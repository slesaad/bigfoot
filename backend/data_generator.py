import glob
import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request


ROAD_TRIP_TYPES = {
    'IN_BUS',
    'IN_VEHICLE',
    'IN_PASSENGER_VEHICLE',
    'IN_ROAD_VEHICLE',
}
ROAD_TRIP_MIN_METERS = 50_000
# The on-device export reports a probability per activity but it is frequently
# 0.0, so we cannot reuse the old confidence>=HIGH filter. Use a distance floor
# to drop obvious misclassifications (e.g. a 1.6 km "flight").
FLIGHT_MIN_METERS = 50_000

# Mapbox Directions caps a single request at 25 coordinates.
MAPBOX_MAX_WAYPOINTS = 25
MAPBOX_DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/driving/{coords}"
# "simplified" ≈ 1 point / ~11m at equator — indistinguishable from "full" at
# typical zoom but ~5-10× smaller output. Participates in the cache key so
# flipping this value invalidates stale entries automatically.
MAPBOX_OVERVIEW = "simplified"


def _load_json_tolerant(path):
    """Load JSON, tolerating latin-1 degree symbols and truncation.

    Phone-exported Timeline.json embeds literal "°" bytes and is sometimes cut
    off mid-object. If strict parsing fails, trim to the last balanced top-level
    element and retry.
    """
    with open(path, 'rb') as f:
        raw = f.read()
    text = raw.decode('latin-1')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Recovery: scan top-level and rebuild a closed document from balanced elements.
    return _recover_truncated_json(text)


def _recover_truncated_json(text):
    i = text.find('[')
    if i < 0:
        raise ValueError("cannot recover: no array found")
    header = text[:i + 1]
    depth = 0
    in_str = False
    esc = False
    elem_start = None
    last_good_end = None
    for j in range(i + 1, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == '{':
            if depth == 0:
                elem_start = j
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                last_good_end = j
        elif c == ']' and depth == 0:
            last_good_end = j - 1
            break
    if last_good_end is None:
        raise ValueError("cannot recover: no complete elements found")
    # Figure out the outer-object tail: everything after the array's closing ]
    # is lost, but the only thing we lose in practice is a closing "}".
    recovered = header + text[i + 1:last_good_end + 1] + ']}'
    return json.loads(recovered)


def _parse_latlng(s):
    """Parse "lat°, lng°" or "lat, lng" into (lat, lng) floats."""
    if not s:
        return None
    nums = re.findall(r'-?\d+\.?\d*', s)
    if len(nums) < 2:
        return None
    return float(nums[0]), float(nums[1])


def _to_e7(x):
    return int(round(x * 1e7))


def _is_new_format(data):
    return isinstance(data, dict) and 'semanticSegments' in data


def _is_old_monthly_format(data):
    return isinstance(data, dict) and 'timelineObjects' in data


def _find_path_between(paths, start_time, end_time):
    """Pick the timelinePath whose time window overlaps [start_time, end_time]."""
    for p in paths:
        if p['start'] <= end_time and p['end'] >= start_time:
            return p['points']
    return None


def generate_new_format(data):
    """Process on-device (2024+) Timeline.json into places/flights/road_trips."""
    places = []
    flights = []
    road_trips = []

    # Index timelinePath segments so we can enrich road trip waypoints.
    paths = []
    for seg in data['semanticSegments']:
        if 'timelinePath' in seg and seg.get('startTime') and seg.get('endTime'):
            pts = []
            for pt in seg['timelinePath']:
                ll = _parse_latlng(pt.get('point'))
                if ll:
                    pts.append(ll)
            if pts:
                paths.append({
                    'start': seg['startTime'],
                    'end': seg['endTime'],
                    'points': pts,
                })

    for seg in data['semanticSegments']:
        if visit := seg.get('visit'):
            loc = visit.get('topCandidate', {}).get('placeLocation', {})
            ll = _parse_latlng(loc.get('latLng'))
            if ll:
                lat, lng = ll
                places.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [lng, lat],
                    },
                })
            continue

        if activity := seg.get('activity'):
            atype = activity.get('topCandidate', {}).get('type')
            start_ll = _parse_latlng(activity.get('start', {}).get('latLng'))
            end_ll = _parse_latlng(activity.get('end', {}).get('latLng'))
            distance = activity.get('distanceMeters') or 0
            if not (start_ll and end_ll):
                continue

            if atype == 'FLYING' and distance > FLIGHT_MIN_METERS:
                flights.append({
                    "startLocation": {
                        "latitudeE7": _to_e7(start_ll[0]),
                        "longitudeE7": _to_e7(start_ll[1]),
                    },
                    "endLocation": {
                        "latitudeE7": _to_e7(end_ll[0]),
                        "longitudeE7": _to_e7(end_ll[1]),
                    },
                    "distance": int(distance),
                    "activityType": "FLYING",
                })
            elif atype in ROAD_TRIP_TYPES and distance > ROAD_TRIP_MIN_METERS:
                path = _find_path_between(paths, seg['startTime'], seg['endTime']) or []
                # L.Routing needs >=2 waypoints; anchor with start/end regardless.
                waypoints = [start_ll] + path + [end_ll]
                road_trips.append({
                    "startLocation": {
                        "latitudeE7": _to_e7(start_ll[0]),
                        "longitudeE7": _to_e7(start_ll[1]),
                    },
                    "endLocation": {
                        "latitudeE7": _to_e7(end_ll[0]),
                        "longitudeE7": _to_e7(end_ll[1]),
                    },
                    "distance": int(distance),
                    "activityType": atype,
                    "waypointPath": {
                        "waypoints": [
                            {"latE7": _to_e7(lat), "lngE7": _to_e7(lng)}
                            for lat, lng in waypoints
                        ],
                    },
                })

    return places, flights, road_trips


def generate_old_format(folder, years):
    """Process legacy Google Takeout Semantic Location History folders."""
    import pgeocode  # only required for the legacy geocoding path
    nomi = pgeocode.Nominatim('us')
    places = []
    flights = []
    road_trips = []

    for year in years:
        for path in glob.glob(os.path.join(folder, year, '*.json')):
            month_data = json.load(open(path))
            for objects in month_data.get('timelineObjects', []):
                if place := objects.get('placeVisit'):
                    if address := place['location'].get('address'):
                        try:
                            zip_code = address.split(",")[-2].split(" ")[-1]
                        except IndexError:
                            continue
                        lat_long = nomi.query_postal_code(zip_code)
                        lat = lat_long.latitude
                        lon = lat_long.longitude
                        if not (math.isnan(lat) or math.isnan(lon)):
                            places.append({
                                "type": "Feature",
                                "geometry": {
                                    "type": "Point",
                                    "coordinates": [lon, lat],
                                },
                            })
                if activity := objects.get('activitySegment'):
                    if activity.get('activityType') == 'FLYING' and activity.get('confidence') == 'HIGH':
                        activity.pop('activities', None)
                        flights.append(activity)
                    if (activity.get('waypointPath')
                            and activity.get('activityType') in ROAD_TRIP_TYPES
                            and activity.get('confidence') == 'HIGH'
                            and (dist := activity.get('distance'))
                            and dist > ROAD_TRIP_MIN_METERS):
                        activity.pop('activities', None)
                        road_trips.append(activity)
    return places, flights, road_trips


def _read_env_file(path):
    """Minimal .env parser: KEY=VALUE per line, # comments, optional quotes."""
    if not os.path.isfile(path):
        return {}
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                out[key] = value
    return out


def _simplify_waypoints(pts, max_n=MAPBOX_MAX_WAYPOINTS):
    """Evenly-spaced sample that always keeps first and last."""
    if len(pts) <= max_n:
        return list(pts)
    step = (len(pts) - 1) / (max_n - 1)
    idxs = [round(i * step) for i in range(max_n)]
    seen = set()
    out = []
    for i in idxs:
        if i not in seen:
            seen.add(i)
            out.append(pts[i])
    return out


def _waypoints_cache_key(pts):
    """Stable hash of the simplified waypoint list (5 decimal places ≈ 1m).

    Includes MAPBOX_OVERVIEW so changing detail level invalidates stale entries.
    """
    rounded = [(round(lat, 5), round(lng, 5)) for lat, lng in pts]
    payload = (MAPBOX_OVERVIEW, rounded)
    return hashlib.sha1(repr(payload).encode()).hexdigest()


def _load_route_cache(path):
    """Seed cache from existing road_trips.json so reruns don't re-call Mapbox."""
    if not os.path.isfile(path):
        return {}
    try:
        existing = json.load(open(path))
    except (json.JSONDecodeError, OSError):
        return {}
    cache = {}
    for trip in existing:
        key = trip.get("routeKey")
        geom = trip.get("geometry")
        if key and geom:
            cache[key] = geom
    return cache


def _fetch_mapbox_directions(waypoints, token):
    """Call Mapbox Directions and return [[lng, lat], ...]; None on failure."""
    coords = ";".join(f"{lng},{lat}" for lat, lng in waypoints)
    url = MAPBOX_DIRECTIONS_URL.format(coords=urllib.parse.quote(coords, safe=",;"))
    qs = urllib.parse.urlencode({
        "geometries": "geojson",
        "overview": MAPBOX_OVERVIEW,
        "access_token": token,
    })
    try:
        with urllib.request.urlopen(f"{url}?{qs}", timeout=20) as resp:
            body = json.load(resp)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  mapbox error: {e}")
        return None
    routes = body.get("routes") or []
    if not routes:
        return None
    return routes[0].get("geometry", {}).get("coordinates")


def resolve_route_geometries(road_trips, output_path, mapbox_token):
    """Attach a `geometry` field to each road trip, hitting Mapbox only on cache miss."""
    cache = _load_route_cache(output_path)
    hits = misses = fails = 0
    for i, trip in enumerate(road_trips):
        raw = [(w["latE7"] / 1e7, w["lngE7"] / 1e7)
               for w in trip["waypointPath"]["waypoints"]]
        simplified = _simplify_waypoints(raw)
        key = _waypoints_cache_key(simplified)
        trip["routeKey"] = key

        if key in cache:
            trip["geometry"] = cache[key]
            hits += 1
            continue

        geom = _fetch_mapbox_directions(simplified, mapbox_token)
        if geom is None:
            fails += 1
            trip["geometry"] = None
        else:
            cache[key] = geom
            trip["geometry"] = geom
            misses += 1
            # Gentle pacing to stay under the default 300 req/min limit.
            time.sleep(0.05)
        if (i + 1) % 25 == 0:
            print(f"  processed {i + 1}/{len(road_trips)} (hits={hits} misses={misses} fails={fails})")
    print(f"  done: hits={hits} misses={misses} fails={fails}")


def save(filepath, places, flights, road_trips):
    json.dump(places, open(os.path.join(filepath, 'places.json'), 'w'))
    json.dump(flights, open(os.path.join(filepath, 'flights.json'), 'w'))
    json.dump(road_trips, open(os.path.join(filepath, 'road_trips.json'), 'w'))


if __name__ == "__main__":
    data_dir = os.path.abspath("../data")

    old_dir = os.path.join(data_dir, "location_history")
    # Prefer Timeline-new.json if present (e.g. a fresh re-export), falling
    # back to Timeline.json.
    new_file = next(
        (os.path.join(data_dir, name)
         for name in ("Timeline-new.json", "Timeline.json")
         if os.path.isfile(os.path.join(data_dir, name))),
        None,
    )

    if new_file:
        print(f"Detected on-device Timeline export: {new_file}")
        data = _load_json_tolerant(new_file)
        if not _is_new_format(data):
            raise SystemExit("Timeline.json did not contain 'semanticSegments'")
        places, flights, road_trips = generate_new_format(data)
    elif os.path.isdir(old_dir):
        print(f"Detected legacy Takeout export: {old_dir}")
        years = [os.path.basename(x) for x in glob.glob(f'{old_dir}/*') if os.path.isdir(x)]
        places, flights, road_trips = generate_old_format(old_dir, years)
    else:
        raise SystemExit(
            f"No input found. Expected either {data_dir}/Timeline-new.json / "
            f"Timeline.json (phone export) or {old_dir}/ (Takeout export)."
        )

    print(f"places={len(places)} flights={len(flights)} road_trips={len(road_trips)}")

    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    mapbox_token = os.environ.get("MAPBOX_TOKEN") or _read_env_file(env_path).get(
        "MAPBOX_TOKEN"
    )
    if not mapbox_token:
        raise SystemExit(
            "MAPBOX_TOKEN is required. Create an unrestricted public token at "
            "https://account.mapbox.com/access-tokens/ and either export it "
            "(MAPBOX_TOKEN=pk.xxx python3 data_generator.py) or add it to "
            "backend/.env."
        )
    print("Resolving road trip geometries via Mapbox Directions...")
    resolve_route_geometries(
        road_trips,
        os.path.join(data_dir, "road_trips.json"),
        mapbox_token,
    )

    save(data_dir, places, flights, road_trips)

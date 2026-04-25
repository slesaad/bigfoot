# Bigfoot (<img src="/assets/logo.png" />)

Bigfoot is a web app that traces the places you've been to, your road trips, and your flights on a map.

- Bigfoot reads location history from your Google Maps Timeline.
- A Python pipeline processes it into frontend-friendly JSONs, enriching road trips with Mapbox driving geometries and adding human-readable place names.
- The frontend renders it with MapLibre GL as a basemap and deck.gl layers on top.

## Features

- scatter of every place visited.
- Road trips rendered as actual driving routes (via Mapbox Directions, cached on disk).
- Flights as great-circle arcs.
- US states you've visited shaded red (auto-derived from places).
- Hover tooltips on road trips and flights with start → end place names, date, distance.
- Click legend rows to toggle layers on/off.
- Sun/moon toggle for dark/light basemap.
- Intro fly-in animation on load.

## Visualizing your own location history

### Step I: Download data

As of 2024, Google moved Timeline from cloud to **on-device** storage. Export directly from the Google Maps app:

- **Android**: Settings → Location → Location Services → Timeline → **Export Timeline data** → share/save `Timeline.json`.
- **iPhone**: Google Maps → profile picture → Settings → Personal content → Export Timeline data **Export Timeline data** → share/save.

Transfer the file to your computer and drop it in `data/`:

```plain
data/
  Timeline.json
```

The pipeline also supports the **legacy** Google Takeout `Semantic Location History/` format — if you still have one of those folders, place it at `data/location_history/` and the script will use it.

### Step II: Get a Mapbox token

You need a Mapbox token with Directions + Geocoding scopes for the data pipeline (one-time, used only while generating data). Create one at [Mapbox → access tokens](https://account.mapbox.com/access-tokens/) with the default public scopes and **no URL restrictions** (so server-side calls from your laptop aren't blocked).

Drop it in `backend/.env`:

```bash
MAPBOX_TOKEN=pk.your_token_here
```

(`backend/.env` is gitignored.)

### Step III: Process data

```bash
cd backend/
python -m venv env
source env/bin/activate
pip install -r requirements.txt
python data_generator.py
cd ..
```

First run makes ~400 Mapbox Directions calls and ~600 Geocoding calls (well inside the free tier). Results are cached inline in `data/road_trips.json` and `data/flights.json`, so subsequent runs are nearly free.

Outputs:
- `data/places.json` — GeoJSON points of every visit.
- `data/flights.json` — flights with start/end coords, place names, distance, dates.
- `data/road_trips.json` — road trips with cached driving geometry, place names, distance, dates.
- `visitedStates.json` — auto-derived from places via point-in-polygon against `us-states.json`.

**Tuning visited states**: a state counts as "visited" if you have at least `STATE_MIN_PLACES` distinct places inside it (near-duplicate coordinates within ~110 m are deduped first). The default is `2` in `backend/data_generator.py`, which filters out one-off pings (e.g. a single airport check-in during a layover). Set to `1` to count every state with any recorded visit, or bump higher (`5`, `10`) to only show states where you actually spent meaningful time:

```python
STATE_MIN_PLACES = 2  # backend/data_generator.py
```

### Step IV: Configure (optional)

`config.json` controls map center, zoom, layer colors, and the Stadia Maps API key. Colors/radius/opacity for each layer are all driven from there. The bundled Stadia key is domain-restricted — create your own at [Stadia Maps](https://client.stadiamaps.com/dashboard/) and replace `stadiaApiKey`.

### Step V: Serve

Serve the repo root with any static file server:

```bash
python -m http.server 3000
```

Open `localhost:3000`.

## URL parameters

The viz reads three query params so you can deep-link, embed, or share focused views:

- `?layers=places,flights,road-trips,states` — only the named layers are visible on load. Any omitted layer's legend row shows as off. Example: `?layers=flights,states` hides places and road trips.
- `?view=LAT,LNG,ZOOM` — overrides `config.json`'s center/zoom (and the intro flyTo target). Example: `?view=38.9,-77.0,7` frames DC at zoom 7.
- `?animate=1` — on load, auto-plays the year slider from the earliest year to the latest, pauses, and loops. Clicking either slider thumb stops it. Pass a number to override ms-per-year (e.g. `?animate=800` for faster).
- `?parent=https://blog.example.com` — allowlist for postMessage control (see Embedding section). Comma-separate for multiple origins.
- `?flight=YYYY-MM-DD` or `?trip=YYYY-MM-DD` — highlights flights/road trips by date. Matches render bright white at 2.5× width; everything else dims to 15% alpha. The map auto-fits to the highlight (unless `?view=` overrides). Accepts:
  - Single day: `?flight=2023-08-14`
  - Month: `?flight=2023-08`
  - Year: `?flight=2023`
  - Range: `?flight=2023-08..2023-10` (August through October 2023), `?trip=2019..2021` (three-year span)

Combine freely: `?view=40.7,-74,5&layers=flights&animate=1500` frames NYC, shows only flights, and animates at 1.5 s/year.

## Embedding / scrollytelling

Bigfoot can be driven from a parent page (e.g. an iframe in a blog post) via `window.postMessage`. Unlike URL parameters, messages trigger smooth `flyTo` transitions instead of iframe reloads — ideal for scroll-driven storytelling.

**Restricting which origins can drive the iframe** (recommended for production): add `?parent=https://your-blog.example.com` to the iframe `src`. The iframe will then only accept messages from that origin, and will target its `ready` signal specifically at that origin. Comma-separate to allow multiple: `?parent=https://prod.example.com,https://staging.example.com`. If the param is absent, any origin is accepted — convenient for local testing, but lax for production.

On map load the iframe posts `{type: 'bigfoot:ready'}` to the parent. After that, send any of these:

```js
const bf = document.querySelector('iframe').contentWindow;

// Show only certain layers (missing keys stay unchanged)
bf.postMessage({
  type: 'bigfoot:setLayers',
  layers: { flights: true, 'road-trips': false, places: false, states: true }
}, '*');

// Smooth flyTo (center is [lng, lat])
bf.postMessage({
  type: 'bigfoot:setView',
  center: [85.3, 27.7], zoom: 10, duration: 2000
}, '*');

// Year filter
bf.postMessage({ type: 'bigfoot:setYearRange', from: 2019, to: 2020 }, '*');

// Highlight a trip/flight (same syntax as ?flight= / ?trip= — date prefix
// or `a..b` range; pass null to clear)
bf.postMessage({ type: 'bigfoot:setHighlight', flight: '2023-08', trip: null }, '*');

// Animate the year slider. All options are optional:
//   tickMs  — ms per year (default 1200)
//   from/to — restrict the sweep to a sub-range (defaults to the full range)
//   loop    — keep cycling (default true). Set false for a single pass.
bf.postMessage({
  type: 'bigfoot:animateYears',
  tickMs: 800,
  from: 2018,
  to: 2024,
  loop: false,
}, '*');

// Stop an in-flight animation (user interaction with the slider also stops it)
bf.postMessage({ type: 'bigfoot:stopAnimation' }, '*');

// Return everything to defaults
bf.postMessage({ type: 'bigfoot:reset' }, '*');
```

When `loop: false` completes, the iframe posts `{type: 'bigfoot:animationEnd'}` back so the parent can advance to the next scroll step.

Listener pattern for the parent:

```js
window.addEventListener('message', (e) => {
  if (e.data?.type === 'bigfoot:ready') {
    // safe to start driving the iframe
  }
});
```

## Deploying to GitHub Pages

Fork the repo, follow the steps above, and push the generated data (`flights.json`, `places.json`, `road_trips.json`, `visitedStates.json`, `config.json`). **Do not push your `Timeline.json`** — it contains precise location history. It's gitignored by default; keep it that way.

Enable GitHub Pages in repo Settings. You'll have the site at `username.github.io/bigfoot`.

## Tech stack

- **Frontend**: [MapLibre GL](https://maplibre.org) (basemap) + [deck.gl](https://deck.gl) layers (`GeoJsonLayer`, `PathLayer`, `ArcLayer`, `ScatterplotLayer`) via `MapboxOverlay`.
- **Basemap**: [Stadia Maps](https://stadiamaps.com) `alidade_smooth` / `alidade_smooth_dark` vector styles.
- **Data pipeline**: Python stdlib + `pgeocode` (only for the legacy Takeout path), `urllib` calls to Mapbox Directions & Geocoding.

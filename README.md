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

### Step IV: Configure (optional)

`config.json` controls map center, zoom, layer colors, and the Stadia Maps API key. Colors/radius/opacity for each layer are all driven from there. The bundled Stadia key is domain-restricted — create your own at [Stadia Maps](https://client.stadiamaps.com/dashboard/) and replace `stadiaApiKey`.

### Step V: Serve

Serve the repo root with any static file server:

```bash
python -m http.server 3000
```

Open `localhost:3000`.

## Deploying to GitHub Pages

Fork the repo, follow the steps above, and push the generated data (`flights.json`, `places.json`, `road_trips.json`, `visitedStates.json`, `config.json`). **Do not push your `Timeline.json`** — it contains precise location history. It's gitignored by default; keep it that way.

Enable GitHub Pages in repo Settings. You'll have the site at `username.github.io/bigfoot`.

## Tech stack

- **Frontend**: [MapLibre GL](https://maplibre.org) (basemap) + [deck.gl](https://deck.gl) layers (`GeoJsonLayer`, `PathLayer`, `ArcLayer`, `ScatterplotLayer`) via `MapboxOverlay`.
- **Basemap**: [Stadia Maps](https://stadiamaps.com) `alidade_smooth` / `alidade_smooth_dark` vector styles.
- **Data pipeline**: Python stdlib + `pgeocode` (only for the legacy Takeout path), `urllib` calls to Mapbox Directions & Geocoding.

const mapId = 'mapid';

// Old Takeout-format data used 32-bit wrap-around on negative E7s. Guard
// against that here so stale outputs keep rendering; new data is clean signed.
const fromE7 = (lat, lng) => {
  const unwrapLat = lat > 900_000_000 ? lat - 4_294_967_296 : lat;
  const unwrapLng = lng > 1_800_000_000 ? lng - 4_294_967_296 : lng;
  return [unwrapLng / 1e7, unwrapLat / 1e7]; // [lng, lat] for deck.gl
};

// Parse "#rrggbb" plus optional alpha (0..1) into [r, g, b, a] for deck.gl.
const hexToRgba = (hex, alpha = 1) => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    Math.round(alpha * 255),
  ];
};

Promise.all([
  fetch('./config.json').then(r => r.json()),
  fetch('./visitedStates.json').then(r => r.json()),
  fetch('data/us-states.json').then(r => r.json()),
  fetch('data/road_trips.json').then(r => r.json()),
  fetch('data/flights.json').then(r => r.json()),
  fetch('data/places.json').then(r => r.json()),
]).then(([config, visited, allStates, roadTrips, flights, places]) => {
  const { mapConfig, vizConfig, stadiaApiKey } = config;

  const map = new maplibregl.Map({
    container: mapId,
    style: `https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json?api_key=${stadiaApiKey}`,
    center: [mapConfig.center[1], mapConfig.center[0]], // MapLibre is [lng, lat]
    zoom: mapConfig.zoom,
    maxZoom: mapConfig.maxZoom,
    minZoom: mapConfig.minZoom,
  });

  const visitedSet = new Set(visited.map(s => s.toLowerCase()));
  const visitedFeatures = allStates.filter(f =>
    visitedSet.has(f.properties.NAME.toLowerCase()),
  );

  const placesColor = hexToRgba(
    vizConfig.points.fillColor,
    vizConfig.points.fillOpacity,
  );
  const statesColor = hexToRgba(vizConfig.states.style.color, vizConfig.states.style.opacity);
  const routesColor = hexToRgba(vizConfig.routes.styles[0].color, vizConfig.routes.styles[0].opacity);
  const flightsColor = hexToRgba(vizConfig.flights.color, 1);

  const visibility = {
    'states': true,
    'road-trips': true,
    'flights': true,
    'places': true,
  };

  // Layers are immutable in deck.gl — rebuild on each toggle and setProps.
  const buildLayers = () => [
    new deck.GeoJsonLayer({
      id: 'states',
      data: { type: 'FeatureCollection', features: visitedFeatures },
      stroked: false,
      filled: true,
      getFillColor: statesColor,
      visible: visibility['states'],
    }),
    new deck.PathLayer({
      id: 'road-trips',
      data: roadTrips,
      getPath: t =>
        t.geometry && t.geometry.length >= 2
          ? t.geometry
          : t.waypointPath.waypoints.map(w => fromE7(w.latE7, w.lngE7)),
      getColor: routesColor,
      getWidth: vizConfig.routes.styles[0].weight,
      widthUnits: 'pixels',
      pickable: true,
      visible: visibility['road-trips'],
    }),
    new deck.ArcLayer({
      id: 'flights',
      data: flights,
      getSourcePosition: f =>
        fromE7(f.startLocation.latitudeE7, f.startLocation.longitudeE7),
      getTargetPosition: f =>
        fromE7(f.endLocation.latitudeE7, f.endLocation.longitudeE7),
      getSourceColor: flightsColor,
      getTargetColor: flightsColor,
      getWidth: vizConfig.flights.weight,
      widthUnits: 'pixels',
      getHeight: 0.3,
      greatCircle: true,
      pickable: true,
      visible: visibility['flights'],
    }),
    new deck.ScatterplotLayer({
      id: 'places',
      data: places,
      getPosition: f => f.geometry.coordinates,
      getRadius: vizConfig.points.radius,
      radiusUnits: 'pixels',
      stroked: false,
      getFillColor: placesColor,
      visible: visibility['places'],
    }),
  ];

  const formatDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  };
  const formatKm = (m) => `${Math.round((m || 0) / 1000).toLocaleString()} km`;
  const prettyActivity = (t) =>
    (t || '').toLowerCase().replaceAll('_', ' ');
  // "San Francisco, California, United States" -> "San Francisco, California"
  const shortPlace = (p) =>
    p ? p.split(', ').slice(0, 2).join(', ') : '';

  const getTooltip = ({ object, layer }) => {
    if (!object) return null;
    if (layer.id === 'road-trips' || layer.id === 'flights') {
      const start = formatDate(object.startTime);
      const end = formatDate(object.endTime);
      const range = start === end ? start : `${start} → ${end}`;
      const title = layer.id === 'flights' ? 'Flight' : 'Road trip';
      const places = object.startPlace && object.endPlace
        ? `<div>${shortPlace(object.startPlace)} → ${shortPlace(object.endPlace)}</div>`
        : '';
      return {
        html: `
          <div><strong>${title}</strong></div>
          ${places}
          <div>${prettyActivity(object.activityType)} · ${formatKm(object.distance)}</div>
          <div>${range}</div>
        `,
        style: {
          background: 'rgba(34, 34, 34, 0.95)',
          color: 'rgba(220, 221, 225, 0.9)',
          font: '11px Lato',
          padding: '6px 8px',
          borderRadius: '2px',
          boxShadow: '0 0 15px rgba(0,0,0,0.3)',
        },
      };
    }
    return null;
  };

  let overlay;
  map.on('load', () => {
    overlay = new deck.MapboxOverlay({ layers: buildLayers(), getTooltip });
    map.addControl(overlay);
  });

  // Legend — click a row to toggle that layer.
  const legend = document.createElement('div');
  legend.className = 'legend';
  const row = (layerId, color, label) =>
    `<label data-layer="${layerId}">
      <i style="background: ${color}"></i><span>${label}</span>
    </label>`;
  legend.innerHTML = `
    <h4>Legend</h4>
    ${row('places', vizConfig.points.fillColor, 'Places visited')}
    ${row('road-trips', vizConfig.routes.styles[0].color, 'Road trips')}
    ${row('flights', vizConfig.flights.color, 'Flights')}
    ${row('states', vizConfig.states.style.color, 'States visited')}
  `;
  legend.addEventListener('click', (e) => {
    const label = e.target.closest('label[data-layer]');
    if (!label) return;
    const layerId = label.dataset.layer;
    visibility[layerId] = !visibility[layerId];
    label.classList.toggle('off', !visibility[layerId]);
    if (overlay) overlay.setProps({ layers: buildLayers() });
  });
  document.body.appendChild(legend);
}).catch(err => console.error(err));

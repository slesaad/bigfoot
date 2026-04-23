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

  const STADIA_STYLES = { dark: 'alidade_smooth_dark', light: 'alidade_smooth' };
  const styleUrl = (theme) =>
    `https://tiles.stadiamaps.com/styles/${STADIA_STYLES[theme]}.json?api_key=${stadiaApiKey}`;
  let theme = 'dark';

  const map = new maplibregl.Map({
    container: mapId,
    style: styleUrl(theme),
    center: [mapConfig.center[1], mapConfig.center[0]], // MapLibre is [lng, lat]
    zoom: 0, // world view on load; flyTo animates to configured zoom
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

  const tooltipStyle = () => theme === 'dark'
    ? {
        background: 'rgba(34, 34, 34, 0.95)',
        color: 'rgba(220, 221, 225, 0.9)',
      }
    : {
        background: 'rgba(255, 255, 255, 0.95)',
        color: 'rgba(34, 34, 34, 0.9)',
      };

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
          ...tooltipStyle(),
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
    map.flyTo({
      center: [mapConfig.center[1], mapConfig.center[0]],
      zoom: mapConfig.zoom,
      duration: 3000,
      curve: 1.6,
      essential: true,
    });
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

  // Theme toggle — sun/moon icons in the header; active one is highlighted.
  const sunSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>`;
  const moonSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

  // Icon shown = the theme you'd switch TO (sun when dark, moon when light).
  const themeBtn = document.createElement('button');
  themeBtn.className = 'theme-icons';
  const renderThemeBtn = () => {
    const target = theme === 'dark' ? 'light' : 'dark';
    themeBtn.innerHTML = target === 'light' ? sunSvg : moonSvg;
    themeBtn.title = `${target[0].toUpperCase() + target.slice(1)} mode`;
    themeBtn.setAttribute('aria-label', themeBtn.title);
  };
  themeBtn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.body.classList.toggle('light', theme === 'light');
    renderThemeBtn();
    map.setStyle(styleUrl(theme));
  });
  renderThemeBtn();
  document.querySelector('.header').appendChild(themeBtn);
}).catch(err => console.error(err));

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

const hslToRgba = (h, s, l, a = 1) => {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    Math.round(a * 255),
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

  // ?view=lat,lng,zoom overrides mapConfig's center/zoom. Also used as the
  // flyTo destination so deep-linked shares land exactly where intended.
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  let initialView = { center: mapConfig.center, zoom: mapConfig.zoom };
  if (viewParam) {
    const parts = viewParam.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => Number.isFinite(n))) {
      initialView = { center: [parts[0], parts[1]], zoom: parts[2] };
    }
  }

  const STADIA_STYLES = { dark: 'alidade_smooth_dark', light: 'alidade_smooth' };
  const styleUrl = (theme) =>
    `https://tiles.stadiamaps.com/styles/${STADIA_STYLES[theme]}.json?api_key=${stadiaApiKey}`;
  let theme = 'dark';

  const map = new maplibregl.Map({
    container: mapId,
    style: styleUrl(theme),
    center: [initialView.center[1], initialView.center[0]], // MapLibre is [lng, lat]
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

  // Flight color = year position along an HSL gradient. Tweak these to
  // re-skin the flights, the legend swatch, and the range-slider fill at once.
  const FLIGHT_HUE_START = 180; // 180 = teal
  const FLIGHT_HUE_END = 350;   // 350 = coral
  const FLIGHT_SATURATION = 40; // 0 = grey, 100 = neon
  const FLIGHT_LIGHTNESS = 60;  // 50 = mid, higher = paler

  const flightYears = flights.map(f => new Date(f.startTime).getFullYear())
    .filter(y => !Number.isNaN(y));
  const fMin = flightYears.length ? Math.min(...flightYears) : 0;
  const fMax = flightYears.length ? Math.max(...flightYears) : 0;
  const flightHueFor = (year) => {
    if (fMax === fMin) return FLIGHT_HUE_START;
    const t = (year - fMin) / (fMax - fMin); // 0..1
    return FLIGHT_HUE_START + t * (FLIGHT_HUE_END - FLIGHT_HUE_START);
  };
  const flightColorFor = (f) =>
    hslToRgba(
      flightHueFor(new Date(f.startTime).getFullYear()),
      FLIGHT_SATURATION,
      FLIGHT_LIGHTNESS,
    );
  const hueStop = (hue) => `hsl(${hue} ${FLIGHT_SATURATION}% ${FLIGHT_LIGHTNESS}%)`;
  const flightGradient = `linear-gradient(to right, ${hueStop(FLIGHT_HUE_START)}, ${hueStop((FLIGHT_HUE_START + FLIGHT_HUE_END) / 2)}, ${hueStop(FLIGHT_HUE_END)})`;
  // Expose to CSS (range-slider::after reads this).
  document.documentElement.style.setProperty('--flight-gradient', flightGradient);

  const visibility = {
    'states': true,
    'road-trips': true,
    'flights': true,
    'places': true,
  };
  // ?layers=a,b,c — if present, only those layers are visible initially.
  const layersParam = params.get('layers');
  if (layersParam) {
    const requested = new Set(
      layersParam.split(',').map(s => s.trim()).filter(Boolean),
    );
    Object.keys(visibility).forEach(k => { visibility[k] = requested.has(k); });
  }

  // Year filter — two-thumb range. Trips/flights with startTime outside the
  // range are hidden. Places/states lack times, so they stay unfiltered.
  const allStartYears = [...roadTrips, ...flights]
    .map(x => x.startTime)
    .filter(Boolean)
    .map(t => new Date(t).getFullYear());
  const minYear = allStartYears.length ? Math.min(...allStartYears) : null;
  const maxYear = allStartYears.length ? Math.max(...allStartYears) : null;
  let fromYear = minYear;
  let toYear = maxYear;
  const yearOf = (x) => x.startTime ? new Date(x.startTime).getFullYear() : null;
  const withinYear = (x) => {
    const y = yearOf(x);
    return y === null || (y >= fromYear && y <= toYear);
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
      data: roadTrips.filter(withinYear),
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
      data: flights.filter(withinYear),
      getSourcePosition: f =>
        fromE7(f.startLocation.latitudeE7, f.startLocation.longitudeE7),
      getTargetPosition: f =>
        fromE7(f.endLocation.latitudeE7, f.endLocation.longitudeE7),
      getSourceColor: flightColorFor,
      getTargetColor: flightColorFor,
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
      // Radius scales with visit count (sqrt = area linear in count), capped
      // so a 1000-visit home doesn't swallow the map.
      getRadius: f => {
        const count = f.properties?.count || 1;
        return vizConfig.points.radius * Math.min(4, Math.sqrt(count));
      },
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
      center: [initialView.center[1], initialView.center[0]],
      zoom: initialView.zoom,
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
  // Flights use a year→hue gradient, so render a gradient swatch instead.
  const flightRow = `
    <label data-layer="flights">
      <i style="background: ${flightGradient}"></i>
      <span>Flights (${fMin}–${fMax})</span>
    </label>`;
  legend.innerHTML = `
    <h4>Legend</h4>
    ${row('places', vizConfig.points.fillColor, 'Places visited')}
    ${row('road-trips', vizConfig.routes.styles[0].color, 'Road trips')}
    ${flightRow}
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
  // Reflect param-driven initial visibility in the legend.
  legend.querySelectorAll('label[data-layer]').forEach(label => {
    label.classList.toggle('off', !visibility[label.dataset.layer]);
  });
  document.body.appendChild(legend);

  // Stats overlay in the header — recomputed from the filtered trip/flight set.
  const fmtKm = (m) => `${Math.round(m / 1000).toLocaleString()} km`;
  const stats = document.createElement('div');
  stats.className = 'stats';
  document.querySelector('.header').appendChild(stats);
  const renderStats = () => {
    const trips = roadTrips.filter(withinYear);
    const flts = flights.filter(withinYear);
    const driven = trips.reduce((s, t) => s + (t.distance || 0), 0);
    const flown = flts.reduce((s, f) => s + (f.distance || 0), 0);
    const items = [
      { text: `${visited.length} states` },
      { text: `${trips.length} road trips` },
      { text: `${flts.length} flights` },
      { text: `${fmtKm(driven)} driven` },
      { text: `${fmtKm(flown)} flown` },
    ];
    if (fromYear !== null) {
      // "since 2015" implies "through now"; switch to "2015—2020" when the
      // upper bound is pulled back, else it's misleading.
      const rangeText = toYear < maxYear
        ? `${fromYear}–${toYear}`
        : `since ${fromYear}`;
      items.unshift({ text: rangeText, cls: 'since' });
    }
    stats.innerHTML = items
      .map(({ text, cls }) => `<span${cls ? ` class="${cls}"` : ''}>${text}</span>`)
      .join('');
  };
  renderStats();

  // Year filter — dual-thumb range (two overlapping native sliders).
  if (minYear !== null && minYear !== maxYear) {
    const yearEl = document.createElement('div');
    yearEl.className = 'year-filter';
    yearEl.innerHTML = `
      <span class="year-value year-from">${fromYear}</span>
      <div class="range-slider">
        <input type="range" class="range-input range-from-input"
               min="${minYear}" max="${maxYear}" value="${fromYear}" step="1">
        <input type="range" class="range-input range-to-input"
               min="${minYear}" max="${maxYear}" value="${toYear}" step="1">
      </div>
      <span class="year-value year-to">${toYear}</span>
    `;
    const fromInput = yearEl.querySelector('.range-from-input');
    const toInput = yearEl.querySelector('.range-to-input');
    const fromValueEl = yearEl.querySelector('.year-from');
    const toValueEl = yearEl.querySelector('.year-to');
    const rangeSlider = yearEl.querySelector('.range-slider');
    const pct = (y) => ((y - minYear) / (maxYear - minYear)) * 100;
    const syncFill = () => {
      rangeSlider.style.setProperty('--from', `${pct(fromYear)}%`);
      rangeSlider.style.setProperty('--to', `${pct(toYear)}%`);
    };
    const onInput = () => {
      // Read sorted so thumbs can swap freely without crossing logic.
      fromYear = Math.min(fromInput.valueAsNumber, toInput.valueAsNumber);
      toYear = Math.max(fromInput.valueAsNumber, toInput.valueAsNumber);
      fromValueEl.textContent = fromYear;
      toValueEl.textContent = toYear;
      syncFill();
      renderStats();
      if (overlay) overlay.setProps({ layers: buildLayers() });
    };
    fromInput.addEventListener('input', onInput);
    toInput.addEventListener('input', onInput);
    syncFill();
    document.body.appendChild(yearEl);

    // ?animate=1 (or ms/year) — cumulative year sweep: fromYear anchored at
    // minYear, toYear ticks from minYear to maxYear, pauses, loops.
    const animateParam = params.get('animate');
    if (animateParam) {
      const parsed = parseInt(animateParam, 10);
      const tickMs = Number.isFinite(parsed) && parsed > 100 ? parsed : 1200;
      let cursor = minYear;
      let animationTimer = null;
      fromInput.value = minYear;
      toInput.value = minYear;
      onInput();
      const step = () => {
        cursor += 1;
        if (cursor > maxYear) {
          cursor = minYear - 1; // the next step() will bump it to minYear
          animationTimer = setTimeout(step, tickMs * 2); // pause at end
          return;
        }
        toInput.value = cursor;
        onInput();
        animationTimer = setTimeout(step, tickMs);
      };
      animationTimer = setTimeout(step, tickMs);
      const stop = () => {
        if (animationTimer) {
          clearTimeout(animationTimer);
          animationTimer = null;
        }
      };
      fromInput.addEventListener('pointerdown', stop);
      toInput.addEventListener('pointerdown', stop);
    }
  }

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

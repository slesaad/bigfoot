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

  // ?flight=YYYY-MM-DD / ?trip=YYYY-MM-DD — prefix match on startTime. Matched
  // items render bright; unmatched ones dim. Map auto-fits to the matches on
  // load (unless ?view= overrides). Shareable deep-links for a specific trip.
  // Ranges use `a..b` (e.g. `?flight=2023-08..2023-10`).
  // `let` so postMessage handlers can update highlight dynamically.
  let highlightFlight = params.get('flight');
  let highlightTrip = params.get('trip');
  const dateMatches = (startTime, spec) => {
    if (!spec || !startTime) return false;
    if (spec.includes('..')) {
      const [a, b] = spec.split('..');
      if (!a || !b) return false;
      // Compare at the coarser endpoint's resolution so YYYY, YYYY-MM,
      // YYYY-MM-DD all compare sanely (ISO dates are lexicographic).
      const len = Math.min(a.length, b.length);
      const prefix = startTime.slice(0, len);
      return prefix >= a.slice(0, len) && prefix <= b.slice(0, len);
    }
    return startTime.startsWith(spec);
  };
  const isHlFlight = (f) => dateMatches(f.startTime, highlightFlight);
  const isHlTrip = (t) => dateMatches(t.startTime, highlightTrip);
  // Fn so updates to highlightFlight/highlightTrip are picked up live.
  const anyHighlight = () => Boolean(highlightFlight || highlightTrip);
  // Highlight = thicker line; non-highlighted = same color, much lower alpha.
  const HIGHLIGHT_WIDTH_MULT = 3;
  const DIM_ALPHA = 25;
  const dim = (rgbaOrRgb) => [rgbaOrRgb[0], rgbaOrRgb[1], rgbaOrRgb[2], DIM_ALPHA];

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
  const tripPath = t =>
    t.geometry && t.geometry.length >= 2
      ? t.geometry
      : t.waypointPath.waypoints.map(w => fromE7(w.latE7, w.lngE7));
  const flightSrc = f => fromE7(f.startLocation.latitudeE7, f.startLocation.longitudeE7);
  const flightTgt = f => fromE7(f.endLocation.latitudeE7, f.endLocation.longitudeE7);
  const tripWeight = vizConfig.routes.styles[0].weight;
  const flightWeight = vizConfig.flights.weight;
  // ID of the first MapLibre symbol layer; used as `beforeId` so deck.gl
  // layers slot below labels (city/road names render on top of the viz).
  // Recomputed on style change because dark/light styles can differ.
  let firstSymbolId = null;

  const buildLayers = () => {
    const hl = anyHighlight();
    return [
    new deck.GeoJsonLayer({
      id: 'states',
      data: { type: 'FeatureCollection', features: visitedFeatures },
      stroked: false,
      filled: true,
      getFillColor: statesColor,
      visible: visibility['states'],
      beforeId: firstSymbolId,
    }),
    new deck.PathLayer({
      id: 'road-trips',
      data: roadTrips.filter(withinYear),
      getPath: tripPath,
      getColor: t => (hl && !isHlTrip(t)) ? dim(routesColor) : routesColor,
      getWidth: t => isHlTrip(t) ? tripWeight * HIGHLIGHT_WIDTH_MULT : tripWeight,
      widthUnits: 'pixels',
      pickable: true,
      visible: visibility['road-trips'],
      beforeId: firstSymbolId,
    }),
    new deck.ArcLayer({
      id: 'flights',
      data: flights.filter(withinYear),
      getSourcePosition: flightSrc,
      getTargetPosition: flightTgt,
      getSourceColor: f => (hl && !isHlFlight(f)) ? dim(flightColorFor(f)) : flightColorFor(f),
      getTargetColor: f => (hl && !isHlFlight(f)) ? dim(flightColorFor(f)) : flightColorFor(f),
      getWidth: f => isHlFlight(f) ? flightWeight * HIGHLIGHT_WIDTH_MULT : flightWeight,
      widthUnits: 'pixels',
      getHeight: 0.3,
      greatCircle: true,
      pickable: true,
      visible: visibility['flights'],
      beforeId: firstSymbolId,
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
      beforeId: firstSymbolId,
    }),
    ];
  };

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

  // Pick the first MapLibre symbol layer (text labels render as symbols);
  // deck.gl layers slot before it so labels stay readable on top of the viz.
  const findFirstSymbolId = () => {
    const layers = (map.getStyle() && map.getStyle().layers) || [];
    const sym = layers.find(l => l.type === 'symbol');
    return sym ? sym.id : null;
  };

  let overlay;
  map.on('load', () => {
    firstSymbolId = findFirstSymbolId();
    overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: buildLayers(),
      getTooltip,
    });
    map.addControl(overlay);

    // Auto-fit to a highlighted trip/flight (unless ?view= is explicit).
    if (anyHighlight() && !viewParam) {
      const matches = [
        ...roadTrips.filter(isHlTrip),
        ...flights.filter(isHlFlight),
      ];
      const coords = matches.flatMap(m => [
        fromE7(m.startLocation.latitudeE7, m.startLocation.longitudeE7),
        fromE7(m.endLocation.latitudeE7, m.endLocation.longitudeE7),
      ]);
      if (coords.length) {
        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 80, duration: 3000, essential: true },
        );
        return;
      }
    }

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
  const stats = document.createElement('div');
  stats.className = 'stats';
  document.querySelector('.header').appendChild(stats);
  const renderStats = () => {
    const trips = roadTrips.filter(withinYear);
    const flts = flights.filter(withinYear);
    const items = [
      { text: `${visited.length} states` },
      { text: `${trips.length} road trips` },
      { text: `${flts.length} flights` },
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
  // Hoisted so the postMessage API can read/write them.
  let fromInput = null, toInput = null, fromValueEl = null, toValueEl = null;
  let syncFill = () => {};
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const updateSliderUi = () => {
    if (fromInput) fromInput.value = fromYear;
    if (toInput) toInput.value = toYear;
    if (fromValueEl) fromValueEl.textContent = fromYear;
    if (toValueEl) toValueEl.textContent = toYear;
    syncFill();
  };

  // Year animation — shared by ?animate= and bigfoot:animateYears.
  const parentOrigins = new Set(
    (params.get('parent') || '')
      .split(',').map(s => s.trim()).filter(Boolean),
  );
  const postToParent = (msg) => {
    if (!(window.parent && window.parent !== window)) return;
    const target = parentOrigins.size === 1 ? [...parentOrigins][0] : '*';
    window.parent.postMessage(msg, target);
  };
  let animationTimer = null;
  const stopAnimation = () => {
    if (animationTimer !== null) {
      clearTimeout(animationTimer);
      animationTimer = null;
    }
  };
  const animateYears = ({ tickMs = 1200, from, to, loop = true } = {}) => {
    stopAnimation();
    if (minYear === null || minYear === maxYear) return;
    const lo = Number.isFinite(Number(from))
      ? clamp(Number(from), minYear, maxYear) : minYear;
    const hi = Number.isFinite(Number(to))
      ? clamp(Number(to), minYear, maxYear) : maxYear;
    if (lo >= hi) return;
    fromYear = lo;
    toYear = lo;
    updateSliderUi();
    renderStats();
    if (overlay) overlay.setProps({ layers: buildLayers() });
    let cursor = lo;
    const step = () => {
      cursor += 1;
      if (cursor > hi) {
        if (loop) {
          cursor = lo - 1; // next step() bumps to lo
          animationTimer = setTimeout(step, tickMs * 2); // pause at end
        } else {
          animationTimer = null;
          postToParent({ type: 'bigfoot:animationEnd' });
        }
        return;
      }
      toYear = cursor;
      updateSliderUi();
      renderStats();
      if (overlay) overlay.setProps({ layers: buildLayers() });
      animationTimer = setTimeout(step, tickMs);
    };
    animationTimer = setTimeout(step, tickMs);
  };
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
    fromInput = yearEl.querySelector('.range-from-input');
    toInput = yearEl.querySelector('.range-to-input');
    fromValueEl = yearEl.querySelector('.year-from');
    toValueEl = yearEl.querySelector('.year-to');
    const rangeSlider = yearEl.querySelector('.range-slider');
    const pct = (y) => ((y - minYear) / (maxYear - minYear)) * 100;
    syncFill = () => {
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
    // Any slider interaction stops an in-flight animation.
    fromInput.addEventListener('pointerdown', stopAnimation);
    toInput.addEventListener('pointerdown', stopAnimation);
    syncFill();
    document.body.appendChild(yearEl);

    // ?animate=1 (or ms/year) — start the shared animation on load.
    const animateParam = params.get('animate');
    if (animateParam) {
      const parsed = parseInt(animateParam, 10);
      const tickMs = Number.isFinite(parsed) && parsed > 100 ? parsed : 1200;
      animateYears({ tickMs });
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
  const applyTheme = (next) => {
    if ((next !== 'dark' && next !== 'light') || next === theme) return;
    theme = next;
    document.body.classList.toggle('light', theme === 'light');
    renderThemeBtn();
    map.setStyle(styleUrl(theme));
    // After the new style finishes loading, label layer IDs may differ.
    map.once('styledata', () => {
      firstSymbolId = findFirstSymbolId();
      if (overlay) overlay.setProps({ layers: buildLayers() });
    });
  };
  themeBtn.addEventListener('click', () => {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  });
  renderThemeBtn();
  document.querySelector('.header').appendChild(themeBtn);

  // postMessage API — blog posts can drive the iframe via window.postMessage.
  // Only messages with `type` starting "bigfoot:" are handled, and (if
  // ?parent=... is set) only when event.origin is in the allowlist.
  const api = {
    setLayers(partial) {
      if (!partial) return;
      Object.entries(partial).forEach(([k, v]) => {
        if (k in visibility) visibility[k] = Boolean(v);
      });
      legend.querySelectorAll('label[data-layer]').forEach(label => {
        label.classList.toggle('off', !visibility[label.dataset.layer]);
      });
      if (overlay) overlay.setProps({ layers: buildLayers() });
    },
    setView({ center, zoom, duration } = {}) {
      const opts = { essential: true, curve: 1.6, duration: duration ?? 2000 };
      if (Array.isArray(center) && center.length === 2) opts.center = center; // [lng, lat]
      if (Number.isFinite(zoom)) opts.zoom = zoom;
      map.flyTo(opts);
    },
    setYearRange(fromArg, toArg) {
      if (minYear === null) return;
      stopAnimation();
      if (fromArg != null && Number.isFinite(Number(fromArg))) {
        fromYear = clamp(Number(fromArg), minYear, maxYear);
      }
      if (toArg != null && Number.isFinite(Number(toArg))) {
        toYear = clamp(Number(toArg), minYear, maxYear);
      }
      if (fromYear > toYear) [fromYear, toYear] = [toYear, fromYear];
      updateSliderUi();
      renderStats();
      if (overlay) overlay.setProps({ layers: buildLayers() });
    },
    setHighlight({ flight = null, trip = null } = {}) {
      highlightFlight = flight || null;
      highlightTrip = trip || null;
      if (overlay) overlay.setProps({ layers: buildLayers() });
    },
    setTheme(next) { applyTheme(next); },
    animateYears,
    stopAnimation,
    reset() {
      stopAnimation();
      Object.keys(visibility).forEach(k => { visibility[k] = true; });
      legend.querySelectorAll('label[data-layer]').forEach(label => {
        label.classList.remove('off');
      });
      fromYear = minYear;
      toYear = maxYear;
      highlightFlight = null;
      highlightTrip = null;
      updateSliderUi();
      renderStats();
      if (overlay) overlay.setProps({ layers: buildLayers() });
    },
  };
  window.addEventListener('message', (e) => {
    // Reject anything not from an explicitly allowed origin.
    if (parentOrigins.size && !parentOrigins.has(e.origin)) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (!d.type.startsWith('bigfoot:')) return;
    switch (d.type.slice(8)) {
      case 'setLayers': api.setLayers(d.layers); break;
      case 'setView': api.setView(d); break;
      case 'setYearRange': api.setYearRange(d.from, d.to); break;
      case 'setHighlight': api.setHighlight(d); break;
      case 'setTheme': api.setTheme(d.theme); break;
      case 'animateYears': api.animateYears(d); break;
      case 'stopAnimation': api.stopAnimation(); break;
      case 'reset': api.reset(); break;
    }
  });
  // Let the parent know we're ready to receive messages.
  map.on('load', () => postToParent({ type: 'bigfoot:ready' }));
}).catch(err => console.error(err));

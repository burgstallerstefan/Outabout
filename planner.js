(() => {
  "use strict";

  const app = window.Outabout;
  const map = app.map;
  const route = app.state.route;
  const util = app.util;
  const ui = {
    card: app.el("routeInfo"),
    title: app.el("routeTitle"),
    grid: app.el("routeGrid"),
    list: app.el("routePointList"),
    actions: app.el("routeActions"),
    start: app.el("startRoute"),
    clear: app.el("clearRoute"),
    center: app.el("routeCenterBtn"),
    share: app.el("shareRoute"),
    export: app.el("exportRouteGpx"),
    toggle: app.el("routeListToggle"),
    elevation: app.el("elevationProfile"),
  };

  const ROUTE_KEY = "outabout.route.v2";
  const LEGACY_KEY = "outabout.route.v1";
  const FS = "\x1f";
  const RS = "\x1e";
  const modeCodes = {
    wandern: "w",
    alpin: "a",
    rennrad: "r",
    gravel: "g",
    mtb: "m",
    spazieren: "s",
  };
  const codeModes = Object.fromEntries(
    Object.entries(modeCodes).map(([key, value]) => [value, key]),
  );
  const legacyTypes = {
    gps: "Aktueller Standort",
    alms: "Alm / Alpe",
    huts: "Hütte",
    food: "Gasthaus / Unterkunft",
    localities: "Ort / Lokalität",
    peaks: "Gipfel",
    map: "",
    shared: "",
  };
  const legacyCategories = {
    g: "gps",
    a: "alms",
    h: "huts",
    f: "food",
    l: "localities",
    p: "peaks",
    m: "map",
    s: "shared",
  };

  let markers = [];
  let collapsed = false;
  let sharedRoute = false;
  let calculationId = 0;
  let activeController = null;
  let rebuildTimer = null;
  const routeCache = new Map();
  const CACHE_MS = 5 * 60 * 1000;

  class NoRouteError extends Error {
    constructor(message) {
      super(message);
      this.name = "NoRouteError";
      this.code = "NO_ROUTE";
    }
  }

  class TechnicalRouteError extends Error {
    constructor(code, message, cause) {
      super(message, cause ? { cause } : undefined);
      this.name = "TechnicalRouteError";
      this.code = code;
    }
  }

  function featureCollection(features = []) {
    return { type: "FeatureCollection", features };
  }

  function safeSetData(sourceId, data) {
    try {
      map.getSource(sourceId)?.setData(data);
    } catch (error) {
      app.log("planner:setData", error, { sourceId });
    }
  }

  function installRouteLayers() {
    const empty = featureCollection();
    const addSource = (id, data = empty) => {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data });
    };
    addSource("route-good");
    addSource("route-fallback");
    addSource("route-segments-hit");
    addSource("route-segment-hover");
    addSource("route-arrows");

    if (!map.getLayer("route-good-outline")) {
      map.addLayer({
        id: "route-good-outline",
        type: "line",
        source: "route-good",
        paint: { "line-width": 10, "line-color": "#fff", "line-opacity": 0.94 },
      });
    }
    if (!map.getLayer("route-good-line")) {
      map.addLayer({
        id: "route-good-line",
        type: "line",
        source: "route-good",
        paint: { "line-width": 6, "line-color": "#7a24b8", "line-opacity": 1 },
      });
    }
    if (!map.getLayer("route-fallback-outline")) {
      map.addLayer({
        id: "route-fallback-outline",
        type: "line",
        source: "route-fallback",
        paint: { "line-width": 9, "line-color": "#fff", "line-opacity": 0.9 },
      });
    }
    if (!map.getLayer("route-fallback-line")) {
      map.addLayer({
        id: "route-fallback-line",
        type: "line",
        source: "route-fallback",
        paint: {
          "line-width": 5,
          "line-color": "#858585",
          "line-opacity": 0.96,
          "line-dasharray": [1.4, 1.1],
        },
      });
    }
    if (!map.getLayer("route-segment-hover")) {
      map.addLayer({
        id: "route-segment-hover",
        type: "line",
        source: "route-segment-hover",
        paint: {
          "line-width": 12,
          "line-color": "#1769d2",
          "line-opacity": 0.44,
        },
      });
    }
    if (!map.getLayer("route-segment-hit")) {
      map.addLayer({
        id: "route-segment-hit",
        type: "line",
        source: "route-segments-hit",
        paint: { "line-width": 28, "line-color": "#000", "line-opacity": 0 },
      });
    }
    if (!map.getLayer("route-arrows")) {
      map.addLayer({
        id: "route-arrows",
        type: "symbol",
        source: "route-arrows",
        layout: {
          "text-field": "➤",
          "text-size": 17,
          "text-rotate": ["+", ["get", "bearing"], 90],
          "text-rotation-alignment": "map",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#7a24b8",
          "text-halo-color": "#fff",
          "text-halo-width": 2,
        },
      });
    }
  }

  function clearSources() {
    const empty = featureCollection();
    [
      "route-good",
      "route-fallback",
      "route-segments-hit",
      "route-segment-hover",
      "route-arrows",
    ].forEach((id) => safeSetData(id, empty));
  }

  function pointSignature(points = route.points) {
    return points
      .map(
        (point) =>
          `${point.id}:${point.coord[0].toFixed(6)},${point.coord[1].toFixed(6)}`,
      )
      .join("|");
  }

  function activitySignature() {
    const config = app.activity.config;
    return `${app.activity.key}:${config.profile}:${JSON.stringify(config.profileParams || {})}`;
  }

  function routeCacheKey(a, b) {
    return `${activitySignature()}:${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  }

  function getCached(key) {
    const cached = routeCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > CACHE_MS) {
      routeCache.delete(key);
      return null;
    }
    return cached.value;
  }

  function putCached(key, value) {
    routeCache.set(key, { createdAt: Date.now(), value });
    while (routeCache.size > 80)
      routeCache.delete(routeCache.keys().next().value);
  }

  function explicitNoRoute(status, body) {
    if (status !== 400 && status !== 422) return false;
    const message = String(body || "").toLowerCase();
    if (/datafile|profile|syntax|parameter|memory|timeout|retry/.test(message))
      return false;
    return /(target|start) island detected|no (?:track|route) found|route not found|no route possible|unmatched waypoint/.test(
      message,
    );
  }

  async function fetchLeg(a, b, signal) {
    const cacheKey = routeCacheKey(a, b);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const config = app.activity.config;
    const params = new URLSearchParams({
      lonlats: `${a[0]},${a[1]}|${b[0]},${b[1]}`,
      profile: config.profile,
      alternativeidx: "0",
      format: "geojson",
    });
    Object.entries(config.profileParams || {}).forEach(([key, value]) => {
      params.set(key, String(value));
    });

    let response;
    try {
      response = await fetch(`${app.config.brouterUrl}?${params}`, {
        signal,
        cache: "no-store",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TechnicalRouteError(
        "NETWORK",
        "BRouter ist über das Netzwerk nicht erreichbar.",
        error,
      );
    }

    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw new TechnicalRouteError(
        "INVALID_RESPONSE",
        "BRouter-Antwort konnte nicht gelesen werden.",
        error,
      );
    }

    if (!response.ok) {
      if (explicitNoRoute(response.status, body))
        throw new NoRouteError(body.trim());
      throw new TechnicalRouteError(
        "HTTP",
        `BRouter-Serverfehler (HTTP ${response.status}).`,
      );
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (error) {
      throw new TechnicalRouteError(
        "INVALID_JSON",
        "BRouter hat keine gültige GeoJSON-Antwort geliefert.",
        error,
      );
    }
    const feature =
      data?.type === "FeatureCollection" ? data.features?.[0] : data;
    const coords = feature?.geometry?.coordinates;
    if (
      !Array.isArray(coords) ||
      coords.length < 2 ||
      coords.some((coord) => !util.validCoord(coord))
    ) {
      throw new TechnicalRouteError(
        "INVALID_GEOMETRY",
        "BRouter hat keine gültige Routengeometrie geliefert.",
      );
    }
    if (
      util.km(a, coords[0]) > 0.12 ||
      util.km(b, coords[coords.length - 1]) > 0.12
    ) {
      throw new TechnicalRouteError(
        "INVALID_GEOMETRY",
        "BRouter hat die Routenpunkte unplausibel weit verschoben.",
      );
    }

    const value = { coords, properties: feature.properties || {} };
    putCached(cacheKey, value);
    return value;
  }

  function durationFor(dist, up, down) {
    switch (app.activity.key) {
      case "alpin":
        return dist / 3.5 + up / 500 + down / 900;
      case "spazieren":
        return dist / 4.5 + up / 700 + down / 1400;
      case "rennrad":
        return dist / 22 + up / 850 + down / 2500;
      case "gravel":
        return dist / 17 + up / 700 + down / 2000;
      case "mtb":
        return dist / 14 + up / 650 + down / 1700;
      default:
        return dist / 4 + up / 600 + down / 1200;
    }
  }

  function analyzeSegments(segments) {
    const coords = [];
    const edgeStatuses = [];
    for (const segment of segments) {
      segment.coords.forEach((coord, index) => {
        if (coords.length)
          edgeStatuses.push(index === 0 ? "break" : segment.status);
        coords.push(coord);
      });
    }
    const remainingDistance = new Array(coords.length).fill(0);
    const remainingUp = new Array(coords.length).fill(0);
    let up = 0;
    let down = 0;
    for (let index = coords.length - 2; index >= 0; index -= 1) {
      if (edgeStatuses[index] === "break") {
        remainingDistance[index] = remainingDistance[index + 1];
        remainingUp[index] = remainingUp[index + 1];
        continue;
      }
      const distance = util.km(coords[index], coords[index + 1]);
      let ascent = 0;
      if (
        Number.isFinite(Number(coords[index][2])) &&
        Number.isFinite(Number(coords[index + 1][2]))
      ) {
        const delta = Number(coords[index + 1][2]) - Number(coords[index][2]);
        if (delta > 0) ascent = delta;
        if (delta < 0) down += -delta;
      }
      up += ascent;
      remainingDistance[index] = remainingDistance[index + 1] + distance;
      remainingUp[index] = remainingUp[index + 1] + ascent;
    }
    const dist = remainingDistance[0] || 0;
    return {
      coords,
      edgeStatuses,
      dist,
      up,
      down,
      duration: durationFor(dist, up, down),
      remainingDistance,
      remainingUp,
    };
  }

  function arrowsForSegments(
    segments,
    fromCoordIndex = 0,
    lookAheadKm = Infinity,
  ) {
    const candidates = [];
    let globalIndex = 0;
    let walked = 0;
    for (const segment of segments) {
      const coords = segment.coords || [];
      if (segment.status !== "routed") {
        globalIndex += Math.max(0, coords.length - 1);
        continue;
      }
      let sinceArrow = 0;
      for (let index = 1; index < coords.length; index += 1) {
        globalIndex += 1;
        const distance = util.km(coords[index - 1], coords[index]);
        if (globalIndex < fromCoordIndex) continue;
        walked += distance;
        sinceArrow += distance;
        if (walked > lookAheadKm) break;
        if (sinceArrow < 0.5) continue;
        sinceArrow = 0;
        candidates.push({
          coord: coords[index],
          bearing: util.bearing(coords[index - 1], coords[index]),
        });
      }
      if (walked > lookAheadKm) break;
    }

    const kept = [];
    for (const candidate of candidates) {
      const overlaps = kept.some(
        (old) => util.km(candidate.coord, old.coord) < 0.12,
      );
      if (!overlaps) kept.push(candidate);
    }
    return featureCollection(
      kept.map((item) => ({
        type: "Feature",
        properties: { bearing: item.bearing },
        geometry: { type: "Point", coordinates: item.coord },
      })),
    );
  }

  function drawRoute() {
    const features = route.segments.map((segment, index) => ({
      type: "Feature",
      properties: { segmentIndex: index, status: segment.status },
      geometry: { type: "LineString", coordinates: segment.coords },
    }));
    safeSetData(
      "route-good",
      featureCollection(
        features.filter((feature) => feature.properties.status === "routed"),
      ),
    );
    safeSetData(
      "route-fallback",
      featureCollection(
        features.filter((feature) => feature.properties.status === "fallback"),
      ),
    );
    safeSetData("route-segments-hit", featureCollection(features));
    safeSetData("route-arrows", arrowsForSegments(route.segments));
  }

  function abortRouting() {
    calculationId += 1;
    activeController?.abort();
    activeController = null;
  }

  function routingMessage(error) {
    switch (error?.code) {
      case "TIMEOUT":
        return "Routing-Zeitüberschreitung. Bitte erneut versuchen.";
      case "NETWORK":
        return "BRouter ist offline oder nicht erreichbar. Die Strecke wurde nicht als unpassierbar markiert.";
      case "HTTP":
        return `${error.message} Die Strecke wurde nicht als unpassierbar markiert.`;
      default:
        return `${error?.message || "Routing technisch fehlgeschlagen."} Kein linearer Fallback wurde erzeugt.`;
    }
  }

  async function calculateRoute({ preserveVisible = false } = {}) {
    if (route.points.length < 2) return null;
    abortRouting();
    const id = calculationId;
    const signature = pointSignature();
    const activityAtStart = activitySignature();
    const snapshot = route.points.map((point) => ({
      ...point,
      coord: [...point.coord],
    }));
    const controller = new AbortController();
    activeController = controller;
    route.calculating = true;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, app.config.routeTimeoutMs);
    app.setStatus(
      `Berechne ${app.activity.config.label}-Route abschnittsweise …`,
    );

    try {
      const legs = await Promise.all(
        snapshot.slice(0, -1).map(async (from, index) => {
          const to = snapshot[index + 1];
          try {
            const result = await fetchLeg(
              from.coord,
              to.coord,
              controller.signal,
            );
            return {
              status: "routed",
              coords: result.coords,
              properties: result.properties,
            };
          } catch (error) {
            if (error instanceof NoRouteError) {
              return {
                status: "fallback",
                coords: [from.coord, to.coord],
                reason: error.message,
              };
            }
            throw error;
          }
        }),
      );

      if (
        id !== calculationId ||
        signature !== pointSignature() ||
        activityAtStart !== activitySignature() ||
        controller.signal.aborted
      ) {
        throw new DOMException("Veraltete Berechnung", "AbortError");
      }

      const analyzed = analyzeSegments(legs);
      route.segments = legs;
      route.coords = analyzed.coords;
      route.edgeStatuses = analyzed.edgeStatuses;
      route.stats = analyzed;
      route.name = `${app.activity.config.label}-Route`;
      route.pointSignature = signature;
      route.stale = false;
      drawRoute();
      renderMarkers();
      updateStats();
      drawElevation(analyzed.coords);
      renderUI();
      const failed = legs.filter((leg) => leg.status === "fallback").length;
      app.setStatus(
        failed
          ? `${failed} Abschnitt${failed === 1 ? "" : "e"} laut BRouter nicht routbar · nur diese sind grau gestrichelt.`
          : `${app.activity.config.label}-Route berechnet. Linie ziehen, um einen Zwischenpunkt einzufügen.`,
        failed ? "warning" : "success",
      );
      app.emit("route:calculated", { route });
      return analyzed;
    } catch (error) {
      if (timedOut)
        error = new TechnicalRouteError(
          "TIMEOUT",
          "BRouter hat nicht rechtzeitig geantwortet.",
        );
      if (error?.name === "AbortError" && !timedOut) return null;
      controller.abort();
      if (!preserveVisible || route.stale) clearSources();
      app.log("routing", error, { signature, activity: activityAtStart });
      app.setStatus(routingMessage(error), "error");
      app.emit("route:error", { error });
      return null;
    } finally {
      clearTimeout(timeout);
      route.calculating = false;
      if (id === calculationId) activeController = null;
    }
  }

  function scheduleCalculation(delay = 90, options) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      calculateRoute(options);
    }, delay);
  }

  function detachSharedHash() {
    if (!/^#(?:r|route)=/.test(location.hash)) return;
    try {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (error) {
      app.log("share:detach", error);
    }
    sharedRoute = false;
  }

  function pointsChanged({ recalculate = true, openList = false } = {}) {
    detachSharedHash();
    abortRouting();
    route.stale = true;
    route.segments = [];
    route.coords = [];
    route.stats = null;
    route.edgeStatuses = [];
    route.importedTrack = false;
    clearSources();
    if (openList) collapsed = false;
    renderMarkers();
    renderList();
    renderUI();
    persist();
    app.emit("route:pointschange", { points: route.points });
    if (recalculate && route.points.length >= 2) scheduleCalculation();
  }

  function normalizePoint(coord, meta = {}, index = route.points.length) {
    if (!util.validCoord(coord)) return null;
    return {
      id: typeof meta.id === "string" && meta.id ? meta.id : util.id("point"),
      coord: util.coord(coord),
      name: String(meta.name || `Punkt ${index + 1}`).slice(0, 180),
      type: String(meta.type || "").slice(0, 120),
      cat: String(meta.cat || "map").slice(0, 40),
    };
  }

  function addPoint(coord, meta = {}) {
    if (route.points.length >= app.config.maxRoutePoints) {
      app.setStatus(
        `Maximal ${app.config.maxRoutePoints} Routenpunkte sind möglich.`,
        "warning",
      );
      return false;
    }
    const point = normalizePoint(coord, meta);
    if (!point) return false;
    route.points.push(point);
    pointsChanged();
    return true;
  }

  async function ensureLocationStart() {
    if (route.points.length) return true;
    let coord = app.state.gps.coord;
    if (!util.validCoord(coord)) {
      try {
        coord = await app.navigation?.requestLocation?.({
          pan: true,
          silent: false,
        });
      } catch (error) {
        app.log("planner:location-start", error);
        return false;
      }
    }
    if (route.points.length) return true;
    const point = normalizePoint(
      coord,
      {
        name: "Aktueller Standort",
        type: "",
        cat: "gps",
      },
      0,
    );
    if (!point) return false;
    route.points.push(point);
    pointsChanged({ recalculate: false });
    return true;
  }

  async function addPoi(coord, meta = {}) {
    if (!route.points.length && !(await ensureLocationStart())) return false;
    return addPoint(coord, meta);
  }

  function insertBetween(segmentIndex, coord) {
    if (segmentIndex < 0 || segmentIndex >= route.points.length - 1)
      return false;
    const point = normalizePoint(
      coord,
      {
        name: `Punkt ${segmentIndex + 2}`,
        type: "Kartenpunkt",
        cat: "map",
      },
      segmentIndex + 1,
    );
    if (!point) return false;
    route.points.splice(segmentIndex + 1, 0, point);
    pointsChanged();
    return true;
  }

  function movePoint(index, coord) {
    if (!route.points[index] || !util.validCoord(coord)) return false;
    route.points[index].coord = util.coord(coord);
    pointsChanged();
    return true;
  }

  function removePoint(index) {
    if (!route.points[index]) return false;
    route.points.splice(index, 1);
    pointsChanged({ recalculate: route.points.length >= 2 });
    if (!route.points.length) app.setStatus("Route gelöscht.");
    else if (route.points.length === 1)
      app.setStatus(
        "Ein Punkt bleibt erhalten; Strecke und Statistik sind ausgeblendet.",
      );
    return true;
  }

  function reorderPoint(from, to) {
    if (
      from === to ||
      !route.points[from] ||
      to < 0 ||
      to >= route.points.length
    )
      return;
    const [point] = route.points.splice(from, 1);
    route.points.splice(to, 0, point);
    pointsChanged();
  }

  function pointIsFallback(index) {
    return (
      route.segments[index - 1]?.status === "fallback" ||
      route.segments[index]?.status === "fallback"
    );
  }

  function clearMarkers() {
    markers.forEach((marker) => marker.remove());
    markers = [];
  }

  function openPointPopup(point, index) {
    document
      .querySelectorAll(".maplibregl-popup")
      .forEach((element) => element.remove());
    const body = document.createElement("div");
    body.className = "point-popup";
    const title = document.createElement("b");
    title.textContent = point.name || `Punkt ${index + 1}`;
    body.appendChild(title);
    if (point.type) {
      const type = document.createElement("div");
      type.className = "popup-subtitle";
      type.textContent = point.type;
      body.appendChild(type);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "popbtn good";
    add.textContent = "＋ Hinzufügen";
    add.addEventListener("click", async () => {
      add.disabled = true;
      const added = await addPoi(point.coord, {
        name: point.name,
        type: point.type,
        cat: point.cat,
      });
      if (added) popup.remove();
      else add.disabled = false;
    });
    body.appendChild(add);

    const google = document.createElement("a");
    google.className = "popup-link";
    google.textContent = "In Google Maps öffnen";
    google.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${point.name} ${point.coord[1]},${point.coord[0]}`)}`;
    google.target = "_blank";
    google.rel = "noopener noreferrer";
    body.appendChild(google);

    app.media?.appendPointMedia?.(body, {
      id: point.id,
      routePointId: point.id,
      coord: point.coord,
      name: point.name,
    });

    const remove = document.createElement("button");
    remove.className = "popbtn warn";
    remove.textContent = "Löschen";
    remove.addEventListener("click", () => {
      popup.remove();
      removePoint(index);
    });
    body.appendChild(remove);

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 18,
    })
      .setLngLat(point.coord)
      .setDOMContent(body)
      .addTo(map);
  }

  function renderMarkers() {
    clearMarkers();
    if (!map.loaded()) return;
    route.points.forEach((point, index) => {
      const markerElement = document.createElement("button");
      markerElement.type = "button";
      markerElement.className = `route-point-marker${pointIsFallback(index) ? " fallback" : ""}`;
      markerElement.textContent = String(index + 1);
      markerElement.dataset.routePointId = point.id;
      markerElement.setAttribute(
        "aria-label",
        `${point.name}, Routenpunkt ${index + 1}`,
      );
      markerElement.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPointPopup(point, index);
      });
      const marker = new maplibregl.Marker({
        element: markerElement,
        draggable: false,
      })
        .setLngLat(point.coord)
        .addTo(map);
      markers.push(marker);
    });
  }

  function beginListDrag(event, fromIndex) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    let targetIndex = fromIndex;
    handle.setPointerCapture?.(pointerId);
    const controller = new AbortController();
    const rows = () => [...ui.list.querySelectorAll(".route-order-row")];
    const clear = () =>
      rows().forEach((row) => row.classList.remove("drop-target"));

    handle.addEventListener(
      "pointermove",
      (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const row = document
          .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          ?.closest?.(".route-order-row");
        if (!row || !ui.list.contains(row)) return;
        const index = Number(row.dataset.index);
        if (!Number.isInteger(index)) return;
        targetIndex = index;
        clear();
        row.classList.add("drop-target");
      },
      { signal: controller.signal },
    );
    const finish = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      clear();
      controller.abort();
      if (targetIndex !== fromIndex) reorderPoint(fromIndex, targetIndex);
    };
    handle.addEventListener("pointerup", finish, { signal: controller.signal });
    handle.addEventListener("pointercancel", finish, {
      signal: controller.signal,
    });
  }

  function renderList() {
    if (!ui.list) return;
    ui.list.replaceChildren();
    route.points.forEach((point, index) => {
      const row = document.createElement("div");
      row.className = "route-order-row";
      row.dataset.index = String(index);

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "route-drag-handle";
      handle.textContent = "☰";
      handle.title = "Punkt verschieben";
      handle.setAttribute(
        "aria-label",
        `${point.name} in der Reihenfolge verschieben`,
      );
      handle.addEventListener("pointerdown", (event) =>
        beginListDrag(event, index),
      );

      const badge = document.createElement("span");
      badge.className = `route-list-badge${pointIsFallback(index) ? " fallback" : ""}`;
      badge.textContent = String(index + 1);

      const info = document.createElement("button");
      info.type = "button";
      info.className = "route-point-info";
      const name = document.createElement("strong");
      name.textContent = point.name || `Punkt ${index + 1}`;
      info.appendChild(name);
      if (point.type) {
        const type = document.createElement("small");
        type.textContent = point.type;
        info.appendChild(type);
      }
      info.addEventListener("click", () => {
        map.easeTo({
          center: point.coord,
          zoom: Math.max(map.getZoom(), 16),
          pitch: 0,
          duration: 350,
        });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "route-remove-point";
      remove.textContent = "×";
      remove.title = "Punkt entfernen";
      remove.setAttribute("aria-label", `${point.name} entfernen`);
      remove.addEventListener("click", () => removePoint(index));
      row.append(handle, badge, info, remove);
      ui.list.appendChild(row);
    });
  }

  function renderUI() {
    const count = route.points.length;
    if (!ui.card) return;
    ui.card.hidden = count === 0;
    syncRouteCenterButton();
    if (!count) return;
    const displayedActivity =
      route.stats && route.name
        ? route.name.replace(/-Route$/, "")
        : app.activity.config.label;
    ui.title.textContent =
      count === 1 ? "1 Punkt" : `${count} Punkte · ${displayedActivity}`;
    ui.toggle.hidden = count < 2;
    ui.toggle.textContent = collapsed ? "⌄" : "⌃";
    ui.toggle.setAttribute("aria-expanded", String(!collapsed));
    ui.list.hidden = count >= 2 && collapsed;
    ui.grid.hidden = count < 2 || collapsed;
    ui.actions.hidden = count < 2 || collapsed;
    if (ui.elevation)
      ui.elevation.hidden = count < 2 || collapsed || !route.stats;
    ui.start.disabled = !route.coords?.length || route.calculating;
  }

  function updateStats() {
    const stats = route.stats;
    const set = (id, value) => {
      const element = app.el(id);
      if (element) element.textContent = value;
    };
    set("routeRemain", stats ? `${stats.dist.toFixed(1)} km` : "—");
    set("routeUp", stats ? `${Math.round(stats.up)} hm` : "—");
    set("routeDown", stats ? `${Math.round(stats.down)} hm` : "—");
    set("routeDuration", stats ? util.formatDuration(stats.duration) : "—");
  }

  function drawElevation(coords) {
    const svg = app.el("elevationSvg");
    const range = app.el("elevationRange");
    const ends = app.el("elevationEnds");
    if (!svg || !ui.elevation) return;
    let elevations = (coords || [])
      .map((coord) => Number(coord?.[2]))
      .filter(Number.isFinite);
    if (elevations.length < 2) {
      ui.elevation.hidden = true;
      svg.replaceChildren();
      return;
    }
    if (elevations.length > 160) {
      elevations = Array.from(
        { length: 160 },
        (_, index) =>
          elevations[Math.round((index * (elevations.length - 1)) / 159)],
      );
    }
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const padding = Math.max(8, (max - min) * 0.08);
    const low = min - padding;
    const high = max + padding;
    const points = elevations
      .map((elevation, index) => {
        const x = 4 + (index / Math.max(1, elevations.length - 1)) * 312;
        const y = 68 - ((elevation - low) / Math.max(1, high - low)) * 62;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    svg.innerHTML = `<polygon points="4,68 ${points} 316,68" class="elevation-area"></polygon><polyline points="${points}" class="elevation-line"></polyline>`;
    range.textContent = `${Math.round(min)}–${Math.round(max)} m`;
    ends.firstElementChild.textContent = `${Math.round(elevations[0])} m`;
    ends.lastElementChild.textContent = `${Math.round(elevations[elevations.length - 1])} m`;
    ui.elevation.hidden = collapsed;
  }

  function pointInViewport(point, width, height) {
    return (
      point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
    );
  }

  function segmentIntersectsViewport(from, to, width, height) {
    if (
      pointInViewport(from, width, height) ||
      pointInViewport(to, width, height)
    )
      return true;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let near = 0;
    let far = 1;
    const clip = (direction, distance) => {
      if (direction === 0) return distance >= 0;
      const ratio = distance / direction;
      if (direction < 0) {
        if (ratio > far) return false;
        if (ratio > near) near = ratio;
      } else {
        if (ratio < near) return false;
        if (ratio < far) far = ratio;
      }
      return true;
    };
    return (
      clip(-dx, from.x) &&
      clip(dx, width - from.x) &&
      clip(-dy, from.y) &&
      clip(dy, height - from.y)
    );
  }

  function routeVisibleInViewport() {
    if (route.coords.length < 2) return true;
    try {
      const canvas = map.getCanvas();
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (!width || !height) return true;
      let previous = map.project([route.coords[0][0], route.coords[0][1]]);
      if (pointInViewport(previous, width, height)) return true;
      for (let index = 1; index < route.coords.length; index += 1) {
        const coord = route.coords[index];
        const current = map.project([coord[0], coord[1]]);
        if (segmentIntersectsViewport(previous, current, width, height))
          return true;
        previous = current;
      }
      return false;
    } catch (error) {
      app.log("planner:route-visibility", error);
      return true;
    }
  }

  function syncRouteCenterButton() {
    if (!ui.center) return;
    ui.center.hidden =
      app.state.tracking.active ||
      route.coords.length < 2 ||
      routeVisibleInViewport();
  }

  function fitRoute() {
    const coords = route.coords.length
      ? route.coords
      : route.points.map((point) => point.coord);
    if (!coords.length) return;
    try {
      if (ui.center) ui.center.hidden = true;
      map.fitBounds(util.bounds(coords), {
        padding: { top: 130, bottom: 230, left: 38, right: 38 },
        duration: 500,
      });
    } catch (error) {
      app.log("planner:fit", error);
    }
  }

  function clearRoute() {
    abortRouting();
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    route.points = [];
    route.segments = [];
    route.coords = [];
    route.edgeStatuses = [];
    route.stats = null;
    route.name = "";
    route.stale = false;
    route.importedTrack = false;
    clearMarkers();
    clearSources();
    renderList();
    renderUI();
    try {
      localStorage.removeItem(ROUTE_KEY);
      localStorage.removeItem(LEGACY_KEY);
      localStorage.removeItem("minitrack.route.v1");
    } catch (error) {
      app.log("planner:clear-storage", error);
    }
    detachSharedHash();
    app.emit("route:clear", {});
    app.setStatus("Route und gespeicherter Stand wurden gelöscht.");
  }

  function persist() {
    try {
      if (!route.points.length) {
        localStorage.removeItem(ROUTE_KEY);
        return;
      }
      localStorage.setItem(
        ROUTE_KEY,
        JSON.stringify({
          v: 2,
          activity: app.activity.key,
          points: route.points.map(({ id, coord, name, type, cat }) => ({
            id,
            coord,
            name,
            type,
            cat,
          })),
          updatedAt: Date.now(),
        }),
      );
    } catch (error) {
      app.log("planner:persist", error);
      app.setStatus("Route konnte lokal nicht gespeichert werden.", "warning");
    }
  }

  function base64UrlEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function base64UrlDecode(value) {
    let encoded = value.replace(/-/g, "+").replace(/_/g, "/");
    while (encoded.length % 4) encoded += "=";
    const binary = atob(encoded);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  }

  function escapeField(value) {
    return encodeURIComponent(String(value || ""));
  }

  function unescapeField(value) {
    return decodeURIComponent(String(value || ""));
  }

  function unescapeLegacyField(value) {
    return String(value || "")
      .replace(/\\r/g, RS)
      .replace(/\\f/g, FS)
      .replace(/\\\\/g, "\\");
  }

  function shareUrl() {
    if (route.points.length < 2) return null;
    const header = `3${FS}${modeCodes[app.activity.key] || "w"}`;
    const rows = route.points.map(
      (point) =>
        `${point.coord[0].toFixed(5)}${FS}${point.coord[1].toFixed(5)}${FS}${escapeField(point.cat)}${FS}${escapeField(point.name)}${FS}${escapeField(point.type)}`,
    );
    const url = new URL(location.href);
    url.hash = `r=${base64UrlEncode([header, ...rows].join(RS))}`;
    return url.toString();
  }

  function decodeCompactHash(value) {
    const rows = base64UrlDecode(value).split(RS);
    const header = rows.shift()?.split(FS) || [];
    if (!["2", "3"].includes(header[0])) return null;
    const points = rows.map((row, index) => {
      const fields = row.split(FS);
      const coord = [Number(fields[0]), Number(fields[1])];
      if (!util.validCoord(coord))
        throw new Error("Ungültige Koordinate im Share-Link");
      if (header[0] === "2") {
        const cat = legacyCategories[fields[2]] || "shared";
        return normalizePoint(
          coord,
          {
            name:
              unescapeLegacyField(fields.slice(3).join(FS)) ||
              `Punkt ${index + 1}`,
            type: legacyTypes[cat] || "",
            cat,
          },
          index,
        );
      }
      return normalizePoint(
        coord,
        {
          cat: unescapeField(fields[2]) || "shared",
          name: unescapeField(fields[3]) || `Punkt ${index + 1}`,
          type: unescapeField(fields.slice(4).join(FS)),
        },
        index,
      );
    });
    return { activity: codeModes[header[1]] || "wandern", points };
  }

  function decodeLegacyHash(value) {
    const data = JSON.parse(base64UrlDecode(value));
    if (data?.v !== 1 || !Array.isArray(data.p)) return null;
    return {
      activity: String(data.m || "wandern"),
      points: data.p.map((item, index) =>
        normalizePoint(
          [Number(item[0]), Number(item[1])],
          { name: item[2], type: item[3], cat: item[4] || "shared" },
          index,
        ),
      ),
    };
  }

  function decodeHash(hash) {
    let match = String(hash || "").match(/^#r=([^&]+)/);
    if (match) return decodeCompactHash(match[1]);
    match = String(hash || "").match(/^#route=([^&]+)/);
    if (match) return decodeLegacyHash(match[1]);
    return null;
  }

  function readShared() {
    try {
      return decodeHash(location.hash);
    } catch (error) {
      app.log("share:decode", error);
      app.setStatus("Der geteilte Link ist ungültig.", "error");
    }
    return null;
  }

  async function share() {
    const url = shareUrl();
    if (!url) return;
    const title = `Outabout · ${app.activity.config.label}`;
    const text = `${app.activity.config.label}-Route mit ${route.points.length} Punkten`;
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
        app.log("share:web-share", error);
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      app.setStatus("Outabout-Link kopiert.", "success");
      return;
    } catch (error) {
      app.log("share:clipboard", error);
    }
    const textarea = document.createElement("textarea");
    textarea.value = url;
    textarea.className = "offscreen-copy";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    app.setStatus(
      copied ? "Outabout-Link kopiert." : "Link konnte nicht kopiert werden.",
      copied ? "success" : "error",
    );
  }

  function xml(value) {
    return String(value ?? "").replace(
      /[<>&'\"]/g,
      (char) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          "'": "&apos;",
          '"': "&quot;",
        })[char],
    );
  }

  function exportGpx() {
    if (route.coords.length < 2) return;
    const name = (route.name || "Outabout Route").replace(
      /[\\/:*?"<>|]+/g,
      "-",
    );
    const trackSegments = route.segments
      .filter((segment) => segment.coords?.length >= 2)
      .map(
        (segment) =>
          `<trkseg>${segment.coords
            .map(
              (coord) =>
                `<trkpt lat="${coord[1]}" lon="${coord[0]}">${Number.isFinite(Number(coord[2])) ? `<ele>${Number(coord[2])}</ele>` : ""}</trkpt>`,
            )
            .join("")}</trkseg>`,
      )
      .join("");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Outabout" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xml(name)}</name></metadata><trk><name>${xml(name)}</name><type>${xml(app.activity.config.label)}</type>${trackSegments}</trk></gpx>`;
    util.download(
      new Blob([gpx], { type: "application/gpx+xml" }),
      `${name}.gpx`,
    );
    app.setStatus("GPX gespeichert.", "success");
  }

  function importGpxTrack(
    segments,
    { name = "Importierte GPX-Route", waypoints = [] } = {},
  ) {
    const importedSegments = (segments || [])
      .map((coords) =>
        (coords || [])
          .filter(util.validCoord)
          .map((coord) =>
            Number.isFinite(Number(coord[2]))
              ? [Number(coord[0]), Number(coord[1]), Number(coord[2])]
              : util.coord(coord),
          ),
      )
      .filter((coords) => coords.length >= 2)
      .map((coords) => ({ status: "routed", coords, properties: {} }));
    if (!importedSegments.length) return false;
    abortRouting();
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    const importedWaypoints = waypoints
      .map((waypoint, index) => normalizePoint(waypoint.coord, waypoint, index))
      .filter(Boolean);
    route.points = importedWaypoints.length
      ? importedWaypoints
      : [
          normalizePoint(
            importedSegments[0].coords[0],
            { name: "Start", cat: "gpx" },
            0,
          ),
          normalizePoint(
            importedSegments.at(-1).coords.at(-1),
            { name: "Ziel", cat: "gpx" },
            1,
          ),
        ].filter(Boolean);
    const analyzed = analyzeSegments(importedSegments);
    route.segments = importedSegments;
    route.coords = analyzed.coords;
    route.edgeStatuses = analyzed.edgeStatuses;
    route.stats = analyzed;
    route.name = String(name).slice(0, 180) || "Importierte GPX-Route";
    route.pointSignature = pointSignature();
    route.stale = false;
    route.importedTrack = true;
    drawRoute();
    renderMarkers();
    updateStats();
    drawElevation(analyzed.coords);
    renderList();
    renderUI();
    persist();
    app.emit("route:calculated", { route });
    app.setStatus(
      `GPX importiert: ${analyzed.coords.length.toLocaleString("de-AT")} Trackpunkte, ${route.points.length} Wegpunkte und ${importedSegments.length} getrennte Segmente.`,
      "success",
    );
    fitRoute();
    return true;
  }

  function restore() {
    const shared = readShared();
    if (
      shared?.points?.length >= 2 &&
      shared.points.length <= app.config.maxRoutePoints
    ) {
      route.points = shared.points.filter(Boolean);
      app.activity.set(shared.activity, { silent: true });
      collapsed = true;
      sharedRoute = true;
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(ROUTE_KEY) || "null");
      if (saved?.v === 2 && Array.isArray(saved.points)) {
        const restored = saved.points
          .slice(0, app.config.maxRoutePoints)
          .map((point, index) => normalizePoint(point.coord, point, index))
          .filter(Boolean);
        route.points = restored;
        app.activity.set(saved.activity, { silent: true });
        return;
      }

      const legacy = JSON.parse(
        localStorage.getItem(LEGACY_KEY) ||
          localStorage.getItem("minitrack.route.v1") ||
          "null",
      );
      if (legacy?.v !== 1) return;
      if (legacy.kind === "routeHash") {
        const decoded = decodeHash(legacy.hash);
        if (
          decoded?.points?.length >= 2 &&
          decoded.points.length <= app.config.maxRoutePoints
        ) {
          route.points = decoded.points.filter(Boolean);
          app.activity.set(decoded.activity, { silent: true });
          persist();
        }
        return;
      }
      if (legacy.kind === "single") {
        const point = normalizePoint(legacy.point, legacy.meta || {}, 0);
        if (point) {
          route.points = [point];
          app.activity.set(legacy.mode, { silent: true });
          persist();
        }
      }
    } catch (error) {
      app.log("planner:restore", error);
    }
  }

  function nearestRouteIndex(coord) {
    if (!util.validCoord(coord) || !route.coords.length) return 0;
    let nearest = 0;
    let distance = Infinity;
    route.coords.forEach((candidate, index) => {
      const next = util.km(coord, candidate);
      if (next < distance) {
        distance = next;
        nearest = index;
      }
    });
    return nearest;
  }

  function remainingAt(coord) {
    if (!route.stats) return null;
    const index = nearestRouteIndex(coord);
    return {
      index,
      dist: route.stats.remainingDistance[index] || 0,
      up: route.stats.remainingUp[index] || 0,
    };
  }

  function setNavigationArrows(coord) {
    if (!route.segments.length) return;
    const index = coord ? nearestRouteIndex(coord) : 0;
    safeSetData(
      "route-arrows",
      arrowsForSegments(route.segments, index, coord ? 2.8 : Infinity),
    );
  }

  function setupLineDrag() {
    const container = map.getContainer();
    const canvas = map.getCanvas();
    let drag = null;

    const pixel = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    const segmentAt = (event) => {
      if (!map.getLayer("route-segment-hit")) return null;
      const feature = map.queryRenderedFeatures(pixel(event), {
        layers: ["route-segment-hit"],
      })[0];
      const index = Number(feature?.properties?.segmentIndex);
      return Number.isInteger(index) ? { index, feature } : null;
    };

    const finish = (event, cancelled = false) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const current = drag;
      drag = null;
      try {
        container.releasePointerCapture?.(current.pointerId);
      } catch {}
      if (current.dragPanEnabled) map.dragPan.enable();
      current.marker?.remove();
      safeSetData("route-segment-hover", featureCollection());
      map.getCanvas().style.cursor = "";
      if (cancelled || current.distance < 6) return;
      const lngLat = map.unproject(pixel(event));
      if (insertBetween(current.segmentIndex, [lngLat.lng, lngLat.lat])) {
        app.setStatus(
          `Neuer Punkt ${current.segmentIndex + 2} eingefügt; beide Nachbarsegmente werden neu geroutet.`,
        );
      }
    };

    container.addEventListener(
      "pointerdown",
      (event) => {
        if (drag || app.state.tracking.active || event.isPrimary === false)
          return;
        if (event.button != null && event.button !== 0) return;
        if (
          event.target?.closest?.(
            ".maplibregl-marker,.maplibregl-popup,.map-control,button,input,label,a",
          )
        )
          return;
        const hit = segmentAt(event);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const coord = map.unproject(pixel(event));
        const markerElement = document.createElement("div");
        markerElement.className = "route-insert-preview";
        const marker = new maplibregl.Marker({ element: markerElement })
          .setLngLat(coord)
          .addTo(map);
        const dragPanEnabled = map.dragPan.isEnabled();
        if (dragPanEnabled) map.dragPan.disable();
        container.setPointerCapture?.(event.pointerId);
        drag = {
          pointerId: event.pointerId,
          segmentIndex: hit.index,
          start: pixel(event),
          distance: 0,
          marker,
          dragPanEnabled,
        };
        map.getCanvas().style.cursor = "grabbing";
        app.setStatus(
          `Linie ${hit.index + 1}–${hit.index + 2} ziehen und am neuen Punkt loslassen.`,
        );
      },
      { capture: true, passive: false },
    );

    container.addEventListener(
      "pointermove",
      (event) => {
        if (!drag) {
          if (event.pointerType === "touch") return;
          const hit = segmentAt(event);
          map.getCanvas().style.cursor = hit ? "grab" : "";
          safeSetData(
            "route-segment-hover",
            hit
              ? featureCollection([
                  {
                    type: "Feature",
                    properties: {},
                    geometry: hit.feature.geometry,
                  },
                ])
              : featureCollection(),
          );
          return;
        }
        if (event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const point = pixel(event);
        drag.distance = Math.max(
          drag.distance,
          Math.hypot(point[0] - drag.start[0], point[1] - drag.start[1]),
        );
        const lngLat = map.unproject(point);
        drag.marker.setLngLat(lngLat);
        const from = route.points[drag.segmentIndex]?.coord;
        const to = route.points[drag.segmentIndex + 1]?.coord;
        if (from && to) {
          safeSetData(
            "route-segment-hover",
            featureCollection([
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: [from, [lngLat.lng, lngLat.lat], to],
                },
              },
            ]),
          );
        }
      },
      { capture: true, passive: false },
    );
    container.addEventListener("pointerup", (event) => finish(event, false), {
      capture: true,
    });
    container.addEventListener(
      "pointercancel",
      (event) => finish(event, true),
      { capture: true },
    );
    window.addEventListener("blur", () => {
      if (drag)
        finish(
          {
            pointerId: drag.pointerId,
            clientX: drag.start[0],
            clientY: drag.start[1],
          },
          true,
        );
    });
  }

  app.planner = {
    get points() {
      return route.points;
    },
    pointCount: () => route.points.length,
    hasStart: () => route.points.length > 0,
    addPoint,
    addPoi,
    setStartPoi(coord, meta) {
      if (route.points.length) return false;
      const added = addPoint(coord, meta);
      if (added)
        app.setStatus(
          `${meta?.name || "Punkt"} als Punkt 1 gesetzt.`,
          "success",
        );
      return added;
    },
    insertBetween,
    movePoint,
    removePoint,
    calculate: calculateRoute,
    fit: fitRoute,
    clear: clearRoute,
    importGpxTrack,
    share,
    getShareUrl: shareUrl,
    nearestRouteIndex,
    remainingAt,
    setNavigationArrows,
    staticArrows: () => setNavigationArrows(null),
    render: () => {
      renderMarkers();
      renderList();
      renderUI();
    },
  };

  ui.toggle?.addEventListener("click", () => {
    collapsed = !collapsed;
    renderUI();
  });
  ui.center?.addEventListener("click", fitRoute);
  ui.clear?.addEventListener("click", clearRoute);
  ui.share?.addEventListener("click", share);
  ui.export?.addEventListener("click", exportGpx);
  ui.start?.addEventListener("click", () => app.navigation?.start?.());
  app.el("elevationToggle")?.addEventListener("click", () => {
    const body = app.el("elevationBody");
    const open = body?.hidden !== false;
    if (body) body.hidden = !open;
    app.el("elevationToggle")?.setAttribute("aria-expanded", String(open));
    app.el("elevationToggleIcon").textContent = open ? "▴" : "▾";
  });

  app.on("activity:change", () => {
    persist();
    if (route.points.length >= 2 && !route.importedTrack)
      scheduleCalculation(40, { preserveVisible: true });
    renderUI();
  });
  app.on("tracking:start", () => {
    markers.forEach((marker) => (marker.getElement().hidden = true));
    syncRouteCenterButton();
  });
  app.on("tracking:stop", () => {
    markers.forEach((marker) => (marker.getElement().hidden = false));
    setNavigationArrows(null);
    syncRouteCenterButton();
  });

  restore();
  renderList();
  renderUI();
  app.whenMapReady(() => {
    installRouteLayers();
    renderMarkers();
    renderUI();
    setupLineDrag();
    map.on("moveend", syncRouteCenterButton);
    map.on("resize", syncRouteCenterButton);
    if (route.points.length >= 2) {
      if (sharedRoute) fitRoute();
      scheduleCalculation(80);
    } else if (route.points.length === 1) {
      map.easeTo({
        center: route.points[0].coord,
        zoom: Math.max(map.getZoom(), 15),
        duration: 0,
      });
    }
  });
})();

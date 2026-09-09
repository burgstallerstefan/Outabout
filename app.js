(() => {
  "use strict";

  const events = new EventTarget();
  const state = {
    activity: "wandern",
    gps: { coord: null, accuracy: null, marker: null },
    route: {
      points: [],
      segments: [],
      coords: [],
      stats: null,
      name: "",
      stale: false,
      calculating: false,
    },
    tracking: {
      active: false,
      paused: false,
      follow: true,
      points: [],
      km: 0,
    },
  };

  const app = {
    version: "2026.09.09.1",
    state,
    events,
    config: {
      brouterUrl: "https://brouter.de/brouter",
      maxRoutePoints: 50,
      routeTimeoutMs: 15000,
    },
    modules: {},
    ui: {},
    on(type, listener, options) {
      const wrapped = (event) => listener(event.detail, event);
      events.addEventListener(type, wrapped, options);
      return () => events.removeEventListener(type, wrapped, options);
    },
    emit(type, detail) {
      events.dispatchEvent(new CustomEvent(type, { detail }));
    },
    el(id) {
      return document.getElementById(id);
    },
    setStatus(message, level = "info") {
      const status = document.getElementById("status");
      if (!status) return;
      status.textContent = String(message || "");
      status.dataset.level = level;
    },
    log(scope, error, context) {
      const method = error ? "error" : "info";
      console[method](`[Outabout:${scope}]`, error || "", context || "");
    },
  };

  app.util = {
    emptyFeatureCollection() {
      return { type: "FeatureCollection", features: [] };
    },
    validCoord(coord) {
      return (
        Array.isArray(coord) &&
        Number.isFinite(Number(coord[0])) &&
        Number.isFinite(Number(coord[1])) &&
        Number(coord[0]) >= -180 &&
        Number(coord[0]) <= 180 &&
        Number(coord[1]) >= -90 &&
        Number(coord[1]) <= 90
      );
    },
    coord(coord) {
      return [Number(coord[0]), Number(coord[1])];
    },
    km(a, b) {
      const radius = 6371;
      const lat1 = (Number(a[1]) * Math.PI) / 180;
      const lat2 = (Number(b[1]) * Math.PI) / 180;
      const dLat = lat2 - lat1;
      const dLon = ((Number(b[0]) - Number(a[0])) * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
    },
    bearing(a, b) {
      const lat1 = (Number(a[1]) * Math.PI) / 180;
      const lat2 = (Number(b[1]) * Math.PI) / 180;
      const dLon = ((Number(b[0]) - Number(a[0])) * Math.PI) / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    },
    formatDuration(hours) {
      const value = Number(hours);
      if (!Number.isFinite(value) || value <= 0) return "—";
      const minutes = Math.max(1, Math.round(value * 60));
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
    },
    escapeHtml(value) {
      return String(value ?? "").replace(
        /[&<>"']/g,
        (char) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[char],
      );
    },
    id(prefix = "id") {
      if (globalThis.crypto?.randomUUID)
        return `${prefix}-${crypto.randomUUID()}`;
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    },
    pointRefId({ coord, cat = "point", name = "" }) {
      const c = app.util.validCoord(coord)
        ? `${Number(coord[0]).toFixed(6)},${Number(coord[1]).toFixed(6)}`
        : "unknown";
      return `${cat}:${c}:${String(name).slice(0, 80)}`;
    },
    bounds(coords) {
      const bounds = new maplibregl.LngLatBounds();
      (coords || [])
        .filter(app.util.validCoord)
        .forEach((coord) => bounds.extend(coord));
      return bounds;
    },
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
  };

  window.Outabout = app;

  const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [13.25, 47.45],
    zoom: 8,
    attributionControl: true,
    doubleClickZoom: false,
  });
  app.map = map;
  // Explicitly disable double-click / double-tap zoom as well. This avoids
  // the built-in MapLibre gesture competing with Outabout's free-point gesture
  // on mobile browsers such as Android Chrome.
  map.doubleClickZoom?.disable();
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "bottom-right",
  );

  let mapReady = false;
  app.whenMapReady = (callback) => {
    if (mapReady || map.loaded()) {
      callback(map);
      return;
    }
    map.once("load", () => callback(map));
  };

  map.on("load", () => {
    mapReady = true;
    map.doubleClickZoom?.disable();
    app.emit("map:ready", { map });
    app.setStatus("Karte geladen.");
  });
  map.on("error", (event) => {
    app.log("map", event?.error || new Error("MapLibre-Fehler"));
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) map.resize();
  });
})();

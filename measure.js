(() => {
  "use strict";

  const app = window.Outabout;
  const map = app.map;
  const button = app.el("measureBtn");
  const reticle = app.el("measureReticle");
  const panel = app.el("measureInfo");
  const distance = app.el("measureDistance");
  const elevation = app.el("measureElevation");
  let active = false;
  let elevationTimer = null;
  let elevationRequest = null;
  let lastElevationKey = null;

  function centerCoord() {
    const center = map.getCenter();
    return [center.lng, center.lat];
  }

  function formatDistance(km) {
    if (!Number.isFinite(km)) return "Standort fehlt";
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  }

  async function loadElevation(coord) {
    const key = `${coord[1].toFixed(4)},${coord[0].toFixed(4)}`;
    if (key === lastElevationKey) return;
    lastElevationKey = key;
    elevationRequest?.abort();
    elevationRequest = new AbortController();
    elevation.textContent = "wird geladen â€¦";
    try {
      const params = new URLSearchParams({
        latitude: String(coord[1]),
        longitude: String(coord[0]),
      });
      const response = await fetch(
        `https://api.open-meteo.com/v1/elevation?${params}`,
        { signal: elevationRequest.signal },
      );
      const data = await response.json();
      const metres = Number(data?.elevation?.[0]);
      if (!response.ok || !Number.isFinite(metres))
        throw new Error("HÃ¶hendaten nicht verfÃ¼gbar");
      if (key === lastElevationKey)
        elevation.textContent = `${Math.round(metres)} m`;
    } catch (error) {
      if (error.name !== "AbortError" && key === lastElevationKey)
        elevation.textContent = "nicht verfÃ¼gbar";
    }
  }

  function update() {
    if (!active) return;
    const coord = centerCoord();
    const current = app.state.gps.coord;
    distance.textContent = formatDistance(
      app.util.validCoord(current) ? app.util.km(current, coord) : NaN,
    );
    clearTimeout(elevationTimer);
    elevationTimer = setTimeout(() => loadElevation(coord), 220);
  }

  function setActive(next) {
    active = next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    reticle.hidden = !active;
    panel.hidden = !active;
    if (active) update();
    else {
      clearTimeout(elevationTimer);
      elevationRequest?.abort();
      lastElevationKey = null;
    }
  }

  button?.addEventListener("click", () => setActive(!active));
  map.on("move", update);
  app.on("gps:update", update);
})();

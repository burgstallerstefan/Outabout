(() => {
  "use strict";

  const app = window.Outabout;

  function pointFromElement(element) {
    const lat = Number(element.getAttribute("lat"));
    const lng = Number(element.getAttribute("lon"));
    if (!app.util.validCoord([lng, lat])) return null;
    const elevation = Number(
      element.querySelector(":scope > ele")?.textContent,
    );
    return Number.isFinite(elevation) ? [lng, lat, elevation] : [lng, lat];
  }

  function pointSegments(xml, selector) {
    return [...xml.querySelectorAll(selector)]
      .map((element) =>
        [...element.querySelectorAll(":scope > trkpt, :scope > rtept")]
          .map(pointFromElement)
          .filter(Boolean),
      )
      .filter((points) => points.length >= 2);
  }

  function splitDisconnected(points) {
    if (points.length < 3) return [points];
    const steps = points
      .slice(1)
      .map((point, index) => app.util.km(points[index], point))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const median = steps[Math.floor(steps.length / 2)] || 0;
    // A copied-together GPX track can contain an artificial jump. Keep normal
    // sparse recordings intact, but do not draw a line across an outlier gap.
    const maxConnectedGapKm = Math.max(0.5, median * 25);
    const segments = [];
    let current = [points[0]];
    for (const point of points.slice(1)) {
      if (app.util.km(current.at(-1), point) > maxConnectedGapKm) {
        if (current.length >= 2) segments.push(current);
        current = [point];
      } else current.push(point);
    }
    if (current.length >= 2) segments.push(current);
    return segments;
  }

  function trackSegments(xml) {
    const tracks = pointSegments(xml, "trk trkseg");
    if (tracks.length) return tracks.flatMap(splitDisconnected);
    const routes = pointSegments(xml, "rte");
    if (routes.length) return routes.flatMap(splitDisconnected);
    const waypoints = [...xml.querySelectorAll("wpt")]
      .map(pointFromElement)
      .filter(Boolean);
    return waypoints.length >= 2 ? splitDisconnected(waypoints) : [];
  }

  function namedWaypoints(xml) {
    const routePoints = [...xml.querySelectorAll("rte > rtept")];
    const elements = routePoints.length
      ? routePoints
      : [...xml.querySelectorAll("wpt")];
    return elements
      .map((element, index) => {
        const coord = pointFromElement(element);
        if (!coord) return null;
        return {
          coord,
          name:
            element.querySelector(":scope > name")?.textContent?.trim() ||
            `Wegpunkt ${index + 1}`,
          type: "GPX-Wegpunkt",
          cat: "gpx",
        };
      })
      .filter(Boolean);
  }

  function gpxName(xml, fallback) {
    return (
      xml
        .querySelector("metadata > name, trk > name, rte > name")
        ?.textContent?.trim() || fallback.replace(/\.gpx$/i, "")
    );
  }

  function parseGpx(text, filename) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.querySelector("parsererror"))
      throw new Error("Ungültige GPX-Datei");
    const segments = trackSegments(xml);
    if (!segments.length)
      throw new Error(
        "Die GPX-Datei enthält keine Strecke mit mindestens zwei Punkten.",
      );
    return {
      segments,
      waypoints: namedWaypoints(xml),
      name: gpxName(xml, filename),
    };
  }

  async function importGpx(file) {
    if (!file) return;
    try {
      const parsed = parseGpx(await file.text(), file.name || "GPX-Route");
      if (!app.planner?.importGpxTrack(parsed.segments, parsed))
        throw new Error("GPX-Strecke konnte nicht übernommen werden.");
    } catch (error) {
      app.log("gpx:import", error, { name: file.name });
      app.setStatus(error.message || "GPX-Import fehlgeschlagen.", "error");
    }
  }

  const input = app.el("gpxImportInput");
  app.el("gpxImportBtn")?.addEventListener("click", () => {
    if (!input) return;
    input.value = "";
    input.click();
  });
  input?.addEventListener("change", () => importGpx(input.files?.[0]));
})();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
  (match) => match[1].split("?")[0],
);
const localScripts = scripts.filter((source) => !/^https?:/.test(source));

test("jede lokale Script-Referenz existiert und wird nur einmal geladen", () => {
  assert.equal(new Set(localScripts).size, localScripts.length);
  localScripts.forEach((source) =>
    assert.ok(fs.existsSync(path.join(root, source)), `${source} fehlt`),
  );
});

test("die neue Architektur enthält keine Patch-Overrides oder MutationObserver", () => {
  const source = localScripts
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /window\.(?:fetch|maplibregl)\s*=/);
  assert.doesNotMatch(source, /geolocation\.watchPosition\s*=/);
  assert.doesNotMatch(source, /MutationObserver/);
  assert.doesNotMatch(source, /profile=trekking/);
  assert.doesNotMatch(source, /MiniTrack/);
});

test("alle sechs Aktivitätsmodi sind definiert", () => {
  const source = fs.readFileSync(path.join(root, "activity.js"), "utf8");
  for (const mode of [
    "wandern",
    "alpin",
    "rennrad",
    "gravel",
    "mtb",
    "spazieren",
  ]) {
    assert.match(source, new RegExp(`\\b${mode}:`));
  }
});

test("Medien bleiben aus localStorage und Share-Daten heraus", () => {
  const media = fs.readFileSync(path.join(root, "media.js"), "utf8");
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  assert.doesNotMatch(media, /localStorage/);
  assert.doesNotMatch(planner, /objectURL|blob:|mediaItems|indexedDB/i);
});

test("Share-Felder werden verlustfrei codiert und alte Links bleiben lesbar", () => {
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  assert.match(planner, /encodeURIComponent\(String\(value \|\| ""\)\)/);
  assert.match(planner, /function unescapeLegacyField/);
  assert.match(planner, /\["2", "3"\]\.includes\(header\[0\]\)/);
  assert.match(planner, /decodeLegacyHash/);
});

test("lokale Routendaten der Version 1 werden in Version 2 migriert", () => {
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  assert.match(planner, /outabout\.route\.v1/);
  assert.match(planner, /minitrack\.route\.v1/);
  assert.match(planner, /legacy\.kind === "routeHash"/);
  assert.match(planner, /legacy\.kind === "single"/);
});

test("Start, Hinzufügen und Standortstart folgen dem bisherigen Bedienablauf", () => {
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  const pois = fs.readFileSync(path.join(root, "pois.js"), "utf8");
  const navigation = fs.readFileSync(path.join(root, "navigation.js"), "utf8");

  assert.match(pois, /start\.textContent = "Start"/);
  assert.match(pois, /add\.textContent = "＋ Hinzufügen"/);
  assert.doesNotMatch(pois, /Als Punkt 1 setzen/);
  assert.match(planner, /async function ensureLocationStart/);
  assert.match(planner, /name: "Aktueller Standort"/);
  assert.match(planner, /remove\.textContent = "Löschen"/);
  assert.match(navigation, /requestLocation\(\{ pan: true, silent: false \}\)/);
});

test("globale Kartenaktionen enthalten Medien und bedingtes Route-Zentrieren", () => {
  assert.doesNotMatch(html, /id="(?:addRoutePoint|mapAddPointBtn)"/);
  assert.equal((html.match(/id="mediaFolderBtn"/g) || []).length, 1);
  assert.match(
    html,
    /id="top"[\s\S]*id="routeCenterBtn"[\s\S]*id="mediaFolderBtn"/,
  );
  assert.match(html, /id="routeCenterBtn"[\s\S]*hidden/);
  assert.match(html, /id="shareRoute"[\s\S]*<svg/);
  assert.match(html, /id="photosChk"[^>]*checked/);
  assert.match(html, /id="videosChk"[^>]*checked/);
});

test("Geotag-Medien werden als Koordinaten gerendert und nach Import fokussiert", () => {
  const media = fs.readFileSync(path.join(root, "media.js"), "utf8");
  assert.match(media, /coordinates: \[item\.lng, item\.lat\]/);
  assert.match(media, /function focusImportedMedia/);
  assert.match(media, /importedCoords\.push\(\[item\.lng, item\.lat\]\)/);
  assert.match(media, /focusImportedMedia\(importedCoords\)/);
});

test("Medienimport erlaubt Ordner und mehrere einzelne Dateien", () => {
  const media = fs.readFileSync(path.join(root, "media.js"), "utf8");
  assert.match(html, /id="mediaFilesInput"/);
  assert.match(html, /id="selectMediaFiles"/);
  assert.match(html, /id="selectMediaDirectory"/);
  assert.match(media, /function selectMediaFiles/);
  assert.match(media, /multiple: true/);
  assert.match(media, /mediaFilesInput/);
  assert.match(media, /function openMediaSelection/);
});

test("GPX-Import ist global verfügbar und übernimmt die Originalstrecke", () => {
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  const gpx = fs.readFileSync(path.join(root, "gpx.js"), "utf8");
  assert.match(html, /id="gpxImportBtn"/);
  assert.match(html, /id="gpxImportInput"/);
  assert.match(gpx, /function trackSegments/);
  assert.match(gpx, /function splitDisconnected/);
  assert.match(gpx, /function namedWaypoints/);
  assert.match(gpx, /function segmentWaypoints/);
  assert.match(gpx, /rte > rtept/);
  assert.match(gpx, /pointSegments\(xml, "trk trkseg"\)/);
  assert.match(gpx, /tracks\.flatMap\(splitDisconnected\)/);
  assert.match(gpx, /app\.planner\?\.importGpxTrack/);
  assert.match(planner, /function importGpxTrack/);
  assert.match(planner, /route\.segments = importedSegments/);
  assert.match(planner, /index === 0 \? "break" : segment\.status/);
});

test("Routenliste bleibt beim HinzufÃ¼gen eingeklappt und Kartenmarker sind nummeriert", () => {
  const planner = fs.readFileSync(path.join(root, "planner.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(
    planner,
    /function pointsChanged\(\{ recalculate = true, openList = false \} = \{\}\)/,
  );
  assert.match(planner, /markerElement\.textContent = String\(index \+ 1\)/);
  assert.match(
    styles,
    /\.route-point-marker \{[\s\S]*background: var\(--blue\)/,
  );
});

test("Messmodus zeigt ein Kartenfadenkreuz und Standortwerte", () => {
  const measure = fs.readFileSync(path.join(root, "measure.js"), "utf8");
  assert.match(html, /id="measureBtn"/);
  assert.match(html, /id="measureReticle"/);
  assert.match(html, /id="measureDistance"/);
  assert.match(html, /id="measureElevation"/);
  assert.match(measure, /function centerCoord/);
  assert.match(measure, /app\.util\.km\(current, coord\)/);
  assert.match(measure, /api\.open-meteo\.com\/v1\/elevation/);
  assert.match(measure, /map\.on\("move", update\)/);
});

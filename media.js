(() => {
  "use strict";

  const app = window.Outabout;
  const map = app.map;
  const DB_NAME = "outabout-media";
  const DB_VERSION = 1;
  const ITEMS = "items";
  const HANDLES = "handles";
  const supportedExtensions = new Set([
    "jpg",
    "jpeg",
    "heic",
    "heif",
    "png",
    "mp4",
    "mov",
    "m4v",
  ]);
  const mediaItems = new Map();
  const memoryFiles = new Map();
  const objectUrls = new Map();
  let dbPromise = null;
  let workerSequence = 0;
  let importRunning = false;

  function openDatabase() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(ITEMS)) {
            const store = db.createObjectStore(ITEMS, { keyPath: "id" });
            store.createIndex("linkedRoutePointId", "linkedRoutePointId", {
              unique: false,
            });
            store.createIndex("kind", "kind", { unique: false });
          }
          if (!db.objectStoreNames.contains(HANDLES))
            db.createObjectStore(HANDLES, { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  async function transaction(storeName, mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = action(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error || result?.error);
      tx.onabort = () =>
        reject(tx.error || new Error("IndexedDB-Transaktion abgebrochen"));
    });
  }

  const db = {
    getAllItems: () =>
      transaction(ITEMS, "readonly", (store) => store.getAll()),
    putItem: (item) =>
      transaction(ITEMS, "readwrite", (store) => store.put(item)),
    deleteItem: (id) =>
      transaction(ITEMS, "readwrite", (store) => store.delete(id)),
    getHandle: (key) =>
      transaction(HANDLES, "readonly", (store) => store.get(key)),
    putHandle: (key, handle) =>
      transaction(HANDLES, "readwrite", (store) => store.put({ key, handle })),
    deleteHandle: (key) =>
      transaction(HANDLES, "readwrite", (store) => store.delete(key)),
  };

  function extension(name) {
    return String(name || "")
      .split(".")
      .pop()
      .toLowerCase();
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function itemId(scope, path, file) {
    return `media-${stableHash(`${scope}|${path}|${file.size}|${file.lastModified}`)}`;
  }

  function workerClient() {
    const worker = new Worker(
      `media-worker.js?v=${encodeURIComponent(app.version)}`,
    );
    const pending = new Map();
    worker.addEventListener("message", (event) => {
      const job = pending.get(event.data?.id);
      if (!job) return;
      pending.delete(event.data.id);
      job.resolve(event.data.result);
    });
    worker.addEventListener("error", (event) => {
      for (const job of pending.values())
        job.reject(event.error || new Error(event.message));
      pending.clear();
    });
    return {
      inspect(file) {
        return new Promise((resolve, reject) => {
          const id = `worker-${Date.now().toString(36)}-${workerSequence++}`;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, file });
        });
      },
      terminate() {
        worker.terminate();
      },
    };
  }

  function featureCollection() {
    const showPhotos = app.el("photosChk")?.checked !== false;
    const showVideos = app.el("videosChk")?.checked !== false;
    const features = [...mediaItems.values()]
      .filter(
        (item) =>
          Number.isFinite(item.lat) &&
          Number.isFinite(item.lng) &&
          ((item.kind === "photo" && showPhotos) ||
            (item.kind === "video" && showVideos)),
      )
      .map((item) => ({
        type: "Feature",
        id: item.id,
        properties: { id: item.id, kind: item.kind },
        geometry: { type: "Point", coordinates: [item.lng, item.lat] },
      }));
    return { type: "FeatureCollection", features };
  }

  function renderMarkers() {
    try {
      map.getSource("outabout-media")?.setData(featureCollection());
    } catch (error) {
      app.log("media:render", error);
    }
  }

  function focusImportedMedia(coords) {
    const valid = coords.filter(app.util.validCoord);
    if (!valid.length) return;
    try {
      if (valid.length === 1) {
        map.flyTo({
          center: valid[0],
          zoom: Math.max(map.getZoom(), 16),
          duration: 500,
        });
      } else {
        map.fitBounds(app.util.bounds(valid), {
          padding: { top: 100, right: 55, bottom: 100, left: 55 },
          maxZoom: 16,
          duration: 600,
        });
      }
    } catch (error) {
      app.log("media:focus-import", error);
    }
  }

  function installLayers() {
    if (!map.getSource("outabout-media")) {
      map.addSource("outabout-media", {
        type: "geojson",
        data: featureCollection(),
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 52,
      });
    }
    if (!map.getLayer("media-clusters")) {
      map.addLayer({
        id: "media-clusters",
        type: "circle",
        source: "outabout-media",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#1769d2",
            25,
            "#7a24b8",
            100,
            "#8b4b00",
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            19,
            25,
            24,
            100,
            30,
          ],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
        },
      });
    }
    if (!map.getLayer("media-cluster-count")) {
      map.addLayer({
        id: "media-cluster-count",
        type: "symbol",
        source: "outabout-media",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
        paint: { "text-color": "#fff" },
      });
    }
    if (!map.getLayer("media-points")) {
      map.addLayer({
        id: "media-points",
        type: "circle",
        source: "outabout-media",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "match",
            ["get", "kind"],
            "video",
            "#d04a30",
            "#1769d2",
          ],
          "circle-radius": 13,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
        },
      });
    }
    if (!map.getLayer("media-point-label")) {
      map.addLayer({
        id: "media-point-label",
        type: "symbol",
        source: "outabout-media",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["match", ["get", "kind"], "video", "▶", "●"],
          "text-size": ["match", ["get", "kind"], "video", 12, 9],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fff" },
      });
    }

    map.on("click", "media-clusters", async (event) => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.cluster_id;
      if (clusterId == null) return;
      try {
        const zoom = await map
          .getSource("outabout-media")
          .getClusterExpansionZoom(clusterId);
        map.easeTo({
          center: feature.geometry.coordinates,
          zoom,
          duration: 350,
        });
      } catch (error) {
        app.log("media:cluster", error);
      }
    });
    map.on("click", "media-points", (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (id) openMapPopup(id);
    });
    for (const layer of ["media-clusters", "media-points"]) {
      map.on(
        "mouseenter",
        layer,
        () => (map.getCanvas().style.cursor = "pointer"),
      );
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
  }

  async function ensurePermission(handle, request = false) {
    if (!handle?.queryPermission) return true;
    let state = await handle.queryPermission({ mode: "read" });
    if (state !== "granted" && request && handle.requestPermission) {
      state = await handle.requestPermission({ mode: "read" });
    }
    return state === "granted";
  }

  async function fileFromDirectory(item, requestPermission) {
    const record = await db.getHandle(item.directoryKey);
    const root = record?.handle;
    if (!root || !(await ensurePermission(root, requestPermission)))
      return null;
    const parts = String(item.relativePath || item.name)
      .split("/")
      .filter(Boolean);
    let directory = root;
    for (const part of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(part);
    const handle = await directory.getFileHandle(parts.at(-1));
    return handle.getFile();
  }

  async function resolveFile(item, requestPermission = false) {
    if (memoryFiles.has(item.id)) return memoryFiles.get(item.id);
    try {
      if (item.fileHandleKey) {
        const record = await db.getHandle(item.fileHandleKey);
        if (
          !record?.handle ||
          !(await ensurePermission(record.handle, requestPermission))
        )
          return null;
        const file = await record.handle.getFile();
        memoryFiles.set(item.id, file);
        return file;
      }
      if (item.directoryKey) {
        const file = await fileFromDirectory(item, requestPermission);
        if (file) memoryFiles.set(item.id, file);
        return file;
      }
    } catch (error) {
      app.log("media:file-access", error, { id: item.id });
    }
    return null;
  }

  function acquireUrl(item, file) {
    const current = objectUrls.get(item.id);
    if (current) {
      current.refs += 1;
      return current.url;
    }
    const value = { url: URL.createObjectURL(file), refs: 1 };
    objectUrls.set(item.id, value);
    return value.url;
  }

  function releaseUrl(id) {
    const current = objectUrls.get(id);
    if (!current) return;
    current.refs -= 1;
    if (current.refs <= 0) {
      URL.revokeObjectURL(current.url);
      objectUrls.delete(id);
    }
  }

  function formattedDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat("de-AT", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
  }

  function showViewer(item, file) {
    const dialog = app.el("mediaViewer");
    const content = app.el("mediaViewerContent");
    const title = app.el("mediaViewerTitle");
    if (!dialog || !content) return;
    content.replaceChildren();
    title.textContent = item.name;
    const url = acquireUrl(item, file);
    const media = document.createElement(
      item.kind === "video" ? "video" : "img",
    );
    media.src = url;
    media.alt = item.kind === "photo" ? item.name : "";
    if (item.kind === "video") {
      media.controls = true;
      media.preload = "metadata";
      media.autoplay = false;
      media.playsInline = true;
    }
    content.appendChild(media);
    const cleanup = () => {
      if (media instanceof HTMLVideoElement) media.pause();
      media.removeAttribute("src");
      media.load?.();
      releaseUrl(item.id);
      dialog.removeEventListener("close", cleanup);
    };
    dialog.addEventListener("close", cleanup);
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  async function fillPreview(container, item, popup) {
    const file = await resolveFile(item, false);
    if (!popup.isOpen()) return;
    if (!file) {
      container.textContent =
        "Dateizugriff ist nach dem Reload nicht mehr freigegeben.";
      container.className = "media-unavailable";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "popbtn secondary";
      retry.textContent =
        item.directoryKey || item.fileHandleKey
          ? "Zugriff erneut erlauben"
          : "Medienordner erneut auswählen";
      retry.addEventListener("click", async () => {
        if (!item.directoryKey && !item.fileHandleKey) {
          selectDirectory();
          return;
        }
        const permittedFile = await resolveFile(item, true);
        if (permittedFile) {
          container.className = "media-preview-loading";
          container.textContent = "Vorschau wird lokal geladen …";
          await fillPreview(container, item, popup);
        } else
          app.setStatus("Dateizugriff wurde nicht freigegeben.", "warning");
      });
      container.appendChild(retry);
      return;
    }
    const url = acquireUrl(item, file);
    const media = document.createElement(
      item.kind === "video" ? "video" : "img",
    );
    media.src = url;
    media.alt = item.kind === "photo" ? item.name : "";
    media.className = "media-popup-preview";
    if (item.kind === "video") {
      media.controls = true;
      media.preload = "metadata";
      media.playsInline = true;
      media.autoplay = false;
    } else media.loading = "lazy";
    container.replaceChildren(media);
    const open = document.createElement("button");
    open.className = "popbtn good";
    open.textContent = "Öffnen";
    open.addEventListener("click", () => showViewer(item, file));
    container.appendChild(open);
    popup.once("close", () => releaseUrl(item.id));
  }

  function openMapPopup(id) {
    const item = mediaItems.get(id);
    if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lng))
      return;
    const body = document.createElement("div");
    body.className = "media-popup";
    const title = document.createElement("b");
    title.textContent = item.name;
    const details = document.createElement("div");
    details.className = "popup-subtitle";
    details.textContent = `${item.kind === "video" ? "Video" : "Foto"}${item.takenAt ? ` · ${formattedDate(item.takenAt)}` : ""}`;
    const coords = document.createElement("small");
    coords.textContent = `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`;
    const preview = document.createElement("div");
    preview.className = "media-preview-loading";
    preview.textContent = "Vorschau wird lokal geladen …";
    body.append(title, details, coords, preview);
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "340px",
    })
      .setLngLat([item.lng, item.lat])
      .setDOMContent(body)
      .addTo(map);
    fillPreview(preview, item, popup).catch((error) => {
      app.log("media:preview", error, { id });
      preview.textContent = "Vorschau konnte nicht geöffnet werden.";
    });
  }

  async function removeItem(item) {
    mediaItems.delete(item.id);
    memoryFiles.delete(item.id);
    const current = objectUrls.get(item.id);
    if (current) URL.revokeObjectURL(current.url);
    objectUrls.delete(item.id);
    await db.deleteItem(item.id);
    if (item.fileHandleKey)
      await db
        .deleteHandle(item.fileHandleKey)
        .catch((error) => app.log("media:delete-handle", error));
    renderMarkers();
  }

  function linkedItems(linkId) {
    return [...mediaItems.values()].filter(
      (item) => item.linkedRoutePointId === linkId,
    );
  }

  function appendPointMedia(container, reference) {
    const linkId =
      reference.routePointId || reference.id || app.util.pointRefId(reference);
    const section = document.createElement("section");
    section.className = "point-media-section";
    const heading = document.createElement("strong");
    heading.textContent = "Medien";
    section.appendChild(heading);

    const list = document.createElement("div");
    list.className = "linked-media-list";
    for (const item of linkedItems(linkId)) {
      const row = document.createElement("div");
      row.className = "linked-media-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "linked-media-open";
      open.textContent = `${item.kind === "video" ? "▶" : "●"} ${item.name}`;
      open.addEventListener("click", async () => {
        if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
          openMapPopup(item.id);
          return;
        }
        const file = await resolveFile(item, true);
        if (file) showViewer(item, file);
        else
          app.setStatus(
            "Datei bitte erneut über den Medienordner freigeben.",
            "warning",
          );
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "linked-media-remove";
      remove.textContent = "×";
      remove.title = "Medium entfernen";
      remove.addEventListener("click", async () => {
        await removeItem(item);
        row.remove();
      });
      row.append(open, remove);
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const empty = document.createElement("small");
      empty.textContent = "Noch keine lokalen Medien verknüpft.";
      list.appendChild(empty);
    }
    section.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "point-media-actions";
    for (const [kind, label] of [
      ["photo", "Foto hinzufügen"],
      ["video", "Video hinzufügen"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        await pickManual(kind, { ...reference, linkId });
        const replacement = document.createElement("div");
        appendPointMedia(replacement, reference);
        section.replaceWith(...replacement.childNodes);
      });
      actions.appendChild(button);
    }
    section.appendChild(actions);
    container.appendChild(section);
  }

  async function inspectManualFile(file, handle, kind, reference) {
    const client = workerClient();
    try {
      const result = await client.inspect(file);
      if (result.status === "unsupported" || result.kind !== kind) {
        app.setStatus(
          `Dateityp von „${file.name}“ wird hier nicht unterstützt.`,
          "warning",
        );
        return null;
      }
      if (result.status === "error") {
        app.setStatus(
          `Metadaten von „${file.name}“ konnten nicht gelesen werden.`,
          "error",
        );
        return null;
      }
      const id = itemId("manual", `${reference.linkId}/${file.name}`, file);
      const item = {
        id,
        name: file.name,
        kind,
        mime: result.mime || file.type,
        takenAt: result.takenAt || null,
        lat: Number.isFinite(result.lat) ? result.lat : null,
        lng: Number.isFinite(result.lng) ? result.lng : null,
        source: handle ? "file-handle" : "input",
        linkedRoutePointId: reference.linkId,
        linkedPointCoord: app.util.validCoord(reference.coord)
          ? app.util.coord(reference.coord)
          : null,
        size: file.size,
        lastModified: file.lastModified,
        fileHandleKey: handle ? `file:${id}` : null,
        createdAt: Date.now(),
      };
      memoryFiles.set(id, file);
      if (handle) await db.putHandle(item.fileHandleKey, handle);
      mediaItems.set(id, item);
      await db.putItem(item);
      renderMarkers();
      app.setStatus(
        result.status === "geotagged"
          ? `${file.name} verknüpft und am Aufnahmeort angezeigt.`
          : `${file.name} lokal mit diesem Punkt verknüpft (ohne Geotag).`,
        "success",
      );
      return item;
    } finally {
      client.terminate();
    }
  }

  function inputFiles({ accept, multiple = true }) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = multiple;
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener(
        "change",
        () => {
          resolve([...input.files]);
          input.remove();
        },
        { once: true },
      );
      input.click();
    });
  }

  async function pickManual(kind, reference) {
    const accept =
      kind === "photo"
        ? "image/jpeg,image/heic,image/heif,image/png"
        : "video/mp4,video/quicktime,video/x-m4v";
    let selected = [];
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [
            {
              description: kind === "photo" ? "Fotos" : "Videos",
              accept:
                kind === "photo"
                  ? { "image/*": [".jpg", ".jpeg", ".heic", ".heif", ".png"] }
                  : { "video/*": [".mp4", ".mov", ".m4v"] },
            },
          ],
        });
        selected = await Promise.all(
          handles.map(async (handle) => ({
            handle,
            file: await handle.getFile(),
          })),
        );
      } catch (error) {
        if (error?.name === "AbortError") return;
        app.log("media:file-picker", error);
      }
    }
    if (!selected.length) {
      const files = await inputFiles({ accept });
      selected = files.map((file) => ({ handle: null, file }));
    }
    for (const entry of selected)
      await inspectManualFile(entry.file, entry.handle, kind, reference);
  }

  async function* directoryEntries(handle, prefix = "") {
    for await (const [name, child] of handle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") yield* directoryEntries(child, path);
      else yield { handle: child, path, name };
    }
  }

  function importDialog() {
    const dialog = app.el("mediaImportDialog");
    const progress = app.el("mediaImportProgress");
    const text = app.el("mediaImportText");
    const summary = app.el("mediaImportSummary");
    summary.replaceChildren();
    progress.value = 0;
    progress.max = 1;
    text.textContent = "Dateien werden erfasst …";
    if (!dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return { dialog, progress, text, summary };
  }

  function showImportSummary(ui, stats) {
    const withLocation = stats.photos + stats.videos;
    ui.text.textContent = "Medienimport abgeschlossen";
    const rows = [
      ["Mit Standort", withLocation],
      ["Fotos mit Geotag", stats.photos],
      ["Videos mit Geotag", stats.videos],
      ["Ohne Standort", stats.noLocation],
      ["Nicht unterstützt", stats.unsupported],
      ["Fehlerhafte Metadaten", stats.errors],
      ["Dateien geprüft", stats.total],
    ];
    const list = document.createElement("dl");
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = new Intl.NumberFormat("de-AT").format(value);
      list.append(dt, dd);
    }
    ui.summary.replaceChildren(list);
    app.setStatus(
      `${withLocation} Medien mit Standort · ${stats.noLocation} ohne Standort · ${stats.total} Dateien geprüft.`,
      "success",
    );
  }

  async function importEntries(
    entries,
    { directoryHandle = null, directoryKey = null } = {},
  ) {
    if (importRunning) return;
    importRunning = true;
    const ui = importDialog();
    const stats = {
      total: entries.length,
      processed: 0,
      photos: 0,
      videos: 0,
      noLocation: 0,
      unsupported: 0,
      errors: 0,
    };
    ui.progress.max = Math.max(1, entries.length);
    const clients = [workerClient(), workerClient()];
    const importedCoords = [];
    let cursor = 0;
    if (directoryHandle && directoryKey) {
      try {
        await db.putHandle(directoryKey, directoryHandle);
      } catch (error) {
        app.log("media:store-directory", error);
        directoryKey = null;
      }
    }

    const updateProgress = () => {
      ui.progress.value = stats.processed;
      ui.text.textContent = `${stats.processed.toLocaleString("de-AT")} von ${stats.total.toLocaleString("de-AT")} Dateien geprüft`;
    };

    const run = async (client) => {
      while (true) {
        const index = cursor++;
        if (index >= entries.length) return;
        const entry = entries[index];
        const ext = extension(entry.name || entry.file?.name);
        if (!supportedExtensions.has(ext)) {
          stats.unsupported += 1;
          stats.processed += 1;
          if (stats.processed % 10 === 0 || stats.processed === stats.total)
            updateProgress();
          continue;
        }
        try {
          const file = entry.file || (await entry.handle.getFile());
          const result = await client.inspect(file);
          if (result.status === "geotagged") {
            if (result.kind === "photo") stats.photos += 1;
            else stats.videos += 1;
            const id = itemId(
              directoryKey || "input",
              entry.path || file.webkitRelativePath || file.name,
              file,
            );
            const item = {
              id,
              name: file.name,
              kind: result.kind,
              mime: result.mime || file.type,
              takenAt: result.takenAt || null,
              lat: result.lat,
              lng: result.lng,
              source: directoryKey ? "directory" : "input",
              directoryKey,
              relativePath: entry.path || file.webkitRelativePath || file.name,
              linkedRoutePointId: null,
              size: file.size,
              lastModified: file.lastModified,
              createdAt: Date.now(),
            };
            memoryFiles.set(id, file);
            mediaItems.set(id, item);
            importedCoords.push([item.lng, item.lat]);
            await db.putItem(item);
          } else if (result.status === "no-location") stats.noLocation += 1;
          else if (result.status === "unsupported") stats.unsupported += 1;
          else stats.errors += 1;
        } catch (error) {
          stats.errors += 1;
          app.log("media:import-file", error, {
            path: entry.path || entry.name,
          });
        }
        stats.processed += 1;
        if (stats.processed % 10 === 0 || stats.processed === stats.total) {
          updateProgress();
          renderMarkers();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    try {
      await Promise.all(clients.map(run));
      renderMarkers();
      focusImportedMedia(importedCoords);
      showImportSummary(ui, stats);
      refreshAccessNote();
    } finally {
      clients.forEach((client) => client.terminate());
      importRunning = false;
    }
  }

  async function selectDirectory() {
    let directoryHandle = null;
    if (window.showDirectoryPicker) {
      try {
        directoryHandle = await window.showDirectoryPicker({
          id: "outabout-media",
          mode: "read",
          startIn: "pictures",
        });
      } catch (error) {
        if (error?.name === "AbortError") return;
        app.log("media:directory-picker", error);
      }
    }

    if (directoryHandle) {
      const ui = importDialog();
      const entries = [];
      let count = 0;
      for await (const entry of directoryEntries(directoryHandle)) {
        entries.push(entry);
        count += 1;
        if (count % 100 === 0) {
          ui.text.textContent = `${count.toLocaleString("de-AT")} Dateien erfasst …`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      const key = `directory:${stableHash(directoryHandle.name)}`;
      await importEntries(entries, { directoryHandle, directoryKey: key });
      return;
    }

    const input = app.el("mediaDirectoryInput");
    input.value = "";
    input.click();
  }

  function openMediaSelection() {
    const dialog = app.el("mediaSelectionDialog");
    if (!dialog?.open) {
      if (dialog?.showModal) dialog.showModal();
      else dialog?.setAttribute("open", "");
    }
  }

  function closeMediaSelection() {
    app.el("mediaSelectionDialog")?.close?.();
  }

  async function selectMediaFiles() {
    let files = [];
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [
            {
              description: "Fotos und Videos",
              accept: {
                "image/*": [".jpg", ".jpeg", ".heic", ".heif", ".png"],
                "video/*": [".mp4", ".mov", ".m4v"],
              },
            },
          ],
        });
        files = await Promise.all(handles.map((handle) => handle.getFile()));
      } catch (error) {
        if (error?.name === "AbortError") return;
        app.log("media:multi-file-picker", error);
      }
    }
    if (!files.length) {
      const input = app.el("mediaFilesInput");
      input.value = "";
      input.click();
      return;
    }
    importEntries(
      files.map((file) => ({ file, path: file.name, name: file.name })),
    ).catch((error) => {
      app.log("media:multi-file-import", error);
      app.setStatus("Medienimport ist fehlgeschlagen.", "error");
    });
  }

  async function refreshAccessNote() {
    const note = app.el("mediaAccessNote");
    if (!note) return;
    const directoryKeys = [
      ...new Set(
        [...mediaItems.values()]
          .map((item) => item.directoryKey)
          .filter(Boolean),
      ),
    ];
    let needsPermission = [...mediaItems.values()].some(
      (item) => item.source === "input",
    );
    for (const key of directoryKeys) {
      try {
        const record = await db.getHandle(key);
        if (!record?.handle || !(await ensurePermission(record.handle, false)))
          needsPermission = true;
      } catch {
        needsPermission = true;
      }
    }
    note.hidden = !needsPermission;
    note.textContent = needsPermission
      ? "Einige Vorschauen benötigen nach dem Reload eine erneute Ordner-/Dateifreigabe. Metadaten und Kartenpositionen bleiben erhalten."
      : "Medien bleiben lokal; gespeicherte Dateifreigaben sind verfügbar.";
  }

  async function restoreIndex() {
    try {
      const items = await db.getAllItems();
      for (const item of items || []) {
        if (!item?.id || !["photo", "video"].includes(item.kind)) continue;
        mediaItems.set(item.id, item);
      }
      renderMarkers();
      refreshAccessNote();
      if (mediaItems.size)
        app.setStatus(
          `${mediaItems.size.toLocaleString("de-AT")} lokale Medienpositionen wiederhergestellt.`,
        );
    } catch (error) {
      app.log("media:restore", error);
      app.setStatus(
        "Lokaler Medienindex konnte nicht geöffnet werden.",
        "warning",
      );
    }
  }

  app.media = {
    items: mediaItems,
    appendPointMedia,
    open: openMapPopup,
    selectDirectory,
    selectMediaFiles,
    resolveFile,
    refresh: renderMarkers,
  };

  app.el("mediaFolderBtn")?.addEventListener("click", openMediaSelection);
  app.el("selectMediaFiles")?.addEventListener("click", () => {
    closeMediaSelection();
    selectMediaFiles();
  });
  app.el("selectMediaDirectory")?.addEventListener("click", () => {
    closeMediaSelection();
    selectDirectory();
  });
  app.el("closeMediaSelection")?.addEventListener("click", closeMediaSelection);
  app.el("mediaDirectoryInput")?.addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    const entries = files.map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
      name: file.name,
    }));
    importEntries(entries).catch((error) => {
      app.log("media:fallback-import", error);
      app.setStatus("Medienimport ist fehlgeschlagen.", "error");
    });
  });
  app.el("mediaFilesInput")?.addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    importEntries(
      files.map((file) => ({ file, path: file.name, name: file.name })),
    ).catch((error) => {
      app.log("media:multi-file-import", error);
      app.setStatus("Medienimport ist fehlgeschlagen.", "error");
    });
  });
  app.el("photosChk")?.addEventListener("change", renderMarkers);
  app.el("videosChk")?.addEventListener("change", renderMarkers);
  app
    .el("closeMediaImport")
    ?.addEventListener("click", () => app.el("mediaImportDialog")?.close());
  app
    .el("closeMediaViewer")
    ?.addEventListener("click", () => app.el("mediaViewer")?.close());
  window.addEventListener("pagehide", () => {
    for (const value of objectUrls.values()) URL.revokeObjectURL(value.url);
    objectUrls.clear();
  });

  app.whenMapReady(() => {
    installLayers();
    restoreIndex();
  });
})();

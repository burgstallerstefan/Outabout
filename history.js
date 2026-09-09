(() => {
  "use strict";

  const app = window.Outabout;
  if (!app) return;

  function boot() {
    if (!app.planner || !app.el("filters")) {
      setTimeout(boot, 40);
      return;
    }

    const planner = app.planner;
    const filterBar = app.el("filters");
    const undoButton = document.createElement("button");
    const redoButton = document.createElement("button");

    undoButton.id = "undoRouteBtn";
    undoButton.type = "button";
    undoButton.className = "icon-button";
    undoButton.textContent = "↶";
    undoButton.title = "Routenänderung rückgängig";
    undoButton.setAttribute("aria-label", undoButton.title);

    redoButton.id = "redoRouteBtn";
    redoButton.type = "button";
    redoButton.className = "icon-button";
    redoButton.textContent = "↷";
    redoButton.title = "Routenänderung wiederholen";
    redoButton.setAttribute("aria-label", redoButton.title);

    // Keep route history controls in the second row, directly after
    // "Karteninhalt". This avoids pushing top-toolbar buttons off-screen on
    // narrow mobile displays.
    filterBar.append(undoButton, redoButton);

    const clonePoints = () =>
      planner.points.map(({ id, coord, name, type, cat }) => ({
        id,
        coord: [...coord],
        name,
        type,
        cat,
      }));
    const key = (points) => JSON.stringify(points);
    const undoStack = [clonePoints()];
    const redoStack = [];
    let applying = false;

    function syncButtons() {
      undoButton.disabled = undoStack.length <= 1;
      redoButton.disabled = redoStack.length === 0;
    }

    function record() {
      if (applying) return;
      const state = clonePoints();
      if (key(state) === key(undoStack[undoStack.length - 1])) return;
      undoStack.push(state);
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
      syncButtons();
    }

    async function apply(points) {
      applying = true;
      try {
        planner.clear();
        for (const point of points) {
          planner.addPoint(point.coord, point);
        }
        planner.render();
        if (points.length >= 2) await planner.calculate();
      } finally {
        applying = false;
        syncButtons();
      }
    }

    async function undo() {
      if (undoStack.length <= 1 || applying) return;
      const current = undoStack.pop();
      redoStack.push(current);
      await apply(undoStack[undoStack.length - 1]);
      app.setStatus("Letzte Routenänderung rückgängig gemacht.", "success");
    }

    async function redo() {
      if (!redoStack.length || applying) return;
      const state = redoStack.pop();
      undoStack.push(state);
      await apply(state);
      app.setStatus("Routenänderung wiederhergestellt.", "success");
    }

    undoButton.addEventListener("click", undo);
    redoButton.addEventListener("click", redo);
    app.on("route:pointschange", record);
    app.on("route:clear", record);

    document.addEventListener("keydown", (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      const target = event.target;
      if (target?.matches?.("input,textarea,[contenteditable='true']")) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    });

    syncButtons();
  }

  boot();
})();

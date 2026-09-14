const state = {
  boards: [],
  currentBoardId: null,
  nodes: [],
  edges: [],
  nodeCounts: {},
  connectMode: false,
  connectSource: null,
  addNoteMode: false,
  addTasksMode: false,
  addZoneMode: false,
  addTableMode: false,
  minimizedImageIds: new Set(),
  editingNodeId: null,
  zoom: 1,
  selectedNodeIds: new Set(),
  boardFilterQuery: "",
};

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const BASE_W = 3000;
const BASE_H = 2000;

const NODE_ICONS = {
  note: "📝",
  host: "🖥",
  account: "🔑",
  link: "🔗",
  file: "📄",
  other: "✦",
  image: "🖼",
  tasks: "☑",
  zone: "▭",
  table: "▦",
};

const $ = (sel) => document.querySelector(sel);

// Opens a URL in the system's actual default browser. Inside the native app
// window, window.open()/target=_blank just navigates (or silently does
// nothing) within pywebview's own embedded view instead of launching a
// real external browser - same class of issue as file downloads - so use
// the native bridge when it's available, and fall back to window.open for
// the plain-browser-tab mode.
async function copyToClipboardWithFeedback(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    const original = el.innerHTML;
    el.classList.add("copied");
    el.textContent = "✓ Copied";
    setTimeout(() => {
      el.innerHTML = original;
      el.classList.remove("copied");
    }, 900);
  } catch {
    alert("Could not copy to clipboard");
  }
}

function openLocalPath(path) {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.open_path) {
    window.pywebview.api.open_path(path);
  } else {
    alert("Opening a local file/folder only works in the desktop app, not in a browser tab.");
  }
}

// Per node-type, what a single click on its highlighted content line does -
// each type behaves differently instead of every type just opening the
// same edit modal for a click on the card.
const QUICK_ACTIONS = {
  link: { icon: "🔗", title: "Open in browser", run: (v) => openExternalUrl(v), className: "" },
  host: { icon: "📋", title: "Copy to clipboard", run: (v, el) => copyToClipboardWithFeedback(v, el), className: "mono" },
  account: { icon: "📋", title: "Copy username", run: (v, el) => copyToClipboardWithFeedback(v, el), className: "" },
  // direction:rtl (via the "rtl" class) truncates a long path from the
  // *front*, so an overflowing path still ends by showing the actual
  // filename instead of just its drive/leading folders.
  file: { icon: "📂", title: "Open in file explorer", run: (v) => openLocalPath(v), className: "mono rtl" },
};

function openExternalUrl(url) {
  if (!url) return;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
    window.pywebview.api.open_external(withScheme);
  } else {
    window.open(withScheme, "_blank", "noopener");
  }
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- boards ----------

async function loadBoards() {
  state.boards = await api("/api/boards");
  if (!state.currentBoardId && state.boards.length) {
    state.currentBoardId = state.boards[0].id;
  }
  renderBoardList();
  if (state.currentBoardId) await loadBoard(state.currentBoardId);
}

function renderBoardList() {
  const el = $("#board-list");
  el.innerHTML = "";
  state.boards.forEach((b) => {
    const div = document.createElement("div");
    div.className = "board-item" + (b.id === state.currentBoardId ? " active" : "");
    div.textContent = b.name;
    div.title = b.description || "";
    div.onclick = () => {
      state.currentBoardId = b.id;
      renderBoardList();
      loadBoard(b.id);
    };
    el.appendChild(div);
  });
}

async function loadBoard(boardId) {
  const board = state.boards.find((b) => b.id === boardId);
  $("#board-title").textContent = board ? board.name : "-";
  vaultFolderId = null;
  vaultFolderPath = [];
  state.selectedNodeIds.clear();
  state.boardFilterQuery = "";
  $("#board-filter-input").value = "";
  state.nodes = await api(`/api/boards/${boardId}/nodes`);
  state.edges = await api(`/api/boards/${boardId}/edges`);
  state.nodeCounts = await api(`/api/boards/${boardId}/node-counts`);
  resetHistory();
  renderCanvas();
  await refreshCurrentView();
}

async function refreshNodeCounts() {
  if (!state.currentBoardId) return;
  state.nodeCounts = await api(`/api/boards/${state.currentBoardId}/node-counts`);
  canvas.querySelectorAll(".node").forEach((el) => {
    const node = state.nodes.find((n) => String(n.id) === el.dataset.id);
    if (node) updateNodeBadges(el, node);
  });
}

$("#new-board-btn").onclick = async () => {
  const name = prompt("New board name:");
  if (!name) return;
  const board = await api("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  state.boards.push(board);
  state.currentBoardId = board.id;
  renderBoardList();
  await loadBoard(board.id);
};

$("#delete-board-btn").onclick = async () => {
  if (!state.currentBoardId) return;
  if (!confirm("Delete this board and all its nodes?")) return;
  await api(`/api/boards/${state.currentBoardId}`, { method: "DELETE" });
  state.boards = state.boards.filter((b) => b.id !== state.currentBoardId);
  state.currentBoardId = state.boards.length ? state.boards[0].id : null;
  renderBoardList();
  if (state.currentBoardId) await loadBoard(state.currentBoardId);
  else {
    state.nodes = [];
    state.edges = [];
    renderCanvas();
    $("#board-title").textContent = "-";
  }
};

// ---------- zoom ----------

const canvasWrapper = $("#canvas-wrapper");
const canvasSizer = $("#canvas-sizer");
const canvasContent = $("#canvas-content");

function applyZoom() {
  canvasContent.style.transform = `scale(${state.zoom})`;
  canvasSizer.style.width = `${BASE_W * state.zoom}px`;
  canvasSizer.style.height = `${BASE_H * state.zoom}px`;
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setZoom(z) {
  state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +z.toFixed(2)));
  applyZoom();
}

canvasWrapper.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.altKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  },
  { passive: false }
);

$("#zoom-in-btn").onclick = () => setZoom(state.zoom + ZOOM_STEP);
$("#zoom-out-btn").onclick = () => setZoom(state.zoom - ZOOM_STEP);

applyZoom();

// ---------- undo / redo ----------

let historyStack = [];
let historyIndex = -1;

function resetHistory() {
  historyStack = [];
  historyIndex = -1;
  updateHistoryButtons();
}

function pushHistory(action) {
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(action);
  historyIndex++;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("#undo-btn").disabled = historyIndex < 0;
  $("#redo-btn").disabled = historyIndex >= historyStack.length - 1;
}

async function undo() {
  if (historyIndex < 0) return;
  await historyStack[historyIndex].undo();
  historyIndex--;
  updateHistoryButtons();
}

async function redo() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  await historyStack[historyIndex].redo();
  updateHistoryButtons();
}

$("#undo-btn").onclick = undo;
$("#redo-btn").onclick = redo;

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
    e.preventDefault();
    redo();
  }
});

// ---------- canvas / nodes ----------

const canvas = $("#canvas");
const edgesLayer = $("#edges-layer");

// A Zone sits behind other nodes but is still its own element in #canvas -
// clicking its plain background (not the label/resize-handle, which have
// their own handlers that stopPropagation) should count as "empty space"
// too, so a node/tool can be placed straight into a zone instead of always
// needing to be created outside it and dragged in.
function isEmptyCanvasTarget(target) {
  return target === canvas || target.classList.contains("node-zone-card");
}

canvas.addEventListener("dblclick", async (e) => {
  if (!isEmptyCanvasTarget(e.target)) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.zoom;
  const y = (e.clientY - rect.top) / state.zoom;
  openNodeModal(null, { x, y });
});

// Sticky-note tool, like Windows Sticky Notes: click the toolbar button to
// arm it, then click anywhere on the board to drop a note right there and
// start typing immediately - no modal, no double-click precision needed.
// Stays armed so several notes can be placed in a row; click the button
// again (or Esc) to turn it off.
// Three "click to arm, then click the board to place one" tools, mutually
// exclusive - arming one disarms the others.
const PLACE_TOOLS = {
  note: { stateKey: "addNoteMode", btn: "#add-note-btn" },
  tasks: { stateKey: "addTasksMode", btn: "#add-tasks-btn" },
  zone: { stateKey: "addZoneMode", btn: "#add-zone-btn" },
  table: { stateKey: "addTableMode", btn: "#add-table-btn" },
};
function armPlaceTool(name) {
  const turningOn = !state[PLACE_TOOLS[name].stateKey];
  Object.entries(PLACE_TOOLS).forEach(([key, tool]) => {
    state[tool.stateKey] = key === name && turningOn;
    $(tool.btn).classList.toggle("active", state[tool.stateKey]);
  });
  const anyOn = Object.values(PLACE_TOOLS).some((t) => state[t.stateKey]);
  canvasWrapper.classList.toggle("note-tool-active", anyOn);
}
$("#add-note-btn").onclick = () => armPlaceTool("note");
$("#add-tasks-btn").onclick = () => armPlaceTool("tasks");
// A "zone" is a big rectangle drawn behind other nodes to visually group
// ones about the same topic - drag its corner to resize, drag its label to
// move it, click the label to rename/recolor it.
$("#add-zone-btn").onclick = () => armPlaceTool("zone");
// A spreadsheet-style grid right on the board - click cells to type into
// them, grow it with rows/columns as needed. Separate from the Reports
// markdown tables (those stay a "| a | b |" text-based table meant for a
// written report; this is a freeform grid meant for the map itself).
$("#add-table-btn").onclick = () => armPlaceTool("table");

canvas.addEventListener("click", async (e) => {
  if (!isEmptyCanvasTarget(e.target)) return;
  if (!state.addNoteMode && !state.addTasksMode && !state.addZoneMode && !state.addTableMode) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.zoom - 95;
  const y = (e.clientY - rect.top) / state.zoom - 20;

  if (state.addZoneMode) {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify({ title: "Zone", type: "zone", color: "#5b8cff", x, y, width: 320, height: 220 }),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
    renderCanvas();
    return;
  }
  if (state.addTableMode) {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        title: "Table",
        type: "table",
        content: JSON.stringify([["", ""], ["", ""]]),
        x, y,
      }),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
    renderCanvas();
    return;
  }
  if (state.addTasksMode) {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify({ title: "Tasks", type: "tasks", content: "", x, y }),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
    renderCanvas();
    const addInput = canvas.querySelector(`.node[data-id="${created.id}"] .node-task-add`);
    if (addInput) addInput.focus();
    return;
  }
  const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
    method: "POST",
    body: JSON.stringify({ title: "Note", type: "note", content: "", x, y }),
  });
  state.nodes.push(created);
  pushHistory(makeCreateNodeAction(created));
  renderCanvas();
  const quickText = canvas.querySelector(`.node[data-id="${created.id}"] .node-quick-text`);
  if (quickText) startQuickNoteEdit(quickText, created);
});

// ---------- multi-select (rubber-band + shift-click) ----------

function applyMultiSelectClass(id) {
  const el = canvas.querySelector(`.node[data-id="${id}"]`);
  if (el) el.classList.toggle("multi-selected", state.selectedNodeIds.has(id));
}

function clearMultiSelection() {
  if (!state.selectedNodeIds.size) return;
  state.selectedNodeIds.forEach((id) => applyMultiSelectClass(id));
  state.selectedNodeIds.clear();
  canvas.querySelectorAll(".node.multi-selected").forEach((n) => n.classList.remove("multi-selected"));
}

// Shift-click toggles a node in/out of the selection instead of opening its
// edit modal - runs in the capture phase so it intercepts the click before
// the node's own (bubble-phase) click handler ever sees it. A plain click
// on a node clears any existing multi-selection (so a later single drag
// doesn't unexpectedly drag a stale group) - but only when this click is a
// real click and not the tail end of a drag that just moved the group.
canvas.addEventListener("click", (e) => {
  if (state.connectMode) return;
  const nodeEl = e.target.closest(".node");
  if (!nodeEl || nodeEl._dragMoved) return;
  if (e.shiftKey) {
    e.stopPropagation();
    e.preventDefault();
    const id = Number(nodeEl.dataset.id);
    if (state.selectedNodeIds.has(id)) state.selectedNodeIds.delete(id);
    else state.selectedNodeIds.add(id);
    applyMultiSelectClass(id);
    return;
  }
  if (state.selectedNodeIds.size) clearMultiSelection();
}, true);

// Drag a rectangle over empty canvas (or a zone's plain background) to
// select every node it touches - held Shift adds to whatever was already
// selected instead of replacing it. A plain click with no drag at all just
// clears the selection, matching Miro/Figma-style canvases.
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || state.connectMode) return;
  if (!isEmptyCanvasTarget(e.target)) return;
  if (Object.values(PLACE_TOOLS).some((t) => state[t.stateKey])) return;
  const additive = e.shiftKey;
  const baseline = additive ? new Set(state.selectedNodeIds) : new Set();
  if (!additive) clearMultiSelection();
  const startX = e.clientX, startY = e.clientY;
  const box = document.createElement("div");
  box.className = "selection-box";
  document.body.appendChild(box);

  const update = (curX, curY) => {
    const x1 = Math.min(startX, curX), y1 = Math.min(startY, curY);
    const x2 = Math.max(startX, curX), y2 = Math.max(startY, curY);
    box.style.left = `${x1}px`;
    box.style.top = `${y1}px`;
    box.style.width = `${x2 - x1}px`;
    box.style.height = `${y2 - y1}px`;
    const next = new Set(baseline);
    canvas.querySelectorAll(".node").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) next.add(Number(el.dataset.id));
    });
    state.selectedNodeIds = next;
    canvas.querySelectorAll(".node").forEach((el) => {
      el.classList.toggle("multi-selected", state.selectedNodeIds.has(Number(el.dataset.id)));
    });
  };
  update(startX, startY);

  const onMove = (ev) => update(ev.clientX, ev.clientY);
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    box.remove();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

async function deleteSelectedNodes() {
  const ids = [...state.selectedNodeIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected node${ids.length > 1 ? "s" : ""} and their connections?`)) return;
  const refs = ids.map((id) => state.nodes.find((n) => n.id === id)).filter(Boolean).map((n) => ({ ...n }));
  await Promise.all(ids.map((id) => api(`/api/nodes/${id}`, { method: "DELETE" })));
  state.nodes = state.nodes.filter((n) => !ids.includes(n.id));
  state.edges = state.edges.filter((e) => !ids.includes(e.source_id) && !ids.includes(e.target_id));
  state.selectedNodeIds.clear();
  const actions = refs.map((ref) => makeDeleteNodeAction(ref));
  pushHistory({
    undo: async () => { for (const a of actions) await a.undo(); },
    redo: async () => { for (const a of actions) await a.redo(); },
  });
  renderCanvas();
  await refreshNodeCounts();
}

document.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && state.selectedNodeIds.size) {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    e.preventDefault();
    deleteSelectedNodes();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (state.addNoteMode || state.addTasksMode || state.addZoneMode || state.addTableMode)) {
    Object.values(PLACE_TOOLS).forEach((tool) => {
      state[tool.stateKey] = false;
      $(tool.btn).classList.remove("active");
    });
    canvasWrapper.classList.remove("note-tool-active");
  }
});

// Collapse the sidebar to the left, like a normal app's collapsible side
// panel - an arrow on the sidebar's own edge tucks it away, and a small
// tab left in its place brings it back.
function setSidebarCollapsed(collapsed) {
  document.getElementById("app").classList.toggle("sidebar-hidden", collapsed);
  $("#sidebar-expand-btn").hidden = !collapsed;
}
$("#sidebar-collapse-btn").onclick = () => setSidebarCollapsed(true);
$("#sidebar-expand-btn").onclick = () => setSidebarCollapsed(false);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("app").classList.contains("sidebar-hidden")) {
    setSidebarCollapsed(false);
  }
});

// Paste an image (Ctrl+V) straight onto the board - like pasting into any
// other app. Only acts while the Board tab is showing and focus isn't in a
// text field/modal (so pasting into a note or a form still just pastes text
// there as normal).
let lastCanvasMouse = { x: BASE_W / 2, y: BASE_H / 2 };
canvasWrapper.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  lastCanvasMouse = {
    x: (e.clientX - rect.left) / state.zoom,
    y: (e.clientY - rect.top) / state.zoom,
  };
});

document.addEventListener("paste", async (e) => {
  if (state.currentView !== "board" || !state.currentBoardId) return;
  const active = document.activeElement;
  const inTextField = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
  if (inTextField) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const imageItem = Array.from(items).find((it) => it.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();
  const file = imageItem.getAsFile();
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const img = new Image();
    img.onload = async () => {
      const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight)) || 1;
      const w = Math.max(IMAGE_MIN_W, Math.round(img.naturalWidth * scale));
      const h = Math.max(IMAGE_MIN_H, Math.round(img.naturalHeight * scale));
      const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
        method: "POST",
        body: JSON.stringify({
          type: "image",
          title: "Pasted image",
          content: dataUrl,
          x: lastCanvasMouse.x - w / 2,
          y: lastCanvasMouse.y - h / 2,
          width: w,
          height: h,
        }),
      });
      state.nodes.push(created);
      pushHistory(makeCreateNodeAction(created));
      renderCanvas();
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
});

function renderCanvas() {
  // A node picked as the "connect from" source may have just been deleted
  // (directly, or via undo/redo) - drop the stale selection so a later click
  // can't try to create an edge from/to a node id that no longer exists.
  if (state.connectSource && !state.nodes.some((n) => n.id === state.connectSource)) {
    state.connectSource = null;
  }
  // Same idea for the multi-select set - and every element gets rebuilt
  // below, so the .multi-selected class has to be reapplied afterward too.
  for (const id of state.selectedNodeIds) {
    if (!state.nodes.some((n) => n.id === id)) state.selectedNodeIds.delete(id);
  }
  canvas.querySelectorAll(".node").forEach((n) => n.remove());
  // Zones render first (so they sit behind, via normal DOM stacking order)
  // and everything else on top of them, so nodes placed inside a zone stay
  // clickable/draggable instead of the zone's rectangle stealing the click.
  const zones = state.nodes.filter((n) => n.type === "zone");
  const others = state.nodes.filter((n) => n.type !== "zone");
  zones.forEach((node) => canvas.appendChild(buildNodeEl(node)));
  others.forEach((node) => canvas.appendChild(buildNodeEl(node)));
  canvas.querySelectorAll(".node").forEach((el) => {
    el.classList.toggle("multi-selected", state.selectedNodeIds.has(Number(el.dataset.id)));
  });
  renderEdges();
  canvasWrapper.classList.toggle("empty", state.nodes.length === 0);
  applyBoardFilter(state.boardFilterQuery);
}

// A quick on-canvas filter (separate from the sidebar's cross-board search)
// for finding things on *this* board by tag - dims everything that doesn't
// match instead of hiding it outright, so the board's layout stays intact
// and a partial/wrong query never looks like nodes went missing.
function applyBoardFilter(query) {
  state.boardFilterQuery = query;
  const nodeEls = canvas.querySelectorAll(".node");
  if (!query) {
    nodeEls.forEach((el) => el.classList.remove("filtered-out"));
    edgesLayer.classList.remove("board-filtering");
    return;
  }
  edgesLayer.classList.add("board-filtering");
  nodeEls.forEach((el) => {
    const node = state.nodes.find((n) => String(n.id) === el.dataset.id);
    const haystack = node ? `${node.tags || ""} ${node.title || ""}`.toLowerCase() : "";
    el.classList.toggle("filtered-out", !haystack.includes(query));
  });
}

$("#board-filter-input").addEventListener("input", (e) => {
  applyBoardFilter(e.target.value.trim().toLowerCase());
});
$("#board-filter-input").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.target.value = "";
    applyBoardFilter("");
    e.target.blur();
  }
});

function buildNodeEl(node) {
  const el = document.createElement("div");
  el.className = "node";
  el.dataset.id = node.id;
  el.dataset.type = node.type;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.setProperty("--node-color", node.color || "#4f8cff");
  const isNote = node.type === "note";
  const isImage = node.type === "image";
  const isTasks = node.type === "tasks";
  const isZone = node.type === "zone";
  const isTable = node.type === "table";

  if (isImage) {
    return buildImageNodeEl(el, node);
  }
  if (isTasks) {
    return buildTasksNodeEl(el, node);
  }
  if (isZone) {
    return buildZoneNodeEl(el, node);
  }
  if (isTable) {
    return buildTableNodeEl(el, node);
  }

  const action = QUICK_ACTIONS[node.type];
  el.innerHTML = `
    <div class="node-icon-badge">${NODE_ICONS[node.type] || NODE_ICONS.other}</div>
    <div class="node-type">${escapeHtml(node.type)}</div>
    <div class="node-title">${escapeHtml(node.title)}</div>
    ${node.tags ? `<div class="node-tags">#${escapeHtml(node.tags).replace(/,\s*/g, " #")}</div>` : ""}
    ${isNote ? `<div class="node-quick-text" data-placeholder="Click to write...">${escapeHtml(node.content || "")}</div>` : ""}
    ${action && node.content ? `<div class="node-quick-action ${action.className}" title="${action.title}">${action.icon} ${escapeHtml(node.content)}</div>` : ""}
    <div class="node-badges"></div>
  `;
  updateNodeBadges(el, node);
  makeDraggable(el, node);
  if (isNote) {
    const quickText = el.querySelector(".node-quick-text");
    quickText.addEventListener("click", (e) => {
      e.stopPropagation();
      if (el._dragMoved) { el._dragMoved = false; return; }
      startQuickNoteEdit(quickText, node);
    });
  }
  if (action) {
    const actionEl = el.querySelector(".node-quick-action");
    if (actionEl) {
      actionEl.addEventListener("mousedown", (e) => e.stopPropagation());
      actionEl.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (el._dragMoved) { el._dragMoved = false; return; }
        await action.run(node.content, actionEl);
      });
    }
  }
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el._dragMoved) {
      el._dragMoved = false;
      return;
    }
    if (state.connectMode) {
      handleConnectClick(node.id, el);
    } else {
      openNodeModal(node);
    }
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });
  return el;
}

// Task-list nodes: a small checklist right on the board, connectable to
// other nodes like any node - lines are stored as plain "- [ ] text" /
// "- [x] text" in node.content, same syntax as the Reports checklists.
function parseTaskLines(content) {
  return (content || "").split("\n").filter((l) => l.trim() !== "");
}

function buildTasksNodeEl(el, node) {
  el.classList.add("node-tasks-card");
  el.innerHTML = `
    <div class="node-header">
      <div class="node-icon-badge">${NODE_ICONS.tasks}</div>
      <div class="node-type">tasks</div>
      <div class="node-title">${escapeHtml(node.title)}</div>
    </div>
    <div class="node-tasklist-items"></div>
    <input type="text" class="node-task-add" placeholder="+ Add task, Enter">
  `;
  makeDraggable(el, node);

  const listEl = el.querySelector(".node-tasklist-items");
  const renderList = () => {
    const lines = parseTaskLines(node.content);
    listEl.innerHTML = lines.map((line, i) => {
      const m = line.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
      const checked = m ? m[1].toLowerCase() === "x" : false;
      const text = m ? m[2] : line;
      return `<div class="tasklist-item"><input type="checkbox" data-idx="${i}"${checked ? " checked" : ""}><span class="task-text">${escapeHtml(text)}</span></div>`;
    }).join("");
  };
  renderList();

  listEl.addEventListener("mousedown", (e) => e.stopPropagation());
  listEl.addEventListener("click", async (e) => {
    e.stopPropagation();
    const textEl = e.target.closest(".task-text");
    const cb = e.target.closest('input[type="checkbox"]') || (textEl && textEl.previousElementSibling);
    if (!cb) return;
    if (textEl) cb.checked = !cb.checked;
    const idx = Number(cb.dataset.idx);
    const lines = parseTaskLines(node.content);
    const m = lines[idx].match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
    const text = m ? m[2] : lines[idx];
    lines[idx] = `- [${cb.checked ? "x" : " "}] ${text}`;
    node.content = lines.join("\n");
    await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ content: node.content }) });
    await refreshNodeCounts();
  });

  const addInput = el.querySelector(".node-task-add");
  addInput.addEventListener("mousedown", (e) => e.stopPropagation());
  addInput.addEventListener("click", (e) => e.stopPropagation());
  addInput.addEventListener("keydown", async (e) => {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    const text = addInput.value.trim();
    if (!text) return;
    const lines = parseTaskLines(node.content);
    lines.push(`- [ ] ${text}`);
    node.content = lines.join("\n");
    addInput.value = "";
    await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ content: node.content }) });
    renderList();
  });

  el.querySelector(".node-header").addEventListener("click", (e) => {
    e.stopPropagation();
    if (el._dragMoved) { el._dragMoved = false; return; }
    if (state.connectMode) handleConnectClick(node.id, el);
    else openNodeModal(node);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });
  return el;
}

const ZONE_MIN_W = 120;
const ZONE_MIN_H = 90;

// Zone nodes: a big dashed rectangle drawn behind other nodes to visually
// group ones about the same topic - drag the body to move it, its corner
// to resize, and click the label to rename/recolor it (reuses the normal
// node modal, same as any other node type).
function buildZoneNodeEl(el, node) {
  el.classList.add("node-zone-card");
  const w = node.width || 320;
  const h = node.height || 220;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.innerHTML = `
    <div class="zone-label">${escapeHtml(node.title)}</div>
    <div class="zone-resize-handle" title="Drag to resize"></div>
  `;
  makeDraggable(el, node);

  el.querySelector(".zone-label").addEventListener("click", (e) => {
    e.stopPropagation();
    if (el._dragMoved) { el._dragMoved = false; return; }
    if (state.connectMode) handleConnectClick(node.id, el);
    else openNodeModal(node);
  });

  const handle = el.querySelector(".zone-resize-handle");
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = parseFloat(el.style.width) || w;
    const startH = parseFloat(el.style.height) || h;
    const onMove = (ev) => {
      const newW = Math.max(ZONE_MIN_W, startW + (ev.clientX - startX) / state.zoom);
      const newH = Math.max(ZONE_MIN_H, startH + (ev.clientY - startY) / state.zoom);
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
      renderEdges();
    };
    const onUp = async () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const newW = parseFloat(el.style.width);
      const newH = parseFloat(el.style.height);
      node.width = newW;
      node.height = newH;
      await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ width: newW, height: newH }) });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });
  return el;
}

// Table node: a small spreadsheet-style grid right on the board, separate
// from the Reports markdown tables - grid data is stored as a JSON array
// of rows (each an array of cell strings) in node.content.
function parseTableGrid(content) {
  try {
    const grid = JSON.parse(content || "null");
    if (Array.isArray(grid) && grid.length && Array.isArray(grid[0])) return grid;
  } catch { /* fall through to default */ }
  return [["", ""], ["", ""]];
}

function buildTableNodeEl(el, node) {
  el.classList.add("node-table-card");
  const grid = parseTableGrid(node.content);
  makeDraggable(el, node);

  const save = async () => {
    node.content = JSON.stringify(grid);
    await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ content: node.content }) });
  };

  const gridEl = document.createElement("table");
  gridEl.className = "node-table-grid";

  const renderGrid = () => {
    gridEl.innerHTML = grid.map((row, ri) =>
      `<tr>${row.map((cell, ci) =>
        `<td data-r="${ri}" data-c="${ci}"><div class="cell-text" contenteditable="true">${escapeHtml(cell)}</div></td>`
      ).join("")}</tr>`
    ).join("");
  };
  renderGrid();

  el.innerHTML = `
    <div class="node-header">
      <div class="node-icon-badge">${NODE_ICONS.table}</div>
      <div class="node-title">${escapeHtml(node.title)}</div>
    </div>
    <div class="node-table-wrap"></div>
    <div class="node-table-controls">
      <button type="button" class="table-add-row" title="Add row">+ Row</button>
      <button type="button" class="table-add-col" title="Add column">+ Col</button>
      <span class="table-controls-sep"></span>
      <button type="button" class="table-del-row" title="Delete last row">− Row</button>
      <button type="button" class="table-del-col" title="Delete last column">− Col</button>
    </div>
  `;
  el.querySelector(".node-table-wrap").appendChild(gridEl);

  const wrap = el.querySelector(".node-table-wrap");
  wrap.addEventListener("mousedown", (e) => e.stopPropagation());
  wrap.addEventListener("click", (e) => e.stopPropagation());
  // blur doesn't bubble, so listen in the capture phase to catch it from
  // whichever cell just lost focus after an edit.
  wrap.addEventListener("blur", (e) => {
    if (!e.target.classList || !e.target.classList.contains("cell-text")) return;
    const td = e.target.closest("td");
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    if (grid[r] && grid[r][c] !== undefined) {
      grid[r][c] = e.target.textContent;
      save();
    }
  }, true);
  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });

  el.querySelector(".table-add-row").addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector(".table-add-row").addEventListener("click", async (e) => {
    e.stopPropagation();
    grid.push(grid[0].map(() => ""));
    renderGrid();
    await save();
  });
  el.querySelector(".table-add-col").addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector(".table-add-col").addEventListener("click", async (e) => {
    e.stopPropagation();
    grid.forEach((row) => row.push(""));
    renderGrid();
    await save();
  });
  el.querySelector(".table-del-row").addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector(".table-del-row").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (grid.length <= 1) return;
    grid.pop();
    renderGrid();
    await save();
  });
  el.querySelector(".table-del-col").addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector(".table-del-col").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (grid[0].length <= 1) return;
    grid.forEach((row) => row.pop());
    renderGrid();
    await save();
  });

  el.querySelector(".node-header").addEventListener("click", (e) => {
    e.stopPropagation();
    if (el._dragMoved) { el._dragMoved = false; return; }
    if (state.connectMode) handleConnectClick(node.id, el);
    else openNodeModal(node);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });
  return el;
}

const IMAGE_DEFAULT_W = 220;
const IMAGE_DEFAULT_H = 160;
const IMAGE_MIN_W = 80;
const IMAGE_MIN_H = 60;

// Pasted-image nodes: pure image on the card, resizable by dragging its
// corner, and collapsible to a small chip via the minimize button - like a
// photo pinned to the board rather than a text record.
function buildImageNodeEl(el, node) {
  el.classList.add("node-image-card");
  if (state.minimizedImageIds.has(node.id)) el.classList.add("minimized");
  const w = node.width || IMAGE_DEFAULT_W;
  const h = node.height || IMAGE_DEFAULT_H;
  el.style.width = `${w}px`;
  el.innerHTML = `
    <div class="node-image-toolbar">
      <button type="button" class="node-image-min-btn" title="Minimize/restore">−</button>
    </div>
    <div class="node-image-wrap" style="height:${h}px">
      <img src="${node.content}" class="node-image" draggable="false">
      <div class="node-image-resize-handle" title="Drag to resize"></div>
    </div>
  `;
  const wrap = el.querySelector(".node-image-wrap");
  makeDraggable(el, node);

  el.querySelector(".node-image-min-btn").addEventListener("mousedown", (e) => e.stopPropagation());
  el.querySelector(".node-image-min-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.minimizedImageIds.has(node.id)) state.minimizedImageIds.delete(node.id);
    else state.minimizedImageIds.add(node.id);
    el.classList.toggle("minimized");
  });

  const handle = el.querySelector(".node-image-resize-handle");
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = parseFloat(el.style.width) || w;
    const startH = wrap.offsetHeight;
    const onMove = (ev) => {
      const newW = Math.max(IMAGE_MIN_W, startW + (ev.clientX - startX) / state.zoom);
      const newH = Math.max(IMAGE_MIN_H, startH + (ev.clientY - startY) / state.zoom);
      el.style.width = `${newW}px`;
      wrap.style.height = `${newH}px`;
      renderEdges();
    };
    const onUp = async () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const newW = parseFloat(el.style.width);
      const newH = wrap.offsetHeight;
      node.width = newW;
      node.height = newH;
      await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ width: newW, height: newH }) });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });
  return el;
}

// Type directly into a sticky note's body, right on the card - like Windows
// Sticky Notes - instead of going through the edit modal for a quick thought.
function startQuickNoteEdit(quickText, node) {
  quickText.contentEditable = "true";
  quickText.classList.add("editing");
  quickText.focus();
  const range = document.createRange();
  range.selectNodeContents(quickText);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async () => {
    quickText.removeEventListener("blur", finish);
    quickText.removeEventListener("keydown", onKeydown);
    quickText.contentEditable = "false";
    quickText.classList.remove("editing");
    const text = quickText.textContent;
    if (text === node.content) return;
    node.content = text;
    if (!node.title || node.title === "Note") {
      node.title = (text.split("\n")[0] || "Note").slice(0, 40) || "Note";
    }
    await api(`/api/nodes/${node.id}`, {
      method: "PUT",
      body: JSON.stringify({ content: text, title: node.title }),
    });
    const el = canvas.querySelector(`.node[data-id="${node.id}"] .node-title`);
    if (el) el.textContent = node.title;
  };
  const onKeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); quickText.blur(); }
    e.stopPropagation();
  };
  quickText.addEventListener("blur", finish);
  quickText.addEventListener("keydown", onKeydown);
}

function updateNodeBadges(el, node) {
  const counts = state.nodeCounts[String(node.id)];
  const badgesEl = el.querySelector(".node-badges");
  if (!badgesEl) return;
  if (!counts || (!counts.captures && !counts.creds)) {
    badgesEl.style.display = "none";
    return;
  }
  badgesEl.style.display = "flex";
  const parts = [];
  if (counts.captures) parts.push(`<span class="node-badge"><img src="/static/img/icons/vault.png" alt=""> ${counts.captures}</span>`);
  if (counts.creds) parts.push(`<span class="node-badge"><img src="/static/img/icons/credentials.png" alt=""> ${counts.creds}</span>`);
  badgesEl.innerHTML = parts.join("");
}

function makeDraggable(el, node) {
  let dragging = false;
  let startX, startY;
  // Dragging a node that's part of the current multi-selection moves every
  // selected node together, not just the one the mouse grabbed.
  let group = []; // [{el, node, origLeft, origTop}]
  el._dragMoved = false;

  el.addEventListener("mousedown", (e) => {
    if (state.connectMode || e.button !== 0) return;
    dragging = true;
    el._dragMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const groupIds = state.selectedNodeIds.has(node.id) && state.selectedNodeIds.size > 1
      ? [...state.selectedNodeIds]
      : [node.id];
    group = groupIds.map((id) => {
      const groupEl = id === node.id ? el : canvas.querySelector(`.node[data-id="${id}"]`);
      const groupNode = id === node.id ? node : state.nodes.find((n) => n.id === id);
      if (!groupEl || !groupNode) return null;
      return { el: groupEl, node: groupNode, origLeft: parseFloat(groupEl.style.left), origTop: parseFloat(groupEl.style.top) };
    }).filter(Boolean);
    el.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rawDx = e.clientX - startX;
    const rawDy = e.clientY - startY;
    if (Math.abs(rawDx) > 3 || Math.abs(rawDy) > 3) el._dragMoved = true;
    const dx = rawDx / state.zoom;
    const dy = rawDy / state.zoom;
    group.forEach((g) => {
      g.el.style.left = `${g.origLeft + dx}px`;
      g.el.style.top = `${g.origTop + dy}px`;
    });
    renderEdges();
  });

  window.addEventListener("mouseup", async () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
    if (!el._dragMoved) { group = []; return; }
    const moves = group.map((g) => {
      const to = { x: parseFloat(g.el.style.left), y: parseFloat(g.el.style.top) };
      const from = { x: g.origLeft, y: g.origTop };
      g.node.x = to.x;
      g.node.y = to.y;
      return { node: g.node, el: g.el, from, to };
    });
    group = [];
    await Promise.all(moves.map((m) => api(`/api/nodes/${m.node.id}`, { method: "PUT", body: JSON.stringify(m.to) })));
    pushHistory({
      undo: async () => {
        await Promise.all(moves.map((m) => {
          m.node.x = m.from.x; m.node.y = m.from.y;
          m.el.style.left = `${m.from.x}px`; m.el.style.top = `${m.from.y}px`;
          return api(`/api/nodes/${m.node.id}`, { method: "PUT", body: JSON.stringify(m.from) });
        }));
        renderEdges();
      },
      redo: async () => {
        await Promise.all(moves.map((m) => {
          m.node.x = m.to.x; m.node.y = m.to.y;
          m.el.style.left = `${m.to.x}px`; m.el.style.top = `${m.to.y}px`;
          return api(`/api/nodes/${m.node.id}`, { method: "PUT", body: JSON.stringify(m.to) });
        }));
        renderEdges();
      },
    });
  });
}

const EDGE_COLOR = "#4f8cff";
const EDGE_WIDTH = "1.6";
const EDGE_OPACITY = "0.45";

function renderEdges() {
  hideEdgeTrash();
  edgesLayer.innerHTML = "";
  state.edges.forEach((edge) => {
    const a = canvas.querySelector(`.node[data-id="${edge.source_id}"]`);
    const b = canvas.querySelector(`.node[data-id="${edge.target_id}"]`);
    if (!a || !b) return;
    const acx = parseFloat(a.style.left) + a.offsetWidth / 2;
    const acy = parseFloat(a.style.top) + a.offsetHeight / 2;
    const bcx = parseFloat(b.style.left) + b.offsetWidth / 2;
    const bcy = parseFloat(b.style.top) + b.offsetHeight / 2;
    // The line now renders above the node cards (so it can be clicked even
    // where it'd otherwise be hidden under one), so pull each end back out
    // of the card's body - both to look right and so the line's invisible
    // click hitbox doesn't sit on top of the node's own clickable area.
    const dx = bcx - acx, dy = bcy - acy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    // Distance from a rectangle's center to its actual border along a given
    // direction - using offsetWidth alone (as before) badly undershot the
    // real edge for a mostly-vertical connection (it should follow height
    // there instead), leaving the line stopping short with a visible gap
    // above/below the node once it was tall or the connection was steep.
    const rectExitDist = (halfW, halfH, dirX, dirY) => {
      const tx = Math.abs(dirX) > 1e-6 ? halfW / Math.abs(dirX) : Infinity;
      const ty = Math.abs(dirY) > 1e-6 ? halfH / Math.abs(dirY) : Infinity;
      return Math.min(tx, ty);
    };
    const padA = Math.min(rectExitDist(a.offsetWidth / 2, a.offsetHeight / 2, ux, uy) + 6, dist / 2 - 2);
    const padB = Math.min(rectExitDist(b.offsetWidth / 2, b.offsetHeight / 2, ux, uy) + 6, dist / 2 - 2);
    const ax = acx + ux * padA;
    const ay = acy + uy * padA;
    const bx = bcx - ux * padB;
    const by = bcy - uy * padB;
    // A subtle arc instead of a ruler-straight line - just enough to read as
    // "curved" without adding real bulge, since a bigger bow (what this used
    // to be) makes a densely-connected board an unreadable tangle of
    // crossing loops. Control points are pulled mainly *along* the actual
    // a->b direction (not forced horizontal - that made the curve leave
    // each node sideways instead of toward the other one).
    const bow = Math.min(dist * 0.12, 28);
    const px = -uy, py = ux; // unit vector perpendicular to a->b
    const c1x = ax + ux * bow + px * bow * 0.25;
    const c1y = ay + uy * bow + py * bow * 0.25;
    const c2x = bx - ux * bow + px * bow * 0.25;
    const c2y = by - uy * bow + py * bow * 0.25;
    const d = `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", d);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", EDGE_COLOR);
    line.setAttribute("stroke-width", EDGE_WIDTH);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", EDGE_OPACITY);
    line.style.pointerEvents = "none";
    // A small solid dot right where the line actually meets each node - at
    // 0.45 opacity a thin line fading into a node's border reads as
    // "floating nearby" rather than "attached", especially once several
    // lines converge on the same corner. The dot is unambiguous.
    const dotA = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dotA.setAttribute("cx", ax);
    dotA.setAttribute("cy", ay);
    dotA.setAttribute("r", "3.5");
    dotA.setAttribute("fill", EDGE_COLOR);
    dotA.style.pointerEvents = "none";
    const dotB = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dotB.setAttribute("cx", bx);
    dotB.setAttribute("cy", by);
    dotB.setAttribute("r", "3.5");
    dotB.setAttribute("fill", EDGE_COLOR);
    dotB.style.pointerEvents = "none";
    // Invisible, much fatter copy of the same curve on top - the actual
    // click/hover target, since hitting a 2px-wide curve exactly with the
    // mouse is unreasonably hard.
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "18");
    hit.style.pointerEvents = "stroke";
    hit.style.cursor = "pointer";

    const deleteThisEdge = async () => {
      hideEdgeTrash();
      await api(`/api/edges/${edge.id}`, { method: "DELETE" });
      state.edges = state.edges.filter((x) => x.id !== edge.id);
      renderEdges();
      pushHistory({
        undo: async () => {
          const recreated = await api(`/api/boards/${state.currentBoardId}/edges`, {
            method: "POST",
            body: JSON.stringify({ source_id: edge.source_id, target_id: edge.target_id, label: edge.label }),
          });
          edge.id = recreated.id;
          state.edges.push(recreated);
          renderEdges();
        },
        redo: async () => {
          await api(`/api/edges/${edge.id}`, { method: "DELETE" });
          state.edges = state.edges.filter((x) => x.id !== edge.id);
          renderEdges();
        },
      });
    };

    let hoverTimer = null;
    hit.addEventListener("mouseenter", () => {
      line.setAttribute("stroke", "#ff5f6d");
      line.setAttribute("stroke-width", "3");
      line.setAttribute("opacity", "0.95");
      dotA.setAttribute("fill", "#ff5f6d");
      dotB.setAttribute("fill", "#ff5f6d");
    });
    hit.addEventListener("mousemove", (e) => {
      if (hoverTimer || edgeTrashEl) return;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        showEdgeTrash(e.clientX, e.clientY, deleteThisEdge);
      }, 700);
    });
    hit.addEventListener("mouseleave", () => {
      line.setAttribute("stroke", EDGE_COLOR);
      line.setAttribute("stroke-width", EDGE_WIDTH);
      line.setAttribute("opacity", EDGE_OPACITY);
      dotA.setAttribute("fill", EDGE_COLOR);
      dotB.setAttribute("fill", EDGE_COLOR);
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    });
    group.appendChild(line);
    group.appendChild(dotA);
    group.appendChild(dotB);
    group.appendChild(hit);
    edgesLayer.appendChild(group);
  });
}

// Small floating trash button that appears near the cursor ~700ms after it
// rests on a connection line, and instantly deletes that line on click - no
// confirmation dialog, since it already takes a deliberate pause + a
// deliberate click to get there.
let edgeTrashEl = null;
function hideEdgeTrash() {
  if (edgeTrashEl) { edgeTrashEl.remove(); edgeTrashEl = null; }
}
function showEdgeTrash(clientX, clientY, onDelete) {
  hideEdgeTrash();
  const btn = document.createElement("div");
  btn.className = "edge-trash-btn";
  btn.textContent = "🗑";
  btn.style.left = `${clientX}px`;
  btn.style.top = `${clientY - 30}px`;
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete();
  });
  btn.addEventListener("mouseleave", hideEdgeTrash);
  document.body.appendChild(btn);
  edgeTrashEl = btn;
}
document.addEventListener("scroll", hideEdgeTrash, true);
document.addEventListener("mousedown", (e) => {
  if (edgeTrashEl && e.target !== edgeTrashEl) hideEdgeTrash();
});

// ---------- connect mode ----------

$("#connect-btn").onclick = () => {
  state.connectMode = !state.connectMode;
  state.connectSource = null;
  $("#connect-btn").classList.toggle("active", state.connectMode);
  canvas.querySelectorAll(".node.selected").forEach((n) => n.classList.remove("selected"));
  clearMultiSelection();
};

async function handleConnectClick(nodeId, el) {
  if (!state.connectSource) {
    state.connectSource = nodeId;
    el.classList.add("selected");
    return;
  }
  if (state.connectSource === nodeId) {
    el.classList.remove("selected");
    state.connectSource = null;
    return;
  }
  const edge = await api(`/api/boards/${state.currentBoardId}/edges`, {
    method: "POST",
    body: JSON.stringify({ source_id: state.connectSource, target_id: nodeId }),
  }).catch((e) => {
    alert(e.message);
    return null;
  });
  canvas.querySelectorAll(".node.selected").forEach((n) => n.classList.remove("selected"));
  state.connectSource = null;
  if (edge) {
    state.edges.push(edge);
    renderEdges();
    pushHistory({
      undo: async () => {
        await api(`/api/edges/${edge.id}`, { method: "DELETE" });
        state.edges = state.edges.filter((x) => x.id !== edge.id);
        renderEdges();
      },
      redo: async () => {
        const recreated = await api(`/api/boards/${state.currentBoardId}/edges`, {
          method: "POST",
          body: JSON.stringify({ source_id: edge.source_id, target_id: edge.target_id, label: edge.label }),
        });
        edge.id = recreated.id;
        state.edges.push(recreated);
        renderEdges();
      },
    });
  }
}

// ---------- context menu ----------

const contextMenu = $("#node-context-menu");
let contextNode = null;

function openContextMenu(clientX, clientY, node) {
  contextNode = node;
  contextMenu.style.left = `${clientX}px`;
  contextMenu.style.top = `${clientY}px`;
  contextMenu.classList.remove("hidden");
}

function closeContextMenu() {
  contextMenu.classList.add("hidden");
  contextNode = null;
}

document.addEventListener("click", () => closeContextMenu());
window.addEventListener("blur", () => closeContextMenu());

contextMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextNode) return;
  e.stopPropagation();
  // Snapshot the node now: confirm() below blocks while a native dialog is
  // shown, and on some webview backends that dialog stealing focus fires a
  // window "blur" event, which our own blur handler uses to close this menu
  // and null out contextNode - via a queued event that finally runs once
  // this handler hits its first await. Reading contextNode again after that
  // (the old code did) threw on a null reference and aborted the function
  // silently: the DELETE request had already gone out and succeeded on the
  // server, but the follow-up code that removes the node from the screen
  // never ran, so a deleted node stayed visible until the next reload.
  const node = contextNode;
  if (action === "delete") {
    if (confirm(`Delete node "${node.title}"?`)) {
      await api(`/api/nodes/${node.id}`, { method: "DELETE" });
      state.nodes = state.nodes.filter((n) => n.id !== node.id);
      state.edges = state.edges.filter(
        (ed) => ed.source_id !== node.id && ed.target_id !== node.id
      );
      pushHistory(makeDeleteNodeAction({ ...node }));
      renderCanvas();
    }
  } else if (action === "duplicate") {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        title: `${node.title} (copy)`,
        type: node.type,
        color: node.color,
        tags: node.tags,
        content: node.content,
        x: node.x + 30,
        y: node.y + 30,
      }),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
    renderCanvas();
  }
  closeContextMenu();
});

// ---------- node modal ----------

// A distinct default color per type, so a fresh board fills in with actual
// variety instead of everything defaulting to the same blue until someone
// manually picks a color for each node.
const TYPE_DEFAULT_COLOR = {
  note: "#ffd86b",
  host: "#37d67a",
  account: "#c77dff",
  link: "#5b8cff",
  file: "#ff9f4d",
  other: "#8b94a7",
};

// "Content" means something different depending on type - a URL for Link,
// so the field is relabeled (and the textarea swapped for how it's used)
// to match, instead of every type looking like the exact same form.
const CONTENT_FIELD_BY_TYPE = {
  link: { label: "URL", placeholder: "https://example.com/...", rows: 2 },
  host: { label: "IP / Hostname", placeholder: "10.0.0.5 or server.local", rows: 2 },
  account: { label: "Username", placeholder: "e.g. admin - keep the password in Credentials instead", rows: 2 },
  file: { label: "File / folder path", placeholder: "C:\\path\\to\\file or /path/to/file", rows: 2 },
};
function updateContentFieldForType() {
  const cfg = CONTENT_FIELD_BY_TYPE[$("#node-type").value];
  $("#node-content-label").textContent = cfg ? cfg.label : "Content";
  $("#node-content").placeholder = cfg ? cfg.placeholder : "";
  $("#node-content").rows = cfg ? cfg.rows : 8;
}

function openNodeModal(node, defaults = {}) {
  state.editingNodeId = node ? node.id : null;
  $("#modal-title").textContent = node ? "Edit node" : "New node";
  $("#node-title").value = node ? node.title : "";
  $("#node-type").value = node ? node.type : "note";
  $("#node-color").value = node ? node.color : TYPE_DEFAULT_COLOR.note;
  $("#node-tags").value = node ? node.tags : "";
  $("#node-content").value = node ? node.content : "";
  $("#node-delete").style.display = node ? "inline-block" : "none";
  $("#node-modal").dataset.x = node ? node.x : defaults.x;
  $("#node-modal").dataset.y = node ? node.y : defaults.y;
  $("#node-modal").dataset.origColor = node ? node.color : TYPE_DEFAULT_COLOR.note;
  updateContentFieldForType();
  $("#node-modal").classList.remove("hidden", "minimized");
}

// Only for a brand-new node (not yet saved): picking a different type also
// switches the color swatch to that type's default, so you don't have to
// manually re-pick a color every time just to get some visual variety.
$("#node-type").addEventListener("change", () => {
  updateContentFieldForType();
  if (state.editingNodeId) return;
  const def = TYPE_DEFAULT_COLOR[$("#node-type").value];
  if (def) $("#node-color").value = def;
});

function closeNodeModal() {
  $("#node-modal").classList.add("hidden");
  state.editingNodeId = null;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#node-modal").classList.contains("hidden")) {
    revertLiveColor();
    closeNodeModal();
  }
  if (e.key === "Escape" && !$("#image-lightbox").classList.contains("hidden")) {
    $("#image-lightbox").classList.add("hidden");
  }
});

function revertLiveColor() {
  if (!state.editingNodeId) return;
  const el = canvas.querySelector(`.node[data-id="${state.editingNodeId}"]`);
  const orig = $("#node-modal").dataset.origColor;
  if (el && orig) el.style.setProperty("--node-color", orig);
}

// Quick color swatches so picking a node color doesn't always mean digging
// into the native color picker - click one to use it directly.
const COLOR_PRESETS = [
  "#5b8cff", "#37d67a", "#ffd86b", "#ff9f4d", "#ff5f6d", "#c77dff",
  "#5bc0ff", "#ff6bd6", "#8bd450", "#ffb347", "#8b94a7", "#e8eaf0",
];
$("#color-presets").innerHTML = COLOR_PRESETS.map(
  (c) => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}"></button>`
).join("");
$("#color-presets").addEventListener("click", (e) => {
  const btn = e.target.closest(".color-swatch");
  if (!btn) return;
  $("#node-color").value = btn.dataset.color;
  $("#node-color").dispatchEvent(new Event("input", { bubbles: true }));
});

$("#node-color").addEventListener("input", (e) => {
  if (!state.editingNodeId) return;
  const el = canvas.querySelector(`.node[data-id="${state.editingNodeId}"]`);
  if (el) el.style.setProperty("--node-color", e.target.value);
});

$("#node-cancel").onclick = () => {
  revertLiveColor();
  closeNodeModal();
};

$("#node-save").onclick = async () => {
  const payload = {
    title: $("#node-title").value.trim() || "Untitled",
    type: $("#node-type").value,
    color: $("#node-color").value,
    tags: $("#node-tags").value.trim(),
    content: $("#node-content").value,
  };
  if (state.editingNodeId) {
    const updated = await api(`/api/nodes/${state.editingNodeId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const idx = state.nodes.findIndex((n) => n.id === updated.id);
    state.nodes[idx] = updated;
  } else {
    payload.x = parseFloat($("#node-modal").dataset.x) || 40;
    payload.y = parseFloat($("#node-modal").dataset.y) || 40;
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
  }
  closeNodeModal();
  renderCanvas();
};

function makeCreateNodeAction(nodeRef) {
  return {
    undo: async () => {
      await api(`/api/nodes/${nodeRef.id}`, { method: "DELETE" });
      state.nodes = state.nodes.filter((n) => n.id !== nodeRef.id);
      state.edges = state.edges.filter((e) => e.source_id !== nodeRef.id && e.target_id !== nodeRef.id);
      renderCanvas();
    },
    redo: async () => {
      const recreated = await api(`/api/boards/${state.currentBoardId}/nodes`, {
        method: "POST",
        body: JSON.stringify({
          title: nodeRef.title, type: nodeRef.type, color: nodeRef.color,
          tags: nodeRef.tags, content: nodeRef.content, x: nodeRef.x, y: nodeRef.y,
        }),
      });
      nodeRef.id = recreated.id;
      state.nodes.push(recreated);
      renderCanvas();
    },
  };
}

function makeDeleteNodeAction(nodeRef) {
  return {
    undo: async () => {
      const recreated = await api(`/api/boards/${state.currentBoardId}/nodes`, {
        method: "POST",
        body: JSON.stringify({
          title: nodeRef.title, type: nodeRef.type, color: nodeRef.color,
          tags: nodeRef.tags, content: nodeRef.content, x: nodeRef.x, y: nodeRef.y,
        }),
      });
      nodeRef.id = recreated.id;
      state.nodes.push(recreated);
      renderCanvas();
      await refreshNodeCounts();
    },
    redo: async () => {
      await api(`/api/nodes/${nodeRef.id}`, { method: "DELETE" });
      state.nodes = state.nodes.filter((n) => n.id !== nodeRef.id);
      state.edges = state.edges.filter((e) => e.source_id !== nodeRef.id && e.target_id !== nodeRef.id);
      renderCanvas();
    },
  };
}

$("#node-delete").onclick = async () => {
  if (!state.editingNodeId) return;
  if (!confirm("Delete this node and its connections?")) return;
  const nodeRef = state.nodes.find((n) => n.id === state.editingNodeId);
  await api(`/api/nodes/${state.editingNodeId}`, { method: "DELETE" });
  state.nodes = state.nodes.filter((n) => n.id !== state.editingNodeId);
  state.edges = state.edges.filter(
    (e) => e.source_id !== state.editingNodeId && e.target_id !== state.editingNodeId
  );
  if (nodeRef) pushHistory(makeDeleteNodeAction({ ...nodeRef }));
  closeNodeModal();
  renderCanvas();
};

// ---------- search ----------

// Searches every board at once, not just whichever one is open - so
// something written weeks ago for a different subject/project is still
// easy to dig back up later.
async function goToBoard(boardId) {
  if (state.currentBoardId !== boardId) {
    state.currentBoardId = boardId;
    renderBoardList();
    await loadBoard(boardId);
  }
}

let searchTimer = null;
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    const el = $("#search-results");
    if (!q) {
      el.innerHTML = "";
      return;
    }
    const { nodes, docs } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    el.innerHTML = "";
    if (!nodes.length && !docs.length) {
      el.innerHTML = `<div class="search-empty">No matches.</div>`;
      return;
    }
    nodes.forEach((node) => {
      const div = document.createElement("div");
      div.className = "search-hit";
      div.innerHTML = `${NODE_ICONS[node.type] || NODE_ICONS.other} ${escapeHtml(node.title)}
        <span class="search-hit-board">${escapeHtml(node.board_name)}</span>`;
      div.onclick = async () => {
        await goToBoard(node.board_id);
        const target = canvas.querySelector(`.node[data-id="${node.id}"]`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        openNodeModal(node);
      };
      el.appendChild(div);
    });
    docs.forEach((doc) => {
      const div = document.createElement("div");
      div.className = "search-hit";
      div.innerHTML = `▤ ${escapeHtml(doc.title)}
        <span class="search-hit-board">${escapeHtml(doc.board_name)}</span>`;
      div.onclick = async () => {
        await goToBoard(doc.board_id);
        switchView("reports");
        openDoc(doc.id);
      };
      el.appendChild(div);
    });
  }, 250);
});

// ---------- export / import ----------

$("#export-btn").onclick = async () => {
  if (!state.currentBoardId) return;
  const board = state.boards.find((b) => b.id === state.currentBoardId);
  const nodeIndex = new Map(state.nodes.map((n, i) => [n.id, i]));
  const payload = {
    format: "mapes-board",
    version: 1,
    board: { name: board.name, description: board.description },
    nodes: state.nodes.map((n) => ({
      type: n.type,
      title: n.title,
      content: n.content,
      tags: n.tags,
      color: n.color,
      x: n.x,
      y: n.y,
    })),
    edges: state.edges.map((e) => ({
      source: nodeIndex.get(e.source_id),
      target: nodeIndex.get(e.target_id),
      label: e.label,
    })),
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = `${(board.name || "mapes-board").replace(/[^\w\-]+/g, "_")}.json`;

  // Inside the native app window, a plain <a download> click often does
  // nothing (pywebview's embedded browser doesn't reliably wire up the
  // download flow a real browser tab has) - use the native save dialog
  // + explicit file write instead, same pattern as "Save As".
  if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_export_json_file) {
    const path = await window.pywebview.api.pick_export_json_file(filename);
    if (!path) return;
    const result = await window.pywebview.api.write_text_file(path, json);
    if (result !== true) alert(`Could not write the file: ${result}`);
    return;
  }

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

$("#import-btn").onclick = () => $("#import-file").click();

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.currentBoardId) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert("Could not read the file: invalid JSON");
    return;
  }
  if (!Array.isArray(data.nodes)) {
    alert("This file doesn't look like a MAPES board export");
    return;
  }
  const createdIds = [];
  for (const n of data.nodes) {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify(n),
    });
    createdIds.push(created.id);
    state.nodes.push(created);
  }
  for (const e2 of data.edges || []) {
    const sourceId = createdIds[e2.source];
    const targetId = createdIds[e2.target];
    if (!sourceId || !targetId) continue;
    const edge = await api(`/api/boards/${state.currentBoardId}/edges`, {
      method: "POST",
      body: JSON.stringify({ source_id: sourceId, target_id: targetId, label: e2.label || "" }),
    });
    state.edges.push(edge);
  }
  renderCanvas();
});

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- file: current path, open, save as, save ----------

function hasNativeApi() {
  return !!(window.pywebview && window.pywebview.api);
}

async function refreshFileStatus() {
  const info = await api("/api/system/file-status");
  $("#file-path").textContent = info.path;
  if (info.linked_path) {
    $("#file-save-btn").disabled = false;
    setFileStatus(`Linked to: ${info.linked_path}`);
  } else {
    $("#file-save-btn").disabled = true;
  }
}

function setFileStatus(text) {
  $("#file-status").textContent = text;
}

$("#file-open-btn").onclick = async () => {
  let path;
  if (hasNativeApi()) {
    path = await window.pywebview.api.pick_open_file();
  } else {
    path = prompt("Path to a folder or .db file to open:");
  }
  if (!path) return;
  try {
    const res = await api("/api/system/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    setFileStatus(res.existed ? "Opened existing board" : "Created new board");
    state.currentBoardId = null;
    await loadBoards();
    await refreshFileStatus();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
};

$("#file-save-as-btn").onclick = async () => {
  let path;
  if (hasNativeApi()) {
    path = await window.pywebview.api.pick_save_as_file();
  } else {
    path = prompt("Save board as (path to a .db file):");
  }
  if (!path) return;
  try {
    const res = await api("/api/system/save-as", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    setFileStatus(`Saved: ${res.path}`);
    $("#file-save-btn").disabled = false;
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
};

$("#file-save-btn").onclick = async () => {
  try {
    const res = await api("/api/system/save", { method: "POST" });
    const now = new Date().toLocaleTimeString("en-US");
    setFileStatus(`Saved at ${now}`);
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
};

// ---------- view tabs (Board / Vault / Credentials / Reports) ----------

state.currentView = "board";

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

async function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.add("hidden"));
  $(`#${view}-view`).classList.remove("hidden");
  await refreshCurrentView();
}

async function refreshCurrentView() {
  if (!state.currentBoardId) return;
  if (state.currentView === "vault") await loadVault();
  else if (state.currentView === "creds") await loadCreds();
  else if (state.currentView === "reports") await loadDocs();
}

function populateNodeSelect(select, selectedId) {
  select.innerHTML = '<option value="">- no node -</option>';
  state.nodes.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n.id;
    opt.textContent = n.title;
    if (selectedId && String(selectedId) === String(n.id)) opt.selected = true;
    select.appendChild(opt);
  });
}

function nodeTitle(nodeId) {
  const n = state.nodes.find((x) => String(x.id) === String(nodeId));
  return n ? n.title : "";
}

// Small removable "chip" shown under a node-link <select>, so the linked
// node can be unlinked with one click instead of hunting it in the dropdown.
// Wiring a select to its chip container also keeps them in sync both ways
// (picking a new node in the dropdown updates the chip) and the select
// itself already guarantees a node can only be linked once (single value).
function wireNodeChip(select, chipContainer) {
  const sync = () => {
    const id = select.value;
    if (!id) {
      chipContainer.innerHTML = "";
      return;
    }
    chipContainer.innerHTML = `<span class="node-chip">${escapeHtml(nodeTitle(id))} <button type="button" class="chip-x" title="Unlink">×</button></span>`;
    chipContainer.querySelector(".chip-x").onclick = () => {
      select.value = "";
      sync();
    };
  };
  select.onchange = sync;
  sync();
}

// ---------- Vault (file attachments + folders) ----------

let editingCaptureId = null;
let vaultFolderId = null;
let vaultFolderPath = []; // [{id, name}, ...] from root to current folder

const TEXT_PREVIEW_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yml", ".yaml", ".xml", ".ini", ".cfg"];

function isTextPreviewable(cap) {
  if (cap.mime && cap.mime.startsWith("text/")) return true;
  if (cap.mime === "application/json") return true;
  const ext = (cap.orig_name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  return TEXT_PREVIEW_EXT.includes(ext);
}

function isSpreadsheetPreviewable(cap) {
  const ext = (cap.orig_name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  return ext === ".xlsx" || ext === ".xlsm";
}

// Windows Notepad has historically saved plain .txt files as UTF-16 (with
// a BOM), not UTF-8 - fetch's default text() always decodes as UTF-8, so a
// UTF-16 file comes out as near-invisible garbage (mostly null bytes).
// Sniff the BOM and pick the right decoder instead of assuming UTF-8.
function decodeTextBuffer(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf);
  }
  return new TextDecoder("utf-8").decode(buf);
}

// Turns a card's name label into an editable text field right in place
// (used by every "Rename" menu item) instead of a native prompt() dialog -
// commits on Enter/blur, reverts on Escape.
function startInlineRename(nameEl, currentValue, onSave) {
  nameEl.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "vault-rename-input";
  input.value = currentValue;
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (commit && val && val !== currentValue) {
      await onSave(val);
    } else {
      nameEl.textContent = currentValue;
    }
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); done = true; nameEl.textContent = currentValue; }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

async function loadVault() {
  const [folders, items] = await Promise.all([
    api(`/api/boards/${state.currentBoardId}/capture-folders${vaultFolderId ? `?parent_id=${vaultFolderId}` : ""}`),
    api(`/api/boards/${state.currentBoardId}/captures${vaultFolderId ? `?folder_id=${vaultFolderId}` : ""}`),
  ]);
  renderVaultBreadcrumb();
  const grid = $("#vault-grid");
  grid.innerHTML = "";
  if (!folders.length && !items.length) {
    grid.innerHTML = `<div class="view-empty"><span class="view-empty-icon">🖼</span>No files yet - click "+ Upload file" above to add one.</div>`;
    return;
  }
  folders.forEach((folder) => {
    const card = document.createElement("div");
    card.className = "vault-card vault-folder-card";
    card.innerHTML = `
      <div class="vault-thumb">📁</div>
      <div class="vault-card-info">
        <div class="vault-card-name">${escapeHtml(folder.name)}</div>
        <div class="vault-card-meta">Folder</div>
      </div>
      <button type="button" class="vault-card-menu-btn" title="More">⋯</button>
      <div class="vault-card-menu hidden">
        <div class="vault-card-menu-item" data-action="rename">Rename</div>
        <div class="vault-card-menu-item" data-action="duplicate">Duplicate</div>
        <div class="vault-card-menu-item danger" data-action="delete">Delete</div>
      </div>
    `;
    card.onclick = () => {
      vaultFolderPath.push({ id: folder.id, name: folder.name });
      vaultFolderId = folder.id;
      loadVault();
    };
    const menuBtn = card.querySelector(".vault-card-menu-btn");
    const menu = card.querySelector(".vault-card-menu");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".vault-card-menu").forEach((m) => { if (m !== menu) m.classList.add("hidden"); });
      menu.classList.toggle("hidden");
    };
    menu.onclick = async (e) => {
      e.stopPropagation();
      const action = e.target.closest(".vault-card-menu-item")?.dataset.action;
      if (!action) return;
      menu.classList.add("hidden");
      if (action === "rename") {
        startInlineRename(card.querySelector(".vault-card-name"), folder.name, async (name) => {
          await api(`/api/capture-folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
          await loadVault();
        });
      } else if (action === "duplicate") {
        await api(`/api/capture-folders/${folder.id}/duplicate`, { method: "POST" });
        await loadVault();
      } else if (action === "delete") {
        if (!confirm(`Delete folder "${folder.name}" and everything inside it?`)) return;
        await api(`/api/capture-folders/${folder.id}`, { method: "DELETE" });
        await loadVault();
      }
    };
    grid.appendChild(card);
  });
  items.forEach((cap) => {
    const card = document.createElement("div");
    card.className = "vault-card";
    const isImage = cap.mime && cap.mime.startsWith("image/");
    card.innerHTML = `
      <div class="vault-thumb">${isImage ? `<img src="/api/captures/${cap.id}/file" loading="lazy">` : "📄"}</div>
      <div class="vault-card-info">
        <div class="vault-card-name">${escapeHtml(cap.caption || cap.orig_name)}</div>
        <div class="vault-card-meta">${nodeTitle(cap.node_id) || "no node"}</div>
      </div>
      <button type="button" class="vault-card-menu-btn" title="More">⋯</button>
      <div class="vault-card-menu hidden">
        <div class="vault-card-menu-item" data-action="rename">Rename</div>
        <div class="vault-card-menu-item" data-action="duplicate">Duplicate</div>
        <div class="vault-card-menu-item danger" data-action="delete">Delete</div>
      </div>
    `;
    card.onclick = () => openCaptureModal(cap);
    const menuBtn = card.querySelector(".vault-card-menu-btn");
    const menu = card.querySelector(".vault-card-menu");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".vault-card-menu").forEach((m) => { if (m !== menu) m.classList.add("hidden"); });
      menu.classList.toggle("hidden");
    };
    menu.onclick = async (e) => {
      e.stopPropagation();
      const action = e.target.closest(".vault-card-menu-item")?.dataset.action;
      if (!action) return;
      menu.classList.add("hidden");
      if (action === "rename") {
        startInlineRename(card.querySelector(".vault-card-name"), cap.caption || cap.orig_name, async (name) => {
          await api(`/api/captures/${cap.id}`, { method: "PATCH", body: JSON.stringify({ caption: name }) });
          await loadVault();
        });
      } else if (action === "duplicate") {
        await api(`/api/captures/${cap.id}/duplicate`, { method: "POST" });
        await loadVault();
      } else if (action === "delete") {
        if (!confirm(`Delete "${cap.caption || cap.orig_name}"?`)) return;
        await api(`/api/captures/${cap.id}`, { method: "DELETE" });
        await loadVault();
      }
    };
    grid.appendChild(card);
  });
}

function renderVaultBreadcrumb() {
  const bar = $("#vault-breadcrumb");
  const crumbs = [{ id: null, name: "Vault" }, ...vaultFolderPath];
  bar.innerHTML = crumbs
    .map((c, i) => {
      const isLast = i === crumbs.length - 1;
      return `<span class="vault-crumb${isLast ? " active" : ""}" data-i="${i}">${escapeHtml(c.name)}</span>`;
    })
    .join('<span class="vault-crumb-sep">/</span>');
  bar.querySelectorAll(".vault-crumb").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      if (i === crumbs.length - 1) return;
      vaultFolderPath = vaultFolderPath.slice(0, i);
      vaultFolderId = i === 0 ? null : crumbs[i].id;
      loadVault();
    };
  });
}

document.addEventListener("click", () => {
  document.querySelectorAll(".vault-card-menu").forEach((m) => m.classList.add("hidden"));
});

$("#vault-upload-btn").onclick = () => $("#vault-file-input").click();

$("#vault-new-folder-btn").onclick = async () => {
  const name = prompt("Folder name:", "New folder");
  if (!name || !name.trim()) return;
  await api(`/api/boards/${state.currentBoardId}/capture-folders`, {
    method: "POST",
    body: JSON.stringify({ name: name.trim(), parent_id: vaultFolderId }),
  });
  await loadVault();
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadOneFile(file, folder_id) {
  const data = await readFileAsDataUrl(file);
  await api(`/api/boards/${state.currentBoardId}/captures`, {
    method: "POST",
    body: JSON.stringify({
      data,
      orig_name: file.name,
      mime: file.type || "application/octet-stream",
      folder_id,
    }),
  });
}

$("#vault-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.currentBoardId) return;
  try {
    await uploadOneFile(file, vaultFolderId);
    await loadVault();
  } catch (err) {
    alert(`Upload error: ${err.message}`);
  }
});

$("#vault-upload-folder-btn").onclick = () => $("#vault-folder-input").click();

// Recreates the picked local folder's structure as Vault sub-folders (one
// API call per never-seen-before directory, cached by path so nested files
// sharing a parent only create it once), then uploads every file into the
// folder that matches its original relative path.
$("#vault-folder-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = "";
  if (!files.length || !state.currentBoardId) return;

  const folderIdByPath = new Map([["", vaultFolderId]]);
  const resolveFolder = async (dirPath) => {
    if (folderIdByPath.has(dirPath)) return folderIdByPath.get(dirPath);
    const parts = dirPath.split("/");
    const parentId = await resolveFolder(parts.slice(0, -1).join("/"));
    const folder = await api(`/api/boards/${state.currentBoardId}/capture-folders`, {
      method: "POST",
      body: JSON.stringify({ name: parts[parts.length - 1], parent_id: parentId }),
    });
    folderIdByPath.set(dirPath, folder.id);
    return folder.id;
  };

  let failed = 0;
  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const dirPath = relPath.split("/").slice(0, -1).join("/");
    try {
      const folderId = await resolveFolder(dirPath);
      await uploadOneFile(file, folderId);
    } catch {
      failed++;
    }
  }
  await loadVault();
  if (failed) alert(`${failed} file(s) failed to upload.`);
});

function renderSheetPreview(preview, data) {
  if (data.error || !data.sheets || !data.sheets.length) {
    preview.innerHTML = `<div class="capture-sheet-preview">${escapeHtml(data.error || "No data")}</div>`;
    return;
  }
  const sheets = data.sheets;
  const tabsHtml = sheets.length > 1
    ? `<div class="sheet-tabs">${sheets.map((s, i) => `<button type="button" class="sheet-tab${i === 0 ? " active" : ""}" data-i="${i}">${escapeHtml(s.name)}</button>`).join("")}</div>`
    : "";
  const renderTable = (sheet) => `
    <div class="capture-sheet-wrap">
      <table class="capture-sheet-table">
        ${sheet.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
      </table>
      ${sheet.truncated ? `<div class="sheet-truncated-note">Showing a partial preview - open the file to see the rest.</div>` : ""}
    </div>
  `;
  preview.innerHTML = `${tabsHtml}${renderTable(sheets[0])}`;
  preview.querySelectorAll(".sheet-tab").forEach((btn) => {
    btn.onclick = () => {
      preview.querySelectorAll(".sheet-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      preview.querySelector(".capture-sheet-wrap").outerHTML = renderTable(sheets[Number(btn.dataset.i)]);
    };
  });
}

function openImageLightbox(url) {
  const box = $("#image-lightbox");
  box.querySelector("img").src = url;
  box.classList.remove("hidden");
}
$("#image-lightbox").onclick = () => $("#image-lightbox").classList.add("hidden");

async function openCaptureModal(cap) {
  editingCaptureId = cap.id;
  const isImage = cap.mime && cap.mime.startsWith("image/");
  const isPdf = cap.mime === "application/pdf";
  const fileUrl = `/api/captures/${cap.id}/file`;
  const preview = $("#capture-preview");
  if (isImage) {
    preview.innerHTML = `<img src="${fileUrl}" title="Click to enlarge">`;
    preview.querySelector("img").onclick = () => openImageLightbox(fileUrl);
  } else if (isPdf) {
    preview.innerHTML = `<iframe class="capture-pdf-frame" src="${fileUrl}"></iframe>`;
  } else if (isSpreadsheetPreviewable(cap)) {
    preview.innerHTML = `<div class="capture-sheet-preview">Loading...</div>`;
    fetch(`/api/captures/${cap.id}/preview`)
      .then((r) => r.json())
      .then((data) => renderSheetPreview(preview, data))
      .catch(() => {
        preview.innerHTML = `<div class="capture-sheet-preview">(couldn't load preview)</div>`;
      });
  } else if (isTextPreviewable(cap)) {
    preview.innerHTML = `<pre class="capture-text-preview">Loading...</pre>`;
    fetch(fileUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const text = decodeTextBuffer(buf);
        preview.querySelector(".capture-text-preview").textContent = text || "(this file is empty)";
      })
      .catch(() => {
        preview.querySelector(".capture-text-preview").textContent = "(couldn't load preview)";
      });
  } else {
    preview.innerHTML = `<div class="file-icon">📄 ${escapeHtml(cap.orig_name)}</div>`;
  }
  $("#capture-open-btn").hidden = isImage;
  $("#capture-open-btn").onclick = () => openExternalUrl(`${location.origin}${fileUrl}`);
  $("#capture-caption").value = cap.caption || "";
  $("#capture-tags").value = cap.tags || "";
  populateNodeSelect($("#capture-node"), cap.node_id);
  wireNodeChip($("#capture-node"), $("#capture-node-chip"));
  $("#capture-modal").classList.remove("hidden", "minimized");
}

$("#capture-cancel").onclick = () => $("#capture-modal").classList.add("hidden");

$("#capture-save").onclick = async () => {
  await api(`/api/captures/${editingCaptureId}`, {
    method: "PATCH",
    body: JSON.stringify({
      caption: $("#capture-caption").value.trim(),
      tags: $("#capture-tags").value.trim(),
      node_id: $("#capture-node").value || null,
    }),
  });
  $("#capture-modal").classList.add("hidden");
  await loadVault();
  await refreshNodeCounts();
};

$("#capture-delete").onclick = async () => {
  if (!confirm("Delete this file?")) return;
  await api(`/api/captures/${editingCaptureId}`, { method: "DELETE" });
  $("#capture-modal").classList.add("hidden");
  await loadVault();
  await refreshNodeCounts();
};

// ---------- Credentials ----------

let editingCredId = null;

async function loadCreds() {
  const items = await api(`/api/boards/${state.currentBoardId}/creds`);
  const tbody = $("#creds-tbody");
  tbody.innerHTML = "";
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">🔑 No credentials yet - click "+ Credential" above to add one.</td></tr>`;
    return;
  }
  items.forEach((cred) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(cred.username || "-")}</td>
      <td>${escapeHtml(cred.service || "-")}</td>
      <td>${escapeHtml(cred.kind)}</td>
      <td><span class="status-badge ${cred.status}">${escapeHtml(cred.status)}</span></td>
      <td>${escapeHtml(nodeTitle(cred.node_id) || "-")}</td>
      <td class="secret-cell">
        ${cred.has_secret
          ? `<span class="secret-value" data-secret-for="${cred.id}">••••••</span>
             <button class="row-action" data-action="reveal" data-id="${cred.id}" title="Show/hide">👁</button>
             <button class="row-action" data-action="copy" data-id="${cred.id}" title="Copy">📋</button>`
          : "-"}
      </td>
    `;
    tr.onclick = () => openCredModal(cred);
    tbody.appendChild(tr);
  });
}

$("#creds-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".row-action");
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  const valueEl = document.querySelector(`[data-secret-for="${id}"]`);
  if (btn.dataset.action === "reveal") {
    if (valueEl.dataset.revealed === "1") {
      valueEl.textContent = "••••••";
      valueEl.dataset.revealed = "0";
    } else {
      const { secret } = await api(`/api/creds/${id}/reveal`);
      valueEl.textContent = secret || "(empty)";
      valueEl.dataset.revealed = "1";
    }
  } else if (btn.dataset.action === "copy") {
    const { secret } = await api(`/api/creds/${id}/reveal`);
    try {
      await navigator.clipboard.writeText(secret || "");
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = "📋"; }, 1000);
    } catch {
      alert("Could not copy to clipboard");
    }
  }
});

$("#creds-add-btn").onclick = () => openCredModal(null);

function openCredModal(cred) {
  editingCredId = cred ? cred.id : null;
  $("#cred-modal-title").textContent = cred ? "Edit credential" : "New credential";
  $("#cred-username").value = cred ? cred.username : "";
  $("#cred-secret").value = "";
  $("#cred-secret").placeholder = cred ? "leave empty to keep unchanged" : "";
  $("#cred-kind").value = cred ? cred.kind : "password";
  $("#cred-hash-type").value = cred ? cred.hash_type : "";
  $("#cred-service").value = cred ? cred.service : "";
  $("#cred-status").value = cred ? cred.status : "untested";
  $("#cred-notes").value = cred ? cred.notes : "";
  populateNodeSelect($("#cred-node"), cred ? cred.node_id : null);
  wireNodeChip($("#cred-node"), $("#cred-node-chip"));
  $("#cred-delete").style.display = cred ? "inline-block" : "none";
  $("#cred-modal").classList.remove("hidden", "minimized");
}

$("#cred-cancel").onclick = () => $("#cred-modal").classList.add("hidden");

$("#cred-save").onclick = async () => {
  const payload = {
    username: $("#cred-username").value.trim(),
    kind: $("#cred-kind").value,
    hash_type: $("#cred-hash-type").value.trim(),
    service: $("#cred-service").value.trim(),
    status: $("#cred-status").value,
    notes: $("#cred-notes").value,
    node_id: $("#cred-node").value || null,
  };
  const secret = $("#cred-secret").value;
  if (secret) payload.secret = secret;
  if (editingCredId) {
    await api(`/api/creds/${editingCredId}`, { method: "PATCH", body: JSON.stringify(payload) });
  } else {
    await api(`/api/boards/${state.currentBoardId}/creds`, { method: "POST", body: JSON.stringify(payload) });
  }
  $("#cred-modal").classList.add("hidden");
  await loadCreds();
  await refreshNodeCounts();
};

$("#cred-delete").onclick = async () => {
  if (!editingCredId || !confirm("Delete this credential?")) return;
  await api(`/api/creds/${editingCredId}`, { method: "DELETE" });
  $("#cred-modal").classList.add("hidden");
  await loadCreds();
  await refreshNodeCounts();
};

// ---------- Reports (markdown docs) ----------

let currentDocId = null;

async function loadDocs() {
  const items = await api(`/api/boards/${state.currentBoardId}/docs`);
  const list = $("#doc-list");
  list.innerHTML = "";
  items.forEach((d) => {
    const div = document.createElement("div");
    div.className = "doc-item" + (d.id === currentDocId ? " active" : "");
    div.innerHTML = `${escapeHtml(d.title)}<div class="doc-item-meta">${d.size} chars</div>`;
    div.onclick = () => openDoc(d.id);
    list.appendChild(div);
  });
  if (!items.some((d) => d.id === currentDocId)) {
    currentDocId = null;
    setDocEditorEnabled(false);
  }
}

function setDocEditorEnabled(enabled) {
  $("#doc-title-input").disabled = !enabled;
  $("#doc-body-input").disabled = !enabled;
  $("#doc-save-btn").disabled = !enabled;
  $("#doc-export-btn").disabled = !enabled;
  $("#doc-delete-btn").disabled = !enabled;
  if (!enabled) {
    $("#doc-title-input").value = "";
    $("#doc-body-input").value = "";
    $("#doc-preview").innerHTML = "";
    $("#doc-preview").classList.add("hidden");
    $("#doc-body-input").classList.remove("hidden");
  }
}

async function openDoc(id) {
  currentDocId = id;
  const doc = await api(`/api/docs/${id}`);
  $("#doc-title-input").value = doc.title;
  $("#doc-body-input").value = doc.body;
  setDocEditorEnabled(true);
  if (doc.body.trim()) showDocPreviewMode();
  else showDocEditMode();
  await loadDocs();
}

$("#doc-add-btn").onclick = async () => {
  const doc = await api(`/api/boards/${state.currentBoardId}/docs`, {
    method: "POST",
    body: JSON.stringify({ title: "New report", body: "" }),
  });
  await openDoc(doc.id);
};

$("#doc-body-input").addEventListener("input", renderDocPreview);

function renderDocPreview() {
  $("#doc-preview").innerHTML = renderMarkdown($("#doc-body-input").value);
}

// Reports uses one screen instead of a permanent split view: click the
// (formatted) text to start typing in it directly, click away and it's
// shown formatted again - closer to a normal document than a code editor
// with a separate live-preview pane bolted on.
function showDocPreviewMode() {
  renderDocPreview();
  $("#doc-body-input").classList.add("hidden");
  $("#doc-preview").classList.remove("hidden");
}
function showDocEditMode() {
  $("#doc-preview").classList.add("hidden");
  $("#doc-body-input").classList.remove("hidden");
  $("#doc-body-input").focus();
}

$("#doc-body-input").addEventListener("blur", async () => {
  if (!currentDocId) return;
  await api(`/api/docs/${currentDocId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: $("#doc-title-input").value.trim() || "Report",
      body: $("#doc-body-input").value,
    }),
  });
  await loadDocs();
  showDocPreviewMode();
});

$("#doc-title-input").addEventListener("blur", async () => {
  if (!currentDocId) return;
  await api(`/api/docs/${currentDocId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: $("#doc-title-input").value.trim() || "Report" }),
  });
  await loadDocs();
});

// Ticking a checklist box in the preview edits the "[ ]"/"[x]" on that exact
// source line and re-renders, without leaving preview mode. Clicking
// anywhere else in the preview switches to edit mode.
$("#doc-preview").addEventListener("click", (e) => {
  // Clicking the checkbox itself already toggles it natively (handled by
  // the "change" listener below) - don't also fall through to edit mode.
  if (e.target.matches('input[type="checkbox"]')) return;
  const text = e.target.closest(".task-text");
  if (text) {
    const cb = text.previousElementSibling;
    if (cb && cb.matches('input[type="checkbox"]')) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  if (currentDocId) showDocEditMode();
});

$("#doc-preview").addEventListener("change", async (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-line]');
  if (!cb) return;
  const idx = Number(cb.dataset.line);
  const textarea = $("#doc-body-input");
  const lines = textarea.value.split("\n");
  if (lines[idx] === undefined) return;
  lines[idx] = cb.checked
    ? lines[idx].replace(/\[[ xX]\]/, "[x]")
    : lines[idx].replace(/\[[ xX]\]/, "[ ]");
  textarea.value = lines.join("\n");
  renderDocPreview();
  // Ticking a box happens while in preview mode (no textarea blur to hang
  // an autosave off of), so save it immediately rather than only on the
  // next explicit "Save report" click.
  if (currentDocId) {
    await api(`/api/docs/${currentDocId}`, {
      method: "PATCH",
      body: JSON.stringify({ body: textarea.value }),
    });
    await loadDocs();
  }
});

$("#doc-save-btn").onclick = async () => {
  await api(`/api/docs/${currentDocId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: $("#doc-title-input").value.trim() || "Report",
      body: $("#doc-body-input").value,
    }),
  });
  await loadDocs();
};

$("#doc-export-btn").onclick = async () => {
  if (!currentDocId) return;
  const res = await fetch(`/api/docs/${currentDocId}/export.md`);
  const text = await res.text();
  const filename = `${($("#doc-title-input").value || "report").replace(/[^\w\-]+/g, "_")}.md`;

  // Same as "Export board to JSON": inside the native app window a plain
  // <a href> click to a download URL doesn't reliably do anything, so use
  // the native save dialog + explicit file write instead.
  if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_export_md_file) {
    const path = await window.pywebview.api.pick_export_md_file(filename);
    if (!path) return;
    const result = await window.pywebview.api.write_text_file(path, text);
    if (result !== true) alert(`Could not write the file: ${result}`);
    return;
  }

  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

$("#doc-delete-btn").onclick = async () => {
  if (!currentDocId || !confirm("Delete this report?")) return;
  await api(`/api/docs/${currentDocId}`, { method: "DELETE" });
  currentDocId = null;
  setDocEditorEnabled(false);
  await loadDocs();
};

function renderMarkdown(src) {
  // Walks the RAW source line-by-line (tracking whether we're inside a
  // ``` fence as we go) instead of pre-substituting code blocks with a
  // placeholder first - that used to shift every later line's index
  // whenever a multi-line code block collapsed to one placeholder line,
  // which would have made task-checkbox line numbers (below) point at the
  // wrong line for any report that mixes code blocks with a checklist.
  const rawLines = String(src ?? "").split("\n");
  const html = [];
  let inList = false;
  let inQuote = false;
  let inCode = false;
  let codeBuf = [];

  let tableRows = null; // array of arrays of cell text while inside a table

  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };
  const closeQuote = () => { if (inQuote) { html.push("</blockquote>"); inQuote = false; } };
  const flushCode = () => { html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; };
  const splitTableRow = (line) => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };
  const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const flushTable = () => {
    if (!tableRows || !tableRows.length) { tableRows = null; return; }
    const [header, ...body] = tableRows;
    html.push(
      "<table class='md-table'><thead><tr>" +
        header.map((c) => `<th>${inline(c)}</th>`).join("") +
        "</tr></thead><tbody>" +
        body.map((row) => "<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>"
    );
    tableRows = null;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (line.trim().startsWith("```")) {
      flushTable();
      if (inCode) { inCode = false; flushCode(); }
      else { closeList(); closeQuote(); inCode = true; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // GitHub-style table: a "| a | b |" row immediately followed by a
    // "| --- | --- |" separator row starts one; every following row with a
    // "|" in it is another row, until a line without one ends it.
    if (tableRows) {
      if (line.includes("|") && line.trim() !== "") {
        tableRows.push(splitTableRow(line));
        continue;
      }
      flushTable();
    } else if (line.includes("|") && rawLines[i + 1] !== undefined && isTableSeparator(rawLines[i + 1])) {
      closeList(); closeQuote();
      tableRows = [splitTableRow(line)];
      i++; // consume the separator row
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    // "- [ ] text" / "- [x] text" checklist items render as a live, clickable
    // checkbox tied back to this exact source line - handy for study to-dos
    // ("review chapter 3", "redo the subnetting exercises"...) that need
    // ticking off without leaving the note.
    const taskItem = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    const listItem = !taskItem && line.match(/^[-*]\s+(.*)$/);
    const quoteItem = line.match(/^>\s?(.*)$/);

    if (heading) {
      closeList(); closeQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (taskItem) {
      closeQuote();
      if (!inList) { html.push("<ul>"); inList = true; }
      const checked = taskItem[1].toLowerCase() === "x";
      html.push(
        `<li class="task-item"><input type="checkbox" data-line="${i}"${checked ? " checked" : ""}><span class="task-text">${inline(taskItem[2])}</span></li>`
      );
    } else if (listItem) {
      closeQuote();
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${inline(listItem[1])}</li>`);
    } else if (quoteItem) {
      closeList();
      if (!inQuote) { html.push("<blockquote>"); inQuote = true; }
      html.push(inline(quoteItem[1]) + "<br>");
    } else if (line.trim() === "") {
      closeList(); closeQuote();
    } else {
      closeList(); closeQuote();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inCode) flushCode(); // unterminated fence - still show what's there
  flushTable();
  closeList(); closeQuote();

  return html.join("\n");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ---------- minimizable modal windows ----------

const MODAL_CANCEL_BTN = {
  "node-modal": "node-cancel",
  "capture-modal": "capture-cancel",
  "cred-modal": "cred-cancel",
};

document.addEventListener("click", (e) => {
  const minBtn = e.target.closest(".modal-min-btn");
  if (minBtn) {
    e.stopPropagation();
    $(`#${minBtn.dataset.modal}`).classList.toggle("minimized");
    return;
  }
  const closeBtn = e.target.closest(".modal-close-btn");
  if (closeBtn) {
    e.stopPropagation();
    const cancelId = MODAL_CANCEL_BTN[closeBtn.dataset.modal];
    if (cancelId) $(`#${cancelId}`).click();
    return;
  }
  const minimizedBox = e.target.closest(".modal.minimized .modal-box");
  if (minimizedBox) {
    minimizedBox.closest(".modal").classList.remove("minimized");
  }
});

// ---------- sidebar resize ----------

(function setupSidebarResize() {
  const sidebar = $("#sidebar");
  const handle = $("#sidebar-resize-handle");
  const MIN_W = 190;
  const MAX_W = 480;
  const saved = parseFloat(localStorage.getItem("mapes_sidebar_w"));
  if (saved && saved >= MIN_W && saved <= MAX_W) sidebar.style.width = `${saved}px`;

  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(MAX_W, Math.max(MIN_W, e.clientX));
    sidebar.style.width = `${w}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("mapes_sidebar_w", parseFloat(sidebar.style.width));
  });
})();

loadBoards();
refreshFileStatus();

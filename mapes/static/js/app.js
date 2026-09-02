const state = {
  boards: [],
  currentBoardId: null,
  nodes: [],
  edges: [],
  nodeCounts: {},
  connectMode: false,
  connectSource: null,
  editingNodeId: null,
  zoom: 1,
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
  other: "▫",
};

const $ = (sel) => document.querySelector(sel);

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
$("#zoom-reset-btn").onclick = () => setZoom(1);

$("#zoom-fit-btn").onclick = () => {
  if (!state.nodes.length) return;
  const pad = 60;
  const xs = state.nodes.map((n) => n.x);
  const ys = state.nodes.map((n) => n.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + 180 + pad;
  const maxY = Math.max(...ys) + 90 + pad;
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const availW = canvasWrapper.clientWidth;
  const availH = canvasWrapper.clientHeight;
  setZoom(Math.min(availW / boxW, availH / boxH, ZOOM_MAX));
  canvasWrapper.scrollLeft = minX * state.zoom;
  canvasWrapper.scrollTop = minY * state.zoom;
};

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

canvas.addEventListener("dblclick", async (e) => {
  if (e.target !== canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.zoom;
  const y = (e.clientY - rect.top) / state.zoom;
  openNodeModal(null, { x, y });
});

// Quick sticky-note shortcut: drop a "note" node in the middle of whatever
// part of the board is currently in view, and open it straight for typing -
// no need to double-click an exact empty spot first.
$("#add-note-btn").onclick = () => {
  const x = (canvasWrapper.scrollLeft + canvasWrapper.clientWidth / 2) / state.zoom - 95;
  const y = (canvasWrapper.scrollTop + canvasWrapper.clientHeight / 2) / state.zoom - 40;
  openNodeModal(null, { x, y });
  $("#node-type").value = "note";
  setTimeout(() => $("#node-content").focus(), 50);
};

function renderCanvas() {
  // A node picked as the "connect from" source may have just been deleted
  // (directly, or via undo/redo) - drop the stale selection so a later click
  // can't try to create an edge from/to a node id that no longer exists.
  if (state.connectSource && !state.nodes.some((n) => n.id === state.connectSource)) {
    state.connectSource = null;
  }
  canvas.querySelectorAll(".node").forEach((n) => n.remove());
  state.nodes.forEach((node) => canvas.appendChild(buildNodeEl(node)));
  renderEdges();
  canvasWrapper.classList.toggle("empty", state.nodes.length === 0);
}

function buildNodeEl(node) {
  const el = document.createElement("div");
  el.className = "node";
  el.dataset.id = node.id;
  el.dataset.type = node.type;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.setProperty("--node-color", node.color || "#4f8cff");
  el.innerHTML = `
    <div class="node-icon-badge">${NODE_ICONS[node.type] || NODE_ICONS.other}</div>
    <div class="node-type">${escapeHtml(node.type)}</div>
    <div class="node-title">${escapeHtml(node.title)}</div>
    ${node.tags ? `<div class="node-tags">#${escapeHtml(node.tags).replace(/,\s*/g, " #")}</div>` : ""}
    <div class="node-badges"></div>
  `;
  updateNodeBadges(el, node);
  makeDraggable(el, node);
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

function updateNodeBadges(el, node) {
  const counts = state.nodeCounts[String(node.id)];
  const badgesEl = el.querySelector(".node-badges");
  if (!badgesEl) return;
  if (!counts || (!counts.captures && !counts.creds && !counts.findings)) {
    badgesEl.style.display = "none";
    return;
  }
  badgesEl.style.display = "flex";
  const parts = [];
  if (counts.captures) parts.push(`<span class="node-badge">🖼 ${counts.captures}</span>`);
  if (counts.creds) parts.push(`<span class="node-badge">🔑 ${counts.creds}</span>`);
  if (counts.findings) parts.push(`<span class="node-badge">⚑ ${counts.findings}</span>`);
  badgesEl.innerHTML = parts.join("");
}

function makeDraggable(el, node) {
  let dragging = false;
  let startX, startY, origLeft, origTop;
  el._dragMoved = false;

  el.addEventListener("mousedown", (e) => {
    if (state.connectMode || e.button !== 0) return;
    dragging = true;
    el._dragMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseFloat(el.style.left);
    origTop = parseFloat(el.style.top);
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
    el.style.left = `${origLeft + dx}px`;
    el.style.top = `${origTop + dy}px`;
    renderEdges();
  });

  window.addEventListener("mouseup", async () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
    if (!el._dragMoved) return;
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    const from = { x: origLeft, y: origTop };
    const to = { x, y };
    node.x = x;
    node.y = y;
    await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(to) });
    pushHistory({
      undo: async () => {
        node.x = from.x; node.y = from.y;
        el.style.left = `${from.x}px`; el.style.top = `${from.y}px`;
        await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(from) });
        renderEdges();
      },
      redo: async () => {
        node.x = to.x; node.y = to.y;
        el.style.left = `${to.x}px`; el.style.top = `${to.y}px`;
        await api(`/api/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(to) });
        renderEdges();
      },
    });
  });
}

function renderEdges() {
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
    const padA = Math.min(a.offsetWidth / 2 + 6, dist / 2 - 2);
    const padB = Math.min(b.offsetWidth / 2 + 6, dist / 2 - 2);
    const ax = acx + ux * padA;
    const ay = acy + uy * padA;
    const bx = bcx - ux * padB;
    const by = bcy - uy * padB;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", ax);
    line.setAttribute("y1", ay);
    line.setAttribute("x2", bx);
    line.setAttribute("y2", by);
    line.setAttribute("stroke", "#4f8cff");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("opacity", "0.6");
    line.style.pointerEvents = "none";
    // Invisible, much fatter line on top - the actual click/hover target, since
    // hitting a 2px-wide diagonal line exactly with the mouse is unreasonably hard.
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.setAttribute("x1", ax);
    hit.setAttribute("y1", ay);
    hit.setAttribute("x2", bx);
    hit.setAttribute("y2", by);
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "18");
    hit.style.pointerEvents = "stroke";
    hit.style.cursor = "pointer";
    hit.addEventListener("mouseenter", () => {
      line.setAttribute("stroke", "#ff5f6d");
      line.setAttribute("stroke-width", "3");
      line.setAttribute("opacity", "0.95");
    });
    hit.addEventListener("mouseleave", () => {
      line.setAttribute("stroke", "#4f8cff");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("opacity", "0.6");
    });
    hit.addEventListener("click", async () => {
      if (confirm("Delete this connection?")) {
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
      }
    });
    group.appendChild(line);
    group.appendChild(hit);
    edgesLayer.appendChild(group);
  });
}

// ---------- connect mode ----------

$("#connect-btn").onclick = () => {
  state.connectMode = !state.connectMode;
  state.connectSource = null;
  $("#connect-btn").classList.toggle("active", state.connectMode);
  canvas.querySelectorAll(".node.selected").forEach((n) => n.classList.remove("selected"));
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
  if (action === "delete") {
    if (confirm(`Delete node "${contextNode.title}"?`)) {
      const nodeRef = { ...contextNode };
      await api(`/api/nodes/${contextNode.id}`, { method: "DELETE" });
      state.nodes = state.nodes.filter((n) => n.id !== contextNode.id);
      state.edges = state.edges.filter(
        (ed) => ed.source_id !== contextNode.id && ed.target_id !== contextNode.id
      );
      pushHistory(makeDeleteNodeAction(nodeRef));
      renderCanvas();
    }
  } else if (action === "duplicate") {
    const created = await api(`/api/boards/${state.currentBoardId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        title: `${contextNode.title} (copy)`,
        type: contextNode.type,
        color: contextNode.color,
        tags: contextNode.tags,
        content: contextNode.content,
        x: contextNode.x + 30,
        y: contextNode.y + 30,
      }),
    });
    state.nodes.push(created);
    pushHistory(makeCreateNodeAction(created));
    renderCanvas();
  }
  closeContextMenu();
});

// ---------- node modal ----------

function openNodeModal(node, defaults = {}) {
  state.editingNodeId = node ? node.id : null;
  $("#modal-title").textContent = node ? "Edit node" : "New node";
  $("#node-title").value = node ? node.title : "";
  $("#node-type").value = node ? node.type : "note";
  $("#node-color").value = node ? node.color : "#4f8cff";
  $("#node-tags").value = node ? node.tags : "";
  $("#node-content").value = node ? node.content : "";
  $("#node-delete").style.display = node ? "inline-block" : "none";
  $("#node-modal").dataset.x = node ? node.x : defaults.x;
  $("#node-modal").dataset.y = node ? node.y : defaults.y;
  $("#node-modal").dataset.origColor = node ? node.color : "#4f8cff";
  $("#node-modal").classList.remove("hidden", "minimized");
}

function closeNodeModal() {
  $("#node-modal").classList.add("hidden");
  state.editingNodeId = null;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#node-modal").classList.contains("hidden")) {
    revertLiveColor();
    closeNodeModal();
  }
});

function revertLiveColor() {
  if (!state.editingNodeId) return;
  const el = canvas.querySelector(`.node[data-id="${state.editingNodeId}"]`);
  const orig = $("#node-modal").dataset.origColor;
  if (el && orig) el.style.setProperty("--node-color", orig);
}

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

let searchTimer = null;
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (!q || !state.currentBoardId) {
      $("#search-results").innerHTML = "";
      return;
    }
    const hits = await api(
      `/api/boards/${state.currentBoardId}/search?q=${encodeURIComponent(q)}`
    );
    const el = $("#search-results");
    el.innerHTML = "";
    hits.forEach((node) => {
      const div = document.createElement("div");
      div.className = "search-hit";
      div.textContent = node.title;
      div.onclick = () => {
        const target = canvas.querySelector(`.node[data-id="${node.id}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          openNodeModal(node);
        }
      };
      el.appendChild(div);
    });
  }, 250);
});

// ---------- export / import ----------

$("#export-btn").onclick = () => {
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
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(board.name || "mapes-board").replace(/[^\w\-]+/g, "_")}.json`;
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

// ---------- view tabs (Board / Vault / Credentials / Findings / Reports) ----------

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
  else if (state.currentView === "findings") await loadFindings();
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

// ---------- Vault (file attachments) ----------

let editingCaptureId = null;

async function loadVault() {
  const items = await api(`/api/boards/${state.currentBoardId}/captures`);
  const grid = $("#vault-grid");
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = `<div class="view-empty"><span class="view-empty-icon">🖼</span>No files yet - click "+ Upload file" above to add one.</div>`;
    return;
  }
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
    `;
    card.onclick = () => openCaptureModal(cap);
    grid.appendChild(card);
  });
}

$("#vault-upload-btn").onclick = () => $("#vault-file-input").click();

$("#vault-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.currentBoardId) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api(`/api/boards/${state.currentBoardId}/captures`, {
        method: "POST",
        body: JSON.stringify({
          data: reader.result,
          orig_name: file.name,
          mime: file.type || "application/octet-stream",
        }),
      });
      await loadVault();
    } catch (err) {
      alert(`Upload error: ${err.message}`);
    }
  };
  reader.readAsDataURL(file);
});

function openCaptureModal(cap) {
  editingCaptureId = cap.id;
  const isImage = cap.mime && cap.mime.startsWith("image/");
  $("#capture-preview").innerHTML = isImage
    ? `<img src="/api/captures/${cap.id}/file">`
    : `<div class="file-icon">📄 ${escapeHtml(cap.orig_name)}</div>`;
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

// ---------- Findings ----------

let editingFindingId = null;
const SEVERITY_LABEL = { crit: "Critical", high: "High", med: "Medium", low: "Low", info: "Info" };

async function loadFindings() {
  const items = await api(`/api/boards/${state.currentBoardId}/findings`);
  const list = $("#findings-list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<div class="view-empty"><span class="view-empty-icon">⚑</span>No findings yet - click "+ Finding" above to add one.</div>`;
    return;
  }
  items.forEach((f) => {
    const card = document.createElement("div");
    card.className = `finding-card ${f.severity}`;
    card.innerHTML = `
      <span class="severity-badge ${f.severity}">${SEVERITY_LABEL[f.severity] || f.severity}</span>
      <span class="finding-title">${escapeHtml(f.title)}</span>
      <span class="finding-node">${escapeHtml(nodeTitle(f.node_id))}</span>
      <span class="status-badge ${f.status}">${escapeHtml(f.status)}</span>
    `;
    card.onclick = () => openFindingModal(f);
    list.appendChild(card);
  });
}

$("#findings-add-btn").onclick = () => openFindingModal(null);

function openFindingModal(f) {
  editingFindingId = f ? f.id : null;
  $("#finding-modal-title").textContent = f ? "Edit finding" : "New finding";
  $("#finding-title").value = f ? f.title : "";
  $("#finding-severity").value = f ? f.severity : "info";
  $("#finding-status").value = f ? f.status : "open";
  $("#finding-description").value = f ? f.description : "";
  $("#finding-impact").value = f ? f.impact : "";
  $("#finding-poc").value = f ? f.poc : "";
  $("#finding-remediation").value = f ? f.remediation : "";
  $("#finding-refs").value = f ? f.refs : "";
  populateNodeSelect($("#finding-node"), f ? f.node_id : null);
  wireNodeChip($("#finding-node"), $("#finding-node-chip"));
  $("#finding-delete").style.display = f ? "inline-block" : "none";
  $("#finding-modal").classList.remove("hidden", "minimized");
}

$("#finding-cancel").onclick = () => $("#finding-modal").classList.add("hidden");

$("#finding-save").onclick = async () => {
  const payload = {
    title: $("#finding-title").value.trim() || "Untitled",
    severity: $("#finding-severity").value,
    status: $("#finding-status").value,
    description: $("#finding-description").value,
    impact: $("#finding-impact").value,
    poc: $("#finding-poc").value,
    remediation: $("#finding-remediation").value,
    refs: $("#finding-refs").value,
    node_id: $("#finding-node").value || null,
  };
  if (editingFindingId) {
    await api(`/api/findings/${editingFindingId}`, { method: "PATCH", body: JSON.stringify(payload) });
  } else {
    await api(`/api/boards/${state.currentBoardId}/findings`, { method: "POST", body: JSON.stringify(payload) });
  }
  $("#finding-modal").classList.add("hidden");
  await loadFindings();
  await refreshNodeCounts();
};

$("#finding-delete").onclick = async () => {
  if (!editingFindingId || !confirm("Delete this finding?")) return;
  await api(`/api/findings/${editingFindingId}`, { method: "DELETE" });
  $("#finding-modal").classList.add("hidden");
  await loadFindings();
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
  }
}

async function openDoc(id) {
  currentDocId = id;
  const doc = await api(`/api/docs/${id}`);
  $("#doc-title-input").value = doc.title;
  $("#doc-body-input").value = doc.body;
  setDocEditorEnabled(true);
  renderDocPreview();
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

$("#doc-export-btn").onclick = () => {
  if (!currentDocId) return;
  const a = document.createElement("a");
  a.href = `/api/docs/${currentDocId}/export.md`;
  a.click();
};

$("#doc-delete-btn").onclick = async () => {
  if (!currentDocId || !confirm("Delete this report?")) return;
  await api(`/api/docs/${currentDocId}`, { method: "DELETE" });
  currentDocId = null;
  setDocEditorEnabled(false);
  await loadDocs();
};

function renderMarkdown(src) {
  const codeBlocks = [];
  let text = String(src ?? "").replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `${codeBlocks.length - 1}`;
  });

  const lines = text.split("\n");
  const html = [];
  let inList = false;
  let inQuote = false;

  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };
  const closeQuote = () => { if (inQuote) { html.push("</blockquote>"); inQuote = false; } };

  for (const line of lines) {
    const codeMatch = line.trim().match(/^(\d+)$/);
    if (codeMatch && codeBlocks[Number(codeMatch[1])] !== undefined) {
      closeList(); closeQuote();
      html.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const listItem = line.match(/^[-*]\s+(.*)$/);
    const quoteItem = line.match(/^>\s?(.*)$/);

    if (heading) {
      closeList(); closeQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
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
  "finding-modal": "finding-cancel",
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

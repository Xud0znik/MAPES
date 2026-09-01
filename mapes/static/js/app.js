const state = {
  boards: [],
  currentBoardId: null,
  nodes: [],
  edges: [],
  connectMode: false,
  connectSource: null,
  editingNodeId: null,
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
  $("#board-title").textContent = board ? board.name : "—";
  state.nodes = await api(`/api/boards/${boardId}/nodes`);
  state.edges = await api(`/api/boards/${boardId}/edges`);
  renderCanvas();
}

$("#new-board-btn").onclick = async () => {
  const name = prompt("Название новой карты:");
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
  if (!confirm("Удалить эту карту вместе со всеми узлами?")) return;
  await api(`/api/boards/${state.currentBoardId}`, { method: "DELETE" });
  state.boards = state.boards.filter((b) => b.id !== state.currentBoardId);
  state.currentBoardId = state.boards.length ? state.boards[0].id : null;
  renderBoardList();
  if (state.currentBoardId) await loadBoard(state.currentBoardId);
  else {
    state.nodes = [];
    state.edges = [];
    renderCanvas();
    $("#board-title").textContent = "—";
  }
};

// ---------- canvas / nodes ----------

const canvas = $("#canvas");
const edgesLayer = $("#edges-layer");

canvas.addEventListener("dblclick", async (e) => {
  if (e.target !== canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  openNodeModal(null, { x, y });
});

function renderCanvas() {
  canvas.querySelectorAll(".node").forEach((n) => n.remove());
  state.nodes.forEach((node) => canvas.appendChild(buildNodeEl(node)));
  renderEdges();
}

function buildNodeEl(node) {
  const el = document.createElement("div");
  el.className = "node";
  el.dataset.id = node.id;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.borderLeftColor = node.color || "#4f8cff";
  el.innerHTML = `
    <div class="node-type">${escapeHtml(node.type)}</div>
    <div class="node-title">${escapeHtml(node.title)}</div>
    ${node.tags ? `<div class="node-tags">#${escapeHtml(node.tags).replace(/,\s*/g, " #")}</div>` : ""}
  `;
  makeDraggable(el, node);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.connectMode) {
      handleConnectClick(node.id, el);
    } else {
      openNodeModal(node);
    }
  });
  return el;
}

function makeDraggable(el, node) {
  let dragging = false;
  let startX, startY, origLeft, origTop;

  el.addEventListener("mousedown", (e) => {
    if (state.connectMode) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseFloat(el.style.left);
    origTop = parseFloat(el.style.top);
    el.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.left = `${origLeft + dx}px`;
    el.style.top = `${origTop + dy}px`;
    renderEdges();
  });

  window.addEventListener("mouseup", async () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    node.x = x;
    node.y = y;
    await api(`/api/nodes/${node.id}`, {
      method: "PUT",
      body: JSON.stringify({ x, y }),
    });
  });
}

function renderEdges() {
  edgesLayer.innerHTML = "";
  state.edges.forEach((edge) => {
    const a = canvas.querySelector(`.node[data-id="${edge.source_id}"]`);
    const b = canvas.querySelector(`.node[data-id="${edge.target_id}"]`);
    if (!a || !b) return;
    const ax = parseFloat(a.style.left) + a.offsetWidth / 2;
    const ay = parseFloat(a.style.top) + a.offsetHeight / 2;
    const bx = parseFloat(b.style.left) + b.offsetWidth / 2;
    const by = parseFloat(b.style.top) + b.offsetHeight / 2;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", ax);
    line.setAttribute("y1", ay);
    line.setAttribute("x2", bx);
    line.setAttribute("y2", by);
    line.setAttribute("stroke", "#4f8cff");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("opacity", "0.6");
    line.style.pointerEvents = "stroke";
    line.style.cursor = "pointer";
    line.addEventListener("click", async () => {
      if (confirm("Удалить связь?")) {
        await api(`/api/edges/${edge.id}`, { method: "DELETE" });
        state.edges = state.edges.filter((x) => x.id !== edge.id);
        renderEdges();
      }
    });
    edgesLayer.appendChild(line);
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
  }
}

// ---------- node modal ----------

function openNodeModal(node, defaults = {}) {
  state.editingNodeId = node ? node.id : null;
  $("#modal-title").textContent = node ? "Редактировать узел" : "Новый узел";
  $("#node-title").value = node ? node.title : "";
  $("#node-type").value = node ? node.type : "note";
  $("#node-color").value = node ? node.color : "#4f8cff";
  $("#node-tags").value = node ? node.tags : "";
  $("#node-content").value = node ? node.content : "";
  $("#node-delete").style.display = node ? "inline-block" : "none";
  $("#node-modal").dataset.x = node ? node.x : defaults.x;
  $("#node-modal").dataset.y = node ? node.y : defaults.y;
  $("#node-modal").classList.remove("hidden");
}

function closeNodeModal() {
  $("#node-modal").classList.add("hidden");
  state.editingNodeId = null;
}

$("#node-cancel").onclick = closeNodeModal;

$("#node-save").onclick = async () => {
  const payload = {
    title: $("#node-title").value.trim() || "Без названия",
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
  }
  closeNodeModal();
  renderCanvas();
};

$("#node-delete").onclick = async () => {
  if (!state.editingNodeId) return;
  if (!confirm("Удалить узел вместе со связями?")) return;
  await api(`/api/nodes/${state.editingNodeId}`, { method: "DELETE" });
  state.nodes = state.nodes.filter((n) => n.id !== state.editingNodeId);
  state.edges = state.edges.filter(
    (e) => e.source_id !== state.editingNodeId && e.target_id !== state.editingNodeId
  );
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

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

loadBoards();

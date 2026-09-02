"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}
const icon = (id, cls = "ic") => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", cls);
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#" + id);
  s.append(u);
  return s;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - Number(ts));
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(Number(ts) * 1000).toLocaleString([], {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function human(n) {
  n = Number(n || 0);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

async function api(method, path, body) {
  const opt = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let url = path;
  if (path.startsWith("/api") && !path.includes("project_id")) {
    url += (path.includes("?") ? "&" : "?") + "project_id=" + state.pid;
  }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && !path.startsWith("/api/login")) {
    showLogin("Your session expired. Sign in again.");
    throw new Error(data.error || "authentication required");
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, kind = "") {
  const t = h("div", { class: "toast " + kind }, msg);
  $("#toast").append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".3s"; setTimeout(() => t.remove(), 300); }, 2600);
}

const NODE_TYPES = [
  { t: "server", label: "Server" }, { t: "pc", label: "PC / Workstation" },
  { t: "dc", label: "Domain controller" }, { t: "router", label: "Router / Switch" },
  { t: "firewall", label: "Firewall" }, { t: "cloud", label: "Cloud / Internet" },
  { t: "container", label: "Container" }, { t: "phone", label: "Mobile / IoT" },
  { t: "web", label: "Web" }, { t: "db", label: "Database" },
  { t: "ssh", label: "SSH / Terminal" }, { t: "mail", label: "Mail" },
  { t: "dns", label: "Domain / DNS" }, { t: "share", label: "Share" },
  { t: "service", label: "Service / App" },
  { t: "user", label: "User" }, { t: "cred", label: "Credential" },
  { t: "note", label: "Note" }, { t: "generic", label: "Generic" },
];
const NODE_LABEL = Object.fromEntries(NODE_TYPES.map((x) => [x.t, x.label]));

const TYPE_GROUPS = [
  { g: "Infrastructure", ts: ["server", "pc", "dc", "router", "firewall", "cloud", "container", "phone"] },
  { g: "Services", ts: ["web", "db", "ssh", "mail", "dns", "share", "service"] },
  { g: "Identity", ts: ["user", "cred"] },
  { g: "Other", ts: ["note", "generic"] },
];
const STATUSES = [
  { s: "unknown", label: "Unknown", c: "#8a95a5" }, { s: "discovered", label: "Discovered", c: "#3b9eff" },
  { s: "interesting", label: "Interesting", c: "#f59e0b" }, { s: "pwned", label: "Pwned", c: "#f5334f" },
  { s: "highvalue", label: "High value", c: "#a56bff" }, { s: "cleared", label: "Nothing to do", c: "#5f8a6a" },
  { s: "dead", label: "Dead / offline", c: "#6b7280" },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((x) => [x.s, x.label.toUpperCase()]));
STATUS_LABEL.unknown = "";
const NODE_FIELDS = ["ip", "hostname", "os", "domain"];
const EDGE_TYPES = ["", "network", "ssh", "rdp", "smb", "http", "https", "winrm", "ldap",
  "kerberos", "database", "email", "credential-reuse", "trust", "admin", "user", "custom",

  "MemberOf", "AdminTo", "HasSession", "CanRDP", "CanPSRemote", "ExecuteDCOM",
  "GenericAll", "GenericWrite", "WriteDacl", "WriteOwner", "Owns", "AddMember",
  "ForceChangePassword", "AllowedToDelegate", "AllowedToAct", "AddAllowedToAct",
  "ReadLAPSPassword", "ReadGMSAPassword", "DCSync", "SyncLAPSPassword", "Contains"];

const AD_ABUSE_EDGES = new Set(["GenericAll", "GenericWrite", "WriteDacl", "WriteOwner", "Owns",
  "AddMember", "ForceChangePassword", "AllowedToDelegate", "AllowedToAct", "AddAllowedToAct",
  "ReadLAPSPassword", "ReadGMSAPassword", "DCSync", "AdminTo"]);

const AD_FLAGS = [
  ["da", "Domain Admin", "i-crown", "#eab308"],
  ["kerberoastable", "Kerberoastable", "i-ticket", "#f2851f"],
  ["asrep", "AS-REP roastable", "i-unlock", "#f5334f"],
  ["unconstrained", "Unconstrained deleg.", "i-key", "#3b9eff"],
  ["highvalue_ad", "High value (AD)", "i-star", "#a56bff"]];
const NODE_SVG = { pc: "i-monitor", server: "i-server", web: "i-globe", mail: "i-mail",
  ssh: "i-terminal", db: "i-database", dns: "i-globe", cloud: "i-cloud", user: "i-user",
  cred: "i-key", share: "i-folder", dc: "i-building", firewall: "i-firewall", router: "i-router",
  phone: "i-phone", service: "i-gear", container: "i-box", note: "i-note", generic: "i-hex" };

const TYPE_COLOR = {
  pc: "#3b9eff", server: "#f2851f", web: "#22c55e", mail: "#d9a520", ssh: "#14b8a6",
  db: "#eab308", dns: "#65a30d", cloud: "#78889a", user: "#a56bff", cred: "#2f8fef",
  share: "#c98a1e", dc: "#ec4899", firewall: "#ef4444", router: "#4f6ef2", phone: "#9d5cf0",
  service: "#7f8a97", container: "#0fb8a6", note: "#e0b83b", generic: "#7f8a97",
};

const STATUS_COLOR = { pwned: "#f5334f", interesting: "#f59e0b", highvalue: "#a56bff", dead: "#6b7280", cleared: "#5f8a6a" };
function typeColor(n) { return (n && n.color) || TYPE_COLOR[n.type] || "#7f8a97"; }
function nodeColor(n) { return STATUS_COLOR[n.status] || typeColor(n); }
function nodeSub(n) { return (n.props && (n.props.ip || n.props.hostname || n.props.domain)) || ""; }
function statusText(n) {
  if (n.status && n.status !== "unknown") return STATUS_LABEL[n.status] || n.status.toUpperCase();
  if (n.type === "cred") return "CREDENTIAL";
  if (n.type === "user") return "USER";
  return "";
}
function nodeIcon(n, cls) {
  const i = icon(NODE_SVG[n.type] || "i-hex", cls || "ic");
  i.style.color = typeColor(n);
  return i;
}

const state = { pid: null, view: "over", curNode: null, filter: "", drawing: [],
  mode: "move", penColor: "#f5334f", penWidth: 3, selSet: new Set(),
  selEdge: null, clipboard: null, authOn: false, user: "", vault: false, crypto: "" };

$$(".navb[data-v]").forEach((b) => {
  b.title = b.textContent.trim();
  b.addEventListener("click", () => switchView(b.dataset.v));
});

function switchView(v, arg) {
  state.view = v;
  $$(".navb[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
  const sb = $("#statusbar"); if (sb) sb.hidden = v !== "board";
  if (v === "over") renderOverview();
  else if (v === "nodes") arg ? renderNodeDetail(arg) : renderNodes();
  else if (v === "board") renderBoard(arg);
  else if (v === "vault") renderVault(arg);
  else if (v === "loot") renderLoot();
  else if (v === "findings") renderFindings();
  else if (v === "docs") renderDocs(arg);
  else if (v === "settings") renderSettings();
}

async function loadProjects() {
  state.projects = await api("GET", "/api/projects");
  if (!state.pid || !state.projects.find((p) => p.id === state.pid)) state.pid = state.projects[0]?.id;
  paintProjectBtn();
}
function paintProjectBtn() {
  const cur = (state.projects || []).find((p) => p.id === state.pid);
  const el = $("#project-name");
  if (el) el.textContent = cur ? cur.name : "—";
}
function selectProject(id) {
  if (id === state.pid) return;
  state.pid = id;
  state.curNode = null;
  state.filter = ""; state.nodeQ = ""; state.vaultQ = ""; state.vaultNode = "";
  paintProjectBtn();
  switchView(state.view);
}
function closeProjectMenu() {
  const m = $(".proj-menu"); if (m) m.remove();
  const b = $("#project-btn"); if (b) b.setAttribute("aria-expanded", "false");
}
function openProjectMenu() {
  const btn = $("#project-btn"), host = $("#proj-switch");
  if (!btn || !host) return;
  const menu = h("div", { class: "proj-menu", role: "listbox" },
    h("div", { class: "proj-menu-h" }, "Switch project"));
  (state.projects || []).forEach((p) => {
    const on = p.id === state.pid;
    const row = h("button", { class: "proj-item" + (on ? " on" : ""), type: "button", role: "option",
      "aria-selected": on ? "true" : "false",
      onclick: () => { closeProjectMenu(); selectProject(p.id); } },
      icon("i-folder"), h("span", { class: "proj-item-n" }, p.name),
      on ? icon("i-check", "proj-check") : null);
    menu.append(row);
  });
  menu.append(h("div", { class: "proj-sep" }),
    h("button", { class: "proj-item", type: "button",
      onclick: () => { closeProjectMenu(); newProjectModal(); } },
      icon("i-plus"), h("span", { class: "proj-item-n" }, "New project…")));
  host.append(menu);
  btn.setAttribute("aria-expanded", "true");

  const items = () => $$(".proj-item", menu);
  let idx = Math.max(0, (state.projects || []).findIndex((p) => p.id === state.pid));
  const focusAt = (i) => {
    const list = items();
    idx = (i + list.length) % list.length;
    list.forEach((el, k) => el.classList.toggle("active", k === idx));
    list[idx].focus();
  };
  focusAt(idx);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(idx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(idx - 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeProjectMenu(); btn.focus(); }
  });
}
function toggleProjectMenu() {
  if ($(".proj-menu")) { closeProjectMenu(); return; }
  openProjectMenu();
}
$("#project-btn") && $("#project-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleProjectMenu(); });
document.addEventListener("pointerdown", (e) => {
  if ($(".proj-menu") && !e.target.closest("#proj-switch")) closeProjectMenu();
});
$("#btn-help") && $("#btn-help").addEventListener("click", showHelp);

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("atlas-theme", t); } catch (_) {}
  const b = $("#btn-theme");
  if (b) { b.innerHTML = ""; b.append(icon(t === "light" ? "i-moon" : "i-sun")); b.title = t === "light" ? "Switch to dark" : "Switch to light"; }
}
function toggleTheme() { applyTheme((document.documentElement.getAttribute("data-theme") || "dark") === "light" ? "dark" : "light"); }
$("#btn-theme") && $("#btn-theme").addEventListener("click", toggleTheme);
(function initTheme() { let t = "dark"; try { t = localStorage.getItem("atlas-theme") || "dark"; } catch (_) {} applyTheme(t); })();
const WIC_KEY = "atlas-wic";
function wicOn() { try { return localStorage.getItem(WIC_KEY) === "1"; } catch (_) { return false; } }
function wicApply() {
  const b = $("#btn-wic");
  if (b) b.hidden = !wicOn();
}
function wicSet(on) {
  try { localStorage.setItem(WIC_KEY, on ? "1" : "0"); } catch (_) {}
  wicApply();
}
$("#btn-wic") && $("#btn-wic").addEventListener("click", () => openWhileItCracks());
wicApply();

function toggleFullscreen() { if (!document.fullscreenElement) { (document.documentElement.requestFullscreen || (() => {})).call(document.documentElement); } else { (document.exitFullscreen || (() => {})).call(document); } }
function showHelp() {
  const rows = [
    ["New node", "pick the type (server, database, web, user...)"],
    ["Drag from the palette", "create a node on the canvas"],
    ["Click a node", "select it and open its properties"],
    ["Double-click a node", "open its full record"],
    ["Node handle / Arrow tool", "create a connection"],
    ["Click a connection", "select it, then edit its type, label or direction"],
    ["Double-click a connection", "edit it in a dialog"],
    ["Drag images onto the canvas", "upload them to the vault (dropped on a node, they get assigned to it)"],
    ["Ctrl+V in Vault or a record", "paste a capture from the clipboard"],
    ["Ctrl+C / Ctrl+V", "copy and paste the selected nodes (with the connections between them)"],
    ["Delete / Backspace", "delete the selected node or connection"],
    ["Ctrl+D", "duplicate node"],
    ["Ctrl+Z / Ctrl+Shift+Z", "undo / redo"],
    ["Wheel", "zoom · Space or Hand + drag: pan"],
  ];
  openModalEl("Keyboard shortcuts",
    h("div", {}, ...rows.map((r) => h("div", { class: "kv" }, h("span", { class: "kv-l", style: "width:auto;flex:1" }, r[0]), h("span", { class: "sub" }, r[1])))),
    null, null,
    h("div", { class: "modal-actions" }, h("button", { class: "btn pri", onclick: closeModal }, "Close")));
}
function newProjectModal() {
  openModal("New project", [field("name", "Name", "client / domain / engagement")], async (v) => {
    const p = await api("POST", "/api/projects", { name: v.name || "Audit" });
    state.pid = p.id;
    state.curNode = null;
    await loadProjects();
    switchView("over");
    toast("Project created", "ok");
  });
}
$("#new-project").addEventListener("click", newProjectModal);

function metricsRow(items) {
  return h("div", { class: "metrics" }, items.map(([lab, val, cls]) =>
    h("div", { class: "mc" }, h("div", { class: "lab" }, lab),
      h("div", { class: "val " + (cls || "") }, String(val)))));
}
function card(ic, title, ...extra) {
  const head = h("div", { class: "card-h" }, ic, title, ...extra);
  return h("div", { class: "card" }, head);
}
function headBar(crumb, title, ...actions) {
  return h("div", { class: "head" },
    h("div", {}, h("div", { class: "crumb" }, crumb), h("h1", {}, title)),
    h("div", { class: "head-actions" }, ...actions));
}
function countChip(ic, n, title) {
  if (!n) return null;
  return h("span", { class: "cchip", title }, icon(ic), String(n));
}
function nodeRow(n, onclick) {
  const c = n.counts || {};
  return h("div", { class: "row click", onclick },
    h("span", { class: "dot", style: "background:" + nodeColor(n) }),
    nodeIcon(n, "ic tic"),
    h("span", { class: "grow" }, n.name || NODE_LABEL[n.type] || "node",
      nodeSub(n) ? h("span", { class: "sub mono" }, "  " + nodeSub(n)) : ""),
    h("span", { class: "cchips" },
      countChip("i-image", c.captures, "captures"), countChip("i-server", c.services, "ports"),
      countChip("i-users", c.users, "users"), countChip("i-key", c.creds, "credentials"),
      countChip("i-flag", c.findings, "findings")),
    h("span", { class: "tag-type" }, NODE_LABEL[n.type] || n.type),
    statusText(n) ? h("span", { class: "pill " + n.status }, STATUS_LABEL[n.status] || n.status) : "");
}
const SEV_LABEL = { info: "Informational", low: "Low", med: "Medium", high: "High", crit: "Critical" };
const FIND_STATUS = [["open", "Open"], ["confirmed", "Confirmed"], ["remediated", "Remediated"],
  ["accepted", "Risk accepted"], ["retest", "Pending retest"]];
const FIND_STATUS_LABEL = Object.fromEntries(FIND_STATUS);
function stepRow(s, reload) {
  return h("div", { class: "row click", onclick: () => openFinding(s.id, { reload }) },
    s.code ? h("span", { class: "find-code mono" }, s.code) : icon("i-arrow"),
    h("span", { class: "grow" }, s.title,
      s.node_name ? h("span", { class: "sub" }, "  " + s.node_name) : ""),
    s.cvss_score != null ? h("span", { class: "sub mono" }, s.cvss_score.toFixed(1)) : "",
    h("span", { class: "pill " + s.severity }, SEV_LABEL[s.severity] || s.severity),
    h("button", { class: "btn ghost sm", title: "mark remediated", onclick: async (e) => {
      e.stopPropagation(); await api("PATCH", "/api/findings/" + s.id, { status: "remediated" }); reload();
    } }, icon("i-check")),
    h("button", { class: "btn ghost sm", title: "delete", onclick: async (e) => {
      e.stopPropagation(); await api("DELETE", "/api/findings/" + s.id); reload();
    } }, icon("i-trash")));
}

async function renderOverview() {
  const root = $("#v-over");
  root.innerHTML = "";
  const d = await api("GET", "/api/overview");

  root.append(
    headBar("project", d.project.name,
      h("button", { class: "btn", onclick: () => switchView("vault") }, icon("i-upload"), "Upload capture"),
      h("button", { class: "btn pri", onclick: () => newNodeModal() }, icon("i-plus"), "New node")),
    metricsRow([
      ["Nodes", d.metrics.nodes], ["Pwned", d.metrics.pwned, "acc"],
      ["Ports", d.metrics.open_ports], ["Users", d.metrics.users],
      ["Credentials", d.metrics.creds], ["Captures", d.metrics.captures]]),
  );

  const hc = card(icon("i-layers"), "Nodes",
    h("button", { class: "btn ghost sm", style: "margin-left:auto", onclick: () => switchView("nodes") }, "see all →"));
  if (!d.nodes.length) hc.append(h("div", { class: "empty" },
    "No nodes yet. Hit \u00abNew node\u00bb and pick a type: server, database, web, user\u2026"));
  d.nodes.slice(0, 12).forEach((n) => hc.append(nodeRow(n, () => switchView("nodes", n.id))));
  root.append(hc);

  if (d.captures && d.captures.length) {
    const cc = card(icon("i-vault"), "Latest captures",
      h("button", { class: "btn ghost sm", style: "margin-left:auto", onclick: () => switchView("vault") }, "see vault →"));
    const strip = h("div", { class: "capstrip" });
    d.captures.forEach((c) => strip.append(
      h("div", { class: "capthumb", title: c.name, onclick: () => switchView("vault", c.id) },
        h("img", { src: "/api/captures/" + c.id + "/file", alt: c.name, loading: "lazy" }),
        h("span", { class: "capthumb-lbl" }, c.name))));
    cc.append(strip);
    root.append(cc);
  }

  const sc = card(icon("i-flag"), "Next steps",
    h("button", { class: "btn ghost sm", style: "margin-left:auto", onclick: () => openFinding(null, { reload: renderOverview }) }, icon("i-plus"), "finding"));
  if (!d.steps.length) sc.append(h("div", { class: "empty" },
    "No open findings. Whatever you add here or on a node record can be dropped into the report."));
  d.steps.forEach((s) => sc.append(stepRow(s, renderOverview)));
  root.append(sc);
}

async function renderNodes() {
  const root = $("#v-nodes");
  root.innerHTML = "";
  state.curNode = null;
  const nodes = await api("GET", "/api/nodes");

  const search = h("input", { class: "search", placeholder: "filter nodes...", value: state.nodeQ || "" });
  const listWrap = h("div", {});
  const draw = () => {
    const q = (search.value || "").toLowerCase();
    state.nodeQ = search.value;
    listWrap.innerHTML = "";
    const shown = nodes.filter((n) => !q ||
      ((n.name || "") + " " + (n.type || "") + " " + NODE_LABEL[n.type] + " " + JSON.stringify(n.props || {}))
        .toLowerCase().includes(q));
    TYPE_GROUPS.forEach((grp) => {
      const inGroup = shown.filter((n) => grp.ts.includes(n.type));
      if (!inGroup.length) return;
      const c = card(icon("i-layers"), grp.g,
        h("span", { class: "sub", style: "margin-left:auto" }, plural(inGroup.length, "node", "nodes")));
      inGroup.forEach((n) => c.append(nodeRow(n, () => renderNodeDetail(n.id))));
      listWrap.append(c);
    });
    const rest = shown.filter((n) => !TYPE_GROUPS.some((g) => g.ts.includes(n.type)));
    if (rest.length) {
      const c = card(icon("i-hex"), "Other types");
      rest.forEach((n) => c.append(nodeRow(n, () => renderNodeDetail(n.id))));
      listWrap.append(c);
    }
    if (!shown.length) {
      const c = card(icon("i-layers"), "Nodes");
      c.append(h("div", { class: "empty" }, nodes.length
        ? "No node matches the filter."
        : "No nodes. Hit \u00abNew node\u00bb and pick a type (server, database, web, user\u2026)."));
      listWrap.append(c);
    }
  };
  search.oninput = draw;

  root.append(
    headBar("inventory", "Nodes",
      h("div", { class: "searchbox" }, icon("i-search"), search),
      h("button", { class: "btn", onclick: () => switchView("board") }, icon("i-board"), "Open board"),
      h("button", { class: "btn pri", onclick: () => newNodeModal() }, icon("i-plus"), "New node")),
    listWrap);
  draw();
}

function newNodeModal(pre) {
  pre = pre || {};
  let chosen = pre.type || "server";
  const nameIn = h("input", { class: "big-name", placeholder: "SQL01 / DC01 / portal.cliente.com", value: pre.name || "" });
  const ipIn = h("input", { placeholder: "10.10.10.5 (optional)" });
  const statusSel = h("select", {}, ...STATUSES.map((s) => h("option", { value: s.s, selected: s.s === (pre.status || "discovered") }, s.label)));

  const grid = h("div", { class: "typegrid" });
  const paint = () => $$(".tcard", grid).forEach((c) => c.classList.toggle("on", c.dataset.t === chosen));
  TYPE_GROUPS.forEach((grp) => {
    grid.append(h("div", { class: "tgrp-h" }, grp.g));
    const row = h("div", { class: "tgrp" });
    grp.ts.forEach((t) => {
      const meta = NODE_TYPES.find((x) => x.t === t);
      if (!meta) return;
      const ic = icon(NODE_SVG[t] || "i-hex", "tcard-ic");
      ic.style.color = TYPE_COLOR[t] || "#7f8a97";
      const c = h("button", { class: "tcard", "data-t": t, type: "button",
        onclick: () => { chosen = t; paint(); nameIn.focus(); },
        ondblclick: () => submit() }, ic, h("span", {}, meta.label));
      row.append(c);
    });
    grid.append(row);
  });
  paint();

  async function submit() {
    const props = {};
    if (ipIn.value.trim()) props.ip = ipIn.value.trim();
    const n = await api("POST", "/api/nodes", {
      project_id: state.pid, type: chosen, status: statusSel.value,
      name: nameIn.value.trim() || NODE_LABEL[chosen], props });
    closeModal();
    toast("Node \u00ab" + n.name + "\u00bb created", "ok");
    if (state.view === "board" && state._reloadNodes) { await state._reloadNodes(); selectNode(state.nodesById[n.id]); }
    else switchView("nodes", n.id);
  }

  openModalEl("New node",
    h("div", { class: "editor" },
      h("div", { class: "field" }, h("label", {}, "Node type"), grid),
      h("div", { class: "field" }, h("label", {}, "Name"), nameIn),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", {}, "IP / host"), ipIn),
        h("div", { class: "field" }, h("label", {}, "Status"), statusSel))),
    submit, "Create node");
  setTimeout(() => nameIn.focus(), 50);
}

async function renderNodeDetail(nid) {
  switchViewTabs("nodes");
  const root = $("#v-nodes");
  const n = await api("GET", "/api/nodes/" + nid + "/detail");
  state.curNode = n;
  n.props = n.props || {};
  root.innerHTML = "";

  const nameIn = h("input", { class: "big-name", value: n.name || "" });
  nameIn.addEventListener("change", async () => {
    await api("PATCH", "/api/nodes/" + nid, { name: nameIn.value.trim() }); toast("Saved", "ok");
  });
  const typeSel = h("select", { class: "mini" }, ...NODE_TYPES.map((x) => h("option", { value: x.t, selected: x.t === n.type }, x.label)));
  typeSel.onchange = async () => { await api("PATCH", "/api/nodes/" + nid, { type: typeSel.value }); renderNodeDetail(nid); };
  const statusSel = h("select", { class: "mini" }, ...STATUSES.map((x) => h("option", { value: x.s, selected: x.s === n.status }, x.label)));
  statusSel.onchange = async () => { await api("PATCH", "/api/nodes/" + nid, { status: statusSel.value }); renderNodeDetail(nid); };

  root.append(h("div", { class: "head" },
    h("div", { class: "nd-id" },
      h("button", { class: "btn ghost sm", onclick: () => renderNodes() }, "\u2190 nodes"),
      h("div", { class: "nd-badge", style: "border-color:" + nodeColor(n) }, nodeIcon(n, "nd-badge-ic")),
      h("div", { class: "grow" }, nameIn,
        h("div", { class: "nd-meta" },
          h("span", { class: "pill " + n.status }, STATUS_LABEL[n.status] || n.status || "unknown"),
          nodeSub(n) ? h("span", { class: "mono sub" }, nodeSub(n)) : "",
          h("span", { class: "sub" }, "created " + fmtDate(n.created_at))))),
    h("div", { class: "head-actions" },
      typeSel, statusSel,
      h("button", { class: "btn", onclick: () => switchView("board", n.id) }, icon("i-board"), "On the board"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm("Delete node \u00ab" + (n.name || "") + "\u00bb and everything hanging off it?")) return;
        await api("DELETE", "/api/nodes/" + nid); toast("Node deleted", "ok"); renderNodes();
      } }, icon("i-trash")))));

  const legacy = ["users", "ports", "credentials", "services", "notes"]
    .filter((k) => Array.isArray(n.props[k]) && n.props[k].length);
  if (legacy.length) {
    const c = card(icon("i-refresh"), "Legacy lists on this node");
    c.append(h("div", { class: "row" },
      h("span", { class: "grow sub" },
        "This node stores " + legacy.join(", ") + " as free text from an older version. " +
        "They can be converted into real ports, users, credentials and notes."),
      h("button", { class: "btn pri", onclick: async () => {
        const r = await api("POST", "/api/nodes/" + nid + "/migrate_props", {});
        toast("Converted " + r.moved + " items", "ok"); renderNodeDetail(nid);
      } }, icon("i-check"), "Convert")));
    root.append(c);
  }

  const tabs = [
    ["General", "i-gear", () => ndGeneral(n)],
    ["Ports", "i-server", () => ndServices(n)],
    ["Users", "i-users", () => ndUsers(n)],
    ["Credentials", "i-key", () => ndCreds(n)],
    ["Captures", "i-image", () => ndCaptures(n)],
    ["Findings", "i-flag", () => ndFindings(n)],
    ["Log", "i-clock", () => ndLog(n)],
    ["Relationships", "i-link", () => ndLinks(n)],
  ];
  const counts = { Ports: n.services.length, Users: n.users.length, Credentials: n.creds.length,
    Captures: n.captures.length, Findings: n.findings.length, Log: n.log.length, Relationships: n.links.length };
  if (!tabs.some((t) => t[0] === state.ndTab)) state.ndTab = "General";
  const bar = h("div", { class: "ndtabs" });
  const body = h("div", { class: "ndbody" });
  tabs.forEach(([label, ic, build]) => {
    const b = h("button", { class: "ndtab" + (label === state.ndTab ? " on" : ""), "data-tab": label, onclick: () => {
      state.ndTab = label;
      $$(".ndtab", bar).forEach((x) => x.classList.toggle("on", x.dataset.tab === label));
      body.innerHTML = ""; body.append(build());
    } }, icon(ic), label, counts[label] ? h("span", { class: "ndtab-n" }, String(counts[label])) : "");
    bar.append(b);
  });
  root.append(bar, body);
  body.append((tabs.find((t) => t[0] === state.ndTab) || tabs[0])[2]());
}

function switchViewTabs(v) {
  state.view = v;
  $$(".navb[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
  const sb = $("#statusbar"); if (sb) sb.hidden = true;
}
const reNode = () => renderNodeDetail(state.curNode.id);

function ndGeneral(n) {
  const wrap = h("div", {});
  const c = card(icon("i-gear"), "Identity");
  NODE_FIELDS.forEach((k) => {
    const inp = h("input", { class: "kv-in", value: n.props[k] || "", placeholder: "—" });
    inp.addEventListener("change", async () => {
      n.props[k] = inp.value.trim();
      await api("PATCH", "/api/nodes/" + n.id, { props: n.props }); toast("Saved", "ok");
    });
    c.append(h("div", { class: "row" }, h("span", { class: "kv-l" }, k.charAt(0).toUpperCase() + k.slice(1)), inp));
  });
  wrap.append(c);

  const cad = card(icon("i-key"), "Active Directory");
  cad.append(adFlagsRow(n, () => refreshNodeEls(n)));
  wrap.append(cad);

  const c2 = card(icon("i-note"), "Description");
  const ta = h("textarea", { class: "nd-ta", placeholder: "what this node is for, how you got in, what is still pending..." },
    n.props.text || "");
  let t;
  ta.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => { n.props.text = ta.value; await api("PATCH", "/api/nodes/" + n.id, { props: n.props }); }, 500);
  });
  c2.append(h("div", { style: "padding:4px 12px 12px" }, ta));
  wrap.append(c2);
  return wrap;
}

function adFlagsRow(n, after) {
  n.props.ad = Array.isArray(n.props.ad) ? n.props.ad : [];
  const wrap = h("div", { class: "adflags" });
  AD_FLAGS.forEach(([key, label, ic, color]) => {
    const cb = h("input", { type: "checkbox" });
    cb.checked = n.props.ad.includes(key);
    cb.onchange = async () => {
      n.props.ad = AD_FLAGS.map((f) => f[0]).filter((k) => k === key ? cb.checked : n.props.ad.includes(k));
      await api("PATCH", "/api/nodes/" + n.id, { props: n.props });
      if (after) after();
    };
    const pic = icon(ic, "adflag-ic");
    pic.style.color = color;
    wrap.append(h("label", { class: "adflag" }, cb, pic, h("span", {}, label)));
  });
  return wrap;
}

function refreshNodeEls(n) {
  if (state.nodesById && state.nodesById[n.id]) {
    state.nodesById[n.id].props = n.props;
    if (state.nodesById[n.id]._el) refreshNode(state.nodesById[n.id]);
  }
}

function ndServices(n) {
  const c = h("div", { class: "card" });
  const tbl = h("table", { class: "t" },
    h("thead", {}, h("tr", {}, ["Port", "Service", "Product / version", "State", "Notes", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  if (!n.services.length) tb.append(h("tr", {}, h("td", { colspan: 6, class: "empty" }, "No ports. Add them as you discover them.")));
  n.services.forEach((s) => {
    const stSel = h("select", { class: "mini" }, ...["open", "closed", "filtered"].map((x) =>
      h("option", { value: x, selected: x === s.state }, x)));
    stSel.onchange = () => api("PATCH", "/api/node_services/" + s.id, { state: stSel.value }).then(() => toast("Saved", "ok"));
    tb.append(h("tr", {},
      h("td", { class: "mono" }, s.port + "/" + s.proto),
      h("td", {}, s.name || "—"),
      h("td", { class: "sub" }, [s.product, s.version].filter(Boolean).join(" ") || "—"),
      h("td", {}, stSel),
      h("td", { class: "sub" }, s.notes || ""),
      h("td", { style: "text-align:right" }, h("button", { class: "btn ghost sm", onclick: async () => {
        await api("DELETE", "/api/node_services/" + s.id); reNode();
      } }, icon("i-trash")))));
  });
  tbl.append(tb);
  c.append(h("div", { class: "card-h" }, icon("i-server"), "Ports and services",
    h("button", { class: "btn pri sm", style: "margin-left:auto", onclick: () => addServiceModal(n) }, icon("i-plus"), "Add port")),
    tbl);
  return c;
}
function addServiceModal(n) {
  openModal("Add port", [
    field("port", "Port", "445"),
    selectField("proto", "Protocol", ["tcp", "udp"], "tcp").el,
    field("name", "Service", "smb"),
    field("product", "Product (optional)", "Samba"),
    field("version", "Version (optional)", "4.17"),
    field("notes", "Notes (optional)", ""),
  ], async (v) => {
    if (!v.port) return toast("Port is missing", "err");
    await api("POST", "/api/node_services", { node_id: n.id, ...v });
    closeModal(); reNode();
  });
}

function ndUsers(n) {
  const c = h("div", { class: "card" });
  const tbl = h("table", { class: "t" },
    h("thead", {}, h("tr", {}, ["User", "Domain", "Kind", "Privilege", "Status", "Notes", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  if (!n.users.length) tb.append(h("tr", {}, h("td", { colspan: 7, class: "empty" }, "No users. Add them as you enumerate.")));
  n.users.forEach((u) => {
    const stSel = h("select", { class: "mini" }, ...["found", "valid", "pwned", "invalid"].map((x) =>
      h("option", { value: x, selected: x === u.status }, x)));
    stSel.onchange = () => api("PATCH", "/api/node_users/" + u.id, { status: stSel.value }).then(() => toast("Saved", "ok"));
    tb.append(h("tr", {},
      h("td", { class: "mono" }, u.username || "—"),
      h("td", { class: "mono sub" }, u.domain || ""),
      h("td", {}, h("span", { class: "pill info" }, u.kind)),
      h("td", {}, h("span", { class: "pill " + (u.privilege === "user" ? "low" : "high") }, u.privilege)),
      h("td", {}, stSel),
      h("td", { class: "sub" }, u.notes || ""),
      h("td", { style: "text-align:right" }, h("button", { class: "btn ghost sm", onclick: async () => {
        await api("DELETE", "/api/node_users/" + u.id); reNode();
      } }, icon("i-trash")))));
  });
  tbl.append(tb);
  c.append(h("div", { class: "card-h" }, icon("i-users"), "Users on this node",
    h("button", { class: "btn pri sm", style: "margin-left:auto", onclick: () => addUserModal(n) }, icon("i-plus"), "Add user")),
    tbl);
  return c;
}
function addUserModal(n) {
  openModal("Add user", [
    field("username", "User", "svc_backup"),
    field("domain", "Domain (optional)", "CLIENT"),
    selectField("kind", "Kind", ["local", "domain", "service", "app"], "local").el,
    selectField("privilege", "Privilege", ["user", "admin", "domain-admin", "system"], "user").el,
    selectField("status", "Status", ["found", "valid", "pwned", "invalid"], "found").el,
    field("notes", "Notes (optional)", ""),
  ], async (v) => {
    if (!v.username) return toast("User is missing", "err");
    await api("POST", "/api/node_users", { node_id: n.id, ...v });
    closeModal(); reNode();
  });
}

function ndCreds(n) {
  const c = h("div", { class: "card" });
  const tbl = h("table", { class: "t" },
    h("thead", {}, h("tr", {}, ["User", "Secret", "Kind", "Service", "Source", "Status", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  if (!n.creds.length) tb.append(h("tr", {}, h("td", { colspan: 7, class: "empty" },
    "No credentials looted from this node.")));
  n.creds.forEach((cr) => tb.append(credRow(cr, reNode, true)));
  tbl.append(tb);
  c.append(h("div", { class: "card-h" }, icon("i-key"), "Looted credentials",
    h("button", { class: "btn pri sm", style: "margin-left:auto", onclick: () => addCredModal(n.id, reNode) }, icon("i-plus"), "Add credential")),
    tbl);
  return c;
}

function ndFindings(n) {
  const c = card(icon("i-flag"), "Findings on this node",
    h("button", { class: "btn pri sm", style: "margin-left:auto", onclick: () => openFinding(null, { nodeId: n.id, reload: reNode }) }, icon("i-plus"), "Add finding"));
  if (!n.findings.length) c.append(h("div", { class: "empty" }, "No findings on this node."));
  n.findings.forEach((f) => c.append(findingRow(f, reNode)));
  return c;
}
function findingRow(f, reload) {
  return h("div", { class: "row click", onclick: () => openFinding(f.id, { reload }) },
    f.code ? h("span", { class: "find-code mono" }, f.code) : "",
    h("span", { class: "grow" }, f.title),
    f.cvss_score != null ? h("span", { class: "sub mono" }, "CVSS " + f.cvss_score.toFixed(1)) : "",
    h("span", { class: "pill " + f.severity }, SEV_LABEL[f.severity] || f.severity),
    h("span", { class: "pill " + f.status }, FIND_STATUS_LABEL[f.status] || f.status),
    h("button", { class: "btn ghost sm", onclick: async (e) => {
      e.stopPropagation(); await api("DELETE", "/api/findings/" + f.id); reload();
    } }, icon("i-trash")));
}

const LOG_KINDS = [["recon", "Recon"], ["exploit", "Exploitation"], ["postex", "Post-exploitation"],
  ["win", "Win"], ["note", "Note"]];
function ndLog(n) {
  const wrap = h("div", {});
  const kindSel = h("select", { class: "mini" }, ...LOG_KINDS.map(([k, l]) => h("option", { value: k }, l)));
  const ta = h("textarea", { class: "nd-ta", placeholder: "what you did, what came out, next step..." });
  const add = async () => {
    if (!ta.value.trim()) return;
    await api("POST", "/api/node_notes", { node_id: n.id, body: ta.value.trim(), kind: kindSel.value });
    ta.value = ""; reNode();
  };
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); add(); } });
  const c = card(icon("i-clock"), "New entry");
  c.append(h("div", { class: "logform" }, ta,
    h("div", { class: "logform-a" }, kindSel,
      h("span", { class: "sub" }, "Ctrl+Enter"),
      h("button", { class: "btn pri", onclick: add }, icon("i-plus"), "Add"))));
  wrap.append(c);

  const c2 = card(icon("i-clock"), "Log");
  if (!n.log.length) c2.append(h("div", { class: "empty" }, "Nothing logged yet."));
  n.log.forEach((e) => c2.append(h("div", { class: "row logrow" },
    h("span", { class: "pill " + (e.kind === "win" ? "done" : e.kind === "exploit" ? "high" : "info") },
      (LOG_KINDS.find((k) => k[0] === e.kind) || ["", e.kind])[1]),
    h("span", { class: "grow logbody" }, e.body),
    h("span", { class: "sub", title: fmtDate(e.created_at) }, ago(e.created_at)),
    h("button", { class: "btn ghost sm", onclick: async () => {
      await api("DELETE", "/api/node_notes/" + e.id); reNode();
    } }, icon("i-trash")))));
  wrap.append(c2);
  return wrap;
}

function ndLinks(n) {
  const c = card(icon("i-link"), "Connections on the board",
    h("button", { class: "btn ghost sm", style: "margin-left:auto", onclick: () => switchView("board", n.id) }, "open board \u2192"));
  if (!n.links.length) c.append(h("div", { class: "empty" }, "This node is not connected to anything. Join it up on the board."));
  n.links.forEach((e) => {
    const out = e.source_id === n.id;
    const other = { id: out ? e.target_id : e.source_id, name: out ? e.target_name : e.source_name,
      type: out ? e.target_type : e.source_type, status: out ? e.target_status : e.source_status };
    c.append(h("div", { class: "row click", onclick: () => renderNodeDetail(other.id) },
      h("span", { class: "sub" }, out ? "→" : "←"),
      nodeIcon(other, "ic tic"),
      h("span", { class: "grow" }, other.name || NODE_LABEL[other.type] || "node"),
      e.type ? h("span", { class: "tag" }, e.type) : "",
      e.label ? h("span", { class: "sub" }, e.label) : ""));
  });
  return c;
}

function ndCaptures(n) {
  const wrap = h("div", {});
  const grid = h("div", { class: "vgrid" });
  if (!n.captures.length) grid.append(h("div", { class: "empty wide" },
    "No captures assigned. Drag images here, paste with Ctrl+V, or assign them from the vault."));
  n.captures.forEach((c) => grid.append(captureCard(c, {
    onOpen: () => openCapture(c.id, reNode),
    extra: h("button", { class: "btn ghost sm", title: "remove from this node", onclick: async (e) => {
      e.stopPropagation();
      await api("DELETE", "/api/nodes/" + n.id + "/captures/" + c.id); reNode();
    } }, icon("i-x")),
  })));

  const zone = dropZone("Drop captures here, or paste with Ctrl+V", (files) => uploadFiles(files, n.id, reNode));
  const c1 = card(icon("i-image"), "Captures on this node",
    h("div", { style: "margin-left:auto;display:flex;gap:8px" },
      assignCaptureSelect(n),
      h("button", { class: "btn pri sm", onclick: () => pickFiles((f) => uploadFiles(f, n.id, reNode)) }, icon("i-upload"), "Upload")));
  c1.append(h("div", { style: "padding:0 12px 12px" }, zone), grid);
  wrap.append(c1);
  return wrap;
}
function assignCaptureSelect(n) {
  const sel = h("select", { class: "mini" }, h("option", { value: "" }, "\uff0b assign from the vault\u2026"));
  api("GET", "/api/captures").then((list) => {
    const mine = new Set((n.captures || []).map((c) => c.id));
    list.filter((c) => !mine.has(c.id)).forEach((c) => sel.append(h("option", { value: c.id }, c.name)));
  }).catch(() => {});
  sel.onchange = async () => {
    if (!sel.value) return;
    await api("POST", "/api/nodes/" + n.id + "/captures", { capture_id: +sel.value });
    toast("Capture assigned", "ok"); reNode();
  };
  return sel;
}

async function renderVault(focusId) {
  const root = $("#v-vault");
  root.innerHTML = "";
  const nodes = await api("GET", "/api/nodes").catch(() => []);
  state.vaultNodes = nodes;

  const search = h("input", { class: "search", placeholder: "search by name, description or tag...", value: state.vaultQ || "" });
  const nodeSel = h("select", { class: "mini" },
    h("option", { value: "" }, "all nodes"),
    h("option", { value: "none", selected: state.vaultNode === "none" }, "\u2014 unassigned \u2014"),
    ...nodes.map((n) => h("option", { value: n.id, selected: String(n.id) === String(state.vaultNode) },
      (n.name || NODE_LABEL[n.type]))));
  const grid = h("div", { class: "vgrid" });
  const info = h("div", { class: "sub", style: "margin-bottom:10px" });

  const reload = async () => {
    let path = "/api/captures";
    const qs = [];
    if (search.value.trim()) qs.push("q=" + encodeURIComponent(search.value.trim()));
    if (nodeSel.value) qs.push("node_id=" + encodeURIComponent(nodeSel.value));
    if (qs.length) path += "?" + qs.join("&");
    const list = await api("GET", path);
    state.captures = list;
    grid.innerHTML = "";
    const bytes = list.reduce((a, c) => a + Number(c.size || 0), 0);
    info.textContent = plural(list.length, "capture", "captures") + " \u00b7 " + human(bytes) + " in data/captures/";
    if (!list.length) grid.append(h("div", { class: "empty wide" },
      "The vault is empty. Drag images in, paste with Ctrl+V, or hit \u00abUpload captures\u00bb."));
    list.forEach((c) => grid.append(captureCard(c, { onOpen: () => openCapture(c.id, reload), showNodes: true })));
  };
  let deb;
  search.oninput = () => { state.vaultQ = search.value; clearTimeout(deb); deb = setTimeout(reload, 200); };
  nodeSel.onchange = () => { state.vaultNode = nodeSel.value; reload(); };

  root.append(
    headBar("vault", "Captures",
      h("div", { class: "searchbox" }, icon("i-search"), search), nodeSel,
      h("button", { class: "btn pri", onclick: () => pickFiles((f) => uploadFiles(f, null, reload)) }, icon("i-upload"), "Upload captures")),
    dropZone("Drop your captures here (PNG, JPG, GIF, WEBP, BMP) or paste with Ctrl+V",
      (files) => uploadFiles(files, null, reload)),
    info, grid);
  state._reloadVault = reload;
  await reload();
  if (focusId) openCapture(focusId, reload);
}

function captureCard(c, opt) {
  opt = opt || {};
  const dims = c.width && c.height ? c.width + "×" + c.height : "";
  return h("div", { class: "vcard", onclick: opt.onOpen },
    h("div", { class: "vcard-img" }, h("img", { src: "/api/captures/" + c.id + "/file", alt: c.name || "capture", loading: "lazy" })),
    h("div", { class: "vcard-b" },
      h("div", { class: "vcard-n" }, c.name || "capture", opt.extra || ""),
      c.caption ? h("div", { class: "sub vcard-cap" }, c.caption) : "",
      opt.showNodes && c.nodes && c.nodes.length
        ? h("div", { class: "vcard-nodes" }, ...c.nodes.map((n) =>
          h("span", { class: "ntag", onclick: (e) => { e.stopPropagation(); switchView("nodes", n.id); } },
            nodeIcon(n, "ic tic"), n.name || NODE_LABEL[n.type])))
        : (opt.showNodes ? h("span", { class: "ntag muted" }, "unassigned") : ""),
      h("div", { class: "vcard-m sub" }, [dims, human(c.size), ago(c.created_at)].filter(Boolean).join(" · "))));
}

async function openCapture(cid, reload) {
  const c = await api("GET", "/api/captures/" + cid);
  const nodes = state.vaultNodes && state.vaultNodes.length ? state.vaultNodes : await api("GET", "/api/nodes").catch(() => []);
  state.vaultNodes = nodes;

  const nameIn = h("input", { class: "big-name", value: c.name || "" });
  const capIn = h("textarea", { class: "nd-ta", placeholder: "what the capture shows, why it matters..." }, c.caption || "");
  const tagsIn = h("input", { placeholder: "smb, pwned, evidence-3", value: c.tags || "" });
  const save = async () => {
    await api("PATCH", "/api/captures/" + cid, {
      name: nameIn.value.trim() || c.name, caption: capIn.value, tags: tagsIn.value.trim() });
  };

  const assigned = h("div", { class: "chips" });
  const paintAssigned = (list) => {
    assigned.innerHTML = "";
    if (!list.length) assigned.append(h("span", { class: "sub" }, "not assigned to any node"));
    list.forEach((n) => assigned.append(h("span", { class: "chip" }, nodeIcon(n, "ic tic"),
      n.name || NODE_LABEL[n.type],
      h("button", { class: "chip-x", title: "remove", onclick: async () => {
        await api("DELETE", "/api/nodes/" + n.id + "/captures/" + cid);
        const up = await api("GET", "/api/captures/" + cid);
        paintAssigned(up.nodes || []); reload && reload();
      } }, "×"))));
  };
  paintAssigned(c.nodes || []);
  const addSel = h("select", { class: "mini" }, h("option", { value: "" }, "\uff0b assign to a node\u2026"),
    ...nodes.map((n) => h("option", { value: n.id }, (n.name || NODE_LABEL[n.type]) + " · " + NODE_LABEL[n.type])));
  addSel.onchange = async () => {
    if (!addSel.value) return;
    await api("POST", "/api/nodes/" + addSel.value + "/captures", { capture_id: cid });
    addSel.value = "";
    const up = await api("GET", "/api/captures/" + cid);
    paintAssigned(up.nodes || []); reload && reload(); toast("Assigned", "ok");
  };

  const actions = h("div", { class: "modal-actions", style: "justify-content:space-between" },
    h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("a", { class: "btn", href: "/api/captures/" + cid + "/file?download=1", download: "" }, icon("i-download"), "Download"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm("Delete the capture and its image file?")) return;
        const r = await api("DELETE", "/api/captures/" + cid);
        closeModal();
        if (r && r.files_left && r.files_left.length) {
          toast("Capture deleted, but the file could not be removed: " + r.files_left.join(", "), "err");
        } else {
          toast("Capture deleted", "ok");
        }
        reload && reload();
      } }, icon("i-trash"), "Delete")),
    h("div", { style: "display:flex;gap:8px" },
      h("button", { class: "btn", onclick: closeModal }, "Close"),
      h("button", { class: "btn pri", onclick: async () => {
        await save(); closeModal(); toast("Saved", "ok"); reload && reload();
      } }, "Save")));

  openModalEl(null,
    h("div", { class: "editor caped" },
      h("div", { class: "caped-img" },
        h("img", { src: "/api/captures/" + cid + "/file", alt: c.name || "capture" })),
      h("div", { class: "caped-side" },
        h("div", { class: "field" }, h("label", {}, "Name"), nameIn),
        h("div", { class: "field" }, h("label", {}, "Description"), capIn),
        h("div", { class: "field" }, h("label", {}, "Tags"), tagsIn),
        h("div", { class: "field" }, h("label", {}, "Assigned nodes"), assigned, addSel),
        h("div", { class: "sub" }, [c.width && c.height ? c.width + "×" + c.height : "", human(c.size),
          c.mime, fmtDate(c.created_at)].filter(Boolean).join(" · ")),
        h("div", { class: "sub mono", style: "margin-top:4px;word-break:break-all" }, "data/captures/" + c.filename))),
    null, null, actions);
}

const MAX_UPLOAD = 32 * 1024 * 1024;
function pickFiles(then) {
  const inp = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" });
  inp.addEventListener("change", () => { if (inp.files && inp.files.length) then([...inp.files]); inp.remove(); });
  document.body.append(inp);
  inp.click();
}
function dropZone(label, then) {
  const z = h("div", { class: "dropzone" }, icon("i-upload"), h("span", {}, label));
  z.addEventListener("click", () => pickFiles(then));
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => {
    e.preventDefault(); z.classList.remove("over");
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) then(files);
  });
  return z;
}
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("could not read " + file.name));
    fr.readAsDataURL(file);
  });
}
async function uploadFiles(files, nodeId, then) {
  const imgs = [...files].filter((f) => (f.type || "").startsWith("image/"));
  if (!imgs.length) return toast("That is not an image", "err");
  let ok = 0;
  for (const f of imgs) {
    if (f.size > MAX_UPLOAD) { toast(f.name + " is too big (max 32 MB)", "err"); continue; }
    try {
      const data = await fileToDataURL(f);
      await api("POST", "/api/captures", {
        project_id: state.pid, name: f.name.replace(/\.[a-z0-9]+$/i, ""),
        orig_name: f.name, data, node_id: nodeId || null });
      ok++;
    } catch (e) { toast(e.message, "err"); }
  }
  if (ok) toast(ok === 1 ? "Capture uploaded" : ok + " captures uploaded", "ok");
  then && then();
}

document.addEventListener("paste", (e) => {
  if (isTyping(e.target)) return;
  if (!$("#modal-wrap").hidden) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => (f.type || "").startsWith("image/"));
  const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";

  if (state.view === "board" && text.startsWith(CLIP_TAG)) {
    e.preventDefault();
    let payload = null;
    try { payload = JSON.parse(text.slice(CLIP_TAG.length)); } catch (_) {}
    return void pasteClipboard(payload || state.clipboard);
  }
  if (!files.length) {

    if (state.view === "board" && state.clipboard) { e.preventDefault(); pasteClipboard(); }
    return;
  }
  e.preventDefault();
  if (state.view === "vault") uploadFiles(files, null, state._reloadVault);
  else if (state.view === "nodes" && state.curNode) uploadFiles(files, state.curNode.id, reNode);
  else if (state.view === "board" && state.selNode) {
    const n = state.selNode;
    uploadFiles(files, n.id, async () => { await state._reloadNodes(); selectNode(state.nodesById[n.id]); });
  } else toast("Open the Vault or select a node to paste the capture", "");
});

const SVGNS = "http://www.w3.org/2000/svg";
const CW = 4000, CH = 2600;

const HIST = { past: [], future: [] };
function pushHist(cmd) { HIST.past.push(cmd); if (HIST.past.length > 120) HIST.past.shift(); HIST.future = []; }
async function undo() { const c = HIST.past.pop(); if (!c) return toast("Nothing to undo", ""); await c.undo(); HIST.future.push(c); updateStatusbar(); }
async function redo() { const c = HIST.future.pop(); if (!c) return toast("Nothing to redo", ""); await c.redo(); HIST.past.push(c); updateStatusbar(); }

let _savedT = null;
function touchSaved() {
  state.lastSaved = new Date().toLocaleTimeString();
  clearTimeout(_savedT); _savedT = setTimeout(updateStatusbar, 200);
}

let _ctxEl = null;
function hideContextMenu() { if (_ctxEl) { _ctxEl.remove(); _ctxEl = null; } }
function showContextMenu(x, y, items) {
  hideContextMenu();
  const m = h("div", { class: "ctxmenu" });
  items.forEach((it) => {
    if (it.sep) { m.append(h("div", { class: "ctx-sep" })); return; }
    const row = h("div", { class: "ctx-item" + (it.danger ? " danger" : "") },
      it.dot ? h("span", { class: "ctx-dot", style: "background:" + it.dot }) : (it.ic ? icon(it.ic, "ctx-ic") : h("span", { class: "ctx-ic" })),
      it.label);
    row.addEventListener("click", () => { hideContextMenu(); it.fn && it.fn(); });
    m.append(row);
  });
  m.style.left = x + "px"; m.style.top = y + "px";
  document.body.append(m); _ctxEl = m;
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = Math.max(4, x - r.width) + "px";
  if (r.bottom > innerHeight) m.style.top = Math.max(4, y - r.height) + "px";
}
document.addEventListener("pointerdown", (e) => { if (_ctxEl && !e.target.closest(".ctxmenu")) hideContextMenu(); });
window.addEventListener("blur", hideContextMenu);

function nodeContextMenu(x, y, n) {
  showContextMenu(x, y, [
    { label: "Open full record", ic: "i-layers", fn: () => switchView("nodes", n.id) },
    { label: "Properties", ic: "i-board", fn: () => selectNode(n) },
    { label: "Upload capture to node", ic: "i-upload", fn: () => pickFiles((f) => uploadFiles(f, n.id, async () => { await loadNodes(); renderEdges(); })) },
    { sep: true },
    ...STATUSES.map((s) => ({ label: "Mark as: " + s.label, dot: s.c, fn: () => saveNode(n, { status: s.s }) })),
    { sep: true },
    { label: "Create connection", ic: "i-arrow", fn: () => { setMode("arrow"); arrowPick(n); } },
    { label: "Copy", ic: "i-copy", fn: () => copySelection(n) },
    { label: "Duplicate", ic: "i-copy", fn: () => duplicateNode(n) },
    { sep: true },
    { label: "Delete", ic: "i-trash", danger: true, fn: () => deleteNode(n) },
  ]);
}
function edgeContextMenu(x, y, e) {
  showContextMenu(x, y, [
    { label: "Edit connection", ic: "i-board", fn: () => editEdge(e) },
    { label: "Reverse direction", ic: "i-refresh", fn: () => reverseEdge(e) },
    { sep: true },
    { label: "Delete connection", ic: "i-trash", danger: true, fn: () => deleteEdge(e) },
  ]);
}

async function renderBoard(focusId) {
  const root = $("#v-board");
  root.innerHTML = "";
  state.mode = state.mode || "move";
  state.penColor = state.penColor || "#f5334f";
  state.penWidth = state.penWidth || 3;
  state.zoom = state.zoom || 1; state.panX = state.panX || 0; state.panY = state.panY || 0;
  state.nodesById = {}; state.edges = []; state.selNode = null; state.selSet = new Set(); state.selEdge = null;

  const search = h("input", { class: "search", placeholder: "filter nodes...", value: state.filter });
  let deb;
  search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { state.filter = search.value; applyFilter(); }, 150); };

  root.append(
    headBar("board", "Audit map",
      h("div", { class: "searchbox" }, icon("i-search"), search),
      h("button", { class: "btn pri", onclick: () => newNodeModal() }, icon("i-plus"), "New node")));

  const tbtn = (ic, title, fn, txt) => h("button", { class: "tbtn", title, onclick: fn }, txt ? txt : icon(ic));
  const tgroup = (...kids) => h("div", { class: "tgroup" }, kids);
  const toggleBtn = (key, ic, title) => {
    const b = h("button", { class: "tbtn" + (state[key] ? " on" : ""), title, onclick: () => { state[key] = !state[key]; b.classList.toggle("on", state[key]); updateCursor(); } }, icon(ic));
    return b;
  };
  root.append(h("div", { class: "wtoolbar" },
    tgroup(tbtn("i-undo", "Undo (Ctrl+Z)", undo), tbtn("i-redo", "Redo (Ctrl+Shift+Z)", redo)),
    tgroup(tbtn("i-copy", "Copy (Ctrl+C)", () => copySelection()),
      tbtn("i-trash", "Delete selection (Del)", deleteSelected)),
    tgroup(toggleBtn("panMode", "i-hand", "Hand (pan)")),
    tgroup(tbtn(null, "Zoom out", () => zoomBy(1 / 1.2), "−"),
      h("span", { class: "zoomlbl", id: "zoom-lbl" }, "100%"),
      tbtn(null, "Zoom in", () => zoomBy(1.2), "+"),
      tbtn("i-maximize", "Reset view", resetView)),
    tgroup(tbtn("i-image", "Export map as image", exportBoard))));

  const edgeSvg = document.createElementNS(SVGNS, "svg");
  edgeSvg.setAttribute("class", "edgelayer"); edgeSvg.setAttribute("width", CW); edgeSvg.setAttribute("height", CH);
  edgeSvg.setAttribute("viewBox", "0 0 " + CW + " " + CH);
  edgeSvg.innerHTML = '<defs>' +
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8892a2"/></marker>' +
    '<marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f5334f"/></marker></defs>';
  const drawSvg = document.createElementNS(SVGNS, "svg");
  drawSvg.setAttribute("class", "drawlayer"); drawSvg.setAttribute("width", CW); drawSvg.setAttribute("height", CH);
  drawSvg.setAttribute("viewBox", "0 0 " + CW + " " + CH);

  const world = h("div", { class: "world", id: "world" }, edgeSvg, drawSvg);
  world.style.width = CW + "px"; world.style.height = CH + "px";
  const stage = h("div", { class: "stage", id: "stage" }, world);
  const panel = h("div", { class: "props-panel", id: "props-panel", hidden: true });

  const modeBtn = (mode, ic, label) => {
    const b = h("button", { class: "toolbtn" + (state.mode === mode ? " on" : ""), title: label, onclick: () => setMode(mode) }, icon(ic), h("span", {}, label));
    b.dataset.mode = mode; return b;
  };
  const swatches = ["#f5334f", "#f2851f", "#eab308", "#22c55e", "#3b9eff", "#4f6ef2", "#a56bff", "#e2e8f0"].map((col) => {
    const s = h("button", { class: "swatch" + (state.penColor === col ? " on" : ""), style: "background:" + col,
      onclick: () => { state.penColor = col; $$(".swatch").forEach((x) => x.classList.remove("on")); s.classList.add("on"); if (state.mode !== "erase") setMode("draw"); } });
    return s;
  });
  const widthIn = h("input", { type: "range", min: "1", max: "12", value: String(state.penWidth), class: "wrange", oninput: (e) => { state.penWidth = +e.target.value; $("#pen-width-v").textContent = e.target.value; } });
  const rail = h("div", { class: "railleft" },

    h("div", { class: "rail-sec rail-pal" }, h("div", { class: "rail-h" }, "Node palette"), buildPaletteList(stage)),
    h("div", { class: "rail-sec rail-tools" }, h("div", { class: "rail-h" }, "Tools"),
      h("div", { class: "tool-grid" },
        modeBtn("move", "i-move", "Move"), modeBtn("text", "i-text", "Text"),
        modeBtn("draw", "i-pen", "Pen"), modeBtn("arrow", "i-arrow", "Arrow"),
        modeBtn("erase", "i-eraser", "Eraser"), modeBtn("select", "i-cursor", "Select")),
      h("div", { class: "swatches rail-sw" }, swatches),
      h("div", { class: "pen-width" }, h("span", { class: "sub" }, "Width"), widthIn, h("span", { class: "sub", id: "pen-width-v" }, String(state.penWidth)))),
    h("div", { class: "minimap", id: "minimap" }, h("div", { class: "mini-h" }, "Minimap"),
      h("div", { class: "mini-inner", id: "mini-inner" })));

  root.append(h("div", { class: "board-area" }, rail, stage, panel));
  state._svg = drawSvg; state._edgeSvg = edgeSvg; state._world = world; state._stage = stage;

  stage.addEventListener("pointerdown", (e) => {
    if (state.mode === "text" && e.button === 0 && !e.target.closest(".node")) {
      const [wx, wy] = screenToWorld(e.clientX, e.clientY);
      createNodeAt("note", wx - 70, wy - 20);
    }
  });

  bindDrawing(drawSvg);
  bindZoomPan(stage);
  bindMarquee(stage);
  state._reloadNodes = async () => { await loadNodes(); renderEdges(); applyFilter(); };
  await loadNodes();
  await loadEdges();
  await loadDrawing();
  setMode(state.mode); applyTransform(); applyFilter();
  if (focusId && state.nodesById[focusId]) {
    const n = state.nodesById[focusId];
    selectNode(n);
    centerOn(n);
  }
}

function clampPan() {
  const st = state._stage; if (!st) return;
  const vw = st.clientWidth, vh = st.clientHeight;
  const worldW = CW * state.zoom, worldH = CH * state.zoom;
  const margin = 120;
  const maxX = margin, minX = Math.min(maxX, vw - worldW - margin);
  const maxY = margin, minY = Math.min(maxY, vh - worldH - margin);
  state.panX = Math.max(minX, Math.min(maxX, state.panX));
  state.panY = Math.max(minY, Math.min(maxY, state.panY));
}
function applyTransform() {
  const w = state._world; if (!w) return;
  clampPan();
  w.style.transform = "translate(" + state.panX + "px," + state.panY + "px) scale(" + state.zoom + ")";
  const l = $("#zoom-lbl"); if (l) l.textContent = Math.round(state.zoom * 100) + "%";
  renderMinimap();
  updateStatusbar();
}
function centerOn(n) {
  const st = state._stage; if (!st || !n) return;
  const r = st.getBoundingClientRect();
  state.panX = r.width / 2 - (n.x || 0) * state.zoom - 58 * state.zoom;
  state.panY = r.height / 2 - (n.y || 0) * state.zoom - 63 * state.zoom;
  applyTransform();
}
function renderMinimap() {
  const inner = $("#mini-inner"); if (!inner || !state._stage) return;
  const W = inner.clientWidth || 182, H = inner.clientHeight || 104;
  const s = Math.min(W / CW, H / CH);
  inner.innerHTML = "";
  Object.values(state.nodesById).forEach((n) => inner.append(
    h("div", { class: "mini-dot", style: "left:" + (n.x || 0) * s + "px;top:" + (n.y || 0) * s + "px;background:" + nodeColor(n) })));
  const st = state._stage.getBoundingClientRect();
  inner.append(h("div", { class: "mini-view", style:
    "left:" + (-state.panX / state.zoom) * s + "px;top:" + (-state.panY / state.zoom) * s + "px;" +
    "width:" + (st.width / state.zoom) * s + "px;height:" + (st.height / state.zoom) * s + "px" }));
}
function screenToWorld(cx, cy) {
  const r = state._stage.getBoundingClientRect();
  return [(cx - r.left - state.panX) / state.zoom, (cy - r.top - state.panY) / state.zoom];
}
function zoomBy(f) { setZoom(state.zoom * f); }
function setZoom(z, cx, cy) {
  const st = state._stage.getBoundingClientRect();
  cx = cx == null ? st.width / 2 : cx - st.left; cy = cy == null ? st.height / 2 : cy - st.top;
  const wx = (cx - state.panX) / state.zoom, wy = (cy - state.panY) / state.zoom;
  state.zoom = Math.min(2.5, Math.max(0.2, z));
  state.panX = cx - wx * state.zoom; state.panY = cy - wy * state.zoom;
  applyTransform();
}
function resetView() { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform(); }

const NODE_W = 116, NODE_H = 126;
function svge(tag, attrs, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
  kids.flat().forEach((k) => k != null && e.append(k));
  return e;
}
function nodeBox(n) { return { l: n.x || 0, t: n.y || 0, r: (n.x || 0) + NODE_W, b: (n.y || 0) + NODE_H }; }
function boxGap(a, b) {
  const dx = Math.max(0, Math.max(a.l, b.l) - Math.min(a.r, b.r));
  const dy = Math.max(0, Math.max(a.t, b.t) - Math.min(a.b, b.b));
  return Math.hypot(dx, dy);
}

function clusterNodes(nodes, edges) {
  const GAP = 320;
  const parent = {};
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  nodes.forEach((n) => (parent[n.id] = n.id));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  (edges || []).forEach((e) => { if (byId[e.source_id] && byId[e.target_id]) union(e.source_id, e.target_id); });
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (boxGap(nodeBox(nodes[i]), nodeBox(nodes[j])) <= GAP) union(nodes[i].id, nodes[j].id);
  const groups = {};
  nodes.forEach((n) => { (groups[find(n.id)] = groups[find(n.id)] || []).push(n); });
  return Object.values(groups).sort((a, b) => b.length - a.length);
}
function bboxOf(nodes) {
  const b = { l: Infinity, t: Infinity, r: -Infinity, bo: -Infinity };
  nodes.forEach((n) => { const x = nodeBox(n); b.l = Math.min(b.l, x.l); b.t = Math.min(b.t, x.t); b.r = Math.max(b.r, x.r); b.bo = Math.max(b.bo, x.b); });
  return b;
}

function symbolGroup(symbolId, color, cx, cy, size, width) {
  const sym = document.getElementById(symbolId);
  const g = svge("g", { transform: "translate(" + (cx - size / 2) + "," + (cy - size / 2) + ") scale(" + (size / 24) + ")",
    fill: "none", stroke: color, "stroke-width": width || 2, "stroke-linecap": "round", "stroke-linejoin": "round" });
  if (sym) [...sym.children].forEach((c) => g.append(c.cloneNode(true)));
  return g;
}

function iconGroup(type, color, cx, cy, size) {
  return symbolGroup(NODE_SVG[type] || "i-hex", color, cx, cy, size);
}
function nodeToSVG(n) {
  const col = nodeColor(n), tcol = typeColor(n);
  const x = n.x || 0, y = n.y || 0;
  const g = svge("g", { transform: "translate(" + x + "," + y + ")" });
  if (n.type === "note") {
    g.append(svge("rect", { x: 4, y: 6, width: 150, height: 74, rx: 3, fill: "#f2d675", stroke: "#0000" }));
    wrapText(g, (n.props && n.props.text) || n.name || "note", 14, 24, 140, "#3a2e08", 12.5, 5);
    return g;
  }
  if (n.type === "cloud") {
    g.append(svge("path", { d: "M28 66 A16 16 0 0 1 29 34 A22 22 0 0 1 71 26 A17 17 0 0 1 96 40 A14 14 0 0 1 92 66 Z",
      fill: "#130d11", stroke: "#8a95a5", "stroke-width": 2 }));
    g.append(text(59, 50, n.name || "Internet", "#e6edf3", 12.5, 600, "middle"));
    return g;
  }
  g.append(svge("polygon", { points: "58,3 113,32 113,94 58,123 3,94 3,32", fill: "#130d11", stroke: col, "stroke-width": 2.6 }));
  g.append(iconGroup(n.type, tcol, 58, 45, 24));
  g.append(text(58, 74, n.name || NODE_LABEL[n.type] || "node", "#eef1f6", 12, 600, "middle"));
  const sub = nodeSub(n);
  if (sub) g.append(text(58, 88, sub, "#98a2b2", 10, 400, "middle"));
  const st = statusText(n);
  if (st) g.append(text(58, sub ? 101 : 92, st, col, 8.5, 700, "middle"));
  const c = n.counts || {};
  if (c.captures) {
    g.append(symbolGroup("i-image", "#98a2b2", 93, 20, 11, 2.4));
    g.append(text(101, 24, String(c.captures), "#98a2b2", 9, 600, "start"));
  }
  if (n.status === "highvalue") g.append(symbolGroup("i-crown", "#a56bff", 58, -2, 14, 2.4));

  const ad = (n.props && Array.isArray(n.props.ad)) ? n.props.ad : [];
  ad.map((k) => AD_FLAGS.find((f) => f[0] === k)).filter(Boolean).forEach((f, i) => {
    g.append(symbolGroup(f[2], f[3], 14 + i * 14, 20, 11, 2.4));
  });
  return g;
}
function text(x, y, s, fill, size, weight, anchor) {
  const t = svge("text", { x, y, fill, "font-size": size, "font-weight": weight || 400,
    "font-family": "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif", "text-anchor": anchor || "start" });
  t.textContent = s;
  return t;
}
function wrapText(g, s, x, y, maxw, fill, size, maxLines) {
  const words = String(s).split(/\s+/), lines = []; let cur = "";
  const per = Math.max(6, Math.floor(maxw / (size * 0.56)));
  words.forEach((w) => { if ((cur + " " + w).trim().length > per) { lines.push(cur.trim()); cur = w; } else cur += " " + w; });
  if (cur.trim()) lines.push(cur.trim());
  lines.slice(0, maxLines || 6).forEach((ln, i) => g.append(text(x, y + i * (size + 3), ln, fill, size, 400, "start")));
}
function nodeCenterXY(n) { return [(n.x || 0) + NODE_W / 2, (n.y || 0) + NODE_H / 2]; }
function buildBoardSVG(clusterNodesList, edges, drawing) {
  const bb = bboxOf(clusterNodesList), pad = 54;
  const minx = bb.l - pad, miny = bb.t - pad, w = (bb.r - bb.l) + 2 * pad, h = (bb.bo - bb.t) + 2 * pad;
  const svg = svge("svg", { xmlns: SVGNS, width: Math.round(w), height: Math.round(h),
    viewBox: minx + " " + miny + " " + w + " " + h });
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#0b0d11";
  svg.append(svge("rect", { x: minx, y: miny, width: w, height: h, fill: bg }));
  const defs = svge("defs", {});
  const mk = (id, color) => {
    const m = svge("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(svge("path", { d: "M0 0L10 5L0 10z", fill: color }));
    return m;
  };
  defs.append(mk("ax", "#8892a2"), mk("axh", "#f5334f"));
  svg.append(defs);
  const ids = new Set(clusterNodesList.map((n) => n.id));

  (drawing || []).forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    svg.append(svge("polyline", { points: s.points.map((p) => p.join(",")).join(" "), fill: "none",
      stroke: s.color || "#f5334f", "stroke-width": s.width || 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  });

  (edges || []).forEach((e) => {
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) return;
    const s = state.nodesById[e.source_id], t = state.nodesById[e.target_id];
    if (!s || !t) return;
    const a = nodeCenterXY(s), b = nodeCenterXY(t);
    const adAbuse = AD_ABUSE_EDGES.has(e.type);
    const hot = s.status === "pwned" || t.status === "pwned" || adAbuse;
    const dashed = ["credential-reuse", "trust", "belongs", "user"].includes(e.type) || /^[A-Z]/.test(e.type || "");
    svg.append(svge("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: hot ? "#f5334f" : "#8892a2",
      "stroke-width": hot ? 2.5 : 2, "stroke-dasharray": dashed ? "5 5" : null, "marker-end": hot ? "url(#axh)" : "url(#ax)" }));
    const lbl = e.label || e.type;
    if (lbl) svg.append(text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 6, lbl, "#c9d1d9", 11, 600, "middle"));
  });
  clusterNodesList.forEach((n) => svg.append(nodeToSVG(n)));
  return { svg, w, h };
}
function svgToPngBlob(svg) {
  return new Promise((res, rej) => {
    const str = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([str], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const c = h("canvas");
      c.width = +svg.getAttribute("width"); c.height = +svg.getAttribute("height");
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((b) => b ? res(b) : rej(new Error("could not generate the PNG")), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("could not rasterise the map")); };
    img.src = url;
  });
}

function pngScaleFor(w, ht) {
  const MAX = 7000, base = 2;
  return Math.max(1, Math.min(base, MAX / w, MAX / ht));
}
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return btoa(bin);
}

async function archiveBoardImage(blob, name) {
  try {
    await api("POST", "/api/projects/" + state.pid + "/exports/map",
              { name: name, data: await blobToBase64(blob) });
    return true;
  } catch (_) {
    return false;
  }
}
async function downloadClusterImage(nodes, name) {
  const { svg, w, h: ht } = buildBoardSVG(nodes, state.edges, state.drawing);
  const scale = pngScaleFor(w, ht);
  svg.setAttribute("width", Math.round(w * scale));
  svg.setAttribute("height", Math.round(ht * scale));
  const blob = await svgToPngBlob(svg);
  const archived = await archiveBoardImage(blob, name);
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return archived;
}
async function exportBoard() {
  const nodes = Object.values(state.nodesById || {});
  if (!nodes.length) return toast("No nodes to export", "");
  const proj = (await api("GET", "/api/projects").catch(() => [])).find((p) => p.id === state.pid);
  const slug = ((proj && proj.name) || "map").replace(/[^\w-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || "map";
  const clusters = clusterNodes(nodes, state.edges);
  const doAll = async (groups, label) => {
    try {
      let archived = 0;
      for (let i = 0; i < groups.length; i++) {
        if (await downloadClusterImage(groups[i], slug + (groups.length > 1 ? "-group-" + (i + 1) : "") + ".png")) archived++;
        if (groups.length > 1) await new Promise((r) => setTimeout(r, 350));
      }
      toast(archived === groups.length ? label + " and saved to the project folder" : label, "ok");
    } catch (e) { toast(e.message, "err"); }
  };
  if (clusters.length === 1) return doAll(clusters, "Map image downloaded");
  openModalEl("Export the map",
    h("div", {},
      h("p", {}, "The map has ", h("b", {}, String(clusters.length)), " separate groups of nodes. " +
        "Exporting it all together would make the nodes come out small."),
      h("p", { class: "sub" }, "Recommended: one image per group, each zoomed in so it reads large."),
      h("div", { class: "exp-groups" }, ...clusters.map((g, i) =>
        h("div", { class: "exp-grp" }, h("b", {}, "Group " + (i + 1)), " · " + plural(g.length, "node", "nodes"))))),
    null, null,
    h("div", { class: "modal-actions" },
      h("button", { class: "btn", onclick: () => { closeModal(); doAll([nodes], "Single image downloaded"); } }, "All in one image"),
      h("button", { class: "btn pri", onclick: () => { closeModal(); doAll(clusters, "Downloaded " + clusters.length + " images"); } },
        icon("i-download"), "Export " + clusters.length + " images")));
}
function bindZoomPan(stage) {
  stage.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    const pan = e.button === 1 || state.panMode || (state.space && e.button === 0);
    if (!pan || (e.button === 0 && e.target.closest(".node") && !state.panMode)) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, px = state.panX, py = state.panY;
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    stage.classList.add("panning");
    const mv = (ev) => { state.panX = px + (ev.clientX - sx); state.panY = py + (ev.clientY - sy); applyTransform(); };
    const up = () => { stage.removeEventListener("pointermove", mv); stage.removeEventListener("pointerup", up); stage.classList.remove("panning"); };
    stage.addEventListener("pointermove", mv); stage.addEventListener("pointerup", up);
  });
}

function buildPaletteList(stage) {
  const pal = h("div", { class: "pal-list" });
  NODE_TYPES.forEach((nt) => {
    const pic = icon(NODE_SVG[nt.t] || "i-hex", "pal-ic");
    pic.style.color = TYPE_COLOR[nt.t] || "#8a95a5";
    const item = h("div", { class: "pal-item", draggable: "true", title: "drag onto the canvas" },
      pic, h("span", { class: "pal-lbl" }, nt.label));
    item.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/atlas-type", nt.t));
    item.addEventListener("dblclick", () => {
      if (state.mode !== "move") setMode("move");
      const r = state._stage.getBoundingClientRect();
      const [wx, wy] = screenToWorld(r.left + 200, r.top + 160);
      createNodeAt(nt.t, wx, wy);
    });
    pal.append(item);
  });
  stage.addEventListener("dragover", (e) => {
    const t = [...e.dataTransfer.types];
    if (t.includes("text/atlas-type") || t.includes("Files")) e.preventDefault();
  });
  stage.addEventListener("drop", async (e) => {
    const t = e.dataTransfer.getData("text/atlas-type");
    if (t) {
      e.preventDefault();
      if (state.mode !== "move") setMode("move");
      const [wx, wy] = screenToWorld(e.clientX, e.clientY);
      createNodeAt(t, wx - 80, wy - 34);
      return;
    }
    const files = [...(e.dataTransfer.files || [])].filter((f) => (f.type || "").startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest(".node");
    const nid = nodeEl ? +nodeEl.dataset.nodeId : null;
    await uploadFiles(files, nid, async () => {
      await state._reloadNodes();
      if (nid && state.nodesById[nid]) selectNode(state.nodesById[nid]);
      if (!nid) toast("Sent to the vault (drop them on a node to assign them)", "");
    });
  });
  return pal;
}

async function loadNodes() {
  $$(".node", state._world).forEach((n) => n.remove());
  const keep = state.selSet ? [...state.selSet] : [];
  state.nodesById = {};
  const nodes = await api("GET", "/api/nodes").catch(() => []);
  nodes.forEach((n) => addNodeEl(n));
  state.selSet = new Set(keep.filter((id) => state.nodesById[id]));
  if (state.selNode) state.selNode = state.nodesById[state.selNode.id] || null;
  markSelection();
}
function addNodeEl(n) {
  state.nodesById[n.id] = n;
  const el = renderNode(n);
  state._world.append(el);
  n._el = el;
  return el;
}
async function createNodeAt(type, x, y) {
  const data = { project_id: state.pid, type, name: NODE_LABEL[type] || "node", x: Math.round(x), y: Math.round(y), props: {} };
  const n = await api("POST", "/api/nodes", data);
  addNodeEl(n); selectNode(n); touchSaved();
  const holder = { n };
  pushHist({
    undo: async () => { await api("DELETE", "/api/nodes/" + holder.n.id).catch(() => {}); if (holder.n._el) holder.n._el.remove(); delete state.nodesById[holder.n.id]; if (state.selNode === holder.n) deselect(); renderEdges(); },
    redo: async () => { const nn = await api("POST", "/api/nodes", Object.assign({}, data, { name: holder.n.name, status: holder.n.status, x: holder.n.x, y: holder.n.y, props: holder.n.props })); holder.n = nn; addNodeEl(nn); },
  });
  return n;
}

function renderNode(n) {
  if (n.type === "note") return renderNoteNode(n);
  if (n.type === "cloud") return renderCloudNode(n);
  const col = nodeColor(n);
  const el = h("div", { class: "node status-" + (n.status || "unknown"), "data-node-id": n.id });
  el.style.left = (n.x || 20) + "px"; el.style.top = (n.y || 20) + "px";
  el.style.setProperty("--nc", col);
  el.style.setProperty("--ic", typeColor(n));
  const hex = document.createElementNS(SVGNS, "svg");
  hex.setAttribute("class", "hex"); hex.setAttribute("viewBox", "0 0 116 126");
  const poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("points", "58,3 113,32 113,94 58,123 3,94 3,32");
  poly.setAttribute("fill", "#130d11"); poly.setAttribute("stroke", col); poly.setAttribute("stroke-width", "2.5");
  hex.append(poly); el.append(hex);
  el.append(h("div", { class: "node-body" },
    icon(NODE_SVG[n.type] || "i-hex", "node-ic2"),
    h("div", { class: "node-name" }, n.name || NODE_LABEL[n.type] || "node"),
    nodeSub(n) ? h("div", { class: "node-sub mono" }, nodeSub(n)) : null,
    statusText(n) ? h("div", { class: "node-slabel" }, statusText(n)) : null));
  if (n.status === "highvalue") {
    const crown = icon("i-crown", "node-crown");
    crown.setAttribute("title", "High value");
    el.append(crown);
  }
  const ad = (n.props && Array.isArray(n.props.ad)) ? n.props.ad : [];
  if (ad.length) {
    const flags = ad.map((k) => AD_FLAGS.find((f) => f[0] === k)).filter(Boolean);
    const tip = flags.map((f) => f[1]).join(", ");
    const box = h("div", { class: "node-adflags", title: tip });
    flags.forEach(([, , ic, color]) => {
      const pic = icon(ic, "adflag-badge");
      pic.style.color = color;
      box.append(pic);
    });
    el.append(box);
  }
  const c = n.counts || {};
  if (c.captures) el.append(h("div", { class: "node-ev", title: c.captures + " captures" }, icon("i-image"), String(c.captures)));
  if (c.creds) el.append(h("div", { class: "node-ev node-ev2", title: c.creds + " credentials" }, icon("i-key"), String(c.creds)));
  el.append(h("div", { class: "node-handle", title: "drag to another node to connect" }));
  bindNodeDrag(el, n);
  bindEdgeHandle($(".node-handle", el), n);
  if (state.selSet && state.selSet.has(n.id)) el.classList.add("sel");
  return el;
}
function renderCloudNode(n) {
  const el = h("div", { class: "node cloud-node", "data-node-id": n.id });
  el.style.left = (n.x || 20) + "px"; el.style.top = (n.y || 20) + "px";
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "cloudsvg"); svg.setAttribute("viewBox", "0 0 118 74");
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", "M28 66 A16 16 0 0 1 29 34 A22 22 0 0 1 71 26 A17 17 0 0 1 96 40 A14 14 0 0 1 92 66 Z");
  p.setAttribute("fill", "#130d11"); p.setAttribute("stroke", "#8a95a5"); p.setAttribute("stroke-width", "2");
  svg.append(p); el.append(svg);
  el.append(h("div", { class: "cloud-lbl" }, n.name || "Internet"));
  el.append(h("div", { class: "node-handle", title: "connect" }));
  bindNodeDrag(el, n); bindEdgeHandle($(".node-handle", el), n);
  if (state.selSet && state.selSet.has(n.id)) el.classList.add("sel");
  return el;
}
function renderNoteNode(n) {
  const el = h("div", { class: "node note-node", "data-node-id": n.id });
  el.style.left = (n.x || 20) + "px"; el.style.top = (n.y || 20) + "px";
  el.append(
    h("div", { class: "postit" }, (n.props && n.props.text) || n.name || "note"),
    h("div", { class: "node-handle", title: "connect" }));
  bindNodeDrag(el, n);
  bindEdgeHandle($(".node-handle", el), n);
  if (state.selSet && state.selSet.has(n.id)) el.classList.add("sel");
  return el;
}
function refreshNode(n) {
  if (!n._el) return;
  const nw = renderNode(n);
  n._el.replaceWith(nw); n._el = nw;
  renderEdges(); applyFilter();
}

const DRAG_SLOP = 5;

function startEdgeDrag(host, n, e, onClick) {
  e.preventDefault(); e.stopPropagation();
  try { host.setPointerCapture(e.pointerId); } catch (_) {}
  const line = document.createElementNS(SVGNS, "line");
  line.setAttribute("class", "edge hot"); line.setAttribute("marker-end", "url(#arrow-hot)");
  state._edgeSvg.append(line);
  const c = nodeCenter(n);
  const sx = e.clientX, sy = e.clientY;
  let dragged = false;
  const mv = (ev) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > DRAG_SLOP) dragged = true;
    const [wx, wy] = screenToWorld(ev.clientX, ev.clientY);
    line.setAttribute("x1", c[0]); line.setAttribute("y1", c[1]); line.setAttribute("x2", wx); line.setAttribute("y2", wy);
  };
  const up = (ev) => {
    host.removeEventListener("pointermove", mv);
    host.removeEventListener("pointerup", up);
    host.removeEventListener("pointercancel", up);
    line.remove();
    const tgt = document.elementFromPoint(ev.clientX, ev.clientY);
    const tnode = tgt && tgt.closest(".node");
    const tid = tnode ? +tnode.dataset.nodeId : null;
    if (tid && tid !== n.id && state.nodesById[tid]) createEdgeBetween(n, state.nodesById[tid]);
    else if (!dragged && onClick) onClick();
  };
  host.addEventListener("pointermove", mv);
  host.addEventListener("pointerup", up);
  host.addEventListener("pointercancel", up);
}

function bindNodeDrag(el, n) {
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); selectNode(n); nodeContextMenu(e.clientX, e.clientY, n); });
  el.addEventListener("dblclick", (e) => {
    if (state.mode !== "move" && state.mode !== "select") return;
    e.preventDefault(); e.stopPropagation();
    switchView("nodes", n.id);
  });
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node-handle")) return;
    if (state.mode === "arrow") return startEdgeDrag(el, n, e, () => arrowPick(n));
    if (!(state.mode === "move" || state.mode === "select") || state.space || state.panMode) return;
    e.preventDefault(); e.stopPropagation();
    const shift = e.shiftKey;
    const sx = e.clientX, sy = e.clientY, ox = n.x || 0, oy = n.y || 0;
    let moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add("dragging");
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / state.zoom, dy = (ev.clientY - sy) / state.zoom;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > DRAG_SLOP) moved = true;
      if (!moved) return;
      n.x = Math.max(0, ox + dx); n.y = Math.max(0, oy + dy);
      el.style.left = n.x + "px"; el.style.top = n.y + "px";
      renderEdges();
    };
    const up = () => {
      el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
      el.classList.remove("dragging");
      if (moved) {
        const from = { x: Math.round(ox), y: Math.round(oy) }, to = { x: Math.round(n.x), y: Math.round(n.y) };
        api("PATCH", "/api/nodes/" + n.id, to).catch(() => {}); touchSaved();
        pushHist({ undo: () => moveNodeTo(n, from), redo: () => moveNodeTo(n, to) });
      } else selectNode(n, shift);
    };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
  });
}
function moveNodeTo(n, p) {
  n.x = p.x; n.y = p.y;
  if (n._el) { n._el.style.left = p.x + "px"; n._el.style.top = p.y + "px"; }
  api("PATCH", "/api/nodes/" + n.id, { x: p.x, y: p.y }).catch(() => {}); renderEdges();
}

function arrowPick(n) {
  if (!state.arrowSrc) {
    state.arrowSrc = n; if (n._el) n._el.classList.add("arrow-src");
    toast("Source: " + (n.name || "node") + ". Now click the target", "");
  } else {
    const src = state.arrowSrc; if (src._el) src._el.classList.remove("arrow-src"); state.arrowSrc = null;
    if (src.id !== n.id) createEdgeBetween(src, n);
  }
}
function clearArrowSrc() {
  if (state.arrowSrc && state.arrowSrc._el) state.arrowSrc._el.classList.remove("arrow-src");
  state.arrowSrc = null;
}
async function createEdgeBetween(a, b) {
  const ed = await api("POST", "/api/edges", { project_id: state.pid, source_id: a.id, target_id: b.id, type: "", label: "" });
  state.edges.push(ed); renderEdges(); touchSaved(); toast("Connection created", "ok");
  pushHist({ undo: async () => { await api("DELETE", "/api/edges/" + ed.id).catch(() => {}); state.edges = state.edges.filter((x) => x.id !== ed.id); renderEdges(); },
    redo: async () => { const e2 = await api("POST", "/api/edges", { project_id: state.pid, source_id: a.id, target_id: b.id, type: ed.type, label: ed.label }); ed.id = e2.id; state.edges.push(e2); renderEdges(); } });
  selectEdge(ed);
  return ed;
}

function bindEdgeHandle(handle, n) {
  handle.addEventListener("pointerdown", (e) => {
    if (!["move", "select", "arrow"].includes(state.mode)) return;
    startEdgeDrag(handle, n, e, () => { if (state.mode === "arrow") arrowPick(n); });
  });
}

async function loadEdges() { state.edges = await api("GET", "/api/edges").catch(() => []); renderEdges(); }
function nodeCenter(n) {
  const el = n._el || (state.nodesById[n.id] && state.nodesById[n.id]._el);
  if (!el) return [n.x || 0, n.y || 0];
  return [el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2];
}
function renderEdges() {
  const svg = state._edgeSvg; if (!svg) return;
  $$(".edge-g", svg).forEach((g) => g.remove());
  state.edges.forEach((e) => {
    const s = state.nodesById[e.source_id], t = state.nodesById[e.target_id];
    if (!s || !t) return;
    const a = nodeCenter(s), b = nodeCenter(t);
    const hot = s.status === "pwned" || t.status === "pwned" || AD_ABUSE_EDGES.has(e.type);
    const dashed = ["credential-reuse", "trust", "belongs", "user"].includes(e.type) || /^[A-Z]/.test(e.type || "");
    const sel = state.selEdge && state.selEdge.id === e.id;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "edge-g" + (sel ? " sel" : ""));

    const hit = document.createElementNS(SVGNS, "line");
    hit.setAttribute("x1", a[0]); hit.setAttribute("y1", a[1]); hit.setAttribute("x2", b[0]); hit.setAttribute("y2", b[1]);
    hit.setAttribute("class", "edge-hit");
    g.append(hit);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", a[0]); line.setAttribute("y1", a[1]); line.setAttribute("x2", b[0]); line.setAttribute("y2", b[1]);
    line.setAttribute("class", "edge" + (hot ? " hot" : "") + (dashed ? " dashed" : "")); line.setAttribute("marker-end", hot ? "url(#arrow-hot)" : "url(#arrow)");
    g.append(line);
    const lbl = e.label || e.type;
    if (lbl) {
      const tx = document.createElementNS(SVGNS, "text");
      tx.setAttribute("x", (a[0] + b[0]) / 2); tx.setAttribute("y", (a[1] + b[1]) / 2 - 6);
      tx.setAttribute("class", "edge-lbl"); tx.textContent = lbl;
      g.append(tx);
    }
    g.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || state.panMode || state.space) return;
      if (!["move", "select"].includes(state.mode)) return;
      ev.stopPropagation(); selectEdge(e);
    });
    g.addEventListener("dblclick", (ev) => { ev.stopPropagation(); editEdge(e); });
    g.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); selectEdge(e); edgeContextMenu(ev.clientX, ev.clientY, e); });
    svg.append(g);
  });
  renderMinimap();
}

function selectEdge(e) {
  state.selSet.clear(); state.selNode = null;
  markSelection();
  state.selEdge = e;
  renderEdges();
  openEdgePanel(e);
  updateStatusbar();
}
function deselectEdge() {
  if (!state.selEdge) return;
  state.selEdge = null;
  renderEdges();
  const p = $("#props-panel"); if (p) p.hidden = true;
  updateStatusbar();
}
async function reverseEdge(e) {
  const up = await api("PATCH", "/api/edges/" + e.id, { source_id: e.target_id, target_id: e.source_id });
  Object.assign(e, up); renderEdges(); touchSaved();
  if (state.selEdge && state.selEdge.id === e.id) openEdgePanel(e);
}
async function deleteEdge(e) {
  await api("DELETE", "/api/edges/" + e.id).catch(() => {});
  state.edges = state.edges.filter((x) => x.id !== e.id);
  if (state.selEdge && state.selEdge.id === e.id) state.selEdge = null;
  renderEdges(); touchSaved(); toast("Connection deleted", "ok");
  const p = $("#props-panel"); if (p) p.hidden = true;
  updateStatusbar();
  const data = { project_id: state.pid, source_id: e.source_id, target_id: e.target_id, type: e.type, label: e.label };
  const holder = { id: e.id };
  pushHist({
    undo: async () => { const e2 = await api("POST", "/api/edges", data); holder.id = e2.id; state.edges.push(e2); renderEdges(); },
    redo: async () => { await api("DELETE", "/api/edges/" + holder.id).catch(() => {}); state.edges = state.edges.filter((x) => x.id !== holder.id); renderEdges(); },
  });
}
async function saveEdge(e, patch) {
  const up = await api("PATCH", "/api/edges/" + e.id, patch).catch(() => null);
  if (up) Object.assign(e, up);
  renderEdges(); touchSaved();
}

function openEdgePanel(e) {
  const p = $("#props-panel"); if (!p) return;
  p.hidden = false; p.innerHTML = "";
  const s = state.nodesById[e.source_id], t = state.nodesById[e.target_id];
  const nameOf = (n) => n ? (n.name || NODE_LABEL[n.type] || "node") : "?";

  p.append(h("div", { class: "pp-title" }, "Connection properties",
    h("button", { class: "btn ghost sm", title: "close", style: "margin-left:auto", onclick: deselectEdge }, icon("i-x"))));

  p.append(h("div", { class: "pe-ends" },
    h("div", { class: "pe-end" }, s ? nodeIcon(s, "ic tic") : "", h("span", { class: "grow" }, nameOf(s))),
    h("button", { class: "btn ghost sm pe-swap", title: "Reverse direction", onclick: () => reverseEdge(e) }, icon("i-refresh")),
    h("div", { class: "pe-end" }, t ? nodeIcon(t, "ic tic") : "", h("span", { class: "grow" }, nameOf(t)))));

  const typeSel = h("select", { class: "mini" }, ...EDGE_TYPES.map((v) =>
    h("option", { value: v, selected: v === (e.type || "") }, v || "— none —")));
  typeSel.onchange = () => saveEdge(e, { type: typeSel.value });
  const labelIn = h("input", { class: "kv-in", value: e.label || "", placeholder: "admin access : 445" });
  labelIn.addEventListener("change", () => saveEdge(e, { label: labelIn.value.trim() }));

  p.append(h("div", { class: "pp-body" },
    kv("Type", typeSel), kv("Label", labelIn),
    h("div", { class: "sub", style: "padding-top:8px" },
      "Double-click a connection on the map to edit it in a dialog; right-click for more actions.")));

  p.append(h("div", { class: "pp-actions" },
    h("button", { class: "btn", onclick: () => editEdge(e) }, icon("i-pen"), "Edit"),
    h("button", { class: "btn danger", onclick: () => deleteEdge(e) }, icon("i-trash"))));
}
function editEdge(e) {
  const typeSel = selectField("type", "Relationship type", EDGE_TYPES, e.type || "");
  const labelF = field("label", "Label", "admin access : 445");
  openModalEl("Connection",
    h("div", {}, typeSel.el, labelF),
    async () => {
      const up = await api("PATCH", "/api/edges/" + e.id, { type: typeSel.get(), label: valOf("label") });
      Object.assign(e, up); renderEdges(); touchSaved(); closeModal();
      if (state.selEdge && state.selEdge.id === e.id) openEdgePanel(e);
    }, "Save");
  const lab = $("[name='label']", $("#modal")); if (lab) lab.value = e.label || "";
  $(".modal-actions", $("#modal")).prepend(
    h("button", { class: "btn danger", style: "margin-right:auto", onclick: () => { closeModal(); deleteEdge(e); } }, "Delete"));
}

function setMode(mode) {
  state.mode = mode;
  clearArrowSrc();
  $$(".toolbtn[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const w = state._world, svg = state._svg;
  if (!w) return;
  w.classList.remove("mode-move", "mode-text", "mode-draw", "mode-arrow", "mode-erase", "mode-select");
  w.classList.add("mode-" + mode);
  const drawing = mode === "draw" || mode === "erase";
  svg.style.pointerEvents = drawing ? "auto" : "none";
  updateCursor();
}

const MODE_CURSOR = { move: "default", select: "default", text: "text", arrow: "crosshair", draw: "crosshair", erase: "cell" };
function updateCursor() {
  const st = state._stage; if (!st) return;
  const panning = state.panMode || state.space;
  st.classList.toggle("pan-ready", !!panning);
  st.style.cursor = panning ? "grab" : (MODE_CURSOR[state.mode] || "default");
}

function applyFilter() {
  const q = (state.filter || "").toLowerCase();
  Object.values(state.nodesById || {}).forEach((n) => {
    if (!n._el) return;
    const hay = ((n.name || "") + " " + (n.type || "") + " " + (NODE_LABEL[n.type] || "") + " " +
      JSON.stringify(n.props || {})).toLowerCase();
    n._el.classList.toggle("dim", !!q && !hay.includes(q));
  });
}

function markSelection() {
  if (!state._world) return;
  $$(".node", state._world).forEach((el) => el.classList.toggle("sel", state.selSet.has(+el.dataset.nodeId)));
}
function syncPanel() {
  const p = $("#props-panel");
  if (state.selSet.size === 1 && state.selNode) openNodePanel(state.selNode);
  else if (p) p.hidden = true;
  updateStatusbar();
}
function selectNode(n, additive) {
  if (!n) return;
  if (state.selEdge) { state.selEdge = null; renderEdges(); }
  if (!additive) state.selSet.clear();
  if (additive && state.selSet.has(n.id)) state.selSet.delete(n.id);
  else state.selSet.add(n.id);
  state.selNode = state.selSet.has(n.id) ? n : (state.selSet.size ? state.nodesById[[...state.selSet].pop()] : null);
  markSelection();
  syncPanel();
}
function deselect() {
  state.selSet.clear(); state.selNode = null;
  const hadEdge = !!state.selEdge; state.selEdge = null;
  if (state._world) $$(".node.sel", state._world).forEach((e) => e.classList.remove("sel"));
  if (hadEdge) renderEdges();
  const p = $("#props-panel"); if (p) p.hidden = true;
  updateStatusbar();
}
function selectedNodes() {
  const ids = state.selSet.size ? [...state.selSet] : (state.selNode ? [state.selNode.id] : []);
  return ids.map((id) => state.nodesById[id]).filter(Boolean);
}
async function deleteSelected() {
  if (state.selEdge) return deleteEdge(state.selEdge);
  for (const n of selectedNodes()) { state.selSet.delete(n.id); await deleteNode(n); }
}
async function duplicateSelected() {
  for (const n of selectedNodes()) await duplicateNode(n);
}

const CLIP_TAG = "atlas-nodes:";
function buildClipPayload(only) {
  const nodes = only ? [only] : selectedNodes();
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes: nodes.map((n) => ({
      srcId: n.id, type: n.type, name: n.name, status: n.status, color: n.color,
      x: n.x || 0, y: n.y || 0, props: JSON.parse(JSON.stringify(n.props || {})),
    })),
    edges: (state.edges || []).filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type, label: e.label })),
  };
}
function copySelection(only) {
  const payload = buildClipPayload(only);
  if (!payload) return toast("Nothing selected to copy", "");
  state.clipboard = payload;

  try { navigator.clipboard?.writeText(CLIP_TAG + JSON.stringify(payload)).catch(() => {}); } catch (_) {}
  toast(payload.nodes.length === 1 ? "Node copied" : payload.nodes.length + " nodes copied", "ok");
}

document.addEventListener("copy", (e) => {
  if (state.view !== "board" || isTyping(e.target)) return;
  if (!$("#modal-wrap").hidden) return;
  if (window.getSelection && String(window.getSelection())) return;
  const payload = buildClipPayload();
  if (!payload || !e.clipboardData) return;
  e.clipboardData.setData("text/plain", CLIP_TAG + JSON.stringify(payload));
  e.preventDefault();
  state.clipboard = payload;
  toast(payload.nodes.length === 1 ? "Node copied" : payload.nodes.length + " nodes copied", "ok");
});
async function pasteClipboard(payload) {
  const clip = payload || state.clipboard;
  if (!clip || !clip.nodes || !clip.nodes.length) return toast("Clipboard is empty", "");

  const OFF = 48;
  const created = [], idMap = {};
  for (const c of clip.nodes) {
    const n = await api("POST", "/api/nodes", {
      project_id: state.pid, type: c.type, name: c.name, status: c.status, color: c.color,
      x: Math.round(c.x + OFF), y: Math.round(c.y + OFF), props: c.props });
    idMap[c.srcId] = n.id;
    addNodeEl(n); created.push(n);
  }
  const newEdges = [];
  for (const e of clip.edges) {
    const src = idMap[e.source_id], tgt = idMap[e.target_id];
    if (!src || !tgt) continue;
    const ed = await api("POST", "/api/edges", { project_id: state.pid, source_id: src, target_id: tgt, type: e.type, label: e.label }).catch(() => null);
    if (ed) { state.edges.push(ed); newEdges.push(ed); }
  }

  state.selEdge = null;
  state.selSet = new Set(created.map((n) => n.id));
  state.selNode = created[created.length - 1] || null;
  markSelection(); renderEdges(); syncPanel(); touchSaved();
  toast(created.length === 1 ? "Node pasted" : created.length + " nodes pasted", "ok");
  pushHist({
    undo: async () => {
      for (const ed of newEdges) await api("DELETE", "/api/edges/" + ed.id).catch(() => {});
      state.edges = state.edges.filter((x) => !newEdges.some((n2) => n2.id === x.id));
      for (const n of created) { await api("DELETE", "/api/nodes/" + n.id).catch(() => {}); if (n._el) n._el.remove(); delete state.nodesById[n.id]; }
      deselect(); renderEdges();
    },
    redo: () => pasteClipboard(),
  });
}

function bindMarquee(stage) {
  stage.addEventListener("pointerdown", (e) => {
    if (state.mode !== "select" || e.button !== 0 || state.panMode || state.space) return;
    if (e.target.closest(".node")) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const box = h("div", { class: "marquee" }); stage.append(box);
    if (!e.shiftKey) { state.selSet.clear(); state.selEdge = null; markSelection(); renderEdges(); syncPanel(); }
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = (ev) => {
      const x = Math.min(x0, ev.clientX), y = Math.min(y0, ev.clientY);
      box.style.left = (x - rect.left) + "px"; box.style.top = (y - rect.top) + "px";
      box.style.width = Math.abs(ev.clientX - x0) + "px"; box.style.height = Math.abs(ev.clientY - y0) + "px";
    };
    const up = (ev) => {
      stage.removeEventListener("pointermove", mv); stage.removeEventListener("pointerup", up);
      const rx = Math.min(x0, ev.clientX), ry = Math.min(y0, ev.clientY);
      const rw = Math.abs(ev.clientX - x0), rh = Math.abs(ev.clientY - y0);
      box.remove();
      if (rw < 4 && rh < 4) { if (!ev.shiftKey) deselect(); return; }
      Object.values(state.nodesById).forEach((n) => {
        if (!n._el) return;
        const cx = rect.left + state.panX + state.zoom * (n._el.offsetLeft + n._el.offsetWidth / 2);
        const cy = rect.top + state.panY + state.zoom * (n._el.offsetTop + n._el.offsetHeight / 2);
        if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) state.selSet.add(n.id);
      });
      markSelection();
      state.selNode = state.selSet.size ? state.nodesById[[...state.selSet][0]] : null;
      syncPanel();
    };
    stage.addEventListener("pointermove", mv); stage.addEventListener("pointerup", up);
  });
}
function openNodePanel(n) {
  const p = $("#props-panel"); if (!p) return;
  p.hidden = false; p.innerHTML = "";
  n.props = n.props || {};
  const col = nodeColor(n), tcol = typeColor(n);
  const nameIn = h("input", { class: "pn-name", value: n.name || "" });
  nameIn.addEventListener("change", () => saveNode(n, { name: nameIn.value.trim() }));

  p.append(h("div", { class: "pp-title" }, "Node properties",
    h("button", { class: "btn ghost sm", title: "close", style: "margin-left:auto", onclick: deselect }, icon("i-x"))));
  p.append(h("div", { class: "pp-head" },
    h("span", { class: "pp-badge", style: "border-color:" + col + ";color:" + tcol }, icon(NODE_SVG[n.type] || "i-hex", "node-ic2")),
    h("div", { class: "grow" }, nameIn,
      h("div", { class: "pp-status", style: "color:" + col }, h("span", { class: "sdot", style: "background:" + col }), statusText(n) || (n.status || "").toUpperCase()))));

  const tabs = ["General", "Captures", "Log", "Note"];
  state.panelTab = tabs.includes(state.panelTab) ? state.panelTab : "General";
  const bar = h("div", { class: "pp-tabs" });
  const body = h("div", { class: "pp-body" });
  tabs.forEach((t) => {
    bar.append(h("button", { class: "pp-tab" + (t === state.panelTab ? " on" : ""), onclick: () => { state.panelTab = t; openNodePanel(n); } }, t));
  });
  p.append(bar, body);

  if (state.panelTab === "General") {
    const typeSel = h("select", { class: "mini" }, ...NODE_TYPES.map((x) => h("option", { value: x.t, selected: x.t === n.type }, x.label)));
    typeSel.onchange = () => saveNode(n, { type: typeSel.value });
    const statusSel = h("select", { class: "mini pn-status" }, ...STATUSES.map((x) => h("option", { value: x.s, selected: x.s === n.status }, x.label)));
    statusSel.onchange = () => saveNode(n, { status: statusSel.value });
    body.append(kv("Type", typeSel), ...NODE_FIELDS.map((k) => kvField(n, k)), kv("Status", statusSel));
    const c = n.counts || {};
    body.append(h("div", { class: "pp-counts" },
      countChip("i-server", c.services, "ports"), countChip("i-users", c.users, "users"),
      countChip("i-key", c.creds, "credentials"), countChip("i-image", c.captures, "captures"),
      countChip("i-flag", c.findings, "findings"), countChip("i-clock", c.notes, "log")));
  } else if (state.panelTab === "Captures") {
    const grid = h("div", { class: "pcaps" });
    (n.captures || []).forEach((c) => grid.append(
      h("div", { class: "pcap", title: c.name },
        h("img", { src: "/api/captures/" + c.id + "/file", alt: c.name, loading: "lazy",
          onclick: () => openCapture(c.id, async () => { await loadNodes(); renderEdges(); const nn = state.nodesById[n.id]; if (nn) selectNode(nn); }) }),
        h("button", { class: "pcap-x", title: "remove from node", onclick: async () => {
          await api("DELETE", "/api/nodes/" + n.id + "/captures/" + c.id);
          await loadNodes(); renderEdges(); const nn = state.nodesById[n.id]; if (nn) selectNode(nn);
        } }, "×"))));
    if (!(n.captures || []).length) grid.append(h("div", { class: "sub" }, "None. Drag images onto the node or paste with Ctrl+V."));
    body.append(h("div", { class: "sec-h" }, "Captures"), grid,
      h("button", { class: "btn sm", style: "width:100%;justify-content:center", onclick: () =>
        pickFiles((f) => uploadFiles(f, n.id, async () => { await loadNodes(); renderEdges(); const nn = state.nodesById[n.id]; if (nn) selectNode(nn); })) },
        icon("i-upload"), "Upload capture"));
  } else if (state.panelTab === "Log") {
    body.append(panelLog(n));
  } else {
    body.append(noteTextField(n));
  }

  p.append(h("div", { class: "pp-actions" },
    h("button", { class: "btn pri", onclick: () => switchView("nodes", n.id) }, icon("i-layers"), "Record"),
    h("button", { class: "btn", title: "Duplicate", onclick: () => duplicateNode(n) }, icon("i-copy")),
    h("button", { class: "btn danger", title: "Delete", onclick: () => deleteNode(n) }, icon("i-trash"))));
}
function kv(label, control) {
  return h("div", { class: "kv" }, h("span", { class: "kv-l" }, label), control);
}
function kvField(n, key) {
  const inp = h("input", { class: "kv-in", value: n.props[key] || "", placeholder: "—" });
  inp.addEventListener("change", () => { n.props[key] = inp.value.trim(); saveNodeProps(n); });
  return kv(key.charAt(0).toUpperCase() + key.slice(1), inp);
}

function panelLog(n) {
  const wrap = h("div", {});
  const kindSel = h("select", { class: "mini" }, ...LOG_KINDS.map(([k, l]) => h("option", { value: k }, l)));
  const ta = h("textarea", { class: "note-ta", style: "min-height:70px", placeholder: "what you did, what came out, next step… (Ctrl+Enter)" });
  const listEl = h("div", { class: "plog" });
  const refresh = async () => {
    const log = await api("GET", "/api/node_notes?node_id=" + n.id).catch(() => []);
    listEl.innerHTML = "";
    if (!log.length) listEl.append(h("div", { class: "sub" }, "Nothing logged yet."));
    log.forEach((e) => listEl.append(h("div", { class: "plog-item" },
      h("div", { class: "plog-h" },
        h("span", { class: "pill " + (e.kind === "win" ? "done" : e.kind === "exploit" ? "high" : "info") },
          (LOG_KINDS.find((k) => k[0] === e.kind) || ["", e.kind])[1]),
        h("span", { class: "sub", style: "margin-left:auto" }, ago(e.created_at)),
        h("button", { class: "btn ghost sm", title: "delete", onclick: async () => {
          await api("DELETE", "/api/node_notes/" + e.id); refresh(); bumpNoteCount(n);
        } }, icon("i-x"))),
      h("div", { class: "plog-b" }, e.body))));
  };
  const add = async () => {
    if (!ta.value.trim()) return;
    await api("POST", "/api/node_notes", { node_id: n.id, body: ta.value.trim(), kind: kindSel.value });
    ta.value = ""; refresh(); bumpNoteCount(n);
  };
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); add(); } });
  wrap.append(
    h("div", { class: "sec-h" }, "Log"),
    h("div", { class: "plog-form" }, ta,
      h("div", { class: "plog-form-a" }, kindSel, h("button", { class: "btn pri sm", onclick: add }, icon("i-plus"), "Add"))),
    listEl);
  refresh();
  return wrap;
}

function bumpNoteCount(n) {
  api("GET", "/api/node_notes?node_id=" + n.id).then((log) => {
    if (n.counts) n.counts.notes = log.length;
  }).catch(() => {});
}
function noteTextField(n) {
  const ta = h("textarea", { class: "note-ta", placeholder: "note text..." }, (n.props && n.props.text) || "");
  let t; ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { n.props.text = ta.value; saveNodeProps(n); }, 350); });
  return h("div", { class: "pfield" }, h("label", {}, "Text"), ta);
}
async function saveNode(n, patch) { Object.assign(n, patch); await api("PATCH", "/api/nodes/" + n.id, patch).catch(() => {}); refreshNode(n); if (state.selNode === n) openNodePanel(n); touchSaved(); }
async function saveNodeProps(n) { await api("PATCH", "/api/nodes/" + n.id, { props: n.props }).catch(() => {}); refreshNode(n); touchSaved(); }
async function deleteNode(n) {
  const data = { type: n.type, name: n.name, status: n.status, x: n.x, y: n.y, color: n.color, props: n.props };
  const holder = { n };
  await api("DELETE", "/api/nodes/" + n.id).catch(() => {});
  if (n._el) n._el.remove(); delete state.nodesById[n.id];
  state.edges = state.edges.filter((e) => e.source_id !== n.id && e.target_id !== n.id);
  renderEdges(); deselect(); toast("Node deleted", "ok"); touchSaved();
  pushHist({
    undo: async () => { const nn = await api("POST", "/api/nodes", Object.assign({ project_id: state.pid }, data)); holder.n = nn; addNodeEl(nn); },
    redo: async () => { await api("DELETE", "/api/nodes/" + holder.n.id).catch(() => {}); if (holder.n._el) holder.n._el.remove(); delete state.nodesById[holder.n.id]; renderEdges(); },
  });
}
async function duplicateNode(n) {
  const nn = await api("POST", "/api/nodes", { project_id: state.pid, type: n.type, name: (n.name || "") + " copy",
    status: n.status, x: (n.x || 0) + 40, y: (n.y || 0) + 40, color: n.color, props: n.props });
  addNodeEl(nn); selectNode(nn);
}

function isTyping(t) { return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable); }
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !isTyping(e.target) && !state.space) { state.space = true; updateCursor(); }
  if (state.view !== "board" || isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const hasSel = state.selSet.size || state.selNode;
  if ((e.key === "Delete" || e.key === "Backspace") && (hasSel || state.selEdge)) { e.preventDefault(); deleteSelected(); }

  else if (mod && e.key.toLowerCase() === "d" && hasSel) { e.preventDefault(); duplicateSelected(); }
  else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === "Escape") { clearArrowSrc(); deselect(); }
});
document.addEventListener("keyup", (e) => { if (e.code === "Space") { state.space = false; updateCursor(); } });

function applyStroke(poly, s) {
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", s.color || "#f5334f");
  poly.setAttribute("stroke-width", s.width || 3);
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
}
function updatePoly(poly, s) { poly.setAttribute("points", s.points.map((p) => p.join(",")).join(" ")); }

function renderStrokes() {
  const svg = state._svg;
  if (!svg) return;
  $$("polyline", svg).forEach((p) => p.remove());
  state.drawing.forEach((s) => {
    const poly = document.createElementNS(SVGNS, "polyline");
    applyStroke(poly, s); updatePoly(poly, s); svg.append(poly);
  });
}

function bindDrawing(svg) {
  let cur = null, poly = null;
  const pt = (e) => screenToWorld(e.clientX, e.clientY).map(Math.round);
  svg.addEventListener("pointerdown", (e) => {
    if (state.mode === "draw") {
      e.preventDefault(); try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      cur = { color: state.penColor, width: state.penWidth, points: [pt(e)] };
      poly = document.createElementNS(SVGNS, "polyline"); applyStroke(poly, cur); updatePoly(poly, cur); svg.append(poly);
    } else if (state.mode === "erase") { eraseAt(pt(e)); }
  });
  svg.addEventListener("pointermove", (e) => {
    if (state.mode === "draw" && cur) { cur.points.push(pt(e)); updatePoly(poly, cur); }
    else if (state.mode === "erase" && e.buttons) { eraseAt(pt(e)); }
  });
  const end = () => {
    if (state.mode === "draw" && cur) {
      if (cur.points.length > 1) { state.drawing.push(cur); saveBoard(); } else if (poly) { poly.remove(); }
      cur = null; poly = null;
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

function eraseAt(p) {
  for (let i = state.drawing.length - 1; i >= 0; i--) {
    const s = state.drawing[i], th = 12 + (s.width || 3);
    if (s.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < th)) {
      state.drawing.splice(i, 1); renderStrokes(); saveBoard(); return;
    }
  }
}

async function loadDrawing() {
  try { const d = await api("GET", "/api/board"); state.drawing = JSON.parse(d.drawing || "[]") || []; }
  catch (e) { state.drawing = []; }
  renderStrokes();
}

let _boardT;
function saveBoard() {
  clearTimeout(_boardT);
  _boardT = setTimeout(() => api("PUT", "/api/board", { project_id: state.pid, drawing: state.drawing }).catch(() => {}), 300);
}

const CRED_STATUS = ["untested", "cracking", "cracked", "valid", "invalid"];
async function renderLoot() {
  const root = $("#v-loot");
  root.innerHTML = "";
  state.lootView = state.lootView || "list";
  const [creds, nodes] = await Promise.all([api("GET", "/api/creds"), api("GET", "/api/nodes").catch(() => [])]);
  state.lootNodes = nodes;
  const toggle = (v, label) => h("button", { class: "seg-btn" + (state.lootView === v ? " on" : ""),
    onclick: () => { state.lootView = v; renderLoot(); } }, label);
  root.append(headBar("loot", "Credentials and loot",
    h("div", { class: "seg" }, toggle("list", "List"), toggle("matrix", "Reuse matrix")),
    h("button", { class: "btn pri", onclick: () => addCredModal(null, renderLoot) }, icon("i-plus"), "Add")));

  if (state.lootView === "matrix") { root.append(await credMatrix(nodes)); return; }

  const c = h("div", { class: "card" });
  const tbl = h("table", { class: "t" },
    h("thead", {}, h("tr", {}, ["User", "Secret", "Kind", "Service", "Valid on", "Node", "Status", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  if (!creds.length) tb.append(h("tr", {}, h("td", { colspan: 8, class: "empty" }, "No credentials. Add what you find as you go.")));
  creds.forEach((cr) => tb.append(credRow(cr, renderLoot)));
  tbl.append(tb); c.append(tbl); root.append(c);
  root.append(h("div", { class: "sub" }, "It detects the hash type, tracks cracking status, and \u00abReuse matrix\u00bb marks where each credential works."));
}

function credRow(cr, reload, hideNode) {
  const secret = h("span", { class: "mono" }, mask(cr.secret));
  secret.style.cursor = "pointer"; secret.title = "click to reveal/copy";
  let shown = false;
  secret.onclick = () => {
    shown = !shown;
    secret.textContent = shown ? cr.secret : mask(cr.secret);
    if (shown) navigator.clipboard?.writeText(cr.secret).then(() => toast("Copied", "ok"));
  };
  const statusSel = h("select", { class: "mini" },
    ...CRED_STATUS.map((s) => h("option", { value: s, selected: s === cr.status }, s)));
  statusSel.onchange = async () => { await api("PATCH", "/api/creds/" + cr.id, { status: statusSel.value }); toast("Updated", "ok"); };
  const validN = (cr.valid_on || []).filter((v) => v.status === "valid").length;
  const cells = [
    h("td", { class: "mono" }, cr.username || "—"),
    h("td", {}, secret),
    h("td", {}, h("span", { class: "pill info" }, cr.kind),
      cr.hash_type ? h("span", { class: "sub hash-tag mono", title: "detected hash type" }, cr.hash_type) : ""),
    h("td", { class: "sub" }, cr.service || ""),
    h("td", {}, validN ? h("span", { class: "pill valid", title: "nodes where it is valid" }, "\u2713 " + validN) : h("span", { class: "sub" }, "\u2014")),
  ];
  if (!hideNode) {
    cells.push(h("td", {}, cr.node_id
      ? h("span", { class: "ntag", onclick: () => switchView("nodes", cr.node_id) },
        nodeIcon({ type: cr.node_type }, "ic tic"), cr.node_name || "node")
      : h("span", { class: "sub mono" }, cr.address || "—")));
  } else {
    cells.push(h("td", { class: "sub" }, cr.source || ""));
  }
  cells.push(h("td", {}, statusSel),
    h("td", { style: "text-align:right" },
      h("button", { class: "btn ghost sm", onclick: async () => { await api("DELETE", "/api/creds/" + cr.id); reload(); } }, icon("i-trash"))));
  return h("tr", {}, ...cells);
}

async function credMatrix() {
  const d = await api("GET", "/api/cred_matrix");
  if (!d.creds.length || !d.nodes.length) {
    const c = card(icon("i-key"), "Reuse matrix");
    c.append(h("div", { class: "empty" }, "You need credentials and nodes to build the matrix."));
    return c;
  }
  const CYCLE = { "": "valid", valid: "invalid", invalid: "" };
  const MARK = { valid: "✓", invalid: "✗", "": "" };
  const wrap = h("div", { class: "card matrix-wrap" });
  const tbl = h("table", { class: "t matrix" });
  const head = h("tr", {}, h("th", { class: "matrix-corner" }, "cred \\ node"));
  d.nodes.forEach((n) => head.append(h("th", { class: "matrix-node", title: n.name },
    h("div", { class: "matrix-nodelbl" }, nodeIcon(n, "ic tic"), h("span", {}, n.name || NODE_LABEL[n.type])))));
  const body = h("tbody");
  d.creds.forEach((cr) => {
    const tr = h("tr", {},
      h("td", { class: "matrix-cred" },
        h("span", { class: "mono" }, cr.username || "—"),
        cr.hash_type ? h("span", { class: "sub hash-tag mono" }, cr.hash_type) : (cr.kind === "hash" ? h("span", { class: "sub" }, "hash") : "")));
    d.nodes.forEach((n) => {
      const key = cr.id + ":" + n.id;
      const cell = h("td", { class: "matrix-cell" });
      const paint = (st) => { cell.textContent = MARK[st] || ""; cell.className = "matrix-cell " + (st || "empty"); };
      paint(d.cells[key] || "");
      cell.onclick = async () => {
        const next = CYCLE[d.cells[key] || ""];
        d.cells[key] = next; paint(next);
        if (next) await api("POST", "/api/creds/" + cr.id + "/nodes", { node_id: n.id, status: next });
        else await api("DELETE", "/api/creds/" + cr.id + "/nodes/" + n.id);
      };
      tr.append(cell);
    });
    body.append(tr);
  });
  tbl.append(h("thead", {}, head), body);
  wrap.append(h("div", { class: "matrix-scroll" }, tbl),
    h("div", { class: "sub", style: "padding:8px 12px" }, "Click a cell: untested \u2192 \u2713 valid \u2192 \u2717 invalid. Green = the credential works on that node."));
  return wrap;
}

function mask(s) { s = s || ""; return s.length <= 3 ? "•".repeat(s.length) : s.slice(0, 2) + "•".repeat(Math.min(6, s.length - 2)); }

function addCredModal(nodeId, reload) {
  const nodes = state.lootNodes || state.vaultNodes || [];
  const userIn = h("input", { placeholder: "administrator" });
  const secretIn = h("input", { placeholder: "P@ssw0rd / hash / $krb5tgs$..." });
  const kindSel = h("select", {}, ...["password", "hash", "key", "token"].map((k) => h("option", { value: k }, k)));
  const serviceIn = h("input", { placeholder: "smb:445" });
  const sourceIn = h("input", { placeholder: "LSASS dump" });
  const nodeSel = h("select", {}, h("option", { value: "" }, "\u2014 none \u2014"),
    ...nodes.map((n) => h("option", { value: n.id, selected: String(n.id) === String(nodeId) },
      (n.name || NODE_LABEL[n.type]) + " · " + NODE_LABEL[n.type])));
  const hint = h("div", { class: "hash-hint sub" });
  let hashType = "";
  secretIn.addEventListener("input", () => {
    const r = HASHID.detect(secretIn.value);
    hashType = r.primary;
    if (r.primary) {
      kindSel.value = "hash";
      hint.innerHTML = "";
      hint.append(icon("i-key", "ic"), h("b", {}, r.primary),
        r.mode ? h("span", { class: "mono" }, "  hashcat -m " + r.mode) : "");
      hint.style.display = "flex";
    } else { hint.style.display = "none"; }
  });

  const body = h("div", {},
    h("div", { class: "grid2" }, h("div", { class: "field" }, h("label", {}, "User"), userIn),
      h("div", { class: "field" }, h("label", {}, "Secret"), secretIn)),
    hint,
    h("div", { class: "grid2" }, h("div", { class: "field" }, h("label", {}, "Kind"), kindSel),
      h("div", { class: "field" }, h("label", {}, "Service"), serviceIn)),
    h("div", { class: "grid2" },
      nodeId ? h("div", { style: "display:none" }, nodeSel) : h("div", { class: "field" }, h("label", {}, "Source node"), nodeSel),
      h("div", { class: "field" }, h("label", {}, "Origin"), sourceIn)));
  hint.style.display = "none";
  openModalEl("Add credential", body, async () => {
    await api("POST", "/api/creds", {
      project_id: state.pid, username: userIn.value.trim(), secret: secretIn.value.trim(),
      kind: kindSel.value, hash_type: kindSel.value === "hash" ? hashType : "",
      service: serviceIn.value.trim(), source: sourceIn.value.trim(),
      node_id: nodeId || nodeSel.value || null });
    closeModal(); toast("Credential saved", "ok"); reload && reload();
  }, "Save");
  setTimeout(() => userIn.focus(), 60);
}

async function renderDocs(focusId) {
  const root = $("#v-docs");
  root.innerHTML = "";
  const [docs, deps, nodes] = await Promise.all([
    api("GET", "/api/docs"),
    state.deps ? Promise.resolve(state.deps) : api("GET", "/api/deps").catch(() => ({})),
    api("GET", "/api/nodes").catch(() => []),
  ]);
  state.deps = deps;
  state.docNodes = nodes;

  root.append(headBar("reports", "Documents",
    h("button", { class: "btn pri", onclick: () => newDocModal() }, icon("i-plus"), "New document")));

  if (!deps.markdown) {
    root.append(h("div", { class: "banner-warn" }, icon("i-help"),
      h("span", { class: "grow" }, "Without markdown-it-py the preview comes out raw. Install it with:"),
      h("code", {}, deps.hint_md || "sudo apt install python3-markdown-it")));
  }

  if (!docs.length) {
    const c = card(icon("i-note"), "Project reports");
    c.append(h("div", { class: "empty" },
      "No documents. Create one and use \u00abTemplate\u00bb to start from the report skeleton."));
    root.append(c);
    return;
  }

  const target = docs.find((d) => d.id === focusId) || docs[0];
  const list = h("div", { class: "doclist" });
  const editorWrap = h("div", { class: "docmain" });
  root.append(h("div", { class: "docs-area" }, list, editorWrap));

  const paintList = (activeId) => {
    list.innerHTML = "";
    list.append(h("div", { class: "rail-h" }, "Documents"));
    docs.forEach((d) => list.append(
      h("div", { class: "docitem" + (d.id === activeId ? " on" : ""), onclick: () => openDoc(d.id) },
        icon("i-note", "ic tic"),
        h("div", { class: "grow" }, h("div", { class: "docitem-t" }, d.title),
          h("div", { class: "sub" }, human(d.size) + " · " + ago(d.updated_at))))));
  };
  const openDoc = async (id) => { paintList(id); await mountEditor(editorWrap, id); };
  await openDoc(target.id);
}

function newDocModal() {
  openModal("New document", [field("title", "Title", "Audit report \u2014 client")], async (v) => {
    const d = await api("POST", "/api/docs", { project_id: state.pid, title: v.title || "Untitled report", body: "" });
    closeModal(); toast("Document created", "ok"); renderDocs(d.id);
  });
}

async function mountEditor(host, docId) {
  const d = await api("GET", "/api/docs/" + docId);
  host.innerHTML = "";
  state.curDoc = d;
  state.docMode = state.docMode || "rich";

  const titleIn = h("input", { class: "big-name", value: d.title || "" });
  const rich = h("div", { class: "markdown-body wysiwyg", contenteditable: "true", spellcheck: "false",
    "data-ph": "Write here. Markdown shortcuts work too: type # and a space for a heading, - for a list, > for a quote, ``` for code." });
  const source = h("textarea", { class: "mdedit", spellcheck: "false", hidden: true });
  const statusEl = h("span", { class: "sub docstatus" }, "saved");
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (_) {}

  const currentMd = () => state.docMode === "source" ? source.value : richToMd(rich);
  let saveT;
  const save = async (quiet) => {
    clearTimeout(saveT);
    statusEl.textContent = "saving\u2026";
    const up = await api("PATCH", "/api/docs/" + docId, { title: titleIn.value.trim() || d.title, body: currentMd() });
    state.curDoc = up;
    statusEl.textContent = "saved " + new Date().toLocaleTimeString();
    if (!quiet) toast("Saved", "ok");
    return up;
  };
  const queueSave = () => { clearTimeout(saveT); statusEl.textContent = "unsaved\u2026"; saveT = setTimeout(() => save(true), 900); };
  state.saveDoc = save;

  const markEmpty = () => rich.classList.toggle("is-empty", !rich.textContent.trim() && !rich.querySelector(".mdchip,img"));
  async function loadRich(md) {
    const frag = await mdToRich(md, state.docNodes);
    rich.innerHTML = "";
    while (frag.firstChild) rich.append(frag.firstChild);
    normalizeEditor(rich);
    markEmpty();
  }

  rich.addEventListener("input", () => { markEmpty(); queueSave(); });
  rich.addEventListener("keydown", (e) => richKeydown(e, rich, save, queueSave));
  rich.addEventListener("paste", (e) => richPaste(e, rich, queueSave));
  rich.addEventListener("click", (e) => richChipClick(e, rich, queueSave));
  source.addEventListener("input", queueSave);
  titleIn.addEventListener("change", () => save(true).then(() => renderDocs(docId)));

  const insertMd = async (md) => {
    if (state.docMode === "source") { insertAt(source, "\n" + md.trim() + "\n"); queueSave(); return; }
    const frag = await mdToRich(md, state.docNodes);
    insertNodesAtCaret(rich, [...frag.childNodes]);
    queueSave();
  };

  const tb = (ic, title, fn, label) => h("button", { class: "tbtn", title, onmousedown: (e) => e.preventDefault(), onclick: fn },
    icon(ic), label ? h("span", { class: "tbtn-l" }, label) : "");

  const modeToggle = h("div", { class: "tgroup" },
    h("button", { class: "tbtn" + (state.docMode === "rich" ? " on" : ""), title: "Visual editor",
      onclick: () => setMode("rich") }, icon("i-eye")),
    h("button", { class: "tbtn" + (state.docMode === "source" ? " on" : ""), title: "View the Markdown",
      onclick: () => setMode("source") }, icon("i-split")));

  async function setMode(m) {
    if (m === state.docMode) return;
    if (m === "source") { source.value = richToMd(rich); }
    else { await loadRich(source.value); }
    state.docMode = m;
    rich.hidden = m !== "rich"; source.hidden = m !== "source";
    $$(".tbtn", modeToggle).forEach((b, i) => b.classList.toggle("on", (i === 0) === (m === "rich")));
    $$(".fmt-only", bar).forEach((b) => b.disabled = m === "source");
  }

  const fmt = (ic, title, fn, label) => {
    const b = tb(ic, title, () => { fn(); queueSave(); }, label);
    b.classList.add("fmt-only");
    return b;
  };

  const bar = h("div", { class: "wtoolbar docbar" },
    h("div", { class: "tgroup" },
      fmt("i-h1", "Heading", () => cycleHeading(rich)),
      fmt("i-bold", "Bold (Ctrl+B)", () => document.execCommand("bold")),
      fmt("i-italic", "Italic (Ctrl+I)", () => document.execCommand("italic")),
      fmt("i-terminal", "Inline code", () => wrapInline("code")),
      fmt("i-list2", "List", () => document.execCommand("insertUnorderedList")),
      fmt("i-table", "Table", () => insertMd("| Field | Value |\n|---|---|\n|  |  |\n")),
      fmt("i-pdf", "Code block", () => editCodeChip(null, rich, queueSave))),
    h("div", { class: "tgroup" },
      tb("i-note", "Full report template", async () => {
        const has = richToMd(rich).trim().length;
        if (has && !confirm("Insert the report template into the document?")) return;
        const r = await api("GET", "/api/snippets/template");
        await insertMd(r.markdown);
      }, "Template"),
      tb("i-layers", "Insert a node's data table", () => pickNodeSnippet(insertMd), "Node"),
      tb("i-image", "Insert a capture from the vault", () => pickCaptureSnippet(insertMd), "Capture"),
      tb("i-flag", "Insert the project findings", async () => {
        const r = await api("GET", "/api/snippets/findings"); await insertMd(r.markdown);
      }, "Findings"),
      tb("i-link", "Link a node with [[...]]", () => pickWikilink(insertMd), "[[ ]]")),
    modeToggle,
    h("div", { class: "tgroup docbar-r" },
      statusEl,
      tb("i-save", "Save (Ctrl+S)", () => save()),
      tb("i-download", "Download .md", async () => { await save(true); location.assign("/api/docs/" + docId + "/export.md"); }),
      h("button", { class: "btn pri sm", title: state.deps.pdf ? "Export to PDF" : "Requires ReportLab",
        onclick: () => exportPdf(docId) }, icon("i-pdf"), "PDF"),
      tb("i-trash", "Delete document", async () => {
        if (!confirm("Delete \u00ab" + (state.curDoc.title || "") + "\u00bb?")) return;
        await api("DELETE", "/api/docs/" + docId); toast("Document deleted", "ok"); renderDocs();
      })));

  host.append(h("div", { class: "docheadrow" }, titleIn), bar, h("div", { class: "docpane" }, rich, source));
  await loadRich(d.body || "");
}

async function mdToRich(md, nodes) {
  const box = document.createElement("div");
  const r = await api("POST", "/api/render", { project_id: state.pid, body: md || "" });
  injectPygments(r.css);
  box.innerHTML = r.html;

  box.querySelectorAll("figure").forEach((fig) => {
    const chip = figureChip(fig), p = fig.parentElement;
    if (p && p !== box && p.tagName === "P" && !p.textContent.trim()) p.replaceWith(chip);
    else fig.replaceWith(chip);
  });
  box.querySelectorAll(".codewrap").forEach((el) => el.replaceWith(codeChip(el)));
  box.querySelectorAll("table").forEach((el) => el.replaceWith(mdChip("tbl-chip", htmlTableToMd(el), el.cloneNode(true))));
  box.querySelectorAll(".wikilink").forEach((w) => w.replaceWith(wikiChip(w, nodes)));
  return box;
}
function codeChip(wrap) {
  const pre = wrap.querySelector("pre");
  const code = (pre ? pre.textContent : wrap.textContent).replace(/\n$/, "");
  const lang = wrap.dataset.lang || "";
  const md = "```" + lang + "\n" + code + "\n```";
  const display = h("div", { class: "codewrap" }); display.innerHTML = wrap.innerHTML;
  return mdChip("cb-chip", md, display);
}
function figureChip(fig) {
  const img = fig.querySelector("img"), cap = fig.querySelector("figcaption");
  const src = img ? img.getAttribute("src") : "";
  const text = cap ? cap.textContent : (img ? img.getAttribute("alt") || "" : "");
  return mdChip("img-chip", "![" + text + "](" + src + ")", fig.cloneNode(true));
}
function mdChip(kind, md, displayNode) {
  const chip = h("div", { class: "mdchip " + kind, contenteditable: "false" });
  chip.dataset.md = md;
  chip.append(
    h("div", { class: "mdchip-tools" },
      h("button", { class: "chip-edit", title: "edit", type: "button" }, icon("i-pen")),
      h("button", { class: "chip-del", title: "remove", type: "button" }, icon("i-x"))),
    h("div", { class: "mdchip-body" }, displayNode));
  return chip;
}
function wikiChip(w, nodes) {
  const nid = +(w.dataset.nodeId || 0);
  const node = (nodes || []).find((n) => n.id === nid);
  const name = node ? node.name : (w.textContent || "").trim();
  const chip = h("span", { class: "wikichip" + (nid ? "" : " broken"), contenteditable: "false",
    "data-name": name, title: nid ? "open the node record" : "no node with that name" },
    icon("i-layers", "ic tic"), name);
  if (nid) chip.dataset.nodeId = nid;
  return chip;
}

function richToMd(root) {
  return blocksToMd(root).replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function blocksToMd(root) {
  const kids = [...root.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent.trim()));
  const hasBlock = kids.some((n) => n.nodeType === 1 &&
    (/^(H[1-6]|P|DIV|UL|OL|BLOCKQUOTE|HR|TABLE|PRE)$/.test(n.tagName) || (n.dataset && n.dataset.md != null)));
  if (!hasBlock) return inlineToMd(root).trim();
  const out = [];
  kids.forEach((n) => { const b = blockToMd(n); if (b !== "") out.push(b); });
  return out.join("\n\n");
}
function blockToMd(node) {
  if (node.nodeType === 3) { const t = node.textContent.trim(); return t ? leadingEsc(escInline(t)) : ""; }
  if (node.nodeType !== 1) return "";
  if (node.dataset && node.dataset.md != null) return node.dataset.md;
  const tag = node.tagName;
  if (/^H[1-6]$/.test(tag)) return "#".repeat(+tag[1]) + " " + inlineToMd(node).trim();
  if (tag === "UL") return listToMd(node, false);
  if (tag === "OL") return listToMd(node, true);
  if (tag === "BLOCKQUOTE") return blocksToMd(node).split("\n").map((l) => l ? "> " + l : ">").join("\n");
  if (tag === "HR") return "---";
  if (tag === "PRE") return "```\n" + node.textContent.replace(/\n$/, "") + "\n```";
  if (tag === "TABLE") return htmlTableToMd(node);
  if (tag === "FIGURE") { const i = node.querySelector("img"), c = node.querySelector("figcaption"); return i ? "![" + (c ? c.textContent : "") + "](" + i.getAttribute("src") + ")" : ""; }
  const s = inlineToMd(node).trim();
  return s ? leadingEsc(s) : "";
}
function inlineToMd(el) {
  let s = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) { s += escInline(n.textContent); return; }
    if (n.nodeType !== 1) return;
    if (n.classList && n.classList.contains("wikichip")) { s += "[[" + (n.dataset.name || n.textContent.trim()) + "]]"; return; }
    const t = n.tagName;
    if (t === "STRONG" || t === "B") s += "**" + inlineToMd(n) + "**";
    else if (t === "EM" || t === "I") s += "*" + inlineToMd(n) + "*";
    else if (t === "CODE") s += "`" + n.textContent + "`";
    else if (t === "A") s += "[" + inlineToMd(n) + "](" + (n.getAttribute("href") || "") + ")";
    else if (t === "BR") s += "\n";
    else s += inlineToMd(n);
  });
  return s;
}
function listToMd(el, ordered) {
  const lines = [];
  let i = 1;
  [...el.children].forEach((li) => {
    if (li.tagName !== "LI") return;
    const inlineParts = [], nested = [];
    [...li.childNodes].forEach((ch) => {
      if (ch.nodeType === 1 && (ch.tagName === "UL" || ch.tagName === "OL")) nested.push(ch);
      else inlineParts.push(ch);
    });
    const tmp = document.createElement("div");
    inlineParts.forEach((n) => tmp.append(n.cloneNode(true)));
    lines.push((ordered ? (i++) + ". " : "- ") + inlineToMd(tmp).trim());
    nested.forEach((n) => listToMd(n, n.tagName === "OL").split("\n").forEach((s) => lines.push("  " + s)));
  });
  return lines.join("\n");
}
function htmlTableToMd(t) {
  const rows = [...t.rows].map((r) => [...r.cells].map((c) => inlineToMd(c).trim().replace(/\|/g, "\\|") || " "));
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { while (r.length < cols) r.push(" "); return r; };
  const head = pad(rows[0]);
  let out = "| " + head.join(" | ") + " |\n|" + head.map(() => "---").join("|") + "|";
  rows.slice(1).forEach((r) => { out += "\n| " + pad(r).join(" | ") + " |"; });
  return out;
}

function escInline(t) { return t.replace(/([\\`*[\]|])/g, "\\$1"); }
function leadingEsc(s) { return s.replace(/^(\s*)(#{1,6}\s|>\s?|[-+]\s|\d+\.\s)/, (m, w, mk) => w + "\\" + mk); }

function topBlock(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.getRangeAt(0).startContainer;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.parentNode === root ? n : null;
}
function isChip(el) { return el && el.nodeType === 1 && el.classList && el.classList.contains("mdchip"); }
function emptyP() { return h("p", {}, h("br")); }

function isEmptyP(el) {
  return el && el.tagName === "P" && !el.textContent.trim() && !el.querySelector("img,.mdchip");
}
function normalizeEditor(root) {
  if (!root.firstElementChild) { root.append(emptyP()); return; }
  if (isChip(root.firstElementChild)) root.insertBefore(emptyP(), root.firstElementChild);
  if (isChip(root.lastElementChild)) root.append(emptyP());
  [...root.children].forEach((el) => {
    if (isChip(el) && isChip(el.previousElementSibling)) root.insertBefore(emptyP(), el);
  });

  [...root.children].forEach((el) => { if (isEmptyP(el) && isEmptyP(el.previousElementSibling)) el.remove(); });
}
function insertNodesAtCaret(root, nodes) {
  const nn = nodes.filter((n) => !(n.nodeType === 3 && !n.textContent.trim()));
  if (!nn.length) return;
  let anchor = topBlock(root);

  if (anchor && anchor.tagName === "P" && !anchor.textContent.trim() && !anchor.querySelector("img,.mdchip")) {
    const first = nn.shift(); root.replaceChild(first, anchor); anchor = first;
  } else if (!anchor) {
    root.append(nn.shift()); anchor = root.lastChild;
  }
  nn.forEach((n) => { anchor.after(n); anchor = n; });
  normalizeEditor(root);

  let after = anchor.nextElementSibling;
  if (!after || isChip(after)) { after = emptyP(); anchor.after(after); }
  placeCaretIn(after);
  root.dispatchEvent(new Event("input"));
}
function wrapInline(tag) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const el = document.createElement(tag);
  if (r.collapsed) { el.textContent = tag === "code" ? "code" : "text"; r.insertNode(el); }
  else { try { r.surroundContents(el); } catch (_) { el.appendChild(r.extractContents()); r.insertNode(el); } }
  const nr = document.createRange(); nr.selectNodeContents(el);
  sel.removeAllRanges(); sel.addRange(nr);
}
const HEADING_CYCLE = { P: "H2", H2: "H3", H3: "P", H1: "P", H4: "P", DIV: "H2" };
function cycleHeading(root) {
  const b = topBlock(root);
  if (!b || (b.dataset && b.dataset.md != null)) return;
  document.execCommand("formatBlock", false, HEADING_CYCLE[b.tagName] || "H2");
}

function richKeydown(e, root, save, queueSave) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); return save(); }
  if (e.key === " ") { if (blockShortcut(root)) { e.preventDefault(); queueSave(); } return; }
  if (e.key === "Enter") {
    const b = topBlock(root);
    if (b && /^H[1-6]$/.test(b.tagName) && atBlockEnd(b)) {
      e.preventDefault(); const p = h("p", {}, h("br")); b.after(p);
      const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); queueSave(); return;
    }
    if (b && b.textContent.replace(/ /g, " ").trim() === "```") {
      e.preventDefault(); b.remove(); editCodeChip(null, root, queueSave); return;
    }
  }
}
function atBlockEnd(b) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(b); r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().trim() === "";
}
function blockShortcut(root) {
  const b = topBlock(root);
  if (!b || (b.dataset && b.dataset.md != null)) return false;
  const txt = b.textContent.replace(/ /g, " ");
  const map = { "#": "H1", "##": "H2", "###": "H3", "####": "H4" };
  if (map[txt]) { setBlockTag(b, map[txt]); return true; }
  if (txt === ">") { document.execCommand("formatBlock", false, "BLOCKQUOTE"); b.textContent = ""; placeCaretIn(topBlock(root) || b); return true; }
  if (txt === "-" || txt === "*") { b.textContent = ""; document.execCommand("insertUnorderedList"); return true; }
  if (txt === "1.") { b.textContent = ""; document.execCommand("insertOrderedList"); return true; }
  return false;
}
function setBlockTag(b, tag) {
  document.execCommand("formatBlock", false, tag);
  const nb = topBlock(b.closest(".wysiwyg")) || b;
  nb.textContent = ""; placeCaretIn(nb);
}
function placeCaretIn(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

async function richPaste(e, root, queueSave) {
  const files = [...(e.clipboardData?.files || [])].filter((f) => (f.type || "").startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    const before = await api("GET", "/api/captures");
    await uploadFiles(files, null, null);
    const after = await api("GET", "/api/captures");
    const fresh = after.filter((c) => !before.some((b) => b.id === c.id));
    for (const c of fresh) {
      const frag = await mdToRich("![" + (c.name || "capture") + "](/api/captures/" + c.id + "/file)", state.docNodes);
      insertNodesAtCaret(root, [...frag.childNodes]);
    }
    queueSave(); return;
  }
  const text = e.clipboardData?.getData("text/plain");
  if (text != null) { e.preventDefault(); document.execCommand("insertText", false, text); queueSave(); }
}

function richChipClick(e, root, queueSave) {
  const del = e.target.closest(".chip-del");
  if (del) { e.preventDefault(); del.closest(".mdchip").remove(); normalizeEditor(root); queueSave(); return; }
  const ed = e.target.closest(".chip-edit");
  if (ed) {
    e.preventDefault();
    const chip = ed.closest(".mdchip");
    if (chip.classList.contains("cb-chip")) editCodeChip(chip, root, queueSave);
    else if (chip.classList.contains("tbl-chip")) editTableChip(chip, queueSave);
    else if (chip.classList.contains("img-chip")) editImageChip(chip, queueSave);
  }
}
async function replaceChipMd(chip, md, queueSave) {
  const frag = await mdToRich(md, state.docNodes);
  const fresh = frag.firstElementChild;
  if (fresh) { const root = chip.closest(".wysiwyg"); chip.replaceWith(fresh); if (root) normalizeEditor(root); queueSave(); }
}
function editCodeChip(chip, root, queueSave) {
  let lang = "", code = "";
  if (chip) { const m = /^```(\w*)\n([\s\S]*)\n```$/.exec(chip.dataset.md || ""); if (m) { lang = m[1]; code = m[2]; } }
  const langIn = h("input", { value: lang, placeholder: "bash, powershell, python, sql\u2026" });
  const codeIn = h("textarea", { class: "mdedit", spellcheck: "false", style: "min-height:260px" }, code);
  openModalEl("Code block", h("div", { class: "editor" },
    h("div", { class: "field" }, h("label", {}, "Language (optional)"), langIn),
    h("div", { class: "field", style: "margin:0" }, h("label", {}, "Code"), codeIn)),
    async () => {
      const md = "```" + langIn.value.trim() + "\n" + codeIn.value.replace(/\n$/, "") + "\n```";
      closeModal();
      if (chip) return replaceChipMd(chip, md, queueSave);
      const frag = await mdToRich(md, state.docNodes);
      insertNodesAtCaret(root, [...frag.childNodes]); queueSave();
    }, "Save");
  setTimeout(() => codeIn.focus(), 60);
}
function editTableChip(chip, queueSave) {
  const ta = h("textarea", { class: "mdedit", spellcheck: "false", style: "min-height:200px" }, chip.dataset.md || "");
  openModalEl("Edit table", h("div", { class: "editor" },
    h("p", { class: "sub" }, "Markdown table. One row per line; separate columns with \u00ab|\u00bb."),
    h("div", { class: "field", style: "margin:0" }, ta)),
    () => { closeModal(); replaceChipMd(chip, ta.value.trim(), queueSave); }, "Save");
  setTimeout(() => ta.focus(), 60);
}
function editImageChip(chip, queueSave) {
  const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(chip.dataset.md || "");
  const capIn = h("input", { value: m ? m[1] : "", placeholder: "what the capture shows" });
  const src = m ? m[2] : "";
  openModalEl("Capture caption", h("div", { class: "editor" },
    src ? h("img", { src, style: "max-width:100%;border-radius:8px;border:1px solid var(--line2);margin-bottom:10px" }) : "",
    h("div", { class: "field", style: "margin:0" }, h("label", {}, "Description"), capIn)),
    () => { closeModal(); replaceChipMd(chip, "![" + capIn.value.trim() + "](" + src + ")", queueSave); }, "Save");
  setTimeout(() => capIn.focus(), 60);
}

async function exportPdf(docId) {
  if (state.saveDoc) await state.saveDoc(true);
  if (!state.deps.pdf) {
    return openModalEl("Export to PDF",
      h("div", {},
        h("p", {}, "The PDF is generated by ReportLab, which is not installed. Install it with:"),
        h("pre", { class: "cmdbox" }, state.deps.hint_pdf || "sudo apt install python3-reportlab"),
        h("p", { class: "sub" }, "Then restart ATLAS and the PDF button will work. "
          + "In the meantime you can download the .md or print the preview with Ctrl+P.")),
      null, null,
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onclick: () => { closeModal(); window.print(); } }, icon("i-download"), "Print the preview"),
        h("button", { class: "btn pri", onclick: closeModal }, "Got it")));
  }
  const r = await fetch("/api/docs/" + docId + "/export.pdf?download=1");
  if (!r.ok) { const e = await r.json().catch(() => ({})); return toast(e.error || "could not generate the PDF", "err"); }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: (state.curDoc.title || "report").replace(/[^\w-]+/g, "-").toLowerCase() + ".pdf" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  const kept = r.headers.get("X-Atlas-Saved-To");
  toast(kept ? "PDF generated and saved as " + kept : "PDF generated", "ok");
}

let _pygDone = false;
function injectPygments(css) {
  if (_pygDone || !css) return;
  document.head.append(h("style", { html: css }));
  _pygDone = true;
}

function insertAt(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  ta.focus(); ta.setSelectionRange(pos, pos);
}

function pickNodeSnippet(insert) {
  const nodes = state.docNodes || [];
  if (!nodes.length) return toast("No nodes yet", "");
  const listEl = h("div", { class: "picklist" });
  nodes.forEach((n) => listEl.append(
    h("div", { class: "pickrow", onclick: async () => {
      const r = await api("GET", "/api/snippets/node?node_id=" + n.id);
      closeModal(); insert("\n" + r.markdown);
    } },
      nodeIcon(n, "ic tic"),
      h("span", { class: "grow" }, n.name || NODE_LABEL[n.type]),
      h("span", { class: "sub" }, NODE_LABEL[n.type]),
      h("span", { class: "cchips" },
        countChip("i-server", (n.counts || {}).services, "ports"),
        countChip("i-users", (n.counts || {}).users, "users"),
        countChip("i-key", (n.counts || {}).creds, "credentials"),
        countChip("i-image", (n.counts || {}).captures, "captures")))));
  openModalEl("Insert a node's data", h("div", {},
    h("p", { class: "sub" }, "Inserts a table with its identity plus its ports, users, credentials and evidence."),
    listEl), null, null,
    h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: closeModal }, "Cancel")));
}

async function pickCaptureSnippet(insert) {
  const caps = await api("GET", "/api/captures");
  if (!caps.length) return toast("The vault is empty", "");
  const grid = h("div", { class: "vgrid pickgrid" });
  caps.forEach((c) => grid.append(captureCard(c, {
    onOpen: async () => {
      const r = await api("GET", "/api/snippets/capture?capture_id=" + c.id);
      closeModal(); insert("\n" + r.markdown);
    }, showNodes: true })));
  openModalEl("Insert a capture", h("div", { class: "editor" },
    h("p", { class: "sub" }, "You can also paste directly with Ctrl+V inside the editor."),
    grid), null, null,
    h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: closeModal }, "Cancel")));
}

function pickWikilink(insert) {
  const nodes = state.docNodes || [];
  if (!nodes.length) return toast("No nodes yet", "");
  const listEl = h("div", { class: "picklist" });
  nodes.forEach((n) => listEl.append(
    h("div", { class: "pickrow", onclick: () => { closeModal(); insert("[[" + (n.name || "") + "]]"); } },
      nodeIcon(n, "ic tic"), h("span", { class: "grow" }, n.name || NODE_LABEL[n.type]),
      h("span", { class: "sub mono" }, nodeSub(n)))));
  openModalEl("Link a node", h("div", {},
    h("p", { class: "sub" }, "In the preview the link opens the node record. In the PDF it comes out as the name in bold."),
    listEl), null, null,
    h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: closeModal }, "Cancel")));
}

async function renderFindings() {
  const root = $("#v-findings");
  root.innerHTML = "";
  const [list, nodes] = await Promise.all([api("GET", "/api/findings"), api("GET", "/api/nodes").catch(() => [])]);
  state.lootNodes = nodes;
  root.append(headBar("findings", "Findings",
    h("button", { class: "btn pri", onclick: () => openFinding(null, { reload: renderFindings }) }, icon("i-plus"), "New finding")));

  const bySev = { crit: 0, high: 0, med: 0, low: 0, info: 0 };
  list.forEach((f) => { bySev[f.severity] = (bySev[f.severity] || 0) + 1; });
  root.append(metricsRow([["Total", list.length], ["Critical", bySev.crit, "crit"],
    ["High", bySev.high], ["Medium", bySev.med], ["Low", bySev.low], ["Info", bySev.info]]));

  const open = list.filter((f) => !["remediated", "accepted"].includes(f.status));
  const closed = list.filter((f) => ["remediated", "accepted"].includes(f.status));
  const c = card(icon("i-flag"), "Open");
  if (!open.length) c.append(h("div", { class: "empty" },
    "No open findings. Create them here or on a node record; the \u00abFindings\u00bb button then drops them into the report."));
  open.forEach((f) => c.append(findingRow(f, renderFindings)));
  root.append(c);
  if (closed.length) {
    const c2 = card(icon("i-check"), "Closed");
    closed.forEach((f) => c2.append(findingRow(f, renderFindings)));
    root.append(c2);
  }
}

function cvssBuilder(f, onSeverity) {
  let version = f.cvss_version || "3.1";
  let m = CVSS.defaults(version);
  if (f.cvss_vector) { const p = CVSS.parse(f.cvss_vector); version = p.version || version; m = Object.assign(CVSS.defaults(version), p.metrics); }
  let enabled = !!f.cvss_vector || !f.id;

  const scoreBadge = h("span", { class: "cvss-score pill info" }, "—");
  const vectorEl = h("div", { class: "cvss-vector mono" });
  const noteEl = h("div", { class: "sub cvss-note" });
  const metricsWrap = h("div", { class: "cvss-metrics" });
  const verSel = h("select", { class: "mini" },
    h("option", { value: "3.1", selected: version === "3.1" }, "CVSS 3.1"),
    h("option", { value: "4.0", selected: version === "4.0" }, "CVSS 4.0"));
  const onChk = h("input", { type: "checkbox" }); onChk.checked = enabled;

  const recalc = () => {
    const r = enabled ? CVSS.evaluate(version, m) : null;
    if (r) {
      scoreBadge.textContent = r.score.toFixed(1);
      scoreBadge.className = "cvss-score pill " + r.severity;
      vectorEl.textContent = r.vector;
      noteEl.textContent = r.exact ? ("Severity: " + r.severityName)
        : ("Estimated severity: " + r.severityName + " \u00b7 the exact CVSS 4.0 score needs the official table (\u2248)");
      onSeverity && onSeverity(r.severity);
    } else {
      scoreBadge.textContent = "—"; scoreBadge.className = "cvss-score pill info";
      vectorEl.textContent = ""; noteEl.textContent = "No CVSS: severity is set by hand.";
    }
  };
  const build = () => {
    metricsWrap.innerHTML = "";
    CVSS.metrics(version).forEach((def) => {
      const sel = h("select", { class: "mini" }, ...def.opts.map(([v, lab]) =>
        h("option", { value: v, selected: (m[def.k] || CVSS.defaults(version)[def.k]) === v }, lab)));
      sel.onchange = () => { m[def.k] = sel.value; recalc(); };
      metricsWrap.append(h("div", { class: "cvss-metric" }, h("label", {}, def.label), sel));
    });
    metricsWrap.style.display = enabled ? "" : "none";
    verSel.disabled = !enabled;
  };
  verSel.onchange = () => { version = verSel.value; m = CVSS.defaults(version); build(); recalc(); };
  onChk.onchange = () => { enabled = onChk.checked; build(); recalc(); };
  build(); recalc();

  const el = h("div", { class: "cvss-box" },
    h("div", { class: "cvss-head" },
      h("label", { class: "cvss-toggle" }, onChk, "CVSS"), verSel, scoreBadge,
      h("span", { class: "grow" }), noteEl),
    metricsWrap, vectorEl);
  return { el, get: () => enabled
    ? { cvss_version: version, cvss_vector: CVSS.toVector(version, m), cvss_score: (CVSS.evaluate(version, m) || {}).score }
    : { cvss_version: "", cvss_vector: "", cvss_score: null } };
}

async function openFinding(fid, opts) {
  opts = opts || {};
  const reload = opts.reload || (() => {});
  const [f, nodes, caps] = await Promise.all([
    fid ? api("GET", "/api/findings/" + fid) : Promise.resolve({}),
    (state.lootNodes && state.lootNodes.length) ? Promise.resolve(state.lootNodes) : api("GET", "/api/nodes").catch(() => []),
    api("GET", "/api/captures").catch(() => []),
  ]);
  state.lootNodes = nodes;
  const capById = Object.fromEntries(caps.map((c) => [c.id, c]));
  let assetIds = f.assets ? f.assets.map((a) => a.id) : (opts.nodeId ? [+opts.nodeId] : []);
  let evidenceIds = f.evidence ? f.evidence.map((c) => c.id) : [];

  const titleIn = h("input", { class: "big-name", placeholder: "MSSQL with a weak sa password", value: f.title || "" });
  const sevSel = h("select", { class: "mini" }, ...["info", "low", "med", "high", "crit"].map((s) =>
    h("option", { value: s, selected: (f.severity || "med") === s }, SEV_LABEL[s])));
  const statusSel = h("select", { class: "mini" }, ...FIND_STATUS.map(([s, l]) =>
    h("option", { value: s, selected: (f.status || "open") === s }, l)));
  const likeSel = h("select", { class: "mini" }, ...[["", "\u2014"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([v, l]) =>
    h("option", { value: v, selected: (f.likelihood || "") === v }, l)));
  const cvss = cvssBuilder(f, (sev) => { sevSel.value = sev; });

  const ta = (val, ph) => h("textarea", { class: "nd-ta", placeholder: ph || "" }, val || "");
  const descIn = ta(f.description || f.detail, "what the vulnerability is and where");
  const impactIn = ta(f.impact, "what an attacker gains / business impact");
  const pocIn = ta(f.poc, "steps to reproduce it, commands, payloads");
  const remedIn = ta(f.remediation, "how to fix it");
  const refsIn = ta(f.refs, "CVE-2023-1234\nCWE-89\nOWASP A03:2021");

  const assetChips = h("div", { class: "chips" });
  const assetSel = h("select", { class: "mini" });
  const paintAssets = () => {
    assetChips.innerHTML = "";
    if (!assetIds.length) assetChips.append(h("span", { class: "sub" }, "no assets assigned"));
    assetIds.forEach((id) => {
      const n = nodes.find((x) => x.id === id) || { name: "node " + id, type: "generic" };
      assetChips.append(h("span", { class: "chip" }, nodeIcon(n, "ic tic"), n.name || NODE_LABEL[n.type],
        h("button", { class: "chip-x", onclick: () => { assetIds = assetIds.filter((x) => x !== id); paintAssets(); } }, "×")));
    });
    assetSel.innerHTML = "";
    assetSel.append(h("option", { value: "" }, "\uff0b add affected asset\u2026"));
    nodes.filter((n) => !assetIds.includes(n.id)).forEach((n) =>
      assetSel.append(h("option", { value: n.id }, (n.name || NODE_LABEL[n.type]) + " · " + NODE_LABEL[n.type])));
  };
  assetSel.onchange = () => { if (assetSel.value) { assetIds.push(+assetSel.value); paintAssets(); } };
  paintAssets();

  const evChips = h("div", { class: "chips" });
  const evSel = h("select", { class: "mini" });
  const paintEv = () => {
    evChips.innerHTML = "";
    if (!evidenceIds.length) evChips.append(h("span", { class: "sub" }, "no evidence"));
    evidenceIds.forEach((id) => {
      const c = capById[id] || { name: "capture " + id };
      evChips.append(h("span", { class: "chip evchip" },
        h("img", { src: "/api/captures/" + id + "/file", alt: c.name }), c.name || "capture",
        h("button", { class: "chip-x", onclick: () => { evidenceIds = evidenceIds.filter((x) => x !== id); paintEv(); } }, "×")));
    });
    evSel.innerHTML = "";
    evSel.append(h("option", { value: "" }, "\uff0b add evidence from the vault\u2026"));
    caps.filter((c) => !evidenceIds.includes(c.id)).forEach((c) => evSel.append(h("option", { value: c.id }, c.name || ("capture " + c.id))));
  };
  evSel.onchange = () => { if (evSel.value) { evidenceIds.push(+evSel.value); paintEv(); } };
  paintEv();

  const fieldBlock = (label, el) => h("div", { class: "pfield" }, h("label", {}, label), el);
  const editor = h("div", { class: "editor find-editor" },
    h("div", { class: "find-head" },
      f.code ? h("span", { class: "find-code mono big" }, f.code) : "",
      titleIn),
    h("div", { class: "grid3" },
      fieldBlock("Severity", sevSel), fieldBlock("Status", statusSel), fieldBlock("Likelihood", likeSel)),
    fieldBlock("CVSS", cvss.el),
    fieldBlock("Description", descIn),
    fieldBlock("Impact", impactIn),
    fieldBlock("Reproduction / PoC", pocIn),
    fieldBlock("Remediation", remedIn),
    fieldBlock("References (one per line: CVE / CWE / OWASP / MITRE)", refsIn),
    fieldBlock("Affected assets", h("div", {}, assetChips, assetSel)),
    fieldBlock("Evidence", h("div", {}, evChips, evSel)));

  const collect = () => Object.assign({
    project_id: state.pid, title: titleIn.value.trim() || "Untitled finding",
    severity: sevSel.value, status: statusSel.value, likelihood: likeSel.value,
    description: descIn.value, impact: impactIn.value, poc: pocIn.value,
    remediation: remedIn.value, refs: refsIn.value,
    assets: assetIds, evidence: evidenceIds }, cvss.get());
  const save = async () => {
    const payload = collect();
    if (fid) await api("PATCH", "/api/findings/" + fid, payload);
    else await api("POST", "/api/findings", payload);
    closeModal(); toast(fid ? "Finding saved" : "Finding created", "ok"); reload();
  };

  const actions = h("div", { class: "modal-actions", style: "justify-content:space-between" },
    fid ? h("button", { class: "btn danger", onclick: async () => {
      if (!confirm("Delete this finding?")) return;
      await api("DELETE", "/api/findings/" + fid); closeModal(); toast("Finding deleted", "ok"); reload();
    } }, icon("i-trash"), "Delete") : h("span", {}),
    h("div", { style: "display:flex;gap:8px" },
      h("button", { class: "btn", onclick: closeModal }, "Cancel"),
      h("button", { class: "btn pri", onclick: save }, fid ? "Save" : "Create finding")));

  openModalEl(fid ? "Edit finding" : "New finding", editor, null, null, actions);
  setTimeout(() => titleIn.focus(), 60);
}

async function renderSettings() {
  const root = $("#v-settings");
  root.innerHTML = "";
  const proj = (await api("GET", "/api/projects")).find((p) => p.id === state.pid) || {};
  root.append(headBar("settings", "Settings"));

  const c = card(icon("i-gear"), "Project");
  const nameIn = h("input", { value: proj.name || "", style: "flex:1" });
  const scopeIn = h("input", { value: proj.scope || "", style: "flex:1", placeholder: "10.0.0.0/24, *.client.com" });
  c.append(
    h("div", { class: "row" }, h("span", { class: "kv-l" }, "Name"), nameIn),
    h("div", { class: "row" }, h("span", { class: "kv-l" }, "Scope"), scopeIn),
    h("div", { class: "row" }, h("span", { class: "grow" }), h("button", { class: "btn pri", onclick: async () => {
      await api("PATCH", "/api/projects/" + state.pid, { name: nameIn.value.trim() || proj.name, scope: scopeIn.value.trim() });
      await loadProjects(); toast("Project updated", "ok");
    } }, "Save")));
  root.append(c);

  const c2 = card(icon("i-database"), "Data");
  c2.append(h("div", { class: "row" }, h("span", { class: "grow sub" },
    "The schema and metadata live in data/atlas.db. Each project keeps its own folder " +
    "under data/projects/, with its screenshots in captures/ and its generated reports " +
    "and board images in exports/. Copy the whole data/ folder to back up or move the engagement.")));
  root.append(c2);

  if (state.authOn) {
    const c4 = card(icon("i-lock"), "Access");
    const cur = h("input", { type: "password", autocomplete: "current-password", style: "flex:1" });
    const nw = h("input", { type: "password", autocomplete: "new-password", style: "flex:1" });
    const rep = h("input", { type: "password", autocomplete: "new-password", style: "flex:1" });
    const save = h("button", { class: "btn pri" }, icon("i-lock"), "Change password");
    save.onclick = async () => {
      if (!cur.value || !nw.value) return toast("Fill in the current and new password", "err");
      if (nw.value !== rep.value) return toast("The new passwords do not match", "err");
      if (nw.value.length < 8) return toast("The new password must be at least 8 characters", "err");
      save.disabled = true;
      try {
        await api("POST", "/api/password", { current: cur.value, new: nw.value });
        cur.value = nw.value = rep.value = "";
        toast("Password changed. Other sessions were signed out.", "ok");
      } catch (e) {
        toast(e.message || "Could not change the password", "err");
      } finally {
        save.disabled = false;
      }
    };
    c4.append(
      h("div", { class: "row" },
        h("span", { class: "grow sub" },
          "Signed in as ", h("b", {}, state.user || "?"),
          location.protocol === "https:"
            ? ". The connection is encrypted with TLS."
            : ". This connection is NOT encrypted - enable tls in conf.json."),
        h("button", { class: "btn", onclick: logout }, icon("i-x"), "Sign out")),
      h("div", { class: "row" }, h("span", { class: "grow sub" },
        state.vault
          ? "Looted secrets are encrypted in the database with this same password" +
            (state.crypto ? " (ChaCha20-Poly1305, " + state.crypto + ")." : ".")
          : "The vault is locked; sign in again to read stored secrets.")),
      h("div", { class: "row" }, h("span", { class: "kv-l" }, "Current"), cur),
      h("div", { class: "row" }, h("span", { class: "kv-l" }, "New"), nw),
      h("div", { class: "row" }, h("span", { class: "kv-l" }, "Repeat"), rep),
      h("div", { class: "row" }, h("span", { class: "grow sub" },
        "Changing it re-seals the vault key, so nothing is re-encrypted and every " +
        "stored secret stays readable. There is no recovery if you forget it."),
        save));
    root.append(c4);
  }

  const hosts = await api("GET", "/api/hosts").catch(() => []);
  if (hosts.length) {
    const c3 = card(icon("i-server"), "Hosts (legacy inventory)");
    c3.append(h("div", { class: "row" }, h("span", { class: "grow sub" },
      "These hosts come from an older version. The node is the central entity now: " +
      "create the equivalent node and delete the host once you no longer need it.")));
    hosts.forEach((ho) => c3.append(h("div", { class: "row" },
      h("span", { class: "mono grow" }, ho.address + (ho.hostname ? "  " + ho.hostname : "")),
      h("span", { class: "sub" }, (ho.open_ports || 0) + " ports"),
      h("button", { class: "btn sm", title: "create a node from this data", onclick: () =>
        newNodeModal({ type: "server", name: ho.hostname || ho.address }) }, icon("i-plus"), "Create node"),
      h("button", { class: "btn ghost sm", onclick: async () => {
        if (!confirm("Delete host " + ho.address + "?")) return;
        await api("DELETE", "/api/hosts/" + ho.id); renderSettings();
      } }, icon("i-trash")))));
    root.append(c3);
  }

  const c5 = card(icon("i-play"), "While it cracks");
  const wicChk = h("input", { type: "checkbox" });
  wicChk.checked = wicOn();
  wicChk.onchange = () => {
    wicSet(wicChk.checked);
    toast(wicChk.checked ? "Enabled - the button is in the top bar" : "Disabled", "ok");
    playBtn.hidden = !wicChk.checked;
  };
  const playBtn = h("button", { class: "btn", onclick: () => openWhileItCracks() }, icon("i-play"), "Play");
  playBtn.hidden = !wicOn();
  c5.append(
    h("div", { class: "row" }, h("span", { class: "grow sub" },
      "A small dodging game for the dead time: while hashcat chews on a hash, while a scan " +
      "finishes, while you wait for a callback. Lasers come in from every side and you dodge " +
      "them with WASD; it speeds up every 10 seconds and keeps your best time. It pauses on " +
      "its own when you switch windows, so going to check on that scan costs you nothing.")),
    h("div", { class: "row" },
      h("label", { class: "grow sub", style: "display:flex;align-items:center;gap:8px" },
        wicChk, "Show it in the top bar"),
      playBtn));
  root.append(c5);
}

function field(name, label, ph, textarea) {
  const inp = textarea ? h("textarea", { name, placeholder: ph || "" }) : h("input", { name, placeholder: ph || "" });
  return h("div", { class: "field" }, h("label", {}, label), inp);
}
function selectField(name, label, values, def, labels) {
  const sel = h("select", { name }, ...values.map((v, i) => h("option", { value: v, selected: v === def }, labels ? labels[i] : v)));
  const el = h("div", { class: "field" }, h("label", {}, label), sel);
  return { el, get: () => sel.value, sel };
}
function valOf(name) { const e = $("[name='" + name + "']", $("#modal")); return e ? e.value.trim() : ""; }

function openModal(title, fields, onSubmit, okLabel) {
  const body = h("div", {}, ...fields);
  openModalEl(title, body, () => {
    const v = {};
    $$("[name]", body).forEach((e) => (v[e.getAttribute("name")] = e.value.trim()));
    return onSubmit(v);
  }, okLabel);
}

function openModalEl(title, bodyEl, onSubmit, okLabel, customActions) {
  const modal = $("#modal");
  modal.className = "modal" + (bodyEl && bodyEl.classList && bodyEl.classList.contains("editor") ? " big" : "") +
    (bodyEl && bodyEl.classList && bodyEl.classList.contains("caped") ? " huge" : "");
  modal.innerHTML = "";
  if (title) modal.append(h("div", { class: "mh" }, h("h2", {}, title),
    h("button", { class: "btn ghost sm", onclick: closeModal }, icon("i-x"))));
  modal.append(bodyEl);
  if (customActions) modal.append(customActions);
  else modal.append(h("div", { class: "modal-actions" },
    h("button", { class: "btn", onclick: closeModal }, "Cancel"),
    h("button", { class: "btn pri", onclick: async () => {
      try { await onSubmit(); } catch (e) { toast(e.message, "err"); }
    } }, okLabel || "Save")));
  $("#modal-wrap").hidden = false;
}
function closeModal() { $("#modal-wrap").hidden = true; }
$("#modal-wrap").addEventListener("click", (e) => { if (e.target.id === "modal-wrap") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function updateStatusbar() {
  const sb = $("#statusbar"); if (!sb || state.view !== "board") return;
  const nodes = Object.keys(state.nodesById || {}).length;
  const edges = (state.edges || []).length;
  sb.innerHTML = "";
  const stat = (l, v) => h("span", {}, l + " ", h("b", {}, String(v)));
  const selCount = state.selEdge ? 1 : ((state.selSet ? state.selSet.size : 0) || (state.selNode ? 1 : 0));
  sb.append(stat("Nodes:", nodes), stat("Connections:", edges), stat("Selected:", selCount),
    h("span", { class: "sb-right" },
      h("span", {}, "\u25cf Autosave"),
      state.lastSaved ? h("span", {}, "Last saved: " + state.lastSaved) : null,
      h("span", {}, Math.round((state.zoom || 1) * 100) + "%"),
      h("button", { class: "ic-btn sm", title: "Fullscreen", onclick: toggleFullscreen }, icon("i-maximize"))));
}

function showLogin(message) {
  const wrap = $("#login-wrap");
  if (!wrap || !wrap.hidden) {
    if (message) setLoginError(message);
    return;
  }
  wrap.hidden = false;
  setLoginError(message || "");
  const u = $("#login-user");
  if (u) setTimeout(() => { (u.value ? $("#login-pass") : u).focus(); }, 40);
}
function hideLogin() {
  const wrap = $("#login-wrap");
  if (wrap) wrap.hidden = true;
  setLoginError("");
  const p = $("#login-pass"); if (p) p.value = "";
}
function setLoginError(msg) {
  const el = $("#login-err");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}
async function checkSession() {
  try {
    const s = await api("GET", "/api/session");
    state.authOn = !!s.auth;
    state.user = s.username || "";
    state.vault = !!s.vault;
    state.crypto = s.crypto || "";
    return !s.auth || !!s.authenticated;
  } catch (_) {
    return false;
  }
}
function bindLogin() {
  const form = $("#login-form");
  if (!form) return;
  const note = $("#login-note");
  if (note && location.protocol !== "https:") {
    note.textContent = "This connection is not encrypted. Enable TLS in conf.json before using atlas over a network.";
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-go"), user = $("#login-user"), pass = $("#login-pass");
    setLoginError("");
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const r = await api("POST", "/api/login", { username: user.value, password: pass.value });
      state.authOn = true;
      state.user = r.username || user.value;
      state.vault = !!r.vault;
      state.crypto = r.crypto || "";
      hideLogin();
      await boot();
    } catch (err) {
      setLoginError(err.message || "Sign-in failed");
      pass.value = ""; pass.focus();
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });
}
async function logout() {
  try { await api("POST", "/api/logout"); } catch (_) {}
  location.reload();
}

async function boot() {
  await loadProjects();
  await renderOverview();
}
(async function init() {
  bindLogin();
  try {
    if (!(await checkSession())) { showLogin(); return; }
    await boot();
  } catch (e) {
    if (!$("#login-wrap") || $("#login-wrap").hidden) {
      document.body.innerHTML = "<pre style='padding:20px;color:#e5534b'>Startup error: " + esc(e.message) + "</pre>";
    }
  }
})();

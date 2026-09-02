(function () {
  const W = 660, H = 430, PR = 9, SPEED = 235;
  const BEST_KEY = "atlas-wic-best";
  const DIRS = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    w: "up", a: "left", s: "down", d: "right",
    arrowup: "up", arrowleft: "left", arrowdown: "down", arrowright: "right",
  };
  let g = null;

  function best() {
    try { return parseFloat(localStorage.getItem(BEST_KEY)) || 0; } catch (_) { return 0; }
  }
  function setBest(v) {
    try { localStorage.setItem(BEST_KEY, v.toFixed(1)); } catch (_) {}
  }
  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function reset() {
    g.t = 0;
    g.bolts = [];
    g.next = 700;
    g.dead = false;
    g.px = W / 2;
    g.py = H / 2;
    g.muzzles = [];
  }

  function level() { return Math.floor(g.t / 10) + 1; }
  function boltSpeed() { return 185 + 34 * (level() - 1); }
  function spawnGap() { return Math.max(165, 640 - 48 * (level() - 1)); }
  function volley() { return 1 + Math.floor((level() - 1) / 4); }

  function spawn() {
    const edges = ["up", "down", "left", "right"];
    const from = edges[(Math.random() * 4) | 0];
    const len = 52, v = boltSpeed();
    const b = { from: from, len: len, thick: 5 };
    if (from === "up") { b.x = 30 + Math.random() * (W - 60); b.y = -len; b.vx = 0; b.vy = v; }
    else if (from === "down") { b.x = 30 + Math.random() * (W - 60); b.y = H + len; b.vx = 0; b.vy = -v; }
    else if (from === "left") { b.x = -len; b.y = 30 + Math.random() * (H - 60); b.vx = v; b.vy = 0; }
    else { b.x = W + len; b.y = 30 + Math.random() * (H - 60); b.vx = -v; b.vy = 0; }
    g.bolts.push(b);
    g.muzzles.push({
      x: from === "left" ? 4 : from === "right" ? W - 4 : b.x,
      y: from === "up" ? 4 : from === "down" ? H - 4 : b.y,
      life: 1,
    });
  }

  function hits(b) {
    const half = b.thick / 2 + PR;
    if (b.vx) {
      const x0 = Math.min(b.x, b.x - Math.sign(b.vx) * b.len);
      const x1 = Math.max(b.x, b.x - Math.sign(b.vx) * b.len);
      return Math.abs(g.py - b.y) < half && g.px > x0 - PR && g.px < x1 + PR;
    }
    const y0 = Math.min(b.y, b.y - Math.sign(b.vy) * b.len);
    const y1 = Math.max(b.y, b.y - Math.sign(b.vy) * b.len);
    return Math.abs(g.px - b.x) < half && g.py > y0 - PR && g.py < y1 + PR;
  }

  function update(dt) {
    if (g.dead || g.paused) return;
    g.t += dt;

    let dx = 0, dy = 0;
    g.held.forEach((k) => {
      const dir = typeof DIRS[k] === "string" ? DIRS[k] : null;
      if (dir) { dx += DIRS[dir][0]; dy += DIRS[dir][1]; }
    });
    const m = Math.hypot(dx, dy) || 1;
    g.px = Math.max(PR, Math.min(W - PR, g.px + (dx / m) * SPEED * dt));
    g.py = Math.max(PR, Math.min(H - PR, g.py + (dy / m) * SPEED * dt));

    g.next -= dt * 1000;
    if (g.next <= 0) {
      for (let i = 0; i < volley(); i++) spawn();
      g.next = spawnGap();
    }
    g.muzzles = g.muzzles.filter((f) => (f.life -= dt * 1.6) > 0);

    g.bolts = g.bolts.filter((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (hits(b)) {
        g.dead = true;
        if (g.t > best()) { setBest(g.t); g.newBest = true; }
      }
      return b.x > -140 && b.x < W + 140 && b.y > -140 && b.y < H + 140;
    });
  }

  function mark(c, x, y, r, fill) {
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r, y);
    c.lineTo(x, y + r);
    c.lineTo(x - r, y);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  function draw() {
    const c = g.ctx, acc = css("--acc", "#e5163f"), acc2 = css("--acc2", "#fb2c56");
    c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    c.fillStyle = "#0a0c11";
    c.fillRect(0, 0, W, H);

    c.strokeStyle = "rgba(255,255,255,.045)";
    c.lineWidth = 1;
    for (let x = 30; x < W; x += 30) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 30; y < H; y += 30) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

    for (const m of g.muzzles) {
      mark(c, m.x, m.y, 5 + m.life * 5, "rgba(229,22,63," + (0.1 + m.life * 0.65) + ")");
      mark(c, m.x, m.y, 2 + m.life * 2, "rgba(255,240,244," + m.life * 0.8 + ")");
    }

    c.lineCap = "round";
    for (const b of g.bolts) {
      const tx = b.x - Math.sign(b.vx) * b.len, ty = b.y - Math.sign(b.vy) * b.len;
      const grad = c.createLinearGradient(tx, ty, b.x, b.y);
      grad.addColorStop(0, "rgba(229,22,63,0)");
      grad.addColorStop(1, acc2);
      c.strokeStyle = grad;
      c.lineWidth = b.thick;
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(b.x, b.y);
      c.stroke();
      c.shadowColor = acc;
      c.shadowBlur = 12;
      mark(c, b.x, b.y, 5, "#fff6f8");
      c.shadowBlur = 0;
    }

    c.shadowColor = "rgba(255,255,255,.55)";
    c.shadowBlur = g.dead ? 0 : 10;
    c.fillStyle = g.dead ? "#6b7280" : "#eef1f6";
    c.beginPath();
    c.arc(g.px, g.py, PR, 0, Math.PI * 2);
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = g.dead ? "#6b7280" : acc;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(g.px, g.py, PR + 4, 0, Math.PI * 2);
    c.stroke();

    c.font = "600 13px ui-monospace,Consolas,monospace";
    c.fillStyle = "#98a2b2";
    c.textAlign = "left";
    c.fillText("time  " + g.t.toFixed(1) + "s", 12, 22);
    c.fillText("level " + level(), 12, 40);
    c.textAlign = "right";
    c.fillText("best  " + (best() ? best().toFixed(1) + "s" : "-"), W - 12, 22);

    if (g.paused && !g.dead) {
      c.fillStyle = "rgba(10,12,17,.72)";
      c.fillRect(0, 0, W, H);
      c.textAlign = "center";
      c.fillStyle = "#eef1f6";
      c.font = "600 18px " + css("--sans", "system-ui");
      c.fillText("paused", W / 2, H / 2);
      c.font = "13px ui-monospace,Consolas,monospace";
      c.fillStyle = "#98a2b2";
      c.fillText("press P or click to resume", W / 2, H / 2 + 24);
    }
    if (g.dead) {
      c.fillStyle = "rgba(10,12,17,.78)";
      c.fillRect(0, 0, W, H);
      c.textAlign = "center";
      c.fillStyle = acc2;
      c.font = "700 26px " + css("--sans", "system-ui");
      c.fillText("hit", W / 2, H / 2 - 22);
      c.fillStyle = "#eef1f6";
      c.font = "600 16px ui-monospace,Consolas,monospace";
      c.fillText("you lasted " + g.t.toFixed(1) + "s", W / 2, H / 2 + 6);
      c.fillStyle = g.newBest ? acc2 : "#98a2b2";
      c.font = "13px ui-monospace,Consolas,monospace";
      c.fillText(g.newBest ? "new best" : "best " + best().toFixed(1) + "s", W / 2, H / 2 + 28);
      c.fillStyle = "#98a2b2";
      c.fillText("press R to go again", W / 2, H / 2 + 52);
    }
  }

  function key(e) {
    if (!g || document.getElementById("modal-wrap").hidden) return;
    const k = (e.key || "").toLowerCase();
    if (k === "escape") return;
    const down = e.type === "keydown";
    if (k === "r") { if (down) { reset(); g.newBest = false; g.paused = false; } }
    else if (k === "p") { if (down) g.paused = !g.paused; }
    else if (k in DIRS) { if (down) g.held.add(k); else g.held.delete(k); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function loop(now) {
    if (!g || document.getElementById("modal-wrap").hidden) { stop(); return; }
    const dt = Math.min(0.05, (now - g.last) / 1000);
    g.last = now;
    update(dt);
    draw();
    g.raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (!g) return;
    cancelAnimationFrame(g.raf);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("keyup", key, true);
    window.removeEventListener("blur", g.onBlur);
    document.removeEventListener("visibilitychange", g.onBlur);
    g = null;
  }

  window.openWhileItCracks = function () {
    stop();
    const canvas = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.cssText = "width:100%;max-width:" + W + "px;height:auto;display:block;margin:0 auto;"
      + "border:1px solid var(--line2);border-radius:var(--radius);background:#0a0c11;cursor:none";
    const hint = document.createElement("div");
    hint.className = "sub";
    hint.style.cssText = "text-align:center;margin-top:10px";
    hint.textContent = "WASD or arrows to dodge · P pauses · R restarts · Esc closes. "
      + "It speeds up every 10 seconds.";
    const body = document.createElement("div");
    body.append(canvas, hint);

    g = {
      ctx: canvas.getContext("2d"), dpr: dpr, held: new Set(),
      paused: false, newBest: false, last: performance.now(), raf: 0,
    };
    reset();
    g.onBlur = function () { if (g) g.paused = true; };
    canvas.addEventListener("click", function () { if (g && !g.dead) g.paused = false; });
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    window.addEventListener("blur", g.onBlur);
    document.addEventListener("visibilitychange", g.onBlur);

    openModalEl("While it cracks", body, null, null,
      (function () {
        const bar = document.createElement("div");
        bar.className = "modal-actions";
        const again = document.createElement("button");
        again.className = "btn";
        again.textContent = "Restart";
        again.onclick = function () { reset(); g.newBest = false; g.paused = false; };
        const close = document.createElement("button");
        close.className = "btn pri";
        close.textContent = "Back to work";
        close.onclick = function () { stop(); closeModal(); };
        bar.append(again, close);
        return bar;
      })());
    g.raf = requestAnimationFrame(loop);
  };
})();

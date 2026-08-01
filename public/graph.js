/* ---------------- Graph view: force-directed page graph (Roam-style) ----------------
   Nodes are pages (and, optionally, journal days); an edge joins two pages whenever a
   block in one references the other — a resolved #/n/ link, a #tag / @mention of a
   single-token title, or a block ref (resolved to its page). Rendered on a <canvas>
   with a small self-contained force simulation: no library, no external requests.
   Interactions: drag a node, pan the background, wheel / pinch zoom, hover highlights
   the neighbourhood, click opens the page. */
'use strict';

function graphViewActive() {
  return state.view === 'graph' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.graphViewActive = graphViewActive;

let graphSim = null;   // the running simulation (torn down on every re-render)

/* ---- data: pages + edges from references (matching collectLinkedRefs semantics) ---- */

function buildGraphData(includeDaily) {
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ids = new Set(pagesOf());
  if (includeDaily) {
    for (const id of Object.keys(doc.nodes)) {
      const n = doc.nodes[id];
      if (n.cal === 'day' && (n.children || []).length) ids.add(id);
    }
  }
  // #tag / @mention regexes for single-token titles — same shape collectLinkedRefs accepts
  const tagRe = new Map();
  for (const t of ids) {
    const title = plainOf(N(t).text).trim();
    if (title && /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)) {
      tagRe.set(t, new RegExp('[#@]' + escRe(title) + '(?![\\p{L}\\p{N}_\\-/])', 'u'));
    }
  }
  const weight = new Map();   // "a|b" (sorted) → reference count
  const addEdge = (a, b) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const k = a < b ? a + '|' + b : b + '|' + a;
    weight.set(k, (weight.get(k) || 0) + 1);
  };
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n.text) continue;
    const host = historyPageOf(id);
    if (!host || !ids.has(host)) continue;
    const seen = new Set();
    for (const m of n.text.matchAll(/#\/n\/([A-Za-z0-9]+)/g)) {
      let t = m[1];
      if (!ids.has(t)) t = historyPageOf(t);   // a block ref counts for its page
      if (t && !seen.has(t)) { seen.add(t); addEdge(host, t); }
    }
    for (const [t, re] of tagRe) {
      if (t !== host && !seen.has(t) && re.test(n.text)) { seen.add(t); addEdge(host, t); }
    }
  }
  const nodes = [...ids].map(id => ({
    id,
    title: plainOf(N(id).text).trim() || 'Untitled',
    day: N(id).cal === 'day',
    degree: 0,
    x: 0, y: 0, vx: 0, vy: 0,
  }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = [];
  for (const [k, w] of weight) {
    const [a, b] = k.split('|');
    edges.push({ a: index.get(a), b: index.get(b), w });
    nodes[index.get(a)].degree += w;
    nodes[index.get(b)].degree += w;
  }
  return { nodes, edges };
}

/* ---- the view ---- */

function renderGraphView(frag) {
  const view = document.createElement('div');
  view.className = 'graph-view';

  const head = document.createElement('div');
  head.className = 'graph-head';
  const h = document.createElement('h1');
  h.className = 'pages-head';
  h.textContent = 'Graph';
  head.append(h);

  const controls = document.createElement('label');
  controls.className = 'graph-daily-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = localStorage.getItem('graph-daily') === '1';
  cb.addEventListener('change', () => {
    localStorage.setItem('graph-daily', cb.checked ? '1' : '0');
    renderPage();   // rebuild with/without journal days
  });
  controls.append(cb, document.createTextNode(' Daily notes'));
  head.append(controls);

  const count = document.createElement('span');
  count.className = 'graph-count';
  head.append(count);
  view.append(head);

  const data = buildGraphData(cb.checked);
  count.textContent = `${data.nodes.length} pages · ${data.edges.length} links`;

  if (!data.nodes.length) {
    const hint = document.createElement('div');
    hint.className = 'pages-empty';
    hint.textContent = 'No pages yet — the graph grows as you write and link.';
    view.append(hint);
    frag.append(view);
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'graph-canvas';
  view.append(canvas);
  frag.append(view);

  if (graphSim) { graphSim.stop(); graphSim = null; }
  graphSim = startGraphSim(canvas, data);
}
window.renderGraphView = renderGraphView;

function startGraphSim(canvas, { nodes, edges }) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  // camera (world → screen: screen = (world - cam) * scale + centre)
  let scale = 1, camX = 0, camY = 0;

  // deterministic-ish initial layout: a phyllotaxis spiral (stable across opens)
  const R0 = 26;
  nodes.forEach((n, i) => {
    const a = i * 2.399963;             // golden angle
    const r = R0 * Math.sqrt(i + 0.5);
    n.x = r * Math.cos(a);
    n.y = r * Math.sin(a);
  });

  const adj = nodes.map(() => new Set());
  for (const e of edges) { adj[e.a].add(e.b); adj[e.b].add(e.a); }
  const radius = n => Math.min(14, 3.2 + 2.2 * Math.sqrt(n.degree));

  /* ---- simulation: springs + repulsion + weak centring, with decaying alpha ---- */
  let alpha = 1;
  let hot = true;
  function tick() {
    const REP = 1600, SPRING = 0.06, LEN = 70, GRAV = 0.012, DAMP = 0.82;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.01; dy = 0.013; d2 = dx * dx + dy * dy; }
        const f = Math.min(12, REP / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = SPRING * (d - LEN) * alpha * Math.min(2, 0.6 + 0.4 * e.w);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      if (n === dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.vx -= n.x * GRAV * alpha;
      n.vy -= n.y * GRAV * alpha;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.985;
    if (alpha < 0.02) hot = false;
  }

  /* ---- rendering (theme colours re-read per frame, so Light/Dark just works) ---- */
  function colors() {
    const cs = getComputedStyle(canvas);
    return {
      line: cs.getPropertyValue('--line').trim() || '#ccc',
      faint: cs.getPropertyValue('--ink-faint').trim() || '#999',
      soft: cs.getPropertyValue('--ink-soft').trim() || '#666',
      ink: cs.getPropertyValue('--ink').trim() || '#222',
      accent: cs.getPropertyValue('--accent').trim() || '#68f',
      bg: cs.getPropertyValue('--bg').trim() || '#fff',
    };
  }
  const sx = n => (n.x - camX) * scale + W / 2;
  const sy = n => (n.y - camY) * scale + H / 2;

  function draw() {
    const c = colors();
    ctx.clearRect(0, 0, W, H);
    const hovered = hoverIdx >= 0 ? hoverIdx : (dragNode ? nodes.indexOf(dragNode) : -1);
    const focus = hovered >= 0;

    ctx.lineWidth = Math.max(0.6, 0.8 * Math.sqrt(scale));
    for (const e of edges) {
      const active = focus && (e.a === hovered || e.b === hovered);
      ctx.strokeStyle = active ? c.accent : c.line;
      ctx.globalAlpha = focus && !active ? 0.25 : 0.85;
      ctx.beginPath();
      ctx.moveTo(sx(nodes[e.a]), sy(nodes[e.a]));
      ctx.lineTo(sx(nodes[e.b]), sy(nodes[e.b]));
      ctx.stroke();
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const x = sx(n), y = sy(n);
      const r = radius(n) * Math.sqrt(scale);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const isHover = i === hovered, isNeighbor = focus && adj[hovered].has(i);
      ctx.globalAlpha = focus && !isHover && !isNeighbor ? 0.3 : 1;
      ctx.fillStyle = isHover ? c.accent : n.day ? c.faint : c.soft;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // labels: hovered + neighbours always; otherwise the busiest nodes, more as you zoom in
    const labelCut = scale > 2 ? 0 : scale > 1.2 ? 1 : scale > 0.7 ? 3 : 6;
    ctx.font = `${Math.max(10, 11 * Math.min(1.6, Math.sqrt(scale)))}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const isHover = i === hovered, isNeighbor = focus && adj[hovered].has(i);
      if (!isHover && !isNeighbor && n.degree < labelCut) continue;
      const x = sx(n), y = sy(n);
      if (x < -80 || y < -30 || x > W + 80 || y > H + 30) continue;
      ctx.globalAlpha = isHover || isNeighbor ? 1 : focus ? 0.3 : 0.85;
      ctx.fillStyle = isHover ? c.ink : c.faint;
      const label = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title;
      ctx.fillText(label, x, y + radius(n) * Math.sqrt(scale) + 12);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- interaction ---- */
  let hoverIdx = -1, dragNode = null, panning = false;
  let downX = 0, downY = 0, moved = false;
  const pointers = new Map();   // pinch zoom
  let pinchDist = 0;

  function nodeAt(px, py) {
    let best = -1, bestD = 1e9;
    for (let i = 0; i < nodes.length; i++) {
      const dx = sx(nodes[i]) - px, dy = sy(nodes[i]) - py;
      const d = Math.hypot(dx, dy);
      const hit = Math.max(8, radius(nodes[i]) * Math.sqrt(scale) + 4);
      if (d < hit && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }
  const toLocal = ev => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', ev => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, toLocal(ev));
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      dragNode = null; panning = false;
      return;
    }
    const p = toLocal(ev);
    downX = p.x; downY = p.y; moved = false;
    const i = nodeAt(p.x, p.y);
    if (i >= 0) { dragNode = nodes[i]; alpha = Math.max(alpha, 0.3); hot = true; }
    else panning = true;
  });
  canvas.addEventListener('pointermove', ev => {
    const p = toLocal(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p);
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist > 0) zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, d / pinchDist);
      pinchDist = d;
      return;
    }
    if (Math.hypot(p.x - downX, p.y - downY) > 4) moved = true;
    if (dragNode) {
      dragNode.x = (p.x - W / 2) / scale + camX;
      dragNode.y = (p.y - H / 2) / scale + camY;
      alpha = Math.max(alpha, 0.25); hot = true;
      return;
    }
    if (panning && pointers.size === 1) {
      camX -= ev.movementX / scale;
      camY -= ev.movementY / scale;
      return;
    }
    const i = nodeAt(p.x, p.y);
    if (i !== hoverIdx) { hoverIdx = i; canvas.style.cursor = i >= 0 ? 'pointer' : 'grab'; }
  });
  const release = ev => {
    pointers.delete(ev.pointerId);
    pinchDist = 0;
    const wasDrag = dragNode, wasPan = panning;
    dragNode = null; panning = false;
    if (!moved && (wasDrag || !wasPan)) {
      const i = nodeAt(...Object.values(toLocal(ev)));
      if (i >= 0) location.hash = '#/n/' + nodes[i].id;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', ev => { pointers.delete(ev.pointerId); dragNode = null; panning = false; });
  canvas.addEventListener('pointerleave', () => { if (!dragNode && !panning) { hoverIdx = -1; } });

  function zoomAt(px, py, factor) {
    const ns = Math.min(6, Math.max(0.15, scale * factor));
    // keep the point under the cursor stationary
    camX += (px - W / 2) / scale - (px - W / 2) / ns;
    camY += (py - H / 2) / scale - (py - H / 2) / ns;
    scale = ns;
  }
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const p = toLocal(ev);
    zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0015));
  }, { passive: false });

  /* ---- lifecycle ---- */
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // fit the spiral into view once at start
  const maxR = R0 * Math.sqrt(nodes.length) + 60;
  scale = Math.min(1.6, Math.max(0.2, Math.min(canvas.clientWidth, canvas.clientHeight) / (2 * maxR) || 1));

  // test hook: node positions in screen space (tests click nodes through this)
  window.__graphProbe = () => ({ nodes, screenOf: n => ({ x: sx(n), y: sy(n) }) });

  let raf = 0;
  let alive = true;
  function frame() {
    if (!alive) return;
    if (!canvas.isConnected) { stop(); return; }   // view was re-rendered away
    if (hot) { tick(); tick(); }
    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function stop() {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
  }
  return { stop };
}

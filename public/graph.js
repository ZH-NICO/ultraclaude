// Layout of the memory graph: a small force simulation, deterministic so the picture does not
// jump around between visits. Pure functions, used by the window and by the tests.

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const hashOf = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** Gives every node an x and y. Linked notes end up close, unrelated ones apart. Returns { x, y } by node id. */
export function layout(nodes, links, { width = 1000, height = 700, iterations = 260 } = {}) {
  const n = nodes.length;
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const rand = rng(hashOf(nodes.map((nd) => nd.id).sort().join('|')));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const radius = Math.min(width, height) / 3;
  nodes.forEach((_, i) => { const a = rand() * Math.PI * 2; const r = radius * Math.sqrt(rand()); x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r; });
  const edges = links.map((l) => [index.get(l.source), index.get(l.target)]).filter(([a, b]) => a !== undefined && b !== undefined);
  const degree = new Int32Array(n);
  for (const [a, b] of edges) { degree[a]++; degree[b]++; }
  const k = Math.min(90, Math.max(42, Math.sqrt((width * height) / Math.max(1, n)) * 0.35)); // the distance two notes like to keep
  let temperature = width / 8;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j]; let ey = y[i] - y[j];
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) { ex = rand() - 0.5; ey = rand() - 0.5; d2 = 0.5; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2; // repulsion
        dx[i] += (ex / d) * f * d; dy[i] += (ey / d) * f * d; dx[j] -= (ex / d) * f * d; dy[j] -= (ey / d) * f * d;
      }
    }
    for (const [a, b] of edges) {
      const ex = x[a] - x[b]; const ey = y[a] - y[b];
      const d = Math.max(0.01, Math.hypot(ex, ey));
      const f = (d * d) / k / Math.max(1, Math.sqrt(Math.min(degree[a], degree[b]))); // attraction along a link
      dx[a] -= (ex / d) * f; dy[a] -= (ey / d) * f; dx[b] += (ex / d) * f; dy[b] += (ey / d) * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * 0.07 * (degree[i] ? 1 : 4); dy[i] -= y[i] * 0.07 * (degree[i] ? 1 : 4); // gravity, much stronger for loose notes
      const len = Math.max(0.01, Math.hypot(dx[i], dy[i]));
      const step = Math.min(len, temperature);
      x[i] += (dx[i] / len) * step; y[i] += (dy[i] / len) * step;
    }
    temperature *= 0.985;
  }
  // a few stragglers must not shrink the whole picture: pull them in to 2.2x the typical distance
  const dist = Array.from({ length: n }, (_, i) => Math.hypot(x[i], y[i])).sort((a, b) => a - b);
  const limit = Math.max(60, (dist[Math.floor(n / 2)] || 0) * 2.2);
  // notes without any link have nothing to attract them: they sit on a ring around the connected ones
  const loose = [];
  let reach = 0;
  for (let i = 0; i < n; i++) { if (degree[i]) reach = Math.max(reach, Math.hypot(x[i], y[i])); else loose.push(i); }
  loose.forEach((i, j) => { const a = (j / loose.length) * Math.PI * 2 + 0.4; const r = Math.max(70, reach * 1.15 + 40); x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r; });
  const out = new Map();
  // the ring of loose notes stays as it is
  nodes.forEach((nd, i) => { const d = Math.hypot(x[i], y[i]); const s = degree[i] && d > limit ? limit / d : 1; out.set(nd.id, { x: x[i] * s, y: y[i] * s }); });
  return out;
}

/** The size of a note's dot: bigger for longer notes and for notes that many others point to. */
export function dotSize(node, degree = 0) {
  if (node.ghost) return 4;
  return Math.max(4, Math.min(13, 3.5 + Math.sqrt(node.size / 400) + Math.sqrt(degree) * 1.2));
}

/** How many links each node has. */
export function degrees(nodes, links) {
  const d = new Map(nodes.map((n) => [n.id, 0]));
  for (const l of links) { d.set(l.source, (d.get(l.source) || 0) + 1); d.set(l.target, (d.get(l.target) || 0) + 1); }
  return d;
}

/** A small pan and zoom controller for an SVG stage. `view` is { x, y, k }; `apply` redraws. */
export function panZoom(stage, view, apply, { min = 0.1, max = 6 } = {}) {
  let drag = null;
  let dragged = false;
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = ev.clientX - r.left; const my = ev.clientY - r.top;
    const k = Math.min(max, Math.max(min, view.k * Math.exp(-ev.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) * k) / view.k; view.y = my - ((my - view.y) * k) / view.k; view.k = k;
    apply();
  }, { passive: false });
  stage.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.map-zoom')) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    dragged = false;
  });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const mx = ev.clientX - drag.x; const my = ev.clientY - drag.y;
    if (!dragged && Math.hypot(mx, my) < 4) return;
    dragged = true;
    stage.classList.add('dragging');
    view.x = drag.vx + mx; view.y = drag.vy + my;
    apply();
  });
  window.addEventListener('pointerup', () => { if (!drag) return; drag = null; stage.classList.remove('dragging'); setTimeout(() => { dragged = false; }, 0); });
  return { wasDrag: () => dragged };
}

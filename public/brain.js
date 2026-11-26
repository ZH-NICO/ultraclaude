// The brain: every Claude Code chat as a neuron inside a slowly turning 3D cloud of light points,
// shaped like a brain (cerebrum with its fissure, cerebellum, stem). Each folder is a region with its
// own colour from the spectrum. Drawn on a 2D canvas with a small perspective projection; no library.

const SPECTRUM = ['#FF5A5F', '#FF9F1C', '#FFE14D', '#7CFF6B', '#2EE6D6', '#4DA3FF', '#9B7BFF', '#FF6BD6'];
const DAY = 864e5;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashOf = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Is a point (x right, y up, z front) inside the brain? Returns the part it belongs to, or ''. */
export function brainPart(x, y, z) {
  const e = (cx, cy, cz, rx, ry, rz) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
  // cerebrum: two hemispheres with the longitudinal fissure between them, flattened underneath
  const fissure = Math.abs(x) < 0.04 && y > -0.05;
  if (!fissure && y > -0.42 && (e(0, 0.12, 0.0, 0.92, 0.78, 1.32) <= 1 || e(0, 0.02, 0.72, 0.84, 0.62, 0.62) <= 1)) return 'cerebrum';
  if (!fissure && e(0, -0.3, 0.42, 0.88, 0.3, 0.55) <= 1 && Math.abs(x) > 0.2) return 'cerebrum'; // temporal lobes
  if (e(0, -0.5, -0.82, 0.62, 0.27, 0.38) <= 1) return 'cerebellum';
  const r = 0.14 - Math.max(0, -y - 0.5) * 0.06;
  if (y < -0.3 && y > -1.15 && Math.hypot(x, z + 0.42 + (y + 0.3) * 0.25) < r) return 'stem';
  return '';
}

/** Where a point sits on the way round the brain's side profile, 0..1 (front, over the top, to the back and under). */
export const around = (y, z) => (((Math.atan2(y - 0.05, z) - 0.35) / (Math.PI * 2)) % 1 + 1) % 1;

/** The spectrum colour at a place on the way round, blended between its stops. */
export function spectrumAt(t) {
  const k = SPECTRUM.length;
  const f = (((t % 1) + 1) % 1) * k;
  const i = Math.floor(f);
  const a = rgb(SPECTRUM[i % k]); const b = rgb(SPECTRUM[(i + 1) % k]);
  return a.map((v, j) => Math.round(v + (b[j] - v) * (f - i)));
}

/** Builds the cloud: regions (one per folder), particles coloured by their region, and one neuron per chat. */
export function buildBrain(projects, { total } = {}) {
  const chats = projects.flatMap((pr) => pr.sessions.map((s) => ({ pr, s })));
  const rand = rng(hashOf(projects.map((p) => p.key).sort().join('|')));
  const count = total ?? Math.max(9500, Math.min(13000, 9000 + chats.length * 30));
  // each folder gets a stretch of the way round the brain, in proportion to its chats; its colour is the spectrum there
  const order = [...projects].sort((a, b) => b.sessions.length - a.sessions.length);
  const weightOf = (pr) => Math.sqrt(pr.sessions.length) + 1;
  const sum = order.reduce((s, pr) => s + weightOf(pr), 0);
  let at = 0;
  const regions = order.map((pr) => {
    const from = at; at += weightOf(pr) / sum;
    const col = spectrumAt((from + at) / 2);
    return { key: pr.key, pr, from, to: at, rgb: col, color: `#${col.map((v) => v.toString(16).padStart(2, '0')).join('')}`, neurons: [] };
  });
  const byKey = new Map(regions.map((r) => [r.key, r]));
  const regionAt = (t) => regions.find((r) => t >= r.from && t < r.to) || regions.at(-1) || null;  const points = [];
  let guard = 0;
  while (points.length < count && guard++ < count * 40) {
    const x = rand() * 2.1 - 1.05; const y = rand() * 2.1 - 1.15; const z = rand() * 2.7 - 1.35;
    const part = brainPart(x, y, z);
    if (!part) continue;
    // denser near the surface, like the cortex
    const depth = part === 'cerebrum' ? ((x / 0.92) ** 2 + ((y - 0.12) / 0.78) ** 2 + (z / 1.32) ** 2) : 1;
    if (part === 'cerebrum' && rand() > 0.45 + depth * 0.7) continue;
    const t = around(y, z);
    const reg = regionAt(t);
    // the colour drifts a little from point to point, like the real thing
    const col = spectrumAt(t + (rand() - 0.5) * 0.06).map((v) => Math.min(255, Math.round(v * (0.8 + rand() * 0.35))));
    points.push({ x, y, z, reg, col, size: 0.9 + rand() * rand() * 1.8, tw: rand() * Math.PI * 2, part });
  }
  // threads: each point to a near point of its own region
  const links = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let best = -1; let bd = 0.05;
    for (let t = 0; t < 7; t++) { const j = Math.floor(rand() * points.length); const q = points[j]; if (j === i || q.reg !== p.reg) continue; const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2; if (d < bd) { bd = d; best = j; } }
    if (best >= 0 && rand() < 0.55) links.push([i, best]);
  }
  // neurons: each chat sits on a point of its folder's region, placed the same every time
  const neurons = [];
  for (const { pr, s } of chats) {
    const reg = byKey.get(pr.key);
    const mine = points.filter((p) => p.reg === reg);
    const cortex = mine.filter((p) => p.part === 'cerebrum');
    const pool = cortex.length ? cortex : mine.length ? mine : points;
    const r2 = rng(hashOf(s.id));
    const home = pool[Math.floor(r2() * pool.length)];
    const n = { pr, s, reg, x: home.x, y: home.y, z: home.z, key: `${pr.key}/${s.id}` };
    reg.neurons.push(n);
    neurons.push(n);
  }
  // each neuron wires to its two nearest neighbours in the same region
  const wires = [];
  for (const reg of regions) {
    for (const n of reg.neurons) {
      const near = reg.neurons.filter((m) => m !== n).map((m) => [m, (m.x - n.x) ** 2 + (m.y - n.y) ** 2 + (m.z - n.z) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, 2);
      for (const [m] of near) if (n.key < m.key || !near.some(([o]) => o === m)) wires.push([n, m]);
    }
  }
  const biggest = Math.max(1, ...chats.map(({ s }) => s.size || 0));
  for (const n of neurons) n.r = 1.6 + 2.6 * Math.sqrt((n.s.size || 0) / biggest);
  return { points, links, neurons, wires, regions };
}

/** The live view on a canvas. */
export class BrainView {
  constructor(canvas, { calm = false, onPick = () => {}, onHover = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.calm = calm;
    this.onPick = onPick;
    this.onHover = onHover;
    this.yaw = Math.PI / 2 + 0.25; this.pitch = 0.1; this.zoom = 1; // starts from the side, where it reads as a brain
    this.model = null;
    this.match = null; // a function chat -> bool while searching
    this.focus = null; // a region key
    this.selected = null; // a neuron key
    this.hover = null;
    this.traces = [];
    this.running = false;
    this.boot = 1;
    this.last = 0;
    this.screen = []; // [neuron, x, y, r] as last drawn, for hit tests
    this.#wire();
  }

  setData(projects) {
    this.model = buildBrain(projects);
    this.traces = []; // they point at neurons of the old brain
    this.boot = this.calm ? 1 : 0;
    this.draw();
  }

  rebootAnimation() { if (!this.calm) this.boot = 0; }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      if (!this.calm) {
        if (!this.dragging) this.yaw += dt * 0.055;
        this.boot = Math.min(1, this.boot + dt / 2.6);
        this.#fire(t);
      }
      try { this.draw(t); } finally { requestAnimationFrame(tick); } // one bad frame must not stop the brain
    };
    requestAnimationFrame(tick);
  }

  stop() { this.running = false; }

  /** Screen position of a chat's neuron (for tests and for focusing). */
  locate(key) { const hit = this.screen.find(([n]) => n.key === key); return hit ? { x: hit[1], y: hit[2] } : null; }

  #project(x, y, z, w, h) {
    const cy = Math.cos(this.yaw); const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    const x1 = x * cy + z * sy; const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp; const z2 = y * sp + z1 * cp;
    const D = 3.4;
    const f = D / (D - z2);
    const s = Math.min(w / 2.9, h / 2.35) * this.zoom; // the whole brain fits at zoom 1, in any window shape
    return [w / 2 + x1 * s * f, h * 0.5 - (y2 - 0.08) * s * f, f, z2];
  }

  #fire(t) {
    // now and then a few neurons of one region light up together, freshest regions most often
    this.traces = this.traces.filter((tr) => t - tr.at < 2600);
    if (!this.model || this.boot < 1 || t < (this.nextFire || 0)) return;
    const regs = this.model.regions.filter((r) => r.neurons.length >= 2);
    if (!regs.length) return;
    const weight = (r) => r.neurons.reduce((sum, n) => sum + (Date.now() - n.s.updated < DAY ? 4 : Date.now() - n.s.updated < 7 * DAY ? 2 : 1), 0);
    let pick = Math.random() * regs.reduce((s, r) => s + weight(r), 0);
    const reg = regs.find((r) => (pick -= weight(r)) <= 0) || regs[0];
    const ns = [...reg.neurons].sort(() => Math.random() - 0.5).slice(0, Math.min(reg.neurons.length, 2 + Math.floor(Math.random() * 2)));
    this.traces.push({ at: t, ns, color: reg.rgb });
    this.nextFire = t + 900 + Math.random() * 1400;
  }

  draw(t = performance.now()) {
    const c = this.canvas; const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth; const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (!this.model) return;
    const { points, links, neurons, wires } = this.model;
    // the brain builds itself from the stem upwards
    const reveal = this.boot >= 1 ? Infinity : -1.2 + this.boot * 2.6;
    const shown = (p) => p.y < reveal;
    const dim = (reg) => (this.focus && reg?.key !== this.focus ? 0.12 : 1);
    const proj = points.map((p) => this.#project(p.x, p.y, p.z, w, h));
    const depthA = (z) => 0.3 + 0.7 * Math.max(0, Math.min(1, (z + 1.3) / 2.6));
    ctx.globalCompositeOperation = 'lighter';
    // threads
    ctx.lineWidth = 0.6;
    for (const [i, j] of links) {
      const a = points[i]; const b = points[j];
      if (!shown(a) || !shown(b)) continue;
      const pa = proj[i]; const pb = proj[j];
      const [r, g, bl] = a.col;
      ctx.strokeStyle = `rgba(${r},${g},${bl},${(0.06 * depthA(pa[3]) * dim(a.reg)).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    // points
    const searching = !!this.match;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!shown(p)) continue;
      const [x, y, f, z] = proj[i];
      const [r, g, b] = p.col;
      const tw = this.calm ? 1 : 0.8 + 0.2 * Math.sin(t / 900 + p.tw);
      const a = 0.95 * (0.35 + 0.65 * depthA(z)) * tw * dim(p.reg) * (searching ? 0.45 : 1) * (this.boot < 1 ? Math.min(1, (reveal - p.y) * 3) : 1);
      const s = p.size * f * (0.95 + this.zoom * 0.25);
      ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    if (this.boot < 0.6) return;
    const appear = Math.min(1, (this.boot - 0.6) / 0.4);
    // neurons and the wires between them
    const np = new Map(neurons.map((n) => [n, this.#project(n.x, n.y, n.z, w, h)]));
    ctx.lineWidth = 0.8;
    for (const [a, b] of wires) {
      const pa = np.get(a); const pb = np.get(b);
      const [r, g, bl] = a.reg.rgb;
      ctx.strokeStyle = `rgba(${r},${g},${bl},${(0.22 * depthA(pa[3]) * dim(a.reg) * appear).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
    }
    this.screen = [];
    for (const n of neurons) {
      const [x, y, f, z] = np.get(n);
      const fresh = Date.now() - n.s.updated < DAY;
      const hit = !searching || this.match(n);
      const pulse = fresh && !this.calm ? 0.75 + 0.25 * Math.sin(t / 350 + n.x * 9) : 1;
      const age = Math.max(0.45, 1 - (Date.now() - n.s.updated) / (60 * DAY));
      const a = appear * depthA(z) * dim(n.reg) * (hit ? 1 : 0.12) * pulse;
      const r = n.r * 0.8 * f * (0.8 + this.zoom * 0.25);
      const [cr, cg, cb] = n.reg.rgb;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, `rgba(${cr},${cg},${cb},${(0.5 * a * age).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${(0.9 * a * age).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
      if (hit && dim(n.reg) === 1) this.screen.push([n, x, y, r, z]);
    }
    ctx.globalCompositeOperation = 'source-over';
    // firing traces: a bright line through a few neurons, rings at their ends
    for (const tr of this.traces) {
      const life = (t - tr.at) / 2600;
      const a = life < 0.15 ? life / 0.15 : 1 - (life - 0.15) / 0.85;
      const pts = tr.ns.map((n) => np.get(n)).filter(Boolean);
      if (pts.length < 2) continue;
      const [r, g, b] = tr.color;
      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.85 * a).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (pts.length > 2) ctx.closePath();
      ctx.stroke();
      for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 + life * 5, 0, Math.PI * 2); ctx.stroke(); }
    }
    // the picked and the hovered neuron: a ring and its name
    for (const key of [this.selected, this.hover?.key].filter(Boolean)) {
      const hit = this.screen.find(([n]) => n.key === key) || (() => { const n = neurons.find((m) => m.key === key); if (!n) return null; const p = np.get(n); return [n, p[0], p[1], n.r]; })();
      if (!hit) continue;
      const [n, x, y] = hit;
      ctx.strokeStyle = key === this.selected ? '#fff' : 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
      const title = n.s.title.length > 48 ? `${n.s.title.slice(0, 47)}…` : n.s.title;
      const left = x + 15 + ctx.measureText(title).width > w - 8; // near the right edge the name goes on the left
      ctx.textAlign = left ? 'right' : 'left';
      const tx = left ? x - 15 : x + 15;
      ctx.fillStyle = '#fff';
      ctx.fillText(title, tx, y - 2);
      ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillText(n.pr.name, tx, y + 13);
      ctx.textAlign = 'left';
    }
  }

  #at(ev) {
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left; const y = ev.clientY - r.top;
    let best = null; let bd = 14 * 14;
    for (const [n, nx, ny] of this.screen) { const d = (nx - x) ** 2 + (ny - y) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }

  #wire() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (ev) => { if (ev.button === 0) drag = { x: ev.clientX, y: ev.clientY, yaw: this.yaw, pitch: this.pitch, moved: false }; });
    window.addEventListener('pointermove', (ev) => {
      if (drag) {
        const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true; this.dragging = true;
        c.classList.add('dragging');
        this.yaw = drag.yaw + dx * 0.008;
        this.pitch = Math.max(-0.9, Math.min(0.9, drag.pitch + dy * 0.006));
        if (!this.running) this.draw();
        return;
      }
      if (ev.target !== c) return;
      const n = this.#at(ev);
      if (n?.key !== this.hover?.key) { this.hover = n; c.style.cursor = n ? 'pointer' : ''; this.onHover(n); if (!this.running) this.draw(); }
    });
    window.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null; this.dragging = false; c.classList.remove('dragging');
      if (!moved && ev.target === c) { const n = this.#at(ev); if (n) this.onPick(n); }
    });
    c.addEventListener('wheel', (ev) => { ev.preventDefault(); this.zoom = Math.max(0.5, Math.min(3.2, this.zoom * Math.exp(-ev.deltaY * 0.0012))); if (!this.running) this.draw(); }, { passive: false });
    c.addEventListener('dblclick', () => { this.zoom = 1; this.pitch = 0.12; if (!this.running) this.draw(); });
  }
}

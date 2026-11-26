// The brain: every file on this computer as a point of light, and every Claude Code chat as a brighter
// neuron, inside a slowly turning 3D cloud shaped like a brain (cerebrum with its fissure, lobes,
// cerebellum, stem). Each main folder is a region with its own stretch of the spectrum. Drawn on a 2D
// canvas: the points go straight into a pixel buffer, lines and neurons on top. No library.

const SPECTRUM = ['#FF5A5F', '#FF9F1C', '#FFE14D', '#7CFF6B', '#2EE6D6', '#4DA3FF', '#9B7BFF', '#FF6BD6'];
const DAY = 864e5;
const FILL = 8000; // fewer files than this: the brain is filled up with points that stand for nothing

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashOf = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const low = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const sepOf = (p) => (String(p).includes('\\') ? '\\' : '/');
const join = (dir, name) => (dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sepOf(dir) + name);
const under = (p, dir) => { const a = low(p); const b = low(dir); return !!b && (a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)); };

/** Is a point (x right, y up, z front) inside the brain? Returns the part it belongs to, or ''. */
export function brainPart(x, y, z) {
  const e = (cx, cy, cz, rx, ry, rz) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
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

/** A random point inside the brain (within a stretch of the way round), denser near the surface like the cortex. */
function sample(rand, from = 0, to = 1) {
  for (let tries = 0; tries < 4000; tries++) {
    const x = rand() * 2.1 - 1.05; const y = rand() * 2.1 - 1.15; const z = rand() * 2.7 - 1.35;
    const part = brainPart(x, y, z);
    if (!part) continue;
    const t = around(y, z);
    if (to - from < 1 && (t < from || t >= to)) continue;
    const depth = part === 'cerebrum' ? (x / 0.92) ** 2 + ((y - 0.12) / 0.78) ** 2 + (z / 1.32) ** 2 : 1;
    if (part === 'cerebrum' && rand() > 0.45 + depth * 0.7) continue;
    return { x, y, z, t, part };
  }
  return null;
}

/**
 * Builds the cloud. `files` is the index from the server ({ regions, dirs, files: [dir, name, region] }), or
 * null: then the regions are the folders with chats, and the points stand for nothing.
 */
export function buildBrain(projects, files = null, { total } = {}) {
  const chats = projects.flatMap((pr) => pr.sessions.map((s) => ({ pr, s })));
  const fromFiles = !!files?.files?.length;
  const rand = rng(hashOf(projects.map((p) => p.key).sort().join('|') + (fromFiles ? files.files.length : 0)));
  const src = fromFiles
    ? files.regions.map((r) => ({ key: r.key, name: r.name, path: r.path, count: r.count }))
    : [...projects].sort((a, b) => b.sessions.length - a.sessions.length).map((pr) => ({ key: pr.key, name: pr.name, path: pr.dir, count: pr.sessions.length, pr }));
  const weight = (r) => Math.sqrt(r.count) + 1;
  const sum = src.reduce((s, r) => s + weight(r), 0) || 1;
  let at = 0;
  const regions = src.map((r) => {
    const from = at; at += weight(r) / sum;
    const col = spectrumAt((from + at) / 2);
    return { ...r, from, to: at, rgb: col, color: hex(col), neurons: [], points: [] };
  });
  const points = [];
  const point = (p, reg, file, dir) => {
    const col = spectrumAt(p.t + (rand() - 0.5) * 0.05).map((v) => Math.min(255, Math.round(v * (0.8 + rand() * 0.35))));
    const pt = { x: p.x, y: p.y, z: p.z, t: p.t, part: p.part, reg, col, size: 0.9 + rand() * rand() * 1.6, tw: rand() * Math.PI * 2, file, dir };
    points.push(pt);
    reg?.points.push(pt);
    return pt;
  };
  if (fromFiles) {
    // each region's files, sorted by folder, take the points of its stretch in order: a folder's files sit together
    const byRegion = regions.map(() => []);
    files.files.forEach((f, i) => byRegion[f[2]]?.push(i));
    const dirOf = (i) => files.dirs[files.files[i][0]];
    regions.forEach((reg, ri) => {
      const own = byRegion[ri].sort((a, b) => (dirOf(a) < dirOf(b) ? -1 : dirOf(a) > dirOf(b) ? 1 : 0));
      const spots = [];
      for (let k = 0; k < own.length; k++) { const s = sample(rand, reg.from, reg.to); if (s) spots.push(s); }
      spots.sort((a, b) => a.t - b.t || a.y - b.y);
      own.forEach((fi, k) => { if (spots[k]) point(spots[k], reg, fi, files.files[fi][0]); });
    });
  }
  const want = total ?? (fromFiles ? Math.max(FILL, points.length) : Math.max(9500, Math.min(13000, 9000 + chats.length * 30)));
  const regionAt = (t) => regions.find((r) => t >= r.from && t < r.to) || regions.at(-1) || null;
  while (points.length < want) { const s = sample(rand); if (!s) break; point(s, regionAt(s.t), -1, -1); }

  // threads: along a folder's files, and to a near point of the same region
  const links = [];
  for (let i = 1; i < points.length && links.length < 9000; i++) if (points[i].dir >= 0 && points[i].dir === points[i - 1].dir) links.push([i - 1, i]);
  for (let i = 0; i < points.length && links.length < 14000; i++) {
    const p = points[i];
    let best = -1; let bd = 0.05;
    for (let tr = 0; tr < 5; tr++) { const j = Math.floor(rand() * points.length); const q = points[j]; if (j === i || q.reg !== p.reg) continue; const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2; if (d < bd) { bd = d; best = j; } }
    if (best >= 0 && rand() < 0.4) links.push([i, best]);
  }

  // neurons: each chat sits among the files of its folder (or in its own region without an index)
  const neurons = [];
  for (const { pr, s } of chats) {
    let reg = fromFiles
      ? regions.filter((r) => r.path && under(pr.dir, r.path)).sort((a, b) => b.path.length - a.path.length)[0] || regions.find((r) => r.key === '*')
      : regions.find((r) => r.key === pr.key);
    reg ||= regions[0];
    if (!reg) continue;
    const r2 = rng(hashOf(s.id));
    const near = fromFiles ? reg.points.filter((p) => p.file >= 0 && under(files.dirs[p.dir], pr.dir)) : [];
    const cortex = reg.points.filter((p) => p.part === 'cerebrum');
    const pool = near.length ? near : cortex.length ? cortex : reg.points.length ? reg.points : points;
    if (!pool.length) continue;
    const home = pool[Math.floor(r2() * pool.length)];
    const n = { pr, s, reg, x: home.x, y: home.y, z: home.z, key: `${pr.key}/${s.id}` };
    reg.neurons.push(n);
    neurons.push(n);
  }
  const wires = [];
  for (const reg of regions) {
    for (const n of reg.neurons) {
      const near = reg.neurons.filter((m) => m !== n).map((m) => [m, (m.x - n.x) ** 2 + (m.y - n.y) ** 2 + (m.z - n.z) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, 2);
      for (const [m] of near) if (n.key < m.key || !near.some(([o]) => o === m)) wires.push([n, m]);
    }
  }
  const biggest = Math.max(1, ...chats.map(({ s }) => s.size || 0));
  for (const n of neurons) n.r = 1.6 + 2.6 * Math.sqrt((n.s.size || 0) / biggest);
  for (const r of regions) delete r.points;
  const pathOf = (p) => (p.file >= 0 ? join(files.dirs[files.files[p.file][0]], files.files[p.file][1]) : '');
  return { points, links, neurons, wires, regions, files: fromFiles ? files : null, pathOf };
}

/** The live view on a canvas. */
export class BrainView {
  constructor(canvas, { calm = false, onPick = () => {}, onPickFile = () => {}, onHover = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.calm = calm;
    this.onPick = onPick;
    this.onPickFile = onPickFile;
    this.onHover = onHover;
    this.yaw = Math.PI / 2 + 0.25; this.pitch = 0.1; this.zoom = 1; // starts from the side, where it reads as a brain
    this.cam = { x: 0, y: 0, z: 0 }; this.goal = null; // where the camera flies to
    this.model = null;
    this.match = null; // a function chat -> bool while searching
    this.focus = null; // a region key
    this.selected = null; // a neuron key or 'file:<point index>'
    this.lit = null; // indices of points lit up for the chat
    this.hover = null;
    this.traces = [];
    this.running = false;
    this.boot = calm ? 1 : 0; // it builds itself when it first appears
    this.last = 0;
    this.screen = []; // [neuron, x, y, r, z] as last drawn, for hit tests
    this.sx = null; this.sy = null; // every point's place on screen, as last drawn
    this.#wire();
  }

  setData(projects, files = null) {
    this.model = buildBrain(projects, files);
    this.traces = []; // they point at neurons of the old brain
    this.lit = null;
    if (String(this.selected).startsWith('file:')) this.selected = null;
    if (this.calm) this.boot = 1;
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
        if (!this.dragging && !this.goal) this.yaw += dt * 0.055;
        this.boot = Math.min(1, this.boot + dt / 2.6);
        this.#fire(t);
      }
      this.#fly(this.calm ? 1 : Math.min(1, dt * 3));
      try { this.draw(t); } finally { requestAnimationFrame(tick); } // one bad frame must not stop the brain
    };
    requestAnimationFrame(tick);
  }

  stop() { this.running = false; }

  /** Screen position of a chat's neuron (for tests and for focusing). */
  locate(key) { const hit = this.screen.find(([n]) => n.key === key); return hit ? { x: hit[1], y: hit[2] } : null; }

  /** Lights up the points of these files and folders and flies the camera to them. Returns how many are lit. */
  show(paths) {
    const m = this.model;
    if (!m?.files) return 0;
    const want = (paths || []).map(low);
    const dirs = m.files.dirs.map(low);
    const name = (fi) => low(join(m.files.dirs[m.files.files[fi][0]], m.files.files[fi][1]));
    const lit = new Set();
    m.points.forEach((p, i) => {
      if (p.file < 0) return;
      const full = name(p.file); const dir = dirs[p.dir];
      if (want.some((w) => full === w || dir === w || dir.startsWith(`${w}\\`) || dir.startsWith(`${w}/`))) lit.add(i);
    });
    // a file that is not drawn (a big index is thinned out) is stood in for by a point of its folder
    for (const w of want) {
      if ([...lit].some((i) => name(m.points[i].file) === w)) continue;
      const parent = w.replace(/[\\/][^\\/]*$/, '');
      const i = m.points.findIndex((p) => p.dir >= 0 && dirs[p.dir] === parent);
      if (i >= 0) lit.add(i);
    }
    this.lit = lit.size ? lit : null;
    if (lit.size) {
      let x = 0; let y = 0; let z = 0;
      for (const i of lit) { x += m.points[i].x; y += m.points[i].y; z += m.points[i].z; }
      x /= lit.size; y /= lit.size; z /= lit.size;
      let yaw = Math.atan2(-x, z); // turn so that the spot faces you
      while (yaw - this.yaw > Math.PI) yaw -= Math.PI * 2;
      while (this.yaw - yaw > Math.PI) yaw += Math.PI * 2;
      const spread = Math.max(0.05, ...[...lit].map((i) => Math.hypot(m.points[i].x - x, m.points[i].y - y, m.points[i].z - z)));
      this.goal = { x: x * 0.85, y: y * 0.85, z: z * 0.85, yaw, pitch: 0.1, zoom: Math.max(1.2, Math.min(3, 0.9 / spread)) };
    }
    if (!this.running) { this.#fly(1); this.draw(); }
    return lit.size;
  }

  /** Back to the whole brain. */
  overview() {
    this.lit = null;
    this.goal = { x: 0, y: 0, z: 0, yaw: this.yaw, pitch: 0.1, zoom: 1, release: true };
    if (!this.running) { this.#fly(1); this.draw(); }
  }

  #fly(k) {
    const g = this.goal;
    if (!g) return;
    for (const a of ['x', 'y', 'z']) this.cam[a] += (g[a] - this.cam[a]) * k;
    this.yaw += (g.yaw - this.yaw) * k; this.pitch += (g.pitch - this.pitch) * k; this.zoom += (g.zoom - this.zoom) * k;
    if (g.release && Math.abs(this.zoom - g.zoom) < 0.01 && Math.hypot(this.cam.x, this.cam.y, this.cam.z) < 0.01) this.goal = null;
  }

  #project(x, y, z, w, h) {
    x -= this.cam.x; y -= this.cam.y; z -= this.cam.z;
    const cy = Math.cos(this.yaw); const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    const x1 = x * cy + z * sy; const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp; const z2 = y * sp + z1 * cp;
    const D = 3.4;
    const f = D / Math.max(0.4, D - z2);
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
    const W = Math.round(w * dpr); const H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.img = null; }
    if (!this.img) { this.img = ctx.createImageData(W, H); this.px = new Uint32Array(this.img.data.buffer); }
    this.px.fill(0xff000000); // black
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.model) { ctx.putImageData(this.img, 0, 0); return; }
    const { points, links, neurons, wires } = this.model;
    const reveal = this.boot >= 1 ? Infinity : -1.2 + this.boot * 2.6; // the brain builds itself from the stem upwards
    const dimOf = (reg) => (this.focus && reg?.key !== this.focus ? 0.12 : 1);
    const depthA = (z) => 0.3 + 0.7 * Math.max(0, Math.min(1, (z + 1.3) / 2.6));
    const quiet = this.lit ? 0.55 : this.match ? 0.45 : 1;
    const n = points.length;
    if (!this.sx || this.sx.length !== n) { this.sx = new Float32Array(n); this.sy = new Float32Array(n); }
    const data = this.img.data;
    // the same projection as #project, unrolled: this loop runs for every point in every frame
    const cy = Math.cos(this.yaw); const syaw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    const D = 3.4; const scale = Math.min(w / 2.9, h / 2.35) * this.zoom;
    const cx = this.cam.x; const cyy = this.cam.y; const cz = this.cam.z;
    const grow = (0.95 + this.zoom * 0.25) * dpr;
    const hasFiles = !!this.model.files;
    const sx = this.sx; const sy = this.sy;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (p.y >= reveal) { sx[i] = -1e4; continue; }
      const x0 = p.x - cx; const y0 = p.y - cyy; const z0 = p.z - cz;
      const x1 = x0 * cy + z0 * syaw; const z1 = -x0 * syaw + z0 * cy;
      const y2 = y0 * cp - z1 * sp; const z2 = y0 * sp + z1 * cp;
      const f = D / Math.max(0.4, D - z2);
      const x = w / 2 + x1 * scale * f; const y = h * 0.5 - (y2 - 0.08) * scale * f;
      sx[i] = x; sy[i] = y;
      const depth = z2 < -1.3 ? 0.3 : z2 > 1.3 ? 1 : 0.3 + 0.7 * ((z2 + 1.3) / 2.6);
      const tw = this.calm ? 1 : 0.8 + 0.2 * Math.sin(t / 900 + p.tw);
      let a = (p.file >= 0 || !hasFiles ? 0.95 : 0.5) * (0.35 + 0.65 * depth) * tw * quiet;
      if (this.focus && p.reg?.key !== this.focus) a *= 0.12;
      if (reveal !== Infinity) a *= Math.min(1, (reveal - p.y) * 3);
      if (a < 0.02) continue;
      if (a > 1) a = 1;
      const size = Math.max(1, (p.size * f * grow + 0.5) | 0);
      const px0 = (x * dpr - size / 2 + 0.5) | 0; const py0 = (y * dpr - size / 2 + 0.5) | 0;
      if (px0 >= W || py0 >= H || px0 + size <= 0 || py0 + size <= 0) continue;
      const r = p.col[0] * a; const g = p.col[1] * a; const b = p.col[2] * a;
      const ye = Math.min(H, py0 + size); const xe = Math.min(W, px0 + size);
      for (let yy = py0 < 0 ? 0 : py0; yy < ye; yy++) {
        let o = (yy * W + (px0 < 0 ? 0 : px0)) * 4;
        for (let xx = px0 < 0 ? 0 : px0; xx < xe; xx++, o += 4) { // added light: overlapping points grow brighter
          data[o] += r; data[o + 1] += g; data[o + 2] += b; // a Uint8ClampedArray stops at 255 by itself
        }
      }
    }
    ctx.putImageData(this.img, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 0.6;
    // threads, one path per region, so thousands of them cost a handful of strokes
    const byReg = new Map();
    for (const [i, j] of links) {
      if (sx[i] < -9e3 || sx[j] < -9e3) continue;
      const reg = points[i].reg;
      let path = byReg.get(reg);
      if (!path) { path = new Path2D(); byReg.set(reg, path); }
      path.moveTo(sx[i], sy[i]); path.lineTo(sx[j], sy[j]);
    }
    for (const [reg, path] of byReg) {
      const [r, g, b] = reg?.rgb || [255, 255, 255];
      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.07 * dimOf(reg) * quiet).toFixed(3)})`;
      ctx.stroke(path);
    }
    // the files the chat is talking about
    if (this.lit) {
      for (const i of this.lit) {
        if (this.sx[i] < -9e3) continue;
        const x = this.sx[i]; const y = this.sy[i];
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 16);
        glow.addColorStop(0, 'rgba(255,255,255,.6)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      // a few lit files carry their names
      if (this.lit.size <= 6) {
        ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        for (const i of this.lit) {
          if (this.sx[i] < -9e3) continue;
          const f = this.model.files.files[points[i].file];
          const right = this.sx[i] + 14 + ctx.measureText(f[1]).width < w - 8;
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillText(f[1], this.sx[i] + (right ? 14 : -14), this.sy[i] + 4);
        }
        ctx.textAlign = 'left';
      }
    }
    this.screen = [];
    this.np = null;
    if (this.boot >= 0.6) {
      const appear = Math.min(1, (this.boot - 0.6) / 0.4);
      const np = new Map(neurons.map((nn) => [nn, this.#project(nn.x, nn.y, nn.z, w, h)]));
      this.np = np;
      ctx.lineWidth = 0.8;
      for (const [a, b] of wires) {
        const pa = np.get(a); const pb = np.get(b);
        const [r, g, bl] = a.reg.rgb;
        ctx.strokeStyle = `rgba(${r},${g},${bl},${(0.22 * depthA(pa[3]) * dimOf(a.reg) * appear).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      }
      for (const nn of neurons) {
        const [x, y, f, z] = np.get(nn);
        const fresh = Date.now() - nn.s.updated < DAY;
        const hit = !this.match || this.match(nn);
        const pulse = fresh && !this.calm ? 0.75 + 0.25 * Math.sin(t / 350 + nn.x * 9) : 1;
        const age = Math.max(0.45, 1 - (Date.now() - nn.s.updated) / (60 * DAY));
        const a = appear * depthA(z) * dimOf(nn.reg) * (hit ? 1 : 0.12) * pulse * (this.lit ? 0.5 : 1);
        const r = nn.r * 0.8 * f * (0.8 + this.zoom * 0.25);
        const [cr, cg, cb] = nn.reg.rgb;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        glow.addColorStop(0, `rgba(${cr},${cg},${cb},${(0.5 * a * age).toFixed(3)})`);
        glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${(0.9 * a * age).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
        if (hit && dimOf(nn.reg) === 1) this.screen.push([nn, x, y, r, z]);
      }
      ctx.globalCompositeOperation = 'source-over';
      for (const tr of this.traces) {
        const life = (t - tr.at) / 2600;
        const a = life < 0.15 ? life / 0.15 : 1 - (life - 0.15) / 0.85;
        const pts = tr.ns.map((nn) => np.get(nn)).filter(Boolean);
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
    }
    ctx.globalCompositeOperation = 'source-over';
    // the picked and the hovered thing: a ring and its name
    for (const key of [this.selected, this.hover?.key].filter(Boolean)) this.#label(key, key === this.selected, w);
  }

  #label(key, picked, w) {
    const ctx = this.ctx;
    let x; let y; let title; let sub;
    if (String(key).startsWith('file:')) {
      const i = Number(key.slice(5));
      const p = this.model.points[i];
      if (!p || !this.sx || this.sx[i] < -9e3) return;
      x = this.sx[i]; y = this.sy[i];
      const f = this.model.files.files[p.file];
      title = f[1]; sub = this.model.files.dirs[f[0]];
    } else {
      const nn = this.model.neurons.find((m) => m.key === key);
      const p = nn && this.np?.get(nn);
      if (!p) return;
      [x, y] = p; title = nn.s.title; sub = nn.pr.name;
    }
    ctx.strokeStyle = picked ? '#fff' : 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    title = title.length > 48 ? `${title.slice(0, 47)}…` : title;
    sub = sub.length > 60 ? `…${sub.slice(-59)}` : sub;
    ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
    const left = x + 15 + ctx.measureText(title).width > w - 8; // near the right edge the name goes on the left
    ctx.textAlign = left ? 'right' : 'left';
    const tx = left ? x - 15 : x + 15;
    ctx.fillStyle = '#fff';
    ctx.fillText(title, tx, y - 2);
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fillText(sub, tx, y + 13);
    ctx.textAlign = 'left';
  }

  /** What is under a point on the canvas: a chat's neuron first, then a file. */
  hitAt(x, y) {
    let best = null; let bd = 14 * 14;
    for (const [nn, nx, ny] of this.screen) { const d = (nx - x) ** 2 + (ny - y) ** 2; if (d < bd) { bd = d; best = nn; } }
    if (best) return best;
    if (!this.model?.files || !this.sx) return null;
    let bi = -1; bd = 7 * 7;
    const pts = this.model.points;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].file < 0) continue;
      const d = (this.sx[i] - x) ** 2 + (this.sy[i] - y) ** 2;
      if (d < bd && (!this.focus || pts[i].reg?.key === this.focus)) { bd = d; bi = i; }
    }
    return bi >= 0 ? { key: `file:${bi}`, file: bi, path: this.model.pathOf(pts[bi]) } : null;
  }

  #at(ev) { const r = this.canvas.getBoundingClientRect(); return this.hitAt(ev.clientX - r.left, ev.clientY - r.top); }

  #wire() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (ev) => { if (ev.button === 0) drag = { x: ev.clientX, y: ev.clientY, yaw: this.yaw, pitch: this.pitch, moved: false }; });
    window.addEventListener('pointermove', (ev) => {
      if (drag) {
        const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true; this.dragging = true;
        if (this.goal) this.goal = null; // you take over the camera
        c.classList.add('dragging');
        this.yaw = drag.yaw + dx * 0.008;
        this.pitch = Math.max(-0.9, Math.min(0.9, drag.pitch + dy * 0.006));
        if (!this.running) this.draw();
        return;
      }
      if (ev.target !== c) return;
      const hit = this.#at(ev);
      if (hit?.key !== this.hover?.key) { this.hover = hit; c.style.cursor = hit ? 'pointer' : ''; this.onHover(hit); if (!this.running) this.draw(); }
    });
    window.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null; this.dragging = false; c.classList.remove('dragging');
      if (!moved && ev.target === c) {
        const hit = this.#at(ev);
        if (hit && hit.file !== undefined) { this.selected = hit.key; this.onPickFile(hit.path); } else if (hit) this.onPick(hit);
      }
    });
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const k = Math.exp(-ev.deltaY * 0.0012);
      this.zoom = Math.max(0.5, Math.min(6, this.zoom * k));
      if (this.goal) this.goal.zoom = Math.max(0.5, Math.min(6, this.goal.zoom * k));
      if (!this.running) this.draw();
    }, { passive: false });
    c.addEventListener('dblclick', () => this.overview());
  }
}

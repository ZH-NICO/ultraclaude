// Everything the brain's views ask about the file index: filtered and sorted tables, pivots, the timeline,
// where the space goes, likely duplicates, and move plans made by rule. Plus tags and saved views.
import fs from 'node:fs';
import path from 'node:path';

const KINDS = {
  Documents: 'pdf doc docx odt rtf txt md tex pages epub mobi',
  Spreadsheets: 'xls xlsx ods csv tsv numbers',
  Slides: 'ppt pptx odp key',
  Images: 'jpg jpeg png gif webp bmp tif tiff heic svg raw cr2 nef psd ai ico',
  Video: 'mp4 mov mkv avi webm wmv m4v flv',
  Audio: 'mp3 wav flac m4a aac ogg opus wma mid',
  Code: 'js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php swift kt scala sh ps1 bat sql html css scss vue svelte json yaml yml toml xml ini ipynb',
  Archives: 'zip rar 7z tar gz bz2 xz iso',
  Programs: 'exe msi dll apk dmg app deb rpm jar bin',
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, list]) => list.split(' ').map((e) => [e, k])));
export const TYPES = [...Object.keys(KINDS), 'Other'];
export const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
export const typeOf = (name) => KIND_OF.get(extOf(name)) || 'Other';
const SIZES = [[100e3, 'under 100 kB'], [1e6, '100 kB – 1 MB'], [10e6, '1 – 10 MB'], [100e6, '10 – 100 MB'], [1e9, '100 MB – 1 GB'], [Infinity, 'over 1 GB']];
export const sizeBucket = (n) => (n === undefined ? 'unknown' : SIZES.find(([max]) => n < max)[1]);
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const inside = (dir, base) => dir === base || dir.startsWith(`${base}\\`) || dir.startsWith(`${base}/`);
const month = (t) => { if (!t) return 'unknown'; const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/** Tags on files and saved views, kept in one small file next to the profile. */
export class Tags {
  constructor(file) {
    this.file = file;
    this.data = { tags: {}, views: [] };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* none yet */ }
  }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* kept for this run */ } }
  of(p) { return this.data.tags[p] || []; }
  all() { const n = new Map(); for (const list of Object.values(this.data.tags)) for (const t of list) n.set(t, (n.get(t) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })); }
  change(paths, add = [], remove = []) {
    const clean = (l) => [].concat(l || []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean);
    const plus = clean(add); const minus = new Set(clean(remove));
    for (const p of paths.slice(0, 2000)) {
      const next = [...new Set([...this.of(p), ...plus])].filter((t) => !minus.has(t));
      if (next.length) this.data.tags[p] = next; else delete this.data.tags[p];
    }
    this.save();
  }
  move(done) { let hit = false; for (const { from, to } of done) if (this.data.tags[from]) { this.data.tags[to] = this.data.tags[from]; delete this.data.tags[from]; hit = true; } if (hit) this.save(); }
  saveView(v) {
    const name = String(v?.name || '').trim().slice(0, 60);
    if (!name) throw new Error('A saved view needs a name.');
    this.data.views = [...this.data.views.filter((x) => x.name !== name), { name, view: String(v.view || 'table'), filter: v.filter || {} }].slice(-30);
    this.save();
  }
  removeView(name) { this.data.views = this.data.views.filter((v) => v.name !== name); this.save(); }
}

/** The numbers of every file that passes the filter { q, type, ext, folder, from, to, min, max, tag }. */
export function select(index, tags, f = {}) {
  const words = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const isExt = (w) => /^(ext:\w{1,8}|\.\w{1,8})$/.test(w);
  const exts = new Set([...words.filter(isExt).map((w) => w.replace(/^ext:|^\./, '')), ...(f.ext ? [String(f.ext).toLowerCase().replace(/^\./, '')] : [])]);
  const terms = words.filter((w) => !isExt(w));
  const folder = f.folder ? norm(f.folder) : '';
  const low = index.dirs.map((d) => d.toLowerCase());
  const okDir = folder ? low.map((d) => inside(d, folder)) : null;
  const from = Number(f.from) || 0; const to = Number(f.to) || 0;
  const min = Number(f.min) || 0; const max = Number(f.max) || 0;
  const out = [];
  for (let i = 0; i < index.files.length; i++) {
    const [d, name, size, mtime] = index.files[i];
    if (okDir && !okDir[d]) continue;
    if (from && !(mtime >= from)) continue;
    if (to && !(mtime < to)) continue;
    if (min && !(size >= min)) continue;
    if (max && !(size < max)) continue;
    if (exts.size && !exts.has(extOf(name))) continue;
    if (f.type && typeOf(name) !== f.type) continue;
    if (terms.length) { const hay = `${low[d]}${path.sep}${name.toLowerCase()}`; if (!terms.every((t) => hay.includes(t))) continue; }
    if (f.tag && !tags.of(index.pathOf(i)).includes(f.tag)) continue;
    out.push(i);
  }
  return out;
}

export const row = (index, tags, i) => { const [d, name, size, mtime] = index.files[i]; const p = index.pathOf(i); return { path: p, name, dir: index.dirs[d], size: size ?? null, mtime: mtime ?? null, type: typeOf(name), tags: tags.of(p) }; };

/** The matching files as dots for an arrangement: an even sample of at most `limit`. */
export function points(index, tags, { filter, limit = 40_000 } = {}) {
  const hits = select(index, tags, filter);
  const regions = index.dirs.map((d) => index.regionOf(d).name);
  const step = Math.max(1, hits.length / limit);
  const dirs = new Map(); const files = [];
  for (let k = 0; k < hits.length && files.length < limit; k += step) {
    const i = hits[Math.floor(k)];
    const [d, name, size, mtime] = index.files[i];
    if (!dirs.has(d)) dirs.set(d, dirs.size);
    files.push([dirs.get(d), name, regions[d], typeOf(name), size ?? null, mtime ?? null, tags.of(index.pathOf(i))[0] || '']);
  }
  const out = []; for (const [d, j] of dirs) out[j] = index.dirs[d];
  return { total: hits.length, dirs: out, files };
}

export function table(index, tags, { filter, sort = 'mtime', desc = true, offset = 0, limit = 100 } = {}) {
  const hits = select(index, tags, filter);
  const by = {
    name: (i) => index.files[i][1].toLowerCase(), size: (i) => index.files[i][2] ?? -1, mtime: (i) => index.files[i][3] ?? 0,
    type: (i) => typeOf(index.files[i][1]), folder: (i) => index.dirs[index.files[i][0]].toLowerCase(),
  }[sort] || ((i) => index.files[i][3] ?? 0);
  const keyed = hits.map((i) => [by(i), i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * (desc ? -1 : 1) || a[1] - b[1]);
  const start = Math.max(0, Number(offset) || 0);
  let bytes = 0; for (const i of hits) bytes += index.files[i][2] || 0;
  return { total: hits.length, bytes, offset: start, rows: keyed.slice(start, start + Math.min(500, Number(limit) || 100)).map(([, i]) => row(index, tags, i)) };
}

export const DIMENSIONS = ['type', 'ext', 'region', 'folder', 'year', 'month', 'size', 'tag'];

function dimension(index, tags, key) {
  if (key === 'type') return (i) => typeOf(index.files[i][1]);
  if (key === 'ext') return (i) => extOf(index.files[i][1]) || '(none)';
  if (key === 'region') { const c = index.dirs.map((d) => index.regionOf(d)); return (i) => c[index.files[i][0]].name; }
  if (key === 'folder') return (i) => index.dirs[index.files[i][0]];
  if (key === 'year') return (i) => month(index.files[i][3]).slice(0, 4);
  if (key === 'month') return (i) => month(index.files[i][3]);
  if (key === 'size') return (i) => sizeBucket(index.files[i][2]);
  if (key === 'tag') return (i) => tags.of(index.pathOf(i))[0] || '(untagged)';
  throw new Error(`Unknown dimension "${key}". Use ${DIMENSIONS.join(', ')}.`);
}

/** A table of any two things: rows × columns, counting files or adding up their size. */
export function pivot(index, tags, { filter, rows = 'region', cols = 'type', value = 'count' } = {}) {
  const hits = select(index, tags, filter);
  const r = dimension(index, tags, rows); const c = dimension(index, tags, cols);
  const cells = new Map(); const rowT = new Map(); const colT = new Map(); let all = 0;
  for (const i of hits) {
    const a = r(i); const b = c(i); const v = value === 'size' ? index.files[i][2] || 0 : 1;
    const k = `${a}\u0000${b}`;
    cells.set(k, (cells.get(k) || 0) + v); rowT.set(a, (rowT.get(a) || 0) + v); colT.set(b, (colT.get(b) || 0) + v); all += v;
  }
  const order = (map, key, max) => {
    const list = [...map].sort(key === 'month' || key === 'year' ? (x, y) => (x[0] < y[0] ? 1 : -1) : (x, y) => y[1] - x[1]);
    return list.slice(0, max).map(([name, total]) => ({ name, total }));
  };
  const R = order(rowT, rows, 40); const C = order(colT, cols, 14);
  return { rows: R, cols: C, cells: R.map((a) => C.map((b) => cells.get(`${a.name}\u0000${b.name}`) || 0)), total: all, hidden: { rows: rowT.size - R.length, cols: colT.size - C.length }, by: { rows, cols, value } };
}

/** Files per month, split by type; the newest 48 months that have any. */
export function timeline(index, tags, { filter } = {}) {
  const months = new Map();
  for (const i of select(index, tags, filter)) {
    const t = index.files[i][3];
    if (!t) continue;
    const k = month(t);
    let m = months.get(k);
    if (!m) { m = { month: k, total: 0, bytes: 0, types: {} }; months.set(k, m); }
    const kind = typeOf(index.files[i][1]);
    m.total++; m.bytes += index.files[i][2] || 0; m.types[kind] = (m.types[kind] || 0) + 1;
  }
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  return { months: list.slice(-48), earlier: Math.max(0, list.length - 48) };
}

/** Where the space goes below a folder (or among the roots): subfolders and big files. */
export function storage(index, tags, { filter, path: at = '' } = {}) {
  const base = norm(at || filter?.folder);
  const parts = new Map(); let total = 0; const files = [];
  const roots = index.roots.map((r) => [r, norm(r)]);
  const childOf = index.dirs.map((d) => {
    const l = d.toLowerCase();
    if (!base) { const r = roots.find(([, n]) => inside(norm(d), n)); return r ? { name: r[0], path: r[0] } : null; }
    if (!inside(norm(d), base)) return null;
    if (norm(d) === base) return '';
    const rest = d.slice(base.length).replace(/^[\\/]+/, '');
    const first = rest.split(/[\\/]/)[0];
    return { name: first, path: d.slice(0, base.length + (l[base.length] === '\\' || l[base.length] === '/' ? 1 : 0)) + first };
  });
  for (const i of select(index, tags, { ...filter, folder: base || undefined })) {
    const c = childOf[index.files[i][0]];
    if (c === null) continue;
    const size = index.files[i][2] || 0;
    total += size;
    if (c === '') { files.push({ name: index.files[i][1], path: index.pathOf(i), size, count: 1, file: true }); continue; }
    let p = parts.get(c.path.toLowerCase());
    if (!p) { p = { name: c.name, path: c.path, size: 0, count: 0 }; parts.set(c.path.toLowerCase(), p); }
    p.size += size; p.count++;
  }
  const all = [...parts.values(), ...files].sort((a, b) => b.size - a.size);
  const shown = all.slice(0, 60);
  const rest = all.slice(60);
  if (rest.length) shown.push({ name: `${rest.length} more`, path: '', size: rest.reduce((s, x) => s + x.size, 0), count: rest.reduce((s, x) => s + x.count, 0), rest: true });
  return { path: at || filter?.folder || '', total, parts: shown };
}

/** Likely duplicates: same name and same size (contents are not read). Biggest waste first. */
export function duplicates(index, tags, { filter, min = 1000 } = {}) {
  const groups = new Map();
  for (const i of select(index, tags, filter)) {
    const [, name, size] = index.files[i];
    if (!(size >= min)) continue;
    const k = `${name.toLowerCase()}\u0000${size}`;
    const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]);
  }
  const list = [...groups.values()].filter((g) => g.length > 1).map((g) => ({ name: index.files[g[0]][1], size: index.files[g[0]][2], waste: index.files[g[0]][2] * (g.length - 1), files: g.slice(0, 20).map((i) => row(index, tags, i)) })).sort((a, b) => b.waste - a.waste);
  return { groups: list.slice(0, 80), total: list.length, waste: list.reduce((s, g) => s + g.waste, 0) };
}

/** A target that is free: "name (2).ext" and so on, also against the other targets of the same plan. */
function free(target, taken) {
  const ext = path.extname(target); const stem = target.slice(0, target.length - ext.length);
  let p = target;
  for (let n = 2; taken.has(p.toLowerCase()) || fs.existsSync(p); n++) p = `${stem} (${n})${ext}`;
  taken.add(p.toLowerCase());
  return p;
}

/** Moves for these files into a folder, or into subfolders of it by type, extension, year or month. */
export function organize(index, tags, { filter, paths, into, by = '' } = {}) {
  const picked = paths?.length ? paths.map(String) : select(index, tags, filter).map((i) => index.pathOf(i));
  if (!picked.length) throw new Error('No files are selected.');
  if (picked.length > 500) throw new Error(`${picked.length} files is too many for one plan (500 at most). Narrow the filter.`);
  const dir = String(into || '').trim() || (by ? String(filter?.folder || '') : '');
  if (!dir || !path.isAbsolute(dir)) throw new Error('Say which folder they should go into (a full path).');
  const byDate = by === 'year' || by === 'month';
  const taken = new Set();
  const moves = [];
  for (const from of picked) {
    const name = path.basename(from);
    let sub = '';
    if (by === 'type') sub = typeOf(name);
    else if (by === 'ext') sub = extOf(name) || 'no extension';
    else if (byDate) { let t = 0; try { t = fs.statSync(from).mtimeMs; } catch { continue; } sub = by === 'year' ? month(t).slice(0, 4) : path.join(month(t).slice(0, 4), month(t)); }
    else if (by) throw new Error('Sort by type, ext, year or month.');
    const target = path.join(dir, sub, name);
    if (path.resolve(target).toLowerCase() === path.resolve(from).toLowerCase()) continue;
    moves.push({ from, to: free(target, taken) });
  }
  if (!moves.length) throw new Error('These files are already where they belong.');
  return moves;
}

/** CSV of the filtered files. Cells that a spreadsheet would read as a formula are defused. */
export function csv(index, tags, { filter } = {}) {
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = ['name,folder,type,size_bytes,modified,tags'];
  for (const i of select(index, tags, filter).slice(0, 100_000)) { const r = row(index, tags, i); lines.push([r.name, r.dir, r.type, r.size, r.mtime ? new Date(r.mtime).toISOString() : '', r.tags.join(' ')].map(cell).join(',')); }
  return `${lines.join('\n')}\n`;
}

const TEXT = new Set([...KINDS.Code.split(' '), 'txt', 'md', 'csv', 'tsv', 'tex', 'log', 'rtf']);
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
/** A look into one file: the start of a text file, or a small picture. */
export function preview(file) {
  const st = fs.statSync(file);
  const base = { size: st.size, mtime: Math.round(st.mtimeMs) };
  if (!st.isFile()) return { ...base, kind: 'none' };
  const ext = extOf(path.basename(file));
  if (IMAGE[ext] && st.size <= 4e6) return { ...base, kind: 'image', data: `data:${IMAGE[ext]};base64,${fs.readFileSync(file).toString('base64')}` };
  if (TEXT.has(ext)) {
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(Math.min(6000, st.size)); fs.readSync(fd, buf, 0, buf.length, 0); return { ...base, kind: 'text', text: buf.toString('utf8'), cut: st.size > 6000 }; } finally { fs.closeSync(fd); }
  }
  return { ...base, kind: 'none' };
}

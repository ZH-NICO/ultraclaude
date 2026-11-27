// Where the brain's dots fly to: the same dots arranged as a table, a timeline, a map of disk space,
// clusters of duplicates or a sorted wall. Pure geometry: files and the server's exact numbers in,
// a list of { file, x, y, s } for the dots and labels for the headings out.

const BUCKETS = [[100e3, 'under 100 kB'], [1e6, '100 kB – 1 MB'], [10e6, '1 – 10 MB'], [100e6, '10 – 100 MB'], [1e9, '100 MB – 1 GB'], [Infinity, 'over 1 GB']];
export const month = (t) => { if (!t) return 'unknown'; const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

/** The value of a file along one dimension; the same words the server's pivot uses. */
export function keyOf(dim, f) {
  if (dim === 'type') return f.type;
  if (dim === 'ext') return extOf(f.name) || '(none)';
  if (dim === 'region') return f.region;
  if (dim === 'folder') return f.dir;
  if (dim === 'year') return month(f.mtime).slice(0, 4);
  if (dim === 'month') return month(f.mtime);
  if (dim === 'size') return f.size === null || f.size === undefined ? 'unknown' : BUCKETS.find(([max]) => f.size < max)[1];
  if (dim === 'tag') return f.tag || '(untagged)';
  return '';
}

/** `n` dots filling a box row by row from its top left (or from the bottom up), as evenly spaced as they fit. */
export function gridFill(box, n, { bottom = false, gap = 7 } = {}) {
  if (n <= 0 || box.w <= 0 || box.h <= 0) return [];
  const step = Math.max(1.2, Math.min(gap, Math.sqrt((box.w * box.h) / n)));
  let cols = Math.max(1, Math.floor(box.w / step));
  while (Math.ceil(n / cols) * step > box.h + step / 2 && cols < n) cols++;
  const sx = box.w / cols < step ? box.w / cols : step;
  const rows = Math.ceil(n / cols);
  const sy = rows * step > box.h ? box.h / rows : step;
  const s = Math.max(1.2, Math.min(11, Math.min(sx, sy) * 0.62));
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols);
    return { x: box.x + (i % cols) * sx + sx / 2, y: bottom ? box.y + box.h - r * sy - sy / 2 : box.y + r * sy + sy / 2, s };
  });
}

/**
 * Shares the dots out among the cells: cells = [{ count, files }]. When every file fits, one dot is one
 * file; otherwise each cell gets its share of `budget` (at least one dot if it holds anything).
 */
export function allot(cells, budget) {
  const total = cells.reduce((s, c) => s + c.count, 0);
  const per = total > budget ? total / budget : 1;
  return { per, counts: cells.map((c) => (c.count ? Math.max(1, Math.round(c.count / per)) : 0)) };
}

/** The dots of one cell: its real files first, repeated if the sample holds fewer than the cell shows. */
const pick = (files, n) => (files.length ? Array.from({ length: n }, (_, i) => files[i % files.length]) : Array(n).fill(null));

function place(cells, boxes, budget, opts) {
  const { per, counts } = allot(cells, budget);
  const dots = [];
  cells.forEach((c, i) => { const spots = gridFill(boxes[i], counts[i], opts); pick(c.files, spots.length).forEach((file, k) => dots.push({ file, ...spots[k], color: c.color })); });
  return { dots, per };
}

const group = (files, key) => { const m = new Map(); for (const f of files) { const k = key(f); const g = m.get(k); if (g) g.push(f); else m.set(k, [f]); } return m; };

/** Rows × columns, as the server counted them; each cell a little block of dots. */
export function tableLayout(area, files, pivot, budget, { maxRows = 12 } = {}) {
  const rows = pivot.rows.slice(0, maxRows);
  // months and years read left to right in time
  const order = pivot.cols.map((c, j) => j);
  if (pivot.by.cols === 'month' || pivot.by.cols === 'year') order.reverse();
  const cols = order.map((j) => pivot.cols[j]);
  const time = pivot.by.cols === 'month' || pivot.by.cols === 'year';
  // what the server's table leaves out still shows: one column for the rest, so no file disappears
  const shownNames = new Set(cols.map((c) => c.name));
  const rest = rows.map((r, i) => Math.max(0, r.total - pivot.cells[i].reduce((a, b) => a + b, 0)));
  const extra = rest.some((v) => v > 0);
  const lead = extra && time ? 1 : 0; // earlier times stand on the left, other values on the right
  const left = Math.min(180, area.w * 0.22); const top = 34;
  const cw = (area.w - left) / Math.max(1, cols.length + (extra ? 1 : 0)); const rh = Math.min(92, (area.h - top) / Math.max(1, rows.length));
  const byCell = group(files, (f) => `${keyOf(pivot.by.rows, f)}\u0000${keyOf(pivot.by.cols, f)}`);
  const byRow = group(files, (f) => keyOf(pivot.by.rows, f));
  const cells = []; const boxes = []; const labels = [];
  rows.forEach((r, i) => {
    labels.push({ kind: 'row', x: area.x, y: area.y + top + i * rh, w: left - 10, h: rh, text: r.name, value: r.total, filter: [[pivot.by.rows, r.name]] });
    cols.forEach((c, j) => {
      const v = pivot.cells[i][order[j]];
      const box = { x: area.x + left + (j + lead) * cw + 4, y: area.y + top + i * rh + 5, w: cw - 8, h: rh - 24 }; // its count goes underneath
      cells.push({ count: pivot.by.value === 'size' ? (byCell.get(`${r.name}\u0000${c.name}`)?.length || (v ? 1 : 0)) : v, files: byCell.get(`${r.name}\u0000${c.name}`) || [], color: r.name });
      boxes.push(box);
      if (v) labels.push({ kind: 'cell', ...box, y: box.y + box.h, h: 16, text: `${r.name}, ${c.name}`, value: v, filter: [[pivot.by.rows, r.name], [pivot.by.cols, c.name]] });
    });
    if (extra && rest[i]) {
      const files = (byRow.get(r.name) || []).filter((f) => !shownNames.has(keyOf(pivot.by.cols, f)));
      const box = { x: area.x + left + (lead ? 0 : cols.length) * cw + 4, y: area.y + top + i * rh + 5, w: cw - 8, h: rh - 24 };
      cells.push({ count: pivot.by.value === 'size' ? files.length || 1 : rest[i], files, color: r.name });
      boxes.push(box);
      labels.push({ kind: 'cell', ...box, y: box.y + box.h, h: 16, text: `${r.name}, ${time ? 'earlier' : 'other'}`, value: rest[i], filter: time ? [[pivot.by.rows, r.name], ['before', cols[0].name]] : [[pivot.by.rows, r.name]] });
    }
  });
  if (extra) labels.push({ kind: 'col', x: area.x + left + (lead ? 0 : cols.length) * cw, y: area.y, w: cw, h: top - 8, text: time ? 'earlier' : 'other', value: rest.reduce((a, b) => a + b, 0), filter: time ? [['before', cols[0].name]] : [] });
  cols.forEach((c, j) => labels.push({ kind: 'col', x: area.x + left + (j + lead) * cw, y: area.y, w: cw, h: top - 8, text: c.name, value: c.total, filter: [[pivot.by.cols, c.name]] }));
  return { ...place(cells, boxes, budget, { gap: 11 }), labels, more: pivot.rows.length - rows.length + pivot.hidden.rows };
}

/** A column of dots per month. */
export function timelineLayout(area, files, timeline, budget) {
  const months = timeline.months;
  const bottom = 40; const top = 20;
  const cw = area.w / Math.max(1, months.length);
  const max = Math.max(1, ...months.map((m) => m.total));
  const by = group(files, (f) => month(f.mtime));
  const cells = months.map((m) => ({ count: m.total, files: (by.get(m.month) || []).sort((a, b) => (a.region < b.region ? -1 : 1)) }));
  const h = area.h - top - bottom;
  const boxes = months.map((m, i) => { const bh = Math.max(8, (m.total / max) * h); return { x: area.x + i * cw + cw * 0.12, y: area.y + top + h - bh, w: cw * 0.76, h: bh }; });
  const labels = months.map((m, i) => ({ kind: 'month', x: area.x + i * cw, y: area.y, w: cw, h: area.h, text: m.month, value: m.total, top: boxes[i].y - area.y, filter: [['month', m.month]] }));
  return { ...place(cells, boxes, budget, { bottom: true, gap: 12 }), labels };
}

/** Where the space goes: one box per folder, its area by size, filled with its dots. */
export function spaceLayout(area, files, storage, budget, squarify) {
  const parts = storage.parts.filter((p) => p.size > 0);
  const rects = squarify(parts.map((p) => p.size), area.w, area.h).map((r) => ({ x: area.x + r.x, y: area.y + r.y, w: r.w, h: r.h }));
  const low = (p) => p.toLowerCase();
  const own = parts.map((p) => (p.rest || !p.path ? [] : files.filter((f) => { const d = low(p.file ? `${f.dir}${f.dir.includes('\\') ? '\\' : '/'}${f.name}` : f.dir); const b = low(p.path).replace(/[\\/]$/, ''); return d === b || d.startsWith(`${b}\\`) || d.startsWith(`${b}/`); })));
  const cells = parts.map((p, i) => ({ count: p.count, files: own[i], color: i }));
  const boxes = rects.map((r) => ({ x: r.x + 4, y: r.y + 4, w: r.w - 8, h: r.h - (r.h > 44 ? 38 : 8) }));
  const labels = parts.map((p, i) => ({ kind: 'box', ...rects[i], text: p.name, value: p.size, count: p.count, path: p.path, file: p.file, rest: p.rest }));
  return { ...place(cells, boxes, budget, { gap: 24 }), labels };
}

/** A small ring of dots for every set of copies. */
export function duplicateLayout(area, found) {
  const groups = found.groups.slice(0, 60);
  const cols = Math.max(1, Math.ceil(Math.sqrt((groups.length * area.w) / Math.max(1, area.h))));
  const rows = Math.max(1, Math.ceil(groups.length / cols));
  const cw = area.w / cols; const rh = Math.min(150, area.h / rows);
  const dots = []; const labels = [];
  groups.forEach((g, i) => {
    const cx = area.x + (i % cols) * cw + cw / 2; const cy = area.y + Math.floor(i / cols) * rh + rh / 2 - 8;
    const radius = Math.min(cw, rh) * 0.24;
    g.files.forEach((f, k) => { const a = (k / g.files.length) * Math.PI * 2 - Math.PI / 2; dots.push({ file: { ...f, region: f.region || '' }, x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, s: 5 }); });
    labels.push({ kind: 'dup', x: cx - cw / 2 + 3, y: cy - rh / 2 + 8, w: cw - 6, h: rh - 4, text: g.name, value: g.size, count: g.files.length, group: g });
  });
  return { dots, labels, per: 1, more: found.total - groups.length };
}

/** All dots in one wall, in order; bigger files are bigger dots. */
export function sortedLayout(area, files, sort = 'size', budget = files.length) {
  const by = { size: (a, b) => (b.size || 0) - (a.size || 0), mtime: (a, b) => (b.mtime || 0) - (a.mtime || 0), name: (a, b) => a.name.localeCompare(b.name), type: (a, b) => a.type.localeCompare(b.type) || (b.size || 0) - (a.size || 0), folder: (a, b) => a.dir.localeCompare(b.dir) }[sort];
  const step = files.length > budget ? files.length / budget : 1;
  const sorted = [...files].sort(by);
  const shown = Array.from({ length: Math.min(budget, files.length) }, (_, i) => sorted[Math.floor(i * step)]);
  const spots = gridFill({ x: area.x, y: area.y + 18, w: area.w, h: area.h - 18 }, shown.length, { gap: 22 });
  const max = Math.sqrt(Math.max(1, ...shown.map((f) => f.size || 0)));
  const dots = shown.map((file, i) => ({ file, x: spots[i].x, y: spots[i].y, s: spots[i].s * (0.55 + 0.9 * Math.sqrt(Math.sqrt(file.size || 0) / max)) }));
  const first = { size: 'biggest', mtime: 'newest', name: 'A', type: 'by type', folder: 'by folder' }[sort];
  return { dots, per: step, labels: [{ kind: 'note', x: area.x, y: area.y, w: area.w, h: 16, text: `${first} first, read like a page` }] };
}

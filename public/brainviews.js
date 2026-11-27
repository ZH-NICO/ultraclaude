// Everything you can do with the brain. There are no separate pages: the same dots fly from the brain into
// a table, a timeline, a map of disk space, clusters of copies or a sorted wall, and back. One filter and one
// period apply to all of them; the list of files slides up from below. Numbers come from the server's index.
import { tableLayout, timelineLayout, spaceLayout, duplicateLayout, sortedLayout } from './brainlayouts.js';
import { spectrumAt } from './brain.js';

export const VIEWS = [['brain', 'Brain'], ['pivot', 'Table'], ['timeline', 'Timeline'], ['storage', 'Space'], ['duplicates', 'Copies'], ['sorted', 'Sorted']];
const SHOWING = { brain: 'the brain', pivot: 'a table', timeline: 'the timeline', storage: 'your disk space', duplicates: 'likely copies', sorted: 'a sorted wall', table: 'the list' };
const DAY = 864e5;
const COLORS = { Documents: '#4DA3FF', Spreadsheets: '#7CFF6B', Slides: '#FF9F1C', Images: '#FF6BD6', Video: '#9B7BFF', Audio: '#FFE14D', Code: '#2EE6D6', Archives: '#C79A6B', Programs: '#FF5A5F', Other: '#8a8a8a' };
const LABEL = { type: 'Type', ext: 'Extension', region: 'Main folder', folder: 'Folder', year: 'Year', month: 'Month', size: 'Size', tag: 'Tag' };
const SIZE_RANGE = { 'under 100 kB': [0, 100e3], '100 kB – 1 MB': [100e3, 1e6], '1 – 10 MB': [1e6, 10e6], '10 – 100 MB': [10e6, 100e6], '100 MB – 1 GB': [100e6, 1e9], 'over 1 GB': [1e9, 0] };

export const bytes = (n) => (n === null || n === undefined ? '…' : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);
export const day = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…');
const num = (n) => Number(n).toLocaleString('en-GB');

/** The time range of a month ("2026-03") or a year ("2026"). */
export function range(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y) return null;
  return m ? { from: +new Date(y, m - 1, 1), to: +new Date(y, m, 1) } : { from: +new Date(y, 0, 1), to: +new Date(y + 1, 0, 1) };
}

/** What a pivot's row or column stands for, as a filter. `regions` maps main folder names to paths. */
export function cellFilter(dim, name, regions = {}) {
  if (dim === 'type') return { type: name };
  if (dim === 'ext') return name === '(none)' ? {} : { ext: name };
  if (dim === 'folder') return { folder: name };
  if (dim === 'region') return regions[name] ? { folder: regions[name] } : {};
  if (dim === 'year' || dim === 'month') return range(name) || {};
  if (dim === 'before') { const r = range(name); return r ? { to: r.from } : {}; }
  if (dim === 'size') { const r = SIZE_RANGE[name]; return r ? { min: r[0], max: r[1] } : {}; }
  if (dim === 'tag') return name === '(untagged)' ? {} : { tag: name };
  return {};
}

/** Squarified treemap: rectangles { x, y, w, h } in a w×h box, one per value (largest first). */
export function squarify(values, w, h) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total || w <= 0 || h <= 0) return values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const areas = values.map((v) => (v / total) * w * h);
  const out = [];
  let x = 0; let y = 0; let i = 0;
  while (i < areas.length) {
    const side = Math.min(w - x, h - y);
    const worst = (row, sum) => Math.max(...row.map((a) => Math.max((side * side * a) / (sum * sum), (sum * sum) / (side * side * a || 1e-9))));
    const row = [areas[i]]; let sum = areas[i]; let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], sum + areas[j]) <= worst(row, sum)) { row.push(areas[j]); sum += areas[j]; j++; }
    const thick = side ? sum / side : 0;
    const tall = w - x >= h - y; // fill a column on the left when the free box is wide
    let at = 0;
    for (const a of row) {
      const len = thick ? a / thick : 0;
      out.push(tall ? { x, y: y + at, w: thick, h: len } : { x: x + at, y, w: len, h: thick });
      at += len;
    }
    if (tall) x += thick; else y += thick;
    i = j;
  }
  return out;
}

export class BrainViews {
  constructor(ctx) {
    Object.assign(this, ctx); // $, h, api, toast, guard, query(), setQuery, brain(), showPaths, pickFile, askAbout, planned
    this.view = 'brain';
    this.filter = {};
    this.table = { sort: 'mtime', desc: true, offset: 0 };
    this.pivot = { rows: 'region', cols: 'month', value: 'count' };
    this.sort = 'size';
    this.drawer = null; // { kind: 'list', filter, title } | { kind: 'picked', paths } | { kind: 'copies' }
    this.selected = new Set();
    this.saved = { tags: [], views: [], types: Object.keys(COLORS) };
    this.regions = {};
    this.seq = 0;
  }

  /** The filter everything shares: the bar's choices and the search box. */
  current() {
    const f = { ...this.filter, q: this.query() };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== 0 && v !== undefined && v !== null));
  }

  async loadSaved() { try { this.saved = await this.api('GET', '/api/brain/saved'); } catch { /* an older server */ } this.bar(); }

  /** Goes to an arrangement ('table' opens the list over the current one). `by` says who asked. */
  open(view, { filter, rows, cols, value, sort, by } = {}) {
    if (filter) { const { q, ...rest } = filter; this.filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v)); this.setQuery(q || ''); }
    if (rows) this.pivot.rows = rows;
    if (cols) this.pivot.cols = cols;
    if (value) this.pivot.value = value;
    this.table.offset = 0; this.selected.clear(); this.bulk = '';
    if (view === 'table') { if (sort) this.table.sort = sort; this.drawer = { kind: 'list' }; }
    else if (VIEWS.some(([k]) => k === view)) { this.view = view; this.drawer = null; if (view === 'sorted' && sort) this.sort = sort; }
    this.by = by || '';
    this.shown = view;
    this.bar();
    this.refresh();
  }

  back() { this.open('brain', { filter: {} }); }

  set(patch) { Object.assign(this.filter, patch); for (const k of Object.keys(this.filter)) if (!this.filter[k]) delete this.filter[k]; this.table.offset = 0; this.selected.clear(); this.bulk = ''; this.bar(); this.refresh(); }

  bar() {
    const { h, $ } = this;
    const f = this.filter;
    const select = (label, value, options, onchange) => {
      const el = h('select', { 'aria-label': label, onchange: () => onchange(el.value) }, ...options.map(([v, text]) => h('option', { value: v }, text)));
      el.value = options.some(([v]) => v === value) ? value : '';
      return el;
    };
    const now = new Date(); const today = +new Date(now.getFullYear(), now.getMonth(), now.getDate()); const y = now.getFullYear();
    const periods = { today: { from: today }, week: { from: today - 6 * DAY }, month: { from: today - 29 * DAY }, year: range(String(y)), lastyear: range(String(y - 1)), older: { to: +new Date(y - 1, 0, 1) } };
    const period = Object.keys(periods).find((k) => (periods[k].from || 0) === (f.from || 0) && (periods[k].to || 0) === (f.to || 0)) || (f.from || f.to ? 'custom' : '');
    const sizes = { big: { min: 1e6 }, huge: { min: 100e6 }, giant: { min: 1e9 }, tiny: { max: 100e3 } };
    const size = Object.keys(sizes).find((k) => (sizes[k].min || 0) === (f.min || 0) && (sizes[k].max || 0) === (f.max || 0)) || (f.min || f.max ? 'custom' : '');
    $('brainBar').replaceChildren(...[
      select('File type', f.type || '', [['', 'Any type'], ...this.saved.types.map((t) => [t, t])], (type) => this.set({ type })),
      select('Period', period, [['', 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'This year'], ['lastyear', 'Last year'], ['older', 'Older'], ...(period === 'custom' ? [['custom', `${f.from ? day(f.from) : '…'} – ${f.to ? day(f.to - 1) : 'now'}`]] : [])], (v) => { if (v !== 'custom') this.set({ from: periods[v]?.from || 0, to: periods[v]?.to || 0 }); }),
      select('Size', size, [['', 'Any size'], ['tiny', 'Under 100 kB'], ['big', 'Over 1 MB'], ['huge', 'Over 100 MB'], ['giant', 'Over 1 GB'], ...(size === 'custom' ? [['custom', `${bytes(f.min || 0)} – ${f.max ? bytes(f.max) : '∞'}`]] : [])], (v) => { if (v !== 'custom') this.set({ min: sizes[v]?.min || 0, max: sizes[v]?.max || 0 }); }),
      this.saved.tags.length ? select('Tag', f.tag || '', [['', 'Any tag'], ...this.saved.tags.map((t) => [t.tag, `${t.tag} (${t.count})`])], (tag) => this.set({ tag })) : null,
      f.folder ? h('button', { type: 'button', class: 'fchip', title: `${f.folder}\nClick to remove`, onclick: () => this.set({ folder: '' }) }, `in ${f.folder.split(/[\\/]/).filter(Boolean).pop()} ✕`) : null,
      f.ext ? h('button', { type: 'button', class: 'fchip', onclick: () => this.set({ ext: '' }) }, `.${f.ext} ✕`) : null,
      Object.keys(this.current()).length ? h('button', { type: 'button', class: 'link', onclick: () => { this.filter = {}; this.setQuery(''); this.set({}); } }, 'Clear') : null,
      h('span', { class: 'spacer' }),
      ...this.saved.views.map((v) => h('span', { class: 'saved' },
        h('button', { type: 'button', class: 'fchip', onclick: () => this.open(v.view, { filter: { ...v.filter } }) }, `★ ${v.name}`),
        h('button', { type: 'button', class: 'x', 'aria-label': `Remove the saved view ${v.name}`, onclick: this.guard(async () => { this.saved.views = (await this.api('POST', '/api/brain/views', { remove: v.name })).views; this.bar(); }) }, '✕'))),
      this.saving ? this.saveForm() : h('button', { type: 'button', class: 'link', onclick: () => { this.saving = true; this.bar(); $('saveName')?.focus(); } }, 'Save view'),
    ].filter(Boolean));
    $('brainDock').replaceChildren(
      ...VIEWS.map(([k, text]) => h('button', { type: 'button', class: this.view === k ? 'on' : '', 'data-view': k, 'aria-pressed': String(this.view === k), onclick: () => this.open(k) }, text)),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', class: this.drawer ? 'on' : '', 'data-view': 'table', 'aria-expanded': String(!!this.drawer), onclick: () => { if (this.drawer) this.closeDrawer(); else this.open('table'); } }, 'List'));
  }

  saveForm() {
    const { h } = this;
    const name = h('input', { id: 'saveName', placeholder: 'Name this view', 'aria-label': 'Name of the saved view', maxlength: 60, onkeydown: (ev) => { if (ev.key === 'Escape') { this.saving = false; this.bar(); } } });
    return h('form', { class: 'save-form', onsubmit: this.guard(async (ev) => { ev.preventDefault(); this.saved.views = (await this.api('POST', '/api/brain/views', { name: name.value, view: this.drawer?.kind === 'list' ? 'table' : this.view, filter: this.current() })).views; this.saving = false; this.bar(); this.toast('View saved.'); }) }, name, h('button', { type: 'submit', class: 'btn' }, 'Save'));
  }

  /** The colour of a main folder, as the brain draws it. */
  color(region) {
    const hit = this.brain()?.model?.regions.find((r) => r.name === region);
    if (hit) return hit.rgb;
    let n = 0; for (const c of String(region)) n = (n * 31 + c.charCodeAt(0)) % 997;
    return spectrumAt(n / 997);
  }

  /** Puts the stage in order: the arrangement, the pill, the period picker and the list. */
  async refresh() {
    const seq = ++this.seq;
    this.pill();
    this.scrubber(seq);
    this.drawDrawer(seq);
    const brain = this.brain();
    if (!brain?.model) return;
    const filter = this.current();
    const stage = this.$('mapStage');
    stage.classList.toggle('arranged', this.view !== 'brain');
    try {
      if (this.view === 'brain') {
        if (brain.arrange) brain.setArrangement(null);
        this.overlay([]);
        if (!Object.keys(filter).length) { if (this.filtering) this.showPaths(null); this.filtering = false; return; }
        const r = await this.api('POST', '/api/brain/table', { filter, limit: 500 });
        if (seq === this.seq) { this.filtering = true; this.showPaths(r.rows.map((x) => x.path), `${num(r.total)} ${r.total === 1 ? 'file matches' : 'files match'}`); }
        return;
      }
      const wantPoints = this.view !== 'duplicates';
      const [points, data] = await Promise.all([
        wantPoints ? this.api('POST', '/api/brain/points', { filter }) : null,
        this.view === 'sorted' ? {} : this.api('POST', `/api/brain/${this.view}`, { filter, ...(this.view === 'pivot' ? this.pivot : {}) }),
      ]);
      // a single folder at the top says nothing: look inside until there is something to compare
      for (let depth = 0; this.view === 'storage' && !filter.folder && depth < 8; depth++) {
        const [only, more] = data.parts;
        if (!only || more || only.file || !only.path || seq !== this.seq) break;
        Object.assign(data, await this.api('POST', '/api/brain/storage', { filter, path: only.path }));
      }
      if (seq !== this.seq) return;
      const files = points?.files.map(([d, name, region, type, size, mtime, tag]) => ({ dir: points.dirs[d], name, region, type, size, mtime, tag })) || [];
      this.found = this.view === 'duplicates' ? data : null;
      this.filtering = false;
      let animate = true;
      brain.setArrangement((w, hh) => {
        const area = { x: 28, y: 62, w: w - 56, h: Math.max(120, hh - 62 - 118) };
        const budget = Math.min(brain.model.points.length, 26_000);
        let L;
        if (this.view === 'pivot') L = tableLayout(area, files, data, budget);
        else if (this.view === 'timeline') L = timelineLayout(area, files, data, budget);
        else if (this.view === 'storage') L = spaceLayout(area, files, data, budget, squarify);
        else if (this.view === 'duplicates') L = duplicateLayout(area, data);
        else L = sortedLayout(area, files, this.sort, Math.min(budget, Math.floor((area.w * area.h) / 40)));
        for (const d of L.dots) {
          // table rows and boxes bring their own colour; everything else takes the colour of its main folder
          d.rgb = typeof d.color === 'number' ? spectrumAt((d.color % 8) / 8) : this.color(d.file?.region ?? d.color);
        }
        this.layoutInfo = { per: L.per, more: L.more, total: points?.total ?? data.total, measured: data.measured };
        this.overlay(L.labels, animate); animate = false;
        this.pill();
        return L;
      });
      if (this.drawer?.kind === 'copies') this.drawDrawer(this.seq);
    } catch (err) {
      if (seq === this.seq) this.overlay([{ kind: 'note', x: 40, y: 120, w: 600, h: 40, text: err.message }]);
    }
  }

  /** The headings of an arrangement, as buttons over the dots. */
  overlay(labels, animate = false) {
    const { h } = this;
    const box = this.$('brainOverlay');
    const at = (l) => `left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px`;
    const list = (l) => () => { this.drawer = { kind: 'list', filter: Object.assign({}, ...l.filter.map(([d, n]) => cellFilter(d, n, this.regions))), title: l.text }; this.table.offset = 0; this.selected.clear(); this.bar(); this.drawDrawer(this.seq); };
    const monthName = (k) => new Date(range(k).from).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    const colName = (l) => (this.pivot.cols === 'month' && range(l.text) ? monthName(l.text) : this.pivot.cols === 'folder' ? l.text.split(/[\\/]/).pop() : l.text);
    const val = (v) => (this.view === 'pivot' && this.pivot.value === 'size' ? bytes(v) : num(v));
    const el = (l) => {
      if (l.kind === 'note') return h('p', { class: 'lb note', style: at(l) }, l.text);
      if (l.kind === 'row') return h('button', { type: 'button', class: 'lb row', style: at(l), title: `${l.text}: show these files`, onclick: list(l) }, h('span', {}, this.pivot.rows === 'folder' ? l.text.split(/[\\/]/).slice(-2).join('/') : l.text), h('small', {}, val(l.value)));
      if (l.kind === 'col') return h('button', { type: 'button', class: 'lb col', style: at(l), title: `${l.text}: ${val(l.value)}`, onclick: list(l) }, colName(l));
      if (l.kind === 'cell') return h('div', { class: 'lb cell', style: at(l) }, h('button', { type: 'button', 'aria-label': `${l.text}: ${val(l.value)}, show them`, onclick: list(l) }, val(l.value)));
      if (l.kind === 'month') return h('div', { class: 'lb month', style: at(l) }, h('button', { type: 'button', title: `${monthName(l.text)}: ${num(l.value)} files`, onclick: list(l) }, h('b', {}, num(l.value)), l.w > 26 ? h('small', {}, monthName(l.text)) : null));
      if (l.kind === 'dup') return h('div', { class: 'lb dup', style: at(l) }, h('button', { type: 'button', title: l.group.files.map((f) => f.path).join('\n'), onclick: () => { this.drawer = { kind: 'copies', group: l.group }; this.bar(); this.drawDrawer(this.seq); } }, h('span', {}, l.text), h('small', {}, `${bytes(l.value)} × ${l.count}`)));
      const small = l.w < 70 || l.h < 44;
      return h('div', { class: 'lb box', style: at(l) }, h('button', { type: 'button', title: `${l.path || l.text}\n${bytes(l.value)} · ${num(l.count)} files`, 'aria-label': `${l.text}, ${bytes(l.value)}`, onclick: () => { if (l.rest) return; if (l.file) this.pickFile(l.path); else this.set({ folder: l.path }); } }, small ? '' : [h('span', {}, l.text), h('small', {}, bytes(l.value))]));
    };
    const kids = labels.map(el);
    const controls = this.view === 'pivot' ? this.tableControls() : this.view === 'sorted' ? this.sortControls() : this.view === 'storage' && this.filter.folder ? h('div', { class: 'arr-controls' }, h('button', { type: 'button', class: 'btn', onclick: () => { const up = this.filter.folder.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''); this.set({ folder: up.length > 2 ? up : '' }); } }, 'Up one folder')) : null;
    box.replaceChildren(...kids, ...(controls ? [controls] : []));
    box.classList.remove('in');
    if (animate) { void box.offsetWidth; box.classList.add('in'); } // the headings fade in while the dots fly
  }

  tableControls() {
    const { h } = this;
    const dims = Object.entries(LABEL);
    const pick = (key, label, options) => { const el = h('select', { 'aria-label': label, onchange: () => { this.pivot[key] = el.value; this.refresh(); } }, ...options.map(([v, t]) => h('option', { value: v }, t))); el.value = this.pivot[key]; return el; };
    return h('div', { class: 'arr-controls' }, pick('rows', 'Rows', dims), h('span', {}, 'by'), pick('cols', 'Columns', dims), pick('value', 'Show', [['count', 'Number of files'], ['size', 'Size']]), h('button', { type: 'button', class: 'btn', onclick: () => { [this.pivot.rows, this.pivot.cols] = [this.pivot.cols, this.pivot.rows]; this.refresh(); } }, 'Swap'));
  }

  sortControls() {
    const { h } = this;
    const el = h('select', { 'aria-label': 'Sort by', onchange: () => { this.sort = el.value; this.refresh(); } }, ...[['size', 'by size'], ['mtime', 'by date'], ['name', 'by name'], ['type', 'by type'], ['folder', 'by folder']].map(([v, t]) => h('option', { value: v }, t)));
    el.value = this.sort;
    return h('div', { class: 'arr-controls' }, h('span', {}, 'Sorted'), el);
  }

  /** "Showing a table · Back to the brain", like a remote control that says what it did. */
  pill() {
    const { h, $ } = this;
    const el = $('brainPill');
    const away = this.view !== 'brain' || this.by;
    el.hidden = !away;
    if (!away) return;
    const i = this.layoutInfo;
    const note = this.view !== 'brain' && i ? [i.per > 1.01 ? `1 dot ≈ ${num(Math.round(i.per))} files` : this.view === 'duplicates' ? '' : '1 dot = 1 file', i.measured === false ? 'sizes and dates still being read' : ''].filter(Boolean).join(' · ') : '';
    el.replaceChildren(...[
      h('span', {}, `${this.by ? `${this.by} is showing` : 'Showing'} ${SHOWING[this.by && this.shown ? this.shown : this.view]}`),
      note ? h('small', {}, note) : null,
      this.view === 'duplicates' && this.found?.total ? h('button', { type: 'button', class: 'link', onclick: () => { this.drawer = { kind: 'copies' }; this.bar(); this.drawDrawer(this.seq); } }, 'Set extra copies aside') : null,
      h('button', { type: 'button', class: 'link', onclick: () => this.back() }, 'Back to the brain'),
    ].filter(Boolean));
  }

  /** The period picker: files per month as little bars. Click a month, or drag over several. */
  async scrubber(seq) {
    const { h, $ } = this;
    const el = $('brainScrub');
    const { from, to, ...rest } = this.current();
    let r;
    try { r = await this.api('POST', '/api/brain/timeline', { filter: rest }); } catch { el.replaceChildren(); return; }
    if (seq !== this.seq) return;
    const months = r.months.slice(-36);
    if (months.length < 2) { el.replaceChildren(); return; }
    const max = Math.max(...months.map((m) => m.total));
    const inside = (m) => { const p = range(m.month); return (!from || p.to > from) && (!to || p.from < to); };
    let start = null;
    const mark = (a, b) => [...bars.children].forEach((c, i) => c.classList.toggle('sel', i >= Math.min(a, b) && i <= Math.max(a, b)));
    const apply = (a, b) => {
      const x = range(months[Math.min(a, b)].month).from; const y = range(months[Math.max(a, b)].month).to;
      this.set(x === from && y === to ? { from: 0, to: 0 } : { from: x, to: y });
    };
    const bars = h('div', { class: 'scrub-bars' }, ...months.map((m, i) => h('button', {
      type: 'button', class: (from || to) && inside(m) ? 'sel' : '', 'aria-label': `${m.month}: ${m.total} files`, title: `${m.month}: ${num(m.total)} files`,
      onpointerdown: (ev) => { start = i; ev.target.releasePointerCapture?.(ev.pointerId); },
      onpointerenter: () => { if (start !== null) mark(start, i); },
      onpointerup: () => { if (start !== null) { const a = start; start = null; apply(a, i); } },
      onclick: (ev) => { if (ev.detail === 0) apply(i, i); }, // from the keyboard
    }, h('i', { style: `height:${Math.max(8, Math.sqrt(m.total / max) * 100).toFixed(0)}%` }))));
    el.classList.toggle('picked', !!(from || to));
    el.replaceChildren(h('small', {}, from || to ? `${from ? day(from) : '…'} – ${to ? day(to - 1) : 'now'}` : 'Pick a period'), bars);
  }

  closeDrawer() { this.drawer = null; this.selected.clear(); this.bulk = ''; this.bar(); this.drawDrawer(this.seq); }

  /** The sheet that slides up with the files themselves. */
  async drawDrawer(seq) {
    const { h, $ } = this;
    const box = $('brainData');
    const d = this.drawer;
    if (!d) { box.hidden = true; box.replaceChildren(); return; }
    const head = (title) => h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Close the list', onclick: () => this.closeDrawer() }, '✕'));
    let kids;
    try {
      if (d.kind === 'picked') kids = [head(`${num(d.paths.length)} picked`), this.actions(d.paths), h('ul', { class: 'picked' }, ...d.paths.slice(0, 200).map((p) => h('li', {}, h('button', { type: 'button', title: p, onclick: () => this.pickFile(p) }, p))))];
      else if (d.kind === 'copies') {
        const found = this.found || await this.api('POST', '/api/brain/duplicates', { filter: this.current() });
        kids = [head(d.group ? d.group.name : 'Likely copies'), ...this.drawDuplicates(d.group ? { ...found, groups: [d.group], total: 1, waste: d.group.waste } : found)];
      } else {
        const filter = { ...this.current(), ...(d.filter || {}) };
        const r = await this.api('POST', '/api/brain/table', { filter, ...this.table, limit: 100 });
        this.listFilter = filter;
        kids = [head(d.title || 'Files'), ...this.drawTable(r)];
      }
    } catch (err) { kids = [head('Files'), h('p', { class: 'data-note' }, err.message)]; }
    if (seq !== this.seq || this.drawer !== d) return;
    const scroll = box.scrollTop;
    box.replaceChildren(...kids.filter(Boolean));
    box.hidden = false;
    box.scrollTop = scroll;
  }

  /** Files picked with a box on the stage. */
  picked(paths) { this.selected = new Set(paths); this.drawer = { kind: 'picked', paths }; this.bar(); this.drawDrawer(this.seq); }

  empty(text = 'No file matches these filters.') { return this.h('p', { class: 'data-empty' }, text); }

  // ---------- table ----------

  drawTable(r) {
    const { h } = this;
    const cols = [['name', 'Name'], ['type', 'Type'], ['size', 'Size'], ['mtime', 'Modified'], ['folder', 'Folder']];
    const head = h('div', { class: 'data-head' },
      h('p', {}, h('b', {}, num(r.total)), ` ${r.total === 1 ? 'file' : 'files'} · ${bytes(r.bytes)}`),
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn', onclick: this.guard(() => this.exportCsv()) }, 'Export CSV'),
        r.total && r.total <= 500 ? h('button', { type: 'button', class: 'btn', onclick: () => { this.bulk = this.bulk === 'all' ? '' : 'all'; this.drawDrawer(this.seq); } }, `Sort these ${num(r.total)}…`) : null));
    if (!r.total) return [head, this.empty()];
    const all = r.rows.every((x) => this.selected.has(x.path));
    const table = h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, h('input', { type: 'checkbox', 'aria-label': 'Select all on this page', checked: all, onchange: (ev) => { for (const x of r.rows) this.selected[ev.target.checked ? 'add' : 'delete'](x.path); this.drawDrawer(this.seq); } })),
        ...cols.map(([key, text]) => h('th', { class: `c-${key}`, 'aria-sort': this.table.sort === key ? (this.table.desc ? 'descending' : 'ascending') : 'none' },
          h('button', { type: 'button', onclick: () => { this.table = { sort: key, desc: this.table.sort === key ? !this.table.desc : key === 'size' || key === 'mtime', offset: 0 }; this.drawDrawer(this.seq); } }, text, this.table.sort === key ? (this.table.desc ? ' ↓' : ' ↑') : ''))),
        h('th', {}, 'Tags'))),
      h('tbody', {}, ...r.rows.map((x) => h('tr', { class: this.selected.has(x.path) ? 'sel' : '', onclick: (ev) => { if (!ev.target.closest('input,button')) this.pickFile(x.path); } },
        h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Select ${x.name}`, checked: this.selected.has(x.path), onchange: (ev) => { this.selected[ev.target.checked ? 'add' : 'delete'](x.path); this.drawDrawer(this.seq); } })),
        h('td', { class: 'c-name', title: x.path }, h('i', { style: `--tc:${COLORS[x.type]}` }), h('button', { type: 'button', onclick: () => this.pickFile(x.path) }, x.name)),
        h('td', {}, x.type), h('td', { class: 'c-size' }, bytes(x.size)), h('td', { class: 'c-mtime' }, day(x.mtime)),
        h('td', { class: 'c-folder', title: x.dir }, h('button', { type: 'button', onclick: () => this.set({ folder: x.dir }) }, h('bdi', {}, x.dir))),
        h('td', {}, ...x.tags.map((t) => h('button', { type: 'button', class: 'tag', onclick: () => this.set({ tag: t }) }, t)))))));
    const pages = r.total > 100 ? h('div', { class: 'pager' },
      h('button', { type: 'button', class: 'btn', disabled: !r.offset, onclick: () => { this.table.offset = Math.max(0, r.offset - 100); this.drawDrawer(this.seq); } }, 'Previous'),
      h('span', {}, `${num(r.offset + 1)}–${num(r.offset + r.rows.length)} of ${num(r.total)}`),
      h('button', { type: 'button', class: 'btn', disabled: r.offset + r.rows.length >= r.total, onclick: () => { this.table.offset = r.offset + 100; this.drawDrawer(this.seq); } }, 'Next')) : null;
    const bar = this.selected.size ? this.actions([...this.selected]) : this.bulk === 'all' && r.total <= 500 ? this.actions(null, r.total) : null;
    return [head, bar, h('div', { class: 'data-scroll' }, table), pages].filter(Boolean);
  }

  /** What can be done with the selected files (or all that match, when `paths` is null). */
  actions(paths, total = paths?.length) {
    const { h } = this;
    const into = h('input', { class: 'into', placeholder: 'Target folder (full path)', 'aria-label': 'Target folder', list: 'brainFolders', value: this.into || this.filter.folder || '', oninput: () => { this.into = into.value; } });
    const by = h('select', { 'aria-label': 'Subfolders' }, ...[['', 'directly into it'], ['type', 'in subfolders by type'], ['ext', 'by extension'], ['year', 'by year'], ['month', 'by month']].map(([v, t]) => h('option', { value: v }, t)));
    const tag = h('input', { class: 'tagin', placeholder: 'Tag', 'aria-label': 'Tag', maxlength: 40 });
    const change = (key) => this.guard(async () => { if (!tag.value.trim()) return; this.saved.tags = (await this.api('POST', '/api/brain/tags', { paths, [key]: [tag.value] })).tags; this.bar(); this.drawDrawer(this.seq); this.toast(key === 'add' ? 'Tagged.' : 'Tag removed.'); });
    return h('div', { class: 'pickbar', role: 'region', 'aria-label': 'Actions for the selected files' },
      h('b', {}, `${num(total)} ${paths ? 'selected' : 'matching'}`),
      h('span', { class: 'pg' }, into, by, h('button', { type: 'button', class: 'btn primary', onclick: this.guard(async () => {
        const plan = await this.api('POST', '/api/brain/plan', { ...(paths ? { paths } : { filter: this.listFilter || this.current() }), into: into.value, by: by.value });
        this.selected.clear(); this.bulk = ''; this.planned(plan); this.closeDrawer();
      }) }, 'Plan the move')),
      paths ? h('span', { class: 'pg' }, tag, h('button', { type: 'button', class: 'btn', onclick: change('add') }, 'Add tag'), h('button', { type: 'button', class: 'btn', onclick: change('remove') }, 'Remove')) : null,
      paths ? h('span', { class: 'pg' },
        h('button', { type: 'button', class: 'btn', onclick: () => { this.open('brain', { filter: {} }); setTimeout(() => this.showPaths(paths, 'your selection'), 0); } }, 'Show in brain'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.askAbout(`About these files:\n${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n(and ${paths.length - 20} more)` : ''}\n`) }, 'Ask Claude'),
        h('button', { type: 'button', class: 'link', onclick: () => { this.selected.clear(); if (this.drawer?.kind === 'picked') this.closeDrawer(); else this.drawDrawer(this.seq); } }, 'Clear')) : null);
  }

  async exportCsv() {
    const { csv } = await this.api('POST', '/api/brain/export', { filter: this.listFilter || this.current() });
    const a = this.h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'brain-files.csv' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- duplicates ----------

  drawDuplicates(r) {
    const { h } = this;
    const extras = r.groups.flatMap((g) => g.files.slice(1).map((f) => f.path)).slice(0, 500);
    const into = h('input', { class: 'into', placeholder: 'Folder for the extra copies', 'aria-label': 'Folder for the extra copies', list: 'brainFolders', value: this.dupInto ?? (this.home ? `${this.home}${this.home.includes('\\') ? '\\' : '/'}Duplicates` : ''), oninput: () => { this.dupInto = into.value; } });
    const head = h('div', { class: 'data-head' },
      h('p', {}, h('b', {}, num(r.total)), ` sets of files with the same name and size · ${bytes(r.waste)} in extra copies`));
    if (!r.total) return [head, this.empty('No likely duplicates here.')];
    return [head,
      h('div', { class: 'pickbar' }, h('b', {}, `${num(extras.length)} extra copies`), h('span', { class: 'pg' }, into, h('button', { type: 'button', class: 'btn primary', onclick: this.guard(async () => { this.planned(await this.api('POST', '/api/brain/plan', { paths: extras, into: into.value, reason: 'Extra copies, set aside. The first of each set stays where it is.' })); }) }, 'Plan setting them aside')),
        h('small', {}, 'Only names and sizes were compared. Check before you delete anything yourself.')),
      h('ul', { class: 'dups' }, ...r.groups.map((g) => h('li', {},
        h('p', {}, h('b', {}, g.name), ` ${bytes(g.size)} × ${g.files.length}`),
        h('ol', {}, ...g.files.map((f, i) => h('li', {}, h('button', { type: 'button', title: f.path, onclick: () => this.pickFile(f.path) }, f.dir), h('small', {}, `${day(f.mtime)}${i ? '' : ' · stays'}`)))))))];
  }
}

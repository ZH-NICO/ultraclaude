// The brain's other views: one filter bar for all of them, and Table, Pivot, Timeline, Storage and
// Duplicates drawn next to the 3D brain. Everything shown comes from the server's index.

export const VIEWS = [['brain', 'Brain'], ['table', 'Table'], ['pivot', 'Pivot'], ['timeline', 'Timeline'], ['storage', 'Storage'], ['duplicates', 'Duplicates']];
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
    Object.assign(this, ctx); // $, h, api, toast, guard, query(), setQuery, showPaths, pickFile, askAbout, planned, brainShown
    this.view = 'brain';
    this.filter = {};
    this.table = { sort: 'mtime', desc: true, offset: 0 };
    this.pivot = { rows: 'region', cols: 'type', value: 'count' };
    this.selected = new Set();
    this.saved = { tags: [], views: [], types: Object.keys(COLORS) };
    this.regions = {};
    this.seq = 0;
  }

  /** The filter all views share: the bar's choices and the search box. */
  current() {
    const f = { ...this.filter, q: this.query() };
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== 0 && v !== undefined && v !== null));
  }

  async loadSaved() { try { this.saved = await this.api('GET', '/api/brain/saved'); } catch { /* an older server */ } this.bar(); }

  open(view, { filter, rows, cols, value, sort } = {}) {
    if (VIEWS.some(([v]) => v === view)) this.view = view;
    if (filter) { const { q, ...rest } = filter; this.filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v)); this.setQuery(q || ''); }
    if (rows) this.pivot.rows = rows;
    if (cols) this.pivot.cols = cols;
    if (value) this.pivot.value = value;
    if (sort) this.table.sort = sort;
    this.table.offset = 0;
    this.selected.clear(); this.bulk = '';
    this.bar();
    this.refresh();
  }

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
      h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, ...VIEWS.map(([v, text]) => h('button', { type: 'button', class: this.view === v ? 'on' : '', 'data-view': v, onclick: () => this.open(v) }, text))),
      select('File type', f.type || '', [['', 'Any type'], ...this.saved.types.map((t) => [t, t])], (type) => this.set({ type })),
      select('Period', period, [['', 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'This year'], ['lastyear', 'Last year'], ['older', 'Older'], ...(period === 'custom' ? [['custom', `${f.from ? day(f.from) : '…'} – ${f.to ? day(f.to - 1) : 'now'}`]] : [])], (v) => { if (v !== 'custom') this.set({ from: periods[v]?.from || 0, to: periods[v]?.to || 0 }); }),
      select('Size', size, [['', 'Any size'], ['tiny', 'Under 100 kB'], ['big', 'Over 1 MB'], ['huge', 'Over 100 MB'], ['giant', 'Over 1 GB'], ...(size === 'custom' ? [['custom', `${bytes(f.min || 0)} – ${f.max ? bytes(f.max) : '∞'}`]] : [])], (v) => { if (v !== 'custom') this.set({ min: sizes[v]?.min || 0, max: sizes[v]?.max || 0 }); }),
      this.saved.tags.length ? select('Tag', f.tag || '', [['', 'Any tag'], ...this.saved.tags.map((t) => [t.tag, `${t.tag} (${t.count})`])], (tag) => this.set({ tag })) : null,
      f.folder ? h('button', { type: 'button', class: 'fchip', title: `${f.folder}\nClick to remove`, onclick: () => this.set({ folder: '' }) }, `in ${f.folder.split(/[\\/]/).filter(Boolean).pop()} ✕`) : null,
      f.ext ? h('button', { type: 'button', class: 'fchip', onclick: () => this.set({ ext: '' }) }, `.${f.ext} ✕`) : null,
      Object.keys(this.current()).length ? h('button', { type: 'button', class: 'link', onclick: () => { this.filter = {}; this.setQuery(''); this.open(this.view); } }, 'Clear') : null,
      h('span', { class: 'spacer' }),
      ...this.saved.views.map((v) => h('span', { class: 'saved' },
        h('button', { type: 'button', class: 'fchip', onclick: () => this.open(v.view, { filter: { ...v.filter } }) }, `★ ${v.name}`),
        h('button', { type: 'button', class: 'x', 'aria-label': `Remove the saved view ${v.name}`, onclick: this.guard(async () => { this.saved.views = (await this.api('POST', '/api/brain/views', { remove: v.name })).views; this.bar(); }) }, '✕'))),
      this.saving ? this.saveForm() : h('button', { type: 'button', class: 'link', onclick: () => { this.saving = true; this.bar(); $('saveName')?.focus(); } }, 'Save view'),
    ].filter(Boolean));
  }

  saveForm() {
    const { h } = this;
    const name = h('input', { id: 'saveName', placeholder: 'Name this view', 'aria-label': 'Name of the saved view', maxlength: 60, onkeydown: (ev) => { if (ev.key === 'Escape') { this.saving = false; this.bar(); } } });
    return h('form', { class: 'save-form', onsubmit: this.guard(async (ev) => { ev.preventDefault(); this.saved.views = (await this.api('POST', '/api/brain/views', { name: name.value, view: this.view, filter: this.current() })).views; this.saving = false; this.bar(); this.toast('View saved.'); }) }, name, h('button', { type: 'submit', class: 'btn' }, 'Save'));
  }

  /** Draws the active view with the current filter. */
  async refresh() {
    const { $, h } = this;
    const seq = ++this.seq;
    const box = $('brainData');
    box.hidden = this.view === 'brain';
    this.brainShown(this.view === 'brain');
    try {
      if (this.view === 'brain') {
        const filter = this.current();
        if (!Object.keys(filter).length) { if (this.filtering) this.showPaths(null); this.filtering = false; return; }
        const r = await this.api('POST', '/api/brain/table', { filter, limit: 500 });
        if (seq === this.seq) { this.filtering = true; this.showPaths(r.rows.map((x) => x.path), `${num(r.total)} ${r.total === 1 ? 'file matches' : 'files match'}`); }
        return;
      }
      const body = { filter: this.current(), ...(this.view === 'table' ? { ...this.table, limit: 100 } : {}), ...(this.view === 'pivot' ? this.pivot : {}) };
      const r = await this.api('POST', `/api/brain/${this.view}`, body);
      if (seq !== this.seq) return;
      const scroll = box.scrollTop;
      box.replaceChildren(...[
        r.measured === false ? h('p', { class: 'data-note' }, 'Sizes and dates are still being read…') : null,
        ...this[`draw${this.view[0].toUpperCase()}${this.view.slice(1)}`](r),
      ].filter(Boolean));
      box.scrollTop = scroll;
    } catch (err) {
      if (seq === this.seq && this.view !== 'brain') box.replaceChildren(h('p', { class: 'data-note' }, err.message));
    }
  }

  empty(text = 'No file matches these filters.') { return this.h('p', { class: 'data-empty' }, text); }

  // ---------- table ----------

  drawTable(r) {
    const { h } = this;
    const cols = [['name', 'Name'], ['type', 'Type'], ['size', 'Size'], ['mtime', 'Modified'], ['folder', 'Folder']];
    const head = h('div', { class: 'data-head' },
      h('p', {}, h('b', {}, num(r.total)), ` ${r.total === 1 ? 'file' : 'files'} · ${bytes(r.bytes)}`),
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn', onclick: this.guard(() => this.exportCsv()) }, 'Export CSV'),
        r.total && r.total <= 500 ? h('button', { type: 'button', class: 'btn', onclick: () => { this.bulk = this.bulk === 'all' ? '' : 'all'; this.refresh(); } }, `Sort these ${num(r.total)}…`) : null));
    if (!r.total) return [head, this.empty()];
    const all = r.rows.every((x) => this.selected.has(x.path));
    const table = h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, h('input', { type: 'checkbox', 'aria-label': 'Select all on this page', checked: all, onchange: (ev) => { for (const x of r.rows) this.selected[ev.target.checked ? 'add' : 'delete'](x.path); this.refresh(); } })),
        ...cols.map(([key, text]) => h('th', { class: `c-${key}`, 'aria-sort': this.table.sort === key ? (this.table.desc ? 'descending' : 'ascending') : 'none' },
          h('button', { type: 'button', onclick: () => { this.table = { sort: key, desc: this.table.sort === key ? !this.table.desc : key === 'size' || key === 'mtime', offset: 0 }; this.refresh(); } }, text, this.table.sort === key ? (this.table.desc ? ' ↓' : ' ↑') : ''))),
        h('th', {}, 'Tags'))),
      h('tbody', {}, ...r.rows.map((x) => h('tr', { class: this.selected.has(x.path) ? 'sel' : '', onclick: (ev) => { if (!ev.target.closest('input,button')) this.pickFile(x.path); } },
        h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Select ${x.name}`, checked: this.selected.has(x.path), onchange: (ev) => { this.selected[ev.target.checked ? 'add' : 'delete'](x.path); this.refresh(); } })),
        h('td', { class: 'c-name', title: x.path }, h('i', { style: `--tc:${COLORS[x.type]}` }), h('button', { type: 'button', onclick: () => this.pickFile(x.path) }, x.name)),
        h('td', {}, x.type), h('td', { class: 'c-size' }, bytes(x.size)), h('td', { class: 'c-mtime' }, day(x.mtime)),
        h('td', { class: 'c-folder', title: x.dir }, h('button', { type: 'button', onclick: () => this.set({ folder: x.dir }) }, h('bdi', {}, x.dir))),
        h('td', {}, ...x.tags.map((t) => h('button', { type: 'button', class: 'tag', onclick: () => this.set({ tag: t }) }, t)))))));
    const pages = r.total > 100 ? h('div', { class: 'pager' },
      h('button', { type: 'button', class: 'btn', disabled: !r.offset, onclick: () => { this.table.offset = Math.max(0, r.offset - 100); this.refresh(); } }, 'Previous'),
      h('span', {}, `${num(r.offset + 1)}–${num(r.offset + r.rows.length)} of ${num(r.total)}`),
      h('button', { type: 'button', class: 'btn', disabled: r.offset + r.rows.length >= r.total, onclick: () => { this.table.offset = r.offset + 100; this.refresh(); } }, 'Next')) : null;
    const bar = this.selected.size ? this.actions([...this.selected]) : this.bulk === 'all' && r.total <= 500 ? this.actions(null, r.total) : null;
    return [head, bar, h('div', { class: 'data-scroll' }, table), pages].filter(Boolean);
  }

  /** What can be done with the selected files (or all that match, when `paths` is null). */
  actions(paths, total = paths?.length) {
    const { h } = this;
    const into = h('input', { class: 'into', placeholder: 'Target folder (full path)', 'aria-label': 'Target folder', list: 'brainFolders', value: this.into || this.filter.folder || '', oninput: () => { this.into = into.value; } });
    const by = h('select', { 'aria-label': 'Subfolders' }, ...[['', 'directly into it'], ['type', 'in subfolders by type'], ['ext', 'by extension'], ['year', 'by year'], ['month', 'by month']].map(([v, t]) => h('option', { value: v }, t)));
    const tag = h('input', { class: 'tagin', placeholder: 'Tag', 'aria-label': 'Tag', maxlength: 40 });
    const change = (key) => this.guard(async () => { if (!tag.value.trim()) return; this.saved.tags = (await this.api('POST', '/api/brain/tags', { paths, [key]: [tag.value] })).tags; this.bar(); this.refresh(); this.toast(key === 'add' ? 'Tagged.' : 'Tag removed.'); });
    return h('div', { class: 'pickbar', role: 'region', 'aria-label': 'Actions for the selected files' },
      h('b', {}, `${num(total)} ${paths ? 'selected' : 'matching'}`),
      h('span', { class: 'pg' }, into, by, h('button', { type: 'button', class: 'btn primary', onclick: this.guard(async () => {
        const plan = await this.api('POST', '/api/brain/plan', { ...(paths ? { paths } : { filter: this.current() }), into: into.value, by: by.value });
        this.selected.clear(); this.bulk = ''; this.planned(plan); this.refresh();
      }) }, 'Plan the move')),
      paths ? h('span', { class: 'pg' }, tag, h('button', { type: 'button', class: 'btn', onclick: change('add') }, 'Add tag'), h('button', { type: 'button', class: 'btn', onclick: change('remove') }, 'Remove')) : null,
      paths ? h('span', { class: 'pg' },
        h('button', { type: 'button', class: 'btn', onclick: () => { this.view = 'brain'; this.bar(); this.$('brainData').hidden = true; this.brainShown(true); this.showPaths(paths, 'your selection'); } }, 'Show in brain'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.askAbout(`About these files:\n${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n(and ${paths.length - 20} more)` : ''}\n`) }, 'Ask Claude'),
        h('button', { type: 'button', class: 'link', onclick: () => { this.selected.clear(); this.refresh(); } }, 'Clear')) : null);
  }

  async exportCsv() {
    const { csv } = await this.api('POST', '/api/brain/export', { filter: this.current() });
    const a = this.h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'brain-files.csv' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- pivot ----------

  drawPivot(r) {
    const { h } = this;
    const dims = Object.entries(LABEL);
    const pick = (key, options) => { const el = h('select', { 'aria-label': key, onchange: () => { this.pivot[key] = el.value; this.refresh(); } }, ...options.map(([v, t]) => h('option', { value: v }, t))); el.value = this.pivot[key]; return el; };
    const head = h('div', { class: 'data-head' },
      h('p', {}, 'Rows ', pick('rows', dims), ' Columns ', pick('cols', dims), ' Show ', pick('value', [['count', 'Number of files'], ['size', 'Size']])),
      h('button', { type: 'button', class: 'btn', onclick: () => { [this.pivot.rows, this.pivot.cols] = [this.pivot.cols, this.pivot.rows]; this.refresh(); } }, 'Swap'));
    if (!r.rows.length) return [head, this.empty()];
    const show = (v) => (r.by.value === 'size' ? bytes(v) : num(v));
    const max = Math.max(1, ...r.cells.flat());
    const go = (...parts) => () => this.open('table', { filter: { ...this.current(), ...Object.assign({}, ...parts.map(([d, n]) => cellFilter(d, n, this.regions))) } });
    const short = (d, n) => (d === 'folder' ? `…${n.split(/[\\/]/).slice(-2).join('/')}` : n);
    const th = (d, n) => h('button', { type: 'button', title: n, onclick: go([d, n]) }, short(d, n));
    return [head, h('div', { class: 'data-scroll' }, h('table', { class: 'data pivot' },
      h('thead', {}, h('tr', {}, h('th', {}, `${LABEL[r.by.rows]} \\ ${LABEL[r.by.cols]}`), ...r.cols.map((c) => h('th', {}, th(r.by.cols, c.name))), h('th', {}, 'Total'))),
      h('tbody', {}, ...r.rows.map((a, i) => h('tr', {}, h('th', { scope: 'row' }, th(r.by.rows, a.name)),
        ...r.cells[i].map((v, j) => h('td', { class: 'cell', style: `--a:${v ? (0.08 + 0.6 * Math.sqrt(v / max)).toFixed(3) : 0}` }, v ? h('button', { type: 'button', onclick: go([r.by.rows, a.name], [r.by.cols, r.cols[j].name]) }, show(v)) : '')),
        h('td', { class: 'sum' }, show(a.total))))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Total'), ...r.cols.map((c) => h('td', { class: 'sum' }, show(c.total))), h('td', { class: 'sum' }, show(r.total)))))),
    r.hidden.rows || r.hidden.cols ? h('p', { class: 'data-note' }, `The biggest are shown; ${r.hidden.rows} more rows and ${r.hidden.cols} more columns are in the totals.`) : null].filter(Boolean);
  }

  // ---------- timeline ----------

  drawTimeline(r) {
    const { h } = this;
    const total = r.months.reduce((s, m) => s + m.total, 0);
    const head = h('div', { class: 'data-head' }, h('p', {}, h('b', {}, num(total)), ' files by the month they last changed. Click a month to see them.'));
    if (!r.months.length) return [head, this.empty()];
    const max = Math.max(...r.months.map((m) => m.total));
    const used = Object.keys(COLORS).filter((t) => r.months.some((m) => m.types[t]));
    const label = (k) => new Date(range(k).from).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    return [head,
      h('div', { class: 'timeline' }, ...r.months.map((m) => h('button', { type: 'button', class: 'tl', title: `${label(m.month)}: ${num(m.total)} files, ${bytes(m.bytes)}\n${used.filter((t) => m.types[t]).map((t) => `${t} ${m.types[t]}`).join(', ')}`, onclick: () => this.open('table', { filter: { ...this.current(), ...range(m.month) } }) },
        h('b', {}, num(m.total)),
        h('span', { class: 'tl-bar', style: `height:${Math.max(2, (m.total / max) * 100).toFixed(1)}%` }, ...used.filter((t) => m.types[t]).map((t) => h('i', { style: `flex:${m.types[t]};background:${COLORS[t]}` }))),
        h('small', {}, label(m.month))))),
      h('div', { class: 'legend' }, ...used.map((t) => h('button', { type: 'button', style: `--tc:${COLORS[t]}`, onclick: () => this.set({ type: this.filter.type === t ? '' : t }) }, h('i'), t))),
      r.earlier ? h('p', { class: 'data-note' }, `${r.earlier} earlier months are not drawn.`) : null].filter(Boolean);
  }

  // ---------- storage ----------

  drawStorage(r) {
    const { h } = this;
    const up = r.path ? r.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') : '';
    const head = h('div', { class: 'data-head' },
      h('p', {}, h('b', {}, bytes(r.total)), ` in ${r.path || 'everything'}`),
      r.path ? h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn', onclick: () => this.set({ folder: up.length > 2 ? up : '' }) }, 'Up one folder'), h('button', { type: 'button', class: 'btn', onclick: () => this.open('table', { filter: this.current(), sort: 'size' }) }, 'As a table')) : null);
    const parts = r.parts.filter((p) => p.size > 0);
    if (!parts.length) return [head, this.empty(r.measured ? 'Nothing here takes any space.' : 'Sizes are still being read…')];
    const box = this.$('brainData');
    const W = Math.max(320, box.clientWidth - 40); const H = Math.max(260, box.clientHeight - 110);
    const rects = squarify(parts.map((p) => p.size), W, H);
    return [head, h('div', { class: 'treemap', style: `width:${W}px;height:${H}px` }, ...parts.map((p, i) => {
      const q = rects[i];
      const small = q.w < 56 || q.h < 30;
      const hue = ['#FF5A5F', '#FF9F1C', '#FFE14D', '#7CFF6B', '#2EE6D6', '#4DA3FF', '#9B7BFF', '#FF6BD6'][i % 8];
      return h('button', { type: 'button', class: `tile${p.file ? ' file' : ''}${p.rest ? ' rest' : ''}`, style: `left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px;--tc:${p.rest ? '#666' : hue}`, title: `${p.path || p.name}\n${bytes(p.size)} · ${num(p.count)} ${p.count === 1 ? 'file' : 'files'}`, 'aria-label': `${p.name}, ${bytes(p.size)}`,
        onclick: () => { if (p.rest) return; if (p.file) this.pickFile(p.path); else this.set({ folder: p.path }); } },
      small ? '' : h('span', {}, p.name), small ? '' : h('small', {}, bytes(p.size)));
    }))];
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

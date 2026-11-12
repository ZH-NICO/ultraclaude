/* global Terminal, FitAddon */
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
const VIEWS = ['overview', 'agents', 'tasks', 'memory'];
const STATE = { working: 'working', waiting: 'needs you', idle: 'idle', starting: 'starting', stopped: 'stopped' };
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = { project: null, roles: [], agents: [], tasks: [], notes: [], noteCount: 0, view: 'overview', sel: null, want: null, grid: false, note: null, role: 'bugfixer' };
let ws;
let halted = false;

// ---------- helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// Only touch the DOM when something changed, so hover, focus and clicks survive live updates.
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value); };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-uc-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function toast(text, kind = '', onclick) {
  const el = h('div', { class: 'toast', onclick: () => { el.remove(); onclick?.(); } }, kind ? h('i', { class: `dot ${kind}` }) : null, h('span', {}, text));
  $('toasts').append(el);
  setTimeout(() => el.remove(), 8000);
}

const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { toast(err.message, 'error'); } };
const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const agentBy = (ref) => S.agents.find((a) => a.id === ref || a.name === ref);
const busy = (a) => a.state === 'working' || a.state === 'waiting';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- navigation ----------

function setView(view) {
  S.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  syncSide();
  if (view === 'overview') { syncGraph(); $('feed').scrollTop = $('feed').scrollHeight; }
  if (view === 'agents') layoutTerms();
  if (view === 'memory') loadNotes();
}

function openAgent(id) {
  S.sel = id;
  S.grid = false;
  setView('agents');
  terms.get(id)?.term.focus();
}

// ---------- sidebar ----------

const rows = new Map(); // agent id -> roster row

function syncSide() {
  for (const b of $('nav').children) b.classList.toggle('active', b.dataset.view === S.view);
  setText($('navTasks'), String(S.tasks.filter((t) => t.status !== 'done').length || ''));
  setText($('navNotes'), String(S.noteCount || ''));
  for (const [id, r] of rows) if (!agentBy(id)) { r.el.remove(); rows.delete(id); }
  for (const a of S.agents) {
    let r = rows.get(a.id);
    if (!r) {
      r = { dot: h('i'), nm: h('span', { class: 'nm' }), st: h('span', { class: 'st' }), act: h('span', { class: 'act' }) };
      r.el = h('button', { type: 'button', onclick: () => openAgent(a.id) }, r.dot, r.nm, r.st, r.act);
      rows.set(a.id, r);
      $('roster').append(r.el);
    }
    setAttr(r.el, 'class', `agent ${a.state}${S.view === 'agents' && !S.grid && S.sel === a.id ? ' active' : ''}`);
    setAttr(r.el, 'title', [a.roleName !== a.name ? a.roleName : '', busy(a) ? a.statusText : '', a.activity].filter(Boolean).join(' · ') || a.name);
    setAttr(r.dot, 'class', `dot ${a.state}`);
    setText(r.nm, a.name);
    setText(r.st, STATE[a.state]);
    setText(r.act, busy(a) ? a.activity || a.statusText : '');
  }
  $('rosterEmpty').hidden = S.agents.length > 0;
  $('gridBtn').hidden = S.agents.length < 2;
  $('gridBtn').classList.toggle('active', S.view === 'agents' && S.grid);
}

function syncSummary() {
  const count = (state) => S.agents.filter((a) => a.state === state).length;
  const waiting = count('waiting');
  const parts = [[count('working'), 'working'], [waiting, 'needs you', 'warn'], [count('idle'), 'idle'], [count('starting'), 'starting'], [count('stopped'), 'stopped']]
    .filter(([n]) => n).map(([n, label, cls]) => h('span', { class: cls || '' }, `${n} ${label}`));
  const out = S.agents.length ? [plural(S.agents.length, 'agent')] : [];
  for (const p of parts) out.push(' · ', p);
  $('summary').replaceChildren(...out);
  document.title = `${waiting ? `(${waiting}) ` : ''}${S.project?.name || ''} · UltraClaude`;
}

// ---------- overview graph ----------

const pos = new Map(); // agent id -> { x, y }
const gnodes = new Map(); // agent id -> svg parts
let hub = { x: 0, y: 0 };
let hubCount;
let graphSig = '';

function syncGraph() {
  const any = S.agents.length > 0;
  $('start').hidden = any;
  $('graph').style.visibility = any ? 'visible' : 'hidden';
  if (S.view !== 'overview' || !any) return;
  const w = $('stage').clientWidth;
  const ht = $('stage').clientHeight;
  if (!w || !ht) return;
  const sig = `${w}x${ht}:${S.agents.map((a) => a.id).join()}`;
  if (sig !== graphSig) { buildGraph(w, ht); graphSig = sig; }
  for (const a of S.agents) updateNode(a);
  setText(hubCount, plural(S.noteCount, 'note'));
}

function buildGraph(w, ht) {
  const compact = w < 640;
  const n = S.agents.length;
  hub = { x: Math.round(w / 2), y: Math.round(ht / 2) };
  const rx = Math.max(70, Math.min(w / 2 - (compact ? 120 : 225), 330));
  const ry = Math.max(70, Math.min(ht / 2 - 90, 200));
  pos.clear();
  gnodes.clear();
  const links = [];
  const nodes = [];
  S.agents.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const p = { x: Math.round(hub.x + cos * rx), y: Math.round(hub.y + sin * ry) };
    pos.set(a.id, p);
    links.push(svg('line', { class: 'g-link', x1: p.x, y1: p.y, x2: hub.x, y2: hub.y }));
    // labels sit on the outer side of the node so they never cross a link
    const side = Math.abs(cos) > 0.4 ? (cos > 0 ? 'right' : 'left') : sin > 0 ? 'bottom' : 'top';
    const anchor = side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle';
    const nd = { side, compact, title: svg('title'), nm: svg('text', { class: 'nm', 'text-anchor': anchor }), what: svg('text', { class: 'what', 'text-anchor': anchor }), now: svg('text', { class: 'now', 'text-anchor': anchor }) };
    nd.g = svg('g', { transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button' }, nd.title, svg('circle', { class: 'hit', r: 18 }), svg('circle', { class: 'mark', r: 6 }), nd.nm, nd.what, nd.now);
    nd.g.addEventListener('click', () => openAgent(a.id));
    nd.g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAgent(a.id); } });
    gnodes.set(a.id, nd);
    nodes.push(nd.g);
  });
  hubCount = svg('text', { class: 'count', y: 14 });
  const hubG = svg('g', { class: 'g-hub', transform: `translate(${hub.x},${hub.y})`, tabindex: 0, role: 'button' },
    svg('title', {}, 'Shared memory'), svg('rect', { x: -50, y: -22, width: 100, height: 44, rx: 4 }), svg('text', { class: 'nm', y: -3 }, 'Memory'), hubCount);
  hubG.addEventListener('click', () => setView('memory'));
  hubG.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setView('memory'); } });
  const g = $('graph');
  g.setAttribute('viewBox', `0 0 ${w} ${ht}`);
  g.replaceChildren(...links, svg('g', { id: 'pulses' }), hubG, ...nodes);
}

function updateNode(a) {
  const nd = gnodes.get(a.id);
  if (!nd) return;
  setAttr(nd.g, 'class', `g-node ${a.state}`);
  const lines = [[nd.nm, cut(a.name, 26)]];
  if (!nd.compact) {
    if (busy(a) && a.statusText) lines.push([nd.what, cut(a.statusText, 36)]);
    lines.push([nd.now, a.state === 'working' ? cut(a.activity || 'working', 30) : STATE[a.state]]);
  }
  for (const el of [nd.what, nd.now]) if (!lines.some(([used]) => used === el)) setText(el, '');
  const lineHeight = 17;
  lines.forEach(([el, text], i) => {
    let x = 0;
    let y;
    if (nd.side === 'right' || nd.side === 'left') { x = nd.side === 'right' ? 16 : -16; y = (i - (lines.length - 1) / 2) * lineHeight + 4; }
    else if (nd.side === 'bottom') y = 27 + i * lineHeight;
    else y = -17 - (lines.length - 1 - i) * lineHeight;
    setText(el, text);
    setAttr(el, 'x', x);
    setAttr(el, 'y', y);
  });
  setText(nd.title, [a.name, a.roleName !== a.name ? a.roleName : '', STATE[a.state], a.activity].filter(Boolean).join(' · '));
}

function fly(from, to, trace) {
  const layer = $('pulses');
  if (!layer) return;
  const done = (el) => () => el.remove();
  if (trace) {
    const line = svg('line', { class: 'g-trace', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    layer.append(line);
    line.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 1500 }).finished.then(done(line), done(line));
  }
  const dot = svg('circle', { class: 'g-pulse', r: 3.5 });
  layer.append(dot);
  dot.animate([{ transform: `translate(${from.x}px,${from.y}px)` }, { transform: `translate(${to.x}px,${to.y}px)` }],
    { duration: 750, easing: 'cubic-bezier(.4,0,.2,1)' }).finished.then(done(dot), done(dot));
}

function ping(at, cls = '') {
  const layer = $('pulses');
  if (!layer) return;
  const ring = svg('circle', { class: `g-ping ${cls}`, r: 6 });
  layer.append(ring);
  const move = `translate(${at.x}px,${at.y}px)`;
  ring.animate([{ transform: `${move} scale(1)`, opacity: 1 }, { transform: `${move} scale(3.4)`, opacity: 0 }],
    { duration: 900, easing: 'ease-out' }).finished.then(() => ring.remove(), () => ring.remove());
}

/** Shows an event in the graph: memory access runs along the spoke, messages between the two agents. */
function animate(e) {
  if (S.view !== 'overview' || calm || document.hidden) return;
  const at = (name) => pos.get(agentBy(name)?.id);
  const me = at(e.agent);
  if (e.type === 'memory' && me) return e.op === 'write' ? fly(me, hub) : fly(hub, me);
  if ((e.type === 'notify' || e.type === 'waiting') && me) return ping(me, 'warn');
  if (e.type !== 'message') return;
  const targets = e.to === 'all' ? S.agents.filter((a) => a.name !== e.agent).map((a) => pos.get(a.id)) : [at(e.to)];
  for (const t of targets.filter(Boolean)) { if (me) fly(me, t, true); else ping(t); }
}

// ---------- activity feed ----------

function feedItem(e) {
  const who = h('b', {}, e.agent === 'user' ? 'You' : e.agent);
  if (e.type === 'message' || e.type === 'notify') {
    const to = e.to === 'all' ? 'everyone' : e.to === 'user' ? 'you' : e.to;
    return h('li', { class: `ev-${e.type}` }, h('time', {}, clock(e.ts)), h('div', {}, who, ' → ', h('b', {}, to), h('p', {}, e.text)));
  }
  return h('li', { class: `ev-${e.type}` }, h('time', {}, clock(e.ts)), h('div', {}, who, ' ', e.text));
}

function addEvent(e) {
  const feed = $('feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  feed.append(feedItem(e));
  while (feed.children.length > 300) feed.firstChild.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function syncSelects() {
  const fill = (el, first) => {
    const keep = el.value;
    el.replaceChildren(h('option', { value: first[0] }, first[1]), ...S.agents.map((a) => h('option', { value: a.name }, a.name)));
    if ([...el.options].some((o) => o.value === keep)) el.value = keep;
  };
  fill($('msgTo'), ['all', 'Everyone']);
  fill($('taskAssignee'), ['', 'Unassigned']);
}

// ---------- terminals ----------

const terms = new Map(); // agent id -> { term, fit, pane, ... }
const pendingReplay = new Map(); // terminal output that arrived before we knew the agent

function ensureTerm(a) {
  if (terms.has(a.id)) return terms.get(a.id);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "IBM Plex Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#0a0b0d', foreground: '#e7e9eb', cursor: '#e7e9eb', selectionBackground: '#373d44' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData((d) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'in', id: a.id, d })));
  term.onResize(({ cols, rows: r }) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', id: a.id, cols, rows: r })));
  const t = { term, fit, opened: false, dot: h('i'), nm: h('span', { class: 'nm' }), meta: h('span', { class: 'meta' }) };
  t.toggle = h('button', { type: 'button', class: 'link', onclick: guard(() => {
    const now = agentBy(a.id);
    return api('POST', `/api/agents/${a.id}/${now.state === 'stopped' ? 'start' : 'stop'}`, { cols: term.cols, rows: term.rows });
  }) });
  const remove = h('button', { type: 'button', class: 'link', onclick: guard(async () => {
    if (confirm(`Remove agent “${agentBy(a.id)?.name}”? Its session will be ended.`)) await api('DELETE', `/api/agents/${a.id}`);
  }) }, 'Remove');
  t.off = h('div', { class: 'pane-off' }, 'Stopped. Start it to continue its session.');
  t.body = h('div', { class: 'pane-body' }, t.off);
  t.pane = h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, t.dot, t.nm, t.meta, t.toggle, remove), t.body);
  new ResizeObserver(() => fitTerm(t)).observe(t.body);
  $('terms').append(t.pane);
  terms.set(a.id, t);
  return t;
}

function fitTerm(t) {
  if (!t.opened || !t.body.clientWidth || !t.body.clientHeight) return;
  try { t.fit.fit(); } catch { /* not measurable yet */ }
}

function layoutTerms() {
  $('terms').classList.toggle('grid', S.grid);
  for (const a of S.agents) {
    const t = ensureTerm(a);
    const show = S.grid || S.sel === a.id;
    t.pane.hidden = !show;
    if (show && S.view === 'agents') {
      if (!t.opened) { t.term.open(t.body); t.opened = true; }
      requestAnimationFrame(() => fitTerm(t));
    }
  }
}

function syncPanes() {
  for (const a of S.agents) {
    const t = ensureTerm(a);
    setAttr(t.pane, 'class', `pane ${a.state}`);
    setAttr(t.dot, 'class', `dot ${a.state}`);
    setText(t.nm, a.name);
    setText(t.meta, [a.roleName !== a.name ? a.roleName : '', STATE[a.state], busy(a) ? a.activity || a.statusText : ''].filter(Boolean).join(' · '));
    setText(t.toggle, a.state === 'stopped' ? 'Start' : 'Stop');
    t.off.hidden = a.state !== 'stopped';
  }
}

function flushReplay() {
  for (const a of S.agents) {
    const d = pendingReplay.get(a.id);
    if (d) { ensureTerm(a).term.write(d); pendingReplay.delete(a.id); }
  }
}

// ---------- tasks ----------

const COLUMNS = [['todo', 'Open'], ['in_progress', 'In progress'], ['done', 'Done']];

function renderTasks() {
  $('board').replaceChildren(...COLUMNS.map(([status, label]) => {
    const items = S.tasks.filter((t) => t.status === status);
    const col = h('div', { class: 'col' }, h('header', {}, h('h2', {}, label), h('span', { class: 'num' }, String(items.length))),
      h('div', { class: 'list' }, items.length ? items.map((t) => {
        const assign = h('select', { 'aria-label': 'Assigned to', onchange: guard((ev) => api('PATCH', `/api/tasks/${t.id}`, { assignee: ev.target.value })) },
          h('option', { value: '' }, 'Unassigned'), S.agents.map((a) => h('option', { value: a.name }, a.name)));
        assign.value = agentBy(t.assignee) ? t.assignee : '';
        const move = h('select', { 'aria-label': 'Status', onchange: guard((ev) => api('PATCH', `/api/tasks/${t.id}`, { status: ev.target.value })) },
          COLUMNS.map(([value, text]) => h('option', { value }, text)));
        move.value = t.status;
        return h('div', { class: 'task', draggable: 'true', ondragstart: (ev) => ev.dataTransfer.setData('text/plain', String(t.id)) },
          h('div', { class: 't' }, h('span', { class: 'id' }, `#${t.id}`), t.title),
          t.description ? h('div', { class: 'd' }, t.description) : null,
          h('footer', {}, assign, move, h('button', { type: 'button', class: 'link', onclick: guard(() => api('DELETE', `/api/tasks/${t.id}`)) }, 'Delete')));
      }) : h('p', { class: 'none' }, status === 'todo' ? 'Nothing open.' : '—')));
    col.addEventListener('dragover', (ev) => { ev.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', (ev) => { if (!col.contains(ev.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', guard(async (ev) => {
      ev.preventDefault();
      col.classList.remove('over');
      const id = ev.dataTransfer.getData('text/plain');
      if (id) await api('PATCH', `/api/tasks/${id}`, { status });
    }));
    return col;
  }));
}

// ---------- memory ----------

const GROUPS = [['Memory', 'Project memory'], ['Global', 'Global memory'], ['Tasks', 'Board'], ['Agents', 'Agents'], ['Log', 'Journal'], ['Project', 'Project'], ['Vault', 'Other']];
let vaultInfo;

async function loadNotes() {
  try { S.notes = await api('GET', '/api/notes'); } catch { return; }
  S.noteCount = S.notes.filter((n) => n.kind === 'Memory' || n.kind === 'Global').length;
  renderNotes();
  syncSide();
}

function renderNotes() {
  const q = $('noteFilter').value.trim().toLowerCase();
  const out = [];
  for (const [kind, label] of GROUPS) {
    const notes = S.notes.filter((n) => (GROUPS.some(([k]) => k === n.kind) ? n.kind : 'Vault') === kind
      && (!q || `${n.title} ${n.excerpt} ${n.tags.join(' ')}`.toLowerCase().includes(q)));
    if (!notes.length) continue;
    out.push(h('h3', {}, label));
    for (const n of notes) {
      out.push(h('button', { type: 'button', class: `note ${S.note === n.path ? 'active' : ''}`, onclick: () => openNote(n.path) },
        h('b', {}, n.title), h('span', {}, [n.updated, ...n.authors].join(' · '))));
    }
  }
  $('noteList').replaceChildren(...(out.length ? out : [h('p', { class: 'none' }, q ? 'No matches.' : 'No notes yet. Your agents add them as they work.')]));
}

function inline(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`/g)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[3] ? h('code', {}, m[3]) : h('a', { onclick: () => openNote(m[1]) }, m[2] || m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function markdown(src) {
  const out = [];
  let list = null;
  let code = null;
  for (const line of src.split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) {
      if (code) { out.push(h('pre', {}, code.join('\n'))); code = null; } else code = [];
      list = null;
      continue;
    }
    if (code) { code.push(line); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (head) { out.push(h(`h${Math.min(3, head[1].length + 1)}`, {}, inline(head[2]))); list = null; }
    else if (item) { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', {}, inline(item[1]))); }
    else if (line.trim()) { out.push(h('p', {}, inline(line))); list = null; }
    else list = null;
  }
  if (code) out.push(h('pre', {}, code.join('\n')));
  return out;
}

const openNote = guard(async (ref) => {
  const n = await api('GET', `/api/note?path=${encodeURIComponent(ref)}`);
  S.note = n.path;
  $('noteView').replaceChildren(
    h('div', { class: 'note-meta' },
      h('button', { type: 'button', class: 'link', onclick: () => { S.note = null; $('noteView').replaceChildren(vaultInfo); renderNotes(); } }, '← All notes'),
      h('span', {}, n.path), h('span', {}, `updated ${n.updated}`),
      n.authors.length ? h('span', {}, `by ${n.authors.join(', ')}`) : null,
      n.tags.length ? h('span', {}, n.tags.map((t) => `#${t}`).join(' ')) : null),
    h('div', { class: 'doc' }, h('h1', {}, n.title), markdown(n.body)));
  $('noteView').scrollTop = 0;
  renderNotes();
});

const openInObsidian = guard(async (path) => {
  const { known } = await api('POST', '/api/open-obsidian', path ? { path } : {});
  if (!known) toast('Obsidian does not know this vault yet. In Obsidian choose “Open folder as vault” and pick the folder that just opened.', 'waiting');
});

// ---------- new agent ----------

function roleButton(r, onclick) {
  return h('button', { type: 'button', class: 'role', 'data-role': r.id, onclick }, h('b', {}, r.name), h('span', {}, r.blurb));
}

function selectRole(id) {
  const before = S.roles.find((r) => r.id === S.role);
  const role = S.roles.find((r) => r.id === id);
  S.role = id;
  for (const b of $('roleGrid').children) b.classList.toggle('selected', b.dataset.role === id);
  const name = $('fName');
  name.setCustomValidity('');
  if (!name.value || name.value === before?.name) name.value = id === 'custom' ? '' : role.name;
  name.placeholder = id === 'custom' ? 'e.g. Database expert' : role.name;
  $('fInstructions').placeholder = id === 'custom' ? 'Describe what this agent should do.' : 'e.g. Only work on the frontend.';
}

const createAgent = guard(async (body) => {
  const a = await api('POST', '/api/agents', body);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  // Show its terminal right away: a first start may ask to trust the folder there.
  if (agentBy(a.id)) openAgent(a.id); else S.want = a.id;
});

// ---------- live updates ----------

let agentSig = null;

function onAgents(agents) {
  S.agents = agents;
  const sig = agents.map((a) => `${a.id}:${a.name}`).join('|');
  if (!agentBy(S.sel)) S.sel = agents[0]?.id || null;
  if (sig !== agentSig) {
    agentSig = sig;
    for (const [id, t] of terms) if (!agentBy(id)) { t.term.dispose(); t.pane.remove(); terms.delete(id); }
    syncSelects();
    renderTasks();
    flushReplay();
    if (S.view === 'agents') { if (agents.length) layoutTerms(); else setView('overview'); }
  }
  syncPanes();
  syncSide();
  syncSummary();
  syncGraph();
  if (S.want && agentBy(S.want)) { const id = S.want; S.want = null; openAgent(id); }
}

function onEvent(e) {
  addEvent(e);
  animate(e);
  const jump = () => { const a = agentBy(e.agent); if (a) openAgent(a.id); };
  const notify = (title) => {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body: e.text });
  };
  if (e.type === 'waiting') { toast(`${e.agent} ${e.text}`, 'waiting', jump); notify(`${e.agent} needs you`); }
  else if (e.type === 'notify') { toast(`${e.agent}: ${e.text}`, 'waiting', jump); notify(`Message from ${e.agent}`); }
  else if (e.type === 'error') toast(`${e.agent} ${e.text}`, 'error');
}

async function loadState() {
  const st = await api('GET', '/api/state');
  Object.assign(S, { project: st.project, roles: st.roles, tasks: st.tasks, noteCount: st.notes });
  setText($('projectName'), S.project.name);
  $('projectName').title = S.project.dir;
  setText($('vaultPath'), S.project.vault);
  $('vaultPath').title = S.project.vault;
  $('obsidianHint').hidden = S.project.inObsidian;
  $('quickRoles').replaceChildren(...S.roles.filter((r) => r.id !== 'custom').map((r) => roleButton(r, () => createAgent({ roleId: r.id }))));
  $('roleGrid').replaceChildren(...S.roles.map((r) => roleButton(r, () => selectRole(r.id))));
  $('feed').replaceChildren();
  for (const e of st.events) addEvent(e);
  agentSig = null;
  onAgents(st.agents);
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?t=${TOKEN}`);
  ws.onopen = guard(async () => {
    $('conn').classList.add('on');
    setText($('connText'), 'connected');
    await loadState();
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'out') terms.get(m.id)?.term.write(m.d);
    else if (m.t === 'replay') {
      const t = terms.get(m.id);
      if (t) { t.term.reset(); t.term.write(m.d); } else pendingReplay.set(m.id, m.d);
    } else if (m.t === 'agents') onAgents(m.agents);
    else if (m.t === 'tasks') { S.tasks = m.tasks; renderTasks(); syncSide(); }
    else if (m.t === 'event') onEvent(m.e);
    else if (m.t === 'notes') { S.noteCount = m.count; syncSide(); syncGraph(); if (S.view === 'memory') loadNotes(); }
  };
  ws.onclose = () => {
    if (halted) return;
    $('conn').classList.remove('on');
    setText($('connText'), 'reconnecting');
    setTimeout(connect, 1500);
  };
}

function halt(title, text) {
  halted = true;
  stageObserver.disconnect();
  if (ws) { ws.onmessage = null; ws.close(); }
  document.body.replaceChildren(h('div', { class: 'halt' }, h('h1', {}, title), h('p', {}, text)));
}

// ---------- wiring ----------

$('nav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('showTools').addEventListener('change', (ev) => $('feed').classList.toggle('hide-tools', !ev.target.checked));
$('gridBtn').addEventListener('click', () => { S.grid = !(S.view === 'agents' && S.grid); setView('agents'); });
$('noteFilter').addEventListener('input', renderNotes);
$('openObsidian').addEventListener('click', () => openInObsidian(S.note)); // the open note, or the project folder
$('openFolder').addEventListener('click', guard(() => api('POST', '/api/open-vault-folder', {})));
$('addAgent').addEventListener('click', () => {
  $('agentForm').reset();
  $('fName').setCustomValidity('');
  selectRole(S.role);
  $('agentDialog').showModal();
});
$('agentCancel').addEventListener('click', () => $('agentDialog').close());
$('fName').addEventListener('input', () => $('fName').setCustomValidity(''));
$('agentForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (S.role === 'custom' && !$('fName').value.trim()) {
    $('fName').setCustomValidity('Give the custom role a name.');
    $('fName').reportValidity();
    return;
  }
  $('agentDialog').close();
  createAgent({
    roleId: S.role, name: $('fName').value.trim(), instructions: $('fInstructions').value, prompt: $('fPrompt').value.trim(),
    model: $('fModel').value, permissionMode: $('fPerm').value, worktree: $('fWorktree').checked,
  });
});
$('msgForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const text = $('msgText').value.trim();
  if (!text) return;
  await api('POST', '/api/message', { to: $('msgTo').value, text });
  $('msgText').value = '';
}));
$('taskForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  await api('POST', '/api/tasks', { title: $('taskTitle').value, assignee: $('taskAssignee').value });
  $('taskTitle').value = '';
}));
$('quit').addEventListener('click', guard(async () => {
  if (!confirm('Stop all agents and quit UltraClaude for this project?')) return;
  await api('POST', '/api/shutdown', {});
  halt('UltraClaude has stopped', 'Run “ultraclaude” in your project folder to start it again. You can close this window.');
}));
const stageObserver = new ResizeObserver(() => syncGraph());
stageObserver.observe($('stage'));

vaultInfo = $('vaultInfo');
if (TOKEN) connect();
else halt('Start UltraClaude from your terminal', 'Go to your project folder and run “ultraclaude”.');

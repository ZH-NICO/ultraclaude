/* global Terminal, FitAddon */
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);

const S = { project: null, roles: [], agents: [], tasks: [], events: [], notes: [], view: 'dashboard', sel: null, grid: false, note: null, role: 'bugfixer' };
const terms = new Map(); // agentId -> { term, fit, pane, body, opened, ... }
let ws;

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

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-uc-token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function toast(text, kind = '', onclick) {
  const el = h('div', { class: `toast ${kind}`, onclick: () => { el.remove(); onclick?.(); } }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { toast(err.message, 'err'); } };
const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const time = (ts) => new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
const STATE_LABEL = { working: 'arbeitet', waiting: 'braucht dich', idle: 'bereit', starting: 'startet', stopped: 'gestoppt' };
const agentBy = (ref) => S.agents.find((a) => a.id === ref || a.name === ref);

// ---------- navigation ----------

function setView(view) {
  S.view = view;
  for (const b of $('nav').children) b.classList.toggle('active', b.dataset.view === view);
  for (const v of ['dashboard', 'terminals', 'tasks', 'memory']) $(`view-${v}`).hidden = v !== view;
  if (view === 'terminals') layoutTerms();
  if (view === 'memory') loadNotes();
}

function openAgent(id) {
  S.sel = id;
  S.grid = false;
  setView('terminals');
  renderTabs();
  terms.get(id)?.term.focus();
}

// ---------- dashboard ----------

function renderTiles() {
  const count = (state) => S.agents.filter((a) => a.state === state).length;
  const waiting = count('waiting');
  const tiles = [
    [S.agents.filter((a) => a.state !== 'stopped').length, 'Agents aktiv'],
    [count('working'), 'arbeiten gerade'],
    [waiting, 'brauchen dich', waiting ? 'alert' : ''],
    [S.tasks.filter((t) => t.status !== 'done').length, 'offene Aufgaben'],
    [S.events.filter((e) => e.type === 'memory' && e.op === 'write').length, 'Memory-Einträge (Sitzung)'],
  ];
  $('tiles').replaceChildren(...tiles.map(([n, label, cls]) => h('div', { class: `tile ${cls || ''}` }, h('b', {}, String(n)), h('span', {}, label))));
  $('navWaiting').hidden = !waiting;
  $('navWaiting').textContent = waiting;
  $('navTasks').textContent = S.tasks.filter((t) => t.status !== 'done').length || '';
  document.title = `${waiting ? `(${waiting}) ` : ''}UltraClaude — ${S.project?.name || ''}`;
}

const CORE = { x: 500, y: 275 };
const USER = { x: 70, y: 62 };
const pos = new Map(); // name -> {x, y}

function renderGraph() {
  const g = $('graph');
  const n = S.agents.length;
  $('empty').hidden = n > 0;
  pos.clear();
  pos.set('user', USER);
  S.agents.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pos.set(a.name, { x: CORE.x + Math.cos(angle) * 350, y: CORE.y + Math.sin(angle) * 185 });
  });
  const links = S.agents.map((a) => {
    const p = pos.get(a.name);
    return svg('line', { class: `g-link ${a.state === 'working' ? 'live' : ''}`, x1: p.x, y1: p.y, x2: CORE.x, y2: CORE.y });
  });
  const core = svg('g', { class: 'g-node g-core', transform: `translate(${CORE.x},${CORE.y})` },
    svg('title', {}, 'Gemeinsame Memory öffnen'),
    svg('circle', { class: 'disc', r: 46 }), svg('text', { class: 'icon' }, '🧠'),
    svg('text', { class: 'name', y: 66 }, 'Memory'), svg('text', { class: 'sub', y: 82 }, 'Obsidian-Vault'));
  core.addEventListener('click', () => setView('memory'));
  const user = svg('g', { class: 'g-node g-user', transform: `translate(${USER.x},${USER.y})` },
    svg('circle', { class: 'disc', r: 24 }), svg('text', { class: 'icon', 'font-size': 20 }, '🙂'), svg('text', { class: 'sub', y: 40 }, 'Du'));
  const nodes = S.agents.map((a) => {
    const p = pos.get(a.name);
    const node = svg('g', { class: `g-node ${a.state}`, transform: `translate(${p.x},${p.y})` },
      svg('title', {}, `${a.name} — ${STATE_LABEL[a.state]}. Klick öffnet das Terminal.`),
      svg('circle', { class: 'halo', r: 38 }),
      svg('circle', { class: 'disc', r: 36 }),
      svg('text', { class: 'icon' }, a.icon),
      svg('text', { class: 'name', y: 56 }, cut(a.name, 22)),
      svg('text', { class: 'sub', y: 72 }, cut(a.statusText || STATE_LABEL[a.state], 38)),
      a.activity ? svg('text', { class: 'act', y: 88 }, cut(a.activity, 38)) : null);
    node.addEventListener('click', () => openAgent(a.id));
    return node;
  });
  g.replaceChildren(...links, core, user, ...nodes, svg('g', { id: 'pulses' }));
}

function pulse(from, to, color) {
  const a = from === 'core' ? CORE : pos.get(from);
  const b = to === 'core' ? CORE : pos.get(to);
  const layer = document.getElementById('pulses');
  if (!a || !b || !layer || S.view !== 'dashboard') return;
  const dot = svg('circle', { class: 'g-pulse', r: 7, fill: color });
  layer.append(dot);
  dot.animate([{ transform: `translate(${a.x}px,${a.y}px)`, opacity: 1 }, { transform: `translate(${b.x}px,${b.y}px)`, opacity: 0.4 }],
    { duration: 900, easing: 'ease-in-out' }).finished.then(() => dot.remove(), () => dot.remove());
}

function animate(e) {
  if (e.type === 'memory') return e.op === 'write' ? pulse(e.agent, 'core', '#a58cff') : pulse('core', e.agent, '#a58cff');
  if (e.type === 'notify') return pulse(e.agent, 'user', '#f5a524');
  if (e.type !== 'message') return;
  const targets = e.to === 'all' ? S.agents.map((a) => a.name).filter((name) => name !== e.agent) : [e.to];
  for (const t of targets) pulse(e.agent, t, '#d97757');
}

const ICON = { message: '💬', notify: '🔔', memory: '🧠', task: '✅', start: '▶️', stop: '⏹️', status: '📌', waiting: '✋', tool: '🔧', error: '⚠️' };

function renderFeed() {
  const feed = $('feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  const list = S.events.filter((e) => e.type !== 'tool' || $('showTools').checked).slice(-120);
  feed.replaceChildren(...(list.length ? list.map((e) => h('li', { class: `ev-${e.type}` },
    h('span', {}, ICON[e.type] || '•'),
    h('span', {}, h('span', { class: 'who' }, e.agent === 'user' ? 'Du' : e.agent), ' ',
      h('span', { class: 'txt' }, e.to ? `→ ${e.to === 'all' ? 'alle' : e.to === 'user' ? 'dich' : e.to}: ${e.text}` : e.text)),
    h('time', {}, time(e.ts)))) : [h('li', { class: 'none' }, 'Hier siehst du live, was deine Agents tun, sich schreiben und in die Memory speichern.')]));
  if (stick) feed.scrollTop = feed.scrollHeight;
}

function renderSelects() {
  const fill = (el, first) => {
    const keep = el.value;
    el.replaceChildren(h('option', { value: first[0] }, first[1]), ...S.agents.map((a) => h('option', { value: a.name }, `${a.icon} ${a.name}`)));
    if ([...el.options].some((o) => o.value === keep)) el.value = keep;
  };
  fill($('msgTo'), ['all', 'An alle']);
  fill($('taskAssignee'), ['', 'Niemand']);
}

// ---------- terminals ----------

function ensureTerm(a) {
  if (terms.has(a.id)) return terms.get(a.id);
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#0b0c0e', foreground: '#e8e8ec', cursor: '#d97757', selectionBackground: '#3a3d47' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData((d) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'in', id: a.id, d })));
  term.onResize(({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', id: a.id, cols, rows })));
  const t = { term, fit, opened: false };
  t.dot = h('i', { class: 'dot' });
  t.title = h('span', { class: 'title' });
  t.act = h('span', { class: 'act' });
  t.toggle = h('button', { class: 'ghost', onclick: guard(() => {
    const cur = agentBy(a.id);
    return api('POST', `/api/agents/${a.id}/${cur.state === 'stopped' ? 'start' : 'stop'}`, { cols: term.cols, rows: term.rows });
  }) });
  t.note = h('div', { class: 'stopped-note' }, 'Gestoppt — mit „Starten“ geht die Session weiter.');
  t.body = h('div', { class: 'pane-body' }, t.note);
  t.pane = h('div', { class: 'pane' },
    h('div', { class: 'pane-head' }, t.dot, t.title, t.act, t.toggle,
      h('button', { class: 'ghost', title: 'Agent entfernen', onclick: guard(async () => {
        if (confirm(`Agent „${agentBy(a.id)?.name}“ entfernen? Seine Session wird beendet.`)) await api('DELETE', `/api/agents/${a.id}`);
      }) }, '✕')),
    t.body);
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
  $('gridToggle').classList.toggle('active', S.grid);
  $('termsEmpty').hidden = S.agents.length > 0;
  $('terms').hidden = !S.agents.length;
  if (!agentBy(S.sel)) S.sel = S.agents[0]?.id || null;
  for (const a of S.agents) {
    const t = ensureTerm(a);
    const show = S.grid || S.sel === a.id;
    t.pane.hidden = !show;
    if (show && S.view === 'terminals') {
      if (!t.opened) { t.term.open(t.body); t.opened = true; }
      requestAnimationFrame(() => fitTerm(t));
    }
  }
}

function renderTabs() {
  $('tabs').replaceChildren(...S.agents.map((a) => h('button', {
    class: `tab ${!S.grid && S.sel === a.id ? 'active' : ''}`,
    onclick: () => { S.sel = a.id; S.grid = false; renderTabs(); terms.get(a.id)?.term.focus(); },
  }, h('i', { class: `dot ${a.state}` }), `${a.icon} ${a.name}`, a.state === 'waiting' ? h('span', { class: 'n' }, ' !') : null)));
  for (const a of S.agents) {
    const t = ensureTerm(a);
    t.dot.className = `dot ${a.state}`;
    t.title.textContent = `${a.icon} ${a.name}`;
    t.act.textContent = [STATE_LABEL[a.state], a.activity || a.statusText].filter(Boolean).join(' · ');
    t.toggle.textContent = a.state === 'stopped' ? '▶ Starten' : '■ Stoppen';
    t.note.hidden = a.state !== 'stopped';
    t.pane.classList.toggle('waiting', a.state === 'waiting');
  }
  for (const [id, t] of terms) {
    if (!agentBy(id)) { t.term.dispose(); t.pane.remove(); terms.delete(id); }
  }
  layoutTerms();
}

// ---------- tasks ----------

function renderTasks() {
  const cols = [['todo', 'Offen'], ['in_progress', 'In Arbeit'], ['done', 'Erledigt']];
  $('board').replaceChildren(...cols.map(([status, label]) => {
    const items = S.tasks.filter((t) => t.status === status);
    const col = h('div', { class: 'col' }, h('h3', {}, label, h('span', {}, String(items.length))),
      h('div', { class: 'list' }, items.map((t) => {
        const assign = h('select', { 'aria-label': 'Zuweisen an', onchange: guard((ev) => api('PATCH', `/api/tasks/${t.id}`, { assignee: ev.target.value })) },
          h('option', { value: '' }, 'Niemand'), S.agents.map((a) => h('option', { value: a.name }, `${a.icon} ${a.name}`)));
        assign.value = t.assignee || '';
        const move = h('select', { 'aria-label': 'Status', onchange: guard((ev) => api('PATCH', `/api/tasks/${t.id}`, { status: ev.target.value })) },
          cols.map(([s, l]) => h('option', { value: s }, l)));
        move.value = t.status;
        return h('div', { class: 'task', draggable: 'true', ondragstart: (ev) => ev.dataTransfer.setData('text/plain', String(t.id)) },
          h('div', { class: 't' }, `#${t.id} ${t.title}`),
          t.description ? h('div', { class: 'd' }, t.description) : null,
          h('div', { class: 'meta' }, assign, move,
            h('button', { class: 'ghost', title: 'Löschen', onclick: guard(() => api('DELETE', `/api/tasks/${t.id}`)) }, '✕')));
      })));
    col.addEventListener('dragover', (ev) => { ev.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
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

async function loadNotes() {
  try { S.notes = await api('GET', '/api/notes'); } catch { return; }
  renderNotes();
}

function renderNotes() {
  const q = $('noteFilter').value.trim().toLowerCase();
  const order = ['Memory', 'Global', 'Tasks', 'Agents', 'Log', 'Projekt', 'Vault'];
  const groups = new Map(order.map((k) => [k, []]));
  for (const n of S.notes) {
    if (q && !`${n.title} ${n.excerpt} ${n.tags.join(' ')}`.toLowerCase().includes(q)) continue;
    (groups.get(n.kind) || groups.get('Vault')).push(n);
  }
  const label = { Memory: 'Projekt-Memory', Global: 'Globale Memory', Tasks: 'Board', Agents: 'Agents', Log: 'Journal', Projekt: 'Projekt', Vault: 'Sonstiges' };
  const out = [];
  for (const [kind, notes] of groups) {
    if (!notes.length) continue;
    out.push(h('h4', {}, `${label[kind]} (${notes.length})`));
    for (const n of notes) {
      out.push(h('button', { class: `note-item ${S.note === n.path ? 'active' : ''}`, onclick: () => openNote(n.path) },
        n.title, h('small', {}, `${n.updated}${n.authors.length ? ` · ${n.authors.join(', ')}` : ''}`)));
    }
  }
  $('noteList').replaceChildren(...(out.length ? out : [h('p', { class: 'hint' }, q ? 'Keine Treffer.' : 'Noch keine Notizen. Deine Agents füllen die Memory beim Arbeiten.')]));
}

function inline(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(h('a', { onclick: () => openNote(m[1]) }, m[2] || m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function markdown(src) {
  const out = h('div', { class: 'md' });
  let list = null;
  let code = null;
  for (const line of src.split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) {
      if (code) { out.append(h('pre', {}, code.join('\n'))); code = null; } else code = [];
      list = null;
      continue;
    }
    if (code) { code.push(line); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (head) { out.append(h(`h${Math.min(3, head[1].length)}`, {}, inline(head[2]))); list = null; }
    else if (item) { if (!list) { list = h('ul'); out.append(list); } list.append(h('li', {}, inline(item[1]))); }
    else if (line.trim()) { out.append(h('p', {}, inline(line))); list = null; }
    else list = null;
  }
  if (code) out.append(h('pre', {}, code.join('\n')));
  return out;
}

const openNote = guard(async (ref) => {
  const n = await api('GET', `/api/note?path=${encodeURIComponent(ref)}`);
  S.note = n.path;
  $('noteView').replaceChildren(
    h('div', { class: 'note-meta' },
      h('button', { onclick: () => { S.note = null; showVaultInfo(); renderNotes(); } }, '← Übersicht'),
      h('span', {}, n.path), h('span', {}, `· ${n.updated}`),
      n.authors.map((a) => h('span', { class: 'chip' }, a)), n.tags.map((t) => h('span', { class: 'chip' }, `#${t}`)),
      h('button', { onclick: guard(() => api('POST', '/api/open-obsidian', { path: n.path })) }, 'In Obsidian öffnen')),
    h('h1', {}, n.title), markdown(n.body));
  renderNotes();
});

let vaultInfo;
function showVaultInfo() { $('noteView').replaceChildren(vaultInfo); }

// ---------- new agent ----------

function roleButton(r, onclick) {
  return h('button', { type: 'button', class: 'role', 'data-role': r.id, onclick },
    h('span', { class: 'ri' }, r.icon), h('span', {}, h('b', {}, r.name), h('small', {}, r.blurb)));
}

function selectRole(id) {
  const before = S.roles.find((r) => r.id === S.role);
  S.role = id;
  for (const b of $('roleGrid').children) b.classList.toggle('selected', b.dataset.role === id);
  const role = S.roles.find((r) => r.id === id);
  const name = $('fName');
  if (!name.value || name.value === before?.name) name.value = id === 'custom' ? '' : role.name;
  name.placeholder = id === 'custom' ? 'z.B. Datenbank-Experte' : role.name;
  $('fInstructions').placeholder = id === 'custom' ? 'Beschreibe, was dieser Agent tun soll.' : 'z.B. Kümmere dich nur um das Frontend.';
}

const createAgent = guard(async (body) => {
  const a = await api('POST', '/api/agents', body);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  S.sel = a.id;
});

// ---------- live updates ----------

function renderAll() {
  renderTiles(); renderGraph(); renderFeed(); renderSelects(); renderTabs(); renderTasks();
}

function onEvent(e) {
  S.events.push(e);
  if (S.events.length > 300) S.events.shift();
  renderFeed();
  renderTiles();
  animate(e);
  const jump = () => { const a = agentBy(e.agent); if (a) openAgent(a.id); };
  if (e.type === 'waiting') {
    toast(`✋ ${e.agent} braucht dich: ${e.text}`, 'warn', jump);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`${e.agent} braucht dich`, { body: e.text });
  } else if (e.type === 'notify') {
    toast(`🔔 ${e.agent}: ${e.text}`, 'warn', jump);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`Nachricht von ${e.agent}`, { body: e.text });
  } else if (e.type === 'error') toast(`${e.agent}: ${e.text}`, 'err');
}

async function loadState() {
  const st = await api('GET', '/api/state');
  Object.assign(S, st);
  $('projectPath').textContent = S.project.dir;
  $('projectPath').title = S.project.dir;
  $('vaultPath').textContent = S.project.vault;
  $('quickRoles').replaceChildren(...S.roles.filter((r) => r.id !== 'custom').map((r) => roleButton(r, () => createAgent({ roleId: r.id }))));
  $('roleGrid').replaceChildren(...S.roles.map((r) => roleButton(r, () => selectRole(r.id))));
  renderAll();
  flushReplay();
}

const pendingReplay = new Map(); // terminal output that arrived before we knew the agent
function flushReplay() {
  for (const a of S.agents) {
    const d = pendingReplay.get(a.id);
    if (d) { ensureTerm(a).term.write(d); pendingReplay.delete(a.id); }
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?t=${TOKEN}`);
  ws.onopen = guard(async () => {
    $('conn').classList.add('on');
    await loadState();
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'out') terms.get(m.id)?.term.write(m.d);
    else if (m.t === 'replay') {
      const t = terms.get(m.id) || (agentBy(m.id) && ensureTerm(agentBy(m.id)));
      if (t) { t.term.reset(); t.term.write(m.d); } else pendingReplay.set(m.id, m.d);
    } else if (m.t === 'agents') {
      S.agents = m.agents;
      flushReplay();
      renderTiles(); renderGraph(); renderSelects(); renderTabs(); renderTasks();
    } else if (m.t === 'tasks') { S.tasks = m.tasks; renderTasks(); renderTiles(); }
    else if (m.t === 'event') onEvent(m.e);
    else if (m.t === 'notes' && S.view === 'memory') loadNotes();
  };
  ws.onclose = () => { $('conn').classList.remove('on'); setTimeout(connect, 1500); };
}

// ---------- wiring ----------

$('nav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('showTools').addEventListener('change', renderFeed);
$('gridToggle').addEventListener('click', () => { S.grid = !S.grid; renderTabs(); });
$('noteFilter').addEventListener('input', renderNotes);
$('openObsidian').addEventListener('click', guard(() => api('POST', '/api/open-obsidian', {})));
$('openFolder').addEventListener('click', guard(() => api('POST', '/api/open-vault-folder', {})));
$('addAgent').addEventListener('click', () => {
  $('agentForm').reset();
  selectRole(S.agents.length ? S.role : 'bugfixer');
  $('agentDialog').showModal();
});
$('agentCancel').addEventListener('click', () => $('agentDialog').close());
$('agentForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (S.role === 'custom' && !$('fName').value.trim()) { $('fName').focus(); return toast('Gib der eigenen Rolle einen Namen.', 'warn'); }
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
window.addEventListener('resize', () => { if (S.view === 'terminals') layoutTerms(); });

vaultInfo = $('noteView').firstElementChild;
if (!TOKEN) {
  document.querySelector('main').replaceChildren(h('div', { class: 'view' }, h('div', { class: 'empty' },
    h('h2', {}, 'Starte UltraClaude aus dem Terminal'), h('p', {}, 'Wechsle in deinen Projektordner und tippe: ultraclaude'))));
} else {
  connect();
  if (['terminals', 'tasks', 'memory'].includes(location.hash.slice(1))) setView(location.hash.slice(1));
}

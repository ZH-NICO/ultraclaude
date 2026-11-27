/* global Terminal, FitAddon */
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
import { agentsIn, stateAt, density, nextEventAfter } from './replay.js';
import { layout, degrees, dotSize, panZoom } from './graph.js';
import { petSprite, petPlace, petMood } from './pet.js';
import { BrainView } from './brain.js';
import { BrainViews, bytes, day } from './brainviews.js';

const VIEWS = ['overview', 'agents', 'tasks', 'memory', 'map', 'replay', 'changes', 'missions'];
const STATE = { working: 'working', waiting: 'needs you', idle: 'idle', starting: 'starting', stopped: 'stopped' };
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = { project: null, roles: [], agents: [], tasks: [], notes: [], noteCount: 0, sessions: [], allSessions: false, picked: new Set(), hidden: new Set(), only: null, tree: [], open: new Set(), openSeeded: false, projectRel: '', folder: null, editing: false, view: 'overview', sel: null, want: null, grid: false, note: null, role: 'bugfixer' };
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
  if (res.status === 401 && !url.startsWith('/api/auth/')) { location.reload(); throw new Error('Please sign in.'); } // the session ended
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
const ago = (ts) => {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  if (min < 60 * 24 * 14) return `${Math.round(min / 1440)}d`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- navigation ----------

function setView(view) {
  S.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  syncSide();
  if (view === 'overview') { syncGraph(); $('feed').scrollTop = $('feed').scrollHeight; }
  if (view === 'agents') layoutTerms();
  if (view === 'memory') { loadNotes(); if (G.mode === 'graph') loadGraph(); }
  if (view === 'map') { brain?.rebootAnimation(); loadChats(); } else brain?.stop();
  if (view === 'replay') loadReplay();
  if (view === 'changes') loadChanges();
  if (view !== 'replay') rpPause();
}

// ---------- brain: every file and chat on this computer ----------
// A turning 3D cloud of light shaped like a brain. Every file is a point in the region of its main folder,
// every Claude Code chat a brighter neuron. Next to it, a Claude chat that finds, shows and sorts files.

let chatData = null;
let chatPick = null; // { key, id } for a chat, { region } for a region, { file } for a file
let brain = null;
let brainFiles = null; // the index from the server, once it is built
let brainIndex = { state: 'idle', files: 0 };
const ask = { items: [], busy: false };
let views = null; // table, pivot, timeline, storage and duplicates
let legendClosed = false; // the list of regions on the brain, folded away or not
try { legendClosed = localStorage.getItem('uc-legend-closed') === '1'; } catch { /* no storage */ }

function brainViews() {
  views ||= new BrainViews({
    $, h, api, toast, guard,
    query: () => $('mapFilter').value.trim(),
    setQuery: (q) => { $('mapFilter').value = q; syncBrain(); },
    showPaths: (paths, label) => { if (!brain) return; if (!paths) { brain.overview(); $('brainStatus').dataset.label = ''; } else brain.show(paths); syncBrainStatus(label); },
    pickFile: (p) => { chatPick = { file: p }; setSide('details'); renderChatDetail(); },
    askAbout,
    planned: (plan) => { onBrainChat(plan); setSide('ask'); toast('The plan is on the right. Nothing moves until you apply it.'); },
    brainShown: (shown) => { if (!brain) return; if (shown && S.view === 'map') { brain.start(); brain.draw(); } else brain.stop(); for (const id of ['brainLegend', 'brainStats', 'brainStatus']) $(id).style.visibility = shown ? '' : 'hidden'; },
  });
  return views;
}

const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const stamp = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const samePath = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const num = (n) => Number(n).toLocaleString('en-GB');
const fileBase = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const dirName = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

const loadChats = guard(async () => {
  if (!brain) {
    brain = new BrainView($('brainCanvas'), {
      calm,
      onPick: (n) => { chatPick = { key: n.pr.key, id: n.s.id }; setSide('details'); syncBrain(); },
      onPickFile: (p) => { chatPick = { file: p }; setSide('details'); renderChatDetail(); },
    });
    $('brainCanvas').view = brain; // lets the browser tests find a point on screen
    new ResizeObserver(() => { if (S.view === 'map') brain.draw(); }).observe($('mapStage'));
  }
  const [chats, files, talk] = await Promise.all([
    api('GET', '/api/chats').catch(() => null),
    api('GET', '/api/brain').catch(() => null),
    api('GET', '/api/brain/chat').catch(() => null),
  ]);
  if (!chats) {
    chatData = [];
    $('mapEmpty').hidden = false;
    setText($('mapEmpty'), 'The UltraClaude server behind this window is older than the window and cannot show the brain yet. Run “ultraclaude” in this folder to update it.');
    return;
  }
  chatData = chats.projects;
  if (files) { brainIndex = files; brainFiles = files.files ? files : null; }
  if (talk) { ask.items = talk.items; ask.busy = talk.busy; renderAsk(); }
  brain.setData(chatData, brainFiles);
  if (!chatPick) {
    const newest = chatData.flatMap((pr) => pr.sessions.map((s) => ({ pr, s }))).sort((a, b) => b.s.updated - a.s.updated)[0];
    if (newest) chatPick = { key: newest.pr.key, id: newest.s.id };
  }
  syncBrain();
  brainViews().home = brainIndex.home;
  await views.loadSaved();
  if (S.view === 'map' && views.view === 'brain') brain.start(); else views.refresh();
});

/** The index changed (built, rebuilt or files moved): draw it anew. */
const reloadFiles = guard(async () => {
  const files = await api('GET', '/api/brain');
  brainIndex = files;
  brainFiles = files.files ? files : null;
  if (brain && chatData) { brain.setData(chatData, brainFiles); syncBrain(); if (views && (views.view !== 'brain' || views.filtering)) views.refresh(); }
});

function syncBrain() {
  if (!chatData || !brain?.model) return;
  const all = chatData.flatMap((pr) => pr.sessions);
  const files = brainFiles ? brainIndex.total : 0;
  setText($('mapSummary'), files ? `${num(files)} files · ${all.length} ${all.length === 1 ? 'chat' : 'chats'} · ${plural(brain.model.regions.length, 'region')}` : `${all.length} ${all.length === 1 ? 'chat' : 'chats'} · ${plural(brain.model.regions.length, 'region')}`);
  $('mapEmpty').hidden = all.length > 0 || !!files || brainIndex.state === 'indexing';
  if (!$('mapEmpty').hidden) setText($('mapEmpty'), 'Nothing in here yet.');
  const q = $('mapFilter').value.trim().toLowerCase();
  brain.match = q ? (n) => `${n.s.title} ${n.s.firstPrompt} ${n.pr.name}`.toLowerCase().includes(q) : null;
  brain.focus = chatPick?.region || null;
  if (chatPick?.id) brain.selected = `${chatPick.key}/${chatPick.id}`;
  else if (!chatPick?.file) brain.selected = null;
  const hits = q ? brain.model.neurons.filter(brain.match).length : 0;
  const open = !legendClosed;
  const fold = h('button', { type: 'button', class: 'fold', 'aria-expanded': String(open), title: open ? 'Hide the list' : 'Show the list', onclick: () => {
    legendClosed = open;
    try { localStorage.setItem('uc-legend-closed', open ? '1' : ''); } catch { /* only remembered for now */ }
    syncBrain();
    $('brainLegend').querySelector('.fold')?.focus();
  } }, h('i', { 'aria-hidden': 'true' }, open ? '▾' : '▸'), 'Regions', h('b', {}, String(brain.model.regions.length)));
  $('brainLegend').replaceChildren(fold, ...(open ? brain.model.regions : []).map((r) => h('button', {
    type: 'button', class: `region${brain.focus === r.key ? ' on' : ''}${brain.focus && brain.focus !== r.key ? ' off' : ''}`, style: `--rc:${r.color}`, title: r.path || r.name,
    onclick: () => { chatPick = chatPick?.region === r.key ? null : { region: r.key }; if (chatPick) setSide('details'); syncBrain(); },
  }, h('i'), h('span', {}, r.name), h('b', {}, num(r.count)))));
  $('brainStats').replaceChildren(...[
    files ? h('p', {}, h('b', {}, num(files)), ' files') : null,
    h('p', {}, h('b', {}, q ? String(hits) : String(all.length)), q ? ` of ${all.length} chats match` : ` ${all.length === 1 ? 'chat' : 'chats'}`),
    h('p', {}, h('b', {}, String(brain.model.regions.length)), ` ${brain.model.regions.length === 1 ? 'region' : 'regions'}`),
  ].filter(Boolean));
  syncBrainStatus();
  if (views) {
    views.regions = Object.fromEntries(brain.model.regions.filter((r) => r.path).map((r) => [r.name, r.path]));
    $('brainFolders').replaceChildren(...brain.model.regions.filter((r) => r.path).map((r) => h('option', { value: r.path })));
  }
  if (!brain.running) brain.draw();
  renderChatDetail();
}

/** The line at the top: the index being built, or what the chat lit up. */
function syncBrainStatus(label) {
  const el = $('brainStatus');
  if (brainIndex.state === 'indexing') {
    el.replaceChildren(h('i', { class: 'spin' }), `Reading the names of your files… ${num(brainIndex.total ?? brainIndex.files)} so far`);
  } else if (brain?.lit) {
    el.replaceChildren(`Showing ${num(brain.lit.size)} ${brain.lit.size === 1 ? 'file' : 'files'}${label || el.dataset.label ? ` · ${label || el.dataset.label}` : ''} `, h('button', { type: 'button', class: 'link', onclick: () => { brain.overview(); el.dataset.label = ''; syncBrainStatus(); } }, 'Show everything'));
    if (label) el.dataset.label = label;
  } else if (brainFiles) {
    el.replaceChildren(`${num(brainIndex.total)} files${brainIndex.truncated ? ' (the first ones; there are more)' : ''}${brainFiles.shown < brainIndex.total ? `, ${num(brainFiles.shown)} drawn` : ''} · `, h('button', { type: 'button', class: 'link', onclick: guard(async () => { await api('POST', '/api/brain/rescan', {}); }) }, 'Read again'));
  } else {
    el.replaceChildren();
  }
}

function setSide(which) {
  for (const b of $('sideTabs').children) b.classList.toggle('on', b.dataset.side === which);
  $('brainAsk').hidden = which !== 'ask';
  $('mapDetail').hidden = which !== 'details';
  if (which === 'ask') { const log = $('askLog'); log.scrollTop = log.scrollHeight; }
}

function askAbout(text) {
  setSide('ask');
  $('askInput').value = text;
  $('askInput').focus();
}

function renderChatDetail() {
  if (chatPick?.file) return renderFileDetail(chatPick.file);
  if (chatPick?.region) return renderRegionDetail(brain?.model?.regions.find((r) => r.key === chatPick.region));
  const pr = chatData?.find((p) => p.key === chatPick?.key);
  const s = pr?.sessions.find((x) => x.id === chatPick.id);
  if (!s) return $('mapDetail').replaceChildren(h('p', { class: 'none' }, 'Turn the brain and pick a point to see that file or chat, or a region on the left.'));
  const color = brain?.model?.neurons.find((n) => n.s.id === s.id)?.reg.color;
  const agent = S.agents.find((a) => a.sessionId === s.id);
  let action = null;
  if (pr.current && agent) action = h('button', { type: 'button', class: 'btn primary', onclick: () => openAgent(agent.id) }, 'Open its terminal');
  else if (pr.current) action = h('button', { type: 'button', class: 'btn primary', onclick: () => createAgent({ sessionId: s.id }) }, 'Continue here');
  else if (pr.dir) action = openFolderButton(pr.dir, pr.name);
  $('mapDetail').replaceChildren(...[
    h('p', { class: 'kicker', style: `--rc:${color}` }, h('i'), `Chat · ${pr.name}`),
    h('h2', {}, s.title),
    h('dl', {}, h('dt', {}, 'Folder'), h('dd', { class: 'mono' }, pr.dir || pr.name), h('dt', {}, 'Last active'), h('dd', {}, `${stamp(s.updated)} · ${ago(s.updated)}`), h('dt', {}, 'Length'), h('dd', {}, kb(s.size))),
    s.firstPrompt && s.firstPrompt !== s.title ? h('div', {}, h('h3', {}, 'Began with'), h('p', { class: 'quote' }, s.firstPrompt)) : null,
    action,
    pr.current ? null : h('p', { class: 'none' }, 'Chats from other folders continue in that folder’s own UltraClaude window.'),
  ].filter(Boolean));
}

function renderFileDetail(p) {
  const reg = brain?.model?.regions.find((r) => r.path && (samePath(dirName(p), r.path) || p.toLowerCase().startsWith(`${r.path.toLowerCase()}${p.includes('\\') ? '\\' : '/'}`)));
  const meta = h('dl', { class: 'file-meta' });
  const look = h('div', { class: 'file-look' });
  showPreview(p, meta, look);
  $('mapDetail').replaceChildren(
    h('p', { class: 'kicker', style: `--rc:${reg?.color || '#fff'}` }, h('i'), `File${reg ? ` · ${reg.name}` : ''}`),
    h('h2', {}, fileBase(p)),
    h('dl', {}, h('dt', {}, 'Folder'), h('dd', { class: 'mono' }, dirName(p))),
    meta,
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn primary', onclick: guard(() => api('POST', '/api/brain/open', { path: p })) }, 'Show in folder'),
      h('button', { type: 'button', class: 'btn', onclick: () => askAbout(`What is "${p}" and where does it belong?`) }, 'Ask about it')),
    look);
}

async function showPreview(p, meta, look) {
  try {
    const v = await api('POST', '/api/brain/preview', { path: p });
    meta.replaceChildren(h('dt', {}, 'Size'), h('dd', {}, bytes(v.size)), h('dt', {}, 'Modified'), h('dd', {}, day(v.mtime)));
    if (v.kind === 'image') look.replaceChildren(h('img', { src: v.data, alt: fileBase(p) }));
    else if (v.kind === 'text') look.replaceChildren(h('pre', {}, v.text, v.cut ? '\n…' : ''));
  } catch { /* guests and files that are gone have no preview */ }
}

function openFolderButton(dir, name) {
  return h('button', { type: 'button', class: 'btn primary', onclick: guard(async () => {
    await api('POST', '/api/open-project', { dir });
    toast(`Opening ${name} in a new UltraClaude window`);
  }) }, 'Open folder in UltraClaude');
}

function renderRegionDetail(r) {
  if (!r) return $('mapDetail').replaceChildren(h('p', { class: 'none' }, 'Turn the brain and pick a point to see that file or chat, or a region on the left.'));
  $('mapDetail').replaceChildren(...[
    h('p', { class: 'kicker', style: `--rc:${r.color}` }, h('i'), 'Region'),
    h('h2', {}, r.name),
    h('dl', {}, r.path ? h('dt', {}, 'Folder') : null, r.path ? h('dd', { class: 'mono' }, r.path) : null, h('dt', {}, brainFiles ? 'Files' : 'Chats'), h('dd', {}, num(r.count)), h('dt', {}, 'Chats'), h('dd', {}, String(r.neurons.length))),
    r.neurons.length ? h('div', {}, h('h3', {}, 'Chats in this region'), h('ul', { class: 'map-list' }, r.neurons.map((n) => h('li', {}, h('a', { onclick: () => { chatPick = { key: n.pr.key, id: n.s.id }; syncBrain(); } }, n.s.title))))) : null,
    h('div', { class: 'row-btns' },
      brainFiles && r.path ? h('button', { type: 'button', class: 'btn primary', onclick: guard(() => api('POST', '/api/brain/open', { path: r.path })) }, 'Show in folder') : null,
      brainFiles && r.path ? h('button', { type: 'button', class: 'btn', onclick: () => askAbout(`Look at ${r.path} and suggest how to sort it.`) }, 'Ask how to sort it') : null),
  ].filter(Boolean));
}

// ---------- the brain chat ----------

const SUGGESTIONS = ['Where are my tax documents?', 'What takes the most space on my computer?', 'Make a table of file types by year', 'Open the timeline for this year', 'Sort my Downloads folder by type', 'Find duplicate files'];

/** Plain text with `code` and line breaks, safely as DOM nodes. */
function richText(text) {
  return String(text).split(/\n{2,}/).map((para) => h('p', {}, ...para.split('\n').flatMap((line, i) => [i ? h('br') : null, ...line.split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? h('code', {}, part.slice(1, -1)) : part))]).filter((x) => x !== null)));
}

function planCard(it) {
  const shown = it.moves.slice(0, 12);
  const act = (what) => guard(async () => { await api('POST', `/api/brain/plans/${it.id}/${what}`, {}); if (what !== 'discard') reloadFiles(); });
  return h('div', { class: `plan ${it.state}` },
    h('p', { class: 'plan-head' }, h('b', {}, `${it.moves.length} ${it.moves.length === 1 ? 'move' : 'moves'}`), ` · ${{ pending: 'waiting for you', applied: 'done', discarded: 'discarded', undone: 'undone' }[it.state]}`),
    it.reason ? h('p', { class: 'plan-why' }, it.reason) : null,
    h('ul', {}, ...shown.map((m) => h('li', { title: `${m.from}\n→ ${m.to}` }, h('span', {}, fileBase(m.from)), h('i', {}, '→'), h('span', {}, dirName(m.to).split(/[\\/]/).slice(-2).join('/'))))),
    it.moves.length > shown.length ? h('p', { class: 'fine' }, `and ${it.moves.length - shown.length} more`) : null,
    it.failed?.length ? h('p', { class: 'form-error' }, `${it.failed.length} could not be moved: ${it.failed.slice(0, 2).map((f) => f.error).join('; ')}`) : null,
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => { brain?.show(it.moves.map((m) => (it.state === 'applied' ? m.to : m.from))); syncBrainStatus('the plan'); } }, 'Show'),
      it.state === 'pending' ? h('button', { type: 'button', class: 'btn primary', onclick: act('apply') }, `Apply ${it.moves.length} ${it.moves.length === 1 ? 'move' : 'moves'}`) : null,
      it.state === 'pending' ? h('button', { type: 'button', class: 'btn', onclick: act('discard') }, 'Discard') : null,
      it.state === 'applied' ? h('button', { type: 'button', class: 'btn', onclick: act('undo') }, 'Undo') : null));
}

function askItem(it) {
  if (it.kind === 'user') return h('div', { class: 'msg user' }, ...richText(it.text));
  if (it.kind === 'text') return h('div', { class: 'msg bot' }, ...richText(it.text));
  if (it.kind === 'action') return h('button', { type: 'button', class: 'chip', title: it.view ? 'Open this view' : 'Show these in the brain', onclick: () => { if (it.view) return brainViews().open(it.view.view, it.view); brainViews().open('brain', { filter: {} }); if (brain?.show(it.paths)) syncBrainStatus(it.text); } }, h('i'), it.text);
  if (it.kind === 'tool') return h('p', { class: 'tool' }, it.text);
  if (it.kind === 'error') return h('p', { class: 'msg error' }, it.text);
  if (it.kind === 'plan') return planCard(it);
  return null;
}

function renderAsk() {
  const log = $('askLog');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const kids = ask.items.map(askItem).filter(Boolean);
  if (!kids.length) {
    kids.push(h('div', { class: 'ask-hello' },
      h('h3', {}, 'Ask your brain'),
      h('p', {}, 'Claude knows the names of all your files. Ask where something is, what a folder holds, or let it sort a folder: you see every move and decide.'),
      h('div', { class: 'sugs' }, ...SUGGESTIONS.map((s) => h('button', { type: 'button', class: 'chip', onclick: () => sendAsk(s) }, s)))));
  }
  if (ask.busy) kids.push(h('p', { class: 'thinking' }, h('i'), h('i'), h('i'), ' thinking'));
  log.replaceChildren(...kids);
  if (stick || ask.busy) log.scrollTop = log.scrollHeight;
  $('askSend').disabled = ask.busy;
}

const sendAsk = guard(async (text) => {
  const body = String(text ?? $('askInput').value).trim();
  if (!body) return;
  setSide('ask');
  await api('POST', '/api/brain/chat', { text: body });
  $('askInput').value = '';
});

function onBrainChat(item) {
  const i = ask.items.findIndex((x) => x.id === item.id);
  if (i >= 0) ask.items[i] = item; else ask.items.push(item);
  renderAsk();
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
  $('mapBtn').classList.toggle('active', S.view === 'map');
  setText($('navTasks'), String(S.tasks.filter((t) => t.status !== 'done').length || ''));
  setText($('navNotes'), String(S.noteCount || ''));
  for (const [id, r] of rows) if (!agentBy(id)) { r.wrap.remove(); rows.delete(id); }
  for (const a of S.agents) {
    let r = rows.get(a.id);
    if (!r) {
      r = { dot: h('i'), nm: h('span', { class: 'nm' }), st: h('span', { class: 'st' }), act: h('span', { class: 'act' }) };
      r.el = h('button', { type: 'button', onclick: () => openAgent(a.id) }, r.dot, r.nm, r.st, r.act);
      r.pick = h('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${a.name}`, onchange: (ev) => togglePick(a.id, ev.target.checked) });
      r.wrap = h('div', { class: 'arow' }, r.pick, r.el);
      rows.set(a.id, r);
      $('roster').append(r.wrap);
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
  syncSelBar();
}

// ---------- choosing agents ----------

/** Whether an agent's terminal is part of the "All terminals" view right now. */
const inGrid = (a) => (S.only ? S.only.has(a.id) : !S.hidden.has(a.id));
const pickedAgents = () => S.agents.filter((a) => S.picked.has(a.id));

function syncSelBar() {
  const n = S.picked.size;
  $('selBar').hidden = n === 0;
  $('roster').classList.toggle('picking', n > 0);
  setText($('selCount'), `${n} selected`);
  for (const [id, r] of rows) {
    const on = S.picked.has(id);
    if (r.pick.checked !== on) r.pick.checked = on;
    r.wrap.classList.toggle('picked', on);
  }
}

function togglePick(id, on) {
  if (on) S.picked.add(id); else S.picked.delete(id);
  syncSelBar();
}

function openTogether() {
  const list = pickedAgents();
  if (list.length === 1) return openAgent(list[0].id);
  S.only = new Set(list.map((a) => a.id));
  S.grid = true;
  setView('agents');
}

const stopPicked = guard(async () => {
  await Promise.all(pickedAgents().filter((a) => a.state !== 'stopped').map((a) => api('POST', `/api/agents/${a.id}/stop`, {})));
});

const removePicked = guard(async () => {
  const list = pickedAgents();
  if (!list.length) return;
  const what = list.length === 1 ? `agent “${list[0].name}”` : `${list.length} agents`;
  if (!confirm(`Remove ${what}? Their sessions will be ended.`)) return;
  S.picked.clear();
  await Promise.all(list.map((a) => api('DELETE', `/api/agents/${a.id}`)));
});

/** The "−" button in All terminals: takes one terminal out of that view without stopping the agent. */
function hideFromGrid(id) {
  if (S.only) S.only.delete(id); else S.hidden.add(id);
  layoutTerms();
}

function syncGridBar() {
  const shown = S.agents.filter(inGrid).length;
  const partial = S.view === 'agents' && S.grid && shown < S.agents.length;
  $('gridBar').hidden = !partial;
  if (partial) setText($('gridBarText'), shown ? `Showing ${shown} of ${S.agents.length} terminals` : 'All terminals are hidden');
}

/** Earlier Claude Code sessions of this folder; a click continues one as an agent. */
function renderSessions() {
  const shown = S.allSessions ? S.sessions : S.sessions.slice(0, 5);
  $('sessionsBox').hidden = !S.sessions.length;
  $('startSessions').hidden = !S.sessions.length;
  $('sessions').replaceChildren(...shown.map((s) => h('button', {
    type: 'button', class: 'session', title: `${s.firstPrompt || s.title}\n\nClick to continue this session here.`, onclick: () => createAgent({ sessionId: s.id }),
  }, h('span', { class: 'nm' }, s.title), h('span', { class: 'when' }, ago(s.updated)))));
  $('sessionsMore').hidden = S.sessions.length <= 5;
  setText($('sessionsMore'), S.allSessions ? 'Show fewer' : `Show all ${S.sessions.length}`);
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
  syncSubs();
  setText(hubCount, plural(S.noteCount, 'note'));
}

function buildGraph(w, ht) {
  const compact = w < 640;
  const n = S.agents.length;
  hub = { x: Math.round(w / 2), y: Math.round(ht / 2) };
  const rx = Math.max(70, Math.min(w / 2 - (compact ? 120 : 225), 330));
  const ry = Math.max(70, Math.min(ht / 2 - 90, 200, rx * 1.2)); // never much taller than wide
  pos.clear();
  gnodes.clear();
  subNodes.clear();
  subsQuiet = true;
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
    nd.pet = petSprite();
    petPlace(nd.pet, side);
    nd.g = svg('g', { transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button' }, nd.title, svg('circle', { class: 'hit', r: 34 }), nd.pet, nd.nm, nd.what, nd.now);
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
  g.replaceChildren(...links, svg('g', { id: 'subs' }), svg('g', { id: 'pulses' }), hubG, ...nodes);
}

function updateNode(a) {
  const nd = gnodes.get(a.id);
  if (!nd) return;
  // a turn that just ended gets a short celebration
  if (nd.prev === 'working' && a.state === 'idle' && !calm) { nd.happyUntil = Date.now() + 1600; setTimeout(() => { const cur = agentBy(a.id); if (cur) updateNode(cur); }, 1650); }
  nd.prev = a.state;
  const happy = nd.happyUntil > Date.now() ? ' happy' : '';
  setAttr(nd.g, 'class', `g-node ${a.state} mood-${petMood(a)}${happy}`);
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
    if (nd.side === 'right' || nd.side === 'left') { x = nd.side === 'right' ? 38 : -38; y = (i - (lines.length - 1) / 2) * lineHeight + 4; }
    else if (nd.side === 'bottom') y = 42 + i * lineHeight;
    else y = -30 - (lines.length - 1 - i) * lineHeight;
    setText(el, text);
    setAttr(el, 'x', x);
    setAttr(el, 'y', y);
  });
  setText(nd.title, [a.name, a.roleName !== a.name ? a.roleName : '', STATE[a.state], a.activity].filter(Boolean).join(' · '));
}

function fly(from, to, trace, layer = $('pulses')) {
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

function ping(at, cls = '', layer = $('pulses')) {
  if (!layer) return;
  const ring = svg('circle', { class: `g-ping ${cls}`, r: 6 });
  layer.append(ring);
  const move = `translate(${at.x}px,${at.y}px)`;
  ring.animate([{ transform: `${move} scale(1)`, opacity: 1 }, { transform: `${move} scale(3.4)`, opacity: 0 }],
    { duration: 900, easing: 'ease-out' }).finished.then(() => ring.remove(), () => ring.remove());
}

// ---------- subagents in the overview ----------
// A subagent hangs off the agent that started it (not off the memory): it grows out of the agent,
// shows data flowing while it works, sends its result back and folds away when it is done.

const subNodes = new Map(); // `${agentId}:${subId}` -> parts of its drawing
let subsQuiet = false; // right after the graph is rebuilt, existing subagents appear without the opening animation
const MAX_SUBS = 6;

/**
 * The spot for slot i beside an agent, alternating on both sides of it, so subagents cross neither its
 * label nor its link to the memory. An agent above or below the memory has its label centred over or
 * under it: there they go wide of the label and stack inwards.
 */
function subSpot(p, i, side) {
  const dx = p.x - hub.x; const dy = p.y - hub.y;
  const len = Math.hypot(dx, dy) || 1;
  const ox = dx / len; const oy = dy / len; // away from the memory
  const px = -oy; const py = ox; // across
  const centred = side === 'top' || side === 'bottom';
  const s = i % 2 ? -1 : 1;
  const m = Math.floor(i / 2);
  const d = centred ? 128 : 58 + m * 30;
  const along = centred ? -(16 + m * 30) : 12;
  const across = px * s;
  return {
    x: Math.round(p.x + px * s * d + ox * along), y: Math.round(p.y + py * s * d + oy * along),
    labelSide: Math.abs(across) > 0.5 ? (across > 0 ? 'right' : 'left') : side === 'left' ? 'left' : 'right',
  };
}

function syncSubs() {
  const layer = $('subs');
  if (!layer) return;
  const want = new Map();
  for (const a of S.agents) {
    const p = pos.get(a.id);
    const nd = gnodes.get(a.id);
    if (!p || !nd) continue;
    // every subagent keeps its slot while it lives, so the others do not jump when one closes; new ones take the first free slot
    const list = (a.subs || []).slice(0, MAX_SUBS);
    const taken = new Set(list.map((s) => subNodes.get(`${a.id}:${s.id}`)?.slot).filter((x) => x !== undefined));
    for (const s of list) {
      const key = `${a.id}:${s.id}`;
      let slot = subNodes.get(key)?.slot;
      if (slot === undefined) { slot = 0; while (taken.has(slot)) slot++; taken.add(slot); }
      want.set(key, { a, s, slot, from: p, at: subSpot(p, slot, nd.side) });
    }
  }
  for (const [key, n] of subNodes) if (!want.has(key)) { subNodes.delete(key); closeSub(n); }
  for (const [key, w] of want) {
    let n = subNodes.get(key);
    if (!n) { n = openSub(w, layer, !subsQuiet); n.slot = w.slot; subNodes.set(key, n); }
    else if (n.at.x !== w.at.x || n.at.y !== w.at.y || n.at.labelSide !== w.at.labelSide) placeSub(n, w.at);
    setText(n.what, cut(w.s.activity || 'starting', 28));
    setText(n.title, `${w.s.label} · ${w.s.type} subagent of ${w.a.name}${w.s.activity ? `\n${w.s.activity}` : ''}\nrunning for ${left(Date.now() - w.s.startedAt)}`);
  }
  subsQuiet = false;
}
function placeSub(n, at) {
  n.at = at;
  setAttr(n.g, 'transform', `translate(${at.x},${at.y})`);
  setAttr(n.line, 'x2', at.x);
  setAttr(n.line, 'y2', at.y);
  const right = at.labelSide === 'right';
  for (const el of [n.nm, n.what]) { setAttr(el, 'x', right ? 16 : -16); setAttr(el, 'text-anchor', right ? 'start' : 'end'); }
}

function openSub({ a, s, from, at }, layer, animated) {
  const line = svg('line', { class: 'g-sublink', x1: from.x, y1: from.y, x2: at.x, y2: at.y });
  const n = { line, from, at, title: svg('title'), nm: svg('text', { class: 'snm', y: -1 }, cut(s.label, 26)), what: svg('text', { class: 'swhat', y: 12 }) };
  n.inner = svg('g', { class: 'g-sub-in' }, svg('circle', { class: 'hit', r: 14 }), petSprite({ mini: true }), n.nm, n.what);
  n.g = svg('g', { class: 'g-sub', tabindex: 0, role: 'button' }, n.title, n.inner);
  n.g.addEventListener('click', () => openAgent(a.id));
  n.g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAgent(a.id); } });
  layer.append(line, n.g);
  placeSub(n, at);
  if (animated && !calm && !document.hidden && S.view === 'overview') {
    // the link grows out of the agent, a spark runs along it, then the subagent pops up
    line.setAttribute('pathLength', '1');
    line.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 380, easing: 'ease-out' })
      .finished.then(() => line.removeAttribute('pathLength'), () => line.removeAttribute('pathLength'));
    ping(from, 'sub');
    fly(from, at);
    n.inner.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.5)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 520, delay: 320, easing: 'ease-out', fill: 'backwards' });
  }
  return n;
}

function closeSub(n) {
  const gone = () => { n.g.remove(); n.line.remove(); };
  if (calm || document.hidden || S.view !== 'overview' || !n.g.isConnected) return gone();
  // the result travels back to the agent, the subagent folds away and the link retracts into the agent
  n.g.classList.add('closing');
  fly(n.at, n.from);
  n.inner.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.25 }, { transform: 'scale(0)', opacity: 0 }], { duration: 420, easing: 'ease-in', fill: 'forwards' });
  n.line.setAttribute('pathLength', '1');
  n.line.animate([{ strokeDasharray: '1 1', strokeDashoffset: 0 }, { strokeDasharray: '1 1', strokeDashoffset: 1 }], { duration: 420, delay: 260, easing: 'ease-in', fill: 'forwards' });
  setTimeout(() => ping(n.from, 'done'), 650);
  setTimeout(gone, 760);
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
    fontFamily: '"Cascadia Mono", Consolas, "IBM Plex Mono", monospace', fontSize: S.user?.prefs.termFont || 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#4d4d4d' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData((d) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'in', id: a.id, d })));
  term.attachCustomKeyEventHandler((ev) => terminalKeys(ev, term, a.id));
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
  t.host = h('div', { class: 'term-host' });
  t.body = h('div', { class: 'pane-body' }, t.host, t.off);
  t.hide = h('button', { type: 'button', class: 'link hide', title: 'Hide from All terminals', 'aria-label': 'Hide from All terminals', onclick: () => hideFromGrid(a.id) }, '−');
  t.pane = h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, t.dot, t.nm, t.meta, t.toggle, t.hide, remove), t.body);
  t.body.addEventListener('paste', (ev) => pasteImage(ev, a.id), true); // Ctrl+V with an image on the clipboard
  new ResizeObserver(() => fitTerm(t)).observe(t.host);
  $('terms').append(t.pane);
  terms.set(a.id, t);
  return t;
}

/**
 * Keys that should behave like in Windows Terminal rather than how xterm.js handles them by default.
 * Returning false hands the key back to the browser (so paste and copy happen natively); returning
 * true lets the terminal send it to Claude Code as usual.
 */
function terminalKeys(ev, term, id) {
  if (ev.type !== 'keydown') return true;
  const key = ev.key.toLowerCase();
  const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
  // Ctrl+V / Ctrl+Shift+V: paste. xterm.js would send ^V and swallow the paste, so neither text nor
  // images arrived. Text now goes in as a normal paste, images through pasteImage().
  if (ctrl && key === 'v') return false;
  // Ctrl+C copies when something is selected, otherwise it interrupts Claude as usual. Ctrl+Shift+C always copies.
  if (ctrl && key === 'c' && (ev.shiftKey || term.hasSelection())) {
    setTimeout(() => term.clearSelection(), 0);
    return false;
  }
  // Shift+Enter / Ctrl+Enter: a new line in the prompt instead of sending it (Claude Code reads ESC CR as that)
  if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'in', id, d: '\x1b\r' }));
    return false;
  }
  return true;
}

/**
 * Ctrl+V with an image (a screenshot, a copied picture) hands it to the agent right away. The image is
 * saved by the server and its path typed into the prompt, which Claude Code shows as "[Image #1]".
 * Text, even next to an image, is pasted as usual.
 */
function pasteImage(ev, id) {
  const data = ev.clipboardData;
  const item = data && [...data.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item || data.types.includes('text/plain')) return;
  const file = item.getAsFile();
  if (!file) return;
  ev.preventDefault();
  ev.stopPropagation();
  fetch(`/api/agents/${id}/paste-image`, { method: 'POST', headers: { 'x-uc-token': TOKEN, 'content-type': file.type }, body: file })
    .then(async (res) => { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText); })
    .catch((err) => toast(`Could not paste the image: ${err.message}`, 'error'));
}

// Fits are bundled and only run once the box has settled, so a terminal keeps its size
// instead of being resized again and again while the layout is still moving.
function fitTerm(t) {
  clearTimeout(t.fitTimer);
  t.fitTimer = setTimeout(() => {
    if (!t.opened || !t.host.clientWidth || !t.host.clientHeight) return;
    try { t.fit.fit(); } catch { /* not measurable yet */ }
  }, 120);
}

function layoutTerms() {
  $('terms').classList.toggle('grid', S.grid);
  syncGridBar();
  for (const a of S.agents) {
    const t = ensureTerm(a);
    const show = S.grid ? inGrid(a) : S.sel === a.id;
    t.pane.hidden = !show;
    t.hide.hidden = !S.grid;
    if (show && S.view === 'agents') {
      if (!t.opened) { t.term.open(t.host); t.opened = true; }
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
      }) : h('p', { class: 'none' }, { todo: 'Nothing open. Add a task above, or let your agents create them.', in_progress: 'Nothing in progress. Drag a task here when someone works on it.', done: 'Nothing done yet.' }[status])));
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

// The vault's real folder structure on the left; on the right a note to read and edit, a folder,
// or the editor for a new note.
let vaultInfo;
const nodeAt = (nodes, p) => { for (const n of nodes) { if (n.path === p) return n; const hit = n.children && nodeAt(n.children, p); if (hit) return hit; } return null; };
const filesIn = (nodes) => nodes.flatMap((n) => (n.type === 'dir' ? filesIn(n.children) : [n]));
const foldersIn = (nodes) => nodes.flatMap((n) => (n.type === 'dir' ? [n, ...foldersIn(n.children)] : []));
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const baseName = (p) => p.split('/').pop().replace(/\.md$/i, '');

async function loadNotes() {
  try {
    const [t, notes] = await Promise.all([api('GET', '/api/tree'), api('GET', '/api/notes')]);
    Object.assign(S, { tree: t.tree, projectRel: t.project, notes });
  } catch { return; }
  if (!S.openSeeded) {
    S.openSeeded = true;
    for (const p of ['Projects', S.projectRel, `${S.projectRel}/Memory`, 'Global']) S.open.add(p);
  }
  S.noteCount = S.notes.filter((n) => ['Memory', 'Global', 'Claude Code'].includes(n.kind)).length;
  renderNotes();
  syncSide();
  // what is shown on the right may have been moved or deleted meanwhile, by you or an agent
  if (!S.editing && ((S.note && !nodeAt(S.tree, S.note)) || (S.folder && !nodeAt(S.tree, S.folder)))) showVaultInfo();
}

function renderNotes() {
  const q = $('noteFilter').value.trim().toLowerCase();
  if (q) {
    const text = new Map(S.notes.map((n) => [n.path, `${n.excerpt} ${n.tags.join(' ')}`.toLowerCase()]));
    const hits = filesIn(S.tree).filter((f) => f.path.toLowerCase().includes(q) || text.get(f.path)?.includes(q));
    $('noteList').replaceChildren(...(hits.length ? hits.map((f) => fileRow(f, 0, true)) : [h('p', { class: 'none' }, 'No matches.')]));
    return;
  }
  const rows = treeRows(S.tree, 0);
  $('noteList').replaceChildren(...(rows.length ? rows : [h('p', { class: 'none' }, 'The vault is empty.')]));
}

const indent = (depth) => `padding-left:${8 + depth * 14}px`;
const treeRows = (nodes, depth) => nodes.flatMap((n) => (n.type === 'dir'
  ? [dirRow(n, depth), ...(S.open.has(n.path) ? treeRows(n.children, depth + 1) : [])]
  : [fileRow(n, depth)]));

function dirRow(n, depth) {
  const open = S.open.has(n.path);
  const count = filesIn(n.children).length;
  return h('button', {
    type: 'button', class: `tnode dir${S.folder === n.path ? ' active' : ''}`, style: indent(depth), title: n.path, 'aria-expanded': String(open),
    onclick: () => { if (open && S.folder === n.path) S.open.delete(n.path); else S.open.add(n.path); showFolder(n.path); },
  }, h('span', { class: 'caret' }, open ? '▾' : '▸'), h('span', { class: 'nm' }, n.name), h('span', { class: 'cnt' }, count ? String(count) : ''));
}

function fileRow(n, depth, withFolder = false) {
  return h('button', { type: 'button', class: `tnode note${S.note === n.path ? ' active' : ''}`, style: indent(depth), title: n.path, onclick: () => openNote(n.path) },
    h('span', { class: 'caret' }), h('span', { class: 'fn' }, h('b', {}, n.name), withFolder ? h('span', { class: 'sub' }, parentOf(n.path) || 'Vault') : null));
}

function showVaultInfo() {
  Object.assign(S, { note: null, folder: null, editing: false });
  $('noteView').replaceChildren(vaultInfo);
  renderNotes();
}

async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast(`Could not copy the ${what.toLowerCase()}`, 'error'); }
}
const fullPath = (rel) => {
  const root = S.project.vault;
  const sep = root.includes('\\') ? '\\' : '/';
  return rel ? `${root}${sep}${rel.split('/').join(sep)}` : root;
};

/** Lets the person type a new path for a note or folder: rename and move in one. */
function renameForm(item, isFile) {
  const input = h('input', { value: isFile ? item.replace(/\.md$/i, '') : item, 'aria-label': 'New name and folder', spellcheck: 'false' });
  const save = guard(async () => {
    const r = await api('POST', '/api/file/move', { from: item, to: input.value.trim() });
    await loadNotes();
    if (isFile) openNote(r.path); else { S.open.add(r.path); showFolder(r.path); }
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') form.replaceWith(form.backup); });
  const form = h('div', { class: 'inline-form' }, input, h('button', { type: 'button', class: 'btn', onclick: save }, 'Save'),
    h('button', { type: 'button', class: 'link', onclick: () => form.replaceWith(form.backup) }, 'Cancel'));
  return form;
}

function showFolder(p) {
  const n = nodeAt(S.tree, p);
  if (!n) return showVaultInfo();
  Object.assign(S, { folder: p, note: null, editing: false });
  const files = n.children.filter((c) => c.type === 'file');
  const actions = h('div', { class: 'note-actions' },
    n.readOnly ? null : h('button', { type: 'button', class: 'link', onclick: () => newNote(p) }, 'New note here'),
    n.readOnly ? null : h('button', { type: 'button', class: 'link', onclick: () => newFolder(p) }, 'New folder here'),
    n.readOnly ? null : h('button', { type: 'button', class: 'link', onclick: () => { const f = renameForm(p, false); f.backup = actions; actions.replaceWith(f); f.querySelector('input').focus(); } }, 'Rename or move'),
    h('button', { type: 'button', class: 'link', onclick: () => copyText(fullPath(p), 'Path') }, 'Copy path'),
    n.readOnly || n.children.length ? null : h('button', { type: 'button', class: 'link danger', onclick: guard(async () => {
      if (!confirm(`Delete the empty folder “${n.name}”?`)) return;
      await api('DELETE', `/api/file?path=${encodeURIComponent(p)}`);
      await loadNotes();
      p.includes('/') ? showFolder(parentOf(p)) : showVaultInfo();
    }) }, 'Delete'));
  $('noteView').replaceChildren(
    h('div', { class: 'note-meta' }, h('button', { type: 'button', class: 'link', onclick: showVaultInfo }, '← Memory'), h('span', {}, p)),
    actions,
    h('div', { class: 'doc' },
      h('h1', {}, n.name),
      n.readOnly ? h('p', { class: 'hint' }, 'UltraClaude keeps this folder up to date itself. You can read and copy what is here.') : null,
      h('p', {}, `${plural(files.length, 'note')}, ${plural(n.children.length - files.length, 'folder')}.`),
      files.length ? h('ul', {}, files.map((f) => h('li', {}, h('a', { onclick: () => openNote(f.path) }, f.name)))) : null));
  $('noteView').scrollTop = 0;
  renderNotes();
}

/** The editor, for a new note (folder given) or an existing one (path and its current text given). */
function showEditor({ folder = null, path = null, content = '', title = '' }) {
  S.editing = true;
  const isNew = !path;
  const folders = foldersIn(S.tree).filter((d) => !d.readOnly);
  const where = isNew ? h('select', { 'aria-label': 'Folder' }, h('option', { value: '' }, 'Vault (top level)'), folders.map((d) => h('option', { value: d.path }, d.path))) : null;
  if (where) where.value = folders.some((d) => d.path === folder) ? folder : '';
  const name = isNew ? h('input', { placeholder: 'Name of the note', 'aria-label': 'Name of the note', spellcheck: 'false', value: title }) : null;
  const text = h('textarea', { spellcheck: 'false', 'aria-label': 'Note text', placeholder: 'What should every agent know? Markdown works, and [[Note name]] links to another note.' });
  text.value = content;
  const original = content;
  const close = () => { S.editing = false; if (isNew) (folder ? showFolder(folder) : showVaultInfo()); else openNote(path); };
  const save = guard(async () => {
    if (isNew) {
      const title = name.value.trim();
      if (!title) { name.focus(); return toast('Give the note a name.', 'waiting'); }
      const r = await api('POST', '/api/file', { path: where.value ? `${where.value}/${title}` : title, content: text.value.trim() ? text.value : `# ${title}\n` });
      S.editing = false;
      S.open.add(parentOf(r.path));
      await loadNotes();
      return openNote(r.path);
    }
    await api('PUT', '/api/file', { path, content: text.value });
    S.editing = false;
    await loadNotes();
    openNote(path);
  });
  const cancel = () => { if (text.value !== original && !confirm('Discard your changes?')) return; close(); };
  text.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') cancel();
  });
  $('noteView').replaceChildren(h('div', { class: 'editor' },
    h('div', { class: 'note-meta' }, h('span', {}, isNew ? 'New note' : `Editing ${path}`), h('span', {}, 'Ctrl+S saves · Esc cancels')),
    isNew ? h('div', { class: 'row' }, where, name) : null,
    text,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'), h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Cancel'))));
  (isNew ? name : text).focus();
  renderNotes();
}

const newNote = (folder) => showEditor({ folder: folder ?? S.folder ?? (S.note ? parentOf(S.note) : `${S.projectRel}/Memory`) });

function newFolder(inFolder) {
  const parent = inFolder ?? S.folder ?? (S.note ? parentOf(S.note) : `${S.projectRel}/Memory`);
  const input = h('input', { placeholder: 'Name of the new folder', 'aria-label': 'Name of the new folder', spellcheck: 'false' });
  const save = guard(async () => {
    const r = await api('POST', '/api/folder', { path: parent ? `${parent}/${input.value.trim()}` : input.value.trim() });
    S.open.add(parent);
    S.open.add(r.path);
    await loadNotes();
    showFolder(r.path);
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') showFolder(parent); });
  Object.assign(S, { folder: parent, note: null, editing: false });
  $('noteView').replaceChildren(h('div', { class: 'editor' },
    h('div', { class: 'note-meta' }, h('span', {}, `New folder in ${parent || 'the vault'}`)),
    h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Create'), h('button', { type: 'button', class: 'link', onclick: () => (parent ? showFolder(parent) : showVaultInfo()) }, 'Cancel'))));
  input.focus();
  renderNotes();
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
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (head) { out.push(h(`h${Math.min(3, head[1].length + 1)}`, {}, inline(head[2]))); list = null; }
    else if (item || num) {
      const tag = item ? 'ul' : 'ol';
      if (list?.tagName.toLowerCase() !== tag) { list = h(tag); out.push(list); }
      list.append(h('li', {}, inline((item || num)[1])));
    }
    else if (line.trim()) { out.push(h('p', {}, inline(line))); list = null; }
    else list = null;
  }
  if (code) out.push(h('pre', {}, code.join('\n')));
  return out;
}

const openNote = guard(async (ref) => {
  const n = await api('GET', `/api/note?path=${encodeURIComponent(ref)}`);
  Object.assign(S, { note: n.path, folder: null, editing: false });
  for (let p = parentOf(n.path); p; p = parentOf(p)) S.open.add(p); // show where it lives
  const readOnly = nodeAt(S.tree, n.path)?.readOnly;
  const actions = h('div', { class: 'note-actions' },
    readOnly ? null : h('button', { type: 'button', class: 'link', onclick: guard(async () => showEditor({ path: n.path, content: (await api('GET', `/api/file?path=${encodeURIComponent(n.path)}`)).content })) }, 'Edit'),
    readOnly ? null : h('button', { type: 'button', class: 'link', onclick: () => { const f = renameForm(n.path, true); f.backup = actions; actions.replaceWith(f); f.querySelector('input').focus(); } }, 'Rename or move'),
    h('button', { type: 'button', class: 'link', onclick: guard(async () => {
      const r = await api('POST', '/api/file/copy', readOnly ? { from: n.path, to: `${S.projectRel}/Memory/${baseName(n.path)}` } : { from: n.path });
      await loadNotes();
      openNote(r.path);
    }) }, readOnly ? 'Copy into Memory' : 'Duplicate'),
    h('button', { type: 'button', class: 'link', onclick: () => copyText(n.body, 'Text') }, 'Copy text'),
    h('button', { type: 'button', class: 'link', onclick: () => copyText(fullPath(n.path), 'Path') }, 'Copy path'),
    h('button', { type: 'button', class: 'link', onclick: () => openInObsidian(n.path) }, 'Open in Obsidian'),
    readOnly ? null : h('button', { type: 'button', class: 'link danger', onclick: guard(async () => {
      if (!confirm(`Delete “${n.title}”? This cannot be undone.`)) return;
      await api('DELETE', `/api/file?path=${encodeURIComponent(n.path)}`);
      await loadNotes();
      showFolder(parentOf(n.path));
    }) }, 'Delete'));
  $('noteView').replaceChildren(...[
    h('div', { class: 'note-meta' },
      h('button', { type: 'button', class: 'link', onclick: showVaultInfo }, '← Memory'),
      h('span', {}, n.path), h('span', {}, `updated ${n.updated}`),
      n.authors.length ? h('span', {}, `by ${n.authors.join(', ')}`) : null,
      n.tags.length ? h('span', {}, n.tags.map((t) => `#${t}`).join(' ')) : null),
    actions,
    readOnly ? h('p', { class: 'hint' }, 'UltraClaude keeps this note up to date itself. To change it, copy it into Memory first.') : null,
    h('div', { class: 'doc' }, h('h1', {}, n.title), markdown(n.body)),
  ].filter(Boolean));
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
  if (S.user?.prefs.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  // Show its terminal right away: a first start may ask to trust the folder there.
  if (agentBy(a.id)) openAgent(a.id); else S.want = a.id;
});

// ---------- live updates ----------

let agentSig = null;

function onAgents(agents) {
  S.agents = agents;
  const alive = new Set(agents.map((a) => a.id));
  for (const set of [S.picked, S.hidden, S.only]) if (set) for (const id of set) if (!alive.has(id)) set.delete(id);
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
  if (e.type === 'memory') graphPulse(e.paths || (e.path ? [e.path] : []), e.op === 'write' ? 'write' : 'read');
  const jump = () => { const a = agentBy(e.agent); if (a) openAgent(a.id); };
  const notify = (title) => {
    if (document.hidden && S.user?.prefs.notify && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body: e.text });
  };
  if (e.type === 'waiting') { toast(`${e.agent} ${e.text}`, 'waiting', jump); notify(`${e.agent} needs you`); }
  else if (e.type === 'notify') { toast(`${e.agent}: ${e.text}`, 'waiting', jump); notify(`Message from ${e.agent}`); }
  else if (e.type === 'error') toast(`${e.agent} ${e.text}`, 'error');
  else if (e.type === 'guard') { toast(`Cost guard: ${e.text}`, 'waiting'); notify('Cost guard'); }
  else if (e.type === 'mission' && e.to === 'user') { toast(`${e.agent} ${e.text}`, 'waiting', () => setView('missions')); notify('Mission finished'); }
}

// Live updates that arrive while the state is being fetched are newer than the fetched state.
let liveSeen = 0;

async function loadState() {
  const seen = liveSeen;
  const st = await api('GET', '/api/state');
  const stale = seen !== liveSeen;
  Object.assign(S, { project: st.project, roles: st.roles, noteCount: st.notes, sessions: st.sessions, version: st.version }, stale ? {} : { tasks: st.tasks });
  // The window always loads the newest interface, the server keeps the code it started with.
  const outdated = !st.version || st.version !== st.latest;
  $('updateBar').hidden = !outdated;
  $('updateBtn').hidden = !st.version;
  setText($('updateText'), st.version
    ? 'UltraClaude was updated. Restart to use the new version. Running agents continue their sessions.'
    : 'The UltraClaude server for this folder is older than this window. Run “ultraclaude” in this folder to update it.');
  renderSessions();
  renderGuard(st.guard);
  renderMissions(st.missions || []);
  setText($('projectName'), S.project.name);
  $('projectName').title = S.project.dir;
  setText($('vaultPath'), S.project.vault);
  $('vaultPath').title = S.project.vault;
  $('obsidianHint').hidden = S.project.inObsidian;
  $('quickRoles').replaceChildren(...S.roles.filter((r) => r.id !== 'custom').map((r) => roleButton(r, () => createAgent({ roleId: r.id }))));
  $('roleGrid').replaceChildren(...S.roles.map((r) => roleButton(r, () => selectRole(r.id))));
  $('feed').replaceChildren();
  for (const e of st.events) addEvent(e);
  if (!stale) { agentSig = null; onAgents(st.agents); }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?t=${TOKEN}`);
  ws.onopen = guard(async () => {
    $('conn').classList.add('on');
    setText($('connText'), 'connected');
    await loadState();
    lookForUpdate();
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'out') terms.get(m.id)?.term.write(m.d);
    else if (m.t === 'replay') {
      const t = terms.get(m.id);
      if (t) { t.term.reset(); t.term.write(m.d); } else pendingReplay.set(m.id, m.d);
    } else if (m.t === 'agents') { liveSeen++; onAgents(m.agents); }
    else if (m.t === 'tasks') { liveSeen++; S.tasks = m.tasks; renderTasks(); syncSide(); }
    else if (m.t === 'event') onEvent(m.e);
    else if (m.t === 'sessions') { S.sessions = m.sessions; renderSessions(); }
    else if (m.t === 'guard') renderGuard(m.guard);
    else if (m.t === 'missions') renderMissions(m.missions);
    else if (m.t === 'brainindex') { if (m.status.measured && !brainIndex.measured && views && views.view !== 'brain' && S.view === 'map') setTimeout(() => views.refresh(), 0); const was = brainIndex.state; brainIndex = { ...brainIndex, ...m.status, total: m.status.files }; if (m.status.state === 'ready' && (was !== 'ready' || !brainFiles)) reloadFiles(); else syncBrainStatus(); }
    else if (m.t === 'brainchat') onBrainChat(m.item);
    else if (m.t === 'brainbusy') { ask.busy = m.busy; renderAsk(); }
    else if (m.t === 'brainreset') { ask.items = []; renderAsk(); }
    else if (m.t === 'brainshow') { if (brain && S.view === 'map' && (!views || views.view === 'brain') && brain.show(m.paths)) syncBrainStatus(m.label); }
    else if (m.t === 'brainview') { if (S.view === 'map') brainViews().open(m.view.view, m.view); }
    else if (m.t === 'notes') { S.noteCount = m.count; syncSide(); syncGraph(); if (S.view === 'memory') { loadNotes(); scheduleGraph(); } } // keeps an open editor as it is
  };
  ws.onclose = (ev) => {
    if (halted) return;
    if (ev.code === 4401) return location.reload(); // signed out or removed elsewhere
    $('conn').classList.remove('on');
    setText($('connText'), 'reconnecting');
    setTimeout(reconnect, 1500);
  };
}

function halt(title, text) {
  halted = true;
  stageObserver.disconnect();
  if (ws) { ws.onmessage = null; ws.close(); }
  document.body.replaceChildren(h('div', { class: 'halt' }, h('h1', {}, title), h('p', {}, text)));
}

// ---------- account: sign in, profile, settings, usage ----------

const AUTH_TEXT = {
  login: { title: 'Sign in', sub: 'Use your UltraClaude account to open this window.', go: 'Sign in', ask: 'New here?', to: 'Create an account' },
  signup: { title: 'Create your account', sub: 'One account on this computer. It protects the window and keeps your settings.', go: 'Create account', ask: 'Already have an account?', to: 'Sign in' },
};
let authMode = 'login';

const authError = (text) => { $('authError').hidden = !text; setText($('authError'), text); };

function pwHint() {
  const n = $('aPass').value.length;
  $('pwHint').classList.toggle('ok', n >= 10);
  setText($('pwHint'), n >= 10 ? 'Long enough. Avoid common words and your email.' : `At least 10 characters (${n}/10). A few random words make a strong password.`);
}

function showAuth(mode, notice = '') {
  authMode = mode;
  const t = AUTH_TEXT[mode];
  document.body.classList.add('locked');
  $('auth').hidden = false;
  setText($('authTitle'), t.title); setText($('authSub'), t.sub); setText($('authGo'), t.go);
  setText($('authSwitchText'), t.ask); setText($('authSwitch'), t.to);
  $('nameFields').hidden = mode !== 'signup';
  $('guestBox').hidden = !S.guestAllowed;
  $('pwHint').hidden = mode !== 'signup';
  $('aPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  authError(notice);
  pwHint();
  $(mode === 'signup' ? 'aFirst' : 'aEmail').focus();
}

const initials = (u) => `${u.firstName[0] || ''}${u.lastName[0] || ''}`.toUpperCase();
const fillAvatar = (el, u) => el.replaceChildren(u.avatar ? h('img', { src: u.avatar, alt: '' }) : initials(u));

function renderProfile() {
  fillAvatar($('profileAvatar'), S.user);
  setText($('profileName'), `${S.user.firstName} ${S.user.lastName}`.trim());
  setText($('signOut'), S.user.guest ? 'End guest session' : 'Sign out');
  $('setNav').querySelector('[data-tab=security]').hidden = !!S.user.guest;
  $('profileBtn').title = `${S.user.email} · account and settings`;
  $('profileBtn').hidden = false;
}

/** Theme and terminal text size of the signed-in account. */
function applyPrefs() {
  const p = S.user.prefs;
  if (p.theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = p.theme;
  for (const t of terms.values()) { t.term.options.fontSize = p.termFont; fitTerm(t); }
}

function enterApp(user) {
  S.user = user;
  applyPrefs();
  renderProfile();
  $('auth').hidden = true;
  document.body.classList.remove('locked');
  connect();
}

/** Set by the Create an account button of the guest view, so the next page load opens the sign-up form. */
const wantSignup = () => { try { const v = sessionStorage.getItem('uc-signup'); sessionStorage.removeItem('uc-signup'); return !!v; } catch { return false; } };

async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    S.guestAllowed = me.guestAllowed;
    const signup = wantSignup(); // always read, so an old flag cannot turn up later
    if (me.user) enterApp(me.user); else showAuth(me.accounts && !signup ? 'login' : 'signup');
  } catch (err) {
    halt('UltraClaude cannot be reached', err.message);
  }
}

async function reconnect() {
  try {
    const me = await api('GET', '/api/auth/me');
    if (!me.user) return location.reload(); // signed out elsewhere: back to the sign-in screen
    connect();
  } catch { setTimeout(reconnect, 1500); }
}

// ---- settings window ----

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
const say = (el, text, kind = '') => { el.className = `msg ${kind}`; el.textContent = text; };
const money = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : String(n));
const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const savePrefs = async (patch) => { S.user = (await api('PATCH', '/api/auth/prefs', patch)).user; applyPrefs(); };

/** A square 256 px picture from any photo, so the account file stays small. */
async function squareAvatar(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const canvas = h('canvas', { width: 256, height: 256 });
  canvas.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function tabGuestProfile() {
  const make = guard(async () => {
    try { sessionStorage.setItem('uc-signup', '1'); } catch { /* the sign-in screen is shown instead */ }
    await api('POST', '/api/auth/logout', {});
    location.reload();
  });
  $('tab-profile').replaceChildren(
    h('h2', {}, 'Guest'),
    h('div', { class: 'who' }, h('span', { class: 'avatar big' }, 'G'), h('div', { class: 'col' }, h('b', {}, 'You are using UltraClaude as a guest'), h('span', { class: 'fine' }, 'Without an account there is no photo, no saved settings and no password to change. The guest session ends after 12 hours of not using it.'))),
    h('div', { class: 'formrow' }, h('button', { type: 'button', class: 'btn primary', onclick: make }, 'Create an account')));
}

function tabProfile() {
  if (S.user.guest) return tabGuestProfile();
  const u = S.user;
  const avatar = h('span', { class: 'avatar big' });
  fillAvatar(avatar, u);
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  file.addEventListener('change', guard(async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 10e6) throw new Error('Choose a PNG, JPEG or WebP picture under 10 MB.');
    S.user = (await api('PATCH', '/api/auth/profile', { avatar: await squareAvatar(f) })).user;
    fillAvatar(avatar, S.user); renderProfile();
  }));
  const remove = h('button', { type: 'button', class: 'link', onclick: guard(async () => { S.user = (await api('PATCH', '/api/auth/profile', { avatar: null })).user; fillAvatar(avatar, S.user); renderProfile(); }) }, 'Remove photo');
  const first = h('input', { value: u.firstName, maxlength: 50, autocomplete: 'given-name' });
  const last = h('input', { value: u.lastName, maxlength: 50, autocomplete: 'family-name' });
  const email = h('input', { type: 'email', value: u.email, maxlength: 254, autocomplete: 'email', spellcheck: 'false' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200 });
  const passField = field('Current password (needed to change your email)', pass);
  passField.hidden = true;
  email.addEventListener('input', () => { passField.hidden = email.value.trim().toLowerCase() === S.user.email; });
  const msg = h('span', { class: 'msg' });
  const save = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const body = { firstName: first.value, lastName: last.value };
    if (!passField.hidden) Object.assign(body, { email: email.value, password: pass.value });
    try { S.user = (await api('PATCH', '/api/auth/profile', body)).user; renderProfile(); pass.value = ''; passField.hidden = true; fillAvatar(avatar, S.user); say(msg, 'Saved', 'ok'); } catch (err) { say(msg, err.message, 'bad'); }
  } }, 'Save');
  $('tab-profile').replaceChildren(
    h('h2', {}, 'Profile'),
    h('div', { class: 'who' }, avatar, h('div', { class: 'col' }, h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, 'Upload photo'), file, remove)),
    h('div', { class: 'group' }, h('div', { class: 'row2' }, field('First name', first), field('Last name', last)), field('Email', email), passField, h('div', { class: 'formrow' }, save, msg)),
    h('p', { class: 'fine' }, `Account created ${new Date(u.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Your account lives on this computer only.`));
}

function tabAppearance() {
  const p = S.user.prefs;
  const themes = [['dark', 'Black'], ['light', 'Light']];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' }, themes.map(([v, label]) => h('button', {
    type: 'button', class: (p.theme === 'light' ? 'light' : 'dark') === v ? 'on' : '', 'aria-pressed': String((p.theme === 'light' ? 'light' : 'dark') === v),
    onclick: guard(async () => { await savePrefs({ theme: v }); tabAppearance(); }),
  }, label)));
  const out = h('output', {}, `${p.termFont} px`);
  const slider = h('input', { type: 'range', min: 10, max: 22, step: 1, value: p.termFont, 'aria-label': 'Terminal text size' });
  slider.addEventListener('input', () => { out.textContent = `${slider.value} px`; for (const t of terms.values()) { t.term.options.fontSize = +slider.value; fitTerm(t); } });
  slider.addEventListener('change', guard(() => savePrefs({ termFont: +slider.value })));
  const notify = h('input', { type: 'checkbox', checked: p.notify });
  notify.addEventListener('change', guard(async () => {
    await savePrefs({ notify: notify.checked });
    if (notify.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }));
  $('tab-appearance').replaceChildren(
    h('h2', {}, 'Appearance'),
    h('div', { class: 'group' }, h('h3', {}, 'Theme'), seg, h('p', { class: 'fine' }, 'UltraClaude is black unless you choose light. The terminals stay black in both.')),
    h('div', { class: 'group' }, h('h3', {}, 'Terminal text size'), h('div', { class: 'range' }, slider, out)),
    h('div', { class: 'group' }, h('h3', {}, 'Notifications'), h('label', { class: 'switch' }, notify, 'Tell me when an agent needs me and this window is in the background')));
}

// ---- usage ----

let usageRange = '30d';
let usageSeq = 0;

function usageTable(head, rows) {
  return h('table', { class: 'usage-table' },
    h('thead', {}, h('tr', {}, head.map(([label, num]) => h('th', { class: num ? 'num' : '' }, label)))),
    h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((c, i) => (c instanceof Node ? c : h('td', { class: head[i][1] ? 'num' : 'name', title: typeof c === 'string' ? c : '' }, c)))))));
}
const shareBar = (part, whole) => h('td', { class: 'share' }, h('div', { class: 'bar' }, h('i', { style: `width:${whole ? Math.max(2, (part / whole) * 100) : 0}%` })));
const nameCell = (title, sub) => h('td', { class: 'name', title: `${title}${sub ? `\n${sub}` : ''}` }, title, sub ? h('small', {}, sub) : null);

function blockCard(u) {
  const b = u.block;
  const limit = h('input', { type: 'number', min: 1000, step: 1000, placeholder: u.limit ? String(u.limit) : 'tokens', value: u.limitIsAuto ? '' : u.limit ?? '', 'aria-label': 'Token limit for one window' });
  const set = h('button', { type: 'button', class: 'btn', onclick: guard(async () => { await savePrefs({ blockLimit: limit.value === '' ? null : Number(limit.value) }); tabUsage(true); }) }, 'Set');
  const controls = h('p', { class: 'small' }, 'Your limit for one window:', limit, 'tokens ', set, u.limitIsAuto ? '' : h('button', { type: 'button', class: 'link', onclick: guard(async () => { await savePrefs({ blockLimit: null }); tabUsage(true); }) }, ' Use automatic'));
  if (!b) return h('div', { class: 'block' }, h('h3', {}, 'Current 5-hour window'), h('p', { class: 'fine' }, 'No Claude Code activity in the last five hours. A new window starts with your next message.'), controls);
  const pct = u.limit ? (b.tokens / u.limit) * 100 : 0;
  return h('div', { class: 'block' },
    h('h3', {}, 'Current 5-hour window', h('span', {}, `started ${hhmm(b.first)} · resets ${hhmm(b.end)}`)),
    u.limit ? h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Share of the window limit used' }, h('i', { class: pct >= 100 ? 'over' : pct >= 80 ? 'hot' : '', style: `width:${Math.min(100, pct)}%` })) : null,
    h('p', { class: 'fine', style: 'margin-top:8px' }, u.limit ? `${Math.round(pct)}% of ${fmt(u.limit)} tokens, ${u.limitIsAuto ? 'your busiest earlier window in the last 30 days' : 'the limit you set'}.` : 'Not enough history yet to compare this window with an earlier one.'),
    h('div', { class: 'figures' },
      h('div', {}, h('b', {}, fmt(b.tokens)), 'tokens'), h('div', {}, h('b', {}, money(b.cost)), 'API-equivalent cost'),
      h('div', {}, h('b', {}, String(b.msgs)), 'messages'), h('div', {}, h('b', {}, b.perMinute ? `${fmt(b.perMinute)}/min` : '–'), 'pace'),
      h('div', {}, h('b', {}, left(b.end - Date.now())), 'until it resets')),
    controls);
}

function trendChart(daily) {
  const days = daily.slice(-30);
  const W = 720; const H = 120; const gap = 4;
  const w = W / days.length - gap;
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const bars = days.map((d, i) => svg('rect', { class: `bar-d${i === days.length - 1 ? ' today' : ''}`, x: (i * (w + gap)).toFixed(1), width: w.toFixed(1), y: (H - (d.tokens / max) * H).toFixed(1), height: Math.max(d.tokens ? 1.5 : 0, (d.tokens / max) * H).toFixed(1), rx: 1.5 },
    svg('title', {}, `${new Date(`${d.date}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: ${fmt(d.tokens)} tokens · ${money(d.cost)} · ${plural(d.msgs, 'message')}`)));
  return svg('svg', { class: 'chart', viewBox: `0 -14 ${W} ${H + 34}`, role: 'img', 'aria-label': 'Tokens per day, last 30 days' },
    svg('line', { class: 'grid', x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5 }), svg('text', { x: 0, y: -4 }, `peak ${fmt(max)} tokens a day`), ...bars,
    svg('text', { x: 0, y: H + 16 }, new Date(`${days[0].date}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
    svg('text', { x: W, y: H + 16, 'text-anchor': 'end' }, 'today'));
}

function heatmap(daily) {
  const first = new Date(`${daily[0].date}T12:00`);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const weeks = Math.ceil((daily.length + offset) / 7);
  const sorted = daily.map((d) => d.tokens).filter(Boolean).sort((a, b) => a - b);
  const level = (n) => (!n ? 0 : 1 + [0.25, 0.5, 0.75].filter((q) => n > sorted[Math.floor(q * (sorted.length - 1))]).length);
  const opacity = [0.07, 0.28, 0.5, 0.75, 1];
  const cell = 11; const step = 14; const top = 16;
  const rects = daily.map((d, i) => {
    const col = Math.floor((i + offset) / 7); const row = (i + offset) % 7;
    return svg('rect', { x: col * step, y: top + row * step, width: cell, height: cell, rx: 2, 'fill-opacity': opacity[level(d.tokens)] },
      svg('title', {}, `${new Date(`${d.date}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}: ${d.tokens ? `${fmt(d.tokens)} tokens · ${money(d.cost)}` : 'no activity'}`));
  });
  const months = [];
  daily.forEach((d, i) => { const dt = new Date(`${d.date}T12:00`); if (dt.getDate() <= 7 && ((i + offset) % 7) === 0) months.push(svg('text', { x: Math.floor((i + offset) / 7) * step, y: 9 }, dt.toLocaleDateString('en-GB', { month: 'short' }))); });
  return svg('svg', { class: 'heat', viewBox: `0 0 ${weeks * step} ${top + 7 * step}`, role: 'img', 'aria-label': 'Activity over the last 26 weeks', style: `width:${Math.min(100, weeks * 3.9)}%;max-width:${weeks * step * 1.3}px` }, ...months, ...rects);
}

function drawUsage(u) {
  const T = u.totals;
  const periods = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, periods.map(([v, label]) => h('button', { type: 'button', class: u.range === v ? 'on' : '', onclick: () => { usageRange = v; tabUsage(); } }, label)));
  const csv = () => {
    const text = `date,tokens,api_cost_usd,messages\n${u.daily.map((d) => `${d.date},${d.tokens},${d.cost.toFixed(4)},${d.msgs}`).join('\n')}\n`;
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: 'ultraclaude-usage.csv' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const empty = !T.msgs;
  return [
    h('h2', {}, 'Usage'),
    h('p', { class: 'lead' }, 'What your Claude Code chats used, read from their history on this computer.'),
    h('div', { class: 'usage-top' }, seg, h('button', { type: 'button', class: 'btn', onclick: () => tabUsage(true) }, 'Refresh'), h('button', { type: 'button', class: 'btn', onclick: csv }, 'Export CSV'), h('span', { class: 'upd' }, `${plural(u.files, 'chat file')} · updated ${hhmm(u.generated)}`)),
    blockCard(u),
    guardCard(),
    h('div', { class: 'stats' },
      h('div', {}, h('b', {}, fmt(T.tokens)), h('span', {}, `tokens · ${fmt(T.i + T.o)} in/out, ${fmt(T.cw + T.cr)} cache`)),
      h('div', {}, h('b', {}, money(T.cost)), h('span', {}, T.unpriced ? `API-equivalent · ${fmt(T.unpriced)} tokens unpriced` : 'API-equivalent cost')),
      h('div', {}, h('b', {}, fmt(T.msgs)), h('span', {}, 'replies')),
      h('div', {}, h('b', {}, String(T.sessions)), h('span', {}, `chats${u.streak > 1 ? ` · ${u.streak}-day streak` : ''}`))),
    h('div', { class: 'group' }, h('h3', {}, 'Tokens per day'), trendChart(u.daily)),
    h('div', { class: 'group' }, h('h3', {}, 'Activity, last 26 weeks'), heatmap(u.daily)),
    empty ? h('p', { class: 'fine' }, 'Nothing in this period. Pick a longer one, or send a message in any Claude Code chat.') : h('div', { class: 'tab', style: 'gap:26px' },
      h('div', { class: 'group' }, h('h3', {}, 'Models'), usageTable([['Model'], ['Tokens', 1], ['Cost', 1], ['Share']], u.models.map((m) => [nameCell(m.model), fmt(m.tokens), m.priced ? money(m.cost) : '–', shareBar(m.tokens, T.tokens)]))),
      h('div', { class: 'group' }, h('h3', {}, 'Projects'), usageTable([['Folder'], ['Chats', 1], ['Tokens', 1], ['Cost', 1], ['Share']], u.projects.slice(0, 12).map((p) => [nameCell(p.name, p.dir), String(p.sessions), fmt(p.tokens), money(p.cost), shareBar(p.tokens, T.tokens)]))),
      h('div', { class: 'group' }, h('h3', {}, 'Recent chats'), usageTable([['Chat'], ['Last active', 1], ['Tokens', 1], ['Cost', 1]], u.sessions.slice(0, 12).map((s) => [nameCell(s.title || `Chat ${s.id.slice(0, 8)}`, `${s.dir ? s.dir.split(/[\\/]/).pop() : ''} · ${s.model}`), ago(s.last), fmt(s.tokens), money(s.cost)])))),
    h('p', { class: 'fine' }, 'Costs are what these tokens would cost at API list prices. A Claude Pro or Max subscription is not billed per token. The percentage Claude shows for your plan cannot be read here, because that needs your Claude login token and UltraClaude never touches it. The window above compares against your busiest earlier window, or the limit you set.'),
  ];
}

async function tabUsage(fresh = false) {
  const root = $('tab-usage');
  const seq = ++usageSeq;
  if (!root.children.length || fresh) root.replaceChildren(h('p', { class: 'loading' }, 'Reading your Claude Code history…'));
  try {
    const u = await api('GET', `/api/usage?range=${usageRange}${fresh ? '&fresh=1' : ''}`);
    if (seq === usageSeq) root.replaceChildren(...drawUsage(u));
  } catch (err) {
    if (seq === usageSeq) root.replaceChildren(h('p', { class: 'form-error' }, err.message));
  }
}

// ---- security ----

const deviceName = (ua = '') => {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
};

async function tabSecurity() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200 });
  const next = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 200 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 200 });
  const msg = h('span', { class: 'msg' });
  const change = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    if (next.value !== again.value) return say(msg, 'The two new passwords are different.', 'bad');
    try { await api('POST', '/api/auth/password', { current: cur.value, next: next.value }); cur.value = next.value = again.value = ''; toast('Password changed. Your other devices were signed out.'); tabSecurity(); } catch (err) { say(msg, err.message, 'bad'); }
  } }, 'Change password');

  const guestBox = h('input', { type: 'checkbox', checked: !!S.guestAllowed });
  guestBox.addEventListener('change', guard(async () => { S.guestAllowed = (await api('PATCH', '/api/auth/guest-setting', { allow: guestBox.checked })).guestAllowed; }));
  const sessionsBox = h('div', { class: 'list' }, h('div', {}, 'Loading…'));
  const others = h('button', { type: 'button', class: 'btn', hidden: true, onclick: guard(async () => { await api('POST', '/api/auth/sessions/revoke-others', {}); tabSecurity(); }) }, 'Sign out everywhere else');

  const pw = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200, 'aria-label': 'Your password' });
  const dmsg = h('span', { class: 'msg' });
  const confirmRow = h('div', { class: 'formrow', hidden: true }, field('Your password', pw),
    h('button', { type: 'button', class: 'btn danger', onclick: async () => {
      if (!confirm('Delete your account for good? Your settings and sessions are removed. Your projects and memory are not touched.')) return;
      try { await api('DELETE', '/api/auth/account', { password: pw.value }); location.reload(); } catch (err) { say(dmsg, err.message, 'bad'); }
    } }, 'Delete permanently'), dmsg);
  const ask = h('button', { type: 'button', class: 'btn danger', onclick: () => { confirmRow.hidden = false; ask.hidden = true; pw.focus(); } }, 'Delete account…');

  $('tab-security').replaceChildren(
    h('h2', {}, 'Security'),
    h('div', { class: 'group' }, h('h3', {}, 'Password'), h('div', { class: 'row2' }, field('Current password', cur), h('span')), h('div', { class: 'row2' }, field('New password', next), field('Repeat new password', again)), h('div', { class: 'formrow' }, change, msg), h('p', { class: 'fine' }, 'At least 10 characters. Changing it signs you out on every other device.')),
    h('div', { class: 'group' }, h('h3', {}, 'Where you are signed in'), sessionsBox, h('div', { class: 'formrow' }, others)),
    h('div', { class: 'group' }, h('h3', {}, 'Sign-in screen'), h('label', { class: 'switch' }, guestBox, 'Offer the button Continue without signing in'), h('p', { class: 'fine' }, 'Anyone who can open this window can then use it as a guest, without an account. Turn it off to require a sign-in every time. Guests cannot see or change any account.')),
    h('div', { class: 'group' }, h('h3', {}, 'How your account is protected'), h('p', { class: 'fine' }, 'Passwords are stored only as a salted scrypt hash. After five wrong tries an account is locked for a while. A session lasts 30 days and lives in a cookie that scripts cannot read and other websites cannot use. The window only talks to this computer.')),
    h('div', { class: 'danger-zone group' }, h('h3', {}, 'Delete account'), h('p', { class: 'fine' }, 'Removes this account from this computer. Your projects, agents and memory stay as they are.'), ask, confirmRow));

  try {
    const { sessions } = await api('GET', '/api/auth/sessions');
    sessionsBox.replaceChildren(...sessions.map((s) => h('div', {},
      h('div', { class: 'grow' }, h('b', {}, deviceName(s.agent), s.current ? h('span', { class: 'chip' }, 'This device') : null), h('span', {}, `Signed in ${ago(s.createdAt)} ago · last active ${ago(s.lastSeen)} ago`)),
      s.current ? null : h('button', { type: 'button', class: 'link', onclick: guard(async () => { await api('DELETE', `/api/auth/sessions/${s.id}`); tabSecurity(); }) }, 'Sign out'))));
    others.hidden = sessions.length < 2;
  } catch (err) { sessionsBox.replaceChildren(h('div', {}, err.message)); }
}

// ---------- updates from GitHub ----------

async function lookForUpdate(fresh = false) {
  try { S.update = await api('GET', `/api/update${fresh ? '?fresh=1' : ''}`); } catch { return; } // an older server cannot say
  $('newBar').hidden = !S.update.available;
  if (S.update.available) setText($('newText'), `New update available: version ${S.update.latest} (you have ${S.update.current}).`);
}

const runUpdate = guard(async () => {
  const buttons = [$('newBtn'), $('aboutUpdate')].filter(Boolean);
  for (const b of buttons) { b.disabled = true; b.textContent = 'Installing…'; }
  try {
    await api('POST', '/api/update', {});
    $('newBar').hidden = true;
    toast('Update installed. Press “Restart now” to use it.');
    await loadState(); // shows the restart bar
  } finally { for (const b of buttons) { b.disabled = false; b.textContent = 'Update now'; } }
});

function updateBox() {
  const u = S.update;
  const text = !u ? 'Checking for updates…' : u.available ? `New update available: version ${u.latest}. You have ${u.current}.` : u.error ? `Version ${u.current}. Could not check for updates: ${u.error}` : `Version ${u.current} is up to date.`;
  return h('div', { class: 'group', id: 'updateBox' }, h('h3', {}, 'Updates'), h('p', {}, text),
    h('div', { class: 'formrow' },
      u?.available ? h('button', { type: 'button', class: 'btn primary', id: 'aboutUpdate', onclick: runUpdate }, 'Update now') : null,
      h('button', { type: 'button', class: 'btn', onclick: guard(async () => { await lookForUpdate(true); tabAbout(); }) }, 'Check for updates')),
    u?.available ? h('p', { class: 'fine' }, `Or run in a terminal: ${u.manual || ''}`) : null);
}

function tabAbout() {
  const keys = [['Ctrl+V', 'Paste text, or attach a copied image'], ['Ctrl+C', 'Copy the selection, or interrupt Claude'], ['Shift+Enter', 'New line in the prompt'], ['Ctrl+S', 'Save a note in the memory editor'], ['Esc', 'Close a window or cancel an edit']];
  $('tab-about').replaceChildren(
    h('h2', {}, 'About'),
    updateBox(),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Signed in as'), h('dd', {}, S.user.email), h('dt', {}, 'Version'), h('dd', { class: 'mono' }, S.version || '–'),
      h('dt', {}, 'This project'), h('dd', { class: 'mono' }, S.project.dir), h('dt', {}, 'Memory vault'), h('dd', { class: 'mono' }, S.project.vault)),
    h('div', { class: 'formrow' }, h('button', { type: 'button', class: 'btn', onclick: () => openInObsidian() }, 'Open in Obsidian'), h('button', { type: 'button', class: 'btn', onclick: guard(() => api('POST', '/api/open-vault-folder', {})) }, 'Open vault folder'), h('a', { class: 'link', href: 'https://github.com/ZH-NICO/ultraclaude', target: '_blank', rel: 'noopener noreferrer' }, 'GitHub')),
    h('div', { class: 'group' }, h('h3', {}, 'Keyboard'), h('table', { class: 'keys' }, h('tbody', {}, keys.map(([k, what]) => h('tr', {}, h('td', {}, k), h('td', {}, what)))))));
}

const TABS = { profile: tabProfile, appearance: tabAppearance, usage: tabUsage, security: tabSecurity, about: tabAbout };

function openSettings(tab = 'profile') {
  if (S.user.guest && tab === 'security') tab = 'profile';
  const dlg = $('settingsDialog');
  if (!dlg.open) dlg.showModal();
  for (const b of $('setNav').querySelectorAll('button[data-tab]')) { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', String(b.dataset.tab === tab)); }
  for (const name of Object.keys(TABS)) $(`tab-${name}`).hidden = name !== tab;
  $('setBody').scrollTop = 0;
  TABS[tab]();
}

// ---------- replay ----------
// Winds the recording back: the team as it was at the chosen moment, played forward at your speed.
// Quiet stretches are skipped, so ten minutes of nothing do not take ten minutes.

const RP = { events: [], from: 0, to: 0, t: 0, playing: false, raf: 0, last: 0, names: [], pos: new Map(), hub: { x: 0, y: 0 }, nodes: new Map(), layer: null, shown: -1, sig: '' };
const rpAt = (v) => Math.round(RP.from + (v / 1000) * (RP.to - RP.from));
const rpValue = (t) => Math.round(((t - RP.from) / Math.max(1, RP.to - RP.from)) * 1000);
const rpClock = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const loadReplay = guard(async () => {
  const range = Number($('replayRange').value);
  const r = await api('GET', `/api/replay?since=${range ? Date.now() - range : 0}`);
  RP.events = r.events;
  RP.names = agentsIn(r.events);
  RP.from = r.events[0]?.ts ?? r.now;
  // the timeline ends now while things are still happening, otherwise at the last event
  const last = r.events.at(-1)?.ts ?? r.now;
  RP.to = r.now - last < 5 * 60e3 ? r.now : last;
  RP.t = RP.to;
  RP.shown = -1;
  rpPause();
  const empty = !r.events.length;
  $('replayEmpty').hidden = !empty;
  $('replayGraph').style.visibility = empty ? 'hidden' : 'visible';
  setText($('replaySub'), empty ? '' : `${plural(r.events.length, 'event')} · ${plural(RP.names.length, 'agent')}`);
  buildReplayGraph();
  const bars = density(r.events, RP.from, RP.to, 120);
  const peak = Math.max(1, ...bars);
  $('rpDensity').setAttribute('viewBox', '0 0 120 20');
  $('rpDensity').replaceChildren(...bars.map((n, i) => svg('rect', { x: i, width: 0.85, y: 20 - (n / peak) * 20, height: (n / peak) * 20 })));
  rpSeek(RP.to, false);
});

function buildReplayGraph() {
  const stage = $('replayStage');
  const w = stage.clientWidth;
  const ht = stage.clientHeight;
  const n = RP.names.length;
  if (!w || !ht || !n) { $('replayGraph').replaceChildren(); return; }
  RP.hub = { x: Math.round(w / 2), y: Math.round(ht / 2) };
  const compact = w < 640;
  const rx = Math.max(70, Math.min(w / 2 - (compact ? 110 : 210), 330));
  const ry = Math.max(70, Math.min(ht / 2 - 90, 200, rx * 1.2));
  RP.pos.clear(); RP.nodes.clear();
  const links = [];
  const nodes = [];
  RP.names.forEach((name, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const p = { x: Math.round(RP.hub.x + Math.cos(a) * rx), y: Math.round(RP.hub.y + Math.sin(a) * ry) };
    RP.pos.set(name, p);
    links.push(svg('line', { class: 'g-link', x1: p.x, y1: p.y, x2: RP.hub.x, y2: RP.hub.y }));
    const side = Math.abs(Math.cos(a)) > 0.4 ? (Math.cos(a) > 0 ? 'right' : 'left') : Math.sin(a) > 0 ? 'bottom' : 'top';
    const anchor = side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle';
    const t = { side, nm: svg('text', { class: 'nm', 'text-anchor': anchor }, cut(name, 24)), what: svg('text', { class: 'what', 'text-anchor': anchor }), now: svg('text', { class: 'now', 'text-anchor': anchor }) };
    t.g = svg('g', { transform: `translate(${p.x},${p.y})` }, svg('circle', { class: 'mark', r: 6 }), t.nm, t.what, t.now);
    RP.nodes.set(name, t);
    nodes.push(t.g);
  });
  const hubG = svg('g', { class: 'g-hub', transform: `translate(${RP.hub.x},${RP.hub.y})` }, svg('rect', { x: -50, y: -22, width: 100, height: 44, rx: 4 }), svg('text', { class: 'nm', y: 4 }, 'Memory'));
  RP.layer = svg('g', {});
  $('replayGraph').setAttribute('viewBox', `0 0 ${w} ${ht}`);
  $('replayGraph').replaceChildren(...links, RP.layer, hubG, ...nodes);
}

function rpUpdate(t, from) {
  $('rpSlider').value = String(rpValue(t));
  setText($('rpTime'), `${rpClock(t)}${Date.now() - t > 2000 ? ` · ${left(Date.now() - t)} ago` : ' · now'}`);
  for (const [name, nd] of RP.nodes) {
    const s = stateAt(RP.events, t, name);
    setAttr(nd.g, 'class', `g-node ${s.state}`);
    const lines = [[nd.nm, null]];
    if (s.state === 'working' || s.state === 'waiting') {
      if (s.status) lines.push([nd.what, cut(s.status, 36)]);
      lines.push([nd.now, cut(s.activity || s.state, 30)]);
    } else lines.push([nd.now, STATE[s.state === 'idle' ? 'idle' : 'stopped']]);
    for (const el of [nd.what, nd.now]) if (!lines.some(([used]) => used === el)) setText(el, '');
    lines.forEach(([el, text], i) => {
      let x = 0; let y;
      if (nd.side === 'right' || nd.side === 'left') { x = nd.side === 'right' ? 16 : -16; y = (i - (lines.length - 1) / 2) * 17 + 4; } else if (nd.side === 'bottom') y = 27 + i * 17; else y = -17 - (lines.length - 1 - i) * 17;
      if (text !== null) setText(el, text);
      setAttr(el, 'x', x); setAttr(el, 'y', y);
    });
  }
  // the feed: the last events up to this moment
  let hi = 0;
  while (hi < RP.events.length && RP.events[hi].ts <= t) hi++;
  if (hi !== RP.shown) {
    $('replayFeed').replaceChildren(...RP.events.slice(Math.max(0, hi - 40), hi).map(feedItem));
    $('replayFeed').scrollTop = $('replayFeed').scrollHeight;
    RP.shown = hi;
  }
  if (from !== false && !calm) for (const e of RP.events.filter((x) => x.ts > from && x.ts <= t).slice(-8)) rpAnimate(e);
}

function rpAnimate(e) {
  const me = RP.pos.get(e.agent);
  if (e.type === 'memory' && me) return e.op === 'write' ? fly(me, RP.hub, false, RP.layer) : fly(RP.hub, me, false, RP.layer);
  if ((e.type === 'notify' || e.type === 'waiting') && me) return ping(me, 'warn', RP.layer);
  if (e.type !== 'message') return;
  const targets = e.to === 'all' ? RP.names.filter((n) => n !== e.agent).map((n) => RP.pos.get(n)) : [RP.pos.get(e.to)];
  for (const to of targets.filter(Boolean)) { if (me) fly(me, to, true, RP.layer); else ping(to, '', RP.layer); }
}

function rpSeek(t, animate = true) {
  const before = RP.t;
  RP.t = Math.min(RP.to, Math.max(RP.from, t));
  rpUpdate(RP.t, animate && RP.t > before ? before : false);
}

function rpPause() {
  RP.playing = false;
  cancelAnimationFrame(RP.raf);
  setText($('rpPlay'), 'Play');
}

function rpTick(now) {
  if (!RP.playing) return;
  const speed = Number($('rpSpeed').value);
  const dt = Math.min(100, now - RP.last); // a hidden tab must not jump ahead
  RP.last = now;
  let t = RP.t + dt * speed;
  const next = nextEventAfter(RP.events, RP.t);
  if (next && next - t > 8000 && next - RP.t > 8000) t = next - 600; // skip a quiet stretch
  rpSeek(t);
  if (RP.t >= RP.to) return rpPause();
  RP.raf = requestAnimationFrame(rpTick);
}

function rpPlay() {
  if (!RP.events.length) return;
  if (RP.t >= RP.to) rpSeek(RP.from, false);
  RP.playing = true;
  RP.last = performance.now();
  setText($('rpPlay'), 'Pause');
  RP.raf = requestAnimationFrame(rpTick);
}

// ---------- memory graph ----------
// The notes as a network, linked by their [[wikilinks]]. Agents reading or writing a note make its dot light up.

const G = { mode: 'list', data: null, pos: new Map(), degree: new Map(), view: null, nodes: new Map(), pz: null, timer: 0 };

function setMemMode(mode) {
  G.mode = mode;
  for (const b of $('memMode').children) b.classList.toggle('on', b.dataset.mode === mode);
  document.querySelector('#view-memory .memory').hidden = mode === 'graph';
  $('memGraph').hidden = mode !== 'graph';
  if (mode === 'graph') loadGraph();
}

const loadGraph = guard(async () => {
  const before = new Set(G.data?.nodes.map((n) => n.id));
  G.data = await api('GET', '/api/graph');
  $('gEmpty').hidden = G.data.nodes.length > 0;
  const stage = $('gStage');
  G.pos = layout(G.data.nodes, G.data.links, { width: Math.max(600, stage.clientWidth), height: Math.max(400, stage.clientHeight) });
  G.degree = degrees(G.data.nodes, G.data.links);
  // the zoom and position are created at startup
  renderGraph(before.size ? before : null);
  if (!G.fitted && G.data.nodes.length) { G.fitted = true; fitGraph(); } // later updates keep your zoom and position
});

function fitGraph() {
  const stage = $('gStage');
  const w = stage.clientWidth; const ht = stage.clientHeight;
  if (!w || !ht || !G.pos.size) return;
  const xs = [...G.pos.values()].map((p) => p.x); const ys = [...G.pos.values()].map((p) => p.y);
  const bw = Math.max(1, Math.max(...xs) - Math.min(...xs)); const bh = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const k = Math.min(2.2, (w - 160) / bw, (ht - 120) / bh);
  Object.assign(G.view, { x: w / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: ht / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * k, k }); // in place: the pan and zoom handler holds this object
  applyGraphView();
}

function applyGraphView() {
  const world = $('gWorld');
  if (!world || !G.view) return;
  world.setAttribute('transform', `translate(${G.view.x.toFixed(1)},${G.view.y.toFixed(1)}) scale(${G.view.k.toFixed(4)})`);
  $('gSvg').classList.toggle('far', G.view.k < 0.7);
}

function renderGraph(previous) {
  const { nodes, links } = G.data;
  if (!G.view) G.view = { x: 0, y: 0, k: 1 };
  const lines = links.map((l) => { const a = G.pos.get(l.source); const b = G.pos.get(l.target); return a && b ? svg('line', { class: 'gl', x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) }) : null; }).filter(Boolean);
  G.nodes.clear();
  const dots = nodes.map((n) => {
    const p = G.pos.get(n.id);
    const r = dotSize(n, G.degree.get(n.id));
    const g = svg('g', { class: `gn ${n.kind.replace(/\s+/g, '-')}${G.degree.get(n.id) >= 3 ? ' big' : ''}${previous && !previous.has(n.id) ? ' fresh' : ''}`, transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`, tabindex: 0, role: 'button', 'aria-label': n.title },
      svg('title', {}, `${n.title}\n${n.ghost ? 'Linked, but no note with this name yet. Click to write it.' : `${n.id}\n${n.updated}${n.authors.length ? ` · ${n.authors.join(', ')}` : ''}`}`),
      svg('circle', { class: 'hit', r: Math.max(r + 5, 10) }), svg('circle', { class: 'dot', r: r.toFixed(1) }),
      svg('text', { x: (r + 5).toFixed(1), y: 4 }, cut(n.title, 30)));
    const open = () => { if (G.pz?.wasDrag()) return; if (n.ghost) { setMemMode('list'); showEditor({ folder: `${S.projectRel}/Memory`, title: n.title }); } else { setMemMode('list'); openNote(n.id); } };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    G.nodes.set(n.id, { g, r, p });
    return g;
  });
  $('gSvg').replaceChildren(svg('g', { id: 'gWorld' }, ...lines, svg('g', { id: 'gRings' }), ...dots));
  applyGraphView();
}

/** Makes the dot of a note light up, for example when an agent reads or writes it. */
function graphPulse(paths, kind) {
  const rings = $('gRings');
  if (!rings || calm || S.view !== 'memory' || G.mode !== 'graph') return;
  for (const path of paths) {
    const nd = G.nodes.get(path);
    if (!nd) continue;
    const ring = svg('circle', { class: `g-ring ${kind}`, cx: nd.p.x.toFixed(1), cy: nd.p.y.toFixed(1), r: nd.r });
    rings.append(ring);
    ring.animate([{ r: nd.r + 2, opacity: 0.9 }, { r: nd.r + 26, opacity: 0 }], { duration: 1100, easing: 'ease-out' }).finished.then(() => ring.remove(), () => ring.remove());
  }
}

function scheduleGraph() {
  clearTimeout(G.timer);
  G.timer = setTimeout(() => { if (S.view === 'memory' && G.mode === 'graph') loadGraph(); }, 500);
}

// ---------- cost guard ----------
// Warns before the 5-hour window is used up and pauses the running agents when it is nearly full.

function renderGuard(g) {
  if (!g) return;
  S.guard = g;
  const show = g.enabled && (g.level !== 'ok' || g.paused.length > 0);
  $('guardBar').hidden = !show;
  $('guardBar').classList.toggle('hot', g.level === 'pause');
  const pct = `${Math.round(g.pct)}% of this 5-hour window is used`;
  setText($('guardText'), g.paused.length
    ? `Cost guard paused ${g.paused.join(', ')}${g.level === 'pause' ? ` at ${Math.round(g.pct)}%. The window resets at ${hhmm(g.end)}.` : '. A new window has started.'}`
    : `Cost guard: ${pct}.${g.fullAt ? ` At this pace it is full at ${hhmm(g.fullAt)}.` : ''}`);
  $('guardResume').hidden = !g.paused.length;
  setText($('guardResume'), g.paused.length === 1 ? 'Resume 1 agent' : `Resume ${g.paused.length} agents`);
}

function guardCard() {
  const g = S.guard;
  if (!g) return null;
  const on = h('input', { type: 'checkbox', checked: g.enabled });
  const warn = h('input', { type: 'number', min: 10, max: 99, value: g.warnAt, 'aria-label': 'Warn at percent' });
  const pause = h('input', { type: 'number', min: 11, max: 100, value: g.pauseAt, 'aria-label': 'Pause at percent' });
  const auto = h('input', { type: 'checkbox', checked: g.autoResume });
  const save = guard(async () => {
    renderGuard(await api('PATCH', '/api/guard', { enabled: on.checked, warnAt: Number(warn.value), pauseAt: Number(pause.value), autoResume: auto.checked }));
    toast('Cost guard saved.');
  });
  return h('div', { class: 'block guard-card' },
    h('h3', {}, 'Cost guard'),
    h('p', { class: 'fine' }, 'Watches the current window against the limit above. It warns first, then stops the running agents so they do not use up the rest. Stopped agents continue their sessions when you resume them.'),
    h('label', { class: 'check' }, on, ' Watch this window'),
    h('p', { class: 'small' }, 'Warn at', warn, '% and pause the agents at', pause, '%'),
    h('label', { class: 'check' }, auto, ' Resume them by itself when a new window starts'),
    h('p', {}, h('button', { type: 'button', class: 'btn', onclick: save }, 'Save')));
}

// ---------- changes (git) ----------
// What each agent changed: its worktree, the files and the diff, and the buttons to bring the work home.

const CH = { data: null, sel: null };
const wtName = (w) => (w.main ? 'Main folder' : w.agent || w.branch || w.path.split(/[\\/]/).pop());

const loadChanges = guard(async () => {
  CH.data = await api('GET', '/api/changes');
  document.querySelector('.changes').classList.toggle('solo', !CH.data.repo); // without git there is no list to show
  if (!CH.data.repo) {
    setText($('changesSub'), 'not a git repository');
    $('wtList').replaceChildren();
    $('wtView').replaceChildren(h('div', { class: 'doc' }, h('h1', {}, 'No git here'), h('p', {}, 'This folder is not a git repository, so there are no changes to show. Run “git init” in it to track what your agents change. Agents started with “Own worktree” then work on their own branch, and their work shows up here to review, merge or open as a pull request.')));
    return;
  }
  const list = CH.data.worktrees;
  const busy = list.filter((w) => w.files.length || w.ahead).length;
  setText($('changesSub'), `${plural(list.length - 1, 'agent worktree')} · ${busy ? `${busy} with changes` : 'nothing changed'}`);
  setText($('navChanges'), busy ? String(busy) : '');
  if (!list.some((w) => w.path === CH.sel)) CH.sel = (list.find((w) => !w.main && (w.files.length || w.ahead)) || list[0]).path;
  $('wtList').replaceChildren(...list.map((w) => h('button', { type: 'button', class: `wt${w.path === CH.sel ? ' on' : ''}`, onclick: () => { CH.sel = w.path; loadChanges(); } },
    h('b', {}, wtName(w)),
    h('small', {}, w.main ? w.branch : w.branch),
    h('span', { class: 'meta' }, [w.ahead ? plural(w.ahead, 'commit') : '', w.files.length ? plural(w.files.length, 'file') : 'no changes', w.dirty ? `${w.dirty} uncommitted` : ''].filter(Boolean).join(' · ')))));
  await showWorktree(list.find((w) => w.path === CH.sel));
});

async function showWorktree(w) {
  const { diff } = await api('GET', `/api/changes/diff?path=${encodeURIComponent(w.path)}`);
  const msg = h('input', { placeholder: 'What changed', 'aria-label': 'Commit message', value: w.agent ? `Work by ${w.agent}` : '' });
  const act = (label, fn, primary = false) => h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onclick: guard(fn) }, label);
  const actions = [];
  if (w.dirty) actions.push(msg, act('Commit all', async () => { await api('POST', '/api/changes/commit', { path: w.path, message: msg.value }); toast('Committed.'); loadChanges(); }));
  if (!w.main && w.ahead) {
    actions.push(act(`Merge into ${w.base}`, async () => { const r = await api('POST', '/api/changes/merge', { path: w.path }); toast(`Merged into ${r.into}.`); loadChanges(); }, !w.dirty));
    actions.push(act('Open pull request', async () => { const r = await api('POST', '/api/changes/pr', { path: w.path }); toast('Pull request opened. Click to see it.', '', () => window.open(r.url, '_blank', 'noopener')); loadChanges(); }));
  }
  $('wtView').replaceChildren(
    h('div', { class: 'wt-head' },
      h('div', {}, h('h2', {}, wtName(w)), h('p', { class: 'fine' }, w.path, w.main ? '' : ` · branch ${w.branch}, ${w.ahead ? `${plural(w.ahead, 'commit')} ahead of ${w.base}` : `nothing committed beyond ${w.base}`}`)),
      actions.length ? h('div', { class: 'wt-actions' }, ...actions) : null),
    w.files.length ? h('ul', { class: 'wt-files' }, ...w.files.map((f) => h('li', { class: f.status }, h('span', { class: 'st' }, f.status), h('code', {}, f.path), f.uncommitted ? h('small', {}, 'uncommitted') : null))) : h('p', { class: 'fine' }, w.main ? 'The main folder has no uncommitted changes.' : 'This worktree has no changes yet.'),
    diff ? renderDiff(diff) : null);
}

/** A unified diff, one line per row, coloured by what happened to it. */
function renderDiff(text) {
  const pre = h('pre', { class: 'diff' });
  const rows = text.split('\n').slice(0, 8000).map((line) => {
    const cls = line.startsWith('diff --git') ? 'file' : line.startsWith('@@') ? 'hunk' : /^(\+\+\+|---|index |new file|deleted file|similarity|rename )/.test(line) ? 'meta' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '';
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = `${line}\n`;
    return el;
  });
  pre.append(...rows);
  return pre;
}

// ---------- missions ----------
// One goal, a coordinator that plans and staffs it, and a pipeline that shows where it stands.

const STAGE_LABEL = { plan: 'Plan', work: 'Work', check: 'Check', done: 'Done' };

function renderMissions(list) {
  if (list) S.missions = list;
  const all = S.missions || [];
  const running = all.filter((m) => m.status === 'running').length;
  setText($('navMissions'), running ? String(running) : '');
  setText($('missionsSub'), all.length ? `${running} running · ${all.length - running} finished or stopped` : 'none yet');
  $('missionList').replaceChildren(...(all.length ? all.map(missionCard) : [h('div', { class: 'empty-state' },
    h('h3', {}, 'No missions yet'),
    h('ol', { class: 'steps' },
      h('li', {}, h('b', {}, '1'), 'Describe what you want done'),
      h('li', {}, h('b', {}, '2'), 'A coordinator plans it and starts helpers'),
      h('li', {}, h('b', {}, '3'), 'Follow it here until it reports back')))]));
}

function missionCard(m) {
  const at = m.stages.indexOf(m.stage);
  const pct = m.tasks.total ? Math.round((m.tasks.done / m.tasks.total) * 100) : 0;
  const lead = agentBy(m.coordinator);
  return h('article', { class: `mission ${m.status}` },
    h('div', { class: 'm-head' },
      h('h3', {}, m.goal),
      h('div', { class: 'm-actions' },
        lead ? h('button', { type: 'button', class: 'btn', onclick: () => openAgent(lead.id) }, 'Open coordinator') : null,
        m.status === 'running' ? h('button', { type: 'button', class: 'btn', onclick: guard(async () => { await api('POST', `/api/missions/${m.id}/stop`); }) }, 'Stop') : null)),
    h('p', { class: 'fine' }, [`${m.coordinator || 'Coordinator'} coordinates`, m.helpers.length ? `helpers: ${m.helpers.join(', ')}` : 'no helpers yet', `started ${hhmm(m.createdAt)}`].join(' · ')),
    h('ol', { class: 'pipeline', 'aria-label': 'Progress' }, m.stages.map((s, i) => h('li', { class: m.stage === 'stopped' ? '' : i < at ? 'past' : i === at ? 'on' : '' }, STAGE_LABEL[s]))),
    m.stage === 'stopped' ? h('p', { class: 'm-stopped' }, `Stopped ${m.endedAt ? hhmm(m.endedAt) : ''}`) : null,
    m.tasks.total ? h('div', { class: 'm-progress' },
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Tasks done' }, h('i', { style: `width:${pct}%` })),
      h('span', {}, `${m.tasks.done} of ${plural(m.tasks.total, 'task')} done`)) : null,
    m.tasks.open.length && m.status === 'running' ? h('ul', { class: 'm-tasks' }, ...m.tasks.open.slice(0, 6).map((t) => h('li', {}, h('span', { class: `st ${t.status}` }, t.status === 'in_progress' ? 'in progress' : 'open'), `#${t.id} ${t.title}`, t.assignee ? h('small', {}, ` · ${t.assignee}`) : null))) : null,
    m.summary ? h('div', { class: 'm-summary' }, h('b', {}, 'Report'), h('p', {}, m.summary)) : null);
}

// ---------- wiring ----------

$('nav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('showTools').addEventListener('change', (ev) => $('feed').classList.toggle('hide-tools', !ev.target.checked));
$('gridBtn').addEventListener('click', () => {
  S.grid = !(S.view === 'agents' && S.grid);
  if (S.grid) S.only = null; // "All terminals" means all, except the ones hidden with "−"
  setView('agents');
});
$('gridShowAll').addEventListener('click', () => { S.only = null; S.hidden.clear(); layoutTerms(); });
$('selOpen').addEventListener('click', openTogether);
$('selStop').addEventListener('click', stopPicked);
$('selRemove').addEventListener('click', removePicked);
$('selClear').addEventListener('click', () => { S.picked.clear(); syncSelBar(); });
$('mapBtn').addEventListener('click', () => setView('map'));
$('changesRefresh').addEventListener('click', () => loadChanges());
$('missionForm').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  await api('POST', '/api/missions', { goal: $('missionGoal').value });
  $('missionGoal').value = '';
  toast('Mission started. The coordinator is planning it.');
}));
$('guardResume').addEventListener('click', guard(async () => { renderGuard(await api('POST', '/api/guard/resume')); }));
$('memMode').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-mode]'); if (b) setMemMode(b.dataset.mode); });
G.pz = panZoom($('gStage'), (G.view = { x: 0, y: 0, k: 1 }), applyGraphView, { min: 0.15, max: 5 });
$('gFit').addEventListener('click', fitGraph);
$('gIn').addEventListener('click', () => { if (G.view) { G.view.k = Math.min(5, G.view.k * 1.4); applyGraphView(); } });
$('gOut').addEventListener('click', () => { if (G.view) { G.view.k = Math.max(0.15, G.view.k / 1.4); applyGraphView(); } });
$('rpPlay').addEventListener('click', () => (RP.playing ? rpPause() : rpPlay()));
$('rpLive').addEventListener('click', () => { rpPause(); rpSeek(RP.to, false); });
$('rpSlider').addEventListener('input', () => { rpPause(); RP.shown = -1; rpSeek(rpAt(Number($('rpSlider').value)), false); });
$('replayRange').addEventListener('change', loadReplay);
$('rpTools').addEventListener('change', (ev) => $('replayFeed').classList.toggle('hide-tools', !ev.target.checked));
new ResizeObserver(() => { if (S.view === 'replay' && RP.names.length) { buildReplayGraph(); rpUpdate(RP.t, false); } }).observe($('replayStage'));
$('authSwitch').addEventListener('click', () => showAuth(authMode === 'login' ? 'signup' : 'login'));
$('aPass').addEventListener('input', pwHint);
for (const id of ['aFirst', 'aLast', 'aEmail', 'aPass']) $(id).addEventListener('input', () => authError('')); // an old error is no longer true once you type
$('aShow').addEventListener('click', () => {
  const show = $('aPass').type === 'password';
  $('aPass').type = show ? 'text' : 'password';
  setText($('aShow'), show ? 'Hide' : 'Show');
  $('aShow').setAttribute('aria-pressed', String(show));
});
$('authForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = { email: $('aEmail').value.trim(), password: $('aPass').value };
  if (authMode === 'signup') Object.assign(body, { firstName: $('aFirst').value, lastName: $('aLast').value });
  const missing = !body.email || !body.password || (authMode === 'signup' && (!body.firstName.trim() || !body.lastName.trim()));
  if (missing) return authError(authMode === 'signup' ? 'Fill in your name, email and password.' : 'Enter your email and password.');
  authError('');
  $('authGo').disabled = true;
  try {
    const { user } = await api('POST', `/api/auth/${authMode}`, body);
    $('aPass').value = '';
    enterApp(user);
  } catch (err) {
    authError(err.message);
    $('aPass').focus();
  } finally {
    $('authGo').disabled = false;
  }
});
$('guestGo').addEventListener('click', async () => {
  $('guestGo').disabled = true;
  try { enterApp((await api('POST', '/api/auth/guest')).user); } catch (err) { authError(err.message); } finally { $('guestGo').disabled = false; }
});
$('profileBtn').addEventListener('click', () => openSettings('profile'));
$('setNav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-tab]'); if (b) openSettings(b.dataset.tab); });
$('setClose').addEventListener('click', () => $('settingsDialog').close());
$('settingsDialog').addEventListener('click', (ev) => { if (ev.target === $('settingsDialog')) $('settingsDialog').close(); }); // a click on the dimmed area
$('signOut').addEventListener('click', guard(async () => { await api('POST', '/api/auth/logout', {}); location.reload(); }));
$('updateBtn').addEventListener('click', guard(async () => {
  await api('POST', '/api/restart', {});
  halt('Restarting UltraClaude', 'The new version opens in a new window in a moment. You can close this one.');
}));
$('newBtn').addEventListener('click', runUpdate);
setInterval(() => { if (!halted && !S.user?.guest) lookForUpdate(); }, 3600e3);
$('mapFilter').addEventListener('input', () => { syncBrain(); clearTimeout(S.searchTimer); S.searchTimer = setTimeout(() => { if (views) { views.table.offset = 0; views.bar(); views.refresh(); } }, 250); });
$('mapFilter').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && views?.view === 'brain') views.open('table'); });
document.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k' && S.view === 'map') { ev.preventDefault(); $('mapFilter').focus(); $('mapFilter').select(); } });
$('sideTabs').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-side]'); if (b) setSide(b.dataset.side); });
$('askForm').addEventListener('submit', (ev) => { ev.preventDefault(); sendAsk(); });
$('askInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendAsk(); } });
$('askNew').addEventListener('click', guard(async () => { await api('POST', '/api/brain/chat/new', {}); }));
$('noteFilter').addEventListener('input', renderNotes);
$('sessionsMore').addEventListener('click', () => { S.allSessions = !S.allSessions; renderSessions(); });
$('openObsidian').addEventListener('click', () => openInObsidian(S.note)); // the open note, or the project folder
$('openFolder').addEventListener('click', guard(() => api('POST', '/api/open-vault-folder', {})));
$('newNote').addEventListener('click', () => newNote());
$('newFolder').addEventListener('click', () => newFolder());
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
if (TOKEN) boot();
else halt('Start UltraClaude from your terminal', 'Go to your project folder and run “ultraclaude”.');

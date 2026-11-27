// Local web server: UI, REST API, terminal WebSocket, MCP endpoint and hook endpoint.
// Only listens on 127.0.0.1 and every non-static route needs the per-server token.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Project } from './project.js';
import { ROLES } from './roles.js';
import { KNOWLEDGE } from './vault.js';
import { claudeProjectDir, listAllProjects } from './history.js';
import { codeVersion } from './version.js';
import { handleMcp } from './mcp.js';
import { loadConfig, HOME_DIR } from './config.js';
import { Profile } from './profile.js';
import { usageReport } from './usage.js';
import { Guard } from './guard.js';
import * as git from './git.js';
import { missionViews, startMission, stopMission } from './missions.js';
import { FileIndex } from './fileindex.js';
import { BrainChat } from './brainchat.js';
import * as bq from './brainquery.js';
import { checkUpdate, installUpdate } from './update.js';

const RANGES = ['today', '7d', '30d', 'all'];
// What the browser may load: only this server. Inline styles are needed by the terminal and the graph.
const SECURITY = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const font = (family, weight) => `node_modules/@fontsource/ibm-plex-${family}/files/ibm-plex-${family}-latin-${weight}-normal.woff2`;
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/plex-sans-400.woff2': font('sans', 400),
  '/vendor/plex-sans-500.woff2': font('sans', 500),
  '/vendor/plex-sans-600.woff2': font('sans', 600),
  '/vendor/plex-mono-400.woff2': font('mono', 400),
  '/vendor/plex-mono-500.woff2': font('mono', 500),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('The image is too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function openExternal(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Whether Obsidian already knows a vault that contains `dir` (only then can we deep-link into it). */
function knownToObsidian(dir) {
  const configDir = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'obsidian')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'obsidian')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'obsidian');
  try {
    const { vaults = {} } = JSON.parse(fs.readFileSync(path.join(configDir, 'obsidian.json'), 'utf8'));
    const norm = (p) => path.resolve(p).toLowerCase();
    return Object.values(vaults).some((v) => v.path && (norm(dir) === norm(v.path) || norm(dir).startsWith(norm(v.path) + path.sep)));
  } catch {
    return false;
  }
}

export async function startServer({ dir, port = 0, vaultPath = loadConfig().vaultPath, autoExit = false, profileFile = path.join(HOME_DIR, 'profile.json') } = {}) {
  const project = new Project({ dir, vaultPath });
  const profile = new Profile(profileFile);
  const token = crypto.randomBytes(18).toString('hex'); // in the window's address; every API call needs it
  const version = process.env.ULTRACLAUDE_TEST_VERSION || codeVersion(); // the code this server runs
  const clients = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  };
  const noteCount = () => project.vault.list(KNOWLEDGE).length;

  project.on('agents', (agents) => broadcast({ t: 'agents', agents }));
  project.on('tasks', (tasks) => broadcast({ t: 'tasks', tasks }));
  project.on('event', (e) => broadcast({ t: 'event', e }));
  project.on('notes', () => broadcast({ t: 'notes', count: noteCount() }));
  project.on('pty', (id, d) => broadcast({ t: 'out', id, d }));
  project.on('sessions', () => broadcast({ t: 'sessions', sessions: project.sessions() }));
  project.on('missions', (missions) => broadcast({ t: 'missions', missions }));
  project.on('missionTasks', () => { if (project.state.missions?.length) broadcast({ t: 'missions', missions: missionViews(project) }); });
  // the cost guard lives next to the profile, so tests with their own profile file get their own guard
  const costGuard = new Guard({ file: path.join(path.dirname(profileFile), 'guard.json'), project, report: () => usageReport({ range: 'today', blockLimit: costGuard.config.limit }) });
  costGuard.on('change', (guard) => broadcast({ t: 'guard', guard }));
  // the brain: an index of all file names on this computer, and a Claude chat that finds and sorts them
  const fileIndex = new FileIndex({ journal: path.join(path.dirname(profileFile), 'brain-moves.jsonl') });
  const brainTags = new bq.Tags(path.join(path.dirname(profileFile), 'brain-tags.json'));
  const brainChat = new BrainChat({ index: fileIndex, endpoint: () => project.endpoint, dataDir: project.dataDir, tags: brainTags });
  brainChat.on('view', (view) => broadcast({ t: 'brainview', view }));
  fileIndex.on('status', (status) => broadcast({ t: 'brainindex', status }));
  brainChat.on('item', (item) => broadcast({ t: 'brainchat', item }));
  brainChat.on('busy', (busy) => broadcast({ t: 'brainbusy', busy }));
  brainChat.on('reset', () => broadcast({ t: 'brainreset' }));
  brainChat.on('show', (show) => broadcast({ t: 'brainshow', ...show }));

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY, ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  let closing = false;
  let guardTimer = null;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(guardTimer);
    brainChat.stop();
    project.stopAll();
    project.saveNow();
    for (const ws of clients) ws.terminate();
    try { fs.unlinkSync(path.join(project.dataDir, 'server.json')); } catch { /* not written */ }
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); // a half-read answer must not keep it open
  };

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/profile') return send(res, 200, { user: profile.view(), suggest: profile.view() ? null : profile.suggestion(), version });
    if (route === 'POST /api/profile') return send(res, 200, { user: profile.save(await readBody(req)) });
    if (route === 'PATCH /api/profile/prefs') {
      const b = await readBody(req);
      const user = profile.setPrefs(b);
      if (b.blockLimit !== undefined) await costGuard.update({ limit: user.prefs.blockLimit }).catch(() => {}); // the window limit is the guard's limit too
      return send(res, 200, { user });
    }
    if (route === 'GET /api/update') return send(res, 200, await checkUpdate({ fresh: url.searchParams.get('fresh') === '1' }));
    if (route === 'POST /api/update') {
      return send(res, 200, await installUpdate());
    }
    if (route === 'GET /api/graph') return send(res, 200, project.vault.graph());
    if (url.pathname === '/api/changes' || url.pathname.startsWith('/api/changes/')) {
      // what the agents changed in git: worktrees, diffs, and bringing the work home
      if (route === 'GET /api/changes') {
        if (!(await git.isRepo(project.dir))) return send(res, 200, { repo: false });
        const list = await Promise.all((await git.worktrees(project.dir)).map((w) => git.changes(project.dir, w.path)));
        const owner = (w) => project.state.agents.find((a) => a.worktree && `${w.path} ${w.branch}`.includes(`uc-${a.id}`))?.name || '';
        return send(res, 200, { repo: true, worktrees: list.map((w) => ({ ...w, agent: w.main ? '' : owner(w) })) });
      }
      if (route === 'GET /api/changes/diff') return send(res, 200, await git.diff(project.dir, url.searchParams.get('path')));
      const b = await readBody(req);
      if (route === 'POST /api/changes/commit') { await git.commitAll(project.dir, b.path, b.message); project.event('git', 'user', `committed in ${path.basename(String(b.path))}: ${b.message || 'Work from UltraClaude'}`); return send(res, 200, { ok: true }); }
      if (route === 'POST /api/changes/merge') { const r = await git.merge(project.dir, b.path); project.event('git', 'user', `merged ${path.basename(String(b.path))} into ${r.into}`); return send(res, 200, r); }
      if (route === 'POST /api/changes/pr') { const r = await git.pullRequest(project.dir, b.path); project.event('git', 'user', `opened a pull request: ${r.url}`); return send(res, 200, r); }
      return send(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/api/brain' || url.pathname.startsWith('/api/brain/')) {
      if (route === 'GET /api/brain') {
        if (fileIndex.state === 'idle') fileIndex.build(); // the first look starts the walk in the background
        return send(res, 200, fileIndex.state === 'ready' ? fileIndex.payload() : fileIndex.status());
      }
      if (route === 'GET /api/brain/chat') return send(res, 200, brainChat.view());
      if (route === 'GET /api/brain/saved') return send(res, 200, { tags: brainTags.all(), views: brainTags.data.views, types: bq.TYPES, dimensions: bq.DIMENSIONS });
      const ask = /^\/api\/brain\/(table|points|pivot|timeline|storage|duplicates)$/.exec(url.pathname);
      if (req.method === 'POST' && ask) {
        if (fileIndex.state !== 'ready') return send(res, 409, { error: 'The files are still being read. One moment.' });
        return send(res, 200, { ...bq[ask[1]](fileIndex, brainTags, await readBody(req)), measured: fileIndex.measured });
      }
      const b = await readBody(req);
      if (route === 'POST /api/brain/rescan') { if (fileIndex.state !== 'indexing') fileIndex.build(); return send(res, 200, fileIndex.status()); }
      if (route === 'POST /api/brain/chat') {
        const problem = brainChat.problem(b.text);
        if (problem) return send(res, 400, { error: problem });
        brainChat.send(b.text).catch((err) => project.event('error', 'Brain', err.message));
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/brain/chat/new') { brainChat.reset(); return send(res, 200, { ok: true }); }
      const plan = /^\/api\/brain\/plans\/([0-9a-f-]+)\/(apply|discard|undo)$/.exec(url.pathname);
      if (req.method === 'POST' && plan) {
        const p = plan[2] === 'discard' ? brainChat.discard(plan[1]) : await brainChat[plan[2]](plan[1]);
        if (plan[2] !== 'discard') project.event('memory', 'user', `${plan[2] === 'apply' ? 'sorted' : 'put back'} ${p.moves.length} ${p.moves.length === 1 ? 'file' : 'files'} in the brain`, { op: 'write' });
        return send(res, 200, p);
      }
      if (route === 'POST /api/brain/export') return send(res, 200, { csv: bq.csv(fileIndex, brainTags, b) });
      if (route === 'POST /api/brain/plan') {
        const moves = bq.organize(fileIndex, brainTags, b);
        return send(res, 200, brainChat.propose(moves, b.reason || (b.by ? `Sorted by ${b.by}.` : 'Moved from the table.')));
      }
      if (route === 'POST /api/brain/tags') { brainTags.change((Array.isArray(b.paths) ? b.paths : []).map(String).filter((p) => fileIndex.allowed(p)), b.add, b.remove); return send(res, 200, { tags: brainTags.all() }); }
      if (route === 'POST /api/brain/views') { if (b.remove) brainTags.removeView(String(b.remove)); else brainTags.saveView(b); return send(res, 200, { views: brainTags.data.views }); }
      if (route === 'POST /api/brain/preview') {
        const target = String(b.path || '');
        if (!fileIndex.allowed(target) || !fs.existsSync(target)) return send(res, 400, { error: 'That is not a file the brain knows.' });
        return send(res, 200, bq.preview(target));
      }
      if (route === 'POST /api/brain/open') {
        const target = String(b.path || '');
        if (!fileIndex.allowed(target) || !fs.existsSync(target)) return send(res, 400, { error: 'That is not a file the brain knows.' });
        openExternal(fs.statSync(target).isDirectory() ? target : path.dirname(target));
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (route === 'POST /api/missions' || /^\/api\/missions\/[0-9a-f]+\/stop$/.test(url.pathname)) {
      if (route === 'POST /api/missions') return send(res, 200, startMission(project, await readBody(req)));
      return send(res, 200, stopMission(project, url.pathname.split('/')[3]));
    }
    if (route === 'GET /api/guard') return send(res, 200, costGuard.view());
    if (route === 'PATCH /api/guard' || route === 'POST /api/guard/resume') {
      return send(res, 200, route === 'PATCH /api/guard' ? await costGuard.update(await readBody(req)) : await costGuard.resume());
    }
    if (route === 'GET /api/replay') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const events = project.recorded({ since, limit: 8000 });
      return send(res, 200, { events, first: events[0]?.ts ?? null, last: events.at(-1)?.ts ?? null, now: Date.now() });
    }
    if (route === 'GET /api/usage') {
      const range = RANGES.includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '30d';
      return send(res, 200, await usageReport({ range, blockLimit: profile.view()?.prefs.blockLimit ?? null, fresh: url.searchParams.get('fresh') === '1' }));
    }
    const paste = req.method === 'POST' && /^\/api\/agents\/([^/]+)\/paste-image$/.exec(url.pathname);
    if (paste) {
      if (!project.agent(paste[1])) return send(res, 404, { error: 'Agent not found' });
      const file = project.pasteImage(paste[1], await readRaw(req, 25_000_000), req.headers['content-type']);
      return send(res, 200, { path: file });
    }
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    // files and folders of the vault, edited by the person in the Memory view
    const changed = (text, extra = {}) => { project.emit('notes'); project.event('memory', 'user', text, { op: 'write', ...extra }); };
    const label = (p) => `“${String(p).split('/').pop().replace(/\.md$/i, '')}”`;
    if (route === 'GET /api/tree') return send(res, 200, { tree: project.vault.tree(), project: project.vault.rel(project.vault.projectDir) });
    if (route === 'GET /api/file') return send(res, 200, project.vault.readRaw(url.searchParams.get('path')));
    if (route === 'POST /api/file') { const r = project.vault.saveRaw(body.path, body.content, { create: true }); changed(`wrote ${label(r.path)} into memory`, { path: r.path }); return send(res, 200, r); }
    if (route === 'PUT /api/file') { const r = project.vault.saveRaw(body.path, body.content); changed(`edited ${label(r.path)} in memory`, { path: r.path }); return send(res, 200, r); }
    if (route === 'POST /api/file/move') { const r = project.vault.move(body.from, body.to); changed(`moved ${label(body.from)} to ${r.path}`, { path: r.path }); return send(res, 200, r); }
    if (route === 'POST /api/file/copy') { const r = project.vault.copy(body.from, body.to); changed(`copied ${label(body.from)} to ${r.path}`, { path: r.path }); return send(res, 200, r); }
    if (route === 'DELETE /api/file') { const r = project.vault.remove(url.searchParams.get('path')); changed(`deleted ${label(r.path)} from memory`); return send(res, 200, r); }
    if (route === 'POST /api/folder') { const r = project.vault.makeFolder(body.path); changed(`made the folder ${r.path} in memory`); return send(res, 200, r); }
    const idMatch = /^\/api\/(agents|tasks)\/([^/]+)(?:\/(start|stop))?$/.exec(url.pathname);

    if (route === 'GET /api/state') {
      project.syncClaudeCode();
      return send(res, 200, {
        project: { name: project.name, dir: project.dir, vault: project.vault.root, inObsidian: knownToObsidian(project.vault.root) },
        roles: ROLES.map(({ prompt, ...r }) => r),
        agents: project.views(), tasks: project.state.tasks, events: project.events.slice(-150), notes: noteCount(), sessions: project.sessions(),
        version, latest: codeVersion(), guard: costGuard.view(), missions: missionViews(project),
      });
    }
    if (route === 'POST /api/agents') return send(res, 200, project.createAgent(body));
    if (idMatch?.[1] === 'agents') {
      const id = idMatch[2];
      if (!project.agent(id)) return send(res, 404, { error: 'Agent not found' });
      if (req.method === 'POST' && idMatch[3] === 'start') { await project.startAgent(id, body); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && idMatch[3] === 'stop') { project.stopAgent(id); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { project.removeAgent(id); return send(res, 200, { ok: true }); }
    }
    if (route === 'POST /api/message') return send(res, 200, { result: project.sendMessage('user', body.to, body.text) });
    if (route === 'POST /api/tasks') return send(res, 200, project.createTask('user', body));
    if (idMatch?.[1] === 'tasks') {
      if (req.method === 'PATCH') return send(res, 200, project.updateTask('user', idMatch[2], body));
      if (req.method === 'DELETE') { project.deleteTask(idMatch[2]); return send(res, 200, { ok: true }); }
    }
    if (route === 'GET /api/chats') {
      // every Claude Code chat on this computer, by folder, for the map behind the "ultraclaude" mark
      const here = path.basename(claudeProjectDir(project.dir));
      const open = new Set(project.state.agents.map((a) => a.sessionId));
      const projects = listAllProjects().map((pr) => ({
        ...pr,
        dir: pr.key === here ? project.dir : pr.dir,
        name: pr.key === here ? project.name : pr.name,
        current: pr.key === here,
        sessions: pr.sessions.map(({ cwd, ...s }) => ({ ...s, open: pr.key === here && open.has(s.id) })),
      }));
      return send(res, 200, { projects });
    }
    if (route === 'GET /api/dirs') {
      // the subfolders of one folder, for the map; hidden and system folders and dependency folders are left out
      const dir = String(url.searchParams.get('path') || '');
      if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 404, { error: 'That folder does not exist.' });
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return send(res, 200, { dirs: [], unreadable: true }); }
      const skip = /^[.$]|^(System Volume Information|node_modules|__pycache__)$/i;
      const dirs = entries.filter((e) => e.isDirectory() && !skip.test(e.name)).map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 500);
      return send(res, 200, { dirs });
    }
    if (route === 'POST /api/open-project') {
      // starts (or shows) UltraClaude for another folder, in its own window
      const dir = String(body.dir || '');
      if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'That folder does not exist any more.' });
      spawn(process.execPath, [path.join(ROOT, 'bin', 'ultraclaude.js')], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /api/notes') { project.syncClaudeCode(); return send(res, 200, project.vault.list()); }
    if (route === 'GET /api/note') {
      const note = project.vault.read(url.searchParams.get('path'));
      return note ? send(res, 200, note) : send(res, 404, { error: 'Note not found' });
    }
    if (route === 'POST /api/open-obsidian') {
      // Obsidian can only open paths inside a vault it already knows; otherwise show the folder to pick.
      const known = knownToObsidian(project.vault.root);
      const target = body.path ? project.vault.abs(body.path) : project.vault.projectDir;
      openExternal(known ? `obsidian://open?path=${encodeURIComponent(target)}` : project.vault.root);
      return send(res, 200, { known });
    }
    if (route === 'POST /api/open-vault-folder') { openExternal(project.vault.root); return send(res, 200, { ok: true }); }
    if (route === 'POST /api/restart') {
      // The command line notices that this server is out of date, restarts it with the new code,
      // lets the running agents continue their sessions and opens a new window.
      spawn(process.execPath, [path.join(ROOT, 'bin', 'ultraclaude.js')], { cwd: project.dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/shutdown') {
      send(res, 200, { ok: true });
      return void setTimeout(() => close().then(() => process.exit(0)), 100);
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host || '').split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] === 'hook' || parts[0] === 'mcp') {
        if (parts[1] !== token) return send(res, 403, { error: 'Forbidden' });
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        const body = await readBody(req);
        const out = parts[0] === 'hook' ? project.handleHook(parts[2], body) : parts[2] === 'brain' ? brainChat.mcp(body) : handleMcp(project, parts[2], body);
        return out ? send(res, 200, out) : send(res, parts[0] === 'mcp' ? 202 : 200);
      }
      if (parts[0] === 'api') {
        if (url.pathname === '/api/ping') return send(res, 200, { ok: true, dir: project.dir, version });
        if (req.headers['x-uc-token'] !== token) return send(res, 403, { error: 'Forbidden' });
        return await api(req, res, url);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const file = VENDOR[url.pathname] ? path.join(ROOT, VENDOR[url.pathname])
        : path.join(PUBLIC, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^([/\\]|\.\.)+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
      const isFont = file.endsWith('.woff2');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': isFont ? 'max-age=604800' : 'no-store', ...SECURITY });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (res.headersSent) return;
      send(res, 400, { error: err.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = (req.headers.host || '').split(':')[0];
    // only this server's own page may connect: it knows the address secret, and the Origin check stops other websites
    if (url.pathname !== '/ws' || url.searchParams.get('t') !== token || !['127.0.0.1', 'localhost'].includes(host) || req.headers.origin !== `http://${req.headers.host}`) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      for (const [id, r] of project.runtime) if (r.buffer) ws.send(JSON.stringify({ t: 'replay', id, d: r.buffer }));
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'in') project.write(m.id, m.d);
        else if (m.t === 'resize') project.resize(m.id, m.cols, m.rows);
      });
      ws.on('close', () => clients.delete(ws));
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  project.endpoint = { port: actualPort, token };
  // Agents that were running when the previous server was replaced by an update continue right away.
  const resume = project.state.agents.filter((a) => a.resumeOnStart);
  for (const a of resume) {
    delete a.resumeOnStart;
    project.startAgent(a.id).catch((err) => project.event('error', a.name, `failed to start: ${err.message}`));
  }
  if (resume.length) project.save();
  guardTimer = setInterval(() => costGuard.tick(), 60_000);
  guardTimer.unref();
  setTimeout(() => { if (!closing) costGuard.tick(); }, 5_000).unref();
  const info = { port: actualPort, token, pid: process.pid, url: `http://127.0.0.1:${actualPort}/?t=${token}` };
  fs.writeFileSync(path.join(project.dataDir, 'server.json'), JSON.stringify(info), { mode: 0o600 });

  if (autoExit) {
    // Stop the background server once the window is closed and no agent is running any more.
    let idleSince = Date.now();
    setInterval(() => {
      if (clients.size || project.running()) idleSince = Date.now();
      else if (Date.now() - idleSince > 60_000) close().then(() => process.exit(0));
    }, 10_000).unref();
  }

  return { ...info, project, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.platform === 'win32' && process.argv.includes('--background') && !process.argv.includes('--has-console')) {
    // Started in the background, this process has no console at all. On Windows every helper
    // it launches (where.exe, node-pty's process lister) would then pop up its own terminal
    // window for a moment. So run the real server as a child that owns one hidden console,
    // which all of its helpers inherit.
    const child = spawn(process.execPath, [...process.argv.slice(1), '--has-console'], { stdio: 'inherit', windowsHide: true });
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    const app = await startServer({ dir: arg('--dir') || process.cwd(), autoExit: true });
    console.log(`UltraClaude server for ${app.project.dir} on ${app.url}`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
  }
}

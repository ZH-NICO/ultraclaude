// Local web server: UI, REST API, terminal WebSocket, MCP endpoint and hook endpoint.
// Only listens on 127.0.0.1 and every non-static route needs the per-server token.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Project } from './project.js';
import { ROLES } from './roles.js';
import { handleMcp } from './mcp.js';
import { loadConfig } from './config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

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

function openExternal(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function startServer({ dir, port = 0, vaultPath = loadConfig().vaultPath, autoExit = false } = {}) {
  const project = new Project({ dir, vaultPath });
  const token = crypto.randomBytes(18).toString('hex');
  const clients = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  };

  project.on('agents', (agents) => broadcast({ t: 'agents', agents }));
  project.on('tasks', (tasks) => broadcast({ t: 'tasks', tasks }));
  project.on('event', (e) => broadcast({ t: 'event', e }));
  project.on('notes', () => broadcast({ t: 'notes' }));
  project.on('pty', (id, d) => broadcast({ t: 'out', id, d }));

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    project.stopAll();
    project.saveNow();
    for (const ws of clients) ws.terminate();
    try { fs.unlinkSync(path.join(project.dataDir, 'server.json')); } catch { /* not written */ }
    await new Promise((r) => server.close(r));
  };

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const idMatch = /^\/api\/(agents|tasks)\/([^/]+)(?:\/(start|stop))?$/.exec(url.pathname);

    if (route === 'GET /api/state') {
      return send(res, 200, {
        project: { name: project.name, dir: project.dir, vault: project.vault.root, vaultProject: project.vault.rel(project.vault.projectDir) },
        roles: ROLES.map(({ prompt, ...r }) => r),
        agents: project.views(), tasks: project.state.tasks, events: project.events.slice(-150),
      });
    }
    if (route === 'POST /api/agents') return send(res, 200, project.createAgent(body));
    if (idMatch?.[1] === 'agents') {
      const id = idMatch[2];
      if (!project.agent(id)) return send(res, 404, { error: 'Agent nicht gefunden' });
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
    if (route === 'GET /api/notes') return send(res, 200, project.vault.list());
    if (route === 'GET /api/note') {
      const note = project.vault.read(url.searchParams.get('path'));
      return note ? send(res, 200, note) : send(res, 404, { error: 'Notiz nicht gefunden' });
    }
    if (route === 'POST /api/open-obsidian') {
      const target = body.path ? project.vault.abs(body.path) : project.vault.projectDir;
      openExternal(`obsidian://open?path=${encodeURIComponent(target)}`);
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/open-vault-folder') { openExternal(project.vault.root); return send(res, 200, { ok: true }); }
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
        const out = parts[0] === 'hook' ? project.handleHook(parts[2], body) : handleMcp(project, parts[2], body);
        return out ? send(res, 200, out) : send(res, parts[0] === 'mcp' ? 202 : 200);
      }
      if (parts[0] === 'api') {
        if (url.pathname === '/api/ping') return send(res, 200, { ok: true, dir: project.dir });
        if (req.headers['x-uc-token'] !== token) return send(res, 403, { error: 'Forbidden' });
        return await api(req, res, url);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const file = VENDOR[url.pathname] ? path.join(ROOT, VENDOR[url.pathname])
        : path.join(PUBLIC, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^([/\\]|\.\.)+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (!res.headersSent) send(res, 400, { error: err.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = (req.headers.host || '').split(':')[0];
    if (url.pathname !== '/ws' || url.searchParams.get('t') !== token || !['127.0.0.1', 'localhost'].includes(host)) return socket.destroy();
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
  const info = { port: actualPort, token, pid: process.pid, url: `http://127.0.0.1:${actualPort}/?t=${token}` };
  fs.writeFileSync(path.join(project.dataDir, 'server.json'), JSON.stringify(info));

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
  const app = await startServer({ dir: arg('--dir') || process.cwd(), autoExit: true });
  console.log(`UltraClaude server for ${app.project.dir} on ${app.url}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}

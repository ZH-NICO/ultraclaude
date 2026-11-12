// One UltraClaude project: the agents (Claude Code processes in pseudo terminals),
// their messages, the task board and the activity feed.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { roleById, buildPrompt } from './roles.js';

const HOOK_SCRIPT = fileURLToPath(new URL('./hook.js', import.meta.url)).replace(/\\/g, '/');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
const BUFFER_MAX = 400_000;
const TASK_STATES = ['todo', 'in_progress', 'done'];

function resolveClaude() {
  if (process.env.ULTRACLAUDE_CLAUDE) return process.env.ULTRACLAUDE_CLAUDE;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.cmd$/i.test(l)) || lines[0] || 'claude';
  } catch {
    return 'claude';
  }
}

const base = (f) => (f ? String(f).split(/[\\/]/).pop() : '');
const short = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function describeTool(name, input = {}) {
  if (name?.startsWith('mcp__ultraclaude__')) {
    const t = name.slice('mcp__ultraclaude__'.length);
    return ({
      send_message: `schreibt an ${input.to || '?'}`,
      read_messages: 'liest Nachrichten',
      list_agents: 'schaut, was das Team macht',
      set_status: 'aktualisiert Status',
      memory_search: `durchsucht Memory: ${short(input.query, 40)}`,
      memory_read: `liest Memory: ${short(input.note, 40)}`,
      memory_write: `speichert Memory: ${short(input.title, 40)}`,
      memory_list: 'listet Memory',
      task_list: 'liest Aufgaben',
      task_create: `erstellt Aufgabe: ${short(input.title, 40)}`,
      task_update: `aktualisiert Aufgabe #${input.id ?? '?'}`,
    })[t] || t;
  }
  switch (name) {
    case 'Read': return `liest ${base(input.file_path)}`;
    case 'Edit': case 'Write': case 'NotebookEdit': return `bearbeitet ${base(input.file_path || input.notebook_path)}`;
    case 'Bash': case 'PowerShell': return `$ ${short(input.command)}`;
    case 'Grep': case 'Glob': return `sucht ${short(input.pattern, 40)}`;
    case 'Agent': case 'Task': return `Subagent: ${short(input.description, 40)}`;
    case 'WebFetch': return `Web: ${short(input.url, 50)}`;
    case 'WebSearch': return `Websuche: ${short(input.query, 40)}`;
    default: return name?.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : String(name || 'arbeitet');
  }
}

export class Project extends EventEmitter {
  constructor({ dir, vaultPath }) {
    super();
    this.dir = path.resolve(dir);
    this.name = path.basename(this.dir) || 'project';
    this.dataDir = path.join(this.dir, '.ultraclaude');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.vault = new Vault(vaultPath, this.name);
    this.runtime = new Map(); // agentId -> { state, activity, pty, buffer, ... }
    this.events = [];
    this.endpoint = null; // { port, token } once the server listens
    this.state = { agents: [], tasks: [], messages: [], nextTaskId: 1 };

    fs.mkdirSync(this.dataDir, { recursive: true });
    const ignore = path.join(this.dataDir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    if (fs.existsSync(this.stateFile)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch { /* start fresh on a corrupt file */ }
    }
    this.vault.ensure(this.dir);
    for (const a of this.state.agents) this.runtime.set(a.id, this.#freshRuntime());
  }

  // ---------- state helpers ----------

  #freshRuntime() {
    return { state: 'stopped', activity: '', statusText: '', toolCount: 0, lastActive: 0, pty: null, buffer: '', pendingPrompt: '', startedAt: 0 };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  agent(ref) {
    const key = String(ref ?? '').trim().toLowerCase();
    return this.state.agents.find((a) => a.id === ref || a.name.toLowerCase() === key);
  }

  view(a) {
    const r = this.runtime.get(a.id);
    return {
      id: a.id, name: a.name, roleId: a.roleId, roleName: a.roleName, icon: a.icon, color: a.color,
      model: a.model, permissionMode: a.permissionMode, worktree: a.worktree,
      state: r.state, activity: r.activity, statusText: r.statusText, toolCount: r.toolCount, lastActive: r.lastActive,
      unread: this.state.messages.filter((m) => m.to === a.id && !m.delivered).length,
    };
  }

  views() { return this.state.agents.map((a) => this.view(a)); }
  running() { return [...this.runtime.values()].filter((r) => r.pty).length; }

  #changed(a) {
    this.emit('agents', this.views());
    if (a) { try { this.vault.writeAgentNote(this.view(a)); } catch { /* vault unavailable */ } }
  }

  event(type, agent, text, extra = {}) {
    const e = { id: crypto.randomUUID(), ts: Date.now(), type, agent, text: short(text, 400), ...extra };
    this.events.push(e);
    if (this.events.length > 300) this.events.shift();
    this.emit('event', e);
    if (type !== 'tool') { try { this.vault.log(agent, extra.to ? `→ ${extra.to}: ${text}` : text); } catch { /* vault unavailable */ } }
    return e;
  }

  // ---------- agents ----------

  createAgent({ roleId = 'custom', name, instructions = '', model = '', permissionMode = '', worktree = false, prompt = '' }) {
    const role = roleById(roleId);
    let wanted = short(name || (role.id === 'custom' ? 'Agent' : role.name), 40).replace(/["\r\n]/g, '');
    let unique = wanted;
    for (let i = 2; this.agent(unique) || ['user', 'all', 'alle'].includes(unique.toLowerCase()); i++) unique = `${wanted} ${i}`;
    const a = {
      id: crypto.randomBytes(4).toString('hex'), name: unique, roleId: role.id,
      roleName: role.id === 'custom' ? unique : role.name, icon: role.icon, color: role.color,
      instructions: String(instructions).trim(), model, permissionMode, worktree: !!worktree,
      sessionId: crypto.randomUUID(), started: false, createdAt: Date.now(),
    };
    this.state.agents.push(a);
    this.runtime.set(a.id, this.#freshRuntime());
    this.save();
    this.startAgent(a.id, { prompt }).catch((err) => this.event('error', a.name, `Start fehlgeschlagen: ${err.message}`));
    return this.view(a);
  }

  async startAgent(id, { prompt = '', cols = 120, rows = 32 } = {}) {
    const a = this.agent(id);
    const r = this.runtime.get(id);
    if (!a || r.pty) return;
    if (!this.endpoint) throw new Error('Server is not listening yet');
    const { port, token } = this.endpoint;
    const pty = (await import('@lydell/node-pty')).default;

    const dir = path.join(this.dataDir, 'agents', a.id);
    fs.mkdirSync(dir, { recursive: true });
    const mcpFile = path.join(dir, 'mcp.json');
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ultraclaude: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}/${a.id}` } } }, null, 2));
    const hook = [{ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT}"`, timeout: 10 }] }];
    fs.writeFileSync(settingsFile, JSON.stringify({
      permissions: { allow: ['mcp__ultraclaude'] },
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook])),
    }, null, 2));

    const resumed = a.started;
    const args = [
      '--append-system-prompt', buildPrompt({ agent: a, project: this.name, vaultPath: this.vault.root }),
      '--mcp-config', mcpFile, '--settings', settingsFile, '--add-dir', this.vault.root, '-n', a.name,
      ...(resumed ? ['--resume', a.sessionId] : ['--session-id', a.sessionId]),
      ...(a.model ? ['--model', a.model] : []),
      ...(a.permissionMode ? ['--permission-mode', a.permissionMode] : []),
      ...(a.worktree ? ['--worktree', `uc-${a.id}`] : []),
    ];
    const env = { ...process.env, ULTRACLAUDE_HOOK_URL: `http://127.0.0.1:${port}/hook/${token}/${a.id}`, ULTRACLAUDE_AGENT: a.name };
    // If UltraClaude itself was launched from inside a Claude Code session, don't pass that session's markers on.
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID']) delete env[k];

    let file = resolveClaude();
    let argv = args;
    if (/\.(cmd|bat)$/i.test(file)) { argv = ['/c', file, ...args]; file = 'cmd.exe'; }

    Object.assign(r, { state: 'starting', activity: 'startet…', buffer: '', pendingPrompt: prompt, startedAt: Date.now() });
    try {
      r.pty = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: this.dir, env });
    } catch (err) {
      Object.assign(r, { state: 'stopped', activity: '' });
      this.event('error', a.name, `Start fehlgeschlagen: ${err.message}`);
      this.#changed(a);
      return;
    }
    r.pty.onData((d) => {
      r.buffer += d;
      if (r.buffer.length > BUFFER_MAX) r.buffer = r.buffer.slice(-BUFFER_MAX / 2);
      this.emit('pty', a.id, d);
    });
    r.pty.onExit(() => {
      const quick = Date.now() - r.startedAt < 8000;
      r.pty = null;
      Object.assign(r, { state: 'stopped', activity: '' });
      if (resumed && quick) {
        // The saved session could not be resumed; the next start gets a new one.
        a.started = false;
        a.sessionId = crypto.randomUUID();
        this.save();
      }
      if (this.agent(a.id)) { this.event('stop', a.name, 'wurde beendet'); this.#changed(a); }
    });
    this.event('start', a.name, resumed ? 'setzt Session fort' : `ist als ${a.roleName} gestartet`);
    this.#changed(a);
  }

  stopAgent(id) {
    const r = this.runtime.get(id);
    if (r?.pty) { try { r.pty.kill(); } catch { /* already gone */ } }
  }

  removeAgent(id) {
    const a = this.agent(id);
    if (!a) return;
    this.state.agents = this.state.agents.filter((x) => x.id !== id);
    this.stopAgent(id);
    this.runtime.delete(id);
    this.state.messages = this.state.messages.filter((m) => m.to !== id);
    this.save();
    this.event('stop', a.name, 'wurde entfernt');
    this.emit('agents', this.views());
  }

  stopAll() { for (const a of this.state.agents) this.stopAgent(a.id); }

  write(id, data) { this.runtime.get(id)?.pty?.write(data); }

  resize(id, cols, rows) {
    const p = this.runtime.get(id)?.pty;
    if (p && cols > 1 && rows > 1) { try { p.resize(Math.floor(cols), Math.floor(rows)); } catch { /* pty closed */ } }
  }

  /** Types a prompt into an idle agent's terminal and submits it. */
  inject(id, text) {
    const r = this.runtime.get(id);
    if (!r?.pty) return false;
    r.state = 'working';
    r.pty.write(String(text).replace(/\s*\r?\n\s*/g, ' ').trim());
    setTimeout(() => r.pty?.write('\r'), 500);
    return true;
  }

  // ---------- messages ----------

  sendMessage(from, to, text) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('message is empty');
    const target = String(to ?? '').trim();
    if (target.toLowerCase() === 'user') {
      this.event('notify', from, body, { to: 'user' });
      return 'Der User sieht die Nachricht im Dashboard.';
    }
    const everyone = ['all', 'alle', '*'].includes(target.toLowerCase());
    const recipients = everyone ? this.state.agents.filter((a) => a.name !== from) : [this.agent(target)].filter(Boolean);
    if (!recipients.length) {
      throw new Error(everyone ? 'Es gibt keine anderen Agents.' : `Kein Agent "${target}". Vorhanden: ${this.state.agents.map((a) => a.name).join(', ') || 'keine'}`);
    }
    for (const a of recipients) {
      this.state.messages.push({ id: crypto.randomUUID(), from, to: a.id, text: body, ts: Date.now(), delivered: false });
    }
    if (this.state.messages.length > 500) this.state.messages = this.state.messages.slice(-500);
    this.save();
    this.event('message', from, body, { to: everyone ? 'all' : recipients[0].name });
    for (const a of recipients) this.#deliverIfIdle(a);
    this.emit('agents', this.views());
    return `Gesendet an ${recipients.map((a) => a.name).join(', ')}.`;
  }

  /** Marks an agent's unread messages as delivered and returns them as prompt text ('' if none). */
  takeUnread(id) {
    const unread = this.state.messages.filter((m) => m.to === id && !m.delivered);
    if (!unread.length) return '';
    for (const m of unread) m.delivered = true;
    this.save();
    return unread.map((m) => `[UltraClaude message] from ${m.from}: ${m.text}`).join('\n');
  }

  #deliverIfIdle(a) {
    const r = this.runtime.get(a.id);
    if (r?.pty && r.state === 'idle') {
      const text = this.takeUnread(a.id);
      if (text) this.inject(a.id, text);
    }
  }

  // ---------- tasks ----------

  #tasksChanged() {
    this.save();
    this.emit('tasks', this.state.tasks);
    try { this.vault.writeBoard(this.state.tasks); } catch { /* vault unavailable */ }
  }

  createTask(by, { title, description = '', assignee = '' }) {
    if (!String(title ?? '').trim()) throw new Error('title is required');
    const who = assignee ? this.agent(assignee) : null;
    if (assignee && !who) throw new Error(`Kein Agent "${assignee}"`);
    const t = { id: this.state.nextTaskId++, title: short(title, 200), description: String(description).trim(), status: 'todo', assignee: who?.name || '', createdBy: by, createdAt: Date.now(), updatedAt: Date.now() };
    this.state.tasks.push(t);
    this.event('task', by, `Neue Aufgabe #${t.id}: ${t.title}${t.assignee ? ` (für ${t.assignee})` : ''}`);
    this.#tasksChanged();
    if (who && who.name !== by) this.sendMessage(by, who.name, `Dir wurde Aufgabe #${t.id} zugewiesen: ${t.title}${t.description ? ` — ${t.description}` : ''}`);
    return t;
  }

  updateTask(by, id, patch = {}) {
    const t = this.state.tasks.find((x) => x.id === Number(id));
    if (!t) throw new Error(`Keine Aufgabe #${id}`);
    if (patch.status !== undefined) {
      if (!TASK_STATES.includes(patch.status)) throw new Error(`status muss eines von ${TASK_STATES.join(', ')} sein`);
      t.status = patch.status;
    }
    let newAssignee = null;
    if (patch.assignee !== undefined) {
      const who = patch.assignee ? this.agent(patch.assignee) : null;
      if (patch.assignee && !who) throw new Error(`Kein Agent "${patch.assignee}"`);
      if (who && who.name !== t.assignee) newAssignee = who;
      t.assignee = who?.name || '';
    }
    if (patch.title) t.title = short(patch.title, 200);
    if (patch.description !== undefined) t.description = String(patch.description).trim();
    if (patch.note) t.description = `${t.description}${t.description ? '\n' : ''}${by}: ${String(patch.note).trim()}`;
    t.updatedAt = Date.now();
    const label = { todo: 'offen', in_progress: 'in Arbeit', done: 'erledigt' }[t.status];
    this.event('task', by, `Aufgabe #${t.id} „${t.title}“ → ${label}${t.assignee ? ` (${t.assignee})` : ''}`);
    this.#tasksChanged();
    if (newAssignee && newAssignee.name !== by) this.sendMessage(by, newAssignee.name, `Dir wurde Aufgabe #${t.id} zugewiesen: ${t.title}`);
    return t;
  }

  deleteTask(id) {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== Number(id));
    this.#tasksChanged();
  }

  // ---------- context handed to agents ----------

  teamSnapshot(exceptId) {
    const lines = this.state.agents.filter((a) => a.id !== exceptId).map((a) => {
      const r = this.runtime.get(a.id);
      return `- ${a.name} (${a.roleName}) — ${r.state}${r.statusText ? ` — ${r.statusText}` : ''}`;
    });
    return lines.length ? `Team right now:\n${lines.join('\n')}` : 'You are currently the only agent in this project.';
  }

  briefing(id) {
    const open = this.state.tasks.filter((t) => t.status !== 'done');
    const notes = this.vault.list(['Memory', 'Global']).slice(0, 30);
    return [
      '[UltraClaude briefing]',
      this.teamSnapshot(id),
      open.length ? `Open tasks:\n${open.map((t) => `- #${t.id} ${t.title} [${t.status}${t.assignee ? `, ${t.assignee}` : ''}]`).join('\n')}` : 'No open tasks on the board.',
      notes.length ? `Shared memory notes (use memory_read / memory_search):\n${notes.map((n) => `- ${n.title}${n.tags.length ? ` (${n.tags.join(', ')})` : ''}: ${short(n.excerpt, 90)}`).join('\n')}` : 'Shared memory is still empty.',
      this.takeUnread(id),
    ].filter(Boolean).join('\n\n');
  }

  // ---------- Claude Code hooks ----------

  /** Called for every hook event of an agent. Returns the JSON the hook prints, or null. */
  handleHook(id, p = {}) {
    const a = this.agent(id);
    const r = this.runtime.get(id);
    if (!a || !r) return null;
    const ev = p.hook_event_name;
    const context = (text) => (text ? { hookSpecificOutput: { hookEventName: ev, additionalContext: text } } : null);
    let out = null;
    r.lastActive = Date.now();

    if (ev === 'SessionStart') {
      Object.assign(r, { state: 'idle', activity: '' });
      out = context(this.briefing(id));
      if (r.pendingPrompt) {
        const prompt = r.pendingPrompt;
        r.pendingPrompt = '';
        setTimeout(() => this.inject(id, prompt), 1500);
      }
    } else if (ev === 'UserPromptSubmit') {
      Object.assign(r, { state: 'working', activity: 'denkt nach…' });
      if (!a.started) { a.started = true; this.save(); }
      out = context([this.teamSnapshot(id), this.takeUnread(id)].filter(Boolean).join('\n\n'));
    } else if (ev === 'PreToolUse') {
      r.toolCount++;
      Object.assign(r, { state: 'working', activity: describeTool(p.tool_name, p.tool_input) });
      this.event('tool', a.name, r.activity);
    } else if (ev === 'PostToolUse') {
      r.state = 'working';
      out = context(this.takeUnread(id));
    } else if (ev === 'Notification') {
      if (r.state === 'working' && !/waiting for your input/i.test(p.message || '')) {
        Object.assign(r, { state: 'waiting', activity: short(p.message || 'braucht dich', 80) });
        this.event('waiting', a.name, r.activity);
      }
    } else if (ev === 'Stop') {
      const unread = this.takeUnread(id);
      if (unread) {
        out = { decision: 'block', reason: `New messages from your team arrived while you were working:\n${unread}` };
      } else {
        Object.assign(r, { state: 'idle', activity: '' });
      }
    }
    this.#changed(a);
    return out;
  }

  setStatus(id, text) {
    const a = this.agent(id);
    const r = this.runtime.get(id);
    r.statusText = short(text, 140);
    this.event('status', a.name, r.statusText);
    this.#changed(a);
  }
}

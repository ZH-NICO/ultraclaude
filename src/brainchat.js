// The brain chat: Claude Code (print mode, the person's own login) with tools to search the file index,
// list folders, show files in the brain view and propose moves. It cannot run commands, write or delete;
// moves only happen when the person applies a plan in the window.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaude, claudeEnv } from './project.js';
import * as bq from './brainquery.js';

const GUIDE = `[UltraClaude brain] You are the guide to the person's brain in UltraClaude: an index of the names of all files on this computer (system, program and hidden folders are left out). Help them find, understand and sort their files.
- brain_overview: the regions (main folders) and how many files each holds.
- brain_search: find files by words in their path; "ext:pdf" keeps one kind.
- brain_list: what is directly inside a folder.
- brain_show: makes the brain view fly to files and light them up. Call it for the files you talk about, so the person sees them.
- brain_propose_moves: to sort, propose moves (from, to; full paths). Nothing moves until the person applies the plan in the window; they can undo it. Never overwrite, never delete, keep file names unless asked.
- brain_query: filtered, sorted file lists with size and date (type, folder, period, size, tag).
- brain_pivot: a table of any two things (type, ext, region, folder, year, month, size, tag), counting files or size.
- brain_duplicates: files with the same name and size.
- brain_view: rearrange the person's dots, with a filter. They fly from the brain into: pivot (a table of rows by cols), timeline, storage (disk space), duplicates, sorted, or back to brain; table opens the list of files. Use it Use it whenever a view answers the question; the period and filter apply to every view.
- brain_organize: propose a plan that moves matching files into a folder, optionally into subfolders by type, ext, year or month.
- brain_tag: add or remove tags on files.
- Read: open a file when its content matters for sorting.
Answer briefly, in the person's language.`;

const TOOLS = [
  { name: 'brain_overview', description: 'The regions of the brain (main folders) with their file counts, and the state of the index.', inputSchema: { type: 'object', properties: {} } },
  { name: 'brain_search', description: 'Find files whose full path contains every word. "ext:pdf" or ".pdf" keeps one file type. Returns full paths.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'At most this many, default 60' } }, required: ['query'] } },
  { name: 'brain_list', description: 'The folders and files directly inside a folder (full path).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'brain_show', description: 'Fly the brain view to these files or folders and light them up for the person.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, label: { type: 'string', description: 'A few words on what is shown' } }, required: ['paths'] } },
  { name: 'brain_propose_moves', description: 'Propose moving files or folders to sort them. The person sees the plan and applies or discards it; nothing moves before. Full paths; the target must not exist.', inputSchema: { type: 'object', properties: { moves: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } }, reason: { type: 'string', description: 'One sentence: why these moves' } }, required: ['moves'] } },
];

const FILTER = { type: 'object', description: 'All optional', properties: {
  q: { type: 'string', description: 'words that must be in the path; ".pdf" keeps one extension' },
  type: { type: 'string', enum: bq.TYPES }, folder: { type: 'string', description: 'full path; includes subfolders' },
  from: { type: 'string', description: 'date YYYY-MM-DD, modified on or after' }, to: { type: 'string', description: 'date YYYY-MM-DD, modified before' },
  min: { type: 'number', description: 'bytes' }, max: { type: 'number', description: 'bytes' }, tag: { type: 'string' } } };
TOOLS.push(
  { name: 'brain_query', description: 'Files that match a filter, sorted. Gives size, date, type and tags.', inputSchema: { type: 'object', properties: { filter: FILTER, sort: { type: 'string', enum: ['mtime', 'size', 'name', 'type', 'folder'] }, desc: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'brain_pivot', description: 'A table of two dimensions over the matching files.', inputSchema: { type: 'object', properties: { filter: FILTER, rows: { type: 'string', enum: bq.DIMENSIONS }, cols: { type: 'string', enum: bq.DIMENSIONS }, value: { type: 'string', enum: ['count', 'size'] } } } },
  { name: 'brain_duplicates', description: 'Files that appear more than once with the same name and size.', inputSchema: { type: 'object', properties: { filter: FILTER } } },
  { name: 'brain_view', description: 'Open a view of the brain for the person, with a filter.', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['brain', 'table', 'pivot', 'timeline', 'storage', 'duplicates', 'sorted'] }, filter: FILTER, rows: { type: 'string', enum: bq.DIMENSIONS }, cols: { type: 'string', enum: bq.DIMENSIONS }, value: { type: 'string', enum: ['count', 'size'] }, sort: { type: 'string' } }, required: ['view'] } },
  { name: 'brain_organize', description: 'Propose moving the matching files (or the given paths) into a folder, optionally into subfolders by type, ext, year or month. The person applies or discards the plan.', inputSchema: { type: 'object', properties: { filter: FILTER, paths: { type: 'array', items: { type: 'string' } }, into: { type: 'string', description: 'full path of the target folder' }, by: { type: 'string', enum: ['type', 'ext', 'year', 'month'] }, reason: { type: 'string' } } } },
  { name: 'brain_tag', description: 'Add or remove tags on files.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
);

/** Claude writes dates as text; the index compares numbers. */
const dated = (f = {}) => ({ ...f, from: f.from ? Date.parse(f.from) || 0 : 0, to: f.to ? Date.parse(f.to) || 0 : 0 });

const short = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export class BrainChat extends EventEmitter {
  constructor({ index, endpoint, dataDir, tags }) {
    super();
    this.tags = tags || new bq.Tags(path.join(dataDir, 'brain', 'tags.json'));
    this.index = index;
    this.endpoint = endpoint; // () => { port, token }
    this.dir = path.join(dataDir, 'brain');
    fs.mkdirSync(this.dir, { recursive: true });
    this.items = [];
    this.busy = false;
    this.proc = null;
    this.sessionId = crypto.randomUUID();
    this.started = false;
    this.notes = []; // what the next message should tell Claude (applied or discarded plans)
  }

  view() { return { items: this.items.slice(-200), busy: this.busy }; }

  #add(item) { const it = { id: crypto.randomUUID(), at: Date.now(), ...item }; this.items.push(it); if (this.items.length > 400) this.items.splice(0, this.items.length - 400); this.emit('item', it); return it; }
  #update(it) { this.emit('item', it); }

  reset() {
    if (this.busy) throw new Error('Wait until the brain has answered.');
    this.items = [];
    this.sessionId = crypto.randomUUID();
    this.started = false;
    this.notes = [];
    this.emit('reset');
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } } }

  /** Why a message cannot be sent now, or null. */
  problem(text) {
    if (!String(text || '').trim()) return 'Write something first.';
    if (this.busy) return 'The brain is still answering.';
    if (!resolveClaude()) return 'Claude Code was not found. Install it and make sure the "claude" command works in your terminal.';
    return null;
  }

  /** Sends one message and streams the answer as items. */
  async send(text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Write something first.');
    if (this.busy) throw new Error('The brain is still answering.');
    let file = resolveClaude();
    if (!file) throw new Error('Claude Code was not found. Install it and make sure the "claude" command works in your terminal.');
    const { port, token } = this.endpoint();
    this.#add({ kind: 'user', text: body });
    const mcpFile = path.join(this.dir, 'mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { brain: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}/brain` } } }));
    const prompt = [this.started ? '' : GUIDE, this.notes.splice(0).join('\n'), body].filter(Boolean).join('\n\n');
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--mcp-config', mcpFile, '--strict-mcp-config',
      '--allowedTools', 'mcp__brain,Read', '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task',
      ...(this.started ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
      ...this.index.roots.flatMap((r) => ['--add-dir', r])];
    let argv = args;
    let verbatim = false;
    if (/\.(cmd|bat)$/i.test(file)) {
      // a .cmd needs cmd.exe; the line is quoted here so paths with spaces or brackets stay whole (no user text is in it)
      const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
      argv = ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`];
      file = process.env.ComSpec || 'cmd.exe';
      verbatim = true;
    }
    this.busy = true;
    this.emit('busy', true);
    const proc = spawn(file, argv, { cwd: os.homedir(), env: claudeEnv(), windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.end(prompt); // the message goes in on stdin, never through a shell
    let buf = ''; let err = ''; let answered = false;
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 10 * 60_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'system' && e.session_id) this.sessionId = e.session_id;
        if (e.type === 'assistant') {
          for (const c of e.message?.content || []) {
            if (c.type === 'text' && c.text.trim()) this.#add({ kind: 'text', text: c.text.trim() });
            if (c.type === 'tool_use' && !String(c.name).startsWith('mcp__brain__')) this.#add({ kind: 'tool', text: c.name === 'Read' ? `read ${path.basename(c.input?.file_path || '')}` : c.name });
          }
        }
        if (e.type === 'result') { answered = true; this.started = true; if (e.is_error) this.#add({ kind: 'error', text: short(e.result || 'Claude could not answer.', 400) }); }
      }
    });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    await new Promise((resolve) => {
      proc.on('error', (e) => { err += e.message; resolve(); });
      proc.on('close', resolve);
    });
    clearTimeout(timer);
    this.proc = null;
    this.busy = false;
    if (!answered) this.#add({ kind: 'error', text: short(err.trim().split('\n').filter(Boolean).pop() || 'Claude Code stopped without an answer.', 400) });
    this.emit('busy', false);
  }

  // ---------- the tools, called by Claude through the MCP endpoint ----------

  call(name, args = {}) {
    const ix = this.index;
    if (ix.state !== 'ready' && name !== 'brain_overview') return `The index is still being built (${ix.files.length} files so far). Try again in a moment.`;
    switch (name) {
      case 'brain_overview': {
        const p = ix.state === 'ready' ? ix.payload(1) : null;
        return [`Index: ${ix.state}, ${ix.files.length} files in ${ix.dirs.length} folders${ix.truncated ? ' (stopped at the limit)' : ''}. Roots: ${ix.roots.join(', ')}. Home: ${ix.home}`,
          ...(p ? p.regions.map((r) => `- ${r.name}: ${r.count} files${r.path ? ` (${r.path})` : ''}`) : [])].join('\n');
      }
      case 'brain_search': {
        const hits = ix.search(args.query, Math.min(300, Number(args.limit) || 60));
        this.#add({ kind: 'action', text: `searched “${short(args.query, 50)}” · ${hits.length} ${hits.length === 1 ? 'file' : 'files'}`, paths: hits.slice(0, 300) });
        if (hits.length) this.emit('show', { paths: hits.slice(0, 300), label: `“${short(args.query, 40)}”` });
        return hits.length ? hits.join('\n') : 'Nothing found.';
      }
      case 'brain_list': {
        const l = ix.list(String(args.path || ''));
        if (!l) return 'That folder is not in the index.';
        this.#add({ kind: 'action', text: `looked into ${path.basename(l.path) || l.path}`, paths: [l.path] });
        this.emit('show', { paths: [l.path], label: path.basename(l.path) || l.path });
        return [`${l.path}`, ...l.folders.map((f) => `[folder] ${f}`), ...l.files, l.more ? `… and ${l.more} more` : ''].filter(Boolean).join('\n');
      }
      case 'brain_show': {
        const paths = (Array.isArray(args.paths) ? args.paths : []).map(String).slice(0, 300);
        if (!paths.length) return 'Nothing to show.';
        this.#add({ kind: 'action', text: `showed ${args.label ? short(args.label, 60) : `${paths.length} ${paths.length === 1 ? 'item' : 'items'}`}`, paths });
        this.emit('show', { paths, label: args.label ? short(args.label, 60) : '' });
        return `The brain view now shows ${paths.length} ${paths.length === 1 ? 'item' : 'items'}.`;
      }
      case 'brain_propose_moves': {
        const moves = (Array.isArray(args.moves) ? args.moves : []).map((m) => ({ from: String(m?.from || ''), to: String(m?.to || '') }));
        const problems = ix.check(moves);
        if (problems.length) return `This plan cannot be done:\n${problems.slice(0, 12).join('\n')}`;
        const plan = this.#add({ kind: 'plan', state: 'pending', reason: short(args.reason || '', 300), moves });
        this.emit('show', { paths: moves.map((m) => m.from), label: 'to sort' });
        return `Proposed ${moves.length} ${moves.length === 1 ? 'move' : 'moves'} (plan ${plan.id.slice(0, 8)}). The person decides in the window; nothing has moved yet.`;
      }
      case 'brain_query': {
        const r = bq.table(ix, this.tags, { ...args, filter: dated(args.filter), limit: Math.min(200, Number(args.limit) || 40) });
        this.#add({ kind: 'action', text: `looked through ${r.total} ${r.total === 1 ? 'file' : 'files'}`, paths: r.rows.map((x) => x.path) });
        return [`${r.total} files, ${r.bytes} bytes${ix.measured ? '' : ' (sizes and dates are still being read)'}`, ...r.rows.map((x) => `${x.path} | ${x.size ?? '?'} B | ${x.mtime ? new Date(x.mtime).toISOString().slice(0, 10) : '?'}${x.tags.length ? ` | tags: ${x.tags.join(', ')}` : ''}`)].join('\n');
      }
      case 'brain_pivot': {
        const r = bq.pivot(ix, this.tags, { ...args, filter: dated(args.filter) });
        this.#add({ kind: 'action', text: `made a table: ${r.by.rows} by ${r.by.cols}`, paths: [], view: { view: 'pivot', filter: dated(args.filter), rows: r.by.rows, cols: r.by.cols, value: r.by.value } });
        return [`${r.by.rows} \\ ${r.by.cols} (${r.by.value})`, ['', ...r.cols.map((c) => c.name)].join(' | '), ...r.rows.map((a, i) => [a.name, ...r.cells[i]].join(' | '))].join('\n');
      }
      case 'brain_duplicates': {
        const r = bq.duplicates(ix, this.tags, { filter: dated(args.filter) });
        this.#add({ kind: 'action', text: `found ${r.total} sets of duplicates`, paths: [], view: { view: 'duplicates', filter: dated(args.filter) } });
        return [`${r.total} sets, ${r.waste} bytes could be freed`, ...r.groups.slice(0, 25).map((g) => `${g.name} (${g.size} B) ×${g.files.length}: ${g.files.map((f) => f.dir).join(' ; ')}`)].join('\n');
      }
      case 'brain_view': {
        const view = { view: String(args.view), filter: dated(args.filter), rows: args.rows, cols: args.cols, value: args.value, sort: args.sort };
        this.#add({ kind: 'action', text: `opened the ${view.view} view`, paths: [], view });
        this.emit('view', view);
        return `The person now sees the ${view.view} view.`;
      }
      case 'brain_organize': {
        let moves;
        try { moves = bq.organize(ix, this.tags, { ...args, filter: dated(args.filter) }); } catch (err) { return err.message; }
        return this.call('brain_propose_moves', { moves, reason: args.reason });
      }
      case 'brain_tag': {
        const paths = (Array.isArray(args.paths) ? args.paths : []).map(String).filter((p) => ix.allowed(p));
        if (!paths.length) return 'No files to tag.';
        this.tags.change(paths, args.add, args.remove);
        this.#add({ kind: 'action', text: `tagged ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`, paths });
        return 'Tags saved.';
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** The MCP endpoint for the brain's tools (JSON-RPC over HTTP, like the agents' one). */
  mcp(body) {
    const one = (msg) => {
      const { id, method, params } = msg ?? {};
      if (id === undefined || id === null) return null;
      const ok = (result) => ({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') return ok({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'brain', version: '0.1.0' } });
      if (method === 'ping') return ok({});
      if (method === 'tools/list') return ok({ tools: TOOLS });
      if (method === 'tools/call') {
        try { return ok({ content: [{ type: 'text', text: String(this.call(params?.name, params?.arguments ?? {})) }] }); } catch (err) { return ok({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }); }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    };
    if (Array.isArray(body)) { const out = body.map(one).filter(Boolean); return out.length ? out : null; }
    return one(body);
  }

  // ---------- plans ----------

  /** A plan made by the person in the window (table, duplicates), applied the same way as Claude's. */
  propose(moves, reason = '') {
    const problems = this.index.check(moves);
    if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));
    return this.#add({ kind: 'plan', state: 'pending', reason: short(reason, 300), moves });
  }

  #plan(id) { const p = this.items.find((i) => i.kind === 'plan' && i.id === id); if (!p) throw new Error('There is no such plan.'); return p; }

  async apply(id) {
    const p = this.#plan(id);
    if (p.state !== 'pending') throw new Error(`This plan was already ${p.state}.`);
    const r = await this.index.apply(p.moves);
    this.tags.move(r.done);
    Object.assign(p, { state: 'applied', done: r.done, failed: r.failed });
    this.#update(p);
    this.notes.push(`[UltraClaude] The person applied plan ${id.slice(0, 8)}: ${r.done.length} moved${r.failed.length ? `, ${r.failed.length} failed (${r.failed.map((f) => `${f.from}: ${f.error}`).slice(0, 5).join('; ')})` : ''}.`);
    return p;
  }

  discard(id) {
    const p = this.#plan(id);
    if (p.state !== 'pending') throw new Error(`This plan was already ${p.state}.`);
    p.state = 'discarded';
    this.#update(p);
    this.notes.push(`[UltraClaude] The person discarded plan ${id.slice(0, 8)}.`);
    return p;
  }

  async undo(id) {
    const p = this.#plan(id);
    if (p.state !== 'applied') throw new Error('Only an applied plan can be undone.');
    const r = await this.index.undo(p.done);
    this.tags.move(r.done);
    Object.assign(p, { state: 'undone', undoFailed: r.failed });
    this.#update(p);
    this.notes.push(`[UltraClaude] The person undid plan ${id.slice(0, 8)}; the files are back where they were.`);
    return p;
  }
}

// The brain's index: the names of all files on this computer (no contents), walked in the background.
// System and program folders, hidden folders and dependency folders are left out. Also moves files for
// the brain chat, but only within the indexed roots, never over an existing file, and always undoable.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const win = process.platform === 'win32';
const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
// never walked, wherever they are
const SKIP_ANYWHERE = new Set(['node_modules', '__pycache__', '$recycle.bin', 'system volume information', 'site-packages', '.git']);
// left out right under a drive root: the operating system and installed programs
const SKIP_AT_ROOT = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'recovery', 'perflogs', 'msocache', 'config.msi', '$windows.~bt', '$windows.~ws', '$winreagent', 'intel', 'amd', 'nvidia', 'drivers', 'onedrivetemp', 'proc', 'sys', 'dev', 'run', 'snap', 'boot', 'lib', 'lib64', 'bin', 'sbin', 'usr', 'etc', 'var', 'opt', 'tmp', 'system', 'private', 'cores']);
// left out right under a user's home: application data
const SKIP_IN_HOME = new Set(['appdata', 'library', 'application data', 'local settings']);

/** Where to look: every fixed drive on Windows, the home folder elsewhere. ULTRACLAUDE_BRAIN_ROOTS overrides it. */
export function defaultRoots() {
  if (process.env.ULTRACLAUDE_BRAIN_ROOTS) return process.env.ULTRACLAUDE_BRAIN_ROOTS.split(path.delimiter).filter(Boolean).map((r) => path.resolve(r));
  if (win) return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  return [os.homedir()];
}

export class FileIndex extends EventEmitter {
  constructor({ roots = defaultRoots(), max = 400_000, home = os.homedir(), journal = null } = {}) {
    super();
    this.roots = roots.map((r) => path.resolve(r));
    this.max = max;
    this.home = path.resolve(home);
    this.journal = journal; // a file where applied moves are written, so they can be undone after a restart too
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.dirs = []; // full paths
    this.dirParent = []; // index of the parent dir, or -1
    this.files = []; // [dirIndex, name]
    this.byPath = null;
    this.startedAt = 0; this.took = 0; this.truncated = false; this.skipped = 0;
  }

  status() { return { state: this.state, files: this.files.length, dirs: this.dirs.length, roots: this.roots, took: this.took, truncated: this.truncated }; }

  /** Whether a folder is left out of the index. */
  skips(dir, name) {
    const n = name.toLowerCase();
    if (n.startsWith('.') || SKIP_ANYWHERE.has(n)) return true;
    const parent = norm(dir);
    if (this.roots.some((r) => norm(r) === parent) && SKIP_AT_ROOT.has(n)) return true;
    if (parent === norm(this.home) && SKIP_IN_HOME.has(n)) return true;
    return false;
  }

  /** Walks the roots; resolves when done. Calling it again while it runs returns the same walk. */
  build() {
    if (this.walk) return this.walk;
    this.reset();
    this.state = 'indexing';
    this.startedAt = Date.now();
    this.emit('status', this.status());
    this.walk = (async () => {
      const queue = this.roots.map((r) => [r, -1]);
      let lastNote = 0;
      while (queue.length && this.files.length < this.max) {
        const [dir, parent] = queue.shift();
        const di = this.dirs.push(dir) - 1;
        this.dirParent.push(parent);
        let handle;
        try { handle = await fs.promises.opendir(dir); } catch { this.skipped++; continue; }
        try {
          for await (const e of handle) {
            if (e.isDirectory()) { if (!this.skips(dir, e.name)) queue.push([path.join(dir, e.name), di]); }
            else if (e.isFile()) { this.files.push([di, e.name]); if (this.files.length >= this.max) break; }
          }
        } catch { this.skipped++; }
        if (this.files.length - lastNote > 5000) { lastNote = this.files.length; this.emit('status', this.status()); }
      }
      this.truncated = this.files.length >= this.max;
      this.state = 'ready';
      this.took = Date.now() - this.startedAt;
      this.walk = null;
      this.emit('status', this.status());
      this.emit('ready');
    })();
    return this.walk;
  }

  pathOf(i) { const [d, n] = this.files[i]; return path.join(this.dirs[d], n); }

  /** Which region a folder belongs to: a folder in the home folder, or a folder right under a drive. */
  regionOf(p) {
    const abs = path.resolve(p);
    const inHome = norm(abs) === norm(this.home) || norm(abs).startsWith(norm(this.home) + path.sep);
    const base = inHome ? this.home : this.roots.find((r) => norm(abs).startsWith(norm(r))) || path.parse(abs).root;
    const first = path.relative(base, abs).split(path.sep)[0];
    if (!first || first === '..') return { key: norm(base), name: inHome ? 'Home' : base, path: base };
    const full = path.join(base, first);
    return { key: norm(full), name: inHome ? first : `${first} (${base.replace(/[\\/]$/, '')})`, path: full };
  }

  /** What the window draws: the regions and up to `limit` files, spread evenly over the index. */
  payload(limit = 40_000) {
    const regions = new Map();
    const dirRegion = this.dirs.map((d) => {
      const r = this.regionOf(d);
      if (!regions.has(r.key)) regions.set(r.key, { ...r, count: 0 });
      return r.key;
    });
    for (const [d] of this.files) regions.get(dirRegion[d]).count++;
    // the 20 biggest regions keep their name, the rest are pooled
    let list = [...regions.values()].filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
    if (list.length > 20) {
      const rest = list.slice(19);
      const other = { key: '*', name: 'Everything else', path: '', count: rest.reduce((s, r) => s + r.count, 0) };
      for (const r of rest) r.pooled = true;
      list = [...list.slice(0, 19), other];
    }
    const regionIndex = new Map(list.map((r, i) => [r.key, i]));
    const step = Math.max(1, this.files.length / limit);
    const dirOut = new Map();
    const files = [];
    for (let k = 0; k < this.files.length && files.length < limit; k += step) {
      const i = Math.floor(k);
      const [d, name] = this.files[i];
      if (!dirOut.has(d)) dirOut.set(d, dirOut.size);
      const reg = regions.get(dirRegion[d]);
      files.push([dirOut.get(d), name, reg.pooled ? regionIndex.get('*') : regionIndex.get(reg.key)]);
    }
    const dirs = [];
    for (const [d, j] of dirOut) dirs[j] = this.dirs[d];
    return { ...this.status(), total: this.files.length, shown: files.length, regions: list.map(({ key, name, path: p, count }) => ({ key, name, path: p, count })), dirs, files };
  }

  /** Files and folders whose path contains every word; "ext:pdf" or ".pdf" keeps one kind. */
  search(query, limit = 200) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const isExt = (w) => /^(ext:\w{1,8}|\.\w{1,8})$/.test(w);
    const exts = words.filter(isExt).map((w) => `.${w.replace(/^ext:|^\./, '')}`);
    const terms = words.filter((w) => !isExt(w));
    if (!terms.length && !exts.length) return [];
    const lowDirs = this.dirs.map((d) => d.toLowerCase());
    const out = [];
    for (let i = 0; i < this.files.length && out.length < limit; i++) {
      const [d, name] = this.files[i];
      const n = name.toLowerCase();
      if (exts.length && !exts.some((e) => n.endsWith(e))) continue;
      const hay = `${lowDirs[d]}${path.sep}${n}`;
      if (terms.every((t) => hay.includes(t))) out.push(path.join(this.dirs[d], name));
    }
    return out;
  }

  /** The folders and files directly inside a folder, as the index knows them. */
  list(dir, limit = 300) {
    const key = norm(dir);
    const di = this.dirs.findIndex((d) => norm(d) === key);
    if (di < 0) return null;
    const folders = []; const files = [];
    this.dirParent.forEach((p, i) => { if (p === di) folders.push(path.basename(this.dirs[i])); });
    for (const [d, n] of this.files) if (d === di) files.push(n);
    return { path: this.dirs[di], folders: folders.sort().slice(0, limit), files: files.sort().slice(0, limit), more: Math.max(0, folders.length + files.length - 2 * limit) };
  }

  /** Is this path inside one of the roots, and not in a left-out folder? */
  allowed(p) {
    const abs = path.resolve(String(p || ''));
    if (!path.isAbsolute(String(p || ''))) return false;
    const root = this.roots.find((r) => norm(abs) === norm(r) || norm(abs).startsWith(norm(r).replace(/[\\/]$/, '') + path.sep));
    if (!root || norm(abs) === norm(root)) return false;
    let cur = abs;
    while (norm(path.dirname(cur)) !== norm(cur) && norm(cur) !== norm(root)) {
      if (this.skips(path.dirname(cur), path.basename(cur))) return false;
      cur = path.dirname(cur);
    }
    return true;
  }

  /** Checks a list of moves; returns the problems, empty when all can be done. */
  check(moves) {
    const problems = [];
    if (!Array.isArray(moves) || !moves.length) return ['There are no moves.'];
    if (moves.length > 500) return ['At most 500 moves at once.'];
    const targets = new Set();
    for (const m of moves) {
      const from = String(m?.from || ''); const to = String(m?.to || '');
      if (!this.allowed(from)) problems.push(`${from}: not a file the brain may move`);
      else if (!fs.existsSync(from)) problems.push(`${from}: does not exist`);
      if (!this.allowed(to)) problems.push(`${to}: not a place the brain may move to`);
      else if (fs.existsSync(to)) problems.push(`${to}: already exists, nothing is overwritten`);
      if (targets.has(norm(to))) problems.push(`${to}: two moves go to the same place`);
      targets.add(norm(to));
    }
    return problems;
  }

  /** Moves files and folders. Each move is done or not; the done ones are returned and written to the journal. */
  async apply(moves) {
    const problems = this.check(moves);
    if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));
    const done = [];
    const failed = [];
    for (const { from, to } of moves) {
      try {
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        try { await fs.promises.rename(from, to); } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
          await fs.promises.rm(from, { recursive: true });
        }
        done.push({ from: path.resolve(from), to: path.resolve(to) });
        this.#moved(from, to);
      } catch (err) { failed.push({ from, to, error: err.message }); }
    }
    if (this.journal && done.length) { try { fs.appendFileSync(this.journal, `${JSON.stringify({ at: Date.now(), done })}\n`); } catch { /* the undo button still works in this run */ } }
    return { done, failed };
  }

  /** Puts moved files back where they were. */
  async undo(done) {
    return this.apply(done.map(({ from, to }) => ({ from: to, to: from })).reverse());
  }

  #moved(from, to) {
    const dirKey = norm(path.dirname(from));
    const name = path.basename(from);
    const d = this.dirs.findIndex((x) => norm(x) === dirKey);
    if (d < 0) return;
    const i = this.files.findIndex(([fd, n]) => fd === d && n === name);
    let td = this.dirs.findIndex((x) => norm(x) === norm(path.dirname(to)));
    if (td < 0) { td = this.dirs.push(path.dirname(to)) - 1; this.dirParent.push(this.dirs.findIndex((x) => norm(x) === norm(path.dirname(path.dirname(to))))); }
    if (i >= 0) this.files[i] = [td, path.basename(to)];
  }
}

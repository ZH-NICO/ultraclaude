// What the agents changed, through git: the worktrees of the project, their diffs, and the steps to bring
// a worktree's work home (commit, merge into the base branch, or a pull request with the GitHub CLI).
// Every command gets its arguments as an array, never through a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_DIFF = 600_000;

function run(cwd, cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      resolve({ ok: !err, out: stdout, err: stderr });
    });
  });
}
const git = (cwd, args, opts) => run(cwd, 'git', args, opts);
const norm = (p) => path.resolve(p).toLowerCase();

export async function isRepo(dir) {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).catch(() => ({ ok: false }));
  return r.ok && r.out.trim() === 'true';
}

/** All worktrees of the repository; the first one is the main folder. */
export async function worktrees(dir) {
  const { out } = await git(dir, ['worktree', 'list', '--porcelain']);
  const list = [];
  let w = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { w = { path: path.resolve(line.slice(9).trim()), branch: '', head: '' }; list.push(w); }
    else if (w && line.startsWith('HEAD ')) w.head = line.slice(5).trim();
    else if (w && line.startsWith('branch ')) w.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (w && line.trim() === 'prunable') w.gone = true;
  }
  return list.filter((x) => !x.gone && fs.existsSync(x.path)).map((x, i) => ({ ...x, main: i === 0 }));
}

/** Only paths that git itself lists as a worktree of this repository are ever worked on. */
async function known(dir, wtPath) {
  const w = (await worktrees(dir)).find((x) => norm(x.path) === norm(String(wtPath || '')));
  if (!w) throw new Error('That is not a worktree of this project.');
  return w;
}

export async function baseBranch(dir) {
  const [main] = await worktrees(dir);
  return main.branch || 'HEAD';
}

function parseStatus(out) {
  return out.split('\n').filter(Boolean).map((l) => {
    const code = l.slice(0, 2);
    const file = l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    const status = code === '??' ? 'new' : /D/.test(code) ? 'deleted' : /A/.test(code) ? 'added' : /R/.test(code) ? 'renamed' : 'modified';
    return { path: file, status };
  });
}

/** What a worktree has that the base branch does not: commits ahead, committed files and uncommitted ones. */
export async function changes(dir, wtPath) {
  const w = await known(dir, wtPath);
  const base = await baseBranch(dir);
  const dirty = parseStatus((await git(w.path, ['status', '--porcelain', '--untracked-files=all'])).out);
  let ahead = 0; let committed = [];
  if (!w.main && w.branch) {
    ahead = Number((await git(w.path, ['rev-list', '--count', `${base}..HEAD`], { allowFail: true })).out.trim()) || 0;
    const ns = (await git(w.path, ['diff', '--name-status', `${base}...HEAD`], { allowFail: true })).out;
    committed = ns.split('\n').filter(Boolean).map((l) => { const [s, ...rest] = l.split('\t'); return { path: rest.at(-1), status: { A: 'added', D: 'deleted', R: 'renamed' }[s[0]] || 'modified' }; });
  }
  const byPath = new Map(committed.map((f) => [f.path, { ...f, committed: true }]));
  for (const f of dirty) byPath.set(f.path, { ...(byPath.get(f.path) || {}), ...f, uncommitted: true });
  return { ...w, base, ahead, dirty: dirty.length, files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** The whole change of a worktree against the point where it left the base branch, uncommitted work included. */
export async function diff(dir, wtPath) {
  const w = await known(dir, wtPath);
  const base = await baseBranch(dir);
  const from = w.main ? 'HEAD' : ((await git(w.path, ['merge-base', base, 'HEAD'], { allowFail: true })).out.trim() || 'HEAD');
  let text = (await git(w.path, ['diff', '--no-color', '--no-ext-diff', from])).out;
  // new files git does not track yet are shown in full
  const untracked = (await git(w.path, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean);
  for (const f of untracked) {
    if (text.length > MAX_DIFF) break;
    const r = await git(w.path, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', f], { allowFail: true });
    text += r.out;
  }
  return { diff: text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… (cut off, the change is too big to show here)\n` : text };
}

/** Commits everything in a worktree. */
export async function commitAll(dir, wtPath, message) {
  const w = await known(dir, wtPath);
  const msg = String(message || '').trim() || 'Work from UltraClaude';
  await git(w.path, ['add', '-A']);
  const r = await git(w.path, ['commit', '-m', msg], { allowFail: true });
  if (!r.ok) throw new Error(/nothing to commit/.test(r.out + r.err) ? 'There is nothing to commit.' : (r.err || r.out).trim().split('\n').pop());
  return { ok: true };
}

/** Merges a worktree's branch into the base branch in the main folder. Stops cleanly on a conflict. */
export async function merge(dir, wtPath) {
  const w = await known(dir, wtPath);
  if (w.main || !w.branch) throw new Error('Only the branch of an agent worktree can be merged.');
  const [main] = await worktrees(dir);
  if (parseStatus((await git(w.path, ['status', '--porcelain'])).out).length) throw new Error('The worktree has uncommitted changes. Commit them first.');
  if (parseStatus((await git(main.path, ['status', '--porcelain', '--untracked-files=no'])).out).length) throw new Error(`The main folder has uncommitted changes. Commit or stash them before merging into ${main.branch}.`);
  const r = await git(main.path, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${w.branch}`, w.branch], { allowFail: true });
  if (!r.ok) {
    await git(main.path, ['merge', '--abort'], { allowFail: true });
    throw new Error(/CONFLICT/.test(r.out + r.err) ? `${w.branch} conflicts with ${main.branch}. Nothing was changed; ask the agent to merge ${main.branch} into its branch first.` : (r.err || r.out).trim().split('\n').pop());
  }
  return { ok: true, into: main.branch };
}

/** Pushes a worktree's branch and opens a pull request with the GitHub CLI. Returns its address. */
export async function pullRequest(dir, wtPath) {
  const w = await known(dir, wtPath);
  if (w.main || !w.branch) throw new Error('Only the branch of an agent worktree can become a pull request.');
  if (parseStatus((await git(w.path, ['status', '--porcelain'])).out).length) throw new Error('The worktree has uncommitted changes. Commit them first.');
  const remote = (await git(w.path, ['remote'])).out.split('\n').filter(Boolean);
  if (!remote.length) throw new Error('This repository has no remote to push to.');
  const origin = remote.includes('origin') ? 'origin' : remote[0];
  await git(w.path, ['push', '-u', origin, w.branch]);
  const gh = process.env.ULTRACLAUDE_GH || 'gh';
  const base = await baseBranch(dir);
  const r = await run(w.path, gh, ['pr', 'create', '--fill', '--head', w.branch, '--base', base], { allowFail: true }).catch((err) => ({ ok: false, err: err.message }));
  const text = `${r.out || ''}\n${r.err || ''}`;
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  if (url) return { url: url.replace(/[).,]+$/, '') };
  throw new Error(/ENOENT|not recognized|not found/i.test(text) ? 'The GitHub CLI (gh) is not installed. The branch was pushed; open the pull request on GitHub.' : text.trim().split('\n').pop() || 'The pull request could not be opened.');
}

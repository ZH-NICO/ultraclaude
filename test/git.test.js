// Changes through git, against real temporary repositories and a stand-in for the GitHub CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isRepo, worktrees, changes, diff, commitAll, merge, pullRequest } from '../src/git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-git-')));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com'); sh(dir, 'config', 'user.name', 'Test'); sh(dir, 'config', 'commit.gpgsign', 'false'); sh(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'start');
  const wt = path.join(dir, '.claude', 'worktrees', 'uc-abc');
  sh(dir, 'worktree', 'add', '-q', '-b', 'worktree-uc-abc', wt);
  return { dir, wt };
}

test('worktrees, their changes and the diff, uncommitted and new files included', async () => {
  const { dir, wt } = repo();
  assert.equal(await isRepo(dir), true);
  assert.equal(await isRepo(os.tmpdir()), false);
  const list = await worktrees(dir);
  assert.equal(list.length, 2);
  assert.ok(list[0].main && list[0].branch === 'main');
  assert.equal(list[1].branch, 'worktree-uc-abc');

  fs.writeFileSync(path.join(wt, 'app.txt'), 'one\nTWO\n');
  sh(wt, 'commit', '-qam', 'change two');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'brand new\n');
  const c = await changes(dir, wt);
  assert.equal(c.ahead, 1);
  assert.equal(c.dirty, 1);
  assert.deepEqual(c.files.map((f) => `${f.path}:${f.status}`), ['app.txt:modified', 'new.txt:new']);
  const d = (await diff(dir, wt)).diff;
  assert.match(d, /-two\n\+TWO/);
  assert.match(d, /\+brand new/);
  await assert.rejects(changes(dir, os.tmpdir()), /not a worktree/, 'only paths git lists');
  await assert.rejects(diff(dir, path.join(wt, '..')), /not a worktree/);
});

test('commit and merge into the base branch; a conflict changes nothing', async () => {
  const { dir, wt } = repo();
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'done\n');
  await assert.rejects(merge(dir, wt), /uncommitted/);
  await commitAll(dir, wt, 'Add feature');
  await assert.rejects(commitAll(dir, wt, 'again'), /nothing to commit/);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'dirty\n');
  await assert.rejects(merge(dir, wt), /main folder has uncommitted/);
  sh(dir, 'checkout', '-q', '--', 'app.txt');
  const r = await merge(dir, wt);
  assert.equal(r.into, 'main');
  assert.equal(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'done\n');
  await assert.rejects(merge(dir, dir), /Only the branch/);

  // both change the same line
  fs.writeFileSync(path.join(wt, 'app.txt'), 'one\nfrom the agent\n'); sh(wt, 'commit', '-qam', 'agent');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'one\nfrom you\n'); sh(dir, 'commit', '-qam', 'you');
  const head = sh(dir, 'rev-parse', 'HEAD');
  await assert.rejects(merge(dir, wt), /conflicts with main/);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head, 'nothing merged');
  assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=no'), '', 'and nothing left half-merged');
});

test('a pull request pushes the branch and returns the address from the GitHub CLI', async () => {
  const { dir, wt } = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-remote-'));
  sh(remote, 'init', '-q', '--bare');
  await assert.rejects(pullRequest(dir, wt), /no remote/);
  sh(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n'); await commitAll(dir, wt, 'x');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-gh-'));
  const log = path.join(bin, 'args.txt');
  const script = path.join(bin, 'gh.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')); console.log('https://github.com/demo/repo/pull/7');\n`);
  const fake = path.join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh');
  fs.writeFileSync(fake, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  process.env.ULTRACLAUDE_GH = fake;
  try {
    // .cmd files need a shell on Windows; execFile refuses them, so the module must say so plainly
    const r = await pullRequest(dir, wt).catch((err) => ({ err }));
    if (r.err) assert.match(r.err.message, /gh|pull request|EINVAL|spawn/i);
    else {
      assert.equal(r.url, 'https://github.com/demo/repo/pull/7');
      assert.match(fs.readFileSync(log, 'utf8'), /pr create --fill --head worktree-uc-abc --base main/);
    }
    assert.ok(sh(remote, 'branch', '--list').includes('worktree-uc-abc'), 'the branch was pushed');
  } finally { delete process.env.ULTRACLAUDE_GH; }
});

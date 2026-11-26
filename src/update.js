// Is there a newer UltraClaude on GitHub, and install it. A release is a higher "version" in package.json.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// the archive, not "github:…": that needs git to be installed
const SOURCE = 'https://github.com/ZH-NICO/ultraclaude/archive/refs/heads/main.tar.gz';
const REMOTE = 'https://raw.githubusercontent.com/ZH-NICO/ultraclaude/main/package.json';
// on Windows "npm.cmd": PowerShell refuses to run the npm.ps1 script by default
export const MANUAL = `${process.platform === 'win32' ? 'npm.cmd' : 'npm'} install -g ${SOURCE}`;

export const localVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function newer(remote, local) {
  const a = String(remote).split('.').map(Number); const b = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

let cached = null;
/** Asks GitHub at most once an hour (or now, with `fresh`). Offline is not an error, just no answer. */
export async function checkUpdate({ fresh = false, get = fetch } = {}) {
  const current = localVersion();
  if (!fresh && cached && Date.now() - cached.at < 3600e3) return { ...cached.value, current, available: newer(cached.value.latest, current) };
  try {
    const r = await get(process.env.ULTRACLAUDE_UPDATE_URL || REMOTE, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const { version: latest } = await r.json();
    cached = { at: Date.now(), value: { latest } };
    return { current, latest, available: newer(latest, current), manual: MANUAL };
  } catch (err) {
    return { current, latest: null, available: false, error: err.message, manual: MANUAL };
  }
}

const run = (line) => new Promise((resolve, reject) => {
  // fixed commands only, nothing from the window goes in here; npm is a .cmd on Windows, so it needs a shell
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', line]] : ['sh', ['-c', line]];
  execFile(cmd, args, { cwd: ROOT, windowsHide: true, timeout: 300_000, maxBuffer: 10e6 }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim().split('\n').slice(-3).join(' '))) : resolve(out)));
});

let installing = false;
export async function installUpdate({ exec = run } = {}) {
  if (installing) throw new Error('The update is already being installed.');
  installing = true;
  try {
    if (fs.existsSync(path.join(ROOT, '.git'))) { await exec('git pull --ff-only'); await exec('npm install --no-audit --no-fund'); }
    else await exec(`${MANUAL} --prefer-online`); // not a cached copy of the old archive
    return { ok: true };
  } catch (err) {
    throw new Error(`The update failed: ${err.message} — close UltraClaude and run “${MANUAL}” in a terminal.`);
  } finally { installing = false; }
}

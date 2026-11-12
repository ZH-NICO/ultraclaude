#!/usr/bin/env node
// `ultraclaude` — opens the UltraClaude window for the folder you are in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../src/config.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const [command, ...rest] = args.filter((a) => !a.startsWith('-'));
const dir = process.cwd();
const dataDir = path.join(dir, '.ultraclaude');
const infoFile = path.join(dataDir, 'server.json');

const HELP = `UltraClaude — ein Team aus Claude-Code-Agents mit gemeinsamer Obsidian-Memory

  ultraclaude              Fenster für den aktuellen Ordner öffnen (startet den Server bei Bedarf)
  ultraclaude stop         Server und alle Agents dieses Ordners beenden
  ultraclaude status       Zeigt, ob der Server für diesen Ordner läuft
  ultraclaude vault [pfad] Obsidian-Vault anzeigen oder ändern
  ultraclaude help         Diese Hilfe

  --no-open                Server starten, aber kein Fenster öffnen`;

async function running() {
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

function openWindow(url) {
  const candidates = process.platform === 'win32' ? [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const browser = candidates.find((c) => c && fs.existsSync(c));
  const [cmd, cmdArgs] = browser ? [browser, [`--app=${url}`, '--window-size=1500,950']]
    : process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
}

async function open() {
  let info = await running();
  if (!info) {
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.unlinkSync(infoFile); } catch { /* no stale file */ }
    const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
    spawn(process.execPath, [SERVER, '--dir', dir], { detached: true, stdio: ['ignore', log, log], windowsHide: true, cwd: dir }).unref();
    for (let i = 0; i < 60 && !info; i++) {
      await new Promise((r) => setTimeout(r, 250));
      info = await running();
    }
    if (!info) {
      console.error(`Server konnte nicht gestartet werden. Details: ${path.join(dataDir, 'server.log')}`);
      process.exit(1);
    }
    console.log(`UltraClaude läuft für ${dir}`);
  } else {
    console.log(`UltraClaude läuft bereits für ${dir}`);
  }
  console.log(info.url);
  if (!flags.has('--no-open')) openWindow(info.url);
}

if (flags.has('-h') || flags.has('--help') || command === 'help') {
  console.log(HELP);
} else if (!command || command === 'open') {
  await open();
} else if (command === 'stop') {
  const info = await running();
  if (!info) console.log('Für diesen Ordner läuft kein UltraClaude.');
  else {
    await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { 'x-uc-token': info.token } }).catch(() => {});
    console.log('UltraClaude beendet.');
  }
} else if (command === 'status') {
  const info = await running();
  console.log(info ? `Läuft: ${info.url}` : 'Für diesen Ordner läuft kein UltraClaude.');
} else if (command === 'vault') {
  if (rest[0]) {
    const vaultPath = path.resolve(rest.join(' '));
    saveConfig({ vaultPath });
    console.log(`Vault gesetzt: ${vaultPath}\nGilt ab dem nächsten Start (ultraclaude stop, dann ultraclaude).`);
  } else {
    console.log(loadConfig().vaultPath);
  }
} else {
  console.error(`Unbekannter Befehl: ${command}\n\n${HELP}`);
  process.exit(1);
}

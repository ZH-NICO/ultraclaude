// What Claude Code itself already knows about a folder: the sessions that ran there before
// UltraClaude was opened, and the memory notes Claude Code saved for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHUNK = 512 * 1024;
const cache = new Map(); // transcript path -> { mtimeMs, size, info }

/** Claude Code keeps one folder per project, named after the project path. */
export function claudeProjectDir(dir) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
}

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, length, start));
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line cut off at the chunk border */ }
  }
  return out;
}

/** The text of something the person actually typed, or '' for commands, tool results and injected text. */
function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c.type === 'text')?.text || '' : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return /^(<|\[UltraClaude|Caveat:)/.test(clean) ? '' : clean;
}

function readSession(file, stat) {
  // Transcripts grow to many megabytes, so only the beginning and the end are read.
  const head = parseLines(readChunk(file, 0, Math.min(CHUNK, stat.size)));
  const tail = stat.size > CHUNK ? parseLines(readChunk(file, stat.size - CHUNK, CHUNK)) : head;
  const last = (key) => [...tail].reverse().find((e) => e[key])?.[key] || [...head].reverse().find((e) => e[key])?.[key] || '';
  const firstPrompt = head.map(promptText).find(Boolean) || '';
  const title = String(last('customTitle') || last('aiTitle') || firstPrompt).replace(/\s+/g, ' ').trim();
  return title ? { id: path.basename(file, '.jsonl'), title: title.slice(0, 80), firstPrompt: firstPrompt.slice(0, 200), updated: Math.round(stat.mtimeMs) } : null;
}

/** Sessions Claude Code has on record for this folder, newest first. Empty ones are left out. */
export function listSessions(dir) {
  const root = claudeProjectDir(dir);
  let names;
  try { names = fs.readdirSync(root).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n)); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      let hit = cache.get(file);
      if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
        hit = { mtimeMs: stat.mtimeMs, size: stat.size, info: readSession(file, stat) };
        cache.set(file, hit);
      }
      if (hit.info) sessions.push(hit.info);
    } catch { /* unreadable or just deleted */ }
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

/** The memory notes Claude Code saved for this folder (its index file is left out). */
export function claudeMemoryFiles(dir) {
  const root = path.join(claudeProjectDir(dir), 'memory');
  try {
    return fs.readdirSync(root)
      .filter((n) => n.toLowerCase().endsWith('.md') && n !== 'MEMORY.md')
      .map((n) => ({ name: n, file: path.join(root, n), mtimeMs: fs.statSync(path.join(root, n)).mtimeMs }));
  } catch {
    return [];
  }
}

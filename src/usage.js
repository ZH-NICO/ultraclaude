// How many tokens Claude Code used, read from its own transcripts (~/.claude/projects/**.jsonl).
// Nothing leaves the computer and no login token is touched. Costs are what the same tokens would
// cost at API prices; a Pro or Max subscription is not billed per token.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeHome, listAllProjects } from './history.js';

// USD per million tokens (input, output), first match wins. Cache writes cost 1.25x the input price
// (2x for the one-hour cache), cache reads 0.1x. Haiku 5.5 is priced for prompts up to 100K tokens.
const PRICES = [
  [/(fable|mythos)-5-2/, 8, 40], [/(fable|mythos)-5/, 10, 50],
  [/opus-5-5/, 4, 20], [/opus-(5|4-8|4-7|4-6|4-5)\b/, 5, 25], [/opus-4(-1)?-20/, 15, 75], [/opus-3/, 15, 75],
  [/sonnet-5/, 2, 10], [/sonnet-(4|3-7|3-5)/, 3, 15],
  [/haiku-5/, 0.1, 0.5], [/haiku-4-5/, 1, 5], [/haiku-3-5/, 0.8, 4], [/haiku-3/, 0.25, 1.25],
];

export const priceFor = (model) => PRICES.find(([re]) => re.test(model))?.slice(1) ?? null;

export function costOf(model, r) {
  const p = priceFor(model);
  if (!p) return null;
  const [pin, pout] = p;
  return (r.i * pin + r.o * pout + (r.cw - r.cw1) * pin * 1.25 + r.cw1 * pin * 2 + r.cr * pin * 0.1) / 1e6;
}

const cache = new Map(); // transcript path -> { mtimeMs, size, cwd, records }

async function readRecords(file) {
  const byId = new Map();
  const loose = [];
  let cwd = '';
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!cwd) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) { try { cwd = JSON.parse(`"${m[1]}"`); } catch { /* odd escape */ } }
    }
    if (!line.includes('"usage"')) continue; // most lines are not token counts; skip them unparsed
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    const u = m?.usage;
    if (e.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') continue;
    const r = { id: m.id || '', t: Date.parse(e.timestamp), model: m.model, i: u.input_tokens | 0, o: u.output_tokens | 0, cw: u.cache_creation_input_tokens | 0, cw1: u.cache_creation?.ephemeral_1h_input_tokens | 0, cr: u.cache_read_input_tokens | 0 };
    if (!Number.isFinite(r.t) || !(r.i + r.o + r.cw + r.cr)) continue;
    // a reply is written several times while it streams; the last copy has the final counts
    if (r.id) { const old = byId.get(r.id); if (!old || r.o >= old.o) byId.set(r.id, r); } else loose.push(r);
  }
  return { cwd, records: [...byId.values(), ...loose] };
}

function transcripts(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const total = (r) => r.i + r.o + r.cw + r.cr;
const blank = () => ({ i: 0, o: 0, cw: 0, cr: 0, msgs: 0, cost: 0, unpriced: 0 });
function add(acc, r, cost) {
  acc.i += r.i; acc.o += r.o; acc.cw += r.cw; acc.cr += r.cr; acc.msgs++;
  if (cost === null) acc.unpriced += total(r); else acc.cost += cost;
  return acc;
}

/** Five-hour blocks like Claude's own session window: a block starts with its first message. */
export function blocksOf(records, now) {
  const blocks = [];
  let b = null;
  for (const r of [...records].sort((x, y) => x.t - y.t)) {
    if (!b || r.t >= b.end || r.t - b.last >= 5 * 3600e3) {
      const start = Math.floor(r.t / 3600e3) * 3600e3;
      b = { start, end: start + 5 * 3600e3, first: r.t, last: r.t, tokens: 0, cost: 0, msgs: 0 };
      blocks.push(b);
    }
    b.last = r.t; b.tokens += total(r); b.msgs++; b.cost += costOf(r.model, r) ?? 0;
  }
  const lastBlock = blocks.at(-1);
  const active = lastBlock && now < lastBlock.end && now - lastBlock.last < 5 * 3600e3 ? lastBlock : null;
  return { blocks, active };
}

let report = null;

export async function usageReport({ range = '30d', now = Date.now(), blockLimit = null, fresh = false } = {}) {
  if (report && !fresh && now - report.at < 20_000 && report.range === range && report.limit === blockLimit) return report.value;
  const root = path.join(claudeHome(), 'projects');
  const seen = new Set();
  const all = [];
  for (const file of transcripts(root)) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    seen.add(file);
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
      try { hit = { mtimeMs: stat.mtimeMs, size: stat.size, ...(await readRecords(file)) }; } catch { continue; }
      cache.set(file, hit);
    }
    const rel = path.relative(root, file).split(path.sep);
    const sid = rel.length > 2 ? rel[1] : path.basename(file, '.jsonl'); // a helper agent counts for the chat that started it
    for (const r of hit.records) all.push({ ...r, sid, proj: rel[0], cwd: hit.cwd });
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);

  // the same reply can sit in two transcripts (a resumed or forked chat): count it once
  const byId = new Map();
  const records = [];
  for (const r of all) {
    if (!r.id) { records.push(r); continue; }
    const old = byId.get(r.id);
    if (!old) { byId.set(r.id, r); records.push(r); } else if (r.o > old.o) Object.assign(old, r);
  }

  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const since = { today: +startOfToday, '7d': now - 7 * 864e5, '30d': now - 30 * 864e5, all: 0 }[range] ?? now - 30 * 864e5;
  const inRange = records.filter((r) => r.t >= since);

  const sum = blank();
  const models = new Map();
  const projects = new Map();
  const sessions = new Map();
  for (const r of inRange) {
    const c = costOf(r.model, r);
    add(sum, r, c);
    add(models.get(r.model) ?? models.set(r.model, blank()).get(r.model), r, c);
    const p = projects.get(r.proj) ?? projects.set(r.proj, { ...blank(), key: r.proj, dir: r.cwd, last: 0, ids: new Set() }).get(r.proj);
    add(p, r, c); p.last = Math.max(p.last, r.t); p.ids.add(r.sid); p.dir ||= r.cwd;
    const s = sessions.get(r.sid) ?? sessions.set(r.sid, { ...blank(), id: r.sid, proj: r.proj, dir: r.cwd, first: r.t, last: 0, model: '' }).get(r.sid);
    add(s, r, c); s.first = Math.min(s.first, r.t); if (r.t >= s.last) { s.last = r.t; s.model = r.model; }
  }

  // days: always the last 26 weeks, for the trend and the heatmap
  const days = new Map();
  const horizon = now - 182 * 864e5;
  for (const r of records) {
    if (r.t < horizon) continue;
    const k = dayKey(r.t);
    const d = days.get(k) ?? days.set(k, { date: k, tokens: 0, cost: 0, msgs: 0 }).get(k);
    d.tokens += total(r); d.msgs++; d.cost += costOf(r.model, r) ?? 0;
  }
  const daily = [];
  for (let t = horizon; t <= now; t += 864e5) { const k = dayKey(t); daily.push(days.get(k) ?? { date: k, tokens: 0, cost: 0, msgs: 0 }); }
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].tokens) streak++; else if (i !== daily.length - 1) break; }

  const { blocks, active } = blocksOf(records, now);
  const recentBlocks = blocks.filter((b) => b.start >= now - 30 * 864e5);
  const peak = Math.max(0, ...recentBlocks.filter((b) => b !== active).map((b) => b.tokens));
  const titles = new Map();
  try { for (const pr of listAllProjects()) for (const s of pr.sessions) titles.set(s.id, s.title); } catch { /* titles are a nicety */ }

  const shape = (o) => ({ i: o.i, o: o.o, cw: o.cw, cr: o.cr, tokens: o.i + o.o + o.cw + o.cr, msgs: o.msgs, cost: o.cost, unpriced: o.unpriced });
  const value = {
    range, generated: now, files: seen.size, price: 'USD per million tokens, API list prices',
    totals: { ...shape(sum), sessions: sessions.size },
    models: [...models].map(([model, o]) => ({ model, ...shape(o), priced: !!priceFor(model) })).sort((a, b) => b.tokens - a.tokens),
    projects: [...projects.values()].map((p) => ({ key: p.key, dir: p.dir, name: p.dir ? path.basename(p.dir) || p.dir : p.key, ...shape(p), sessions: p.ids.size, last: p.last })).sort((a, b) => b.tokens - a.tokens).slice(0, 25),
    sessions: [...sessions.values()].map((s) => ({ id: s.id, title: titles.get(s.id) || '', dir: s.dir, ...shape(s), first: s.first, last: s.last, model: s.model })).sort((a, b) => b.last - a.last).slice(0, 25),
    daily, streak, today: daily.at(-1),
    block: active ? { start: active.start, end: active.end, first: active.first, last: active.last, tokens: active.tokens, cost: active.cost, msgs: active.msgs, perMinute: active.last > active.first ? Math.round(active.tokens / ((active.last - active.first) / 60_000)) : 0 } : null,
    limit: blockLimit ?? (peak || null), limitIsAuto: blockLimit === null, peak,
  };
  report = { at: now, range, limit: blockLimit, value };
  return value;
}

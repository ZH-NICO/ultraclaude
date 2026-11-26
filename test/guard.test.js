// The cost guard: warns once per window, pauses running agents near the limit, resumes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Guard, assess } from '../src/guard.js';

const H = 3600e3;
const T0 = 1_800_000_000_000;
const block = (tokens, start = T0, perMinute = 1000) => ({ block: { start, end: start + 5 * H, tokens, perMinute }, limit: 100_000 });

function fakeProject() {
  const p = new EventEmitter();
  p.state = { agents: [{ id: 'a', name: 'Bugfixer' }, { id: 'b', name: 'Tester' }, { id: 'c', name: 'Idle one' }] };
  p.runtime = new Map([['a', { pty: {} }], ['b', { pty: {} }], ['c', { pty: null }]]);
  p.events = [];
  p.agent = (id) => p.state.agents.find((a) => a.id === id);
  p.event = (type, agent, text) => p.events.push({ type, agent, text });
  p.stopAgent = (id) => { p.runtime.get(id).pty = null; };
  p.startAgent = async (id) => { p.runtime.get(id).pty = {}; };
  return p;
}

test('assess: the level, the share and when the window is full at this pace', () => {
  const cfg = { enabled: true, warnAt: 80, pauseAt: 95, limit: null };
  assert.equal(assess(block(50_000), cfg, T0).level, 'ok');
  const w = assess(block(85_000), cfg, T0);
  assert.equal(w.level, 'warn');
  assert.equal(Math.round(w.pct), 85);
  assert.equal(w.fullAt, T0 + 15 * 60_000, '15k tokens left at 1k a minute');
  assert.equal(assess(block(96_000), cfg, T0).level, 'pause');
  assert.equal(assess(block(96_000), { ...cfg, enabled: false }, T0).level, 'ok', 'switched off');
  assert.equal(assess(block(96_000), { ...cfg, limit: 1_000_000 }, T0).level, 'ok', 'its own limit wins');
  assert.equal(assess({ block: null, limit: 5 }, cfg, T0).level, 'ok', 'no window, nothing to do');
  assert.equal(assess(block(10_000, T0, 1), cfg, T0).fullAt, null, 'not full before the window resets');
});

test('the guard warns once, pauses the running agents once and resumes them', async () => {
  const p = fakeProject();
  let r = block(50_000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-guard-')), 'guard.json');
  const g = new Guard({ file, project: p, report: async () => r, now: () => T0 });
  const changes = [];
  g.on('change', (v) => changes.push(v.level));

  await g.tick();
  assert.equal(p.events.length, 0);
  r = block(85_000); await g.tick(); await g.tick();
  assert.equal(p.events.filter((e) => /85%/.test(e.text)).length, 1, 'one warning per window');
  r = block(97_000); const v = await g.tick();
  assert.equal(p.runtime.get('a').pty, null);
  assert.equal(p.runtime.get('b').pty, null);
  assert.deepEqual(v.paused, ['Bugfixer', 'Tester'], 'only the ones that were running');
  assert.match(p.events.at(-1).text, /Paused Bugfixer, Tester/);
  await p.startAgent('a'); await g.tick();
  assert.ok(p.runtime.get('a').pty, 'an agent you start again yourself is not stopped twice in the same window');
  assert.ok(changes.includes('warn') && changes.includes('pause'));

  // a new window without auto resume: they stay paused until you say so
  r = block(1_000, T0 + 5 * H); await g.tick();
  assert.equal(p.runtime.get('b').pty, null);
  const after = await g.resume();
  assert.ok(p.runtime.get('b').pty);
  assert.deepEqual(after.paused, []);
});

test('auto resume, settings that are saved, and settings that make no sense', async () => {
  const p = fakeProject();
  let r = block(99_000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-guard-')), 'guard.json');
  const g = new Guard({ file, project: p, report: async () => r, now: () => T0 });
  await g.update({ autoResume: true });
  assert.equal(p.runtime.get('a').pty, null, 'update checks at once');
  r = { block: null, limit: 100_000 }; await g.tick();
  assert.ok(p.runtime.get('a').pty && p.runtime.get('b').pty, 'resumed when the window reset');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autoResume, true);
  assert.equal(new Guard({ file, project: p, report: async () => r }).config.autoResume, true, 'kept for the next start');
  await assert.rejects(g.update({ warnAt: 96 }), /before the pause/);
  await assert.rejects(g.update({ pauseAt: 150 }), /between 10 and 100/);
  await assert.rejects(g.update({ limit: 5 }), /at least 1000/);
  assert.equal(g.config.warnAt, 80, 'a rejected change changes nothing');
});

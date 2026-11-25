// The recording of events and the replay logic that turns them back into agent states.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentsIn, stateAt, between, density, nextEventAfter, BUSY_MS } from '../public/replay.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${name}-`));
process.env.CLAUDE_CONFIG_DIR = tmp('claude');
const { startTest } = await import('./helper.js');

const ev = (ts, type, agent, text = '') => ({ id: String(ts), ts, type, agent, text });

test('what an agent was doing at a given moment', () => {
  const events = [
    ev(1000, 'start', 'Bugfixer'), ev(2000, 'tool', 'Bugfixer', 'editing token.ts'), ev(2500, 'status', 'Bugfixer', 'now: Fixing login'),
    ev(3000, 'start', 'Tester'), ev(40_000, 'waiting', 'Tester', 'needs you: Claude needs your permission'),
    ev(50_000, 'tool', 'Tester', '$ npm test'), ev(90_000, 'stop', 'Bugfixer', 'stopped'), ev(95_000, 'message', 'user', 'hello'),
  ];
  assert.deepEqual(agentsIn(events), ['Bugfixer', 'Tester'], 'the user is not an agent');
  assert.deepEqual(stateAt(events, 2200, 'Bugfixer'), { state: 'working', activity: 'editing token.ts', status: '' });
  assert.equal(stateAt(events, 2600, 'Bugfixer').status, 'Fixing login');
  assert.equal(stateAt(events, 2500 + BUSY_MS + 1, 'Bugfixer').state, 'idle', 'quiet for 12 s');
  assert.equal(stateAt(events, 500, 'Bugfixer').state, 'idle', 'before anything was recorded');
  assert.equal(stateAt(events, 41_000, 'Tester').state, 'waiting');
  assert.equal(stateAt(events, 50_500, 'Tester').state, 'working', 'acting again ends the waiting');
  assert.equal(stateAt(events, 91_000, 'Bugfixer').state, 'stopped');
  assert.equal(stateAt(events, 91_000, 'Tester').state, 'idle');
  assert.deepEqual(between(events, 2000, 3000).map((e) => e.ts), [2500, 3000]);
  assert.deepEqual(density(events, 0, 100_000, 4), [4, 1, 1, 2]);
  assert.equal(nextEventAfter(events, 3000), 40_000);
  assert.equal(nextEventAfter(events, 95_000), null);
});

test('every event is recorded in the project folder and comes back after a restart', async (t) => {
  const dir = tmp('proj');
  const app = await startTest({ dir, vaultPath: tmp('v') });
  t.after(() => app.close()); // closing twice is fine
  const { project } = app;
  project.startAgent = async () => {};
  const a = project.createAgent({ roleId: 'tester' });
  project.setStatus(a.id, 'Running the suite');
  project.sendMessage('Tester', 'user', 'All green');
  const file = path.join(dir, '.ultraclaude', 'events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.type), ['status', 'notify']);
  assert.equal(lines[0].text, 'now: Running the suite');

  const call = async (url, headers = {}) => (await fetch(`http://127.0.0.1:${app.port}${url}`, { headers: { 'x-uc-token': app.token, ...headers } }));
  assert.equal((await call('/api/replay')).status, 401, 'a signed-in account is needed');
  const all = await (await call('/api/replay', { cookie: app.cookie })).json();
  assert.equal(all.events.length, 2);
  assert.equal(all.first, lines[0].ts);
  assert.equal((await (await call(`/api/replay?since=${lines[1].ts + 1}`, { cookie: app.cookie })).json()).events.length, 0);
  await app.close();

  fs.appendFileSync(file, '{"half a line');
  const again = await startTest({ dir, vaultPath: tmp('v') });
  t.after(() => again.close());
  assert.deepEqual(again.project.events.map((e) => e.type), ['status', 'notify'], 'the feed is filled from the recording, a torn line is skipped');
});

test('a very long recording is cut back to its newest lines', async (t) => {
  const dir = tmp('proj');
  const app = await startTest({ dir, vaultPath: tmp('v') });
  t.after(() => app.close());
  const file = path.join(dir, '.ultraclaude', 'events.jsonl');
  fs.writeFileSync(file, Array.from({ length: 31000 }, (_, i) => JSON.stringify(ev(i + 1, 'tool', 'A', `n${i}`))).join('\n') + '\n');
  const kept = app.project.recorded({ limit: 100000 });
  assert.equal(kept.length, 20000);
  assert.equal(kept.at(-1).text, 'n30999');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 20000, 'the file itself shrank');
});

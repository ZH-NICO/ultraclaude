// Mission Control: a coordinator plans, staffs within a budget, tasks count for progress, and it reports back.
// The agents' MCP calls are simulated; no real Claude Code runs (that would use your quota).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/project.js';
import { handleMcp } from '../src/mcp.js';
import { startMission, stopMission, missionViews, stageOf } from '../src/missions.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${n}-`));
let rpc = 0;
const tool = (p, agentId, name, args) => {
  const r = handleMcp(p, agentId, { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }).result;
  return { text: r.content[0].text, error: !!r.isError };
};
const toolNames = (p, agentId) => handleMcp(p, agentId, { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' }).result.tools.map((t) => t.name);

test('stageOf follows the board', () => {
  const m = { id: 'm1', status: 'running' };
  assert.equal(stageOf(m, []), 'plan');
  assert.equal(stageOf(m, [{ mission: 'm1', status: 'todo' }, { mission: 'm1', status: 'done' }]), 'work');
  assert.equal(stageOf(m, [{ mission: 'm1', status: 'done' }, { mission: 'x', status: 'todo' }]), 'check');
  assert.equal(stageOf({ ...m, status: 'done' }, []), 'done');
  assert.equal(stageOf({ ...m, status: 'stopped' }, []), 'stopped');
});

test('a mission from start to finish', () => {
  const p = new Project({ dir: tmp('proj'), vaultPath: tmp('vault') });
  const seen = [];
  p.on('missions', (v) => seen.push(v[0].stage));
  assert.throws(() => startMission(p, { goal: 'short' }), /sentence/);

  const m = startMission(p, { goal: 'Add a dark mode toggle to the settings page', budget: 2 });
  assert.equal(m.stage, 'plan');
  assert.equal(m.budget, 2);
  const lead = p.agent(m.coordinator);
  assert.equal(lead.roleId, 'lead');
  assert.ok(p.state.agents.length === 1);

  // only the coordinator gets the mission tools
  assert.ok(toolNames(p, lead.id).includes('team_start_agent'));
  const other = p.createAgent({ roleId: 'tester', name: 'Outsider' });
  assert.ok(!toolNames(p, other.id).includes('team_start_agent'));
  assert.ok(tool(p, other.id, 'team_start_agent', { role: 'feature', task: 'x' }).error, 'an outsider cannot start agents');

  // plan
  tool(p, lead.id, 'task_create', { title: 'Toggle component' });
  tool(p, lead.id, 'task_create', { title: 'Persist the choice' });
  tool(p, other.id, 'task_create', { title: 'Not part of it' });
  assert.equal(missionViews(p)[0].tasks.total, 2, 'only the team\'s tasks count');
  assert.equal(missionViews(p)[0].stage, 'work');

  // staff within the budget
  assert.match(tool(p, lead.id, 'team_start_agent', { role: 'feature', task: 'Build the toggle', name: 'Toggle dev' }).text, /1\/2/);
  assert.match(tool(p, lead.id, 'team_start_agent', { role: 'tester', task: 'Test it' }).text, /2\/2/);
  const over = tool(p, lead.id, 'team_start_agent', { role: 'docs', task: 'Docs' });
  assert.ok(over.error && /budget/.test(over.text));
  assert.ok(tool(p, lead.id, 'team_start_agent', { role: 'lead', task: 'x' }).error, 'no coordinators of coordinators');
  const v = missionViews(p)[0];
  assert.equal(v.helpers.length, 2);
  assert.equal(v.helpers[0], 'Toggle dev');

  // a helper's own task counts too, and finishing all of them moves it to check
  tool(p, p.agent('Toggle dev').id, 'task_create', { title: 'Fix contrast' });
  assert.equal(missionViews(p)[0].tasks.total, 3);
  for (const t of p.state.tasks.filter((x) => x.mission === m.id)) tool(p, lead.id, 'task_update', { id: t.id, status: 'done' });
  assert.equal(missionViews(p)[0].stage, 'check');

  // report
  assert.match(tool(p, lead.id, 'mission_done', { summary: 'Toggle added and persisted; contrast fixed.' }).text, /finished/);
  const done = missionViews(p)[0];
  assert.equal(done.stage, 'done');
  assert.match(done.summary, /contrast fixed/);
  assert.ok(!toolNames(p, lead.id).includes('team_start_agent'), 'the tools go away with the mission');
  assert.ok(p.events.some((e) => e.type === 'mission' && e.to === 'user' && /finished mission/.test(e.text)));
  assert.ok(seen.includes('plan') && seen.includes('done'));
  p.saveNow();
  assert.equal(JSON.parse(fs.readFileSync(p.stateFile, 'utf8')).missions[0].status, 'done', 'kept across restarts');
});

test('stopping a mission stops its team, and the budget is clamped', () => {
  const p = new Project({ dir: tmp('proj'), vaultPath: tmp('vault') });
  const m = startMission(p, { goal: 'Write the release notes for 2.0', budget: 50 });
  assert.equal(m.budget, 6);
  const stopped = [];
  p.stopAgent = (id) => stopped.push(id);
  const v = stopMission(p, m.id);
  assert.equal(v.stage, 'stopped');
  assert.deepEqual(stopped, [p.agent(m.coordinator).id]);
  assert.throws(() => stopMission(p, 'nope'), /no such mission/);
  startMission(p, { goal: 'Second mission goal here' }); startMission(p, { goal: 'Third mission goal here' }); startMission(p, { goal: 'Fourth mission goal here' });
  assert.throws(() => startMission(p, { goal: 'Fifth mission goal here' }), /Three missions/);
});

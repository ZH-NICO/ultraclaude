// Subagents an agent starts with Claude Code's Agent tool: they appear, get their own activity and go away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/project.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${n}-`));

test('subagents start, work, and finish, in the foreground and in the background', () => {
  const p = new Project({ dir: tmp('proj'), vaultPath: tmp('vault') });
  const a = p.createAgent({ roleId: 'feature', name: 'Dev' });
  const hook = (body) => p.handleHook(a.id, body);
  const subs = () => p.views()[0].subs;
  hook({ hook_event_name: 'SessionStart' });

  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Explore the auth code', subagent_type: 'Explore', prompt: 'x' } });
  assert.deepEqual(subs().map((s) => [s.id, s.label, s.type]), [['t1', 'Explore the auth code', 'Explore']]);
  assert.match(p.views()[0].activity, /subagent: Explore the auth code/);

  // its own tool calls carry an agent_id: they become the subagent's activity, not the agent's
  hook({ hook_event_name: 'PreToolUse', agent_id: 'sa-1', tool_name: 'Read', tool_input: { file_path: '/x/login.ts' } });
  assert.equal(subs()[0].activity, 'reading login.ts');
  assert.match(p.views()[0].activity, /subagent/);
  assert.ok(p.events.some((e) => e.type === 'tool' && /↳ Explore the auth code: reading login\.ts/.test(e.text)));

  // a second one in the background
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't2', tool_input: { description: 'Run the tests', run_in_background: true } });
  hook({ hook_event_name: 'PreToolUse', agent_id: 'sa-2', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(subs().find((s) => s.id === 't2').activity, '$ npm test', 'the next unknown agent_id binds to the subagent without one');

  // the foreground one returns; the background one keeps running past its tool result
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't1' });
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't2' });
  assert.deepEqual(subs().map((s) => s.id), ['t2']);
  hook({ hook_event_name: 'Stop' });
  assert.deepEqual(subs().map((s) => s.id), ['t2'], 'a background subagent outlives the turn');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'sa-2' });
  assert.deepEqual(subs(), []);
  const life = p.events.filter((e) => e.type === 'subagent').map((e) => `${e.op}:${e.sub}`);
  assert.deepEqual(life, ['start:t1', 'start:t2', 'end:t1', 'end:t2']);

  // a foreground subagent that never reported back is cleared when the turn ends
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 't3', tool_input: { description: 'Lost one' } });
  hook({ hook_event_name: 'Stop' });
  assert.deepEqual(subs(), []);
});

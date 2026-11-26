// Mission Control: you give one goal, a coordinator agent plans it into tasks, starts helpers within a
// budget, tracks them and reports back. Progress comes from the mission's tasks on the board.
import crypto from 'node:crypto';
import { ROLES } from './roles.js';

const HELPER_ROLES = ROLES.filter((r) => !['lead', 'custom'].includes(r.id)).map((r) => r.id);
const STAGES = ['plan', 'work', 'check', 'done'];

/** Which step a mission is at: plan (no tasks yet), work (tasks open), check (all done, not reported), done. */
export function stageOf(m, tasks) {
  if (m.status === 'done') return 'done';
  if (m.status === 'stopped') return 'stopped';
  const mine = tasks.filter((t) => t.mission === m.id);
  if (!mine.length) return 'plan';
  return mine.every((t) => t.status === 'done') ? 'check' : 'work';
}

export function missionView(project, m) {
  const tasks = project.state.tasks.filter((t) => t.mission === m.id);
  const name = (id) => project.state.agents.find((a) => a.id === id)?.name || '';
  return {
    id: m.id, goal: m.goal, status: m.status, budget: m.budget, createdAt: m.createdAt, endedAt: m.endedAt || 0, summary: m.summary || '',
    stage: stageOf(m, project.state.tasks), stages: STAGES,
    coordinator: name(m.coordinator), helpers: m.helpers.map(name).filter(Boolean),
    tasks: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length, open: tasks.filter((t) => t.status !== 'done').map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee })) },
  };
}

export const missionViews = (project) => (project.state.missions || []).map((m) => missionView(project, m)).reverse();

/** The running mission an agent belongs to, as coordinator or helper. */
export function missionOf(project, agentRef) {
  const a = project.agent(agentRef);
  if (!a) return null;
  return (project.state.missions || []).find((m) => m.status === 'running' && (m.coordinator === a.id || m.helpers.includes(a.id))) || null;
}

const changed = (project) => { project.save(); project.emit('missions', missionViews(project)); };

export function startMission(project, { goal, budget = 3 }) {
  const text = String(goal ?? '').trim();
  if (text.length < 8) throw new Error('Describe the goal in a sentence or two.');
  const max = Math.min(6, Math.max(1, Math.round(Number(budget) || 3)));
  project.state.missions ||= [];
  if (project.state.missions.filter((m) => m.status === 'running').length >= 3) throw new Error('Three missions are already running. Stop one first.');
  const m = { id: crypto.randomBytes(3).toString('hex'), goal: text.slice(0, 2000), status: 'running', budget: max, helpers: [], coordinator: '', createdAt: Date.now() };
  project.state.missions.push(m);
  const lead = project.createAgent({ roleId: 'lead', name: `Mission ${m.id}`, prompt: briefing(m) });
  m.coordinator = lead.id;
  project.event('mission', 'user', `started a mission: ${text}`, { mission: m.id });
  changed(project);
  return missionView(project, m);
}

function briefing(m) {
  return `[UltraClaude mission ${m.id}] Goal: ${m.goal}
You coordinate this mission. Work in these steps:
1. Plan: read the code and shared memory as needed, then put every piece of work on the board with task_create, one task each, with clear acceptance criteria.
2. Staff it: start up to ${m.budget} helper agents with team_start_agent (roles: ${HELPER_ROLES.join(', ')}). Give each one a concrete task and assign its board task to it with task_update. Do the work yourself when a helper is not worth it.
3. Track: follow the board and your messages, answer questions, check results, and send work back when it is not good enough.
4. Finish: when every task is done and checked, call mission_done with a short summary for the user of what was done and what is left.
Stay within the budget. If the goal is unclear, ask the user with send_message to "user".`;
}

export function stopMission(project, id) {
  const m = (project.state.missions || []).find((x) => x.id === id);
  if (!m) throw new Error('There is no such mission.');
  if (m.status !== 'running') return missionView(project, m);
  m.status = 'stopped';
  m.endedAt = Date.now();
  for (const aid of [m.coordinator, ...m.helpers]) project.stopAgent(aid);
  project.event('mission', 'user', `stopped mission ${m.id}`, { mission: m.id });
  changed(project);
  return missionView(project, m);
}

// ---------- the coordinator's tools ----------

export const MISSION_TOOLS = [
  { name: 'team_start_agent', description: 'Mission coordinator only: start a helper agent with a role and a first task. Counts against the mission budget.',
    inputSchema: { type: 'object', properties: {
      role: { type: 'string', enum: HELPER_ROLES, description: 'The helper\'s role' },
      task: { type: 'string', description: 'What the helper should do first, concrete and self-contained' },
      name: { type: 'string', description: 'Optional name; by default the role name' },
    }, required: ['role', 'task'] } },
  { name: 'mission_done', description: 'Mission coordinator only: finish the mission and report to the user.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'What was done, what is left, anything the user must check' } }, required: ['summary'] } },
];

/** The extra tools an agent sees: only the coordinator of a running mission gets them. */
export const toolsFor = (project, agent) => ((project.state.missions || []).some((m) => m.status === 'running' && m.coordinator === agent.id) ? MISSION_TOOLS : []);

export function callMissionTool(project, agent, name, args = {}) {
  const m = (project.state.missions || []).find((x) => x.status === 'running' && x.coordinator === agent.id);
  if (!m) throw new Error('Only the coordinator of a running mission can do this.');
  if (name === 'team_start_agent') {
    if (!HELPER_ROLES.includes(args.role)) throw new Error(`role must be one of ${HELPER_ROLES.join(', ')}`);
    if (!String(args.task || '').trim()) throw new Error('Give the helper a task.');
    if (m.helpers.length >= m.budget) throw new Error(`The budget of ${m.budget} helpers is used up. Reuse a helper with send_message, or do it yourself.`);
    const helper = project.createAgent({ roleId: args.role, name: args.name, prompt: `[UltraClaude mission ${m.id}, coordinated by ${agent.name}] Mission goal: ${m.goal}\nYour task: ${String(args.task).trim()}\nReport to ${agent.name} with send_message when done or stuck, and keep your board task up to date.` });
    m.helpers.push(helper.id);
    project.event('mission', agent.name, `started ${helper.name} for mission ${m.id}`, { mission: m.id, to: helper.name });
    changed(project);
    return `Started ${helper.name} (${m.helpers.length}/${m.budget} helpers used). It begins with its task now.`;
  }
  if (name === 'mission_done') {
    m.status = 'done';
    m.endedAt = Date.now();
    m.summary = String(args.summary || '').trim().slice(0, 4000);
    project.event('mission', agent.name, `finished mission ${m.id}: ${m.summary}`, { mission: m.id, to: 'user' });
    changed(project);
    return 'The mission is finished and the user sees your summary. Helpers keep running until the user stops them.';
  }
  throw new Error(`Unknown tool: ${name}`);
}

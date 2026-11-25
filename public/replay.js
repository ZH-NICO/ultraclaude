// The replay: works out from the recorded events what every agent was doing at a given moment.
// Pure functions, so the same code runs in the window and in the tests.

export const BUSY_MS = 12_000; // an agent that did something in the last 12 s counts as working
const DOING = new Set(['tool', 'status', 'message', 'notify', 'memory', 'task']);

/** The agents that appear in the events, in order of first appearance. */
export function agentsIn(events) {
  const seen = new Set();
  for (const e of events) if (e.agent && e.agent !== 'user') seen.add(e.agent);
  return [...seen];
}

/** State of one agent at time `t`: working, waiting, idle or stopped, with what it was last doing. */
export function stateAt(events, t, name) {
  let alive = true;
  let lastDoing = 0;
  let lastWaiting = 0;
  let activity = '';
  let status = '';
  for (const e of events) {
    if (e.ts > t) break;
    if (e.agent !== name) continue;
    if (e.type === 'start') alive = true;
    else if (e.type === 'stop') alive = false;
    else if (e.type === 'waiting') lastWaiting = e.ts;
    else if (DOING.has(e.type)) {
      lastDoing = e.ts;
      if (e.type === 'tool') activity = e.text;
      if (e.type === 'status') status = e.text.replace(/^now: /, '');
    }
  }
  if (!alive) return { state: 'stopped', activity: '', status };
  if (lastWaiting && lastWaiting >= lastDoing) return { state: 'waiting', activity: 'needs you', status };
  if (lastDoing && t - lastDoing < BUSY_MS) return { state: 'working', activity, status };
  return { state: 'idle', activity: '', status };
}

/** The events that happened in the half-open window (from, to]. */
export function between(events, from, to) {
  return events.filter((e) => e.ts > from && e.ts <= to);
}

/** Events per bucket, for the strip above the timeline. */
export function density(events, from, to, buckets) {
  const out = new Array(buckets).fill(0);
  const span = Math.max(1, to - from);
  for (const e of events) {
    if (e.ts < from || e.ts > to) continue;
    out[Math.min(buckets - 1, Math.floor(((e.ts - from) / span) * buckets))]++;
  }
  return out;
}

/** Shortens a long quiet stretch so that the replay does not sit still: returns the next time something happens. */
export function nextEventAfter(events, t) {
  for (const e of events) if (e.ts > t) return e.ts;
  return null;
}

// The cost guard: watches the current 5-hour window, warns before it is used up and pauses the
// running agents when it is nearly full, so a forgotten team does not burn the rest of the window.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = { enabled: true, warnAt: 80, pauseAt: 95, autoResume: false, limit: null };

/** How full the window is and when it will be full at the current pace. Pure, for the tests. */
export function assess(report, cfg, now = Date.now()) {
  const b = report?.block;
  const limit = cfg.limit ?? report?.limit ?? null;
  if (!b || !limit) return { level: 'ok', pct: 0, tokens: b?.tokens ?? 0, limit, block: b?.start ?? null, end: b?.end ?? null, fullAt: null };
  const pct = (b.tokens / limit) * 100;
  const fullAt = b.perMinute > 0 && b.tokens < limit ? now + ((limit - b.tokens) / b.perMinute) * 60_000 : null;
  const level = !cfg.enabled ? 'ok' : pct >= cfg.pauseAt ? 'pause' : pct >= cfg.warnAt ? 'warn' : 'ok';
  return { level, pct, tokens: b.tokens, limit, block: b.start, end: b.end, fullAt: fullAt && fullAt < b.end ? fullAt : null };
}

export class Guard extends EventEmitter {
  /** `report()` returns a usage report; `project` is used to stop and start agents. */
  constructor({ file, project, report, now = Date.now }) {
    super();
    this.file = file;
    this.project = project;
    this.report = report;
    this.now = now;
    this.config = { ...DEFAULTS };
    try { Object.assign(this.config, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* defaults */ }
    this.state = assess(null, this.config);
    this.warned = null; // the window that was already warned about
    this.pausedIn = null; // the window in which agents were paused
    this.paused = []; // ids of the agents the guard stopped
  }

  async update(patch = {}) {
    const c = { ...this.config };
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.autoResume !== undefined) c.autoResume = !!patch.autoResume;
    for (const k of ['warnAt', 'pauseAt']) if (patch[k] !== undefined) c[k] = Math.round(Number(patch[k]));
    if (patch.limit !== undefined) c.limit = patch.limit === null || patch.limit === '' ? null : Math.round(Number(patch.limit));
    if (![c.warnAt, c.pauseAt].every((v) => Number.isFinite(v) && v >= 10 && v <= 100)) throw new Error('Percentages must be between 10 and 100.');
    if (c.warnAt >= c.pauseAt) throw new Error('The warning must come before the pause.');
    if (c.limit !== null && !(c.limit >= 1000)) throw new Error('The limit must be at least 1000 tokens.');
    this.config = c;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(c, null, 2)); } catch { /* kept for this run */ }
    return this.tick();
  }

  view() {
    const names = this.paused.map((id) => this.project.agent(id)?.name).filter(Boolean);
    return { ...this.config, ...this.state, paused: names };
  }

  async tick() {
    let report;
    try { report = await this.report(); } catch { return this.view(); }
    const s = assess(report, this.config, this.now());
    const before = this.state.level;
    this.state = s;
    if (s.level === 'warn' && this.warned !== s.block) {
      this.warned = s.block;
      this.project.event('guard', 'Cost guard', `${Math.round(s.pct)}% of this 5-hour window is used${s.fullAt ? `; at this pace it is full at ${clock(s.fullAt)}` : ''}.`);
    }
    if (s.level === 'pause' && this.pausedIn !== s.block) {
      this.pausedIn = s.block;
      this.warned = s.block;
      const running = this.project.state.agents.filter((a) => this.project.runtime.get(a.id)?.pty);
      this.paused = running.map((a) => a.id);
      for (const a of running) this.project.stopAgent(a.id);
      this.project.event('guard', 'Cost guard', `${Math.round(s.pct)}% of this 5-hour window is used. ${running.length ? `Paused ${running.map((a) => a.name).join(', ')}.` : 'No agent was running.'} The window resets at ${clock(s.end)}.`);
    }
    // a new window (or none at all): the paused agents may continue if the person wants that
    if (this.paused.length && this.pausedIn !== null && s.block !== this.pausedIn && this.config.autoResume) await this.resume('the window reset');
    if (before !== s.level || s.level !== 'ok') this.emit('change', this.view());
    return this.view();
  }

  /** Starts the agents the guard paused again. */
  async resume(why = 'you asked') {
    const ids = this.paused;
    this.paused = [];
    for (const id of ids) if (this.project.agent(id)) await this.project.startAgent(id).catch(() => {});
    if (ids.length) this.project.event('guard', 'Cost guard', `resumed ${ids.length === 1 ? 'one agent' : `${ids.length} agents`} because ${why}.`);
    this.emit('change', this.view());
    return this.view();
  }
}

const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

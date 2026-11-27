// Accounts for the window: sign-up, sign-in, sessions and per-user settings.
// Stored in one file (~/.ultraclaude/users.json, readable by its owner only).
// Passwords are never stored: only a salted scrypt hash. Session tokens are random, handed to the
// browser in a cookie and stored only as a SHA-256 hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KDF = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_MS = 30 * 864e5; // a session ends after 30 days without use
const GUEST_MS = 12 * 3600e3; // a guest session after 12 hours
const LOCK_AFTER = 5; // failed sign-ins for one email before it is locked
const THEMES = ['system', 'light', 'dark'];
const COMMON = ['password', 'passwort', 'qwerty', 'letmein', 'iloveyou', '12345678', 'abcdefgh', 'ultraclaude'];

export class AuthError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clean = (s) => String(s ?? '').normalize('NFC').trim();

export function validName(label, value) {
  const v = clean(value);
  if (!v) throw new AuthError(`Enter your ${label}.`);
  if (v.length > 50 || /[\u0000-\u001f<>]/.test(v)) throw new AuthError(`That ${label} cannot be used.`);
  return v;
}

/** A name from Google, trimmed to what an account may hold. */
const looseName = (value, fallback) => clean(value).replace(/[\u0000-\u001f<>]/g, '').slice(0, 50) || fallback;

export function validEmail(value) {
  const v = clean(value).toLowerCase();
  if (v.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>".]{2,}$/.test(v)) throw new AuthError('Enter a valid email address.');
  return v;
}

export function validPassword(value, email = '') {
  const v = String(value ?? '');
  if (v.length < 10) throw new AuthError('Use at least 10 characters for the password.');
  if (v.length > 200) throw new AuthError('The password is too long (200 characters at most).');
  if (new Set(v).size < 4) throw new AuthError('That password is too easy to guess.');
  const lower = v.toLowerCase();
  const local = email.split('@')[0];
  if (COMMON.some((c) => lower.includes(c)) || (local.length >= 4 && lower.includes(local))) throw new AuthError('That password is too easy to guess. Avoid common words and your email.');
  return v;
}

function validAvatar(value) {
  if (value === null || value === '') return '';
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
  if (!m || value.length > 300_000) throw new AuthError('Use a PNG, JPEG or WebP picture under 200 kB.');
  const head = Buffer.from(m[2].slice(0, 24), 'base64');
  const ok = { png: head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), jpeg: head[0] === 0xff && head[1] === 0xd8, webp: head.subarray(0, 4).toString() === 'RIFF' };
  if (!ok[m[1]]) throw new AuthError('That file is not a valid picture.');
  return value;
}

async function hash(password, salt = crypto.randomBytes(16)) {
  const key = await scrypt(password, salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p });
  return { salt: salt.toString('hex'), key: key.toString('hex'), N: KDF.N, r: KDF.r, p: KDF.p };
}

async function verify(password, h) {
  const key = await scrypt(password, Buffer.from(h.salt, 'hex'), 64, { N: h.N, r: h.r, p: h.p });
  return same(key.toString('hex'), h.key);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class Accounts {
  constructor(file) {
    this.file = file;
    this.data = { users: [], sessions: [] };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((s) => now - s.lastSeen < SESSION_MS && this.data.users.some((u) => u.id === s.userId));
    this.data.settings = { allowGuest: true, ...this.data.settings };
    this.guests = []; // guest sessions: kept in memory only, gone when the server stops
    this.guestUser = { id: 'guest', guest: true, firstName: 'Guest', lastName: '', email: '', avatar: '', createdAt: 0, prefs: { theme: 'system', termFont: 13, notify: true, blockLimit: null } };
    this.fails = new Map(); // email -> { count, until }
    this.recent = []; // timestamps of all sign-in attempts, for a global brake
  }

  #save() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(this.data);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, this.file); // all or nothing
    } catch {
      // Windows refuses the rename while a virus scanner or another program holds the file for a moment.
      // Writing in place is not atomic, but it is better than losing the change.
      fs.writeFileSync(this.file, text, { mode: 0o600 });
      fs.rmSync(tmp, { force: true });
    }
  }

  #saveLater() { clearTimeout(this.timer); this.timer = setTimeout(() => this.#save(), 5000); this.timer.unref?.(); }

  count() { return this.data.users.length; }

  publicUser(u) {
    return { id: u.id, guest: !!u.guest, google: !!u.google, hasPassword: !!u.pass, firstName: u.firstName, lastName: u.lastName, email: u.email, avatar: u.avatar || '', createdAt: u.createdAt, prefs: u.prefs };
  }

  /** Whether the sign-in screen offers "Continue without signing in". Saved with the accounts. */
  get allowGuest() { return this.data.settings.allowGuest !== false; }

  set allowGuest(on) {
    this.data.settings.allowGuest = !!on;
    if (!on) this.guests = []; // turning it off ends every guest session
    this.#save();
  }

  /** A session without an account. It only lasts 12 hours without use and is not written to disk. */
  startGuest(meta = {}) {
    if (!this.allowGuest) throw new AuthError('Please sign in.', 403);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.guests.push({ id: crypto.randomBytes(6).toString('hex'), hash: sha(token), userId: 'guest', createdAt: now, lastSeen: now, agent: String(meta.agent || '').slice(0, 200) });
    return { token, maxAge: GUEST_MS / 1000 };
  }

  async signup({ firstName, lastName, email, password }) {
    const e = validEmail(email);
    const user = { id: crypto.randomUUID(), firstName: validName('first name', firstName), lastName: validName('last name', lastName), email: e, avatar: '', createdAt: Date.now(), prefs: { theme: 'system', termFont: 13, notify: true, blockLimit: null } };
    validPassword(password, e);
    if (this.data.users.some((u) => u.email === e)) throw new AuthError('There is already an account with this email. Sign in instead.', 409);
    user.pass = await hash(password);
    if (this.data.users.some((u) => u.email === e)) throw new AuthError('There is already an account with this email. Sign in instead.', 409); // two sign-ups at once
    this.data.users.push(user);
    this.#save();
    return user;
  }

  /** Throws when `key` (an email, or "signup") is locked or when attempts come in too fast overall. */
  brake(email) {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= 30) throw new AuthError('Too many sign-in attempts. Wait a minute.', 429, { retryAfter: 60 });
    this.recent.push(now);
    const f = this.fails.get(email);
    if (f?.until > now) throw new AuthError(`Too many wrong passwords. Try again in ${Math.ceil((f.until - now) / 1000)} seconds.`, 429, { retryAfter: Math.ceil((f.until - now) / 1000) });
  }

  /** Checks the password and opens a session. The error is the same for an unknown email and a wrong password. */
  async login(email, password, meta = {}) {
    const e = clean(email).toLowerCase();
    this.brake(e);
    const user = this.data.users.find((u) => u.email === e);
    this.dummy ||= await hash('not-a-real-password', Buffer.alloc(16, 1)); // equal work whether or not the account exists
    const ok = await verify(String(password ?? '').slice(0, 200), user?.pass || this.dummy); // an account made with Google has no password
    if (!user?.pass || !ok) {
      const f = this.fails.get(e) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= LOCK_AFTER) f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - LOCK_AFTER));
      this.fails.set(e, f);
      throw new AuthError('The email or password is wrong.', 401);
    }
    this.fails.delete(e);
    return { user, ...this.#open(user, meta) };
  }

  /**
   * The account behind a Google identity: the one already connected, the signed-in one that asked to be
   * connected (`linkId`), or a new one. An existing password account is never joined just because the
   * email is the same: whoever made it would get into it, or hand theirs to someone else.
   */
  google({ sub, email, firstName, lastName }, linkId = null) {
    const e = validEmail(email);
    const known = this.data.users.find((u) => u.google === sub);
    if (linkId) {
      const user = this.data.users.find((u) => u.id === linkId);
      if (!user) throw new AuthError('That account does not exist any more.', 404);
      if (known && known !== user) throw new AuthError('This Google account is already connected to another account here.', 409);
      user.google = sub;
      this.#save();
      return user;
    }
    if (known) return known;
    if (this.data.users.some((u) => u.email === e)) throw new AuthError('There is already an account with this email. Sign in with your password, then choose Connect Google under Settings → Security.', 409);
    const user = { id: crypto.randomUUID(), firstName: looseName(firstName, e.split('@')[0]), lastName: looseName(lastName, ''), email: e, avatar: '', google: sub, createdAt: Date.now(), prefs: { theme: 'system', termFont: 13, notify: true, blockLimit: null } };
    this.data.users.push(user);
    this.#save();
    return user;
  }

  /** Opens a session for a user who just proved who they are (sign-up, or a password check done elsewhere). */
  start(user, meta = {}) { return this.#open(user, meta); }

  #open(user, meta) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.data.sessions.push({ id: crypto.randomBytes(6).toString('hex'), hash: sha(token), userId: user.id, createdAt: now, lastSeen: now, agent: String(meta.agent || '').slice(0, 200) });
    this.#save();
    return { token, maxAge: SESSION_MS / 1000 };
  }

  /** The session behind a Cookie header, or null. */
  fromCookie(header, cookieName) {
    const token = parseCookies(header)[cookieName];
    if (!token || token.length > 100) return null;
    const h = sha(token);
    const now = Date.now();
    const guest = this.allowGuest && this.guests.find((x) => same(x.hash, h));
    if (guest) {
      if (now - guest.lastSeen > GUEST_MS) { this.guests = this.guests.filter((x) => x !== guest); return null; }
      guest.lastSeen = now;
      return { user: this.guestUser, session: guest };
    }
    const s = this.data.sessions.find((x) => same(x.hash, h));
    if (!s || now - s.lastSeen > SESSION_MS) return null;
    const user = this.data.users.find((u) => u.id === s.userId);
    if (!user) return null;
    if (now - s.lastSeen > 3600_000) { s.lastSeen = now; this.#saveLater(); }
    return { user, session: s };
  }

  logout(session) {
    this.guests = this.guests.filter((s) => s !== session);
    this.data.sessions = this.data.sessions.filter((s) => s !== session);
    this.#save();
  }

  sessionsOf(user, current) {
    return this.data.sessions.filter((s) => s.userId === user.id).sort((a, b) => b.lastSeen - a.lastSeen)
      .map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, agent: s.agent, current: s === current }));
  }

  revoke(user, id) {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => !(s.userId === user.id && s.id === id));
    if (this.data.sessions.length === before) throw new AuthError('That session does not exist any more.', 404);
    this.#save();
  }

  revokeOthers(user, keep) { this.data.sessions = this.data.sessions.filter((s) => s.userId !== user.id || s === keep); this.#save(); }

  async #needPassword(user, password) {
    if (!user.pass) throw new AuthError('Set a password first, under Settings → Security.', 403);
    if (!(await verify(String(password ?? '').slice(0, 200), user.pass))) throw new AuthError('The current password is wrong.', 403);
  }

  async updateProfile(user, { firstName, lastName, avatar, email, password }) {
    const next = {};
    if (firstName !== undefined) next.firstName = validName('first name', firstName);
    if (lastName !== undefined) next.lastName = user.google && !clean(lastName) ? '' : validName('last name', lastName); // some Google accounts have one name
    if (avatar !== undefined) next.avatar = validAvatar(avatar);
    if (email !== undefined && clean(email).toLowerCase() !== user.email) {
      const e = validEmail(email);
      await this.#needPassword(user, password);
      if (this.data.users.some((u) => u.email === e)) throw new AuthError('There is already an account with this email.', 409);
      next.email = e;
    }
    Object.assign(user, next);
    this.#save();
    return user;
  }

  /** Changes the password and signs out every other device. */
  async changePassword(user, current, next, keep) {
    if (user.pass) await this.#needPassword(user, current); // a Google account sets its first password with its session
    validPassword(next, user.email);
    user.pass = await hash(next);
    this.revokeOthers(user, keep);
  }

  setPrefs(user, p = {}) {
    const prefs = { ...user.prefs };
    if (p.theme !== undefined) { if (!THEMES.includes(p.theme)) throw new AuthError('Unknown theme.'); prefs.theme = p.theme; }
    if (p.termFont !== undefined) { const n = Math.round(Number(p.termFont)); if (!(n >= 10 && n <= 22)) throw new AuthError('The font size must be between 10 and 22.'); prefs.termFont = n; }
    if (p.notify !== undefined) prefs.notify = !!p.notify;
    if (p.blockLimit !== undefined) {
      const n = p.blockLimit === null || p.blockLimit === '' ? null : Math.round(Number(p.blockLimit));
      if (n !== null && !(n >= 1000 && n <= 1e10)) throw new AuthError('Enter a token limit of at least 1,000, or leave it empty.');
      prefs.blockLimit = n;
    }
    user.prefs = prefs;
    this.#save();
    return user;
  }

  async deleteAccount(user, password) {
    // without a password, typing the account's email is the confirmation
    if (user.pass) await this.#needPassword(user, password);
    else if (clean(password).toLowerCase() !== user.email) throw new AuthError('Type your email address to confirm.', 403);
    this.data.users = this.data.users.filter((u) => u !== user);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== user.id);
    this.#save();
  }
}

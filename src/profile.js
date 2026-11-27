// Who uses this window: first name, last name and date of birth, plus the look of the window. One file on
// this computer (~/.ultraclaude/profile.json, readable by its owner only). It is not a sign-in: what
// protects the window is the secret in its address and that the server only listens on 127.0.0.1.
import fs from 'node:fs';
import path from 'node:path';

const THEMES = ['system', 'light', 'dark'];
const DEFAULTS = { theme: 'system', termFont: 13, notify: true, blockLimit: null };
const clean = (s) => String(s ?? '').normalize('NFC').trim();
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function validName(label, value) {
  const v = clean(value);
  if (!v) throw new Error(`Enter your ${label}.`);
  if (v.length > 50 || /[\u0000-\u001f<>]/.test(v)) throw new Error(`That ${label} cannot be used.`);
  return v;
}

/** A real day, as YYYY-MM-DD, not in the future and not more than 130 years back. */
export function validBirthDate(value, now = new Date()) {
  const v = clean(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== v) throw new Error('Enter your date of birth.');
  if (d > now || now.getUTCFullYear() - +m[1] > 130) throw new Error('That date of birth cannot be right.');
  return v;
}

function validAvatar(value) {
  if (value === null || value === '') return '';
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
  if (!m || value.length > 300_000) throw new Error('Use a PNG, JPEG or WebP picture under 200 kB.');
  const head = Buffer.from(m[2].slice(0, 24), 'base64');
  const ok = { png: head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), jpeg: head[0] === 0xff && head[1] === 0xd8, webp: head.subarray(0, 4).toString() === 'RIFF' };
  if (!ok[m[1]]) throw new Error('That file is not a valid picture.');
  return value;
}

export class Profile {
  constructor(file) {
    this.file = file;
    this.data = read(file);
  }

  /** The profile, or null before it was filled in. */
  view() { return this.data && { ...this.data, prefs: { ...DEFAULTS, ...this.data.prefs } }; }

  /** What an account from an earlier version already knows, to fill the form in advance. */
  suggestion() {
    const old = read(path.join(path.dirname(this.file), 'users.json'))?.users?.[0];
    return old ? { firstName: old.firstName, lastName: old.lastName } : null;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  /** Creates the profile, or changes the fields that are given. */
  save({ firstName, lastName, birthDate, avatar } = {}) {
    const now = this.data;
    const next = {
      firstName: now && firstName === undefined ? now.firstName : validName('first name', firstName),
      lastName: now && lastName === undefined ? now.lastName : validName('last name', lastName),
      birthDate: now && birthDate === undefined ? now.birthDate : validBirthDate(birthDate),
      avatar: avatar === undefined ? now?.avatar || '' : validAvatar(avatar),
    };
    const old = now ? null : read(path.join(path.dirname(this.file), 'users.json'))?.users?.[0];
    this.data = { ...next, createdAt: now?.createdAt || Date.now(), prefs: now?.prefs || { ...DEFAULTS, ...old?.prefs } };
    this.#save();
    return this.view();
  }

  setPrefs(p = {}) {
    if (!this.data) throw new Error('Enter your name first.');
    const prefs = { ...DEFAULTS, ...this.data.prefs };
    if (p.theme !== undefined) { if (!THEMES.includes(p.theme)) throw new Error('Unknown theme.'); prefs.theme = p.theme; }
    if (p.termFont !== undefined) { const n = Math.round(Number(p.termFont)); if (!(n >= 10 && n <= 22)) throw new Error('The font size must be between 10 and 22.'); prefs.termFont = n; }
    if (p.notify !== undefined) prefs.notify = !!p.notify;
    if (p.blockLimit !== undefined) {
      const n = p.blockLimit === null || p.blockLimit === '' ? null : Math.round(Number(p.blockLimit));
      if (n !== null && !(n >= 1000 && n <= 1e10)) throw new Error('Enter a token limit of at least 1,000, or leave it empty.');
      prefs.blockLimit = n;
    }
    this.data.prefs = prefs;
    this.#save();
    return this.view();
  }
}

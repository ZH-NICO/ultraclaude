// Sign in with Google, the way Google asks desktop apps to do it: the browser goes to Google, Google sends
// it back to this server on 127.0.0.1, and the server swaps the code for the identity (with PKCE).
// The window that started it then collects its session with a one-time handle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AuthError } from './accounts.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const LIFE = 10 * 60_000;
const random = () => crypto.randomBytes(32).toString('base64url');

export class Google {
  constructor({ accounts, files, get = fetch }) {
    this.accounts = accounts;
    this.files = files; // where the OAuth client may be, first one wins
    this.get = get;
    this.pending = new Map(); // state -> { handle, verifier, nonce, redirect, link, at, result }
  }

  /** The OAuth client, as Google's downloaded client_secret_….json or just { client_id, client_secret }. */
  config() {
    for (const file of this.files) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const c = j.installed || j.web || j;
        if (c.client_id && c.client_secret) return { id: String(c.client_id), secret: String(c.client_secret) };
      } catch { /* not there or not readable */ }
    }
    return null;
  }

  #prune() {
    for (const [state, p] of this.pending) if (Date.now() - p.at > LIFE) this.pending.delete(state);
    while (this.pending.size >= 20) this.pending.delete(this.pending.keys().next().value);
  }

  /** `link` is the signed-in account that wants Google added to it, if any. */
  start({ port, link = null }) {
    const c = this.config();
    if (!c) throw new AuthError('Google sign-in is not set up on this computer yet. See “Sign in with Google” in the README.', 501);
    this.#prune();
    const state = random(); const handle = random(); const verifier = random(); const nonce = random();
    const redirect = `http://127.0.0.1:${port}/auth/google/callback`;
    this.pending.set(state, { handle, verifier, nonce, redirect, link: link?.id || null, at: Date.now(), result: null });
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' });
    return { url: `${AUTH}?${q}`, handle };
  }

  /** Google sent the browser back. Returns what the browser page should say. */
  async callback(query) {
    const p = this.pending.get(query.get('state') || '');
    if (!p || p.result || p.busy || Date.now() - p.at > LIFE) return { ok: false, message: 'This sign-in link is no longer valid. Start again in UltraClaude.' };
    p.busy = true;
    try {
      if (query.get('error') || !query.get('code')) throw new AuthError('Google sign-in was cancelled.');
      const c = this.config();
      const r = await this.get(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ code: query.get('code'), client_id: c.id, client_secret: c.secret, redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier }).toString() });
      if (!r.ok) throw new AuthError('Google did not accept the sign-in. Check the client ID and secret.');
      const who = identity((await r.json()).id_token, c.id, p.nonce);
      p.result = { userId: this.accounts.google(who, p.link).id };
      return { ok: true, message: 'You are signed in. Go back to the UltraClaude window.' };
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'Google could not be reached.';
      p.result = { error: message };
      return { ok: false, message };
    }
  }

  /** The window asks whether its sign-in is through. A finished one can be collected once. */
  finish(handle) {
    const hit = [...this.pending].find(([, p]) => p.handle === handle);
    if (!hit || Date.now() - hit[1].at > LIFE) throw new AuthError('The Google sign-in took too long. Try again.');
    const [state, p] = hit;
    if (!p.result) return { pending: true };
    this.pending.delete(state);
    if (p.result.error) throw new AuthError(p.result.error);
    const user = this.accounts.data.users.find((u) => u.id === p.result.userId);
    if (!user) throw new AuthError('That account does not exist any more.');
    return { user, link: p.link };
  }
}

/**
 * Who the ID token speaks for. It came straight from Google over TLS in answer to our own request, so
 * Google's rules need no signature check; who it is for, who issued it, its age and our nonce are checked.
 */
export function identity(idToken, clientId, nonce, now = Date.now()) {
  let c;
  try { c = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); } catch { throw new AuthError('Google sent an answer that cannot be read.'); }
  if (c.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) || !(c.exp * 1000 > now) || c.nonce !== nonce || !c.sub) throw new AuthError('Google sent an answer that does not belong to this sign-in.');
  if (!c.email || c.email_verified !== true) throw new AuthError('Your Google account has no verified email address.');
  return { sub: String(c.sub), email: c.email, firstName: c.given_name || c.name || '', lastName: c.family_name || '' };
}

// Sign in with Google against a stand-in for Google's token address: the whole round trip through the
// server, and everything that must be refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from '../src/server.js';
import { identity } from '../src/google.js';

const CLIENT = 'demo.apps.googleusercontent.com';
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const good = (nonce, more = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: '1001', email: 'Gina@Example.com', email_verified: true, given_name: 'Gina', family_name: 'Google', ...more });

test('the identity must be meant for this sign-in', () => {
  assert.equal(identity(jwt(good('n')), CLIENT, 'n').sub, '1001');
  for (const bad of [{ aud: 'someone-else' }, { iss: 'https://evil.example' }, { exp: 1 }, { nonce: 'other' }, { email_verified: false }, { email_verified: 'true' }, { sub: '' }]) {
    assert.throws(() => identity(jwt(good('n', bad)), CLIENT, 'n'), /Google/, JSON.stringify(bad));
  }
  assert.throws(() => identity('rubbish', CLIENT, 'n'), /cannot be read/);
});

test('sign in with Google through the server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-google-'));
  const config = path.join(dir, 'google.json');
  let claims; let sent;
  const app = await startServer({
    dir, vaultPath: path.join(dir, 'vault'), usersFile: path.join(dir, 'users.json'), googleFiles: [config],
    googleFetch: async (url, opts) => { sent = { url, body: new URLSearchParams(opts.body) }; return { ok: true, json: async () => ({ id_token: jwt(claims) }) }; },
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (method, url, body, cookie = '') => {
    const r = await fetch(base + url, { method, headers: { 'x-uc-token': app.token, 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };

  assert.equal((await api('GET', '/api/auth/me')).body.google, false);
  assert.match((await api('POST', '/api/auth/google/start', {})).body.error, /not set up/);
  fs.writeFileSync(config, JSON.stringify({ installed: { client_id: CLIENT, client_secret: 'shh' } }));
  assert.equal((await api('GET', '/api/auth/me')).body.google, true, 'picked up without a restart');
  assert.equal((await fetch(`${base}/api/auth/google/start`, { method: 'POST' })).status, 403, 'only the window may start a sign-in');

  /** The round trip: start, Google calls back, the window collects. */
  const round = async (person = {}, cookie = '', query = {}) => {
    const start = await api('POST', '/api/auth/google/start', {}, cookie);
    const u = new URL(start.body.url);
    assert.equal(u.origin, 'https://accounts.google.com');
    assert.deepEqual((await api('POST', '/api/auth/google/finish', { handle: start.body.handle })).body, { pending: true });
    claims = good(u.searchParams.get('nonce'), person);
    const back = await fetch(`${base}/auth/google/callback?${new URLSearchParams({ state: u.searchParams.get('state'), code: 'abc', ...query })}`);
    return { u, start, back, page: await back.text(), done: await api('POST', '/api/auth/google/finish', { handle: start.body.handle }, cookie) };
  };

  const first = await round();
  assert.equal(first.back.status, 200);
  assert.ok(!first.page.includes(app.token) && !first.back.headers.get('set-cookie'), 'the browser page gets neither the address token nor a session');
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  assert.equal(crypto.createHash('sha256').update(sent.body.get('code_verifier')).digest('base64url'), first.u.searchParams.get('code_challenge'), 'PKCE');
  assert.equal(sent.body.get('redirect_uri'), `${base}/auth/google/callback`);
  assert.deepEqual([first.done.body.user.email, first.done.body.user.google, first.done.body.user.hasPassword], ['gina@example.com', true, false]);
  assert.match(first.done.cookie, /^uc_session=.+/);
  assert.equal((await api('GET', '/api/auth/me', null, first.done.cookie)).body.user.firstName, 'Gina');
  assert.match((await api('POST', '/api/auth/google/finish', { handle: first.start.body.handle })).body.error, /too long/, 'collected only once');
  const replay = await fetch(`${base}/auth/google/callback?state=${first.u.searchParams.get('state')}&code=abc`);
  assert.equal(replay.status, 400);
  assert.equal((await round()).done.body.user.id, first.done.body.user.id, 'the same Google account, the same account here');

  // no password: cannot sign in with one, sets a first one with the session
  assert.equal((await api('POST', '/api/auth/login', { email: 'gina@example.com', password: '' })).status, 401);
  assert.match((await api('DELETE', '/api/auth/account', {}, first.done.cookie)).body.error ?? (await api('DELETE', '/api/auth/account', { password: 'x' }, first.done.cookie)).body.error, /email/);
  assert.equal((await api('POST', '/api/auth/password', { next: 'correct horse battery staple' }, first.done.cookie)).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { email: 'gina@example.com', password: 'correct horse battery staple' })).status, 200);

  // the same email as a password account: not joined by itself, but by its owner from the settings
  const own = await api('POST', '/api/auth/signup', { firstName: 'Pat', lastName: 'Word', email: 'pat@example.com', password: 'purple elephant umbrella' });
  const taken = await round({ sub: '2002', email: 'pat@example.com' });
  assert.equal(taken.back.status, 400);
  assert.match(taken.done.body.error, /Connect Google/);
  assert.equal(taken.done.cookie, '');
  const linked = await round({ sub: '2002', email: 'pat@example.com' }, own.cookie);
  assert.deepEqual([linked.done.body.user.id, linked.done.body.user.google, linked.done.cookie], [own.body.user.id, true, ''], 'connected, session kept');
  assert.equal((await round({ sub: '2002', email: 'pat@example.com' })).done.body.user.id, own.body.user.id);
  assert.match((await round({ sub: '1001' }, own.cookie)).done.body.error, /already connected/);

  assert.match((await round({}, '', { error: 'access_denied' })).done.body.error, /cancelled/);
  assert.match((await round({ nonce: 'forged' })).done.body.error, /does not belong/);
});

// Accounts and what protects the window: passwords, sessions, lockout, cookies and who may connect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Accounts, AuthError, parseCookies, validEmail, validPassword } from '../src/accounts.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${name}-`));
process.env.CLAUDE_CONFIG_DIR = tmp('claude');
const { startServer } = await import('../src/server.js');
const { ACCOUNT, PASSWORD } = await import('./helper.js');

const fails = async (promise, status, message) => {
  await assert.rejects(promise, (err) => err instanceof AuthError && err.status === status && (!message || message.test(err.message)));
};

test('sign-up checks name, email and password', async () => {
  const a = new Accounts(path.join(tmp('acc'), 'users.json'));
  await fails(a.signup({ ...ACCOUNT, firstName: ' ' }), 400, /first name/);
  await fails(a.signup({ ...ACCOUNT, lastName: 'x<script>' }), 400, /last name/);
  await fails(a.signup({ ...ACCOUNT, email: 'not-an-email' }), 400, /valid email/);
  await fails(a.signup({ ...ACCOUNT, password: 'short1' }), 400, /at least 10/);
  await fails(a.signup({ ...ACCOUNT, password: 'aaaaaaaaaaaa' }), 400, /too easy/);
  await fails(a.signup({ ...ACCOUNT, password: 'MyPassword12345' }), 400, /too easy/);
  await fails(a.signup({ ...ACCOUNT, password: 'tess-is-my-name-1' }), 400, /too easy/);
  assert.equal(a.count(), 0, 'nothing was created by the failed attempts');
  const user = await a.signup({ ...ACCOUNT, email: '  Tess@Example.COM ' });
  assert.equal(user.email, 'tess@example.com');
  await fails(a.signup({ ...ACCOUNT, email: 'TESS@example.com' }), 409, /already an account/);
  assert.equal(validEmail('a.b+c@sub.example.org'), 'a.b+c@sub.example.org');
  assert.throws(() => validPassword('x'.repeat(201)), /too long/);
});

test('passwords are stored only as a salted hash, in a file only the owner can read', async () => {
  const file = path.join(tmp('acc'), 'users.json');
  const a = new Accounts(file);
  await a.signup(ACCOUNT);
  await a.signup({ ...ACCOUNT, email: 'second@example.com' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(PASSWORD), 'the password is not in the file');
  const [u1, u2] = JSON.parse(text).users;
  assert.equal(u1.pass.N, 16384);
  assert.notEqual(u1.pass.salt, u2.pass.salt, 'every account has its own salt');
  assert.notEqual(u1.pass.key, u2.pass.key, 'the same password hashes differently');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new Accounts(file).count(), 2, 'accounts survive a restart');
});

test('sign-in: the same answer for a wrong password and an unknown email, lockout after five tries', async () => {
  const a = new Accounts(path.join(tmp('acc'), 'users.json'));
  await a.signup(ACCOUNT);
  const wrong = await a.login(ACCOUNT.email, 'wrong password!').catch((e) => e);
  const unknown = await a.login('nobody@example.com', 'wrong password!').catch((e) => e);
  assert.equal(wrong.message, unknown.message);
  assert.equal(wrong.status, 401);
  for (let i = 0; i < 3; i++) await fails(a.login(ACCOUNT.email, 'still wrong!'), 401);
  const locked = await a.login(ACCOUNT.email, 'wrong again!').then(() => null, (e) => e);
  assert.equal(locked.status, 401, 'the fifth failure is still an ordinary failure');
  const blocked = await a.login(ACCOUNT.email, PASSWORD).then(() => null, (e) => e);
  assert.equal(blocked.status, 429, 'now even the right password has to wait');
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 30);
  const other = new Accounts(path.join(tmp('acc'), 'users.json'));
  await other.signup(ACCOUNT);
  const ok = await other.login(ACCOUNT.email.toUpperCase(), PASSWORD);
  assert.equal(ok.user.email, ACCOUNT.email, 'emails are not case sensitive');
});

test('sessions: found by cookie, listed, revoked; a password change signs the other devices out', async () => {
  const a = new Accounts(path.join(tmp('acc'), 'users.json'));
  const user = await a.signup(ACCOUNT);
  const one = await a.login(ACCOUNT.email, PASSWORD, { agent: 'Edge' });
  const two = await a.login(ACCOUNT.email, PASSWORD, { agent: 'Chrome' });
  const header = (t) => `theme=dark; uc_session=${t}; other=1`;
  assert.equal(parseCookies(header('abc')).uc_session, 'abc');
  const first = a.fromCookie(header(one.token), 'uc_session');
  assert.equal(first.user.id, user.id);
  assert.equal(a.fromCookie(header('not-a-token'), 'uc_session'), null);
  assert.equal(a.fromCookie('', 'uc_session'), null);
  assert.ok(!JSON.stringify(a.data.sessions).includes(one.token), 'only a hash of the token is stored');

  const list = a.sessionsOf(user, first.session);
  assert.deepEqual(list.map((s) => [s.agent, s.current]).sort(), [['Chrome', false], ['Edge', true]]);
  await fails(a.changePassword(user, 'wrong current', 'a brand new passphrase', first.session), 403, /current password/);
  await a.changePassword(user, PASSWORD, 'a brand new passphrase', first.session);
  assert.ok(a.fromCookie(header(one.token), 'uc_session'), 'this device stays signed in');
  assert.equal(a.fromCookie(header(two.token), 'uc_session'), null, 'the other device is signed out');
  await fails(a.login(ACCOUNT.email, PASSWORD), 401);
  const fresh = await a.login(ACCOUNT.email, 'a brand new passphrase');
  const sid = a.sessionsOf(user, null).find((s) => s.id !== first.session.id).id;
  a.revoke(user, sid);
  assert.equal(a.fromCookie(header(fresh.token), 'uc_session'), null);
  assert.throws(() => a.revoke(user, sid), /does not exist/);
  a.logout(first.session);
  assert.equal(a.fromCookie(header(one.token), 'uc_session'), null);
});

test('profile, preferences and deleting the account', async () => {
  const file = path.join(tmp('acc'), 'users.json');
  const a = new Accounts(file);
  const user = await a.signup(ACCOUNT);
  await a.updateProfile(user, { firstName: 'Tessa', lastName: 'Tester-Smith' });
  assert.equal(a.publicUser(user).firstName, 'Tessa');
  await fails(a.updateProfile(user, { email: 'new@example.com', password: 'wrong' }), 403);
  await a.updateProfile(user, { email: 'new@example.com', password: PASSWORD });
  assert.equal(user.email, 'new@example.com');
  const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]).toString('base64')}`;
  await a.updateProfile(user, { avatar: png });
  assert.equal(user.avatar, png);
  await fails(a.updateProfile(user, { avatar: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` }), 400, /not a valid picture/);
  await fails(a.updateProfile(user, { avatar: 'javascript:alert(1)' }), 400);
  await a.updateProfile(user, { avatar: null });
  assert.equal(user.avatar, '');
  assert.equal(a.setPrefs(user, { theme: 'dark', termFont: 15, notify: false, blockLimit: 5000000 }).prefs.blockLimit, 5000000);
  assert.throws(() => a.setPrefs(user, { theme: 'neon' }), /Unknown theme/);
  assert.throws(() => a.setPrefs(user, { termFont: 99 }), /between 10 and 22/);
  assert.equal(a.setPrefs(user, { blockLimit: '' }).prefs.blockLimit, null);
  await fails(a.deleteAccount(user, 'wrong'), 403);
  await a.deleteAccount(user, PASSWORD);
  assert.equal(new Accounts(file).count(), 0);
});

test('the server: nothing works without signing in, and who may connect is checked', async (t) => {
  const usersFile = path.join(tmp('acc'), 'users.json');
  const app = await startServer({ dir: tmp('proj'), vaultPath: tmp('v'), usersFile });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const call = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'x-uc-token': app.token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const json = async (res) => ({ status: res.status, headers: res.headers, ...(await res.json()) });

  assert.deepEqual((await json(await call('GET', '/api/auth/me'))).user, null);
  assert.equal((await json(await call('GET', '/api/auth/me'))).accounts, 0, 'the window can tell it should offer sign-up');
  for (const url of ['/api/state', '/api/usage', '/api/tree', '/api/chats', '/api/dirs?path=C%3A%5C', '/api/notes']) {
    assert.equal((await call('GET', url)).status, 401, `${url} needs an account`);
  }
  assert.equal((await call('POST', '/api/agents', { roleId: 'tester' })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 403, 'and the address token');

  const weak = await json(await call('POST', '/api/auth/signup', { ...ACCOUNT, password: 'short' }));
  assert.equal(weak.status, 400);
  const up = await call('POST', '/api/auth/signup', ACCOUNT);
  const setCookie = up.headers.get('set-cookie');
  assert.match(setCookie, /^uc_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  const cookie = setCookie.split(';')[0];
  const me = await json(await call('GET', '/api/auth/me', undefined, { cookie }));
  assert.equal(me.user.firstName, 'Tess');
  assert.ok(!('pass' in me.user) && !JSON.stringify(me).includes('"hash"'), 'no password data leaves the server');
  assert.equal((await call('GET', '/api/state', undefined, { cookie })).status, 200);
  assert.equal((await call('GET', '/api/state', undefined, { cookie: 'uc_session=forged' })).status, 401);

  const bad = await json(await call('POST', '/api/auth/login', { email: ACCOUNT.email, password: 'nope nope nope' }));
  assert.equal([bad.status, bad.error].join(), '401,The email or password is wrong.');
  assert.ok(!bad.headers.get('set-cookie'), 'no cookie for a failed sign-in');
  for (let i = 0; i < 4; i++) await call('POST', '/api/auth/login', { email: ACCOUNT.email, password: 'nope nope nope' });
  const locked = await json(await call('POST', '/api/auth/login', { email: ACCOUNT.email, password: PASSWORD }));
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);

  // the page may only load from this server and cannot be framed
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  // the live connection needs the address token, the cookie and this server's own origin
  const open = (query, headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws${query}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(null));
    ws.on('unexpected-response', () => resolve(null));
  });
  const origin = `http://127.0.0.1:${app.port}`;
  assert.equal(await open(`?t=${app.token}`, { origin }), null, 'no cookie');
  assert.equal(await open(`?t=${app.token}`, { cookie, origin: 'http://evil.example' }), null, 'a different website');
  assert.equal(await open('?t=wrong', { cookie, origin }), null, 'wrong token');
  const ws = await open(`?t=${app.token}`, { cookie, origin });
  assert.ok(ws, 'signed in, right token, own origin');

  // the command line uses its own key: it may read the state and stop the server, nothing else
  const info = JSON.parse(fs.readFileSync(path.join(app.project.dataDir, 'server.json'), 'utf8'));
  assert.equal((await call('GET', '/api/state', undefined, { 'x-uc-cli': info.cliKey })).status, 200);
  assert.equal((await call('GET', '/api/usage', undefined, { 'x-uc-cli': info.cliKey })).status, 401);
  assert.equal((await call('POST', '/api/agents', { roleId: 'tester' }, { 'x-uc-cli': info.cliKey })).status, 401);
  assert.equal((await call('GET', '/api/state', undefined, { 'x-uc-cli': 'wrong' })).status, 401);

  // signing out ends the cookie and the live connection
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const out = await call('POST', '/api/auth/logout', {}, { cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await closed, 4401);
  assert.equal((await call('GET', '/api/state', undefined, { cookie })).status, 401);
});

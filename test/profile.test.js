// The profile (name and date of birth) and who may still not reach the server without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Profile, validBirthDate } from '../src/profile.js';
import { startServer } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uc-profile-'));

test('a date of birth is a real day in the past', () => {
  assert.equal(validBirthDate('2008-02-29'), '2008-02-29');
  for (const bad of ['', '2007-02-29', '31.01.2000', '2999-01-01', '1850-01-01', '2000-13-01']) assert.throws(() => validBirthDate(bad), /date of birth/, bad);
});

test('the profile is saved, changed field by field, and takes over an old account\'s name and settings', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [{ firstName: 'Old', lastName: 'Account', prefs: { theme: 'light' } }] }));
  const p = new Profile(path.join(dir, 'profile.json'));
  assert.equal(p.view(), null);
  assert.deepEqual(p.suggestion(), { firstName: 'Old', lastName: 'Account' });
  assert.throws(() => p.save({ firstName: 'A', lastName: 'B' }), /date of birth/);
  assert.throws(() => p.save({ firstName: '<x>', lastName: 'B', birthDate: '2000-01-31' }), /first name/);
  assert.equal(p.save({ firstName: ' Ada ', lastName: 'Lovelace', birthDate: '2000-01-31' }).prefs.theme, 'light');
  assert.equal(p.save({ lastName: 'King' }).firstName, 'Ada');
  p.setPrefs({ termFont: 15 });
  const again = new Profile(path.join(dir, 'profile.json')).view();
  assert.deepEqual([again.lastName, again.birthDate, again.prefs.termFont], ['King', '2000-01-31', 15]);
});

test('no sign-in, but still only this window: the address secret and the origin are checked', async (t) => {
  const dir = tmp();
  const app = await startServer({ dir, vaultPath: path.join(dir, 'vault'), profileFile: path.join(dir, 'profile.json') });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = (method, url, body, token = app.token) => fetch(base + url, { method, headers: { 'x-uc-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await (await api('GET', '/api/profile')).json()).user, null);
  assert.equal((await api('GET', '/api/state')).status, 200, 'no sign-in needed');
  assert.equal((await api('GET', '/api/state', null, 'wrong')).status, 403);
  assert.equal((await fetch(`${base}/api/profile`)).status, 403);
  assert.equal((await api('POST', '/api/profile', { firstName: 'Ada' })).status, 400);
  const saved = await (await api('POST', '/api/profile', { firstName: 'Ada', lastName: 'Lovelace', birthDate: '2000-01-31' })).json();
  assert.equal(saved.user.firstName, 'Ada');
  assert.equal((await (await api('PATCH', '/api/profile/prefs', { theme: 'light' })).json()).user.prefs.theme, 'light');
  assert.equal((await api('POST', '/api/auth/login', {})).status, 404, 'the old sign-in is gone');
  const open = (origin, token) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?t=${token}`, { headers: { origin } });
    ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false);
  });
  assert.equal(await open('https://evil.example', app.token), false, 'another website cannot connect');
  assert.equal(await open(base, 'wrong'), false);
});

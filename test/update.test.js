// Update check: newer versions are noticed, offline is quiet, a failed install says what to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newer, checkUpdate, installUpdate, localVersion } from '../src/update.js';

test('versions, check and install', async () => {
  assert.ok(newer('0.2.1', '0.2.0') && newer('1.0.0', '0.9.9') && newer('0.10.0', '0.9.0'));
  assert.ok(!newer('0.2.0', '0.2.0') && !newer('0.1.9', '0.2.0'));
  const yes = await checkUpdate({ fresh: true, get: async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }) });
  assert.deepEqual([yes.available, yes.latest, yes.current], [true, '99.0.0', localVersion()]);
  const off = await checkUpdate({ fresh: true, get: async () => { throw new Error('offline'); } });
  assert.deepEqual([off.available, off.error], [false, 'offline']);
  const ran = [];
  await installUpdate({ exec: async (c) => ran.push(c) });
  assert.ok(ran.length >= 1);
  await assert.rejects(installUpdate({ exec: async () => { throw new Error('EPERM'); } }), /EPERM.*npm install -g/);
});

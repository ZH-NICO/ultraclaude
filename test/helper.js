// Starts a server for a test with its own accounts file (never the real ~/.ultraclaude/users.json)
// and signs in through the real sign-up endpoint. app.cookie is then sent with every API call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

export const PASSWORD = 'correct horse battery';
export const ACCOUNT = { firstName: 'Tess', lastName: 'Tester', email: 'tess@example.com', password: PASSWORD };

export async function startTest(options = {}) {
  const usersFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-users-')), 'users.json');
  const app = await startServer({ usersFile, ...options });
  const res = await fetch(`http://127.0.0.1:${app.port}/api/auth/signup`, { method: 'POST', headers: { 'x-uc-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(ACCOUNT) });
  if (!res.ok) throw new Error(`test sign-up failed: ${await res.text()}`);
  app.cookie = res.headers.get('set-cookie').split(';')[0];
  app.usersFile = usersFile;
  return app;
}

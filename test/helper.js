// Starts a server for a test with its own profile file (never the real ~/.ultraclaude).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

export function startTest(options = {}) {
  const profileFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-profile-')), 'profile.json');
  return startServer({ profileFile, ...options });
}

// The brain's file index: what it walks and leaves out, search, regions, and safe, undoable moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from '../src/fileindex.js';

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-idx-')));
  const home = path.join(root, 'Users', 'demo');
  const put = (rel, text = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put('Users/demo/Documents/taxes/2025 tax return.pdf');
  put('Users/demo/Documents/taxes/receipt-01.pdf');
  put('Users/demo/Documents/cv.docx');
  put('Users/demo/Downloads/IMG_0001.jpg');
  put('Users/demo/Downloads/IMG_0002.jpg');
  put('Users/demo/Downloads/invoice march.pdf');
  put('Users/demo/notes.txt');
  put('Users/demo/AppData/Local/cache.bin'); // application data: left out
  put('Users/demo/code/app/node_modules/left/out.js'); // dependencies: left out
  put('Users/demo/code/app/.git/HEAD'); // hidden: left out
  put('Users/demo/code/app/src/main.js');
  put('Windows/System32/kernel.dll'); // the system: left out
  put('Games/save1.dat');
  return { root, home };
}

test('it walks the files, leaves the system, app data, hidden and dependency folders out, and finds things', async () => {
  const { root, home } = world();
  const idx = new FileIndex({ roots: [root], home });
  const notes = [];
  idx.on('status', (s) => notes.push(s.state));
  await idx.build();
  assert.equal(idx.state, 'ready');
  assert.deepEqual(notes.at(0), 'indexing'); assert.equal(notes.at(-1), 'ready');
  const all = idx.files.map((_, i) => idx.pathOf(i).slice(root.length + 1).replace(/\\/g, '/')).sort();
  assert.deepEqual(all, ['Games/save1.dat', 'Users/demo/Documents/cv.docx', 'Users/demo/Documents/taxes/2025 tax return.pdf', 'Users/demo/Documents/taxes/receipt-01.pdf', 'Users/demo/Downloads/IMG_0001.jpg', 'Users/demo/Downloads/IMG_0002.jpg', 'Users/demo/Downloads/invoice march.pdf', 'Users/demo/code/app/src/main.js', 'Users/demo/notes.txt']);

  assert.deepEqual(idx.search('tax pdf').map((p) => path.basename(p)), ['2025 tax return.pdf', 'receipt-01.pdf'], 'every word must be in the path');
  assert.deepEqual(idx.search('ext:jpg').map((p) => path.basename(p)), ['IMG_0001.jpg', 'IMG_0002.jpg']);
  assert.deepEqual(idx.search('downloads .pdf').map((p) => path.basename(p)), ['invoice march.pdf']);
  assert.deepEqual(idx.search(''), []);
  const dl = idx.list(path.join(home, 'Downloads'));
  assert.deepEqual(dl.files, ['IMG_0001.jpg', 'IMG_0002.jpg', 'invoice march.pdf']);
  assert.deepEqual(idx.list(path.join(home, 'Documents')).folders, ['taxes']);
  assert.equal(idx.list(path.join(root, 'nowhere')), null);

  const p = idx.payload();
  assert.equal(p.files.length, 9);
  const names = p.regions.map((r) => r.name).sort();
  assert.deepEqual(names, ['Documents', 'Downloads', `Games (${root})`, 'Home', 'code'].sort(), 'folders in the home folder, and folders under the drive');
  assert.equal(p.regions.find((r) => r.name === 'Documents').count, 3);
  for (const [d, name, r] of p.files) assert.ok(p.dirs[d] && name && p.regions[r]);
  assert.equal(idx.payload(4).files.length, 4, 'a big index is thinned out evenly');
});

test('moves stay inside the roots, never overwrite, and can be undone', async () => {
  const { root, home } = world();
  const journal = path.join(root, 'journal.jsonl');
  const idx = new FileIndex({ roots: [root], home, journal });
  await idx.build();
  const dl = (n) => path.join(home, 'Downloads', n);
  const pics = path.join(home, 'Pictures', 'Phone');
  assert.match(idx.check([{ from: dl('IMG_0001.jpg'), to: path.join(os.tmpdir(), 'elsewhere.jpg') }]).join(), /not a place/, 'not out of the roots');
  assert.match(idx.check([{ from: dl('IMG_0001.jpg'), to: dl('IMG_0002.jpg') }]).join(), /already exists/);
  assert.match(idx.check([{ from: dl('IMG_0001.jpg'), to: path.join(root, 'Windows', 'x.jpg') }]).join(), /not a place/, 'not into the system');
  assert.match(idx.check([{ from: path.join(home, 'AppData', 'Local', 'cache.bin'), to: dl('cache.bin') }]).join(), /not a file the brain may move/);
  assert.match(idx.check([{ from: dl('nope.jpg'), to: path.join(pics, 'nope.jpg') }]).join(), /does not exist/);
  assert.match(idx.check([{ from: dl('IMG_0001.jpg'), to: path.join(pics, 'a.jpg') }, { from: dl('IMG_0002.jpg'), to: path.join(pics, 'a.jpg') }]).join(), /same place/);
  await assert.rejects(idx.apply([{ from: dl('IMG_0001.jpg'), to: dl('IMG_0002.jpg') }]), /already exists/);
  assert.ok(fs.existsSync(dl('IMG_0001.jpg')), 'a refused plan moves nothing');

  const r = await idx.apply([{ from: dl('IMG_0001.jpg'), to: path.join(pics, 'IMG_0001.jpg') }, { from: dl('IMG_0002.jpg'), to: path.join(pics, 'IMG_0002.jpg') }]);
  assert.equal(r.done.length, 2);
  assert.ok(fs.existsSync(path.join(pics, 'IMG_0001.jpg')) && !fs.existsSync(dl('IMG_0001.jpg')), 'moved, with the new folder made');
  assert.deepEqual(idx.search('phone').map((p) => path.basename(p)), ['IMG_0001.jpg', 'IMG_0002.jpg'], 'the index knows the new places');
  assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8').trim()).done.length, 2, 'written to the journal');
  const back = await idx.undo(r.done);
  assert.equal(back.done.length, 2);
  assert.ok(fs.existsSync(dl('IMG_0001.jpg')) && !fs.existsSync(path.join(pics, 'IMG_0001.jpg')), 'undone');
});

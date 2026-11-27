// The brain's views: tables, pivots, timeline, storage, duplicates, sorting plans, tags, CSV and previews.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from '../src/fileindex.js';
import * as bq from '../src/brainquery.js';
import { BrainChat } from '../src/brainchat.js';

async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-bq-')));
  const home = path.join(root, 'Users', 'demo');
  const put = (rel, size, date) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size, 'a')); const t = new Date(date); fs.utimesSync(p, t, t); return p; };
  put('Documents/report.pdf', 3000, '2026-03-10');
  put('Documents/=cmd.txt', 10, '2025-01-05');
  put('Downloads/photo.jpg', 5000, '2026-10-02');
  put('Downloads/setup.exe', 9000, '2026-10-20');
  put('Downloads/report.pdf', 3000, '2026-03-11');
  put('Music/song.mp3', 2000, '2024-07-07');
  const index = new FileIndex({ roots: [root], home });
  await index.build();
  await index.measuring;
  const tags = new bq.Tags(path.join(root, '.tags.json'));
  return { root, home, index, tags };
}
const names = (r) => r.rows.map((x) => x.name);

test('table: filter, sort, page and totals', async () => {
  const { home, index, tags } = await world();
  assert.equal(index.measured, true);
  const all = bq.table(index, tags, { sort: 'size' });
  assert.deepEqual([all.total, all.bytes, names(all)[0]], [6, 22010, 'setup.exe']);
  assert.deepEqual(names(bq.table(index, tags, { filter: { type: 'Documents' }, sort: 'name', desc: false })), ['=cmd.txt', 'report.pdf', 'report.pdf']);
  assert.deepEqual(names(bq.table(index, tags, { filter: { folder: path.join(home, 'Downloads'), from: Date.parse('2026-10-01') }, sort: 'mtime' })), ['setup.exe', 'photo.jpg']);
  assert.deepEqual(names(bq.table(index, tags, { filter: { min: 2500, max: 6000, q: '.pdf' } })), ['report.pdf', 'report.pdf']);
  assert.equal(bq.table(index, tags, { offset: 4, limit: 4 }).rows.length, 2);
});

test('pivot, timeline, storage and duplicates', async () => {
  const { root, home, index, tags } = await world();
  const p = bq.pivot(index, tags, { rows: 'region', cols: 'type' });
  assert.equal(p.total, 6);
  const dl = p.rows.findIndex((r) => r.name === 'Downloads');
  assert.equal(p.cells[dl][p.cols.findIndex((c) => c.name === 'Programs')], 1);
  assert.equal(bq.pivot(index, tags, { rows: 'year', cols: 'type', value: 'size' }).rows[0].name, '2026', 'newest first');
  assert.throws(() => bq.pivot(index, tags, { rows: 'nope' }), /Unknown dimension/);
  const t = bq.timeline(index, tags);
  assert.deepEqual(t.months.map((m) => m.month), ['2024-07', '2025-01', '2026-03', '2026-10']);
  assert.equal(t.months[2].total, 2);
  const s = bq.storage(index, tags, { path: home });
  assert.deepEqual(s.parts.map((x) => x.name), ['Downloads', 'Documents', 'Music']);
  assert.equal(s.total, 22010);
  assert.equal(bq.storage(index, tags, {}).parts[0].path, root);
  assert.deepEqual(bq.storage(index, tags, { path: path.join(home, 'Music') }).parts.map((x) => [x.name, !!x.file]), [['song.mp3', true]]);
  const d = bq.duplicates(index, tags, { min: 1 });
  assert.deepEqual([d.total, d.waste, d.groups[0].name], [1, 3000, 'report.pdf']);
});

test('plans by rule, tags that follow moved files, CSV and previews', async () => {
  const { home, index, tags } = await world();
  const downloads = path.join(home, 'Downloads');
  const moves = bq.organize(index, tags, { filter: { folder: downloads }, by: 'type' });
  assert.deepEqual(moves.map((m) => path.relative(downloads, m.to).replace(/\\/g, '/')).sort(), ['Documents/report.pdf', 'Images/photo.jpg', 'Programs/setup.exe']);
  const both = bq.organize(index, tags, { filter: { q: 'report.pdf' }, into: path.join(home, 'Sorted') });
  assert.deepEqual(both.map((m) => path.basename(m.to)).sort(), ['report (2).pdf', 'report.pdf'], 'two files of one name never collide');
  assert.match(bq.organize(index, tags, { paths: [path.join(downloads, 'photo.jpg')], into: home, by: 'month' })[0].to, /2026[\\/]2026-10[\\/]photo\.jpg$/);
  assert.throws(() => bq.organize(index, tags, { filter: { q: 'nothing-here' }, into: home }), /No files/);
  assert.throws(() => bq.organize(index, tags, { filter: { q: 'song' } }), /which folder/);

  const photo = path.join(downloads, 'photo.jpg');
  tags.change([photo], ['holiday', ' holiday ', 'x'], []);
  tags.change([photo], [], ['x']);
  assert.deepEqual(tags.of(photo), ['holiday']);
  assert.deepEqual(names(bq.table(index, tags, { filter: { tag: 'holiday' } })), ['photo.jpg']);
  const chat = new BrainChat({ index, tags, endpoint: () => ({}), dataDir: path.join(home, '.uc') });
  const plan = chat.propose(bq.organize(index, tags, { paths: [photo], into: path.join(home, 'Pictures') }));
  await chat.apply(plan.id);
  const there = path.join(home, 'Pictures', 'photo.jpg');
  assert.deepEqual(tags.of(there), ['holiday'], 'the tag moved with the file');
  assert.equal(bq.table(index, tags, { filter: { q: 'photo' } }).rows[0].size, 5000, 'size and date survive a move');
  await chat.undo(plan.id);
  assert.deepEqual(tags.of(photo), ['holiday']);

  tags.saveView({ name: 'Big', view: 'table', filter: { min: 1 } });
  assert.equal(new bq.Tags(tags.file).data.views[0].name, 'Big', 'saved to disk');
  tags.removeView('Big');
  assert.equal(tags.data.views.length, 0);
  assert.match(bq.csv(index, tags, { filter: { q: 'cmd' } }), /\n'=cmd\.txt,/, 'no spreadsheet formulas');
  assert.equal(bq.preview(path.join(home, 'Documents', '=cmd.txt')).text, 'a'.repeat(10));
  assert.match(bq.preview(photo).data, /^data:image\/jpeg;base64,/);
  assert.equal(bq.preview(path.join(downloads, 'setup.exe')).kind, 'none');

  // Claude's tools
  assert.match(chat.call('brain_query', { filter: { type: 'Audio' } }), /1 files[\s\S]*song\.mp3/);
  assert.match(chat.call('brain_pivot', { rows: 'type', cols: 'year' }), /Documents \|/);
  const seen = []; chat.on('view', (v) => seen.push(v));
  chat.call('brain_view', { view: 'timeline', filter: { from: '2026-01-01' } });
  assert.equal(seen[0].filter.from, Date.parse('2026-01-01'));
  assert.match(chat.call('brain_organize', { filter: { type: 'Audio' }, into: path.join(home, 'Old') }), /Proposed 1 move/);
  assert.equal(chat.call('brain_tag', { paths: [photo, path.join(os.tmpdir(), 'x')], add: ['a'] }), 'Tags saved.');
});

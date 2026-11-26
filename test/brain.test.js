// The brain's shape and how chats and folders become neurons and regions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { brainPart, buildBrain } from '../public/brain.js';

const project = (key, n, age = 0) => ({ key, name: key, dir: `/x/${key}`, sessions: Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}`, title: `${key} chat ${i}`, size: 1000 * (i + 1), updated: Date.now() - age - i * 3600e3 })) });

test('the shape has a cerebrum with a fissure, a cerebellum and a stem', () => {
  assert.equal(brainPart(0.5, 0.2, 0.2), 'cerebrum');
  assert.equal(brainPart(0, 0.4, 0.2), '', 'the fissure between the hemispheres is empty');
  assert.equal(brainPart(0, -0.5, -0.82), 'cerebellum');
  assert.equal(brainPart(0, -0.8, -0.29), 'stem');
  assert.equal(brainPart(1.2, 0, 0), '', 'nothing outside');
  assert.equal(brainPart(0.6, -0.9, 0.6), '', 'nothing hangs below the cerebrum except the stem');
});

test('every chat becomes a neuron in its folder\'s region, the same way every time', () => {
  const projects = [project('web', 6), project('api', 4, 10 * 864e5), project('notes', 1)];
  const a = buildBrain(projects, null, { total: 2000 });
  const b = buildBrain(projects, null, { total: 2000 });
  assert.equal(a.points.length, 2000);
  assert.equal(a.neurons.length, 11);
  assert.equal(a.regions.length, 3);
  assert.equal(new Set(a.regions.map((r) => r.color)).size, 3, 'each region has its own colour');
  assert.equal(a.regions[0].key, 'web', 'the biggest folder comes first');
  for (const n of a.neurons) {
    assert.equal(n.reg.key, n.pr.key);
    assert.ok(brainPart(n.x, n.y, n.z), 'neurons sit inside the brain');
  }
  assert.deepEqual(a.neurons.map((n) => [n.x, n.y, n.z]), b.neurons.map((n) => [n.x, n.y, n.z]), 'stable between visits');
  assert.ok(a.points.every((p) => brainPart(p.x, p.y, p.z)));
  assert.ok(a.points.some((p) => p.part === 'stem') && a.points.some((p) => p.part === 'cerebellum'));
  assert.ok(a.wires.length >= 4 && a.wires.every(([m, n]) => m.reg === n.reg), 'wires stay within a region');
  assert.ok(a.links.every(([i, j]) => a.points[i].reg === a.points[j].reg));
  const big = a.neurons.find((n) => n.s.id === 'web-5'); const small = a.neurons.find((n) => n.s.id === 'web-0');
  assert.ok(big.r > small.r, 'longer chats are bigger neurons');
  assert.equal(buildBrain([], null, { total: 500 }).neurons.length, 0, 'an empty history still draws a brain');
});

test('with the file index, every file is a point in its region and chats sit among their folder\'s files', () => {
  const files = {
    regions: [{ key: 'docs', name: 'Documents', path: '/home/me/Documents', count: 3 }, { key: 'code', name: 'code', path: '/home/me/code', count: 4 }],
    dirs: ['/home/me/Documents', '/home/me/Documents/taxes', '/home/me/code/web', '/home/me/code/api'],
    files: [[0, 'cv.docx', 0], [1, 'a.pdf', 0], [1, 'b.pdf', 0], [2, 'index.html', 1], [2, 'app.js', 1], [3, 'server.js', 1], [3, 'db.js', 1]],
  };
  const projects = [{ key: 'w', name: 'web', dir: '/home/me/code/web', sessions: [{ id: 's1', title: 'Fix the web app', size: 10, updated: Date.now() }] }];
  const m = buildBrain(projects, files);
  const filePoints = m.points.filter((p) => p.file >= 0);
  assert.equal(filePoints.length, 7, 'one point per file');
  assert.ok(m.points.length >= 8000, 'filled up to look like a brain');
  assert.deepEqual(m.regions.map((r) => r.name), ['Documents', 'code']);
  for (const p of filePoints) assert.equal(p.reg.key, files.regions[files.files[p.file][2]].key, 'a file sits in its region');
  assert.ok(m.points.filter((p) => p.file >= 0).every((p) => p.t >= p.reg.from && p.t < p.reg.to), 'and in its region\'s stretch of the spectrum');
  assert.equal(m.pathOf(filePoints.find((p) => files.files[p.file][1] === 'a.pdf')), '/home/me/Documents/taxes/a.pdf');
  assert.ok(m.links.some(([i, j]) => m.points[i].dir === 1 && m.points[j].dir === 1), 'a folder\'s files are threaded together');
  const n = m.neurons[0];
  assert.equal(n.reg.name, 'code', 'the chat is in the region of its folder');
  const home = m.points.find((p) => p.x === n.x && p.y === n.y && p.z === n.z);
  assert.equal(files.dirs[home.dir], '/home/me/code/web', 'right among its folder\'s files');
});
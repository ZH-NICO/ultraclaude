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
  const a = buildBrain(projects, { total: 2000 });
  const b = buildBrain(projects, { total: 2000 });
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
  assert.equal(buildBrain([], { total: 500 }).neurons.length, 0, 'an empty history still draws a brain');
});

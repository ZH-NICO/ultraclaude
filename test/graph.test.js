// The memory graph: links between notes, and the layout that places them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';
import { layout, degrees, dotSize } from '../public/graph.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${name}-`));

test('notes become nodes and [[wikilinks]] become links; missing targets are ghosts', () => {
  const v = new Vault(tmp('vault'), 'demo');
  v.ensure('/x/demo');
  v.write({ title: 'Auth architecture', content: 'See [[Login bug 42]] and [[login bug 42|the bug]] and [[Token refresh#Details]].\nAlso [[Style guide]].', author: 'Architect' });
  v.write({ title: 'Login bug 42', content: 'Back to [[Auth architecture]]. Not itself: [[Login bug 42]].', author: 'Bugfixer' });
  v.write({ title: 'Style guide', content: 'Tabs.', scope: 'global', author: 'user' });
  v.log('Bugfixer', 'something');
  v.writeBoard([{ id: 1, title: 'x', status: 'todo' }]);

  const g = v.graph();
  const titles = g.nodes.map((n) => n.title).sort();
  assert.ok(titles.includes('Auth architecture') && titles.includes('Style guide') && titles.includes('Token refresh'));
  assert.ok(!titles.some((t) => /Board|\d{4}-\d\d-\d\d/.test(t)), 'the board and the journal are not part of it');
  const id = (t) => g.nodes.find((n) => n.title === t).id;
  const link = (a, b) => g.links.some((l) => l.source === id(a) && l.target === id(b));
  assert.ok(link('Auth architecture', 'Login bug 42'));
  assert.ok(link('Login bug 42', 'Auth architecture'));
  assert.ok(link('Auth architecture', 'Style guide'), 'a global note is found by its title');
  assert.equal(g.links.filter((l) => l.source === id('Auth architecture') && l.target === id('Login bug 42')).length, 1, 'the same link twice counts once, whatever its spelling');
  assert.ok(!g.links.some((l) => l.source === l.target), 'no note links to itself');
  const ghost = g.nodes.find((n) => n.title === 'Token refresh');
  assert.equal(ghost.ghost, true);
  assert.ok(link('Auth architecture', 'Token refresh') || g.links.some((l) => l.target === ghost.id));
  assert.ok(g.nodes.every((n) => !('body' in n)), 'note texts are not sent along');
});

test('the layout keeps linked notes close and is the same every time', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, size: 500 }));
  const links = [];
  for (let i = 0; i < 11; i++) links.push({ source: `n${i}`, target: `n${i + 1}` }); // a chain of twelve
  for (let i = 12; i < 23; i++) links.push({ source: `n${i}`, target: `n${i + 1}` }); // another chain of twelve
  const a = layout(nodes, links);
  const b = layout(nodes, links);
  assert.deepEqual([...a.get('n3').x.toString()].join(''), [...b.get('n3').x.toString()].join(''), 'deterministic');
  const dist = (p, q) => Math.hypot(a.get(p).x - a.get(q).x, a.get(p).y - a.get(q).y);
  let linked = 0;
  for (const l of links) linked += dist(l.source, l.target);
  linked /= links.length;
  let unlinked = 0; let count = 0;
  for (let i = 0; i < 12; i++) for (let j = 12; j < 24; j++) { unlinked += dist(`n${i}`, `n${j}`); count++; }
  unlinked /= count;
  assert.ok(linked < unlinked * 0.6, `linked ${linked.toFixed(0)} px apart on average, unrelated ${unlinked.toFixed(0)}`);
  for (const p of a.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.equal(layout([], []).size, 0);
  assert.equal(layout([{ id: 'only', size: 1 }], []).size, 1);
  const d = degrees(nodes, links);
  assert.equal(d.get('n0'), 1);
  assert.equal(d.get('n5'), 2);
  assert.ok(dotSize({ size: 100000 }, 9) <= 13 && dotSize({ size: 0 }, 0) >= 4 && dotSize({ ghost: true, size: 99999 }, 9) === 4);
});

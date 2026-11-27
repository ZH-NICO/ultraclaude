// The arrangements of the brain's dots: no file disappears, dots stay in their cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridFill, allot, tableLayout, sortedLayout, keyOf } from '../public/brainlayouts.js';

const inside = (d, b) => d.x >= b.x - 0.5 && d.x <= b.x + b.w + 0.5 && d.y >= b.y - 0.5 && d.y <= b.y + b.h + 0.5;

test('dots fill their box and never leave it, however many', () => {
  const box = { x: 10, y: 20, w: 60, h: 40 };
  for (const n of [1, 7, 100, 3000]) {
    const dots = gridFill(box, n);
    assert.equal(dots.length, n);
    assert.ok(dots.every((d) => inside(d, box)), `${n} dots stay inside`);
  }
  assert.ok(gridFill(box, 5, { bottom: true }).every((d) => d.y > 40), 'from the bottom up');
  assert.deepEqual(gridFill(box, 0), []);
});

test('one dot per file while they fit, a share each when they do not', () => {
  assert.deepEqual(allot([{ count: 3 }, { count: 5 }], 100), { per: 1, counts: [3, 5] });
  const many = allot([{ count: 90000 }, { count: 9999 }, { count: 1 }, { count: 0 }], 1000);
  assert.deepEqual(many.counts, [900, 100, 1, 0], 'a cell with anything in it keeps a dot');
});

test('a table keeps what the server leaves out in an "earlier" column', () => {
  const files = [
    { region: 'Docs', name: 'a.pdf', dir: '/d', type: 'Documents', mtime: +new Date(2026, 2, 5), size: 1 },
    { region: 'Docs', name: 'old.pdf', dir: '/d', type: 'Documents', mtime: +new Date(2020, 0, 5), size: 1 },
  ];
  const pivot = { by: { rows: 'region', cols: 'month', value: 'count' }, rows: [{ name: 'Docs', total: 2 }], cols: [{ name: '2026-03', total: 1 }], cells: [[1]], hidden: { rows: 0, cols: 1 } };
  const area = { x: 0, y: 0, w: 800, h: 400 };
  const t = tableLayout(area, files, pivot, 1000);
  assert.equal(t.dots.length, 2);
  assert.deepEqual(t.dots.map((d) => d.file.name), ['a.pdf', 'old.pdf']);
  assert.ok(t.dots[1].x < t.dots[0].x, 'earlier stands on the left');
  assert.ok(t.labels.some((l) => l.kind === 'col' && l.text === 'earlier' && l.value === 1));
  assert.equal(keyOf('year', files[1]), '2020');
  assert.equal(sortedLayout(area, files, 'name').dots[0].file.name, 'a.pdf');
});
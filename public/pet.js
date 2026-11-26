// The agents' pet: a small pixel crab drawn from a grid, with parts that CSS animates per state
// (breathing and blinking, thinking, typing, waiting, sleeping, celebrating). Our own drawing.

const NS = 'http://www.w3.org/2000/svg';
const P = 3; // size of one pixel
const W = 16; const H = 9;

// B body · E eye · a/b arms (left/right) · l/r legs (two pairs that step in turn)
const GRID = [
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..BBEBBBBBBEBB..',
  'aaBBEBBBBBBEBBbb',
  'aaBBBBBBBBBBBBbb',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..l.r......l.r..',
  '..l.r......l.r..',
];

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** One path made of the grid cells marked with `ch`, so each part is a single element. */
function cells(ch) {
  let d = '';
  GRID.forEach((row, y) => [...row].forEach((c, x) => { if (c === ch) d += `M${x * P} ${y * P}h${P}v${P}h-${P}z`; }));
  return d;
}

const PATHS = Object.fromEntries(['B', 'E', 'a', 'b', 'l', 'r'].map((c) => [c, cells(c)]));

/**
 * A pet centred on 0,0. `mini` makes a small one, for subagents.
 * Its state comes from the class of a parent (.working, .waiting, ...).
 */
export function petSprite({ mini = false } = {}) {
  const ox = -(W * P) / 2; const oy = -(H * P) / 2 - 1;
  const sprite = el('g', { class: 'pet-sprite', transform: `translate(${ox},${oy})` },
    el('g', { class: 'pet-legs l' }, el('path', { d: PATHS.l })),
    el('g', { class: 'pet-legs r' }, el('path', { d: PATHS.r })),
    el('g', { class: 'pet-body' },
      el('g', { class: 'pet-arm l' }, el('path', { d: PATHS.a })),
      el('g', { class: 'pet-arm r' }, el('path', { d: PATHS.b })),
      el('path', { class: 'pet-fill', d: PATHS.B }),
      el('g', { class: 'pet-eyes' }, el('path', { d: PATHS.E })),
      el('g', { class: 'pet-shut' }, el('rect', { x: 3 * P + 1, y: 3 * P, width: 2 * P, height: 1.2 }), el('rect', { x: 10 * P + 1, y: 3 * P, width: 2 * P, height: 1.2 }))),
    // a little keyboard for typing
    el('g', { class: 'pet-kbd' },
      el('rect', { class: 'k', x: 0.5 * P, y: 7.8 * P, width: 15 * P, height: 1.9 * P, rx: 1.5 }),
      ...[0, 1, 2, 3, 4, 5].map((i) => el('rect', { class: `key k${i % 5}`, x: 1.6 * P + i * 2.25 * P, y: 8.3 * P, width: 1.5 * P, height: 0.8 * P }))));
  const bubbles = el('g', { class: 'pet-bubbles' },
    // thinking: a cloud with three dots, rising from little bubbles
    el('g', { class: 'pet-think' },
      el('circle', { cx: 20, cy: -12, r: 1.6 }), el('circle', { cx: 24, cy: -17, r: 2.4 }),
      el('rect', { x: 23, y: -33, width: 22, height: 12, rx: 6 }),
      ...[0, 1, 2].map((i) => el('circle', { class: `dot d${i}`, cx: 29 + i * 5, cy: -27, r: 1.4 }))),
    // waiting for you: an exclamation bubble
    el('g', { class: 'pet-alert' }, el('rect', { x: 18, y: -34, width: 12, height: 14, rx: 3 }), el('rect', { class: 'bang', x: 23, y: -31, width: 2.4, height: 5.5 }), el('rect', { class: 'bang', x: 23, y: -24.5, width: 2.4, height: 2.4 })),
    // sleeping
    el('g', { class: 'pet-zzz' }, ...[0, 1, 2].map((i) => el('text', { class: `z z${i}`, x: 18, y: -10 }, 'z'))));
  // done: sparkles
  const fx = el('g', { class: 'pet-fx' }, bubbles, el('g', { class: 'pet-spark' }, ...[[-26, -18], [26, -20], [-20, 12], [22, 10]].map(([x, y], i) => el('path', { class: `s s${i}`, d: `M${x - 3} ${y}h6M${x} ${y - 3}v6` }))));
  return el('g', { class: `pet${mini ? ' mini' : ''}`, transform: mini ? 'scale(.6)' : 'scale(1.25)' }, el('ellipse', { class: 'pet-shadow', cx: 0, cy: H * P / 2 + 1, rx: 15, ry: 2.2 }), sprite, fx);
}

/** Moves the bubbles to the side of the pet where its label is not (the label side is right, left, top or bottom). */
export function petPlace(pet, labelSide) {
  const shift = { right: 'translate(-62,0)', top: 'translate(0,38)' }[labelSide];
  if (shift) pet.querySelector('.pet-bubbles').setAttribute('transform', shift);
}

/** The pet's mood for an agent view. */
export function petMood(a) {
  if (a.state === 'working' && (!a.activity || a.activity === 'thinking')) return 'thinking';
  return a.state;
}

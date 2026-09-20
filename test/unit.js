/* Deterministic unit tests for logic.js — no browser needed: `npm run test:unit`. */
const assert = require('assert');
const L = require('../logic.js');

let n = 0;
function eq(a, b, name) {
  n++;
  try {
    assert.deepStrictEqual(a, b);
    console.log('PASS  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '  expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
    process.exitCode = 1;
  }
}

// movement / bounds
eq(L.nextPos({ x: 9, y: 10 }, { x: 1, y: 0 }), { x: 10, y: 10 }, 'nextPos steps');
eq(L.wrapPos({ x: 20, y: -1 }, 20), { x: 0, y: 19 }, 'wrapPos both axes');
eq(L.inBounds({ x: 19, y: 5 }, 20), true, 'inBounds inside');
eq(L.inBounds({ x: 20, y: 5 }, 20), false, 'wall detected outside');
eq(L.inBounds({ x: 5, y: -1 }, 20), false, 'wall detected negative');

// self collision with tail-vacate rule
const body = [
  { x: 5, y: 5 },
  { x: 5, y: 6 },
  { x: 6, y: 6 },
];
eq(L.hitsBody({ x: 5, y: 6 }, body, false), true, 'self hit detected');
eq(L.hitsBody({ x: 6, y: 6 }, body, false), false, 'vacating tail ignored when not growing');
eq(L.hitsBody({ x: 6, y: 6 }, body, true), true, 'tail counts when growing');
eq(L.hitsBody({ x: 0, y: 0 }, body, false), false, 'empty cell free');

// levels / combo / scoring
eq(L.levelFor(0, 6), 1, 'level starts at 1');
eq(L.levelFor(5, 6), 1, 'level 1 until goal');
eq(L.levelFor(6, 6), 2, 'level 2 at goal');
eq(L.comboFor(0, 0, 1000, 5000), { combo: 1, mult: 1 }, 'first eat combo x1');
eq(L.comboFor(1, 1000, 3000, 5000), { combo: 2, mult: 2 }, 'chained eat combo x2');
eq(L.comboFor(2, 1000, 9000, 5000), { combo: 1, mult: 1 }, 'stale chain resets');
eq(L.comboFor(7, 1000, 2000, 5000), { combo: 8, mult: 5 }, 'mult capped at x5');
eq(L.scoreGain(10, 3), 30, 'regular scoring');
eq(L.scoreGain(50, 2), 100, 'bonus scoring');

// snapDir: camera-relative tie-breaks never pick suicide
eq(L.snapDir(0, 1, { x: 1, y: 0 }, 3), { x: 0, y: 1 }, 'clear winner picked');
eq(L.snapDir(-0.7071, -0.7071, { x: 1, y: 0 }, 3), { x: 0, y: -1 }, 'diagonal tie drops opposite, picks up');
eq(L.snapDir(-0.7071, -0.7071, { x: -1, y: 0 }, 3), { x: 0, y: -1 }, 'diagonal tie keeps up heading left');
eq(L.snapDir(0.7071, -0.7071, { x: 0, y: 1 }, 3), { x: 1, y: 0 }, 'tie drops down (opposite), picks right');
eq(L.snapDir(-1, 0, { x: 0, y: 0 }, 1), { x: -1, y: 0 }, 'len-1 may reverse');

// findFree placement
const occ = { 0: true };
eq(
  L.findFree(occ, 2, () => 0.99),
  { x: 1, y: 1 },
  'findFree random pick'
);
eq(
  L.findFree({ 0: 1, 1: 1, 2: 1 }, 2, () => 0, 0),
  { x: 1, y: 1 },
  'findFree exhaustive fallback'
);
eq(
  L.findFree({ 0: 1, 1: 1, 2: 1, 3: 1 }, 2, () => 0, 0),
  null,
  'findFree null when full'
);
eq(L.manhattan({ x: 1, y: 1 }, { x: 4, y: 5 }), 7, 'manhattan distance');
eq(L.fmtTime(0), '0:00', 'fmtTime zero');
eq(L.fmtTime(65000), '1:05', 'fmtTime minute');
eq(L.fmtTime(-5), '0:00', 'fmtTime clamps negative');

// mulberry32: deterministic, in range, seed-sensitive
var r1 = L.mulberry32(7),
  r2 = L.mulberry32(7),
  r3 = L.mulberry32(8);
var seq1 = [r1(), r1(), r1()],
  seq2 = [r2(), r2(), r2()];
eq(seq1, seq2, 'mulberry32 same seed same sequence');
eq(
  seq1.every(function (v) {
    return v >= 0 && v < 1;
  }),
  true,
  'mulberry32 range [0,1)'
);
eq(r1() === r3() && seq1[0] === r3(), false, 'mulberry32 different seeds diverge');
eq(
  L.findFree({}, 20, L.mulberry32(1234), 300),
  L.findFree({}, 20, L.mulberry32(1234), 300),
  'findFree deterministic under seeded rng'
);

// mirrorLayout: quadrant symmetry, dedupe, sorted, bounded
var ml = L.mirrorLayout(
  [
    [2, 2],
    [3, 6],
  ],
  20
);
eq(ml.length, 8, 'mirrorLayout 2 base cells -> 8 cells');
eq(
  ml.every(function (c) {
    function has(x, y) {
      return ml.some(function (k) {
        return k.x === x && k.y === y;
      });
    }
    return has(19 - c.x, c.y) && has(c.x, 19 - c.y) && has(19 - c.x, 19 - c.y);
  }),
  true,
  'mirrorLayout every cell has all 3 mirrors'
);
var mlSorted = ml.every(function (c, i) {
  return i === 0 || ml[i - 1].y * 20 + ml[i - 1].x <= c.y * 20 + c.x;
});
eq(mlSorted, true, 'mirrorLayout sorted row-major');
var mlEdge = L.mirrorLayout([[0, 0]], 20);
eq(mlEdge.length, 4, 'mirrorLayout corner -> 4 distinct cells');
var mlDedupe = L.mirrorLayout([[9, 9]], 20);
eq(mlDedupe.length, 4, 'mirrorLayout near-center dedupes to 4');
eq(
  L.mirrorLayout([[25, 25]], 20),
  [],
  'mirrorLayout drops out-of-bounds base cells'
);

// slideDir: ice momentum pipeline
var R = { x: 1, y: 0 },
  U = { x: 0, y: -1 },
  Ld = { x: -1, y: 0 };
var s1 = L.slideDir([Ld], null, R);
eq(s1, { dir: R, pending: Ld, queue: [] }, 'slideDir stashes turn, moves straight');
var s2 = L.slideDir(s1.queue, s1.pending, s1.dir);
eq(s2, { dir: Ld, pending: null, queue: [] }, 'slideDir applies stashed turn next tick');
var s3 = L.slideDir([Ld, U], null, R);
eq(s3.queue, [U], 'slideDir FIFO: only head stashed');
var s4 = L.slideDir(s3.queue, s3.pending, s3.dir);
eq(s4, { dir: Ld, pending: null, queue: [U] }, 'slideDir pending wins over queued');
var s5 = L.slideDir([], null, R);
eq(s5, { dir: R, pending: null, queue: [] }, 'slideDir empty is identity');

console.log('\n==== unit: ' + (process.exitCode ? 'FAILURES' : n + '/' + n + ' passed') + ' ====');

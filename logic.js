/* Pure game logic: zero DOM, zero THREE, zero Math.random inside (RNG injected).
 * Loaded in the browser before main.js and required by test/unit.js in node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SnakeLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function nextPos(head, dir) {
    return { x: head.x + dir.x, y: head.y + dir.y };
  }
  function wrapPos(p, n) {
    return { x: ((p.x % n) + n) % n, y: ((p.y % n) + n) % n };
  }
  function inBounds(p, n) {
    return p.x >= 0 && p.y >= 0 && p.x < n && p.y < n;
  }
  function key(x, y, n) {
    return x + y * n;
  }
  // Tail cell vacates unless growing.
  function hitsBody(p, body, growing) {
    var end = growing ? body.length : body.length - 1;
    for (var i = 0; i < end; i++) if (body[i].x === p.x && body[i].y === p.y) return true;
    return false;
  }
  function levelFor(foods, perLevel) {
    return 1 + Math.floor(foods / perLevel);
  }
  // ---------- Combo risk ladder ----------
  // The multiplier used to be pinned at x5 (`Math.min(c, 5)`), so a chain past
  // five was a dead plateau: the 6th chained food scored exactly what the 5th
  // did, and the reward curve stopped responding to skill for the rest of the
  // run. It is now a ladder - the multiplier keeps climbing, and the window you
  // have to land the NEXT eat inside shrinks every step. A long chain is
  // therefore a bet rather than a free plateau: the greedier you get, the less
  // time you have to keep what you already earned.
  var COMBO_STEP = 0.86; // window factor per combo step
  var COMBO_MIN_WINDOW = 1100; // never squeezes below this (ms)
  // Window still open for the current step. Uses the combo held *before* the
  // eat, so the value that judged the last gap is the same one the player saw.
  function comboWindow(base, combo) {
    if (!combo || combo < 1) return base;
    // rounded to whole ms: the value is surfaced in the HUD and compared in
    // tests, and a float window is never what anyone wants to read
    return Math.max(COMBO_MIN_WINDOW, Math.round(base * Math.pow(COMBO_STEP, combo - 1)));
  }
  // Chained eats raise the combo; `window` is the next step's allowance, which
  // the caller can surface so the shrinking risk is visible rather than secret.
  function comboFor(combo, lastAt, now, win) {
    var c = now - lastAt <= comboWindow(win, combo) ? combo + 1 : 1;
    return { combo: c, mult: c, window: comboWindow(win, c) };
  }
  function scoreGain(base, mult) {
    return base * mult;
  }
  // Streak bank: convert a live chain into a guaranteed lump sum. Quadratic on
  // purpose - holding for a bigger chain always pays strictly more than banking
  // early, but so does the per-food value of simply keeping eating, so "bank
  // now" is always the safe-and-worse option. That gap is the whole decision.
  function bankValue(combo, unit, mult) {
    if (!combo || combo < 1) return 0;
    unit = unit == null ? 5 : unit;
    mult = mult == null ? 1 : mult;
    return Math.round(unit * combo * combo * mult);
  }
  // Daily challenge seed: same day -> same seed -> same map and same rule for
  // everyone. Days since the Unix epoch, hashed with Knuth's multiplicative
  // constant so consecutive days land far apart in the mulberry32 stream.
  function dailySeed(day) {
    return (Math.imul(day | 0, 2654435761) >>> 0) % 100000;
  }
  // Snap a screen/world desire vector to the nearest of 4 grid dirs.
  // Ties drop the suicide (opposite-of-heading) candidate first (len > 1),
  // fixed order [up, down, left, right] after that. Never returns opposite
  // of heading unless len <= 1 (no neck to hit).
  function snapDir(dx, dz, dir, len) {
    var cands = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    var best = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var d = cands[i][0] * dx + cands[i][1] * dz;
      if (d > best) best = d;
    }
    for (var j = 0; j < cands.length; j++) {
      var d2 = cands[j][0] * dx + cands[j][1] * dz;
      if (d2 < best - 1e-9) continue;
      if (len > 1 && cands[j][0] === -dir.x && cands[j][1] === -dir.y) continue;
      return { x: cands[j][0], y: cands[j][1] };
    }
    return { x: cands[0][0], y: cands[0][1] };
  }
  // Random free cell from an occupancy set, then exhaustive scan fallback.
  // occ: object/set-like with truthy lookup by key(x,y,n). rand: () => [0,1).
  function findFree(occ, n, rand, tries) {
    tries = tries == null ? 300 : tries;
    for (var t = 0; t < tries; t++) {
      var x = Math.floor(rand() * n),
        y = Math.floor(rand() * n);
      if (!occ[key(x, y, n)]) return { x: x, y: y };
    }
    var empt = [];
    for (var yy = 0; yy < n; yy++)
      for (var xx = 0; xx < n; xx++) if (!occ[key(xx, yy, n)]) empt.push({ x: xx, y: yy });
    if (!empt.length) return null;
    return empt[Math.floor(rand() * empt.length)];
  }
  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  // Deterministic PRNG (mulberry32) for seeded runs (?seed= deep links).
  // Same seed -> same sequence, so a shared link replays identical spawns.
  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var z = Math.imul(a ^ (a >>> 15), 1 | a);
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  // Quadrant-mirrored obstacle layout: base cells in one quadrant mirrored
  // across both axes, deduped (center-crossing cells) and sorted for
  // deterministic order. Same input -> same fair, symmetric map.
  function mirrorLayout(base, n) {
    var out = [],
      seen = {};
    for (var i = 0; i < base.length; i++) {
      var x = base[i][0],
        y = base[i][1];
      var pts = [
        [x, y],
        [n - 1 - x, y],
        [x, n - 1 - y],
        [n - 1 - x, n - 1 - y],
      ];
      for (var j = 0; j < pts.length; j++) {
        var px = pts[j][0],
          py = pts[j][1];
        if (px < 0 || px >= n || py < 0 || py >= n) continue;
        var k = px + py * n;
        if (!seen[k]) {
          seen[k] = true;
          out.push({ x: px, y: py });
        }
      }
    }
    out.sort(function (a, b) {
      return a.y * n + a.x - (b.y * n + b.x);
    });
    return out;
  }
  // Ice slide: turns take effect one cell later (momentum pipeline).
  // pending = turn stashed last tick; it applies before any queued turn
  // (FIFO: pending was queue[0] when stashed). Pure per-tick transition.
  function slideDir(queue, pending, dir) {
    if (pending) return { dir: pending, pending: null, queue: queue };
    if (queue.length) return { dir: dir, pending: queue[0], queue: queue.slice(1) };
    return { dir: dir, pending: null, queue: queue };
  }

  return {
    nextPos: nextPos,
    wrapPos: wrapPos,
    inBounds: inBounds,
    key: key,
    hitsBody: hitsBody,
    levelFor: levelFor,
    comboFor: comboFor,
    comboWindow: comboWindow,
    bankValue: bankValue,
    dailySeed: dailySeed,
    scoreGain: scoreGain,
    snapDir: snapDir,
    findFree: findFree,
    manhattan: manhattan,
    mulberry32: mulberry32,
    mirrorLayout: mirrorLayout,
    slideDir: slideDir,
    fmtTime: fmtTime,
  };
});

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
  // Chained eats within `win` ms raise combo (mult capped at 5).
  function comboFor(combo, lastAt, now, win) {
    var c = now - lastAt <= win ? combo + 1 : 1;
    return { combo: c, mult: Math.min(c, 5) };
  }
  function scoreGain(base, mult) {
    return base * mult;
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
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  return {
    nextPos: nextPos,
    wrapPos: wrapPos,
    inBounds: inBounds,
    key: key,
    hitsBody: hitsBody,
    levelFor: levelFor,
    comboFor: comboFor,
    scoreGain: scoreGain,
    snapDir: snapDir,
    findFree: findFree,
    manhattan: manhattan,
    fmtTime: fmtTime,
  };
});

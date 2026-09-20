/* Contrast audit: every gameplay-critical color must stand out from its
 * biome ground (food, snake head/body in both palettes + all skins, bonus,
 * obstacles). WCAG-style luminance ratios, game-tuned floor. Run:
 * `npm run test:contrast`. Fails non-zero. */
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const FLOOR = 1.8; // large game graphics (not text): clearly distinguishable

function lum(hex) {
  const n = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex;
  const r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const hex6 = (h) => '#' + h.toString(16).padStart(6, '0');

// ---- extract tables from main.js (single source of truth: the game code)
const levelsRegion = main.slice(main.indexOf('var LEVELS = ['), main.indexOf('var themeIdx'));
const names = [...levelsRegion.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
const grounds = [...levelsRegion.matchAll(/ground: (0x[0-9a-f]+)/g)].map((m) => parseInt(m[1]));
const obColors = [...levelsRegion.matchAll(/obColor: (0x[0-9a-f]+)/g)].map((m) => parseInt(m[1]));
const foodRegion = main.slice(main.indexOf('var FOOD_TINT = ['), main.indexOf('var WALL_STYLE'));
const foodHex = [...foodRegion.matchAll(/c: (0x[0-9a-f]+)/g)].map((m) => parseInt(m[1]));
const palRegion = main.slice(main.indexOf('var PALETTES = {'), main.indexOf('function curPal'));
function palBlock(name) {
  const start = palRegion.indexOf(name + ': {');
  const end = palRegion.indexOf('},', start);
  const slice = palRegion.slice(start, end);
  const get = (k) => parseInt(slice.match(new RegExp('\\b' + k + ': (0x[0-9a-f]+)'))[1]);
  return { head: get('head'), bodyA: get('bodyA'), bodyB: get('bodyB'), bonus: get('bonus') };
}
const pals = { standard: palBlock('standard'), cb: palBlock('cb') };
const skinsRegion = main.slice(main.indexOf('var SKINS = ['), main.indexOf('function skinById'));
const skins = [
  ...skinsRegion.matchAll(/css: \{ head: '(#[0-9a-f]+)', body: \['(#[0-9a-f]+)', '(#[0-9a-f]+)'\]/g),
].map((m) => ({ head: m[1], body: [m[2], m[3]] }));
const skinIds = [...skinsRegion.matchAll(/ach: '([a-z0-9]+)'/g)].map((m) => m[1]);

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}

check('contrast: parsed 8 biomes', names.length === 8 && grounds.length === 8, names.join(','));
check('contrast: parsed 8 food tints', foodHex.length === 8);
check('contrast:parsed skins', skins.length === skinIds.length, skins.length + ' css skins');

for (let i = 0; i < names.length; i++) {
  const g = grounds[i],
    tag = names[i];
  check(tag + ': food vs ground', ratio(foodHex[i], g) >= FLOOR, ratio(foodHex[i], g).toFixed(2));
  for (const pn of Object.keys(pals)) {
    const p = pals[pn];
    check(
      tag + ': snake(' + pn + ') vs ground',
      ratio(p.head, g) >= FLOOR && ratio(p.bodyA, g) >= FLOOR && ratio(p.bodyB, g) >= FLOOR,
      [p.head, p.bodyA, p.bodyB].map((h) => ratio(h, g).toFixed(2)).join('/')
    );
    check(tag + ': bonus(' + pn + ') vs ground', ratio(p.bonus, g) >= FLOOR, ratio(p.bonus, g).toFixed(2));
  }
  check(tag + ': obstacle vs ground', ratio(obColors[i], g) >= FLOOR, ratio(obColors[i], g).toFixed(2));
  for (let s = 0; s < skins.length; s++) {
    const sk = skins[s];
    const ok = ratio(sk.head, g) >= FLOOR && ratio(sk.body[0], g) >= FLOOR && ratio(sk.body[1], g) >= FLOOR;
    check(
      tag + ': skin#' + s + '(' + (skinIds[s] || '?') + ') vs ground',
      ok,
      [sk.head, ...sk.body].map((h) => ratio(h, g).toFixed(2)).join('/')
    );
  }
}

console.log('\n==== contrast: ' + (fails ? 'FAILURES (' + fails + ')' : 'all clear') + ' ====');
process.exit(fails ? 1 : 0);

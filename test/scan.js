/* Static bug scanner: cross-checks ids, i18n keys, test hooks, button wiring,
 * service-worker assets and dead code. Run: `npm run test:scan`. Fails non-zero. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const main = read('main.js');
const html = read('index.html');
const i18nSrc = read('i18n.js');

let fails = 0;
function bad(name, extra) {
  fails++;
  console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : ''));
}
function good(name) {
  console.log('PASS  ' + name);
}

// ---- 1. i18n key coverage: every t('k') / data-i18n="k" must exist in all 4 langs
const used = new Set();
for (const m of main.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) if (!/_$/.test(m[1])) used.add(m[1]); // skip 'ach_'+id style prefixes
for (const m of html.matchAll(/data-i18n(?:-html)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
const langBlocks = {};
for (const m of i18nSrc.matchAll(/^    (en|es|fr|de): \{/gm)) langBlocks[m[1]] = m.index;
const langs = Object.keys(langBlocks);
function blockHas(lang, key) {
  const start = langBlocks[lang];
  const ends = Object.values(langBlocks).filter((i) => i > start);
  const end = ends.length ? Math.min(...ends) : i18nSrc.length;
  return new RegExp('\\b' + key + '\\s*:').test(i18nSrc.slice(start, end));
}
const missing = [];
for (const k of [...used].sort()) for (const l of langs) if (!blockHas(l, k)) missing.push(l + ':' + k);
if (missing.length) bad('i18n coverage', missing.join(', '));
else good('i18n coverage (' + used.size + ' keys x ' + langs.length + ' langs)');

// ---- 2. biome_* / ach_* keys for content defined in code
const levelNames = [...main.matchAll(/name: '([A-Za-z]+)',\n\s*icon:/g)].map((m) => m[1]);
const unlockIds = [...main.matchAll(/unlock\('([a-z0-9]+)'\)/g)].map((m) => m[1]);
const contentKeys = [
  ...new Set([...levelNames.map((n) => 'biome_' + n), ...unlockIds.map((i) => 'ach_' + i)]),
];
const missingContent = contentKeys.filter((k) => !blockHas('en', k));
if (missingContent.length) bad('content keys', missingContent.join(', '));
else good('content keys (biomes ' + levelNames.length + ', achievements ' + unlockIds.length + ')');

// ---- 3. duplicate id="..." in HTML
const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupIds.length) bad('duplicate ids', [...new Set(dupIds)].join(', '));
else good('duplicate ids (' + ids.length + ' unique)');

// ---- 4. every $('x') in main.js must exist in HTML
const refs = new Set([...main.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missingIds = [...refs].filter((id) => !ids.includes(id));
if (missingIds.length) bad('dangling $() refs', missingIds.join(', '));
else good('$() refs (' + refs.size + ' all resolve)');

// ---- 5. __game hooks used by e2e must exist in main.js
const hookSrc = main.slice(main.indexOf('window.__game = {'));
const hookNames = new Set(
  [
    ...hookSrc.matchAll(/get (\w+)\(\)/g),
    ...hookSrc.matchAll(/^\s{4}(\w+): function/gm),
    ...hookSrc.matchAll(/^\s{4}(\w+): (?!function)[\w]+,/gm),
  ].flatMap((m) => [m[1]])
);
const e2eSrc = read('e2e/test.js') + read('e2e/mobile.js');
const usedHooks = new Set([...e2eSrc.matchAll(/__game\.(\w+)/g)].map((m) => m[1]));
const missingHooks = [...usedHooks].filter((h) => !hookNames.has(h));
if (missingHooks.length) bad('dangling __game hooks', missingHooks.join(', '));
else good('__game hooks (' + usedHooks.size + ' used, all defined)');

// ---- 6. no console.log noise in shipped scripts
const noisy = ['main.js', 'logic.js', 'i18n.js'].filter((f) => /console\.(log|debug)\(/.test(read(f)));
if (noisy.length) bad('console noise', noisy.join(', '));
else good('console noise');

// ---- 7. no TODO/FIXME/XXX leftovers
const todos = ['main.js', 'logic.js', 'i18n.js', 'index.html', 'style.css', 'sw.js'].filter((f) =>
  /TODO:|FIXME|XXX|\bHACK\b/i.test(read(f))
);
if (todos.length) bad('todo markers', todos.join(', '));
else good('todo markers');

// ---- 8. every <button id> in HTML is wired in main.js
const buttons = [...html.matchAll(/<button[^>]* id="([^"]+)"/g)].map((m) => m[1]);
const unwired = buttons.filter((id) => !new RegExp(`\\$\\('${id}'\\)`).test(main));
if (unwired.length) bad('unwired buttons', unwired.join(', '));
else good('unwired buttons (' + buttons.length + ' wired)');

// ---- 9. service-worker LOCAL assets exist on disk
const swAssets = [...read('sw.js').matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
const missingAssets = swAssets.filter((a) => !fs.existsSync(path.join(ROOT, a === '' ? 'index.html' : a)));
if (missingAssets.length) bad('sw assets', missingAssets.join(', '));
else good('sw assets (' + swAssets.length + ' exist)');

// ---- 10. manifest icon + start_url exist
const manifest = JSON.parse(read('manifest.json'));
const manifestFiles = [manifest.start_url.replace(/^\.\//, ''), ...manifest.icons.map((i) => i.src)];
const missingManifest = manifestFiles.filter((a) => !fs.existsSync(path.join(ROOT, a)));
if (missingManifest.length) bad('manifest files', missingManifest.join(', '));
else good('manifest files');

// ---- 11. SETTING_IDS all match real inputs
const settingIds = [...main.matchAll(/'((?:opt|btn)-[a-z-]+)'/g)]
  .map((m) => m[1])
  .filter((id) => id.startsWith('opt-'));
const missingInputs = [...new Set(settingIds)].filter((id) => !ids.includes(id));
if (missingInputs.length) bad('setting inputs', missingInputs.join(', '));
else good('setting inputs');

// ---- 13. LEVELS entries complete + decor/tex keys resolve
const levelsRegion = main.slice(main.indexOf('var LEVELS = ['), main.indexOf('var themeIdx'));
const levelFields = [
  'name',
  'icon',
  'bg',
  'ground',
  'grid',
  'wall',
  'css',
  'ob',
  'obColor',
  'hemiSky',
  'hemiGround',
  'decor',
  'tex',
];
const incomplete = levelFields.filter((f) => {
  const c = (levelsRegion.match(new RegExp('\\b' + f + '\\s*:', 'g')) || []).length;
  return c !== 8;
});
const decorVals = [...levelsRegion.matchAll(/decor: '(\w+)'/g)].map((m) => m[1]);
const texVals = [...levelsRegion.matchAll(/tex: '(\w+)'/g)].map((m) => m[1]);
const decorTable = main.slice(main.indexOf('var DECORTABLE = {'));
const texTable = main.slice(main.indexOf('var TEXPAINTERS = {'));
const badDecor = [...new Set(decorVals)].filter((k) => !new RegExp('\\b' + k + '\\s*:').test(decorTable));
const badTex = [...new Set(texVals)].filter((k) => !new RegExp('\\b' + k + '\\s*:').test(texTable));
const levelProblems = [...incomplete.map((f) => 'field:' + f), ...badDecor, ...badTex];
if (levelProblems.length) bad('biome completeness', levelProblems.join(', '));
else good('biome completeness (8 biomes, decor+painters resolve)');

// ---- 12. duplicate keys inside the __game hooks literal
const hookRegion = hookSrc.slice(0, hookSrc.indexOf('// ---------- Boot'));
const keyCounts = {};
for (const line of hookRegion.split('\n')) {
  const m = line.match(/^\s{4}(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(\))/);
  if (m) keyCounts[m[1]] = (keyCounts[m[1]] || 0) + 1;
}
const dupKeys = Object.entries(keyCounts)
  .filter(([, c]) => c > 1)
  .map(([k]) => k);
if (dupKeys.length) bad('duplicate hook keys', dupKeys.join(', '));
else good('duplicate hook keys');

console.log('\n==== scan: ' + (fails ? 'FAILURES' : 'all clean') + ' ====');
process.exit(fails ? 1 : 0);

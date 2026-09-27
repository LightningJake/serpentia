// Fails when a change ships without invalidating the service worker cache.
//
// The footgun this exists to kill: sw.js is byte-compared by the browser, so if
// sw.js itself is unchanged the new worker never installs, nothing is
// re-precached, and returning players keep the PREVIOUS build served straight
// out of the old cache. That is exactly the "my fix did not land until I hard
// refreshed" bug, and it is invisible locally because a fresh profile has no
// stale cache to be wrong about.
//
// Rule: if sw.js OR any file it precaches changed, the CACHE version must have
// changed too. The precache list is parsed out of sw.js, so adding an asset to
// LOCAL is covered automatically without touching this file.
//
// Escape hatch (use sparingly, with a reason on the same line):
//   const CACHE = 'snake-v8'; // sw-bump-exempt: comment-only sw.js change
// A comment-only sw.js edit legitimately needs no bump, and a guard with no
// escape hatch is a guard people learn to disable.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, ok, extra) => {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
};

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function cacheVersion(src) {
  const m = src.match(/const\s+CACHE\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}
function isExempt(src) {
  return /sw-bump-exempt\s*:/i.test(src);
}
// relative paths sw.js precaches, parsed from LOCAL so this never drifts
function precachedFiles(src) {
  const m = src.match(/const\s+LOCAL\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  const out = [];
  const re = /'([^']+)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) {
    const p = hit[1].replace(/^\.\//, '');
    if (p && p !== '') out.push(p === '' ? 'index.html' : p);
  }
  return out;
}
// './' means the directory itself, which git tracks as index.html
function trackedName(p) {
  return p === 'index.html' ? 'index.html' : p;
}

console.log('=== sw: cache version guard ===');
const head = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const headVer = cacheVersion(head);
check('sw.js declares a CACHE version', !!headVer, String(headVer));

// base = the commit this change is being compared against.
//
// Two different situations, and getting this wrong silently passes everything:
//   - clean tree (CI after checkout, or locally before committing): the thing
//     under test is HEAD, so compare it against its parent HEAD~1.
//   - dirty tree (locally, mid-change): the thing under test is the WORKING
//     TREE, so compare it against HEAD. Using HEAD~1 here would compare the
//     new work against a commit that is already superseded and pass for free.
let baseRef = process.env.SW_BASE_REF || '';
if (!baseRef) {
  const watched = ['sw.js'].concat(precachedFiles(head).map(trackedName));
  let dirty = false;
  try {
    const st = git(['status', '--porcelain', '--'].concat(watched));
    dirty = st.trim().length > 0;
  } catch (e) {
    dirty = false;
  }
  const ref = dirty ? 'HEAD' : 'HEAD~1';
  try {
    baseRef = git(['rev-parse', '--verify', '--quiet', ref]).trim();
  } catch (e) {
    baseRef = '';
  }
  if (baseRef) console.log('comparing working tree against ' + ref + (dirty ? ' (uncommitted changes)' : ''));
}

if (!baseRef) {
  console.log('SKIP  no base commit to compare against (first commit)');
} else {
  let baseSw;
  try {
    baseSw = git(['show', baseRef + ':sw.js']);
  } catch (e) {
    baseSw = null;
  }
  if (baseSw === null) {
    console.log('SKIP  sw.js did not exist at ' + baseRef);
  } else {
    const baseVer = cacheVersion(baseSw);
    const files = precachedFiles(head).map(trackedName);
    const changed = [];
    if (baseSw !== head) changed.push('sw.js');
    for (const f of files) {
      let a, b;
      try {
        a = git(['show', baseRef + ':' + f]);
      } catch (e) {
        a = null; // new file
      }
      try {
        b = fs.readFileSync(path.join(ROOT, f), 'utf8');
      } catch (e) {
        b = null; // deleted
      }
      if (a !== b) changed.push(f);
    }
    const bumped = headVer !== baseVer;
    if (changed.length === 0) {
      console.log('SKIP  nothing that affects the cache changed vs ' + baseRef.slice(0, 7));
    } else if (isExempt(head)) {
      console.log('SKIP  sw-bump-exempt declared on the CACHE line: ' + changed.join(', '));
    } else {
      check(
        'cache version bumped when cached files changed (' + changed.join(', ') + ')',
        bumped,
        baseVer + ' -> ' + headVer
      );
      if (!bumped) {
        console.log('');
        console.log('  Returning players will keep the PREVIOUS build:');
        console.log('  sw.js is byte-compared by the browser, so an unchanged sw.js');
        console.log('  never installs a new worker and nothing is re-precached.');
        console.log(
          "  Bump it:  const CACHE = 'snake-v" + (parseInt(String(baseVer).replace(/\D/g, ''), 10) + 1) + "';"
        );
        console.log('  Or, for a comment-only sw.js edit, add on that same line:');
        console.log('    // sw-bump-exempt: <reason>');
      }
    }
  }
}

const failed = results.filter((r) => !r).length;
console.log('\n==== ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);

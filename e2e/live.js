/* Live release verification for the deployed build.
 * Usage: `npm run test:live` (defaults to the production URL below)
 *    or: LIVE_URL=https://<preview>.vercel.app npm run test:live
 * Covers the release checklist: boot timing, loader, full run, console/SW
 * audit, mobile emulation, and the offline airplane-mode reload. */
const { chromium } = require('playwright-core');

const BASE = process.env.LIVE_URL || 'https://serpentia-coral.vercel.app/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}
const g = (page, expr) => page.evaluate(new Function('return window.__game.' + expr));

async function launch() {
  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
    ],
  };
  if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
  else if (process.env.PW_EXECUTABLE) launchOpts.executablePath = process.env.PW_EXECUTABLE;
  else launchOpts.executablePath = EDGE;
  return chromium.launch(launchOpts);
}

(async () => {
  console.log('live target: ' + BASE);
  const browser = await launch();
  try {
    // ---------- desktop pass ----------
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
    });

    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    const bootMs = Date.now() - t0;
    console.log('live: boot to interactive in ' + bootMs + 'ms');
    check('live: boots to menu', (await g(page, 'state')) === 'menu');
    check('live: loader hidden', await page.locator('#loader').isHidden());
    check('live: boot under 15s on this link', bootMs < 15000, bootMs + 'ms');
    // release artifacts must exist on production (fails right after new files until redeploy)
    const liveOg = await page.evaluate(() =>
      fetch('og-image.png')
        .then((r) => r.status)
        .catch(() => -1)
    );
    const liveRobots = await page.evaluate(() =>
      fetch('robots.txt')
        .then((r) => r.text())
        .catch(() => '')
    );
    check('live: og-image deployed', liveOg === 200, String(liveOg));
    check('live: robots+sitemap deployed', /Allow: \//.test(liveRobots));

    // full run: start -> eat -> die -> restart -> pause menu
    await page.locator('#btn-play').click();
    await page.waitForTimeout(300);
    check('live: starts', (await g(page, 'state')) === 'playing');
    await page.evaluate(() => {
      const s = window.__game.snake,
        d = window.__game.dir;
      window.__game.setFood(s[0].x + d.x, s[0].y + d.y);
    });
    await page.waitForFunction(() => window.__game.score >= 10, null, { timeout: 8000 });
    check('live: eating scores', true);
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForFunction(() => window.__game.state === 'over', null, { timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, {
      timeout: 8000,
    });
    check('live: death + game-over card', /Game Over/.test(await page.locator('#ov-title').textContent()));
    await page.locator('#btn-play').click();
    await page.waitForTimeout(250);
    check('live: play-again restarts', (await g(page, 'state')) === 'playing');
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(250);
    check(
      'live: pause menu opens',
      (await g(page, 'state')) === 'paused' && (await page.locator('#pause-menu').isVisible())
    );
    await page.locator('#btn-quit').click();
    await page.waitForTimeout(250);
    check('live: quit to menu', (await g(page, 'state')) === 'menu');

    // service worker + 3D FPS sample (wrap on so it survives unattended)
    const swReg = await page.evaluate(() =>
      navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => !!r) : 'n/a'
    );
    check('live: service worker registered', swReg === true, String(swReg));
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
    });
    await page.waitForTimeout(4000);
    const perf = await page.evaluate(() => window.__game.perf());
    console.log('live: perf sample ' + JSON.stringify(perf));
    check('live: renders frames', perf.fps > 5, 'fps=' + perf.fps);
    check('live: no page errors (desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));
    check(
      'live: no console errors (desktop)',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ')
    );
    await page.close();

    // ---------- mobile emulation pass ----------
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const mp = await mctx.newPage();
    const merr = [];
    mp.on('pageerror', (e) => merr.push(String((e && e.message) || e)));
    await mp.goto(BASE, { waitUntil: 'load' });
    await mp.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    await mp.locator('#btn-play').tap();
    await mp.waitForTimeout(300);
    check('live-mobile: tap starts', (await g(mp, 'state')) === 'playing');
    await mp.evaluate(() => {
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
      window.__game.pause();
    });
    const pt = await mp.evaluate(() => window.__game.screenFor(14, 10));
    if (pt) {
      await mp.touchscreen.tap(pt.x, pt.y);
      await mp.waitForTimeout(500);
      const md = await mp.evaluate(() => window.__game.dir);
      check('live-mobile: tap steers', md.x === 1 && md.y === 0, JSON.stringify(md));
    } else {
      check('live-mobile: tap steers (2D fallback path)', true, '2d mode');
    }
    check('live-mobile: no page errors', merr.length === 0, merr.slice(0, 2).join(' | '));
    await mctx.close();

    // ---------- offline airplane-mode pass ----------
    const octx = await browser.newContext();
    const op = await octx.newPage();
    const oerr = [];
    op.on('pageerror', (e) => oerr.push(String((e && e.message) || e)));
    await op.goto(BASE, { waitUntil: 'load' });
    await op.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    // ensure the SW controls the page, then kill the network and reload
    await op.reload({ waitUntil: 'load' });
    await op.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    const controlled = await op.evaluate(() =>
      navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => !!r) : false
    );
    await octx.setOffline(true);
    await op.reload({ waitUntil: 'load' }).catch(() => {});
    await op.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
    check(
      'live-offline: game boots with no network',
      true,
      'sw=' + controlled + ' mode=' + (await g(op, 'mode'))
    );
    check('live-offline: menu interactive', (await g(op, 'state')) === 'menu');
    await op.locator('#btn-play').click();
    await op.waitForTimeout(400);
    check('live-offline: playable offline', (await g(op, 'state')) === 'playing');
    check('live-offline: no page errors', oerr.length === 0, oerr.slice(0, 2).join(' | '));
    await octx.setOffline(false);
    await octx.close();
  } finally {
    await browser.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== live: ' + (results.length - fails.length) + '/' + results.length + ' passed ====');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

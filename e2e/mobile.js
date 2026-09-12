/* Mobile pass: 390x844 touch viewport. Covers tap-to-steer, swipe steering,
 * auto D-pad, and touch Start. Run: `npm run test:mobile`. */
const { chromium } = require('playwright-core');
const { serve } = require('./server');

const PORT = 8902;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.149.0/three.min.js';

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}
const g = (page, expr) => page.evaluate(new Function('return window.__game.' + expr));

(async () => {
  const server = serve(PORT);
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
  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });

    check('m-boot: game loads on mobile viewport', true, await g(page, 'mode'));
    check('m-boot: dpad auto-visible on coarse pointer', await page.locator('#dpad').isVisible());

    // Touch Start (real tap = pointerdown fast path)
    await page.locator('#btn-play').tap();
    await page.waitForTimeout(300);
    check('m-start: tap starts game', (await g(page, 'state')) === 'playing', await g(page, 'state'));

    // Tap-to-steer at a board cell right of the head (paused + settled: deterministic)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
    });
    await page.waitForTimeout(2500);
    const mode = await g(page, 'mode');
    let px, py;
    if (mode === '3d') {
      const pt = await page.evaluate(() => window.__game.screenFor(14, 10));
      px = pt.x;
      py = pt.y; // screenFor already returns viewport CSS px
    } else {
      const v = await page.evaluate(() => window.__game.view);
      const rect = await page.locator('#scene').boundingBox();
      px = rect.x + (v.ox + 14.5 * v.cell) / v.dpr;
      py = rect.y + (v.oy + 10.5 * v.cell) / v.dpr;
    }
    // synthetic touch tap on canvas: bypasses overlay hit-test, exercises
    // our own touchstart/touchend + mapping logic deterministically
    await page.evaluate(
      ({ x, y }) => {
        const c = document.getElementById('scene');
        const mk = (id) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
        c.dispatchEvent(
          new TouchEvent('touchstart', { touches: [mk(1)], changedTouches: [mk(1)], bubbles: true })
        );
        c.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(1)], bubbles: true }));
      },
      { x: px, y: py }
    );
    const tq = await page.evaluate(() => window.__game.queue);
    check(
      'm-tap: touchscreen tap queues right',
      tq.length > 0 && tq[0].x === 1 && tq[0].y === 0,
      JSON.stringify(tq)
    );

    // Synthetic swipe right (TouchEvent constructor path).
    // Axis-aligned camera first: diagonal default ties right/up (correctly a no-op).
    await page.evaluate(() => {
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
      window.__game.setCam(0, 0.95);
      window.__game.pause();
    });
    await page.waitForTimeout(300); // let camera.position settle onto the orbit
    await page.evaluate(() => {
      const c = document.getElementById('scene');
      const mk = (id, x, y) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
      const t0 = mk(1, 200, 400);
      c.dispatchEvent(new TouchEvent('touchstart', { touches: [t0], changedTouches: [t0], bubbles: true }));
      c.dispatchEvent(
        new TouchEvent('touchend', { touches: [], changedTouches: [mk(1, 300, 400)], bubbles: true })
      );
    });
    await page.waitForTimeout(500);
    const sq = await page.evaluate(() => window.__game.queue);
    check('m-swipe: swipe right queues', sq.length > 0 && sq[0].x === 1 && sq[0].y === 0, JSON.stringify(sq));

    // D-pad button steers on mobile (queue assert: deterministic while paused)
    await page.evaluate(() => window.__game.setDir(1, 0)); // head right, queue cleared
    await page.locator('#dpad button[data-dir="left"]').tap();
    const dq = await page.evaluate(() => window.__game.queue);
    check('m-dpad: left queues turn', dq.length > 0 && dq[dq.length - 1].y === -1, JSON.stringify(dq));

    check('m-clean: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== mobile: ' + (results.length - fails.length) + '/' + results.length + ' passed ====');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

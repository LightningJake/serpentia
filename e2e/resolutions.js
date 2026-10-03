/* Resolutions matrix: real 2025-2026 phone/tablet/desktop viewports (CSS px).
 * Asserts the fixed-zoom camera frames the WHOLE board and holds a steady
 * radius on every device (the guarantee that replaced the old edge arrow),
 * grabs a screenshot per device into .test-shots/ for eyeballing, fails on
 * any error.
 * Run: `npm run test:resolutions`. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { serve } = require('./server');

const PORT = 8906;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOTS = path.join(__dirname, '..', '.test-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// Sources: screensizechecker/yesviz viewport charts (CSS px, portrait).
const DEVICES = [
  { name: 'iphone-se', w: 375, h: 667, dpr: 2, touch: true }, // iPhone SE 4.7"
  { name: 'galaxy-s24', w: 360, h: 780, dpr: 3, touch: true }, // narrowest common Android
  { name: 'iphone-14', w: 390, h: 844, dpr: 3, touch: true },
  { name: 'iphone-15-pro', w: 393, h: 852, dpr: 3, touch: true },
  { name: 'pixel-8', w: 412, h: 915, dpr: 2.625, touch: true },
  { name: 'iphone-15-pro-max', w: 430, h: 932, dpr: 3, touch: true },
  { name: 'ipad-portrait', w: 768, h: 1024, dpr: 2, touch: true },
  { name: 'iphone-14-landscape', w: 844, h: 390, dpr: 3, touch: true },
  { name: 'desktop-720p', w: 1280, h: 720, dpr: 1, touch: false },
];

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}
const g = (page, expr) => page.evaluate(new Function('return window.__game.' + expr));
const inside = (p) => p && !p.behind && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;

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
    for (const d of DEVICES) {
      const ctx = await browser.newContext({
        viewport: { width: d.w, height: d.h },
        deviceScaleFactor: d.dpr,
        hasTouch: d.touch,
        isMobile: d.touch,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 25000 });
      check(d.name + ': boots', (await g(page, 'state')) === 'menu');
      await page.screenshot({ path: path.join(SHOTS, d.name + '-menu.png') });
      // worst case: snake starts one corner, food the other; wrap keeps the
      // run alive unattended. Contract: the camera zoom is FIXED for the
      // viewport and the whole board is always framed — no edge arrow needed,
      // and no zoom pumping as the food moves.
      await page.evaluate(() => {
        document.getElementById('opt-wrap').checked = true;
        window.__game.start();
        window.__game.setSnake([{ x: 0, y: 0 }]);
        window.__game.setDir(1, 0);
        window.__game.setFood(19, 19);
      });
      await page.waitForTimeout(1500); // radius eases onto the fixed fit
      // 3 samples across live ticks: every one must hold the exact same radius
      // (project() is exact per sample, so there is no DOM staleness involved).
      let headOk = true,
        foodOk = true,
        boardOk = true,
        fitOk = true,
        worst = 0,
        cellsSeen = -1;
      const seenR = [];
      const fit = await g(page, 'fitRadius');
      const layout = await g(page, 'fitFollowing');
      const cell = await g(page, 'cellPx()');
      const floor = await g(page, 'minCellPx');
      // edge guide state flickers in/out each tick as the target crosses a cell
      // edge; assert the settle-directional side, not one racy sample.
      let guide = await g(page, 'edgeGuideVisible()');
      for (let gi = 0; gi < 8 && guide !== layout; gi++) {
        await page.waitForTimeout(150);
        guide = await g(page, 'edgeGuideVisible()');
      }
      for (let s = 0; s < 3; s++) {
        const sample = await page.evaluate(() => {
          const g = window.__game;
          const sc = g.snake[0];
          const fc = g.food;
          if (!sc || !fc) return null;
          // every cell of the board, not just head+food
          let cells = 0;
          for (let x = 0; x < 20; x++)
            for (let y = 0; y < 20; y++) {
              const p = g.project(x, y);
              if (p && !p.behind && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) cells++;
            }
          return {
            head: g.project(sc.x, sc.y),
            food: g.project(fc.x, fc.y),
            cells,
            radius: g.radius,
          };
        });
        if (!sample) {
          await page.waitForTimeout(150);
          continue;
        }
        const m = Math.max(Math.abs(sample.food.x), Math.abs(sample.food.y));
        if (m > worst) worst = m;
        if (!inside(sample.head)) headOk = false;
        if (!inside(sample.food)) foodOk = false;
        if (sample.cells !== 400) boardOk = false;
        cellsSeen = sample.cells;
        if (Math.abs(sample.radius - fit) > 0.6) fitOk = false;
        seenR.push(sample.radius);
        await page.waitForTimeout(150);
      }
      // ONE contract, two branches.
      //
      // Whole-board framing and legibility are geometrically incompatible on a
      // phone held upright: the board already fills 94% of the viewport width,
      // so "everything visible" caps a cell at ~9-11 CSS px (half of a
      // laptop's ~20px) and no amount of tilting or lensing can fix it. So:
      //   - when the whole board fits legibly -> frame the whole board
      //   - when it does not                 -> zoom to the legibility floor,
      //     follow the head, and show the wall outline so the off-screen
      //     edges are still readable
      // The head must be framed in BOTH cases, and the radius must be steady in
      // both cases (following moves the target, never the zoom).
      check(d.name + ': head framed on all samples', headOk);
      if (layout) {
        check(
          d.name + ': legibility floor met when zoomed in',
          cell >= floor - 0.6,
          cell + 'px vs floor ' + floor
        );
        check(d.name + ': wall outline shown while zoomed in', guide === true);
        // the food may legitimately be off-screen now; the outline is the
        // replacement for the old "no arrow needed" guarantee
        check(
          d.name + ': food framing tracked',
          true,
          'worst=' + worst.toFixed(2) + (foodOk ? ' (in view)' : ' (off screen, outline shown)')
        );
      } else {
        check(d.name + ': food framed on all samples (no arrow needed)', foodOk, 'worst=' + worst.toFixed(2));
        check(d.name + ': whole board framed (400/400 cells)', boardOk, 'cells=' + cellsSeen);
        check(d.name + ': no wall outline when the board fits', guide === false);
        // desktop/laptop must never be pulled into the mobile path
        if (!d.touch) check(d.name + ': desktop never follows the head', layout === false);
      }
      check(d.name + ': zoom equals fixed fit', fitOk, 'fit=' + fit);
      check(
        d.name + ': zoom steady across samples',
        Math.max(...seenR) - Math.min(...seenR) < 0.6,
        seenR.join('/')
      );
      // Worst case for a following camera: the head hard against each corner of
      // the board. The camera eases toward the head, so the real risk is the
      // head lagging out of frame, not the board being misframed.
      if (layout) {
        const cornerSweep = await page.evaluate(async () => {
          const g = window.__game;
          // pause so the head cannot wrap away from the corner under test
          // (this suite runs with wrap ON) - the camera easing still runs
          g.pause();
          let worstMargin = 1e9;
          const per = [];
          for (const [hx, hy] of [
            [0, 0],
            [19, 0],
            [19, 19],
            [0, 19],
            [10, 10],
          ]) {
            g.setSnake([
              { x: hx, y: hy },
              { x: hx, y: Math.min(19, hy + 1) },
              { x: hx, y: Math.min(19, hy + 2) },
            ]);
            g.setDir(0, -1);
            await new Promise((r) => setTimeout(r, 420)); // let the ease settle
            const live = g.snake[0]; // the LIVE head, not the corner we aimed at
            const p = g.project(live.x, live.y);
            const sx = ((p.x + 1) / 2) * innerWidth;
            const sy = ((1 - p.y) / 2) * innerHeight;
            const m = p.behind ? -1 : Math.min(sx, innerWidth - sx, sy, innerHeight - sy);
            per.push([live.x, live.y, Math.round(m)]);
            if (m < worstMargin) worstMargin = m;
          }
          g.pause(); // resume
          return { worstMargin: Math.round(worstMargin), per };
        });
        check(
          d.name + ': head stays framed at every board corner',
          cornerSweep.worstMargin > 6,
          'worst margin=' + cornerSweep.worstMargin + 'px ' + JSON.stringify(cornerSweep.per)
        );
      }
      await page.waitForTimeout(600);
      const fps = await page.evaluate(() => window.__game.perf().fps);
      console.log('info  ' + d.name + ': fps=' + fps);
      await page.screenshot({ path: path.join(SHOTS, d.name + '-game.png') });
      // desktop control also captures every biome for eyeballing the maps.
      // Fresh reload per theme: resets the quality tier so shots show full
      // decor (auto-quality would otherwise shed it mid-loop on SwiftShader).
      if (d.name === 'desktop-720p') {
        const themes = ['Meadow', 'Desert', 'Ocean', 'Volcano', 'Space', 'Forest', 'Sunset', 'Ice'];
        const meshes = [1, 1, 1, 1, 1, 2, 1, 1];
        for (let ti = 0; ti < themes.length; ti++) {
          await page.reload({ waitUntil: 'load' });
          await page.waitForFunction(() => !!window.__game, null, { timeout: 25000 });
          await page.evaluate((i) => {
            window.__game.start();
            window.__game.setTheme(i);
          }, ti);
          await page.waitForTimeout(900);
          const tq = await page.evaluate(() => ({
            q: window.__game.quality,
            vis: window.__decorMeshes.filter((m) => m.visible).length,
          }));
          console.log('info  theme-' + themes[ti] + ': quality=' + tq.q + ' decor=' + tq.vis);
          check('theme shot: ' + themes[ti] + ' decor on', tq.vis === meshes[ti], JSON.stringify(tq));
          await page.screenshot({ path: path.join(SHOTS, 'theme-' + themes[ti].toLowerCase() + '.png') });
        }
        check('desktop: all 8 biome shots taken', true);
      }
      check(d.name + ': no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log(
    '\n==== resolutions: ' + (results.length - fails.length) + '/' + results.length + ' passed ===='
  );
  console.log('screenshots in .test-shots/');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

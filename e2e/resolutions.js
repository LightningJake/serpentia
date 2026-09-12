/* Resolutions matrix: real 2025-2026 phone/tablet/desktop viewports (CSS px).
 * Asserts head+food stay on screen (the framing-camera guarantee), grabs a
 * screenshot per device into .test-shots/ for eyeballing, fails on any error.
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
      // run alive unattended. Contract: the head is always framed; the food
      // is either framed or flagged by the edge arrow (aligned + live distance).
      // Radius is fixed now, so one settle wait suffices — no servo to chase.
      await page.evaluate(() => {
        document.getElementById('opt-wrap').checked = true;
        window.__game.start();
        window.__game.setSnake([{ x: 0, y: 0 }]);
        window.__game.setDir(1, 0);
        window.__game.setFood(19, 19);
      });
      await page.waitForTimeout(1500); // follow target eases onto the head
      // best-of-3 samples: software-GL frames lag the live snake by up to a
      // couple of cells, so a single read can catch the arrow mid-update
      let bestCos = -2,
        dist = null,
        want = null,
        head = null,
        food = null,
        arrowShown = false;
      for (let s = 0; s < 3; s++) {
        const sample = await page.evaluate(() => {
          const sc = window.__game.snake[0];
          const fc = window.__game.food;
          const r = document.getElementById('food-arrow').getBoundingClientRect();
          const hs = window.__game.screenFor(sc.x, sc.y);
          let dx = fc.x - sc.x,
            dy = fc.y - sc.y;
          if (document.getElementById('opt-wrap').checked) {
            dx -= 20 * Math.round(dx / 20);
            dy -= 20 * Math.round(dy / 20);
          }
          const fs = window.__game.screenFor(sc.x + dx, sc.y + dy);
          const ax = r.left + r.width / 2;
          const ay = r.top + r.height / 2;
          const dot = (ax - hs.x) * (fs.x - hs.x) + (ay - hs.y) * (fs.y - hs.y);
          const la = Math.hypot(ax - hs.x, ay - hs.y);
          const lf = Math.hypot(fs.x - hs.x, fs.y - hs.y);
          return {
            head: window.__game.project(sc.x, sc.y),
            food: window.__game.project(fc.x, fc.y),
            arrowShown: !document.getElementById('food-arrow').hidden,
            cos: lf > 1 ? dot / (la * lf) : 1,
            dist: document.getElementById('food-dist').textContent,
            want: String(Math.abs(dx) + Math.abs(dy)),
          };
        });
        if (sample.cos > bestCos) {
          bestCos = sample.cos;
          dist = sample.dist;
          want = sample.want;
          head = sample.head;
          food = sample.food;
          arrowShown = sample.arrowShown;
        }
        await page.waitForTimeout(150);
      }
      const frame = { head, food, arrowShown, cos: bestCos, dist, want };
      const headOk = inside(frame.head);
      const foodOk = inside(frame.food);
      check(d.name + ': head framed', headOk, JSON.stringify(frame.head));
      if (foodOk) {
        check(d.name + ': food framed, arrow hidden', !frame.arrowShown);
      } else {
        check(
          d.name + ': arrow flags off-screen food',
          frame.arrowShown && frame.cos > 0.8 && frame.dist === frame.want,
          JSON.stringify({ cos: frame.cos, dist: frame.dist, want: frame.want, food: frame.food })
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

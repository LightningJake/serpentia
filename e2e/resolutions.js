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
      const frame = await page.evaluate(() => {
        const s = window.__game.snake[0];
        const f = window.__game.food;
        const h = window.__game.project(s.x, s.y);
        const fp = window.__game.project(f.x, f.y);
        const r = document.getElementById('food-arrow').getBoundingClientRect();
        const hs = window.__game.screenFor(s.x, s.y);
        // expected bearing uses the same wrap-shortest delta as the game
        let dx = f.x - s.x,
          dy = f.y - s.y;
        if (document.getElementById('opt-wrap').checked) {
          dx -= 20 * Math.round(dx / 20);
          dy -= 20 * Math.round(dy / 20);
        }
        const fs = window.__game.screenFor(s.x + dx, s.y + dy);
        const ax = r.left + r.width / 2;
        const ay = r.top + r.height / 2;
        const dot = (ax - hs.x) * (fs.x - hs.x) + (ay - hs.y) * (fs.y - hs.y);
        const la = Math.hypot(ax - hs.x, ay - hs.y);
        const lf = Math.hypot(fs.x - hs.x, fs.y - hs.y);
        return {
          head: h,
          food: fp,
          arrowShown: !document.getElementById('food-arrow').hidden,
          cos: lf > 1 ? dot / (la * lf) : 1,
          dist: document.getElementById('food-dist').textContent,
          want: String(Math.abs(dx) + Math.abs(dy)),
        };
      });
      const headOk = inside(frame.head);
      const foodOk = inside(frame.food);
      check(d.name + ': head framed', headOk, JSON.stringify(frame.head));
      if (foodOk) {
        check(d.name + ': food framed, arrow hidden', !frame.arrowShown);
      } else {
        check(
          d.name + ': arrow flags off-screen food',
          frame.arrowShown && frame.cos > 0.85 && frame.dist === frame.want,
          JSON.stringify({ cos: frame.cos, dist: frame.dist, want: frame.want, food: frame.food })
        );
      }
      await page.waitForTimeout(600);
      const fps = await page.evaluate(() => window.__game.perf().fps);
      console.log('info  ' + d.name + ': fps=' + fps);
      await page.screenshot({ path: path.join(SHOTS, d.name + '-game.png') });
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

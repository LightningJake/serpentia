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
      // worst case framing: snake and food in opposite corners, frozen so the
      // assertion is deterministic (camera keeps easing while paused)
      await page.evaluate(() => {
        document.getElementById('opt-wrap').checked = true;
        window.__game.start();
        window.__game.pause();
        window.__game.setSnake([{ x: 0, y: 0 }]);
        window.__game.setFood(19, 19);
      });
      await page.waitForTimeout(3200); // camera framing eases in (~2s+)
      const head = await page.evaluate(() => window.__game.project(0, 0));
      const food = await page.evaluate(() => window.__game.project(19, 19));
      check(
        d.name + ': opposite corners framed',
        inside(head) && inside(food),
        JSON.stringify({ head, food })
      );
      await page.evaluate(() => window.__game.pause()); // resume briefly: game must run here
      await page.waitForTimeout(600);
      check(d.name + ': runs after framing', (await g(page, 'state')) === 'playing');
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

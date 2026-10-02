/* Perf probe: measures real FPS + renderer budgets in headless Edge.
 * Run: `npm run test:perf`. Prints numbers; asserts regression budgets. */
const { chromium } = require('playwright-core');
const { serve } = require('./server');

const PORT = 8904;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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
  let fail = 0;
  try {
    // Desktop plus a real phone, because phones are where the renderer budget
    // actually bites: higher DPR, a taller frame, and the touch legibility floor
    // zooming the camera in. Desktop-only perf was blind to all of that.
    const TARGETS = [
      { name: 'desktop-720p', w: 1280, h: 720, dpr: 1, touch: false },
      { name: 'galaxy-s24', w: 360, h: 780, dpr: 3, touch: true },
    ];
    for (const t of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: t.w, height: t.h },
        deviceScaleFactor: t.dpr,
        hasTouch: t.touch,
        isMobile: t.touch,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
      // launch flakes (dead SwiftShader/CDN fetch) land in 2D: one clean reload
      // distinguishes that from a real regression before any measurement
      if ((await page.evaluate(() => window.__game.mode)) !== '3d') {
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
      }
      // wrap mode: snake survives the whole probe window unattended
      await page.evaluate(() => {
        document.getElementById('opt-wrap').checked = true;
        window.__game.start();
      });
      await page.waitForTimeout(6000);
      // PHASE 1 - the default 3-segment snake against the original budgets.
      // Those were calibrated for the static scene, so they are left exactly as
      // they were rather than loosened to accommodate a longer snake.
      const p = await page.evaluate(() => window.__game.perf());
      console.log('perf[' + t.name + ']:', JSON.stringify(p));
      const budget = (name, ok, extra) => {
        console.log(
          (ok ? 'PASS' : 'FAIL') + '  perf[' + t.name + ']: ' + name + (extra ? '  [' + extra + ']' : '')
        );
        if (!ok) fail++;
      };
      budget('mode is 3d (WebGL probe valid)', (await page.evaluate(() => window.__game.mode)) === '3d');
      budget('draw calls < 60', p.calls < 60, 'calls=' + p.calls);
      budget('triangles < 30000', p.tris < 30000, 'tris=' + p.tris);
      budget('fps above catastrophic floor (>5)', p.fps > 5, 'fps=' + p.fps);

      // PHASE 2 - the stress case. The body is two InstancedMeshes, so the point
      // is that draw calls stay FLAT as the snake grows. Before instancing a
      // 180-segment snake cost ~180 calls, doubled again by the shadow pass; if
      // anyone reintroduces a mesh per segment, this is what catches it.
      const stress = await page.evaluate(async () => {
        const gme = window.__game;
        const body = [];
        for (let i = 0; i < 180; i++) body.push({ x: i % 20, y: Math.floor(i / 20) });
        gme.setSnake(body.reverse());
        gme.setDir(1, 0);
        gme.setFood(19, 19);
        await new Promise((r) => setTimeout(r, 2500));
        return gme.perf();
      });
      console.log('perf[' + t.name + '] 180-seg:', JSON.stringify(stress));
      budget(
        '180 segments: draw calls stay < 40 (body is instanced)',
        stress.calls < 40,
        'calls=' + stress.calls
      );
      budget('180 segments: triangles < 120000', stress.tris < 120000, 'tris=' + stress.tris);
      budget('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(fail ? 'PERF FAILURES' : 'PERF OK');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

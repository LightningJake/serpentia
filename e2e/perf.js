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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
    const p = await page.evaluate(() => window.__game.perf());
    console.log('perf:', JSON.stringify(p));
    const budget = (name, ok, extra) => {
      console.log((ok ? 'PASS' : 'FAIL') + '  perf: ' + name + (extra ? '  [' + extra + ']' : ''));
      if (!ok) fail++;
    };
    budget('mode is 3d (WebGL probe valid)', (await page.evaluate(() => window.__game.mode)) === '3d');
    budget('draw calls < 60', p.calls < 60, 'calls=' + p.calls);
    budget('triangles < 30000', p.tris < 30000, 'tris=' + p.tris);
    budget('fps above catastrophic floor (>5)', p.fps > 5, 'fps=' + p.fps);
    budget('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
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

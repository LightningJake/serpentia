/* Adversarial edge-case suite: pause spam, mid-cinematic restarts, storage
 * denial, blur, resize, clock-freeze, combo modes, win path. `npm run test:edge`. */
const { chromium } = require('playwright-core');
const { serve } = require('./server');

const PORT = 8905;
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
  const server = serve(PORT);
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });

    // 1. pause spam: 12 rapid toggles land in a valid state (wrap on: no wall roulette)
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = true;
    });
    for (let i = 0; i < 12; i++) await page.locator('#btn-pause').click();
    await page.waitForTimeout(200);
    const spamState = await g(page, 'state');
    check('edge: pause spam stays valid', spamState === 'playing' || spamState === 'paused', spamState);

    // 2. restart DURING the death cinematic: stale Game Over must never appear
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = false;
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForFunction(() => window.__game.state === 'over', null, { timeout: 5000 });
    await page.locator('#btn-restart').click(); // ~instant restart, overlay still pending
    await page.evaluate(() => window.__game.pause()); // freeze: no second wall death can sneak in
    await page.waitForTimeout(1600); // past the 1000ms overlay delay
    check(
      'edge: no stale overlay after mid-cinematic restart',
      (await g(page, 'state')) === 'paused' &&
        /Paus/.test(await page.locator('#ov-title').textContent()) &&
        (await page.locator('#pause-menu').isVisible())
    );
    await page.evaluate(() => {
      window.__game.pause(); // resume
      document.getElementById('opt-wrap').checked = false;
    });

    // 3. Enter while paused starts a fresh visible run (not a stranded pause)
    await page.evaluate(() => window.__game.start());
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    check(
      'edge: Enter unpauses into fresh run',
      (await g(page, 'state')) === 'playing' &&
        (await g(page, 'score')) === 0 &&
        (await page.locator('#overlay').isHidden())
    );

    // 4. music survives pause/resume, stops on quit
    await page.evaluate(() => window.__game.start());
    await page.waitForTimeout(250);
    const m0 = await page.evaluate(() => window.__game.musicPlaying());
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(150);
    await page.locator('#btn-resume').click();
    await page.waitForTimeout(150);
    const m1 = await page.evaluate(() => window.__game.musicPlaying());
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(150);
    // Fail fast with the live state if the pause menu did not open (under a
    // loaded machine a click can land mid-transition); a blind 30s click
    // timeout here used to abort the whole file with zero diagnostics.
    let quitOk = true;
    try {
      await page.locator('#btn-quit').click({ timeout: 5000 });
    } catch (e) {
      quitOk = false;
    }
    const quitState = (await g(page, 'state')) + '/menu=' + (await page.locator('#pause-menu').isVisible());
    check('edge: quit clickable from pause menu', quitOk, quitState);
    await page.waitForTimeout(150);
    const m2 = await page.evaluate(() => window.__game.musicPlaying());
    check(
      'edge: music pause/resume/quit',
      m0 === true && m1 === true && m2 === false,
      [m0, m1, m2].join('/')
    );

    // 5. wrap flipped mid-run takes effect live
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      document.getElementById('opt-wrap').checked = false;
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
      document.getElementById('opt-wrap').checked = true; // flip before the step
      window.__game.step();
    });
    check(
      'edge: mid-run wrap flip saves the snake',
      (await g(page, 'state')) === 'paused' && (await page.evaluate(() => window.__game.snake[0].x)) === 0
    );
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
    });

    // 6. fifteen rapid starts stay clean
    await page.evaluate(() => {
      for (let i = 0; i < 15; i++) window.__game.start();
    });
    await page.waitForTimeout(250);
    check(
      'edge: 15 rapid starts clean',
      (await g(page, 'state')) === 'playing' &&
        (await g(page, 'score')) === 0 &&
        (await page.locator('#overlay').isHidden())
    );

    // 7. window blur auto-pauses (switching apps)
    await page.evaluate(() => {
      window.__game.start();
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(150);
    check('edge: blur auto-pauses', (await g(page, 'state')) === 'paused');

    // 8. resize storm keeps the loop alive
    await page.evaluate(() => window.__game.start());
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    check('edge: resize storm survives', (await g(page, 'state')) === 'playing');

    // 9. kid mode effect: slow tick + walls become tunnels
    await page.evaluate(() => window.__game.pause());
    await page.locator('#btn-quit').click();
    await page.waitForTimeout(250);
    await page.locator('#opt-kid').click();
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
      window.__game.pause();
    });
    await page.waitForTimeout(400);
    check(
      'edge: kid mode wraps + slow tick',
      (await g(page, 'state')) === 'playing' && (await g(page, 'tickMs')) === 160,
      (await g(page, 'state')) + '/' + (await g(page, 'tickMs'))
    );
    await page.evaluate(() => {
      const k = document.getElementById('opt-kid');
      k.checked = false;
      k.dispatchEvent(new Event('change', { bubbles: true }));
      const w = document.getElementById('opt-wrap');
      w.checked = false;
      w.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 10. bonus clock freezes while paused
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setBonus(5, 5, 600);
    });
    await page.waitForTimeout(900);
    const frozenBonus = await page.evaluate(() => window.__game.bonus);
    await page.locator('#btn-resume').click();
    await page.waitForFunction(() => window.__game.bonus === null, null, { timeout: 4000 });
    check('edge: bonus ttl frozen in pause', frozenBonus !== null);

    // 11. wrap + obstacles combo: walls wrap, rocks still kill
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-obstacles').checked = true;
      window.__game.reset();
      window.__game.pause();
      const o = window.__game.obstacles.find((c) => c.x > 0) || window.__game.obstacles[0];
      window.__game.setSnake([{ x: o.x - 1, y: o.y }]);
      window.__game.setDir(1, 0);
      window.__game.step();
      document.getElementById('opt-wrap').checked = false;
      document.getElementById('opt-obstacles').checked = false;
    });
    check('edge: wrap+obstacles combo kills on rock', (await g(page, 'state')) === 'over');

    // 12. win path smoke test
    await page.evaluate(() => window.__game.win());
    await page.waitForTimeout(200);
    check(
      'edge: win overlay shows',
      (await g(page, 'state')) === 'win' && /Win/i.test(await page.locator('#ov-title').textContent())
    );

    // 13. achievements + life survive reload (earn a bite first)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      const s = window.__game.snake;
      window.__game.setFood(s[0].x + 1, s[0].y);
      window.__game.step();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    const ach = await page.evaluate(() => window.__game.ach);
    const life = await page.evaluate(() => window.__game.life);
    check('edge: ach/life persist reload', ach.includes('bite') && life.foods > 0, ach.join(','));

    check('edge: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();

    // 14. localStorage denied entirely: memory fallback keeps game playable
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('denied');
        },
        configurable: true,
      });
    });
    const p2 = await ctx2.newPage();
    const err2 = [];
    p2.on('pageerror', (e) => err2.push(String((e && e.message) || e)));
    await p2.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
    await p2.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    await p2.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      const s = window.__game.snake;
      window.__game.setFood(s[0].x + 1, s[0].y);
      window.__game.step();
    });
    const s2 = await p2.evaluate(() => window.__game.score);
    check('edge: storage-denied still scores', s2 === 10, 'score=' + s2);
    check('edge: storage-denied no errors', err2.length === 0, err2.slice(0, 2).join(' | '));
    await ctx2.close();
  } finally {
    await browser.close();
    server.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== edge: ' + (results.length - fails.length) + '/' + results.length + ' passed ====');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

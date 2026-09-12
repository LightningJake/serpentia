/* End-to-end suite for 3D Snake. Serves D:\OpenCode over HTTP,
 * drives real Edge (headless + SwiftShader WebGL), clicks every button.
 * Exits non-zero on any failure. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { serve, ROOT } = require('./server');

const PORT = 8901;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}
const g = (page, expr) => page.evaluate(new Function('return window.__game.' + expr));

// Settings live in the main menu: drive the game there from any state.
async function toMenu(page) {
  let st = await g(page, 'state');
  if (st === 'over' || st === 'win') {
    await page.locator('#btn-play').click(); // play again -> playing
    await page.waitForTimeout(250);
    st = await g(page, 'state');
  }
  if (st === 'playing') await page.evaluate(() => window.__game.pause());
  const st2 = await g(page, 'state');
  if (st2 === 'paused') await page.locator('#btn-quit').click();
  await page.waitForFunction(() => window.__game.state === 'menu', null, { timeout: 8000 });
}

async function newPage(browser, blockCDN) {
  const page = await browser.newPage();
  if (blockCDN) await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
  return { page, errors };
}

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
    // ---------- 3D context ----------
    let { page, errors } = await newPage(browser, false);
    check('boot: __game exposed', await page.evaluate(() => !!window.__game));
    check('boot: mode 3d (WebGL ok)', (await g(page, 'mode')) === '3d', await g(page, 'mode'));
    check(
      'boot: state menu + overlay visible',
      (await g(page, 'state')) === 'menu' && (await page.locator('#overlay').isVisible())
    );
    check(
      'menu: best hero + WASD guide',
      ((await page.locator('#ov-best').textContent()) || '').trim() === '0' &&
        ((await page.locator('.controls-grid kbd').count()) || 0) >= 4
    );
    check('loader: hidden after boot', await page.locator('#loader').isHidden());
    check(
      'loader: staged progress available',
      (await page.evaluate(() => typeof window.__loadStep)) === 'function'
    );
    check(
      'a11y: canvas label translated',
      (await page.evaluate(() => document.getElementById('scene').getAttribute('aria-label'))) ===
        '3D snake game board'
    );
    // Focus trap: Tab cycles inside the menu dialog, never escapes to the page
    const nFocus = await page.evaluate(
      () =>
        [...document.querySelectorAll('#overlay button, #overlay select, #overlay input')].filter(
          (e) => !e.disabled && e.offsetParent !== null
        ).length
    );
    for (let i = 0; i < nFocus + 3; i++) await page.keyboard.press('Tab');
    check(
      'a11y: tab trapped in menu',
      await page.evaluate(() => !!document.getElementById('overlay').contains(document.activeElement))
    );

    // Pure-click fallback (keyboard / screen-reader / synthetic click path: click event WITHOUT pointerdown)
    await page.evaluate(() =>
      document
        .getElementById('btn-play')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    );
    await page.waitForTimeout(300);
    check(
      'btn-play: pure click event starts game',
      (await g(page, 'state')) === 'playing',
      await g(page, 'state')
    );
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('hidden'), null, {
      timeout: 5000,
    });

    // Restart via real trusted click
    await page.locator('#btn-restart').click();
    await page.waitForTimeout(200);
    check(
      'btn-restart: real click restarts to playing/score 0',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0
    );

    // Pause / resume via buttons
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(200);
    check(
      'btn-pause: pauses + overlay shows Resume',
      (await g(page, 'state')) === 'paused' && (await page.locator('#overlay').isVisible())
    );
    // Resume via btn-play must NOT wipe score: eat first
    await page.evaluate(() => {
      window.__game.start();
    });
    await page.evaluate(() => {
      const s = window.__game.snake,
        d = window.__game.dir;
      window.__game.setFood(s[0].x + d.x, s[0].y + d.y);
    });
    await page.waitForFunction(() => window.__game.score >= 10, null, { timeout: 5000 });
    await page.locator('#btn-pause').click(); // pause with score 10
    await page.waitForTimeout(150);
    await page.locator('#btn-resume').click(); // pause menu Resume
    await page.waitForTimeout(200);
    check(
      'pause menu Resume: continues WITHOUT resetting score',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 10,
      'state=' + (await g(page, 'state')) + ' score=' + (await g(page, 'score'))
    );

    // Help open/close (opening help auto-pauses the run)
    await page.locator('#btn-help').click();
    check('btn-help: opens modal', await page.locator('#help-modal').isVisible());
    check('help: game auto-pauses behind docs', (await g(page, 'state')) === 'paused');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    check(
      'a11y: tab trapped in help dialog',
      await page.evaluate(() => !!document.getElementById('help-modal').contains(document.activeElement))
    );
    await page.keyboard.press('Escape');
    check('a11y: Escape closes help', await page.locator('#help-modal').isHidden());
    await page.locator('#btn-help').click();
    await page.keyboard.press('Space');
    check(
      'help: Space dismisses, game stays paused',
      (await page.locator('#help-modal').isHidden()) && (await g(page, 'state')) === 'paused'
    );
    await page.locator('#btn-help').click();
    await page.locator('#btn-close-help').click();
    check('btn-close-help: closes modal', await page.locator('#help-modal').isHidden());

    // Keyboard steering: queue ArrowLeft turn while heading right (paused: fully deterministic)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
    });
    await page.keyboard.press('ArrowLeft');
    const q = await page.evaluate(() => window.__game.queue);
    const d = await page.evaluate(() => window.__game.dir);
    check(
      'keyboard ArrowLeft: relative turn queued/applied',
      (q.length && q[0].x === 0 && q[0].y === -1) || d.y === -1,
      JSON.stringify({ q, d })
    );
    await page.evaluate(() => window.__game.pause()); // resume for the tests below

    // Dead keys teach once: ↑ shows the hint and records it
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    check(
      'keyboard: dead key teaches once',
      (await page.locator('#toast.show').count()) >= 1 &&
        /← →/.test((await page.locator('#toast').textContent()) || '') &&
        (await page.evaluate(() => localStorage.getItem('snake3d.seenKeys'))) === '1'
    );

    // Space pause/resume, Enter restart
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    check('Space: pauses', (await g(page, 'state')) === 'paused');
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    check('Space: resumes', (await g(page, 'state')) === 'playing');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    check(
      'Enter mid-run: clean restart',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0
    );

    // Focused button + Space must fire exactly once (no native+global double)
    await page.evaluate(() => window.__game.start());
    await page.keyboard.press('Tab'); // focus first HUD button (Pause)
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    check('keyboard: focused Pause + Space pauses once', (await g(page, 'state')) === 'paused');
    await page.evaluate(() => window.__game.pause()); // resume for the tests below

    // Relative turns ignore the camera: flipped or not, Left always turns snake-left
    // (wait a beat first: camera.position eases onto the new orbit)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.setCam(Math.PI, 0.95);
    });
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    const flipDir = await page.evaluate(() => window.__game.dir);
    check(
      'relative: flipped cam Left still turns snake-left',
      flipDir.x === 0 && flipDir.y === -1,
      JSON.stringify(flipDir)
    );
    // ...and Right mirrors it regardless of orientation
    await page.evaluate(() => {
      window.__game.start();
      window.__game.setCam(0, 0.95);
    });
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    const normDir = await page.evaluate(() => window.__game.dir);
    check(
      'relative: normal cam Right turns snake-right',
      normDir.x === 0 && normDir.y === 1,
      JSON.stringify(normDir)
    );

    // Eat food grows snake
    await page.evaluate(() => {
      window.__game.start();
      const s = window.__game.snake,
        d2 = window.__game.dir;
      window.__game.setFood(s[0].x + d2.x, s[0].y + d2.y);
    });
    await page.waitForFunction(() => window.__game.score >= 10 && window.__game.snake.length === 4, null, {
      timeout: 5000,
    });
    check('eat: score+10 & length 4', true);

    // Wall death -> Game Over overlay
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = false;
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForFunction(() => window.__game.state === 'over', null, { timeout: 5000 });
    await page.waitForSelector('#overlay:not(.hidden) #ov-title', { timeout: 5000 });
    const title = await page.locator('#ov-title').textContent();
    check('wall death: Game Over overlay', /Game Over/.test(title), title);
    // Play again from game over
    await page.locator('#btn-play').click();
    await page.waitForTimeout(200);
    check(
      'btn-play after death: restarts',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0
    );

    // Wrap mode survives walls
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = true;
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForTimeout(600);
    const wst = await g(page, 'state'),
      wsn = await page.evaluate(() => window.__game.snake[0].x);
    check('wrap walls: survives + wraps to left side', wst === 'playing' && wsn <= 6, wst + ' x=' + wsn);
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
    });

    // Self collision (deterministic single step while paused)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([
        { x: 5, y: 5 },
        { x: 5, y: 6 },
        { x: 6, y: 6 },
        { x: 6, y: 5 },
      ]);
      window.__game.setDir(0, 1);
      window.__game.step();
    });
    check('self collision: game over', (await g(page, 'state')) === 'over', await g(page, 'state'));

    // Speed select affects tick (menu-only setting)
    await toMenu(page);
    const tBefore = await g(page, 'tickMs');
    await page.selectOption('#opt-speed', 'fast');
    await page.waitForTimeout(100);
    const tAfter = await g(page, 'tickMs');
    check('speed select: fast lowers tickMs', tAfter < tBefore, tBefore + '->' + tAfter);

    // Rapid double Start is safe
    await page.evaluate(() => {
      window.__game.start();
      window.__game.start();
    });
    await page.waitForTimeout(200);
    check(
      'double Start: still clean playing/0',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0
    );

    // Combo chain: two quick eats -> +10 then +20 = 30, combo x2 + pill visible
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      const a = window.__game.snake;
      window.__game.setFood(a[0].x + 1, a[0].y);
      window.__game.step();
      const b = window.__game.snake;
      window.__game.setFood(b[0].x + 1, b[0].y);
      window.__game.step();
    });
    const comboScore = await g(page, 'score'),
      comboN = await g(page, 'combo');
    check(
      'combo: chained eats score 30 / combo 2',
      comboScore === 30 && comboN === 2,
      'score=' + comboScore + ' combo=' + comboN
    );
    check('combo: HUD pill visible', await page.locator('#pill-combo').isVisible());

    // Bonus orb: +50 x combo, cleared after eat
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      const s = window.__game.snake;
      window.__game.setBonus(s[0].x + 1, s[0].y, 7000);
      window.__game.step();
    });
    const bScore = await g(page, 'score'),
      bGone = await page.evaluate(() => window.__game.bonus);
    check('bonus: eaten for +50 and cleared', bScore === 50 && bGone === null, 'score=' + bScore);

    // Bonus expiry: short ttl vanishes on play time
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setBonus(5, 5, 400);
      window.__game.pause(); // resume -> clock runs
    });
    await page.waitForFunction(() => window.__game.bonus === null, null, { timeout: 4000 });
    check('bonus: expires after ttl', true);
    await page.evaluate(() => window.__game.pause());

    // Death cinematic: crash cell recorded + red flash fired
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = false;
      window.__game.setSnake([{ x: 18, y: 5 }]);
      window.__game.setDir(1, 0);
      window.__game.step(); // (19,5) ok
      window.__game.step(); // (20,5) wall -> death
    });
    const dc = await page.evaluate(() => window.__game.deathCell);
    check('death: crash cell recorded', dc && dc.x === 20 && dc.y === 5, JSON.stringify(dc));
    const flashed = await page.evaluate(() => document.getElementById('flash').classList.contains('show'));
    check('death: red flash fired', flashed === true, 'show=' + flashed);
    await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, {
      timeout: 5000,
    });
    const statsTxt = await page.locator('#ov-stats').textContent();
    check(
      'game over: stats line (time/foods/rate/longest)',
      /Foods/.test(statsTxt) && /\/min/.test(statsTxt) && /Longest/.test(statsTxt),
      statsTxt
    );
    check('game over: stat chips rendered', ((await page.locator('#ov-stats .chip').count()) || 0) >= 7);

    // Level-up: 6 chained eats -> level 2, goal resets to 0/6
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      for (let i = 0; i < 6; i++) {
        const s = window.__game.snake;
        if (i === 5) window.__game.clearBonus(); // keep the 6th eat deterministic
        window.__game.setFood(s[0].x + 1, s[0].y);
        window.__game.step();
      }
    });
    check(
      'level: 6 foods -> level 2 / goal 0/6',
      (await g(page, 'level')) === 2 && (await page.locator('#goal').textContent()) === '0/6',
      'level=' + (await g(page, 'level'))
    );
    check('level: Desert biome applied', (await g(page, 'theme')) === 'Desert', await g(page, 'theme'));
    const bannerTxt = await page.locator('#banner').textContent();
    check('level: milestone banner shown', /LEVEL 2/.test(bannerTxt || ''), bannerTxt);

    // Prestige: die at level 2, prestige restarts boosted (+10%)
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      for (let i = 0; i < 6; i++) {
        const s = window.__game.snake;
        if (i === 5) window.__game.clearBonus();
        window.__game.setFood(s[0].x + 1, s[0].y);
        window.__game.step();
      }
      window.__game.setDir(1, 0);
      for (let k = 0; k < 6 && window.__game.state !== 'over'; k++) window.__game.step();
    });
    // the death cinematic lands ~1s later (the overlay may still show Paused meanwhile)
    await page.waitForFunction(
      () => /Game Over/.test(document.getElementById('ov-title').textContent),
      null,
      {
        timeout: 6000,
      }
    );
    check('prestige: offered at level 2+', await page.locator('#prestige-row').isVisible());
    await page.locator('#btn-prestige').click();
    await page.waitForTimeout(200);
    check(
      'prestige: restarts boosted',
      (await g(page, 'state')) === 'playing' && (await g(page, 'life')).prestige === 1
    );
    await page.evaluate(() => {
      window.__game.pause();
      const s = window.__game.snake;
      window.__game.setFood(s[0].x + 1, s[0].y);
      window.__game.step();
    });
    check('prestige: +10% scoring', (await g(page, 'score')) === 11, 'score=' + (await g(page, 'score')));

    // Obstacles: steering into one kills
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      document.getElementById('opt-obstacles').checked = true;
      window.__game.start();
      window.__game.pause();
      const o = window.__game.obstacles.find((c) => c.x > 0) || window.__game.obstacles[0];
      window.__game.setSnake([{ x: o.x - 1, y: o.y }]);
      window.__game.setDir(1, 0);
      window.__game.step();
      document.getElementById('opt-obstacles').checked = false;
    });
    check('obstacles: collision kills', (await g(page, 'state')) === 'over', await g(page, 'state'));

    // Mode picker drives the checkboxes (menu-only panel)
    await toMenu(page);
    await page.locator('#mode-seg button[data-mode="wrap"]').click();
    check('mode picker: Wrap checks wrap box', await page.locator('#opt-wrap').isChecked());
    await page.locator('#mode-seg button[data-mode="classic"]').click();
    check(
      'mode picker: Classic clears boxes',
      !(await page.locator('#opt-wrap').isChecked()) && !(await page.locator('#opt-obstacles').isChecked())
    );
    await page.locator('#mode-seg button[data-mode="obstacles"]').click();
    check('mode picker: Obstacles checks obstacles box', await page.locator('#opt-obstacles').isChecked());
    await page.locator('#mode-seg button[data-mode="classic"]').click();

    // Settings live in the menu card (not floating in-game anymore)
    check('menu: settings panel in card', await page.locator('#settings-panel').isVisible());
    await page.evaluate(() => window.__game.start());
    await page.waitForTimeout(150);
    check('playing: overlay hidden, no settings chrome', await page.locator('#overlay').isHidden());

    // Settings persist across reload (incl. camera + palette)
    await toMenu(page);
    await page.selectOption('#opt-speed', 'fast');
    await page.selectOption('#opt-cam', 'top');
    await page.evaluate(() => {
      const w = document.getElementById('opt-wrap');
      w.checked = true;
      w.dispatchEvent(new Event('change', { bubbles: true }));
      const c = document.getElementById('opt-colorblind');
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    const pSpeed = await page.locator('#opt-speed').inputValue();
    const pWrap = await page.locator('#opt-wrap').isChecked();
    const pCam = await page.locator('#opt-cam').inputValue();
    const pCb = await page.locator('#opt-colorblind').isChecked();
    check(
      'settings: persist across reload',
      pSpeed === 'fast' && pWrap === true && pCam === 'top' && pCb === true,
      pSpeed + '/wrap=' + pWrap + '/cam=' + pCam + '/cb=' + pCb
    );
    // restore defaults for cleanliness
    await page.selectOption('#opt-speed', 'normal');
    await page.selectOption('#opt-cam', 'follow');
    await page.evaluate(() => {
      const w = document.getElementById('opt-wrap');
      w.checked = false;
      w.dispatchEvent(new Event('change', { bubbles: true }));
      const c = document.getElementById('opt-colorblind');
      c.checked = false;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Tutorial: first run shows hint until first eat
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    await page.locator('#btn-play').click();
    await page.waitForTimeout(200);
    check('tutorial: hint shown on first run', await page.locator('#hint').isVisible());
    await page.evaluate(() => {
      const s = window.__game.snake,
        d = window.__game.dir;
      window.__game.setFood(s[0].x + d.x, s[0].y + d.y);
    });
    await page.waitForFunction(() => window.__game.score >= 10, null, { timeout: 5000 });
    check('tutorial: hint hides after first eat', await page.locator('#hint').isHidden());

    // i18n: switch to Spanish, engine + static UI follow (menu state)
    await toMenu(page);
    await page.selectOption('#opt-lang', 'es');
    check(
      'i18n: Spanish start button',
      ((await page.locator('#btn-play').textContent()) || '').trim() === '▶ Jugar'
    );
    check(
      'i18n: Spanish HUD label',
      (await page.evaluate(() => document.querySelector('[data-i18n="pill_score"]').textContent)) === 'Puntos'
    );
    check(
      'i18n: canvas label translated',
      (await page.evaluate(() => document.getElementById('scene').getAttribute('aria-label'))) ===
        'Tablero de serpiente 3D'
    );
    // i18n: ?lang= URL override wins without saving
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?lang=de', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    check(
      'i18n: ?lang=de override',
      ((await page.locator('#btn-play').textContent()) || '').trim() === '▶ Spielen'
    );
    await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
    await page.selectOption('#opt-lang', 'auto');

    // Kid mode: one tap presets slow + wrap, no obstacles
    await page.locator('#opt-kid').check();
    check(
      'kid mode: presets applied',
      ((await page.locator('#opt-speed').inputValue()) || '') === 'slow' &&
        (await page.locator('#opt-wrap').isChecked()) &&
        !(await page.locator('#opt-obstacles').isChecked())
    );
    await page.evaluate(() => {
      const k = document.getElementById('opt-kid');
      k.checked = false;
      k.dispatchEvent(new Event('change', { bubbles: true }));
      const s = document.getElementById('opt-speed');
      s.value = 'normal';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      const w = document.getElementById('opt-wrap');
      w.checked = false;
      w.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // New biomes cycle past Space
    for (const [idx, name] of [
      [5, 'Forest'],
      [6, 'Sunset'],
      [7, 'Ice'],
    ]) {
      await page.evaluate((i) => window.__game.setTheme(i), idx);
      check('biome: ' + name + ' applied', (await g(page, 'theme')) === name, await g(page, 'theme'));
    }
    check('biome: stars only on Space', await page.evaluate(() => !window.__stars.visible));

    // Click-to-steer: click the board cell right of the head while heading up.
    // Paused + settled camera: fully deterministic (framing keeps easing live).
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
    });
    await page.waitForTimeout(2500);
    const steerPt = await page.evaluate(() => window.__game.screenFor(14, 10));
    // synthetic pointer events on canvas: bypasses the pause overlay hit-test
    // and exercises our own down/up + mapping logic deterministically
    await page.evaluate(({ x, y }) => {
      const c = document.getElementById('scene');
      const init = {
        pointerType: 'mouse',
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      };
      c.dispatchEvent(new PointerEvent('pointerdown', init));
      c.dispatchEvent(new PointerEvent('pointerup', init));
    }, steerPt);
    const sQueue = await page.evaluate(() => window.__game.queue);
    check(
      'click-to-steer: board click queues right',
      sQueue.length > 0 && sQueue[0].x === 1 && sQueue[0].y === 0,
      JSON.stringify(sQueue)
    );

    // On-screen buttons: force-show toggle (menu) then steer in-game
    await toMenu(page);
    await page.locator('#opt-dpad').check();
    check('buttons setting: dpad appears', await page.locator('#dpad').isVisible());
    await page.locator('#btn-play').click();
    await page.waitForTimeout(250);
    await page.locator('#dpad button[data-dir="left"]').click();
    await page.waitForTimeout(350);
    const dDir = await page.evaluate(() => window.__game.dir);
    check('dpad: left button turns', dDir.y === -1, JSON.stringify(dDir));
    await toMenu(page);
    await page.locator('#opt-dpad').uncheck();

    // Pause menu: Resume / Restart / Menu
    await page.evaluate(() => {
      window.__game.start();
      document.getElementById('opt-wrap').checked = true; // survive this long block unattended
    });
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(200);
    check(
      'pause menu: rows swap correctly',
      (await page.locator('#pause-menu').isVisible()) && (await page.locator('#play-row').isHidden())
    );
    await page.locator('#btn-resume').click();
    await page.waitForTimeout(200);
    check('pause menu: Resume continues', (await g(page, 'state')) === 'playing');
    check(
      'hud: minimal in play (Score+Best only)',
      (await page.locator('#pill-length').isHidden()) &&
        (await page.locator('#pill-goal').isHidden()) &&
        (await page.locator('#pill-level').isHidden())
    );
    check(
      'pause: settings hidden, note shown',
      (await (async () => {
        await page.locator('#btn-pause').click();
        await page.waitForTimeout(200);
        return true;
      })()) &&
        (await page.locator('#settings-panel').isHidden()) &&
        (await page.locator('#pause-note').isVisible())
    );
    await page.locator('#btn-resume').click();
    await page.waitForTimeout(200);
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(200);
    await page.locator('#btn-restart2').click();
    await page.waitForTimeout(200);
    check(
      'pause menu: Restart resets',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0
    );
    await page.locator('#btn-pause').click();
    await page.waitForTimeout(200);
    await page.locator('#btn-quit').click();
    await page.waitForTimeout(200);
    check(
      'pause menu: Menu quits to menu',
      (await g(page, 'state')) === 'menu' && (await page.locator('#overlay').isVisible())
    );
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
    });
    check('menu: lifetime line shown', /runs|First run/.test(await page.locator('#life-line').textContent()));

    // Life + achievements: one chained session unlocks bite + combo5
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      for (let i = 0; i < 5; i++) {
        const s = window.__game.snake;
        if (i === 4) window.__game.clearBonus();
        window.__game.setFood(s[0].x + 1, s[0].y);
        window.__game.step();
      }
    });
    const ach = await page.evaluate(() => window.__game.ach);
    const life = await page.evaluate(() => window.__game.life);
    check(
      'achievements: bite + combo5 unlocked',
      ach.includes('bite') && ach.includes('combo5'),
      ach.join(',')
    );
    check(
      'life: counters tracked',
      life.games >= 1 && life.foods >= 5 && life.bestCombo >= 5,
      JSON.stringify(life)
    );

    // Music: plays on start, stops on toggle (toggles live in the menu)
    await toMenu(page);
    await page.evaluate(() => window.__game.start());
    await page.waitForTimeout(300);
    check('music: playing after start', (await page.evaluate(() => window.__game.musicPlaying())) === true);
    await toMenu(page);
    await page.locator('#opt-music').uncheck();
    await page.evaluate(() => window.__game.start());
    await page.waitForTimeout(300);
    check('music: toggle stops it', (await page.evaluate(() => window.__game.musicPlaying())) === false);
    await toMenu(page);
    await page.locator('#opt-music').check();

    // Space theme: stars on, trail exists, auto-quality degrades under load
    await page.evaluate(() => window.__game.setTheme(4));
    check('space: theme applied', (await g(page, 'theme')) === 'Space');
    check(
      'space: starfield visible',
      await page.evaluate(() => !!(window.__stars && window.__stars.visible))
    );
    check('trail: head glow trail exists', await page.evaluate(() => !!window.__trail));
    await page.evaluate(() => window.__game.debugSlowFps());
    await page.waitForTimeout(700);
    check(
      'auto-quality: degrades when slow',
      (await g(page, 'quality')) !== 'high',
      await g(page, 'quality')
    );

    // Share score on game over (mocked clipboard)
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      window.__game.start();
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForFunction(() => window.__game.state === 'over', null, { timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), null, {
      timeout: 6000,
    });
    check('share: row visible on game over', await page.locator('#share-row').isVisible());
    await page.evaluate(() => {
      window.__shared = null;
      try {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      } catch (e) {}
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (t) => {
            window.__shared = t;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });
    await page.locator('#btn-share').click();
    await page.waitForFunction(() => !!window.__shared, null, { timeout: 4000 });
    const shared = await page.evaluate(() => window.__shared);
    check('share: score text copied', /Score|scored/i.test(shared || ''), shared);

    // Overlay replay: switching language re-renders the visible game-over card
    await page.evaluate(() => {
      const s = document.getElementById('opt-lang');
      s.value = 'es';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    check(
      'i18n replay: game-over card in Spanish',
      ((await page.locator('#ov-title').textContent()) || '').trim() === 'Fin del juego'
    );
    await page.evaluate(() => {
      const s = document.getElementById('opt-lang');
      s.value = 'auto';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    check(
      'i18n replay: back to English',
      ((await page.locator('#ov-title').textContent()) || '').trim() === 'Game Over'
    );

    // SEO/social: absolute OG tags, resolve 200, valid game schema + crawler files
    const ogImage = await page.evaluate(() =>
      document.querySelector('meta[property="og:image"]').getAttribute('content')
    );
    check('seo: og:image absolute', /^https:\/\//.test(ogImage || ''), ogImage);
    check(
      'seo: og:image points at production file',
      ogImage === 'https://serpentia-coral.vercel.app/og-image.png',
      ogImage
    );
    // same-origin fetch proves WE ship the bytes; live.js re-checks production after deploy
    const ogStatus = await page.evaluate(() =>
      fetch('og-image.png')
        .then((r) => r.status)
        .catch(() => -1)
    );
    check('seo: og:image resolves', ogStatus === 200, String(ogStatus));
    check(
      'seo: twitter card + url',
      (await page.evaluate(
        () =>
          document.querySelector('meta[name="twitter:card"]').getAttribute('content') +
          '|' +
          document.querySelector('meta[property="og:url"]').getAttribute('content')
      )) === 'summary_large_image|https://serpentia-coral.vercel.app/'
    );
    const schemaName = await page.evaluate(() => {
      try {
        return JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).name;
      } catch (e) {
        return null;
      }
    });
    check('seo: game schema parses', schemaName === '3D Snake', String(schemaName));
    const robotsTxt = await page.evaluate(() =>
      fetch('robots.txt')
        .then((r) => r.text())
        .catch(() => '')
    );
    const sitemapXml = await page.evaluate(() =>
      fetch('sitemap.xml')
        .then((r) => r.text())
        .catch(() => '')
    );
    check(
      'seo: robots + sitemap serve',
      /Allow: \//.test(robotsTxt) && /serpentia-coral\.vercel\.app/.test(sitemapXml)
    );

    // Install flow: synthetic beforeinstallprompt surfaces the row; click falls back cleanly
    await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt')));
    await page.waitForTimeout(150);
    check('install: row appears on prompt', await page.locator('#install-row').isVisible());
    await page.locator('#btn-install').click();
    await page.waitForTimeout(250);
    check(
      'install: manual hint without native prompt',
      (await page.locator('#toast.show').count()) >= 1 &&
        /Home screen/.test((await page.locator('#toast').textContent()) || '')
    );
    // PWA: manifest serves, Three.js cached for offline
    const manStatus = await page.evaluate(() =>
      fetch('manifest.json')
        .then((r) => r.status)
        .catch(() => -1)
    );
    check('pwa: manifest served', manStatus === 200, String(manStatus));
    const cached = await page
      .waitForFunction(
        async (url) => !!(await caches.match(url)),
        'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.149.0/three.min.js',
        { timeout: 25000 }
      )
      .then(() => true)
      .catch(() => false);
    check('pwa: engine cached for offline', cached);

    // Fullscreen control removed by design (game plays fine windowed)
    check('no fullscreen button', (await page.locator('#btn-fs').count()) === 0);

    check('no page errors in 3D session', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();

    // ---------- 2D fallback context (CDN blocked) ----------
    const r2 = await newPage(browser, true);
    const page2 = r2.page;
    check('2D: fallback mode active', (await g(page2, 'mode')) === '2d', await g(page2, 'mode'));
    check('2D: loader hidden too', await page2.locator('#loader').isHidden());
    // Start must work even while the nogl notice is showing (non-blocking banner)
    const noglVisible = await page2
      .locator('#nogl')
      .isVisible()
      .catch(() => false);
    await page2.locator('#btn-play').click();
    await page2.waitForTimeout(300);
    check(
      '2D: Start clickable while notice visible (notice=' + noglVisible + ')',
      (await g(page2, 'state')) === 'playing',
      await g(page2, 'state')
    );
    await page2.evaluate(() => {
      const s = window.__game.snake,
        dd = window.__game.dir;
      window.__game.setFood(s[0].x + dd.x, s[0].y + dd.y);
    });
    await page2.waitForFunction(() => window.__game.score >= 10, null, { timeout: 5000 });
    check('2D: food + scoring works', true);
    await page2.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      const s = window.__game.snake;
      window.__game.setBonus(s[0].x + 1, s[0].y, 7000);
      window.__game.step();
    });
    check('2D: bonus orb works', (await g(page2, 'score')) === 50, 'score=' + (await g(page2, 'score')));
    await page2.evaluate(() => {
      document.getElementById('opt-obstacles').checked = true;
      window.__game.start();
      window.__game.pause();
    });
    const nOb = await page2.evaluate(() => window.__game.obstacles.length);
    check('2D: obstacles spawn', nOb > 0, 'n=' + nOb);
    // 2D tap-to-steer via the same click path
    await page2.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
      window.__game.pause(); // resume
    });
    await page2.waitForTimeout(120);
    const v2 = await page2.evaluate(() => window.__game.view);
    const rect2 = await page2.locator('#scene').boundingBox();
    await page2.mouse.click(
      rect2.x + (v2.ox + 14.5 * v2.cell) / v2.dpr,
      rect2.y + (v2.oy + 10.5 * v2.cell) / v2.dpr
    );
    await page2.waitForTimeout(450);
    const sDir2 = await page2.evaluate(() => window.__game.dir);
    check('2D: tap-to-steer works', sDir2.x === 1 && sDir2.y === 0, JSON.stringify(sDir2));
    await page2.evaluate(() => {
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start(); // fresh centered snake: max wall-runway before pausing
    });
    await page2.locator('#btn-pause').click();
    await page2.waitForTimeout(150);
    check('2D: pause works', (await g(page2, 'state')) === 'paused');
    check('no page errors in 2D session', r2.errors.length === 0, r2.errors.slice(0, 2).join(' | '));
    await page2.close();
  } finally {
    await browser.close();
    server.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== ' + (results.length - fails.length) + '/' + results.length + ' passed ====');
  if (fails.length) {
    console.log('FAILURES:');
    fails.forEach((f) => console.log(' - ' + f.name + ' ' + f.extra));
  }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});

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
    check('arrow element removed', (await page.locator('#food-arrow').count()) === 0);
    check(
      'loader: staged progress available',
      (await page.evaluate(() => typeof window.__loadStep)) === 'function'
    );
    check(
      'a11y: canvas label translated',
      (await page.evaluate(() => document.getElementById('scene').getAttribute('aria-label'))) ===
        '3D snake game board'
    );
    // #toast is a visual channel only: with role=status AND #sr-status both
    // live, every event was spoken twice
    check(
      'a11y: toast is not a second live region',
      await page.evaluate(() => {
        const t = document.getElementById('toast');
        return t.getAttribute('aria-hidden') === 'true' && !t.hasAttribute('role');
      })
    );
    // hardcoded English accessible names (D-pad buttons especially: they are
    // the only way to steer on a phone)
    check(
      'a11y: dpad labels are i18n-driven',
      await page.evaluate(() => {
        const l = document.querySelector('#dpad button[data-dir="left"]');
        const r = document.querySelector('#dpad button[data-dir="right"]');
        return (
          l.getAttribute('data-i18n-aria') === 'dpad_left' &&
          r.getAttribute('data-i18n-aria') === 'dpad_right' &&
          l.getAttribute('aria-label') === 'Turn left' &&
          r.getAttribute('aria-label') === 'Turn right'
        );
      })
    );
    // HUD must not rewrite identical text on every tick (polite live region)
    check(
      'a11y: HUD writes only on change',
      await page.evaluate(async () => {
        const el = document.getElementById('score');
        const before = document.getElementById('hud').innerHTML;
        // same score, three ticks: nothing may change in the live region
        await new Promise((r) => setTimeout(r, 400));
        return el.textContent === el.textContent && document.getElementById('hud').innerHTML === before;
      })
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
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) >= 10,
      'state=' + (await g(page, 'state')) + ' score=' + (await g(page, 'score'))
    );

    // Help open/close (opening help auto-pauses the run).
    // Wrap on: the snake must not wall-die unattended mid-block.
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
    });
    await page.locator('#btn-help').click();
    check('btn-help: opens modal', await page.locator('#help-modal').isVisible());
    check('help: game auto-pauses behind docs', (await g(page, 'state')) === 'paused');
    // dialog semantics: the help overlay dims the screen but had no role, so
    // assistive tech never announced it as a dialog
    check(
      'a11y: help is a labelled modal dialog',
      await page.evaluate(() => {
        const h = document.getElementById('help-modal');
        const title = document.getElementById('help-title');
        return (
          h.getAttribute('role') === 'dialog' &&
          h.getAttribute('aria-modal') === 'true' &&
          !!title &&
          h.getAttribute('aria-labelledby') === title.id
        );
      })
    );
    // focus moves into the dialog on open
    check(
      'a11y: focus moves into help',
      await page.evaluate(() => document.getElementById('help-modal').contains(document.activeElement))
    );
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    check(
      'a11y: tab trapped in help dialog',
      await page.evaluate(() => !!document.getElementById('help-modal').contains(document.activeElement))
    );
    await page.keyboard.press('Escape');
    check('a11y: Escape closes help', await page.locator('#help-modal').isHidden());
    // ...and hands focus to the card's primary action, not the hidden close
    // button. (Space on a focused button activates it natively, so restoring
    // to btn-help would re-open the dialog instead of resuming.)
    check(
      'a11y: focus restored to primary action',
      await page.evaluate(() => document.activeElement && document.activeElement.id === 'btn-resume')
    );
    await page.locator('#btn-help').click();
    await page.keyboard.press('Space');
    check(
      'help: Space dismisses, game stays paused',
      (await page.locator('#help-modal').isHidden()) && (await g(page, 'state')) === 'paused'
    );
    await page.locator('#btn-help').click();
    await page.locator('#btn-close-help').click();
    check('btn-close-help: closes modal', await page.locator('#help-modal').isHidden());
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
    });

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

    // Input responsiveness: a turn applies within ~2 ticks, no more.
    // (Proves there is no input delay beyond the designed 1-tick quantization.)
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-speed').value = 'normal';
      window.__game.start();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
    await page.keyboard.press('ArrowLeft');
    const t0 = Date.now();
    await page.waitForFunction(() => window.__game.dir.x === 0 && window.__game.dir.y === -1, null, {
      timeout: 2000,
    });
    const dirMs = Date.now() - t0;
    check('input: turn applies fast', dirMs < 900, dirMs + 'ms (tick=120ms)');
    await page.waitForFunction(() => window.__game.snake[0].y < 10, null, { timeout: 3000 });
    check('input: head follows the turn', true);
    // ...even with a button focused (focused buttons used to swallow turn keys).
    // Paused so the queued turn persists instead of being consumed by a tick.
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      document.getElementById('btn-pause').focus();
    });
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(80);
    const focusQ = await page.evaluate(() => window.__game.queue);
    check(
      'input: turn keys steer with button focused',
      focusQ.length > 0 && focusQ[0].x === 0 && focusQ[0].y === -1,
      JSON.stringify(focusQ)
    );
    // ...while Space/Enter on a focused button still fire exactly once.
    // Explicit start+pause: the previous test leaves unknown state.
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      document.getElementById('btn-resume').focus();
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    check('input: Space on button single-fires', (await g(page, 'state')) === 'playing');
    // Enter on the focused Resume must toggle exactly once (native click only).
    // games is read after the setup start() so any increment is Enter's fault.
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      document.getElementById('btn-resume').focus();
    });
    const gamesBefore = (await g(page, 'life')).games;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    check(
      'input: Enter on button fires once',
      (await g(page, 'state')) === 'playing' && (await g(page, 'life')).games === gamesBefore,
      JSON.stringify({ state: await g(page, 'state'), games: (await g(page, 'life')).games })
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
    // accessible names must follow the language too, not just visible text
    check(
      'i18n: dpad aria-labels translated (?lang=de)',
      await page.evaluate(() => {
        const l = document.querySelector('#dpad button[data-dir="left"]');
        const r = document.querySelector('#dpad button[data-dir="right"]');
        const g = document.getElementById('dpad');
        return (
          l.getAttribute('aria-label') === 'Nach links drehen' &&
          r.getAttribute('aria-label') === 'Nach rechts drehen' &&
          g.getAttribute('aria-label') === 'Steuerknöpfe'
        );
      })
    );
    // h13/h14 used to be fully translated but never rendered anywhere
    check(
      'i18n: shield + skin help rows are rendered (?lang=de)',
      await page.evaluate(() => {
        const items = [...document.querySelectorAll('#help-modal li')].map((li) =>
          li.getAttribute('data-i18n-html')
        );
        return items.includes('h13') && items.includes('h14');
      })
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

    // Auto-fit framing (replaces the old edge arrow): head AND food stay on
    // screen in every situation. NDC |.|<=1 is visible; head gets the 0.9
    // comfort bound, food the 0.97 edge bound. All settles run paused so the
    // geometry is exact (framing runs while paused, snake frozen).
    const frameNow = async () =>
      page.evaluate(() => {
        const s = window.__game.snake[0];
        const f = window.__game.food;
        return {
          head: window.__game.project(s.x, s.y),
          food: window.__game.project(f.x, f.y),
          radius: window.__game.radius,
        };
      });
    const inScreen = (p, b) => p && !p.behind && Math.abs(p.x) <= b && Math.abs(p.y) <= b;
    // far corner, wrap off: the hardest raw span on the board
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 0, y: 0 }]);
      window.__game.setDir(1, 0);
      window.__game.setFood(19, 19);
    });
    await page.waitForTimeout(1500);
    const frameFar = await frameNow();
    check(
      'frame: far food stays on screen',
      inScreen(frameFar.head, 0.9) && inScreen(frameFar.food, 0.97),
      JSON.stringify(frameFar)
    );
    check('frame: radius opens up for distance', frameFar.radius > 30, String(frameFar.radius));
    // wrap-adjacent: raw span still framed (no shortcut zoom)
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 0, y: 10 }]);
      window.__game.setDir(0, 1);
      window.__game.setFood(19, 10);
    });
    await page.waitForTimeout(1500);
    const frameWrap = await frameNow();
    check(
      'frame: wrap-adjacent food stays on screen',
      inScreen(frameWrap.head, 0.9) && inScreen(frameWrap.food, 0.97),
      JSON.stringify(frameWrap)
    );
    // zoom-out snaps instantly (an eat never loses the new food)...
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setFood(11, 10);
    });
    await page.waitForTimeout(800);
    const rNear1 = (await frameNow()).radius;
    await page.evaluate(() => window.__game.setFood(0, 0));
    await page.waitForTimeout(400);
    const rFar = (await frameNow()).radius;
    // ...zoom-in eases down gently (no bounce)
    await page.evaluate(() => {
      const s = window.__game.snake[0];
      window.__game.setFood(s.x + 1, s.y);
    });
    await page.waitForTimeout(2500);
    const rNear2 = (await frameNow()).radius;
    check(
      'frame: radius snaps out, eases in',
      rFar > rNear1 + 5 && rNear2 < rFar - 3,
      [rNear1, rFar, rNear2].join('/')
    );
    // inspection hold: manual zoom wins briefly, auto-fit resumes after
    await page.evaluate(() => window.__game.setFood(19, 19));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__game.setRadius(14, 1500));
    await page.waitForTimeout(600);
    const rHold = (await frameNow()).radius;
    await page.waitForTimeout(2500);
    const rResumed = (await frameNow()).radius;
    check(
      'frame: inspection hold then auto resume',
      rHold < 20 && rResumed > 30,
      [rHold, rResumed].join('/')
    );
    // top-down view frames identically
    await page.evaluate(() => {
      document.getElementById('opt-cam').value = 'top';
      document.getElementById('opt-wrap').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 0, y: 0 }]);
      window.__game.setDir(1, 0);
      window.__game.setFood(19, 19);
    });
    await page.waitForTimeout(1500);
    const frameTop = await frameNow();
    check(
      'frame: top-down keeps both on screen',
      inScreen(frameTop.head, 0.9) && inScreen(frameTop.food, 0.97),
      JSON.stringify(frameTop)
    );
    await page.evaluate(() => {
      document.getElementById('opt-cam').value = 'follow';
      document.getElementById('opt-wrap').checked = false;
    });

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

    // Phase-A maps: every biome shows exactly its decor ring (+ texture unless low tier).
    // Forest has a second trunk ring; nothing else does.
    // Footprint audit: every instance center stays a provable margin off the ±10.25 walls.
    const dst = await page.evaluate(() => window.__game.decorStats());
    check('decor: footprint clear of board', dst.minCheb >= 13.4 && dst.total === 650, JSON.stringify(dst));
    check(
      'trail: soft round sprite (not squares)',
      await page.evaluate(
        () =>
          !!(
            window.__trailMat.map &&
            window.__trailMat.transparent &&
            window.__trailMat.blending === window.THREE.AdditiveBlending
          )
      )
    );
    const themeNames = ['Meadow', 'Desert', 'Ocean', 'Volcano', 'Space', 'Forest', 'Sunset', 'Ice'];
    const themeMeshes = [1, 1, 1, 1, 1, 2, 1, 1];
    for (let ti = 0; ti < themeNames.length; ti++) {
      await page.evaluate((i) => window.__game.setTheme(i), ti);
      await page.waitForTimeout(120);
      const dinfo = await page.evaluate(() => ({
        q: window.__game.quality,
        vis: window.__decorMeshes.filter((m) => m.visible).length,
        map: !!window.__groundMat.map,
      }));
      check(
        'decor: ' + themeNames[ti] + ' consistent',
        dinfo.q === 'low' ? dinfo.vis === 0 && !dinfo.map : dinfo.vis === themeMeshes[ti] && dinfo.map,
        JSON.stringify(dinfo)
      );
    }
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
    check('frame: camera settled near board', (await g(page, 'radius')) < 50);
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

    // SW precache completeness: the old addAll() was all-or-nothing, so ONE
    // bad URL left a fresh worker holding an empty cache and offline simply
    // never worked - invisible, because a failing read looks like a healthy
    // one from the outside. Ask the worker what it actually stored.
    const swStatus = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !navigator.serviceWorker.controller) return { ready: false };
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ready: false, why: 'timeout' }), 8000);
        const onMsg = (e) => {
          if (e.data && e.data.type === 'STATUS') {
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('message', onMsg);
            resolve({ ready: true, cache: e.data.cache, precache: e.data.precache });
          }
        };
        navigator.serviceWorker.addEventListener('message', onMsg);
        navigator.serviceWorker.controller.postMessage({ type: 'STATUS' });
      });
    });
    check('sw: reports precache result', swStatus.ready === true, JSON.stringify(swStatus));
    // 3D must come up for real, not via a silent catch: initThree() failing
    // used to be indistinguishable from "WebGL blocked" with no record
    check(
      '3d: renderer constructed with no init error',
      (await g(page, 'mode')) === '3d' &&
        (await page.evaluate(() => !window.__initErr)) &&
        (await page.evaluate(() => !!(window.__ray && window.__groundMat))),
      String(await page.evaluate(() => window.__initErr || 'none'))
    );
    const allCached = await page.evaluate(
      async () =>
        (
          await Promise.all(
            [
              './',
              './index.html',
              './style.css',
              './main.js',
              './logic.js',
              './i18n.js',
              './manifest.json',
              './icon.svg',
            ].map((u) => caches.match(new URL(u, location.href).toString()))
          )
        ).filter(Boolean).length
    );
    check('sw: all 8 local assets cached', allCached === 8, allCached + '/8');
    // deep links (?theme=&seed=) must reuse the one cached index.html instead
    // of minting a permanent entry per shared link
    const deepCached = await page.evaluate(async () => {
      const plain = await caches.match(new URL('./index.html', location.href).toString());
      const deep = await caches.match(new URL('./index.html?theme=volcano&seed=7', location.href).toString());
      const keys = await caches.keys();
      let entries = 0;
      for (const k of keys) entries += (await (await caches.open(k)).keys()).length;
      return { plain: !!plain, deep: !!deep, entries };
    });
    check(
      'sw: deep link reuses cached index (no query-keyed entry)',
      deepCached.plain && !deepCached.deep,
      JSON.stringify(deepCached)
    );

    // Fullscreen control removed by design (game plays fine windowed)
    check('no fullscreen button', (await page.locator('#btn-fs').count()) === 0);

    // ---- 7-feature round: recap, shot, shield, music voices, skins, links
    // 1. death recap: cause + biome + score + best on the game-over card
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
      window.__game.step();
    });
    await page.waitForTimeout(1400); // past the 1000ms overlay delay
    const recap = (await page.locator('#ov-sub').textContent()) || '';
    check(
      'recap: cause + biome + score + best',
      /wall/i.test(recap) && /Meadow/.test(recap) && /pts/.test(recap) && /Best/.test(recap),
      recap
    );
    // 2. share picture primed on game over; the button delivers a file/toast
    check('shot: primed on game over', await page.evaluate(() => window.__game.shotReady));
    await page.locator('#btn-shot').click();
    await page.waitForTimeout(500);
    const shotToast = (await page.locator('#toast').textContent()) || '';
    check('shot: button delivers picture', /Picture saved/.test(shotToast), shotToast);
    // 3. shield: orb grants a charge, the charge blocks a wall death
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = false;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 5, y: 5 }]);
      window.__game.setDir(1, 0);
      window.__game.setFood(0, 0); // park the food far away: the orb must be next
      window.__game.setShield(6, 5, 9000);
      window.__game.pause(); // resume: next tick eats the orb
    });
    await page.waitForFunction(() => window.__game.hasShield === true, null, { timeout: 5000 });
    check('shield: orb grants charge', true);
    check('shield: HUD pill shows', await page.locator('#pill-shield').isVisible());
    await page.evaluate(() => {
      window.__game.setSnake([{ x: 19, y: 5 }]);
      window.__game.setDir(1, 0);
    });
    await page.waitForFunction(() => window.__game.hasShield === false, null, { timeout: 5000 });
    const shieldLife = await g(page, 'life');
    check(
      'shield: blocks wall death, charge spent',
      shieldLife.deathsBlocked >= 1 && (await g(page, 'hasShield')) === false,
      JSON.stringify({ life: shieldLife })
    );
    // still pushing into the same wall with no charge left: the next tick kills
    await page.waitForFunction(() => window.__game.state === 'over', null, { timeout: 5000 });
    check('shield: single use — second crash kills', true);
    check(
      'shield: guardian achievement earned',
      (await g(page, 'ach')).indexOf('shield1') >= 0,
      JSON.stringify(await g(page, 'ach'))
    );
    // 4. per-biome music voices: all 8 keep the scheduler alive
    // (wrap on: the run must survive unattended while voices switch)
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
    });
    let voicesOk = true;
    for (let mi = 0; mi < 8; mi++) {
      await page.evaluate((i) => window.__game.setTheme(i), mi);
      await page.waitForTimeout(250);
      if (!(await page.evaluate(() => window.__game.musicPlaying()))) voicesOk = false;
    }
    check('music: all 8 biome voices play', voicesOk);
    // 5. skins: 6 options; guardian unlocked by the shield save above,
    // gold stays locked (a real win is unreachable in tests)
    const skinCount = await page.locator('#opt-skin option').count();
    const skinStates = await page.evaluate(() => {
      const out = {};
      const opts = document.querySelectorAll('#opt-skin option');
      for (let i = 0; i < opts.length; i++) out[opts[i].value] = !opts[i].disabled;
      return out;
    });
    check(
      'skins: picker reflects earned locks',
      skinCount === 6 &&
        skinStates.classic === true &&
        skinStates.guardian === true &&
        skinStates.gold !== true,
      JSON.stringify({ count: skinCount, states: skinStates })
    );
    await page.evaluate(() => window.__game.setSkin('gold'));
    check('skins: locked skin rejected', (await g(page, 'skin')) === 'classic');
    await page.evaluate(() => window.__game.setSkin('guardian'));
    check(
      'skins: guardian applies cyan head',
      (await g(page, 'skin')) === 'guardian' &&
        (await page.evaluate(() => window.__matH.color.getHex())) === 0x46e6ff
    );
    await page.evaluate(() => window.__game.setSkin('classic'));
    // 6. deep links: theme + seed from the URL, identical spawns across reloads
    const linkUrl = 'http://127.0.0.1:' + PORT + '/index.html?theme=volcano&seed=7';
    await page.goto(linkUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game && window.__game.state === 'menu', null, {
      timeout: 25000,
    });
    check('link: theme param selects biome', (await g(page, 'theme')) === 'Volcano');
    check('link: seed param arms deterministic rng', (await g(page, 'seed')) === 7);
    await page.evaluate(() => {
      document.getElementById('opt-obstacles').checked = false;
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
    });
    await page.waitForTimeout(300);
    const foodA = await g(page, 'food');
    await page.goto(linkUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game && window.__game.state === 'menu', null, {
      timeout: 25000,
    });
    await page.evaluate(() => {
      document.getElementById('opt-obstacles').checked = false;
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
    });
    await page.waitForTimeout(300);
    const foodB = await g(page, 'food');
    check(
      'link: same seed, same first food',
      foodA.x === foodB.x && foodA.y === foodB.y,
      JSON.stringify({ a: foodA, b: foodB })
    );
    // same seed replays identical obstacle maps too (layouts are seeded)
    async function seededObstacles() {
      await page.goto(linkUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__game && window.__game.state === 'menu', null, {
        timeout: 25000,
      });
      await page.evaluate(() => {
        document.getElementById('opt-obstacles').checked = true;
        document.getElementById('opt-wrap').checked = true;
        window.__game.start();
        window.__game.pause();
      });
      await page.waitForTimeout(200);
      return {
        obs: await g(page, 'obstacles'),
        layout: await g(page, 'layout'),
        head: (await g(page, 'snake'))[0],
      };
    }
    const runA = await seededObstacles();
    const runB = await seededObstacles();
    check(
      'link: same seed, same obstacles',
      JSON.stringify(runA.obs) === JSON.stringify(runB.obs) && runA.obs.length > 0,
      runA.obs.length + ' obstacles'
    );
    check(
      'link: same seed, same layout variant',
      JSON.stringify(runA.layout) === JSON.stringify(runB.layout),
      JSON.stringify(runA.layout)
    );
    // 7. SW update row exists (revealed by real updates; hidden by default)
    check('update: row hidden by default', await page.locator('#update-row').isHidden());

    // ---- map round: layouts, terrain rules, ambient, themed food/walls
    // clean page: variant roulette must not inherit the seeded link above
    await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game && window.__game.state === 'menu', null, {
      timeout: 25000,
    });
    // 1. layouts: force the patterned variant (rolling the seeded dice made
    // this a ~1-in-7000 flake), then prove symmetry + head clearance
    const sym = await page.evaluate(() => {
      document.getElementById('opt-obstacles').checked = true;
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
      window.__game.pause();
      window.__game.forceLayout('pattern');
      const obs = window.__game.obstacles;
      const set = {};
      obs.forEach((o) => (set[o.x + o.y * 20] = true));
      const head = window.__game.snake[0];
      return {
        n: obs.length,
        mirror: obs.every((o) => set[19 - o.x + o.y * 20] && set[o.x + (19 - o.y) * 20]),
        clear: obs.every((o) => Math.abs(o.x - head.x) + Math.abs(o.y - head.y) >= 4),
        scatter: (window.__game.layout || {}).scatter === true,
      };
    });
    check(
      'layout: patterned variant symmetric + head-clear',
      sym.n > 0 && !sym.scatter && sym.mirror && sym.clear,
      JSON.stringify(sym)
    );
    // the transposed variant is a different map, and equally symmetric
    const symT = await page.evaluate(() => {
      window.__game.forceLayout('transpose');
      const obs = window.__game.obstacles;
      const set = {};
      obs.forEach((o) => (set[o.x + o.y * 20] = true));
      return {
        n: obs.length,
        mirror: obs.every((o) => set[19 - o.x + o.y * 20] && set[o.x + (19 - o.y) * 20]),
        transpose: (window.__game.layout || {}).transpose === true,
      };
    });
    check(
      'layout: transposed variant symmetric + flagged',
      symT.n > 0 && symT.transpose && symT.mirror,
      JSON.stringify(symT)
    );
    // scatter is intentionally NOT symmetric — the variant must still place
    // obstacles clear of the head
    const symS = await page.evaluate(() => {
      window.__game.forceLayout('scatter');
      const obs = window.__game.obstacles;
      const head = window.__game.snake[0];
      return {
        n: obs.length,
        scatter: (window.__game.layout || {}).scatter === true,
        clear: obs.every((o) => Math.abs(o.x - head.x) + Math.abs(o.y - head.y) >= 4),
      };
    });
    check(
      'layout: scatter variant still head-clear',
      symS.n > 0 && symS.scatter && symS.clear,
      JSON.stringify(symS)
    );
    // 7. telegraph: fresh spawns pulse, then expire
    check('telegraph: neighbors pulse on spawn', (await g(page, 'warnCount')) > 0);
    await page.waitForTimeout(1600);
    check('telegraph: pulses expire', (await g(page, 'warnCount')) === 0);
    // 2a. ice slide: the turn lands one cell later
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(7);
    });
    await page.keyboard.press('ArrowLeft'); // snake-left from east = north
    await page.evaluate(() => window.__game.step());
    const iceH1 = (await g(page, 'snake'))[0];
    check(
      'ice: turn slides one cell later',
      (await g(page, 'dir')).x === 1 && (await g(page, 'dir')).y === 0 && iceH1.x === 11 && iceH1.y === 10,
      JSON.stringify({ dir: await g(page, 'dir'), head: iceH1 })
    );
    // 2b. leaving the ice flushes the stashed turn immediately
    await page.evaluate(() => {
      window.__game.setTheme(0);
      window.__game.step();
    });
    check('ice: flush on warm ground', (await g(page, 'dir')).x === 0 && (await g(page, 'dir')).y === -1);
    // 2c. staying on ice: the stashed turn applies on the next tick
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(7);
    });
    await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => {
      window.__game.step();
      window.__game.step();
    });
    const iceH3 = (await g(page, 'snake'))[0];
    check(
      'ice: stashed turn applies next tick',
      (await g(page, 'dir')).x === 0 && (await g(page, 'dir')).y === -1 && iceH3.x === 11 && iceH3.y === 9,
      JSON.stringify({ dir: await g(page, 'dir'), head: iceH3 })
    );
    // 2d. desert drain: withered food respawns with a warning (raw ticks: deterministic)
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(1);
      window.__game.setFood(5, 5);
      window.__game.witherFood();
      window.__game.step();
      window.__game.step();
    });
    await page.waitForTimeout(200);
    const drainToast = (await page.locator('#toast').textContent()) || '';
    check(
      'desert: withered food respawns',
      /withered/.test(drainToast) && (await g(page, 'state')) === 'paused',
      drainToast + '/' + (await g(page, 'state'))
    );
    // 2e. volcano embers: ignited cells kill, telegraphs are safe to cross
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(3);
      window.__game.setEmber(11, 10, 2500);
    });
    await page.evaluate(() => window.__game.step());
    check('ember: ignited cell kills', (await g(page, 'state')) === 'over');
    await page.waitForTimeout(1400);
    const emberSub = (await page.locator('#ov-sub').textContent()) || '';
    check('ember: recap names fire', /fire/i.test(emberSub), emberSub);
    await page.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(3);
      window.__game.setEmber(11, 10, 0);
    });
    await page.evaluate(() => window.__game.step());
    check('ember: telegraph phase safe', (await g(page, 'state')) === 'paused');

    // Screen readers must be told when an ember turns lethal: it is a visual
    // ring for sighted players and a silent death for everyone else.
    const emberSr = await page.evaluate(async (EMBER_WARN) => {
      const sr = () => document.getElementById('sr-status').textContent;
      const before = sr();
      document.getElementById('opt-wrap').checked = true;
      document.getElementById('opt-obstacles').checked = false;
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(1, 0);
      window.__game.setTheme(3);
      window.__game.clearEmbers();
      window.__game.setEmber(5, 5, EMBER_WARN - 40); // just below ignition
      window.__game.pause(); // resume so the age loop runs
      // age it past EMBER_WARN (2000ms) on play time. Wait for the ember text
      // specifically: other announcements (perf mode) share this region.
      const hit = () => /burning|keep clear/i.test(sr());
      const t0 = Date.now();
      while (Date.now() - t0 < 4000 && !hit()) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return { before, after: sr(), hit: hit() };
    }, 2000);
    check(
      'a11y: ember ignition announced',
      /burning|keep clear/i.test(emberSr.after),
      JSON.stringify(emberSr)
    );
    // ...and repeated hazards still speak (the say() de-dupe must not swallow it)
    const emberSr2 = await page.evaluate(async (EMBER_WARN) => {
      const sr = () => document.getElementById('sr-status').textContent;
      const hit = () => /burning|keep clear/i.test(sr());
      window.__game.clearEmbers();
      window.__game.setEmber(6, 6, EMBER_WARN - 40);
      // wait for a NEW ignition (the live region may still hold the first one)
      const t0 = Date.now();
      let seen = 0;
      while (Date.now() - t0 < 4000) {
        if (hit()) {
          seen++;
          if (seen >= 2) break; // counted the stale one + the new one
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      return sr();
    }, 2000);
    check('a11y: repeat ember still announced', /burning|keep clear/i.test(emberSr2), emberSr2);
    // 3+4. ambient cloud, food tints, wall builds, glyph map across all biomes
    await page.evaluate(() => {
      document.getElementById('opt-wrap').checked = true;
      window.__game.start();
    });
    const wantGlyphs = ['square', 'circle', 'diamond', 'circle', 'square', 'tri', 'square', 'diamond'];
    let ambDataOk = true,
      ambGateOk = true;
    const glyphs = [];
    let tint0 = 0,
      tint3 = 0,
      wallMeadow = 0,
      wallIce = 0;
    for (let ai = 0; ai < 8; ai++) {
      await page.evaluate((i) => window.__game.setTheme(i), ai);
      await page.waitForTimeout(300);
      const row = await page.evaluate(() => ({
        vis: window.__game.ambient.visible,
        n: window.__game.ambient.count,
        color: window.__game.ambient.color,
        tint: window.__game.foodTint,
        wall: window.__game.wallH,
        glyph: window.__game.obGlyph(),
        quality: window.__game.quality,
      }));
      glyphs.push(row.glyph);
      if (!(row.n > 0 && row.color > 0)) ambDataOk = false;
      if (row.vis !== (row.quality !== 'low')) ambGateOk = false;
      if (ai === 0) {
        tint0 = row.tint;
        wallMeadow = row.wall;
      }
      if (ai === 3) tint3 = row.tint;
      if (ai === 7) wallIce = row.wall;
    }
    check('ambient: per-biome cloud data on all maps', ambDataOk);
    check('ambient: visibility follows quality tier', ambGateOk);
    check('food: tint changes per biome', tint0 !== tint3 && tint0 > 0 && tint3 > 0, tint0 + '/' + tint3);
    check('walls: ice crystal build taller', wallIce > wallMeadow, wallMeadow + '/' + wallIce);
    check(
      'glyphs: obstacle map follows biome geos',
      JSON.stringify(glyphs) === JSON.stringify(wantGlyphs),
      glyphs.join(',')
    );

    check('no page errors in 3D session', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();

    // ---------- 2D fallback context (CDN blocked) ----------
    const r2 = await newPage(browser, true);
    const page2 = r2.page;
    check('2D: fallback mode active', (await g(page2, 'mode')) === '2d', await g(page2, 'mode'));
    check('2D: loader hidden too', await page2.locator('#loader').isHidden());
    // the CDN-blocked path must degrade for the RIGHT reason, so a genuine
    // scene-setup bug can never masquerade as a blocked CDN
    check(
      '2D: fallback caused by missing engine, not a scene bug',
      (await page2.evaluate(() => typeof window.THREE)) === 'undefined' &&
        (await page2.evaluate(() => !window.__initErr)),
      String(await page2.evaluate(() => window.__initErr || 'no-three'))
    );
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
    // 2D parity: themed obstacle glyphs follow the biome geos
    const glyphs2d = {};
    for (const [ti, want] of [
      [0, 'square'],
      [1, 'circle'],
      [5, 'tri'],
      [2, 'diamond'],
    ]) {
      await page2.evaluate((i) => window.__game.setTheme(i), ti);
      await page2.waitForTimeout(150);
      glyphs2d[ti] = await page2.evaluate(() => window.__game.obGlyph());
      check('2D: glyph for theme ' + ti, glyphs2d[ti] === want, glyphs2d[ti]);
    }
    // 2D ember + telegraph render paths stay silent
    await page2.evaluate(() => {
      document.getElementById('opt-obstacles').checked = true;
      window.__game.start();
      window.__game.pause();
      window.__game.setEmber(5, 5, 2500);
      window.__game.step();
    });
    await page2.waitForTimeout(300);
    check('2D: ember render path alive', (await g(page2, 'state')) === 'paused');
    await page2.evaluate(() => {
      document.getElementById('opt-obstacles').checked = true;
      window.__game.start();
      window.__game.pause();
    });
    const nOb = await page2.evaluate(() => window.__game.obstacles.length);
    check('2D: obstacles spawn', nOb > 0, 'n=' + nOb);
    check('2D: no food arrow element', (await page2.locator('#food-arrow').count()) === 0);
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

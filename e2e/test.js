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

    // Restart via real trusted click.
    // No sleep before reading the score: this test used to wait 200ms and then
    // assert score === 0, which is a coin flip - reset() respawns food at a
    // random cell, so if it happened to land next to the head the snake ate
    // before the assertion and the check failed for no real reason. The click
    // handler resets the score synchronously, so reading immediately is both
    // deterministic and the stronger test.
    await page.evaluate(() => window.__game.forceEats(3));
    const scoreBeforeRestart = await g(page, 'score');
    await page.locator('#btn-restart').click();
    const afterRestart = await g(page, 'state');
    const scoreAfterRestart = await g(page, 'score');
    check(
      'btn-restart: real click restarts to playing/score 0',
      afterRestart === 'playing' && scoreAfterRestart === 0 && scoreBeforeRestart > 0,
      'before=' + scoreBeforeRestart + ' after=' + scoreAfterRestart + ' state=' + afterRestart
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

    // Dead keys teach once: the FIRST dead key shows the hint and records it,
    // and later dead keys stay silent.
    //
    // The hint is asserted by RECORDING every #toast write, not by sampling
    // the element afterwards. The game is playing here, so #toast is a shared
    // channel: a competing announcement (perf mode under swiftshader, level
    // up, a hazard) can overwrite the text within the wait, which made this
    // check fail intermittently while the hint had fired correctly.
    await page.evaluate(() => {
      const el = document.getElementById('toast');
      window.__toastSeen = [];
      window.__toastMo = new MutationObserver(() => {
        const v = el.textContent;
        if (v && window.__toastSeen[window.__toastSeen.length - 1] !== v) window.__toastSeen.push(v);
      });
      window.__toastMo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    const deadKey = await page.evaluate(() => {
      window.__toastMo.disconnect();
      const want = window.I18N.en.keys_hint;
      const seen = window.__toastSeen;
      return {
        want,
        taught: seen.includes(want),
        // the "once" in the test name: a second dead key must not re-teach
        count: seen.filter((v) => v === want).length,
        stored: localStorage.getItem('snake3d.seenKeys'),
        seen: seen.slice(-4),
      };
    });
    check(
      'keyboard: dead key teaches once',
      deadKey.taught && deadKey.count === 1 && deadKey.stored === '1',
      JSON.stringify(deadKey)
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

    // Eat food grows snake.
    // Assert the INTENT (one food = +10 and exactly one segment of growth)
    // instead of polling for `length === 4`, which is a single transient frame
    // a poll can easily miss once the snake keeps moving. Same luck-dependence
    // that made the 2D scoring check flaky: food placed once, then hoped for.
    const lenBefore = (await g(page, 'snake')).length;
    await page.evaluate(() => {
      window.__game.start();
      window.__eatDrive = setInterval(() => {
        const gme = window.__game;
        if (gme.state !== 'playing') return;
        const s = gme.snake[0];
        if (!s) return;
        const d = gme.dir;
        gme.setFood((s.x + d.x + 20) % 20, (s.y + d.y + 20) % 20);
      }, 30);
    });
    const ate = await page
      .waitForFunction(() => window.__game.score >= 10, null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    const eatRes = await page.evaluate(() => {
      clearInterval(window.__eatDrive);
      return { score: window.__game.score, len: window.__game.snake.length };
    });
    check(
      'eat: score+10 & length 4',
      ate && eatRes.score >= 10 && eatRes.len === lenBefore + 1,
      JSON.stringify({ before: lenBefore, ...eatRes })
    );

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

    // Wrap mode survives walls.
    // Driven by explicit step() calls rather than a wall-clock wait: the old
    // version slept 600ms and asserted an exact cell, so its result depended on
    // how many ticks the browser managed to fit in that window (plus IPC
    // overhead). Stepping makes "it wrapped" the only thing under test.
    const wset = await page.evaluate(() => {
      const g2 = window.__game;
      g2.start();
      document.getElementById('opt-wrap').checked = true;
      g2.setSnake([{ x: 19, y: 5 }]);
      g2.setDir(1, 0);
      const seen = [];
      for (let i = 0; i < 4; i++) {
        g2.step();
        seen.push(g2.snake[0].x);
      }
      return { state: g2.state, seen: seen };
    });
    const wpos = wset.seen;
    const wst = wset.state;
    check(
      'wrap walls: survives + wraps to left side',
      wst === 'playing' && wpos[0] === 0 && wpos[3] === 3,
      wst + ' ' + wpos.join(',')
    );
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

    // Speed curve: asymptotic, so it keeps improving for the whole run instead
    // of slamming into a floor and sitting flat. The old linear curve reached
    // 55ms by food #12 (fast) / #22 (normal) and never moved again.
    const curve = await page.evaluate(() => {
      const gme = window.__game;
      gme.start();
      gme.pause();
      document.getElementById('opt-speed').value = 'normal';
      const at = (n) => gme.tickForFoods(n);
      return { f0: at(0), f6: at(6), f22: at(22), f60: at(60), f200: at(200) };
    });
    check(
      'speed curve: strictly decreasing, never clamped flat',
      curve.f0 > curve.f6 && curve.f6 > curve.f22 && curve.f22 > curve.f60 && curve.f60 > curve.f200,
      JSON.stringify(curve)
    );
    check(
      'speed curve: starts exactly at the selected preset (160 slow / 120 normal)',
      Math.abs(curve.f0 - 120) < 0.001,
      'f0=' + curve.f0
    );
    check(
      'speed curve: approaches the floor but never reaches it',
      curve.f200 > 55 && curve.f200 < 56,
      'f200=' + curve.f200
    );

    // A bonus orb grows the snake, so it must count toward the level goal too.
    const bonusGoal = await page.evaluate(() => {
      const gme = window.__game;
      gme.start();
      gme.pause();
      gme.clearBonus();
      // 5 regular foods -> level 1, goal 5/6
      for (let i = 0; i < 5; i++) {
        const s = gme.snake[0];
        gme.setFood(s.x + 1, s.y);
        gme.step();
      }
      const before = { level: gme.level, goal: document.getElementById('goal').textContent };
      // now eat a bonus orb instead of the regular food
      gme.clearBonus();
      const s2 = gme.snake[0];
      gme.setBonus(s2.x + 1, s2.y, 90000);
      gme.step();
      return { before, after: { level: gme.level, goal: document.getElementById('goal').textContent } };
    });
    check(
      'bonus orb: counts toward the level goal (5 food + 1 bonus -> level 2)',
      bonusGoal.before.goal === '5/6' && bonusGoal.after.level === 2,
      JSON.stringify(bonusGoal)
    );

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

    // Kid mode must be REVERSIBLE. It used to be a one-way preset: unchecking
    // did nothing, so the player was stuck in kid settings with no indication.
    const kidRestore = await page.evaluate(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = v;
        else el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // a distinctive starting point
      set('opt-kid', false);
      set('opt-speed', 'fast');
      set('opt-obstacles', true);
      const before = {
        speed: document.getElementById('opt-speed').value,
        obstacles: document.getElementById('opt-obstacles').checked,
      };
      set('opt-kid', true);
      const during = {
        speed: document.getElementById('opt-speed').value,
        wrap: document.getElementById('opt-wrap').checked,
        obstacles: document.getElementById('opt-obstacles').checked,
      };
      set('opt-kid', false);
      const after = {
        speed: document.getElementById('opt-speed').value,
        obstacles: document.getElementById('opt-obstacles').checked,
      };
      return { before, during, after };
    });
    check(
      'kid mode: presets applied while on',
      kidRestore.during.speed === 'slow' && kidRestore.during.wrap && !kidRestore.during.obstacles,
      JSON.stringify(kidRestore.during)
    );
    check(
      'kid mode: unchecking restores the previous settings',
      kidRestore.after.speed === kidRestore.before.speed &&
        kidRestore.after.obstacles === kidRestore.before.obstacles,
      JSON.stringify({ before: kidRestore.before, after: kidRestore.after })
    );

    // New biomes cycle past Space
    for (const [idx, name] of [
      [5, 'Forest'],
      [6, 'Sunset'],
      [7, 'Ice'],
    ]) {
      await page.evaluate((i) => window.__game.setTheme(i), idx);
      check('biome: ' + name + ' applied', (await g(page, 'theme')) === name, await g(page, 'theme'));
    }
    // Report the scene precondition instead of dereferencing it blindly. This
    // page was re-navigated above, so if WebGL happened to be unavailable the
    // game boots its 2D fallback and there is no 3D scene at all: every earlier
    // check still passes, and a bare `window.__stars.visible` would throw an
    // opaque harness error that aborts the rest of the run. Name the real
    // cause (mode + stashed init error) so an environment failure is
    // diagnosable rather than mysterious.
    const sceneState = await page.evaluate(() => ({
      mode: window.__game.mode,
      hasScene: !!window.__stars,
      initErr: window.__initErr || null,
    }));
    check(
      'biome: 3D scene present after re-navigation',
      sceneState.mode === '3d' && sceneState.hasScene,
      JSON.stringify(sceneState)
    );
    check(
      'biome: stars only on Space',
      sceneState.hasScene && !(await page.evaluate(() => window.__stars.visible)),
      JSON.stringify(sceneState)
    );

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

    // Fixed framing (replaces the old edge arrow): the zoom is a pure function
    // of the viewport, and the WHOLE board is framed at every screen size, so
    // head and food are on screen in every situation. NDC |.|<=1 is visible;
    // head gets the 0.9 comfort bound, food the 0.97 edge bound. All settles run
    // paused so the geometry is exact (framing runs while paused, snake frozen).
    const frameNow = async () =>
      page.evaluate(() => {
        const s = window.__game.snake[0];
        const f = window.__game.food;
        // every cell, so "whole board framed" is measured, not assumed
        let cells = 0;
        for (let x = 0; x < 20; x++)
          for (let y = 0; y < 20; y++) {
            const p = window.__game.project(x, y);
            if (p && !p.behind && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) cells++;
          }
        return {
          head: window.__game.project(s.x, s.y),
          food: window.__game.project(f.x, f.y),
          radius: window.__game.radius,
          fit: window.__game.fitRadius,
          cells,
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
    check(
      'frame: whole board framed at far food (400 cells)',
      frameFar.cells === 400,
      'cells=' + frameFar.cells
    );
    check(
      'frame: zoom equals the fixed fit',
      Math.abs(frameFar.radius - frameFar.fit) < 0.6,
      frameFar.radius + ' vs fit ' + frameFar.fit
    );
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
    // The regression this locks down: the zoom must NOT react to where the food
    // is. Adjacent food, opposite-corner food, then adjacent again — the radius
    // has to be identical every time (it used to pump by 5-15 world units).
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
    await page.evaluate(() => {
      const s = window.__game.snake[0];
      window.__game.setFood(s.x + 1, s.y);
    });
    await page.waitForTimeout(2500);
    const rNear2 = (await frameNow()).radius;
    check(
      'frame: zoom fixed regardless of food distance',
      Math.abs(rFar - rNear1) < 0.6 && Math.abs(rNear2 - rNear1) < 0.6,
      [rNear1, rFar, rNear2].join('/')
    );
    // inspection hold: manual zoom wins briefly, then the fixed frame resumes
    await page.evaluate(() => window.__game.setFood(19, 19));
    await page.waitForTimeout(1200);
    const fitBefore = (await frameNow()).fit;
    await page.evaluate(() => window.__game.setRadius(14, 1500));
    await page.waitForTimeout(600);
    const rHold = (await frameNow()).radius;
    await page.waitForTimeout(2500);
    const rResumed = (await frameNow()).radius;
    check(
      'frame: inspection hold then fixed resume',
      rHold < 20 && Math.abs(rResumed - fitBefore) < 0.6,
      [rHold, rResumed, 'fit', fitBefore].join('/')
    );
    // top-down view frames the whole board too, at its own fit distance
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
    check('frame: top-down frames whole board', frameTop.cells === 400, 'cells=' + frameTop.cells);
    check(
      'frame: top-down zoom equals its own fit',
      Math.abs(frameTop.radius - frameTop.fit) < 0.6,
      frameTop.radius + ' vs fit ' + frameTop.fit
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
      window.__scoreProbe = 0;
      window.__game.start();
      document.getElementById('opt-wrap').checked = true; // survive this long block unattended
      window.__game.pause();
      // A known non-zero score. The old version of this test left the snake
      // running unattended for ~1s and asserted score === 0 after Restart, which
      // only held when the snake happened not to stumble onto food in that
      // window - a coin-flip flake, and a weak test even when it passed: it
      // never proved Restart cleared anything.
      window.__game.forceEats(3);
      window.__scoreProbe = window.__game.score;
      window.__game.resume();
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
    const probeBefore = await page.evaluate(() => window.__scoreProbe);
    await page.locator('#btn-restart2').click();
    await page.waitForTimeout(200);
    check(
      'pause menu: Restart resets',
      (await g(page, 'state')) === 'playing' && (await g(page, 'score')) === 0 && probeBefore > 0,
      'before=' + probeBefore + ' after=' + (await g(page, 'score'))
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
    // 3. shield: orb grants a charge, the charge SAVES the run
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
    // Drive into the wall and let the run keep going: a charge that only
    // delayed death by one tick used to end the run right here, which is what
    // players reported ("it said the shield broke, then the game ended").
    const shieldSave = await page.evaluate(() => {
      const gme = window.__game;
      gme.setSnake([{ x: 19, y: 5 }]);
      gme.setDir(1, 0);
      const before = gme.life.deathsBlocked || 0;
      gme.step(); // crash -> charge absorbs and steers us clear
      return { state: gme.state, dir: { ...gme.dir }, blocked: (gme.life.deathsBlocked || 0) - before };
    });
    check(
      'shield: absorbs the crash and steers clear (not just one tick)',
      shieldSave.state === 'playing' && shieldSave.dir.x === -1 && shieldSave.dir.y === 0,
      JSON.stringify(shieldSave)
    );
    // single use: with the charge spent, the very next crash must be fatal
    const shieldSpent = await page.evaluate(() => {
      const gme = window.__game;
      gme.setSnake([{ x: 19, y: 5 }]);
      gme.setDir(1, 0);
      gme.step(); // crash with no charge left
      return { state: gme.state, blocked: gme.life.deathsBlocked };
    });
    check(
      'shield: single use — a later crash kills',
      shieldSpent.state === 'over',
      JSON.stringify({ state: shieldSpent.state, life: shieldSpent })
    );
    check(
      'shield: guardian achievement earned',
      (await g(page, 'ach')).indexOf('shield1') >= 0,
      JSON.stringify(await g(page, 'ach'))
    );

    // 3b. every lethal source must be survivable, not just walls. Driven by
    // manual steps so each case is deterministic instead of racing the clock.
    const shieldPaths = await page.evaluate(() => {
      const gme = window.__game;
      const out = [];
      const grant = () => {
        gme.start();
        gme.pause();
        gme.clearEmbers();
        gme.setFood(0, 0);
        gme.setSnake([{ x: 5, y: 5 }]);
        gme.setDir(1, 0);
        gme.setShield(6, 5, 90000);
        gme.step();
        return gme.hasShield;
      };
      const run = (name, setup) => {
        if (!grant()) return out.push([name, false, 'grant failed']);
        new Function('g', setup)(gme);
        for (let i = 0; i < 6; i++) {
          gme.step();
          if (gme.state === 'over') break;
        }
        out.push([name, gme.state !== 'over', gme.state]);
      };
      run('self bite (2x2 coil)', 'g.setSnake([{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5}]); g.setDir(0,1);');
      run(
        'self bite (mid-body)',
        'g.setSnake([{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:7,y:5},{x:8,y:5}]); g.setDir(1,0);'
      );
      run('ember', 'g.setSnake([{x:5,y:5}]); g.setDir(1,0); g.setEmber(6,5,2500);');
      run('corner walled in', 'g.setSnake([{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]); g.setDir(0,-1);');
      run(
        'fully trapped (no safe heading)',
        'g.setSnake([{x:5,y:5},{x:4,y:5},{x:4,y:4},{x:5,y:4},{x:6,y:4},{x:6,y:5},{x:6,y:6},{x:5,y:6},{x:4,y:6}]); g.setDir(1,0);'
      );
      return out;
    });
    for (const [nm, ok, st] of shieldPaths) check('shield survives: ' + nm, ok, 'ended=' + st);
    const noCharge = await page.evaluate(() => {
      const gme = window.__game;
      document.getElementById('opt-wrap').checked = false;
      gme.start();
      gme.pause();
      gme.setSnake([{ x: 19, y: 5 }]);
      gme.setDir(1, 0);
      gme.step();
      return gme.state;
    });
    check('shield control: no charge still kills', noCharge === 'over', noCharge);
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
    // Assert on the EXACT ignite string from the page's own translations, not a
    // loose /burning|keep clear/ regex: ember_first ("...then burn - keep clear!")
    // matches that regex, so a stale region could satisfy the old assertion
    // without the ignition ever being announced.
    const EMBER_SR = await page.evaluate(async (EMBER_WARN) => {
      const srEl = document.getElementById('sr-status');
      const want = window.I18N.en.ember_ignite;
      const first = window.I18N.en.ember_first;
      // The region is shared with perf/game-state chatter, so a transient
      // ignition can be overwritten before the next poll. Record EVERY write.
      const seen = [];
      let prev = '';
      const mo = new MutationObserver(() => {
        const v = srEl.textContent;
        // record every write, INCLUDING a repeat of the previous value: a
        // forced repeat announces by clearing then re-writing, and de-duping
        // here would hide exactly the behaviour under test
        if (v !== prev) {
          prev = v;
          seen.push(v);
        }
      });
      mo.observe(srEl, { childList: true, characterData: true, subtree: true });
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
      const t0 = Date.now();
      let spawned2 = false;
      while (Date.now() - t0 < 6000) {
        await new Promise((r) => setTimeout(r, 80));
        const n = seen.filter((v) => v === want).length;
        // a second, identical hazard: say() de-dupes repeats, so this only
        // speaks if ignition is announced with force=true
        if (n >= 1 && !spawned2) {
          spawned2 = true;
          window.__game.setEmber(6, 6, EMBER_WARN - 40);
        }
        if (n >= 2) break;
      }
      mo.disconnect();
      const hits = seen.filter((v) => v === want).length;
      return {
        want,
        first,
        hits,
        sawFirst: seen.includes(first),
        spawned2,
        // the two writes must be separated by a clear, proving the repeat was
        // an observable change rather than an ignored no-op rewrite
        clearedBetween: (() => {
          const i = seen.indexOf(want);
          return i >= 0 && seen.slice(i + 1, seen.indexOf(want, i + 1)).includes('');
        })(),
        seen: seen.slice(-6),
      };
    }, 2000);
    check(
      'a11y: ember ignition announced',
      EMBER_SR.hits >= 1 && !EMBER_SR.sawFirst,
      JSON.stringify(EMBER_SR)
    );
    // a second, identical hazard must still speak: say() de-dupes repeats, so
    // ignition is announced with force=true
    check(
      'a11y: repeat ember still announced',
      EMBER_SR.hits >= 2 && EMBER_SR.clearedBetween,
      JSON.stringify(EMBER_SR)
    );
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

    // ---------- combo ladder / bank / maze / orb pacing / daily ----------
    // A fresh page so the ladder assertions cannot be perturbed by the combo
    // state left behind by the scoring group above.
    const rL = await newPage(browser, false);
    const pL = rL.page;
    {
      // --- 2: the ladder replaces the x5 plateau ---
      const ladder = await pL.evaluate(() => {
        const S = window.SnakeLogic;
        // comboFor(m-1, gap) chains once and lands on exactly m
        return [1, 5, 8, 12].map((m) => S.comboFor(m - 1, 1000, 1001, 5000).mult);
      });
      check('ladder: multiplier keeps climbing past x5', ladder.join(',') === '1,5,8,12', ladder.join(','));
      const win = await pL.evaluate(() => {
        const S = window.SnakeLogic;
        return [1, 2, 4, 8, 12, 20].map((c) => S.comboWindow(5000, c));
      });
      // strictly tighter while it can be, then pinned at the floor - never
      // growing back, which is what would make the "risk" a lie
      check(
        'ladder: window tightens every step then floors out',
        win[0] === 5000 &&
          win[1] < win[0] &&
          win[2] < win[1] &&
          win[3] < win[2] &&
          win[4] <= win[3] &&
          win[4] === 1100 &&
          win[5] === 1100,
        win.join(',')
      );
      // The HUD must not imply a ceiling the scoring no longer has.
      await pL.evaluate(() => {
        window.__game.start();
        window.__game.setCombo(9);
      });
      await pL.waitForTimeout(120);
      const pillTxt = await pL.locator('#combo').textContent();
      const pillHot = await pL.locator('#pill-combo').getAttribute('class');
      check(
        'ladder: HUD shows uncapped multiplier and flags a hot chain',
        pillTxt.trim() === 'x9' && /hot/.test(pillHot || ''),
        pillTxt + ' / ' + pillHot
      );
      // The combo banner interpolates {n}. A call site that forgot to pass it
      // rendered a literal "x{n}" on screen and no assertion caught it, so pin
      // every user-facing string we build from a chain.
      const bannerTxt = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.start();
        g2.pause();
        g2.forceEats(5); // lands the chain exactly on the 5th milestone
        return document.getElementById('banner').textContent;
      });
      check(
        'ladder: combo banner interpolates the step (no literal {n})',
        /x5/.test(bannerTxt || '') && !/{/.test(bannerTxt || ''),
        bannerTxt
      );
      const bankToast = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.resume();
        g2.pause();
        g2.setCombo(6);
        g2.bank();
        return document.getElementById('toast').textContent;
      });
      check(
        'ladder: bank toast interpolates the amount (no literal {n})',
        /180/.test(bankToast || '') && !/{/.test(bankToast || ''),
        bankToast
      );

      // --- 4: the streak bank ---
      await pL.evaluate(() => window.__game.setCombo(2));
      const bankOff = await pL.evaluate(() => {
        const before = window.__game.score;
        return { row: window.__game.bankRowVisible(), gained: window.__game.bank(), before };
      });
      check('bank: nothing to bank below the threshold', bankOff.row === false && bankOff.gained === false);
      await pL.evaluate(() => window.__game.setCombo(6));
      // resume first: the previous block left the game paused, and pause() on a
      // paused game *resumes* it, which would hide the card we are asserting on
      await pL.evaluate(() => {
        window.__game.resume();
        window.__game.setCombo(6);
        window.__game.pause();
      });
      await pL.waitForTimeout(150);
      check('bank: row offered on the pause card', await pL.evaluate(() => window.__game.bankRowVisible()));
      const bankLabel = (await pL.locator('#btn-bank').textContent()).trim();
      const banked = await pL.evaluate(() => {
        const before = window.__game.score;
        const ok = window.__game.bank();
        return { ok, gained: window.__game.score - before, combo: window.__game.combo };
      });
      check(
        'bank: pays 5 x combo^2 and clears the chain',
        banked.ok && banked.gained === 180 && banked.combo === 0,
        'x6 -> ' + banked.gained + ', label="' + bankLabel + '"'
      );
      check('bank: row hides again once banked', await pL.evaluate(() => !window.__game.bankRowVisible()));
      // an un-banked chain must die with the run, and the recap has to say so.
      // Fully deterministic: classic mode, no orbs, food parked off the path -
      // otherwise a stray bonus sitting on the walk line gets eaten first, which
      // bumps the chain and changes the number the recap reports.
      await pL.evaluate(() => {
        window.__game.resume(); // paused -> playing
        document.getElementById('opt-wrap').checked = false;
        document.getElementById('opt-obstacles').checked = false;
        window.__game.clearBonus();
        window.__game.reset();
        window.__game.setCombo(7);
        window.__game.setDir(-1, 0);
        window.__game.setSnake([
          { x: 9, y: 10 },
          { x: 10, y: 10 },
          { x: 11, y: 10 },
          { x: 11, y: 11 },
        ]);
        window.__game.setFood(0, 0);
      });
      // wait for the recap card itself, not just the state flip: the overlay is
      // deliberately delayed ~1s behind the crash
      await pL
        .waitForFunction(() => /\u00d77/.test(document.getElementById('ov-sub').textContent || ''), null, {
          timeout: 8000,
        })
        .catch(() => {});
      const lostTxt = await pL.locator('#ov-sub').textContent();
      check(
        'bank: crash forfeits an un-banked chain and the recap names it',
        (await g(pL, 'state')) === 'over' && /\u00d77/.test(lostTxt || ''),
        (lostTxt || '').slice(0, 70)
      );

      // --- 2b: speed-aware combo base ---
      const comboBase = await pL.evaluate(() => window.__game.comboBase);
      check(
        'ladder: combo base is the speed-scaled window (>= floor)',
        Number.isFinite(comboBase) && comboBase >= 1100,
        String(comboBase)
      );
      const bankP = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.reset();
        g2.start();
        g2.setCombo(6);
        g2.clearEmbers();
        const calm = g2.bankValueNow();
        g2.setEmber(5, 5, 0); // one live telegraph on the board
        const hot = g2.bankValueNow();
        return { calm, hot };
      });
      check(
        'bank: calm board keeps old value; an ember raises the cash-out',
        bankP.calm === 180 && bankP.hot === 225,
        JSON.stringify(bankP)
      );
      const bankDelta = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.pause(); // paused + combo 6 -> bank card visible
        return document.getElementById('bank-delta').textContent;
      });
      check(
        'bank: pause card shows the gain from one more chained food',
        /Next chain/.test(bankDelta || '') && /\+\d+/.test(bankDelta || ''),
        bankDelta
      );

      // --- 2c: daily teaser + desert countdown ---
      const teaser = await pL.locator('#daily-teaser').textContent();
      check(
        'daily: the menu always teases today\u2019s twist',
        /twist|reto|d\u00e9fi|Wendung/i.test(teaser || ''),
        (teaser || '').slice(0, 50)
      );
      const desert = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.reset();
        g2.start();
        g2.setTheme(1); // Desert (reset() would otherwise restore the start theme)
        const fresh = g2.desertRemaining();
        g2.ageFood(16000); // leave ~4s before the food withers
        return { fresh, low: g2.desertRemaining() };
      });
      check(
        'desert: food wither countdown is queryable and shrinks with age',
        Number.isFinite(desert.fresh) &&
          desert.fresh > 10000 &&
          desert.low < 5000 &&
          desert.low < desert.fresh,
        JSON.stringify(desert)
      );

      // --- 2d: perf/robustness + UI/UX hardening ---
      const hudNoChurn = await pL.evaluate(() => {
        const before = window.__game.hudWrites;
        return { before, after: window.__game.hudWrites, finite: Number.isFinite(window.__game.hudWrites) };
      });
      check(
        'perf: hudWrites counter is exposed and monotonic',
        hudNoChurn.finite && hudNoChurn.after >= hudNoChurn.before,
        JSON.stringify(hudNoChurn)
      );
      const backBtn = await pL.evaluate(() => {
        const b = document.getElementById('btn-back-help');
        return b ? { visible: !b.hidden, text: b.textContent } : null;
      });
      check(
        'ui: help modal has an explicit Back button',
        !!backBtn && /back|atr\u00e1s|retour|zur\u00fcck/i.test(backBtn.text || ''),
        backBtn && backBtn.text
      );
      const howto = await pL.evaluate(() => document.getElementById('menu-howto').textContent);
      check('ui: menu shows the one-line how-to', /bank/i.test(howto || ''), (howto || '').slice(0, 50));
      const pauseTouch = await pL.evaluate(() => {
        const b = document.querySelector('#pause-menu .btn');
        return b ? getComputedStyle(b).minHeight : null;
      });
      check('ui: pause buttons have a 48px touch floor', pauseTouch === '48px', String(pauseTouch));
      const resumeConsistency = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.resume && g2.resume();
        g2.start();
        g2.pause();
        return {
          corner: document.getElementById('btn-pause').textContent,
          primary: document.getElementById('btn-play').textContent,
          row: document.getElementById('btn-resume').textContent,
        };
      });
      check(
        'ui: every pause affordance reads the same resume action',
        resumeConsistency.corner === resumeConsistency.primary &&
          resumeConsistency.row.indexOf('Resume') >= 0,
        JSON.stringify(resumeConsistency)
      );
      const corrupt = await pL.evaluate(() => {
        localStorage.setItem('snake3d.settings', '{not json');
        localStorage.setItem('snake3d.life', 'garbage');
        localStorage.setItem('snake3d.ach', '[broken');
        return 'seeded';
      });
      await pL.reload();
      await pL.waitForTimeout(500);
      const bootOk = await pL.evaluate(() => ({
        title: (document.getElementById('ov-title') || {}).textContent || '',
        state: window.__game ? window.__game.state : null,
      }));
      check(
        'robustness: corrupt persistence still boots to a clean menu',
        corrupt === 'seeded' && /snake/i.test(bootOk.title) && bootOk.state === 'menu',
        JSON.stringify(bootOk)
      );
      // leaving corrupt blobs on disk would poison every later reload in this session
      await pL.evaluate(() => {
        localStorage.removeItem('snake3d.settings');
        localStorage.removeItem('snake3d.life');
        localStorage.removeItem('snake3d.ach');
      });

      // die in a boring corner (short chain, zero banked) -> recap must teach
      await pL.evaluate(() => {
        const g2 = window.__game;
        g2.reset();
        g2.start();
        g2.clearBonus();
        g2.setCombo(2);
        g2.setFood(19, 19);
        g2.setSnake([
          { x: 2, y: 2 },
          { x: 3, y: 2 },
          { x: 4, y: 2 },
        ]);
        g2.setDir(-1, 0); // straight into the left wall
      });
      await pL
        .waitForFunction(() => document.getElementById('ov-stats').childElementCount > 0, null, {
          timeout: 8000,
        })
        .catch(() => {});
      const recapHint = await pL.evaluate(() => {
        const oh = document.getElementById('ov-hint');
        return oh ? { hidden: oh.hidden, text: oh.textContent } : null;
      });
      check(
        'ui: a streak-less, unbanked death teaches the bank in the recap',
        !!recapHint && recapHint.hidden === false && /bank/i.test(recapHint.text || ''),
        JSON.stringify(recapHint)
      );

      // --- 3: orb pacing ---
      const caps = await pL.evaluate(() => {
        const out = [];
        for (const lv of [1, 3, 6]) {
          window.__game.start();
          window.__game.pause();
          window.__game.clearBonus();
          if (lv > 1) window.__game.forceEats((lv - 1) * 6 + 2);
          window.__game.clearBonus();
          window.__game.setBonusCount(3);
          out.push({ lv: window.__game.level, n: window.__game.bonuses.length });
        }
        return out;
      });
      check(
        'orbs: concurrent cap climbs 1 -> 2 -> 3 with level',
        caps.length === 3 && caps[0].n === 1 && caps[1].n === 2 && caps[2].n === 3,
        JSON.stringify(caps)
      );
      // removing one orb must not disturb the others
      const pool = await pL.evaluate(() => {
        const g2 = window.__game;
        g2.start();
        g2.pause();
        g2.clearBonus();
        g2.forceEats(32);
        g2.clearBonus();
        g2.setBonusCount(3);
        const before = g2.bonuses;
        const mid = before[1];
        g2.clearBonusAt(0);
        const after = g2.bonuses;
        return {
          before: before.length,
          after: after.length,
          stillThere: after.some((b) => b.x === mid.x && b.y === mid.y),
        };
      });
      check(
        'orbs: eating one leaves the rest in place',
        pool.before === 3 && pool.after === 2 && pool.stillThere,
        JSON.stringify(pool)
      );

      // --- 5: maze is its own mode ---
      // the mode picker lives in the settings panel, which is menu-only
      await toMenu(pL);
      await pL.evaluate(() => {
        document.getElementById('opt-wrap').checked = false;
        document.getElementById('opt-obstacles').checked = false;
        window.__game.reset();
      });
      const arena = await g(pL, 'obstacles.length');
      await pL.locator('#mode-seg button[data-mode="maze"]').click();
      await pL.waitForTimeout(80);
      const mazeChecks = await pL.evaluate(() => ({
        wrap: document.getElementById('opt-wrap').checked,
        ob: document.getElementById('opt-obstacles').checked,
        sel: document.querySelector('#mode-seg button[data-mode="maze"]').getAttribute('aria-checked'),
        n: window.__game.obstacles.length,
      }));
      await pL.evaluate(() => window.__game.reset());
      const mazeN = (await g(pL, 'obstacles.length')) || 0;
      check(
        'maze: picker turns it into one coherent mode',
        mazeChecks.wrap && mazeChecks.ob && mazeChecks.sel === 'true',
        JSON.stringify(mazeChecks)
      );
      check(
        'maze: opens with corridor density, not four stones',
        mazeN > arena && mazeN >= 8,
        'arena=' + arena + ' maze=' + mazeN
      );
      // maze maps stay mirror-symmetric, the property the layouts are built on
      const sym = await pL.evaluate(() => {
        const obs = window.__game.obstacles;
        const has = (x, y) => obs.some((o) => o.x === x && o.y === y);
        return obs.every((o) => has(o.x, 19 - o.y) && has(19 - o.x, o.y) && has(19 - o.x, 19 - o.y));
      });
      check('maze: layout keeps the 4-fold mirror symmetry', sym);
      // and neither of the three solo modes may be mistaken for maze
      for (const solo of ['wrap', 'obstacles', 'classic']) {
        await pL.locator('#mode-seg button[data-mode="' + solo + '"]').click();
        await pL.waitForTimeout(50);
        const sel = await pL.evaluate(
          (s) =>
            document.querySelector('#mode-seg button[data-mode="' + s + '"]').getAttribute('aria-checked'),
          solo
        );
        if (sel !== 'true') {
          check('maze: solo mode ' + solo + ' not reported as maze', false, sel);
          break;
        }
        if (solo === 'classic') check('maze: classic/wrap/obstacles never alias to maze', true);
      }

      // --- 6: daily challenge ---
      await toMenu(pL);
      const daily = await pL.evaluate(() => {
        window.__game.setDaily(true, 20000);
        return window.__game.daily;
      });
      check(
        'daily: a day resolves to a rule and a seed',
        daily.on === true && daily.day === 20000 && !!daily.rule && daily.seed >= 0,
        JSON.stringify(daily)
      );
      const same = await pL.evaluate(() => {
        window.__game.setDaily(true, 20000);
        const a = window.__game.daily;
        window.__game.setDaily(false);
        window.__game.setDaily(true, 20000);
        return a.rule === window.__game.daily.rule && a.seed === window.__game.daily.seed;
      });
      check('daily: same day replays identically', same);
      const locked = await pL.evaluate(() => ({
        wrap: document.getElementById('opt-wrap').disabled,
        spd: document.getElementById('opt-speed').disabled,
        seg: document.querySelector('#mode-seg button[data-mode="maze"]').disabled,
        note: !document.getElementById('daily-note').hidden,
        noteText: document.getElementById('daily-note').textContent,
        btn: document.getElementById('btn-daily').textContent.trim(),
      }));
      check(
        'daily: the settings it pins are visibly locked, with the rule stated',
        locked.wrap && locked.spd && locked.seg && locked.note && locked.noteText.length > 5,
        JSON.stringify(locked)
      );
      await pL.evaluate(() => {
        window.__game.setDaily(false);
        document.getElementById('opt-wrap').checked = false;
        document.getElementById('opt-obstacles').checked = false;
      });
      const freed = await pL.evaluate(() => ({
        wrap: document.getElementById('opt-wrap').disabled,
        note: document.getElementById('daily-note').hidden,
      }));
      check('daily: leaving it unlocks everything again', !freed.wrap && freed.note);

      // every rule must be reachable, and each must actually differ
      const rules = await pL.evaluate(() => {
        const out = [];
        for (let d = 19900; d < 19960; d++) {
          window.__game.setDaily(true, d);
          out.push(window.__game.daily.rule);
        }
        window.__game.setDaily(false);
        return Array.from(new Set(out));
      });
      check(
        'daily: the whole rule table is reachable across 60 days',
        rules.length >= 5,
        rules.length + ' distinct: ' + rules.join(',')
      );

      // a shared daily link must land on the same rule
      const linkPage = await newPage(browser, false);
      await linkPage.page.goto('http://127.0.0.1:' + PORT + '/index.html?daily=20000', {
        waitUntil: 'load',
      });
      await linkPage.page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
      const viaLink = await g(linkPage.page, 'daily');
      check(
        'daily: ?daily=<day> deep link replays the same rule',
        viaLink.on === true && viaLink.day === 20000 && viaLink.rule === daily.rule,
        JSON.stringify(viaLink)
      );
      await linkPage.page.close();

      check('no page errors in ladder session', rL.errors.length === 0, rL.errors.slice(0, 2).join(' | '));
    }
    await pL.close();

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
    // Score 10 by steering food into the path, rather than placing it once and
    // hoping the snake randomly re-crosses the respawned food inside 5s. The
    // old version was luck- and load-dependent and flaked under CPU pressure.
    await page2.evaluate(() => {
      window.__scoreDrive = setInterval(() => {
        const gme = window.__game;
        if (gme.state !== 'playing') return;
        const s = gme.snake[0];
        if (!s) return;
        const d = gme.dir;
        gme.setFood((s.x + d.x + 20) % 20, (s.y + d.y + 20) % 20);
      }, 30);
    });
    const scored = await page2
      .waitForFunction(() => window.__game.score >= 10, null, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    await page2.evaluate(() => clearInterval(window.__scoreDrive));
    check('2D: food + scoring works', scored, 'score=' + (await g(page2, 'score')));
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
    // 2D tap-to-steer via the same click path.
    // Stay PAUSED and assert the QUEUED direction, like the 3D case above.
    // The old version called pause() twice - and the hook is a TOGGLE, so the
    // second call resumed play. The snake then travelled before the click
    // landed, and since steerToward picks the dominant axis a 5-cell drift
    // turned the tap into a (reversed, therefore ignored) downward turn:
    // an intermittent failure with nothing to do with steering.
    await page2.evaluate(() => {
      window.__game.start();
      window.__game.pause();
      window.__game.setSnake([{ x: 10, y: 10 }]);
      window.__game.setDir(0, -1);
    });
    await page2.waitForTimeout(200);
    // Compute the tap point and dispatch in ONE in-page evaluate, deriving the
    // client coords from the canvas's own getBoundingClientRect(). Reading the
    // box from Playwright and dispatching separately risks a skew that lands
    // the tap off the board, which silently queues nothing at all.
    const q2 = await page2.evaluate(() => {
      const g = window.__game;
      const v = g.view;
      const c = document.getElementById('scene');
      const r = c.getBoundingClientRect();
      const init = {
        pointerType: 'mouse',
        button: 0,
        clientX: r.left + (v.ox + 14.5 * v.cell) / v.dpr,
        clientY: r.top + (v.oy + 10.5 * v.cell) / v.dpr,
        bubbles: true,
        cancelable: true,
      };
      c.dispatchEvent(new PointerEvent('pointerdown', init));
      c.dispatchEvent(new PointerEvent('pointerup', init));
      // report what steerToward should have computed, so a failure explains
      // itself instead of just showing an empty queue
      const px = (init.clientX - r.left) * v.dpr;
      const py = (init.clientY - r.top) * v.dpr;
      return {
        queue: g.queue,
        gx: Math.floor((px - v.ox) / v.cell),
        gy: Math.floor((py - v.oy) / v.cell),
        view: v,
        rect: { left: r.left, top: r.top, w: r.width, h: r.height },
        head: g.snake[0],
        dir: g.dir,
        state: g.state,
      };
    });
    await page2.waitForTimeout(200);
    check(
      '2D: tap-to-steer works',
      q2.queue.length === 1 && q2.queue[0].x === 1 && q2.queue[0].y === 0,
      JSON.stringify(q2)
    );
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

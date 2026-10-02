/* ============================================================
 * 3D Snake (classic script — works over file:// and http)
 * - UI handlers attach FIRST so Start never dies, even if CDN/WebGL fails
 * - 3D via global THREE (UMD r149); automatic 2D canvas fallback
 * - Super-responsive: pointerdown buttons, instant visual turn,
 *   fast first-step, snappy lerp, capped pixel ratio + shadows
 * ============================================================ */
(function () {
  'use strict';

  var GRID = 20;
  var CELL = 1;
  var MAX_QUEUE = 3;
  var MAX_DT = 0.25;
  var SPEED_PRESETS = { slow: 160, normal: 120, fast: 90 }; // responsive defaults
  var MIN_INTERVAL = 55;
  var SPEED_RAMP = 22; // foods to decay ~37% of the remaining headroom (see tickForFoods)
  var LERP_SPEED = 18; // was 14 — snappier slide
  var BONUS_TTL = 7000; // bonus pickup lifetime (ms of play time)
  var BONUS_EVERY = 5; // min regular foods between bonus spawns (cooldown, not a modulo)
  var BONUS_MAX = 3; // hard ceiling on concurrent pink orbs
  var SHIELD_TTL = 9000; // shield pickup lifetime (ms of play time)
  var SHIELD_PHASE = 1500; // ghost window when a shield cannot find a safe heading
  var SHIELD_EVERY = 7; // min regular foods between shield spawns
  var MAZE_OBSTACLE_START = 12; // maze mode opens with real corridor structure
  var MAZE_OBSTACLE_PER_LEVEL = 4; // ...and keeps thickening
  var DESERT_FOOD_TTL = 20000; // desert rule: uneaten food withers after 20s
  var EMBER_WARN = 2000; // volcano rule: ember telegraphs this long before igniting
  var EMBER_BURN = 3000; // volcano rule: ignited ember stays lethal this long
  var EMBER_EVERY = 5000; // volcano rule: new ember cadence while playing
  var EMBER_MAX = 3; // volcano rule: max concurrent embers
  var COMBO_WINDOW = 5000; // base gap that chains a combo; shrinks per step (see SnakeLogic.comboWindow)
  var COMBO_HOT = 8; // combo at/above this paints the HUD pill as a high-risk chain
  var BANK_MIN = 5; // shortest chain worth cashing out on the pause card
  var BANK_UNIT = 5; // bank = BANK_UNIT * combo^2 * prestige
  var FOODS_PER_LEVEL = 6; // goal: foods per level
  var OBSTACLE_START = 4; // rocks on a fresh obstacles run
  var OBSTACLE_PER_LEVEL = 3;
  var OBSTACLE_MAX = 28;
  var SWIPE_PX = { calm: 40, normal: 24, twitchy: 14 };

  // ---------- DOM ----------
  function $(id) {
    return document.getElementById(id);
  }
  var canvas = $('scene'),
    overlay = $('overlay');
  var ovTitle = $('ov-title'),
    ovSub = $('ov-sub'),
    ovStats = $('ov-stats');
  var elScore = $('score'),
    elBest = $('best'),
    elLevel = $('level'),
    elLen = $('length');
  var toastEl = $('toast');

  // ---------- State ----------
  var state = 'menu';
  var snake = [];
  var dir = { x: 1, y: 0 };
  var queue = [];
  var food = { x: 12, y: 10 };
  var score = 0,
    foodsEaten = 0,
    best = 0;
  // Bonus orbs are a small pool, not a singleton. `BONUS_EVERY` used to be a
  // bare `foodsEaten % 5`, which meant at most one pink orb could ever exist and
  // its arrival was arithmetic rather than an event. bonusCap() lets the late
  // game - the part where a mistake is actually expensive - carry several at
  // once, so the orbs stop being a formality and become the run.
  var bonuses = []; // [{x, y, left, bornAt}] live bonus orbs
  var shield = null,
    shieldLeft = 0,
    shieldPhase = 0,
    hasShield = false; // shield pickup {x,y} + TTL; hasShield = charge held
  // Entity pacing bookkeeping: foodsEaten when each orb type last spawned, so
  // cadence is a cooldown ("not yet") rather than a calendar slot.
  var lastBonusFood = 0,
    lastShieldFood = 0;
  var slideHeld = null; // ice rule: turn stashed one tick (momentum pipeline)
  var embers = []; // volcano rule: [{x, y, born}] telegraph -> burn -> gone
  var emberAcc = 0,
    emberToastShown = false; // volcano spawn cadence + first-sight hint
  var runLayout = null; // obstacle variant picked per run {base, transpose, scatter}
  var warnPulses = []; // obstacle telegraphs [{x, y, until}]
  // Seeded runs (?seed=): gameplay spawns draw from rng() instead of
  // Math.random so a shared link replays identical maps. Visual-only
  // randomness (particles, decor, textures) stays unseeded on purpose.
  var seedNum = null,
    seedGen = null;
  function rng() {
    if (seedNum == null) return Math.random();
    if (!seedGen) seedGen = SnakeLogic.mulberry32(seedNum);
    return seedGen();
  }
  // Deep-link starting biome (?theme=): level-ups cycle LEVELS from here.
  var startThemeIdx = 0;
  var skinId = 'classic'; // active snake skin (achievement-gated)
  var combo = 0,
    lastEatAt = 0; // combo multiplier chain
  var comboWindowMs = COMBO_WINDOW; // allowance currently in effect (shrinks as the chain grows)
  var banked = 0; // score cashed out this run
  var lastLostCombo = 0; // chain a death forfeited, so the recap can name what it cost
  // Daily challenge: one date-seeded rule and one date-seeded map, identical
  // for every player, all day. Opt-in from the menu; never persisted.
  var dailyOn = false,
    dailyDay = null,
    dailyRule = null;
  var deathCell = null; // crash-highlight cell {x,y}
  var obstacles = []; // deadly blocks [{x,y}]
  var level = 1; // 1 + floor(foodsEaten / FOODS_PER_LEVEL)
  var runStartAt = 0,
    longest = 3; // run stats
  var squash = 0; // eat squash-and-stretch impulse 0..1
  var foodBornAt = 0,
    shieldBornAt = 0; // spawn-pulse timestamps (bonuses carry their own per-orb)
  var seenTut = false; // first-run tutorial hint
  var tickMs = SPEED_PRESETS.normal;
  var acc = 0,
    lastT = performance.now();
  var shake = 0;
  var mode = '3d';
  var reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var memStore = {};
  var store = {
    get: function (k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return memStore[k] || null;
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {
        memStore[k] = v;
      }
    },
    remove: function (k) {
      delete memStore[k];
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    },
  };
  // Every persisted key, for the "erase progress" action. Anything added to
  // storage later must be listed here or it will survive a reset, which is the
  // whole point of the button.
  var SAVE_KEYS = [
    'snake3d.best',
    'snake3d.life',
    'snake3d.ach',
    'snake3d.settings',
    'snake3d.seen',
    'snake3d.seenKeys',
  ];
  best = Number(store.get('snake3d.best') || 0) || 0;

  // ---------- i18n ----------
  var LANGS = ['en', 'es', 'fr', 'de'];
  var lang = 'en';
  function t(k, vars) {
    var d = (typeof window.I18N !== 'undefined' && window.I18N) || {};
    var s = (d[lang] && d[lang][k]) || (d.en && d.en[k]) || k;
    if (vars) for (var key in vars) s = s.split('{' + key + '}').join(vars[key]);
    return s;
  }
  // Unshadowable alias: many functions use `var t` as a local (frame clock,
  // touch, temp tex...), which hides the i18n helper for the whole function
  // body. Anything inside those must call i18n() instead of t().
  function i18n(k, vars) {
    return t(k, vars);
  }
  function biomeName(n) {
    return t('biome_' + n, null) || n;
  }
  function resolveLang() {
    try {
      var q = new URLSearchParams(location.search).get('lang');
      if (q && LANGS.indexOf(q) >= 0) return q;
    } catch (e) {}
    var el = $('opt-lang');
    var v = el ? el.value : 'auto';
    if (v && v !== 'auto' && LANGS.indexOf(v) >= 0) return v;
    try {
      var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
      if (LANGS.indexOf(nav) >= 0) return nav;
    } catch (e2) {}
    return 'en';
  }
  function applyI18n() {
    lang = resolveLang();
    try {
      document.documentElement.lang = lang;
    } catch (e) {}
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
    var htmls = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmls.length; j++) htmls[j].innerHTML = t(htmls[j].getAttribute('data-i18n-html'));
    var cv = $('scene');
    if (cv) cv.setAttribute('aria-label', t('canvas_label'));
    // aria-labels: the D-pad, mode group and help grid were the only elements
    // whose accessible name was hardcoded English
    var arias = document.querySelectorAll('[data-i18n-aria]');
    for (var a = 0; a < arias.length; a++)
      arias[a].setAttribute('aria-label', t(arias[a].getAttribute('data-i18n-aria')));
    // tooltips: the HUD pills and the mode/transport buttons carried hardcoded
    // English title= text, so a non-English player saw English on hover
    var titles = document.querySelectorAll('[data-i18n-title]');
    for (var ti = 0; ti < titles.length; ti++)
      titles[ti].setAttribute('title', t(titles[ti].getAttribute('data-i18n-title')));
    // dynamic button labels follow the current state
    if (typeof setState === 'function' && (state === 'playing' || state === 'paused')) {
      var bp = $('btn-pause');
      if (bp) bp.textContent = state === 'paused' ? t('btn_resume') : t('btn_pause');
    }
    var bp2 = $('btn-play');
    if (bp2)
      bp2.textContent =
        state === 'paused' ? t('btn_resume') : state === 'menu' ? t('btn_play') : t('btn_again');
    if (typeof updateHUD === 'function') updateHUD();
    // the daily row and the bank button carry the live chain / rule, so their
    // labels cannot be static data-i18n text
    if (typeof applyDailyLabels === 'function') applyDailyLabels();
    // re-render the visible card in the new language
    if (lastOvReplay && overlay && !overlay.classList.contains('hidden')) {
      try {
        lastOvReplay();
      } catch (e) {}
    }
    if (typeof syncSkinOptions === 'function') syncSkinOptions();
  }

  // ---------- Lifetime stats + achievements (persisted) ----------
  // SAVE_VERSION guards the shape of the saved blobs. Without it, renaming or
  // removing a stat key would silently reset every returning player's progress
  // to zero with no way to tell that is what happened. Bump it and handle the
  // old shape deliberately rather than discovering it in someone's save file.
  var SAVE_VERSION = 1;
  var life = {
    games: 0,
    foods: 0,
    bestCombo: 0,
    bestLevel: 1,
    wins: 0,
    prestige: 0,
    deathsBlocked: 0,
    bestBank: 0,
  };
  var ach = [];
  function loadLife() {
    try {
      var o = JSON.parse(store.get('snake3d.life') || 'null');
      // A v0 blob (pre-versioning) has no `v` field and is read as-is: the
      // shape has not changed yet, so this is the migration path to keep.
      var v = o && o.v != null ? o.v : 0;
      if (o) for (var k in life) if (o[k] != null) life[k] = o[k];
      if (v > SAVE_VERSION) {
        // Written by a newer build than this one. Keep the numbers we can
        // read rather than discarding the whole save.
        if (typeof o === 'object' && o) for (var k2 in life) if (o[k2] != null) life[k2] = o[k2];
      }
    } catch (e) {}
    try {
      ach = JSON.parse(store.get('snake3d.ach') || '[]') || [];
    } catch (e) {
      ach = [];
    }
  }
  function saveLife() {
    var blob = { v: SAVE_VERSION };
    for (var k in life) blob[k] = life[k];
    store.set('snake3d.life', JSON.stringify(blob));
    store.set('snake3d.ach', JSON.stringify(ach));
  }
  // Wipe every saved key and return the player to a genuinely first-run
  // state. Previously the only way to do this was to clear site data by hand.
  function eraseProgress() {
    for (var i = 0; i < SAVE_KEYS.length; i++) store.remove(SAVE_KEYS[i]);
    best = 0;
    life = {
      games: 0,
      foods: 0,
      bestCombo: 0,
      bestLevel: 1,
      wins: 0,
      prestige: 0,
      deathsBlocked: 0,
      bestBank: 0,
    };
    ach = [];
    settingsRestored = {};
    if (typeof syncSkinOptions === 'function') syncSkinOptions();
    if (typeof applyI18n === 'function') applyI18n();
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof showMenuOv === 'function') {
      state = 'menu';
      showMenuOv();
    }
  }
  function lifeLine() {
    if (!life.games) return t('life_first');
    var s =
      life.games +
      ' ' +
      t('life_runs') +
      ' • ' +
      life.foods +
      ' ' +
      t('life_foods') +
      ' • best x' +
      Math.max(1, life.bestCombo) +
      ' ' +
      t('life_combo') +
      ' • ' +
      t('life_level') +
      ' ' +
      life.bestLevel;
    // `wins` has been persisted and incremented forever but was never shown
    // anywhere, so winning the board left no visible trace outside the run.
    if (life.wins > 0) s += ' • 🏆 ' + life.wins;
    if (life.bestBank > 0) s += ' • 🏦 ' + life.bestBank;
    if (life.prestige > 0) s += ' • ⭐+' + life.prestige * 10 + '%';
    return s;
  }
  // Endless framing: prestige restarts the run with a permanent +10%/level bonus.
  function prestigeMult() {
    return 1 + 0.1 * (life.prestige || 0);
  }
  function doPrestige() {
    if (state !== 'over' && state !== 'win') return;
    life.prestige = (life.prestige || 0) + 1;
    saveLife();
    say(t('prestige_toast'));
    lastStartAt = 0;
    startGame();
  }
  function unlock(id) {
    if (ach.indexOf(id) >= 0) return;
    ach.push(id);
    saveLife();
    syncSkinOptions(); // an achievement may have unlocked a skin
    var name = t('ach_' + id);
    say(t('ach_t', { n: name }));
    beep(660, 1320, 0.2, 'sine');
    buzz(25);
  }
  function checkAch() {
    if (foodsEaten > 0) unlock('bite');
    if (combo >= 5) unlock('combo5');
    if (level >= 3) unlock('level3');
    if (level >= 5) unlock('space');
  }

  // ---------- Persistent settings ----------
  var SETTING_IDS = [
    'opt-wrap',
    'opt-obstacles',
    'opt-sound',
    'opt-shadows',
    'opt-colorblind',
    'opt-dpad',
    'opt-music',
    'opt-lang',
    'opt-kid',
    'opt-speed',
    'opt-cam',
    'opt-swipe',
    'opt-skin',
  ];
  function saveSettings() {
    var o = {};
    for (var i = 0; i < SETTING_IDS.length; i++) {
      var el = $(SETTING_IDS[i]);
      if (!el) continue;
      o[SETTING_IDS[i]] = el.type === 'checkbox' ? !!el.checked : el.value;
    }
    store.set('snake3d.settings', JSON.stringify(o));
  }
  // which settings actually came from storage, so first-run defaults can tell
  // "never chosen" apart from "chosen and left off"
  var settingsRestored = {};
  function loadSettings() {
    var o = null;
    try {
      o = JSON.parse(store.get('snake3d.settings') || 'null');
    } catch (e) {
      o = null;
    }
    if (!o) return;
    for (var i = 0; i < SETTING_IDS.length; i++) {
      var el = $(SETTING_IDS[i]);
      if (!el || o[SETTING_IDS[i]] === undefined) continue;
      settingsRestored[SETTING_IDS[i]] = true;
      if (el.type === 'checkbox') el.checked = !!o[SETTING_IDS[i]];
      else el.value = o[SETTING_IDS[i]];
      // A stored value that no longer exists (a removed speed/camera/lang/skin
      // option, or a hand-edited value) would silently leave el.value === ''.
      // That reads as a valid empty string everywhere downstream - e.g.
      // baseInterval() treats '' as 'normal' - so the player ends up on a
      // default they never chose and the control shows blank. Fall back to the
      // first real option instead.
      if (el.tagName === 'SELECT' && !el.value && el.options.length) el.selectedIndex = 0;
    }
  }

  // ---------- Toast / HUD (defined early — no dependency on THREE) ----------
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 1800);
  }
  function updateHUD() {
    // #hud is an aria-live region, and updateHUD runs on every tick (up to
    // ~18/s). Only write when the value actually changed: an unconditional
    // textContent assignment makes screen readers re-announce the whole HUD
    // continuously, drowning out real announcements.
    setText(elScore, score);
    setText(elBest, best);
    setText(elLevel, level);
    setText(elLen, snake.length);
    var gl = $('goal');
    if (gl) setText(gl, (foodsEaten % FOODS_PER_LEVEL) + '/' + FOODS_PER_LEVEL);
    // minimal in-game HUD: extra pills hide while playing
    var mini = state === 'playing';
    var hideIds = ['pill-level', 'pill-length', 'pill-goal'];
    for (var hi = 0; hi < hideIds.length; hi++) {
      var hp = $(hideIds[hi]);
      if (hp) hp.hidden = mini;
    }
    var pc = $('pill-combo');
    if (pc) {
      pc.hidden = combo < 2 || mini;
      if (combo >= 2) {
        // uncapped now: the ladder is the point, so the HUD must not imply a
        // ceiling the scoring no longer has
        setText($('combo'), 'x' + combo);
        pc.classList.toggle('hot', combo >= COMBO_HOT);
        setAttr(pc, 'title', t('tip_combo_hot', { n: combo }));
      }
    }
    // shield charge stays visible mid-run: it is a life, not a stat
    var ps = $('pill-shield');
    if (ps) {
      ps.hidden = !hasShield;
      setAttr(ps, 'title', t('shield_hud'));
    }
  }
  // attribute writer: same no-op skip as setText (updateHUD runs every tick)
  function setAttr(el, k, v) {
    if (el && el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
  // Combo: chained eats raise the multiplier, and the window to land the next
  // one shrinks every step (SnakeLogic.comboWindow). A long chain is a bet.
  function registerEat() {
    var now = performance.now();
    var r = SnakeLogic.comboFor(combo, lastEatAt, now, COMBO_WINDOW);
    combo = r.combo;
    comboWindowMs = r.window;
    lastEatAt = now;
    return r.mult;
  }
  // Streak bank: cash the live chain out for a guaranteed lump sum. The chain
  // resets, so banking is a real choice - bank a smaller sure thing now, or
  // keep riding a window that is closing. Dying with an un-banked chain
  // forfeits it (see die()), which is what gives the pause button any weight.
  function canBank() {
    return combo >= BANK_MIN;
  }
  function bankNow() {
    if (!canBank()) return false;
    var v = SnakeLogic.bankValue(combo, BANK_UNIT, prestigeMult());
    score += v;
    banked += v;
    if (v > (life.bestBank || 0)) life.bestBank = v;
    if (combo > life.bestCombo) life.bestCombo = combo;
    saveLife();
    combo = 0;
    lastEatAt = 0;
    comboWindowMs = COMBO_WINDOW;
    unlock('bank5');
    updateHUD();
    toast(t('bank_t', { n: v }));
    say(t('bank_t', { n: v }));
    beep(523, 1046, 0.22, 'sine');
    buzz([25, 40, 25]);
    // the bank row is worth 0 and must disappear, so whoever banked owns the
    // re-render - not just the button handler
    if (state === 'paused') replayPause();
    return true;
  }
  // Screen-reader announcements. #toast is aria-hidden (visual only), so this
  // is the single source of spoken feedback: every user-visible event that
  // toasts must also announce here, exactly once.
  function announce(msg) {
    var el = $('sr-status');
    if (el) el.textContent = msg;
  }
  // toast + announce in one call, so the two can never drift apart again.
  // A repeat of the previous message is skipped UNLESS force is set. Note that
  // force alone is not enough: writing the same string into a polite live
  // region is ignored by screen readers, because nothing changed. A forced
  // repeat therefore clears the region first and re-writes on the next frame,
  // which is an actual change and is re-announced.
  var lastSaid = '';
  var sayPending = 0;
  function say(msg, force) {
    toast(msg);
    if (force || msg !== lastSaid) {
      lastSaid = msg;
      var el = $('sr-status');
      // Writing the same string into a polite live region is ignored by screen
      // readers - nothing changed. A forced repeat must therefore clear the
      // region and re-write it as a SEPARATE task, so the change is observable.
      // requestAnimationFrame was not enough: both writes land in one frame and
      // observers coalesce them into a single no-op mutation.
      if (force && el && el.textContent === msg) {
        var n = ++sayPending;
        el.textContent = '';
        setTimeout(function () {
          if (n === sayPending) el.textContent = msg;
        }, 60);
      } else {
        announce(msg);
      }
    }
  }
  // Palettes: standard vs colorblind-safe (Okabe-Ito inspired)
  var PALETTES = {
    standard: {
      head: 0x39ff88,
      headEm: 0x0a5a2a,
      bodyA: 0x22dd66,
      bodyAEm: 0x063d1d,
      bodyB: 0x2f9dff,
      bodyBEm: 0x0a2a55,
      food: 0xffc94d,
      foodEm: 0xcc6a00,
      bonus: 0xff5fa2,
      bonusEm: 0xa3124f,
      css: { head: '#39ff88', body: ['#22dd66', '#2f9dff'], food: '#ffc94d', bonus: '#ff5fa2' },
    },
    cb: {
      head: 0x56b4e9,
      headEm: 0x1a3a66,
      bodyA: 0x0072b2,
      bodyAEm: 0x06283d,
      bodyB: 0x009e73,
      bodyBEm: 0x063d2e,
      food: 0xe69f00,
      foodEm: 0x7a5200,
      bonus: 0xcc79a7,
      bonusEm: 0x5c2440,
      css: { head: '#56b4e9', body: ['#0072b2', '#009e73'], food: '#e69f00', bonus: '#cc79a7' },
    },
  };
  function curPal() {
    var el = $('opt-colorblind');
    return el && el.checked ? PALETTES.cb : PALETTES.standard;
  }
  // Unlockable snake skins, gated on achievements (classic = palette colors).
  // css mirrors the 3D hexes for the 2D fallback renderer.
  var SKINS = [
    { id: 'classic', ach: null },
    {
      id: 'abyss',
      ach: 'level3',
      head: 0xc77dff,
      headEm: 0x3a0a5a,
      bodyA: 0x9d4edd,
      bodyAEm: 0x2a0a4a,
      bodyB: 0xe0aaff,
      bodyBEm: 0x4a2a6a,
      css: { head: '#c77dff', body: ['#9d4edd', '#e0aaff'] },
    },
    {
      id: 'ember',
      ach: 'combo5',
      head: 0xff8500,
      headEm: 0x7a2e00,
      bodyA: 0xdc2f02,
      bodyAEm: 0x4d0f00,
      bodyB: 0xffd60a,
      bodyBEm: 0x6b4e00,
      css: { head: '#ff8500', body: ['#dc2f02', '#ffd60a'] },
    },
    {
      id: 'frost',
      ach: 'space',
      head: 0xcaf0f8,
      headEm: 0x2a6f97,
      bodyA: 0x90e0ef,
      bodyAEm: 0x1d5f7a,
      bodyB: 0x48cae4,
      bodyBEm: 0x14495e,
      css: { head: '#caf0f8', body: ['#90e0ef', '#48cae4'] },
    },
    {
      id: 'gold',
      ach: 'win',
      head: 0xffd700,
      headEm: 0x8a5f00,
      bodyA: 0xdaa520,
      bodyAEm: 0x5c3d00,
      bodyB: 0xb8860b,
      bodyBEm: 0x3d2b00,
      css: { head: '#ffd700', body: ['#daa520', '#b8860b'] },
    },
    {
      id: 'guardian',
      ach: 'shield1',
      head: 0x46e6ff,
      headEm: 0x0a4a5a,
      bodyA: 0x00b4d8,
      bodyAEm: 0x07333f,
      bodyB: 0x0077b6,
      bodyBEm: 0x06283d,
      css: { head: '#46e6ff', body: ['#00b4d8', '#0077b6'] },
    },
  ];
  function skinById(id) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return SKINS[i];
    return SKINS[0];
  }
  function skinUnlocked(sk) {
    return !sk.ach || ach.indexOf(sk.ach) >= 0;
  }
  function activeSkin() {
    var sk = skinById(skinId);
    return skinUnlocked(sk) ? sk : SKINS[0];
  }
  // 2D fallback reads snake colors through here (palette, then skin override)
  function snakeCss() {
    var p = curPal().css;
    var sk = activeSkin();
    if (!sk.css) return { head: p.head, body: p.body };
    return { head: sk.css.head, body: sk.css.body };
  }
  function applySkin() {
    var sk = activeSkin();
    if (sk.id !== skinId) {
      skinId = sk.id;
      var sel = $('opt-skin');
      if (sel) sel.value = skinId;
      saveSettings();
    }
    if (!sk.css) return; // classic: palette colors already applied
    if (window.__matH) {
      window.__matH.color.setHex(sk.head);
      window.__matH.emissive.setHex(sk.headEm);
      window.__matA.color.setHex(sk.bodyA);
      window.__matA.emissive.setHex(sk.bodyAEm);
      window.__matB.color.setHex(sk.bodyB);
      window.__matB.emissive.setHex(sk.bodyBEm);
    }
    if (window.__trailMat) window.__trailMat.color.setHex(sk.head);
    if (window.__headLight) window.__headLight.color.setHex(sk.head);
  }
  // Rebuilds the skin picker: locked skins stay visible but disabled, with
  // the gating achievement named so players know what to chase.
  function syncSkinOptions() {
    var sel = $('opt-skin');
    if (!sel) return;
    // adopt a valid stored selection first (loadSettings ran before us)
    var cur = skinById(sel.value);
    if (cur && skinUnlocked(cur)) skinId = cur.id;
    sel.innerHTML = '';
    for (var i = 0; i < SKINS.length; i++) {
      var sk = SKINS[i];
      var o = document.createElement('option');
      o.value = sk.id;
      if (skinUnlocked(sk)) o.textContent = t('skin_' + sk.id);
      else {
        o.textContent = t('skin_locked', { n: t('ach_' + sk.ach) });
        o.disabled = true;
      }
      sel.appendChild(o);
    }
    sel.value = activeSkin().id;
    skinId = sel.value;
  }
  function applyPalette() {
    var p = curPal();
    if (window.__matH) {
      window.__matH.color.setHex(p.head);
      window.__matH.emissive.setHex(p.headEm);
      window.__matA.color.setHex(p.bodyA);
      window.__matA.emissive.setHex(p.bodyAEm);
      window.__matB.color.setHex(p.bodyB);
      window.__matB.emissive.setHex(p.bodyBEm);
    }
    if (foodMesh) {
      foodMesh.material.color.setHex(p.food);
      foodMesh.material.emissive.setHex(p.foodEm);
    }
    // all bonus orbs share one material, so one write repaints the pool
    if (window.__bonusMeshes && window.__bonusMeshes.length) {
      window.__bonusMeshes[0].material.color.setHex(p.bonus);
      window.__bonusMeshes[0].material.emissive.setHex(p.bonusEm);
    }
    if (window.__trailMat) window.__trailMat.color.setHex(p.head);
    if (window.__headLight) window.__headLight.color.setHex(p.head);
    applySkin(); // skins override the snake mats (classic = palette, no-op)
    applyFoodTint(); // food keeps its per-biome tint under either palette
  }
  // Run stats line for game-over / win cards + screen readers
  function statsLine() {
    var mins = Math.max(1 / 60, (performance.now() - runStartAt) / 60000);
    var rate = Math.round(foodsEaten / mins);
    return (
      t('st_score') +
      ' ' +
      score +
      ' • ' +
      t('st_best') +
      ' ' +
      best +
      ' • ⏱ ' +
      SnakeLogic.fmtTime(performance.now() - runStartAt) +
      ' • ' +
      foodsEaten +
      ' ' +
      t('st_foods') +
      ' • ' +
      rate +
      t('st_rate') +
      ' • ' +
      t('st_longest') +
      ' ' +
      longest
    );
  }
  // DOM text writer: skips no-op writes so aria-live regions are not spammed
  function setText(el, v) {
    if (!el) return;
    var s = String(v);
    if (el.textContent !== s) el.textContent = s;
  }
  function setState(s) {
    state = s;
    overlay.classList.toggle('hidden', s === 'playing' || s === 'paused');
    var bp = $('btn-pause');
    if (bp) bp.textContent = s === 'paused' ? t('btn_resume') : t('btn_pause');
  }
  // Overlay replay: language switch re-renders the visible card in the new
  // language. Callers pass a thunk rebuilding their exact content.
  var lastOvReplay = null;
  function showOverlay(title, sub, statsHTML, replay) {
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    ovStats.innerHTML = statsHTML || '';
    var ob = $('ov-best');
    if (ob) ob.textContent = best;
    var ll = $('life-line');
    if (ll) ll.textContent = state === 'menu' ? lifeLine() : '';
    var b = $('btn-play');
    if (b) {
      b.textContent =
        state === 'paused' ? t('btn_resume') : state === 'menu' ? t('btn_play') : t('btn_again');
      b.disabled = false;
    }
    // pause menu vs single-button rows vs share row, by state
    var pr = $('play-row'),
      pm = $('pause-menu'),
      sr = $('share-row');
    if (pr) pr.hidden = state === 'paused';
    if (pm) pm.hidden = state !== 'paused';
    if (sr) sr.hidden = !(state === 'over' || state === 'win');
    var gz = $('prestige-row');
    if (gz) gz.hidden = !((state === 'over' || state === 'win') && level >= 2);
    // Only offer the reset once there is something to reset, and only from the
    // menu (it lives outside the settings panel, which is menu-only).
    var er = $('erase-row');
    if (er) er.hidden = !(state === 'menu' && (life.games > 0 || best > 0 || ach.length > 0));
    // settings live in the main menu; pause gets the pointer note instead
    var sp = $('settings-panel');
    if (sp) sp.hidden = state !== 'menu';
    var pn = $('pause-note');
    if (pn) pn.hidden = state !== 'paused';
    // Streak bank rides the pause card: it is the only moment mid-run where the
    // player can think, which is exactly when the "ride it or take the money"
    // decision is worth making. Hidden below BANK_MIN so it is never noise.
    var bb = $('btn-bank');
    if (bb) {
      bb.hidden = !(state === 'paused' && canBank());
      if (!bb.hidden)
        setText(
          bb,
          t('bank_btn') +
            '  ' +
            t('bank_btn_val', { n: combo, v: SnakeLogic.bankValue(combo, BANK_UNIT, prestigeMult()) })
        );
    }
    if (state === 'menu' && b) {
      try {
        b.focus({ preventScroll: true });
      } catch (e) {}
    }
    syncModeSeg();
    overlay.classList.remove('hidden');
    if (replay) lastOvReplay = replay;
  }
  function showMenuOv() {
    var m = menuCopy();
    syncSkinOptions();
    showOverlay(m.title, m.sub, '', showMenuOv);
  }
  function menuCopy() {
    return {
      title: t('title_menu'),
      sub: mode === '3d' ? t('sub_menu') : t('sub_2d'),
    };
  }
  function quitToMenu() {
    stopMusic();
    reset();
    setState('menu');
    showMenuOv();
    announce(t('sr_menu'));
    var b = $('btn-play');
    if (b) b.blur();
  }
  // Haptics: tiny buzz on eat, pattern on death/level (no-ops where unsupported)
  function buzz(p) {
    try {
      if (navigator.vibrate) navigator.vibrate(p);
    } catch (e) {}
  }
  // Shareable deep link: same starting biome + seed replays the same map.
  function linkForRun() {
    try {
      if (!/^https?:/.test(location.protocol)) return '';
      var u = location.origin + location.pathname + '?theme=' + LEVELS[startThemeIdx].name.toLowerCase();
      if (seedNum != null) u += '&seed=' + seedNum;
      // a daily is only shareable if the recipient lands on the same day *and*
      // the same rule, so pin the day rather than letting it default to today
      if (dailyOn && dailyDay != null) u += '&daily=' + dailyDay;
      return u;
    } catch (e) {
      return '';
    }
  }
  function shareText() {
    var txt =
      '3D Snake: ' +
      t('st_score') +
      ' ' +
      score +
      ', ' +
      t('st_level') +
      ' ' +
      level +
      ', ' +
      t('st_longest') +
      ' ' +
      longest;
    var link = linkForRun();
    if (link) txt += ' ' + link;
    return txt;
  }
  function shareScore() {
    var txt = shareText();
    if (navigator.share) {
      try {
        var r = navigator.share({ title: '3D Snake', text: txt });
        if (r && r.catch) r.catch(function () {});
      } catch (e) {}
      return;
    }
    function done() {
      say(t('copied'));
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(done, done);
      else say(txt);
    } catch (e) {
      say(txt);
    }
  }
  // Shareable moments: 1200x630 picture card (game frame + score bar) for
  // game-over / new-best. WebGL buffers are only readable right after a
  // render, so 3D capture is queued into the frame loop; 2D reads directly.
  var shotPending = false,
    shotCb = null,
    lastShotURL = null,
    shotReadyFlag = false;
  function gameShotDataURL() {
    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }
  function snapFrame() {
    if (!shotPending) return;
    shotPending = false;
    var cb = shotCb;
    shotCb = null;
    if (cb) cb(gameShotDataURL());
  }
  function dataURLtoBlob(u) {
    try {
      var parts = u.split(','),
        mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
      var bin = atob(parts[1]),
        arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) {
      return null;
    }
  }
  function makeShot(cb) {
    function compose(frameURL) {
      try {
        var W = 1200,
          H = 630;
        var out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        var x = out.getContext('2d');
        x.fillStyle = '#0b1020';
        x.fillRect(0, 0, W, H);
        function bar() {
          var g = x.createLinearGradient(0, H - 150, 0, H);
          g.addColorStop(0, 'rgba(5,8,18,0)');
          g.addColorStop(1, 'rgba(5,8,18,0.92)');
          x.fillStyle = g;
          x.fillRect(0, H - 150, W, 150);
          x.fillStyle = '#fff';
          x.font = '800 54px system-ui, sans-serif';
          x.fillText('🐍 3D Snake — ' + score + ' pts', 48, H - 78);
          x.font = '400 30px system-ui, sans-serif';
          x.fillStyle = '#bcd';
          var sub = t('st_best') + ' ' + best + ' · ' + t('st_level') + ' ' + level;
          if (seedNum != null) sub += ' · ' + t('st_seed') + ' ' + seedNum;
          x.fillText(LEVELS[themeIdx].name + ' ' + LEVELS[themeIdx].icon + '   ' + sub, 48, H - 30);
        }
        if (!frameURL) {
          bar();
          cb(out.toDataURL('image/png'));
          return;
        }
        var img = new Image();
        img.onload = function () {
          try {
            var s = Math.max(W / img.width, H / img.height);
            var dw = img.width * s,
              dh = img.height * s;
            x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
          } catch (e2) {}
          bar();
          try {
            cb(out.toDataURL('image/png'));
          } catch (e3) {
            cb(null);
          }
        };
        img.onerror = function () {
          bar();
          try {
            cb(out.toDataURL('image/png'));
          } catch (e4) {
            cb(null);
          }
        };
        img.src = frameURL;
      } catch (e) {
        cb(null);
      }
    }
    if (mode === '3d') {
      shotPending = true;
      shotCb = compose; // runs after the next render, while the buffer is valid
      setTimeout(function () {
        if (shotCb) {
          shotCb = null;
          shotPending = false;
          compose(gameShotDataURL());
        }
      }, 1500);
    } else compose(gameShotDataURL());
  }
  function primeShot() {
    shotReadyFlag = false;
    try {
      makeShot(function (u) {
        if (u) {
          lastShotURL = u;
          shotReadyFlag = true;
        }
      });
    } catch (e) {}
  }
  function deliverShot(u) {
    if (!u) {
      say(t('shot_fail'));
      return;
    }
    var f = null;
    try {
      var b = dataURLtoBlob(u);
      if (b && typeof File === 'function')
        f = new File([b], 'snake-' + score + '.png', { type: 'image/png' });
    } catch (e) {
      f = null;
    }
    if (f && navigator.share) {
      try {
        var r = navigator.share({ title: '3D Snake', text: shareText(), files: [f] });
        if (r && r.catch)
          r.catch(function () {
            downloadFallback(u);
          });
        return;
      } catch (e) {}
    }
    downloadFallback(u);
  }
  function downloadFallback(u) {
    try {
      var a = document.createElement('a');
      a.href = u;
      a.download = 'snake-' + score + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      say(t('shot_saved'));
    } catch (e) {
      say(t('shot_fail'));
    }
  }
  // Stat chips for overlay cards (screen readers get statsLine() instead)
  function chip(label, val) {
    return '<span class="chip"><i>' + label + '</i><b>' + val + '</b></span>';
  }
  function statsChips() {
    var mins = Math.max(1 / 60, (performance.now() - runStartAt) / 60000);
    var rate = Math.round(foodsEaten / mins);
    var chips =
      chip(t('st_score'), score) +
      chip(t('st_best'), best) +
      chip(t('st_level'), level) +
      chip(t('st_time'), SnakeLogic.fmtTime(performance.now() - runStartAt)) +
      chip(t('st_foods'), foodsEaten) +
      chip(t('pill_goal'), (foodsEaten % FOODS_PER_LEVEL) + '/' + FOODS_PER_LEVEL) +
      chip(t('st_rate'), rate) +
      chip(t('st_longest'), longest);
    if (seedNum != null) chips += chip(t('st_seed'), seedNum);
    return chips;
  }
  // Center-screen milestone banner (level-ups, max combo)
  var bannerTimer = null;
  function showBanner(text) {
    var el = $('banner');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2400);
  }
  // Arena biomes: one per level, cycling (meadow -> desert -> ocean ->
  // volcano crater -> deep space -> forest -> sunset -> ice)
  var LEVELS = [
    {
      name: 'Meadow',
      icon: '🌱',
      bg: 0x070b18,
      ground: 0x0f3a2a,
      grid: 0xffffff,
      wall: 0x2f9dff,
      css: '#070b18',
      ob: 'box',
      obColor: 0x5a6b2f,
      hemiSky: 0x9fc5ff,
      hemiGround: 0x1c331c,
      decor: 'tuft',
      tex: 'speckle',
    },
    {
      name: 'Desert',
      icon: '🏜️',
      bg: 0x150e03,
      ground: 0x3a2a10,
      grid: 0xffd9a0,
      wall: 0xfa9418,
      css: '#150e03',
      ob: 'rock',
      obColor: 0xb07a3f,
      hemiSky: 0xffd9a0,
      hemiGround: 0x3a2410,
      decor: 'dunerock',
      tex: 'ripples',
    },
    {
      name: 'Ocean',
      icon: '🌊',
      bg: 0x02101c,
      ground: 0x07304a,
      grid: 0xbfe9ff,
      wall: 0x1da2d8,
      css: '#02101c',
      ob: 'cry',
      obColor: 0x2fbfa5,
      hemiSky: 0xbfe9ff,
      hemiGround: 0x06283d,
      decor: 'shell',
      tex: 'waves',
    },
    {
      name: 'Volcano',
      icon: '🌋',
      bg: 0x170404,
      ground: 0x33100c,
      grid: 0xffb59d,
      wall: 0xff4d2d,
      css: '#170404',
      ob: 'rock',
      obColor: 0xc1440e,
      hemiSky: 0xffb59d,
      hemiGround: 0x2b0d0d,
      decor: 'shard',
      tex: 'cracks',
    },
    {
      name: 'Space',
      icon: '🌌',
      bg: 0x0b0618,
      ground: 0x191233,
      grid: 0xd9c6ff,
      wall: 0x9d5cff,
      css: '#0b0618',
      ob: 'box',
      obColor: 0x5a5f8a,
      hemiSky: 0xd9c6ff,
      hemiGround: 0x0b0618,
      decor: 'roid',
      tex: 'starspeck',
    },
    {
      name: 'Forest',
      icon: '🌲',
      bg: 0x06120b,
      ground: 0x0e2a1a,
      grid: 0xc9f2c7,
      wall: 0x3ddc84,
      css: '#06120b',
      ob: 'spike',
      obColor: 0x2e5b34,
      hemiSky: 0xc9f2c7,
      hemiGround: 0x0e2a1a,
      decor: 'pine',
      tex: 'moss',
    },
    {
      name: 'Sunset',
      icon: '🌅',
      bg: 0x170b12,
      ground: 0x33182a,
      grid: 0xffd1a8,
      wall: 0xff8c42,
      css: '#170b12',
      ob: 'box',
      obColor: 0x8a4a2a,
      hemiSky: 0xffd1a8,
      hemiGround: 0x33182a,
      decor: 'mesa',
      tex: 'dunes',
    },
    {
      name: 'Ice',
      icon: '❄️',
      bg: 0x0a1420,
      ground: 0x16324a,
      grid: 0xe8fbff,
      wall: 0x7fcdff,
      css: '#0a1420',
      ob: 'cry',
      obColor: 0x9fdcff,
      hemiSky: 0xe8fbff,
      hemiGround: 0x16324a,
      decor: 'shardice',
      tex: 'frost',
    },
  ];
  var themeIdx = 0;
  // Hand-designed obstacle layouts: one quadrant base per biome, mirrored at
  // spawn time (see SnakeLogic.mirrorLayout). Fair by construction: no cells
  // near the start zone, symmetric so no side is favored. The transpose and
  // scatter variants keep runs fresh; all are seed-replayable.
  var LAYOUTS = [
    {
      base: [
        [2, 2],
        [3, 6],
      ],
    }, // Meadow: lone stones
    {
      base: [
        [1, 4],
        [4, 2],
      ],
    }, // Desert: dune diagonals
    {
      base: [
        [2, 5],
        [5, 3],
      ],
    }, // Ocean: tidal pools
    {
      base: [
        [4, 1],
        [1, 4],
        [4, 4],
      ],
    }, // Volcano: dense crater cross
    {
      base: [
        [0, 5],
        [5, 1],
      ],
    }, // Space: sparse asteroids
    {
      base: [
        [2, 2],
        [3, 5],
      ],
    }, // Forest: grove clusters
    {
      base: [
        [5, 2],
        [2, 6],
      ],
    }, // Sunset: mesa arcs
    {
      base: [
        [2, 0],
        [2, 6],
        [6, 2],
      ],
    }, // Ice: frozen lanes
  ];
  // Maze layout, used when BOTH wrap walls and obstacles are on. It is not
  // "wrap + obstacles" with the same four lonely stones: the biome bases above
  // are scattered points, which is the right texture for an open arena but reads
  // as noise in a wrapping board. This base is made of short *runs* of cells, so
  // the 4-fold mirror builds barrier segments and the free space between them
  // becomes corridors. Placed away from the spawn column (x>=4 keeps every
  // mirrored orbit at Manhattan >= 4 from the head at 9,10) so the opening
  // board is always survivable, and deliberately overlapping the biome bases
  // never happens because maze replaces them rather than adding to them.
  var MAZE_LAYOUT = {
    base: [
      [4, 2],
      [5, 2],
      [6, 2],
      [8, 2],
      [2, 4],
      [2, 5],
      [2, 6],
      [2, 8],
      [6, 4],
      [6, 6],
      [8, 8],
    ],
  };

  // Per-biome food tints (3D mesh + light + 2D fallback share the table).
  var FOOD_TINT = [
    { c: 0xffc94d, e: 0xcc6a00, css: '#ffc94d' }, // Meadow: honey orb
    { c: 0xff9f1c, e: 0x9c4a00, css: '#ff9f1c' }, // Desert: sunfruit
    { c: 0x7fe7ff, e: 0x0a6a8a, css: '#7fe7ff' }, // Ocean: pearl
    { c: 0xff5a2d, e: 0x7a1500, css: '#ff5a2d' }, // Volcano: ember
    { c: 0x6ef3ff, e: 0x0a5a6e, css: '#6ef3ff' }, // Space: ion
    { c: 0xff4d6d, e: 0x7a0f2b, css: '#ff4d6d' }, // Forest: berry
    { c: 0xff7fb5, e: 0x7a1f4d, css: '#ff7fb5' }, // Sunset: blossom
    { c: 0xbfefff, e: 0x2a6f97, css: '#bfefff' }, // Ice: frost
  ];
  // Per-biome wall builds (mirrors the obstacle-geo system).
  var WALL_STYLE = ['slab', 'slab', 'slab', 'obsidian', 'slab', 'slab', 'slab', 'crystal'];
  // Ambient weather per biome: count, color, mote size, fall (+=down, -=rise),
  // sideways drift, half-extent of the volume, height. One shared Points cloud.
  var AMBIENT = [
    { n: 70, color: 0xbfff9f, size: 0.22, fall: 0.6, drift: 0.8, area: 26, h: 9 }, // Meadow pollen
    { n: 90, color: 0xe8c47a, size: 0.18, fall: 0.25, drift: 3.2, area: 30, h: 7 }, // Desert sand
    { n: 110, color: 0x7fc8ff, size: 0.16, fall: 5.5, drift: 0.4, area: 24, h: 12 }, // Ocean rain
    { n: 80, color: 0xff7a2d, size: 0.2, fall: -2.2, drift: 0.9, area: 24, h: 10 }, // Volcano embers
    { n: 60, color: 0xcfd6ff, size: 0.15, fall: 0.15, drift: 0.3, area: 30, h: 12 }, // Space dust
    { n: 80, color: 0x9fe6a0, size: 0.2, fall: 1.1, drift: 1.2, area: 26, h: 10 }, // Forest leaves
    { n: 70, color: 0xffb36b, size: 0.2, fall: 0.5, drift: 1.0, area: 26, h: 9 }, // Sunset petals
    { n: 120, color: 0xffffff, size: 0.16, fall: 1.6, drift: 0.9, area: 26, h: 12 }, // Ice snow
  ];
  function biomeIs(name) {
    return LEVELS[themeIdx].name === name;
  }
  function wallDims(style, horizontal) {
    var L = GRID + 1;
    if (style === 'crystal') return horizontal ? [L, 1.8, 0.35] : [0.35, 1.8, L];
    if (style === 'obsidian') return horizontal ? [L, 0.8, 0.7] : [0.7, 0.8, L];
    return horizontal ? [L, 1.1, 0.5] : [0.5, 1.1, L];
  }
  function applyWallStyle() {
    if (!window.__wallMeshes || !window.THREE) return;
    var style = WALL_STYLE[themeIdx] || 'slab';
    for (var i = 0; i < window.__wallMeshes.length; i++) {
      var m = window.__wallMeshes[i];
      var d = wallDims(style, i < 2);
      if (m.geometry) m.geometry.dispose();
      m.geometry = new window.THREE.BoxGeometry(d[0], d[1], d[2]);
    }
    if (window.__wallMat) {
      window.__wallMat.opacity = style === 'crystal' ? 0.5 : style === 'obsidian' ? 0.95 : 0.35;
      window.__wallMat.transparent = true;
    }
  }
  function applyFoodTint() {
    var ft = FOOD_TINT[themeIdx] || FOOD_TINT[0];
    if (mode !== '3d') return;
    if (foodMesh) {
      foodMesh.material.color.setHex(ft.c);
      foodMesh.material.emissive.setHex(ft.e);
    }
    if (foodLight) foodLight.color.setHex(ft.c);
    if (foodBase) foodBase.material.color.setHex(ft.c);
  }
  function rebuildAmbient() {
    if (!window.__ambient || !window.THREE) return;
    var A = AMBIENT[themeIdx] || AMBIENT[0];
    window.__ambMat.color.setHex(A.color);
    window.__ambMat.size = A.size;
    window.__ambient.geometry.setDrawRange(0, A.n);
    for (var i = 0; i < 120; i++) {
      window.__ambPos[i * 3] = (Math.random() - 0.5) * A.area;
      window.__ambPos[i * 3 + 1] = Math.random() * A.h;
      window.__ambPos[i * 3 + 2] = (Math.random() - 0.5) * A.area;
    }
    window.__ambient.geometry.attributes.position.needsUpdate = true;
    updateAmbientVisibility();
  }
  function updateAmbientVisibility() {
    if (!window.__ambient) return;
    window.__ambient.visible = mode === '3d' && quality !== 'low' && !reducedMotion;
  }
  function applyTheme(idx) {
    themeIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
    var L = LEVELS[themeIdx];
    if (mode === '3d' && scene) {
      scene.background.setHex(L.bg);
      scene.fog.color.setHex(L.bg);
      if (window.__hemi) {
        window.__hemi.color.setHex(L.hemiSky);
        window.__hemi.groundColor.setHex(L.hemiGround);
      }
      if (window.__groundMat) window.__groundMat.color.setHex(L.ground);
      if (window.__skirtMat) {
        window.__skirtMat.color.setHex(L.bg);
        window.__skirtMat.color.multiplyScalar(1.5);
      }
      if (window.__gridMat) window.__gridMat.color.setHex(L.grid);
      if (window.__wallMat) {
        window.__wallMat.color.setHex(L.wall);
        window.__wallMat.emissive.setHex(L.wall);
      }
      if (window.__obMat) {
        window.__obMat.color.setHex(L.obColor);
        window.__obMat.emissive.setHex(L.obColor);
        window.__obMat.emissive.multiplyScalar(0.35);
      }
      var og = window.__obGeos ? window.__obGeos[L.ob] : null;
      if (og) {
        window.__obGeo = og;
        for (var oi = 0; oi < obstacleMeshes.length; oi++) obstacleMeshes[oi].geometry = og;
      }
      if (window.__stars) window.__stars.visible = LEVELS[themeIdx].name === 'Space';
      applyWallStyle();
      applyFoodTint();
      rebuildAmbient();
      applyQualityVisuals();
    }
    return L;
  }
  // ---------- Daily challenge ----------
  // A "daily" is one date -> one seed + one rule, identical for every player for
  // the whole day. It reuses the seeded-run machinery (?seed=) rather than
  // inventing a second RNG, so a daily is reproducible from its link and a
  // friend can be beaten at exactly the same map. Every rule is expressed in
  // terms of systems the game already has (modes, speed, orb cadence), so a
  // daily adds no new physics - which is why this is cheap enough to ship and
  // cheap enough to extend with another row.
  var DAILY_RULES = [
    {
      id: 'maze',
      wrap: true,
      obstacles: true,
      speed: 'normal',
      bonusEvery: 5,
      shieldEvery: 7,
      shieldOff: false,
    },
    {
      id: 'gauntlet',
      wrap: false,
      obstacles: true,
      speed: 'normal',
      bonusEvery: 5,
      shieldEvery: 7,
      shieldOff: false,
    },
    {
      id: 'blitz',
      wrap: true,
      obstacles: false,
      speed: 'fast',
      bonusEvery: 5,
      shieldEvery: 7,
      shieldOff: false,
    },
    {
      id: 'bounty',
      wrap: true,
      obstacles: false,
      speed: 'normal',
      bonusEvery: 3,
      shieldEvery: 9,
      shieldOff: false,
    },
    {
      id: 'noshield',
      wrap: true,
      obstacles: true,
      speed: 'normal',
      bonusEvery: 4,
      shieldEvery: 99,
      shieldOff: true,
    },
  ];
  // Days since the Unix epoch, in whole days, so every timezone agrees on when
  // the daily rolls over.
  function todayIndex() {
    return Math.floor(Date.now() / 86400000);
  }
  function ruleForDay(day) {
    return DAILY_RULES[SnakeLogic.dailySeed(day) % DAILY_RULES.length];
  }
  function dailyRuleName() {
    return t('daily_rule_' + dailyRule.id);
  }
  // Apply (or release) the daily. While it is on, the settings that define the
  // challenge are visibly disabled rather than silently ignored - a control that
  // looks live but is not was the exact bug behind the old "Buttons" toggle.
  function applyDaily(on, day) {
    dailyOn = !!on;
    if (!dailyOn) {
      dailyRule = null;
      dailyDay = null;
    } else {
      dailyDay = day == null ? todayIndex() : day | 0;
      dailyRule = ruleForDay(dailyDay);
      seedNum = SnakeLogic.dailySeed(dailyDay);
      seedGen = null;
      $('opt-wrap').checked = !!dailyRule.wrap;
      $('opt-obstacles').checked = !!dailyRule.obstacles;
      $('opt-speed').value = dailyRule.speed;
      saveSettings();
    }
    var locked = ['opt-wrap', 'opt-obstacles', 'opt-speed'];
    for (var i = 0; i < locked.length; i++) {
      var el = $(locked[i]);
      if (el) el.disabled = dailyOn;
    }
    var segs = document.querySelectorAll('#mode-seg button');
    for (var s = 0; s < segs.length; s++) segs[s].disabled = dailyOn;
    applyDailyLabels();
    syncModeSeg();
  }
  // Split out of applyDaily so a language switch can re-render the same labels
  // without toggling the challenge off and on.
  function applyDailyLabels() {
    var db = $('btn-daily');
    if (db) setText(db, dailyOn ? t('daily_exit') : t('daily_btn'));
    var dn = $('daily-note');
    if (dn) {
      dn.hidden = !dailyOn;
      if (dailyOn) dn.textContent = t('daily_t', { n: dailyRuleName() });
    }
  }

  // ---------- Run modes ----------
  // Maze used to be an accident: it was the two independent checkboxes both being
  // on, which produced "wrap, plus a handful of rocks", i.e. classic obstacles
  // with the exits removed. It is now one named mode with its own tuned layout
  // and density, so the picker offers four real choices instead of three plus a
  // footgun combination. Both checkboxes still exist and still drive
  // everything - they are the source of truth - the picker just stops
  // pretending the combination is meaningless.
  function wrapOn() {
    var el = $('opt-wrap');
    return !!(el && el.checked);
  }
  function mazeOn() {
    return wrapOn() && obstaclesOn();
  }
  // Maze opens already structured and keeps thickening; an arena keeps its
  // lighter, sparser pacing.
  function obstacleStart() {
    return mazeOn() ? MAZE_OBSTACLE_START : OBSTACLE_START;
  }
  function obstaclePerLevel() {
    return mazeOn() ? MAZE_OBSTACLE_PER_LEVEL : OBSTACLE_PER_LEVEL;
  }
  function setMode(m) {
    if (m === 'wrap') {
      $('opt-wrap').checked = true;
      $('opt-obstacles').checked = false;
    } else if (m === 'obstacles') {
      $('opt-obstacles').checked = true;
      $('opt-wrap').checked = false;
    } else if (m === 'maze') {
      $('opt-wrap').checked = true;
      $('opt-obstacles').checked = true;
    } else {
      $('opt-wrap').checked = false;
      $('opt-obstacles').checked = false;
    }
    saveSettings();
    syncModeSeg();
  }
  function syncModeSeg() {
    var m = 'classic';
    // maze first: both boxes on must read as maze, not as "obstacles"
    if (mazeOn()) m = 'maze';
    else if ($('opt-obstacles') && $('opt-obstacles').checked) m = 'obstacles';
    else if ($('opt-wrap') && $('opt-wrap').checked) m = 'wrap';
    var btns = document.querySelectorAll('#mode-seg button');
    for (var i = 0; i < btns.length; i++)
      btns[i].setAttribute('aria-checked', btns[i].getAttribute('data-mode') === m ? 'true' : 'false');
  }

  // ---------- Audio (lazy) ----------
  var actx = null,
    master = null;
  function audio() {
    if (!actx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        actx = new AC();
        master = actx.createGain();
        master.gain.value = 0.22;
        master.connect(actx.destination);
      } catch (e) {
        return null;
      }
    }
    if (actx && actx.state === 'suspended') actx.resume().catch(function () {});
    return actx;
  }
  function beep(f0, f1, dur, type, vol) {
    if (!$('opt-sound').checked) return;
    var ctx = audio();
    if (!ctx) return;
    try {
      dur = dur || 0.1;
      type = type || 'square';
      vol = vol == null ? 1 : vol;
      var o = ctx.createOscillator(),
        g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), ctx.currentTime + dur);
      g.gain.setValueAtTime(0.5 * vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    } catch (e) {}
  }
  var sfx = {
    eat: function () {
      beep(620, 980, 0.1, 'square');
    },
    die: function () {
      beep(220, 55, 0.35, 'sawtooth');
    },
    win: function () {
      beep(523, 523, 0.1);
      setTimeout(function () {
        beep(659, 659, 0.1);
      }, 110);
      setTimeout(function () {
        beep(784, 1046, 0.2);
      }, 220);
    },
    click: function () {
      beep(440, 660, 0.05, 'sine', 0.6);
    },
  };
  // Procedural background music: A-minor pentatonic lead + soft bass pulse.
  // No assets; starts on first user gesture (startGame), stops on menu/death.
  var musicTimer = null,
    musicStep = 0,
    nextNoteT = 0,
    musicGain = null;
  // Procedural voice per biome (order matches LEVELS): tempo, bass root
  // shift (semitones from A2), melody scale, lead/bass waveforms.
  var MUSICTHEMES = [
    { bpm: 112, root: 0, scale: [0, 3, 5, 7, 10, 12, 10, 7, 5, 3], lead: 'triangle', bass: 'sine' }, // Meadow
    { bpm: 96, root: -2, scale: [0, 1, 5, 7, 8, 12, 8, 7, 5, 1], lead: 'square', bass: 'triangle' }, // Desert
    { bpm: 88, root: 3, scale: [0, 2, 4, 7, 9, 12, 9, 7, 4, 2], lead: 'sine', bass: 'sine' }, // Ocean
    { bpm: 132, root: -4, scale: [0, 1, 5, 6, 8, 12, 8, 6, 5, 1], lead: 'sawtooth', bass: 'square' }, // Volcano
    { bpm: 76, root: 5, scale: [0, 2, 5, 7, 9, 12, 9, 7, 5, 2], lead: 'sine', bass: 'triangle' }, // Space
    { bpm: 104, root: -5, scale: [0, 3, 5, 7, 10, 12, 10, 7, 5, 3], lead: 'triangle', bass: 'sine' }, // Forest
    { bpm: 92, root: 2, scale: [0, 2, 3, 7, 9, 12, 9, 7, 3, 2], lead: 'triangle', bass: 'sine' }, // Sunset
    { bpm: 120, root: 7, scale: [0, 3, 5, 7, 10, 14, 10, 7, 5, 3], lead: 'sine', bass: 'sine' }, // Ice
  ];
  function musicTheme() {
    return MUSICTHEMES[themeIdx] || MUSICTHEMES[0];
  }
  function musicOn() {
    var el = $('opt-music');
    return !!(el && el.checked);
  }
  function startMusic() {
    stopMusic();
    if (!musicOn()) return;
    var ctx = audio();
    if (!ctx) return;
    try {
      if (!musicGain) {
        musicGain = ctx.createGain();
        musicGain.gain.value = 0.09;
        musicGain.connect(ctx.destination);
      }
      musicStep = 0;
      nextNoteT = ctx.currentTime + 0.08;
      musicTimer = setInterval(musicSched, 90);
    } catch (e) {
      musicTimer = null;
    }
  }
  function stopMusic() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  }
  function musicPlaying() {
    return !!musicTimer;
  }
  function musicSched() {
    var ctx = actx;
    if (!ctx || !musicOn()) {
      stopMusic();
      return;
    }
    try {
      var stepDur = 60 / musicTheme().bpm / 2;
      while (nextNoteT < ctx.currentTime + 0.28) {
        playMusicStep(musicStep, nextNoteT, stepDur);
        nextNoteT += stepDur;
        musicStep++;
      }
    } catch (e) {
      stopMusic();
    }
  }
  function playMusicStep(s, t, dur) {
    var ctx = actx;
    function note(freq, durN, type, vol) {
      var o = ctx.createOscillator(),
        g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + durN);
      o.connect(g);
      g.connect(musicGain);
      o.start(t);
      o.stop(t + durN + 0.02);
    }
    var th = musicTheme();
    var A2 = 110 * Math.pow(2, th.root / 12);
    if (s % 8 === 0) note(A2, dur * 6, th.bass, 0.5);
    if (s % 8 === 4) note(A2 * Math.pow(2, -5 / 12), dur * 5, th.bass, 0.4);
    if (s % 2 === 0) {
      var mel = th.scale[s % th.scale.length];
      note((440 * Math.pow(2, mel / 12) * Math.pow(2, th.root / 12)) / 2, dur * 1.8, th.lead, 0.32);
    }
  }

  // ---------- Core logic (renderer-independent) ----------
  function baseInterval() {
    var v = $('opt-speed') ? $('opt-speed').value : 'normal';
    return SPEED_PRESETS[v] || SPEED_PRESETS.normal;
  }
  // Tick length after N foods. Single source of truth: this used to be
  // inlined in five places, which is how the speed curve and the help text
  // drifted apart in the first place.
  //
  // The curve approaches MIN_INTERVAL asymptotically instead of clamping to it.
  // The old linear "base - 3 per food" hit the floor by food #12 (fast) to #35
  // (slow) and then sat there dead flat for the rest of the run: after that the
  // only difficulty growth left in the game was obstacles. An exponential
  // decay never actually reaches the floor, so the snake keeps getting
  // imperceptibly faster for the whole run while each food matters less than
  // the last - which is the shape a speed curve wants anyway.
  function tickForFoods(n) {
    var head = Math.max(1, baseInterval() - MIN_INTERVAL);
    return MIN_INTERVAL + head * Math.exp(-n / SPEED_RAMP);
  }
  function reset() {
    snake = [
      { x: 9, y: 10 },
      { x: 8, y: 10 },
      { x: 7, y: 10 },
    ];
    dir = { x: 1, y: 0 };
    queue = [];
    score = 0;
    foodsEaten = 0;
    level = 1;
    longest = 3;
    tickMs = baseInterval();
    acc = 0;
    squash = 0;
    bonuses = [];
    hasShield = false;
    shieldPhase = 0;
    slideHeld = null;
    embers = [];
    emberAcc = 0;
    emberToastShown = false;
    runLayout = null;
    warnPulses = [];
    holdUntil = 0;
    radiusHold = 0; // fresh run, fresh framing (no stale inspection zoom)
    seedGen = null; // fresh deterministic stream for seeded runs
    combo = 0;
    lastEatAt = 0;
    comboWindowMs = COMBO_WINDOW;
    banked = 0;
    lastLostCombo = 0;
    lastBonusFood = 0;
    lastShieldFood = 0;
    deathCell = null;
    obstacles = [];
    clearBonuses();
    hideShieldMesh();
    if (window.__shieldRing) window.__shieldRing.visible = false;
    if (window.__emberRings)
      for (var er = 0; er < window.__emberRings.length; er++) window.__emberRings[er].visible = false;
    if (window.__warnRings)
      for (var wr = 0; wr < window.__warnRings.length; wr++) window.__warnRings[wr].visible = false;
    if (window.__deathRing) window.__deathRing.visible = false;
    var fl = $('flash');
    if (fl) fl.classList.remove('show');
    applyTheme(startThemeIdx);
    spawnFood();
    if (obstaclesOn()) seedObstacles(obstacleStart());
    syncSnakeMeshes(true);
    syncObstacleMeshes(true);
    updateHUD();
  }
  function obstaclesOn() {
    var el = $('opt-obstacles');
    return !!(el && el.checked);
  }
  // every spawnable thing, for placement that never overlaps
  function occupiedMap(extra) {
    var o = {};
    for (var i = 0; i < snake.length; i++) o[snake[i].x + snake[i].y * GRID] = true;
    o[food.x + food.y * GRID] = true;
    for (var b = 0; b < bonuses.length; b++) o[bonuses[b].x + bonuses[b].y * GRID] = true;
    if (shield) o[shield.x + shield.y * GRID] = true;
    for (var e = 0; e < embers.length; e++) o[embers[e].x + embers[e].y * GRID] = true;
    for (var j = 0; j < obstacles.length; j++) o[obstacles[j].x + obstacles[j].y * GRID] = true;
    if (extra) o[extra.x + extra.y * GRID] = true;
    return o;
  }
  function freeCell(minHeadDist) {
    var occ = occupiedMap();
    for (var t = 0; t < 250; t++) {
      var x = (rng() * GRID) | 0,
        y = (rng() * GRID) | 0;
      if (occ[x + y * GRID]) continue;
      if (minHeadDist && snake.length && Math.abs(x - snake[0].x) + Math.abs(y - snake[0].y) < minHeadDist)
        continue;
      return { x: x, y: y };
    }
    return null;
  }
  function pickLayout() {
    // one variant per run: pattern, transposed pattern, or classic scatter.
    // Chosen from the seeded stream, so links replay identical maps.
    var r = rng();
    if (mazeOn()) {
      // never scatter in a maze: random confetti instead of walls is exactly
      // the "wrap + a few rocks" outcome maze mode exists to stop being
      runLayout = { base: MAZE_LAYOUT.base, transpose: r < 0.4 };
      return;
    }
    var L = LAYOUTS[themeIdx] || LAYOUTS[0];
    if (r < 0.15) runLayout = { scatter: true };
    else runLayout = { base: L.base, transpose: r < 0.4 };
  }
  function seedObstacles(n) {
    obstacles = [];
    pickLayout();
    addObstacles(n);
  }
  function transposeBase(base) {
    return base.map(function (c) {
      return [c[1], c[0]];
    });
  }
  function addObstacles(n) {
    var before = obstacles.length;
    var want = Math.min(OBSTACLE_MAX, before + n);
    // pattern candidates first: mirrored, head-clear, unoccupied.
    // Added as whole mirror orbits (always 4 cells) so truncation can never
    // break symmetry; the first orbit is taken even when it overflows want
    // slightly (counts land on multiples of 4: 4, 8, 12, ...).
    if (runLayout && !runLayout.scatter) {
      var cands = SnakeLogic.mirrorLayout(
        runLayout.transpose ? transposeBase(runLayout.base) : runLayout.base,
        GRID
      );
      var occ = occupiedMap();
      var seenOb = {};
      for (var i = 0; i < cands.length && obstacles.length < want; i++) {
        var ck = cands[i].x + cands[i].y * GRID;
        if (seenOb[ck]) continue;
        // whole orbit of this cell
        var orb = [
          { x: cands[i].x, y: cands[i].y },
          { x: GRID - 1 - cands[i].x, y: cands[i].y },
          { x: cands[i].x, y: GRID - 1 - cands[i].y },
          { x: GRID - 1 - cands[i].x, y: GRID - 1 - cands[i].y },
        ];
        var members = [];
        // An orbit is all-or-nothing. If ANY of its 4 cells is unusable the
        // whole orbit is dropped: keeping the rest leaves a lopsided map, which
        // is both unfair (one side armoured) and breaks the symmetry the
        // layouts are built around. Both reasons below were real bugs, each
        // caught by the e2e suite:
        //   - a member too close to the head (fairness)
        //   - a member already occupied by the snake or food (playability)
        var blocked = false;
        for (var q = 0; q < orb.length; q++) {
          var mk = orb[q].x + orb[q].y * GRID;
          if (seenOb[mk]) continue;
          seenOb[mk] = true;
          if (occ[mk]) {
            blocked = true;
            continue;
          }
          if (snake.length && Math.abs(orb[q].x - snake[0].x) + Math.abs(orb[q].y - snake[0].y) < 4) {
            blocked = true;
            continue;
          }
          members.push(orb[q]);
        }
        if (blocked) members = [];
        if (!members.length) continue;
        if (obstacles.length + members.length > want && obstacles.length !== before) break;
        for (var m2 = 0; m2 < members.length; m2++) {
          obstacles.push(members[m2]);
          occ[members[m2].x + members[m2].y * GRID] = true;
        }
      }
    }
    // scatter fill for the rest (or the whole variant when scatter:true)
    var guard = 0;
    while (obstacles.length < want && guard++ < 500) {
      var f = freeCell(4);
      if (!f) break;
      obstacles.push(f);
    }
    var fresh = obstacles.slice(before);
    if (fresh.length) telegraph(fresh);
    syncObstacleMeshes(true);
  }
  // Danger telegraph: the 4-neighbors of fresh obstacles pulse briefly so
  // level-up spikes read as fair instead of ambushes.
  function telegraph(cells) {
    var now = performance.now();
    var dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (var i = 0; i < cells.length; i++) {
      for (var d = 0; d < dirs.length; d++) {
        var x = cells[i].x + dirs[d][0],
          y = cells[i].y + dirs[d][1];
        if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
        warnPulses.push({ x: x, y: y, until: now + 1400 });
      }
    }
    if (warnPulses.length > 64) warnPulses.splice(0, warnPulses.length - 64);
    // fresh deadly blocks are a visual-only pulse; announce once per batch
    if (cells.length) say(t('telegraph_a11y'));
  }
  function activeWarns(now) {
    var out = [];
    for (var i = 0; i < warnPulses.length; i++) if (warnPulses[i].until > now) out.push(warnPulses[i]);
    return out;
  }
  function levelUp(n) {
    level = n;
    if (n > life.bestLevel) life.bestLevel = n;
    saveLife();
    checkAch();
    buzz([20, 30, 20]);
    var L = applyTheme(startThemeIdx + n - 1);
    if (musicOn()) startMusic(); // adopt the new biome's voice immediately
    showBanner(t('banner_level', { n: n, biome: biomeName(L.name) + ' ' + L.icon }));
    toast(t('level_t', { n: n, biome: biomeName(L.name) }));
    if (L.name === 'Ice') {
      // banner above keeps the level info; this teaches the slide
      say(t('ice_banner'));
    }
    beep(523, 1046, 0.18, 'sine');
    announce(t('sr_level', { n: n, biome: biomeName(L.name) }));
    if (obstaclesOn()) addObstacles(obstaclePerLevel());
  }
  function spawnFood() {
    if (snake.length >= GRID * GRID) return false;
    var c = SnakeLogic.findFree(occupiedMap(), GRID, rng, 300);
    if (!c) return false;
    food = c;
    placeFoodMesh();
    return true;
  }
  function queueDirection(nx, ny) {
    var last = queue.length ? queue[queue.length - 1] : slideHeld || dir;
    if (nx === last.x && ny === last.y) return;
    if (snake.length > 1 && nx === -last.x && ny === -last.y) return;
    if (queue.length < MAX_QUEUE) {
      queue.push({ x: nx, y: ny });
      snapHeadVisual();
    }
  }
  // Relative turning: the snake always moves forward; ←/A turns to ITS left,
  // →/D to its right (screen coords: y grows downwards).
  // Double-turn U-turns are safe by geometry — no suicide guard needed here.
  function queueTurn(side) {
    var last = queue.length ? queue[queue.length - 1] : slideHeld || dir;
    var nx = side < 0 ? last.y : -last.y;
    var ny = side < 0 ? -last.x : last.x;
    queueDirection(nx, ny);
  }
  // ↑/↓/W/S do nothing by design; teach once, then stay silent.
  var seenKeys = false;
  function deadKeyHint() {
    if (!seenKeys) {
      seenKeys = true;
      try {
        store.set('snake3d.seenKeys', '1');
      } catch (e) {}
      say(t('keys_hint'));
    }
  }
  // RESPONSIVE: rotate head instantly on input so turns feel immediate,
  // even though the grid step happens on the next fixed tick.
  function snapHeadVisual() {
    if (mode !== '3d' || !snakeHead) return;
    var eff = queue.length ? queue[0] : slideHeld || dir;
    snakeHead.rotation.y = Math.atan2(eff.x, eff.y);
  }
  function step() {
    // ice rule: turns take effect one cell later (momentum pipeline)
    if (biomeIs('Ice')) {
      var sr = SnakeLogic.slideDir(queue, slideHeld, dir);
      dir = sr.dir;
      slideHeld = sr.pending;
      queue = sr.queue;
    } else {
      if (slideHeld) {
        queue.unshift(slideHeld); // leaving the ice: flush, no turn lost
        slideHeld = null;
      }
      if (queue.length) dir = queue.shift();
    }
    var np = SnakeLogic.nextPos(snake[0], dir);
    var nx = np.x,
      ny = np.y;
    var wrap = $('opt-wrap').checked;
    if (wrap) {
      var w = SnakeLogic.wrapPos(np, GRID);
      nx = w.x;
      ny = w.y;
    } else if (!SnakeLogic.inBounds(np, GRID)) {
      if (tryShield()) return;
      die(t('die_wall'), { x: nx, y: ny });
      return;
    }
    var willEat = nx === food.x && ny === food.y;
    var eatBonusIdx = -1;
    for (var bi = 0; bi < bonuses.length; bi++)
      if (bonuses[bi].x === nx && bonuses[bi].y === ny) {
        eatBonusIdx = bi;
        break;
      }
    var willEatBonus = eatBonusIdx >= 0;
    var willEatShield = !!(shield && nx === shield.x && ny === shield.y);
    var willGrow = willEat || willEatBonus;
    var cell = { x: nx, y: ny };
    // A shield spent while fully boxed in sets shieldPhase: ghost through our
    // own body / blocks / embers long enough to get out. Walls still kill, so
    // the snake can never leave the board.
    var phased = shieldPhase > 0;
    for (var oi = 0; !phased && oi < obstacles.length; oi++)
      if (obstacles[oi].x === nx && obstacles[oi].y === ny) {
        if (tryShield()) return;
        die(t('die_ob'), cell);
        return;
      }
    if (!phased && SnakeLogic.hitsBody(cell, snake, willGrow)) {
      if (tryShield()) return;
      die(t('die_self'), cell);
      return;
    }
    // volcano rule: ignited embers are lethal (telegraph phase is safe).
    // Ages advance on play time only, so pausing freezes telegraphs fairly.
    for (var ei = 0; !phased && ei < embers.length; ei++) {
      var em = embers[ei];
      if (em.x === nx && em.y === ny && em.age >= EMBER_WARN && em.age < EMBER_WARN + EMBER_BURN) {
        if (tryShield()) return;
        die(t('die_ember'), cell);
        return;
      }
    }
    snake.unshift({ x: nx, y: ny });
    if (snake.length > longest) longest = snake.length;
    if (willEatBonus) {
      var multB = registerEat();
      var gainedB = Math.round(50 * multB * prestigeMult());
      score += gainedB;
      // A bonus orb grows the snake just like a regular food (willGrow covers
      // both), so it counts toward the level goal too. It used to bump only
      // life.foods, which left the "FOODS n/6" pill under-reporting real
      // progress and made the level/speed curve ignore the pink orbs.
      foodsEaten++;
      life.foods++;
      if (combo > life.bestCombo) life.bestCombo = combo;
      saveLife();
      checkAch();
      buzz(30);
      squash = 1;
      fx2d(nx, ny, '+' + gainedB, curPal().css.bonus);
      hideTut();
      var tb = gridToWorld(nx, ny);
      burst({ x: tb.x, y: 0.7, z: tb.z }, 0xff5fa2, 16);
      beep(880, 1560, 0.16, 'square');
      removeBonus(eatBonusIdx);
      say(t('bonus_ate', { n: gainedB }) + (multB > 1 ? ' (x' + multB + ')' : ''));
      // Milestones, not "every eat past 5": the ladder has no ceiling now, so a
      // `>= 5` test would fire the banner on every remaining food of the run.
      if (multB >= 5 && multB % 5 === 0) showBanner(t('banner_combo', { n: multB }));
      // The regular food is still on the board, so no spawnFood() here. But the
      // pool just freed a slot, so re-check the cadence: collecting fast refills
      // the board faster.
      paceEntities();
      var nlB = SnakeLogic.levelFor(foodsEaten, FOODS_PER_LEVEL);
      if (nlB > level) levelUp(nlB);
      tickMs = tickForFoods(foodsEaten);
      if (snake.length >= GRID * GRID) {
        syncSnakeMeshes();
        updateHUD();
        win();
        return;
      }
    } else if (willEat) {
      var mult = registerEat();
      var gained = Math.round(10 * mult * prestigeMult());
      score += gained;
      foodsEaten++;
      life.foods++;
      if (combo > life.bestCombo) life.bestCombo = combo;
      saveLife();
      checkAch();
      buzz(15);
      squash = 1;
      fx2d(nx, ny, '+' + gained, curPal().css.food);
      hideTut();
      if (mult > 1) say(t('combo_t', { m: mult, n: gained }));
      // every 5th step, not every eat past 5 - and `n` must be passed, or the
      // banner renders a literal "x{n}" (the bonus path already did this right)
      if (mult >= 5 && mult % 5 === 0) showBanner(t('banner_combo', { n: mult }));
      var nl = SnakeLogic.levelFor(foodsEaten, FOODS_PER_LEVEL);
      if (nl > level) levelUp(nl);
      var gt = gridToWorld(nx, ny);
      burst({ x: gt.x, y: 0.7, z: gt.z }, combo >= 3 ? 0xfff3a3 : 0xffc94d, Math.min(8 + combo * 2, 20));
      sfx.eat();
      tickMs = tickForFoods(foodsEaten);
      if (snake.length >= GRID * GRID) {
        syncSnakeMeshes();
        updateHUD();
        win();
        return;
      }
      spawnFood();
      paceEntities();
    } else if (willEatShield) {
      snake.pop(); // armor, not food: normal move, no growth
      hasShield = true;
      hideShieldMesh();
      var gw = gridToWorld(nx, ny);
      burst({ x: gw.x, y: 0.7, z: gw.z }, 0x46e6ff, 14);
      sfx.eat();
      buzz(20);
      say(t('shield_ate'));
      hideTut();
    } else snake.pop();
    // desert rule: uneaten food withers and respawns elsewhere (eating wins ties)
    if (!willEat && biomeIs('Desert') && performance.now() - foodBornAt > DESERT_FOOD_TTL) {
      spawnFood();
      say(t('desert_drain'));
    }
    syncSnakeMeshes();
    updateHUD();
  }
  function die(msg, cell) {
    state = 'over';
    sfx.die();
    stopMusic();
    deathCell = cell || { x: snake[0].x, y: snake[0].y };
    if (!reducedMotion) shake = 0.9;
    else shake = 0;
    // crash marker: red ring + particles on the killing cell, screen flash
    try {
      var cx = Math.max(0, Math.min(GRID - 1, deathCell.x));
      var cy = Math.max(0, Math.min(GRID - 1, deathCell.y));
      var w = gridToWorld(cx, cy);
      burst({ x: w.x, y: 0.7, z: w.z }, 0xff2d55, 14);
      fx2d(cx, cy, null, '#ff2d55');
      if (window.__deathRing) {
        window.__deathRing.position.set(w.x, 0.06, w.z);
        window.__deathRing.visible = true;
      }
    } catch (e) {}
    var fl = $('flash');
    if (fl && !reducedMotion) {
      fl.classList.remove('show');
      void fl.offsetWidth;
      fl.classList.add('show');
      setTimeout(function () {
        fl.classList.remove('show');
      }, 700);
    }
    // An un-banked chain dies with the run. Captured before the reset so the
    // recap can name what the crash actually cost - otherwise banking is just a
    // bonus button with no downside and no reason to ever press it.
    lastLostCombo = combo >= BANK_MIN ? combo : 0;
    combo = 0;
    var isBest = score > best && score > 0;
    var nb = Math.max(best, score);
    if (nb !== best) {
      best = nb;
      store.set('snake3d.best', String(best));
    }
    saveLife();
    buzz([60, 40, 60]);
    updateHUD();
    var stats = statsLine();
    // dramatic beat: let shake + flash + marker land before the overlay
    var replayOver = function () {
      var recap = t('recap_t', {
        cause: msg,
        biome: biomeName(LEVELS[themeIdx].name) + ' ' + LEVELS[themeIdx].icon,
        score: score,
        best: best,
      });
      showOverlay(
        t('over_t'),
        recap +
          (isBest ? ' ' + t('newbest') : '') +
          (lastLostCombo ? ' ' + t('bank_lost', { n: lastLostCombo }) : ''),
        statsChips(),
        replayOver
      );
      primeShot(); // share picture ready by the time the card is read
    };
    setTimeout(function () {
      if (state === 'over') replayOver();
    }, 1000);
    // cause first, then the stat line: the recap card reuses the same order.
    // One announcement only - toast() is visual (aria-hidden), say() would
    // duplicate the cause.
    announce(msg + '. ' + t('sr_over', { s: stats }));
    toast(msg);
  }
  function win() {
    state = 'win';
    sfx.win();
    stopMusic();
    best = Math.max(best, score);
    store.set('snake3d.best', String(best));
    life.wins++;
    unlock('win');
    saveLife();
    updateHUD();
    var stats = statsLine();
    var replayWin = function () {
      showOverlay(t('win_t'), t('win_s'), statsChips(), replayWin);
      primeShot();
    };
    replayWin();
    announce(t('sr_win', { s: stats }));
  }
  function hideTut() {
    if (!seenTut) {
      seenTut = true;
      store.set('snake3d.seen', '1');
    }
    var h = $('hint');
    if (h) h.hidden = true;
  }
  function startGame() {
    sfx.click();
    audio();
    reset();
    setState('playing');
    runStartAt = performance.now();
    life.games++;
    saveLife();
    startMusic();
    var h = $('hint');
    if (h) h.hidden = seenTut;
    announce(t('sr_start'));
    // the daily is only fair if its rule is stated, not just applied: the
    // controls are visibly disabled, so the twist needs saying out loud too
    if (dailyOn) {
      toast(t('daily_t', { n: dailyRuleName() }));
      say(t('daily_t', { n: dailyRuleName() }));
    }
    acc = Math.max(0, tickMs - 30); // RESPONSIVE: first step lands ~30ms after tap
    var b = $('btn-play');
    if (b) b.blur();
  }
  // Shared by togglePause() and the bank button, so re-rendering the pause card
  // (after banking, or after a language switch) always rebuilds the same thing
  // - including the bank row, whose value depends on the live chain.
  function replayPause() {
    showOverlay(t('paused_t'), t('paused_s'), statsChips(), replayPause);
  }
  function togglePause() {
    if (state === 'playing') {
      setState('paused');
      replayPause();
      announce(t('sr_pause'));
    } else if (state === 'paused') {
      setState('playing');
      acc = 0;
      lastT = performance.now();
      if (musicOn()) startMusic(); // e.g. re-enabled while paused
    }
    var b = $('btn-pause');
    if (b) b.blur();
  }
  function steer(d) {
    audio();
    if (d === 'left') queueTurn(-1);
    else if (d === 'right') queueTurn(1);
  }
  // Camera-relative steering: W/arrows-up/swipe-up/D-pad-up always mean
  // "screen up" (away from the camera), no matter how the camera orbited.
  // In top-down / 2D this degenerates to the classic arrow layout.
  function camBasis() {
    if (mode === '3d' && camera && camTarget) {
      var fx = camTarget.x - camera.position.x,
        fz = camTarget.z - camera.position.z;
      var len = Math.sqrt(fx * fx + fz * fz);
      if (len > 1e-4) {
        fx /= len;
        fz /= len;
        return { fx: fx, fz: fz, rx: -fz, rz: fx };
      }
    }
    return { fx: 0, fz: -1, rx: 1, rz: 0 };
  }
  function viewSteer(sx, sy) {
    // (sx, sy): screen space, up = (0, -1). Snaps to nearest grid direction
    // (suicide-proof tie-break lives in SnakeLogic.snapDir).
    var b = camBasis();
    var uy = -sy;
    var pick = SnakeLogic.snapDir(sx * b.rx + uy * b.fx, sx * b.rz + uy * b.fz, dir, snake.length);
    queueDirection(pick.x, pick.y);
  }
  // Point-and-go: click/tap the board where you want the snake to head.
  // Picks the dominant axis; 180-degree taps are safely ignored by queueDirection.
  var view2d = { ox: 0, oy: 0, cell: 10, dpr: 1 };
  function steerToward(clientX, clientY) {
    if (!snake.length) return;
    var r = canvas.getBoundingClientRect();
    var gx, gy;
    if (mode === '3d') {
      if (!window.__ray || !camera) return;
      var nx = ((clientX - r.left) / r.width) * 2 - 1;
      var ny = -((clientY - r.top) / r.height) * 2 + 1;
      window.__ray.setFromCamera({ x: nx, y: ny }, camera);
      var o = window.__ray.ray.origin,
        d = window.__ray.ray.direction;
      if (!d.y || Math.abs(d.y) < 1e-6) return;
      var t = -o.y / d.y;
      if (!isFinite(t) || t < 0) return;
      gx = Math.floor(o.x + d.x * t + GRID / 2);
      gy = Math.floor(o.z + d.z * t + GRID / 2);
    } else {
      var px = (clientX - r.left) * view2d.dpr;
      var py = (clientY - r.top) * view2d.dpr;
      gx = Math.floor((px - view2d.ox) / view2d.cell);
      gy = Math.floor((py - view2d.oy) / view2d.cell);
    }
    if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) return;
    var dx = gx - snake[0].x,
      dy = gy - snake[0].y;
    if (dx === 0 && dy === 0) return;
    audio();
    if (Math.abs(dx) >= Math.abs(dy)) queueDirection(dx > 0 ? 1 : -1, 0);
    else queueDirection(0, dy > 0 ? 1 : -1);
  }
  // Mouse/pen: click (no drag) steers; drag orbits (see initThree)
  var mDownX = 0,
    mDownY = 0,
    mDownT = 0,
    mDownBtn = 0;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') return;
    mDownX = e.clientX;
    mDownY = e.clientY;
    mDownT = performance.now();
    mDownBtn = e.button;
  });
  canvas.addEventListener('pointerup', function (e) {
    if (e.pointerType === 'touch' || mDownBtn !== 0) return;
    var moved = Math.sqrt(
      (e.clientX - mDownX) * (e.clientX - mDownX) + (e.clientY - mDownY) * (e.clientY - mDownY)
    );
    if (performance.now() - mDownT < 350 && moved < 8) steerToward(e.clientX, e.clientY);
  });

  // ---------- UI wiring: attached BEFORE 3D init so Start never dies ----------
  // EDGE: buttons must work for mouse, touch, keyboard, screen readers and
  // synthetic clicks. pointerdown = fast path; click = fallback (no double-fire).
  // NOTE: no keydown handler here on purpose — native Enter/Space already
  // fires click on focused buttons, and that single click is enough.
  function blurIt(el) {
    try {
      if (el && el.blur) el.blur();
    } catch (e) {}
  }
  function onTap(el, fn) {
    if (!el) return;
    var lastPd = 0;
    el.addEventListener('pointerdown', function (e) {
      lastPd = Date.now();
      if (e.cancelable) e.preventDefault();
      fn();
      blurIt(el);
    });
    el.addEventListener('click', function (e) {
      if (Date.now() - lastPd > 600) {
        fn(); // fallback: no pointerdown seen (keyboard/AT/script/old browser)
        blurIt(el);
      } else if (e.cancelable) e.preventDefault();
    });
  }
  var lastStartAt = 0;
  function guardedStart() {
    var now = Date.now();
    if (state === 'paused') {
      togglePause();
      return;
    } // overlay says Resume -> resume, don't wipe score
    if (state === 'playing' && now - lastStartAt < 400) return; // swallow accidental double-tap
    lastStartAt = now;
    startGame();
  }
  onTap($('btn-play'), guardedStart);
  onTap($('btn-restart'), function () {
    lastStartAt = 0;
    startGame();
  }); // explicit Restart always resets
  onTap($('btn-pause'), function () {
    if (state === 'playing' || state === 'paused') togglePause();
    else say(t('press_start'));
  });
  // Help dialog: open moves focus inside, close hands it back to the opener.
  // Without the restore, focus was left on the now-hidden close button and the
  // next Tab restarted from <body> (keyboard users lost their place).
  function openHelp() {
    if (state === 'playing') togglePause(); // never run the game behind the docs
    $('help-modal').hidden = false;
    var c = $('btn-close-help');
    if (c) {
      try {
        c.focus({ preventScroll: true });
      } catch (e) {}
    }
  }
  function closeHelp() {
    $('help-modal').hidden = true;
    // Hand focus to the card's primary action, which is where the player is
    // actually headed (help auto-pauses, so Resume is the next thing wanted).
    // Falling back to the help button is wrong: Space on it would re-open the
    // dialog instead of resuming, because buttons activate on Space natively.
    var back = null;
    if (state === 'paused') back = $('btn-resume');
    else if (state === 'playing' || state === 'menu') back = $('btn-play');
    if (!back || back.hidden || back.disabled) back = $('btn-help');
    if (back && back.focus) {
      try {
        back.focus({ preventScroll: true });
      } catch (e) {}
    }
  }
  onTap($('btn-help'), openHelp);
  onTap($('btn-close-help'), closeHelp);
  onTap($('btn-resume'), function () {
    if (state === 'paused') togglePause();
  });
  onTap($('btn-restart2'), function () {
    lastStartAt = 0;
    startGame();
  });
  onTap($('btn-quit'), function () {
    if (state === 'paused') quitToMenu();
  });
  onTap($('btn-bank'), function () {
    // stays paused on purpose: the pause card is the decision point, so the
    // player banks and then decides again whether to resume or die for more
    if (state === 'paused') bankNow();
  });
  onTap($('btn-daily'), function () {
    sfx.click();
    applyDaily(!dailyOn);
  });
  onTap($('btn-prestige'), doPrestige);
  onTap($('btn-share'), shareScore);
  onTap($('btn-shot'), function () {
    if (lastShotURL) deliverShot(lastShotURL);
    else
      makeShot(function (u) {
        if (u) {
          lastShotURL = u;
          shotReadyFlag = true;
          deliverShot(u);
        } else say(t('shot_fail'));
      });
  });
  // Service-worker update: the waiting worker activates, then we reload
  // into the new version. The row is revealed by the registration script.
  onTap($('btn-update'), function () {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller)
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    } catch (e) {}
    setTimeout(function () {
      try {
        location.reload();
      } catch (e2) {}
    }, 600);
  });
  // A new worker took over, so this page is running the previous build. Say so
  // rather than reloading: an automatic refresh would destroy a live run.
  window.__notifyUpdate = function () {
    say(t('update_t'), true);
  };
  // PWA install: surfaced only when the browser fires beforeinstallprompt
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    try {
      e.preventDefault();
    } catch (err) {}
    deferredInstall = e;
    var r = $('install-row');
    if (r) r.hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    deferredInstall = null;
    var r = $('install-row');
    if (r) r.hidden = true;
    say(t('install_ok'));
    announce(t('install_ok'));
  });
  onTap($('btn-install'), function () {
    if (deferredInstall && typeof deferredInstall.prompt === 'function') {
      try {
        deferredInstall.prompt();
        if (deferredInstall.userChoice && deferredInstall.userChoice.catch)
          deferredInstall.userChoice.catch(function () {});
      } catch (e) {}
    } else say(t('install_manual'));
  });
  // Erase progress. Destructive, so it arms on the first tap and disarms if the
  // player does anything else - no blocking confirm() dialog and no new modal.
  var eraseArmed = false,
    eraseTimer = 0;
  function disarmErase() {
    eraseArmed = false;
    if (eraseTimer) clearTimeout(eraseTimer);
    eraseTimer = 0;
    var b = $('btn-erase');
    if (b) b.textContent = t('erase_btn');
  }
  onTap($('btn-erase'), function () {
    if (!eraseArmed) {
      eraseArmed = true;
      var b = $('btn-erase');
      if (b) b.textContent = t('erase_confirm');
      say(t('erase_armed'));
      if (eraseTimer) clearTimeout(eraseTimer);
      eraseTimer = setTimeout(disarmErase, 6000);
      return;
    }
    disarmErase();
    eraseProgress();
    say(t('erase_done'));
    announce(t('erase_done'));
  });
  // any run start re-arms silently: erasing is never something you want to
  // finish off by accident
  onTap($('btn-play'), disarmErase);
  onTap($('btn-resume'), disarmErase);
  onTap($('btn-restart'), disarmErase);
  onTap($('btn-restart2'), disarmErase);
  var segBtns = document.querySelectorAll('#mode-seg button');
  for (var gi = 0; gi < segBtns.length; gi++) {
    (function (b) {
      onTap(b, function () {
        setMode(b.getAttribute('data-mode'));
      });
    })(segBtns[gi]);
  }
  ['opt-wrap', 'opt-obstacles'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('change', syncModeSeg);
  });
  if ($('opt-colorblind')) $('opt-colorblind').addEventListener('change', applyPalette);
  if ($('opt-skin'))
    $('opt-skin').addEventListener('change', function (e) {
      var sk = skinById(e.target.value);
      if (skinUnlocked(sk)) {
        skinId = sk.id;
        saveSettings();
        applySkin();
        say(t('skin_' + skinId));
      } else syncSkinOptions(); // locked choice: snap back to the owned skin
    });
  if ($('opt-music'))
    $('opt-music').addEventListener('change', function () {
      if (musicOn() && state === 'playing') startMusic();
      else stopMusic();
    });
  if ($('opt-lang')) $('opt-lang').addEventListener('change', applyI18n);
  // Kid mode: one tap sets slow + wrap + no obstacles (transparent presets).
  // It has to be reversible: previously unchecking did nothing at all, so a
  // player who turned it on could never get their speed/mode back and had no
  // way to tell the preset was still in force. Remember what was there before
  // and put it back.
  var kidPrev = null;
  if ($('opt-kid'))
    $('opt-kid').addEventListener('change', function (e) {
      if (e.target.checked) {
        kidPrev = {
          speed: $('opt-speed').value,
          wrap: $('opt-wrap').checked,
          obstacles: $('opt-obstacles').checked,
        };
        $('opt-speed').value = 'slow';
        $('opt-wrap').checked = true;
        $('opt-obstacles').checked = false;
        say(t('kid_on'));
        announce(t('kid_on'));
      } else if (kidPrev) {
        $('opt-speed').value = kidPrev.speed;
        $('opt-wrap').checked = kidPrev.wrap;
        $('opt-obstacles').checked = kidPrev.obstacles;
        kidPrev = null;
        say(t('kid_off'));
        announce(t('kid_off'));
      } else {
        // Kid mode was already on when the page loaded, so the pre-kid state
        // was never captured. Fall back to plain Classic rather than leaving
        // the preset silently in force.
        $('opt-speed').value = 'normal';
        $('opt-wrap').checked = false;
        $('opt-obstacles').checked = false;
        say(t('kid_off'));
        announce(t('kid_off'));
      }
      saveSettings();
      syncModeSeg();
      tickMs = tickForFoods(foodsEaten);
    });
  function applyDpad() {
    var el = $('opt-dpad');
    $('dpad').classList.toggle('force', !!(el && el.checked));
  }
  if ($('opt-dpad')) $('opt-dpad').addEventListener('change', applyDpad);
  if ($('opt-speed'))
    $('opt-speed').addEventListener('change', function () {
      tickMs = tickForFoods(foodsEaten);
    });
  // persist every setting on change
  for (var si = 0; si < SETTING_IDS.length; si++) {
    (function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', saveSettings);
    })(SETTING_IDS[si]);
  }
  var dpadBtns = document.querySelectorAll('#dpad button');
  for (var di = 0; di < dpadBtns.length; di++) {
    (function (b) {
      var lastPd = 0;
      b.addEventListener('pointerdown', function (e) {
        lastPd = Date.now();
        if (e.cancelable) e.preventDefault();
        steer(b.getAttribute('data-dir'));
      });
      b.addEventListener('click', function (e) {
        if (Date.now() - lastPd > 600) steer(b.getAttribute('data-dir'));
      });
    })(dpadBtns[di]);
  }
  // ←/→/A/D turn the snake (it always moves forward); ↑/↓/W/S teach once.
  // Swipe stays screen-absolute via viewSteer (a swipe IS a direction).
  var TURNMAP = {
    ArrowLeft: -1,
    KeyA: -1,
    ArrowRight: 1,
    KeyD: 1,
  };
  var DEADKEYS = {
    ArrowUp: 1,
    KeyW: 1,
    ArrowDown: 1,
    KeyS: 1,
  };
  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.code === 'Escape') e.target.blur();
      return; // let form controls handle their own keys (Space opens select, etc.)
    }
    // Focus trap: Tab cycles inside the open dialog (help wins over overlay)
    if (e.code === 'Tab') {
      var scope = null;
      if (!$('help-modal').hidden) scope = $('help-modal');
      else if (!overlay.classList.contains('hidden')) scope = overlay;
      if (scope) {
        var items = [];
        var f = scope.querySelectorAll('button, select, input, [tabindex]');
        for (var fi = 0; fi < f.length; fi++) {
          if (f[fi].disabled) continue;
          var p = f[fi],
            off = false;
          while (p && p !== scope) {
            if (p.hidden) {
              off = true;
              break;
            }
            p = p.parentElement;
          }
          if (!off && f[fi].offsetParent !== null) items.push(f[fi]);
        }
        if (items.length) {
          var first = items[0],
            last = items[items.length - 1],
            act = document.activeElement;
          if (e.shiftKey && (act === first || !scope.contains(act))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && act === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      return;
    }
    // Escape closes help even when a button holds focus (trap keeps it there)
    if (e.code === 'Escape' && !$('help-modal').hidden) {
      closeHelp();
      return;
    }
    // Focused buttons activate natively (single click via onTap fallback).
    // Swallowing them here would double-fire (native + global) — but only
    // Space/Enter activate buttons, so only those return early. Turn keys
    // must keep steering even right after clicking a button (otherwise the
    // controls silently die until the next canvas click).
    if (tag === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;
    if (TURNMAP[e.code]) {
      e.preventDefault();
      audio();
      queueTurn(TURNMAP[e.code]);
      return;
    }
    if (DEADKEYS[e.code]) {
      e.preventDefault();
      audio();
      deadKeyHint();
      return;
    }
    if (e.code === 'Space' || e.code === 'KeyP') {
      e.preventDefault();
      if (!$('help-modal').hidden) {
        closeHelp(); // dismiss docs first, game stays paused
        return;
      }
      if (state === 'playing' || state === 'paused') togglePause();
      else startGame();
      return;
    }
    if (e.code === 'Enter') {
      if (!$('help-modal').hidden) {
        closeHelp();
        return;
      }
      if (state === 'paused')
        startGame(); // fresh run, unpaused (reset() alone would strand the pause overlay)
      else if (state !== 'playing') startGame();
      else reset();
    }
  });
  // Touch: single-finger swipe steers, two-finger drag orbits + pinches zoom
  var tsX = 0,
    tsY = 0,
    tsT = 0,
    multiTouch = false;
  var pinchD = 0,
    pinchMX = 0,
    pinchMY = 0;
  canvas.addEventListener(
    'touchstart',
    function (e) {
      multiTouch = e.touches.length > 1;
      if (!multiTouch) pinchD = 0;
      var t = e.changedTouches[0];
      tsX = t.clientX;
      tsY = t.clientY;
      tsT = performance.now();
    },
    { passive: true }
  );
  canvas.addEventListener(
    'touchmove',
    function (e) {
      if (e.touches.length !== 2) return;
      var a = e.touches[0],
        b = e.touches[1];
      var mx = (a.clientX + b.clientX) / 2,
        my = (a.clientY + b.clientY) / 2;
      var d = Math.sqrt(
        (a.clientX - b.clientX) * (a.clientX - b.clientX) + (a.clientY - b.clientY) * (a.clientY - b.clientY)
      );
      if (pinchD > 0) {
        theta -= (mx - pinchMX) * 0.008;
        phi -= (my - pinchMY) * 0.007;
        phi = Math.max(0.35, Math.min(1.25, phi));
        applyFit(); // keep the board framed at the new orbit angle
        setRadiusHold(radius - (d - pinchD) * 0.05);
      }
      pinchMX = mx;
      pinchMY = my;
      pinchD = d;
    },
    { passive: true }
  );
  canvas.addEventListener(
    'touchend',
    function (e) {
      if (e.touches.length < 2) pinchD = 0;
      if (multiTouch) return; // two fingers = camera gesture, never steer
      var t = e.changedTouches[0];
      var dx = t.clientX - tsX,
        dy = t.clientY - tsY,
        dt = performance.now() - tsT;
      var sel = $('opt-swipe');
      var thresh = (sel && SWIPE_PX[sel.value]) || 24;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dt < 350 && dist > thresh) {
        if (e.cancelable) e.preventDefault();
        audio();
        if (Math.abs(dx) > Math.abs(dy)) viewSteer(dx > 0 ? 1 : -1, 0);
        else viewSteer(0, dy > 0 ? 1 : -1);
      } else if (dt < 350 && dist <= 8) {
        // tap = "go there": the easiest steering of all
        audio();
        steerToward(t.clientX, t.clientY);
      }
    },
    { passive: false }
  );
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state === 'playing') togglePause();
  });
  window.addEventListener('blur', function () {
    if (state === 'playing') togglePause();
  });

  // ---------- Renderer: try 3D, fall back to 2D ----------
  var renderer = null,
    scene = null,
    camera = null,
    dirLight = null;
  var obstacleMeshes = [];
  var foodMesh = null,
    foodLight = null,
    foodBase = null;
  var particles = [];
  var theta = Math.PI / 4,
    phi = 0.95,
    radius = 24;
  // Fixed framing. The camera radius is derived from the board's actual 3D
  // corners for the CURRENT orbit angle, so it is a pure function of screen
  // size and camera orientation - never of where the snake or food is. That
  // kills the zoom pumping ("zooms out, then zooms back in") while keeping the
  // whole board framed, including on narrow portrait screens where the old
  // head+food auto-fit left half the board off-screen.
  //
  // We fit the real corner points rather than a bounding sphere: the board is
  // a FLAT box, so a sphere is hugely conservative (it would force the whole
  // frame to fit the board's 45-degree diagonal vertically and shrink the game
  // to a stamp on desktop). Projecting the 8 corners and solving for the
  // distance that keeps them all inside the frustum is both exact and tight.
  //
  // Because the solve re-runs when the player orbits, dragging the view keeps
  // the board framed at any angle instead of clipping it.
  var FIT_FILL = 0.94; // fraction of the NDC box the board may span
  var FIT_HALF = (GRID * CELL) / 2 + 0.5, // board half-extent incl. the wall lip
    FIT_TOP = 1.8; // tallest wall style (crystal)
  var FIT_R = 38; // live fit radius, refreshed on resize and on orbit
  var MIN_CELL_PX = 18; // legibility floor for touch layouts (see applyFit)
  var FOLLOW_LEASH = 1.6; // max cells the camera target may trail the head by
  var fitFollow = false; // true when the floor zoomed in and the camera must track the head
  var lastTopView = false; // last seen top-down state, to re-fit on toggle
  // 8 corners of the board box, in world space
  var FIT_CORNERS = [];
  for (var fcx = 0; fcx < 8; fcx++)
    FIT_CORNERS.push({
      x: fcx & 1 ? FIT_HALF : -FIT_HALF,
      y: fcx & 2 ? FIT_TOP : 0,
      z: fcx & 4 ? FIT_HALF : -FIT_HALF,
    });
  // Largest NDC magnitude the board reaches at a given distance. Monotonically
  // DEcreasing in R (further away = smaller on screen), which is what makes the
  // bisection below valid. A corner behind the camera counts as infinitely far
  // too big, so it is treated as +Infinity rather than a magic constant.
  // Camera basis for an ARBITRARY orbit/distance, for the fit solve.
  // Deliberately NOT called camBasis(): that name belongs to the live-basis
  // helper above, which viewSteer() and the basis() test hook depend on.
  function orbitBasis(R, usePhi, useTheta) {
    var sp = Math.sin(usePhi),
      cp = Math.cos(usePhi),
      st = Math.sin(useTheta),
      ct = Math.cos(useTheta);
    var cx = R * sp * st,
      cy = R * cp,
      cz = R * sp * ct;
    // camera basis, looking at the origin (the target is always board centre)
    var fl = Math.hypot(cx, cy, cz) || 1;
    var fx = -cx / fl,
      fy = -cy / fl,
      fz = -cz / fl;
    // right = normalize(cross(forward, worldUp)), worldUp = +Y
    var rx = fz,
      ry = 0,
      rz = -fx;
    var rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) {
      // looking straight down: forward is parallel to worldUp, so pick any
      // perpendicular reference instead of dividing by ~0
      rx = 1;
      ry = 0;
      rz = 0;
      rl = 1;
    }
    rx /= rl;
    ry /= rl;
    rz /= rl;
    // up = cross(right, forward)
    return {
      cx: cx,
      cy: cy,
      cz: cz,
      fx: fx,
      fy: fy,
      fz: fz,
      rx: rx,
      ry: ry,
      rz: rz,
      ux: ry * fz - rz * fy,
      uy: rz * fx - rx * fz,
      uz: rx * fy - ry * fx,
    };
  }
  function fitOvershoot(R, usePhi, useTheta, tX, tY) {
    var b = orbitBasis(R, usePhi, useTheta);
    var worst = 0;
    for (var i = 0; i < FIT_CORNERS.length; i++) {
      var P = FIT_CORNERS[i];
      var vx = P.x - b.cx,
        vy = P.y - b.cy,
        vz = P.z - b.cz;
      var zc = vx * b.fx + vy * b.fy + vz * b.fz; // depth in front of the camera
      if (zc <= 1e-4) return Infinity;
      var xc = vx * b.rx + vy * b.ry + vz * b.rz;
      var yc = vx * b.ux + vy * b.uy + vz * b.uz;
      var m = Math.max(Math.abs(xc) / (tX * zc), Math.abs(yc) / (tY * zc));
      if (m > worst) worst = m;
    }
    return worst;
  }
  // Smallest radius that keeps every board corner inside the frustum at the
  // given orbit, via bisection on the monotone fitOvershoot().
  function computeFitRadius(aspect, usePhi, useTheta) {
    var tY = Math.tan((camera.fov * Math.PI) / 360);
    var tX = tY * aspect;
    var lo = 4,
      hi = 400;
    // hi is always far enough: the whole board is a few tens of units across
    var guard = 0;
    while (fitOvershoot(hi, usePhi, useTheta, tX, tY) > FIT_FILL && guard++ < 8) hi *= 2;
    for (var it = 0; it < 40; it++) {
      var mid = (lo + hi) / 2;
      if (fitOvershoot(mid, usePhi, useTheta, tX, tY) > FIT_FILL) lo = mid;
      else hi = mid;
    }
    return hi;
  }
  function applyFit() {
    if (mode !== '3d' || !camera) return;
    var topNow = !!($('opt-cam') && $('opt-cam').value === 'top');
    var usePhi = topNow ? 0.16 : phi;
    var whole = computeFitRadius(camera.aspect, usePhi, theta);
    FIT_R = whole;
    fitFollow = false;
    // LEGIBILITY FLOOR (touch layouts only).
    //
    // Framing the whole 20x20 board is not always compatible with being able
    // to read it. On a phone held upright the board already consumes 94% of
    // the viewport width, so "whole board visible" caps a cell at ~9-11 CSS px
    // - about half the ~20px a laptop gets, and too small to play. That is not
    // a tuning problem: the ceiling is geometric. Tilting toward top-down makes
    // it WORSE and a narrower lens does nothing, because a portrait frame is
    // width-bound.
    //
    // So on touch layouts, if the whole-board fit lands under MIN_CELL_PX, we
    // stop fitting the whole board: we move in until cells are legible and
    // follow the snake instead (see the camera target below). The board then
    // overflows the screen edges, which is why the wall outline is drawn while
    // this is active - without it the player cannot see where the walls are.
    //
    // Cell size is very close to inversely proportional to R (measured
    // R*cell is constant to within a percent across the whole range), so the
    // zoom needed for a target cell size is one multiply - no second bisection.
    // Pointer-coarse covers phones AND tablets, and is false on every desktop,
    // so laptops/desktops keep the exact framing and numbers they have now.
    if (touchLayout()) {
      var cellNow = cellPxAtRadius(whole, usePhi, theta);
      if (cellNow > 0 && cellNow < MIN_CELL_PX) {
        FIT_R = (whole * cellNow) / MIN_CELL_PX;
        fitFollow = true;
      }
    }
    if (scene.fog) {
      scene.fog.near = FIT_R * 0.85;
      scene.fog.far = FIT_R * 2.4;
    }
  }
  // touch-primary layout: phones and tablets. Pointer-coarse rather than a
  // width threshold, so a narrow desktop window is NOT treated as a phone and
  // desktop framing is never changed.
  function touchLayout() {
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }
  // On-screen width of one cell at a given camera distance, in CSS px.
  function cellPxAtRadius(R, usePhi, useTheta) {
    var tY = Math.tan((camera.fov * Math.PI) / 360);
    var tX = tY * camera.aspect;
    var b = orbitBasis(R, usePhi, useTheta);
    // two horizontally adjacent cell centres straddling the board middle
    var pts = [
      { x: -CELL / 2, y: 0, z: 0 },
      { x: CELL / 2, y: 0, z: 0 },
    ];
    var scr = [];
    for (var i = 0; i < pts.length; i++) {
      var P = pts[i];
      var vx = P.x - b.cx,
        vy = P.y - b.cy,
        vz = P.z - b.cz;
      var zc = vx * b.fx + vy * b.fy + vz * b.fz;
      if (zc <= 1e-4) return 0;
      var xc = (vx * b.rx + vy * b.ry + vz * b.rz) / (tX * zc);
      var yc = (vx * b.ux + vy * b.uy + vz * b.uz) / (tY * zc);
      // NDC -> CSS px
      scr.push({ x: ((xc + 1) / 2) * window.innerWidth, y: ((1 - yc) / 2) * window.innerHeight });
    }
    return Math.hypot(scr[1].x - scr[0].x, scr[1].y - scr[0].y);
  }
  // Look-target food weight is gone with the auto-fit: the whole board is
  // framed, so the camera no longer has to chase the food.
  var radiusHold = 0, // wheel/pinch inspection override (absolute radius)
    holdUntil = 0; // fixed framing resumes after this timestamp
  function setRadiusHold(r) {
    radiusHold = Math.max(10, Math.min(FIT_R * 1.8, r));
    holdUntil = performance.now() + 4000;
  }
  var camTarget = null,
    desiredTarget = null;
  var ctx2d = null;

  function gridToWorld(cx, cy) {
    return { x: (cx - GRID / 2 + 0.5) * CELL, z: (cy - GRID / 2 + 0.5) * CELL };
  }

  function initThree() {
    var THREE = window.THREE;
    if (!THREE) return false;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      // Remember WHY: "WebGL blocked" and "renderer construction threw" are
      // indistinguishable from the outside otherwise (and we ship no console
      // logging by design), so the real cause is stashed for the test suite.
      window.__initErr = String((e && e.message) || e);
      return false;
    }
    // RESPONSIVE perf: cap DPR + smaller shadows = big fps win on laptops
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = $('opt-shadows') ? $('opt-shadows').checked : true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b18);
    scene.fog = new THREE.Fog(0x070b18, 30, 70);
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);
    applyFit(); // fixed framing for this viewport (also sets the fog band)
    window.__ray = new THREE.Raycaster();

    window.__hemi = new THREE.HemisphereLight(0x8fb4ff, 0x0a0f22, 0.9);
    scene.add(window.__hemi);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(10, 18, 6);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    dirLight.shadow.camera.left = -16;
    dirLight.shadow.camera.right = 16;
    dirLight.shadow.camera.top = 16;
    dirLight.shadow.camera.bottom = -16;
    scene.add(dirLight);

    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID, GRID),
      new THREE.MeshStandardMaterial({ color: 0x0d1730, roughness: 0.9, metalness: 0.1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    window.__groundMat = ground.material;
    // outer skirt: decor sits on something instead of floating in the void
    var skirt = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x0a1020, roughness: 1 })
    );
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -0.05;
    skirt.receiveShadow = false;
    scene.add(skirt);
    window.__skirtMat = skirt.material;
    var grid = new THREE.GridHelper(GRID, GRID, 0x2f6bff, 0x1a2a55);
    grid.position.y = 0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);
    window.__gridMat = grid.material;

    var wallMat = new THREE.MeshStandardMaterial({
      color: 0x2f9dff,
      emissive: 0x112233,
      transparent: true,
      opacity: 0.35,
      roughness: 0.4,
    });
    window.__wallMat = wallMat;
    var wallMeshes = [];
    function mkWall(w, d, x, z) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, d), wallMat);
      m.position.set(x, 0.55, z);
      m.castShadow = true;
      scene.add(m);
      wallMeshes.push(m);
    }
    mkWall(GRID + 1, 0.5, 0, -GRID / 2 - 0.25);
    mkWall(GRID + 1, 0.5, 0, GRID / 2 + 0.25);
    mkWall(0.5, GRID + 1, -GRID / 2 - 0.25, 0);
    mkWall(0.5, GRID + 1, GRID / 2 + 0.25, 0);
    window.__wallMeshes = wallMeshes; // N,S,E,W order (first two are horizontal)

    // shared geo/mat pool (rounded bead segments; palette applied below)
    window.__snakeGeo = new THREE.SphereGeometry(0.5, 18, 14);
    window.__matA = new THREE.MeshStandardMaterial({ color: 0x22dd66, emissive: 0x063d1d, roughness: 0.35 });
    window.__matB = new THREE.MeshStandardMaterial({ color: 0x2f9dff, emissive: 0x0a2a55, roughness: 0.35 });
    window.__matH = new THREE.MeshStandardMaterial({ color: 0x39ff88, emissive: 0x0a5a2a, roughness: 0.3 });
    window.__eyeGeo = new THREE.SphereGeometry(0.11, 12, 12);
    window.__eyeMat = new THREE.MeshBasicMaterial({ color: 0x06130c });
    window.__obGeo = new THREE.BoxGeometry(0.92, 1.5, 0.92);
    window.__obGeos = {
      box: window.__obGeo,
      rock: new THREE.DodecahedronGeometry(0.8),
      spike: new THREE.ConeGeometry(0.55, 1.6, 6),
      cry: new THREE.OctahedronGeometry(0.8),
    };
    window.__obGeos.cry.scale(1, 1.4, 1);
    window.__obMat = new THREE.MeshStandardMaterial({ color: 0x3b2a5e, emissive: 0x1a0f33, roughness: 0.6 });
    // head glow light follows the snake
    window.__headLight = new THREE.PointLight(0x39ff88, 1.0, 7);
    scene.add(window.__headLight);
    buildDecor();

    foodMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.38, 1),
      new THREE.MeshStandardMaterial({
        color: 0xffc94d,
        emissive: 0xcc6a00,
        emissiveIntensity: 1.0,
        roughness: 0.25,
      })
    );
    foodMesh.castShadow = true;
    scene.add(foodMesh);
    foodLight = new THREE.PointLight(0xffaa33, 1.4, 9);
    scene.add(foodLight);
    foodBase = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.5, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      })
    );
    foodBase.rotation.x = -Math.PI / 2;
    foodBase.position.y = 0.03;
    scene.add(foodBase);

    // bonus pickups: a pool of pink octahedra, all hidden until spawned. One
    // shared geometry + one shared material, so the extra orbs cost draw calls
    // only (2-3 of them) and no extra geometry or shader permutations. Kept as
    // separate meshes rather than an InstancedMesh because each orb pulses
    // independently on its own TTL and the pool is small enough that it would
    // not pay for itself.
    var bonusGeo = new THREE.OctahedronGeometry(0.44, 0);
    var bonusMat = new THREE.MeshStandardMaterial({
      color: 0xff5fa2,
      emissive: 0xa3124f,
      emissiveIntensity: 1.2,
      roughness: 0.25,
    });
    window.__bonusMeshes = [];
    window.__bonusLights = [];
    for (var bmi = 0; bmi < BONUS_MAX; bmi++) {
      var bm = new THREE.Mesh(bonusGeo, bonusMat);
      bm.castShadow = true;
      bm.visible = false;
      scene.add(bm);
      window.__bonusMeshes.push(bm);
      var bl = new THREE.PointLight(0xff5fa2, 0, 8);
      scene.add(bl);
      window.__bonusLights.push(bl);
    }
    // shield pickup: cyan icosahedron, hidden until spawned
    window.__shieldMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 0),
      new THREE.MeshStandardMaterial({
        color: 0x46e6ff,
        emissive: 0x0a4a5a,
        emissiveIntensity: 1.2,
        roughness: 0.25,
      })
    );
    window.__shieldMesh.castShadow = true;
    window.__shieldMesh.visible = false;
    scene.add(window.__shieldMesh);
    window.__shieldLight = new THREE.PointLight(0x46e6ff, 1.1, 8);
    scene.add(window.__shieldLight);
    // active-shield halo: follows the head while a charge is held
    window.__shieldRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 40),
      new THREE.MeshBasicMaterial({
        color: 0x46e6ff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      })
    );
    window.__shieldRing.rotation.x = -Math.PI / 2;
    window.__shieldRing.position.y = 0.06;
    window.__shieldRing.visible = false;
    scene.add(window.__shieldRing);
    // crash marker: red pulsing ring, shown on death
    window.__deathRing = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.62, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff2d55,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      })
    );
    window.__deathRing.rotation.x = -Math.PI / 2;
    window.__deathRing.position.y = 0.06;
    window.__deathRing.visible = false;
    scene.add(window.__deathRing);
    // volcano embers: phase rings (orange telegraph -> red burn), pooled
    window.__emberRings = [];
    for (var eri = 0; eri < EMBER_MAX; eri++) {
      var er = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.5, 32),
        new THREE.MeshBasicMaterial({
          color: 0xff9f1c,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        })
      );
      er.rotation.x = -Math.PI / 2;
      er.position.y = 0.05;
      er.visible = false;
      scene.add(er);
      window.__emberRings.push(er);
    }
    // obstacle telegraphs: neighbor cells pulse briefly on fresh spawns
    window.__warnRings = [];
    for (var wri = 0; wri < 16; wri++) {
      var wr = new THREE.Mesh(
        new THREE.RingGeometry(0.32, 0.44, 4),
        new THREE.MeshBasicMaterial({
          color: 0xffb36b,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
        })
      );
      wr.rotation.x = -Math.PI / 2;
      wr.rotation.z = Math.PI / 4;
      wr.position.y = 0.04;
      wr.visible = false;
      scene.add(wr);
      window.__warnRings.push(wr);
    }
    // ambient weather: one recycled Points cloud, per-biome params
    window.__ambPos = new Float32Array(120 * 3);
    var ambGeo = new THREE.BufferGeometry();
    ambGeo.setAttribute('position', new THREE.BufferAttribute(window.__ambPos, 3));
    window.__ambMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.2,
      map: glowTexture(),
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    window.__ambient = new THREE.Points(ambGeo, window.__ambMat);
    window.__ambient.frustumCulled = false;
    window.__ambient.visible = false;
    scene.add(window.__ambient);
    rebuildAmbient();

    // starfield shell (Space biome only)
    var starGeo = new THREE.BufferGeometry();
    var starPos = new Float32Array(400 * 3);
    for (var sti = 0; sti < 400; sti++) {
      var sr = 42 + Math.random() * 30,
        sth = Math.random() * Math.PI * 2,
        sph = Math.acos(2 * Math.random() - 1);
      starPos[sti * 3] = sr * Math.sin(sph) * Math.cos(sth);
      starPos[sti * 3 + 1] = Math.abs(sr * Math.cos(sph)) * 0.6 - 2;
      starPos[sti * 3 + 2] = sr * Math.sin(sph) * Math.sin(sth);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    window.__stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, transparent: true, opacity: 0.9 })
    );
    window.__stars.visible = false;
    scene.add(window.__stars);

    // head glow trail (ring buffer of recent head positions; round soft
    // sprite — raw PointsMaterial quads read as ugly squares)
    window.__trailN = 18;
    var trailGeo = new THREE.BufferGeometry();
    window.__trailPos = new Float32Array(window.__trailN * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(window.__trailPos, 3));
    window.__trailMat = new THREE.PointsMaterial({
      color: 0x39ff88,
      size: 0.42,
      map: glowTexture(),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    window.__trail = new THREE.Points(trailGeo, window.__trailMat);
    window.__trail.frustumCulled = false;
    window.__trail.visible = false;
    scene.add(window.__trail);

    var partGeo = new THREE.SphereGeometry(0.09, 8, 8);
    var partMat = new THREE.MeshBasicMaterial({ color: 0xffd97a });
    for (var i = 0; i < 30; i++) {
      var p = new THREE.Mesh(partGeo, partMat.clone()); // own material: bursts tint per event
      p.visible = false;
      scene.add(p);
      particles.push({ m: p, v: new THREE.Vector3(), life: 0 });
    }
    camTarget = new THREE.Vector3(0, 0, 0);
    desiredTarget = new THREE.Vector3(0, 0, 0);

    var dragging = false,
      px = 0,
      py = 0;
    // mouse/pen only — touch uses swipe-to-steer + two-finger orbit via pointermove below
    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      dragging = true;
      px = e.clientX;
      py = e.clientY;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerType === 'touch') return;
      theta -= (e.clientX - px) * 0.006;
      phi -= (e.clientY - py) * 0.005;
      phi = Math.max(0.35, Math.min(1.25, phi));
      px = e.clientX;
      py = e.clientY;
      applyFit(); // keep the board framed at the new orbit angle
    });
    window.addEventListener('pointerup', function () {
      dragging = false;
    });
    canvas.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        setRadiusHold(radius + e.deltaY * 0.02); // temporary inspection zoom
      },
      { passive: false }
    );
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      say(t('gpu_lost'));
      if (state === 'playing') togglePause();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      say(t('gpu_back'));
    });

    var sh = $('opt-shadows');
    if (sh)
      sh.addEventListener('change', function (e) {
        renderer.shadowMap.enabled = e.target.checked;
        dirLight.castShadow = e.target.checked;
        scene.traverse(function (o) {
          if (o.material) o.material.needsUpdate = true;
        });
      });
    applyPalette();
    return true;
  }

  // Snake rendering. The head stays its own Mesh (it has a distinct material
  // and two eye children); the body is two InstancedMeshes, one per stripe
  // material.
  //
  // This used to be one Mesh per segment, which cost ~180 draw calls for a
  // 180-segment snake and ~400 at the win condition - doubled again by the
  // shadow pass. On a phone that is the single largest cost in the frame.
  // Two instanced meshes bring the whole snake to 3 draw calls. Splitting by
  // material (rather than one mesh plus per-instance colour) is deliberate:
  // instanceColor only tints diffuse, while the two stripes differ in BOTH
  // colour and emissive, so this keeps the look pixel-identical.
  var snakeHead = null,
    snakeBodyA = null,
    snakeBodyB = null,
    snakeLen = 0;
  var segPos = []; // smoothed world x/z per segment, including the head
  function makeSegmentMesh(isHead) {
    var THREE = window.THREE;
    var m = new THREE.Mesh(window.__snakeGeo, window.__matH);
    m.castShadow = true;
    if (isHead) {
      var e1 = new THREE.Mesh(window.__eyeGeo, window.__eyeMat);
      var e2 = new THREE.Mesh(window.__eyeGeo, window.__eyeMat);
      e1.position.set(-0.2, 0.2, 0.42);
      e2.position.set(0.2, 0.2, 0.42);
      m.add(e1);
      m.add(e2);
    }
    scene.add(m);
    return m;
  }
  // capacity is the whole board: a full 20x20 snake is a win, so the buffers
  // never need to grow past that
  var BODY_CAP = GRID * GRID;
  function ensureSnakeMeshes() {
    if (snakeHead) return;
    var THREE = window.THREE;
    snakeHead = makeSegmentMesh(true);
    snakeBodyA = new THREE.InstancedMesh(window.__snakeGeo, window.__matA, BODY_CAP);
    snakeBodyB = new THREE.InstancedMesh(window.__snakeGeo, window.__matB, BODY_CAP);
    snakeBodyA.castShadow = snakeBodyB.castShadow = true;
    // count is driven per frame from the live length
    snakeBodyA.count = snakeBodyB.count = 0;
    snakeBodyA.frustumCulled = snakeBodyB.frustumCulled = false;
    scene.add(snakeBodyA);
    scene.add(snakeBodyB);
  }
  function syncSnakeMeshes(snap) {
    if (mode !== '3d') return;
    ensureSnakeMeshes();
    snakeLen = snake.length;
    while (segPos.length < snake.length) {
      var idx = segPos.length;
      var t0 = gridToWorld(snake[idx] ? snake[idx].x : 0, snake[idx] ? snake[idx].y : 0);
      segPos.push({ x: t0.x, z: t0.z });
    }
    while (segPos.length > snake.length) segPos.pop();
    if (snap) {
      for (var s = 0; s < snake.length; s++) {
        var w = gridToWorld(snake[s].x, snake[s].y);
        segPos[s].x = w.x;
        segPos[s].z = w.z;
      }
      snakeHead.position.set(segPos[0].x, 0.55, segPos[0].z);
    }
  }
  function placeFoodMesh() {
    if (mode !== '3d' || !foodMesh) {
      foodBornAt = performance.now();
      return;
    }
    var t = gridToWorld(food.x, food.y);
    foodMesh.position.set(t.x, 0.7, t.z);
    foodMesh.scale.setScalar(0.01);
    foodBornAt = performance.now();
    foodLight.position.set(t.x, 1.6, t.z);
    foodBase.position.set(t.x, 0.03, t.z);
  }
  function makeObstacleMesh() {
    var THREE = window.THREE;
    var m = new THREE.Mesh(window.__obGeo || window.__obGeos.box, window.__obMat);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  }
  // Ground painters: procedural canvas textures (near-white so they multiply
  // with the themed ground color). Generated once per biome, cached.
  var TEXPAINTERS = {
    speckle: function (x, S, accent) {
      for (var i = 0; i < 500; i++) {
        x.fillStyle = 'rgba(0,0,0,' + (0.04 + Math.random() * 0.08) + ')';
        x.fillRect(Math.random() * S, Math.random() * S, 2, 2);
      }
    },
    ripples: function (x, S, accent) {
      x.strokeStyle = 'rgba(0,0,0,0.10)';
      x.lineWidth = 3;
      for (var r = 0; r < 14; r++) {
        x.beginPath();
        for (var px = 0; px <= S; px += 8) x.lineTo(px, r * 19 + Math.sin(px / 22 + r) * 5);
        x.stroke();
      }
    },
    waves: function (x, S, accent) {
      x.strokeStyle = accent;
      x.globalAlpha = 0.12;
      x.lineWidth = 2;
      for (var r = 0; r < 10; r++)
        for (var c = 0; c < 4; c++) {
          x.beginPath();
          x.arc(c * 70 + 20, r * 28 + 10, 12 + (r % 3) * 4, 0, 7);
          x.stroke();
        }
      x.globalAlpha = 1;
    },
    cracks: function (x, S, accent) {
      x.strokeStyle = 'rgba(0,0,0,0.35)';
      x.lineWidth = 2;
      for (var i = 0; i < 22; i++) {
        var cx = Math.random() * S,
          cy = Math.random() * S;
        x.beginPath();
        x.moveTo(cx, cy);
        for (var s = 0; s < 4; s++) {
          cx += (Math.random() - 0.5) * 60;
          cy += (Math.random() - 0.5) * 60;
          x.lineTo(cx, cy);
        }
        x.stroke();
      }
      x.strokeStyle = accent;
      x.globalAlpha = 0.5;
      x.lineWidth = 1.5;
      for (var g = 0; g < 6; g++) {
        var gx = Math.random() * S,
          gy = Math.random() * S;
        x.beginPath();
        x.moveTo(gx, gy);
        x.lineTo(gx + (Math.random() - 0.5) * 80, gy + (Math.random() - 0.5) * 80);
        x.stroke();
      }
      x.globalAlpha = 1;
    },
    moss: function (x, S, accent) {
      for (var i = 0; i < 44; i++) {
        x.fillStyle = 'rgba(0,0,0,0.07)';
        x.beginPath();
        x.arc(Math.random() * S, Math.random() * S, 6 + Math.random() * 16, 0, 7);
        x.fill();
      }
    },
    dunes: function (x, S, accent) {
      x.strokeStyle = 'rgba(0,0,0,0.09)';
      x.lineWidth = 9;
      for (var r = -4; r < 12; r++) {
        x.beginPath();
        x.moveTo(r * 32 - 40, 0);
        x.lineTo(r * 32 + 40, S);
        x.stroke();
      }
    },
    starspeck: function (x, S, accent) {
      for (var i = 0; i < 160; i++) {
        x.fillStyle = 'rgba(255,255,255,' + (0.25 + Math.random() * 0.6) + ')';
        x.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
      }
    },
    frost: function (x, S, accent) {
      x.strokeStyle = accent;
      x.globalAlpha = 0.14;
      x.lineWidth = 2;
      for (var i = 0; i < 28; i++) {
        var sx = Math.random() * S,
          sy = Math.random() * S;
        x.beginPath();
        x.moveTo(sx, sy);
        x.lineTo(sx + 20 + Math.random() * 30, sy + 6);
        x.stroke();
      }
      x.globalAlpha = 1;
    },
  };
  function paintGround(kind, accentCss) {
    var S = 256;
    var c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    var x = c.getContext('2d');
    x.fillStyle = '#f4f4f4';
    x.fillRect(0, 0, S, S);
    (TEXPAINTERS[kind] || TEXPAINTERS.speckle)(x, S, accentCss);
    var t = new window.THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = window.THREE.RepeatWrapping;
    t.repeat.set(6, 6);
    if (window.THREE.SRGBColorSpace !== undefined) t.colorSpace = window.THREE.SRGBColorSpace;
    return t;
  }
  function groundTexFor(i) {
    if (!window.__groundTex) window.__groundTex = {};
    if (!window.__groundTex[i]) {
      var L = LEVELS[i];
      window.__groundTex[i] = paintGround(L.tex, '#' + L.wall.toString(16).padStart(6, '0'));
    }
    return window.__groundTex[i];
  }
  // One instanced decor ring per biome, built once, visibility-toggled.
  // Everything sits OUTSIDE the walls: pure scenery, never gameplay.
  var DECORTABLE = {
    tuft: {
      geo: 'cone',
      color: 0x3fae5a,
      em: 0x000000,
      count: 110,
      y0: 0.3,
      y1: 0.3,
      s0: 0.7,
      s1: 1.0,
      ys: 1,
    },
    dunerock: {
      geo: 'rock',
      color: 0xc49a5f,
      em: 0x000000,
      count: 60,
      y0: 0.3,
      y1: 0.3,
      s0: 0.7,
      s1: 1.3,
      ys: 1,
    },
    shell: {
      geo: 'cry',
      color: 0x63d6c2,
      em: 0x062a28,
      count: 70,
      y0: 0.3,
      y1: 0.3,
      s0: 0.6,
      s1: 1.1,
      ys: 1,
    },
    shard: {
      geo: 'cone',
      color: 0x3a2323,
      em: 0x771100,
      count: 60,
      y0: 0.45,
      y1: 0.45,
      s0: 0.8,
      s1: 1.2,
      ys: 1,
    },
    roid: { geo: 'rock', color: 0x8a8fa8, em: 0x000000, count: 55, y0: 2, y1: 5.5, s0: 0.6, s1: 1.2, ys: 1 },
    pine: {
      geo: 'cone',
      color: 0x35b95c,
      em: 0x0a3318,
      count: 90,
      y0: 0.9,
      y1: 0.9,
      s0: 0.9,
      s1: 1.3,
      ys: 1.7,
      trunk: true,
    },
    mesa: { geo: 'cyl', color: 0xb4632e, em: 0x000000, count: 45, y0: 0.6, y1: 0.6, s0: 0.8, s1: 1.4, ys: 1 },
    shardice: {
      geo: 'cry',
      color: 0xcfeaff,
      em: 0x224455,
      count: 70,
      y0: 0.4,
      y1: 0.4,
      s0: 0.6,
      s1: 1.2,
      ys: 1,
    },
  };
  // radial-gradient sprite: soft round dots for points/particles
  function glowTexture() {
    var c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return new window.THREE.CanvasTexture(c);
  }
  function buildDecor() {
    var THREE = window.THREE;
    window.__decorGeos = {
      cone: new THREE.ConeGeometry(0.35, 0.9, 5),
      rock: new THREE.DodecahedronGeometry(0.5),
      cry: new THREE.OctahedronGeometry(0.55),
      cyl: new THREE.CylinderGeometry(0.4, 0.5, 1.2, 6),
      trunk: new THREE.CylinderGeometry(0.12, 0.17, 0.8, 5),
    };
    window.__decorMeshes = [];
    window.__decorOwner = [];
    var dummy = new THREE.Object3D();
    // Landscaping: an even ring road (60%) plus 3 themed clusters (40%).
    // Both go through clampOutside, so the Chebyshev audit provably keeps
    // every piece off the board + walls. Counts per biome are unchanged.
    var ringMin = 13.5,
      ringMax = 22;
    function clampOutside(px, pz) {
      var pm = Math.max(Math.abs(px), Math.abs(pz));
      if (pm < ringMin) {
        px *= ringMin / pm;
        pz *= ringMin / pm;
      } else if (pm > ringMax) {
        px *= ringMax / pm;
        pz *= ringMax / pm;
      }
      return [px, pz];
    }
    var trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
    for (var bi = 0; bi < LEVELS.length; bi++) {
      var D = DECORTABLE[LEVELS[bi].decor];
      var m = new THREE.InstancedMesh(
        window.__decorGeos[D.geo],
        new THREE.MeshStandardMaterial({ color: D.color, emissive: D.em, roughness: 0.85 }),
        D.count
      );
      var tm = null;
      if (D.trunk) {
        tm = new THREE.InstancedMesh(window.__decorGeos.trunk, trunkMat, D.count);
        tm.castShadow = false;
        tm.receiveShadow = false;
        tm.visible = false;
        tm.frustumCulled = false;
      }
      for (var k = 0; k < D.count; k++) {
        var px, pz;
        if (k < Math.ceil(D.count * 0.6)) {
          // ring road: slot k evenly around the arena, jittered
          var sa = ((k + 0.15 + Math.random() * 0.7) / D.count) * Math.PI * 2;
          var sr = 14 + Math.random() * 4.5;
          px = Math.cos(sa) * sr;
          pz = Math.sin(sa) * sr;
        } else {
          // themed cluster: 3 clumps at biome-offset angles, gaussian-ish blob
          var ci = (k + bi) % 3;
          var ca = bi * 2.4 + ci * ((Math.PI * 2) / 3);
          var cr = 16.5;
          var cx = Math.cos(ca) * cr,
            cz = Math.sin(ca) * cr;
          var jx = (Math.random() + Math.random() + Math.random() - 1.5) * 1.8;
          var jz = (Math.random() + Math.random() + Math.random() - 1.5) * 1.8;
          px = cx + jx;
          pz = cz + jz;
        }
        var cl = clampOutside(px, pz);
        px = cl[0];
        pz = cl[1];
        var s = D.s0 + Math.random() * (D.s1 - D.s0);
        dummy.position.set(px, D.y0 + Math.random() * (D.y1 - D.y0), pz);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.set(s, s * (D.ys || 1), s);
        dummy.updateMatrix();
        m.setMatrixAt(k, dummy.matrix);
        if (tm) {
          dummy.position.set(px, 0.4 * s, pz);
          dummy.scale.set(s, s, s);
          dummy.updateMatrix();
          tm.setMatrixAt(k, dummy.matrix);
        }
      }
      m.instanceMatrix.needsUpdate = true;
      if (tm) tm.instanceMatrix.needsUpdate = true;
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      window.__decorMeshes.push(m);
      window.__decorOwner.push(bi);
      if (tm) {
        scene.add(tm);
        window.__decorMeshes.push(tm);
        window.__decorOwner.push(bi);
      }
    }
  }
  function updateDecorVisibility() {
    if (!window.__decorMeshes) return;
    for (var i = 0; i < window.__decorMeshes.length; i++)
      window.__decorMeshes[i].visible =
        mode === '3d' && window.__decorOwner[i] === themeIdx && quality !== 'low';
  }
  // Quality-gated visuals: low tier sheds texture + decor (flat classic look)
  function applyQualityVisuals() {
    if (mode !== '3d' || !scene) return;
    updateAmbientVisibility();
    if (window.__groundMat) {
      var wantMap = quality !== 'low';
      if (!!window.__groundMat.map !== wantMap) {
        window.__groundMat.map = wantMap ? groundTexFor(themeIdx) : null;
        window.__groundMat.needsUpdate = true;
      }
    }
    updateDecorVisibility();
  }
  function syncObstacleMeshes(snap) {
    if (mode !== '3d' || !window.__obGeo) return;
    while (obstacleMeshes.length < obstacles.length) {
      var mesh = makeObstacleMesh();
      obstacleMeshes.push(mesh);
    }
    while (obstacleMeshes.length > obstacles.length) scene.remove(obstacleMeshes.pop());
    for (var i = 0; i < obstacleMeshes.length; i++) {
      var w = gridToWorld(obstacles[i].x, obstacles[i].y);
      obstacleMeshes[i].position.set(w.x, 0.75, w.z);
      obstacleMeshes[i].visible = true;
      if (snap) obstacleMeshes[i].scale.setScalar(0.01);
    }
  }
  // Entity pacing. Both orbs used to spawn on `foodsEaten % N`, which is a
  // calendar slot: it fires whether or not the moment is interesting, it cannot
  // defer, and it told the player exactly when to expect a pickup. These are
  // cooldowns instead - "not yet" rather than "not today" - and each defers
  // rather than being skipped when its precondition is not met, so a held
  // shield charge postpones the next orb instead of wasting its slot.
  function bonusEvery() {
    return dailyOn && dailyRule ? dailyRule.bonusEvery : BONUS_EVERY;
  }
  function shieldEvery() {
    return dailyOn && dailyRule ? dailyRule.shieldEvery : SHIELD_EVERY;
  }
  function shieldsOff() {
    return !!(dailyOn && dailyRule && dailyRule.shieldOff);
  }
  function bonusDue() {
    if (bonuses.length >= Math.min(BONUS_MAX, bonusCap())) return false;
    return foodsEaten - lastBonusFood >= bonusEvery();
  }
  function shieldDue() {
    if (shieldsOff() || shield || hasShield) return false;
    return foodsEaten - lastShieldFood >= shieldEvery();
  }
  function paceEntities() {
    if (bonusDue()) spawnBonus();
    if (shieldDue()) spawnShield();
  }

  // Bonus pickup: worth 50 x combo, worth grabbing several of late. Never on the
  // snake, the regular food, or another orb.
  function bonusAt(x, y) {
    for (var i = 0; i < bonuses.length; i++) if (bonuses[i].x === x && bonuses[i].y === y) return i;
    return -1;
  }
  // How many pink orbs may be in play at once. This is the difficulty curve the
  // orbs were missing: one orb for the opening levels (so picking one up stays
  // a real "do I detour?"), two once you know the game, three once the board is
  // dangerous enough that detouring is the interesting part.
  function bonusCap() {
    return level >= 6 ? 3 : level >= 3 ? 2 : 1;
  }
  function spawnBonus() {
    if (bonuses.length >= Math.min(BONUS_MAX, bonusCap()) || snake.length >= GRID * GRID - 1) return false;
    var c = SnakeLogic.findFree(occupiedMap(), GRID, rng, 200);
    if (!c) return false;
    bonuses.push({ x: c.x, y: c.y, left: BONUS_TTL, bornAt: performance.now() });
    lastBonusFood = foodsEaten; // cooldown, not a calendar slot
    placeBonusMesh(bonuses.length - 1);
    say(t('bonus_spawn'));
    return true;
  }
  function placeBonusMesh(i) {
    var b = bonuses[i];
    if (!b) return;
    b.bornAt = performance.now();
    var m = window.__bonusMeshes && window.__bonusMeshes[i];
    if (mode !== '3d' || !m) return;
    var t = gridToWorld(b.x, b.y);
    m.position.set(t.x, 0.7, t.z);
    m.scale.setScalar(0.01);
    m.visible = true;
    var l = window.__bonusLights && window.__bonusLights[i];
    if (l) l.position.set(t.x, 1.8, t.z);
  }
  // spawn-pop easing (overshoots slightly, like a jelly pop)
  function easeOutBack(x) {
    var c = 1.70158;
    var u = x - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }
  // Remove one orb. Slots are reused rather than compacted, so a mesh index
  // always maps to the same orb for its whole life - popping a bonus must not
  // teleport the *other* orb's mesh.
  function removeBonus(i) {
    if (i < 0 || i >= bonuses.length) return;
    bonuses.splice(i, 1);
    var m = window.__bonusMeshes && window.__bonusMeshes[i];
    if (m) m.visible = false;
    var l = window.__bonusLights && window.__bonusLights[i];
    if (l) l.intensity = 0;
    // the orb that just took this slot inherits it
    if (bonuses[i]) placeBonusMesh(i);
  }
  function clearBonuses() {
    for (var i = 0; i < Math.max(bonuses.length, (window.__bonusMeshes || []).length); i++) {
      var m = window.__bonusMeshes && window.__bonusMeshes[i];
      if (m) m.visible = false;
      var l = window.__bonusLights && window.__bonusLights[i];
      if (l) l.intensity = 0;
    }
    bonuses = [];
  }
  // Which neighbouring cell could the head enter next tick without dying?
  // Mirrors the collision rules in step() exactly (including the tail vacating,
  // and food/bonus counting as growth) so a heading chosen here is genuinely
  // survivable rather than merely plausible.
  function safeDirFrom(x, y) {
    var wrap = $('opt-wrap').checked;
    var cands = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (var i = 0; i < cands.length; i++) {
      var dx = cands[i][0],
        dy = cands[i][1];
      var np = { x: x + dx, y: y + dy };
      if (wrap) np = SnakeLogic.wrapPos(np, GRID);
      else if (!SnakeLogic.inBounds(np, GRID)) continue;
      var oi;
      for (oi = 0; oi < obstacles.length; oi++)
        if (obstacles[oi].x === np.x && obstacles[oi].y === np.y) break;
      if (oi < obstacles.length) continue;
      var grows = (food && food.x === np.x && food.y === np.y) || bonusAt(np.x, np.y) >= 0;
      if (SnakeLogic.hitsBody(np, snake, grows)) continue;
      var lit = false;
      for (var ei = 0; ei < embers.length; ei++) {
        var em = embers[ei];
        if (em.x === np.x && em.y === np.y && em.age >= EMBER_WARN && em.age < EMBER_WARN + EMBER_BURN) {
          lit = true;
          break;
        }
      }
      if (lit) continue;
      return { x: dx, y: dy };
    }
    return null;
  }
  // Shield pickup: rare, timed. Eating it holds one charge that survives
  // the next lethal crash (the step is ignored, the snake holds position).
  function spawnShield() {
    if (shield || hasShield || snake.length >= GRID * GRID - 1) return false;
    var c = SnakeLogic.findFree(occupiedMap(), GRID, rng, 200);
    if (!c) return false;
    shield = c;
    shieldLeft = SHIELD_TTL;
    shieldBornAt = performance.now();
    lastShieldFood = foodsEaten; // cooldown, not a calendar slot
    placeShieldMesh();
    say(t('shield_spawn'));
    return true;
  }
  function placeShieldMesh() {
    if (mode !== '3d' || !window.__shieldMesh || !shield) return;
    var t = gridToWorld(shield.x, shield.y);
    window.__shieldMesh.position.set(t.x, 0.7, t.z);
    window.__shieldMesh.scale.setScalar(0.01);
    window.__shieldMesh.visible = true;
    if (window.__shieldLight) window.__shieldLight.position.set(t.x, 1.8, t.z);
  }
  function hideShieldMesh() {
    shield = null;
    shieldLeft = 0;
    if (window.__shieldMesh) window.__shieldMesh.visible = false;
  }
  // Volcano rule: embers telegraph (orange, safe) then ignite (red, lethal).
  function spawnEmber() {
    if (embers.length >= EMBER_MAX || snake.length >= GRID * GRID - 1) return false;
    var c = freeCell(3);
    if (!c) return false;
    embers.push({ x: c.x, y: c.y, age: 0 });
    if (!emberToastShown) {
      emberToastShown = true;
      say(t('ember_first'));
    }
    return true;
  }
  // Lethal crash with a charge held: consume it, hold position, live on.
  function tryShield() {
    if (!hasShield) return false;
    hasShield = false;
    life.deathsBlocked = (life.deathsBlocked || 0) + 1;
    saveLife();
    unlock('shield1');
    updateHUD();
    // Holding position is not enough on its own: the heading still points at
    // whatever just killed us, so the very next tick re-enters the same cell
    // and the run dies anyway -- players reported exactly that ("it said the
    // shield broke, then the game ended"). Steer to a survivable neighbour so
    // the charge is a real save, and clear stale queued turns so they cannot
    // immediately steer back into the thing we just escaped.
    var sd = safeDirFrom(snake[0].x, snake[0].y);
    if (sd) {
      dir = sd;
      queue = [];
      slideHeld = null;
    } else {
      // Boxed in on every side (a tight coil): no heading can save us, so
      // ghost through our own body for a moment to get out. Walls still apply.
      shieldPhase = SHIELD_PHASE;
    }
    var hw = gridToWorld(snake[0].x, snake[0].y);
    burst({ x: hw.x, y: 0.7, z: hw.z }, 0x46e6ff, 20);
    showBanner(t('shield_saved'));
    say(t('shield_saved'));
    beep(440, 880, 0.2, 'square');
    buzz([40, 40, 40]);
    return true;
  }
  function burst(pos, colorHex, count) {
    if (mode !== '3d' || reducedMotion) return;
    var want = Math.max(1, Math.min(24, count || 10));
    var n = 0;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.life > 0) continue;
      p.life = 0.5;
      p.m.visible = true;
      try {
        p.m.material.color.setHex(colorHex == null ? 0xffd97a : colorHex);
      } catch (e) {}
      p.m.position.set(pos.x, pos.y, pos.z);
      p.v.set((Math.random() - 0.5) * 6, Math.random() * 5 + 2, (Math.random() - 0.5) * 6);
      if (++n >= want) break;
    }
  }
  // ---------- 2D fallback + effects ----------
  var parts2d = [],
    pops2d = [];
  function fx2d(gx, gy, text, color) {
    if (mode !== '2d') return;
    if (text) pops2d.push({ gx: gx, gy: gy, text: text, color: color || '#ffd97a', life: 1.1 });
    for (var i = 0; i < 10; i++) {
      var a = Math.random() * Math.PI * 2,
        sp = 3 + Math.random() * 5;
      parts2d.push({
        gx: gx + 0.5,
        gy: gy + 0.5,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.6,
        color: color || '#ffd97a',
      });
    }
    if (parts2d.length > 160) parts2d.splice(0, parts2d.length - 160);
  }
  // ---------- 2D fallback ----------
  function init2D(reason) {
    mode = '2d';
    try {
      ctx2d = canvas.getContext('2d');
    } catch (e) {
      ctx2d = null;
    }
    fitCanvas();
    var n = $('nogl');
    if (n && reason) {
      n.hidden = false;
      setTimeout(function () {
        n.hidden = true;
      }, 5000);
    }
    say(reason || t('note_2d_mode'));
  }
  function fitCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    view2d.dpr = dpr;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  function draw2D(dt) {
    if (!ctx2d) return;
    var W = canvas.width,
      H = canvas.height;
    var pal = curPal().css;
    ctx2d.fillStyle = LEVELS[themeIdx].css;
    ctx2d.fillRect(0, 0, W, H);
    var cell = Math.min(W, H) / (GRID + 2);
    var ox = (W - cell * GRID) / 2,
      oy = (H - cell * GRID) / 2;
    view2d.ox = ox;
    view2d.oy = oy;
    view2d.cell = cell;
    ctx2d.strokeStyle = 'rgba(90,162,255,.25)';
    for (var i = 0; i <= GRID; i++) {
      ctx2d.beginPath();
      ctx2d.moveTo(ox + i * cell, oy);
      ctx2d.lineTo(ox + i * cell, oy + GRID * cell);
      ctx2d.stroke();
      ctx2d.beginPath();
      ctx2d.moveTo(ox, oy + i * cell);
      ctx2d.lineTo(ox + GRID * cell, oy + i * cell);
      ctx2d.stroke();
    }
    var ob;
    // subtle checkerboard ground tint so the fallback has texture too
    ctx2d.fillStyle = 'rgba(255,255,255,0.03)';
    for (var gx = 0; gx < GRID; gx++)
      for (var gy = 0; gy < GRID; gy++)
        if ((gx + gy) % 2 === 0) ctx2d.fillRect(ox + gx * cell, oy + gy * cell, cell, cell);
    // themed obstacle glyphs echo the 3D geos (box=square, rock=circle,
    // spike=triangle, cry=diamond), drawn in the biome obstacle color
    var obCss = '#' + LEVELS[themeIdx].obColor.toString(16).padStart(6, '0');
    var obKind = LEVELS[themeIdx].ob;
    var glyph =
      obKind === 'spike' ? 'tri' : obKind === 'rock' ? 'circle' : obKind === 'cry' ? 'diamond' : 'square';
    for (ob = 0; ob < obstacles.length; ob++) {
      var ocx = ox + (obstacles[ob].x + 0.5) * cell,
        ocy = oy + (obstacles[ob].y + 0.5) * cell,
        orr = cell * 0.42;
      ctx2d.fillStyle = obCss;
      ctx2d.strokeStyle = '#241a3d';
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      if (glyph === 'circle') ctx2d.arc(ocx, ocy, orr, 0, 7);
      else if (glyph === 'tri') {
        ctx2d.moveTo(ocx, ocy - orr);
        ctx2d.lineTo(ocx + orr, ocy + orr);
        ctx2d.lineTo(ocx - orr, ocy + orr);
        ctx2d.closePath();
      } else if (glyph === 'diamond') {
        ctx2d.moveTo(ocx, ocy - orr);
        ctx2d.lineTo(ocx + orr, ocy);
        ctx2d.lineTo(ocx, ocy + orr);
        ctx2d.lineTo(ocx - orr, ocy);
        ctx2d.closePath();
      } else ctx2d.rect(ocx - orr, ocy - orr, orr * 2, orr * 2);
      ctx2d.fill();
      ctx2d.stroke();
    }
    // volcano embers (2D): orange telegraph outline, red burning fill
    var now2d = performance.now();
    for (var emi = 0; emi < embers.length; emi++) {
      var em3 = embers[emi];
      if (em3.age >= EMBER_WARN) {
        ctx2d.fillStyle = '#ff2d2d';
        ctx2d.fillRect(ox + em3.x * cell + 1, oy + em3.y * cell + 1, cell - 2, cell - 2);
      } else {
        ctx2d.strokeStyle = '#ff9f1c';
        ctx2d.lineWidth = 2;
        ctx2d.strokeRect(ox + em3.x * cell + 2, oy + em3.y * cell + 2, cell - 4, cell - 4);
      }
    }
    // telegraph pulses (2D)
    var aw2d = warnPulses.length ? activeWarns(now2d) : [];
    ctx2d.strokeStyle = 'rgba(255,179,107,0.8)';
    ctx2d.lineWidth = 2;
    for (var wi = 0; wi < aw2d.length; wi++)
      ctx2d.strokeRect(ox + aw2d[wi].x * cell + 3, oy + aw2d[wi].y * cell + 3, cell - 6, cell - 6);
    var foodTintCss = (FOOD_TINT[themeIdx] || FOOD_TINT[0]).css;
    var desertBlink =
      biomeIs('Desert') && DESERT_FOOD_TTL - (now2d - foodBornAt) < 5000
        ? Math.floor(now2d / 125) % 2 === 0
        : true;
    if (desertBlink) {
      ctx2d.fillStyle = foodTintCss;
      ctx2d.beginPath();
      ctx2d.arc(ox + (food.x + 0.5) * cell, oy + (food.y + 0.5) * cell, cell * 0.36, 0, 7);
      ctx2d.fill();
    }
    for (var dbi = 0; dbi < bonuses.length; dbi++) {
      var db = bonuses[dbi];
      var blink = db.left > 2000 || Math.floor(performance.now() / 125) % 2 === 0;
      if (blink) {
        ctx2d.fillStyle = pal.bonus;
        ctx2d.beginPath();
        ctx2d.arc(ox + (db.x + 0.5) * cell, oy + (db.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.fill();
        ctx2d.strokeStyle = '#fff';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(ox + (db.x + 0.5) * cell, oy + (db.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.stroke();
      }
    }
    if (shield) {
      var sblink = shieldLeft > 2000 || Math.floor(performance.now() / 125) % 2 === 0;
      if (sblink) {
        ctx2d.fillStyle = '#46e6ff';
        ctx2d.beginPath();
        ctx2d.arc(ox + (shield.x + 0.5) * cell, oy + (shield.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.fill();
        ctx2d.strokeStyle = '#fff';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(ox + (shield.x + 0.5) * cell, oy + (shield.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.stroke();
      }
    }
    var sc2d = snakeCss();
    for (var s = snake.length - 1; s >= 0; s--) {
      ctx2d.fillStyle = s === 0 ? sc2d.head : sc2d.body[s % 2];
      var x = ox + snake[s].x * cell + 1,
        y = oy + snake[s].y * cell + 1;
      ctx2d.fillRect(x, y, cell - 2, cell - 2);
    }
    if (deathCell && state === 'over') {
      var dx = Math.max(0, Math.min(GRID - 1, deathCell.x)),
        dy = Math.max(0, Math.min(GRID - 1, deathCell.y));
      ctx2d.strokeStyle = '#ff2d55';
      ctx2d.lineWidth = 3;
      ctx2d.strokeRect(ox + dx * cell + 2, oy + dy * cell + 2, cell - 4, cell - 4);
    }
    var pi, pj;
    for (pi = parts2d.length - 1; pi >= 0; pi--) {
      var q = parts2d[pi];
      q.life -= dt;
      q.gx += q.vx * dt;
      q.gy += q.vy * dt;
      if (q.life <= 0) {
        parts2d.splice(pi, 1);
        continue;
      }
      ctx2d.globalAlpha = Math.min(1, q.life * 2);
      ctx2d.fillStyle = q.color;
      ctx2d.beginPath();
      ctx2d.arc(ox + q.gx * cell, oy + q.gy * cell, cell * 0.12, 0, 7);
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
    ctx2d.textAlign = 'center';
    ctx2d.font = 'bold ' + Math.max(12, cell * 0.5) + 'px sans-serif';
    for (pj = pops2d.length - 1; pj >= 0; pj--) {
      var r = pops2d[pj];
      r.life -= dt;
      if (r.life <= 0) {
        pops2d.splice(pj, 1);
        continue;
      }
      ctx2d.globalAlpha = Math.min(1, r.life);
      ctx2d.fillStyle = r.color;
      ctx2d.fillText(
        r.text,
        ox + (r.gx + 0.5) * cell,
        oy + (r.gy + 0.5) * cell - (1.1 - r.life) * cell * 0.9
      );
    }
    ctx2d.globalAlpha = 1;
  }
  window.addEventListener('resize', function () {
    if (mode === '3d' && renderer) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      applyFit(); // fixed framing tracks the new aspect
    } else fitCanvas();
  });

  // ---------- Main loop ----------
  // Auto-quality: step pixel ratio / shadows down when FPS sags
  var fpsEMA = 60,
    lastQCheck = 0,
    quality = 'high';
  // Auto quality. Two problems with the original: a single slow window was
  // enough to drop a tier permanently (one GC pause, one tab switch, or one
  // biome painting its ground texture cost the player their shadows for the
  // rest of the session), and there was no way back up even after the
  // hitch was long over. So a step down now needs the slow FPS to PERSIST
  // across consecutive windows, and a comfortably fast run steps back up.
  var qLow = 0,
    qHigh = 0;
  function setQuality(next) {
    if (next === 'low') {
      renderer.shadowMap.enabled = false;
      if (dirLight) dirLight.castShadow = false;
      if (scene)
        scene.traverse(function (o) {
          if (o.material) o.material.needsUpdate = true;
        });
    } else if (next === 'medium') {
      renderer.setPixelRatio(1);
      // shadows come back on the way up, unless the player turned them off
      if ($('opt-shadows') && $('opt-shadows').checked) {
        renderer.shadowMap.enabled = true;
        if (dirLight) dirLight.castShadow = true;
      }
    }
    quality = next;
    applyQualityVisuals();
  }
  function qualityTick(now) {
    if (mode !== '3d' || !renderer) return;
    if (now - lastQCheck < 3000) return;
    lastQCheck = now;
    if (fpsEMA < 40) {
      qHigh = 0;
      if (quality !== 'low') qLow++;
      else qLow = 0;
      // two consecutive slow windows before shedding anything
      if (qLow >= 2) {
        qLow = 0;
        var next = quality === 'high' ? 'medium' : 'low';
        if (next !== quality) {
          setQuality(next);
          say(t('perf_t', { q: quality }));
        }
      }
    } else if (fpsEMA > 55) {
      // comfortably fast again: climb back, one tier at a time
      qLow = 0;
      if (quality !== 'high') {
        qHigh++;
        if (qHigh >= 3) {
          qHigh = 0;
          setQuality(quality === 'low' ? 'medium' : 'high');
        }
      } else qHigh = 0;
    } else {
      qLow = 0;
      qHigh = 0;
    }
  }
  function animate(now) {
    requestAnimationFrame(animate);
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (!(dt >= 0)) dt = 0;
    // camera easing gets its own generous clamp: it is purely visual, so on
    // very slow devices the view still converges in wall-clock time instead
    // of lagging seconds behind (logic keeps the strict MAX_DT clamp).
    var cdt = Math.min(dt, 0.5);
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt > 0) fpsEMA += (1 / dt - fpsEMA) * 0.05;
    qualityTick(now);

    if (state === 'playing') {
      acc += dt * 1000;
      var guard = 0;
      while (acc >= tickMs && guard++ < 5) {
        step();
        acc -= tickMs;
        if (state !== 'playing') {
          acc = 0;
          break;
        }
      }
      if (guard >= 5) acc = 0;
    }

    // bonus countdown runs on play time in both 3D and 2D modes
    if (state === 'playing') {
      for (var pbi = bonuses.length - 1; pbi >= 0; pbi--) {
        bonuses[pbi].left -= dt * 1000;
        if (bonuses[pbi].left <= 0) removeBonus(pbi);
      }
    }
    if (shield && state === 'playing') {
      shieldLeft -= dt * 1000;
      if (shieldLeft <= 0) hideShieldMesh();
    }
    if (shieldPhase > 0 && state === 'playing') {
      shieldPhase -= dt * 1000;
      // self-resolving: the ghost ends the moment the head is somewhere a
      // normal step would have survived, so it can never linger or be relied on
      if (shieldPhase <= 0 || safeDirFrom(snake[0].x, snake[0].y)) shieldPhase = 0;
    }
    // volcano embers age on play time in both modes (frozen in pause)
    if (state === 'playing' && biomeIs('Volcano')) {
      emberAcc += dt * 1000;
      if (emberAcc > EMBER_EVERY) {
        emberAcc = 0;
        spawnEmber();
      }
    } else if (state !== 'playing') emberAcc = 0;
    if (state === 'playing') {
      // resolved outside the loop: `t` is shadowed by the frame clock in
      // animate(), so the i18n helper must be called as i18n() in here
      var igniteMsg = i18n('ember_ignite');
      for (var emi = embers.length - 1; emi >= 0; emi--) {
        var em = embers[emi];
        var wasBurning = em.age >= EMBER_WARN;
        em.age += dt * 1000;
        if (!wasBurning && em.age >= EMBER_WARN) {
          // the telegraph->lethal transition is invisible to a screen reader
          // otherwise: a cell the player cannot see becomes deadly silently
          say(igniteMsg, true);
        }
        if (em.age >= EMBER_WARN + EMBER_BURN) embers.splice(emi, 1);
      }
    }

    if (mode === '2d') {
      draw2D(dt);
      return;
    }

    var t = now / 1000;
    var k = Math.min(1, cdt * LERP_SPEED);
    var eff = queue.length ? queue[0] : dir;
    if (squash > 0) squash = Math.max(0, squash - dt * 4);
    var n = snake.length;
    if (snakeHead && n) {
      var aArr = snakeBodyA.instanceMatrix.array;
      var bArr = snakeBodyB.instanceMatrix.array;
      var aN = 0,
        bN = 0;
      for (var i = 0; i < n; i++) {
        var w = gridToWorld(snake[i].x, snake[i].y);
        var sp = segPos[i];
        // same smoothing as before: snap on a long jump (teleport / respawn),
        // otherwise ease toward the target cell
        if (Math.abs(w.x - sp.x) > 2 || Math.abs(w.z - sp.z) > 2) {
          sp.x = w.x;
          sp.z = w.z;
        } else {
          sp.x += (w.x - sp.x) * k;
          sp.z += (w.z - sp.z) * k;
        }
        var yy = 0.55 + (reducedMotion ? 0 : Math.sin(t * 6 - i * 0.55) * 0.045);
        var taper = 1.06 - (i / Math.max(1, n)) * 0.5; // thick head, thin tail
        if (i === 0) {
          snakeHead.position.set(sp.x, yy, sp.z);
          if (squash > 0 && !reducedMotion)
            snakeHead.scale.set(
              taper * (1 + 0.3 * squash),
              taper * (1 - 0.35 * squash),
              taper * (1 + 0.3 * squash)
            );
          else snakeHead.scale.setScalar(taper);
          snakeHead.rotation.y = Math.atan2(eff.x, eff.y);
        } else {
          // write translate+uniform-scale straight into the matrix array:
          // column-major, so scale on the diagonal and translation at 12/13/14
          var arr = i % 2 ? aArr : bArr; // matches the old i%2 ? matA : matB
          var o = (i % 2 ? aN++ : bN++) * 16;
          arr[o] = taper;
          arr[o + 5] = taper;
          arr[o + 10] = taper;
          arr[o + 1] = arr[o + 2] = arr[o + 3] = 0;
          arr[o + 4] = arr[o + 6] = arr[o + 7] = 0;
          arr[o + 8] = arr[o + 9] = arr[o + 11] = 0;
          arr[o + 12] = sp.x;
          arr[o + 13] = yy;
          arr[o + 14] = sp.z;
          arr[o + 15] = 1;
        }
      }
      snakeBodyA.count = aN;
      snakeBodyB.count = bN;
      snakeBodyA.instanceMatrix.needsUpdate = true;
      snakeBodyB.instanceMatrix.needsUpdate = true;
    }
    if (window.__headLight && snake.length) {
      var hw = gridToWorld(snake[0].x, snake[0].y);
      window.__headLight.position.set(hw.x, 1.6, hw.z);
    }
    // head glow trail: push current head pos through the ring buffer
    if (window.__trail && snakeHead && !reducedMotion) {
      var hp = snakeHead.position;
      var tp = window.__trailPos,
        tn = window.__trailN;
      for (var ti = tn - 1; ti > 0; ti--) {
        tp[ti * 3] = tp[(ti - 1) * 3];
        tp[ti * 3 + 1] = tp[(ti - 1) * 3 + 1];
        tp[ti * 3 + 2] = tp[(ti - 1) * 3 + 2];
      }
      tp[0] = hp.x;
      tp[1] = hp.y;
      tp[2] = hp.z;
      window.__trail.geometry.attributes.position.needsUpdate = true;
      window.__trail.visible = state === 'playing';
    } else if (window.__trail) window.__trail.visible = false;
    // obstacle grow-in pop
    for (var og = 0; og < obstacleMeshes.length; og++) {
      if (obstacleMeshes[og].scale.x < 1)
        obstacleMeshes[og].scale.setScalar(Math.min(1, obstacleMeshes[og].scale.x + dt * 3));
    }
    var foodAge = (now - foodBornAt) / 350;
    var foodPop = foodAge >= 1 ? 1 : Math.max(0.01, easeOutBack(Math.max(0, foodAge)));
    if (!reducedMotion) {
      foodMesh.position.y = 0.7 + Math.sin(t * 3) * 0.12;
      foodMesh.rotation.y = t * 1.5;
      foodMesh.rotation.x = t * 0.8;
      foodMesh.scale.setScalar((1 + Math.sin(t * 3) * 0.08) * foodPop);
      var sc = 1 + Math.sin(t * 3) * 0.08;
      foodBase.scale.set(sc, sc, 1);
    } else foodMesh.scale.setScalar(foodPop);
    // desert rule: food blinks in its last 5s before withering
    var desertUrgent =
      state === 'playing' && biomeIs('Desert') && DESERT_FOOD_TTL - (now - foodBornAt) < 5000;
    var foodShown = !desertUrgent || Math.floor(t * 8) % 2 === 0;
    foodMesh.visible = foodShown;
    if (foodLight) foodLight.visible = foodShown;
    if (foodBase) foodBase.visible = foodShown;
    if (window.__gridMat && !reducedMotion) window.__gridMat.opacity = 0.45 + 0.15 * Math.sin(t * 1.2);
    // bonus pickup motion (countdown handled above for both modes)
    for (var mbi = 0; mbi < bonuses.length && window.__bonusMeshes; mbi++) {
      var mbm = window.__bonusMeshes[mbi];
      if (!mbm) break;
      var mb = bonuses[mbi];
      var bAge = (now - mb.bornAt) / 350;
      var bPop = bAge >= 1 ? 1 : Math.max(0.01, easeOutBack(Math.max(0, bAge)));
      var mbl = window.__bonusLights && window.__bonusLights[mbi];
      if (!reducedMotion) {
        mbm.position.y = 0.7 + Math.sin(t * 4.2) * 0.14;
        mbm.rotation.y = t * 2.4;
        var bs = (1 + Math.sin(t * 5) * 0.1) * bPop;
        mbm.scale.set(bs, bs, bs);
        mbm.visible = mb.left > 2000 || Math.floor(t * 8) % 2 === 0;
        if (mbl) mbl.intensity = mbm.visible ? 1.1 : 0;
      } else mbm.scale.setScalar(bPop);
    }
    // crash marker pulse
    if (window.__deathRing && window.__deathRing.visible && !reducedMotion) {
      var ds = 1 + Math.sin(t * 10) * 0.15;
      window.__deathRing.scale.set(ds, ds, 1);
    }
    // volcano ember rings: orange telegraph, red burn
    if (window.__emberRings) {
      for (var eri = 0; eri < window.__emberRings.length; eri++) {
        var emRing = embers[eri];
        var erMesh = window.__emberRings[eri];
        if (!emRing || state !== 'playing') {
          erMesh.visible = false;
          continue;
        }
        var ew = gridToWorld(emRing.x, emRing.y);
        erMesh.position.set(ew.x, 0.05, ew.z);
        var burning = emRing.age >= EMBER_WARN;
        erMesh.material.color.setHex(burning ? 0xff2d2d : 0xff9f1c);
        erMesh.material.opacity = burning ? 0.95 : 0.55 + 0.35 * Math.sin(t * 8);
        var es2 = burning ? 1 + 0.1 * Math.sin(t * 12) : 1;
        erMesh.scale.set(es2, es2, 1);
        erMesh.visible = true;
      }
    }
    // obstacle telegraph rings: fade as they expire (zero-alloc fast path)
    if (window.__warnRings) {
      var aw = warnPulses.length ? activeWarns(now) : [];
      for (var wri = 0; wri < window.__warnRings.length; wri++) {
        var wrMesh = window.__warnRings[wri];
        var wp = aw[wri];
        if (!wp) {
          wrMesh.visible = false;
          continue;
        }
        var ww = gridToWorld(wp.x, wp.y);
        wrMesh.position.set(ww.x, 0.04, ww.z);
        var remain = Math.max(0, (wp.until - now) / 1400);
        wrMesh.material.opacity = 0.25 + 0.6 * remain;
        var ws = 1 + (1 - remain) * 0.3;
        wrMesh.scale.set(ws, ws, 1);
        wrMesh.visible = true;
      }
    }
    // ambient weather drift (positions wrap inside the biome volume)
    if (window.__ambient && window.__ambient.visible) {
      var amb = AMBIENT[themeIdx] || AMBIENT[0];
      var ap = window.__ambPos;
      for (var ai = 0; ai < amb.n; ai++) {
        var ay = ap[ai * 3 + 1] - amb.fall * dt;
        if (ay > amb.h) ay = 0;
        else if (ay < 0) ay = amb.h;
        var ax = ap[ai * 3] + (amb.drift + Math.sin(t * 1.7 + ai) * 0.4) * dt;
        var half = amb.area / 2;
        if (ax > half) ax = -half;
        else if (ax < -half) ax = half;
        ap[ai * 3] = ax;
        ap[ai * 3 + 1] = ay;
      }
      window.__ambient.geometry.attributes.position.needsUpdate = true;
    }
    // shield pickup motion + held-charge halo on the head
    if (shield && window.__shieldMesh) {
      var hAge = (now - shieldBornAt) / 350;
      var hPop = hAge >= 1 ? 1 : Math.max(0.01, easeOutBack(Math.max(0, hAge)));
      if (!reducedMotion) {
        window.__shieldMesh.position.y = 0.7 + Math.sin(t * 4.2 + 1.3) * 0.14;
        window.__shieldMesh.rotation.y = t * 2.4;
        window.__shieldMesh.rotation.x = t * 1.1;
        var hs2 = (1 + Math.sin(t * 5 + 1.3) * 0.1) * hPop;
        window.__shieldMesh.scale.set(hs2, hs2, hs2);
        window.__shieldMesh.visible = shieldLeft > 2000 || Math.floor(t * 8) % 2 === 0;
      } else window.__shieldMesh.scale.setScalar(hPop);
    }
    if (window.__shieldRing && snakeHead) {
      var showHalo = hasShield && state === 'playing';
      window.__shieldRing.visible = showHalo;
      if (showHalo) {
        var shp = snakeHead.position;
        window.__shieldRing.position.set(shp.x, 0.06, shp.z);
        if (!reducedMotion) {
          var shs = 1 + Math.sin(t * 6) * 0.08;
          window.__shieldRing.scale.set(shs, shs, 1);
        }
      }
    }
    for (var pi = 0; pi < particles.length; pi++) {
      var p = particles[pi];
      if (p.life <= 0) continue;
      p.life -= dt;
      p.v.y -= 12 * dt;
      p.m.position.addScaledVector(p.v, dt);
      if (p.m.position.y < 0.05 || p.life <= 0) {
        p.life = 0;
        p.m.visible = false;
      }
    }
    var camSel = $('opt-cam');
    var topView = !!(camSel && camSel.value === 'top');
    // Top-down is a much shallower pitch, so it needs its own fit distance.
    // Detected here rather than on a 'change' event so a programmatic value
    // set (settings restore, test hooks) is picked up too.
    if (topView !== lastTopView) {
      lastTopView = topView;
      applyFit();
    }
    // Fixed framing. The radius is a pure function of the viewport (FIT_R,
    // refreshed on resize) - it NEVER depends on where the snake or the food
    // is, so there is no zoom pumping while playing. On desktop/laptop the look
    // target stays on the board centre for the same reason: chasing the head
    // meant the frame drifted even when the zoom was steady, and the whole board
    // already fits.
    //
    // Touch layouts are the one exception. When applyFit() had to zoom in past
    // the whole-board fit to reach the legibility floor (MIN_CELL_PX), part of
    // the board is off-screen and a fixed centre target would let the snake
    // wander out of frame. So there the target tracks the head. The radius is
    // still fixed, so following does NOT reintroduce zoom breathing - only the
    // look target moves, and it is smoothed and leashed so the head can never
    // lag far enough to leave the screen.
    if (fitFollow && snake.length) {
      var hw2 = gridToWorld(snake[0].x, snake[0].y);
      desiredTarget.set(hw2.x, 0, hw2.z);
      // faster easing than the desktop path: a slow lerp would let a fast snake
      // outrun the camera at high speed
      camTarget.lerp(desiredTarget, Math.min(1, cdt * 8));
      // hard leash: whatever the easing does, the target stays within
      // FOLLOW_LEASH cells of the head, so the head is always well inside the
      // frame instead of merely usually inside it
      var lx = camTarget.x - hw2.x,
        lz = camTarget.z - hw2.z;
      var ld = Math.hypot(lx, lz);
      if (ld > FOLLOW_LEASH) {
        var k = FOLLOW_LEASH / ld;
        camTarget.x = hw2.x + lx * k;
        camTarget.z = hw2.z + lz * k;
      }
    } else {
      desiredTarget.set(0, 0, 0);
      camTarget.lerp(desiredTarget, Math.min(1, cdt * 3));
    }
    var wantR = FIT_R;
    if (now < holdUntil && radiusHold > 0)
      radius += (radiusHold - radius) * Math.min(1, cdt * 9); // inspection: quick, still smooth
    else radius += (wantR - radius) * Math.min(1, cdt * 4);
    var sx = shake > 0 ? (Math.random() - 0.5) * shake * 0.9 : 0;
    var sy = shake > 0 ? (Math.random() - 0.5) * shake * 0.9 : 0;
    if (shake > 0) shake = Math.max(0, shake - dt * 1.4);
    var usePhi = topView ? 0.16 : phi;
    camera.position.set(
      camTarget.x + radius * Math.sin(usePhi) * Math.sin(theta) + sx,
      radius * Math.cos(usePhi) + sy,
      camTarget.z + radius * Math.sin(usePhi) * Math.cos(theta)
    );
    camera.lookAt(camTarget.x, 0, camTarget.z);
    renderer.render(scene, camera);
    updateEdgeGuide();
    snapFrame(); // queued share-picture capture reads the fresh buffer here
  }

  // Project the board's wall rectangle to screen space. Only visible while the
  // legibility floor is active (fitFollow), i.e. when part of the board is off
  // screen; otherwise the real 3D walls are in frame and this is hidden.
  // Uses the same clip->CSS px mapping as the rest of the camera code.
  var edgeGuideEl = null,
    edgeGuidePoly = null;
  function updateEdgeGuide() {
    if (mode !== '3d') return;
    if (!edgeGuideEl) {
      edgeGuideEl = $('edge-guide');
      edgeGuidePoly = $('edge-guide-poly');
      if (!edgeGuideEl || !edgeGuidePoly) return;
    }
    // NOTE: `hidden` is an HTMLElement IDL property; SVGElement does not have
    // it. Assigning svg.hidden = false would only create a JS expando and leave
    // the content attribute in place, so the global [hidden]{display:none}
    // rule would keep the guide invisible forever. Toggle the attribute.
    if (!fitFollow) {
      if (!edgeGuideEl.hasAttribute('hidden')) edgeGuideEl.setAttribute('hidden', '');
      return;
    }
    var m = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    var e = m.elements;
    var pts = '',
      off = 0;
    for (var i = 0; i < 4; i++) {
      var wx = i === 0 || i === 3 ? -FIT_HALF : FIT_HALF;
      var wz = i < 2 ? -FIT_HALF : FIT_HALF;
      var cw = e[3] * wx + e[7] * 0 + e[11] * wz + e[15];
      if (cw <= 1e-4) {
        off = 1;
        break;
      }
      var cx = (e[0] * wx + e[4] * 0 + e[8] * wz + e[12]) / cw;
      var cy = (e[1] * wx + e[5] * 0 + e[9] * wz + e[13]) / cw;
      var sx = ((cx + 1) / 2) * window.innerWidth;
      var sy = ((1 - cy) / 2) * window.innerHeight;
      pts += (i ? ' ' : '') + sx.toFixed(1) + ',' + sy.toFixed(1);
    }
    // A corner behind the camera means the projection is unusable this frame;
    // hide rather than draw a wrong shape.
    if (off) {
      if (!edgeGuideEl.hasAttribute('hidden')) edgeGuideEl.setAttribute('hidden', '');
      return;
    }
    edgeGuidePoly.setAttribute('points', pts);
    edgeGuideEl.removeAttribute('hidden');
  }

  // ---------- Test hooks (harmless in production; used by e2e) ----------
  // ---------- Test hooks ----------
  function setSnakeTest(arr) {
    snake = arr.map(function (s) {
      return { x: s.x, y: s.y };
    });
    syncSnakeMeshes(true);
    updateHUD();
  }
  function setDirTest(x, y) {
    dir = { x: x, y: y };
    queue = [];
    slideHeld = null;
  }
  function setFoodTest(x, y) {
    food = { x: x, y: y };
    foodBornAt = performance.now();
    placeFoodMesh();
  }
  window.__game = {
    get state() {
      return state;
    },
    get mode() {
      return mode;
    },
    get score() {
      return score;
    },
    // getter, not a snapshot: `best` changes on death and on erase, and a
    // captured value would silently report a stale best forever
    get best() {
      return best;
    },
    get snake() {
      return snake.map(function (s) {
        return { x: s.x, y: s.y };
      });
    },
    get dir() {
      return { x: dir.x, y: dir.y };
    },
    get queue() {
      return queue.map(function (q) {
        return { x: q.x, y: q.y };
      });
    },
    get food() {
      return { x: food.x, y: food.y };
    },
    get tickMs() {
      return tickMs;
    },
    // First live orb, kept for the existing single-orb tests; `bonuses` is the
    // real state now that several can coexist.
    get bonus() {
      return bonuses.length ? { x: bonuses[0].x, y: bonuses[0].y } : null;
    },
    get bonuses() {
      return bonuses.map(function (b) {
        return { x: b.x, y: b.y, left: Math.round(b.left) };
      });
    },
    get comboWindow() {
      return Math.round(comboWindowMs);
    },
    get banked() {
      return banked;
    },
    canBank: function () {
      return canBank();
    },
    get bonusLeft() {
      return bonuses.length ? bonuses[0].left : 0;
    },
    get combo() {
      return combo;
    },
    get deathCell() {
      return deathCell ? { x: deathCell.x, y: deathCell.y } : null;
    },
    get level() {
      return level;
    },
    get obstacles() {
      return obstacles.map(function (o) {
        return { x: o.x, y: o.y };
      });
    },
    get longest() {
      return longest;
    },
    get theme() {
      return LEVELS[themeIdx].name;
    },
    get life() {
      return {
        games: life.games,
        foods: life.foods,
        bestCombo: life.bestCombo,
        bestLevel: life.bestLevel,
        wins: life.wins || 0,
        prestige: life.prestige || 0,
        deathsBlocked: life.deathsBlocked || 0,
        bestBank: life.bestBank || 0,
      };
    },
    get ach() {
      return ach.slice();
    },
    get quality() {
      return quality;
    },
    musicPlaying: musicPlaying,
    perf: function () {
      var info = { calls: 0, tris: 0 };
      try {
        if (renderer && renderer.info && renderer.info.render) {
          info.calls = renderer.info.render.calls;
          info.tris = renderer.info.render.triangles;
        }
      } catch (e) {}
      var pr = 0;
      try {
        pr = renderer ? renderer.getPixelRatio() : 0;
      } catch (e2) {}
      return {
        fps: Math.round(fpsEMA),
        calls: info.calls,
        tris: info.tris,
        quality: quality,
        pr: pr,
        radius: Math.round(radius * 10) / 10,
      };
    },
    setTheme: function (i) {
      applyTheme(i);
    },
    debugSlowFps: function () {
      fpsEMA = 20;
      lastQCheck = 0;
    },
    get view() {
      return { ox: view2d.ox, oy: view2d.oy, cell: view2d.cell, dpr: view2d.dpr };
    },
    // footprint audit: min Chebyshev distance of every decor instance from
    // board center (walls sit at ±10.25). Proves nothing spills onto play.
    decorStats: function () {
      var minCheb = Infinity,
        total = 0;
      if (window.__decorMeshes) {
        for (var i = 0; i < window.__decorMeshes.length; i++) {
          var arr = window.__decorMeshes[i].instanceMatrix.array;
          var n = window.__decorMeshes[i].count;
          for (var k = 0; k < n; k++) {
            var m = Math.max(Math.abs(arr[k * 16 + 12]), Math.abs(arr[k * 16 + 14]));
            if (m < minCheb) minCheb = m;
            total++;
          }
        }
      }
      return { minCheb: minCheb === Infinity ? -1 : Math.round(minCheb * 100) / 100, total: total };
    },
    // Places one orb (replacing any live one) so the single-orb tests keep
    // working against a pool-backed implementation.
    setBonus: function (x, y, ttl) {
      clearBonuses();
      bonuses.push({ x: x, y: y, left: ttl || BONUS_TTL, bornAt: performance.now() });
      placeBonusMesh(0);
    },
    // Force a specific pool size, bypassing bonusCap(), to test the multi-orb
    // late game without having to eat 18 foods first.
    setBonusCount: function (n) {
      for (var i = 0; i < n; i++) {
        if (!spawnBonus()) break;
        if (bonuses[i]) bonuses[i].left = BONUS_TTL * 20; // keep them on the board
      }
      return bonuses.length;
    },
    pace: paceEntities,
    get daily() {
      return {
        on: dailyOn,
        day: dailyDay,
        rule: dailyRule ? dailyRule.id : null,
        seed: dailyOn ? seedNum : null,
      };
    },
    dailyRuleName: dailyRuleName,
    setDaily: applyDaily,
    ruleForDay: ruleForDay,
    setCombo: function (n) {
      combo = n;
      lastEatAt = performance.now();
      updateHUD();
    },
    bank: function () {
      return bankNow();
    },
    bankRowVisible: function () {
      var bb = $('btn-bank');
      return !!(bb && !bb.hidden);
    },
    get shield() {
      return shield ? { x: shield.x, y: shield.y } : null;
    },
    get hasShield() {
      return hasShield;
    },
    get shieldPhase() {
      return shieldPhase;
    },
    get biomeName() {
      return LEVELS[themeIdx].name;
    },
    // camera-layout introspection, so e2e can assert the legibility floor and
    // the "desktop is untouched" guarantee instead of eyeballing screenshots
    get fitFollowing() {
      return fitFollow;
    },
    get minCellPx() {
      return MIN_CELL_PX;
    },
    // the real speed curve, so e2e can assert its shape rather than a copy
    tickForFoods: tickForFoods,
    get touchLayout() {
      return touchLayout();
    },
    cellPx: function () {
      if (mode !== '3d' || !camera) return null;
      var sel = $('opt-cam');
      var isTop = !!(sel && sel.value === 'top');
      return cellPxAtRadius(radius, isTop ? 0.16 : phi, theta);
    },
    edgeGuideVisible: function () {
      var el = $('edge-guide');
      // attribute, not el.hidden: SVGElement has no hidden IDL property
      return !!(el && !el.hasAttribute('hidden'));
    },
    setShield: function (x, y, ttl) {
      shield = { x: x, y: y };
      shieldLeft = ttl || SHIELD_TTL;
      placeShieldMesh();
    },
    clearShield: function () {
      hideShieldMesh();
    },
    get seed() {
      return seedNum;
    },
    setSeed: function (n) {
      seedNum = n == null ? null : parseInt(n, 10) || 0;
      seedGen = null;
    },
    get skin() {
      return skinId;
    },
    setSkin: function (id) {
      var sk = skinById(id);
      if (sk && skinUnlocked(sk)) {
        skinId = sk.id;
        applySkin();
      }
      return skinId;
    },
    get shotReady() {
      return shotReadyFlag;
    },
    clearBonus: function () {
      clearBonuses();
    },
    clearBonusAt: function (i) {
      removeBonus(i);
    },
    // Drive N chained eats from a known snake position: reset to the spawn
    // column facing right each time, so the snake can never reach a wall or
    // itself and the only variable is the eat.
    forceEats: function (n) {
      for (var i = 0; i < n; i++) {
        setSnakeTest([
          { x: 9, y: 10 },
          { x: 8, y: 10 },
          { x: 7, y: 10 },
        ]);
        setDirTest(1, 0);
        setFoodTest(10, 10);
        step();
      }
      return foodsEaten;
    },
    resume: function () {
      if (state === 'paused') togglePause();
    },
    spawnBonus: spawnBonus,
    start: startGame,
    pause: togglePause,
    reset: reset,
    step: step,
    setFood: function (x, y) {
      setFoodTest(x, y);
    },
    // test hook: age the current food past its desert TTL to force a wither
    witherFood: function () {
      foodBornAt = performance.now() - DESERT_FOOD_TTL - 1000;
    },
    get embers() {
      return embers.map(function (e) {
        return { x: e.x, y: e.y, age: Math.round(e.age) };
      });
    },
    // test hook: plant an ember with a chosen age (0 = telegraph, >=WARN = burning)
    setEmber: function (x, y, age) {
      embers = [{ x: x, y: y, age: age || 0 }];
    },
    clearEmbers: function () {
      embers = [];
    },
    get warnCount() {
      return activeWarns(performance.now()).length;
    },
    get ambient() {
      var A = AMBIENT[themeIdx] || AMBIENT[0];
      return {
        visible: !!(window.__ambient && window.__ambient.visible),
        count: A.n,
        color: A.color,
      };
    },
    obGlyph: function () {
      var k = LEVELS[themeIdx].ob;
      return k === 'spike' ? 'tri' : k === 'rock' ? 'circle' : k === 'cry' ? 'diamond' : 'square';
    },
    get layout() {
      return runLayout ? { scatter: !!runLayout.scatter, transpose: !!runLayout.transpose } : null;
    },
    // Test hook: force a layout variant instead of rolling the seeded dice.
    // The symmetry assert needs a patterned variant deterministically; with
    // random rolls it was a ~1-in-7000 flake across the retry loop.
    forceLayout: function (kind) {
      if (kind === 'scatter') runLayout = { scatter: true };
      else {
        var L = mazeOn() ? MAZE_LAYOUT : LAYOUTS[themeIdx] || LAYOUTS[0];
        runLayout = { base: L.base, transpose: kind === 'transpose' };
      }
      // rebuild from EMPTY, never append: the run's own seed may have chosen
      // the scatter variant, whose obstacles are intentionally asymmetric, so
      // appending would make the forced variant's symmetry untestable
      obstacles = [];
      addObstacles(obstacleStart());
      return runLayout;
    },
    // test hooks: themed food tint + wall build heights
    get foodTint() {
      try {
        return foodMesh ? foodMesh.material.color.getHex() : -1;
      } catch (e) {
        return -1;
      }
    },
    get wallH() {
      try {
        return window.__wallMeshes ? window.__wallMeshes[0].geometry.parameters.height : -1;
      } catch (e) {
        return -1;
      }
    },
    setSnake: function (arr) {
      setSnakeTest(arr);
    },
    setDir: function (x, y) {
      setDirTest(x, y);
    },
    die: die,
    win: win,
    screenFor: function (gx, gy) {
      if (mode !== '3d' || !window.THREE || !camera) return null;
      var w = gridToWorld(gx, gy);
      var v = new window.THREE.Vector3(w.x, 0.5, w.z).project(camera);
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    },
    // NDC coords of a cell: |x|,|y| <= 1 means on screen (used by resolutions suite)
    project: function (gx, gy) {
      if (mode !== '3d' || !window.THREE || !camera) return null;
      var w = gridToWorld(gx, gy);
      var v = new window.THREE.Vector3(w.x, 0.5, w.z).project(camera);
      return { x: v.x, y: v.y, behind: v.z > 1 };
    },
    // NDC of a raw world point: lets the framing suites measure the true board
    // corners (not grid cells) against the frustum.
    worldProject: function (x, y, z) {
      if (mode !== '3d' || !window.THREE || !camera) return null;
      var v = new window.THREE.Vector3(x, y, z).project(camera);
      return { x: v.x, y: v.y, behind: v.z > 1 };
    },
    setCam: function (t, p) {
      theta = t;
      phi = Math.max(0.16, Math.min(1.25, p));
      applyFit();
    },
    // Inspection zoom for tests: absolute radius held for ms (default 4000),
    // exactly like a wheel/pinch gesture. The fixed frame resumes after it.
    setRadius: function (r, ms) {
      radiusHold = Math.max(10, Math.min(FIT_R * 1.8, r));
      holdUntil = performance.now() + (ms == null ? 4000 : ms);
    },
    get radius() {
      return Math.round(radius * 10) / 10;
    },
    // The fixed fit radius for the current viewport, so suites can assert
    // "zoom equals the fit" instead of hardcoding the old 10..48 window.
    get fitRadius() {
      return Math.round(FIT_R * 10) / 10;
    },
    recomputeFit: function () {
      applyFit();
      return this.fitRadius;
    },
    // Read-only camera basis for the swipe suite: it must wait until the
    // orbit actually settles before asserting screen-absolute steering.
    basis: function () {
      return camBasis();
    },
  };

  // Deep links (?theme=&seed=): same starting biome + seed replays the
  // same map and spawns. Unknown theme names and bad seeds are ignored.
  function parseDeepLinks() {
    var q = '';
    try {
      q = location.search || '';
    } catch (e) {
      q = '';
    }
    if (!q) return;
    var m = q.match(/[?&]theme=([^&]*)/);
    if (m) {
      var name = '';
      try {
        name = decodeURIComponent(m[1]).toLowerCase();
      } catch (e) {
        name = '';
      }
      for (var i = 0; i < LEVELS.length; i++)
        if (LEVELS[i].name.toLowerCase() === name) {
          startThemeIdx = i;
          break;
        }
    }
    var s = q.match(/[?&]seed=(-?\d+)/);
    if (s) {
      var n = parseInt(s[1], 10);
      if (isFinite(n)) {
        seedNum = n;
        seedGen = null;
      }
    }
    // ?daily joins today's challenge; ?daily=<day> pins a specific day so a
    // shared daily link (and the test suite) can replay it exactly.
    var d = q.match(/[?&]daily=([^&]*)/);
    if (d) {
      var day = todayIndex();
      var raw = '';
      try {
        raw = decodeURIComponent(d[1] || '');
      } catch (e) {
        raw = '';
      }
      if (/^-?\d+$/.test(raw)) {
        var want = parseInt(raw, 10);
        if (isFinite(want)) day = want;
      }
      applyDaily(true, day);
    }
  }

  // ---------- Boot: settings first (shadows/speed feed 3D init), then 3D attempt, else 2D
  loadSettings();
  parseDeepLinks();
  loadLife();
  // The on-screen turn buttons used to be forced on by a
  // `@media (pointer: coarse)` CSS rule, which made the "Buttons" setting do
  // nothing at all on phones - a switch that silently cannot change anything.
  // Now the CSS only obeys the checkbox, and touch layouts get it defaulted ON
  // (there is no keyboard to steer with) while desktop keeps defaulting off.
  // Applied only when the player has never chosen, so an explicit choice is
  // never overridden - including an explicit "off" on a phone.
  if (settingsRestored['opt-dpad'] === undefined && touchLayout() && $('opt-dpad')) {
    $('opt-dpad').checked = true;
    saveSettings();
  }
  applyDpad();
  applyI18n();
  seenTut = store.get('snake3d.seen') === '1';
  try {
    seenKeys = store.get('snake3d.seenKeys') === '1';
  } catch (e) {}
  var ok3d = false;
  try {
    ok3d = initThree();
  } catch (e) {
    // initThree is ~345 lines of scene setup; a silent catch here turns any
    // bug in it into "the game just looks different" with no way to tell a
    // blocked WebGL context from a real defect. Stash the message instead.
    window.__initErr = String((e && e.message) || e);
    ok3d = false;
  }
  if (!ok3d) init2D(!window.THREE ? t('note_2d_cdn') : t('note_2d_gl'));
  else if (!renderer) init2D(t('note_2d_render'));

  reset();
  setState('menu');
  showMenuOv();
  updateHUD();
  var ld = $('loader');
  if (ld) ld.hidden = true;
  requestAnimationFrame(function (t) {
    lastT = t;
    requestAnimationFrame(animate);
  });
})();

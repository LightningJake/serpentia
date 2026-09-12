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
  var LERP_SPEED = 18; // was 14 — snappier slide
  var BONUS_TTL = 7000; // bonus pickup lifetime (ms of play time)
  var BONUS_EVERY = 5; // spawn a bonus every N regular foods
  var COMBO_WINDOW = 5000; // eats within this gap chain the combo
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
  var bonus = null,
    bonusLeft = 0; // bonus pickup {x,y} + ms of play time remaining
  var combo = 0,
    lastEatAt = 0; // combo multiplier chain
  var deathCell = null; // crash-highlight cell {x,y}
  var obstacles = []; // deadly blocks [{x,y}]
  var level = 1; // 1 + floor(foodsEaten / FOODS_PER_LEVEL)
  var runStartAt = 0,
    longest = 3; // run stats
  var squash = 0; // eat squash-and-stretch impulse 0..1
  var foodBornAt = 0,
    bonusBornAt = 0; // spawn-pulse timestamps
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
  };
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
    // re-render the visible card in the new language
    if (lastOvReplay && overlay && !overlay.classList.contains('hidden')) {
      try {
        lastOvReplay();
      } catch (e) {}
    }
  }

  // ---------- Lifetime stats + achievements (persisted) ----------
  var life = { games: 0, foods: 0, bestCombo: 0, bestLevel: 1, wins: 0, prestige: 0 };
  var ach = [];
  function loadLife() {
    try {
      var o = JSON.parse(store.get('snake3d.life') || 'null');
      if (o) for (var k in life) if (o[k] != null) life[k] = o[k];
    } catch (e) {}
    try {
      ach = JSON.parse(store.get('snake3d.ach') || '[]') || [];
    } catch (e) {
      ach = [];
    }
  }
  function saveLife() {
    store.set('snake3d.life', JSON.stringify(life));
    store.set('snake3d.ach', JSON.stringify(ach));
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
    toast(t('prestige_toast'));
    announce(t('prestige_toast'));
    lastStartAt = 0;
    startGame();
  }
  function unlock(id) {
    if (ach.indexOf(id) >= 0) return;
    ach.push(id);
    saveLife();
    var name = t('ach_' + id);
    toast(t('ach_t', { n: name }));
    announce(t('ach_t', { n: name }));
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
    'opt-follow',
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
      if (el.type === 'checkbox') el.checked = !!o[SETTING_IDS[i]];
      else el.value = o[SETTING_IDS[i]];
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
    elScore.textContent = score;
    elBest.textContent = best;
    elLevel.textContent = level;
    elLen.textContent = snake.length;
    var gl = $('goal');
    if (gl) gl.textContent = (foodsEaten % FOODS_PER_LEVEL) + '/' + FOODS_PER_LEVEL;
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
      if (combo >= 2) $('combo').textContent = 'x' + Math.min(combo, 5);
    }
  }
  // Combo: eats chained within COMBO_WINDOW raise the multiplier (capped at x5)
  function registerEat() {
    var r = SnakeLogic.comboFor(combo, lastEatAt, performance.now(), COMBO_WINDOW);
    combo = r.combo;
    lastEatAt = performance.now();
    return r.mult;
  }
  // Screen-reader announcements (separate from visual toasts)
  function announce(msg) {
    var el = $('sr-status');
    if (el) el.textContent = msg;
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
    if (window.__bonusMesh) {
      window.__bonusMesh.material.color.setHex(p.bonus);
      window.__bonusMesh.material.emissive.setHex(p.bonusEm);
    }
    if (window.__trailMat) window.__trailMat.color.setHex(p.head);
    if (window.__headLight) window.__headLight.color.setHex(p.head);
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
    // settings live in the main menu; pause gets the pointer note instead
    var sp = $('settings-panel');
    if (sp) sp.hidden = state !== 'menu';
    var pn = $('pause-note');
    if (pn) pn.hidden = state !== 'paused';
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
  function shareScore() {
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
    if (navigator.share) {
      try {
        var r = navigator.share({ title: '3D Snake', text: txt });
        if (r && r.catch) r.catch(function () {});
      } catch (e) {}
      return;
    }
    function done() {
      toast(t('copied'));
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(done, done);
      else toast(txt);
    } catch (e) {
      toast(txt);
    }
  }
  // Stat chips for overlay cards (screen readers get statsLine() instead)
  function chip(label, val) {
    return '<span class="chip"><i>' + label + '</i><b>' + val + '</b></span>';
  }
  function statsChips() {
    var mins = Math.max(1 / 60, (performance.now() - runStartAt) / 60000);
    var rate = Math.round(foodsEaten / mins);
    return (
      chip(t('st_score'), score) +
      chip(t('st_best'), best) +
      chip(t('st_level'), level) +
      chip(t('st_time'), SnakeLogic.fmtTime(performance.now() - runStartAt)) +
      chip(t('st_foods'), foodsEaten) +
      chip(t('pill_goal'), (foodsEaten % FOODS_PER_LEVEL) + '/' + FOODS_PER_LEVEL) +
      chip(t('st_rate'), rate) +
      chip(t('st_longest'), longest)
    );
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
      obColor: 0x54201c,
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
      applyQualityVisuals();
    }
    return L;
  }
  // Run mode picker (start card) <-> settings checkboxes, kept in sync
  function setMode(m) {
    if (m === 'wrap') {
      $('opt-wrap').checked = true;
      $('opt-obstacles').checked = false;
    } else if (m === 'obstacles') {
      $('opt-obstacles').checked = true;
      $('opt-wrap').checked = false;
    } else {
      $('opt-wrap').checked = false;
      $('opt-obstacles').checked = false;
    }
    saveSettings();
    syncModeSeg();
  }
  function syncModeSeg() {
    var m = 'classic';
    if ($('opt-obstacles') && $('opt-obstacles').checked) m = 'obstacles';
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
  var MUSIC_BPM = 112;
  var PENTA = [0, 3, 5, 7, 10, 12, 10, 7, 5, 3];
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
      var stepDur = 60 / MUSIC_BPM / 2;
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
    var A2 = 110;
    if (s % 8 === 0) note(A2, dur * 6, 'sine', 0.5);
    if (s % 8 === 4) note(A2 * Math.pow(2, -5 / 12), dur * 5, 'sine', 0.4);
    if (s % 2 === 0) {
      var mel = PENTA[s % PENTA.length];
      note((440 * Math.pow(2, mel / 12)) / 2, dur * 1.8, 'triangle', 0.32);
    }
  }

  // ---------- Core logic (renderer-independent) ----------
  function baseInterval() {
    var v = $('opt-speed') ? $('opt-speed').value : 'normal';
    return SPEED_PRESETS[v] || SPEED_PRESETS.normal;
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
    bonus = null;
    bonusLeft = 0;
    combo = 0;
    lastEatAt = 0;
    deathCell = null;
    obstacles = [];
    hideBonusMesh();
    if (window.__deathRing) window.__deathRing.visible = false;
    var fl = $('flash');
    if (fl) fl.classList.remove('show');
    applyTheme(0);
    spawnFood();
    if (obstaclesOn()) seedObstacles(OBSTACLE_START);
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
    if (bonus) o[bonus.x + bonus.y * GRID] = true;
    for (var j = 0; j < obstacles.length; j++) o[obstacles[j].x + obstacles[j].y * GRID] = true;
    if (extra) o[extra.x + extra.y * GRID] = true;
    return o;
  }
  function freeCell(minHeadDist) {
    var occ = occupiedMap();
    for (var t = 0; t < 250; t++) {
      var x = (Math.random() * GRID) | 0,
        y = (Math.random() * GRID) | 0;
      if (occ[x + y * GRID]) continue;
      if (minHeadDist && snake.length && Math.abs(x - snake[0].x) + Math.abs(y - snake[0].y) < minHeadDist)
        continue;
      return { x: x, y: y };
    }
    return null;
  }
  function seedObstacles(n) {
    obstacles = [];
    addObstacles(n);
  }
  function addObstacles(n) {
    for (var k = 0; k < n && obstacles.length < OBSTACLE_MAX; k++) {
      var c = freeCell(4);
      if (!c) return;
      obstacles.push(c);
    }
    syncObstacleMeshes(true);
  }
  function levelUp(n) {
    level = n;
    if (n > life.bestLevel) life.bestLevel = n;
    saveLife();
    checkAch();
    buzz([20, 30, 20]);
    var L = applyTheme(n - 1);
    showBanner(t('banner_level', { n: n, biome: biomeName(L.name) + ' ' + L.icon }));
    toast(t('level_t', { n: n, biome: biomeName(L.name) }));
    beep(523, 1046, 0.18, 'sine');
    announce(t('sr_level', { n: n, biome: biomeName(L.name) }));
    if (obstaclesOn()) addObstacles(OBSTACLE_PER_LEVEL);
  }
  function spawnFood() {
    if (snake.length >= GRID * GRID) return false;
    var c = SnakeLogic.findFree(occupiedMap(), GRID, Math.random, 300);
    if (!c) return false;
    food = c;
    placeFoodMesh();
    return true;
  }
  function queueDirection(nx, ny) {
    var last = queue.length ? queue[queue.length - 1] : dir;
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
    var last = queue.length ? queue[queue.length - 1] : dir;
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
      toast(t('keys_hint'));
      announce(t('keys_hint'));
    }
  }
  // RESPONSIVE: rotate head instantly on input so turns feel immediate,
  // even though the grid step happens on the next fixed tick.
  function snapHeadVisual() {
    if (mode !== '3d' || !snakeMeshes.length) return;
    var eff = queue.length ? queue[0] : dir;
    snakeMeshes[0].rotation.y = Math.atan2(eff.x, eff.y);
  }
  function step() {
    if (queue.length) dir = queue.shift();
    var np = SnakeLogic.nextPos(snake[0], dir);
    var nx = np.x,
      ny = np.y;
    var wrap = $('opt-wrap').checked;
    if (wrap) {
      var w = SnakeLogic.wrapPos(np, GRID);
      nx = w.x;
      ny = w.y;
    } else if (!SnakeLogic.inBounds(np, GRID)) {
      die(t('die_wall'), { x: nx, y: ny });
      return;
    }
    var willEat = nx === food.x && ny === food.y;
    var willEatBonus = !!(bonus && nx === bonus.x && ny === bonus.y);
    var willGrow = willEat || willEatBonus;
    var cell = { x: nx, y: ny };
    for (var oi = 0; oi < obstacles.length; oi++)
      if (obstacles[oi].x === nx && obstacles[oi].y === ny) {
        die(t('die_ob'), cell);
        return;
      }
    if (SnakeLogic.hitsBody(cell, snake, willGrow)) {
      die(t('die_self'), cell);
      return;
    }
    snake.unshift({ x: nx, y: ny });
    if (snake.length > longest) longest = snake.length;
    if (willEatBonus) {
      var multB = registerEat();
      var gainedB = Math.round(50 * multB * prestigeMult());
      score += gainedB;
      life.foods++;
      if (combo > life.bestCombo) life.bestCombo = combo;
      saveLife();
      checkAch();
      buzz(30);
      squash = 1;
      fx2d(nx, ny, '+' + gainedB, curPal().css.bonus);
      hideTut();
      var tb = gridToWorld(nx, ny);
      burst({ x: tb.x, y: 0.7, z: tb.z });
      beep(880, 1560, 0.16, 'square');
      hideBonusMesh();
      toast(t('bonus_ate', { n: gainedB }) + (multB > 1 ? ' (x' + multB + ')' : ''));
      if (multB >= 5) showBanner(t('banner_combo'));
      tickMs = Math.max(MIN_INTERVAL, baseInterval() - foodsEaten * 3);
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
      if (mult > 1) toast(t('combo_t', { m: mult, n: gained }));
      if (mult >= 5) showBanner(t('banner_combo'));
      var nl = SnakeLogic.levelFor(foodsEaten, FOODS_PER_LEVEL);
      if (nl > level) levelUp(nl);
      var gt = gridToWorld(nx, ny);
      burst({ x: gt.x, y: 0.7, z: gt.z });
      sfx.eat();
      tickMs = Math.max(MIN_INTERVAL, baseInterval() - foodsEaten * 3);
      if (snake.length >= GRID * GRID) {
        syncSnakeMeshes();
        updateHUD();
        win();
        return;
      }
      spawnFood();
      if (!bonus && foodsEaten % BONUS_EVERY === 0) spawnBonus();
    } else snake.pop();
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
      burst({ x: w.x, y: 0.7, z: w.z });
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
      showOverlay(t('over_t'), isBest ? msg + ' ' + t('newbest') : msg, statsChips(), replayOver);
    };
    setTimeout(function () {
      if (state === 'over') replayOver();
    }, 1000);
    announce(t('sr_over', { s: stats }));
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
    acc = Math.max(0, tickMs - 30); // RESPONSIVE: first step lands ~30ms after tap
    var b = $('btn-play');
    if (b) b.blur();
  }
  function togglePause() {
    if (state === 'playing') {
      setState('paused');
      var replayPause = function () {
        showOverlay(t('paused_t'), t('paused_s'), statsChips(), replayPause);
      };
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
    else toast(t('press_start'));
  });
  onTap($('btn-help'), function () {
    if (state === 'playing') togglePause(); // never run the game behind the docs
    $('help-modal').hidden = false;
  });
  onTap($('btn-close-help'), function () {
    $('help-modal').hidden = true;
  });
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
  onTap($('btn-prestige'), doPrestige);
  onTap($('btn-share'), shareScore);
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
    toast(t('install_ok'));
    announce(t('install_ok'));
  });
  onTap($('btn-install'), function () {
    if (deferredInstall && typeof deferredInstall.prompt === 'function') {
      try {
        deferredInstall.prompt();
        if (deferredInstall.userChoice && deferredInstall.userChoice.catch)
          deferredInstall.userChoice.catch(function () {});
      } catch (e) {}
    } else toast(t('install_manual'));
  });
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
  if ($('opt-music'))
    $('opt-music').addEventListener('change', function () {
      if (musicOn() && state === 'playing') startMusic();
      else stopMusic();
    });
  if ($('opt-lang')) $('opt-lang').addEventListener('change', applyI18n);
  // Kid mode: one tap sets slow + wrap + no obstacles (transparent presets)
  if ($('opt-kid'))
    $('opt-kid').addEventListener('change', function (e) {
      if (e.target.checked) {
        $('opt-speed').value = 'slow';
        $('opt-wrap').checked = true;
        $('opt-obstacles').checked = false;
        saveSettings();
        syncModeSeg();
        tickMs = Math.max(MIN_INTERVAL, baseInterval() - foodsEaten * 3);
        toast(t('kid_on'));
        announce(t('kid_on'));
      }
    });
  function applyDpad() {
    var el = $('opt-dpad');
    $('dpad').classList.toggle('force', !!(el && el.checked));
  }
  if ($('opt-dpad')) $('opt-dpad').addEventListener('change', applyDpad);
  if ($('opt-speed'))
    $('opt-speed').addEventListener('change', function () {
      tickMs = Math.max(MIN_INTERVAL, baseInterval() - foodsEaten * 3);
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
      $('help-modal').hidden = true;
      return;
    }
    // Focused buttons activate natively (single click via onTap fallback).
    // Swallowing them here would double-fire (native + global).
    if (tag === 'BUTTON') return;
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
        $('help-modal').hidden = true; // dismiss docs first, game stays paused
        return;
      }
      if (state === 'playing' || state === 'paused') togglePause();
      else startGame();
      return;
    }
    if (e.code === 'Enter') {
      if (!$('help-modal').hidden) {
        $('help-modal').hidden = true;
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
        radius = Math.max(10, Math.min(45, radius - (d - pinchD) * 0.05));
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
  var snakeMeshes = [];
  var obstacleMeshes = [];
  var foodMesh = null,
    foodLight = null,
    foodBase = null;
  var particles = [];
  var theta = Math.PI / 4,
    phi = 0.95,
    radius = 24;
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
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
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
    function mkWall(w, d, x, z) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, d), wallMat);
      m.position.set(x, 0.55, z);
      m.castShadow = true;
      scene.add(m);
    }
    mkWall(GRID + 1, 0.5, 0, -GRID / 2 - 0.25);
    mkWall(GRID + 1, 0.5, 0, GRID / 2 + 0.25);
    mkWall(0.5, GRID + 1, -GRID / 2 - 0.25, 0);
    mkWall(0.5, GRID + 1, GRID / 2 + 0.25, 0);

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

    // bonus pickup: pink octahedron, hidden until spawned
    window.__bonusMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.44, 0),
      new THREE.MeshStandardMaterial({
        color: 0xff5fa2,
        emissive: 0xa3124f,
        emissiveIntensity: 1.2,
        roughness: 0.25,
      })
    );
    window.__bonusMesh.castShadow = true;
    window.__bonusMesh.visible = false;
    scene.add(window.__bonusMesh);
    window.__bonusLight = new THREE.PointLight(0xff5fa2, 1.1, 8);
    scene.add(window.__bonusLight);
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
      var p = new THREE.Mesh(partGeo, partMat);
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
    });
    window.addEventListener('pointerup', function () {
      dragging = false;
    });
    canvas.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        radius = Math.max(10, Math.min(45, radius + e.deltaY * 0.02));
      },
      { passive: false }
    );
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      toast(t('gpu_lost'));
      if (state === 'playing') togglePause();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      toast(t('gpu_back'));
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

  function makeSegmentMesh(isHead) {
    var THREE = window.THREE;
    var m = new THREE.Mesh(
      window.__snakeGeo,
      isHead ? window.__matH : snakeMeshes.length % 2 ? window.__matA : window.__matB
    );
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
  function syncSnakeMeshes(snap) {
    if (mode !== '3d') return;
    while (snakeMeshes.length < snake.length) {
      var mesh = makeSegmentMesh(snakeMeshes.length === 0);
      var t = gridToWorld(snake[snakeMeshes.length].x, snake[snakeMeshes.length].y);
      mesh.position.set(t.x, 0.55, t.z);
      snakeMeshes.push(mesh);
    }
    while (snakeMeshes.length > snake.length) scene.remove(snakeMeshes.pop());
    for (var i = 0; i < snakeMeshes.length; i++) {
      var mm = snakeMeshes[i];
      mm.material = i === 0 ? window.__matH : i % 2 ? window.__matA : window.__matB;
      for (var c = 0; c < mm.children.length; c++) mm.children[c].visible = i === 0;
      if (snap) {
        var w = gridToWorld(snake[i].x, snake[i].y);
        mm.position.set(w.x, 0.55, w.z);
      }
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
    // even ring road: every k-th slot around the arena with jitter. Reads as
    // intentional landscaping (not noise, not clumps), and the square clamp
    // below provably keeps every piece off the board + walls.
    var ringMin = 13.5,
      ringMax = 22;
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
        // slot k evenly around the ring, jittered; Chebyshev clamp keeps a
        // hard clear margin off the ±10.25 walls on every side + corner
        var sa = ((k + 0.15 + Math.random() * 0.7) / D.count) * Math.PI * 2;
        var sr = 14 + Math.random() * 4.5;
        var px = Math.cos(sa) * sr,
          pz = Math.sin(sa) * sr;
        var pm = Math.max(Math.abs(px), Math.abs(pz));
        if (pm < ringMin) {
          px *= ringMin / pm;
          pz *= ringMin / pm;
        } else if (pm > ringMax) {
          px *= ringMax / pm;
          pz *= ringMax / pm;
        }
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
  // Bonus pickup: rare, timed, worth 50 x combo. Never on snake or regular food.
  function spawnBonus() {
    if (bonus || snake.length >= GRID * GRID - 1) return false;
    var c = SnakeLogic.findFree(occupiedMap(), GRID, Math.random, 200);
    if (!c) return false;
    bonus = c;
    bonusLeft = BONUS_TTL;
    placeBonusMesh();
    toast(t('bonus_spawn'));
    return true;
  }
  function placeBonusMesh() {
    bonusBornAt = performance.now();
    if (mode !== '3d' || !window.__bonusMesh || !bonus) return;
    var t = gridToWorld(bonus.x, bonus.y);
    window.__bonusMesh.position.set(t.x, 0.7, t.z);
    window.__bonusMesh.scale.setScalar(0.01);
    window.__bonusMesh.visible = true;
    if (window.__bonusLight) window.__bonusLight.position.set(t.x, 1.8, t.z);
  }
  // spawn-pop easing (overshoots slightly, like a jelly pop)
  function easeOutBack(x) {
    var c = 1.70158;
    var u = x - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }
  function hideBonusMesh() {
    bonus = null;
    bonusLeft = 0;
    if (window.__bonusMesh) window.__bonusMesh.visible = false;
  }
  function burst(pos) {
    if (mode !== '3d' || reducedMotion) return;
    var n = 0;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.life > 0) continue;
      p.life = 0.5;
      p.m.visible = true;
      p.m.position.set(pos.x, pos.y, pos.z);
      p.v.set((Math.random() - 0.5) * 6, Math.random() * 5 + 2, (Math.random() - 0.5) * 6);
      if (++n >= 10) break;
    }
  }
  // Off-screen food arrow: the camera stays close and readable; when the food
  // leaves the frame, an edge marker points at it with the cell distance.
  // Wrap-aware: across an edge, it points the short way around.
  function ndcCell(gx, gy) {
    if (mode !== '3d' || !window.THREE || !camera) return null;
    var w = gridToWorld(gx, gy);
    var v = new window.THREE.Vector3(w.x, 0.5, w.z).project(camera);
    return { x: v.x, y: v.y, behind: v.z > 1 };
  }
  function updateFoodArrow() {
    var el = $('food-arrow');
    if (!el) return;
    if (mode !== '3d' || state !== 'playing' || !snake.length) {
      el.hidden = true;
      return;
    }
    var hs = ndcCell(snake[0].x, snake[0].y);
    var fs = ndcCell(food.x, food.y);
    var onScreen = function (p) {
      return p && !p.behind && Math.abs(p.x) <= 0.92 && Math.abs(p.y) <= 0.88;
    };
    if (onScreen(fs)) {
      el.hidden = true;
      return;
    }
    var hw = gridToWorld(snake[0].x, snake[0].y);
    var fw = gridToWorld(food.x, food.y);
    var dx = fw.x - hw.x,
      dz = fw.z - hw.z;
    if ($('opt-wrap').checked) {
      dx -= GRID * Math.round(dx / GRID);
      dz -= GRID * Math.round(dz / GRID);
    }
    var len = Math.sqrt(dx * dx + dz * dz) || 1;
    var b = camBasis();
    var sx = (dx / len) * b.rx + (dz / len) * b.rz; // screen right+
    var sy = (dx / len) * b.fx + (dz / len) * b.fz; // screen up+
    var ang = Math.atan2(sx, sy);
    var ax = hs && !hs.behind ? ((hs.x + 1) / 2) * window.innerWidth : window.innerWidth / 2;
    var ay = hs && !hs.behind ? ((1 - hs.y) / 2) * window.innerHeight : window.innerHeight / 2;
    var R = 110;
    var px = ax + Math.sin(ang) * R,
      py = ay - Math.cos(ang) * R;
    // shrink the offset to fit instead of clamping: clamping skews the
    // bearing, shrinking keeps the arrow truthful on narrow screens
    var R2 = R;
    for (var fit = 0; fit < 12; fit++) {
      px = ax + Math.sin(ang) * R2;
      py = ay - Math.cos(ang) * R2;
      if (px >= 46 && px <= window.innerWidth - 46 && py >= 120 && py <= window.innerHeight - 190) break;
      R2 *= 0.85;
    }
    px = Math.max(46, Math.min(window.innerWidth - 46, px));
    py = Math.max(120, Math.min(window.innerHeight - 190, py));
    var mdx = Math.abs(food.x - snake[0].x);
    var mdz = Math.abs(food.y - snake[0].y);
    if ($('opt-wrap').checked) {
      mdx = Math.min(mdx, GRID - mdx);
      mdz = Math.min(mdz, GRID - mdz);
    }
    el.hidden = false;
    el.style.left = px + 'px';
    el.style.top = py + 'px';
    var glyph = el.firstElementChild;
    if (glyph) glyph.style.transform = 'rotate(' + (ang * 180) / Math.PI + 'deg)';
    var dist = $('food-dist');
    if (dist) dist.textContent = mdx + mdz;
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
    toast(reason || t('note_2d_mode'));
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
    for (ob = 0; ob < obstacles.length; ob++) {
      ctx2d.fillStyle = '#' + LEVELS[themeIdx].wall.toString(16).padStart(6, '0');
      ctx2d.fillRect(ox + obstacles[ob].x * cell + 1, oy + obstacles[ob].y * cell + 1, cell - 2, cell - 2);
      ctx2d.strokeStyle = '#241a3d';
      ctx2d.lineWidth = 2;
      ctx2d.strokeRect(ox + obstacles[ob].x * cell + 2, oy + obstacles[ob].y * cell + 2, cell - 4, cell - 4);
    }
    ctx2d.fillStyle = pal.food;
    ctx2d.beginPath();
    ctx2d.arc(ox + (food.x + 0.5) * cell, oy + (food.y + 0.5) * cell, cell * 0.36, 0, 7);
    ctx2d.fill();
    if (bonus) {
      var blink = bonusLeft > 2000 || Math.floor(performance.now() / 125) % 2 === 0;
      if (blink) {
        ctx2d.fillStyle = pal.bonus;
        ctx2d.beginPath();
        ctx2d.arc(ox + (bonus.x + 0.5) * cell, oy + (bonus.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.fill();
        ctx2d.strokeStyle = '#fff';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(ox + (bonus.x + 0.5) * cell, oy + (bonus.y + 0.5) * cell, cell * 0.42, 0, 7);
        ctx2d.stroke();
      }
    }
    for (var s = snake.length - 1; s >= 0; s--) {
      ctx2d.fillStyle = s === 0 ? pal.head : pal.body[s % 2];
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
    } else fitCanvas();
  });

  // ---------- Main loop ----------
  // Auto-quality: step pixel ratio / shadows down when FPS sags
  var fpsEMA = 60,
    lastQCheck = 0,
    quality = 'high';
  function qualityTick(now) {
    if (mode !== '3d' || !renderer) return;
    if (now - lastQCheck < 3000) return;
    lastQCheck = now;
    if (fpsEMA >= 40 || quality === 'low') return;
    if (quality === 'high') {
      quality = 'medium';
      renderer.setPixelRatio(1);
    } else if (quality === 'medium') {
      quality = 'low';
      renderer.shadowMap.enabled = false;
      if (dirLight) dirLight.castShadow = false;
      if (scene)
        scene.traverse(function (o) {
          if (o.material) o.material.needsUpdate = true;
        });
    }
    applyQualityVisuals();
    toast(t('perf_t', { q: quality }));
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
    if (bonus && state === 'playing') {
      bonusLeft -= dt * 1000;
      if (bonusLeft <= 0) hideBonusMesh();
    }

    if (mode === '2d') {
      draw2D(dt);
      return;
    }

    var t = now / 1000;
    var k = Math.min(1, cdt * LERP_SPEED);
    var eff = queue.length ? queue[0] : dir;
    if (squash > 0) squash = Math.max(0, squash - dt * 4);
    for (var i = 0; i < snakeMeshes.length; i++) {
      var mesh = snakeMeshes[i];
      var w = gridToWorld(snake[i].x, snake[i].y);
      if (Math.abs(w.x - mesh.position.x) > 2 || Math.abs(w.z - mesh.position.z) > 2) {
        mesh.position.x = w.x;
        mesh.position.z = w.z;
      } else {
        mesh.position.x += (w.x - mesh.position.x) * k;
        mesh.position.z += (w.z - mesh.position.z) * k;
      }
      mesh.position.y = 0.55 + (reducedMotion ? 0 : Math.sin(t * 6 - i * 0.55) * 0.045);
      var taper = 1.06 - (i / Math.max(1, snakeMeshes.length)) * 0.5; // thick head, thin tail
      if (i === 0 && squash > 0 && !reducedMotion) {
        mesh.scale.set(taper * (1 + 0.3 * squash), taper * (1 - 0.35 * squash), taper * (1 + 0.3 * squash));
      } else mesh.scale.setScalar(taper);
      if (i === 0) mesh.rotation.y = Math.atan2(eff.x, eff.y);
    }
    if (window.__headLight && snake.length) {
      var hw = gridToWorld(snake[0].x, snake[0].y);
      window.__headLight.position.set(hw.x, 1.6, hw.z);
    }
    // head glow trail: push current head pos through the ring buffer
    if (window.__trail && snakeMeshes.length && !reducedMotion) {
      var hp = snakeMeshes[0].position;
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
    if (window.__gridMat && !reducedMotion) window.__gridMat.opacity = 0.45 + 0.15 * Math.sin(t * 1.2);
    // bonus pickup motion (countdown handled above for both modes)
    if (bonus && window.__bonusMesh) {
      var bAge = (now - bonusBornAt) / 350;
      var bPop = bAge >= 1 ? 1 : Math.max(0.01, easeOutBack(Math.max(0, bAge)));
      if (!reducedMotion) {
        window.__bonusMesh.position.y = 0.7 + Math.sin(t * 4.2) * 0.14;
        window.__bonusMesh.rotation.y = t * 2.4;
        var bs = (1 + Math.sin(t * 5) * 0.1) * bPop;
        window.__bonusMesh.scale.set(bs, bs, bs);
        window.__bonusMesh.visible = bonusLeft > 2000 || Math.floor(t * 8) % 2 === 0;
      } else window.__bonusMesh.scale.setScalar(bPop);
    }
    // crash marker pulse
    if (window.__deathRing && window.__deathRing.visible && !reducedMotion) {
      var ds = 1 + Math.sin(t * 10) * 0.15;
      window.__deathRing.scale.set(ds, ds, 1);
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
    var head = snake.length ? gridToWorld(snake[0].x, snake[0].y) : { x: 0, z: 0 };
    var fw = gridToWorld(food.x, food.y);
    // fixed comfortable framing: the camera NEVER auto-zooms (that bounce on
    // every eat was the #1 feel complaint). It follows the head with a slight
    // lookahead toward the food; far food is signalled by the edge arrow, and
    // the user owns the radius via wheel / pinch.
    if (topView) desiredTarget.set(0, 0, 0);
    else if ($('opt-follow').checked)
      desiredTarget.set(head.x * 0.85 + fw.x * 0.15, 0, head.z * 0.85 + fw.z * 0.15);
    else desiredTarget.set(0, 0, 0);
    camTarget.lerp(desiredTarget, Math.min(1, cdt * 3));
    updateFoodArrow(); // edge marker when the food is off-screen (3D playing only)
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
  }

  // ---------- Test hooks (harmless in production; used by e2e) ----------
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
    get bonus() {
      return bonus ? { x: bonus.x, y: bonus.y } : null;
    },
    get bonusLeft() {
      return bonusLeft;
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
        prestige: life.prestige || 0,
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
    setBonus: function (x, y, ttl) {
      bonus = { x: x, y: y };
      bonusLeft = ttl || BONUS_TTL;
      placeBonusMesh();
    },
    clearBonus: function () {
      hideBonusMesh();
    },
    spawnBonus: spawnBonus,
    start: startGame,
    pause: togglePause,
    reset: reset,
    step: step,
    setFood: function (x, y) {
      food = { x: x, y: y };
      placeFoodMesh();
    },
    setSnake: function (arr) {
      snake = arr.map(function (s) {
        return { x: s.x, y: s.y };
      });
      syncSnakeMeshes(true);
      updateHUD();
    },
    setDir: function (x, y) {
      dir = { x: x, y: y };
      queue = [];
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
    setCam: function (t, p) {
      theta = t;
      phi = Math.max(0.16, Math.min(1.25, p));
    },
  };

  // ---------- Boot: settings first (shadows/speed feed 3D init), then 3D attempt, else 2D
  loadSettings();
  loadLife();
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

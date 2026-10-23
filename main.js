/* Racket Rage Tennis - main.js
   Sections:
     1. Utilities, seeded RNG, dates and money
     2. Game data: tiers, opponents, copy, press conference, trophies
     3. Save data (one LocalStorage key)
     4. Stage sizing and input mapping (fixed 16:9)
     5. Court projection and drawing helpers
     6. Match engine (serve, rally, line calls, rage, code violations)
     7. Match rendering and HUD
     8. Finite state machine: MENU, CAREER_HUB, MATCH_PLAY, MELTDOWN_MINIGAME, PRESS_CONFERENCE, GAME_OVER
     9. Daily Meltdown seed, scorecard and sharing
    10. Boot
   All player facing text avoids dashes. */
(function () {
  'use strict';

  /* =====================================================================
     1. Utilities
     ===================================================================== */
  const W = 1280;
  const H = 720;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Linear Congruential Generator (Numerical Recipes constants). Returns a function giving [0, 1).
  function makeLCG(seed) {
    let s = (seed >>> 0) || 1;
    const r = function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    r.range = (a, b) => a + (b - a) * r();
    r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.chance = (p) => r() < p;
    r.gauss = () => {
      let u = 0;
      while (!u) u = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };
    return r;
  }

  const pad = (n) => (n < 10 ? '0' : '') + n;
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  // A Daily streak is still alive if you played today or yesterday, or two days ago with a shield to cover the gap
  function daysAgoKey(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateKey(d); }
  function streakAlive() {
    const lp = SAVE.lastPlayedDate;
    if (lp === dateKey() || lp === daysAgoKey(1)) return SAVE.dailyStreak || 0;
    if (lp === daysAgoKey(2) && (SAVE.streakShields || 0) > 0) return SAVE.dailyStreak || 0;
    return 0;
  }
  // Tomorrow's Daily Meltdown, named in advance: something to come back for
  function tomorrowLine() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const d = dailyConfig(dateKey(t));
    return 'Tomorrow: vs ' + d.opp.name + ' (' + skillLabel(d.skill) + ').';
  }
  // Web: once, after the first tour match, the Daily Meltdown is introduced on the hub (it is easy to miss on the
  // title screen, and it is the main reason to come back tomorrow). Not if today's has been played.
  function maybeDailyNudge(scope) {
    const key = dateKey();
    const played = (SAVE.stats.matchesWon || 0) + (SAVE.stats.matchesLost || 0);
    if (SAVE.dailyNudged || !SAVE.tutorialDone || played < 2 || SAVE.lastPlayedDate === key || pendingResume()) return;
    SAVE.dailyNudged = true;
    persist();
    const d = dailyConfig(key);
    $('#nudgeLine').textContent = 'Today: vs ' + d.opp.name + ' (' + skillLabel(d.skill) + ')' + (d.twist ? '. ' + d.twist.name + '.' : '.');
    const modal = $('#dailyNudge');
    scope.timeout(() => modal.classList.remove('hidden'), 700);
    scope.on($('#btnNudgeGo'), 'click', () => {
      sfx('click');
      modal.classList.add('hidden');
      newMatch(dailyConfig(key));
      FSM.change('MATCH_PLAY', { fresh: true });
    });
    scope.on($('#btnNudgeLater'), 'click', () => { sfx('click'); modal.classList.add('hidden'); });
    scope.add(() => modal.classList.add('hidden'));
  }
  function yesterdayKey() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return dateKey(d);
  }
  // Display dates never use dashes: "3 Oct 2026"
  function prettyDate(key) {
    const p = key.split('-').map(Number);
    return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0];
  }
  function money(n) {
    const v = Math.round(Math.abs(n)).toLocaleString('en-GB');
    return (n < 0 ? 'minus £' : '£') + v;
  }
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const fill = (s, map) => s.replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? map[k] : m));

  /* ---- Controls: the input in use (touch, mouse or keys), so every tip and label names the right controls ---- */
  const INPUT = { kind: window.matchMedia && window.matchMedia('(pointer: fine)').matches ? 'mouse' : 'touch' };
  // Key names. Letters are replaced from the player's own keyboard layout where the browser says (an AZERTY W is a Z).
  const KEYCAP = { Space: 'Space', Enter: 'Enter', ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' };
  const keyName = (code) => KEYCAP[code] || code.replace(/^Key|^Digit/, '');
  const onInputChange = [];
  function setInput(kind) {
    if (INPUT.kind === kind) return;
    INPUT.kind = kind;
    onInputChange.forEach((f) => f());
  }
  // Every control phrase, per input. {KeyW} and the like become key names.
  const CTL = {
    hit: { touch: 'Press and hold. Let go as the ring closes on the ball.', mouse: 'Hold the mouse button. Let go as the ring closes on the ball.', keys: 'Hold {Space}. Let go as the ring closes on the ball.' },
    aim: { touch: 'While you hold, drag to aim. Let go on the ring.', mouse: 'Point the mouse where you want the ball to go.', keys: 'Hold {KeyA} or {KeyD} as you let go to aim left or right.' },
    serveHint: { touch: 'Hold to toss, drag to aim, let go to serve. Flick for spin.', mouse: 'Point at the lit box. Hold, let go to serve. Flick for spin.', keys: 'Hold {Space}, let go to serve. {KeyA} {KeyD} aim, {KeyW} {KeyS} spin.' },
    serveTip: { touch: 'Your serve. Hold to toss, drag into the lit box, let go.', mouse: 'Your serve. Point at the lit box, hold the button, let go near the top of the bar.', keys: 'Your serve. Hold {Space}, let go near the top of the bar.' },
    spin: { touch: 'Flick up as you let go for topspin. Flick down for slice.', mouse: 'Flick the mouse up as you let go for topspin, down for slice.', keys: 'Hold {KeyW} as you let go for topspin, {KeyS} for slice.' },
    lobNet: { touch: 'They are at the net. Flick up hard to lob over them.', mouse: 'They are at the net. Flick the mouse up as you let go to lob them.', keys: 'They are at the net. Hold {KeyW} as you let go to lob them.' },
    lob: { touch: 'Flick up hard to lob. Good against net rushers, or to buy time.', mouse: 'Flick the mouse up hard to lob. Good against net rushers, or to buy time.', keys: 'Hold {KeyW} on the run or against a net rusher to lob.' },
    power: { touch: 'Press early and hold to hit harder. Less control, more fun.', mouse: 'Press the button early and hold to hit harder. Less control, more fun.', keys: 'Press {Space} early and hold to hit harder. Less control, more fun.' },
    net: { touch: 'Left thumb down to move yourself. Push it up to charge the net.', mouse: 'Right-click to charge the net. Right-click again to drop back.', keys: 'The arrow keys move you. Hold {ArrowUp} to charge the net.' },
    oppNet: { touch: 'They are at the net. Pass them wide, or flick up to lob.', mouse: 'They are at the net. Pass them wide, or flick the mouse up to lob.', keys: 'They are at the net. Pass them wide, or hold {KeyW} to lob.' },
    onRun: { touch: 'On the run. Flick up for a defensive lob.', mouse: 'On the run. Flick the mouse up for a defensive lob.', keys: 'On the run. Hold {KeyW} for a defensive lob.' },
    legs: { touch: 'Your legs run for you. Left thumb moves you, push up to come in.', mouse: 'Your legs run for you. Right-click to come to the net.', keys: 'Your legs run for you. The arrow keys steer, {ArrowUp} to come in.' },
    charge: { touch: 'Hold early to charge, release on the ring. Flick up topspin, down slice.', mouse: 'Hold early to charge, let go on the ring. Flick up topspin, down slice.', keys: 'Hold {Space} early to charge. {KeyW} topspin, {KeyS} slice, {KeyQ} drop shot.' },
    celebrate: { touch: 'Tap CELEBRATE. It calms you down, and the crowd loves it. Mostly.', mouse: 'Click CELEBRATE or press {KeyF}. It calms you down, and the crowd loves it. Mostly.', keys: 'Press {KeyF} to CELEBRATE. It calms you down, and the crowd loves it. Mostly.' },
    challengeTip: { touch: 'Think it was in? Tap CHALLENGE. Wrong ones cost a challenge and rage.', mouse: 'Think it was in? Click CHALLENGE or press {KeyC}. Wrong ones cost a challenge and rage.', keys: 'Think it was in? Press {KeyC} to CHALLENGE. Wrong ones cost a challenge and rage.' },
    proFeet: { touch: 'Pro footwork: thumb onto the footprint, and be still when the ball arrives.', mouse: 'Pro footwork: arrow keys onto the footprint, and be still when the ball arrives.' },
    noSwing: { touch: 'No swing. Press, then let go as the ring closes.', mouse: 'No swing. Hold the button, then let go as the ring closes.', keys: 'No swing. Hold {Space}, then let go as the ring closes.' },
    skip: { touch: 'Tap to skip', mouse: 'Click to skip', keys: 'Press {Space} to skip' },
    footAuto: { touch: 'Your legs run to the ball for you. Your left thumb steers when you want it to.', mouse: 'Your legs run to the ball for you. Right-click or the arrow keys take you to the net.' },
    footPro: { touch: 'You do the running with your left thumb. Get your feet set before the ball arrives and the shot goes harder and straighter.', mouse: 'You do the running with the arrow keys. Get your feet set before the ball arrives and the shot goes harder and straighter.' },
    aimNormal: { touch: 'Your finger points where the ball goes.', mouse: 'For touch screens. With a mouse you point straight at the spot.' },
    aimLow: { touch: 'Fine aim: your finger moves further for the same change. Easier to hit a line.', mouse: 'For touch screens. With a mouse you point straight at the spot.' },
    aimHigh: { touch: 'Quick aim: small movements reach the corners. Good for small screens.', mouse: 'For touch screens. With a mouse you point straight at the spot.' },
    proCard: { touch: 'You do the running. Get set in time for harder shots.', mouse: 'You do the running, with the arrow keys. Get set in time for harder shots.' },
    // The lesson
    tutHit: { touch: 'Let go as the ring closes on the ball. Land two in. Do not worry about aiming yet.', mouse: 'Hold the mouse button, let go as the ring closes on the ball. Land two in. Do not worry about aiming yet.', keys: 'Hold {Space}, let go as the ring closes on the ball. Land two in. Do not worry about aiming yet.' },
    tutAim: { touch: 'Drag to aim. Land two in the lit target, deep in the far corner.', mouse: 'Point the mouse at the lit target, deep in the far corner. Land two in.', keys: 'Hold {KeyA} as you let go to aim left. Land two in the lit target, deep in the far corner.' },
    tutCharge: { touch: 'Press early and keep holding as the ball comes. Let go as the ring closes. Two powered shots in.', mouse: 'Press the button early and keep holding as the ball comes. Let go as the ring closes. Two powered shots in.', keys: 'Press {Space} early and keep holding as the ball comes. Let go as the ring closes. Two powered shots in.' },
    tutTop: { touch: 'Flick your thumb up as you let go. The ball dips and kicks up. Land one in.', mouse: 'Flick the mouse up as you let go. The ball dips and kicks up. Land one in.', keys: 'Hold {KeyW} as you let go. The ball dips and kicks up. Land one in.' },
    tutSlice: { touch: 'Flick your thumb down as you let go. The ball skids and stays low. Land one in.', mouse: 'Flick the mouse down as you let go. The ball skids and stays low. Land one in.', keys: 'Hold {KeyS} as you let go. The ball skids and stays low. Land one in.' },
    tutLob: { touch: 'Derek is at the net. Flick up as you let go to lob it over his head. Land two in.', mouse: 'Derek is at the net. Flick the mouse up as you let go to lob it over his head. Land two in.', keys: 'Derek is at the net. Hold {KeyW} as you let go to lob it over his head. Land two in.' },
    tutServe: { touch: 'Your serve. Hold to toss, drag into the lit box, let go near the top of the bar. Land two in.', mouse: 'Your serve. Point at the lit box, hold the button to toss, let go near the top of the bar. Land two in.', keys: 'Your serve. Hold {Space} to toss, let go near the top of the bar. Land two in.' },
    tutMelt: { touch: 'Your rage is full: your call. Smash It resets your rage but costs a racket. Keep It In: tap the red thoughts, leave the green.', mouse: 'Your rage is full: your call. Smash It resets your rage but costs a racket. Keep It In: click the red thoughts, leave the green.', keys: 'Your rage is full: your call. {Digit1} Smash It resets your rage but costs a racket. {Digit2} Keep It In: {Space} swats the top thought. Swat the red, leave the green.' },
    missNoUp: { touch: 'NO FLICK: FLICK UP AS YOU LET GO', mouse: 'NO FLICK: FLICK THE MOUSE UP AS YOU LET GO', keys: 'NO SPIN: HOLD {KeyW} AS YOU LET GO' },
    missWrongUp: { touch: 'THAT WAS A SLICE: FLICK UP, NOT DOWN', keys: 'THAT WAS A SLICE: {KeyW}, NOT {KeyS}' },
    missNoDown: { touch: 'NO FLICK: FLICK DOWN AS YOU LET GO', mouse: 'NO FLICK: FLICK THE MOUSE DOWN AS YOU LET GO', keys: 'NO SPIN: HOLD {KeyS} AS YOU LET GO' },
    missWrongDown: { touch: 'THAT WAS TOPSPIN: FLICK DOWN, NOT UP', keys: 'THAT WAS TOPSPIN: {KeyS}, NOT {KeyW}' },
    // How to Play
    howServe: { touch: 'Hold to toss. Drag into the lit box. Let go.', mouse: 'Point at the lit box. Hold to toss, let go near the top of the bar.', keys: 'Hold {Space} to toss, let go near the top of the bar. {KeyA} {KeyD} pick the side.' },
    howHit: { touch: 'Drag to aim. Let go as the ring closes on the ball. Early or late and it sprays.', mouse: 'Point where you want it. Hold the button, let go as the ring closes. Early or late and it sprays.', keys: 'Hold {Space}, let go as the ring closes. Hold {KeyA} or {KeyD} to aim. Early or late and it sprays.' },
    howRun: { touch: 'Your legs do the running. You just hit.', mouse: 'Your legs do the running. Right-click to come to the net.', keys: 'Your legs do the running. The arrow keys steer if you want.' },
    howFoot: { touch: 'Close call? Tap <b>CHALLENGE</b>. Ace or a winner? Tap <b>CELEBRATE</b>. New moves are taught as you play.', mouse: 'Close call? Click <b>CHALLENGE</b> {KeyC}. Ace or a winner? Click <b>CELEBRATE</b> {KeyF}. {KeyP} pauses. New moves are taught as you play.', keys: 'Close call? {KeyC} to <b>CHALLENGE</b>. Ace or a winner? {KeyF} to <b>CELEBRATE</b>. {KeyP} pauses. New moves are taught as you play.' },
    howSpin: { touch: 'Flick up as you let go for topspin. Flick down for slice. Aim short and flick down for a drop shot.', mouse: 'Flick the mouse up as you let go for topspin, down for slice. Aim short and flick down for a drop shot.', keys: 'Hold {KeyW} as you let go for topspin, {KeyS} for slice. {KeyQ} plays a drop shot.' },
    howPower: { touch: 'Press early and hold. The ring fills, the ball goes harder, and somewhere less predictable.', mouse: 'Press the button early and hold. The ring fills, the ball goes harder, and somewhere less predictable.', keys: 'Press {Space} early and hold. The ring fills, the ball goes harder, and somewhere less predictable.' },
    howNet: { touch: 'Left thumb down to move yourself. Push it up to charge the net. Pro footwork (in Settings): you do all the running. Stand on the footprint before the ball arrives for a harder, straighter shot.', mouse: 'Right-click to charge the net, and again to drop back. Pro footwork (in Settings): you do all the running, with the arrow keys. Stand on the footprint before the ball arrives for a harder, straighter shot.', keys: 'The arrow keys move you, {ArrowUp} to charge the net. Pro footwork (in Settings): you do all the running. Stand on the footprint before the ball arrives for a harder, straighter shot.' },
    howLob: { touch: 'Flick up when they are at the net, or when you are scrambling wide and need time.', mouse: 'Flick the mouse up when they are at the net, or when you are scrambling wide and need time.', keys: 'Hold {KeyW} when they are at the net, or when you are scrambling wide and need time.' }
  };
  const ctlPick = (id) => { const c = CTL[id]; return c[INPUT.kind] || (INPUT.kind === 'keys' && c.mouse) || c.touch; };
  const ctl = (id) => ctlPick(id).replace(/\{(\w+)\}/g, (m, k) => keyName(k));
  const ctlHtml = (id) => ctlPick(id).replace(/\{(\w+)\}/g, (m, k) => '<kbd>' + keyName(k) + '</kbd>');
  // Menu text written for thumbs reads "click" on a computer
  const tapify = (s) => (INPUT.kind === 'touch' ? s : String(s).replace(/\bTap\b/g, 'Click').replace(/\btap\b/g, 'click'));
  // The full controls list for a computer: the pause menu and How to Play
  function controlsSheet() {
    const k = (c) => '<kbd>' + keyName(c) + '</kbd>';
    const row = (keys, what) => '<span><em>' + keys + '</em><i>' + what + '</i></span>';
    return '<div><b>Mouse</b>' + row('Point', 'aim') + row('Hold, let go', 'hit, on the ring') + row('Flick up, down', 'topspin, slice') + row('Right-click', 'to the net and back') + '</div>' +
      '<div><b>Keyboard</b>' + row(k('Space'), 'hold, let go on the ring') + row(k('KeyA') + k('KeyD'), 'aim left, right') + row(k('KeyW') + k('KeyS') + k('KeyQ'), 'topspin, slice, drop') +
      row(k('ArrowLeft') + k('ArrowUp') + k('ArrowRight'), 'move, up to the net') + row(k('KeyC') + k('KeyF'), 'challenge, celebrate') + row(k('KeyP') + k('KeyM'), 'pause, sound') + '</div>';
  }
  function refreshControls() {
    document.body.dataset.input = INPUT.kind;
    document.querySelectorAll('[data-ctl]').forEach((el) => { el.innerHTML = ctlHtml(el.dataset.ctl); });
    document.querySelectorAll('[data-hk]').forEach((el) => { el.textContent = keyName(el.dataset.hk); });
    document.querySelectorAll('[data-sheet]').forEach((el) => { el.innerHTML = controlsSheet(); });
  }
  // Keys that mean the player is playing on the keyboard
  const PLAY_KEYS = ['Space', 'Enter', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  // Keyboard on the menus: the buttons of the top layer (an open window, else the screen)
  function navButtons() {
    const layers = Array.from(document.querySelectorAll('.modal:not(.hidden), .overlay.show'));
    const root = layers.length ? layers[layers.length - 1] : document.querySelector('.screen.show') || document.body;
    return Array.from(root.querySelectorAll('button')).filter((b) => !b.disabled && b.offsetParent !== null && b.getBoundingClientRect().width > 0);
  }

  /* =====================================================================
     2. Game data
     ===================================================================== */
  const ROUNDS = ['Quarter Final', 'Semi Final', 'Final'];
  const ROUND_PRIZE = [1, 2, 4];

  const SURFACES = {
    grass: { court: '#3f8a3e', stripe: '#47944a', outside: '#2f7232', line: '#f6f6ee', speed: 1.08, bounceH: 0.85, bounceT: 0.9, marks: false },
    hard: { court: '#2d5c9a', stripe: '#2d5c9a', outside: '#2e6e55', line: '#f2f2f2', speed: 1, bounceH: 1, bounceT: 1, marks: false },
    indoor: { court: '#3b6e5c', stripe: '#3b6e5c', outside: '#7d3438', line: '#f2f2f2', speed: 1.04, bounceH: 0.95, bounceT: 0.95, marks: false },
    clay: { court: '#c2643b', stripe: '#c86a40', outside: '#b55a32', line: '#f3eee3', speed: 0.9, bounceH: 1.2, bounceT: 1.12, marks: true }
  };
  const SURF_PLAY = {
    grass: {
      note: 'Fast and low. Slice skids, serves fly, and the net pays.',
      spin: { slice: { bh: 0.72, keep: 1.14 }, sliceServe: { bh: 0.75, keep: 1.12 }, flat: { keep: 1.06 }, topspin: { bh: 0.88 }, kick: { bh: 0.85 }, volley: { keep: 1.1 }, drop: { keep: 0.85 } }
    },
    hard: { note: 'True bounce. What you hit is what you get.', spin: {} },
    indoor: {
      note: 'No wind, quick and flat. Big hitters love it.',
      spin: { flat: { keep: 1.08 }, smash: { keep: 1.08 }, topspin: { bh: 0.94 } }
    },
    clay: {
      note: 'Slow and high. Topspin kicks up, drop shots die, rallies go on.',
      spin: { topspin: { bh: 1.25, keep: 1.04 }, kick: { bh: 1.15 }, slice: { keep: 0.85 }, drop: { keep: 0.65, bh: 0.8 }, flat: { keep: 0.92 }, sliceServe: { keep: 0.9 } }
    }
  };

  const TIERS = [
    { name: 'Little Puddleby Lawn Tennis Club Open', short: 'Club Open', venue: 'Court 2, behind the tea hut', surface: 'grass', fine: 50, prize: 200, games: 4, strict: 0.15, windMax: 10, cheat: 0.4, trophy: 'The Puddleby Plate', ref: 'Mrs Penhaligon', crowd: 0.3 },
    { name: 'The County Closed Championships', short: 'County Closed', venue: 'The council courts, freshly swept', surface: 'hard', fine: 375, prize: 1500, games: 4, strict: 0.3, windMax: 14, cheat: 0.45, trophy: 'The County Tankard', ref: 'Mr Dobbs', crowd: 0.45 },
    { name: 'The Grimsby Indoor Challenger', short: 'Grimsby Challenger', venue: 'A leisure centre that smells of chips', surface: 'indoor', fine: 2000, prize: 8000, games: 5, strict: 0.45, windMax: 0, cheat: 0.5, trophy: 'The Grimsby Cod', ref: 'Ms Grieve', crowd: 0.6 },
    { name: 'The Royal Tunbridge Invitational', short: 'Tunbridge Invitational', venue: 'Centre Court, Royal Tunbridge', surface: 'clay', fine: 10000, prize: 40000, games: 5, strict: 0.6, windMax: 16, cheat: 0.55, trophy: 'The Tunbridge Salver', ref: 'Mr Ashdown', crowd: 0.8 },
    { name: 'The Grand Slam at Wimbleford', short: 'Grand Slam', venue: 'Centre Court, Wimbleford', surface: 'grass', fine: 62500, prize: 250000, games: 6, strict: 0.75, windMax: 12, cheat: 0.6, trophy: 'The Wimbleford Cup', ref: 'Mr Featherstonehaugh', crowd: 1 }
  ];

  const TRAIT_LABEL = { cheat: 'Line Call Cheat', grunter: 'Loud Grunter', timewaster: 'Time Waster' };

  const OPPONENTS = [
    [
      { name: 'Gerald Pinch', traits: ['cheat'], skill: 0.2, bio: 'Club treasurer. Called a ball in once, in 1994, and has never forgiven himself.', shirt: '#ece6cc', face: '#e8c3a0', band: '#2a4d8f', hair: '#9a9a9a', pitch: 150 },
      { name: 'Nigel Brannock', traits: ['timewaster'], skill: 0.28, bio: 'Retied his laces eleven times during the warm up. Both laces were already tied.', shirt: '#7aa6c2', face: '#f0c9a8', band: '#ffffff', hair: '#5a3b22', pitch: 140 },
      { name: 'Big Sue Tolland', traits: ['grunter'], skill: 0.36, bio: 'Grunts on the serve, the return and the handshake. Has been asked to leave a library.', shirt: '#d94f7a', face: '#d9a27c', band: '#ffd400', hair: '#2b1b12', pitch: 230 }
    ],
    [
      { name: 'Rupert Allsop', traits: ['grunter'], skill: 0.4, bio: 'Former school captain. Grunts in Latin, which he says is more dignified.', shirt: '#1f3a6b', face: '#f2cdb0', band: '#c8102e', hair: '#d9b25c', pitch: 160 },
      { name: 'Felicity Crane', traits: ['cheat'], skill: 0.46, bio: 'Perfect eyesight for balls on her side of the net. None whatsoever for yours.', shirt: '#f4f1e6', face: '#eac2a2', band: '#6b3fa0', hair: '#7a4a28', pitch: 240 },
      { name: 'The Reverend Hodge', traits: ['timewaster'], skill: 0.52, bio: 'Says a short prayer before every serve. The prayers are not short.', shirt: '#202020', face: '#c8956d', band: '#ffffff', hair: '#e2e2e2', pitch: 125 }
    ],
    [
      { name: 'Kev Mallard', traits: ['grunter'], skill: 0.55, bio: 'Registered with the council as a noise nuisance in two boroughs.', shirt: '#ff7a1a', face: '#efc19b', band: '#111111', hair: '#3a2a1a', pitch: 135 },
      { name: 'Tobias Wren', traits: ['timewaster'], skill: 0.6, bio: 'Takes a towel after every point, including the ones he did not play in.', shirt: '#2f8f83', face: '#a8714f', band: '#ffffff', hair: '#141414', pitch: 150 },
      { name: 'Anton Steele', traits: ['grunter', 'timewaster'], skill: 0.64, bio: 'Grunts loudly enough to drown out the umpire, then asks the umpire to repeat everything.', shirt: '#4a4a4a', face: '#e6bc98', band: '#d9f24a', hair: '#151515', pitch: 120 }
    ],
    [
      { name: 'Lady Araminta Fforde', traits: ['timewaster'], skill: 0.69, bio: 'Owns the land the courts are built on. And, she feels, the clock.', shirt: '#e9e4f5', face: '#f3d2b8', band: '#3b1f5c', hair: '#c9a24a', pitch: 250 },
      { name: 'Marcus Thwaite', traits: ['grunter', 'timewaster'], skill: 0.73, bio: 'Bounces the ball thirty times, then grunts as if the bouncing was the hard part.', shirt: '#8a1c2b', face: '#d8a582', band: '#ffffff', hair: '#2a2a2a', pitch: 130 },
      { name: 'Jonty Pemberton', traits: ['timewaster', 'grunter'], skill: 0.78, bio: 'Calls for the trainer whenever he is losing and for a review whenever you are winning.', shirt: '#f2c14e', face: '#f1cfb1', band: '#1f3a6b', hair: '#b07a3a', pitch: 145 }
    ],
    [
      { name: 'Henrik Lund', traits: ['timewaster'], skill: 0.81, bio: 'Arranges his water bottles by height between every point. There are nine.', shirt: '#dfe9f2', face: '#f5d6bd', band: '#0057b8', hair: '#f0dc9a', pitch: 135 },
      { name: 'Brad Colton', traits: ['grunter'], skill: 0.86, bio: 'His grunt registered on a seismograph in Kent. He considers this a personal best.', shirt: '#101010', face: '#c58c64', band: '#ff3b30', hair: '#101010', pitch: 115 },
      { name: 'The Baron', traits: ['grunter', 'timewaster'], skill: 0.92, bio: 'Nobody knows his first name. Nobody has seen him lose a point quietly. Nobody enjoys him.', shirt: '#3d1f4f', face: '#e2b896', band: '#d4af37', hair: '#1a1a1a', pitch: 110 }
    ]
  ];
  // Grudge Tour+ brings new faces: season 2 is all new, later seasons mix both rosters, and old rivals come back
  const OPPONENTS_B = [
    [
      { name: 'Dr Alan Pettigrew', traits: ['cheat'], skill: 0.2, bio: 'Retired dentist. Calls every close ball out, then explains why at length.', shirt: '#f2f2f2', face: '#f0c9a8', band: '#2f8f6b', hair: '#c9c9c9', pitch: 135 },
      { name: 'Maureen Clegg', traits: ['timewaster'], skill: 0.28, bio: 'Brings a flask. Pours a cup between points. Drinks it. All of it.', shirt: '#b5486b', face: '#e8c3a0', band: '#f4f1e6', hair: '#8a6a4a', pitch: 225 },
      { name: 'Dougie Fairbairn', traits: ['grunter'], skill: 0.36, bio: 'Grunts in a Scottish accent. He is from Swindon.', shirt: '#2f6b3a', face: '#e6b48f', band: '#ffd400', hair: '#c0462a', pitch: 125 }
    ],
    [
      { name: 'Priscilla Vane', traits: ['cheat'], skill: 0.4, bio: 'Line judge at the 1986 county finals. Still thinks she is.', shirt: '#6b3fa0', face: '#f2cdb0', band: '#f4f1e6', hair: '#2b1b12', pitch: 245 },
      { name: 'Gareth Bowes', traits: ['grunter'], skill: 0.46, bio: 'Personal trainer. Counts his reps out loud. Loses count at fourteen.', shirt: '#e2701c', face: '#8d5a3b', band: '#1a1a1a', hair: '#1a1a1a', pitch: 120 },
      { name: 'Colonel Ashby-Rudd', traits: ['timewaster'], skill: 0.52, bio: 'Inspects his racket like a rifle before every serve. Salutes the net.', shirt: '#4a5a3a', face: '#f0c9a8', band: '#c8102e', hair: '#e8e0d0', pitch: 115 }
    ],
    [
      { name: 'Shaz Pollock', traits: ['grunter'], skill: 0.55, bio: 'Leisure centre aerobics instructor. Every shot comes with a count of eight.', shirt: '#ff4fa3', face: '#d9a27c', band: '#33d1ff', hair: '#f2d16b', pitch: 235 },
      { name: 'Desmond Kirkby', traits: ['grunter', 'timewaster'], skill: 0.6, bio: 'Asks for a let on every serve. Then a towel. Then a let on the towel.', shirt: '#3b5f8a', face: '#5c3a26', band: '#f4f1e6', hair: '#151515', pitch: 130 },
      { name: 'Yvonne Strand', traits: ['timewaster', 'grunter'], skill: 0.64, bio: 'Has complained about the lighting at every venue in Lincolnshire, including outdoors.', shirt: '#1f4a33', face: '#eac2a2', band: '#e8c66a', hair: '#5a3b22', pitch: 215 }
    ],
    [
      { name: 'Sir Crispin Doyle', traits: ['timewaster'], skill: 0.69, bio: 'Knighted for services to tennis. Nobody can remember which services.', shirt: '#f4f1e6', face: '#f2cdb0', band: '#1f3a6b', hair: '#d9d9d9', pitch: 140 },
      { name: 'Ottilie Marchbanks', traits: ['timewaster'], skill: 0.73, bio: 'Rearranges her sweatbands by colour between points. She owns forty.', shirt: '#2a6b8f', face: '#c68e62', band: '#ff8a3a', hair: '#2b1b12', pitch: 230 },
      { name: 'Fabrice Leclerc', traits: ['grunter', 'timewaster'], skill: 0.78, bio: 'Clay specialist. Lies down to inspect every ball mark. Takes his time getting up.', shirt: '#1d2a6b', face: '#e6bc98', band: '#f4f1e6', hair: '#3a2716', pitch: 150 }
    ],
    [
      { name: 'Vanya Petrova', traits: ['grunter'], skill: 0.81, bio: 'Her grunt has its own sponsorship deal and a separate agent.', shirt: '#c8102e', face: '#f0c9a8', band: '#f4f1e6', hair: '#e8d08a', pitch: 240 },
      { name: 'Chad Huxley', traits: ['timewaster'], skill: 0.86, bio: 'Checks his hair in the scoreboard between points. It is always fine.', shirt: '#15151a', face: '#d9a27c', band: '#d4af37', hair: '#c49a5a', pitch: 145 },
      { name: 'The Duchess', traits: ['grunter', 'timewaster'], skill: 0.92, bio: 'Has never lost a line call. Has never been asked to explain one.', shirt: '#4a1f6b', face: '#eac2a2', band: '#d4af37', hair: '#9a9a9a', pitch: 220 }
    ]
  ];

  const DAILY_FIRST = ['Clive', 'Penelope', 'Barnaby', 'Hilary', 'Crispin', 'Moira', 'Dennis', 'Ottilie', 'Quentin', 'Sandra', 'Rufus', 'Bev', 'Hamish', 'Imogen', 'Terry', 'Wendy'];
  const DAILY_LAST = ['Blunt', 'Fothergill', 'Snape', 'Higginbottom', 'Prowse', 'Featherby', 'Gosling', 'Crumb', 'Thistlewood', 'Batt', 'Ogden', 'Pargeter', 'Smallbone', 'Twigg'];
  const SHIRTS = ['#ece6cc', '#d94f7a', '#1f3a6b', '#ff7a1a', '#2f8f83', '#8a1c2b', '#f2c14e', '#3d1f4f', '#7aa6c2'];
  const FACES = ['#e8c3a0', '#f0c9a8', '#d9a27c', '#c8956d', '#a8714f', '#f3d2b8', '#8d5a3b'];

  const STRICT_LABELS = [[0.25, 'Lenient'], [0.45, 'Fair'], [0.62, 'Fussy'], [0.8, 'Strict'], [2, 'Draconian']];
  const strictLabel = (s) => STRICT_LABELS.find((x) => s < x[0])[1];
  const skillLabel = (s) => (s < 0.35 ? 'Hopeful' : s < 0.5 ? 'Club Standard' : s < 0.65 ? 'Handy' : s < 0.78 ? 'Dangerous' : 'Terrifying');

  const COPY = {
    pNet: { main: 'NET', subs: ['The net has never lost a point to you.', 'Straight into the tape. Textbook, if the textbook is wrong.', 'The net cord sends its regards.'] },
    pOut: { main: 'OUT', subs: ['Out by a distance usually measured in postcodes.', 'Long. Commuter belt long.', 'Wide. The ball kids flinched.', 'Out. Nobody even hesitated.'] },
    whiff: { main: 'AIR SHOT', subs: ['A full swing at a ball that had already left.', 'Contact was optional, apparently.', 'You hit the air very hard. The air is fine.'] },
    noSwing: { main: 'WATCHED IT GO', subs: ['Admired it all the way past, like a tourist.', 'You stood very still. It did not help.', 'Lovely ball. Shame it was for you.'] },
    oWinner: { main: 'WINNER', subs: ['Clean winner. Unspeakably rude.', 'Passed you like a bus that was not stopping.', 'You were not there. Neither was your racket.'] },
    pWinner: { main: 'WINNER', subs: ['Untouchable. Briefly.', 'They did not even pretend to run.', 'Try to look like you meant it.'] },
    oNet: { main: 'NET', subs: ['Their mistake. Keep your joy private.', 'They netted it. Do not look smug. Too late.'] },
    oOut: { main: 'OUT', subs: ['Their ball is out. Celebrate inwardly, like a Victorian.', 'Long. Not your fault, for once.'] },
    ace: { main: 'ACE', subs: ['{mph} mph of pure resentment.', 'They saw it on the replay.', 'Untouched. Like your manners.'] },
    oAce: { main: 'ACE', subs: ['You did not see it. You barely heard it.', 'Served past you at {mph} mph. Lovely.'] },
    forcedErr: { main: 'FORCED ERROR', subs: ['You made them stretch. They did not enjoy it.', 'Pulled wide, and it showed.', 'That one was your doing.'] },
    unreturned: { main: 'UNRETURNED', subs: ['They got a frame on it. Barely.', 'Returned into the third row. That one is on your serve.', 'Netted the return. Your serve did that.'] },
    pFault: { main: 'FAULT', subs: ['Second serve. Breathe through your nose.', 'Fault. The service box remains a rumour.'] },
    oFault: { main: 'FAULT', subs: ['Their first serve misses. Do not clap.', 'Fault. Resist the urge to say anything.'] },
    pDouble: { main: 'DOUBLE FAULT', subs: ['Two serves. Zero in. A clean sweep of failure.', 'The service box remains unvisited.'] },
    oDouble: { main: 'DOUBLE FAULT', subs: ['They have gifted you a point. Accept it graciously. Or at all.'] },
    badCall: { main: 'OUT', subs: ['{opp} calls it out. With great confidence and no eye contact.', 'Out, says {opp}. Your blood pressure says otherwise.', '{opp} called it out without looking up from the towel.'] },
    badFault: { main: 'FAULT', subs: ['{opp} calls your serve out. It looked good from here.', 'Fault, apparently. Apparently.'] },
    umpCall: { main: 'CALLED OUT', subs: ['The umpire saw it differently. Challenge it?', 'Out, says the chair. The chair may need glasses.'] },
    umpFault: { main: 'FAULT', subs: ['The chair calls your serve out. Fancy a review?', 'Fault, says the umpire. Owl Vision is available.'] },
    noReview: { main: 'OUT', subs: ['{opp} calls it out. No umpire, no review. It stands.', 'No cameras at this event. {opp} knows it.', 'Out, says {opp}. Nobody can prove otherwise. That is the point.'] },
    pracNext: { main: 'NEXT BALL', subs: ['Derek reaches for another ball.', 'Derek nods. He has a lot of balls.', 'Again. Derek has nowhere to be.'] },
    tutNext: { main: 'NEXT LESSON', subs: ['Derek is writing something on his clipboard. It might be praise.', 'Derek nods. It is the most he has ever nodded.'] },
    closeOut: { main: 'OUT', subs: ['Too close to call from here. Challenge it, if you dare.', 'Very tight. The call sounded sure. Calls always sound sure.'] },
    pDrop: { main: 'DROP SHOT', subs: ['They ran. They arrived in time to watch it bounce twice.', 'Feathered over the net. Nobody expected finesse from you. Least of all you.'] },
    pLob: { main: 'LOB', subs: ['Over their head. They watched it like a lost balloon.', 'Lobbed. They turned round just in time to see it land.'] },
    pPass: { main: 'PASSING SHOT', subs: ['Straight past them at the net. They waved at it as it went.', 'Passed them at the net. They are pretending they meant to leave it.'] },
    pSmash: { main: 'SMASH', subs: ['Put away overhead with feeling. Mostly anger, but it counts.', 'Smashed. Some of that was about the line calls.'] },
    pVolley: { main: 'VOLLEY', subs: ['Punched away at the net. Very continental of you.', 'A crisp volley. Nobody knew you could do that. You included.'] },
    overHead: { main: 'OVER YOUR HEAD', subs: ['Lobbed. You reached up like someone waving at a passing plane.', 'Over you. Back up next time, or grow.'] },
    oDrop: { main: 'DROP SHOT', subs: ['Dropped short. You arrived in time to admire it.', 'A drop shot. You ran like someone chasing a bus that has already gone.'] },
    oSmash: { main: 'SMASH', subs: ['You lobbed it short. They said thank you with violence.', 'Put away overhead. The ball has not been seen since.'] },
    oVolley: { main: 'VOLLEY', subs: ['Punched away at the net. Nothing you could do, which never stops you.', 'Volleyed into the open court. Rude, but legal.'] },
    overturned: { main: 'OVERTURNED', subs: ['The ball was in. The umpire is suddenly very interested in the scoreboard.', 'In. Point to you. The crowd turns slowly to look at the chair.'] },
    overturnedAce: { main: 'OVERTURNED', subs: ['The serve was in. Ace. The umpire has gone a funny colour.'] },
    replay: { main: 'REPLAY THE POINT', subs: ['It was in, but {opp} could have reached it. Play it again.', 'Overturned. {opp} was right there, so the point is replayed.'] },
    jammed: { main: 'JAMMED', subs: ['Too fast and straight at them. They got a frame on it and nothing else.', 'Into the body at pace. The return is somewhere near the car park.'] },
    callStands: { main: 'CALL STANDS', subs: ['It was out. You used a challenge to confirm your own mistake.', 'Out. The replay was very clear and very public.'] },
    notReady: { main: 'NOT READY', subs: ['{opp} raises a hand. Not ready. For the last forty minutes.', '{opp} was not ready. {opp} is never ready.'] },
    deuce: { main: 'DEUCE', subs: ['Level again. Breathe through your nose.', 'Deuce. This could take a while. Bring snacks.', 'Deuce. Nobody wants this game to end, except everyone.'] },
    advYou: { main: 'ADVANTAGE', subs: ['Your advantage. Do not celebrate. You know what happens when you celebrate.', 'One point from the game. Hold your nerve, and your racket.'] },
    advThem: { main: 'ADVANTAGE', subs: ['Their advantage. The racket is looking at you nervously.', 'Advantage {opp}. A good moment to remain calm. Statistically, you will not.'] },
    tiebreak: { main: 'TIEBREAK', subs: ['First to seven, by two. Every point counts double in your blood pressure.'] },
    setPoint: { main: 'MATCH POINT', subs: ['One point from the match. Try to look relaxed. Not like that.'] },
    setPointThem: { main: 'MATCH POINT DOWN', subs: ['One point from defeat. A perfect time for composure. Or the other thing.'] },
    breakPoint: { main: 'BREAK POINT', subs: ['A chance to break serve. Try not to break anything else.'] },
    tooFar: { main: 'TOO FAR', subs: ['You lunged with real conviction and no chance.'] }
  };
  const GRUNTS = ['HNNNGH!', 'UUAAARGH!', 'HUUUAH!', 'EEEEYAH!', 'HNNNNNNGHAA!', 'HWAAAH!'];
  const MELT = {
    ok: ['You counted to ten. Then to eleven, to be safe.', 'The racket lives. It will never trust you again.', 'Inner peace located. Temporarily.']
  };
  const PENALTY = ['Warning', 'Point penalty', 'Game penalty', 'Default'];

  /* Press conference. Answers move reputation: negative is Crowd Villain, positive is Fan Favourite.
     fine is a fraction of the tier fine. */
  const OUTLETS = ['The Daily Grumble', 'Racket Monthly', 'The Puddleby Gazette', 'Lawn and Order', 'The Volley Times', 'Backhand Weekly', 'The Sunday Sulk'];
  // The regulars on the tennis beat. The club gets the local paper; the Slam gets everyone, plus photographers.
  const JOURNOS = [
    { name: 'Maud Fennimore', outlet: 'The Puddleby Gazette', hair: '#e8e0d0', jacket: '#4a6a3a', style: 'bun', skin: '#f0c9a8', red: false },
    { name: 'Clive Gravel', outlet: 'Lawn and Order', hair: '#5a3b22', jacket: '#6b4a2a', style: 'short', skin: '#e8c3a0', red: false },
    { name: 'Hilary Spout', outlet: 'The Daily Grumble', hair: '#c8642c', jacket: '#8a1c2b', style: 'bob', skin: '#f3d2b8', red: true },
    { name: 'Desmond Pike', outlet: 'Backhand Weekly', hair: '#9a9a9a', jacket: '#3a4a5a', style: 'bald', skin: '#d9a27c', red: false },
    { name: 'Priya Lamb', outlet: 'The Volley Times', hair: '#1a1a1a', jacket: '#2f6b5a', style: 'long', skin: '#a8714f', red: false },
    { name: 'Bev Nettle', outlet: 'The Sunday Sulk', hair: '#d8b46a', jacket: '#6b3fa0', style: 'curly', skin: '#f0c9a8', red: true },
    { name: 'Rory Quill', outlet: 'Racket Monthly', hair: '#2a1d14', jacket: '#1f3a6b', style: 'short', skin: '#8d5a3b', red: false }
  ];
  const PRESS_PACK = { club: [0, 1], council: [1, 3, 6], leisure: [2, 3, 4, 6], invitational: [2, 3, 4, 5, 6], slam: [2, 3, 4, 5, 6, 1] };
  const PHOTOGRAPHERS = { club: 0, council: 0, leisure: 1, invitational: 1, slam: 2 };
  // The chairs in each venue's press room
  const PRESS_CHAIR = {
    club: { frame: '#6b4a2a', back: '#8a5d33' },
    council: { frame: '#8a8f96', back: '#2f6fb0' },
    leisure: { frame: '#8a8f96', back: '#e2701c' },
    invitational: { frame: '#3a2a1a', back: '#2a6b4a' },
    slam: { frame: '#c9d1d9', back: '#5a2f86' }
  };
  // A follow-up, when an answer is too good to leave alone. One per press conference at most.
  const FOLLOW_UPS = {
    spicy: [
      { q: 'Can I quote you on that?', a: [{ t: 'Print it.', rep: -4, tone: 'spicy', exclusive: true }, { t: 'That was off the record.', rep: 3, tone: 'charming' }] },
      { q: 'Would you like to say that again, slower, for the cameras?', a: [{ t: 'Gladly.', rep: -4, tone: 'spicy', exclusive: true }, { t: 'I said nothing. Nobody saw anything.', rep: 2, tone: 'deadpan' }] }
    ],
    charming: [
      { q: 'Who are you, and what have you done with the real you?', a: [{ t: 'This is the real me now.', rep: 3, tone: 'charming' }, { t: 'Give it a week.', rep: -3, tone: 'spicy' }] },
      { q: 'Is this a new you, or a new publicist?', a: [{ t: 'Both, and they are lovely.', rep: 3, tone: 'charming' }, { t: 'The publicist quit at lunch.', rep: -2, tone: 'deadpan' }] }
    ]
  };
  const toneOf = (a) => a.tone || (a.rep >= 5 ? 'charming' : a.rep <= -5 ? 'spicy' : 'deadpan');
  const TONE_LABEL = { charming: 'Charming', spicy: 'Spicy', deadpan: 'Deadpan' };
  const PRESS = {
    tooSlow: {
      q: 'You pulled your hand away from {opp} at the net. Too slow, was it?',
      a: [
        { t: 'It was a joke. {opp} has no sense of humour.', rep: -6, h: 'TOO SLOW: STAR\'S PLAYGROUND PRANK SHOCKS CENTRE COURT' },
        { t: 'I apologise. I will send flowers.', rep: 8, h: 'HANDSHAKE SNUB STAR SAYS SORRY WITH FLOWERS' },
        { t: 'They were too slow. I do not make the rules.', rep: -10, h: 'TOO SLOW! STAR UNREPENTANT OVER NET SNUB' }
      ]
    },
    snubbed: {
      q: '{opp} walked straight past your handshake. How does that feel?',
      a: [
        { t: 'I hope their hand is all right.', rep: 8, h: 'SNUBBED STAR TAKES THE HIGH ROAD' },
        { t: 'I will shake it next time. Hard.', rep: -6, h: 'SNUBBED STAR VOWS CRUSHING HANDSHAKE' },
        { t: 'I shook hands with the umpire instead. Better grip.', rep: -1, h: 'UMPIRE GETS THE HANDSHAKE IN NET SNUB FARCE' }
      ]
    },
    revenge: {
      q: '{opp} beat you last time. Was today about revenge?',
      a: [
        { t: 'I never forget a scoreline.', rep: -4, h: 'STAR SETTLES OLD SCORE' },
        { t: 'Every match is a fresh start.', rep: 6, h: 'GRACIOUS STAR MOVES ON' },
        { t: 'I have a list. They are crossed off now.', rep: -8, h: 'STAR KEEPS A LIST' }
      ]
    },
    smashed: {
      q: 'You destroyed {n} racket{s} today. Talk us through your process.',
      a: [
        { t: 'The racket knew what it did.', rep: -12, h: 'NO REGRETS: STAR BLAMES EQUIPMENT' },
        { t: 'I have written to each of them personally to apologise.', rep: 12, h: 'TEARFUL STAR PENS LETTERS TO BROKEN RACKETS' },
        { t: 'They were like that when I got here.', rep: -3, h: 'RACKETS ALREADY BROKEN, CLAIMS STAR' }
      ]
    },
    clean: {
      q: 'Not a single racket harmed today. Are you feeling unwell?',
      a: [
        { t: 'I have taken up breathing. It is very effective.', rep: 8, h: 'STAR DISCOVERS BREATHING, CALLS IT A GAME CHANGER' },
        { t: 'The rackets know I am watching them.', rep: -6, h: 'THREATS ISSUED TO SPORTING GOODS' },
        { t: 'Give it time.', rep: -2, h: 'CALM BEFORE THE STORM, WARNS STAR' }
      ]
    },
    cheat: {
      q: '{opp} called a lot of your shots out. Did you agree with any of them?',
      a: [
        { t: 'I am sure {opp} believed every single one. Faith is a wonderful thing.', rep: 8, h: 'GRACIOUS IN DEFEAT OF THE LINES' },
        { t: 'I would like to see {opp}\'s optician\'s records.', rep: -10, fine: 0.5, h: 'OPTICIAN ROW: STAR FINED FOR EYE TEST SLUR' },
        { t: 'I agreed with one. It was a crisp packet.', rep: -2, h: 'CRISP PACKET THE ONLY THING CALLED CORRECTLY' }
      ]
    },
    grunter: {
      q: 'Did the grunting bother you?',
      a: [
        { t: 'I assumed someone was being slowly sat on.', rep: -8, h: 'GRUNT FEUD ERUPTS IN INTERVIEW ROOM' },
        { t: 'It is part of the game. A loud, damp part.', rep: 5, h: 'STAR TAKES THE HIGH ROAD, NOTES DAMPNESS' },
        { t: 'I have reported it to the council as a noise complaint.', rep: -3, h: 'COUNCIL TO INVESTIGATE TENNIS NOISE' }
      ]
    },
    timewaster: {
      q: '{opp} took nearly four minutes to serve at one point. Thoughts?',
      a: [
        { t: 'Everyone prepares differently. Some prepare forever.', rep: 6, h: 'PATIENT STAR PRAISES ENDLESS PREPARATION' },
        { t: 'I aged visibly. I came here with dark hair.', rep: 0, h: 'MATCH SO SLOW PLAYER GOES GREY' },
        { t: 'I have started a petition. It has one signature. Mine.', rep: -6, h: 'ONE MAN PETITION AGAINST TIME WASTING' }
      ]
    },
    violations: {
      q: 'The umpire gave you {v} code violation{vs}. Do you have anything to say to the umpire?',
      a: [
        { t: 'Only that the umpire was right, and that I am a work in progress.', rep: 10, h: 'CONTRITE STAR ADMITS BEING A WORK IN PROGRESS' },
        { t: 'Yes. Several things. Mostly in mime.', rep: -12, fine: 1, h: 'MIME OUTBURST COSTS STAR AGAIN' },
        { t: 'We have agreed to see other people.', rep: -2, h: 'UMPIRE AND STAR CALL IT A DAY' }
      ]
    },
    generic: [
      {
        q: 'A young fan asked for your sweatband after the match. Will you be giving it to them?',
        a: [
          { t: 'Absolutely. Signed, washed, and with a short note on posture.', rep: 12, h: 'STAR GIFTS SWEATBAND, ADVICE NOBODY ASKED FOR' },
          { t: 'Once it stops smelling of the third game, yes.', rep: 2, h: 'SWEATBAND DELAYED FOR HYGIENE REASONS' },
          { t: 'No. It is evidence.', rep: -9, h: 'STAR REFUSES CHILD, CITES EVIDENCE' }
        ]
      },
      {
        q: 'How would you describe your temperament on court?',
        a: [
          { t: 'A gentle stream that floods occasionally.', rep: 4, h: 'FLOOD WARNINGS ISSUED FOR CENTRE COURT' },
          { t: 'Volcanic, but in a quiet, residential sort of way.', rep: -4, h: 'SUBURBAN VOLCANO STRIKES AGAIN' },
          { t: 'Ask the rackets. Oh wait.', rep: -8, h: 'GALLOWS HUMOUR FROM THE BASELINE' }
        ]
      },
      {
        q: 'Some say you set a bad example for the youth game. Fair?',
        a: [
          { t: 'Fair. I am working on it with a professional and a stress ball.', rep: 10, h: 'STAR SEEKS HELP, SQUEEZES BALL' },
          { t: 'The youth game could do with some passion.', rep: -8, h: 'STAR WANTS TODDLERS SMASHING RACKETS' },
          { t: 'I set a bad example for everybody. I do not discriminate.', rep: -3, h: 'EQUAL OPPORTUNITIES MENACE' }
        ]
      },
      {
        q: 'You were heard using an audible obscenity in the second game. Care to repeat it?',
        a: [
          { t: 'I said fiddlesticks. With considerable emphasis.', rep: 7, h: 'FIDDLESTICKS FURY ROCKS THE CLUB' },
          { t: 'I can write it down for you, if you have a long piece of paper.', rep: -10, fine: 0.5, h: 'STAR FINED AGAIN FOR LONG WORD' },
          { t: 'I was reading out the menu. It was a very upsetting menu.', rep: -1, h: 'MENU BLAMED FOR OUTBURST' }
        ]
      },
      {
        q: 'Who do you dedicate this win to?',
        a: [
          { t: 'My mum, my coach and the people who sweep up the graphite.', rep: 10, h: 'STAR THANKS THE CLEANERS, NATION WEEPS' },
          { t: 'Myself. I did all the work.', rep: -10, h: 'SELF DEDICATED VICTORY FOR SELF MADE STAR' },
          { t: 'The net. We have had our differences.', rep: 2, h: 'TENDER WORDS FOR THE NET' }
        ]
      }
    ],
    celebs: {
      q: 'You celebrated every winner like a cup final. Was that strictly necessary?',
      a: [
        { t: 'I was celebrating the sport, not myself. Mostly the sport.', rep: 4, h: 'STAR CELEBRATES SPORT, ALSO SELF' },
        { t: 'If you hit shots like mine, you would dance too.', rep: -8, h: 'MODEST STAR COMPARES SELF TO GREATS, GREATS UNAVAILABLE' },
        { t: 'My physio says it helps my temper. My physio also says a lot of things.', rep: 2, h: 'THERAPEUTIC CELEBRATIONS ARE PHYSIO APPROVED' }
      ]
    },
    final: {
      q: 'You are the champion. Any message for {opp}?',
      a: [
        { t: 'Unlucky. Genuinely. Mostly.', rep: 8, h: 'CHAMPION SPARES A THOUGHT, MOSTLY' },
        { t: 'Practise.', rep: -12, h: 'ONE WORD WINNER LEAVES ROOM IN SILENCE' },
        { t: 'I would like to thank the ball kids, most of whom were awake.', rep: 0, h: 'BALL KIDS THANKED, WOKEN' }
      ]
    }
  };
  // Second versions of the questions that come up most, so a long career does not repeat itself
  const PRESS_ALT = {
    smashed: [{
      q: 'Your racket bag is lighter than when you arrived. Where did {n} racket{s} go?',
      a: [
        { t: 'Somewhere better. A farm, I think.', rep: 6, h: 'RACKETS SENT TO LIVE ON A FARM, INSISTS STAR' },
        { t: 'Ask the net. It knows what it did.', rep: -10, h: 'STAR BLAMES NET FOR RACKET MASSACRE' },
        { t: 'I am travelling light this season.', rep: -2, h: 'STAR CLAIMS DESTRUCTION WAS JUST PACKING' }
      ]
    }],
    clean: [{
      q: 'No tantrums today. Your sponsor seems confused. Should they be worried?',
      a: [
        { t: 'My sponsor should be proud. I certainly am.', rep: 9, h: 'PROUD STAR PRAISES OWN RESTRAINT' },
        { t: 'Tell them to enjoy it while it lasts.', rep: -7, h: 'STAR ISSUES TANTRUM WARNING TO SPONSOR' },
        { t: 'I was saving it for the car park.', rep: -3, h: 'CAR PARK BRACES ITSELF' }
      ]
    }],
    violations: [{
      q: 'That is {v} code violation{vs} today. Is the umpire your nemesis now?',
      a: [
        { t: 'The umpire did a difficult job very well. Mostly.', rep: 9, h: 'STAR PRAISES UMPIRE, MOSTLY' },
        { t: 'I have their address. I mean, their autograph.', rep: -12, fine: 1, h: 'STAR IN UMPIRE ADDRESS GAFFE' },
        { t: 'We are more like pen pals. Angry pen pals.', rep: -2, h: 'UMPIRE FEUD NOW CONDUCTED BY LETTER' }
      ]
    }],
    celebs: [{
      q: 'You celebrated a net cord like you had won the lottery. Explain.',
      a: [
        { t: 'Every point is a gift. I unwrap them loudly.', rep: 6, h: 'STAR UNWRAPS EVERY POINT LOUDLY' },
        { t: 'If they did not want it celebrated, they should have won it.', rep: -9, h: 'GLOATING STAR SHOWS NO MERCY' },
        { t: 'I was celebrating something else. Personal news.', rep: -1, h: 'MYSTERY CELEBRATION SPARKS RUMOURS' }
      ]
    }]
  };
  // The second writing batch: 20 more general questions and 20 second versions of the story questions
  const PRESS_BATCH2 = {
    "generic": [
      {
        "q": "The tea hut ran out of scones during your match. Were you responsible?",
        "a": [
          {
            "t": "I will bake the replacements myself. Badly, but with love.",
            "rep": 8,
            "h": "STAR VOWS TO BAKE FOR TEA HUT"
          },
          {
            "t": "The scones were looking at me. I dealt with it.",
            "rep": -8,
            "h": "SCONE MASSACRE AT THE TEA HUT"
          },
          {
            "t": "I had four. One for each emotion.",
            "rep": -1,
            "h": "STAR EATS FEELINGS, AND FOUR SCONES"
          }
        ]
      },
      {
        "q": "{opp} called you the rudest player on tour. Your response?",
        "a": [
          {
            "t": "I will work on it. Starting with a thank you card to {opp}.",
            "rep": 8,
            "h": "THANK YOU CARD ENDS RUDENESS ROW"
          },
          {
            "t": "Rudest on tour? I have not even started.",
            "rep": -9,
            "h": "RUDEST STAR: I HAVE NOT EVEN STARTED"
          },
          {
            "t": "I prefer the word candid. Loudly candid.",
            "rep": 0,
            "h": "STAR REBRANDS RUDENESS AS CANDOUR"
          }
        ]
      },
      {
        "q": "You argued with a pigeon on the baseline. Who won?",
        "a": [
          {
            "t": "The pigeon. It had more composure than me. I learned a lot.",
            "rep": 6,
            "h": "PIGEON TEACHES STAR COMPOSURE"
          },
          {
            "t": "Me. It will not be back. Its friends know why.",
            "rep": -8,
            "h": "PIGEON FEUD TAKES SINISTER TURN"
          },
          {
            "t": "We agreed a draw. Neither of us is happy.",
            "rep": 0,
            "h": "PIGEON TALKS END IN STALEMATE"
          }
        ]
      },
      {
        "q": "How did you feel when {opp} took a medical timeout at match point?",
        "a": [
          {
            "t": "Concerned. Health comes first. I hope the ankle is fine.",
            "rep": 8,
            "h": "CARING STAR PUTS RIVAL HEALTH FIRST"
          },
          {
            "t": "That ankle made a miraculous recovery the moment they lost.",
            "rep": -9,
            "h": "MIRACLE ANKLE: STAR CRIES FOUL"
          },
          {
            "t": "I used the time to fold my towels. They look lovely.",
            "rep": 1,
            "h": "STAR FOLDS TOWELS DURING CRISIS"
          }
        ]
      },
      {
        "q": "The line judge needed a lie down after the match. Any comment?",
        "a": [
          {
            "t": "I have sent a hamper and a sincere apology.",
            "rep": 9,
            "h": "HAMPER SENT TO SHAKEN LINE JUDGE"
          },
          {
            "t": "Good. Lying down is the only thing they called correctly.",
            "rep": -10,
            "fine": 1,
            "h": "LINE JUDGE INSULTED WHILE HORIZONTAL"
          },
          {
            "t": "So did I. It was a long match.",
            "rep": -1,
            "h": "EVERYONE LIES DOWN AFTER MATCH"
          }
        ]
      },
      {
        "q": "Any advice for the people at home trying to copy your forehand?",
        "a": [
          {
            "t": "Bend your knees, stay calm, and keep the racket in one piece.",
            "rep": 9,
            "h": "STAR GIVES NATION A FREE LESSON"
          },
          {
            "t": "Do not bother. Some things cannot be taught, only feared.",
            "rep": -8,
            "h": "STAR SAYS FOREHAND CANNOT BE TAUGHT"
          },
          {
            "t": "Mind the lampshade. I lost three that way.",
            "rep": 0,
            "h": "LAMPSHADE WARNING ISSUED TO NATION"
          }
        ]
      },
      {
        "q": "{opp} brought eleven rackets today. Is that more than you?",
        "a": [
          {
            "t": "Much more. {opp} is clearly better organised than me.",
            "rep": 6,
            "h": "STAR PRAISES RIVAL ORGANISATION"
          },
          {
            "t": "Eleven? I could get through those by lunch.",
            "rep": -9,
            "h": "STAR EYES RIVAL RACKETS HUNGRILY"
          },
          {
            "t": "I counted them. Then I counted mine. Then I had a little sit down.",
            "rep": -1,
            "h": "RACKET ENVY HITS STAR"
          }
        ]
      },
      {
        "q": "There were reports of shouting from your locker room. What happened?",
        "a": [
          {
            "t": "I was singing. Badly. I apologise to everyone with ears.",
            "rep": 6,
            "h": "STAR APOLOGISES FOR SINGING"
          },
          {
            "t": "The hand dryer and I had words. Only one of us walked away.",
            "rep": -8,
            "h": "HAND DRYER DESTROYED IN LOCKER ROOM"
          },
          {
            "t": "That was the physio. I owe the physio money.",
            "rep": -2,
            "h": "PHYSIO SHOUTING OVER UNPAID BILL"
          }
        ]
      },
      {
        "q": "Do you read what the newspapers write about you?",
        "a": [
          {
            "t": "Every word. Some of the headlines are better than my tennis.",
            "rep": 8,
            "h": "HEADLINES BETTER THAN TENNIS, ADMITS STAR"
          },
          {
            "t": "I read them, then I serve balls at them in practice.",
            "rep": -7,
            "h": "NEWSPAPERS USED AS SERVING TARGETS"
          },
          {
            "t": "Only the crossword. It is the only fair section.",
            "rep": 0,
            "h": "STAR ONLY TRUSTS THE CROSSWORD"
          }
        ]
      },
      {
        "q": "You were seen apologising to a ball after the match. Why?",
        "a": [
          {
            "t": "I hit it very hard. Everyone deserves an apology, even felt.",
            "rep": 7,
            "h": "STAR SAYS SORRY TO TENNIS BALL"
          },
          {
            "t": "I was not apologising. I was making it a promise.",
            "rep": -8,
            "h": "TENNIS BALL RECEIVES CHILLING PROMISE"
          },
          {
            "t": "It was a mistake. I thought it was my brother.",
            "rep": -1,
            "h": "STAR MISTAKES BALL FOR BROTHER"
          }
        ]
      },
      {
        "q": "What did you say to {opp} at the net?",
        "a": [
          {
            "t": "Well played, and that their backhand is the best I have seen.",
            "rep": 9,
            "h": "STAR HAILS RIVAL BACKHAND AT NET"
          },
          {
            "t": "I wished them luck in their next career.",
            "rep": -9,
            "h": "STAR WISHES RIVAL LUCK IN NEW CAREER"
          },
          {
            "t": "We talked about parking. It is very bad here.",
            "rep": 1,
            "h": "NET TALKS FOCUS ON PARKING"
          }
        ]
      },
      {
        "q": "The crowd sang your name at match point. Did that help?",
        "a": [
          {
            "t": "Enormously. I would like to buy every one of them an ice lolly.",
            "rep": 9,
            "h": "STAR PROMISES CROWD ICE LOLLIES"
          },
          {
            "t": "They were flat in the chorus. I will be sending notes.",
            "rep": -7,
            "h": "STAR CRITIQUES FANS SINGING"
          },
          {
            "t": "They got my name wrong. I let it go.",
            "rep": 0,
            "h": "FANS SING WRONG NAME, STAR LETS IT GO"
          }
        ]
      },
      {
        "q": "Is it true you once threw a racket into a river?",
        "a": [
          {
            "t": "Yes, and I paid for a team of divers to fetch it.",
            "rep": 6,
            "h": "STAR FUNDS RACKET RESCUE DIVE"
          },
          {
            "t": "It was a lake. Get your facts right.",
            "rep": -8,
            "h": "STAR CORRECTS PRESS: IT WAS A LAKE"
          },
          {
            "t": "Into is a strong word. Towards.",
            "rep": -2,
            "h": "STAR DISPUTES RIVER RACKET DETAILS"
          }
        ]
      },
      {
        "q": "Your mother was in the crowd. What does she make of your behaviour?",
        "a": [
          {
            "t": "She is proud of the tennis and patient with the rest.",
            "rep": 8,
            "h": "MUM PROUD OF TENNIS, PATIENT WITH REST"
          },
          {
            "t": "She taught me everything. Ask her about the 1994 church fete.",
            "rep": -8,
            "h": "MUM BLAMED IN CHURCH FETE TEMPER ROW"
          },
          {
            "t": "She left at four games all. She had a casserole in.",
            "rep": 0,
            "h": "MUM LEAVES EARLY FOR CASSEROLE"
          }
        ]
      },
      {
        "q": "How do you rate the new electronic line calling?",
        "a": [
          {
            "t": "It is fair and accurate. I am learning to accept both.",
            "rep": 7,
            "h": "STAR MAKES PEACE WITH THE MACHINES"
          },
          {
            "t": "I do not argue with machines. I unplug them.",
            "rep": -10,
            "fine": 1,
            "h": "STAR THREATENS TO UNPLUG LINE CALLING"
          },
          {
            "t": "It agrees with me more than people do. We are close.",
            "rep": 1,
            "h": "STAR BEFRIENDS LINE CALLING COMPUTER"
          }
        ]
      },
      {
        "q": "You smiled at {opp} at the changeover. Was that deliberate?",
        "a": [
          {
            "t": "Yes. I am trying new things. My face is still adjusting.",
            "rep": 7,
            "h": "STAR SMILES, FACE STILL ADJUSTING"
          },
          {
            "t": "It was a warning. {opp} understood.",
            "rep": -7,
            "h": "STAR SMILE WAS A THREAT"
          },
          {
            "t": "I had a sweet in my mouth. A very good sweet.",
            "rep": -1,
            "h": "SMILE CAUSED BY SWEET, CONFIRMS STAR"
          }
        ]
      },
      {
        "q": "{opp} says they like playing you because you beat yourself. Fair?",
        "a": [
          {
            "t": "Fair point. Today I decided to let someone else have a go.",
            "rep": 7,
            "h": "STAR STOPS BEATING SELF, BEATS RIVAL"
          },
          {
            "t": "{opp} would know. {opp} has been beaten by everybody.",
            "rep": -10,
            "h": "STAR SAYS RIVAL BEATEN BY EVERYBODY"
          },
          {
            "t": "I did beat myself. Then I beat {opp}. Busy day.",
            "rep": 0,
            "h": "STAR BEATS TWO PEOPLE IN BUSY DAY"
          }
        ]
      },
      {
        "q": "The umbrella man says you shouted at the rain. Is that right?",
        "a": [
          {
            "t": "I did, and I have apologised to the rain and the umbrella man.",
            "rep": 6,
            "h": "STAR APOLOGISES TO THE RAIN"
          },
          {
            "t": "The rain started it. I finished it.",
            "rep": -7,
            "h": "STAR CLAIMS VICTORY OVER WEATHER"
          },
          {
            "t": "It stopped, did it not? Draw your own conclusions.",
            "rep": -1,
            "h": "STAR TAKES CREDIT FOR SUNSHINE"
          }
        ]
      },
      {
        "q": "What did {opp} do that annoyed you most today?",
        "a": [
          {
            "t": "Nothing at all. {opp} was a fair and gentle opponent.",
            "rep": 8,
            "h": "STAR FINDS NOTHING TO HATE IN RIVAL"
          },
          {
            "t": "The headband. Nobody needs a headband that bright.",
            "rep": -7,
            "h": "HEADBAND FURY: STAR SLAMS RIVAL ACCESSORY"
          },
          {
            "t": "They hummed between points. The same tune. For two hours.",
            "rep": -1,
            "h": "RIVAL HUMS ONE TUNE FOR TWO HOURS"
          }
        ]
      },
      {
        "q": "Your physio was seen crying outside the stadium. Should we worry?",
        "a": [
          {
            "t": "Happy tears. I thanked them properly for the first time.",
            "rep": 9,
            "h": "PHYSIO WEEPS AT FIRST THANK YOU"
          },
          {
            "t": "They will get over it. I told them the truth about their massages.",
            "rep": -8,
            "h": "STAR SLAMS PHYSIO MASSAGE TECHNIQUE"
          },
          {
            "t": "They found my receipts for strings. It was a lot.",
            "rep": -2,
            "h": "PHYSIO SEES STRING RECEIPTS, WEEPS"
          }
        ]
      }
    ],
    "alt": {
      "smashed": [
        {
          "q": "You broke {n} racket{s} today. Will the manufacturer keep sending them?",
          "a": [
            {
              "t": "I hope so. I have promised to treat the next one gently.",
              "rep": 8,
              "h": "STAR PROMISES GENTLE CARE OF NEXT RACKET"
            },
            {
              "t": "They should pay me. I am their best customer.",
              "rep": -9,
              "h": "STAR DEMANDS PAY FROM RACKET MAKER"
            },
            {
              "t": "They have started sending them already broken. It saves time.",
              "rep": -2,
              "h": "RACKETS NOW ARRIVE ALREADY BROKEN"
            }
          ]
        },
        {
          "q": "{n} racket{s} gone today. Is there a memorial service planned?",
          "a": [
            {
              "t": "A small one. Strings will be played. Everyone is welcome.",
              "rep": 7,
              "h": "RACKETS HONOURED AT MOVING SERVICE"
            },
            {
              "t": "No. They knew the risks when they signed up.",
              "rep": -10,
              "h": "NO MEMORIAL FOR FALLEN RACKETS"
            },
            {
              "t": "Closed casket. It is the only kind with rackets.",
              "rep": -1,
              "h": "CLOSED CASKET FOR SMASHED RACKETS"
            }
          ]
        }
      ],
      "clean": [
        {
          "q": "Every racket survived today. Have you spoken to them since?",
          "a": [
            {
              "t": "I took them out for dinner. They earned it.",
              "rep": 7,
              "h": "STAR TREATS RACKETS TO DINNER"
            },
            {
              "t": "They are on probation. One wobble and that is it.",
              "rep": -6,
              "h": "RACKETS PLACED ON PROBATION"
            },
            {
              "t": "They are not speaking to me. Old wounds.",
              "rep": -1,
              "h": "RACKETS GIVE STAR SILENT TREATMENT"
            }
          ]
        },
        {
          "q": "Your racket stringer had nothing to do today. Will they cope?",
          "a": [
            {
              "t": "I bought them a good book. They deserve the rest.",
              "rep": 8,
              "h": "STAR GIFTS BOOK TO IDLE STRINGER"
            },
            {
              "t": "They should enjoy the holiday. Wednesday will be busy.",
              "rep": -7,
              "h": "STRINGER WARNED ABOUT WEDNESDAY"
            },
            {
              "t": "They restrung my umbrella out of habit.",
              "rep": 0,
              "h": "BORED STRINGER RESTRINGS UMBRELLA"
            }
          ]
        }
      ],
      "violations": [
        {
          "q": "{v} code violation{vs} today. Are you trying to collect the full set?",
          "a": [
            {
              "t": "No. I am trying to stop collecting them. Slowly.",
              "rep": 8,
              "h": "STAR VOWS TO QUIT COLLECTING VIOLATIONS"
            },
            {
              "t": "Yes. The umpire is keeping my sticker album for me.",
              "rep": -9,
              "h": "STAR TREATS VIOLATIONS LIKE STICKERS"
            },
            {
              "t": "I am two short of a free tea towel.",
              "rep": -2,
              "h": "VIOLATIONS TEA TOWEL NEARLY COMPLETE"
            }
          ]
        },
        {
          "q": "The umpire handed you {v} code violation{vs}. What were they for?",
          "a": [
            {
              "t": "Fair calls, every one. I accept them all.",
              "rep": 9,
              "h": "STAR ACCEPTS EVERY VIOLATION"
            },
            {
              "t": "For telling the truth about that hat the umpire wears.",
              "rep": -11,
              "fine": 1,
              "h": "UMPIRE HAT INSULT LANDS STAR IN TROUBLE"
            },
            {
              "t": "I do not know. I stopped listening after the first.",
              "rep": -2,
              "h": "STAR STOPPED LISTENING TO UMPIRE"
            }
          ]
        }
      ],
      "celebs": [
        {
          "q": "You did a cartwheel after a break of serve. Is that a new routine?",
          "a": [
            {
              "t": "It was pure joy. I am sorry it was so wobbly.",
              "rep": 6,
              "h": "JOYFUL STAR SORRY FOR WOBBLY CARTWHEEL"
            },
            {
              "t": "It was for {opp}. A little reminder of the score.",
              "rep": -8,
              "h": "STAR CARTWHEELS IN RIVAL FACE"
            },
            {
              "t": "It was a fall with a positive attitude.",
              "rep": 1,
              "h": "CARTWHEEL WAS ACTUALLY A FALL"
            }
          ]
        }
      ],
      "revenge": [
        {
          "q": "{opp} beat you in your last meeting. Did you watch the replay?",
          "a": [
            {
              "t": "Many times. {opp} taught me a lot that day.",
              "rep": 8,
              "h": "STAR LEARNS FROM OLD DEFEAT"
            },
            {
              "t": "Once. Then I put it in the bin and set fire to the bin.",
              "rep": -9,
              "h": "STAR BURNS RIVAL REPLAY IN BIN"
            },
            {
              "t": "I watched it backwards. I win that version.",
              "rep": 0,
              "h": "STAR WINS REPLAY BY WATCHING IT BACKWARDS"
            }
          ]
        },
        {
          "q": "You lost to {opp} last time. Did that defeat keep you awake?",
          "a": [
            {
              "t": "A little. It made me work harder, so thank you {opp}.",
              "rep": 8,
              "h": "STAR THANKS RIVAL FOR SLEEPLESS NIGHTS"
            },
            {
              "t": "Yes. I lay there thinking about today. Today was lovely.",
              "rep": -8,
              "h": "STAR SAVOURS LONG AWAITED REVENGE"
            },
            {
              "t": "No. The flat upstairs is learning the trombone.",
              "rep": -1,
              "h": "TROMBONE BLAMED FOR LOST SLEEP"
            }
          ]
        }
      ],
      "final": [
        {
          "q": "Champion at last. What will you do with the trophy?",
          "a": [
            {
              "t": "Share it with my family and the stringers who kept me going.",
              "rep": 9,
              "h": "CHAMPION SHARES TROPHY WITH STRINGERS"
            },
            {
              "t": "Put it in my window, where {opp} can see it.",
              "rep": -10,
              "h": "TROPHY PLACED IN RIVAL EYELINE"
            },
            {
              "t": "Keep it well away from my rackets. They get jealous.",
              "rep": 1,
              "h": "TROPHY HIDDEN FROM JEALOUS RACKETS"
            }
          ]
        },
        {
          "q": "You beat {opp} in the final. What went through your head at match point?",
          "a": [
            {
              "t": "That {opp} deserved a better day. And that I needed the loo.",
              "rep": 7,
              "h": "CHAMPION SPARES THOUGHT FOR RIVAL, AND LOO"
            },
            {
              "t": "That I would remember their face for ever. It was a lovely face.",
              "rep": -8,
              "h": "CHAMPION SAVOURS RIVAL DEFEAT FACE"
            },
            {
              "t": "Mostly whether I had left the oven on.",
              "rep": 0,
              "h": "CHAMPION WORRIED ABOUT OVEN"
            }
          ]
        }
      ],
      "cheat": [
        {
          "q": "{opp} called your best winner out. Did you see where it landed?",
          "a": [
            {
              "t": "{opp} had a better view than me. I will trust that.",
              "rep": 7,
              "h": "STAR TRUSTS RIVAL ON DISPUTED CALL"
            },
            {
              "t": "Yes. So did everyone except {opp}, who was looking at the sky.",
              "rep": -9,
              "h": "STAR SAYS RIVAL WAS WATCHING THE SKY"
            },
            {
              "t": "In. It is now in a frame in my kitchen.",
              "rep": -2,
              "h": "DISPUTED BALL FRAMED IN KITCHEN"
            }
          ]
        },
        {
          "q": "Did {opp} get any line calls right today?",
          "a": [
            {
              "t": "Plenty. Calling lines is hard and {opp} did their best.",
              "rep": 8,
              "h": "STAR DEFENDS RIVAL LINE CALLS"
            },
            {
              "t": "{opp} called one ball out before I had even hit it.",
              "rep": -10,
              "fine": 1,
              "h": "STAR ACCUSES RIVAL OF EARLY CALLS"
            },
            {
              "t": "They called the coin toss right. I will give them that.",
              "rep": -1,
              "h": "RIVAL CALLS COIN TOSS CORRECTLY"
            }
          ]
        }
      ],
      "grunter": [
        {
          "q": "The grunting hit a hundred decibels today. Could you hear yourself think?",
          "a": [
            {
              "t": "Barely, but it is not my place to judge. Some effort is loud.",
              "rep": 6,
              "h": "STAR RESPECTS LOUD EFFORT"
            },
            {
              "t": "Think? I could not even hear my own swearing.",
              "rep": -7,
              "h": "STAR LOSES OWN SWEARING IN GRUNT STORM"
            },
            {
              "t": "Three car alarms went off. All of them were answering back.",
              "rep": -1,
              "h": "CAR ALARMS JOIN GRUNTING DUET"
            }
          ]
        },
        {
          "q": "{opp} grunts on every shot. Have you ever tried grunting back?",
          "a": [
            {
              "t": "No. One grunter per court is plenty for everybody.",
              "rep": 6,
              "h": "STAR REFUSES TO JOIN GRUNT WAR"
            },
            {
              "t": "I hum the shipping forecast at them. It is very effective.",
              "rep": -8,
              "h": "STAR WEAPONISES THE SHIPPING FORECAST"
            },
            {
              "t": "Once. A seagull answered and we have been close since.",
              "rep": -1,
              "h": "SEAGULL ANSWERS STAR GRUNT"
            }
          ]
        }
      ],
      "timewaster": [
        {
          "q": "{opp} bounced the ball thirty times before one serve. Did you count?",
          "a": [
            {
              "t": "I did, but only to admire the consistency.",
              "rep": 6,
              "h": "STAR ADMIRES RIVAL BOUNCING"
            },
            {
              "t": "I have bought {opp} a watch. Second hand, like their serve.",
              "rep": -8,
              "h": "STAR GIFTS RIVAL WATCH IN SERVE JIBE"
            },
            {
              "t": "I lost count at twenty and started my tax return.",
              "rep": 0,
              "h": "STAR FILES TAX RETURN MID MATCH"
            }
          ]
        },
        {
          "q": "The match ran an hour over because of {opp}. Was that frustrating?",
          "a": [
            {
              "t": "Not at all. More tennis for the people who paid.",
              "rep": 7,
              "h": "STAR HAILS EXTRA TENNIS FOR FANS"
            },
            {
              "t": "{opp} plays like they are paid by the hour.",
              "rep": -9,
              "h": "STAR ACCUSES RIVAL OF HOURLY TENNIS"
            },
            {
              "t": "I missed my bus and two birthdays.",
              "rep": -1,
              "h": "STAR MISSES BUS AND TWO BIRTHDAYS"
            }
          ]
        }
      ],
      "tooSlow": [
        {
          "q": "You pulled the handshake away again. Should {opp} start practising?",
          "a": [
            {
              "t": "I will stop. {opp} deserves a proper handshake and an apology.",
              "rep": 8,
              "h": "STAR ENDS HANDSHAKE PRANK, SAYS SORRY"
            },
            {
              "t": "They should. I have reflexes and they have hope.",
              "rep": -9,
              "h": "REFLEXES V HOPE: STAR MOCKS RIVAL"
            },
            {
              "t": "I was only keeping my hand warm. It is October.",
              "rep": -2,
              "h": "STAR CITES COLD HANDS IN NET ROW"
            }
          ]
        }
      ],
      "snubbed": [
        {
          "q": "{opp} refused to shake your hand. Will you be taking it further?",
          "a": [
            {
              "t": "No. They were upset, and I know that feeling well.",
              "rep": 8,
              "h": "SNUBBED STAR SHOWS UNDERSTANDING"
            },
            {
              "t": "I will be sending them a glove. Unwashed.",
              "rep": -8,
              "h": "UNWASHED GLOVE THREAT IN HANDSHAKE ROW"
            },
            {
              "t": "My hand is still out there. Waiting.",
              "rep": -1,
              "h": "STAR HAND STILL WAITING AT NET"
            }
          ]
        },
        {
          "q": "{opp} left you standing at the net. What did you do with your hand?",
          "a": [
            {
              "t": "I waved to the crowd. They waved back. It was lovely.",
              "rep": 7,
              "h": "CROWD RESCUES SNUBBED STAR WITH WAVE"
            },
            {
              "t": "Made a gesture. A small one. The cameras missed most of it.",
              "rep": -10,
              "fine": 1,
              "h": "NET GESTURE COSTS SNUBBED STAR"
            },
            {
              "t": "Checked for rain. It was not raining.",
              "rep": 0,
              "h": "SNUBBED STAR CHECKS FOR RAIN"
            }
          ]
        }
      ]
    }
  };
  PRESS.generic.push(...PRESS_BATCH2.generic);
  Object.keys(PRESS_BATCH2.alt).forEach((k) => { PRESS_ALT[k] = (PRESS_ALT[k] || []).concat(PRESS_BATCH2.alt[k]); });
  function pickUnseen(list, bucket, textOf) {
    if (!list || !list.length) return undefined;
    if (list.length === 1) return list[0];
    const seen = (SAVE.seen = SAVE.seen || {});
    const ids = (seen[bucket] = seen[bucket] || []);
    const idOf = (x) => fnv1a(String(textOf ? textOf(x) : x)).toString(36);
    let fresh = list.filter((x) => ids.indexOf(idOf(x)) < 0);
    if (!fresh.length) {
      // All seen: start again, but not with the most recent one
      const lastId = ids[ids.length - 1];
      ids.length = 0;
      fresh = list.filter((x) => idOf(x) !== lastId);
    }
    const v = fresh[Math.floor(Math.random() * fresh.length)];
    ids.push(idOf(v));
    if (ids.length > 400) ids.splice(0, ids.length - 400);
    return v;
  }
  const pressQ = (key) => pickUnseen([PRESS[key]].concat(PRESS_ALT[key] || []).filter(Boolean), 'press:' + key, (x) => x.q);
  // Roasts from your own numbers. Three tones for the question, by reputation: polite, pointed, brutal.
  const ROASTS = [
    { n: (r) => (r.stats && r.stats.doubleFaults) || 0, min: 3,
      q: ['{N} double faults today. Is the net a friend of the family?', '{N} double faults. Is the service box a myth where you come from?', '{N} double faults. The ball kids have started a sweepstake. Comment?'],
      a: [{ t: 'Guilty. I will be serving in my dreams tonight.', rep: 6, h: 'SORRY STAR SERVES UP APOLOGY' },
        { t: 'The net moved. I have photographs.', rep: -8, h: 'STAR CLAIMS NET MOVED: {N} DOUBLE FAULTS' },
        { t: 'I was keeping it interesting.', rep: -2, h: '{N} DOUBLE FAULTS "FOR ENTERTAINMENT"' }] },
    { n: (r) => (r.stats && r.stats.errors) || 0, min: 10,
      q: ['{N} unforced errors. A tricky day at the office?', '{N} unforced errors. Were any of them forced? Even one?', '{N} unforced errors. Did you want to win, out of interest?'],
      a: [{ t: 'My worst day. I will be back in the practice court at dawn.', rep: 6, h: 'STAR VOWS DAWN PRACTICE AFTER ERROR FEST' },
        { t: 'The balls were faulty. All of them.', rep: -8, h: 'STAR BLAMES EVERY SINGLE BALL' },
        { t: 'I was testing the lines. They are all there.', rep: -2, h: '{N} ERRORS: STAR "INSPECTING THE LINES"' }] },
    { n: (r) => r.smashed || 0, min: 2,
      q: ['{N} rackets broken today. Is there a bulk discount?', '{N} rackets. Your sponsor has asked us to ask: why?', '{N} rackets. At what point does this become a hobby?'],
      a: [{ t: 'I will pay for every one of them. Personally. Slowly.', rep: 7, h: 'STAR TO PAY FOR WRECKED RACKETS' },
        { t: 'They knew what they did.', rep: -9, h: 'RACKETS "KNEW WHAT THEY DID", SAYS STAR' },
        { t: 'Recycling. I care about the planet.', rep: -2, h: '{N} RACKETS SMASHED IN THE NAME OF RECYCLING' }] },
    { n: (r) => r.violations || 0, min: 2,
      q: ['{N} code violations today. Is the umpire on your Christmas card list?', '{N} code violations and {F} in fines. Worth it?', '{N} code violations. Do you know the rules, or just the umpire?'],
      a: [{ t: 'I owe the umpire an apology and a biscuit.', rep: 7, h: 'STAR OFFERS UMPIRE A BISCUIT' },
        { t: 'Worth every penny.', rep: -10, h: '{F} IN FINES "WORTH EVERY PENNY"' },
        { t: 'I was helping them practise their announcements.', rep: -2, h: 'STAR GIVES UMPIRE "VOICE PRACTICE"' }] },
    { n: (r) => (r.stats && r.stats.meltdowns) || 0, min: 2,
      q: ['You had {N} meltdowns out there. Are you all right?', '{N} meltdowns. Should someone check on the racket bag?', '{N} meltdowns in one match. Is that a personal best?'],
      a: [{ t: 'I am working on it. Breathing, mostly.', rep: 7, h: 'STAR VOWS TO BREATHE MORE' },
        { t: 'Passion. You would not understand.', rep: -8, h: 'MELTDOWNS ARE "PASSION", STAR INSISTS' },
        { t: 'Two? I counted three.', rep: -2, h: 'STAR LOSES COUNT OF OWN MELTDOWNS' }] },
    { n: (r) => (r.stats && r.stats.shots >= 20 && perfectPct(r.stats) < 15 ? 100 - perfectPct(r.stats) : 0), min: 1,
      pct: true,
      q: ['Only {P}% of your hits were clean today. Where were you aiming?', '{P}% perfect contact. Did you bring your own racket?', '{P}% clean hits. Have you considered a bigger racket? Or a smaller ball?'],
      a: [{ t: 'Rusty. I will sort it out.', rep: 5, h: 'RUSTY STAR TO SORT IT OUT' },
        { t: 'The sweet spot moved.', rep: -7, h: 'SWEET SPOT "MOVED", CLAIMS STAR' },
        { t: 'I hit them where I meant to. Mostly the frame.', rep: -2, h: 'STAR AIMED FOR THE FRAME, ON PURPOSE' }] }
  ];
  // The worst of your numbers, as a question: none if nothing is bad enough to mention
  function roastQ(r) {
    const hits = ROASTS.map((x) => ({ x: x, n: x.n(r) })).filter((o) => o.n >= o.x.min).sort((p, q) => q.n / q.x.min - p.n / p.x.min);
    if (!hits.length) return null;
    const o = hits[0];
    const rep = SAVE.reputationScore;
    const tone = rep >= 20 ? 0 : rep <= -20 ? 2 : 1;
    const word = (n) => { const w = NUMBER_WORDS[n]; return w || String(n); };
    const P = r.stats && r.stats.shots ? perfectPct(r.stats) : 0;
    const fillR = (t, cap) => t.replace(/\{N\}/g, (cap ? word(o.n).toUpperCase() : word(o.n))).replace(/\{F\}/g, money(r.fines || 0)).replace(/\{P\}/g, String(P));
    return { q: fillR(o.x.q[tone]), a: o.x.a.map((ans) => ({ t: fillR(ans.t), rep: ans.rep, h: fillR(ans.h, true) })) };
  }
  // Each test reads the match result; the press picks one that fits, when one does
  const PRESS_REACT = [
    { when: (r) => r.oppLost > 0, q: '{opp} lost their temper out there. Did you enjoy that?', a: [
      { t: 'Not at all. I know how it feels. I sent flowers.', rep: 10, h: 'STAR SENDS FLOWERS TO MELTED RIVAL' },
      { t: 'Every second. I may have it framed.', rep: -11, h: 'GLOATING STAR TO FRAME RIVAL MELTDOWN' },
      { t: 'I did not notice. I was busy being calm.', rep: -2, h: 'STAR CLAIMS TO HAVE MISSED THE WHOLE THING' }] },
    { when: (r) => r.games && r.games[1] === 0, q: 'You did not drop a single game. Was that kind?', a: [
      { t: 'I wanted to give them games. My racket would not allow it.', rep: 5, h: 'RACKET BLAMED FOR WHITEWASH' },
      { t: 'Kindness is for the warm up.', rep: -9, h: 'NO MERCY: STAR DELIVERS BAGEL' },
      { t: 'They got a lot of exercise.', rep: -2, h: 'WHITEWASH DESCRIBED AS FITNESS SESSION' }] },
    { when: (r) => r.games && r.games[0] - r.games[1] <= 1, q: 'That was tight. Were you nervous at any point?', a: [
      { t: 'Terrified. Fair play to {opp}, they were brilliant.', rep: 10, h: 'HUMBLE STAR ADMITS TERROR' },
      { t: 'Nervous? I was toying with them.', rep: -8, h: 'STAR CLAIMS NAILBITER WAS ALL A BIT' },
      { t: 'Only when I looked at the score.', rep: -1, h: 'STAR AVOIDED SCOREBOARD FOR HEALTH REASONS' }] },
    { when: (r) => r.stats && r.stats.aces >= 4, q: '{a} aces today. Is the serve the secret?', a: [
      { t: 'The secret is practice. And a very patient coach.', rep: 7, h: 'ACE STAR CREDITS PATIENT COACH' },
      { t: 'The secret is that they cannot return it.', rep: -7, h: 'ACE STAR MOCKS RETURN GAME' },
      { t: 'I am mostly aiming at the umpire.', rep: -4, h: 'UMPIRE UNDER FIRE IN SERVE SHOCK' }] },
    { when: (r) => r.cfg.surface === 'clay', q: 'How did you find the clay?', a: [
      { t: 'Beautiful. Slow, honest, and very orange.', rep: 6, h: 'STAR FALLS FOR CLAY' },
      { t: 'All over my socks.', rep: -2, h: 'SOCK CRISIS AT TUNBRIDGE' },
      { t: 'Too slow. Like this press conference.', rep: -9, h: 'STAR SAYS CLAY AND REPORTERS BOTH TOO SLOW' }] },
    { when: (r) => r.cfg.surface === 'grass', q: 'Grass is famously tricky. How did you manage it?', a: [
      { t: 'I treated it with respect. And a little fear.', rep: 7, h: 'STAR RESPECTS THE GRASS' },
      { t: 'I told it who was in charge.', rep: -7, h: 'STAR THREATENS LAWN' },
      { t: 'I did not eat any, which is progress.', rep: -1, h: 'STAR REPORTS NO GRASS EATEN' }] },
    { when: (r) => r.cfg.surface === 'indoor', q: 'Does playing indoors suit your temper?', a: [
      { t: 'No wind, no excuses. I like that.', rep: 7, h: 'STAR WELCOMES LIFE WITHOUT EXCUSES' },
      { t: 'There is nowhere for the rackets to land. That is a design flaw.', rep: -9, h: 'STAR CRITICISES ROOF FOR LIMITING THROWS' },
      { t: 'It smells of chips. I can work with chips.', rep: -1, h: 'CHIPS SMELL EMBRACED BY STAR' }] },
    { when: (r) => r.repNow <= -40, q: 'The crowd booed your walk-on. How do you explain that?', a: [
      { t: 'I have work to do. I intend to do it.', rep: 9, h: 'VILLAIN VOWS TO CHANGE' },
      { t: 'They boo because they care.', rep: -6, h: 'STAR READS BOOS AS LOVE' },
      { t: 'I thought it was a very long "ooh".', rep: -2, h: 'STAR MISHEARS AGAIN' }] },
    { when: (r) => r.repNow >= 40, q: 'You are the crowd\'s favourite now. Does that put pressure on you?', a: [
      { t: 'Only the nice kind. Thank you, all of you.', rep: 8, h: 'DARLING OF THE CROWD SAYS THANK YOU' },
      { t: 'They will turn. They always turn.', rep: -6, h: 'STAR PREDICTS CROWD BETRAYAL' },
      { t: 'I am trying not to let it go to my head. It is going to my head.', rep: 1, h: 'IT IS GOING TO HIS HEAD, CONFIRMS STAR' }] },
    { when: (r) => SAVE.totalFines >= 20 * TIERS[r.cfg.tierIdx].fine, q: 'Your fines now total {fines}. Are you sponsored by the federation?', a: [
      { t: 'I see it as a donation to the sport.', rep: 4, h: 'STAR CALLS FINES A DONATION' },
      { t: 'I would like a loyalty card.', rep: -7, h: 'STAR DEMANDS FINE LOYALTY SCHEME' },
      { t: 'My accountant is in therapy.', rep: -1, h: 'ACCOUNTANT TAKES TIME OFF' }] },
    { when: (r) => r.rackets <= 1, q: 'You are down to {r} racket{rs}. Are you worried?', a: [
      { t: 'Worried enough to be careful with it.', rep: 7, h: 'LAST RACKET PLACED UNDER PROTECTION' },
      { t: 'The racket should be worried.', rep: -9, h: 'LAST RACKET ISSUED WARNING' },
      { t: 'I can always play with my hand.', rep: -3, h: 'STAR CONSIDERS PLAYING BAREHANDED' }] },
    { when: (r) => (SAVE.season || 1) > 1, q: 'Season {season} of the Grudge Tour. Does it get easier?', a: [
      { t: 'It gets harder, and I am grateful for every match.', rep: 8, h: 'GRATEFUL STAR EMBRACES THE GRIND' },
      { t: 'For me, yes. For them, no.', rep: -8, h: 'SEASONED STAR SAYS OTHERS STILL STRUGGLING' },
      { t: 'I have stopped counting. So has my physio.', rep: -1, h: 'PHYSIO STOPS COUNTING' }] }
  ];
  PRESS.generic.push(
    {
      q: 'What is in the bag, apart from rackets?',
      a: [
        { t: 'A banana, a towel and a letter from my mother.', rep: 7, h: 'STAR CARRIES LETTER FROM MOTHER' },
        { t: 'Spare rackets for the spare rackets.', rep: -6, h: 'STAR PLANS AHEAD FOR DESTRUCTION' },
        { t: 'Evidence.', rep: -3, h: 'STAR BAG CONTENTS UNDER INVESTIGATION' }
      ]
    },
    {
      q: 'Do you have a pre-match ritual?',
      a: [
        { t: 'I shake hands with the net. It deserves respect.', rep: 6, h: 'STAR SHAKES HANDS WITH NET' },
        { t: 'I look at my opponent until they look away.', rep: -8, h: 'STARING CONTEST BEFORE EVERY MATCH' },
        { t: 'I count my rackets. Then I count them again later.', rep: -2, h: 'STAR TAKES RACKET REGISTER' }
      ]
    }
  );
  PRESS.generic.push(
    {
      q: 'Your coach left at four games all. Is everything all right between you?',
      a: [
        { t: 'They had a train to catch. I respect punctuality.', rep: 6, h: 'STAR DEFENDS COACH, AND THE TRAINS' },
        { t: 'They could not handle the greatness.', rep: -8, h: 'COACH FLEES GREATNESS, CLAIMS STAR' },
        { t: 'I do not have a coach. That was a fan in a tracksuit.', rep: -1, h: 'TRACKSUIT MAN IDENTIFIED AS FAN' }
      ]
    },
    {
      q: 'What do you say to the people who booed you today?',
      a: [
        { t: 'Thank you for coming. Tickets are not cheap.', rep: 10, h: 'GRACIOUS STAR THANKS BOOING FANS' },
        { t: 'I could hear you. I have written your seats down.', rep: -12, h: 'STAR KEEPS LIST OF SEAT NUMBERS' },
        { t: 'Was that booing? I thought it was a very long "ooh".', rep: -1, h: 'STAR MISTAKES BOOS FOR ADMIRATION' }
      ]
    },
    {
      q: 'You spent the changeover talking to your racket. What was said?',
      a: [
        { t: 'Encouragement. It is going through a lot.', rep: 7, h: 'STAR OFFERS RACKET EMOTIONAL SUPPORT' },
        { t: 'A final warning.', rep: -9, h: 'RACKET GIVEN FINAL WARNING' },
        { t: 'It did most of the listening.', rep: -2, h: 'RACKET SILENT ON CHANGEOVER TALKS' }
      ]
    },
    {
      q: 'If you were not a tennis player, what would you be?',
      a: [
        { t: 'A teacher. Patience is my gift.', rep: 6, h: 'STAR CLAIMS PATIENCE, WITNESSES DISAGREE' },
        { t: 'Banned from most sports, probably.', rep: -6, h: 'STAR PREDICTS BANS ACROSS ALL SPORT' },
        { t: 'A racket. I would like to see how they like it.', rep: -3, h: 'STAR WANTS TO BECOME RACKET, FOR REVENGE' }
      ]
    }
  );

  /* Locker Room catalogue. Everything is cosmetic: nothing here changes how you play.
     Prices are in prize money. Free items are owned from the start. */
  // Your player's look: the same palettes and hair styles the opponents and the crowd are drawn with
  const PLAYER_LOOK = {
    skins: ['#f3d2b8', '#eac2a2', '#e7b892', '#d9a27c', '#c58c64', '#a8714f', '#8d5a3b', '#6b4430'],
    hairs: ['#141414', '#3a2716', '#7a4a28', '#c0462a', '#d9b25c', '#f0dc9a', '#9a9a9a', '#e8e0d0'],
    styles: [['short', 'Short'], ['buzz', 'Buzz cut'], ['curly', 'Curly'], ['side', 'Side parting'], ['floppy', 'Floppy'], ['long', 'Long'], ['ponytail', 'Ponytail'], ['bob', 'Bob'], ['bun', 'Bun'], ['bald', 'Bald']]
  };
  const LOCKER_CATS = [['you', 'You'], ['shirt', 'Shirts'], ['shorts', 'Shorts'], ['band', 'Bands'], ['shoes', 'Shoes'], ['racket', 'Rackets'], ['tantrum', 'Tantrums'], ['celeb', 'Celebrations']];
  const LOCKER = {
    shirt: [
      { id: 'shirt_sponsor', name: 'Sponsor Kit', price: 0, desc: 'Follows your reputation. They pay you to wear it, so wear it.' },
      { id: 'shirt_white', name: 'Club Whites', price: 150, color: '#f4f1e6', color2: '#1f3a6b', design: 'polo', text: '#1f3a6b', desc: 'A proper collared polo. Old members nod at you approvingly.' },
      { id: 'shirt_green', name: 'Racing Green', price: 600, color: '#1f5a3a', color2: '#d9f24a', design: 'stripes', text: '#d9f24a', desc: 'Twin racing stripes. Looks fast. Is not fast.' },
      { id: 'shirt_pinstripe', name: 'Bank Holiday', price: 900, color: '#f4f1e6', color2: '#3b5ba5', design: 'pinstripe', text: '#1f3a6b', desc: 'Pinstripes, for the banker who has had enough.' },
      { id: 'shirt_orange', name: 'Tangerine', price: 1500, color: '#ff7a1a', color2: '#1a1a1a', design: 'chevron', text: '#1a1a1a', desc: 'A big black chevron. Visible from space and from the cheap seats.' },
      { id: 'shirt_hoops', name: 'Rugby Hoops', price: 2000, color: '#1f5a3a', color2: '#f4f1e6', design: 'hoops', text: '#d9f24a', desc: 'Hooped like a prop forward. Tackles not permitted.' },
      { id: 'shirt_polka', name: 'Polka Party', price: 3500, color: '#ff7aa8', color2: '#fff4f8', design: 'dots', text: '#3d1f4f', desc: 'Spotty. Cheerful. Deeply unsettling to opponents.' },
      { id: 'shirt_navy', name: 'Midnight Navy', price: 4000, color: '#14233f', color2: '#c8102e', design: 'sash', text: '#f4f1e6', desc: 'A red sash across the chest. Serious. Brooding. Hides sweat and shame.' },
      { id: 'shirt_hawaii', name: 'Holiday Mode', price: 7000, color: '#2a9d8f', color2: '#ffd166', color3: '#1d6b4f', design: 'hawaiian', text: '#1a1a1a', desc: 'Flowers, leaves and a total lack of focus.' },
      { id: 'shirt_pink', name: 'Hot Pink Fury', price: 12000, color: '#ff3d8b', color2: '#1a1a1a', design: 'bolt', text: '#1a1a1a', desc: 'A lightning bolt for when your temper needs a matching outfit.' },
      { id: 'shirt_retro', name: 'Retro 1978', price: 18000, color: '#efe4c8', color2: '#c1440e', color3: '#e09f3e', color4: '#7a4b2a', design: 'retro', text: '#7a4b2a', desc: 'Chest stripes from the year of the wooden racket.' },
      { id: 'shirt_camo', name: 'Camouflage', price: 25000, color: '#5b6b3a', color2: '#3b4526', color3: '#8f9560', design: 'camo', text: '#e9e4c8', desc: 'So the umpire cannot see you. They can.' },
      { id: 'shirt_tiedye', name: 'Tie Dye', price: 45000, color: '#ff5d73', color2: '#ffd166', color3: '#06d6a0', color4: '#4d7cfe', design: 'tiedye', text: '#1a1a1a', desc: 'Hand dyed at a festival you do not remember.' },
      { id: 'shirt_gold', name: 'Gold Lame', price: 90000, color: '#d4af37', color2: '#fff2b0', design: 'sequins', text: '#3d1f4f', desc: 'Sequinned. Says you have arrived. Also says you have no taste.' },
      { id: 'shirt_supporter', name: 'Supporter Kit', price: 0, pack: 'pro_pack', color: '#10261a', color2: '#e8c66a', design: 'sash', text: '#e8c66a', desc: 'Black and gold, with a sash. Only for people who backed the game.' },
      { id: 'shirt_diamond', name: 'Diamond Kit', price: 400000, color: '#cfeeff', color2: '#ffffff', design: 'sequins', text: '#1f3a6b', desc: 'Set with stones the jeweller swears are real. Sparkles under floodlights. So do your fines.' }
    ],
    shorts: [
      { id: 'shorts_sponsor', name: 'Sponsor Shorts', price: 0, desc: 'Comes with the contract.' },
      { id: 'shorts_white', name: 'Tennis Whites', price: 100, color: '#f4f4f4', desc: 'Brave on a clay court.' },
      { id: 'shorts_brown', name: 'Corduroy Brown', price: 800, color: '#6b4a2a', color2: '#4f3620', design: 'cord', desc: 'Proper corduroy. Your grandad played in these. He also smashed rackets.' },
      { id: 'shorts_blue', name: 'Electric Blue', price: 3000, color: '#1f6fff', color2: '#f4f4f4', design: 'stripe', desc: 'White go faster stripes down each side. Shorts are not fast.' },
      { id: 'shorts_camo', name: 'Camo Shorts', price: 6000, color: '#5b6b3a', color2: '#3b4526', color3: '#8f9560', design: 'camo', desc: 'For hiding in the long grass of Court 2.' },
      { id: 'shorts_red', name: 'Highland Red', price: 20000, color: '#a31f2b', color2: '#1a2a4a', color3: '#f2c14e', design: 'tartan', desc: 'Tartan. Matches your face at 100% rage.' },
      { id: 'shorts_gold', name: 'Gold Shorts', price: 250000, color: '#d4af37', color2: '#fff2b0', design: 'stripe', desc: 'Spun gold. They do not breathe. Neither will you.' }
    ],
    band: [
      { id: 'band_sponsor', name: 'Sponsor Band', price: 0, desc: 'Absorbs sweat, not criticism.' },
      { id: 'band_lime', name: 'Lime', price: 80, color: '#d9f24a', desc: 'Ball coloured, so you can find your head.' },
      { id: 'band_purple', name: 'Royal Purple', price: 500, color: '#6b3fa0', desc: 'Regal. Not royal. Please stop telling people it is royal.' },
      { id: 'band_black', name: 'Villain Black', price: 1200, color: '#111111', desc: 'The headband of someone the crowd will boo.' },
      { id: 'band_gold', name: 'Gold', price: 25000, color: '#d4af37', desc: 'A crown for people who have not won anything.' },
      { id: 'band_diamond', name: 'Diamond Band', price: 150000, color: '#cfeeff', desc: 'A crown for people who have won everything, and want you to know.' }
    ],
    shoes: [
      { id: 'shoes_white', name: 'Court Classic', price: 0, color: '#f6f6f2', sole: '#ffffff', accent: '#1f3a6b', desc: 'White leather, navy flash. They squeak. That is the point.' },
      { id: 'shoes_clay', name: 'Clay Specialist', price: 300, color: '#ece6da', sole: '#d2693c', accent: '#d2693c', desc: 'Herringbone soles, pre stained, so nobody can tell.' },
      { id: 'shoes_gum', name: 'Retro Gum', price: 1200, color: '#f1ead8', sole: '#b5793d', accent: '#1f5a3a', desc: 'Suede uppers, gum soles, a green flash. Very 1978.' },
      { id: 'shoes_black', name: 'Black Ops', price: 2500, color: '#1e1e1e', sole: '#2c2c2c', accent: '#6a6a6a', desc: 'Black on black. Silent. They still squeak.' },
      { id: 'shoes_neon', name: 'Neon Volt', price: 8000, color: '#e6ff3a', sole: '#f4f4f4', accent: '#1a1a1a', desc: 'The umpire will see you coming.' },
      { id: 'shoes_gold', name: 'Gold Trainers', price: 60000, color: '#d4af37', sole: '#f4f4f4', accent: '#fff2b0', desc: 'Stamping on a racket has never looked so expensive.' },
      { id: 'shoes_diamond', name: 'Diamond Trainers', price: 500000, color: '#e8f8ff', sole: '#cfeeff', accent: '#7fd8ff', desc: 'Made to order in a vault. The squeak is a perfect C.' }
    ],
    racket: [
      { id: 'racket_yellow', name: 'Ball Yellow', price: 0, color: '#d9f24a', desc: 'Standard issue. Five of them. For now.' },
      { id: 'racket_black', name: 'Graphite Black', price: 400, color: '#2a2a2a', desc: 'Stealthy. Breaks just the same.' },
      { id: 'racket_red', name: 'Fire Red', price: 2000, color: '#e8352b', desc: 'Pre angered.' },
      { id: 'racket_ice', name: 'Ice Blue', price: 6000, color: '#7fd8ff', desc: 'Cool, calm, collected. Unlike you.' },
      { id: 'racket_chrome', name: 'Chrome', price: 40000, color: '#c9d1d9', desc: 'Shatters into very shiny pieces.' },
      { id: 'racket_wood', name: 'Wooden Classic', price: 150000, color: '#a0662f', desc: 'Hand made in 1974. Smashes beautifully.' },
      { id: 'racket_supporter', name: 'Supporter\'s Racket', price: 0, pack: 'pro_pack', color: '#e8c66a', desc: 'Champagne gold. It breaks like any other, but more expensively.' },
      { id: 'racket_gold', name: 'Solid Gold', price: 1500000, color: '#d4af37', desc: 'Solid gold. Too heavy to play with. Exactly heavy enough to throw.' }
    ],
    tantrum: [
      { id: 'tantrum_spike', style: 'spike', name: 'Spiked', price: 0, desc: 'The classic. Head first into the baseline.' },
      { id: 'tantrum_knee', style: 'knee', name: 'Snapped', price: 0, desc: 'Over the knee like a breadstick. Knee not included.' },
      { id: 'tantrum_strings', style: 'strings', name: 'Strung Out', price: 0, desc: 'Three stomps. Every string goes.' },
      { id: 'tantrum_taco', style: 'taco', name: 'Tacoed', price: 5000, desc: 'Folded in half, followed by a shrug.' },
      { id: 'tantrum_bin', style: 'bin', name: 'Binned', price: 12000, desc: 'Marched to the courtside bin and posted in head first. General waste.' },
      { id: 'tantrum_hoof', style: 'hoof', name: 'Hoofed', price: 20000, desc: 'Dropped, then drop kicked into the stand. Somebody shouts GOAL.' },
      { id: 'tantrum_heli', style: 'heli', name: 'Launched', price: 30000, desc: 'A hammer throw into row M. Row M is delighted.' },
      { id: 'tantrum_post', style: 'post', name: 'Shattered', price: 75000, desc: 'A run up and a full forehand into the advertising.' },
      { id: 'tantrum_chew', style: 'chew', name: 'Chewed', price: 0, pack: 'pack_bad_loser', desc: 'Gnawed like a dog with a bone until the frame gives in. Tastes of graphite.' },
      { id: 'tantrum_bounce', style: 'bounce', name: 'Bounced', price: 0, pack: 'pack_bad_loser', desc: 'Hurled at the court so hard it bounces back and lands on your head.' },
      { id: 'tantrum_fore', style: 'fore', name: 'Fore!', price: 0, pack: 'pack_bad_loser', desc: 'A full golf swing into the court. The divot is still being replaced.' },
      { id: 'tantrum_drums', style: 'drums', name: 'Drum Solo', price: 350000, desc: 'Three beats on the baseline and a cymbal crash that ends the racket. The crowd claps along.' },
      { id: 'tantrum_gift', style: 'gift', name: 'Signed and Thrown', price: 1000000, desc: 'Signed, kissed and lobbed into the crowd. Technically a gift. Still a code violation.' }
    ],
    // Celebrations play after aces and winners. Each one lowers your rage by calm.
    celeb: [
      { id: 'celeb_comeon', style: 'comeon', name: 'Come On!', price: 0, calm: 0.06, desc: 'A clenched fist and a roar. Cheap, classic, effective. Calms you 6%.' },
      { id: 'celeb_plane', style: 'plane', name: 'The Aeroplane', price: 600, calm: 0.08, desc: 'Arms out, one lap of the baseline. Cabin crew, prepare for gloating. Calms you 8%.' },
      { id: 'celeb_guitar', style: 'guitar', name: 'Air Racket', price: 2500, calm: 0.09, desc: 'A face melting solo on a racket. Calms you 9%.' },
      { id: 'celeb_shush', style: 'shush', name: 'The Shush', price: 5000, calm: 0.1, desc: 'A finger to the lips for the crowd. Calms you 10%. Costs you reputation every time.' },
      { id: 'celeb_robot', style: 'robot', name: 'The Robot', price: 15000, calm: 0.11, desc: 'Cold, mechanical, emotionless. What your coach asked for, in the wrong way. Calms you 11%.' },
      { id: 'celeb_slide', style: 'slide', name: 'Knee Slide', price: 30000, calm: 0.12, desc: 'Ten metres on your knees. The groundsman weeps. Calms you 12%.' },
      { id: 'celeb_worm', style: 'worm', name: 'The Worm', price: 60000, calm: 0.14, desc: 'Face first and fully committed. Calms you 14%.' },
      { id: 'celeb_flip', style: 'backflip', name: 'Backflip', price: 120000, calm: 0.15, desc: 'Nobody knew you could do this. Including you. Calms you 15%.' },
      { id: 'celeb_champagne', style: 'champagne', name: 'Champagne Shower', price: 250000, calm: 0.15, desc: 'Shaken, popped and sprayed over the front row. They have asked for their dry cleaning money. Calms you 15%.' },
      { id: 'celeb_trophy', style: 'trophy', name: 'The Trophy Lift', price: 700000, calm: 0.15, desc: 'A gold cup, held aloft, then kissed. You brought it from home. Calms you 15%.' },
      { id: 'celeb_bow', style: 'bow', name: 'Theatre Bow', price: 0, pack: 'pack_show_off', calm: 0.12, desc: 'A sweeping bow to all four stands, and roses from nowhere. Calms you 12%.' },
      { id: 'celeb_mic', style: 'mic', name: 'Mic Drop', price: 0, pack: 'pack_show_off', calm: 0.12, desc: 'A microphone from your pocket, one line, and a drop. Calms you 12%.' },
      { id: 'celeb_selfie', style: 'selfie', name: 'The Selfie', price: 0, pack: 'pack_show_off', calm: 0.12, desc: 'Peace sign, pout, flash. The point is now content. Calms you 12%.' },
      { id: 'celeb_fireworks', style: 'fireworks', name: 'Fireworks', price: 2000000, calm: 0.16, desc: 'One raised racket and the sky goes off. The neighbours have complained. Calms you 16%.' }
    ]
  };
  const LOCKER_INDEX = {};
  Object.keys(LOCKER).forEach((cat) => LOCKER[cat].forEach((it) => { it.cat = cat; LOCKER_INDEX[it.id] = it; }));
  const FREE_ITEMS = Object.keys(LOCKER_INDEX).filter((id) => LOCKER_INDEX[id].price === 0 && !LOCKER_INDEX[id].pack);

  const TROPHIES = {
    t0: 'The Puddleby Plate', t1: 'The County Tankard', t2: 'The Grimsby Cod', t3: 'The Tunbridge Salver', t4: 'The Wimbleford Cup',
    royalBox: 'The Royal Box Incident',
    cleanBag: 'The Clean Bag', hothead: 'Hothead Award', ace150: 'The 150 Club', villain: 'Pantomime Villain', darling: 'Nation\'s Darling', devotee: 'Daily Devotee',
    allTantrums: 'Full Repertoire', allCelebs: 'Showboat', allIncidents: 'Banned Everywhere', celeb50: 'Fifty Not Out', rattled: 'Head Games'
  };

  /* =====================================================================
     3. Save data
     ===================================================================== */
  const SAVE_KEY = 'racketRageTennis.v1';
  function defaultSave() {
    return {
      careerTier: 0,
      totalFines: 0,
      reputationScore: 0,
      remainingRackets: 5,
      dailyStreak: 0,
      lastPlayedDate: null,
      unlockedTrophies: [],
      tournamentRound: 0,
      prizeMoney: 0,
      tournamentSmashed: 0,
      tournamentFines: 0,
      careerComplete: false,
      tutorialDone: false,
      lessonPaid: false,   // Derek's £500 for kit, paid once, whenever you first finish the lesson
      lastDaily: null,
      tips: {},
      rivals: {},   // head to head by opponent name: { w, l, smashed, lostIt, last }
      hints: {},   // how many points each teaching hint has appeared in
      incidentsSeen: [],
      dailyLog: [],
      stats: { matchesWon: 0, matchesLost: 0, racketsSmashed: 0, aces: 0, codeViolations: 0, badCalls: 0, meltdownsSurvived: 0, fastestServe: 0, celebrations: 0 },
      settings: { muted: false, music: true, vibration: true, timing: 'auto', aim: 'normal', short: true, text: 'normal', footwork: 'auto', gentle: false, reminders: true },
      // Your player: body (f or m), skin, hair colour and style, and shorts or a skirt. made: chosen at least once.
      player: { made: false, name: '', first: '', last: '', body: 'm', skin: '#e7b892', hair: '#3a2716', style: 'short', bottom: 'shorts' },
      locker: { owned: FREE_ITEMS.slice(), equip: { shirt: 'shirt_sponsor', shorts: 'shorts_sponsor', band: 'band_sponsor', shoes: 'shoes_white', racket: 'racket_yellow', celeb: 'celeb_comeon' } }
    };
  }
  function loadSave() {
    const base = defaultSave();
    try {
      const raw = window.RRCG ? RRCG.getItem(SAVE_KEY) : localStorage.getItem(SAVE_KEY);
      if (!raw) return base;
      const data = JSON.parse(raw);
      const out = Object.assign(base, data);
      out.stats = Object.assign(defaultSave().stats, data.stats || {});
      out.settings = Object.assign(defaultSave().settings, data.settings || {});
      out.player = Object.assign(defaultSave().player, data.player || {});
      const dl = defaultSave().locker;
      out.locker = { owned: Array.isArray(data.locker && data.locker.owned) ? data.locker.owned.slice() : dl.owned, equip: Object.assign(dl.equip, (data.locker && data.locker.equip) || {}) };
      FREE_ITEMS.forEach((id) => { if (out.locker.owned.indexOf(id) < 0) out.locker.owned.push(id); });
      if (typeof out.prizeMoney !== 'number' || !isFinite(out.prizeMoney)) out.prizeMoney = 0;
      // Players who already have matches under their belt skip the lesson
      if (data.tutorialDone === undefined) out.tutorialDone = !!(data.stats && (data.stats.matchesWon + data.stats.matchesLost) > 0);
      if (!Array.isArray(out.unlockedTrophies)) out.unlockedTrophies = [];
      if (!out.tips || typeof out.tips !== 'object') out.tips = {};
      if (!Array.isArray(out.incidentsSeen)) out.incidentsSeen = [];
      if (!Array.isArray(out.dailyLog)) out.dailyLog = [];
      out.careerTier = clamp(out.careerTier | 0, 0, TIERS.length - 1);
      out.tournamentRound = clamp(out.tournamentRound | 0, 0, 2);
      out.remainingRackets = clamp(out.remainingRackets | 0, 0, 5);
      return out;
    } catch (e) {
      return base;
    }
  }
  let SAVE = loadSave();
  function persist() {
    try {
      SAVE._at = Date.now();   // which copy is newer, if the SDK copy and this device's copy differ (cg.js)
      const json = JSON.stringify(SAVE);
      if (window.RRCG) RRCG.setItem(SAVE_KEY, json); else localStorage.setItem(SAVE_KEY, json);
    } catch (e) { /* storage full or blocked: play on */ }
  }
  // Collection trophies, checked whenever something is bought or happens
  function checkCollections() {
    const own = (cat) => LOCKER[cat].every((it) => it.pack || SAVE.locker.owned.indexOf(it.id) >= 0);
    if (own('tantrum')) unlock('allTantrums');
    if (own('celeb')) unlock('allCelebs');
    if (Object.keys(INCIDENTS).every((k) => SAVE.incidentsSeen.indexOf(k) >= 0)) unlock('allIncidents');
    if ((SAVE.stats.celebrations || 0) >= 50) unlock('celeb50');
  }
  function unlock(id) {
    if (!TROPHIES[id] || SAVE.unlockedTrophies.indexOf(id) >= 0) return false;
    SAVE.unlockedTrophies.push(id);
    // The matching achievement comes with it, without a second announcement
    SAVE.ach = SAVE.ach || {};
    ACHIEVEMENTS.forEach((a) => {
      if (a.trophy === id && !SAVE.ach[a.id]) {
        SAVE.ach[a.id] = dateKey();
        if (window.RRGames) RRGames.unlock(a.id);
      }
    });
    persist();
    award('trophy', TROPHIES[id], TROPHY_WHY[id] || '');
    return true;
  }

  /* =====================================================================
     4. Stage sizing and input
     ===================================================================== */
  const stage = $('#stage');
  const canvas = $('#game');
  const g = canvas.getContext('2d');
  let scale = 1;
  // Bleed: on screens wider than 16:9 the scene carries on past the sides of the 16:9 stage.
  // Logical x then runs from -BX to W + BX. Menus, HUD and anything you tap stay inside 0..W.
  let BX = 0;
  let BY = 0;
  // How far each HUD corner may move out from the 16:9 stage towards the screen edge (logical units),
  // stopping short of any notch or rounded corner
  const HUD = { l: 0, r: 0, t: 0, b: 0 };
  let bgCache = null;
  // Safe area insets in CSS px: the larger of the browser's env() values and what Android reports
  let safeProbe = null;
  function safeInsets() {
    if (!safeProbe) {
      safeProbe = document.createElement('div');
      safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(safeProbe);
    }
    const cs = getComputedStyle(safeProbe);
    const cut = window.__cutout || {};
    return {
      l: Math.max(parseFloat(cs.paddingLeft) || 0, cut.l || 0),
      r: Math.max(parseFloat(cs.paddingRight) || 0, cut.r || 0),
      t: Math.max(parseFloat(cs.paddingTop) || 0, cut.t || 0),
      b: Math.max(parseFloat(cs.paddingBottom) || 0, cut.b || 0)
    };
  }

  // Drawing resolution, chosen once at launch: 1.5x (measured on a phone: about 60 fps in a match, against 47 at 2x),
  // or 2x when saved in the settings. Never changed while running: on a phone, resizing the canvas mid-game made
  // every frame after it far slower until a restart.
  const RES = { cap: SAVE.settings && SAVE.settings.res === 2 ? 2 : 1.5 };
  let HUD_BTN = null;
  function hudButtonsBox() {
    if (HUD_BTN) return HUD_BTN;
    const el = $('#hudButtons');
    const r = el && !el.classList.contains('hidden') ? el.getBoundingClientRect() : null;
    if (!r || !r.width) return null;
    const a = toLogical({ clientX: r.left, clientY: r.top });
    const b = toLogical({ clientX: r.right, clientY: r.bottom });
    HUD_BTN = { x0: a.x, x1: b.x, y0: a.y, y1: b.y };
    return HUD_BTN;
  }
  function fit() {
    HUD_BTN = null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let w = vw;
    if (w * 9 / 16 > vh) w = vh * 16 / 9;
    w = Math.floor(w);
    const h = Math.floor(w * 9 / 16);
    // The 16:9 stage is centred; the scene bleeds past it to fill wider or taller screens
    const bleed = Math.max(0, Math.floor((vw - w) / 2));
    const bleedY = Math.max(0, Math.floor((vh - h) / 2));
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    stage.style.left = bleed + 'px';
    stage.style.top = bleedY + 'px';
    stage.style.fontSize = (w / 64) + 'px';
    stage.style.setProperty('--u', (w / 64) + 'px');
    STAGE_PX = w;
    stage.style.setProperty('--bleed', bleed + 'px');
    stage.style.setProperty('--bleed-y', bleedY + 'px');
    canvas.style.left = -bleed + 'px';
    canvas.style.top = -bleedY + 'px';
    canvas.style.width = (w + 2 * bleed) + 'px';
    canvas.style.height = (h + 2 * bleedY) + 'px';
    const k = W / w;
    BX = bleed * k;
    BY = bleedY * k;
    const safe = safeInsets();
    ['l', 'r', 't', 'b'].forEach((s) => stage.style.setProperty('--safe-' + s, safe[s] + 'px'));
    HUD.l = Math.max(0, BX - safe.l * k);
    HUD.r = Math.max(0, BX - safe.r * k);
    HUD.t = Math.max(0, BY - safe.t * k);
    HUD.b = Math.max(0, BY - safe.b * k);
    const dpr = Math.min(window.devicePixelRatio || 1, RES.cap);
    // Only touch the canvas when its size really changes: setting it resets the canvas, even to the same size
    const cw = Math.round((w + 2 * bleed) * dpr);
    const ch = Math.round((h + 2 * bleedY) * dpr);
    const newScale = dpr * w / W;
    if (canvas.width !== cw || canvas.height !== ch || scale !== newScale) {
      canvas.width = cw;
      canvas.height = ch;
      scale = newScale;
      bgCache = null;
    }
    $('#rotate').classList.toggle('show', vh > vw * 1.15 && vw < 900);
  }

  // How much the match HUD grows on a small screen: 1 on a laptop, about 1.23 on a 20:9 phone in landscape
  let STAGE_PX = 1280;
  function hudK() {
    return clamp(900 / STAGE_PX, 1, 1.28) * (SAVE.settings.text === 'large' ? 1.1 : 1);
  }
  // A player's name as a TV score bug shows it: the surname
  // Your name as typed, and as the broadcast shows it (surname in capitals); YOU and you until you choose one
  // Your first name and surname (an older save has one name: it becomes the first name)
  // A capital at the start of each part of a name (Mary-Jane, Le Roux); the rest as typed (McEnroe stays)
  function capName(v) { return String(v || '').trim().replace(/(^|[\s-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase()); }
  function myNames() {
    const P = SAVE.player || {};
    if (!P.first && !P.last && P.name) { P.first = String(P.name).trim(); P.last = ''; }
    return { first: capName(P.first), last: capName(P.last) };
  }
  function myName() { const n = myNames(); return (n.first + ' ' + n.last).trim(); }
  function mySur() { const n = myNames(); return n.last || n.first; }
  function myTv() { return mySur() ? mySur().toUpperCase() : 'YOU'; }
  // As the umpire says it: surnames, as on the tour
  function mySaid() { return mySur() || 'you'; }
  function oppSaid() { return String(M.cfg.opp.name).trim().split(' ').pop(); }
  function tvName(name) {
    const w = String(name).trim().split(/\s+/);
    return w[w.length - 1].toUpperCase();
  }
  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * (W + 2 * BX) - BX, y: (e.clientY - r.top) / r.height * (H + 2 * BY) - BY };
  }

  // Shrinks a one-line label until it fits its box (long amounts of prize money)
  // Shrinks a canvas font until the text fits maxW
  function fitCanvasText(ctx, text, maxW, size, family, weight) {
    let px = size;
    ctx.font = (weight || '') + px + 'px ' + family;
    while (ctx.measureText(text).width > maxW && px > 10) { px -= 1; ctx.font = (weight || '') + px + 'px ' + family; }
  }
  function fitWidth(el) {
    el.style.fontSize = '';
    let px = parseFloat(getComputedStyle(el).fontSize);
    const box = el.parentNode.clientWidth - 4;
    while (el.scrollWidth > box && px > 11) { px -= 1; el.style.fontSize = px + 'px'; }
  }
  // Plays a list's entrance again (the cards slide in one after another), for a tab change
  function replayEnter(el) {
    if (!el) return;
    el.classList.remove('enter');
    void el.offsetWidth;
    el.classList.add('enter');
    clearTimeout(el.__enterT);
    el.__enterT = setTimeout(() => el.classList.remove('enter'), 900);
  }
  // A scrolling list fades out at whichever edge has more to swipe to (there is no scrollbar)
  function edgeFade(el) {
    el.classList.toggle('more-above', el.scrollTop > 4);
    el.classList.toggle('more-below', el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  }

  let toastTimer = 0;
  const ACHIEVEMENTS = [
    { id: 'first', name: 'First Blood', desc: 'Win a match.', test: (r) => r.won },
    { id: 'bagel', name: 'Bagel Baker', desc: 'Win without dropping a game.', test: (r) => r.won && r.games[1] === 0 },
    { id: 'aces', name: 'Ace Machine', desc: 'Serve 5 aces in one match.', test: (r) => r.stats.aces >= 5 },
    { id: 'windup', name: 'Wind-Up Merchant', trophy: 'rattled', desc: 'Make an opponent lose their temper.' },
    { id: 'tooslow', name: 'Too Slow!', desc: 'Pull your hand away at the net.', test: (r) => r.handshake && r.handshake.choice === 'tooSlow' },
    { id: 'hanging', name: 'Left Hanging', desc: 'Get snubbed at the net.', test: (r) => r.handshake && r.handshake.snub },
    { id: 'settled', name: 'Old Score Settled', desc: 'Beat someone who beat you last time.', test: (r) => r.revenge },
    { id: 'scratch', name: 'The Clean Bag', trophy: 'cleanBag', desc: 'Win a tournament without smashing a racket.' },
    { id: 'graveyard', name: 'Racket Graveyard', desc: 'Smash 10 rackets in your career.', test: (r, S) => S.stats.racketsSmashed >= 10 },
    { id: 'royal', name: 'Royal Appointment', desc: 'Land a racket in the Royal Box.', test: (r) => r.reason === 'royal' && (r.incident || 'royal') === 'royal' },
    { id: 'villain', name: 'Pantomime Villain', trophy: 'villain', desc: 'Become a Pantomime Villain in the press. Answer rudely.' },
    { id: 'treasure', name: 'Nation\'s Darling', trophy: 'darling', desc: 'Become the Nation\'s Darling in the press. Answer nicely.' },
    { id: 'fines', name: 'Federation Favourite', desc: 'Pay £100,000 in fines.', test: (r, S) => S.totalFines >= 100000 },
    { id: 'habit', name: 'Creature of Habit', desc: 'Play the Daily Meltdown 7 days running.', test: (r, S) => S.dailyStreak >= 7 },
    { id: 'allcourt', name: 'All-Court Player', desc: 'Win on grass, hard, indoor and clay.', test: (r, S) => ['grass', 'hard', 'indoor', 'clay'].every((k) => S.surf && S.surf[k] && S.surf[k].w > 0) },
    { id: 'slam', name: 'Grand Slam Champion', desc: 'Win the Wimbleford Cup.', test: (r) => r.final && r.won && r.cfg.tierIdx === 4 },
    { id: 'again', name: 'Again, With Feeling', desc: 'Win a title in Grudge Tour+.', test: (r, S) => r.final && r.won && (S.season || 1) > 1 }
  ];
  // Returns the achievements this result has just unlocked, and shows them one after another
  function checkAchievements(r) {
    SAVE.ach = SAVE.ach || {};
    // Awards that follow a trophy were announced with the trophy; this only catches up older saves, quietly
    ACHIEVEMENTS.forEach((a) => {
      if (a.trophy && !SAVE.ach[a.id] && SAVE.unlockedTrophies.indexOf(a.trophy) >= 0) {
        SAVE.ach[a.id] = dateKey();
        if (window.RRGames) RRGames.unlock(a.id);
      }
    });
    const got = ACHIEVEMENTS.filter((a) => !a.trophy && !SAVE.ach[a.id] && (() => { try { return a.test(r, SAVE); } catch (e) { return false; } })());
    got.forEach((a, i) => {
      SAVE.ach[a.id] = dateKey();
      if (window.RRGames) RRGames.unlock(a.id);
      award('ach', a.name, a.desc);
    });
    return got;
  }
  // How each trophy was won, for its card
  const TROPHY_WHY = {
    t0: 'Won the Club Open.', t1: 'Won the County Closed.', t2: 'Won the Grimsby Challenger.', t3: 'Won the Tunbridge Invitational.', t4: 'Won the Grand Slam at Wimbleford.',
    royalBox: 'Landed a racket in the Royal Box.', cleanBag: 'Won a tournament without smashing a racket.', hothead: 'Smashed 10 rackets in your career.',
    ace150: 'Served at 150 mph.', villain: 'The press now calls you a pantomime villain.', darling: 'The press now calls you the nation\'s darling.',
    devotee: 'Played the Daily Meltdown three days running.', allTantrums: 'Every tantrum in your repertoire.', allCelebs: 'Every celebration in your repertoire.',
    allIncidents: 'Caused every incident there is.', celeb50: 'Celebrated 50 times.', rattled: 'Made an opponent lose their temper.'
  };
  // How to earn each trophy, for the ones not won yet
  const TROPHY_HOW = {
    t0: 'Win the Club Open.', t1: 'Win the County Closed.', t2: 'Win the Grimsby Challenger.', t3: 'Win the Tunbridge Invitational.', t4: 'Win the Grand Slam at Wimbleford.',
    royalBox: 'Land a racket in the Royal Box. Aim high.', cleanBag: 'Win a tournament without smashing a racket.', hothead: 'Smash 10 rackets in your career.',
    ace150: 'Serve at 150 mph.', villain: 'Answer the press rudely until they call you a villain.', darling: 'Answer the press nicely until they call you a darling.',
    devotee: 'Play the Daily Meltdown three days running.', allTantrums: 'Own every tantrum.', allCelebs: 'Own every celebration.',
    allIncidents: 'Cause every incident there is.', celeb50: 'Celebrate 50 times.', rattled: 'Make an opponent lose their temper.'
  };
  const CUP_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 6h20v6h7v4c0 6-4 10-9 11-2 4-5 6-7 6v5h7v5H16v-5h7v-5c-2 0-5-2-7-6-5-1-9-5-9-11v-4h7zm-3 10c0 3 2 5 4 6-1-2-1-4-1-6zm26 0h-3c0 2 0 4-1 6 2-1 4-3 4-6z"/></svg>';
  const MEDAL_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 4h8l4 10-5 3zm20 0h-8l-4 10 5 3zM24 16a14 14 0 1 1 0 28 14 14 0 0 1 0-28zm0 5l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>';
  // Achievements that come with a trophy show as the trophy; the rest have their own medals in the room
  const soloAch = () => ACHIEVEMENTS.filter((a) => !a.trophy);
  // Everything won, trophies and medals together, for the title screen's chip and the room's heading
  function awardTally() {
    const ach = SAVE.ach || {};
    const t = Object.keys(TROPHIES).filter((id) => SAVE.unlockedTrophies.indexOf(id) >= 0).length;
    const a = soloAch().filter((x) => ach[x.id]).length;
    return { n: t + a, total: Object.keys(TROPHIES).length + soloAch().length };
  }
  // The Trophy Room: tournament trophies first, then the rest, then the achievement medals; won ones in gold,
  // the others as silhouettes with how to earn them
  function openTrophies() {
    const ids = Object.keys(TROPHIES);
    const won = (id) => SAVE.unlockedTrophies.indexOf(id) >= 0;
    const tally = awardTally();
    $('#trophyTitle').textContent = tally.n + ' of ' + tally.total + (tally.n === tally.total ? '. The full set.' : '');
    const grid = $('#trophyGrid');
    grid.innerHTML = '';
    const head = (text) => { const h = document.createElement('div'); h.className = 'troph-head'; h.textContent = text; grid.appendChild(h); };
    const tile = (got, svg, name, line, medal) => {
      const d = document.createElement('div');
      d.className = 'troph' + (got ? ' got' : '') + (medal ? ' medal' : '');
      d.innerHTML = svg + '<span><b></b><small></small></span>';
      d.querySelector('b').textContent = name;
      d.querySelector('small').textContent = line;
      grid.appendChild(d);
    };
    head('Trophies ' + ids.filter(won).length + '/' + ids.length);
    ids.forEach((id) => {
      const got = won(id);
      const times = /^t\d$/.test(id) ? ((SAVE.titles && SAVE.titles[id]) || (got ? 1 : 0)) : 0;
      tile(got, CUP_SVG, TROPHIES[id] + (times > 1 ? ' x' + times : ''), got ? TROPHY_WHY[id] : TROPHY_HOW[id]);
    });
    const ach = SAVE.ach || {};
    const solo = soloAch();
    head('Achievements ' + solo.filter((a) => ach[a.id]).length + '/' + solo.length);
    solo.forEach((a) => tile(!!ach[a.id], MEDAL_SVG, a.name, a.desc, true));
    grid.scrollTop = 0;
    $('#trophyModal').classList.remove('hidden');
  }
  // Award cards: a trophy or an achievement, shown one at a time on a calm screen (never during a match or a
  // meltdown, where they wait). Tap to dismiss; the Record in the tour screen lists them all.
  const AWARDS = [];
  let awardUp = false;
  const AWARD_CALM = /^(GAME_OVER|MENU|CAREER_HUB|LOCKER_ROOM)$/;
  function award(kind, name, why) {
    AWARDS.push({ kind: kind, name: name, why: why });
    pumpAwards();
  }
  function pumpAwards() {
    if (awardUp || !AWARDS.length || !AWARD_CALM.test(FSM.name || '')) return;
    const a = AWARDS.shift();
    const el = $('#award');
    awardUp = true;
    el.classList.toggle('ach', a.kind === 'ach');
    $('#awardKind').textContent = a.kind === 'ach' ? 'Achievement' : 'Trophy won';
    $('#awardName').textContent = a.name;
    $('#awardWhy').textContent = a.why;
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    sfx('stingUp');
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('click', done);
      el.classList.remove('show');
      setTimeout(() => { el.classList.add('hidden'); awardUp = false; setTimeout(pumpAwards, 350); }, 260);
    };
    timer = setTimeout(done, 3800);
    el.addEventListener('click', done);
    // Tapping a card opens the Trophy Room, where it now sits in gold
    el.onclick = () => openTrophies();
  }
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = tapify(msg);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  // A named feel for a contact: heavy for a perfect strike, medium for a good one, light for a mishit
  function haptic(kind) {
    if (!SAVE.settings.vibration) return;
    const Cap = window.Capacitor;
    try {
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Haptics) {
        Cap.Plugins.Haptics.impact({ style: kind === 'heavy' ? 'HEAVY' : kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
        return;
      }
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      if (navigator.vibrate) navigator.vibrate(kind === 'heavy' ? [10, 20, 26] : kind === 'medium' ? 14 : [5, 35, 5]);
    } catch (e) { /* ignore */ }
  }
  // Asking for a Play Store review: only at a high point (a tournament won, or a Quick Match or Daily win),
  // only once you have won a few matches, at most once every 45 days and three times ever. Never after a loss.
  // Google decides whether the card actually appears; nothing in the game depends on the answer.
  const REVIEW_ASK = { minWins: 3, gapDays: 45, maxAsks: 3, delay: 2.5 };
  function maybeAskReview(res) {
    if (!res || !res.won) return;
    const R = SAVE.review || (SAVE.review = { asks: 0, last: 0 });
    if (SAVE.stats.matchesWon < REVIEW_ASK.minWins || R.asks >= REVIEW_ASK.maxAsks) return;
    if (Date.now() - R.last < REVIEW_ASK.gapDays * 86400000) return;
    const Cap = window.Capacitor;
    const plugin = Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.InAppReview;
    if (!plugin) return;
    R.asks++;
    R.last = Date.now();
    persist();
    setTimeout(() => { try { plugin.requestReview().catch(() => {}); } catch (e) { /* ignore */ } }, REVIEW_ASK.delay * 1000);
  }
  function vibrate(pattern) {
    if (!SAVE.settings.vibration) return;
    const Cap = window.Capacitor;
    try {
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Haptics) {
        const heavy = Array.isArray(pattern) || pattern > 60;
        Cap.Plugins.Haptics.impact({ style: heavy ? 'HEAVY' : 'MEDIUM' });
        return;
      }
      // Browsers refuse (and log an error) if the page has not had a tap yet, as in the intro
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* ignore */ }
  }

  const sfx = (name, opts) => window.RRAudio && RRAudio.play(name, opts);

  /* =====================================================================
     5. Court projection and drawing helpers
     ===================================================================== */
  // Court in metres. x across (0 is the centre line), y from your baseline (0) to theirs (23.77).
  const C = { L: 23.77, net: 11.885, hw: 4.115, dw: 5.485, svc: 6.4 };
  const CAM = { back: 12, h: 6, H0: -4.4, K: 1159, F: 1050 };

  function proj(x, y, z) {
    const d = Math.max(0.5, y + CAM.back);
    return { x: 640 + CAM.F * x / d, y: CAM.H0 + (CAM.h - (z || 0)) * CAM.K / d, s: CAM.K / d };
  }

  function quad(ctx, pts, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = proj(p[0], p[1], p[2] || 0);
      if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.fill();
  }

  function courtLine(ctx, x1, y1, x2, y2, color) {
    const w = 0.05;
    if (x1 === x2) quad(ctx, [[x1 - w, y1], [x1 + w, y1], [x2 + w, y2], [x2 - w, y2]], color);
    else quad(ctx, [[x1, y1 - w], [x2, y2 - w], [x2, y2 + w], [x1, y1 + w]], color);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxW) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    words.forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    });
    if (line) lines.push(line);
    return lines;
  }

  /* Venues. Stands are measured in metres from the centre line: the front wall at x0, then tiers of
     depth by rise. y0 to y1 is how far they run along the court. density is how full the seats are. */
  const VENUES = {
    club: {
      sunK: 0, kids: 0, chair: false, calls: 'players', screen: false, blazer: '#2c5a2c', kidShirt: '#f4f1e6', hat: 'cap',
      sky: ['#86bde4', '#dcefd8'], board: '#2c5a2c', boardText: ['#f4f1e6', '#f2c14e'],
      tiers: 2, x0: 8.4, depth: 1.0, rise: 0.42, wallH: 0.7, y0: 1, y1: 24, seat: 0.85, density: 0.42,
      tread: '#9a6a3c', tread2: '#8a5d33', riser: '#6b4a2c', wall: '#e9e4d4', backWall: null,
      palette: ['#f4f1e6', '#e8d9b5', '#9cc7e8', '#f2c14e', '#d94f7a', '#2f8f83', '#ffffff', '#b5c99a'], hatP: 0.3, hat: '#e9d8a6', flagP: 0, flags: []
    },
    council: {
      sunK: 3, kids: 0, chair: false, calls: 'players', screen: false, blazer: '#1f3a6b', kidShirt: '#c8102e', hat: 'cap',
      sky: ['#76838f', '#c3ccd3'], board: '#2e4a3a', boardText: ['#f4f1e6', '#d9f24a'],
      tiers: 4, x0: 8.3, depth: 0.85, rise: 0.5, wallH: 0.9, y0: -5, y1: 29, seat: 0.6, density: 0.5,
      tread: '#a9b0b6', tread2: '#9aa1a7', riser: '#60676d', wall: '#3a6b4a', backWall: null,
      palette: ['#2b4a7a', '#7a2b2b', '#3d5c3a', '#c9a227', '#4a4a4a', '#1f6b8a', '#8a4b1f', '#d0d0c8'], hatP: 0.18, hat: '#2a2a2a', flagP: 0.03, flags: ['#c8102e', '#f4f1e6']
    },
    leisure: {
      sunK: 0, kids: 4, chair: true, calls: 'umpire', screen: false, blazer: '#2f5f9e', kidShirt: '#f2c14e', kidCap: '#2f5f9e', hat: 'cap',
      sky: ['#cbc2a3', '#e4ddc4'], board: '#2f5f9e', boardText: ['#f4f1e6', '#f2c14e'],
      tiers: 5, x0: 8.2, depth: 0.8, rise: 0.45, wallH: 0.9, y0: -5, y1: 29, seat: 0.55, density: 0.62,
      tread: '#c99a5e', tread2: '#b98a50', riser: '#7a5a32', wall: '#2f5f9e', backWall: '#d6ceb2',
      palette: ['#1f3a6b', '#c8102e', '#2f8f83', '#6b3fa0', '#f2c14e', '#333333', '#e8e8e8', '#ff7a1a'], hatP: 0.05, hat: '#c8102e', flagP: 0.03, flags: ['#1f3a6b', '#f2c14e']
    },
    invitational: {
      sunK: 2.6, kids: 4, chair: true, calls: 'umpire', screen: true, blazer: '#1f4a33', kidShirt: '#f4f1e6', kidCap: '#1f4a33', hat: 'panama',
      sky: ['#6fa6d6', '#cfe5f4'], board: '#1f4a33', boardText: ['#f4f1e6', '#e8c66a'],
      tiers: 7, x0: 8.2, depth: 0.8, rise: 0.5, wallH: 1.0, y0: -6, y1: 30, seat: 0.55, density: 0.85,
      tread: '#2a5c40', tread2: '#24533a', riser: '#173827', wall: '#1f4a33', backWall: '#173827',
      palette: ['#1f3a6b', '#f4f1e6', '#8a1c2b', '#2f5a3a', '#e8d9b5', '#6b3fa0', '#ffffff', '#d4af37'], hatP: 0.3, hat: '#efe2b8', flagP: 0.03, flags: ['#c8102e', '#f4f1e6']
    },
    slam: {
      sunK: 2.4, kids: 6, chair: true, calls: 'electronic', screen: true, blazer: '#3b1f5e', kidShirt: '#1f6b3a', kidCap: '#3b1f5e', hat: 'panama',
      sky: ['#0b1a13', '#26473a'], board: '#3b1f5e', boardText: ['#f4f1e6', '#d9f24a'],
      tiers: 11, x0: 8.2, depth: 0.72, rise: 0.48, wallH: 1.0, y0: -6, y1: 30, seat: 0.5, density: 0.97,
      tread: '#24563a', tread2: '#1f4d33', riser: '#13291c', wall: '#3b1f5e', backWall: '#0f2016',
      palette: ['#c8102e', '#1f3a6b', '#f4f1e6', '#2f8f83', '#f2c14e', '#6b3fa0', '#333333', '#7aa6c2', '#ffffff'], hatP: 0.08, hat: '#f4f1e6', flagP: 0.07, flags: ['#6b3fa0', '#1f6b3a', '#f4f1e6']
    }
  };
  const VENUE_BY_TIER = ['club', 'council', 'leisure', 'invitational', 'slam'];
  Object.keys(VENUES).forEach((k) => { VENUES[k].key = k; });
  // Who comes to each venue: how many are older, what they wear, and the seats they sit on
  const CROWD_PROFILE = {
    club: { old: 0.45, wear: { cardigan: 0.3, polo: 0.25, tee: 0.2, jacket: 0.15, dress: 0.1 }, seat: null },
    council: { old: 0.2, wear: { hoodie: 0.3, tee: 0.35, jacket: 0.2, stripe: 0.15 }, seat: '#2f6fb0' },
    leisure: { old: 0.25, wear: { tee: 0.4, hoodie: 0.2, polo: 0.2, jacket: 0.2 }, seat: '#e2701c' },
    invitational: { old: 0.35, wear: { jacket: 0.35, dress: 0.2, polo: 0.25, cardigan: 0.1, tee: 0.1 }, seat: '#2a6b4a' },
    slam: { old: 0.2, wear: { tee: 0.25, dress: 0.2, polo: 0.2, jacket: 0.25, stripe: 0.1 }, seat: '#5a2f86' }
  };
  const CROWD_POSES = { rest: 0.45, folded: 0.18, drink: 0.1, fan: 0.08, chin: 0.07, phone: 0.07, point: 0.05 };
  // Every random choice for one spectator, always in the same order, so the same seat gets the same person
  function crowdPerson(rng, V) {
    const prof = CROWD_PROFILE[V.key] || CROWD_PROFILE.slam;
    const P = {
      kid: rng() < 0.08,
      body: rng() < 0.4 ? CROWD_NEUTRALS[Math.floor(rng() * CROWD_NEUTRALS.length)] : V.palette[Math.floor(rng() * V.palette.length)],
      inner: V.palette[Math.floor(rng() * V.palette.length)],
      skin: CROWD_SKINS[Math.floor(rng() * CROWD_SKINS.length)],
      look: crowdLook(rng),
      wear: pickWeighted(prof.wear, rng()),
      pose: pickWeighted(CROWD_POSES, rng()),
      lean: rng() < 0.25 ? (rng() < 0.5 ? -1 : 1) : 0,
      dir: rng() < 0.5 ? -1 : 1,
      cup: rng() < 0.5 ? '#f4f1e6' : '#c8102e'
    };
    const old = rng() < prof.old;
    const grey = rng();
    const bald = rng();
    if (old && !P.kid) {
      P.look.hair = grey < 0.5 ? '#d9d9d4' : '#9a9a9a';
      if (P.look.style === 'long' || P.look.style === 'curly') P.look.style = 'short';
      if (bald < 0.3) P.look.style = 'bald';
    }
    if (P.inner === P.body) P.inner = '#f4f1e6';
    // Trousers, shorts or a skirt, and shoes. Shorts at the outdoor venues in summer.
    const lw = rng();
    P.legWear = P.wear === 'dress' ? 'skirt' : lw < (V.key === 'club' || V.key === 'council' ? 0.3 : 0.12) ? 'shorts' : 'trousers';
    P.legs = LEG_COLS[Math.floor(rng() * LEG_COLS.length)];
    P.shoe = rng() < 0.5 ? '#f4f4ee' : '#2a2622';
    return P;
  }
  // The clothes on a torso (top of the shoulders at ty, shoulder width sw, height h)
  function paintWear(g, x, ty, sw, h, r, P) {
    g.fillStyle = P.body;
    shoulders(g, x, ty, sw, h);
    g.fill();
    if (P.wear === 'dress') {
      // Bare shoulders and straps
      g.fillStyle = P.skin;
      shoulders(g, x, ty, sw, r * 0.6);
      g.fill();
      g.fillStyle = P.body;
      g.fillRect(x - sw * 0.3, ty, r * 0.24, r * 0.65);
      g.fillRect(x + sw * 0.3 - r * 0.24, ty, r * 0.24, r * 0.65);
      g.fillRect(x - sw * 0.44, ty + r * 0.55, sw * 0.88, r * 0.25);
    } else if (P.wear === 'jacket' || P.wear === 'cardigan') {
      // Open at the front, the shirt underneath showing
      g.fillStyle = P.inner;
      g.beginPath();
      g.moveTo(x - r * 0.5, ty);
      g.lineTo(x + r * 0.5, ty);
      g.lineTo(x + r * 0.32, ty + h);
      g.lineTo(x - r * 0.32, ty + h);
      g.fill();
      if (P.wear === 'jacket') {
        g.fillStyle = shadeHex(P.body, -0.2);
        [-1, 1].forEach((sd) => {
          g.beginPath();
          g.moveTo(x + sd * r * 0.5, ty);
          g.lineTo(x + sd * r * 0.95, ty);
          g.lineTo(x + sd * r * 0.42, ty + r * 1.1);
          g.fill();
        });
      } else {
        g.fillStyle = shadeHex(P.body, -0.35);
        for (let i = 0; i < 3; i++) g.fillRect(x - r * 0.48, ty + r * (0.5 + i * 0.6), Math.max(0.8, r * 0.16), Math.max(0.8, r * 0.16));
      }
    } else if (P.wear === 'polo') {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.moveTo(x - r * 0.55, ty);
      g.lineTo(x, ty + r * 0.5);
      g.lineTo(x + r * 0.55, ty);
      g.fill();
    } else if (P.wear === 'stripe') {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 3; i++) g.fillRect(x - sw / 2, ty + r * (0.6 + i * 0.7), sw, r * 0.28);
    } else if (P.wear === 'hoodie') {
      g.strokeStyle = '#f4f1e6';
      g.lineWidth = Math.max(0.6, r * 0.12);
      g.beginPath();
      g.moveTo(x - r * 0.25, ty + r * 0.15);
      g.lineTo(x - r * 0.25, ty + r * 0.9);
      g.moveTo(x + r * 0.25, ty + r * 0.15);
      g.lineTo(x + r * 0.25, ty + r * 0.9);
      g.stroke();
    } else {
      g.fillStyle = shadeHex(P.body, -0.2);
      g.beginPath();
      g.arc(x, ty, r * 0.5, 0, Math.PI);
      g.fill();
    }
    // Shade down the side away from the light
    g.fillStyle = 'rgba(0,0,0,0.13)';
    g.fillRect(x + sw * 0.22, ty + r * 0.35, sw * 0.28, h - r * 0.35);
  }
  // Arms, by pose, over the torso. hx, hy: the head. Light enough to read at a few pixels high.
  function paintPose(g, x, ty, sw, r, hx, hy, P) {
    const sleeve = P.wear === 'dress' ? P.skin : shadeHex(P.body, -0.1);
    const lw = Math.max(1, r * 0.55);
    const arm = (ax, ay, bx, by) => {
      g.strokeStyle = sleeve;
      g.lineWidth = lw;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.fillStyle = P.skin;
      g.beginPath();
      g.arc(bx, by, lw * 0.55, 0, Math.PI * 2);
      g.fill();
    };
    if (P.pose === 'folded') {
      g.fillStyle = sleeve;
      roundRect(g, x - sw * 0.44, ty + r * 1.2, sw * 0.88, r * 0.6, r * 0.25);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(x - sw * 0.44, ty + r * 1.5, sw * 0.88, r * 0.12);
    } else if (P.pose === 'drink') {
      arm(x + sw * 0.32, ty + r * 1.7, hx + r * 0.55, hy + r * 0.75);
      g.fillStyle = P.cup;
      g.fillRect(hx + r * 0.35, hy + r * 0.15, r * 0.45, r * 0.6);
    } else if (P.pose === 'fan') {
      arm(x - sw * 0.32, ty + r * 1.6, hx - r * 1.15, hy + r * 0.5);
      g.fillStyle = P.inner;
      g.fillRect(hx - r * 1.65, hy - r * 0.45, r * 0.9, r * 1.15);
    } else if (P.pose === 'chin') {
      arm(x + sw * 0.18, ty + r * 1.9, hx + r * 0.1, hy + r * 1.0);
    } else if (P.pose === 'phone') {
      g.fillStyle = '#16181c';
      g.fillRect(x - r * 0.28, ty + r * 0.95, r * 0.56, r * 0.8);
      g.fillStyle = P.skin;
      g.fillRect(x - r * 0.42, ty + r * 1.5, r * 0.84, r * 0.3);
    } else if (P.pose === 'point') {
      arm(x + P.dir * sw * 0.4, ty + r * 0.45, x + P.dir * r * 2.6, ty - r * 0.25);
    }
  }
  function venueKey(cfg) {
    if (cfg.mode === 'tutorial') return 'club';
    if (cfg.mode === 'career' || cfg.mode === 'quick') return VENUE_BY_TIER[cfg.tierIdx] || 'slam';
    // The Daily Meltdown picks a venue that suits its surface
    if (cfg.surface === 'indoor') return 'leisure';
    if (cfg.surface === 'clay') return 'invitational';
    if (cfg.surface === 'hard') return 'council';
    return (cfg.seed >>> 3) % 2 ? 'slam' : 'club';
  }
  const CROWD_NEUTRALS = ['#f4f1e6', '#ffffff', '#1f2a44', '#2a2a2a', '#8a8f96', '#d8cfb8', '#4a6a8a', '#6b4a3a'];
  const LEG_COLS = ['#2b3a55', '#3b4f73', '#2a2a2a', '#c9b48a', '#5a4a3a', '#e8e4d8', '#6b6f73', '#3d5c3a'];
  const CROWD_SKINS = ['#e8c3a0', '#d9a27c', '#a8714f', '#f0c9a8', '#8d5a3b', '#f3d2b8', '#6b4430'];
  const CROWD_HAIR = ['#2a1d14', '#4a3020', '#8a5a2b', '#d8b46a', '#1a1a1a', '#9a9a9a', '#c8642c', '#e8e0d0'];
  // A torso with rounded shoulders, from the neck (x, y) down to y + hgt
  function shoulders(g, x, y, w, hgt) {
    g.beginPath();
    g.moveTo(x - w / 2, y + hgt);
    g.lineTo(x - w / 2, y + w * 0.32);
    g.quadraticCurveTo(x - w / 2, y, x - w * 0.18, y);
    g.lineTo(x + w * 0.18, y);
    g.quadraticCurveTo(x + w / 2, y, x + w / 2, y + w * 0.32);
    g.lineTo(x + w / 2, y + hgt);
    g.closePath();
  }
  // Hair: a cap over the top of the head, with a few styles. Long hair is drawn behind the shoulders first.
  function paintHair(g, x, y, r, col, style) {
    g.fillStyle = col;
    g.beginPath();
    if (style === 'curly') {
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * (1.0 + i * 0.25);
        g.moveTo(x + Math.cos(a) * r * 0.85 + r * 0.42, y + Math.sin(a) * r * 0.85);
        g.arc(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, r * 0.42, 0, Math.PI * 2);
      }
    } else {
      g.arc(x, y - r * 0.06, r * 1.03, Math.PI * 1.02, Math.PI * 1.98);
      if (style === 'bob') { g.rect(x - r * 1.03, y - r * 0.2, r * 0.32, r * 0.95); g.rect(x + r * 0.71, y - r * 0.2, r * 0.32, r * 0.95); }
    }
    g.fill();
  }
  function crowdLook(rng) {
    const h = rng();
    return {
      hair: CROWD_HAIR[Math.floor(rng() * CROWD_HAIR.length)],
      style: h < 0.08 ? 'bald' : h < 0.26 ? 'long' : h < 0.38 ? 'bob' : h < 0.5 ? 'curly' : 'short',
      top: rng(),
      shades: rng() < 0.14
    };
  }
  // A seated spectator in screen space: head at (x, y), radius r
  // A seated spectator in screen space: head at (x, y), radius r. A small head on a neck over broad shoulders,
  // dressed for the venue, doing something: arms folded, a drink, a programme as a fan, chin in hand, a phone.
  function paintSpectator(g, x, y, r, V, rng, look, B) {
    const P = crowdPerson(rng, V);
    let sw;
    let ty;
    let h;
    if (B) {
      // Measured from the body: head, shoulders and hips on the seat; a child sits lower and narrower
      r = 0.112 * B.s;
      if (B.adult) P.kid = false;
      const drop = P.kid ? 0.2 * B.s : 0;
      if (P.kid) r *= 0.82;
      y = B.head.y + drop;
      x = B.head.x;
      sw = (P.kid ? 0.3 : 0.42) * B.s;
      ty = B.sh.y + drop;
      h = Math.max(r, B.hip.y - ty + 0.05 * B.s);
    } else if (P.kid) { y += r * 0.9; r *= 0.75; }
    r *= 0.82;
    const L = P.look;
    const hx = x + P.lean * r * 0.35;
    if (!B) {
      sw = r * 3.3;
      ty = y + r * 1.25;
      h = r * 2.8;
    }
    const away = look === 'far';
    if (P.wear === 'hoodie') {
      g.fillStyle = shadeHex(P.body, -0.15);
      g.beginPath();
      g.ellipse(x, ty - r * 0.05, r * 1.2, r * 0.6, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (L.style === 'long') { g.fillStyle = L.hair; g.fillRect(hx - r, y - r * 0.3, r * 2, r * 2); }
    paintWear(g, x, ty, sw, h, r, P);
    g.fillStyle = shadeHex(P.skin, -0.12);
    g.fillRect(hx - r * 0.34, y + r * 0.55, r * 0.68, r * 0.8);
    g.fillStyle = P.skin;
    g.beginPath();
    g.arc(hx, y, r, 0, Math.PI * 2);
    g.fill();
    if (away) {
      // Turned away: the back of the head
      if (L.style !== 'bald') {
        g.fillStyle = L.hair;
        g.beginPath();
        g.arc(hx, y - r * 0.04, r * 1.03, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      if (L.style !== 'bald') paintHair(g, hx, y, r, L.hair, L.style === 'long' ? 'short' : L.style);
      if (r > 2.4) {
        const turn = B && B.face ? B.face * r * 0.22 : 0;
        g.fillStyle = '#1b1b1b';
        g.fillRect(hx - r * 0.42 + turn, y - r * 0.02, Math.max(0.8, r * 0.2), Math.max(0.8, r * 0.2));
        g.fillRect(hx + r * 0.22 + turn, y - r * 0.02, Math.max(0.8, r * 0.2), Math.max(0.8, r * 0.2));
      }
    }
    if (B && !B.noLegs) paintLegs(g, B, P, r);
    if (B && !B.noLegs && P.pose === 'rest') {
      const sleeve = P.wear === 'dress' ? P.skin : shadeHex(P.body, -0.1);
      const lw = Math.max(1, r * 0.55);
      [0, 1].forEach((i) => {
        const L2 = B.legs[i];
        const sd = i ? 1 : -1;
        const hand = { x: lerp(L2[0].x, L2[1].x, 0.6), y: lerp(L2[0].y, L2[1].y, 0.6) - lw * 0.3 };
        g.strokeStyle = sleeve;
        g.lineWidth = lw;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x + sd * sw * 0.4, ty + r * 0.5);
        g.lineTo(x + sd * sw * 0.46, (ty + B.hip.y) / 2);
        g.lineTo(hand.x, hand.y);
        g.stroke();
        g.fillStyle = P.skin;
        g.beginPath();
        g.arc(hand.x, hand.y, lw * 0.55, 0, Math.PI * 2);
        g.fill();
      });
    }
    if (!(B && B.back)) paintPose(g, x, ty, sw, r, hx, y, P);
    if (L.shades && r > 2.2 && !away) {
      g.fillStyle = '#121212';
      g.fillRect(hx - r * 0.78, y - r * 0.12, r * 1.56, r * 0.32);
    }
    x = hx;
    const k = rng();
    if (k < V.hatP) {
      g.fillStyle = V.hat;
      g.fillRect(x - r * 1.3, y - r * 0.65, r * 2.6, r * 0.4);
      g.fillRect(x - r * 0.8, y - r * 1.3, r * 1.6, r * 0.75);
    } else if (k < V.hatP + V.flagP && V.flags.length && !(B && B.adult)) {
      g.fillStyle = V.flags[Math.floor(rng() * V.flags.length)];
      g.fillRect(x + r * 0.8, y - r * 3.2, r * 2.2, r * 1.4);
      g.fillStyle = '#ddd';
      g.fillRect(x + r * 0.7, y - r * 3.2, r * 0.2, r * 3.4);
    }
  }
  // Both legs of a seated spectator: thighs out over the front of the seat, shins down to the step, shoes.
  // B.legs is far leg first, each [hip, knee, foot] in screen space.
  function paintLegs(g, B, P, r) {
    const s = B.s;
    const thigh = Math.max(1.2, 0.15 * s);
    const shin = Math.max(1, 0.11 * s);
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.beginPath();
    g.ellipse((B.legs[0][2].x + B.legs[1][2].x + B.hip.x) / 3, (B.legs[0][2].y + B.legs[1][2].y) / 2, 0.32 * s, 0.07 * s, 0, 0, Math.PI * 2);
    g.fill();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    B.legs.forEach((L) => {
      const lower = P.legWear === 'trousers' ? P.legs : P.skin;
      g.strokeStyle = shadeHex(lower, -0.08);
      g.lineWidth = shin;
      g.beginPath();
      g.moveTo(L[1].x, L[1].y);
      g.lineTo(L[2].x, L[2].y - shin * 0.3);
      g.stroke();
      g.strokeStyle = P.legWear === 'skirt' ? P.body : P.legWear === 'shorts' ? P.legs : P.legs;
      g.lineWidth = thigh;
      g.beginPath();
      g.moveTo(L[0].x, L[0].y);
      g.lineTo(L[1].x, L[1].y);
      g.stroke();
      if (P.legWear === 'skirt' || P.legWear === 'shorts') {
        // Bare knee below the hem
        g.fillStyle = P.skin;
        g.beginPath();
        g.arc(L[1].x, L[1].y, shin * 0.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = P.shoe;
      g.beginPath();
      g.ellipse(L[2].x + (L[2].x - L[1].x) * 0.25, L[2].y - shin * 0.15, Math.max(1, 0.075 * s), Math.max(0.8, 0.04 * s), 0, 0, Math.PI * 2);
      g.fill();
    });
    // The lap, shaded where the torso meets it
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(B.hip.x - 0.2 * s, B.hip.y - 0.02 * s, 0.4 * s, Math.max(1, 0.035 * s));
  }
  /* ---- Sponsors. Each has its own mark, colours and type, so a board reads before its words do ---- */
  const SPONSORS = {
    barley: { bg: '#1f4a33', fg: '#f4ecd2', accent: '#e8c66a', font: 'italic bold {s}px Georgia, "Times New Roman", serif', word: 'Barley Water Co.' },
    snarl: { bg: '#121212', fg: '#d9f24a', accent: '#ff3b30', sub: 'ENERGY', subColor: '#ffffff', font: 'italic 900 {s}px Impact, "Arial Black", sans-serif', word: 'SNARL' },
    hendry: { bg: '#1f3a6b', fg: '#ffffff', accent: '#e8c66a', sub: 'STRINGERS', font: 'bold {s}px "Trebuchet MS", sans-serif', word: 'HENDRY' },
    graphite: { bg: '#2b2f33', fg: '#ff7a1a', accent: '#d7dadd', sub: 'DIRECT', font: '900 {s}px "Segoe UI", Arial, sans-serif', word: 'GRAPHITE' },
    calm: { bg: '#cdeee7', fg: '#1d6b63', accent: '#5fae5a', font: 'bold {s}px "Trebuchet MS", sans-serif', word: 'calm pond' }
  };
  const SPONSOR_ORDER = ['barley', 'snarl', 'hendry', 'graphite', 'calm'];
  // Who has their name painted on the court at each venue
  const VENUE_SPONSOR = { club: 'barley', council: 'graphite', leisure: 'calm', invitational: 'hendry', slam: 'snarl' };
  // A sponsor's mark, centred on (cx, cy), radius r
  function sponsorMark(g, id, cx, cy, r, fg, acc) {
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (id === 'barley') {
      // A barley ear in an oval
      g.strokeStyle = fg;
      g.lineWidth = r * 0.12;
      g.beginPath();
      g.ellipse(cx, cy, r * 0.74, r, 0, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(cx, cy + r * 0.72);
      g.lineTo(cx, cy - r * 0.6);
      g.stroke();
      g.fillStyle = acc;
      for (let i = 0; i < 4; i++) {
        const y = cy - r * 0.48 + i * r * 0.27;
        [-1, 1].forEach((sd) => {
          g.beginPath();
          g.ellipse(cx + sd * r * 0.16, y, r * 0.11, r * 0.2, sd * 0.55, 0, Math.PI * 2);
          g.fill();
        });
      }
    } else if (id === 'snarl') {
      // A lightning bolt between two fangs
      g.fillStyle = fg;
      const P = [[0.2, -1], [-0.5, 0.12], [-0.06, 0.12], [-0.24, 1], [0.5, -0.18], [0.06, -0.18]];
      g.beginPath();
      P.forEach((q, i) => (i ? g.lineTo(cx + q[0] * r, cy + q[1] * r) : g.moveTo(cx + q[0] * r, cy + q[1] * r)));
      g.closePath();
      g.fill();
      g.fillStyle = acc;
      [-1, 1].forEach((sd) => {
        g.beginPath();
        g.moveTo(cx + sd * r * 0.62, cy - r * 0.55);
        g.lineTo(cx + sd * r * 0.92, cy - r * 0.55);
        g.lineTo(cx + sd * r * 0.77, cy - r * 0.05);
        g.fill();
      });
    } else if (id === 'hendry') {
      // A racket face, strung
      g.strokeStyle = fg;
      g.lineWidth = r * 0.14;
      g.beginPath();
      g.ellipse(cx, cy - r * 0.12, r * 0.62, r * 0.8, 0, 0, Math.PI * 2);
      g.stroke();
      g.save();
      g.beginPath();
      g.ellipse(cx, cy - r * 0.12, r * 0.56, r * 0.74, 0, 0, Math.PI * 2);
      g.clip();
      g.strokeStyle = acc;
      g.lineWidth = r * 0.06;
      for (let i = -3; i <= 3; i++) {
        g.beginPath();
        g.moveTo(cx + i * r * 0.17, cy - r);
        g.lineTo(cx + i * r * 0.17, cy + r);
        g.moveTo(cx - r, cy - r * 0.12 + i * r * 0.2);
        g.lineTo(cx + r, cy - r * 0.12 + i * r * 0.2);
        g.stroke();
      }
      g.restore();
      g.strokeStyle = fg;
      g.lineWidth = r * 0.16;
      g.beginPath();
      g.moveTo(cx, cy + r * 0.68);
      g.lineTo(cx, cy + r * 1.05);
      g.stroke();
    } else if (id === 'graphite') {
      // A hexagon in a hexagon
      const hex = (rr, fill) => {
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + i * Math.PI / 3;
          if (i) g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        g.closePath();
        if (fill) g.fill(); else g.stroke();
      };
      g.strokeStyle = fg;
      g.lineWidth = r * 0.16;
      hex(r * 0.92, false);
      g.fillStyle = acc;
      hex(r * 0.4, true);
    } else if (id === 'calm') {
      // Ripples round a lily pad
      g.strokeStyle = fg;
      g.lineWidth = r * 0.1;
      [0.78, 1.0].forEach((k) => {
        g.beginPath();
        g.ellipse(cx, cy + r * 0.15, r * k, r * k * 0.5, 0, Math.PI * 1.05, Math.PI * 1.95);
        g.stroke();
      });
      g.fillStyle = acc;
      g.beginPath();
      g.moveTo(cx, cy + r * 0.2);
      g.arc(cx, cy + r * 0.2, r * 0.48, -0.25, Math.PI * 2 - 0.65);
      g.closePath();
      g.fill();
    }
    g.restore();
  }
  // A sponsor's board: background, mark and words as one centred group fitted to the panel.
  // paint: a single colour and no background (painted on the court).
  function drawSponsorArt(g, id, x, y, w, h, paint) {
    const sp = SPONSORS[id];
    const fg = paint || sp.fg;
    const acc = paint || sp.accent;
    if (!paint) {
      g.fillStyle = sp.bg;
      g.fillRect(x, y, w, h);
    }
    const r = h * 0.34;
    const fs = h * (sp.sub ? 0.44 : 0.5);
    const sfs = h * 0.19;
    const setF = (px) => { g.font = sp.font.replace('{s}', px.toFixed(1)); };
    const subFont = 'bold ' + sfs.toFixed(1) + 'px "Trebuchet MS", sans-serif';
    const subText = sp.sub ? sp.sub.split('').join('\u2009') : '';
    setF(fs);
    const tw = g.measureText(sp.word).width;
    g.font = subFont;
    const sw = sp.sub ? g.measureText(subText).width : 0;
    const gap = r * 0.55;
    const gw = 2 * r + gap + Math.max(tw, sw);
    const k = Math.min(1, (w * 0.9) / gw);
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.scale(k, k);
    const left = -gw / 2;
    sponsorMark(g, id, left + r, 0, r, fg, acc);
    const tx = left + 2 * r + gap;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    setF(fs);
    g.fillStyle = fg;
    g.fillText(sp.word, tx, sp.sub ? -h * 0.1 : h * 0.02);
    if (sp.sub) {
      g.font = subFont;
      g.fillStyle = paint || sp.subColor || acc;
      g.fillText(subText, tx + 1, h * 0.25);
    }
    g.restore();
  }
  // Board art, rendered once per sponsor and size
  const boardArt = {};
  function boardPanel(id, w, h) {
    const key = id + ':' + Math.round(w) + 'x' + Math.round(h) + ':' + scale;
    if (!boardArt[key]) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w * scale * 2));
      c.height = Math.max(1, Math.ceil(h * scale * 2));
      const g = c.getContext('2d');
      g.scale(c.width / w, c.height / h);
      drawSponsorArt(g, id, 0, 0, w, h);
      boardArt[key] = c;
    }
    return boardArt[key];
  }
  // A whole-board message across one panel
  function boardMessage(ctx, x, y, w, h, bg, fg, text, markId) {
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    let tx = x + w / 2;
    if (markId) {
      sponsorMark(ctx, markId, x + h * 0.6, y + h / 2, h * 0.3, fg, SPONSORS[markId].accent);
      tx += h * 0.35;
    }
    ctx.font = (h * 0.56).toFixed(1) + 'px "Lilita One", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fg;
    ctx.fillText(text, tx, y + h * 0.53, Math.max(10, w - (markId ? h * 1.3 : h * 0.4)));
  }
  // The far boards, drawn live. The big venues have LED boards: the ads rotate, and they react to the match.
  // Smaller venues have painted boards that never change.
  function drawBoards(ctx) {
    const G = bgCache && bgCache.geo;
    if (!G || !G.boards || !M) return;
    const B = G.boards;
    const pw = B.w / B.n;
    const led = G.V.screen;
    const t = M.time;
    const lp = M.lastPoint;
    const recent = lp && t - lp.t < 2.6;
    let take = null;
    if (led) {
      if (tantrumOnCourt()) take = 'breathe';
      else if (M.celeb) take = 'celeb';
      else if (recent && (lp.reason === 'ace' || lp.reason === 'overturnedAce')) take = 'ace';
    }
    const cycle = led ? t / 9 : 0;
    const rot = Math.floor(cycle);
    const wipe = led && !reduceMotion ? clamp((cycle - rot) * 9 / 0.35, 0, 1) : 1;
    const flash = reduceMotion || Math.sin(t * 12) > 0;
    for (let i = 0; i < B.n; i++) {
      const x = B.x + i * pw;
      if (take === 'breathe') boardMessage(ctx, x, B.y, pw, B.h, '#cdeee7', '#1d6b63', Math.floor(t / 1.6) % 2 ? 'AND OUT' : 'BREATHE IN', 'calm');
      else if (take === 'ace') boardMessage(ctx, x, B.y, pw, B.h, '#05080a', flash ? '#d9f24a' : '#7d8c2a', i % 2 ? lp.mph + ' MPH' : 'ACE');
      else if (take === 'celeb') {
        const id = SPONSOR_ORDER[(i + Math.floor(t * 3)) % 5];
        boardMessage(ctx, x, B.y, pw, B.h, SPONSORS[id].bg, SPONSORS[id].fg, 'WHAT A SHOT');
      } else if (led && M.rage >= 0.8 && i === Math.floor(B.n / 2)) {
        // Snarl Energy buys the middle board whenever you are about to blow
        boardMessage(ctx, x, B.y, pw, B.h, '#121212', flash ? '#d9f24a' : '#ff3b30', 'LET IT OUT', 'snarl');
      } else {
        const id = SPONSOR_ORDER[(i + 1 + rot) % 5];
        ctx.drawImage(boardPanel(id, pw, B.h), x, B.y, pw, B.h);
        if (wipe < 1) {
          // The old ad scrolls away under the new one
          const old = SPONSOR_ORDER[(i + rot) % 5];
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, B.y + B.h * wipe, pw, B.h * (1 - wipe));
          ctx.clip();
          ctx.drawImage(boardPanel(old, pw, B.h), x, B.y, pw, B.h);
          ctx.restore();
        }
      }
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x - 0.5, B.y, 1, B.h);
    }
    if (led) {
      // The wave lights the boards as it passes
      if (M.waveT >= 0 && !reduceMotion) {
        const c = M.waveT / 2.6;
        for (let i = 0; i < B.n; i++) {
          const a = Math.exp(-Math.pow(((i + 0.5) / B.n - c) * 5, 2)) * 0.45;
          if (a > 0.02) {
            ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
            ctx.fillRect(B.x + i * pw, B.y, pw, B.h);
          }
        }
      }
      // LED rows
      ctx.fillStyle = 'rgba(0,0,0,0.13)';
      for (let yy = B.y + 1; yy < B.y + B.h; yy += 2) ctx.fillRect(B.x, yy, B.w, 0.7);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(B.x, B.y, B.w, Math.max(1, B.h * 0.07));
  }
  const FAN_SIGNS = {
    calm: ['BREATHE', 'NOT THE RACKET', 'CALM DOWN, DEAR', 'THINK OF THE RACKETS'],
    wild: ['WHAT A SHOT', 'MARRY ME', 'GREATEST EVER', 'DO THE WORM'],
    any: ['HI MUM', '5 RACKETS LEFT?', 'I CAME FOR THE MELTDOWN', 'GRANDAD SAYS HI', 'BOOK HIM, UMP']
  };
  const SIGN_CARDS = ['#fbf8ee', '#fbf8ee', '#ffe45c', '#ffd1dc', '#cfe8ff', '#f3e3c3'];
  const SIGN_INKS = ['#c8102e', '#1f3a6b', '#1a1a1a', '#0f6b3a', '#6b3fa0'];
  const SIGN_FONT = '"Marker Felt", "Segoe Print", "Comic Sans MS", "Bradley Hand", cursive';
  // Words split over at most two lines, as someone with a marker pen would
  function signLines(text) {
    const words = text.split(' ');
    if (words.length < 2 || text.length < 11) return [text];
    let best = [text];
    let bestW = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const w = Math.max(a.length, b.length);
      if (w < bestW) { bestW = w; best = [a, b]; }
    }
    return best;
  }
  // A cardboard sign held above the head, facing in towards the court.
  // (cx, cy) is the middle of its bottom edge; s is pixels per metre at that spot.
  function drawCrowdSign(ctx, f, cx, cy, s, text, t, sh, bw) {
    const sw = 0.95 * s;
    const lines = signLines(text);
    const sh2 = (lines.length > 1 ? 0.62 : 0.46) * s;
    const sway = reduceMotion ? 0 : Math.sin(t * 2.6 + f.phase) * 0.035;
    const lift = f.stick ? 0.28 * s : 0;
    // Arms first: two hands on the bottom corners, or one hand on the stick
    ctx.strokeStyle = f.skin;
    ctx.lineWidth = Math.max(1, 0.06 * s);
    ctx.lineCap = 'round';
    const grips = f.stick ? [{ x: cx, y: cy + lift * 0.6 }] : [{ x: cx - sw * 0.38, y: cy - 0.03 * s }, { x: cx + sw * 0.38, y: cy - 0.03 * s }];
    grips.forEach((g, i) => {
      ctx.beginPath();
      ctx.moveTo(sh.x + (grips.length > 1 ? (i ? 1 : -1) : 0.4) * bw * 0.45, sh.y);
      ctx.lineTo(g.x, g.y);
      ctx.stroke();
    });
    ctx.save();
    ctx.translate(cx, cy - lift);
    ctx.rotate(f.tilt + sway);
    // Angled towards the court: a little narrower, and skewed by which stand it is in
    ctx.transform(0.86, f.sg * 0.1, 0, 1, 0, 0);
    if (f.stick) {
      ctx.fillStyle = '#a0662f';
      ctx.fillRect(-0.025 * s, -0.05 * s, 0.05 * s, lift + 0.12 * s);
    }
    // The board: slightly uneven corners, a shadow, a darker edge
    const w0 = f.wobble;
    const pts = [
      [-sw / 2 + w0[0] * 0.03 * s, -sh2], [sw / 2 - w0[1] * 0.03 * s, -sh2 + w0[2] * 0.02 * s],
      [sw / 2, 0], [-sw / 2, -w0[3] * 0.02 * s]
    ];
    const path = (dx, dy) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0] + dx, p[1] + dy) : ctx.moveTo(p[0] + dx, p[1] + dy)));
      ctx.closePath();
    };
    path(0.04 * s, 0.05 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();
    path(0, 0);
    ctx.fillStyle = f.card;
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,20,0.35)';
    ctx.lineWidth = Math.max(1, 0.015 * s);
    ctx.stroke();
    // A touch of light across the top of the card
    const gl = ctx.createLinearGradient(0, -sh2, 0, 0);
    gl.addColorStop(0, 'rgba(255,255,255,0.25)');
    gl.addColorStop(1, 'rgba(0,0,0,0.06)');
    ctx.fillStyle = gl;
    path(0, 0);
    ctx.fill();
    // Hand lettering in marker, sized to fit
    ctx.fillStyle = f.ink;
    ctx.strokeStyle = f.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const longest = lines.reduce((a, b) => (a.length > b.length ? a : b));
    let fs = (lines.length > 1 ? 0.22 : 0.26) * s;
    ctx.font = 'bold ' + Math.round(fs) + 'px ' + SIGN_FONT;
    const fit = (sw * 0.84) / Math.max(1, ctx.measureText(longest).width);
    if (fit < 1) {
      fs *= fit;
      ctx.font = 'bold ' + Math.max(5, Math.round(fs)) + 'px ' + SIGN_FONT;
    }
    const lh = fs * 1.05;
    const y0 = -sh2 / 2 - (lines.length - 1) * lh / 2;
    lines.forEach((l, i) => ctx.fillText(l, 0, y0 + i * lh));
    // A flourish: an underline, a hand-drawn border, or hearts
    ctx.lineWidth = Math.max(1, 0.025 * s);
    if (f.deco === 1) {
      const uw = Math.min(sw * 0.7, ctx.measureText(lines[lines.length - 1]).width);
      ctx.beginPath();
      ctx.moveTo(-uw / 2, y0 + (lines.length - 1) * lh + fs * 0.6);
      ctx.quadraticCurveTo(0, y0 + (lines.length - 1) * lh + fs * 0.8, uw / 2, y0 + (lines.length - 1) * lh + fs * 0.55);
      ctx.stroke();
    } else if (f.deco === 2) {
      ctx.beginPath();
      ctx.rect(-sw / 2 + 0.05 * s, -sh2 + 0.05 * s, sw - 0.1 * s, sh2 - 0.1 * s);
      ctx.stroke();
    } else if (f.deco === 3 && s > 30) {
      const heart = (hx, hy, r) => {
        ctx.beginPath();
        ctx.moveTo(hx, hy + r * 0.9);
        ctx.bezierCurveTo(hx - r * 1.4, hy - r * 0.2, hx - r * 0.6, hy - r * 1.2, hx, hy - r * 0.3);
        ctx.bezierCurveTo(hx + r * 0.6, hy - r * 1.2, hx + r * 1.4, hy - r * 0.2, hx, hy + r * 0.9);
        ctx.fill();
      };
      heart(-sw * 0.4, -sh2 * 0.78, 0.05 * s);
      heart(sw * 0.4, -sh2 * 0.22, 0.05 * s);
    }
    ctx.restore();
    // Fingers over the edge of the card
    if (!f.stick) {
      ctx.fillStyle = f.skin;
      grips.forEach((g) => {
        ctx.beginPath();
        ctx.arc(g.x, g.y, Math.max(1, 0.05 * s), 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // Static scenery (stands, crowd, boards, court, lines, umpire chair) is drawn once per match and size.
  // The club tea hut, beside the court on the right by the net: white weatherboard, a pitched green roof, a serving
  // hatch with a striped awning and an urn, a TEA sign on the ridge, bunting, and a queue
  const TEA_HUT = { x0: 6.6, x1: 8.3, y0: 14.6, y1: 16.2, wall: 2.2, ridge: 3.0 };
  function drawTeaHut(ctx, rng) {
    const T = TEA_HUT;
    const ym = (T.y0 + T.y1) / 2;
    const wall = '#efe6cf';
    const boards = (x0, y0, x1, y1) => {
      ctx.strokeStyle = 'rgba(90,70,40,0.22)';
      ctx.lineWidth = 1;
      for (let z = 0.25; z < T.wall; z += 0.25) {
        const a = proj(x0, y0, z);
        const b = proj(x1, y1, z);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    };
    // The gable end facing the court, with the door
    quad(ctx, [[T.x0, T.y0, 0], [T.x0, T.y1, 0], [T.x0, T.y1, T.wall], [T.x0, T.y0, T.wall]], shadeHex(wall, -0.06));
    quad(ctx, [[T.x0, T.y0, T.wall], [T.x0, T.y1, T.wall], [T.x0, ym, T.ridge], [T.x0, ym, T.ridge]], shadeHex(wall, -0.06));
    boards(T.x0, T.y0, T.x0, T.y1);
    quad(ctx, [[T.x0 - 0.01, ym - 0.05, 0], [T.x0 - 0.01, ym + 0.45, 0], [T.x0 - 0.01, ym + 0.45, 1.8], [T.x0 - 0.01, ym - 0.05, 1.8]], '#5d4128');
    // The front, facing you, with the serving hatch
    quad(ctx, [[T.x0, T.y0, 0], [T.x1, T.y0, 0], [T.x1, T.y0, T.wall], [T.x0, T.y0, T.wall]], wall);
    boards(T.x0, T.y0, T.x1, T.y0);
    const h0 = T.x0 + 0.3;
    const h1 = T.x1 - 0.3;
    quad(ctx, [[h0, T.y0 - 0.01, 0.95], [h1, T.y0 - 0.01, 0.95], [h1, T.y0 - 0.01, 1.85], [h0, T.y0 - 0.01, 1.85]], '#3b2a1c');
    // Inside: shelves and a hint of the tea lady
    quad(ctx, [[h0 + 0.1, T.y0 - 0.02, 1.45], [h1 - 0.1, T.y0 - 0.02, 1.45], [h1 - 0.1, T.y0 - 0.02, 1.5], [h0 + 0.1, T.y0 - 0.02, 1.5]], '#8a5d33');
    const lady = proj((h0 + h1) / 2 + 0.25, T.y0 + 0.2, 1.42);
    ctx.fillStyle = '#e8c3a0';
    ctx.beginPath();
    ctx.arc(lady.x, lady.y, 0.12 * lady.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9d9d4';
    ctx.beginPath();
    ctx.arc(lady.x, lady.y - 0.05 * lady.s, 0.12 * lady.s, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#c8102e';
    ctx.fillRect(lady.x - 0.16 * lady.s, lady.y + 0.12 * lady.s, 0.32 * lady.s, 0.3 * lady.s);
    // Counter, urn and cups
    quad(ctx, [[h0, T.y0 - 0.01, 0.95], [h1, T.y0 - 0.01, 0.95], [h1, T.y0 - 0.32, 0.95], [h0, T.y0 - 0.32, 0.95]], '#9a6a3c');
    quad(ctx, [[h0, T.y0 - 0.32, 0.85], [h1, T.y0 - 0.32, 0.85], [h1, T.y0 - 0.32, 0.95], [h0, T.y0 - 0.32, 0.95]], '#6b4628');
    const u0 = proj(h0 + 0.25, T.y0 - 0.15, 0.95);
    const u1 = proj(h0 + 0.25, T.y0 - 0.15, 1.38);
    ctx.fillStyle = '#c9ccd1';
    roundRect(ctx, u0.x - 0.13 * u0.s, u1.y, 0.26 * u0.s, u0.y - u1.y, 0.04 * u0.s);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(u0.x - 0.09 * u0.s, u1.y + 2, 0.05 * u0.s, u0.y - u1.y - 4);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(u0.x + 0.12 * u0.s, u0.y - 0.16 * u0.s, 0.06 * u0.s, 0.03 * u0.s);
    for (let i = 0; i < 4; i++) {
      const c0 = proj(h0 + 0.65 + i * 0.22, T.y0 - 0.18, 0.95);
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(c0.x - 0.05 * c0.s, c0.y - 0.1 * c0.s, 0.1 * c0.s, 0.1 * c0.s);
    }
    // Striped awning over the hatch
    const stripes = 9;
    for (let i = 0; i < stripes; i++) {
      const xa = lerp(h0 - 0.12, h1 + 0.12, i / stripes);
      const xb = lerp(h0 - 0.12, h1 + 0.12, (i + 1) / stripes);
      quad(ctx, [[xa, T.y0, 2.02], [xb, T.y0, 2.02], [xb, T.y0 - 0.65, 1.72], [xa, T.y0 - 0.65, 1.72]], i % 2 ? '#f4f1e6' : '#c8102e');
    }
    // Scalloped edge of the awning
    for (let i = 0; i < stripes; i++) {
      const c0 = proj(lerp(h0 - 0.12, h1 + 0.12, (i + 0.5) / stripes), T.y0 - 0.65, 1.72);
      ctx.fillStyle = i % 2 ? '#f4f1e6' : '#c8102e';
      ctx.beginPath();
      ctx.arc(c0.x, c0.y, 0.1 * c0.s, 0, Math.PI);
      ctx.fill();
    }
    // Pitched roof: the front slope, and the white fascia up the gable
    quad(ctx, [[T.x0 - 0.25, T.y0 - 0.25, T.wall - 0.05], [T.x1 + 0.25, T.y0 - 0.25, T.wall - 0.05], [T.x1 + 0.25, ym, T.ridge + 0.02], [T.x0 - 0.25, ym, T.ridge + 0.02]], '#2f5a2a');
    quad(ctx, [[T.x0 - 0.25, T.y0 - 0.25, T.wall - 0.05], [T.x1 + 0.25, T.y0 - 0.25, T.wall - 0.05], [T.x1 + 0.25, T.y0 - 0.25, T.wall - 0.15], [T.x0 - 0.25, T.y0 - 0.25, T.wall - 0.15]], '#f4f1e6');
    quad(ctx, [[T.x0 - 0.25, T.y0 - 0.25, T.wall - 0.05], [T.x0 - 0.25, ym, T.ridge + 0.02], [T.x0 - 0.25, ym, T.ridge - 0.08], [T.x0 - 0.25, T.y0 - 0.25, T.wall - 0.15]], '#f4f1e6');
    quad(ctx, [[T.x0 - 0.25, ym, T.ridge + 0.02], [T.x0 - 0.25, T.y1 + 0.25, T.wall - 0.05], [T.x0 - 0.25, T.y1 + 0.25, T.wall - 0.15], [T.x0 - 0.25, ym, T.ridge - 0.08]], '#f4f1e6');
    // Bunting along the front eave
    const flag = ['#c8102e', '#f4f1e6', '#1f3a6b', '#f2c14e'];
    for (let i = 0; i < 10; i++) {
      const x = lerp(T.x0 - 0.2, T.x1 + 0.2, (i + 0.5) / 10);
      const a = proj(x - 0.09, T.y0 - 0.27, T.wall - 0.12);
      const b = proj(x + 0.09, T.y0 - 0.27, T.wall - 0.12);
      const c = proj(x, T.y0 - 0.27, T.wall - 0.34);
      ctx.fillStyle = flag[i % 4];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.fill();
    }
    // The TEA sign on the ridge, facing you
    const sb = proj(T.x0 + 0.3, ym, T.ridge - 0.02);
    const st = proj(T.x1 - 0.3, ym, T.ridge + 0.62);
    ctx.fillStyle = '#f4ecd2';
    roundRect(ctx, sb.x, st.y, st.x - sb.x, sb.y - st.y, 0.08 * sb.s);
    ctx.fill();
    ctx.strokeStyle = '#7a2b2b';
    ctx.lineWidth = Math.max(1, 0.05 * sb.s);
    ctx.stroke();
    ctx.font = Math.round((sb.y - st.y) * 0.78) + 'px "Lilita One", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7a2b2b';
    ctx.fillText('TEA', (sb.x + st.x) / 2, st.y + (sb.y - st.y) * 0.56);
    // A customer at the hatch
    [[T.x0 + 0.95, T.y0 - 0.75, '#d94f7a']].forEach((q, i) => {
      drawCrewPerson(ctx, q[0], q[1], { pose: 'stand', shirt: q[2], trousers: '#3a3a40', skin: CROWD_SKINS[(i * 2 + 2) % CROWD_SKINS.length], hat: i === 1 ? 'panama' : 'cap', capColor: '#e9d8a6' });
    });
  }
  function buildBackground(surfaceKey, crowdSeed) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
    const S = SURFACES[surfaceKey];
    const rng = makeLCG(crowdSeed);
    const cc = document.createElement('canvas');
    cc.width = canvas.width;
    cc.height = canvas.height;
    const cctx = cc.getContext('2d');
    cctx.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
    // The same crowd turned to watch the far end: the side stands show the backs of their heads.
    // drawCrowd blends between the two as the ball goes up and down the court.
    // Props that stand in front of the stands (the tea hut) go on their own layer, drawn after the crowd
    const fgc = document.createElement('canvas');
    fgc.width = canvas.width;
    fgc.height = canvas.height;
    const fgx = fgc.getContext('2d');
    fgx.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
    const ccFar = document.createElement('canvas');
    ccFar.width = canvas.width;
    ccFar.height = canvas.height;
    const cfx = ccFar.getContext('2d');
    cfx.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
    const paintBoth = (x, y, r, side, B) => {
      const rec = [];
      paintSpectator(cctx, x, y, r, V, () => { const v = rng(); rec.push(v); return v; }, 'near', B);
      let ri = 0;
      paintSpectator(cfx, x, y, r, V, () => rec[ri++], side ? 'far' : 'near', B);
    };
    // A seated body in the stands, in world space: hips on the seat at (x, y, z + 0.46), facing along (fx, fy).
    // Knees come forward over the front of the seat and the feet rest on the step. The row in front hides the shins.
    const seatedBody = (x, y, z, fx, fy) => {
      const head = proj(x, y, z + 1.08);
      const legs = [-1, 1].map((sd) => {
        // Sideways from the hips: across the facing direction
        const ox = -fy * sd * 0.1;
        const oy = fx * sd * 0.1;
        return [proj(x + ox + fx * 0.05, y + oy + fy * 0.05, z + 0.46), proj(x + ox + fx * 0.4, y + oy + fy * 0.4, z + 0.5), proj(x + ox * 1.15 + fx * 0.44, y + oy * 1.15 + fy * 0.44, z + 0.02)];
      });
      // Far leg first: the one higher up the screen
      legs.sort((a, b) => a[1].y - b[1].y);
      // Which way the face turns on screen: towards the court for the side stands
      const ahead = proj(x + fx, y + fy, z + 1.08);
      return { s: head.s, head: head, sh: proj(x, y, z + 0.88), hip: proj(x, y, z + 0.46), legs: legs, face: fy ? 0 : Math.sign(ahead.x - head.x) };
    };

    const VK = venueKey(M.cfg);
    const V = VENUES[VK];
    // A career final is the evening session: dusk at the small outdoor venues, floodlights at the big two.
    // The leisure centre is indoors and looks the same.
    const session = M.cfg.mode === 'career' && M.cfg.round === 2 && VK !== 'leisure' ? (V.screen ? 'night' : 'dusk') : null;
    const skyCols = session === 'night' ? (VK === 'slam' ? ['#03060d', '#121c30'] : ['#050b18', '#1b2a48']) : session === 'dusk' ? ['#d8704a', '#fbd39a'] : V.sky;
    // The ground is one rectangle: a far stand behind the far baseline and a stand down each side.
    // Tier k sits at the same height on all three, so the tiers turn the corners together.
    const N = V.tiers;
    const D = V.depth;
    const YF = 30;                                // front wall of the far stand, 6 m behind the baseline
    const outer = V.x0 + N * D;                   // outside edge of the side stands
    const tierZ = (k) => V.wallH + k * V.rise;
    const rimZ = tierZ(N - 1);
    const top = proj(0, YF + N * D, rimZ).y;      // the far rim, on screen
    const by = proj(0, YF, V.wallH).y;            // the top of the far boards, on screen
    // Sky, or the hall wall indoors
    const skyEnd = proj(0, YF, 0).y;
    const sky = ctx.createLinearGradient(0, -BY, 0, skyEnd);
    sky.addColorStop(0, skyCols[0]);
    sky.addColorStop(1, skyCols[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(-BX, -BY, W + 2 * BX, skyEnd + BY + 2);
    const span = (fn) => { for (let x = -BX; x < W + BX; ) x = fn(x); };
    if (session === 'night' && VK !== 'slam') {
      // Stars
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + rng() * 0.6).toFixed(2) + ')';
        ctx.fillRect(-BX + rng() * (W + 2 * BX), -BY + rng() * (skyEnd + BY) * 0.6, 1.5, 1.5);
      }
    }
    // Night darkens the stands and the sky but not the floodlit court; dusk warms everything
    const applySession = () => {
      if (!session) return;
      const tint = session === 'night' ? 'rgba(6,10,32,0.5)' : 'rgba(255,110,40,0.13)';
      const floor = [[-V.x0, V.y0], [V.x0, V.y0], [V.x0, YF], [-V.x0, YF]].map((q) => proj(q[0], q[1], 0));
      ctx.save();
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.rect(-BX, -BY, W + 2 * BX, H + 2 * BY);
      if (session === 'night') floor.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
      [cctx, cfx, fgx].forEach((g) => {
        g.save();
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = tint;
        g.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
        g.restore();
      });
      if (session === 'night') {
        // Floodlight banks on the rim, with a glow
        const outerX = V.x0 + N * D;
        [[-outerX, YF + N * D], [outerX, YF + N * D], [-outerX, 16], [outerX, 16]].forEach((q) => {
          const b = proj(q[0], q[1], rimZ);
          const t = proj(q[0], q[1], rimZ + 4);
          ctx.strokeStyle = '#3a4048';
          ctx.lineWidth = Math.max(2, 0.12 * b.s);
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(t.x, t.y);
          ctx.stroke();
          const w = 1.6 * t.s;
          const glow = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, w * 2.4);
          glow.addColorStop(0, 'rgba(255,250,225,0.75)');
          glow.addColorStop(1, 'rgba(255,250,225,0)');
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = glow;
          ctx.fillRect(t.x - w * 2.4, t.y - w * 2.4, w * 4.8, w * 4.8);
          ctx.restore();
          ctx.fillStyle = '#fffbe8';
          ctx.fillRect(t.x - w / 2, t.y - w * 0.3, w, w * 0.45);
        });
      }
    };
    // Distant scenery behind each venue, paler with distance
    if (!session || session === 'dusk') {
      const far = (col) => (session === 'dusk' ? shadeHex(col, -0.25) : col);
      if (VK === 'club' || VK === 'invitational') {
        // Rolling hills, two ranges, and a church spire on the far one
        [[top - 95, '#a9c9a0', 70], [top - 70, '#8fb886', 55]].forEach((hl, li) => {
          ctx.fillStyle = far(hl[1]);
          ctx.beginPath();
          ctx.moveTo(-BX, hl[0] + 80);
          for (let x = -BX; x <= W + BX; x += 40) ctx.lineTo(x, hl[0] - Math.sin(x / (180 + li * 70) + li * 2) * hl[2] * 0.4 - Math.sin(x / 61) * 6);
          ctx.lineTo(W + BX, hl[0] + 80);
          ctx.fill();
        });
        const cx = VK === 'club' ? 300 : 1000;
        const cy = top - 102 - Math.sin(cx / 180) * 28;
        ctx.fillStyle = far('#c9c3b0');
        ctx.fillRect(cx - 9, cy - 22, 18, 26);
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy - 22);
        ctx.lineTo(cx, cy - 52);
        ctx.lineTo(cx + 9, cy - 22);
        ctx.fill();
        if (VK === 'invitational') {
          // A manor house among the trees
          ctx.fillStyle = far('#e8dfc6');
          ctx.fillRect(250, top - 62, 120, 30);
          ctx.fillStyle = far('#7d8a8e');
          ctx.beginPath();
          ctx.moveTo(244, top - 62);
          ctx.lineTo(310, top - 82);
          ctx.lineTo(376, top - 62);
          ctx.fill();
          ctx.fillStyle = far('#5b6f7c');
          for (let i = 0; i < 6; i++) ctx.fillRect(258 + i * 18, top - 55, 8, 12);
        }
      } else if (VK === 'council') {
        // Tower blocks beyond the rooftops
        [[60, 120, 70], [260, 90, 60], [880, 140, 80], [1080, 100, 64], [1230, 120, 70]].forEach((tb) => {
          const x = tb[0];
          const h = tb[1];
          const w = tb[2];
          ctx.fillStyle = far('#9aa6b2');
          ctx.fillRect(x, top - 20 - h, w, h);
          ctx.fillStyle = far('#7d8994');
          ctx.fillRect(x + w * 0.75, top - 20 - h, w * 0.25, h);
          ctx.fillStyle = far('#c9d6e2');
          for (let yy = top - 12 - h; yy < top - 26; yy += 12) for (let xx = x + 6; xx < x + w * 0.7; xx += 12) if (rng() < 0.7) ctx.fillRect(xx, yy, 5, 6);
        });
      }
    }
    if (VK === 'club') {
      // Trees, a hedge behind the benches, and bunting
      span((x) => {
        const r = 22 + rng() * 26;
        ctx.fillStyle = rng() < 0.5 ? '#3d7a3a' : '#4a8a42';
        ctx.beginPath();
        ctx.arc(x, top - 18 - rng() * 30, r, 0, Math.PI * 2);
        ctx.fill();
        return x + r * 1.1;
      });
      // The clubhouse behind the hedge: white weatherboard, a green roof, and a flag
      {
        const hx = 800;
        const hw = 130;
        const hh = 44;
        const hb = top - 26;
        ctx.fillStyle = '#f4f1e6';
        ctx.fillRect(hx, hb - hh, hw, hh);
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        for (let yy = hb - hh + 6; yy < hb; yy += 6) ctx.fillRect(hx, yy, hw, 1);
        ctx.fillStyle = '#2f5a2a';
        ctx.beginPath();
        ctx.moveTo(hx - 10, hb - hh);
        ctx.lineTo(hx + hw + 10, hb - hh);
        ctx.lineTo(hx + hw - 24, hb - hh - 20);
        ctx.lineTo(hx + 24, hb - hh - 20);
        ctx.fill();
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = '#f4f1e6';
          ctx.fillRect(hx + 16 + i * 40, hb - hh + 9, 26, 18);
          ctx.fillStyle = '#3a5b73';
          ctx.fillRect(hx + 18 + i * 40, hb - hh + 11, 22, 14);
        }
        ctx.strokeStyle = '#e9e4d4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hx + hw / 2, hb - hh - 20);
        ctx.lineTo(hx + hw / 2, hb - hh - 50);
        ctx.stroke();
        ctx.fillStyle = '#c8102e';
        ctx.fillRect(hx + hw / 2 + 1, hb - hh - 50, 18, 11);
        ctx.fillStyle = '#f4f1e6';
        ctx.fillRect(hx + hw / 2 + 1, hb - hh - 46, 18, 3);
      }
      ctx.fillStyle = '#2f5a2a';
      ctx.fillRect(-BX, top - 34, W + 2 * BX, by - top + 34);
      ctx.fillStyle = 'rgba(80,140,60,0.5)';
      for (let i = 0; i < 260; i++) ctx.fillRect(-BX + rng() * (W + 2 * BX), top - 34 + rng() * (by - top + 30), 3, 3);
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-BX, top - 30);
      for (let x = -BX; x <= W + BX; x += 40) ctx.quadraticCurveTo(x + 20, top - 18, x + 40, top - 30);
      ctx.stroke();
      const flagCols = ['#c8102e', '#f4f1e6', '#1f3a6b', '#f2c14e'];
      for (let x = -BX, i = 0; x < W + BX; x += 20, i++) {
        const sag = Math.sin(((x + BX) % 40) / 40 * Math.PI) * 6;
        ctx.fillStyle = flagCols[i % 4];
        ctx.beginPath();
        ctx.moveTo(x, top - 30 + sag);
        ctx.lineTo(x + 12, top - 30 + sag);
        ctx.lineTo(x + 6, top - 18 + sag);
        ctx.fill();
      }
    } else if (VK === 'council') {
      // Rooftops over the fence
      span((x) => {
        const w = 60 + rng() * 70;
        const h = 22 + rng() * 26;
        ctx.fillStyle = rng() < 0.5 ? '#8a8f96' : '#9c8a7a';
        ctx.fillRect(x, top - h, w, h + 4);
        ctx.fillStyle = '#5c4a40';
        ctx.beginPath();
        ctx.moveTo(x - 4, top - h);
        ctx.lineTo(x + w / 2, top - h - 16);
        ctx.lineTo(x + w + 4, top - h);
        ctx.fill();
        return x + w + 6 + rng() * 20;
      });
    } else if (VK === 'leisure') {
      // A sports hall: lit ceiling, painted wall, banners and a basketball hoop
      ctx.fillStyle = '#4a4a46';
      ctx.fillRect(-BX, -BY, W + 2 * BX, top - 40 + BY);
      ctx.fillStyle = '#fffbe6';
      for (let x = -BX + 30; x < W + BX; x += 150) { ctx.fillRect(x, top - 66, 90, 7); ctx.fillRect(x + 30, top - 96, 60, 5); }
      ctx.fillStyle = '#9fb7d6';
      ctx.fillRect(-BX, top - 40, W + 2 * BX, 8);
      ctx.font = '15px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      [[330, 'GRIMSBY LEISURE CENTRE', '#c8102e'], [950, 'NO RUNNING ON POOLSIDE', '#1f3a6b']].forEach((b) => {
        ctx.fillStyle = b[2];
        ctx.fillRect(b[0] - 120, top - 30, 240, 22);
        ctx.fillStyle = '#f4f1e6';
        ctx.fillText(b[1], b[0], top - 19);
      });
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(626, top - 34, 28, 20);
      ctx.strokeStyle = '#ff7a1a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(640, top - 12, 8, 2.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (VK === 'invitational') {
      // A clock on the pavilion roof
      ctx.fillStyle = '#173827';
      ctx.fillRect(560, top - 34, 160, 34);
      ctx.fillStyle = '#f4f1e6';
      ctx.beginPath();
      ctx.arc(640, top - 30, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(640, top - 30);
      ctx.lineTo(640, top - 43);
      ctx.moveTo(640, top - 30);
      ctx.lineTo(649, top - 27);
      ctx.stroke();
    } else if (VK === 'slam') {
      // Floodlit roof canopy and the big scoreboard
      ctx.fillStyle = '#111c17';
      ctx.beginPath();
      ctx.moveTo(-BX, -BY);
      ctx.lineTo(W + BX, -BY);
      ctx.lineTo(W + BX, top - 30);
      ctx.quadraticCurveTo(640, top - 60, -BX, top - 30);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,250,220,0.9)';
      for (let x = -BX + 20; x < W + BX; x += 46) ctx.fillRect(x, top - 34 - Math.sin((x + BX) / (W + 2 * BX) * Math.PI) * 26, 14, 3);
      ctx.fillStyle = '#0a1410';
      ctx.fillRect(540, top - 26, 200, 24);
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#d9f24a';
      ctx.fillText('WIMBLEFORD  CENTRE COURT', 640, top - 14);
    }
    // Ground, out to the back of the stands
    ctx.fillStyle = S.outside;
    ctx.fillRect(-BX, proj(0, YF + N * D, 0).y, W + 2 * BX, H + BY);
    // Court surface
    quad(ctx, [[-C.dw, 0], [C.dw, 0], [C.dw, C.L], [-C.dw, C.L]], S.court);
    if (S.stripe !== S.court) {
      for (let i = 0; i < 16; i += 2) {
        const y0 = -3 + i * 2.2;
        quad(ctx, [[-C.dw - 2.5, y0], [C.dw + 2.5, y0], [C.dw + 2.5, y0 + 2.2], [-C.dw - 2.5, y0 + 2.2]], S.stripe);
      }
      quad(ctx, [[-C.dw - 9, -6], [-C.dw - 2.5, -6], [-C.dw - 2.5, 30], [-C.dw - 9, 30]], S.outside);
      quad(ctx, [[C.dw + 2.5, -6], [C.dw + 9, -6], [C.dw + 9, 30], [C.dw + 2.5, 30]], S.outside);
    }
    if (surfaceKey === 'clay') {
      for (let i = 0; i < 260; i++) {
        const p = proj(rng.range(-8, 8), rng.range(-4, 28));
        ctx.fillStyle = 'rgba(120,50,20,0.18)';
        ctx.fillRect(p.x, p.y, 2, 1);
      }
    }
    // Wear: worn grass behind the baselines, skid marks on clay, rubber scuffs on hard courts, a tired carpet
    const wearAt = (yBase, dir) => {
      for (let i = 0; i < 26; i++) {
        const wx = rng.range(-1.9, 1.9) * (0.4 + rng() * 0.6);
        const wy = yBase + dir * rng.range(-0.6, 1.8);
        const p = proj(wx, wy, 0);
        if (surfaceKey === 'grass') {
          ctx.fillStyle = 'rgba(150,135,70,' + (0.14 + rng() * 0.16).toFixed(2) + ')';
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, (0.35 + rng() * 0.5) * p.s, (0.1 + rng() * 0.12) * p.s, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (surfaceKey === 'clay') {
          const q = proj(wx + rng.range(-0.5, 0.5), wy + rng.range(-0.15, 0.15), 0);
          ctx.strokeStyle = 'rgba(235,165,115,' + (0.12 + rng() * 0.14).toFixed(2) + ')';
          ctx.lineWidth = Math.max(1, 0.06 * p.s);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        } else if (surfaceKey === 'hard') {
          // Rubber skids: short, flat curves that lie on the court in perspective, so they never read as doodles
          if (rng() < 0.45) continue;
          ctx.strokeStyle = 'rgba(15,20,30,' + (0.07 + rng() * 0.08).toFixed(2) + ')';
          ctx.lineWidth = Math.max(1, 0.035 * p.s);
          const a0 = rng() * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, (0.3 + rng() * 0.35) * p.s, (0.06 + rng() * 0.05) * p.s, 0, a0, a0 + 0.8 + rng() * 0.6);
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.05)';
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, (0.4 + rng() * 0.4) * p.s, 0.12 * p.s, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    wearAt(0, -1);
    wearAt(C.L, 1);
    // The surface itself. Clay is brushed in long passes across the court; hard courts have a gritty finish;
    // grass a fine grain.
    if (surfaceKey === 'clay') {
      for (let y = -3; y < 28; y += 0.32) {
        const a = proj(-C.dw - 2.5, y, 0);
        const b = proj(C.dw + 2.5, y, 0);
        ctx.strokeStyle = rng() < 0.5 ? 'rgba(255,200,160,0.05)' : 'rgba(110,45,20,0.05)';
        ctx.lineWidth = Math.max(1, 0.1 * a.s);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    } else if (surfaceKey === 'hard' || surfaceKey === 'indoor' || surfaceKey === 'grass') {
      const n = surfaceKey === 'grass' ? 900 : 1600;
      for (let i = 0; i < n; i++) {
        const q = proj(rng.range(-8, 8), rng.range(-4, 29), 0);
        ctx.fillStyle = surfaceKey === 'grass' ? (rng() < 0.5 ? 'rgba(170,220,120,0.09)' : 'rgba(20,60,20,0.08)') : (rng() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)');
        const r2 = Math.max(0.8, 0.025 * q.s);
        ctx.fillRect(q.x, q.y, r2, r2 * 0.6);
      }
    }
    // Lines
    const L = S.line;
    if (surfaceKey === 'clay') {
      // Clay lines are tapes laid on the surface: a soft shadow under each one
      const sh = 'rgba(90,35,15,0.28)';
      [[-C.dw, 0, C.dw, 0], [-C.dw, C.L, C.dw, C.L], [-C.dw, 0, -C.dw, C.L], [C.dw, 0, C.dw, C.L], [-C.hw, 0, -C.hw, C.L], [C.hw, 0, C.hw, C.L],
        [-C.hw, C.net - C.svc, C.hw, C.net - C.svc], [-C.hw, C.net + C.svc, C.hw, C.net + C.svc], [0, C.net - C.svc, 0, C.net + C.svc]].forEach((l) => {
        courtLine(ctx, l[0] + 0.03, l[1] + 0.04, l[2] + 0.03, l[3] + 0.04, sh);
      });
    }
    courtLine(ctx, -C.dw, 0, C.dw, 0, L);
    courtLine(ctx, -C.dw, C.L, C.dw, C.L, L);
    courtLine(ctx, -C.dw, 0, -C.dw, C.L, L);
    courtLine(ctx, C.dw, 0, C.dw, C.L, L);
    courtLine(ctx, -C.hw, 0, -C.hw, C.L, L);
    courtLine(ctx, C.hw, 0, C.hw, C.L, L);
    courtLine(ctx, -C.hw, C.net - C.svc, C.hw, C.net - C.svc, L);
    courtLine(ctx, -C.hw, C.net + C.svc, C.hw, C.net + C.svc, L);
    courtLine(ctx, 0, C.net - C.svc, 0, C.net + C.svc, L);
    courtLine(ctx, 0, 0, 0, 0.2, L);
    courtLine(ctx, 0, C.L - 0.2, 0, C.L, L);
    if (surfaceKey !== 'indoor') {
      // The net's shadow, falling right and away from you like the players' (the mesh lets some light through)
      quad(ctx, [[-6.4, C.net, 0], [6.4, C.net, 0], [6.4 + 0.55, C.net + 0.25, 0], [-6.4 + 0.55, C.net + 0.25, 0]], 'rgba(0,0,0,0.13)');
      quad(ctx, [[6.4 + 0.45, C.net + 0.2, 0], [6.4 + 0.6, C.net + 0.2, 0], [6.4 + 0.6, C.net + 0.27, 0], [6.4 + 0.45, C.net + 0.27, 0]], 'rgba(0,0,0,0.2)');
    }
    {
      // The tournament sponsor painted behind the far baseline, as at the real events
      const art = document.createElement('canvas');
      art.width = 480;
      art.height = 120;
      drawSponsorArt(art.getContext('2d'), VENUE_SPONSOR[VK], 0, 0, 480, 120, surfaceKey === 'clay' ? 'rgba(250,244,232,0.72)' : 'rgba(250,250,244,0.62)');
      const p00 = proj(-2.6, 27.8, 0);
      const p10 = proj(2.6, 27.8, 0);
      const p01 = proj(-2.6, 25.8, 0);
      ctx.save();
      ctx.transform((p10.x - p00.x) / 480, (p10.y - p00.y) / 480, (p01.x - p00.x) / 120, (p01.y - p00.y) / 120, p00.x, p00.y);
      ctx.drawImage(art, 0, 0);
      ctx.restore();
    }

    // The left stand's shadow across the ground and part of the court, with a soft edge
    if (V.sunK) {
      const reach = rimZ * V.sunK;
      [[0.13, 0], [0.11, 0.6]].forEach((band) => {
        const xn = -outer + reach + 1 - band[1];
        const xf = -outer + reach - 1 - band[1];
        quad(ctx, [[-outer, V.y0, 0], [xn, V.y0, 0], [xf, YF, 0], [-outer, YF, 0]], 'rgba(10,25,45,' + band[0] + ')');
      });
    }
    // Soft shadow where the ground meets the side walls and the far wall
    [0.16, 0.11, 0.07, 0.035].forEach((al, i) => {
      const w0 = V.x0 - i * 0.45;
      const w1 = V.x0 - (i + 1) * 0.45;
      const sh = 'rgba(0,0,0,' + al + ')';
      quad(ctx, [[-w0, V.y0, 0], [-w1, V.y0, 0], [-w1, YF - (i + 1) * 0.45, 0], [-w0, YF - i * 0.45, 0]], sh);
      quad(ctx, [[w1, V.y0, 0], [w0, V.y0, 0], [w0, YF - i * 0.45, 0], [w1, YF - (i + 1) * 0.45, 0]], sh);
      quad(ctx, [[-w0, YF - i * 0.45, 0], [w0, YF - i * 0.45, 0], [w1, YF - (i + 1) * 0.45, 0], [-w1, YF - (i + 1) * 0.45, 0]], sh);
    });
    // Seats, aisles and tunnels. Seats sit behind the crowd, so empty ones show as seats, not gaps.
    const prof = CROWD_PROFILE[VK] || CROWD_PROFILE.slam;
    const seatCol = prof.seat;
    const AISLE_Y = VK === 'club' ? [] : [3.6, 15.6, 25.2];
    const AISLE_X = VK === 'club' ? [] : [-5.2, 5.2];
    // A slatted bench along a tier at the club: seat at 0.46 m on legs, a plank face towards the court
    const benchSide = (xs, ya2, yb2, z, sg) => {
      const xf = xs - sg * 0.2;
      const xb = xs + sg * 0.22;
      for (let y = ya2 + 0.3; y < yb2; y += 1.8) {
        quad(ctx, [[xf + sg * 0.04, y, z], [xf + sg * 0.04, y + 0.06, z], [xf + sg * 0.04, y + 0.06, z + 0.42], [xf + sg * 0.04, y, z + 0.42]], '#4a3220');
      }
      quad(ctx, [[xf, ya2, z + 0.46], [xb, ya2, z + 0.46], [xb, yb2, z + 0.46], [xf, yb2, z + 0.46]], '#b88a56');
      quad(ctx, [[xf, ya2, z + 0.4], [xf, yb2, z + 0.4], [xf, yb2, z + 0.46], [xf, ya2, z + 0.46]], '#7a5232');
    };
    const benchFar = (xa2, xb2, yp, z) => {
      const yf = yp - 0.2;
      const yb = yp + 0.22;
      for (let x = xa2 + 0.3; x < xb2; x += 1.8) quad(ctx, [[x, yf + 0.04, z], [x + 0.06, yf + 0.04, z], [x + 0.06, yf + 0.04, z + 0.42], [x, yf + 0.04, z + 0.42]], '#4a3220');
      quad(ctx, [[xa2, yf, z + 0.46], [xb2, yf, z + 0.46], [xb2, yb, z + 0.46], [xa2, yb, z + 0.46]], '#b88a56');
      quad(ctx, [[xa2, yf, z + 0.4], [xb2, yf, z + 0.4], [xb2, yf, z + 0.46], [xa2, yf, z + 0.46]], '#7a5232');
    };
    const TUNNEL = V.screen ? [7.2, 9.2] : null;
    const inAisleY = (y, k) => AISLE_Y.some((a) => Math.abs(y - a) < 0.6) || (TUNNEL && k < 3 && y > TUNNEL[0] - 0.2 && y < TUNNEL[1] + 0.2);
    const seatSide = (x, y, z, sg) => {
      if (!seatCol) return;
      const bx = x + sg * 0.24;
      quad(ctx, [[bx, y - 0.21, z + 0.05], [bx, y + 0.21, z + 0.05], [bx, y + 0.21, z + 0.5], [bx, y - 0.21, z + 0.5]], seatCol);
      quad(ctx, [[bx, y - 0.21, z + 0.42], [bx, y + 0.21, z + 0.42], [bx, y + 0.21, z + 0.5], [bx, y - 0.21, z + 0.5]], 'rgba(255,255,255,0.18)');
    };
    const seatFar = (x, y, z) => {
      if (!seatCol) return;
      const by = y + 0.24;
      quad(ctx, [[x - 0.21, by, z + 0.05], [x + 0.21, by, z + 0.05], [x + 0.21, by, z + 0.5], [x - 0.21, by, z + 0.5]], seatCol);
      quad(ctx, [[x - 0.21, by, z + 0.42], [x + 0.21, by, z + 0.42], [x + 0.21, by, z + 0.5], [x - 0.21, by, z + 0.5]], 'rgba(255,255,255,0.18)');
    };
    // Side stands, back tier first. Each tier is a tread and the riser in front of it.
    const fans = [];
    if (V.backWall) quad(ctx, [[-outer, YF + N * D, rimZ], [outer, YF + N * D, rimZ], [outer, YF + N * D, rimZ + 9], [-outer, YF + N * D, rimZ + 9]], V.backWall);
    for (let k = N - 1; k >= 0; k--) {
      const ya = YF + k * D;
      const yc = YF + (k + 1) * D;
      const z = tierZ(k);
      const w = V.x0 + (k + 1) * D;
      quad(ctx, [[-w, ya, z], [w, ya, z], [w, yc, z], [-w, yc, z]], k % 2 ? V.tread : V.tread2);
      if (k > 0) quad(ctx, [[-w, ya, tierZ(k - 1)], [w, ya, tierZ(k - 1)], [w, ya, z], [-w, ya, z]], V.riser);
      // Steps up the aisles, lighter, with a handrail
      AISLE_X.forEach((ax) => {
        quad(ctx, [[ax - 0.5, ya, z], [ax + 0.5, ya, z], [ax + 0.5, yc, z], [ax - 0.5, yc, z]], 'rgba(255,255,255,0.14)');
        const ra = proj(ax + 0.52, ya, z + 0.9);
        const rb = proj(ax + 0.52, yc, z + 0.9 + V.rise);
        ctx.strokeStyle = 'rgba(220,220,215,0.7)';
        ctx.lineWidth = Math.max(1, 0.03 * ra.s);
        ctx.beginPath();
        ctx.moveTo(ra.x, ra.y);
        ctx.lineTo(rb.x, rb.y);
        ctx.stroke();
      });
      if (!seatCol) benchFar(-w + 0.2, w - 0.2, ya + 0.62 * D, z);
      for (let x = -w + 0.3; x <= w - 0.3; x += V.seat) {
        if (AISLE_X.some((ax) => Math.abs(x - ax) < 0.6)) continue;
        const yp = ya + 0.62 * D;
        seatFar(x, yp, z);
        if (rng() > V.density) continue;
        const hp = proj(x, yp, z + 1.08);
        paintBoth(hp.x, hp.y, 0.1 * hp.s, false, seatedBody(x, yp, z, 0, -1));
      }
    }
    // Its front wall carries the sponsor boards
    quad(ctx, [[-V.x0, YF, 0], [V.x0, YF, 0], [V.x0, YF, V.wallH], [-V.x0, YF, V.wallH]], V.board);
    quad(ctx, [[-V.x0, YF, V.wallH - 0.08], [V.x0, YF, V.wallH - 0.08], [V.x0, YF, V.wallH], [-V.x0, YF, V.wallH]], 'rgba(255,255,255,0.35)');
    // The sponsor boards themselves are drawn live (drawBoards), over this strip
    let boards;
    {
      const a = proj(-V.x0, YF, V.wallH);
      const b = proj(V.x0, YF, 0);
      boards = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, n: Math.max(1, Math.floor((2 * V.x0) / 3.6)) };
    }
    [-1, 1].forEach((sg) => {
      // Trees behind the club benches
      if (VK === 'club') {
        for (let y = YF + N * D + 2; y >= V.y0 - 4; y -= 3.2) {
          if (sg > 0 && y > YF) continue;   // keep the clubhouse in view
          const p = proj(sg * (12 + rng() * 3), y, 3 + rng() * 1.5);
          ctx.fillStyle = rng() < 0.5 ? '#3d7a3a' : '#467f3c';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 * p.s, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (V.backWall) {
        const xb = sg * (V.x0 + V.tiers * V.depth);
        const zt = tierZ(V.tiers - 1);
        quad(ctx, [[xb, V.y0, zt], [xb, YF + N * D, zt], [xb, YF + N * D, zt + 9], [xb, V.y0, zt + 9]], V.backWall);
      }
      for (let k = V.tiers - 1; k >= 0; k--) {
        const xa = sg * (V.x0 + k * V.depth);
        const xc = sg * (V.x0 + (k + 1) * V.depth);
        const z = tierZ(k);
        const ye = YF + k * D;
        quad(ctx, [[xa, V.y0, z], [xc, V.y0, z], [xc, ye, z], [xa, ye, z]], k % 2 ? V.tread : V.tread2);
        if (k > 0) quad(ctx, [[xa, V.y0, tierZ(k - 1)], [xa, ye, tierZ(k - 1)], [xa, ye, z], [xa, V.y0, z]], V.riser);
        // Aisle steps and handrails; at the big venues a tunnel through the lower tiers
        AISLE_Y.forEach((ay) => {
          quad(ctx, [[xa, ay - 0.5, z], [xc, ay - 0.5, z], [xc, ay + 0.5, z], [xa, ay + 0.5, z]], 'rgba(255,255,255,0.14)');
          const ra = proj(xa, ay + 0.52, z + 0.9);
          const rb = proj(xc, ay + 0.52, z + 0.9 + V.rise);
          ctx.strokeStyle = 'rgba(220,220,215,0.7)';
          ctx.lineWidth = Math.max(1, 0.03 * ra.s);
          ctx.beginPath();
          ctx.moveTo(ra.x, ra.y);
          ctx.lineTo(rb.x, rb.y);
          ctx.stroke();
        });
        if (TUNNEL && k < 3) quad(ctx, [[xa, TUNNEL[0], z], [xc, TUNNEL[0], z], [xc, TUNNEL[1], z], [xa, TUNNEL[1], z]], '#0c0f0d');
        if (!seatCol) benchSide(sg * (V.x0 + (k + 0.62) * V.depth), V.y0, ye, z, sg);
        // Spectators: tier 0 is the live front row, drawn every frame; the rest are painted once
        for (let y = ye - 0.3; y >= V.y0; y -= V.seat) {
          if (inAisleY(y, k)) continue;
          seatSide(sg * (V.x0 + (k + 0.62) * V.depth), y, z, sg);
          if (rng() > (k === 0 ? Math.min(1, V.density + 0.15) : V.density)) continue;
          const x = sg * (V.x0 + (k + 0.62) * V.depth);
          if (k === 0) {
            const kd = rng();
            fans.push({
              x: x, y: y, z: z, sg: sg, phase: rng() * Math.PI * 2,
              body: rng() < 0.4 ? CROWD_NEUTRALS[Math.floor(rng() * CROWD_NEUTRALS.length)] : V.palette[Math.floor(rng() * V.palette.length)], skin: CROWD_SKINS[Math.floor(rng() * CROWD_SKINS.length)],
              hat: rng() < V.hatP ? V.hat : null,
              look: crowdLook(rng),
              person: crowdPerson(rng, V),
              kind: kd < 0.07 ? 'sign' : kd < 0.07 + V.flagP * 1.5 && V.flags.length ? 'flag' : 'fan',
              flag: V.flags.length ? V.flags[Math.floor(rng() * V.flags.length)] : '#fff',
              // A home-made sign: card colour, marker colour, how it is held, and a flourish
              card: SIGN_CARDS[Math.floor(rng() * SIGN_CARDS.length)], ink: SIGN_INKS[Math.floor(rng() * SIGN_INKS.length)],
              tilt: (rng() - 0.5) * 0.2, stick: rng() < 0.3, deco: Math.floor(rng() * 4), wobble: [rng(), rng(), rng(), rng()]
            });
          } else {
            const hp = proj(x, y, z + 1.08);
            paintBoth(hp.x, hp.y, 0.1 * hp.s, true, seatedBody(x, y, z, -sg, 0));
          }
        }
      }
      // Front wall, with a rail along the top
      quad(ctx, [[sg * V.x0, V.y0, 0], [sg * V.x0, YF, 0], [sg * V.x0, YF, V.wallH], [sg * V.x0, V.y0, V.wallH]], V.wall);
      quad(ctx, [[sg * V.x0, V.y0, V.wallH - 0.08], [sg * V.x0, YF, V.wallH - 0.08], [sg * V.x0, YF, V.wallH], [sg * V.x0, V.y0, V.wallH]], 'rgba(255,255,255,0.35)');
      if (TUNNEL) {
        // The players' tunnel: a dark mouth in the wall under the stand, with a frame and a light inside
        const zt = tierZ(2);
        quad(ctx, [[sg * V.x0, TUNNEL[0], 0], [sg * V.x0, TUNNEL[1], 0], [sg * V.x0, TUNNEL[1], zt], [sg * V.x0, TUNNEL[0], zt]], '#0c0f0d');
        quad(ctx, [[sg * V.x0, TUNNEL[0] + 0.3, 0], [sg * V.x0, TUNNEL[1] - 0.3, 0], [sg * V.x0, TUNNEL[1] - 0.3, zt * 0.55], [sg * V.x0, TUNNEL[0] + 0.3, zt * 0.55]], 'rgba(255,236,190,0.12)');
        [TUNNEL[0], TUNNEL[1]].forEach((ty2) => quad(ctx, [[sg * V.x0, ty2 - 0.12, 0], [sg * V.x0, ty2 + 0.12, 0], [sg * V.x0, ty2 + 0.12, zt], [sg * V.x0, ty2 - 0.12, zt]], V.wall));
      }
      if (VK === 'invitational') {
        // Flower boxes along the wall
        for (let y = YF; y >= V.y0; y -= 0.45) {
          const p = proj(sg * (V.x0 - 0.05), y, V.wallH + 0.05);
          ctx.fillStyle = ['#c8102e', '#ff7aa8', '#f4f1e6'][Math.floor(rng() * 3)];
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1, 0.07 * p.s), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (VK === 'council') {
        // Chain link fence and floodlights
        quad(ctx, [[sg * 7.95, -4, 0], [sg * 7.95, YF - 0.2, 0], [sg * 7.95, YF - 0.2, 3.2], [sg * 7.95, -4, 3.2]], 'rgba(40,45,50,0.16)');
        ctx.strokeStyle = 'rgba(70,75,80,0.9)';
        for (let y = -3; y <= YF - 0.2; y += 3) {
          const a = proj(sg * 7.95, y, 0);
          const b = proj(sg * 7.95, y, 3.2);
          ctx.lineWidth = Math.max(1, 0.06 * a.s);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        [-3, YF + N * D + 0.8].forEach((y) => {
          const a = proj(sg * (outer + 0.8), y, 0);
          const b = proj(sg * (outer + 0.8), y, 12);
          ctx.strokeStyle = '#555b60';
          ctx.lineWidth = Math.max(2, 0.18 * a.s);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.fillStyle = '#e9edf0';
          ctx.fillRect(b.x - 0.7 * b.s, b.y - 0.4 * b.s, 1.4 * b.s, 0.5 * b.s);
        });
      }
    });
    if (VK === 'council') {
      quad(ctx, [[-7.95, YF - 0.2, 0], [7.95, YF - 0.2, 0], [7.95, YF - 0.2, 3.2], [-7.95, YF - 0.2, 3.2]], 'rgba(40,45,50,0.16)');
      ctx.strokeStyle = 'rgba(70,75,80,0.9)';
      for (let x = -7.95; x <= 7.96; x += 3.18) {
        const a = proj(x, YF - 0.2, 0);
        const b = proj(x, YF - 0.2, 3.2);
        ctx.lineWidth = Math.max(1, 0.06 * a.s);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    // Far people first, so nearer ones overlap them
    fans.sort((a, b) => b.y - a.y);
    if (VK === 'club') drawTeaHut(fgx, rng);
    if (V.screen) {
      // The TV camera in the far corner, on its tripod, with its operator
      const cx = -7.5;
      const cy = 28.2;
      drawCrewPerson(ctx, cx - 0.35, cy + 0.2, { pose: 'stand', shirt: '#1a1a1a', trousers: '#2a2a2a', skin: '#d9a27c', hat: 'cap', capColor: '#1a1a1a' });
      const head = proj(cx, cy, 1.45);
      const s2 = head.s;
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = Math.max(1, 0.04 * s2);
      [[-0.25, -0.15], [0.25, -0.15], [0, 0.25]].forEach((q) => {
        const g0 = proj(cx + q[0], cy + q[1], 0);
        ctx.beginPath();
        ctx.moveTo(head.x, head.y);
        ctx.lineTo(g0.x, g0.y);
        ctx.stroke();
      });
      ctx.fillStyle = '#2b2f33';
      ctx.fillRect(head.x - 0.22 * s2, head.y - 0.3 * s2, 0.5 * s2, 0.28 * s2);
      ctx.fillStyle = '#16181b';
      ctx.fillRect(head.x + 0.28 * s2, head.y - 0.25 * s2, 0.22 * s2, 0.18 * s2);
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(head.x - 0.18 * s2, head.y - 0.27 * s2, 0.06 * s2, 0.06 * s2);
      ctx.fillStyle = '#f4f1e6';
      ctx.font = 'bold ' + Math.max(6, Math.round(0.14 * s2)) + 'px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TV', head.x + 0.05 * s2, head.y - 0.15 * s2);
    }

    // The official. From Grimsby up, a chair umpire left of the net; below that, a referee standing courtside.
    if (!V.chair) {
      drawCrewPerson(ctx, -6.9, C.net - 0.6, { pose: 'stand', shirt: V.blazer, trousers: '#2a2a2a', skin: '#e2b48f', hat: 'cap', capColor: '#1a1a1a' });
      const cb = proj(-6.75, C.net - 0.6, 1.05);
      ctx.fillStyle = '#c9b48a';
      ctx.fillRect(cb.x - 0.12 * cb.s, cb.y - 0.16 * cb.s, 0.24 * cb.s, 0.3 * cb.s);
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(cb.x - 0.09 * cb.s, cb.y - 0.11 * cb.s, 0.18 * cb.s, 0.22 * cb.s);
      applySession();
      return { bg: c, crowd: cc, crowdFar: ccFar, fg: fgc, fans: fans, geo: { VK: VK, V: V, YF: YF, N: N, D: D, outer: outer, rimZ: rimZ, boards: boards, session: session, cloudY: VK === 'club' ? top - 110 : VK === 'council' ? top - 150 : VK === 'invitational' ? top - 90 : null } };
    }
    // The chair umpire is drawn live (drawUmpireChair), so they can watch the ball
    applySession();
    return { bg: c, crowd: cc, crowdFar: ccFar, fg: fgc, fans: fans, geo: { VK: VK, V: V, YF: YF, N: N, D: D, outer: outer, rimZ: rimZ, boards: boards, session: session, cloudY: VK === 'club' ? top - 110 : VK === 'council' ? top - 150 : VK === 'invitational' ? top - 90 : null } };
  }

  // The crowd in 32 columns. Each column bobs with excitement; the wave rolls left to right.
  // How far the crowd has turned to watch the far end (0 = your end, 1 = theirs), eased so heads turn, not snap
  function crowdLookStep() {
    if (!M) return 0;
    const now = M.time || 0;
    const dt = clamp(now - (M.crowdLookT === undefined ? now : M.crowdLookT), 0, 0.1);
    M.crowdLookT = now;
    const s = M.shot;
    let target = M.crowdLook === undefined ? 0 : M.crowdLook;
    if (s && !s.dead && M.phase === 'rally') target = clamp((shotPos(s, s.t).y - 6) / 12, 0, 1);
    else if (M.phase === 'serveReady' || M.phase === 'serveAim') target = 0.15;
    else if (M.phase === 'oppToss') target = 0.85;
    M.crowdLook = (M.crowdLook || 0) + (target - (M.crowdLook || 0)) * Math.min(1, dt * 6);
    return M.crowdLook;
  }
  // Each column (or front row fan) turns a little after the next, so the stand ripples
  const turnK = (look, seed) => clamp(look * 1.3 - 0.3 * seed, 0, 1);
  // Clouds drifting with the wind across the sky at the outdoor venues, clipped above the scenery
  function drawClouds(ctx) {
    const G = bgCache && bgCache.geo;
    if (!G || G.cloudY === null || G.cloudY === undefined || G.session === 'night' || !M) return;
    const dir = (M.cfg.wind || 0) >= 0 ? 1 : -1;
    const speed = 4 + Math.abs(M.cfg.wind || 0) * 0.8;
    const span = W + 2 * BX + 400;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-BX, -BY, W + 2 * BX, G.cloudY + BY);
    ctx.clip();
    for (let i = 0; i < 5; i++) {
      const base = ((i * 337 + 120) % span);
      let x = (base + (reduceMotion ? 0 : dir * (M.time || 0) * speed * (0.7 + i * 0.12))) % span;
      if (x < 0) x += span;
      x -= 200 + BX;
      const y = G.cloudY - 30 - (i % 3) * 22;
      const k = 0.8 + (i % 2) * 0.4;
      ctx.fillStyle = G.session === 'dusk' ? 'rgba(255,214,180,0.85)' : 'rgba(255,255,255,0.88)';
      [[0, 0, 34], [28, -8, 26], [-26, 2, 22], [50, 6, 18], [-44, 8, 16]].forEach((b) => {
        ctx.beginPath();
        ctx.arc(x + b[0] * k, y + b[1] * k, b[2] * k, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = 'rgba(150,170,190,0.18)';
      ctx.fillRect(x - 60 * k, y + 8 * k, 120 * k, 10 * k);
    }
    ctx.restore();
  }
  function drawCrowd(ctx) {
    const c = bgCache.crowd;
    const cf = bgCache.crowdFar;
    const look = reduceMotion ? 0 : crowdLookStep();
    const cols = 32;
    const cw = (W + 2 * BX) / cols;
    const sw = c.width / cols;
    ctx.save();
    for (let i = 0; i < cols; i++) {
      let dy = 0;
      if (!reduceMotion) {
        dy -= M.hype * 7 * Math.abs(Math.sin(M.time * 9 + i * 1.7));
        if (M.waveT >= 0) {
          const centre = M.waveT / 2.6 * (cols + 8) - 4;
          dy -= 14 * Math.exp(-((i - centre) * (i - centre)) / 4);
        }
      }
      ctx.drawImage(c, i * sw, 0, sw, c.height, -BX + i * cw, -BY + dy, cw + 0.5, H + 2 * BY);
      const a = cf ? turnK(look, ((i * 37) % 11) / 11) : 0;
      if (a > 0.01) {
        ctx.globalAlpha = a;
        ctx.drawImage(cf, i * sw, 0, sw, cf.height, -BX + i * cw, -BY + dy, cw + 0.5, H + 2 * BY);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  /* ---- Ball kids at their posts (the top two tournaments only; line calls are electronic) ---- */
  // Ball kid posts: kneeling at the net, then standing at the far corners
  // The back ones stand against the far wall in the corners, behind where the opponent ever goes (28 m)
  const KID_POSTS = [[6.4, C.net, 'kneel'], [-6.4, C.net, 'kneel'], [6.9, C.L + 5.3, 'stand'], [-6.9, C.L + 5.3, 'stand'], [5.5, C.L + 5.4, 'stand'], [-5.5, C.L + 5.4, 'stand']];
  function crew() {
    if (M.crew) return M.crew;
    const V = VENUES[venueKey(M.cfg)];
    M.crew = {
      V: V,
      kids: KID_POSTS.slice(0, V.kids).map((p) => ({ hx: p[0], hy: p[1], x: p[0], y: p[1], pose: p[2], mode: 'home', tx: 0, ty: 0, t: 0 }))
    };
    return M.crew;
  }
  function updateCrew(dt) {
    const c = crew();
    // After a point, the nearest ball kid sprints for the ball and brings it back
    if (M.phase === 'pointOver' && !M.kidSent && M.marks.length && c.kids.length) {
      M.kidSent = true;
      const mk = M.marks[M.marks.length - 1];
      const tx = clamp(mk.x, -7.5, 7.5);
      const ty = clamp(mk.y, -2.5, C.L + 3);
      let best = null;
      c.kids.forEach((k) => { const d = Math.hypot(k.hx - tx, k.hy - ty); if (k.mode === 'home' && (!best || d < best.d)) best = { k: k, d: d }; });
      if (best && best.d < 14) { best.k.mode = 'out'; best.k.tx = tx; best.k.ty = ty; }
    }
    if (M.phase !== 'pointOver') M.kidSent = false;
    c.kids.forEach((k) => {
      // Anyone who comes charging past gets out of the way, then goes back to their spot
      let ox = 0;
      let oy = 0;
      if (k.mode === 'home') {
        [M.player, M.opp].forEach((b) => {
          const dx = k.hx - b.x;
          const dy = k.hy - b.y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < 1.5) { ox += dx / d * (1.5 - d); oy += dy / d * (1.5 - d) * 0.5; }
        });
      }
      k.ox = (k.ox || 0) + (ox - (k.ox || 0)) * Math.min(1, dt * 10);
      k.oy = (k.oy || 0) + (oy - (k.oy || 0)) * Math.min(1, dt * 10);
      if (k.mode === 'home') return;
      k.t += dt;
      const gx = k.mode === 'out' ? k.tx : k.hx;
      const gy = k.mode === 'out' ? k.ty : k.hy;
      const d = Math.hypot(gx - k.x, gy - k.y);
      const step = 6.5 * dt;
      if (d <= step) {
        k.x = gx;
        k.y = gy;
        k.mode = k.mode === 'out' ? 'back' : 'home';
      } else {
        k.x += (gx - k.x) / d * step;
        k.y += (gy - k.y) / d * step;
      }
    });
  }
  // A small person on court, in world metres. seated: on a chair. pose: 'stand' | 'kneel' | 'run'
  // Crew sprites, by pose, colours and size (sizes in 2.5% steps; a running stride in 8 frames)
  const CREW_SPRITES = new Map();
  function crewSprite(o, sq) {
    const t8 = o.pose === 'run' ? Math.round(((o.t || 0) * 16 / (Math.PI * 2)) * 8) % 8 : 0;
    const key = [sq.toFixed(3), scale.toFixed(3), o.pose, o.seated ? 1 : 0, o.call || '', o.dir || 0, o.shirt, o.trousers, o.shorts ? 1 : 0, o.skin, o.hat, o.capColor, o.hair || '', t8].join('|');
    let sp = CREW_SPRITES.get(key);
    if (sp) { CREW_SPRITES.delete(key); CREW_SPRITES.set(key, sp); return sp; }
    // The sprite: the figure drawn at (ox, oy) in game units on a canvas at the screen's real resolution
    const pad = 6;
    const S = sq;
    const ox = 1.1 * S + pad;
    const oy = 2.3 * S + pad;
    const wL = 2.2 * S + pad * 2;
    const hL = 2.5 * S + pad * 2;
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.ceil(wL * scale));
    c.height = Math.max(2, Math.ceil(hL * scale));
    const cc = c.getContext('2d');
    cc.setTransform(scale, 0, 0, scale, 0, 0);
    const o2 = Object.assign({}, o, { g: { x: ox, y: oy, s: S / (o.scale || 1) }, t: t8 * (Math.PI * 2 / 8) / 16 });
    withOutline(cc, { x0: ox - 1.1 * S, y0: oy - 2.3 * S, x1: ox + 1.1 * S, y1: oy + 0.2 * S }, (k) => drawCrewPerson(k, 0, 0, Object.assign({}, o2, { inOutline: true })));
    sp = { c: c, ox: ox, oy: oy, w: wL, h: hL };
    CREW_SPRITES.set(key, sp);
    if (CREW_SPRITES.size > 160) CREW_SPRITES.delete(CREW_SPRITES.keys().next().value);
    return sp;
  }
  function drawCrewPerson(ctx, x, y, o) {
    const g = o.g || proj(x, y, 0);
    const s = g.s * (o.scale || 1);
    const at = (dz, dx) => ({ x: g.x + (dx || 0) * s, y: g.y - dz * s });
    if (OUTLINE_PASS === false && !o.inOutline) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, 0.3 * s, 0.07 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Stamp the sprite for this pose and size (made once), scaled by the small difference to the exact size
      const sq = Math.pow(1.025, Math.round(Math.log(s) / Math.log(1.025)));
      const sp = crewSprite(o, sq);
      const k = s / sq;
      ctx.drawImage(sp.c, g.x - sp.ox * k, g.y - sp.oy * k, sp.w * k, sp.h * k);
      return null;
    }
    // The same build as the players: shaded, tapered limbs, a torso that narrows to the waist, a neck and a face
    const skin = o.skin || '#e2b48f';
    const legCol = o.shorts ? skin : o.trousers;
    const shoe = (pt) => {
      ctx.fillStyle = '#f4f4ee';
      ctx.beginPath();
      ctx.ellipse(pt.x, pt.y - 0.02 * s, 0.075 * s, 0.035 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    let hip;
    if (o.seated) {
      // A plain wooden chair
      ctx.strokeStyle = '#3a2a1a';
      ctx.lineWidth = Math.max(1, 0.05 * s);
      ctx.beginPath();
      [-0.2, 0.2].forEach((dx) => { ctx.moveTo(at(0, dx).x, at(0).y); ctx.lineTo(at(0.48, dx).x, at(0.48).y); });
      ctx.moveTo(at(0.48, -0.22).x, at(0.48).y);
      ctx.lineTo(at(1.05, -0.22).x, at(1.05).y);
      ctx.stroke();
      ctx.fillStyle = '#5a4128';
      ctx.fillRect(at(0, -0.25).x, at(0.52).y, 0.5 * s, 0.06 * s);
      hip = 0.56;
      [-1, 1].forEach((sd) => {
        const h0 = at(hip, sd * 0.08);
        const kn = at(hip - 0.04, sd * 0.13);
        const ft = at(0.03, sd * 0.13);
        shadedChain(ctx, [h0, kn, ft], [0.065 * s, 0.055 * s, 0.035 * s], legCol);
        shoe(ft);
      });
    } else if (o.pose === 'kneel') {
      hip = 0.46;
      // One knee down, one knee up
      shadedChain(ctx, [at(hip, -0.08), at(0.07, -0.12), at(0.05, -0.3)], [0.06 * s, 0.05 * s, 0.035 * s], legCol);
      shadedChain(ctx, [at(hip, 0.08), at(0.42, 0.17), at(0.04, 0.18)], [0.06 * s, 0.05 * s, 0.035 * s], legCol);
      shoe(at(0.03, 0.19));
    } else {
      hip = 0.82;
      const stride = o.pose === 'run' ? Math.sin(o.t * 16) * 0.16 : 0;
      [-1, 1].forEach((sd) => {
        const h0 = at(hip, sd * 0.08);
        const ft = at(0.03, sd * (0.1 + stride * sd));
        const kn = jointFor(h0, ft, Math.hypot(ft.x - h0.x, ft.y - h0.y) * 1.02, sd);
        shadedChain(ctx, [h0, kn, ft], [0.068 * s, 0.05 * s, 0.032 * s], legCol);
        shoe(ft);
      });
    }
    // Shorts (ball kids) over the tops of the legs
    if (o.shorts) {
      ctx.fillStyle = o.trousers;
      const sTop = at(hip + 0.05);
      ctx.fillRect(sTop.x - 0.2 * s, sTop.y, 0.4 * s, 0.26 * s);
    }
    const top = hip + 0.58;
    const behind = o.shorts && o.pose === 'stand' && !o.call;
    if (behind) {
      [-1, 1].forEach((sd) => {
        const a = at(top - 0.06, sd * 0.19);
        const b = at(hip + 0.06, sd * 0.05);
        shadedChain(ctx, [a, { x: (a.x + b.x) / 2 + sd * 0.06 * s, y: (a.y + b.y) / 2 }, b], [0.048 * s, 0.038 * s, 0.03 * s], o.shirt);
      });
    }
    // Torso
    const tTop = at(top);
    const tBot = at(hip - 0.02);
    const tw = 0.4 * s;
    ctx.fillStyle = o.shirt;
    torsoPath(ctx, tTop.x - tw / 2, tTop.y, tw, tBot.y - tTop.y, 0.07 * s);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(tTop.x + tw * 0.22, tTop.y + 0.05 * s, tw * 0.26, tBot.y - tTop.y - 0.05 * s);
    if (!o.shorts) {
      // Officials: a white shirt and a tie under the blazer
      ctx.fillStyle = '#f4f4ee';
      ctx.beginPath();
      ctx.moveTo(tTop.x - 0.07 * s, tTop.y);
      ctx.lineTo(tTop.x + 0.07 * s, tTop.y);
      ctx.lineTo(tTop.x, tTop.y + 0.2 * s);
      ctx.fill();
      ctx.fillStyle = '#8a1c2b';
      ctx.fillRect(tTop.x - 0.012 * s, tTop.y + 0.03 * s, 0.024 * s, 0.14 * s);
    }
    // Arms
    const shL = at(top - 0.06, -0.19);
    const shR = at(top - 0.06, 0.19);
    let hL;
    let hR;
    if (o.call) {
      const out = at(top - 0.02, 0.62 * o.dir);
      if (o.dir > 0) { hR = out; hL = at(hip, -0.22); } else { hL = out; hR = at(hip, 0.22); }
    } else if (o.pose === 'run') {
      const sw = Math.sin(o.t * 16) * 0.12;
      hL = at(hip + 0.1, -0.24 + sw);
      hR = at(hip + 0.1, 0.24 - sw);
    } else if (o.seated) {
      hL = at(hip - 0.02, -0.13);
      hR = at(hip - 0.02, 0.13);
    } else if (o.pose === 'kneel') {
      hL = at(0.44, 0.06);
      hR = at(0.44, 0.16);
    } else {
      hL = at(hip - 0.02, -0.23);
      hR = at(hip - 0.02, 0.23);
    }
    if (!behind) [[shL, hL, 1], [shR, hR, -1]].forEach((A) => {
      const el = jointFor(A[0], A[1], 0.56 * s, A[2]);
      shadedChain(ctx, [A[0], el, A[1]], [0.048 * s, 0.038 * s, 0.03 * s], o.shirt);
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(A[1].x, A[1].y, 0.035 * s, 0, Math.PI * 2);
      ctx.fill();
    });
    // Neck, head and face: the match figure's head (drawFigure) at this size, under the hat
    const hr = 0.123 * s;
    const head = at(top + hr * 1.12 / s);
    ctx.fillStyle = shadeHex(skin, -0.12);
    ctx.fillRect(head.x - 0.044 * s, head.y + hr * 0.5, 0.088 * s, hr * 0.7);
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(head.x, head.y, hr, 0, Math.PI * 2);
    ctx.fill();
    [-1, 1].forEach((sd) => {
      ctx.fillStyle = sd > 0 ? shadeHex(skin, -0.12) : skin;
      ctx.beginPath();
      ctx.ellipse(head.x + sd * hr, head.y + hr * 0.12, hr * 0.17, hr * 0.27, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    const hairCol = o.hair || '#3a2716';
    ctx.fillStyle = hairCol;
    ctx.beginPath();
    ctx.arc(head.x, head.y - hr * 0.06, hr * 1.03, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    if (s > 14) {
      const lw = Math.max(1, hr * 0.13);
      ctx.fillStyle = '#ffffff';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.ellipse(head.x + sd * hr * 0.36, head.y + hr * 0.12, hr * 0.17, hr * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = '#1b1b1b';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.arc(head.x + sd * hr * 0.36 + (o.dir || 0) * hr * 0.05, head.y + hr * 0.13, hr * 0.09, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.strokeStyle = hairCol;
      ctx.lineWidth = lw * 1.2;
      ctx.lineCap = 'round';
      const tilt = o.call ? 0.3 : 0;
      [-1, 1].forEach((sd) => {
        const bx = head.x + sd * hr * 0.36;
        const by = head.y - hr * 0.12;
        ctx.beginPath();
        ctx.moveTo(bx - hr * 0.2, by + sd * tilt * hr * 0.5);
        ctx.lineTo(bx + hr * 0.2, by - sd * tilt * hr * 0.5);
        ctx.stroke();
      });
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#5a2a20';
      ctx.beginPath();
      if (o.call) {
        ctx.fillStyle = '#4a1414';
        ctx.ellipse(head.x, head.y + hr * 0.58, hr * 0.22, hr * 0.26, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(head.x - hr * 0.2, head.y + hr * 0.58);
        ctx.lineTo(head.x + hr * 0.2, head.y + hr * 0.58);
        ctx.stroke();
      }
    }
    if (o.hat === 'panama') {
      ctx.fillStyle = '#efe2b8';
      ctx.fillRect(head.x - hr * 1.6, head.y - hr * 0.7, hr * 3.2, hr * 0.35);
      ctx.fillRect(head.x - hr * 0.95, head.y - hr * 1.5, hr * 1.9, hr * 0.85);
      ctx.fillStyle = o.shirt;
      ctx.fillRect(head.x - hr * 0.95, head.y - hr * 0.75, hr * 1.9, hr * 0.2);
    } else {
      ctx.fillStyle = o.capColor || o.shirt;
      ctx.beginPath();
      ctx.arc(head.x, head.y - hr * 0.25, hr, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(head.x - hr * 0.2, head.y - hr * 0.45, hr * 1.5, hr * 0.28);
    }
    // The call, shouted
    if (o.call && s > 12) {
      ctx.font = 'bold ' + Math.max(9, Math.round(0.28 * s)) + 'px "Trebuchet MS", sans-serif';
      const tw = ctx.measureText(o.call).width + 0.2 * s;
      const bx = head.x - tw / 2;
      const by2 = head.y - 0.62 * s;
      ctx.fillStyle = '#fff6d6';
      roundRect(ctx, bx, by2, tw, 0.34 * s, 0.08 * s);
      ctx.fill();
      ctx.fillStyle = '#b3261e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.call, head.x, by2 + 0.17 * s);
    }
  }
  // Adds the crew to the depth sorted scene
  // A player's bench beside the umpire's chair: a towel over the back, drinks, a racket bag, and spare rackets
  // leaning on the front. Yours loses one for every racket you smash.
  function drawBench(ctx, x, y, mine) {
    const G = bgCache.geo;
    const sp = SPONSORS[VENUE_SPONSOR[G.VK]];
    const p0 = proj(x, y, 0);
    const sc = p0.s;
    ctx.strokeStyle = '#262626';
    ctx.lineWidth = Math.max(1, 0.04 * sc);
    [[-0.22, -0.28], [0.22, -0.28], [-0.22, 0.28], [0.22, 0.28]].forEach((q) => {
      const a = proj(x + q[0], y + q[1], 0);
      const b = proj(x + q[0], y + q[1], 0.45);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    // Backrest towards the wall, seat, and the seat's front edge
    quad(ctx, [[x - 0.25, y - 0.3, 0.45], [x - 0.25, y + 0.3, 0.45], [x - 0.25, y + 0.3, 1.05], [x - 0.25, y - 0.3, 1.05]], sp.bg);
    quad(ctx, [[x - 0.25, y - 0.3, 0.45], [x + 0.25, y - 0.3, 0.45], [x + 0.25, y + 0.3, 0.45], [x - 0.25, y + 0.3, 0.45]], '#3a4750');
    quad(ctx, [[x + 0.25, y - 0.3, 0.38], [x + 0.25, y + 0.3, 0.38], [x + 0.25, y + 0.3, 0.45], [x + 0.25, y - 0.3, 0.45]], '#262f35');
    // Towel over the back, in the tournament colours
    quad(ctx, [[x - 0.23, y - 0.2, 1.08], [x - 0.23, y + 0.12, 1.08], [x - 0.23, y + 0.12, 0.7], [x - 0.23, y - 0.2, 0.7]], '#f4f1e6');
    quad(ctx, [[x - 0.225, y - 0.2, 0.82], [x - 0.225, y + 0.12, 0.82], [x - 0.225, y + 0.12, 0.88], [x - 0.225, y - 0.2, 0.88]], sp.accent);
    // Racket bag on the ground, nearer the net
    const bag = mine ? playerColors().shirt || '#1c1c1c' : (M.cfg.opp.shirt || '#1c1c1c');
    quad(ctx, [[x + 0.06, y + 0.4, 0.24], [x + 0.42, y + 0.4, 0.24], [x + 0.42, y + 1.25, 0.24], [x + 0.06, y + 1.25, 0.24]], bag);
    quad(ctx, [[x + 0.42, y + 0.4, 0], [x + 0.42, y + 1.25, 0], [x + 0.42, y + 1.25, 0.24], [x + 0.42, y + 0.4, 0.24]], 'rgba(0,0,0,0.35)');
    // Drinks: a sponsor's bottle and a water
    [[x + 0.42, y - 0.22, sp.bg, sp.fg], [x + 0.42, y - 0.06, '#bfe3f2', '#2f6f9a']].forEach((d) => {
      const a = proj(d[0], d[1], 0);
      const b = proj(d[0], d[1], 0.26);
      const w = 0.08 * a.s;
      ctx.fillStyle = d[2];
      ctx.fillRect(a.x - w / 2, b.y, w, a.y - b.y);
      ctx.fillStyle = d[3];
      ctx.fillRect(a.x - w * 0.3, b.y - w * 0.4, w * 0.6, w * 0.45);
    });
    // Spare rackets stood in a line beside the bench, towards the court, so you can count them
    const n = mine ? Math.max(0, M.rackets - 1) : 2;
    const col = mine ? playerColors().racket : '#2a2a2a';
    for (let i = 0; i < n; i++) {
      const xx = x + 0.34 + i * 0.17;
      const yy = y - 0.42;
      const a = proj(xx, yy, 0.02);
      const b = proj(xx + 0.02, yy + 0.04, 0.42);
      const h = proj(xx + 0.03, yy + 0.06, 0.6);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, 0.035 * a.s);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, 0.025 * a.s);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.ellipse(h.x, h.y, 0.09 * a.s, 0.13 * a.s, 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  // The umpire's chair: a tall frame with a ladder and a platform, the tournament sponsor on the front panel,
  // and the umpire in a blazer with a microphone. Their head follows the ball: face towards you when it is at
  // your end, the back of the head when it is at theirs.
  function drawUmpireChair(ctx) {
    const G = bgCache.geo;
    const sp = SPONSORS[VENUE_SPONSOR[G.VK]];
    const x = -7.35;
    const y = C.net;
    const P = (dx, dy, z) => proj(x + dx, y + dy, z);
    ctx.strokeStyle = '#2b2f33';
    ctx.lineCap = 'round';
    const leg = (dx, dy) => {
      const a = P(dx, dy, 0);
      const b = P(dx * 0.7, dy * 0.7, 1.75);
      ctx.lineWidth = Math.max(1.5, 0.06 * a.s);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    leg(-0.35, 0.45);
    leg(-0.35, -0.45);
    // Ladder rungs on the court side
    for (let z = 0.35; z < 1.7; z += 0.35) {
      const a = P(0.33, -0.36, z);
      const b = P(0.33, 0.36, z);
      ctx.lineWidth = Math.max(1, 0.035 * a.s);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    leg(0.35, 0.45);
    leg(0.35, -0.45);
    // Platform, the sponsor panel facing the court, the seat back
    quad(ctx, [[-0.3, -0.38, 1.75], [0.3, -0.38, 1.75], [0.3, 0.38, 1.75], [-0.3, 0.38, 1.75]].map((q) => [x + q[0], y + q[1], q[2]]), '#3a4048');
    quad(ctx, [[0.3, -0.38, 1.75], [0.3, 0.38, 1.75], [0.3, 0.38, 2.15], [0.3, -0.38, 2.15]].map((q) => [x + q[0], y + q[1], q[2]]), sp.bg);
    const pc = P(0.31, 0, 1.95);
    sponsorMark(ctx, VENUE_SPONSOR[G.VK], pc.x, pc.y, 0.13 * pc.s, sp.fg, sp.accent);
    quad(ctx, [[-0.3, -0.3, 2.15], [-0.3, 0.3, 2.15], [-0.3, 0.3, 2.85], [-0.3, -0.3, 2.85]].map((q) => [x + q[0], y + q[1], q[2]]), '#2b2f33');
    // The umpire
    const seat = P(-0.05, 0, 2.15);
    const k = seat.s;
    const look = M.crowdLook || 0;
    const away = look > 0.5;
    withOutline(ctx, { x0: seat.x - 0.6 * k, y0: seat.y - 1.1 * k, x1: seat.x + 0.6 * k, y1: seat.y + 0.4 * k }, (c) => {
      // Legs over the front of the seat
      c.fillStyle = '#2a2a33';
      c.fillRect(seat.x - 0.05 * k, seat.y - 0.06 * k, 0.32 * k, 0.12 * k);
      c.fillRect(seat.x + 0.2 * k, seat.y - 0.04 * k, 0.1 * k, 0.36 * k);
      // Blazer
      c.fillStyle = umpire().blazer || G.V.blazer;
      roundRect(c, seat.x - 0.17 * k, seat.y - 0.6 * k, 0.34 * k, 0.58 * k, 0.08 * k);
      c.fill();
      c.fillStyle = '#f4f1e6';
      c.beginPath();
      c.moveTo(seat.x - 0.05 * k, seat.y - 0.6 * k);
      c.lineTo(seat.x + 0.02 * k, seat.y - 0.42 * k);
      c.lineTo(seat.x + 0.08 * k, seat.y - 0.6 * k);
      c.fill();
      // Microphone on its stalk
      c.strokeStyle = '#1a1a1a';
      c.lineWidth = Math.max(1, 0.025 * k);
      c.beginPath();
      c.moveTo(seat.x + 0.32 * k, seat.y - 0.2 * k);
      c.lineTo(seat.x + 0.24 * k, seat.y - 0.66 * k);
      c.stroke();
      c.fillStyle = '#1a1a1a';
      c.beginPath();
      c.arc(seat.x + 0.23 * k, seat.y - 0.68 * k, 0.04 * k, 0, Math.PI * 2);
      c.fill();
      // Head, turning with the play
      const hx = seat.x + 0.02 * k;
      const hy = seat.y - 0.75 * k;
      const hr = 0.12 * k;
      const U = umpire();
      // A bob hangs below the head at the back
      if (U.hair && U.style === 'bob') {
        c.fillStyle = U.hair;
        roundRect(c, hx - hr * 1.08, hy - hr * 0.4, away ? hr * 2.16 : hr * 0.75, hr * 1.25, hr * 0.3);
        c.fill();
      }
      c.fillStyle = U.skin;
      c.beginPath();
      c.arc(hx, hy, hr, 0, Math.PI * 2);
      c.fill();
      if (U.hair) {
        c.fillStyle = U.hair;
        c.beginPath();
        if (away) c.arc(hx, hy - hr * 0.05, hr * 1.02, 0, Math.PI * 2);
        else c.arc(hx - hr * 0.2, hy - hr * 0.2, hr * 0.98, Math.PI * 0.9, Math.PI * 1.9);
        c.fill();
        if (U.style === 'bun') { c.beginPath(); c.arc(hx - hr * 0.6, hy - hr * 0.8, hr * 0.42, 0, Math.PI * 2); c.fill(); }
      } else {
        // Bald, with a horseshoe of grey round the back
        c.strokeStyle = '#8f8f8f';
        c.lineWidth = hr * 0.32;
        c.beginPath();
        c.arc(hx, hy, hr * 0.86, away ? Math.PI * 0.15 : Math.PI * 0.75, away ? Math.PI * 0.85 : Math.PI * 1.15);
        c.stroke();
      }
      if (!away && U.tache) {
        c.fillStyle = U.tache;
        roundRect(c, hx + hr * 0.42, hy + hr * 0.32, hr * 0.5, hr * 0.18, hr * 0.08);
        c.fill();
      }
      if (!away && U.glasses) {
        // Spectacles, facing the court
        c.strokeStyle = '#1a1a1a';
        c.lineWidth = Math.max(1, 0.02 * k);
        c.beginPath();
        c.arc(hx + hr * 0.45, hy + hr * 0.05, hr * 0.22, 0, Math.PI * 2);
        c.stroke();
      }
    });
  }
  // Line judges at the Invitational: seated against the side walls, level with the far service line and baseline.
  // The nearest one stands and calls a ball out, arm out along the line.
  const LINE_JUDGES = [[-7.6, C.net + C.svc], [7.6, C.net + C.svc], [-7.6, C.L - 0.1], [7.6, C.L - 0.1]];
  function pushLineJudges(items, ctx) {
    const G = bgCache.geo;
    if (!G || G.VK !== 'invitational') return;
    const lc = M.lineCall && M.time - M.lineCall.t < 1.5 ? M.lineCall : null;
    let caller = -1;
    if (lc) {
      let best = 99;
      LINE_JUDGES.forEach((j, i) => {
        const d = Math.abs(j[1] - lc.y) + (Math.sign(j[0]) === Math.sign(lc.x || 1) ? 0 : 3);
        if (d < best) { best = d; caller = i; }
      });
    }
    LINE_JUDGES.forEach((j, i) => {
      const calling = i === caller;
      items.push({ y: j[1], draw: () => drawCrewPerson(ctx, j[0], j[1], {
        seated: !calling, pose: 'stand', scale: 0.9, shirt: G.V.blazer, trousers: '#2a2a2a', skin: CROWD_SKINS[(i * 2 + 1) % CROWD_SKINS.length],
        hat: 'panama', call: calling ? (lc.close ? 'IN!' : 'OUT!') : null, dir: -Math.sign(j[0])
      }) });
    });
  }
  function pushCrew(items, ctx) {
    const c = crew();
    const V = c.V;
    if (V.chair) items.push({ y: C.net + 0.01, draw: () => drawUmpireChair(ctx) });
    pushLineJudges(items, ctx);
    items.push({ y: C.net - 1.9, draw: () => drawBench(ctx, -7.45, C.net - 1.9, true) });
    items.push({ y: C.net + 1.9, draw: () => drawBench(ctx, -7.45, C.net + 1.9, false) });
    c.kids.forEach((k, i) => {
      const dodging = Math.abs(k.ox || 0) + Math.abs(k.oy || 0) > 0.15;
      const pose = k.mode === 'home' ? (dodging ? 'run' : k.pose) : 'run';
      items.push({ y: k.y, draw: () => drawCrewPerson(ctx, k.x + (k.ox || 0), k.y + (k.oy || 0), {
        scale: 0.7, pose: pose, t: k.t + i, shirt: V.kidShirt, trousers: V.kidCap || '#1f2a24', shorts: true, skin: CROWD_SKINS[(i * 3) % CROWD_SKINS.length], hat: 'cap', capColor: V.kidCap || '#f4f1e6'
      }) });
    });
  }

  /* ---- Flags along the rim of the stands, blowing with the match's wind ---- */
  function drawRimFlags(ctx) {
    const G = bgCache.geo;
    if (!G || !G.V.flags.length || G.VK === 'leisure') return;
    const wind = M.cfg.wind || 0;
    const strength = clamp(Math.abs(wind) / 14, 0, 1);
    const dir = wind >= 0 ? 1 : -1;
    const posts = [];
    const back = G.YF + G.N * G.D;
    for (let x = -G.outer + 1.2; x <= G.outer - 1.2; x += 4.4) posts.push([x, back]);
    // Only the far half of the side rims: nearer flags would loom over the camera
    [-1, 1].forEach((sg) => { for (let y = 16; y < back; y += 6) posts.push([sg * G.outer, y]); });
    posts.forEach((p, i) => {
      const b = proj(p[0], p[1], G.rimZ);
      const tp = proj(p[0], p[1], G.rimZ + 2.6);
      if (tp.x < -BX - 40 || tp.x > W + BX + 40) return;
      const s = b.s;
      ctx.strokeStyle = '#d8d8d0';
      ctx.lineWidth = Math.max(1, 0.06 * s);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(tp.x, tp.y);
      ctx.stroke();
      // Limp when still, straight out when it blows; it ripples faster in a strong wind
      const L = 1.3 * s;
      const hgt = 0.8 * s;
      const droop = (1 - strength) * 1.25;
      const ux = Math.cos(droop) * dir;
      const uy = Math.sin(droop);
      const ph = reduceMotion ? 0 : M.time * (3 + 7 * strength) + i * 1.3;
      const wv = (u) => Math.sin(ph - u * 4) * 0.12 * hgt * (0.3 + strength) * u;
      ctx.fillStyle = G.V.flags[i % G.V.flags.length];
      ctx.beginPath();
      for (let u = 0; u <= 1.001; u += 0.25) ctx.lineTo(tp.x + ux * L * u, tp.y + uy * L * u + wv(u));
      for (let u = 1; u >= -0.001; u -= 0.25) ctx.lineTo(tp.x + ux * L * u - uy * hgt * dir * 0, tp.y + uy * L * u + hgt + wv(u));
      ctx.closePath();
      ctx.fill();
    });
  }

  /* ---- The big screen: live score, and the replays the crowd came for ---- */
  // The big screen in the far stand: set right of the title strap and below the top of the screen, which on a
  // phone (where the HUD is scaled up) would otherwise cover its left edge and cut its top
  const BIG_SCREEN = { x: 2.8, drop: { slam: 0.8, invitational: 0.3 } };
  function drawBigScreen(ctx) {
    const G = bgCache.geo;
    if (!G || !G.V.screen) return;
    const yb = G.YF + G.N * G.D - 0.3;
    // Hung low in the far stand, right of centre, clear of the scoreboard at the top of the screen
    const zTop = G.rimZ - 0.6 - BIG_SCREEN.drop[G.VK];
    const zBot = Math.max(G.V.wallH + 0.4, G.rimZ - 4.2 - BIG_SCREEN.drop[G.VK]);
    const a = proj(G.V.x0 + BIG_SCREEN.x, yb, zTop);
    const b = proj(G.V.x0 + BIG_SCREEN.x + (zTop - zBot) * 2.2, yb, zBot);
    const x = a.x;
    const y = a.y;
    const w = b.x - a.x;
    const h = b.y - a.y;
    // Struts, frame, screen
    ctx.fillStyle = '#20262b';
    ctx.fillRect(x + w * 0.2, y + h, w * 0.05, Math.max(0, proj(0, yb, G.rimZ - 5.2).y - (y + h)));
    ctx.fillRect(x + w * 0.75, y + h, w * 0.05, Math.max(0, proj(0, yb, G.rimZ - 5.2).y - (y + h)));
    ctx.fillStyle = '#20262b';
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    ctx.fillStyle = '#05080a';
    ctx.fillRect(x, y, w, h);
    const fs = h * 0.24;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    const lp = M.lastPoint;
    const recent = lp && M.time - lp.t < 2.6;
    const flash = reduceMotion ? 1 : (Math.sin(M.time * 12) > 0 ? 1 : 0.55);
    const big = (text, color) => {
      ctx.font = 'bold ' + Math.round(fs * 1.35) + 'px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(text, cx, y + h * 0.45);
    };
    if (tantrumOnCourt()) {
      ctx.globalAlpha = flash;
      big('RACKET ABUSE', '#ff3b30');
      ctx.globalAlpha = 1;
      ctx.font = 'bold ' + Math.round(fs * 0.7) + 'px "Courier New", monospace';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('REPLAY TO FOLLOW', cx, y + h * 0.78);
    } else if (M.phase === 'review') {
      big('OWL VISION', '#9fe7ff');
    } else if (M.crowdCam && M.time - M.crowdCam.t < 2.6 && !/rally|serveAim/.test(M.phase)) {
      // CROWD CAM: a spectator spots themselves and waves like mad
      const cc = M.crowdCam;
      const tt = M.time - cc.t;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = ['#2f5a3a', '#3b2f5e', '#5a3a2f'][cc.look];
      ctx.fillRect(x, y, w, h);
      const fx = x + w * 0.5;
      const fy = y + h * 1.05;
      const u = h * 0.9;
      ctx.fillStyle = ['#c8102e', '#1f3a6b', '#f2c14e'][cc.look];
      roundRect(ctx, fx - u * 0.32, fy - u * 0.55, u * 0.64, u * 0.6, u * 0.12);
      ctx.fill();
      ctx.fillStyle = CROWD_SKINS[cc.look * 2];
      ctx.beginPath();
      ctx.arc(fx, fy - u * 0.72, u * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = CROWD_HAIR[cc.look + 1];
      ctx.beginPath();
      ctx.arc(fx, fy - u * 0.76, u * 0.2, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(fx - u * 0.1, fy - u * 0.73, u * 0.05, u * 0.05);
      ctx.fillRect(fx + u * 0.05, fy - u * 0.73, u * 0.05, u * 0.05);
      ctx.fillStyle = '#5a1a1a';
      ctx.beginPath();
      ctx.ellipse(fx, fy - u * 0.62, u * 0.07, u * 0.05 + Math.abs(Math.sin(tt * 9)) * u * 0.03, 0, 0, Math.PI * 2);
      ctx.fill();
      // Both arms waving
      ctx.strokeStyle = CROWD_SKINS[cc.look * 2];
      ctx.lineWidth = u * 0.09;
      ctx.lineCap = 'round';
      const wv = reduceMotion ? 0 : Math.sin(tt * 12) * 0.5;
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.moveTo(fx + sd * u * 0.28, fy - u * 0.5);
        ctx.lineTo(fx + sd * u * (0.45 + 0.1 * Math.sin(wv)), fy - u * (0.95 + 0.1 * wv * sd));
        ctx.stroke();
      });
      ctx.restore();
      ctx.font = 'bold ' + Math.round(fs * 0.62) + 'px "Courier New", monospace';
      ctx.fillStyle = '#d9f24a';
      ctx.textAlign = 'left';
      ctx.fillText('CROWD CAM', x + w * 0.04, y + h * 0.14);
      ctx.textAlign = 'center';
    } else if (M.celeb) {
      big('WHAT A SHOT!', '#d9f24a');
    } else if (recent && (lp.reason === 'ace' || lp.reason === 'overturnedAce')) {
      big('ACE', '#d9f24a');
      ctx.font = 'bold ' + Math.round(fs * 0.75) + 'px "Courier New", monospace';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText(lp.mph + ' MPH', cx, y + h * 0.8);
    } else {
      // The score, broadcast style
      ctx.font = 'bold ' + Math.round(fs * 0.62) + 'px "Courier New", monospace';
      ctx.fillStyle = '#d9f24a';
      ctx.fillText(G.VK === 'slam' ? 'WIMBLEFORD' : 'ROYAL TUNBRIDGE', cx, y + h * 0.16);
      ctx.font = 'bold ' + Math.round(fs * 0.78) + 'px "Courier New", monospace';
      const rows = [[myTv(), 0], [tvName(M.cfg.opp.name), 1]];
      const scoreW = ctx.measureText('0  AD').width;
      rows.forEach((r, i) => {
        const ry = y + h * (0.45 + i * 0.3);
        ctx.textAlign = 'left';
        ctx.fillStyle = M.server === r[1] ? '#d9f24a' : '#f4f1e6';
        ctx.fillText((M.server === r[1] ? '\u2022' : ' ') + r[0], x + w * 0.05, ry, w * 0.86 - scoreW);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#f4f1e6';
        ctx.fillText(String(M.games[r[1]]) + '  ' + pointLabel(r[1]), x + w * 0.95, ry);
      });
      ctx.textAlign = 'center';
    }
    // A sheen across the glass
    const gl = ctx.createLinearGradient(x, y, x + w, y + h);
    gl.addColorStop(0, 'rgba(255,255,255,0.08)');
    gl.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(x, y, w, h);
  }

  // The front row, drawn live. They stand for big moments and the wave, film tantrums on their phones,
  // boo a cheat or a shush, clutch their heads at a code violation, and hold up signs.
  function drawFans(ctx) {
    const fans = bgCache.fans;
    if (!fans || !fans.length) return;
    const t = M.time;
    const mood = M.crowdMood ? M.crowdMood.kind : null;
    const filming = tantrumOnCourt() || M.phase === 'review';
    const waveY = M.waveT >= 0 ? lerp(-6, 32, M.waveT / 2.6) : null;
    const signs = M.rage > 0.7 ? FAN_SIGNS.calm : (mood === 'wild' || M.hype > 0.6) ? FAN_SIGNS.wild : FAN_SIGNS.any;
    ctx.lineCap = 'round';
    for (let i = 0; i < fans.length; i++) {
      const f = fans[i];
      const ph = f.phase;
      let stand = M.hype > 0.62 || mood === 'wild' || mood === 'boo' || tantrumOnCourt();
      if (waveY !== null && Math.abs(f.y - waveY) < 2.4) stand = true;
      const bounce = stand && mood === 'wild' && !reduceMotion ? Math.abs(Math.sin(t * 9 + ph)) * 0.14 : 0;
      // Hips on the seat at 0.46 m, or at 0.9 m standing. base is the bottom of the torso.
      const z = f.z + (stand ? 0.9 : 0.46) + bounce;
      const base = proj(f.x, f.y, z);
      const s = base.s;
      if (base.x < -BX - 60 || base.x > W + BX + 60 || base.y > H + BY + 60) continue;
      // Real proportions: a smaller head on a neck, broad shoulders
      const top = proj(f.x, f.y, z + 0.5);
      const head = proj(f.x, f.y, z + 0.69);
      const sh = proj(f.x, f.y, z + 0.45);
      const bw = 0.42 * s;
      const Lk = f.look;
      const hr = 0.095 * s;
      const P = f.person;
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = Math.max(1, 0.024 * s);
      if (P) {
        // Legs: seated, thighs out towards the court and shins down to the step; standing, straight down
        const fx = -f.sg;
        const legs = [1, -1].map((sd) => {
          const ly = f.y + sd * 0.1;
          return stand
            ? [proj(f.x, ly, z), proj(f.x + fx * 0.06, ly, f.z + 0.47), proj(f.x + fx * 0.04, ly + sd * 0.02, f.z + 0.02)]
            : [proj(f.x + fx * 0.05, ly, z), proj(f.x + fx * 0.4, ly, z + 0.04), proj(f.x + fx * 0.44, ly + sd * 0.02, f.z + 0.02)];
        });
        const ol = Math.max(1, 0.024 * s);
        legs.forEach((L) => {
          const lower = P.legWear === 'trousers' ? P.legs : P.skin;
          const upper = P.legWear === 'skirt' ? f.body : P.legs;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          [[L[1], L[2], 0.11, lower], [L[0], L[1], 0.15, upper]].forEach((seg) => {
            ctx.strokeStyle = '#0b0b0b';
            ctx.lineWidth = seg[2] * s + ol * 2;
            ctx.beginPath();
            ctx.moveTo(seg[0].x, seg[0].y);
            ctx.lineTo(seg[1].x, seg[1].y);
            ctx.stroke();
            ctx.strokeStyle = seg[3];
            ctx.lineWidth = seg[2] * s;
            ctx.stroke();
          });
          ctx.fillStyle = P.shoe;
          ctx.beginPath();
          ctx.ellipse(L[2].x + fx * 0.03 * s, L[2].y - 0.015 * s, 0.08 * s, 0.04 * s, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = ol;
          ctx.stroke();
        });
        ctx.strokeStyle = '#0b0b0b';
        ctx.lineWidth = ol;
      }
      if (Lk.style === 'long') {
        ctx.fillStyle = Lk.hair;
        ctx.fillRect(head.x - hr, head.y - hr * 0.3, hr * 2, hr * 1.9);
      }
      ctx.fillStyle = f.body;
      shoulders(ctx, top.x, top.y, bw, base.y - top.y);
      ctx.fill();
      ctx.stroke();
      if (f.person && (f.person.wear === 'jacket' || f.person.wear === 'cardigan')) {
        // An open jacket or cardigan over a shirt
        ctx.fillStyle = f.person.inner;
        ctx.beginPath();
        ctx.moveTo(top.x - bw * 0.16, top.y + 1);
        ctx.lineTo(top.x + bw * 0.16, top.y + 1);
        ctx.lineTo(top.x + bw * 0.1, base.y);
        ctx.lineTo(top.x - bw * 0.1, base.y);
        ctx.fill();
      }
      if (Lk.top < 0.16) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(top.x - bw / 2 + 1, top.y + (base.y - top.y) * 0.35, bw - 2, (base.y - top.y) * 0.12);
        ctx.fillRect(top.x - bw / 2 + 1, top.y + (base.y - top.y) * 0.62, bw - 2, (base.y - top.y) * 0.12);
      } else if (Lk.top < 0.34) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(top.x - bw * 0.22, top.y + 1);
        ctx.lineTo(top.x, top.y + bw * 0.3);
        ctx.lineTo(top.x + bw * 0.22, top.y + 1);
        ctx.fill();
      }
      ctx.fillStyle = shadeHex(f.skin, -0.12);
      ctx.fillRect(head.x - hr * 0.4, head.y + hr * 0.5, hr * 0.8, top.y - head.y - hr * 0.3);
      ctx.fillStyle = f.skin;
      ctx.beginPath();
      ctx.arc(head.x, head.y, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const away = !reduceMotion && turnK(M.crowdLook || 0, (f.phase / (Math.PI * 2)) % 1) > 0.5;
      if (away) {
        if (Lk.style !== 'bald') {
          ctx.fillStyle = Lk.hair;
          ctx.beginPath();
          ctx.arc(head.x, head.y - hr * 0.04, hr * 1.03, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (Lk.style !== 'bald') paintHair(ctx, head.x, head.y, hr, Lk.hair, Lk.style === 'long' ? 'short' : Lk.style);
      if (s > 24 && !away) {
        // A face turned to the court: an eye or sunglasses, and a mouth that opens when they shout
        const fx = -f.sg;
        if (Lk.shades) {
          ctx.fillStyle = '#121212';
          ctx.fillRect(head.x + fx * hr * 0.1 - hr * 0.55, head.y - hr * 0.2, hr * 1.1, hr * 0.32);
        } else {
          ctx.fillStyle = '#1a1a1a';
          ctx.beginPath();
          ctx.arc(head.x + fx * hr * 0.45, head.y - hr * 0.06, Math.max(0.8, hr * 0.13), 0, Math.PI * 2);
          ctx.fill();
        }
        if (stand || mood === 'boo' || mood === 'gasp') {
          ctx.fillStyle = '#5a1a1a';
          ctx.beginPath();
          ctx.ellipse(head.x + fx * hr * 0.5, head.y + hr * 0.45, hr * 0.16, hr * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (f.hat) {
        ctx.fillStyle = f.hat;
        ctx.fillRect(head.x - 0.13 * s, head.y - 0.065 * s, 0.26 * s, 0.04 * s);
        ctx.fillRect(head.x - 0.08 * s, head.y - 0.13 * s, 0.16 * s, 0.075 * s);
      }
      // Arms
      ctx.strokeStyle = f.skin;
      ctx.lineWidth = Math.max(1, 0.06 * s);
      const arm = (dx, dy) => {
        ctx.beginPath();
        ctx.moveTo(sh.x + Math.sign(dx) * bw * 0.45, sh.y);
        ctx.lineTo(sh.x + dx * s, sh.y + dy * s);
        ctx.stroke();
      };
      if (f.kind === 'sign' && (stand || M.rage > 0.7) && s > 20 && onScreenShift(ctx, head.x - 0.6 * s, 1.2 * s) === 0) {
        // A home-made sign held up above the head
        const text = signs[Math.floor(ph * 7) % signs.length];
        drawCrowdSign(ctx, f, head.x, head.y - 0.16 * s, s, text, t, sh, bw);
      } else if (filming && f.kind !== 'flag') {
        // Phones out
        const hx = sh.x + 0.12 * s;
        const hy = sh.y - 0.36 * s;
        arm(0.12, -0.36);
        ctx.fillStyle = '#16181c';
        ctx.fillRect(hx - 0.05 * s, hy - 0.09 * s, 0.1 * s, 0.17 * s);
        if (!reduceMotion && ((t * 1.7 + ph) % 1) < 0.07) {
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.arc(hx, hy - 0.04 * s, 0.07 * s, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (M.rage >= 0.85 && f.kind !== 'flag' && (ph * 3) % 1 < 0.55) {
        // Hands over the eyes: they cannot watch what is coming
        arm(-0.08, -0.22);
        arm(0.08, -0.22);
        ctx.fillStyle = f.skin;
        ctx.fillRect(head.x - 0.11 * s, head.y - 0.04 * s, 0.22 * s, 0.06 * s);
      } else if (mood === 'boo') {
        arm(-0.16, 0.06);
        arm(0.16, 0.06);
        if (ph < 1.6 && s > 18) {
          ctx.font = 'bold ' + Math.max(7, Math.round(0.16 * s)) + 'px "Trebuchet MS", sans-serif';
          ctx.fillStyle = '#ff8a80';
          ctx.textAlign = 'center';
          ctx.fillText('BOO', head.x, head.y - 0.24 * s - Math.abs(Math.sin(t * 5 + ph)) * 0.08 * s);
        }
      } else if (mood === 'gasp') {
        // Hands on heads
        ctx.beginPath();
        ctx.moveTo(sh.x - bw * 0.45, sh.y);
        ctx.lineTo(head.x - 0.1 * s, head.y - 0.05 * s);
        ctx.moveTo(sh.x + bw * 0.45, sh.y);
        ctx.lineTo(head.x + 0.1 * s, head.y - 0.05 * s);
        ctx.stroke();
      } else if (stand) {
        const wv = reduceMotion ? 0 : Math.sin(t * 8 + ph) * 0.06;
        arm(-0.22 + wv, -0.4);
        arm(0.22 + wv, -0.4);
        if (f.kind === 'flag') {
          const hx = sh.x + (0.22 + wv) * s;
          const hy = sh.y - 0.4 * s;
          ctx.strokeStyle = '#ddd';
          ctx.lineWidth = Math.max(1, 0.03 * s);
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx, hy - 0.45 * s);
          ctx.stroke();
          ctx.fillStyle = f.flag;
          ctx.beginPath();
          ctx.moveTo(hx, hy - 0.45 * s);
          ctx.quadraticCurveTo(hx + 0.2 * s, hy - (0.5 + wv) * s, hx + 0.38 * s, hy - 0.42 * s);
          ctx.lineTo(hx + 0.38 * s, hy - 0.2 * s);
          ctx.quadraticCurveTo(hx + 0.2 * s, hy - (0.26 - wv) * s, hx, hy - 0.22 * s);
          ctx.fill();
        }
      } else if (M.hype > 0.25 && !reduceMotion) {
        // Polite applause
        const c = Math.abs(Math.sin(t * 14 + ph)) * 0.05;
        arm(-0.02 - c, -0.12);
        arm(0.02 + c, -0.12);
      } else if (f.person) {
        // Sitting quietly: arms folded, a sip of a drink, chin in hand, or a phone
        const P = f.person;
        const pose = P.pose === 'fan' || P.pose === 'point' ? 'folded' : P.pose;
        if (pose === 'rest') {
          // Forearms resting in the lap, hands together
          const lap = base.y - 0.06 * s;
          ctx.strokeStyle = shadeHex(f.body, -0.12);
          ctx.lineWidth = Math.max(1, 0.06 * s);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(sh.x - bw * 0.45, sh.y + 0.12 * s);
          ctx.lineTo(sh.x - 0.03 * s, lap);
          ctx.moveTo(sh.x + bw * 0.45, sh.y + 0.12 * s);
          ctx.lineTo(sh.x + 0.03 * s, lap);
          ctx.stroke();
          ctx.fillStyle = f.skin;
          ctx.beginPath();
          ctx.arc(sh.x, lap, 0.035 * s, 0, Math.PI * 2);
          ctx.fill();
        } else if (pose === 'folded') {
          ctx.fillStyle = shadeHex(f.body, -0.12);
          roundRect(ctx, sh.x - bw * 0.42, sh.y + 0.06 * s, bw * 0.84, 0.08 * s, 0.03 * s);
          ctx.fill();
        } else if (pose === 'drink') {
          const sip = reduceMotion ? 0 : Math.max(0, Math.sin(t * 0.7 + ph)) * 0.08;
          arm(0.08, -0.16 - sip);
          ctx.fillStyle = P.cup;
          ctx.fillRect(sh.x + 0.05 * s, sh.y - (0.24 + sip) * s, 0.06 * s, 0.08 * s);
        } else if (pose === 'chin') {
          ctx.beginPath();
          ctx.moveTo(sh.x + bw * 0.2, sh.y + 0.1 * s);
          ctx.lineTo(head.x, head.y + 0.1 * s);
          ctx.stroke();
        } else if (pose === 'phone') {
          ctx.fillStyle = '#16181c';
          ctx.fillRect(sh.x - 0.035 * s, sh.y + 0.02 * s, 0.07 * s, 0.1 * s);
        }
      }
    }
  }

  // The rare thrown racket incident. Same throw, same instant default and ten times the fine, but where it lands
  // depends on the venue. The Royal Box only exists at the Grand Slam final.
  const INCIDENTS = {
    royal: {
      title: 'ROYAL BOX INCIDENT', say: "One's scone!", extra: 'plus a new hat',
      lines: ['The racket has landed in the Royal Box. So, effectively, have you.', 'Thrown into the Royal Box. A cucumber sandwich has been lost with all hands.'],
      over: ['Your racket was last seen in the Royal Box, beside a scone it ruined. You have been defaulted, fined, and asked to leave the county. Odds of that: 1 in {odds}.', 'Defaulted. The Royal Box would like your address, so it can return the racket and send a bill for the hat. Odds of that: 1 in {odds}.']
    },
    teahut: {
      title: 'TEA HUT INCIDENT', say: 'My sponge!', extra: 'plus a new Victoria sponge',
      lines: ['Through the tea hut hatch and into the Victoria sponge. The committee has convened.', 'The racket went in for a cup of tea. It did not wipe its feet.'],
      over: ['The racket went through the tea hut hatch and into the Victoria sponge. The committee met over what was left of it and defaulted you. Odds of that: 1 in {odds}.', 'Defaulted by the club committee, in writing, on headed paper, with a crumb on it. Odds of that: 1 in {odds}.']
    },
    greenhouse: {
      title: 'GREENHOUSE INCIDENT', say: 'OI! MY TOMATOES!', extra: 'plus twelve panes of glass',
      lines: ['Over the fence and through a neighbour\'s greenhouse. The tomatoes did not make it.', 'The racket cleared the fence, two gardens and most of a greenhouse.'],
      over: ['Your racket went over the fence and through a greenhouse. The neighbour has the racket, the tournament has defaulted you, and the tomatoes have a lawyer. Odds of that: 1 in {odds}.', 'Defaulted. The neighbour is keeping the racket as evidence. Odds of that: 1 in {odds}.']
    },
    alarm: {
      title: 'FIRE ALARM INCIDENT', say: 'Everybody out!', extra: 'plus the fire brigade\'s call out',
      lines: ['Straight into the fire alarm. The whole leisure centre is now standing in the car park.', 'The racket set off the fire alarm. The swimming gala is out on the pavement in towels.'],
      over: ['You hit the fire alarm with a racket from the baseline. Grimsby Leisure Centre was evacuated and you were defaulted in the car park. Odds of that: 1 in {odds}.', 'Defaulted, in the car park, next to the aqua aerobics class. Odds of that: 1 in {odds}.']
    },
    clock: {
      title: 'CLOCK INCIDENT', say: 'Time!', extra: 'plus a clockmaker',
      lines: ['The racket hit the pavilion clock. It stopped at the exact moment you lost your temper.', 'Time stood still. Then the clock fell off. The match did not resume.'],
      over: ['You stopped the Tunbridge pavilion clock with a racket. It has been there since 1887. You have been defaulted, and the clock will be kept as it is, as a warning. Odds of that: 1 in {odds}.', 'Defaulted. The clock now shows the time forever: the moment you lost it. Odds of that: 1 in {odds}.']
    },
    screen: {
      title: 'BIG SCREEN INCIDENT', say: 'We appear to have lost the picture.', extra: 'plus a new big screen',
      lines: ['The racket went straight through the big screen. Millions watched it happen, briefly.', 'The big screen now shows NO SIGNAL. It also shows a racket.'],
      over: ['Your racket went through the big screen. The last thing it showed was you, throwing it. You have been defaulted. Odds of that: 1 in {odds}.', 'Defaulted. The big screen is being replaced, and the replay of the incident is being shown on the new one. Odds of that: 1 in {odds}.']
    }
  };
  function incidentKey(cfg) {
    if (cfg.mode === 'career' && cfg.tierIdx === TIERS.length - 1 && cfg.round === 2) return 'royal';
    return { club: 'teahut', council: 'greenhouse', leisure: 'alarm', invitational: 'clock', slam: 'screen' }[venueKey(cfg)] || 'teahut';
  }
  function farRimY() {
    const G = bgCache && bgCache.geo;
    return G ? proj(0, G.YF + G.N * G.D, G.rimZ).y : 120;
  }
  // Where the big screen hangs, in screen pixels
  function bigScreenRect() {
    const G = bgCache && bgCache.geo;
    if (!G) return { x: 760, y: 60, w: 220, h: 120 };   // not drawn yet (only in a test that never renders)
    const yb = G.YF + G.N * G.D - 0.3;
    const zTop = G.rimZ - 0.6 - BIG_SCREEN.drop[G.VK];
    const zBot = Math.max(G.V.wallH + 0.4, G.rimZ - 4.2 - BIG_SCREEN.drop[G.VK]);
    const a = proj(G.V.x0 + BIG_SCREEN.x, yb, zTop);
    const b = proj(G.V.x0 + BIG_SCREEN.x + (zTop - zBot) * 2.2, yb, zBot);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  // The Tunbridge pavilion clock, and where it lands when it falls off: the front of the far stand
  function clockSpots() {
    const G = bgCache && bgCache.geo;
    if (!G) return { top: { x: 640, y: 90 }, land: { x: 640, y: 160 } };
    const l = proj(0.6, G.YF + 0.3, G.V.wallH + 0.2);
    return { top: { x: 640, y: farRimY() - 30 }, land: { x: l.x, y: l.y } };
  }
  // Where the thrown racket lands, in screen pixels
  function incidentTarget() {
    const k = MD.incident || 'royal';
    if (k === 'royal') return ROYAL_BOX;
    if (k === 'teahut') { const p = proj((TEA_HUT.x0 + TEA_HUT.x1) / 2, TEA_HUT.y0 - 0.05, 1.4); return { x: p.x, y: p.y }; }
    if (k === 'greenhouse') return { x: 1010, y: farRimY() - 24 };
    if (k === 'alarm') return { x: 790, y: farRimY() - 26 };
    if (k === 'clock') { const s = clockSpots(); return MD.t > SMASH_T + 1.6 ? s.land : s.top; }
    const r = bigScreenRect();
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  // The scene at the landing site, before and after the racket arrives
  function drawIncident(ctx) {
    const k = MD.incident || 'royal';
    if (k === 'royal') { drawRoyalBox(ctx); return; }
    const b = incidentTarget();
    const hitT = MD.t - (SMASH_T + 1.3);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (k === 'greenhouse') {
      // A greenhouse over the fence, glass and white frames
      ctx.fillStyle = hitT > 0 ? 'rgba(160,210,220,0.25)' : 'rgba(170,220,230,0.7)';
      ctx.fillRect(b.x - 40, b.y - 14, 80, 30);
      ctx.beginPath();
      ctx.moveTo(b.x - 44, b.y - 14);
      ctx.lineTo(b.x, b.y - 34);
      ctx.lineTo(b.x + 44, b.y - 14);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#f4f1e6';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x - 40, b.y - 14, 80, 30);
      for (let x = -20; x <= 20; x += 20) { ctx.beginPath(); ctx.moveTo(b.x + x, b.y - 14); ctx.lineTo(b.x + x, b.y + 16); ctx.stroke(); }
      if (hitT > 0) {
        ctx.fillStyle = '#c8102e';
        for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(b.x - 25 + i * 10, b.y + 6 + Math.min(10, hitT * 40) * ((i % 2) + 0.5), 3.5, 0, Math.PI * 2); ctx.fill(); }
      }
    } else if (k === 'alarm') {
      // A fire alarm call point and bell on the sports hall wall
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(b.x - 11, b.y - 11, 22, 22);
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(b.x - 6, b.y - 6, 12, 12);
      ctx.fillStyle = '#c8102e';
      ctx.beginPath();
      ctx.arc(b.x + 34, b.y - 4, 10, Math.PI, 0);
      ctx.fill();
      if (hitT > 0) {
        // Bell ringing and the hall's strobes
        const on = Math.floor(hitT * 6) % 2 === 0;
        ctx.strokeStyle = '#ffefc2';
        ctx.lineWidth = 2;
        [14, 20].forEach((r) => { ctx.beginPath(); ctx.arc(b.x + 34, b.y - 4, r, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); });
        if (on && !reduceMotion) { ctx.fillStyle = 'rgba(255,40,30,0.12)'; ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY); }
      }
    } else if (k === 'clock') {
      // Hit, the hands spin, then the whole clock falls off the pavilion into the front of the far stand
      if (hitT > 0) {
        const s = clockSpots();
        ctx.fillStyle = '#173827';
        ctx.beginPath();
        ctx.arc(s.top.x, s.top.y, 19, 0, Math.PI * 2);
        ctx.fill();
        const f = clamp((hitT - 0.25) / 0.55, 0, 1);
        const cx = lerp(s.top.x, s.land.x, f);
        const cy = lerp(s.top.y, s.land.y, f * f);
        const spin = Math.min(hitT, 0.8) * 30;
        ctx.fillStyle = '#f4f1e6';
        ctx.strokeStyle = '#173827';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.sin(spin) * 13, cy - Math.cos(spin) * 13);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.sin(spin * 0.3 + 2) * 9, cy - Math.cos(spin * 0.3 + 2) * 9);
        ctx.moveTo(cx - 12, cy - 10);
        ctx.lineTo(cx + 2, cy + 4);
        ctx.lineTo(cx + 10, cy + 14);
        ctx.stroke();
        drawRacketShape(ctx, { x: cx - 10, y: cy + 8, ang: -0.35, len: RL * 0.22, color: playerKit().racket, crack: true });
      }
    } else if (k === 'screen') {
      if (hitT > 0) {
        const r = bigScreenRect();
        ctx.fillStyle = '#05080a';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (!reduceMotion) {
          for (let i = 0; i < 40; i++) {
            ctx.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.25).toFixed(2) + ')';
            ctx.fillRect(r.x + Math.random() * r.w, r.y + Math.random() * r.h, r.w * 0.06, 2);
          }
        }
        ctx.fillStyle = '#f4f1e6';
        ctx.font = 'bold ' + Math.round(r.h * 0.22) + 'px "Lilita One", Impact, sans-serif';
        ctx.fillText('NO SIGNAL', r.x + r.w / 2, r.y + r.h * 0.72);
        ctx.strokeStyle = 'rgba(244,241,230,0.8)';
        ctx.lineWidth = 1.5;
        [[0, -1], [0.8, -0.4], [0.9, 0.6], [-0.7, 0.7], [-0.9, -0.3]].forEach((d) => {
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x + d[0] * r.w * 0.3, b.y + d[1] * r.h * 0.45);
          ctx.stroke();
        });
      }
    } else if (k === 'teahut' && hitT > 0) {
      // Sponge and crumbs out of the hatch
      ctx.fillStyle = '#f0d9a8';
      for (let i = 0; i < 8; i++) {
        const an = i / 8 * Math.PI * 2;
        const d = 4 + 18 * Math.min(1, hitT * 3);
        ctx.fillRect(b.x + Math.cos(an) * d, b.y + Math.sin(an) * d * 0.6 + 14 * Math.min(1, hitT * 2), 4, 4);
      }
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(b.x - 8, b.y + 2, 16, 3);
    }
    if (hitT > 0) {
      if (k !== 'clock') drawRacketShape(ctx, { x: b.x - 10, y: b.y + 8, ang: -0.35, len: RL * 0.22, color: playerKit().racket, crack: true });
      if (hitT > 0.35) {
        const I = INCIDENTS[k];
        ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
        const w = ctx.measureText(I.say).width + 18;
        const bx = clamp(b.x + 20, 10, W - w - 10);
        const by = Math.max(14, b.y - 62);
        ctx.fillStyle = '#ffefc2';
        roundRect(ctx, bx, by, w, 28, 7);
        ctx.fill();
        ctx.fillStyle = '#b3261e';
        ctx.textAlign = 'left';
        ctx.fillText(I.say, bx + 9, by + 14);
      }
    }
    ctx.restore();
  }
  function royalActive() {
    return tantrumOnCourt() && MD.style.id === 'royal';
  }
  function royalRelease() {
    const fp = proj(M.player.x, M.player.y, 0);
    const sc = fp.s * 0.88 / KP;
    return { x: fp.x + 0.15 * KP * sc, y: fp.y + (205 - FLOOR_Y) * sc, sc: sc };
  }
  function drawRoyalBox(ctx) {
    const b = ROYAL_BOX;
    const hitT = MD.t - (SMASH_T + 1.3);
    ctx.save();
    ctx.fillStyle = '#4b1f6b';
    ctx.fillRect(b.x - 80, b.y - 30, 160, 62);
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x - 80, b.y - 30, 160, 62);
    ctx.fillStyle = '#d4af37';
    ctx.font = 'bold 11px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ROYAL BOX', b.x, b.y - 21);
    [b.x - 38, b.x + 34].forEach((px, i) => {
      ctx.fillStyle = i ? '#7aa6c2' : '#1a1a1a';
      ctx.fillRect(px - 11, b.y + 2, 22, 26);
      ctx.fillStyle = '#f0c9a8';
      ctx.beginPath();
      ctx.arc(px, b.y - 4, 8, 0, Math.PI * 2);
      ctx.fill();
      if (i === 0) {
        // The top hat leaves when the racket arrives
        let hx = px;
        let hy = b.y - 15;
        let hrot = 0;
        if (hitT > 0) { hx += 70 * hitT; hy += -120 * hitT + 240 * hitT * hitT; hrot = hitT * 9; }
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(hrot);
        ctx.fillStyle = '#111';
        ctx.fillRect(-8, -12, 16, 13);
        ctx.fillRect(-12, 0, 24, 3);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ff3d8b';
        ctx.beginPath();
        ctx.arc(px + 5, b.y - 12, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (hitT > 0) {
        ctx.fillStyle = '#5a0f0f';
        ctx.beginPath();
        ctx.ellipse(px, b.y - 1, 2.5, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    if (hitT <= 0) {
      // Afternoon tea, for now
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(b.x - 6, b.y + 12, 9, 7);
      ctx.fillRect(b.x - 9, b.y + 19, 15, 2);
    } else {
      const k = Math.min(1, hitT * 3);
      ctx.fillStyle = 'rgba(120,70,30,0.8)';
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + 18, 10 + 14 * k, 3 + 3 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 8; i++) {
        const an = i / 8 * Math.PI * 2;
        const d = 6 + 26 * k;
        ctx.fillRect(b.x + Math.cos(an) * d, b.y + 14 + Math.sin(an) * d * 0.5 + 18 * k * k, 3, 3);
      }
      drawRacketShape(ctx, { x: b.x - 34, y: b.y + 12, ang: -0.35, len: RL * 0.22, color: playerKit().racket, crack: true });
      if (hitT > 0.35) {
        ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
        const w = ctx.measureText("One's scone!").width + 18;
        ctx.fillStyle = '#ffefc2';
        roundRect(ctx, b.x + 40, b.y - 62, w, 28, 7);
        ctx.fill();
        ctx.fillStyle = '#b3261e';
        ctx.textAlign = 'left';
        ctx.fillText("One's scone!", b.x + 49, b.y - 48);
      }
    }
    ctx.restore();
  }
  function drawRoyalFlight(ctx) {
    if (MD.t < SMASH_T) return;
    const u = clamp((MD.t - SMASH_T) / 1.3, 0, 1);
    if (u >= 1) return;
    const r = royalRelease();
    const b = incidentTarget();
    const x = lerp(r.x, b.x - 30, u);
    const y = lerp(r.y, b.y + 10, u) - 220 * 4 * u * (1 - u);
    drawRacketShape(ctx, { x: x, y: y, ang: (MD.t - SMASH_T) * 22, len: RL * r.sc * lerp(1, 0.25, u), color: playerKit().racket });
  }
  // Press photographers in the stand, firing away whenever there is a tantrum to capture
  function drawFlashes(ctx) {
    if (reduceMotion) return;
    for (let i = 0; i < 8; i++) {
      const cyc = M.time * 2.4 + i * 0.618;
      const fr = cyc - Math.floor(cyc);
      if (fr > 0.08) continue;
      const n = Math.floor(cyc) * 7 + i * 13;
      const x = (n * 197 + i * 83) % W;
      const y = 18 + (n * 53) % 105;
      const a = 1 - fr / 0.08;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, 28);
      gr.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(2) + ')');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(x - 28, y - 28, 56, 56);
    }
  }

  function drawNet(ctx) {
    const top = [];
    for (let i = 0; i <= 20; i++) {
      const x = -6.4 + i * 0.64;
      const hgt = 0.914 + 0.156 * Math.pow(Math.abs(x) / 6.4, 2);
      top.push(proj(x, C.net, hgt));
    }
    const left = proj(-6.4, C.net, 0);
    const right = proj(6.4, C.net, 0);
    ctx.fillStyle = 'rgba(20,20,20,0.5)';
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    top.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 20; i++) {
      const b = proj(-6.4 + i * 0.64, C.net, 0);
      ctx.beginPath();
      ctx.moveTo(top[i].x, top[i].y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      top.forEach((p, i) => {
        const b = proj(-6.4 + i * 0.64, C.net, 0);
        const y = lerp(p.y, b.y, k / 4);
        if (i) ctx.lineTo(p.x, y); else ctx.moveTo(p.x, y);
      });
      ctx.stroke();
    }
    // The centre strap holds the middle down to 0.914 m
    quad(ctx, [[-0.03, C.net, 0], [0.03, C.net, 0], [0.03, C.net, 0.914], [-0.03, C.net, 0.914]], '#f4f4ee');
    // The white headband along the top, 6 cm deep
    ctx.fillStyle = '#f4f4ee';
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const x = -6.4 + i * 0.64;
      const hgt = 0.914 + 0.156 * Math.pow(Math.abs(x) / 6.4, 2);
      const q = proj(x, C.net, hgt);
      if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
    }
    for (let i = 20; i >= 0; i--) {
      const x = -6.4 + i * 0.64;
      const hgt = 0.914 + 0.156 * Math.pow(Math.abs(x) / 6.4, 2) - 0.065;
      const q = proj(x, C.net, hgt);
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = '#d9d9d0';
    [[-6.4], [6.4]].forEach((x) => {
      const b = proj(x[0], C.net, 0);
      const t = proj(x[0], C.net, 1.07);
      ctx.fillRect(b.x - 2.5, t.y, 5, b.y - t.y);
      ctx.fillStyle = '#9a9a92';
      ctx.fillRect(b.x - 3.5, t.y - 2, 7, 3);
      ctx.fillStyle = '#d9d9d0';
    });
    // Post covers carry the tournament sponsor
    const G = bgCache && bgCache.geo;
    const sid = G ? VENUE_SPONSOR[G.VK] : null;
    if (sid) {
      const sp = SPONSORS[sid];
      [-6.4, 6.4].forEach((x) => {
        const lo = proj(x, C.net, 0.12);
        const hi = proj(x, C.net, 0.98);
        const w = 0.34 * lo.s;
        ctx.fillStyle = sp.bg;
        ctx.fillRect(lo.x - w / 2, hi.y, w, lo.y - hi.y);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lo.x - w / 2, hi.y, w, lo.y - hi.y);
        sponsorMark(ctx, sid, lo.x, (lo.y + hi.y) / 2, w * 0.36, sp.fg, sp.accent);
      });
    }
  }

  /* =====================================================================
     6. Match engine
     ===================================================================== */
  let M = null;
  const SWING_WINDOW = 0.3;   // seconds either side of the ideal contact (scaled by timingHelp)
  // Timing help widens the hitting window and the PERFECT and GOOD bands. Auto is generous at the club and
  // tapers to nothing by Tunbridge; the lesson is the most generous. Always keeps the club's help everywhere.
  const TIMING_HELP = { tiers: [1.35, 1.2, 1.08, 1, 1], lesson: 1.4, daily: 1.1, always: 1.35 };
  function timingHelp() {
    if (!M) return 1;
    const set = SAVE.settings.timing || 'auto';
    if (set === 'off') return 1;
    if (M.tut) return TIMING_HELP.lesson;
    if (set === 'always') return Math.max(TIMING_HELP.always * Math.min(1, diff().timing), 1);
    if (M.cfg.mode === 'daily') return TIMING_HELP.daily;
    const base = TIMING_HELP.tiers[M.cfg.tierIdx] || 1;
    // Easy keeps the club's wide window everywhere; Hard is tighter than anywhere on Normal
    return diff().timing > 1 ? Math.max(base, diff().timing) : base * diff().timing;
  }
  const swingWindow = () => SWING_WINDOW * timingHelp();
  // How far the aim moves for a given finger movement
  const AIM_SENS = { low: 0.8, normal: 1, high: 1.2 };
  const WHIFF_WINDOW = 0.6;   // a release this close but outside the window is an air shot
  const REACH = 1.6;          // metres from the body a racket can reach
  // Reach scales with the opponent's skill (0.2 at the club to 0.92 at the Slam), and good players lose less of it to pace
  const REACH_SKILL = { base: 1.08, k: 0.15, pace: 0.5 };
  // Serve returns. Chance = base - pace x (pace - skill x paceSkill) - stretch² x (stretch - skill x stretchSkill)
  // - line placement - spin + skill x skill. Body serves: base - pace x body + skill x skill.
  // read is the returner's reaction time to a serve before skill, in seconds. Their running speed while returning
  // a serve is scaled by move + skill x moveSkill: a better player covers more of the box.
  const SERVE_RET = { base: 0.98, pace: 0.32, paceSkill: 0.1, body: 0.5, stretch: 0.6, stretchSkill: 0.2, skill: 0.15, read: 0.24, move: 1.17, moveSkill: -0.4 };
  const serveMove = () => SERVE_RET.move + SERVE_RET.moveSkill * M.cfg.skill;

  function effectiveStrict(base) {
    return clamp(base - (SAVE.reputationScore / 100) * 0.22, 0.05, 0.95);
  }
  // Swat the Thoughts: how hard a meltdown is. Each meltdown in a match brings more angry thoughts, rising faster,
  // with more calm decoys among them; a strict umpire speeds them up. The first one of a match is the easiest.
  function meltWave(strict, nth, tut) {
    if (tut) return { angry: 5, calm: 1, speed: 120, gap: 0.6, strikes: 3 };
    nth = nth || 0;
    // Tuned with a bot with human limits (0.35 s to read a bubble, a tap every 0.25 s at most, 20 px of aim error,
    // 6% misreads): it passes about 100%, 75%, 58% and 33% of first to fourth meltdowns. Tapping every bubble
    // or mashing the screen fails the first one every time, because of the calm decoys.
    // Keeping it in should be a real fight from the first time (players found the old one far too easy), and by the
    // fourth or fifth time in a match the thoughts come faster than a thumb can tap: the racket is going.
    return {
      angry: Math.min(20, 12 + 2 * nth),
      calm: Math.min(7, 3 + nth),
      speed: Math.min(400, 270 + 45 * strict + 25 * nth),
      gap: Math.max(0.14, 0.23 - 0.02 * nth - 0.04 * strict),
      // Keeping it in is a short-term fix: every time you do it in a match, you have less room for error
      // (3, then 2, 2, 2, then 1 strike), so sooner or later the racket is the smart choice
      strikes: nth >= 4 ? 1 : nth >= 1 ? 2 : 3
    };
  }
  // Boiling point is a choice. Smash it: the rage goes (down to smash), at the price of a racket, a fine and a
  // code violation. Keep it in: the thoughts mini-game; win it and you play on hot (held), lose it and the racket
  // gets it anyway with less of the rage gone (lost). Nobody choosing within choose seconds: the temper decides.
  const VENT = { smash: 0.1, held: 0.8, lost: 0.4, choose: 3 };
  const ANGRY_THOUGHTS = ['THAT WAS IN!', 'BLIND!', 'WHY ME?!', 'CHEAT!', 'UNBELIEVABLE!', 'THE WIND!', 'THESE STRINGS!', 'EVERYONE SAW IT!', 'RIGGED!', 'I HATE GRASS!', 'GET A NEW UMPIRE!', 'NOT AGAIN!', 'SERIOUSLY?!', 'THIS RACKET!'];
  const CALM_THOUGHTS = ['BREATHE', 'LET IT GO', 'ONLY TENNIS', 'COUNT TO TEN', 'HAPPY PLACE', 'NEXT POINT'];
  // A tap at pos (stage pixels) swats the highest thought under it; with no position (Space), the highest of all
  function swatThought(pos) {
    const live = MD.thoughts.filter((th) => !th.done);
    let hit = null;
    if (!pos) hit = live.sort((a, b) => a.y - b.y)[0] || null;
    else {
      // The thought has risen a little by the time the thumb lands, so the area reaches further below it;
      // of two under the thumb, the nearer one
      const lag = (MD.wave ? MD.wave.speed : 300) * 0.15;
      const ax = (th) => th.w / 2 + 28;
      const near = (th) => Math.hypot((pos.x - th.x) / ax(th), (pos.y - th.y - lag / 2) / (48 + lag / 2));
      hit = live.filter((th) => Math.abs(pos.x - th.x) <= ax(th) && pos.y >= th.y - 48 && pos.y <= th.y + 48 + lag).sort((a, b) => near(a) - near(b))[0] || null;
    }
    if (!hit) {
      if (pos) MD.pops.push({ x: pos.x, y: pos.y, t: 0, miss: true });
      return null;
    }
    hit.done = true;
    MD.pops.push({ x: hit.x, y: hit.y, t: 0, calm: hit.calm });
    if (hit.calm) {
      // Swatting a calm thought: you have talked yourself out of calming down
      MD.strikes++;
      MD.flash = 1;
      sfx('chime', { good: false });
      vibrate([30, 30, 30]);
    } else {
      sfx('click');
      sfx('breath', { power: 0.5 + Math.random() * 0.3 });
      vibrate(10);
    }
    return hit;
  }
  const BOIL_Y = 236;        // the line a thought must not reach: boiling point

  const season = () => SAVE.season || 1;
  // Each season after the first: opponents 5% sharper (to a ceiling), prize money half as much again
  const SEASON = { skill: 0.05, maxSkill: 0.97, prize: 0.5 };
  const seasonPrizeK = () => 1 + SEASON.prize * (season() - 1);
  const seasonOpp = (o) => (season() > 1 ? Object.assign({}, o, { skill: Math.min(SEASON.maxSkill, o.skill + SEASON.skill * (season() - 1)) }) : o);
  function careerMatchConfig() {
    const tier = TIERS[SAVE.careerTier];
    const opp = seasonOpp(careerOpponent(SAVE.careerTier, SAVE.tournamentRound));
    const seed = (Math.random() * 4294967295) >>> 0;
    const wr = makeLCG(seed ^ 0x9e3779b9);
    const wind = tier.windMax ? Math.round(wr.range(-tier.windMax, tier.windMax)) : 0;
    return {
      mode: 'career',
      tierIdx: SAVE.careerTier,
      round: SAVE.tournamentRound,
      label: tier.short + ' ' + ROUNDS[SAVE.tournamentRound],
      surface: tier.surface,
      games: tier.games,
      opp: opp,
      skill: opp.skill,
      strict: effectiveStrict(tier.strict),
      ref: tier.ref,
      cheatRate: tier.cheat,
      wind: wind,
      fine: tier.fine,
      rackets: SAVE.remainingRackets,
      maxRackets: 5,
      crowd: tier.crowd,
      seed: seed
    };
  }

  // A Quick Match: first to 3 games against someone from a tour you have reached, at their venue.
  // Nothing on the career changes; a win pays a tenth of a quarter final's prize, so it cannot outpace the tour.
  const QUICK = { games: 3, rackets: 3, prizeK: 0.1 };
  // The economy's other levers. Fines are paid from prize money after the match's winnings, never below zero.
  // A spare racket bought in the hub costs a share of the current tour's quarter final prize.
  const ECON = { dailyFine: 250, spareK: 0.3 };
  /* ---- The shop. Products and their prices come from billing.js (RRStore); what they unlock lives here. ---- */
  const SHOP = {
    pack_bad_loser: { name: 'Bad Loser Pack', line: 'Three tantrums: Chewed, Bounced and Fore!' },
    pack_show_off: { name: 'Show Off Pack', line: 'Three celebrations: Theatre Bow, Mic Drop and The Selfie' },
    pack_bundle: { name: 'Both Packs', line: 'All six, for less than the two apart' },
    pro_pack: { name: 'Pro Pack', line: 'Every advert reward without the advert. 1.5x prize money. The Supporter Kit and racket.' }
  };
  const PACK_OF = { pack_bundle: ['pack_bad_loser', 'pack_show_off'] };
  function hasProduct(id) {
    const p = SAVE.purchases || [];
    return p.indexOf(id) >= 0 || Object.keys(PACK_OF).some((b) => p.indexOf(b) >= 0 && PACK_OF[b].indexOf(id) >= 0);
  }
  const isPro = () => hasProduct('pro_pack');
  // The items a player can get here: shop-pack items only where the shop exists (not on the web), or already owned
  const lockerList = (cat) => LOCKER[cat].filter((it) => !it.pack || !!window.RRStore || hasProduct(it.pack));
  const proK = () => (isPro() ? 1.5 : 1);
  // What the store says you own becomes Locker items you own. Called at start up and after every purchase.
  function syncPurchases(list) {
    SAVE.purchases = (list || []).slice();
    Object.keys(LOCKER_INDEX).forEach((id) => {
      const it = LOCKER_INDEX[id];
      if (it.pack && hasProduct(it.pack) && SAVE.locker.owned.indexOf(id) < 0) SAVE.locker.owned.push(id);
    });
    persist();
    if (FSM.name === 'LOCKER_ROOM' && FSM.state.renderItems) FSM.state.renderItems(FSM.scope);
  }
  function openShop(focus) {
    renderShop(focus);
    $('#shopModal').classList.remove('hidden');
  }
  function renderShop(focus) {
    const list = $('#shopList');
    list.innerHTML = '';
    const store = window.RRStore;
    const open = store && store.available();
    const prods = store ? store.products() : [];
    prods.forEach((p) => {
      const info = SHOP[p.id];
      const owned = hasProduct(p.id) || (PACK_OF[p.id] && PACK_OF[p.id].every(hasProduct));
      // The bundle is only a bargain if you own neither pack
      if (PACK_OF[p.id] && !owned && PACK_OF[p.id].some(hasProduct)) return;
      const row = document.createElement('div');
      row.className = 'shop-row' + (p.id === focus ? ' focus' : '') + (p.id === 'pro_pack' ? ' pro' : '');
      row.innerHTML = '<div><b></b><small></small></div><button type="button" class="btn small"></button>';
      // Before the store has products (the playtest), each pack shows its launch price beside its name
      row.querySelector('b').textContent = info.name + (open || owned ? '' : '  ' + p.price);
      row.querySelector('small').textContent = info.line;
      const b = row.querySelector('button');
      b.textContent = owned ? 'Owned' : open ? p.price : 'Available at launch';
      b.disabled = owned || !open;
      b.classList.add(owned ? 'ghost' : 'primary');
      b.addEventListener('click', () => {
        sfx('click');
        b.disabled = true;
        $('#shopMsg').textContent = 'Talking to the store...';
        store.buy(p.id).then((r) => {
          if (r.ok) {
            sfx('coins');
            renderShop();
            $('#shopMsg').textContent = info.name + ' is yours. Thank you for backing the game.';
          } else {
            b.disabled = false;
            $('#shopMsg').textContent = r.reason === 'cancelled' ? 'No charge made.' : r.reason === 'pending' ? 'Payment pending. It unlocks as soon as it clears.' : 'The store could not complete that. Nothing was charged.';
          }
        });
      });
      list.appendChild(row);
    });
    $('#shopMsg').textContent = open ? 'One-off purchases. No subscriptions. Packs are for fun, not for winning.' : 'Packs go on sale when the game launches. One-off purchases, no subscriptions, and they are for fun, not for winning.';
  }
  function initShop() {
    const store = window.RRStore;
    $('#btnShopClose').addEventListener('click', () => { sfx('click'); $('#shopModal').classList.add('hidden'); });
    $('#btnShopRestore').addEventListener('click', () => {
      sfx('click');
      if (!store) return;
      $('#shopMsg').textContent = 'Checking your purchases...';
      store.restore().then((r) => {
        $('#shopMsg').textContent = r.ok ? (r.owned.length ? 'Restored: ' + r.owned.map((id) => SHOP[id].name).join(', ') + '.' : 'Nothing to restore on this account.') : 'Could not reach the store. Try again later.';
        const m = $('#shopMsg').textContent;
        renderShop();
        $('#shopMsg').textContent = m;
      });
    });
    if (!store) return;
    store.onChange((list) => syncPurchases(list));
    store.init().then(() => syncPurchases(store.products().filter((p) => p.owned).map((p) => p.id)));
  }
  // Rewarded adverts: at most four a day, so the game never feels like an advert player.
  // The Pro Pack skips adverts entirely. The Spare Racket Import is a rescue: always offered, and it never uses one of the
  // day's 4 slots, so a rescue cannot hide the optional offers for the rest of the day.
  const AD_CAP = 4;
  function adsToday() {
    const L = SAVE.adLog;
    return L && L.day === dateKey() ? L.n : 0;
  }
  function countAd() {
    SAVE.adLog = { day: dateKey(), n: adsToday() + 1 };
    persist();
  }
  const adsLive = () => !!(window.RRCG && RRCG.adsLive);
  const adOk = () => adsLive() && (isPro() || adsToday() < AD_CAP);
  function payFines(res) {
    const paid = Math.min(SAVE.prizeMoney, M.fines || 0);
    SAVE.prizeMoney -= paid;
    res.finesPaid = paid;
    res.finesWaived = (M.fines || 0) - paid;
  }
  function sparePrice(tierIdx) {
    return Math.round(TIERS[tierIdx].prize * ECON.spareK);
  }
  // The next thing worth saving for: the cheapest item you do not own and cannot yet afford
  function nextGoal() {
    const all = Object.keys(LOCKER_INDEX).map((id) => LOCKER_INDEX[id]).filter((it) => it.price > 0 && SAVE.locker.owned.indexOf(it.id) < 0);
    if (!all.length) return null;
    all.sort((a, b) => a.price - b.price);
    return all.find((it) => it.price > SAVE.prizeMoney) || all[all.length - 1];
  }
  // Web: a first-time player's first match. Straight in, no menus: the easiest opponent at the Club Open,
  // first to 2 games, and they serve first so your first job is just to hit the ball back.
  function firstConfig() {
    const tier = TIERS[0];
    const opp = Object.assign({}, OPPONENTS[0][0], { skill: 0.16 });
    return Object.assign(quickConfig(), { first: true, tierIdx: 0, label: 'Your First Match', surface: tier.surface, games: 2, opp: opp, skill: opp.skill, strict: effectiveStrict(tier.strict), ref: tier.ref, cheatRate: 0, wind: 0, fine: Math.max(10, Math.round(tier.fine * QUICK.prizeK)), crowd: tier.crowd });
  }
  function quickConfig() {
    const top = SAVE.careerComplete ? TIERS.length - 1 : SAVE.careerTier;
    const tierIdx = Math.floor(Math.random() * (top + 1));
    const tier = TIERS[tierIdx];
    const pool = (SAVE.season || 1) > 1 ? OPPONENTS[tierIdx].concat(OPPONENTS_B[tierIdx]) : OPPONENTS[tierIdx];
    const opp = pool[Math.floor(Math.random() * pool.length)];
    const seed = (Math.random() * 4294967295) >>> 0;
    const wr = makeLCG(seed ^ 0x9e3779b9);
    return {
      mode: 'quick',
      tierIdx: tierIdx,
      round: 0,
      label: 'Quick Match',
      surface: tier.surface,
      games: QUICK.games,
      opp: opp,
      skill: opp.skill,
      strict: effectiveStrict(tier.strict),
      ref: tier.ref,
      cheatRate: tier.cheat,
      wind: tier.windMax ? Math.round(wr.range(-tier.windMax, tier.windMax)) : 0,
      fine: Math.max(10, Math.round(tier.fine * QUICK.prizeK)),
      rackets: QUICK.rackets,
      maxRackets: QUICK.rackets,
      crowd: tier.crowd,
      seed: seed
    };
  }

  /* ---- Resume: the score is saved at the start of every point, so a match survives the app being closed ---- */
  const RESUME_KEEP = ['ostats', 'oppLostCount', 'points', 'games', 'server', 'tiebreak', 'tbFirst', 'secondServe', 'rage', 'peakRage', 'rackets', 'smashed', 'fines', 'violations', 'stats', 'challenges', 'owlRented', 'oppTemp', 'toll', 'streak', 'obscenities', 'lastObscenityGame'];
  function saveResume() {
    if (!M || M.tut || M.matchWinner !== null) return;
    const snap = {};
    RESUME_KEEP.forEach((k) => { if (M[k] !== undefined) snap[k] = M[k]; });
    SAVE.resume = { cfg: M.cfg, snap: snap, at: Date.now() };
    persist();
  }
  function clearResume() {
    if (SAVE.resume) { SAVE.resume = null; persist(); }
  }
  // A saved match from the last day, if there is one
  function pendingResume() {
    const r = SAVE.resume;
    if (!r || !r.cfg || !r.snap) return null;
    if (Date.now() - (r.at || 0) > 24 * 3600 * 1000) { clearResume(); return null; }
    return r;
  }
  function restoreMatch(r) {
    newMatch(r.cfg);
    Object.keys(r.snap).forEach((k) => { M[k] = r.snap[k]; });
    M.stats = Object.assign({}, M.stats, r.snap.stats || {});
    // A short intro, then straight into the next point
    M.phaseDur = 1.4;
    M.resumed = true;
  }

  function newMatch(cfg) {
    if (cfg.diff === undefined) {
      cfg = Object.assign({}, cfg);
      cfg.diff = cfg.mode === 'career' || cfg.mode === 'quick' ? diffKey() : 'normal';
      // Hard: a stricter umpire as well
      cfg.strict = Math.min(1, (cfg.strict || 0) + DIFF[cfg.diff].strict);
    }
    // A sponsor's bet placed before this tour match rides on it (and survives a resume, inside cfg)
    if (cfg.mode === 'career' && cfg.bet === undefined) {
      cfg = Object.assign({}, cfg, { bet: !!SAVE.sponsorBet });
      if (SAVE.sponsorBet) { SAVE.sponsorBet = false; persist(); }
    }
    const surf = SURFACES[cfg.surface];
    M = {
      cfg: cfg,
      surf: surf,
      rng: makeLCG(cfg.seed),
      games: [0, 0],
      points: [0, 0],
      server: cfg.first ? 1 : 0,
      secondServe: false,
      rage: 0.12,
      peakRage: 0.12,
      rackets: cfg.rackets,
      smashed: 0,
      fines: 0,
      violations: 0,
      phase: 'intro',
      phaseT: 0,
      // The first match on the web: a short walk-on, so the start card comes up fast
      phaseDur: cfg.first ? 0.5 : cfg.mode === 'tutorial' || !(cfg.mode === 'career' && (cfg.round === 2 || rivalRec(cfg.opp.name))) ? 2.6 : INTRO_TV.end,
      shot: null,
      player: { x: 0.8, y: -0.8, tx: 0.8, ty: -0.8, swing: 0, side: 1, run: 0, vx: 0, lastSqueak: 0 },
      opp: { x: -0.8, y: 24.6, tx: -0.8, ty: 24.6, swing: 0, side: -1, run: 0, vx: 0, mouth: 0, atNet: false, boost: 1 },
      aim: { x: 0, y: 20 },
      touch: { down: false, id: null, ignoreUp: false },
      keyDown: false,
      keyFlick: 0,
      rallyCount: 0,
      challenges: 3,
      challengeable: null,
      review: null,
      hype: 0,
      waveT: -1,
      waveDone: false,
      cam: { x: 0, y: 0, z: 1.05 },
      stick: { active: false, id: null, ox: 0, oy: 0, vx: 0, vy: 0 },
      keyMove: { l: false, r: false, u: false, d: false },
      chargeStart: null,
      timeScale: 1,
      hitStop: 0,
      sparks: [],
      rageFx: { jump: 0, from: 0 },
      skids: [],
      oppTemp: cfg.oppTemperStart || 0,
      oppLost: 0,
      oppTempFx: 0,
      tip: null,
      dawdle: 0,
      bigPoint: false,
      heart: null,
      celebOpen: false,
      celeb: null,
      crowdMood: null,
      tantrumShots: [],
      tut: null,
      tossT: 0,
      power: 0,
      calls: [],
      parts: [],
      debris: [],
      lastSmash: null,
      marks: [],
      floaters: [],
      speech: null,
      wobble: 0,
      time: 0,
      shake: 0,
      gameCheats: 0,
      bounceCount: 0,
      bounceT: 0,
      notReadyPending: false,
      matchWinner: null,
      tiebreak: false,
      tbFirst: 0,
      endReason: null,
      pendingObscenity: false,
      pendingFault: false,
      lastMph: 0,
      mphT: 0,
      adUsed: false,
      paused: false,
      steam: 0,
      stats: { aces: 0, winners: 0, errors: 0, doubleFaults: 0, badCalls: 0, fastest: 0, meltdowns: 0, survived: 0, pointsWon: 0, pointsLost: 0, challenges: 0, overturned: 0, pumps: 0, shots: 0, perfect: 0, lines: 0, spins: {} },
      ostats: { aces: 0, winners: 0, errors: 0 }
    };
    window.RRAudio && RRAudio.crowdLevel && RRAudio.crowdLevel(1);
    // A borrowed celebration is used up by the next real match
    if (cfg.mode !== 'tutorial' && SAVE.borrowCeleb) { M.borrow = SAVE.borrowCeleb; delete SAVE.borrowCeleb; persist(); }
    if (cfg.mode === 'tutorial') M.tut = cfg.practice
      ? { practice: cfg.practice, step: 99, count: 0, flags: {}, endPoint: false, done: false, ins: 0, best: 0 }
      : { step: tutStepFrom(0), count: 0, flags: {}, endPoint: false, done: false };
    bgCache = null;
    return M;
  }

  const isDeuceSide = () => (M.points[0] + M.points[1]) % 2 === 0;
  function tiebreakServer() {
    const n = M.points[0] + M.points[1];
    if (n === 0) return M.tbFirst;
    return Math.floor((n + 1) / 2) % 2 === 1 ? 1 - M.tbFirst : M.tbFirst;
  }
  // Whoever wins this point takes the game (tiebreak: the set)
  function pointWinsGame(w) {
    const a = M.points[w] + 1;
    const b = M.points[1 - w];
    return M.tiebreak ? a >= 7 && a - b >= 2 : a >= 4 && a - b >= 2;
  }
  function gameWinsSet(w) {
    const a = M.games[w] + 1;
    const b = M.games[1 - w];
    return M.tiebreak || (a >= M.cfg.games && a - b >= 2);
  }
  const hasTrait = (t) => M.cfg.opp.traits.indexOf(t) >= 0;

  function serviceBox(receiver, deuce) {
    // receiver 1 is the far side (them), 0 is the near side (you)
    if (receiver === 1) return { x0: deuce ? -C.hw : 0, x1: deuce ? 0 : C.hw, y0: C.net, y1: C.net + C.svc };
    return { x0: deuce ? 0 : -C.hw, x1: deuce ? C.hw : 0, y0: C.net - C.svc, y1: C.net };
  }
  function courtHalf(receiver) {
    return receiver === 1 ? { x0: -C.hw, x1: C.hw, y0: C.net, y1: C.L } : { x0: -C.hw, x1: C.hw, y0: 0, y1: C.net };
  }
  const BALL_R = 0.033;   // ball radius in metres: a ball touching any part of the line is in
  function inBox(p, b) {
    const m = BALL_R;
    return p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m;
  }
  // Distance to the nearest line a ball can be called out over. The edge along the net is skipped.
  function lineDistance(p, b) {
    const ys = [b.y0, b.y1].filter((y) => Math.abs(y - C.net) > 0.01);
    return Math.min.apply(null, [Math.abs(p.x - b.x0), Math.abs(p.x - b.x1)].concat(ys.map((y) => Math.abs(p.y - y))));
  }
  // How far outside the area a ball landed, in metres (0 if in)
  function outBy(p, b) {
    const dx = Math.max(b.x0 - p.x, p.x - b.x1, 0);
    const dy = Math.max(b.y0 - p.y, p.y - b.y1, 0);
    return Math.hypot(dx, dy);
  }
  function describeOut(m) {
    return m < 1 ? 'OUT by ' + Math.max(1, Math.round(m * 100)) + ' cm' : 'OUT by ' + m.toFixed(1) + ' m';
  }
  // Why your ball went out, so the call never looks random
  function outReason(s, area) {
    const c = s.cause;
    if (!c) return null;
    if (!inBox(c.aim, area)) return 'You aimed it out. The reticle was red.';
    const parts = [['shake', Math.hypot(c.shake.x, c.shake.y)], ['timing', Math.hypot(c.scatter.x, c.scatter.y)], ['wind', Math.abs(s.land.x - s.aim.x)]];
    parts.sort((a, b) => b[1] - a[1]);
    if (parts[0][0] === 'shake') return 'Your aim was shaking with rage. The ball went where the shake sent it.';
    if (parts[0][0] === 'wind') return 'The wind carried it ' + (s.land.x > s.aim.x ? 'right' : 'left') + '. Aim inside the lines and allow for it.';
    return c.quality === 'poor' ? 'Mistimed. A late or early swing sprays the ball.' : 'Slightly off the strings. It happens. It happens to you a lot.';
  }

  function windDrift(T1) {
    return M.cfg.wind * 0.447 * 0.09 * T1 * T1;
  }
  function flightTime(from, target, mph) {
    const v = mph * 0.447 * 0.8 * M.surf.speed;
    return Math.max(0.3, Math.hypot(target.x - from.x, target.y - from.y) / v);
  }

  // Shot types change the flight and the bounce.
  // apexK scales the arc, clear is net clearance (m), bh and bt scale the bounce height and time,
  // keep is how much pace survives the bounce.
  const SPIN = {
    flat: { apexK: 1, clear: 1.08, bh: 1, bt: 1, keep: 0.72, color: '#d9f24a', label: 'FLAT', rate: 6 },
    topspin: { apexK: 1.35, clear: 1.65, bh: 1.35, bt: 1.08, keep: 0.82, color: '#ff8a3a', label: 'TOPSPIN', rate: 32 },
    slice: { apexK: 0.75, clear: 1.0, bh: 0.5, bt: 0.78, keep: 0.6, color: '#6fd3ff', label: 'SLICE', rate: -24 },
    drop: { apex: 1.35, clear: 1.25, bh: 0.32, bt: 0.55, keep: 0.22, color: '#9fe7a0', label: 'DROP SHOT', rate: -18 },
    lob: { apex: 6.2, clear: 3, bh: 1.15, bt: 1.2, keep: 0.7, color: '#f4f1e6', label: 'LOB', rate: 12 },
    kick: { apex: 0.7, clear: 1.6, bh: 1.6, bt: 1.12, keep: 0.75, color: '#ff8a3a', label: 'KICK SERVE', rate: 36 },
    sliceServe: { apex: 0.15, clear: 1.0, bh: 0.7, bt: 0.85, keep: 0.72, color: '#6fd3ff', label: 'SLICE SERVE', rate: -26 },
    smash: { apexK: 0.4, clear: 1.0, bh: 1.2, bt: 0.9, keep: 0.8, color: '#ff3b30', label: 'SMASH', rate: 8 },
    volley: { apexK: 0.7, clear: 1.05, bh: 0.9, bt: 0.9, keep: 0.68, color: '#d9f24a', label: 'VOLLEY', rate: 4 }
  };
  const NET_POS = 14.6;   // where an opponent stands to volley
  // Difficulty. Normal is the game as tuned. The lesson and the Daily always play at Normal, so everyone's Daily
  // is the same match. Prize money is the same on Easy; Hard pays more, and so does its Red Zone.
  //   serveBar: your power bar's rise time (bigger is slower)   timing: the hitting window, times the usual
  //   oppSpeed: how fast they run   oppErr: added to their error chance   oppServe: their serve speed
  //   rage: rage you gain, times   melt: meltdown thought speed, gap and extra strikes, and the share of angry
  //   thoughts that arrive dressed as calm ones   read: they read a shot you have played three times running
  const DIFF = {
    easy: { serveBar: 1.25, ace: 0.3, timing: 1.35, oppSpeed: 0.92, oppErr: 0.05, oppServe: 0.85, rage: 0.85, melt: { speed: 0.78, gap: 1.15, strikes: 1, turn: 0 }, strict: 0, prize: 1, red: 1, read: false, aimMiddle: true },
    normal: { serveBar: 1, ace: 1, timing: 1, oppSpeed: 1, oppErr: 0, oppServe: 1, rage: 1, melt: { speed: 1, gap: 1, strikes: 0, turn: 0 }, strict: 0, prize: 1, red: 1, read: false, aimMiddle: false },
    hard: { serveBar: 0.88, ace: 1.6, timing: 0.85, oppSpeed: 1.05, oppErr: -0.03, oppServe: 1.04, rage: 1.2, melt: { speed: 1.1, gap: 0.92, strikes: 0, turn: 0.3 }, strict: 0.2, prize: 1.5, red: 1.5, read: true, aimMiddle: false }
  };
  // Your chosen difficulty. Gentle mode, from before there were three, counts as Easy.
  function diffKey() { return SAVE.settings.difficulty || (SAVE.settings.gentle ? 'easy' : 'normal'); }
  // The difficulty of the match being played: fixed when it starts
  function diff() { return DIFF[M && M.cfg && M.cfg.diff] || DIFF.normal; }
  // A lob over an opponent at the net: they lose read seconds turning round, run back at run times their speed,
  // and play it over their shoulder with err (less errSkill times their skill) more chance of an error
  const LOBBED = { read: 0.08, run: 1.05, err: 0.18, errSkill: 0.12 };

  function makeShot(from, target, mph, o) {
    o = o || {};
    const spin = o.spin || 'flat';
    const sp = SPIN[spin];
    const T1 = flightTime(from, target, mph) * (spin === 'lob' ? 1.25 : 1);
    const land = { x: target.x + windDrift(T1), y: target.y };
    let apex = sp.apex !== undefined ? sp.apex : (o.serve ? 0.15 : clamp(1.75 - mph / 100, 0.45, 1.6) * sp.apexK);
    const sNet = (C.net - from.y) / (land.y - from.y);
    let netted = false;
    let netT = 0;
    let netZ = 0;
    if (sNet > 0 && sNet < 1) {
      const zl = from.z * (1 - sNet);
      const bell = 4 * sNet * (1 - sNet);
      if (o.net) apex = Math.max(0, (0.45 - zl) / bell);
      else apex = Math.max(apex, (sp.clear - zl) / bell);
      netZ = zl + apex * bell;
      if (netZ < 0.92) { netted = true; netT = sNet * T1; }
    }
    const sm = ((SURF_PLAY[M.cfg.surface] || SURF_PLAY.hard).spin[spin]) || {};
    const T2 = clamp(1.05 - (mph - 50) / 170, 0.5, 1.05) * M.surf.bounceT * sp.bt * (sm.bt || 1);
    const vx = (land.x - from.x) / T1 * sp.keep * (sm.keep || 1) + (o.curveX || 0);
    const vy = (land.y - from.y) / T1 * sp.keep * (sm.keep || 1);
    const apex2 = clamp(0.75 + mph / 170, 0.9, 1.5) * M.surf.bounceH * sp.bh * (sm.bh || 1);
    // When the receiver meets it: near the top of the bounce, but no deeper than 3.2 m behind their baseline
    const toPlayer = o.hitter === 1;
    const limit = toPlayer ? -3.2 : C.L + 3.2;
    let after = 0.55 * T2;
    const yAt = land.y + vy * after;
    if ((toPlayer && yAt < limit) || (!toPlayer && yAt > limit)) after = Math.max(0.12, (limit - land.y) / vy);
    let tc = T1 + after;
    // An opponent at the net meets the ball in the air, unless it is sailing well out or over their head
    let volley = false;
    let lobbed = false;
    if (!toPlayer && o.oppAtNetY && !o.net && land.y > o.oppAtNetY + 0.3) {
      const sV = (o.oppAtNetY - from.y) / (land.y - from.y);
      if (sV > 0 && sV < 1) {
        const zV = from.z * (1 - sV) + apex * 4 * sV * (1 - sV);
        if (zV > 2.9) lobbed = true;
        else if (outBy(land, courtHalf(1)) < 0.3) { volley = true; tc = sV * T1; }
      }
    }
    const s = {
      from: from, aim: { x: target.x, y: target.y }, land: land, T1: T1, T2: T2, apex: apex, apex2: apex2, vx: vx, vy: vy,
      mph: mph, hitter: o.hitter, serve: !!o.serve, t: 0, tc: tc, spin: spin, volley: volley, lobbed: lobbed,
      netted: netted, netT: netT, netZ: netZ, netDone: false, bounced: false, resolved: false, dead: false, trail: []
    };
    if (netted) s.netX = lerp(from.x, target.x, sNet) + (land.x - target.x) * sNet * sNet;
    return s;
  }

  function shotPos(s, t) {
    if (s.netted && t >= s.netT) {
      const u = t - s.netT;
      return { x: s.netX, y: C.net + (s.hitter === 0 ? -0.12 : 0.12), z: Math.max(0.03, s.netZ - 4.9 * u * u) };
    }
    if (t < s.T1) {
      const k = t / s.T1;
      const drift = s.land.x - s.aim.x;
      return {
        x: lerp(s.from.x, s.aim.x, k) + drift * k * k,
        y: lerp(s.from.y, s.land.y, k),
        z: s.from.z * (1 - k) + s.apex * 4 * k * (1 - k) + 0.03
      };
    }
    const u = t - s.T1;
    let z = 0;
    let h = s.apex2;
    let T = s.T2;
    let uu = u;
    for (let i = 0; i < 5; i++) {
      if (uu < T) { z = h * 4 * (uu / T) * (1 - uu / T); break; }
      uu -= T;
      h *= 0.35;
      T *= 0.55;
    }
    const slow = Math.min(u, 2.5);
    return { x: s.land.x + s.vx * slow, y: s.land.y + s.vy * slow, z: z + 0.03 };
  }

  function addRage(amount, label) {
    if (M.tut) return;
    if (amount > 0) amount *= diff().rage;
    // Pressure makes everything worse
    if (amount > 0 && M.bigPoint) {
      amount *= 1.5;
      if (label !== false) label = (label ? label + ' ' : '') + 'x1.5';
    }
    const before = M.rage;
    M.rage = clamp(M.rage + amount, 0, 1);
    if (M.rage > before + 0.004) {
      // Remember where the bar was, so the new chunk can flash, and kick the bar
      M.rageFx.from = M.rageFx.jump > 0.05 ? Math.min(M.rageFx.from, before) : before;
      M.rageFx.jump = Math.min(1, 0.55 + (M.rage - before) * 5);
    }
    M.peakRage = Math.max(M.peakRage, M.rage);
    M.gamePeak = Math.max(M.gamePeak || 0, M.rage);
    // Crossing into each band: a sting and a tap on the hand, so you feel it rising without looking
    [0.5, 0.7, 0.85].forEach((th, i) => {
      if (before < th && M.rage >= th) { sfx('stingDown', { power: 0.5 + 0.25 * i }); haptic(i === 2 ? 'heavy' : 'light'); }
    });
    const delta = Math.round((M.rage - before) * 100);
    if (label !== false && delta !== 0) {
      // Shown by your head, where your eyes are, as well as filling the bar
      M.floaters.push({ text: (delta > 0 ? '+' : '') + delta + ' RAGE' + (label ? '  ' + label : ''), world: { x: M.player.x, y: M.player.y, z: 2.4 }, x: 0, y: 0, t: 0, color: delta > 0 ? '#ff6a5f' : '#9fe7ff' });
      if (M.rage >= 0.5) showTip('rage', 'Rage hits harder but aims worse. At 100%: smash it, or keep it in.');
    }
  }

  // The opponent's temper. Lobs, drop shots, winners, long rallies, showboating and dawdling over your serve
  // wind them up; winning points calms them. Full, they lose it for three points: more errors, a lot of shouting.
  function oppTemper(amount) {
    if (!M || M.tut) return;
    const before = M.oppTemp;
    M.oppTemp = clamp(M.oppTemp + amount, 0, 1);
    if (M.oppTemp > before + 0.01) M.oppTempFx = 1;
    if (M.oppTemp >= 0.4) showTip('opp', 'Wind them up with lobs, drop shots and winners. Fill their temper and they crack.');
    if (M.oppTemp >= 1 && !M.oppLost) {
      M.oppLost = 3;
      M.oppLostCount = (M.oppLostCount || 0) + 1;
      M.oppTemp = 1;
      M.speech = { text: pick(['WHAT?! HOW IS THAT IN?!', 'I CANNOT PLAY ON THIS!', 'THIS IS A DISGRACE!', 'ARE YOU SERIOUS?!']), who: 'opp', t: 0, dur: 2 };
      sfx('shout', { vowel: 'a' });
      sfx('frame');
      sfx('ooh');
      callout('oppLost', { main: 'THEY HAVE LOST IT', sub: M.cfg.opp.name + ' is rattled. Three points of chaos. Make them pay.', color: '#ffb03a', dur: 2.2 });
      M.hype = 1;
      unlock('rattled');
    }
  }

  // One time tips for the first matches, so the lesson can stay short
  // First-time tips wait for a gap between points: they never pop up over a rally
  function showTip(id, text, move) {
    if (!M || M.tut || SAVE.tips[id]) return;
    SAVE.tips[id] = true;
    persist();
    M.tipQueue = M.tipQueue || [];
    M.tipQueue.push({ text: text, t: 0, dur: move ? 5.5 : 5, move: move || null });
  }
  // Points played across every match, ever. The advanced moves are taught one at a time
  // across the first tour (about three matches), never all in the first one.
  const lifePts = () => (SAVE.ptsEver || 0);
  const TEACH = { lob: 10, lobAnyway: 64, power: 28, net: 48 };
  const tipQuiet = () => !/rally|serveAim/.test(M.phase);
  const HINT_POINTS = 3;   // how many points each teaching hint appears in, ever

  // A point in the world, in screen pixels after the broadcast camera
  function worldToScreen(x, y, z) {
    const p = proj(x, y, z);
    return { x: (p.x - 640) * M.cam.z + 640 + M.cam.x, y: (p.y - 360) * M.cam.z + 360 + M.cam.y };
  }

  const MORE_SUBS = {
    pNet: ['The net was in the way. It usually is.', 'Into the tape. The tape thanks you.', 'A brave attempt to go through the net rather than over it.'],
    pOut: ['Long. The ball had somewhere else to be.', 'Out by a distance nobody needed glasses for.', 'Wide. Nearer the car park than the line.'],
    whiff: ['Swung at fresh air. The air won.', 'A full swing, no ball. Very aerodynamic.', 'The racket and the ball have still never met.'],
    oWinner: ['{opp} hits a clean winner. Rude.', 'Past you before you had decided which way to run.', 'Unreturnable. You did not even pretend.'],
    pWinner: ['Clean. Very clean. Suspiciously clean.', 'A winner. The crowd checks it was you.', 'Painted the line. Frame it.'],
    oNet: ['{opp} finds the net. Try not to smile.', 'Into the net. Their racket gets a long look.', 'The net saves you. Buy it a drink.'],
    oOut: ['{opp} misses long. Polite applause, mostly yours.', 'Out. {opp} glares at the ball.', 'Wide. Their coach has put their head in their hands.'],
    ace: ['{mph} mph. The returner heard a rumour of it.', 'Untouched. The ball kid flinched.', 'An ace. Do not celebrate. Celebrate a bit.'],
    oAce: ['{mph} mph past you. You heard it more than saw it.', 'Ace. You moved after it had gone.', 'Untouchable. You touched your hair instead.'],
    forcedErr: ['You made them stretch. They did not like it.', 'Pressure tells. It told them off.', 'Too good. They could only watch it go wrong.'],
    unreturned: ['Back into the net it goes. Your serve did that.', 'They got a frame on it. Just a frame.', 'Returned straight into the ground. Lovely.'],
    pFault: ['Fault. Breathe.', 'Into the net. The second serve will be fine. Probably.', 'Long. The service box is smaller than it looks.'],
    pDouble: ['Two faults. The crowd groans in harmony.', 'A double fault. The racket is being watched closely.', 'Double fault. You glare at the service box.'],
    oDouble: ['{opp} serves two faults. Look sympathetic.', 'A double from {opp}. Free point. Take it.', '{opp} double faults and blames the wind. Whatever the wind is doing.'],
    deuce: ['Deuce again. Nobody is going home.', 'Deuce. The umpire checks the time.', 'Deuce. Long game. Longer face.'],
    breakPoint: ['Break point. Do not think about it.', 'One point from breaking them. Calm hands.', 'Break point. The crowd leans forward.'],
    pLob: ['Over their head and in. Lovely.', 'A lob. They watched it all the way down.', 'Up and over. They are still looking up.'],
    pDrop: ['Dead on arrival. They did not arrive.', 'A drop shot. They ran. They did not make it.', 'Kissed over the net. Cruel and beautiful.']
  };
  const TEMPLATE_SUBS = {
    pWinner: ['{sur} is still looking for that one.', 'That one is going on the {sponsor} advert.'],
    oWinner: ['Even {ump} nearly applauded that.', '{sur} points at the line. You point at the sky. Nobody knows why.'],
    ace: ['{mph} mph. {sur} has asked for it to be measured again.', 'An ace at the {event}. {sur} inspects their racket for holes.'],
    oAce: ['{sur} does not even celebrate. That is worse.', '{mph} mph from {sur}. Your racket was still on its way.'],
    pOut: ['{sur} raises one finger. Just the one, thankfully.', 'Out. {ump} says so, and {ump} has a chair.'],
    oNet: ['{sur} blames the net. The net has a lawyer.', '{sur} stares at the net as if it owes them money.'],
    pNet: ['Into the net, right in front of {ump}, who writes something down.', 'The net stops it. {sponsor} would like their racket to stop too.'],
    pDouble: ['{sponsor} would like a word after this.', 'Two faults. {sur} tries very hard not to smile.'],
    deuce: ['Deuce at the {event}. Somebody put the kettle on.', 'Deuce. {sur} has started breathing loudly.'],
    breakPoint: ['Break point. {sur} is fiddling with the strings.', 'Break point at the {event}. The crowd forgets its sandwiches.'],
    whiff: ['{sur} saw that. Everyone saw that.', 'A full swing at nothing. {ump} looks away politely.']
  };
  Object.keys(TEMPLATE_SUBS).forEach((k) => { if (COPY[k] && COPY[k].subs) COPY[k].subs.push(...TEMPLATE_SUBS[k]); });
  Object.keys(MORE_SUBS).forEach((k) => { if (COPY[k] && COPY[k].subs) COPY[k].subs.push(...MORE_SUBS[k]); });
  const SUB_KEEP = /^(umpCall|umpFault|noReview|badCall|badFault|overturned|overturnedAce|replay|callStands|tutNext|notReady|tooFar)$/;
  // Play is starting (a serve, or your celebration): whatever stamp is up fades in a blink and the queue goes,
  // so no NOT READY or MATCH POINT hangs over the next rally. The lesson keeps its stamps: they are instructions.
  function clearStamps() {
    if (!M || (M.tut && (M.tut.practice || M.tut.ending))) return;
    M.calls = M.calls.slice(0, 1);
    const c = M.calls[0];
    if (c) c.dur = Math.min(c.dur, c.t + 0.2);
  }
  function callout(key, opts) {
    opts = opts || {};
    const c = COPY[key];
    const main = opts.main || (c ? c.main : key);
    let sub = opts.sub !== undefined ? opts.sub : c ? pickUnseen(c.subs, 'sub:' + key) : '';
    // Less reading mid-match: a random joke sticker at most once every 10 seconds of play. Calls you can act on
    // (umpire calls, reviews, challenges, the lesson) and stickers written for the moment always show.
    if (sub && opts.sub === undefined && !M.tut && !SUB_KEEP.test(key)) {
      if (M.time - (M.lastSubT === undefined ? -99 : M.lastSubT) < 10) {
        sub = '';
        // Not shown, so not seen
        const b = SAVE.seen && SAVE.seen['sub:' + key];
        if (b && opts.sub === undefined) b.pop();
      }
      else M.lastSubT = M.time;
    }
    const sur = String(M.cfg.opp.name).trim().split(/\s+/).pop();
    sub = fill(sub, {
      opp: M.cfg.opp.name,
      mph: Math.round(M.lastMph),
      sur: sur,
      ump: M.cfg.ref || 'the umpire',
      sponsor: (playerKit().sponsor || 'Your sponsor').replace(/\.$/, ''),
      event: M.cfg.mode === 'career' ? TIERS[M.cfg.tierIdx].short : M.cfg.mode === 'daily' ? 'Daily Meltdown' : 'club'
    });
    // Long enough to read: about three words a second for the line underneath, never less than 1.5 seconds
    const words = sub ? sub.split(/\s+/).length : 0;
    const dur = Math.min(4.5, Math.max(1.5, opts.dur || 1.6, words ? 1.3 + words / 3.2 : 0));
    M.calls.push({ main: main, sub: sub, t: 0, dur: dur, color: opts.color || '#f4f1e6' });
    // Good stamps get a rising sting, bad ones a bwomp; neutral ones (deuce, game, fault) stay quiet
    const col = opts.color || '';
    if (col === '#d9f24a' || col === '#ffb03a') sfx('stingUp');
    else if (col === '#ff8a80') sfx('stingDown');
    if (M.calls.length > 3) M.calls.splice(1, 1);
  }

  // The five umpires. g: a man's or a woman's voice; pitch and rate for the phone's voice, hz for the synthesised
  // one; how they look in the chair; and how they ask for quiet before a big point.
  const UMPIRES = {
    'Mrs Penhaligon': { blazer: '#7a5c9e', g: 'f', voice: 'gba', pitch: 1, rate: 0.92, hz: 215, skin: '#efc9a8', hair: '#d9d4cb', style: 'bun', glasses: true, quiet: ['Quiet please.', 'Thank you.'] },
    'Mr Dobbs': { blazer: '#3d434b', g: 'm', voice: 'gbd', pitch: 1, rate: 1.06, hz: 112, skin: '#e2b48f', hair: null, tache: '#5a3a22', quiet: ['Quiet.', 'Quiet please.'] },
    'Ms Grieve': { blazer: '#1f5c6b', g: 'f', voice: 'gbc', pitch: 1, rate: 1.0, hz: 190, skin: '#b9825a', hair: '#1b1b1b', style: 'bob', quiet: ['Quiet please.'] },
    'Mr Ashdown': { blazer: '#2f5f9e', g: 'm', voice: 'gbb', pitch: 1, rate: 0.97, hz: 125, skin: '#d9a57c', hair: '#4a2f1c', style: 'side', quiet: ['Quiet please.', 'Thank you.'] },
    'Mr Featherstonehaugh': { blazer: '#6b2430', g: 'm', voice: 'rjs', pitch: 1, rate: 0.86, hz: 105, skin: '#f0c9a8', hair: '#f2efe8', style: 'side', tache: '#f2efe8', glasses: true, quiet: ['Quiet please.', 'Thank you.'] }
  };
  function umpire() { return UMPIRES[(M && M.cfg && M.cfg.ref) || ''] || UMPIRES['Mr Ashdown']; }
  // The umpire calls the score before every point, the server's score first: Fifteen love, Thirty all, Love forty.
  // In a tiebreak: One all, or Three two, and the leader's name. Spoken only: the scoreboard shows it.
  const SCORE_WORDS = ['Love', 'Fifteen', 'Thirty', 'Forty'];
  const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
  function callScore() {
    const sv = M.points[M.server];
    const rc = M.points[1 - M.server];
    let text;
    if (M.tiebreak) {
      const w = (n) => NUMBER_WORDS[n] || String(n);
      const a = M.points[0];
      const b = M.points[1];
      text = a === b ? w(a) + ' all.' : w(Math.max(a, b)) + ' ' + w(Math.min(a, b)).toLowerCase() + ', ' + (a > b ? mySaid() : oppSaid()) + '.';
    } else text = sv === rc ? SCORE_WORDS[sv] + ' all.' : SCORE_WORDS[sv] + ' ' + SCORE_WORDS[rc].toLowerCase() + '.';
    const U = umpire();
    sfx('umpire', { text: text, gender: U.g, voice: U.voice, online: true, vPitch: U.pitch, vRate: U.rate, pitch: U.hz });
  }
  function say(text, who) {
    M.speech = { text: text, who: who || 'ump', t: 0, dur: 2.4 };
    if (who === 'ump' || !who) { const U = umpire(); sfx('umpire', { text: text, gender: U.g, voice: U.voice, online: true, vPitch: U.pitch, vRate: U.rate, pitch: U.hz }); }
  }

  /* ---- The Tea Hut Lesson: one mechanic at a time, with Coach Derek feeding balls ---- */
  const COACH = { name: 'Coach Derek', traits: [], skill: 0.3, shirt: '#1f3a6b', face: '#e8c3a0', band: '#ffffff', hair: '#9a9a9a', pitch: 140 };
  const TUT_STEPS = [
    { id: 'timing', title: 'Hit', get text() { return ctl('tutHit'); }, need: 2 },
    { id: 'aim', title: 'Aim', get text() { return ctl('tutAim'); }, need: 2, target: { x0: -C.hw, x1: -1.4, y0: 18.5, y1: C.L } },
    // safeAim: the step teaches something other than aim, so the shot is aimed safely inside the court
    { id: 'charge', title: 'Power', get text() { return ctl('tutCharge'); }, need: 2, safeAim: true, slowFeed: true },
    { id: 'topspin', title: 'Topspin', get text() { return ctl('tutTop'); }, need: 1, safeAim: true },
    { id: 'slice', title: 'Slice', get text() { return ctl('tutSlice'); }, need: 1, safeAim: true },
    { id: 'lob', title: 'Lob', get text() { return ctl('tutLob'); }, need: 2, net: true, safeAim: true },
    { id: 'serve', title: 'Serve', get text() { return ctl('tutServe'); }, need: 2, server: 0 },
    { id: 'meltdown', title: 'The Temper', get text() { return ctl('tutMelt'); }, need: 1 }
  ];
  // Practice drills: the lesson's no-stakes match with Derek, plus what he feeds and who serves
  const DRILLS = {
    rally: { title: 'Rallies', text: 'Derek feeds you all over the court and sends everything back. Keep it going.' },
    returns: { title: 'Returns', text: 'Derek serves properly. Get it back in, then he serves again.' },
    serves: { title: 'Serves', text: 'Your serve, every point. Find the sweet spot and the lines.' },
    free: { title: 'Free Hit', text: 'Anything goes: spin, lobs, pace. Derek is not taking it easy.' }
  };
  // Your shot numbers: perfect contacts as a share of all your hits, and the shot you played most
  function perfectPct(S) { return S && S.shots ? Math.round(100 * (S.perfect || 0) / S.shots) : 0; }
  function favouriteShot(S) {
    const sp = (S && S.spins) || {};
    const k = Object.keys(sp).sort((a, b) => sp[b] - sp[a])[0];
    return k ? (SPIN[k] ? SPIN[k].label : k.toUpperCase()) : '-';
  }
  function practiceConfig(drill) {
    return Object.assign(tutorialConfig(), { label: 'Practice: ' + DRILLS[drill].title, practice: drill });
  }
  function tutorialConfig() {
    return { mode: 'tutorial', tierIdx: 0, round: 0, label: 'The Tea Hut Lesson', surface: 'grass', games: 99, opp: COACH, skill: 0.3, strict: 0.1, ref: 'Mrs Penhaligon', cheatRate: 0, wind: 0, fine: 0, rackets: 5, maxRackets: 5, crowd: 0.2, seed: 4242 };
  }
  function tutStepFrom(i) {
    return i;
  }
  function tutStep() {
    return M && M.tut ? TUT_STEPS[M.tut.step] || null : null;
  }
  function practiceEvent(kind, sh) {
    const T = M.tut;
    if (kind !== 'in' && kind !== 'serveIn') return;
    T.ins++;
    T.best = Math.max(T.best, (M.rallyCount || 0) + 1);
    if (kind === 'serveIn') {
      M.floaters.push({ text: Math.round(sh.mph || M.lastMph) + ' MPH  IN', x: 640, y: 430, t: 0, color: '#d9f24a', big: true });
      T.endPoint = true;
    } else if (T.practice === 'returns' && (M.rallyCount || 0) <= 1) {
      M.floaters.push({ text: 'RETURNED', x: 640, y: 430, t: 0, color: '#d9f24a', big: true });
      T.endPoint = true;
    }
  }
  function tutEvent(kind, sh) {
    const T = M.tut;
    if (T && T.practice) { practiceEvent(kind, sh); return; }
    const st = tutStep();
    if (!T || !st) return;
    let ok = false;
    if (st.id === 'timing') ok = kind === 'in';
    else if (st.id === 'move') ok = kind === 'in' && sh.from.y > C.net - C.svc;
    else if (st.id === 'aim') ok = kind === 'in' && inBox(sh.land, st.target);
    else if (st.id === 'spin') {
      if (kind === 'in' && (sh.spin === 'topspin' || sh.spin === 'slice') && !T.flags[sh.spin]) { T.flags[sh.spin] = true; ok = true; }
    } else if (st.id === 'topspin' || st.id === 'slice') ok = kind === 'in' && sh.spin === st.id;
    else if (st.id === 'charge') ok = kind === 'in' && (sh.charge || 0) >= 0.7;
    else if (st.id === 'serve') ok = kind === 'serveIn';
    else if (st.id === 'lob') ok = kind === 'in' && !!sh.lobbed;
    else if (st.id === 'challenge') ok = kind === 'overturn';
    else if (st.id === 'meltdown') ok = kind === 'meltdown';
    // The Lob step: every ball of yours that lands ends the point, so Derek is back at the net for the next one
    if (st.id === 'lob' && kind === 'in') T.endPoint = true;
    if (!ok) return;
    T.count++;
    // A good serve ends the point: Derek does not return it, so the next one comes straight away
    if (st.id === 'serve') T.endPoint = true;
    sfx('chime', { good: true });
    const passed = T.count >= st.need;
    const last = T.step >= TUT_STEPS.length - 1;
    // The last step's finish gets its own close (LESSON COMPLETE), so no floater for it here
    // Praise for the move itself the first time, so you know what worked
    const praise = { charge: 'POWER SHOT! ', topspin: 'TOPSPIN! ', slice: 'SLICE! ', lob: 'LOB! ' }[st.id] || 'NICE. ';
    if (!(passed && last)) M.floaters.push({ text: passed ? 'STEP ' + (T.step + 1) + ' OF ' + TUT_STEPS.length + ' DONE' : praise + T.count + ' OF ' + st.need, x: 640, y: 430, t: 0, color: '#d9f24a', big: true });
    if (!passed) return;
    T.step = tutStepFrom(T.step + 1);
    T.count = 0;
    T.flags = {};
    T.endPoint = true;   // Derek lets the next ball go, so each lesson starts fresh
    T.feeds = 0;
    if (T.step >= TUT_STEPS.length) { T.done = true; return; }
    if (TUT_STEPS[T.step].id === 'meltdown') M.rage = 1;
  }
  // Derek's gentle feed, down the middle
  function coachFeed(from) {
    const r = M.rng;
    const o = M.opp;
    const start = from || { x: o.x - 0.25, y: o.y, z: 1.1 };
    let tx = r.range(-1.2, 1.2);
    const P = M.tut && M.tut.practice;
    if (P && P !== 'serves') {
      const free = P === 'free';
      const spin = free ? ['flat', 'topspin', 'slice', 'topspin', 'lob'][Math.floor(r() * 5)] : 'flat';
      const deep = spin === 'lob' ? r.range(1.2, 3) : r.range(2.4, 7.2);
      M.shot = makeShot(start, { x: r.range(-3.2, 3.2), y: deep }, spin === 'lob' ? 40 : (free ? 50 : 46) + r() * (free ? 16 : 10), { hitter: 1, spin: spin });
    } else if (tutStep() && tutStep().net) M.shot = makeShot(start, { x: tx, y: r.range(2.6, 4) }, 34 + r() * 4, { hitter: 1, spin: 'flat' });
    else if (tutStep() && tutStep().slowFeed) M.shot = makeShot(start, { x: tx, y: r.range(3.2, 4.6) }, 36 + r() * 4, { hitter: 1, spin: 'flat' });
    else M.shot = makeShot(start, { x: tx, y: r.range(3.2, 5) }, 44 + r() * 6, { hitter: 1, spin: 'flat' });
    o.swing = SWING_AT_HIT;
    o.stroke = null;
    sfx('hit', { power: 0.6 });
    M.phase = 'rally';
    aimReceiver(M.shot);
    clearStamps();
    if (M.tut && !M.tut.practice) M.tut.feeds = (M.tut.feeds || 0) + 1;
  }
  function endTutorial() {
    const first = !SAVE.tutorialDone;
    const paid = !SAVE.lessonPaid;
    SAVE.tutorialDone = true;
    SAVE.lessonPaid = true;
    if (paid) SAVE.prizeMoney += 500;
    if (first) SAVE.askStyle = true;
    // The lesson taught hitting and aiming, so those match hints are not needed
    SAVE.hints = SAVE.hints || {};
    SAVE.hints.hit = SAVE.hints.aim = HINT_POINTS;
    persist();
    const toastL = paid ? 'Lesson complete. Derek has waived his fee and slipped you £500 for kit.' : 'Lesson complete. Derek says you have not improved, but he has.';
    // After the first lesson, make your player, then on to the tour
    if (first && !SAVE.player.made && !M.cfg.replay) { FSM.change('LOCKER_ROOM', { from: 'CAREER_HUB', create: true, toastNext: toastL }); return; }
    FSM.change(M.cfg.replay ? 'MENU' : 'CAREER_HUB', { toast: toastL });
  }

  /* ---- point flow ---- */
  function nextPoint() {
    saveResume();
    if (M.tut) {
      const st = tutStep();
      M.server = M.tut.practice ? (M.tut.practice === 'serves' ? 0 : 1) : st && st.server === 0 ? 0 : 1;
      M.tut.endPoint = false;
    }
    // In a tiebreak the server changes every two points: settle it before anyone takes their place
    if (M.tiebreak) M.server = tiebreakServer();
    const deuce = isDeuceSide();
    const p = M.player;
    const o = M.opp;
    M.shot = null;
    M.calls = M.calls.filter((c) => c.t < c.dur * 0.6);
    M.opp.atNet = false;
    M.opp.boost = 1;
    M.player.boost = 1;
    M.rallyCount = 0;
    M.challengeable = null;
    M.dawdle = 0;
    if (M.server === 0) {
      p.x = p.tx = deuce ? 0.7 : -0.7;
      p.y = p.ty = -0.6;
      o.x = o.tx = deuce ? -2.6 : 2.6;
      o.y = o.ty = 24.8;
      const b = serviceBox(1, deuce);
      M.aim = { x: (b.x0 + b.x1) / 2, y: C.net + 4.4 };
    } else {
      o.x = o.tx = deuce ? -0.7 : 0.7;
      o.y = o.ty = 24.4;
      p.x = p.tx = deuce ? 2.4 : -2.4;
      p.y = p.ty = M.secondServe ? -0.5 : -1.4;   // step in on a second serve
      M.aim = { x: 0, y: 20.5 };
    }
    if (M.tut && !M.tut.practice && tutStep() && tutStep().net) { o.y = o.ty = NET_POS; o.atNet = true; }
    M.phase = 'prePoint';
    M.phaseT = 0;
    M.phaseDur = 0.6;
    M.bounceCount = 0;
    M.bounceT = 0;
    if (!M.secondServe && !M.tiebreak && M.points[0] >= 3 && M.points[1] >= 3) {
      const d = M.points[0] - M.points[1];
      if (d === 0) { callout('deuce', { dur: 1.4, color: '#d9f24a' }); say('Deuce.'); }
      else { callout(d > 0 ? 'advYou' : 'advThem', { dur: 1.4, color: d > 0 ? '#d9f24a' : '#ff8a80' }); say('Advantage, ' + (d > 0 ? mySaid() : oppSaid()) + '.'); }
    } else if (!M.secondServe && !M.tut && M.points[0] + M.points[1] > 0) callScore();
    if (!M.secondServe) {
      // Just the words on these stamps: the strap underneath carries the detail, and it needs time on screen
      if (pointWinsGame(0) && gameWinsSet(0)) callout('setPoint', { dur: 1.2, sub: '', color: '#d9f24a' });
      else if (pointWinsGame(1) && gameWinsSet(1)) callout('setPointThem', { dur: 1.2, sub: '', color: '#ff8a80' });
      else if (!M.tiebreak && M.server === 1 && pointWinsGame(0)) callout('breakPoint', { dur: 1.2, sub: '', color: '#d9f24a' });
    }
    if (!M.secondServe) { M.bigPoint = isBigPoint(); bigPointSetup(); crowdShout(); }
    if (proFeet()) showTip('proFeet', ctl('proFeet'));
    if (M.bigPoint && !M.heart && window.RRAudio) M.heart = RRAudio.loop('heartbeat');
    if (!M.bigPoint) stopHeart();
    if (hasTrait('timewaster')) {
      if (M.server === 1 && !M.secondServe) M.phaseDur = 2.4 + M.rng() * 3.6;
      else if (M.server === 0 && M.rng() < 0.15) M.notReadyPending = true;
    }
  }

  function startServe() {
    if (M.server === 0) {
      M.phase = 'serveReady';
      M.phaseT = 0;
    } else {
      clearStamps();
      M.phase = 'oppToss';
      M.phaseT = 0;
      M.phaseDur = 0.75;
    }
  }

  function currentReticle() {
    const A = 2.3 * Math.pow(M.rage, 1.6) + M.wobble;
    const t = M.time;
    return {
      x: M.aim.x + A * (Math.sin(t * 11.3) + 0.6 * Math.sin(t * 23.1 + 1.7)) / 1.6,
      y: M.aim.y + A * 0.8 * (Math.sin(t * 9.7 + 0.5) + 0.6 * Math.sin(t * 19.3 + 2.2)) / 1.6,
      amp: A
    };
  }

  const STICK_ZONE = 400;   // logical pixels from the left edge: the movement thumb lives here
  // Charging: hold before the swing to load up power (0.8 s to full)
  function charging() {
    return !!(M && M.chargeStart !== null && (M.touch.down || M.keyDown) && M.phase === 'rally' && s_incoming());
  }
  function chargeLevel() {
    return M && M.chargeStart !== null ? clamp((M.time - M.chargeStart) / 0.8, 0, 1) : 0;
  }
  // Where an incoming ball reaches your depth: in the air if you stand in front of the bounce
  // (a volley), after the bounce otherwise. Used whenever you control your own feet.
  function playerCrossing(s) {
    const Y = M.player.y;
    if (Y > s.land.y + 0.2 && Y < s.from.y) return (s.from.y - Y) / (s.from.y - s.land.y) * s.T1;
    if (s.vy >= -0.01) return s.T1 + s.T2 * 0.9;
    return s.T1 + clamp((Y - s.land.y) / s.vy, 0.1, s.T2 * 0.92);
  }
  // Pressure points: break points, set points and late tiebreak points
  function isBigPoint() {
    if (M.tiebreak) return M.points[0] + M.points[1] >= 8 || pointWinsGame(0) || pointWinsGame(1);
    return pointWinsGame(1 - M.server) || (pointWinsGame(0) && gameWinsSet(0)) || (pointWinsGame(1) && gameWinsSet(1));
  }
  // A big point on TV: a strap with what is at stake and how it has gone today, the umpire asking for quiet,
  // the crowd falling silent. Then, once it is played, the roar (or the groan), and once a match, a replay.
  function bigPointSetup() {
    M.big = null;
    if (!M.bigPoint || M.tut) return;
    const B = M.bigStats = M.bigStats || { bpFor: 0, bpWon: 0, bpAg: 0, bpSaved: 0, mpFor: 0, mpAg: 0, mpSaved: 0 };
    const sur = M.cfg.opp.name.trim().split(' ').pop();
    let kind;
    let line;
    if (pointWinsGame(0) && gameWinsSet(0)) {
      kind = 'matchFor';
      B.mpFor++;
      line = B.mpFor === 1 ? 'First match point' : 'Match point number ' + B.mpFor;
    } else if (pointWinsGame(1) && gameWinsSet(1)) {
      kind = 'matchAg';
      B.mpAg++;
      line = B.mpSaved ? 'Saved ' + B.mpSaved + ' already. One more?' : 'One point from defeat';
    } else if (M.tiebreak) {
      kind = 'tb';
      line = 'Tiebreak, ' + M.points[0] + '-' + M.points[1];
    } else if (M.server === 1 && pointWinsGame(0)) {
      kind = 'bpFor';
      B.bpFor++;
      line = B.bpFor === 1 ? 'First chance to break ' + sur : 'Converted ' + B.bpWon + ' of ' + (B.bpFor - 1) + ' so far';
    } else {
      kind = 'bpAg';
      B.bpAg++;
      line = B.bpAg === 1 ? 'First break point against you' : 'Saved ' + B.bpSaved + ' of ' + (B.bpAg - 1) + ' so far';
    }
    const TITLE = { matchFor: 'MATCH POINT', matchAg: 'MATCH POINT ' + sur.toUpperCase(), tb: 'TIEBREAK', bpFor: 'BREAK POINT', bpAg: 'BREAK POINT ' + sur.toUpperCase() };
    M.big = { kind: kind, title: TITLE[kind], line: line, t: M.time, good: kind === 'matchFor' || kind === 'bpFor' || kind === 'tb' };
    // The hush: the crowd drops away, and the umpire asks for quiet once the score has been called
    if (M.cfg.crowd >= 0.3) {
      window.RRAudio && RRAudio.crowdLevel && RRAudio.crowdLevel(0.3);
      if (!M.quietSaid || M.rng() < 0.45) { M.quietSaid = true; M.quietAt = M.time + 1.5; }
    }
  }
  // After a big point: the crowd comes back, loud, and the moment gets its line
  function bigPointResult(winner, reason) {
    window.RRAudio && RRAudio.crowdLevel && RRAudio.crowdLevel(1);
    M.quietAt = 0;
    const big = M.big;
    M.big = null;
    if (!big) return;
    const B = M.bigStats;
    if (big.kind === 'bpFor' && winner === 0) B.bpWon++;
    if (big.kind === 'bpAg' && winner === 0) B.bpSaved++;
    if (big.kind === 'matchAg' && winner === 0) B.mpSaved++;
    const won = winner === 0;
    const text = { bpFor: won ? 'BROKEN!' : 'CHANCE GONE', bpAg: won ? 'BREAK POINT SAVED' : 'BROKEN', matchAg: won ? 'MATCH POINT SAVED' : null, tb: null, matchFor: null }[big.kind];
    if (text) M.floaters.push({ text: text, x: 640, y: 165, t: 0, color: won ? '#d9f24a' : '#ff8a80', big: true });
    if (won) sfx('applause', { power: 1.4 });
    else sfx('ooh');
    // Once a match, a break, a break point saved or a match point saved, won well, gets an instant replay.
    // Not an ordinary tiebreak point: nothing was decided, so a replay there only puzzles you.
    const good = (POINT_VALUE[reason] || 0) >= 3 || (M.rallyCount || 0) >= 6;
    if (won && good && big.kind !== 'matchFor' && big.kind !== 'tb' && !M.instantDone && M.pointRec && M.pointRec.length >= 30) {
      const TT = { bpFor: 'THE BREAK', bpAg: 'BREAK POINT SAVED', matchAg: 'MATCH POINT SAVED', tb: 'TIEBREAK' };
      M.instantDue = { title: TT[big.kind] || 'BIG POINT', sub: (HL_TITLE[reason] || 'POINT WON') + ((M.rallyCount || 0) >= 4 ? '  |  ' + M.rallyCount + '-shot rally' : '') };
    }
  }
  function startInstantReplay() {
    const due = M.instantDue;
    M.instantDue = null;
    M.instantDone = true;
    M.instantBack = { p: Object.assign({}, M.player), o: Object.assign({}, M.opp), shot: M.shot, cam: Object.assign({}, M.cam) };
    M.phase = 'highlight';
    M.phaseT = 0;
    const n = M.pointRec.length;
    const from = Math.max(0, n - 96);
    M.hl = { i: from, f: M.pointRec.slice(), shot: true, skip: false, instant: true, title: due.title, sub: due.sub, slowFrom: Math.max(from, n - 60) };
    M.stinger = { t: M.time };
    M.calls.length = 0;
    M.floaters.length = 0;
    M.cut = null;
    M.speech = null;
    sfx('whoosh', { power: 0.6 });
  }
  const CROWD_SHOUTS = {
    good: ['Come on, {s}!', 'Go on, {s}!', 'You can do it, {s}!', 'Lovely stuff, {s}!', 'We love you, {s}!', 'Keep going, {s}!', 'Head up, {s}!',
      'My nan believes in you, {s}!', 'Do it for the tea tent, {s}!', "You've got this, {s}!", 'Marry me, {s}!', 'Nice and easy, {s}!'],
    bad: ['Calm down, {s}!', 'Behave, {s}!', 'Mind the racket, {s}!', 'Deep breaths, {s}!', 'Count to ten, {s}!', 'Think of the rackets, {s}!',
      'Steady on, {s}!', 'Use your words, {s}!', 'My kids are watching, {s}!', 'Put the racket down, {s}!', "We've paid for these seats, {s}!", 'Be nice, {s}!']
  };
  // The next shout: its line and voice, with its audio started now (it takes the phone a second or two)
  function nextShout() {
    const bad = SAVE.reputationScore < -20;
    const sur = mySur();
    const line = pickUnseen(bad ? CROWD_SHOUTS.bad : CROWD_SHOUTS.good, bad ? 'shout:bad' : 'shout:good').replace('{s}', sur);
    const fv = pick(['gbg', 'gba', 'gbb', 'gbd']);
    return { line: line, fv: fv, bad: bad };
  }
  // Between points, now and then, someone in the crowd shouts your name
  function crowdShout() {
    if (M.tut || !myName() || M.bigPoint || M.secondServe || M.cfg.crowd < 0.3) return;
    const pts = M.stats.pointsWon + M.stats.pointsLost;
    if (pts - (M.lastShoutAt || -9) < 4 || M.rng() > 0.16) return;
    M.lastShoutAt = pts;
    const sur = mySur();
    // Fans for a well behaved player, nervous parents for a bad one. A line is not used again until the rest have had a go.
    // The line was chosen one shout ahead, so its audio has had time to be made; then the next is chosen
    const nx = M.shoutNext && M.shoutNext.bad === (SAVE.reputationScore < -20) ? M.shoutNext : nextShout();
    M.shoutNext = null;
    const line = nx.line;
    const fv = nx.fv;
    setTimeout(() => { if (M && !M.shoutNext) M.shoutNext = nextShout(); }, 2500);
    const F = M.fanShout = { text: line, at: M.time + 0.5 + M.rng() * 0.5, x: M.rng() < 0.5 ? 230 + M.rng() * 160 : 890 + M.rng() * 160, g: /gbb|gbd/.test(fv) ? 'm' : 'f', v: fv, p: 1.02 + M.rng() * 0.1 };

  }
  function stopHeart() {
    if (M && M.heart) { M.heart.stop(); M.heart = null; }
  }

  // Mouse: the court spot under the pointer. Depth by halving (further away is higher up the screen),
  // then across, which is a straight line at any one depth.
  function pointAim(sx, sy) {
    const serving = M.phase === 'serveReady' || M.phase === 'serveAim';
    let lo = C.net;
    let hi = C.L + 8;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (worldToScreen(0, mid, 0).y > sy) lo = mid; else hi = mid;
    }
    const y = (lo + hi) / 2;
    const a = worldToScreen(0, y, 0);
    const b = worldToScreen(1, y, 0);
    M.aim.x = clamp((sx - a.x) / ((b.x - a.x) || 1), -7, 7);
    M.aim.y = serving ? clamp(y, 12.2, 19.6) : clamp(y, 13.2, 26);
  }
  // Keys: A and D aim left and right while held, Q aims short for a drop shot; nothing held is down the middle, deep
  function keyAim() {
    const k = M.keyAim || {};
    const dir = (k.r ? 1 : 0) - (k.l ? 1 : 0);
    if (M.phase === 'serveReady' || M.phase === 'serveAim') {
      const b = serviceBox(1, isDeuceSide());
      const lo = Math.min(b.x0, b.x1) + 0.4;
      const hi = Math.max(b.x0, b.x1) - 0.4;
      M.aim.x = clamp((lo + hi) / 2 + dir * 1.5, lo, hi);
      M.aim.y = C.net + 4.4;
    } else {
      M.aim.x = dir * 2.9;
      M.aim.y = k.q ? DROP_Y - 1.4 : 20.5;
    }
  }
  // Mouse: the right button sends you to the net, or back to the baseline if you are already up there
  function netToggle() {
    const p = M.player;
    if (M.phase !== 'rally') return;
    if (p.rush || p.y > 3) {
      p.rush = 0;
      p.retreat = true;
      M.floaters.push({ text: 'BACK TO THE BASELINE', x: 640, y: 470, t: 0, color: '#9fe7ff', big: true });
    } else {
      p.rush = 7.2;
      p.retreat = false;
      M.floaters.push({ text: 'TO THE NET', x: 640, y: 470, t: 0, color: '#9fe7ff', big: true });
    }
  }
  function setAimFromScreen(sx, sy) {
    if (M.aimSrc === 'mouse') { pointAim(sx, sy); return; }
    sx = clamp((sx - STICK_ZONE) / (W - STICK_ZONE), 0, 1) * W;
    const serving = M.phase === 'serveReady' || M.phase === 'serveAim';
    const k = AIM_SENS[SAVE.settings.aim] || 1;
    M.aim.x = clamp((sx / W - 0.5) * 13 * k, -7, 7);
    const fy = clamp(0.5 + (clamp(sy / H, 0, 1) - 0.5) * k, 0, 1);
    M.aim.y = serving ? lerp(19.6, 12.2, fy) : lerp(26, 13.2, fy);
  }

  // The serve power bar. It climbs steadily through the safe range, then whips through the red, so a big serve is
  // a timing skill. rise is the seconds from empty to full: quicker on the bigger tours (club to Slam; 0.68 s in the
  // Daily). Above red it moves at whip times its speed below. Above 60% rage it wobbles by up to jitter.
  // Inside sweet you get full pace without the extra spread of a maximum serve.
  const SERVE_BAR = { rise: [0.9, 0.73, 0.68, 0.63, 0.58], daily: 0.68, red: 0.8, whip: 2, jitter: 0.05, sweet: [0.9, 0.97] };
  function powerAt(t) {
    const rise = (M.cfg.mode === 'career' || M.cfg.mode === 'quick' ? (SERVE_BAR.rise[M.cfg.tierIdx] || 0.7) : SERVE_BAR.daily) * diff().serveBar;
    const k = (t / rise) % 2;
    const tri = 1 - Math.abs(k - 1);
    // Share of the rise spent below red, at the steady speed; the rest whips through the top
    const R = SERVE_BAR.red;
    const ub = R / (R + (1 - R) / SERVE_BAR.whip);
    let pw = tri < ub ? tri / ub * R : R + (tri - ub) / (1 - ub) * (1 - R);
    if (M.rage > 0.6 && !reduceMotion) pw += Math.sin(t * 31) * SERVE_BAR.jitter * (M.rage - 0.6) / 0.4;
    return clamp(pw, 0, 1);
  }

  // flick: +1 up (kick), -1 down (slice), 0 none (flat)
  function playerServe(flick) {
    const deuce = isDeuceSide();
    const p = M.power;
    const ret = currentReticle();
    const type = flick > 0 ? 'kick' : flick < 0 ? 'sliceServe' : 'flat';
    let mph = Math.min(150, (75 + 40.4 * p) * (1 + 0.3 * M.rage));
    if (type === 'kick') mph = (68 + 28 * p) * (1 + 0.15 * M.rage);
    else if (type === 'sliceServe') mph = (72 + 34 * p) * (1 + 0.2 * M.rage);
    // The sweet spot keeps a full pace serve as accurate as a 70% one; overshooting into the top of the red sprays it
    const sweet = p >= SERVE_BAR.sweet[0] && p <= SERVE_BAR.sweet[1];
    const spread = sweet ? 0.12 + 0.5 * 0.49 : (0.12 + 0.5 * p * p) * (p > SERVE_BAR.sweet[1] ? 1.15 : 1);
    const scatter = spread * (type === 'kick' ? 0.7 : type === 'sliceServe' ? 0.85 : 1);
    if (sweet) M.floaters.push({ text: 'SWEET SPOT', x: 640, y: 430, t: 0, color: '#d9f24a', big: true });
    const sc = { x: M.rng.gauss() * scatter, y: M.rng.gauss() * scatter * 0.7 };
    const target = { x: ret.x + sc.x, y: ret.y + sc.y };
    const from = { x: M.player.x + 0.25, y: M.player.y, z: 2.75 };
    // A slice serve swings away from the receiver after the bounce
    startPointRecording();
    M.shot = makeShot(from, target, mph, { hitter: 0, serve: true, spin: type, curveX: type === 'sliceServe' ? (deuce ? -2.6 : 2.6) : 0 });
    if (type !== 'flat') M.floaters.push({ text: SPIN[type].label, x: 640, y: 470, t: 0, color: SPIN[type].color, big: true });
    M.shot.cause = { aim: { x: M.aim.x, y: M.aim.y }, shake: { x: ret.x - M.aim.x, y: ret.y - M.aim.y }, scatter: sc, quality: p > 0.85 ? 'poor' : 'good' };
    M.shot.recvX = M.opp.x;   // where the returner stood: how far the serve moved them decides ace or body serve
    M.shot.deuce = deuce;
    M.player.swing = SWING_AT_HIT;
    M.player.stroke = 'serve';
    M.lastMph = mph;
    M.mphT = 1.8;
    M.stats.fastest = Math.max(M.stats.fastest, Math.round(mph));
    if (Math.round(mph) >= 150) unlock('ace150');
    sfx('hit', { power: 0.9 + p * 0.6 });
    sfx('whoosh', { power: p });
    vibrate(25);
    M.phase = 'rally';
    // The opponent shuffles towards where it will be returned from
    aimReceiver(M.shot);
  }

  // Their aces: a big first serve, wide or down the T, can beat your legs. The chance rises with pace from 105 mph,
  // up to max, times the difficulty's ace factor. At contact your feet get only part of the way.
  const OPP_ACE = { from: 105, per: 60, max: 0.2, legs: 0.3 };
  function oppServe() {
    if (M.tut && M.tut.practice !== 'returns') { coachFeed(); return; }
    const deuce = isDeuceSide();
    const sk = M.cfg.skill;
    const r = M.rng;
    const box = serviceBox(0, deuce);
    const first = !M.secondServe;
    const ST = oppStyle();
    // Easy: slower serves, and fewer aimed at the lines. Hard: a little quicker.
    const gentle = diff().aimMiddle;
    const mph = (first ? 78 + 42 * sk + r() * 8 + ST.serve : 62 + 20 * sk + r() * 6) * diff().oppServe;
    const faultP = Math.max(0.03, first ? 0.34 - 0.2 * sk + ST.fault : 0.09 - 0.06 * sk);
    let tx;
    const spot = r();
    if (spot < ST.wide) tx = deuce ? box.x1 - 0.35 : box.x0 + 0.35;          // wide
    else if (spot < ST.wide + ST.t) tx = deuce ? box.x0 + 0.3 : box.x1 - 0.3;      // down the T
    else tx = (box.x0 + box.x1) / 2;                                    // body
    if (gentle) tx = lerp(tx, (box.x0 + box.x1) / 2, 0.45);
    let ty = lerp(box.y0 + 1.2, box.y0 + 0.4, sk) + r() * 0.8;
    let net = false;
    const placed = spot < ST.wide + ST.t;
    let fault = false;
    if (r() < faultP) {
      fault = true;
      const kind = r();
      if (kind < 0.35) net = true;
      else if (kind < 0.7) ty = box.y0 - 0.2 - r() * 0.8;
      else tx += (tx > 0 ? 1 : -1) * (0.3 + r() * 0.7);
    }
    const from = { x: M.opp.x - 0.25, y: M.opp.y, z: 2.7 };
    // Skilled servers allow for the wind
    const T1 = flightTime(from, { x: tx, y: ty }, mph);
    tx -= windDrift(T1) * sk;
    const k = r();
    const type = first ? (k < 0.5 ? 'flat' : k < 0.8 ? 'sliceServe' : 'kick') : (k < 0.7 ? 'kick' : 'sliceServe');
    const sMph = type === 'kick' ? mph * 0.86 : type === 'sliceServe' ? mph * 0.93 : mph;
    startPointRecording();
    M.shot = makeShot(from, { x: tx, y: ty }, sMph, { hitter: 1, serve: true, net: net, spin: type, curveX: type === 'sliceServe' ? (deuce ? 2.4 : -2.4) : 0 });
    M.shot.deuce = deuce;
    M.shot.second = !first;
    M.opp.swing = SWING_AT_HIT;
    M.opp.stroke = 'serve';
    // A serve and volleyer follows most first serves in
    if (!net && r() < ST.svNet * (first ? 1 : 0.45)) M.opp.atNet = true;
    M.lastMph = mph;
    M.mphT = 1.4;
    sfx('hit', { power: 1.1, pan: -0.1 });
    if (hasTrait('grunter')) grunt(1.2);
    M.phase = 'rally';
    aimReceiver(M.shot);
    // An ace in the making: your legs only get part of the way there
    const aceP = first && !fault && placed && !M.tut ? Math.min(OPP_ACE.max, Math.max(0, (mph - OPP_ACE.from) / OPP_ACE.per)) * (diff().ace || 1) : 0;
    if (aceP > 0 && r() < aceP) { M.shot.ace = true; M.shot.aceX = M.player.x; }
  }

  function grunt(power) {
    sfx('grunt', { power: power, pitch: M.cfg.opp.pitch });
    M.opp.mouth = 0.5;
    M.wobble = Math.min(1.6, M.wobble + 0.75);
    M.speech = { text: pick(GRUNTS), who: 'opp', t: 0, dur: 0.8 };
    addRage(0.015, 'GRUNT');
  }

  // Like a real player cutting off the angle: meet the ball as late after the bounce as you can
  // still reach it. Wide balls keep travelling after they bounce, so waiting for the top of the
  // bounce can leave the ball out of reach.
  // delay: reaction time before the first step, so a ball that is hard to read can beat them
  function chooseContact(s, body, speed, delay) {
    if (s.volley || s.netted) return;
    const natural = s.tc - s.T1;
    for (let a = natural; a >= 0.1; a -= 0.03) {
      const cp = shotPos(s, s.T1 + a);
      // You take the ball before it drags you more than 1.9 m behind the baseline: any deeper and the camera loses you
      if (body === M.player && cp.y < -1.9) continue;
      const need = Math.max(0, Math.hypot(Math.abs(cp.x - body.x) - 0.75, cp.y - body.y) - REACH * 0.6) / speed + (delay || 0);
      if (need <= s.T1 + a - s.t) { s.tc = s.T1 + a; return; }
    }
  }

  // Moves the receiving player towards where the ball will be met
  function aimReceiver(s) {
    if (s.hitter === 1) { chooseContact(s, M.player, 7 * (s.spin === 'drop' ? 1.35 : 1)); }
    else {
      // They read your shot later when it is struck cleanly or loaded up: more time lost before the first step.
      // A serve is read off the toss and the racket, a little later the faster it comes.
      const q = s.cause && !s.serve ? s.cause.quality : 'poor';
      M.opp.react = s.volley ? 0.05
        : s.serve ? SERVE_RET.read - 0.08 * M.cfg.skill + clamp((s.mph - 90) / 250, 0, 0.12)
        : 0.18 - 0.1 * M.cfg.skill + (q === 'perfect' ? 0.12 : q === 'good' ? 0.04 : 0) + 0.1 * (s.charge || 0) + (s.wrongFoot ? 0.18 : 0) + (s.lobbed ? LOBBED.read : 0) - (s.read ? 0.1 : 0);
      chooseContact(s, M.opp, (4.2 + 3.2 * M.cfg.skill) * diff().oppSpeed * (s.spin === 'drop' ? 1 + 0.6 * M.cfg.skill : s.serve ? serveMove() : 1), M.opp.react);
    }
    const cp = shotPos(s, s.tc);
    if (s.hitter === 1) {
      const p = M.player;
      p.rush = 0;
      p.side = cp.x >= p.x ? 1 : -1;
      p.tx = clamp(cp.x - 0.75 * p.side, -8, 8);
      p.ty = clamp(cp.y - 0.25, -2.3, 9.5);
      p.boost = s.spin === 'drop' ? 1.35 : 1;
      // The opponent recovers to the middle, or closes in on the net
      M.opp.tx = M.opp.x * 0.4;
      M.opp.ty = M.opp.atNet ? NET_POS : 24.6;
      M.opp.boost = 1;
    } else {
      const o = M.opp;
      o.side = cp.x >= o.x ? 1 : -1;
      o.tx = clamp(cp.x - 0.7 * o.side, -8, 8);
      o.ty = s.volley ? cp.y : clamp(cp.y + 0.25, 13.5, 28);
      // Returning a serve there is only time for a split step and a stride or two
      o.boost = s.spin === 'drop' ? 1 + 0.6 * M.cfg.skill : s.lobbed ? LOBBED.run : s.serve ? serveMove() : 1;
      if (s.lobbed) o.atNet = false;
      M.player.tx = M.player.x * 0.5;
      M.player.ty = -1;
    }
  }

  function updateRally(dt) {
    const s = M.shot;
    if (!s) return;
    s.t += dt;
    const bp = shotPos(s, s.t);
    s.trail.push(bp);
    if (s.trail.length > 9) s.trail.shift();

    if (s.netted && !s.netDone && s.t >= s.netT) {
      s.netDone = true;
      s.dead = true;
      if (s.serve) { serveFault(s, 'net'); return; }
      sfx('net');
      if (s.hitter === 0) { M.stats.errors++; pointTo(1, 'pNet'); } else pointTo(0, s.forcedReturn ? 'unreturned' : s.forcedErr ? 'forcedErr' : 'oNet');
      return;
    }
    if (!s.netted && !s.bounced && s.t >= s.T1) {
      s.bounced = true;
      onBounce(s);
    }
    if (s.hitter === 1 && !s.resolved && !s.dead && s.t < 0.05) {
      if (!s.serve && M.rallyCount >= 2) showTip('spin', ctl('spin'), 'spin');
      if (!s.serve && lifePts() >= TEACH.lob && (M.opp.y < C.net + 5 || lifePts() >= TEACH.lobAnyway)) showTip('lob', M.opp.y < C.net + 5 ? ctl('lobNet') : ctl('lob'), 'lob');
      if (!s.serve && lifePts() >= TEACH.power) showTip('power', ctl('power'), 'power');
      if (!s.serve && lifePts() >= TEACH.net) showTip('net', ctl('net'), 'net');
    }
    if (s.hitter === 1 && !s.resolved && !s.dead) {
      // The contact point follows your feet while the ball is still on its way, then freezes
      if (s.t < s.tc) s.tc = Math.max(s.t, playerCrossing(s));
      const cp = shotPos(s, s.tc);
      const p = M.player;
      if (Math.abs(cp.x - p.x) > 0.4) p.side = cp.x >= p.x ? 1 : -1;
      p.tx = clamp(cp.x - 0.75 * p.side, -8, 8);
      if (s.ace) p.tx = s.aceX + (p.tx - s.aceX) * OPP_ACE.legs;
      // Depth stays where it was chosen when the ball was struck. Re-aiming it at the crossing point here fed back
      // on itself (the crossing moves with your feet), and ran you back to the fence on every high bounce.
      // A lob that would sail over your head where you stand: commit to backing off behind the bounce
      // and play it off the ground. Low enough to reach, and you stay put and smash it.
      if (s.spin === 'lob' && !s.bounced && cp.z > 3.4) s.backOff = true;
      p.backOff = !!s.backOff;
      if (p.backOff) p.ty = clamp(Math.min(cp.y - 0.25, s.land.y - 1.2), -2.3, 10.6);
    }
    if (s.dead || s.resolved) return;
    if (s.hitter === 0 && (s.bounced || s.volley) && s.t >= s.tc) oppContact(s);
    else if (s.hitter === 1 && s.t > s.tc + swingWindow()) playerMissed(s);
  }

  // Could the receiver have got to this ball if it had not been called out? Judged from where
  // they are now, how fast they move, and how long the ball would take to reach its contact point.
  function oppCouldPlay(s) {
    const o = M.opp;
    const cp = shotPos(s, s.tc);
    const speed = (4.2 + 3.2 * M.cfg.skill) * diff().oppSpeed * (o.boost || 1);
    const gx = Math.max(0, Math.abs(cp.x - o.x) - REACH);
    const gy = Math.max(0, Math.abs(cp.y - o.y) - 1.2);
    return Math.hypot(gx, gy) / speed <= Math.max(0, s.tc - s.t) + 0.15;
  }

  // What the bounce throws up: chalk off a line on grass, a puff of clay every time on clay (more off the tapes),
  // and a fleck of paint off a line on a hard court
  function bounceFx(L, onLine) {
    const surf = M.cfg.surface;
    const g = proj(L.x, L.y, 0);
    let n = 0;
    let col = '#ffffff';
    if (surf === 'grass' && onLine) { n = 10; col = '#ffffff'; }
    else if (surf === 'clay') { n = onLine ? 10 : 4; col = onLine ? '#f3e6d8' : '#d9895a'; }
    else if (onLine) { n = 4; col = '#f2f2f2'; }
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.15 + Math.random() * 0.7);
      const v = (20 + Math.random() * 50) * (g.s / 40);
      M.parts.push({ kind: 'dust', x: g.x + (Math.random() - 0.5) * 0.12 * g.s, y: g.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 60, t: 0, life: 0.45 + Math.random() * 0.3, r: (onLine ? 0.05 : 0.04) * g.s * (0.6 + Math.random() * 0.6), color: col });
    }
  }
  function onBounce(s) {
    const L = s.land;
    sfx('bounce', { power: 0.6, pan: L.x / 8 });
    M.marks.push({ x: L.x, y: L.y, t: 0, label: null });
    if (M.marks.length > 8) M.marks.shift();
    const receiver = 1 - s.hitter;
    const area = s.serve ? serviceBox(receiver, s.deuce) : courtHalf(receiver);
    const isIn = inBox(L, area);
    if (!reduceMotion) bounceFx(L, isIn ? lineDistance(L, area) < 0.09 : outBy(L, area) < 0.02);

    if (!isIn) {
      s.dead = true;
      const mark = M.marks[M.marks.length - 1];
      const ob = outBy(L, area);
      // Close calls on your shots hide the distance: that is what challenges are for
      const close = s.hitter === 0 && ob < 0.25 && challengesOn();
      if (s.hitter === 0 && ob < 1 && challengesOn()) M.challengeable = { kind: s.serve ? 'serve' : 'rally', x: L.x, y: L.y, area: area, truthIn: false, snap: snapshotScore() };
      mark.label = close ? 'CLOSE' : describeOut(ob);
      M.lineCall = { t: M.time, x: L.x, y: L.y, close: false };
      mark.hold = 2.8;
      mark.out = !close;
      const why = s.hitter === 0 ? (close ? pick(COPY.closeOut.subs) : outReason(s, area)) : null;
      if (s.serve) { serveFault(s, 'out', false, why); openChallengeWindow(); return; }
      sfx('shout', { vowel: 'o' });
      if (s.hitter === 0) { M.stats.errors++; pointTo(1, 'pOut', false, why); openChallengeWindow(); } else pointTo(0, s.forcedReturn ? 'unreturned' : s.forcedErr ? 'forcedErr' : 'oOut');
      return;
    }
    const tutCheat = !!(M.tut && s.hitter === 0 && !s.serve && tutStep() && tutStep().cheat);
    if (M.tut && s.hitter === 0 && !tutCheat) tutEvent(s.serve ? 'serveIn' : 'in', s);
    if (s.hitter === 0 && !s.serve && s.land) {
      const edge = Math.min(C.hw - Math.abs(s.land.x), C.L - s.land.y);
      if (edge >= 0 && edge < 0.3) {
        M.stats.lines = (M.stats.lines || 0) + 1;
        M.floaters.push({ text: 'PAINTED THE LINE', world: { x: s.land.x, y: s.land.y, z: 0.8 }, x: 0, y: 0, t: 0, color: '#ffd23a', big: true });
        sfx('ooh');
      }
    }
    // A good ball from you, close to a line, called out anyway. Who does it depends on the event:
    // a line call cheat calling their own side (no review), or the chair umpire getting it wrong (challenge it).
    // Electronic calling at the Grand Slam never errs. Derek does it on purpose, to teach challenges.
    const mode = callMode();
    if (tutCheat || (s.hitter === 0 && M.gameCheats < 1 && mode !== 'electronic')) {
      const dist = lineDistance(L, area);
      const cheat = mode === 'players' && hasTrait('cheat') && dist < 0.45 && M.rng() < M.cfg.cheatRate;
      const ump = mode === 'umpire' && !M.tut && dist < 0.3 && M.rng() < 0.16 + 0.12 * M.cfg.strict;
      if (tutCheat || cheat || ump) {
        const by = tutCheat ? 'opp' : cheat ? 'opp' : 'ump';
        s.dead = true;
        M.gameCheats++;
        M.stats.badCalls++;
        if (challengesOn()) M.challengeable = { kind: s.serve ? 'serve' : 'rally', x: L.x, y: L.y, area: area, truthIn: true, playable: oppCouldPlay(s), by: by, snap: snapshotScore() };
        const mark = M.marks[M.marks.length - 1];
        mark.label = 'CLOSE';
        mark.hold = 4;
        if (by === 'opp') {
          M.speech = { text: 'OUT!', who: 'opp', t: 0, dur: 1.3 };
          sfx('shout', { vowel: 'o' });
          sfx('boo');
          M.crowdMood = { kind: 'boo', t: 0, dur: 2.4 };
        } else {
          M.speech = { text: s.serve ? 'Fault.' : 'Out.', who: 'ump', t: 0, dur: 1.3 };
          sfx('ooh');
        }
        vibrate([40, 40, 40]);
        addRage(0.2, 'LINE CALL');
        const key = by === 'ump' ? (s.serve ? 'umpFault' : 'umpCall') : (s.serve ? 'badFault' : 'badCall');
        // Where players call their own lines there is no review: it stands
        const opts = { color: '#ff8a80', dur: 2 };
        if (!challengesOn()) opts.sub = fill(pick(COPY.noReview.subs), { opp: M.cfg.opp.name });
        if (s.serve) {
          callout(key, opts);
          serveFault(s, 'cheat', true);
        } else {
          callout(key, opts);
          pointTo(1, 'badCall', true);
        }
        openChallengeWindow();
      }
    }
  }

  function serveFault(s, how, quiet, why) {
    s.dead = true;
    if (!quiet) {
      sfx(how === 'net' ? 'net' : 'fault');
      if (how !== 'net') sfx('shout', { vowel: 'o', fault: true });
    }
    if (!M.secondServe) {
      M.secondServe = true;
      if (!quiet) callout(s.hitter === 0 ? 'pFault' : 'oFault', why ? { dur: 1.6, sub: why } : { dur: 1.1 });
      if (s.hitter === 0) addRage(0.03, false);
      M.phase = 'pointOver';
      M.phaseT = 0;
      M.phaseDur = 1.15;
      M.pendingFault = true;
      if (s.hitter === 1) showTip('second', 'First serve was a fault. Attack the slower second one.');
    } else {
      if (s.hitter === 0) { M.stats.doubleFaults++; pointTo(1, quiet ? 'badCall' : 'pDouble', quiet, why); } else pointTo(0, 'oDouble');
    }
  }

  function oppContact(s) {
    s.resolved = true;
    if (M.tut) {
      // Derek returns everything, unless he is moving you on to the next lesson
      if (M.tut.endPoint || M.tut.done) { pointTo(0, M.tut.practice ? 'pracNext' : 'tutNext'); return; }
      const cp = shotPos(s, s.t);
      coachFeed({ x: cp.x, y: cp.y, z: Math.max(0.6, cp.z) });
      M.rallyCount++;
      return;
    }
    const o = M.opp;
    const r = M.rng;
    const sk = M.cfg.skill;
    const cp = shotPos(s, s.t);
    const dist = Math.abs(cp.x - o.x);
    // A fast ball gives them less time to get the racket out: full stretch reach shrinks with pace
    // Better players reach further and read pace better: a Slam returner gets to serves a club player cannot
    const skillReach = REACH_SKILL.base + REACH_SKILL.k * sk;
    const paceCost = clamp((s.mph - 55) / 110, 0, 0.3) * (1 - REACH_SKILL.pace * sk);
    const reach = (REACH + (s.volley ? 0.4 : 0) + (s.spin === 'drop' ? 0.5 : 0)) * skillReach * (1 - paceCost);
    if (dist > reach || Math.abs(cp.y - o.y) > 2.6) {
      M.lastContact = { stretch: dist / reach, mph: s.mph, serve: s.serve, missed: true };
      if (s.serve) { M.stats.aces++; SAVE.stats.aces++; bigHit(cp.x, cp.y, Math.max(0.3, cp.z), 0.18, 34, 1.4); pointTo(0, 'ace'); }
      else {
        M.stats.winners++;
        pointTo(0, s.spin === 'drop' ? 'pDrop' : s.spin === 'smash' ? 'pSmash' : s.spin === 'volley' ? 'pVolley' : s.lobbed ? 'pLob' : o.atNet ? 'pPass' : 'pWinner');
      }
      return;
    }
    const stretch = dist / reach;
    M.lastContact = { stretch: stretch, mph: s.mph, serve: s.serve };   // for RRDebug tuning
    o.swing = SWING_AT_HIT;
    o.stroke = null;
    let jammed = false;
    let forcedReturn = false;   // a serve that beat them: their return is a miss
    if (s.serve) {
      const box = serviceBox(1, s.deuce);
      const edge = Math.min(Math.abs(s.land.x - box.x0), Math.abs(s.land.x - box.x1));
      const placement = clamp(0.6 - edge, 0, 0.6) * 0.35;
      // Whether they get it back depends on pace, the lines, and how far they had to stretch for it at contact.
      // A serve at the body comes onto the racket, so it is usually returned; out of reach was an ace above.
      const pace = clamp((s.mph - 70) / 60, 0, 1);
      const spinD = s.spin === 'kick' ? 0.08 : s.spin === 'sliceServe' ? 0.05 : 0;
      // A body serve comes at where they were standing: they have to get out of its way, so pace cramps them.
      // Otherwise what counts is how far past a comfortable hitting distance (0.7 m) they had to stretch.
      const bodyServe = Math.abs(cp.x - (s.recvX === undefined ? o.x : s.recvX)) < 0.5;
      const reachK = clamp((dist - 0.7) / Math.max(0.3, reach - 0.7), 0, 1);
      const retP = bodyServe
        ? clamp(SERVE_RET.base - pace * SERVE_RET.body - spinD + sk * SERVE_RET.skill, 0.1, 0.97)
        : clamp(SERVE_RET.base - pace * (SERVE_RET.pace - sk * SERVE_RET.paceSkill) - reachK * reachK * (SERVE_RET.stretch - sk * SERVE_RET.stretchSkill) - placement - spinD + sk * SERVE_RET.skill, 0.1, 0.97);
      M.lastContact.body = bodyServe;
      M.lastContact.reachK = reachK;
      if (r() > retP) {
        sfx('hit', { power: 0.3, pan: cp.x / 8 });
        if (bodyServe) {
          // Straight at them. A fast one jams them: framed outright, or fended off as a weak floater.
          if (r() < clamp((s.mph - 92) / 40, 0, 0.6)) { pointTo(0, 'jammed'); return; }
          jammed = true;
        } else {
          // They get a racket on it and the return goes into the net, long or wide, so you see it happen.
          // Not an ace: aces are the ones they cannot reach.
          forcedReturn = true;
        }
      }
    }
    // A short lob is a gift: they smash it. A deep one buys you time.
    const sitter = s.spin === 'lob' && !s.lobbed && s.land.y < C.net + C.svc + 1;
    // Errors: fewer as skill rises; pace and being stretched wide cause them (stretch counts squared: the last
    // half metre is the hard part)
    let errP = OPP_ERR.base - OPP_ERR.skill * sk + Math.max(0, s.mph - 65) / OPP_ERR.pace + stretch * stretch * OPP_ERR.stretch;
    errP += { topspin: 0.05, slice: 0.05, drop: 0.12, lob: -0.06, kick: 0.04, sliceServe: 0.03 }[s.spin] || 0;
    if (s.volley) errP = 0.06 - 0.04 * sk + Math.max(0, s.mph - 75) / 200 + (s.spin === 'topspin' ? 0.08 : 0) + stretch * 0.15;
    if (sitter) errP = 0.05;
    // Over their head: no easy lob to handle any more, they are scrambling back and playing it blind
    if (s.lobbed) errP += 0.06 + LOBBED.err - LOBBED.errSkill * sk;
    errP += diff().oppErr - (s.read ? 0.06 : 0);
    // A rattled opponent makes more mistakes, and a lot more once they have lost it
    errP += M.oppTemp * 0.1 + (M.oppLost ? 0.12 : 0);
    // Their style, and their confidence when they are on a roll
    errP += oppStyle().err + ((M.streak || 0) <= -3 ? -0.03 : 0);
    const isErr = forcedReturn || (!jammed && r() < clamp(errP, 0.03, 0.75));
    const away = M.player.x > 0 ? -1 : 1;
    const margin = clamp(1.3 - 0.85 * sk, 0.2, 1.3);
    let spin = 'flat';
    let mph;
    let tx;
    let ty;
    if (jammed) {
      // A weak floater from a jammed return: short, slow, somewhere in the middle
      spin = 'slice';
      mph = 32 + 8 * sk;
      tx = r.range(-1.6, 1.6);
      ty = r.range(4, 8);
    } else if (sitter) {
      spin = 'smash';
      mph = 88 + 12 * sk;
      tx = away * r.range(1.5, C.hw - 0.4);
      ty = r.range(2, 7);
    } else if (M.player.y > 4.5 && !s.serve) {
      // You are at the net: they try to pass you, or lob you
      if (r() < oppStyle().lobNet + 0.15 * sk) {
        spin = 'lob';
        mph = 44;
        tx = r.range(-2.5, 2.5);
        ty = r.range(1.2, 3.8);
      } else {
        spin = 'topspin';
        mph = 56 + 28 * sk;
        tx = (M.player.x > 0 ? -1 : 1) * r.range(2.4, C.hw - 0.3);
        ty = r.range(2.5, 7);
      }
    } else if (s.volley) {
      mph = 46 + 12 * sk;
      tx = away * r.range(1.4, C.hw - 0.5);
      ty = r.range(4.5, 9);
    } else {
      // Their shot, by their style: a slicer chips and drops, a grinder loops it deep, a lob merchant lobs
      const ST = oppStyle();
      const dropOk = (sk > 0.45 || ST.mix.drop) && M.player.y < -1.5 && !o.atNet && cp.y > 21;
      spin = pickWeighted(ST.mix, r());
      if (spin === 'drop' && !dropOk) spin = 'slice';
      if (dropOk && !ST.mix.drop && r() < 0.08) spin = 'drop';
      if (spin === 'drop') {
        mph = 36 + 6 * sk;
        tx = away * r.range(0.5, 3);
        ty = r.range(8.6, 10.6);
      } else if (spin === 'lob') {
        mph = 44;
        tx = r.range(-2.8, 2.8);
        ty = r.range(0.8, 3.2);
      } else {
        mph = (50 + 30 * sk + r() * 12) * (spin === 'slice' ? 0.82 : spin === 'topspin' ? 0.95 : 1) * ST.pace;
        tx = (r() < 0.72 ? away : -away) * r.range(0.4, C.hw - margin);
        ty = Math.max(0.6, r.range(1 + (1 - sk) * 2.6, 6.5 + (1 - sk) * 3) - ST.deep);
        // A short or weak ball, or you pulled out of position: better players go for it, fast and into the open court
        const weak = s.land.y < C.net + C.svc + 0.4 || (s.cause && s.cause.quality === 'poor') || Math.abs(M.player.x) > 2.6;
        const attackK = { bigServer: 1.3, allRounder: 1.1, serveVolley: 1, slicer: 0.8, grinder: 0.6, lobber: 0.6 }[styleKey(M.cfg.opp)] || 1;
        if (!s.serve && r() < (weak ? 0.15 + 0.55 * sk : OPP_ERR.neutralAttack * sk) * attackK) {
          mph *= 1.22;
          tx = (Math.abs(M.player.x) > 2.6 ? -Math.sign(M.player.x) : away) * r.range(C.hw - 1.3, C.hw - 0.35);
          ty = r.range(1.2, 5.5);
        }
        if (s.mph > 90) mph *= 0.88;
        if (s.spin === 'drop') mph = 45;
      }
    }
    let net = false;
    if (isErr) {
      const k = r();
      if (k < 0.45) net = true;
      else if (k < 0.75) ty = -r.range(0.3, 1.8);
      else tx = (tx >= 0 ? 1 : -1) * (C.hw + r.range(0.25, 1.4));
    } else {
      const T1 = flightTime(cp, { x: tx, y: ty }, mph);
      tx -= windDrift(T1) * (0.4 + 0.6 * sk);
    }
    M.shot = makeShot({ x: cp.x, y: cp.y, z: Math.max(0.6, cp.z) }, { x: tx, y: ty }, mph, { hitter: 1, net: net, spin: spin });
    M.shot.byVolley = s.volley;
    M.shot.forcedReturn = forcedReturn;
    // Pulled out wide and missed: you forced that error
    M.shot.forcedErr = !forcedReturn && isErr && stretch > 0.72;
    o.swingSpin = s.volley ? 'volley' : spin;
    if (stretch > 0.75) o.lunge = 0.4;
    M.player.split = 0.28;
    M.rallyCount++;
    rallyMilestone();
    // Short balls invite them forward. Skilled players come in more often.
    if (!isErr && !o.atNet && !sitter && spin !== 'drop' && !s.serve) {
      const chance = (s.land.y < 16.5 ? 0.38 : 0.04) * (0.5 + sk) * oppStyle().net;
      if (r() < chance) {
        o.atNet = true;
        if (!M.speech) M.speech = { text: 'Coming in!', who: 'opp', t: 0, dur: 0.9 };
      }
    }
    sfx('hit', { power: spin === 'smash' ? 1.5 : 0.9, pan: cp.x / 8 });
    if (hasTrait('grunter')) grunt(spin === 'smash' ? 1.5 : 0.8 + r() * 0.6);
    aimReceiver(M.shot);
  }

  function playerMissed(s) {
    s.resolved = true;
    const cp = shotPos(s, s.tc);
    const reachable = Math.abs(cp.x - M.player.x) <= REACH + 0.2 && Math.abs(cp.y - M.player.y) <= 2.6;
    if (!reachable) {
      if (s.serve) pointTo(1, 'oAce');
      else pointTo(1, s.spin === 'drop' ? 'oDrop' : s.spin === 'smash' ? 'oSmash' : s.byVolley ? 'oVolley' : 'oWinner');
    } else {
      M.stats.errors++;
      pointTo(1, 'noSwing', false, M.touch.down || M.keyDown ? 'You were still holding. Let go as the ring closes.' : ctl('noSwing'));
    }
  }

  // Which shot a release makes. flick: +1 up, -1 down, 0 none.
  // Up is topspin, or a lob when they are at the net or you are on the run. Down is slice, or a drop shot when you aim short.
  // A drop shot always needs the flick, so a thumb resting low on the screen never plays one by accident.
  const DROP_Y = 15.6;
  function aimShort() { return M.aim.y < DROP_Y; }
  function shotTypeFor(flick, onRun) {
    if (flick > 0) return M.opp.atNet || onRun ? 'lob' : 'topspin';
    if (flick < 0) return aimShort() ? 'drop' : 'slice';
    return 'flat';
  }
  // Every swing is triggered at the moment of the hit, with the racket already taken back, so the stroke starts
  // just before contact (the full stroke runs 0.35 s, contact at 45% of it). Starting from the top of the
  // backswing put the racket on the ball 0.16 s after the ball had left.
  const SWING_AT_HIT = 0.25;
  // Touch shots get worse with rage: extra scatter in metres at 100% rage
  const TOUCH = { slice: 1.4, drop: 2.2, lob: 1.6 };
  // Risk: the shots that win points also lose them. A drop shot finds the net more often the worse it is
  // timed and the further from the net it is played; a full-power drive finds the net or goes long.
  // Steady, well-timed rallying is untouched. Easy takes half of this, Hard a little more.
  const RISK = {
    dropNet: { perfect: 0.1, good: 0.2, poor: 0.45 },     // a drop shot into the net, before rage
    dropFar: 0.012,                                       // more per metre further than 6 m from the net
    powerNet: { flat: 0.12, slice: 0.12, volley: 0.08, topspin: 0.05 },   // at full power, good timing
    powerLong: { flat: 1.5, slice: 1.2, volley: 0.8, topspin: 0.75 },     // extra depth scatter in metres at full power
    powerBias: 0.7,                                       // and it drifts long, not short
    perfectCut: 0.5,                                      // perfect timing halves the extra risk
    diff: { easy: 0.5, normal: 1, hard: 1.2 }
  };

  // Called when the finger lifts (or Space is released) during a rally
  function trySwing(flick) {
    const s = M.shot;
    if (!s || s.hitter !== 1 || s.resolved || s.dead) return;
    const dt = s.t - s.tc;
    if (dt < -WHIFF_WINDOW) return; // just aiming, nothing happens
    const bp = shotPos(s, s.t);
    const p = M.player;
    p.swing = SWING_AT_HIT;
    p.stroke = null;
    sfx('whoosh', { power: 0.7 });
    // Their ball is going into the net: a swing at it costs nothing, the point is still yours when it drops
    if (s.netted) return;
    if (Math.abs(dt) > swingWindow()) {
      s.resolved = true;
      M.stats.errors++;
      pointTo(1, 'whiff', false, 'Too early. Let go as the ring closes on the ball.');   // a late release never gets here: playerMissed calls it first
      return;
    }
    // Reach is judged at the contact point, so an early or late swing inside the window still counts
    const cpt = shotPos(s, s.tc);
    if (Math.abs(cpt.x - p.x) > REACH + 0.3 || Math.abs(cpt.y - p.y) > 2.8) {
      s.resolved = true;
      // Out of reach: name the shot that beat you
      pointTo(1, s.serve ? 'oAce' : s.spin === 'drop' ? 'oDrop' : s.spin === 'smash' ? 'oSmash' : s.byVolley ? 'oVolley' : 'tooFar');
      return;
    }
    // A lob that is still well above you cannot be reached: back up and let it bounce
    if (cpt.z > 3.6) {
      s.resolved = true;
      pointTo(1, 'overHead');
      return;
    }
    s.resolved = true;
    const err = Math.abs(dt) / timingHelp();
    const q = err < 0.06 ? 'perfect' : err < 0.14 ? 'good' : 'poor';
    const forward = p.y > 2.5;
    // On the run: you got there with almost no time to set your feet, or you are reaching at full stretch.
    // Less pace, less control, and a flick up plays a defensive lob.
    const onRun = !s.serve && (Math.abs(cpt.x - p.x) > 1.3 || s.setT === undefined || s.tc - s.setT < 0.2);
    const preBounce = s.tc < s.T1 - 0.01;
    let type;
    if (cpt.z > 2.35 && (forward || preBounce)) type = 'smash';
    else if (preBounce && forward) type = (flick || 0) < 0 && aimShort() ? 'drop' : 'volley';
    else type = shotTypeFor(flick || 0, onRun);
    const lessonStep = M.tut && !M.tut.practice ? tutStep() : null;
    // The spin steps: a flick up is always topspin and a flick down always slice (no drop shot, no lob on the run)
    if (lessonStep && (lessonStep.id === 'topspin' || lessonStep.id === 'slice') && flick) type = flick > 0 ? 'topspin' : 'slice';
    // Charge: a held swing hits harder and less accurately. Touch shots ignore it.
    const charge = TOUCH[type] ? 0 : chargeLevel();
    if (lessonStep && lessonStep.safeAim) {
      // The step is not about aim: keep the shot well inside the court whatever the thumb's height
      M.aim.x = clamp(M.aim.x, -3, 3);
      M.aim.y = clamp(M.aim.y, 17, 21.5);
      // Say what went wrong, plainly
      const T = M.tut;
      let miss = null;
      if (lessonStep.id === 'topspin' && type !== 'topspin') miss = !flick ? ctl('missNoUp') : ctl('missWrongUp');
      else if (lessonStep.id === 'slice' && type !== 'slice') miss = !flick ? ctl('missNoDown') : ctl('missWrongDown');
      else if (lessonStep.id === 'charge' && charge < 0.7) miss = 'NOT HELD LONG ENOUGH: PRESS EARLIER';
      else if (lessonStep.id === 'lob' && type !== 'lob') miss = 'NO LOB: FLICK UP AS YOU LET GO';
      if (miss) M.floaters.push({ text: miss, x: 640, y: 430, t: 0, color: '#ffb03a', big: true });
    }
    M.chargeStart = null;
    const ret = currentReticle();
    let scatter = { perfect: 0.2, good: 0.55, poor: 1.35 }[q] + (TOUCH[type] || 0) * M.rage + 0.4 * charge * charge;
    if (type === 'topspin') scatter *= 0.85;
    if (type === 'volley') scatter *= 0.8;
    // On a roll, your hands are steadier
    if ((M.streak || 0) >= 3) scatter *= 0.9;
    if (onRun && type !== 'lob') scatter += 0.5;
    // Pro footwork: feet set in good time before the ball arrives, a cleaner, harder shot
    const inPos = proFeet() && !onRun && s.setT !== undefined && s.tc - s.setT >= 0.3;
    if (inPos) {
      scatter *= 0.8;
      M.stats.setShots = (M.stats.setShots || 0) + 1;
      if ((M.setShown || 0) < 3) { M.setShown = (M.setShown || 0) + 1; M.floaters.push({ text: 'FEET SET', world: { x: p.x, y: p.y, z: 2.4 }, x: 0, y: 0, t: 0, color: '#9fe7ff', big: true }); }
    }
    const sc = { x: M.rng.gauss() * scatter, y: M.rng.gauss() * scatter };
    // Power costs control in depth: a held drive spreads further, and mostly long (not in the lesson)
    const riskK = (lessonStep ? 0 : RISK.diff[M.cfg.diff] || 1) * (q === 'perfect' ? RISK.perfectCut : 1);
    const c2 = charge * charge;
    if (RISK.powerLong[type] && c2 > 0) sc.y += (M.rng.gauss() * RISK.powerLong[type] + RISK.powerBias) * c2 * riskK;
    const target = { x: ret.x + sc.x, y: ret.y + sc.y };
    if (type === 'lob') target.y = Math.max(target.y, 20.5 + sc.y * 0.5);
    if (type === 'lob' && onRun) target.y = Math.max(target.y, 21.5);
    const base = 62 + { perfect: 14, good: 5, poor: -12 }[q];
    let mph;
    if (type === 'drop') mph = 32 + (q === 'perfect' ? 4 : 0);
    else if (type === 'lob') mph = 44;
    else if (type === 'slice') mph = base * 0.8 * (1 + 0.1 * M.rage);
    else if (type === 'topspin') mph = base * 0.93 * (1 + 0.22 * M.rage);
    else if (type === 'volley') mph = base * 0.85 * (1 + 0.2 * M.rage);
    else if (type === 'smash') mph = (80 + (q === 'perfect' ? 10 : 0)) * (1 + 0.35 * M.rage);
    else mph = base * (1 + 0.3 * M.rage);
    if (!TOUCH[type]) mph *= 0.9 + 0.25 * charge;
    if (onRun && type !== 'smash' && type !== 'lob') mph *= 0.85;
    if (inPos && !TOUCH[type]) mph *= 1.08;
    // A second serve sitting up: time it well and you attack it
    const attack = s.serve && s.second && q !== 'poor' && !onRun;
    if (attack) mph *= 1.12;
    let net = q === 'poor' && M.rng() < 0.3;
    // A drop shot: timing, distance from the net and temper all count
    if (type === 'drop') {
      const far = Math.max(0, (C.net - cpt.y) - 6) * RISK.dropFar;
      const pDrop = lessonStep ? 0.08 : (RISK.dropNet[q] + far) * (RISK.diff[M.cfg.diff] || 1) + 0.4 * M.rage;
      if (M.rng() < pDrop) net = true;
    }
    // A full-power drive clips the tape now and then
    if (RISK.powerNet[type] && c2 > 0 && M.rng() < RISK.powerNet[type] * c2 * riskK) net = true;
    M.shot = makeShot({ x: bp.x, y: bp.y, z: Math.max(0.5, bp.z) }, target, mph, { hitter: 0, net: net, spin: type, oppAtNetY: M.opp.atNet ? NET_POS : null });
    M.shot.cause = { aim: { x: M.aim.x, y: M.aim.y }, shake: { x: ret.x - M.aim.x, y: ret.y - M.aim.y }, scatter: sc, quality: q };
    M.shot.charge = charge;
    // Hard: the same shot to the same side three times running, and they are waiting for it
    const pk = type + (target.x < 0 ? 'L' : 'R');
    M.patt = (M.patt || []).concat(pk).slice(-3);
    if (diff().read && M.patt.length === 3 && M.patt.every((k) => k === pk)) {
      M.shot.read = true;
      if ((M.readShown || 0) < 2) { M.readShown = (M.readShown || 0) + 1; M.floaters.push({ text: 'THEY READ IT', world: { x: M.opp.x, y: M.opp.y, z: 2.6 }, x: 0, y: 0, t: 0, color: '#ffb03a', big: true }); }
      showTip('readIt', 'Hard mode: repeat a shot three times and they will be waiting. Mix it up.');
    }
    // Hitting from inside the court: an approach shot, and you follow it in
    const approach = !s.serve && cpt.y > 3.6 && cpt.y < 8 && !onRun && /^(flat|topspin|slice)$/.test(type);
    if (approach) p.rush = 7.4;
    // Wrong-footing: they are moving one way and you put it behind them, so their first step is late
    const o = M.opp;
    if (!s.serve && Math.abs(o.vx || 0) > 2 && Math.sign(target.x - o.x) === -Math.sign(o.vx) && Math.abs(target.x - o.x) > 1.4) {
      M.shot.wrongFoot = true;
      M.floaters.push({ text: 'WRONG-FOOTED', world: { x: o.x, y: o.y, z: 2.3 }, x: 0, y: 0, t: 0, color: '#9fe7ff', big: true });
    }
    p.swingSpin = type;
    if (onRun) p.lunge = 0.45;
    M.opp.split = 0.28;
    M.lastMph = mph;
    M.mphT = 1.4;
    M.rallyCount++;
    rallyMilestone();
    const label = (attack ? 'ATTACK ' : onRun ? 'ON THE RUN ' : approach ? 'APPROACH ' : charge > 0.85 ? 'POWER ' : '') + (q === 'perfect' ? 'PERFECT' : q === 'good' ? 'GOOD' : dt < 0 ? 'EARLY' : 'LATE') + (type === 'flat' ? '' : ' ' + SPIN[type].label);
    // Your shot numbers, for the changeover stats and the results
    M.stats.shots = (M.stats.shots || 0) + 1;
    if (q === 'perfect') M.stats.perfect = (M.stats.perfect || 0) + 1;
    M.perfectChain = q === 'perfect' ? (M.perfectChain || 0) + 1 : 0;
    if (M.perfectChain >= 2) addRage(-0.01, false);
    M.stats.spins = M.stats.spins || {};
    M.stats.spins[type] = (M.stats.spins[type] || 0) + 1;
    // The verdict appears where you hit it
    M.floaters.push({ text: label + (M.perfectChain >= 2 ? '  x' + M.perfectChain : ''), world: { x: bp.x, y: bp.y, z: bp.z + 0.6 }, x: 0, y: 0, t: 0, color: q === 'perfect' ? '#d9f24a' : q === 'good' ? '#f4f1e6' : '#ffb03a', big: true });
    // The sound and the feel of the contact: a crisp crack off the middle of the strings, a dull clunk off the frame
    if (q === 'perfect' && type !== 'drop') sfx('sweet', { power: 1.2, rate: Math.min(1.4, 1 + 0.06 * Math.max(0, (M.perfectChain || 1) - 1)) });
    else if (q === 'poor') sfx('mishit', {});
    else sfx('hit', { power: type === 'drop' ? 0.45 : 1 });
    haptic(q === 'perfect' ? 'heavy' : q === 'good' ? 'medium' : 'light');
    if (q === 'perfect') bigHit(bp.x, bp.y, bp.z, 0.09, 22, charge > 0.85 ? 1.3 : 1);
    aimReceiver(M.shot);
  }

  // The TV director: after a notable point, a hard cut to a close-up of one player's reaction, held for a
  // second, then a hard cut back to the wide shot. Big points always get one; other notable points half the time.
  // The cut starts after the point's replay recording stops, so the point of the match never includes it.
  const CUT = { at: 1.0, hold: 2.0, zoomYou: 1.85, zoomThem: 2.1 };
  // What you say to the camera, by reaction, and what they say when the camera finds them
  const REACT_LINES = {
    r_glare: ['Don\'t.', 'Not a word.', 'Delete that.', 'I can see you.'],
    r_facepalm: ['Why am I like this.', 'I practise this.', 'Classic me.', 'Every time.'],
    r_shrug: ['HOW?!', 'Is that legal?', 'Rude.', 'Oh, come on.'],
    r_wink: ['Still got it.', 'You saw that.', 'Clip it.', 'Easy.'],
    r_flex: ['Gun show.', 'Tickets, please.', 'Built different.', 'Mwah.']
  };
  const OPP_REACT = {
    won: ['Too easy.', 'Lovely.', 'Thank you.', 'Next.', 'As planned.'],
    lost: ['Oh, COME ON.', 'Lucky.', 'Unbelievable.', 'Was that in?', 'Fine.']
  };
  // A pick that never repeats the last one from the same list
  function pickFresh(list, key) {
    const last = (M.lastPicks = M.lastPicks || {})[key];
    const opts = list.length > 1 ? list.filter((x) => x !== last) : list;
    const v = opts[Math.floor(Math.random() * opts.length)];
    M.lastPicks[key] = v;
    return v;
  }
  function directCut(winner, reason) {
    M.cut = null;
    if (M.tut || reduceMotion || reason === 'badCall') return;
    // Only the points that matter get the close up: a cut after every point is noise
    if (!M.bigPoint) return;
    const pts = M.stats.pointsWon + M.stats.pointsLost;
    M.lastCutAt = pts;
    // Lose it and the camera usually finds you; win it and it is a coin toss between your swagger and their sulk
    const who = winner === 1 ? (Math.random() < 0.7 ? 0 : 1) : (Math.random() < 0.5 ? 0 : 1);
    M.cut = { who: who, at: CUT.at, until: CUT.at + CUT.hold };
    if (who === 0) {
      // You turn to the camera
      const own = /^(pNet|pOut|whiff|noSwing|pDouble|tooFar|overHead)$/.test(reason);
      const pool = winner === 0 ? ['r_wink', 'r_flex'] : own ? ['r_facepalm', 'r_glare'] : ['r_shrug', 'r_glare'];
      M.cut.react = pickFresh(pool, 'react');
      M.cut.say = pickFresh(REACT_LINES[M.cut.react], 'say');
    } else {
      M.cut.say = pickFresh(OPP_REACT[winner === 1 ? 'won' : 'lost'], 'opp');
    }
    // Aces land with a punch of the camera
    if (reason === 'ace' || reason === 'oAce') M.cam.z += 0.05;
  }
  function pointTo(winner, reason, rageAlreadyAdded, why) {
    if (M.phase === 'pointOver' && !M.pendingFault) return;
    if (!M.tut) SAVE.ptsEver = (SAVE.ptsEver || 0) + 1;
    if (M.tut) {
      M.pendingFault = false;
      M.phase = 'pointOver';
      M.phaseT = 0;
      M.phaseDur = 1.1;
      if (reason !== 'badCall') callout(reason, why ? { color: '#ff8a80', sub: why, dur: 1.6 } : { color: winner === 0 ? '#d9f24a' : '#ff8a80', dur: 1.2 });
      M.secondServe = false;
      return;
    }
    M.pendingFault = false;
    M.phase = 'pointOver';
    M.phaseT = 0;
    M.phaseDur = 1.2;
    M.cut = null;
    M.lastPoint = { reason: reason, t: M.time, mph: Math.round(M.lastMph), winner: winner, rally: M.rallyCount };
    if (M.ostats) {
      if (reason === 'oAce') M.ostats.aces++;
      else if (/^o(Winner|Drop|Smash|Volley)$/.test(reason)) M.ostats.winners++;
      else if (/^(oNet|oOut|oDouble)$/.test(reason)) M.ostats.errors++;
    }
    directCut(winner, reason);
    bigPointResult(winner, reason);
    if (M.cut) M.phaseDur = Math.max(M.phaseDur, M.cut.until + 0.2);
    // How much the match has taken out of them: sweat, untidy hair, clay on the socks (0 to 1)
    M.toll = Math.min(1, (M.toll || 0) + 0.012 + 0.003 * (M.rallyCount || 0));
    {
      const VKp = venueKey(M.cfg);
      // One point in six at the outdoor venues, a pigeon drops in
      if (!M.pigeon && /club|council|invitational/.test(VKp) && Math.random() < 1 / 6) {
        M.pigeon = { x: (Math.random() - 0.5) * 6, y: 4 + Math.random() * 5, z: 0, mode: 'walk', t: 0, dir: Math.random() < 0.5 ? -1 : 1, seed: Math.random() * 6, peck: 0 };
      }
      // One quiet point in four, the big screen goes to the crowd cam
      if (VENUES[VKp].screen && !/ace|overturnedAce/.test(reason) && Math.random() < 0.25) M.crowdCam = { t: M.time, look: Math.floor(Math.random() * 3) };
    }
    const crowd = M.cfg.crowd;
    if (reason !== 'badCall') callout(reason, why ? { color: '#ff8a80', sub: why, dur: 2 } : { color: winner === 0 ? '#d9f24a' : '#ff8a80' });
    // One moment at a time, each long enough to take in: the reaction cut waits until the caption is mostly read,
    // and the next point waits for both (a tap still skips)
    const lastCall = M.calls[M.calls.length - 1];
    const readT = lastCall && lastCall.t === 0 ? lastCall.dur : 0;
    if (M.cut) {
      const shift = Math.max(0, Math.min(2.2, readT * 0.75) - M.cut.at);
      M.cut.at += shift;
      M.cut.until += shift;
    }
    M.phaseDur = Math.max(M.phaseDur, readT * 0.85, M.cut ? M.cut.until + 0.2 : 0);
    if (M.rallyCount >= 7) M.hype = Math.min(1, M.hype + 0.4);
    // The broadcast checks on your racket's chances once per climb into each red zone
    M.oddsSeen = M.oddsSeen || {};
    if (M.rage < 0.4) M.oddsSeen = {};
    const zone = RACKET_ODDS.at.filter((z) => M.rage >= z).pop();
    if (zone !== undefined && !M.oddsSeen[zone] && !M.tut) {
      M.oddsSeen[zone] = true;
      M.oddsTV = { t: M.time, from: Math.min(97, racketOdds() + 18), line: zone >= 0.85 ? 'Stringer on standby' : 'Bookies interested' };
    }
    // Their temper: points that hurt wind them up, points they win calm them. While they have lost it, count it down.
    if (M.oppLost) { M.oppLost--; if (!M.oppLost) M.oppTemp = 0.45; }
    if (winner === 0) oppTemper(({ pDrop: 0.14, pLob: 0.14, pPass: 0.1, pWinner: 0.08, ace: 0.08, unreturned: 0.06, jammed: 0.06, pSmash: 0.08, pVolley: 0.06, oDouble: 0.1, overturned: 0.08, overturnedAce: 0.1, forcedErr: 0.07 }[reason] || 0.04) + (M.rallyCount >= 8 ? 0.05 : 0));
    else if (!M.oppLost) oppTemper(-0.04);
    // Momentum: a run of points swings the crowd, your temper and their confidence
    M.streak = winner === 0 ? Math.max(1, (M.streak || 0) + 1) : Math.min(-1, (M.streak || 0) - 1);
    if (M.streak === 3 || M.streak === 6) {
      M.floaters.push({ text: 'THE CROWD IS WITH YOU', x: 640, y: 165, t: 0, color: '#d9f24a', big: true });
      addRage(-0.04, false);
      M.hype = Math.min(1, M.hype + 0.3);
      oppTemper(0.06);
    } else if (M.streak === -3 || M.streak === -6) {
      M.floaters.push({ text: M.cfg.opp.name.split(' ').pop().toUpperCase() + ' IS ON A ROLL', x: 640, y: 165, t: 0, color: '#ff8a80', big: true });
      addRage(0.05, 'SLUMP');
    }
    if (winner === 0) {
      M.stats.pointsWon++;
      // A winner lands: the picture holds for a beat and the phone buzzes
      if (/^(ace|pWinner|pPass|pLob|pDrop|pSmash|pVolley|overturnedAce)$/.test(reason)) {
        M.hitStop = Math.max(M.hitStop || 0, 0.09);
        M.shake = Math.max(M.shake, 0.25);
        haptic('medium');
        // The Red Zone: a winner hit above 85% rage pays a bonus (not in the Daily, where everyone plays the same)
        if (M.rage >= 0.85 && !M.tut && M.cfg.mode !== 'daily') {
          const bonus = Math.max(10, Math.round((M.cfg.fine || 50) * 0.4 * diff().red));
          M.redBonus = (M.redBonus || 0) + bonus;
          M.floaters.push({ text: 'RED ZONE +' + money(bonus), x: 640, y: 210, t: 0, color: '#ff3b30', big: true });
          showTip('redZone', 'Red Zone: winners above 85% rage pay a bonus. Angry pays. Until it does not.');
        }
      }
      M.celebOpen = !M.tut && CELEB_REASONS.test(reason);
      // Time to reach the Celebrate button
      if (M.celebOpen) M.phaseDur = Math.max(M.phaseDur, 1.8);
      // Winning a long rally is worth a celebration and calms you down, whatever ended it
      if (M.rallyCount >= 10) {
        M.celebOpen = !M.tut;
        addRage(-0.04, 'RALLY');
      }
      M.hype = Math.min(1, M.hype + (/^(ace|unreturned|jammed|pWinner|pDrop|pLob|pPass|overturned|overturnedAce)$/.test(reason) ? 0.7 : 0.3));
      addRage(reason === 'ace' ? -0.1 : -0.05);
      sfx('applause', { power: 0.4 + crowd * 0.8 });
      vibrate(20);
    } else {
      M.stats.pointsLost++;
      M.celebOpen = false;
      if (!rageAlreadyAdded) {
        const add = { pNet: 0.12, pOut: 0.12, whiff: 0.13, noSwing: 0.1, tooFar: 0.05, oWinner: 0.045, oAce: 0.06, pDouble: 0.15 }[reason] || 0.04;
        const tag = M.challengeable ? 'LINE CALL' : { pNet: 'ERROR', pOut: 'ERROR', whiff: 'ERROR', noSwing: 'ERROR', pDouble: 'DOUBLE FAULT' }[reason] || '';
        addRage(add, tag);
      }
      if (reason === 'oWinner' || reason === 'oAce') sfx('ooh');
      // Muttering at high rage can draw an audible obscenity warning from a strict umpire
      // Capped at one per game so a strict umpire cannot default you on muttering alone
      const gameNo = M.games[0] + M.games[1];
      if (M.rage > 0.82 && M.lastObscenityGame !== gameNo && (M.obscenities || 0) < 2 && M.rng() < M.cfg.strict * 0.1) {
        M.pendingObscenity = true;
        M.lastObscenityGame = gameNo;
        M.obscenities = (M.obscenities || 0) + 1;
      }
    }
    awardPoint(winner);
  }

  function awardPoint(w) {
    const wins = pointWinsGame(w);
    M.points[w]++;
    M.secondServe = false;
    if (wins) gameTo(w);
  }

  function gameTo(w) {
    // How angry you got in this game, for the share strip: calm, cross, furious, or a meltdown
    (M.gameRage = M.gameRage || []).push((M.stats.meltdowns || 0) > (M.gameMelts || 0) ? 4 : M.gamePeak >= 0.7 ? 3 : M.gamePeak >= 0.4 ? 2 : 1);
    M.gameMelts = M.stats.meltdowns || 0;
    M.gamePeak = M.rage;
    const setWon = gameWinsSet(w);
    M.games[w]++;
    M.points = [0, 0];
    M.gameCheats = 0;
    // After a tiebreak the match is over; otherwise service alternates each game
    if (!M.tiebreak) M.server = 1 - M.server;
    const name = w === 0 ? mySaid() : oppSaid();
    // The score as an umpire says it: the leader first, "1 game", "love", "2 games all"
    const gamesN = (n) => (n === 0 ? 'love' : n + (n === 1 ? ' game' : ' games'));
    const gamesLine = () => {
      const a = M.games[0], b = M.games[1];
      if (a === b) return a + (a === 1 ? ' game' : ' games') + ' all.';
      return (a > b ? mySaid() : oppSaid()) + ' leads ' + gamesN(Math.max(a, b)) + ' to ' + (Math.min(a, b) === 0 ? 'love' : Math.min(a, b)) + '.';
    };
    if (setWon) {
      M.matchWinner = w;
      say('Game, set and match, ' + name + '. ' + gamesN(M.games[w]) + ' to ' + (M.games[1 - w] === 0 ? 'love' : M.games[1 - w]) + '.');
    } else if (M.games[0] === M.cfg.games && M.games[1] === M.cfg.games) {
      M.tiebreak = true;
      M.tbFirst = M.server;
      M.challenges += 1;
      say('Game, ' + name + '. ' + gamesLine() + ' Tiebreak.');
      callout('tiebreak', { dur: 2, color: '#d9f24a' });
      if (w === 1) addRage(0.04, 'GAME LOST');
    } else {
      // A changeover: a short pause with the match stats on screen
      if ((M.games[0] + M.games[1]) % 2 === 1 && !M.tut) { M.tvStats = { t: M.time }; M.phaseDur = Math.max(M.phaseDur, 4.4); }
      say('Game, ' + name + '.');
      callout('GAME', { main: 'GAME', sub: 'Game, ' + name + '. ' + gamesLine(), dur: 1.6, color: w === 0 ? '#d9f24a' : '#ff8a80' });
      if (w === 1) addRage(0.04, 'GAME LOST');
    }
  }

  function canFinalWarn() {
    return !M.tut && !M.finalUsed && M.cfg.mode !== 'daily' && adOk();
  }
  // Code violations: warning, point penalty, game penalty, default
  function codeViolation(kind) {
    M.violations++;
    SAVE.stats.codeViolations++;
    const n = Math.min(M.violations, 4);
    M.fines += M.cfg.fine;
    const what = kind === 'abuse' ? 'Racket abuse' : 'Audible obscenity';
    // A default for racket abuse can be talked down to a final warning, once a match, for an advert (not in the
    // Daily, where everyone plays the same match). The umpire holds the word until you have answered.
    const offer = n >= 4 && kind === 'abuse' && canFinalWarn();
    if (offer) M.finalOffer = true;
    say('Code violation. ' + what + '.' + (offer ? '' : ' ' + PENALTY[n - 1] + '.'));
    M.floaters.push({ text: money(M.cfg.fine) + ' FINE', x: 640, y: 420, t: 0, color: '#ffb03a', big: true });
    M.crowdMood = { kind: 'gasp', t: 0, dur: 2.2 };
    vibrate([60, 50, 60]);
    if (n === 2) awardPoint(1);
    else if (n === 3) {
      M.points = [0, 0];
      gameTo(1);
      if (M.tiebreak) M.server = tiebreakServer();
    } else if (n >= 4) {
      M.matchWinner = 1;
      M.endReason = 'default';
    }
  }

  /* ---- Challenges: 3 per set, one more in a tiebreak. A correct challenge costs nothing. ---- */
  function snapshotScore() {
    return {
      points: M.points.slice(), games: M.games.slice(), server: M.server, tiebreak: M.tiebreak, tbFirst: M.tbFirst,
      secondServe: M.secondServe, matchWinner: M.matchWinner, gameCheats: M.gameCheats, rage: M.rage, challenges: M.challenges
    };
  }
  function restoreScore(sn) {
    M.points = sn.points.slice();
    M.games = sn.games.slice();
    M.server = sn.server;
    M.tiebreak = sn.tiebreak;
    M.tbFirst = sn.tbFirst;
    M.secondServe = sn.secondServe;
    M.matchWinner = sn.matchWinner;
    M.gameCheats = sn.gameCheats;
    M.rage = sn.rage;
    M.challenges = sn.challenges;
    M.pendingFault = false;
    M.pendingObscenity = false;
  }
  // Out of challenges in a career match? Owl Vision can be rented once per match by watching an advert.
  // Never in the Daily Meltdown, where everyone plays on the same terms, and never in the lesson.
  function owlRentable() {
    return !!(M && M.challenges === 0 && !M.owlRented && M.cfg.mode === 'career' && !M.tut && window.RRAds && adOk());
  }
  function openChallengeWindow() {
    if (M.challengeable && (M.challenges > 0 || owlRentable())) M.phaseDur = Math.max(M.phaseDur, 2.9);
  }
  function challengeOpen() {
    return !!(M && M.phase === 'pointOver' && M.challengeable && (M.challenges > 0 || owlRentable()) && !M.paused && !M.renting);
  }
  function rentOwl() {
    M.renting = true;
    M.paused = true;
    const status = $('#chalLeft');
    rewardedAd(FSM.scope, status, 'Advert playing. Mr Owl is putting his glasses on.').then((ok) => {
      M.renting = false;
      togglePause(false);
      if (!ok) return;
      M.owlRented = true;
      M.challenges = 1;
      startChallenge();
    });
  }
  function startChallenge() {
    if (!challengeOpen()) return;
    if (M.challenges === 0) { rentOwl(); return; }
    M.review = Object.assign({ t: 0, sounded: false }, M.challengeable);
    M.challengeable = null;
    M.phase = 'review';
    M.phaseT = 0;
    M.calls = [];
    M.stats.challenges++;
    say('Owl Vision, please.');
    sfx('whoosh', { power: 1 });
    sfx('drumroll', { dur: 2.2 });
    vibrate(20);
  }
  function resolveChallenge() {
    const r = M.review;
    M.review = null;
    if (r.truthIn && r.playable) {
      // The call was wrong, but they could have reached the ball: the point is replayed
      restoreScore(r.snap);
      M.stats.overturned++;
      M.calls = [];
      callout('replay', { color: '#9fe7ff', dur: 2 });
      say('Call overturned. Replay the point.');
      if (M.tut) tutEvent('overturn');
      addRage(-0.1, 'VINDICATED');
      M.hype = Math.max(M.hype, 0.6);
      sfx('ooh');
      M.speech = { text: pick(['Fine. Again.', 'I was being cautious.', 'It looked out from here.']), who: 'opp', t: 0, dur: 1.6 };
      M.phase = 'pointOver';
      M.phaseT = 0;
      M.phaseDur = 1.8;
    } else if (r.truthIn) {
      // The call was wrong and they were nowhere near it: the point (or the ace) is yours
      restoreScore(r.snap);
      M.stats.overturned++;
      M.calls = [];
      M.phase = 'rally';
      if (r.kind === 'serve') { M.stats.aces++; SAVE.stats.aces++; }
      pointTo(0, r.kind === 'serve' ? 'overturnedAce' : 'overturned');
      if (M.tut) tutEvent('overturn');
      addRage(-0.1, 'VINDICATED');
      M.hype = 1;
      sfx('boo');
      M.speech = r.by === 'ump'
        ? { text: pick(['Correction. The ball was in.', 'I stand corrected.', 'The call is overruled. By a bird, apparently.']), who: 'ump', t: 0, dur: 1.8 }
        : { text: pick(['Must have been the sun.', 'I was unsighted.', 'The ball was very fluffy.', 'I stand by it. Spiritually.']), who: 'opp', t: 0, dur: 1.8 };
    } else {
      M.challenges = Math.max(0, M.challenges - 1);
      callout('callStands', { color: '#ff8a80', dur: 1.8 });
      addRage(0.08, 'CHALLENGE LOST');
      sfx('ooh');
      M.phase = 'pointOver';
      M.phaseT = 0;
      M.phaseDur = 1.6;
    }
  }

  // Celebrations: after an ace or a clean winner you may celebrate. It calms you down, the crowd
  // goes wild (mostly), and showboating too often costs a little reputation.
  const CELEB_REASONS = /^(ace|unreturned|jammed|pWinner|pDrop|pLob|pPass|pSmash|pVolley|overturnedAce)$/;
  const CELEB_LEN = 2;
  // Celebrations work like tantrums: everything you own is in your repertoire, and one is picked at random,
  // never the same one twice running. The pick is made when the CELEBRATE button appears, so it can name it.
  function pickCeleb() {
    if (M && M.borrow && !M.borrowUsed && LOCKER_INDEX[M.borrow]) { M.borrowUsed = true; return LOCKER_INDEX[M.borrow]; }
    const owned = LOCKER.celeb.filter((it) => SAVE.locker.owned.indexOf(it.id) >= 0 || (M && it.id === M.borrow));
    const pool = owned.length > 1 ? owned.filter((it) => !M || it.style !== M.lastCeleb) : owned.length ? owned : [LOCKER_INDEX.celeb_comeon];
    return pick(pool);
  }
  function celebItem() {
    if (M && M.nextCeleb) return M.nextCeleb;
    const it = pickCeleb();
    if (M) M.nextCeleb = it;
    return it;
  }
  function celebrate() {
    if (!(M && M.phase === 'pointOver' && M.celebOpen && !M.celeb && !M.paused && !M.tut)) return;
    const it = celebItem();
    M.celebOpen = false;
    M.nextCeleb = null;
    M.lastCeleb = it.style;
    M.celeb = { style: it.style, t: 0 };
    clearStamps();
    M.stats.pumps++;
    SAVE.stats.celebrations = (SAVE.stats.celebrations || 0) + 1;
    oppTemper(it.style === 'shush' ? 0.15 : 0.04);
    checkCollections();
    M.phaseDur = Math.max(M.phaseDur, M.phaseT + CELEB_LEN + 0.3);
    addRage(-it.calm, it.name.toUpperCase());
    M.hype = 1;
    M.crowdMood = { kind: it.style === 'shush' ? 'boo' : 'wild', t: 0, dur: CELEB_LEN + 0.4 };
    if (it.style === 'shush') {
      SAVE.reputationScore = clamp(SAVE.reputationScore - 2, -100, 100);
      sfx('boo');
    } else {
      if (M.stats.pumps % 4 === 0) SAVE.reputationScore = clamp(SAVE.reputationScore - 1, -100, 100);
      sfx('applause', { power: 1.2 });
    }
    if (it.style === 'comeon') sfx('umpire', { text: 'Come on!', pitch: 230, gender: SAVE.player.body === 'f' ? 'f' : 'm', voice: SAVE.player.body === 'f' ? 'gbg' : 'gbb', vPitch: 1.05, vRate: 1.1 });
    else sfx('whoosh', { power: 1 });
    vibrate(30);
  }

  // The first advert is loaded once, at a quiet moment (see admob.js deferPreload)
  let adsWarmed = false;
  function adsWarm() {
    if (adsWarmed || !window.RRAds) return;
    adsWarmed = true;
    (RRAds.warm || RRAds.prepareRewarded)();
  }
  function afterPoint() {
    adsWarm();
    M.challengeable = null;
    M.celebOpen = false;
    M.nextCeleb = null;
    M.celeb = null;
    if (M.instantDue && M.matchWinner === null && !M.pendingFault) { startInstantReplay(); return; }
    if (M.pendingFault) {
      M.pendingFault = false;
      nextPoint();
      M.phaseDur = 0.4;
      return;
    }
    if (M.matchWinner !== null) {
      stopHeart();
      M.bigPoint = false;
      M.phase = 'matchOver';
      M.phaseT = 0;
      // Long enough for the umpire to start the call, then straight to the net (2.4 s felt like waiting)
      M.phaseDur = 1.4;
      if (M.matchWinner === 0) sfx('applause', { power: 1.5 }); else sfx('ooh');
      return;
    }
    if (M.pendingObscenity) {
      M.pendingObscenity = false;
      codeViolation('obscenity');
      M.phase = 'pointOver';
      M.phaseT = 0;
      M.phaseDur = 2.2;
      return;
    }
    if (M.rage >= 1) {
      FSM.change('MELTDOWN_MINIGAME');
      return;
    }
    nextPoint();
  }

  // A gentle broadcast camera: follows the ball a little and tightens on big points
  // Trailer tools (with RRDebug, removed before release): no HUD, and a slow camera move onto a player
  let CINEMA = false;
  let CAM_PATH = null;
  function updateCamera(dt) {
    if (CAM_PATH) {
      const k = clamp((M.time - CAM_PATH.t0) / CAM_PATH.dur, 0, 1);
      const e = k * k * (3 - 2 * k);
      const f = CAM_PATH.who === 1 ? M.opp : M.player;
      const fp = proj(f.x, f.y, 0);
      const kk = fp.s * 0.88;
      const z = lerp(CAM_PATH.z0, CAM_PATH.z1, e);
      // hold: centred on them from the first frame (a pure push in); lift: how far up the body to centre
      const c = CAM_PATH.hold ? 1 : e;
      const lift = CAM_PATH.lift || 1.1;
      M.cam.z = z;
      M.cam.x = clamp(-(fp.x - 640) * z * c, -(z - 1) * 640, (z - 1) * 640);
      M.cam.y = clamp((-(fp.y - lift * kk - 360) * z) * c, -(z - 1) * 360, (z - 1) * 360);
      return;
    }
    if (M.phase === 'handshake' && !reduceMotion) {
      const mp = proj(0, C.net, 1.0);
      const z = 2.6;
      const k3 = Math.min(1, dt * 2.5);
      M.cam.z += (z - M.cam.z) * k3;
      M.cam.x += (clamp(-(mp.x - 640) * z, -(z - 1) * 640, (z - 1) * 640) - M.cam.x) * k3;
      M.cam.y += (clamp(-(mp.y - 360) * z - 30, -(z - 1) * 360, (z - 1) * 360) - M.cam.y) * k3;
      return;
    }
    const C2 = M.cut;
    if (C2 && !M.celeb && M.phase === 'pointOver' && !M.challengeable && M.phaseT >= C2.at && M.phaseT < C2.until) {
      const f = C2.who === 0 ? M.player : M.opp;
      const fp = proj(f.x, f.y, 0);
      const kk = fp.s * 0.88;
      const z = C2.who === 0 ? CUT.zoomYou : CUT.zoomThem;
      const tx = clamp(-(fp.x - 640) * z, -(z - 1) * 640, (z - 1) * 640);
      const ty = clamp(-(fp.y - 1.15 * kk - 360) * z, -(z - 1) * 360, (z - 1) * 360);
      // A hard cut in, then a slow drift closer while it holds
      if (!C2.live) {
        C2.live = true;
        M.cam.z = z;
        M.cam.x = tx;
        M.cam.y = ty;
        if (C2.who === 1 && C2.say) M.speech = { text: C2.say, who: 'opp', t: 0, dur: C2.until - C2.at };
      }
      const drift = 1 + 0.03 * (M.phaseT - C2.at) / (C2.until - C2.at);
      M.cam.z = z * drift;
      M.cam.x = clamp(tx * drift, -(M.cam.z - 1) * 640, (M.cam.z - 1) * 640);
      M.cam.y = clamp(ty * drift, -(M.cam.z - 1) * 360, (M.cam.z - 1) * 360);
      return;
    }
    if (C2 && C2.live) {
      // And a hard cut back to the wide shot
      C2.live = false;
      M.cut = null;
      M.cam.z = 1.05;
      M.cam.x = 0;
      M.cam.y = 0;
    }
    if (M.celeb) {
      // Close in on you while you celebrate
      const fp = proj(M.player.x, M.player.y, 0);
      const kk = fp.s * 0.88;
      const z = reduceMotion ? 1.25 : 1.55;
      const tx = -(fp.x - 640) * z;
      const ty = -(fp.y - 1.1 * kk - 360) * z;
      const k = Math.min(1, dt * 3);
      M.cam.z += (z - M.cam.z) * k;
      M.cam.x += (clamp(tx, -(M.cam.z - 1) * 640, (M.cam.z - 1) * 640) - M.cam.x) * k;
      M.cam.y += (clamp(ty, -(M.cam.z - 1) * 360, (M.cam.z - 1) * 360) - M.cam.y) * k;
      return;
    }
    const s = M.shot;
    const focus = s ? shotPos(s, s.t) : { x: (M.player.x + M.opp.x) / 2, y: 12 };
    const big = M.tiebreak || (pointWinsGame(0) && gameWinsSet(0)) || (pointWinsGame(1) && gameWinsSet(1));
    // On a big point, before the serve, the camera creeps in
    const creep = M.bigPoint && /prePoint|serveReady|serveAim/.test(M.phase);
    const z = reduceMotion ? 1.04 : 1.05 + (creep ? 0.08 : big ? 0.035 : 0);
    const maxX = (z - 1) * 640 * 0.92;
    const maxY = (z - 1) * 360 * 0.9;
    const tx = reduceMotion ? 0 : clamp(-focus.x * 9, -maxX, maxX);
    const ty = reduceMotion ? 0 : clamp((focus.y - 12) * 1.3, -maxY, maxY);
    const k = Math.min(1, dt * (creep ? 0.7 : 2.2));
    M.cam.x += (tx - M.cam.x) * k;
    M.cam.y += (ty - M.cam.y) * k;
    M.cam.z += (z - M.cam.z) * k;
    M.cam.x = clamp(M.cam.x, -(M.cam.z - 1) * 640, (M.cam.z - 1) * 640);
    M.cam.y = clamp(M.cam.y, -(M.cam.z - 1) * 360, (M.cam.z - 1) * 360);
  }

  function moveBody(b, speed, dt) {
    if (b.react > 0) { b.react -= dt; b.vx = 0; return; }
    const dx = b.tx - b.x;
    const dy = b.ty - b.y;
    const d = Math.hypot(dx, dy);
    const step = Math.min(d, speed * dt);
    const prevVx = b.vx || 0;
    if (d > 0.001) {
      b.x += dx / d * step;
      b.y += dy / d * step;
      b.vx = dx / d * step / dt;
    } else b.vx = 0;
    b.run += step * 3.2;
    return prevVx;
  }

  // A burst of sparks at a point on court. They live in screen space around the projected point.
  function spawnSparks(x, y, z, n, colors, power) {
    if (reduceMotion) return;
    const p = proj(x, y, z);
    // Never too small to see, even at the far baseline
    const k = clamp(p.s / 60, 1.1, 2.2) * (power || 1);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (140 + Math.random() * 320) * k;
      M.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60 * k, t: 0, life: 0.3 + Math.random() * 0.35, w: (2.2 + Math.random() * 2.4) * k, color: colors[i % colors.length] });
    }
    M.sparks.push({ ring: true, x: p.x, y: p.y, t: 0, life: 0.3, r: 40 * k });
  }
  function updateSparks(dt) {
    M.sparks.forEach((s) => {
      s.t += dt;
      if (s.ring) return;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 900 * dt;
      s.vx *= 1 - dt * 2.5;
    });
    M.sparks = M.sparks.filter((s) => s.t < s.life);
  }
  function drawSparks(ctx) {
    if (!M.sparks.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    M.sparks.forEach((s) => {
      const a = 1 - s.t / s.life;
      if (s.ring) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (a * 0.9).toFixed(2) + ')';
        ctx.lineWidth = 4 * a + 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * (0.3 + (1 - a) * 1.4), 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = a;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
      ctx.stroke();
    });
    ctx.restore();
  }
  // A big moment: the world stops for a beat while the sparks fly
  function bigHit(x, y, z, freeze, n, power) {
    spawnSparks(x, y, z, n, ['#ffffff', '#d9f24a', '#ffd166', '#fff3a0'], power);
    M.hitStop = Math.max(M.hitStop, freeze);
    M.shake = Math.max(M.shake, 0.35 * (power || 1));
  }

  function updateMatch(dtReal) {
    // Hit stop: everything holds still except the sparks and the rage bar
    M.rageFx.jump = Math.max(0, M.rageFx.jump - dtReal * 2.2);
    updateSparks(dtReal);
    if (M.hitStop > 0) {
      M.hitStop -= dtReal;
      return;
    }
    // Slow motion for the last instant before you meet the ball on a pressure point
    const s0 = M.shot;
    let slow = 1;
    if (M.bigPoint && M.phase === 'rally' && s0 && s0.hitter === 1 && !s0.resolved && !s0.dead) {
      const until = s0.tc - s0.t;
      if (until < 0.45 && until > -0.25) slow = 0.45;
    }
    M.timeScale += (slow - M.timeScale) * Math.min(1, dtReal * 14);
    const dt = dtReal * M.timeScale;
    M.time += dt;
    M.wobble = Math.max(0, M.wobble - dt * 1.2);
    M.shake = Math.max(0, M.shake - dt * 3);
    M.mphT = Math.max(0, M.mphT - dt);
    M.player.swing = Math.max(0, M.player.swing - dt);
    M.opp.swing = Math.max(0, M.opp.swing - dt);
    [M.player, M.opp].forEach((bd) => { bd.split = Math.max(0, (bd.split || 0) - dt); bd.lunge = Math.max(0, (bd.lunge || 0) - dt); });
    M.skids.forEach((sk) => { sk.t += dt; });
    M.skids = M.skids.filter((sk) => sk.t < sk.life);
    M.opp.mouth = Math.max(0, M.opp.mouth - dt);
    if (M.calls[0]) M.calls[0].t += dt;
    while (M.calls.length && M.calls[0].t > M.calls[0].dur) M.calls.shift();
    M.floaters.forEach((f) => { f.t += dt; });
    M.floaters = M.floaters.filter((f) => f.t < 1.4);
    M.marks.forEach((m) => { m.t += dt; });
    M.marks = M.marks.filter((m) => m.t < (m.hold || (M.surf.marks ? 6 : 0.8)));
    if (M.speech) { M.speech.t += dt; if (M.speech.t > M.speech.dur) M.speech = null; }
    M.parts.forEach((p) => { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt; });
    M.parts = M.parts.filter((p) => p.t < p.life);

    // Steam from the ears above 70% rage
    if (M.rage > 0.7) {
      M.steam += dt * (M.rage - 0.6) * 22;
      while (M.steam > 1) {
        M.steam -= 1;
        const hp = proj(M.player.x, M.player.y, 1.9);
        M.parts.push({ x: hp.x + (Math.random() - 0.5) * 30, y: hp.y, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 40, t: 0, life: 0.9, r: 6 + Math.random() * 6, kind: 'steam' });
      }
    }

    // Movement. The legs run to the ball by themselves. The left thumb steers, one axis at a time:
    // push sideways and you choose where to stand, push up or down and you choose your depth, and
    // whatever you are not pushing the legs still look after. Let go and they take over again.
    const p = M.player;
    let sx = M.stick.active ? M.stick.vx : 0;
    let sy = M.stick.active ? M.stick.vy : 0;
    if (!M.stick.active) {
      const km = M.keyMove;
      sx = (km.r ? 1 : 0) - (km.l ? 1 : 0);
      sy = (km.u ? 1 : 0) - (km.d ? 1 : 0);
      const n = Math.hypot(sx, sy);
      if (n > 1) { sx /= n; sy /= n; }
    }
    let prev = p.vx || 0;
    if (M.phase !== 'rally') {
      prev = moveBody(p, 7 * (p.boost || 1), dt);
    } else {
      const sp = 7.2 * (p.boost || 1);
      // Where the legs would go: sideways to the ball, keeping your depth once you have come in,
      // unless a lob is going over you. Backpedalling is slower than running forwards.
      const backOff = p.backOff && s_incoming();
      const gx = p.tx;
      // Serve and volley: push up just after your serve and you follow it in to the volleying position
      const s0 = M.shot;
      if (sy > 0.5 && s0 && s0.serve && s0.hitter === 0 && s0.t < 0.9 && !p.rush && p.y < 3) {
        p.rush = 7.2;
        M.floaters.push({ text: 'SERVE AND VOLLEY', x: 640, y: 470, t: 0, color: '#9fe7ff', big: true });
      }
      // Following a serve or an approach shot in: keep running to the volleying position
      if (p.rush && (p.y >= p.rush - 0.15 || M.phase !== 'rally')) p.rush = 0;
      if (p.retreat && (p.y < 0.5 || M.phase !== 'rally')) p.retreat = false;
      const gy = p.rush ? p.rush : p.retreat ? Math.min(p.ty, -0.4) : p.y > 2 && !backOff ? p.y : p.ty;
      const dx = gx - p.x;
      const dy = gy - p.y;
      const d = Math.hypot(dx, dy);
      let vx = d > 0.02 ? dx / d * Math.min(sp, d / dt) : 0;
      let vy = d > 0.02 ? dy / d * Math.min(sp, d / dt) : 0;
      const pro = proFeet();
      p.goal = { x: gx, y: gy };
      // The moment your feet are set for this ball (used to tell a shot on the run)
      if (!pro && s_incoming() && d < 0.15 && M.shot.setT === undefined) M.shot.setT = M.shot.t;
      if (backOff && vy < 0) vy *= 0.6;
      // Pro: the legs only go where your thumb sends them (following a serve in still runs on)
      if (pro && !p.rush) { vx = 0; vy = 0; }
      if (Math.abs(sx) > 0.25) vx = sx * sp;
      if (Math.abs(sy) > 0.25) vy = sy * sp;
      // Pro: set means near the right spot and standing still
      if (pro && s_incoming() && d < 0.7 && Math.hypot(vx, vy) < 0.5 && M.shot.setT === undefined) M.shot.setT = M.shot.t;
      if (pro && s_incoming() && M.shot.setT !== undefined && d >= 0.7 && M.shot.t - M.shot.setT < 0.3) M.shot.setT = undefined;
      p.x = clamp(p.x + vx * dt, -8, 8);
      p.y = clamp(p.y + vy * dt, -2.3, 10.6);   // deeper than this and the camera loses your feet
      p.vx = vx;
      p.run += Math.hypot(vx, vy) * dt * 3.2;
    }
    if (Math.abs(p.vx) > 3 && (Math.sign(p.vx) !== Math.sign(prev || 0) || Math.abs(prev || 0) < 1) && M.time - p.lastSqueak > 0.45) {
      p.lastSqueak = M.time;
      sfx('squeak', { pan: p.x / 8 });
      footFx(p, prev);
    }
    const prevO = moveBody(M.opp, (4.2 + 3.2 * M.cfg.skill) * diff().oppSpeed * (M.opp.boost || 1), dt);
    const o2 = M.opp;
    if (Math.abs(o2.vx) > 3 && (Math.sign(o2.vx) !== Math.sign(prevO || 0) || Math.abs(prevO || 0) < 1) && M.time - (o2.lastSqueak || 0) > 0.45) {
      o2.lastSqueak = M.time;
      if (M.cfg.surface !== 'grass') sfx('squeak', { pan: o2.x / 8, power: 0.6 });
      footFx(o2, prevO);
    }

    // Taking your time over your serve: gamesmanship. After 4 s it starts to get to them.
    if (M.phase === 'serveReady' && M.server === 0 && !M.tut && M.phaseT > 4 && M.dawdle < 0.12) {
      if (!M.dawdle) M.speech = { text: pick(['Any time today!', 'Serve the ball!', 'We are all waiting.']), who: 'opp', t: 0, dur: 1.6 };
      M.dawdle += dt * 0.03;
      oppTemper(dt * 0.03);
    }
    M.oppTempFx = Math.max(0, M.oppTempFx - dt * 2);
    if (!M.tip && M.tipQueue && M.tipQueue.length && tipQuiet()) {
      M.tip = M.tipQueue.shift();
      sfx('chime', { good: true });
    }
    // Its time only runs while it can be seen
    if (M.tip && tipQuiet()) { M.tip.t += dt; if (M.tip.t > M.tip.dur) M.tip = null; }
    // Crowd: excitement decays, the wave rolls across the stand once a long rally gets going
    M.hype = Math.max(0, M.hype - dt * 0.45);
    if (M.rallyCount >= 8 && M.waveT < 0 && !M.waveDone) { M.waveT = 0; M.waveDone = true; sfx('applause', { power: 0.5 }); }
    if (M.rallyCount === 0) M.waveDone = false;
    if (M.waveT >= 0) { M.waveT += dt; if (M.waveT > 2.6) M.waveT = -1; }
    if (M.celeb) { M.celeb.t += dt; if (M.celeb.t >= CELEB_LEN) M.celeb = null; }
    updateCrew(dt);
    if (M.crowdMood) { M.crowdMood.t += dt; if (M.crowdMood.t >= M.crowdMood.dur) M.crowdMood = null; }
    updateCamera(dt);
    recordFrame();
    if (M.quietAt && M.time >= M.quietAt && /prePoint|serveReady|serveAim/.test(M.phase)) { M.quietAt = 0; say(pick(umpire().quiet)); }
    // A fan's shout: the words on screen and the crowd's cheer (a spoken voice sounded robotic)
    if (M.fanShout && M.time >= M.fanShout.at) {
      const F = M.fanShout;
      M.fanShout = null;
      if (/prePoint|serveReady|serveAim|oppToss/.test(M.phase)) {
        sfx('cheer', { power: 0.6, pan: (F.x - 640) / 900 });
        M.floaters.push({ text: F.text.toUpperCase(), x: F.x, y: 170, t: 0, color: '#f4f1e6', big: true });
      }
    }

    M.phaseT += dt;
    switch (M.phase) {
      case 'intro':
        if (M.phaseDur > 3 && M.phaseT > 1 && !M.introSaid) {
          M.introSaid = true;
          const rv0 = rivalRec(M.cfg.opp.name);
          if (rv0) M.speech = { text: isNemesis(M.cfg.opp.name) ? pick(['You again. Lovely.', 'Back for more?', 'I remember you.']) : rv0.last === 'w' ? pick(['Not this time.', 'I have been thinking about you.', 'Rematch. Good.']) : pick(['Again?', 'This should not take long.']), who: 'opp', t: 0, dur: 1.8 };
        }
        if (M.phaseDur > 3 && M.phaseT < 2.6) {
          // Both players jog out from their benches by the umpire's chair to the baseline
          const u = clamp(M.phaseT / 2.4, 0, 1);
          const e = u * u * (3 - 2 * u);
          [[M.player, -7.0, C.net - 1.9, 0.8, -0.8], [M.opp, -7.0, C.net + 1.9, -0.8, 24.6]].forEach((q) => {
            const b = q[0];
            const nx = lerp(q[1], q[3], e);
            const ny = lerp(q[2], q[4], e);
            const sp = Math.hypot(nx - b.x, ny - b.y) / Math.max(dt, 0.001);
            b.vx = u < 1 ? Math.sign(q[3] - q[1]) * Math.min(6, sp) : 0;
            b.run += Math.min(6, sp) * dt * 3.2;
            b.x = b.tx = nx;
            b.y = b.ty = ny;
          });
        }
        if (M.phaseT >= M.phaseDur) nextPoint();
        break;
      case 'prePoint':
        if (hasTrait('timewaster') && M.server === 1 && M.phaseDur > 1.5) {
          M.bounceT += dt;
          if (M.bounceT > 0.4) {
            M.bounceT = 0;
            M.bounceCount++;
            sfx('bounce', { power: 0.35, pan: -0.1 });
            addRage(0.008, false);
          }
          if (M.bounceCount === 6 && !M.speech) M.speech = { text: 'Bouncing. Still.', who: 'opp', t: 0, dur: 1.2 };
        }
        if (M.phaseT >= M.phaseDur) startServe();
        break;
      case 'serveReady':
        // You bounce the ball while you get ready: a soft bounce each time it lands
        if (M.server === 0 && Math.floor(M.phaseT / 0.8) !== Math.floor((M.phaseT - dt) / 0.8)) sfx('bounce', { power: 0.25, pan: -0.05 });
        break;
      case 'serveAim':
        M.tossT += dt;
        M.power = powerAt(M.tossT);
        if (M.notReadyPending && M.tossT > 0.45) {
          M.notReadyPending = false;
          M.phase = 'serveReady';
          M.touch.ignoreUp = M.touch.down || M.keyDown;
          M.speech = { text: 'Not ready!', who: 'opp', t: 0, dur: 1.3 };
          callout('notReady', { dur: 1.8, color: '#ff8a80' });
          addRage(0.06, 'NOT READY');
          sfx('boo');
        }
        break;
      case 'oppToss':
        if (M.phaseT >= M.phaseDur) oppServe();
        break;
      case 'rally':
        updateRally(dt);
        break;
      case 'pointOver':
        if (M.shot) { M.shot.t += dt; }
        if (M.phaseT >= M.phaseDur) afterPoint();
        break;
      case 'review':
        M.review.t += dt;
        if (!M.review.sounded && M.review.t > 2.25) {
          M.review.sounded = true;
          sfx('chime', { good: M.review.truthIn });
          vibrate(M.review.truthIn ? [30, 40, 30] : 60);
        }
        if (M.review.t >= 3.6) resolveChallenge();
        break;
      case 'matchOver':
        if (M.shot && M.phaseDur > 0.05) M.shot.t += dt;
        if (M.phaseT >= M.phaseDur) {
          scorePoint();
          if (!M.hsDone && (M.endReason || 'normal') === 'normal' && !M.tut) startHandshake();
          else if (!M.hlDone && M.bestPoint && (M.endReason || 'normal') === 'normal' && !M.tut) startHighlight(!!SAVE.settings.short);
          else finishMatch(M.endReason || 'normal');
        }
        break;
      case 'handshake':
        updateHandshake(dt);
        break;
      case 'highlight': {
        // Point of the match: played back from the recording, the last 30% in slow motion
        const HL = M.hl;
        const n = HL.f.length;
        HL.i += dt * 60 * (HL.i > HL.slowFrom ? 0.45 : 1);
        if (!HL.shot && HL.i > HL.slowFrom - 8) {
          HL.shot = true;
          captureTantrum('POINT OF THE MATCH', M.bestPoint.title + (M.bestPoint.rally >= 6 ? ', after a ' + M.bestPoint.rally + '-shot rally' : ''), false);
          const shot = M.tantrumShots[M.tantrumShots.length - 1];
          if (shot) shot.highlight = true;
        }
        if (HL.instant && (HL.skip || HL.i >= n - 1)) {
          // Back to the live picture, where the point ended
          const bk = M.instantBack;
          Object.assign(M.player, bk.p);
          Object.assign(M.opp, bk.o);
          M.shot = bk.shot;
          Object.assign(M.cam, bk.cam);
          M.stinger = { t: M.time };
          M.phase = 'pointOver';
          M.phaseT = M.phaseDur;
          break;
        }
        if (HL.skip || HL.i >= n - 1) {
          M.stinger = { t: M.time };
          M.phase = 'matchOver';
          M.phaseT = 0;
          M.phaseDur = 0.01;
        } else applyFrame(HL.f[Math.floor(HL.i)]);
        break;
      }
    }
  }

  /* ---- input handlers for the match ---- */
  // Recent finger positions, used to spot a flick at release
  const samples = [];
  function sample(pos) {
    samples.push({ t: performance.now(), x: pos.x, y: pos.y });
    if (samples.length > 16) samples.shift();
  }
  // Returns { flick, aimPos }. A flick is a fast vertical move just before release; the aim is
  // taken from just before the flick started, so flicking never drags the aim off target.
  function readFlick(pos) {
    const now = performance.now();
    let first = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (now - samples[i].t > 120) break;
      first = samples[i];
    }
    if (!first || !pos) return { flick: 0, aimPos: pos };
    const dtS = Math.max(0.016, (now - first.t) / 1000);
    const dy = pos.y - first.y;
    const vy = dy / dtS;
    if (Math.abs(dy) > 28 && Math.abs(vy) > 650) return { flick: vy < 0 ? 1 : -1, aimPos: first };
    return { flick: 0, aimPos: pos };
  }

  function pressDown(pos) {
    if (!M || M.paused) return;
    window.RRAudio && RRAudio.resume();
    samples.length = 0;
    if (pos) { setAimFromScreen(pos.x, pos.y); sample(pos); }
    if (M.tut && M.phase === 'rally') clearStamps();
    if (M.phase === 'rally') M.chargeStart = M.time;
    if (M.phase === 'serveReady') {
      clearStamps();
      M.phase = 'serveAim';
      M.tossT = 0;
      M.power = 0;
      M.touch.ignoreUp = false;
      sfx('bounce', { power: 0.3 });
    }
  }
  function pressMove(pos) {
    if (!M || M.paused) return;
    setAimFromScreen(pos.x, pos.y);
    sample(pos);
  }
  function pressUp(pos) {
    if (!M || M.paused) return;
    let flick = M.keyFlick || 0;
    if (pos) {
      const f = readFlick(pos);
      if (f.flick) flick = f.flick;
      setAimFromScreen(f.aimPos.x, f.aimPos.y);
    }
    samples.length = 0;
    if (M.touch.ignoreUp) { M.touch.ignoreUp = false; return; }
    if (M.phase !== 'rally') M.chargeStart = null;
    if (M.phase === 'serveAim') playerServe(flick);
    else if (M.phase === 'rally') trySwing(flick);
  }

  /* =====================================================================
     7. Match rendering and HUD
     ===================================================================== */
  // A player on court. front = facing the camera (the opponent), otherwise seen from behind (you).
  // opts: { toss (0 to 1), load (holding a charged backswing), stance ('ready', 'sulk', 'overhead'),
  //         redden (0 to 1), time (seconds, for idle animation), noRacket }
  // ---- Kit painters, shared by the small court figures and the big close up puppet ----
  // A design drawn inside a box that the caller has already clipped to the garment
  function paintDesign(ctx, design, x, y, w, h, c2, c3, c4, front) {
    if (!design || design === 'plain') return;
    c3 = c3 || c2;
    c4 = c4 || c3;
    const fillPoly = (pts, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x + p[0] * w, y + p[1] * h) : ctx.moveTo(x + p[0] * w, y + p[1] * h)));
      ctx.closePath();
      ctx.fill();
    };
    const blob = (cx, cy, r, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(x + cx * w, y + cy * h, r * w, r * w * 0.7, cx * 3, 0, Math.PI * 2);
      ctx.fill();
    };
    switch (design) {
      case 'polo': {
        // Collar and a buttoned placket from the front, a collar band from behind
        ctx.fillStyle = c2;
        if (front) {
          fillPoly([[0.28, 0], [0.5, 0.2], [0.42, 0.24], [0.22, 0.06]], c2);
          fillPoly([[0.72, 0], [0.5, 0.2], [0.58, 0.24], [0.78, 0.06]], c2);
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(x + w * 0.485, y + h * 0.2, w * 0.03, h * 0.22);
          ctx.fillStyle = c2;
          [0.27, 0.36].forEach((v) => { ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * v, Math.max(0.8, w * 0.025), 0, Math.PI * 2); ctx.fill(); });
        } else ctx.fillRect(x + w * 0.22, y, w * 0.56, h * 0.08);
        break;
      }
      case 'pinstripe':
        ctx.fillStyle = c2;
        for (let i = 1; i < 9; i++) ctx.fillRect(x + (i / 9) * w, y, Math.max(0.6, w * 0.012), h);
        break;
      case 'stripes':
        ctx.fillStyle = c2;
        ctx.fillRect(x + w * 0.3, y, w * 0.13, h);
        ctx.fillRect(x + w * 0.57, y, w * 0.13, h);
        break;
      case 'hoops':
        ctx.fillStyle = c2;
        for (let i = 0; i < 6; i += 2) ctx.fillRect(x, y + (i + 0.5) * h / 6, w, h / 6);
        break;
      case 'chevron':
        fillPoly([[0, 0.18], [0.5, 0.5], [1, 0.18], [1, 0.36], [0.5, 0.68], [0, 0.36]], c2);
        break;
      case 'sash':
        fillPoly([[0, 0], [0.24, 0], [1, 0.82], [1, 1], [0.78, 1], [0, 0.2]], c2);
        break;
      case 'bolt':
        fillPoly([[0.62, 0], [0.3, 0.52], [0.5, 0.52], [0.36, 1], [0.74, 0.42], [0.54, 0.42], [0.72, 0]], c2);
        break;
      case 'dots':
        ctx.fillStyle = c2;
        for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) {
          ctx.beginPath();
          ctx.arc(x + ((c + (r % 2) * 0.5) / 4.5) * w, y + (r / 5.2 + 0.05) * h, Math.max(0.8, w * 0.045), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 'hawaiian': {
        const flower = (cx, cy) => {
          ctx.fillStyle = c3;
          ctx.beginPath();
          ctx.ellipse(x + (cx + 0.08) * w, y + (cy + 0.07) * h, w * 0.1, w * 0.04, 0.7, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = c2;
          for (let p = 0; p < 5; p++) {
            const a = p * Math.PI * 0.4;
            ctx.beginPath();
            ctx.arc(x + cx * w + Math.cos(a) * w * 0.05, y + cy * h + Math.sin(a) * w * 0.05, w * 0.045, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = '#e76f51';
          ctx.beginPath();
          ctx.arc(x + cx * w, y + cy * h, w * 0.025, 0, Math.PI * 2);
          ctx.fill();
        };
        [[0.22, 0.2], [0.7, 0.32], [0.35, 0.62], [0.8, 0.78], [0.12, 0.9]].forEach((p) => flower(p[0], p[1]));
        break;
      }
      case 'retro':
        ctx.fillStyle = c2;
        ctx.fillRect(x, y + h * 0.3, w, h * 0.09);
        ctx.fillStyle = c3;
        ctx.fillRect(x, y + h * 0.39, w, h * 0.09);
        ctx.fillStyle = c4;
        ctx.fillRect(x, y + h * 0.48, w, h * 0.09);
        break;
      case 'camo':
        [[0.2, 0.15, 0.22, c2], [0.7, 0.3, 0.2, c3], [0.35, 0.55, 0.24, c3], [0.8, 0.72, 0.2, c2], [0.15, 0.85, 0.18, c2], [0.55, 0.92, 0.16, '#2a2f1c']].forEach((q) => blob(q[0], q[1], q[2], q[3]));
        break;
      case 'tiedye': {
        const cols = [c2, c3, c4, c2, c3];
        for (let i = 5; i >= 1; i--) {
          ctx.fillStyle = cols[i - 1];
          ctx.beginPath();
          ctx.arc(x + w * 0.5, y + h * 0.42, (i / 5) * Math.max(w, h) * 0.75, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'sequins':
        ctx.fillStyle = c2;
        for (let r = 0; r < 9; r++) for (let c = 0; c < 7; c++) {
          if ((r * 7 + c) % 3 === 0) continue;
          ctx.fillRect(x + ((c + (r % 2) * 0.5) / 6.5) * w, y + (r / 8.5) * h, Math.max(0.8, w * 0.03), Math.max(0.8, w * 0.03));
        }
        break;
      case 'cord':
        ctx.fillStyle = c2;
        for (let i = 1; i < 12; i++) ctx.fillRect(x + (i / 12) * w, y, Math.max(0.5, w * 0.012), h);
        break;
      case 'stripe':
        ctx.fillStyle = c2;
        ctx.fillRect(x, y, w * 0.1, h);
        ctx.fillRect(x + w * 0.9, y, w * 0.1, h);
        break;
      case 'tartan':
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = c2;
        for (let i = 0; i < 5; i++) {
          ctx.fillRect(x + (i / 4.5) * w, y, w * 0.06, h);
          ctx.fillRect(x, y + (i / 4.5) * h, w, h * 0.06);
        }
        ctx.fillStyle = c3;
        for (let i = 0; i < 5; i++) {
          ctx.fillRect(x + (i / 4.5 + 0.1) * w, y, Math.max(0.5, w * 0.012), h);
          ctx.fillRect(x, y + (i / 4.5 + 0.1) * h, w, Math.max(0.5, h * 0.012));
        }
        ctx.globalAlpha = 1;
        break;
    }
  }
  // A shirt: base colour, the design clipped to it, side trim and the sponsor name
  function paintShirt(ctx, x, y, w, h, r, kit, front, textSize) {
    ctx.fillStyle = kit.shirt;
    torsoPath(ctx, x, y, w, h, r);
    ctx.fill();
    if (kit.design) {
      ctx.save();
      torsoPath(ctx, x, y, w, h, r);
      ctx.clip();
      paintDesign(ctx, kit.design, x, y, w, h, kit.shirt2 || '#ffffff', kit.shirt3, kit.shirt4, front);
      ctx.restore();
    }
    if (kit.trim) {
      ctx.fillStyle = kit.trim;
      ctx.fillRect(x, y + h * 0.12, w * 0.12, h * 0.8);
      ctx.fillRect(x + w - w * 0.12, y + h * 0.12, w * 0.12, h * 0.8);
    }
    // Cel shading: a hard shade down the side away from the light and a lit edge, so the body reads round.
    // Drawn as shapes that follow the torso's own edges (no clipping, which can be slow on phones).
    const inset = w * 0.06;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.76, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w - inset, y + h);
    ctx.lineTo(x + w * 0.78, y + h);
    ctx.quadraticCurveTo(x + w * 0.7, y + h * 0.5, x + w * 0.76, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.lineTo(x + w * 0.09, y + r);
    ctx.lineTo(x + inset + w * 0.07, y + h);
    ctx.lineTo(x + inset, y + h);
    ctx.closePath();
    ctx.fill();
    // The hem
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.beginPath();
    ctx.moveTo(x + inset * 0.9, y + h * 0.9);
    ctx.lineTo(x + w - inset * 0.9, y + h * 0.9);
    ctx.lineTo(x + w - inset, y + h);
    ctx.lineTo(x + inset, y + h);
    ctx.closePath();
    ctx.fill();
    if (w > 36) {
      // Folds from the armpits and at the waist, only when the figure is big enough to show them
      ctx.strokeStyle = 'rgba(0,0,0,0.13)';
      ctx.lineWidth = Math.max(1, w * 0.025);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.12, y + h * 0.3);
      ctx.quadraticCurveTo(x + w * 0.2, y + h * 0.42, x + w * 0.3, y + h * 0.46);
      ctx.moveTo(x + w * 0.88, y + h * 0.3);
      ctx.quadraticCurveTo(x + w * 0.8, y + h * 0.42, x + w * 0.7, y + h * 0.46);
      ctx.moveTo(x + w * 0.38, y + h * 0.8);
      ctx.quadraticCurveTo(x + w * 0.46, y + h * 0.86, x + w * 0.56, y + h * 0.82);
      ctx.stroke();
    }
    ctx.restore();
    // Collar: a V at the front, a band at the back of the neck
    ctx.fillStyle = kit.shirt2 && kit.shirt2 !== kit.shirt ? kit.shirt2 : shadeHex(kit.shirt, -0.25);
    ctx.beginPath();
    if (front) {
      ctx.moveTo(x + w * 0.36, y);
      ctx.lineTo(x + w * 0.5, y + h * 0.16);
      ctx.lineTo(x + w * 0.64, y);
    } else {
      ctx.moveTo(x + w * 0.34, y);
      ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.07, x + w * 0.66, y);
      ctx.lineTo(x + w * 0.66, y - h * 0.02);
      ctx.lineTo(x + w * 0.34, y - h * 0.02);
    }
    ctx.closePath();
    ctx.fill();
    if (kit.text && textSize) {
      ctx.font = 'bold ' + Math.round(textSize) + 'px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(1, textSize * 0.18);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      if (kit.design && kit.design !== 'polo' && kit.design !== 'pinstripe') ctx.strokeText(kit.text, x + w / 2, y + h * (front ? 0.55 : 0.38));
      ctx.fillStyle = kit.textColor || '#1f3a6b';
      ctx.fillText(kit.text, x + w / 2, y + h * (front ? 0.55 : 0.38));
    }
  }
  function shortsPath(ctx, x, y, w, h) {
    const fl = w * 0.05;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w + fl, y + h);
    ctx.lineTo(x - fl, y + h);
    ctx.closePath();
  }
  function paintShorts(ctx, x, y, w, h, r, kit) {
    if (kit.skirt) {
      const fl = w * 0.16;
      const hs = h * 1.12;
      ctx.fillStyle = kit.shorts;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w + fl, y + hs);
      ctx.lineTo(x - fl, y + hs);
      ctx.closePath();
      ctx.fill();
      // Pleats: thin darker lines fanning out to the hem
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = Math.max(1, w * 0.02);
      ctx.beginPath();
      for (let i = 1; i < 6; i++) {
        const u = i / 6;
        ctx.moveTo(x + w * u, y + hs * 0.18);
        ctx.lineTo(x - fl + (w + 2 * fl) * u, y + hs);
      }
      ctx.stroke();
      // Cel shade down the side away from the light, and the waistband
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.76, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w + fl, y + hs);
      ctx.lineTo(x + w * 0.76 + fl * 0.76, y + hs);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(x, y, w, h * 0.12);
      return;
    }
    ctx.fillStyle = kit.shorts;
    shortsPath(ctx, x, y, w, h);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x - w * 0.05, y + h * 0.88, w * 1.1, h * 0.12);
    if (kit.shortsDesign) {
      ctx.save();
      shortsPath(ctx, x, y, w, h);
      ctx.clip();
      paintDesign(ctx, kit.shortsDesign, x, y, w, h, kit.shorts2 || '#ffffff', kit.shorts3, null, true);
      ctx.restore();
    }
    // The gap between the legs
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + w * 0.49, y + h * 0.55, w * 0.02, h * 0.45);
    // Cel shade and waistband, as on the shirt, following the shorts' flared edges (no clipping)
    const fl = w * 0.05;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.76, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w + fl, y + h);
    ctx.lineTo(x + w * 0.76 + fl * 0.76, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w + fl * 0.12, y + h * 0.12);
    ctx.lineTo(x - fl * 0.12, y + h * 0.12);
    ctx.closePath();
    ctx.fill();
  }
  // A small court shoe. From behind: heel counter, pull tab and sole. From the front: toe box and laces.
  function paintShoeSmall(ctx, cx, gy, k, kit, front) {
    const w = 0.17 * k;
    const h = 0.1 * k;
    const sole = kit.shoeSole || '#ffffff';
    const upper = kit.shoes || '#f6f6f2';
    const accent = kit.shoeAccent || '#1f3a6b';
    ctx.fillStyle = upper;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, gy - h * 0.25);
    ctx.quadraticCurveTo(cx - w * 0.5, gy - h, cx - w * 0.18, gy - h);
    ctx.quadraticCurveTo(cx, gy - h * (front ? 1.05 : 0.82), cx + w * 0.18, gy - h);
    ctx.quadraticCurveTo(cx + w * 0.5, gy - h, cx + w * 0.5, gy - h * 0.25);
    ctx.closePath();
    ctx.fill();
    if (front) {
      // Laces down the tongue
      ctx.fillStyle = accent;
      ctx.fillRect(cx - w * 0.12, gy - h * 0.95, w * 0.24, h * 0.55);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 3; i++) ctx.fillRect(cx - w * 0.14, gy - h * (0.9 - i * 0.18), w * 0.28, Math.max(0.6, h * 0.07));
    } else {
      // Heel counter and pull tab
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(cx - w * 0.5, gy - h * 0.55, w, h * 0.3);
      ctx.fillStyle = accent;
      ctx.fillRect(cx - w * 0.09, gy - h * 1.08, w * 0.18, h * 0.5);
    }
    ctx.fillStyle = sole;
    roundRect(ctx, cx - w * 0.54, gy - h * 0.28, w * 1.08, h * 0.3, h * 0.12);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(cx - w * 0.54, gy - h * 0.04, w * 1.08, h * 0.06);
  }
  // A big shoe in three quarter profile, toe pointing dir (+1 right, -1 left)
  function paintShoeBig(ctx, fx, fy, dir, kit) {
    const L = 0.3 * KP;
    const h = 0.12 * KP;
    const sole = kit.shoeSole || '#ffffff';
    const upper = kit.shoes || '#f6f6f2';
    const accent = kit.shoeAccent || '#1f3a6b';
    const X = (u) => fx + dir * u * L;
    // Upper: heel at the back, collar dipping at the ankle, a long vamp to a rounded toe
    ctx.fillStyle = upper;
    ctx.beginPath();
    ctx.moveTo(X(-0.36), fy - h * 0.2);
    ctx.quadraticCurveTo(X(-0.4), fy - h * 0.95, X(-0.28), fy - h * 1.05);
    ctx.quadraticCurveTo(X(-0.12), fy - h * 0.82, X(0.02), fy - h * 1.02);
    ctx.quadraticCurveTo(X(0.3), fy - h * 0.72, X(0.56), fy - h * 0.45);
    ctx.quadraticCurveTo(X(0.68), fy - h * 0.3, X(0.64), fy - h * 0.2);
    ctx.closePath();
    ctx.fill();
    // Toe cap and heel tab
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.moveTo(X(0.36), fy - h * 0.2);
    ctx.quadraticCurveTo(X(0.42), fy - h * 0.62, X(0.56), fy - h * 0.45);
    ctx.quadraticCurveTo(X(0.68), fy - h * 0.3, X(0.64), fy - h * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(X(-0.38), fy - h * 0.98);
    ctx.lineTo(X(-0.27), fy - h * 1.12);
    ctx.lineTo(X(-0.22), fy - h * 0.9);
    ctx.lineTo(X(-0.36), fy - h * 0.6);
    ctx.closePath();
    ctx.fill();
    // The flash along the side
    ctx.strokeStyle = accent;
    ctx.lineWidth = h * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(X(-0.26), fy - h * 0.38);
    ctx.quadraticCurveTo(X(0.05), fy - h * 0.3, X(0.28), fy - h * 0.72);
    ctx.stroke();
    // Laces across the vamp
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, h * 0.07);
    for (let i = 0; i < 4; i++) {
      const u = 0.06 + i * 0.07;
      ctx.beginPath();
      ctx.moveTo(X(u), fy - h * (0.98 - i * 0.07));
      ctx.lineTo(X(u + 0.06), fy - h * (0.84 - i * 0.07));
      ctx.stroke();
    }
    // Sole: midsole, then the darker outsole with a tread line
    ctx.fillStyle = sole;
    roundRect(ctx, Math.min(X(-0.4), X(0.68)), fy - h * 0.26, L * 1.08, h * 0.24, h * 0.1);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(Math.min(X(-0.4), X(0.68)), fy - h * 0.06, L * 1.08, h * 0.08);
  }
  // Hair seen from the front. 'behind' draws what falls behind the head (long hair, a bob, a ponytail, a bun);
  // 'top' draws what sits on it.
  // Hair from behind: the cap, plus whatever hangs below it (long, bob, ponytail) or sits on top (bun).
  // sway (-1 to 1) swings a ponytail.
  function backHair(ctx, x, y, hr, col, style, sway) {
    ctx.fillStyle = col;
    ctx.beginPath();
    if (style === 'bald') return;
    if (style === 'long') { ctx.arc(x, y - hr * 0.04, hr * 1.04, Math.PI, 0); ctx.rect(x - hr * 1.04, y - hr * 0.05, hr * 2.08, hr * 1.4); ctx.moveTo(x - hr * 0.95, y + hr * 1.3); ctx.quadraticCurveTo(x, y + hr * 2.6, x + hr * 0.95, y + hr * 1.3); }
    else if (style === 'bob') { ctx.arc(x, y - hr * 0.04, hr * 1.06, Math.PI, 0); ctx.rect(x - hr * 1.06, y - hr * 0.05, hr * 2.12, hr * 0.95); }
    else if (style === 'buzz') ctx.arc(x, y - hr * 0.02, hr * 0.98, 0, Math.PI * 2);
    else if (style === 'balding') { ctx.arc(x, y + hr * 0.15, hr * 1.0, Math.PI * 0.05, Math.PI * 0.95); ctx.arc(x, y - hr * 0.04, hr * 1.02, Math.PI * 0.95, Math.PI * 1.25); ctx.arc(x, y - hr * 0.04, hr * 1.02, Math.PI * 1.75, Math.PI * 2.05); }
    else if (style === 'curly') {
      ctx.arc(x, y - hr * 0.04, hr * 1.02, 0, Math.PI * 2);
      for (let i = 0; i < 8; i++) {
        const a = Math.PI * (0.85 + i * 0.185);
        ctx.moveTo(x + Math.cos(a) * hr * 0.95 + hr * 0.3, y - hr * 0.04 + Math.sin(a) * hr * 0.95);
        ctx.arc(x + Math.cos(a) * hr * 0.95, y - hr * 0.04 + Math.sin(a) * hr * 0.95, hr * 0.3, 0, Math.PI * 2);
      }
    }
    else ctx.arc(x, y - hr * 0.04, hr * 1.02, 0, Math.PI * 2);
    ctx.fill();
    if (style === 'ponytail') {
      const sw = (sway || 0) * hr * 0.35;
      ctx.beginPath();
      ctx.moveTo(x - hr * 0.3, y + hr * 0.3);
      ctx.quadraticCurveTo(x - hr * 0.5 + sw * 0.5, y + hr * 1.5, x - hr * 0.08 + sw, y + hr * 2.35);
      ctx.quadraticCurveTo(x + sw, y + hr * 2.55, x + hr * 0.08 + sw, y + hr * 2.35);
      ctx.quadraticCurveTo(x + hr * 0.5 + sw * 0.5, y + hr * 1.5, x + hr * 0.3, y + hr * 0.3);
      ctx.closePath();
      ctx.fill();
    } else if (style === 'bun') {
      ctx.beginPath();
      ctx.arc(x, y - hr * 0.55, hr * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function frontHair(ctx, x, y, hr, col, style, layer) {
    if (style === 'bald') return;
    ctx.fillStyle = col;
    if (layer === 'behind') {
      ctx.beginPath();
      if (style === 'long') { ctx.arc(x, y - hr * 0.1, hr * 1.12, Math.PI, 0); ctx.rect(x - hr * 1.12, y - hr * 0.1, hr * 2.24, hr * 1.7); }
      else if (style === 'bob') { ctx.arc(x, y - hr * 0.1, hr * 1.1, Math.PI, 0); ctx.rect(x - hr * 1.1, y - hr * 0.1, hr * 2.2, hr * 0.85); }
      else if (style === 'ponytail') ctx.ellipse(x + hr * 1.05, y + hr * 0.45, hr * 0.26, hr * 0.62, -0.2, 0, Math.PI * 2);
      else if (style === 'bun') ctx.arc(x, y - hr * 1.05, hr * 0.42, 0, Math.PI * 2);
      else return;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    if (style === 'balding') {
      [-1, 1].forEach((sd) => { ctx.moveTo(x + sd * hr * 0.86 + hr * 0.3, y - hr * 0.12); ctx.arc(x + sd * hr * 0.86, y - hr * 0.12, hr * 0.3, 0, Math.PI * 2); });
      ctx.fill();
      return;
    }
    if (style === 'buzz') {
      ctx.arc(x, y - hr * 0.12, hr * 1.0, Math.PI * 1.12, Math.PI * 1.88);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (style === 'curly') {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (1.0 + i * 0.2);
        ctx.moveTo(x + Math.cos(a) * hr * 0.85 + hr * 0.36, y - hr * 0.1 + Math.sin(a) * hr * 0.85);
        ctx.arc(x + Math.cos(a) * hr * 0.85, y - hr * 0.1 + Math.sin(a) * hr * 0.85, hr * 0.36, 0, Math.PI * 2);
      }
      ctx.fill();
      return;
    }
    ctx.arc(x, y - hr * 0.25, hr, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    if (style === 'side') {
      ctx.beginPath();
      ctx.ellipse(x - hr * 0.3, y - hr * 0.95, hr * 0.58, hr * 0.28, -0.15, 0, Math.PI * 2);
      ctx.fill();
    } else if (style === 'floppy') {
      ctx.beginPath();
      ctx.moveTo(x - hr * 0.75, y - hr * 0.5);
      ctx.lineTo(x + hr * 0.35, y - hr * 0.62);
      ctx.lineTo(x - hr * 0.45, y - hr * 0.02);
      ctx.closePath();
      ctx.fill();
    } else if (style === 'slick') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = Math.max(1, hr * 0.1);
      ctx.beginPath();
      ctx.arc(x - hr * 0.1, y - hr * 0.3, hr * 0.7, Math.PI * 1.15, Math.PI * 1.55);
      ctx.stroke();
    }
  }
  // A colour lightened (amt > 0) or darkened (amt < 0). Takes #rgb or #rrggbb; anything else comes back unchanged.
  function shadeHex(hex, amt) {
    if (typeof hex !== 'string' || hex[0] !== '#') return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    const f = (v) => Math.round(clamp(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt, 0, 255));
    return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  }
  // A whole limb as a chain of tapered segments (points, and a half width at each), shaded in one pass and lit in
  // a second so the joints never show as bands
  function shadedChain(ctx, pts, hw, col) {
    ctx.fillStyle = shadeHex(col, -0.2);
    for (let i = 1; i < pts.length; i++) { taperPath(ctx, pts[i - 1], pts[i], hw[i - 1], hw[i]); ctx.fill('nonzero'); }
    ctx.fillStyle = col;
    for (let i = 1; i < pts.length; i++) {
      taperPath(ctx, { x: pts[i - 1].x - hw[i - 1] * 0.22, y: pts[i - 1].y }, { x: pts[i].x - hw[i] * 0.22, y: pts[i].y }, hw[i - 1] * 0.74, hw[i] * 0.74);
      ctx.fill('nonzero');
    }
  }
  // A tapered limb from a to b (half widths h0 and h1) with round ends
  function taperPath(ctx, a, b, h0, h1) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    const q = [[a.x + nx * h0, a.y + ny * h0], [b.x + nx * h1, b.y + ny * h1], [b.x - nx * h1, b.y - ny * h1], [a.x - nx * h0, a.y - ny * h0]];
    ctx.beginPath();
    q.forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
    ctx.closePath();
    // The round ends must wind the same way as the body, or a nonzero fill cancels where they overlap
    let area = 0;
    for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    const ccw = area < 0;
    ctx.moveTo(a.x + h0, a.y);
    ctx.arc(a.x, a.y, h0, 0, Math.PI * 2 * (ccw ? -1 : 1), ccw);
    ctx.moveTo(b.x + h1, b.y);
    ctx.arc(b.x, b.y, h1, 0, Math.PI * 2 * (ccw ? -1 : 1), ccw);
  }
  // The same, lit from the left: the whole limb in shade, then a narrower lit copy nudged towards the light,
  // leaving a darker edge on the right (the sun is behind the left-hand stand)
  function shadedLimb(ctx, a, b, h0, h1, col) {
    ctx.fillStyle = shadeHex(col, -0.2);
    taperPath(ctx, a, b, h0, h1);
    ctx.fill('nonzero');
    ctx.fillStyle = col;
    taperPath(ctx, { x: a.x - h0 * 0.22, y: a.y }, { x: b.x - h1 * 0.22, y: b.y }, h0 * 0.74, h1 * 0.74);
    ctx.fill('nonzero');
  }
  // The shape of a shirt: square shoulders with rounded corners, narrowing a little to the waist
  function torsoPath(ctx, x, y, w, h, r) {
    const inset = w * 0.06;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w - inset, y + h);
    ctx.lineTo(x + inset, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  // A white sock showing above the shoe, along the line of the lower leg
  function paintSock(ctx, knee, foot, len, width, stripe) {
    const dx = foot.x - knee.x;
    const dy = foot.y - knee.y;
    const L = Math.hypot(dx, dy) || 1;
    ctx.strokeStyle = '#f7f7f2';
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(foot.x - (dx / L) * len, foot.y - (dy / L) * len);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
    if (stripe && width > 3) {
      // A band of colour near the top of the sock
      ctx.strokeStyle = stripe;
      ctx.beginPath();
      ctx.moveTo(foot.x - (dx / L) * len * 0.86, foot.y - (dy / L) * len * 0.86);
      ctx.lineTo(foot.x - (dx / L) * len * 0.72, foot.y - (dy / L) * len * 0.72);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
  }

  // Outlines: the figure is drawn into a scratch canvas, a dark copy of it is stamped around it in eight directions,
  // then the figure goes on top. Only the area in box (current drawing units) is processed, so it stays cheap.
  // About 2.4 CSS pixels thick on every canvas. Shadows are skipped inside the pass and drawn by the caller.
  // Scratch images for outlines, one pair per size (rounded up to 32 px). On a phone the whole scratch image is
  // uploaded to the graphics chip each time it is drawn, so a small figure must never use a big figure's image.
  const OUTLINE_BUFS = new Map();
  function outlineBufs(w, h) {
    const bw = Math.ceil(w / 32) * 32;
    const bh = Math.ceil(h / 32) * 32;
    const key = bw + 'x' + bh;
    let p = OUTLINE_BUFS.get(key);
    if (p) { OUTLINE_BUFS.delete(key); OUTLINE_BUFS.set(key, p); return p; }   // most recently used last
    p = { a: document.createElement('canvas'), b: document.createElement('canvas') };
    p.a.width = p.b.width = bw;
    p.a.height = p.b.height = bh;
    OUTLINE_BUFS.set(key, p);
    if (OUTLINE_BUFS.size > 24) OUTLINE_BUFS.delete(OUTLINE_BUFS.keys().next().value);
    return p;
  }
  let OUTLINE_PASS = false;
  let OUTLINE_OFF = false;   // speed test switch
  // Drawing that belongs on top of a figure (speech bubbles) is queued during an outline pass and drawn
  // after it, at the same place, so the outline buffer's box never crops it
  let OUTLINE_LATE = null;
  function drawLate(c, fn) {
    if (OUTLINE_LATE) OUTLINE_LATE.push({ fn: fn, t: c.getTransform() });
    else fn(c);
  }
  // Moves a box (in the current drawing space) left or right so it sits inside the visible screen
  function onScreenShift(c, x, w) {
    if (!c.getTransform) return 0;
    const T = c.getTransform();
    if (!T.a) return 0;
    const left = T.a * x + T.e;
    const right = T.a * (x + w) + T.e;
    const margin = 8 * scale;
    if (right > c.canvas.width - margin) return (c.canvas.width - margin - right) / T.a;
    if (left < margin) return (margin - left) / T.a;
    return 0;
  }
  function outlinePx(ctx) {
    const cv = ctx.canvas;
    const ratio = cv.clientWidth ? cv.width / cv.clientWidth : canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
    return Math.max(1.5, 2.4 * ratio);
  }
  // shadowY: the ground line (the feet) in drawing units. When given, the figure's silhouette is sheared onto the
  // ground as a cast shadow, falling right and away from you (the sun is low on the left, behind the camera).
  function withOutline(ctx, box, draw, shadowY) {
    // Drawing without an outline still counts as the pass, so a figure never wraps itself again
    const direct = () => { const was = OUTLINE_PASS; OUTLINE_PASS = true; try { return draw(ctx); } finally { OUTLINE_PASS = was; } };
    if (OUTLINE_PASS || OUTLINE_OFF || !ctx.getTransform) return direct();
    const T = ctx.getTransform();
    const lw = outlinePx(ctx);
    const pts = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].map((p) => ({ x: T.a * p[0] + T.c * p[1] + T.e, y: T.b * p[0] + T.d * p[1] + T.f }));
    const pad = Math.ceil(lw) + 2;
    const x0 = Math.max(0, Math.floor(Math.min.apply(null, pts.map((p) => p.x))) - pad);
    const y0 = Math.max(0, Math.floor(Math.min.apply(null, pts.map((p) => p.y))) - pad);
    const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max.apply(null, pts.map((p) => p.x))) + pad);
    const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max.apply(null, pts.map((p) => p.y))) + pad);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 2 || h <= 2) return direct();
    const bufs = outlineBufs(w, h);
    const OUTLINE_A = bufs.a;
    const OUTLINE_B = bufs.b;
    const a = OUTLINE_A.getContext('2d');
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalAlpha = 1;
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, w, h);
    a.setTransform(T.a, T.b, T.c, T.d, T.e - x0, T.f - y0);
    OUTLINE_PASS = true;
    const outerLate = OUTLINE_LATE;
    OUTLINE_LATE = [];
    let ret;
    let late;
    try { ret = draw(a); } finally { OUTLINE_PASS = false; late = OUTLINE_LATE; OUTLINE_LATE = outerLate; }
    const b = OUTLINE_B.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, w, h);
    b.drawImage(OUTLINE_A, 0, 0, w, h, 0, 0, w, h);
    b.globalCompositeOperation = 'source-in';
    b.fillStyle = '#0b0b0b';
    b.fillRect(0, 0, w, h);
    b.globalCompositeOperation = 'source-over';
    ctx.save();
    if (shadowY !== undefined && shadowY !== null) {
      const fy = T.b * 0 + T.d * shadowY + T.f;
      const kx = 0.6;
      const ky = -0.24;
      ctx.setTransform(1, 0, -kx, -ky, kx * fy, fy * (1 + ky));
      ctx.globalAlpha = 0.26;
      ctx.drawImage(OUTLINE_B, 0, 0, w, h, x0, y0, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = lw * 0.85;
    for (let i = 0; i < 4; i++) {
      ctx.drawImage(OUTLINE_B, 0, 0, w, h, x0 + (i & 1 ? d : -d), y0 + (i & 2 ? d : -d), w, h);
    }
    ctx.drawImage(OUTLINE_A, 0, 0, w, h, x0, y0, w, h);
    late.forEach((L) => {
      ctx.setTransform(L.t.a, L.t.b, L.t.c, L.t.d, L.t.e + x0, L.t.f + y0);
      drawLate(ctx, L.fn);
    });
    ctx.restore();
    return ret;
  }

  // Feet on the surface when a player stops or turns: a slide and a cloud of dust on clay, scuffed grass,
  // a rubber mark on a hard court
  function footFx(b, prevVx) {
    const surf = M.cfg.surface;
    const dirX = Math.sign(prevVx || b.vx || 1);
    const foot = proj(b.x, b.y, 0);
    const n = surf === 'clay' ? 7 : surf === 'grass' ? 4 : 0;
    const col = surf === 'clay' ? '#d9895a' : '#7fb35a';
    for (let i = 0; i < n; i++) {
      M.parts.push({ kind: 'dust', x: foot.x + (Math.random() - 0.5) * 10, y: foot.y, vx: -dirX * (20 + Math.random() * 60), vy: -20 - Math.random() * 40, g: 60, t: 0, life: 0.6 + Math.random() * 0.3, r: (surf === 'clay' ? 4 : 2.5) + Math.random() * 4, color: col });
    }
    const len = surf === 'clay' ? 0.9 : surf === 'grass' ? 0.35 : 0.25;
    M.skids.push({ x: b.x, y: b.y, dx: dirX * len, t: 0, life: surf === 'clay' ? 12 : 5, color: surf === 'clay' ? 'rgba(235,165,115,0.6)' : surf === 'grass' ? 'rgba(120,100,50,0.45)' : 'rgba(20,20,25,0.35)' });
    if (M.skids.length > 24) M.skids.shift();
  }

  // Stroke technique for a right-hander, seen from behind (screen right is their right). x and y are the racket
  // hand relative to the top of the shoulders, in body units; a is where the racket points (0 = right, -PI/2 = up).
  // off is the left hand: 'throat' (resting on the racket throat), 'grip' (two hands on the handle), or a spot;
  // tuck means the left arm is folded in front of the chest, so from behind only the back shows.
  // Seen from the front, the opponent is the same player mirrored.
  //   prep: the unit turn, held while the ball comes. slot: racket dropped below the ball, just before the swing.
  //   hit: contact out in front. fin: the finish.
  const STROKES = {
    // One-handed forehand: left hand points at the ball, racket loops down below it, contact by the front hip,
    // the left arm tucks in, and the racket wraps over the left shoulder with the left hand catching the throat
    fh: {
      // the racket points back at the back fence, so from behind it is short and only a little above level
      prep: { x: 0.46, y: 0.28, a: -0.5, len: 0.7, off: 'throat' },
      slot: { x: 0.5, y: 0.44, a: 0.95, len: 0.8, off: { x: 0.38, y: 0.04 } },
      hit: { x: 0.47, y: 0.3, a: 0.05, off: { x: -0.08, y: 0.3, tuck: true } },
      fin: { x: -0.22, y: -0.08, a: -2.6, off: 'throat' }
    },
    // Two-handed backhand: right hand at the bottom of the grip, left hand above it, both arms together.
    // Low by the left hip, contact out in front, finish high over the right shoulder
    bh2: {
      prep: { x: -0.4, y: 0.28, a: -2.64, len: 0.7, off: 'grip' },
      slot: { x: -0.44, y: 0.44, a: 2.25, len: 0.8, off: 'grip' },
      hit: { x: -0.44, y: 0.3, a: 3.09, off: 'grip' },
      fin: { x: 0.22, y: -0.1, a: -0.5, off: 'grip' }
    },
    // One-handed slice backhand: racket taken back high with the left hand on the throat, cut down through the
    // ball, then the arms split. Side-on, the left shoulder faces the camera, so the left arm swings back
    // towards us (screen right, in front of the body: over) while the racket goes out to the left and forward.
    bh1: {
      prep: { x: -0.32, y: 0.1, a: -2.6, len: 0.7, off: 'throat' },
      slot: { x: -0.4, y: 0.04, a: -2.75, len: 0.75, off: 'throat' },
      hit: { x: -0.44, y: 0.32, a: -2.9, off: { x: 0.36, y: 0.36, over: true } },
      // the finish points forward at the target, so from behind the racket is foreshortened (len)
      fin: { x: -0.22, y: 0.18, a: -1.85, len: 0.65, off: { x: 0.5, y: 0.3, over: true } }
    },
    // Volleys: a short punch. Racket up in front with the left hand on the throat, a firm push through the ball,
    // a short follow-through, no swing. Forehand volley:
    volf: {
      prep: { x: 0.36, y: 0.12, a: -0.95, len: 0.8, off: 'throat' },
      slot: { x: 0.42, y: 0.1, a: -1.0, len: 0.8, off: { x: 0.3, y: 0.06 } },
      hit: { x: 0.52, y: 0.16, a: -0.4, len: 0.9, off: { x: -0.15, y: 0.22, tuck: true } },
      fin: { x: 0.48, y: 0.28, a: 0.02, len: 0.9, off: { x: -0.15, y: 0.26, tuck: true } }
    },
    // Backhand volley, one hand, the left arm going back for balance
    volb: {
      prep: { x: -0.34, y: 0.12, a: -2.2, len: 0.8, off: 'throat' },
      slot: { x: -0.38, y: 0.08, a: -2.15, len: 0.8, off: 'throat' },
      hit: { x: -0.5, y: 0.16, a: -2.75, len: 0.9, off: { x: 0.26, y: 0.3, over: true } },
      fin: { x: -0.46, y: 0.28, a: 3.1, len: 0.9, off: { x: 0.32, y: 0.3, over: true } }
    },
    // Overhead smash: racket dropped behind the head, the left arm pointing up at the ball, then down hard
    oh: {
      prep: { x: 0.18, y: -0.5, a: -2.0, off: { x: -0.12, y: -0.78 } },
      slot: { x: 0.16, y: -0.56, a: -2.1, off: { x: -0.1, y: -0.8 } },
      hit: { x: 0.16, y: -0.74, a: -1.5, off: { x: -0.08, y: 0.22, tuck: true } },
      fin: { x: -0.3, y: 0.5, a: 2.2, off: { x: -0.1, y: 0.3, tuck: true } }
    },
    // Serve: from the trophy position, reach up to full stretch, then the racket comes down across the body
    // and finishes by the left hip, the tossing arm tucked in
    sv: {
      prep: { x: 0.12, y: -0.6, a: -1.75, off: { x: -0.05, y: 0.2, tuck: true } },
      slot: { x: 0.12, y: -0.62, a: -1.75, off: { x: -0.05, y: 0.2, tuck: true } },
      hit: { x: 0.14, y: -0.72, a: -1.45, off: { x: -0.08, y: 0.25, tuck: true } },
      fin: { x: -0.32, y: 0.52, a: 2.2, off: { x: -0.1, y: 0.3, tuck: true } }
    }
  };

  // A pose between two STROKES keys at t, in screen space: racket hand, racket angle, left hand, and whether
  // the left arm is tucked in front of the chest. Seen from the front (dom -1) the key is mirrored.
  function strokePose(A, B, t, f, shoulder, k, dom) {
    const m = (K) => ({ x: f.x + dom * K.x * k, y: shoulder + K.y * k, a: dom > 0 ? K.a : Math.PI - K.a });
    const PA = m(A);
    const PB = m(B);
    let a1 = PB.a;
    while (a1 - PA.a > Math.PI) a1 -= Math.PI * 2;
    while (PA.a - a1 > Math.PI) a1 += Math.PI * 2;
    const P = { x: lerp(PA.x, PB.x, t), y: lerp(PA.y, PB.y, t), a: lerp(PA.a, a1, t), len: lerp(A.len || 1, B.len || 1, t) };
    const offAt = (K, Q) => {
      if (typeof K.off === 'string') {
        const d = (K.off === 'grip' ? 0.12 : 0.24) * k;
        return { x: Q.x + Math.cos(Q.a) * d, y: Q.y + Math.sin(Q.a) * d, tuck: false, over: false };
      }
      return { x: f.x + dom * K.off.x * k, y: shoulder + K.off.y * k, tuck: !!K.off.tuck, over: !!K.off.over };
    };
    let o;
    if (typeof A.off === 'string' && A.off === B.off) o = offAt(A, P);
    else {
      const oa = offAt(A, PA);
      const ob = offAt(B, PB);
      o = { x: lerp(oa.x, ob.x, t), y: lerp(oa.y, ob.y, t), tuck: t < 0.75 ? oa.tuck : ob.tuck, over: t < 0.3 ? oa.over : ob.over };
    }
    return { x: P.x, y: P.y, a: P.a, len: P.len, ox: o.x, oy: o.y, tuck: o.tuck, over: o.over };
  }

  function drawFigure(ctx, b, front, colors, opts) {
    opts = opts || {};
    const f = proj(b.x, b.y, 0);
    const k = f.s * 0.88;
    if (!OUTLINE_PASS && !opts.noOutline) {
      // Shadows first, on the court, then the figure with its outline
      // The cast shadow comes from the figure's own silhouette, in withOutline below
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 0.34 * k, 0.08 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      const sunny = !(M && M.cfg && M.cfg.surface === 'indoor');
      const res = withOutline(ctx, { x0: f.x - 2.2 * k, y0: f.y - 3.4 * k, x1: f.x + 2.2 * k, y1: f.y + 0.3 * k }, (c) => drawFigure(c, b, front, colors, opts), sunny && !opts.noShadow ? f.y : null);
      if (res && res.trail && res.trail.length > 2 && !reduceMotion) {
        // The swing arc: a swoosh along the racket head's path, in the colour of the shot
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let j = 1; j < res.trail.length; j++) {
          const u = j / (res.trail.length - 1);
          ctx.globalAlpha = 0.15 + 0.55 * u;
          ctx.strokeStyle = res.trailColor;
          ctx.lineWidth = (0.04 + 0.16 * u) * k;
          ctx.beginPath();
          ctx.moveTo(res.trail[j - 1].x, res.trail[j - 1].y);
          ctx.lineTo(res.trail[j].x, res.trail[j].y);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.03 * k;
        ctx.beginPath();
        res.trail.slice(Math.floor(res.trail.length / 2)).forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        ctx.restore();
      }
      return res;
    }
    const moving = Math.abs(b.vx || 0) > 0.3;
    const run = Math.sin(b.run) * (moving ? 1 : 0);
    const tm = opts.time || 0;
    // Shadows: a cast shadow from a low sun behind the far stand (none indoors), plus a contact shadow.
    // In the outline pass they were drawn already, outside it.
    if (!OUTLINE_PASS && !(M && M.cfg && M.cfg.surface === 'indoor')) {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(f.x + 0.42 * k, f.y + 0.1 * k, 0.78 * k, 0.15 * k, 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!OUTLINE_PASS) {
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 0.34 * k, 0.08 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Movement and stance: a split step hop, a lean into a sprint, a side shuffle for short moves, a lunge at full stretch
    const speed = Math.abs(b.vx || 0);
    const sprinting = moving && speed > 3.5;
    const shuffling = moving && !sprinting;
    const splitK = b.split > 0 ? Math.sin((1 - b.split / 0.28) * Math.PI) : 0;
    const lungeK = b.lunge > 0 ? Math.min(1, b.lunge / 0.12) : 0;
    const prep = !!opts.prep && !(b.swing > 0) && !opts.toss;
    const shear = sprinting ? -Math.sign(b.vx) * 0.07 * Math.min(1, speed / 7) : lungeK ? -(b.side || 1) * 0.09 * lungeK : 0;
    const lift = splitK * 0.16 * k;
    ctx.save();
    ctx.translate(f.x, f.y - lift);
    ctx.transform(1, 0, shear, 1, 0, 0);
    ctx.translate(-f.x, -f.y);
    const runLeg = sprinting ? run : 0;
    let trail = null;

    const swinging = b.swing > 0 || opts.load;
    const stance = opts.toss ? 'serve' : swinging ? 'swing' : (opts.stance || 'ready');
    // A tennis ready position: feet wider than the shoulders, knees bent, hips low
    const athletic = stance === 'ready' || stance === 'swing';
    const LK = colors.look || {};
    const legH = 0.82 * k * (athletic ? 0.9 : 1) * (1 - 0.22 * lungeK) * (LK.h || 1);
    const bodyH = 0.66 * k * (LK.h || 1);
    const bw = 0.42 * k * (prep || stance === 'bounce' ? 0.86 : 1) * (LK.w || 1);   // shoulders turned side on in the unit turn and before a serve
    const hip = f.y - legH;
    const shoulder = hip - bodyH;
    const spread = lungeK ? (0.22 + 0.2 * lungeK) * k : shuffling ? (0.1 + 0.12 * Math.abs(Math.sin(b.run * 1.3))) * k : athletic && !moving ? (0.22 + 0.05 * splitK) * k : 0.12 * k;
    const dom = front ? -1 : 1;              // the racket shoulder: screen right from behind, screen left from the front
    const ballSide = b.side || dom;
    // Hips and shoulders turn separately, as in a real groundstroke: in the unit turn the shoulders coil further
    // than the hips; the swing starts from the hips, which unwind first and pull the shoulders and arm through;
    // at the finish the shoulders have turned past square. 1 is coiled away from the net, 0 square, -1 turned past.
    // A turned body shows narrower and shifts its middle towards the racket side.
    let coil = 0;
    let hipCoil = 0;
    if (stance === 'swing' || prep) {
      const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
      if (stance !== 'swing') { coil = ease(clamp(opts.prep, 0, 1) / 0.6); hipCoil = coil * 0.55; }
      else if (!(b.swing > 0)) { coil = 1; hipCoil = 0.55; }
      else {
        const sw = 1 - b.swing / 0.35;
        hipCoil = 0.55 - 1.15 * ease(sw / 0.55);          // the hips lead: open by contact
        coil = 1 - 1.85 * ease((sw - 0.12) / 0.8);        // the shoulders follow, then turn past
      }
      // Volleys, overheads and serves are mostly arm and shoulder: a smaller hip turn
      const armOnly = b.stroke === 'serve' || b.swingSpin === 'volley' || b.swingSpin === 'smash';
      if (armOnly) { coil *= 0.4; hipCoil *= 0.3; }
      // A backhand turns the other way
      if (ballSide !== dom) { coil = -coil; hipCoil = -hipCoil; }
    }
    const bwS = bw * (1 - 0.35 * Math.abs(coil));
    const bwH = bw * (1 - 0.25 * Math.abs(hipCoil));
    const cxS = f.x + dom * coil * 0.08 * k;
    const cxH = f.x + dom * hipCoil * 0.06 * k;
    const shY = shoulder + 0.08 * k;
    const shX = cxS + dom * bwS * 0.48;
    const offX = cxS - dom * bwS * 0.48;

    // ---- Pose: where the hands are and which way the racket points ----
    let hand;
    let rAng;
    let offHand = null;
    let offTuck = false;     // the left arm folded in front of the chest
    let offOver = false;     // the left arm reaching back towards the camera, in front of the body from behind
    let rLen = 1;            // foreshortening of the racket
    let behind = false;      // racket hidden behind the body (seen from behind, held in front of you)
    if (stance === 'serve') {
      // Trophy position: racket up behind the head, tossing arm reaching high
      hand = { x: f.x + dom * 0.3 * k, y: shoulder - 0.08 * k };
      rAng = -Math.PI / 2 - dom * (0.35 + opts.toss * 0.25);
      offHand = { x: f.x - dom * 0.08 * k, y: shoulder - (0.3 + opts.toss * 0.35) * k };
    } else if (stance === 'swing' || prep) {
      // A real stroke, from the STROKES table: which one depends on the ball's side and the shot
      // The serve pose only while the serve itself is swinging: the next ball is a groundstroke
      const kind = b.stroke === 'serve' && b.swing > 0 ? 'sv'
        : b.swing > 0 && b.swingSpin === 'smash' ? 'oh'
        : b.swing > 0 && b.swingSpin === 'volley' ? (ballSide === dom ? 'volf' : 'volb') : ballSide === dom ? 'fh' : b.swing > 0 && (b.swingSpin === 'slice' || b.swingSpin === 'drop') ? 'bh1' : 'bh2';
      const S = STROKES[kind];
      const sw = b.swing > 0 ? 1 - b.swing / 0.35 : 0;
      const e = sw < 0.45 ? sw / 0.45 : 1 + (sw - 0.45) / 0.55;
      const poseAt = (ev) => {
        let A;
        let B;
        let tt;
        if (stance !== 'swing') {
          // The unit turn: racket up and back first, then dropped into the slot as the ball arrives
          const pp = clamp((clamp(opts.prep, 0, 1) - 0.5) / 0.5, 0, 1);
          A = S.prep; B = S.slot; tt = pp * pp * (3 - 2 * pp);
        } else if (!(b.swing > 0)) {
          A = S.slot; B = S.slot; tt = 0;        // charging: held in the slot
        } else {
          A = ev < 1 ? S.slot : S.hit; B = ev < 1 ? S.hit : S.fin; tt = ev < 1 ? ev : ev - 1;
        }
        return strokePose(A, B, tt, f, shoulder, k, dom);
      };
      const P = poseAt(Math.min(e, 1.999));
      hand = { x: P.x, y: P.y };
      rAng = P.a;
      offHand = { x: P.ox, y: P.oy };
      offTuck = P.tuck;
      offOver = P.over;
      rLen = P.len;
      if (b.swing > 0 && e > 0.15) {
        // The racket head's path over the last part of the stroke, for the swing arc
        trail = [];
        const e0 = Math.max(0, e - 0.75);
        for (let j = 0; j <= 10; j++) {
          const Q = poseAt(Math.min(1.999, e0 + (e - e0) * j / 10));
          trail.push({ x: Q.x + Math.cos(Q.a) * 0.44 * k * Q.len, y: Q.y + Math.sin(Q.a) * 0.44 * k * Q.len });
        }
      }
    } else if (stance === 'overhead') {
      // Fed up: racket held flat above the head with both hands, shaking
      const bob = reduceMotion ? 0 : Math.sin(tm * 9) * 0.03 * k;
      hand = { x: f.x + dom * 0.3 * k, y: shoulder - 0.5 * k + bob };
      rAng = (dom > 0 ? Math.PI : 0) + Math.sin(tm * 3) * 0.08;
      offHand = { x: f.x - dom * 0.3 * k, y: shoulder - 0.5 * k - bob };
    } else if (stance === 'shake') {
      // A hand held out to meet theirs over the net, the other at the side
      hand = opts.shakeAt || { x: f.x + dom * 0.3 * k, y: shoulder + 0.3 * k };
      rAng = Math.PI / 2;
      offHand = { x: f.x - dom * 0.27 * k, y: hip - 0.04 * k };
    } else if (stance === 'trophy') {
      // Both hands up over the head, holding something aloft
      hand = { x: f.x + dom * 0.17 * k, y: shoulder - 0.6 * k };
      rAng = -Math.PI / 2;
      offHand = { x: f.x - dom * 0.17 * k, y: shoulder - 0.6 * k };
    } else if (stance === 'clap') {
      // Polite applause for the winner, through gritted teeth
      const cl = reduceMotion ? 0.04 : 0.03 + 0.04 * Math.abs(Math.sin(tm * 12));
      hand = { x: f.x + dom * cl * k, y: shoulder + 0.24 * k };
      rAng = Math.PI / 2;
      offHand = { x: f.x - dom * cl * k, y: shoulder + 0.24 * k };
    } else if (stance === 'sulk') {
      // Sulking: racket dangling from one hand, swung at nothing, other hand on the hip
      hand = { x: f.x + dom * 0.34 * k, y: hip + 0.02 * k };
      rAng = Math.PI / 2 + (reduceMotion ? 0.1 : Math.sin(tm * 4) * 0.4);
      offHand = { x: f.x - dom * 0.27 * k, y: hip - 0.06 * k };
    } else if (stance === 'bounce') {
      // Before a serve: upright and side-on, racket hanging relaxed in the right hand by the leg,
      // bouncing the ball with the left hand
      hand = { x: f.x + dom * 0.3 * k, y: hip - 0.02 * k };
      rAng = dom > 0 ? 1.2 : Math.PI - 1.2;
      rLen = 0.85;
      offHand = opts.ballHand || { x: f.x - dom * 0.3 * k, y: hip };
    } else if (sprinting) {
      // Sprinting: racket carried at the side, the other arm pumping
      const ph = Math.sin(b.run);
      hand = { x: f.x + dom * 0.34 * k, y: hip - 0.08 * k + ph * 0.08 * k };
      rAng = -Math.PI / 2 + dom * 0.7;
      offHand = { x: f.x - dom * 0.3 * k, y: hip - 0.12 * k - ph * 0.12 * k };
    } else {
      // Ready: both hands on the racket in front of the waist, head up and pointing at the net
      if (front) {
        hand = { x: f.x + dom * 0.03 * k, y: hip + 0.02 * k };
        rAng = -Math.PI / 2 + dom * 0.18;
        rLen = 0.78;
      } else {
        hand = { x: f.x + dom * 0.06 * k, y: hip - 0.16 * k };
        // Pointing at the net, so from behind the racket is end on: short, and mostly hidden by your back
        rAng = -Math.PI / 2 + dom * 0.5;
        rLen = 0.5;
        behind = true;
      }
    }
    const dir = { x: Math.cos(rAng), y: Math.sin(rAng) };
    const nrm = { x: -dir.y, y: dir.x };
    const at = (d) => ({ x: hand.x + dir.x * d * k * rLen, y: hand.y + dir.y * d * k * rLen });
    if (!offHand) offHand = at(0.22);   // ready: the other hand on the throat

    const drawLegs = () => {
      ctx.strokeStyle = colors.skin;
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.12 * k;
      ctx.lineJoin = 'round';
      const lh = { x: cxH - 0.1 * k * bwH / bw, y: hip };
      const rh = { x: cxH + 0.1 * k * bwH / bw, y: hip };
      // In a lunge the lead leg (on the ball's side) steps out further and bends; the trail leg stays long
      const leadR = (b.side || 1) > 0;
      const reach = 0.12 * k * lungeK;
      const lf = { x: f.x - spread + runLeg * 0.16 * k - (leadR ? 0 : reach), y: f.y - 0.05 * k };
      const rf = { x: f.x + spread - runLeg * 0.16 * k + (leadR ? reach : 0), y: f.y - 0.05 * k };
      // Knees: from behind or in front a knee bends towards or away from you, so it barely shows.
      // Only the lunge's lead leg, driving sideways, gets a visible bend.
      const lBend = 1.01 + (leadR ? 0 : 0.16 * lungeK);
      const rBend = 1.01 + (leadR ? 0.16 * lungeK : 0);
      const lk = jointFor(lh, lf, Math.hypot(lf.x - lh.x, lf.y - lh.y) * lBend, 1);
      const rk = jointFor(rh, rf, Math.hypot(rf.x - rh.x, rf.y - rh.y) * rBend, -1);
      // Thigh, then a calf that swells below the knee and narrows to the ankle
      [[lh, lk, lf], [rh, rk, rf]].forEach((L) => {
        const calf = { x: lerp(L[1].x, L[2].x, 0.35), y: lerp(L[1].y, L[2].y, 0.35) };
        shadedChain(ctx, [L[0], L[1], calf, L[2]], [0.075 * k, 0.052 * k, 0.058 * k, 0.034 * k], colors.skin);
      });
      paintSock(ctx, lk, lf, 0.13 * k, 0.085 * k, colors.band);
      paintSock(ctx, rk, rf, 0.13 * k, 0.085 * k, colors.band);
      if (k > 50) {
        // Knee creases, when the figure is close enough to see them
        ctx.strokeStyle = shadeHex(colors.skin, -0.26);
        ctx.lineWidth = Math.max(1, 0.009 * k);
        ctx.lineCap = 'round';
        [lk, rk].forEach((kn) => {
          ctx.beginPath();
          ctx.arc(kn.x, kn.y + 0.01 * k, 0.028 * k, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        });
      }
      if (toll > 0.2 && M && M.cfg && M.cfg.surface === 'clay') {
        // Clay dust creeps up the socks
        ctx.fillStyle = 'rgba(196,100,59,' + (0.6 * clamp((toll - 0.2) / 0.8, 0, 1)).toFixed(2) + ')';
        [lf, rf].forEach((ft) => ctx.fillRect(ft.x - 0.045 * k, ft.y - 0.08 * k, 0.09 * k, 0.08 * k));
      }
      paintShoeSmall(ctx, lf.x, f.y, k, colors, front);
      paintShoeSmall(ctx, rf.x, f.y, k, colors, front);
    };
    const toll = clamp(opts.toll || 0, 0, 1);
    const drawTorso = () => {
      paintShorts(ctx, cxH - bwH / 2, hip - 0.06 * k, bwH, 0.26 * k, 0.03 * k, colors);
      // The shirt and what is on it, turned with the shoulders (squeezed sideways about the middle)
      ctx.save();
      ctx.translate(cxS, 0);
      ctx.scale(bwS / bw, 1);
      ctx.translate(-f.x, 0);
      paintShirt(ctx, f.x - bw / 2, shoulder, bw, bodyH, 0.08 * k, colors, front, colors.text && !front && k > 40 ? 0.1 * k : 0);
      if (toll > 0.15) {
        // Sweat: a patch down the middle of the back (or the chest) and under the arms, darkening the shirt
        ctx.save();
        torsoPath(ctx, f.x - bw / 2, shoulder, bw, bodyH, 0.08 * k);
        ctx.clip();
        ctx.globalAlpha = clamp((toll - 0.15) / 0.85, 0, 1) * 0.55;
        ctx.fillStyle = shadeHex(colors.shirt, -0.3);
        ctx.beginPath();
        ctx.ellipse(f.x, shoulder + bodyH * (front ? 0.22 : 0.3), bw * 0.2, bodyH * (front ? 0.18 : 0.32), 0, 0, Math.PI * 2);
        ctx.moveTo(f.x - bw * 0.5 + bw * 0.12, shoulder + bodyH * 0.2);
        ctx.ellipse(f.x - bw * 0.5, shoulder + bodyH * 0.2, bw * 0.12, bodyH * 0.14, 0, 0, Math.PI * 2);
        ctx.moveTo(f.x + bw * 0.5 + bw * 0.12, shoulder + bodyH * 0.2);
        ctx.ellipse(f.x + bw * 0.5, shoulder + bodyH * 0.2, bw * 0.12, bodyH * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (opts.bag) {
        // Arriving with the racket bag slung across the back
        ctx.save();
        ctx.translate(f.x, shoulder + bodyH * 0.42);
        ctx.rotate(front ? 0.45 : -0.45);
        ctx.fillStyle = colors.bag || shadeHex(colors.shorts || '#1f3a8a', -0.2);
        roundRect(ctx, -bw * 0.85, -bw * 0.2, bw * 1.7, bw * 0.4, bw * 0.18);
        ctx.fill();
        ctx.fillStyle = colors.band || '#ffffff';
        ctx.fillRect(-bw * 0.85, -bw * 0.03, bw * 1.7, bw * 0.06);
        ctx.restore();
      }
      ctx.restore();
    };
    const drawRacket = () => {
      if (opts.noRacket) return;
      ctx.lineCap = 'round';
      // Grip: the hand sits at the butt, with a little of the handle showing below it
      const butt = at(-0.035);
      const gripTop = at(0.17);
      // Overgrip: pale tape with a dark wrap line, and a dark butt cap
      ctx.strokeStyle = '#f1ede0';
      ctx.lineWidth = 0.06 * k;
      ctx.beginPath();
      ctx.moveTo(butt.x, butt.y);
      ctx.lineTo(gripTop.x, gripTop.y);
      ctx.stroke();
      if (k > 30) {
        ctx.strokeStyle = 'rgba(30,30,30,0.55)';
        ctx.lineWidth = Math.max(0.6, 0.008 * k);
        for (let j = 0; j < 4; j++) {
          const pA = at(0.0 + j * 0.045);
          ctx.beginPath();
          ctx.moveTo(pA.x + nrm.x * 0.03 * k, pA.y + nrm.y * 0.03 * k);
          ctx.lineTo(pA.x - nrm.x * 0.03 * k + dir.x * 0.025 * k, pA.y - nrm.y * 0.03 * k + dir.y * 0.025 * k);
          ctx.stroke();
        }
      }
      ctx.fillStyle = '#1c1c1c';
      ctx.beginPath();
      ctx.arc(butt.x, butt.y, 0.035 * k, 0, Math.PI * 2);
      ctx.fill();
      const head = at(0.44);
      const throatEnd = at(0.29);
      ctx.strokeStyle = colors.racket;
      ctx.lineWidth = 0.032 * k;
      ctx.beginPath();
      ctx.moveTo(gripTop.x, gripTop.y);
      ctx.lineTo(throatEnd.x + nrm.x * 0.075 * k, throatEnd.y + nrm.y * 0.075 * k);
      ctx.moveTo(gripTop.x, gripTop.y);
      ctx.lineTo(throatEnd.x - nrm.x * 0.075 * k, throatEnd.y - nrm.y * 0.075 * k);
      // The throat bridge
      const br = at(0.265);
      ctx.moveTo(br.x + nrm.x * 0.062 * k, br.y + nrm.y * 0.062 * k);
      ctx.lineTo(br.x - nrm.x * 0.062 * k, br.y - nrm.y * 0.062 * k);
      ctx.stroke();
      ctx.save();
      ctx.translate(head.x, head.y);
      ctx.rotate(rAng);
      ctx.scale(rLen, 1);
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.165 * k, 0.12 * k, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240,240,220,0.28)';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = Math.max(0.5, 0.006 * k);
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 0.045 * k, -0.13 * k);
        ctx.lineTo(i * 0.045 * k, 0.13 * k);
        ctx.moveTo(-0.17 * k, i * 0.035 * k);
        ctx.lineTo(0.17 * k, i * 0.035 * k);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = colors.racket;
      ctx.lineWidth = 0.04 * k;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.165 * k, 0.12 * k, 0, 0, Math.PI * 2);
      ctx.stroke();
      // A glossy highlight down one side, and a dark bumper guard over the tip
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 0.012 * k;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.165 * k, 0.12 * k, 0, Math.PI * 0.62, Math.PI * 1.1);
      ctx.stroke();
      ctx.strokeStyle = '#1c1c1c';
      ctx.lineWidth = 0.05 * k;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.17 * k, 0.125 * k, 0, -0.55, 0.55);
      ctx.stroke();
      ctx.restore();
      // A charged shot makes the frame glow
      if (opts.load && opts.charge > 0.2) {
        ctx.fillStyle = 'rgba(255,170,60,' + (0.15 + 0.35 * opts.charge).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(head.x, head.y, 0.24 * k, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    // Arms with an elbow that hangs below the line from shoulder to hand
    const drawArms = (which) => {
      const limb = (sx, sy, hx, hy) => {
        const dx = hx - sx;
        const dy = hy - sy;
        const L = Math.hypot(dx, dy) || 1;
        const half = 0.31 * k;
        const sag = Math.sqrt(Math.max(0, half * half - (L / 2) * (L / 2)));
        let ex = (sx + hx) / 2 + (-dy / L) * sag;
        let ey = (sy + hy) / 2 + (dx / L) * sag;
        if (ey < (sy + hy) / 2) { ex = (sx + hx) / 2 + (dy / L) * sag; ey = (sy + hy) / 2 - (dx / L) * sag; }
        // In a stroke a lowered arm tucks its elbow in by the ribs. Flared out, it reads as a chicken wing
        // (a hand on the hip in a sulk keeps its elbow out).
        if ((stance === 'swing' || prep) && hy > sy) {
          const ax = (sx + hx) / 2 - (-dy / L) * sag;
          const bx = (sx + hx) / 2 + (-dy / L) * sag;
          const inner = Math.abs(ax - f.x) < Math.abs(bx - f.x) ? -1 : 1;
          ex = (sx + hx) / 2 + inner * (-dy / L) * sag;
          ey = (sy + hy) / 2 + inner * (dx / L) * sag;
        }
        const sh = { x: sx, y: sy };
        const el = { x: ex, y: ey };
        const wr = { x: hx, y: hy };
        shadedChain(ctx, [sh, el, wr], [0.05 * k, 0.038 * k, 0.029 * k], colors.skin);
        return { sh: sh, el: el, wr: wr };
      };
      // A short sleeve over the top of the upper arm
      const sleeve = (A) => {
        if (front ? false : (behind || (which === 'main' && hideMain) || (which === 'off' && hideOff) || (!which && (hideMain || hideOff)))) return;
        const end = { x: lerp(A.sh.x, A.el.x, 0.42), y: lerp(A.sh.y, A.el.y, 0.42) };
        ctx.fillStyle = colors.shirt;
        taperPath(ctx, { x: A.sh.x, y: A.sh.y - 0.01 * k }, end, 0.068 * k, 0.06 * k);
        ctx.fill('nonzero');
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        taperPath(ctx, { x: lerp(A.sh.x, end.x, 0.88), y: lerp(A.sh.y, end.y, 0.88) }, end, 0.06 * k, 0.06 * k);
        ctx.fill('nonzero');
      };
      if (which !== 'off') {
        const A = limb(shX, shY, hand.x, hand.y);
        sleeve(A);
        // Wristband on the racket arm
        ctx.fillStyle = colors.band || '#ffffff';
        taperPath(ctx, { x: lerp(A.el.x, A.wr.x, 0.74), y: lerp(A.el.y, A.wr.y, 0.74) }, { x: lerp(A.el.x, A.wr.x, 0.9), y: lerp(A.el.y, A.wr.y, 0.9) }, 0.036 * k, 0.034 * k);
        ctx.fill('nonzero');
        ctx.fillStyle = colors.skin;
        ctx.beginPath();
        ctx.arc(hand.x, hand.y, 0.05 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      if (which !== 'main') {
        const A = limb(offX, shY, offHand.x, offHand.y);
        sleeve(A);
        ctx.fillStyle = colors.skin;
        ctx.beginPath();
        ctx.arc(offHand.x, offHand.y, 0.044 * k, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    // Seen from behind, an arm reaching across the body is in front of the chest, so the back hides it and
    // only the hand shows past the shirt. Drawn over the shirt it reads as a hand tucked behind the back.
    const crosses = (hx, sx) => (hx - f.x) * Math.sign(sx - f.x) < -0.02 * k;
    const hideMain = !front && crosses(hand.x, shX);
    const hideOff = !front && !offOver && (offTuck || crosses(offHand.x, offX));

    drawLegs();
    if (behind) {
      // Seen from behind, a racket held out in front is mostly hidden by your own back
      drawRacket();
      drawArms();
      drawTorso();
    } else {
      if (hideMain && hideOff) drawArms();
      else if (hideMain) drawArms('main');
      else if (hideOff) drawArms('off');
      drawTorso();
      drawRacket();
      if (!hideMain && !hideOff) drawArms();
      else if (!hideMain) drawArms('main');
      else if (!hideOff) drawArms('off');
    }

    // Head: a neck, ears, hair, and the face. look (-1 to 1) turns the head towards the ball on screen.
    const hr = 0.14 * k;
    const headY = shoulder - hr * 1.12;
    const look = clamp(opts.look || 0, -1, 1);
    ctx.fillStyle = shadeHex(colors.skin, -0.12);
    ctx.fillRect(f.x - 0.05 * k, headY + hr * 0.5, 0.1 * k, shoulder - headY - hr * 0.4);
    if (front) frontHair(ctx, f.x + look * hr * 0.12, headY, hr, colors.hair, LK.hair || 'short', 'behind');
    ctx.fillStyle = colors.skin;
    ctx.beginPath();
    ctx.arc(f.x, headY, hr, 0, Math.PI * 2);
    ctx.fill();
    // Ears: the one on the side the head turns towards shows more
    [-1, 1].forEach((sd) => {
      const show = 1 + 0.5 * sd * look * (front ? -1 : 1);
      ctx.fillStyle = sd > 0 ? shadeHex(colors.skin, -0.12) : colors.skin;
      ctx.beginPath();
      ctx.ellipse(f.x + sd * hr * (0.92 + 0.08 * show), headY + hr * 0.12, hr * 0.17 * show, hr * 0.27, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = colors.hair;
    ctx.beginPath();
    if (front) frontHair(ctx, f.x + look * hr * 0.12, headY, hr, colors.hair, LK.hair || 'short', 'top');
    else if (LK.hair && LK.hair !== 'short') {
      // A chosen style from behind: a ponytail swings with the run and the swing
      backHair(ctx, f.x - look * hr * 0.28, headY, hr, colors.hair, LK.hair, Math.sin(b.run || 0) * (moving ? 0.6 : 0) + (b.swing > 0 ? 0.5 * dom : 0));
    } else {
      // From behind, the hair slides away from the turn, uncovering a cheek on the ball's side
      ctx.arc(f.x - look * hr * 0.28, headY - hr * 0.04, hr * 1.02, 0, Math.PI * 2);
    }
    ctx.fill();
    if (toll > 0.5) {
      // Hair coming loose: a few tufts sticking out over the band
      ctx.strokeStyle = colors.hair;
      ctx.lineWidth = Math.max(1, hr * 0.12);
      ctx.lineCap = 'round';
      const n = 2 + Math.round((toll - 0.5) * 6);
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (1.15 + i * 0.7 / Math.max(1, n - 1));
        ctx.beginPath();
        ctx.moveTo(f.x + Math.cos(a) * hr * 0.9, headY + Math.sin(a) * hr * 0.9);
        ctx.lineTo(f.x + Math.cos(a + 0.15) * hr * 1.28, headY + Math.sin(a + 0.15) * hr * 1.28);
        ctx.stroke();
      }
    }
    ctx.fillStyle = colors.band;
    ctx.fillRect(f.x - hr, headY - hr * 0.45, hr * 2, hr * 0.32);
    if (front) {
      // Faces show the temper: calm, focused, cross, furious, or pleased with themselves
      const mood = opts.mood || 'calm';
      const ex = look * hr * 0.16;
      const xtra = LK.extra || [];
      if (xtra.indexOf('beard') >= 0 || xtra.indexOf('stubble') >= 0) {
        ctx.save();
        ctx.globalAlpha = xtra.indexOf('beard') >= 0 ? 1 : 0.32;
        ctx.fillStyle = colors.hair;
        ctx.beginPath();
        ctx.arc(f.x, headY, hr * 1.02, 0.08 * Math.PI, 0.92 * Math.PI);
        ctx.arc(f.x + ex * 0.4, headY + hr * 0.12, hr * 0.72, 0.9 * Math.PI, 0.1 * Math.PI, true);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      if (xtra.indexOf('collar') >= 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(f.x - hr * 0.16, shoulder - hr * 0.05, hr * 0.32, hr * 0.16);
      }
      if (xtra.indexOf('pearls') >= 0) {
        ctx.fillStyle = '#fbf6ea';
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.arc(f.x + i * hr * 0.17, shoulder + hr * (0.06 + 0.04 * Math.abs(i)), Math.max(0.8, hr * 0.07), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (xtra.indexOf('earrings') >= 0) {
        ctx.fillStyle = '#e8c45a';
        [-1, 1].forEach((sd) => {
          ctx.beginPath();
          ctx.arc(f.x + sd * hr * 1.0, headY + hr * 0.42, Math.max(0.8, hr * 0.08), 0, Math.PI * 2);
          ctx.fill();
        });
      }
      const ink = '#1b1b1b';
      const lw = Math.max(1, hr * 0.13);
      ctx.fillStyle = '#ffffff';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.ellipse(f.x + sd * hr * 0.36 + ex * 0.5, headY + hr * 0.12, hr * 0.17, hr * (mood === 'furious' ? 0.12 : 0.16), 0, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = ink;
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.arc(f.x + sd * hr * 0.36 + ex, headY + hr * 0.13, hr * 0.09, 0, Math.PI * 2);
        ctx.fill();
      });
      if (hr > 9) {
        ctx.fillStyle = '#ffffff';
        [-1, 1].forEach((sd) => {
          ctx.beginPath();
          ctx.arc(f.x + sd * hr * 0.36 + ex + hr * 0.03, headY + hr * 0.1, hr * 0.03, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.fillStyle = mood === 'furious' ? 'rgba(220,40,30,0.3)' : 'rgba(230,100,90,0.2)';
        [-1, 1].forEach((sd) => {
          ctx.beginPath();
          ctx.ellipse(f.x + sd * hr * 0.52 + ex * 0.6, headY + hr * 0.42, hr * 0.15, hr * 0.09, 0, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.strokeStyle = shadeHex(colors.skin, -0.3);
        ctx.lineWidth = Math.max(1, hr * 0.08);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(f.x + ex * 0.9, headY + hr * 0.3, hr * 0.09, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
      }
      // Eyebrows: level when calm, low and angled in when cross, a deep V when furious, raised when pleased
      const tilt = { calm: 0, focus: 0.12, cross: 0.3, furious: 0.5, happy: -0.15 }[mood] || 0;
      const lift = { calm: 0, focus: 0.03, cross: 0.06, furious: 0.08, happy: -0.06 }[mood] || 0;
      ctx.strokeStyle = colors.hair === '#e8e0d0' ? '#7a6a50' : colors.hair;
      ctx.lineWidth = lw * 1.2;
      ctx.lineCap = 'round';
      [-1, 1].forEach((sd) => {
        const bx = f.x + sd * hr * 0.36 + ex * 0.5;
        const by = headY - hr * 0.12 + lift * hr;
        ctx.beginPath();
        ctx.moveTo(bx - hr * 0.2, by - sd * tilt * hr * 0.5 * -1);
        ctx.lineTo(bx + hr * 0.2, by + sd * tilt * hr * 0.5 * -1);
        ctx.stroke();
      });
      if (xtra.indexOf('glasses') >= 0) {
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = Math.max(1, hr * 0.08);
        [-1, 1].forEach((sd) => {
          ctx.beginPath();
          ctx.arc(f.x + sd * hr * 0.36 + ex * 0.5, headY + hr * 0.12, hr * 0.24, 0, Math.PI * 2);
          ctx.stroke();
        });
        ctx.beginPath();
        ctx.moveTo(f.x - hr * 0.12 + ex * 0.5, headY + hr * 0.1);
        ctx.lineTo(f.x + hr * 0.12 + ex * 0.5, headY + hr * 0.1);
        ctx.stroke();
      }
      if (xtra.indexOf('shades') >= 0) {
        ctx.fillStyle = '#111111';
        roundRect(ctx, f.x - hr * 0.62 + ex * 0.5, headY - hr * 0.04, hr * 1.24, hr * 0.32, hr * 0.1);
        ctx.fill();
      }
      if (xtra.indexOf('monocle') >= 0) {
        ctx.strokeStyle = '#d4af37';
        ctx.lineWidth = Math.max(1, hr * 0.07);
        ctx.beginPath();
        ctx.arc(f.x + hr * 0.36 + ex, headY + hr * 0.13, hr * 0.24, 0, Math.PI * 2);
        ctx.moveTo(f.x + hr * 0.6 + ex, headY + hr * 0.2);
        ctx.quadraticCurveTo(f.x + hr * 0.9, headY + hr * 0.9, f.x + hr * 0.5, shoulder + hr * 0.3);
        ctx.stroke();
      }
      // Mouth
      const mx = f.x + ex * 0.6;
      const my = headY + hr * 0.58;
      if (xtra.indexOf('moustache') >= 0) {
        ctx.fillStyle = colors.hair;
        [-1, 1].forEach((sd) => {
          ctx.beginPath();
          ctx.ellipse(mx + sd * hr * 0.15, my - hr * 0.16, hr * 0.19, hr * 0.08, sd * -0.35, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#5a2a20';
      if (b.mouth > 0 || mood === 'furious') {
        ctx.fillStyle = '#4a1414';
        ctx.beginPath();
        ctx.ellipse(mx, my, hr * 0.26, hr * (b.mouth > 0 ? 0.3 : 0.16), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(mx - hr * 0.2, my - hr * (b.mouth > 0 ? 0.24 : 0.12), hr * 0.4, hr * 0.07);
      } else {
        ctx.beginPath();
        if (mood === 'happy') ctx.arc(mx, my - hr * 0.12, hr * 0.24, 0.2 * Math.PI, 0.8 * Math.PI);
        else if (mood === 'cross') ctx.arc(mx, my + hr * 0.16, hr * 0.22, 1.2 * Math.PI, 1.8 * Math.PI);
        else {
          ctx.moveTo(mx - hr * 0.2, my);
          ctx.lineTo(mx + hr * 0.2, my);
        }
        ctx.stroke();
      }
    }
    if (opts.redden) {
      ctx.fillStyle = 'rgba(255,40,30,' + (opts.redden * 0.45).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(f.x, headY, hr * 1.05, 0, Math.PI * 2);
      ctx.fill();
    }
    // In the overhead stance the racket and hands sit above the head, so draw them last
    if (stance === 'overhead') { drawRacket(); drawArms(); }
    ctx.restore();
    // The arc is drawn after the outline pass, so map its points through the lean and the hop here
    if (trail) trail = trail.map((p) => ({ x: p.x + shear * (p.y - f.y), y: p.y - lift }));
    return { headX: f.x + shear * (headY - hr - f.y), headY: headY - hr - lift, k: k, trail: trail, trailColor: (SPIN[b.swingSpin || 'flat'] || SPIN.flat).color };
  }

  function drawBall(ctx, bp, s) {
    const sh = proj(bp.x, bp.y, 0);
    const p = proj(bp.x, bp.y, bp.z);
    const r = Math.max(2.6, 0.075 * p.s);
    // Never a ball bigger than a fist on screen: closer than that, it has gone past the camera
    if (r > 34) return;
    // The shadow tightens and darkens as the ball comes down, and spreads and fades when it is high
    const hk = clamp((bp.z || 0) / 3, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.42 - 0.24 * hk).toFixed(2) + ')';
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, r * (1 + 0.7 * hk), r * (0.38 + 0.2 * hk), 0, 0, Math.PI * 2);
    ctx.fill();
    const sp = s ? SPIN[s.spin || 'flat'] : null;
    if (sp && s.trail.length > 2) {
      // Trail colour tells you the spin: yellow flat, orange topspin, blue slice, green drop, white lob
      ctx.lineCap = 'round';
      for (let i = 1; i < s.trail.length; i++) {
        const a = proj(s.trail[i - 1].x, s.trail[i - 1].y, s.trail[i - 1].z);
        const b = proj(s.trail[i].x, s.trail[i].y, s.trail[i].z);
        ctx.globalAlpha = 0.08 + 0.42 * i / s.trail.length;
        ctx.strokeStyle = sp.color;
        ctx.lineWidth = r * (0.5 + i / s.trail.length);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Squash: flattened for a moment as it lands, and stretched along its path just off the racket
    let sx = 1;
    let sy = 1;
    let ang = 0;
    if (s && !reduceMotion) {
      const ub = Math.abs(s.t - s.T1);
      if (ub < 0.05 && !s.netted) { sx = 1.35 - ub * 4; sy = 0.68 + ub * 5; }
      else if (s.t < 0.06 && s.trail.length > 1) {
        const a = s.trail[s.trail.length - 2];
        const b = s.trail[s.trail.length - 1];
        const pa = proj(a.x, a.y, a.z);
        const pb = proj(b.x, b.y, b.z);
        ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
        sx = 1.3;
        sy = 0.8;
      }
    }
    // Felt: lit from the upper left, with a fuzzy edge when it is close to the camera
    const shade = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r * 1.1);
    shade.addColorStop(0, '#f1ff8a');
    shade.addColorStop(0.6, '#d9f24a');
    shade.addColorStop(1, '#a9c22a');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r * sx, r * sy, ang, 0, Math.PI * 2);
    ctx.fill();
    if (r > 6) {
      ctx.strokeStyle = 'rgba(232,250,140,0.55)';
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.setLineDash([1.2, 1.6]);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * sx * 1.04, r * sy * 1.04, ang, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const rot = s ? s.t * sp.rate : 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = Math.max(0.8, r * 0.18);
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(rot) * r * 0.5, p.y + Math.sin(rot) * r * 0.5, r * 0.8, rot + Math.PI - 0.9, rot + Math.PI + 0.9);
    ctx.stroke();
    return p;
  }

  // Each sponsor pays a share of your prize money on its own terms. Villains get Snarl Energy, who pay for chaos;
  // favourites get Barley Water, who pay for a clean match; everyone else gets Hendry Stringers' steady cheque.
  const SPONSOR_DEALS = {
    'Snarl Energy': { desc: 'Pays 10% of your prize money, plus 12% for every racket you smash and 5% for every code violation.' },
    'Barley Water Co.': { desc: 'Pays 15% of your prize money, plus 35% more for a clean match: no smashed rackets, no code violations.' },
    'Hendry Stringers': { desc: 'Pays a steady 20% of your prize money. No conditions.' }
  };
  // What the sponsor pays for a won match, and why
  function sponsorPay(prize, smashed, violations) {
    const name = sponsorKit().sponsor;
    if (name === 'Snarl Energy') {
      const s = Math.min(4, smashed);
      const v = Math.min(3, violations);
      return { name: name, amount: Math.round(prize * (0.1 + 0.12 * s + 0.05 * v)), why: s || v ? s + ' smashed, ' + v + ' violation' + (v === 1 ? '' : 's') : 'a quiet match, sadly' };
    }
    if (name === 'Barley Water Co.') {
      const clean = !smashed && !violations;
      return { name: name, amount: Math.round(prize * (clean ? 0.5 : 0.15)), why: clean ? 'clean match bonus' : 'no clean match bonus' };
    }
    return { name: name, amount: Math.round(prize * 0.2), why: 'steady as ever' };
  }
  function sponsorKit() {
    const r = SAVE.reputationScore;
    if (r <= -25) return { sponsor: 'Snarl Energy', shirt: '#161616', shirt2: '#ff3b30', design: 'bolt', shorts: '#c8102e', band: '#c8102e', trim: null, text: 'SNARL', textColor: '#ff3b30' };
    if (r >= 25) return { sponsor: 'Barley Water Co.', shirt: '#f4f1e6', shirt2: '#6b3fa0', design: 'polo', shorts: '#6b3fa0', band: '#6b3fa0', trim: '#b79ce0', text: 'BARLEY', textColor: '#6b3fa0' };
    return { sponsor: 'Hendry Stringers', shirt: '#f4f1e6', shirt2: '#1f3a6b', design: 'polo', shorts: '#1f3a6b', band: '#ff3b30', trim: null, text: 'HENDRY', textColor: '#1f3a6b' };
  }
  // The item being tried on in the Locker Room, shown without being bought
  let lockerTry = null;
  // Sponsor kit underneath, Locker Room choices on top. The sponsor name stays on your back: they pay you.
  function playerKit() {
    const kit = Object.assign({ shoes: '#f4f4f4', racket: '#d9f24a' }, sponsorKit());
    const eq = Object.assign({}, SAVE.locker.equip);
    const tried = lockerTry && LOCKER_INDEX[lockerTry];
    if (tried && tried.cat !== 'tantrum' && tried.cat !== 'celeb') eq[tried.cat] = lockerTry;
    const sh = LOCKER_INDEX[eq.shirt];
    if (sh && sh.color) {
      kit.shirt = sh.color;
      kit.trim = sh.trim || null;
      kit.textColor = sh.text;
      kit.design = sh.design || null;
      kit.shirt2 = sh.color2;
      kit.shirt3 = sh.color3;
      kit.shirt4 = sh.color4;
    }
    ['shorts', 'band', 'shoes', 'racket'].forEach((cat) => {
      const it = LOCKER_INDEX[eq[cat]];
      if (it && it.color) kit[cat] = it.color;
    });
    const so = LOCKER_INDEX[eq.shorts];
    if (so && so.design) { kit.shortsDesign = so.design; kit.shorts2 = so.color2; kit.shorts3 = so.color3; }
    const sho = LOCKER_INDEX[eq.shoes];
    if (sho) { kit.shoeSole = sho.sole; kit.shoeAccent = sho.accent; }
    const pl = SAVE.player || {};
    kit.skin = pl.skin || '#e7b892';
    kit.hair = pl.hair || '#3a2716';
    kit.look = { h: pl.body === 'f' ? 0.97 : 1, w: pl.body === 'f' ? 0.9 : 1, hair: pl.style || 'short', extra: [] };
    kit.skirt = pl.body === 'f';
    return kit;
  }
  // Locker swatch for an item: a small CSS picture of the design
  function swatchCss(it) {
    const a = it.color;
    const b = it.color2;
    const c = it.color3 || b;
    const d = it.color4 || c;
    if (!a) return null;
    if (it.cat === 'shoes') return 'linear-gradient(180deg, ' + a + ' 0 58%, ' + it.accent + ' 58% 70%, ' + it.sole + ' 70% 100%)';
    switch (it.design) {
      case 'polo': return 'linear-gradient(180deg, ' + b + ' 0 20%, ' + a + ' 20%)';
      case 'pinstripe': return 'repeating-linear-gradient(90deg, ' + a + ' 0 5px, ' + b + ' 5px 6px)';
      case 'stripes': return 'linear-gradient(90deg, ' + a + ' 0 30%, ' + b + ' 30% 43%, ' + a + ' 43% 57%, ' + b + ' 57% 70%, ' + a + ' 70%)';
      case 'hoops': return 'repeating-linear-gradient(180deg, ' + a + ' 0 7px, ' + b + ' 7px 14px)';
      case 'chevron': return 'linear-gradient(135deg, ' + a + ' 0 38%, ' + b + ' 38% 52%, ' + a + ' 52%)';
      case 'sash': return 'linear-gradient(45deg, ' + a + ' 0 40%, ' + b + ' 40% 60%, ' + a + ' 60%)';
      case 'dots': return 'radial-gradient(' + b + ' 28%, transparent 31%) 0 0 / 9px 9px, ' + a;
      case 'hawaiian': return 'radial-gradient(circle at 28% 30%, ' + b + ' 0 16%, transparent 18%), radial-gradient(circle at 72% 68%, ' + b + ' 0 14%, transparent 16%), radial-gradient(circle at 70% 25%, ' + c + ' 0 12%, transparent 14%), ' + a;
      case 'bolt': return 'linear-gradient(115deg, ' + a + ' 0 44%, ' + b + ' 44% 56%, ' + a + ' 56%)';
      case 'retro': return 'linear-gradient(180deg, ' + a + ' 0 30%, ' + b + ' 30% 42%, ' + c + ' 42% 54%, ' + d + ' 54% 66%, ' + a + ' 66%)';
      case 'camo': return 'radial-gradient(circle at 25% 30%, ' + b + ' 0 20%, transparent 22%), radial-gradient(circle at 70% 60%, ' + c + ' 0 22%, transparent 24%), radial-gradient(circle at 40% 80%, ' + b + ' 0 15%, transparent 17%), ' + a;
      case 'tiedye': return 'conic-gradient(from 30deg, ' + a + ', ' + b + ', ' + c + ', ' + d + ', ' + a + ')';
      case 'sequins': return 'radial-gradient(' + b + ' 18%, transparent 24%) 0 0 / 6px 6px, ' + a;
      case 'cord': return 'repeating-linear-gradient(90deg, ' + a + ' 0 3px, ' + b + ' 3px 4px)';
      case 'stripe': return 'linear-gradient(90deg, ' + b + ' 0 14%, ' + a + ' 14% 86%, ' + b + ' 86%)';
      case 'tartan': return 'repeating-linear-gradient(90deg, transparent 0 8px, ' + b + 'aa 8px 11px, transparent 11px 16px, ' + c + '88 16px 17px), repeating-linear-gradient(0deg, transparent 0 8px, ' + b + 'aa 8px 11px, transparent 11px 16px), ' + a;
      default: return a;
    }
  }
  function playerColors() {
    const kit = playerKit();
    return Object.assign({ skin: '#e7b892', hair: '#3a2716' }, kit, { racket: M.rage > 0.85 ? '#ff3b30' : kit.racket });
  }
  // Each opponent's build and signature look: h and w scale height and shoulders; hair is a style; extra is a list
  // of details (glasses, shades, moustache, beard, stubble, collar, pearls, earrings, monocle)
  const OPP_LOOKS = {
    'Gerald Pinch': { h: 0.95, w: 0.95, hair: 'balding', extra: ['glasses'] },
    'Nigel Brannock': { h: 1.06, w: 0.86, hair: 'short', extra: [] },
    'Big Sue Tolland': { h: 1.0, w: 1.25, hair: 'bun', extra: ['earrings'] },
    'Rupert Allsop': { h: 1.06, w: 1.0, hair: 'side', extra: [] },
    'Felicity Crane': { h: 1.02, w: 0.9, hair: 'ponytail', extra: ['earrings'] },
    'The Reverend Hodge': { h: 0.98, w: 1.05, hair: 'balding', extra: ['collar', 'glasses'] },
    'Kev Mallard': { h: 0.96, w: 1.18, hair: 'buzz', extra: ['stubble'] },
    'Tobias Wren': { h: 1.04, w: 0.95, hair: 'curly', extra: [] },
    'Anton Steele': { h: 1.08, w: 1.12, hair: 'buzz', extra: ['beard'] },
    'Lady Araminta Fforde': { h: 1.0, w: 0.9, hair: 'bob', extra: ['pearls'] },
    'Marcus Thwaite': { h: 1.02, w: 1.06, hair: 'short', extra: ['stubble'] },
    'Jonty Pemberton': { h: 1.04, w: 0.95, hair: 'floppy', extra: [] },
    'Henrik Lund': { h: 1.1, w: 0.95, hair: 'long', extra: [] },
    'Brad Colton': { h: 1.1, w: 1.2, hair: 'buzz', extra: ['shades'] },
    'The Baron': { h: 1.0, w: 1.08, hair: 'slick', extra: ['moustache', 'monocle'] },
    'Coach Derek': { h: 1.0, w: 1.1, hair: 'balding', extra: ['moustache'] }
  };
  // How each opponent plays. mix: rally shot weights; err: added to their error rate; pace: rally pace; deep: metres
  // deeper they hit; net: how keen they are to come in; lobNet: chance of lobbing you when you are at the net;
  // serve: first serve mph; fault: added to first serve faults; svNet: chance of following a first serve in;
  // wide and t: shares of first serves aimed wide and down the T (the rest at the body)
  // Opponent rally errors: base - skill x skill weight + (pace over 65 mph) / pace + stretch² x stretch. neutralAttack
  // x skill is how often they go for a winner off an ordinary ball (more off a short or weak one)
  const OPP_ERR = { base: 0.085, skill: 0.11, pace: 350, stretch: 0.1, neutralAttack: 0.26 };
  const STYLES = {
    allRounder: { label: 'All-rounder', mix: { topspin: 0.5, flat: 0.28, slice: 0.22 }, err: 0, pace: 1, deep: 0, net: 1, lobNet: 0.4, serve: 0, fault: 0, svNet: 0, wide: 0.4, t: 0.35 },
    bigServer: { label: 'Big server', mix: { flat: 0.55, topspin: 0.3, slice: 0.15 }, err: 0, pace: 1.08, deep: 0, net: 0.6, lobNet: 0.2, serve: 11, fault: 0.06, svNet: 0.1, wide: 0.5, t: 0.42 },
    grinder: { label: 'Grinder', mix: { topspin: 0.72, flat: 0.16, slice: 0.12 }, err: -0.05, pace: 0.93, deep: 0.9, net: 0.35, lobNet: 0.45, serve: -6, fault: -0.07, svNet: 0, wide: 0.35, t: 0.3 },
    serveVolley: { label: 'Serve and volley', mix: { flat: 0.4, slice: 0.4, topspin: 0.2 }, err: 0.01, pace: 1.02, deep: 0, net: 2.4, lobNet: 0.25, serve: 4, fault: 0.02, svNet: 0.75, wide: 0.45, t: 0.4 },
    slicer: { label: 'Slicer', mix: { slice: 0.55, topspin: 0.18, flat: 0.15, drop: 0.12 }, err: -0.01, pace: 0.9, deep: 0.3, net: 1.2, lobNet: 0.35, serve: -3, fault: -0.03, svNet: 0.15, wide: 0.45, t: 0.25 },
    lobber: { label: 'Lob merchant', mix: { topspin: 0.45, lob: 0.25, flat: 0.18, slice: 0.12 }, err: -0.02, pace: 0.9, deep: 0.5, net: 0.4, lobNet: 0.75, serve: -4, fault: -0.03, svNet: 0, wide: 0.4, t: 0.3 }
  };
  const OPP_STYLE = {
    'Gerald Pinch': 'slicer', 'Nigel Brannock': 'grinder', 'Big Sue Tolland': 'bigServer', 'Rupert Allsop': 'serveVolley', 'Felicity Crane': 'lobber',
    'The Reverend Hodge': 'slicer', 'Kev Mallard': 'bigServer', 'Tobias Wren': 'grinder', 'Anton Steele': 'bigServer', 'Lady Araminta Fforde': 'slicer',
    'Marcus Thwaite': 'grinder', 'Jonty Pemberton': 'serveVolley', 'Henrik Lund': 'grinder', 'Brad Colton': 'bigServer', 'The Baron': 'allRounder', 'Coach Derek': 'allRounder'
  };
  // Daily opponents get a style from their name, so the same name always plays the same way
  function styleKey(opp) {
    if (OPP_STYLE[opp.name]) return OPP_STYLE[opp.name];
    const keys = Object.keys(STYLES);
    return keys[fnv1a(opp.name) % keys.length];
  }
  function oppStyle() { return STYLES[styleKey(M.cfg.opp)]; }
  // Rivalries: a head to head record per opponent. A nemesis has beaten you at least twice and more often than not.
  // The walk-on broadcast, in seconds: their strap, then the tale of the tape, then the coin toss
  const INTRO_TV = { opp: [0.2, 3.0], tape: [3.0, 6.4], toss: 6.0, end: 7.6 };
  function rivalRec(name) { return (SAVE.rivals || {})[name] || null; }
  function isNemesis(name) { const r = rivalRec(name); return !!r && r.l >= 2 && r.l > r.w; }
  function rivalLine(name) {
    const r = rivalRec(name);
    if (!r) return '';
    return '  |  ' + (isNemesis(name) ? 'NEMESIS  ' : r.last === 'l' ? 'REMATCH  ' : '') + 'Head to head ' + r.w + '-' + r.l;
  }
  // A nemesis from an earlier tour comes back for the quarter final of a later one (half of them, by name),
  // and has been practising
  // From season 3, each season has its own roster, built from a seed: new names, traits, looks and a bio
  // from a job and a habit that fits the trait. About one slot in three is a returning face instead.
  const GEN_TITLES = ['', '', '', '', 'Dr ', 'Professor ', 'The Hon. ', 'Major ', 'Captain '];
  const GEN_JOBS = ['Retired magistrate', 'Part-time pub quiz host', 'Former county badminton champion', 'Driving instructor',
    'Chair of the residents association', 'Wedding DJ', 'Owns three garden centres', 'Supply teacher', 'Has a podcast about tennis',
    'Local radio weather presenter', 'Antiques dealer', 'Pigeon fancier', 'Retired dentist', 'Estate agent', 'Parish councillor', 'Sommelier'];
  const GEN_HABITS = {
    cheat: ['Calls anything near the line out, then apologises to the line.', 'Has never once seen a ball land in on their own side.', 'Disputes the score, the weather and the colour of the ball.', 'Brings their own line judge. It is their brother.', 'Calls a ball out before it has landed, to save time.', 'Squints at every line, then calls it out anyway.'],
    grunter: ['Grunts on every shot, including the warm up.', 'Their grunt has set off car alarms in the car park.', 'Grunts in two notes, like a doorbell.', 'Grunts when picking up a ball. Grunts when putting it down.', 'Has been asked to grunt more quietly by a brass band.', 'Grunts the score as well as the shots.'],
    timewaster: ['Ties both shoes before every serve. Both were tied.', 'Consults a notebook between points. It is blank.', 'Takes a towel after every point, and several in between.', 'Bounces the ball until the crowd starts counting.', 'Changes rackets after every game. They are all the same racket.', 'Asks the umpire the time. Twice a game.']
  };
  const GEN_ROSTERS = {};
  function genRoster(season) {
    if (GEN_ROSTERS[season]) return GEN_ROSTERS[season];
    const r = makeLCG(fnv1a('roster:' + season));
    const used = {};
    const roster = OPPONENTS.map((tier, t) => tier.map((base, i) => {
      // A returning face in about a third of the slots
      if (r() < 0.33) return r() < 0.5 ? base : OPPONENTS_B[t][i];
      let name;
      for (let k = 0; k < 20; k++) { name = r.pick(GEN_TITLES) + r.pick(DAILY_FIRST) + ' ' + r.pick(DAILY_LAST); if (!used[name]) break; }
      used[name] = true;
      const pool = t <= 1 ? ['cheat', 'grunter', 'timewaster'] : ['grunter', 'timewaster'];
      const first = r.pick(pool);
      const traits = [first];
      if (r() < 0.35) traits.push(r.pick(pool.filter((x) => x !== first)));
      return {
        name: name,
        traits: traits,
        skill: base.skill,
        bio: r.pick(GEN_JOBS) + '. ' + r.pick(GEN_HABITS[first]),
        shirt: r.pick(SHIRTS),
        face: r.pick(FACES),
        band: r.pick(['#ffffff', '#ff3b30', '#d9f24a', '#1f3a6b', '#2f8f6b', '#e2701c']),
        hair: r.pick(['#2b1b12', '#9a9a9a', '#d9b25c', '#141414', '#7a4a28', '#c0462a', '#e8e0d0']),
        pitch: r.int(110, 240)
      };
    }));
    GEN_ROSTERS[season] = roster;
    return roster;
  }
  function rosterFor(tierIdx, round) {
    const sn = SAVE.season || 1;
    if (sn <= 1) return OPPONENTS;
    if (sn === 2) return OPPONENTS_B;
    return genRoster(sn);
  }
  function careerOpponent(tierIdx, round) {
    const base = rosterFor(tierIdx, round)[tierIdx][round];
    if (round !== 0 || tierIdx === 0) return base;
    for (let t = 0; t < tierIdx; t++) {
      const pool = OPPONENTS[t].concat(OPPONENTS_B[t]);
      for (let i = 0; i < pool.length; i++) {
        const o = pool[i];
        if (isNemesis(o.name) && fnv1a(o.name + ':' + tierIdx) % 2 === 0) {
          const back = Object.assign({}, o, { skill: Math.min(0.95, Math.max(o.skill, base.skill) + 0.03), bio: 'Your nemesis is back, and has been practising. ' + o.bio, nemesis: true });
          if (back.traits.indexOf('cheat') >= 0 && callMode({ mode: 'career', tierIdx: tierIdx }) !== 'players') {
            back.traits = back.traits.filter((t) => t !== 'cheat');
            const swap = ['grunter', 'timewaster'].find((t) => back.traits.indexOf(t) < 0);
            if (swap) back.traits.push(swap);
          }
          return back;
        }
      }
    }
    return base;
  }
  // A long rally gets noticed: at 10, 16 and 22 shots the crowd goes "ooh" and you calm down a little
  /* ---- The handshake at the net ---- */
  // rep: reputation change (positive is Fan Favourite). A snub from them earns you sympathy if you were gracious.
  const HANDSHAKE = {
    firm: { label: 'Firm Handshake', rep: 4, call: 'FIRM HANDSHAKE', sub: 'Two pumps and a nod. Textbook.', you: ['Well played.', 'Good match.'], them: ['Good match.', 'Fair enough.'] },
    limp: { label: 'Limp Fish', rep: 0, call: 'LIMP FISH', sub: 'Like shaking hands with a damp sock.', you: ['Mm.', 'Yep.'], them: ['Was that it?', 'Charming.'] },
    tooSlow: { label: 'Too Slow', rep: -7, call: 'TOO SLOW!', sub: 'The oldest trick in the playground. The crowd boos.', you: ['TOO SLOW!', 'Psych!'], them: ['Unbelievable.', 'Grow up.'] }
  };
  const HS = { walk: 0.8, wait: 4.5, play: 2.4 };
  // Will they snub you? Rivals, nemeses, anyone who lost their temper or lost to a villain might
  function oppSnubs() {
    const r = rivalRec(M.cfg.opp.name);
    let p = 0.06;
    if (M.oppLostCount) p += 0.2;
    if (r && r.l + r.w >= 1) p += 0.1;
    if (isNemesis(M.cfg.opp.name)) p += 0.15;
    if (M.matchWinner === 0 && SAVE.reputationScore <= -25) p += 0.12;
    if (r && r.hs === 'tooSlow') p += 0.35;   // you did it to them last time
    return Math.random() < p;
  }
  function startHandshake() {
    M.hsDone = true;
    M.phase = 'handshake';
    M.phaseT = 0;
    M.phaseDur = 99;
    M.shot = null;
    M.calls.length = 0;
    // The umpire's "Game, set and match" may still be going: let it finish
    if (M.speech && M.speech.who !== 'ump') M.speech = null;
    M.hs = { t: 0, choice: null, at: 0, snub: oppSnubs(), from: { px: M.player.x, py: M.player.y, ox: M.opp.x, oy: M.opp.y } };
    $('#hsChoices').classList.add('hidden');
  }
  function chooseHandshake(id) {
    const S2 = M.hs;
    if (!S2 || S2.choice) return;
    S2.choice = id;
    S2.at = S2.t;
    $('#hsChoices').classList.add('hidden');
    sfx('click');
    const H2 = HANDSHAKE[id];
    // Reputation: snubbed while being gracious earns sympathy; a mutual snub is just sad
    let dRep = H2.rep;
    if (S2.snub && id === 'firm') dRep = 7;
    if (S2.snub && id === 'tooSlow') dRep = -9;
    S2.rep = dRep;
    SAVE.reputationScore = clamp(SAVE.reputationScore + dRep, -100, 100);
    if (id === 'tooSlow') SAVE.stats.tooSlow = (SAVE.stats.tooSlow || 0) + 1;
    persist();
    const main = S2.snub ? (id === 'tooSlow' ? 'MUTUAL SNUB' : 'SNUBBED!') : H2.call;
    const sub = S2.snub ? (id === 'tooSlow' ? 'Neither of you shook. The ' + officialTitle().toLowerCase() + ' looks at the floor.' : tvName(M.cfg.opp.name) + ' walked straight past your hand.') : H2.sub;
    callout('hs', { main: main, sub: sub, dur: 2.2, color: dRep > 0 ? '#d9f24a' : dRep < 0 ? '#ff8a80' : '#f4f1e6' });
    if (dRep) M.floaters.push({ text: (dRep > 0 ? 'FAN FAVOURITE +' : 'CROWD VILLAIN +') + Math.abs(dRep), x: 640, y: 655, t: 0, color: dRep > 0 ? '#9fe7a0' : '#ff8a80', big: true });
    if (dRep < 0 || S2.snub) { M.crowdMood = { kind: 'boo', t: 0, dur: 2.2 }; sfx('boo'); } else sfx('applause', { power: 0.7 });
  }
  function updateHandshake(dt) {
    const S2 = M.hs;
    S2.t += dt;
    const p = M.player;
    const o = M.opp;
    // Walk to the net, a little either side of the centre strap
    const w = clamp(S2.t / HS.walk, 0, 1);
    const e = w * w * (3 - 2 * w);
    p.x = lerp(S2.from.px, -0.32, e);
    p.y = lerp(S2.from.py, C.net - 0.75, e);
    o.x = lerp(S2.from.ox, 0.32, e);
    o.y = lerp(S2.from.oy, C.net + 0.75, e);
    p.vx = w < 1 ? 1 : 0;
    o.vx = w < 1 ? 1 : 0;
    p.run += w < 1 ? dt * 12 : 0;
    o.run += w < 1 ? dt * 12 : 0;
    p.swing = 0;
    o.swing = 0;
    if (w >= 1 && !S2.choice) {
      $('#hsChoices').classList.remove('hidden');
      if (S2.t > HS.walk + HS.wait) chooseHandshake('firm');
    }
    if (S2.choice) {
      const a = S2.t - S2.at;
      if (a > 0.5 && !S2.said) {
        S2.said = true;
        const H2 = HANDSHAKE[S2.choice];
        M.speech = S2.snub && S2.choice !== 'tooSlow'
          ? { text: pick(['Not today.', 'Talk to my agent.', 'I do not shake with people like you.']), who: 'opp', t: 0, dur: 1.6 }
          : { text: pick(S2.choice === 'tooSlow' ? H2.you : H2.them), who: S2.choice === 'tooSlow' ? 'you' : 'opp', t: 0, dur: 1.6 };
      }
      if (S2.snub && S2.choice !== 'tooSlow') o.x = lerp(0.32, 3.5, clamp((a - 0.4) / 1.6, 0, 1));
      if (a > HS.play) {
        M.phase = 'matchOver';
        M.phaseT = 0;
        M.phaseDur = 0.01;
      }
    }
  }
  // Where each hand is, and how each face looks, for the figures
  function handshakePose(who) {
    const S2 = M.hs;
    if (!S2 || M.phase !== 'handshake') return null;
    const meet = proj(0, C.net, 1.02);
    const k = meet.s * 0.88;
    const a = S2.choice ? S2.t - S2.at : 0;
    const out = S2.t > HS.walk * 0.7;
    if (!out) return { stance: 'ready', at: null, mood: 'calm', front: who === 'opp' };
    if (who === 'you') {
      if (!S2.choice) return { stance: 'shake', at: { x: meet.x - 0.04 * k, y: meet.y }, mood: 'calm' };
      if (S2.choice === 'tooSlow' && a > 0.25) {
        // Whipped away, up and through the hair
        const hd = M.playerHead || { headX: meet.x - 0.4 * k, headY: meet.y - 0.9 * k };
        const sweep = clamp((a - 0.25) / 0.45, 0, 1);
        return { stance: 'shake', at: { x: hd.headX + (0.34 - 0.14 * sweep) * k, y: hd.headY + (0.02 - 0.06 * sweep) * k }, mood: 'happy' };
      }
      const pump = S2.choice === 'firm' && !S2.snub ? Math.sin(a * 14) * 0.05 * k * (a < 1.2 ? 1 : 0) : 0;
      const droop = S2.choice === 'limp' ? 0.08 * k : 0;
      return { stance: 'shake', at: { x: meet.x - 0.04 * k, y: meet.y + pump + droop }, mood: S2.snub ? 'cross' : 'calm' };
    }
    // Them
    if (S2.snub && S2.choice !== 'tooSlow' && S2.choice) return { stance: 'sulk', at: null, mood: 'happy', front: a < 0.4 };
    if (S2.snub && !S2.choice) return { stance: 'sulk', at: null, mood: 'cross', front: true };
    if (!S2.choice) return { stance: 'shake', at: { x: meet.x + 0.04 * k, y: meet.y }, mood: 'calm', front: true };
    const pump = S2.choice === 'firm' ? Math.sin(a * 14) * 0.05 * k * (a < 1.2 ? 1 : 0) : 0;
    const droop = S2.choice === 'limp' ? 0.08 * k : 0;
    const mood = S2.choice === 'tooSlow' ? 'furious' : S2.choice === 'limp' ? 'cross' : 'happy';
    return { stance: 'shake', at: { x: meet.x + 0.04 * k, y: meet.y + pump + droop }, mood: mood, front: true };
  }
  // A looping finger for each move, on a small square of glass. Same outline and colours as the HUD.
  function drawMoveIcon(ctx, mv, cx, cy, t) {
    const S = 34;
    ctx.save();
    ctx.fillStyle = '#10261a';
    ctx.strokeStyle = '#06110a';
    ctx.lineWidth = 4;
    roundRect(ctx, cx - S, cy - S, S * 2, S * 2, 10);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(217,242,74,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    const loop = (t % 1.4) / 1.4;
    let fx = cx;
    let fy = cy + 8;
    let ring = 0;
    let arrow = 0;
    const ease = (u) => u * u * (3 - 2 * u);
    if (mv === 'spin') {
      // Up, then down, alternating each loop
      const up = Math.floor(t / 1.4) % 2 === 0;
      const k = ease(Math.min(1, loop / 0.35));
      fy = cy + (up ? 14 - 30 * k : -14 + 30 * k);
      arrow = up ? -1 : 1;
    } else if (mv === 'lob') {
      const k = ease(Math.min(1, loop / 0.3));
      fy = cy + 18 - 40 * k;
      arrow = -1;
    } else if (mv === 'power') {
      fy = cy;
      ring = Math.min(1, loop / 0.8);
    } else if (mv === 'net') {
      fx = cx - 10;
      const k = ease(Math.min(1, loop / 0.5));
      fy = cy + 16 - 30 * k;
      arrow = -1;
    } else if (mv === 'serve') {
      // Hold, then drag forward into the box
      const k = ease(clamp((loop - 0.35) / 0.4, 0, 1));
      ring = Math.min(1, loop / 0.35);
      fy = cy + 14 - 26 * k;
    }
    if (ring > 0) {
      ctx.strokeStyle = '#d9f24a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(fx, fy, 15, -Math.PI / 2, -Math.PI / 2 + ring * Math.PI * 2);
      ctx.stroke();
    }
    if (arrow) {
      ctx.strokeStyle = 'rgba(244,241,230,0.55)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      const ax = cx + 18;
      ctx.beginPath();
      ctx.moveTo(ax, cy + 12 * -arrow);
      ctx.lineTo(ax, cy - 14 * -arrow);
      ctx.moveTo(ax - 6, cy - 8 * -arrow);
      ctx.lineTo(ax, cy - 14 * -arrow);
      ctx.lineTo(ax + 6, cy - 8 * -arrow);
      ctx.stroke();
    }
    ctx.fillStyle = '#f4f1e6';
    ctx.strokeStyle = '#06110a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx, fy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  /* ---- Point of the match: every point is recorded; your best one is replayed when the match ends ---- */
  const pickBody = (b) => ({ x: b.x, y: b.y, vx: b.vx, run: b.run, swing: b.swing, swingSpin: b.swingSpin, side: b.side, stroke: b.stroke, lunge: b.lunge, split: b.split, mouth: b.mouth || 0 });
  function recordFrame() {
    if (M.tut || M.phase === 'highlight' || !M.pointRec) return;
    if (!/rally|pointOver/.test(M.phase) || (M.phase === 'pointOver' && M.phaseT > 1)) return;
    // The last 25 seconds of a long rally: the end of the point is the part worth replaying
    if (M.pointRec.length > 60 * 25) M.pointRec.shift();
    const sh = M.shot;
    M.pointRec.push({
      p: pickBody(M.player), o: pickBody(M.opp), shot: sh, st: sh ? sh.t : 0, bounced: sh ? sh.bounced : false,
      trail: sh ? sh.trail.map((q) => ({ x: q.x, y: q.y, z: q.z })) : null, cam: { x: M.cam.x, y: M.cam.y, z: M.cam.z }
    });
  }
  // How good the last point was, if you won it: a winner beats an ace beats a forced error, and long rallies count
  const HL_TITLE = { pWinner: 'WINNER', pPass: 'PASSING SHOT', pLob: 'LOB WINNER', pDrop: 'DROP SHOT WINNER', pSmash: 'SMASH', pVolley: 'VOLLEY WINNER', ace: 'ACE', unreturned: 'UNRETURNED SERVE', jammed: 'JAMMED THEM', forcedErr: 'FORCED ERROR', overturnedAce: 'ACE, ON REVIEW', overturned: 'WON ON REVIEW' };
  const POINT_VALUE = { pWinner: 6, pPass: 7, pLob: 7, pDrop: 7, pSmash: 6, pVolley: 6, ace: 4, unreturned: 3, jammed: 3, forcedErr: 4, overturnedAce: 4, overturned: 3 };
  function scorePoint() {
    const lp = M.lastPoint;
    if (M.tut || !lp || lp.scored || !M.pointRec || M.pointRec.length < 30) return;
    lp.scored = true;
    if (lp.winner !== 0) return;
    const score = (POINT_VALUE[lp.reason] || 1) + (lp.rally || 0) * 0.6;
    if (!M.bestPoint || score > M.bestPoint.score) {
      M.bestPoint = { frames: M.pointRec, score: score, reason: lp.reason, rally: lp.rally || 0, title: HL_TITLE[lp.reason] || 'POINT WON' };
    }
  }
  function startPointRecording() {
    scorePoint();
    M.pointRec = [];
  }
  function startHighlight(short) {
    const f = M.bestPoint.frames;
    const n = f.length;
    M.hlDone = true;
    M.phase = 'highlight';
    M.phaseT = 0;
    // Short: the last 1.6 s of the point, the last second of it in slow motion (about 3 s in all)
    const from = short ? Math.max(0, n - 96) : 0;
    const slowFrom = short ? Math.max(from, n - 60) : n * 0.7;
    M.hl = { i: from, f: f, shot: false, skip: false, slowFrom: slowFrom };
    M.stinger = { t: M.time };
    M.calls.length = 0;
    M.floaters.length = 0;
    // Record it for sharing: the real time, plus the slow motion at the end
    recordTantrumClip(Math.min(14, (slowFrom - from) / 60 + (n - slowFrom) / 60 / 0.45 + 0.4), M.bestPoint.title);
    sfx('whoosh', { power: 0.6 });
  }
  function applyFrame(fr) {
    Object.assign(M.player, fr.p);
    Object.assign(M.opp, fr.o);
    M.shot = fr.shot;
    if (fr.shot) {
      fr.shot.t = fr.st;
      fr.shot.bounced = fr.bounced;
      fr.shot.trail = fr.trail || [];
    }
    M.cam.x = fr.cam.x;
    M.cam.y = fr.cam.y;
    M.cam.z = fr.cam.z;
  }
  function rallyMilestone() {
    if (M.tut) return;
    if (M.rallyCount === 10 || M.rallyCount === 16 || M.rallyCount === 22) {
      M.floaters.push({ text: M.rallyCount + '-SHOT RALLY', x: 640, y: 200, t: 0, color: '#f4f1e6', big: true });
      sfx('ooh');
      M.hype = Math.min(1, M.hype + 0.2);
      addRage(-0.03, false);
    }
  }
  function pickWeighted(mix, u) {
    let sum = 0;
    const keys = Object.keys(mix);
    keys.forEach((k) => { sum += mix[k]; });
    let acc = 0;
    for (let i = 0; i < keys.length; i++) { acc += mix[keys[i]] / sum; if (u < acc) return keys[i]; }
    return keys[keys.length - 1];
  }
  function oppColors() {
    return oppColorsFor(M.cfg.opp);
  }
  function oppColorsFor(o) {
    const designs = ['polo', 'hoops', 'stripes', 'sash', 'chevron', 'polo', 'pinstripe'];
    let hsh = 0;
    for (let i = 0; i < o.name.length; i++) hsh = (hsh * 31 + o.name.charCodeAt(i)) >>> 0;
    return { skin: o.face, shirt: o.shirt, shirt2: o.band, design: designs[hsh % designs.length], shorts: '#f4f4f4', hair: o.hair || '#333', band: o.band, racket: '#222', shoes: '#f6f6f2', shoeSole: '#ffffff', shoeAccent: o.band, look: OPP_LOOKS[o.name] || null };
  }

  // An opponent drawn as they look on court, facing you, into a canvas of their own: 'bust' for portraits,
  // 'full' for a whole figure. The mood shows on the face (calm, focus, happy, cross, furious).
  function renderFigure(o, mood, w, h, mode, extra) {
    extra = extra || {};
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    const body = { x: 0, y: 1.6, tx: 0, ty: 1.6, vx: 0, run: 0, swing: 0, side: 1, stroke: null, lunge: 0, split: 0, react: 0 };
    const f = proj(0, 1.6, 0);
    const k = f.s * 0.88;
    const box = mode === 'bust' ? [f.x - 0.5 * k, f.y - 1.92 * k, f.x + 0.5 * k, f.y - 0.92 * k] : [f.x - 0.78 * k, f.y - (extra.top || 1.95) * k, f.x + 0.78 * k, f.y + 0.1 * k];
    const S = Math.min(w / (box[2] - box[0]), h / (box[3] - box[1]));
    g.setTransform(S, 0, 0, S, -box[0] * S + (w - (box[2] - box[0]) * S) / 2, -box[1] * S + (h - (box[3] - box[1]) * S) / 2);
    const cols = extra.colors || oppColorsFor(o);
    if (extra.before) extra.before(g, f, k, cols);
    try { drawFigure(g, body, true, cols, { mood: mood, time: extra.time || 0, look: 0, noShadow: true, noRacket: mode === 'bust' || extra.noRacket, stance: extra.stance, redden: extra.redden || 0 }); } catch (e) { /* a figure never stops the game */ }
    return cv;
  }
  // You, as the match draws you, in your kit
  function youColors() {
    return Object.assign({ skin: '#e7b892', hair: '#3a2716' }, playerKit());
  }
  // One person from the crowd painter, at any size, facing you or turned away. The same seed is always the
  // same person. Outlined like the front row of the stands.
  function paintPerson(ctx, seed, x, headY, sz, V, front, outline) {
    const B = { s: sz, head: { x: x, y: headY }, sh: { x: x, y: headY + 0.2 * sz }, hip: { x: x, y: headY + 0.7 * sz }, legs: null, noLegs: true, back: !front, adult: true, face: 0 };
    const draw = (c) => paintSpectator(c, x, headY, 0, V, makeLCG(seed), front ? 'near' : 'far', B);
    if (outline) withOutline(ctx, { x0: x - 0.4 * sz, y0: headY - 0.35 * sz, x1: x + 0.4 * sz, y1: headY + 0.85 * sz }, draw);
    else draw(ctx);
    return crowdPerson(makeLCG(seed), V);
  }
  // How they look at you, from your history together
  function rivalMood(o) {
    const r = rivalRec(o.name);
    if (!r) return 'calm';
    if (isNemesis(o.name)) return 'happy';
    return r.last === 'w' ? 'cross' : 'happy';
  }
  function tantrumOnCourt() {
    return FSM.name === 'MELTDOWN_MINIGAME' && MD.smashed && MD.style && MD.phase !== 'ready' && MD.phase !== 'tapping';
  }

  // The ball bounced before a serve, by the server's left hand and a little in front of them.
  // The opponent faces you, so their left is screen right; yours is screen left.
  function preServeBall() {
    if (M.phase === 'prePoint' && M.server === 1 && M.bounceCount > 0) {
      const k = M.bounceT / 0.4;
      return { who: M.opp, x: M.opp.x + 0.35, y: M.opp.y - 0.3, z: 0.05 + Math.sin(k * Math.PI) * 0.9 };
    }
    if (M.phase === 'serveReady' && M.server === 0) {
      const k = (M.phaseT % 0.8) / 0.8;
      return { who: M.player, x: M.player.x - 0.35, y: M.player.y + 0.3, z: 0.05 + Math.sin(k * Math.PI) * 0.9 };
    }
    return null;
  }
  // The bouncing hand stays at waist height and meets the ball at the top of each bounce
  function ballHand(pb) {
    return pb ? proj(pb.x, pb.y, clamp(pb.z, 0.8, 0.95)) : null;
  }

  // Which way a player's head turns: towards the ball, left or right on screen (-1 to 1)
  function lookAt(b) {
    const s = M.shot;
    if (!s || s.dead || M.phase !== 'rally') return 0;
    const bp = shotPos(s, s.t);
    return clamp((bp.x - b.x) / 2.5, -1, 1);
  }
  // One light for the whole scene: a colour grade per venue (warm at Tunbridge, cool at the council courts) and a
  // soft vignette, over the world and under the HUD. Dusk and night already carry their own tint.
  const GRADE = { club: 'rgba(255,236,190,0.05)', council: 'rgba(160,185,210,0.07)', leisure: 'rgba(255,240,205,0.04)', invitational: 'rgba(255,196,120,0.08)', slam: 'rgba(195,210,255,0.04)' };
  let vignetteGrad = null;
  function drawGrade(ctx) {
    const G = bgCache && bgCache.geo;
    if (!G) return;
    if (!G.session && GRADE[G.VK]) {
      ctx.fillStyle = GRADE[G.VK];
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    }
    if (!vignetteGrad) {
      vignetteGrad = ctx.createRadialGradient(640, 380, 320, 640, 380, 860);
      vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vignetteGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    }
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
  }

  /* ---- Ambient life ---- */
  // A pigeon wanders onto the court between points at the outdoor venues, pecks about, and flies off when play starts
  function updatePigeon() {
    const pg = M.pigeon;
    if (!pg) return;
    const dt = clamp(M.time - (pg.last || M.time), 0, 0.1);
    pg.last = M.time;
    pg.t += dt;
    if (pg.mode === 'walk') {
      if (/serveAim|oppToss|rally/.test(M.phase)) {
        pg.mode = 'fly';
        pg.vx = (pg.x > 0 ? 1 : -1) * 3;
        sfx('whoosh', { power: 0.3, pan: pg.x / 8 });
      } else {
        // Waddle in short bursts, turning now and then
        const moving = Math.sin(pg.t * 1.7 + pg.seed) > 0.2;
        if (moving) pg.x += pg.dir * 0.35 * dt;
        if (Math.random() < dt * 0.4) pg.dir *= -1;
        pg.x = clamp(pg.x, -4.5, 4.5);
        pg.peck = moving ? 0 : Math.abs(Math.sin(pg.t * 9)) > 0.7 ? 1 : 0;
      }
    } else {
      pg.x += pg.vx * dt;
      pg.z += 2.6 * dt;
      pg.y += 1.5 * dt;
      if (pg.z > 9) M.pigeon = null;
    }
  }
  function drawPigeon(ctx) {
    const pg = M.pigeon;
    if (!pg) return;
    const g0 = proj(pg.x, pg.y, 0);
    const b = proj(pg.x, pg.y, pg.z + 0.12);
    const k = b.s;
    const d = pg.mode === 'fly' ? Math.sign(pg.vx) : pg.dir;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(g0.x, g0.y, 0.14 * k, 0.04 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8f96a3';
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, 0.14 * k, 0.09 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6f7682';
    if (pg.mode === 'fly') {
      const flap = Math.sin(pg.t * 30) * 0.16 * k;
      ctx.beginPath();
      ctx.moveTo(b.x - 0.04 * k, b.y);
      ctx.lineTo(b.x - 0.22 * k, b.y - flap);
      ctx.lineTo(b.x + 0.06 * k, b.y - 0.02 * k);
      ctx.lineTo(b.x + 0.24 * k, b.y - flap);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.ellipse(b.x - d * 0.03 * k, b.y - 0.01 * k, 0.09 * k, 0.05 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Head with the green-purple sheen at the neck, a beak, and an eye
    const hx = b.x + d * 0.13 * k;
    const hy = b.y - (pg.peck ? 0.0 : 0.09) * k + (pg.peck ? 0.05 * k : 0);
    ctx.fillStyle = '#6e8a7c';
    ctx.beginPath();
    ctx.arc(b.x + d * 0.09 * k, b.y - 0.05 * k, 0.045 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#9aa1ad';
    ctx.beginPath();
    ctx.arc(hx, hy, 0.045 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e0b04a';
    ctx.beginPath();
    ctx.moveTo(hx + d * 0.04 * k, hy - 0.01 * k);
    ctx.lineTo(hx + d * 0.08 * k, hy + 0.005 * k);
    ctx.lineTo(hx + d * 0.04 * k, hy + 0.015 * k);
    ctx.fill();
    ctx.fillStyle = '#ff6a3a';
    ctx.fillRect(hx + d * 0.012 * k - 0.6, hy - 0.015 * k - 0.6, Math.max(1.2, 0.02 * k), Math.max(1.2, 0.02 * k));
    if (pg.mode === 'walk') {
      ctx.strokeStyle = '#d9776a';
      ctx.lineWidth = Math.max(1, 0.015 * k);
      ctx.beginPath();
      ctx.moveTo(b.x - 0.03 * k, b.y + 0.07 * k);
      ctx.lineTo(g0.x - 0.03 * k, g0.y);
      ctx.moveTo(b.x + 0.03 * k, b.y + 0.07 * k);
      ctx.lineTo(g0.x + 0.03 * k, g0.y);
      ctx.stroke();
    }
  }
  // Between points at the big venues, a ball kid at the far wall rolls a ball along to the other corner
  function rolledBall() {
    const G = bgCache && bgCache.geo;
    if (!G || !G.V.kids || G.V.kids < 4 || M.phase !== 'pointOver') return null;
    const u = (M.phaseT - 0.1) / 1.5;
    if (u <= 0 || u >= 1) return null;
    const dir = ((M.points[0] + M.points[1] + M.games[0] + M.games[1]) % 2) ? 1 : -1;
    return { x: dir * lerp(-6.4, 6.4, u), y: C.L + 5.6, z: 0.035 + Math.abs(Math.sin(u * 18)) * 0.01 };
  }

  // The court wears as the match goes on: footprints where both players move, and their slides, stamped into a
  // half-resolution layer over the court that lasts the whole match
  const WEAR_COL = { clay: 'rgba(110,45,20,0.12)', grass: 'rgba(165,145,80,0.1)', hard: 'rgba(20,25,35,0.05)', indoor: 'rgba(0,0,0,0.045)' };
  function courtWear(ctx) {
    const cw = Math.max(1, Math.round(canvas.width / 2));
    const ch = Math.max(1, Math.round(canvas.height / 2));
    if (!M.wear || M.wear.width !== cw || M.wear.height !== ch) {
      M.wear = document.createElement('canvas');
      M.wear.width = cw;
      M.wear.height = ch;
      M.wearCtx = M.wear.getContext('2d');
      M.wearCtx.setTransform(scale / 2, 0, 0, scale / 2, BX * scale / 2, BY * scale / 2);
    }
    const g = M.wearCtx;
    g.fillStyle = WEAR_COL[M.cfg.surface] || WEAR_COL.hard;
    [M.player, M.opp].forEach((b) => {
      const ls = b.lastStep || (b.lastStep = { x: b.x, y: b.y, n: 0 });
      if (Math.hypot(b.x - ls.x, b.y - ls.y) > 0.45) {
        ls.x = b.x;
        ls.y = b.y;
        ls.n++;
        const q = proj(b.x + (ls.n % 2 ? 0.1 : -0.1), b.y, 0);
        g.beginPath();
        g.ellipse(q.x, q.y, 0.07 * q.s, 0.028 * q.s, 0, 0, Math.PI * 2);
        g.fill();
      }
    });
    M.skids.forEach((sk) => {
      if (sk.worn) return;
      sk.worn = true;
      const a = proj(sk.x - sk.dx, sk.y, 0);
      const b2 = proj(sk.x, sk.y, 0);
      g.strokeStyle = WEAR_COL[M.cfg.surface] || WEAR_COL.hard;
      g.lineWidth = Math.max(1, 0.08 * b2.s);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b2.x, b2.y);
      g.stroke();
    });
    ctx.drawImage(M.wear, -BX, -BY, W + 2 * BX, H + 2 * BY);
  }
  // The stands: the stadium picture, then everything in it that moves
  function drawStands(ctx) {
    ctx.drawImage(bgCache.bg, -BX, -BY, W + 2 * BX, H + 2 * BY);
    drawClouds(ctx);
    drawCrowd(ctx);
    drawBoards(ctx);
    drawRimFlags(ctx);
    drawBigScreen(ctx);
    drawFans(ctx);
  }
  // While the ball is in play the crowd keeps still (unless a Mexican wave is rolling round)
  const STILL = { c: null, key: '' };
  function standsStill() {
    if (FSM.name !== 'MATCH_PLAY' || !/^(serveReady|serveAim|oppToss|rally)$/.test(M.phase)) return false;
    if (M.waveT >= 0 || M.celeb || (M.crowdCam && M.time - M.crowdCam.t < 2.6) || tantrumOnCourt()) return false;
    return SAVE.settings.stillCrowd !== false;
  }
  function drawStillStands(ctx) {
    const bg = bgCache.bg;
    const key = (M.stats.pointsWon + M.stats.pointsLost) + ':' + M.games[0] + ':' + M.games[1] + ':' + bg.width + 'x' + bg.height + ':' + BX + ':' + BY;
    if (STILL.key !== key || !STILL.c || STILL.bg !== bg) {
      if (!STILL.c || STILL.c.width !== bg.width || STILL.c.height !== bg.height) {
        STILL.c = document.createElement('canvas');
        STILL.c.width = bg.width;
        STILL.c.height = bg.height;
      }
      const k = bg.width / (W + 2 * BX);
      const sc = STILL.c.getContext('2d');
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, STILL.c.width, STILL.c.height);
      sc.setTransform(k, 0, 0, k, BX * k, BY * k);
      drawStands(sc);
      STILL.key = key;
      STILL.bg = bg;
    }
    ctx.drawImage(STILL.c, -BX, -BY, W + 2 * BX, H + 2 * BY);
  }
  function renderMatch(ctx) {
    if (!M) return;
    if (!bgCache) bgCache = buildBackground(M.cfg.surface, M.cfg.seed);
    ctx.fillStyle = '#0d1f16';
    ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    ctx.save();
    // Camera: zoom about the centre, then pan. The HUD is drawn afterwards, unmoved.
    ctx.translate(640 + M.cam.x, 360 + M.cam.y);
    ctx.scale(M.cam.z, M.cam.z);
    ctx.translate(-640, -360);
    if (standsStill()) drawStillStands(ctx);
    else drawStands(ctx);
    if (bgCache.fg) ctx.drawImage(bgCache.fg, -BX, -BY, W + 2 * BX, H + 2 * BY);
    if (tantrumOnCourt() || M.celeb) drawFlashes(ctx);
    if (royalActive()) drawIncident(ctx);
    if (M.shake > 0 && !reduceMotion) ctx.translate((Math.random() - 0.5) * 14 * M.shake, (Math.random() - 0.5) * 10 * M.shake);

    if (!tantrumOnCourt()) courtWear(ctx);
    // Ball marks (clay keeps them; elsewhere a brief chalk puff)
    M.marks.forEach((m) => {
      const p = proj(m.x, m.y, 0);
      const a = M.surf.marks || m.label ? 0.75 : Math.max(0, 0.6 - m.t);
      ctx.fillStyle = M.surf.marks ? 'rgba(110,40,15,' + a + ')' : 'rgba(255,255,255,' + a * 0.6 + ')';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, Math.max(3, 0.1 * p.s), Math.max(1.5, 0.04 * p.s), 0, 0, Math.PI * 2);
      ctx.fill();
      if (m.label) {
        ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = m.out ? '#ff8a80' : '#d9f24a';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        const label = m.label;
        ctx.strokeText(label, p.x, p.y - 12);
        ctx.fillText(label, p.x, p.y - 12);
      }
    });

    // Pro footwork: a ring where their ball will bounce and a faint footprint where you would want to stand
    if (proFeet() && s_incoming() && M.shot.land && !M.shot.bounced) {
      const lp = proj(M.shot.land.x, M.shot.land.y, 0);
      ctx.strokeStyle = 'rgba(244,241,230,0.55)';
      ctx.lineWidth = Math.max(1.5, 0.03 * lp.s);
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.ellipse(lp.x, lp.y, 0.28 * lp.s, 0.1 * lp.s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const gl = M.player.goal;
      if (gl) {
        const gp0 = proj(gl.x, gl.y, 0);
        // Off the bottom of the picture (deep behind the baseline): pinned to the edge, with an arrow down
        const deep = gp0.y > 640;
        const gp = deep ? { x: gp0.x, y: 640, s: gp0.s } : gp0;
        if (deep) {
          ctx.strokeStyle = 'rgba(159,231,255,0.6)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(gp.x - 9, gp.y + 12);
          ctx.lineTo(gp.x, gp.y + 20);
          ctx.lineTo(gp.x + 9, gp.y + 12);
          ctx.stroke();
        }
        ctx.fillStyle = M.shot.setT !== undefined ? 'rgba(159,231,255,0.75)' : 'rgba(159,231,255,0.42)';
        [-1, 1].forEach((sd) => { ctx.beginPath(); ctx.ellipse(gp.x + sd * 0.11 * gp.s, gp.y, 0.075 * gp.s, 0.04 * gp.s, 0, 0, Math.PI * 2); ctx.fill(); });
      }
    }
    drawDebris(ctx);
    // Skid marks: slides on clay, scuffs on grass, rubber on hard courts
    M.skids.forEach((sk) => {
      const a = proj(sk.x - sk.dx, sk.y, 0);
      const b2 = proj(sk.x, sk.y, 0);
      ctx.globalAlpha = Math.max(0, 1 - sk.t / sk.life);
      ctx.strokeStyle = sk.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, 0.09 * b2.s);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Service box highlight while you serve
    if (M.phase === 'serveReady' || M.phase === 'serveAim') {
      const b = serviceBox(1, isDeuceSide());
      quad(ctx, [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], 'rgba(217,242,74,' + (0.12 + 0.06 * Math.sin(M.time * 5)) + ')');
    }

    // The aiming lesson's target
    if (M.tut && tutStep() && tutStep().target) {
      const b = tutStep().target;
      quad(ctx, [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]], 'rgba(217,242,74,' + (0.38 + 0.14 * Math.sin(M.time * 5)).toFixed(2) + ')');
      const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map((q) => proj(q[0], q[1], 0));
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#d9f24a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      const mid = proj((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0);
      ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
      ctx.fillStyle = '#d9f24a';
      ctx.textAlign = 'center';
      ctx.fillText('TARGET', mid.x, mid.y - 22);
    }

    // Depth sorted scene: things further away first
    const s = M.shot;
    let bp = null;
    if (s) bp = shotPos(s, s.t);
    const tossing = M.phase === 'serveAim' || M.phase === 'oppToss';
    const items = [];
    items.push({ y: M.opp.y, draw: () => {
      const so = M.shot;
      // How far into the unit turn they are (0 = not turning): the racket goes up, then drops into the slot
      const oPrep = so && M.phase === 'rally' && so.hitter === 0 && !so.resolved && !so.dead && so.tc - so.t < 0.5 ? clamp(1 - (so.tc - so.t) / 0.5, 0.01, 1) : 0;
      const pbO = preServeBall();
      const bounceO = pbO && pbO.who === M.opp;
      // Their face: furious once they have lost it, cross as the temper rises, pleased just after winning a point,
      // focused while a ball comes at them
      const lpO = M.lastPoint;
      const moodO = M.oppLost ? 'furious' : M.oppTemp > 0.55 ? 'cross' : lpO && lpO.winner === 1 && M.time - lpO.t < 2.2 ? 'happy' : so && so.hitter === 0 && !so.resolved ? 'focus' : 'calm';
      const hsO = handshakePose('opp');
      if (hsO) {
        M.oppHead = drawFigure(ctx, M.opp, hsO.front !== false, oppColors(), { look: 0, mood: hsO.mood, time: M.time, toll: M.toll || 0, noRacket: hsO.stance === 'shake', stance: hsO.stance, shakeAt: hsO.at, redden: hsO.mood === 'furious' ? 0.7 : 0 });
        return;
      }
      const h = drawFigure(ctx, M.opp, true, oppColors(), { look: lookAt(M.opp), mood: moodO, time: M.time, toll: M.toll || 0, bag: M.phase === 'intro' && M.phaseT < 2.5, noRacket: M.phase === 'intro' && M.phaseT < 2.5, prep: oPrep, stance: bounceO ? 'bounce' : undefined, ballHand: bounceO ? ballHand(pbO) : null, toss: M.phase === 'oppToss' ? Math.max(0.05, M.phaseT / M.phaseDur) : 0, redden: M.oppLost ? 0.9 : Math.max(0, M.oppTemp - 0.35) });
      M.oppHead = h;
    } });
    items.push({ y: C.net, draw: () => drawNet(ctx) });
    pushCrew(items, ctx);
    // Between points your stance gives your mood away: sulking above 60% rage, fed up above 80%
    const idle = M.phase === 'pointOver' || M.phase === 'prePoint' || M.phase === 'intro' || M.phase === 'review';
    const stance = idle ? (M.rage > 0.8 ? 'overhead' : M.rage > 0.6 ? 'sulk' : 'ready') : 'ready';
    items.push({ y: M.player.y, draw: () => {
      const rc = M.cut && M.cut.live && M.cut.who === 0 && M.cut.react && M.phase === 'pointOver' ? M.cut : null;
      if (rc && !M.celeb) {
        const fp = proj(M.player.x, M.player.y, 0);
        const sc = fp.s * 0.88 / KP;
        ctx.save();
        ctx.translate(fp.x, fp.y);
        ctx.scale(sc, sc);
        ctx.translate(-PX, -FLOOR_Y);
        REACT_SAY = rc.say;
        renderRoutine(ctx, Math.max(0, M.phaseT - rc.at), rc.react, playerKit(), [], []);
        ctx.restore();
        M.playerHead = { headX: fp.x, headY: fp.y - 2 * fp.s * 0.88, k: fp.s * 0.88 };
        return;
      }
      if (M.celeb) {
        const fp = proj(M.player.x, M.player.y, 0);
        const sc = fp.s * 0.88 / KP;
        ctx.save();
        ctx.translate(fp.x, fp.y);
        ctx.scale(sc, sc);
        ctx.translate(-PX, -FLOOR_Y);
        renderRoutine(ctx, M.celeb.t, M.celeb.style, playerKit(), [], []);
        ctx.restore();
        M.playerHead = { headX: fp.x, headY: fp.y - 2 * fp.s * 0.88, k: fp.s * 0.88 };
        return;
      }
      if (tantrumOnCourt()) {
        const fp = proj(M.player.x, M.player.y, 0);
        const sc = fp.s * 0.88 / KP;
        ctx.save();
        ctx.translate(fp.x, fp.y);
        ctx.scale(sc, sc);
        ctx.translate(-PX, -FLOOR_Y);
        // The action replay runs its own clock (MD.rt) back through the wind-up and the impact
        renderSmash(ctx, MD.replaying ? MD.rt : MD.t);
        ctx.restore();
        M.playerHead = { headX: fp.x, headY: fp.y - 2 * fp.s * 0.88, k: fp.s * 0.88 };
        return;
      }
      const sp2 = M.shot;
      const pPrep = sp2 && M.phase === 'rally' && sp2.hitter === 1 && !sp2.resolved && !sp2.dead && sp2.tc - sp2.t < 0.6 ? clamp(1 - (sp2.tc - sp2.t) / 0.6, 0.01, 1) : 0;
      const pbP = preServeBall();
      const bounceP = pbP && pbP.who === M.player;
      const hsY = handshakePose('you');
      if (hsY) {
        M.playerHead = drawFigure(ctx, M.player, false, playerColors(), { look: 0, time: M.time, toll: M.toll || 0, noRacket: hsY.stance === 'shake', stance: hsY.stance, shakeAt: hsY.at });
        return;
      }
      const h = drawFigure(ctx, M.player, false, playerColors(), {
        prep: pPrep,
        ballHand: bounceP ? ballHand(pbP) : null,
        toss: M.phase === 'serveAim' ? Math.max(0.05, M.power) : 0,
        redden: Math.max(0, M.rage - 0.5) * 2,
        stance: bounceP ? 'bounce' : stance,
        look: lookAt(M.player),
        toll: M.toll || 0,
        bag: M.phase === 'intro' && M.phaseT < 2.5,
        noRacket: M.phase === 'intro' && M.phaseT < 2.5,
        load: charging(),
        charge: chargeLevel(),
        time: M.time
      });
      M.playerHead = h;
    } });
    // The dead ball from the last point is cleared away for the meltdown close up, and once a dead ball has flown
    // back past your baseline it is gone: drawn any nearer, it swells over the whole picture (and your celebration)
    const goneBy = s && s.dead && bp && bp.y < -1.2;
    if (bp && !tossing && !goneBy && FSM.name !== 'MELTDOWN_MINIGAME') items.push({ y: bp.y + 0.01, draw: () => drawBall(ctx, bp, s) });
    if (M.phase === 'serveAim') {
      const z = 2.2 + Math.sin(Math.min(1, M.tossT / 0.5) * Math.PI / 2) * 1.3;
      items.push({ y: M.player.y - 0.01, draw: () => drawBall(ctx, { x: M.player.x + 0.25, y: M.player.y, z: z }) });
    }
    if (M.phase === 'oppToss') {
      const k = M.phaseT / M.phaseDur;
      items.push({ y: M.opp.y + 0.01, draw: () => drawBall(ctx, { x: M.opp.x - 0.25, y: M.opp.y, z: 1.8 + Math.sin(k * Math.PI) * 1.4 }) });
    }
    const pbBall = preServeBall();
    // Drawn just after the server, so the bouncing hand never hides the ball
    if (pbBall) items.push({ y: pbBall.who.y - 0.02, draw: () => drawBall(ctx, pbBall) });
    updatePigeon();
    if (M.pigeon) items.push({ y: M.pigeon.y, draw: () => drawPigeon(ctx) });
    const rb = rolledBall();
    if (rb) items.push({ y: rb.y, draw: () => drawBall(ctx, rb) });
    items.sort((a, b) => b.y - a.y).forEach((it) => it.draw());
    if (royalActive()) drawRoyalFlight(ctx);
    drawSparks(ctx);

    // Timing ring and contact marker on an incoming ball
    if (s && s.hitter === 1 && !s.resolved && !s.dead && M.phase === 'rally') {
      const until = s.tc - s.t;
      if (until < 1.1) {
        const cp = shotPos(s, s.tc);
        const g0 = proj(cp.x, cp.y, 0);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(g0.x, g0.y, 0.35 * g0.s, 0.1 * g0.s, 0, 0, Math.PI * 2);
        ctx.stroke();
        const bpp = proj(bp.x, bp.y, bp.z);
        // Sized on screen, not on court: the broadcast camera's zoom must not blow the ring up
        const zc = M.cam && M.cam.z ? M.cam.z : 1;
        const r = (10 + Math.max(0, until) * 110) / zc;
        const inWin = Math.abs(until) <= swingWindow();
        const sweet = Math.abs(until) <= 0.06 * timingHelp();
        ctx.strokeStyle = sweet ? '#d9f24a' : inWin ? '#f4f1e6' : 'rgba(244,241,230,0.4)';
        ctx.lineWidth = (sweet ? 5 : 3) / zc;
        ctx.beginPath();
        ctx.arc(bpp.x, bpp.y, r, 0, Math.PI * 2);
        ctx.stroke();
        const ls = M.tut && !M.tut.practice ? tutStep() : null;
        if (ls && ls.id === 'charge' && ((M.tut.feeds || 0) <= 3 || M.tut.count === 0)) {
          const held = M.touch.down || M.keyDown;
          const cue = !held ? (until > 0.25 ? 'PRESS AND HOLD' : '') : inWin ? 'NOW LET GO!' : 'HOLD...';
          if (cue) {
            ctx.save();
            ctx.font = '30px "Lilita One", Impact, sans-serif';
            ctx.textAlign = 'center';
            ctx.lineWidth = 7;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#0b0b0b';
            const cy = clamp(bpp.y - r - 26, 150, H - 140);
            ctx.strokeText(cue, bpp.x, cy);
            ctx.fillStyle = inWin && held ? '#d9f24a' : '#f4f1e6';
            ctx.fillText(cue, bpp.x, cy);
            ctx.restore();
          }
        }
      }
    }

    // Aim reticle. It shakes with rage, and that is where the ball actually goes.
    const showRet = M.phase === 'serveReady' || M.phase === 'serveAim' || (M.phase === 'rally' && s && s.hitter === 1 && !s.resolved);
    if (showRet) {
      const ret = currentReticle();
      const p = proj(ret.x, ret.y, 0);
      const serving = M.phase !== 'rally';
      const area = serving ? serviceBox(1, isDeuceSide()) : courtHalf(1);
      const good = inBox(ret, area);
      const col = good ? (M.rage > 0.7 ? '#ffb03a' : '#d9f24a') : '#ff3b30';
      const rr = Math.max(9, 0.45 * p.s);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * 0.38, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - rr * 1.4, p.y);
      ctx.lineTo(p.x - rr * 0.5, p.y);
      ctx.moveTo(p.x + rr * 0.5, p.y);
      ctx.lineTo(p.x + rr * 1.4, p.y);
      ctx.moveTo(p.x, p.y - rr * 0.7);
      ctx.lineTo(p.x, p.y - rr * 0.2);
      ctx.stroke();
      // Wind preview: where the ball will actually land if hit cleanly at the reticle
      if (M.cfg.wind) {
        const estMph = serving ? Math.min(150, (75 + 40.4 * (M.phase === 'serveAim' ? M.power : 0.6)) * (1 + 0.3 * M.rage)) : 67 * (1 + 0.3 * M.rage);
        const from = serving ? { x: M.player.x, y: M.player.y } : (s ? shotPos(s, s.tc) : M.player);
        const land = { x: ret.x + windDrift(flightTime(from, ret, estMph)), y: ret.y };
        const lp = proj(land.x, land.y, 0);
        const landIn = inBox(land, area);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#9fe7ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(lp.x, lp.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = landIn ? '#9fe7ff' : '#ff3b30';
        ctx.beginPath();
        ctx.ellipse(lp.x, lp.y, rr * 0.35, rr * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (charging()) {
        const c = chargeLevel();
        ctx.strokeStyle = c >= 1 ? '#ff8a3a' : '#f4f1e6';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rr * 1.5, rr * 0.6, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c);
        ctx.stroke();
      }
      ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      if (!good) {
        ctx.fillStyle = '#ff3b30';
        ctx.fillText('OUT', p.x, p.y - rr * 0.9);
      } else if (!serving) {
        // What a plain release will play. Flicks override it.
        const t = shotTypeFor(0);
        const shaky = TOUCH[t] && M.rage > 0.55;
        ctx.fillStyle = shaky ? '#ff8a80' : SPIN[t].color;
        ctx.fillText(SPIN[t].label + (shaky ? ' (SHAKY HANDS)' : '') + (aimShort() ? '  \u2193 DROP' : ''), p.x, p.y - rr * 0.9);
      }
    }

    // Particles: steam and racket shards
    M.parts.forEach((pt) => {
      const a = 1 - pt.t / pt.life;
      if (pt.kind === 'dust') {
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = a * 0.7;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * (1 + pt.t * 1.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (pt.kind === 'steam') {
        ctx.fillStyle = 'rgba(240,240,240,' + (a * 0.45).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * (1 + pt.t), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(pt.t * pt.spin);
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = a;
        ctx.fillRect(-pt.r, -pt.r * 0.3, pt.r * 2, pt.r * 0.6);
        ctx.restore();
      }
    });

    // Speech bubbles
    // In a close up the umpire's chair is out of shot, so the umpire speaks through a subtitle instead
    if (M.speech && !(M.speech.who === 'ump' && M.cam.z > 1.3)) {
      const sp = M.speech;
      let x;
      let y;
      if (sp.who === 'opp' && M.oppHead) { x = M.oppHead.headX; y = M.oppHead.headY - 14; } else if (sp.who === 'you' && M.playerHead) { x = M.playerHead.headX; y = M.playerHead.headY - 14; } else { const u = proj(-7.3, C.net, 2.1); x = u.x + 10; y = u.y - 82; }
      const big = sp.who === 'opp' && GRUNTS.indexOf(sp.text) >= 0;
      ctx.font = (big ? 'bold 22px ' : 'bold 18px ') + '"Trebuchet MS", sans-serif';
      const lines = wrapText(ctx, sp.text, 320);
      const w = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)) + 22;
      const lh = big ? 26 : 22;
      const h = lines.length * lh + 12;
      let bx = clamp(x - (sp.who === 'opp' ? w / 2 : 20), 8, W - w - 8);
      // At a changeover the stats strap is on the left: the umpire speaks from beside it
      if (sp.who === 'ump' && M.tvStats) bx = Math.max(bx, (16 + 330) * Math.min(hudK(), 1.15) - HUD.l + 14);
      // The umpire's chair is under the score bug: the umpire speaks from just below it
      let by = sp.who === 'ump' || (sp.who !== 'opp' && sp.who !== 'you') ? Math.max(y - h, 150 * hudK() - HUD.t) : y - h;
      // The panels and the stamp are measured on the screen; the bubble is drawn through the camera, so map them into its space
      const zc = M.cam.z || 1;
      const toCam = (r) => ({ x0: (r.x0 - 640 - M.cam.x) / zc + 640, x1: (r.x1 - 640 - M.cam.x) / zc + 640, y0: (r.y0 - 360 - M.cam.y) / zc + 360, y1: (r.y1 - 360 - M.cam.y) / zc + 360 });
      const hits = (r) => by < r.y1 + 4 && by + h > r.y0 - 4 && bx < r.x1 + 4 && bx + w > r.x0 - 4;
      // The umpire never talks over the stamp: the bubble moves beside it, or below it if there is no room
      if (sp.who !== 'opp' && sp.who !== 'you' && M.callBox) {
        const S = toCam(M.callBox);
        if (hits(S)) {
          if (S.x0 - 8 - w >= 8) bx = Math.min(bx, S.x0 - 8 - w);
          else if (S.x1 + 8 + w <= W - 8) bx = Math.max(bx, S.x1 + 8);
          else by = S.y1 + 8;
        }
      }
      // A player's bubble never sits under the score panel, the title and wind panel, the sound and pause
      // buttons or the stamp: it drops below whatever it would hit, beside their head (the tail points back at them)
      if (sp.who === 'opp' || sp.who === 'you') {
        const blocks = [M.scoreHud, M.topHud, hudButtonsBox(), M.callBox].filter(Boolean).map(toCam);
        const tabH = sp.who === 'opp' ? 14 : 0;   // the name tab above the opponent's bubble
        for (let pass = 0; pass < 3; pass++) {
          const R = blocks.find((r) => by - tabH < r.y1 + 4 && by + h > r.y0 - 4 && bx < r.x1 + 4 && bx + w > r.x0 - 4);
          if (!R) break;
          by = R.y1 + 6 + tabH;
          bx = x + 22 + w <= W - 8 ? x + 22 : Math.max(8, x - 22 - w);
        }
      }
      const pop = Math.min(1, sp.t * 8);
      ctx.save();
      ctx.globalAlpha = Math.min(1, (sp.dur - sp.t) * 4);
      // The tail points at the speaker: up if the bubble had to drop below them. A bubble moved off to the side
      // of the speaker gets a long pointer from its near edge to their mouth, so it never seems to come from the crowd.
      const below = by > y - h + 1;
      const dy = (1 - pop) * 8;
      const tail = (() => {
        if ((sp.who === 'opp' || sp.who === 'you') && (x < bx + 4 || x > bx + w - 4)) {
          const ex = x < bx ? bx + 1 : bx + w - 1;
          const mid = clamp(y + 16 - dy, by + h * 0.3, by + h * 0.7) + dy;
          return [[ex, mid - 8], [x + (ex > x ? 9 : -9), y + 18], [ex, mid + 8]];
        }
        const tx = clamp(x, bx + 10, bx + w - 10);
        const ty0 = (below ? by : by + h) + dy;
        return [[tx - 7, ty0], [tx, ty0 + (below ? -11 : 11)], [tx + 7, ty0]];
      })();
      const bubblePath = () => roundRect(ctx, bx, by + dy, w, h, 8);
      const tailPath = () => { ctx.beginPath(); ctx.moveTo(tail[0][0], tail[0][1]); ctx.lineTo(tail[1][0], tail[1][1]); ctx.lineTo(tail[2][0], tail[2][1]); ctx.closePath(); };
      // A dark outline round the bubble and its tail, as round every figure, so it stands off the crowd behind
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      bubblePath(); ctx.stroke();
      tailPath(); ctx.stroke();
      ctx.fillStyle = big ? '#ffefc2' : '#f4f1e6';
      bubblePath(); ctx.fill();
      tailPath(); ctx.fill();
      // The speaker's name on a caption tab, as on TV
      const who = sp.who === 'opp' ? tvName(M.cfg.opp.name) : null;
      if (who) {
        ctx.font = '14px "Lilita One", Impact, sans-serif';
        const nw = ctx.measureText(who).width + 14;
        hudPanel(ctx, bx + 8, by + dy - 13, nw, 18, 5, '#c8102e');
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(who, bx + 15, by + dy - 4);
        ctx.font = (big ? 'bold 22px ' : 'bold 18px ') + '"Trebuchet MS", sans-serif';
      }
      ctx.fillStyle = big ? '#b3261e' : '#10261a';
      ctx.textAlign = 'center';
      // Centred both ways in the bubble
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => ctx.fillText(l, bx + w / 2, by + h / 2 + 1 + (i - (lines.length - 1) / 2) * lh + (1 - pop) * 8));
      ctx.restore();
    }
    ctx.restore();
    drawGrade(ctx);
    // A thrown racket incident cuts away like TV: no scoreboard over the landing site
    // The meltdown is a cut away: no scoreboard or meters, just you, the thoughts and the stamp
    if (FSM.name !== 'MELTDOWN_MINIGAME' && !CINEMA) { drawHUD(ctx); drawRacketOdds(ctx); } else M.callBox = null;
    drawStinger(ctx);
  }

  const POINT_NAMES = ['0', '15', '30', '40'];
  // Who runs the match: an umpire in the chair, or at the smaller events a referee
  function officialTitle(cfg) {
    const V = VENUES[venueKey(cfg || M.cfg)];
    return V && V.chair ? 'Umpire' : 'Referee';
  }
  // Who calls the lines. players: the opponent calls your shots and there is nothing to review.
  // umpire: the chair calls them, sometimes wrongly, and you may challenge. electronic: always right.
  // The Tea Hut Lesson uses umpire rules so that Derek can teach challenges.
  function callMode(cfg) {
    cfg = cfg || M.cfg;
    if (cfg.mode === 'tutorial') return 'umpire';
    return VENUES[venueKey(cfg)].calls;
  }
  function challengesOn() {
    return callMode() === 'umpire';
  }
  function pointLabel(i) {
    const a = M.points[i];
    const b = M.points[1 - i];
    if (M.tiebreak) return String(a);
    if (a >= 3 && b >= 3) return a > b ? 'AD' : a === b ? '40' : '';
    return POINT_NAMES[Math.min(3, a)];
  }
  function scoreStatus() {
    if (M.tiebreak) return 'TIEBREAK';
    const a = M.points[0];
    const b = M.points[1];
    if (a >= 3 && b >= 3) return a === b ? 'DEUCE' : a > b ? 'ADVANTAGE YOU' : 'ADVANTAGE ' + tvName(M.cfg.opp.name);
    // Momentum, when nothing bigger is happening
    if ((M.streak || 0) >= 3) return 'ON A ROLL: ' + M.streak + ' IN A ROW';
    if ((M.streak || 0) <= -3) return M.cfg.opp.name.split(' ').pop().toUpperCase() + ': ' + -M.streak + ' IN A ROW';
    return '';
  }

  /* ---- Broadcast graphics: the changeover stats strap and the replay stinger ---- */
  const TV = { statsHold: 6.5, stingerLen: 0.7 };
  function drawBroadcast(ctx) {
    const st = M.tvStats;
    if (st && !M.tut) {
      const age = M.time - st.t;
      const showing = age < TV.statsHold && !/rally|serveAim/.test(M.phase) && M.phase !== 'highlight' && M.phase !== 'matchOver';
      if (!showing && age > 1.6) M.tvStats = null;
      else if (showing && age > 0.9) {
        // Slides in from the left under the score bug, and out again
        const a = age - 0.9;
        const inK = reduceMotion ? 1 : Math.min(1, a / 0.35);
        const outK = reduceMotion ? 1 : Math.min(1, (TV.statsHold - 0.9 - a) / 0.35);
        const e = 1 - Math.pow(1 - Math.min(inK, outK), 3);
        const K = hudK();
        ctx.save();
        ctx.translate(-HUD.l, -HUD.t);
        ctx.scale(Math.min(K, 1.15), Math.min(K, 1.15));
        ctx.translate(-360 * (1 - e), 0);
        ctx.globalAlpha = e;
        const x = 16;
        const y = 140;
        const w = 330;
        const S = M.stats;
        const O = M.ostats || { aces: 0, winners: 0, errors: 0 };
        const rows = [['ACES', S.aces, O.aces], ['WINNERS', S.winners, O.winners], ['ERRORS', S.errors, O.errors], ['PERFECT HITS', perfectPct(S) + '%', '-'], ['LINES PAINTED', S.lines || 0, '-'], ['POINTS WON', S.pointsWon, S.pointsLost], ['TANTRUMS', M.smashed || 0, M.oppLostCount || 0]];
        const h = 50 + rows.length * 26;
        hudPanel(ctx, x, y, w, h, 12);
        ctx.fillStyle = '#d9f24a';
        roundRect(ctx, x, y, w, 34, 12);
        ctx.fill();
        ctx.fillRect(x, y + 20, w, 14);
        ctx.fillStyle = '#10261a';
        ctx.font = '19px "Lilita One", Impact, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('MATCH STATS', x + 14, y + 18);
        ctx.textAlign = 'right';
        ctx.font = '16px "Lilita One", Impact, sans-serif';
        ctx.fillText(myTv(), x + w - 84, y + 18, 62);
        ctx.fillText(tvName(M.cfg.opp.name), x + w - 14, y + 18, 62);
        rows.forEach((r, i) => {
          const yy = y + 52 + i * 26;
          if (i % 2) { ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + 6, yy - 12, w - 12, 24); }
          ctx.textAlign = 'left';
          ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
          ctx.fillStyle = 'rgba(244,241,230,0.82)';
          ctx.fillText(r[0], x + 14, yy);
          ctx.textAlign = 'right';
          ctx.font = '20px "Lilita One", Impact, sans-serif';
          const better = r[0] === 'ERRORS' || r[0] === 'TANTRUMS' ? r[1] < r[2] : r[1] > r[2];
          ctx.fillStyle = better ? '#d9f24a' : '#f4f1e6';
          ctx.fillText(String(r[1]), x + w - 84, yy + 1);
          ctx.fillStyle = '#f4f1e6';
          ctx.fillText(String(r[2]), x + w - 14, yy + 1);
        });
        ctx.restore();
      }
    }
  }
  // The replay stinger: a band in the tour colours sweeps across everything, the ball logo spinning in it
  function drawStinger(ctx) {
    const sg = M && M.stinger;
    if (sg && !reduceMotion) {
      const k = (M.time - sg.t) / TV.stingerLen;
      if (k >= 1) M.stinger = null;
      else if (k >= 0) {
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const cx = lerp(-500, W + 500, e);
        ctx.save();
        ctx.translate(cx, H / 2);
        ctx.rotate(-0.22);
        [['#06110a', 330], ['#d9f24a', 270], ['#10261a', 200]].forEach((b) => {
          ctx.fillStyle = b[0];
          ctx.fillRect(-b[1] / 2, -H, b[1], H * 2);
        });
        ctx.rotate(0.22 + k * 9);
        ctx.fillStyle = '#d9f24a';
        ctx.strokeStyle = '#06110a';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(0, 0, 54, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#f4f1e6';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(-58, 0, 42, -0.9, 0.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(58, 0, 42, Math.PI - 0.9, Math.PI + 0.9);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
  // A HUD sticker: a solid panel with a thick dark outline, a drop shadow and a faint inner edge
  function hudPanel(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, x + 3, y + 5, w, h, r);
    ctx.fill();
    ctx.fillStyle = fill || '#173a26';
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = '#06110a';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(244,241,230,0.14)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x + 4, y + 4, w - 8, h - 8, Math.max(2, r - 3));
    ctx.stroke();
  }

  // The face on the rage meter: calm and pink, then red, gritted and steaming
  // Tale of the tape: you against them before the first point, like a boxing broadcast. Their numbers are
  // made up from their name, so the same opponent always has the same record.
  function drawTape(ctx, t) {
    const T0 = INTRO_TV.tape[0];
    const T1 = INTRO_TV.tape[1];
    if (t < T0 || t > T1) return;
    const k = Math.min(1, (t - T0) * 4, (T1 - t) * 4);
    const o = M.cfg.opp;
    const r = rivalRec(o.name);
    const hsh = fnv1a(o.name + ':tape');
    const tier = M.cfg.mode === 'career' ? M.cfg.tierIdx : 2;
    const theirSmash = 2 + (hsh % 9) * (1 + tier) + (o.traits.indexOf('grunter') >= 0 ? 3 : 0);
    const theirFines = (4 + (hsh >>> 4) % 40) * 1000 * (1 + tier);
    const rows = [
      ['HEAD TO HEAD', r ? String(r.w) : '0', r ? String(r.l) : '0'],
      ['RACKETS SMASHED', String(SAVE.stats.racketsSmashed || 0), String(theirSmash)],
      ['FINES PAID', money(SAVE.totalFines || 0), money(theirFines)],
      ['TEMPER', repLabel(SAVE.reputationScore), o.traits.length ? TRAIT_LABEL[o.traits[0]] : 'Unknown']
    ];
    // What the day brings: the Daily twist, or the court, or the grudge
    const foot = M.cfg.twist ? 'TODAY: ' + M.cfg.twist.name.toUpperCase() + '. ' + M.cfg.twist.line
      : M.cfg.surface && M.cfg.surface !== 'hard' && SURF_PLAY[M.cfg.surface] ? (M.cfg.surface === 'indoor' ? 'INDOOR' : M.cfg.surface.toUpperCase()) + ' COURT. ' + SURF_PLAY[M.cfg.surface].note
        : r && r.last === 'l' ? 'They beat you last time. The camera knows.' : r ? 'You beat them last time. They remember.' : 'First meeting. No history. Yet.';
    const x = 640 - 360;
    const y = 120 + (1 - k) * 30;
    ctx.save();
    ctx.globalAlpha = k;
    hudPanel(ctx, x, y, 720, 250, 14, '#10261a');
    hudPanel(ctx, 640 - 120, y - 16, 240, 34, 8, '#c8102e');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '22px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('TALE OF THE TAPE', 640, y + 1);
    // Portraits and names at either side
    const pics = M.strapPics || {};
    [[pics.you, myTv(), x + 70, '#d9f24a'], [pics.opp, tvName(o.name), x + 650, '#ff8a80']].forEach((p) => {
      ctx.save();
      roundRect(ctx, p[2] - 46, y + 34, 92, 92, 10);
      ctx.fillStyle = '#0b1f14';
      ctx.fill();
      ctx.clip();
      if (p[0]) ctx.drawImage(p[0], p[2] - 46, y + 34, 92, 92);
      ctx.restore();
      ctx.strokeStyle = p[3];
      ctx.lineWidth = 3;
      roundRect(ctx, p[2] - 46, y + 34, 92, 92, 10);
      ctx.stroke();
      ctx.font = '20px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = p[3];
      fitCanvasText(ctx, p[1], 130, 20, '"Lilita One", Impact, sans-serif');
      ctx.fillText(p[1], p[2], y + 146);
    });
    rows.forEach((row, i) => {
      const ry = y + 52 + i * 34;
      if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(x + 140, ry - 15, 440, 30); }
      ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
      ctx.fillStyle = 'rgba(244,241,230,0.7)';
      ctx.fillText(row[0], 640, ry);
      ctx.font = '22px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#d9f24a';
      fitCanvasText(ctx, row[1], 120, 22, '"Lilita One", Impact, sans-serif');
      ctx.fillText(row[1], 640 - 96, ry);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ff8a80';
      ctx.font = '22px "Lilita One", Impact, sans-serif';
      fitCanvasText(ctx, row[2], 120, 22, '"Lilita One", Impact, sans-serif');
      ctx.fillText(row[2], 640 + 96, ry);
      ctx.textAlign = 'center';
    });
    ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f4f1e6';
    const lines = wrapText(ctx, foot, 640);
    lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, 640, y + 200 + i * 22 + (lines.length === 1 ? 11 : 0)));
    ctx.font = 'bold 12px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(244,241,230,0.5)';
    ctx.fillText(ctl('skip'), 640, y + 234);
    ctx.restore();
  }
  // Racket survival odds: a TV graphic when your temper crosses into the red zones, ticking down as it climbs.
  // Shown between points only, never over a rally.
  const RACKET_ODDS = { at: [0.6, 0.85], hold: 3.2 };
  function racketOdds() {
    return clamp(Math.round(100 * (1 - Math.pow(M.rage, 1.6)) - 6 * (M.smashed || 0)), 3, 97);
  }
  function drawRacketOdds(ctx) {
    const R = M.oddsTV;
    if (!R || M.tut) return;
    const age = M.time - R.t;
    if (age > RACKET_ODDS.hold) { M.oddsTV = null; return; }
    const k = Math.min(1, age * 5, (RACKET_ODDS.hold - age) * 4);
    const target = racketOdds();
    R.shown = R.shown === undefined ? R.from : R.shown + (target - R.shown) * 0.12;
    const v = Math.round(R.shown);
    const x = 16 - HUD.l - (1 - k) * 240;
    const y = (M.scoreHud ? M.scoreHud.y1 : 120) + 12;
    ctx.save();
    ctx.globalAlpha = k;
    hudPanel(ctx, x, y, 270, 74, 10, '#10261a');
    ctx.fillStyle = v < 30 ? '#ff3b30' : v < 60 ? '#ffb03a' : '#d9f24a';
    ctx.fillRect(x, y, 8, 74);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(244,241,230,0.85)';
    ctx.fillText('RACKET SURVIVAL', x + 20, y + 18);
    ctx.font = '36px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = v < 30 ? '#ff6a5f' : '#f4f1e6';
    ctx.fillText(v + '%', x + 20, y + 48);
    ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(244,241,230,0.8)';
    ctx.fillText(R.line, x + 96, y + 48);
    ctx.restore();
  }
  function drawRageFace(ctx, x, y, r, rage, t) {
    const shake = rage > 0.85 && !reduceMotion ? Math.sin(t * 50) * 1.5 : 0;
    x += shake;
    // Your own skin tone, flushing red as the rage climbs
    const own = (SAVE.player && SAVE.player.skin) || '#e7b892';
    const flush = rage < 0.5 ? 0 : rage < 0.85 ? 0.45 : 0.8;
    const mixC = (a, b, k) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.substr(i, 2), 16) * (1 - k) + parseInt(b.substr(i, 2), 16) * k).toString(16).padStart(2, '0')).join('');
    const skin = mixC(own, '#ff4b3a', flush);
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Brows: flat when calm, a deep V when furious
    const v = clamp((rage - 0.2) / 0.7, 0, 1) * r * 0.22;
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y - r * 0.36 - v * 0.2);
    ctx.lineTo(x - r * 0.15, y - r * 0.32 + v);
    ctx.moveTo(x + r * 0.55, y - r * 0.36 - v * 0.2);
    ctx.lineTo(x + r * 0.15, y - r * 0.32 + v);
    ctx.stroke();
    ctx.fillStyle = '#2a1a10';
    [-1, 1].forEach((s) => { ctx.beginPath(); ctx.arc(x + s * r * 0.33, y - r * 0.08, r * 0.09, 0, Math.PI * 2); ctx.fill(); });
    // Mouth: a smile, a line, then gritted teeth
    if (rage < 0.35) {
      ctx.beginPath();
      ctx.arc(x, y + r * 0.2, r * 0.32, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else if (rage < 0.7) {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.3, y + r * 0.42);
      ctx.lineTo(x + r * 0.3, y + r * 0.42);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(x - r * 0.4, y + r * 0.3, r * 0.8, r * 0.26);
      ctx.strokeStyle = '#2a1a10';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - r * 0.4, y + r * 0.3, r * 0.8, r * 0.26);
      for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x - r * 0.4 + i * r * 0.2, y + r * 0.3); ctx.lineTo(x - r * 0.4 + i * r * 0.2, y + r * 0.56); ctx.stroke(); }
    }
    // Steam from the ears above 70%
    if (rage >= 0.7) {
      ctx.fillStyle = 'rgba(240,240,240,0.7)';
      [-1, 1].forEach((s) => {
        for (let i = 0; i < 2; i++) {
          const ph = (((t * 1.6 + i * 0.5) % 1) + 1) % 1;
          ctx.beginPath();
          ctx.arc(x + s * (r + 3 + ph * 6), y - r * 0.1 - ph * 16, 3 + ph * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
  }

  // The big point strap: what is at stake, and how it has gone today
  function drawBigStrap(ctx, B) {
    const a = clamp((M.time - B.shown) * 4, 0, 1);
    const slide = (1 - a) * 30;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '30px "Lilita One", Impact, sans-serif';
    const tw = ctx.measureText(B.title).width;
    ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
    const lw = ctx.measureText(B.line).width;
    const w = Math.max(tw, lw) + 56;
    const x = 640 - w / 2;
    const y = 498 + slide;
    hudPanel(ctx, x, y, w, 70, 10, '#0f2a1b');
    ctx.fillStyle = B.good ? '#d9f24a' : '#ff3b30';
    ctx.fillRect(x, y + 8, 6, 54);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '30px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = B.good ? '#d9f24a' : '#ff8a80';
    ctx.fillText(B.title, 640 + 3, y + 25);
    ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f4f1e6';
    ctx.fillText(B.line, 640 + 3, y + 53);
    ctx.restore();
  }
  function drawHUD(ctx) {
    ctx.textBaseline = 'middle';
    // Pressure point: the edges pulse with your heartbeat, and slow motion brings in cinema bars
    if (M.rage >= 0.85 && !M.bigPoint && FSM.name === 'MATCH_PLAY' && M.phase !== 'matchOver') {
      const beat = reduceMotion ? 0.5 : Math.pow(Math.max(0, Math.sin(M.time * 7.3)), 6);
      const k = (M.rage - 0.85) / 0.15;
      const vg = ctx.createRadialGradient(640, 360, 320, 640, 360, 780);
      vg.addColorStop(0, 'rgba(255,0,0,0)');
      vg.addColorStop(1, 'rgba(220,20,20,' + (0.1 + 0.22 * k * beat).toFixed(2) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    }
    if (M.bigPoint && M.phase !== 'matchOver') {
      const beat = Math.pow(Math.max(0, Math.sin(M.time * 7.3)), 6);
      const vg = ctx.createRadialGradient(640, 360, 300, 640, 360, 780);
      vg.addColorStop(0, 'rgba(255,0,0,0)');
      vg.addColorStop(1, 'rgba(200,16,46,' + (0.12 + 0.18 * beat).toFixed(2) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    }
    if (M.timeScale < 0.97) {
      const bar = (1 - M.timeScale) / 0.55 * 44;
      ctx.fillStyle = '#000';
      ctx.fillRect(-BX, -BY, W + 2 * BX, bar + BY);
      ctx.fillRect(-BX, H - bar, W + 2 * BX, bar + BY);
    }
    // Movement stick
    if (M.phase === 'rally' || M.phase === 'pointOver' || M.phase === 'prePoint') {
      const st = M.stick;
      if (st.active) {
        ctx.strokeStyle = 'rgba(244,241,230,0.4)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(st.ox, st.oy, 62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(244,241,230,0.45)';
        ctx.beginPath();
        ctx.arc(st.ox + st.vx * 56, st.oy - st.vy * 56, 26, 0, Math.PI * 2);
        ctx.fill();
      } else if (M.phase === 'rally' && !M.stickUsed && INPUT.kind === 'touch') {
        ctx.strokeStyle = 'rgba(244,241,230,0.14)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(190, 470, 56, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
        ctx.fillStyle = 'rgba(244,241,230,0.34)';
        ctx.textAlign = 'center';
        ctx.fillText('MOVE', 190, 480);
        ctx.beginPath();
        ctx.moveTo(190, 432);
        ctx.lineTo(180, 446);
        ctx.lineTo(200, 446);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
        ctx.fillText('NET', 190, 460);
      }
    }
    drawBroadcast(ctx);
    // Scoreboard, top left: a TV score bug, with a tab underneath for the set or the moment.
    // LIGHT: the panels at 80% so the court shows; Large text keeps them near full size (92%).
    const LIGHT = SAVE.settings.text === 'large' ? 0.92 : 0.8;
    const KB = hudK() * LIGHT;
    // The top row shares the width: the bug and the strap grow only as far as they fit side by side
    const KT = Math.max(1, Math.min(hudK(), (640 - 14 - 16 + HUD.l) / (400 + 190))) * LIGHT;
    // In a rally only what you play by stays up: the score, the wind, the rage bar, the rackets. The rest
    // (the event and umpire, the match format, the meter's labels) fades back in once the point is over.
    const inRally = M.phase === 'rally' && !M.tut;
    M.calmA = (M.calmA === undefined ? 1 : M.calmA) + ((inRally ? 0 : 1) - (M.calmA === undefined ? 1 : M.calmA)) * 0.15;
    const calmA = M.calmA;
    // Kept clear of rounded screen corners: a fixed inset (game units) that does not shrink with the panels
    const CORNER = { x: 14, y: 8 };
    ctx.save();
    ctx.translate(-HUD.l + CORNER.x, -HUD.t + CORNER.y);
    ctx.scale(KT, KT);
    const sx = 16;
    const sy = 12;
    const status = scoreStatus();
    const tabText = status || (M.tut ? 'PRACTICE  ·  NOTHING COUNTS' : 'FIRST TO ' + M.cfg.games + ', BY 2  ·  TIEBREAK AT ' + M.cfg.games + '-' + M.cfg.games);
    ctx.font = '18px "Lilita One", Impact, sans-serif';
    const tabW = ctx.measureText(tabText).width + 26;
    ctx.save();
    if (!status) ctx.globalAlpha = calmA;
    if (M.tut) ctx.globalAlpha = 0;
    hudPanel(ctx, sx + 14, sy + 66, tabW, 32, 8, status ? '#d9f24a' : '#0f2a1b');
    ctx.textAlign = 'left';
    ctx.fillStyle = status ? '#10261a' : 'rgba(244,241,230,0.8)';
    ctx.fillText(tabText, sx + 27, sy + 86);
    ctx.restore();
    let lostRow = 0;
    if (M.oppLost) {
      ctx.font = '16px "Lilita One", Impact, sans-serif';
      const lw2 = ctx.measureText('THEY HAVE LOST IT').width + 26;
      // Beside the score tab when both fit; when a long one (ON A ROLL, ADVANTAGE) is up, on its own row underneath
      lostRow = sx + 14 + tabW + 8 > sx + 400 - 14 - lw2 ? 30 : 0;
      const lx = lostRow ? sx + 14 : sx + 400 - 14 - lw2;
      hudPanel(ctx, lx, sy + 66 + lostRow, lw2, 30, 8, Math.sin(M.time * 12) > 0 ? '#ff3b30' : '#c8102e');
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText('THEY HAVE LOST IT', lx + 13, sy + 86 + lostRow);
    }
    hudPanel(ctx, sx, sy, 400, 76, 12);
    M.scoreHud = { x0: (sx - 4) * KT - HUD.l + CORNER.x, x1: (sx + 404) * KT - HUD.l + CORNER.x, y0: 0, y1: (sy + 100 + lostRow) * KT - HUD.t + CORNER.y };
    const rows = [[myTv(), 0], [M.tut ? M.cfg.opp.name.toUpperCase() : tvName(M.cfg.opp.name), 1]];
    rows.forEach((r, i) => {
      const y = sy + 21 + i * 34;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      roundRect(ctx, sx + 8, y - 14, 268, 28, 6);
      ctx.fill();
      // Server: a ball by their name
      if (M.server === r[1]) {
        ctx.fillStyle = '#d9f24a';
        ctx.strokeStyle = '#06110a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx + 21, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#f4f1e6';
      ctx.font = '21px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'left';
      let name = r[0];
      const maxName = i === 1 && !M.tut ? 172 : 230;
      while (ctx.measureText(name).width > maxName && name.length > 4) name = name.slice(0, -2);
      ctx.fillText(name, sx + 34, y + 1);
      // Games in a box, points in yellow
      hudPanel(ctx, sx + 284, y - 14, 44, 28, 6, '#0b1d12');
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f4f1e6';
      ctx.font = '22px "Lilita One", Impact, sans-serif';
      ctx.fillText(String(M.games[r[1]]), sx + 306, y + 1);
      // A score that has just changed pops, like a TV bug ticking over
      const pk = pointLabel(r[1]) + '/' + M.games[r[1]];
      M.scoreSeen = M.scoreSeen || [null, null];
      if (M.scoreSeen[r[1]] !== pk) { if (M.scoreSeen[r[1]] !== null) (M.scorePop = M.scorePop || [0, 0])[r[1]] = M.time; M.scoreSeen[r[1]] = pk; }
      const pa = reduceMotion || !M.scorePop ? 1 : M.time - M.scorePop[r[1]];
      const pop = pa < 0.45 ? 1 + 0.45 * Math.sin(pa / 0.45 * Math.PI) * (1 - pa / 0.45) : 1;
      ctx.save();
      ctx.translate(sx + 364, y + 1);
      ctx.scale(pop, pop);
      ctx.fillStyle = pa < 0.15 ? '#ffffff' : '#d9f24a';
      ctx.font = '24px "Lilita One", Impact, sans-serif';
      ctx.fillText(pointLabel(r[1]), 0, 0);
      ctx.restore();
    });
    if (!M.tut) {
      // Their temper: five pips by their name, filling orange to red; all flashing when they lose it
      const shake = M.oppTempFx > 0 && !reduceMotion ? Math.sin(M.time * 60) * 2 * M.oppTempFx : 0;
      const y = sy + 55;
      for (let i = 0; i < 5; i++) {
        const x = sx + 216 + i * 12 + shake;
        const fill = clamp(M.oppTemp * 5 - i, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.arc(x, y, 4.6, 0, Math.PI * 2);
        ctx.fill();
        if (fill > 0 || M.oppLost) {
          ctx.globalAlpha = M.oppLost ? (Math.sin(M.time * 12) > 0 ? 1 : 0.5) : 0.35 + 0.65 * fill;
          ctx.fillStyle = M.oppLost || i >= 3 ? '#ff3b30' : '#ffb03a';
          ctx.beginPath();
          ctx.arc(x, y, 4.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();

    // Title, with the wind on a tab underneath. In a lesson, Coach Derek's card takes the top of the screen instead.
    ctx.save();
    ctx.translate(0, -HUD.t);
    ctx.translate(640, 0);
    ctx.scale(KT, KT);
    ctx.translate(-640, 0);
    if (!M.tut) {
    const wind = M.cfg.wind;
    const wy = 32 * (1 - calmA);   // how far the tab has risen into the title's place
    ctx.save();
    if (wind === 0) ctx.globalAlpha = calmA;
    ctx.translate(0, -wy);
    hudPanel(ctx, 562, 40, 156, 38, 8, '#0f2a1b');
    ctx.textAlign = 'center';
    ctx.font = '16px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = '#9fe7ff';
    if (wind === 0) ctx.fillText('NO WIND', 640, 64);
    else {
      // The words centred in the tab, the arrow beside them on the side the wind blows to
      const dir = wind > 0 ? 1 : -1;
      const label = 'WIND ' + Math.abs(wind) + ' MPH';
      const lw = ctx.measureText(label).width;
      const gap = 18;
      const cx = 640 - dir * gap / 2;
      ctx.fillText(label, cx, 64);
      ctx.beginPath();
      const ax = cx + dir * (lw / 2 + 8);
      ctx.moveTo(ax + dir * 8, 64);
      ctx.lineTo(ax - dir * 4, 57);
      ctx.lineTo(ax - dir * 4, 71);
      ctx.fill();
    }
    ctx.restore();
    // The event and the umpire: between points only (the wind tab under it stays)
    M.topHud = calmA > 0.3 || M.tut
      ? { x0: 640 + (450 - 640) * KT, x1: 640 + (830 - 640) * KT, y0: 0, y1: (M.tut ? 52 : 78) * KT - HUD.t }
      : { x0: 640 + (562 - 640) * KT, x1: 640 + (718 - 640) * KT, y0: 0, y1: (M.cfg.wind ? 46 : 0) * KT - HUD.t };
    if (calmA > 0.02 || M.tut) {
      ctx.save();
      if (!M.tut) ctx.globalAlpha = calmA;
      hudPanel(ctx, 450, 8, 380, 44, 12);
      // Centred in its panel whatever was drawn before it
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '18px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText(M.cfg.label.toUpperCase(), 640, 24);
      ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
      ctx.fillStyle = 'rgba(244,241,230,0.85)';
      ctx.fillText(officialTitle() + ' ' + M.cfg.ref + ', ' + strictLabel(M.cfg.strict), 640, 42);
      ctx.restore();
    }

    // Shot speed readout
    if (M.mphT > 0) {
      ctx.globalAlpha = Math.min(1, M.mphT * 2);
      ctx.font = '28px "Lilita One", Impact, sans-serif';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#0b0b0b';
      ctx.strokeText(Math.round(M.lastMph) + ' MPH', 640, 108);
      ctx.fillStyle = M.lastMph >= 130 ? '#ff6a5f' : '#f4f1e6';
      ctx.fillText(Math.round(M.lastMph) + ' MPH', 640, 108);
      ctx.globalAlpha = 1;
    }

    }
    ctx.restore();

    // Rage meter, bottom left: face, label, bar, and the number in its own place at the end
    ctx.save();
    ctx.translate(-HUD.l + CORNER.x, HUD.b - CORNER.y);
    ctx.translate(0, H);
    ctx.scale(KB, KB);
    ctx.translate(0, -H);
    const px0 = 20;
    const rx = 76;     // the bar starts after the face
    const ry = 644;
    const rw = 262;    // and stops short of the number
    const rh = 28;
    const flick = M.rage > 0.8 ? (Math.sin(M.time * 30) * 0.5 + 0.5) : 0;
    // Face, RAGE and the pace on top, the bar with its colour ruler, the number with room to breathe
    const pw = 410;
    const nx = px0 - 6 + pw - 14;   // right edge for the number and the pace
    hudPanel(ctx, px0 - 6, ry - 34, pw, 86, 12);
    drawRageFace(ctx, px0 + 23, ry + rh / 2 - 1, 26, M.rage, M.time);
    ctx.textAlign = 'left';
    ctx.font = '20px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = M.rage > 0.8 ? '#ff3b30' : '#f4f1e6';
    ctx.fillText('RAGE', rx, ry - 13);
    ctx.textAlign = 'right';
    if (M.bigPoint) {
      ctx.font = '16px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = '#ff6a5f';
      ctx.fillText('PRESSURE x1.5', nx, ry - 13);
    } else {
      ctx.font = 'bold 14px "Trebuchet MS", sans-serif';
      ctx.fillStyle = 'rgba(244,241,230,' + (0.8 * calmA).toFixed(2) + ')';
      ctx.fillText('+' + Math.round(M.rage * 30) + '% PACE', nx, ry - 13);
    }
    // The number, big, at the end
    ctx.font = '26px "Lilita One", Impact, sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#06110a';
    ctx.strokeText(Math.round(M.rage * 100) + '%', nx, ry + rh / 2 + 1);
    ctx.fillStyle = M.rage >= 0.85 ? '#ff3b30' : M.rage >= 0.5 ? '#ffb03a' : '#f4f1e6';
    ctx.fillText(Math.round(M.rage * 100) + '%', nx, ry + rh / 2 + 1);
    // When rage rises the bar jumps: it swells, shudders, and the new chunk flashes white
    const jump = reduceMotion ? 0 : M.rageFx.jump;
    ctx.save();
    if (jump > 0) {
      const sw = 1 + 0.14 * jump * Math.abs(Math.sin(jump * Math.PI * 2.5));
      ctx.translate(rx + rw / 2 + Math.sin(M.time * 70 + jump * 40) * 5 * jump, ry + rh / 2 - 6 * jump);
      ctx.scale(sw, sw);
      ctx.translate(-(rx + rw / 2), -(ry + rh / 2));
    }
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(ctx, rx, ry, rw, rh, 6);
    ctx.fill();
    ctx.strokeStyle = '#06110a';
    ctx.lineWidth = 2;
    ctx.stroke();
    const grad = ctx.createLinearGradient(rx, 0, rx + rw, 0);
    grad.addColorStop(0, '#5fd068');
    grad.addColorStop(0.5, '#ffb03a');
    grad.addColorStop(1, '#ff3b30');
    ctx.fillStyle = grad;
    roundRect(ctx, rx, ry, Math.max(6, rw * M.rage), rh, 6);
    ctx.fill();
    if (flick) {
      ctx.fillStyle = 'rgba(255,255,255,' + (flick * 0.25).toFixed(2) + ')';
      roundRect(ctx, rx, ry, rw * M.rage, rh, 6);
      ctx.fill();
    }
    if (M.rageFx.jump > 0 && M.rage > M.rageFx.from) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * M.rageFx.jump).toFixed(2) + ')';
      ctx.fillRect(rx + rw * M.rageFx.from, ry, rw * (M.rage - M.rageFx.from), rh);
    }
    // The zones as a coloured ruler under the bar: amber for shaky aim, orange for steam, red for the red racket
    [[0.5, 0.7, '#ffd23a'], [0.7, 0.85, '#ff9a2e'], [0.85, 1, '#ff3b30']].forEach((z) => {
      ctx.fillStyle = z[2];
      ctx.globalAlpha = M.rage >= z[0] ? 1 : 0.55;
      ctx.fillRect(rx + rw * z[0] + 1, ry + rh + 4, rw * (z[1] - z[0]) - 2, 6);
      ctx.globalAlpha = 1;
    });
    // Where things change (shaky aim, steam, the red racket): ticks on the bar; the ruler names them by colour
    [0.5, 0.7, 0.85].forEach((z) => {
      const x = rx + rw * z;
      ctx.fillStyle = M.rage >= z ? 'rgba(16,38,26,0.8)' : 'rgba(244,241,230,0.6)';
      ctx.fillRect(x - 1, ry, 2, 7);
      ctx.fillRect(x - 1, ry + rh - 7, 2, 7);
    });
    ctx.restore();
    // One more and it goes
    if (M.rage >= 0.92 && FSM.name === 'MATCH_PLAY' && (Math.sin(M.time * 9) > -0.3 || reduceMotion)) {
      ctx.font = '20px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText('ONE MORE AND IT GOES', px0 + 186, ry - 46);
      ctx.fillStyle = '#ff3b30';
      ctx.fillText('ONE MORE AND IT GOES', px0 + 186, ry - 46);
    }

    ctx.restore();

    // Racket bag and code violations, bottom right, the same size as the rage meter
    const KR = KB;
    ctx.save();
    ctx.translate(HUD.r - CORNER.x, HUD.b - CORNER.y);
    ctx.translate(W, H);
    ctx.scale(KR, KR);
    ctx.translate(-W, -H);
    const n = Math.max(M.cfg.maxRackets, M.rackets);
    // Wide enough for both labels side by side
    ctx.font = '18px "Lilita One", Impact, sans-serif';
    const rightLabel = challengesOn() ? 'CHALLENGES ' + M.challenges : callMode() === 'electronic' ? 'ELECTRONIC' : 'PLAYER CALLS';
    const panelW = Math.max(n * 30 + 32, ctx.measureText('RACKETS').width + ctx.measureText(rightLabel).width + 64);
    const bx = W - 10 - panelW + 14;
    hudPanel(ctx, bx - 14, 610, panelW, 100, 12);
    ctx.textAlign = 'right';
    ctx.font = '18px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = M.challenges ? '#9fe7ff' : 'rgba(244,241,230,0.75)';
    if (!challengesOn()) ctx.fillStyle = 'rgba(244,241,230,0.75)';
    ctx.fillText(challengesOn() ? 'CHALLENGES ' + M.challenges : callMode() === 'electronic' ? 'ELECTRONIC' : 'PLAYER CALLS', bx - 14 + panelW - 12, 631);
    ctx.textAlign = 'left';
    ctx.font = '18px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = '#f4f1e6';
    ctx.fillText('RACKETS', bx - 2, 631);
    // A divider, so the two labels never read as one phrase
    const dvx = bx - 2 + ctx.measureText('RACKETS').width + 10;
    ctx.fillStyle = 'rgba(244,241,230,0.3)';
    ctx.fillRect(dvx, 620, 2, 22);
    for (let i = 0; i < n; i++) {
      const x = bx + i * 30 + 10;
      const alive = i < M.rackets;
      ctx.save();
      ctx.translate(x, 664);
      if (!alive) ctx.rotate(0.5);
      ctx.strokeStyle = alive ? '#d9f24a' : '#ff3b30';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, -8, 9, 12, 0, 0, Math.PI * 2);
      if (!alive) ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = alive ? '#f4f1e6' : '#ff3b30';
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.lineTo(0, 22);
      ctx.stroke();
      ctx.restore();
    }
    ctx.font = '19px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = M.violations ? '#ffb03a' : 'rgba(244,241,230,0.9)';
    ctx.fillText(M.violations ? 'Code: ' + PENALTY[Math.min(M.violations, 4) - 1] : 'Code: clean', bx - 2, 698);

    ctx.restore();

    // Context hint
    // Teaching hints retire: each shows in at most HINT_POINTS points, ever, so they are gone by the second match.
    // Scene setting (the venue, a time waster bouncing) always shows.
    let hint = '';
    let hid = null;
    const teach = (id, text) => { if (!hint && !(M.tut && !M.tut.practice) && (SAVE.hints = SAVE.hints || {}) && (SAVE.hints[id] || 0) < HINT_POINTS) { hint = text; hid = id; } };
    if (M.phase === 'serveReady') teach('serve', ctl('serveHint'));
    else if (M.phase === 'rally' && s_incoming()) {
      teach('hit', ctl('hit'));
      teach('aim', ctl('aim'));
      if (M.opp.atNet) teach('oppNet', ctl('oppNet'));
      if (M.shot.serve && M.shot.second) teach('second', 'Second serve. Time it well and attack it.');
      if (Math.abs(M.player.tx - M.player.x) > 2.5) teach('onRun', ctl('onRun'));
      if (M.player.y > 4.5) teach('atNet', 'You are at the net. Volley it. Back up for lobs.');
      if (!M.stickUsed) teach('legs', ctl('legs'));
      teach('charge', ctl('charge'));
    } else if (challengeOpen()) teach('challenge', 'Think it was in? Challenge it. Get it wrong and it costs you rage.');
    else if (M.phase === 'prePoint' && M.server === 1 && hasTrait('timewaster') && M.bounceCount > 2) hint = M.cfg.opp.name + ' is bouncing the ball. Bounce ' + M.bounceCount + '.';
    else if (M.phase === 'intro' && M.phaseDur <= 3) hint = M.cfg.label + '. ' + (M.cfg.mode === 'daily' ? 'Today\'s Daily Meltdown.' : M.resumed ? 'Resumed where you left off.' : TIERS[M.cfg.tierIdx].venue + '.');
    if (hid && !(M.hintsSeen || (M.hintsSeen = {}))[hid + ':' + (M.stats.pointsWon + M.stats.pointsLost)]) {
      // Counted once per point it appears in
      M.hintsSeen[hid + ':' + (M.stats.pointsWon + M.stats.pointsLost)] = true;
      SAVE.hints[hid] = (SAVE.hints[hid] || 0) + 1;
      persist();
    }
    if (hint) {
      // Between the rage meter and the racket bag, wherever the screen shape puts them; wrapped to fit,
      // and lifted above them if the gap is too narrow
      ctx.save();
      ctx.translate(0, HUD.b);
      const bagW = Math.max(Math.max(M.cfg.maxRackets, M.rackets) * 30 + 32, 260);
      const gapL = 14 + 410 * KB - HUD.l + 12 + CORNER.x;
      const gapR = W - (10 + bagW) * KB + HUD.r - 12 - CORNER.x;
      let cx = (gapL + gapR) / 2;
      let maxW = gapR - gapL;
      let bottom = 704;
      if (maxW < 230) { cx = 640; maxW = 640; bottom = 600; }
      // At least 26 (about 13 px on a phone), 24 if it needs three lines
      let size = Math.max(26, Math.round(16 * KB));
      if (maxW < 520) { cx = 640; maxW = 900; bottom = 600; }
      ctx.font = 'bold ' + size + 'px "Trebuchet MS", sans-serif';
      let lines = wrapText(ctx, hint, maxW - 28);
      if (lines.length > 2) { size = Math.max(24, Math.round(14 * KB)); ctx.font = 'bold ' + size + 'px "Trebuchet MS", sans-serif'; lines = wrapText(ctx, hint, maxW - 28); }
      const w = Math.min(maxW, Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)) + 28);
      const h = 12 + lines.length * (size + 5);
      // Never over your player in a rally: if it would cover them, it fades right back
      const ph = M.playerHead;
      const pf = worldToScreen(M.player.x, M.player.y, 0);
      const top = HUD.b + bottom - h;
      const covers = ph && M.phase === 'rally' && pf.x + 0.6 * ph.k > cx - w / 2 && pf.x - 0.6 * ph.k < cx + w / 2 && pf.y > top && ph.headY < HUD.b + bottom;
      if (covers) ctx.globalAlpha = 0;
      hudPanel(ctx, cx - w / 2, bottom - h, w, h, 10, '#f4f1e6');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#16261a';
      lines.forEach((l, i) => ctx.fillText(l, cx, bottom - h + 6 + (size + 5) * (i + 0.5)));
      ctx.restore();
    }

    // Serve power bar
    if (M.phase === 'serveAim') {
      const px = 470;
      const py = 470;
      ctx.fillStyle = 'rgba(8,20,12,0.8)';
      roundRect(ctx, px - 6, py - 6, 30, 172, 8);
      ctx.fill();
      const pg = ctx.createLinearGradient(0, py + 160, 0, py);
      pg.addColorStop(0, '#5fd068');
      pg.addColorStop(0.7, '#ffb03a');
      pg.addColorStop(1, '#ff3b30');
      ctx.fillStyle = pg;
      ctx.fillRect(px, py + 160 * (1 - M.power), 18, 160 * M.power);
      // The sweet spot, a bright band near the top
      const sy0 = py + 160 * (1 - SERVE_BAR.sweet[1]);
      const sy1 = py + 160 * (1 - SERVE_BAR.sweet[0]);
      ctx.strokeStyle = '#d9f24a';
      ctx.lineWidth = 2;
      ctx.strokeRect(px - 3, sy0, 24, sy1 - sy0);
      ctx.fillStyle = 'rgba(217,242,74,0.35)';
      ctx.fillRect(px - 3, sy0, 24, sy1 - sy0);
      ctx.fillStyle = '#f4f1e6';
      ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      const est = Math.min(150, (75 + 40.4 * M.power) * (1 + 0.3 * M.rage));
      ctx.fillText(Math.round(est) + ' mph', px + 9, py - 18);
    }

    // Callouts: stamped on, tilted, outlined, with a bit of overshoot and a shake
    M.callBox = null;
    if (M.calls.length) {
      const c = M.calls[0];
      const u = reduceMotion ? 1 : Math.min(1, c.t * 6);
      // Ease out with overshoot: 0 to about 1.15 and back to 1
      const pop = reduceMotion ? 1 : 1 + 2.4 * Math.pow(u - 1, 3) + 1.4 * Math.pow(u - 1, 2);
      const a = Math.min(1, (c.dur - c.t) * 3);
      const tilt = ((c.main.length * 7) % 5 - 2) * 0.025;
      const shake = !reduceMotion && c.t < 0.25 ? (0.25 - c.t) * 24 : 0;
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      // At the net the stamp sits below the players' feet, so the handshake itself stays in view
      const atNet = M.phase === 'handshake';
      // In a reaction close up the face and the speech bubble own the middle: the stamp sits in the lower third
      const inCut = !!(M.cut && M.cut.live);
      ctx.translate(640 + (Math.random() - 0.5) * shake, (atNet ? 520 : inCut ? 448 : 262) + (Math.random() - 0.5) * shake);
      ctx.rotate(tilt);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = atNet ? 62 : inCut ? 54 : 86;
      ctx.font = size + 'px "Lilita One", Impact, sans-serif';
      while (ctx.measureText(c.main).width > 900 && size > 40) { size -= 4; ctx.font = size + 'px "Lilita One", Impact, sans-serif'; }
      ctx.lineJoin = 'round';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(c.main, 6, 8);
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 14;
      ctx.strokeText(c.main, 0, 0);
      const gr = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.35, c.color);
      gr.addColorStop(1, c.color);
      ctx.fillStyle = gr;
      ctx.fillText(c.main, 0, 0);
      // Where the stamp and its sticker sit, so speech bubbles can keep out of the way
      const cy = atNet ? 520 : inCut ? 448 : 262;
      const mainW = ctx.measureText(c.main).width + 20;
      M.callBox = { x0: 640 - mainW / 2, x1: 640 + mainW / 2, y0: cy - size * 0.55, y1: cy + size * 0.55 };
      if (c.sub) {
        // The joke, on a cream sticker under the stamp (about 13 px on a phone)
        ctx.font = 'bold 26px "Trebuchet MS", sans-serif';
        const lines = wrapText(ctx, c.sub, 760);
        const w = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)) + 40;
        const slh = 30;
        const h = 22 + lines.length * slh;
        M.callBox = { x0: Math.min(M.callBox.x0, 640 - w / 2), x1: Math.max(M.callBox.x1, 640 + w / 2), y0: M.callBox.y0, y1: cy + size * 0.55 + h + 6 };
        ctx.rotate(-tilt * 1.6);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        roundRect(ctx, -w / 2 + 3, size * 0.55 + 5, w, h, 10);
        ctx.fill();
        ctx.fillStyle = '#f4f1e6';
        roundRect(ctx, -w / 2, size * 0.55, w, h, 10);
        ctx.fill();
        ctx.strokeStyle = '#0b0b0b';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = '#16261a';
        // Centred top to bottom in the sticker, however many lines
        ctx.textBaseline = 'middle';
        lines.forEach((l, i) => ctx.fillText(l, 0, size * 0.55 + h / 2 + 1 + (i - (lines.length - 1) / 2) * slh));
      }
      ctx.restore();
    }

    // Floaters
    M.floaters.forEach((f) => {
      if (f.world) { const sp = worldToScreen(f.world.x, f.world.y, f.world.z); f.x = clamp(sp.x, 160, W - 160); f.y = clamp(sp.y, 150, H - 130); }
      ctx.globalAlpha = 1 - f.t / 1.4;
      ctx.font = f.big ? '26px "Lilita One", Impact, sans-serif' : 'bold 19px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = f.big ? 7 : 4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = f.big ? '#0b0b0b' : 'rgba(0,0,0,0.7)';
      ctx.strokeText(f.text, f.x, f.y - f.t * 40);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - f.t * 40);
      ctx.globalAlpha = 1;
    });

    if (M.tut) {
      // The lesson card sits over the scoreboard, so it follows it into the corner, inset like the scoreboard
      // so a phone's rounded corner never clips it
      ctx.save();
      ctx.translate(-HUD.l + 14, -HUD.t + 8);
      drawCoach(ctx);
      ctx.restore();
    }
    if (M.tip && FSM.name === 'MATCH_PLAY' && tipQuiet()) {
      const a = Math.min(1, M.tip.t * 4, (M.tip.dur - M.tip.t) * 2);
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      const mv = M.tip.move;
      // Sized to read on a phone: about 14 px at the usual landscape size
      const TW = 820;
      const tx = mv ? 640 - TW / 2 + 112 : 640 - TW / 2 + 78;
      ctx.font = 'bold 28px "Trebuchet MS", sans-serif';
      const lines = wrapText(ctx, M.tip.text, mv ? TW - 136 : TW - 100);
      const h = Math.max(mv ? 110 : 0, (mv ? 58 : 26) + lines.length * 36);
      ctx.fillStyle = 'rgba(8,20,12,0.94)';
      roundRect(ctx, 640 - TW / 2, 118, TW, h, 12);
      ctx.fill();
      ctx.strokeStyle = '#06110a';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = '#d9f24a';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.textBaseline = 'middle';
      if (mv) {
        drawMoveIcon(ctx, mv, 640 - TW / 2 + 56, 118 + h / 2, M.tip.t);
        ctx.fillStyle = '#d9f24a';
        ctx.font = '28px "Lilita One", Impact, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('NEW MOVE', tx, 146);
      } else {
        ctx.fillStyle = '#d9f24a';
        roundRect(ctx, 640 - TW / 2 + 12, 129, 56, 30, 6);
        ctx.fill();
        ctx.fillStyle = '#10261a';
        ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('TIP', 640 - TW / 2 + 40, 145);
      }
      ctx.fillStyle = '#f4f1e6';
      ctx.font = 'bold 28px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, tx, (mv ? 182 : 145) + i * 36));
      ctx.restore();
    }
    if (M.phase === 'review' && M.review) drawReview(ctx, M.review);
    // Once the stamp has gone, the strap carries the moment through the serve
    if (M.big && !M.calls.length && /prePoint|serveReady|serveAim|oppToss/.test(M.phase)) { if (!M.big.shown) M.big.shown = M.time; drawBigStrap(ctx, M.big); }

    if (M.phase === 'highlight') {
      // TV replay: letterbox bars, a POINT OF THE MATCH bug, slow motion marked, tap to skip
      const HL = M.hl;
      const slow = HL.i > HL.slowFrom;
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fillRect(-BX, -BY, W + 2 * BX, 46 + BY);
      ctx.fillRect(-BX, H - 46, W + 2 * BX, 46 + BY);
      hudPanel(ctx, 640 - 220, 58, 440, 70, 10, '#10261a');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '30px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = '#d9f24a';
      ctx.fillText(HL.instant ? HL.title : 'POINT OF THE MATCH', 640, 82);
      ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText(HL.instant ? HL.sub : M.bestPoint.title + (M.bestPoint.rally >= 4 ? '  |  ' + M.bestPoint.rally + '-shot rally' : ''), 640, 110);
      ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = slow ? '#ffb03a' : '#ff3b30';
      if (slow || Math.sin(M.time * 6) > 0) ctx.fillText(slow ? 'SLOW MOTION' : '\u25CF REPLAY', 30, 23);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(244,241,230,0.75)';
      ctx.fillText(ctl('skip'), W - 30, H - 23);
      // The pundit's pen: in the slow motion, a hand-drawn ring round where the ball lands, an arrow, a word
      if (slow && M.shot && M.shot.land && !reduceMotion) {
        const lp = worldToScreen(M.shot.land.x, M.shot.land.y, 0);
        const u = clamp((HL.i - HL.slowFrom) / Math.max(20, HL.f.length * 0.12), 0, 1);
        const rx = 46;
        const ry = 22;
        ctx.save();
        ctx.strokeStyle = '#ffe14a';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        // A slightly wobbly loop that overshoots its start, as a real pen would
        for (let a = 0; a <= u * Math.PI * 2.15; a += 0.08) {
          const wob = 1 + 0.06 * Math.sin(a * 3 + 1);
          const px = lp.x + Math.cos(a - 1.2) * rx * wob;
          const py = lp.y + Math.sin(a - 1.2) * ry * wob;
          if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (u >= 1) {
          // The arrow and the word
          const ax = lp.x + 150;
          const ay = lp.y - 110;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(lp.x + 120, lp.y - 30, lp.x + rx + 6, lp.y - 8);
          ctx.moveTo(lp.x + rx + 6, lp.y - 8);
          ctx.lineTo(lp.x + rx + 22, lp.y - 26);
          ctx.moveTo(lp.x + rx + 6, lp.y - 8);
          ctx.lineTo(lp.x + rx + 28, lp.y - 4);
          ctx.stroke();
          const words = ['UNPLAYABLE', 'PURE CHEEK', 'TEXTBOOK', 'LOOK AT THAT', 'OH YES'];
          const word = words[(M.bestPoint && M.bestPoint.rally ? M.bestPoint.rally : 0) % words.length];
          ctx.font = 'italic 30px "Lilita One", Impact, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillStyle = '#ffe14a';
          ctx.fillText(word, ax - 10, ay - 18);
        }
        ctx.restore();
      }
    }
    if (M.phase === 'intro' && M.phaseDur > 3) {
      // TV straps: the opponent while they walk out, then you, then the coin toss
      const t = M.phaseT;
      // Head and shoulders portraits for the straps, drawn once per match with the match figure
      if (!M.strapPics) M.strapPics = { opp: renderFigure(M.cfg.opp, rivalMood(M.cfg.opp), 150, 150, 'bust'), you: renderFigure(null, 'calm', 150, 150, 'bust', { colors: youColors() }) };
      const strap = (t0, t1, name, line, accent, pic) => {
        if (t < t0 || t > t1) return;
        const k = Math.min(1, (t - t0) * 4, (t1 - t) * 4);
        const x = 640 - 330 + (1 - k) * -60;
        ctx.save();
        ctx.globalAlpha = k;
        hudPanel(ctx, x, 470, 660, 86, 10, '#10261a');
        ctx.fillStyle = accent;
        ctx.fillRect(x + 10, 480, 8, 66);
        let tx = x + 32;
        if (pic) {
          // The portrait in a framed window, like a broadcast graphic
          ctx.save();
          roundRect(ctx, x + 26, 476, 74, 74, 8);
          ctx.fillStyle = shadeHex(accent.length === 7 ? accent : '#2f6b3a', -0.55);
          ctx.fill();
          ctx.clip();
          ctx.drawImage(pic, x + 26, 476, 74, 74);
          ctx.restore();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2;
          roundRect(ctx, x + 26, 476, 74, 74, 8);
          ctx.stroke();
          tx = x + 114;
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '34px "Lilita One", Impact, sans-serif';
        ctx.fillStyle = '#f4f1e6';
        fitCanvasText(ctx, name, 640 - (tx - x), 34, '"Lilita One", Impact, sans-serif');
        ctx.fillText(name, tx, 500);
        ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
        fitCanvasText(ctx, line, 640 - (tx - x), 17, '"Trebuchet MS", sans-serif', 'bold ');
        ctx.fillStyle = accent;
        ctx.fillText(line, tx, 532);
        ctx.restore();
      };
      strap(INTRO_TV.opp[0], INTRO_TV.opp[1], M.cfg.opp.name.toUpperCase(), [oppStyle().label].concat(M.cfg.opp.traits.map((tr) => TRAIT_LABEL[tr])).join('  |  ') + '   Skill: ' + skillLabel(M.cfg.skill) + rivalLine(M.cfg.opp.name), '#ff8a80', M.strapPics.opp);
      drawTape(ctx, t);
      if (t > INTRO_TV.toss) {
        // The coin toss: a spinning coin over the net, then who serves
        const u = clamp((t - INTRO_TV.toss) / 1.1, 0, 1);
        const cy = 250 - Math.sin(u * Math.PI) * 70;
        const spin = Math.abs(Math.cos(u * 9 * Math.PI));
        ctx.save();
        ctx.globalAlpha = Math.min(1, (M.phaseDur - t) * 3);
        if (u < 1) {
          ctx.fillStyle = '#d4af37';
          ctx.strokeStyle = '#7a5a12';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.ellipse(640, cy, 26, Math.max(3, 26 * spin), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.font = '40px "Lilita One", Impact, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 8;
          ctx.strokeStyle = '#0b0b0b';
          const msg = M.server === 0 ? 'YOU SERVE FIRST' : M.cfg.opp.name.split(' ').pop().toUpperCase() + ' SERVES FIRST';
          ctx.strokeText(msg, 640, 250);
          ctx.fillStyle = '#d9f24a';
          ctx.fillText(msg, 640, 250);
        }
        ctx.restore();
      }
    } else if (M.phase === 'intro') {
      ctx.fillStyle = 'rgba(8,20,12,' + Math.max(0, 0.75 - M.phaseT * 0.3).toFixed(2) + ')';
      ctx.fillRect(-BX, 160, W + 2 * BX, 220);
      ctx.globalAlpha = Math.min(1, (M.phaseDur - M.phaseT) * 2);
      ctx.textAlign = 'center';
      ctx.font = '54px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText('YOU  v  ' + M.cfg.opp.name.toUpperCase(), 640, 240);
      ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
      ctx.fillStyle = '#d9f24a';
      ctx.fillText(M.cfg.opp.traits.map((t) => TRAIT_LABEL[t]).join('  |  ') + '   Skill: ' + skillLabel(M.cfg.skill), 640, 290);
      ctx.fillStyle = 'rgba(244,241,230,0.8)';
      ctx.fillText(M.rackets + ' racket' + (M.rackets === 1 ? '' : 's') + ' in the bag. Kit by ' + playerKit().sponsor.replace(/\.$/, '') + '. Try to leave with some rackets.', 640, 322);
      ctx.globalAlpha = 1;
    }
  }
  function drawReview(ctx, r) {
    const t = r.t;
    ctx.fillStyle = 'rgba(4,10,6,0.84)';
    ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    const px = 290;
    const py = 96;
    const pw = 700;
    const ph = 470;
    ctx.fillStyle = '#0f1d14';
    roundRect(ctx, px, py, pw, ph, 14);
    ctx.fill();
    ctx.strokeStyle = '#9fe7ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '34px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = '#9fe7ff';
    ctx.fillText('LINE REVIEW', 640, py + 34);
    ctx.font = 'bold 14px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(244,241,230,0.7)';
    ctx.fillText('Owl Vision. Accurate to the millimetre, give or take a millimetre.', 640, py + 62);

    // Nearest line that matters. perp is the distance of the ball centre inside that line's outer edge.
    const a = r.area;
    const cands = [
      { perp: r.x - a.x0, vertical: true, left: true }, { perp: a.x1 - r.x, vertical: true },
      { perp: r.y - a.y0, vertical: false, net: Math.abs(a.y0 - C.net) < 0.01 },
      { perp: a.y1 - r.y, vertical: false, net: Math.abs(a.y1 - C.net) < 0.01 }
    ].filter((c) => !c.net);
    cands.sort((p1, p2) => p1.perp - p2.perp);
    const line = cands[0];
    const vx = px + 30;
    const vy = py + 84;
    const vw = pw - 60;
    const vh = ph - 190;
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const S = 1100;  // pixels per metre
    const mid = clamp(line.perp / 2, -0.12, 0.12);
    const edgeX = cx + mid * S;            // inside is to the left of the edge
    const ballX = cx - (line.perp - mid) * S;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx, vy, vw, vh);
    ctx.clip();
    // Seen from your end, the left sideline has the court on its right: mirror the view
    if (line.left) {
      ctx.translate(2 * cx, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = M.surf.court;
    ctx.fillRect(vx, vy, edgeX - vx, vh);
    ctx.fillStyle = M.surf.outside;
    ctx.fillRect(edgeX, vy, vx + vw - edgeX, vh);
    ctx.fillStyle = M.surf.line;
    ctx.fillRect(edgeX - 0.05 * S, vy, 0.05 * S, vh);
    // Millimetre ticks along the edge
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = -20; i <= 20; i++) ctx.fillRect(edgeX + i * 0.01 * S, vy + vh - (i % 5 === 0 ? 18 : 9), 1.5, i % 5 === 0 ? 18 : 9);
    // The ball arrives from above, then leaves its mark
    const arrive = clamp(t / 1.1, 0, 1);
    const br = BALL_R * S;
    if (arrive < 1) {
      const by = lerp(vy - 60, cy, arrive * arrive);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(ballX, cy, br * (0.6 + arrive * 0.6), br * (0.5 + arrive * 0.5), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d9f24a';
      ctx.beginPath();
      ctx.arc(ballX, by, br, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(80,60,20,0.55)';
      ctx.beginPath();
      ctx.ellipse(ballX, cy, br, br * 1.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#d9f24a';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
    if (!line.vertical) {
      ctx.font = 'bold 12px "Trebuchet MS", sans-serif';
      ctx.fillStyle = 'rgba(244,241,230,0.6)';
      ctx.fillText('View turned to face the ' + (Math.abs((line.perp === r.y - a.y0 ? a.y0 : a.y1) - C.L) < 0.01 || Math.abs((line.perp === r.y - a.y0 ? a.y0 : a.y1)) < 0.01 ? 'baseline' : 'service line'), 640, vy + vh + 14);
    }
    // Verdict
    const touchesLine = line.perp + BALL_R >= -1e-9;
    if (t > 1.2 && t < 2.25) {
      ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText('Analysing' + '.'.repeat(1 + Math.floor(t * 4) % 3), 640, py + ph - 60);
    } else if (t >= 2.25) {
      const isIn = touchesLine;
      const mm = Math.max(1, Math.round(Math.abs(isIn ? line.perp + BALL_R : -line.perp - BALL_R) * 1000));
      ctx.font = '64px "Lilita One", Impact, sans-serif';
      ctx.fillStyle = isIn ? '#5fd068' : '#ff3b30';
      ctx.fillText(isIn ? 'IN' : 'OUT', 640, py + ph - 72);
      ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
      ctx.fillStyle = '#f4f1e6';
      ctx.fillText(isIn ? (line.perp <= BALL_R ? 'It clipped the line by ' + mm + ' mm. The call is overturned.' : 'In by ' + mm + ' mm. The call is overturned.')
        : 'Out by ' + mm + ' mm. The call stands.', 640, py + ph - 28);
    }
  }

  // A broadcast subtitle for the umpire when the chair is out of shot
  function drawUmpireSubtitle(ctx, y) {
    if (!(M.speech && M.speech.who === 'ump')) return;
    ctx.font = 'bold 19px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = officialTitle().toUpperCase() + ': ' + M.speech.text;
    const w = ctx.measureText(text).width + 30;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    roundRect(ctx, 640 - w / 2, y, w, 34, 6);
    ctx.fill();
    ctx.fillStyle = '#ffd977';
    ctx.fillText(text, 640, y + 17);
  }

  // Coach Derek's lesson card, over the scoreboard (there is no score in a lesson)
  function drawCoach(ctx) {
    const T = M.tut;
    if (T.practice) { drawPracticeCard(ctx, T); return; }
    const st = TUT_STEPS[Math.min(T.step, TUT_STEPS.length - 1)];
    const list = TUT_STEPS;
    const num = Math.min(list.indexOf(st) + 1, list.length);
    ctx.font = 'bold 26px "Trebuchet MS", sans-serif';
    // Narrow and in the corner: it must stop short of the middle, where Derek stands
    const CW = 590;
    const tl = wrapText(ctx, st.text, CW - 104).slice(0, 4);
    const ch = 56 + tl.length * 32;
    ctx.fillStyle = '#08140c';
    roundRect(ctx, 16, 8, CW, ch, 10);
    ctx.fill();
    ctx.strokeStyle = '#d9f24a';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Derek: grey hair, a whistle, no patience
    ctx.fillStyle = '#e8c3a0';
    ctx.beginPath();
    ctx.arc(52, 56, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#9a9a9a';
    ctx.beginPath();
    ctx.arc(52, 50, 25, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(43, 54, 4, 4);
    ctx.fillRect(57, 54, 4, 4);
    ctx.fillRect(45, 66, 14, 3);
    ctx.fillStyle = '#c9d1d9';
    ctx.fillRect(58, 70, 12, 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#d9f24a';
    ctx.fillText('STEP ' + num + ' OF ' + list.length + ': ' + st.title.toUpperCase(), 100, 32);
    ctx.font = 'bold 26px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f4f1e6';
    tl.forEach((l, i) => ctx.fillText(l, 100, 68 + i * 32));
    if (st.id === 'spin') {
      // Which spins are done: ticked off by name
      ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'right';
      [['TOPSPIN', 'topspin'], ['SLICE', 'slice']].forEach((k, i) => {
        const got = !!T.flags[k[1]];
        ctx.fillStyle = got ? '#d9f24a' : 'rgba(255,255,255,0.35)';
        ctx.fillText((got ? '\u2713 ' : '') + k[0], CW - (1 - i) * 104, 32);
      });
      ctx.textAlign = 'left';
    } else {
      for (let i = 0; i < st.need; i++) {
        ctx.fillStyle = i < T.count ? '#d9f24a' : 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.arc(CW - (st.need - i) * 28, 32, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawPracticeCard(ctx, T) {
    const D = DRILLS[T.practice];
    ctx.fillStyle = '#08140c';
    roundRect(ctx, 16, 8, 814, 98, 10);
    ctx.fill();
    ctx.strokeStyle = '#d9f24a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#e8c3a0';
    ctx.beginPath();
    ctx.arc(52, 56, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#9a9a9a';
    ctx.beginPath();
    ctx.arc(52, 50, 25, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(43, 54, 4, 4);
    ctx.fillRect(57, 54, 4, 4);
    ctx.fillRect(45, 66, 14, 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#d9f24a';
    ctx.fillText('COACH DEREK   PRACTICE: ' + D.title.toUpperCase() + '   NOTHING COUNTS', 90, 26);
    ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#f4f1e6';
    ctx.fillText(D.text, 90, 54, 720);
    ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#9fe7ff';
    ctx.fillText((T.practice === 'serves' ? 'Serves in: ' : 'Balls in: ') + T.ins + (T.practice === 'serves' ? '' : '     Best rally: ' + T.best) + '     Pause to stop', 90, 84);
  }
  // Pro footwork: you do the running (never in the lesson; Practice follows the setting)
  function proFeet() { return SAVE.settings.footwork === 'pro' && !!M && (!M.tut || !!M.tut.practice); }
  function s_incoming() {
    const s = M.shot;
    return s && s.hitter === 1 && !s.resolved && !s.dead;
  }

  /* =====================================================================
     8. Finite state machine
     ===================================================================== */
  // Each state gets a fresh Scope. Everything registered through it (DOM listeners, timers,
  // audio loops) is torn down automatically when the state exits.
  function Scope() {
    const disposers = [];
    return {
      on(el, ev, fn, opts) {
        el.addEventListener(ev, fn, opts);
        disposers.push(() => el.removeEventListener(ev, fn, opts));
      },
      timeout(fn, ms) {
        const id = setTimeout(fn, ms);
        disposers.push(() => clearTimeout(id));
        return id;
      },
      loop(name) {
        const h = window.RRAudio ? RRAudio.loop(name) : { stop() {} };
        disposers.push(() => h.stop());
        return h;
      },
      add(fn) { disposers.push(fn); },
      dispose() {
        while (disposers.length) {
          try { disposers.pop()(); } catch (e) { /* keep tearing down */ }
        }
      }
    };
  }

  const SCREENS = ['menu', 'how', 'hub', 'press', 'over', 'locker'];
  // A big stamp on a result screen, with confetti and a fanfare for a win, a sad trombone for a loss
  function resultStamp(el, text, win) {
    el.textContent = text;
    el.className = 'result-stamp ' + (win ? 'win' : 'loss');
    void el.offsetWidth;
    el.classList.add('go');
    setTimeout(() => sfx(win ? 'fanfare' : 'trombone'), 250);
    if (win) confetti(60);
  }
  function confetti(n) {
    if (reduceMotion) return;
    const cols = ['#d9f24a', '#ff3b30', '#f4f1e6', '#6fd3ff', '#ffb03a', '#b79ce0'];
    // The open gaps either side of the panel on screen, measured, so it never falls over the panel
    const sr = stage.getBoundingClientRect();
    const pan = Array.from(document.querySelectorAll('.panel')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const gapL = pan ? pan.left - sr.left : sr.width * 0.12;
    const gapR = pan ? sr.right - pan.right : sr.width * 0.12;
    const sides = [gapL >= 28 ? -1 : 0, gapR >= 28 ? 1 : 0].filter(Boolean);
    if (!sides.length) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'confetti';
      // Down the open margins either side of the panel, so it never falls over the buttons
      const side = sides[i % sides.length];
      const gap = side < 0 ? gapL : gapR;
      const px = 6 + Math.random() * Math.max(0, gap - 30);
      p.style.left = (side < 0 ? px : sr.width - px - 10).toFixed(0) + 'px';
      p.style.background = cols[i % cols.length];
      p.style.setProperty('--sx', (side * Math.random() * 1.2).toFixed(2) + 'em');
      p.style.setProperty('--r', Math.round(360 + Math.random() * 720) + 'deg');
      p.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's';
      p.style.animationDuration = (1.8 + Math.random() * 1.2).toFixed(2) + 's';
      stage.appendChild(p);
      setTimeout(() => p.remove(), 3800);
    }
  }

  // A tennis ball swoosh whenever one menu screen gives way to another
  let lastScreen = null;
  let wipeTimer = 0;
  function swoosh() {
    if (reduceMotion) return;
    const w = $('#wipe');
    w.classList.remove('go');
    void w.offsetWidth;
    w.classList.add('go');
    clearTimeout(wipeTimer);
    wipeTimer = setTimeout(() => w.classList.remove('go'), 480);
    sfx('whoosh', { power: 0.5 });
  }
  function showScreen(id) {
    if (id && lastScreen && id !== lastScreen) swoosh();
    lastScreen = id;
    SCREENS.forEach((s) => $('#' + s).classList.toggle('show', s === id));
  }

  // Money that counts up to its new value, with a burst of coins when it rises
  function countUp(el, to, fmt, from) {
    fmt = fmt || money;
    from = from || 0;
    if (reduceMotion || to === from) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const dur = Math.min(1400, 450 + Math.abs(to - from) / 40);
    el.classList.add('counting');
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
      else el.classList.remove('counting');
    };
    requestAnimationFrame(step);
    if (to > from) coinBurst(el, 12);
  }
  function coinBurst(el, n) {
    if (reduceMotion) return;
    const sr = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    for (let i = 0; i < n; i++) {
      const coin = document.createElement('i');
      coin.className = 'coin';
      coin.style.left = (r.left + r.width / 2 - sr.left) + 'px';
      coin.style.top = (r.top + r.height / 2 - sr.top) + 'px';
      coin.style.setProperty('--dx', ((Math.random() - 0.5) * 9).toFixed(2) + 'em');
      coin.style.setProperty('--dy', (-1.5 - Math.random() * 4).toFixed(2) + 'em');
      coin.style.animationDelay = (i * 0.045).toFixed(2) + 's';
      stage.appendChild(coin);
      setTimeout(() => coin.remove(), 1500);
    }
  }
  let chipMoneyShown = null;

  const TRANSITIONS = {
    BOOT: ['INTRO', 'MENU', 'MATCH_PLAY'],
    INTRO: ['MENU'],
    MENU: ['CAREER_HUB', 'MATCH_PLAY', 'LOCKER_ROOM'],
    LOCKER_ROOM: ['MENU', 'CAREER_HUB', 'MATCH_PLAY'],
    CAREER_HUB: ['MENU', 'MATCH_PLAY', 'CAREER_HUB', 'LOCKER_ROOM'],
    MATCH_PLAY: ['MELTDOWN_MINIGAME', 'PRESS_CONFERENCE', 'GAME_OVER', 'CAREER_HUB', 'MENU', 'LOCKER_ROOM'],
    MELTDOWN_MINIGAME: ['MATCH_PLAY', 'GAME_OVER', 'PRESS_CONFERENCE'],
    PRESS_CONFERENCE: ['CAREER_HUB', 'GAME_OVER', 'MATCH_PLAY', 'MENU'],
    GAME_OVER: ['MENU', 'CAREER_HUB', 'MATCH_PLAY', 'LOCKER_ROOM']
  };

  const FSM = {
    name: 'BOOT',
    state: null,
    scope: null,
    states: {},
    change(next, params) {
      if (TRANSITIONS[this.name].indexOf(next) < 0) {
        console.warn('Blocked state change', this.name, '->', next);
        return false;
      }
      const prev = this.name;
      $('#cardModal').classList.add('hidden');
      $('#trophyModal').classList.add('hidden');
      $('#betModal').classList.add('hidden');
      $('#meltChoice').classList.add('hidden');
      $('#finalModal').classList.add('hidden');
      if (prev === 'MENU' && next !== 'MATCH_PLAY') adsWarm();
      if (this.state && this.state.exit) this.state.exit(next);
      if (this.scope) this.scope.dispose();
      this.name = next;
      this.state = this.states[next];
      this.scope = Scope();
      showScreen(this.state.screen || null);
      cgPlay();
      this.state.enter(params || {}, this.scope, prev);
      // Awards earned during the match come out once there is a calm screen to show them on
      setTimeout(pumpAwards, 900);
      return true;
    }
  };

  /* ---------- shared match input (bound per state through the scope) ---------- */
  // The first match's start card: shown before the first serve until you press anything
  const startGate = () => !!(M && M.cfg.first && !M.go && M.phase === 'prePoint' && !M.paused);
  function drawStartCard(ctx) {
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 260);
    const desk = INPUT.kind !== 'touch';
    ctx.save();
    ctx.fillStyle = 'rgba(6,14,9,0.45)';
    ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
    const w = desk ? 820 : 640;
    const h = desk ? 340 : 230;
    const x = 640 - w / 2;
    const y = desk ? 178 : 250;
    hudPanel(ctx, x, y, w, h, 14, '#10261a');
    ctx.fillStyle = '#d9f24a';
    ctx.fillRect(x + 24, y + 22, 8, 56);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f4f1e6';
    ctx.font = '50px "Lilita One", Impact, sans-serif';
    ctx.fillText('YOUR FIRST MATCH', 640, y + 52);
    ctx.font = 'bold 26px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(244,241,230,0.85)';
    if (desk) {
      ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
      ctx.fillText('First to 2 games against ' + M.cfg.opp.name + '. Keep your temper. Or do not.', 640, y + 104);
      // The controls, both ways, with the keys drawn as keys
      capsRow(ctx, 'MOUSE', ['Point to aim', 'Hold, let go on the ring', 'Right-click: net'], x + 50, y + 162);
      capsRow(ctx, 'KEYS', ['[Space] hit', '[KeyA][KeyD] aim', '[KeyW][KeyS] spin', '[ArrowUp] net', '[KeyP] pause'], x + 50, y + 214);
    } else {
      ctx.fillText('First to 2 games against ' + M.cfg.opp.name + '.', 640, y + 108);
      ctx.fillText('Keep your temper. Or do not.', 640, y + 142);
    }
    ctx.textAlign = 'center';
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#d9f24a';
    ctx.font = '34px "Lilita One", Impact, sans-serif';
    ctx.fillText(desk ? 'CLICK OR PRESS SPACE TO PLAY' : 'TAP TO PLAY', 640, y + h - 38);
    ctx.restore();
  }
  // One row of controls: a label, then items, where [KeyW] is drawn as a key
  function capsRow(ctx, label, parts, x0, yy) {
    ctx.textAlign = 'left';
    ctx.font = '24px "Lilita One", Impact, sans-serif';
    ctx.fillStyle = '#d9f24a';
    ctx.fillText(label, x0, yy);
    let cx = x0 + 100;
    ctx.font = 'bold 21px "Trebuchet MS", sans-serif';
    parts.forEach((part, pi) => {
      if (pi) cx += 26;
      part.split(/(\[[^\]]+\])/).filter(Boolean).forEach((tok) => {
        const cap = /^\[(.+)\]$/.exec(tok);
        if (cap) {
          const s = keyName(cap[1]);
          const tw = Math.max(28, ctx.measureText(s).width + 16);
          ctx.fillStyle = '#f4f1e6';
          roundRect(ctx, cx, yy - 15, tw, 30, 6);
          ctx.fill();
          ctx.fillStyle = '#16261a';
          ctx.textAlign = 'center';
          ctx.fillText(s, cx + tw / 2, yy + 1);
          ctx.textAlign = 'left';
          cx += tw + 5;
        } else {
          ctx.fillStyle = 'rgba(244,241,230,0.92)';
          ctx.fillText(tok, cx, yy + 1);
          cx += ctx.measureText(tok).width;
        }
      });
    });
  }
  // A press gets you past the replay, the TV walk-on, the handshake, a reaction cut, a changeover or a caption
  // you have read: TV pacing never holds up play. True if the press was used up doing that.
  function matchSkip() {
    if (M.phase === 'highlight') { M.hl.skip = true; return true; }
    if (M.phase === 'intro' && M.phaseDur > 3 && M.phaseT > 0.5) {
      M.phaseT = M.phaseT < INTRO_TV.tape[0] ? INTRO_TV.tape[0] : M.phaseT < INTRO_TV.toss ? INTRO_TV.toss : M.phaseDur - 0.05;
      return true;
    }
    if (M.phase === 'handshake') {
      if (M.hs && M.hs.choice && M.hs.t - M.hs.at > 0.8) M.hs.at = M.hs.t - HS.play - 0.01;
      return true;
    }
    if (M.phase === 'pointOver' && !M.challengeable && ((M.cut && M.phaseT >= M.cut.at) || (M.tvStats && M.phaseT > 1.2) || M.phaseT > 0.5)) {
      M.phaseT = Math.max(M.phaseT, M.phaseDur - 0.05);
      if (M.cut) M.cut.until = 0;
      return true;
    }
    return false;
  }
  const HS_KEYS = { Digit1: 'firm', Digit2: 'limp', Digit3: 'tooSlow', Numpad1: 'firm', Numpad2: 'limp', Numpad3: 'tooSlow' };
  // CrazyGames: gameplay is on while a match is on screen and not paused (off on the pause menu, menus and results).
  // The first match's start card counts as gameplay: CrazyGames measures load time from Play Now to the first gameplay
  // start, so waiting for the click would add the player's reading time to the load time. A hidden tab is not reported:
  // CrazyGames handles that itself.
  function cgPlay() {
    if (!window.RRCG || document.hidden) return;
    RRCG.gameplay(FSM.name === 'MELTDOWN_MINIGAME' || (FSM.name === 'MATCH_PLAY' && !!M && !M.paused));
  }
  function bindMatchInput(scope) {
    const t = () => M.touch;
    const st = () => M.stick;
    // Left thumb: a floating stick that appears wherever it lands in the left zone (not while serving)
    const stickAllowed = (pos) => pos.x < STICK_ZONE && M.phase !== 'serveReady' && M.phase !== 'serveAim';
    scope.on(canvas, 'pointerdown', (e) => {
      e.preventDefault();
      if (M.cfg.first && !M.go) { M.go = true; return; }
      const mouse = e.pointerType === 'mouse';
      // Mouse: the right button takes you to the net and back; the middle button does nothing
      if (mouse && e.button !== 0) { if (e.button === 2 && !M.paused) netToggle(); return; }
      if (matchSkip()) return;
      const pos = toLogical(e);
      if (mouse) { M.aimSrc = 'mouse'; M.mousePos = pos; }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!mouse && stickAllowed(pos) && !(st().active && st().id !== e.pointerId)) {
        Object.assign(st(), { active: true, id: e.pointerId, ox: pos.x, oy: pos.y, vx: 0, vy: 0 });
        M.stickUsed = true;
        return;
      }
      // Right thumb: aim, charge and swing. A new press always takes over, so a lost pointerup
      // (common on Android WebViews) can never lock input.
      t().down = true;
      t().id = e.pointerId;
      pressDown(pos);
    });
    scope.on(canvas, 'pointermove', (e) => {
      // Mouse: the aim follows the pointer (see MATCH_PLAY.update)
      if (e.pointerType === 'mouse') { M.mousePos = toLogical(e); if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) M.aimSrc = 'mouse'; }
      if (st().active && e.pointerId === st().id) {
        e.preventDefault();
        const pos = toLogical(e);
        let dx = (pos.x - st().ox) / 60;
        let dy = (pos.y - st().oy) / 60;
        const n = Math.hypot(dx, dy);
        if (n > 1) { dx /= n; dy /= n; }
        st().vx = dx;
        st().vy = -dy;     // up the screen is towards the net
        return;
      }
      if (!t().down || e.pointerId !== t().id) return;
      e.preventDefault();
      pressMove(toLogical(e));
    });
    const up = (e) => {
      if (st().active && e.pointerId === st().id) {
        Object.assign(st(), { active: false, id: null, vx: 0, vy: 0 });
        return;
      }
      if (!t().down || e.pointerId !== t().id) return;
      e.preventDefault();
      t().down = false;
      t().id = null;
      pressUp(e.type === 'pointercancel' ? null : toLogical(e));
    };
    scope.on(canvas, 'pointerup', up);
    scope.on(canvas, 'pointercancel', up);
    const arrow = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' };
    scope.on(window, 'keydown', (e) => {
      const tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA')) return;
      if (e.repeat) {
        if (e.code === 'Space' || arrow[e.code]) e.preventDefault();
        return;
      }
      // P pauses (Escape is left alone: on the web it closes full screen)
      if (e.code === 'KeyP') { togglePause(); return; }
      if (e.code === 'KeyM') { toggleMute(); return; }
      if (M.paused) return;   // the pause menu takes the keys: arrows to pick, Space or Enter to press
      if (HS_KEYS[e.code] && !$('#hsChoices').classList.contains('hidden')) { e.preventDefault(); chooseHandshake(HS_KEYS[e.code]); return; }
      const ka = M.keyAim || (M.keyAim = {});
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (M.cfg.first && !M.go) { M.go = true; return; }
        if (matchSkip()) return;
        M.keyDown = true;
        pressDown(null);
      } else if (arrow[e.code]) {
        e.preventDefault();
        M.keyMove[arrow[e.code]] = true;
      } else if (e.code === 'KeyW') M.keyFlick = 1;
      else if (e.code === 'KeyS') M.keyFlick = -1;
      else if (e.code === 'KeyA' || e.code === 'KeyD' || e.code === 'KeyQ') {
        ka[{ KeyA: 'l', KeyD: 'r', KeyQ: 'q' }[e.code]] = true;
        M.aimSrc = 'keys';
        if (e.code === 'KeyQ') M.keyFlick = -1;
      } else if (e.code === 'KeyC') startChallenge();
      else if (e.code === 'KeyF') celebrate();
    });
    scope.on(window, 'keyup', (e) => {
      if (arrow[e.code]) M.keyMove[arrow[e.code]] = false;
      if (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'KeyQ') M.keyFlick = 0;
      const ka = M.keyAim || (M.keyAim = {});
      if (e.code === 'KeyA') ka.l = false;
      if (e.code === 'KeyD') ka.r = false;
      if (e.code === 'KeyQ') ka.q = false;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!M.keyDown) return;
        M.keyDown = false;
        pressUp(null);
      }
    });
  }

  function togglePause(force) {
    if (!M || FSM.name !== 'MATCH_PLAY') return;
    M.paused = force !== undefined ? force : !M.paused;
    $('#pause').classList.toggle('hidden', !M.paused);
    cgPlay();
    if (M.paused) {
      M.touch.down = false;
      M.keyDown = false;
      M.chargeStart = null;
      Object.assign(M.stick, { active: false, id: null, vx: 0, vy: 0 });
      M.keyMove = { l: false, r: false, u: false, d: false };
      M.keyAim = {};
    }
  }

  function toggleMute() {
    SAVE.settings.muted = !SAVE.settings.muted;
    persist();
    applySettings();
  }

  function applySettings() {
    window.RRAudio && RRAudio.setMuted(SAVE.settings.muted);
    $('#btnMute').classList.toggle('muted', SAVE.settings.muted);
    // Each setting is a row: the name on the left, its value on the right
    const row = (id, name, val) => { const el = $(id); el.innerHTML = '<span></span><b></b>'; el.firstChild.textContent = name; el.lastChild.textContent = val; };
    row('#btnSound', 'Sound', SAVE.settings.muted ? 'Off' : 'On');
    row('#btnMusic', 'Music', SAVE.settings.music === false ? 'Off' : 'On');
    row('#btnVibe', 'Vibration', SAVE.settings.vibration ? 'On' : 'Off');
    row('#btnTiming', 'Timing help', { auto: 'Auto', always: 'Always', off: 'Off' }[SAVE.settings.timing] || 'Auto');
    row('#btnAim', 'Aim', { low: 'Fine', normal: 'Normal', high: 'Quick' }[SAVE.settings.aim] || 'Normal');
    row('#btnShort', 'After a match', SAVE.settings.short ? 'Short' : 'Full');
    row('#btnText', 'Text size', SAVE.settings.text === 'large' ? 'Large' : 'Normal');
    row('#btnFootwork', 'Footwork', SAVE.settings.footwork === 'pro' ? 'Pro' : 'Auto');
    row('#btnDifficulty', 'Difficulty', { easy: 'Easy', normal: 'Normal', hard: 'Hard' }[diffKey()]);
    row('#btnReminders', 'Reminders', SAVE.settings.reminders === false ? 'Off' : 'On');
    document.getElementById('stage').classList.toggle('big-text', SAVE.settings.text === 'large');
  }

  /* ---------- Reminders ---------- */
  // One local notification at a time, made on the phone (no server): if someone beat you last, they are still
  // talking about it; otherwise tomorrow's Daily opponent and your streak. Rescheduled whenever the title opens
  // or the app goes to the background, so a player who keeps playing never gets nagged twice in a day.
  // Permission is asked once, after your first win. Settings > Reminders turns them off.
  const NOTE_ID = 7001;
  function notesPlugin() {
    const C = window.Capacitor;
    return C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.LocalNotifications ? C.Plugins.LocalNotifications : null;
  }
  function reminderText(at) {
    const lastLoss = SAVE.lastLossTo && rivalRec(SAVE.lastLossTo) && rivalRec(SAVE.lastLossTo).last === 'l' ? SAVE.lastLossTo : null;
    if (lastLoss) {
      const sur = lastLoss.trim().split(' ').pop();
      return { title: sur + ' is still talking about it', body: pick(['They told the press it was "routine". Rematch?', 'Apparently you "looked rattled". Fancy proving them wrong?', 'They have framed the scoreline. Your rackets are furious.']) };
    }
    // The Daily of the day it arrives. Arriving today with today's Daily unplayed and a streak alive: it ends at midnight
    const day = dateKey(at);
    const d = dailyConfig(day);
    const today = day === dateKey();
    const alive = streakAlive();
    if (today && SAVE.lastPlayedDate !== day && alive >= 1) return { title: 'Your ' + alive + '-day streak ends at midnight', body: "Today's Daily Meltdown: vs " + d.opp.name + '. One match keeps it going.' };
    return { title: 'Daily Meltdown: vs ' + d.opp.name, body: alive >= 2 ? 'Keep your ' + alive + '-day streak going. Five rackets, one temper.' : 'Same conditions for everyone. Five rackets, one temper.' };
  }
  async function scheduleReminders() {
    const N = notesPlugin();
    if (!N) return;
    try {
      await N.cancel({ notifications: [{ id: NOTE_ID }] });
      if (SAVE.settings.reminders === false || !SAVE.tutorialDone || !SAVE.notifAsked) return;
      const perm = await N.checkPermissions();
      if (perm.display !== 'granted') return;
      // The next 6 pm at least six hours away
      const at = new Date();
      at.setHours(18, 0, 0, 0);
      // and never on a day whose Daily you have already played
      while (at.getTime() - Date.now() < 6 * 3600 * 1000 || dateKey(at) === SAVE.lastPlayedDate) at.setDate(at.getDate() + 1);
      const t = reminderText(at);
      await N.schedule({ notifications: [{ id: NOTE_ID, title: t.title, body: t.body, schedule: { at: at, allowWhileIdle: true } }] });
    } catch (e) { /* no reminder is not worth bothering anyone about */ }
  }
  async function askReminders() {
    const N = notesPlugin();
    if (!N || SAVE.notifAsked || SAVE.settings.reminders === false) return;
    SAVE.notifAsked = true;
    persist();
    try { await N.requestPermissions(); } catch (e) { /* declined or unavailable */ }
    scheduleReminders();
  }

  /* ---------- MENU ---------- */
  // The title theme (audio.js 'title'): on while the title screen is up, if Music is on
  let titleTheme = null;
  function titleMusic(on) {
    if (!on || SAVE.settings.music === false) { if (titleTheme) { titleTheme.stop(); titleTheme = null; } return; }
    if (titleTheme || !window.RRAudio) return;
    const h = RRAudio.loop('title');
    if (!h.dummy) titleTheme = h;
  }
  // The title screen's stadium: a borrowed match object for the venue, crowd and kit, never the real match
  const TITLE = { m: null, bg: null, key: '', t: 0, act: null, actT: 0, taps: 0, say: null, sayT: 0 };
  const TITLE_LINES = ['I am completely calm.', 'Who designed this net?', 'Five rackets. Plenty.', 'The umpire knows what they did.', 'Breathe. In. Out. RAAAH.'];
  function titleScene() {
    const tierIdx = SAVE.careerComplete ? TIERS.length - 1 : SAVE.careerTier;
    const key = tierIdx + ':' + scale + ':' + BX + ':' + BY;
    if (TITLE.key !== key || !TITLE.m) {
      const prevM = M;
      const prevBg = bgCache;
      const tier = TIERS[tierIdx];
      newMatch({ mode: 'career', tierIdx: tierIdx, round: 0, label: '', surface: tier.surface, games: 6, opp: OPPONENTS[tierIdx][0], skill: 0.5, strict: 0.5, ref: '', cheatRate: 0, wind: 0, fine: 0, rackets: 5, maxRackets: 5, crowd: tier.crowd, seed: 777 + tierIdx });
      TITLE.m = M;
      TITLE.bg = buildBackground(M.cfg.surface, M.cfg.seed);
      TITLE.key = key;
      M = prevM;
      bgCache = prevBg;
    }
    return TITLE;
  }
  // Tap the player: your equipped celebration, then a tantrum, in turn
  function titlePerform() {
    if (TITLE.act) return;
    TITLE.taps++;
    const tantrum = TITLE.taps % 2 === 0;
    TITLE.act = tantrum ? 'spike' : celebItem().style;
    TITLE.actT = 0;
    TITLE.say = null;
    if (tantrum) { sfx('scream', { pitch: 1 }); setTimeout(() => { sfx('frame'); sfx('crunch'); }, SMASH_T * 1000); } else sfx('applause', { power: 0.9 });
    vibrate(25);
  }
  function titleUpdate(dt) {
    const S = titleScene();
    S.t += dt;
    // Until the lesson is done, the title shows what the game is about: a racket meets the court
    if (TITLE.autoSmash > 0) { TITLE.autoSmash -= dt; if (TITLE.autoSmash <= 0 && !S.act) { TITLE.taps = 1; titlePerform(); } }
    const m = S.m;
    m.time += dt;
    m.hype = S.act ? 0.9 : 0.25 + 0.2 * Math.max(0, Math.sin(S.t * 0.7));
    m.crowdMood = S.act ? { kind: S.act === 'spike' ? 'gasp' : 'wild', t: 0, dur: 1 } : null;
    // A wave around the ground every so often
    if (m.waveT < 0 && (S.t % 11) < dt) m.waveT = 0;
    if (m.waveT >= 0) { m.waveT += dt; if (m.waveT > 2.6) m.waveT = -1; }
    if (S.act) {
      S.actT += dt;
      if (S.actT > (S.act === 'spike' ? 3.4 : CELEB_LEN + 0.3)) S.act = null;
    } else {
      // Something to do with his hands: bounce the ball, twirl the racket, check the strings
      S.idleT = (S.idleT || 0) + dt;
      if (!S.idle && S.idleT > 3.4) { S.idle = { kind: pick(['bounce', 'twirl', 'strings']), t: 0 }; S.idleT = 0; }
      if (S.idle) { S.idle.t += dt; if (S.idle.t > 1.7) S.idle = null; }
      // A mutter now and then
      S.sayT += dt;
      if (!S.say && S.sayT > 5) { S.say = pick(TITLE_LINES); S.sayT = 0; }
      if (S.say && S.sayT > 2.4) { S.say = null; S.sayT = 0; }
    }
  }
  // The title's stadium (picture, crowd, boards, fans, foreground) painted once into one canvas: redrawing the
  // crowd and fans every frame under the slow camera drift held the title to about 25 fps on a phone
  const TSTILL = { c: null, key: '' };
  function drawTitleStands(ctx) {
    const bg = bgCache.bg;
    const key = TITLE.key + ':' + bg.width + 'x' + bg.height;
    if (TSTILL.key !== key || !TSTILL.c || TSTILL.bg !== bg) {
      if (!TSTILL.c || TSTILL.c.width !== bg.width || TSTILL.c.height !== bg.height) {
        TSTILL.c = document.createElement('canvas');
        TSTILL.c.width = bg.width;
        TSTILL.c.height = bg.height;
      }
      const k = bg.width / (W + 2 * BX);
      const sc = TSTILL.c.getContext('2d');
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, TSTILL.c.width, TSTILL.c.height);
      sc.setTransform(k, 0, 0, k, BX * k, BY * k);
      sc.drawImage(bg, -BX, -BY, W + 2 * BX, H + 2 * BY);
      drawCrowd(sc);
      drawBoards(sc);
      drawFans(sc);
      if (bgCache.fg) sc.drawImage(bgCache.fg, -BX, -BY, W + 2 * BX, H + 2 * BY);
      TSTILL.key = key;
      TSTILL.bg = bg;
    }
    ctx.drawImage(TSTILL.c, -BX, -BY, W + 2 * BX, H + 2 * BY);
  }
  // Builds and paints the title once, off screen, while the studio splash holds its logo, so the title
  // appears without the build stalling its first frames
  function warmTitle() {
    try {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 32;
      titleRender(c.getContext('2d'));
    } catch (e) { /* the title builds itself when it opens anyway */ }
  }
  function titleRender(ctx) {
    const S = titleScene();
    const prevM = M;
    const prevBg = bgCache;
    M = S.m;
    bgCache = S.bg;
    // The stadium, with a slow drift
    const z = reduceMotion ? 1.06 : 1.08 + 0.02 * Math.sin(S.t * 0.15);
    const px = reduceMotion ? 0 : Math.sin(S.t * 0.11) * 18;
    ctx.save();
    ctx.translate(640 + px, 330);
    ctx.scale(z, z);
    ctx.translate(-640, -360);
    drawTitleStands(ctx);
    // Cloud shadows drifting over the ground at the outdoor venues
    if (!reduceMotion && /club|council|invitational/.test(bgCache.geo ? bgCache.geo.VK : '')) {
      for (let i = 0; i < 3; i++) {
        const cx = ((S.t * 28 + i * 760) % 2300) - 600;
        const cy = 260 + i * 150;
        const g2 = ctx.createRadialGradient(cx, cy, 20, cx, cy, 300);
        g2.addColorStop(0, 'rgba(10,25,35,0.2)');
        g2.addColorStop(1, 'rgba(10,25,35,0)');
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.42);
        ctx.translate(-cx, -cy);
        ctx.fillStyle = g2;
        ctx.fillRect(cx - 300, cy - 300, 600, 600);
        ctx.restore();
      }
    }
    ctx.restore();
    // Shade the left for the title, and the bottom for the buttons
    const gl = ctx.createLinearGradient(-BX, 0, 760, 0);
    gl.addColorStop(0, 'rgba(4,12,7,0.86)');
    gl.addColorStop(0.55, 'rgba(4,12,7,0.55)');
    gl.addColorStop(1, 'rgba(4,12,7,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(-BX, -BY, 760 + BX, H + 2 * BY);
    const gb = ctx.createLinearGradient(0, 520, 0, H + BY);
    gb.addColorStop(0, 'rgba(4,12,7,0)');
    gb.addColorStop(1, 'rgba(4,12,7,0.75)');
    ctx.fillStyle = gb;
    ctx.fillRect(-BX, 520, W + 2 * BX, H + BY - 520);
    // You, on court, in your kit
    const kit = Object.assign({ skin: '#e7b892', hair: '#3a2716' }, playerKit());
    ctx.save();
    ctx.translate(900, 585);
    ctx.scale(0.86, 0.86);
    ctx.translate(-PX, -FLOOR_Y);
    if (S.act) renderRoutine(ctx, S.actT, S.act, kit, [], []);
    else {
      const bob = reduceMotion ? 0 : Math.abs(Math.sin(S.t * 3.2)) * 6;
      let butt = { x: PX + 0.3 * KP, y: 470 - bob };
      let ang = -Math.PI / 2 + 0.3;
      const body = { x: PX, jump: bob, crouch: 0.15, mouth: S.say ? 0.4 : 0, brow: 1, steam: true, say: S.say };
      const idle = reduceMotion ? null : S.idle;
      let ball = null;
      if (idle && idle.kind === 'bounce') {
        // Racket flat, ball bouncing on the strings
        butt = { x: PX + 0.12 * KP, y: 420 - bob };
        ang = -0.12;
        const head = { x: butt.x + Math.cos(ang) * RL * 0.72, y: butt.y + Math.sin(ang) * RL * 0.72 };
        ball = { x: head.x, y: head.y - 10 - Math.abs(Math.sin(idle.t * 7)) * 70 };
      } else if (idle && idle.kind === 'twirl') {
        ang += idle.t * 14;
      } else if (idle && idle.kind === 'strings') {
        // Holding the strings up to the face, unimpressed
        butt = { x: PX + 0.12 * KP, y: 345 - bob };
        ang = -Math.PI / 2 - 0.15;
        body.mouth = 0;
        body.brow = -0.2;
        body.say = body.say || 'Hmm.';
      }
      body.hands = grip(butt, ang);
      const rk = Object.assign({ len: RL, color: kit.racket }, { x: butt.x, y: butt.y, ang: ang, t: S.t });
      puppetShadow(ctx, body);
      withOutline(ctx, puppetBox(body, rk), (c) => {
        const arms = drawPuppet(c, body, S.t, kit);
        drawRacketShape(c, rk);
        arms();
      });
      if (ball) {
        ctx.fillStyle = '#d9f24a';
        ctx.strokeStyle = '#0b0b0b';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    M = prevM;
    bgCache = prevBg;
  }

  FSM.states.MENU = {
    screen: 'menu',
    enter(p, scope) {
      const key = dateKey();
      const d = dailyConfig(key);
      const playedToday = SAVE.lastPlayedDate === key;
      // Top bar
      if (chipMoneyShown !== null && SAVE.prizeMoney > chipMoneyShown) { const from = chipMoneyShown; setTimeout(() => countUp($('#chipMoney'), SAVE.prizeMoney, money, from), 500); }
      else $('#chipMoney').textContent = money(SAVE.prizeMoney);
      chipMoneyShown = SAVE.prizeMoney;
      $('#chipRackets').textContent = SAVE.remainingRackets + ' in your tour bag';
      // Trophies won, and the way into the Trophy Room
      const tally = awardTally();
      $('#trophyCount').textContent = tally.n + '/' + tally.total;
      scope.on($('#btnTrophies'), 'click', () => { click(); openTrophies(); });
      // PLAY: the lesson first time, then the tour
      $('#playSub').textContent = !SAVE.tutorialDone ? 'Your first match' : SAVE.careerComplete ? 'Champion. Play on' : 'Grudge Tour: ' + TIERS[SAVE.careerTier].short;
      // Daily tile, and its details panel
      // The streak, on the tile: kept today, or there to keep
      const streakTile = streakAlive();
      $('#dailyTileSub').textContent = playedToday && SAVE.lastDaily
        ? (SAVE.lastDaily.won ? 'Won ' : 'Lost ') + SAVE.lastDaily.score + (streakTile >= 2 ? '  |  ' + streakTile + '-day streak' : '')
        : streakTile >= 2 ? 'Keep your ' + streakTile + '-day streak' : 'vs ' + String(d.opp.name).trim().split(/\s+/).pop();
      $('#btnDailyTile').classList.toggle('streak', streakTile >= 2);
      // Today's Daily done: Quick Match is the next thing to play (the career stays the big button)
      $('#btnQuickTile').classList.toggle('suggest', playedToday);
      $('#btnQuickTile small').textContent = playedToday ? 'Daily done. One more?' : 'First to 3, win by 2';
      $('#btnDailyTile').classList.toggle('done', playedToday);
      $('#dailyDate').textContent = prettyDate(key);
      $('#dTwist').innerHTML = '<b></b> <span></span>';
      $('#dTwist b').textContent = d.twist ? d.twist.name + '.' : '';
      $('#dTwist span').textContent = d.twist ? d.twist.line : '';
      $('#dOpp').textContent = d.opp.name;
      $('#dTraits').textContent = d.opp.traits.map((t) => TRAIT_LABEL[t]).join(', ');
      $('#dSkill').textContent = skillLabel(d.skill);
      $('#dRef').textContent = d.ref + ', ' + strictLabel(d.strict);
      $('#dWind').textContent = d.wind ? Math.abs(d.wind) + ' mph, blowing ' + (d.wind > 0 ? 'right' : 'left') : 'Still';
      $('#dRackets').textContent = d.rackets + ' in the bag';
      const streakNow = streakAlive();
      $('#dStreak').textContent = streakNow + (streakNow === 1 ? ' day' : ' days') + ((SAVE.streakShields || 0) > 0 ? '  |  ' + SAVE.streakShields + ' shield' + (SAVE.streakShields > 1 ? 's' : '') : '');
      const mine = fillClubhouse($('#dTable'), key);
      $('#dTableNote').textContent = mine === null ? 'Today\'s regulars. Play the Daily Meltdown to get on the board.' : 'Your official score today: ' + mine + '. Replays do not count.';
      $('#btnDaily').textContent = playedToday ? 'Practice' : 'Play Today';
      $('#dailyNote').textContent = playedToday && SAVE.lastDaily
        ? 'Today\'s official result: ' + (SAVE.lastDaily.won ? 'Win' : 'Loss') + ' ' + SAVE.lastDaily.score + '. Replays are practice.'
        : 'Same conditions for everyone today. New meltdown at midnight.';
      if (playedToday) $('#dailyNote').textContent += ' ' + tomorrowLine();
      applySettings();
      if (p && p.toast) toast(p.toast, 3600);
      const click = () => sfx('click');
      const panel = (id, on) => $(id).classList.toggle('show', on);
      $('#btnQuickTile').classList.toggle('hidden', !SAVE.tutorialDone);
      // A first-time player sees one thing to do: PLAY. The other modes and the money appear after the lesson.
      const fresh = !SAVE.tutorialDone;
      $('#btnDailyTile').classList.toggle('hidden', fresh);
      $('#btnLocker').classList.toggle('hidden', fresh);
      document.querySelector('#menu .chips').classList.toggle('hidden', fresh);
      document.querySelector('#menu .title-actions').classList.toggle('first-run', fresh);
      scope.on($('#btnQuickTile'), 'click', () => {
        click();
        newMatch(quickConfig());
        FSM.change('MATCH_PLAY', { fresh: true });
      });
      // A match was left unfinished when the app closed: pick it up, or retire from it (a retirement is a loss)
      const rs = pendingResume();
      $('#resumeModal').classList.toggle('hidden', !rs);
      if (rs) {
        $('#resumeLine').textContent = (rs.cfg.mode === 'daily' ? 'Daily Meltdown' : rs.cfg.label) + ' against ' + rs.cfg.opp.name + '. Games ' + rs.snap.games[0] + '-' + rs.snap.games[1] + '.';
        scope.on($('#btnResumeGo'), 'click', () => {
          click();
          $('#resumeModal').classList.add('hidden');
          restoreMatch(rs);
          FSM.change('MATCH_PLAY', { fresh: true });
        });
        scope.on($('#btnResumeRetire'), 'click', () => {
          click();
          $('#resumeModal').classList.add('hidden');
          restoreMatch(rs);
          FSM.change('MATCH_PLAY', { fresh: true });
          M.matchWinner = 1;
          finishMatch('retired');
        });
      }
      scope.on($('#btnCareer'), 'click', () => {
        click();
        // First time in: the first match, then the tour (the lesson is optional, under How to Play)
        if (!SAVE.tutorialDone) { newMatch(firstConfig()); FSM.change('MATCH_PLAY', { fresh: true }); }
        else FSM.change('CAREER_HUB');
      });
      scope.on($('#btnPractice'), 'click', () => { click(); $('#practiceModal').classList.remove('hidden'); });
      scope.on($('#btnPracticeBack'), 'click', () => { click(); $('#practiceModal').classList.add('hidden'); });
      document.querySelectorAll('#practiceModal [data-drill]').forEach((b) => scope.on(b, 'click', () => {
        click();
        $('#practiceModal').classList.add('hidden');
        panel('#how', false);
        newMatch(practiceConfig(b.dataset.drill));
        FSM.change('MATCH_PLAY', { fresh: true });
      }));
      scope.on($('#btnLesson'), 'click', () => {
        click();
        panel('#how', false);
        const lesson = tutorialConfig();
        lesson.replay = !!SAVE.tutorialDone;
        newMatch(lesson);
        FSM.change('MATCH_PLAY', { fresh: true });
      });
      scope.on($('#btnLocker'), 'click', () => { click(); FSM.change('LOCKER_ROOM', { from: 'MENU' }); });
      scope.on($('#btnDailyTile'), 'click', () => { click(); panel('#dailyPanel', true); });
      scope.on($('#btnDailyBack'), 'click', () => { click(); panel('#dailyPanel', false); });
      scope.on($('#btnDaily'), 'click', () => {
        click();
        panel('#dailyPanel', false);
        newMatch(dailyConfig(key));
        FSM.change('MATCH_PLAY', { fresh: true });
      });
      scope.on($('#btnHow'), 'click', () => { click(); markLearned(); panel('#how', true); });
      scope.on($('#btnHowBack'), 'click', () => { click(); panel('#how', false); });
      scope.on($('#btnSettings'), 'click', () => { click(); panel('#settingsPanel', true); });
      scope.on($('#btnSettingsBack'), 'click', () => { click(); panel('#settingsPanel', false); });
      scope.on($('#menuPlayer'), 'click', () => titlePerform());
      scope.on($('#btnSound'), 'click', () => { toggleMute(); click(); $('#settingsNote').textContent = SAVE.settings.muted ? 'All sound off. The umpire mimes.' : 'Sound on: the crowd, the umpire and every racket you break.'; });
      scope.on($('#btnMusic'), 'click', () => {
        SAVE.settings.music = SAVE.settings.music === false;
        persist();
        applySettings();
        $('#settingsNote').textContent = SAVE.settings.music !== false ? 'The title theme plays on the title screen.' : 'No music. Sound effects stay on.';
        titleMusic(SAVE.settings.music !== false);
        click();
      });
      // The title theme, from the first tap (sound may only start after one), until you leave the title
      titleMusic(true);
      scope.add(() => titleMusic(false));
      if (!SAVE.tutorialDone) TITLE.autoSmash = 1.6;
      scheduleReminders();
      scope.on($('#btnVibe'), 'click', () => {
        SAVE.settings.vibration = !SAVE.settings.vibration;
        persist();
        applySettings();
        $('#settingsNote').textContent = SAVE.settings.vibration ? 'The phone buzzes on big hits, smashes and bad calls.' : 'No buzzing.';
        vibrate(30);
        click();
      });
      const cycle = (key, order, note) => {
        SAVE.settings[key] = order[(order.indexOf(SAVE.settings[key]) + 1) % order.length];
        persist();
        applySettings();
        $('#settingsNote').textContent = note[SAVE.settings[key]];
        click();
      };
      scope.on($('#btnTiming'), 'click', () => cycle('timing', ['auto', 'always', 'off'], {
        auto: 'A wider hitting window at the club, easing off as you climb. Gone by Tunbridge.',
        always: 'The club\'s wider hitting window at every venue. Nobody needs to know.',
        off: 'The real window everywhere. Purists only.'
      }));
      scope.on($('#btnText'), 'click', () => cycle('text', ['normal', 'large'], {
        normal: 'Menus and the scoreboard at their usual size.',
        large: 'Bigger words in the menus, the press room and the scoreboard.'
      }));
      $('#buildTag').textContent = 'Build ' + BUILD + (FPS.on ? '. Frame meter on' : '');
      const speedLabels = () => {
        $('#speedTest').classList.toggle('hidden', !FPS.on);
        $('#dbgOutline').textContent = 'Outlines: ' + (OUTLINE_OFF ? 'Off' : 'On');
        const savedRes = SAVE.settings.res === 2 ? 2 : 1.5;
        $('#dbgRes').textContent = 'Resolution: ' + savedRes + 'x' + (savedRes !== RES.cap ? ' after restart' : '');
        $('#dbgPace').textContent = 'Pacing: ' + (PACE.off ? 'Off' : 'Auto');
      };
      speedLabels();
      scope.on($('#buildTag'), 'click', () => {
        FPS.on = !FPS.on;
        $('#buildTag').textContent = 'Build ' + BUILD + (FPS.on ? '. Frame meter on' : '');
        speedLabels();
      });
      scope.on($('#dbgOutline'), 'click', () => { OUTLINE_OFF = !OUTLINE_OFF; speedLabels(); });
      scope.on($('#dbgRes'), 'click', () => {
        SAVE.settings.res = SAVE.settings.res === 2 ? 1.5 : 2;
        persist();
        speedLabels();
      });
      scope.on($('#dbgPace'), 'click', () => { PACE.off = !PACE.off; if (PACE.off) PACE.lock = false; speedLabels(); });
      scope.on($('#btnFootwork'), 'click', () => cycle('footwork', ['auto', 'pro'], {
        auto: ctl('footAuto'),
        pro: ctl('footPro')
      }));
      scope.on($('#btnReminders'), 'click', () => {
        cycle('reminders', [true, false], {
          true: 'At most one a day, about 6 pm: a rival with something to say, or tomorrow\'s Daily Meltdown.',
          false: 'No reminders. The rackets will wait.'
        });
        if (SAVE.settings.reminders !== false && !SAVE.notifAsked && SAVE.tutorialDone) askReminders();
        else scheduleReminders();
      });
      scope.on($('#btnDifficulty'), 'click', () => {
        SAVE.settings.difficulty = diffKey();
        SAVE.settings.gentle = false;
        cycle('difficulty', ['easy', 'normal', 'hard'], {
          easy: 'Easy: a wider hitting window, a slower serve bar, slower opponents and calmer meltdowns. Same prize money.',
          normal: 'Normal: the game as it was meant to be lost.',
          hard: 'Hard: a tight window, quicker opponents who read repeated shots, stricter umpires and sneakier meltdowns. 1.5x prize money.'
        });
      });
      scope.on($('#btnShort'), 'click', () => cycle('short', [false, true], {
        false: 'The full show: the replay, the press and tomorrow\'s paper.',
        true: 'Straight to the press, then the next match. No replay, no paper.'
      }));
      scope.on($('#btnAim', ), 'click', () => cycle('aim', ['normal', 'low', 'high'], {
        normal: ctl('aimNormal'),
        low: ctl('aimLow'),
        high: ctl('aimHigh')
      }));
    },
    update(dt) { titleUpdate(dt); },
    render(ctx) { titleRender(ctx); },
    exit() { ['#how', '#dailyPanel', '#settingsPanel'].forEach((id) => $(id).classList.remove('show')); $('#resumeModal').classList.add('hidden'); }
  };

  /* ---------- CAREER_HUB ---------- */
  function repLabel(r) {
    if (r <= -60) return 'Pantomime Villain';
    if (r <= -25) return 'Crowd Villain';
    if (r < 25) return 'Unknown Quantity';
    if (r < 60) return 'Fan Favourite';
    return 'Nation\'s Darling';
  }
  function racketIcons(n, total) {
    let html = '';
    for (let i = 0; i < total; i++) html += '<i class="rk' + (i < n ? '' : ' broken') + '"></i>';
    return html;
  }

  // The three ways to play, as chosen after the lesson
  const PLAY_STYLES = {
    relaxed: { footwork: 'auto', difficulty: 'easy', toast: 'Relaxed it is: Easy. Derek approves. Change it any time: Difficulty, top right.' },
    standard: { footwork: 'auto', difficulty: 'normal', toast: 'Standard it is. The full challenge. Change it any time: Difficulty, top right.' },
    pro: { footwork: 'pro', difficulty: 'normal', toast: 'Pro it is. Your legs are your own problem now. Footwork is in Settings.' }
  };
  FSM.states.CAREER_HUB = {
    screen: 'hub',
    enter(p, scope) {
      const done = SAVE.careerComplete;
      const tierIdx = SAVE.careerTier;
      const tier = TIERS[tierIdx];
      const round = SAVE.tournamentRound;
      const opp = seasonOpp(careerOpponent(tierIdx, round));
      const strict = effectiveStrict(tier.strict);

      const ladder = $('#ladder');
      ladder.innerHTML = '';
      TIERS.forEach((t, i) => {
        const li = document.createElement('li');
        const won = done || i < tierIdx;
        const times = (SAVE.titles && SAVE.titles['t' + i]) || (SAVE.unlockedTrophies.indexOf('t' + i) >= 0 ? 1 : 0);
        li.className = won ? 'done' : i === tierIdx && !done ? 'current' : i > tierIdx ? 'locked' : '';
        li.innerHTML = '<span class="n"></span><div><b></b><small></small></div>';
        li.querySelector('.n').textContent = won ? '✓' : String(i + 1);
        li.querySelector('b').textContent = t.short;
        li.querySelector('small').textContent = won ? t.trophy + (times > 1 ? ' won x' + times : ' won') : i === tierIdx ? 'In progress' : t.surface === 'indoor' ? 'Indoor carpet' : t.surface.charAt(0).toUpperCase() + t.surface.slice(1) + ' court';
        ladder.appendChild(li);
      });
      // Tap Record to turn the poster over: your career in numbers
      const st = SAVE.stats;
      const titles = TIERS.reduce((sum, t, i) => sum + Math.max((SAVE.titles && SAVE.titles['t' + i]) || 0, SAVE.unlockedTrophies.indexOf('t' + i) >= 0 ? 1 : 0), 0);
      const rows = [
        ['Season', season()],
        ['Won', st.matchesWon + ' of ' + (st.matchesWon + st.matchesLost)],
        ['Titles', titles],
        ['Rackets smashed', st.racketsSmashed],
        ['Aces', st.aces],
        ['Code violations', st.codeViolations],
        ['Fines paid', money(SAVE.totalFines)],
        ['Handshakes refused', st.tooSlow || 0],
        ['Fastest serve', st.fastestServe ? st.fastestServe + ' mph' : 'None yet']
      ];
      ['grass', 'hard', 'indoor', 'clay'].forEach((k) => {
        const sf = (SAVE.surf && SAVE.surf[k]) || { w: 0, l: 0 };
        rows.push([(k === 'indoor' ? 'Indoor' : k.charAt(0).toUpperCase() + k.slice(1)) + ' won-lost', sf.w + '-' + sf.l]);
      });
      const rec = $('#recordStats');
      rec.innerHTML = '';
      rows.forEach((r) => { const d = document.createElement('div'); d.innerHTML = '<small></small><b></b>'; d.firstChild.textContent = r[0]; d.lastChild.textContent = String(r[1]); rec.appendChild(d); });
      const achEl = $('#recordAch');
      achEl.innerHTML = '';
      const have = SAVE.ach || {};
      // The same achievements, and the same count, as the Trophy Room (the ones that come with a trophy live there as trophies)
      const solo = soloAch();
      solo.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ach' + (have[a.id] ? ' got' : '');
        b.textContent = a.name;
        b.addEventListener('click', () => { $('#recordAchNote').textContent = a.name + ': ' + a.desc + (have[a.id] ? ' Done.' : ''); });
        achEl.appendChild(b);
      });
      $('#recordAchCount').textContent = solo.filter((a) => have[a.id]).length + ' of ' + solo.length;
      $('#recordAchNote').textContent = tapify('Tap one to see how to get it. Trophies are in the Trophy Room.');
      scope.on($('#btnRecord'), 'click', () => { sfx('click'); $('#recordModal').classList.remove('hidden'); });
      scope.on($('#btnRecordClose'), 'click', () => { sfx('click'); $('#recordModal').classList.add('hidden'); });
      const shelf = $('#trophyShelf');
      shelf.innerHTML = '';
      if (!SAVE.unlockedTrophies.length) shelf.innerHTML = '<span class="trophy none">Empty. Like the trophy cabinet of a person who smashes rackets.</span>';
      SAVE.unlockedTrophies.forEach((id) => {
        const s = document.createElement('span');
        s.className = 'trophy';
        s.textContent = TROPHIES[id];
        shelf.appendChild(s);
      });

      if (done) {
        $('#hubKicker').textContent = season() > 1 ? 'Season ' + season() + ' complete' : 'Career complete';
        $('#hubTitle').textContent = 'Grand Slam Champion';
        $('#hubVenue').textContent = '';
        $('#hubRounds').innerHTML = '';
      } else {
        // The tag stays short so it is never cut off; the venue gets its own line under the name
        $('#hubKicker').textContent = (season() > 1 ? 'Season ' + season() + '. ' : '') + 'Tier ' + (tierIdx + 1) + ' of 5';
        $('#hubTitle').textContent = tier.name;
        $('#hubVenue').textContent = tier.venue + '.';
        $('#hubRounds').innerHTML = ROUNDS.map((r, i) => '<span class="' + (i < round ? 'won' : i === round ? 'now' : '') + '">' + r + '</span>').join('');
      }
      const face = $('#oppFace');
      face.style.setProperty('--face', opp.face);
      face.style.setProperty('--band', opp.band);
      // Their portrait, as they look on court, wearing the face your history together has earned
      face.innerHTML = '';
      if (!done) {
        const pc = renderFigure(opp, rivalMood(opp), 200, 200, 'bust');
        face.appendChild(pc);
      }
      face.classList.toggle('has-portrait', !done);
      $('#oppName').textContent = done ? (season() > 1 ? 'Nobody left to beat. Again.' : 'Nobody left to beat') : opp.name;
      $('#oppTags').innerHTML = '';
      if (!done) {
        opp.traits.concat(['style', 'skill']).forEach((t) => {
          const s = document.createElement('span');
          s.className = 'tag' + (t === 'skill' ? ' skill' : '');
          s.textContent = t === 'skill' ? skillLabel(opp.skill) : t === 'style' ? STYLES[styleKey(opp)].label : TRAIT_LABEL[t];
          $('#oppTags').appendChild(s);
        });
        const h2h = rivalRec(opp.name);
        const hs = document.createElement('span');
        hs.className = 'tag h2h';
        hs.textContent = h2h ? 'Head to head ' + h2h.w + '-' + h2h.l : 'First meeting';
        $('#oppTags').appendChild(hs);
      }
      const rvr = rivalRec(opp.name);
      $('#oppBio').textContent = done ? 'You could start again from the tea hut. The rackets would rather you did not.' : (rvr && isNemesis(opp.name) && !opp.nemesis ? 'Your nemesis. ' : '') + opp.bio;
      $('#hubRackets').innerHTML = racketIcons(SAVE.remainingRackets, 5);
      // A spare racket from the stringer, while the bag has room
      const spare = sparePrice(tierIdx);
      const buy = $('#btnBuyRacket');
      buy.classList.toggle('hidden', done || SAVE.remainingRackets >= 5);
      buy.textContent = '+1 for ' + money(spare);
      scope.on(buy, 'click', () => {
        if (done || SAVE.remainingRackets >= 5) return;
        if (SAVE.prizeMoney < spare) { sfx('click'); toast('A spare costs ' + money(spare) + '. You are ' + money(spare - SAVE.prizeMoney) + ' short.'); return; }
        SAVE.prizeMoney -= spare;
        SAVE.remainingRackets = Math.min(5, SAVE.remainingRackets + 1);
        persist();
        sfx('coins');
        FSM.change('CAREER_HUB', { toast: 'One fresh racket from the stringer, for ' + money(spare) + '. Try to keep this one.' });
      });
      // Once a day, the stringer delivers a spare for an advert (instantly with the Pro Pack)
      const adr = $('#btnAdRacket');
      const freeTour = !done && SAVE.remainingRackets < 5 && !SAVE.freeSpareUsed;
      const adFree = freeTour || (!done && SAVE.remainingRackets < 5 && SAVE.adRacketDay !== dateKey() && adOk());
      adr.classList.toggle('hidden', !adFree);
      adr.textContent = freeTour ? 'Free spare' : isPro() ? 'Free today (Pro)' : 'Free: watch an advert';
      scope.on(adr, 'click', () => {
        if (adr.disabled || done || SAVE.remainingRackets >= 5) return;
        if (!SAVE.freeSpareUsed) {
          // One on the house each tournament: no advert, no catch
          SAVE.freeSpareUsed = true;
          SAVE.remainingRackets = Math.min(5, SAVE.remainingRackets + 1);
          persist();
          sfx('coins');
          FSM.change('CAREER_HUB', { toast: 'The stringer gives you one on the house. Once a tournament.' });
          return;
        }
        adr.disabled = true;
        sfx('click');
        rewardedAd(scope, $('#hubAdMsg'), 'Advert playing. The stringer is on his way.').then((ok) => {
          adr.disabled = false;
          if (!ok) { toast($('#hubAdMsg').textContent || 'No advert available right now.'); return; }
          SAVE.adRacketDay = dateKey();
          SAVE.remainingRackets = Math.min(5, SAVE.remainingRackets + 1);
          persist();
          sfx('coins');
          FSM.change('CAREER_HUB', { toast: 'A free spare from the stringer. Same time tomorrow.' });
        });
      });
      // The sponsor's bet on your next match: a chip by your prize money that explains itself before any advert
      const betBtn = $('#btnBet');
      const betShow = () => {
        betBtn.classList.toggle('hidden', !adOk() && !SAVE.sponsorBet);
        betBtn.textContent = SAVE.sponsorBet ? 'Bet on' : 'Bet';
        betBtn.classList.toggle('on', !!SAVE.sponsorBet);
      };
      betShow();
      scope.on(betBtn, 'click', () => {
        sfx('click');
        offerBet(scope, $('#betRow'), $('#btnBetGo'), $('#betNote'), $('#betMsg'), () => { betShow(); $('#btnBetClose').textContent = 'Done'; });
        $('#btnBetClose').textContent = SAVE.sponsorBet ? 'Done' : 'Not Now';
        $('#betModal').classList.remove('hidden');
      });
      scope.on($('#btnBetClose'), 'click', () => { sfx('click'); $('#betModal').classList.add('hidden'); });
      // What you are saving for
      const goal = nextGoal();
      $('#hubGoal').classList.toggle('hidden', !goal);
      if (goal) {
        const can = SAVE.prizeMoney >= goal.price;
        $('#goalName').textContent = goal.name;
        $('#goalLeft').textContent = can ? 'You can afford it' : money(goal.price - SAVE.prizeMoney) + ' to go';
        $('#goalFill').style.width = Math.round(Math.min(1, SAVE.prizeMoney / goal.price) * 100) + '%';
        scope.on($('#hubGoal'), 'click', () => { sfx('click'); FSM.change('LOCKER_ROOM', { from: 'CAREER_HUB', cat: goal.cat }); });
      }
      $('#hubRef').textContent = tier.ref;
      $('#hubRefLabel').textContent = officialTitle({ mode: 'career', tierIdx: tierIdx, surface: tier.surface });
      $('#hubRefNote').textContent = strictLabel(strict) + '. Meltdowns start with ' + meltWave(strict, 0).angry + ' thoughts to swat.';
      $('#hubFines').textContent = money(SAVE.totalFines);
      $('#hubBank').textContent = money(SAVE.prizeMoney);
      const rep = SAVE.reputationScore;
      $('#repPip').style.left = (50 + rep / 2) + '%';
      $('#repLabel').textContent = repLabel(rep);
      $('#hubRepShort').textContent = repLabel(rep);
      $('#repNote').textContent = 'Sponsor: ' + sponsorKit().sponsor.replace(/\.$/, '') + '. ' + SPONSOR_DEALS[sponsorKit().sponsor].desc + ' Umpires are ' + (rep < -20 ? 'watching you closely.' : rep > 20 ? 'inclined to give you the benefit of the doubt.' : 'reserving judgement.');
      $('#btnWalkOn').textContent = done ? 'Start Grudge Tour+' : 'Walk On Court';

      scope.on($('#btnWalkOn'), 'click', () => {
        sfx('click');
        if (SAVE.careerComplete) {
          // A new season: keep the money, the kit, the trophies and every grudge
          SAVE.season = season() + 1;
          Object.assign(SAVE, { careerTier: 0, tournamentRound: 0, remainingRackets: 5, careerComplete: false, tournamentSmashed: 0, tournamentFines: 0, freeSpareUsed: false });
          persist();
          FSM.change('CAREER_HUB', { toast: 'Grudge Tour+ season ' + SAVE.season + '. Everyone is better. Everyone remembers you.' });
          return;
        }
        const go = () => { $('#backModal').classList.add('hidden'); newMatch(careerMatchConfig()); FSM.change('MATCH_PLAY', { fresh: true }); };
        const rv = rivalRec(opp.name);
        const key = rv ? opp.name + ':' + (rv.w + rv.l) + ':' + SAVE.careerTier + ':' + SAVE.tournamentRound : null;
        if (rv && SAVE.backPageKey !== key) {
          // A rematch: the back pages have been waiting for this
          SAVE.backPageKey = key;
          persist();
          const page = buildBackPage(opp, rv);
          $('#backImg').src = page.toDataURL('image/png');
          $('#backModal').classList.remove('hidden');
          sfx('whoosh', { power: 0.6 });
          scope.on($('#btnBackShare'), 'click', () => { sfx('click'); shareCanvas(page, 'The rematch: me vs ' + opp.name + ' | Racket Rage Tennis', 'racket-rage-back-page.png'); });
          scope.on($('#btnBackGo'), 'click', () => { sfx('click'); go(); });
          // Tapping the page itself also walks you on
          scope.on($('#backImg'), 'click', () => { sfx('click'); go(); });
          return;
        }
        go();
      });
      scope.on($('#btnHubMenu'), 'click', () => { sfx('click'); FSM.change('MENU'); });
      scope.on($('#btnHubLocker'), 'click', () => { sfx('click'); FSM.change('LOCKER_ROOM', { from: 'CAREER_HUB' }); });
      // Difficulty, on show between matches: tap to change it for the next one
      const DIFF_LINE = { easy: 'Easy: a wider window, slower opponents, calmer meltdowns. Same prize money.', normal: 'Normal: the game as it was meant to be lost.', hard: 'Hard: tighter timing, sharper opponents, sneakier meltdowns. 1.5x prize money.' };
      const diffChip = () => { $('#btnHubDiff').textContent = 'Difficulty: ' + { easy: 'Easy', normal: 'Normal', hard: 'Hard' }[diffKey()]; };
      diffChip();
      scope.on($('#btnHubDiff'), 'click', () => {
        sfx('click');
        const order = ['easy', 'normal', 'hard'];
        SAVE.settings.difficulty = order[(order.indexOf(diffKey()) + 1) % 3];
        SAVE.settings.gentle = false;
        persist();
        diffChip();
        toast(DIFF_LINE[diffKey()] + ' Applies from the next match.', 3200);
      });
      // A nudge, once per run: a losing run on Normal or Hard, or a winning run on Normal
      if (!SAVE.askStyle) {
        if ((SAVE.lossRun || 0) >= 3 && diffKey() !== 'easy' && !SAVE.hintEasy) {
          SAVE.hintEasy = true;
          persist();
          setTimeout(() => toast('Three defeats in a row. No shame in Easy: tap Difficulty, top right. Same prize money.', 4200), 900);
        } else if ((SAVE.winRun || 0) >= 5 && diffKey() === 'normal' && !SAVE.hintHard) {
          SAVE.hintHard = true;
          persist();
          setTimeout(() => toast('Five wins in a row. Fancy Hard? Tap Difficulty, top right. 1.5x prize money.', 4200), 900);
        }
        if (!(SAVE.lossRun >= 3)) SAVE.hintEasy = false;
      }
      if (SAVE.stats.matchesWon >= 1 && !SAVE.notifAsked) setTimeout(askReminders, 1500);
      if (SAVE.askStyle) {
        // How do you like to play? The toast waits until the choice is made
        const modal = $('#styleModal');
        modal.classList.remove('hidden');
        document.querySelectorAll('#styleModal [data-style]').forEach((b) => scope.on(b, 'click', () => {
          sfx('click');
          const st = PLAY_STYLES[b.dataset.style];
          SAVE.settings.footwork = st.footwork;
          SAVE.settings.difficulty = st.difficulty;
          SAVE.settings.gentle = false;
          delete SAVE.askStyle;
          persist();
          applySettings();
          diffChip();
          modal.classList.add('hidden');
          toast(st.toast, 3600);
          // Then Derek's news about the £500
          if (p.toast) setTimeout(() => toast(p.toast, 3600), 3800);
        }));
        scope.add(() => modal.classList.add('hidden'));
      } else {
        if (p.toast) toast(p.toast, 3600);
        maybeDailyNudge(scope);
      }
    },
    exit() { this.confirmReset = false; }
  };

  /* ---------- LOCKER_ROOM ---------- */
  // A big preview of you on the left. Tap an item to try it on, tap again to buy it.
  function drawLockerPreview(styleId, t) {
    const c = $('#lockerPreview');
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const bg = ctx.createLinearGradient(0, 0, 0, c.height);
    bg.addColorStop(0, '#1d3b29');
    bg.addColorStop(1, '#2d5c9a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, c.height * 0.86, c.width, 3);
    const sc = c.height / 520;
    ctx.setTransform(sc, 0, 0, sc, c.width / 2 - (PX + (styleId ? 40 : 0)) * sc, c.height * 0.86 - FLOOR_Y * sc);
    const kit = playerKit();
    if (styleId) { renderRoutine(ctx, t, styleId, kit, [], []); return; }
    let pose;
    {
      const butt = { x: PX + 0.3 * KP, y: 470 };
      const ang = -Math.PI / 2 + 0.3;
      pose = { body: { x: PX, mouth: 0, smug: true, brow: 0, steam: false, hands: grip(butt, ang) }, racket: { x: butt.x, y: butt.y, ang: ang, t: t } };
    }
    if (pose.under) pose.under(ctx);
    const rk = pose.racket ? Object.assign({ len: RL, color: kit.racket }, pose.racket) : null;
    puppetShadow(ctx, pose.body);
    withOutline(ctx, puppetBox(pose.body, rk), (c) => {
      if (rk && pose.racketBehind) drawRacketShape(c, rk);
      const arms = drawPuppet(c, pose.body, t);
      if (rk && !pose.racketBehind) drawRacketShape(c, rk);
      arms();
    });
  }

  FSM.states.LOCKER_ROOM = {
    screen: 'locker',
    enter(p, scope) {
      this.from = p.from || 'MENU';
      this.cat = p.cat || this.cat || 'shirt';
      // Create Your Player: only the You tab, then straight on to the lesson
      this.create = !!p.create;
      this.toastNext = p.toastNext || null;
      $('#locker').classList.toggle('creating', this.create);
      $('#lockerTitle').textContent = this.create ? 'Create Your Player' : 'Kit Bag';
      $('#btnLockerBack').textContent = this.create ? (SAVE.tutorialDone ? 'On to the Tour' : 'To the Lesson') : 'Done';
      if (this.create) this.cat = 'you';
      this.pending = null;
      this.preview = null;
      this.t = 0;
      lockerTry = null;
      const tabs = $('#lockerTabs');
      tabs.innerHTML = '';
      // Two rows: what you wear on top, what you do (tantrums and celebrations) underneath, with how many you own
      const rows = {};
      ['kit', 'moves'].forEach((k) => { rows[k] = document.createElement('div'); rows[k].className = 'locker-tabrow ' + k; tabs.appendChild(rows[k]); });
      LOCKER_CATS.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab' + (c[0] === this.cat ? ' on' : '');
        const moves = c[0] === 'tantrum' || c[0] === 'celeb';
        b.textContent = c[0] === 'shorts' && SAVE.player.body === 'f' ? 'Skirts' : c[1];
        if (moves) {
          const n = lockerList(c[0]).filter((it) => SAVE.locker.owned.indexOf(it.id) >= 0).length;
          const k = document.createElement('small');
          k.textContent = n + '/' + lockerList(c[0]).length;
          b.appendChild(k);
          b.dataset.cat = c[0];
        }
        scope.on(b, 'click', () => {
          sfx('click');
          this.cat = c[0];
          this.pending = null;
          lockerTry = null;
          this.preview = null;
          tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
          this.borrowFor(null);
          this.renderItems(scope);
          this.tabNote();
          replayEnter($('#lockerItems'));
          drawLockerPreview(null, 0);
        });
        rows[moves ? 'moves' : 'kit'].appendChild(b);
      });
      scope.on($('#btnLockerBack'), 'click', () => {
        sfx('click');
        SAVE.player.made = true;
        persist();
        if (this.create && !SAVE.tutorialDone) { newMatch(tutorialConfig()); FSM.change('MATCH_PLAY', { fresh: true }); return; }
        FSM.change(this.from, this.toastNext ? { toast: this.toastNext } : undefined);
      });
      scope.on($('#btnShop'), 'click', () => { sfx('click'); openShop(); });
      $('#btnBorrow').classList.add('hidden');
      scope.on($('#btnBorrow'), 'click', () => {
        const it = this.borrowItem;
        if (!it) return;
        sfx('click');
        $('#btnBorrow').classList.add('hidden');
        rewardedAd(scope, $('#lockerNote'), 'Advert playing. The celebration is being gift wrapped.').then((ok) => {
          if (!ok) { this.borrowFor(it); return; }
          SAVE.borrowCeleb = it.id;
          persist();
          sfx('coins');
          this.note(it.name + ' is yours for your next match. It goes back afterwards, slightly used.');
        });
      });
      this.renderItems(scope);
      this.tabNote();
      replayEnter($('#lockerItems'));
      drawLockerPreview(null, 0);
      const goal = nextGoal();
      $('#lockerGoal').classList.toggle('hidden', !goal || this.create);
      if (goal) $('#lockerGoal').textContent = 'Saving for ' + goal.name + ': ' + (SAVE.prizeMoney >= goal.price ? 'you can afford it' : money(goal.price - SAVE.prizeMoney) + ' to go');
    },
    note(text) { $('#lockerNote').textContent = tapify(text); },
    // What a tap does on this tab, until an item has been picked
    tabNote() {
      if (this.cat === 'you') return;
      this.note(this.cat === 'celeb' ? 'Tap to watch a celebration. Tap again to buy. Play it after a winner.' : this.cat === 'tantrum' ? 'Tap to watch a tantrum. Tap again to buy. It plays when you smash a racket.' : 'Tap to try it on. Tap again to buy. None of it helps.');
    },
    // The You tab: rows of choices, each applied at once and shown on the preview
    renderYou(scope, box) {
      const P = SAVE.player;
      const row = (label, items) => {
        const r = document.createElement('div');
        r.className = 'you-row';
        const l = document.createElement('small');
        l.textContent = label;
        r.appendChild(l);
        const wrap = document.createElement('div');
        wrap.className = 'you-opts';
        items.forEach((x) => wrap.appendChild(x));
        r.appendChild(wrap);
        box.appendChild(r);
      };
      const set = (key, val) => {
        sfx('click');
        P[key] = val;
        // The kit tab is Skirts for a woman, Shorts for a man
        if (key === 'body') $('#lockerTabs').querySelectorAll('.tab').forEach((b) => { if (/^(Shorts|Skirts)$/.test(b.textContent)) b.textContent = val === 'f' ? 'Skirts' : 'Shorts'; });
        // Choosing a body suggests the usual kit and a hair style; both can be changed straight after
        // (only when the hair is still the other default, so a style you picked yourself is kept)
        if (key === 'body' && (P.style === 'short' || P.style === 'ponytail')) P.style = val === 'f' ? 'ponytail' : 'short';
        persist();
        this.renderItems(scope);
        drawLockerPreview(null, 0);
      };
      const chip = (key, val, text) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'you-chip' + (P[key] === val ? ' on' : '');
        b.textContent = text;
        scope.on(b, 'click', () => set(key, val));
        return b;
      };
      const dot = (key, val, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'you-dot' + (P[key] === val ? ' on' : '');
        b.style.background = val;
        b.setAttribute('aria-label', label);
        scope.on(b, 'click', () => set(key, val));
        return b;
      };
      // First name and surname: letters, spaces, hyphens and apostrophes, saved as you type
      myNames();
      const nameBox = (key, hint) => {
        const box = document.createElement('input');
        box.type = 'text';
        box.className = 'you-name';
        box.maxLength = 16;
        box.placeholder = hint;
        box.autocomplete = 'off';
        box.spellcheck = false;
        box.setAttribute('autocapitalize', 'words');
        box.setAttribute('aria-label', hint);
        box.value = capName(P[key]);
        scope.on(box, 'input', () => {
          const v = box.value.replace(/[^\p{L} '\-]/gu, '').replace(/\s{2,}/g, ' ').replace(/^\s+/, '').replace(/(^|[\s-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase()).slice(0, 16);
          if (v !== box.value) box.value = v;
          P[key] = v.trim();
          P.name = myName();
          persist();
        });
        scope.on(box, 'keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') box.blur(); });
        // The phone keyboard takes half the screen: keep the box in view above it
        scope.on(box, 'focus', () => setTimeout(() => box.scrollIntoView({ block: 'center' }), 350));
        return box;
      };
      row('Name', [nameBox('first', 'First name'), nameBox('last', 'Surname')]);
      row('Player', [chip('body', 'f', 'Woman'), chip('body', 'm', 'Man')]);
      row('Skin', PLAYER_LOOK.skins.map((c, i) => dot('skin', c, 'Skin tone ' + (i + 1))));
      // Every style is open to everyone; the order just puts the likelier ones first for the body chosen
      const FIRST_F = ['ponytail', 'bob', 'bun', 'long', 'curly'];
      const styles = P.body === 'f' ? FIRST_F.map((id) => PLAYER_LOOK.styles.find((x) => x[0] === id)).concat(PLAYER_LOOK.styles.filter((x) => FIRST_F.indexOf(x[0]) < 0)) : PLAYER_LOOK.styles;
      row('Hair', styles.map((x) => chip('style', x[0], x[1])));
      row('Hair colour', PLAYER_LOOK.hairs.map((c, i) => dot('hair', c, 'Hair colour ' + (i + 1))));
      this.note(this.create ? 'This is you. Change any of it later in the Locker Room.' : 'All free. Tap to change, it shows on the left.');
    },
    renderItems(scope) {
      const lm = $('#lockerMoney');
      const was = Number(lm.dataset.v);
      if (lm.dataset.v !== undefined && was > SAVE.prizeMoney) countUp(lm, SAVE.prizeMoney, money, was);
      else lm.textContent = money(SAVE.prizeMoney);
      lm.dataset.v = SAVE.prizeMoney;
      fitWidth(lm);
      const box = $('#lockerItems');
      box.innerHTML = '';
      // Keep the owned counts on the Tantrums and Celebrations tabs up to date after a purchase
      $('#lockerTabs').querySelectorAll('.tab[data-cat] small').forEach((k) => { const c = k.parentNode.dataset.cat; k.textContent = lockerList(c).filter((it) => SAVE.locker.owned.indexOf(it.id) >= 0).length + '/' + lockerList(c).length; });
      box.classList.toggle('you-grid', this.cat === 'you');
      if (this.cat === 'you') { this.renderYou(scope, box); return; }
      // What a tap does here, until an item has been picked
      LOCKER[this.cat].forEach((it) => {
        if (it.pack && !window.RRStore && !hasProduct(it.pack)) return;
        const owned = SAVE.locker.owned.indexOf(it.id) >= 0;
        const routine = it.cat === 'tantrum' || it.cat === 'celeb';
        const worn = !routine && SAVE.locker.equip[it.cat] === it.id;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'item' + (worn ? ' worn' : '') + (owned ? ' owned' : '') + (this.pending === it.id ? ' pending' : '');
        const sw = document.createElement('span');
        sw.className = 'swatch' + (it.cat === 'tantrum' ? ' tantrum' : it.cat === 'celeb' ? ' celeb' : '');
        if (!routine && swatchCss(it)) sw.style.background = swatchCss(it);
        else if (!routine) sw.style.background = sponsorKit()[it.cat === 'band' ? 'band' : it.cat] || '#888';
        const name = document.createElement('b');
        name.textContent = it.cat === 'shorts' && SAVE.player.body === 'f' ? it.name.replace(/Shorts\b/, 'Skirt') : it.name;
        const sub = document.createElement('small');
        // One short line on every door: the price, or where it stands with you
        const pending = this.pending === it.id;
        sub.textContent = worn ? 'Wearing' : owned ? 'Owned' : it.pack ? (pending ? 'See in shop' : SHOP[it.pack].name.replace(/ Pack$/, '') + ' pack') : money(it.price);
        if (it.pack && !owned) b.classList.add('pack');
        if (!owned && !it.pack && SAVE.prizeMoney < it.price) b.classList.add('dear');
        // Tantrums and celebrations get a mark of their own instead of a colour swatch
        if (routine) sw.innerHTML = it.cat === 'celeb'
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8z"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z"/></svg>';
        b.appendChild(sw);
        b.appendChild(name);
        b.appendChild(sub);
        scope.on(b, 'click', () => this.pick(it, scope));
        box.appendChild(b);
      });
      if (!box.dataset.fade) {
        box.dataset.fade = '1';
        box.addEventListener('scroll', () => edgeFade(box), { passive: true });
      }
      edgeFade(box);
    },
    // The Borrow button shows for a celebration you do not own, while adverts are allowed today
    borrowFor(it) {
      const b = $('#btnBorrow');
      const show = !!(it && it.cat === 'celeb' && SAVE.locker.owned.indexOf(it.id) < 0 && adOk() && SAVE.borrowCeleb !== it.id);
      b.classList.toggle('hidden', !show);
      this.borrowItem = show ? it : null;
    },
    pick(it, scope) {
      sfx('click');
      const owned = SAVE.locker.owned.indexOf(it.id) >= 0;
      if (it.pack && !owned) {
        if (it.cat === 'tantrum' || it.cat === 'celeb') {
          this.preview = it.style;
          this.loop = it.cat === 'celeb' ? CELEB_LEN + 0.6 : 3.6;
          this.t = 0;
        } else {
          this.preview = null;
          lockerTry = it.id;
        }
        this.borrowFor(it);
        if (this.pending === it.id) { this.pending = null; openShop(it.pack); }
        else { this.pending = it.id; this.note(it.desc + ' Part of the ' + SHOP[it.pack].name + '. Tap again to see it in the shop.'); }
        this.renderItems(scope);
        if (!this.preview) drawLockerPreview(null, 0);
        return;
      }
      if (it.cat === 'tantrum' || it.cat === 'celeb') {
        this.preview = it.style;
        this.loop = it.cat === 'celeb' ? CELEB_LEN + 0.6 : 3.6;
        this.t = 0;
      } else {
        this.preview = null;
        lockerTry = it.id;
      }
      this.borrowFor(owned ? null : it);
      if (owned) {
        if (it.cat !== 'tantrum' && it.cat !== 'celeb') { SAVE.locker.equip[it.cat] = it.id; lockerTry = null; persist(); }
        this.pending = null;
        this.note(it.desc);
      } else if (this.pending === it.id) {
        if (SAVE.prizeMoney >= it.price) {
          SAVE.prizeMoney -= it.price;
          SAVE.locker.owned.push(it.id);
          if (it.cat !== 'tantrum' && it.cat !== 'celeb') { SAVE.locker.equip[it.cat] = it.id; lockerTry = null; }
          persist();
          sfx('coins');
          this.pending = null;
          this.note('Bought ' + it.name + ' for ' + money(it.price) + '. The shop assistant pretends to be impressed.');
          checkCollections();
        } else {
          this.note('You need ' + money(it.price - SAVE.prizeMoney) + ' more. Win something. Or smash less.');
        }
      } else {
        this.pending = it.id;
        this.note(it.desc + (SAVE.prizeMoney >= it.price ? ' Tap again to buy it for ' + money(it.price) + '.' : ' Costs ' + money(it.price) + '. You are ' + money(it.price - SAVE.prizeMoney) + ' short.'));
      }
      this.renderItems(scope);
      if (!this.preview) drawLockerPreview(null, 0);
    },
    update(dt) {
      // Tantrum and celebration previews play on a loop; everything else is a still
      if (!this.preview) return;
      this.t += dt;
      if (this.t > (this.loop || 3.6)) this.t = 0;
      drawLockerPreview(this.preview, this.t);
    },
    exit() {
      lockerTry = null;
      this.preview = null;
    }
  };

  /* ---------- MATCH_PLAY ---------- */
  FSM.states.MATCH_PLAY = {
    screen: null,
    enter(p, scope) {
      $('#hudButtons').classList.remove('hidden');
      M.paused = false;
      M.touch.down = false;
      M.keyDown = false;
      $('#pause').classList.add('hidden');
      scope.loop('crowd');
      bindMatchInput(scope);
      // Nothing keeps keyboard focus during play, so Space can never press a button by mistake
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      scope.on(document, 'click', (e) => { if (e.target.closest && e.target.closest('button') && !M.paused) setTimeout(() => { if (!M.paused && document.activeElement && document.activeElement.blur) document.activeElement.blur(); }, 0); });
      canvas.classList.add('aiming');
      scope.on($('#btnPause'), 'click', () => togglePause());
      scope.on($('#btnChallenge'), 'click', () => startChallenge());
      $('#hsChoices').classList.add('hidden');
      scope.on($('#btnHsFirm'), 'click', () => chooseHandshake('firm'));
      scope.on($('#btnHsLimp'), 'click', () => chooseHandshake('limp'));
      scope.on($('#btnHsSlow'), 'click', () => chooseHandshake('tooSlow'));
      scope.on($('#btnPump'), 'click', () => celebrate());
      scope.on($('#btnShareNow'), 'click', () => {
        if (!M.shareChip) return;
        const shot = M.shareChip.shot;
        M.shareChip = null;
        sfx('click');
        togglePause(true);
        shareTantrum(shot, 'Racket Rage Tennis | ' + shot.title + ' | ' + (M.cfg.mode === 'daily' ? 'Daily Meltdown' : M.cfg.label));
      });
      scope.on($('#btnMute'), 'click', () => toggleMute());
      scope.on($('#btnResume'), 'click', () => togglePause(false));
      $('#btnRetire').textContent = M.tut ? (M.tut.practice ? 'End Practice' : 'Skip the Lesson') : 'Retire Hurt';
      scope.on($('#btnRetire'), 'click', () => {
        togglePause(false);
        if (M.tut && M.tut.practice) { FSM.change('MENU'); return; }
        if (M.tut) {
          if (!SAVE.tutorialDone) SAVE.askStyle = true;
          SAVE.tutorialDone = true;
          persist();
          const toastS = 'Lesson skipped. Derek is not offended. Derek is always slightly offended.';
          if (!SAVE.player.made && !M.cfg.replay) { FSM.change('LOCKER_ROOM', { from: 'CAREER_HUB', create: true, toastNext: toastS }); return; }
          FSM.change(M.cfg.replay ? 'MENU' : 'CAREER_HUB', { toast: toastS });
          return;
        }
        M.matchWinner = 1;
        finishMatch('retired');
      });
      this.scope = scope;
      scope.on(document, 'visibilitychange', () => { if (document.hidden) togglePause(true); });
      if (p.resume && M.tut && tutStep() && tutStep().id === 'meltdown') tutEvent('meltdown');
      if (p.resume) {
        if (M.matchWinner !== null) {
          M.phase = 'matchOver';
          M.phaseT = 0;
          M.phaseDur = 2.2;
        } else nextPoint();
      }
    },
    update(dt) {
      // The first match holds the first serve until you press: that press is also what lets the sound start
      if (startGate()) M.phaseT = 0;
      cgPlay();
      // Mouse: the aim follows the pointer, pressed or not. Keys: A and D hold it left or right, Q short.
      if (!M.paused && /^(prePoint|oppToss|rally|serveReady|serveAim)$/.test(M.phase)) {
        if (M.aimSrc === 'mouse' && M.mousePos) setAimFromScreen(M.mousePos.x, M.mousePos.y);
        else if (M.aimSrc === 'keys') keyAim();
      }
      if (!M.paused) updateMatch(dt);
      if (M.tut && M.tut.done && !M.tut.ending) {
        M.tut.ending = true;
        // No more balls: Derek lowers his racket and the lesson ends on the stamp
        M.shot = null;
        M.phase = 'pointOver';
        M.phaseT = 0;
        M.phaseDur = 99;
        M.rage = Math.min(M.rage, 0.2);
        callout('done', { main: 'LESSON COMPLETE', sub: 'Every step done. You are ready. Mostly.', dur: 3.2, color: '#d9f24a' });
        M.speech = { text: 'That will do. Off you go.', who: 'opp', t: 0, dur: 2.6 };
        sfx('applause', { power: 1 });
        this.scope.timeout(endTutorial, 3400);
      }
      // The challenge button only shows while a challengeable call is on the board
      const open = challengeOpen();
      const btn = $('#btnChallenge');
      if (open !== !btn.classList.contains('hidden')) btn.classList.toggle('hidden', !open);
      // Share that: for a few seconds after a tantrum, until the next rally gets going
      if (M.shareChip && !M.paused) { M.shareChip.t += dt; if (M.shareChip.t > 7 || M.phase === 'rally') M.shareChip = null; }
      const shareOpen = !!(M.shareChip && !M.paused);
      if (shareOpen !== !$('#btnShareNow').classList.contains('hidden')) $('#btnShareNow').classList.toggle('hidden', !shareOpen);
      const pumpOpen = !!(M.phase === 'pointOver' && M.celebOpen && !M.celeb && !M.paused && !M.tut && M.phaseT < 1.5);
      if (pumpOpen) showTip('celebrate', ctl('celebrate'));
      if (open) showTip('challenge', ctl('challengeTip'));
      if (M.phase === 'serveReady' && M.server === 0) showTip('serve', ctl('serveTip'), 'serve');
      const pb = $('#btnPump');
      if (pumpOpen !== !pb.classList.contains('hidden')) {
        if (pumpOpen) $('#pumpName').textContent = celebItem().name;
        pb.classList.toggle('hidden', !pumpOpen);
      }
      if (open) {
        $('#btnChallenge b').textContent = M.challenges ? 'CHALLENGE' : 'RENT OWL VISION';
        if (!M.renting) $('#chalLeft').textContent = M.challenges ? M.challenges + ' left' : isPro() ? 'Free (Pro)' : 'Watch an advert';
        $('#chalBar').style.width = Math.max(0, 100 * (1 - M.phaseT / M.phaseDur)).toFixed(1) + '%';
      }
    },
    render(ctx) {
      renderMatch(ctx);
      if (startGate()) drawStartCard(ctx);
    },
    exit() {
      stopHeart();
      canvas.classList.remove('aiming');
      $('#btnPump').classList.add('hidden');
      $('#btnShareNow').classList.add('hidden');
      $('#btnChallenge').classList.add('hidden');
      $('#hudButtons').classList.add('hidden');
      $('#pause').classList.add('hidden');
    }
  };

  /* ---------- MELTDOWN_MINIGAME ---------- */
  const MD = { phase: 'ready', t: 0, taps: 0, need: 12, smashed: false, line: '', title: '', shards: [], style: null, parts: [], impact: false, cues: [] };

  // Six ways to break a racket. Real graphite cracks at the throat, folds in half or bursts its
  // strings. These do the same, only louder and with more follow through.
  const SMASH_STYLES = [
    { id: 'spike', title: 'SPIKED', lines: ['Driven into the court like a tent peg. The groundsman is taking notes.', 'Head first into the baseline. The baseline has a dent and a grievance.'] },
    { id: 'taco', title: 'TACOED', lines: ['Folded neatly in half. It now fits in a sandwich bag.', 'Bent into a perfect taco. The stringer has asked you to stop ringing.'] },
    { id: 'knee', title: 'SNAPPED', lines: ['Snapped over the knee like a breadstick. The knee is also complaining.', 'Two rackets for the price of one. Neither of them works.'] },
    { id: 'heli', title: 'LAUNCHED', lines: ['Thrown into row M. A pensioner caught it and is refusing to give it back.', 'It went up. It has not come down. Air traffic control has been informed.'] },
    { id: 'post', title: 'SHATTERED', lines: ['Introduced to the advertising hoarding at speed. The hoarding won.', 'The frame met the sponsor board and left in several directions at once.'] },
    { id: 'bin', title: 'BINNED', lines: ['Posted head first into the courtside bin. General waste, as it turns out.', 'Binned. The lid will not shut, and neither will the crowd.'] },
    { id: 'hoof', title: 'HOOFED', lines: ['Drop kicked into the stand. A scout from the football club has left his number.', 'Hoofed. It cleared the stand, the car park and most of a postcode.'] },
    { id: 'strings', title: 'STRUNG OUT', lines: ['The strings went off like a harp in a bonfire. Lovely sound, mind.', 'Every string snapped at once. Somewhere, a violinist felt it.'] },
    { id: 'chew', title: 'CHEWED', lines: ['Gnawed through the frame like a Labrador with a slipper. The dentist has been called.', 'Bitten in half. The strings are being picked out of your teeth by a ball kid.'] },
    { id: 'bounce', title: 'BOUNCED', lines: ['Slammed into the court so hard it came back for you. Physics: 1, You: 0.', 'It bounced, it rose, it returned to your head. Karma has excellent timing.'] },
    { id: 'fore', title: 'FORE!', lines: ['A full golf swing into the baseline. The divot is being replaced by a groundsman in tears.', 'Teed off, literally. The club has asked you to try the other sport instead.'] },
    { id: 'drums', title: 'DRUM SOLO', lines: ['Three beats and a crash. The racket did not survive the encore.', 'A drum solo on the baseline. The crowd clapped along. The umpire did not.'] },
    { id: 'gift', title: 'SIGNED AND THROWN', lines: ['Signed and lobbed into the crowd. A lovely gesture, the umpire says, writing it down.', 'You signed it and threw it to a fan. They are framing it. You are being fined for it.'] },
    { id: 'royal', title: 'ROYAL BOX INCIDENT', lines: ['The racket has landed in the Royal Box. So, effectively, have you.', 'Thrown into the Royal Box. A cucumber sandwich has been lost with all hands.'] }
  ];
  const COMMENTARY = ['Let us see that again. Oh dear.', 'Watch the wrists here. Not a technique they teach at the club.', 'Remarkable follow through. Completely unnecessary.', 'And there it goes. Graphite everywhere.', 'In slow motion it is somehow worse.'];
  const ROYAL_BOX = { x: 330, y: 66 };   // left of the far stand, clear of the big screen
  let forcedSmash = null;  // debug only
  let forcedIncident = null;  // debug only
  const SMASH_T = 0.9;    // moment of impact, seconds into the result (after the wind up)
  const FLOOR_Y = 600;
  const RK_LEN = 300;

  // A racket in screen space. Origin is the butt cap, +x runs along the frame to the tip.
  // o: { x, y, ang, len, scale, flat, bend, fold, crack, stringsGone, noHead, noHandle, color, t }
  function drawRacketShape(ctx, o) {
    const L = o.len || RK_LEN;
    const col = o.color || '#d9f24a';
    const throatX = L * 0.36;
    const hl = L * 0.29;
    const hw = L * 0.2;
    ctx.save();
    ctx.translate(o.x, o.y);
    if (o.flat) ctx.scale(1, o.flat);
    ctx.rotate(o.ang || 0);
    if (o.scale) ctx.scale(o.scale, o.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!o.noHandle) {
      // Pale overgrip with a dark spiral wrap, then a dark butt cap
      ctx.strokeStyle = '#f1ede0';
      ctx.lineWidth = L * 0.066;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(L * 0.3, 0);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(30,30,30,0.6)';
      ctx.lineWidth = Math.max(1, L * 0.008);
      for (let j = 0; j < 7; j++) {
        ctx.beginPath();
        ctx.moveTo(L * (0.02 + j * 0.035), -L * 0.033);
        ctx.lineTo(L * (0.045 + j * 0.035), L * 0.033);
        ctx.stroke();
      }
      ctx.fillStyle = '#1c1c1c';
      ctx.fillRect(-L * 0.016, -L * 0.038, L * 0.03, L * 0.076);
      if (o.noHead) {
        // Splintered end where the throat used to be
        ctx.strokeStyle = col;
        ctx.lineWidth = L * 0.03;
        ctx.beginPath();
        ctx.moveTo(L * 0.3, 0);
        ctx.lineTo(L * 0.37, -L * 0.05);
        ctx.moveTo(L * 0.3, 0);
        ctx.lineTo(L * 0.35, L * 0.035);
        ctx.stroke();
        ctx.fillStyle = '#f4f1e6';
        ctx.beginPath();
        ctx.moveTo(L * 0.36, -L * 0.06);
        ctx.lineTo(L * 0.39, -L * 0.03);
        ctx.lineTo(L * 0.355, -L * 0.035);
        ctx.fill();
      }
    }
    if (!o.noHead) {
      ctx.translate(throatX, 0);
      if (o.bend) ctx.rotate(o.bend);
      // Open throat
      ctx.strokeStyle = col;
      ctx.lineWidth = L * 0.036;
      ctx.beginPath();
      ctx.moveTo(-L * 0.06, 0);
      ctx.lineTo(L * 0.1, -hw * 0.78);
      ctx.moveTo(-L * 0.06, 0);
      ctx.lineTo(L * 0.1, hw * 0.78);
      // The throat bridge
      ctx.moveTo(L * 0.075, -hw * 0.62);
      ctx.lineTo(L * 0.075, hw * 0.62);
      ctx.stroke();
      if (o.noHandle) {
        // Splintered stub of the shaft
        ctx.fillStyle = '#f4f1e6';
        ctx.beginPath();
        ctx.moveTo(-L * 0.06, -L * 0.02);
        ctx.lineTo(-L * 0.1, 0);
        ctx.lineTo(-L * 0.06, L * 0.02);
        ctx.fill();
      }
      // Head
      ctx.translate(L * 0.35, 0);
      const squash = 1 - (o.fold || 0) * 0.82;
      ctx.save();
      ctx.scale(1, squash);
      ctx.beginPath();
      ctx.ellipse(0, 0, hl, hw, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240,240,220,0.18)';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = Math.max(1, L * 0.006);
      const gone = o.stringsGone || 0;
      for (let i = -6; i <= 6; i++) {
        if ((((i * 7 + 13) % 10) + 10) % 10 / 10 < gone) continue;
        ctx.beginPath();
        ctx.moveTo(i * hl / 7, -hw);
        ctx.lineTo(i * hl / 7, hw);
        ctx.stroke();
      }
      for (let i = -5; i <= 5; i++) {
        if ((((i * 3 + 17) % 10) + 10) % 10 / 10 < gone) continue;
        ctx.beginPath();
        ctx.moveTo(-hl, i * hw / 6);
        ctx.lineTo(hl, i * hw / 6);
        ctx.stroke();
      }
      ctx.restore();
      // A stencil on the strings
      if (gone < 0.4 && L > 80) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(0, 0, hl, hw, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(200,16,46,0.55)';
        ctx.font = Math.round(hw * 1.1) + 'px "Lilita One", Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.rotate(Math.PI / 2);
        ctx.fillText('R', 0, 0);
        ctx.restore();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = L * 0.04 / Math.max(0.3, squash);
      ctx.beginPath();
      ctx.ellipse(0, 0, hl, hw, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = L * 0.012;
      ctx.beginPath();
      ctx.ellipse(0, 0, hl, hw, 0, Math.PI * 0.6, Math.PI * 1.1);
      ctx.stroke();
      ctx.strokeStyle = '#1c1c1c';
      ctx.lineWidth = L * 0.05;
      ctx.beginPath();
      ctx.ellipse(0, 0, hl * 1.02, hw * 1.03, 0, -0.55, 0.55);
      ctx.stroke();
      ctx.restore();
      if (o.fold) {
        // The crease where a taco folds
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = L * 0.012;
        ctx.beginPath();
        ctx.moveTo(-hl, 0);
        ctx.lineTo(hl, 0);
        ctx.stroke();
      }
      if (o.crack) {
        ctx.strokeStyle = '#111';
        ctx.lineWidth = L * 0.014;
        ctx.beginPath();
        ctx.moveTo(-hl * 0.55, -hw * squash * 0.95);
        ctx.lineTo(-hl * 0.42, -hw * squash * 0.55);
        ctx.lineTo(-hl * 0.6, -hw * squash * 0.3);
        ctx.lineTo(-hl * 0.45, hw * squash * 0.05);
        ctx.stroke();
      }
      if (gone > 0) {
        // Loose strings whipping out of the frame
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = Math.max(1, L * 0.006);
        const tt = o.t || 0;
        for (let i = 0; i < 7; i++) {
          const a = i / 7 * Math.PI * 2 + 0.4;
          const sx = Math.cos(a) * hl;
          const sy = Math.sin(a) * hw * squash;
          const reach = L * 0.12 * gone * (1 + (i % 3) * 0.4);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(sx + Math.cos(a) * reach * 0.5, sy + Math.sin(a) * reach * 0.5 + Math.sin(tt * 30 + i) * 8,
            sx + Math.cos(a + 0.6) * reach, sy + Math.sin(a + 0.6) * reach,
            sx + Math.cos(a + 0.3) * reach * 1.3, sy + Math.sin(a + 0.3) * reach * 1.3 + gone * 12);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function rigid(x, y, vx, vy, ang, spin, props) {
    return Object.assign({ x: x, y: y, vx: vx, vy: vy, ang: ang, spin: spin, g: 1300, rest: false }, props);
  }
  function stepRigid(b, dt) {
    if (b.rest) return;
    b.vy += b.g * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.ang += b.spin * dt;
    if (b.floor !== undefined && b.y > b.floor) {
      b.y = b.floor;
      b.vy *= -0.35;
      b.vx *= 0.6;
      b.spin *= 0.5;
      if (Math.abs(b.vy) < 60) b.rest = true;
    }
  }

  function smashRacket() {
    M.rackets = Math.max(0, M.rackets - 1);
    M.smashed++;
    if (!M.tut) {
      SAVE.stats.racketsSmashed++;
      if (SAVE.stats.racketsSmashed >= 10) unlock('hothead');
    }
    const owned = SMASH_STYLES.filter((st) => SAVE.locker.owned.indexOf('tantrum_' + st.id) >= 0);
    const pool = owned.length > 1 ? owned.filter((st) => st.id !== M.lastSmash) : owned.length ? owned : SMASH_STYLES.filter((x) => x.id !== 'royal');
    // The Royal Box Incident: rare. Each earlier smash this match shortens the odds, as do a villain's
    // reputation and a strict umpire. Capped at 4 percent: smashing is a choice now, made often, and an incident
    // ends the match outright, so it has to stay a rare story rather than a regular tax.
    const royalP = M.tut ? 0 : clamp(0.008 + 0.004 * (M.smashed - 1) + (SAVE.reputationScore <= -25 ? 0.006 : 0) + (M.cfg.strict > 0.6 ? 0.004 : 0), 0, 0.04);
    MD.royalOdds = royalP > 0 ? Math.round(1 / royalP) : 0;
    const royal = forcedSmash === 'royal' || (!forcedSmash && Math.random() < royalP);
    MD.style = royal ? SMASH_STYLES.find((x) => x.id === 'royal') : SMASH_STYLES.find((x) => x.id === forcedSmash) || pick(pool);
    MD.incident = royal ? (forcedIncident || incidentKey(M.cfg)) : null;
    // First smash of the match gets an action replay
    MD.replayAt = M.smashed === 1 && !royal && !M.tut ? SMASH_T + 0.9 : 0;
    MD.replaying = false;
    MD.replayDone = false;
    MD.freeze = 0;
    MD.captured = false;
    MD.royalSaid = false;
    M.lastSmash = MD.style.id;
    MD.title = MD.incident ? INCIDENTS[MD.incident].title : MD.style.title;
    MD.line = pick(MD.incident ? INCIDENTS[MD.incident].lines : MD.style.lines);
    MD.parts = [];
    MD.impact = false;
    MD.cues = [];
    vibrate(40);
    // The build up: a scream, plus the noises each routine makes on the way to the impact
    const id = MD.style.id;
    const cue = (t, name, opts) => MD.cues.push({ t: t, name: name, opts: opts || {} });
    if (id === 'strings') cue(0.6, 'scream', { pitch: 1.1 });
    else if (id === 'knee') cue(0.5, 'grunt', { power: 1.4, pitch: 150 });
    else cue(0.12, 'scream');
    if (id === 'heli') { cue(0.3, 'whoosh', { power: 0.6 }); cue(0.55, 'whoosh', { power: 0.9 }); cue(0.78, 'whoosh', { power: 1.3 }); }
    if (id === 'post' || id === 'royal') { cue(0.08, 'squeak'); cue(0.22, 'squeak'); cue(0.36, 'squeak'); cue(0.6, 'whoosh', { power: 1.2 }); }
    if (id === 'spike' || id === 'taco') cue(0.6, 'whoosh', { power: 1.2 });
    if (id === 'bin') { cue(0.1, 'squeak'); cue(0.25, 'squeak'); cue(0.5, 'creak'); cue(0.75, 'whoosh', { power: 0.9 }); }
    if (id === 'hoof') { cue(0.45, 'bounce'); cue(0.75, 'whoosh', { power: 0.8 }); }
    if (id === 'drums') { cue(0.35, 'bounce'); cue(0.62, 'bounce'); cue(0.8, 'whoosh', { power: 0.9 }); }
    if (id === 'chew') { cue(0.45, 'creak'); cue(0.6, 'creak'); cue(0.75, 'creak'); }
    if (id === 'bounce') { cue(0.7, 'whoosh', { power: 1.1 }); cue(SMASH_T + 0.95, 'whoosh', { power: 0.6 }); }
    if (id === 'fore') { cue(0.3, 'squeak'); cue(0.78, 'whoosh', { power: 1.3 }); }
    if (id === 'gift') { cue(0.15, 'squeak'); cue(0.3, 'squeak'); cue(0.75, 'whoosh', { power: 1 }); }
    // The excuse afterwards, muttered
    const excuse = { spike: [SMASH_T + 0.7, 'It slipped'], taco: [SMASH_T + 0.6, 'Faulty frame'], knee: [SMASH_T + 1, 'Ow my knee'], heli: [SMASH_T + 0.9, 'Sorry sorry'], post: [SMASH_T + 0.05, 'Ow ow ow'], strings: [1.9, 'Lovely sound'], royal: [SMASH_T + 1.7, 'Oh no'], bin: [SMASH_T + 0.9, 'Recycling'], hoof: [SMASH_T + 0.7, 'Goal'], drums: [SMASH_T + 0.8, 'Encore'], gift: [SMASH_T + 1.2, 'You are welcome'], chew: [SMASH_T + 0.9, 'Needs salt'], bounce: [SMASH_T + 1.8, 'Ow'], fore: [SMASH_T + 0.8, 'Fore'] }[id];
    cue(excuse[0], 'umpire', { text: excuse[1], pitch: 190 });
    MD.cues.sort((a, b) => a.t - b.t);
  }

  /* ---- The tantrum: a big cartoon of you, facing the crowd, destroying the racket ---- */
  const PX = 560;            // where you stand for the performance
  const KP = 190;            // pixels per metre for the big figure
  const RL = 0.72 * KP;      // racket length in pixels
  const easeOut = (u) => 1 - (1 - u) * (1 - u);
  const easeIn = (u) => u * u;
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  const POST_X = PX + 0.5 * KP + RL + 8;   // left face of the courtside hoarding in the Shattered routine

  function handsOnHips(x) {
    return [{ x: x - 0.3 * KP, y: 448 }, { x: x + 0.3 * KP, y: 448 }];
  }
  // Two hands on the grip: the lower hand at the butt, the other just above it
  function grip(butt, ang) {
    return [{ x: butt.x + Math.cos(ang) * 0.14 * RL, y: butt.y + Math.sin(ang) * 0.14 * RL }, butt];
  }

  // A joint (knee or elbow) for a two part limb of total length len, bending to one side
  function jointFor(a, b, len, dir) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const sag = Math.sqrt(Math.max(0, (len / 2) * (len / 2) - (L / 2) * (L / 2)));
    return { x: (a.x + b.x) / 2 + (-dy / L) * sag * dir, y: (a.y + b.y) / 2 + (dx / L) * sag * dir };
  }
  function stroke3(ctx, a, j, b, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(j.x, j.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // p: { x, jump, crouch, lean, squash (1 facing us, negative facing away), hands, feet, knees,
  //      mouth (0 to 1), brow (1 furious, negative worried), smug, steam, say }
  // Draws the body and returns a function that draws the arms, so a held racket can sit between them.
  function drawPuppet(ctx, p, t, kitIn) {
    const kit = kitIn || playerKit();
    const skin = kit.skin || '#e7b892';
    const squash = p.squash === undefined ? 1 : p.squash;
    const front = squash >= 0;
    const wk = Math.max(0.3, Math.abs(squash));
    const feetY = FLOOR_Y - (p.jump || 0);
    const hip = { x: p.x, y: feetY - 0.84 * KP * (1 - 0.28 * (p.crouch || 0)) };
    const lean = p.lean || 0;
    const bend = p.bend || 0;
    const bodyH = 0.66 * KP * (1 - 0.32 * bend);
    const up = { x: Math.sin(lean), y: -Math.cos(lean) };
    const across = { x: Math.cos(lean), y: Math.sin(lean) };
    const sh = { x: hip.x + up.x * bodyH, y: hip.y + up.y * bodyH };
    const w = 0.22 * KP * wk * ((kit.look && kit.look.w) || 1);
    const shL = { x: sh.x - across.x * w, y: sh.y - across.y * w + 0.06 * KP };
    const shR = { x: sh.x + across.x * w, y: sh.y + across.y * w + 0.06 * KP };
    const feet = (p.feet || [null, null]).map((f, i) => f || { x: hip.x + (i ? 1 : -1) * 0.17 * KP, y: feetY });
    const knees = p.knees || [null, null];

    // Shadow on the court (a spinning routine draws its own)
    ctx.fillStyle = p.noShadow || OUTLINE_PASS ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(p.x, FLOOR_Y + 3, 0.45 * KP * (1 - Math.min(0.5, (p.jump || 0) / 220)), 0.08 * KP, 0, 0, Math.PI * 2);
    ctx.fill();
    // Legs and shoes
    [0, 1].forEach((i) => {
      const h = { x: hip.x + (i ? 1 : -1) * w * 0.5, y: hip.y };
      const k = knees[i] || jointFor(h, feet[i], 0.86 * KP, i ? -1 : 1);
      // The same shaded, tapered legs as on court: thigh, a calf that swells below the knee, a slim ankle
      // Standing, the leg stops at the ankle, inside the shoe, so its round end never shows under the sole
      const ankle = p.kneel ? feet[i] : { x: lerp(k.x, feet[i].x, 0.93), y: lerp(k.y, feet[i].y, 0.93) - 0.03 * KP };
      const calf = { x: lerp(k.x, ankle.x, 0.35), y: lerp(k.y, ankle.y, 0.35) };
      shadedChain(ctx, [h, k, calf, ankle], [0.08 * KP, 0.056 * KP, 0.062 * KP, 0.038 * KP], skin);
      // Kneeling, the shins and shoes are behind the knees, out of sight
      if (!p.kneel) {
        paintSock(ctx, k, feet[i], 0.15 * KP, 0.09 * KP, kit.band);
        // A knee crease
        ctx.strokeStyle = shadeHex(skin, -0.26);
        ctx.lineWidth = Math.max(1, 0.01 * KP);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(k.x, k.y + 0.012 * KP, 0.03 * KP, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        paintShoeBig(ctx, feet[i].x, feet[i].y + 0.02 * KP, i ? 1 : -1, kit);
      }
    });
    // Shorts and shirt, leaning with the spine
    ctx.save();
    ctx.translate(hip.x, hip.y);
    ctx.rotate(lean);
    paintShorts(ctx, -w * 1.02, -0.05 * KP, w * 2.04, 0.25 * KP, 0.04 * KP, kit);
    paintShirt(ctx, -w, -bodyH, w * 2, bodyH + 0.02 * KP, 0.08 * KP, kit, front, wk > 0.6 ? 0.1 * KP : 0);
    ctx.restore();
    // Head on a neck, with ears: the same head and face as the match figure (drawFigure), at close-up size.
    // The routine's expression (brow, mouth, smug, steam) maps onto the match figure's moods.
    const hr = 0.14 * KP;
    const hc = { x: sh.x + up.x * hr * 1.12 * (1 - 1.6 * bend), y: sh.y + up.y * hr * 1.12 * (1 - 1.6 * bend) };
    // Deep in a bow you see the top of the head, not the face
    const showFace = front && wk > 0.45 && bend < 0.55;
    ctx.fillStyle = shadeHex(skin, -0.12);
    taperPath(ctx, { x: sh.x, y: sh.y + 0.02 * KP }, hc, 0.05 * KP, 0.05 * KP);
    ctx.fill('nonzero');
    const hairCol = kit.hair || '#3a2716';
    const hairStyle = (kit.look && kit.look.hair) || 'short';
    if (showFace) frontHair(ctx, hc.x, hc.y, hr * wk, hairCol, hairStyle, 'behind');
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(hc.x, hc.y, hr, 0, Math.PI * 2);
    ctx.fill();
    if (showFace) {
      [-1, 1].forEach((sd) => {
        ctx.fillStyle = sd > 0 ? shadeHex(skin, -0.12) : skin;
        ctx.beginPath();
        ctx.ellipse(hc.x + sd * hr * wk, hc.y + hr * 0.12, hr * 0.17, hr * 0.27, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.fillStyle = hairCol;
    ctx.beginPath();
    if (showFace) frontHair(ctx, hc.x, hc.y, hr * wk, hairCol, hairStyle, 'top');
    else if (hairStyle !== 'short') backHair(ctx, hc.x, hc.y, hr, hairCol, hairStyle, 0);
    else ctx.arc(hc.x, hc.y - hr * 0.04, hr * 1.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = kit.band;
    ctx.fillRect(hc.x - hr * wk, hc.y - hr * 0.45, hr * 2 * wk, hr * 0.32);
    if (showFace) {
      const b = p.brow === undefined ? 1 : p.brow;
      const m = p.mouth || 0;
      // The match figure's moods: furious, cross, calm or happy
      const mood = p.steam || b > 0.85 ? (m > 0.5 ? 'furious' : 'cross') : b > 0.3 ? 'cross' : p.smug || b < -0.1 ? 'happy' : 'calm';
      const ink = '#1b1b1b';
      const lw = Math.max(1, hr * 0.13);
      ctx.fillStyle = '#ffffff';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.ellipse(hc.x + sd * hr * 0.36 * wk, hc.y + hr * 0.12, hr * 0.17, hr * (mood === 'furious' ? 0.12 : 0.16), 0, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = ink;
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.arc(hc.x + sd * hr * 0.36 * wk, hc.y + hr * 0.13, hr * 0.09, 0, Math.PI * 2);
        ctx.fill();
      });
      // Close up: a catchlight in each eye, warm cheeks and a nose, as on the match figure
      ctx.fillStyle = '#ffffff';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.arc(hc.x + sd * hr * 0.36 * wk + hr * 0.03, hc.y + hr * 0.1, hr * 0.03, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = p.steam ? 'rgba(220,40,30,0.3)' : 'rgba(230,100,90,0.2)';
      [-1, 1].forEach((sd) => {
        ctx.beginPath();
        ctx.ellipse(hc.x + sd * hr * 0.52 * wk, hc.y + hr * 0.42, hr * 0.15, hr * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.strokeStyle = shadeHex(skin, -0.3);
      ctx.lineWidth = Math.max(1, hr * 0.08);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(hc.x, hc.y + hr * 0.3, hr * 0.09, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      const tilt = { calm: 0, cross: 0.3, furious: 0.5, happy: -0.15 }[mood];
      const lift = { calm: 0, cross: 0.06, furious: 0.08, happy: -0.06 }[mood];
      ctx.strokeStyle = hairCol === '#e8e0d0' ? '#7a6a50' : hairCol;
      ctx.lineWidth = lw * 1.2;
      ctx.lineCap = 'round';
      [-1, 1].forEach((sd) => {
        const bx = hc.x + sd * hr * 0.36 * wk;
        const by = hc.y - hr * 0.12 + lift * hr;
        ctx.beginPath();
        ctx.moveTo(bx - hr * 0.2, by + sd * tilt * hr * 0.5);
        ctx.lineTo(bx + hr * 0.2, by - sd * tilt * hr * 0.5);
        ctx.stroke();
      });
      // Mouth: open when shouting, a smile when pleased, a frown when cross, a line otherwise
      const mx = hc.x;
      const my = hc.y + hr * 0.58;
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#5a2a20';
      if (m > 0.05 || mood === 'furious') {
        const open = Math.max(m, 0.25);
        ctx.fillStyle = '#4a1414';
        ctx.beginPath();
        ctx.ellipse(mx, my, hr * 0.26, hr * (0.12 + 0.24 * open), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(mx - hr * 0.2, my - hr * (0.06 + 0.2 * open), hr * 0.4, hr * 0.07);
      } else {
        ctx.beginPath();
        if (mood === 'happy') ctx.arc(mx, my - hr * 0.12, hr * 0.24, 0.2 * Math.PI, 0.8 * Math.PI);
        else if (mood === 'cross') ctx.arc(mx, my + hr * 0.16, hr * 0.22, 1.2 * Math.PI, 1.8 * Math.PI);
        else { ctx.moveTo(mx - hr * 0.2, my); ctx.lineTo(mx + hr * 0.2, my); }
        ctx.stroke();
      }
    }
    // Red with fury, as on court
    if (p.steam) {
      ctx.fillStyle = 'rgba(255,40,30,0.4)';
      ctx.beginPath();
      ctx.arc(hc.x, hc.y, hr * 1.05, 0, Math.PI * 2);
      ctx.fill();
    }
    // Steam out of both ears
    if (p.steam && !reduceMotion) {
      for (let i = 0; i < 4; i++) {
        // Wrapped into 0..1 even when the routine clock is still negative at the start
        const k = (((t * 1.6 + i * 0.25) % 1) + 1) % 1;
        const sx = hc.x + (i % 2 ? 1 : -1) * (hr * 1.05 + k * 18);
        ctx.fillStyle = 'rgba(240,240,240,' + (0.55 * (1 - k)).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(sx, hc.y - k * 46, 7 + k * 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Speech bubble to the upper right of the head
    if (p.say) {
      const say = p.say;
      const hx = hc.x;
      const hy = hc.y;
      drawLate(ctx, (c) => {
        c.font = 'bold 22px "Trebuchet MS", sans-serif';
        const tw = c.measureText(say).width + 24;
        let bx = hx + hr * 0.7;
        bx += onScreenShift(c, bx, tw);
        const by = hy - hr * 1.6 - 34;
        c.fillStyle = '#ffefc2';
        c.strokeStyle = '#0b0b0b';
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(clamp(hx + hr * 0.2, bx + 10, bx + tw - 24), by + 35);
        c.lineTo(hx + hr * 0.4, hy - hr * 0.9);
        c.lineTo(clamp(hx + hr * 0.2, bx + 10, bx + tw - 24) + 16, by + 35);
        c.closePath();
        c.fill();
        c.stroke();
        roundRect(c, bx, by, tw, 36, 10);
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(clamp(hx + hr * 0.2, bx + 10, bx + tw - 24) + 1.5, by + 34);
        c.lineTo(clamp(hx + hr * 0.2, bx + 10, bx + tw - 24) + 14.5, by + 34);
        c.strokeStyle = '#ffefc2';
        c.lineWidth = 3;
        c.stroke();
        c.fillStyle = '#b3261e';
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.fillText(say, bx + 12, by + 18);
      });
    }
    // Arms are drawn on request, after any racket held in front of the body
    const hands = p.hands || [{ x: shL.x - 0.05 * KP, y: hip.y + 0.05 * KP }, { x: shR.x + 0.05 * KP, y: hip.y + 0.05 * KP }];
    return function drawArms() {
      // Shaded, tapered arms with short sleeves, and a wristband on the racket hand
      [[shL, hands[0], 1], [shR, hands[1], -1]].forEach((A, i) => {
        const el = jointFor(A[0], A[1], 0.62 * KP, A[2] * (p.elbowsOut ? -1 : 1));
        shadedChain(ctx, [A[0], el, A[1]], [0.058 * KP, 0.044 * KP, 0.034 * KP], skin);
        ctx.fillStyle = kit.shirt;
        taperPath(ctx, A[0], { x: lerp(A[0].x, el.x, 0.42), y: lerp(A[0].y, el.y, 0.42) }, 0.08 * KP, 0.07 * KP);
        ctx.fill('nonzero');
        if (i === 1) {
          ctx.fillStyle = kit.band || '#ffffff';
          taperPath(ctx, { x: lerp(el.x, A[1].x, 0.74), y: lerp(el.y, A[1].y, 0.74) }, { x: lerp(el.x, A[1].x, 0.9), y: lerp(el.y, A[1].y, 0.9) }, 0.042 * KP, 0.04 * KP);
          ctx.fill('nonzero');
        }
      });
      ctx.fillStyle = skin;
      hands.forEach((h) => { ctx.beginPath(); ctx.arc(h.x, h.y, 0.058 * KP, 0, Math.PI * 2); ctx.fill(); });
    };
  }

  // Celebrations, performed facing the crowd. Same pose format as the tantrums, CELEB_LEN seconds long.
  // Shoulders sit about 326 px up the page, the head at 280, hips at 440; arms reach about 118 px.
  const SKIN = '#e7b892';
  function shoulderOf(x, hipY, lean) {
    return { x: x + Math.sin(lean) * 0.66 * KP, y: hipY - Math.cos(lean) * 0.66 * KP };
  }
  let REACT_SAY = null;   // the line for the reaction being drawn
  const CELEB = {
    // Come On!: a crouch, two fist pumps and a roar
    comeon(t) {
      const u = seg(t, 0, 0.2);
      const cyc = Math.min(2, Math.max(0, t - 0.2) / 0.55);
      const down = cyc >= 2 ? 1 : Math.sin((cyc % 1) * Math.PI);
      const body = { x: PX, crouch: 0.25 * u + 0.15 * down, lean: 0.1 * u, mouth: t > 0.15 ? 0.6 + 0.4 * down : 0.2, brow: 1, say: t > 0.2 && t < 1.8 ? 'COME ON!' : null };
      const fist = { x: PX + 0.38 * KP, y: lerp(292, 400, down) };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, fist];
      return { body: body, racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t } };
    },
    // The Aeroplane: arms out, banking through one lap
    plane(t) {
      const ang = Math.min(1, t / 1.8) * Math.PI * 2;
      const x = PX + Math.sin(ang) * 0.9 * KP;
      const bank = Math.cos(ang) * 0.28;
      const step = reduceMotion ? 0 : Math.sin(t * 16);
      const body = { x: x, lean: bank, crouch: 0.1, mouth: 0.7, brow: 0, say: t > 0.2 && t < 1.7 ? 'NYEEOOWW!' : null };
      body.feet = [{ x: x - 0.17 * KP + step * 0.12 * KP, y: FLOOR_Y - Math.max(0, step) * 14 }, { x: x + 0.17 * KP - step * 0.12 * KP, y: FLOOR_Y - Math.max(0, -step) * 14 }];
      const sh = shoulderOf(x, 445, bank);
      const ca = Math.cos(bank);
      const sa = Math.sin(bank);
      const wing = (s) => ({ x: sh.x + s * 0.78 * KP * ca, y: sh.y + 12 + s * 0.78 * KP * sa });
      body.hands = [wing(-1), wing(1)];
      return { body: body, racket: { x: body.hands[1].x, y: body.hands[1].y, ang: bank, t: t } };
    },
    // Air Racket: a solo on the strings, head banging, then the rock star jump
    guitar(t) {
      const bang = reduceMotion ? 0 : Math.sin(t * 14);
      const jump = t > 1.3 && t < 1.75 ? Math.sin(seg(t, 1.3, 1.75) * Math.PI) * 70 : 0;
      const body = { x: PX, crouch: 0.3 + 0.1 * Math.abs(bang), lean: 0.06 * bang, jump: jump, mouth: 0.8, brow: 1, say: t > 0.3 && t < 1.8 ? 'WAAAOW!' : null };
      // Held like a guitar: the head is the body of the guitar, low across the belly; the handle is the neck,
      // rising across to the racket hand, which frets near the end. The other hand strums over the strings.
      // In the jump the neck swings up, rock star style.
      const rise = jump / 70;
      const ang = Math.PI - 0.5 - 0.45 * rise;
      const head = { x: PX + 0.02 * KP, y: 410 - jump };
      const butt = { x: head.x - Math.cos(ang) * 0.68 * RL, y: head.y - Math.sin(ang) * 0.68 * RL };
      const strum = reduceMotion ? 0 : Math.sin(t * 24);
      const fret = reduceMotion ? 0 : Math.sin(t * 9) * 0.04;
      body.hands = [{ x: head.x + 0.02 * KP + strum * 7, y: head.y - 4 + strum * 14 }, { x: butt.x + Math.cos(ang) * (0.12 + fret) * RL, y: butt.y + Math.sin(ang) * (0.12 + fret) * RL }];
      return {
        body: body,
        racket: { x: butt.x, y: butt.y, ang: ang, t: t },
        over(ctx) {
          if (reduceMotion) return;
          ctx.font = 'bold 34px "Trebuchet MS", sans-serif';
          ctx.textAlign = 'center';
          for (let i = 0; i < 3; i++) {
            const k = (t * 1.3 + i / 3) % 1;
            ctx.fillStyle = 'rgba(217,242,74,' + (1 - k).toFixed(2) + ')';
            ctx.fillText(i % 2 ? '\u266B' : '\u266A', PX + 0.75 * KP + i * 26, 380 - k * 150);
          }
        }
      };
    },
    // The Shush: a finger to the lips for the crowd, then a hand cupped to the ear
    shush(t) {
      const u = easeOut(seg(t, 0, 0.3));
      const cup = seg(t, 1.0, 1.25);
      const body = { x: PX, lean: -0.06 * u, smug: true, brow: -0.2, mouth: 0, say: t > 0.3 && t < 1.0 ? 'SHHHHH.' : t >= 1.1 ? 'Sorry, what was that?' : null };
      const rest = { x: PX + 0.42 * KP, y: 455 };
      const lips = { x: PX + 0.05 * KP, y: 300 };
      const finger = { x: lerp(rest.x, lips.x, u), y: lerp(rest.y, lips.y, u) };
      const hip = { x: PX - 0.3 * KP, y: 448 };
      const ear = { x: PX - 0.26 * KP, y: 280 };
      body.hands = [{ x: lerp(hip.x, ear.x, cup), y: lerp(hip.y, ear.y, cup) }, cup > 0 ? { x: lerp(lips.x, rest.x, cup), y: lerp(lips.y, rest.y, cup) } : finger];
      return {
        body: body,
        racket: { x: PX - 0.12 * KP, y: 330, ang: Math.PI * 0.62, t: t },
        racketBehind: true,
        over(ctx) {
          if (u < 0.95 || cup > 0) return;
          ctx.strokeStyle = SKIN;
          ctx.lineWidth = 7;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(lips.x, lips.y + 8);
          ctx.lineTo(lips.x - 2, lips.y - 16);
          ctx.stroke();
        }
      };
    },
    // The Robot: stiff, snapping poses on the beat
    robot(t) {
      const beat = Math.floor(t / 0.24);
      const keys = [
        [[-0.48, 0], [0.48, 0]], [[-0.45, -0.38], [0.22, 0.26]], [[-0.22, 0.26], [0.45, -0.38]],
        [[-0.14, -0.06], [0.14, -0.06]], [[-0.5, -0.5], [0.5, 0.3]], [[-0.5, 0.3], [0.5, -0.5]]
      ];
      const key = keys[beat % keys.length];
      const x = PX + (beat % 4 < 2 ? -1 : 1) * 0.12 * KP;
      const body = { x: x, lean: (beat % 3 - 1) * 0.04, mouth: 0, brow: 0, say: t > 1.5 ? 'BEEP. BOOP.' : null };
      body.hands = key.map((h) => ({ x: x + h[0] * KP, y: 326 + h[1] * KP }));
      return { body: body, racket: { x: body.hands[1].x, y: body.hands[1].y, ang: -Math.PI / 2, t: t } };
    },
    // Knee Slide: a run up, then ten metres on the knees, arms wide
    slide(t) {
      const kneel = seg(t, 0.4, 0.55);
      const sl = easeOut(seg(t, 0.45, 1.3));
      const x = t < 0.45 ? lerp(PX - 1.7 * KP, PX - 0.9 * KP, seg(t, 0, 0.45)) : lerp(PX - 0.9 * KP, PX + 0.9 * KP, sl);
      const step = t < 0.45 && !reduceMotion ? Math.sin(t * 22) : 0;
      const body = { x: x, lean: lerp(0.15, -0.12, kneel), crouch: kneel, jump: -42 * kneel, mouth: 1, brow: 1, say: t > 0.5 ? 'YEEEESSS!' : null };
      const hipY = FLOOR_Y + 42 * kneel - 0.84 * KP * (1 - 0.28 * kneel);
      const sh = shoulderOf(x, hipY, body.lean);
      if (kneel > 0.5) {
        body.kneel = true;
        body.knees = [{ x: x - 0.17 * KP, y: FLOOR_Y - 10 }, { x: x + 0.17 * KP, y: FLOOR_Y - 10 }];
        body.feet = body.knees;
        body.hands = [{ x: sh.x - 0.42 * KP, y: sh.y - 0.4 * KP }, { x: sh.x + 0.42 * KP, y: sh.y - 0.4 * KP }];
      } else {
        body.feet = [{ x: x - 0.17 * KP + step * 0.14 * KP, y: FLOOR_Y - Math.max(0, step) * 16 }, { x: x + 0.17 * KP - step * 0.14 * KP, y: FLOOR_Y - Math.max(0, -step) * 16 }];
        body.hands = [{ x: sh.x - 0.3 * KP, y: sh.y + 0.45 * KP - step * 20 }, { x: sh.x + 0.3 * KP, y: sh.y + 0.45 * KP + step * 20 }];
      }
      const startX = PX - 0.9 * KP;
      return {
        body: body,
        racket: { x: body.hands[1].x, y: body.hands[1].y, ang: kneel > 0.5 ? -Math.PI / 2 - 0.3 : Math.PI / 2, t: t },
        under(ctx) {
          if (kneel < 0.5) return;
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          ctx.fillRect(startX, FLOOR_Y - 4, x - startX, 8);
          if (reduceMotion || t > 1.3) return;
          ctx.fillStyle = 'rgba(200,190,150,0.7)';
          for (let i = 0; i < 6; i++) {
            const k = (t * 5 + i / 6) % 1;
            ctx.beginPath();
            ctx.arc(x - 0.2 * KP - k * 80 + (i % 2) * 0.4 * KP, FLOOR_Y - 10 - Math.sin(k * Math.PI) * 30, 5 * (1 - k) + 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      };
    },
    // The Worm: face first onto the court and a full length ripple along it
    worm(t) {
      const dive = easeOut(seg(t, 0, 0.35));
      const w = reduceMotion ? 0 : Math.max(0, t - 0.35) * 7;
      const hipLift = dive < 1 ? 0 : Math.max(0, Math.sin(w)) * 0.22 * KP;
      const chestLift = dive < 1 ? 0 : Math.max(0, Math.sin(w - 1.3)) * 0.2 * KP;
      const feetLift = dive < 1 ? 0 : Math.max(0, Math.sin(w + 1.3)) * 0.25 * KP;
      const x = PX + 0.4 * KP - seg(t, 0.35, 2) * 0.6 * KP;
      const lieY = FLOOR_Y - 0.13 * KP;
      const hipY = lerp(440, lieY - hipLift, dive);
      const lean = lerp(0, -Math.PI / 2 + (chestLift - hipLift) / (0.66 * KP), dive);
      const body = { x: x, lean: lean, jump: -(hipY - 440), mouth: 0.5, brow: 0, say: t > 1.45 ? 'Ta da.' : null, smug: t > 1.45 };
      const sh = shoulderOf(x, hipY, lean);
      if (dive > 0.6) {
        body.knees = [{ x: x + 0.42 * KP, y: FLOOR_Y - 14 - feetLift * 0.5 }, { x: x + 0.44 * KP, y: FLOOR_Y - 10 - feetLift * 0.5 }];
        body.feet = [{ x: x + 0.82 * KP, y: FLOOR_Y - 8 - feetLift }, { x: x + 0.86 * KP, y: FLOOR_Y - 4 - feetLift }];
        body.hands = [{ x: sh.x - 0.12 * KP, y: FLOOR_Y - 6 }, { x: sh.x + 0.08 * KP, y: FLOOR_Y - 6 }];
      } else {
        body.hands = [{ x: sh.x - 0.4 * KP, y: sh.y + 0.2 * KP }, { x: sh.x - 0.25 * KP, y: sh.y + 0.3 * KP }];
      }
      return { body: body, racket: { x: PX + 1.05 * KP, y: FLOOR_Y - 4, ang: Math.PI, flat: 0.42, t: t } };
    },
    // Backflip: crouch, launch, one full turn, stick the landing
    // Reactions to the camera, played during a reaction cut. The line comes from REACT_SAY.
    // The Glare: a slow turn to the lens, then a finger pointed straight at it
    r_glare(t) {
      const u = easeOut(seg(t, 0, 0.35));
      const body = { x: PX, brow: 1, mouth: 0, lean: 0.08 * u, steam: M && M.rage > 0.6, say: t > 0.35 ? REACT_SAY : null };
      const point = { x: lerp(PX + 0.42 * KP, PX + 0.12 * KP, u), y: lerp(455, 330, u) };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, point];
      return { body: body, racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t } };
    },
    // The Facepalm: a hand over the face, a slow shake of the head
    r_facepalm(t) {
      const u = easeOut(seg(t, 0, 0.3));
      const shake = reduceMotion ? 0 : Math.sin(t * 9) * 0.06 * u;
      const body = { x: PX, brow: -1, mouth: 0.15, lean: shake, crouch: 0.1 * u, say: t > 0.3 ? REACT_SAY : null };
      const face = { x: lerp(PX + 0.42 * KP, PX + 0.04 * KP, u), y: lerp(455, 252, u) };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, face];
      return { body: body, racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t } };
    },
    // The Shrug: arms out, palms up, appealing to the nation
    r_shrug(t) {
      const u = easeOut(seg(t, 0, 0.3));
      const bob = reduceMotion ? 0 : Math.abs(Math.sin(t * 6)) * 10 * u;
      const body = { x: PX, brow: -0.6, mouth: 0.7, crouch: 0.08 * u, say: t > 0.25 ? REACT_SAY : null };
      body.hands = [{ x: PX - lerp(0.42, 0.68, u) * KP, y: lerp(462, 372, u) - bob }, { x: PX + lerp(0.42, 0.68, u) * KP, y: lerp(462, 372, u) - bob }];
      return { body: body, racket: { x: body.hands[1].x, y: body.hands[1].y, ang: lerp(Math.PI / 2 + 0.3, -0.25, u), t: t } };
    },
    // The Wink: a finger gun at the lens
    r_wink(t) {
      const u = easeOut(seg(t, 0, 0.3));
      const kick = t > 0.45 && t < 0.6 && !reduceMotion ? -14 : 0;
      const body = { x: PX, smug: true, brow: -0.3, mouth: 0, lean: -0.05 * u, say: t > 0.3 ? REACT_SAY : null };
      const gun = { x: lerp(PX + 0.42 * KP, PX + 0.3 * KP, u), y: lerp(455, 315, u) + kick };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, gun];
      return { body: body, racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t } };
    },
    // The Flex: a kiss on the bicep, eyebrows doing the rest
    r_flex(t) {
      const u = easeOut(seg(t, 0, 0.3));
      const body = { x: PX, smug: true, brow: -0.4, mouth: t > 0.55 && t < 0.8 ? 0.15 : 0.5, lean: -0.08 * u, say: t > 0.3 ? REACT_SAY : null };
      const fist = { x: lerp(PX + 0.42 * KP, PX + 0.2 * KP, u), y: lerp(455, 262, u) };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, fist];
      return { body: body, racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t } };
    },
    // Theatre Bow: a flourish, a deep bow, then kisses blown to the gods; roses land around you
    bow(t) {
      const flour = easeOut(seg(t, 0, 0.35));
      const down = seg(t, 0.35, 0.7) * (1 - seg(t, 1.2, 1.45));
      // From the front a bow is the head and shoulders going down, not sideways: a forward bend, a little dip,
      // one hand to the waist and the other arm sweeping out wide and low
      const dn = easeOut(down);
      const body = { x: PX, lean: -0.05 * dn, bend: 0.85 * dn, crouch: 0.15 * dn, smug: true, brow: -0.3, mouth: t > 1.45 ? 0.15 : 0.4, say: t > 1.45 ? 'Thank you, thank you.' : null };
      body.hands = t < 1.45
        ? [{ x: PX - lerp(lerp(0.42, 0.7, flour), 0.8, dn) * KP, y: lerp(lerp(462, 290, flour), 470, dn) }, { x: PX + lerp(0.2, 0.02, dn) * KP, y: lerp(420, 432, dn) }]
        : [{ x: PX + 0.05 * KP, y: 262 }, { x: PX + 0.42 * KP, y: 455 }];
      return {
        body: body,
        racket: { x: body.hands[1].x, y: body.hands[1].y, ang: Math.PI / 2 + 0.3, t: t },
        over(ctx) {
          if (reduceMotion) return;
          for (let i = 0; i < 6; i++) {
            const k = (t - 0.5 - i * 0.12) / 0.7;
            if (k < 0) continue;
            const side = i % 2 ? 1 : -1;
            const x = PX + side * (300 - Math.min(1, k) * (160 - i * 12));
            const y = k < 1 ? 120 + k * k * (FLOOR_Y - 130) : FLOOR_Y - 8;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(k < 1 ? k * 6 : 1.2);
            ctx.strokeStyle = '#2f7a3c';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, 44);
            ctx.stroke();
            ctx.fillStyle = '#c8102e';
            ctx.strokeStyle = '#0b0b0b';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(0, 0, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#8a0c20';
            ctx.beginPath();
            ctx.arc(-3, -2, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      };
    },
    // Mic Drop: a microphone from your pocket, one line, and the drop
    mic(t) {
      const up = easeOut(seg(t, 0, 0.3));
      const drop = t > 1.25;
      const body = { x: PX, smug: t > 0.8, brow: -0.3, mouth: t < 1.25 ? 0.6 : 0, say: t > 0.3 && t < 1.2 ? 'And THAT...' : t >= 1.3 ? '...is tennis.' : null };
      const micHand = drop ? { x: PX + 0.7 * KP, y: 320 } : { x: lerp(PX + 0.42 * KP, PX + 0.18 * KP, up), y: lerp(455, 285, up) };
      if (t > 0.95 && !drop) { const k = seg(t, 0.95, 1.25); micHand.x = lerp(PX + 0.18 * KP, PX + 0.7 * KP, k); micHand.y = lerp(285, 320, k); }
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, micHand];
      const fall = Math.max(0, t - 1.25);
      return {
        body: body,
        racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t },
        over(ctx) {
          const mx = drop ? PX + 0.7 * KP : micHand.x;
          const my = drop ? Math.min(FLOOR_Y - 10, 320 + fall * fall * 1600) : micHand.y;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(drop ? Math.min(1.4, fall * 6) : -0.5);
          ctx.fillStyle = '#1a1a1a';
          ctx.strokeStyle = '#0b0b0b';
          ctx.lineWidth = 2;
          roundRect(ctx, -6, -6, 12, 46, 4);
          ctx.fill();
          ctx.fillStyle = '#8a8f96';
          ctx.beginPath();
          ctx.arc(0, -14, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          if (drop && my >= FLOOR_Y - 10 && !reduceMotion) {
            const k = Math.min(1, (fall - 0.22) * 3);
            if (k > 0 && k < 1) {
              ctx.strokeStyle = 'rgba(255,255,255,' + (1 - k).toFixed(2) + ')';
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.ellipse(mx, FLOOR_Y - 4, 20 + k * 60, 5 + k * 12, 0, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      };
    },
    // The Selfie: phone up at arm's length, peace sign, pout, flash, then straight to posting it
    selfie(t) {
      const up = easeOut(seg(t, 0, 0.35));
      const check = t > 1.25;
      const body = { x: PX, smug: true, brow: -0.4, mouth: t > 0.4 && t < 1.25 ? 0.05 : 0.3, lean: -0.08 * up, say: check ? 'Posting that.' : null };
      const phone = check ? { x: PX + 0.2 * KP, y: 330 } : { x: lerp(PX + 0.42 * KP, PX + 0.62 * KP, up), y: lerp(455, 205, up) };
      const peace = check ? { x: PX - 0.42 * KP, y: 462 } : { x: lerp(PX - 0.42 * KP, PX - 0.4 * KP, up), y: lerp(462, 240, up) };
      body.hands = [peace, phone];
      return {
        body: body,
        racket: null,
        over(ctx) {
          ctx.save();
          ctx.translate(phone.x, phone.y);
          ctx.rotate(check ? 0 : -0.35);
          ctx.fillStyle = '#16181c';
          roundRect(ctx, -14, -24, 28, 46, 5);
          ctx.fill();
          ctx.fillStyle = check ? '#6fd3ff' : '#2a3038';
          ctx.fillRect(-11, -20, 22, 36);
          ctx.restore();
          if (!check) {
            // Two fingers up
            ctx.strokeStyle = '#0b0b0b';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(peace.x - 4, peace.y - 6);
            ctx.lineTo(peace.x - 10, peace.y - 26);
            ctx.moveTo(peace.x + 4, peace.y - 6);
            ctx.lineTo(peace.x + 8, peace.y - 26);
            ctx.stroke();
          }
          const f = t - 1.0;
          if (f > 0 && f < 0.25 && !reduceMotion) {
            ctx.fillStyle = 'rgba(255,255,255,' + (0.9 * (1 - f / 0.25)).toFixed(2) + ')';
            ctx.beginPath();
            ctx.arc(phone.x, phone.y, 40 + f * 600, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      };
    },
    // Champagne Shower: a bottle shaken, popped, and sprayed over the front row
    champagne(t) {
      const shake = t < 0.8 && !reduceMotion ? Math.sin(t * 40) * 14 : 0;
      const pop = seg(t, 0.8, 0.95);
      const body = { x: PX, crouch: t < 0.8 ? 0.2 : 0.05, lean: t < 0.8 ? 0 : -0.1, mouth: t < 0.8 ? 0.3 : 0.9, brow: t < 0.8 ? 0.4 : 1, say: t > 0.8 && t < 1.9 ? 'CHEERS!' : null };
      const tip = t < 0.8 ? { x: PX + 0.25 * KP + shake, y: 360 + shake * 0.4 } : { x: lerp(PX + 0.25 * KP, PX + 0.7 * KP, pop), y: lerp(360, 292, pop) };
      const ang = t < 0.8 ? -Math.PI / 2 : lerp(-Math.PI / 2, -0.7, pop);
      const hold = { x: tip.x - Math.cos(ang) * 46, y: tip.y - Math.sin(ang) * 46 };
      const low = { x: PX - 0.42 * KP, y: 462 };
      body.hands = [low, hold];
      return {
        body: body,
        racket: { x: low.x, y: low.y, ang: Math.PI / 2 + 0.3, t: t },
        over(ctx) {
          // The bottle: dark green glass, gold foil at the neck
          ctx.save();
          ctx.translate(hold.x, hold.y);
          ctx.rotate(ang + Math.PI / 2);
          ctx.fillStyle = '#1d4a2c';
          ctx.strokeStyle = '#0b0b0b';
          ctx.lineWidth = 3;
          roundRect(ctx, -14, -10, 28, 70, 10);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#f4f1e6';
          ctx.fillRect(-14, 14, 28, 18);
          ctx.fillStyle = '#d4af37';
          roundRect(ctx, -7, -40, 14, 34, 4);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          if (t < 0.8 || reduceMotion) return;
          // The spray: foam in an arc that rises and falls on the crowd
          const a = t - 0.8;
          const dx = Math.cos(ang);
          const dy = Math.sin(ang);
          for (let i = 0; i < 46; i++) {
            const k = ((i * 0.137 + a * 1.8) % 1);
            const life = Math.min(1, a * 2);
            const d = k * 560 * life;
            const x = tip.x + dx * d + (i % 5 - 2) * 4;
            const y = tip.y + dy * d + k * k * 260 + (i % 3) * 5;
            ctx.fillStyle = 'rgba(255,248,214,' + (0.9 - k * 0.7).toFixed(2) + ')';
            ctx.beginPath();
            ctx.arc(x, y, 3 + (i % 4) * 2 + k * 5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      };
    },
    // The Trophy Lift: a gold cup, raised over the head, then kissed
    trophy(t) {
      const lift = easeOut(seg(t, 0, 0.5));
      const kiss = seg(t, 1.45, 1.75);
      const bob = reduceMotion ? 0 : Math.sin(t * 7) * 6 * (t > 0.5 && t < 1.45 ? 1 : 0);
      const cupY = t < 1.45 ? lerp(420, 168, lift) + bob : lerp(168, 335, easeOut(kiss));
      // Held aloft, the cup is behind your head (your hands on its handles); for the kiss it comes in front
      const body = { x: PX, jump: t > 0.5 && t < 1.45 ? Math.abs(Math.sin(t * 7)) * 12 : 0, mouth: kiss > 0.5 ? 0.15 : 0.8, brow: 1, smug: kiss > 0.5, say: t > 0.55 && t < 1.4 ? 'MINE!' : t >= 1.5 ? 'Mwah.' : null };
      body.hands = t < 1.45 ? [{ x: PX - 0.27 * KP, y: cupY + 26 }, { x: PX + 0.27 * KP, y: cupY + 26 }] : [{ x: PX - 0.2 * KP, y: cupY + 40 }, { x: PX + 0.2 * KP, y: cupY + 40 }];
      body.elbowsOut = t < 1.45;
      const behind = t < 1.45 && t > 0.2;
      const drawCup = (ctx) => {
          // A gold cup with two handles on a black plinth
          const x = PX;
          const y = cupY;
          ctx.save();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#0b0b0b';
          ctx.fillStyle = '#1a1a1a';
          ctx.fillRect(x - 26, y + 52, 52, 16);
          ctx.strokeRect(x - 26, y + 52, 52, 16);
          const g = ctx.createLinearGradient(x - 40, 0, x + 40, 0);
          g.addColorStop(0, '#a8862e');
          g.addColorStop(0.4, '#ffe89a');
          g.addColorStop(1, '#c99a2e');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(x - 38, y - 40);
          ctx.lineTo(x + 38, y - 40);
          ctx.quadraticCurveTo(x + 36, y + 14, x + 8, y + 26);
          ctx.lineTo(x + 10, y + 52);
          ctx.lineTo(x - 10, y + 52);
          ctx.lineTo(x - 8, y + 26);
          ctx.quadraticCurveTo(x - 36, y + 14, x - 38, y - 40);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.lineWidth = 7;
          ctx.strokeStyle = '#c99a2e';
          [-1, 1].forEach((sd) => {
            ctx.beginPath();
            ctx.arc(x + sd * 42, y - 18, 16, sd > 0 ? -Math.PI / 2 : Math.PI / 2, sd > 0 ? Math.PI / 2 : Math.PI * 1.5);
            ctx.stroke();
          });
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillRect(x - 24, y - 34, 6, 30);
          ctx.restore();
      };
      return { body: body, racket: null, under: behind ? drawCup : null, over: behind ? null : drawCup };
    },
    // Fireworks: one racket raised to the sky, and the sky goes off
    fireworks(t) {
      const up = easeOut(seg(t, 0, 0.4));
      const body = { x: PX, lean: -0.05 * up, mouth: 0.5, brow: 0.6, smug: t > 1.2, say: t > 0.35 && t < 1.9 ? 'BEHOLD.' : null };
      const hand = { x: lerp(PX + 0.42 * KP, PX + 0.3 * KP, up), y: lerp(455, 200, up) };
      body.hands = [{ x: PX - 0.3 * KP, y: 448 }, hand];
      const BURSTS = [[0.5, -175, 200, '#ff3b30'], [0.85, 175, 160, '#d9f24a'], [1.2, -140, 120, '#6fd3ff'], [1.5, 185, 250, '#ffb03a']];
      return {
        body: body,
        racket: { x: hand.x, y: hand.y, ang: -Math.PI / 2 + 0.1 * up, t: t },
        over(ctx) {
          BURSTS.forEach((b) => {
            const a = t - b[0];
            if (a < 0 || a > 0.9) return;
            const cx = PX + b[1];
            const cy = b[2];
            const r = easeOut(Math.min(1, a / 0.5)) * 78;
            ctx.save();
            ctx.globalAlpha = Math.max(0, 1 - a / 0.9);
            ctx.fillStyle = b[3];
            for (let i = 0; i < 18; i++) {
              const an = i / 18 * Math.PI * 2;
              const sag = a * a * 60;
              ctx.beginPath();
              ctx.arc(cx + Math.cos(an) * r, cy + Math.sin(an) * r + sag, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillRect(cx + Math.cos(an) * r * 0.6 - 1.5, cy + Math.sin(an) * r * 0.6 + sag - 1.5, 3, 3);
            }
            ctx.restore();
          });
        }
      };
    },
    backflip(t) {
      const crouch = seg(t, 0, 0.3);
      const air = seg(t, 0.3, 0.95);
      const land = seg(t, 0.95, 1.25);
      const jump = Math.sin(air * Math.PI) * 170;
      const body = { x: PX, jump: jump, mouth: t > 0.95 ? 0.4 : 0.6, brow: t > 1.1 ? -0.2 : 1, smug: t > 1.2, say: t > 1.15 ? 'Perfect ten.' : null };
      if (t < 0.3) {
        body.crouch = 0.7 * easeIn(crouch);
        body.hands = [{ x: PX - 0.35 * KP, y: 500 }, { x: PX + 0.35 * KP, y: 500 }];
      } else if (t < 0.95) {
        body.crouch = 1;
        const hipY = FLOOR_Y - jump - 0.84 * KP * 0.72;
        body.knees = [{ x: PX - 0.12 * KP, y: hipY - 0.15 * KP }, { x: PX + 0.12 * KP, y: hipY - 0.15 * KP }];
        body.feet = [{ x: PX - 0.1 * KP, y: hipY + 0.2 * KP }, { x: PX + 0.1 * KP, y: hipY + 0.2 * KP }];
        body.hands = [{ x: PX - 0.14 * KP, y: hipY - 0.12 * KP }, { x: PX + 0.14 * KP, y: hipY - 0.12 * KP }];
      } else {
        body.crouch = 0.5 * (1 - land);
        body.hands = [{ x: PX - 0.42 * KP, y: 215 }, { x: PX + 0.42 * KP, y: 215 }];
      }
      if (t > 0.3 && t < 0.95) body.noShadow = true;
      const spin = t > 0.3 && t < 0.95 && !reduceMotion ? { x: PX, y: FLOOR_Y - jump - 0.9 * KP, ang: -Math.PI * 2 * air * air * (3 - 2 * air) } : null;
      return {
        body: body,
        racket: { x: body.hands[1].x, y: body.hands[1].y, ang: t > 0.95 ? -Math.PI / 2 : t < 0.3 ? -0.5 : lerp(-0.5, Math.PI / 2, Math.min(1, air / 0.3)), t: t },
        spin: spin,
        under(ctx) {
          if (!body.noShadow) return;
          ctx.fillStyle = 'rgba(0,0,0,' + (0.35 - jump / 900).toFixed(2) + ')';
          ctx.beginPath();
          ctx.ellipse(PX, FLOOR_Y + 3, 0.45 * KP * (1 - jump / 400), 0.08 * KP, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      };
    }
  };

  // Each routine returns the pose at time t: { body, racket, racketBehind, under, over }.
  // Impact (the break) happens at SMASH_T in every routine.
  const TANTRUM = {
    // The Royal Box Incident: a javelin run up and a throw that does not stop until the stands
    royal(t) {
      const u = seg(t, 0, 0.55);
      const e = easeIn(seg(t, 0.55, SMASH_T));
      const a = Math.max(0, t - SMASH_T);
      const bx = t < 0.55 ? lerp(PX - 280, PX, easeOut(u)) : PX;
      const body = { x: bx, mouth: 1, brow: 1, steam: true, lean: -0.15 };
      if (t < 0.55) {
        const ph = t * 28;
        body.feet = [
          { x: bx - 0.16 * KP + Math.sin(ph) * 0.18 * KP, y: FLOOR_Y - Math.max(0, Math.sin(ph)) * 22 },
          { x: bx + 0.16 * KP - Math.sin(ph) * 0.18 * KP, y: FLOOR_Y - Math.max(0, -Math.sin(ph)) * 22 }
        ];
        body.say = 'HAAAAA!';
      }
      if (t < SMASH_T) {
        // Racket cocked back over the shoulder like a javelin, then whipped over the top
        const ang = t < 0.55 ? Math.PI * 0.8 : lerp(Math.PI * 0.8, -Math.PI / 2 - 0.2, e);
        const butt = { x: bx + lerp(0.35, 0.15, e) * KP, y: lerp(260, 205, e) };
        body.lean = t < 0.55 ? -0.2 : lerp(-0.3, 0.35, e);
        body.hands = [{ x: bx - 0.45 * KP, y: 330 }, butt];
        // Cocked, the head hangs down behind your back; it comes into view as it whips over the top
        return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, t: t }, racketBehind: ang > 1.0 };
      }
      // Released: the follow through, then the dawning horror
      body.say = a < 0.6 ? null : a < 1.6 ? 'Oh.' : 'OH NO.';
      body.mouth = a < 1.4 ? 0.6 : 0.9;
      body.brow = a < 0.4 ? 1 : -1;
      body.steam = a < 0.6;
      body.lean = a < 0.4 ? 0.35 : 0;
      body.hands = a < 0.4 ? [{ x: PX + 0.3 * KP, y: 300 }, { x: PX + 0.5 * KP, y: 250 }] : [{ x: PX - 0.16 * KP, y: 245 }, { x: PX + 0.16 * KP, y: 245 }];
      return { body: body, racket: null };
    },
    // Binned: marched to the courtside bin and posted head first. The lid will not shut on the handle.
    bin(t) {
      const bc = PX + 0.95 * KP;               // the bin's centre
      const top = FLOOR_Y - 0.82 * KP;         // its rim
      const a = Math.max(0, t - SMASH_T);
      const lid = t < 0.45 ? 0 : t < SMASH_T + 0.1 ? 1 : Math.max(0.42, 1 - (t - SMASH_T - 0.1) * 7);   // propped open by the handle
      const under = (ctx) => {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(bc - 58, FLOOR_Y - 6, 124, 10);
        ctx.fillStyle = '#163f25';
        ctx.fillRect(bc - 50, top, 100, 10);
      };
      const over = (ctx) => {
        ctx.fillStyle = '#2d7a47';
        ctx.beginPath();
        ctx.moveTo(bc - 52, top + 6);
        ctx.lineTo(bc + 52, top + 6);
        ctx.lineTo(bc + 45, FLOOR_Y - 14);
        ctx.lineTo(bc - 45, FLOOR_Y - 14);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#1f5a34';
        ctx.fillRect(bc - 54, top + 4, 108, 12);
        ctx.fillStyle = '#1a1a1a';
        [bc - 34, bc + 34].forEach((x) => { ctx.beginPath(); ctx.arc(x, FLOOR_Y - 12, 11, 0, Math.PI * 2); ctx.fill(); });
        ctx.fillStyle = '#f4f1e6';
        ctx.font = 'bold 12px "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GENERAL', bc, top + 52);
        ctx.fillText('WASTE', bc, top + 68);
        // The lid, hinged at the back right corner
        ctx.save();
        ctx.translate(bc + 54, top + 4);
        ctx.rotate(lid * 1.9);
        ctx.fillStyle = '#24643c';
        ctx.fillRect(-108, -10, 108, 12);
        ctx.restore();
      };
      const bx = t < 0.45 ? lerp(PX - 0.35 * KP, PX, easeOut(seg(t, 0, 0.45))) : PX;
      const body = { x: bx, mouth: 1, brow: 1, steam: true };
      let butt;
      let ang;
      if (t < 0.45) {
        const ph = t * 24;
        body.feet = [
          { x: bx - 0.16 * KP + Math.sin(ph) * 0.12 * KP, y: FLOOR_Y - Math.max(0, Math.sin(ph)) * 16 },
          { x: bx + 0.16 * KP - Math.sin(ph) * 0.12 * KP, y: FLOOR_Y - Math.max(0, -Math.sin(ph)) * 16 }
        ];
        butt = { x: bx + 0.32 * KP, y: 430 };
        ang = -Math.PI / 2 + 0.15;
        body.say = 'Right. You.';
        body.mouth = 0.3;
        body.hands = [{ x: bx - 0.3 * KP, y: 448 }, butt];
      } else if (t < SMASH_T) {
        // Up over the rim, flipped head down, then rammed in
        const up = easeOut(seg(t, 0.45, 0.68));
        const ram = easeIn(seg(t, 0.68, SMASH_T));
        butt = { x: lerp(PX + 0.32 * KP, bc - 4, up), y: lerp(lerp(430, 225, up), top - 44, ram) };
        ang = lerp(-Math.PI / 2 + 0.15, Math.PI / 2, up);
        body.lean = lerp(0, 0.3, up);
        body.say = 'IN. YOU. GO.';
        body.hands = grip(butt, ang);
      } else {
        butt = { x: bc - 4, y: top - 44 };
        ang = Math.PI / 2;
        body.lean = lerp(0.3, 0, seg(a, 0.1, 0.4));
        // Brushing the hands together: job done
        const brush = Math.sin(a * 22) * 0.12 * KP;
        body.hands = a < 0.25 ? grip(butt, ang) : [{ x: PX - 0.05 * KP + brush, y: 360 }, { x: PX + 0.05 * KP - brush, y: 368 }];
        body.mouth = a < 0.3 ? 1 : 0;
        if (a > 0.6) { body.smug = true; body.brow = -0.3; body.steam = false; body.say = 'Recycling.'; }
      }
      return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, crack: a > 0, t: t }, under: under, over: over };
    },
    // Hoofed: held out at arm's length, dropped, then drop kicked into the stand
    hoof(t) {
      const a = Math.max(0, t - SMASH_T);
      const rest = { x: PX + 0.02 * KP, y: FLOOR_Y - 4, ang: 0, flat: 0.42 };
      const body = { x: PX, mouth: 0.2, brow: 1, steam: true };
      let racket;
      if (t < 0.4) {
        const butt = { x: PX + 0.36 * KP, y: 352 };
        racket = { x: butt.x, y: butt.y, ang: -0.1, t: t };
        body.hands = [{ x: PX - 0.3 * KP, y: 448 }, butt];
        body.say = 'Look at you.';
      } else if (t < 0.6) {
        // Let go: it drops and lands flat in front of you
        const k = easeIn(seg(t, 0.4, 0.6));
        racket = { x: lerp(PX + 0.36 * KP, rest.x, k), y: lerp(352, rest.y, k), ang: lerp(-0.1, 0, k), flat: lerp(1, rest.flat, k), t: t };
        body.hands = [{ x: PX - 0.3 * KP, y: 448 }, { x: PX + 0.36 * KP, y: lerp(352, 380, k) }];
        body.mouth = 0.5;
      } else if (t < SMASH_T) {
        // Wind up: kicking foot back, arms out for balance, then through
        const back = easeOut(seg(t, 0.6, 0.76));
        const thru = easeIn(seg(t, 0.76, SMASH_T));
        racket = Object.assign({}, rest, { t: t });
        body.feet = [{ x: PX - 0.17 * KP, y: FLOOR_Y }, { x: lerp(lerp(PX + 0.17 * KP, PX - 0.45 * KP, back), rest.x + RL * 0.55, thru), y: lerp(lerp(FLOOR_Y, FLOOR_Y - 0.4 * KP, back), FLOOR_Y - 12, thru) }];
        body.hands = [{ x: PX - 0.6 * KP, y: 330 }, { x: PX + 0.5 * KP, y: 300 }];
        body.lean = lerp(-0.15, 0.12, thru);
        body.mouth = 1;
        body.say = 'HAAAA!';
      } else {
        // Away it goes, spinning into the stand
        const x = rest.x + RL * 0.55 + 760 * a;
        const y = FLOOR_Y - 20 - 980 * a + 520 * a * a;
        racket = x < W + 200 && y > -200 ? { x: x, y: y, ang: 22 * a, scale: Math.max(0.15, 1 - 0.7 * a), crack: true, t: t } : null;
        const follow = a < 0.35;
        body.feet = follow ? [{ x: PX - 0.17 * KP, y: FLOOR_Y }, { x: PX + 0.5 * KP, y: FLOOR_Y - 0.75 * KP }] : null;
        body.lean = follow ? -0.2 : 0;
        if (a > 0.5) {
          body.jump = Math.abs(Math.sin(a * 8)) * 26;
          body.hands = [{ x: PX - 0.42 * KP, y: 215 }, { x: PX + 0.42 * KP, y: 215 }];
          body.mouth = 1;
          body.brow = -0.3;
          body.steam = false;
          body.say = 'GOAAAAL!';
        } else {
          body.hands = [{ x: PX - 0.6 * KP, y: 330 }, { x: PX + 0.5 * KP, y: 300 }];
          body.mouth = 1;
        }
      }
      return { body: body, racket: racket };
    },
    // Spiked: racket raised overhead with a scream, a little jump, slammed head first into the court
    spike(t) {
      const u = seg(t, 0, 0.5);
      const v = seg(t, 0.5, SMASH_T);
      const e = easeIn(v);
      const a = Math.max(0, t - SMASH_T);
      const body = { x: PX, lean: -0.22 * easeOut(u), crouch: 0.35 * u, mouth: t > 0.12 ? 1 : 0.3, brow: 1, steam: true, say: t > 0.12 && a < 0.5 ? 'RAAAAAH!' : null };
      let butt;
      let ang;
      if (t < 0.5) {
        butt = { x: PX + 0.08 * KP, y: lerp(430, 215, easeOut(u)) };
        ang = lerp(-Math.PI / 2 + 0.3, -Math.PI / 2 - 0.75, u);
      } else if (t < SMASH_T) {
        butt = { x: lerp(PX + 0.08 * KP, PX + 0.62 * KP, e), y: lerp(215, FLOOR_Y - RL * 0.99, e) };
        ang = lerp(-Math.PI / 2 - 0.75, Math.PI / 2, e);
        body.jump = Math.sin(v * Math.PI) * 60;
        body.lean = lerp(-0.22, 0.55, e);
        body.crouch = lerp(0.35, 0.5, e);
      } else {
        butt = { x: PX + 0.62 * KP, y: FLOOR_Y - RL * 0.99 };
        ang = Math.PI / 2;
        const r = seg(a, 0.3, 0.7);
        body.lean = lerp(0.55, -0.05, r);
        body.crouch = lerp(0.5, 0, r);
        body.mouth = a < 0.3 ? 1 : 0;
        if (a > 0.6) { body.smug = true; body.brow = -0.3; body.say = 'It slipped.'; body.steam = false; }
      }
      body.hands = a < 0.3 ? grip(butt, ang) : handsOnHips(PX);
      return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, crack: a > 0, bend: Math.min(1, a * 9) * 0.85, t: t } };
    },
    // Tacoed: the same slam, then it folds, falls over, and you shrug at the crowd
    taco(t) {
      if (t < SMASH_T) return TANTRUM.spike(t);
      const a = t - SMASH_T;
      const endX = PX + 0.62 * KP;
      const endY = FLOOR_Y - RL * 0.99;
      const fall = Math.min(1, Math.max(0, a - 0.25) * 2.2);
      const racket = { x: endX - fall * fall * RL * 0.55, y: endY + fall * fall * RL * 0.62, ang: Math.PI / 2 + fall * fall * 1.25, fold: Math.min(1, a * 6), bend: 0.25, crack: true, t: t };
      const r = seg(a, 0.15, 0.5);
      const body = { x: PX, lean: lerp(0.55, 0, r), crouch: lerp(0.5, 0, r), mouth: a < 0.2 ? 1 : 0, brow: a > 0.5 ? -0.7 : 1, steam: a < 0.5 };
      body.hands = a < 0.15 ? grip({ x: endX, y: endY }, Math.PI / 2) : [{ x: PX - 0.55 * KP, y: 300 }, { x: PX + 0.55 * KP, y: 300 }];
      if (a > 0.55) body.say = 'Faulty frame.';
      return { body: body, racket: racket };
    },
    // Strung Out: thrown on the floor, then stomped on three times until every string goes
    strings(t) {
      const rest = { x: PX - 0.05 * KP, y: FLOOR_Y - 4, ang: 0, flat: 0.42 };
      const headX = rest.x + RL * 0.71;
      const body = { x: PX - 0.2 * KP, brow: 1, mouth: 0.5, steam: true };
      let racket;
      if (t < 0.35) {
        const butt = { x: PX + 0.05 * KP, y: 360 };
        racket = { x: butt.x, y: butt.y, ang: -1.25, t: t };
        body.hands = [{ x: PX - 0.42 * KP, y: 440 }, butt];
        body.say = 'You.';
        body.mouth = 0.15;
      } else if (t < 0.55) {
        const k = easeIn(seg(t, 0.35, 0.55));
        const butt = { x: lerp(PX + 0.05 * KP, rest.x, k), y: lerp(360, rest.y, k) };
        racket = { x: butt.x, y: butt.y, ang: lerp(-1.25, 0, k), flat: lerp(1, rest.flat, k), t: t };
        body.hands = [{ x: PX - 0.42 * KP, y: 440 }, { x: lerp(PX + 0.05 * KP, PX + 0.35 * KP, k), y: lerp(360, 470, k) }];
        body.lean = 0.3 * k;
      } else {
        const stomps = [[0.55, SMASH_T], [SMASH_T, 1.32], [1.32, 1.74]];
        let jump = 0;
        let stomping = false;
        stomps.forEach((wnd) => {
          if (t >= wnd[0] && t < wnd[1]) {
            const s = seg(t, wnd[0], wnd[1]);
            jump = Math.sin(s * Math.PI) * 75;
            stomping = s > 0.55;
          }
        });
        const done = stomps.filter((wnd) => t >= wnd[1]).length;
        body.x = lerp(PX - 0.2 * KP, headX, easeOut(seg(t, 0.55, 0.8)));
        body.jump = jump;
        body.mouth = 1;
        body.say = t < 1.85 ? 'STAY. DOWN.' : 'Lovely sound.';
        if (t >= 1.85) { body.mouth = 0; body.smug = true; body.brow = -0.3; body.steam = false; }
        body.hands = t < 1.85 ? [{ x: body.x - 0.55 * KP, y: 330 }, { x: body.x + 0.55 * KP, y: 330 }] : handsOnHips(body.x);
        if (jump > 1) {
          // Left knee tucked, right heel driving down
          body.feet = [{ x: body.x - 0.18 * KP, y: FLOOR_Y - jump - 0.22 * KP }, { x: body.x + 0.08 * KP, y: FLOOR_Y - jump * (stomping ? 0.15 : 0.6) }];
        }
        racket = Object.assign({}, rest, { crack: done > 0, stringsGone: Math.min(1, done * 0.34 + (stomping ? 0.08 : 0)), t: t });
      }
      return { body: body, racket: racket, racketBehind: t >= 0.55 };
    },
    // Snapped: across the thigh like a breadstick, a victory pose, then the knee files a complaint
    knee(t) {
      const u = seg(t, 0, 0.5);
      const v = seg(t, 0.5, SMASH_T);
      const e = easeIn(v);
      const a = Math.max(0, t - SMASH_T);
      const jit = t < SMASH_T && !reduceMotion ? Math.sin(t * 70) * 3 * (0.3 + u) : 0;
      const kneeY = 455;
      const body = { x: PX, mouth: 0.3, brow: 1, steam: true };
      if (t < SMASH_T) {
        const upK = easeOut(v);
        body.knees = [{ x: PX - 0.1 * KP, y: lerp(520, kneeY + 0.05 * KP, upK) }, null];
        body.feet = [{ x: PX - 0.12 * KP, y: lerp(FLOOR_Y, kneeY + 0.42 * KP, upK) }, null];
        const y = lerp(400, kneeY - 0.04 * KP, e) + jit;
        const butt = { x: PX - 0.1 * KP - RL * 0.5 + jit, y: y };
        body.hands = [{ x: butt.x + 0.05 * RL, y: y }, { x: butt.x + 0.85 * RL, y: y + 0.2 * RL * e }];
        body.say = t < 0.5 ? 'Right.' : 'HNNNNG!';
        body.mouth = t < 0.5 ? 0.15 : 1;
        body.lean = 0.1 * e;
        return { body: body, racket: { x: butt.x, y: butt.y, ang: 0, bend: 0.32 * e, t: t } };
      }
      if (a < 0.9) {
        body.hands = [{ x: PX - 0.42 * KP, y: 215 }, { x: PX + 0.42 * KP, y: 215 }];
        body.mouth = 1;
        body.say = 'HA!';
        body.jump = Math.abs(Math.sin(a * 6)) * 20;
      } else {
        // Hopping on one leg, holding the knee
        body.jump = Math.abs(Math.sin(a * 9)) * 18;
        body.lean = 0.2;
        body.crouch = 0.25;
        body.mouth = 0.5;
        body.brow = -0.8;
        body.steam = false;
        body.say = 'Ow. My knee.';
        body.knees = [{ x: PX - 0.12 * KP, y: FLOOR_Y - body.jump - 0.62 * KP }, null];
        body.feet = [{ x: PX - 0.2 * KP, y: FLOOR_Y - body.jump - 0.3 * KP }, null];
        body.hands = [{ x: PX - 0.14 * KP, y: FLOOR_Y - body.jump - 0.6 * KP }, { x: PX - 0.02 * KP, y: FLOOR_Y - body.jump - 0.58 * KP }];
      }
      return { body: body, racket: null };
    },
    // Launched: a hammer throw. Two spins, then away into row M.
    // Chewed: the frame lifted to the mouth and gnawed, head shaking, until it snaps; strings spat out
    chew(t) {
      const a = Math.max(0, t - SMASH_T);
      const lift = easeOut(seg(t, 0, 0.4));
      const gnaw = t > 0.4 && t < SMASH_T && !reduceMotion ? Math.sin(t * 38) : 0;
      const body = { x: PX, brow: 1, mouth: t > 0.35 && t < SMASH_T ? 0.9 : 0.4, steam: t < SMASH_T + 0.4, lean: 0.08 * gnaw, crouch: 0.12 * lift, say: t > 0.4 && t < SMASH_T ? 'GRRRRR' : null };
      const y = lerp(450, 262, lift) + gnaw * 4;
      const butt = { x: lerp(PX + 0.1 * KP, PX - 0.58 * KP, lift) + gnaw * 6, y: y };
      const ang = lerp(Math.PI / 2, 0, lift);
      if (t < SMASH_T) {
        body.hands = [{ x: butt.x + 0.08 * KP, y: y + 6 }, { x: PX + 0.25 * KP + gnaw * 6, y: y + 4 }];
        return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, t: t } };
      }
      // Snapped: the head drops, you spit out strings and look pleased with yourself
      const drop = Math.min(1, a * 2.2);
      body.smug = a > 0.6;
      body.brow = a > 0.6 ? -0.3 : 1;
      body.mouth = a > 0.6 ? 0.1 : 0.7;
      body.hands = [{ x: PX - 0.5 * KP, y: 268 + drop * 120 }, { x: PX + 0.42 * KP, y: 455 }];
      return {
        body: body,
        racket: { x: PX - 0.58 * KP, y: 262 + drop * 120, ang: drop * 1.2, crack: true, bend: 0.9, t: t },
        over(ctx) {
          if (reduceMotion || a > 1.2) return;
          ctx.strokeStyle = '#f4f1e6';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          for (let i = 0; i < 5; i++) {
            const k = Math.min(1, a * 1.6 + i * 0.05);
            const x = PX + 0.12 * KP + k * (60 + i * 26);
            const y2 = 258 - Math.sin(k * Math.PI) * (40 + i * 10) + k * k * 120;
            ctx.beginPath();
            ctx.moveTo(x, y2);
            ctx.lineTo(x + 14, y2 + 6);
            ctx.stroke();
          }
        }
      };
    },
    // Bounced: hurled down so hard it bounces straight back up, then lands on your head
    bounce(t) {
      const a = Math.max(0, t - SMASH_T);
      const body = { x: PX, brow: 1, mouth: 1, steam: true, say: t > 0.15 && t < SMASH_T ? 'AAARGH!' : null };
      if (t < SMASH_T) {
        const u = easeOut(seg(t, 0, 0.5));
        const e = easeIn(seg(t, 0.5, SMASH_T));
        const butt = t < 0.5 ? { x: PX + 0.1 * KP, y: lerp(430, 205, u) } : { x: lerp(PX + 0.1 * KP, PX + 0.55 * KP, e), y: lerp(205, FLOOR_Y - RL * 0.99, e) };
        const ang = t < 0.5 ? lerp(Math.PI / 2, -Math.PI / 2 - 0.6, u) : lerp(-Math.PI / 2 - 0.6, Math.PI / 2, e);
        body.lean = t < 0.5 ? -0.15 : lerp(-0.15, 0.4, e);
        body.hands = grip(butt, ang);
        return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, t: t } };
      }
      // Up it goes, spinning, and down onto your head at a + 0.5
      const fly = Math.min(1, a / 0.5);
      const land = a >= 0.5;
      const rx = lerp(PX + 0.55 * KP, PX - 0.3 * KP, fly);
      const ry = land ? 198 + Math.min(1, (a - 0.5) * 3) * 4 : lerp(FLOOR_Y - RL, 198, fly) - Math.sin(fly * Math.PI) * 200;
      body.lean = land ? 0.05 * Math.sin(a * 20) * Math.max(0, 1 - (a - 0.5) * 2) : 0.1;
      body.mouth = land ? 0.5 : 0.8;
      body.brow = land ? -1 : 1;
      body.steam = !land;
      body.hands = land ? [{ x: PX - 0.2 * KP, y: 240 }, { x: PX + 0.22 * KP, y: 236 }] : [{ x: PX - 0.4 * KP, y: 300 }, { x: PX + 0.4 * KP, y: 300 }];
      if (land && a > 0.9) body.say = 'Ow.';
      return {
        body: body,
        racket: land ? { x: PX - 0.3 * KP, y: 198, ang: -0.1, crack: true, bend: 0.6, t: t } : { x: rx, y: ry, ang: Math.PI / 2 - fly * 9, crack: true, t: t },
        over(ctx) {
          if (!land || reduceMotion || a > 1.6) return;
          // Cartoon stars round the head
          ctx.fillStyle = '#ffd400';
          for (let i = 0; i < 4; i++) {
            const an = a * 6 + i * Math.PI / 2;
            const x = PX + Math.cos(an) * 70;
            const y = 205 + Math.sin(an) * 18;
            ctx.beginPath();
            for (let j = 0; j < 10; j++) {
              const r2 = j % 2 ? 5 : 12;
              const aa = j / 10 * Math.PI * 2 - Math.PI / 2;
              ctx.lineTo(x + Math.cos(aa) * r2, y + Math.sin(aa) * r2);
            }
            ctx.closePath();
            ctx.fill();
          }
        }
      };
    },
    // Fore!: a golfer's address, a big backswing, and the racket driven into the court
    fore(t) {
      const a = Math.max(0, t - SMASH_T);
      const body = { x: PX, crouch: 0.3, lean: 0.25, mouth: 0.2, brow: 0.6, steam: t < SMASH_T, say: t > 0.05 && t < 0.4 ? 'Quiet, please.' : null };
      let butt;
      let ang;
      if (t < 0.4) {
        // Address: hands together low, the head on the court in front
        butt = { x: PX + 0.05 * KP, y: 470 };
        ang = Math.PI / 2 - 0.35;
      } else if (t < SMASH_T) {
        const back = easeOut(seg(t, 0.4, 0.68));
        const down = easeIn(seg(t, 0.68, SMASH_T));
        const top = { x: PX - 0.35 * KP, y: 240 };
        butt = t < 0.68 ? { x: lerp(PX + 0.05 * KP, top.x, back), y: lerp(470, top.y, back) } : { x: lerp(top.x, PX + 0.15 * KP, down), y: lerp(top.y, 470, down) };
        ang = t < 0.68 ? lerp(Math.PI / 2 - 0.35, -Math.PI - 0.4, back) : lerp(-Math.PI - 0.4, Math.PI / 2 - 0.2, down);
        body.lean = t < 0.68 ? lerp(0.25, -0.15, back) : lerp(-0.15, 0.3, down);
        body.mouth = t < 0.68 ? 0.2 : 1;
      } else {
        // Follow through: hand shading the eyes, watching a ball that is not there
        butt = { x: PX + 0.15 * KP, y: 470 };
        ang = Math.PI / 2 - 0.2;
        body.lean = -0.05;
        body.crouch = 0.05;
        body.mouth = a > 0.5 ? 0.9 : 0.4;
        if (a > 0.5) body.say = 'FORE!';
      }
      body.hands = a > 0.25 ? [{ x: PX + 0.05 * KP, y: 262 }, { x: PX + 0.4 * KP, y: 455 }] : grip(butt, ang);
      return {
        body: body,
        racket: { x: butt.x, y: butt.y, ang: ang, crack: a > 0, bend: Math.min(1, a * 8) * 0.8, t: t },
        under(ctx) {
          if (a <= 0) return;
          // The divot
          ctx.fillStyle = 'rgba(70,45,20,0.6)';
          ctx.beginPath();
          ctx.ellipse(PX + 0.45 * KP, FLOOR_Y + 2, 40, 9, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      };
    },
    // Drum Solo: two beats on the baseline, then the crash that ends it
    drums(t) {
      const BEATS = [[0.12, 0.35], [0.38, 0.62], [0.65, SMASH_T]];
      const a = Math.max(0, t - SMASH_T);
      const body = { x: PX, crouch: 0.3, lean: 0.1, mouth: 1, brow: 1, steam: true, say: t > 0.1 && a < 0.4 ? 'BA-DUM-' + (t > 0.62 ? 'TSSS!' : 'DUM') : null };
      const top = { x: PX + 0.1 * KP, y: 230 };
      const floor = { x: PX + 0.62 * KP, y: FLOOR_Y - RL * 0.99 };
      let butt = top;
      let ang = -Math.PI / 2 - 0.7;
      if (t < SMASH_T) {
        const b = BEATS.find((q) => t < q[1]) || BEATS[2];
        const k = seg(t, b[0], b[1]);
        // Up for the first 40% of each beat, then down onto the court
        const down = k < 0.4 ? 0 : easeIn((k - 0.4) / 0.6);
        const raise = k < 0.4 ? easeOut(k / 0.4) : 1;
        const startB = t < 0.12 ? { x: PX + 0.08 * KP, y: 430 } : floor;
        butt = k < 0.4 ? { x: lerp(startB.x, top.x, raise), y: lerp(startB.y, top.y, raise) } : { x: lerp(top.x, floor.x, down), y: lerp(top.y, floor.y, down) };
        ang = k < 0.4 ? lerp(Math.PI / 2, -Math.PI / 2 - 0.7, raise) : lerp(-Math.PI / 2 - 0.7, Math.PI / 2, down);
        body.lean = k < 0.4 ? -0.1 : lerp(-0.1, 0.45, down);
        body.jump = Math.sin(k * Math.PI) * 26;
      } else {
        butt = floor;
        ang = Math.PI / 2;
        const r = seg(a, 0.3, 0.7);
        body.lean = lerp(0.45, -0.05, r);
        body.crouch = lerp(0.3, 0, r);
        body.mouth = a < 0.3 ? 1 : 0.2;
        if (a > 0.7) { body.smug = true; body.brow = -0.3; body.steam = false; body.say = 'Thank you, goodnight.'; }
      }
      body.hands = a < 0.3 ? grip(butt, ang) : [{ x: PX - 0.5 * KP, y: 250 }, { x: PX + 0.5 * KP, y: 250 }];
      return { body: body, racket: { x: butt.x, y: butt.y, ang: ang, crack: a > 0, bend: Math.min(1, a * 9) * 0.85, t: t } };
    },
    // Signed and Thrown: a signature, a kiss, and an underarm lob into the crowd
    gift(t) {
      const a = Math.max(0, t - SMASH_T);
      const body = { x: PX, mouth: t < 0.5 ? 0.2 : 0.6, brow: t < SMASH_T ? -0.2 : 0.4, smug: t < 0.5, steam: t > 0.5 && t < SMASH_T, say: t > 0.05 && t < 0.5 ? 'For you.' : null };
      if (t < 0.5) {
        // Racket held up in front, face out; the other hand signs it with a flourish
        const butt = { x: PX - 0.42 * KP, y: 430 };
        const ang = -Math.PI / 2 - 0.35;
        const head = { x: butt.x + Math.cos(ang) * RL * 0.72, y: butt.y + Math.sin(ang) * RL * 0.72 };
        const pen = { x: head.x + Math.sin(t * 30) * 22, y: head.y + Math.cos(t * 23) * 14 + 10 };
        body.hands = [butt, pen];
        return {
          body: body,
          racket: { x: butt.x, y: butt.y, ang: ang, t: t },
          over(ctx) {
            ctx.strokeStyle = '#1a1a1a';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(pen.x, pen.y);
            ctx.lineTo(pen.x + 16, pen.y + 22);
            ctx.stroke();
          }
        };
      }
      if (t < SMASH_T) {
        // Back, then an underarm swing that lets go at the top
        const e = easeIn(seg(t, 0.5, SMASH_T));
        const hand = { x: lerp(PX + 0.1 * KP, PX + 0.55 * KP, e), y: lerp(520, 300, e) };
        body.lean = lerp(-0.15, 0.1, e);
        body.crouch = lerp(0.35, 0.05, e);
        body.hands = [{ x: PX - 0.4 * KP, y: 430 }, hand];
        return { body: body, racket: { x: hand.x, y: hand.y, ang: lerp(Math.PI / 2 + 0.6, -Math.PI / 2, e), t: t } };
      }
      // Up and away into the stand, turning over and over; you bow to the crowd
      const x = PX + 0.55 * KP - 520 * a;
      const y = 300 - 900 * a + 520 * a * a;
      const racket = x > -300 && y < H + 200 ? { x: x, y: y, ang: -Math.PI / 2 - 9 * a, scale: Math.max(0.15, 1 - a * 0.55), t: t } : null;
      const bow = seg(a, 0.6, 1.0) * (1 - seg(a, 1.6, 1.9));
      body.lean = 0.45 * bow;
      body.crouch = 0.15 * bow;
      body.hands = a < 0.5 ? [{ x: PX - 0.3 * KP, y: 440 }, { x: PX + 0.5 * KP, y: 240 }] : [{ x: PX - 0.05 * KP, y: 360 }, { x: PX + 0.35 * KP, y: 450 }];
      if (a > 1.0) body.say = 'You are welcome.';
      return { body: body, racket: racket };
    },
    heli(t) {
      const sh = { x: PX, y: 335 };
      if (t < SMASH_T) {
        const phi = easeIn(t / SMASH_T) * Math.PI * 4.5;
        const c = Math.cos(phi);
        const hand = { x: sh.x + c * 0.62 * KP, y: sh.y + 15 + Math.sin(phi) * 0.1 * KP };
        const body = { x: PX, squash: c, crouch: 0.2 + 0.1 * Math.sin(phi * 2), mouth: 1, brow: 1, steam: true, say: t > 0.2 ? 'AAAAAARGH!' : null, hands: [hand, hand] };
        return { body: body, racket: { x: hand.x, y: hand.y, ang: c >= 0 ? 0.15 : Math.PI - 0.15, scale: Math.max(0.35, Math.abs(c)), t: t } };
      }
      const a = t - SMASH_T;
      const rel = { x: sh.x + 0.62 * KP, y: sh.y + 15 };
      const x = rel.x + 820 * a;
      const y = rel.y - 760 * a + 330 * a * a;
      const racket = x < W + 200 && y > -200 ? { x: x, y: y, ang: 0.15 + 24 * a, scale: Math.max(0.12, 1 - a * 0.62), t: t } : null;
      const body = { x: PX, mouth: a < 0.5 ? 1 : 0.3, brow: a > 0.7 ? -0.8 : 1, steam: a < 0.7 };
      // Follow through, then a hand shading the eyes to watch where it went
      body.hands = a < 0.5 ? [{ x: PX + 0.55 * KP, y: 240 }, { x: PX + 0.68 * KP, y: 252 }] : [{ x: PX + 0.02 * KP, y: 262 }, { x: PX + 0.3 * KP, y: 445 }];
      if (a > 0.85) body.say = 'Sorry! SORRY!';
      return { body: body, racket: racket };
    },
    // Shattered: a run up, a full forehand into the net post, then a lot of hopping
    post(t) {
      // A courtside advertising hoarding, the nearest hard object
      const under = (ctx) => {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(POST_X + 8, FLOOR_Y - 6, 70, 10);
        ctx.fillStyle = '#123321';
        ctx.fillRect(POST_X, 330, 66, FLOOR_Y - 330);
        ctx.fillStyle = '#0a1f14';
        ctx.fillRect(POST_X, 330, 66, 10);
        ctx.save();
        ctx.translate(POST_X + 33, (340 + FLOOR_Y) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#d9f24a';
        ctx.font = '34px "Lilita One", Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SNARL ENERGY', 0, 0);
        ctx.restore();
      };
      const u = seg(t, 0, 0.5);
      const e = easeIn(seg(t, 0.5, SMASH_T));
      const a = Math.max(0, t - SMASH_T);
      const bx = t < 0.5 ? lerp(PX - 330, PX, easeOut(u)) : PX;
      const body = { x: bx, mouth: 1, brow: 1, steam: true, say: t > 0.1 && t < SMASH_T ? 'COME HERE!' : null, lean: 0.15 };
      let racket = null;
      if (t < 0.5) {
        const ph = t * 28;
        body.feet = [
          { x: bx - 0.16 * KP + Math.sin(ph) * 0.18 * KP, y: FLOOR_Y - Math.max(0, Math.sin(ph)) * 22 },
          { x: bx + 0.16 * KP - Math.sin(ph) * 0.18 * KP, y: FLOOR_Y - Math.max(0, -Math.sin(ph)) * 22 }
        ];
      }
      if (t < SMASH_T) {
        // A forehand: taken back behind you on the run, then round and into the hoarding
        const ang = t < 0.5 ? -2.5 : lerp(-2.5, 0, e);
        const butt = { x: t < 0.5 ? bx - 0.22 * KP : lerp(PX - 0.22 * KP, POST_X - RL - 4, e), y: t < 0.5 ? 380 : lerp(380, 400, e) };
        racket = { x: butt.x, y: butt.y, ang: ang, t: t };
        body.hands = grip(butt, ang);
        if (t >= 0.5) body.lean = lerp(-0.2, 0.3, e);
        return { body: body, racket: racket, racketBehind: ang < -1.4, under: under };
      } else {
        body.jump = a < 1.8 ? Math.abs(Math.sin(a * 11)) * 26 : 0;
        const shake = reduceMotion ? 0 : Math.sin(a * 50) * 10;
        body.hands = [{ x: PX + 0.05 * KP, y: 330 }, { x: PX + 0.18 * KP + shake, y: 300 + shake * 0.5 }];
        body.say = 'OW. OW. OW.';
        body.brow = -0.8;
        body.lean = 0;
      }
      return { body: body, racket: racket, under: under };
    }
  };

  // Fired once at the moment of impact: sounds, shake and flying pieces that suit the routine
  function smashImpact() {
    const id = MD.style.id;
    let ix = PX + 0.62 * KP;
    let iy = FLOOR_Y;
    const at = (delay, name, opts) => MD.cues.push({ t: SMASH_T + delay, name: name, opts: opts || {} });
    if (id === 'spike') { sfx('frame'); sfx('crunch'); }
    else if (id === 'bin') { ix = -1; sfx('clang'); sfx('crunch'); at(0.18, 'clang'); at(0.5, 'applause', { power: 0.6 }); }
    else if (id === 'hoof') { ix = -1; sfx('frame'); sfx('whoosh', { power: 1.4 }); at(0.4, 'gasp'); at(0.9, 'applause', { power: 0.9 }); }
    else if (id === 'taco') { sfx('frame'); sfx('creak'); }
    else if (id === 'chew') { sfx('snap'); sfx('crunch'); ix = PX - 0.05 * KP; iy = 262; }
    else if (id === 'bounce') { sfx('frame'); sfx('crunch'); at(1.4, 'clang'); at(1.5, 'gasp'); at(1.9, 'applause', { power: 0.6 }); }
    else if (id === 'fore') { sfx('frame'); sfx('crunch'); at(0.5, 'applause', { power: 0.5 }); }
    else if (id === 'drums') { sfx('frame'); sfx('crunch'); at(0.3, 'applause', { power: 0.7 }); }
    else if (id === 'gift') { ix = -1; sfx('whoosh', { power: 1.1 }); at(0.6, 'applause', { power: 1.2 }); }
    else if (id === 'strings') {
      ix = PX - 0.05 * KP + RL * 0.71;
      sfx('frame');
      // Three stomps, each one bursting more strings
      [0, 0.42, 0.84].forEach((d, n) => {
        if (n) at(d, 'crunch');
        for (let i = 0; i < 3; i++) at(d + 0.04 + i * 0.07, 'ping', { pitch: 1300 + (n * 3 + i) * 220 });
      });
    } else if (id === 'knee') {
      const bx = PX - 0.1 * KP - RL * 0.5;
      ix = bx + RL * 0.4;
      iy = 447;
      sfx('snap');
      MD.parts.push(rigid(bx, 447, -170, -380, 0, -6, { floor: FLOOR_Y, piece: 'handle' }));
      MD.parts.push(rigid(bx + RL * 0.36, 447, 210, -460, 0, 7, { floor: FLOOR_Y - 10, piece: 'head' }));
    } else if (id === 'heli') {
      ix = -1;
      at(1.25, 'crunch', { far: true });
      at(1.3, 'gasp');
      at(1.6, 'applause', { power: 0.5 });
    } else if (id === 'royal') {
      ix = -1;
      at(1.3, 'crunch', { far: true });
      at(1.32, 'ping', { pitch: 2600 });
      at(1.36, 'ping', { pitch: 3100 });
      at(1.4, 'ping', { pitch: 2300 });
      at(1.35, 'gasp');
      at(1.75, 'boo');
    } else if (id === 'post') {
      ix = POST_X;
      iy = 400;
      sfx('clang');
      sfx('crunch');
      MD.parts.push(rigid(POST_X - RL - 4, 400, -120, -60, 0, -3, { floor: FLOOR_Y, piece: 'handle' }));
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i / 8 - 0.5) * Math.PI * 1.2;
        const v = 280 + Math.random() * 420;
        MD.parts.push(rigid(POST_X - 15, 400 + (Math.random() - 0.5) * 50, Math.cos(a) * v, Math.sin(a) * v - 200, Math.random() * 6, (Math.random() - 0.5) * 16, { floor: FLOOR_Y, piece: 'rim', r: 14 + Math.random() * 10 }));
      }
    }
    MD.cues.sort((a, b) => a.t - b.t);
    if (id !== 'royal') {
      MD.freeze = 0.14;
      if (!reduceMotion) M.cam.z += 0.18;
    }
    sfx('gasp');
    if (SAVE.reputationScore < -25) sfx('boo');
    M.hype = 1;
    vibrate([120, 60, 200]);
    if (ix >= 0) {
      M.shake = 1;
      for (let i = 0; i < 22; i++) {
        const a = -Math.PI * Math.random();
        const v = 180 + Math.random() * 420;
        MD.shards.push({ x: ix, y: iy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 1100, t: 0, life: 1.4, r: 3 + Math.random() * 7, spin: (Math.random() - 0.5) * 20, color: Math.random() < 0.6 ? '#d9f24a' : '#222' });
      }
    }
    // Leave the wreckage on the court for the rest of the match. The launched one is in the crowd.
    if (id !== 'heli' && id !== 'royal' && id !== 'bin' && id !== 'hoof' && id !== 'gift') {
      M.debris.push({ x: clamp(M.player.x + (ix - PX) / KP, -8, 8), y: M.player.y - 0.15, ang: (id === 'knee' ? 0.3 : 0.1) + Math.random() * 0.4, style: id === 'drums' || id === 'fore' || id === 'bounce' || id === 'chew' ? 'spike' : id, color: playerKit().racket, smash: M.smashed });
      if (M.debris.length > 6) M.debris.shift();
    }
  }

  function renderSmash(ctx, t) {
    renderRoutine(ctx, t, MD.style.id, playerKit(), MD.replaying ? [] : MD.parts, MD.replaying ? [] : MD.shards);
  }
  function routinePose(styleId, t) {
    return (TANTRUM[styleId] || CELEB[styleId])(t);
  }
  // The box around a cartoon figure and the racket in its hand, in figure pixels
  function puppetBox(body, rk) {
    const jump = body.jump || 0;
    let x0 = body.x - 1.3 * KP;
    let x1 = body.x + 1.3 * KP;
    let y0 = FLOOR_Y - 3.1 * KP - jump;
    const y1 = FLOOR_Y + 30;
    if (rk) {
      x0 = Math.min(x0, rk.x - RL * 1.1);
      x1 = Math.max(x1, rk.x + RL * 1.1);
      y0 = Math.min(y0, rk.y - RL * 1.1);
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function puppetShadow(ctx, p) {
    if (p.noShadow) return;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(p.x, FLOOR_Y + 3, 0.45 * KP * (1 - Math.min(0.5, (p.jump || 0) / 220)), 0.08 * KP, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  function renderRoutine(ctx, t, styleId, kit, parts, shards) {
    const pose = routinePose(styleId, t);
    const col = kit.racket;
    if (pose.under) pose.under(ctx);
    const rk = pose.racket ? Object.assign({ len: RL, color: col }, pose.racket) : null;
    // A spin turns the whole body and the racket about a point (backflips)
    if (pose.spin) {
      ctx.save();
      ctx.translate(pose.spin.x, pose.spin.y);
      ctx.rotate(pose.spin.ang);
      ctx.translate(-pose.spin.x, -pose.spin.y);
    }
    // The figure and the racket in hand, outlined together; flying pieces and props are not
    const far = rk && Math.hypot(rk.x - pose.body.x, rk.y - 400) > 2.2 * KP;
    if (!pose.spin) puppetShadow(ctx, pose.body);
    withOutline(ctx, puppetBox(pose.body, far ? null : rk), (c) => {
      if (rk && !far && pose.racketBehind) drawRacketShape(c, rk);
      const drawArms = drawPuppet(c, pose.body, t, kit);
      if (rk && !far && !pose.racketBehind) drawRacketShape(c, rk);
      drawArms();
    });
    if (far) drawRacketShape(ctx, rk);
    if (pose.spin) ctx.restore();
    parts.forEach((b) => {
      if (b.piece === 'handle') drawRacketShape(ctx, { x: b.x, y: b.y, ang: b.ang, len: RL, noHead: true, color: col });
      else if (b.piece === 'head') {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.ang);
        drawRacketShape(ctx, { x: -RL * 0.36, y: 0, ang: 0, len: RL, noHandle: true, crack: true, color: col });
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.ang);
        ctx.strokeStyle = col;
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, b.r, b.r, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-b.r * 0.2, 3);
        ctx.lineTo(-b.r * 0.1, b.r * 0.6);
        ctx.moveTo(b.r * 0.15, 3);
        ctx.lineTo(b.r * 0.3, b.r * 0.5);
        ctx.stroke();
        ctx.restore();
      }
    });
    if (pose.over) pose.over(ctx);
    shards.forEach((s) => {
      if (s.t > s.life) return;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.t * s.spin);
      ctx.globalAlpha = 1 - s.t / s.life;
      ctx.fillStyle = s.color;
      ctx.fillRect(-s.r, -s.r * 0.3, s.r * 2, s.r * 0.6);
      ctx.restore();
    });
  }

  // Wreckage lying on the court, squashed flat into the perspective
  function drawDebris(ctx) {
    M.debris.forEach((d) => {
      // The action replay shows this racket still whole, so its wreckage waits until the replay ends
      if (MD.replaying && d.smash === M.smashed) return;
      const p = proj(d.x, d.y, 0);
      const len = 0.68 * p.s;
      const o = { x: p.x, y: p.y, ang: d.ang, len: len, flat: 0.45, crack: true, color: d.color };
      if (d.style === 'spike') o.bend = 0.85;
      else if (d.style === 'taco') o.fold = 1;
      else if (d.style === 'strings') o.stringsGone = 1;
      if (d.style === 'knee' || d.style === 'post') {
        drawRacketShape(ctx, Object.assign({}, o, { noHead: true }));
        if (d.style === 'knee') drawRacketShape(ctx, Object.assign({}, o, { x: p.x + len * 0.5, y: p.y + len * 0.1, ang: d.ang + 1.4, noHandle: true }));
      } else drawRacketShape(ctx, o);
    });
  }

  FSM.states.MELTDOWN_MINIGAME = {
    screen: null,
    enter(p, scope) {
      // Boiling point: smash it or keep it in (the mini-game starts only if you keep it in)
      MD.phase = 'choice';
      MD.t = 0;
      MD.taps = 0;
      MD.thoughts = [];
      MD.pops = [];
      MD.strikes = 0;
      MD.flash = 0;
      MD.smashed = false;
      MD.shards = [];
      MD.parts = [];
      MD.cues = [];
      MD.impact = false;
      MD.style = null;
      MD.line = '';
      MD.violationDue = false;
      M.calls = [];
      M.challengeable = null;
      M.stats.meltdowns++;
      // Step back into shot: from a far corner the close up camera cannot pan far enough to frame you
      M.player.x = clamp(M.player.x, -3.2, 3.2);
      M.player.y = clamp(M.player.y, -1.6, 8);
      // Each meltdown in a match is harder to talk yourself out of. The lesson's one is gentle.
      MD.wave = meltWave(M.cfg.strict, M.stats.meltdowns - 1, !!M.tut);
      // Easy: slower thoughts, more room between them, one more strike. Hard: quicker, and some angry thoughts
      // arrive dressed as calm ones, turning red halfway up: swat them early and it counts against you
      const DM = M.tut ? DIFF.normal.melt : diff().melt;
      MD.wave = Object.assign({}, MD.wave, { speed: MD.wave.speed * DM.speed, gap: MD.wave.gap * DM.gap, strikes: MD.wave.strikes + DM.strikes, turn: DM.turn });
      // The order they come in: calm ones scattered among the angry, never first
      MD.queue = [];
      for (let i = 0; i < MD.wave.angry; i++) MD.queue.push(false);
      for (let i = 0; i < MD.wave.calm; i++) MD.queue.splice(1 + Math.floor(Math.random() * MD.queue.length), 0, true);
      MD.nextAt = 0.15;
      scope.loop('heartbeat');
      vibrate(80);
      // The choice card: what each option costs right now, so the decision is an informed one
      const mc = $('#meltChoice');
      const nextPen = PENALTY[Math.min(M.violations || 0, 3)];
      const last = M.rackets <= 1;
      $('#mcSmashNote').textContent = M.tut ? 'Rage resets. It costs a racket.' : 'Rage to ' + Math.round(VENT.smash * 100) + '%. ' + (last ? 'Your last racket! ' : '') + nextPen + ', ' + money(M.cfg.fine) + ' fine.';
      const sk = MD.wave.strikes;
      $('#mcHoldNote').textContent = 'Swat the thoughts: ' + sk + (sk === 1 ? ' strike' : ' strikes') + ' and out. Stay at ' + Math.round(VENT.held * 100) + '%.';
      $('#mcClock').style.transform = 'scaleX(1)';
      mc.classList.remove('hidden');
      MD.choose = (how) => {
        if (MD.phase !== 'choice') return;
        mc.classList.add('hidden');
        sfx('click');
        if (how === 'hold') { MD.phase = 'ready'; MD.t = 0; return; }
        MD.chose = how;
        this.smash(VENT.smash);
      };
      scope.on($('#btnMeltSmash'), 'click', () => MD.choose('smash'));
      scope.on($('#btnMeltHold'), 'click', () => MD.choose('hold'));
      const tap = (e) => {
        if (e) e.preventDefault();
        window.RRAudio && RRAudio.resume();
        // A repeat tantrum can be skipped once the umpire has spoken (the first one always plays in full)
        if (MD.phase === 'result' && MD.smashed && M.smashed > 1 && MD.style.id !== 'royal' && !MD.violationDue && MD.t > SMASH_T + 1 && MD.t < 3.8) { MD.t = 3.8; return; }
        if (MD.phase !== 'tapping') return;
        MD.taps++;
        swatThought(e && e.clientX !== undefined ? toLogical(e) : null);
      };
      scope.on(canvas, 'pointerdown', tap);
      scope.on(window, 'keydown', (e) => {
        if (e.repeat) return;
        if (MD.phase === 'choice' && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Numpad1' || e.code === 'Numpad2')) { MD.choose(/1$/.test(e.code) ? 'smash' : 'hold'); return; }
        if (e.code === 'Space' || e.code === 'Enter') tap(e);
      });
      scope.on($('#btnAdWatch'), 'click', () => this.watchAd(scope));
      scope.on($('#btnAdForfeit'), 'click', () => {
        sfx('click');
        $('#adModal').classList.add('hidden');
        M.matchWinner = 1;
        finishMatch('forfeit');
      });
      this.scope = scope;
    },
    update(dt) {
      // The impact freeze frame and the action replay both pause the routine clock
      let dtR = dt;
      if (MD.freeze > 0) { MD.freeze -= dt; dtR = 0; }
      if (MD.replaying) {
        dtR = 0;
        MD.rt += dt * 0.4;
        if (!MD.replayImpact && MD.rt >= SMASH_T) { MD.replayImpact = true; sfx('crunch'); sfx('ooh'); }
        if (MD.rt >= SMASH_T + 0.35) { MD.replaying = false; MD.replayDone = true; }
      } else if (MD.phase === 'result' && MD.smashed && MD.replayAt && !MD.replayDone && MD.t >= MD.replayAt) {
        MD.replaying = true;
        MD.rt = 0.45;
        MD.replayImpact = false;
        MD.replayLine = pick(COMMENTARY);
        sfx('whoosh', { power: 0.6 });
      }
      if (tantrumOnCourt() && !reduceMotion && Math.random() < dt * 4) sfx('shutter');
      MD.t += dtR;
      MD.shards.forEach((p) => { p.t += dtR; p.x += p.vx * dtR; p.y += p.vy * dtR; p.vy += p.g * dtR; });
      MD.parts.forEach((b) => stepRigid(b, dtR));
      if (MD.phase === 'result' && MD.smashed && MD.style.id === 'royal' && !MD.royalSaid && MD.t >= SMASH_T + 2.9) {
        MD.royalSaid = true;
        say('Code violation. Unsportsmanlike conduct. Default.');
        sfx('boo');
      }
      if (MD.phase === 'result' && MD.smashed) {
        if (!MD.impact && MD.t >= SMASH_T) { MD.impact = true; smashImpact(); MD.cues.sort((a, b) => a.t - b.t); }
        // The umpire speaks once the dust settles. Tied to the routine clock so it can never be skipped.
        if (MD.violationDue && MD.t >= SMASH_T + 0.8) { MD.violationDue = false; codeViolation('abuse'); }
        while (MD.cues.length && MD.t >= MD.cues[0].t) { const c = MD.cues.shift(); sfx(c.name, c.opts); }
      }
      M.shake = Math.max(0, M.shake - dt * 2);
      M.time += dt;
      M.hype = Math.max(0, M.hype - dt * 0.3);
      if (M.speech) { M.speech.t += dt; if (M.speech.t > M.speech.dur) M.speech = null; }
      // Broadcast close up: push in on you while you tap, closer still for the tantrum.
      // For Launched the camera pulls back to follow the racket into the stand.
      {
        const fp = proj(M.player.x, M.player.y, 0);
        const kk = fp.s * 0.88;
        const smashing = tantrumOnCourt();
        const following = smashing && MD.style.id === 'heli' && MD.t > SMASH_T + 0.15;
        let z = following ? 1.15 : reduceMotion ? 1.3 : smashing ? 2.0 : 1.6;
        const midY = fp.y - (smashing ? 1.15 : 1.0) * kk;
        let tx = -(fp.x - 640) * z;
        let ty = (smashing ? -20 : 30) - (midY - 360) * z;   // the tantrum sits a little above centre, clear of the rage bar
        if (following) { tx = -60; ty = (z - 1) * 360; }
        if (smashing && MD.style.id === 'royal' && MD.t > SMASH_T + 0.1) {
          const b = incidentTarget();
          const landed = MD.t > SMASH_T + 1.3;
          z = landed ? 2.3 : 1.35;
          const fx = landed ? b.x : (fp.x + b.x) / 2;
          const fy = landed ? b.y : (fp.y - 120 + b.y) / 2;
          tx = -(fx - 640) * z;
          ty = (landed ? 40 : 0) - (fy - 360) * z;
        }
        const e = Math.min(1, dt * 3);
        M.cam.z += (z - M.cam.z) * e;
        M.cam.x += (clamp(tx, -(M.cam.z - 1) * 640, (M.cam.z - 1) * 640) - M.cam.x) * e;
        M.cam.y += (clamp(ty, -(M.cam.z - 1) * 360, (M.cam.z - 1) * 360) - M.cam.y) * e;
        M.cam.x = clamp(M.cam.x, -(M.cam.z - 1) * 640, (M.cam.z - 1) * 640);
        M.cam.y = clamp(M.cam.y, -(M.cam.z - 1) * 360, (M.cam.z - 1) * 360);
      }
      if (MD.phase === 'choice') {
        // The clock runs down; nobody choosing means the temper chooses
        $('#mcClock').style.transform = 'scaleX(' + Math.max(0, 1 - MD.t / VENT.choose).toFixed(3) + ')';
        if (MD.t >= VENT.choose) MD.choose('smash');
      } else if (MD.phase === 'ready' && MD.t > (MD.wave && MD.wave.turn ? 2 : 1.2)) { MD.phase = 'tapping'; MD.t = 0; sfx('whoosh'); }
      else if (MD.phase === 'tapping') {
        // Thoughts rise from your head at the wave's speed; an angry one reaching boiling point is a strike
        if (MD.queue.length && MD.t >= MD.nextAt) {
          const calm = MD.queue.shift();
          const head = worldToScreen(M.player.x, M.player.y, 1.9);
          let x = clamp(head.x + (Math.random() - 0.5) * 460, 170, W - 170);
          const prev = MD.thoughts[MD.thoughts.length - 1];
          if (prev && Math.abs(prev.x - x) < 170) x = clamp(x + (x < 640 ? 220 : -220), 170, W - 170);
          const turn = !calm && Math.random() < (MD.wave.turn || 0);
          const text = calm || turn ? pick(CALM_THOUGHTS) : pick(ANGRY_THOUGHTS);
          g.font = 'bold 27px "Trebuchet MS", sans-serif';
          MD.thoughts.push({ x: x, y: 540 + Math.random() * 40, text: text, calm: calm || turn, turn: turn, w: Math.max(170, g.measureText(text).width + 44), t: 0, done: false, wob: Math.random() * 6 });
          MD.nextAt = MD.t + MD.wave.gap * (0.75 + Math.random() * 0.5);
        }
        MD.thoughts.forEach((th) => {
          if (th.done) return;
          th.t += dt;
          if (th.liar !== undefined) th.liar += dt;
          th.y -= MD.wave.speed * dt;
          th.x += Math.sin(th.t * 5 + th.wob) * 18 * dt;
          // A turncoat shows its true colours halfway up
          if (th.turn && th.calm && th.y < (560 + BOIL_Y) / 2) {
            th.calm = false;
            th.liar = 0;
            th.text = pick(ANGRY_THOUGHTS);
            g.font = 'bold 27px "Trebuchet MS", sans-serif';
            th.w = Math.max(170, g.measureText(th.text).width + 44);
            sfx('stingDown');
            vibrate(15);
          }
          if (th.y <= BOIL_Y) {
            th.done = true;
            if (!th.calm) {
              MD.strikes++;
              MD.flash = 1;
              sfx('chime', { good: false });
              vibrate([30, 30, 30]);
            }
          }
        });
        MD.pops.forEach((p) => { p.t += dt; });
        MD.pops = MD.pops.filter((p) => p.t < 0.4);
        MD.flash = Math.max(0, MD.flash - dt * 3);
      }
      const waveOver = MD.phase === 'tapping' && !MD.queue.length && MD.thoughts.every((th) => th.done);
      if (MD.phase === 'tapping' && (MD.strikes >= MD.wave.strikes || waveOver)) {
        MD.phase = 'result';
        MD.t = 0;
        if (MD.strikes < MD.wave.strikes) {
          MD.smashed = false;
          MD.line = pick(MELT.ok);
          // Held it in: no racket lost, but you play on hot
          M.rage = VENT.held;
          M.stats.survived++;
          SAVE.stats.meltdownsSurvived++;
          sfx('applause', { power: 0.6 });
          persist();
        } else {
          // Lost the battle: the racket gets it anyway, and less of the rage goes than if you had chosen to
          this.smash(VENT.lost);
        }
      } else if (MD.phase === 'result' && MD.t >= (MD.smashed ? (MD.style.id === 'royal' ? SMASH_T + 4.6 : 3.8) : 2.4)) {
        if (MD.violationDue) { MD.violationDue = false; codeViolation('abuse'); }
        if (MD.smashed && MD.style.id === 'royal') {
          // Instant default, ten times the fine, and a story for the grandchildren
          MD.phase = 'done';
          M.fines += M.cfg.fine * 10;
          M.violations = 4;
          M.matchWinner = 1;
          if (MD.incident === 'royal') unlock('royalBox');
          if (SAVE.incidentsSeen.indexOf(MD.incident) < 0) SAVE.incidentsSeen.push(MD.incident);
          checkCollections();
          finishMatch('royal');
          return;
        }
        MD.phase = 'done';
        if (M.finalOffer) { M.finalOffer = false; this.openFinal(); return; }
        if (MD.smashed && M.rackets === 0 && M.matchWinner === null) this.openImport();
        else {
          if (MD.smashed && !M.tut && M.tantrumShots.length) M.shareChip = { shot: M.tantrumShots[M.tantrumShots.length - 1], t: 0 };
          FSM.change('MATCH_PLAY', { resume: true });
        }
      }
    },
    // The racket gets it: the tantrum, then the rage left over (a chosen smash vents nearly all of it)
    smash(rageAfter) {
      MD.phase = 'result';
      MD.t = 0;
      MD.smashed = true;
      smashRacket();
      recordTantrumClip(MD.style.id === 'royal' ? 5.2 : 3.4, MD.style.title);
      M.rage = rageAfter;
      MD.violationDue = MD.style.id !== 'royal' && !M.tut;
      persist();
    },
    // A fourth violation: default, unless an advert talks the umpire into one final warning
    openFinal() {
      MD.phase = 'final';
      const scope = this.scope;
      const modal = $('#finalModal');
      const btn = $('#btnFinalAd');
      const msg = $('#finalMsg');
      msg.textContent = '';
      $('#finalLine').textContent = 'That is the fourth. The ' + officialTitle().toLowerCase() + ' is reaching for the word. One advert might buy you a final warning instead, once a match.';
      btn.disabled = false;
      btn.textContent = isPro() ? 'Final Warning (Pro)' : 'Final Warning: Watch an Advert';
      modal.classList.remove('hidden');
      const accept = () => {
        modal.classList.add('hidden');
        say('Default.');
        if (MD.smashed && !M.tut && M.tantrumShots.length) M.shareChip = { shot: M.tantrumShots[M.tantrumShots.length - 1], t: 0 };
        FSM.change('MATCH_PLAY', { resume: true });
      };
      scope.on($('#btnFinalNo'), 'click', () => { sfx('click'); accept(); });
      scope.on(btn, 'click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        sfx('click');
        rewardedAd(scope, msg, 'Advert playing. The ' + officialTitle().toLowerCase() + ' is reconsidering.').then((ok) => {
          if (FSM.name !== 'MELTDOWN_MINIGAME') return;
          if (!ok) { btn.disabled = false; btn.textContent = 'Try the Advert Again'; return; }
          // Back to the brink: three violations, the match goes on, and no second reprieve
          M.finalUsed = true;
          M.violations = 3;
          M.matchWinner = null;
          M.endReason = null;
          modal.classList.add('hidden');
          say('Final warning.');
          toast('Final warning. One more and you are out. No more favours.', 3200);
          sfx('coins');
          if (MD.smashed && M.rackets === 0) { this.openImport(); return; }
          FSM.change('MATCH_PLAY', { resume: true });
        });
      });
    },
    openImport() {
      MD.phase = 'import';
      const modal = $('#adModal');
      modal.classList.remove('hidden');
      const msg = $('#adMsg');
      const btn = $('#btnAdWatch');
      btn.classList.toggle('hidden', !adsLive());
      if (M.cfg.noSpare) {
        msg.textContent = 'Last Racket Standing: no courier today. That was the one.';
        btn.disabled = true;
      } else if (!adsLive()) {
        msg.textContent = 'No courier, no spare. That was your last racket.';
        btn.disabled = true;
      } else if (M.adUsed) {
        // 5. The courier comes once a match, not once a day
        msg.textContent = 'The courier has already been once this match and has gone home for his tea.';
        btn.disabled = true;
      } else {
        msg.textContent = isPro() ? 'Pro Pack: the courier skips the advert.' : '';
        btn.textContent = adWatchLabel();
        btn.disabled = false;
        window.RRAds && RRAds.prepareRewarded();
      }
    },
    watchAd(scope) {
      const btn = $('#btnAdWatch');
      const msg = $('#adMsg');
      if (btn.disabled) return;
      btn.disabled = true;
      sfx('click');
      msg.textContent = 'Fetching the courier...';
      let settled = false;
      // Game side guard: the game never waits more than 5 seconds for an advert to begin.
      let started = false;
      const guard = scope.timeout(() => {
        if (!started && !settled) {
          settled = true;
          msg.textContent = 'The courier is stuck on the M25. No advert is available right now.';
          btn.disabled = false;
          btn.textContent = 'Try the Courier Again';
        }
      }, 5000);
      const ads = window.RRAds;
      if (isPro()) { clearTimeout(guard); settled = true; started = true; Promise.resolve({ rewarded: true }).then(grant); return; }
      if (!ads) { clearTimeout(guard); settled = true; msg.textContent = 'Adverts are not available here.'; btn.disabled = false; return; }
      ads.showRewarded({ onStart: () => { started = true; msg.textContent = 'Advert playing. Sit still. Think about what you did.'; } })
        .then((res) => grant(res))
        .catch(() => {
          settled = true;
          msg.textContent = 'Something went wrong with the courier. Forfeit or try again.';
          btn.disabled = false;
        });
      function grant(res) {
          if (FSM.name !== 'MELTDOWN_MINIGAME') return;
          if (settled && !started && !isPro()) return;
          settled = true;
          clearTimeout(guard);
          if (res && res.rewarded) {
            M.rackets += 1;
            M.adUsed = true;
            M.rage = 0.35;
            $('#adModal').classList.add('hidden');
            btn.textContent = adWatchLabel();
            sfx('coins');
            toast('Spare racket delivered. Please do not introduce it to the floor.');
            FSM.change('MATCH_PLAY', { resume: true });
          } else {
            const why = res && res.reason;
            msg.textContent = why === 'closed early' ? 'You skipped the advert, so the courier kept the racket. Fair, frankly.'
              : why === 'offline' ? 'No signal. The courier cannot find you.'
                : 'The courier is stuck on the M25. No advert is available right now.';
            btn.disabled = false;
            btn.textContent = 'Try the Courier Again';
          }
      }
    },
    render(ctx) {
      // The match itself stays on screen: the camera is in close and the tantrum happens on court
      renderMatch(ctx);
      if (MD.replaying) {
        // Action replay: warm tint, scan lines, a REPLAY bug and the commentary box
        ctx.fillStyle = 'rgba(90,70,30,0.22)';
        ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        for (let y = -BY; y < H + BY; y += 6) ctx.fillRect(-BX, y, W + 2 * BX, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        roundRect(ctx, 1000, 70, 240, 40, 8);
        ctx.fill();
        if (Math.floor(M.time * 3) % 2 === 0) {
          ctx.fillStyle = '#ff3b30';
          ctx.beginPath();
          ctx.arc(1024, 90, 7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
        ctx.fillStyle = '#f4f1e6';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('ACTION REPLAY', 1042, 91);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(-BX, 580, W + 2 * BX, 40);
        ctx.font = 'italic bold 19px "Trebuchet MS", sans-serif';
        ctx.fillStyle = '#ffd977';
        ctx.textAlign = 'center';
        ctx.fillText('COMMENTARY: ' + MD.replayLine, 640, 600);
        return;
      }
      const tapping = MD.phase === 'choice' || MD.phase === 'ready' || MD.phase === 'tapping';
      const pulse = 0.5 + 0.5 * Math.sin(M.time * 14);
      const vg = ctx.createRadialGradient(640, 380, 220, 640, 380, 760);
      vg.addColorStop(0, 'rgba(255,0,0,0)');
      vg.addColorStop(1, 'rgba(255,30,20,' + ((tapping ? 0.35 : 0.16) + pulse * (tapping ? 0.25 : 0.06)).toFixed(2) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const jx = reduceMotion ? 0 : (Math.random() - 0.5) * 8;
      const jy = reduceMotion ? 0 : (Math.random() - 0.5) * 6;
      const band = (y, h) => {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(-BX, y, W + 2 * BX, h);
      };

      if (tapping) {
        // An arcade stamp: pops in, tilted, outlined, shaking
        const pop = MD.phase === 'ready' ? Math.max(0, 1 - MD.t * 6) : 0;
        ctx.save();
        ctx.translate(640 + jx, 140 + jy);
        ctx.rotate(-0.06);
        ctx.scale(1 + pop * 0.8, 1 + pop * 0.8);
        ctx.font = '104px "Lilita One", Impact, sans-serif';
        ctx.lineJoin = 'round';
        ctx.fillStyle = '#6d0f0a';
        ctx.fillText('MELTDOWN!', 7, 8);
        ctx.strokeStyle = '#140404';
        ctx.lineWidth = 16;
        ctx.strokeText('MELTDOWN!', 0, 0);
        const gr = ctx.createLinearGradient(0, -40, 0, 40);
        gr.addColorStop(0, '#fff36b');
        gr.addColorStop(0.55, '#ffb03a');
        gr.addColorStop(1, '#ff3b30');
        ctx.fillStyle = gr;
        ctx.fillText('MELTDOWN!', 0, 0);
        ctx.restore();
        if (MD.phase === 'ready') {
          // The only instruction, as a sticker, before the first thought arrives
          ctx.save();
          ctx.translate(640, 214);
          ctx.rotate(0.03);
          ctx.font = '28px "Lilita One", Impact, sans-serif';
          const tw = ctx.measureText('SWAT THE RED. SPARE THE GREEN.').width + 40;
          ctx.fillStyle = '#f4f1e6';
          ctx.strokeStyle = '#140404';
          ctx.lineWidth = 5;
          roundRect(ctx, -tw / 2, -24, tw, 48, 10);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#c8102e';
          ctx.fillText('SWAT THE RED.', -tw / 2 + 20 + ctx.measureText('SWAT THE RED.').width / 2, 2);
          ctx.fillStyle = '#2f7a3c';
          ctx.fillText('SPARE THE GREEN.', tw / 2 - 20 - ctx.measureText('SPARE THE GREEN.').width / 2, 2);
          ctx.restore();
          // Hard: fair warning
          if (MD.wave && MD.wave.turn && MD.t > 0.5) {
            ctx.save();
            ctx.translate(640, 278);
            ctx.rotate(-0.03);
            ctx.font = '24px "Lilita One", Impact, sans-serif';
            const lw = ctx.measureText('HARD MODE: SOME GREEN ONES ARE LYING.').width + 36;
            ctx.fillStyle = '#ffb03a';
            ctx.strokeStyle = '#140404';
            ctx.lineWidth = 5;
            roundRect(ctx, -lw / 2, -21, lw, 42, 9);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#140404';
            ctx.fillText('HARD MODE: SOME GREEN ONES ARE LYING.', 0, 2);
            ctx.restore();
          }
        }
        // Boiling point: an angry thought that reaches this line is a strike
        ctx.strokeStyle = 'rgba(255,59,48,' + (0.5 + 0.4 * MD.flash).toFixed(2) + ')';
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 8]);
        ctx.beginPath();
        ctx.moveTo(-BX, BOIL_Y);
        ctx.lineTo(W + BX, BOIL_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 16px "Trebuchet MS", sans-serif';
        ctx.fillStyle = '#ff8a80';
        ctx.textAlign = 'right';
        ctx.fillText('BOILING POINT', W - 24, BOIL_Y - 10);
        ctx.textAlign = 'center';
        if (MD.flash > 0) {
          ctx.fillStyle = 'rgba(255,40,30,' + (0.25 * MD.flash).toFixed(2) + ')';
          ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
        }
        // The thoughts: red bubbles to swat, green ones to leave
        (MD.thoughts || []).forEach((th) => {
          if (th.done) return;
          const near = clamp(1 - (th.y - BOIL_Y) / 160, 0, 1);
          const sh = th.calm || reduceMotion ? 0 : Math.sin(MD.t * 40 + th.wob) * 2 * near;
          ctx.fillStyle = th.calm ? '#dff5d8' : '#fff4f2';
          ctx.strokeStyle = th.calm ? '#3f9b4f' : near > 0.6 ? '#ff1f12' : '#ff3b30';
          ctx.lineWidth = 3;
          roundRect(ctx, th.x - th.w / 2 + sh, th.y - 32, th.w, 64, 18);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(th.x - 10 + sh, th.y + 31);
          ctx.lineTo(th.x + sh, th.y + 44);
          ctx.lineTo(th.x + 10 + sh, th.y + 31);
          ctx.fill();
          ctx.font = 'bold 27px "Trebuchet MS", sans-serif';
          ctx.fillStyle = th.calm ? '#2f7a3c' : '#c8102e';
          ctx.fillText(th.text, th.x + sh, th.y + 1);
          // A turncoat, caught in the act
          if (th.liar !== undefined && th.liar < 0.9) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, (0.9 - th.liar) * 4);
            ctx.translate(th.x + th.w / 2 - 6, th.y - 34);
            ctx.rotate(0.18);
            ctx.font = '22px "Lilita One", Impact, sans-serif';
            ctx.lineWidth = 5;
            ctx.strokeStyle = '#140404';
            ctx.strokeText('LIAR!', 0, 0);
            ctx.fillStyle = '#ffb03a';
            ctx.fillText('LIAR!', 0, 0);
            ctx.restore();
          }
        });
        // Swatted: a pop, green for good, red for the calm one you should have left
        (MD.pops || []).forEach((p) => {
          const k = p.t / 0.4;
          if (p.miss) {
            ctx.strokeStyle = 'rgba(244,241,230,' + (0.7 * (1 - k)).toFixed(2) + ')';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10 + 16 * k, 0, Math.PI * 2);
            ctx.stroke();
            return;
          }
          ctx.strokeStyle = p.calm ? 'rgba(255,59,48,' + (1 - k).toFixed(2) + ')' : 'rgba(217,242,74,' + (1 - k).toFixed(2) + ')';
          ctx.lineWidth = 3;
          for (let i = 0; i < 8; i++) {
            const a = i / 8 * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(p.x + Math.cos(a) * 20 * (1 + k), p.y + Math.sin(a) * 14 * (1 + k));
            ctx.lineTo(p.x + Math.cos(a) * 36 * (1 + k), p.y + Math.sin(a) * 25 * (1 + k));
            ctx.stroke();
          }
        });
        // Strikes, and how many thoughts are still to come (not while you are still choosing)
        if (MD.wave && MD.phase !== 'choice') {
          const n = MD.wave.strikes;
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          roundRect(ctx, 640 - 150, 600, 300, 44, 10);
          ctx.fill();
          ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
          ctx.fillStyle = '#f4f1e6';
          ctx.textAlign = 'left';
          ctx.fillText('STRIKES', 640 - 136, 622);
          for (let i = 0; i < n; i++) {
            ctx.fillStyle = i < MD.strikes ? '#ff3b30' : 'rgba(244,241,230,0.25)';
            ctx.beginPath();
            ctx.arc(640 - 60 + i * 26, 622, 9, 0, Math.PI * 2);
            ctx.fill();
          }
          const left = (MD.queue ? MD.queue.filter((c) => !c).length : 0) + MD.thoughts.filter((th) => !th.done && (!th.calm || th.turn)).length;
          ctx.textAlign = 'right';
          ctx.fillStyle = '#d9f24a';
          ctx.fillText(left + ' TO GO', 640 + 136, 622);
          ctx.textAlign = 'center';
        }
      } else {
        // A TV caption across the top once the deed is done
        if (!MD.smashed || MD.t > SMASH_T) {
          const title = MD.smashed ? MD.title : 'COMPOSED. JUST.';
          const lines = (ctx.font = 'bold 20px "Trebuchet MS", sans-serif', wrapText(ctx, MD.line, 900));
          // The Royal Box sits at the top of the stand, so its caption goes to the bottom of the screen
          const capY = MD.style && MD.style.id === 'royal' ? 388 : 36;
          band(capY, 74 + lines.length * 26);
          ctx.font = '54px "Lilita One", Impact, sans-serif';
          ctx.fillStyle = MD.smashed ? '#ff3b30' : '#5fd068';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 7;
          ctx.strokeText(title, 640, capY + 36);
          ctx.fillText(title, 640, capY + 36);
          ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
          ctx.fillStyle = '#f4f1e6';
          lines.forEach((l, i) => ctx.fillText(l, 640, capY + 80 + i * 26));
        }
        if (MD.smashed && MD.style.id === 'heli' && MD.t > SMASH_T + 1.15) {
          ctx.font = 'bold 22px "Trebuchet MS", sans-serif';
          ctx.fillStyle = '#ffefc2';
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 5;
          ctx.strokeText('Row M: "Mine now."', 1000, 210);
          ctx.fillText('Row M: "Mine now."', 1000, 210);
        }
        if (MD.smashed && MD.t > SMASH_T + 0.5) {
          band(560, 34);
          ctx.font = 'bold 18px "Trebuchet MS", sans-serif';
          ctx.fillStyle = '#ffb03a';
          const bottom = MD.style.id === 'royal'
            ? 'Odds of that: 1 in ' + MD.royalOdds + '. Fine: ' + money(M.cfg.fine * 10) + ', ' + INCIDENTS[MD.incident || 'royal'].extra + '.'
            : M.rackets === 0 ? 'That was your last racket.' : M.rackets + ' racket' + (M.rackets === 1 ? '' : 's') + ' left in the bag' + (M.tut || !M.cfg.fine ? '.' : '. Fine: ' + money(M.cfg.fine) + '.');
          ctx.fillText(bottom, 640, 577);
        }
      }
      // The umpire, as a broadcast subtitle (the chair is out of shot in the close up)
      if (M.speech && M.speech.who === 'ump') {
        ctx.font = 'bold 19px "Trebuchet MS", sans-serif';
        const text = officialTitle().toUpperCase() + ': ' + M.speech.text;
        const w = ctx.measureText(text).width + 30;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        roundRect(ctx, 640 - w / 2, 506, w, 34, 6);
        ctx.fill();
        ctx.fillStyle = '#ffd977';
        ctx.fillText(text, 640, 523);
      }
      // Grab the frame at the moment of impact (for the Royal Box, the moment it lands)
      if (MD.smashed && !MD.captured && !MD.replaying && MD.t >= (MD.style.id === 'royal' ? SMASH_T + 2.2 : SMASH_T + 0.35)) {
        MD.captured = true;
        captureTantrum(MD.title, MD.line, false);
      }
    },
    exit() {
      $('#adModal').classList.add('hidden');
      $('#btnAdWatch').disabled = false;
      $('#btnAdWatch').textContent = adWatchLabel();
      this.scope = null;
    }
  };

  /* ---------- Share your tantrum ---------- */
  // Records the canvas for a few seconds while a tantrum plays, where the device supports it. The clip is
  // attached to the still captured from the same tantrum. Sound is not included.
  function clipType() {
    if (!window.MediaRecorder || !canvas.captureStream) return null;
    return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || null;
  }
  // The clip is portrait (9:16), as the short video apps want it: a 3:4 window of the picture round you, with
  // the game's name above and the moment and where to get it below, copied in frame by frame while it records
  function portraitClip(caption, seconds) {
    const V = document.createElement('canvas');
    V.width = 720;
    V.height = 1280;
    const v = V.getContext('2d');
    const band = (y, h, fn) => { v.fillStyle = '#0b1f14'; v.fillRect(0, y, 720, h); fn(); };
    v.textAlign = 'center';
    v.textBaseline = 'middle';
    let live = true;
    const frame = () => {
      if (!live) return;
      // Below the TV caption across the top of the picture, which a portrait crop would cut off at both ends
      const sy = Math.round(canvas.height * 0.2);
      const ch = canvas.height - sy;
      const cw = Math.min(canvas.width, Math.round(ch * 0.75));
      v.drawImage(canvas, Math.round((canvas.width - cw) / 2), sy, cw, ch, 0, 160, 720, 960);
      band(0, 160, () => {
        v.font = '64px "Lilita One", Impact, sans-serif';
        v.fillStyle = '#f4f1e6';
        v.fillText('RACKET', 190, 84);
        v.fillStyle = '#ff3b30';
        v.fillText('RAGE', 380, 84);
        v.fillStyle = '#d9f24a';
        v.fillText('TENNIS', 565, 84);
      });
      band(1120, 160, () => {
        v.font = '54px "Lilita One", Impact, sans-serif';
        v.fillStyle = '#ffd23a';
        fitCanvasText(v, caption, 660, 54, '"Lilita One", Impact, sans-serif');
        v.fillText(caption, 360, 1172);
        v.font = 'bold 30px "Trebuchet MS", sans-serif';
        v.fillStyle = '#f4f1e6';
        v.fillText('Five rackets. One temper. No refunds.', 360, 1236);
      });
      requestAnimationFrame(frame);
    };
    frame();
    setTimeout(() => { live = false; }, seconds * 1000 + 300);
    return V;
  }
  function recordTantrumClip(seconds, caption) {
    const type = clipType();
    if (!type || M.tut) return;
    try {
      const src = portraitClip(caption || 'RACKET RAGE', seconds);
      const rec = new MediaRecorder(src.captureStream(30), { mimeType: type, videoBitsPerSecond: 3000000 });
      const chunks = [];
      const owner = { clip: null };
      MD.clipOwner = owner;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        owner.clip = new Blob(chunks, { type: type.split(';')[0] });
        if (owner.shot) { owner.shot.clip = owner.clip; }
        rec.stream.getTracks().forEach((tr) => tr.stop());
      };
      rec.start();
      setTimeout(() => { try { rec.stop(); } catch (e) { /* already stopped */ } }, seconds * 1000);
    } catch (e) { /* no clip, the still will do */ }
  }

  // Keeps a still of the best moment of a tantrum (yours or theirs) for the share card
  const TABLOID_VERB = { spike: 'SPIKES', taco: 'FOLDS', knee: 'SNAPS', heli: 'LAUNCHES', post: 'SHATTERS', bin: 'BINS', hoof: 'HOOFS', strings: 'SHREDS', chew: 'CHEWS', bounce: 'BOUNCES', fore: 'TEES OFF ON', drums: 'DRUMS ON', gift: 'GIFTS' };
  const TABLOID_ORD = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH'];
  const TABLOID_BLAME = ['WIND', 'STRINGS', 'BALL KID', 'SUN', 'NET', 'UMPIRE', 'NEW SOCKS', 'PIGEON', 'CROWD', 'GRASS'];
  function tabloidHeadline() {
    const verb = MD.style && TABLOID_VERB[MD.style.id];
    if (!verb) return null;
    const who = mySur() && Math.random() < 0.6 ? mySur().toUpperCase() : pick(['BRAT', 'HOTHEAD', 'TANTRUM STAR']);
    const ord = TABLOID_ORD[Math.max(0, Math.min(TABLOID_ORD.length - 1, (M.smashed || 1) - 1))];
    return who + ' ' + verb + ' ' + ord + ' RACKET, BLAMES ' + pick(TABLOID_BLAME);
  }
  function captureTantrum(title, line, theirs) {
    try {
      const c = document.createElement('canvas');
      c.width = 960;
      c.height = 540;
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
      const shot = { img: c, title: title, line: line, theirs: !!theirs, headline: !theirs && MD.style && title === MD.title ? tabloidHeadline() : null };
      M.tantrumShots.push(shot);
      // The clip of the same tantrum, when it finishes recording
      if (MD.clipOwner) { MD.clipOwner.shot = shot; if (MD.clipOwner.clip) shot.clip = MD.clipOwner.clip; MD.clipOwner = null; }
    } catch (e) { /* a missing still is not worth stopping the game for */ }
  }
  // An incident (the Royal Box and the rest) beats everything, then your own tantrums, then theirs
  function bestShot(list) {
    return list.find((x) => /INCIDENT/.test(x.title)) || list.find((x) => !x.theirs) || list[0] || null;
  }
  // A shared moment, as a square newspaper page in the same style as tomorrow's front page and the back page:
  // a red top for a tantrum, The Volley Times for the point of the match
  function buildShareCard(shot, text) {
    const c = document.createElement('canvas');
    c.width = 1080;
    c.height = 1080;
    const x = c.getContext('2d');
    const tabloid = !shot.highlight;
    x.fillStyle = '#f2ece0';
    x.fillRect(0, 0, 1080, 1080);
    // Masthead
    if (tabloid) { x.fillStyle = '#c8102e'; x.fillRect(0, 0, 1080, 150); }
    x.fillStyle = tabloid ? '#ffffff' : '#111111';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = (tabloid ? 'italic 900 ' : 'bold ') + '84px Georgia, "Times New Roman", serif';
    x.fillText(tabloid ? 'DAILY GRUMBLE' : 'THE VOLLEY TIMES', 540, 80);
    x.fillStyle = '#111';
    x.font = 'bold 26px Georgia, serif';
    x.textAlign = 'left';
    x.fillText(prettyDate(dateKey()).toUpperCase(), 40, 182);
    x.textAlign = 'right';
    x.fillText(tabloid ? 'SPORT  |  40p' : 'SPORT', 1040, 182);
    x.fillRect(40, 204, 1000, 4);
    // Headline: the tabloid's own words when there are some, over two lines if it needs them
    x.textAlign = 'left';
    const head = (tabloid && shot.headline) || shot.title;
    let size = 120;
    x.font = '900 ' + size + 'px Impact, "Arial Black", sans-serif';
    let lines = [head];
    while (size > 56) {
      x.font = '900 ' + size + 'px Impact, "Arial Black", sans-serif';
      lines = wrapText(x, head, 1000);
      if (lines.length <= 2 && lines.every((l) => x.measureText(l).width <= 1000)) break;
      size -= 6;
    }
    lines.slice(0, 2).forEach((l, i) => x.fillText(l, 40, 222 + size * 0.55 + i * size * 0.95));
    const py = 222 + size + (Math.min(2, lines.length) - 1) * size * 0.95 + 16;
    // The photo, framed, with a caption
    const ph = 1080 - py - 200;
    const pw = Math.round(ph * shot.img.width / shot.img.height);
    const pxx = Math.round((1080 - Math.min(pw, 1000)) / 2);
    x.drawImage(shot.img, pxx, py, Math.min(pw, 1000), ph);
    x.strokeStyle = '#111';
    x.lineWidth = 4;
    x.strokeRect(pxx, py, Math.min(pw, 1000), ph);
    x.font = 'italic 28px Georgia, serif';
    x.fillStyle = '#333';
    wrapText(x, shot.line || '', 1000).slice(0, 1).forEach((l) => x.fillText(l, 40, py + ph + 34));
    // Match facts strip
    x.fillStyle = '#111';
    x.fillRect(40, py + ph + 62, 1000, 3);
    x.font = 'bold 24px Georgia, serif';
    wrapText(x, text, 1000).slice(0, 2).forEach((l, i) => x.fillText(l, 40, py + ph + 96 + i * 32));
    x.font = 'bold 26px "Trebuchet MS", sans-serif';
    x.fillStyle = '#c8102e';
    x.textAlign = 'right';
    x.fillText('RACKET RAGE TENNIS', 1040, 1052);
    return c;
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  async function shareTantrum(shot, text) {
    if (shot.clip) {
      const ext = /mp4/.test(shot.clip.type) ? 'mp4' : 'webm';
      const name = 'racket-rage-tantrum.' + ext;
      const Cap = window.Capacitor;
      try {
        if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Filesystem && Cap.Plugins.Share) {
          const saved = await Cap.Plugins.Filesystem.writeFile({ path: name, data: await blobToBase64(shot.clip), directory: 'CACHE' });
          await Cap.Plugins.Share.share({ title: 'Racket Rage Tennis', text: text, files: [saved.uri], dialogTitle: 'Share your tantrum' });
          return;
        }
      } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return;
      }
      try {
        const file = new File([shot.clip], name, { type: shot.clip.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text: text });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
      // No way to share a video here: fall through to the still card
    }
    const card = buildShareCard(shot, text);
    const dataUrl = card.toDataURL('image/png');
    const Cap = window.Capacitor;
    // In the app: write the picture to the cache folder and hand it to the share sheet
    try {
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Filesystem && Cap.Plugins.Share) {
        const saved = await Cap.Plugins.Filesystem.writeFile({ path: 'racket-rage-tantrum.png', data: dataUrl.split(',')[1], directory: 'CACHE' });
        await Cap.Plugins.Share.share({ title: 'Racket Rage Tennis', text: text, files: [saved.uri], dialogTitle: 'Share your tantrum' });
        return;
      }
    } catch (e) {
      if (e && /cancel/i.test(String(e.message || e))) return;
    }
    // In a browser that can share files
    try {
      const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
      const file = blob && new File([blob], 'racket-rage-tantrum.png', { type: 'image/png' });
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: text });
        toast('Shared. The group chat will never look at you the same way.');
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    // Otherwise show it, so it can be saved by hand
    $('#cardImg').src = dataUrl;
    $('#cardSave').href = dataUrl;
    $('#cardSave').setAttribute('download', 'racket-rage-tantrum.png');
    cardFrame('tantrum');
    $('#cardModal').dataset.text = text;
    $('#cardModal').classList.remove('hidden');
  }

  /* ---------- Rewarded adverts for bonuses ---------- */
  // Resolves true only when the reward was earned. Never waits more than 5 seconds for an advert to start.
  function rewardedAd(scope, statusEl, playing) {
    return new Promise((resolve) => {
      if (isPro()) { statusEl.textContent = 'Pro Pack: no advert needed.'; resolve(true); return; }
      const ads = window.RRAds;
      if (!ads) { statusEl.textContent = 'Adverts are not available here.'; resolve(false); return; }
      let started = false;
      let settled = false;
      statusEl.textContent = 'Finding an advert...';
      const guard = scope.timeout(() => {
        if (!started && !settled) {
          settled = true;
          statusEl.textContent = 'No advert available right now. Try again in a moment.';
          resolve(false);
        }
      }, 5000);
      ads.showRewarded({ onStart: () => { started = true; statusEl.textContent = playing || 'Advert playing. The money is warming up.'; } })
        .then((res) => {
          if (settled && !started) return;
          settled = true;
          clearTimeout(guard);
          if (res && res.rewarded) { countAd(); statusEl.textContent = ''; resolve(true); return; }
          statusEl.textContent = res && res.reason === 'closed early' ? 'Advert skipped, so no bonus. Fair, frankly.'
            : res && res.reason === 'offline' ? 'No signal. The bonus cannot find you.'
              : 'No advert available right now. Try again in a moment.';
          resolve(false);
        })
        .catch(() => {
          settled = true;
          statusEl.textContent = 'Something went wrong with the advert.';
          resolve(false);
        });
    });
  }
  // The sponsor's bet: plug them (an advert) before a tour match, and if you win it they pay the prize money
  // BET.k times more on top. Lose and they pay nothing extra. One bet at a time, on your next tour match.
  const BET = { k: 2 };
  function betStake() {
    const tier = TIERS[SAVE.careerTier];
    return BET.k * Math.round(tier.prize * ROUND_PRIZE[SAVE.tournamentRound] * proK() * seasonPrizeK() * DIFF[diffKey()].prize);
  }
  // Wires a bet offer: a line saying what is at stake and a button; once placed, the line says so
  function offerBet(scope, row, btn, note, msg, onPlaced) {
    const sp = sponsorKit().sponsor.replace(/\.$/, '');
    const placed = () => {
      btn.classList.add('hidden');
      note.textContent = sp + ' have bet on you. Win your next match and they triple your prize money.';
    };
    row.classList.toggle('hidden', !adOk() && !SAVE.sponsorBet);
    msg.textContent = '';
    if (SAVE.sponsorBet) { placed(); return; }
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = isPro() ? 'Back Yourself (Pro)' : 'Watch Their Advert';
    note.textContent = 'Plug ' + sp + ' before your next match. Win it and they triple your prize money: ' + money(betStake()) + ' extra. Lose and you get nothing extra.';
    scope.on(btn, 'click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      sfx('click');
      rewardedAd(scope, msg).then((ok) => {
        if (!ok) { btn.disabled = false; btn.textContent = 'Try the Advert Again'; return; }
        SAVE.sponsorBet = true;
        persist();
        sfx('coins');
        placed();
        if (onPlaced) onPlaced();
      });
    });
  }
  // Wires a "double it" button: one advert, one doubling, then the button goes away
  // words (optional): { btn, retry, done(amount) } to tell the story of the advert in this place
  function adWatchLabel() { return isPro() ? 'Get a Racket (Pro)' : 'Watch an Advert for a Racket'; }
  function offerDoubler(scope, row, btn, msg, amount, label, onDone, words) {
    words = words || {};
    if (!adOk()) amount = 0;
    row.classList.toggle('hidden', !(amount > 0));
    btn.disabled = false;
    btn.textContent = isPro() ? (words.btn || 'Double It').replace(/: Watch (an|Their) Advert/, '') + ' (Pro)' : words.btn || 'Double It: Watch an Advert';
    msg.textContent = '';
    if (!(amount > 0)) return;
    scope.on(btn, 'click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      sfx('click');
      rewardedAd(scope, msg).then((ok) => {
        if (!ok) { btn.disabled = false; btn.textContent = words.retry || 'Try the Advert Again'; return; }
        SAVE.prizeMoney += amount;
        persist();
        sfx('coins');
        btn.classList.add('hidden');
        msg.textContent = words.done ? words.done(amount) : label + ' doubled. Another ' + money(amount) + ' in the bank.';
        toast(words.toast ? words.toast(amount) : 'Doubled. ' + money(amount) + ' added to your prize money.');
        if (onDone) onDone();
      });
    });
  }

  /* ---------- match results ---------- */
  function finishMatch(reason) {
    clearResume();
    const won = M.matchWinner === 0 && reason === 'normal';
    const res = {
      won: won,
      reason: reason,
      score: M.games[0] + '-' + M.games[1],
      smashed: M.smashed,
      fines: M.fines,
      peakRage: M.peakRage,
      stats: M.stats,
      cfg: M.cfg,
      rackets: M.rackets,
      violations: M.violations,
      celebs: M.stats.pumps,
      royalOdds: reason === 'royal' ? MD.royalOdds : 0,
      incident: reason === 'royal' ? MD.incident || 'royal' : null,
      tantrum: bestShot(M.tantrumShots),
      handshake: M.hs && M.hs.choice ? { choice: M.hs.choice, snub: M.hs.snub } : null,
      oppLost: M.oppLostCount || 0,
      games: [M.games[0], M.games[1]]
    };
    res.rageStrip = (M.gameRage || []).slice();
    M.result = res;
    // Head to head, for rivalries
    if (!M.tut) {
      const rv = SAVE.rivals || (SAVE.rivals = {});
      const rec = rv[M.cfg.opp.name] || (rv[M.cfg.opp.name] = { w: 0, l: 0, smashed: 0, lostIt: 0, last: null });
      res.revenge = won && rec.l >= 1 && rec.l >= rec.w;
      if (M.hs && M.hs.choice) rec.hs = M.hs.snub ? 'snubbed' : M.hs.choice;
      if (won) rec.w++; else rec.l++;
      rec.smashed += M.smashed;
      rec.lostIt += M.oppLostCount || 0;
      rec.last = won ? 'w' : 'l';
      // Losses in a row: after two, the game stops offering an advert to cover fines until you win again
      SAVE.lossRun = won ? 0 : (SAVE.lossRun || 0) + 1;
      SAVE.winRun = won ? (SAVE.winRun || 0) + 1 : 0;
      res.h2h = { w: rec.w, l: rec.l };
      if (!won) SAVE.lastLossTo = M.cfg.opp.name;
      else if (SAVE.lastLossTo === M.cfg.opp.name) SAVE.lastLossTo = null;
    }
    SAVE.totalFines += M.fines;
    if (M.redBonus) { SAVE.prizeMoney += M.redBonus; res.redBonus = M.redBonus; }
    if (won) SAVE.stats.matchesWon++; else SAVE.stats.matchesLost++;
    if (!M.tut && M.cfg.surface) {
      SAVE.surf = SAVE.surf || {};
      const sf = SAVE.surf[M.cfg.surface] || (SAVE.surf[M.cfg.surface] = { w: 0, l: 0 });
      if (won) sf.w++; else sf.l++;
    }
    res.checkAch = !M.tut;
    SAVE.stats.badCalls += M.stats.badCalls;
    SAVE.stats.fastestServe = Math.max(SAVE.stats.fastestServe, M.stats.fastest);

    if (M.cfg.mode === 'quick') {
      res.winnings = won ? Math.round(TIERS[M.cfg.tierIdx].prize * QUICK.prizeK * proK()) : 0;
      SAVE.prizeMoney += res.winnings;
      if (M.cfg.first && !SAVE.tutorialDone) { SAVE.tutorialDone = true; SAVE.askStyle = true; }
      payFines(res);
      persist();
      if (res.checkAch) res.newAch = checkAchievements(res);
      FSM.change('GAME_OVER', { kind: 'quick', result: res });
      return;
    }
    if (M.cfg.mode === 'daily') {
      const key = M.cfg.dateKey;
      const official = SAVE.lastPlayedDate !== key;
      if (official) {
        // A missed day is covered by a shield, if you have one
        const shielded = SAVE.lastPlayedDate === daysAgoKey(2) && (SAVE.streakShields || 0) > 0;
        if (shielded) SAVE.streakShields--;
        SAVE.dailyStreak = SAVE.lastPlayedDate === yesterdayKey() || shielded ? SAVE.dailyStreak + 1 : 1;
        res.shieldUsed = shielded;
        // Every 7 days in a row earns a shield (two at most)
        if (SAVE.dailyStreak % 7 === 0) { SAVE.streakShields = Math.min(2, (SAVE.streakShields || 0) + 1); res.shieldEarned = true; }
        if (res.shieldEarned) setTimeout(() => toast(SAVE.dailyStreak + ' days in a row: a streak shield. It covers one missed day.', 4200), 2500);
        else if (res.shieldUsed) setTimeout(() => toast('Your streak shield covered the day you missed. Streak: ' + SAVE.dailyStreak + '.', 4200), 2500);
        SAVE.lastPlayedDate = key;
        res.points = dailyPoints(won, M.games[0], M.stats, M.smashed, M.violations || 0);
        // Only the official (first) attempt of the day goes on the world table
        if (window.RRGames) RRGames.submitDaily(res.points);
        SAVE.lastDaily = { date: key, won: won, score: res.score, smashed: M.smashed, fines: M.fines, points: res.points };
        SAVE.dailyLog.push({ date: key, won: won, points: res.points });
        if (SAVE.dailyLog.length > 30) SAVE.dailyLog.shift();
        const table = clubhouseTable(key, res.points);
        res.rank = table.findIndex((x) => x.you) + 1;
        res.of = table.length;
        if (SAVE.dailyStreak >= 3) unlock('devotee');
      }
      res.official = official;
      // Official daily results pay; replays pay a token appearance fee
      res.winnings = Math.round((official ? (won ? 2000 + 250 * Math.min(SAVE.dailyStreak, 8) : 250) : (won ? 100 : 0)) * proK());
      SAVE.prizeMoney += res.winnings;
      payFines(res);
      persist();
      if (res.checkAch) res.newAch = checkAchievements(res);
      FSM.change('GAME_OVER', { kind: 'daily', result: res });
      return;
    }

    // Career
    SAVE.tournamentSmashed += M.smashed;
    SAVE.tournamentFines += M.fines;
    if (won) {
      SAVE.remainingRackets = M.rackets;
      const tier = TIERS[M.cfg.tierIdx];
      const prize = Math.round(tier.prize * ROUND_PRIZE[M.cfg.round] * proK() * seasonPrizeK() * diff().prize);
      const deal = sponsorPay(prize, M.smashed, M.violations || 0);
      const sponsor = deal.amount;
      SAVE.prizeMoney += prize + sponsor;
      // The sponsor's bet came in: they pay the prize money twice more
      if (M.cfg.bet) { res.betWin = BET.k * prize; SAVE.prizeMoney += res.betWin; }
      res.prize = prize;
      res.sponsor = sponsor;
      res.sponsorName = deal.name;
      res.sponsorWhy = deal.why;
      res.final = M.cfg.round === 2;
      if (res.final) {
        unlock('t' + M.cfg.tierIdx);
        SAVE.titles = SAVE.titles || {};
        SAVE.titles['t' + M.cfg.tierIdx] = (SAVE.titles['t' + M.cfg.tierIdx] || 0) + 1;
        if (SAVE.tournamentSmashed === 0) unlock('cleanBag');
        res.tournamentSmashed = SAVE.tournamentSmashed;
        res.tournamentFines = SAVE.tournamentFines;
        if (M.cfg.tierIdx === TIERS.length - 1) {
          SAVE.careerComplete = true;
        } else {
          SAVE.careerTier++;
        }
        SAVE.tournamentRound = 0;
        SAVE.remainingRackets = 5;
        SAVE.freeSpareUsed = false;
        SAVE.tournamentSmashed = 0;
        SAVE.tournamentFines = 0;
      } else {
        SAVE.tournamentRound++;
      }
      payFines(res);
      persist();
      if (res.checkAch) res.newAch = checkAchievements(res);
      FSM.change('PRESS_CONFERENCE', { result: res });
    } else {
      // Knocked out: the bag is restocked for the next attempt at this tournament
      res.betLost = !!M.cfg.bet;
      if (res.betLost) setTimeout(() => toast(sponsorKit().sponsor.replace(/\.$/, '') + ' lost their bet on you. They are reading the small print.', 4000), 1800);
      res.tournamentSmashed = SAVE.tournamentSmashed;
      res.tournamentFines = SAVE.tournamentFines;
      SAVE.tournamentRound = 0;
      SAVE.remainingRackets = 5;
      SAVE.freeSpareUsed = false;
      SAVE.tournamentSmashed = 0;
      SAVE.tournamentFines = 0;
      payFines(res);
      persist();
      if (res.checkAch) res.newAch = checkAchievements(res);
      if (reason === 'normal' && !SAVE.practiceHinted) {
        SAVE.practiceHinted = true;
        persist();
        setTimeout(() => toast('Tough one. Practise with Coach Derek any time: tap ? on the title screen.', 4200), 2600);
      }
      FSM.change('GAME_OVER', { kind: reason === 'normal' ? 'eliminated' : reason, result: res });
    }
  }

  /* ---------- PRESS_CONFERENCE ---------- */
  function buildQuestions(res) {
    const qs = [];
    const opp = res.cfg.opp;
    const story = !!(res.final || res.revenge || (res.handshake && (res.handshake.snub || res.handshake.choice === 'tooSlow')));
    const want = res.cfg.tierIdx < 2 && !story ? 1 : 2;
    if (res.handshake && (res.handshake.snub || res.handshake.choice === 'tooSlow')) qs.push(res.handshake.snub && res.handshake.choice !== 'tooSlow' ? pressQ('snubbed') : pressQ('tooSlow'));
    if (res.revenge) qs.push(pressQ('revenge'));
    if (res.final) qs.push(pressQ('final'));
    if (res.celebs >= 3 && Math.random() < 0.6) qs.push(pressQ('celebs'));
    if (res.smashed > 0) qs.push(pressQ('smashed'));
    else if (res.violations > 0) qs.push(pressQ('violations'));
    else if (Math.random() < 0.5) qs.push(pressQ('clean'));
    // Your own numbers, when they are bad enough: ahead of the usual questions, never ahead of a story
    let roast = null;
    try { roast = roastQ(res); } catch (e) { roast = null; }
    if (roast && Math.random() < 0.75) { if (story) qs.splice(1, 0, roast); else qs.unshift(roast); }
    const fits = PRESS_REACT.filter((x) => { try { return x.when(Object.assign({ repNow: SAVE.reputationScore }, res)); } catch (e) { return false; } });
    if (qs.length < want && fits.length && Math.random() < 0.65) qs.push(pickUnseen(fits, 'react', (x) => x.q));
    const trait = pick(opp.traits);
    if (qs.length < want && PRESS[trait]) qs.push(pressQ(trait));
    while (qs.length < want) {
      const gq = pickUnseen(PRESS.generic.filter((g) => qs.indexOf(g) < 0), 'generic', (x) => x.q);
      if (qs.indexOf(gq) < 0) qs.push(gq);
    }
    return qs.slice(0, want);
  }

  // The interview room, dressed for the venue: you at the desk with the microphones, your sponsor behind you,
  // the press in silhouette in front. Your face follows your last answer.
  function drawPressScene(st) {
    const c = $('#pressScene');
    if (!c || !st.res) return;
    const ctx = c.getContext('2d');
    const Wc = c.width;
    const Hc = c.height;
    const v = st.venue || 'club';
    const kit = playerKit();
    const spon = sponsorKit();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Back wall
    const wall = { club: ['#7a5236', '#6a4630'], council: ['#9a9a94', '#8a8a84'], leisure: ['#d9d2bd', '#cfc7b0'], invitational: ['#4a3426', '#3e2b1f'], slam: ['#13294b', '#0e1f3a'] }[v];
    ctx.fillStyle = wall[0];
    ctx.fillRect(0, 0, Wc, Hc);
    if (v === 'club') {
      // Clubhouse planks, a noticeboard and bunting
      ctx.fillStyle = wall[1];
      for (let y = 0; y < Hc; y += 26) ctx.fillRect(0, y, Wc, 3);
      ctx.fillStyle = '#c9a36b';
      ctx.fillRect(28, 40, 110, 80);
      ['#f4f1e6', '#ffe08a', '#bfe3ff'].forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(38 + i * 32, 52 + (i % 2) * 18, 26, 34); });
      ['#c8102e', '#f4f1e6', '#1f3a6b'].forEach((col, i) => {
        for (let k = i; k < 12; k += 3) {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(k * 42, 8);
          ctx.lineTo(k * 42 + 36, 8);
          ctx.lineTo(k * 42 + 18, 34);
          ctx.fill();
        }
      });
    } else if (v === 'council') {
      // Breeze blocks and a pop up banner
      ctx.fillStyle = wall[1];
      for (let y = 0; y < Hc; y += 30) for (let x = (y / 30) % 2 ? 0 : 30; x < Wc; x += 60) ctx.fillRect(x, y, 2, 30);
      for (let y = 0; y < Hc; y += 30) ctx.fillRect(0, y, Wc, 2);
      ctx.fillStyle = '#f4f1e6';
      ctx.fillRect(Wc - 120, 20, 96, 250);
      ctx.fillStyle = spon.textColor;
      ctx.save();
      ctx.translate(Wc - 72, 145);
      ctx.rotate(-Math.PI / 2);
      ctx.font = '30px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(spon.text, 0, 10);
      ctx.restore();
    } else if (v === 'leisure') {
      // A corner of the sports hall: wall bars and a crash mat
      ctx.fillStyle = '#b08850';
      for (let x = 20; x < 150; x += 30) ctx.fillRect(x, 20, 8, 300);
      for (let y = 40; y < 320; y += 26) ctx.fillRect(20, y, 128, 5);
      ctx.fillStyle = '#2f6fb3';
      ctx.fillRect(Wc - 150, 230, 150, 80);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(Wc - 150, 230, 150, 8);
    } else if (v === 'invitational') {
      // Wood panelling, a club crest and flowers
      ctx.fillStyle = wall[1];
      for (let x = 0; x < Wc; x += 80) ctx.fillRect(x, 0, 6, Hc);
      ctx.fillStyle = '#2f5d3a';
      ctx.fillRect(0, 0, Wc, 30);
      ctx.fillStyle = '#d9b44a';
      ctx.beginPath();
      ctx.moveTo(Wc / 2 - 34, 46);
      ctx.lineTo(Wc / 2 + 34, 46);
      ctx.lineTo(Wc / 2 + 34, 84);
      ctx.quadraticCurveTo(Wc / 2, 118, Wc / 2 - 34, 84);
      ctx.fill();
    } else {
      // The Grand Slam logo wall: your sponsor and the tournament, over and over
      ctx.font = 'bold 20px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      for (let row = 0; row < 12; row++) {
        for (let col = 0; col < 4; col++) {
          const alt = (row + col) % 2;
          ctx.fillStyle = alt ? 'rgba(244,241,230,0.55)' : spon.textColor === '#1f3a6b' ? '#9fc3ff' : spon.textColor;
          ctx.fillText(alt ? 'SLAM' : spon.text, 60 + col * 120 + (row % 2) * 60, 30 + row * 34);
        }
      }
    }
    // You, behind the desk. Your face follows the last answer.
    const mood = st.mood || 'neutral';
    // The room in depth: you behind the desk at the back, the floor, then the press nearer the camera
    const deskY = 300;
    const deskH = 66;
    const FLOOR = { club: '#7a5a3c', council: '#5c6168', leisure: '#3a6f9a', invitational: '#4a2f22', slam: '#1d2433' }[v];
    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, deskY + deskH - 4, Wc, Hc - deskY - deskH + 4);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let yy = deskY + deskH + 18; yy < Hc; yy += 26) ctx.fillRect(0, yy, Wc, 2);
    st.figs = st.figs || {};
    const fm = { nice: 'happy', villain: 'happy', cross: 'cross', neutral: 'calm' }[mood] || 'calm';
    if (!st.figs[mood]) st.figs[mood] = renderFigure(null, fm, 220, 310, 'full', { colors: youColors(), noRacket: true, redden: mood === 'cross' ? 0.6 : 0 });
    // Behind the desk: nothing of you shows below its front edge
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Wc, deskY + deskH);
    ctx.clip();
    ctx.drawImage(st.figs[mood], Wc / 2 - 110, deskY + 14 - 171);
    ctx.restore();
    // The desk and its cloth
    const cloth = { club: '#f4f1e6', council: '#2a2a2a', leisure: '#1f3a6b', invitational: '#2f5d3a', slam: '#0b1a33' }[v];
    ctx.fillStyle = cloth;
    ctx.fillRect(30, deskY, Wc - 60, deskH);
    ctx.strokeStyle = '#0b0b0b';
    ctx.lineWidth = 3;
    ctx.strokeRect(30, deskY, Wc - 60, deskH);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(30, deskY + deskH, Wc - 60, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(10, deskY, Wc - 20, 6);
    if (v === 'slam' || v === 'invitational') {
      ctx.fillStyle = spon.textColor === '#1f3a6b' ? '#9fc3ff' : spon.textColor;
      ctx.font = '24px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(spon.text, Wc / 2, deskY + 42);
    }
    // Microphones: one dictaphone at the club, a forest of them at the Slam
    const mics = { club: 1, council: 2, leisure: 2, invitational: 4, slam: 7 }[v];
    const flags = ['#c8102e', '#1f3a6b', '#d9f24a', '#f4f1e6', '#ff8a3a', '#5fd068', '#9b59b6'];
    for (let i = 0; i < mics; i++) {
      const mx = Wc / 2 + (i - (mics - 1) / 2) * 30;
      const top = deskY - 34 - (i % 2) * 8;
      if (v === 'club') {
        ctx.fillStyle = '#333';
        ctx.fillRect(mx - 14, deskY - 24, 28, 22);
        ctx.fillStyle = '#ff3b30';
        ctx.fillRect(mx + 6, deskY - 20, 4, 4);
        continue;
      }
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(mx, deskY);
      ctx.lineTo(mx + (i - (mics - 1) / 2) * 6, top);
      ctx.stroke();
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.ellipse(mx + (i - (mics - 1) / 2) * 6, top - 8, 9, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = flags[i % flags.length];
      ctx.fillRect(mx + (i - (mics - 1) / 2) * 6 - 10, top + 6, 20, 14);
    }
    // Your sponsor's product on the desk
    const px = Wc - 70;
    if (spon.sponsor === 'Snarl Energy') {
      ctx.fillStyle = '#161616';
      ctx.fillRect(px, deskY - 46, 26, 46);
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(px, deskY - 34, 26, 8);
    } else if (spon.sponsor === 'Barley Water Co.') {
      ctx.fillStyle = 'rgba(183,156,224,0.85)';
      ctx.fillRect(px, deskY - 52, 24, 52);
      ctx.fillRect(px + 7, deskY - 64, 10, 14);
      ctx.fillStyle = '#6b3fa0';
      ctx.fillRect(px, deskY - 34, 24, 12);
    } else {
      ctx.fillStyle = '#1f3a6b';
      ctx.beginPath();
      ctx.ellipse(px + 14, deskY - 14, 18, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4f1e6';
      ctx.beginPath();
      ctx.ellipse(px + 14, deskY - 14, 6, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    drawPressPack(ctx, st, Wc, Hc, v);
    // Camera flashes
    (st.flash || []).forEach((f) => {
      const a = 1 - f.t / 0.25;
      const g = ctx.createRadialGradient(f.x * Wc, f.y * Hc, 0, f.x * Wc, f.y * Hc, 70);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * a).toFixed(2) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, Wc, Hc);
    });
  }

  // The journalists, from behind, in the front rows: jackets, lanyards, hair, a notepad. The one asking holds a
  // dictaphone up. They react to your answer: shoulders shake with laughter, heads jerk back at a spicy one,
  // pens scribble at a deadpan one. Photographers crouch at the sides, flashing at anything quotable.
  // From behind, a seated person's calves and shoes show under the chair; the chair back covers their lower back.
  // Same outline and colours as the stands.
  function drawPressChair(ctx, x, seatY, floorY, sz, P, chair) {
    const ol = '#0b0b0b';
    const legCol = P.legWear === 'trousers' ? P.legs : P.skin;
    ctx.lineCap = 'round';
    [-1, 1].forEach((sd) => {
      const kx = x + sd * 0.09 * sz;
      ctx.strokeStyle = ol;
      ctx.lineWidth = 0.1 * sz + 4;
      ctx.beginPath();
      ctx.moveTo(kx, seatY);
      ctx.lineTo(kx + sd * 0.02 * sz, floorY - 0.04 * sz);
      ctx.stroke();
      ctx.strokeStyle = shadeHex(legCol, -0.08);
      ctx.lineWidth = 0.1 * sz;
      ctx.stroke();
      ctx.fillStyle = P.shoe;
      ctx.strokeStyle = ol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(kx + sd * 0.02 * sz, floorY - 0.03 * sz, 0.07 * sz, 0.035 * sz, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    // The chair: four legs, the seat edge, and the back rest across the sitter's lower back
    const cw = 0.42 * sz;
    ctx.strokeStyle = ol;
    ctx.lineWidth = 0.035 * sz + 3;
    [-1, 1].forEach((sd) => {
      ctx.beginPath();
      ctx.moveTo(x + sd * cw / 2, seatY - 0.3 * sz);
      ctx.lineTo(x + sd * cw / 2, floorY);
      ctx.stroke();
    });
    ctx.strokeStyle = chair.frame;
    ctx.lineWidth = 0.035 * sz;
    [-1, 1].forEach((sd) => {
      ctx.beginPath();
      ctx.moveTo(x + sd * cw / 2, seatY - 0.3 * sz);
      ctx.lineTo(x + sd * cw / 2, floorY);
      ctx.stroke();
    });
    ctx.fillStyle = chair.back;
    ctx.strokeStyle = ol;
    ctx.lineWidth = 2.5;
    roundRect(ctx, x - cw / 2 - 0.02 * sz, seatY - 0.3 * sz, cw + 0.04 * sz, 0.17 * sz, 0.03 * sz);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = shadeHex(chair.back, -0.25);
    ctx.fillRect(x - cw / 2, seatY - 0.02 * sz, cw, 0.05 * sz);
  }
  function drawPressPack(ctx, st, Wc, Hc, v) {
    const pack = (PRESS_PACK[v] || PRESS_PACK.club).map((i) => JOURNOS[i]);
    const r = st.react;
    const ra = r ? st.t - r.t : 9;
    const n = pack.length;
    const PV = VENUES.invitational;   // the press dress like the smarter end of the crowd
    const flashing = (st.flash || []).some((f) => f.t >= 0 && f.t < 0.12);
    // Photographers first, standing at the back corners, cameras held up over everyone
    for (let p = 0; p < PHOTOGRAPHERS[v]; p++) {
      const side = p % 2 ? -1 : 1;
      drawPhotographer(ctx, side > 0 ? 50 : Wc - 50, Hc - 196, side, flashing && (p + Math.floor(st.t * 7)) % 2 === 0, 'press-photo-' + p);
    }
    // Two rows of journalists, the back row first; the one asking holds up a dictaphone
    const order = pack.map((j, i) => i).sort((a, b) => (b % 2) - (a % 2));
    let tag = null;
    order.forEach((i) => {
      const j = pack[i];
      const asking = st.asker === j && !st.answered;
      const back = i % 2;
      const sz = back ? 96 : 116;
      const x = (Wc / (n + 1)) * (i + 1);
      const floorY = back ? Hc - 58 : Hc - 8;
      let y = floorY - 1.2 * sz;
      if (r && ra < 1.4) {
        if (r.kind === 'laugh') y += Math.abs(Math.sin(ra * 22 + i)) * 5 * (1 - ra / 1.4);
        else if (r.kind === 'gasp') y -= Math.max(0, 1 - ra * 2) * 10;
        else if (r.kind === 'scribble') y += Math.sin(ra * 18 + i) * 1.5;
      }
      const P = paintPerson(ctx, fnv1a('journo:' + j.name), x, y, sz, PV, false, true);
      drawPressChair(ctx, x, y + 0.72 * sz, floorY, sz, P, PRESS_CHAIR[v] || PRESS_CHAIR.club);
      if (asking) {
        // An arm up over the shoulder, a dictaphone pointed at you
        const sleeve = P.wear === 'dress' ? P.skin : shadeHex(P.body, -0.1);
        const sh2 = { x: x + 0.17 * sz, y: y + 0.24 * sz };
        const hd = { x: x + 0.26 * sz, y: y - 0.14 * sz };
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#0b0b0b';
        ctx.lineWidth = 0.08 * sz + 4;
        ctx.beginPath();
        ctx.moveTo(sh2.x, sh2.y);
        ctx.lineTo(hd.x, hd.y);
        ctx.stroke();
        ctx.strokeStyle = sleeve;
        ctx.lineWidth = 0.08 * sz;
        ctx.stroke();
        ctx.fillStyle = '#16181c';
        roundRect(ctx, hd.x - 0.035 * sz, hd.y - 0.17 * sz, 0.07 * sz, 0.16 * sz, 3);
        ctx.fill();
        ctx.fillStyle = '#ff3b30';
        ctx.fillRect(hd.x - 0.015 * sz, hd.y - 0.15 * sz, 0.03 * sz, 0.02 * sz);
        ctx.fillStyle = P.skin;
        ctx.beginPath();
        ctx.arc(hd.x, hd.y, 0.045 * sz, 0, Math.PI * 2);
        ctx.fill();
        tag = { x: x, y: y - 0.62 * sz, name: j.name };
      }
    });
    // Who is asking: a name tag over them, drawn last so nothing covers it
    if (tag) {
      ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
      const tw = ctx.measureText(tag.name).width + 16;
      const lx = clamp(tag.x - tw / 2, 4, Wc - tw - 4);
      ctx.fillStyle = '#f4f1e6';
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 2;
      roundRect(ctx, lx, tag.y, tw, 22, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#10261a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag.name, lx + tw / 2, tag.y + 11);
    }
  }
  // A press photographer from behind, in the crowd painter's style: standing, both arms up, the camera held
  // over the heads in front with the lens angled in at the desk and a flashgun on top
  function drawPhotographer(ctx, x, y, side, flashOn, seed) {
    const sz = 112;
    const P0 = crowdPerson(makeLCG(fnv1a(seed || 'photographer')), VENUES.council);
    // Standing: legs straight down to the floor, drawn first so the jacket hangs over them
    const legCol = P0.legWear === 'trousers' ? P0.legs : P0.skin;
    [-1, 1].forEach((sd) => {
      const lx = x + sd * 0.09 * sz;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 0.12 * sz + 4;
      ctx.beginPath();
      ctx.moveTo(lx, y + 0.66 * sz);
      ctx.lineTo(lx + sd * 0.02 * sz, y + 1.5 * sz);
      ctx.stroke();
      ctx.strokeStyle = legCol;
      ctx.lineWidth = 0.12 * sz;
      ctx.stroke();
      ctx.fillStyle = P0.shoe;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(lx + sd * 0.02 * sz, y + 1.52 * sz, 0.08 * sz, 0.04 * sz, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    const P = paintPerson(ctx, fnv1a(seed || 'photographer'), x, y, sz, VENUES.council, false, true);
    const sleeve = shadeHex(P.body, -0.1);
    const cam = { x: x + side * 0.1 * sz, y: y - 0.16 * sz };
    ctx.lineCap = 'round';
    [-1, 1].forEach((sd) => {
      const a = { x: x + sd * 0.17 * sz, y: y + 0.24 * sz };
      const b = { x: cam.x + sd * 0.13 * sz, y: cam.y + 0.04 * sz };
      ctx.strokeStyle = '#0b0b0b';
      ctx.lineWidth = 0.075 * sz + 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = sleeve;
      ctx.lineWidth = 0.075 * sz;
      ctx.stroke();
    });
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.rotate(side * 0.3);
    ctx.strokeStyle = '#0b0b0b';
    ctx.lineWidth = 2.5;
    ctx.fillStyle = '#16181c';
    roundRect(ctx, -0.15 * sz, -0.07 * sz, 0.3 * sz, 0.16 * sz, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(-0.06 * sz, -0.22 * sz, 0.12 * sz, 0.16 * sz);
    ctx.strokeRect(-0.06 * sz, -0.22 * sz, 0.12 * sz, 0.16 * sz);
    ctx.fillStyle = flashOn ? '#ffffff' : '#8a8f96';
    ctx.fillRect(0.07 * sz, -0.16 * sz, 0.07 * sz, 0.08 * sz);
    ctx.strokeRect(0.07 * sz, -0.16 * sz, 0.07 * sz, 0.08 * sz);
    ctx.restore();
  }

  // Tomorrow's front page, as a picture: the masthead of the paper that got the best quote, the headline,
  // a photo from the room, and the numbers down the side
  function buildFrontPage(st) {
    const cv = document.createElement('canvas');
    cv.width = 600;
    cv.height = 800;
    const g = cv.getContext('2d');
    const res = st.res;
    const top = st.lead;
    // The photo is the room as it is now, without the name tag over whoever asked last
    st.answered = true;
    drawPressScene(st);
    const j = top.journo;
    g.fillStyle = '#f2ece0';
    g.fillRect(0, 0, 600, 800);
    // Masthead: red top for the tabloids, black type for the rest
    if (j.red) { g.fillStyle = '#c8102e'; g.fillRect(0, 0, 600, 110); }
    g.fillStyle = j.red ? '#ffffff' : '#111111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // The masthead, shrunk until it fits across the page
    const mast = j.outlet.toUpperCase().replace(/^THE /, j.red ? '' : 'THE ');
    let msz = 50;
    do { g.font = (j.red ? 'italic 900 ' : 'bold ') + msz + 'px Georgia, "Times New Roman", serif'; msz -= 2; } while (g.measureText(mast).width > 548 && msz > 24);
    g.fillText(mast, 300, 58);
    g.fillStyle = '#111';
    g.font = 'bold 15px Georgia, serif';
    g.textAlign = 'left';
    g.fillText(prettyDate(dateKey()).toUpperCase(), 24, 130);
    g.textAlign = 'right';
    g.fillText('40p', 576, 130);
    g.fillRect(24, 142, 552, 3);
    // EXCLUSIVE splash
    let y = 160;
    if (st.exclusive) {
      g.fillStyle = '#ffd400';
      g.fillRect(24, y, 190, 36);
      g.fillStyle = '#111';
      g.font = '900 24px Impact, "Arial Black", sans-serif';
      g.textAlign = 'left';
      g.fillText('EXCLUSIVE', 36, y + 19);
      y += 46;
    }
    // The headline, as big as it will go
    g.fillStyle = '#111';
    g.textAlign = 'left';
    let size = 64;
    let lines;
    do {
      g.font = '900 ' + size + 'px Impact, "Arial Black", sans-serif';
      lines = wrapText(g, top.h, 552);
      size -= 4;
    } while (lines.length > 3 && size > 30);
    lines.forEach((l, i) => g.fillText(l, 24, y + size * 0.55 + i * (size + 6)));
    y += lines.length * (size + 6) + 14;
    // The photo from the room
    const ph = $('#pressScene');
    const pw = 360;
    // A long headline leaves less room: the photo is cropped shorter so the second story still fits below it
    const pH = Math.min(Math.round(pw * ph.height / ph.width), 668 - y);
    const srcH = ph.width * pH / pw;
    g.drawImage(ph, 0, (ph.height - srcH) * 0.45, ph.width, srcH, 24, y, pw, pH);
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.strokeRect(24, y, pw, pH);
    g.font = 'italic 14px Georgia, serif';
    g.fillStyle = '#333';
    g.fillText('Pictured: the star, moments after saying it', 24, y + pH + 18);
    // The numbers down the side
    const sx = 404;
    g.fillStyle = '#111';
    g.font = 'bold 16px Georgia, serif';
    g.fillText('MATCH FACTS', sx, y + 10);
    g.fillRect(sx, y + 22, 172, 2);
    const facts = [['Score', res.score], ['Opponent', res.cfg.opp.name], ['Rackets smashed', String(res.smashed)], ['Fines paid', money(res.finesPaid || 0)], ['Sponsor', res.sponsorName]];
    facts.forEach((f, i) => {
      g.font = '13px Georgia, serif';
      g.fillStyle = '#555';
      g.fillText(f[0], sx, y + 46 + i * 46);
      g.font = 'bold 17px Georgia, serif';
      g.fillStyle = '#111';
      const v2 = wrapText(g, f[1], 172)[0];
      g.fillText(v2, sx, y + 66 + i * 46);
    });
    // The second story, and the strapline
    const by = Math.max(y + pH + 40, 680);
    g.fillRect(24, by, 552, 2);
    if (st.second) {
      // Full width when there is room above the strapline at the foot of the page; otherwise it runs beside it,
      // in a narrower column that stops short of the strapline
      g.fillStyle = '#111';
      const roomy = by + 56 <= 764;
      const text = 'ALSO: ' + st.second.h;
      if (roomy) {
        g.font = 'bold 20px Georgia, serif';
        wrapText(g, text, 552).slice(0, 2).forEach((l, i) => g.fillText(l, 24, by + 28 + i * 24));
      } else {
        // One line beside the strapline, as large as fits (two small lines only for a very long story)
        let fs = 17;
        g.font = 'bold ' + fs + 'px Georgia, serif';
        while (g.measureText(text).width > 400 && fs > 13) { fs--; g.font = 'bold ' + fs + 'px Georgia, serif'; }
        const lines = wrapText(g, text, 400).slice(0, 2);
        const lh = fs + 2;
        const y0 = Math.min(by + fs + 8, 792 - (lines.length - 1) * lh);
        lines.forEach((l, i) => g.fillText(l, 24, y0 + i * lh));
      }
    }
    g.font = 'bold 14px "Trebuchet MS", sans-serif';
    g.fillStyle = '#c8102e';
    g.textAlign = 'right';
    g.fillText('RACKET RAGE TENNIS', 576, 784);
    return cv;
  }
  // Before a rematch: the back page of the sports section, with their portrait, the head to head and a quote
  const BACK_COPY = {
    nemesis: { h: 'THE GRUDGE MATCH', sub: '{opp} has beaten you {l} times. Today, somebody cracks.', q: ['I know what you did last tournament.', 'Bring rackets. Plural.', 'I have cleared my diary for this.'] },
    theyWon: { h: '{SUR} SMELLS BLOOD', sub: 'Last time ended in tears. Theirs were tears of joy.', q: ['Same again, please.', 'Tell your rackets I said hello.', 'I hope they have restocked the bag.'] },
    handshake: { h: '{SUR} HAS NOT FORGOTTEN', sub: 'Last time you pulled your hand away at the net. They have been practising their handshake.', q: ['Too slow? We will see who is too slow.', 'I have been doing grip exercises.', 'I have a long memory and a strong hand.'] },
    youWon: { h: '{SUR} VOWS PAYBACK', sub: 'Beaten last time, and they have been practising. Allegedly.', q: ['That was a fluke and the fluke is over.', 'I have watched the tape. Forty times.', 'Revenge is a dish best served at 130 mph.'] }
  };
  function buildBackPage(o, r) {
    const kind = r.hs === 'tooSlow' ? 'handshake' : isNemesis(o.name) ? 'nemesis' : r.last === 'l' ? 'theyWon' : 'youWon';
    const B = BACK_COPY[kind];
    const sur = tvName(o.name);
    const cv = document.createElement('canvas');
    cv.width = 600;
    cv.height = 800;
    const g = cv.getContext('2d');
    g.fillStyle = '#f2ece0';
    g.fillRect(0, 0, 600, 800);
    // The sport section's masthead
    g.fillStyle = '#1f6b3a';
    g.fillRect(0, 0, 600, 96);
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = '900 54px Impact, "Arial Black", sans-serif';
    g.fillText('SPORT', 24, 50);
    g.font = 'bold 16px Georgia, serif';
    g.textAlign = 'right';
    g.fillText('THE DAILY GRUMBLE', 576, 38);
    g.fillText(prettyDate(dateKey()).toUpperCase(), 576, 64);
    // Headline
    g.fillStyle = '#111';
    g.textAlign = 'left';
    let size = 72;
    let lines;
    do {
      g.font = '900 ' + size + 'px Impact, "Arial Black", sans-serif';
      lines = wrapText(g, B.h.replace('{SUR}', sur), 552);
      size -= 4;
    } while (lines.length > 2 && size > 36);
    lines.forEach((l, i) => g.fillText(l, 24, 140 + i * (size + 6)));
    let y = 140 + lines.length * (size + 6) - 8;
    g.font = 'italic 20px Georgia, serif';
    g.fillStyle = '#333';
    wrapText(g, fill(B.sub, { opp: o.name, l: r.l }), 552).forEach((l, i) => g.fillText(l, 24, y + i * 26));
    y += 54;
    // Their portrait, glaring
    const pf = renderFigure(o, kind === 'youWon' ? 'cross' : 'happy', 330, 330, 'bust');
    g.fillStyle = '#d7cfbd';
    g.fillRect(24, y, 330, 330);
    g.drawImage(pf, 24, y);
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.strokeRect(24, y, 330, 330);
    g.font = 'italic 14px Georgia, serif';
    g.fillStyle = '#333';
    g.fillText(o.name + ', yesterday', 24, y + 348);
    // Head to head
    const hx = 374;
    g.fillStyle = '#111';
    g.font = 'bold 16px Georgia, serif';
    g.fillText('HEAD TO HEAD', hx, y + 12);
    g.fillRect(hx, y + 24, 202, 2);
    g.font = '900 64px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.fillText(r.w + ' - ' + r.l, hx + 101, y + 76);
    g.font = 'bold 14px Georgia, serif';
    g.fillText('YOU          ' + sur.slice(0, 10), hx + 101, y + 116);
    g.textAlign = 'left';
    // Their quote, pulled out
    g.fillStyle = '#c8102e';
    g.fillRect(hx, y + 150, 6, 140);
    g.fillStyle = '#111';
    g.font = 'italic bold 22px Georgia, serif';
    wrapText(g, '"' + pick(B.q) + '"', 186).slice(0, 5).forEach((l, i) => g.fillText(l, hx + 16, y + 170 + i * 28));
    g.font = '14px Georgia, serif';
    g.fillText('- ' + o.name, hx + 16, y + 312);
    g.font = 'bold 14px "Trebuchet MS", sans-serif';
    g.fillStyle = '#c8102e';
    g.textAlign = 'right';
    g.fillText('RACKET RAGE TENNIS', 576, 784);
    return cv;
  }

  // ---------- The trophy ceremony, after a final ----------
  // Each tour's trophy has its own shape: a plate, a tankard, a gold cod, a salver and the cup.
  // Drawn centred on (x, y), about 90 px tall at s = 1.
  function drawTrophyShape(g, tierIdx, x, y, s) {
    const gold = (x0, x1) => { const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, '#a8862e'); gr.addColorStop(0.4, '#ffe89a'); gr.addColorStop(1, '#c99a2e'); return gr; };
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.strokeStyle = '#0b0b0b';
    g.lineWidth = 3;
    g.fillStyle = gold(-50, 50);
    if (tierIdx === 0) {
      // The Puddleby Plate: a dish on edge, with a ring and a crest
      g.beginPath(); g.arc(0, 0, 44, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.arc(0, 0, 32, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#c99a2e'; g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (tierIdx === 1) {
      // The County Tankard: a lidded mug with a handle
      g.fillRect(-26, -34, 52, 70); g.strokeRect(-26, -34, 52, 70);
      g.beginPath(); g.ellipse(0, -36, 30, 8, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.lineWidth = 9; g.strokeStyle = '#c99a2e'; g.beginPath(); g.arc(30, 0, 16, -Math.PI / 2, Math.PI / 2); g.stroke();
      g.lineWidth = 3; g.strokeStyle = '#0b0b0b'; g.strokeRect(-26, -10, 52, 6);
    } else if (tierIdx === 2) {
      // The Grimsby Cod: a gold fish on a plinth
      g.beginPath();
      g.moveTo(-46, 0); g.quadraticCurveTo(-10, -32, 30, -6); g.lineTo(48, -22); g.lineTo(44, 0); g.lineTo(48, 22); g.lineTo(30, 6); g.quadraticCurveTo(-10, 32, -46, 0);
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#111'; g.beginPath(); g.arc(-30, -4, 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1a1a1a'; g.fillRect(-14, 26, 28, 18); g.strokeRect(-14, 26, 28, 18);
    } else if (tierIdx === 3) {
      // The Tunbridge Salver: a round tray, held face out
      g.beginPath(); g.ellipse(0, 0, 50, 40, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(0, 0, 40, 31, 0, 0, Math.PI * 2); g.stroke();
      g.font = 'bold 12px Georgia, serif'; g.fillStyle = '#6b4a00'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('TUNBRIDGE', 0, 0);
    } else {
      // The Wimbleford Cup: two handles, a lid and a plinth
      g.beginPath();
      g.moveTo(-38, -40); g.lineTo(38, -40); g.quadraticCurveTo(36, 14, 8, 26); g.lineTo(10, 52); g.lineTo(-10, 52); g.lineTo(-8, 26); g.quadraticCurveTo(-36, 14, -38, -40);
      g.closePath(); g.fill(); g.stroke();
      g.lineWidth = 7; g.strokeStyle = '#c99a2e';
      [-1, 1].forEach((sd) => { g.beginPath(); g.arc(sd * 42, -18, 16, sd > 0 ? -Math.PI / 2 : Math.PI / 2, sd > 0 ? Math.PI / 2 : Math.PI * 1.5); g.stroke(); });
      g.lineWidth = 3; g.strokeStyle = '#0b0b0b';
      g.fillStyle = '#1a1a1a'; g.fillRect(-26, 52, 52, 14); g.strokeRect(-26, 52, 52, 14);
      g.fillStyle = gold(-10, 10); g.beginPath(); g.arc(0, -48, 9, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(-20, -26, 5, 22);
    g.restore();
  }
  function drawCeremony(st) {
    const cv = $('#ceremonyScene');
    const C2 = st.ceremony;
    if (!cv || !C2) return;
    const g = cv.getContext('2d');
    const Wc = cv.width;
    const Hc = cv.height;
    const res = st.res;
    const tierIdx = res.cfg.tierIdx;
    const tier = TIERS[tierIdx];
    const t = C2.t;
    g.setTransform(1, 0, 0, 1, 0, 0);
    // The stands behind: rows of faces in the venue's colours, the sponsor boards, the court
    const V = VENUES[VENUE_BY_TIER[tierIdx]];
    g.fillStyle = V.riser || '#173827';
    g.fillRect(0, 0, Wc, 230);
    // The crowd, painted once by the same painter as the stands in a match
    if (!C2.crowd) {
      C2.crowd = document.createElement('canvas');
      C2.crowd.width = Wc;
      C2.crowd.height = 232;
      const cg = C2.crowd.getContext('2d');
      cg.fillStyle = V.riser || '#173827';
      cg.fillRect(0, 0, Wc, 232);
      for (let row = 0; row < 6; row++) {
        cg.fillStyle = row % 2 ? V.tread || '#24533a' : V.tread2 || '#2a5c40';
        cg.fillRect(0, 22 + row * 36, Wc, 36);
        for (let x = 14 + (row % 2) * 13; x < Wc; x += 27) {
          paintPerson(cg, fnv1a('stand:' + tierIdx + ':' + row + ':' + x), x, 18 + row * 36, 112, V, true, false);
        }
      }
    }
    g.drawImage(C2.crowd, 0, 0);
    g.fillStyle = V.board || '#1f4a33';
    g.fillRect(0, 222, Wc, 44);
    g.fillStyle = '#f4f1e6';
    g.font = '24px "Lilita One", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(tier.name.toUpperCase(), Wc / 2, 245);
    g.fillStyle = SURFACES[tier.surface].court;
    g.fillRect(0, 266, Wc, Hc - 266);
    // The podium: the place and the name, both above the caption strap at the bottom (it starts at Hc - 56)
    const step = (x, w, top, n, label) => {
      g.fillStyle = '#f4f1e6';
      g.strokeStyle = '#0b0b0b';
      g.lineWidth = 3;
      g.fillRect(x, top, w, Hc - top);
      g.strokeRect(x, top, w, Hc - top + 4);
      const room = Hc - 56 - top;
      g.fillStyle = '#10261a';
      g.font = (room < 80 ? 30 : 40) + 'px "Lilita One", Impact, sans-serif';
      g.fillText(n, x + w / 2, top + room * 0.3);
      fitCanvasText(g, label, w - 14, 25, '"Lilita One", Impact, sans-serif');
      g.fillText(label, x + w / 2, top + room * 0.76);
    };
    step(Wc / 2 - 70, 140, 330, '1', myTv());
    step(Wc / 2 - 230, 140, 362, '2', tvName(res.cfg.opp.name));
    // The runner up on the second step, clapping through gritted teeth; you on the top step with the trophy
    // held aloft. Both drawn exactly as they look in a match.
    if (!C2.opp) C2.opp = renderFigure(res.cfg.opp, 'cross', 170, 230, 'full', { stance: 'clap', noRacket: true });
    g.drawImage(C2.opp, Wc / 2 - 245, 362 - 226);
    if (!C2.you) {
      C2.you = renderFigure(null, 'happy', 200, 330, 'full', {
        colors: youColors(), stance: 'trophy', noRacket: true, top: 2.75,
        before: (fg, f, k) => drawTrophyShape(fg, tierIdx, f.x, f.y - 2.28 * k, 0.5 * k / 90)
      });
    }
    const bob = reduceMotion ? 0 : Math.abs(Math.sin(t * 4)) * 8;
    g.drawImage(C2.you, Wc / 2 - 100, 330 - 326 - bob);
    // Confetti
    if (!C2.bits) {
      C2.bits = [];
      for (let i = 0; i < 90; i++) C2.bits.push({ x: Math.random() * Wc, y: -Math.random() * Hc, v: 50 + Math.random() * 70, w: Math.random() * 6, c: ['#d9f24a', '#ff3b30', '#6fd3ff', '#f4f1e6', '#ffb03a'][i % 5] });
    }
    if (!reduceMotion) C2.bits.forEach((b) => {
      const yy = (b.y + t * b.v) % (Hc + 20);
      g.fillStyle = b.c;
      g.save();
      g.translate(b.x + Math.sin(t * 3 + b.w) * 10, yy);
      g.rotate(t * 4 + b.w);
      g.fillRect(-4, -2, 8, 4);
      g.restore();
    });
    // Flashes from the photographers' pit
    if (!reduceMotion && Math.sin(t * 9.3) > 0.97) {
      const fx = (Math.sin(t * 13) * 0.5 + 0.5) * Wc;
      const gr = g.createRadialGradient(fx, Hc - 20, 0, fx, Hc - 20, 160);
      gr.addColorStop(0, 'rgba(255,255,255,0.85)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, Wc, Hc);
    }
    // The caption strap
    g.fillStyle = 'rgba(16,38,26,0.92)';
    g.fillRect(0, Hc - 56, Wc, 56);
    g.fillStyle = '#d9f24a';
    g.font = '26px "Lilita One", Impact, sans-serif';
    g.fillText('CHAMPION', Wc / 2, Hc - 36);
    g.fillStyle = '#f4f1e6';
    g.font = 'bold 15px "Trebuchet MS", sans-serif';
    g.fillText(tier.trophy + '  |  ' + res.score + ' against ' + res.cfg.opp.name, Wc / 2, Hc - 14);
  }

  // The share frame's words, by what is in it
  const CARD_FRAME = {
    tantrum: { kicker: 'Your tantrum, framed', fine: 'Save the picture, then post it wherever your shame is best appreciated.', copy: 'Copy Scorecard' },
    page: { kicker: 'Hot off the press', fine: 'Save the picture, then post it wherever your shame is best appreciated.', copy: 'Copy Caption' },
    trophy: { kicker: 'Your trophy, framed', fine: 'Save the picture, then show everyone. Modestly, if you can manage it.', copy: 'Copy Caption' }
  };
  function cardFrame(kind) {
    const f = CARD_FRAME[kind] || CARD_FRAME.page;
    $('#cardKicker').textContent = f.kicker;
    $('#cardFine').textContent = f.fine;
    $('#cardCopy').textContent = f.copy;
  }
  async function shareCanvas(card, text, file, kind) {
    const dataUrl = card.toDataURL('image/png');
    const Cap = window.Capacitor;
    try {
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Filesystem && Cap.Plugins.Share) {
        const saved = await Cap.Plugins.Filesystem.writeFile({ path: file, data: dataUrl.split(',')[1], directory: 'CACHE' });
        await Cap.Plugins.Share.share({ title: 'Racket Rage Tennis', text: text, files: [saved.uri], dialogTitle: 'Share the front page' });
        return;
      }
    } catch (e) {
      if (e && /cancel/i.test(String(e.message || e))) return;
    }
    try {
      const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
      const f = blob && new File([blob], file, { type: 'image/png' });
      if (f && navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], text: text });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    $('#cardImg').src = dataUrl;
    $('#cardSave').href = dataUrl;
    $('#cardSave').setAttribute('download', file);
    cardFrame(kind || 'page');
    $('#cardModal').dataset.text = text;
    $('#cardModal').classList.remove('hidden');
  }

  FSM.states.PRESS_CONFERENCE = {
    screen: 'press',
    update(dt) {
      this.t = (this.t || 0) + dt;
      // Camera flashes, more of them at the bigger events
      const rate = { club: 0, council: 0.2, leisure: 0.3, invitational: 0.8, slam: 2.2 }[this.venue] || 0;
      if (!reduceMotion && Math.random() < rate * dt) this.flash.push({ x: Math.random(), y: 0.72 + Math.random() * 0.2, t: 0 });
      this.flash = (this.flash || []).filter((f) => (f.t += dt) < 0.25);
      drawPressScene(this);
      if (this.ceremony) { this.ceremony.t += dt; drawCeremony(this); }
    },
    enter(p, scope) {
      const res = p.result;
      this.venue = venueKey(res.cfg);
      const tier = TIERS[res.cfg.tierIdx];
      const qs = buildQuestions(res);
      let qi = 0;
      const vars = {
        opp: res.cfg.opp.name,
        n: res.smashed,
        s: res.smashed === 1 ? '' : 's',
        v: res.violations,
        vs: res.violations === 1 ? '' : 's',
        a: (res.stats && res.stats.aces) || 0,
        fines: money(SAVE.totalFines),
        r: res.rackets,
        rs: res.rackets === 1 ? '' : 's',
        season: SAVE.season || 1
      };
      $('#pressKicker').textContent = res.cfg.label + ' won ' + res.score;
      $('#pressTitle').textContent = res.final ? 'Champion\'s Press Conference' : 'The Interview Room';
      setTimeout(() => resultStamp($('#pressStamp'), res.final ? 'CHAMPION!' : 'YOU WON!', true), 300);
      if (res.final) maybeAskReview(res);
      const payout = $('#pressPayout');
      // Two lines, so the questions have the room: prize and fines, then the sponsor's cut
      payout.innerHTML = 'Prize money <b></b> <i>Fines <b class="neg"></b></i><br><span></span> <b></b> <small></small>';
      payout.querySelector('span').textContent = res.sponsorName;
      payout.querySelector('small').textContent = '(' + res.sponsorWhy + ')';
      const bs = payout.querySelectorAll('b');
      bs[0].textContent = money(0);
      bs[2].textContent = money(0);
      setTimeout(() => { countUp(bs[0], res.prize); setTimeout(() => countUp(bs[2], res.sponsor), 350); }, 450);
      bs[1].textContent = (res.finesPaid ? '-' : '') + money(res.finesPaid || 0);
      // A bet that came in: the sponsor's extra goes on the end of the sponsor's line
      if (res.betWin) {
        // It takes the place of the sponsor's mood, so the payout stays two lines
        payout.querySelector('small').remove();
        const bw = document.createElement('i');
        bw.innerHTML = 'Bet <b></b>';
        payout.appendChild(bw);
        bw.querySelector('b').textContent = money(0);
        setTimeout(() => countUp(bw.querySelector('b'), res.betWin), 1100);
        setTimeout(() => toast(res.sponsorName + (/s$/.test(res.sponsorName) ? '\'' : '\'s') + ' bet on you came in: ' + money(res.betWin) + '.', 3200), 1400);
      }
      // The sponsor's bet on your next match, unless the tour is over
      const tourOver = res.final && SAVE.careerComplete && res.cfg.tierIdx === TIERS.length - 1;
      offerBet(scope, $('#doubleRow'), $('#btnDouble'), $('#doubleNote'), $('#doubleMsg'), () => fit());
      if (tourOver) $('#doubleRow').classList.add('hidden');
      this.res = res;
      this.mood = res.smashed > 0 ? 'cross' : 'neutral';
      this.t = 0;
      this.flash = [];
      $('#pressTantrumRow').classList.toggle('hidden', !res.tantrum);
      if (res.tantrum) {
        $('#btnPressTantrum').textContent = res.tantrum.highlight ? 'Share Highlight' : res.tantrum.theirs ? 'Share Their Tantrum' : 'Share Your Tantrum';
        scope.on($('#btnPressTantrum'), 'click', () => { sfx('click'); shareTantrum(res.tantrum, scorecardText('win', res)); });
      }
      sfx('coins');
      // After a final: the trophy ceremony first, then the press room
      this.ceremony = null;
      if (res.final) {
        this.ceremony = { t: 0 };
        $('#ceremonyModal').classList.remove('hidden');
        sfx('applause', { power: 1.4 });
        scope.on($('#btnCeremonyShare'), 'click', () => { sfx('click'); shareCanvas($('#ceremonyScene'), 'Champion: ' + TIERS[res.cfg.tierIdx].trophy + ' | Racket Rage Tennis', 'racket-rage-trophy.png', 'trophy'); });
        scope.on($('#btnCeremonyOn'), 'click', () => { sfx('click'); $('#ceremonyModal').classList.add('hidden'); this.ceremony = null; });
      }

      // At the smaller venues the official is a referee, not an umpire in a chair
      const isRef = officialTitle(res.cfg) === 'Referee';
      const official = (t) => (isRef ? t.replace(/\bumpire\b/g, 'referee').replace(/\bUmpire\b/g, 'Referee').replace(/\bUMPIRE\b/g, 'REFEREE') : t);
      const pack = (PRESS_PACK[this.venue] || PRESS_PACK.club).map((i) => JOURNOS[i]);
      const start = Math.floor(Math.random() * pack.length);
      this.stories = [];
      this.exclusive = false;
      this.followed = false;
      this.react = null;
      // An answer button: the words, then a chip for its tone, and a warning if it carries a fine
      const answerButton = (a, onPick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'answer';
        const tx = document.createElement('span');
        tx.textContent = official(fill(a.t, vars));
        b.appendChild(tx);
        const chips = document.createElement('span');
        chips.className = 'chips';
        const tone = document.createElement('i');
        tone.className = 'tone ' + toneOf(a);
        tone.textContent = TONE_LABEL[toneOf(a)];
        chips.appendChild(tone);
        if (a.fine) { const f = document.createElement('i'); f.className = 'tone fine'; f.textContent = 'Fine'; chips.appendChild(f); }
        b.appendChild(chips);
        scope.on(b, 'click', () => onPick(a, b));
        return b;
      };
      const askedBy = (j) => {
        this.asker = j;
        this.answered = false;
        $('#pressJourno').textContent = j.outlet;
        $('#pressJourno').title = j.name;
      };
      // The whole press room fits the screen without scrolling: if it would not, it tightens up in two steps
      const fit = () => {
        const p = $('#press .press-panel');
        p.classList.remove('fit1', 'fit2');
        if (p.scrollHeight > p.clientHeight) p.classList.add('fit1');
        if (p.scrollHeight > p.clientHeight) p.classList.add('fit2');
      };
      scope.on(window, 'resize', fit);
      const show = () => {
        const q = qs[qi];
        askedBy(pack[(start + qi) % pack.length]);
        $('#pressQuestion').textContent = official(fill(q.q, vars));
        $('#pressHeadline').classList.add('hidden');
        $('#btnPressNext').classList.add('hidden');
        $('#btnPressLeave').classList.add('hidden');
        $('#btnPressMenu').classList.add('hidden');
        const box = $('#pressAnswers');
        box.innerHTML = '';
        box.classList.remove('done');
        q.a.forEach((a) => box.appendChild(answerButton(a, answer)));
        replayEnter(box);
        // A tap that brought you here must not land on an answer that has just appeared under the finger
        this.askT = performance.now();
        fit();
      };
      // The room's reaction, and the photographers
      const react = (a) => {
        const tone = toneOf(a);
        this.react = { kind: tone === 'charming' ? 'laugh' : tone === 'spicy' ? 'gasp' : 'scribble', t: this.t };
        if (tone === 'spicy' && !reduceMotion) for (let i = 0; i < 6; i++) this.flash.push({ x: Math.random(), y: 0.6 + Math.random() * 0.3, t: -i * 0.07 });
      };
      // A follow-up from the same journalist: the press smell a story
      const followUp = (a) => {
        if (this.followed) return null;
        const tone = toneOf(a);
        if (tone === 'spicy' && Math.random() < 0.6) return pick(FOLLOW_UPS.spicy);
        if (tone === 'charming' && a.rep >= 8 && Math.random() < 0.35) return pick(FOLLOW_UPS.charming);
        return null;
      };
      const answer = (a, btn, isFollow) => {
        if (btn.disabled || performance.now() - (this.askT || 0) < 500) return;
        $('#pressAnswers').querySelectorAll('button').forEach((b) => { b.disabled = true; });
        btn.classList.add('picked');
        this.answered = true;
        react(a);
        if (!isFollow) this.stories.push({ h: official(fill(a.h, vars)), rep: a.rep, journo: this.asker });
        else if (a.exclusive) { this.exclusive = true; this.stories[this.stories.length - 1].exclusive = true; }
        const fu = !isFollow ? followUp(a) : null;
        const before = sponsorKit().sponsor;
        SAVE.reputationScore = clamp(SAVE.reputationScore + a.rep, -100, 100);
        const after = sponsorKit().sponsor;
        this.mood = a.rep >= 5 ? 'nice' : a.rep <= -5 ? 'villain' : 'neutral';
        let fineAmt = 0;
        if (a.fine) {
          fineAmt = Math.round(tier.fine * a.fine);
          SAVE.totalFines += fineAmt;
          SAVE.prizeMoney = Math.max(0, SAVE.prizeMoney - fineAmt);
        }
        if (SAVE.reputationScore <= -60) unlock('villain');
        if (SAVE.reputationScore >= 60) unlock('darling');
        persist();
        if (a.rep >= 5) sfx('applause', { power: 0.5 }); else if (a.rep <= -5) sfx('boo'); else sfx('ooh');
        if (fu) {
          // The same journalist presses for more
          this.followed = true;
          scope.timeout(() => {
            this.answered = false;
            $('#pressQuestion').textContent = fu.q;
            const box = $('#pressAnswers');
            box.innerHTML = '';
            box.classList.remove('done');
            fu.a.forEach((fa) => box.appendChild(answerButton(fa, (x, b) => answer(x, b, true))));
            replayEnter(box);
            this.askT = performance.now();
            fit();
          }, 900);
          return;
        }
        // Only your answer stays, so the headline and the button fit on a phone screen
        $('#pressAnswers').classList.add('done');
        const story = this.stories[this.stories.length - 1];
        const h = $('#pressHeadline');
        h.innerHTML = '';
        h.appendChild(document.createTextNode((this.exclusive && isFollow ? 'EXCLUSIVE: ' : '') + story.h));
        const sm = document.createElement('small');
        sm.textContent = (a.rep > 0 ? 'Fan Favourite +' + a.rep : a.rep < 0 ? 'Crowd Villain +' + (-a.rep) : 'Reputation unchanged') + (isFollow ? ' on the follow-up'  : '') + (fineAmt ? '. Fined ' + money(fineAmt) + ' for conduct.' : '.') + ' Now: ' + repLabel(SAVE.reputationScore) + '.';
        if (after !== before) sm.textContent += ' ' + before + ' have dropped you. ' + after + ' are your new sponsor.';
        h.appendChild(sm);
        h.classList.remove('hidden');
        const next = $('#btnPressNext');
        const lastQ = qi >= qs.length - 1;
        next.textContent = !lastQ ? 'Next Question' : SAVE.settings.short ? (res.final ? 'Back to the Tour' : 'Next Match') : 'Read Tomorrow\'s Paper';
        next.classList.remove('hidden');
        // A way out to the tour at any point, unless the main button already goes there
        $('#btnPressLeave').classList.toggle('hidden', lastQ && SAVE.settings.short && !!res.final);
        $('#btnPressMenu').classList.remove('hidden');
        fit();
        // If the screen is so small the panel still scrolls, bring the button into view
        requestAnimationFrame(() => { try { next.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }); } catch (e) { next.scrollIntoView(false); } });
      };
      const leave = () => {
        $('#paperModal').classList.add('hidden');
        $('#ceremonyModal').classList.add('hidden');
        if (res.final && window.RRCG) RRCG.happytime();
        if (res.final && SAVE.careerComplete && res.cfg.tierIdx === TIERS.length - 1) {
          FSM.change('GAME_OVER', { kind: 'careerWon', result: res });
        } else if (res.final) {
          FSM.change('CAREER_HUB', { toast: tier.trophy + ' added to the cabinet. Next stop: ' + TIERS[SAVE.careerTier].short + '.' });
        } else {
          FSM.change('CAREER_HUB', { toast: 'Through to the ' + ROUNDS[SAVE.tournamentRound] + '. ' + SAVE.remainingRackets + ' racket' + (SAVE.remainingRackets === 1 ? '' : 's') + ' left in the bag.' });
        }
      };
      // Straight on to the next round's walk-on, skipping the career screen
      const nextMatch = () => {
        $('#paperModal').classList.add('hidden');
        newMatch(careerMatchConfig());
        FSM.change('MATCH_PLAY', { fresh: true });
      };
      this.nextMatch = nextMatch;
      $('#btnPaperNext').classList.toggle('hidden', !!res.final);
      scope.on($('#btnPaperNext'), 'click', () => { sfx('click'); nextMatch(); });
      scope.on($('#btnPressNext'), 'click', () => {
        sfx('click');
        qi++;
        if (qi < qs.length) { show(); return; }
        if (SAVE.settings.short) { if (res.final) leave(); else nextMatch(); return; }
        // Tomorrow's paper: the biggest story leads, the other goes underneath
        const sorted = this.stories.slice().sort((x, y) => Math.abs(y.rep) - Math.abs(x.rep));
        // An exclusive always leads; otherwise the biggest story does
        this.lead = this.stories.find((x) => x.exclusive) || sorted[0];
        this.second = this.stories.find((x) => x !== this.lead) || null;
        const page = buildFrontPage(this);
        this.page = page;
        $('#paperImg').src = page.toDataURL('image/png');
        $('#paperModal').classList.remove('hidden');
        sfx('whoosh', { power: 0.6 });
      });
      scope.on($('#btnPaperShare'), 'click', () => { sfx('click'); shareCanvas(this.page, this.lead.journo.outlet + ': ' + this.lead.h + ' | Racket Rage Tennis', 'racket-rage-front-page.png'); });
      scope.on($('#btnPaperLeave'), 'click', () => { sfx('click'); leave(); });
      scope.on($('#btnPressLeave'), 'click', () => { sfx('click'); leave(); });
      // Straight to the title screen; winning the whole tour still gets its own screen first
      scope.on($('#btnPressMenu'), 'click', () => {
        sfx('click');
        if (res.final && SAVE.careerComplete && res.cfg.tierIdx === TIERS.length - 1) { leave(); return; }
        $('#paperModal').classList.add('hidden');
        $('#ceremonyModal').classList.add('hidden');
        FSM.change('MENU');
      });
      show();
      // Again once the fonts and the payout have settled
      scope.timeout(fit, 400);
    }
  };

  /* ---------- GAME_OVER ---------- */
  const OVER_COPY = {
    eliminated: { title: 'KNOCKED OUT', kicker: 'Eliminated', lines: ['Beaten in the {round}. Your bag has been restocked. Your dignity is on back order.', 'Out in the {round}. You shook hands like you were trying to break theirs.', 'Knocked out in the {round}. The car park is this way, past the people who saw it.'] },
    forfeit: { title: 'FORFEIT', kicker: 'No rackets remain', lines: ['You ran out of rackets before you ran out of temper. The crowd applauded, mainly the ending.', 'Forfeited for want of equipment. You have been asked to stop calling the stringer.'] },
    royal: { title: 'ROYAL BOX INCIDENT', kicker: 'Defaulted for unsportsmanlike conduct', lines: ['Your racket was last seen in the Royal Box, beside a scone it ruined. You have been defaulted, fined, and asked to leave the county. Odds of that: 1 in {odds}.', 'Defaulted. The Royal Box would like your address, so it can return the racket and send a bill for the hat. Odds of that: 1 in {odds}.'] },
    default: { title: 'DEFAULTED', kicker: 'Four code violations', lines: ['The umpire has removed you from the match, the venue and the Christmas card list.', 'Defaulted. The umpire climbed down from the chair just to watch you leave.'] },
    retired: { title: 'RETIRED HURT', kicker: 'Injury: mostly pride', lines: ['You retired with an injury the physio has described as largely emotional.', 'Retired hurt. The hurt is in the ego, which is not covered by insurance.'] },
    careerWon: { title: 'GRAND SLAM CHAMPION', kicker: 'The Wimbleford Cup is yours', lines: ['The trophy is engraved, the rackets are buried, and the fines are on direct debit.', 'Champion of the Grudge Tour. The sport is delighted. The sport is also relieved.'] },
    dailyWin: { title: 'MELTDOWN SURVIVED', kicker: 'Daily Meltdown', lines: ['You won today\'s match. Tell the group chat, but humbly. No, more humbly than that.', 'A win. The rackets that survived are in shock.'] },
    quickWin: { title: 'QUICK WIN', kicker: 'Quick Match', lines: ['A short one, a win, no paperwork. Back in the car before the traffic.', 'A quick one, and a win. The rackets barely noticed.'] },
    quickLoss: { title: 'QUICK LOSS', kicker: 'Quick Match', lines: ['Not long enough to settle in. Long enough to lose.', 'Beaten in a hurry. At least it was quick.'] },
    firstWin: { title: 'FIRST WIN', kicker: 'Your First Match', lines: ['You beat {opp}. The council courts have never seen anything like it. They have, but be nice.', 'A win, first time out. {opp} is blaming the wind. There was no wind.'] },
    firstLoss: { title: 'BEATEN', kicker: 'Your First Match', lines: ['{opp} won this one. The Grudge Tour is where you get even.', 'Beaten by {opp}. Remember the name. The Grudge Tour will.'] },
    dailyLoss: { title: 'MELTDOWN LOST', kicker: 'Daily Meltdown', lines: ['Beaten today. A new meltdown at midnight, if you can bear it.', 'A loss. Share it anyway. Honesty is very fashionable.'] }
  };

  function scorecardText(kind, res) {
    const date = prettyDate(res.cfg.mode === 'daily' ? res.cfg.dateKey : dateKey());
    let label;
    if (res.reason === 'royal') label = (res.cfg.mode === 'daily' ? 'Daily Meltdown' : res.cfg.label) + ' ' + INCIDENTS[res.incident || 'royal'].title.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
    else if (res.cfg.mode === 'daily') label = 'Daily Meltdown ' + (res.won ? 'Win' : 'Loss') + ' ' + res.score;
    else if (res.cfg.mode === 'quick') label = 'Quick Match ' + (res.won ? 'Win' : 'Loss') + ' ' + res.score + ' vs ' + res.cfg.opp.name;
    else label = res.cfg.label + ' ' + (res.won ? 'Win' : kind === 'forfeit' ? 'Forfeit' : kind === 'default' ? 'Default' : 'Loss') + ' ' + res.score + ' vs ' + res.cfg.opp.name;
    const tour = res.cfg.mode !== 'daily' && res.tournamentSmashed !== undefined;
    const smashed = tour ? res.tournamentSmashed : res.smashed;
    const fines = tour && res.tournamentFines !== undefined ? res.tournamentFines : res.fines;
    let text = 'Racket Rage Tennis ' + date + ' | ' + label + ' | ' + (tour ? 'Tournament: ' : '') + smashed + ' Racket' + (smashed === 1 ? '' : 's') + ' Smashed' + (tour ? ', ' : ' | ') + money(fines) + ' In Fines';
    if (res.cfg.diff === 'hard') text += ' | Hard mode';
    if (res.cfg.mode === 'daily' && res.official) text += ' | Streak ' + SAVE.dailyStreak;
    // One face per game, from calm to meltdown
    if (res.cfg.mode === 'daily' && res.rageStrip && res.rageStrip.length) text += '\n' + res.rageStrip.map((k) => ['', '\u{1F60C}', '\u{1F624}', '\u{1F621}', '\u{1F92F}'][k]).join('') + ' my rage, game by game';
    if (isPro()) text += ' | Supporter';
    return text;
  }

  async function shareText(text) {
    const Cap = window.Capacitor;
    try {
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Share) {
        await Cap.Plugins.Share.share({ text: text, dialogTitle: 'Share your shame' });
        return;
      }
    } catch (e) { /* fall through to the web paths */ }
    if (navigator.share) {
      try {
        await navigator.share({ text: text });
        toast('Shared. The group chat has been informed.');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Scorecard copied. Paste it in the group chat and await judgement.');
      return;
    } catch (e) { /* try the old way */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast('Scorecard copied. Paste it in the group chat and await judgement.'); return; }
    } catch (e) { /* ignore */ }
    toast('Could not copy. Press and hold the scorecard to copy it by hand.');
  }

  FSM.states.GAME_OVER = {
    screen: 'over',
    enter(p, scope) {
      const res = p.result;
      let kind = p.kind;
      if (res.reason === 'royal') kind = 'royal';
      else if (kind === 'daily') kind = res.won ? 'dailyWin' : 'dailyLoss';
      else if (kind === 'quick' && res.cfg.first) kind = res.won ? 'firstWin' : 'firstLoss';
      else if (kind === 'quick') kind = res.won ? 'quickWin' : 'quickLoss';
      const first = !!res.cfg.first;
      let c = OVER_COPY[kind] || OVER_COPY.eliminated;
      if (kind === 'royal') { const I = INCIDENTS[res.incident || 'royal']; c = { title: I.title, kicker: c.kicker, lines: I.over }; }
      $('#overKicker').textContent = c.kicker + (res.cfg.mode === 'career' ? '. ' + res.cfg.label : '');
      $('#overTitle').textContent = c.title;
      // The verdict is stamped on in place of the heading: a fanfare and confetti for a win, the sad trombone otherwise
      $('#overTitle').classList.add('hidden');
      const win = kind === 'careerWon' || kind === 'dailyWin' || kind === 'quickWin' || kind === 'firstWin';
      $('#overStamp').textContent = '';
      setTimeout(() => resultStamp($('#overStamp'), c.title.replace(/[!.?]*$/, '!'), win), 250);
      $('#overLine').textContent = fill(pick(c.lines), { round: ROUNDS[res.cfg.round || 0], odds: res.royalOdds, opp: res.cfg.opp.name }) +
        (first ? ' Next: make your player and enter the Grudge Tour. Five tiers, one temper.' : '') +
        (res.cfg.mode === 'daily' && res.official && res.rank ? ' Clubhouse table: ' + res.points + ' points, ' + ordinal(res.rank) + ' of ' + res.of + '.' : '') +
        (res.cfg.mode === 'daily' && res.official ? ' ' + tomorrowLine() : '');
      // Four numbers, one row. The scorecard you share carries the rest.
      const stats = [
        ['Score', res.score],
        ['Smashed', res.smashed],
        ['Peak rage', Math.round(res.peakRage * 100) + '%'],
        res.cfg.mode === 'daily' ? ['Daily streak', SAVE.dailyStreak] : ['Fines paid', (res.finesPaid ? '-' : '') + money(res.finesPaid || 0)],
        ['Perfect hits', res.stats.shots ? perfectPct(res.stats) + '%' : '-'],
        ['Winners', res.stats.winners || 0],
        ['Lines painted', res.stats.lines || 0],
        ['Top shot', favouriteShot(res.stats)]
      ];
      const grid = $('#overStats');
      grid.innerHTML = '';
      stats.forEach((s) => {
        const d = document.createElement('div');
        d.innerHTML = '<small></small><b></b>';
        d.querySelector('small').textContent = s[0];
        d.querySelector('b').textContent = String(s[1]);
        grid.appendChild(d);
      });
      const isDaily = res.cfg.mode === 'daily' || res.cfg.mode === 'quick';
      $('#overWinnings').textContent = isDaily ? 'Winnings: ' + money(0) : '';
      if (isDaily && res.winnings) setTimeout(() => countUp($('#overWinnings'), res.winnings, (v) => 'Winnings: ' + money(v)), 500);
      $('#btnOverDouble').classList.remove('hidden');
      offerDoubler(scope, $('#overDoubleRow'), $('#btnOverDouble'), $('#overDoubleMsg'), isDaily && res.official && res.won ? res.winnings : 0, 'Winnings');
      if (isDaily && !(res.official && res.won)) $('#overDoubleRow').classList.toggle('hidden', !res.winnings);
      if (isDaily && !(res.official && res.won)) $('#btnOverDouble').classList.add('hidden');
      if (res.cfg.mode === 'quick') { $('#overDoubleRow').classList.toggle('hidden', !res.winnings); $('#btnOverDouble').classList.add('hidden'); }
      if (!(res.cfg.mode === 'daily' && res.official && res.won) && res.finesPaid > 0 && adOk() && (SAVE.lossRun || 0) < 2) {
        $('#btnOverDouble').classList.remove('hidden');
        offerDoubler(scope, $('#overDoubleRow'), $('#btnOverDouble'), $('#overDoubleMsg'), res.finesPaid, 'Fines', null, {
          btn: 'Sponsor Pays Your Fines: Watch an Advert',
          retry: 'Try the Advert Again',
          done: (amt) => 'Your sponsor paid ' + money(amt) + ' of fines. They would like a quiet word.',
          toast: (amt) => 'Fines covered. ' + money(amt) + ' back in your prize money.'
        });
      }
      const card = scorecardText(p.kind, res);
      $('#overCard').textContent = card + (res.cfg.mode === 'daily' && !res.official ? '\n(Practice replay. Today\'s official result stands.)' : '');
      const main = $('#btnOverMain');
      if (res.cfg.mode === 'daily') main.textContent = 'Practice Again';
      else if (first) main.textContent = 'Make Your Player';
      else if (res.cfg.mode === 'quick') main.textContent = 'Play Again';
      else if (kind === 'careerWon') main.textContent = 'Trophy Cabinet';
      else main.textContent = 'Re-enter';
      // One clear next step after the first match: no share button competing with it
      $('#btnShare').classList.toggle('hidden', first);
      sfx(res.won ? 'applause' : 'ooh', { power: 1 });
      if (kind === 'quickWin' || kind === 'dailyWin' || kind === 'careerWon') maybeAskReview(res);
      scope.on($('#btnShare'), 'click', () => { sfx('click'); shareText(card); });
      const tb = $('#btnTantrum');
      tb.classList.toggle('hidden', !res.tantrum);
      if (res.tantrum) {
        tb.textContent = res.tantrum.highlight ? 'Share Highlight' : res.tantrum.theirs ? 'Share Their Tantrum' : 'Share Your Tantrum';
        scope.on(tb, 'click', () => { sfx('click'); shareTantrum(res.tantrum, card); });
      }
      scope.on(main, 'click', () => {
        sfx('click');
        if (first) {
          FSM.change('LOCKER_ROOM', { from: 'CAREER_HUB', create: true, toastNext: 'Welcome to the Grudge Tour. Five tiers, one temper. It starts behind the tea hut.' });
          return;
        }
        if (res.cfg.mode === 'daily') {
          newMatch(dailyConfig(dateKey()));
          FSM.change('MATCH_PLAY', { fresh: true });
        } else if (res.cfg.mode === 'quick') {
          newMatch(quickConfig());
          FSM.change('MATCH_PLAY', { fresh: true });
        } else FSM.change('CAREER_HUB');
      });
      scope.on($('#btnOverMenu'), 'click', () => { sfx('click'); FSM.change('MENU'); });
    }
  };

  /* ---------- INTRO: the game's own opening. You, one racket, no perspective. ---------- */
  // Runs after the studio splash and before the title screen. Tap or a key skips it.
  const INTRO_LEN = 3.6;
  FSM.states.INTRO = {
    screen: null,
    enter(p, scope) {
      this.t = 0;
      this.t0 = performance.now();   // wall clock, so the intro lasts the same however the frames arrive
      this.done = false;
      this.impact = false;
      this.shards = [];
      this.stamped = false;
      this.short = reduceMotion;
      this.cues = this.short ? [] : [
        { t: 0.12, name: 'scream' },
        { t: 0.6, name: 'whoosh', opts: { power: 1.2 } }
      ];
      // Sound may stay silent until the first tap, depending on the WebView's autoplay rules
      window.RRAudio && RRAudio.init();
      window.RRAudio && RRAudio.setMuted(SAVE.settings.muted);
      const skip = (e) => {
        if (e) e.preventDefault();
        window.RRAudio && RRAudio.resume();
        if (this.t > 0.25) this.finish();
      };
      scope.on(canvas, 'pointerdown', skip);
      scope.on(window, 'keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') skip(e); });
    },
    finish() {
      if (this.done) return;
      this.done = true;
      FSM.change('MENU');
    },
    update(dt) {
      this.t = (performance.now() - this.t0) / 1000;
      this.shards.forEach((p) => { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; });
      while (this.cues.length && this.t >= this.cues[0].t) { const c = this.cues.shift(); sfx(c.name, c.opts || {}); }
      if (!this.short && !this.impact && this.t >= SMASH_T) {
        this.impact = true;
        sfx('frame');
        sfx('crunch');
        sfx('gasp');
        vibrate([80, 40, 120]);
        const col = playerKit().racket;
        for (let i = 0; i < 26; i++) {
          const a = -Math.PI * Math.random();
          const v = 200 + Math.random() * 460;
          this.shards.push({ x: PX + 0.62 * KP, y: FLOOR_Y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 1100, t: 0, life: 1.6, r: 3 + Math.random() * 8, spin: (Math.random() - 0.5) * 20, color: Math.random() < 0.6 ? col : '#222' });
        }
      }
      if (!this.short && !this.stamped && this.t >= 1.55) { this.stamped = true; sfx('hit', { power: 1.5 }); sfx('applause', { power: 0.8 }); }
      if (this.t >= (this.short ? 1.2 : INTRO_LEN)) this.finish();
    },
    render(ctx) {
      const t = this.t;
      // Stadium at night: dark stand, a spotlight, a strip of grass with a baseline
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0b1a10');
      bg.addColorStop(0.62, '#173a24');
      bg.addColorStop(0.62, '#2f6b3a');
      bg.addColorStop(1, '#245a2f');
      ctx.fillStyle = bg;
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
      const spot = ctx.createRadialGradient(470, 430, 40, 470, 430, 520);
      spot.addColorStop(0, 'rgba(255,250,220,0.22)');
      spot.addColorStop(1, 'rgba(255,250,220,0)');
      ctx.fillStyle = spot;
      ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
      ctx.fillStyle = '#f4f4ee';
      ctx.fillRect(-BX, 655, W + 2 * BX, 6);
      // Shake at the impact and at the title stamp
      const shake = reduceMotion ? 0 : Math.max(0, 1 - Math.abs(t - SMASH_T) * 8) * 10 + Math.max(0, 1 - Math.abs(t - 1.6) * 8) * 6;
      ctx.save();
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      // You, mid tantrum (the reduced motion version shows the aftermath as a still)
      const poseT = this.short ? SMASH_T + 1.2 : t;
      ctx.save();
      ctx.translate(440, 655);
      ctx.scale(1.08, 1.08);
      ctx.translate(-PX, -FLOOR_Y);
      renderRoutine(ctx, poseT, 'spike', playerKit(), [], this.shards);
      ctx.restore();
      // The title stamps in, one word at a time
      const words = [['RACKET', '#f4f1e6', 110], ['RAGE', '#ff3b30', 150], ['TENNIS', '#d9f24a', 100]];
      words.forEach((w, i) => {
        const start = this.short ? 0 : 1.5 + i * 0.12;
        const k = clamp((t - start) / 0.22, 0, 1);
        if (k <= 0) return;
        const pop = this.short ? 1 : k < 1 ? 1.6 - 0.6 * easeOut(k) : 1;
        const y = 230 + i * 140;
        ctx.save();
        ctx.translate(930 + (i === 1 && !reduceMotion ? Math.sin(t * 40) * 3 : 0), y);
        ctx.rotate(-0.05);
        ctx.scale(pop, pop);
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.font = w[2] + 'px Impact, "Arial Black", sans-serif';   // the logo keeps its own lettering
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 12;
        ctx.strokeStyle = '#0b1a10';
        ctx.strokeText(w[0], 0, 0);
        ctx.fillStyle = w[1];
        ctx.fillText(w[0], 0, 0);
        ctx.restore();
      });
      ctx.restore();
      if (this.short || t > 2.3) {
        ctx.globalAlpha = this.short ? 1 : Math.min(1, (t - 2.3) * 3);
        ctx.font = 'bold 26px "Trebuchet MS", sans-serif';
        ctx.fillStyle = '#f4f1e6';
        ctx.textAlign = 'center';
        ctx.fillText('Five rackets. One temper. No refunds.', 930, 640);
        ctx.globalAlpha = 1;
      }
      if (!this.short && t > 0.3) {
        ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
        ctx.fillStyle = 'rgba(244,241,230,0.5)';
        ctx.textAlign = 'right';
        ctx.fillText(ctl('skip'), W - 24, H - 20);
      }
      // Fade out into the title screen
      const end = this.short ? 1.2 : INTRO_LEN;
      if (t > end - 0.3) {
        ctx.fillStyle = 'rgba(16,38,26,' + clamp((t - (end - 0.3)) / 0.3, 0, 1).toFixed(2) + ')';
        ctx.fillRect(-BX, -BY, W + 2 * BX, H + 2 * BY);
      }
    }
  };

  /* =====================================================================
     9. Daily Meltdown
     ===================================================================== */
  // Everything that matters is fixed for 24 hours by the device date (YYYY-MM-DD).
  // A Daily Meltdown score: winning, games, winners and aces, less smashed rackets and code violations
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function dailyPoints(won, games, stats, smashed, violations) {
    return Math.max(0, (won ? 500 : 0) + games * 80 + stats.winners * 15 + stats.aces * 20 - smashed * 120 - violations * 40);
  }
  // The clubhouse regulars: fictional members whose scores for the day come from the date, the same for everyone
  const REGULARS = ['Big Keith', 'Dr Okonjo', 'Mrs Penhaligon\'s Nephew', 'The Vicar', 'Two Rackets Terry', 'Fenella from Accounts', 'Young Dominic', 'The Brigadier', 'Sandra (Ladies Captain)', 'Mo from the Car Park'];
  function clubhouseTable(key, mine) {
    const r = makeLCG(fnv1a('racket-rage-regulars:' + key));
    const pool = REGULARS.slice();
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const name = pool.splice(Math.floor(r() * pool.length), 1)[0];
      rows.push({ name: name, pts: Math.round(r.range(180, 1150) / 5) * 5 });
    }
    if (mine !== null && mine !== undefined) rows.push({ name: 'You', pts: mine, you: true });
    rows.sort((a, b) => b.pts - a.pts);
    return rows;
  }
  function fillClubhouse(el, key) {
    const mine = SAVE.lastDaily && SAVE.lastDaily.date === key && SAVE.lastDaily.points !== undefined ? SAVE.lastDaily.points : null;
    el.innerHTML = '';
    clubhouseTable(key, mine).forEach((row, i) => {
      const li = document.createElement('li');
      if (row.you) li.className = 'you';
      const n = document.createElement('span');
      n.textContent = (i + 1) + '. ' + row.name;
      const p = document.createElement('b');
      p.textContent = row.pts;
      li.appendChild(n);
      li.appendChild(p);
      el.appendChild(li);
    });
    return mine;
  }
  const DAILY_TWISTS = [
    { id: 'gale', name: 'Gale Warning', line: 'A howling wind. Aim into it.', apply: (cfg) => { if (cfg.surface === 'indoor') cfg.surface = 'hard'; cfg.wind = (cfg.wind < 0 ? -1 : 1) * 24; } },
    { id: 'last', name: 'Last Racket Standing', line: 'One racket in the bag. Break it and you are out.', apply: (cfg) => { cfg.rackets = 1; cfg.maxRackets = 1; cfg.noSpare = true; } },
    { id: 'strict', name: 'The Strictest Umpire in England', line: 'Every mutter is a code violation waiting to happen.', apply: (cfg) => { cfg.strict = 0.95; } },
    { id: 'sudden', name: 'Sudden Death', line: 'First to 3 games, win by 2. No time to warm up.', apply: (cfg) => { cfg.games = 3; } },
    { id: 'clay', name: 'Clay Day', line: 'Slow and high. Bring patience and spare socks.', apply: (cfg) => { cfg.surface = 'clay'; } },
    { id: 'grass', name: 'Lawn Day', line: 'Fast, low and slippery. Slice skids.', apply: (cfg) => { cfg.surface = 'grass'; } },
    { id: 'wound', name: 'Wound Up', line: 'Your opponent arrives already furious.', apply: (cfg) => { cfg.oppTemperStart = 0.6; } },
    { id: 'calm', name: 'Calm Before the Storm', line: 'No wind, a lenient official, and no excuses.', apply: (cfg) => { cfg.wind = 0; cfg.strict = 0.15; } }
  ];
  function dailyTwist(key) { return DAILY_TWISTS[fnv1a('twist:' + key) % DAILY_TWISTS.length]; }
  function dailyConfig(key) {
    const r = makeLCG(fnv1a('racket-rage:' + key));
    const traitsPool = ['cheat', 'grunter', 'timewaster'];
    const first = r.pick(traitsPool);
    const traits = [first];
    if (r() < 0.45) {
      const second = r.pick(traitsPool.filter((t) => t !== first));
      traits.push(second);
    }
    const skill = Math.round(r.range(0.3, 0.85) * 100) / 100;
    const strict = Math.round(r.range(0.15, 0.9) * 100) / 100;
    const wind = Math.round(r.range(0, 24)) * (r() < 0.5 ? -1 : 1);
    const rackets = r.int(2, 5);
    const tierIdx = r.int(1, 4);
    const tier = TIERS[tierIdx];
    const surfaces = ['grass', 'hard', 'clay', 'indoor'];
    const surface = r.pick(surfaces);
    const opp = {
      name: r.pick(DAILY_FIRST) + ' ' + r.pick(DAILY_LAST),
      traits: traits,
      skill: skill,
      shirt: r.pick(SHIRTS),
      face: r.pick(FACES),
      band: r.pick(['#ffffff', '#ff3b30', '#d9f24a', '#1f3a6b']),
      hair: r.pick(['#2b1b12', '#9a9a9a', '#d9b25c', '#141414', '#7a4a28']),
      pitch: r.int(110, 240)
    };
    const cfg = {
      mode: 'daily',
      dateKey: key,
      tierIdx: tierIdx,
      round: 0,
      label: 'Daily Meltdown',
      surface: surface,
      games: 4,
      opp: opp,
      skill: skill,
      strict: strict,
      ref: r.pick(['Mrs Penhaligon', 'Mr Dobbs', 'Ms Grieve', 'Mr Ashdown', 'Mr Featherstonehaugh']),
      cheatRate: 0.4 + r() * 0.3,
      wind: surface === 'indoor' ? 0 : wind,
      fine: ECON.dailyFine,
      rackets: rackets,
      maxRackets: rackets,
      crowd: 0.7,
      seed: r.int(1, 2147483646)
    };
    if (cfg.mode === 'daily') {
      const tw = dailyTwist(key);
      tw.apply(cfg);
      cfg.twist = { name: tw.name, line: tw.line };
    }
    if (callMode(cfg) !== 'players' && traits.indexOf('cheat') >= 0) {
      const swap = ['grunter', 'timewaster'].find((t) => traits.indexOf(t) < 0);
      if (swap) traits[traits.indexOf('cheat')] = swap; else traits.splice(traits.indexOf('cheat'), 1);
    }
    return cfg;
  }

  /* =====================================================================
     10. Boot
     ===================================================================== */
  let reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }

  let last = performance.now();
  let debugSpeed = 1;
  const BUILD = 'Web 22 Oct 12:12';
  const FPS = { on: false, gap: 16.7, work: 0, n: 0, maxCur: 0, worst: 0, winT: 0, hitches: [] };
  // The screen's refresh period (the shortest gap between frames, drifting up slowly), and whether frames are
  // locked to 60. An uneven mix of 120 Hz and 60 Hz frames looks choppier than a steady 60.
  const PACE = { period: 16.7, avg: 16.7, n: 0, lock: false, rafLast: 0, off: false };
  function frame(now) {
    const raw = now - (PACE.rafLast || now - 16.7);
    PACE.rafLast = now;
    if (raw > 3) PACE.period = raw < PACE.period ? (raw + PACE.period) / 2 : PACE.period + (Math.min(raw, 40) - PACE.period) * 0.002;
    if (PACE.lock && now - last < 16.67 - PACE.period * 0.5) { requestAnimationFrame(frame); return; }
    const gapMs = now - last;
    const dt = Math.min(0.05, gapMs / 1000);
    last = now;
    const t0 = FPS.on ? performance.now() : 0;
    const st = FSM.state;
    const steps = Math.max(1, Math.min(20, debugSpeed | 0));
    for (let i = 0; i < steps && FSM.state === st; i++) if (st && st.update) st.update(dt);
    if (st && st.render) {
      g.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
      st.render(g);
    }
    PACE.avg += (gapMs - PACE.avg) * 0.05;
    if (!PACE.lock && !PACE.off && ++PACE.n > 180 && PACE.period < 9.5 && PACE.avg > 10.5) PACE.lock = true;
    if (FPS.on) {
      FPS.gap += (gapMs - FPS.gap) * 0.08;
      FPS.work += (performance.now() - t0 - FPS.work) * 0.08;
      // The worst frame in the last 2 seconds, and long frames (over 34 ms, two missed 60 Hz frames) in the last 10
      FPS.maxCur = Math.max(FPS.maxCur, gapMs);
      if (now - FPS.winT > 2000) { FPS.worst = FPS.maxCur; FPS.maxCur = 0; FPS.winT = now; }
      if (gapMs > 34) FPS.hitches.push(now);
      while (FPS.hitches.length && now - FPS.hitches[0] > 10000) FPS.hitches.shift();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const fs2 = Math.round(13 * Math.max(1, scale * 1.4));
      g.font = 'bold ' + fs2 + 'px monospace';
      const txt = Math.round(1000 / Math.max(1, FPS.gap)) + ' fps  ' + FPS.gap.toFixed(1) + ' ms  work ' + FPS.work.toFixed(1) + ' ms  worst ' + Math.round(FPS.worst) + ' ms  hitches ' + FPS.hitches.length + '  screen ' + Math.round(1000 / PACE.period) + ' Hz' + (PACE.lock ? ', held at 60' : '') + '  res ' + Math.min(window.devicePixelRatio || 1, RES.cap) + 'x' + (OUTLINE_OFF ? '  no outlines' : '');
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(0, 0, g.measureText(txt).width + fs2, fs2 * 1.6);
      g.fillStyle = FPS.gap > 25 ? '#ff6b5b' : '#d9f24a';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(txt, fs2 * 0.5, fs2 * 0.8);
    }
    requestAnimationFrame(frame);
  }

  // Cold Gravy studio splash. Nothing of the game (loop, intro, title, sound, ads, consent, keys,
  // back button) starts until it has finished. The fallback covers a missing splash file.
  const splashDone = (window.ColdGravySplash && ColdGravySplash.done) || Promise.resolve();
  let splashFinished = false;

  /* ---- Menu backgrounds: the players' tunnel (career hub), the locker room, the stadium at dusk (results) ---- */
  function menuCanvas() {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    return c;
  }
  // A wall panel in perspective: the strip of a wall between two depths, as a skewed rectangle
  function paintTunnel() {
    const c = menuCanvas();
    const g = c.getContext('2d');
    const vx = 640;
    const ox0 = 470;
    const ox1 = 810;
    const oy0 = 210;
    const oy1 = 440;
    // At depth t (0 at the screen edge, 1 at the opening), where the walls, ceiling and floor are
    const L = (t) => lerp(0, ox0, t);
    const R = (t) => lerp(1280, ox1, t);
    const T = (t) => lerp(0, oy0, t);
    const B = (t) => lerp(720, oy1, t);
    // The opening: sky, the far stand, the court in the light
    const sky = g.createLinearGradient(0, oy0, 0, oy1);
    sky.addColorStop(0, '#bfe0f5');
    sky.addColorStop(0.35, '#e9f4e8');
    sky.addColorStop(0.36, '#2f6b45');
    sky.addColorStop(0.6, '#3d8a4e');
    sky.addColorStop(1, '#58a85e');
    g.fillStyle = sky;
    g.fillRect(ox0, oy0, ox1 - ox0, oy1 - oy0);
    const rng = makeLCG(99);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = ['#f4f1e6', '#c8102e', '#1f3a6b', '#f2c14e', '#e8d9b5'][Math.floor(rng() * 5)];
      g.fillRect(ox0 + rng() * (ox1 - ox0), oy0 + 30 + rng() * 45, 3, 3);
    }
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ox0 + 40, oy1 - 20);
    g.lineTo(ox0 + 110, oy0 + 120);
    g.lineTo(ox1 - 110, oy0 + 120);
    g.lineTo(ox1 - 40, oy1 - 20);
    g.moveTo(ox0 + 70, oy0 + 165);
    g.lineTo(ox1 - 70, oy0 + 165);
    g.stroke();
    g.fillStyle = 'rgba(20,20,20,0.55)';
    g.fillRect(ox0 + 80, oy0 + 150, ox1 - ox0 - 160, 14);
    // Light pouring in
    const glow = g.createRadialGradient(vx, (oy0 + oy1) / 2, 40, vx, (oy0 + oy1) / 2, 520);
    glow.addColorStop(0, 'rgba(255,250,225,0.5)');
    glow.addColorStop(1, 'rgba(255,250,225,0)');
    // Ceiling, walls, floor
    const poly = (pts, fill) => { g.fillStyle = fill; g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath(); g.fill(); };
    poly([[0, 0], [1280, 0], [ox1, oy0], [ox0, oy0]], '#1b201d');
    const wl = g.createLinearGradient(0, 0, ox0, 0);
    wl.addColorStop(0, '#141815');
    wl.addColorStop(1, '#3a423d');
    poly([[0, 0], [ox0, oy0], [ox0, oy1], [0, 720]], wl);
    const wr = g.createLinearGradient(1280, 0, ox1, 0);
    wr.addColorStop(0, '#141815');
    wr.addColorStop(1, '#3a423d');
    poly([[1280, 0], [ox1, oy0], [ox1, oy1], [1280, 720]], wr);
    poly([[0, 720], [1280, 720], [ox1, oy1], [ox0, oy1]], '#3b2d22');
    // A long green runner with gold edges up the middle of the floor
    poly([[vx - 260, 720], [vx + 260, 720], [vx + 70, oy1], [vx - 70, oy1]], '#1f4a33');
    g.strokeStyle = '#d4af37';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(vx - 240, 720);
    g.lineTo(vx - 64, oy1);
    g.moveTo(vx + 240, 720);
    g.lineTo(vx + 64, oy1);
    g.stroke();
    // Ceiling lights, nearer ones bigger
    for (let i = 0; i < 6; i++) {
      const t = 0.12 + i * 0.14;
      const y = T(t) + 6;
      const w = lerp(160, 40, t);
      g.fillStyle = 'rgba(255,248,220,0.92)';
      g.fillRect(vx - w / 2, y, w, lerp(10, 3, t));
      const lg = g.createRadialGradient(vx, y + 30, 5, vx, y + 30, lerp(160, 40, t));
      lg.addColorStop(0, 'rgba(255,240,200,0.18)');
      lg.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = lg;
      g.fillRect(vx - 200, y, 400, 220);
    }
    // Sponsor boards and champions' photos along the walls
    const ids = SPONSOR_ORDER;
    for (let i = 0; i < 3; i++) {
      const t0 = 0.08 + i * 0.27;
      const t1 = t0 + 0.17;
      [-1, 1].forEach((sd) => {
        const xa = sd < 0 ? L(t0) : R(t0);
        const xb = sd < 0 ? L(t1) : R(t1);
        const ya = lerp(T(t0), B(t0), 0.42);
        const yb = lerp(T(t1), B(t1), 0.42);
        const ha = (B(t0) - T(t0)) * 0.16;
        const hb = (B(t1) - T(t1)) * 0.16;
        const art = document.createElement('canvas');
        art.width = 300;
        art.height = 80;
        drawSponsorArt(art.getContext('2d'), ids[(i * 2 + (sd > 0 ? 1 : 0)) % ids.length], 0, 0, 300, 80);
        g.save();
        g.beginPath();
        g.moveTo(xa, ya);
        g.lineTo(xb, yb);
        g.lineTo(xb, yb + hb);
        g.lineTo(xa, ya + ha);
        g.closePath();
        g.clip();
        g.setTransform((xb - xa) / 300, (yb - ya) / 300, 0, (ha + hb) / 160, xa, ya);
        g.drawImage(art, 0, 0);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.restore();
        // A framed photo above
        const fa = lerp(T(t0), B(t0), 0.2);
        const fb = lerp(T(t1), B(t1), 0.2);
        const pa = (B(t0) - T(t0)) * 0.13;
        const pb = (B(t1) - T(t1)) * 0.13;
        const mx = (x) => lerp(xa, xb, x);
        const my = (x, d) => lerp(fa, fb, x) + lerp(pa, pb, x) * d;
        g.fillStyle = '#c9a24a';
        g.beginPath();
        g.moveTo(mx(0.25), my(0.25, 0));
        g.lineTo(mx(0.75), my(0.75, 0));
        g.lineTo(mx(0.75), my(0.75, 1));
        g.lineTo(mx(0.25), my(0.25, 1));
        g.closePath();
        g.fill();
        g.fillStyle = '#5f7f6a';
        g.beginPath();
        g.moveTo(mx(0.3), my(0.3, 0.15));
        g.lineTo(mx(0.7), my(0.7, 0.15));
        g.lineTo(mx(0.7), my(0.7, 0.85));
        g.lineTo(mx(0.3), my(0.3, 0.85));
        g.closePath();
        g.fill();
      });
    }
    g.fillStyle = glow;
    g.fillRect(0, 0, 1280, 720);
    // Tour banners hung on the near walls: on a wide phone these fill the strips beside the panels.
    // Same outlined sticker look as the menus: thick dark outline, club green, gold trim.
    [[58, 'ball'], [1222, 'trophy']].forEach((bn) => {
      const cx = bn[0];
      const w = 88;
      const top = 96;
      const bot = 560;
      const ol = '#06110a';
      // The rail and its finials
      g.fillStyle = '#c9a24a';
      g.strokeStyle = ol;
      g.lineWidth = 4;
      g.beginPath();
      g.roundRect ? g.roundRect(cx - w / 2 - 14, top - 12, w + 28, 10, 5) : g.rect(cx - w / 2 - 14, top - 12, w + 28, 10);
      g.fill();
      g.stroke();
      [-1, 1].forEach((sd) => { g.beginPath(); g.arc(cx + sd * (w / 2 + 16), top - 7, 8, 0, Math.PI * 2); g.fill(); g.stroke(); });
      // The cloth, with a swallowtail
      const cloth = () => {
        g.beginPath();
        g.moveTo(cx - w / 2, top - 4);
        g.lineTo(cx + w / 2, top - 4);
        g.lineTo(cx + w / 2, bot);
        g.lineTo(cx, bot - 34);
        g.lineTo(cx - w / 2, bot);
        g.closePath();
      };
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.save(); g.translate(6, 8); cloth(); g.fill(); g.restore();
      const cg = g.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
      cg.addColorStop(0, '#174030');
      cg.addColorStop(0.5, '#23603f');
      cg.addColorStop(1, '#174030');
      g.fillStyle = cg;
      cloth();
      g.fill();
      g.lineWidth = 5;
      g.stroke();
      // Gold trim inside the edge, and two bands
      g.strokeStyle = '#d4af37';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx - w / 2 + 9, top + 6);
      g.lineTo(cx + w / 2 - 9, top + 6);
      g.lineTo(cx + w / 2 - 9, bot - 14);
      g.lineTo(cx, bot - 44);
      g.lineTo(cx - w / 2 + 9, bot - 14);
      g.closePath();
      g.stroke();
      g.fillStyle = '#d4af37';
      g.fillRect(cx - w / 2 + 9, top + 300, w - 18, 8);
      g.fillRect(cx - w / 2 + 9, top + 318, w - 18, 3);
      // The crest: a tennis ball on the left, the Wimbledon Cup on the right
      const cy = top + 150;
      g.fillStyle = '#f4ecd2';
      g.strokeStyle = ol;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(cx, cy, 34, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (bn[1] === 'ball') {
        g.fillStyle = '#d9f24a';
        g.beginPath();
        g.arc(cx, cy, 24, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.strokeStyle = '#f4ecd2';
        g.lineWidth = 3;
        g.beginPath();
        g.arc(cx - 24, cy, 18, -0.9, 0.9);
        g.stroke();
        g.beginPath();
        g.arc(cx + 24, cy, 18, Math.PI - 0.9, Math.PI + 0.9);
        g.stroke();
      } else {
        drawTrophyShape(g, 4, cx, cy + 4, 0.36);
      }
      // Rackets crossed under the crest
      [-1, 1].forEach((sd) => {
        g.save();
        g.translate(cx, top + 245);
        g.rotate(sd * 0.55);
        g.strokeStyle = ol;
        g.lineWidth = 9;
        g.beginPath(); g.moveTo(0, 6); g.lineTo(0, 40); g.stroke();
        g.strokeStyle = '#8a5d33';
        g.lineWidth = 5;
        g.stroke();
        g.fillStyle = 'rgba(244,236,210,0.25)';
        g.strokeStyle = ol;
        g.lineWidth = 7;
        g.beginPath(); g.ellipse(0, -16, 13, 19, 0, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = '#f4ecd2';
        g.lineWidth = 3.5;
        g.stroke();
        g.restore();
      });
    });
    return c.toDataURL('image/jpeg', 0.82);
  }
  function paintLockerRoom() {
    const c = menuCanvas();
    const g = c.getContext('2d');
    // White tiled walls with dark grout
    g.fillStyle = '#e9ece6';
    g.fillRect(0, 0, 1280, 720);
    g.strokeStyle = 'rgba(80,95,90,0.25)';
    g.lineWidth = 2;
    for (let x = 0; x <= 1280; x += 48) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 520); g.stroke(); }
    for (let y = 0; y <= 520; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(1280, y); g.stroke(); }
    // A green band of tiles
    g.fillStyle = '#2f6b45';
    g.fillRect(0, 300, 1280, 48);
    // Floor
    const fl = g.createLinearGradient(0, 520, 0, 720);
    fl.addColorStop(0, '#6b6f6a');
    fl.addColorStop(1, '#3f423f');
    g.fillStyle = fl;
    g.fillRect(0, 520, 1280, 200);
    // Coat hooks with towels and a shirt
    for (let i = 0; i < 9; i++) {
      const x = 80 + i * 140;
      g.fillStyle = '#9aa1a7';
      g.fillRect(x - 4, 200, 8, 14);
      if (i % 2 === 0) {
        g.fillStyle = ['#f4f1e6', '#c8102e', '#1f3a6b', '#f2c14e', '#2f8f83'][i % 5];
        g.beginPath();
        g.moveTo(x - 30, 214);
        g.lineTo(x + 30, 214);
        g.lineTo(x + 26, 300);
        g.lineTo(x - 26, 300);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(x - 26, 286, 52, 8);
      }
    }
    // The tactics board
    g.fillStyle = '#f7f7f2';
    g.fillRect(860, 60, 300, 170);
    g.strokeStyle = '#2b2f33';
    g.lineWidth = 6;
    g.strokeRect(860, 60, 300, 170);
    g.strokeStyle = '#1f6b3a';
    g.lineWidth = 3;
    g.strokeRect(900, 85, 220, 120);
    g.beginPath();
    g.moveTo(1010, 85);
    g.lineTo(1010, 205);
    g.moveTo(900, 145);
    g.lineTo(1120, 145);
    g.stroke();
    g.strokeStyle = '#c8102e';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(930, 190);
    g.quadraticCurveTo(1000, 120, 1090, 100);
    g.stroke();
    g.font = 'bold 22px "Segoe Print", "Comic Sans MS", cursive';
    g.fillStyle = '#c8102e';
    g.fillText('STAY CALM', 920, 120);
    // The bench, a racket bag and shoes
    g.fillStyle = '#9a6a3c';
    g.fillRect(60, 470, 1160, 26);
    g.fillStyle = '#7a5230';
    g.fillRect(60, 496, 1160, 10);
    for (let x = 100; x < 1220; x += 260) { g.fillStyle = '#5a3d22'; g.fillRect(x, 506, 16, 60); }
    g.fillStyle = '#1f3a6b';
    roundRect(g, 420, 420, 260, 52, 22);
    g.fill();
    g.fillStyle = '#e0312b';
    g.fillRect(420, 440, 260, 8);
    g.fillStyle = '#f6f6f2';
    roundRect(g, 760, 560, 70, 26, 10);
    g.fill();
    roundRect(g, 840, 566, 70, 26, 10);
    g.fill();
    return c.toDataURL('image/jpeg', 0.82);
  }
  function paintDusk() {
    const c = menuCanvas();
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 380);
    sky.addColorStop(0, '#2b2a4a');
    sky.addColorStop(0.55, '#d8704a');
    sky.addColorStop(1, '#fbd39a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 1280, 720);
    // The stadium bowl in silhouette, floodlights on
    g.fillStyle = '#1b1f2b';
    g.beginPath();
    g.moveTo(0, 420);
    g.quadraticCurveTo(640, 250, 1280, 420);
    g.lineTo(1280, 720);
    g.lineTo(0, 720);
    g.fill();
    [[180, 300], [1100, 300]].forEach((q) => {
      g.strokeStyle = '#1b1f2b';
      g.lineWidth = 8;
      g.beginPath();
      g.moveTo(q[0], 420);
      g.lineTo(q[0], q[1]);
      g.stroke();
      g.fillStyle = '#fff7da';
      g.fillRect(q[0] - 34, q[1] - 16, 68, 18);
      const lg = g.createRadialGradient(q[0], q[1], 5, q[0], q[1], 170);
      lg.addColorStop(0, 'rgba(255,245,210,0.55)');
      lg.addColorStop(1, 'rgba(255,245,210,0)');
      g.fillStyle = lg;
      g.fillRect(q[0] - 180, q[1] - 180, 360, 360);
    });
    // The court, lit, from high up
    g.fillStyle = '#2f6b45';
    g.beginPath();
    g.moveTo(330, 700);
    g.lineTo(520, 430);
    g.lineTo(760, 430);
    g.lineTo(950, 700);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(360, 690);
    g.lineTo(530, 440);
    g.lineTo(750, 440);
    g.lineTo(920, 690);
    g.closePath();
    g.moveTo(450, 560);
    g.lineTo(830, 560);
    g.stroke();
    g.fillStyle = 'rgba(20,20,20,0.6)';
    g.fillRect(440, 548, 400, 10);
    // Lights in the stands
    const rng = makeLCG(7);
    for (let i = 0; i < 220; i++) {
      g.fillStyle = 'rgba(255,230,170,' + (0.3 + rng() * 0.5).toFixed(2) + ')';
      const x = rng() * 1280;
      g.fillRect(x, 400 + rng() * 300 - Math.abs(x - 640) * 0.0, 2, 2);
    }
    return c.toDataURL('image/jpeg', 0.82);
  }
  // Set them behind the hub, the locker room and the results, darkened so the panels stay readable
  function paintMenuArt() {
    try {
      const shade = 'linear-gradient(180deg, rgba(8,22,14,0.62), rgba(8,22,14,0.8))';
      const sides = 'linear-gradient(90deg, rgba(8,22,14,0) 0, rgba(8,22,14,0) 9%, rgba(8,22,14,0.55) 13%, rgba(8,22,14,0.55) 87%, rgba(8,22,14,0) 91%)';
      [['hub', paintTunnel], ['locker', paintLockerRoom], ['over', paintDusk]].forEach((m) => {
        const el = document.getElementById(m[0]);
        if (el) el.style.background = (m[0] === 'hub' ? sides + ', linear-gradient(180deg, rgba(8,22,14,0.35), rgba(8,22,14,0.5))' : shade) + ', url(' + m[1]() + ') center / cover no-repeat, #0b1d12';
      });
    } catch (e) { /* the plain background will do */ }
  }
  // How to Play, Moves: a Learned stamp on each move the game has taught you
  function markLearned() {
    document.querySelectorAll('#how [data-move]').forEach((c) => c.classList.toggle('is-learned', !!SAVE.tips[c.dataset.move]));
  }
  function boot() {
    paintMenuArt();
    // CrazyGames' mute setting takes priority over the game's own sound setting
    if (window.RRCG && window.RRAudio && RRAudio.setHostMuted) RRCG.onMute((m) => RRAudio.setHostMuted(m));
    // Controls: tips and labels follow the input in use (touch, mouse or keys)
    document.addEventListener('pointerdown', (e) => setInput(e.pointerType === 'touch' ? 'touch' : 'mouse'), { capture: true });
    // Inside the CrazyGames frame, a click on the court must give the game the keyboard. The court's own press handler
    // cancels the browser's default (so a swing never selects or drags anything), and that default is what would move focus
    // into the frame. So the game asks for focus itself, on any press, while it does not have it.
    document.addEventListener('pointerdown', () => { if (!document.hasFocus()) { try { window.focus(); } catch (err) { /* the page keeps focus */ } } }, { capture: true });
    document.addEventListener('keydown', (e) => { if (PLAY_KEYS.indexOf(e.code) >= 0) setInput('keys'); }, { capture: true });
    onInputChange.push(refreshControls);
    refreshControls();
    try {
      if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
        navigator.keyboard.getLayoutMap().then((map) => {
          ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyC', 'KeyF', 'KeyP', 'KeyM'].forEach((c) => { const v = map.get(c); if (v && /^[a-z]$/i.test(v)) KEYCAP[c] = v.toUpperCase(); });
          refreshControls();
        }).catch(() => {});
      }
    } catch (e) { /* the layout stays QWERTY */ }
    // Keyboard on the menus: with nothing picked, an arrow, Space or Enter picks the main button of the top window
    // or screen; arrows then step through its buttons, and Space or Enter press them as usual
    document.addEventListener('keydown', (e) => {
      const nav = e.code.indexOf('Arrow') === 0;
      if (!nav && e.code !== 'Space' && e.code !== 'Enter') return;
      const tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA')) return;
      const modal = document.querySelector('.modal:not(.hidden)');
      if (/^(MATCH_PLAY|MELTDOWN_MINIGAME|INTRO|BOOT)$/.test(FSM.name) && !modal) return;
      const btns = navButtons();
      if (!btns.length) return;
      const cur = btns.indexOf(document.activeElement);
      if (cur < 0) {
        e.preventDefault();
        (btns.find((b) => b.classList.contains('primary')) || btns[0]).focus();
        return;
      }
      if (nav) {
        e.preventDefault();
        const d = e.code === 'ArrowDown' || e.code === 'ArrowRight' ? 1 : -1;
        btns[(cur + d + btns.length) % btns.length].focus();
      }
    });
    // Space and the arrows never scroll the page
    document.addEventListener('keydown', (e) => { if ((e.code === 'Space' || e.code.indexOf('Arrow') === 0) && (e.target === document.body || e.target === canvas)) e.preventDefault(); });
    // The display font: load it before the first frame so canvas text never falls back
    if (document.fonts && document.fonts.load) document.fonts.load('40px "Lilita One"').catch(() => {});
    fit();
    window.addEventListener('resize', fit);
    // How to Play: three pages behind tabs
    document.querySelectorAll('#how [data-how]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#how [data-how]').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#how [data-page]').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== b.dataset.how));
      const pg = document.querySelector('#how [data-page="' + b.dataset.how + '"]');
      replayEnter(pg);
      // A page taller than the screen fades out at the edge that has more, rather than cutting a card in half
      pg.scrollTop = 0;
      requestAnimationFrame(() => edgeFade(pg));
      if (splashFinished) sfx('click');
    }));
    document.querySelectorAll('#how [data-page]').forEach((p) => p.addEventListener('scroll', () => edgeFade(p), { passive: true }));
    window.addEventListener('cutout', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 200));
    document.addEventListener('visibilitychange', () => {
      if (!window.RRAudio) return;
      if (document.hidden) RRAudio.suspend(); else RRAudio.resume();
      if (document.hidden) scheduleReminders();
    });
    // Block the long press menu and pinch zoom gestures on Android WebViews
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());

    // Android back button inside Capacitor
    const Cap = window.Capacitor;
    if (Cap && Cap.Plugins && Cap.Plugins.App && Cap.isNativePlatform && Cap.isNativePlatform()) {
      Cap.Plugins.App.addListener('backButton', () => {
        if (!splashFinished) return;   // the studio splash plays out untouched
        if (FSM.name === 'INTRO') FSM.state.finish();
        else if (FSM.name === 'MATCH_PLAY') togglePause();
        else if (FSM.name === 'CAREER_HUB' || FSM.name === 'GAME_OVER') FSM.change('MENU');
        else if (FSM.name === 'MENU') {
          // Back closes an open panel first, then leaves the app
          const open = ['#how', '#dailyPanel', '#settingsPanel'].map((id) => $(id)).find((el) => el.classList.contains('show'));
          if (open) open.classList.remove('show');
          else if (Cap.Plugins.App.minimizeApp) Cap.Plugins.App.minimizeApp();
        }
      });
    }

    // The share card preview, used when the device cannot share pictures directly
    $('#cardClose').addEventListener('click', () => { sfx('click'); $('#cardModal').classList.add('hidden'); });
    $('#btnTrophyClose').addEventListener('click', () => { sfx('click'); $('#trophyModal').classList.add('hidden'); });
    $('#cardCopy').addEventListener('click', () => { sfx('click'); shareText($('#cardModal').dataset.text || ''); });
    // Sound may only start after a press. Listen from the start, so a press on the studio splash counts too.
    const earlyAudio = () => { if (window.RRAudio) { RRAudio.init(); RRAudio.setMuted(SAVE.settings.muted); RRAudio.resume(); } };
    document.addEventListener('pointerdown', earlyAudio, { capture: true, once: true });
    document.addEventListener('keydown', earlyAudio, { capture: true, once: true });
    // The splash's logo is up by now and animates on the compositor: a good moment to build the title
    if (!splashFinished) setTimeout(warmTitle, 900);
    splashDone.then(() => {
      splashFinished = true;
      if (window.RRCG) RRCG.loadingStop();
      document.body.classList.remove('cg-wait');
      // Audio needs a user gesture before it may start. These capture listeners only go on after the splash.
      const unlockAudio = () => {
        if (window.RRAudio) { RRAudio.init(); RRAudio.setMuted(SAVE.settings.muted); RRAudio.resume(); }
        if (FSM.name === 'MENU') titleMusic(true);
      };
      // Where the device allows sound without a tap (the Android app does), start it now, so the title theme
      // plays as soon as the title appears; elsewhere the first tap starts it
      unlockAudio();
      document.addEventListener('pointerdown', unlockAudio, { capture: true });
      document.addEventListener('keydown', unlockAudio, { capture: true });
      // Ads and the Google consent prompt, then the game's own intro, then the title screen
      window.RRAds && RRAds.init();
      setTimeout(adsWarm, 25000);
      initShop();
      // Play Games: signs in quietly and shows the world table and achievements buttons, once it is set up
      if (window.RRGames) RRGames.init(Object.keys(SAVE.ach || {})).then((ok) => { document.querySelectorAll('#btnDailyWorld, #btnRecordPG').forEach((b) => b.classList.toggle('hidden', !ok)); });
      $('#btnDailyWorld').addEventListener('click', () => { sfx('click'); RRGames.showLeaderboard(); });
      $('#btnRecordPG').addEventListener('click', () => { sfx('click'); RRGames.showAchievements(); });
      applySettings();
      // Web: a first-time player goes straight into their first match, with no intro or menus first.
      // Everyone else goes to the title screen.
      if (!SAVE.tutorialDone && !pendingResume()) {
        SAVE.introSeen = true;
        persist();
        newMatch(firstConfig());
        FSM.change('MATCH_PLAY', { fresh: true });
      } else {
        const back = SAVE.tutorialDone && SAVE.lastVisit && SAVE.lastVisit !== dateKey();
        FSM.change('MENU');
        if (back) { const w = reminderText(new Date()); setTimeout(() => toast(w.title + '. ' + w.body, 5200), 700); }
      }
      SAVE.lastVisit = dateKey();
      persist();
      last = performance.now();
      requestAnimationFrame(frame);
    });
  }

  // Console hooks for testing. Remove before release if you prefer.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || /[?&]rrdebug\b/.test(location.search)) window.RRDebug = {
    fsm: FSM,
    // For tools/make-covers.js: the game's own painters, so the store covers are drawn in the match style
    cover: { buildBackground: (s, seed) => buildBackground(s, seed), renderRoutine: (c, t, id, kit, parts, shards) => renderRoutine(c, t, id, kit, parts, shards), playerKit: () => playerKit(), TANTRUM: TANTRUM, K: { KP: KP, PX: PX, FLOOR_Y: FLOOR_Y, SMASH_T: SMASH_T, W: W, H: H, BX: BX, BY: BY, scale: scale } },
    // Runs n frames of dt seconds and draws the last one, for tests in a hidden or throttled tab
    // Advance the game without drawing, for fast bot tests
    tick(dt, n) {
      for (let i = 0; i < (n || 1); i++) {
        const st = FSM.state;
        if (st && st.update) st.update(dt || 1 / 60);
      }
    },
    step(dt, n) {
      for (let i = 0; i < (n || 1); i++) {
        const st = FSM.state;
        if (st && st.update) st.update(dt || 1 / 60);
      }
      const st = FSM.state;
      if (st && st.render) {
        g.setTransform(scale, 0, 0, scale, BX * scale, BY * scale);
        st.render(g);
      }
    },
    get match() { return M; },
    get md() { return MD; },
    roast: (r) => roastQ(r),
    headline: () => tabloidHeadline(),
    streakAlive: () => streakAlive(),
    cinema(on) { CINEMA = !!on; document.body.classList.toggle('cinema', CINEMA); },
    camPath(o) { CAM_PATH = o ? Object.assign({ who: 0, z0: 1, z1: 1.6, dur: 6, t0: M.time }, o) : null; },
    // Where a court point lands on the canvas, in canvas pixels (for test crops)
    canvasPx(x, y, z) { const p = worldToScreen(x, y, z || 0); return { x: (p.x + BX) * scale, y: (p.y + BY) * scale, s: scale }; },
    swat(x, y) { return swatThought(x === undefined ? null : { x: x, y: y }); },
    // Draws one frame of a tantrum or celebration routine into the Locker Room preview, for checking poses
    routineFrame(id, t) { drawLockerPreview(id, t); return $('#lockerPreview').toDataURL(); },
    get save() { return SAVE; },
    setRage(v) { if (M) M.rage = clamp(v, 0, 1); },
    // The opponent plays one shot of the given spin at (x, y) on your side, for testing footwork
    // Serves one ball from your side at the given power and aim, for measuring aces
    serveTest(p, x, y, flick) {
      M.power = p;
      M.aim = { x: x, y: y };
      playerServe(flick || 0);
      M.phase = 'rally';
      return M.shot;
    },
    feed(spin, x, y, mph) {
      const o = M.opp;
      M.shot = makeShot({ x: o.x, y: o.y, z: 1.1 }, { x: x, y: y }, mph || 44, { hitter: 1, spin: spin });
      M.phase = 'rally';
      aimReceiver(M.shot);
      return M.shot;
    },
    addRage(v, label) { if (M) addRage(v, label); },
    bigHit(x, y, z, freeze, n, power) { if (M) bigHit(x, y, z, freeze, n, power); },
    // Lands n good balls of yours at (x, y) and reports how each was called, for testing the line call rules
    testCalls(x, y, n) {
      const out = { inPlay: 0, oppCall: 0, umpCall: 0, challengeable: 0, subs: [] };
      for (let i = 0; i < n; i++) {
        M.phase = 'rally';
        M.gameCheats = 0;
        M.challengeable = null;
        M.calls = [];
        M.speech = null;
        M.cfg.wind = 0;
        const sh = makeShot({ x: 0, y: 0.5, z: 1 }, { x: x, y: y }, 60, { hitter: 0, spin: 'flat' });
        M.shot = sh;
        while (!sh.bounced && !sh.dead && sh.t < 6) { sh.t += 1 / 60; if (sh.t >= sh.T1) { sh.bounced = true; onBounce(sh); } }
        if (!sh.dead) { out.inPlay++; continue; }
        if (M.speech && M.speech.who === 'opp') out.oppCall++;
        if (M.speech && M.speech.who === 'ump') out.umpCall++;
        if (M.challengeable) out.challengeable++;
        if (M.calls[0] && out.subs.length < 2) out.subs.push(M.calls[0].main + ': ' + M.calls[0].sub);
      }
      M.shot = null;
      return out;
    },
    setSpeed(n) { debugSpeed = n; },
    drawFigure: (ctx, b, front, colors, opts) => drawFigure(ctx, b, front, colors, opts),
    smashStyles: SMASH_STYLES.map((x) => x.id),
    point(w) { awardPoint(w); return { points: M.points.slice(), games: M.games.slice(), tiebreak: M.tiebreak, server: M.server, winner: M.matchWinner, label: [pointLabel(0), pointLabel(1)], status: scoreStatus() }; },
    pointTo(w, reason) { pointTo(w, reason); },
    // n lobs of yours over an opponent standing at the net: how each ends (their winner, error, return, or yours)
    lobTest(n, spin) {
      const out = {};
      for (let i = 0; i < n; i++) {
        M.phase = 'rally';
        M.matchWinner = null;
        M.calls = [];
        M.cfg.wind = 0;
        Object.assign(M.opp, { x: (M.rng() - 0.5) * 4, y: NET_POS, tx: 0, ty: NET_POS, atNet: true, swing: 0 });
        Object.assign(M.player, { x: 0, y: -0.5, tx: 0, ty: -0.5 });
        const sh = makeShot({ x: 0, y: 0.2, z: 1 }, { x: (M.rng() - 0.5) * 6, y: 21 + M.rng() * 1.5 }, 44, { hitter: 0, spin: spin || 'lob', oppAtNetY: NET_POS });
        sh.cause = { quality: 'good' };
        M.shot = sh;
        aimReceiver(sh);
        let k = 0;
        while (k++ < 600 && M.phase === 'rally' && M.shot === sh) updateMatch(1 / 60);
        const key = M.phase !== 'rally' ? (M.lastPoint ? M.lastPoint.reason : M.phase) : M.shot && M.shot.hitter === 1 ? (M.shot.netted || !inBox(M.shot.land, courtHalf(0)) ? 'their error' : 'returned in') + (sh.lobbed ? '' : '(not lobbed)') : 'other';
        out[key] = (out[key] || 0) + 1;
      }
      M.shot = null;
      return out;
    },
    tbServer: () => tiebreakServer(),
    tutEvent: (k, sh) => tutEvent(k, sh),
    award: (k, n, w) => award(k, n, w),
    forceSmash(id, incident) { forcedSmash = id; forcedIncident = incident || null; },
    dailyConfig: dailyConfig,
    scorecard: scorecardText,
    reset() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } location.reload(); }
  };

  boot();
})();

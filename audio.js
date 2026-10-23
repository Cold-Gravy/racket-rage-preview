/* Racket Rage Tennis - audio.js
   Web Audio: recorded samples for the ball, the frame and the applause (www/sfx, all CC0),
   procedural synthesis for everything else and as the fallback while the samples load.
   Public API (window.RRAudio):
     init()              create the AudioContext (call from a user gesture)
     resume(), suspend() wake or park the context
     play(name, opts)    one shot: hit, sweet, mishit, bounce, net, frame, squeak, gasp, ooh, applause, boo,
                         grunt, umpire, shout, fault, breath, ping, crunch, creak, snap, clang, drumroll, chime, scream,
                         coins, click, whoosh, stingUp, stingDown, fanfare, trombone
     loop(name)          start a loop (crowd, heartbeat). Returns { stop() }.
     stopLoops()         stop every running loop
     setMuted(bool), isMuted()
*/
(function (global) {
  'use strict';

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  const loops = new Set();

  // The phone's own voice for the umpire and line judges (the app's Voice plugin: Android text-to-speech,
  // British English). true once the phone says it has a usable voice; until then, and on a desktop browser,
  // the synthesised voice speaks.
  let nativeReady = false;
  let lastShout = 0;
  let nativeHas = {};   // which of a man's and a woman's British voice the phone has
  function checkVoice() {
    const P = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Voice;
    if (!P || nativeReady) return;
    P.ready().then(function (r) { nativeReady = !!(r && r.ready); nativeHas = r || {}; }).catch(function () { nativeReady = false; });
  }
  function nativeVoice(name, o) {
    if (!nativeReady) return false;
    const P = global.Capacitor.Plugins.Voice;
    let text = o.text;
    let pitch = o.vPitch || (o.pitch ? Math.min(1.6, o.pitch / 150) : 0.9);
    let rate = o.vRate || 0.95;
    // An umpire speaks with their own voice (m or f); a fan's shout is queued so it never cuts off the umpire
    const gender = o.gender || null;
    if (name === 'fan') { pitch = o.vPitch || 1; rate = o.vRate || 1.05; }
    // No man's voice on this phone: the default voice, pitched down
    if (gender === 'm' && !nativeHas.male && !o.voice) pitch *= 0.78;
    if (name === 'shout') {
      // Line judges: a sharp OUT or FAULT. The opponent's scream (another vowel) stays synthesised.
      if (o.vowel !== 'o') return false;
      text = o.fault ? 'Fault!' : 'Out!';
      pitch = 1.15;
      rate = 1.1;
    }
    if (!text) return false;
    // The umpire's call straight after a line judge's waits for the line judge to finish ("Out!" ... "Game, Allsop.")
    const now = Date.now();
    const queue = name === 'fan' || (name === 'umpire' && now - lastShout < 1500);
    if (name === 'shout') lastShout = now;
    P.speak({ text: text, rate: rate, pitch: pitch, volume: name === 'fan' ? 0.6 : 0.95, queue: queue, gender: gender, voice: o.voice || null, online: !!o.online }).then(function (r) { if (r && r.ok === false) nativeReady = false; }).catch(function () { nativeReady = false; });
    return true;
  }

  function init() {
    checkVoice();
    if (ctx) { loadSamples(); return; }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC(); } catch (e) { ctx = null; return; }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(comp);
    comp.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    loadSamples();
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }

  // Muted by the player, or by the host page (CrazyGames' own mute, or while an advert plays)
  let userMuted = false;
  let hostMuted = false;
  function applyMute() {
    muted = userMuted || hostMuted;
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.85, ctx.currentTime, 0.02);
    if (muted && global.speechSynthesis) { try { global.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  }
  function setMuted(m) { userMuted = !!m; applyMute(); }
  function setHostMuted(m) { hostMuted = !!m; applyMute(); }

  /* ---------- building blocks ---------- */
  function out(pan, dest) {
    const target = dest || master;
    if (typeof pan === 'number' && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(target);
      return p;
    }
    return target;
  }

  function env(param, t, a, peak, hold, rel) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    param.setValueAtTime(Math.max(peak, 0.0002), t + a + hold);
    param.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }

  // Filtered noise burst. freqEnd sweeps the filter.
  function noise(t, dur, type, freq, q, peak, a, rel, opts) {
    opts = opts || {};
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    env(g.gain, t, a, peak, Math.max(0, dur - a - rel), rel);
    src.connect(f);
    f.connect(g);
    g.connect(out(opts.pan, opts.dest));
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  function tone(t, dur, type, freq, peak, a, rel, opts) {
    opts = opts || {};
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + dur);
    const g = ctx.createGain();
    env(g.gain, t, a, peak, Math.max(0, dur - a - rel), rel);
    let node = o;
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lowpass;
      o.connect(f);
      node = f;
    }
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = opts.vibrato;
      lg.gain.value = opts.vibratoDepth || 20;
      lfo.connect(lg);
      lg.connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    node.connect(g);
    g.connect(out(opts.pan, opts.dest));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // A voice: sawtooth glottal source through two vowel formants.
  const VOWELS = {
    a: [800, 1200], e: [500, 1850], i: [320, 2300], o: [500, 900], u: [350, 800], r: [450, 1300]
  };
  function voice(t, dur, pitch, pitchEnd, vowel, peak, opts) {
    opts = opts || {};
    const f = VOWELS[vowel] || VOWELS.a;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(pitch, t);
    o.frequency.linearRampToValueAtTime(pitchEnd, t + dur);
    const g = ctx.createGain();
    env(g.gain, t, Math.min(0.03, dur * 0.2), peak, Math.max(0, dur * 0.6), dur * 0.3);
    const dest = out(opts.pan, opts.dest);
    for (let k = 0; k < 2; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f[k] * (opts.formantShift || 1);
      bp.Q.value = k === 0 ? 6 : 9;
      const kg = ctx.createGain();
      kg.gain.value = k === 0 ? 1.4 : 0.8;
      o.connect(bp);
      bp.connect(kg);
      kg.connect(g);
    }
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Rough syllables from text, so "Code violation" gets five plausible mumbles.
  function syllables(text) {
    const words = String(text || 'out').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
    const list = [];
    words.forEach(function (w, wi) {
      const groups = w.match(/[aeiouy]+/g) || ['a'];
      groups.forEach(function (g, gi) {
        let v = g[0] === 'y' ? 'i' : g[0];
        if (g === 'ou' || g === 'ow') v = 'o';
        list.push({ v: VOWELS[v] ? v : 'a', stress: gi === 0, gap: gi === groups.length - 1 ? (wi === words.length - 1 ? 0 : 0.09) : 0.015, consonant: /[stcfkpz]/.test(w) });
      });
    });
    return list.slice(0, 16);
  }

  /* ---------- sounds ---------- */
  const SFX = {
    // Strings on felt: a crisp click on top of a short woody body. power 0 to 1.5
    hit: function (t, o) {
      const p = o.power || 1;
      noise(t, 0.05, 'highpass', 2600, 0.8, 0.5 * p, 0.001, 0.04, { pan: o.pan });
      noise(t, 0.09, 'bandpass', 1100, 3, 0.35 * p, 0.001, 0.07, { pan: o.pan, freqEnd: 700 });
      tone(t, 0.09, 'triangle', 520 + 120 * p, 0.25 * p, 0.001, 0.07, { freqEnd: 260, pan: o.pan });
    },
    // A clean strike from the middle of the strings: a crisp crack and a bright ring of the strings
    sweet: function (t, o) {
      const p = o.power || 1;
      noise(t, 0.03, 'highpass', 4200, 0.8, 0.7 * p, 0.0005, 0.025, { pan: o.pan });
      tone(t, 0.16, 'sine', 1380, 0.12 * p, 0.001, 0.14, { freqEnd: 1180, pan: o.pan });
      noise(t, 0.08, 'bandpass', 1250, 4, 0.3 * p, 0.001, 0.06, { pan: o.pan, freqEnd: 800 });
      tone(t, 0.08, 'triangle', 640, 0.22 * p, 0.001, 0.06, { freqEnd: 300, pan: o.pan });
    },
    // Off the frame: a dull, hollow clunk with a little rattle
    mishit: function (t, o) {
      tone(t, 0.1, 'triangle', 240, 0.3, 0.001, 0.08, { freqEnd: 130, pan: o.pan });
      noise(t, 0.06, 'bandpass', 520, 5, 0.3, 0.001, 0.05, { pan: o.pan });
      tone(t + 0.03, 0.03, 'square', 900, 0.04, 0.001, 0.02, { pan: o.pan, lowpass: 1500 });
    },
    bounce: function (t, o) {
      const p = o.power || 0.7;
      tone(t, 0.08, 'sine', 240, 0.3 * p, 0.002, 0.06, { freqEnd: 120, pan: o.pan });
      noise(t, 0.04, 'bandpass', 1800, 2, 0.12 * p, 0.001, 0.03, { pan: o.pan });
    },
    net: function (t) {
      noise(t, 0.35, 'bandpass', 900, 1.2, 0.3, 0.005, 0.3, { freqEnd: 300 });
      tone(t, 0.2, 'sine', 110, 0.3, 0.003, 0.17, { freqEnd: 60 });
    },
    // The hollow snap of a graphite frame giving up: a crack, a resonant body, then rattling bits.
    frame: function (t) {
      noise(t, 0.03, 'highpass', 3000, 0.7, 0.9, 0.0005, 0.025);
      noise(t, 0.4, 'bandpass', 340, 14, 0.9, 0.001, 0.38, { freqEnd: 260 });
      tone(t, 0.35, 'square', 180, 0.22, 0.001, 0.3, { freqEnd: 70, lowpass: 900 });
      noise(t + 0.02, 0.25, 'bandpass', 1500, 8, 0.25, 0.002, 0.2, { freqEnd: 900 });
      for (let i = 0; i < 6; i++) {
        const tt = t + 0.25 + i * 0.07 + Math.random() * 0.05;
        tone(tt, 0.04, 'triangle', 700 + Math.random() * 900, 0.12, 0.001, 0.035, { pan: Math.random() * 1.6 - 0.8 });
      }
    },
    // Rubber on a hard court.
    squeak: function (t, o) {
      const f = 1700 + Math.random() * 900;
      tone(t, 0.14, 'sine', f, 0.09, 0.01, 0.06, { freqEnd: f * 1.35, vibrato: 60, vibratoDepth: 140, pan: o.pan });
      tone(t, 0.14, 'triangle', f * 1.5, 0.03, 0.01, 0.06, { freqEnd: f * 2, pan: o.pan });
    },
    // Eight thousand people inhaling at once.
    gasp: function (t) {
      noise(t, 0.9, 'bandpass', 900, 1.1, 0.3, 0.06, 0.6, { freqEnd: 1600 });
      for (let i = 0; i < 8; i++) {
        voice(t + Math.random() * 0.08, 0.5, 190 + Math.random() * 120, 230 + Math.random() * 140, 'a', 0.06, { pan: Math.random() * 1.6 - 0.8 });
      }
    },
    ooh: function (t) {
      for (let i = 0; i < 8; i++) {
        const p = 160 + Math.random() * 120;
        voice(t + Math.random() * 0.1, 0.9, p, p * 0.85, 'u', 0.06, { pan: Math.random() * 1.6 - 0.8 });
      }
    },
    applause: function (t, o) {
      const n = Math.round(30 * (o.power || 1));
      for (let i = 0; i < n; i++) {
        noise(t + Math.random() * 1.6, 0.04, 'bandpass', 1800 + Math.random() * 1500, 1.5, 0.18, 0.001, 0.035, { pan: Math.random() * 1.8 - 0.9 });
      }
    },
    boo: function (t) {
      for (let i = 0; i < 9; i++) {
        const p = 110 + Math.random() * 90;
        voice(t + Math.random() * 0.2, 1.3, p, p * 0.8, 'u', 0.05, { pan: Math.random() * 1.6 - 0.8 });
      }
    },
    // Opponent grunt. power scales volume and length.
    grunt: function (t, o) {
      const p = o.power || 1;
      const pitch = (o.pitch || 210) * (0.92 + Math.random() * 0.16);
      voice(t, 0.18 + 0.22 * p, pitch * 1.25, pitch * 0.8, 'a', 0.28 * p, { formantShift: 0.95 });
      noise(t, 0.16 + 0.2 * p, 'bandpass', 1300, 2, 0.08 * p, 0.01, 0.12);
    },
    // Umpire. opts.text is turned into syllables with a flat, unimpressed contour.
    fan: function () {},
    // A fan's shout gets the recorded crowd cheer (no fallback sound if the file is missing)
    cheer: function () {},
    umpire: function (t, o) {
      const syl = syllables(o.text);
      let tt = t;
      const base = o.pitch || 128;
      syl.forEach(function (s, i) {
        const d = s.stress ? 0.17 : 0.12;
        const pitch = base * (s.stress ? 1.12 : 1) * (1 - i * 0.012);
        if (s.consonant && s.stress) noise(tt, 0.04, 'highpass', 3500, 0.7, 0.05, 0.003, 0.03);
        voice(tt + 0.02, d, pitch, pitch * 0.93, s.v, 0.22, { formantShift: 1 });
        tt += d + s.gap;
      });
      // Microphone thump and a little room
      tone(t - 0.04, 0.05, 'sine', 90, 0.08, 0.003, 0.04);
    },
    // A line judge shouting "OUT" or "FAULT".
    shout: function (t, o) {
      const v = o.vowel || 'o';
      voice(t, 0.32, 260, 190, v, 0.35, { formantShift: 1.05 });
      if (o.fault) noise(t, 0.05, 'highpass', 3000, 0.8, 0.12, 0.003, 0.04);
    },
    // The old service line beep, for faults.
    fault: function (t) {
      tone(t, 0.18, 'sine', 1560, 0.12, 0.004, 0.06);
    },
    // One deep breath per tap in the meltdown.
    breath: function (t, o) {
      const p = o.power || 1;
      noise(t, 0.16, 'bandpass', 700 + Math.random() * 300, 1.4, 0.12 * p, 0.02, 0.1, { freqEnd: 1100 });
    },
    // One string letting go, a bright twang that drops in pitch
    ping: function (t, o) {
      const f = o.pitch || 1600;
      tone(t, 0.35, 'triangle', f, 0.1, 0.002, 0.3, { freqEnd: f * 0.55 });
      tone(t, 0.2, 'sine', f * 2.01, 0.04, 0.002, 0.18, { freqEnd: f });
    },
    // Graphite giving way in several places at once. o.far makes it sound distant.
    crunch: function (t, o) {
      const p = o.far ? 0.35 : 1;
      for (let i = 0; i < 5; i++) {
        noise(t + i * 0.035 + Math.random() * 0.02, 0.05, 'bandpass', 1800 + Math.random() * 1600, 3, 0.35 * p, 0.001, 0.045);
      }
      noise(t, 0.25, 'lowpass', 700, 1, 0.3 * p, 0.003, 0.2);
    },
    // A frame bending slowly before it folds
    creak: function (t) {
      tone(t, 0.45, 'sawtooth', 210, 0.08, 0.04, 0.2, { freqEnd: 95, lowpass: 900, vibrato: 38, vibratoDepth: 25 });
      noise(t, 0.4, 'bandpass', 1200, 6, 0.08, 0.05, 0.2, { freqEnd: 500 });
    },
    // A clean snap at the throat, like a breadstick the size of a cricket bat
    snap: function (t) {
      noise(t, 0.025, 'highpass', 2500, 0.7, 1, 0.0005, 0.02);
      tone(t, 0.12, 'square', 900, 0.15, 0.001, 0.1, { freqEnd: 300, lowpass: 3000 });
      noise(t + 0.01, 0.18, 'bandpass', 600, 5, 0.3, 0.002, 0.15, { freqEnd: 300 });
    },
    // Racket meets aluminium net post
    clang: function (t) {
      [523, 1187, 1873, 2795].forEach(function (f, i) {
        tone(t, 0.9, 'sine', f, 0.12 / (i + 1) + 0.03, 0.001, 0.85);
      });
      noise(t, 0.04, 'highpass', 3000, 0.7, 0.5, 0.0005, 0.035);
    },
    // Your tantrum scream: a strained, rising "AAAH" with grit in it
    scream: function (t, o) {
      const p = o.pitch || 1;
      voice(t, 0.85, 240 * p, 330 * p, 'a', 0.3, { formantShift: 1.1 });
      voice(t + 0.02, 0.85, 247 * p, 338 * p, 'a', 0.16, { formantShift: 1.15 });
      noise(t, 0.85, 'bandpass', 1500, 1.4, 0.12, 0.05, 0.3);
    },
    // A press photographer's shutter: two quick clicks
    shutter: function (t) {
      noise(t, 0.02, 'highpass', 3500, 0.8, 0.12, 0.001, 0.015, { pan: Math.random() * 1.6 - 0.8 });
      noise(t + 0.06, 0.03, 'bandpass', 2200, 2, 0.1, 0.001, 0.025, { pan: Math.random() * 1.6 - 0.8 });
    },
    // Snare roll that builds while the line review thinks
    drumroll: function (t, o) {
      const d = o.dur || 2.2;
      const n = Math.floor(d / 0.045);
      for (let i = 0; i < n; i++) {
        noise(t + i * 0.045, 0.04, 'bandpass', 1800 + Math.random() * 400, 1.2, 0.04 + 0.1 * (i / n), 0.002, 0.035);
      }
      tone(t + d, 0.3, 'sine', 90, 0.4, 0.003, 0.25, { freqEnd: 50 });
      noise(t + d, 0.25, 'highpass', 4000, 0.7, 0.18, 0.002, 0.22);
    },
    // Verdict chime: rising for IN (good), falling for OUT
    chime: function (t, o) {
      const notes = o.good ? [660, 880, 1320] : [520, 415, 330];
      notes.forEach(function (f, i) { tone(t + i * 0.1, 0.5, 'sine', f, 0.13, 0.005, 0.45); });
    },
    coins: function (t) {
      for (let i = 0; i < 6; i++) tone(t + i * 0.06, 0.12, 'triangle', 1800 + (i % 3) * 400, 0.07, 0.002, 0.1);
      tone(t + 0.4, 0.3, 'sine', 2600, 0.06, 0.002, 0.25);
    },
    whoosh: function (t, o) {
      const p = o.power || 1;
      noise(t, 0.22, 'bandpass', 600, 1.2, 0.18 * p, 0.04, 0.15, { freqEnd: 2400 });
    },
    // A short arcade sting with a good callout stamp
    stingUp: function (t) {
      [523, 659, 784, 1047].forEach(function (f, i) { tone(t + i * 0.055, 0.14, 'square', f, 0.05, 0.004, 0.09, { lowpass: 3200 }); });
      tone(t + 0.22, 0.32, 'triangle', 1568, 0.05, 0.004, 0.26);
    },
    // And a falling bwomp with a bad one
    stingDown: function (t) {
      tone(t, 0.16, 'square', 392, 0.05, 0.004, 0.1, { lowpass: 1400 });
      tone(t + 0.15, 0.34, 'square', 294, 0.05, 0.004, 0.26, { lowpass: 1100, freqEnd: 250 });
    },
    // Winning a match: a fanfare
    fanfare: function (t) {
      [523, 659, 784].forEach(function (f, i) { tone(t + i * 0.12, 0.2, 'square', f, 0.06, 0.005, 0.12, { lowpass: 3000 }); });
      [523, 659, 784, 1047].forEach(function (f) { tone(t + 0.4, 0.9, 'sawtooth', f, 0.035, 0.01, 0.6, { lowpass: 2600 }); });
    },
    // Losing one: the sad trombone, wah wah wah waaah
    trombone: function (t) {
      [[392, 0.34], [370, 0.34], [349, 0.34]].forEach(function (n, i) { tone(t + i * 0.38, n[1], 'sawtooth', n[0], 0.07, 0.03, 0.12, { lowpass: 1100 }); });
      tone(t + 1.14, 1.1, 'sawtooth', 330, 0.07, 0.03, 0.4, { lowpass: 1000, freqEnd: 300, vibrato: 6, vibratoDepth: 9 });
    },
    click: function (t) {
      tone(t, 0.04, 'square', 700, 0.05, 0.002, 0.03, { lowpass: 2200 });
    }
  };

  /* ---------- recorded samples ---------- */
  // Each name plays one of its files at random, a touch faster or slower each time so repeats do not sound identical.
  const SAMPLE_FILES = {
    hit: ['hit1', 'hit2', 'hit3'],
    sweet: ['hit1', 'hit3'],
    mishit: ['mishit1', 'mishit2', 'mishit3'],
    bounce: ['bounce1', 'bounce2', 'bounce3', 'bounce4', 'bounce5'],
    frame: ['frame1', 'frame2', 'frame3'],
    applause: ['applause1', 'applause2'],
    applauseBig: ['applauseBig'],
    cheer: ['cheer1'],
    crowdLoop: ['crowdLoop']
  };
  // Crowd reactions fade out after this many seconds, so the stands are quiet again for the next serve
  const SAMPLE_MAX = { applause: 2.2, applauseBig: 3.2, cheer: 2.6 };
  // A perfect hit plays its thock a little faster, so it sounds tighter
  const SAMPLE_RATE = { sweet: 1.1 };
  const SAMPLE_GAIN = { hit: 0.6, sweet: 0.78, mishit: 0.55, bounce: 0.32, frame: 0.75, applause: 0.5, applauseBig: 0.45, cheer: 0.4 };
  // Played with the sample: the string ring of a perfect hit, and the synthesised rattle of a breaking frame
  const SAMPLE_LAYER = {
    sweet: function (t, o) {
      const p = o.power || 1;
      noise(t, 0.03, 'bandpass', 1900, 3, 0.22 * p, 0.0005, 0.025, { pan: o.pan, freqEnd: 1500 });
      tone(t, 0.16, 'sine', 1380, 0.08 * p, 0.001, 0.14, { freqEnd: 1180, pan: o.pan });
    },
    frame: function (t, o) { SFX.frame(t, o); }
  };
  const samples = {};
  let samplesAsked = false;
  function loadSamples() {
    if (samplesAsked || !ctx || !global.fetch) return;
    samplesAsked = true;
    Object.keys(SAMPLE_FILES).forEach(function (name) {
      SAMPLE_FILES[name].forEach(function (f) {
        fetch('sfx/' + f + '.ogg')
          .then(function (r) { if (!r.ok) throw new Error(f); return r.arrayBuffer(); })
          .then(function (ab) { return new Promise(function (ok, bad) { ctx.decodeAudioData(ab, ok, bad); }); })
          .then(function (buf) { (samples[name] = samples[name] || []).push(buf); })
          .catch(function () { /* the synthesised sound stays in use */ });
      });
    });
  }
  function playSample(name, t, o) {
    if (name === 'applause' && (o.power || 1) >= 1.2 && samples.applauseBig) {
      const big = playSample('applauseBig', t, Object.assign({}, o, { power: Math.min(1.3, o.power) }));
      if (big && samples.cheer && Math.random() < 0.5) playSample('cheer', t + 0.15, { pan: (Math.random() - 0.5) * 0.6, power: 1 });
      if (big) return true;
    }
    const list = samples[name];
    if (!list || !list.length) return false;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = ((SAMPLE_RATE[name] || 1) * (0.97 + Math.random() * 0.06) + (SAMPLE_RATE[name] ? 0 : (Math.random() - 0.5) * 0.06)) * (o.rate || 1);
    const g = ctx.createGain();
    const p = o.power === undefined ? 1 : Math.max(0.2, Math.min(1.6, o.power));
    const vol = (SAMPLE_GAIN[name] || 0.5) * p;
    g.gain.value = vol;
    src.connect(g);
    g.connect(out(o.pan, o.dest));
    src.start(t);
    const max = SAMPLE_MAX[name];
    if (max && src.buffer.duration > max) {
      g.gain.setValueAtTime(vol, t + max);
      g.gain.linearRampToValueAtTime(0.0001, t + max + 0.8);
      src.stop(t + max + 0.9);
    }
    if (SAMPLE_LAYER[name]) SAMPLE_LAYER[name](t, o);
    return true;
  }

  function play(name, opts) {
    if (!ctx || muted || !SFX[name]) return;
    resume();
    loadSamples();
    const t = ctx.currentTime + 0.005;
    try {
      if ((name === 'umpire' || name === 'shout' || name === 'fan') && nativeVoice(name, opts || {})) return;
      if (playSample(name, t, opts || {})) return;
      SFX[name](t, opts || {});
    } catch (e) { /* ignore */ }
  }

  /* ---------- loops ---------- */
  // The crowd loop's level: 1 normally, lower for a hush before a big point
  const CROWD_LEVEL = 0.42;
  let crowdGain = null;
  let crowdK = 1;
  function crowdLevel(k) {
    crowdK = k;
    if (crowdGain && ctx) crowdGain.gain.setTargetAtTime(CROWD_LEVEL * k, ctx.currentTime, k < 1 ? 0.5 : 0.25);
  }
  const LOOPS = {
    // Polite crowd murmur: band limited noise breathing in and out, plus the odd cough.
    crowd: function () {
      if (samples.crowdLoop && samples.crowdLoop.length) {
        const rs = ctx.createBufferSource();
        rs.buffer = samples.crowdLoop[0];
        rs.loop = true;
        // Heard from the court, the crowd is a murmur: a low pass takes out the band where words are made out
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 650;
        lp.Q.value = 0.5;
        const rg = ctx.createGain();
        rg.gain.value = 0.0001;
        rg.gain.setTargetAtTime(CROWD_LEVEL * crowdK, ctx.currentTime, 0.8);
        rs.connect(lp);
        lp.connect(rg);
        rg.connect(master);
        crowdGain = rg;
        rs.start(ctx.currentTime, Math.random() * 25);
        return function stop() {
          if (crowdGain === rg) crowdGain = null;
          rg.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
          setTimeout(function () { try { rs.stop(); } catch (e) { /* ignore */ } }, 1200);
        };
      }
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 480;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.setTargetAtTime(0.05, ctx.currentTime, 0.8);
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 0.17;
      lg.gain.value = 0.018;
      lfo.connect(lg);
      lg.connect(g.gain);
      src.connect(bp);
      bp.connect(g);
      g.connect(master);
      src.start();
      lfo.start();
      const extras = setInterval(function () {
        if (muted || !ctx || ctx.state !== 'running') return;
        const r = Math.random();
        if (r < 0.18) {
          noise(ctx.currentTime, 0.12, 'bandpass', 500 + Math.random() * 400, 2, 0.05, 0.005, 0.1, { pan: Math.random() * 1.6 - 0.8 });
        } else if (r < 0.3) {
          const p = 150 + Math.random() * 140;
          voice(ctx.currentTime, 0.25, p, p * 0.9, ['a', 'e', 'o'][(Math.random() * 3) | 0], 0.025, { pan: Math.random() * 1.6 - 0.8 });
        }
      }, 700);
      return function stop() {
        clearInterval(extras);
        g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
        setTimeout(function () { try { src.stop(); lfo.stop(); } catch (e) { /* ignore */ } }, 1200);
      };
    },
    // The title theme: a two minute pop rock song in E major at 136 bpm, bright and singable, so it never feels
    // like a loop. A bell riff to open; verses with a sung line over clean picked guitar; a pre chorus that lifts
    // (A to B); a big chorus of double tracked guitars with a hook doubled by a bell an octave up; a second verse
    // and chorus; a bridge and a snare roll; a last chorus a tone higher; a short outro; then back to the verse.
    // Drums are a modelled kit in a small room, played a touch loose. The tennis ball turns up as percussion.
    title: function () {
      const BPM = 136;
      const STEP = 60 / BPM / 4;
      const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
      const R = () => Math.random();
      const bus = ctx.createGain();
      bus.gain.value = 0.0001;
      bus.gain.setTargetAtTime(0.42, ctx.currentTime, 0.08);
      bus.connect(master);
      // The lead's echo: a dotted eighth
      const echo = ctx.createDelay(1);
      echo.delayTime.value = STEP * 3;
      const fb = ctx.createGain();
      fb.gain.value = 0.2;
      const elp = ctx.createBiquadFilter();
      elp.type = 'lowpass';
      elp.frequency.value = 3200;
      echo.connect(elp);
      elp.connect(fb);
      fb.connect(echo);
      const eg = ctx.createGain();
      eg.gain.value = 0.32;
      elp.connect(eg);
      eg.connect(bus);
      // A small live room for the drums (kept short: it is the costliest part to run)
      const room = ctx.createConvolver();
      {
        const sr = ctx.sampleRate;
        const len = Math.floor(sr * 0.4);
        const b = ctx.createBuffer(2, len, sr);
        for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = Math.floor(sr * 0.008); i < len; i++) d[i] = (R() * 2 - 1) * Math.pow(1 - i / len, 4); }
        room.buffer = b;
      }
      const roomG = ctx.createGain();
      roomG.gain.value = 0.3;
      room.connect(roomG);
      roomG.connect(bus);
      const drums = ctx.createGain();
      drums.connect(bus);
      drums.connect(room);
      // Amplifiers: a distortion curve, a speaker cabinet with a little mid push, a place in the stereo picture
      function amp(drive, cut, level, pan) {
        const ws = ctx.createWaveShaper();
        const N = 1024;
        const curve = new Float32Array(N);
        for (let j = 0; j < N; j++) { const x = j / (N - 1) * 2 - 1; curve[j] = Math.tanh(x * drive) / Math.tanh(drive); }
        ws.curve = curve;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 110;
        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = 1800;
        mid.Q.value = 0.8;
        mid.gain.value = 3;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cut;
        const g = ctx.createGain();
        g.gain.value = level;
        ws.connect(hp);
        hp.connect(mid);
        mid.connect(lp);
        lp.connect(g);
        g.connect(out(pan || 0, bus));
        return { input: ws, out: g };
      }
      const gtrL = amp(10, 4200, 0.13, -0.65);
      const gtrR = amp(10, 4000, 0.13, 0.65);
      const clean = amp(1.4, 6500, 0.22, 0.4);
      const lead = amp(3.5, 4800, 0.17, 0);
      lead.out.connect(echo);
      // Oscillators through an envelope into a destination
      function osc(t, n, dur, types, peak, dest, at, rel, detune, vib) {
        const g = ctx.createGain();
        env(g.gain, t, at, peak, Math.max(0, dur - at - rel), rel);
        g.connect(dest);
        types.forEach(function (ty, i) {
          const o = ctx.createOscillator();
          o.type = ty;
          o.frequency.value = hz(n);
          o.detune.value = (i % 2 ? 1 : -1) * (detune || 0);
          if (vib && dur > 0.3) {
            const l = ctx.createOscillator();
            const lg = ctx.createGain();
            l.frequency.value = 5.5;
            lg.gain.setValueAtTime(0, t);
            lg.gain.linearRampToValueAtTime(14, t + dur);
            l.connect(lg);
            lg.connect(o.detune);
            l.start(t);
            l.stop(t + dur + 0.05);
          }
          o.connect(g);
          o.start(t);
          o.stop(t + dur + 0.05);
        });
      }
      // A power chord, double tracked: left and right a few cents and milliseconds apart
      function power(t, root, dur, peak) {
        [0, 7, 12].forEach(function (iv) {
          osc(t, root + iv, dur, ['sawtooth'], peak, gtrL.input, 0.003, Math.min(0.14, dur * 0.4), 0);
          osc(t + 0.009, root + iv + 0.07, dur, ['sawtooth'], peak, gtrR.input, 0.003, Math.min(0.14, dur * 0.4), 0);
        });
      }
      // A picked note on the clean guitar, and a bell (glockenspiel) for the sparkle on top of the hook
      const pick = (t, n, peak) => osc(t, n, STEP * 3, ['sawtooth'], peak, clean.input, 0.002, STEP * 2.6, 0);
      const bell = (t, n, peak) => {
        tone(t, 0.6, 'sine', hz(n), peak, 0.002, 0.58, { dest: bus, pan: 0.15 });
        tone(t, 0.25, 'triangle', hz(n) * 3, peak * 0.25, 0.001, 0.24, { dest: bus, pan: 0.15 });
      };
      // The sung line: the lead guitar with a singer's vibrato
      const sing = (t, n, len, peak) => osc(t, n, STEP * len, ['sawtooth', 'square'], peak, lead.input, 0.01, 0.12, 7, true);
      // The kit, modelled
      const loose = (t) => t + (R() - 0.5) * 0.006;
      const kick = (t, v) => {
        t = loose(t);
        tone(t, 0.3, 'sine', 145, 1.0 * v, 0.001, 0.28, { freqEnd: 48, dest: drums });
        noise(t, 0.012, 'highpass', 3500, 0.7, 0.16 * v, 0.0005, 0.01, { dest: drums });
      };
      const snare = (t, v) => {
        t = loose(t);
        tone(t, 0.12, 'triangle', 220, 0.32 * v, 0.001, 0.11, { freqEnd: 175, dest: drums });
        noise(t, 0.2, 'bandpass', 3200, 0.6, 0.42 * v, 0.001, 0.18, { dest: drums, freqEnd: 2300 });
      };
      const hat = (t, v, open) => {
        t = loose(t);
        noise(t, open ? 0.28 : 0.045, 'highpass', 8200, 0.8, (open ? 0.1 : 0.09) * v, 0.001, open ? 0.26 : 0.04, { dest: drums, pan: 0.25 });
      };
      const crash = (t) => noise(t, 1.8, 'highpass', 5200, 0.6, 0.16, 0.003, 1.75, { dest: drums, pan: -0.3 });
      const tom = (t, f, v) => tone(loose(t), 0.3, 'sine', f, 0.55 * (v || 1), 0.002, 0.28, { freqEnd: f * 0.62, dest: drums });
      const clap = (t) => [0, 0.011, 0.023].forEach(function (d, j) { noise(t + d, 0.03 + j * 0.02, 'bandpass', 1400, 1.2, 0.18, 0.001, 0.025 + j * 0.02, { dest: bus }); });
      // The crowd's HEY
      const hey = (t) => {
        [180, 205, 230, 260, 150].forEach(function (p, j) { voice(t + j * 0.006, 0.2, p, p * 0.92, 'e', 0.06, { dest: bus, pan: (j - 2) * 0.3 }); });
        noise(t, 0.12, 'bandpass', 2400, 1, 0.07, 0.002, 0.1, { dest: bus });
      };
      // Chords: power chord root, bass root, and the bright voicing (added nines) the clean guitar picks through
      const E = { pw: 40, bass: 40, v: [52, 59, 64, 66, 68, 71] };
      const B = { pw: 47, bass: 35, v: [59, 63, 66, 71, 73, 75] };
      const Cm = { pw: 49, bass: 37, v: [61, 64, 68, 71, 73, 76] };
      const A = { pw: 45, bass: 33, v: [57, 61, 64, 69, 71, 73] };
      const SONG = [];
      const add = (kind, chords, key) => chords.forEach(function (c, k) { SONG.push({ kind: kind, c: c, k: k, n: chords.length, key: key || 0 }); });
      add('intro', [E, B, Cm, A]);
      const VERSE_AT = SONG.length;
      add('verse', [E, B, A, B, E, B, A, B]);
      add('pre', [A, B, A, B]);
      add('chorus', [E, B, Cm, A, E, B, Cm, A]);
      add('verse2', [E, B, A, B, E, B, A, B]);
      add('pre', [A, B, A, B]);
      add('chorus', [E, B, Cm, A, E, B, Cm, A]);
      add('bridge', [A, E, A, B]);
      add('build', [A, A, B, B]);
      add('final', [E, B, Cm, A, E, B, Cm, A], 2);
      add('outro', [E, B, E, E], 2);
      // The verse's sung line, bar by bar ([step, note, length]): four bars, the second half answers the first
      const VERSE = [
        [[0, 68, 2], [2, 71, 2], [4, 71, 2], [6, 73, 2], [8, 71, 4], [12, 68, 4]],
        [[0, 66, 2], [2, 68, 2], [4, 71, 4], [8, 68, 4], [12, 66, 4]],
        [[0, 69, 2], [2, 68, 2], [4, 69, 2], [6, 71, 2], [8, 73, 4], [12, 71, 4]],
        [[0, 71, 2], [2, 73, 2], [4, 75, 4], [8, 73, 6], [14, 71, 2]],
        [[0, 68, 2], [2, 71, 2], [4, 71, 2], [6, 73, 2], [8, 76, 4], [12, 75, 4]],
        [[0, 73, 2], [2, 71, 2], [4, 71, 4], [8, 68, 4], [12, 66, 4]],
        [[0, 69, 2], [2, 71, 2], [4, 73, 2], [6, 76, 2], [8, 75, 4], [12, 73, 4]],
        [[0, 71, 4], [4, 73, 4], [8, 75, 8]]
      ];
      // The pre chorus climbs
      const PRE = [
        [[0, 73, 2], [2, 73, 2], [4, 73, 2], [6, 71, 2], [8, 73, 8]],
        [[0, 75, 2], [2, 75, 2], [4, 75, 2], [6, 73, 2], [8, 75, 8]],
        [[0, 76, 2], [2, 76, 2], [4, 76, 2], [6, 75, 2], [8, 76, 4], [12, 78, 4]],
        [[0, 78, 4], [4, 80, 4], [8, 78, 8]]
      ];
      // The chorus hook: a bouncing figure that repeats, then jumps up; the second time round it goes higher
      const C1 = [[0, 76, 2], [2, 76, 2], [4, 75, 2], [6, 76, 2], [8, 80, 4], [12, 78, 4]];
      const C2 = [[0, 78, 2], [2, 78, 2], [4, 76, 2], [6, 75, 2], [8, 75, 4], [12, 71, 4]];
      const C3 = [[0, 76, 2], [2, 76, 2], [4, 75, 2], [6, 76, 2], [8, 80, 2], [10, 81, 2], [12, 80, 4]];
      const C4 = [[0, 78, 4], [4, 76, 2], [6, 73, 2], [8, 76, 8]];
      const C8 = [[0, 78, 2], [2, 80, 2], [4, 81, 4], [8, 83, 8]];
      const HOOK = [C1, C2, C3, C4, C1, C2, C3, C8];
      // Bridge: a held, hopeful line
      const BRIDGE = [[[0, 73, 8], [8, 76, 8]], [[0, 75, 8], [8, 71, 8]], [[0, 73, 8], [8, 76, 8]], [[0, 78, 16]]];
      const RIFF = [0, 2, 4, 2, 5, 4, 3, 2];
      function play(i, t) {
        const bi = Math.floor(i / 16);
        const s = i % 16;
        const S = SONG[bi % SONG.length];
        const kd = S.kind;
        const tr = S.key;
        const C = S.c;
        const last = S.k === S.n - 1;
        const fill = last && s >= 12 && kd !== 'outro' && kd !== 'build';
        const big = kd === 'chorus' || kd === 'final';
        const verse = kd === 'verse' || kd === 'verse2';
        // ---- Drums ----
        if (S.k === 0 && s === 0 && !verse) crash(t);
        if (big && S.k === 4 && s === 0) crash(t);
        if (fill) tom(t, [230, 190, 150, 120][s - 12], 0.9);
        else if (kd === 'intro') {
          if (s === 0 || s === 8) kick(t, 0.9);
          if (s === 4 || s === 12) snare(t, 0.7);
          if (s % 2 === 0) hat(t, 0.7);
        } else if (verse) {
          if (s === 0 || s === 7 || s === 8 || s === 10) kick(t, s === 7 ? 0.6 : 0.85);
          if (s === 4 || s === 12) { snare(t, 0.75); if (kd === 'verse2') clap(t); }
          if (s % 2 === 0) hat(t, s % 4 === 0 ? 0.8 : 0.55);
        } else if (kd === 'pre') {
          if (s % 4 === 0) kick(t, 0.9);
          if (s === 4 || s === 12 || (S.k === 3 && s % 2 === 0 && s >= 8)) snare(t, 0.6 + S.k * 0.08);
          if (s % 2 === 0) hat(t, 0.7, s % 4 === 2);
        } else if (big) {
          if (s === 0 || s === 3 || s === 8 || s === 10) kick(t, 1);
          if (s === 4 || s === 12) { snare(t, 1); clap(t); }
          if (s % 2 === 0) hat(t, 0.8, s % 4 === 2);
        } else if (kd === 'bridge') {
          if (s === 0 || s === 6 || s === 8) kick(t, 0.8);
          if (s === 4 || s === 12) snare(t, 0.6);
          if (s % 2 === 0) hat(t, 0.55);
        } else if (kd === 'build') {
          if (s % 4 === 0) kick(t, 0.9);
          const every = S.k < 2 ? 4 : S.k === 2 ? 2 : 1;
          if (s % every === 0) snare(t, 0.4 + 0.15 * S.k + 0.02 * s);
        } else if (kd === 'outro') {
          if (S.k < 2) { if (s === 0 || s === 8) kick(t, 0.9); if (s === 4 || s === 12) snare(t, 0.8); if (s % 2 === 0) hat(t, 0.6); }
          else if (S.k === 2 && s === 0) { kick(t, 1); crash(t); }
        }
        if (verse && S.k % 2 === 1 && s === 14) playSample('hit', t, { power: 0.4, dest: bus });
        if (big && (S.k === 3 || S.k === 7) && s === 14) hey(t);
        // ---- Guitars ----
        const pw = C.pw + tr;
        if (kd === 'intro') {
          if (s % 2 === 0) pick(t, C.v[RIFF[s / 2]] + tr, 0.1);
          if (S.k >= 2 && s === 0) power(t, pw, STEP * 14, 0.07);
        } else if (verse) {
          // Bright picking up and down the chord, and a strummed chord on the twos and fours
          if (s % 2 === 0) pick(t, C.v[RIFF[s / 2]] + tr, 0.09);
          if (s === 4 || s === 12) C.v.slice(2).forEach(function (n, j) { pick(t + j * 0.01, n + tr, 0.035); });
        } else if (kd === 'pre') {
          if (s % 2 === 0) power(t, pw, STEP * 1.4, 0.06 + 0.012 * S.k);
        } else if (big) {
          if (s === 0) power(t, pw, STEP * 7, 0.11);
          else if (s >= 8 && s % 2 === 0) power(t, pw, STEP * 1.4, 0.08);
          if (s === 0 || s === 8) C.v.slice(2).forEach(function (n, j) { pick(t + j * 0.012, n + tr, 0.04); });
        } else if (kd === 'bridge') {
          if (s % 2 === 0) pick(t, C.v[[5, 3, 4, 2, 5, 3, 1, 2][s / 2]] + tr, 0.1);
          if (s === 0) power(t, pw, STEP * 15, 0.05);
        } else if (kd === 'build') {
          if (s % 2 === 0) power(t, pw, STEP * 1.3, 0.05 + 0.015 * S.k);
        } else if (kd === 'outro') {
          if (s === 0 && S.k < 3) power(t, pw, STEP * (S.k === 2 ? 30 : 7), 0.11);
          if (S.k < 2 && s >= 8 && s % 2 === 0) power(t, pw, STEP * 1.4, 0.08);
        }
        // ---- Bass ----
        const bn = C.bass + tr;
        if (big || kd === 'build' || kd === 'pre') { if (s % 2 === 0) osc(t, bn + (s === 14 && big ? 12 : 0), STEP * 1.6, ['sawtooth', 'sine'], 0.14, bus, 0.004, 0.08, 4); }
        else if (verse || kd === 'intro') { if (s % 4 === 0 || s === 14) osc(t, bn + (s === 12 && verse ? 7 : 0), STEP * (s === 14 ? 1.6 : 3.4), ['sawtooth', 'sine'], 0.13, bus, 0.004, 0.12, 4); }
        else if (kd === 'bridge') { if (s % 4 === 0) osc(t, bn, STEP * 3.6, ['sawtooth', 'sine'], 0.13, bus, 0.01, 0.2, 4); }
        else if (kd === 'outro' && S.k < 3 && s % 2 === 0 && (S.k < 2 || s === 0)) osc(t, bn, STEP * (S.k === 2 ? 28 : 1.6), ['sawtooth', 'sine'], 0.14, bus, 0.004, 0.1, 4);
        // ---- A soft pad under the chorus, pre chorus and bridge ----
        if (s === 0 && (big || kd === 'bridge' || kd === 'pre')) C.v.slice(2, 5).forEach(function (n) { osc(t, n + tr + 12, STEP * 16, ['triangle'], 0.018, bus, 0.3, 0.5, 0); });
        // ---- The melodies ----
        const line = (bar, peak, withBell) => bar.forEach(function (h) {
          if (h[0] !== s) return;
          if (peak) sing(t, h[1] + tr, h[2], peak);
          if (withBell) bell(t, h[1] + tr + 12, withBell);
        });
        if (kd === 'intro') line(HOOK[S.k], 0, 0.09);
        else if (verse) line(VERSE[S.k], kd === 'verse2' ? 0.1 : 0.09, 0);
        else if (kd === 'pre') line(PRE[S.k], 0.1, 0.03);
        else if (big) line(HOOK[S.k], 0.12, kd === 'final' ? 0.08 : 0.06);
        else if (kd === 'bridge') line(BRIDGE[S.k], 0.08, 0);
        else if (kd === 'outro' && S.k < 2) line(HOOK[S.k], 0.1, 0.07);
      }
      let i = 0;
      let next = ctx.currentTime + 0.12;
      const timer = setInterval(function () {
        if (!ctx || ctx.state !== 'running') { if (ctx) next = ctx.currentTime + 0.12; return; }
        if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
        while (next < ctx.currentTime + 0.3) {
          play(i, next);
          next += STEP;
          i++;
          // After the outro, back to the first verse (the intro plays once)
          if (i >= SONG.length * 16) i = VERSE_AT * 16;
        }
      }, 60);
      return function stop() {
        clearInterval(timer);
        bus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3);
        setTimeout(function () { try { bus.disconnect(); fb.disconnect(); room.disconnect(); } catch (e) { /* ignore */ } }, 2000);
      };
    },
    // Double thump at a pulse that a GP would want to discuss.
    heartbeat: function () {
      function beat() {
        if (muted || !ctx || ctx.state !== 'running') return;
        const t = ctx.currentTime + 0.01;
        tone(t, 0.12, 'sine', 70, 0.6, 0.004, 0.1, { freqEnd: 40 });
        tone(t + 0.16, 0.12, 'sine', 62, 0.45, 0.004, 0.1, { freqEnd: 38 });
      }
      beat();
      const id = setInterval(beat, 430);
      return function stop() { clearInterval(id); };
    }
  };

  function loop(name) {
    if (!ctx || !LOOPS[name]) return { stop: function () {}, dummy: true };
    resume();
    let stopFn = null;
    try { stopFn = LOOPS[name](); } catch (e) { stopFn = null; }
    const handle = {
      stop: function () {
        if (!loops.has(handle)) return;
        loops.delete(handle);
        if (stopFn) try { stopFn(); } catch (e) { /* ignore */ }
      }
    };
    loops.add(handle);
    return handle;
  }

  function stopLoops() {
    Array.from(loops).forEach(function (h) { h.stop(); });
  }

  global.RRAudio = {
    init: init,
    resume: resume,
    suspend: suspend,
    play: play,
    loop: loop,
    stopLoops: stopLoops,
    setMuted: setMuted,
    setHostMuted: setHostMuted,
    crowdLevel: crowdLevel,
    isMuted: function () { return muted; },
    activeLoops: function () { return loops.size; }
  };
})(window);

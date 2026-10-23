/* Racket Rage Tennis - cg.js
   The CrazyGames SDK, wrapped so the game never depends on it.
   The SDK only works on localhost and CrazyGames domains, and an ad blocker may stop it loading at all.
   Every call here is safe in all of those cases: without the SDK the game plays on, saves to localStorage,
   and offers no adverts.

   window.RRCG:
     ready                   -> Promise<boolean>   resolves once the SDK is initialised (true) or given up on (false)
     ok()                    -> boolean            the SDK is usable here
     gameplay(on)            -> report play starting or stopping (only sends a change)
     loadingStop()           -> the game has finished loading
     happytime()             -> a big moment (sparingly: a trophy, the Grand Slam)
     getItem(k), setItem(k, v) -> the save: the SDK Data Module first, localStorage as the fallback and copy
     onMute(fn)              -> fn(muted) now and whenever CrazyGames' own mute setting changes
     adsLive                 -> false for Basic Launch (adverts are disabled there). Set true for Full Launch.

   window.RRAds (the same interface the Android build's admob.js had, so the game code is unchanged):
     init(), warm(), prepareRewarded(), isReady(), isNative(), onStateChange(fn)
     showRewarded({ onStart }) -> Promise<{ rewarded, reason? }>
*/
(function (global) {
  'use strict';

  const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
  const WAIT_MS = 3000;          // the most the game waits for the SDK before starting without it
  let sdk = null;                // window.CrazyGames.SDK once initialised and usable
  let playing = false;
  const muteFns = [];
  let hostMuted = false;

  function log() { if (/[?&]rrdebug\b/.test(location.search)) console.log.apply(console, ['[cg]'].concat([].slice.call(arguments))); }

  const ready = new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok); };
    // Preview build: the SDK only loads on CrazyGames itself. On any other host the game starts at once, without it,
    // and saves to this device only.
    if (!/(^|\.)crazygames\.[a-z.]+$/.test(location.hostname)) { finish(false); return; }
    setTimeout(() => finish(false), WAIT_MS);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.onerror = () => { log('SDK did not load (blocked or offline)'); finish(false); };
    s.onload = () => {
      const S = global.CrazyGames && global.CrazyGames.SDK;
      if (!S) { finish(false); return; }
      Promise.resolve()
        .then(() => S.init())
        .then(() => {
          // 'disabled' means a domain the SDK refuses: every call would throw there
          if (S.environment !== 'local' && S.environment !== 'crazygames') { log('SDK environment', S.environment); finish(false); return; }
          sdk = S;
          log('SDK ready, environment', S.environment);
          try { S.game.loadingStart(); } catch (e) { /* ignore */ }
          try {
            hostMuted = !!(S.game.settings && S.game.settings.muteAudio);
            S.game.addSettingsChangeListener((st) => { hostMuted = !!(st && st.muteAudio); muteFns.forEach((f) => f(hostMuted)); });
          } catch (e) { /* ignore */ }
          finish(true);
        })
        .catch((e) => { log('SDK init failed', e); finish(false); });
    };
    document.head.appendChild(s);
  });

  const call = (fn) => { if (!sdk) return; try { fn(sdk); } catch (e) { log('SDK call failed', e); } };

  const RRCG = {
    ready: ready,
    adsLive: false,   // Basic Launch: CrazyGames disables adverts. Flip to true for Full Launch.
    ok: () => !!sdk,
    gameplay(on) {
      on = !!on;
      if (on === playing) return;
      playing = on;
      call((S) => (on ? S.game.gameplayStart() : S.game.gameplayStop()));
    },
    loadingStop() { call((S) => S.game.loadingStop()); },
    happytime() { call((S) => S.game.happytime()); },
    // The SDK's copy and this device's copy: the newer one wins. The SDK saves up to a second after a change,
    // so a tab closed straight after a save can leave the SDK copy behind. Saves carry their time in _at.
    getItem(k) {
      let a = null;
      let b = null;
      if (sdk) { try { a = sdk.data.getItem(k); } catch (e) { a = null; } }
      try { b = localStorage.getItem(k); } catch (e) { b = null; }
      if (!a || !b) return a || b || null;
      const at = (v) => { try { return JSON.parse(v)._at || 0; } catch (e) { return 0; } };
      return at(b) > at(a) ? b : a;
    },
    setItem(k, v) {
      call((S) => S.data.setItem(k, v));
      // A copy on this device too: if the SDK is blocked next time, the save is still here
      try { localStorage.setItem(k, v); } catch (e) { /* storage full or blocked: play on */ }
    },
    onMute(fn) { muteFns.push(fn); fn(hostMuted); }
  };

  // Rewarded adverts through the SDK. With adsLive false, nothing is ever shown and the game hides every offer.
  const listeners = [];
  const RRAds = {
    init() { return Promise.resolve(); },
    warm() {},
    prepareRewarded() { return Promise.resolve(RRCG.adsLive && !!sdk); },
    isReady() { return RRCG.adsLive && !!sdk; },
    isNative() { return false; },
    onStateChange(fn) { listeners.push(fn); },
    showRewarded(opts) {
      opts = opts || {};
      return new Promise((resolve) => {
        if (!RRCG.adsLive || !sdk) { resolve({ rewarded: false, reason: 'unavailable' }); return; }
        let settled = false;
        const end = (r) => { if (settled) return; settled = true; muteFns.forEach((f) => f(hostMuted)); resolve(r); };
        try {
          sdk.ad.requestAd('rewarded', {
            // CrazyGames asks for the game to be silent and paused while an advert plays
            adStarted: () => { muteFns.forEach((f) => f(true)); if (opts.onStart) opts.onStart(); },
            adFinished: () => end({ rewarded: true }),
            adError: (err) => end({ rewarded: false, reason: (err && err.code) || 'error' })
          });
        } catch (e) { end({ rewarded: false, reason: 'error' }); }
      });
    }
  };

  global.RRCG = RRCG;
  global.RRAds = RRAds;
})(window);

// Synthesised with the Web Audio API rather than shipped as files: every cue
// here is a short blip, and generating them costs nothing to download and
// nothing to load on a phone connection.
//
// Browsers won't let audio start before a user gesture, which is fine — the
// first thing anyone does is tap a lobby button, and that unlocks it.

const Sound = (() => {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const STORAGE_KEY = '321futbol.muted';

  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem(STORAGE_KEY) === '1';
  } catch (err) {
    muted = false; // private mode, blocked storage — just default to sound on
  }

  function context() {
    if (!AudioCtx) return null;
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq, dur = 0.12, type = 'sine', gain = 0.07, delay = 0, sweepTo = null }) {
    if (muted) return;
    const c = context();
    if (!c) return;

    const start = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + dur);

    // Ramps rather than hard starts/stops, otherwise every blip clicks.
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    osc.connect(amp).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  return {
    unlock: () => context(),

    isMuted: () => muted,
    toggleMute() {
      muted = !muted;
      try {
        localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
      } catch (err) {
        // not persisting is survivable
      }
      if (!muted) tone({ freq: 660, dur: 0.08, type: 'triangle' });
      return muted;
    },

    tick: () => tone({ freq: 430, dur: 0.07, type: 'square', gain: 0.05 }),
    go: () => tone({ freq: 760, dur: 0.2, type: 'square', gain: 0.09, sweepTo: 1140 }),
    lock: () => tone({ freq: 600, dur: 0.06, type: 'triangle', gain: 0.05 }),
    opponentReady: () => tone({ freq: 520, dur: 0.09, type: 'triangle', gain: 0.05 }),

    win() {
      tone({ freq: 660, dur: 0.1, type: 'triangle', gain: 0.08 });
      tone({ freq: 990, dur: 0.22, type: 'triangle', gain: 0.08, delay: 0.09 });
    },
    lose: () => tone({ freq: 170, dur: 0.28, type: 'sawtooth', gain: 0.06, sweepTo: 110 }),
    reject: () => tone({ freq: 220, dur: 0.1, type: 'square', gain: 0.05 }),

    gameWin() {
      [0, 0.12, 0.24].forEach((delay, i) => {
        tone({ freq: 620 + i * 220, dur: 0.16, type: 'triangle', gain: 0.09, delay });
      });
    },
    gameLose() {
      tone({ freq: 300, dur: 0.18, type: 'sawtooth', gain: 0.06 });
      tone({ freq: 160, dur: 0.35, type: 'sawtooth', gain: 0.06, delay: 0.16 });
    },
  };
})();

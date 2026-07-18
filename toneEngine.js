// Native tone engine.
//
// The tone is computed sample-by-sample as pure math (identical to what Web
// Audio does) and played through expo-audio's native player. This avoids the
// WebView audio thread that Android power-parks, which is the crackle source.
//
// The key to a click-free continuous tone is a CYCLE-ALIGNED loop: the buffer
// must contain a whole number of wave cycles so the loop point wraps at exactly
// the same phase, with no discontinuity.
//
// IMPORTANT (cost 2 wasted builds): expo-audio is FINE on SDK 54, but the app
// MUST pin `expo-asset` (~12.0.13) in package.json. Without the pin, npm
// resolves expo-asset to 57.x, which is built against a newer expo-modules-core
// and dies natively at launch with:
//   NoClassDefFoundError: Lexpo/modules/kotlin/types/AnyTypeCache (AssetModule)
// Verify with `npm ls expo-asset`: it must show ONE deduped 12.0.x copy.
//
// NOTE: `AudioPlayer` is a TYPE-only export in expo-audio. Importing it as a
// value throws at module load. Only import real runtime values here.
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

const SR = 44100; // sample rate

let player = null;
let current = null; // last params, to avoid needless rebuilds

// ---- WAV encoding (16-bit PCM stereo) ----
function encodeWav(left, right) {
  const n = left.length;
  const bytesPerSample = 2;
  const blockAlign = 2 * bytesPerSample; // stereo
  const dataLen = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, SR, true);
  view.setUint32(28, SR * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(o, l < 0 ? l * 0x8000 : l * 0x7fff, true); o += 2;
    view.setInt16(o, r < 0 ? r * 0x8000 : r * 0x7fff, true); o += 2;
  }
  return buf;
}

// base64 (no Buffer in RN by default; small manual encoder)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

// NOTE: bowls are NOT handled here. The bowl is a real recording played by the
// WebView itself (see index.html): it is a short struck sample, so it never had
// the sustained-tone crackle this native engine exists to fix. Keeping it in one
// place stops the two implementations drifting apart.

// waveform sample at phase p (0..1)
function waveSample(type, p) {
  switch (type) {
    case 'square':   return p < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * p - 1;
    case 'triangle': return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 'sine':
    default:         return Math.sin(2 * Math.PI * p);
  }
}

// Loop length holding a whole number of cycles of `hz`. Naively rounding
// cycles*cycleSamples breaks alignment (the rounding error IS a phase jump), so
// we search cycle counts for one landing closest to a whole sample.
function loopLenForCycle(hz) {
  const cycleSamples = SR / hz;
  const targetCycles = Math.max(1, Math.round((SR * 0.5) / cycleSamples));
  let best = null, bestErr = Infinity;
  const lo = Math.max(1, targetCycles - 200), hi = targetCycles + 200;
  for (let c = lo; c <= hi; c++) {
    const exact = c * cycleSamples;
    const err = Math.abs(exact - Math.round(exact));
    if (err < bestErr) { bestErr = err; best = Math.round(exact); }
    if (err < 1e-9) break;
  }
  return best;
}

// Loop length holding whole cycles of BOTH frequencies (binaural: each ear gets
// a different tone). Aligning only to the beat period is NOT enough.
function loopLenForPair(f1, f2) {
  let best = Math.round(SR * 0.5), bestErr = Infinity;
  const minLen = Math.round(SR * 0.25);
  const maxLen = Math.round(SR * 4);
  for (let len = minLen; len <= maxLen; len++) {
    const p1 = (f1 * len / SR) % 1;
    const p2 = (f2 * len / SR) % 1;
    const err = Math.min(p1, 1 - p1) + Math.min(p2, 1 - p2);
    if (err < bestErr) { bestErr = err; best = len; if (err < 1e-7) break; }
  }
  return best;
}

// Build the looping buffer for the given params. Returns {left,right,len}.
function buildBuffer(p) {
  const { freq, wave, vol, mode, beat, isoRate } = p;

  if (mode === 'binaural') {
    const len = loopLenForPair(freq, freq + beat);
    const left = new Float32Array(len), right = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      left[i]  = waveSample(wave, (freq * i / SR) % 1) * vol;
      right[i] = waveSample(wave, ((freq + beat) * i / SR) % 1) * vol;
    }
    return { left, right, len };
  }

  if (mode === 'iso') {
    // single tone amplitude-modulated by a smooth (triangle) pulse at isoRate.
    // A square gate would click on every pulse; triangle ramps instead.
    const pulseLen = Math.round(SR / isoRate);
    const len = pulseLen * Math.max(1, Math.round((SR * 0.5) / pulseLen));
    const left = new Float32Array(len), right = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const carrier = waveSample(wave, (freq * i / SR) % 1);
      const tri = waveSample('triangle', (isoRate * i / SR) % 1);
      const s = carrier * (0.5 + 0.5 * tri) * vol;
      left[i] = s; right[i] = s;
    }
    return { left, right, len };
  }

  // plain sustained tone
  const len = loopLenForCycle(freq);
  const left = new Float32Array(len), right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = waveSample(wave, (freq * i / SR) % 1) * vol;
    left[i] = s; right[i] = s;
  }
  return { left, right, len };
}

function sameParams(a, b) {
  if (!a || !b) return false;
  return a.freq === b.freq && a.wave === b.wave && a.vol === b.vol &&
         a.mode === b.mode && a.beat === b.beat && a.isoRate === b.isoRate;
}

export async function ensureAudioMode() {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    });
  } catch (e) {}
}

// Kill a player properly: pause FIRST, then release. Calling remove() on a
// playing player does not reliably stop the sound.
function destroy(p) {
  if (!p) return;
  try { p.pause(); } catch (e) {}
  try { p.remove(); } catch (e) {}
}

// Every player we have ever created that might still be sounding. Belt and
// braces: if a race ever orphans one, this still finds and kills it.
const livePlayers = new Set();
function killAll() {
  for (const p of livePlayers) destroy(p);
  livePlayers.clear();
  player = null;
}

// Guards against overlapping async builds. Building + base64-encoding a stereo
// buffer takes real time, so tapping voice A then voice B starts TWO builds.
// Without this token the slower one finishes last, overwrites `player`, and the
// other keeps looping forever with nothing referencing it (the "they all play
// and won't stop" bug).
let playToken = 0;

export async function playTone(params) {
  // The bowl is a struck sample played by the WebView, never a native loop.
  // If it ever reaches here, looping it would produce a continuous drone that
  // never fades and never re-strikes (that exact bug shipped once). Refuse.
  if (params && params.wave === 'bowl') { stopTone(); return; }
  if (sameParams(current, params) && player && player.playing) return;
  current = { ...params };

  const myToken = ++playToken;

  // Silence everything immediately, before the slow build, so the old voice
  // stops the moment you tap rather than when the new one is ready.
  killAll();

  const { left, right } = buildBuffer(params);
  const b64 = toBase64(encodeWav(left, right));
  const uri = 'data:audio/wav;base64,' + b64;

  // A newer tap superseded us while we were building: abandon this one.
  if (myToken !== playToken) return;

  // Anything that slipped through during the build.
  killAll();

  const p = createAudioPlayer({ uri });
  p.loop = true;
  p.volume = 1.0;
  livePlayers.add(p);
  player = p;
  p.play();
}

export function stopTone() {
  current = null;
  playToken++;      // invalidate any in-flight build
  killAll();
}

export function updateVolume(v) {
  if (player) { try { player.volume = Math.max(0, Math.min(1, v)); } catch (e) {} }
}

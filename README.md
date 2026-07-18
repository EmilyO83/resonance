# Resonance

A cross-platform sound-frequency generator and maker's guide, built with React Native + Expo. It generates clean, artefact-free tones in real time (Solfeggio frequencies, binaural beats, isochronic pulses, and a real recorded singing bowl), and includes illustrated guides for building orgone devices and tensor rings.

Runs on **Android** as a native app and in any **web browser** from a single self-contained HTML file. Fully offline. No accounts, no backend, no tracking.

---

## Why it exists

Most "healing frequency" tracks online are compressed audio uploads: MP3s and video re-encodes riddled with codec artefacts and aliasing. If you want a clean 528 Hz tone, you shouldn't have to hunt through hours of distorted uploads. Resonance **synthesises** the tone live instead of playing a recording, so it's mathematically pure every time.

## Features

- **Frequency generator** with sine / triangle / square / saw waveforms, a fine-tune slider, and exact-Hz entry
- **Grouped preset library** — the full Solfeggio set, Schumann resonance, tuning references
- **Binaural beats** — a slightly different tone in each ear; the brain perceives the difference as a pulse (needs headphones)
- **Isochronic pulses** — a single tone gated on and off; works on speakers, no headphones needed
- **Sweep mode** — glide smoothly between two frequencies over a set duration
- **Sleep timer** with a gentle fade-out
- **Singing bowl** — a real Tibetan bowl recording (public domain), retuned to the chosen frequency and struck repeatedly with overlapping natural decay
- **Save favourites** and a **session journal**, stored locally on the device
- **Maker's guides** — step-by-step orgone and tensor-ring instructions with an interactive sacred-cubit length calculator
- **Accessibility & polish** — focus mode, low-frequency speaker warnings, dark theme throughout

## Engineering highlights

This is a small app with some genuinely interesting problems under the hood.

### Click-free, artefact-free synthesis
Tones are generated sample-by-sample with the Web Audio API. Gain envelopes ramp on start and stop so there are no clicks, and a limiter guards against clipping. No compression, no re-encoding, no aliasing.

### Cycle-aligned looping
The native tone engine ([`toneEngine.js`](toneEngine.js)) plays a looping PCM buffer. For the loop to be seamless, the buffer must contain a **whole number of wave cycles**, or every loop point produces an audible tick. The engine searches for a cycle count that lands on an exact sample boundary, and handles the harder cases: binaural (two frequencies that must *both* complete whole cycles) and isochronic (carrier plus modulation). Verified across the full frequency range with a seam-continuity test.

### WebView vs native audio — a deliberate split
The app is one HTML document wrapped in a WebView. On Android, the WebView's audio thread gets **power-parked** during long sustained tones, which causes intermittent crackle. The fix: sustained tones are generated in the **native** layer (`expo-audio`), which Android doesn't starve, while the WebView acts as a remote control that posts audio state to native. Short struck samples (the bowl) stay in the WebView, since they never trigger the parking behaviour. One audio implementation per problem, chosen for the right reason.

### Real instrument, honestly scoped
The singing bowl is an actual recording (~297 Hz), retuned by playback rate. Retuning only sounds convincing within about 0.7×–1.6×, so the bowl is **only offered on frequencies where it still sounds real** and hidden elsewhere, rather than shipping a chipmunk version everywhere.

### Single-source, offline-first
The entire UI and browser audio engine live in one `web/index.html`. A small build step ([`build-html.js`](build-html.js)) inlines it into the app bundle, so the packaged Android app and the browser version are always in sync and both work with zero network access.

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | React Native 0.81 + Expo SDK 54 |
| Audio (web) | Web Audio API (live synthesis) |
| Audio (native) | expo-audio (cycle-aligned PCM loops) |
| Shell | react-native-webview |
| Screen wake | expo-keep-awake (only while a tone plays) |
| Build | EAS / local Gradle |

## Project structure

```
web/index.html      The whole app: UI + Web Audio engine (single file)
App.js              WebView host; bridges audio state to the native engine
toneEngine.js       Native tone synthesis (cycle-aligned looping buffers)
build-html.js       Inlines web/index.html into appHtml.js for the bundle
make-icon.js        Dependency-free PNG app-icon generator
check-imports.js    Guards against importing type-only exports (crash safety)
app.json / eas.json Expo + build configuration
```

## Running it

**In a browser** — no build required:

```bash
open web/index.html      # or just double-click it
```

**On Android** — build an APK locally:

```bash
npm install
npm run apk              # builds android/app/build/outputs/apk/release/app-release.apk
npm run apk:install      # installs to a USB-connected device
```

**Live on a device via Expo Go** (JS changes reload instantly):

```bash
npm run phone
```

After editing `web/index.html`, run `node build-html.js` to sync it into the native bundle.

## Notes

- The frequency and wellbeing content is for personal / experiential use. It is not a medical device and does not replace professional care.
- Audio assets are public domain (Wikimedia Commons). All synthesis is original.

## License

MIT

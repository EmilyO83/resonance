import React, { useCallback, useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { HTML } from './appHtml';
import { ensureAudioMode, playTone, stopTone, updateVolume } from './toneEngine';

// The HTML is the UI + remote control. It does NOT synthesize audio itself
// (Android power-parks WebView audio, which is what causes the crackle).
// It posts JSON audio state; we generate the tone natively here.
export default function App() {
  useEffect(() => { ensureAudioMode(); }, []);

  // A single tap in the UI can fire play + update + update (applyFreq,
  // rebuildLive and play all report state). Building a buffer is slow, so
  // firing one per message stacks up overlapping tones. Coalesce a burst of
  // messages into ONE build using the last state received.
  const pending = useRef(null);
  const timer = useRef(null);
  const webref = useRef(null);

  // --- Native Sleep Cycles scheduler ---------------------------------------
  // Sleep Cycles used to be scheduled by setTimeout/setInterval INSIDE the
  // WebView. Android freezes WebView JS timers when the screen sleeps, so the
  // fade-back-in after a rest gap never fired and the tone stayed silent all
  // night. We run the whole sequence here in the RN runtime instead: these
  // timers keep firing off-screen, and combined with shouldPlayInBackground
  // the tone survives a locked / dozing phone. The WebView only owns the UI
  // readout now; if its timers freeze, the audio is unaffected.
  const cyc = useRef(null); // { params, on, gap, fade, num, targetVol, index, phase, fadeStep, phaseTimer }

  const cycClear = () => {
    const c = cyc.current;
    if (!c) return;
    if (c.fadeStep) { clearInterval(c.fadeStep); c.fadeStep = null; }
    if (c.phaseTimer) { clearTimeout(c.phaseTimer); c.phaseTimer = null; }
  };

  const cycStopAll = () => {
    cycClear();
    cyc.current = null;
    stopTone();
    deactivateKeepAwake('tone').catch(() => {});
  };

  // Report the live phase back to the WebView so its dots/countdown follow the
  // native clock (purely cosmetic; audio does not depend on it).
  const cycReport = (phase, index, num, msLeft) => {
    try {
      webref.current && webref.current.postMessage(
        JSON.stringify({ cyc: 'phase', phase, index, num, msLeft })
      );
    } catch (e) {}
  };

  // Ramp the native player's volume from `from` to `to` over `mins`, then done().
  const cycFade = (from, to, mins, done) => {
    const c = cyc.current;
    if (!c) return;
    if (c.fadeStep) { clearInterval(c.fadeStep); c.fadeStep = null; }
    const totalMs = Math.max(500, mins * 60000);
    const start = Date.now();
    updateVolume(from);
    c.fadeStep = setInterval(() => {
      if (!cyc.current) return;
      const t = Math.min(1, (Date.now() - start) / totalMs);
      updateVolume(from + (to - from) * t);
      if (t >= 1) { clearInterval(c.fadeStep); c.fadeStep = null; if (done) done(); }
    }, 500);
  };

  // Advance the cycle state machine: in -> hold -> out -> rest -> (next) in.
  const cycNext = () => {
    const c = cyc.current;
    if (!c) return;
    cycClear();

    if (c.phase === '') {
      // first cycle: start the tone silent, fade in
      c.index = 0;
      playTone({ ...c.params, vol: 1 }).catch(() => {});
      updateVolume(0.0001);
      c.phase = 'in';
      cycReport('in', c.index, c.num, c.fade * 60000);
      cycFade(0.0001, c.targetVol, c.fade, cycNext);
    } else if (c.phase === 'in') {
      const holdMin = Math.max(0, c.on - 2 * c.fade);
      c.phase = 'hold';
      cycReport('hold', c.index, c.num, holdMin * 60000);
      c.phaseTimer = setTimeout(cycNext, holdMin * 60000);
    } else if (c.phase === 'hold') {
      c.phase = 'out';
      cycReport('out', c.index, c.num, c.fade * 60000);
      cycFade(c.targetVol, 0.0001, c.fade, cycNext);
    } else if (c.phase === 'out') {
      // fade-out done: go TRULY silent for the rest gap. Background audio keeps
      // the session alive across the gap, so we can genuinely stop the tone
      // (no all-night inaudible loop) and restart it for the next fade-in.
      stopTone();
      if (c.index >= c.num - 1) { cycFinish(); return; }
      c.phase = 'rest';
      cycReport('rest', c.index, c.num, c.gap * 60000);
      c.phaseTimer = setTimeout(cycNext, c.gap * 60000);
    } else if (c.phase === 'rest') {
      c.index++;
      playTone({ ...c.params, vol: 1 }).catch(() => {});
      updateVolume(0.0001);
      c.phase = 'in';
      cycReport('in', c.index, c.num, c.fade * 60000);
      cycFade(0.0001, c.targetVol, c.fade, cycNext);
    }
  };

  const cycFinish = () => {
    cycStopAll();
    try {
      webref.current && webref.current.postMessage(JSON.stringify({ cyc: 'done' }));
    } catch (e) {}
  };

  const flush = useCallback(() => {
    timer.current = null;
    const msg = pending.current;
    pending.current = null;
    if (msg) playTone(msg).catch(() => {});
  }, []);

  const onMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch (e) { return; }

    if (msg.type === 'cycle') {
      // Start (or restart) a native Sleep Cycles run. Keep-awake still helps on
      // devices without a solid background-audio session; background mode is the
      // real guarantee.
      activateKeepAwakeAsync('tone').catch(() => {});
      cycStopAll();
      cyc.current = {
        params: { freq: msg.freq, wave: msg.wave, mode: msg.mode, beat: msg.beat, isoRate: msg.isoRate },
        on: msg.on, gap: msg.gap, fade: msg.fade, num: msg.num,
        targetVol: Math.max(0.01, Math.min(1, msg.targetVol)),
        index: 0, phase: '', fadeStep: null, phaseTimer: null,
      };
      cycNext();
      return;
    }

    if (msg.type === 'cycleStop') {
      cycStopAll();
      return;
    }

    if (msg.type === 'play' || msg.type === 'update') {
      // A plain play/update overrides any running cycle.
      if (cyc.current) { cycClear(); cyc.current = null; }
      if (msg.type === 'play') activateKeepAwakeAsync('tone').catch(() => {});
      pending.current = msg;                       // keep only the newest state
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 60);       // one build per burst
    } else if (msg.type === 'stop') {
      deactivateKeepAwake('tone').catch(() => {});
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current = null;                      // cancel any queued build
      if (cyc.current) { cycClear(); cyc.current = null; }
      stopTone();
    }
  }, [flush]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
        ref={webref}
        originWhitelist={['*']}
        source={{ html: HTML, baseUrl: 'https://resonance.local/' }}
        style={styles.web}
        onMessage={onMessage}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        domStorageEnabled
        javaScriptEnabled
        cacheEnabled
        setSupportMultipleWindows={false}
        overScrollMode="never"
        bounces={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f1a' },
  web: { flex: 1, backgroundColor: '#0b0f1a' },
});

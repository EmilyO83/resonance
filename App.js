import React, { useCallback, useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { HTML } from './appHtml';
import { ensureAudioMode, playTone, stopTone } from './toneEngine';

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

  const flush = useCallback(() => {
    timer.current = null;
    const msg = pending.current;
    pending.current = null;
    if (msg) playTone(msg).catch(() => {});
  }, []);

  const onMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch (e) { return; }

    if (msg.type === 'play' || msg.type === 'update') {
      if (msg.type === 'play') activateKeepAwakeAsync('tone').catch(() => {});
      pending.current = msg;                       // keep only the newest state
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 60);       // one build per burst
    } else if (msg.type === 'stop') {
      deactivateKeepAwake('tone').catch(() => {});
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current = null;                      // cancel any queued build
      stopTone();
    }
  }, [flush]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
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

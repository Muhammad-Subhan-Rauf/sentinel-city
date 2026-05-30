// App-wide crash catcher. Instead of a bare red screen (dev) or a silent white
// screen (production), this renders the actual error message + component stack
// and logs the full error to the Metro console. Self-contained styling (no
// theme/hooks) so it still works even when the theme or a provider is what threw.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

type Props = { children: React.ReactNode };
type State = { error: Error | null; info: { componentStack?: string } | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Surfaces in the Metro terminal (npm/expo logs) and any remote logger.
    console.error('[Sentinel] Render crash:', error?.message, '\n', error?.stack, '\n', info?.componentStack);
    this.setState({ info });
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.kicker}>SENTINEL · APP ERROR</Text>
          <Text style={styles.title}>Something crashed while rendering</Text>
          <Text style={styles.message}>{error.message || String(error)}</Text>

          {error.stack ? (
            <>
              <Text style={styles.sectionLabel}>Stack</Text>
              <Text style={styles.stack}>{error.stack}</Text>
            </>
          ) : null}

          {info?.componentStack ? (
            <>
              <Text style={styles.sectionLabel}>Component tree</Text>
              <Text style={styles.stack}>{info.componentStack.trim()}</Text>
            </>
          ) : null}

          <Pressable onPress={this.reset} style={styles.button}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
          <Text style={styles.hint}>
            This message is also printed in your Metro / `expo start` terminal. Fix the file and save —
            Fast Refresh will reload.
          </Text>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0E17' },
  content: { padding: 24, paddingTop: 72 },
  kicker: { color: '#FF4D57', fontSize: 11, letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },
  title: { color: '#F4F7FF', fontSize: 22, fontWeight: '800', marginBottom: 16 },
  message: { color: '#FF8089', fontSize: 14, lineHeight: 20, fontFamily: 'monospace' },
  sectionLabel: { color: '#8895B0', fontSize: 11, letterSpacing: 1.2, fontWeight: '700', marginTop: 20, marginBottom: 6, textTransform: 'uppercase' },
  stack: { color: '#AEBAD4', fontSize: 11, lineHeight: 17, fontFamily: 'monospace' },
  button: { backgroundColor: '#4C8DFF', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 28 },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  hint: { color: '#8895B0', fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: 'center' },
});

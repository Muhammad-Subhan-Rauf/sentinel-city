import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider, useTheme } from '@/theme';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { installGlobalErrorLogging, log } from '@/lib/logging';
import RootNavigator from '@/navigation/RootNavigator';

// Catch uncaught JS errors / promise rejections at startup so they print to the
// Metro (`expo start`) terminal instead of disappearing.
installGlobalErrorLogging();

// Load Atkinson Hyperlegible in the background. We do NOT block the UI on it —
// rendering immediately means a font-load hang can never trap the user on a
// blank/spinner screen; text simply falls back to the system font and swaps to
// Atkinson once the hook resolves and re-renders.
function Root() {
  const t = useTheme();
  const [fontsLoaded, fontError] = useFonts({
    AtkinsonHyperlegible: require('@/assets/fonts/AtkinsonHyperlegible-Regular.ttf'),
    'AtkinsonHyperlegible-Bold': require('@/assets/fonts/AtkinsonHyperlegible-Bold.ttf'),
  });

  useEffect(() => {
    log('boot · scheme:', t.scheme, '· fonts:', fontsLoaded ? 'loaded' : fontError ? 'error (system fallback)' : 'loading');
    if (fontError) console.warn('[Sentinel] font load failed (using system font):', fontError);
  }, [t.scheme, fontsLoaded, fontError]);

  return (
    <AuthProvider>
      <StatusBar style={t.scheme === 'light' ? 'dark' : 'light'} />
      <RootNavigator />
    </AuthProvider>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <ThemeProvider>
            <Root />
          </ThemeProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

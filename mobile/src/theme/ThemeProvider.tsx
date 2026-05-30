// Theme context. Resolves the active color scheme from the OS (reactive via
// useColorScheme) and exposes a fully-resolved `Theme` object plus a live
// `reduceMotion` flag so every component animates responsibly.
//
// Usage:  const t = useTheme();  t.color.surface  /  t.spacing.lg  /  t.scheme

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import {
  ColorTokens,
  darkColors,
  lightColors,
  duration,
  fonts,
  fontSize,
  lineHeight,
  makeShadow,
  radius,
  spacing,
  zIndex,
} from './tokens';

export type Scheme = 'dark' | 'light';

export type Theme = {
  scheme: Scheme;
  color: ColorTokens;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  lineHeight: typeof lineHeight;
  fonts: typeof fonts;
  duration: typeof duration;
  zIndex: typeof zIndex;
  /** Drop-shadow / glow for an elevation level, scheme-aware. */
  shadow: (level: 0 | 1 | 2 | 3) => object;
  /** Severity (1-5) → color, clamped. */
  severityColor: (sev: number) => string;
  /** True when the user has asked the OS to minimise motion. */
  reduceMotion: boolean;
};

function buildTheme(scheme: Scheme, reduceMotion: boolean): Theme {
  const color = scheme === 'light' ? lightColors : darkColors;
  return {
    scheme,
    color,
    spacing,
    radius,
    fontSize,
    lineHeight,
    fonts,
    duration,
    zIndex,
    shadow: (level) => makeShadow(level, scheme),
    severityColor: (sev) => color.severity[Math.max(1, Math.min(5, Math.round(sev))) - 1],
    reduceMotion,
  };
}

const ThemeCtx = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const osScheme = useColorScheme();
  const scheme: Scheme = osScheme === 'light' ? 'light' : 'dark';
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => mounted && setReduceMotion(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) =>
      setReduceMotion(!!v),
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const theme = useMemo(() => buildTheme(scheme, reduceMotion), [scheme, reduceMotion]);

  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeCtx);
  if (!t) throw new Error('useTheme must be used inside <ThemeProvider>');
  return t;
}

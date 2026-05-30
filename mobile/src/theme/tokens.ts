// ─────────────────────────────────────────────────────────────────────────
// Design tokens — the single source of truth for the whole app.
//
// Two complete palettes (dark + light) so every surface, text level and accent
// has a defined value in both modes. Components never reference raw hex; they
// read semantic tokens off the active theme (see ThemeProvider) so light/dark
// parity is automatic and WCAG-AAA contrast is preserved in both.
// ─────────────────────────────────────────────────────────────────────────

// ── Non-color scales (shared across both themes) ──────────────────────────

// 4-pt spacing rhythm. Use these everywhere instead of magic numbers so the
// vertical/horizontal rhythm stays consistent.
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 56,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

// Type scale. 16 is the comfortable mobile body minimum (avoids iOS auto-zoom
// on inputs); nothing meaningful drops below 13.
export const fontSize = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  display: 34,
} as const;

export const lineHeight = {
  xs: 16,
  sm: 18,
  base: 22,
  md: 24,
  lg: 26,
  xl: 30,
  xxl: 36,
  display: 42,
} as const;

// Atkinson Hyperlegible ships exactly two weights (400 / 700). We lean on those
// two families plus size to build hierarchy, rather than synthetic weights.
export const fonts = {
  regular: 'AtkinsonHyperlegible',
  bold: 'AtkinsonHyperlegible-Bold',
  // Tabular monospace for coordinates / counts / timers so columns don't jitter.
  mono: 'monospace',
} as const;

// Motion durations (ms). Micro-interactions live in fast/base; nothing UI-driven
// should exceed `slow`. All are bypassed when reduce-motion is on.
export const duration = {
  instant: 0,
  fast: 140,
  base: 200,
  slow: 300,
  slower: 440,
} as const;

// Layered z-index scale so overlays never fight.
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 20,
  overlay: 40,
  banner: 100,
  toast: 1000,
} as const;

// ── Color tokens ───────────────────────────────────────────────────────────

export type ColorTokens = {
  // Surfaces (back-to-front)
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceHover: string;
  overlay: string; // modal scrim

  // Lines
  border: string;
  borderStrong: string;
  divider: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  // Action / brand (safety blue)
  primary: string;
  primaryStrong: string;
  primarySoft: string;
  onPrimary: string;

  // Status
  danger: string;
  dangerStrong: string;
  dangerSoft: string;
  onDanger: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  info: string;
  infoSoft: string;

  // Focus ring
  focus: string;

  // Role accents (mirror the web operator console)
  citizen: string;
  worker: string;
  admin: string;
  firefighter: string;
  paramedic: string;
  police: string;

  // Hazard polygons (match the basemap palette)
  hazardNotification: string;
  hazardCordon: string;

  // Severity ramp 1→5 (low→critical). Always paired with an icon + label in UI
  // so meaning is never carried by color alone.
  severity: [string, string, string, string, string];

  // Pure values that stay constant regardless of theme (e.g. text on a colored
  // chip that is always saturated).
  alwaysWhite: string;
};

export const darkColors: ColorTokens = {
  bg: '#0A0E17',
  surface: '#121826',
  surfaceAlt: '#1A2236',
  surfaceHover: '#222C44',
  overlay: 'rgba(4,7,14,0.74)',

  border: '#28324A',
  borderStrong: '#3A4869',
  divider: 'rgba(255,255,255,0.07)',

  textPrimary: '#F4F7FF',
  textSecondary: '#AEBAD4',
  textMuted: '#8895B0',
  textInverse: '#0A0E17',

  primary: '#4C8DFF',
  primaryStrong: '#2F6FE6',
  primarySoft: 'rgba(76,141,255,0.16)',
  onPrimary: '#FFFFFF',

  danger: '#FF4D57',
  dangerStrong: '#E11D2E',
  dangerSoft: 'rgba(255,77,87,0.16)',
  onDanger: '#FFFFFF',
  warning: '#F6A724',
  warningSoft: 'rgba(246,167,36,0.16)',
  success: '#2FD46E',
  successSoft: 'rgba(47,212,110,0.16)',
  info: '#2DD4EE',
  infoSoft: 'rgba(45,212,238,0.16)',

  focus: '#7FB0FF',

  citizen: '#2DD4EE',
  worker: '#FB7185',
  admin: '#B388FF',
  firefighter: '#FF6242',
  paramedic: '#FB7185',
  police: '#4C8DFF',

  hazardNotification: '#FBBF24',
  hazardCordon: '#FB7A3C',

  severity: ['#38BDF8', '#FACC15', '#FB923C', '#FB5A45', '#FF3B47'],

  alwaysWhite: '#FFFFFF',
};

export const lightColors: ColorTokens = {
  bg: '#F4F7FC',
  surface: '#FFFFFF',
  surfaceAlt: '#EDF1F9',
  surfaceHover: '#E2E9F5',
  overlay: 'rgba(15,23,42,0.42)',

  border: '#DBE2EE',
  borderStrong: '#BFCADC',
  divider: 'rgba(15,23,42,0.08)',

  textPrimary: '#0E1726',
  textSecondary: '#43536C',
  textMuted: '#65728B',
  textInverse: '#FFFFFF',

  primary: '#2563EB',
  primaryStrong: '#1D4ED8',
  primarySoft: 'rgba(37,99,235,0.10)',
  onPrimary: '#FFFFFF',

  danger: '#DC2626',
  dangerStrong: '#B91C1C',
  dangerSoft: 'rgba(220,38,38,0.09)',
  onDanger: '#FFFFFF',
  warning: '#C2700A',
  warningSoft: 'rgba(194,112,10,0.12)',
  success: '#15873E',
  successSoft: 'rgba(21,135,62,0.12)',
  info: '#0E7C99',
  infoSoft: 'rgba(14,124,153,0.12)',

  focus: '#2563EB',

  citizen: '#0E7C99',
  worker: '#DB2777',
  admin: '#8B30D9',
  firefighter: '#DC2626',
  paramedic: '#DB2777',
  police: '#2563EB',

  hazardNotification: '#B45309',
  hazardCordon: '#C2410C',

  severity: ['#0284C7', '#CA8A04', '#EA580C', '#DC2626', '#B91C1C'],

  alwaysWhite: '#FFFFFF',
};

// Elevation → platform shadow. Dark surfaces lean on a faint glow + border;
// light surfaces use a soft drop shadow. Returns RN-style shadow props.
export function makeShadow(level: 0 | 1 | 2 | 3, scheme: 'dark' | 'light') {
  if (level === 0) return {};
  const lightShadows = {
    1: { shadowColor: '#1B2A4A', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    2: { shadowColor: '#1B2A4A', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    3: { shadowColor: '#1B2A4A', shadowOpacity: 0.18, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
  } as const;
  const darkShadows = {
    1: { shadowColor: '#000000', shadowOpacity: 0.32, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
    2: { shadowColor: '#000000', shadowOpacity: 0.42, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 7 },
    3: { shadowColor: '#000000', shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 14 }, elevation: 12 },
  } as const;
  return scheme === 'light' ? lightShadows[level] : darkShadows[level];
}

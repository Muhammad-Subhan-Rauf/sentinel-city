// Themed text. Pick a `variant` from the type scale and a semantic `tone`;
// color resolves from the active theme so the same call works in light + dark.
// Use this instead of RN's <Text> everywhere so we never hardcode a font/size.

import React from 'react';
import { Text as RNText, TextProps as RNTextProps } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { typography, TypeVariant } from '@/theme/typography';

export type Tone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'inverse'
  | 'danger'
  | 'warning'
  | 'success'
  | 'info'
  | 'accent'
  | 'onPrimary'
  | 'onDanger';

type Props = RNTextProps & {
  variant?: TypeVariant;
  tone?: Tone;
  /** Explicit color override; wins over `tone`. */
  color?: string;
  center?: boolean;
};

export function Text({ variant = 'body', tone = 'primary', color, center, style, ...rest }: Props) {
  const t = useTheme();
  const toneColor: Record<Tone, string> = {
    primary: t.color.textPrimary,
    secondary: t.color.textSecondary,
    muted: t.color.textMuted,
    inverse: t.color.textInverse,
    danger: t.color.danger,
    warning: t.color.warning,
    success: t.color.success,
    info: t.color.info,
    accent: t.color.primary,
    onPrimary: t.color.onPrimary,
    onDanger: t.color.onDanger,
  };
  return (
    <RNText
      style={[typography[variant], { color: color ?? toneColor[tone] }, center && { textAlign: 'center' }, style]}
      {...rest}
    />
  );
}

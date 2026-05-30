// Compact status pill. Always renders a label, and optionally a leading icon,
// so information is never conveyed by color alone (WCAG 1.4.1). `tone` selects a
// semantic color; `solid` fills it, otherwise it's a soft tint + colored text.

import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export type BadgeTone = 'neutral' | 'danger' | 'warning' | 'success' | 'info' | 'accent';

export function Badge({
  label,
  tone = 'neutral',
  icon,
  solid = false,
  color,
  style,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: IconName;
  solid?: boolean;
  /** Explicit accent override (e.g. a severity color). */
  color?: string;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const toneMap: Record<BadgeTone, { fg: string; soft: string }> = {
    neutral: { fg: t.color.textSecondary, soft: t.color.surfaceAlt },
    danger: { fg: t.color.danger, soft: t.color.dangerSoft },
    warning: { fg: t.color.warning, soft: t.color.warningSoft },
    success: { fg: t.color.success, soft: t.color.successSoft },
    info: { fg: t.color.info, soft: t.color.infoSoft },
    accent: { fg: t.color.primary, soft: t.color.primarySoft },
  };
  const c = toneMap[tone];
  const accent = color ?? c.fg;
  const bg = solid ? accent : c.soft;
  const fg = solid ? t.color.alwaysWhite : accent;

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 4,
          paddingHorizontal: t.spacing.sm,
          paddingVertical: 3,
          borderRadius: t.radius.pill,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={12} color={fg} />}
      <Text variant="caption" color={fg} style={{ fontFamily: t.fonts.bold, letterSpacing: 0.3 }}>
        {label}
      </Text>
    </View>
  );
}

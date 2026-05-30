// A rounded square holding an icon over a soft tint of its accent color.
// Used as the leading glyph in list rows, headers and stat tiles.

import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, IconName } from './Icon';

const soft = (hex: string, scheme: 'dark' | 'light') => {
  // Build a translucent tint from a solid hex so any accent gets a matching wash.
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return `rgba(${r},${g},${b},${scheme === 'dark' ? 0.18 : 0.12})`;
};

export function IconBadge({
  name,
  color,
  size = 40,
  iconSize,
  style,
}: {
  name: IconName;
  color: string;
  size?: number;
  iconSize?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: t.radius.md,
          backgroundColor: soft(color, t.scheme),
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Icon name={name} size={iconSize ?? Math.round(size * 0.52)} color={color} />
    </View>
  );
}

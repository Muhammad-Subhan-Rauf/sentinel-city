// Surface container. Static by default; pass `onPress` to make it an animated,
// accessible pressable. `accent` paints a 4px left status stripe (severity/role).

import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

type Props = {
  children: React.ReactNode;
  onPress?: () => void;
  accent?: string;
  elevation?: 0 | 1 | 2 | 3;
  padded?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function Card({
  children,
  onPress,
  accent,
  elevation = 1,
  padded = true,
  style,
  accessibilityLabel,
  accessibilityHint,
}: Props) {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const base: ViewStyle = {
    backgroundColor: t.color.surface,
    borderColor: t.color.border,
    borderWidth: StyleSheet.hairlineWidth + 0.5,
    borderRadius: t.radius.lg,
    padding: padded ? t.spacing.lg : 0,
    ...(accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : null),
    ...t.shadow(elevation),
  };

  if (!onPress) return <View style={[base, style]}>{children}</View>;

  const animate = (to: number) => {
    if (t.reduceMotion) return;
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={() => animate(0.98)}
        onPressOut={() => animate(1)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        style={({ pressed }) => [base, pressed && { backgroundColor: t.color.surfaceHover }, style]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

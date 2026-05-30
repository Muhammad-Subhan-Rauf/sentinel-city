// Shimmer placeholders. Shown while first data loads instead of a bare spinner
// (skeletons preserve layout and feel faster). Pulse is disabled under
// reduce-motion, leaving a static block.

import React, { useEffect, useRef } from 'react';
import { Animated, View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

export function Skeleton({
  width,
  height = 14,
  radius,
  style,
}: {
  width?: number | string;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (t.reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, t.reduceMotion]);

  return (
    <Animated.View
      style={[
        {
          width: (width as any) ?? '100%',
          height,
          borderRadius: radius ?? t.radius.sm,
          backgroundColor: t.color.surfaceAlt,
          opacity: t.reduceMotion ? 0.7 : opacity,
        },
        style,
      ]}
    />
  );
}

/** A card-shaped skeleton matching the common list-row layout. */
export function SkeletonCard() {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.color.surface,
        borderColor: t.color.border,
        borderWidth: 1,
        borderRadius: t.radius.lg,
        padding: t.spacing.lg,
        marginBottom: t.spacing.md,
        flexDirection: 'row',
        gap: t.spacing.md,
        alignItems: 'center',
      }}
    >
      <Skeleton width={40} height={40} radius={t.radius.md} />
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton width="60%" height={14} />
        <Skeleton width="90%" height={12} />
      </View>
    </View>
  );
}

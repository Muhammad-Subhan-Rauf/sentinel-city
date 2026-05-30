// The one button. Variants cover every CTA in the app; every instance is ≥44pt,
// announces itself to screen readers, shows a press/scale response (skipped
// under reduce-motion), and has explicit disabled + loading states.

import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { Icon, IconName } from './Icon';

export type ButtonVariant = 'primary' | 'danger' | 'secondary' | 'ghost' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = true,
  style,
}: Props) {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const isDisabled = disabled || loading;

  const heights: Record<ButtonSize, number> = { sm: 40, md: 48, lg: 56 };
  const padding: Record<ButtonSize, number> = { sm: t.spacing.lg, md: t.spacing.xl, lg: t.spacing.xl };

  const fills: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: t.color.primary, fg: t.color.onPrimary },
    danger: { bg: t.color.danger, fg: t.color.onDanger },
    success: { bg: t.color.success, fg: t.color.alwaysWhite },
    secondary: { bg: t.color.surfaceAlt, fg: t.color.textPrimary, border: t.color.border },
    ghost: { bg: 'transparent', fg: t.color.primary },
  };
  const f = fills[variant];

  const animateTo = (to: number) => {
    if (t.reduceMotion) return;
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };

  return (
    <Animated.View style={[fullWidth && { alignSelf: 'stretch' }, { transform: [{ scale }] }, style]}>
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        onPressIn={() => animateTo(0.97)}
        onPressOut={() => animateTo(1)}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        accessibilityLabel={label}
        style={[
          styles.base,
          {
            height: heights[size],
            paddingHorizontal: padding[size],
            borderRadius: t.radius.md,
            backgroundColor: f.bg,
            borderWidth: f.border ? 1 : 0,
            borderColor: f.border,
            opacity: isDisabled ? 0.45 : 1,
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={f.fg} />
        ) : (
          <>
            {icon && <Icon name={icon} size={size === 'lg' ? 22 : 18} color={f.fg} />}
            <Text variant={size === 'lg' ? 'h3' : 'label'} color={f.fg} numberOfLines={1} style={styles.label}>
              {label}
            </Text>
            {iconRight && <Icon name={iconRight} size={size === 'lg' ? 22 : 18} color={f.fg} />}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
  },
  label: { includeFontPadding: false } as any,
});

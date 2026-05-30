import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import { Text, IconBadge, Icon, warningKindIcon } from '@/components/ui';
import type { GeofenceToast } from '@/lib/geofence';

type Props = {
  toasts: GeofenceToast[];
  onDismiss: (id: string) => void;
};

const AUTO_DISMISS_MS = 6000;

export function InAppBanner({ toasts, onDismiss }: Props) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const timer = setTimeout(() => onDismiss(oldest.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      {toasts.slice(-2).map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </View>
  );
}

function ToastCard({ toast, onDismiss }: { toast: GeofenceToast; onDismiss: () => void }) {
  const t = useTheme();
  const slide = useRef(new Animated.Value(t.reduceMotion ? 0 : -90)).current;

  useEffect(() => {
    if (t.reduceMotion) return;
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, speed: 14, bounciness: 6 }).start();
  }, [slide, t.reduceMotion]);

  const accent =
    toast.kind === 'disaster' || toast.kind === 'alert'
      ? t.color.danger
      : toast.kind === 'cordon'
        ? t.color.hazardCordon
        : toast.kind === 'weather'
          ? t.color.warning
          : t.color.primary;

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[
        styles.card,
        {
          backgroundColor: t.color.surface,
          borderColor: t.color.border,
          borderRadius: t.radius.lg,
          borderLeftColor: accent,
          transform: [{ translateY: slide }],
          ...t.shadow(2),
        },
      ]}
    >
      <IconBadge name={warningKindIcon(toast.kind)} color={accent} size={38} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {toast.title}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={2} style={{ marginTop: 1 }}>
          {toast.body}
        </Text>
      </View>
      <Pressable onPress={onDismiss} hitSlop={10} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel="Dismiss alert">
        <Icon name="close" size={18} color={t.color.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 52, left: 12, right: 12, gap: 8, zIndex: 1000 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 8,
    borderWidth: 1,
    borderLeftWidth: 4,
  },
});

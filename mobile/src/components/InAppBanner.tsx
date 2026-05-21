import React, { useEffect } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/colors';
import type { GeofenceToast } from '@/lib/geofence';

type Props = {
  toasts: GeofenceToast[];
  onDismiss: (id: string) => void;
};

const AUTO_DISMISS_MS = 6000;

export function InAppBanner({ toasts, onDismiss }: Props) {
  // Auto-dismiss the oldest toast after AUTO_DISMISS_MS.
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const t = setTimeout(() => onDismiss(oldest.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      {toasts.slice(-2).map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </View>
  );
}

function ToastCard({ toast, onDismiss }: { toast: GeofenceToast; onDismiss: () => void }) {
  const slide = React.useRef(new Animated.Value(-80)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: 0,
      duration: 240,
      useNativeDriver: true,
    }).start();
  }, [slide]);

  const accent =
    toast.kind === 'disaster' || toast.kind === 'alert'
      ? colors.danger
      : toast.kind === 'cordon'
        ? colors.hazardCordon
        : toast.kind === 'weather'
          ? colors.hazardNotification
          : toast.kind === 'dispatch'
            ? colors.info
            : colors.hazardNotification;

  return (
    <Animated.View
      style={[
        styles.card,
        { borderLeftColor: accent, transform: [{ translateY: slide }] },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{toast.title}</Text>
        <Text style={styles.body} numberOfLines={2}>
          {toast.body}
        </Text>
      </View>
      <Pressable onPress={onDismiss} hitSlop={10} style={styles.dismiss}>
        <Text style={styles.dismissText}>×</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 56,
    left: 12,
    right: 12,
    gap: 8,
    zIndex: 1000,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    borderRadius: 10,
    padding: 12,
    paddingRight: 8,
    borderColor: colors.border,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 4,
  },
  title: { color: colors.textPrimary, fontWeight: '700', fontSize: 14 },
  body: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  dismiss: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dismissText: { color: colors.textMuted, fontSize: 22, lineHeight: 22 },
});

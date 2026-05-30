// Citizen-only bottom tab bar with a raised, red "911" call-for-help button
// pinned to the horizontal centre. The regular destinations are split into a
// left and right group around it; tapping 911 jumps to the SOS screen. Only the
// citizen navigator uses this bar — workers/admins keep the standard one.

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme } from '@/theme';
import { Text } from '@/components/ui';

const SOS_ROUTE = 'SOS';

export function CitizenTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useTheme();

  const routes = state.routes;
  const activeKey = routes[state.index]?.key;
  const others = routes.filter((r) => r.name !== SOS_ROUTE);
  const sos = routes.find((r) => r.name === SOS_ROUTE);
  const half = Math.ceil(others.length / 2);
  const left = others.slice(0, half);
  const right = others.slice(half);

  const renderItem = (route: (typeof routes)[number]) => {
    const { options } = descriptors[route.key];
    const focused = route.key === activeKey;
    const color = focused ? t.color.citizen : t.color.textMuted;
    const label = (options.title ?? route.name) as string;

    const onPress = () => {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
    };

    return (
      <Pressable
        key={route.key}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={label}
        style={styles.item}
      >
        {options.tabBarIcon?.({ focused, color, size: 24 })}
        <Text variant="caption" color={color} style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    );
  };

  const onSosPress = () => {
    if (!sos) return;
    const event = navigation.emit({ type: 'tabPress', target: sos.key, canPreventDefault: true });
    if (!event.defaultPrevented) navigation.navigate(SOS_ROUTE);
  };
  const sosFocused = sos?.key === activeKey;

  return (
    <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.color.surface }}>
      <View style={[styles.bar, { backgroundColor: t.color.surface, borderTopColor: t.color.border }]}>
        <View style={styles.group}>{left.map(renderItem)}</View>

        {/* Centre: raised red 911 button */}
        <View style={styles.centerSlot} pointerEvents="box-none">
          <Pressable
            onPress={onSosPress}
            accessibilityRole="button"
            accessibilityLabel="Call 911 for help"
            accessibilityHint="Opens the emergency call-for-help screen"
            style={({ pressed }) => [
              styles.sosButton,
              {
                backgroundColor: pressed ? t.color.dangerStrong : t.color.danger,
                borderColor: t.color.bg,
                transform: [{ scale: pressed ? 0.96 : 1 }],
                ...t.shadow(3),
              },
              sosFocused && { borderColor: t.color.onDanger },
            ]}
          >
            <Text variant="h3" color={t.color.onDanger} style={{ letterSpacing: 0.5 }}>
              911
            </Text>
          </Pressable>
          <Text variant="caption" color={sosFocused ? t.color.danger : t.color.textMuted} style={styles.sosLabel} numberOfLines={1}>
            Get help
          </Text>
        </View>

        <View style={styles.group}>{right.map(renderItem)}</View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 1,
    height: 64,
    paddingTop: 8,
  },
  group: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-around' },
  item: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 3, paddingTop: 2, minHeight: 44 },
  label: { fontSize: 11, letterSpacing: 0.2 },
  // Reserve a fixed centre column; the button is lifted above the bar.
  centerSlot: { width: 76, alignItems: 'center' },
  sosButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    marginTop: -26, // raise above the bar
  },
  sosLabel: { marginTop: 2 },
});

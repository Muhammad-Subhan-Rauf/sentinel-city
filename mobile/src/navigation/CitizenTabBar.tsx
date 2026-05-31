// Citizen-only bottom tab bar with a raised, red "911" call-for-help button
// pinned to the horizontal centre. The regular destinations are split into a
// left and right group around it; tapping 911 jumps to the SOS screen. Only the
// citizen navigator uses this bar — workers/admins keep the standard one.
//
// When the citizen is inside an active danger zone (signalled by
// dangerSignal.setInDangerZone from CitizenMapScreen), the SOS button pulses
// and grows a bright outer halo so the existing affordance lights up — we
// deliberately do NOT spawn a second 911 button anywhere else.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme } from '@/theme';
import { Text } from '@/components/ui';
import { useInDangerZone } from '@/lib/dangerSignal';
import { open911 } from '@/lib/sos911';

const SOS_ROUTE = 'SOS';

export function CitizenTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const inDanger = useInDangerZone();
  const pulse = useRef(new Animated.Value(0)).current;

  // Drive a slow scale/opacity loop on the halo whenever the citizen is inside
  // a zone. Stopped (and reset) the moment they step out so the bar settles.
  // Respect reduceMotion by holding the halo fully visible without animating.
  useEffect(() => {
    pulse.stopAnimation();
    if (!inDanger) {
      pulse.setValue(0);
      return;
    }
    if (t.reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [inDanger, t.reduceMotion, pulse]);

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  const buttonScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  const routes = state.routes;
  const activeKey = routes[state.index]?.key;
  // SOS_ROUTE is no longer a registered screen, but keep the filter so the bar
  // stays correct if it's ever re-added; the centre button is the 911 entry point.
  const others = routes.filter((r) => r.name !== SOS_ROUTE);
  const half = Math.ceil(others.length / 2);
  const left = others.slice(0, half);
  const right = others.slice(half);

  const renderItem = (route: (typeof routes)[number]) => {
    const { options } = descriptors[route.key];
    const focused = route.key === activeKey;
    const color = focused ? t.color.citizen : t.color.textMuted;
    const label = (options.title ?? route.name) as string;
    const badge = options.tabBarBadge;
    const hasBadge = badge != null && badge !== 0 && badge !== '';

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
        accessibilityLabel={hasBadge ? `${label}, ${badge} new` : label}
        style={styles.item}
      >
        <View style={styles.iconWrap}>
          {options.tabBarIcon?.({ focused, color, size: 24 })}
          {hasBadge && (
            <View style={[styles.badge, { backgroundColor: t.color.danger, borderColor: t.color.surface }]}>
              <Text color={t.color.onDanger} style={[styles.badgeText, { fontFamily: t.fonts.bold }]} numberOfLines={1}>
                {String(badge)}
              </Text>
            </View>
          )}
        </View>
        <Text variant="caption" color={color} style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    );
  };

  // Fire the global signal so the call menu pops over the CURRENT screen — the
  // citizen never has to navigate to a separate call-for-help page.
  const onSosPress = () => open911();
  const sosFocused = false;

  return (
    <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.color.surface }}>
      <View style={[styles.bar, { backgroundColor: t.color.surface, borderTopColor: t.color.border }]}>
        <View style={styles.group}>{left.map(renderItem)}</View>

        {/* Centre: raised red 911 button (with in-zone pulse halo) */}
        <View style={styles.centerSlot} pointerEvents="box-none">
          <View style={styles.sosWrap} pointerEvents="box-none">
            {inDanger && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.sosHalo,
                  {
                    backgroundColor: t.color.danger,
                    opacity: haloOpacity,
                    transform: [{ scale: haloScale }],
                  },
                ]}
              />
            )}
            <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
              <Pressable
                onPress={onSosPress}
                accessibilityRole="button"
                accessibilityLabel={inDanger ? 'Call 911 — you are inside a danger zone' : 'Call 911 for help'}
                accessibilityHint="Opens the 911 call menu"
                style={({ pressed }) => [
                  styles.sosButton,
                  {
                    backgroundColor: pressed ? t.color.dangerStrong : t.color.danger,
                    borderColor: inDanger ? t.color.onDanger : t.color.bg,
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                    ...t.shadow(3),
                  },
                  sosFocused && !inDanger && { borderColor: t.color.onDanger },
                ]}
              >
                <Text variant="h3" color={t.color.onDanger} style={{ letterSpacing: 0.5 }}>
                  911
                </Text>
              </Pressable>
            </Animated.View>
          </View>
          <Text
            variant="caption"
            color={inDanger ? t.color.danger : sosFocused ? t.color.danger : t.color.textMuted}
            style={styles.sosLabel}
            numberOfLines={1}
          >
            {inDanger ? 'Tap for help' : 'Get help'}
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
  iconWrap: { width: 30, height: 24, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 9, lineHeight: 11 },
  label: { fontSize: 11, letterSpacing: 0.2 },
  // Reserve a fixed centre column; the button is lifted above the bar.
  centerSlot: { width: 76, alignItems: 'center' },
  // The button is lifted above the bar; the halo lives inside the same wrap so
  // it can scale out beyond the button bounds without disturbing layout.
  sosWrap: { width: 62, height: 62, marginTop: -26, alignItems: 'center', justifyContent: 'center' },
  sosHalo: { position: 'absolute', width: 62, height: 62, borderRadius: 31 },
  sosButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
  },
  sosLabel: { marginTop: 2 },
});

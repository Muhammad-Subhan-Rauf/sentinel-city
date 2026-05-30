// Destination search box for the citizen map. Type a place → debounced Stadia
// autocomplete (≈350ms) → tap a suggestion to route there. Complements tapping
// the map directly. When a destination is set it collapses to a compact bar
// showing the resolved area name with a clear (×) control.

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { autocompletePlaces, PlaceSuggestion } from '@/lib/api';
import { PlaceLabel } from '@/lib/geocode';
import { useTheme } from '@/theme';
import { Text, Icon } from '@/components/ui';

type LatLng = { lat: number; lng: number };

type Props = {
  // Biases suggestions toward the user's current area.
  focus: LatLng | null;
  destination: LatLng | null;
  onSelect: (p: { lat: number; lng: number; label: string }) => void;
  onClear: () => void;
};

const DEBOUNCE_MS = 350;

export function DestinationSearch({ focus, destination, onSelect, onClear }: Props) {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const reqToken = useRef(0);
  const inputRef = useRef<TextInput>(null);

  // Debounced autocomplete. A token guards against out-of-order responses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const myToken = ++reqToken.current;
    const handle = setTimeout(async () => {
      const found = await autocompletePlaces(q, focus);
      if (reqToken.current !== myToken) return; // stale
      setResults(found);
      setSearching(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, focus]);

  const pick = (s: PlaceSuggestion) => {
    reqToken.current++; // cancel any pending search
    onSelect({ lat: s.lat, lng: s.lng, label: s.secondary ? `${s.label}, ${s.secondary}` : s.label });
    setQuery('');
    setResults([]);
    setSearching(false);
    setFocused(false);
    Keyboard.dismiss();
  };

  const reset = () => {
    setQuery('');
    setResults([]);
    reqToken.current++;
  };

  const showDropdown = focused && query.trim().length >= 3 && (searching || results.length > 0);

  // Collapsed bar: a destination is set and the user isn't actively searching.
  if (destination && !focused && !query) {
    return (
      <View style={[styles.bar, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
        <Icon name="route" size={18} color={t.color.primary} />
        <View style={{ flex: 1 }}>
          <Text variant="overline" tone="muted">
            Destination
          </Text>
          <PlaceLabel lat={destination.lat} lng={destination.lng} fallback={`${destination.lat.toFixed(4)}, ${destination.lng.toFixed(4)}`} variant="bodyStrong" tone="primary" />
        </View>
        <Pressable
          onPress={onClear}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Clear destination"
          style={[styles.iconBtn, { backgroundColor: t.color.surfaceAlt }]}
        >
          <Icon name="close" size={18} color={t.color.textSecondary} />
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <View style={[styles.bar, { backgroundColor: t.color.surface, borderColor: focused ? t.color.primary : t.color.border, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
        <Icon name="search" size={18} color={t.color.textMuted} />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={setQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search for a destination…"
          placeholderTextColor={t.color.textMuted}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, paddingVertical: 0, color: t.color.textPrimary, fontFamily: t.fonts.regular, fontSize: t.fontSize.base }}
          accessibilityLabel="Search for a destination"
        />
        {searching ? (
          <ActivityIndicator size="small" color={t.color.textMuted} />
        ) : query.length > 0 ? (
          <Pressable onPress={reset} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
            <Icon name="close" size={18} color={t.color.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {showDropdown && (
        <View style={[styles.dropdown, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.lg, ...t.shadow(3) }]}>
          {results.length === 0 && !searching ? (
            <Text variant="caption" tone="muted" style={{ padding: t.spacing.md }}>
              No matches. Try a street, place or landmark.
            </Text>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 260 }}>
              {results.map((s, i) => (
                <Pressable
                  key={s.id}
                  onPress={() => pick(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.label}${s.secondary ? `, ${s.secondary}` : ''}`}
                  style={({ pressed }) => [
                    styles.row,
                    { borderTopColor: t.color.divider, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, backgroundColor: pressed ? t.color.surfaceHover : 'transparent' },
                  ]}
                >
                  <Icon name="pin" size={16} color={t.color.primary} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {s.label}
                    </Text>
                    {s.secondary ? (
                      <Text variant="caption" tone="muted" numberOfLines={1}>
                        {s.secondary}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, minHeight: 52 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  dropdown: { marginTop: 8, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52 },
});

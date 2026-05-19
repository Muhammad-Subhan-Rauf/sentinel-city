// Shared Settings screen for all roles.
//   - Citizens & workers: pin-drop map (drag to relocate) + address search + sign-out
//   - Admins: identity caption + sign-out only (no map; admins don't have a position)

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, UrlTile } from 'react-native-maps';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { colors, roleAccent } from '@/lib/colors';
import { searchPlaces, Suggestion } from '@/lib/nominatim';

const CARTODB_DARK_URL = 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
const MANHATTAN = { lat: 40.758, lng: -73.9855 };

export default function SettingsScreen() {
  const { session, signOut } = useAuth();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const role = session?.role;
  const isField = role === 'citizen' || role === 'worker';
  const accent = roleAccent(role ?? 'citizen');

  // Pull current position from backend for citizens/workers.
  useEffect(() => {
    if (!session || !isField) return;
    let cancelled = false;
    (async () => {
      try {
        const me =
          session.role === 'citizen'
            ? await api.getCitizen(session.userId)
            : await api.getWorker(session.userId);
        if (cancelled) return;
        setPin({ lat: me.lat, lng: me.lng });
      } catch {
        // First time? Fall back to Manhattan center so the map can render.
        setPin(MANHATTAN);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, isField]);

  // Nominatim debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setSearching(true);
      try {
        const out = await searchPlaces(query, ac.signal);
        setSuggestions(out);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const pushLocation = async (loc: { lat: number; lng: number }) => {
    if (!session || !isField) return;
    setSaving(true);
    try {
      if (session.role === 'citizen') {
        await api.updateCitizen(session.userId, { lat: loc.lat, lng: loc.lng });
      } else {
        await api.updateWorker(session.userId, { lat: loc.lat, lng: loc.lng });
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      /* swallow; banner could surface this later */
    } finally {
      setSaving(false);
    }
  };

  const mapTypeProp = Platform.OS === 'android' ? { mapType: 'none' as const } : {};

  if (!session) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>
        Signed in as {session.name} · {session.sub_role ?? session.role}
      </Text>

      {isField && (
        <>
          <View style={styles.searchWrap}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search address…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoCorrect={false}
              autoCapitalize="words"
            />
            {searching && <ActivityIndicator color={colors.info} style={styles.spinner} />}
          </View>
          {suggestions.length > 0 && (
            <ScrollView style={styles.suggestions} keyboardShouldPersistTaps="handled">
              {suggestions.map((s, idx) => (
                <Pressable
                  key={`${s.lat}-${s.lng}-${idx}`}
                  onPress={() => {
                    const loc = { lat: s.lat, lng: s.lng };
                    setPin(loc);
                    setQuery(s.display_name);
                    setSuggestions([]);
                    pushLocation(loc);
                  }}
                  style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.suggestionText} numberOfLines={2}>
                    {s.display_name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          <View style={styles.mapBox}>
            {pin ? (
              <MapView
                style={StyleSheet.absoluteFillObject}
                initialRegion={{
                  latitude: pin.lat,
                  longitude: pin.lng,
                  latitudeDelta: 0.04,
                  longitudeDelta: 0.04,
                }}
                region={{
                  latitude: pin.lat,
                  longitude: pin.lng,
                  latitudeDelta: 0.04,
                  longitudeDelta: 0.04,
                }}
                {...mapTypeProp}
              >
                <UrlTile urlTemplate={CARTODB_DARK_URL} maximumZ={19} flipY={false} zIndex={-1} />
                <Marker
                  draggable
                  coordinate={{ latitude: pin.lat, longitude: pin.lng }}
                  onDragEnd={(e) => {
                    const { latitude, longitude } = e.nativeEvent.coordinate;
                    const loc = { lat: latitude, lng: longitude };
                    setPin(loc);
                    pushLocation(loc);
                  }}
                  pinColor={accent}
                  title="My location"
                  description="Drag to move"
                />
              </MapView>
            ) : (
              <ActivityIndicator color={colors.info} style={{ marginTop: 24 }} />
            )}
          </View>

          <View style={styles.coordsRow}>
            {pin && (
              <Text style={styles.coords}>
                {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
              </Text>
            )}
            {saving ? (
              <ActivityIndicator color={colors.info} />
            ) : savedAt ? (
              <Text style={styles.savedAt}>Synced {savedAt}</Text>
            ) : null}
          </View>
        </>
      )}

      <Pressable onPress={signOut} style={styles.signOutBtn}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, marginTop: 4, marginBottom: 12 },
  searchWrap: { position: 'relative', marginBottom: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    color: colors.textPrimary,
    padding: 12,
    borderRadius: 10,
    fontSize: 15,
  },
  spinner: { position: 'absolute', right: 12, top: 12 },
  suggestions: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 8,
    maxHeight: 160,
  },
  suggestion: { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  suggestionText: { color: colors.textPrimary, fontSize: 13 },
  mapBox: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 12,
    minHeight: 240,
  },
  coordsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  coords: { color: colors.textPrimary, fontSize: 13, fontVariant: ['tabular-nums'] },
  savedAt: { color: colors.success, fontSize: 12 },
  signOutBtn: {
    backgroundColor: colors.danger,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  signOutText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

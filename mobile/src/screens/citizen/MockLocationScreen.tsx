// Mock Location: lets a citizen override their position either by
//   - typing an address (Nominatim autocomplete)
//   - dragging a pin on the map
// Persists to backend so the web operator sees the new position.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { api, MobileCitizen } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { searchPlaces, Suggestion } from '@/lib/nominatim';

export default function MockLocationScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!session || session.role !== 'citizen') return;
    api
      .getCitizen(session.userId)
      .then((c) => {
        setMe(c);
        setPin({ lat: c.lat, lng: c.lng });
      })
      .catch(() => undefined);
  }, [session]);

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

  const applyPin = async () => {
    if (!session || !pin) return;
    setSaving(true);
    try {
      const updated = await api.updateCitizen(session.userId, { lat: pin.lat, lng: pin.lng });
      setMe(updated);
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      // Show error inline.
    } finally {
      setSaving(false);
    }
  };

  if (!session || session.role !== 'citizen') {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.placeholder}>Mock location is only available for Citizen accounts.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Mock Location</Text>
      <Text style={styles.subtitle}>
        Type an address or drag the pin to override your position.
      </Text>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search for an address…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCorrect={false}
          autoCapitalize="words"
        />
        {searching && <ActivityIndicator color={colors.info} style={styles.spinner} />}
      </View>

      {suggestions.length > 0 && (
        <View style={styles.suggestions}>
          {suggestions.map((s, idx) => (
            <Pressable
              key={`${s.lat}-${s.lng}-${idx}`}
              onPress={() => {
                setPin({ lat: s.lat, lng: s.lng });
                setQuery(s.display_name);
                setSuggestions([]);
              }}
              style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.suggestionText} numberOfLines={2}>
                {s.display_name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.mapBox}>
        {pin ? (
          <MapView
            provider={PROVIDER_GOOGLE}
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
          >
            <Marker
              draggable
              coordinate={{ latitude: pin.lat, longitude: pin.lng }}
              onDragEnd={(e) => {
                const { latitude, longitude } = e.nativeEvent.coordinate;
                setPin({ lat: latitude, lng: longitude });
              }}
              pinColor={colors.citizen}
              title="My location"
              description="Drag to move"
            />
          </MapView>
        ) : (
          <ActivityIndicator color={colors.info} style={{ marginTop: 24 }} />
        )}
      </View>

      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          {pin && (
            <Text style={styles.coords}>
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </Text>
          )}
          {savedAt && <Text style={styles.savedAt}>Saved at {savedAt}</Text>}
        </View>
        <Pressable
          onPress={applyPin}
          disabled={saving || !pin}
          style={({ pressed }) => [
            styles.saveBtn,
            (saving || !pin) && { opacity: 0.5 },
            pressed && { opacity: 0.8 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Set Location</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, marginTop: 4, marginBottom: 12 },
  placeholder: { color: colors.textSecondary, padding: 20 },
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
    maxHeight: 200,
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
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  coords: { color: colors.textPrimary, fontSize: 13, fontVariant: ['tabular-nums'] },
  savedAt: { color: colors.success, fontSize: 12, marginTop: 2 },
  saveBtn: {
    backgroundColor: colors.citizen,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
  },
  saveBtnText: { color: '#fff', fontWeight: '700' },
});

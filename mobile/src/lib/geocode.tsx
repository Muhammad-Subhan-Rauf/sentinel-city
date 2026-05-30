// Reverse-geocoding helpers shared across the app: turn a lat/lng into a human
// area name ("Times Square, Manhattan") instead of bare coordinates.
//
// Everything here degrades gracefully — if the Stadia key is missing or the
// network is down the hook simply stays on the coordinate fallback, so no
// screen ever breaks waiting on a name. Results are cached per ~11m grid cell
// and in-flight requests are de-duped, so a list of rows resolves each unique
// location at most once.

import React, { useEffect, useState } from 'react';
import { reverseGeocode } from '@/lib/api';
import { Text } from '@/components/ui';
import type { Tone } from '@/components/ui';
import type { TypeVariant } from '@/theme';
import type { TextStyle } from 'react-native';

// null = looked up, no name found. undefined = not looked up yet.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function key(lat: number, lng: number): string {
  // 4 dp ≈ 11 m — enough to coalesce a stationary point's repeated lookups.
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export function lookupAreaName(lat: number, lng: number): Promise<string | null> {
  const k = key(lat, lng);
  if (cache.has(k)) return Promise.resolve(cache.get(k)!);
  const existing = inflight.get(k);
  if (existing) return existing;
  const p = reverseGeocode(lat, lng)
    .then((name) => {
      cache.set(k, name);
      inflight.delete(k);
      return name;
    })
    .catch(() => {
      inflight.delete(k);
      return null;
    });
  inflight.set(k, p);
  return p;
}

/** Resolve a coordinate to an area name. `label` is null until resolved (or if
 *  none is found); `loading` is true only while a network lookup is pending. */
export function useReverseGeocode(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { label: string | null; loading: boolean } {
  const valid = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
  const k = valid ? key(lat as number, lng as number) : '';
  const [label, setLabel] = useState<string | null>(valid && cache.has(k) ? cache.get(k)! : null);
  const [loading, setLoading] = useState<boolean>(valid && !cache.has(k));

  useEffect(() => {
    if (!valid) {
      setLabel(null);
      setLoading(false);
      return;
    }
    if (cache.has(k)) {
      setLabel(cache.get(k)!);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    lookupAreaName(lat as number, lng as number).then((name) => {
      if (cancelled) return;
      setLabel(name);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [k, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  return { label, loading };
}

/** Drop-in text that shows the area name for a coordinate, falling back to
 *  `fallback` (typically the formatted coordinates) until/unless one resolves. */
export function PlaceLabel({
  lat,
  lng,
  fallback,
  variant = 'caption',
  tone = 'secondary',
  color,
  numberOfLines = 1,
  style,
}: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  fallback?: string;
  variant?: TypeVariant;
  tone?: Tone;
  color?: string;
  numberOfLines?: number;
  style?: TextStyle;
}) {
  const { label } = useReverseGeocode(lat, lng);
  return (
    <Text variant={variant} tone={tone} color={color} numberOfLines={numberOfLines} style={style}>
      {label ?? fallback ?? 'Locating…'}
    </Text>
  );
}

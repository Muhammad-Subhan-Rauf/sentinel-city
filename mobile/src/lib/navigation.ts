// Turn-by-turn progress tracking for in-app navigation. Given a route (with
// Valhalla maneuvers) and the user's current location, it figures out the
// upcoming turn, the along-route distance to it, the remaining distance/ETA, and
// whether the user has arrived. Pure + memoized — voice/UI live in NavBanner.

import { useMemo } from 'react';
import { Route, RouteManeuver } from '@/lib/api';
import { haversineMeters, LatLng } from '@/lib/geo';

export type NavState = {
  step: RouteManeuver | null; // the next maneuver to perform
  thenStep: RouteManeuver | null; // the one after (preview line)
  stepIndex: number; // index of `step` in route.maneuvers (-1 = none)
  distanceToTurnM: number; // along-route distance to `step`
  remainingM: number; // along-route distance to destination
  remainingMin: number; // ETA for the remaining distance
  progress: number; // 0..1 fraction of the route completed
  arrived: boolean;
};

const EMPTY: NavState = {
  step: null,
  thenStep: null,
  stepIndex: -1,
  distanceToTurnM: 0,
  remainingM: 0,
  remainingMin: 0,
  progress: 0,
  arrived: false,
};

// Index of the route coordinate nearest the user (their progress along the line).
function nearestIndex(coords: Route['coordinates'], loc: LatLng): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMeters(loc, { lat: coords[i].latitude, lng: coords[i].longitude });
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Live navigation state for the given route + location. */
export function useNavProgress(route: Route | null, loc: LatLng | null): NavState {
  // Cumulative along-route distance (metres) at each coordinate.
  const cum = useMemo(() => {
    if (!route || route.coordinates.length === 0) return [] as number[];
    const arr = new Array<number>(route.coordinates.length).fill(0);
    for (let i = 1; i < route.coordinates.length; i++) {
      const a = route.coordinates[i - 1];
      const b = route.coordinates[i];
      arr[i] = arr[i - 1] + haversineMeters({ lat: a.latitude, lng: a.longitude }, { lat: b.latitude, lng: b.longitude });
    }
    return arr;
  }, [route]);

  return useMemo<NavState>(() => {
    if (!route || !loc || route.coordinates.length === 0 || cum.length === 0) return EMPTY;

    const idx = nearestIndex(route.coordinates, loc);
    const total = cum[cum.length - 1] ?? 0;
    const traveled = cum[idx] ?? 0;
    const remainingM = Math.max(0, total - traveled);
    const remainingMin =
      route.distanceKm > 0 ? (route.durationMin * (remainingM / 1000)) / route.distanceKm : 0;
    const progress = total > 0 ? Math.min(1, traveled / total) : 0;

    // Distance from the user to the destination (last coordinate) as the crow
    // flies — used as an arrival check independent of along-route drift.
    const last = route.coordinates[route.coordinates.length - 1];
    const toEndM = haversineMeters(loc, { lat: last.latitude, lng: last.longitude });
    const arrived = toEndM < 25 || remainingM < 25;

    const maneuvers = route.maneuvers ?? [];
    // The upcoming turn is the first maneuver strictly ahead of the user.
    let stepIndex = maneuvers.findIndex((m) => m.shapeIndex > idx);
    if (stepIndex === -1 && maneuvers.length > 0) stepIndex = maneuvers.length - 1; // destination
    const step = stepIndex >= 0 ? maneuvers[stepIndex] : null;
    const thenStep = step && stepIndex + 1 < maneuvers.length ? maneuvers[stepIndex + 1] : null;

    const stepCum = step ? cum[Math.min(step.shapeIndex, cum.length - 1)] ?? total : total;
    const distanceToTurnM = Math.max(0, stepCum - traveled);

    return { step, thenStep, stepIndex, distanceToTurnM, remainingM, remainingMin, progress, arrived };
  }, [route, loc, cum]);
}

/** "120 m" / "1.3 km" — friendly distance for the nav banner. */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** "3 min" / "1 hr 5 min" — friendly ETA. */
export function formatEta(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

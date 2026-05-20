// Per-worker dispatch latch. When a worker taps "Acknowledge + Route" in the
// Calls tab, the Calls screen pushes a DispatchTarget under that worker's
// scope key; their Map screen subscribes to the same key and auto-routes to
// the caller's location.
//
// Earlier versions of this module exposed a single global target — that
// caused cross-talk: a firefighter on a phone acknowledged a call, then
// signing in as police on the same device inherited the firefighter's route.
// Now each (device_id + sub_role) has its own slot, persisted to AsyncStorage
// so an acknowledged call survives across app restarts and sub-role switches.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type DispatchTarget = {
  callId: string;
  lat: number;
  lng: number;
  label: string;          // e.g. "Citizen-BD13 · Wildfire sev 4"
  caller_name: string;
  disaster_type: string;
  severity: number;
};

// Scope key shape lives here so callers compose it the same way every time.
// We accept undefined for sub_role to gracefully short-circuit non-worker
// callers (citizens / admins, who don't have dispatch latches).
export function scopeKeyFor(deviceId: string | undefined | null, subRole: string | undefined | null): string | null {
  if (!deviceId || !subRole) return null;
  return `${deviceId}:${subRole}`;
}

const STORAGE_KEY = (scope: string) => `sentinel.dispatch.v1:${scope}`;

const targets = new Map<string, DispatchTarget | null>();
// Keyed by scope as well — each subscription fires only when its own scope
// changes, so two workers signed in on different devices don't poke each
// other's hooks.
const listeners = new Map<string, Set<(t: DispatchTarget | null) => void>>();

function notify(scope: string) {
  const set = listeners.get(scope);
  if (!set) return;
  const t = targets.get(scope) ?? null;
  for (const fn of set) fn(t);
}

// Hydrate from disk on first access of a scope. Avoids racing on every render
// by tracking "already loaded" scopes in a Set.
const hydrated = new Set<string>();
async function hydrate(scope: string) {
  if (hydrated.has(scope)) return;
  hydrated.add(scope);
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY(scope));
    if (!raw) return;
    const parsed = JSON.parse(raw) as DispatchTarget;
    if (parsed && typeof parsed === 'object' && parsed.callId) {
      // Only adopt the persisted target if no in-memory value has been set
      // since hydration started — otherwise we'd clobber a fresh acknowledge.
      if (!targets.get(scope)) {
        targets.set(scope, parsed);
        notify(scope);
      }
    }
  } catch {
    /* corrupt or unreadable — ignore */
  }
}

export function setDispatchTarget(scope: string | null, t: DispatchTarget | null) {
  if (!scope) return;
  targets.set(scope, t);
  // Fire-and-forget persistence so a worker can kill the app, reopen, and
  // still see their active dispatch.
  if (t) {
    AsyncStorage.setItem(STORAGE_KEY(scope), JSON.stringify(t)).catch(() => {});
  } else {
    AsyncStorage.removeItem(STORAGE_KEY(scope)).catch(() => {});
  }
  notify(scope);
}

export function getDispatchTarget(scope: string | null): DispatchTarget | null {
  if (!scope) return null;
  return targets.get(scope) ?? null;
}

// Subscribe to the dispatch latch for a given (device + sub_role) scope.
// `scope` is allowed to be null while the caller's session is still resolving
// — the hook returns null in that case and re-subscribes once a real scope
// arrives.
export function useDispatchTarget(scope: string | null): DispatchTarget | null {
  const [t, setT] = useState<DispatchTarget | null>(scope ? targets.get(scope) ?? null : null);
  useEffect(() => {
    if (!scope) {
      setT(null);
      return;
    }
    // Trigger a one-shot hydration on first subscribe to this scope.
    hydrate(scope);
    // Snapshot the current value (might already be present from a prior
    // setDispatchTarget call in this session).
    setT(targets.get(scope) ?? null);
    const fn = (next: DispatchTarget | null) => setT(next);
    let set = listeners.get(scope);
    if (!set) {
      set = new Set();
      listeners.set(scope, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }, [scope]);
  return t;
}

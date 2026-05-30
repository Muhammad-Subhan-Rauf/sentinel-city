// Cross-screen signal: is the citizen currently standing inside an active
// danger zone? CitizenMapScreen owns the geometry check and sets it; the
// citizen tab bar reads it via the hook to pulse the SOS button so the
// "you need to act" affordance lives in one consistent place instead of a
// second 911 button appearing on the map.

import { useEffect, useState } from 'react';

let _inZone = false;
const _subs = new Set<(v: boolean) => void>();

export function setInDangerZone(value: boolean) {
  if (_inZone === value) return;
  _inZone = value;
  for (const fn of _subs) fn(value);
}

export function useInDangerZone(): boolean {
  const [v, setV] = useState(_inZone);
  useEffect(() => {
    _subs.add(setV);
    setV(_inZone);
    return () => {
      _subs.delete(setV);
    };
  }, []);
  return v;
}

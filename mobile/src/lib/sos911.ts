// Cross-screen signal: "open the 911 call menu now". The citizen tab bar's red
// 911 button fires open911() from anywhere; a single <Sos911Launcher/> mounted at
// the citizen root listens and pops the pre-call sheet over the current screen —
// so the caller never has to navigate to a separate page first.
//
// Same lightweight module-store pattern as dangerSignal. A monotonic counter is
// used (not a boolean) so each tap is a distinct event the launcher can react to,
// even if the menu was just closed.

import { useEffect, useState } from 'react';

let _count = 0;
const _subs = new Set<(n: number) => void>();

export function open911(): void {
  _count += 1;
  for (const fn of _subs) fn(_count);
}

/** Returns a token that increments every time open911() is called. */
export function useSos911OpenToken(): number {
  const [n, setN] = useState(_count);
  useEffect(() => {
    _subs.add(setN);
    return () => {
      _subs.delete(setN);
    };
  }, []);
  return n;
}

// Shared map-data store. The hazard + infrastructure layers shown on the map
// (and counted in the legend) are COMMON to everyone — the same disasters,
// cordons, advisories, and fire/hospital/police stations regardless of who's
// logged in. Only the "me" dot is per-user. So instead of every map mount
// running its own poll and starting from empty (which made the legend re-load /
// flash blank each time), this module loads that common data ONCE into a
// process-wide snapshot, keeps a single shared poller alive while any map is on
// screen, and serves the last-known snapshot instantly on every (re)mount.
//
// Same lightweight subscribe pattern as dangerSignal/sos911. Reads go through
// api's cachedGet, so the actual network calls are still deduped + TTL-cached;
// this layer adds cross-mount persistence so the legend is never empty once it
// has loaded once.

import { useEffect, useState } from 'react';
import { api, Notification, Cordon, Disaster, MobileCitizen, StationPoint } from '@/lib/api';

export type MapData = {
  notifs: Notification[];
  cordons: Cordon[];
  disasters: Disaster[];
  citizens: MobileCitizen[];
  fireStations: StationPoint[];
  hospitals: StationPoint[];
  policeStations: StationPoint[];
  // True once the first successful load has populated the snapshot.
  loaded: boolean;
};

const EMPTY: MapData = {
  notifs: [],
  cordons: [],
  disasters: [],
  citizens: [],
  fireStations: [],
  hospitals: [],
  policeStations: [],
  loaded: false,
};

let _data: MapData = EMPTY;
const _subs = new Set<(d: MapData) => void>();
let _timer: ReturnType<typeof setInterval> | null = null;
// Ref-count of mounted consumers that want the (privacy-gated) citizen layer.
let _wantCitizens = 0;
const POLL_MS = 5000;

async function _refresh(): Promise<void> {
  try {
    const [notifs, cordons, disasters, fireStations, hospitals, policeStations, citizens] = await Promise.all([
      api.listNotifications().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => _data.notifs),
      api.listCordons().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => _data.cordons),
      // Disasters are gated on citizen reports (api.listReportedDisasters): a
      // placed disaster only appears once users report it.
      api.listReportedDisasters().catch(() => _data.disasters),
      api.listFireStations().catch(() => _data.fireStations),
      api.listHospitals().catch(() => _data.hospitals),
      api.listPoliceStations().catch(() => _data.policeStations),
      // Other citizens stay private — only fetched when a consumer asks for them.
      _wantCitizens > 0 ? api.listCitizens().catch(() => _data.citizens) : Promise.resolve(_data.citizens),
    ]);
    _data = { notifs, cordons, disasters, citizens, fireStations, hospitals, policeStations, loaded: true };
    for (const fn of _subs) fn(_data);
  } catch {
    /* keep last-known snapshot */
  }
}

function _ensurePolling(): void {
  if (_timer) return;
  _refresh(); // immediate
  _timer = setInterval(_refresh, POLL_MS);
}

function _maybeStopPolling(): void {
  if (_subs.size === 0 && _timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Subscribe to the shared map data. Returns the last-known snapshot immediately
 * (so the legend/markers render instantly), then live updates while mounted.
 * Pass `includeCitizens` to opt the citizen layer into the shared poll.
 */
export function useMapData(includeCitizens = false): MapData {
  const [data, setData] = useState<MapData>(_data);
  useEffect(() => {
    if (includeCitizens) _wantCitizens += 1;
    _subs.add(setData);
    setData(_data); // hand back the persisted snapshot right away
    _ensurePolling();
    return () => {
      _subs.delete(setData);
      if (includeCitizens) _wantCitizens = Math.max(0, _wantCitizens - 1);
      _maybeStopPolling();
    };
  }, [includeCitizens]);
  return data;
}

/** Clear the shared snapshot (called on sign-out so one session's view doesn't
 *  bleed into the next before the first refresh). */
export function resetMapData(): void {
  _data = EMPTY;
  for (const fn of _subs) fn(_data);
}

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import MapView from './MapView'
import CityPicker from './CityPicker'
import RoutePanel from './RoutePanel'
import CallsDrawer from './CallsDrawer'
import SeveritySelector from './SeveritySelector'
import WeatherIndicator from './WeatherIndicator'
import SettingsPanel from './SettingsPanel'
import { requestRoute } from '../lib/routing'
import { loadRoadGraph } from '../lib/roadGraph'
import { useWeather } from '../lib/useWeather'
import { createCitizenEngine } from '../sim/citizenEngine'
import {
  DISASTER_TYPES,
  DISASTER_PROFILES,
  getProfile,
  getGeometryMode,
  getAllowedGeometries,
} from '../lib/disasterProfiles'
import {
  FIRE_TRUCK_CAPACITY,
  DISPATCH_MIN_TRUCKS,
  DISPATCH_MAX_TRUCKS,
  POLICE_PATROL_DEFAULT_RADIUS_M,
} from '../lib/config'
import { isPersistableEventId } from '../lib/eventId'

// Disaster types where the cause matters for weather. Other types ignore it.
const CAUSE_AMBIGUOUS_TYPES = ['Flood', 'Power_Outage', 'Infrastructure_Failure']

// Disaster types with an expanding wave; only these expose the spread-speed slider.
const SPREADING_TYPES = ['Flood', 'Wildfire']

// Disaster types that expose the "people inside / safe-exit %" inputs and
// generate escapee citizens at trigger time.
const BUILDING_TYPES = ['Building_Fire']

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

const MAP_STYLES = [
  { value: 'dark',      label: 'Dark' },
  { value: 'colored',   label: 'Streets' },
  { value: 'satellite', label: 'Satellite' },
]

// Default operating area on app load. Bounds match the Manhattan admin boundary
// from OSM/Nominatim. The polygon is a hand-traced approximation of the island
// outline so we can filter the road graph to Manhattan-only nodes (the bbox
// alone includes Jersey City, the Bronx edge, and Queens/Brooklyn edges).
const DEFAULT_CITY = {
  id: 'manhattan-default',
  name: 'Manhattan, New York County, New York, United States',
  shortName: 'Manhattan',
  polygon: {
    type: 'Polygon',
    coordinates: [[
      [-73.923, 40.879],  // Inwood north tip
      [-73.911, 40.864],  // Spuyten Duyvil curve
      [-73.928, 40.835],
      [-73.929, 40.810],  // East Harlem
      [-73.937, 40.795],  // East 96th
      [-73.948, 40.781],  // Upper East 80s
      [-73.958, 40.764],  // East 60s
      [-73.965, 40.752],  // Midtown East
      [-73.969, 40.738],  // East 30s
      [-73.972, 40.726],  // East Village
      [-73.971, 40.711],  // Lower East Side
      [-73.999, 40.701],  // Financial District south
      [-74.018, 40.701],  // Battery west
      [-74.014, 40.717],  // Tribeca west
      [-74.011, 40.733],  // West Village
      [-74.010, 40.752],  // Hell's Kitchen
      [-74.001, 40.769],  // West 60s
      [-73.992, 40.781],
      [-73.980, 40.799],  // Upper West Side
      [-73.968, 40.811],  // Morningside Heights
      [-73.953, 40.835],
      [-73.944, 40.849],  // Washington Heights
      [-73.933, 40.864],  // Fort Tryon
      [-73.923, 40.879],  // close
    ]],
  },
  bounds: [
    [40.6815, -74.0479],
    [40.8820, -73.9070],
  ],
}

const now = () => new Date().toLocaleTimeString('en-US', { hour12: false })

export default function DisasterDashboard() {
  const [disasterType, setDisasterType] = useState('Flood')
  const [severity, setSeverity] = useState(3)
  const [notes, setNotes] = useState('')
  const [cause, setCause] = useState('infrastructure') // 'weather' | 'infrastructure'
  const [spreadSpeed, setSpreadSpeed] = useState(1)     // 0.25× – 4× multiplier
  const [peopleInside, setPeopleInside] = useState(50)  // Building_Fire
  const [safeExitPct, setSafeExitPct] = useState(70)    // Building_Fire (0-100)
  const [spreadInSeconds, setSpreadInSeconds] = useState(30)  // Building_Fire delayed spread
  // When set, the next placed zone is a spread-target of this parent's fire.
  const [nestingParentId, setNestingParentId] = useState(null)
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(false)
  // Per-type override of the geometry mode, only meaningful for types with
  // multiple allowedGeometries (Power_Outage). Falls back to the profile default.
  const [geometryModeOverrides, setGeometryModeOverrides] = useState({})
  const [showCameras, setShowCameras] = useState(false)
  const [showIntersections, setShowIntersections] = useState(false)
  const [mapStyle, setMapStyle] = useState('colored')
  const [city, setCity] = useState(DEFAULT_CITY) // { id, name, shortName, polygon, bounds } | null

  // Routing state
  const [waypoints, setWaypoints] = useState({ start: null, end: null })
  const [waypointMode, setWaypointMode] = useState(null) // 'start' | 'end' | null
  const [route, setRoute] = useState(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeError, setRouteError] = useState(null)

  const [logOpen, setLogOpen] = useState(true)
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'System ready.' },
  ])

  // Citizen simulation + 911 stream
  const [simStatus, setSimStatus] = useState('Loading street network…')
  const [simReady, setSimReady] = useState(false)
  const [citizenCount, setCitizenCount] = useState(0)

  // Emergency-services state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fireStations, setFireStations] = useState([])
  const [hospitals, setHospitals] = useState([])
  const [policeStations, setPoliceStations] = useState([])
  const [stationPlacementMode, setStationPlacementMode] = useState(false)
  const [hospitalPlacementMode, setHospitalPlacementMode] = useState(false)
  const [policePlacementMode, setPolicePlacementMode] = useState(false)
  const [pendingStationName, setPendingStationName] = useState(null)
  const [pendingStationCapacity, setPendingStationCapacity] = useState(4)
  const [pendingHospitalName, setPendingHospitalName] = useState(null)
  const [pendingHospitalCapacity, setPendingHospitalCapacity] = useState(3)
  const [pendingPoliceName, setPendingPoliceName] = useState(null)
  const [pendingPoliceCapacity, setPendingPoliceCapacity] = useState(10)
  const [dispatchTrucks, setDispatchTrucks] = useState(3)
  // Dispatch target is a *search area* — operators click a centre, then a
  // slider sets the radius. Simulates an AI's triangulated guess at the fire
  // location from incoming citizen reports.
  const [dispatchTarget, setDispatchTarget] = useState(null)  // { lat, lng, radius } | null
  const [dispatchTargetMode, setDispatchTargetMode] = useState(false)
  const [dispatchRadius, setDispatchRadius] = useState(400)  // metres
  const [activeDispatches, setActiveDispatches] = useState([])  // [{ id, trucks, target }]
  // Ambulance dispatch
  const [ambDispatchUnits, setAmbDispatchUnits] = useState(2)
  const [ambDispatchTarget, setAmbDispatchTarget] = useState(null)
  const [ambDispatchTargetMode, setAmbDispatchTargetMode] = useState(false)
  const [ambDispatchRadius, setAmbDispatchRadius] = useState(150)
  const [activeAmbulanceDispatches, setActiveAmbulanceDispatches] = useState([])
  // Police manual patrol
  const [policeDispatchUnits, setPoliceDispatchUnits] = useState(3)
  const [policeDispatchTarget, setPoliceDispatchTarget] = useState(null)
  const [policeDispatchTargetMode, setPoliceDispatchTargetMode] = useState(false)
  const [policeDispatchRadius, setPoliceDispatchRadius] = useState(400)
  const [activePoliceDispatches, setActivePoliceDispatches] = useState([])
  // Robbery context menu (right-click on a citizen)
  const [crimeMenu, setCrimeMenu] = useState(null) // { citizenIdx, x, y } | null
  const [notifications, setNotifications] = useState([])
  const [cordons, setCordons] = useState([])
  const [notifReason, setNotifReason] = useState('')
  const [polygonDrawKind, setPolygonDrawKind] = useState(null)  // 'notification' | 'cordon' | null
  const [simSpeed, setSimSpeed] = useState(1)
  const [citizenReports, setCitizenReports] = useState([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [callFilter, setCallFilter] = useState('all')
  const [engine, setEngine] = useState(null)
  const zonesRef = useRef(zones)
  const pendingReportsRef = useRef([])
  const notificationsRef = useRef([])
  const cordonsRef = useRef([])

  // Mocked weather: re-fetched on mount, every 15 s, and after every trigger.
  const { weather, refresh: refreshWeather } = useWeather()

  // Push simSpeed changes into the engine's tick loop.
  useEffect(() => {
    if (!engine) return
    engine.setSpeed(simSpeed)
  }, [engine, simSpeed])

  const addLog = (type, message) =>
    setLog((prev) => [{ type, time: now(), message }, ...prev].slice(0, 80))

  // Resolved geometry mode for the currently-selected type (override wins).
  const activeGeometryMode =
    geometryModeOverrides[disasterType] || getGeometryMode(disasterType)
  const allowedGeometries = getAllowedGeometries(disasterType)

  // Clamp severity into the current type's range whenever the type changes.
  useEffect(() => {
    const p = getProfile(disasterType)
    if (!p) return
    const { min, max } = p.severity
    if (severity < min) setSeverity(min)
    else if (severity > max) setSeverity(max)
  }, [disasterType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Draft values (what the next-drawn zone will inherit) — kept in a ref so
  // the zone-add callback has stable identity and doesn't re-bind Geoman.
  const draftRef = useRef({
    disasterType, severity, notes, cause, spreadSpeed,
    peopleInside, safeExitPct, spreadInSeconds, nestingParentId,
    geometryMode: activeGeometryMode,
  })
  useEffect(() => {
    draftRef.current = {
      disasterType, severity, notes, cause, spreadSpeed,
      peopleInside, safeExitPct, spreadInSeconds, nestingParentId,
      geometryMode: activeGeometryMode,
    }
  }, [disasterType, severity, notes, cause, spreadSpeed, peopleInside, safeExitPct, spreadInSeconds, nestingParentId, activeGeometryMode])

  // Mirror zones into a ref so the citizen engine (created once) always reads
  // the latest array without re-binding its tick handler.
  useEffect(() => {
    zonesRef.current = zones
  }, [zones])
  useEffect(() => { notificationsRef.current = notifications }, [notifications])
  useEffect(() => { cordonsRef.current = cordons }, [cordons])

  // Boot the road graph + citizen engine once on mount (Manhattan bounds).
  useEffect(() => {
    let cancelled = false
    let localEngine = null
    let unsubscribeCount = null
    const ctrl = new AbortController()

    ;(async () => {
      try {
        const graph = await loadRoadGraph(DEFAULT_CITY.bounds, {
          signal: ctrl.signal,
          polygon: DEFAULT_CITY.polygon,
          onProgress: (msg) => !cancelled && setSimStatus(msg),
          // Pre-baked Manhattan graph — see frontend/scripts/bake-road-graph.mjs.
          // Loader falls back to live Overpass automatically if this 404s.
          bakedPath: '/road-graph-manhattan.json',
        })
        if (cancelled) return
        const CITIZEN_COUNT = 1500
        localEngine = createCitizenEngine({
          roadGraph: graph,
          count: CITIZEN_COUNT,
          getZones: () => zonesRef.current,
          getNotifications: () => notificationsRef.current,
          getCordons: () => cordonsRef.current,
          onReport: (r) => {
            pendingReportsRef.current.push(r)
          },
          onZoneResolved: (zoneId) => {
            // Engine signalled a fire has been put out. Mirror to backend +
            // local state. Also recall any trucks targeting this zone.
            fetch(`${BACKEND_URL}/api/disasters/${zoneId}`, { method: 'DELETE' }).catch(() => {})
            setZones((prev) => prev.filter((z) => z.id !== zoneId))
          },
          onScheduledSpread: (parentId, childIds) => {
            // Building Fire spread timer elapsed — activate the child fires
            // unless they've already been activated or removed.
            for (const childId of childIds) {
              fetch(`${BACKEND_URL}/api/disasters/${childId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'active' }),
              }).catch(() => {})
              setZones((prev) =>
                prev.map((z) =>
                  z.id === childId && z.status === 'draft'
                    ? { ...z, status: 'active', triggeredAt: localEngine.getCurrentTime() }
                    : z,
                ),
              )
            }
          },
          onUnitReturned: ({ kind, stationId, units }) => {
            // Decrement the station's *_dispatched counter so the capacity
            // badge reflects reality. Refresh that station's table only.
            const path = kind === 'firefighter' ? 'fire-stations'
                       : kind === 'ambulance' ? 'hospitals'
                       : 'police-stations'
            fetch(`${BACKEND_URL}/api/${path}/${stationId}/return_ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ units }),
            }).then(async () => {
              // Re-fetch the relevant station list so the badge updates.
              const listRes = await fetch(`${BACKEND_URL}/api/${path}`)
              if (!listRes.ok) return
              const json = await listRes.json()
              if (kind === 'firefighter') setFireStations(json.stations || [])
              else if (kind === 'ambulance') setHospitals(json.hospitals || [])
              else setPoliceStations(json.stations || [])
            }).catch(() => {})
          },
          onCriminalCaught: ({ criminalIdx, policeIdx }) => {
            addLog('success', `Officer detained suspect (citizen #${criminalIdx}).`)
          },
        })
        localEngine.start()
        setEngine(localEngine)
        setSimReady(true)
        // Zero out persisted *_dispatched counters: the engine just (re)started
        // with no units alive, so any leftover values from a previous session
        // would mark stations as "at capacity" forever and block auto-patrol.
        try {
          await fetch(`${BACKEND_URL}/api/reset-dispatched`, { method: 'POST' })
        } catch { /* offline; counters may drift but it's not fatal */ }
        // Wire the citizen pill to the engine's live count. Fires every tick
        // (≤50 ms cadence at speed=1); React bails out when the value is
        // unchanged, so this is effectively free for steady-state ticks.
        unsubscribeCount = localEngine.subscribe(() => {
          setCitizenCount(localEngine.snapshot().liveCount)
        })
        setCitizenCount(localEngine.snapshot().liveCount)
        setSimStatus(`${graph.size()} street nodes loaded.`)
      } catch (err) {
        if (err.name === 'AbortError') return
        console.warn('Citizen sim failed to start:', err)
        setSimStatus(`Sim offline: ${err.message}`)
      }
    })()

    return () => {
      cancelled = true
      ctrl.abort()
      if (unsubscribeCount) unsubscribeCount()
      if (localEngine) localEngine.stop()
      setEngine(null)
    }
  }, [])

  // Batched flush of pending reports: append to UI state and POST to backend
  // every 2 s. Keeps the call drawer responsive without spamming the network.
  useEffect(() => {
    const flush = async () => {
      const batch = pendingReportsRef.current
      if (batch.length === 0) return
      pendingReportsRef.current = []

      // Enrich each report with id, reported_at, and the event's type for the UI.
      const zonesNow = zonesRef.current
      const enriched = batch.map((r) => {
        const z = zonesNow.find((z) => z.id === r.event_id)
        return {
          ...r,
          id: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          reported_at: new Date().toISOString(),
          event_type: z?.type,
        }
      })

      setCitizenReports((prev) => {
        const next = [...enriched, ...prev]
        return next.length > 500 ? next.slice(0, 500) : next
      })

      // Fire-and-forget POST. Failures are not fatal; reports remain in UI.
      // Filter out reports whose event_id isn't a real disaster UUID — crime
      // events use a synthetic 'crime:<idx>:<t>' id that doesn't (and shouldn't)
      // exist in disaster_events, so the DB UUID column rejects it.
      const persistable = batch.filter((r) => isPersistableEventId(r.event_id))
      if (persistable.length === 0) return
      try {
        await fetch(`${BACKEND_URL}/api/citizen-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reports: persistable.map((r) => ({
              event_id: r.event_id,
              citizen_idx: r.citizen_idx,
              report_kind: r.report_kind,
              location: r.location,
              transcript: r.transcript,
              perceived_severity: r.perceived_severity,
            })),
          }),
        })
      } catch {
        /* offline / backend down — drop silently */
      }
    }

    const id = setInterval(flush, 2000)
    return () => clearInterval(id)
  }, [])

  // Initial fetch of fire stations, hospitals, police stations + active
  // notifications/cordons. These persist across reloads, unlike the in-flight
  // dispatches.
  useEffect(() => {
    let cancelled = false
    const fetchAll = async () => {
      try {
        const [s, h, p, n, c] = await Promise.all([
          fetch(`${BACKEND_URL}/api/fire-stations`).then((r) => r.ok ? r.json() : { stations: [] }),
          fetch(`${BACKEND_URL}/api/hospitals`).then((r) => r.ok ? r.json() : { hospitals: [] }),
          fetch(`${BACKEND_URL}/api/police-stations`).then((r) => r.ok ? r.json() : { stations: [] }),
          fetch(`${BACKEND_URL}/api/notifications`).then((r) => r.ok ? r.json() : { notifications: [] }),
          fetch(`${BACKEND_URL}/api/cordons`).then((r) => r.ok ? r.json() : { cordons: [] }),
        ])
        if (cancelled) return
        setFireStations(s.stations || [])
        setHospitals(h.hospitals || [])
        setPoliceStations(p.stations || [])
        setNotifications(n.notifications || [])
        setCordons(c.cordons || [])
      } catch { /* offline; stays empty */ }
    }
    fetchAll()
    return () => { cancelled = true }
  }, [])

  // Station placement handlers
  const handleStationPlace = useCallback(async ({ lat, lng }) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/fire-stations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, name: pendingStationName, truck_count: pendingStationCapacity }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/fire-stations`).then((r) => r.json())
        setFireStations(refreshed.stations || [])
        addLog('success', `Fire station placed (${pendingStationCapacity} trucks).`)
      } else {
        addLog('error', `Fire station POST failed (${res.status}). Is the backend running with the latest code?`)
      }
    } catch (e) {
      addLog('error', `Fire station POST failed: ${e?.message || 'offline'}`)
    }
    setStationPlacementMode(false)
    setPendingStationName(null)
  }, [pendingStationName, pendingStationCapacity]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStationRemove = useCallback(async (id) => {
    setFireStations((prev) => prev.filter((s) => s.id !== id))
    fetch(`${BACKEND_URL}/api/fire-stations/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  // Update an existing station's capacity in-place.
  const handleStationCapacityChange = useCallback(async (id, count) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/fire-stations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/fire-stations`).then((r) => r.json())
        setFireStations(refreshed.stations || [])
      } else {
        addLog('error', `Fire station PATCH failed (${res.status}).`)
      }
    } catch (e) {
      addLog('error', `Fire station PATCH failed: ${e?.message || 'offline'}`)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Hospital placement handlers (mirror fire station)
  const handleHospitalPlace = useCallback(async ({ lat, lng }) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/hospitals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, name: pendingHospitalName, ambulance_count: pendingHospitalCapacity }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/hospitals`).then((r) => r.json())
        setHospitals(refreshed.hospitals || [])
        addLog('success', `Hospital placed (${pendingHospitalCapacity} ambulances).`)
      } else {
        addLog('error', `Hospital POST failed (${res.status}). Restart the backend to pick up new endpoints.`)
      }
    } catch (e) {
      addLog('error', `Hospital POST failed: ${e?.message || 'offline'}`)
    }
    setHospitalPlacementMode(false)
    setPendingHospitalName(null)
  }, [pendingHospitalName, pendingHospitalCapacity]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleHospitalRemove = useCallback(async (id) => {
    setHospitals((prev) => prev.filter((h) => h.id !== id))
    fetch(`${BACKEND_URL}/api/hospitals/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const handleHospitalCapacityChange = useCallback(async (id, count) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/hospitals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/hospitals`).then((r) => r.json())
        setHospitals(refreshed.hospitals || [])
      } else {
        addLog('error', `Hospital PATCH failed (${res.status}).`)
      }
    } catch (e) {
      addLog('error', `Hospital PATCH failed: ${e?.message || 'offline'}`)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Police station placement handlers (mirror fire station)
  const handlePolicePlace = useCallback(async ({ lat, lng }) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/police-stations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, name: pendingPoliceName, police_count: pendingPoliceCapacity }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/police-stations`).then((r) => r.json())
        setPoliceStations(refreshed.stations || [])
        addLog('success', `Police station placed (${pendingPoliceCapacity} officers).`)
      } else {
        addLog('error', `Police station POST failed (${res.status}). Restart the backend to pick up new endpoints.`)
      }
    } catch (e) {
      addLog('error', `Police station POST failed: ${e?.message || 'offline'}`)
    }
    setPolicePlacementMode(false)
    setPendingPoliceName(null)
  }, [pendingPoliceName, pendingPoliceCapacity]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePoliceRemove = useCallback(async (id) => {
    setPoliceStations((prev) => prev.filter((p) => p.id !== id))
    fetch(`${BACKEND_URL}/api/police-stations/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const handlePoliceCapacityChange = useCallback(async (id, count) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/police-stations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      })
      if (res.ok) {
        const refreshed = await fetch(`${BACKEND_URL}/api/police-stations`).then((r) => r.json())
        setPoliceStations(refreshed.stations || [])
      } else {
        addLog('error', `Police station PATCH failed (${res.status}).`)
      }
    } catch (e) {
      addLog('error', `Police station PATCH failed: ${e?.message || 'offline'}`)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-station dispatch. Sorts stations by distance to the target and
  // pulls trucks from each in turn until the request is fulfilled or every
  // station is dry. Each station's ack is atomic so capacity caps are
  // honoured even if multiple operators race.
  const handleDispatch = useCallback(async () => {
    if (!dispatchTarget || !engine) {
      addLog('error', 'Place a target on the map first.')
      return
    }
    if (fireStations.length === 0) {
      addLog('error', 'No fire stations configured. Open Settings (⚙) to add one.')
      return
    }
    const sorted = fireStations
      .map((s) => ({ s, d: Math.hypot(s.lat - dispatchTarget.lat, s.lng - dispatchTarget.lng) }))
      .sort((a, b) => a.d - b.d)
    let remaining = dispatchTrucks
    const newDispatches = []
    // First, re-task any RETURNING trucks so they don't waste the round trip
    // home before being useful. Re-tasked trucks keep their original
    // capacity allocation — no ack needed.
    if (engine.retaskReturningTrucks && remaining > 0) {
      const retaskId = `retask-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`
      const retasked = engine.retaskReturningTrucks(retaskId, dispatchTarget, remaining)
      if (retasked > 0) {
        newDispatches.push({ id: retaskId, trucks: retasked, target: dispatchTarget, stationName: 'returning crews' })
        remaining -= retasked
      }
    }
    for (const { s } of sorted) {
      if (remaining <= 0) break
      const available = (s.truck_count ?? 0) - (s.trucks_dispatched ?? 0)
      if (available <= 0) continue
      const toTake = Math.min(remaining, available)
      let ackOk = false
      try {
        const ack = await fetch(`${BACKEND_URL}/api/fire-stations/${s.id}/dispatch_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: toTake }),
        })
        ackOk = ack.ok
      } catch { /* offline */ }
      if (!ackOk) continue
      fetch(`${BACKEND_URL}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'firefighter', trucks: toTake, target: dispatchTarget, station_id: s.id }),
      }).catch(() => {})
      const dispatchId = `disp-${Date.now()}-${s.id.slice(0, 4)}-${Math.random().toString(36).slice(2, 4)}`
      const spawned = engine.spawnFireTrucks
        ? engine.spawnFireTrucks(dispatchId, { lat: s.lat, lng: s.lng }, dispatchTarget, toTake, s.id)
        : 0
      // Refund any shortfall so the counter doesn't drift.
      const shortfall = toTake - spawned
      if (shortfall > 0) {
        fetch(`${BACKEND_URL}/api/fire-stations/${s.id}/return_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: shortfall }),
        }).catch(() => {})
      }
      if (spawned > 0) {
        newDispatches.push({ id: dispatchId, trucks: spawned, target: dispatchTarget, stationName: s.name || 'Station' })
        remaining -= spawned
      }
    }
    if (newDispatches.length > 0) {
      setActiveDispatches((prev) => [...prev, ...newDispatches])
      const total = newDispatches.reduce((n, d) => n + d.trucks, 0)
      const names = newDispatches.map((d) => `${d.trucks}× ${d.stationName}`).join(', ')
      addLog('success', `Dispatched ${total} truck${total === 1 ? '' : 's'} (${names}).`)
    }
    if (remaining > 0) {
      addLog('error', `Short ${remaining} truck${remaining === 1 ? '' : 's'} — every station is at capacity.`)
    }
    fetch(`${BACKEND_URL}/api/fire-stations`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (j) setFireStations(j.stations || [])
    }).catch(() => {})
    setDispatchTarget(null)
  }, [dispatchTarget, dispatchTrucks, fireStations, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRecall = useCallback((dispatchId) => {
    if (engine?.recallTrucks) engine.recallTrucks(dispatchId)
    setActiveDispatches((prev) => prev.filter((d) => d.id !== dispatchId))
    addLog('info', `Trucks recalled.`)
  }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-hospital ambulance dispatch — same fan-out pattern as firefighters.
  const handleAmbulanceDispatch = useCallback(async () => {
    if (!ambDispatchTarget || !engine) {
      addLog('error', 'Place an ambulance target on the map first.')
      return
    }
    if (hospitals.length === 0) {
      addLog('error', 'No hospitals configured. Open Settings (⚙) to add one.')
      return
    }
    const sorted = hospitals
      .map((h) => ({ h, d: Math.hypot(h.lat - ambDispatchTarget.lat, h.lng - ambDispatchTarget.lng) }))
      .sort((a, b) => a.d - b.d)
    let remaining = ambDispatchUnits
    const newDispatches = []
    if (engine.retaskReturningAmbulances && remaining > 0) {
      const retaskId = `retask-amb-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`
      const retasked = engine.retaskReturningAmbulances(retaskId, ambDispatchTarget, remaining)
      if (retasked > 0) {
        newDispatches.push({ id: retaskId, units: retasked, target: ambDispatchTarget, stationName: 'returning crews' })
        remaining -= retasked
      }
    }
    for (const { h } of sorted) {
      if (remaining <= 0) break
      const available = (h.ambulance_count ?? 0) - (h.ambulances_dispatched ?? 0)
      if (available <= 0) continue
      const toTake = Math.min(remaining, available)
      let ackOk = false
      try {
        const ack = await fetch(`${BACKEND_URL}/api/hospitals/${h.id}/dispatch_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: toTake }),
        })
        ackOk = ack.ok
      } catch { /* offline */ }
      if (!ackOk) continue
      fetch(`${BACKEND_URL}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'ambulance', units: toTake, target: ambDispatchTarget, station_id: h.id }),
      }).catch(() => {})
      const dispatchId = `amb-${Date.now()}-${h.id.slice(0, 4)}-${Math.random().toString(36).slice(2, 4)}`
      const spawned = engine.spawnAmbulances
        ? engine.spawnAmbulances(dispatchId, { lat: h.lat, lng: h.lng }, ambDispatchTarget, toTake, h.id)
        : 0
      const shortfall = toTake - spawned
      if (shortfall > 0) {
        fetch(`${BACKEND_URL}/api/hospitals/${h.id}/return_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: shortfall }),
        }).catch(() => {})
      }
      if (spawned > 0) {
        newDispatches.push({ id: dispatchId, units: spawned, target: ambDispatchTarget, stationName: h.name || 'Hospital' })
        remaining -= spawned
      }
    }
    if (newDispatches.length > 0) {
      setActiveAmbulanceDispatches((prev) => [...prev, ...newDispatches])
      const total = newDispatches.reduce((n, d) => n + d.units, 0)
      const names = newDispatches.map((d) => `${d.units}× ${d.stationName}`).join(', ')
      addLog('success', `Dispatched ${total} ambulance${total === 1 ? '' : 's'} (${names}).`)
    }
    if (remaining > 0) {
      addLog('error', `Short ${remaining} ambulance${remaining === 1 ? '' : 's'} — every hospital is at capacity.`)
    }
    fetch(`${BACKEND_URL}/api/hospitals`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (j) setHospitals(j.hospitals || [])
    }).catch(() => {})
    setAmbDispatchTarget(null)
  }, [ambDispatchTarget, ambDispatchUnits, hospitals, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAmbulanceRecall = useCallback((dispatchId) => {
    if (engine?.recallAmbulances) engine.recallAmbulances(dispatchId)
    setActiveAmbulanceDispatches((prev) => prev.filter((d) => d.id !== dispatchId))
    addLog('info', 'Ambulances recalled.')
  }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-precinct manual patrol — same fan-out pattern as firefighters.
  const handlePoliceDispatchManual = useCallback(async () => {
    if (!policeDispatchTarget || !engine) {
      addLog('error', 'Place a patrol target on the map first.')
      return
    }
    if (policeStations.length === 0) {
      addLog('error', 'No police stations configured. Open Settings (⚙) to add one.')
      return
    }
    const sorted = policeStations
      .map((p) => ({ p, d: Math.hypot(p.lat - policeDispatchTarget.lat, p.lng - policeDispatchTarget.lng) }))
      .sort((a, b) => a.d - b.d)
    let remaining = policeDispatchUnits
    const newDispatches = []
    if (engine.retaskReturningPolice && remaining > 0) {
      const retaskId = `manual-retask-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`
      const retasked = engine.retaskReturningPolice(retaskId, policeDispatchTarget, remaining)
      if (retasked > 0) {
        newDispatches.push({ id: retaskId, units: retasked, target: policeDispatchTarget, stationName: 'returning crews' })
        remaining -= retasked
      }
    }
    for (const { p } of sorted) {
      if (remaining <= 0) break
      const available = (p.police_count ?? 0) - (p.police_dispatched ?? 0)
      if (available <= 0) continue
      const toTake = Math.min(remaining, available)
      let ackOk = false
      try {
        const ack = await fetch(`${BACKEND_URL}/api/police-stations/${p.id}/dispatch_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: toTake }),
        })
        ackOk = ack.ok
      } catch { /* offline */ }
      if (!ackOk) continue
      fetch(`${BACKEND_URL}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'police', units: toTake, target: policeDispatchTarget, station_id: p.id }),
      }).catch(() => {})
      const dispatchId = `manual-${Date.now()}-${p.id.slice(0, 4)}-${Math.random().toString(36).slice(2, 4)}`
      const spawned = engine.spawnPolice
        ? engine.spawnPolice(dispatchId, { lat: p.lat, lng: p.lng }, policeDispatchTarget, toTake, p.id)
        : 0
      const shortfall = toTake - spawned
      if (shortfall > 0) {
        fetch(`${BACKEND_URL}/api/police-stations/${p.id}/return_ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: shortfall }),
        }).catch(() => {})
      }
      if (spawned > 0) {
        newDispatches.push({ id: dispatchId, units: spawned, target: policeDispatchTarget, stationName: p.name || 'Station' })
        remaining -= spawned
      }
    }
    if (newDispatches.length > 0) {
      setActivePoliceDispatches((prev) => [...prev, ...newDispatches])
      const total = newDispatches.reduce((n, d) => n + d.units, 0)
      const names = newDispatches.map((d) => `${d.units}× ${d.stationName}`).join(', ')
      addLog('success', `Dispatched ${total} officer${total === 1 ? '' : 's'} (${names}).`)
    }
    if (remaining > 0) {
      addLog('error', `Short ${remaining} officer${remaining === 1 ? '' : 's'} — every station is at capacity.`)
    }
    fetch(`${BACKEND_URL}/api/police-stations`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (j) setPoliceStations(j.stations || [])
    }).catch(() => {})
    setPoliceDispatchTarget(null)
  }, [policeDispatchTarget, policeDispatchUnits, policeStations, engine]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePoliceRecall = useCallback((dispatchId) => {
    if (engine?.recallPolice) engine.recallPolice(dispatchId)
    setActivePoliceDispatches((prev) => prev.filter((d) => d.id !== dispatchId))
    addLog('info', 'Patrol recalled.')
  }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // Robbery context-menu handlers
  const handleCitizenContextMenu = useCallback((idx, x, y) => {
    setCrimeMenu({ citizenIdx: idx, x, y })
  }, [])

  const handleTriggerRobbery = useCallback((level) => {
    if (!engine?.triggerRobbery || !crimeMenu) return
    const res = engine.triggerRobbery(crimeMenu.citizenIdx, level)
    if (res?.result === 'caught') addLog('success', `L${level} robbery: suspect caught by officer on scene.`)
    else if (res?.result === 'committed' && res.injuredIdx >= 0) addLog('error', `L${level} robbery: bystander injured. Dispatch an ambulance.`)
    else if (res?.result === 'committed') addLog('info', `L${level} robbery: no one injured.`)
    setCrimeMenu(null)
  }, [engine, crimeMenu]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close the crime menu on any click outside it.
  useEffect(() => {
    if (!crimeMenu) return
    const close = () => setCrimeMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [crimeMenu])

  // ~50% auto-patrol: for each police station, keep round(police_count * 0.5)
  // officers out on baseline patrol. Refills when one of those officers
  // despawns at the station (e.g. stuck-detection sent them home).
  // Manual operator dispatches stack on top of this baseline.
  useEffect(() => {
    if (!engine?.spawnPolice || !engine.getAutoPoliceCounts) return
    let cancelled = false
    const checkAndDeploy = async () => {
      if (cancelled) return
      if (policeStations.length === 0) return
      const auto = engine.getAutoPoliceCounts()
      for (const ps of policeStations) {
        const target = Math.round((ps.police_count ?? 0) * 0.5)
        const current = auto.get(ps.id) || 0
        if (current >= target) continue
        const available = (ps.police_count ?? 0) - (ps.police_dispatched ?? 0)
        if (available <= 0) {
          console.warn(`[auto-patrol] ${ps.name || ps.id}: at capacity (${ps.police_dispatched}/${ps.police_count}); skipping`)
          continue
        }
        const need = Math.min(target - current, available)
        if (need <= 0) continue
        let ackOk = false
        try {
          const ack = await fetch(`${BACKEND_URL}/api/police-stations/${ps.id}/dispatch_ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ units: need }),
          })
          ackOk = ack.ok
          if (!ackOk) {
            console.warn(`[auto-patrol] ${ps.name || ps.id}: dispatch_ack returned ${ack.status}`)
          }
        } catch (e) {
          console.warn(`[auto-patrol] ${ps.name || ps.id}: dispatch_ack failed`, e?.message)
        }
        if (!ackOk) continue
        const dispatchId = `auto-${ps.id}-${Date.now()}`
        const spawned = engine.spawnPolice(
          dispatchId,
          { lat: ps.lat, lng: ps.lng },
          { lat: ps.lat, lng: ps.lng, radius: POLICE_PATROL_DEFAULT_RADIUS_M },
          need,
          ps.id,
        )
        // Refund any units the engine couldn't actually spawn so the DB
        // counter doesn't drift over time (eventually stranding the station
        // at "capacity" with no actual officers out).
        const shortfall = need - spawned
        if (shortfall > 0) {
          console.warn(`[auto-patrol] ${ps.name || ps.id}: requested ${need}, engine spawned ${spawned}; refunding ${shortfall}`)
          try {
            await fetch(`${BACKEND_URL}/api/police-stations/${ps.id}/return_ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ units: shortfall }),
            })
          } catch { /* offline */ }
        }
        if (spawned > 0) {
          console.info(`[auto-patrol] ${ps.name || ps.id}: deployed ${spawned} officer${spawned === 1 ? '' : 's'}`)
        }
        // Refresh station list so the capacity badge reflects the auto-deploy.
        fetch(`${BACKEND_URL}/api/police-stations`).then((r) => r.ok ? r.json() : null).then((j) => {
          if (j && !cancelled) setPoliceStations(j.stations || [])
        }).catch(() => {})
      }
    }
    // Fire immediately so the operator sees cops appear right after placing a
    // station — don't wait 3 s for the first interval tick.
    checkAndDeploy()
    const id = setInterval(checkAndDeploy, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [engine, policeStations])

  // Subscribe to engine ticks and prune any active-dispatch entry whose units
  // have all despawned. Without this the panel keeps showing "7 from Station"
  // even after every unit has made it back.
  useEffect(() => {
    if (!engine?.subscribe) return
    const unsub = engine.subscribe(() => {
      if (engine.getActiveDispatchIds) {
        const live = engine.getActiveDispatchIds()
        setActiveDispatches((prev) => {
          const next = prev.filter((d) => live.has(d.id))
          return next.length === prev.length ? prev : next
        })
      }
      if (engine.getActiveAmbulanceDispatchIds) {
        const live = engine.getActiveAmbulanceDispatchIds()
        setActiveAmbulanceDispatches((prev) => {
          const next = prev.filter((d) => live.has(d.id))
          return next.length === prev.length ? prev : next
        })
      }
      if (engine.getActivePoliceDispatchIds) {
        const live = engine.getActivePoliceDispatchIds()
        setActivePoliceDispatches((prev) => {
          const next = prev.filter((d) => live.has(d.id))
          return next.length === prev.length ? prev : next
        })
      }
    })
    return unsub
  }, [engine])

  // Notify / cordon polygon completion
  const handlePolygonDraw = useCallback(async (geometry) => {
    if (polygonDrawKind === 'notification') {
      const reason = notifReason.trim() || 'Evacuate the area'
      try {
        const res = await fetch(`${BACKEND_URL}/api/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ geometry, reason }),
        })
        if (res.ok) {
          const r = await res.json()
          setNotifications((prev) => [
            { id: r.id, geometry, reason, status: 'active', created_at: new Date().toISOString() },
            ...prev,
          ])
          addLog('success', `Notification sent: ${reason}`)
        }
      } catch { /* offline */ }
    } else if (polygonDrawKind === 'cordon') {
      const reason = notifReason.trim() || null
      try {
        const res = await fetch(`${BACKEND_URL}/api/cordons`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ geometry, reason }),
        })
        if (res.ok) {
          const r = await res.json()
          setCordons((prev) => [
            { id: r.id, geometry, reason, status: 'active', created_at: new Date().toISOString() },
            ...prev,
          ])
          addLog('success', `Cordon active: ${reason || 'no entry'}`)
        }
      } catch { /* offline */ }
    }
    setPolygonDrawKind(null)
    setNotifReason('')
  }, [polygonDrawKind, notifReason]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClearNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    fetch(`${BACKEND_URL}/api/notifications/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const handleClearCordon = useCallback((id) => {
    setCordons((prev) => prev.filter((c) => c.id !== id))
    fetch(`${BACKEND_URL}/api/cordons/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  // Persist a freshly-drawn zone to Postgres as 'draft' and refresh the
  // weather indicator as soon as the write lands. The caller doesn't need
  // to await — the zone is already in local state optimistically; only the
  // weather pill races the network round-trip (~100-200 ms typical).
  const postDraftZone = async (zone) => {
    try {
      await fetch(`${BACKEND_URL}/api/trigger-disaster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: zone.id,
          disaster_type: zone.type,
          severity: zone.severity,
          geometry: zone.geometry,
          geometry_kind: zone.geometryKind,
          notes: zone.notes,
          cause: zone.cause ?? null,
          status: 'draft',
          spread_speed: zone.spreadSpeed ?? 1,
          people_inside: zone.peopleInside ?? null,
          safe_exit_pct: zone.safeExitPct ?? null,
          parent_id: zone.parentId ?? null,
          spread_in_seconds: zone.spreadInSeconds ?? null,
        }),
      })
    } catch {
      /* offline; the 1-s poll backstop will sync once the backend is reachable */
    }
    refreshWeather()
  }

  const handleZoneAdd = useCallback(({ id, geometry }) => {
    const d = draftRef.current
    const t = DISASTER_TYPES.find((x) => x.value === d.disasterType) || DISASTER_TYPES[0]
    // Infer geometryKind from the actual geometry produced — Geoman emits
    // 'Point' for marker-points and circles, 'Polygon' for everything else.
    const isPoint = geometry?.type === 'Point' && geometry?.radius_metres == null
    const geometryKind = isPoint ? 'point' : 'area'
    const isBuilding = BUILDING_TYPES.includes(d.disasterType)
    const zone = {
      id,
      type: d.disasterType,
      typeLabel: t.label,
      typeIcon: t.icon,
      color: t.color,
      severity: d.severity,
      notes: d.notes.trim() || null,
      cause: CAUSE_AMBIGUOUS_TYPES.includes(d.disasterType) ? d.cause : null,
      spreadSpeed: SPREADING_TYPES.includes(d.disasterType) ? d.spreadSpeed : 1,
      peopleInside: isBuilding ? d.peopleInside : null,
      safeExitPct: isBuilding ? d.safeExitPct : null,
      parentId: isBuilding ? d.nestingParentId : null,
      spreadInSeconds: isBuilding ? d.spreadInSeconds : null,
      triggeredAt: null,
      status: 'draft',
      geometry,
      geometryKind,
    }
    setZones((prev) => [...prev, zone])
    postDraftZone(zone)
    // Exit nesting-placement mode once the spread target has been placed —
    // a single click means a single neighbour. Operator can click "+ Spread"
    // again on the parent card if they want more neighbours.
    if (zone.parentId) setNestingParentId(null)
    setLog((prev) =>
      [{ type: 'info', time: now(), message: `Zone added: ${t.label} (severity ${d.severity}).` }, ...prev].slice(0, 80),
    )
  }, [])

  // City-wide event entry — no Geoman drawing involved. Operator clicks the
  // "Add citywide" button in the sidebar.
  const handleAddCitywideZone = useCallback(() => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const t = DISASTER_TYPES.find((x) => x.value === disasterType) || DISASTER_TYPES[0]
    const zone = {
      id,
      type: disasterType,
      typeLabel: t.label,
      typeIcon: t.icon,
      color: t.color,
      severity,
      notes: notes.trim() || null,
      cause: CAUSE_AMBIGUOUS_TYPES.includes(disasterType) ? cause : null,
      spreadSpeed: SPREADING_TYPES.includes(disasterType) ? spreadSpeed : 1,
      triggeredAt: null,
      status: 'draft',
      geometry: null,
      geometryKind: 'city',
    }
    setZones((prev) => [...prev, zone])
    postDraftZone(zone)
    addLog('info', `Citywide ${t.label} added (severity ${severity}).`)
  }, [disasterType, severity, notes, cause, spreadSpeed]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleZoneUpdate = useCallback((id, patch) => {
    setZones((prev) => prev.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }, [])

  const handleZoneRemove = useCallback((id) => {
    setZones((prev) => prev.filter((z) => z.id !== id))
    fetch(`${BACKEND_URL}/api/disasters/${id}`, { method: 'DELETE' })
      .catch(() => {})
      .finally(() => refreshWeather())
    setLog((prev) =>
      [{ type: 'info', time: now(), message: 'Zone removed.' }, ...prev].slice(0, 80),
    )
  }, [refreshWeather])

  const handleClearAllZones = useCallback(() => {
    if (zones.length === 0) return
    const count = zones.length
    setZones([])
    fetch(`${BACKEND_URL}/api/disasters`, { method: 'DELETE' })
      .catch(() => {})
      .finally(() => refreshWeather())
    setLog((prev) =>
      [{ type: 'info', time: now(), message: `Cleared all zones (${count}).` }, ...prev].slice(0, 80),
    )
  }, [zones.length, refreshWeather])

  // ── Routing handlers ───────────────────────────────────────
  const handleWaypointPick = useCallback((point) => {
    setWaypoints((prev) => {
      if (!waypointMode) return prev
      return { ...prev, [waypointMode]: point }
    })
    setWaypointMode(null)
  }, [waypointMode])

  const handleClearWaypoint = (which) => {
    setWaypoints((prev) => ({ ...prev, [which]: null }))
    setRoute(null)
    setRouteError(null)
  }

  const handleClearAllWaypoints = () => {
    setWaypoints({ start: null, end: null })
    setWaypointMode(null)
    setRoute(null)
    setRouteError(null)
  }

  // Focus target sent to MapView when the user clicks a 911 report row.
  // MapView clears its own internal "focus" once it has panned.
  const [focusPoint, setFocusPoint] = useState(null)
  const handleReportClick = useCallback((r) => {
    if (r?.location) {
      setFocusPoint({ lat: r.location.lat, lng: r.location.lng, t: Date.now() })
    }
  }, [])

  const typeIconLookup = useMemo(() => {
    const lookup = new Map(DISASTER_TYPES.map((d) => [d.value, d.icon]))
    return (t) => lookup.get(t) || ''
  }, [])

  // Citizen inspector: click a dot on the map → capture its stats so we can
  // figure out why a particular citizen isn't behaving as expected.
  const [inspectedCitizen, setInspectedCitizen] = useState(null)
  const handleCitizenClick = useCallback((idx) => {
    if (!engine) return
    const stats = engine.getCitizenStats?.(idx)
    if (!stats) return
    setInspectedCitizen(stats)
    // Also dump to console for copy-paste / longer inspection.
    // eslint-disable-next-line no-console
    console.log('[Citizen]', stats)
  }, [engine])

  // Recompute the route whenever waypoints or avoid-zones change.
  useEffect(() => {
    if (!waypoints.start || !waypoints.end) {
      setRoute(null)
      setRouteError(null)
      return
    }
    const ctrl = new AbortController()
    setRouteLoading(true)
    setRouteError(null)
    requestRoute({
      start: waypoints.start,
      end: waypoints.end,
      zones,
      signal: ctrl.signal,
    })
      .then((r) => {
        setRoute(r)
        setRouteError(null)
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setRoute(null)
        setRouteError(err.message)
      })
      .finally(() => setRouteLoading(false))

    return () => ctrl.abort()
  }, [waypoints.start, waypoints.end, zones])

  const handleCitySelect = (c) => {
    setCity(c)
    setZones([])
    addLog('info', `Operating area: ${c.shortName}`)
  }

  const handleCityClear = () => {
    if (city?.id === DEFAULT_CITY.id) return
    addLog('info', `Reset to default area: ${DEFAULT_CITY.shortName}`)
    setCity(DEFAULT_CITY)
    setZones([])
  }

  const currentDisaster = DISASTER_TYPES.find((d) => d.value === disasterType) || DISASTER_TYPES[0]

  const handleTrigger = async () => {
    // Only activate root zones — Building_Fire children stay as draft and are
    // activated later by the engine's scheduled-spread callback if/when their
    // parent's spread timer expires (and the parent isn't put out first).
    const drafts = zones.filter((z) => z.status === 'draft' && !z.parentId)
    if (drafts.length === 0) {
      addLog('error', 'No draft zones to trigger.')
      return
    }
    setLoading(true)
    addLog('pending', `Activating ${drafts.length} zone${drafts.length === 1 ? '' : 's'}…`)

    // Wall-clock-ish anchor used by the citizen sim's wave physics. Engine
    // exposes sim seconds; fall back to 0 if the engine isn't ready yet.
    const triggerSimT = engine?.getCurrentTime?.() ?? 0

    for (const zone of drafts) {
      try {
        const res = await fetch(`${BACKEND_URL}/api/disasters/${zone.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        })
        if (!res.ok) {
          const result = await res.json().catch(() => ({}))
          throw new Error(result.detail || `HTTP ${res.status}`)
        }
        setZones((prev) =>
          prev.map((z) =>
            z.id === zone.id ? { ...z, status: 'active', triggeredAt: triggerSimT } : z,
          ),
        )
        // Building_Fire: materialise escapees as fleeing citizens on the streets.
        if (BUILDING_TYPES.includes(zone.type) && engine?.spawnFleeingCitizens) {
          const coords = zone.geometry?.coordinates
          if (Array.isArray(coords) && coords.length >= 2) {
            const fireLoc = { lat: coords[1], lng: coords[0] }
            const escapees = Math.round(
              (zone.peopleInside ?? 0) * ((zone.safeExitPct ?? 0) / 100),
            )
            if (escapees > 0) {
              const actual = engine.spawnFleeingCitizens(zone.id, fireLoc, escapees)
              if (actual > 0) {
                addLog('info', `${actual} escaped from ${zone.typeLabel}.`)
                setCitizenCount(engine.snapshot().liveCount)
              }
            }
          }
        }
        addLog('success', `${zone.typeLabel} activated.`)
      } catch (err) {
        addLog('error', `${zone.typeLabel}: ${err.message}`)
      }
    }
    refreshWeather()
    setLoading(false)
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-100">
      {/* ─── Sidebar ─────────────────────────────────────────── */}
      <aside className="w-[360px] shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col">
        <header className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Sentinel-City</h1>
            <p className="text-[11px] text-zinc-500 mt-0.5">Municipal emergency orchestration</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Online
          </span>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          {/* Operating area */}
          <section>
            <SectionLabel>Operating area</SectionLabel>
            <CityPicker
              value={city}
              onSelect={handleCitySelect}
              onClear={handleCityClear}
            />
            {!city && (
              <p className="text-[11px] text-zinc-600 mt-1.5 leading-snug">
                Optional — scope the map to a specific city, or leave empty for global view.
              </p>
            )}
          </section>

          {/* Disaster type */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Emergency classification</SectionLabel>
              <span className="text-[10px] text-zinc-600">for next zone</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {DISASTER_TYPES.map((d) => {
                const sel = disasterType === d.value
                return (
                  <button
                    key={d.value}
                    onClick={() => setDisasterType(d.value)}
                    className={[
                      'flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[12px] transition-colors font-medium',
                      sel
                        ? 'bg-zinc-800 border border-zinc-700 text-zinc-100'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                    ].join(' ')}
                  >
                    <span className="text-base leading-none shrink-0">{d.icon}</span>
                    <span className="truncate flex-1">{d.label}</span>
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: d.color, boxShadow: sel ? `0 0 6px ${d.color}` : 'none' }}
                    />
                  </button>
                )
              })}
            </div>
          </section>

          {/* Severity (type-aware) */}
          <SeveritySelector
            type={disasterType}
            value={severity}
            onChange={setSeverity}
          />

          {/* Building Fire — people inside / safe-exit % / nesting banner.
              Only shown when the operator has selected Building_Fire. */}
          {BUILDING_TYPES.includes(disasterType) && (
            <section className="space-y-3">
              {nestingParentId && (
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
                  <span>Next placement spreads fire from the selected building.</span>
                  <button
                    onClick={() => setNestingParentId(null)}
                    className="text-amber-300 hover:text-amber-100 text-[10px] uppercase tracking-wide"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <SectionLabel className="mb-0">People inside</SectionLabel>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={peopleInside}
                    onChange={(e) => setPeopleInside(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-20 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[12px] text-zinc-100 tabular-nums focus:outline-none focus:border-zinc-600"
                  />
                </div>
                <div className="flex items-center justify-between mb-2">
                  <SectionLabel className="mb-0">Safe exit</SectionLabel>
                  <span className="text-[11px] text-zinc-400 tabular-nums">{safeExitPct}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={safeExitPct}
                  onChange={(e) => setSafeExitPct(parseInt(e.target.value, 10))}
                  className="w-full accent-red-500"
                />
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                  <div>
                    Escaping <span className="text-emerald-400 tabular-nums">{Math.round(peopleInside * safeExitPct / 100)}</span>
                  </div>
                  <div className="text-right">
                    Trapped <span className="text-red-400 tabular-nums">{peopleInside - Math.round(peopleInside * safeExitPct / 100)}</span>
                  </div>
                </div>
              </div>
              {/* Delayed-spread timer. Children stay as draft until this many
                  seconds elapse after Trigger, unless firefighters put the
                  parent out first. Only meaningful when the operator nests a
                  neighbour under this fire. */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <SectionLabel className="mb-0">Spread in</SectionLabel>
                  <span className="text-[11px] text-zinc-400 tabular-nums">{spreadInSeconds}s</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="300"
                  step="5"
                  value={spreadInSeconds}
                  onChange={(e) => setSpreadInSeconds(parseInt(e.target.value, 10))}
                  className="w-full accent-amber-500"
                />
                <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                  <span>5s</span>
                  <span>30s</span>
                  <span>5m</span>
                </div>
              </div>
            </section>
          )}

          {/* Spread speed — multiplier on the per-type spreadRateMps formula
              from disasterProfiles.js. Only meaningful for types with an
              expanding wave (Flood, Wildfire). */}
          {SPREADING_TYPES.includes(disasterType) && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <SectionLabel className="mb-0">Spread speed</SectionLabel>
                <span className="text-[11px] text-zinc-400 tabular-nums">{spreadSpeed.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min="0.25"
                max="4"
                step="0.05"
                value={spreadSpeed}
                onChange={(e) => setSpreadSpeed(parseFloat(e.target.value))}
                className="w-full accent-red-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                <span>0.25× slow</span>
                <span>1× normal</span>
                <span>4× extreme</span>
              </div>
            </section>
          )}

          {/* Cause — only for ambiguous types where the same disaster could
              be weather-driven (river flood, freeze-burst main) or rooted in
              infrastructure (hydrant burst, equipment failure). Drives the
              mocked /api/weather endpoint. */}
          {CAUSE_AMBIGUOUS_TYPES.includes(disasterType) && (
            <section>
              <SectionLabel>Caused by</SectionLabel>
              <div className="inline-flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                {[
                  { value: 'infrastructure', label: 'Infrastructure' },
                  { value: 'weather',        label: 'Weather' },
                ].map((o) => {
                  const sel = cause === o.value
                  return (
                    <button
                      key={o.value}
                      onClick={() => setCause(o.value)}
                      className={[
                        'px-2.5 py-1 text-[11px] rounded transition-colors',
                        sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                      ].join(' ')}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[10px] text-zinc-600 mt-1.5 leading-snug">
                Weather causes can affect the weather report.
              </p>
            </section>
          )}

          {/* Geometry mode toggle — only shown for types with multiple allowed
              geometries (currently Power_Outage). */}
          {allowedGeometries.length > 1 && (
            <section>
              <SectionLabel>Scope</SectionLabel>
              <div className="inline-flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                {allowedGeometries.map((g) => {
                  const sel = activeGeometryMode === g
                  return (
                    <button
                      key={g}
                      onClick={() =>
                        setGeometryModeOverrides((prev) => ({ ...prev, [disasterType]: g }))
                      }
                      className={[
                        'px-2.5 py-1 text-[11px] rounded transition-colors',
                        sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                      ].join(' ')}
                    >
                      {g === 'city' ? 'Citywide' : g === 'area' ? 'Area' : 'Point'}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {/* Notes */}
          <section>
            <SectionLabel>
              Directives <span className="text-zinc-600 font-normal">(optional)</span>
            </SectionLabel>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Evacuation routes, hazmat details, road units…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-zinc-600 transition-colors"
            />
          </section>

          {/* Zones */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Zones</SectionLabel>
              <span className="text-[11px] text-zinc-500 tabular-nums">{zones.length}</span>
            </div>

            {/* Mode-specific entry hint / action */}
            {activeGeometryMode === 'city' ? (
              <button
                onClick={handleAddCitywideZone}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-dashed border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[12px] text-zinc-200 transition-colors mb-2"
              >
                <span>+</span>
                Add citywide {currentDisaster.label}
              </button>
            ) : activeGeometryMode === 'point' ? (
              <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug mb-2">
                Click once on the map to mark a {currentDisaster.label.toLowerCase()} location.
              </div>
            ) : (
              <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug mb-2">
                Use the drawing tools (top-left) to outline the {currentDisaster.label.toLowerCase()} area.
              </div>
            )}

            {zones.length === 0 ? (
              <div className="px-3 py-2.5 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug">
                No active zones yet.
              </div>
            ) : (
              <ZoneList
                zones={zones}
                onRemove={handleZoneRemove}
                onStartNesting={(id) => setNestingParentId(id)}
                nestingParentId={nestingParentId}
              />
            )}
          </section>

          {/* Emergency tools — dispatch firefighters, send notifications,
              place cordons. Each is conceptually an operator (or future AI
              agent) tool. */}
          <section className="space-y-2">
            <SectionLabel>Dispatch firefighters</SectionLabel>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDispatchTrucks((v) => Math.max(DISPATCH_MIN_TRUCKS, v - 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >−</button>
              <input
                type="number"
                min={DISPATCH_MIN_TRUCKS}
                max={DISPATCH_MAX_TRUCKS}
                value={dispatchTrucks}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10) || DISPATCH_MIN_TRUCKS
                  setDispatchTrucks(Math.max(DISPATCH_MIN_TRUCKS, Math.min(DISPATCH_MAX_TRUCKS, v)))
                }}
                className="w-14 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[12px] text-zinc-100 tabular-nums text-center focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => setDispatchTrucks((v) => Math.min(DISPATCH_MAX_TRUCKS, v + 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >+</button>
              <span className="text-[10px] text-zinc-500">
                {dispatchTrucks * FIRE_TRUCK_CAPACITY} firefighters
              </span>
            </div>
            <button
              onClick={() => setDispatchTargetMode((v) => !v)}
              className={[
                'w-full py-1.5 rounded text-[11px] transition-colors',
                dispatchTargetMode
                  ? 'bg-amber-500/30 text-amber-100 border border-amber-500/60'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100',
              ].join(' ')}
            >
              {dispatchTargetMode
                ? 'Click on map to set search-area centre…'
                : dispatchTarget
                  ? `Search area: ${dispatchTarget.lat.toFixed(3)}, ${dispatchTarget.lng.toFixed(3)} · ${Math.round(dispatchTarget.radius ?? dispatchRadius)} m (change)`
                  : 'Pick search area on map'}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400 whitespace-nowrap">Search radius</span>
              <input
                type="range"
                min={200}
                max={1000}
                step={50}
                value={dispatchRadius}
                onChange={(e) => {
                  const r = +e.target.value
                  setDispatchRadius(r)
                  // Live-update the placed target so the on-map circle resizes
                  // with the slider, and the engine receives the latest value.
                  setDispatchTarget((t) => (t ? { ...t, radius: r } : t))
                }}
                className="flex-1"
              />
              <span className="text-[11px] text-zinc-400 tabular-nums w-12 text-right">{dispatchRadius}m</span>
            </div>
            <button
              onClick={handleDispatch}
              disabled={!dispatchTarget || fireStations.length === 0}
              className="w-full py-2 rounded text-[12px] font-medium text-white bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
            >
              Dispatch {dispatchTrucks} truck{dispatchTrucks === 1 ? '' : 's'}
            </button>
            {fireStations.length === 0 && (
              <p className="text-[10px] text-zinc-600">No stations — open ⚙ Settings to place one.</p>
            )}
            {activeDispatches.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Active dispatches</div>
                {activeDispatches.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-[10px]">
                    <span>🚒 {d.trucks}</span>
                    <span className="text-zinc-500 flex-1 truncate">from {d.stationName}</span>
                    <button
                      onClick={() => handleRecall(d.id)}
                      className="text-zinc-500 hover:text-amber-300 text-[10px]"
                    >Recall</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Ambulance dispatch */}
          <section className="space-y-2">
            <SectionLabel>Dispatch ambulances</SectionLabel>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setAmbDispatchUnits((v) => Math.max(1, v - 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >−</button>
              <input
                type="number"
                min={1}
                max={20}
                value={ambDispatchUnits}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10) || 1
                  setAmbDispatchUnits(Math.max(1, Math.min(20, v)))
                }}
                className="w-14 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[12px] text-zinc-100 tabular-nums text-center focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => setAmbDispatchUnits((v) => Math.min(20, v + 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >+</button>
              <span className="text-[10px] text-zinc-500">ambulances</span>
            </div>
            <button
              onClick={() => setAmbDispatchTargetMode((v) => !v)}
              className={[
                'w-full py-1.5 rounded text-[11px] transition-colors',
                ambDispatchTargetMode
                  ? 'bg-rose-500/30 text-rose-100 border border-rose-500/60'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100',
              ].join(' ')}
            >
              {ambDispatchTargetMode
                ? 'Click on map to set patient pickup centre…'
                : ambDispatchTarget
                  ? `Pickup: ${ambDispatchTarget.lat.toFixed(3)}, ${ambDispatchTarget.lng.toFixed(3)} · ${Math.round(ambDispatchTarget.radius ?? ambDispatchRadius)} m (change)`
                  : '🏥 Pick pickup area on map'}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400 whitespace-nowrap">Search radius</span>
              <input
                type="range"
                min={50}
                max={300}
                step={25}
                value={ambDispatchRadius}
                onChange={(e) => {
                  const r = +e.target.value
                  setAmbDispatchRadius(r)
                  setAmbDispatchTarget((t) => (t ? { ...t, radius: r } : t))
                }}
                className="flex-1"
              />
              <span className="text-[11px] text-zinc-400 tabular-nums w-12 text-right">{ambDispatchRadius}m</span>
            </div>
            <button
              onClick={handleAmbulanceDispatch}
              disabled={!ambDispatchTarget || hospitals.length === 0}
              className="w-full py-2 rounded text-[12px] font-medium text-white bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
            >
              Dispatch {ambDispatchUnits} ambulance{ambDispatchUnits === 1 ? '' : 's'}
            </button>
            {hospitals.length === 0 && (
              <p className="text-[10px] text-zinc-600">No hospitals — open ⚙ Settings to place one.</p>
            )}
            {activeAmbulanceDispatches.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Active dispatches</div>
                {activeAmbulanceDispatches.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-[10px]">
                    <span>🚑 {d.units}</span>
                    <span className="text-zinc-500 flex-1 truncate">from {d.stationName}</span>
                    <button
                      onClick={() => handleAmbulanceRecall(d.id)}
                      className="text-zinc-500 hover:text-rose-300 text-[10px]"
                    >Recall</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Manual police patrol */}
          <section className="space-y-2">
            <SectionLabel>Manual police patrol</SectionLabel>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPoliceDispatchUnits((v) => Math.max(1, v - 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >−</button>
              <input
                type="number"
                min={1}
                max={50}
                value={policeDispatchUnits}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10) || 1
                  setPoliceDispatchUnits(Math.max(1, Math.min(50, v)))
                }}
                className="w-14 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[12px] text-zinc-100 tabular-nums text-center focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => setPoliceDispatchUnits((v) => Math.min(50, v + 1))}
                className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100"
              >+</button>
              <span className="text-[10px] text-zinc-500">officers</span>
            </div>
            <button
              onClick={() => setPoliceDispatchTargetMode((v) => !v)}
              className={[
                'w-full py-1.5 rounded text-[11px] transition-colors',
                policeDispatchTargetMode
                  ? 'bg-blue-500/30 text-blue-100 border border-blue-500/60'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100',
              ].join(' ')}
            >
              {policeDispatchTargetMode
                ? 'Click on map to set patrol centre…'
                : policeDispatchTarget
                  ? `Patrol: ${policeDispatchTarget.lat.toFixed(3)}, ${policeDispatchTarget.lng.toFixed(3)} · ${Math.round(policeDispatchTarget.radius ?? policeDispatchRadius)} m (change)`
                  : '🚓 Pick patrol area on map'}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400 whitespace-nowrap">Patrol radius</span>
              <input
                type="range"
                min={150}
                max={1500}
                step={50}
                value={policeDispatchRadius}
                onChange={(e) => {
                  const r = +e.target.value
                  setPoliceDispatchRadius(r)
                  setPoliceDispatchTarget((t) => (t ? { ...t, radius: r } : t))
                }}
                className="flex-1"
              />
              <span className="text-[11px] text-zinc-400 tabular-nums w-12 text-right">{policeDispatchRadius}m</span>
            </div>
            <button
              onClick={handlePoliceDispatchManual}
              disabled={!policeDispatchTarget || policeStations.length === 0}
              className="w-full py-2 rounded text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
            >
              Dispatch {policeDispatchUnits} officer{policeDispatchUnits === 1 ? '' : 's'}
            </button>
            {policeStations.length === 0 && (
              <p className="text-[10px] text-zinc-600">No police stations — open ⚙ Settings to place one.</p>
            )}
            {activePoliceDispatches.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Active patrols</div>
                {activePoliceDispatches.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-[10px]">
                    <span>🚓 {d.units}</span>
                    <span className="text-zinc-500 flex-1 truncate">from {d.stationName}</span>
                    <button
                      onClick={() => handlePoliceRecall(d.id)}
                      className="text-zinc-500 hover:text-blue-300 text-[10px]"
                    >Recall</button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-zinc-600">
              ~50% of each station's roster auto-patrols nearby looking for crime. Right-click any citizen to trigger a robbery.
            </p>
          </section>

          <section className="space-y-2">
            <SectionLabel>Notify / Cordon</SectionLabel>
            <input
              type="text"
              value={notifReason}
              onChange={(e) => setNotifReason(e.target.value)}
              placeholder="Reason (e.g. Toxic plume)"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setPolygonDrawKind(polygonDrawKind === 'notification' ? null : 'notification')}
                className={[
                  'py-1.5 rounded text-[11px] transition-colors',
                  polygonDrawKind === 'notification'
                    ? 'bg-yellow-500/30 text-yellow-100 border border-yellow-500/60'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100',
                ].join(' ')}
              >
                {polygonDrawKind === 'notification' ? 'Draw…' : '📢 Notify area'}
              </button>
              <button
                onClick={() => setPolygonDrawKind(polygonDrawKind === 'cordon' ? null : 'cordon')}
                className={[
                  'py-1.5 rounded text-[11px] transition-colors',
                  polygonDrawKind === 'cordon'
                    ? 'bg-orange-500/30 text-orange-100 border border-orange-500/60'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100',
                ].join(' ')}
              >
                {polygonDrawKind === 'cordon' ? 'Draw…' : '🚧 Cordon'}
              </button>
            </div>
            {(notifications.length > 0 || cordons.length > 0) && (
              <div className="space-y-1 pt-1">
                {notifications.map((n) => (
                  <div key={n.id} className="flex items-center gap-2 px-2 py-1 rounded border border-yellow-500/30 bg-yellow-500/5 text-[10px]">
                    <span>📢</span>
                    <span className="text-zinc-200 flex-1 truncate">{n.reason}</span>
                    <button onClick={() => handleClearNotification(n.id)} className="text-zinc-500 hover:text-red-400">×</button>
                  </div>
                ))}
                {cordons.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 px-2 py-1 rounded border border-orange-500/30 bg-orange-500/5 text-[10px]">
                    <span>🚧</span>
                    <span className="text-zinc-200 flex-1 truncate">{c.reason || 'No entry'}</span>
                    <button onClick={() => handleClearCordon(c.id)} className="text-zinc-500 hover:text-red-400">×</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Trigger — flips all draft zones to active */}
          {(() => {
            const draftCount = zones.filter((z) => z.status === 'draft').length
            return (
              <button
                id="btn-trigger-disaster"
                onClick={handleTrigger}
                disabled={loading || draftCount === 0}
                className="w-full py-2.5 rounded-md font-medium text-[13px] text-white bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Activating…
                  </span>
                ) : draftCount === 0 ? (
                  zones.length === 0 ? 'Draw at least one zone' : 'All zones active'
                ) : (
                  `Trigger ${draftCount} zone${draftCount === 1 ? '' : 's'}`
                )}
              </button>
            )
          })()}

          {/* Clear all — wipes every zone (drafts + actives), local + DB.
              Useful for resetting the simulator between scenarios. */}
          <button
            onClick={handleClearAllZones}
            disabled={loading || zones.length === 0}
            className="w-full mt-2 py-1.5 rounded-md text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 disabled:text-zinc-700 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            Clear all zones
          </button>

          {/* Routing */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Routing</SectionLabel>
              <span className="text-[10px] text-zinc-600">avoids active zones</span>
            </div>
            <RoutePanel
              waypoints={waypoints}
              waypointMode={waypointMode}
              onPickMode={setWaypointMode}
              onClearWaypoint={handleClearWaypoint}
              onClearAll={handleClearAllWaypoints}
              route={route}
              loading={routeLoading}
              error={routeError}
            />
          </section>
        </div>

        {/* Activity log */}
        <div className="border-t border-zinc-800">
          <button
            onClick={() => setLogOpen((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-3 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span className="font-medium">Activity</span>
            <span className="text-zinc-600 text-[10px]">{logOpen ? '▾' : '▸'}</span>
          </button>
          {logOpen && (
            <div className="max-h-[180px] overflow-y-auto px-5 pb-4 space-y-1.5">
              {log.map((e, i) => (
                <LogRow key={i} entry={e} />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ─── Map ─────────────────────────────────────────────── */}
      <main className="flex-1 relative">
        <MapView
          zones={zones}
          onZoneAdd={handleZoneAdd}
          onZoneUpdate={handleZoneUpdate}
          onZoneRemove={handleZoneRemove}
          drawingMode={activeGeometryMode}
          mapStyle={mapStyle}
          showCameras={showCameras}
          showIntersections={showIntersections}
          city={city}
          route={route}
          waypoints={waypoints}
          waypointMode={waypointMode}
          onWaypointPick={handleWaypointPick}
          citizenEngine={engine}
          focusPoint={focusPoint}
          onCitizenClick={handleCitizenClick}
          onCitizenContextMenu={handleCitizenContextMenu}
          fireStations={fireStations}
          stationPlacementMode={stationPlacementMode}
          onStationPlace={handleStationPlace}
          hospitals={hospitals}
          hospitalPlacementMode={hospitalPlacementMode}
          onHospitalPlace={handleHospitalPlace}
          policeStations={policeStations}
          policePlacementMode={policePlacementMode}
          onPolicePlace={handlePolicePlace}
          notifications={notifications}
          cordons={cordons}
          dispatchTargetMode={dispatchTargetMode}
          dispatchTarget={dispatchTarget}
          activeDispatches={activeDispatches}
          onDispatchTargetPick={(p) => { setDispatchTarget({ lat: p.lat, lng: p.lng, radius: dispatchRadius }); setDispatchTargetMode(false) }}
          ambDispatchTargetMode={ambDispatchTargetMode}
          ambDispatchTarget={ambDispatchTarget}
          activeAmbulanceDispatches={activeAmbulanceDispatches}
          onAmbDispatchTargetPick={(p) => { setAmbDispatchTarget({ lat: p.lat, lng: p.lng, radius: ambDispatchRadius }); setAmbDispatchTargetMode(false) }}
          policeDispatchTargetMode={policeDispatchTargetMode}
          policeDispatchTarget={policeDispatchTarget}
          activePoliceDispatches={activePoliceDispatches}
          onPoliceDispatchTargetPick={(p) => { setPoliceDispatchTarget({ lat: p.lat, lng: p.lng, radius: policeDispatchRadius }); setPoliceDispatchTargetMode(false) }}
          polygonDrawKind={polygonDrawKind}
          onPolygonDraw={handlePolygonDraw}
        />

        <SettingsPanel
          open={settingsOpen}
          onClose={() => {
            setSettingsOpen(false)
            setStationPlacementMode(false)
            setHospitalPlacementMode(false)
            setPolicePlacementMode(false)
          }}
          stations={fireStations}
          placementMode={stationPlacementMode}
          onStationPlacementToggle={(on, name, capacity) => {
            setStationPlacementMode(on)
            setPendingStationName(name)
            if (typeof capacity === 'number') setPendingStationCapacity(capacity)
          }}
          onStationRemove={handleStationRemove}
          onStationCapacityChange={handleStationCapacityChange}
          hospitals={hospitals}
          hospitalPlacementMode={hospitalPlacementMode}
          onHospitalPlacementToggle={(on, name, capacity) => {
            setHospitalPlacementMode(on)
            setPendingHospitalName(name)
            if (typeof capacity === 'number') setPendingHospitalCapacity(capacity)
          }}
          onHospitalRemove={handleHospitalRemove}
          onHospitalCapacityChange={handleHospitalCapacityChange}
          policeStations={policeStations}
          policePlacementMode={policePlacementMode}
          onPolicePlacementToggle={(on, name, capacity) => {
            setPolicePlacementMode(on)
            setPendingPoliceName(name)
            if (typeof capacity === 'number') setPendingPoliceCapacity(capacity)
          }}
          onPoliceRemove={handlePoliceRemove}
          onPoliceCapacityChange={handlePoliceCapacityChange}
        />

        <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2">
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="inline-flex items-center justify-center w-8 h-8 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
            title="Settings"
          >
            ⚙
          </button>
          <WeatherIndicator weather={weather} />
          {(() => {
            const totals = zones.reduce(
              (acc, z) => {
                if (z.type !== 'Building_Fire' || z.status !== 'active') return acc
                if (typeof z.peopleInside !== 'number' || typeof z.safeExitPct !== 'number') return acc
                const escaped = Math.round(z.peopleInside * (z.safeExitPct / 100))
                acc.escaped += escaped
                acc.trapped += z.peopleInside - escaped
                return acc
              },
              { escaped: 0, trapped: 0 },
            )
            if (totals.escaped === 0 && totals.trapped === 0) return null
            return (
              <div
                className="inline-flex items-center gap-2 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] text-zinc-200"
                title="Cumulative people accounted for across active building fires"
              >
                <span className="text-base leading-none" aria-hidden>🏢</span>
                <span className="text-emerald-400 tabular-nums">{totals.escaped} out</span>
                <span className="text-zinc-600">·</span>
                <span className="text-red-400 tabular-nums">{totals.trapped} trapped</span>
              </div>
            )
          })()}
          <Segmented value={mapStyle} onChange={setMapStyle} options={MAP_STYLES} />

          <button
            onClick={() => setShowCameras((c) => !c)}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              showCameras
                ? 'text-zinc-100 hover:border-zinc-700'
                : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showCameras ? 'bg-amber-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Cameras {showCameras ? 'on' : 'off'}
          </button>

          <button
            onClick={() => setShowIntersections((v) => !v)}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              showIntersections
                ? 'text-zinc-100 hover:border-zinc-700'
                : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showIntersections ? 'bg-sky-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Intersections {showIntersections ? 'on' : 'off'}
          </button>
        </div>

        {/* Citizen inspector — appears when a dot is clicked on the map */}
        {inspectedCitizen && (
          <div className="absolute top-4 left-16 z-40 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-md text-[11px] text-zinc-200 w-[280px] font-mono">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <span className="font-semibold text-zinc-100">Citizen #{inspectedCitizen.idx}</span>
              <button
                onClick={() => setInspectedCitizen(null)}
                className="text-zinc-500 hover:text-zinc-200 text-[14px] leading-none"
              >
                ×
              </button>
            </div>
            <div className="px-3 py-2 space-y-0.5 leading-relaxed">
              <div><span className="text-zinc-500">state</span> <span className="text-zinc-100">{inspectedCitizen.state}</span> <span className="text-zinc-500">({inspectedCitizen.speed} m/s)</span></div>
              <div><span className="text-zinc-500">pos</span> {inspectedCitizen.lat.toFixed(5)}, {inspectedCitizen.lng.toFixed(5)}</div>
              <div><span className="text-zinc-500">node</span> {String(inspectedCitizen.currentNode).slice(0, 18)}</div>
              <div><span className="text-zinc-500">→ target</span> {String(inspectedCitizen.targetNode).slice(0, 18)}</div>
              <div><span className="text-zinc-500">path</span> {inspectedCitizen.pathLength} nodes, {Math.round(inspectedCitizen.pathRemainingM)} m left</div>
              <div><span className="text-zinc-500">nbrs</span> {inspectedCitizen.neighborCount}</div>
              <div className="pt-1 border-t border-zinc-800 mt-1" />
              <div><span className="text-zinc-500">total moved</span> {Math.round(inspectedCitizen.totalMovedM)} m</div>
              <div>
                <span className="text-zinc-500">last moved</span>{' '}
                <span className={inspectedCitizen.ticksStillSinceMove > 2 ? 'text-amber-400' : 'text-zinc-100'}>
                  {inspectedCitizen.lastMovedSimT > 0
                    ? `t=${inspectedCitizen.lastMovedSimT.toFixed(1)} (Δ${inspectedCitizen.ticksStillSinceMove.toFixed(1)}s ago)`
                    : 'never'}
                </span>
              </div>
              <div><span className="text-zinc-500">retargets</span> {inspectedCitizen.retargetCount} <span className="text-zinc-500">· last at</span> t={inspectedCitizen.lastRetargetSimT.toFixed(1)}</div>
              <div className="pt-1 border-t border-zinc-800 mt-1" />
              <div><span className="text-zinc-500">cause zone</span> {inspectedCitizen.causeZoneId ? String(inspectedCitizen.causeZoneId).slice(0, 12) + '…' : '—'}</div>
              <div><span className="text-zinc-500">state expires</span> {inspectedCitizen.stateExpiresAt === Infinity ? '∞' : inspectedCitizen.stateExpiresAt.toFixed(1)}</div>
              <div><span className="text-zinc-500">recovery at</span> {inspectedCitizen.recoveryAt > 0 ? inspectedCitizen.recoveryAt.toFixed(1) : '—'}</div>
              <div><span className="text-zinc-500">sim time</span> {inspectedCitizen.simTimeS.toFixed(1)}</div>
              <div><span className="text-zinc-500">reports logged</span> {inspectedCitizen.reportLogSize}</div>
            </div>
            <div className="px-3 pb-2 pt-1 text-[10px] text-zinc-600 border-t border-zinc-800">
              snapshot at click — not live. click again to refresh.
            </div>
          </div>
        )}

        {/* Sim status + speed slider (bottom-left of map area) */}
        <div className="absolute bottom-4 left-4 z-30 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-2 text-[11px] text-zinc-400 min-w-[260px]">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={[
                'w-1.5 h-1.5 rounded-full shrink-0',
                simReady ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse',
              ].join(' ')}
            />
            <span className="truncate">
              {simStatus}
              {simReady && (
                <>
                  {' · '}
                  <span className="tabular-nums text-zinc-200">{citizenCount}</span> citizens active
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 shrink-0 w-10">Speed</span>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={simSpeed}
              onChange={(e) => setSimSpeed(Number(e.target.value))}
              disabled={!simReady}
              className="flex-1"
              style={{
                '--range-pct': `${(simSpeed / 8) * 100}%`,
                '--range-color': simSpeed === 0 ? '#71717a' : '#fafafa',
              }}
            />
            <span className="text-[10px] text-zinc-300 tabular-nums w-12 text-right shrink-0">
              {simSpeed === 0 ? 'Paused' : `${simSpeed}×`}
            </span>
          </div>
        </div>

        {/* Floating 911 calls button */}
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          className={[
            'absolute bottom-4 right-4 z-40 inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-medium transition-colors',
            'bg-zinc-900/95 backdrop-blur border border-zinc-800 text-zinc-100 hover:border-zinc-600 shadow-lg shadow-black/50',
            drawerOpen ? 'ring-2 ring-amber-500/60' : '',
          ].join(' ')}
          title={drawerOpen ? 'Close 911 calls' : 'Open 911 calls'}
        >
          <span className="text-base leading-none">📞</span>
          <span className="tabular-nums">{citizenReports.length}</span>
          <span className="text-zinc-500">calls</span>
        </button>

        <CallsDrawer
          open={drawerOpen}
          reports={citizenReports}
          filter={callFilter}
          onFilterChange={setCallFilter}
          onClose={() => setDrawerOpen(false)}
          onClear={() => setCitizenReports([])}
          onReportClick={handleReportClick}
          typeIconLookup={typeIconLookup}
        />

        {/* Right-click crime menu (operator triggers a robbery on a citizen). */}
        {crimeMenu && (
          <div
            className="fixed z-[1000] bg-zinc-900/97 backdrop-blur border border-zinc-700 rounded-md shadow-xl py-1 text-[11px] text-zinc-100"
            style={{ left: crimeMenu.x + 4, top: crimeMenu.y + 4 }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="px-3 py-1 text-zinc-500 text-[10px] uppercase tracking-wide">
              Citizen #{crimeMenu.citizenIdx}
            </div>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-amber-500/20 hover:text-amber-200"
              onClick={() => handleTriggerRobbery(1)}
            >
              💰 Trigger Robbery (L1 – pickpocket)
            </button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-red-500/20 hover:text-red-200"
              onClick={() => handleTriggerRobbery(2)}
            >
              🔫 Trigger Robbery (L2 – armed)
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-zinc-500 hover:text-zinc-300"
              onClick={() => setCrimeMenu(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function SectionLabel({ children, className = '' }) {
  return (
    <h2 className={`text-[12px] font-medium text-zinc-300 mb-2.5 ${className}`}>
      {children}
    </h2>
  )
}

// Sidebar zones list. Renders top-level zones as cards; Building_Fire children
// (spread targets) are nested visually beneath their parent. Each Building_Fire
// card exposes a "+ Spread to neighbour" button that the caller wires up to a
// nesting-mode state in the parent component.
function ZoneList({ zones, onRemove, onStartNesting, nestingParentId }) {
  const topLevel = zones.filter((z) => !z.parentId)
  return (
    <div className="space-y-1.5">
      {topLevel.map((z) => {
        const children = zones.filter((c) => c.parentId === z.id)
        return (
          <div key={z.id} className="space-y-1.5">
            <ZoneCard
              zone={z}
              onRemove={onRemove}
              onStartNesting={onStartNesting}
              isNestingTarget={z.id === nestingParentId}
            />
            {children.length > 0 && (
              <div className="ml-3 pl-2 border-l border-zinc-800 space-y-1.5">
                {children.map((c) => (
                  <ZoneCard
                    key={c.id}
                    zone={c}
                    onRemove={onRemove}
                    onStartNesting={onStartNesting}
                    isNestingTarget={c.id === nestingParentId}
                    isChild
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ZoneCard({ zone: z, onRemove, onStartNesting, isNestingTarget, isChild }) {
  const kindLabel =
    z.geometryKind === 'city'
      ? 'Citywide'
      : z.geometryKind === 'point'
        ? 'Point'
        : z.geometry?.type === 'Point'
          ? 'Circle'
          : 'Polygon'
  const isBuilding = z.type === 'Building_Fire'
  const escaping =
    isBuilding && typeof z.peopleInside === 'number' && typeof z.safeExitPct === 'number'
      ? Math.round(z.peopleInside * (z.safeExitPct / 100))
      : null
  const trapped = isBuilding && escaping != null ? z.peopleInside - escaping : null
  return (
    <div
      className={[
        'pl-2 pr-1.5 py-2 rounded-md border bg-zinc-900',
        isNestingTarget ? 'border-amber-500/60' : 'border-zinc-800',
      ].join(' ')}
    >
      <div className="flex items-center gap-2.5">
        <span className="w-1 h-8 rounded-full shrink-0" style={{ background: z.color }} />
        <span className="text-base leading-none shrink-0">{z.typeIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-zinc-200 truncate font-medium">
            {z.typeLabel}
            {isChild && <span className="text-zinc-600 ml-1.5">(spread)</span>}
          </div>
          <div className="text-[10px] text-zinc-500 tabular-nums flex items-center gap-1.5">
            <span>Sev {z.severity} · {kindLabel}</span>
            <span
              className={[
                'px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide',
                z.status === 'active'
                  ? 'bg-red-500/20 text-red-300'
                  : 'bg-zinc-700/60 text-zinc-300',
              ].join(' ')}
            >
              {z.status === 'active' ? 'Active' : 'Draft'}
            </span>
          </div>
        </div>
        <button
          onClick={() => onRemove(z.id)}
          className="text-zinc-600 hover:text-red-400 text-[16px] leading-none w-6 h-6 flex items-center justify-center rounded transition-colors"
          title="Remove zone"
        >
          ×
        </button>
      </div>
      {isBuilding && escaping != null && (
        <div className="mt-1.5 pl-3 text-[10px] flex items-center gap-3 tabular-nums">
          <span className="text-zinc-500">{z.peopleInside} inside</span>
          <span className="text-emerald-400">{escaping} out</span>
          <span className="text-red-400">{trapped} trapped</span>
        </div>
      )}
      {isBuilding && (
        <div className="mt-1.5 pl-3">
          <button
            onClick={() => onStartNesting(z.id)}
            disabled={isNestingTarget}
            className="text-[10px] text-amber-400 hover:text-amber-300 disabled:text-zinc-600 disabled:cursor-not-allowed"
          >
            {isNestingTarget ? '✓ Awaiting placement on map' : '+ Spread to neighbour'}
          </button>
        </div>
      )}
    </div>
  )
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex items-center bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md p-0.5">
      {options.map((o) => {
        const sel = value === o.value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={[
              'px-2.5 py-1 text-[12px] rounded transition-colors',
              sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function LogRow({ entry }) {
  const dot =
    {
      success: 'bg-emerald-500',
      error: 'bg-red-500',
      info: 'bg-zinc-500',
      pending: 'bg-amber-500',
    }[entry.type] || 'bg-zinc-500'

  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed">
      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dot}`} />
      <span className="font-mono text-zinc-600 shrink-0">{entry.time}</span>
      <span className="text-zinc-300 break-words">{entry.message}</span>
    </div>
  )
}

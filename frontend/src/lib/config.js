// Central tunables for the emergency-services layer. Edit these to rebalance
// dispatch outcomes without hunting through engine code.

// Each fire-truck dot represents this many firefighters. Operator dispatches
// a TRUCK COUNT in the UI; total firefighters = trucks × capacity.
export const FIRE_TRUCK_CAPACITY = 5

// Per-severity requirement for overcoming a Wildfire. Below → fire keeps
// growing (slowly); equal → wave stalls then drifts down; above → wave shrinks.
export const WILDFIRE_FIREFIGHTERS_NEEDED = (sev) => sev * 10

// Per-severity firefighters needed to extinguish a Building Fire before its
// spread timer expires.
export const BUILDING_FIRE_FIREFIGHTERS_NEEDED = (sev) => sev * 4

// Average road speed for a fire truck (m/s). ~18 m/s ≈ 40 mph.
export const FIRE_TRUCK_SPEED_MPS = 18

// A truck within this radius of a fire's centroid contributes its full
// passenger count to the fire's fight rate that tick.
export const TRUCK_EXTINGUISH_REACH_M = 60

// Radius around the dispatched target point in which trucks patrol while
// they search for the fire by sight.
export const TRUCK_PATROL_RADIUS_M = 150

// Wildfire wave radius shrinks by this many metres-per-second per firefighter
// within extinguish reach.
export const EXTINGUISH_RATE_PER_FF_M_PER_S = 0.3

// Building Fire intensity decay per firefighter per second.
export const BUILDING_EXTINGUISH_RATE = 0.5

// Notification lifetime (sim seconds) before auto-clear.
export const NOTIFICATION_TTL_S = 180

// Soft cap on stations the operator can place (UI guard, not DB).
export const MAX_FIRE_STATIONS = 8

// Truck dispatch cap per single call (1–20).
export const DISPATCH_MIN_TRUCKS = 1
export const DISPATCH_MAX_TRUCKS = 20

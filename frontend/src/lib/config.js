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
// within extinguish reach. Tuned so two trucks (10 firefighters) can hold a
// severity-1 fire (4 m/s growth) at 1 m/s net shrinkage, and 8-10 trucks make
// visible progress on a severity-4 (13 m/s growth, was previously unfightable
// without ~9 trucks just to break even).
export const EXTINGUISH_RATE_PER_FF_M_PER_S = 0.6

// Building Fire intensity decay per firefighter per second.
export const BUILDING_EXTINGUISH_RATE = 0.5

// Notification lifetime (sim seconds) before auto-clear.
export const NOTIFICATION_TTL_S = 180

// Probability that a citizen who observes a disaster AND reacts by fleeing
// will actually dial 911 before running. People mid-panic often just run.
// Citizens still transition to 'fleeing' regardless — only the call is gated.
// Observation reports from non-fleeing reactions (hide / approach / shelter /
// neutral) and 'affected' self-reports always emit.
export const FLEEING_CALL_PROBABILITY = 0.4

// Background "noise" to stress-test the orchestrator. Every PRANK_CALL_INTERVAL_S
// sim-seconds a random walking citizen dials in a fake emergency. The
// transcripts deliberately *sound* like real 911 calls (fire, robbery, accident,
// flood, etc.) — the AI orchestrator's job is NOT to spot absurd content, it's
// to filter low-credibility, uncorroborated single-source signals against the
// disaster registry. Prank calls use a synthetic event_id ('prank:<idx>:<t>')
// so they appear in the call drawer like any other report but never persist
// to disaster_events and never cause state transitions.
export const PRANK_CALL_INTERVAL_S = 30
export const PRANK_TRANSCRIPTS = [
  // Building fire — sounds urgent, no corroboration from neighbors
  'There is heavy smoke coming from the third floor of my apartment building, I can smell something burning!',
  'The warehouse next to me has flames shooting out of the roof, please send fire trucks immediately!',
  'My kitchen caught fire, I got out but the whole apartment is going up, send help fast!',
  // Wildfire / brush fire
  'I see flames in the trees behind the park, looks like the brush is burning out of control.',
  'There is a fire spreading on the hillside near my street, the wind is pushing it toward houses!',
  // Flood / water main
  'A water main just burst on my block, the street is filling up fast, cars are floating!',
  'Water is rushing into the subway entrance, I think the storm drain failed!',
  'My basement is flooding fast, looks like a pipe burst in the whole building.',
  // Accident / vehicle
  'There has been a serious car accident at the intersection, one vehicle is overturned and people are trapped!',
  'A motorcyclist just got hit by a truck on the avenue, he is on the ground not moving!',
  'A bus and a taxi collided, I can see injured passengers, please send ambulances!',
  // Robbery / armed
  'Three men with masks just ran out of the convenience store carrying bags, I think it was a robbery.',
  'Someone is breaking into the jewelry store on the corner, I can hear glass shattering!',
  'There is a man with a weapon outside my building demanding people hand over wallets!',
  // Gunshots / gang
  'I just heard multiple gunshots in the alley behind my building, please send police!',
  'There is a fight breaking out between two groups on the street, I think someone has a knife!',
  // Power / infrastructure
  'A power line just came down across my street, it is sparking on a parked car!',
  'A construction crane is leaning over a building, looks like it might collapse!',
  'I think the gas line ruptured, the smell is overwhelming and people are coughing.',
  // Medical / heat
  'An elderly man just collapsed on the sidewalk in front of me, he is unresponsive!',
  'A jogger is down in the park, I think he had a heat stroke, he is not waking up.',
  // Building / structural
  'A piece of the building facade just fell onto the sidewalk, people are screaming!',
  'I can hear loud cracking sounds from the parking garage, I think it might be collapsing!',
  // Road block / chemical
  'There is a tanker truck leaking some kind of liquid all over the highway, it smells chemical!',
  'A tree just fell across the road blocking both lanes, traffic is backed up for blocks!',
]

// Soft cap on stations the operator can place (UI guard, not DB).
export const MAX_FIRE_STATIONS = 8
export const MAX_HOSPITALS = 6
export const MAX_POLICE_STATIONS = 6

// Truck dispatch cap per single call (1–20).
export const DISPATCH_MIN_TRUCKS = 1
export const DISPATCH_MAX_TRUCKS = 20

// ──────────────────────────────────────────────────────────────────────
// Citizen HP system. Each citizen has invisible health 0–100. While in
// the active spreading event they bleed fast; outside the event but still
// injured they bleed slowly. An ambulance ride is effectively a safety net.
// Citizens at HP ≥ 70 are "stable" — self-heal slowly, ambulances ignore.
// ──────────────────────────────────────────────────────────────────────
export const HP_MAX = 100
export const HP_HEAL_THRESHOLD = 70
export const HP_DECAY_INSIDE_EVENT_PS = 1.6   // ~60 s to death without rescue
export const HP_DECAY_OUTSIDE_EVENT_PS = 0.33 // ~5 min outside the event
export const HP_DECAY_IN_AMBULANCE_PS = 0.05  // ~33 min (safety net)
export const HP_PASSIVE_HEAL_PS = 0.05        // self-recovery above threshold
export const HP_FAINT_THRESHOLD = 40
export const DEAD_DESPAWN_AFTER_S = 60

// ──────────────────────────────────────────────────────────────────────
// Ambulance tunables. Smaller search area than fire trucks (location more
// precise per spec). Patients are loaded for AMBULANCE_LOAD_SECONDS then
// transported home where they're miraculously restored to full HP.
// ──────────────────────────────────────────────────────────────────────
export const AMBULANCE_PATIENT_CAPACITY = 2
export const AMBULANCE_SEARCH_RADIUS_M = 50   // 1/3 of TRUCK_PATROL_RADIUS_M
export const AMBULANCE_PERCEPTION_M = 100
export const AMBULANCE_PICKUP_REACH_M = 25
export const AMBULANCE_LOAD_SECONDS = 3

// ──────────────────────────────────────────────────────────────────────
// Police tunables. ~50% of each station's roster auto-patrols. Officers
// catch crimes that occur within POLICE_INTERVENTION_RADIUS_M.
// ──────────────────────────────────────────────────────────────────────
export const POLICE_PATROL_DEFAULT_RADIUS_M = 400
export const POLICE_INTERVENTION_RADIUS_M = 100

// ──────────────────────────────────────────────────────────────────────
// Robbery mechanics. Operator right-clicks a citizen → chooses L1/L2.
// Police presence catches the criminal outright. Otherwise % chance of
// injuring a nearby citizen who needs a manual ambulance dispatch.
// ──────────────────────────────────────────────────────────────────────
export const ROBBERY_VICTIM_RADIUS_M = 60
export const ROBBERY_L1_INJURE_CHANCE = 0.2
export const ROBBERY_L2_INJURE_CHANCE = 0.5
export const ROBBERY_L1_INITIAL_HP = 80
export const ROBBERY_L2_INITIAL_HP = 50

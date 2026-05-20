// Design tokens — kept tight so all screens feel like one product.
export const colors = {
  bg: '#0b1220',
  surface: '#121a2e',
  surfaceAlt: '#1a2440',
  border: '#243154',
  textPrimary: '#f1f5fb',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',

  // Role accents — used to highlight "me" on the map
  citizen: '#22d3ee',      // cyan ring — matches web operator console
  worker: '#f43f5e',       // hot pink — generic worker fallback (rarely shown)
  admin: '#a855f7',        // purple for admin

  // Per-subrole accents for workers. Picked to match the dispatch palette
  // used in the web operator console so an admin reading the mobile map
  // recognises each crew at a glance.
  firefighter: '#ef4444',  // red — fire dispatch
  paramedic:   '#fb7185',  // rose — ambulance dispatch
  police:      '#3b82f6',  // blue — police dispatch

  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#06b6d4',

  // Hazard polygons — match web (CartoDB dark) palette
  hazardNotification: '#fbbf24', // yellow — evacuation notifications
  hazardCordon: '#f97316',       // orange — no-entry cordons
};

export const roleAccent = (role: 'citizen' | 'worker' | 'admin') =>
  role === 'citizen' ? colors.citizen : role === 'worker' ? colors.worker : colors.admin;

// Returns the dispatch-palette color for a specific worker sub-role. Falls
// back to the generic worker pink if the sub-role is missing or unknown,
// so legacy data (or a future sub-role we haven't styled yet) still paints.
export type WorkerSubRoleColor = 'firefighter' | 'paramedic' | 'police';
export const workerAccent = (subRole?: string | null): string => {
  if (subRole === 'firefighter') return colors.firefighter;
  if (subRole === 'paramedic') return colors.paramedic;
  if (subRole === 'police') return colors.police;
  return colors.worker;
};

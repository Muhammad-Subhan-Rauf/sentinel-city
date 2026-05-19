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
  worker: '#f43f5e',       // hot pink — matches web operator console
  admin: '#a855f7',        // purple for admin

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

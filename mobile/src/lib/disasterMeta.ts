// Mirrors a slim subset of frontend/src/lib/disasterProfiles.js — only the
// fields the mobile UI needs (color + label + icon). Backend is the source
// of truth for what disasters exist; this file just decorates them.

export type DisasterMeta = {
  label: string;
  color: string;
  icon: string;
};

const META: Record<string, DisasterMeta> = {
  Flood: { label: 'Flood', color: '#3b82f6', icon: '🌊' },
  Wildfire: { label: 'Wildfire', color: '#ef4444', icon: '🔥' },
  Heatwave: { label: 'Heatwave', color: '#facc15', icon: '🥵' },
  Power_Outage: { label: 'Power Outage', color: '#14b8a6', icon: '⚡' },
  Robbery: { label: 'Robbery', color: '#ec4899', icon: '🚨' },
  Gang_Violence: { label: 'Gang Violence', color: '#a855f7', icon: '⚠️' },
  Accident: { label: 'Accident', color: '#f97316', icon: '🚧' },
  Road_Blockage: { label: 'Road Blockage', color: '#94a3b8', icon: '🚦' },
  Infrastructure_Failure: { label: 'Infrastructure Failure', color: '#a16207', icon: '🏗️' },
  Building_Fire: { label: 'Building Fire', color: '#dc2626', icon: '🏚️' },
};

export function metaFor(type: string): DisasterMeta {
  return META[type] ?? { label: type, color: '#64748b', icon: '⚠️' };
}

// Per-disaster-type decoration — label + map color + emoji + vector icon name.
// Colors/emojis mirror the web operator console (frontend/src/lib/disasterProfiles.js)
// so a zone reads the same on phone and desktop. Backend is the source of truth
// for which disasters exist; this just decorates them.

import type { IconName } from '@/components/ui';

export type DisasterMeta = { label: string; icon: IconName; color: string; emoji: string };

const META: Record<string, DisasterMeta> = {
  Flood: { label: 'Flood', icon: 'flood', color: '#3b82f6', emoji: '🌊' },
  Wildfire: { label: 'Wildfire', icon: 'wildfire', color: '#ef4444', emoji: '🔥' },
  Heatwave: { label: 'Heatwave', icon: 'heatwave', color: '#facc15', emoji: '🥵' },
  Power_Outage: { label: 'Power Outage', icon: 'power-outage', color: '#14b8a6', emoji: '⚡' },
  Robbery: { label: 'Robbery', icon: 'robbery', color: '#ec4899', emoji: '🚨' },
  Gang_Violence: { label: 'Gang Violence', icon: 'gang-violence', color: '#a855f7', emoji: '⚠️' },
  Accident: { label: 'Accident', icon: 'accident', color: '#f97316', emoji: '🚧' },
  Road_Blockage: { label: 'Road Blockage', icon: 'road-blockage', color: '#94a3b8', emoji: '🚦' },
  Infrastructure_Failure: { label: 'Infrastructure Failure', icon: 'infrastructure', color: '#a16207', emoji: '🏗️' },
  Building_Fire: { label: 'Building Fire', icon: 'building-fire', color: '#dc2626', emoji: '🏚️' },
};

const FALLBACK: DisasterMeta = { label: 'Hazard', icon: 'alert', color: '#ef4444', emoji: '⚠️' };

export function metaFor(type: string): DisasterMeta {
  return META[type] ?? { ...FALLBACK, label: type.replace(/_/g, ' ') };
}

export const disasterColor = (type: string): string => metaFor(type).color;
export const disasterEmoji = (type: string): string => metaFor(type).emoji;
export const disasterLabel = (type: string): string => metaFor(type).label;

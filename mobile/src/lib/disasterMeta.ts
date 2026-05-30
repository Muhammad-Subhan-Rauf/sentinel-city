// Mirrors a slim subset of frontend/src/lib/disasterProfiles.js — only the
// fields the mobile UI needs (label + vector icon name). Backend is the source
// of truth for what disasters exist; this file just decorates them. Icons are
// semantic names resolved by <Icon> (see components/ui/Icon). Colors come from
// the severity ramp on the active theme, so they're intentionally not stored here.

import type { IconName } from '@/components/ui';

export type DisasterMeta = { label: string; icon: IconName };

const META: Record<string, DisasterMeta> = {
  Flood: { label: 'Flood', icon: 'flood' },
  Wildfire: { label: 'Wildfire', icon: 'wildfire' },
  Heatwave: { label: 'Heatwave', icon: 'heatwave' },
  Power_Outage: { label: 'Power Outage', icon: 'power-outage' },
  Robbery: { label: 'Robbery', icon: 'robbery' },
  Gang_Violence: { label: 'Gang Violence', icon: 'gang-violence' },
  Accident: { label: 'Accident', icon: 'accident' },
  Road_Blockage: { label: 'Road Blockage', icon: 'road-blockage' },
  Infrastructure_Failure: { label: 'Infrastructure Failure', icon: 'infrastructure' },
  Building_Fire: { label: 'Building Fire', icon: 'building-fire' },
};

export function metaFor(type: string): DisasterMeta {
  return META[type] ?? { label: type.replace(/_/g, ' '), icon: 'alert' };
}

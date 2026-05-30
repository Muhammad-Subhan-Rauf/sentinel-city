// Single icon entry-point for the whole app. Screens reference *semantic* names
// ("alert", "ambulance", "route") rather than a specific glyph from a specific
// family, so the icon language stays consistent and swappable in one place.
//
// Replaces every emoji that used to stand in for a structural icon — the #1
// thing that read as "unfinished" in the old UI.

import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { EmergencyService } from '@/lib/api';

type Entry = { lib: 'ion' | 'mci'; glyph: string };

// Keep names task-oriented. `-outline` variants exist where a tab/inactive state
// wants the lighter weight.
const REGISTRY = {
  // Navigation / tabs
  map: { lib: 'ion', glyph: 'map' },
  'map-outline': { lib: 'ion', glyph: 'map-outline' },
  alerts: { lib: 'ion', glyph: 'notifications' },
  'alerts-outline': { lib: 'ion', glyph: 'notifications-outline' },
  settings: { lib: 'ion', glyph: 'settings' },
  'settings-outline': { lib: 'ion', glyph: 'settings-outline' },
  dispatch: { lib: 'mci', glyph: 'car-emergency' },
  'dispatch-outline': { lib: 'ion', glyph: 'warning-outline' },
  calls: { lib: 'ion', glyph: 'call' },
  'calls-outline': { lib: 'ion', glyph: 'call-outline' },
  agents: { lib: 'mci', glyph: 'robot' },
  'agents-outline': { lib: 'mci', glyph: 'robot-outline' },
  impact: { lib: 'ion', glyph: 'stats-chart' },
  'impact-outline': { lib: 'ion', glyph: 'stats-chart-outline' },

  // Emergency services
  ambulance: { lib: 'mci', glyph: 'ambulance' },
  police: { lib: 'mci', glyph: 'police-badge' },
  firefighter: { lib: 'mci', glyph: 'fire-truck' },
  'all-services': { lib: 'ion', glyph: 'alert-circle' },

  // Warning kinds / hazards
  disaster: { lib: 'ion', glyph: 'flame' },
  cordon: { lib: 'mci', glyph: 'sign-caution' },
  weather: { lib: 'ion', glyph: 'thunderstorm' },
  alert: { lib: 'ion', glyph: 'warning' },
  megaphone: { lib: 'ion', glyph: 'megaphone' },
  'megaphone-outline': { lib: 'ion', glyph: 'megaphone-outline' },

  // Disaster types
  flood: { lib: 'ion', glyph: 'water' },
  wildfire: { lib: 'ion', glyph: 'flame' },
  heatwave: { lib: 'mci', glyph: 'weather-sunny-alert' },
  'power-outage': { lib: 'ion', glyph: 'flash-off' },
  robbery: { lib: 'mci', glyph: 'robber' },
  'gang-violence': { lib: 'mci', glyph: 'alert-octagon' },
  accident: { lib: 'mci', glyph: 'car-emergency' },
  'road-blockage': { lib: 'mci', glyph: 'traffic-cone' },
  infrastructure: { lib: 'mci', glyph: 'office-building' },
  'building-fire': { lib: 'mci', glyph: 'home-flood' },

  // UI / actions
  close: { lib: 'ion', glyph: 'close' },
  check: { lib: 'ion', glyph: 'checkmark' },
  'check-circle': { lib: 'ion', glyph: 'checkmark-circle' },
  chevronRight: { lib: 'ion', glyph: 'chevron-forward' },
  chevronDown: { lib: 'ion', glyph: 'chevron-down' },
  chevronUp: { lib: 'ion', glyph: 'chevron-up' },
  arrowRight: { lib: 'ion', glyph: 'arrow-forward' },
  route: { lib: 'ion', glyph: 'navigate' },
  location: { lib: 'ion', glyph: 'location' },
  pin: { lib: 'ion', glyph: 'pin' },
  shield: { lib: 'ion', glyph: 'shield-checkmark' },
  signout: { lib: 'ion', glyph: 'log-out-outline' },
  refresh: { lib: 'ion', glyph: 'refresh' },
  time: { lib: 'ion', glyph: 'time-outline' },
  history: { lib: 'ion', glyph: 'time' },
  'history-outline': { lib: 'ion', glyph: 'time-outline' },
  walk: { lib: 'ion', glyph: 'walk' },
  person: { lib: 'ion', glyph: 'person' },
  people: { lib: 'ion', glyph: 'people' },
  trash: { lib: 'ion', glyph: 'trash-outline' },
  eye: { lib: 'ion', glyph: 'eye-outline' },
  'eye-off': { lib: 'ion', glyph: 'eye-off-outline' },
  radio: { lib: 'ion', glyph: 'radio' },
  offline: { lib: 'ion', glyph: 'cloud-offline-outline' },
  sparkles: { lib: 'ion', glyph: 'sparkles' },
  camera: { lib: 'ion', glyph: 'camera' },
  'camera-outline': { lib: 'ion', glyph: 'camera-outline' },
  'camera-reverse': { lib: 'ion', glyph: 'camera-reverse' },
  flash: { lib: 'ion', glyph: 'flash' },
  'flash-off': { lib: 'ion', glyph: 'flash-off' },
  image: { lib: 'ion', glyph: 'image' },
  'shield-alert': { lib: 'mci', glyph: 'shield-alert' },
  'shield-check': { lib: 'mci', glyph: 'shield-check' },
  'help-circle': { lib: 'ion', glyph: 'help-circle' },
  retake: { lib: 'ion', glyph: 'refresh-circle' },
  search: { lib: 'ion', glyph: 'search' },
  info: { lib: 'ion', glyph: 'information-circle-outline' },
  drag: { lib: 'ion', glyph: 'reorder-two' },
  back: { lib: 'ion', glyph: 'arrow-back' },
  acknowledge: { lib: 'ion', glyph: 'hand-left' },
  enroute: { lib: 'mci', glyph: 'navigation-variant' },
  resolved: { lib: 'ion', glyph: 'checkmark-done' },
} as const satisfies Record<string, Entry>;

export type IconName = keyof typeof REGISTRY;

export function Icon({
  name,
  size = 20,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color: string;
  style?: object;
}) {
  const entry = REGISTRY[name];
  const Comp = entry.lib === 'mci' ? MaterialCommunityIcons : Ionicons;
  return <Comp name={entry.glyph as any} size={size} color={color} style={style} />;
}

// ── Semantic mappers ───────────────────────────────────────────────────────

const SERVICE_ICON: Record<EmergencyService, IconName> = {
  ambulance: 'ambulance',
  police: 'police',
  firefighter: 'firefighter',
};
export const serviceIcon = (s: EmergencyService): IconName => SERVICE_ICON[s] ?? 'all-services';

export function warningKindIcon(kind: string): IconName {
  switch (kind) {
    case 'disaster':
      return 'disaster';
    case 'cordon':
      return 'cordon';
    case 'dispatch':
      return 'megaphone';
    case 'weather':
      return 'weather';
    default:
      return 'alert';
  }
}

const DISASTER_ICON: Record<string, IconName> = {
  Flood: 'flood',
  Wildfire: 'wildfire',
  Heatwave: 'heatwave',
  Power_Outage: 'power-outage',
  Robbery: 'robbery',
  Gang_Violence: 'gang-violence',
  Accident: 'accident',
  Road_Blockage: 'road-blockage',
  Infrastructure_Failure: 'infrastructure',
  Building_Fire: 'building-fire',
};
export const disasterIcon = (type: string): IconName => DISASTER_ICON[type] ?? 'alert';

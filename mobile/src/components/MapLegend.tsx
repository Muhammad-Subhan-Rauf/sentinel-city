// Floating legend for the mobile map. Mirrors the symbology used on the web
// operator console — same colors, dashed-cordon convention, role accents.
// Collapsible to a single chip so it doesn't eat the viewport.

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import { Text, Icon } from '@/components/ui';
import type { WorkerSubRole } from '@/lib/api';

export type LegendStats = { dangerZones: number; advisories: number; cordons: number };
export type StationCounts = { fire: number; hospital: number; police: number };

type Props = {
  myRole: 'citizen' | 'worker' | 'admin';
  mySubRole?: WorkerSubRole;
  /** Show other citizens (privacy-gated — off on the citizen map). */
  showOtherUsers: boolean;
  hasDestination: boolean;
  hasRoute: boolean;
  hasPins: boolean;
  /** Counts of public-servant stations shown on the map (fire/hospital/police). */
  stationCounts?: StationCounts;
  citizenCount?: number;
  stats: LegendStats;
  /** Absolute top offset (px) — each screen sets this to clear its own header /
   *  safe-area / top banners so the chip + expanded panel never collide. */
  topOffset?: number;
};

function LegendRow({ swatch, label, detail }: { swatch: React.ReactNode; label: string; detail?: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.swatchCell}>{swatch}</View>
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
        {detail ? (
          <Text variant="caption" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// Emoji swatch used for the station legend rows — mirrors the map markers.
function Glyph({ emoji }: { emoji: string }) {
  return <Text style={{ fontSize: 16 }}>{emoji}</Text>;
}

const countLabel = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function MapLegend({ myRole, mySubRole, showOtherUsers, hasDestination, hasRoute, hasPins, stationCounts, citizenCount, stats, topOffset = 16 }: Props) {
  const t = useTheme();
  const [open, setOpen] = useState(false);

  const workerAccent = (sub?: string) =>
    sub === 'firefighter' ? t.color.firefighter : sub === 'police' ? t.color.police : sub === 'paramedic' ? t.color.paramedic : t.color.worker;

  const Dot = ({ color, ring = false }: { color: string; ring?: boolean }) => (
    <View style={[styles.dot, { backgroundColor: color }, ring && { borderWidth: 2, borderColor: t.color.alwaysWhite }]} />
  );
  const PolygonChip = ({ color, dashed = false }: { color: string; dashed?: boolean }) => (
    <View style={[styles.polygonChip, { borderColor: color, backgroundColor: color + '33', borderStyle: dashed ? 'dashed' : 'solid' }]} />
  );
  const LineChip = ({ color }: { color: string }) => <View style={[styles.lineChip, { backgroundColor: color }]} />;

  const meAccent = myRole === 'citizen' ? t.color.citizen : myRole === 'worker' ? workerAccent(mySubRole) : t.color.admin;
  const subRoleLabel =
    mySubRole === 'firefighter' ? 'Firefighter' : mySubRole === 'paramedic' ? 'Paramedic' : mySubRole === 'police' ? 'Police' : 'Emergency Worker';
  const meLabel = myRole === 'citizen' ? 'You (Citizen)' : myRole === 'worker' ? `You (${subRoleLabel})` : 'You (Operator)';

  const chipText =
    stats.dangerZones > 0
      ? `${stats.dangerZones} danger zone${stats.dangerZones === 1 ? '' : 's'}`
      : stats.advisories + stats.cordons > 0
        ? `${stats.advisories + stats.cordons} active alert${stats.advisories + stats.cordons === 1 ? '' : 's'}`
        : 'Legend';

  return (
    <View style={[styles.wrap, { top: topOffset }]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Map legend. ${chipText}`}
        style={[styles.chip, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.pill, ...t.shadow(1) }]}
      >
        <View style={[styles.chipDot, { backgroundColor: stats.dangerZones > 0 ? t.color.danger : t.color.primary }]} />
        <Text variant="label">{chipText}</Text>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} color={t.color.textSecondary} />
      </Pressable>

      {open && (
        <View style={[styles.panel, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
          <Text variant="overline" tone="muted" style={styles.sectionHeader}>
            People
          </Text>
          <LegendRow swatch={<Dot color={meAccent} ring />} label={meLabel} detail="80 m awareness ring" />
          {showOtherUsers && (
            <LegendRow swatch={<Dot color={t.color.citizen} />} label="Citizens" detail={citizenCount != null ? `${citizenCount} online` : 'Cyan dot'} />
          )}

          {stationCounts && (
            <>
              <Text variant="overline" tone="muted" style={styles.sectionHeader}>
                Stations
              </Text>
              <LegendRow swatch={<Glyph emoji="🚒" />} label="Fire station" detail={countLabel(stationCounts.fire, 'station', 'stations')} />
              <LegendRow swatch={<Glyph emoji="🏥" />} label="Hospital" detail={countLabel(stationCounts.hospital, 'hospital', 'hospitals')} />
              <LegendRow swatch={<Glyph emoji="🚓" />} label="Police station" detail={countLabel(stationCounts.police, 'station', 'stations')} />
            </>
          )}

          <Text variant="overline" tone="muted" style={styles.sectionHeader}>
            Hazards
          </Text>
          <LegendRow swatch={<PolygonChip color={t.color.danger} />} label="Active disaster" detail="Live footprint" />
          <LegendRow swatch={<PolygonChip color={t.color.hazardNotification} />} label="Evacuation advisory" detail="Yellow polygon" />
          <LegendRow swatch={<PolygonChip color={t.color.hazardCordon} dashed />} label="No-entry cordon" detail="Dashed orange" />

          {(hasDestination || hasRoute || hasPins) && (
            <>
              <Text variant="overline" tone="muted" style={styles.sectionHeader}>
                Navigation
              </Text>
              {hasDestination && <LegendRow swatch={<Dot color={t.color.success} />} label="Destination" />}
              {hasRoute && <LegendRow swatch={<LineChip color={t.color.primary} />} label="Suggested route" detail="Avoids hazards" />}
              {hasPins && <LegendRow swatch={<Dot color={t.color.primary} />} label="Citizen report" detail="Tap to view" />}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // `top` is supplied per-screen via the topOffset prop so the legend clears
  // each map's own header / safe-area / banners.
  wrap: { position: 'absolute', left: 16, right: 16 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 12, gap: 8 },
  chipDot: { width: 10, height: 10, borderRadius: 5 },
  panel: { marginTop: 8, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 12, maxWidth: 320 },
  sectionHeader: { marginTop: 8, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 10 },
  swatchCell: { width: 28, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  polygonChip: { width: 22, height: 14, borderWidth: 2, borderRadius: 3 },
  lineChip: { width: 22, height: 3, borderRadius: 2 },
});

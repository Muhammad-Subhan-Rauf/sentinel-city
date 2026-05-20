// Floating legend for the mobile map. Mirrors the symbology used on the web
// operator console so an admin coming from the web can read the mobile screen
// at a glance — same colors, same dashed-cordon convention, same role accents.
//
// Collapsible to a single chip so it doesn't eat half the viewport. The chip
// always shows the live hazard count (the most actionable summary); the
// expanded panel breaks down every glyph the map can render.

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, workerAccent } from '@/lib/colors';
import type { WorkerSubRole } from '@/lib/api';

export type LegendStats = {
  dangerZones: number;
  advisories: number;
  cordons: number;
};

export type WorkerCounts = {
  firefighter: number;
  paramedic: number;
  police: number;
};

type Props = {
  myRole: 'citizen' | 'worker' | 'admin';
  // Sub-role chosen for the "me" row's color + label when the user is a worker.
  mySubRole?: WorkerSubRole;
  showOtherUsers: boolean;
  hasDestination: boolean;
  hasRoute: boolean;
  hasPins: boolean;
  // Live tallies so the legend doubles as a roster summary — useful for admins
  // checking "are any paramedics actually online?" at a glance.
  workerCounts?: WorkerCounts;
  citizenCount?: number;
  stats: LegendStats;
};

// One row in the expanded panel — a colored swatch + a label + an optional
// secondary description. Swatch shape varies (dot/ring/line/dashed) so each
// symbol maps to its on-map appearance.
function LegendRow({
  swatch,
  label,
  detail,
}: {
  swatch: React.ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.swatchCell}>{swatch}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

const Dot = ({ color, ring = false }: { color: string; ring?: boolean }) => (
  <View
    style={[
      styles.dot,
      { backgroundColor: color },
      ring && { borderWidth: 2, borderColor: '#fff' },
    ]}
  />
);

const PolygonChip = ({
  color,
  dashed = false,
}: {
  color: string;
  dashed?: boolean;
}) => (
  <View
    style={[
      styles.polygonChip,
      {
        borderColor: color,
        backgroundColor: color + '33',
        borderStyle: dashed ? 'dashed' : 'solid',
      },
    ]}
  />
);

const LineChip = ({ color }: { color: string }) => (
  <View style={[styles.lineChip, { backgroundColor: color }]} />
);

export function MapLegend({
  myRole,
  mySubRole,
  showOtherUsers,
  hasDestination,
  hasRoute,
  hasPins,
  workerCounts,
  citizenCount,
  stats,
}: Props) {
  const [open, setOpen] = useState(false);

  // "Me" accent matches the dot drawn on the map. Workers get their dispatch
  // color (red/rose/blue); citizens/admin fall back to their role accent.
  const meAccent =
    myRole === 'citizen'
      ? colors.citizen
      : myRole === 'worker'
        ? workerAccent(mySubRole)
        : colors.admin;
  const subRoleLabel =
    mySubRole === 'firefighter'
      ? 'Firefighter'
      : mySubRole === 'paramedic'
        ? 'Paramedic'
        : mySubRole === 'police'
          ? 'Police'
          : 'Emergency Worker';
  const meLabel =
    myRole === 'citizen'
      ? 'You (Citizen)'
      : myRole === 'worker'
        ? `You (${subRoleLabel})`
        : 'You (Operator)';

  // Headline chip text. Prefer the most urgent count.
  const chipText =
    stats.dangerZones > 0
      ? `${stats.dangerZones} danger zone${stats.dangerZones === 1 ? '' : 's'}`
      : stats.advisories + stats.cordons > 0
        ? `${stats.advisories + stats.cordons} active alert${stats.advisories + stats.cordons === 1 ? '' : 's'}`
        : 'Legend';

  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.chip} hitSlop={6}>
        <View
          style={[
            styles.chipDot,
            { backgroundColor: stats.dangerZones > 0 ? colors.danger : colors.info },
          ]}
        />
        <Text style={styles.chipText}>{chipText}</Text>
        <Text style={styles.caret}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open && (
        <View style={styles.panel}>
          <Text style={styles.sectionHeader}>People</Text>
          <LegendRow swatch={<Dot color={meAccent} ring />} label={meLabel} detail="80 m awareness ring" />
          {showOtherUsers && (
            <>
              <LegendRow
                swatch={<Dot color={colors.citizen} />}
                label="Citizens"
                detail={
                  citizenCount != null
                    ? `${citizenCount} online · cyan dot`
                    : 'Cyan dot'
                }
              />
              <LegendRow
                swatch={<Dot color={colors.firefighter} />}
                label="Firefighters"
                detail={
                  workerCounts
                    ? `${workerCounts.firefighter} on duty · red dot`
                    : 'Red dot — fire dispatch'
                }
              />
              <LegendRow
                swatch={<Dot color={colors.paramedic} />}
                label="Paramedics"
                detail={
                  workerCounts
                    ? `${workerCounts.paramedic} on duty · rose dot`
                    : 'Rose dot — ambulance dispatch'
                }
              />
              <LegendRow
                swatch={<Dot color={colors.police} />}
                label="Police"
                detail={
                  workerCounts
                    ? `${workerCounts.police} on duty · blue dot`
                    : 'Blue dot — police dispatch'
                }
              />
            </>
          )}

          <Text style={styles.sectionHeader}>Hazards</Text>
          <LegendRow
            swatch={<PolygonChip color={colors.danger} />}
            label="Active disaster"
            detail="Live footprint from operator console"
          />
          <LegendRow
            swatch={<PolygonChip color={colors.hazardNotification} />}
            label="Evacuation advisory"
            detail="Operator-drawn yellow polygon"
          />
          <LegendRow
            swatch={<PolygonChip color={colors.hazardCordon} dashed />}
            label="No-entry cordon"
            detail="Dashed orange polygon"
          />

          {(hasDestination || hasRoute || hasPins) && (
            <>
              <Text style={styles.sectionHeader}>Navigation</Text>
              {hasDestination && (
                <LegendRow swatch={<Dot color={colors.success} />} label="Destination" />
              )}
              {hasRoute && (
                <LegendRow
                  swatch={<LineChip color={colors.info} />}
                  label="Suggested route"
                  detail="Avoids cordoned areas"
                />
              )}
              {hasPins && (
                <LegendRow
                  swatch={<Dot color={colors.info} />}
                  label="Citizen report"
                  detail="Tap to view details"
                />
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    gap: 8,
  },
  chipDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  chipText: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 13,
  },
  caret: {
    color: colors.textSecondary,
    fontSize: 12,
    marginLeft: 2,
  },
  panel: {
    marginTop: 8,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    // Tight max width so the panel reads as a card, not a fullscreen sheet.
    maxWidth: 320,
  },
  sectionHeader: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 6,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    gap: 10,
  },
  swatchCell: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  rowDetail: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  polygonChip: {
    width: 22,
    height: 14,
    borderWidth: 2,
    borderRadius: 3,
  },
  lineChip: {
    width: 22,
    height: 3,
    borderRadius: 2,
  },
});

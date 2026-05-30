// Headline metric tile. Big tabular value + label, optional leading icon and a
// "tap for AI insight" affordance. Replaces the old StatCard.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Card } from './Card';
import { Text } from './Text';
import { IconBadge } from './IconBadge';
import { Icon, IconName } from './Icon';

export function StatTile({
  label,
  value,
  accent,
  icon,
  hint,
  onPress,
}: {
  label: string;
  value: string;
  accent?: string;
  icon?: IconName;
  hint?: string;
  onPress?: () => void;
}) {
  const t = useTheme();
  const a = accent ?? t.color.primary;
  return (
    <Card
      onPress={onPress}
      accent={a}
      style={{ marginBottom: t.spacing.md }}
      accessibilityLabel={`${label}: ${value}`}
      accessibilityHint={onPress ? 'Opens the AI insight for this metric' : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
        {icon ? <IconBadge name={icon} color={a} size={44} /> : null}
        <View style={{ flex: 1 }}>
          <Text variant="label" tone="secondary">
            {label}
          </Text>
          <Text variant="title" color={a} style={{ fontVariant: ['tabular-nums'], marginTop: 2 }}>
            {value}
          </Text>
        </View>
        {onPress ? <Icon name="chevronRight" size={20} color={t.color.textMuted} /> : null}
      </View>
      {onPress ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: t.spacing.sm }}>
          <Icon name="sparkles" size={13} color={t.color.textMuted} />
          <Text variant="caption" tone="muted">
            {hint ?? 'Tap for AI insight'}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

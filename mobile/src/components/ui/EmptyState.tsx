// Friendly empty / cleared state. An icon in a soft disc, a headline, an
// optional body line, and an optional action. Used for "no alerts", "no calls",
// load failures, etc. — never leave a blank region.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { IconBadge } from './IconBadge';
import { IconName } from './Icon';
import { Button } from './Button';

export function EmptyState({
  icon,
  title,
  body,
  tone,
  actionLabel,
  onAction,
}: {
  icon: IconName;
  title: string;
  body?: string;
  /** Accent for the icon disc; defaults to success ("all clear" reads calm). */
  tone?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: t.spacing.xxl, paddingVertical: t.spacing.giant }}>
      <IconBadge name={icon} color={tone ?? t.color.success} size={64} iconSize={30} />
      <Text variant="h2" center style={{ marginTop: t.spacing.lg }}>
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="secondary" center style={{ marginTop: t.spacing.sm }}>
          {body}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="secondary" fullWidth={false} onPress={onAction} style={{ marginTop: t.spacing.xl }} />
      ) : null}
    </View>
  );
}

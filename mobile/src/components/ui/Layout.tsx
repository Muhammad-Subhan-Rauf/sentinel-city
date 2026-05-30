// Small structural primitives: SectionHeader, Divider, Row, Spacer.

import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export function SectionHeader({
  title,
  hint,
  right,
  style,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View style={[{ marginBottom: t.spacing.sm, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: t.spacing.md }, style]}>
      <View style={{ flex: 1 }}>
        <Text variant="overline" tone="muted">
          {title}
        </Text>
        {hint ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {hint}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function Divider({ style }: { style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ height: StyleSheet_hairline, backgroundColor: t.color.divider }, style]} />;
}

const StyleSheet_hairline = 1;

export function Row({
  children,
  gap,
  align = 'center',
  justify,
  style,
}: {
  children: React.ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View style={[{ flexDirection: 'row', alignItems: align, justifyContent: justify, gap: gap ?? t.spacing.sm }, style]}>
      {children}
    </View>
  );
}

export function Spacer({ size = 16 }: { size?: number }) {
  return <View style={{ height: size }} />;
}

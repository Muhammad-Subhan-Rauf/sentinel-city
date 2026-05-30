// Standard screen scaffold: safe-area aware, themed background, an optional
// large title + subtitle header, and a scroll/no-scroll body. List screens pass
// `scroll={false}` and render their own FlatList so virtualization works.

import React from 'react';
import { ScrollView, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui';

type Props = {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  /** Apply the standard 16pt gutter to the body. */
  padded?: boolean;
  contentContainerStyle?: ViewStyle;
};

export function Screen({
  title,
  subtitle,
  right,
  children,
  scroll = true,
  padded = true,
  contentContainerStyle,
}: Props) {
  const t = useTheme();
  const pad: ViewStyle = padded
    ? { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xxxl }
    : {};

  const header =
    title || subtitle || right ? (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: t.spacing.md,
          paddingHorizontal: t.spacing.lg,
          paddingTop: t.spacing.sm,
          paddingBottom: t.spacing.md,
        }}
      >
        <View style={{ flex: 1 }}>
          {title ? <Text variant="title">{title}</Text> : null}
          {subtitle ? (
            <Text variant="body" tone="secondary" style={{ marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={{ paddingTop: 4 }}>{right}</View> : null}
      </View>
    ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right']}>
      {header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[{ paddingTop: t.spacing.xs }, pad, contentContainerStyle]}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, pad, contentContainerStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

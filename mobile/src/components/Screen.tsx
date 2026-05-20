import React from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@/lib/colors';

type Props = {
  title?: string;
  children: React.ReactNode;
  scroll?: boolean;
};

export function Screen({ title, children, scroll = true }: Props) {
  const body = scroll ? (
    <ScrollView contentContainerStyle={styles.scrollPad}>{children}</ScrollView>
  ) : (
    // Non-scroll body must flex so a FlatList/list child can size itself.
    // Without `flex: 1` here, virtualized children collapse to 0 height and
    // render no rows (the bug that hid the Notifications feed).
    <View style={[styles.scrollPad, { flex: 1 }]}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  scrollPad: { padding: 16, paddingBottom: 32 },
});

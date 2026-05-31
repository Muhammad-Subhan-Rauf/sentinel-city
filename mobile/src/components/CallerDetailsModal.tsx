// Read-only caller profile, opened from a 911 call card so responders can see
// who they're rolling to (vitals, conditions, emergency contact) at a glance.
// The data rides on the call as `caller_profile` — it is NOT spoken in the
// transcript. Only fields the caller actually filled are shown.

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { Text, Card, IconBadge, Icon, SectionHeader, IconName } from '@/components/ui';

type Profile = Record<string, string | boolean | null | undefined> | null | undefined;

const has = (v: unknown) => (typeof v === 'string' ? v.trim().length > 0 : !!v);

function Row({ label, value }: { label: string; value?: string | null }) {
  const t = useTheme();
  if (!has(value)) return null;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: t.spacing.md, paddingVertical: 6 }}>
      <Text variant="caption" tone="muted" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text variant="bodyStrong" style={{ flex: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

function Section({ title, icon, accent, children, show }: { title: string; icon: IconName; accent: string; children: React.ReactNode; show: boolean }) {
  const t = useTheme();
  if (!show) return null;
  return (
    <Card style={{ marginBottom: t.spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: t.spacing.sm }}>
        <IconBadge name={icon} color={accent} size={30} iconSize={16} />
        <Text variant="overline" tone="muted">
          {title}
        </Text>
      </View>
      {children}
    </Card>
  );
}

export function CallerDetailsModal({
  visible,
  onClose,
  profile,
  fallbackName,
}: {
  visible: boolean;
  onClose: () => void;
  profile: Profile;
  fallbackName?: string;
}) {
  const t = useTheme();
  const p = profile ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);

  const contact = [str('emergencyContactName'), str('emergencyContactRelation') ? `(${str('emergencyContactRelation')})` : '', str('emergencyContactPhone')]
    .filter(Boolean)
    .join(' ');

  const identityShown = ['fullName', 'dateOfBirth', 'sex', 'phone', 'homeAddress', 'primaryLanguage'].some((k) => has(p[k]));
  const medicalShown = ['bloodType', 'heightCm', 'weightKg', 'allergies', 'medications', 'conditions', 'accessibility'].some((k) => has(p[k])) || p.organDonor === true;
  const insuranceShown = ['insuranceProvider', 'insurancePolicy'].some((k) => has(p[k]));
  const empty = !identityShown && !medicalShown && !insuranceShown && !has(p.notes) && !has(contact);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: t.color.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <IconBadge name="person" color={t.color.primary} size={40} />
            <View style={{ flex: 1 }}>
              <Text variant="h2" numberOfLines={1}>
                {str('fullName') || fallbackName || 'Caller'}
              </Text>
              <Text variant="caption" tone="muted">
                Caller details
              </Text>
            </View>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close caller details">
            <Icon name="close" size={26} color={t.color.textSecondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: t.spacing.huge }}>
          {empty ? (
            <View style={{ alignItems: 'center', paddingTop: t.spacing.giant }}>
              <IconBadge name="person" color={t.color.textMuted} size={56} iconSize={28} />
              <Text variant="body" tone="muted" center style={{ marginTop: t.spacing.md }}>
                This caller hasn't filled in a profile.
              </Text>
            </View>
          ) : (
            <>
              <Section title="Identity" icon="person" accent={t.color.primary} show={identityShown}>
                <Row label="Name" value={str('fullName')} />
                <Row label="Date of birth" value={str('dateOfBirth')} />
                <Row label="Sex" value={str('sex')} />
                <Row label="Phone" value={str('phone')} />
                <Row label="Home address" value={str('homeAddress')} />
                <Row label="Language" value={str('primaryLanguage')} />
              </Section>

              <Section title="Medical & vitals" icon="ambulance" accent={t.color.danger} show={medicalShown}>
                <Row label="Blood type" value={str('bloodType')} />
                <Row label="Height" value={has(str('heightCm')) ? `${str('heightCm')} cm` : undefined} />
                <Row label="Weight" value={has(str('weightKg')) ? `${str('weightKg')} kg` : undefined} />
                <Row label="Allergies" value={str('allergies')} />
                <Row label="Medications" value={str('medications')} />
                <Row label="Conditions" value={str('conditions')} />
                <Row label="Accessibility" value={str('accessibility')} />
                <Row label="Organ donor" value={p.organDonor === true ? 'Yes' : undefined} />
              </Section>

              <Section title="Emergency contact" icon="calls" accent={t.color.success} show={has(contact)}>
                <Row label="Contact" value={contact} />
              </Section>

              <Section title="Insurance" icon="shield" accent={t.color.info} show={insuranceShown}>
                <Row label="Provider" value={str('insuranceProvider')} />
                <Row label="Policy" value={str('insurancePolicy')} />
              </Section>

              <Section title="Notes" icon="info" accent={t.color.warning} show={has(p.notes)}>
                <Text variant="body">{str('notes')}</Text>
              </Section>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
});

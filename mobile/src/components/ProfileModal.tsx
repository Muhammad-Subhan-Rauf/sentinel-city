// Profile editor. Civilians get a full emergency/medical profile (auto-shared
// with the 911 operator); public servants get a slim service profile. Opened as
// a full-screen modal from Settings. Loads/saves to on-device storage.

import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { Text, Button, Icon, SectionHeader } from '@/components/ui';
import { AnyProfile, loadProfileOrSeed, saveProfile } from '@/lib/profile';

type Kind = 'civilian' | 'responder';

type FieldDef = {
  key: keyof AnyProfile;
  label: string;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address';
  multiline?: boolean;
  autoCapitalize?: 'none' | 'words' | 'sentences';
};

type SectionDef = { title: string; hint?: string; fields: FieldDef[] };

const CIVILIAN_SECTIONS: SectionDef[] = [
  {
    title: 'Identity',
    fields: [
      { key: 'fullName', label: 'Full name', placeholder: 'e.g. Alex Carter', autoCapitalize: 'words' },
      { key: 'dateOfBirth', label: 'Date of birth', placeholder: 'YYYY-MM-DD' },
      { key: 'sex', label: 'Sex', placeholder: 'e.g. Female / Male / Other' },
      { key: 'phone', label: 'Phone number', placeholder: 'e.g. +1 555 123 4567', keyboardType: 'phone-pad' },
      { key: 'homeAddress', label: 'Home address', placeholder: 'Street, city', multiline: true, autoCapitalize: 'words' },
      { key: 'primaryLanguage', label: 'Primary language', placeholder: 'e.g. English', autoCapitalize: 'words' },
    ],
  },
  {
    title: 'Medical & vitals',
    hint: 'Shared with the operator so responders arrive prepared.',
    fields: [
      { key: 'bloodType', label: 'Blood type', placeholder: 'e.g. O+' },
      { key: 'heightCm', label: 'Height (cm)', placeholder: 'e.g. 175', keyboardType: 'numeric' },
      { key: 'weightKg', label: 'Weight (kg)', placeholder: 'e.g. 70', keyboardType: 'numeric' },
      { key: 'allergies', label: 'Allergies', placeholder: 'e.g. penicillin, peanuts', multiline: true },
      { key: 'medications', label: 'Current medications', placeholder: 'e.g. insulin, albuterol', multiline: true },
      { key: 'conditions', label: 'Medical conditions', placeholder: 'e.g. asthma, diabetes, epilepsy, pregnancy', multiline: true },
      { key: 'accessibility', label: 'Accessibility needs', placeholder: 'e.g. wheelchair user, hard of hearing', multiline: true },
    ],
  },
  {
    title: 'Emergency contact',
    fields: [
      { key: 'emergencyContactName', label: 'Contact name', placeholder: 'e.g. Jane Carter', autoCapitalize: 'words' },
      { key: 'emergencyContactRelation', label: 'Relationship', placeholder: 'e.g. sister' },
      { key: 'emergencyContactPhone', label: 'Contact phone', placeholder: 'e.g. +1 555 987 6543', keyboardType: 'phone-pad' },
    ],
  },
  {
    title: 'Insurance (optional)',
    fields: [
      { key: 'insuranceProvider', label: 'Provider', placeholder: 'e.g. BlueCross', autoCapitalize: 'words' },
      { key: 'insurancePolicy', label: 'Policy number', placeholder: 'e.g. 1234-5678' },
    ],
  },
  {
    title: 'Notes for responders',
    fields: [{ key: 'notes', label: 'Anything else', placeholder: 'Gate code, pets, where you usually are…', multiline: true, autoCapitalize: 'sentences' }],
  },
];

const RESPONDER_SECTIONS: SectionDef[] = [
  {
    title: 'Identity',
    fields: [
      { key: 'fullName', label: 'Full name', placeholder: 'e.g. Officer Dana Lee', autoCapitalize: 'words' },
      { key: 'badgeId', label: 'Badge / ID number', placeholder: 'e.g. FF-2043' },
      { key: 'rank', label: 'Rank', placeholder: 'e.g. Lieutenant', autoCapitalize: 'words' },
      { key: 'unit', label: 'Unit / station', placeholder: 'e.g. Engine 12 / 7th Precinct', autoCapitalize: 'words' },
      { key: 'callSign', label: 'Call sign', placeholder: 'e.g. Medic-3' },
    ],
  },
  {
    title: 'Service',
    fields: [
      { key: 'certifications', label: 'Certifications', placeholder: 'e.g. EMT-Paramedic, Hazmat', multiline: true },
      { key: 'yearsOfService', label: 'Years of service', placeholder: 'e.g. 8', keyboardType: 'numeric' },
      { key: 'bloodType', label: 'Blood type', placeholder: 'e.g. O+' },
    ],
  },
  {
    title: 'Emergency contact',
    fields: [
      { key: 'emergencyContactName', label: 'Contact name', placeholder: 'e.g. Sam Lee', autoCapitalize: 'words' },
      { key: 'emergencyContactPhone', label: 'Contact phone', placeholder: 'e.g. +1 555 222 3333', keyboardType: 'phone-pad' },
    ],
  },
];

export function ProfileModal({
  visible,
  onClose,
  userId,
  kind,
  subRole,
  name,
  accent,
}: {
  visible: boolean;
  onClose: () => void;
  userId: string;
  kind: Kind;
  subRole?: string;
  name?: string;
  accent: string;
}) {
  const t = useTheme();
  const [profile, setProfile] = useState<AnyProfile>({});
  const [saving, setSaving] = useState(false);
  const sections = kind === 'civilian' ? CIVILIAN_SECTIONS : RESPONDER_SECTIONS;

  useEffect(() => {
    if (!visible) return;
    loadProfileOrSeed(userId, kind, subRole, name).then(setProfile).catch(() => setProfile({}));
  }, [visible, userId, kind, subRole, name]);

  const set = (key: keyof AnyProfile, value: string | boolean) => setProfile((p) => ({ ...p, [key]: value }));

  const onSave = async () => {
    setSaving(true);
    await saveProfile(userId, profile);
    setSaving(false);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
    <SafeAreaView style={[styles.root, { backgroundColor: t.color.bg }]} edges={['top', 'left', 'right', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: t.color.border }]}>
        <View style={{ flex: 1 }}>
          <Text variant="h1">{kind === 'civilian' ? 'Your profile' : 'Service profile'}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close profile">
          <Icon name="close" size={26} color={t.color.textSecondary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: t.spacing.giant }} keyboardShouldPersistTaps="handled">
          {/* Why we ask */}
          <View style={[styles.note, { backgroundColor: accent + '1A', borderColor: accent + '55', borderRadius: t.radius.md }]}>
            <Icon name={kind === 'civilian' ? 'shield' : 'info'} size={16} color={accent} />
            <Text variant="caption" tone="secondary" style={{ flex: 1, marginLeft: 8 }}>
              {kind === 'civilian'
                ? 'This is shared automatically with the 911 operator when you call, so they can identify you and brief the right department. Stored on your device.'
                : 'Your service details — shown to dispatch / command so they know who is responding. Stored on your device.'}
            </Text>
          </View>

          {sections.map((section) => (
            <View key={section.title} style={{ marginTop: t.spacing.lg }}>
              <SectionHeader title={section.title} hint={section.hint} />
              {section.fields.map((f) => (
                <Field
                  key={f.key as string}
                  def={f}
                  value={(profile[f.key] as string) ?? ''}
                  onChange={(v) => set(f.key, v)}
                />
              ))}
            </View>
          ))}

          {/* Organ donor toggle (civilian only) */}
          {kind === 'civilian' && (
            <View style={[styles.switchRow, { borderColor: t.color.border, borderRadius: t.radius.md, marginTop: t.spacing.md }]}>
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">Registered organ donor</Text>
                <Text variant="caption" tone="muted">
                  Relayed to medical responders.
                </Text>
              </View>
              <Switch
                value={!!profile.organDonor}
                onValueChange={(v) => set('organDonor', v)}
                trackColor={{ true: accent, false: t.color.surfaceAlt }}
                thumbColor={t.color.alwaysWhite}
              />
            </View>
          )}

          <Button label="Save profile" icon="check" loading={saving} onPress={onSave} style={{ marginTop: t.spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </Modal>
  );
}

function Field({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: t.spacing.md }}>
      <Text variant="label" tone="secondary" style={{ marginBottom: 6 }}>
        {def.label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={def.placeholder}
        placeholderTextColor={t.color.textMuted}
        keyboardType={def.keyboardType ?? 'default'}
        autoCapitalize={def.autoCapitalize ?? 'sentences'}
        multiline={def.multiline}
        style={[
          {
            backgroundColor: t.color.surface,
            borderColor: t.color.border,
            borderWidth: 1,
            borderRadius: t.radius.md,
            paddingHorizontal: t.spacing.md,
            paddingVertical: 12,
            color: t.color.textPrimary,
            fontFamily: t.fonts.regular,
            fontSize: t.fontSize.md,
            minHeight: 48,
          },
          def.multiline && { minHeight: 72, textAlignVertical: 'top' },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  note: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, borderWidth: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1 },
});

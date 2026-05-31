// Per-user emergency profile, stored on-device (AsyncStorage). For civilians it
// holds the vitals/medical/contact info a 911 operator needs to identify the
// caller and brief the responding department; it's auto-appended to the call
// transcript when an SOS is placed. Public servants get a slimmer service profile.
//
// Stored locally (keyed per user) rather than on the backend: the data is
// sensitive, the backend roster is in-memory, and the operator receives what
// matters via the call transcript (see summarizeCivilianForDispatch).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from './auth';

export type CivilianProfile = {
  fullName?: string;
  dateOfBirth?: string;
  sex?: string;
  phone?: string;
  homeAddress?: string;
  primaryLanguage?: string;
  // Vitals / medical
  bloodType?: string;
  heightCm?: string;
  weightKg?: string;
  allergies?: string;
  medications?: string;
  conditions?: string; // chronic conditions: asthma, diabetes, epilepsy, cardiac, pregnancy…
  accessibility?: string; // mobility / sensory / cognitive needs responders should know
  organDonor?: boolean;
  // Insurance
  insuranceProvider?: string;
  insurancePolicy?: string;
  // Emergency contact
  emergencyContactName?: string;
  emergencyContactRelation?: string;
  emergencyContactPhone?: string;
  // Free text
  notes?: string;
};

export type ResponderProfile = {
  fullName?: string;
  badgeId?: string;
  rank?: string;
  unit?: string; // station / precinct / unit name
  callSign?: string;
  certifications?: string;
  yearsOfService?: string;
  bloodType?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
};

export type AnyProfile = CivilianProfile & ResponderProfile;

const KEY = (userId: string) => `sentinel.profile.v1:${userId}`;
const SEEDED_KEY = (userId: string) => `sentinel.profile-seeded.v1:${userId}`;

export type ProfileKind = 'civilian' | 'responder';

// Demo seed data so every account opens Manage Profile with a realistic, filled
// profile (and so 911 calls carry believable caller info out of the box). Keyed
// by role / sub-role. The logged-in name is threaded in so the card matches.
export function mockProfileFor(kind: ProfileKind, subRole: string | undefined, name?: string): AnyProfile {
  if (kind === 'civilian') {
    return {
      fullName: name ?? 'Alex Carter',
      dateOfBirth: '1991-03-22',
      sex: 'Female',
      phone: '+1 555 0142',
      homeAddress: '210 W 70th St, Apt 4B, New York, NY 10023',
      primaryLanguage: 'English',
      bloodType: 'O+',
      heightCm: '170',
      weightKg: '68',
      allergies: 'Penicillin, peanuts',
      medications: 'Albuterol inhaler (as needed)',
      conditions: 'Asthma',
      accessibility: 'None',
      organDonor: true,
      insuranceProvider: 'BlueCross BlueShield',
      insurancePolicy: 'BCBS-4471902',
      emergencyContactName: 'Jordan Avery',
      emergencyContactRelation: 'Spouse',
      emergencyContactPhone: '+1 555 0199',
      notes: '4th-floor walk-up, apartment 4B. One cat indoors.',
    };
  }
  const RESPONDER: Record<string, ResponderProfile> = {
    firefighter: {
      fullName: name ?? 'Dana Brooks',
      badgeId: 'FF-2043',
      rank: 'Lieutenant',
      unit: 'Engine 12 / Ladder 12',
      callSign: 'Ladder-12',
      certifications: 'Firefighter II, Hazmat Technician, EMT-B',
      yearsOfService: '9',
      bloodType: 'A+',
      emergencyContactName: 'Sam Rivera',
      emergencyContactPhone: '+1 555 0173',
    },
    paramedic: {
      fullName: name ?? 'Morgan Ellis',
      badgeId: 'EMS-7781',
      rank: 'Paramedic',
      unit: 'Medic 3',
      callSign: 'Medic-3',
      certifications: 'NREMT-Paramedic, ACLS, PALS',
      yearsOfService: '6',
      bloodType: 'O-',
      emergencyContactName: 'Casey Tran',
      emergencyContactPhone: '+1 555 0188',
    },
    police: {
      fullName: name ?? 'Riley Quinn',
      badgeId: 'PD-5512',
      rank: 'Sergeant',
      unit: '7th Precinct',
      callSign: 'Unit-21',
      certifications: 'POST Certified, Crisis Intervention (CIT)',
      yearsOfService: '11',
      bloodType: 'B+',
      emergencyContactName: 'Jamie Park',
      emergencyContactPhone: '+1 555 0165',
    },
  };
  return RESPONDER[subRole ?? 'firefighter'] ?? RESPONDER.firefighter;
}

export async function loadProfile(userId: string): Promise<AnyProfile> {
  try {
    const raw = await AsyncStorage.getItem(KEY(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveProfile(userId: string, profile: AnyProfile): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY(userId), JSON.stringify(profile));
  } catch {
    /* best-effort */
  }
}

// Loads the saved profile, or — the first time only — seeds and persists a
// role-appropriate mock so the profile is never empty on a fresh account. The
// one-time seed flag means a user who deliberately clears their profile won't
// have it silently repopulated.
export async function loadProfileOrSeed(
  userId: string,
  kind: ProfileKind,
  subRole?: string,
  name?: string,
): Promise<AnyProfile> {
  const existing = await loadProfile(userId);
  if (hasProfileData(existing)) return existing;
  try {
    if ((await AsyncStorage.getItem(SEEDED_KEY(userId))) === '1') return existing;
  } catch {
    /* fall through to seed */
  }
  const seed = mockProfileFor(kind, subRole, name);
  await saveProfile(userId, seed);
  AsyncStorage.setItem(SEEDED_KEY(userId), '1').catch(() => {});
  return seed;
}

// True once the user has filled in anything meaningful — used to nudge them and
// to decide whether to attach a profile block to a 911 call.
export function hasProfileData(p: AnyProfile): boolean {
  return Object.values(p).some((v) => (typeof v === 'string' ? v.trim().length > 0 : !!v));
}

// Compact, operator-facing summary appended to the 911 transcript. Only emits
// fields the caller actually filled, so a sparse profile stays terse.
export function summarizeCivilianForDispatch(p: CivilianProfile): string | null {
  const parts: string[] = [];
  const add = (label: string, v?: string) => {
    if (v && v.trim()) parts.push(`${label}: ${v.trim()}`);
  };
  add('DOB', p.dateOfBirth);
  add('Sex', p.sex);
  add('Blood type', p.bloodType);
  add('Allergies', p.allergies);
  add('Conditions', p.conditions);
  add('Medications', p.medications);
  add('Accessibility', p.accessibility);
  add('Primary language', p.primaryLanguage);
  if (p.organDonor) parts.push('Organ donor: yes');
  if (p.emergencyContactName && p.emergencyContactName.trim()) {
    const rel = p.emergencyContactRelation?.trim();
    const phone = p.emergencyContactPhone?.trim();
    parts.push(
      `Emergency contact: ${p.emergencyContactName.trim()}${rel ? ` (${rel})` : ''}${phone ? ` ${phone}` : ''}`,
    );
  }
  if (parts.length === 0) return null;
  return `Caller medical profile — ${parts.join('; ')}.`;
}

export function profileRoleKind(session: Session | null): 'civilian' | 'responder' | 'none' {
  if (!session) return 'none';
  if (session.role === 'citizen') return 'civilian';
  if (session.role === 'worker') return 'responder';
  return 'none'; // admins have no field profile
}

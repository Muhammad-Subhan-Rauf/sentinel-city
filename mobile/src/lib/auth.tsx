// Session/identity. No real login — user picks a hardcoded demo profile
// from the login screen and we persist it in AsyncStorage so the app
// remembers it between launches.

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Role } from './api';

export type Session = {
  role: Role;
  userId: string;   // 'citizen-1' | 'worker-2' | 'admin-1'
  name: string;
};

const STORAGE_KEY = 'sentinel.session.v1';

type Ctx = {
  session: Session | null;
  loading: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setSession(JSON.parse(raw));
      } catch {
        // First launch or corrupted entry — start signed out.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = async (s: Session) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    setSession(s);
  };

  const signOut = async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setSession(null);
  };

  return (
    <AuthCtx.Provider value={{ session, loading, signIn, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): Ctx {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// Hardcoded demo identities exposed on the login screen.
// IDs match the seed data in backend/main.py (MOBILE_CITIZENS / MOBILE_WORKERS).
export const DEMO_USERS: Array<{ role: Role; id: string; name: string; subtitle: string }> = [
  { role: 'citizen', id: 'citizen-1', name: 'Alex Rivera', subtitle: 'Resident · Midtown' },
  { role: 'citizen', id: 'citizen-2', name: 'Priya Shah', subtitle: 'Resident · Chelsea' },
  { role: 'citizen', id: 'citizen-3', name: 'Marcus Lee', subtitle: 'Resident · Upper East' },
  { role: 'worker', id: 'worker-1', name: 'Capt. Diaz', subtitle: 'Firefighter · Station 5' },
  { role: 'worker', id: 'worker-2', name: 'Lt. Patel', subtitle: 'Paramedic · EMS 14' },
  { role: 'worker', id: 'worker-3', name: 'Off. Brennan', subtitle: 'Police · Precinct 18' },
  { role: 'admin', id: 'admin-1', name: 'Operator: J. Quinn', subtitle: 'City Ops · Tier 1' },
];

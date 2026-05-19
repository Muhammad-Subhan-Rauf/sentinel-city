// Session/identity. Pattern-based PIN login: first==last digit of a 4-digit
// PIN identifies the role. Backend validates and upserts the user record.

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, type Role, type WorkerSubRole } from './api';

export type Session = {
  userId: string;
  role: Role;
  sub_role?: WorkerSubRole;
  name: string;
};

const SESSION_KEY = 'sentinel.session.v1';
const DEVICE_KEY = 'sentinel.device.v1';

function randomDeviceId(): string {
  // RFC4122-ish v4 fallback; good enough for an identity token.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${
    '89ab'[Math.floor(Math.random() * 4)]
  }${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

type Ctx = {
  session: Session | null;
  deviceId: string | null;
  loading: boolean;
  signIn: (pin: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        let storedDeviceId = await AsyncStorage.getItem(DEVICE_KEY);
        if (!storedDeviceId) {
          storedDeviceId = randomDeviceId();
          await AsyncStorage.setItem(DEVICE_KEY, storedDeviceId);
        }
        setDeviceId(storedDeviceId);

        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const isValidShape =
            parsed && typeof parsed === 'object' && parsed.userId && parsed.role;
          // Old demo-profile sessions (e.g. userId="citizen-1") are no longer
          // valid since the backend dropped the seeded roster — force re-login.
          const isLegacyDemoId =
            typeof parsed?.userId === 'string' &&
            /^(citizen|worker|admin)-\d+$/.test(parsed.userId);
          if (isValidShape && !isLegacyDemoId) {
            setSession(parsed as Session);
          } else {
            await AsyncStorage.removeItem(SESSION_KEY);
          }
        }
      } catch {
        // First launch — start signed out.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = async (pin: string) => {
    if (!deviceId) throw new Error('Device not ready');
    const res = await api.login(deviceId, pin);
    const newSession: Session = {
      userId: res.user_id,
      role: res.role,
      sub_role: res.sub_role,
      name: res.name,
    };
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    setSession(newSession);
  };

  const signOut = async () => {
    await AsyncStorage.removeItem(SESSION_KEY);
    setSession(null);
  };

  return (
    <AuthCtx.Provider value={{ session, deviceId, loading, signIn, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): Ctx {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

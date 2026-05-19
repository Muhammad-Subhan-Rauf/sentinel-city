// Top-level navigation. Renders one of:
//   - <LoginScreen/> when there is no session
//   - role-specific bottom-tab navigator when signed in
// A small "Sign out" header button is wired into every tab navigator.

import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '@/lib/auth';
import { colors, roleAccent } from '@/lib/colors';

import LoginScreen from '@/screens/LoginScreen';
import CitizenMapScreen from '@/screens/citizen/CitizenMapScreen';
import NotificationsScreen from '@/screens/citizen/NotificationsScreen';
import MockLocationScreen from '@/screens/citizen/MockLocationScreen';
import WorkerMapScreen from '@/screens/worker/WorkerMapScreen';
import AdminDispatchScreen from '@/screens/admin/AdminDispatchScreen';
import AdminAgentsScreen from '@/screens/admin/AdminAgentsScreen';
import AdminSavingsScreen from '@/screens/admin/AdminSavingsScreen';

const Tab = createBottomTabNavigator();

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    primary: colors.info,
    notification: colors.danger,
  },
};

function SignOutButton() {
  const { signOut, session } = useAuth();
  if (!session) return null;
  return (
    <Pressable onPress={signOut} style={styles.signOut} hitSlop={10}>
      <Text style={styles.signOutText}>Sign out</Text>
    </Pressable>
  );
}

function tabScreenOptions(activeColor: string) {
  return {
    tabBarActiveTintColor: activeColor,
    tabBarInactiveTintColor: colors.textMuted,
    tabBarStyle: {
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
    },
    headerStyle: { backgroundColor: colors.surface },
    headerTitleStyle: { color: colors.textPrimary, fontWeight: '700' as const },
    headerRight: () => <SignOutButton />,
  };
}

function emoji(name: string) {
  return () => <Text style={{ fontSize: 18 }}>{name}</Text>;
}

function CitizenTabs() {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions(colors.citizen)}>
      <Tab.Screen
        name="Map"
        component={CitizenMapScreen}
        options={{ tabBarIcon: emoji('🗺️') }}
      />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: emoji('🔔') }}
      />
      <Tab.Screen
        name="Location"
        component={MockLocationScreen}
        options={{ tabBarIcon: emoji('📍') }}
      />
    </Tab.Navigator>
  );
}

function WorkerTabs() {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions(colors.worker)}>
      <Tab.Screen
        name="Map"
        component={WorkerMapScreen}
        options={{ tabBarIcon: emoji('🚒') }}
      />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: emoji('🔔') }}
      />
    </Tab.Navigator>
  );
}

function AdminTabs() {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions(colors.admin)}>
      <Tab.Screen
        name="Dispatch"
        component={AdminDispatchScreen}
        options={{ tabBarIcon: emoji('🚨') }}
      />
      <Tab.Screen
        name="Agents"
        component={AdminAgentsScreen}
        options={{ tabBarIcon: emoji('🤖') }}
      />
      <Tab.Screen
        name="Impact"
        component={AdminSavingsScreen}
        options={{ tabBarIcon: emoji('📈') }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const { session, loading } = useAuth();

  if (loading) return null;

  return (
    <NavigationContainer theme={navTheme}>
      {!session ? (
        <LoginScreen />
      ) : session.role === 'citizen' ? (
        <CitizenTabs />
      ) : session.role === 'worker' ? (
        <WorkerTabs />
      ) : (
        <AdminTabs />
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  signOut: {
    marginRight: 14,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    borderColor: colors.border,
    borderWidth: 1,
  },
  signOutText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
});

// Top-level navigation. Renders one of:
//   - <LoginScreen/> when there is no session
//   - role-specific bottom-tab navigator when signed in
// A small "Sign out" header button is wired into every tab navigator.

import React from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '@/lib/auth';
import { useGeofenceWatcher } from '@/lib/geofence';
import { colors } from '@/lib/colors';
import { InAppBanner } from '@/components/InAppBanner';

import LoginScreen from '@/screens/LoginScreen';
import CitizenMapScreen from '@/screens/citizen/CitizenMapScreen';
import NotificationsScreen from '@/screens/citizen/NotificationsScreen';
import SettingsScreen from '@/screens/SettingsScreen';
import WorkerMapScreen from '@/screens/worker/WorkerMapScreen';
import WorkerCallLogsScreen from '@/screens/worker/WorkerCallLogsScreen';
import AdminDispatchScreen from '@/screens/admin/AdminDispatchScreen';
import AdminCallsScreen from '@/screens/admin/AdminCallsScreen';
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
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: emoji('⚙️') }}
      />
    </Tab.Navigator>
  );
}

function WorkerTabs() {
  // All worker sub-roles (police / firefighter / paramedic) get a Calls tab
  // that lists only the 911 calls whose requested_services includes their
  // service. The screen filters server-side.
  const { session } = useAuth();
  const mapIcon =
    session?.sub_role === 'paramedic' ? '🚑' : session?.sub_role === 'police' ? '🚓' : '🚒';
  return (
    <Tab.Navigator screenOptions={tabScreenOptions(colors.worker)}>
      <Tab.Screen
        name="Map"
        component={WorkerMapScreen}
        options={{ tabBarIcon: emoji(mapIcon) }}
      />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: emoji('🔔') }}
      />
      <Tab.Screen
        name="Calls"
        component={WorkerCallLogsScreen}
        options={{ tabBarIcon: emoji('📞') }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: emoji('⚙️') }}
      />
    </Tab.Navigator>
  );
}

function AdminTabs() {
  return (
    <Tab.Navigator
      screenOptions={{ ...tabScreenOptions(colors.admin), tabBarShowLabel: false }}
    >
      <Tab.Screen
        name="Dispatch"
        component={AdminDispatchScreen}
        options={{ tabBarIcon: emoji('🚨') }}
      />
      <Tab.Screen
        name="Calls"
        component={AdminCallsScreen}
        options={{ tabBarIcon: emoji('📞') }}
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
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: emoji('🔔') }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: emoji('⚙️') }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const { session, loading } = useAuth();
  const { toasts, dismiss } = useGeofenceWatcher(session);

  if (loading) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
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
      <InAppBanner toasts={toasts} onDismiss={dismiss} />
    </View>
  );
}

const styles = StyleSheet.create({});

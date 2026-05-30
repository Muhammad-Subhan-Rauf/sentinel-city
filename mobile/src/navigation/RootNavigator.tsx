// Top-level navigation. Renders <LoginScreen/> when signed out, otherwise a
// role-specific bottom-tab navigator. Tabs use vector icons (filled when active,
// outline when inactive), the active tint is the role accent, and the whole
// NavigationContainer is themed light/dark to match the app.

import React from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator, BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';
import { View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { useGeofenceWatcher } from '@/lib/geofence';
import { useTheme } from '@/theme';
import { Icon, IconName } from '@/components/ui';
import { InAppBanner } from '@/components/InAppBanner';
import { CitizenTabBar } from '@/navigation/CitizenTabBar';

import LoginScreen from '@/screens/LoginScreen';
import CitizenMapScreen from '@/screens/citizen/CitizenMapScreen';
import CitizenSosScreen from '@/screens/citizen/CitizenSosScreen';
import CitizenHistoryScreen from '@/screens/citizen/CitizenHistoryScreen';
import NotificationsScreen from '@/screens/citizen/NotificationsScreen';
import SettingsScreen from '@/screens/SettingsScreen';
import WorkerMapScreen from '@/screens/worker/WorkerMapScreen';
import WorkerCallLogsScreen from '@/screens/worker/WorkerCallLogsScreen';
import AdminDispatchScreen from '@/screens/admin/AdminDispatchScreen';
import AdminCallsScreen from '@/screens/admin/AdminCallsScreen';
import AdminAgentsScreen from '@/screens/admin/AdminAgentsScreen';
import AdminSavingsScreen from '@/screens/admin/AdminSavingsScreen';

const Tab = createBottomTabNavigator();

// Builds a tabBarIcon that swaps filled/outline by focus state.
function tabIcon(base: string) {
  return ({ focused, color }: { focused: boolean; color: string }) => (
    <Icon name={(focused ? base : `${base}-outline`) as IconName} size={24} color={color} />
  );
}

function useTabScreenOptions(activeColor: string): BottomTabNavigationOptions {
  const t = useTheme();
  return {
    tabBarActiveTintColor: activeColor,
    tabBarInactiveTintColor: t.color.textMuted,
    tabBarStyle: {
      backgroundColor: t.color.surface,
      borderTopColor: t.color.border,
      borderTopWidth: 1,
      height: 64,
      paddingTop: 6,
      paddingBottom: 10,
    },
    tabBarLabelStyle: { fontFamily: t.fonts.bold, fontSize: 11, letterSpacing: 0.2 },
    tabBarItemStyle: { paddingTop: 2 },
    headerStyle: { backgroundColor: t.color.bg, borderBottomColor: t.color.border, borderBottomWidth: 1, shadowColor: 'transparent' },
    headerTitleStyle: { fontFamily: t.fonts.bold, fontSize: 18, color: t.color.textPrimary },
    headerTintColor: t.color.textPrimary,
    headerShadowVisible: false,
  };
}

function CitizenTabs() {
  const t = useTheme();
  // Custom bar renders a raised red "911" call-for-help button in the centre.
  // The SOS screen is registered here but hidden from the default item list —
  // the centre button is its entry point.
  return (
    <Tab.Navigator
      screenOptions={useTabScreenOptions(t.color.citizen)}
      tabBar={(props) => <CitizenTabBar {...props} />}
    >
      <Tab.Screen name="Map" component={CitizenMapScreen} options={{ tabBarIcon: tabIcon('map'), headerShown: false }} />
      <Tab.Screen name="Alerts" component={NotificationsScreen} options={{ tabBarIcon: tabIcon('alerts') }} />
      <Tab.Screen name="SOS" component={CitizenSosScreen} options={{ title: 'Get help', headerShown: false }} />
      <Tab.Screen name="History" component={CitizenHistoryScreen} options={{ tabBarIcon: tabIcon('history') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: tabIcon('settings') }} />
    </Tab.Navigator>
  );
}

function WorkerTabs() {
  const t = useTheme();
  return (
    <Tab.Navigator screenOptions={useTabScreenOptions(t.color.worker)}>
      <Tab.Screen name="Map" component={WorkerMapScreen} options={{ tabBarIcon: tabIcon('map'), headerShown: false }} />
      <Tab.Screen name="Alerts" component={NotificationsScreen} options={{ tabBarIcon: tabIcon('alerts') }} />
      <Tab.Screen name="Calls" component={WorkerCallLogsScreen} options={{ tabBarIcon: tabIcon('calls') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: tabIcon('settings') }} />
    </Tab.Navigator>
  );
}

function AdminTabs() {
  const t = useTheme();
  // Six destinations (incl. Settings, which holds sign-out) is one above the
  // ideal bottom-nav max, so admin tabs go icon-only to keep them comfortably
  // tappable. Admins are power users who learn the glyphs quickly.
  return (
    <Tab.Navigator screenOptions={{ ...useTabScreenOptions(t.color.admin), tabBarShowLabel: false }}>
      <Tab.Screen name="Dispatch" component={AdminDispatchScreen} options={{ tabBarIcon: tabIcon('megaphone') }} />
      <Tab.Screen name="Calls" component={AdminCallsScreen} options={{ tabBarIcon: tabIcon('calls') }} />
      <Tab.Screen name="Agents" component={AdminAgentsScreen} options={{ tabBarIcon: tabIcon('agents') }} />
      <Tab.Screen name="Impact" component={AdminSavingsScreen} options={{ tabBarIcon: tabIcon('impact') }} />
      <Tab.Screen name="Alerts" component={NotificationsScreen} options={{ tabBarIcon: tabIcon('alerts') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: tabIcon('settings') }} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const t = useTheme();
  const { session, loading } = useAuth();
  const { toasts, dismiss } = useGeofenceWatcher(session);

  if (loading) return null;

  const navTheme = {
    ...(t.scheme === 'light' ? DefaultTheme : DarkTheme),
    colors: {
      ...(t.scheme === 'light' ? DefaultTheme : DarkTheme).colors,
      background: t.color.bg,
      card: t.color.surface,
      text: t.color.textPrimary,
      border: t.color.border,
      primary: t.color.primary,
      notification: t.color.danger,
    },
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
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

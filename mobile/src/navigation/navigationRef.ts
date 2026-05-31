// Navigation ref so code rendered OUTSIDE the navigator tree (e.g. the global
// Sos911Launcher overlay) can still navigate — used to route the caller to the
// live map after help is dispatched. Kept in its own module to avoid an import
// cycle with RootNavigator.

import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

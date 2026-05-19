# Sentinel-City Mobile (Expo)

Cross-platform companion app for the Sentinel-City web operator console. Built with **Expo SDK 52 + React Native + TypeScript + react-native-maps + React Navigation**.

## Three role-based interfaces

| Role | Screens | Notes |
|------|---------|-------|
| **Citizen** | Map · Notifications · Mock Location | Google-Maps-style map with auto-rerouting around active hazard polygons (Valhalla). Cannot see other citizens. Own location highlighted with a blue ring. |
| **Emergency Worker** | Map · Notifications | Sees citizens + other workers + active hazards. Own location in red. Cycle status (available → dispatched → on_scene). |
| **Admin** | Dispatch · Agents · Impact | Live worker roster, mock AI agent registry, and Lives/Infrastructure/Money tiles with AI-generated insight modals. |

All three role views poll the shared FastAPI backend at `/api/citizens`, `/api/workers`, `/api/notifications`, `/api/cordons`, `/api/agents`, `/api/savings-summary`.

## First run

```bash
cd mobile
npm install
npm start          # Expo dev server (QR code for Expo Go)
npm run ios        # iOS simulator (requires Xcode)
npm run android    # Android emulator (requires Android Studio)
npm run web        # Browser preview
```

The first `npm install` will be slow because it pulls native iOS/Android peer deps. After that it's instant.

## Configuration

The backend URL is read from `app.json → expo.extra.backendUrl` (defaults to `http://localhost:8000`). On a phone, replace `localhost` with your machine's LAN IP so the device can reach the FastAPI server:

```bash
EXPO_PUBLIC_BACKEND_URL=http://192.168.1.42:8000 \
EXPO_PUBLIC_VALHALLA_URL=http://192.168.1.42:8002 \
npm start
```

Or edit `app.json` directly.

## Mock login

There is no real auth (matches the web app's no-auth mode). The login screen lists 7 hardcoded demo profiles:

- **3 citizens** — Alex Rivera, Priya Shah, Marcus Lee
- **3 workers** — Capt. Diaz (firefighter), Lt. Patel (paramedic), Off. Brennan (police)
- **1 admin** — Operator J. Quinn

Pick any profile to enter. The session persists across launches via AsyncStorage. Tap "Sign out" in the header to return to the login screen.

The 5 citizen and 3 worker profiles are seeded server-side in `backend/main.py` (`MOBILE_CITIZENS` / `MOBILE_WORKERS`) so they reset on backend restart. The web operator can see them on the map immediately — they appear with a **cyan ring (citizens)** or **hot-pink ring (workers)** so they stand out from the simulated citizens.

## How the citizen rerouting works

1. Citizen taps the map to set a destination.
2. App calls Valhalla's `/route` endpoint with the current set of active notification + cordon polygons as `avoid_polygons`.
3. Every 5s, the app re-checks the hazard set. If any polygon was added or removed, it re-runs the route. The route line updates seamlessly.
4. The visualization on screen always shows the most recent safe path.

## Web integration

The web `MapView` was updated to render mobile users as well. Look for the **cyan-ringed dots (citizens)** and **hot-pink ringed dots (workers)** on the operator map — those are the mobile-app users in real time. Tooltips show name and status.

## Where AI plugs in later

Three integration points have explicit hooks:

- `backend/main.py` → `MOCK_AGENTS` list. Replace each entry with live model status.
- `backend/main.py` → `_SAVINGS_INSIGHTS` dict. Replace pre-written narratives with model-generated text.
- `backend/main.py` → `_tick_savings()` function. Replace synthetic counters with aggregates from the prediction agent.

## Project layout

```
mobile/
├── App.tsx                       # Provider tree
├── index.ts                      # registerRootComponent
├── app.json                      # Expo config (incl. backend URL)
├── package.json
├── tsconfig.json
├── babel.config.js
└── src/
    ├── lib/
    │   ├── api.ts                # FastAPI client + Valhalla routing
    │   ├── auth.tsx              # Session context + demo users
    │   ├── colors.ts             # Design tokens
    │   ├── geo.ts                # Haversine, centroid helpers
    │   ├── disasterMeta.ts       # Disaster-type colour/icon registry
    │   └── nominatim.ts          # OSM address autocomplete
    ├── components/
    │   ├── DisasterMap.tsx       # Shared map (citizen + worker)
    │   ├── Screen.tsx            # SafeArea + title wrapper
    │   └── StatCard.tsx          # Admin stat tile
    ├── navigation/
    │   └── RootNavigator.tsx     # Role-aware tab navigator
    └── screens/
        ├── LoginScreen.tsx
        ├── citizen/
        │   ├── CitizenMapScreen.tsx
        │   ├── NotificationsScreen.tsx   # shared by worker
        │   └── MockLocationScreen.tsx
        ├── worker/
        │   └── WorkerMapScreen.tsx
        └── admin/
            ├── AdminDispatchScreen.tsx
            ├── AdminAgentsScreen.tsx
            └── AdminSavingsScreen.tsx
```

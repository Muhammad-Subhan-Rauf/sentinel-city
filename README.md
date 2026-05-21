# Sentinel-City

Agentic disaster-response platform. Operators draw zones and trigger events from a web dashboard; an AI orchestrator detects, declares, cordons, and dispatches; citizens and responders see the AI's reasoning and act on it from a mobile app.

```
sentinel-city/
├── backend/    FastAPI + PostgreSQL + LangGraph (Vertex AI Gemini)
├── frontend/   React + Vite + Leaflet operator dashboard
├── mobile/     Expo + React Native (citizen / worker / admin)
├── db/         Postgres init + numbered migrations
└── docker-compose.yml
```

---

## What it does

- **Operator dashboard** ([frontend/](frontend/)) — draw geometry, trigger disasters, watch the AI's log stream, dispatch units manually, manage stations.
- **AI orchestrator** ([backend/orchestrator.py](backend/orchestrator.py)) — two LangGraph ReAct agents on Vertex AI Gemini:
  - *Detection Loop* — ingests citizen reports / weather / traffic, triangulates, declares incidents.
  - *Monitoring Loop* — ranks nearest resources, dispatches fire/EMS/police, cordons no-entry zones, publishes citizen alerts, clears resolved events.
  - Tool surface in [backend/agent_tools.py](backend/agent_tools.py); all writes go through [backend/api_client.py](backend/api_client.py) which stamps `source='ai'` so the mobile app can filter operator vs AI traffic.
- **Mobile app** ([mobile/](mobile/)) — three roles:
  - *Citizen* — AI-warned of nearby hazards, walking routes that avoid them, 911 calling from inside a zone.
  - *Worker* (firefighter / paramedic / police) — driving routes around hazards, dispatch acknowledgment, call queue filtered by service.
  - *Admin* — citywide oversight feed, dispatch + agents + savings telemetry.
- **Backend** ([backend/main.py](backend/main.py)) — system of record. Disasters, citizen reports, responder field reports, 911 calls, fire/hospital/police stations, simulated weather + traffic that react to active events, savings metrics, audit logs.

---

## Mobile warnings: AI-only

The mobile app consumes **`GET /api/warnings/nearby?lat=&lng=&radius_m=`** ([backend/main.py:2096](backend/main.py)) — a unified, AI-only nearby-warning feed aggregating five sources, server-filtered to `source='ai'` and proximity-trimmed:

| Source              | AI tool                  | Surfaces as `kind` |
| ------------------- | ------------------------ | ------------------ |
| `notifications`     | `publish_citizen_alert`  | `alert`            |
| `cordons`           | `create_cordon`          | `cordon`           |
| `disaster_events`   | `declare_incident`       | `disaster`         |
| `active_dispatches` | `dispatch_units`         | `dispatch`         |
| weather alerts      | weather watcher          | `weather`          |

Operator-drawn dashboard entries are hidden from mobile. Omitting `lat`/`lng` returns the citywide admin feed.

---

## Run locally with Docker

```bash
docker compose up --build
# Dashboard → http://localhost:5173
# Backend   → http://localhost:8000  (Swagger at /docs)
# Postgres  → localhost:5432  (sentinel / sentinel)
```

`backend/.env` needs `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` for Vertex AI; the service-account JSON mounts from `backend/vertex-sa.json`. See [backend/Dockerfile](backend/Dockerfile) and [docker-compose.yml](docker-compose.yml).

---

## Run pieces individually

### Backend

```bash
cd backend
python -m venv venv && venv\Scripts\activate    # Windows
pip install -r requirements.txt
# DATABASE_URL must point at a Postgres instance (e.g. docker compose up db)
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev    # → http://localhost:5173
```

### Mobile

```bash
cd mobile
npm install
# Dev — Metro + Expo Go
npm run start
# Production APK build (see also mobile/eas.json for cloud builds)
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# → mobile/android/app/build/outputs/apk/release/app-release.apk
```

Configure backend URL for the APK via `EXPO_PUBLIC_BACKEND_URL`. The current build points at the deployed Cloud Run instance.

---

## Database

Schema is bootstrapped by [db/init.sql](db/init.sql) plus the numbered migration files in [db/](db/). [backend/main.py](backend/main.py) lifespan also self-heals the schema via idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` calls — adding a column means appending one statement there, no migration runner needed.

Key tables: `disaster_events`, `notifications`, `cordons`, `active_dispatches`, `citizen_reports`, `responder_reports`, `fire_stations`, `hospitals`, `police_stations`, `emergency_calls`, `audit_logs`.

---

## Tech stack

| Layer       | Stack                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Backend     | FastAPI, Uvicorn, psycopg2, Pydantic v2, LangGraph, Vertex AI (Gemini 2.x)            |
| Dashboard   | React 18, Vite, Tailwind, react-leaflet, leaflet-geoman-free                          |
| Mobile      | React Native 0.76, Expo SDK 52, react-native-webview (Leaflet inside), expo-location |
| Routing     | Stadia Maps hosted Valhalla (`avoid_polygons` for hazard-aware routes)                |
| Database    | PostgreSQL 16 (JSONB geometry; no PostGIS dependency)                                 |
| Container   | Docker Compose for local; backend deploys to Cloud Run                                |

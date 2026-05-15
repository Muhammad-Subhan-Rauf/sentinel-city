# 🛡️ Sentinel-City

> **Agentic Disaster Orchestration Platform** — Built for high-stakes hackathon competition.

A full-stack platform that lets operators draw geospatial zones on a live map and trigger AI-orchestrated disaster response workflows, secured end-to-end with Supabase JWT authentication.

---

## 🏗️ Architecture

```
sentinel-city/
├── frontend/   # React + Vite + Tailwind CSS + react-leaflet + Geoman
└── backend/    # Python + FastAPI + Supabase + PyJWT
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Python 3.11+
- A [Supabase](https://supabase.com) project with:
  - A `disaster_events` table (columns: `id`, `triggered_by`, `disaster_type`, `severity`, `area_geometry`, `notes`, `status`, `created_at`)
  - Email auth enabled

---

### 1. Backend

```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt

# Copy and fill in your Supabase keys
cp .env.example .env

uvicorn main:app --reload
# → http://localhost:8000
# → http://localhost:8000/docs  (Swagger UI)
```

### 2. Frontend

```bash
cd frontend

# Copy and fill in your Supabase keys
cp .env.example .env

npm install
npm run dev
# → http://localhost:5173
```

---

## 🔑 Environment Variables

### `backend/.env`
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Service role key (bypasses RLS for admin writes) |
| `SUPABASE_JWT_SECRET` | JWT secret for verifying user tokens |

### `frontend/.env`
| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key (safe for client-side) |
| `VITE_BACKEND_URL` | Backend URL (default: `http://localhost:8000`) |

---

## 🗺️ Supabase Table Schema

```sql
create table disaster_events (
  id            uuid primary key default gen_random_uuid(),
  triggered_by  uuid references auth.users(id),
  disaster_type text not null,
  severity      int  not null check (severity between 1 and 10),
  area_geometry jsonb,
  notes         text,
  status        text default 'active',
  created_at    timestamptz default now()
);

-- Enable RLS
alter table disaster_events enable row level security;

-- Backend service key bypasses RLS automatically
```

---

## 🤖 AI Agent Integration

Look for the `[ANTIGRAVITY AI TRIGGER POINT]` comment block in `backend/main.py`. This is where agent logic plugs in after the event is validated and before it's written to the database.

---

## 🔒 Security Model

- Frontend uses the **anon key** — safe for public exposure; RLS controls data access
- Backend uses the **service role key** — never exposed to client, only used server-side
- Every request to the backend is verified against the **JWT secret** before any DB write

---

## 📦 Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, react-leaflet, leaflet-geoman-free, @supabase/supabase-js, h3-js |
| Backend | FastAPI, Uvicorn, Supabase Python SDK, PyJWT, Pydantic v2, python-dotenv |
| Database | Supabase (PostgreSQL + PostGIS) |
| Auth | Supabase Auth (JWT, email/password) |

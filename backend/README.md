# Sentinel-City AI Orchestrator

This directory contains the AI Orchestrator for the Sentinel-City project. The orchestrator is a purely signal-driven, multi-agent AI system powered by Gemini 2.5 Flash. It continuously observes city APIs (weather, traffic, citizen reports), reasons about them to detect incidents, and coordinates emergency responses without any hard-coded rules or direct connection to the frontend dashboard.

## Architecture

The orchestrator runs as a standalone Python process (`orchestrator.py`) alongside the FastAPI backend. It interacts exclusively with the backend REST APIs.

*   **Signals**: Obtains data from `GET /api/weather`, `GET /api/traffic`, `GET /api/citizen-reports`, etc.
*   **Reasoning**: Passes signals to Gemini via structured prompts (`prompts/`). Gemini uses function calling to interact with the city.
*   **Actions**: Executes Gemini's tool calls (e.g., `POST /api/trigger-disaster`, `POST /api/dispatch`, `POST /api/cordons`).

### Components

*   **`orchestrator.py`**: Main entry point containing the two async loops:
    *   **Loop A (Detection)**: Polls APIs, looks for clusters/patterns, declares new incidents.
    *   **Loop B (Monitoring)**: Spawned per active incident to track trajectory, scale response, and eventually clear the incident.
*   **`api_client.py`**: Async `httpx` client wrapping all backend endpoints with retry logic.
*   **`tools.py`**: Gemini function-calling schemas and execution logic.
*   **`state.py`**: In-memory state tracking for incidents and agent posture.
*   **`audit.py`**: Structured JSONL decision logging to `logs/`.
*   **`prompts/`**: Identity and judgment guidance for Gemini (not rules).

## Setup & Running

The orchestrator is automatically run as the 5th service in `docker-compose.yml`.

To run manually:

1.  Ensure the backend is running (`uvicorn main:app` or via Docker).
2.  Set `GEMINI_API_KEY` in your `.env`.
3.  Install dependencies: `pip install -r requirements.txt`
4.  Run: `python orchestrator.py`

## Features

*   **Triangulation**: Fuses locations from multiple sources (citizens, sensors) with confidence weighting.
*   **Credibility Scoring**: Authority > sensors > clustered citizens > single citizen.
*   **Prank Filtering**: Identifies and ignores spoofed/prank 911 calls.
*   **Dynamic Traffic**: The traffic API dynamically reflects stopped/congested flow based on active disasters and cordons.
*   **Auditability**: Every decision, tool call, and signal observation is logged in `logs/orchestrator_*.jsonl`.

## Testing & Baseline

*   **Stress Tests**: Run `python -m pytest tests/test_stress_scenarios.py` to test the AI's handling of false alarms, pranks, multi-crisis competition, etc.
*   **Baseline Comparison**: See `baseline/` for a hard-coded rule engine to compare AI metrics against.

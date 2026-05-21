"""
Async HTTP client for Sentinel-City Backend endpoints.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

class SentinelAPIClient:
    """Async client for Sentinel-City AI Orchestrator."""

    def __init__(self, base_url: str = "https://sentinel-backend-228162497559.me-central1.run.app"):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=10.0)

    async def close(self) -> None:
        """Close the HTTP client."""
        await self.client.aclose()

    async def _request(self, method: str, endpoint: str, retries: int = 3, **kwargs) -> Any:
        """Helper to make HTTP requests with simple exponential backoff retry logic."""
        url = endpoint
        for attempt in range(retries):
            try:
                response = await self.client.request(method, url, **kwargs)
                response.raise_for_status()
                # If there's content, return parsed JSON
                if response.content:
                    return response.json()
                return None
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error {e.response.status_code} for {method} {url}")
                if attempt == retries - 1:
                    raise
            except httpx.RequestError as e:
                logger.warning(f"Request error on {method} {url}: {e}. Attempt {attempt + 1}/{retries}")
                if attempt == retries - 1:
                    raise
            # Exponential backoff
            await asyncio.sleep(2 ** attempt)

    # --- Signal Readers ---

    async def get_disasters(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/disasters")

    async def get_weather(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/weather")

    async def get_weather_regions(self) -> Dict[str, Any]:
        return await self._request("GET", "/api/weather/regions")

    async def get_traffic(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/traffic")

    async def get_citizen_reports(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/citizen-reports")

    async def get_responder_reports(self, status: str = "pending") -> Dict[str, Any]:
        """Pull responder field reports (casualty + fire_sighted corrections).

        Defaults to status='pending' so the AI's monitoring context only
        surfaces work still requiring action.
        """
        return await self._request("GET", f"/api/responder-reports?status={status}")

    async def get_nearest_resources(
        self, lat: float, lng: float, kind: str = "fire_station", limit: int = 3,
    ) -> Dict[str, Any]:
        """Server-ranked nearest stations (hospital/fire_station/police_station)
        with available capacity. Used by the orchestrator to spare the AI from
        haversine arithmetic."""
        return await self._request(
            "GET",
            f"/api/nearest-resources?lat={lat}&lng={lng}&kind={kind}&limit={limit}",
        )

    async def resolve_responder_reports_near(
        self, lat: float, lng: float, radius_m: float = 100.0,
        report_kind_prefix: str = "casualty_",
    ) -> Dict[str, Any]:
        """Mark pending responder reports within radius of (lat, lng) as resolved.

        Called by agent_tools after a successful ambulance dispatch so the AI
        doesn't see the same casualty twice.
        """
        return await self._request(
            "POST",
            "/api/responder-reports/resolve-near",
            params={"lat": lat, "lng": lng, "radius_m": radius_m,
                    "report_kind_prefix": report_kind_prefix},
        )

    async def get_fire_stations(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/fire-stations")

    async def get_hospitals(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/hospitals")

    async def get_police_stations(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/police-stations")

    async def get_notifications(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/notifications")

    async def get_cordons(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/cordons")

    # --- Actions ---

    async def trigger_disaster(self, data: Dict[str, Any]) -> Dict[str, Any]:
        # This client is the AI orchestrator's voice into the public API.
        # Every disaster declared via here is by definition AI-originated, so
        # stamp source='ai' for /api/warnings/nearby to pick it up. Callers
        # that pre-set 'source' (rare) win.
        payload = {"source": "ai", **data}
        return await self._request("POST", "/api/trigger-disaster", json=payload)

    async def update_disaster(self, disaster_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request("PATCH", f"/api/disasters/{disaster_id}", json=data)

    async def delete_disaster(self, disaster_id: str) -> Any:
        return await self._request("DELETE", f"/api/disasters/{disaster_id}")

    async def notify(self, data: Dict[str, Any]) -> Dict[str, Any]:
        payload = {"source": "ai", **data}
        return await self._request("POST", "/api/notify", json=payload)

    async def cordon(self, data: Dict[str, Any]) -> Dict[str, Any]:
        payload = {"source": "ai", **data}
        return await self._request("POST", "/api/cordons", json=payload)

    async def dispatch(self, data: Dict[str, Any]) -> Dict[str, Any]:
        payload = {"source": "ai", **data}
        return await self._request("POST", "/api/dispatch", json=payload)

    async def dispatch_ack(self, dispatch_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        unit_type = data.get("unit_type")
        station_id = data.get("station_id")
        units = data.get("count", 1)
        if unit_type in ("firefighter", "fire"):
            endpoint = f"/api/fire-stations/{station_id}/dispatch_ack"
        elif unit_type in ("ambulance", "medical"):
            endpoint = f"/api/hospitals/{station_id}/dispatch_ack"
        elif unit_type in ("police", "security"):
            endpoint = f"/api/police-stations/{station_id}/dispatch_ack"
        else:
            raise ValueError(f"Unknown unit_type: {unit_type}")
        return await self._request("POST", endpoint, json={"units": units})

    async def return_ack(self, dispatch_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        unit_type = data.get("unit_type")
        station_id = data.get("station_id")
        units = data.get("count", 1)
        if unit_type in ("firefighter", "fire"):
            endpoint = f"/api/fire-stations/{station_id}/return_ack"
        elif unit_type in ("ambulance", "medical"):
            endpoint = f"/api/hospitals/{station_id}/return_ack"
        elif unit_type in ("police", "security"):
            endpoint = f"/api/police-stations/{station_id}/return_ack"
        else:
            raise ValueError(f"Unknown unit_type: {unit_type}")
        return await self._request("POST", endpoint, json={"units": units})

    async def update_agent(self, agent_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request("PATCH", f"/api/agents/{agent_id}", json=data)

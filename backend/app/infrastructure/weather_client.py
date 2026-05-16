import httpx
from typing import Optional
from app.core.config import settings
from app.domain.weather_models import CurrentWeather

class OpenMeteoClient:
    @classmethod
    async def get_current_weather(cls, latitude: float, longitude: float) -> Optional[CurrentWeather]:
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "current": "temperature_2m,precipitation,wind_speed_10m,weather_code"
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                response = await client.get(settings.OPEN_METEO_URL, params=params)
                if response.status_code == 200:
                    data = response.json()
                    current = data.get("current", {})
                    return CurrentWeather(
                        temperature_c=float(current.get("temperature_2m", 0.0)),
                        precipitation_mm_h=float(current.get("precipitation", 0.0)),
                        wind_speed_kmh=float(current.get("wind_speed_10m", 0.0)),
                        weather_code=int(current.get("weather_code", 0))
                    )
                else:
                    print(f"[OpenMeteoClient] API returned status {response.status_code}")
                    return None
            except Exception as e:
                print(f"[OpenMeteoClient] HTTP Request failed: {e}")
                return None

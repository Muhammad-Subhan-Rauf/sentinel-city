from typing import Optional, List
from app.core.config import settings
from app.domain.weather_models import WeatherSummaryResponse, HazardAlert, CurrentWeather
from app.infrastructure.weather_client import OpenMeteoClient
from app.infrastructure.database import DisasterRepository

class WeatherOrchestratorService:
    @classmethod
    async def get_weather_disaster_report(
        cls, latitude: Optional[float] = None, longitude: Optional[float] = None
    ) -> WeatherSummaryResponse:
        # Apply robust defaults if parameters are missing
        lat = latitude if latitude is not None else settings.DEFAULT_LATITUDE
        lon = longitude if longitude is not None else settings.DEFAULT_LONGITUDE

        # Fetch telemetry and database events
        current_weather: Optional[CurrentWeather] = await OpenMeteoClient.get_current_weather(lat, lon)
        internal_events = DisasterRepository.get_active_weather_disasters()

        alerts: List[HazardAlert] = []

        # 1. Evaluate Sensor Telemetry against Hazard Thresholds
        if current_weather:
            if current_weather.temperature_c >= settings.HEATWAVE_TEMP_C:
                alerts.append(
                    HazardAlert(
                        hazard_type="Heatwave",
                        severity=8,
                        description=f"Severe heatwave conditions detected: {current_weather.temperature_c}°C.",
                        source="Open-Meteo Sensor"
                    )
                )
            elif current_weather.temperature_c <= settings.FREEZING_TEMP_C:
                alerts.append(
                    HazardAlert(
                        hazard_type="Extreme Cold / Freeze",
                        severity=7,
                        description=f"Sub-zero freezing temperatures detected: {current_weather.temperature_c}°C.",
                        source="Open-Meteo Sensor"
                    )
                )

            if current_weather.precipitation_mm_h >= settings.FLOOD_PRECIP_MM_H:
                alerts.append(
                    HazardAlert(
                        hazard_type="Flood",
                        severity=9,
                        description=f"Heavy rainfall ({current_weather.precipitation_mm_h} mm/h) indicating high flash flood risk.",
                        source="Open-Meteo Sensor"
                    )
                )

            if current_weather.wind_speed_kmh >= settings.STORM_WIND_KMH:
                alerts.append(
                    HazardAlert(
                        hazard_type="Storm / High Wind",
                        severity=8,
                        description=f"Severe wind speeds detected: {current_weather.wind_speed_kmh} km/h.",
                        source="Open-Meteo Sensor"
                    )
                )

        # 2. Add Operator-Reported Internal Database Events
        for event in internal_events:
            alerts.append(
                HazardAlert(
                    hazard_type=event.disaster_type,
                    severity=event.severity,
                    description=event.notes if event.notes else f"Active municipal {event.disaster_type} emergency.",
                    source="Municipal Operator"
                )
            )

        # 3. Determine Overall Safety Status
        total_hazards = len(alerts)
        if total_hazards == 0:
            status = "Safe"
        else:
            max_severity = max(a.severity for a in alerts)
            status = "Critical" if max_severity >= 7 else "Warning"

        return WeatherSummaryResponse(
            latitude=lat,
            longitude=lon,
            status=status,
            total_hazards=total_hazards,
            current_weather=current_weather,
            active_alerts=alerts,
            internal_disaster_events=internal_events
        )

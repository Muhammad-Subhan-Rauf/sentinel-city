from pydantic import BaseModel, Field
from typing import List, Optional, Any, Dict
from datetime import datetime

class HazardAlert(BaseModel):
    hazard_type: str = Field(..., description="Type of weather hazard e.g., Flood, Heatwave, Storm")
    severity: int = Field(..., ge=1, le=10, description="Hazard severity level from 1 to 10")
    description: str = Field(..., description="Human-readable description of the alert")
    source: str = Field(..., description="Origin of alert (e.g., Open-Meteo Sensor telemetry, Municipal Operator)")
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")

class InternalDisasterEvent(BaseModel):
    id: str
    disaster_type: str
    severity: int
    notes: Optional[str] = None
    status: str
    created_at: str

class CurrentWeather(BaseModel):
    temperature_c: float = Field(..., description="Current temperature in Celsius")
    precipitation_mm_h: float = Field(..., description="Current precipitation rate in mm/h")
    wind_speed_kmh: float = Field(..., description="Current wind speed in km/h")
    weather_code: int = Field(..., description="WMO weather interpretation code")

class WeatherSummaryResponse(BaseModel):
    latitude: float
    longitude: float
    status: str = Field(..., description="Overall location safety status: Safe, Warning, Critical")
    total_hazards: int = Field(0, description="Total active weather hazards detected")
    current_weather: Optional[CurrentWeather] = None
    active_alerts: List[HazardAlert] = []
    internal_disaster_events: List[InternalDisasterEvent] = []

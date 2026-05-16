import os
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

class Settings:
    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres")
    DB_POOL_MIN_CONN: int = int(os.getenv("DB_POOL_MIN_CONN", "1"))
    DB_POOL_MAX_CONN: int = int(os.getenv("DB_POOL_MAX_CONN", "10"))

    # External APIs
    OPEN_METEO_URL: str = os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")

    # Geocoding Defaults (Berlin Center - matching frontend placeholder)
    DEFAULT_LATITUDE: float = float(os.getenv("DEFAULT_LATITUDE", "52.5200"))
    DEFAULT_LONGITUDE: float = float(os.getenv("DEFAULT_LONGITUDE", "13.4050"))

    # Hazard & Risk Evaluation Thresholds
    HEATWAVE_TEMP_C: float = float(os.getenv("HEATWAVE_TEMP_C", "35.0"))
    FREEZING_TEMP_C: float = float(os.getenv("FREEZING_TEMP_C", "-5.0"))
    FLOOD_PRECIP_MM_H: float = float(os.getenv("FLOOD_PRECIP_MM_H", "15.0"))
    STORM_WIND_KMH: float = float(os.getenv("STORM_WIND_KMH", "60.0"))

settings = Settings()

from fastapi import APIRouter, Query, HTTPException, status
from typing import Optional
from app.domain.weather_models import WeatherSummaryResponse
from app.services.weather_service import WeatherOrchestratorService

router = APIRouter(prefix="/api", tags=["Weather Disasters & Hazards"])

@router.get(
    "/weather-reports",
    response_model=WeatherSummaryResponse,
    summary="Get multi-source weather disaster and hazard reports",
    description="Aggregates live meteorological telemetry with verified operator municipal disaster logs."
)
async def get_weather_reports(
    latitude: Optional[float] = Query(None, description="Target location latitude. Defaults to municipal center if omitted."),
    longitude: Optional[float] = Query(None, description="Target location longitude. Defaults to municipal center if omitted.")
):
    try:
        report = await WeatherOrchestratorService.get_weather_disaster_report(latitude, longitude)
        return report
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate weather disaster report: {e}"
        )

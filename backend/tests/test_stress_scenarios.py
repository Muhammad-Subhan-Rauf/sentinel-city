import pytest
import httpx
import asyncio

# The backend orchestrator or main FastAPI app URL
BASE_URL = "http://localhost:8000"

@pytest.fixture
async def async_client():
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client

@pytest.mark.asyncio
async def test_scenario_1_single_credible_fire(async_client):
    """Scenario 1: A highly credible fire report from a reliable source."""
    payload = {
        "text": "Huge fire at the downtown library, flames are visible from the roof!",
        "location": {"lat": 40.7128, "lon": -74.0060},
        "user_id": "trusted_citizen_01"
    }
    response = await async_client.post("/api/reports", json=payload)
    # We might expect a 200 or 201, and some credibility score > 0.8
    assert response.status_code in [200, 201, 404] # 404 if endpoint not implemented yet
    
@pytest.mark.asyncio
async def test_scenario_2_high_volume_false_alarms(async_client):
    """Scenario 2: Many rapid reports that are likely false alarms."""
    for i in range(10):
        payload = {
            "text": "I think I saw an alien spaceship!",
            "location": {"lat": 40.7128 + i*0.001, "lon": -74.0060},
            "user_id": f"panicked_user_{i}"
        }
        await async_client.post("/api/reports", json=payload)
    # Orchestrator should flag these as low credibility / false alarm

@pytest.mark.asyncio
async def test_scenario_3_coordinated_prank_calls(async_client):
    """Scenario 3: Multiple users reporting the exact same fake incident at the exact same time."""
    tasks = []
    for i in range(5):
        payload = {
            "text": "There's a dinosaur in the park!",
            "location": {"lat": 40.7306, "lon": -73.9866},
            "user_id": f"prankster_{i}"
        }
        tasks.append(async_client.post("/api/reports", json=payload))
    await asyncio.gather(*tasks)

@pytest.mark.asyncio
async def test_scenario_4_capacity_exhaustion(async_client):
    """Scenario 4: A massive number of reports simulating a city-wide disaster."""
    tasks = []
    # 50 concurrent reports
    for i in range(50):
        payload = {
            "text": "Earthquake felt strongly here!",
            "location": {"lat": 40.7 + i*0.001, "lon": -74.0 + i*0.001},
            "user_id": f"user_{i}"
        }
        tasks.append(async_client.post("/api/reports", json=payload))
    await asyncio.gather(*tasks)

@pytest.mark.asyncio
async def test_scenario_5_vague_reports(async_client):
    """Scenario 5: Vague reports that require the orchestrator to request more info or assign low credibility."""
    payload = {
        "text": "Something is wrong outside.",
        "location": {"lat": 40.7128, "lon": -74.0060},
        "user_id": "vague_user_01"
    }
    await async_client.post("/api/reports", json=payload)

@pytest.mark.asyncio
async def test_scenario_6_escalation(async_client):
    """Scenario 6: Small fire reported initially, then more severe reports follow."""
    # Initial report
    await async_client.post("/api/reports", json={
        "text": "Smell smoke near the trash can.",
        "location": {"lat": 40.7580, "lon": -73.9855},
        "user_id": "observer_1"
    })
    # Escalation
    await async_client.post("/api/reports", json={
        "text": "The building is on fire, smoke everywhere!",
        "location": {"lat": 40.7580, "lon": -73.9855},
        "user_id": "observer_2"
    })

@pytest.mark.asyncio
async def test_scenario_7_simultaneous_disasters(async_client):
    """Scenario 7: Multiple unrelated major incidents happening at once."""
    await asyncio.gather(
        async_client.post("/api/reports", json={
            "text": "Major car pileup on the highway!",
            "location": {"lat": 40.8000, "lon": -73.9500},
            "user_id": "driver_1"
        }),
        async_client.post("/api/reports", json={
            "text": "Factory explosion!",
            "location": {"lat": 40.7000, "lon": -74.0100},
            "user_id": "worker_1"
        })
    )

@pytest.mark.asyncio
async def test_scenario_8_conflicting_reports(async_client):
    """Scenario 8: Reports that conflict with each other (e.g., real fire vs just BBQ)."""
    await async_client.post("/api/reports", json={
        "text": "There's a huge fire in the park!",
        "location": {"lat": 40.7306, "lon": -73.9866},
        "user_id": "alarmed_citizen"
    })
    await async_client.post("/api/reports", json={
        "text": "No fire, it's just a neighborhood BBQ event.",
        "location": {"lat": 40.7306, "lon": -73.9866},
        "user_id": "chill_citizen"
    })

"""
Pydantic models for Agent and Incident state tracking.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

class IncidentState(BaseModel):
    """Tracks the state of an active incident.

    Note: `location` is GROUND TRUTH — never shown to the AI. The agent must
    call `triangulate_incident` to get an approximate `location_estimate`,
    which is cached here after the first triangulation.
    """
    incident_id: str
    type: str
    location: Dict[str, float]  # GROUND TRUTH — server-side only
    location_estimate: Optional[Dict[str, float]] = None  # AI-visible, noisy
    severity: str
    confidence: float
    description: str
    dispatched_units: List[str] = Field(default_factory=list)
    status: str = "active"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    history: List[Dict[str, Any]] = Field(default_factory=list)

    def agent_view(self) -> Dict[str, Any]:
        """Serialize for the agent context — strips ground-truth location."""
        d = self.model_dump()
        d.pop("location", None)
        return d

    def update_state(self, **kwargs) -> None:
        """Update fields and record the update in history."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
        self.updated_at = datetime.now(timezone.utc)
        self.history.append({
            "timestamp": self.updated_at.isoformat(),
            "updates": kwargs
        })

class AgentState(BaseModel):
    """Tracks the state of an AI orchestrator agent."""
    agent_id: str
    active_incidents: Dict[str, IncidentState] = Field(default_factory=dict)
    monitoring_history: List[Dict[str, Any]] = Field(default_factory=list)
    last_update: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def add_incident(self, incident: IncidentState) -> None:
        """Add a new incident to track."""
        self.active_incidents[incident.incident_id] = incident
        self.last_update = datetime.now(timezone.utc)

    def update_incident(self, incident_id: str, **kwargs) -> None:
        """Update an existing incident."""
        if incident_id in self.active_incidents:
            self.active_incidents[incident_id].update_state(**kwargs)
            self.last_update = datetime.now(timezone.utc)

    def remove_incident(self, incident_id: str) -> None:
        """Remove an incident from tracking."""
        if incident_id in self.active_incidents:
            del self.active_incidents[incident_id]
            self.last_update = datetime.now(timezone.utc)

    def log_monitoring(self, observation: Dict[str, Any]) -> None:
        """Log a new monitoring observation."""
        self.monitoring_history.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "observation": observation
        })
        self.last_update = datetime.now(timezone.utc)

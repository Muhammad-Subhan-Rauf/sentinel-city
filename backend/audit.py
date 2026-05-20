"""
Structured JSONL auditing module for logging agent actions, decisions, and observations.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

class AuditLogger:
    """JSONL logger for structured agent audits."""

    def __init__(self, log_dir: str = r"c:\Users\Subhan\Desktop\Hackathon\backend\logs"):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.current_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.log_file = self.log_dir / f"audit_{self.current_date}.jsonl"

    def _log(self, event_type: str, details: Dict[str, Any]) -> None:
        """Core logging logic writing to a JSONL file."""
        new_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if new_date != self.current_date:
            self.current_date = new_date
            self.log_file = self.log_dir / f"audit_{self.current_date}.jsonl"

        log_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "details": details
        }
        
        with open(self.log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")

    def log_decision(self, agent_id: str, context: str, decision: str, rationale: str) -> None:
        """Logs an agent's decision."""
        self._log("DECISION", {
            "agent_id": agent_id,
            "context": context,
            "decision": decision,
            "rationale": rationale
        })

    def log_tool_call(
        self, agent_id: str, tool_name: str, arguments: Dict[str, Any], 
        result: Any = None, error: Optional[str] = None
    ) -> None:
        """Logs a tool call execution and its outcome."""
        self._log("TOOL_CALL", {
            "agent_id": agent_id,
            "tool_name": tool_name,
            "arguments": arguments,
            "result": result,
            "error": error
        })

    def log_observation(self, agent_id: str, source: str, data: Any) -> None:
        """Logs an observation from the environment (e.g., incoming signals)."""
        self._log("OBSERVATION", {
            "agent_id": agent_id,
            "source": source,
            "data": data
        })

    def log_recovery_action(self, agent_id: str, error_context: str, action_taken: str) -> None:
        """Logs an action taken to recover from an error."""
        self._log("RECOVERY_ACTION", {
            "agent_id": agent_id,
            "error_context": error_context,
            "action_taken": action_taken
        })

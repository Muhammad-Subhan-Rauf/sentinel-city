import logging
import math
from typing import Dict, Any, List, Optional
import asyncio

logger = logging.getLogger(__name__)

GET_WEATHER = {
    "name": "get_weather",
    "description": "Get current weather conditions in Sentinel City",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

GET_TRAFFIC = {
    "name": "get_traffic",
    "description": "Get current traffic conditions",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

GET_CITIZEN_REPORTS = {
    "name": "get_citizen_reports",
    "description": "Get recent citizen reports",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

GET_WORLD_STATE = {
    "name": "get_world_state",
    "description": "Get current world state of all active incidents, disasters, and station capacities",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

GET_ACTIVE_NOTIFICATIONS = {
    "name": "get_active_notifications",
    "description": "Get all active notifications and citizen alerts",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

GET_ACTIVE_CORDONS = {
    "name": "get_active_cordons",
    "description": "Get all active cordons in the city",
    "parameters": {
        "type": "OBJECT",
        "properties": {}
    }
}

DECLARE_INCIDENT = {
    "name": "declare_incident",
    "description": "Declare a new incident or disaster",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "type": {"type": "STRING", "description": "Type of incident (e.g. fire, medical, police)"},
            "location": {
                "type": "OBJECT",
                "properties": {
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"}
                },
                "required": ["lat", "lng"]
            },
            "severity": {"type": "STRING", "description": "Severity level: low, medium, high, critical"},
            "description": {"type": "STRING", "description": "Description of the incident"}
        },
        "required": ["type", "location", "severity", "description"]
    }
}

UPDATE_INCIDENT = {
    "name": "update_incident",
    "description": "Update an existing incident",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "The ID of the incident"},
            "status": {"type": "STRING", "description": "New status"},
            "severity": {"type": "STRING", "description": "New severity"},
            "description": {"type": "STRING", "description": "Additional description"}
        },
        "required": ["incident_id"]
    }
}

CLEAR_INCIDENT = {
    "name": "clear_incident",
    "description": "Clear or resolve an incident",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "The ID of the incident"}
        },
        "required": ["incident_id"]
    }
}

PUBLISH_CITIZEN_ALERT = {
    "name": "publish_citizen_alert",
    "description": "Publish an alert to citizens",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "Associated incident ID"},
            "message": {"type": "STRING", "description": "The alert message"},
            "severity": {"type": "STRING", "description": "Alert severity"},
            "target_area": {
                "type": "OBJECT",
                "properties": {
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"},
                    "radius": {"type": "NUMBER"}
                }
            }
        },
        "required": ["incident_id", "message", "severity"]
    }
}

RETRACT_CITIZEN_ALERT = {
    "name": "retract_citizen_alert",
    "description": "Retract an existing citizen alert",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "alert_id": {"type": "STRING", "description": "The ID of the alert/notification to retract"}
        },
        "required": ["alert_id"]
    }
}

CREATE_CORDON = {
    "name": "create_cordon",
    "description": "Create a new cordon around an area",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "Associated incident ID"},
            "center": {
                "type": "OBJECT",
                "properties": {
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"}
                },
                "required": ["lat", "lng"]
            },
            "radius": {"type": "INTEGER", "description": "Radius in meters"},
            "reason": {"type": "STRING", "description": "Reason for the cordon"}
        },
        "required": ["incident_id", "center", "radius", "reason"]
    }
}

CLEAR_CORDON = {
    "name": "clear_cordon",
    "description": "Clear an existing cordon",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "cordon_id": {"type": "STRING", "description": "The ID of the cordon to clear"}
        },
        "required": ["cordon_id"]
    }
}

DISPATCH_UNITS = {
    "name": "dispatch_units",
    "description": "Dispatch emergency units to an incident",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "Associated incident ID"},
            "station_id": {"type": "STRING", "description": "Station from which to dispatch"},
            "unit_type": {"type": "STRING", "description": "Type of unit (firefighter, ambulance, police)"},
            "count": {"type": "INTEGER", "description": "Number of units"},
            "target": {
                "type": "OBJECT",
                "properties": {
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"}
                },
                "required": ["lat", "lng"]
            }
        },
        "required": ["incident_id", "station_id", "unit_type", "count", "target"]
    }
}

MULTI_STATION_DISPATCH = {
    "name": "multi_station_dispatch",
    "description": "Dispatch units from multiple stations",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING", "description": "Associated incident ID"},
            "target": {
                "type": "OBJECT",
                "properties": {
                    "lat": {"type": "NUMBER"},
                    "lng": {"type": "NUMBER"}
                },
                "required": ["lat", "lng"]
            },
            "dispatches": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "station_id": {"type": "STRING"},
                        "unit_type": {"type": "STRING", "description": "firefighter, ambulance, or police"},
                        "count": {"type": "INTEGER"}
                    },
                    "required": ["station_id", "unit_type", "count"]
                }
            }
        },
        "required": ["incident_id", "target", "dispatches"]
    }
}

RETURN_UNITS = {
    "name": "return_units",
    "description": "Return emergency units back to their station",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "incident_id": {"type": "STRING"},
            "station_id": {"type": "STRING"},
            "unit_type": {"type": "STRING"},
            "count": {"type": "INTEGER"}
        },
        "required": ["incident_id", "station_id", "unit_type", "count"]
    }
}

ALL_TOOLS = [
    GET_WEATHER, GET_TRAFFIC, GET_CITIZEN_REPORTS, GET_WORLD_STATE,
    GET_ACTIVE_NOTIFICATIONS, GET_ACTIVE_CORDONS, DECLARE_INCIDENT,
    UPDATE_INCIDENT, CLEAR_INCIDENT, PUBLISH_CITIZEN_ALERT, RETRACT_CITIZEN_ALERT,
    CREATE_CORDON, CLEAR_CORDON, DISPATCH_UNITS, MULTI_STATION_DISPATCH, RETURN_UNITS
]

# Backend /api/trigger-disaster expects DisasterPayload with disaster_type as
# Title_Case (Flood, Wildfire, Power_Outage, ...). Gemini sends free-form
# strings like "wildfire", "building fire", "medical". Normalize.
_DISASTER_TYPE_MAP = {
    "flood": "Flood",
    "wildfire": "Wildfire",
    "fire": "Wildfire",
    "building_fire": "Wildfire",
    "heatwave": "Heatwave",
    "heat": "Heatwave",
    "power_outage": "Power_Outage",
    "power": "Power_Outage",
    "blackout": "Power_Outage",
    "robbery": "Robbery",
    "theft": "Robbery",
    "gang_violence": "Gang_Violence",
    "gang": "Gang_Violence",
    "violence": "Gang_Violence",
    "accident": "Accident",
    "medical": "Accident",
    "crash": "Accident",
    "road_blockage": "Road_Blockage",
    "road_block": "Road_Blockage",
    "roadblock": "Road_Blockage",
    "infrastructure_failure": "Infrastructure_Failure",
    "infrastructure": "Infrastructure_Failure",
}

# Backend severity ceilings by type (mirror SEVERITY_MAX_BY_TYPE in main.py).
_SEVERITY_MAX_BY_TYPE = {
    "Flood": 5, "Wildfire": 5, "Heatwave": 4, "Power_Outage": 3,
    "Robbery": 4, "Gang_Violence": 5, "Accident": 4,
    "Road_Blockage": 3, "Infrastructure_Failure": 4,
}

_SEVERITY_WORD_MAP = {"low": 2, "medium": 4, "high": 6, "critical": 8}


def _build_disaster_payload(args: Dict[str, Any]) -> Dict[str, Any]:
    """Translate Gemini's declare_incident args into a DisasterPayload body."""
    raw_type = str(args["type"]).strip().lower().replace(" ", "_").replace("-", "_")
    disaster_type = _DISASTER_TYPE_MAP.get(raw_type, raw_type.title())

    sev_raw = args["severity"]
    if isinstance(sev_raw, str):
        sev = _SEVERITY_WORD_MAP.get(sev_raw.strip().lower(), 4)
    else:
        try:
            sev = int(sev_raw)
        except (TypeError, ValueError):
            sev = 4
    sev = max(1, min(10, sev))
    cap = _SEVERITY_MAX_BY_TYPE.get(disaster_type)
    if cap is not None:
        sev = min(sev, cap)

    loc = args["location"]
    lat = loc["lat"]
    lng = loc["lng"]

    return {
        "disaster_type": disaster_type,
        "severity": sev,
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "geometry_kind": "point",
        "notes": args.get("description", ""),
        "status": "active",
    }


def _circle_to_geojson_polygon(lat: float, lng: float, radius_m: float, vertices: int = 24) -> Dict[str, Any]:
    """Approximate a circle (lat, lng, radius in meters) as a GeoJSON Polygon."""
    if radius_m <= 0:
        radius_m = 100.0
    deg_per_m_lat = 1.0 / 111320.0
    deg_per_m_lng = 1.0 / (111320.0 * max(math.cos(math.radians(lat)), 1e-6))
    coords = []
    for i in range(vertices):
        theta = 2.0 * math.pi * i / vertices
        coords.append([
            lng + radius_m * math.cos(theta) * deg_per_m_lng,
            lat + radius_m * math.sin(theta) * deg_per_m_lat,
        ])
    coords.append(coords[0])  # close the ring
    return {"type": "Polygon", "coordinates": [coords]}


def _build_cordon_payload(args: Dict[str, Any]) -> Dict[str, Any]:
    """Translate Gemini's create_cordon args into a CordonPayload body."""
    center = args.get("center") or {}
    lat = float(center.get("lat", 0.0))
    lng = float(center.get("lng", 0.0))
    radius = float(args.get("radius", 200.0))
    return {
        "geometry": _circle_to_geojson_polygon(lat, lng, radius),
        "reason": args.get("reason", ""),
        "event_id": args.get("incident_id") or args.get("event_id"),
    }


class ToolExecutor:
    """Executes Sentinel City tools, applying validation and audit logging."""

    def __init__(self, api_client: Any, audit_logger: Any):
        self.api = api_client
        self.audit = audit_logger

    async def execute(self, tool_name: str, arguments: Dict[str, Any], agent_id: str = "orchestrator") -> Any:
        logger.info(f"Executing tool {tool_name} with arguments {arguments}")
        
        try:
            result = await self._dispatch_tool(tool_name, arguments)
            if hasattr(self.audit, "log_tool_call"):
                # Handle positional arguments vs named arguments matching AuditLogger
                try:
                    self.audit.log_tool_call(agent_id=agent_id, tool_name=tool_name, arguments=arguments, result=result)
                except TypeError:
                    self.audit.log_tool_call(agent_id, tool_name, arguments, result)
            return result
        except Exception as e:
            logger.error(f"Error executing {tool_name}: {e}")
            if hasattr(self.audit, "log_tool_call"):
                try:
                    self.audit.log_tool_call(agent_id=agent_id, tool_name=tool_name, arguments=arguments, error=str(e))
                except TypeError:
                    self.audit.log_tool_call(agent_id, tool_name, arguments, error=str(e))
            raise

    async def _dispatch_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        if tool_name == "get_weather":
            return await self.api.get_weather()
            
        elif tool_name == "get_traffic":
            return await self.api.get_traffic()
            
        elif tool_name == "get_citizen_reports":
            return await self.api.get_citizen_reports()
            
        elif tool_name == "get_world_state":
            disasters = await self.api.get_disasters()
            fire = await self.api.get_fire_stations()
            hosp = await self.api.get_hospitals()
            pol = await self.api.get_police_stations()
            return {
                "disasters": disasters,
                "fire_stations": fire,
                "hospitals": hosp,
                "police_stations": pol
            }
            
        elif tool_name == "get_active_notifications":
            return await self.api.get_notifications()
            
        elif tool_name == "get_active_cordons":
            return await self.api.get_cordons()
            
        elif tool_name == "declare_incident":
            for field in ["type", "location", "severity", "description"]:
                if field not in args:
                    raise ValueError(f"Missing required field '{field}' in declare_incident")
            payload = _build_disaster_payload(args)
            return await self.api.trigger_disaster(payload)
            
        elif tool_name == "update_incident":
            if "incident_id" not in args:
                raise ValueError("Missing 'incident_id' in update_incident")
            payload = dict(args)
            incident_id = payload.pop("incident_id")
            return await self.api.update_disaster(incident_id, payload)
            
        elif tool_name == "clear_incident":
            if "incident_id" not in args:
                raise ValueError("Missing 'incident_id' in clear_incident")
            return await self.api.delete_disaster(args["incident_id"])
            
        elif tool_name == "publish_citizen_alert":
            for field in ["incident_id", "message", "severity"]:
                if field not in args:
                    raise ValueError(f"Missing required field '{field}' in publish_citizen_alert")
            return await self.api.notify(args)
            
        elif tool_name == "retract_citizen_alert":
            if "alert_id" not in args:
                raise ValueError("Missing 'alert_id' in retract_citizen_alert")
            return await self.api._request("DELETE", f"/notifications/{args['alert_id']}")
            
        elif tool_name == "create_cordon":
            for field in ["incident_id", "center", "radius", "reason"]:
                if field not in args:
                    raise ValueError(f"Missing required field '{field}' in create_cordon")
            payload = _build_cordon_payload(args)
            return await self.api.cordon(payload)
            
        elif tool_name == "clear_cordon":
            if "cordon_id" not in args:
                raise ValueError("Missing 'cordon_id' in clear_cordon")
            return await self.api._request("DELETE", f"/cordons/{args['cordon_id']}")
            
        elif tool_name == "dispatch_units":
            for field in ["incident_id", "station_id", "unit_type", "count", "target"]:
                if field not in args:
                    raise ValueError(f"Missing required field '{field}' in dispatch_units")
            
            # Map to backend's DispatchPayload structure
            payload = {
                "kind": args["unit_type"],
                "units": args["count"],
                "target": args["target"],
                "station_id": args["station_id"]
            }
            return await self.api.dispatch(payload)
            
        elif tool_name == "multi_station_dispatch":
            if "incident_id" not in args or "dispatches" not in args or "target" not in args:
                raise ValueError("Missing 'incident_id', 'target' or 'dispatches' in multi_station_dispatch")
            
            incident_id = args["incident_id"]
            target = args["target"]
            results = []
            for d in args["dispatches"]:
                for field in ["station_id", "unit_type", "count"]:
                    if field not in d:
                        raise ValueError(f"Missing required field '{field}' in dispatch item")
                dispatch_args = {
                    "kind": d["unit_type"],
                    "units": d["count"],
                    "target": target,
                    "station_id": d["station_id"]
                }
                res = await self.api.dispatch(dispatch_args)
                results.append(res)
            return results
            
        elif tool_name == "return_units":
            for field in ["incident_id", "station_id", "unit_type", "count"]:
                if field not in args:
                    raise ValueError(f"Missing required field '{field}' in return_units")
            
            incident_id = args["incident_id"]
            if hasattr(self.api, "return_ack"):
                return await self.api.return_ack(incident_id, args)
            else:
                return await self.api._request("POST", f"/dispatch/{incident_id}/return", json=args)
                
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

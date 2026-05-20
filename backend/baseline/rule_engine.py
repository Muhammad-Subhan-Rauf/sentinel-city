import math
from typing import List, Dict, Any

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000  # radius of Earth in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

class RuleEngine:
    def __init__(self):
        self.reports: List[Dict[str, Any]] = []

    def add_report(self, report: Dict[str, Any]):
        """
        report dict expects: {'id': int, 'lat': float, 'lon': float, 'type': str, 'timestamp': float}
        """
        self.reports.append(report)

    def detect_fires(self) -> List[Dict[str, Any]]:
        """
        Detects a fire if > 3 calls within 200m of each other.
        Returns a list of detected fire events with their approximate locations.
        """
        detected_fires = []
        fire_reports = [r for r in self.reports if r.get('type') == 'fire']
        
        # Simple clustering: for each report, count how many other reports are within 200m.
        # If > 3 (meaning at least 4 including itself, or > 3 other calls? ">3 calls" typically means >=4 calls total).
        # We'll use >= 4 calls total in a cluster.
        processed = set()
        for r1 in fire_reports:
            if r1['id'] in processed:
                continue
            
            cluster = [r1]
            for r2 in fire_reports:
                if r1['id'] == r2['id']:
                    continue
                if haversine(r1['lat'], r1['lon'], r2['lat'], r2['lon']) <= 200:
                    cluster.append(r2)
            
            if len(cluster) > 3:
                # Mark all as processed so we don't create overlapping duplicate fires for the same cluster
                for c in cluster:
                    processed.add(c['id'])
                
                # Approximate location as centroid
                avg_lat = sum(c['lat'] for c in cluster) / len(cluster)
                avg_lon = sum(c['lon'] for c in cluster) / len(cluster)
                
                detected_fires.append({
                    'event_type': 'fire',
                    'lat': avg_lat,
                    'lon': avg_lon,
                    'report_ids': [c['id'] for c in cluster],
                    'confidence': 1.0  # Rule engine is confident if rule is met
                })
        
        return detected_fires

import json
from typing import List, Dict, Any
from .rule_engine import RuleEngine

def compare_metrics(rule_results: List[Dict[str, Any]], ai_results: List[Dict[str, Any]], ground_truth: List[Dict[str, Any]]):
    """
    Compare the metrics between the fixed-rule engine and the AI orchestrator against ground truth.
    """
    def calculate_metrics(predictions, truth):
        # Simplistic evaluation for demonstration
        # A true positive is a prediction that is close to a truth event
        tp = 0
        fp = 0
        fn = 0
        
        # This assumes each prediction matches at most one truth
        matched_truths = set()
        for p in predictions:
            matched = False
            for i, t in enumerate(truth):
                if i in matched_truths:
                    continue
                # Assuming 'lat' and 'lon' are present and we consider a match if within 500m
                from .rule_engine import haversine
                if p['event_type'] == t['event_type'] and haversine(p['lat'], p['lon'], t['lat'], t['lon']) <= 500:
                    tp += 1
                    matched_truths.add(i)
                    matched = True
                    break
            if not matched:
                fp += 1
                
        fn = len(truth) - len(matched_truths)
        
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        
        return {
            "true_positives": tp,
            "false_positives": fp,
            "false_negatives": fn,
            "precision": precision,
            "recall": recall,
            "f1_score": f1
        }

    rule_metrics = calculate_metrics(rule_results, ground_truth)
    ai_metrics = calculate_metrics(ai_results, ground_truth)

    print("--- Baseline Comparison Metrics ---")
    print("Rule Engine Metrics:")
    print(json.dumps(rule_metrics, indent=2))
    print("\nAI Orchestrator Metrics:")
    print(json.dumps(ai_metrics, indent=2))
    
    return {
        "rule_metrics": rule_metrics,
        "ai_metrics": ai_metrics
    }

if __name__ == "__main__":
    # Example usage / Mock run
    print("Running baseline comparison with mock data...")
    ground_truth = [{"event_type": "fire", "lat": 40.7128, "lon": -74.0060}]
    
    rule_preds = [{"event_type": "fire", "lat": 40.7130, "lon": -74.0062}]
    ai_preds = [{"event_type": "fire", "lat": 40.7129, "lon": -74.0061}]
    
    compare_metrics(rule_preds, ai_preds, ground_truth)

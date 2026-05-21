"""
One-shot Vertex AI sanity check. Run locally:

    cd backend
    python test_vertex.py

Expects:
  - backend/vertex-sa.json present (the service-account JSON you downloaded)
  - The SA has roles/aiplatform.user on project hackathon-496916
  - Vertex AI API enabled on that project

Prints the model's reply + the input/output token counts so you can confirm
both that it works AND that the per-call cost is in the "cents" range, not
the "dollars" range, before turning the orchestrator on.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Pin auth + project from the same env layout the orchestrator uses, but
# fall back to a default for ad-hoc runs.
HERE = Path(__file__).resolve().parent
SA_JSON = HERE / "vertex-sa.json"

if not SA_JSON.exists():
    sys.exit(
        f"[FAIL] {SA_JSON} not found.\n"
        "Download the service-account JSON from GCP console "
        "(IAM → Service Accounts → your SA → Keys → Add Key → JSON) "
        f"and save it as exactly:\n  {SA_JSON}"
    )

os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", str(SA_JSON))
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "hackathon-496916")
os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "us-central1")

project = os.environ["GOOGLE_CLOUD_PROJECT"]
location = os.environ["GOOGLE_CLOUD_LOCATION"]
model_name = "gemini-2.5-flash-lite"

print(f"[INFO] SA JSON:  {SA_JSON}")
print(f"[INFO] Project:  {project}")
print(f"[INFO] Location: {location}")
print(f"[INFO] Model:    {model_name}")
print()

try:
    from langchain_google_vertexai import ChatVertexAI
except ImportError:
    sys.exit(
        "[FAIL] langchain-google-vertexai not installed locally.\n"
        "Run: pip install langchain-google-vertexai"
    )

llm = ChatVertexAI(
    model=model_name,
    temperature=0.0,
    project=project,
    location=location,
    max_retries=1,
)

prompt = (
    "Reply with one short sentence confirming you are running. "
    "Then on a new line write 'OK'."
)
print(f"[INFO] Sending prompt: {prompt!r}\n")

try:
    response = llm.invoke(prompt)
except Exception as exc:
    name = type(exc).__name__
    msg = str(exc)
    print(f"[FAIL] {name}: {msg[:600]}\n")
    if "403" in msg or "PermissionDenied" in name:
        print("Likely cause: the service account lacks roles/aiplatform.user.")
        print("Fix: GCP Console → IAM → find the SA → add 'Agent Platform User'.")
    elif "404" in msg or "NotFound" in name:
        print(f"Likely cause: model {model_name!r} isn't available in {location!r},")
        print("or Vertex AI API isn't enabled. Try GOOGLE_CLOUD_LOCATION=us-central1")
        print("and confirm: https://console.cloud.google.com/apis/library/aiplatform.googleapis.com")
    elif "DefaultCredentialsError" in name or "credentials" in msg.lower():
        print("Likely cause: SA JSON unreadable or malformed.")
        print(f"Check: cat {SA_JSON} | head -3 — should show JSON.")
    sys.exit(1)

print("[OK] Got a response.\n")
print("-" * 60)
print(response.content if isinstance(response.content, str) else response.content)
print("-" * 60)

usage = getattr(response, "usage_metadata", None) or {}
if usage:
    in_tok = usage.get("input_tokens", 0)
    out_tok = usage.get("output_tokens", 0)
    total = usage.get("total_tokens", in_tok + out_tok)
    print(f"\n[USAGE] input={in_tok}  output={out_tok}  total={total} tokens")
    # gemini-2.5-flash-lite pricing (approx, as of 2026):
    #   $0.075 / 1M input tokens, $0.30 / 1M output tokens.
    cost_usd = (in_tok * 0.075 + out_tok * 0.30) / 1_000_000
    print(f"[USAGE] est. cost for this call: ${cost_usd:.6f}")
else:
    print("\n[USAGE] response.usage_metadata was empty (provider didn't report).")

print("\n[DONE] Vertex AI is wired up correctly.")

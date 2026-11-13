"""Regenerate ``web/fixtures/*.json`` from the real API, run in-process on the sample station.

Usage: ``uv run python scripts/make_fixtures.py``. The front end uses these files when opened
with ``?fixtures=1``. Every value is a real response of this application; nothing is hand-written.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from climpoc.api.app import create_app
from climpoc.api.store import DatasetStore

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "web" / "fixtures"
BAD_FILE = "1936 1 1 0.3 23.7 18.7\n1936 1 2 0.5 24.1\n1936 2 30 0 25 19.7\n1936 1 4 x 25.6 20.6\n"


def save(name: str, body: object) -> None:
    text = json.dumps(body, separators=(",", ":"), allow_nan=False)
    (FIXTURES / f"{name}.json").write_text(text + "\n")
    print(f"{name}.json  {len(text) / 1024:.0f} kB")


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    client = TestClient(create_app(DatasetStore(), ROOT / "web"))
    for name in ("health", "version", "indices"):
        save(name, client.get(f"/api/{name}").json())
    created = client.post("/api/datasets/sample")
    if created.status_code != 201:
        raise SystemExit(f"Sample dataset unavailable: {created.json()['error']['message']}")
    dataset = created.json()
    save("dataset", dataset)
    url = f"/api/datasets/{dataset['id']}"
    for variable in ("tasmax", "tasmin", "pr"):
        save(f"daily_{variable}", client.get(f"{url}/daily", params={"variable": variable}).json())
    for frequency in ("annual", "monthly"):
        client.post(f"{url}/compute", json={"indices": "all", "frequency": frequency})  # warm-up run
        fresh = client.post("/api/datasets/sample").json()
        request = {"indices": "all", "frequency": frequency}
        body = client.post(f"/api/datasets/{fresh['id']}/compute", json=request).json()
        body["dataset_id"] = dataset["id"]
        save(f"compute_{frequency}", body)
    save("qc_rerun", client.post(f"{url}/qc", json={"max_precip_mm": 150, "max_temperature_jump": 15}).json())
    save("error_validation", client.post("/api/datasets", files={"file": ("bad.txt", BAD_FILE)}).json())
    save("error_not_found", client.get("/api/datasets/ds_0000000000000000").json())
    save("error_unknown_index", client.post(f"{url}/compute", json={"indices": ["txx", "nope"]}).json())


if __name__ == "__main__":
    main()

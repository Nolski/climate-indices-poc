"""API tests with FastAPI's test client: every endpoint, success and failure."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
import xarray as xr
from fastapi.testclient import TestClient

from climpoc.api.app import create_app
from climpoc.api.config import ApiConfig
from climpoc.api.store import DatasetStore
from climpoc.indices.registry import REGISTRY
from conftest import synthetic_text

TEXT = synthetic_text()
FORM = {"name": "Test station", "latitude": "45", "longitude": "5", "base_start": "1991", "base_end": "2000"}


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture(scope="module")
def web_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("web")
    (root / "index.html").write_text("<!doctype html><title>t</title>" + "<p>hello</p>" * 200)
    (root / "js").mkdir()
    (root / "js" / "app.js").write_text("console.log('x');" * 200)
    return root


@pytest.fixture(scope="module")
def client(web_dir: Path) -> TestClient:
    return TestClient(create_app(DatasetStore(), web_dir, ApiConfig()))


@pytest.fixture(scope="module")
def dataset(client: TestClient) -> dict:
    response = client.post("/api/datasets", files={"file": ("my_station.txt", TEXT)}, data=FORM)
    assert response.status_code == 201, response.text
    return response.json()


def assert_error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    error = response.json()["error"]
    assert error["code"] == code and isinstance(error["message"], str) and isinstance(error["details"], list)
    return error


def test_health_and_version(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}
    version = client.get("/api/version").json()
    assert set(version) == {"app", "xclim", "python"} and version["xclim"] == "1.0.0"


def test_indices_listing(client: TestClient) -> None:
    indices = client.get("/api/indices").json()["indices"]
    assert [index["id"] for index in indices] == list(REGISTRY)
    txx = next(index for index in indices if index["id"] == "txx")
    assert txx == {
        "id": "txx", "name": "TXx", "long_name": "Hottest day", "description": "Maximum of daily maximum temperature",
        "group": "temperature", "units": "degC", "inputs": ["tasmax"], "frequencies": ["annual", "monthly"],
        "needs_base_period": False, "validated": txx["validated"], "validation": txx["validation"],
    }  # fmt: skip
    assert {index["group"] for index in indices} == {"temperature", "precipitation", "duration", "percentile"}
    assert all(isinstance(index["validated"], bool) for index in indices)


def test_upload_returns_dataset_summary(dataset: dict) -> None:
    assert dataset["id"].startswith("ds_")
    assert dataset["station"] == {"name": "Test station", "latitude": 45.0, "longitude": 5.0}
    assert dataset["period"] == {"start": "1990-01-01", "end": "2001-12-31", "n_days": 4383}
    assert dataset["base_period"] == {"start": 1991, "end": 2000}
    assert 3590 <= dataset["expires_in_seconds"] <= 3600
    assert set(dataset["variables"]) == {"pr", "tasmax", "tasmin"}
    assert dataset["variables"]["pr"]["units"] == "mm/day" and dataset["variables"]["tasmax"]["n_missing"] == 0
    qc = dataset["qc"]
    assert set(qc["summary"]) == {"errors", "warnings", "info"}
    assert {"id", "title", "severity", "description", "count", "records"} == set(qc["checks"][0])
    assert qc["missing_by_year"][0] == {"year": 1990, "pr": 0, "tasmax": 0, "tasmin": 0}


def test_upload_defaults_name_to_file_name(client: TestClient) -> None:
    response = client.post(
        "/api/datasets", files={"file": ("lima_airport.csv", synthetic_text("2000-01-01", "2000-12-31"))}
    )
    body = response.json()
    assert response.status_code == 201
    assert body["station"] == {"name": "lima_airport", "latitude": None, "longitude": None}
    assert body["base_period"] == {"start": 1971, "end": 2000}


def test_upload_with_bad_rows_lists_line_numbers(client: TestClient) -> None:
    text = "1990 1 1 0 20 10\n1990 1 2 0 20\n1990 2 30 0 20 10\n"
    error = assert_error(client.post("/api/datasets", files={"file": ("bad.txt", text)}), 422, "invalid_station_file")
    assert [detail["line"] for detail in error["details"]] == [2, 3]
    assert "expected 6 columns" in error["details"][0]["message"]
    assert "2 problems found" in error["message"]


def test_upload_rejects_empty_binary_and_missing_file(client: TestClient) -> None:
    assert_error(client.post("/api/datasets", files={"file": ("empty.txt", "  \n")}), 400, "empty_file")
    assert_error(
        client.post("/api/datasets", files={"file": ("x.xlsx", b"PK\x03\x04\x00binary")}), 422, "invalid_station_file"
    )
    assert_error(client.post("/api/datasets", data=FORM), 422, "invalid_request")


def test_upload_rejects_bad_parameters(client: TestClient) -> None:
    files = {"file": ("s.txt", TEXT)}
    assert_error(client.post("/api/datasets", files=files, data={"latitude": "123"}), 422, "invalid_request")
    assert_error(
        client.post("/api/datasets", files=files, data={"base_start": "2000", "base_end": "1990"}),
        400,
        "invalid_base_period",
    )


def test_upload_over_20_mb_is_rejected(client: TestClient) -> None:
    big = b"1990 1 1 0 20 10\n" * (ApiConfig().max_upload_bytes // 17 + 10)
    assert_error(client.post("/api/datasets", files={"file": ("big.txt", big)}), 413, "file_too_large")


def test_sample_dataset(client: TestClient) -> None:
    response = client.post("/api/datasets/sample")
    if response.status_code == 404:
        assert_error(response, 404, "sample_not_available")
        pytest.skip("sample station file absent; run scripts/fetch_sample.sh")
    body = response.json()
    assert response.status_code == 201
    assert body["station"] == {"name": "sydney_observatory_hill_1936-2015", "latitude": -10.0, "longitude": 100.0}
    assert body["period"]["n_days"] == 29220
    assert {name: variable["n_missing"] for name, variable in body["variables"].items()} == {
        "pr": 7,
        "tasmax": 58,
        "tasmin": 58,
    }
    custom = client.post(
        "/api/datasets/sample", json={"latitude": -33.86, "longitude": 151.21, "base_start": 1961, "base_end": 1990}
    )
    assert custom.json()["base_period"] == {"start": 1961, "end": 1990}
    assert_error(client.post("/api/datasets/sample", json={"latitude": 200}), 422, "invalid_request")


def test_get_dataset_and_unknown_id(client: TestClient, dataset: dict) -> None:
    again = client.get(f"/api/datasets/{dataset['id']}")
    assert again.status_code == 200 and again.json()["period"] == dataset["period"]
    assert again.headers["cache-control"] == "no-store"
    error = assert_error(client.get("/api/datasets/ds_missing"), 404, "dataset_not_found")
    assert "upload the file again" in error["message"]


def test_daily_series(client: TestClient, dataset: dict) -> None:
    url = f"/api/datasets/{dataset['id']}/daily"
    whole = client.get(url, params={"variable": "tasmax"}).json()
    assert (
        whole["variable"] == "tasmax"
        and whole["units"] == "degC"
        and len(whole["time"]) == len(whole["values"]) == 4383
    )
    part = client.get(url, params={"variable": "pr", "start": "1995-01-01", "end": "1995-01-31"}).json()
    assert part["time"][0] == "1995-01-01" and part["time"][-1] == "1995-01-31" and len(part["values"]) == 31
    assert_error(client.get(url, params={"variable": "wind"}), 400, "unknown_variable")
    assert_error(client.get(url, params={"start": "1995-13-45"}), 400, "invalid_date")
    assert_error(client.get(url, params={"start": "yesterday"}), 422, "invalid_request")
    assert_error(client.get("/api/datasets/ds_missing/daily"), 404, "dataset_not_found")


def test_missing_daily_values_are_null(client: TestClient) -> None:
    text = "2000 1 1 0 20 10\n2000 1 2 -99.9 -99.9 11\n2000 1 3 0 22 12\n"
    created = client.post("/api/datasets", files={"file": ("gap.txt", text)}).json()
    body = client.get(f"/api/datasets/{created['id']}/daily", params={"variable": "tasmax"})
    assert body.json()["values"] == [20.0, None, 22.0]
    assert "NaN" not in body.text and "-99.9" not in body.text


def test_compute_selected_indices(client: TestClient, dataset: dict) -> None:
    response = client.post(
        f"/api/datasets/{dataset['id']}/compute", json={"indices": ["txx", "SU", "tx90p", "gsl"], "frequency": "annual"}
    )
    body = response.json()
    assert response.status_code == 200, response.text
    assert body["dataset_id"] == dataset["id"] and body["frequency"] == "annual"
    assert body["base_period"] == {"start": 1991, "end": 2000}
    assert body["missing_policy"] == {"id": "climdex", "max_missing_days_per_year": 15, "max_missing_days_per_month": 3}
    assert isinstance(body["elapsed_ms"], int) and body["skipped"] == []
    assert [result["id"] for result in body["results"]] == ["txx", "su", "tx90p", "gsl"]
    txx = body["results"][0]
    assert set(txx) == {"id", "name", "long_name", "units", "time", "values", "stats", "trend"}
    assert txx["time"] == [str(year) for year in range(1990, 2002)] and len(txx["values"]) == 12
    assert set(txx["stats"]) == {"n", "mean", "min", "max"} and txx["stats"]["n"] == 12
    assert set(txx["trend"]) == {"method", "slope_per_decade", "lower", "upper", "p_value", "n"}


def test_compute_all_monthly_reports_skipped(client: TestClient, dataset: dict) -> None:
    body = client.post(f"/api/datasets/{dataset['id']}/compute", json={"indices": "all", "frequency": "monthly"}).json()
    computed = {result["id"] for result in body["results"]}
    skipped = {item["id"]: item["reason"] for item in body["skipped"]}
    assert computed | set(skipped) == set(REGISTRY) and not computed & set(skipped)
    assert skipped["cdd"] == "not available at monthly frequency"
    su = next(result for result in body["results"] if result["id"] == "su")
    assert su["time"][0] == "1990-01" and len(su["time"]) == 144
    again = client.post(f"/api/datasets/{dataset['id']}/compute", json={"frequency": "monthly"}).json()
    assert again["results"] == body["results"] and again["elapsed_ms"] == 0, "served from the in-memory cache"


def test_compute_with_other_missing_policy(client: TestClient) -> None:
    lines = TEXT.splitlines()
    lines[400] = " ".join([*lines[400].split()[:4], "-99.9", "-99.9"])
    created = client.post("/api/datasets", files={"file": ("s.txt", "\n".join(lines))}, data=FORM).json()
    url = f"/api/datasets/{created['id']}/compute"
    default = client.post(url, json={"indices": ["txx"]}).json()["results"][0]
    strict = client.post(url, json={"indices": ["txx"], "missing_policy": {"id": "any"}}).json()
    assert default["stats"]["n"] == 12 and strict["results"][0]["stats"]["n"] == 11
    assert strict["missing_policy"] == {"id": "any"} and strict["results"][0]["values"][1] is None
    assert_error(client.post(url, json={"missing_policy": {"id": "nope"}}), 400, "unknown_missing_policy")
    assert_error(
        client.post(url, json={"missing_policy": {"id": "any", "max_missing_fraction": 0.5}}),
        400,
        "invalid_missing_policy",
    )


def test_compute_with_user_parameters(client: TestClient, dataset: dict) -> None:
    url = f"/api/datasets/{dataset['id']}/compute"
    parameters = {"rx_days": 7, "hdd_base": 15, "wsdi_days": 5}
    body = client.post(url, json={"indices": ["rx7day", "hddheat15", "wsdi5", "txx"], "parameters": parameters}).json()
    assert [result["id"] for result in body["results"]] == ["rx7day", "hddheat15", "wsdi5", "txx"]
    everything = client.post(url, json={"indices": "all", "parameters": parameters}).json()
    ids = {result["id"] for result in everything["results"]}
    assert {"rx7day", "hddheat15", "wsdi5", "csdi3"} <= ids and not {"rx3day", "hddheat18", "wsdi3"} & ids
    assert_error(client.post(url, json={"indices": ["rx3day"], "parameters": parameters}), 400, "unknown_index")
    assert_error(client.post(url, json={"parameters": {"wsdi_days": 11}}), 422, "invalid_request")
    default = client.post(url, json={"indices": ["rx3day"]}).json()
    assert [result["id"] for result in default["results"]] == ["rx3day"]


def test_compute_errors(client: TestClient, dataset: dict) -> None:
    url = f"/api/datasets/{dataset['id']}/compute"
    error = assert_error(client.post(url, json={"indices": ["txx", "nope"]}), 400, "unknown_index")
    assert error["details"] == ["nope"]
    assert_error(client.post(url, json={"indices": []}), 400, "no_indices")
    assert_error(client.post(url, json={"frequency": "daily"}), 422, "invalid_request")
    assert_error(client.post("/api/datasets/ds_missing/compute", json={}), 404, "dataset_not_found")


def test_percentile_indices_skipped_without_base_data(client: TestClient) -> None:
    created = client.post("/api/datasets", files={"file": ("s.txt", TEXT)}).json()  # default base 1971-2000
    body = client.post(f"/api/datasets/{created['id']}/compute", json={"indices": ["tx90p", "su"]}).json()
    assert [result["id"] for result in body["results"]] == ["tx90p", "su"]
    short = client.post(
        "/api/datasets", files={"file": ("s.txt", TEXT)}, data={"base_start": "1961", "base_end": "1980"}
    ).json()
    body = client.post(f"/api/datasets/{short['id']}/compute", json={"indices": ["tx90p", "su"]}).json()
    assert [result["id"] for result in body["results"]] == ["su"]
    assert body["skipped"][0]["id"] == "tx90p" and "base period 1961-1980" in body["skipped"][0]["reason"]


def test_export_formats(client: TestClient, dataset: dict) -> None:
    url = f"/api/datasets/{dataset['id']}/export"
    archive = client.get(url, params={"format": "zip", "frequency": "annual", "indices": "txx,su"})
    assert archive.status_code == 200 and archive.headers["content-type"] == "application/zip"
    assert archive.headers["content-disposition"] == 'attachment; filename="Test_station_indices_annual.zip"'
    names = set(zipfile.ZipFile(io.BytesIO(archive.content)).namelist())
    assert {
        "README.txt",
        "indices/Test_station_txx_ANN.csv",
        "indices/Test_station_su_ANN.csv",
        "qc/Test_station_qc_findings.csv",
    } <= names
    nc = client.get(url, params={"format": "netcdf", "indices": "txx"})
    assert nc.headers["content-type"] == "application/x-netcdf"
    assert set(xr.open_dataset(io.BytesIO(nc.content)).data_vars) == {"txx", "time_bnds"}
    as_json = client.get(url, params={"format": "json", "frequency": "monthly", "indices": "su"})
    assert as_json.json()["results"][0]["id"] == "su" and as_json.json()["frequency"] == "monthly"
    assert "attachment" in as_json.headers["content-disposition"]


def test_export_errors(client: TestClient, dataset: dict) -> None:
    url = f"/api/datasets/{dataset['id']}/export"
    assert_error(client.get(url, params={"format": "xlsx"}), 422, "invalid_request")
    assert_error(client.get(url, params={"indices": "nope"}), 400, "unknown_index")
    assert_error(client.get(url, params={"frequency": "monthly", "indices": "cdd"}), 400, "nothing_to_export")
    assert_error(client.get("/api/datasets/ds_missing/export"), 404, "dataset_not_found")


def test_rerun_qc_with_new_thresholds(client: TestClient) -> None:
    created = client.post("/api/datasets", files={"file": ("s.txt", TEXT)}, data=FORM).json()
    url = f"/api/datasets/{created['id']}/qc"
    before = {check["id"]: check["count"] for check in created["qc"]["checks"]}
    body = client.post(url, json={"max_precip_mm": 20, "climatology_sd": 2.5}).json()
    after = {check["id"]: check["count"] for check in body["checks"]}
    assert (
        after["out_of_bounds"] > before["out_of_bounds"]
        and after["climatology_outliers"] > before["climatology_outliers"]
    )
    assert body["settings"]["max_precip_mm"] == 20.0
    assert client.get(f"/api/datasets/{created['id']}").json()["qc"]["settings"]["max_precip_mm"] == 20.0
    assert_error(client.post(url, json={"nope": 1}), 400, "unknown_qc_setting")


def test_delete_dataset(client: TestClient) -> None:
    created = client.post("/api/datasets", files={"file": ("s.txt", synthetic_text("2000-01-01", "2000-12-31"))}).json()
    assert client.delete(f"/api/datasets/{created['id']}").status_code == 204
    assert_error(client.get(f"/api/datasets/{created['id']}"), 404, "dataset_not_found")
    assert_error(client.delete(f"/api/datasets/{created['id']}"), 404, "dataset_not_found")


def test_datasets_expire_after_the_ttl(web_dir: Path) -> None:
    clock = Clock()
    store = DatasetStore(ttl=3600, clock=clock)
    with TestClient(create_app(store, web_dir, ApiConfig())) as local:
        created = local.post(
            "/api/datasets", files={"file": ("s.txt", synthetic_text("2000-01-01", "2000-12-31"))}
        ).json()
        clock.now = 3599
        assert local.get(f"/api/datasets/{created['id']}").json()["expires_in_seconds"] == 1
        clock.now = 3600
        assert_error(local.get(f"/api/datasets/{created['id']}"), 404, "dataset_not_found")
        assert len(store) == 0


def test_store_evicts_oldest_when_full() -> None:
    from climpoc.io.station import parse_station_text
    from climpoc.qc import run_qc

    clock = Clock()
    store = DatasetStore(max_entries=2, clock=clock)
    parsed = parse_station_text(synthetic_text("2000-01-01", "2000-03-31"))
    ids = []
    for _ in range(3):
        clock.now += 1
        ids.append(store.add(parsed, (1971, 2000), run_qc(parsed.records)).id)
    assert store.get(ids[0]) is None and store.get(ids[1]) is not None and len(store) == 2


def test_unknown_api_route_uses_error_shape(client: TestClient) -> None:
    assert_error(client.get("/api/nope"), 404, "not_found")
    assert_error(client.put("/api/health"), 405, "method_not_allowed")


def test_static_front_end_with_cache_and_compression(client: TestClient) -> None:
    page = client.get("/", headers={"accept-encoding": "br"})
    assert page.status_code == 200 and "hello" in page.text
    assert page.headers["cache-control"] == "no-cache" and page.headers["content-encoding"] == "br"
    assert "default-src 'self'" in page.headers["content-security-policy"]
    script = client.get("/js/app.js", headers={"accept-encoding": "gzip"})
    assert script.headers["cache-control"] == "public, max-age=604800" and script.headers["content-encoding"] == "gzip"
    versioned = client.get("/js/app.js?v=1")
    assert versioned.headers["cache-control"] == "public, max-age=31536000, immutable"
    unchanged = client.get("/js/app.js", headers={"if-none-match": script.headers["etag"]})
    assert unchanged.status_code == 304
    assert client.get("/nope.js").status_code == 404


def test_api_responses_are_compressed(client: TestClient, dataset: dict) -> None:
    response = client.get(f"/api/datasets/{dataset['id']}/daily", headers={"accept-encoding": "br, gzip"})
    assert response.headers["content-encoding"] == "br"
    assert len(response.json()["values"]) == 4383

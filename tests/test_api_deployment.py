"""Deployment settings: cross-origin access, configurable limits and the request limit.

All of them are off or at their defaults unless environment variables say otherwise.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from climpoc.api.app import create_app
from climpoc.api.config import ApiConfig, ConfigError
from climpoc.api.ratelimit import TokenBuckets, client_address
from climpoc.cli import main
from conftest import synthetic_text

PAGES = "https://example.github.io"
OTHER = "https://evil.example"
SMALL = synthetic_text("2000-01-01", "2000-12-31")


def app_client(**settings: object) -> TestClient:
    return TestClient(create_app(config=ApiConfig(**settings)))  # type: ignore[arg-type]


def preflight(client: TestClient, path: str, method: str, origin: str = PAGES, headers: str = "content-type"):
    request = {"Origin": origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers}
    return client.options(path, headers=request)


# --- configuration -------------------------------------------------------------------------


def test_defaults_when_nothing_is_set() -> None:
    config = ApiConfig.from_env({})
    assert config == ApiConfig()
    assert (config.cors_origins, config.max_datasets, config.max_upload_mb, config.dataset_ttl_minutes) == (
        (),
        50,
        20,
        60,
    )
    assert (config.rate_limit_per_minute, config.trust_proxy) == (0, False)


def test_settings_are_read_from_the_environment() -> None:
    config = ApiConfig.from_env({
        "CLIMPOC_CORS_ORIGINS": "https://example.github.io/, http://localhost:8080",
        "CLIMPOC_MAX_DATASETS": "20", "CLIMPOC_MAX_UPLOAD_MB": "2", "CLIMPOC_DATASET_TTL_MINUTES": "30",
        "CLIMPOC_RATE_LIMIT_PER_MINUTE": "60", "CLIMPOC_TRUST_PROXY": "1",
    })  # fmt: skip
    assert config.cors_origins == ("https://example.github.io", "http://localhost:8080")
    assert config.limits() == {
        "max_upload_mb": 2, "max_datasets": 20, "dataset_ttl_minutes": 30, "rate_limit_per_minute": 60,
    }  # fmt: skip
    assert config.trust_proxy and config.max_upload_bytes == 2 * 1024 * 1024


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("CLIMPOC_CORS_ORIGINS", "*", "is not an origin"),
        ("CLIMPOC_CORS_ORIGINS", "https://*.github.io", "is not an origin"),
        ("CLIMPOC_CORS_ORIGINS", "example.github.io", "is not an origin"),
        ("CLIMPOC_CORS_ORIGINS", "https://example.github.io/app", "is not an origin"),
        ("CLIMPOC_MAX_DATASETS", "many", "is not a whole number"),
        ("CLIMPOC_MAX_DATASETS", "0", "outside the allowed range 1 to 10000"),
        ("CLIMPOC_MAX_UPLOAD_MB", "-5", "outside the allowed range"),
        ("CLIMPOC_DATASET_TTL_MINUTES", "1.5", "is not a whole number"),
        ("CLIMPOC_RATE_LIMIT_PER_MINUTE", "-1", "outside the allowed range"),
        ("CLIMPOC_TRUST_PROXY", "maybe", "use 1 or 0"),
    ],
)
def test_bad_values_are_refused_with_the_variable_name(name: str, value: str, message: str) -> None:
    with pytest.raises(ConfigError, match=name) as caught:
        ApiConfig.from_env({name: value})
    assert message in str(caught.value)


def test_serve_refuses_to_start_with_a_bad_setting(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CLIMPOC_MAX_UPLOAD_MB", "huge")
    assert main(["serve"]) == 2
    assert "Cannot start: CLIMPOC_MAX_UPLOAD_MB: 'huge' is not a whole number." in capsys.readouterr().err


# --- cross-origin access -------------------------------------------------------------------


def test_no_cors_headers_when_unset() -> None:
    client = app_client()
    response = client.get("/api/health", headers={"Origin": PAGES})
    assert response.status_code == 200
    assert not [name for name in response.headers if name.startswith("access-control-")]
    assert preflight(client, "/api/datasets", "POST").status_code == 405, "no preflight handling either"


def test_allowed_origin_gets_headers_without_credentials_or_wildcard() -> None:
    client = app_client(cors_origins=(PAGES,))
    response = client.get("/api/indices", headers={"Origin": PAGES})
    assert response.headers["access-control-allow-origin"] == PAGES
    assert "access-control-allow-credentials" not in response.headers
    assert "Origin" in response.headers["vary"]
    assert "Content-Disposition" in response.headers["access-control-expose-headers"]


def test_other_origins_get_no_headers() -> None:
    client = app_client(cors_origins=(PAGES,))
    response = client.get("/api/indices", headers={"Origin": OTHER})
    assert response.status_code == 200, "the browser, not the server, keeps the page from reading it"
    assert not [name for name in response.headers if name.startswith("access-control-")]
    refused = preflight(client, "/api/datasets", "POST", origin=OTHER)
    assert refused.status_code == 405
    assert not [name for name in refused.headers if name.startswith("access-control-")]


@pytest.mark.parametrize(
    ("path", "method"),
    [("/api/datasets/ds_x/compute", "POST"), ("/api/datasets", "POST"), ("/api/datasets/ds_x", "DELETE"),
     ("/api/datasets/ds_x/export", "GET")],
)  # fmt: skip
def test_preflight_for_json_post_upload_delete_and_download(path: str, method: str) -> None:
    response = preflight(app_client(cors_origins=(PAGES,)), path, method)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == PAGES
    assert set(response.headers["access-control-allow-methods"].split(", ")) == {"GET", "POST", "DELETE", "OPTIONS"}
    assert "content-type" in response.headers["access-control-allow-headers"].lower()
    assert response.headers["access-control-max-age"] == "600"


def test_preflight_refuses_other_methods_and_headers() -> None:
    client = app_client(cors_origins=(PAGES,))
    assert preflight(client, "/api/datasets/ds_x", "PUT").status_code == 400
    assert preflight(client, "/api/datasets", "POST", headers="authorization").status_code == 400


def test_cross_origin_workflow_and_errors_carry_the_headers() -> None:
    client = app_client(cors_origins=(PAGES,), max_upload_mb=1)
    origin = {"Origin": PAGES}
    created = client.post("/api/datasets", files={"file": ("s.txt", SMALL)}, headers=origin)
    assert created.status_code == 201 and created.headers["access-control-allow-origin"] == PAGES
    url = f"/api/datasets/{created.json()['id']}"
    exported = client.get(f"{url}/export", params={"format": "json", "indices": "su"}, headers=origin)
    assert "attachment" in exported.headers["content-disposition"]
    assert "Content-Disposition" in exported.headers["access-control-expose-headers"]
    assert client.delete(url, headers=origin).headers["access-control-allow-origin"] == PAGES
    missing = client.get(url, headers=origin)
    assert missing.status_code == 404 and missing.headers["access-control-allow-origin"] == PAGES
    too_large = client.post("/api/datasets", files={"file": ("big.txt", b"x" * (1024 * 1024 + 2048))}, headers=origin)
    assert too_large.status_code == 413 and too_large.headers["access-control-allow-origin"] == PAGES


def test_unexpected_errors_are_structured_and_readable_cross_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*args: object, **kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr("climpoc.api.app.compute_indices", broken)
    client = app_client(cors_origins=(PAGES,))
    created = client.post("/api/datasets", files={"file": ("s.txt", SMALL)}).json()
    response = client.post(
        f"/api/datasets/{created['id']}/compute", json={"indices": ["su"]}, headers={"Origin": PAGES}
    )
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error" and "boom" not in response.text
    assert response.headers["access-control-allow-origin"] == PAGES


# --- limits ----------------------------------------------------------------------------------


def test_limits_endpoint_reports_defaults_and_settings() -> None:
    assert app_client().get("/api/limits").json() == {
        "max_upload_mb": 20, "max_datasets": 50, "dataset_ttl_minutes": 60, "rate_limit_per_minute": None,
    }  # fmt: skip
    configured = app_client(max_upload_mb=2, max_datasets=3, dataset_ttl_minutes=30, rate_limit_per_minute=120)
    assert configured.get("/api/limits").json() == {
        "max_upload_mb": 2, "max_datasets": 3, "dataset_ttl_minutes": 30, "rate_limit_per_minute": 120,
    }  # fmt: skip


def test_configured_limits_are_enforced() -> None:
    client = app_client(max_upload_mb=1, max_datasets=2, dataset_ttl_minutes=30)
    too_large = client.post("/api/datasets", files={"file": ("big.txt", b"1990 1 1 0 20 10\n" * 70_000)})
    assert too_large.status_code == 413 and "1 MB limit" in too_large.json()["error"]["message"]
    ids = [client.post("/api/datasets", files={"file": ("s.txt", SMALL)}).json() for _ in range(3)]
    assert ids[0]["expires_in_seconds"] == 30 * 60
    assert client.get(f"/api/datasets/{ids[0]['id']}").status_code == 404, "the oldest of three was evicted"
    assert client.get(f"/api/datasets/{ids[2]['id']}").status_code == 200
    assert "30 minutes" in client.get("/api/datasets/ds_gone").json()["error"]["message"]


# --- request limit ---------------------------------------------------------------------------


def test_no_request_limit_by_default() -> None:
    client = app_client()
    assert {client.get("/api/version").status_code for _ in range(40)} == {200}


def test_request_limit_answers_429_with_retry_after() -> None:
    client = app_client(rate_limit_per_minute=3, cors_origins=(PAGES,))
    assert [client.get("/api/version").status_code for _ in range(3)] == [200, 200, 200]
    limited = client.get("/api/version", headers={"Origin": PAGES})
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited" and limited.headers["retry-after"] == "20"
    assert limited.headers["access-control-allow-origin"] == PAGES, "the page must be able to read the refusal"
    assert client.get("/api/health").status_code == 200, "the health check is never limited"
    assert preflight(client, "/api/datasets", "POST").status_code == 200, "nor is a preflight request"


def test_token_bucket_refills_over_time() -> None:
    now = [0.0]
    buckets = TokenBuckets(60, clock=lambda: now[0])
    assert [buckets.take("a") for _ in range(60)] == [0.0] * 60
    assert buckets.take("a") == pytest.approx(1.0), "one token per second at 60 per minute"
    assert buckets.take("b") == 0.0, "other clients are unaffected"
    now[0] = 2.5
    assert [buckets.take("a") > 0 for _ in range(3)] == [False, False, True]


def test_client_address_uses_forwarded_header_only_when_trusted() -> None:
    scope = {"client": ("10.0.0.1", 1234), "headers": [(b"x-forwarded-for", b"203.0.113.9, 198.51.100.7")]}
    assert client_address(scope, trust_proxy=False) == "10.0.0.1"
    assert client_address(scope, trust_proxy=True) == "198.51.100.7", "the entry added by the trusted proxy"
    assert client_address({"client": ("10.0.0.1", 1), "headers": []}, trust_proxy=True) == "10.0.0.1"

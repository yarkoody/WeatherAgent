"""API clients for the three public data sources, and the snapshot refresh.

`python -m app.data` (or `make data`) fetches NRI and Open-Meteo data for every hub
and writes the committed snapshot in `data/snapshot/`. Scoring reads only that
snapshot. NWS alerts are fetched live by the tool and the alert job.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.schemas import Hub

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

NRI_URL = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/"
    "National_Risk_Index_Counties/FeatureServer/0/query"
)
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
NWS_URL = "https://api.weather.gov/alerts/active"
NWS_USER_AGENT = "weather-risk-agent (demo)"

NRI_FIELDS = (
    "HRCN_AFREQ", "IFLD_AFREQ", "CFLD_AFREQ", "WNTW_AFREQ", "ISTM_AFREQ",
    "CWAV_AFREQ", "TRND_AFREQ", "SWND_AFREQ", "HAIL_AFREQ",
    "POPULATION", "AREA", "RESL_SCORE",
)
DAILY_VARS = ("snowfall_sum", "precipitation_sum", "wind_gusts_10m_max", "temperature_2m_min")
NWS_KEEP = ("event", "severity", "headline", "expires")

SNAPSHOT_START = "2015-01-01"
SNAPSHOT_END = "2025-12-31"

TIMEOUT_SECONDS = 10.0  # batch snapshot clients (NRI, Open-Meteo)
RETRIES = 2
NWS_TIMEOUT_SECONDS = 5.0  # live NWS call inside a chat turn: fail fast
NWS_RETRIES = 1
BACKOFF_SECONDS = 1.0  # doubled on each retry; tests set it to 0
# Open-Meteo weighs an 11-year, 4-variable request as ~115 calls (limit 600/minute).
REFRESH_PAUSE_SECONDS = 15.0


class UpstreamError(Exception):
    """An external API failed after all retries, or returned data we cannot use.

    `retryable` is False for client errors (4xx other than 429): asking again will not help.
    """

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


def _get_json(
    url: str,
    params: dict[str, Any],
    headers: dict[str, str] | None = None,
    *,
    timeout: float | None = None,
    retries: int | None = None,
) -> dict:
    """GET JSON; retries only transport errors and 5xx, with exponential backoff."""
    timeout = TIMEOUT_SECONDS if timeout is None else timeout
    retries = RETRIES if retries is None else retries
    last: Exception | None = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(BACKOFF_SECONDS * 2 ** (attempt - 1))
        try:
            resp = httpx.get(url, params=params, headers=headers, timeout=timeout)
        except httpx.TransportError as exc:
            last = exc
            continue
        if resp.status_code >= 500:
            last = httpx.HTTPStatusError(f"HTTP {resp.status_code}", request=resp.request, response=resp)
            continue
        if resp.status_code >= 400:
            raise UpstreamError(f"{url} returned HTTP {resp.status_code}", retryable=resp.status_code == 429)
        try:
            return resp.json()
        except ValueError as exc:
            raise UpstreamError(f"{url} returned invalid JSON: {exc}", retryable=False) from exc
    raise UpstreamError(f"{url} failed after {retries + 1} attempts: {last}")


def fetch_nri(fips_list: list[str]) -> dict[str, dict[str, float | None]]:
    """NRI county fields for each FIPS code. Null values stay None."""
    where = "STCOFIPS IN (" + ",".join(f"'{f}'" for f in fips_list) + ")"
    body = _get_json(NRI_URL, {
        "where": where,
        "outFields": ",".join(("STCOFIPS", *NRI_FIELDS)),
        "returnGeometry": "false",
        "f": "json",
    })
    if "error" in body:
        raise UpstreamError(f"NRI query error: {body['error']}")
    out = {}
    for feature in body.get("features", []):
        attrs = feature["attributes"]
        out[attrs["STCOFIPS"]] = {k: attrs.get(k) for k in NRI_FIELDS}
    missing = set(fips_list) - set(out)
    if missing:
        raise UpstreamError(f"NRI returned no row for FIPS {sorted(missing)}")
    return out


def fetch_weather(hub: Hub, start: str, end: str) -> dict[str, list]:
    """Open-Meteo daily archive for the hub point: time plus the four daily variables."""
    body = _get_json(OPEN_METEO_URL, {
        "latitude": hub.lat,
        "longitude": hub.lon,
        "start_date": start,
        "end_date": end,
        "daily": ",".join(DAILY_VARS),
        "timezone": "auto",
    })
    try:
        daily = body["daily"]
        return {"time": daily["time"], **{v: daily[v] for v in DAILY_VARS}}
    except (KeyError, TypeError) as exc:
        raise UpstreamError(f"Open-Meteo response missing {exc}") from exc


def fetch_nws_alerts(lat: float, lon: float) -> list[dict[str, str | None]]:
    """Active NWS alerts at a point. Free-text description and instruction are dropped."""
    body = _get_json(
        NWS_URL,
        {"point": f"{lat:.4f},{lon:.4f}"},
        headers={"User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json"},
        timeout=NWS_TIMEOUT_SECONDS,
        retries=NWS_RETRIES,
    )
    alerts = []
    for feature in body.get("features", []):
        props = feature.get("properties", {})
        alerts.append({k: props.get(k) for k in NWS_KEEP})
    return alerts


def _write_atomic(path: Path, payload: dict) -> None:
    """Write to a temp file in the same folder, then rename over the target."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(payload, indent=1) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def refresh(data_dir: Path = DATA_DIR) -> None:
    """Fetch NRI and Open-Meteo data for every hub and write data/snapshot/*.json."""
    hubs = [Hub(**h) for h in json.loads((data_dir / "hubs.json").read_text())]
    snap = data_dir / "snapshot"
    snap.mkdir(parents=True, exist_ok=True)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Fetch everything first; write only when every call succeeded, so a failed run keeps the old snapshot.
    nri = fetch_nri([h.county_fips for h in hubs])
    weather = {}
    for i, hub in enumerate(hubs):
        if i:
            time.sleep(REFRESH_PAUSE_SECONDS)  # stay under the Open-Meteo per-minute limit
        weather[hub.id] = fetch_weather(hub, SNAPSHOT_START, SNAPSHOT_END)
    _write_atomic(snap / "nri.json", {"fetched_at": fetched_at, "source": NRI_URL, "counties": nri})
    _write_atomic(snap / "weather.json", {
        "fetched_at": fetched_at, "source": OPEN_METEO_URL,
        "start": SNAPSHOT_START, "end": SNAPSHOT_END, "hubs": weather,
    })


if __name__ == "__main__":
    refresh()
    print("snapshot written to", DATA_DIR / "snapshot")

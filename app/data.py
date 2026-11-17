"""API clients for the three public data sources, and the snapshot refresh.

`python -m app.data` (or `make data`) fetches NRI and Open-Meteo data for every hub
and writes the committed snapshot in `data/snapshot/`. Scoring reads only that
snapshot. NWS alerts are fetched live by the tool and the alert job.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
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
_METRO_BASE = "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files"
METRO_LIST1_URL = f"{_METRO_BASE}/list1_2023.xlsx"  # county -> CBSA
METRO_LIST2_URL = f"{_METRO_BASE}/list2_2023.xlsx"  # principal cities per CBSA
CBSA_POP_URL = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/metro/totals/cbsa-est2024-alldata.csv"
CBSA_POP_VINTAGE = "Census Bureau population estimates, Vintage 2024 (July 1 estimates), CBSA totals"
METRO_DELINEATION = "OMB Bulletin 23-01, July 2023 metropolitan and micropolitan delineations (Census files)"

STATE_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR",
}

NRI_FIELDS = (
    "HRCN_AFREQ", "IFLD_AFREQ", "CFLD_AFREQ", "WNTW_AFREQ", "ISTM_AFREQ",
    "CWAV_AFREQ", "TRND_AFREQ", "SWND_AFREQ", "HAIL_AFREQ",
    "POPULATION", "AREA", "RESL_SCORE",
    "CFLD_EXP_AREA",  # sq mi of the county exposed to coastal flooding (scales coastal-flood frequency)
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
    resp = _get(url, params, headers, timeout=timeout, retries=retries)
    try:
        return resp.json()
    except ValueError as exc:
        raise UpstreamError(f"{url} returned invalid JSON: {exc}", retryable=False) from exc


def _get(
    url: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    *,
    timeout: float | None = None,
    retries: int | None = None,
) -> httpx.Response:
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
        return resp
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


# ---------- OMB metro areas (city -> CBSA -> hub) ----------

_XL = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def xlsx_table(content: bytes, first_header: str) -> list[dict[str, str | None]]:
    """Rows of the first sheet of an .xlsx, keyed by the header row whose first cell is `first_header`.

    Standard library only (an .xlsx is a zip of XML). Only data rows whose first cell is a numeric code are
    kept, which skips the Census files' title, note and source lines.
    """
    z = zipfile.ZipFile(io.BytesIO(content))
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{_XL}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_XL}t")))
    header: dict[str, str] | None = None
    out = []
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(f"{_XL}row"):
        cells: dict[str, str | None] = {}
        for c in row.findall(f"{_XL}c"):
            col = re.match(r"[A-Z]+", c.get("r", "")).group()
            v = c.find(f"{_XL}v")
            if c.get("t") == "s" and v is not None:
                cells[col] = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                cells[col] = "".join(t.text or "" for t in c.iter(f"{_XL}t"))
            else:
                cells[col] = None if v is None else v.text
        if header is None:
            if cells.get("A") == first_header:
                header = {col: name for col, name in cells.items() if name}
            continue
        if re.fullmatch(r"\d+", cells.get("A") or ""):
            out.append({name: cells.get(col) for col, name in header.items()})
    if header is None:
        raise UpstreamError(f"no header row starting with {first_header!r}", retryable=False)
    return out


def build_metro_cities(list1: list[dict], list2: list[dict], hubs: list[Hub]) -> dict:
    """Every principal city (name, state) -> CBSA, and each CBSA's title, type and hub (if a hub county is in it)."""
    county_cbsa = {}
    cbsas: dict[str, dict] = {}
    for r in list1:
        county_cbsa[r["FIPS State Code"].zfill(2) + r["FIPS County Code"].zfill(3)] = r["CBSA Code"]
        kind = r["Metropolitan/Micropolitan Statistical Area"]
        cbsas[r["CBSA Code"]] = {"title": r["CBSA Title"],
                                 "type": "Metropolitan" if kind.startswith("Metropolitan") else "Micropolitan",
                                 "hub_id": None}
    for hub in sorted(hubs, key=lambda h: h.id):
        code = county_cbsa.get(hub.county_fips)
        if code is None:
            raise UpstreamError(f"hub county {hub.county_fips} ({hub.id}) is in no CBSA", retryable=False)
        cbsas[code]["hub_id"] = hub.id
    cities = {(r["Principal City Name"], STATE_FIPS.get(r["FIPS State Code"].zfill(2), r["FIPS State Code"]),
               r["CBSA Code"]) for r in list2}
    for _, _, code in cities:
        cbsas.setdefault(code, {"title": "", "type": "", "hub_id": None})
    return {
        "source": {"list1": METRO_LIST1_URL, "list2": METRO_LIST2_URL, "delineation": METRO_DELINEATION},
        "cbsas": dict(sorted(cbsas.items())),
        "cities": [{"name": n, "state": st, "cbsa": code} for n, st, code in sorted(cities)],
    }


def fetch_metro_cities(hubs: list[Hub]) -> dict:
    list1 = xlsx_table(_get(METRO_LIST1_URL, timeout=30.0).content, first_header="CBSA Code")
    list2 = xlsx_table(_get(METRO_LIST2_URL, timeout=30.0).content, first_header="CBSA Code")
    return build_metro_cities(list1, list2, hubs)


def _load_hubs(data_dir: Path) -> list[Hub]:
    return [Hub(**h) for h in json.loads((data_dir / "hubs.json").read_text())]


def fetch_metro_population(hub_cbsa: dict[str, str]) -> dict:
    """Latest population estimate of each hub's metro area (CBSA total row), from the Census CSV (latin-1)."""
    text = _get(CBSA_POP_URL, timeout=30.0).content.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    years = sorted(int(c[len("POPESTIMATE"):]) for c in reader.fieldnames or [] if re.fullmatch(r"POPESTIMATE\d{4}", c))
    if not years:
        raise UpstreamError("population file has no POPESTIMATE columns", retryable=False)
    col = f"POPESTIMATE{years[-1]}"
    totals = {r["CBSA"]: r for r in reader if not r["MDIV"] and not r["STCOU"]}  # CBSA total rows only
    missing = sorted(code for code in hub_cbsa.values() if code not in totals)
    if missing:
        raise UpstreamError(f"population file has no total row for CBSA {missing}", retryable=False)
    return {
        "source": CBSA_POP_URL, "vintage": CBSA_POP_VINTAGE, "year": years[-1],
        "hubs": {hub: {"cbsa": code, "name": totals[code]["NAME"], "population": int(totals[code][col])}
                 for hub, code in sorted(hub_cbsa.items())},
    }


def _hub_cbsas(metro: dict) -> dict[str, str]:
    return {v["hub_id"]: code for code, v in metro["cbsas"].items() if v.get("hub_id")}


def refresh_population(data_dir: Path = DATA_DIR) -> None:
    """Rebuild data/snapshot/metro_population.json from the committed metro_cities.json (`python -m app.data population`)."""
    metro = json.loads((data_dir / "metro_cities.json").read_text())
    pop = fetch_metro_population(_hub_cbsas(metro))
    pop["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (data_dir / "snapshot").mkdir(parents=True, exist_ok=True)
    _write_atomic(data_dir / "snapshot" / "metro_population.json", pop)


def refresh_metro(data_dir: Path = DATA_DIR) -> None:
    """Rebuild data/metro_cities.json only (`python -m app.data metro`)."""
    metro = fetch_metro_cities(_load_hubs(data_dir))
    metro["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _write_atomic(data_dir / "metro_cities.json", metro)


def _write_atomic(path: Path, payload: dict) -> None:
    """Write to a temp file in the same folder, then rename over the target."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(payload, indent=1) + "\n")
        os.chmod(tmp, 0o644)  # mkstemp creates 0600; data files are ordinary readable files
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def refresh(data_dir: Path = DATA_DIR) -> None:
    """Fetch NRI, Open-Meteo and the OMB metro lists; write data/snapshot/*.json and data/metro_cities.json."""
    hubs = _load_hubs(data_dir)
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
    metro = fetch_metro_cities(hubs)
    metro["fetched_at"] = fetched_at
    population = fetch_metro_population(_hub_cbsas(metro))
    population["fetched_at"] = fetched_at
    _write_atomic(snap / "nri.json", {"fetched_at": fetched_at, "source": NRI_URL, "counties": nri})
    _write_atomic(snap / "weather.json", {
        "fetched_at": fetched_at, "source": OPEN_METEO_URL,
        "start": SNAPSHOT_START, "end": SNAPSHOT_END, "hubs": weather,
    })
    _write_atomic(data_dir / "metro_cities.json", metro)
    _write_atomic(snap / "metro_population.json", population)


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["metro"]:
        refresh_metro()
        print("written", DATA_DIR / "metro_cities.json")
    elif sys.argv[1:] == ["population"]:
        refresh_population()
        print("written", DATA_DIR / "snapshot" / "metro_population.json")
    else:
        refresh()
        print("snapshot written to", DATA_DIR / "snapshot", "and", DATA_DIR / "metro_cities.json")

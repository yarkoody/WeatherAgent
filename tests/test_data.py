"""A1: API clients for NRI, Open-Meteo and NWS, on recorded fixtures (no network)."""

import json
from pathlib import Path

import httpx
import pytest
import respx

from app import data
import io
import zipfile
from xml.sax.saxutils import escape

from app.data import METRO_LIST1_URL, METRO_LIST2_URL, NRI_URL, NWS_URL, OPEN_METEO_URL, UpstreamError
from app.schemas import Hub

FIX = Path(__file__).parent / "fixtures"


def _fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text())


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(data, "BACKOFF_SECONDS", 0.0)


MIAMI = Hub(
    id="miami", name="Miami Hub", city="Miami", state="FL", region="South",
    lat=25.7617, lon=-80.1918, county_fips="12086",
)


@respx.mock
def test_fetch_nri_parses_fields():
    respx.get(NRI_URL).mock(return_value=httpx.Response(200, json=_fixture("nri_query.json")))
    out = data.fetch_nri(["12086", "48201"])
    assert set(out) == {"12086", "48201"}
    assert set(out["12086"]) == set(data.NRI_FIELDS)
    assert out["12086"]["HRCN_AFREQ"] == pytest.approx(0.305, abs=1e-3)
    assert out["12086"]["ISTM_AFREQ"] is None  # null in NRI is kept as null, not 0
    assert out["48201"]["POPULATION"] == 4726200
    assert out["12086"]["CFLD_EXP_AREA"] == pytest.approx(134.45, abs=0.01)  # sq mi exposed to coastal flood


@respx.mock
def test_fetch_nri_missing_county_raises():
    respx.get(NRI_URL).mock(return_value=httpx.Response(200, json=_fixture("nri_query.json")))
    with pytest.raises(UpstreamError):
        data.fetch_nri(["12086", "48201", "99999"])


@respx.mock
def test_fetch_weather_parses_daily():
    route = respx.get(OPEN_METEO_URL).mock(
        return_value=httpx.Response(200, json=_fixture("openmeteo_archive.json"))
    )
    out = data.fetch_weather(MIAMI, "2025-01-01", "2025-01-05")
    assert set(out) == {"time", *data.DAILY_VARS}
    assert out["time"][0] == "2025-01-01"
    assert len(out["wind_gusts_10m_max"]) == 5
    params = route.calls.last.request.url.params
    assert params["timezone"] == "auto"
    assert params["start_date"] == "2025-01-01"


@respx.mock
def test_nws_alerts_drop_free_text():
    route = respx.get(NWS_URL).mock(return_value=httpx.Response(200, json=_fixture("nws_alerts.json")))
    alerts = data.fetch_nws_alerts(39.7392, -104.9903)
    assert alerts[0] == {
        "event": "Winter Weather Advisory",
        "severity": "Moderate",
        "headline": "Winter Weather Advisory issued November 17 at 11:00AM MST until November 18 at 5:00AM MST by NWS Boulder CO",
        "expires": "2026-11-18T05:00:00-07:00",
    }
    assert alerts[1]["expires"] is None
    assert all(set(a) == {"event", "severity", "headline", "expires"} for a in alerts)
    request = route.calls.last.request
    assert request.headers["User-Agent"] == "weather-risk-agent (demo)"
    assert request.url.params["point"] == "39.7392,-104.9903"


@respx.mock
def test_client_retries_then_raises_upstream_error():
    route = respx.get(OPEN_METEO_URL).mock(side_effect=httpx.ConnectTimeout("timeout"))
    with pytest.raises(UpstreamError):
        data.fetch_weather(MIAMI, "2025-01-01", "2025-01-05")
    assert route.call_count == 3  # first try + 2 retries


@respx.mock
def test_client_retries_then_succeeds():
    route = respx.get(NWS_URL).mock(
        side_effect=[httpx.Response(503), httpx.Response(200, json=_fixture("nws_alerts.json"))]
    )
    assert len(data.fetch_nws_alerts(39.7, -105.0)) == 2
    assert route.call_count == 2


def test_client_uses_10s_timeout():
    assert data.TIMEOUT_SECONDS == 10.0
    assert data.RETRIES == 2


@respx.mock
def test_client_does_not_retry_4xx():
    route = respx.get(NRI_URL).mock(return_value=httpx.Response(404))
    with pytest.raises(UpstreamError) as exc:
        data.fetch_nri(["12086"])
    assert route.call_count == 1
    assert exc.value.retryable is False


@respx.mock
def test_server_errors_are_retryable():
    respx.get(NRI_URL).mock(return_value=httpx.Response(502))
    with pytest.raises(UpstreamError) as exc:
        data.fetch_nri(["12086"])
    assert exc.value.retryable is True


@respx.mock
def test_nws_uses_short_timeout_and_one_retry():
    route = respx.get(NWS_URL).mock(side_effect=httpx.ConnectTimeout("timeout"))
    with pytest.raises(UpstreamError):
        data.fetch_nws_alerts(39.7, -105.0)
    assert route.call_count == 2  # first try + 1 retry
    assert route.calls.last.request.extensions["timeout"]["connect"] == 5.0


def _hubs_dir(tmp_path):
    (tmp_path / "hubs.json").write_text(json.dumps([MIAMI.model_dump()]))
    snap = tmp_path / "snapshot"
    snap.mkdir()
    return snap


@respx.mock
def test_refresh_writes_nothing_when_a_fetch_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "REFRESH_PAUSE_SECONDS", 0.0)
    snap = _hubs_dir(tmp_path)
    (snap / "nri.json").write_text("old nri")
    (snap / "weather.json").write_text("old weather")
    respx.get(NRI_URL).mock(return_value=httpx.Response(200, json=_fixture("nri_query.json")))
    respx.get(OPEN_METEO_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(UpstreamError):
        data.refresh(tmp_path)
    assert (snap / "nri.json").read_text() == "old nri"
    assert (snap / "weather.json").read_text() == "old weather"
    assert sorted(p.name for p in snap.iterdir()) == ["nri.json", "weather.json"]


@respx.mock
def test_refresh_writes_both_snapshot_files(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "REFRESH_PAUSE_SECONDS", 0.0)
    snap = _hubs_dir(tmp_path)
    respx.get(NRI_URL).mock(return_value=httpx.Response(200, json=_fixture("nri_query.json")))
    respx.get(OPEN_METEO_URL).mock(return_value=httpx.Response(200, json=_fixture("openmeteo_archive.json")))
    _mock_metro_lists()
    data.refresh(tmp_path)
    metro = json.loads((tmp_path / "metro_cities.json").read_text())
    assert metro["cbsas"]["33100"]["hub_id"] == "miami"
    nri = json.loads((snap / "nri.json").read_text())
    weather = json.loads((snap / "weather.json").read_text())
    assert nri["fetched_at"] == weather["fetched_at"]
    assert "12086" in nri["counties"] and "miami" in weather["hubs"]
    assert sorted(p.name for p in snap.iterdir()) == ["nri.json", "weather.json"]


# ---------- OMB metro delineations ----------

LIST1 = [
    ["List 1. CORE BASED STATISTICAL AREAS (CBSAs)..."],
    ["CBSA Code", "Metropolitan Division Code", "CSA Code", "CBSA Title", "Metropolitan/Micropolitan Statistical Area",
     "Metropolitan Division Title", "CSA Title", "County/County Equivalent", "State Name", "FIPS State Code",
     "FIPS County Code", "Central/Outlying County"],
    ["33100", None, None, "Miami-Fort Lauderdale-West Palm Beach, FL", "Metropolitan Statistical Area", None, None,
     "Miami-Dade County", "Florida", "12", "086", "Central"],
    ["14460", None, None, "Boston-Cambridge-Newton, MA-NH", "Metropolitan Statistical Area", None, None,
     "Suffolk County", "Massachusetts", "25", "025", "Central"],
    ["Source: File prepared by U.S. Census Bureau"],
]
LIST2 = [
    ["List 2. PRINCIPAL CITIES..."],
    ["CBSA Code", "CBSA Title", "Metropolitan/Micropolitan Statistical Area", "Principal City Name", "FIPS State Code",
     "FIPS Place Code"],
    ["33100", "Miami-Fort Lauderdale-West Palm Beach, FL", "Metropolitan Statistical Area", "Miami", "12", "45000"],
    ["33100", "Miami-Fort Lauderdale-West Palm Beach, FL", "Metropolitan Statistical Area", "Fort Lauderdale", "12", "24000"],
    ["14460", "Boston-Cambridge-Newton, MA-NH", "Metropolitan Statistical Area", "Boston", "25", "07000"],
    ["38860", "Portland-South Portland, ME", "Metropolitan Statistical Area", "Portland", "23", "60545"],
    ["Note: The Office of Management and Budget's (OMB's) 2020 Standards"],
]


def _xlsx(rows):
    """A minimal .xlsx (inline strings) like the Census files, built in memory."""
    cols = "ABCDEFGHIJKL"
    body = "".join(
        f'<row r="{i}">' + "".join(
            f'<c r="{cols[j]}{i}" t="inlineStr"><is><t>{escape(v)}</t></is></c>'
            for j, v in enumerate(row) if v is not None) + "</row>"
        for i, row in enumerate(rows, start=1))
    sheet = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f"<sheetData>{body}</sheetData></worksheet>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def _mock_metro_lists():
    respx.get(METRO_LIST1_URL).mock(return_value=httpx.Response(200, content=_xlsx(LIST1)))
    respx.get(METRO_LIST2_URL).mock(return_value=httpx.Response(200, content=_xlsx(LIST2)))


def test_xlsx_table_reads_rows_under_the_header():
    rows = data.xlsx_table(_xlsx(LIST2), first_header="CBSA Code")
    assert len(rows) == 4  # title, header, note and source lines are skipped
    assert rows[0]["Principal City Name"] == "Miami" and rows[0]["FIPS State Code"] == "12"


def test_build_metro_cities_links_hub_cbsas():
    list1 = data.xlsx_table(_xlsx(LIST1), first_header="CBSA Code")
    list2 = data.xlsx_table(_xlsx(LIST2), first_header="CBSA Code")
    out = data.build_metro_cities(list1, list2, [MIAMI])
    assert out["cbsas"]["33100"] == {"title": "Miami-Fort Lauderdale-West Palm Beach, FL", "type": "Metropolitan",
                                     "hub_id": "miami"}
    assert out["cbsas"]["14460"]["hub_id"] is None
    assert {"name": "Fort Lauderdale", "state": "FL", "cbsa": "33100"} in out["cities"]
    assert {"name": "Portland", "state": "ME", "cbsa": "38860"} in out["cities"]
    assert out["source"]["list1"] == METRO_LIST1_URL and "July 2023" in out["source"]["delineation"]


@respx.mock
def test_refresh_metro_writes_only_the_metro_file(tmp_path):
    _hubs_dir(tmp_path)
    _mock_metro_lists()
    data.refresh_metro(tmp_path)
    metro = json.loads((tmp_path / "metro_cities.json").read_text())
    assert metro["cbsas"]["33100"]["hub_id"] == "miami"
    assert sorted(p.name for p in (tmp_path / "snapshot").iterdir()) == []
    assert (tmp_path / "metro_cities.json").stat().st_mode & 0o777 == 0o644  # readable data file, like a normal write

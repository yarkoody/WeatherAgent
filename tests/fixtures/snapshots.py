"""Small hand-built snapshot for scoring and tool tests (no network)."""

from datetime import date, timedelta

from app.schemas import Hub
from app.scoring import Snapshot

FETCHED_AT = "2026-11-17T09:00:00+00:00"


def _nri(**kw):
    base = dict(HRCN_AFREQ=0, IFLD_AFREQ=0, CFLD_AFREQ=0, WNTW_AFREQ=0, ISTM_AFREQ=0, CWAV_AFREQ=0,
                TRND_AFREQ=0, SWND_AFREQ=0, HAIL_AFREQ=0, POPULATION=1_000_000, AREA=500, RESL_SCORE=50)
    base.update(kw)
    return base


def _weather(snow=0, cold=0, rain=0, gust=0, trace=0):
    """Every year 2015-2025: day-of-year ranges get extreme values.

    snow >= 5 cm on days [0, snow); tmin -20 C on days [0, cold); rain 60 mm on days [100, 100+rain);
    gust 80 km/h on days [200, 200+gust); trace snowfall 0.1 cm on days [300, 300+trace) and 0.09 cm on day 330.
    """
    out = {"time": [], "snowfall_sum": [], "precipitation_sum": [], "wind_gusts_10m_max": [], "temperature_2m_min": []}
    d = date(2015, 1, 1)
    while d <= date(2025, 12, 31):
        i = d.timetuple().tm_yday - 1
        s = 6.0 if i < snow else 0.1 if 300 <= i < 300 + trace else 0.09 if i == 330 else 0.0
        out["time"].append(d.isoformat())
        out["snowfall_sum"].append(s)
        out["temperature_2m_min"].append(-20.0 if i < cold else 5.0)
        out["precipitation_sum"].append(60.0 if 100 <= i < 100 + rain else 1.0)
        out["wind_gusts_10m_max"].append(80.0 if 200 <= i < 200 + gust else 20.0)
        d += timedelta(days=1)
    return out


# delta is listed first and has alpha's exact data, so ties must break by hub_id, not list order.
HUBS = [
    Hub(id="delta", name="Delta Hub", city="Delta", state="NJ", region="Northeast", lat=40.0, lon=-74.0, county_fips="00001"),
    Hub(id="alpha", name="Alpha Hub", city="Alpha", state="IL", region="Midwest", lat=41.0, lon=-87.0, county_fips="00001"),
    Hub(id="bravo", name="Bravo Hub", city="Bravo", state="FL", region="South", lat=26.0, lon=-80.0, county_fips="00002"),
    Hub(id="charlie", name="Charlie Hub", city="Charlie", state="CO", region="West", lat=39.0, lon=-105.0, county_fips="00003"),
]

ALPHA_WEATHER = _weather(snow=5, cold=8, rain=3, gust=2, trace=3)

SNAPSHOT = Snapshot(
    nri={"fetched_at": FETCHED_AT, "source": "test", "counties": {
        "00001": _nri(WNTW_AFREQ=10, ISTM_AFREQ=1, CWAV_AFREQ=2, IFLD_AFREQ=2, CFLD_AFREQ=None, HRCN_AFREQ=None,
                      TRND_AFREQ=0.4, SWND_AFREQ=4, HAIL_AFREQ=4, POPULATION=2_500_000, AREA=500, RESL_SCORE=60),
        "00002": _nri(HRCN_AFREQ=0.3, IFLD_AFREQ=8, CFLD_AFREQ=2, ISTM_AFREQ=None, TRND_AFREQ=2, SWND_AFREQ=2,
                      HAIL_AFREQ=2, POPULATION=6_000_000, AREA=4000, RESL_SCORE=20,
                      CFLD_EXP_AREA=400),
        "00003": _nri(WNTW_AFREQ=40, ISTM_AFREQ=5, CWAV_AFREQ=10, POPULATION=1_000_000, AREA=30, RESL_SCORE=90),
    }},
    weather={"fetched_at": FETCHED_AT, "source": "test", "start": "2015-01-01", "end": "2025-12-31", "hubs": {
        "alpha": ALPHA_WEATHER,
        "delta": ALPHA_WEATHER,
        "bravo": _weather(rain=5, gust=1),
        "charlie": _weather(snow=30, cold=30),
    }},
)

"""The Docker image must contain every data file the app reads at runtime.

A deploy once shipped without data/metro_cities.json and data/jev_second_opinion.json because the
Dockerfile copied only a hand-picked list, so city resolution and the JEV column silently failed live.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_dockerfile_copies_all_runtime_data_files():
    dockerfile = (ROOT / "Dockerfile").read_text()
    copies = re.findall(r"^COPY\s+(?!--from)(\S+)\s+(\S+)", dockerfile, flags=re.M)
    sources = {src.rstrip("/") for src, _ in copies}
    for needed in sorted(p for p in (ROOT / "data").glob("*.json")):
        rel = needed.relative_to(ROOT).as_posix()
        assert "data" in sources or rel in sources, f"{rel} is not copied into the image"


def test_dockerignore_keeps_the_local_database_out():
    assert "data/app.db" in (ROOT / ".dockerignore").read_text().split()

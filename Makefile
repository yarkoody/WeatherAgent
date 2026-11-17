.PHONY: setup data run test eval alerts web jev

setup:
	uv sync
	cd web && npm ci

data:
	uv run python -m app.data

run:
	uv run uvicorn app.api:app --reload

test:
	uv run pytest

eval:
	uv run python -m evals.run

alerts:
	uv run python -m app.alerts

web:
	cd web && npm run build

jev:
	uv run python -m evals.jev_crosscheck

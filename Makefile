# DarkFleet canonical commands. Windows devs: run the same tools directly
# (backend/.venv/Scripts/python.exe -m pytest ...). CI/Docker use these targets.

.PHONY: backend-test backend-lint backend-typecheck frontend-test frontend-typecheck frontend-build test e2e

backend-test:
	cd backend && uv run --python 3.12 pytest tests -q

backend-lint:
	cd backend && uv run --python 3.12 ruff check darkfleet tests

backend-typecheck:
	cd backend && uv run --python 3.12 mypy --config-file pyproject.toml darkfleet

frontend-test:
	npx vitest run

frontend-typecheck:
	npx tsc --noEmit

frontend-build:
	npx vite build

test: backend-test backend-lint backend-typecheck frontend-test frontend-typecheck

e2e:
	npx playwright test

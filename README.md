# DarkFleet

Maritime SAR/AIS correlation, Apache-2.0.

**The Python backend is the single analytical authority.** It reads real SAR from a
provider STAC catalogue, detects, correlates against AIS, and produces the
evidence. The frontend is an API consumer and renders what the backend decided.
There is **no DEMO/synthetic mode**: every scan is a REAL scan against a live
provider, and a provider that cannot serve the request returns an error rather
than substituting data.

## Run Locally

Two processes: the Python API and the Vite dev server. **The API must be running
for the UI to work** — there is no local analysis path in the browser to fall
back on.

**Prerequisites:** Node.js, and Python 3.12 for the backend.

### 1. Start the backend (serves the API on `http://127.0.0.1:8000`)

```bash
cd backend
uv run --python 3.12 python -m darkfleet --reload
```

`python -m darkfleet --check` builds the app, prints the route table and exits
without binding a port — useful as a smoke test. `uv` is the expected runner
(`make backend-test` uses it); an existing virtualenv works too, e.g.
`backend/.venv/Scripts/python -m darkfleet` on Windows.

Copy `.env.example` to `.env` first if you want to add provider credentials.
None are required to start: with no credentials the providers report their real
state (`AUTH_REQUIRED` / `NOT_CONFIGURED`) through `GET /api/providers/health`
rather than pretending to be online.

`GET /api/targets/{id}/summary` writes its narrative with a **deterministic
template** (`darkfleet/template@1`) — no model call, so nothing to configure and
nothing that can fabricate. `GEMINI_API_KEY` is still listed in `.env.example`
for a future adapter, but no backend module reads it today.

### 2. Start the frontend

```bash
npm install
npm run dev
```

`npm run dev` is now **Vite**, not an Express server. It serves the app and
proxies `/api` to the Python backend at `http://127.0.0.1:8000`; point it
elsewhere with `DARKFLEET_API_URL`:

```bash
DARKFLEET_API_URL=http://192.168.1.10:8000 npm run dev
```

`npm start` is `vite preview` and serves a production build from `dist/`, so it
needs `npm run build` first.

### Docker instead

```bash
cp .env.example .env    # optional: add provider credentials
docker compose up --build
```

API on `http://localhost:8000` (OpenAPI docs at `/docs`), web on
`http://localhost:8080`. Data persists in the `darkfleet-data` volume; back it
up, because the AIS archive cannot be rebuilt retroactively.

## Tests

```bash
make test          # backend pytest + ruff + strict mypy + frontend vitest + tsc
```

Individually: `make backend-test`, `make frontend-test`, `make frontend-build`.
The backend suite exercises the **real** pipeline offline by reading a
checked-in GeoTIFF fixture — there is no scene synthesiser anywhere in this
project, in product code or in tests.

## Documentation

| | |
|---|---|
| `docs/METHODOLOGY.md` | how a detection becomes evidence, stage by stage |
| `docs/LIMITATIONS.md` | what this tool does not do, and where not to trust it |
| `docs/CURRENT_STATE.md` | CP0 takeover inventory, with later dispositions marked |
| `docs/REMOVALS.md` | every intentional removal, dated, with verification |
| `docs/MASTER_FEATURE_PARITY.md` | feature-by-feature parity matrix |
| `docs/PROVENANCE.md` | third-party data and code licences, and what was adopted |
| `docs/SECURITY.md` | threat model and known limitations |
| `docs/EXECUTION_LEDGER.md` | append-only checkpoint log with evidence |

Licence: Apache-2.0. Third-party assets keep their own terms — see
`docs/PROVENANCE.md` before asking whether you may use this commercially.
# Execution Ledger

> Append-only. One entry per checkpoint with proof, never claims.

## CP0 — Baseline, research, environments (2026-10-01)

- Re-verified prior artifacts instead of trusting them: pytest 5/5, ruff clean,
  mypy strict clean (7 files), tsc clean, vitest 6/6, npm 240 pkgs / 0 vulns.
- Research complete: RES-SAR (provider probes), RES-AIS (5 sources + pyais),
  RES-AUX (9 datasets), RES-ML (datasets + no-weights verdict).
- Key corrections adopted: CDSE S-1 BLOCKED (no collections, 400 was wrong ID);
  EarthSearch GCP-referenced (210 GCPs, warp path); MarineCadastre = keyless
  historical AIS; WorldCover 10 m = primary mask; deterministic CV path.
- 11 plan docs written; PLAN_LOCK.json populated; commit follows.
- Status: ✅ VERIFIED.

# Feature Preservation Contract

> Complements `UI_FEATURE_MIGRATION.md` (UI surface) with **non-UI** capabilities
> that must survive the rebuild. Each row: capability → where it lives now →
> where it must live → gate that proves it.

| Capability | Lives now | Must live | Proof gate |
|---|---|---|---|
| Deterministic DEMO synthesis (seeded) | `rasterSynthesis.ts` + `server.ts` | Python DEMO provider | CP6 (DEMO E2E deterministic) |
| CA-CFAR + components + correlation math | TS engine (3 copies) | Single Python authority, parity-proven | CP3 (TST-002) |
| Geodesy (haversine→geodesic upgrade) | `geodesy.ts` | Python `sar`/`correlation` (pyproj.Geod) | CP5 (TST-001) |
| Score decomposition | `correlation.ts` | Backend-persisted per candidate | CP5 |
| Provenance object | `ScanResult.provenance` | Persisted evidence record | CP6 |
| GeoJSON/KML/analytical-JSON generators | `export.ts` | Backend `exports/` (+PNG/PDF) | CP12 |
| REAL-mode refusal honesty | `server.ts` 503 block | Capability-based provider errors | CP7 (TST-012) |
| Scenario fixtures (5 regions) | `scenes.ts` | DEMO scenario pack + docs | CP6 |
| SAR chip (24×24 + clutter stats) | `cfar.ts` chip extraction | Evidence imagery | CP3/CP10 |
| Proximity-pair detection | `correlation.ts:281-294` | Temporal-intel precursor (neutral) | CP5 |
| Ghost/AIS-only counting | `correlation.ts:296-302` | Real AIS_ONLY targets | CP5 |
| SAR overlay colormaps (sar-mono/contrast/thermal) | `sarOverlay.ts` | Unified colormap system (reconcile with 2D trio) | CP9 |
| AIS dead-reckoning tracks | `aisTracks.ts` | Cesium AIS tracks + predicted | CP9 |
| Footprint + uncertainty visuals | `sceneFootprint.ts` + 2D rings | Registry layers | CP9 |

## Non-negotiables

1. No capability above disappears without a `REMOVED_WITH_JUSTIFICATION` row.
2. The TS engine is retired only after TST-002 parity passes (REMOVALS.md entry).
3. UI copy neutralization (UI-022) is a preservation fix, not a removal.
4. Final audit (CP16) diffs this list against the shipped product.

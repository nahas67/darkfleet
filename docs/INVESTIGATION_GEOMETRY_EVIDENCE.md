# DF-X16 — Persisted WGS84 Geo-Annotations and Measurements

**Status:** Implemented in the local Investigation notebook. Geometry is
**operator-authored material**, not radar detections, AIS messages, or proof
of a vessel's presence.

## Starting state, migration, and backwards compatibility

The existing notebook persisted case records, analyst notes and watched SAR
target IDs under data/investigations.sqlite3. The source scan evidence remains
separate, in data/scans/<scan_id>.json. Before DF-X16, no geographic geometry
or measurement endpoint was present.

The idempotent SQLite migration adds investigation_geometries with foreign key
investigation_id REFERENCES investigations(id) ON DELETE CASCADE, plus
an index (investigation_id, created_at, id). The PRAGMA user_version is raised
to 2. The older case/notes/watchlist schema and content remain unchanged,
and the existing investigation response shapes remain backward compatible.
Case deletion cascades to its operator annotations, not source scan evidence.

## HTTP contract

Base: /api/investigations/{case_id}/geometries

| Method | Path suffix | Result |
| --- | --- | --- |
| GET | / | GeometryListOut with geometries array |
| POST | / | Create, HTTP 201, GeometryOut |
| GET | /{geo_id} | Read geometry and server-computed metrics |
| PUT | /{geo_id} | Replace label, notes, shape; preserve ID and created_at |
| DELETE | /{geo_id} | Delete this case's annotation only, HTTP 204 |

Create/replace body:

~~~json
{
  "label": "Operator transit line",
  "notes": "Hypothesis; not an observed radar target.",
  "geometry": {
    "kind": "polyline",
    "coordinates": [[179.5, 0], [-179.5, 0]],
    "radius_m": null
  }
}
~~~

Coordinates are WGS84 [longitude, latitude], not [latitude, longitude], map
pixels, or an arbitrary projection. Shape kinds:

- point: exactly one vertex; no length or area claimed.
- polyline: 2–250 vertices, open chain, measured length and initial bearing.
- polygon: 3–250 vertices, implicit geodesic closure; an explicitly repeated
  terminal vertex is canonicalized away. Area and closed perimeter measured.
- range_ring: exactly one center vertex and radius_m from 1 to 2,000,000
  metres. The radius is an ellipsoidal-geodesic radius; circumference and
  area are numerical approximations using 720 sampled WGS84 directions.

Label: 1–120 trimmed characters. Notes: maximum 4000 characters.
Unknown request fields are refused. Coordinates must be finite, longitude
between -180 and 180, latitude between -90 and 90; adjacent geodesic
zero-length segments, repeated polygon vertices, flat or self-intersecting
polygons are refused. Polygon longitude paths are unwrapped using the
shortest antimeridian transition. A longitude span >= 180 degrees after
unwrapping is refused to avoid hemisphere-area ambiguity.

Outputs return exact source vertices, metric method, UTC created/updated
timestamps, inherited case scan_id (nullable), investigation_id and
provenance = OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE. Case-level scan_id is
not supplied or changed by a geometry request. A linked case requires the
persisted REAL, synthetic-false scan at creation and update; an unlinked case
is allowed with no external scan.

Explicit errors: 404 UNKNOWN_INVESTIGATION, UNKNOWN_GEOMETRY,
UNKNOWN_SCAN; 422 for malformed shapes, invalid coordinates, unknown fields.
Cross-case geometry IDs are inaccessible (404).

## WGS84 authority and reference results

backend/darkfleet/investigation_geometry.py uses pyproj.Geod(ellps="WGS84")
inverse and forward geodesics plus polygon_area_perimeter. This is the same
WGS84 geodesic standard already used in the SAR/AIS correlation subsystem,
not a screen-space or degree-distance approximation.

| Known geometric case | Checked result |
| --- | --- |
| Equator (0°, 0°) to (1°, 0°) | 111,319.490793 m; initial azimuth 90° |
| Meridian (0°, 0°) to (0°, 1°) | 110,574.388557 m; initial azimuth 0° |
| Dateline (179.5°, 0°) to (-179.5°, 0°) | Same one-degree equatorial arc; 90° |
| Equatorial 1° × 1° geodesic polygon | 12,308,778,361 m², perimeter 443,770.917 m |
| 1000 m geodesic ring | Approximately π × 10⁶ m² and 2π × 1000 m |

Metres to kilometres: divide by 1000. Metres to nautical miles: divide by
1852. m² to km²: divide by 1,000,000. Bearings are clockwise from true north
in [0°,360°). Point length and area fields are NULL, not fabricated zeroes.
Polygon area is returned as absolute area. The range ring's polygonized
area/perimeter are declared approximations, not exact closed-form values.
Oversized/multi-hemisphere polygons are not a supported measurement class.

## UI and state

src/reports/InvestigationNotebook.tsx mounts InvestigationGeometryPanel for
the currently selected investigation. The panel supplies a geometry-type
selector, longitude-first vertex textarea, label, optional notes, and ring
radius in metres. Operators can create, list, update, and confirm-delete.
Persisted WGS84 measurements show kilometres, nautical miles, square km
and azimuth where relevant, with the algorithm description and explicit
operator-provenance warning. Switching cases clears the draft/editor and
loads only that case's geometry; superseded responses cannot rewrite the new
case. Existing notes and watchlist remain in their prior controls.

## Verification

Run from backend:

~~~powershell
python -m pytest tests/test_investigations.py tests/test_investigation_geometry.py -q
python -m ruff check darkfleet/api/investigations.py darkfleet/investigation_geometry.py tests/test_investigation_geometry.py
python -m mypy --follow-imports=silent --disable-error-code=valid-type darkfleet/api/investigations.py darkfleet/investigation_geometry.py
~~~

From project root:

~~~powershell
npm test -- --run src/api/investigationGeometry.test.ts src/reports/InvestigationNotebook.test.tsx
npm run lint
npm run build
~~~

Tests cover backward-compatible case notes/watchlists, migration of a
pre-geospatial SQLite DB, application restart, CRUD, cascade deletion,
scan-file byte identity, cross-case isolation, linked-scan deletion guards,
WGS84 reference calculations, antimeridian handling, invalid geometry,
client API call semantics, parser validation and SSR control discovery.
The frontend test runtime is Node: SSR discoverability and client contract
tests do NOT establish a real-browser click-through.

Final scoped verification (Windows backend/.venv Python 3.12.13):
25/25 Python tests passed (original cases, DF-X16 geometry, official MCP),
10/10 focused frontend tests passed (geometry client, notebook and previous
investigations), scoped Ruff and mypy passed, npm run lint and Vite production
build passed. The generated contract check passed (3314 lines), with geometry
schemas added and regeneration performed by the prime coordinator to preserve
other simultaneous contract additions. Mypy used the valid-type error-code
suppression due to a pre-existing unrelated views.py Literal[float] issue.

## Explicit limitations

No Cesium globe draw/drag/edit handles, no screen pointer-to-WGS84 pick or
measurement overlays, no range-ring globe visualization. Coordinates are
entered manually in the notebook. No true sensor uncertainty, operator
identity/RBAC, durable edit history, automatic track association or vessel
claim classification was added. Measurements only describe the coordinates
that the operator provided. They are not evidence that a SAR object or AIS
report occurred at those coordinates.

"""Generate ``src/api/contract.ts`` from the live OpenAPI schema (IR1 / Checkpoint B).

The defect this exists to prevent
---------------------------------
The frontend used to hand-write ``VesselTarget`` and declared ``classification``
while the backend emitted ``cls``. Nothing caught the drift, and a detection's
class was ``undefined`` in every live render path for an unknown number of
releases. Two hand-written mirrors of one shape will drift; a generated file
cannot, because it is overwritten by the generator rather than edited.

Why generate instead of share
-----------------------------
A shared JSON-schema file would still need per-language binding code and a
committed artefact to drift from. Deriving TypeScript from the schema FastAPI
*actually serves* means the contract that ships is the contract that is enforced:
if the backend stops validating a field, it disappears from the generated type.

Run::

    python -m tools.export_contract            # write
    python -m tools.export_contract --check    # fail if out of date (CI gate)

Design notes
------------
* Only the schemas the frontend consumes are emitted. The whole OpenAPI document
  would be several hundred lines of provider and error shapes nobody imports.
* ``additionalProperties: false`` is enforced by the backend Pydantic model at the
  boundary and again by ``src/api/validate.ts`` on arrival, not by a TypeScript
  index signature. That is not a downgrade: a type-only check cannot catch a
  runtime payload, and it is the runtime check that was missing when the
  ``cls``/``classification`` drift shipped.
* Nullable unions stay unions (``number | null``). They are never collapsed to
  ``number`` with a default, because in this codebase ``null`` means "not
  measured" and a default would erase exactly the distinction the contract exists
  to preserve.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
OUT = ROOT / "src" / "api" / "contract.ts"

#: Schemas to emit, in dependency-friendly order. `export const` blocks are
#: appended after the interfaces so a literal union can reference them.
SCHEMAS: tuple[str, ...] = (
    "ScoreDecomposition",
    "AisAssociation",
    "VesselTarget",
    "AisOnlyTarget",
    "ScanTargetsResponse",
    "SceneSummary",
    "SceneListResponse",
    "ScanAccepted",
    "StageEventOut",
    "ScanStateResponse",
    "ProviderHealthEntry",
    "HealthResponse",
    "TargetEvidenceResponse",
    "EvidenceDocumentResponse",
    "DebugLayerResponse",
    "LayerStats",
    # AIS delivery (GREEN-3). Order matters only for readability: the generator
    # follows $ref edges, so a dependency listed after its dependent is still
    # emitted before it.
    "AisObservationOut",
    "AisCoverageOut",
    "ScanAisWindow",
    "ScanAisResponse",
    "TargetAisResponse",
    "VesselTrackResponse",
)

HEADER = """// GENERATED FILE - DO NOT EDIT BY HAND.
//
// Produced by `python -m tools.export_contract` from the FastAPI OpenAPI schema.
// `src/api/contract.ts` is the single source of truth for every wire shape the
// frontend consumes; the backend validates against the same declarations.
//
// Regenerate after any API change, or run with --check to prove it is current.
//
// This file was generated because two hand-written mirrors of one shape had
// drifted: the frontend declared `classification` while the backend emitted `cls`,
// and a detection's class was undefined in every live render path.

/* eslint-disable */

export const CLASSIFICATION_VALUES = [
%s
] as const;

export type TargetClassification = (typeof CLASSIFICATION_VALUES)[number];

"""


def ts_type(schema: dict[str, Any], defs: dict[str, Any]) -> str:
    """Render one JSON Schema node as a TypeScript type expression."""
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(v) for v in schema["enum"])

    for key in ("anyOf", "oneOf"):
        if key in schema:
            parts = [ts_type(s, defs) for s in schema[key]]
            # Collapse `X | null` duplicates but keep a real union.
            out: list[str] = []
            for p in parts:
                if p not in out:
                    out.append(p)
            return " | ".join(out)

    for key in ("allOf",):
        if key in schema:
            parts = [ts_type(s, defs) for s in schema[key]]
            return " & ".join(p for p in parts if p != "{}")

    kind = schema.get("type")
    if kind == "string":
        return "string"
    if kind in ("number", "integer"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        return f"{ts_type(schema.get('items', {}), defs)}[]"
    if kind == "object" or "properties" in schema:
        # `dict[str, int]` arrives as additionalProperties:{type:integer}. Emitting
        # a bare `Record<string, unknown>` threw away the value type, which is how
        # `counts` ended up mismatched against a consumer expecting numbers.
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict) and extra:
            return f"Record<string, {ts_type(extra, defs)}>"
        return "Record<string, unknown>"
    if not kind:
        return "unknown"
    return "unknown"


def render_interface(name: str, schema: dict[str, Any], defs: dict[str, Any]) -> str:
    props: dict[str, Any] = schema.get("properties") or {}
    required = set(schema.get("required") or ())

    # A schema that is purely an enum is a union, not an object. ProviderStatus is
    # exactly this: emitting an empty interface for it would produce a type that
    # accepts any object, which is precisely how the frontend came to invent a
    # seventh provider state the backend can never emit.
    if not props and ("enum" in schema or "const" in schema):
        values = schema.get("enum") or [schema["const"]]
        body = " | ".join(json.dumps(v) for v in values)
        desc = _describe(schema)
        head = f"/** {desc} */\n" if desc else ""
        return f"{head}export type {name} = {body};"

    # `additionalProperties: false` is NOT emitted as a `[k: string]: never` index
    # signature: TypeScript requires an index signature to be assignable to every
    # declared property, so `never` fails to compile against a real interface. The
    # constraint is enforced two other ways instead, both stronger than a type:
    # the backend Pydantic model rejects unknown keys at the boundary, and
    # src/api/validate.ts rejects them again on arrival.
    strict = schema.get("additionalProperties") is False

    lines = [f"export interface {name} {{"]
    if strict:
        lines.append(
            "  /** Rejects unknown keys at runtime: this schema is"
            " additionalProperties:false. */"
        )
    if not props:
        lines.append("  // (no declared properties)")
    for field, spec in props.items():
        optional = "" if field in required else "?"
        ts = ts_type(spec, defs)
        desc = _describe(spec)
        if desc:
            lines.append(f"  /** {desc} */")
        lines.append(f"  readonly {field}{optional}: {ts};")
    lines.append("}")
    return "\n".join(lines)


def _describe(spec: dict[str, Any]) -> str:
    """Emit the schema's own description, if it has one."""
    desc = spec.get("description")
    if not desc:
        return ""
    flat = " ".join(str(desc).split())
    if len(flat) > 300:
        flat = flat[:297] + "..."
    return flat.replace("*/", "*\\/")


def build() -> str:
    # Import inside the function so `--check` works before the venv has anything
    # installed, and so a missing dependency produces an actionable message.
    sys.path.insert(0, str(BACKEND))
    from darkfleet.api.app import create_app
    from darkfleet.config.settings import Settings

    settings = Settings()
    settings.log_level = "WARNING"
    app = create_app(settings)
    openapi = app.openapi()
    defs: dict[str, Any] = openapi.get("components", {}).get("schemas", {})

    from darkfleet.api.targets import CLASSIFICATION_VALUES

    out = [HEADER % "\n".join(f"  '{v}'," for v in CLASSIFICATION_VALUES)]

    # Auto-discover transitively referenced schemas. A hand-maintained list drifts:
    # the first version referenced ProviderStatus without emitting it, which
    # produced a file that did not compile. Anything a listed schema points at is
    # emitted too, so a new $ref cannot silently produce an undefined type.
    def refs_in(schema: dict[str, Any]) -> set[str]:
        """Every schema name this node transitively references.

        Recurses into ALL nested values, not a fixed key list. The first version
        only descended into anyOf/oneOf/allOf/items/properties, so it never reached
        the property schemas themselves and silently missed ProviderStatus -- the
        exact failure this was written to prevent.
        """
        found: set[str] = set()
        stack: list[Any] = [schema]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                    found.add(ref.rsplit("/", 1)[-1])
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
        return found

    emit: list[str] = []
    queue = list(SCHEMAS)
    seen: set[str] = set()
    while queue:
        name = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)
        spec = defs.get(name)
        if spec is None:
            print(f"warning: schema {name} not in OpenAPI; skipping", file=sys.stderr)
            continue
        emit.append(name)
        for dep in sorted(refs_in(spec)):
            if dep not in seen:
                queue.append(dep)

    emitted: list[str] = []
    for name in emit:
        out.append(render_interface(name, defs[name], defs))
        out.append("")
        emitted.append(name)

    out.append("/** Schemas emitted into this file. */")
    out.append("export type ContractSchemaName =")
    for name in emitted:
        out.append(f"  | '{name}'")
    out.append(";")
    out.append("")

    # The ScanStage values, in enum order, as a RUNTIME array.
    #
    # A generated union type alone cannot give a consumer the pipeline ORDER, so
    # the frontend was obliged to keep a second hand-written list beside it --
    # and that list is what went stale when GEO-CORR added GEOLOCATING. Emitting
    # the ordered values removes the second list rather than documenting it.
    stage_spec = defs.get("ScanStage") or {}
    stage_values = stage_spec.get("enum")
    if stage_values:
        out.append("/**")
        out.append(" * ScanStage values in the backend's declared pipeline order.")
        out.append(" *")
        out.append(" * Generated. Consumers must not extend or reorder this.")
        out.append(" */")
        out.append("export const SCAN_STAGE_ORDER = [")
        for value in stage_values:
            out.append(f"  '{value}',")
        out.append("] as const;")
        out.append("")

    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if the generated file is out of date instead of writing",
    )
    args = ap.parse_args()

    content = build()

    if args.check:
        if not OUT.exists():
            print(f"missing {OUT}", file=sys.stderr)
            return 1
        current = OUT.read_text(encoding="utf-8")
        if current != content:
            print(
                "contract.ts is STALE. Run: python -m tools.export_contract",
                file=sys.stderr,
            )
            return 1
        print(f"contract.ts is current ({len(content.splitlines())} lines)")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(content.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

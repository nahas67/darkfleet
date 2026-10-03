"""Route reachability gate: two distinct metrics, not one.

    python tools/route_reachability.py           # report both
    python tools/route_reachability.py --strict  # non-zero on any orphan
    python tools/route_reachability.py --json

WHY TWO METRICS
---------------

``CALLER_REACHABLE`` is what the previous gate measured: a path-shaped literal
addressing the route exists somewhere under ``src/``. That is necessary and not
sufficient. A helper module can be written, contain a perfect request, and never
be reached from the running application -- and the old gate would call that a
delivered feature.

``PRODUCT_REACHABLE`` adds the structural half: the module holding the literal
must be connected to the running application through VALUE imports from the real
entry point, and that connection must pass through an actual rendering component.
A helper imported only by another helper, or only by a test, does not qualify.

WHAT THIS PROVES, AND WHAT IT DOES NOT
--------------------------------------

Proves: the request lives in code the shipped application loads and that some
component on the path renders.

Does not prove: that a human clicked anything. Full call-graph analysis is out of
scope for a regex tool, and a tool that guessed at invocation would be worse than
one that states its limit. The remaining gap is closed by browser E2E, which
drives the real UI. Treat PRODUCT_REACHABLE as "the code is in the product", not
as "an operator has used it".

The entry point is read from ``index.html`` rather than hardcoded, so renaming
``src/main.tsx`` cannot silently turn every route into an orphan or every orphan
into a reachable one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROUTES = ROOT / "backend" / "darkfleet" / "api" / "routes.py"
SRC = ROOT / "src"
INDEX_HTML = ROOT / "index.html"

_ROUTE = re.compile(r'@router\.(get|post|put|delete|patch)\(\s*"([^"]+)"')
_STRING = re.compile(r"""['"`]([^'"`\n]*)['"`]""")

# `import type { X } from './y'` erases at runtime, so it cannot connect a module
# to the running application. `import { X }` and `import X from` cannot.
_IMPORT_TYPE = re.compile(r"^\s*import\s+type\b", re.MULTILINE)
_IMPORT = re.compile(
    r"""^\s*import\s+(?!type\b)(?:[\s\S]*?\bfrom\s+)?['"](\.[^'"]+)['"]""",
    re.MULTILINE,
)
# A component module: JSX with a capitalised tag, or an explicit JSX return.
_JSX_TAG = re.compile(r"<[A-Z][A-Za-z0-9_]*[\s/>]")
_ENTRY = re.compile(r"""<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']""")

#: Extensions tried when an import has none.
_EXT = (".ts", ".tsx")


@dataclass(frozen=True)
class Route:
    verb: str
    path: str

    @property
    def label(self) -> str:
        return f"{self.verb} {self.path}"


@dataclass(frozen=True)
class Caller:
    """One path-shaped literal, and the module it lives in."""

    literal: str
    module: Path


def declared_routes() -> list[Route]:
    return [Route(m.group(1).upper(), m.group(2)) for m in _ROUTE.finditer(ROUTES.read_text(encoding="utf-8"))]


def _template_paths(source: str) -> set[str]:
    """Every string and template-literal body in a TypeScript source file.

    Regex rather than a real parser: TypeScript is not Python, and the only
    structure needed here is "what path-shaped literals does this file contain".
    A template literal such as ``/api/scans/${scanId}/targets`` is kept intact,
    including its hole, so the matcher can treat the hole as a path segment.
    """
    return {m.group(1) for m in _STRING.finditer(source) if m.group(1)}


def _segments(path: str) -> list[str]:
    """Path segments, with any query string or fragment dropped.

    The cut happens at the first ``?`` or ``#`` before splitting, otherwise the
    query of a literal like ``/api/revisit?bbox=...`` would be mistaken for a
    trailing path segment and the route would look uncalled.
    """
    return [s for s in re.split(r"[/?#]", re.split(r"[?#]", path, maxsplit=1)[0]) if s]


def _is_hole(segment: str) -> bool:
    """A path hole in either notation: FastAPI ``{scan_id}`` or TS ``${scanId}``."""
    return (
        (segment.startswith("{") and segment.endswith("}"))
        or (segment.startswith("${") and segment.endswith("}"))
    )


def _matches(route_path: str, literal: str) -> bool:
    """Whether a frontend literal addresses a route path.

    Compared from the end of the path, because that is where the distinguishing
    part lives: the method prefix and the mount point may differ between the
    FastAPI route and the frontend call, but the tail identifies the resource.
    """
    route_segments = _segments(route_path)
    literal_segments = _segments(literal)
    if len(literal_segments) < len(route_segments):
        return False
    tail = literal_segments[-len(route_segments) :]
    return all(_is_hole(a) or a == b for a, b in zip(route_segments, tail))


# --------------------------------------------------------------- import graph


def entry_module() -> Path | None:
    """The shipped entry point, read from ``index.html``.

    Not hardcoded. A hardcoded path is a path that quietly stops being true.
    """
    if not INDEX_HTML.exists():
        return None
    match = _ENTRY.search(INDEX_HTML.read_text(encoding="utf-8"))
    if not match:
        return None
    src = match.group(1).lstrip("/")
    candidate = ROOT / src
    return candidate if candidate.exists() else None


def _resolve(specifier: str, importer: Path) -> Path | None:
    target = (importer.parent / specifier).resolve()
    if target.exists() and target.is_file():
        return target
    for ext in _EXT:
        with_ext = target.with_suffix(target.suffix + ext) if target.suffix else Path(str(target) + ext)
        if with_ext.exists():
            return with_ext
    for ext in _EXT:
        as_index = target / f"index{ext}"
        if as_index.exists():
            return as_index
    return None


def value_imports(module: Path) -> list[Path]:
    """Modules this one imports at RUNTIME.

    ``import type`` is excluded: it is erased before execution, so a type-only
    edge connects two type declarations and not two pieces of running code.
    """
    try:
        source = module.read_text(encoding="utf-8")
    except OSError:
        return []
    # Blank out type-only imports so their specifiers are not double-counted.
    scannable = _IMPORT_TYPE.sub(lambda m: "\n" * m.group(0).count("\n"), source)
    out: list[Path] = []
    for match in _IMPORT.finditer(scannable):
        resolved = _resolve(match.group(1), module)
        if resolved is not None:
            out.append(resolved)
    return out


def reachable_from(entry: Path) -> set[Path]:
    """Every module the shipped application loads, via runtime imports."""
    seen: set[Path] = set()
    stack = [entry]
    while stack:
        module = stack.pop()
        if module in seen:
            continue
        seen.add(module)
        stack.extend(value_imports(module))
    return seen


def is_component(module: Path) -> bool:
    """Whether a module renders JSX, i.e. whether it produces pixels.

    The structural stand-in for "an active component": a module with no JSX cannot
    be a React component, so a request reached only through such modules is in
    data-layer code and not on a render path.
    """
    try:
        return bool(_JSX_TAG.search(module.read_text(encoding="utf-8")))
    except OSError:
        return False


def product_reachable(callers: list[Caller], entry: Path | None) -> set[str]:
    """Route paths reachable through the running application.

    A literal qualifies when all three hold:

    1. its module is loaded by the shipped application (value-import closure of
       the entry point);
    2. the chain from the entry to that module passes through a module that
       renders JSX -- so the code is on a render path, not stranded in the data
       layer;
    3. the literal addresses the route.

    A helper written but never imported fails (1). A helper imported only by
    another helper fails (2). A helper exercised only by a test fails (1), which
    is the point: a test is not a user.
    """
    if entry is None:
        return set()
    loaded = reachable_from(entry)
    if entry not in loaded:
        loaded.add(entry)

    # Reverse edges, so the render path from the entry to each module is walkable.
    importers: dict[Path, list[Path]] = {}
    for module in loaded:
        for imported in value_imports(module):
            if imported in loaded:
                importers.setdefault(imported, []).append(module)

    # Forward BFS from the entry over value imports, remembering whether a
    # rendering component has been seen on the path so far.
    render_path: dict[Path, bool] = {entry: is_component(entry)}
    stack = [entry]
    while stack:
        module = stack.pop()
        for imported in value_imports(module):
            if imported not in loaded:
                continue
            candidate = render_path[module] or is_component(imported)
            if imported not in render_path or (candidate and not render_path[imported]):
                render_path[imported] = candidate
                stack.append(imported)

    qualified: set[str] = set()
    for caller in callers:
        if render_path.get(caller.module):
            qualified.add(caller.literal)
    return qualified


# ------------------------------------------------------------------ reporting


def main() -> int:
    parser = argparse.ArgumentParser(description="Route reachability, two metrics.")
    parser.add_argument("--strict", action="store_true", help="exit non-zero on any orphan")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    routes = declared_routes()

    callers: list[Caller] = []
    for path in SRC.rglob("*"):
        if path.suffix in (".ts", ".tsx"):
            for literal in _template_paths(path.read_text(encoding="utf-8")):
                callers.append(Caller(literal, path))

    literals = {c.literal for c in callers}
    caller_ok = [r for r in routes if any(_matches(r.path, lit) for lit in literals)]

    entry = entry_module()
    on_render_path = product_reachable(callers, entry) if entry else set()
    product_ok = [r for r in routes if any(_matches(r.path, lit) for lit in on_render_path)]

    caller_orphans = [r for r in routes if r not in caller_ok]
    product_orphans = [r for r in routes if r not in product_ok]

    if args.json:
        print(
            json.dumps(
                {
                    "entry": str(entry.relative_to(ROOT)) if entry else None,
                    "total": len(routes),
                    "caller_reachable": len(caller_ok),
                    "product_reachable": len(product_ok),
                    "caller_orphans": [{"verb": o.verb, "path": o.path} for o in caller_orphans],
                    "product_orphans": [{"verb": o.verb, "path": o.path} for o in product_orphans],
                },
                indent=2,
            )
        )
        return 1 if (args.strict and product_orphans) else 0

    print(f"backend routes          : {len(routes)}")
    print(f"CALLER_REACHABLE        : {len(caller_ok)}")
    print(f"PRODUCT_REACHABLE       : {len(product_ok)}")
    print(f"entry point             : {entry.relative_to(ROOT) if entry else 'NOT FOUND'}")
    if caller_orphans:
        print()
        print("No frontend caller anywhere in src/:")
        for route in caller_orphans:
            print(f"   {route.label}")
    if product_orphans:
        print()
        print("Has a caller, but NOT reachable through the running application:")
        for route in product_orphans:
            print(f"   {route.label}")
        print()
        print(
            "PRODUCT_REACHABLE proves the request is in the shipped app's render\n"
            "path. It does not prove an operator clicked anything; browser E2E\n"
            "closes that gap."
        )
    return 1 if (args.strict and product_orphans) else 0


if __name__ == "__main__":
    sys.exit(main())
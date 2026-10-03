"""Route reachability gate.

A backend route with no frontend caller is not a product feature -- it is code
that exists and proves nothing. This is the same discipline the module-level
reachability check applies to imports, applied to the API surface.

Used as a checkpoint gate, and as a way to see which capabilities are
implemented but unreachable.

    python tools/route_reachability.py          # report
    python tools/route_reachability.py --strict # non-zero if any orphan
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

_ROUTE = re.compile(r'@router\.(get|post|put|delete|patch)\(\s*"([^"]+)"')
_STRING = re.compile(r"""['"`]([^'"`\n]*)['"`]""")


@dataclass(frozen=True)
class Route:
    verb: str
    path: str

    @property
    def label(self) -> str:
        return f"{self.verb} {self.path}"


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero on any orphan")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    routes = declared_routes()
    literals: set[str] = set()
    for path in SRC.rglob("*"):
        if path.suffix in (".ts", ".tsx"):
            literals |= _template_paths(path.read_text(encoding="utf-8"))

    orphans = [r for r in routes if not any(_matches(r.path, lit) for lit in literals)]

    if args.json:
        print(
            json.dumps(
                {
                    "total": len(routes),
                    "reachable": len(routes) - len(orphans),
                    "orphans": [{"verb": o.verb, "path": o.path} for o in orphans],
                },
                indent=2,
            )
        )
        return 1 if (args.strict and orphans) else 0

    print(f"backend routes          : {len(routes)}")
    print(f"with a frontend caller  : {len(routes) - len(orphans)}")
    print(f"orphaned                : {len(orphans)}")
    if orphans:
        print()
        print("Implemented in the backend, unreachable from the product:")
        for route in orphans:
            print(f"   {route.label}")
        print()
        print("Each is verified backend capability that no operator can invoke.")
    return 1 if (args.strict and orphans) else 0


if __name__ == "__main__":
    sys.exit(main())
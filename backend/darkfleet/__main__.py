"""``python -m darkfleet`` -- serve the API with uvicorn.

Flags override the corresponding ``DARKFLEET_*`` settings; anything left unset
uses the configured value. ``--check`` validates the wiring and exits without
binding a port, which is what a smoke test wants.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.observability import configure as configure_logging


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m darkfleet",
        description="Serve the DarkFleet SAR/AIS API.",
    )
    parser.add_argument("--host", default=None, help="Bind address (default settings.api_host).")
    parser.add_argument("--port", type=int, default=None, help="Port (default settings.api_port).")
    parser.add_argument("--reload", action="store_true", help="Reload on source changes.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Build the app, report the route table, and exit.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    settings = Settings()
    configure_logging(settings.log_level)
    application = create_app(settings)

    if args.check:
        for route in sorted(
            (route for route in application.routes if getattr(route, "path", "").startswith("/api")),
            key=lambda item: getattr(item, "path", ""),
        ):
            methods = ",".join(sorted(getattr(route, "methods", []) or []))
            print(f"{methods:<8} {getattr(route, 'path', '')}")
        return 0

    import uvicorn

    uvicorn.run(
        application,
        host=args.host or settings.api_host,
        port=args.port or settings.api_port,
        log_level=settings.log_level.lower(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
"""Start DarkFleet's local read-only MCP evidence server on stdio.

    python -m tools.mcp_evidence --data-dir ../data

stdout is reserved for JSON-RPC. Errors and SDK diagnostics use stderr.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from darkfleet.mcp_server import create_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only local MCP evidence over stdio")
    parser.add_argument(
        "--data-dir", required=True, type=Path,
        help="Existing DarkFleet data_dir containing scans/ and optional ais/ and reference/.",
    )
    args = parser.parse_args()
    if not args.data_dir.is_dir():
        parser.error(f"data directory does not exist: {args.data_dir}")
    create_server(args.data_dir).run(transport="stdio")


if __name__ == "__main__":
    main()

"""DarkFleet HTTP API (API-001..012).

The API is a thin adapter over the engine:

* :mod:`darkfleet.api.models` -- typed request/response contracts (API-011);
* :mod:`darkfleet.api.routes` -- the routers, the scan-job adapter, live
  provider probing, exports and debug layers;
* :mod:`darkfleet.api.app` -- the FastAPI factory, lifespan and CORS.

Detection, correlation, evidence and provider access stay in their own
modules; nothing here reimplements them.
"""

from __future__ import annotations

from darkfleet.api.app import DEFAULT_CORS_ORIGINS, create_app
from darkfleet.api.routes import DEBUG_LAYERS, KNOWN_PROVIDERS, ApiState

__all__ = [
    "DEBUG_LAYERS",
    "DEFAULT_CORS_ORIGINS",
    "KNOWN_PROVIDERS",
    "ApiState",
    "create_app",
]
"""FastAPI application factory: lifespan, CORS and error rendering (API-012).

The app owns no scan logic. It builds the :class:`~darkfleet.api.routes.ApiState`
from :class:`~darkfleet.config.settings.Settings` during startup, mounts the
routers, and renders every failure as one consistent error body carrying a
``status``. In particular :class:`~darkfleet.providers.RealDataUnavailableError`
becomes an explicit 503 (or 400) response with a ProviderStatus value -- there is
no handler that turns a provider failure into invented data.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from darkfleet import __version__
from darkfleet.api.analyst_routes import router as analyst_router
from darkfleet.api.investigations import router as investigations_router
from darkfleet.api.local_sar_routes import router as local_sar_router
from darkfleet.api.maritime_routes import router as maritime_router
from darkfleet.api.missions import router as missions_router
from darkfleet.api.report_routes import router as reports_router
from darkfleet.api.routes import ApiState, liveness_router, router
from darkfleet.api.sar_compare_routes import router as sar_compare_router
from darkfleet.api.sar_imagery_routes import router as sar_imagery_router
from darkfleet.api.views import router as saved_views_router
from darkfleet.config.settings import Settings
from darkfleet.config.settings import settings as default_settings
from darkfleet.observability import configure as configure_logging
from darkfleet.providers import RealDataUnavailableError

__all__ = ["DEFAULT_CORS_ORIGINS", "app", "create_app"]

#: Local dev origins for the Vite frontend. Widen per deployment via create_app.
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def _error_body(detail: object, http_code: int) -> dict[str, Any]:
    """Render an error body. Structured API errors are returned unwrapped."""
    if isinstance(detail, dict) and "error" in detail:
        return {str(key): value for key, value in detail.items()}
    return {"error": "HTTP_ERROR", "status": f"HTTP_{http_code}", "message": str(detail)}


def create_app(
    app_settings: Settings | None = None,
    *,
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS,
) -> FastAPI:
    """Build the API application.

    ``app_settings`` defaults to the process-wide :data:`settings` singleton and
    is read at *call* time, so a test (or a CLI flag) can point the whole API at
    a temporary ``data_dir`` without touching a global.
    """
    resolved = default_settings if app_settings is None else app_settings

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        configure_logging(getattr(resolved, "log_level", "INFO"))
        application.state.darkfleet_state = ApiState.build(resolved)
        yield

    application = FastAPI(
        title="DarkFleet API",
        version=__version__,
        description=(
            "SAR/AIS correlation API. Stage transitions are real work reports, "
            "never timers, and a REAL provider failure is always explicit."
        ),
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    application.include_router(liveness_router)
    application.include_router(router)
    application.include_router(investigations_router)
    application.include_router(missions_router)
    application.include_router(reports_router)
    application.include_router(analyst_router)
    application.include_router(sar_compare_router)
    application.include_router(sar_imagery_router)
    application.include_router(local_sar_router)
    application.include_router(saved_views_router)
    # Maritime context lives on its own router: the spatial surface will grow, and
    # it must not widen the core scan router. The route is scan-scoped, so a target
    # id is never resolvable without its scan.
    application.include_router(maritime_router)

    @application.exception_handler(HTTPException)
    async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.detail, exc.status_code),
            headers=getattr(exc, "headers", None),
        )

    @application.exception_handler(RealDataUnavailableError)
    async def _real_data_unavailable(
        request: Request, exc: RealDataUnavailableError
    ) -> JSONResponse:
        """A provider failure is a 503 with its ProviderStatus, never substitute data."""
        del request
        http = exc.details.get("http")
        if http in (401, 403):
            provider_status = "AUTH_REQUIRED"
            code = status.HTTP_503_SERVICE_UNAVAILABLE
        elif http == 429:
            provider_status = "RATE_LIMITED"
            code = status.HTTP_503_SERVICE_UNAVAILABLE
        else:
            provider_status = "UNAVAILABLE"
            code = status.HTTP_503_SERVICE_UNAVAILABLE
        return JSONResponse(
            status_code=code,
            content={
                "error": "REAL_DATA_UNAVAILABLE",
                "status": provider_status,
                "message": str(exc),
                "provider": str(exc.details.get("provider", "")) or None,
                "detail": exc.details,
                "suggestions": list(exc.suggestions),
            },
        )

    @application.exception_handler(ValueError)
    async def _bad_request(request: Request, exc: ValueError) -> JSONResponse:
        """A malformed identifier or document shape is a 400, not a 500."""
        del request
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "INVALID_REQUEST",
                "status": "INVALID_REQUEST",
                "message": str(exc),
            },
        )

    return application


#: Module-level app for ``uvicorn darkfleet.api.app:app``.
app = create_app()

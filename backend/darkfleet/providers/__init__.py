"""Provider capability model. Accessibility and georeferencing are separate states."""

from __future__ import annotations

from enum import Enum
from typing import Any


class ProviderStatus(str, Enum):
    AVAILABLE = "AVAILABLE"
    DEGRADED = "DEGRADED"
    UNAVAILABLE = "UNAVAILABLE"
    AUTH_REQUIRED = "AUTH_REQUIRED"
    RATE_LIMITED = "RATE_LIMITED"
    NOT_CONFIGURED = "NOT_CONFIGURED"


class Georeferencing(str, Enum):
    AFFINE_GEOREFERENCED = "AFFINE_GEOREFERENCED"
    GCP_GEOREFERENCED = "GCP_GEOREFERENCED"
    UNREFERENCED = "UNREFERENCED"


class RealDataUnavailableError(RuntimeError):
    """Raised when a REAL path cannot be satisfied. Never falls back to synthetic."""

    def __init__(
        self,
        message: str,
        details: dict[str, Any] | None = None,
        suggestions: list[str] | None = None,
    ):
        super().__init__(message)
        self.code = "REAL_DATA_UNAVAILABLE"
        self.details = details or {}
        self.suggestions = suggestions or [
            "Check network reachability of the provider endpoint.",
            (
                "Widen the area or the datetime range; this provider may hold no "
                "acquisition that covers it."
            ),
            "Configure a provider credential (see .env.example) if one is required.",
        ]

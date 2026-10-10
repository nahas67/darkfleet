"""Typed configuration. Environment variables override; no hardcoded credentials."""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class PlanetaryComputerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_PC_")

    stac_url: str = "https://planetarycomputer.microsoft.com/api/stac/v1"
    rtc_collection: str = "sentinel-1-rtc"
    grd_collection: str = "sentinel-1-grd"
    sas_token_url: str = "https://planetarycomputer.microsoft.com/api/sas/v1/token"


class CdseSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_CDSE_")

    stac_url: str = "https://stac.dataspace.copernicus.eu/v1"
    client_id: str = ""
    client_secret: str = ""


class EarthSearchSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_EARTHSEARCH_")

    stac_url: str = "https://earth-search.aws.element84.com/v1"
    grd_collection: str = "sentinel-1-grd"


class AisSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_AIS_")

    aistream_api_key: str = ""
    aistream_url: str = "wss://stream.aisstream.io/v0/stream"
    aishub_username: str = ""
    gfw_api_token: str = ""
    correlation_window_seconds: int = 900


class CfarSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_CFAR_")

    training_cells: int = 16
    guard_cells: int = 4
    threshold_factor: float = 3.5
    coastline_buffer_meters: int = 150
    speckle_filter: Literal["none", "median", "lee"] = "median"
    kernel_size: int = 3
    min_pixels: int = 3
    max_pixels: int = 1000


class MatchingSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_MATCH_")

    base_radius_meters: float = 1200.0
    max_radius_meters: float = 2800.0
    min_composite_score: float = 0.40
    weight_spatial: float = 0.45
    weight_temporal: float = 0.25
    weight_heading: float = 0.15
    weight_size: float = 0.15


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DARKFLEET_", env_nested_delimiter="__")

    #: Every scan is a REAL scan against a live provider. There is no synthetic
    #: runtime mode and no degraded path: a fabricated observation must never be
    #: reachable from the product, because a user cannot tell one from a
    #: measurement they relied on.
    runtime_mode: Literal["REAL"] = "REAL"

    data_dir: str = "data"
    # Local-first is a security boundary: the API has no authentication, so a
    # direct `python -m darkfleet` must never expose mutable operator data to
    # other hosts on the network. Container deployments opt into 0.0.0.0.
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    log_level: str = "INFO"

    pc: PlanetaryComputerSettings = Field(default_factory=PlanetaryComputerSettings)
    cdse: CdseSettings = Field(default_factory=CdseSettings)
    earthsearch: EarthSearchSettings = Field(default_factory=EarthSearchSettings)
    ais: AisSettings = Field(default_factory=AisSettings)
    cfar: CfarSettings = Field(default_factory=CfarSettings)
    matching: MatchingSettings = Field(default_factory=MatchingSettings)


settings = Settings()

"""The verified reference-dataset registry.

ONE TABLE, ONE TRUTH

Every dataset DarkFleet can answer a contextual question from is declared here once,
with the version this repository has VERIFIED against the publisher. Readers resolve
datasets through :func:`known_manifest`, so a query, the layer console and the dossier
all name the same version -- which is what makes the displayed provenance trustworthy
(§77).

These versions are NOT "latest". They are the versions checked on 2026-10-04 and
recorded in ``docs/MARITIME_REFERENCE_SOURCES.md``. Two of them have a live trap:

  * Marine Regions v11 is ARCHIVED. A Copernicus Marine mirror still serves v11 EEZ and
    v4 Territorial Seas, so taking a version from a mirror yields a five-year-old
    boundary that still loads cleanly. The expected version is pinned here rather than
    discovered from whatever answers.
  * GEBCO_2025 publishes that only 27.3% of the ocean floor is mapped to modern
    standards. That number is itself provenance and travels with the dataset, because
    presenting the grid as uniform direct measurement overstates it by a factor of
    about four.

NEITHER DATASET IS COMMITTED

Coastline is 2.93 MB and ports are a few MB; the EEZ geodatabase is 122 MB and GEBCO is
3.7 billion cells. None of them belong in git (§6). What is committed is this table,
the install machinery, checksums, and tiny fixtures.
"""

from __future__ import annotations

from .datasets import DatasetManifest, LocalRepresentation, SourceMechanism
from .provenance import LicenseKind

#: Verification date for the versions below. Recorded so a future reader can tell how
#: old the check is without hunting through commit history.
VERIFIED_ON = "2026-10-04"


def _coastline() -> DatasetManifest:
    return DatasetManifest(
        id="natural_earth_coastline",
        provider="Natural Earth (NACIS)",
        dataset="ne_10m_coastline",
        version="4.1.0",
        release_date=None,
        identifier="https://www.naturalearthdata.com/downloads/10m-physical-vectors/",
        download_url=(
            "https://naciscdn.org/naturalearth/10m/physical/"
            "ne_10m_coastline.zip"
        ),
        license=LicenseKind.PUBLIC_DOMAIN,
        attribution="Natural Earth — public domain",
        # Public domain, so no obligations beyond the credit. Stated rather than left
        # empty so an empty string cannot later be read as "unrecorded terms".
        terms_notes=(
            "Public domain. No redistribution restriction. This is a cartographic "
            "generalisation for reference scale, NOT a hydrographic survey."
        ),
        resolution="1:10m scale (1:50m and 1:110m also published)",
        coverage_note="Global. Includes major islands; omits minor islands.",
        limitations=(
            "REFERENCE COASTLINE — NOT FOR NAVIGATION.",
            ("Generalised for cartographic reference; carries no depth, drying, "
            "hazard or chart-accuracy information."),
            ("Minor islands are absent at this scale, so small features may be "
            "missing near a coast."),
        ),
        representation=LocalRepresentation.PREPPED_GEOJSON,
        payload_files=("coastline.json",),
        expected_sha256=None,
    )


def _eez() -> DatasetManifest:
    return DatasetManifest(
        id="marine_regions_eez",
        provider="VLIZ / Marine Regions",
        dataset="Maritime Boundaries Geodatabase — World EEZ",
        # v12, released 2023-10-25. v11 is ARCHIVED. Do not take this from a mirror.
        version="12",
        release_date="2023-10-25",
        identifier="https://doi.org/10.14284/386",
        download_url="https://www.marineregions.org/downloads/",
        license=LicenseKind.CC_BY,
        attribution="VLIZ / Marine Regions — Maritime Boundaries Geodatabase",
        # THE CAVEAT THAT MATTERS. CC BY permits commercial use but the publisher asks
        # users NOT to redistribute the products elsewhere and to refer to
        # marineregions.org for the current version. Shipping a transformed copy inside
        # DarkFleet without checking that would breach the request even while
        # satisfying the licence, which is exactly the trap §79 describes.
        terms_notes=(
            "CC BY 4.0. Commercial use permitted. The publisher ASKS that the "
            "products are not redistributed elsewhere and that marineregions.org is "
            "referenced for the most current version. Prefer an installer flow over "
            "bundling a transformed copy; confirm terms before redistributing."
        ),
        resolution="Vector boundaries; no raster resolution",
        coverage_note="Global, including high seas and overlapping-claim areas.",
        limitations=(
            ("Boundaries are DISPUTED, OVERLAPPING and PROVISIONAL: a third party's "
            "representation derived from treaties, and from CALCULATED MEDIAN LINES "
            "where treaties are unavailable."),
            ("Marine Regions does not determine sovereignty. DarkFleet reports the "
            "dataset's representation and nothing more."),
            ("Version 11 is archived. A Copernicus Marine mirror still serves v11; "
            "taking a version from a mirror silently yields a five-year-old boundary."),
        ),
        representation=LocalRepresentation.PREPPED_GEOJSON,
        payload_files=("eez.json",),
        expected_sha256=None,
    )


def _ports() -> DatasetManifest:
    return DatasetManifest(
        id="nga_world_port_index",
        provider="NGA Maritime Safety Information",
        dataset="World Port Index (Pub 150)",
        version="35th Edition",
        # THE CURRENCY, WHICH IS NOT THE EDITION. Both are recorded because confusing
        # them is how a 2019 dataset gets described as current.
        release_date="2019-08-31",
        identifier="https://msi.nga.mil/Publications/WPIndex",
        download_url="https://msi.nga.mil/Publications/WPIndex",
        license=LicenseKind.PUBLIC_DOMAIN,
        attribution="NGA Maritime Safety Information — World Port Index",
        terms_notes=(
            "Public domain: the publisher states all ports data has been released "
            "into the public domain. The live structured export sits behind the NGA WPI "
            "Viewing Application; the directly downloadable artefacts are labelled "
            "Archived 2019 Edition."
        ),
        resolution="Point locations with approximately 100 harbour characteristics",
        coverage_note="Global ports, with editorial selection by the publisher.",
        limitations=(
            ("DATA CURRENCY 2019-08-31. This is NOT a live port-operations feed and "
            "must not be described as a current port database."),
            "A printed-book derived product; facilities and services may have changed.",
            ("PROXIMITY IS CONTEXT ONLY. Nearest port establishes distance and identity. "
            "It does not establish origin, destination, intent or a port call."),
        ),
        representation=LocalRepresentation.PREPPED_ROWS,
        payload_files=("ports.json",),
        expected_sha256=None,
    )


def _bathymetry() -> DatasetManifest:
    return DatasetManifest(
        id="gebco_2025",
        provider="GEBCO Compilation Group",
        dataset="GEBCO_2025 Grid",
        version="2025",
        release_date="2025-08",
        identifier="https://doi.org/10.5285/37c52e96-24ea-67ce-e063-7086abc05f29",
        download_url="https://www.gebco.net/data_and_products/gridded_bathymetry_data/",
        license=LicenseKind.PUBLIC_DOMAIN,
        attribution="GEBCO Compilation Group — GEBCO_2025 Grid",
        terms_notes=(
            "Public domain: 'free to copy, publish, distribute and transmit' with "
            "adaptation permitted. The publisher offers user-defined area downloads, "
            "so a local subset is an explicitly supported delivery route."
        ),
        resolution="15 arc-second; 43200 x 86400; pixel-centre registered",
        coverage_note=(
            "Global. Only 27.3% of the ocean floor is mapped to modern standards."
        ),
        limitations=(
            "REFERENCE BATHYMETRY — NOT FOR NAVIGATION.",
            ("Only 27.3% of the ocean floor is mapped to modern standards; the "
            "remainder is interpolated or predicted from heterogeneous sources."),
            ("Merges heterogeneous source data into a single 15 arc-second cell, so no "
            "local sounding accuracy is implied."),
            ("Depth precision is limited by the grid interval. Do not report "
            "centimetre-looking precision from a 15 arc-second cell."),
        ),
        representation=LocalRepresentation.PREPPED_GRID,
        payload_files=("grid.json",),
        expected_sha256=None,
    )


def _eez_wfs() -> DatasetManifest:
    """
    Marine Regions EEZ, snapshotted from the OFFICIAL WFS.

    A SEPARATE MANIFEST FROM THE BULK PRODUCT, deliberately. The bulk geodatabase v12 is
    behind a registration form that collects personal data under GDPR, so it is not
    installed and no identity was fabricated to obtain it. The publisher's WFS is the
    official machine-accessible route and needs no registration.

    THE VERSION IS NOT ESTABLISHED, AND THAT IS THE FACTUAL RESULT
    -----------------------------------------------------------
    DF-X8.4H §2 requires the version to be proven from the service or reported honestly.
    It was attempted and it failed:

      * GetCapabilities (164 KB) lists ``MarineRegions:eez`` with an EMPTY Title and an
        EMPTY Abstract.
      * The larger ``/ows`` capabilities document (722 KB) is the same on this point.
      * ``/geoserver/rest/layers/MarineRegions:eez.json`` returns 401.
      * No OWS MetadataLink or ISO 19115 document is advertised.
      * The only version-like tokens in the document belong to OTHER layers --
        ``eez_12nm``, ``seavox_v16``..``v19`` -- and matching "12" from ``eez_12nm`` onto
        ``eez`` would be exactly the unfounded inference this checkpoint forbids.

    So ``version`` records a service snapshot, ``version_established`` is False, and the
    retrieval timestamp is the only version-like fact carried. The bulk product's
    "World EEZ v12, 2023-10-25" remains on record as a LEGACY STATIC SOURCE RECORD for a
    dataset this build does not have installed.
    """
    return DatasetManifest(
        id="marine_regions_eez_wfs",
        provider="VLIZ / Marine Regions",
        # `MarineRegions:eez`, NOT `MaritimeRegions:eez`.
    #
    # The GeoServer WORKSPACE is `MarineRegions`, so every layer in it is `MarineRegions:*`.
    # "MaritimeRegions" is the organisation's older trade name and is not the layer name --
    # which is exactly why `source_layer` two lines below has always been correct and this
    # field was not.
    #
    # Found by the browser, not by reading: the frontend's provenance guard refused to draw the
    # EEZ layer because this string did not match the layer the registry declares, and it said
    # so in the layer console. The guard did its job; the manifest was wrong.
    dataset="Marine Regions WFS — MarineRegions:eez",
        version="CURRENT-SERVICE-SNAPSHOT",
        version_established=False,
        source_mechanism=SourceMechanism.WFS,
        source_service="https://geo.vliz.be/geoserver/MarineRegions/wfs",
        source_layer="MarineRegions:eez",
        # 285 features, from GetFeature resultType=hits on 2026-10-05.
        source_feature_count=285,
        release_date=None,
        identifier="https://www.marineregions.org/",
        download_url=None,
        license=LicenseKind.CC_BY,
        attribution="VLIZ / Marine Regions",
        terms_notes=(
            "CC BY 4.0. The publisher asks that users refer others back to Marine "
            "Regions rather than redistributing its products, so DarkFleet keeps a LOCAL "
            "SNAPSHOT and displays attribution instead of bundling the source payload."
        ),
        resolution="Vector boundaries; no raster resolution",
        coverage_note=(
            "Global. WFS bbox -180 -62.79 .. 180 86.99. Features carry pol_type, "
            "sovereign1..3, territory1..3, mrgid, area_km2."
        ),
        limitations=(
            ("VERSION NOT ESTABLISHED FROM WFS METADATA. Retrieved as a service snapshot; "
            "the service publishes no per-layer version string for MarineRegions:eez."),
            ("Boundaries are DISPUTED, OVERLAPPING and PROVISIONAL: a third party's "
            "representation derived from treaties, and from CALCULATED MEDIAN LINES "
            "where treaties are unavailable."),
            ("Marine Regions does not determine sovereignty. DarkFleet reports the "
            "dataset's representation and nothing more."),
            ("Not the bulk geodatabase. The bulk World EEZ v12 release is a separate "
            "static product behind a registration form and is NOT installed."),
        ),
        representation=LocalRepresentation.PREPPED_GEOJSON,
        payload_files=("eez.json",),
        expected_sha256=None,
    )


def _high_seas_wfs() -> DatasetManifest:
    """
    Marine Regions WFS ``high_seas`` -- the EXPLICIT high-seas polygons.

    This exists because of a rule, not because a layer was available. DarkFleet refuses
    to infer HIGH_SEAS from the absence of an EEZ match, so a query outside every EEZ can
    only be answered HIGH_SEAS if there is real high-seas geometry to test against. The
    publisher supplies exactly one feature -- ``name='High Seas'``, ``mrgid=63203``,
    ``area_km2=222496418`` -- so the refusal can be replaced by a measurement.
    """
    return DatasetManifest(
        id="marine_regions_high_seas_wfs",
        provider="VLIZ / Marine Regions",
        dataset="Marine Regions WFS — MarineRegions:high_seas",
        version="CURRENT-SERVICE-SNAPSHOT",
        version_established=False,
        source_mechanism=SourceMechanism.WFS,
        source_service="https://geo.vliz.be/geoserver/MarineRegions/wfs",
        source_layer="MarineRegions:high_seas",
        source_feature_count=1,
        release_date=None,
        identifier="https://marineregions.org/eezmethodology.php",
        download_url=None,
        license=LicenseKind.CC_BY,
        attribution="VLIZ / Marine Regions",
        terms_notes="CC BY 4.0. Local snapshot with attribution; source payload not bundled.",
        resolution="Vector boundaries",
        coverage_note=(
            "Global high seas as one multipolygon feature. WFS bbox "
            "-180 -85.56 .. 180 90."
        ),
        limitations=(
            "VERSION NOT ESTABLISHED FROM WFS METADATA.",
            ("Used ONLY to answer HIGH_SEAS positively. Absence of a match in this layer "
            "is never read as high seas."),
        ),
        representation=LocalRepresentation.PREPPED_GEOJSON,
        payload_files=("high_seas.json",),
        expected_sha256=None,
    )


_BUILDERS = {
    "natural_earth_coastline": _coastline,
    "marine_regions_eez": _eez,
    "marine_regions_eez_wfs": _eez_wfs,
    "marine_regions_high_seas_wfs": _high_seas_wfs,
    "nga_world_port_index": _ports,
    "gebco_2025": _bathymetry,
}

#: Human labels for the layer console and system panel.
DATASET_LABELS = {
    "natural_earth_coastline": "Coastline",
    "marine_regions_eez": "EEZ / maritime boundaries (bulk, not installed)",
    "marine_regions_eez_wfs": "EEZ / maritime boundaries",
    "marine_regions_high_seas_wfs": "High seas",
    "nga_world_port_index": "Ports",
    "gebco_2025": "Bathymetry",
}


def known_manifest(dataset_id: str) -> DatasetManifest | None:
    """The verified manifest for a dataset id, or None if unrecognised.

    Returning None rather than raising: a caller asking about an unknown dataset should
    report NOT_INSTALLED, not crash a dossier.
    """
    builder = _BUILDERS.get(dataset_id)
    return builder() if builder is not None else None


def known_dataset_ids() -> tuple[str, ...]:
    return tuple(_BUILDERS)


def dataset_label(dataset_id: str) -> str:
    return DATASET_LABELS.get(dataset_id, dataset_id)
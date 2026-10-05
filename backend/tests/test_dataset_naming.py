"""Pin the WFS layer NAME, so `dataset` and `source_layer` cannot drift apart again.

THE DEFECT
----------
`dataset="Marine Regions WFS - MaritimeRegions:eez"` and `source_layer="MarineRegions:eez"`
disagreed in the same manifest. The GeoServer workspace is `MarineRegions`, so every layer is
`MarineRegions:*`; "MaritimeRegions" is the organisation's older trade name, not the layer.

It survived because both strings are individually plausible and nothing compared them. The
frontend's provenance guard caught it -- the EEZ layer silently drew nothing -- and that is a
very expensive way to learn that two fields in one literal should agree.

WHAT IS ASSERTED
----------------
For every service-sourced dataset, the layer named in `dataset` is the layer named in
`source_layer`. `dataset` is prose for humans and may carry a prefix, so the check is that
`source_layer` APPEARS in `dataset` -- which is what makes the mismatch above impossible.
"""

from __future__ import annotations

from darkfleet.maritime.datasets import SourceMechanism
from darkfleet.maritime.registry import known_dataset_ids, known_manifest

#: Datasets obtained from a live service rather than a static download.
SERVICE_MECHANISMS = {SourceMechanism.WFS, SourceMechanism.ARCGIS_FEATURE_SERVICE}


class TestServiceDatasetNaming:
    def test_the_dataset_name_contains_the_layer_it_names(self) -> None:
        for dataset_id in known_dataset_ids():
            manifest = known_manifest(dataset_id)
            assert manifest is not None, f"{dataset_id} has no manifest"
            if manifest.source_mechanism not in SERVICE_MECHANISMS:
                continue
            layer = manifest.source_layer
            assert layer, (
                f"{dataset_id} claims {manifest.source_mechanism} but names no source layer, "
                "so nothing says which layer the data actually came from"
            )
            # THE assertion. `MaritimeRegions:eez` inside a `MarineRegions:eez` product is the
            # drift this exists to prevent.
            assert layer in manifest.dataset, (
                f"{dataset_id}: source_layer {layer!r} does not appear in dataset "
                f"{manifest.dataset!r}. One of the two is a typo, and an operator cannot tell "
                "which -- the provenance guard will refuse to draw rather than misattribute."
            )

    def test_the_wfs_workspace_is_marineregions(self) -> None:
        # The workspace name is a fact about the service, and getting it wrong in a source
        # URL is the same class of error.
        for dataset_id in known_dataset_ids():
            manifest = known_manifest(dataset_id)
            if manifest is None or manifest.source_mechanism is not SourceMechanism.WFS:
                continue
            service = manifest.source_service or ""
            assert "/geoserver/MarineRegions/" in service, (
                f"{dataset_id}: WFS service {service!r} does not name the MarineRegions "
                "workspace, whose layers are MarineRegions:*"
            )
            assert "MaritimeRegions" not in service, (
                f"{dataset_id}: {service!r} uses 'MaritimeRegions'; the workspace is "
                "'MarineRegions'"
            )

    def test_every_service_dataset_names_its_service(self) -> None:
        for dataset_id in known_dataset_ids():
            manifest = known_manifest(dataset_id)
            if manifest is None or manifest.source_mechanism not in SERVICE_MECHANISMS:
                continue
            assert manifest.source_service, (
                f"{dataset_id} is a {manifest.source_mechanism.value} source with no service "
                "URL, so the snapshot cannot be re-fetched or checked"
            )

"""Direct pipeline logger cannot leak secrets from untrusted provider metadata."""

from __future__ import annotations

from darkfleet import observability


def test_direct_pipeline_stage_logger_scrubs_untrusted_scene_id(monkeypatch) -> None:
    """The STAC logging path bypasses the job runner's stage-history boundary."""
    output: list[str] = []
    monkeypatch.setattr(
        observability.logger, "info", lambda fmt, *args: output.append(fmt % args)
    )
    secret = "CANARY_TOKEN_SHOULD_NEVER_APPEAR"
    observability.stage(
        "STAC",
        f"selected scene S1A_TEST; resolution=10; sig={secret}; "
        f"Authorization: Bearer {secret}; body={{\"apiKey\":\"{secret}\"}}",
    )
    assert len(output) == 1
    assert secret not in output[0]
    assert "selected scene S1A_TEST" in output[0]
    assert "resolution=10" in output[0]
    assert "sig=<redacted>" in output[0]

"""Fail-closed adapter classification tests for the H7/H8 hardware runner."""

from __future__ import annotations

import unittest

from run_hardware_benchmark import classify_gpu


class GpuIdentityTests(unittest.TestCase):
    def test_real_amd_d3d11_adapter_is_eligible(self) -> None:
        identity = {"webgl2": True,
                    "unmaskedRenderer": "ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11)",
                    "unmaskedVendor": "Google Inc. (AMD)"}
        status, _ = classify_gpu(identity)
        self.assertEqual(status, "HARDWARE_IDENTIFIED")

    def test_software_rasterizers_are_not_hardware(self) -> None:
        for text in ("ANGLE (Google, Vulkan 1.3 SwiftShader Device)",
                     "llvmpipe (LLVM 17.0)", "Microsoft Basic Render Driver"):
            with self.subTest(text=text):
                status, _ = classify_gpu({"webgl2": True, "unmaskedRenderer": text})
                self.assertEqual(status, "SOFTWARE")

    def test_masked_unknown_or_non_webgl2_identity_fails_closed(self) -> None:
        for identity in (
            {"webgl2": True, "renderer": "WebKit WebGL", "unmaskedRenderer": None},
            {"webgl2": True, "unmaskedRenderer": "UnknownVirtualGpu"},
            {"webgl2": False, "unmaskedRenderer": "AMD Radeon D3D11"},
            {},
        ):
            with self.subTest(identity=identity):
                status, _ = classify_gpu(identity)
                self.assertEqual(status, "UNVERIFIED")


if __name__ == "__main__":
    unittest.main()

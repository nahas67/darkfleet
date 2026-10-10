"""Launch an isolated real Chromium browser to execute DF-X9.8 H7/H8 WebGL checks.

Usage, from the repository root (requires Python playwright and installed Chrome):
    python tools/ais-gpu/run_hardware_benchmark.py --output ./ais-browser-evidence.json

The target is STRICTLY localhost. The script refuses to call benchmark routines
unless a real WebGL context exposes an identifiable non-software adapter.
Browser JavaScript runs the actual application renderer; Python merely records
the result. No CPU-only Vitest timing is substituted for browser frame timing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

HARNESS_URL = "http://127.0.0.1:5173/tools/ais-gpu/index.html"
CHROME_PATH = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
SOFTWARE_MARKERS = ("swiftshader", "llvmpipe", "softpipe", "software raster", "software renderer", "lavapipe", "microsoft basic render")
HARDWARE_MARKERS = ("nvidia", "geforce", "radeon", "amd", "intel", "iris", "uhd graphics", "arc(tm)", "d3d11", "d3d12")


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def classify_gpu(gpu: dict[str, Any]) -> tuple[str, str]:
    """Fail closed on masking/ambiguous driver strings; do not infer from WebGL alone."""
    if gpu.get("webgl2") is not True:
        return "UNVERIFIED", "A WebGL2 context was not observed"
    renderer = gpu.get("unmaskedRenderer")
    vendor = gpu.get("unmaskedVendor")
    if not isinstance(renderer, str) or not renderer.strip():
        return "UNVERIFIED", "Unmasked adapter unavailable; WebGL alone is not proof of hardware"
    identity = f"{vendor or ''} {renderer}".lower()
    if any(marker in identity for marker in SOFTWARE_MARKERS):
        return "SOFTWARE", "Identified software rasterizer; hardware FPS gate not satisfied"
    if not any(marker in identity for marker in HARDWARE_MARKERS):
        return "UNVERIFIED", "Unknown adapter identity; fail closed rather than imply hardware"
    return "HARDWARE_IDENTIFIED", "Hardware-like vendor/adapter string reported by live WebGL context"


def source_identity() -> dict[str, Any]:
    """Bind evidence to the exact local file bytes Vite could serve at run time."""
    root = Path(__file__).resolve().parents[2]
    paths = (
        "src/globe/aisRenderer.ts", "src/globe/glyphGeometry.ts",
        "tools/ais-gpu/main.ts", "tools/ais-gpu/index.html",
    )
    digests = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths}
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True,
                          text=True, check=False)
    return {"gitHead": head.stdout.strip() if head.returncode == 0 else None,
            "sourceSha256": digests, "identityNote": "Live Vite development sources; compare file hashes when reproducing"}


def browser_run(executable_path: Path, *, headed: bool, timeout_ms: int) -> dict[str, Any]:
    outcome: dict[str, Any] = {
        "collectedAtUtc": now_utc(), "url": HARNESS_URL,
        "status": "UNVERIFIED", "reason": "No browser execution attempted yet",
        "browserExecutable": str(executable_path), "headed": headed,
        "source": "real Chrome/Edge browser executing the local AIS harness; synthetic contact fixtures",
        "sourceIdentity": source_identity(),
    }
    if not executable_path.is_file():
        return {**outcome, "reason": "Browser executable not installed"}

    with sync_playwright() as playwright:
        browser = None
        try:
            browser = playwright.chromium.launch(
                executable_path=str(executable_path), headless=not headed,
                args=[
                    "--enable-gpu", "--enable-webgl", "--ignore-gpu-blocklist",
                    "--disable-software-rasterizer", "--use-angle=d3d11",
                    "--disable-background-timer-throttling", "--enable-precise-memory-info",
                    "--js-flags=--expose-gc",
                ], timeout=timeout_ms,
            )
            context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            # The harness is local-first; do not solicit external basemap or AIS
            # data while running performance fixtures. Blob/data are local assets.
            context.route("**/*", lambda route: (
                route.continue_() if route.request.url.startswith(("http://127.0.0.1:5173/", "data:", "blob:"))
                else route.abort("blockedbyclient")
            ))
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)[:500]))
            page.goto(HARNESS_URL, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_function("() => Boolean(window.dfAisGpuBench)", timeout=timeout_ms)
            outcome.update({
                "browserVersion": browser.version,
                "userAgent": page.evaluate("navigator.userAgent"),
                "webgl": page.evaluate("window.dfAisGpuBench.gpuInfo()"),
                "canvas": page.evaluate("[document.querySelector('canvas')?.clientWidth, document.querySelector('canvas')?.clientHeight]"),
            })
            gpu = outcome["webgl"]
            outcome["hardwareIdentity"], outcome["reason"] = classify_gpu(gpu if isinstance(gpu, dict) else {})
            if outcome["hardwareIdentity"] != "HARDWARE_IDENTIFIED":
                outcome["pageErrors"] = errors
                return outcome

            outcome["initialMemory"] = page.evaluate("""() => {
              const gcAvailable = typeof window.gc === 'function';
              if (gcAvailable) window.gc();
              return { gcAvailable,
                jsHeapAfterGcBytes: performance.memory?.usedJSHeapSize ?? null,
                note: 'JS heap only, NOT GPU VRAM; GC exposure is checked rather than assumed.' };
            }""")

            # Evaluate the actual in-page Cesium renderer. Per-stage data contains
            # real Cesium postRender and RAF intervals, not CPU-only model timings.
            outcome["stages"] = []
            for count in (500, 1000, 2500, 5000, 10000):
                stage = page.evaluate(f"window.dfAisGpuBench.runStage({count})")
                outcome["stages"].append(stage)
                if not stage.get("frames", {}).get("sceneRenderedDuringSample"):
                    outcome["reason"] = f"Cesium did not render during stage {count}; FPS unverifiable"
                    outcome["status"] = "PARTIAL_BROWSER_GPU"
                    outcome["pageErrors"] = errors
                    return outcome
            outcome["picking"] = page.evaluate("window.dfAisGpuBench.measureSelectionAndPick()")
            outcome["dense10k"] = page.evaluate("window.dfAisGpuBench.runStage(10000, true)")
            outcome["lifecycle"] = page.evaluate("window.dfAisGpuBench.lifecycle(25)")
            outcome["postLifecycleMemory"] = page.evaluate("""() => {
              const gcAvailable = typeof window.gc === 'function';
              if (gcAvailable) window.gc();
              return { gcAvailable,
                jsHeapAfterGcBytes: performance.memory?.usedJSHeapSize ?? null,
                note: 'End of full staged benchmark after 25 renderer cycles, not a clean identical-heap baseline.' };
            }""")
            outcome["basemap"] = page.evaluate("window.dfAisGpuBench.basemapCycles(25)")
            outcome["pageErrors"] = errors
            outcome["status"] = "MEASURED_BROWSER_GPU"
            outcome["reason"] = "Actual browser WebGL/JS stages completed; see per-metric verification flags"
            return outcome
        except (PlaywrightError, PlaywrightTimeout, OSError, ValueError) as exc:
            outcome["reason"] = f"Browser execution failed: {type(exc).__name__}: {str(exc)[:600]}"
            return outcome
        finally:
            if browser is not None:
                browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("ais-browser-evidence.json"))
    parser.add_argument("--browser", choices=("chrome", "edge"), default="chrome")
    parser.add_argument("--headed", action="store_true", help="Attempt visible browser for hardware GPU")
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    args = parser.parse_args()
    executable = CHROME_PATH if args.browser == "chrome" else EDGE_PATH
    evidence = browser_run(executable, headed=args.headed, timeout_ms=args.timeout_ms)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "reason": evidence["reason"],
                      "hardwareIdentity": evidence.get("hardwareIdentity"),
                      "webgl": evidence.get("webgl"), "output": str(args.output)}, indent=2))
    return 0 if evidence["status"] == "MEASURED_BROWSER_GPU" else 2


if __name__ == "__main__":
    sys.exit(main())

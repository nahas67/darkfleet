"""The two reachability metrics must disagree when the code says they should.

The point of splitting CALLER_REACHABLE from PRODUCT_REACHABLE is that the first
one is gameable. A helper module can hold a perfect request, be covered by tests,
and still never be loaded by the running application -- and a gate that reports
that as a delivered feature is worse than no gate, because it certifies the
opposite of the truth.

These tests build synthetic module trees on disk and assert the divergence, so
the distinction is pinned by behaviour rather than by intent.

No fake product code is written into ``src/``: every tree here is a temporary
directory, cleaned up by the fixture.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import route_reachability as gate

DOLLAR = "$"


def lit(template: str) -> str:
    """Build a TypeScript template literal without shell interpolation."""
    return template.replace("§", DOLLAR)


def write(root: Path, relative: str, body: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path.resolve()


@pytest.fixture
def tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A synthetic src/ tree with index.html and main.tsx, swapped in.

    monkeypatch is used rather than a real file move so the fixture cannot leave
    the repository in a half-swapped state if an assertion fails mid-test.
    """
    src = tmp_path / "src"
    src.mkdir()
    (tmp_path / "index.html").write_text(
        '<script type="module" src="/src/main.tsx"></script>', encoding="utf-8"
    )
    monkeypatch.setattr(gate, "ROOT", tmp_path)
    monkeypatch.setattr(gate, "SRC", src)
    monkeypatch.setattr(gate, "INDEX_HTML", tmp_path / "index.html")
    return src


def callers_in(src: Path) -> list[gate.Caller]:
    out: list[gate.Caller] = []
    for path in src.rglob("*"):
        if path.suffix in (".ts", ".tsx"):
            for literal in gate._template_paths(path.read_text(encoding="utf-8")):
                out.append(gate.Caller(literal, path.resolve()))
    return out


def product_literals(src: Path) -> set[str]:
    return gate.product_reachable(callers_in(src), gate.entry_module())


# ------------------------------------------------------ the metrics must differ


def test_a_dead_helper_is_caller_reachable_but_not_product_reachable(tree: Path) -> None:
    """The case the second metric exists for.

    ``orphan.ts`` holds a correct request for a real route. Nothing imports it.
    The old gate reported that as a shipped feature.
    """
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(tree, "App.tsx", "export function App() {\n  return <div>hello</div>;\n}\n")
    write(
        tree,
        "orphan.ts",
        "export const URL = '/api/debug/§{scanId}/§{layer}';\n"
        "export function call() {\n  return fetch(URL);\n}\n".replace("§", DOLLAR),
    )

    everything = {c.literal for c in callers_in(tree)}
    assert gate._matches("/debug/{scan_id}/{layer}", "/api/debug/" + lit("${scanId}/${layer}"))
    assert any(gate._matches("/debug/{scan_id}/{layer}", x) for x in everything), (
        "precondition: the dead helper must still satisfy CALLER_REACHABLE"
    )

    assert not any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    ), "a module nothing imports must not be PRODUCT_REACHABLE"


def test_a_test_only_caller_is_not_product_reachable(tree: Path) -> None:
    """A test is not a user.

    The helper is imported by a test file and nothing else. CALLER_REACHABLE sees
    it; PRODUCT_REACHABLE must not, because a test file is not in the entry
    point's runtime import closure.
    """
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(tree, "App.tsx", "export function App() {\n  return <div>hi</div>;\n}\n")
    write(
        tree,
        "api.ts",
        "export const URL = '/api/debug/" + lit("${scanId}/${layer}") + "';\n",
    )
    write(
        tree,
        "api.test.ts",
        "import { URL } from './api';\nit('has a url', () => { expect(URL).toBeTruthy(); });\n",
    )

    assert any(gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)) is False
    assert not any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    )


def test_a_live_component_path_is_product_reachable(tree: Path) -> None:
    """The positive case: the same helper, actually wired up.

    An earlier draft of this test had ``App`` render ``<Panel />`` WITHOUT importing
    it, so ``Panel`` and ``api.ts`` were both dead code and the gate refused the
    route. The gate was right and the tree was wrong -- which is the behaviour
    worth keeping.
    """
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(
        tree,
        "App.tsx",
        "import { Panel } from './Panel';\nexport function App() {\n  return <Panel />;\n}\n",
    )
    write(
        tree,
        "Panel.tsx",
        "import { load } from './api';\nexport function Panel() {\n  return <b onClick={load} />;\n}\n",
    )
    write(
        tree,
        "api.ts",
        "export const URL = '/api/debug/" + lit("${scanId}/${layer}") + "';\n"
        "export const load = () => fetch(URL);\n",
    )

    assert any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    ), "a helper on a component render path must be PRODUCT_REACHABLE"


def test_a_rendered_but_unimported_component_is_still_dead(tree: Path) -> None:
    """Rendering a component is not importing it.

    The companion to the failure above, pinned deliberately: JSX referencing a name
    does not create an import edge, and a gate that believed it would credit a
    route for code the bundler never loads.
    """
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(tree, "App.tsx", "export function App() {\n  return <Panel />;\n}\n")
    write(
        tree,
        "api.ts",
        "export const URL = '/api/debug/" + lit("${scanId}/${layer}") + "';\n",
    )

    assert not any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    )


def test_stranded_data_layer_code_is_not_product_reachable(tree: Path) -> None:
    """Reachable, but never on a render path.

    Two data modules import each other and nothing renders them. The literal is in
    the shipped closure, so a closure-only check would pass; the render-path
    requirement is what makes it fail.
    """
    write(tree, "main.tsx", "export const Root = null;\n")
    write(tree, "core.ts", "import { helper } from './helper';\nexport const core = helper;\n")
    write(
        tree,
        "helper.ts",
        "export const helper = '/api/debug/" + lit("${scanId}/${layer}") + "';\n",
    )

    assert not any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    ), "code with no component on the path is not a product surface"


# ------------------------------------------------------------ import mechanics


def test_a_type_only_import_is_not_a_runtime_edge(tree: Path) -> None:
    """`import type` erases before execution.

    A type-only dependency must not connect a module to the running application,
    or a types-only file could make anything look reachable.
    """
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(tree, "App.tsx", "export function App() {\n  return <div />;\n}\n")
    write(tree, "types.ts", "export type Thing = string;\n")
    write(
        tree,
        "orphan.ts",
        "import type { Thing } from './types';\n"
        "export const URL = '/api/debug/" + lit("${scanId}/${layer}") + "';\n"
        "export type Also = Thing;\n",
    )

    assert not any(
        gate._matches("/debug/{scan_id}/{layer}", x) for x in product_literals(tree)
    )


def test_entry_point_is_read_from_index_html(tree: Path) -> None:
    """Not hardcoded.

    A hardcoded entry path is a path that quietly stops being true the day the
    file is renamed, and every route would then read as an orphan.
    """
    write(tree, "App.tsx", "export function App() {\n  return <div />;\n}\n")
    assert gate.entry_module() is None, "main.tsx has not been written yet"

    entry = write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    assert gate.entry_module() == entry


def test_missing_index_html_reports_no_entry(tree: Path) -> None:
    """Absent entry point is stated, not silently treated as full reachability."""
    (tree.parent / "index.html").unlink()
    assert gate.entry_module() is None
    assert product_literals(tree) == set()


def test_extensionless_and_directory_imports_resolve(tree: Path) -> None:
    """Real-world import styles: no extension, and directory index."""
    write(tree, "main.tsx", "import { App } from './App';\nexport const Root = App;\n")
    write(tree, "App.tsx", "import { api } from './lib';\nimport { more } from './nested';\n")
    write(
        tree,
        "lib/index.ts",
        "export const api = '/api/debug/" + lit("${scanId}/${layer}") + "';\n",
    )
    write(tree, "nested/index.tsx", "export const more = 1;\n")

    resolved = {p.name for p in gate.value_imports(tree / "App.tsx")}
    assert resolved == {"index.ts", "index.tsx"}


def test_component_detection_needs_a_capitalised_tag(tree: Path) -> None:
    """Lower-case tags are DOM elements, not components.

    An `<h1>` does not make a data module a render surface.
    """
    write(tree, "plain.ts", "export const el = '<h1>hi</h1>';\n")
    write(tree, "real.tsx", "export const C = () => <Panel />;\n")
    assert gate.is_component(tree / "plain.ts") is False
    assert gate.is_component(tree / "real.tsx") is True


# --------------------------------------------------- the real product, today


def test_debug_layer_route_is_both_metrics_in_this_repo() -> None:
    """DF-X6C's own claim, checked against the repository rather than asserted.

    `/debug/{scan_id}/{layer}` was caller-reachable only by accident of where the
    client happened to build the URL; the product-reachability metric is what
    makes "reachable from the running app" a checked statement.
    """
    src = Path(__file__).resolve().parents[2] / "src"
    entry = gate.entry_module()
    assert entry is not None, "index.html must declare a module entry point"

    caller = {c.literal for c in callers_in(src)}
    product = product_literals(src)

    route = "/debug/{scan_id}/{layer}"
    assert any(gate._matches(route, x) for x in caller), "debug layer lost its caller"
    assert any(gate._matches(route, x) for x in product), "debug layer left the render path"


def test_probe_route_is_product_reachable() -> None:
    """The probe must be reachable, and reachable by interaction.

    A click handler is the user action; the gate cannot see the click, but it can
    insist the request lives in a component the application renders.

    Deliberately takes no ``tree`` fixture: that fixture repoints the gate at a
    temporary directory, and asking for it here measured the fixture rather than
    this repository.
    """
    src = Path(__file__).resolve().parents[2] / "src"
    product = product_literals(src)
    route = "/scans/{scan_id}/debug/probe"
    assert any(gate._matches(route, x) for x in product), (
        "the coordinate probe must be reachable from the running application"
    )
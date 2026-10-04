"""
Strip comments from source text before pattern assertions.

WHY THIS EXISTS

Source-text pins must strip comments FIRST. A module docstring that explains a defect
necessarily QUOTES the removed code -- the whole point of the comment is to say what was
deleted. So a naive regex over raw source matches the historical example inside the
explanation and reports the very defect it is meant to prevent, forever.

This has bitten twice in this repository (`correlationCase.test.ts` and
`test_wake_scoring_authority.py`). The fix is to make the pin operate on CODE, not on
prose about code.

The comment syntaxes handled here are the ones the repository actually uses:
Python `#`, JS/TS `//` and block comments, and CSS `/* */`. String literals are left
alone: a `//` inside a URL must not be treated as a comment opener, and removing string
content would change code semantics.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def strip_line_comments(text: str) -> str:
    """Remove `//` comments that are not inside a string literal."""
    out: list[str] = []
    in_string: str | None = None
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string is not None:
            out.append(ch)
            if ch == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if ch == in_string:
                in_string = None
            i += 1
            continue
        if ch in "\"'`":
            in_string = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def strip_block_comments(text: str) -> str:
    """Remove /* */ comments, preserving newlines so line numbers stay meaningful."""
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)
    return re.sub(r"^\s*\*.*$", "", text, flags=re.MULTILINE)


def strip_python_comments(text: str) -> str:
    """Remove `#` comments outside string literals."""
    out: list[str] = []
    quote: str | None = None
    for line in text.splitlines(keepends=True):
        if quote is None:
            stripped = re.sub(r"#.*$", "", line)
            # Track quote state across lines for triple-quoted and normal strings.
            for match in re.finditer(r"'''|\"\"\"|[\"']", stripped):
                token = match.group(0)
                if quote is None:
                    quote = token if token in "'\"" else None
            if quote is None:
                out.append(stripped)
                continue
        out.append(line)
        if quote in ('"""', "'''"):
            if quote in line:
                quote = None
        else:
            for match in re.finditer(r"[\"']", line):
                if match.start() == 0 or line[match.start() - 1] != "\\":
                    quote = None
                    break
    return "".join(out)


def strip_css_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)


def strip_for(path: Path) -> str:
    """Strip comments appropriate to the file's extension."""
    text = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix == ".py":
        return strip_python_comments(text)
    if suffix == ".css":
        return strip_css_comments(text)
    if suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs"):
        return strip_line_comments(strip_block_comments(text))
    return text


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print(strip_for(Path(arg)))
"""Strip the UTF-8 BOM that a PowerShell `Set-Content -Encoding UTF8` wrote into source files.

Python tolerates a BOM when READING a source file, so nothing failed visibly -- but an AST
walk of the file text does not, and more importantly the BOM is an invisible non-ASCII
character at offset 0 of a file the product ships. The same `Set-Content` was used across
this session, so every file it touched is checked rather than just the one that happened to
fail.
"""
import pathlib

root = pathlib.Path(r"C:\Users\nahas\OneDrive\Desktop\darkfleet")
BOM = b"\xef\xbb\xbf"

targets = list((root / "backend" / "darkfleet").rglob("*.py"))
targets += list((root / "backend" / "tests").rglob("*.py"))
targets += list((root / "backend" / "tools").rglob("*.py"))
targets += list((root / "src").rglob("*.ts"))
targets += list((root / "src").rglob("*.tsx"))

fixed = []
for path in targets:
    data = path.read_bytes()
    if data.startswith(BOM):
        path.write_bytes(data[len(BOM):])
        fixed.append(str(path.relative_to(root)))

print(f"stripped BOM from {len(fixed)} file(s)")
for name in fixed:
    print(f"  {name}")

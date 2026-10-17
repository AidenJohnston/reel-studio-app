#!/usr/bin/env python3
"""pack.py OUT.zip FILE...  -> a zip with fixed timestamps and permissions, so equal inputs give an equal archive."""
import hashlib
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sys.argv[2:]:
        p = Path(name)
        zi = zipfile.ZipInfo(p.name, date_time=(2025, 3, 3, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = (0o755 if p.suffix in ("", ".exe") and p.name != "BUILDINFO.txt" else 0o644) << 16
        z.writestr(zi, p.read_bytes())
h = hashlib.sha256(out.read_bytes()).hexdigest()
print("%s  %s  (%.1f MB)" % (h, out.name, out.stat().st_size / 1e6))

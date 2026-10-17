#!/usr/bin/env python3
"""Re-create packaging/fonts/ from the upstream releases (OFL fonts only), verifying checksums.

The folder is committed, so builds do NOT need this. Run it only to audit or to bump a font:
    python packaging/fetch_fonts.py [--out DIR]     (default: packaging/fonts-check, then diff against packaging/fonts)
"""
import argparse, hashlib, shutil, sys, urllib.request, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = {"User-Agent": "reel-studio-packaging/1.0"}
ARCHIVES = {
    "Inter-4.1.zip": ("https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
                      "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e"),
    "Roboto_v3.016.zip": ("https://github.com/googlefonts/roboto-3-classic/releases/download/v3.016/Roboto_v3.016.zip",
                          "1653dbe12f248da8fb0b9920db7b9496cd677ed3981154f6f15285c8bd4e334f"),
    "Fraunces_1.000.zip": ("https://github.com/undercasetype/Fraunces/releases/download/1.000/UnderCaseType_Fraunces_1.000.zip",
                           "8d8b81dfaeb89433f5c908e1d8d0a4b202bd627bd80d4cd5ff56f311fdcad19f"),
}
MONTSERRAT = {  # fetched file by file from tag v7.222
    "Montserrat-Regular.ttf": "6eabd0fb8e3066b6155bac338ef5a6c35b9963ab3f39be7c67edc4a99d870699",
    "Montserrat-Medium.ttf": "7ce96811837174f00c087b73332aed3f04a19069248ab46213d9ea05ff879cbc",
    "Montserrat-SemiBold.ttf": "49fbfce003ad1692d7c9a6502791577088c12c50088d4caa27dbbfe540ad9d13",
    "Montserrat-Bold.ttf": "4e6d93bc38122c371acb8dc0dbefbf2649c235191e1be136bb5720546d719808",
    "Montserrat-ExtraBold.ttf": "1b364c3400bf7b1cc2c47a25dd0d3edd8331da451412aa5539080f78f8f70b63",
}
LICENSES = {  # name -> (url, sha256)
    "Montserrat-OFL.txt": ("https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/OFL.txt", "41f82bb4d24b304f30f7136bc47abdd083782e4265c984160f5649d1e78ea49c"),
    "Roboto-OFL.txt": ("https://raw.githubusercontent.com/googlefonts/roboto-3-classic/v3.016/OFL.txt", "061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41"),
    "Fraunces-OFL.txt": ("https://raw.githubusercontent.com/undercasetype/Fraunces/1.000/OFL.txt", "bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b"),
}
PICK = {  # archive -> [(member, output name)]
    "Inter-4.1.zip": [("extras/ttf/Inter-%s.ttf" % w, "Inter-%s.ttf" % w) for w in ("Regular", "Medium", "SemiBold", "Bold")] + [("LICENSE.txt", "Inter-OFL.txt")],
    "Roboto_v3.016.zip": [("hinted/static/Roboto-%s.ttf" % w, "Roboto-%s.ttf" % w) for w in ("Regular", "Medium", "Bold")],
    "Fraunces_1.000.zip": [("UnderCaseType_Fraunces_1.000/Fonts - Desktop/static/ttf/Fraunces72pt-%s.ttf" % w, "Fraunces-%s.ttf" % w) for w in ("Regular", "SemiBold", "Bold")],
}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def check(data, want, what):
    got = hashlib.sha256(data).hexdigest()
    if got != want:
        sys.exit("CHECKSUM MISMATCH %s\n  want %s\n  got  %s" % (what, want, got))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "fonts-check"))
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    for name, (url, sha) in ARCHIVES.items():
        data = get(url)
        check(data, sha, name)
        tmp = out / name
        tmp.write_bytes(data)
        with zipfile.ZipFile(str(tmp)) as z:
            for member, dest in PICK[name]:
                (out / dest).write_bytes(z.read(member))
        tmp.unlink()
    for name, sha in MONTSERRAT.items():
        data = get("https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/fonts/ttf/" + name)
        check(data, sha, name)
        (out / name).write_bytes(data)
    for name, (url, sha) in LICENSES.items():
        data = get(url)
        check(data, sha, name)
        (out / name).write_bytes(data)
    print("wrote", out)
    same = all((out / p.name).exists() and (out / p.name).read_bytes() == p.read_bytes() for p in (HERE / "fonts").glob("*.ttf"))
    print("identical to packaging/fonts:", same)


if __name__ == "__main__":
    main()

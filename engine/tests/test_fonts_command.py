"""The fonts command lists what a caption can name, the person's own first, and those names resolve."""
import os
import shutil
from pathlib import Path

from reelengine import captions, cli

BUNDLED = Path(captions.__file__).parent / "fonts"


def test_own_font_is_listed_first_and_resolves(tmp_path, monkeypatch):
    root = tmp_path / "Reel Studio ü"
    mine = root / "Library" / "Fonts"
    mine.mkdir(parents=True)
    shutil.copyfile(BUNDLED / "Fraunces_700Bold.ttf", mine / "My Brand.ttf")
    (mine / "broken.ttf").write_bytes(b"not a font")
    monkeypatch.setenv("REELENGINE_ROOT", str(root))
    monkeypatch.setenv("REELENGINE_FONTS", str(mine))
    captions.font_index.cache_clear()
    parsed = cli.build_parser().parse_args(["fonts"])
    result = parsed.fn(parsed)
    first = result["fonts"][0]
    # fails if the person's font is missing, not marked theirs, or a damaged file is offered
    assert first["file"] == "My Brand.ttf" and first["yours"] is True
    assert "broken.ttf" not in {f["file"] for f in result["fonts"]}
    assert any(not f["yours"] for f in result["fonts"])
    name = next(n for n in first["names"] if n != "My Brand")
    family, path, _, warning = captions.resolve_font(name)
    assert warning is None and path == mine / "My Brand.ttf"
    captions.font_index.cache_clear()


def test_compositor_reads_every_font_folder_in_the_list(tmp_path, monkeypatch):
    from reelengine import compose_util
    a, b = tmp_path / "Library Fonts", tmp_path / "bundled"
    a.mkdir()
    b.mkdir()
    monkeypatch.setenv("REELENGINE_FONTS", os.pathsep.join([str(a), str(b)]))
    # fails if the path list the app sends is read as one folder, so graphics fall back to other faces
    assert compose_util.font_dirs()[:2] == [a, b]

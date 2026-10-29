"""project.json held open by another program while the engine writes it (Windows).

Python's open() on Windows shares read and write but not delete, so os.replace onto a file held that way
fails with PermissionError, the same as when a virus scanner or sync tool holds project.json.
"""
import json
import sys
import threading

import pytest

from reelengine import project as projmod

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="only Windows refuses to rename over an open file")


def test_write_json_waits_out_a_file_held_for_a_moment(tmp_path):
    target = tmp_path / "project.json"
    target.write_text('{"version": 1}\n', encoding="utf-8")
    held = open(target, "rb")
    threading.Timer(0.8, held.close).start()
    try:
        projmod.write_json(target, {"version": 2})
    finally:
        held.close()
    assert json.loads(target.read_text(encoding="utf-8")) == {"version": 2}
    assert not list(tmp_path.glob("*.tmp"))


def test_write_json_gives_up_without_leaving_its_temp_file(tmp_path, monkeypatch):
    monkeypatch.setattr(projmod, "_REPLACE_TRIES", 2)
    target = tmp_path / "project.json"
    target.write_text('{"version": 1}\n', encoding="utf-8")
    with open(target, "rb"):
        with pytest.raises(PermissionError):
            projmod.write_json(target, {"version": 2})
    assert json.loads(target.read_text(encoding="utf-8")) == {"version": 1}
    assert not list(tmp_path.glob("*.tmp"))

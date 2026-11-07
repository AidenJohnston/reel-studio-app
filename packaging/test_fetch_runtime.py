"""The runtime cache in fetch_runtime.py: run with `python -m pytest packaging/test_fetch_runtime.py`."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location("fetch_runtime", Path(__file__).with_name("fetch_runtime.py"))
fetch_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_runtime)

FINGERPRINT = {"pbs": "x", "req": "y", "licenses": [], "ffmpeg": ["z"]}


def runtime(tmp_path: Path, **manifest) -> Path:
    rt = tmp_path / "win"
    (rt / "python").mkdir(parents=True)
    (rt / "ffmpeg").mkdir()
    (rt / "runtime-manifest.json").write_text(json.dumps({"fingerprint": FINGERPRINT, **manifest}), encoding="utf-8")
    return rt


def test_a_cross_fetch_without_packages_is_not_reused_by_a_normal_build(tmp_path):
    # what a --no-pip run writes: the same fingerprint, no packages installed
    assert not fetch_runtime.up_to_date(runtime(tmp_path, dependencies=False), FINGERPRINT)


def test_a_complete_runtime_is_reused_and_a_changed_one_is_not(tmp_path):
    rt = runtime(tmp_path, dependencies=True)
    assert fetch_runtime.up_to_date(rt, FINGERPRINT)
    assert not fetch_runtime.up_to_date(rt, {**FINGERPRINT, "req": "other"})

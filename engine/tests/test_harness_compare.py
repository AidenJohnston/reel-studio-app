"""The speed harness's checks have one right answer each: these pin them on made-up frames,
sounds and a throwaway git repo, with no engine or FFmpeg involved."""
import math
import shutil
import subprocess

import numpy as np
import pytest

from harness import compare, replay
from harness.engines import Refusal, extract_reference, git_blob_id, verify_reference

W, H = 540, 960            # preview size; caption boxes are in 1080x1920 output pixels
BOX = [240, 1380, 600, 130]


def scene(caption_dy: int = 0) -> np.ndarray:
    """Textured background with a white-on-black caption bar at BOX (scaled to preview), moved
    down by caption_dy preview pixels."""
    rng = np.random.default_rng(7)
    f = rng.integers(40, 200, size=(H, W, 3), dtype=np.uint8)
    x, y, w, h = (v // 2 for v in BOX)
    y += caption_dy
    f[y:y + h, x:x + w] = 0
    for i in range(x + 8, x + w - 8, 22):               # letter-like strokes
        f[y + 12:y + h - 12, i:i + 10] = 255
    return f


def test_psnr_matches_its_definition():
    a = np.full((4, 4, 3), 100, np.uint8)
    assert compare.psnr(a, a) == math.inf
    # every sample off by 10: MSE 100, so 10*log10(255^2/100)
    assert compare.psnr(a, a + 10) == pytest.approx(10 * math.log10(255 ** 2 / 100))


def test_identical_preview_passes_and_a_shifted_caption_fails_only_the_caption_band():
    band = compare.caption_band([BOX], W, H, scale=W / 1080, pad=0.15)
    same = compare.frame_metrics(scene(), scene(), band)
    assert same["captionPsnr"] == math.inf and same["otherPsnr"] == math.inf
    moved = compare.frame_metrics(scene(), scene(caption_dy=6), band)
    # a 6 px slip at preview size (12 px in the final) wrecks the caption band ...
    assert moved["captionPsnr"] < 15
    # ... while everything outside it is untouched, so only a strict caption check can see it
    assert moved["otherPsnr"] == math.inf


def test_darkened_frame_fails_the_mean_color_bound():
    f = scene()
    assert compare.mean_color_delta(f, f) == 0.0
    dark = (f.astype(np.float64) * 0.9).astype(np.uint8)
    delta = compare.mean_color_delta(f, dark)
    assert delta > 10
    assert compare.verdict(delta, maximum=4.0) == "fail"


def test_unconfigured_threshold_is_unset_not_pass():
    assert compare.verdict(12.0, minimum=None) == "unset"
    assert compare.verdict(12.0, minimum=30.0) == "fail"
    assert compare.verdict(31.0, minimum=30.0) == "pass"


def test_audio_offset_sign_and_size():
    rate = 48000
    rng = np.random.default_rng(3)
    ref = rng.normal(0, 0.2, rate)
    late = np.concatenate([np.zeros(480), ref[:-480]])     # 10 ms late
    early = np.concatenate([ref[240:], np.zeros(240)])     # 5 ms early
    assert compare.audio_offset(ref, ref, rate, 0.5) == 0.0
    assert compare.audio_offset(ref, late, rate, 0.5) == pytest.approx(0.010)
    assert compare.audio_offset(ref, early, rate, 0.5) == pytest.approx(-0.005)


def test_level_delta_reads_half_volume_as_6_db_and_ignores_pauses():
    rate = 48000
    tone = 0.5 * np.sin(2 * np.pi * 220 * np.arange(rate) / rate)
    tone[: rate // 2] = 0.0                                   # a pause in the reference
    cand = tone * 0.5
    # hiss where the reference pauses: a level there means nothing, so it must not count
    cand[: rate // 2] = np.random.default_rng(1).normal(0, 0.05, rate // 2)
    assert compare.level_delta_db(tone, cand, rate, 0.1, -45.0) == pytest.approx(6.02, abs=0.01)


def test_timestamps_match_reports_count_and_first_slip():
    ref = [i / 30 for i in range(30)]
    assert compare.timestamps_match(ref, list(ref), tol=1e-6) is None
    assert "frame count" in compare.timestamps_match(ref, ref[:-1], tol=1e-6)
    slipped = list(ref)
    slipped[12] += 1 / 30
    assert compare.timestamps_match(ref, slipped, tol=0.5 / 30).startswith("frame 12")


def test_preview_times_sit_on_the_frame_grid():
    assert replay.grid(30) == 0.1 and replay.grid(24) == 0.125 and replay.grid(25) == 0.04
    p = replay.plan_previews(3.47, 12.0, 30)
    assert p["window"] == [2.4, 4.4] and p["stills"] == [3.4, 3.9]


def test_git_blob_id_matches_git():
    assert git_blob_id(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_reference_copy_is_refused_once_edited(tmp_path):
    repo = tmp_path / "repo"
    pkg = repo / "engine" / "reelengine"
    pkg.mkdir(parents=True)
    (pkg / "render.py").write_text("SCALE = 0.5\n")
    (pkg / "fonts").mkdir()
    (pkg / "fonts" / "a.ttf").write_bytes(b"\x00\x01\r\n")
    git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-qm", "ref"], check=True)
    commit = subprocess.run(git + ["rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

    dest = extract_reference(repo, commit, tmp_path / "ref")
    assert (dest / "reelengine" / "fonts" / "a.ttf").read_bytes() == b"\x00\x01\r\n"
    (dest / "reelengine" / "render.py").write_text("SCALE = 0.25\n")
    with pytest.raises(Refusal, match="changed"):
        verify_reference(repo, commit, dest)
    (dest / "reelengine" / "render.py").write_text("SCALE = 0.5\n")
    verify_reference(repo, commit, dest)
    (dest / "reelengine" / "extra.py").write_text("")
    with pytest.raises(Refusal, match="extra"):
        verify_reference(repo, commit, dest)

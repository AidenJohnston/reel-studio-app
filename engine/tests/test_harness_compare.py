"""The speed harness's checks have one right answer each: these pin them on made-up frames,
sounds, folders and a throwaway git repo. No engine runs; one test makes a tiny video with FFmpeg."""
import json
import math
import os
import shutil
import subprocess

import numpy as np
import pytest

from harness import checks, compare, corpus, replay
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
    # the one-pass numbers are the plain definition's
    assert moved["captionPsnr"] == pytest.approx(compare.psnr(scene(), scene(caption_dy=6), band))
    assert moved["framePsnr"] == pytest.approx(compare.psnr(scene(), scene(caption_dy=6)))


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


def test_level_delta_counts_the_last_partial_slice():
    rate = 48000
    n = rate + rate // 20                                     # 1.05 s: ten full slices and half of one
    tone = 0.5 * np.sin(2 * np.pi * 220 * np.arange(n) / rate)
    cut_short = tone.copy()
    cut_short[rate:] = 0.0                                    # the closing 50 ms went silent
    assert compare.level_delta_db(tone, cut_short, rate, 0.1, -45.0) > 20


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


@pytest.mark.parametrize("fps,window,stills", [(29.97, [73, 133], [103, 118]),
                                             (23.976, [58, 106], [83, 95]),
                                             (59.94, [147, 267], [207, 237])])
def test_fractional_preview_plans_keep_exact_frame_times(fps, window, stills):
    plan = replay.plan_previews(3.47, 12.0, fps)
    assert plan["window"] == [k / fps for k in window]
    assert plan["stills"] == [k / fps for k in stills]
    short = replay.plan_previews(0.0, 0.02, fps)
    assert short["window"][0] >= 0 and short["window"][1] <= 0.02
    assert short["stills"] == [0.0]


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


# --- what the harness trusts on disk -------------------------------------------------------------

HLG = {"width": 2160, "height": 3840, "codec": "hevc", "transfer": "hlg", "seed": 1}


def fake_take(d, hdr: bool, rotation: int = 0, spec=None, state_hdr=None):
    (d / "project" / "work").mkdir(parents=True)
    (d / "states").mkdir()
    src = lambda h: json.dumps({"sources": [{"id": "s1", "hdr": h, "rotation": rotation}]})
    (d / "project" / "project.json").write_text(src(hdr))
    (d / "states" / "00.json").write_text(src(hdr if state_hdr is None else state_hdr))
    (d / "project" / "work" / "transcript.json").write_text("{}")
    (d / "session.json").write_text('{"steps": [{"state": "states/00.json"}]}')
    if spec is not None:
        (d / corpus.SPEC_FILE).write_text(json.dumps({"key": corpus.spec_key(spec)}))
    return d


def test_take_made_by_older_code_or_another_spec_is_rebuilt(tmp_path):
    old = fake_take(tmp_path / "old", hdr=False)                    # a corpus from before spec.json
    assert corpus.needs_build(HLG, old)
    cur = fake_take(tmp_path / "cur", hdr=True, spec=HLG)
    assert not corpus.needs_build(HLG, cur)
    assert corpus.needs_build(dict(HLG, seed=2), cur)


def test_hlg_take_the_engine_reads_as_sdr_is_refused(tmp_path):
    with pytest.raises(RuntimeError, match="hdr=False"):
        corpus.validate(HLG, fake_take(tmp_path / "a", hdr=False, spec=HLG))
    corpus.validate(HLG, fake_take(tmp_path / "b", hdr=True, spec=HLG))
    # the states are what both engines render: a stale one is refused even when the project is right
    with pytest.raises(RuntimeError, match="states/00.json: hdr=False"):
        corpus.validate(HLG, fake_take(tmp_path / "s", hdr=True, spec=HLG, state_hdr=False))
    with pytest.raises(RuntimeError, match="rotation"):
        corpus.validate({"rotation": 90}, fake_take(tmp_path / "c", hdr=False, rotation=0))
    # a state whose first source looks right but whose sources differ (the real one listed second)
    d = fake_take(tmp_path / "d", hdr=True, spec=HLG)
    (d / "states" / "00.json").write_text(json.dumps({"sources": [{"id": "s2", "hdr": True},
                                                                  {"id": "s1", "hdr": False}]}))
    with pytest.raises(RuntimeError, match="sources differ"):
        corpus.validate(HLG, d)


PINS = {"engineCommit": "c0ffee", "ffmpeg": {"sha256": "ff"}}


def fake_reference(d):
    d.mkdir()
    for n in replay.REF_FILES:
        (d / n).write_bytes(n.encode())
    replay.write_reference_manifest(d, d.name, PINS)
    return d


def test_reference_cache_whose_files_changed_is_refused(tmp_path):
    assert replay.reference_ready(tmp_path / "none", "none", PINS) is False
    with pytest.raises(Refusal, match="lost its manifest"):           # at check time it must exist
        replay.reference_ready(tmp_path / "none", "none", PINS, require=True)
    d = fake_reference(tmp_path / "k1")
    assert replay.reference_ready(d, "k1", PINS) is True
    (d / "export.mp4").write_bytes(b"another render")
    with pytest.raises(Refusal, match="export.mp4 changed"):
        replay.reference_ready(d, "k1", PINS)
    e = fake_reference(tmp_path / "k2")
    with pytest.raises(Refusal, match="made by"):
        replay.reference_ready(e, "k2", {"engineCommit": "c0ffee", "ffmpeg": {"sha256": "other"}})
    legacy = tmp_path / "k3"
    legacy.mkdir()
    (legacy / "done.json").write_text("{}")                         # from before manifests: rebuild
    assert replay.reference_ready(legacy, "k3", PINS) is False


def test_checking_refuses_a_reference_that_lost_its_manifest_after_setup(tmp_path):
    from types import SimpleNamespace
    d = fake_reference(tmp_path / "k1")
    (d / replay.REF_MANIFEST).unlink()
    take = SimpleNamespace(session=[{"state": "states/00.json"}])
    refs = [{"dir": d, "key": "k1", "format": {"width": 1080, "height": 1920}, "window": [0.0, 2.0],
             "stills": [1.0], "fps": 30.0}]
    with pytest.raises(Refusal, match="lost its manifest"):
        replay.check_take(take, refs, [], "ffmpeg", "ffprobe", {"preview": {}, "final": {}}, PINS,
                          {"previewScale": 0.5, "stillWidth": 540})


def test_preview_sizes_follow_the_output_format():
    fmt = {"width": 1080, "height": 1920}
    assert replay.preview_size(fmt, 0.5) == (540, 960)
    assert replay.still_size((540, 960), 540) == (540, 960)
    # a landscape draft: FFmpeg's -2 rounds 151.875 * 2 to 304, not down to 302
    assert replay.still_size((960, 540), 540) == (540, 304)


def test_still_of_the_wrong_size_fails_before_any_comparison(tmp_path):
    from PIL import Image
    png = tmp_path / "tiny.png"
    Image.new("RGB", (54, 96), (90, 90, 90)).save(png)
    # the reference path does not exist: reaching it would raise instead of failing on size
    r = checks.check_still("ffmpeg", "ffprobe", tmp_path / "no-ref.mp4", png, 1.0, [], {}, (540, 960))
    assert r["status"] == "fail" and "size 54x96, required 540x960" in r["failures"][0]


FFMPEG = os.environ.get("REELENGINE_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("REELENGINE_FFPROBE") or shutil.which("ffprobe")


@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="needs ffmpeg and ffprobe")
def test_draft_of_the_wrong_size_fails_before_any_comparison(tmp_path):
    tiny = tmp_path / "tiny.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=54x96:d=0.2:r=30",
                    "-pix_fmt", "yuv420p", str(tiny)], check=True)
    r = checks.check_preview_video(FFMPEG, FFPROBE, tmp_path / "no-ref.mp4", tiny, [], {}, 30.0, (540, 960))
    assert r["status"] == "fail" and "size 54x96, required 540x960" in r["failures"][0]


def test_every_still_is_paired_with_a_requested_time():
    assert replay.pair_stills([1.0, 1.5], ["still1", "still0"]) == [(1.0, "still0"), (1.5, "still1")]
    # an extra still, or a requested time with none, comes back half empty (check_take fails it)
    assert replay.pair_stills([1.0], ["still0", "still1"])[1] == (None, "still1")
    assert replay.pair_stills([1.0, 1.5], ["still0"])[1] == (1.5, None)


def test_a_proxy_run_refuses_a_preview_that_read_the_original():
    from harness.engines import Call
    copies = {"sources": {"s1": {"status": "built"}, "s2": {"status": "not-needed"}}}
    read = Call(1.0, {"videoFrom": {"s1": "proxy", "s2": "original"}}, "")
    replay._check_copy_read(read, copies, "draft")
    fell_back = Call(1.0, {"videoFrom": {"s1": "original", "s2": "original"}}, "")
    with pytest.raises(RuntimeError, match="copies exist for \\['s1'\\]"):
        replay._check_copy_read(fell_back, copies, "draft")


def test_a_proxy_run_refuses_a_take_whose_copy_was_not_made(tmp_path):
    from harness.engines import Call

    class Cand:
        def run(self, command, args):
            assert command == "proxy"
            return Call(1.0, {"sources": {"s1": {"status": "failed", "reason": "ffmpeg"}}}, "")
    take = tmp_path / "take"
    (take / "project" / "media").mkdir(parents=True)
    (take / "project" / "project.json").write_text("{}", encoding="utf-8")
    (take / "session.json").write_text('{"steps": []}', encoding="utf-8")
    with pytest.raises(RuntimeError, match="preview copies not made"):
        replay.replay(replay.Take("t", take), Cand(), [], tmp_path / "scratch", None, "ffprobe", proxy=True)

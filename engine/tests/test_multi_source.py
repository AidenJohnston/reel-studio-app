"""Clip projects must preserve source order, timing, captions and downgrade refusal."""
import subprocess
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from conftest import mkwords
from reelengine import analyze, audio_env, broll, captions, cli, cut, init, project, render, tools, transcribe, verify
from reelengine.proto import EngineError


def clip(cid, source, start, end):
    return {"clip": cid, "source": source, "in": start, "out": end}


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    folder = tmp_path_factory.mktemp("clip-signals")
    paths = {}
    for name, offset, audio in [("s1", 0, True), ("s2", 20, True), ("silent", 0, False)]:
        path = folder / f"{name}.mp4"
        # Every half second changes both brightness and tone frequency on the same source clock.
        video = f"nullsrc=s=96x64:r=30:d=6,geq=lum='30+{offset}+16*floor(T*2)':cb=128:cr=128"
        cmd = [tools.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", video]
        if audio:
            tone = f"aevalsrc=0.2*sin(2*PI*(250+{offset * 5}+125*floor(t*2))*t):s=48000:d=6"
            cmd += ["-f", "lavfi", "-i", tone, "-c:a", "aac"]
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        paths[name] = path
    return paths


def make_project(tmp_path, media, keep, words=None, library=False):
    pdir = tmp_path / "project"
    p = project.new_project("Clip reel")
    p["format"] = {"width": 96, "height": 64, "fps": 30}
    p["sources"] = []
    for sid, original in media.items():
        rel = f"Library/Footage/{sid}.mp4" if library else f"media/{sid}.mp4"
        dest = (tmp_path if library else pdir) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.hardlink_to(original)
        p["sources"].append({"id": sid, "path": rel, "duration": 6, "fps": 30,
                             "width": 96, "height": 64})
    p["cut"]["keep"] = keep
    p["captions"]["enabled"] = words is not None
    if words is not None:
        p["transcript"] = {"file": "work/transcript.json"}
        project.write_json(pdir / "work/transcript.json", {"words": words})
    project.save(pdir, p)
    return pdir, p


def decode(path):
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:v:0",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         check=True, capture_output=True, timeout=60).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, 64, 96)
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:a:0",
                          "-f", "f32le", "-ac", "1", "-ar", "48000", "-"],
                         check=True, capture_output=True, timeout=60).stdout
    return frames, np.frombuffer(raw, np.float32)


def assert_signals(path, spans):
    frames, sound = decode(path)
    duration = sum(end - start for _, start, end in spans)
    assert len(frames) == round(duration * 30)
    assert abs(len(sound) / 48000 - duration) <= 1 / 30
    cursor = 0.0
    for sid, start, end in spans:
        offset = 20 if sid == "s2" else 0
        for delta in np.arange(0.1, end - start - 0.06, 0.1):
            src = start + delta
            # Avoid measuring windows across a fixture's half-second transition.
            if min(src % 0.5, 0.5 - src % 0.5) < 0.075:
                continue
            at = cursor + delta
            level = 30 + offset + 16 * int(src * 2)
            grey = (level - 16) * 255 / 219
            assert abs(float(frames[round(at * 30)].mean()) - grey) < 7, (sid, src, at)
            samples = sound[round((at - 0.025) * 48000):round((at + 0.025) * 48000)]
            spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
            hz = np.fft.rfftfreq(len(samples), 1 / 48000)[spectrum.argmax()]
            assert abs(hz - (250 + offset * 5 + 125 * int(src * 2))) < 25, (sid, src, at, hz)
        cursor += end - start


@pytest.mark.needs_libass
def test_three_clips_render_in_sync_without_transcript(tmp_path, media):
    spans = [("s1", 3.2, 4.4), ("s2", 1.3, 2.4), ("s1", 0.4, 1.8)]
    keep = [clip(f"c{i}", *span) for i, span in enumerate(spans, 1)]
    pdir, p = make_project(tmp_path, {s: media[s] for s in ("s1", "s2")}, keep, library=True)
    p["captions"]["enabled"] = True
    project.save(pdir, p)
    assert not (pdir / "work/transcript.json").exists()
    result = render.run(pdir, root=tmp_path, cover=False)
    assert result["duration"] == pytest.approx(3.7)
    assert result["captions"] == 0
    assert result["verify"]["ok"], result["verify"]
    assert_signals(result["file"], spans)


def test_reordering_clips_moves_source_anchored_broll(tmp_path, media):
    keep = [clip("c1", "s1", 0, 1), clip("c2", "s2", 2, 4), clip("c3", "s1", 4, 6)]
    pdir, p = make_project(tmp_path, {s: media[s] for s in ("s1", "s2")}, keep)
    p["broll"] = [{"id": "b1", "anchor": {"source": "s2", "s": 2.5, "e": 3.0},
                   "leadIn": 0, "treatment": "text-pop", "params": {"text": "GOAL"}}]
    project.save(pdir, p)

    def window():
        tl = project.timeline(pdir, p)
        ctx = render.make_ctx(pdir, p, tl, False, tmp_path, pdir / "work/render")
        plans = broll.plan_windows(ctx)
        assert len(plans) == 1
        assert render.unknown_anchor_skips(p, tl) == ([], [])
        return plans[0]["t0"], plans[0]["t1"]

    before = window()
    p["cut"]["keep"] = [keep[1], keep[2], keep[0]]
    after = window()
    # every card holds 2 s (#173), so the window is where the anchor lands plus that hold
    assert before == pytest.approx((1.5, 3.5))
    assert after == pytest.approx((0.5, 2.5))
    # Trimming away the anchor removes the overlay instead of leaving it at its old output time.
    p["cut"]["keep"] = [clip("c2", "s2", 3.5, 4)]
    tl = project.timeline(pdir, p)
    ctx = render.make_ctx(pdir, p, tl, False, tmp_path, pdir / "work/render")
    assert broll.plan_windows(ctx) == []


def test_mixed_cut_captions_only_kept_words(tmp_path, media):
    words = mkwords([(0.4, 0.7, "First"), (2, 2.3, "Removed")])
    words += mkwords([(1.2, 1.5, "Clip"), (3, 3.3, "Outside")], source="s2", start_id=2)
    pdir, p = make_project(tmp_path, {s: media[s] for s in ("s1", "s2")},
                           [{"from": "w0", "to": "w0"}, clip("c1", "s2", 1, 2)], words)
    tl = project.timeline(pdir, p)
    assert [w["id"] for w in tl.words_out] == ["w0", "w2"]
    assert tl.words_out[-1]["s"] == pytest.approx(0.667, abs=0.001)
    _, report, _, _, _ = captions.build_for_timeline(tl, p, 1080, 1920)
    text = " ".join(row["text"] for row in report).upper()
    assert "FIRST" in text and "CLIP" in text
    assert "REMOVED" not in text and "OUTSIDE" not in text


@pytest.mark.parametrize("mixed", [False, True])
def test_silent_sources_render_silence(tmp_path, media, mixed):
    paths = {"s1": media["silent"]}
    keep = [clip("c1", "s1", 1, 2)]
    if mixed:
        paths["s2"] = media["s2"]
        keep += [clip("c2", "s2", 2, 3), clip("c3", "s1", 3, 4)]
    pdir, _ = make_project(tmp_path, paths, keep)
    result = render.run(pdir, root=tmp_path, cover=False)
    assert result["verify"]["ok"], result["verify"]
    assert not result["warnings"], result["warnings"]
    # A later standalone verify must retain the render's explicit silence expectation.
    assert verify.run(Path(result["file"]))["ok"]
    if not mixed:
        # A file without the explicit expectation must still fail the normal loudness check.
        assert "loudness" in verify.check(Path(result["file"]), expect_w=96, expect_h=64)["fails"]
    frames, sound = decode(result["file"])
    assert len(frames) == (90 if mixed else 30)
    assert np.max(np.abs(sound[4800:43200])) < 0.0001
    if mixed:
        assert np.max(np.abs(sound[52800:91200])) > 0.01
        assert np.max(np.abs(sound[100800:139200])) < 0.0001


@pytest.mark.parametrize("sample_rate", [48000, 44100])
@pytest.mark.parametrize("container", ["mov", "mkv"])
@pytest.mark.parametrize("start,end,audio_at,video_duration", [
    (0, 3, 0, 3),        # audio ends two seconds before the picture
    (0.5, 3, 1, 3),      # trim starts before a late audio stream
    (2, 3, 0, 3),        # trim is entirely beyond the audio stream
    (1, 2, 0, 3),        # trim starts exactly at audio EOF
    (0.5, 1.5, 0, 3),    # first concat segment overlaps audio EOF
    (7.5, 10, 8, 10),    # late audio after a nonzero input seek
])
def test_short_or_delayed_audio_preserves_clip_clock(tmp_path, media, start, end, audio_at, video_duration, sample_rate, container):
    # Matroska commonly omits stream duration; MOV provides it. Both must handle an empty trim.
    source = tmp_path / f"short-audio.{container}"
    subprocess.run([tools.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=gray:s=96x64:r=30:d={video_duration}",
                    "-itsoffset", str(audio_at), "-f", "lavfi", "-i", f"sine=f=440:r={sample_rate}:d=1",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", str(source)],
                   check=True, capture_output=True, timeout=60)
    keep = [clip("c1", "s1", start, end), clip("c2", "s2", 0, 1)]
    pdir, p = make_project(tmp_path, {"s1": source, "s2": media["s2"]}, keep)
    p["sources"][0]["duration"] = video_duration
    project.save(pdir, p)
    result = render.run(pdir, root=tmp_path, cover=False)
    frames, sound = decode(result["file"])
    first_duration = end - start
    assert len(frames) == round((first_duration + 1) * 30)
    assert len(sound) / 48000 == pytest.approx(first_duration + 1, abs=1 / 30)

    def peak(a, b):
        return np.max(np.abs(sound[round(a * 48000):round(b * 48000)]))

    for at in np.arange(0.1, first_duration - 0.05, 0.1):
        source_time = start + at
        if audio_at + 0.05 < source_time < audio_at + 0.95:
            assert peak(at - 0.02, at + 0.02) > 0.01, source_time
        elif source_time < audio_at - 0.05 or source_time > audio_at + 1.05:
            assert peak(at - 0.02, at + 0.02) < 0.0001, source_time
    # The following clip's distinct tone must begin on its planned output clock.
    assert peak(first_duration + 0.1, first_duration + 0.4) > 0.01
    samples = sound[round((first_duration + 0.1) * 48000):round((first_duration + 0.4) * 48000)]
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    hz = np.fft.rfftfreq(len(samples), 1 / 48000)[spectrum.argmax()]
    assert hz == pytest.approx(350, abs=10)
    assert result["verify"]["ok"], result["verify"]


@pytest.mark.parametrize("all_silent", [False, True])
def test_transcribe_skips_silent_sources_and_keeps_voiced_source_words(tmp_path, media, monkeypatch, all_silent):
    paths = {"s1": media["silent"], "s2": media["silent"] if all_silent else media["s2"]}
    pdir, _ = make_project(tmp_path, paths,
                           [clip("c1", "s1", 0, 1), clip("c2", "s2", 0, 1)])

    def recognize(model, wav, language, prompt, dur, p0, p1, hotwords=None):
        # Only the recognizer is stubbed. Probing, extraction and word refinement are real.
        samples = audio_env.read_wav(wav)
        if not np.any(samples):
            return [], [], "en"
        return ([{"s": 0.1, "e": 0.4, "w": "Goal", "p": 0.99}],
                [{"s": 0.1, "e": 0.4, "text": "Goal", "n": 1}], "en")

    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (object(), "cpu", "int8"))
    monkeypatch.setattr(transcribe, "_transcribe_one", recognize)
    monkeypatch.setenv("REELENGINE_HINTS", "0")
    monkeypatch.setenv("REELENGINE_VOCAB", "0")
    if all_silent:
        with pytest.raises(EngineError) as exc:
            transcribe.run(pdir)
        assert exc.value.code == "NO_SPEECH"
        assert not project.transcript_path(pdir).exists()
        return
    result = transcribe.run(pdir)
    transcript = project.load_transcript(pdir, project.load(pdir))
    assert result["words"] == 1
    assert [(w["w"], w["source"]) for w in transcript["words"]] == [("Goal", "s2")]
    assert [s["source"] for s in transcript["segments"]] == ["s2"]
    assert result["timings"]["audioSeconds"] == 6
    # analyze, run on the same project (the engine CLI's `analyze` and `autocut`), skips the silent take
    # too instead of failing to extract its audio
    analyze.run(pdir)
    assert set(project.read_json(pdir / "work" / "envelope.json")) == {"s2"}


def test_init_accepts_silent_video(tmp_path, media):
    result = init.run(tmp_path / "new", "Silent clip", [media["silent"]])
    assert len(result["sources"]) == 1
    assert project.load(tmp_path / "new")["sources"][0]["duration"] == pytest.approx(6)


def test_main_schema_refuses_clip_project_with_bad_project(tmp_path, monkeypatch):
    # Snapshot from origin/main at 31382f9, before clip items existed. No git/network dependency.
    old_schema = Path(__file__).parent / "fixtures/project-schema-31382f9.json"
    p = project.new_project("Downgrade")
    p["cut"]["keep"] = [clip("c1", "s1", 0, 1)]
    project.write_json(tmp_path / "project.json", p)
    monkeypatch.setattr(project, "_VALIDATOR", jsonschema.Draft202012Validator(project.read_json(old_schema)))
    with pytest.raises(EngineError) as exc:
        project.load(tmp_path)
    assert exc.value.code == "BAD_PROJECT"


def test_old_word_range_project_renders_unchanged(tmp_path, media):
    words = mkwords([(0.4, 0.7, "One"), (0.8, 1.2, "two"), (3.2, 3.5, "three")])
    pdir, p = make_project(tmp_path, {"s1": media["s1"]}, [{"from": "w0", "to": "w2"}], words)
    p["captions"]["enabled"] = False
    project.save(pdir, p)
    result = render.run(pdir, root=tmp_path, cover=False)
    # Existing gap/lead/tail behavior on main, measured on the source frame grid.
    assert result["duration"] == pytest.approx(1.8)
    assert_signals(result["file"], [("s1", 0.3, 1.266667), ("s1", 3.033333, 3.866667)])


def test_batch_intake_orders_capture_times_and_transcribes_only_audio(tmp_path, media, monkeypatch):
    files = [tmp_path / name for name in ("late.mov", "silent.mov", "early.mov")]
    for file, original, captured in zip(files, (media["s1"], media["silent"], media["s2"]),
                                        ("2026-10-22T12:00:03Z", "2026-10-22T12:00:02Z", "2026-10-22T12:00:01Z")):
        subprocess.run([tools.ffmpeg(), "-y", "-v", "error", "-i", str(original), "-c", "copy",
                        "-metadata", f"creation_time={captured}", str(file)], check=True, capture_output=True)
    pdir = tmp_path / "batch"
    init.run(pdir, "Three clips", files)
    p = project.load(pdir)
    assert [s["originalName"] for s in p["sources"]] == ["early.mov", "silent.mov", "late.mov"]
    assert [s["hasAudio"] for s in p["sources"]] == [True, False, True]
    assert [s["id"] for s in p["sources"]] == ["s1", "s2", "s3"]

    def recognize(model, wav, language, prompt, dur, p0, p1, hotwords=None):
        return ([{"s": 0.1, "e": 0.4, "w": "Goal", "p": 0.99}],
                [{"s": 0.1, "e": 0.4, "text": "Goal", "n": 1}], "en")

    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (object(), "cpu", "int8"))
    monkeypatch.setattr(transcribe, "_transcribe_one", recognize)
    monkeypatch.setenv("REELENGINE_HINTS", "0")
    monkeypatch.setenv("REELENGINE_VOCAB", "0")
    transcribe.run(pdir)
    assert [w["source"] for w in project.load_transcript(pdir, project.load(pdir))["words"]] == ["s1", "s3"]
    assert not transcribe.audio_path(pdir, "s2").exists()

    # A missing capture date preserves the complete drop order instead of inventing a timestamp.
    unsorted = tmp_path / "drop-order"
    init.run(unsorted, "Drop order", [files[0], media["silent"], files[2]])
    assert [s["originalName"] for s in project.load(unsorted)["sources"]] == ["late.mov", "silent.mp4", "early.mov"]

    # fails if a reel cut from parts of several files (app archive-reels.ts) gets its files renumbered by date
    given = tmp_path / "given-order"
    parsed = cli.build_parser().parse_args(["init", "--project", str(given), "--title", "Given", "--keep-order", *map(str, files)])
    parsed.fn(parsed)
    assert [s["originalName"] for s in project.load(given)["sources"]] == ["late.mov", "silent.mov", "early.mov"]

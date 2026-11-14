"""Mirrored-take detection (mirror_detect.py) and the automatic flip at `init`.

Frames are synthetic: a wall with posters drawn in the bundled fonts, flipped to make a "mirrored" take.
Camera metadata comes from a hand-built QuickTime file laid out like an iPhone's. The OS text recognition
(Windows.Media.Ocr / macOS Vision) runs only where it exists; elsewhere (CI on Ubuntu) a fake reader
stands in and the real-OCR test skips."""
import json
import struct
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from reelengine import compose_util, init as initmod, mirror_detect as md, project as projmod

WORDS = {"stay", "curious", "the", "quick", "brown", "fox", "clean", "taste", "fresh", "coffee", "wow", "mom",
         "bid", "toot", "open", "late", "every", "day", "happy"}
FONTS = Path(md.__file__).resolve().parent / "fonts"


def _clip(path: Path, img: np.ndarray, seconds: float = 3.0) -> Path:
    """A still picture as a short talking-head-like clip, with a sound track (init refuses silent video)."""
    png = path.with_suffix(".png")
    png.write_bytes(cv2.imencode(".png", img)[1].tobytes())
    subprocess.run([compose_util.ffmpeg_bin(), "-v", "error", "-y", "-loop", "1", "-i", str(png),
                    "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}", "-t", str(seconds),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-shortest", str(path)],
                   check=True, stdin=subprocess.DEVNULL)
    return path


def _draw(img: np.ndarray, lines: list) -> np.ndarray:
    """Text drawn in a bundled font: [(x, y, size, text, font file)] -> a copy of img."""
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    d = ImageDraw.Draw(pil)
    for x, y, size, text, font in lines:
        d.text((x, y), text, font=ImageFont.truetype(str(FONTS / font), size), fill=(25, 25, 25))
    return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)


def _room(lines: list) -> np.ndarray:
    """A wall with a "person" in the middle and writing on it, the right way round."""
    img = np.full((1920, 1080, 3), 228, np.uint8)
    cv2.rectangle(img, (400, 860), (680, 1920), (90, 80, 70), -1)
    cv2.circle(img, (540, 760), 150, (120, 140, 170), -1)
    return _draw(img, lines)


POSTERS = [(60, 140, 120, "STAY CURIOUS", "Inter_700Bold.ttf"),
           (60, 330, 84, "FRESH COFFEE", "Montserrat-SemiBold.ttf"),
           (620, 1100, 46, "Open late", "Fraunces_600SemiBold.ttf"),
           (620, 1160, 46, "every day", "Fraunces_600SemiBold.ttf")]
CAPTION = [(170, 1560, 96, "THE QUICK BROWN FOX", "Inter_700Bold.ttf")]   # big subtitles a phone app burned in


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp("mirror clips")
    wall = _room(POSTERS)
    mirrored = cv2.flip(wall, 1)
    return {
        "right": _clip(d / "right.mp4", wall),
        "mirrored": _clip(d / "mirrored.mp4", mirrored),
        # a mirrored take with app captions on top (they read right): the room still reads backwards
        "mirrored+captions": _clip(d / "mirrored-captions.mp4", _draw(mirrored, CAPTION)),
        # a mirrored take of a bare wall, with app captions: only the captions read, and they read right
        "captions-only": _clip(d / "captions-only.mp4", _draw(cv2.flip(_room([]), 1), CAPTION)),
        # only words a mirror leaves as they are
        "symmetric": _clip(d / "symmetric.mp4", _room([(80, 200, 160, "WOW  MOM  TOOT", "Inter_700Bold.ttf")])),
        "blank": _clip(d / "blank.mp4", np.full((1920, 1080, 3), 200, np.uint8)),
    }


# --- scoring and the decision ------------------------------------------------------------------------

def test_scores_letters_of_everyday_words_only():
    assert md.score_lines(["BE CURIOUS"], WORDS) == 7               # 2-letter words never count
    assert md.score_lines(["FRESH COFFEE TO GO", "the quick"], WORDS) == 5 + 6 + 3 + 5
    # backwards writing comes out as junk, mixed case or digits: none of it counts
    assert md.score_lines(["V1002 yqqAH' 38", "sobN", "mooe", "ВЕ НЬЛ ООИ", ""], WORDS) == 0
    assert md.score_lines(["Happy", "hAPPY"], WORDS) == 5
    assert md.score_lines([None], WORDS) == 0


def test_words_a_mirror_leaves_readable_say_nothing():
    for w in ("WOW", "MOM", "TOOT", "bid", "wow"):
        assert md.reads_same_mirrored(w), w
    for w in ("HAPPY", "MOW", "bad", "Wow", "COFFEE"):
        assert not md.reads_same_mirrored(w), w
    assert md.score_lines(["WOW MOM TOOT", "bid"], WORDS) == 0
    assert md.score_lines(["WOW HAPPY"], WORDS) == 5


@pytest.mark.parametrize("as_filmed,flipped,camera,verdict", [
    (0, 0, None, "unsure"),              # no writing in view
    (0, 5, None, "unsure"),              # one short word: could be a misread
    (0, 6, None, "maybe-mirrored"),      # a little writing reads only flipped: ask
    (0, 11, None, "maybe-mirrored"),
    (0, 13, None, "mirrored"),
    (4, 62, None, "mirrored"),
    (12, 33, None, "maybe-mirrored"),    # clearly better flipped, but not by the full margin
    (12, 34, None, "mirrored"),
    (7, 14, None, "unsure"),             # a bit better flipped, not clearly
    (105, 8, None, "as-filmed"),
    (40, 40, None, "unsure"),            # captions added in a phone app read right even on a mirrored picture
    (30, 55, None, "unsure"),
    (0, 60, "front", "mirrored"),        # a front camera can be mirrored ("Mirror Front Camera" on)
    (0, 60, "back", "as-filmed"),        # never the back camera: that writing is a reflection (a mirror selfie)
    (0, 8, "back", "as-filmed"),
    (0, 0, "front", "unsure"),           # the camera alone never decides
])
def test_decide_needs_a_clear_win(as_filmed, flipped, camera, verdict):
    assert md.decide(as_filmed, flipped, camera) == verdict


# --- the camera, from iPhone track metadata -------------------------------------------------------------

def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def _iphone_mov(path: Path, lens: str, big_mdat: bool = False) -> Path:
    """A QuickTime file laid out like an iPhone camera's: the lens is named in the video track's meta box
    (hdlr mdta + keys + ilst), after the media data, as the Camera app writes it."""
    key = b"mdta" + b"com.apple.quicktime.camera.lens_model"
    keys = _box(b"keys", b"\0\0\0\0" + struct.pack(">I", 1) + struct.pack(">I", 8 + len(key))[:4] + key)
    value = _box(b"data", struct.pack(">II", 1, 0) + lens.encode())
    ilst = _box(b"ilst", struct.pack(">I", 8 + len(value)) + struct.pack(">I", 1) + value)
    meta = _box(b"meta", _box(b"hdlr", b"\0" * 8 + b"mdta" + b"\0" * 12) + keys + ilst)
    trak = _box(b"trak", _box(b"tkhd", b"\0" * 84) + _box(b"mdia", b"\0" * 16) + meta)
    # a decoy: the same words inside the media data must not count, only the track's own meta box
    mdat_payload = b"\0" * 64 + b"iPhone 14 back camera 5.7mm f/1.5"
    if big_mdat:
        mdat = struct.pack(">I4sQ", 1, b"mdat", 16 + len(mdat_payload)) + mdat_payload   # 64-bit size
    else:
        mdat = _box(b"mdat", mdat_payload)
    path.write_bytes(_box(b"ftyp", b"qt  \0\0\0\0qt  ") + _box(b"wide", b"") + mdat
                     + _box(b"moov", _box(b"mvhd", b"\0" * 100) + trak))
    return path


def test_camera_facing_reads_the_iphone_lens_tag(tmp_path):
    assert md.camera_facing(_iphone_mov(tmp_path / "a.mov", "iPhone 14 front camera 2.69mm f/1.9")) == "front"
    assert md.camera_facing(_iphone_mov(tmp_path / "b.mov", "iPhone 14 back camera 5.7mm f/1.5")) == "back"
    assert md.camera_facing(_iphone_mov(tmp_path / "c.mov", "iPhone 16 Plus back dual wide camera 2.22mm f/1.6",
                                        big_mdat=True)) == "back"
    assert md.camera_facing(_iphone_mov(tmp_path / "d.mov", "iPhone 15 Pro Max front TrueDepth camera")) == "front"


def test_camera_facing_is_none_without_a_tag(tmp_path, clips):
    assert md.camera_facing(clips["right"]) is None              # what Instagram Edits and CapCut save
    assert md.camera_facing(_iphone_mov(tmp_path / "e.mov", "Some Camera 4mm")) is None
    junk = tmp_path / "junk.mov"
    junk.write_bytes(b"\0\0\0\x10moov" + b"\xff" * 4)             # a box that runs past the end
    assert md.camera_facing(junk) is None
    assert md.camera_facing(tmp_path / "missing.mov") is None


# --- the dictionary -------------------------------------------------------------------------------

def _letters_words(n: int) -> list:
    alpha = "abcdefghijklmnopqrstuvwxyz"
    return [alpha[i % 26] + alpha[(i // 26) % 26] + alpha[(i // 676) % 26] for i in range(n)]


def test_words_come_from_the_speech_model_vocabulary(tmp_path, monkeypatch):
    monkeypatch.delenv("REELENGINE_MODEL", raising=False)
    models = tmp_path / "models"
    m = models / "small.en"
    m.mkdir(parents=True)
    vocab = {"Ġ" + w: i for i, w in enumerate(_letters_words(1500) + ["happy", "Soon"])}
    vocab.update({"happy": 9001, "Ġx1": 9002, "Ġcafé": 9003})     # no space mark / digit / non-ASCII
    (m / "tokenizer.json").write_text(json.dumps({"model": {"vocab": vocab}}), encoding="utf-8")
    words = md.load_words(models)
    assert {"happy", "soon"} <= words and "x1" not in words and "café" not in words


def test_words_from_a_vocabulary_txt_and_none_without_a_model(tmp_path):
    m = tmp_path / "models" / "other"
    m.mkdir(parents=True)
    (m / "vocabulary.txt").write_text("\n".join("Ġ" + w for w in _letters_words(1200)), encoding="utf-8")
    assert len(md.load_words(tmp_path / "models")) == 1200
    (tmp_path / "empty").mkdir()
    assert md.load_words(tmp_path / "empty") is None


# --- the check, with a stand-in reader --------------------------------------------------------------

def _fake_reader(flipped_text: list, seen=None):
    """Reads `flipped_text` only in the flipped frames (a mirrored take), junk as filmed."""
    def read(paths):
        if seen is not None:
            seen.extend(paths)
        return [flipped_text if p.endswith("-flip.jpg") else ["V1002 yqqAH' 38"] for p in paths]
    return read


def test_detect_reads_each_frame_as_filmed_and_flipped(tmp_path, clips):
    seen = []

    def read(paths):
        # every frame comes with its exact left-right mirror image
        for a, b in zip(paths[::2], paths[1::2]):
            assert b == a[:-4] + "-flip.jpg"
            fa, fb = cv2.imread(a, cv2.IMREAD_GRAYSCALE), cv2.imread(b, cv2.IMREAD_GRAYSCALE)
            assert fa.shape == (1920, 1080)
            assert np.abs(cv2.flip(fa, 1).astype(int) - fb.astype(int)).mean() < 3
        return _fake_reader(["THE QUICK BROWN FOX", "CLEAN TASTE"], seen)(paths)

    r = md.detect(clips["mirrored"], tmp_path, words=WORDS, reader=read, reader_name="fake")
    assert r["verdict"] == "mirrored" and r["frames"] == len(md.SAMPLE_AT) == 4
    assert r["why"] == "the writing behind you reads backwards" and r["camera"] is None
    assert r["letters"] == {"asFilmed": 0, "flipped": 4 * (3 + 5 + 5 + 3 + 5 + 5)}
    assert len(seen) == 8 and not (tmp_path / "mirror-check").exists()     # frames are cleaned up


def test_detect_asks_when_only_a_little_writing_reads_flipped(tmp_path, clips):
    # "OPEN" in one of the four frames: 4 letters, under the bar; in two: 8, worth asking about
    def read(paths):
        return [["OPEN"] if p.endswith(("f0-flip.jpg", "f1-flip.jpg")) else [] for p in paths]
    r = md.detect(clips["mirrored"], tmp_path, words=WORDS, reader=read, reader_name="fake")
    assert r["verdict"] == "maybe-mirrored" and r["why"] == "some writing behind you seems to read backwards"


def test_detect_never_flips_a_back_camera_take(tmp_path, clips, monkeypatch):
    monkeypatch.setattr(md, "camera_facing", lambda video: "back")
    r = md.detect(clips["mirrored"], tmp_path, words=WORDS, reader=_fake_reader(["THE QUICK BROWN FOX"]))
    assert r["verdict"] == "as-filmed" and r["camera"] == "back" and r["letters"]["flipped"] > 40


def test_detect_never_raises(tmp_path, clips, monkeypatch):
    def broken(paths):
        raise RuntimeError("text recognition crashed")
    r = md.detect(clips["right"], tmp_path, words=WORDS, reader=broken, reader_name="fake")
    assert r["verdict"] == "unknown" and "crashed" in r["detail"] and r["why"] == ""
    bad = tmp_path / "not a video.mp4"
    bad.write_bytes(b"nope")
    assert md.detect(bad, tmp_path, words=WORDS, reader=_fake_reader([]))["verdict"] == "unknown"
    monkeypatch.setenv("REELENGINE_MIRROR_DETECT", "0")
    assert md.detect(clips["right"], tmp_path, words=WORDS, reader=_fake_reader([]))["verdict"] == "unknown"


def test_detect_without_a_model_or_text_recognition_is_unknown(tmp_path, clips, monkeypatch):
    monkeypatch.setattr(md, "load_words", lambda models=None: None)
    assert md.detect(clips["right"], tmp_path, reader=_fake_reader([]))["verdict"] == "unknown"
    monkeypatch.setattr(md, "os_reader", lambda: (None, None))
    r = md.detect(clips["right"], tmp_path, words=WORDS)
    assert r["verdict"] == "unknown" and "text recognition" in r["detail"]


def test_windows_reader_splits_the_pictures_and_keeps_their_order(monkeypatch):
    calls = []

    def fake_run(cmd, timeout):
        paths = [str(c) for c in cmd[cmd.index("-File") + 2:]]
        calls.append(paths)
        # control characters in recognised text must not lose the line
        return "\n".join(json.dumps({"i": i, "lines": [p + "\x07"]}) for i, p in enumerate(paths)) + "\nnoise"

    monkeypatch.setattr(md, "_run", fake_run)
    monkeypatch.setattr(md.os, "cpu_count", lambda: 16)
    paths = [f"p{i}.jpg" for i in range(8)]
    assert md._windows_reader(paths) == [[p + "\x07"] for p in paths]
    assert len(calls) == 4 and sorted(sum(calls, [])) == sorted(paths)


def test_parse_keeps_a_failed_picture_apart_from_an_empty_one():
    with pytest.raises(RuntimeError):
        md._parse('{"error":"no-ocr-language"}', 2)
    out = '{"i": 0, "error": "vision failed"}\n{"i": 1, "lines": ["A"]}\n{"i": 2, "lines": []}'
    assert md._parse(out, 4) == [None, ["A"], [], None]       # failed, read, read with no writing, missing


def test_a_failed_reading_is_never_evidence(tmp_path, clips):
    # each frame reads 11 letters as filmed and 22 flipped: 44 vs 88 is "unsure". If the as-filmed reading
    # of two frames failed and counted as empty, 22 vs 88 would flip the take; those frames are dropped.
    def read(paths):
        return [None if p.endswith(("f0.jpg", "f1.jpg"))
                else ["STAY CURIOUS", "FRESH COFFEE"] if p.endswith("-flip.jpg") else ["STAY CURIOUS"]
                for p in paths]
    r = md.detect(clips["mirrored"], tmp_path, words=WORDS, reader=read, reader_name="fake")
    assert (r["verdict"], r["frames"], r["letters"]) == ("unsure", 2, {"asFilmed": 22, "flipped": 44})
    r = md.detect(clips["mirrored"], tmp_path, words=WORDS, reader=lambda paths: [None] * len(paths))
    assert r["verdict"] == "unknown" and "failed on every frame" in r["detail"]


def test_a_setup_failure_never_stops_the_import(tmp_path, clips, monkeypatch):
    def boom(*a, **k):
        raise AttributeError("damaged model")
    monkeypatch.setattr(md, "load_words", boom)
    r = md.detect(clips["right"], tmp_path, reader=_fake_reader([]))
    assert r["verdict"] == "unknown" and "damaged model" in r["detail"]
    monkeypatch.setattr(md, "camera_facing", boom)
    assert md.detect(clips["right"], tmp_path, words=WORDS, reader=_fake_reader([]))["verdict"] == "unknown"
    # and init still makes the project
    pdir = tmp_path / "proj"
    initmod.run(pdir, "Setup failure", [clips["right"]])
    assert projmod.load(pdir)["sources"][0]["mirrorCheck"]["verdict"] == "unknown"


def test_a_damaged_tokenizer_is_no_vocabulary(tmp_path):
    for i, bad in enumerate(([1, 2, 3], {"model": [1]}, {"model": {"vocab": 7}})):
        m = tmp_path / f"models{i}" / "small.en"
        m.mkdir(parents=True)
        (m / "tokenizer.json").write_text(json.dumps(bad), encoding="utf-8")
        assert md.load_words(m.parent) is None


# --- the OS's own text recognition (Windows / macOS only) --------------------------------------------

@pytest.mark.skipif(md.os_reader()[1] is None, reason="no built-in text recognition on this OS")
def test_real_text_recognition_on_synthetic_rooms(tmp_path, clips):
    got = {k: md.detect(v, tmp_path, words=WORDS) for k, v in clips.items()}
    seen = {k: (r["verdict"], r["letters"]) for k, r in got.items()}
    assert got["mirrored"]["verdict"] == "mirrored", seen
    assert got["mirrored+captions"]["verdict"] in ("mirrored", "maybe-mirrored"), seen
    assert got["right"]["verdict"] == "as-filmed", seen
    for k in ("captions-only", "symmetric", "blank"):     # nothing says which way round: no flip, no question
        assert got[k]["verdict"] in ("unsure", "as-filmed"), seen


# --- init flips a take that clearly looked mirrored, and only then --------------------------------------

@pytest.mark.parametrize("verdict", ["mirrored", "maybe-mirrored", "unsure", "as-filmed", "unknown"])
def test_init_flips_only_a_clearly_mirrored_take(tmp_path, clips, monkeypatch, verdict):
    seen = []

    def fake_detect(video, work, duration=None, **kw):
        seen.append((Path(video).name, duration))
        return {"verdict": verdict, "why": md.WHY.get(verdict, ""), "camera": "front",
                "letters": {"asFilmed": 0, "flipped": 40}, "frames": 4, "reader": "fake", "seconds": 0.1,
                "detail": ""}

    monkeypatch.setattr(md, "detect", fake_detect)
    pdir = tmp_path / "proj"
    res = initmod.run(pdir, "Mirror test", [clips["mirrored"]])
    proj = projmod.load(pdir)                      # validates against the schema
    src = proj["sources"][0]
    assert seen == [("take01.mp4", src["duration"])]      # the project's own copy, looked at once
    assert res["sources"][0] == src
    want = {"verdict": verdict, "camera": "front", "letters": {"asFilmed": 0, "flipped": 40}}
    if md.WHY.get(verdict):
        want["why"] = md.WHY[verdict]
    assert src["mirrorCheck"] == want                     # no timings: the same take writes the same record
    if verdict == "mirrored":
        assert src["mirror"] is True
    else:
        assert "mirror" not in src                        # maybe-mirrored asks, the rest change nothing


def test_the_schema_knows_every_verdict():
    schema = json.loads(projmod.SCHEMA_PATH.read_text(encoding="utf-8"))
    check = schema["properties"]["sources"]["items"]["properties"]["mirrorCheck"]
    assert tuple(check["properties"]["verdict"]["enum"]) == md.VERDICTS

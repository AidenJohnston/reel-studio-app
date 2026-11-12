"""The parts of a chunked final that need no FFmpeg: where chunks fall, which caption events key a chunk, what
a file's identity is, and which old chunks the cache keeps."""
import os

from reelengine import chunks

ASS = "\n".join([
    "[Script Info]", "PlayResX: 1080", "PlayResY: 1920", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize", "Style: Cap,Montserrat,76", "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.50,0:00:01.90,Cap,,0,0,0,,SO HERE IS",
    "Dialogue: 0,0:00:02.20,0:00:03.10,Cap,,0,0,0,,THE THING, AGAIN",
    "Dialogue: 0,0:01:01.00,0:01:02.00,Cap,,0,0,0,,LATE",
])


def test_chunks_are_two_keyframe_intervals_and_the_last_one_is_short():
    assert chunks.plan(130, 30) == [(0, 60), (60, 120), (120, 130)]
    assert chunks.chunk_frames(29.97) == 60
    assert chunks.plan(1, 30) == [(0, 1)]


def test_missing_chunks_group_into_consecutive_runs():
    assert chunks.runs([0, 1, 2, 5, 7, 8]) == [[0, 1, 2], [5], [7, 8]]
    assert chunks.runs([]) == []


def test_a_chunk_is_keyed_on_the_caption_events_on_screen_in_it():
    header, events = chunks.caption_events(ASS, 2.0, 4.0)
    assert "Style: Cap,Montserrat,76" in header and "PlayResY: 1920" in header
    assert events == ["Dialogue: 0,0:00:02.20,0:00:03.10,Cap,,0,0,0,,THE THING, AGAIN"]
    # within the margin of the chunk's start: the event a frame away counts
    assert len(chunks.caption_events(ASS, 1.95, 4.0)[1]) == 2
    assert chunks.caption_events(ASS, 4.0, 6.0)[1] == []
    assert chunks.caption_events(ASS, 60.0, 62.0)[1] == ["Dialogue: 0,0:01:01.00,0:01:02.00,Cap,,0,0,0,,LATE"]


def test_a_file_is_known_by_its_content_not_its_time(tmp_path):
    a, b = tmp_path / "a.png", tmp_path / "b.png"
    a.write_bytes(b"one picture")
    b.write_bytes(b"one picture")
    assert chunks.file_identity(a) == chunks.file_identity(b)
    os.utime(b, (1, 1))
    assert chunks.file_identity(a) == chunks.file_identity(b)
    b.write_bytes(b"another one")
    assert chunks.file_identity(a) != chunks.file_identity(b)


def test_a_large_file_is_sampled_through_its_middle(tmp_path, monkeypatch):
    monkeypatch.setattr(chunks, "PART_HASH_LIMIT", 1 << 10)
    monkeypatch.setattr(chunks, "SAMPLE_EDGE", 1 << 10)
    monkeypatch.setattr(chunks, "SAMPLE_BLOCK", 1 << 8)
    data = bytearray(64 << 10)
    a = tmp_path / "a.mp4"
    a.write_bytes(bytes(data))
    first = chunks.file_identity(a)
    data[31 << 10:33 << 10] = bytes([1]) * (2 << 10)    # 2 KiB in the middle, the same size: a sampled block
    a.write_bytes(bytes(data))
    assert chunks.file_identity(a) != first


def test_the_cache_keeps_this_renders_chunks_and_the_newest_others(tmp_path, monkeypatch):
    cache = chunks.Cache(tmp_path / "chunks")
    monkeypatch.setattr(chunks, "KEEP_FACTOR", 2)
    for n, key in enumerate(["old1", "old2", "old3", "now1", "now2"]):
        cache.path(key).write_bytes(b"x")
        os.utime(cache.path(key), ns=(n * 10**9, n * 10**9))
    cache.prune(["now1", "now2"])
    assert sorted(f.stem for f in cache.dir.glob("*.mp4")) == ["now1", "now2", "old2", "old3"]

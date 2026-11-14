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


def test_missing_chunks_group_into_consecutive_runs_of_a_bounded_size():
    assert chunks.runs([0, 1, 2, 5, 7, 8], 8) == [[0, 1, 2], [5], [7, 8]]
    assert chunks.runs(list(range(20)), 8) == [list(range(8)), list(range(8, 16)), list(range(16, 20))]
    assert chunks.runs([], 8) == []


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


def test_a_large_file_changed_anywhere_has_another_identity(tmp_path):
    # Fails if a large take is identified by samples: pixels changed between them, the length and the
    # modification time kept, let old chunks play over the new picture (Astra engine review 2). 70 MiB, over the
    # 64 MiB the sampling started at, with 4 KiB changed at 5.5 MiB, between two of its samples.
    a = tmp_path / "take.mp4"
    data = bytearray(70 << 20)
    a.write_bytes(bytes(data))
    st = a.stat()
    first = chunks.file_identity(a)
    data[(11 << 19):(11 << 19) + 4096] = bytes([7]) * 4096
    a.write_bytes(bytes(data))
    os.utime(a, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert chunks.file_identity(a) != first

def test_the_cache_keeps_this_renders_chunks_and_the_newest_others(tmp_path, monkeypatch):
    cache = chunks.Cache(tmp_path / "chunks")
    monkeypatch.setattr(chunks, "KEEP_FACTOR", 2)
    for n, key in enumerate(["old1", "old2", "old3", "now1", "now2"]):
        cache.path(key).write_bytes(b"x")
        os.utime(cache.path(key), ns=(n * 10**9, n * 10**9))
    cache.prune(["now1", "now2"])
    assert sorted(f.stem for f in cache.dir.glob("*.mp4")) == ["now1", "now2", "old2", "old3"]

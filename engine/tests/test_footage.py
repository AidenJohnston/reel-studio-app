"""Footage commands retain completed work and share speech across copied files."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import wave
from pathlib import Path

import pytest

from reelengine import audio_env, cli, project, transcribe, tools


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    folder = tmp_path_factory.mktemp("footage-clips")
    paths = []
    for n, colors in enumerate((("red", "blue"), ("green", "white"))):
        out = folder / f"clip{n}.mp4"
        tools.text_run([
            tools.ffmpeg(), "-y", "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", f"color={colors[0]}:s=64x64:r=10:d=1",
            "-f", "lavfi", "-i", f"color={colors[1]}:s=64x64:r=10:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(out),
        ], 60, "generate footage fixture")
        paths.append(out)
    return paths


@pytest.fixture
def library(tmp_path, clips, monkeypatch):
    root = tmp_path / "studio"
    lib = root / "Library"
    lib.mkdir(parents=True)
    shutil.copyfile(clips[0], lib / "a.mp4")
    monkeypatch.setenv("REELENGINE_ROOT", str(root))
    monkeypatch.setenv("REELSTUDIO_ROOT", str(root))
    monkeypatch.setenv("REELENGINE_MODEL", "small.en")
    monkeypatch.delenv("REELENGINE_HINTS", raising=False)
    monkeypatch.setenv("REELENGINE_VOCAB", "0")
    calls = []

    def fake_one(model, wav, language, prompt, duration, p0, p1, hotwords=None):
        calls.append(wav)
        return ([{"s": .25, "e": .5, "w": "twenty", "p": .9, "_seg": 0},
                 {"s": .55, "e": .8, "w": "bucks.", "p": .8, "_seg": 0}],
                [{"s": .25, "e": .8, "text": "twenty bucks.", "n": 2}], "en")

    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (object(), "cpu", "int8"))
    monkeypatch.setattr(transcribe, "_transcribe_one", fake_one)
    monkeypatch.setattr(audio_env, "refine_words", lambda words, *a, **k: words)
    return root, calls


def command(root, *args):
    parsed = cli.build_parser().parse_args(["footage", *args, "--root", str(root)])
    return parsed.fn(parsed)


def connect(root):
    return sqlite3.connect(root / ".index" / "index.sqlite")


def test_copies_share_one_transcript(library):
    root, calls = library
    shutil.copyfile(root / "Library/a.mp4", root / "Library/copy.mp4")
    result = command(root, "index")
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM files").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM paths").fetchone()[0] == 2
    assert len(calls) == 1
    assert result == {"files": 2, "stagesRun": 3, "pending": 0, "filesPending": 0,
                      "places": [{"id": "Library", "files": 2, "online": True}]}


def test_interrupted_run_keeps_committed_stages(library, clips):
    root, calls = library
    shutil.copyfile(clips[1], root / "Library/b.mp4")
    child = subprocess.run([sys.executable, "-c", """
import os, sys
from pathlib import Path
from reelengine import audio_env, footage, transcribe
root = Path(sys.argv[1])
transcribe.load_model = lambda name: (object(), 'cpu', 'int8')
def fake_one(*args, **kwargs):
    with (root / 'speech-calls').open('a') as calls:
        calls.write('called\\n')
    return ([{'s': .25, 'e': .5, 'w': 'twenty', 'p': .9, '_seg': 0},
             {'s': .55, 'e': .8, 'w': 'bucks.', 'p': .8, '_seg': 0}],
            [{'s': .25, 'e': .8, 'text': 'twenty bucks.', 'n': 2}], 'en')
transcribe._transcribe_one = fake_one
audio_env.refine_words = lambda words, *a, **k: words
def stop(stage, *args, **kwargs):
    if stage == 'footage-transcript':
        os._exit(73)
footage.progress = stop
footage.index(root)
""", str(root)], capture_output=True, text=True, timeout=60)
    assert child.returncode == 73, child.stderr
    with connect(root) as db:
        assert db.execute("SELECT stage FROM stages ORDER BY stage").fetchall() == [
            ("probe",), ("transcript:small.en",)]
        assert db.execute("SELECT count(*) FROM words").fetchone()[0] == 2
    result = command(root, "index")
    assert result["stagesRun"] == 4
    assert result["pending"] == 0
    assert len(calls) == 1
    assert (root / "speech-calls").read_text().splitlines() == ["called"]
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM stages").fetchone()[0] == 6
        assert db.execute("SELECT count(*) FROM shots").fetchone()[0] == 4


def test_touch_rehashes_without_rerunning_stages(library, monkeypatch):
    root, calls = library
    command(root, "index")
    from reelengine import footage
    hashed = []
    real_hash = footage.file_hash

    def count_hash(path):
        hashed.append(path)
        return real_hash(path)

    monkeypatch.setattr(footage, "file_hash", count_hash)
    assert command(root, "index")["stagesRun"] == 0
    assert not hashed
    clip = root / "Library/a.mp4"
    st = clip.stat()
    os.utime(clip, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    assert command(root, "index")["stagesRun"] == 0
    assert hashed == [clip]
    assert len(calls) == 1


def test_indexed_words_keep_audio_boundaries_and_vocabulary_segments(library, monkeypatch):
    root, _ = library

    def fake_one(*args, **kwargs):
        return ([{"s": .25, "e": .5, "w": "Code", "p": .4, "_seg": 0},
                 {"s": .55, "e": .8, "w": "Rabbit.", "p": .4, "_seg": 0}],
                [{"s": .25, "e": .8, "text": "Code Rabbit.", "n": 2}], "en")

    def refined(words, *args):
        return [{**word, "ws": word["s"] - .01, "we": word["e"] + .01,
                 "gaps": [[.3, .35]]} for word in words]

    monkeypatch.setattr(transcribe, "_transcribe_one", fake_one)
    monkeypatch.setattr(audio_env, "refine_words", refined)
    command(root, "index")
    pdir = root / "Projects/vocab"
    proj = project.new_project("My video")
    proj["sources"] = [{"id": "s1", "path": "Library/a.mp4", "duration": 2.0}]
    project.save(pdir, proj)
    transcribe.run(pdir, model_name="small.en")
    data = project.read_json(pdir / "work/transcript.json")
    assert data["words"][0]["gaps"] == [[.3, .35]]
    assert data["words"][0]["ws"] == .24
    proj = project.load(pdir)
    proj["captions"]["corrections"] = [{"from": "Code Rabbit", "to": "CodeRabbit"}]
    project.save(pdir, proj)
    monkeypatch.setenv("REELENGINE_VOCAB", "1")
    transcribe.run(pdir, model_name="small.en")
    data = project.read_json(pdir / "work/transcript.json")
    assert [word["w"] for word in data["words"]] == ["CodeRabbit."]
    assert data["segments"][0]["from"] == data["segments"][0]["to"]


def test_search_returns_speech_times_snapped_to_shots(library):
    root, _ = library
    command(root, "index")
    result = command(root, "search", "--query", "twenty bucks")
    hit, = result["hits"]
    assert hit["said"] == "twenty bucks."
    assert hit["t0"] == 0 and hit["t1"] == pytest.approx(1, abs=.11)
    assert hit["t0"] <= .25 < .8 <= hit["t1"]
    assert hit["file"] == {"name": "a.mp4", "path": "Library/a.mp4", "place": "Library", "online": True, "duration": 2.0}
    assert hit["hit"].endswith(f"@{hit['t0']:.2f}-{hit['t1']:.2f}")
    assert not result["more"]
    assert command(root, "search", "--query", "absent")["hits"] == []


def test_search_without_fts5_reports_literal_fallback(library, monkeypatch, capsys):
    root, _ = library
    from reelengine import footage
    real_connect = sqlite3.connect

    class NoFTS(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if sql.startswith("CREATE VIRTUAL TABLE"):
                raise sqlite3.OperationalError("no such module: fts5")
            return super().execute(sql, parameters)

    monkeypatch.setattr(footage.sqlite3, "connect",
                        lambda *args, **kwargs: real_connect(*args, factory=NoFTS, **kwargs))
    command(root, "index")
    result = command(root, "search", "--query", "twenty bucks")
    assert result["backend"] == "literal"
    assert result["hits"][0]["said"] == "twenty bucks."
    assert result["hits"][0]["t0"] <= .25 < .8 <= result["hits"][0]["t1"]
    assert "FTS5 is unavailable" in capsys.readouterr().err


def test_budget_and_stage_versions_resume_only_missing_work(library, monkeypatch):
    root, calls = library
    assert command(root, "index", "--budget-seconds", "0") == {
        "files": 1, "stagesRun": 0, "pending": 3, "filesPending": 1,
        "places": [{"id": "Library", "files": 1, "online": True}]}
    assert not calls
    command(root, "index")
    from reelengine import footage
    monkeypatch.setattr(footage, "SHOTS_VERSION", footage.SHOTS_VERSION + 1)
    assert command(root, "index")["stagesRun"] == 1
    assert len(calls) == 1
    assert command(root, "index", "--model", "tiny.en")["stagesRun"] == 1
    assert len(calls) == 2
    with connect(root) as db:
        assert db.execute("SELECT DISTINCT model FROM words ORDER BY model").fetchall() == [
            ("small.en",), ("tiny.en",)]


def test_transcribe_imports_indexed_words_with_stable_ids(library, monkeypatch):
    root, calls = library
    command(root, "index")
    pdir = root / "Projects/test"
    (pdir / "media").mkdir(parents=True)
    shutil.copyfile(root / "Library/a.mp4", pdir / "media/take.mp4")
    proj = project.new_project("My video")
    proj["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 2.0}]
    project.save(pdir, proj)

    def forbidden(*args, **kwargs):
        pytest.fail("indexed transcription must not load whisper or extract audio")

    monkeypatch.setattr(transcribe, "load_model", forbidden)
    monkeypatch.setattr(transcribe, "require_model", forbidden)
    monkeypatch.setattr(transcribe, "extract_audio", forbidden)
    for _ in range(2):
        transcribe.run(pdir, model_name="small.en")
        data = json.loads((pdir / "work/transcript.json").read_text())
        assert [(w["id"], w["source"], w["s"], w["e"], w["w"]) for w in data["words"]] == [
            ("w0", "s1", .25, .5, "twenty"), ("w1", "s1", .55, .8, "bucks.")]
        assert data["segments"][0]["from"] == "w0"
        assert data["segments"][0]["to"] == "w1"
    assert len(calls) == 1


@pytest.mark.parametrize("stop_stage", ["footage-probe", "footage-transcript"])
def test_resume_rehashes_replacement_with_identical_metadata(library, monkeypatch, stop_stage):
    root, _ = library
    from reelengine import footage
    (root / "Library/a.mp4").unlink()
    source = root / "Library/take.wav"
    for path, amplitude in ((source, 1000), (root / "replacement.wav", 2000)):
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(amplitude.to_bytes(2, "little", signed=True) * 16000)
    original = root / "original.wav"
    shutil.copyfile(source, original)

    def speech(model, wav, *args, **kwargs):
        word = "original" if audio_env.read_wav(wav)[0] < .045 else "replacement"
        return ([{"s": .1, "e": .5, "w": word, "p": .9, "_seg": 0}],
                [{"s": .1, "e": .5, "text": word, "n": 1}], "en")

    real_progress = footage.progress

    def stop(stage, *args, **kwargs):
        if stage == stop_stage:
            raise KeyboardInterrupt

    monkeypatch.setattr(transcribe, "_transcribe_one", speech)
    monkeypatch.setattr(footage, "progress", stop)
    with pytest.raises(KeyboardInterrupt):
        command(root, "index")
    st = source.stat()
    source.write_bytes((root / "replacement.wav").read_bytes())
    os.utime(source, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert source.stat().st_size == st.st_size
    monkeypatch.setattr(footage, "progress", real_progress)
    command(root, "index")
    old_words = footage.lookup(root, original, "small.en")
    assert old_words is None or old_words[0][0]["w"] == "original"
    replacement = footage.lookup(root, source, "small.en")
    assert replacement is not None and replacement[0][0]["w"] == "replacement"
    with connect(root) as db:
        assert db.execute("SELECT hash FROM paths WHERE rel='take.wav'").fetchone()[0] == footage.file_hash(source)
    shutil.copyfile(original, root / "Library/restored.wav")
    command(root, "index")
    assert footage.lookup(root, original, "small.en")[0][0]["w"] == "original"


def test_same_metadata_change_during_transcription_does_not_commit(library, monkeypatch):
    root, _ = library
    from reelengine.proto import EngineError
    source = root / "Library/a.mp4"
    speech = transcribe._transcribe_one

    def replace_during_speech(*args, **kwargs):
        result = speech(*args, **kwargs)
        st = source.stat()
        data = source.read_bytes()
        source.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
        os.utime(source, ns=(st.st_atime_ns, st.st_mtime_ns))
        return result

    monkeypatch.setattr(transcribe, "_transcribe_one", replace_during_speech)
    with pytest.raises(EngineError, match="changed during indexing"):
        command(root, "index")
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM words").fetchone()[0] == 0
        assert db.execute("SELECT stage FROM stages").fetchall() == [("probe",)]


@pytest.mark.parametrize("literal", [False, True])
def test_removed_hashes_are_collected_and_large_deletions_compacted(library, clips, literal):
    root, _ = library
    if literal:
        (root / ".index").mkdir()
        with connect(root) as db:
            db.execute("CREATE TABLE text_fts(text TEXT, hash TEXT, s REAL, e REAL, kind TEXT, model TEXT)")
    shutil.copyfile(clips[1], root / "Library/b.mp4")
    shutil.copyfile(root / "Library/a.mp4", root / "Library/copy.mp4")
    command(root, "index")
    with connect(root) as db:
        removed = db.execute("SELECT hash FROM paths WHERE rel='b.mp4'").fetchone()[0]
        kept = db.execute("SELECT hash FROM paths WHERE rel='copy.mp4'").fetchone()[0]
        db.execute("INSERT INTO words VALUES (?, 0, 1, ?, 1, 'small.en')", (removed, "x" * (12 * 1024 * 1024)))
    database = root / ".index/index.sqlite"
    before_size = database.stat().st_size
    (root / "Library/a.mp4").unlink()
    (root / "Library/b.mp4").unlink()
    assert command(root, "index")["stagesRun"] == 0
    with connect(root) as db:
        assert db.execute("SELECT rel FROM paths").fetchall() == [("copy.mp4",)]
        for table in ("files", "stages", "words", "transcripts", "shots", "text_fts"):
            assert db.execute(f"SELECT count(*) FROM {table} WHERE hash=?", (removed,)).fetchone()[0] == 0, table
            assert db.execute(f"SELECT count(*) FROM {table} WHERE hash=?", (kept,)).fetchone()[0] > 0, table
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert database.stat().st_size < before_size / 2
    assert command(root, "search", "--query", "twenty bucks")["hits"][0]["file"]["name"] == "copy.mp4"


def test_killed_audio_staging_is_swept_without_deleting_live_run(library, monkeypatch):
    root, _ = library
    scratch = root / "os-temp"
    scratch.mkdir()
    child = subprocess.run([sys.executable, "-c", """
import os, sys
from pathlib import Path
from reelengine import footage, transcribe
root = Path(sys.argv[1])
transcribe.load_model = lambda name: (object(), 'cpu', 'int8')
def die(model, wav, *args, **kwargs):
    (root / 'extracted-audio').write_text(str(wav))
    os._exit(73)
transcribe._transcribe_one = die
footage.index(root)
""", str(root)], capture_output=True, text=True, timeout=60,
        env={**os.environ, "TMPDIR": str(scratch), "TMP": str(scratch), "TEMP": str(scratch)})
    assert child.returncode == 73, child.stderr
    stale_audio = Path((root / "extracted-audio").read_text())
    assert stale_audio.is_file()
    assert stale_audio.resolve().is_relative_to((root / ".index").resolve())
    unpublished = root / ".index/staging/run-unpublished"
    unpublished.mkdir()
    command(root, "index", "--budget-seconds", "0")
    assert not stale_audio.exists()
    assert not unpublished.exists()
    real_speech = transcribe._transcribe_one

    def check_live(model, wav, *args, **kwargs):
        assert wav.is_file()
        command(root, "index", "--budget-seconds", "0")
        assert wav.is_file()
        return real_speech(model, wav, *args, **kwargs)

    monkeypatch.setattr(transcribe, "_transcribe_one", check_live)
    assert command(root, "index")["pending"] == 0
    assert not list((root / ".index/staging").iterdir())


def test_cache_lookup_keeps_a_snapshot_during_garbage_collection(library, monkeypatch):
    root, _ = library
    from reelengine import footage
    command(root, "index")
    copied_source = root / "project-copy.mp4"
    shutil.copyfile(root / "Library/a.mp4", copied_source)
    with connect(root) as db:
        db.execute("PRAGMA journal_mode=WAL")
    real_connect = sqlite3.connect
    collected = []

    def collect_between_reads(sql):
        if sql.startswith("SELECT s, e, w, p FROM words"):
            (root / "Library/a.mp4").unlink()
            collected.append(command(root, "index"))

    def traced_connect(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        if kwargs.get("uri") and str(args[0]).endswith("?mode=ro"):
            connection.set_trace_callback(collect_between_reads)
        return connection

    monkeypatch.setattr(footage.sqlite3, "connect", traced_connect)
    words, segments, _ = footage.lookup(root, copied_source, "small.en")
    assert len(collected) == 1
    assert [word["w"] for word in words] == ["twenty", "bucks."]
    assert segments[0]["n"] == len(words)
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM files").fetchone()[0] == 0


def test_search_caches_one_midpoint_thumbnail_for_parallel_queries(library, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    root, _ = library
    command(root, "index")
    decodes = []
    real_decode = tools.text_run

    def decode(*args, **kwargs):
        decodes.append(args)
        return real_decode(*args, **kwargs)

    monkeypatch.setattr(tools, "text_run", decode)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: command(root, "search", "--query", "twenty bucks"), range(2)))
    assert len(decodes) == 1
    hit = results[0]["hits"][0]
    thumb = Path(hit["thumbnail"])
    assert hit["file"]["path"] == "Library/a.mp4"
    assert thumb.is_relative_to(root / ".index" / "thumbs")
    assert thumb.name == f"{round((hit['t0'] + hit['t1']) / 2 * 1000)}.jpg"
    assert results[1]["hits"][0]["thumbnail"] == str(thumb)
    assert thumb.read_bytes().startswith(b"\xff\xd8")
    stat = thumb.stat()

    def no_decode(*args, **kwargs):
        pytest.fail("a cached thumbnail must not decode the clip again")

    monkeypatch.setattr(tools, "text_run", no_decode)
    again = command(root, "search", "--query", "twenty bucks")["hits"][0]
    assert again["thumbnail"] == str(thumb)
    assert thumb.stat().st_mtime_ns == stat.st_mtime_ns


def test_search_refuses_a_thumbnail_cache_outside_the_index(library, tmp_path):
    root, _ = library
    command(root, "index")
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / ".index" / "thumbs").symlink_to(outside, target_is_directory=True)
    from reelengine.proto import EngineError
    with pytest.raises(EngineError, match="thumbnail cache folder is a symlink"):
        command(root, "search", "--query", "twenty bucks")
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("stored_hash", ["absolute", "../escape", "A" * 64, "a" * 63, "g" * 64])
def test_search_rejects_malformed_stored_hash_before_thumbnail_writes(library, tmp_path, stored_hash):
    from reelengine.proto import EngineError

    root, _ = library
    command(root, "index")
    outside = tmp_path / "outside"
    outside.mkdir()
    digest = str(outside) if stored_hash == "absolute" else stored_hash
    with connect(root) as db:
        for table in ("paths", "files", "stages", "words", "transcripts", "shots", "text_fts"):
            db.execute(f"UPDATE {table} SET hash=?", (digest,))
    with pytest.raises(EngineError, match="invalid footage hash"):
        command(root, "search", "--query", "twenty bucks")
    assert list(outside.iterdir()) == []
    assert not (root / ".index" / "thumbs").exists()


SOURCE = "src-0123abcd"


def test_footage_folder_is_indexed_in_place_and_found(library, clips, tmp_path):
    root, calls = library
    drive = tmp_path / "Drive ü" / "Shoots"
    (drive / "day 1").mkdir(parents=True)
    (drive / ".hidden").mkdir()
    shutil.copyfile(clips[1], drive / "day 1" / "b.mp4")
    shutil.copyfile(clips[1], drive / ".hidden" / "skip.mp4")
    (drive / "song.mp3").write_bytes(b"not a video")
    result = command(root, "index", "--source", f"{SOURCE}={drive}")
    # fails if a footage folder is copied, read for songs, or walked into hidden folders
    assert result["places"] == [{"id": "Library", "files": 1, "online": True},
                                {"id": SOURCE, "files": 1, "online": True}]
    assert len(calls) == 2
    assert not (root / "Library" / "b.mp4").exists()
    paths = {hit["file"]["path"] for hit in command(root, "search", "--query", "twenty bucks")["hits"]}
    # fails if a hit in an added folder is named as a Library file the editor would then not find
    assert paths == {"Library/a.mp4", f"Footage/{SOURCE}/day 1/b.mp4"}


def test_unplugged_folder_keeps_its_index_and_says_so(library, clips, tmp_path):
    root, calls = library
    (root / "Library" / "a.mp4").unlink()
    drive = tmp_path / "drive"
    drive.mkdir()
    shutil.copyfile(clips[1], drive / "b.mp4")
    command(root, "index", "--source", f"{SOURCE}={drive}")
    drive.rename(tmp_path / "unplugged")
    result = command(root, "index", "--source", f"{SOURCE}={drive}")
    # fails if an unplugged drive's analysis is thrown away, so plugging it back listens to every file again
    assert result["places"][1] == {"id": SOURCE, "files": 1, "online": False}
    hit, = command(root, "search", "--query", "twenty bucks")["hits"]
    assert hit["file"]["online"] is False and hit["thumbnail"] is None
    assert hit["file"]["path"] == f"Footage/{SOURCE}/b.mp4"
    (tmp_path / "unplugged").rename(drive)
    assert command(root, "index", "--source", f"{SOURCE}={drive}")["stagesRun"] == 0
    assert len(calls) == 1


def test_folder_no_longer_named_is_forgotten(library, clips, tmp_path):
    root, _ = library
    drive = tmp_path / "drive"
    drive.mkdir()
    shutil.copyfile(clips[1], drive / "b.mp4")
    command(root, "index", "--source", f"{SOURCE}={drive}")
    result = command(root, "index")
    # fails if a removed folder's clips stay searchable after the person removed it
    assert result["places"] == [{"id": "Library", "files": 1, "online": True}]
    assert [h["file"]["path"] for h in command(root, "search", "--query", "twenty bucks")["hits"]] == ["Library/a.mp4"]
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM places").fetchone()[0] == 1


def test_progress_counts_the_files_left_once_per_copy(library, clips, monkeypatch):
    root, _ = library
    shutil.copyfile(clips[0], root / "Library" / "copy of a.mp4")
    shutil.copyfile(clips[1], root / "Library" / "b.mp4")
    from reelengine import footage
    seen = []
    monkeypatch.setattr(footage, "progress", lambda stage, pct, message, force=False: seen.append((pct, message)))
    command(root, "index")
    # fails if a copy is counted as more work, or the bar ends short of full
    assert {m for _, m in seen} == {"Reading a.mp4 (1 of 2)", "Reading b.mp4 (2 of 2)"}
    assert [p for p, _ in seen] == sorted(p for p, _ in seen) and seen[-1][0] == 100

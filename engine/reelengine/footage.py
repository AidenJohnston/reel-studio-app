"""Content-addressed Library analysis, committed one stage at a time."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
import time
from contextlib import closing, contextmanager
from pathlib import Path

from . import audio_env, probe, project, tools, transcribe
from .proto import EngineError, log, progress

PROBE_VERSION = 1
TRANSCRIPT_VERSION = 1
SHOTS_VERSION = 1
# Avoid rewriting the database for small deletions. These maintenance thresholds have no
# workload benchmark; require both 8 MiB and a quarter of the database to be free pages.
VACUUM_MIN_BYTES = 8 * 1024 * 1024
VACUUM_MIN_FRACTION = .25


def file_hash(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _signature(path: Path) -> tuple:
    st = path.stat()
    return st.st_size, st.st_mtime_ns


def _unchanged(path: Path, signature: tuple, digest: str | None = None) -> None:
    if _signature(path) != signature or (digest is not None and file_hash(path) != digest):
        raise EngineError("FOOTAGE_CHANGED", f"{path.name} changed during indexing",
                          "A Library file changed while I was reading it. Run the index again.")


def _open(root: Path) -> sqlite3.Connection:
    folder = root / ".index"
    folder.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(folder / "index.sqlite")
    db.row_factory = sqlite3.Row
    try:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY, label TEXT, root TEXT, network INT);
            CREATE TABLE IF NOT EXISTS paths(place TEXT, rel TEXT, size INT, mtime_ns INT, hash TEXT,
                PRIMARY KEY(place, rel));
            CREATE INDEX IF NOT EXISTS paths_hash ON paths(hash);
            CREATE TABLE IF NOT EXISTS files(hash TEXT PRIMARY KEY, hash_kind TEXT,
                duration REAL, fps REAL, width INT, height INT, rotation INT, has_audio INT);
            CREATE TABLE IF NOT EXISTS stages(hash TEXT, stage TEXT, version INT, done_at TEXT,
                error TEXT, PRIMARY KEY(hash, stage));
            CREATE TABLE IF NOT EXISTS words(hash TEXT, s REAL, e REAL, w TEXT, p REAL, model TEXT);
            CREATE INDEX IF NOT EXISTS words_file_model ON words(hash, model);
            CREATE TABLE IF NOT EXISTS transcripts(hash TEXT, model TEXT, language TEXT, segments TEXT,
                word_metadata TEXT,
                PRIMARY KEY(hash, model));
            CREATE TABLE IF NOT EXISTS shots(hash TEXT, n INT, s REAL, e REAL,
                faces INT, face_area REAL, lufs REAL, thumb TEXT, PRIMARY KEY(hash, n));
        """)
        try:
            db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5("
                       "text, hash UNINDEXED, s UNINDEXED, e UNINDEXED, kind UNINDEXED, model UNINDEXED)")
        except sqlite3.OperationalError as exc:
            if "no such module: fts5" not in str(exc).lower():
                raise
            db.execute("CREATE TABLE IF NOT EXISTS text_fts("
                       "text TEXT, hash TEXT, s REAL, e REAL, kind TEXT, model TEXT)")
        db.commit()
        if not _has_fts(db):
            log("Footage search: SQLite FTS5 is unavailable; using literal text search.")
        return db
    except BaseException:
        db.close()
        raise


def _has_fts(db: sqlite3.Connection) -> bool:
    row = db.execute("SELECT sql FROM sqlite_master WHERE name='text_fts'").fetchone()
    return "USING fts5" in row[0]


def _done(db, digest, stage, version) -> bool:
    row = db.execute("SELECT version, error FROM stages WHERE hash=? AND stage=?",
                     (digest, stage)).fetchone()
    return row is not None and row[0] == version and row[1] is None


def _settled(db, digest, stage, version) -> bool:
    """Done, or failed on these very bytes at this version: a damaged file is not read again until it changes."""
    row = db.execute("SELECT version FROM stages WHERE hash=? AND stage=?", (digest, stage)).fetchone()
    return row is not None and row[0] == version


def _failed(db, digest, stages) -> bool:
    """A stage failed on these bytes at its current version: the file waits, whole, until it changes."""
    return any(row is not None and row[0] == version and row[1] is not None
               for stage, version in stages
               for row in [db.execute("SELECT version, error FROM stages WHERE hash=? AND stage=?",
                                      (digest, stage)).fetchone()])


def _file_settled(db, digest, stages) -> bool:
    return _failed(db, digest, stages) or all(_settled(db, digest, s, v) for s, v in stages)


def _mark_failed(db, digest, stage, version, code):
    with db:
        db.execute("INSERT OR REPLACE INTO stages VALUES (?, ?, ?, ?, ?)",
                   (digest, stage, version, project.now_iso(), code))


def _mark_done(db, digest, stage, version):
    db.execute("INSERT OR REPLACE INTO stages VALUES (?, ?, ?, ?, NULL)",
               (digest, stage, version, project.now_iso()))


def _collect_unreferenced(db):
    for table in ("text_fts", "words", "transcripts", "shots", "stages", "files"):
        removed = db.execute(f"DELETE FROM {table} WHERE NOT EXISTS "
                             f"(SELECT 1 FROM paths WHERE paths.hash={table}.hash)").rowcount
        if table == "text_fts" and removed and _has_fts(db):
            db.execute("INSERT INTO text_fts(text_fts) VALUES ('optimize')")


def _compact(db):
    free = db.execute("PRAGMA freelist_count").fetchone()[0]
    pages = db.execute("PRAGMA page_count").fetchone()[0]
    page_size = db.execute("PRAGMA page_size").fetchone()[0]
    if free * page_size >= VACUUM_MIN_BYTES and free >= pages * VACUUM_MIN_FRACTION:
        db.execute("VACUUM")


@contextmanager
def _run_staging(db, root):
    staging = root / ".index" / "staging"
    if staging.is_symlink():
        raise EngineError("UNSAFE_PATH", "index staging folder is a symlink",
                          "The index staging folder points elsewhere. Remove the index and try again.")
    staging.mkdir(parents=True, exist_ok=True)
    run, owner = None, None
    try:
        # Serialize publication and sweeping with other index startups. A separate SQLite
        # exclusive lock stays held for the run, and the OS releases it after a kill.
        with db:
            db.execute("BEGIN IMMEDIATE")
            for old in staging.iterdir():
                marker = old / "owner.sqlite"
                if (not re.fullmatch(r"run-[a-z0-9_]+", old.name) or old.is_symlink()
                        or not old.is_dir() or marker.is_symlink()):
                    continue
                if not marker.is_file():
                    # A kill between mkdir and opening the owner leaves an empty directory.
                    if not any(old.iterdir()):
                        old.rmdir()
                    continue
                with closing(sqlite3.connect(marker.resolve().as_uri() + "?mode=rw", uri=True, timeout=0)) as lease:
                    try:
                        lease.execute("BEGIN EXCLUSIVE")
                    except sqlite3.OperationalError as exc:
                        if exc.sqlite_errorcode in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                            continue
                        raise
                shutil.rmtree(old)
            run = Path(tempfile.mkdtemp(prefix="run-", dir=staging))
            owner = sqlite3.connect(run / "owner.sqlite", timeout=0)
            owner.execute("BEGIN EXCLUSIVE")
        yield run
    finally:
        if run is not None:
            with db:
                db.execute("BEGIN IMMEDIATE")
                if owner is not None:
                    owner.close()
                shutil.rmtree(run)


def _windows(words):
    window = []
    for word in words:
        window.append(word)
        if re.search(r"[.!?][\"']?$", word["w"]) or word["e"] - window[0]["s"] >= 10:
            yield window
            window = []
    if window:
        yield window


def _speech(path, duration, model, staging):
    wav = transcribe.extract_audio(path, staging / "audio.wav")
    words, segments, language = transcribe._transcribe_one(model, wav, None, None,
                                                          duration, 0, 100)
    samples = audio_env.read_wav(wav)
    env = audio_env.envelope(samples)
    words.sort(key=lambda word: (word["s"], word["e"]))
    words = audio_env.refine_words(words, env, audio_env.noise_threshold(env),
                                  len(samples) / audio_env.SR)
    counts = {}
    for word in words:
        n = word.get("_seg")
        counts[n] = counts.get(n, 0) + 1
    if None not in counts:
        active = [n for n in range(len(segments)) if counts.get(n)]
        segments = [{**segments[n], "n": counts[n]} for n in active]
        remap = {old: new for new, old in enumerate(active)}
        for word in words:
            word["_seg"] = remap[word["_seg"]]
    return words, segments, language


def _shots(path, duration, has_video):
    cuts = []
    if has_video:
        # 0.3 is an initial scene-score threshold, not measured on user footage. Scale first
        # to keep this pass small; version this stage when detection changes.
        result = tools.text_run([
            tools.ffmpeg(), "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
            "-an", "-vf", "scale=320:-2,select='gt(scene,0.3)',showinfo",
            "-f", "null", "-",
        ], 1800, f"find scenes in {path.name}")
        cuts = [float(t) for t in re.findall(r"pts_time:\s*([0-9.eE+-]+)", result.stderr)]
    edges = [0.0] + sorted({t for t in cuts if 0 < t < duration}) + [duration]
    return [(n, s, e) for n, (s, e) in enumerate(zip(edges, edges[1:])) if e > s]


# An added footage folder's id, made by the app (main/footage-sources.ts) from the folder's path.
SOURCE_ID = re.compile(r"src-[0-9a-f]{8,32}")
# Folders a drive or the system keeps for itself; nothing in them is someone's footage.
SKIP_DIRS = {"$RECYCLE.BIN", "System Volume Information", "node_modules"}


def _places(root: Path, sources) -> list[tuple[str, Path, str]]:
    """(id, folder, label) for the Library and each added footage folder, Library first."""
    out = [("Library", root / "Library", "Library")]
    seen = {"Library"}
    for sid, folder in sources:
        folder = Path(folder)
        if not SOURCE_ID.fullmatch(sid) or sid in seen:
            raise EngineError("BAD_ARGS", f"bad footage source id {sid!r}",
                              "A footage folder in your settings is damaged. Remove it and add it again.")
        if not folder.is_absolute():
            raise EngineError("BAD_ARGS", f"footage source {sid} is not an absolute path",
                              "A footage folder in your settings is damaged. Remove it and add it again.")
        seen.add(sid)
        out.append((sid, folder, folder.name or str(folder)))
    return out


def _media_in(folder: Path, kinds: set) -> tuple[list[Path], list[Path]]:
    """Media files under `folder`, sorted, never through a symlink and never in a hidden or system folder; and the
    folders that could not be read, whose indexed files must not be taken for deleted."""
    found, unread = [], []
    for top, dirs, files in os.walk(folder, onerror=lambda error: unread.append(Path(error.filename or folder))):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for name in files:
            path = Path(top) / name
            if name.startswith(".") or path.suffix.lower() not in kinds or path.is_symlink():
                continue
            found.append(path)
    return sorted(found), unread


def _scan(db, place: str, folder: Path, kinds: set, stages) -> list[tuple]:
    """Record every media file under one place; returns (place, path, digest, signature) per file."""
    found, rels = [], set()
    paths, unread = _media_in(folder, kinds)
    for path in paths:
        if not path.resolve().is_relative_to(folder.resolve()):
            continue
        rel = path.relative_to(folder).as_posix()
        try:
            signature = _signature(path)
            old = db.execute("SELECT size, mtime_ns, hash FROM paths WHERE place=? AND rel=?", (place, rel)).fetchone()
            # Metadata only skips completed files. Pending analysis must establish identity
            # from bytes again, including after a replacement that kept size and mtime.
            complete = old and all(_done(db, old[2], stage, version) for stage, version in stages)
            digest = old[2] if complete and tuple(old[:2]) == signature else file_hash(path)
            _unchanged(path, signature)
        except (OSError, EngineError):
            if place == "Library" or folder.is_dir():
                raise
            raise _Gone(place)
        rels.add(rel)
        db.execute("INSERT OR REPLACE INTO paths VALUES (?, ?, ?, ?, ?)", (place, rel, *signature, digest))
        found.append((place, path, digest, signature))
    if place != "Library" and not folder.is_dir():
        raise _Gone(place)
    for row in db.execute("SELECT rel FROM paths WHERE place=?", (place,)).fetchall():
        # a file under a folder that could not be read this time was not seen, which is not the same as gone
        if row[0] not in rels and not any((folder / row[0]).is_relative_to(d) for d in unread):
            db.execute("DELETE FROM paths WHERE place=? AND rel=?", (place, row[0]))
    return found


class _Gone(Exception):
    """An added footage folder that went away (a drive unplugged) during a run."""
    def __init__(self, place: str):
        super().__init__(place)
        self.place = place


def index(root: Path, *, model_name: str | None = None, budget_seconds: float | None = None,
          sources=()) -> dict:
    """Index the Library and each added footage folder, (id, absolute folder) in `sources`. A folder
    that is not there (a drive unplugged) keeps what was indexed from it and is reported offline; a
    folder no longer named loses its rows, and the analysis no other copy shares is collected."""
    if budget_seconds is not None and (not math.isfinite(budget_seconds) or budget_seconds < 0):
        raise EngineError("BAD_ARGS", "budget-seconds must be finite and nonnegative",
                          "Choose a time budget of zero seconds or more.")
    root = Path(root)
    places = _places(root, sources)
    name = model_name or transcribe.default_model()
    stages = [("probe", PROBE_VERSION), (f"transcript:{name}", TRANSCRIPT_VERSION), ("shots", SHOTS_VERSION)]
    deadline = time.monotonic() + budget_seconds if budget_seconds is not None else math.inf
    model = []  # the listening model, loaded by the first file with speech to read
    online = {}
    with closing(_open(root)) as db, _run_staging(db, root) as staging:
        found = []
        with db:
            named = {pid for pid, _, _ in places}
            for row in db.execute("SELECT id FROM places").fetchall():
                if row[0] not in named:
                    db.execute("DELETE FROM paths WHERE place=?", (row[0],))
                    db.execute("DELETE FROM places WHERE id=?", (row[0],))
            for pid, folder, label in places:
                db.execute("INSERT OR REPLACE INTO places VALUES (?, ?, ?, 0)",
                           (pid, label, "Library" if pid == "Library" else str(folder)))
                if pid != "Library" and not folder.is_dir():
                    online[pid] = False
                    continue
                # A footage folder is someone's videos; only the Library also holds songs.
                kinds = probe.VIDEO_EXT | probe.AUDIO_EXT if pid == "Library" else probe.VIDEO_EXT
                # A drive unplugged mid-scan undoes only its own folder's rows.
                db.execute("SAVEPOINT place")
                try:
                    found += _scan(db, pid, folder, kinds, stages)
                    online[pid] = True
                except _Gone:
                    db.execute("ROLLBACK TO place")
                    online[pid] = False
                finally:
                    db.execute("RELEASE place")
            _collect_unreferenced(db)
        _compact(db)

        # Copies share one analysis, so progress counts distinct files with work left.
        todo, queued = [], set()
        for entry in found:
            if entry[2] not in queued and not _file_settled(db, entry[2], stages):
                todo.append(entry)
                queued.add(entry[2])
        ran = 0
        for k, (place, path, digest, signature) in enumerate(todo):
            if time.monotonic() >= deadline:
                break
            if not online.get(place, True):
                continue
            progress("footage-file", 100 * k / len(todo), f"Reading {path.name} ({k + 1} of {len(todo)})", force=True)
            folder = next(f for pid, f, _ in places if pid == place)
            try:
                ran += _analyse(db, path, digest, signature, stages, name, staging, deadline,
                                model, k, len(todo), lambda: folder.is_dir() and path.is_file())
            except (OSError, EngineError) as exc:
                if place == "Library" or folder.is_dir():
                    raise
                online[place] = False
                log(f"Footage index: {place} went offline during indexing ({type(exc).__name__}).")
                continue
        # a failed file's later stages wait on its bytes, not on another run
        pending = sum(not _settled(db, digest, stage, version) for digest in {e[2] for e in found}
                      if not _failed(db, digest, stages) for stage, version in stages)
        counts = {pid: db.execute("SELECT count(*) FROM paths WHERE place=?", (pid,)).fetchone()[0]
                  for pid, _, _ in places}
        waiting = len({e[2] for e in found if not _file_settled(db, e[2], stages)})
        failed = db.execute("SELECT count(DISTINCT hash) FROM stages WHERE error IS NOT NULL").fetchone()[0]
        return {"files": len(found), "stagesRun": ran, "pending": pending, "filesPending": waiting, "filesFailed": failed,
                "places": [{"id": pid, "files": counts[pid], "online": online.get(pid, True)}
                           for pid, _, _ in places]}


def _analyse(db, path, digest, signature, stages, name, staging, deadline, model, k, total, there) -> int:
    """Run one file's missing stages, each committed on its own; returns how many ran."""
    ran = 0
    for stage, version in stages:
        if _settled(db, digest, stage, version):
            if _done(db, digest, stage, version):
                continue
            break  # an earlier failure on these bytes: the later stages need what it would have made
        if time.monotonic() >= deadline:
            break
        _unchanged(path, signature, digest)
        if stage.startswith("transcript:") and not model and \
                db.execute("SELECT has_audio FROM files WHERE hash=?", (digest,)).fetchone()[0]:
            # outside the per-file failure below: a missing model is no fault of this file
            model.append(transcribe.load_model(name)[0])
        try:
            ran += _stage(db, path, digest, signature, stage, version, name, staging, model)
        except EngineError as exc:
            # A file that can't be read (damaged, half copied) must not stop every run at itself. A change while
            # reading is not the file's fault, and is reported as before.
            # A file or drive that went away mid-read is not damaged: the caller sees its folder offline.
            if exc.code == "FOOTAGE_CHANGED" or not there():
                raise
            _mark_failed(db, digest, stage, version, exc.code)
            log(f"Footage index: {path.name} {stage} failed ({exc.code}); it is read again when it changes.")
            break
        done = sum(_done(db, digest, s, v) for s, v in stages) / len(stages)
        progress("footage-" + stage.split(":")[0], 100 * (k + done) / total,
                 f"Reading {path.name} ({k + 1} of {total})", force=True)
    return ran


def _stage(db, path, digest, signature, stage, version, name, staging, model) -> int:
    """One stage of one file, committed on its own. The caller loads the listening model into `model`."""
    if stage == "probe":
        info = probe.probe(path, quick=True)
        _unchanged(path, signature, digest)
        with db:
            db.execute("INSERT OR REPLACE INTO files VALUES (?, 'sha256', ?, ?, ?, ?, ?, ?)",
                       (digest, info["duration"], info["fps"], info["width"], info["height"],
                        info["rotation"], int(info["hasAudio"])))
            _mark_done(db, digest, stage, version)
        return 1
    info = db.execute("SELECT * FROM files WHERE hash=?", (digest,)).fetchone()
    if stage.startswith("transcript:"):
        words, segments, language = [], [], None
        if info["has_audio"]:
            words, segments, language = _speech(path, info["duration"], model[0], staging)
        _unchanged(path, signature, digest)
        with db:
            db.execute("DELETE FROM words WHERE hash=? AND model=?", (digest, name))
            db.executemany("INSERT INTO words VALUES (?, ?, ?, ?, ?, ?)",
                           [(digest, w["s"], w["e"], w["w"], w.get("p"), name) for w in words])
            # Audio gaps drive cuts; segment tags keep vocabulary joins within a segment.
            metadata = [{k: v for k, v in w.items() if k not in {"s", "e", "w", "p"}} for w in words]
            db.execute("INSERT OR REPLACE INTO transcripts VALUES (?, ?, ?, ?, ?)",
                       (digest, name, language, json.dumps(segments), json.dumps(metadata)))
            db.execute("DELETE FROM text_fts WHERE hash=? AND model=?", (digest, name))
            db.executemany("INSERT INTO text_fts VALUES (?, ?, ?, ?, 'speech', ?)",
                           [(" ".join(w["w"] for w in win), digest, win[0]["s"], win[-1]["e"], name)
                            for win in _windows(words)])
            _mark_done(db, digest, stage, version)
        return 1
    shots = _shots(path, info["duration"], info["width"] > 0)
    _unchanged(path, signature, digest)
    with db:
        db.execute("DELETE FROM shots WHERE hash=?", (digest,))
        db.executemany("INSERT INTO shots(hash, n, s, e) VALUES (?, ?, ?, ?)",
                       [(digest, *shot) for shot in shots])
        _mark_done(db, digest, stage, version)
    return 1


def lookup(root: Path, path: Path, model: str, language: str | None = None):
    """Read only full-hash, current-model words; an absent index costs no writes."""
    database = Path(root).resolve() / ".index" / "index.sqlite"
    if not database.is_file():
        return None
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        digest = file_hash(path)
        # GC can commit between these reads; keep completion, words and metadata in one snapshot.
        db.execute("BEGIN")
        if not _done(db, digest, f"transcript:{model}", TRANSCRIPT_VERSION):
            return None
        row = db.execute("SELECT t.* FROM transcripts t JOIN files f USING(hash) "
                         "WHERE t.hash=? AND t.model=? AND f.hash_kind='sha256'", (digest, model)).fetchone()
        if row is None or (language and language != row["language"]):
            return None
        words = [dict(w) for w in db.execute("SELECT s, e, w, p FROM words WHERE hash=? AND model=? ORDER BY s, e",
                                            (digest, model))]
        for word, metadata in zip(words, json.loads(row["word_metadata"])):
            word.update(metadata)
        return words, json.loads(row["segments"]), row["language"]


def _thumbnail(root: Path, digest: str, source: Path, midpoint: float) -> str:
    # Index rows can be modified independently of the media. Validate before using a hash as a path.
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise EngineError("UNSAFE_PATH", "invalid footage hash",
                          "The footage index contains an invalid file hash. Remove the index and try again.")
    thumbs = root / ".index" / "thumbs"
    out = thumbs / digest[:2] / digest
    if not out.resolve().is_relative_to(thumbs.resolve()):
        raise EngineError("UNSAFE_PATH", "thumbnail cache path is outside the thumbs folder",
                          "The footage thumbnail folder points elsewhere. Remove the index and try again.")
    for folder in (root / ".index", root / ".index" / "thumbs", out.parent, out):
        if folder.is_symlink():
            raise EngineError("UNSAFE_PATH", "thumbnail cache folder is a symlink",
                              "The footage thumbnail folder points elsewhere. Remove the index and try again.")
        folder.mkdir(exist_ok=True)
    target = out / f"{round(midpoint * 1000)}.jpg"
    if target.is_symlink() or (out / "thumbs.sqlite").is_symlink():
        raise EngineError("UNSAFE_PATH", "thumbnail cache file is a symlink",
                          "A footage thumbnail points elsewhere. Remove the index and try again.")
    if target.is_file():
        return str(target)
    # SQLite releases this per-file lock after a crash or cancellation. A still becomes
    # visible only after its decode finishes, so parallel searches never read a partial JPEG.
    with closing(sqlite3.connect(out / "thumbs.sqlite", timeout=65)) as owner:
        owner.execute("BEGIN EXCLUSIVE")
        if target.is_file():
            return str(target)
        for stale in out.glob("pending-*.jpg"):
            stale.unlink()
        fd, temporary = tempfile.mkstemp(prefix="pending-", suffix=".jpg", dir=out)
        os.close(fd)
        try:
            tools.text_run([tools.ffmpeg(), "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                            "-ss", f"{midpoint:.3f}", "-i", str(source), "-frames:v", "1",
                            "-vf", "scale=320:-2", temporary], 60, "footage thumbnail")
            if Path(temporary).stat().st_size == 0:
                raise EngineError("NO_FRAME", f"No frame at {midpoint}", "I could not read a still from this clip.")
            os.replace(temporary, target)
            return str(target)
        finally:
            Path(temporary).unlink(missing_ok=True)


def ref_of(place: str, rel: str) -> str:
    """How the app and the editor name an indexed file: Library/<rel>, or Footage/<folder id>/<rel> for a
    file in an added footage folder (the app copies one into the Library before it is used)."""
    return f"Library/{rel}" if place == "Library" else f"Footage/{place}/{rel}"


def _current(folder: Path | None, row) -> bool:
    """The indexed file is still there, unchanged, and really inside its folder."""
    if folder is None:
        return False
    path = folder / row["rel"]
    try:
        return (path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(folder.resolve())
                and _signature(path) == (row["size"], row["mtime_ns"]))
    except OSError:
        return False


def search(root: Path, query: str, *, limit: int = 8) -> dict:
    if not query.strip() or not 1 <= limit <= 8:
        raise EngineError("BAD_ARGS", "search needs a query and limit between 1 and 8",
                          "Enter some words to find and choose up to eight results.")
    root = Path(root).resolve()
    database = root / ".index" / "index.sqlite"
    if not database.is_file():
        return {"hits": [], "more": False, "backend": "none"}
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        fts = _has_fts(db)
        if fts:
            rows = db.execute("SELECT * FROM text_fts WHERE text_fts MATCH ? ORDER BY rank, hash, s",
                              ('"' + query.replace('"', '""') + '"',))
        else:
            rows = db.execute("SELECT * FROM text_fts WHERE instr(lower(text), lower(?)) > 0 ORDER BY hash, s",
                              (query,))
        folders = {row["id"]: (root / "Library" if row["id"] == "Library" else Path(row["root"]))
                   for row in db.execute("SELECT id, root FROM places")}
        hits, sources, seen = [], [], set()
        for row in rows:
            digest = row["hash"]
            key = (digest, row["s"], row["e"])
            if key in seen or not _done(db, digest, f"transcript:{row['model']}", TRANSCRIPT_VERSION):
                continue
            paths = db.execute("SELECT * FROM paths WHERE hash=? ORDER BY place != 'Library', place, rel",
                               (digest,)).fetchall()
            current = next((p for p in paths if _current(folders.get(p["place"]), p)), None)
            # A copy on a drive that is unplugged is still found, so the person can be told to plug it in.
            away = next((p for p in paths if p["place"] in folders and p["place"] != "Library"
                         and not folders[p["place"]].is_dir()), None)
            chosen = current or away
            if chosen is None:
                continue
            info = db.execute("SELECT duration, width FROM files WHERE hash=?", (digest,)).fetchone()
            s, e = row["s"], row["e"]
            if _done(db, digest, "shots", SHOTS_VERSION):
                shot = db.execute("SELECT min(s), max(e) FROM shots WHERE hash=? AND e>? AND s<?",
                                  (digest, s, e)).fetchone()
                if shot[0] is not None:
                    s, e = shot
            hits.append({"hit": f"{digest[:12]}@{s:.2f}-{e:.2f}",
                         "file": {"name": Path(chosen["rel"]).name, "path": ref_of(chosen["place"], chosen["rel"]),
                                  "place": chosen["place"], "online": current is not None, "duration": info[0]},
                         "t0": s, "t1": e, "said": row["text"],
                         "thumbnail": None})
            sources.append((digest, folders[chosen["place"]] / chosen["rel"] if current else None, info[1]))
            seen.add(key)
            if len(hits) > limit:
                break
    # Release the read snapshot before ffmpeg runs so indexing can commit concurrently.
    for hit, (digest, source, width) in zip(hits[:limit], sources):
        if width > 0 and source is not None:
            hit["thumbnail"] = _thumbnail(root, digest, source, (hit["t0"] + hit["t1"]) / 2)
    return {"hits": hits[:limit], "more": len(hits) > limit,
            "backend": "fts5" if fts else "literal"}

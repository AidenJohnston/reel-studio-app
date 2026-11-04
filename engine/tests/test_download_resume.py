"""Speech-model download after a REAL network drop (known issue: resume never seen completing).

A local server stands in for Hugging Face: the index API, a 302 from /resolve/ to a "CDN" path (like
the real thing), Range support, throttled chunks, and connections it CUTS mid-file on purpose:
a clean close (the file comes up short), a TCP reset (SO_LINGER 0) and a chunked body that stops
mid-chunk (http.client.IncompleteRead). Every test ends with the file's SHA-256 checked by
download_model itself and the bytes compared here.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from reelengine import transcribe
from reelengine.proto import EngineError

ENGINE = Path(__file__).resolve().parents[1]
MODEL = os.urandom(3 * 1024 * 1024 + 12345)         # 3 MB, not a multiple of any chunk size
CONFIG = b'{"model_type": "whisper"}'
FILES = {"model.bin": MODEL, "config.json": CONFIG, "tokenizer.json": b'{"version": "1.0"}'}


class Plan:
    """What the server does to each successive request for model.bin."""

    def __init__(self, drops):
        self.drops = list(drops)      # e.g. [("close", 700_000), ("reset", 400_000), ("chunked", 300_000)]
        self.requests = []            # (start offset, how it ended)
        self.paths = []               # every path asked for, in order
        self.lock = threading.Lock()
        self.throttle = 0.0           # seconds per 64 KB chunk

    def next(self, start):
        with self.lock:
            d = self.drops.pop(0) if self.drops else None
            self.requests.append((start, d[0] if d else "ok"))
            return d


def _server(plan: Plan):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_GET(self):
            plan.paths.append(self.path)
            if self.path.startswith("/api/models/"):
                body = json.dumps({"siblings": [
                    {"rfilename": n, "lfs": {"size": len(d), "sha256": hashlib.sha256(d).hexdigest()}}
                    for n, d in FILES.items()]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if "/resolve/main/" in self.path:          # like HF: redirect to the CDN, Range must survive
                self.send_response(302)
                self.send_header("Location", "/cdn/" + self.path.rsplit("/", 1)[1])
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            name = self.path.rsplit("/", 1)[1]
            data = FILES[name]
            start = 0
            rng = self.headers.get("Range")
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
                if start >= len(data):
                    self.send_response(416)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            drop = plan.next(start) if name == "model.bin" else None
            body = data[start:]
            chunked = drop is not None and drop[0] == "chunked"
            self.send_response(206 if start else 200)
            if start:
                self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            limit = drop[1] if drop else len(body)
            sent = 0
            try:
                while sent < min(limit, len(body)):
                    piece = body[sent:min(sent + 65536, limit, len(body))]
                    if chunked:
                        self.wfile.write(b"%x\r\n" % 65536 + piece)      # announce a full chunk, send less
                    else:
                        self.wfile.write(piece)
                    sent += len(piece)
                    if plan.throttle:
                        time.sleep(plan.throttle)
                self.wfile.flush()
                if drop:
                    if drop[0] == "reset":
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    else:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    self.close_connection = True
            except OSError:
                self.close_connection = True

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_MODELS", str(tmp_path / "models"))
    monkeypatch.setenv("REELENGINE_RESUME_BACKOFF", "0")
    servers = []

    def start(plan):
        s = _server(plan)
        servers.append(s)
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{s.server_port}")
        return s
    yield tmp_path / "models" / "tiny.en", start
    for s in servers:
        s.shutdown()


def test_resumes_by_itself_after_close_reset_and_broken_chunk(env):
    d, start = env
    plan = Plan([("close", 700_000), ("reset", 500_000), ("chunked", 400_000)])
    start(plan)
    r = transcribe.download_model("tiny.en")
    assert r["downloaded"]
    assert (d / "model.bin").read_bytes() == MODEL               # sha256 was checked by the engine too
    assert not (d / "model.bin.part").exists()
    offsets = [s for s, _ in plan.requests]
    kinds = [k for _, k in plan.requests]
    assert kinds == ["close", "reset", "chunked", "ok"]
    # each retry asked for the bytes it did NOT have (Range), never from zero again. (A reset can
    # throw away bytes still in flight, so an offset may repeat; it never goes back.)
    assert offsets[0] == 0 and offsets[1] == 700_000
    assert all(b >= a for a, b in zip(offsets, offsets[1:])), offsets
    assert offsets[-1] < len(MODEL)


def test_drop_that_keeps_happening_keeps_the_part_and_the_next_try_finishes(env):
    d, start = env
    plan = Plan([("close", 300_000)] * (transcribe.RESUME_TRIES + 1))
    start(plan)
    with pytest.raises(EngineError) as e:
        transcribe.download_model("tiny.en")
    assert e.value.code == "DOWNLOAD_INCOMPLETE"
    kept = (d / "model.bin.part").stat().st_size
    assert kept == 300_000 * (transcribe.RESUME_TRIES + 1)
    # the user presses "Keep downloading": same engine call, network healthy again
    r = transcribe.download_model("tiny.en")
    assert r["downloaded"] and (d / "model.bin").read_bytes() == MODEL
    assert plan.requests[-1] == (kept, "ok")                     # picked up exactly where it stopped


def test_resets_that_keep_happening_report_offline_and_resume_later(env):
    d, start = env
    plan = Plan([("close", 200_000)] + [("reset", 0)] * transcribe.RESUME_TRIES)
    start(plan)
    with pytest.raises(EngineError) as e:
        transcribe.download_model("tiny.en")
    assert e.value.code == "OFFLINE" and "pick up where it left off" in e.value.user_message
    assert (d / "model.bin.part").stat().st_size == 200_000
    transcribe.download_model("tiny.en")
    assert (d / "model.bin").read_bytes() == MODEL


def test_offline_from_the_first_byte_fails_fast(env, monkeypatch):
    d, _ = env
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()                                                    # nothing listens there
    monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{port}")
    t0 = time.time()
    with pytest.raises(EngineError) as e:
        transcribe.download_model("tiny.en")
    assert e.value.code == "OFFLINE" and time.time() - t0 < 20


def test_killed_mid_download_then_run_again_resumes(env, tmp_path):
    """The app quits (or the machine sleeps) in the middle: the engine PROCESS dies with the socket
    open. Running download-model again resumes from the .part and passes the checksum."""
    d, start = env
    plan = Plan([])
    plan.throttle = 0.05                                         # ~1.3 MB/s: slow enough to kill mid-file
    srv = start(plan)
    envv = dict(os.environ, PYTHONPATH=str(ENGINE))
    p = subprocess.Popen([sys.executable, "-m", "reelengine", "download-model", "--name", "tiny.en"],
                         cwd=str(ENGINE), env=envv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    part = d / "model.bin.part"
    deadline = time.time() + 30
    while time.time() < deadline and not (part.exists() and part.stat().st_size > 400_000):
        time.sleep(0.05)
    p.kill()
    p.wait(timeout=10)
    have = part.stat().st_size
    assert 0 < have < len(MODEL)
    plan.throttle = 0
    out = subprocess.run([sys.executable, "-m", "reelengine", "download-model", "--name", "tiny.en"],
                         cwd=str(ENGINE), env=envv, capture_output=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert (d / "model.bin").read_bytes() == MODEL
    assert plan.requests[-1][0] >= have > 0                     # resumed, not restarted


def test_a_pinned_model_downloads_its_revision_and_refuses_other_bytes(env, monkeypatch):
    """small.en ships pinned (models/speech-models.json): no index lookup, the exact revision, and a
    file whose bytes differ from the pinned SHA-256 is never kept."""
    d, start = env
    plan = Plan([])
    start(plan)
    pin = {"repo": "Systran/faster-whisper-tiny.en", "revision": "0123abc",
           "files": [{"name": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in FILES.items()]}
    monkeypatch.setitem(transcribe.PINNED_MODELS, "tiny.en", pin)
    transcribe.download_model("tiny.en")
    assert (d / "model.bin").read_bytes() == MODEL
    assert not any(p.startswith("/api/") for p in plan.paths)
    assert all("/resolve/0123abc/" in p for p in plan.paths), plan.paths

    for f in d.iterdir():
        f.unlink()
    pin["files"][1]["sha256"] = "0" * 64                         # config.json: same size, other bytes
    with pytest.raises(EngineError) as e:
        transcribe.download_model("tiny.en")
    assert e.value.code == "DOWNLOAD_CORRUPT" and not (d / "config.json").exists()

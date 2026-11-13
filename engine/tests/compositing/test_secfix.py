"""Regression tests for an independent code review, engine side. Each test names its
finding. Each FAILED before the fixes landed and passes now."""
from __future__ import annotations

import builtins
import functools
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import types
from pathlib import Path

import pytest
from PIL import Image

import fixtures as fx
from reelengine import assets, broll, captions, cut, init as initmod, project as projmod, render, tools
from reelengine import transcribe, verify
from reelengine.proto import EngineError
from reelengine.safepath import safe_resolve


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("secfix media")
    return {"video": fx.synth_video(d / "talk.mp4", dur=12.0), "clip": fx.synth_clip(d / "clip.mp4", dur=2.0),
            **fx.synth_images(d / "img")}


@pytest.fixture()
def strict(monkeypatch):
    """The suite's test-only hatches OFF: the rules exactly as the app runs them."""
    monkeypatch.delenv("REELENGINE_EXTRA_READ_DIRS", raising=False)
    monkeypatch.delenv("REELENGINE_ALLOW_PRIVATE_FETCH", raising=False)


def _proj(tmp_path, media, keep=((1.0, 5.0), (6.0, 10.0)), **extra):
    pdir = tmp_path / "p"
    fx.make_project(pdir, media["video"], keep=keep, extra=extra or None)
    return pdir


# --- 1 (CRITICAL): no free string reaches an ffmpeg filter graph -------------------------------

EVIL = "000000,metadata=mode=print:file=PWNED.txt"


def test_f1_background_cannot_inject_a_filter(tmp_path, media, monkeypatch):
    assert broll.ff_hex(EVIL) == "101010"
    assert broll.ff_hex("#a0B1c2") == "A0B1C2" and broll.ff_hex("A0B1C2FF") == "A0B1C2"
    pdir = _proj(tmp_path, media)
    ctx = fx.make_ctx(pdir)
    monkeypatch.chdir(tmp_path)                       # where `file=PWNED.txt` would land
    out = broll._video_full(ctx, media["clip"], 0.0, 1.0, "contain", EVIL, "evil")
    assert out.exists()
    assert not (tmp_path / "PWNED.txt").exists()
    assert not list(tmp_path.rglob("PWNED.txt"))


def test_f1_split_background_validated(tmp_path, media, monkeypatch):
    pdir = _proj(tmp_path, media)
    ctx = fx.make_ctx(pdir)
    monkeypatch.chdir(tmp_path)
    face = (380, 576, 320, 400)
    out = broll._split_video(ctx, 1.0, 2.0, media["clip"], "video", 0.0,
                             {"fit": "contain", "background": EVIL, "split": 0.4}, face, "evil-split")
    assert out.exists() and not list(tmp_path.rglob("PWNED.txt"))


def test_f1_ass_text_and_colours_cannot_break_the_file():
    assert "\n" not in captions.ass_escape("hello\nDialogue: 0,0:00:00.00,9:00:00.00,Cap,,0,0,0,,{\\pos(0,0)}X")
    assert "{" not in captions.ass_escape("{\\b1}x")
    assert captions.ass_color("#FF0000,1,2") == captions.ass_color("#FFFFFF")


# --- 2: path containment (engine) --------------------------------------------------------------

BAD_PATHS = [r"C:\Windows\win.ini", "C:/Windows/win.ini", "/etc/passwd", r"\\server\share\x.png",
             "//server/share/x.png", r"\\?\C:\Windows\win.ini", "Library/../../secret.png",
             "../../secret.mp4", "work/../../secret.png", r"work\..\..\secret.png"]


@pytest.mark.parametrize("bad", BAD_PATHS)
def test_f2_resolve_refuses_outside_paths(tmp_path, media, strict, bad):
    pdir = _proj(tmp_path, media)
    ctx = fx.make_ctx(pdir, root=tmp_path / "root")
    with pytest.raises(EngineError) as e:
        ctx.resolve_path(bad)
    assert e.value.code == "UNSAFE_PATH" and e.value.user_message
    # the duck-typed path A2 uses had an unchecked fallback join
    from reelengine.compose_util import resolve_asset
    duck = types.SimpleNamespace(project_dir=pdir, root=tmp_path / "root")
    with pytest.raises(EngineError):
        resolve_asset(duck, bad)


def test_f2_absolute_file_outside_is_refused_even_if_it_exists(tmp_path, media, strict):
    secret = tmp_path / "secret.png"
    Image.new("RGB", (8, 8)).save(secret)
    pdir = _proj(tmp_path, media)
    ctx = fx.make_ctx(pdir, root=tmp_path / "root")
    with pytest.raises(EngineError):
        ctx.resolve_path(str(secret))
    with pytest.raises(EngineError):
        projmod.source_path(pdir, {"id": "s9", "path": str(secret)})


def test_f2_allowed_paths_still_resolve(tmp_path, media, strict):
    pdir = _proj(tmp_path, media)
    root = tmp_path / "root"
    ctx = fx.make_ctx(pdir, root=root)
    assert ctx.resolve_path("work/assets/a.png") == Path(os.path.realpath(pdir / "work" / "assets" / "a.png"))
    assert ctx.resolve_path("Library/Music/s.mp3") == Path(os.path.realpath(root / "Library" / "Music" / "s.mp3"))
    assert projmod.source_path(pdir, ctx.project["sources"][0]).exists()


def test_f2_symlink_inside_work_cannot_escape(tmp_path, media, strict):
    secret = tmp_path / "secret.png"
    Image.new("RGB", (8, 8)).save(secret)
    pdir = _proj(tmp_path, media)
    link = pdir / "work" / "assets" / "innocent.png"
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(secret, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need Developer Mode / admin on this Windows")
    ctx = fx.make_ctx(pdir, root=tmp_path / "root")
    with pytest.raises(EngineError):
        ctx.resolve_path("work/assets/innocent.png")


@pytest.mark.parametrize("where", ["source", "asset", "track"])
def test_f2_schema_rejects_absolute_unc_and_dotdot(tmp_path, media, where):
    pdir = _proj(tmp_path, media)
    good = projmod.read_json(pdir / "project.json")
    assert projmod.validate(good) == []
    for bad in (r"C:\Windows\win.ini", r"\\srv\share\x", "//srv/x", "/etc/x", "Library/../../x", ".."):
        p = json.loads(json.dumps(good))
        if where == "source":
            p["sources"][0]["path"] = bad
        elif where == "asset":
            p["broll"] = [{"id": "b1", "anchor": {"from": "w1", "to": "w2"}, "treatment": "full-frame", "asset": bad}]
        else:
            p["music"] = {"enabled": True, "track": bad}
        assert projmod.validate(p), f"{where}={bad!r} was accepted"


# --- 3: the transcript is always work/transcript.json ------------------------------------------

def test_f3_transcript_file_cannot_point_elsewhere(tmp_path, media):
    pdir = _proj(tmp_path, media)
    proj = projmod.read_json(pdir / "project.json")
    proj["transcript"]["file"] = "../outside/transcript.json"
    assert projmod.transcript_path(pdir, proj) == pdir / "work" / "transcript.json"
    assert projmod.validate(proj), "schema accepted a transcript.file outside work/"
    proj["transcript"]["file"] = str(tmp_path / "abs.json")
    assert projmod.transcript_path(pdir, proj) == pdir / "work" / "transcript.json"


# --- 4, 5: fetch_image ------------------------------------------------------------------------

class _Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.startswith("/redirect-loopback"):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/x.png")
            self.end_headers()
            return
        if self.path.startswith("/redirect?to="):
            self.send_response(302)
            self.send_header("Location", self.path.split("=", 1)[1])
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass


@pytest.fixture()
def site(tmp_path):
    d = tmp_path / "site"
    d.mkdir()
    Image.new("RGB", (40, 30), (10, 200, 10)).save(d / "pic.png")
    (d / "big.png").write_bytes(b"\x89PNG" + os.urandom(300_000))
    (d / "notimg.png").write_bytes(b"this is text pretending to be a png" * 4)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Handler, directory=str(d)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.mark.parametrize("name", ["../../../x", r"..\..\x", "C:/Users/v/Desktop/x", "/abs/x", "a/b"])
def test_f4_fetch_image_name_is_a_slug(tmp_path, site, name):
    dest = tmp_path / "proj" / "work" / "assets"
    out = assets.fetch_image(f"{site}/pic.png", dest, name=name)
    assert out.resolve().parent == dest.resolve(), out
    assert all(c.isalnum() or c in "-." for c in out.name)


@pytest.mark.parametrize("url", ["file:///C:/Windows/win.ini", "data:image/png;base64,iVBORw0KGgo=",
                                 "ftp://example.com/x.png", "gopher://x/", "javascript:alert(1)"])
def test_f5_only_http_urls(tmp_path, url):
    with pytest.raises(EngineError) as e:
        assets.fetch_image(url, tmp_path)
    assert e.value.code == "BAD_URL"


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254",
                                  "[::1]", "0.0.0.0"])
def test_f5_private_hosts_refused(tmp_path, strict, host):
    with pytest.raises(EngineError) as e:
        assets.fetch_image(f"http://{host}:8/x.png", tmp_path)
    assert e.value.code == "BLOCKED_HOST"


def test_f5_redirect_to_loopback_refused(monkeypatch):
    monkeypatch.delenv("REELENGINE_ALLOW_PRIVATE_FETCH", raising=False)
    h = assets._CheckedRedirects()
    with pytest.raises(EngineError) as e:
        h.redirect_request(None, None, 302, "Found", {}, "http://127.0.0.1/secret.png")
    assert e.value.code == "BLOCKED_HOST"


def _resolves_as(monkeypatch, host, first, then):
    """`host` answers `first` to its first lookup and `then` to every later one."""
    monkeypatch.setenv("no_proxy", "*")              # a system proxy would do the lookups instead
    real, answers = socket.getaddrinfo, [first]

    def fake(h, port, *a, **kw):
        if h != host:
            return real(h, port, *a, **kw)
        ip = answers.pop() if answers else then
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port))]
    monkeypatch.setattr(socket, "getaddrinfo", fake)


def test_f5_a_name_that_rebinds_to_loopback_is_not_fetched(tmp_path, site, strict, monkeypatch):
    _resolves_as(monkeypatch, "pics.example", "93.184.215.14", "127.0.0.1")
    with pytest.raises(EngineError) as e:
        assets.fetch_image(f"http://pics.example:{site.rsplit(':', 1)[1]}/pic.png", tmp_path)
    assert e.value.code == "BLOCKED_HOST"


class _V6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def test_f5_a_redirect_that_rebinds_to_loopback_is_not_followed(tmp_path, site, strict, monkeypatch):
    # [::1] stands in for a public website; its redirect names a host that later answers 127.0.0.1
    cdn = _V6Server(("::1", 0), functools.partial(_Handler, directory=str(tmp_path)))
    threading.Thread(target=cdn.serve_forever, daemon=True).start()
    real_blocked = assets._blocked_ip
    monkeypatch.setattr(assets, "_blocked_ip", lambda ip: ip != "::1" and real_blocked(ip))
    _resolves_as(monkeypatch, "inner.example", "93.184.215.14", "127.0.0.1")
    target = f"http://inner.example:{site.rsplit(':', 1)[1]}/pic.png"
    try:
        with pytest.raises(EngineError) as e:
            assets.fetch_image(f"http://[::1]:{cdn.server_port}/redirect?to={target}", tmp_path / "out")
        assert e.value.code == "BLOCKED_HOST"
    finally:
        cdn.shutdown()


@pytest.mark.parametrize("ip", ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1", "::ffff:127.0.0.1"])
def test_f5_nat64_and_mapped_private_addresses_are_blocked(ip):
    assert assets._blocked_ip(ip)


def test_f5_nat64_public_address_is_allowed():
    # an IPv6-only network (DNS64) reaches every IPv4-only website through 64:ff9b::/96
    assert not assets._blocked_ip("64:ff9b::808:808")


def test_f5_size_cap_and_image_check(tmp_path, site, monkeypatch):
    monkeypatch.setattr(assets, "MAX_IMAGE_BYTES", 100_000)
    with pytest.raises(EngineError) as e:
        assets._get(f"{site}/big.png", limit=100_000)
    assert e.value.code == "TOO_BIG"
    with pytest.raises(EngineError) as e:
        assets.fetch_image(f"{site}/notimg.png", tmp_path)
    assert e.value.code == "NOT_AN_IMAGE"


# --- 6, 20: model download ---------------------------------------------------------------------

FILES = {"model.bin": os.urandom(5000), "config.json": b'{"a": 1}', "tokenizer.json": b"{}"}


def _hf_server(files: dict, bad_name: str | None = None, lie_sha: set | None = None, hits: list | None = None):
    def sha(b):
        return hashlib.sha256(b).hexdigest()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/api/models/"):
                sibs = [{"rfilename": k, "size": len(v), "lfs": {"sha256": sha(v), "size": len(v)}}
                        for k, v in files.items()]
                if bad_name:
                    sibs.append({"rfilename": bad_name, "size": 3, "lfs": {"sha256": sha(b"bad"), "size": 3}})
                body = json.dumps({"siblings": sibs}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)
                return
            name = self.path.rsplit("/", 1)[-1]
            data = files.get(name, b"bad")
            if lie_sha and name in lie_sha:
                data = bytes(len(data))           # right length, wrong bytes
                lie_sha.discard(name)             # only the first time
            if hits is not None:
                hits.append((name, self.headers.get("Range")))
            rng = self.headers.get("Range")
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
                if start >= len(data):
                    self.send_response(416)
                    self.end_headers()
                    return
                self.send_response(206)
                self.end_headers()
                self.wfile.write(data[start:])
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(data)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture()
def models(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_MODELS", str(tmp_path / "models"))
    return tmp_path / "models"


def test_f6_complete_part_is_not_a_permanent_416(models, monkeypatch):
    srv = _hf_server(FILES)
    try:
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{srv.server_port}")
        d = models / "tiny.en"
        d.mkdir(parents=True)
        (d / "model.bin.part").write_bytes(FILES["model.bin"])   # killed right before the rename
        r = transcribe.download_model("tiny.en")
        assert r["downloaded"] and (d / "model.bin").read_bytes() == FILES["model.bin"]
        assert not (d / "model.bin.part").exists()
    finally:
        srv.shutdown()


def test_f6_server_416_restarts_the_file(models, monkeypatch):
    srv = _hf_server(FILES)
    try:
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{srv.server_port}")
        d = models / "tiny.en"
        d.mkdir(parents=True)
        (d / "config.json.part").write_bytes(b"x" * 400)          # longer than the file: never resumable
        transcribe.download_model("tiny.en")
        assert (d / "config.json").read_bytes() == FILES["config.json"]
    finally:
        srv.shutdown()


def test_f6_sha256_mismatch_is_redownloaded(models, monkeypatch):
    hits = []
    srv = _hf_server(FILES, lie_sha={"model.bin"}, hits=hits)
    try:
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{srv.server_port}")
        transcribe.download_model("tiny.en")
        assert (models / "tiny.en" / "model.bin").read_bytes() == FILES["model.bin"]
        assert sum(1 for n, _ in hits if n == "model.bin") == 2
    finally:
        srv.shutdown()


@pytest.mark.parametrize("bad", ["x/../../ESCAPED.bin", "x\\..\\..\\ESCAPED.bin", "sub/model.bin", "C:evil.bin"])
def test_f20_remote_file_names_cannot_escape(models, monkeypatch, bad):
    srv = _hf_server(FILES, bad_name=bad)
    try:
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{srv.server_port}")
        with pytest.raises(EngineError) as e:
            transcribe.download_model("tiny.en")
        assert e.value.code == "BAD_MODEL_INDEX"
        assert not (models / "ESCAPED.bin").exists() and not list(models.parent.rglob("ESCAPED.bin"))
    finally:
        srv.shutdown()


# --- 16: read-modify-write of project.json -----------------------------------------------------

def test_f16_render_keeps_an_edit_saved_while_it_ran(tmp_path, media, monkeypatch):
    pdir = _proj(tmp_path, media, keep=((1.0, 4.0),))
    real_cover = render.render_cover

    def cover_and_edit(*a, **k):
        p = projmod.read_json(pdir / "project.json")          # the app/AI saves during the render
        p["post"]["caption"] = "edited meanwhile"
        p["captions"]["style"]["size"] = 80
        projmod.save(pdir, p)
        return real_cover(*a, **k)

    monkeypatch.setattr(render, "render_cover", cover_and_edit)
    r = render.run(pdir, draft=False, root=tmp_path, verify=False)
    after = projmod.read_json(pdir / "project.json")
    assert after["version"] == r["version"] == 1
    assert after["post"]["caption"] == "edited meanwhile" and after["captions"]["style"]["size"] == 80


def test_f16_transcribe_keeps_an_edit_saved_while_it_ran(tmp_path, media, monkeypatch):
    pdir = _proj(tmp_path, media)
    words0 = projmod.read_json(pdir / "work" / "transcript.json")["words"]
    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "load_model", lambda name, prefer=None: (object(), "cpu", "int8"))

    def fake_one(model, wav, lang, prompt, dur, p0, p1, hotwords=None):
        p = projmod.read_json(pdir / "project.json")
        p["title"] = "renamed meanwhile"
        projmod.save(pdir, p)
        ws = [{"s": w["s"], "e": w["e"], "w": w["w"]} for w in words0]
        return ws, [{"s": ws[0]["s"], "e": ws[-1]["e"], "text": "x", "n": len(ws)}], "en"

    monkeypatch.setattr(transcribe, "_transcribe_one", fake_one)
    transcribe.run(pdir)
    after = projmod.read_json(pdir / "project.json")
    assert after["title"] == "renamed meanwhile" and after["transcript"]["file"] == "work/transcript.json"


# --- 17, 39: honest render results -------------------------------------------------------------

def test_f17_unknown_anchor_is_reported_and_f39_no_dev_text(tmp_path, media, monkeypatch):
    pdir = _proj(tmp_path, media, keep=((1.0, 4.0),),
                 broll=[{"id": "b7", "anchor": {"from": "w9998", "to": "w9999"}, "treatment": "text-pop",
                         "asset": None, "params": {"text": "hi"}}],
                 zooms=[{"anchor": {"from": "w9990", "to": "w9991"}, "scale": 1.1}])
    r = render.run(pdir, draft=True, root=tmp_path, verify=False)
    rows = [b for b in r["broll"] if b["id"] == "b7"]
    assert rows and rows[0]["skipped"], r["broll"]
    assert any("no longer in the transcript" in w for w in r["warnings"]), r["warnings"]
    assert any("zoom" in w for w in r["warnings"])

    def boom(ctx):
        raise ValueError("operands could not be broadcast together with shapes (3,) (4,)")

    monkeypatch.setattr(broll, "build_layers", boom)
    p = projmod.read_json(pdir / "project.json")
    p["broll"][0]["anchor"] = {"from": "w3", "to": "w5"}
    projmod.save(pdir, p)
    r = render.run(pdir, draft=True, root=tmp_path, verify=False)
    text = " ".join(r["warnings"])
    assert "ValueError" not in text and "operands" not in text and "b-roll" in text


def test_f39_ffmpeg_timeout_is_timeout():
    with pytest.raises(EngineError) as e:
        tools.ffmpeg_progress([sys.executable, "-c", "import time; time.sleep(20)"], 1.0, lambda p: None,
                              timeout=0.5, what="sleep")
    assert e.value.code == "TIMEOUT"


# --- 18: no replayed audio at adjacent keep ranges ---------------------------------------------

def test_f18_adjacent_ranges_never_replay_source():
    from conftest import mkwords
    spec = [(0.10, 0.40, "a"), (0.45, 0.80, "b"), (0.85, 1.30, "c"),
            (1.40, 1.70, "d"), (1.75, 2.10, "e"), (2.15, 2.60, "f")]
    words = mkwords(spec)
    srcs = {"s1": {"duration": 4.0, "fps": 30.0}}
    split = cut.build_timeline(words, [{"from": "w0", "to": "w2"}, {"from": "w3", "to": "w5"}], srcs,
                               gap_cap=0.25, min_saving=0.08)
    whole = cut.build_timeline(words, [{"from": "w0", "to": "w5"}], srcs, gap_cap=0.25, min_saving=0.08)
    for a, b in zip(split.segments, split.segments[1:]):
        if a.source == b.source:
            assert b.src_start >= a.src_end - 1e-6, f"replayed {a.src_end - b.src_start:.3f}s of source"
    assert split.word_out_time("w3") == pytest.approx(whole.word_out_time("w3"), abs=1e-6)
    assert split.duration == pytest.approx(whole.duration, abs=1e-6)


# --- 19: a GPU that crashes the process never runs in-process ----------------------------------

def test_f19_cuda_selftest_crash_falls_back_to_cpu(tmp_path, monkeypatch):
    built = []

    class FakeModel:
        def __init__(self, path, device, compute_type, cpu_threads=0):
            built.append(device)
            if device == "cuda":
                raise AssertionError("an in-process CUDA load would abort the engine")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeModel))
    monkeypatch.setattr(transcribe, "require_model", lambda name: tmp_path)
    monkeypatch.setattr(transcribe, "cuda_available", lambda: True)
    transcribe._CUDA_OK.clear()
    crashed = subprocess.CompletedProcess([], 3221226505, "", "Could not load library cudnn_ops64_9.dll")
    monkeypatch.setattr(transcribe.subprocess, "run", lambda *a, **k: crashed)
    model, dev, compute = transcribe.load_model("tiny.en")
    assert (dev, compute) == ("cpu", "int8") and built == ["cpu"]


# --- 21: stale media from a dead init ----------------------------------------------------------

def test_f21_init_replaces_stale_media(tmp_path, media):
    pdir = tmp_path / "proj"
    (pdir / "media").mkdir(parents=True)
    stale = fx.synth_video(tmp_path / "other.mp4", dur=3.0)
    shutil.copy2(stale, pdir / "media" / "take01.mp4")        # left by an init that died
    r = initmod.run(pdir, "T", [media["video"]])
    src = r["sources"][0]
    assert (pdir / "media" / "take01.mp4").stat().st_size == media["video"].stat().st_size
    assert src["duration"] == pytest.approx(12.0, abs=0.2)


# --- 38b: a failed verify decode is not a PASS -------------------------------------------------

def test_f38b_verify_decode_failure_is_not_pass(tmp_path, media, monkeypatch):
    real = tools.text_run

    def failing(cmd, timeout, what, check=True, **k):
        if what == "verify decode":
            return subprocess.CompletedProcess(cmd, 1, "", "Error while decoding stream #0:0: Invalid data")
        return real(cmd, timeout, what, check=check, **k)

    monkeypatch.setattr(tools, "text_run", failing)
    rep = verify.check(media["video"], expect_w=1080, expect_h=1920)
    black = [c for c in rep["checks"] if c["name"] == "black frames"]
    assert black and black[0]["status"] != "PASS" and not rep["ok"]


# --- 40: an export is never replaced by a different video under the same version ---------------

def test_f40_replaced_asset_makes_a_new_version(tmp_path, media):
    pdir = _proj(tmp_path, media, keep=((1.0, 4.0),))
    (pdir / "work" / "assets").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (400, 300), (200, 0, 0)).save(pdir / "work" / "assets" / "pic.png")
    p = projmod.read_json(pdir / "project.json")
    p["broll"] = [{"id": "b1", "anchor": {"from": "w4", "to": "w7"}, "treatment": "full-frame",
                   "asset": "work/assets/pic.png", "params": {}}]
    projmod.save(pdir, p)
    r1 = render.run(pdir, draft=False, root=tmp_path, verify=False)
    first = (pdir / "versions" / "v1" / "export.mp4").read_bytes()
    assert render.run(pdir, draft=False, root=tmp_path, verify=False)["version"] == r1["version"] == 1
    Image.new("RGB", (400, 300), (0, 0, 200)).save(pdir / "work" / "assets" / "pic.png")   # same name
    r3 = render.run(pdir, draft=False, root=tmp_path, verify=False)
    assert r3["version"] == 2
    assert (pdir / "versions" / "v1" / "export.mp4").read_bytes() == first


# --- 41: durable atomic writes -----------------------------------------------------------------

def test_f41_write_json_fsyncs_before_replace(tmp_path, monkeypatch):
    calls = []
    real_fsync, real_replace = os.fsync, os.replace
    monkeypatch.setattr(os, "fsync", lambda fd: (calls.append("fsync"), real_fsync(fd))[1])
    monkeypatch.setattr(os, "replace", lambda a, b: (calls.append("replace"), real_replace(a, b))[1])
    projmod.write_json(tmp_path / "x.json", {"a": 1})
    assert calls and calls[0] == "fsync" and "replace" in calls


# --- 42: nothing ever opens media/* for writing ------------------------------------------------

def test_f42_media_is_never_opened_for_writing(tmp_path, media, monkeypatch):
    pdir = tmp_path / "proj"
    initmod.run(pdir, "T", [media["video"]])
    take = pdir / "media" / "take01.mp4"
    before = (take.stat().st_mtime_ns, hashlib.sha256(take.read_bytes()).hexdigest())
    media_dir = os.path.normcase(os.path.realpath(pdir / "media"))
    real_open, real_os_open = builtins.open, os.open

    def guard(path):
        try:
            rp = os.path.normcase(os.path.realpath(os.fspath(path)))
        except TypeError:
            return
        assert not rp.startswith(media_dir), f"opened {path} for writing"

    def g_open(file, mode="r", *a, **k):
        if any(c in mode for c in "wax+"):
            guard(file)
        return real_open(file, mode, *a, **k)

    def g_os_open(path, flags, *a, **k):
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC):
            guard(path)
        return real_os_open(path, flags, *a, **k)

    monkeypatch.setattr(builtins, "open", g_open)
    monkeypatch.setattr(os, "open", g_os_open)
    words = [{"id": f"w{i}", "source": "s1", "s": 0.5 + i * 0.4, "e": 0.8 + i * 0.4, "w": f"w{i}"} for i in range(25)]
    projmod.write_json(pdir / "work" / "transcript.json", {"words": words})
    p = projmod.read_json(pdir / "project.json")
    p["transcript"] = {"file": "work/transcript.json", "language": "en"}
    p["cut"]["keep"] = [{"from": "w1", "to": "w8"}, {"from": "w12", "to": "w20"}]
    projmod.save(pdir, p)
    render.run(pdir, draft=True, root=tmp_path, verify=False)
    render.run(pdir, draft=False, root=tmp_path, verify=True)
    assert (take.stat().st_mtime_ns, hashlib.sha256(take.read_bytes()).hexdigest()) == before


# --- 1 (audit): a b-roll id is part of a layer FILE NAME ---------------------------------------

def test_f1_audit_broll_id_cannot_be_a_path(tmp_path, media):
    pdir = _proj(tmp_path, media)
    p = projmod.read_json(pdir / "project.json")
    for bad in ("../../../evil", "a/b", "C:x", ""):
        p["broll"] = [{"id": bad, "anchor": {"from": "w1", "to": "w2"}, "treatment": "text-pop", "params": {"text": "x"}}]
        assert projmod.validate(p), f"broll id {bad!r} accepted"
    p["broll"][0]["id"] = "b12"
    assert projmod.validate(p) == []


def test_f5_download_media_refuses_private_hosts(tmp_path, strict):
    with pytest.raises(EngineError) as e:
        assets.download_media("http://127.0.0.1:9/video.mp4", tmp_path)
    assert e.value.code == "BLOCKED_HOST"


def test_f38a_bad_link_checked_before_ytdlp_import(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", None)          # yt-dlp missing from this install
    with pytest.raises(EngineError) as e:
        assets.download_media("not a link", tmp_path)
    assert e.value.code == "BAD_LINK"


# --- e2e (c): cover text sits by the face, never mid-chest -------------------------------------

def test_e2e_cover_text_hugs_the_face_when_the_head_is_high(tmp_path, media, monkeypatch):
    from reelengine import cover, placement
    seen = []
    box = [390, 230, 300, 360]                                  # head high in the frame, chin at y=590

    def fake_detect(bgr):
        seen.append(bgr.shape)
        return {"box": box, "core": placement.core_from_box(box), "score": 0.99, "landmarks": None}

    monkeypatch.setattr(placement, "detect_in_frame", fake_detect)
    pdir = _proj(tmp_path, media, cover={"atSourceTime": 3.0, "source": "s1", "text": "Big news"})
    ctx = fx.make_ctx(pdir)
    cover.render(ctx, tmp_path / "cover.png")
    x, y, w, h, where = ctx._cover_text_box
    assert seen and seen[-1][:2] == (1920, 1080)                # detected on the composed cover
    chin = box[1] + box[3]
    assert where == "below" and chin <= y <= chin + 0.08 * 1920, (y, chin)
    assert y + h <= chin + 0.24 * 1920 + 2

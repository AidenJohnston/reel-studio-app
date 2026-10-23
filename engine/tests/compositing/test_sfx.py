"""Sound effects in the final mix: on their moment, sparse, under the voice, and absent when unused."""
import json
import re
import subprocess
from pathlib import Path

import pytest

from reelengine import music, project as projmod, render, sfx

from . import fixtures as fx

FPS = 30


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    """A 10 s take that talks for 3 s, then stays silent, so each effect can be measured on its own in
    the mix. The talking is gated pink noise: its peaks sit about 12 dB over its loudness, as speech's do."""
    p = tmp_path_factory.mktemp("sfx-take") / "take.mp4"
    af = "anoisesrc=d=10:c=pink:r=48000:a=0.3:seed=7,volume='if(lt(t,3),if(lt(mod(t,1.2),0.8),1,0),0)':eval=frame"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=270x480:r=30:d=10",
                    "-f", "lavfi", "-i", af, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "pcm_s16le", "-shortest", str(p.with_suffix(".mov"))], check=True)
    return p.with_suffix(".mov")


def project(tmp_path, take):
    fx.make_project(tmp_path / "proj", take, keep=((0.05, 9.6),))
    return fx.make_ctx(tmp_path / "proj")


def mix(ctx, tmp_path, **fields):
    """(cut voice, final mix path, final mix samples) for the project with `fields` set."""
    fx.set_project(ctx, **fields)
    voice = fx.cut_voice(ctx, tmp_path / "voice.wav")
    out = music.build_audio(ctx, voice)
    return voice, out, music.decode(out, ctx)


def seconds(x, a, b):
    return x[int(a * music.SR): int(b * music.SR)]


def test_hit_lands_on_its_moment_within_a_frame(tmp_path, take):
    # whoosh-wide's hit is 670 ms in and riser-short's 1717 ms: placed by the file's start, both would
    # land many frames late. The riser sits on a b-roll's appearance, which leads its word by 0.3 s.
    ctx = project(tmp_path, take)
    w4, w8 = fx.word_near(ctx, 4.0), fx.word_near(ctx, 8.3)
    _, _, out = mix(ctx, tmp_path,
                     broll=[{"id": "b1", "anchor": {"from": w8, "to": w8}, "treatment": "text-pop",
                             "leadIn": 0.3, "params": {"text": "Hi"}}],
                     sfx=[{"at": {"word": w4}, "sound": "whoosh-wide"}, {"at": {"broll": "b1"}, "sound": "riser-short"}])
    for want, a, b in ((round(ctx.word_out_time(w4) * FPS) / FPS, 3.3, 5.3),
                       (round((ctx.word_out_time(w8) - 0.3) * FPS) / FPS, 5.8, 8.6)):
        got = a + sfx.hit_offset(seconds(out, a, b))
        assert abs(got - want) <= 1 / FPS, (got, want)


def test_effect_on_first_kept_word_survives_a_snapped_cut(tmp_path, take):
    pdir = tmp_path / "proj"
    proj = fx.make_project(pdir, take)
    # Continuous speech: the removed word ends exactly where the kept word starts.
    # At 30 fps, snapping 2.02 s moves the segment start past that word's source start.
    words = [
        {"id": "w0", "source": "s1", "s": 0.05, "e": 0.8, "w": "Keep"},
        {"id": "w1", "source": "s1", "s": 1.0, "e": 2.02, "w": "remove"},
        {"id": "w2", "source": "s1", "s": 2.02, "e": 2.4, "w": "this"},
        {"id": "w3", "source": "s1", "s": 2.4, "e": 3.0, "w": "too"},
    ]
    proj["cut"]["keep"] = [{"from": "w0", "to": "w0"}, {"from": "w2", "to": "w3"}]
    proj["sfx"] = [{"at": {"word": "w2"}, "sound": "pop-plop"}]
    (pdir / "work" / "transcript.json").write_text(json.dumps({"words": words}), encoding="utf-8")
    tl = projmod.timeline(pdir, proj, words)
    assert tl.segments[1].src_start > words[2]["s"] + 0.001
    ctx = render.make_ctx(pdir, proj, tl, True, pdir, pdir / "work" / "render")

    placed, left = sfx.plan(ctx)

    assert left == []
    assert len(placed) == 1
    assert placed[0]["at"] == {"word": "w2"}
    assert placed[0]["t"] == pytest.approx(tl.segments[1].out_start)


def test_two_effects_closer_than_the_limit_play_once(tmp_path, take):
    ctx = project(tmp_path, take)
    first, second = fx.word_near(ctx, 4.0), fx.word_near(ctx, 4.0 + sfx.MIN_GAP - 0.4)
    _, _, out = mix(ctx, tmp_path, sfx=[{"at": {"word": first}, "sound": "pop-plop"},
                                        {"at": {"word": second}, "sound": "pop-plop"}])
    t2 = ctx.word_out_time(second)
    assert sfx.peak_loudness(seconds(out, 3.9, 4.4)) > -40
    assert sfx.peak_loudness(seconds(out, t2 - 0.1, t2 + 0.4)) < -70


def test_effects_that_cannot_play_cleanly_are_left_out(tmp_path, take):
    pdir = tmp_path / "proj"
    fx.make_project(pdir, take, keep=((0.05, 3.0), (4.0, 6.0), (7.0, 9.6)))
    words = projmod.load_transcript(pdir, projmod.load(pdir))["words"]
    removed = next(w["id"] for w in words if 3.2 < w["s"] < 3.8)
    keep = projmod.load(pdir)["cut"]["keep"]

    def ctx_with(sfx_list):
        proj = projmod.load(pdir)
        proj["sfx"] = sfx_list
        tl = projmod.timeline(pdir, proj, words)
        return render.make_ctx(pdir, proj, tl, True, pdir, pdir / "work" / "render"), tl

    _, tl = ctx_with([])
    out = {w["id"]: tl.word_out_time(w["id"]) for w in words if tl.word_out_time(w["id"]) is not None}
    near = lambda t: min(out, key=lambda wid: abs(out[wid] - t))
    ctx, _ = ctx_with([
        {"at": {"word": removed}, "sound": "pop-plop"},              # its sentence was cut out
        {"at": {"cut": keep[0]["from"]}, "sound": "pop-cartoon"},    # the video's first frame is not a cut
        {"at": {"word": near(0.5)}, "sound": "riser-short"},         # a 1.7 s build from before the start
        {"at": {"cut": keep[2]["from"]}, "sound": "impact-boom"},
        {"at": {"word": near(tl.word_out_time(keep[2]["from"]) + 2.4)}, "sound": "riser-short"},  # builds over the boom
    ])
    placed, left = sfx.plan(ctx)
    assert [p["sound"]["id"] for p in placed] == ["impact-boom"]
    assert sorted(r["sound"] for r in left) == ["pop-cartoon", "pop-plop", "riser-short", "riser-short"]


def test_louder_never_goes_past_the_cap_under_the_voice(tmp_path, take):
    ctx = project(tmp_path, take)
    click = fx.word_near(ctx, 7.5)
    _, _, out = mix(ctx, tmp_path, sfx=[{"at": {"word": fx.word_near(ctx, 5.0)}, "sound": "typing-digital", "gainDb": 12},
                                        {"at": {"word": click}, "sound": "click-tick", "gainDb": 12}])
    voice = music.speech_mask(seconds(out, 0.0, 3.0))[1]
    effect = sfx.peak_loudness(seconds(out, 4.5, 6.0))
    assert voice + sfx.CAP_DB - 1.0 <= effect <= voice + sfx.CAP_DB + 0.5, (effect, voice)
    # a 20 ms click within that loudness would still out-peak the voice and push the limiter down on it
    t = ctx.word_out_time(click)
    voice_peak, click_peak = (float(abs(seconds(out, a, b)).max()) for a, b in ((0.0, 3.0), (t - 0.1, t + 0.2)))
    assert 0 < click_peak <= voice_peak * 10 ** (-sfx.PEAK_UNDER_DB / 20) * 1.06, (click_peak, voice_peak)


def test_an_effect_that_fails_to_mix_is_not_cached_as_mixed(tmp_path, take, monkeypatch):
    ctx = project(tmp_path, take)
    word = fx.word_near(ctx, 5.0)

    def broken(*args):
        raise ValueError("bad decode")
    monkeypatch.setattr(sfx, "track", broken)
    _, failed, _ = mix(ctx, tmp_path, sfx=[{"at": {"word": word}, "sound": "pop-plop"}])
    assert ctx.sfx_mixed is None
    monkeypatch.undo()
    _, fixed, out = mix(ctx, tmp_path, sfx=[{"at": {"word": word}, "sound": "pop-plop"}])
    assert fixed != failed and ctx.sfx_mixed
    assert sfx.peak_loudness(seconds(out, 4.8, 5.4)) > -40


def test_no_effects_leaves_the_mix_as_it_was(tmp_path, take):
    # the mix before sound effects existed: the cut voice, levelled. Any step added to that path
    # (headroom for effects, a second limiter) changes the bytes of every video without effects.
    ctx = project(tmp_path, take)
    voice, out, _ = mix(ctx, tmp_path)
    level, _ = music.normalize(ctx, music.decode(voice, ctx), tmp_path)
    assert out.read_bytes() == music.write_wav(tmp_path / "before.wav", level, ctx=ctx).read_bytes()


def test_every_shipped_sound_is_listed_as_cc0():
    notices = (Path(sfx.PACK_DIR).parents[1] / "THIRD_PARTY.md").read_text(encoding="utf-8")
    rows = {m.group(1): m.group(0) for m in re.finditer(r"^\| `sfx/([a-z0-9-]+\.opus)` \|.*$", notices, re.M)}
    pack = json.loads((Path(sfx.PACK_DIR) / "pack.json").read_text(encoding="utf-8"))["sounds"]
    assert sorted(p.name for p in Path(sfx.PACK_DIR).glob("*.opus")) == sorted(s["file"] for s in pack)
    for s in pack:
        row = rows.get(s["file"])
        assert row and "| CC0 1.0 |" in row and s["source"] in row, s["file"]

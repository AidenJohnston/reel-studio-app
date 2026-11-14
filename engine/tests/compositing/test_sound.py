"""The music and voice moments in the final mix, measured in the audio: the song enters on its attack,
drops out for a named line and comes back on a beat, the last word gets a reverb throw, and the same
project mixes to the same samples every time."""
import hashlib
import json
import subprocess

from pathlib import Path

import numpy as np
import pytest

from reelengine import beats, music, project as projmod, render

from . import fixtures as fx

FPS = 30
KICK_AT, PERIOD = 0.25, 0.5          # the generated song's first kick, and its beat


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    """A 10 s take that talks over [0.4, 2.0] and [3.0, 4.6] s and is silent after, and a 40 s song:
    a soft chord pad from the first sample and a kick every 0.5 s from 0.25 s (so its attack is not its
    start). The kick stands well over the pad, as a drum does in a mix: with a loud pad the chords'
    beating pulls the tempo tracker's phase off the kicks."""
    d = tmp_path_factory.mktemp("sound")
    take = d / "take.mov"
    af = ("anoisesrc=d=10:c=pink:r=48000:a=0.3:seed=3,"
          "volume='if(between(t,0.4,2.0)+between(t,3.0,4.6),1,0)':eval=frame")
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=270x480:r=30:d=10",
                    "-f", "lavfi", "-i", af, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "pcm_s16le", "-shortest", str(take)], check=True)
    song = d / "song.wav"
    kick = f"0.9*sin(2*PI*60*t)*exp(-30*mod(t-{KICK_AT},{PERIOD}))*gte(t,{KICK_AT})"
    pad = "0.06*sin(2*PI*220*t)+0.05*sin(2*PI*277*t)+0.05*sin(2*PI*330*t)"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"aevalsrc='{pad}+{kick}':s=48000:d=40",
                    "-ac", "2", str(song)], check=True)
    return {"take": take, "song": song, "analysis": music.analyze_track(song)}


def kicks(until=40.0):
    return np.arange(KICK_AT, until, PERIOD)


def test_the_song_starts_on_its_attack_and_its_beats_sit_on_the_kicks(media):
    a = media["analysis"]
    # the pad sounds from 0 s; the first hit is the kick at 0.25 s, less a 3 ms pre-roll
    assert a["suggestedStartAt"] == pytest.approx(KICK_AT - music.ATTACK_PREROLL, abs=0.012)
    assert a["bpm"] == pytest.approx(120, abs=1.5)
    for b in a["beats"][:40]:
        assert np.min(np.abs(kicks() - b)) <= 0.012, b


def project(tmp_path, media, keep=((0.05, 9.5),), words=None, cut_keep=None, **fields):
    """A real render timeline and ctx (so drops and the throw see the cut the renderer plays). `words`:
    a transcript to use instead of the fixture's evenly spaced one, all of it kept unless `cut_keep`
    gives the ranges."""
    pdir = tmp_path / "proj"
    fx.make_project(pdir, media["take"], keep=keep)
    (pdir / "media" / "song.wav").write_bytes(media["song"].read_bytes())
    proj = projmod.load(pdir)
    if words:
        (pdir / "work" / "transcript.json").write_text(json.dumps({"words": words}), encoding="utf-8")
        proj["cut"]["keep"] = cut_keep or [{"from": words[0]["id"], "to": words[-1]["id"]}]
    proj.update(fields)
    (pdir / "project.json").write_text(json.dumps(proj), encoding="utf-8")
    words = projmod.load_transcript(pdir, proj)["words"]
    tl = projmod.timeline(pdir, proj, words, root=pdir)
    return render.make_ctx(pdir, proj, tl, True, pdir, pdir / "work" / "render")


def song(media, **extra):
    a = media["analysis"]
    return {"enabled": True, "track": "media/song.wav", "startAt": a["suggestedStartAt"], "level": "under-voice",
            "automation": [], "fadeOut": 0.3, "beats": grid_of(media), **extra}


def grid_of(media):
    a = media["analysis"]
    return beats.quantise(a["beats"], FPS, a["duration"], beats.file_sha256(media["song"]))


def mixed(ctx, tmp_path, name="voice.wav"):
    voice = fx.cut_voice(ctx, tmp_path / name)
    out = music.build_audio(ctx, voice)
    return music.decode(out, ctx), json.loads(out.with_suffix(".json").read_text())    # mix-<sig>.json, beside the mix


def on_grid(t, ctx):
    grid = beats.output_grid(ctx.project, ctx.project_dir / "media" / "song.wav")
    return min(abs(b - t) for b in grid) < 1e-3


def rms_db(x, a, b):
    seg = x[int(a * music.SR): int(b * music.SR)]
    return 10 * np.log10(max(float(np.mean(seg.astype(np.float64) ** 2)), 1e-14))


def test_with_no_fade_in_the_first_frame_hits(tmp_path, media):
    # Fails if suggestedStartAt is not on the song's attack. The default fade-in stays 0.6 s on
    # release/0.2.0 (the Sound tab shows and sets it), so this asks for none.
    ctx = project(tmp_path, media, music=song(media, fadeIn=0))
    x, _ = mixed(ctx, tmp_path)
    # the take is silent for its first 0.35 s, so this is the music alone: the kick on the first frame
    # is louder than the pad a fifth of a second later. A 0.6 s fade-in is ~25 dB down here.
    assert rms_db(x, 0.0, 0.03) > rms_db(x, 0.20, 0.23) + 3


def test_a_drop_silences_the_line_and_the_music_comes_back_on_a_beat(tmp_path, media):
    ctx = project(tmp_path, media)
    line = fx.word_near(ctx, 6.4), fx.word_near(ctx, 7.2)       # in the take's silence: music alone
    ctx = project(tmp_path, media, music=song(media, drops=[{"from": line[0], "to": line[1]}]))
    x, rep = mixed(ctx, tmp_path)
    (drop,) = rep["music"]["drops"]
    assert drop["out"] == pytest.approx(round((ctx.word_out_time(line[0]) - music.DROP_LEAD) * FPS) / FPS)
    assert drop["onBeat"] and on_grid(drop["back"], ctx)
    assert drop["back"] >= ctx.word_out_end(line[1])
    assert rms_db(x, drop["out"] + 0.01, drop["back"] - 0.01) < -90             # silent through the line
    assert rms_db(x, drop["back"] + 0.006, drop["back"] + 0.05) > -40           # back at full level
    assert rms_db(x, drop["out"] - 0.2, drop["out"] - 0.01) > -40               # and playing before it
    # the song kept running underneath: it comes back on a kick (to the frame the grid is stored in)
    t_song = drop["back"] + ctx.project["music"]["startAt"]
    assert np.min(np.abs(kicks() - t_song)) <= 1 / FPS


def test_a_start_too_near_the_songs_end_starts_it_from_the_top_for_the_mix_and_the_beats_alike(tmp_path, media):
    ctx = project(tmp_path, media)
    line = fx.word_near(ctx, 6.4), fx.word_near(ctx, 7.2)
    near_end = media["analysis"]["duration"] - 0.5
    ctx = project(tmp_path, media, music=song(media, startAt=near_end, drops=[{"from": line[0], "to": line[1]}]))
    x, rep = mixed(ctx, tmp_path)
    assert rep["music"]["startAt"] == 0.0                     # the mixer played the song from the top...
    (drop,) = rep["music"]["drops"]
    assert drop["onBeat"]
    # ...and the beat the music comes back on is a kick of the song as it plays from the top
    assert np.min(np.abs(kicks() - drop["back"])) <= 1 / FPS
    assert rms_db(x, drop["back"] + 0.006, drop["back"] + 0.05) > -40


def test_the_reverb_throw_rings_out_after_the_last_word(tmp_path, media):
    # four words over the take's first stretch of talk, which stops at 2.0 s; the cut keeps 0.35 s after
    words = [{"id": f"w{i}", "source": "s1", "s": round(0.45 + 0.4 * i, 3), "e": round(0.75 + 0.4 * i, 3),
              "w": f"word{i}"} for i in range(3)] + [{"id": "w3", "source": "s1", "s": 1.65, "e": 2.0, "w": "end"}]
    plain = project(tmp_path / "a", media, words=words)
    thrown = project(tmp_path / "b", media, words=words, voice={"reverbThrow": True})
    dry, _ = mixed(plain, tmp_path / "a")
    wet, rep = mixed(thrown, tmp_path / "b")
    t = rep["reverbThrow"]
    last = projmod.load_transcript(thrown.project_dir, thrown.project)["words"]
    assert t["word"] == max((w["id"] for w in last if thrown.is_kept(w["id"])), key=thrown.word_out_end)
    end = thrown.word_out_end(t["word"])
    # the send is the last word, or its final THROW_S when it is longer
    assert t["from"] == pytest.approx(max(thrown.word_out_time(t["word"]), end - music.THROW_S), abs=0.01)
    # after the voice stops there is a tail with the throw, near silence without it
    tail = (end + 0.03, thrown.duration - music.THROW_END_FADE)      # output clock: the voice stops at `end`
    assert rms_db(dry, *tail) < -80
    assert rms_db(wet, *tail) > -45
    # it is a tail under the voice, not a second voice: quieter than the words it echoes
    assert rms_db(wet, *tail) < rms_db(wet, end - 0.5, end) - 6
    # and the voice before the throw is untouched (the same samples, up to the loudness pass's gain)
    a, b = int(0.5 * music.SR), int((t["from"] - 0.05) * music.SR)
    g = float(np.dot(wet[a:b, 0], dry[a:b, 0]) / np.dot(dry[a:b, 0], dry[a:b, 0]))
    assert np.max(np.abs(wet[a:b] - g * dry[a:b])) < 2e-3


def test_the_same_project_mixes_to_the_same_samples(tmp_path, media):
    keep = ((0.05, 4.2), (6.0, 9.5))
    cut_at = project(tmp_path / "plain", media, keep=keep).out_timeline[-1].out_start
    # start the song so one of its beats falls a frame before the jump cut: within the cut's reach
    grid = grid_of(media)["frames"]
    start = next(f for f in grid if f / FPS > cut_at + 1) / FPS - (cut_at - 1 / FPS)

    def once(sub):
        ctx = project(tmp_path / sub, media, keep=keep,
                      music=song(media, startAt=start, onBeat=["cuts"]), voice={"reverbThrow": True},
                      sfx=[{"at": {"word": "w3"}, "sound": "pop-plop"}])
        x, rep = mixed(ctx, tmp_path / sub)
        return ctx, x, rep
    c1, x1, r1 = once("a")
    c2, x2, r2 = once("b")
    assert [(s.src_start, s.src_end, s.out_start) for s in c1.out_timeline] == \
        [(s.src_start, s.src_end, s.out_start) for s in c2.out_timeline]
    # the jump cut moved onto the beat
    assert c1.out_timeline[-1].out_start == pytest.approx(cut_at - 1 / FPS, abs=1e-5)
    assert on_grid(c1.out_timeline[-1].out_start, c1)
    assert np.array_equal(x1, x2)
    md5 = [hashlib.md5(Path(r["file"]).read_bytes()).hexdigest() for r in (r1, r2)]
    assert md5[0] == md5[1]
    assert r1["sfx"] == r2["sfx"] and r1["reverbThrow"] == r2["reverbThrow"]


def test_the_throw_lands_on_the_videos_last_word_when_that_word_also_plays_earlier(tmp_path, media):
    # the last kept range repeats words from the first (the same take used twice), and the final word's
    # text is said twice: the echo belongs at the end of the video, not on the word's first appearance
    words = [{"id": f"w{i}", "source": "s1", "s": round(0.45 + 0.4 * i, 3), "e": round(0.75 + 0.4 * i, 3),
              "w": "end" if i in (1, 3) else f"word{i}"} for i in range(4)]
    ctx = project(tmp_path, media, words=words, cut_keep=[{"from": "w0", "to": "w3"}, {"from": "w2", "to": "w3"}],
                  voice={"reverbThrow": True})
    wid, ws, we = music.final_word(ctx)
    last = ctx.out_timeline[-1]
    assert wid == "w3" and ws >= last.out_start and we == pytest.approx(last.out_start + words[3]["e"] - last.src_start)
    _, rep = mixed(ctx, tmp_path)
    assert rep["reverbThrow"]["word"] == "w3"
    assert rep["reverbThrow"]["from"] == pytest.approx(max(ws, we - music.THROW_S), abs=0.001)
    assert rep["reverbThrow"]["from"] > ctx.word_out_end("w3")       # past the word's first appearance


def test_the_throw_is_the_same_whatever_else_the_voice_holds(tmp_path, media):
    """A preview window, or an earlier edit, changes the rest of the voice track: the tail must not move."""
    words = [{"id": f"w{i}", "source": "s1", "s": round(0.45 + 0.4 * i, 3), "e": round(0.75 + 0.4 * i, 3),
              "w": f"word{i}"} for i in range(4)]
    ctx = project(tmp_path, media, words=words, voice={"reverbThrow": True})
    voice = music.decode(fx.cut_voice(ctx, tmp_path / "voice.wav"), ctx)
    full, _ = music.reverb_throw(ctx, voice)
    k = int(0.8 * music.SR)                                  # a window that starts 0.8 s in
    win, _ = music.reverb_throw(ctx, voice[k:], offset=k / music.SR)
    loud_start = voice.copy()
    loud_start[:k] *= 8                                      # an earlier part of the voice, much louder
    louder, _ = music.reverb_throw(ctx, loud_start)
    digest = lambda x: hashlib.md5(np.ascontiguousarray(x).tobytes()).hexdigest()   # noqa: E731
    assert digest(full[k:]) == digest(win) == digest(louder[k:])
    assert np.abs(full).max() > 0

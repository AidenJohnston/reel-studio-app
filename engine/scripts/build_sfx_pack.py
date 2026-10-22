"""Rebuild engine/reelengine/sfx/ (the bundled sound effects) from their CC0 sources.

    REELENGINE_FFMPEG=<the app's ffmpeg> python engine/scripts/build_sfx_pack.py --encoder <ffmpeg with libopus>

Each source is downloaded, checked against its pinned SHA-256 and its licence (the CC0 deed on its
Freesound page, or the CC0 notice in the Kenney pack), cut to the part that sounds, levelled so its
loudest 400 ms reads LOUDNESS (or lower, when a sharp click would pass PEAK_DBTP first) and written
as 48 kHz Opus. The app's ffmpeg build decodes Opus but has no encoder for it, hence --encoder.

Then every written file is decoded the way the engine decodes it and measured, so pack.json describes
the files that ship:
  * onsetMs: sfx.hit_offset, where the sound rises to within 6 dB of its peak and stays there
  * loudness: sfx.peak_loudness, the loudest 400 ms (LUFS)
  * energy 1-3: how long the sound holds its peak, as its K-weighted energy over the power of its
    loudest 50 ms, in seconds. Measured on this pack: clicks, pops and quick whooshes hold under
    0.1 s (1), short swells under 0.3 s (2), booms, long risers and long whooshes longer (3).
engine/THIRD_PARTY.md lists every sound; a test fails when a sound in pack.json has no CC0 row there.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reelengine import music, sfx  # noqa: E402

OUT = Path(sfx.PACK_DIR)
LOUDNESS = -20.0
PEAK_DBTP = -1.0
ENERGY_STEPS = (0.1, 0.3)
CC0_DEED = "creativecommons.org/publicdomain/zero/1.0"
UA = {"User-Agent": "reelstudio-sfx-pack-build"}

KENNEY = {
    "interface-sounds": ("https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
                         "f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232"),
    "ui-audio": ("https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip",
                 "946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6"),
    "impact-sounds": ("https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip",
                      "029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8"),
    "sci-fi-sounds": ("https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip",
                      "119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04"),
}

# (id, job, source, trim): source is ("kenney", pack, member) or ("freesound", sound id, preview url, sha256);
# trim (start, seconds, fade-out seconds) keeps the useful part of a long recording.
SOUNDS = [
    ("whoosh-quick", "whoosh", ("freesound", 60013, "https://cdn.freesound.org/previews/60/60013_71257-hq.ogg", "eb8ac4dc0345f6d608dd96e517f27001e8f3ada58cca9b680f87409a3197c814"), None),
    ("whoosh-snap", "whoosh", ("freesound", 59988, "https://cdn.freesound.org/previews/59/59988_71257-hq.ogg", "5a6922ba701fa187fa035d740b6ef0a67356d828cc70ce0eb3b665b44c21d124"), None),
    ("whoosh-soft", "whoosh", ("freesound", 585257, "https://cdn.freesound.org/previews/585/585257_4530936-hq.ogg", "50dacc6f5e426f790cd98fba2274851d8ede612fcce4a887c4d04ddd90b3395a"), None),
    ("whoosh-double", "whoosh", ("freesound", 19312, "https://cdn.freesound.org/previews/19/19312_84709-hq.ogg", "e840b0b3fbf8a7496a5928015ef2c5ce5491746dd778a1da978c6f33d9f1a260"), None),
    ("whoosh-chop", "whoosh", ("freesound", 127197, "https://cdn.freesound.org/previews/127/127197_162543-hq.ogg", "97bc4782e2ac27cff6a52e952c44c4d733ff04864a4f9da3e4b84b5d6ae511fd"), None),
    ("whoosh-air", "whoosh", ("freesound", 243400, "https://cdn.freesound.org/previews/243/243400_4146245-hq.ogg", "78cb1897ee8507f5f8200bb445ab1b271ef720361ca3e83665c32ed15063e802"), None),
    ("whoosh-wide", "whoosh", ("freesound", 683096, "https://cdn.freesound.org/previews/683/683096_6253486-hq.ogg", "c8bae389d52a6cb7827b7980ff8b45f6b4389ace33a94ae9e317f5fb2fe387e3"), None),
    ("whoosh-sweep", "whoosh", ("freesound", 683101, "https://cdn.freesound.org/previews/683/683101_6253486-hq.ogg", "013fd2d67a8e9b8fffbe07eb9f3842a45314e36aca67fffa3e71a9c753dd0903"), None),
    ("pop-soft", "pop", ("freesound", 202230, "https://cdn.freesound.org/previews/202/202230_3725006-hq.ogg", "c35ff2504093cb85c12cd2e38cec366c659fc38572de89c74991e261b29b11f3"), None),
    ("pop-cartoon", "pop", ("freesound", 245646, "https://cdn.freesound.org/previews/245/245646_1038806-hq.ogg", "6008282a6121c773ac810263a6343e14228ad2800668ea014f6c61ee8913f2e1"), None),
    ("pop-plop", "pop", ("freesound", 447910, "https://cdn.freesound.org/previews/447/447910_9159316-hq.ogg", "b302dc6274bb6a9d9cafb96920706d688e29bbc4dfaae722b4d93a73754be873"), None),
    ("pop-pluck", "pop", ("kenney", "interface-sounds", "Audio/pluck_001.ogg"), None),
    ("pop-drop", "pop", ("kenney", "interface-sounds", "Audio/drop_002.ogg"), None),
    ("click-mouse", "click", ("kenney", "ui-audio", "Audio/mouseclick1.ogg"), None),
    ("click-soft", "click", ("kenney", "ui-audio", "Audio/click2.ogg"), None),
    ("click-bright", "click", ("kenney", "ui-audio", "Audio/click4.ogg"), None),
    ("click-tick", "click", ("kenney", "interface-sounds", "Audio/tick_002.ogg"), None),
    ("click-select", "click", ("kenney", "interface-sounds", "Audio/select_001.ogg"), None),
    ("riser-short", "riser", ("freesound", 561207, "https://cdn.freesound.org/previews/561/561207_10825267-hq.ogg", "253d731e56a55c83884a9ea39b9aa880ce67ed008d567bca8a2d80ce7421b26b"), None),
    ("riser-synth", "riser", ("freesound", 685256, "https://cdn.freesound.org/previews/685/685256_12265588-hq.ogg", "c262f8d42fce705493e047028e2fed92967f900a0b63e8a6d2b82fd5acc1bb40"), None),
    ("riser-subtle", "riser", ("freesound", 859482, "https://cdn.freesound.org/previews/859/859482_18689440-hq.ogg", "ba093c861cb07c8c89e27b139ed23fc4e44c7f1ee3273137ea583f0a1384fcc9"), None),
    ("riser-cymbal", "riser", ("freesound", 774635, "https://cdn.freesound.org/previews/774/774635_16682330-hq.ogg", "0451d62b182b85010d80e13ec5d807cddee5d1d6e75d73f09ae4f962271d53b6"), None),
    ("impact-boom", "impact", ("freesound", 430977, "https://cdn.freesound.org/previews/430/430977_8698658-hq.ogg", "9d9eac91900234b5b2e94209416d8762e7747147f5cc4b5ee271529d6c8b4145"), (0.0, 2.5, 0.8)),
    ("impact-subdrop", "impact", ("freesound", 428073, "https://cdn.freesound.org/previews/428/428073_4067257-hq.ogg", "89791df3dadb4702b7919df233151894823afe9bd663a8b76ea4087881f9c50d"), (0.0, 2.2, 0.8)),
    ("impact-hit", "impact", ("freesound", 222517, "https://cdn.freesound.org/previews/222/222517_71257-hq.ogg", "663e3b0213daab49eac32abd19f08a13bb014a1e3335998a6ca964267fb36035"), (0.0, 2.5, 0.8)),
    ("impact-punch", "impact", ("kenney", "impact-sounds", "Audio/impactPunch_heavy_000.ogg"), None),
    ("impact-thud", "impact", ("kenney", "impact-sounds", "Audio/impactSoft_heavy_000.ogg"), None),
    ("impact-low", "impact", ("kenney", "sci-fi-sounds", "Audio/lowFrequency_explosion_001.ogg"), None),
    ("ding-correct", "ding", ("freesound", 243701, "https://cdn.freesound.org/previews/243/243701_3752922-hq.ogg", "f4304d17ce11720f114243639199af0dfda38be230f35093b9ba38c45e4e8460"), None),
    ("ding-bright", "ding", ("freesound", 335908, "https://cdn.freesound.org/previews/335/335908_5865517-hq.ogg", "c50c221301552f14efce78f9f6a9fb1a622921b186434de1ffbbaeeb5aa79163"), None),
    ("ding-ting", "ding", ("freesound", 174027, "https://cdn.freesound.org/previews/174/174027_3242494-hq.ogg", "49c18f8c9da6ec56337d6900ef891295b92c95d160814a3754c08ef268b199dd"), None),
    ("ding-idea", "ding", ("freesound", 407258, "https://cdn.freesound.org/previews/407/407258_7941603-hq.ogg", "0d6c65de5d7770f40a0facbab6b8189474803557222a9b8186080cf1be2b639e"), (0.6, 2.0, 0.6)),
    ("ding-glass", "ding", ("kenney", "interface-sounds", "Audio/glass_004.ogg"), None),
    ("typing-keys", "typing", ("freesound", 447909, "https://cdn.freesound.org/previews/447/447909_9159316-hq.ogg", "822f82f785153e7ffbc216f4ade65a15c5c4203ef68acb72f44c983cdb70c229"), (0.0, 1.6, 0.15)),
    ("typing-mech", "typing", ("freesound", 348239, "https://cdn.freesound.org/previews/348/348239_4067257-hq.ogg", "9632368364864a84b4504f6e4345192b206f7d1f4a0857c1cdcbee3043019b59"), None),
    ("typing-digital", "typing", ("freesound", 416777, "https://cdn.freesound.org/previews/416/416777_7935195-hq.ogg", "745744d167cbe4fbb82c167f6cc7d8cc899ffa25ae2f703f461fe08f7a718477"), None),
    ("typing-key", "typing", ("freesound", 194799, "https://cdn.freesound.org/previews/194/194799_670763-hq.ogg", "8dfce404055a6495838124bfa502953f6309ddd96ebab803306a6473c3c14e8f"), None),
]


def fetch(url: str, sha256: str, cache: Path) -> bytes:
    f = cache / sha256
    if not f.exists():
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
            f.write_bytes(r.read())
    data = f.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        f.unlink()
        sys.exit(f"{url}: sha256 {got}, expected {sha256}")
    return data


def fetch_source(src: tuple, cache: Path, tmp: Path) -> tuple[Path, str]:
    """(downloaded file, the page that states its licence) after checking that licence is CC0."""
    if src[0] == "kenney":
        url, sha = KENNEY[src[1]]
        z = zipfile.ZipFile(io.BytesIO(fetch(url, sha, cache)))
        if "Creative Commons Zero, CC0" not in z.read("License.txt").decode("utf-8", "replace"):
            sys.exit(f"kenney {src[1]}: License.txt is not CC0")
        out = tmp / f"kenney-{src[1]}-{Path(src[2]).name}"
        out.write_bytes(z.read(src[2]))
        return out, f"https://kenney.nl/assets/{src[1]}"
    _, sid, url, sha = src
    page = f"https://freesound.org/s/{sid}/"
    with urllib.request.urlopen(urllib.request.Request(page, headers=UA), timeout=60) as r:
        page, html = r.geturl(), r.read().decode("utf-8", "replace")
    if CC0_DEED not in html:
        sys.exit(f"freesound {sid}: the page does not show the CC0 deed")
    out = tmp / f"freesound-{sid}.ogg"
    out.write_bytes(fetch(url, sha, cache))
    return out, page


def tighten(x: np.ndarray) -> np.ndarray:
    """Drop the silence before the first sound and after the last (with short fades at the new edges)."""
    p = (x.astype(np.float64) ** 2).sum(axis=1)
    h = int(0.005 * music.SR)
    env = 10 * np.log10(np.maximum(np.add.reduceat(p, np.arange(0, len(p), h)) / h, 1e-12))
    loud = np.flatnonzero(env >= env.max() - 50)
    a = max(0, loud[0] * h - h)
    b = min(len(x), (np.flatnonzero(env >= env.max() - 60)[-1] + 2) * h)
    y = x[a:b].copy()
    if a > 0:
        n = min(len(y), int(0.003 * music.SR))
        y[:n] *= np.linspace(0, 1, n, dtype=np.float32)[:, None]
    n = min(len(y), int(0.020 * music.SR))
    y[len(y) - n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
    return y


def trim_to(x: np.ndarray, trim) -> np.ndarray:
    start, dur, fade = trim
    y = x[int(start * music.SR): int((start + dur) * music.SR)].copy()
    n = int(fade * music.SR)
    y[len(y) - n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
    return y


def encode(encoder: str, x: np.ndarray, out: Path) -> None:
    mono = float(np.abs(x[:, 0] - x[:, 1]).max()) < 1e-4
    y = x[:, :1] if mono else x
    subprocess.run([encoder, "-y", "-v", "error", "-nostdin", "-f", "f32le", "-ar", str(music.SR), "-ac", str(y.shape[1]),
                    "-i", "-", "-c:a", "libopus", "-b:a", "64k" if mono else "96k", "-vbr", "on",
                    "-application", "audio", "-map_metadata", "-1", "-fflags", "+bitexact", str(out)],
                   input=np.ascontiguousarray(y, np.float32).tobytes(), check=True)


def energy(x: np.ndarray) -> tuple[int, float]:
    pad = int(0.05 * music.SR)
    x = np.pad(x, ((pad, pad), (0, 0)))
    total = float((music._k_weight(x, music.SR).astype(np.float64) ** 2).sum()) / music.SR
    seconds = total / float(music.block_power(x, music.SR, 0.05, 0.005).max())
    return 1 + sum(seconds >= s for s in ENERGY_STEPS), seconds


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoder", required=True, help="an ffmpeg with libopus")
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "reelstudio-sfx-sources"))
    args = ap.parse_args()
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    sounds = []
    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as built:
        for sid, job, src, trim in SOUNDS:
            path, page = fetch_source(src, cache, Path(td))
            x = music.decode(path)
            x = trim_to(x, trim) if trim else x
            x = tighten(x)
            gain = LOUDNESS - sfx.peak_loudness(x)
            over = music.true_peak_db(x * np.float32(10 ** (gain / 20))) - PEAK_DBTP
            if over > 0:
                gain -= over
            out = Path(built) / f"{sid}.opus"
            encode(args.encoder, x * np.float32(10 ** (gain / 20)), out)
            y = music.decode(out)
            level, held = energy(y)
            sounds.append({"id": sid, "job": job, "file": out.name, "seconds": round(len(y) / music.SR, 3),
                           "onsetMs": round(sfx.hit_offset(y) * 1000), "loudness": round(sfx.peak_loudness(y), 2),
                           "energy": level, "source": page})
            print(f"{sid:<16} {sounds[-1]['seconds']:5.2f}s onset {sounds[-1]['onsetMs']:5d} ms "
                  f"loudness {sounds[-1]['loudness']:6.1f} held {held:5.2f}s energy {level} {out.stat().st_size // 1024} KB")
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.opus"):
            old.unlink()
        for f in Path(built).glob("*.opus"):
            f.replace(OUT / f.name)
    (OUT / "pack.json").write_text(json.dumps({"version": 1, "sounds": sounds}, indent=1) + "\n", encoding="utf-8")
    print(f"{len(sounds)} sounds, {sum(f.stat().st_size for f in OUT.glob('*.opus')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

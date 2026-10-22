# Third-party components shipped with the Reel Studio engine

Reel Studio is MIT-licensed. Everything below is redistributed under its own license. Packaging
(`packaging/`) must copy this file plus the license files named here into the app bundle.

## Bundled in the `reelengine` package

| Component | Files | License | Notes |
|---|---|---|---|
| YuNet face detector (OpenCV Model Zoo, `face_detection_yunet_2023mar`) | `reelengine/models/face_detection_yunet_2023mar.onnx` | MIT, (c) Shiqi Yu et al. | Unmodified. sha256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`. Source + license: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet . MIT allows redistribution in an MIT app with the notice kept (`models/README.md`). |
| Montserrat (SemiBold, variable) | `reelengine/fonts/Montserrat-*.ttf` | SIL OFL 1.1 | `fonts/OFL-Montserrat.txt` |
| Inter (Regular, Medium, SemiBold, Bold) | `reelengine/fonts/Inter_*.ttf` | SIL OFL 1.1 | `fonts/OFL-Inter.txt` |
| Fraunces (SemiBold, Bold) | `reelengine/fonts/Fraunces_*.ttf` | SIL OFL 1.1 | `fonts/OFL-Fraunces.txt` |
| Roboto (Regular, Medium, Bold) v2.001047 | `reelengine/fonts/Roboto-*.ttf` | Apache 2.0 | `fonts/LICENSE-Roboto-Apache-2.0.txt` |

OFL fonts may be bundled with software; they may not be sold on their own and keep their names.
Licenses were read from each font's own `name` table (IDs 0, 13, 14), not assumed.

## Sound effects (`reelengine/sfx/`)

Every sound effect is dedicated to the public domain under CC0 1.0, so none needs a credit; the
authors are listed anyway. `engine/scripts/build_sfx_pack.py` rebuilds the files from these
sources: it pins each download's SHA-256, refuses a Freesound sound whose page does not show the CC0
deed or a Kenney pack whose `License.txt` is not CC0, and keeps each source's job and measured
onset, loudness and energy in `sfx/pack.json`. Freesound sounds come from the site's high-quality
previews; all were trimmed, levelled and re-encoded as Opus. Licences checked on 2026-10-22.

| File | Job | Source | Author | License | Page |
|---|---|---|---|---|---|
| `sfx/whoosh-quick.opus` | whoosh | Freesound #60013 "Whoosh" | qubodup | CC0 1.0 | https://freesound.org/people/qubodup/sounds/60013/ |
| `sfx/whoosh-snap.opus` | whoosh | Freesound #59988 "SWOSH-01 44.1kHz" | qubodup | CC0 1.0 | https://freesound.org/people/qubodup/sounds/59988/ |
| `sfx/whoosh-soft.opus` | whoosh | Freesound #585257 "swoosh-1.mp3" | lesaucisson | CC0 1.0 | https://freesound.org/people/lesaucisson/sounds/585257/ |
| `sfx/whoosh-double.opus` | whoosh | Freesound #19312 "classic double swwosh .wav" | martian | CC0 1.0 | https://freesound.org/people/martian/sounds/19312/ |
| `sfx/whoosh-chop.opus` | whoosh | Freesound #127197 "fast simple chop 5.aif" | dave.des | CC0 1.0 | https://freesound.org/people/dave.des/sounds/127197/ |
| `sfx/whoosh-air.opus` | whoosh | Freesound #243400 "woosh.wav" | freakinbehemoth | CC0 1.0 | https://freesound.org/people/freakinbehemoth/sounds/243400/ |
| `sfx/whoosh-wide.opus` | whoosh | Freesound #683096 "Woosh" | florianreichelt | CC0 1.0 | https://freesound.org/people/florianreichelt/sounds/683096/ |
| `sfx/whoosh-sweep.opus` | whoosh | Freesound #683101 "quick woosh" | florianreichelt | CC0 1.0 | https://freesound.org/people/florianreichelt/sounds/683101/ |
| `sfx/pop-soft.opus` | pop | Freesound #202230 "Pop sound" | deraj | CC0 1.0 | https://freesound.org/people/deraj/sounds/202230/ |
| `sfx/pop-cartoon.opus` | pop | Freesound #245646 "Cartoon Pop (Distorted)" | unfa | CC0 1.0 | https://freesound.org/people/unfa/sounds/245646/ |
| `sfx/pop-plop.opus` | pop | Freesound #447910 "Plop!" | Breviceps | CC0 1.0 | https://freesound.org/people/Breviceps/sounds/447910/ |
| `sfx/pop-pluck.opus` | pop | Kenney "Interface Sounds" pack, `pluck_001.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `sfx/pop-drop.opus` | pop | Kenney "Interface Sounds" pack, `drop_002.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `sfx/click-mouse.opus` | click | Kenney "Ui Audio" pack, `mouseclick1.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/ui-audio |
| `sfx/click-soft.opus` | click | Kenney "Ui Audio" pack, `click2.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/ui-audio |
| `sfx/click-bright.opus` | click | Kenney "Ui Audio" pack, `click4.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/ui-audio |
| `sfx/click-tick.opus` | click | Kenney "Interface Sounds" pack, `tick_002.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `sfx/click-select.opus` | click | Kenney "Interface Sounds" pack, `select_001.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `sfx/riser-short.opus` | riser | Freesound #561207 "Riser" | Rizzard | CC0 1.0 | https://freesound.org/people/Rizzard/sounds/561207/ |
| `sfx/riser-synth.opus` | riser | Freesound #685256 "Riser sound effect short.wav" | syntheffects | CC0 1.0 | https://freesound.org/people/syntheffects/sounds/685256/ |
| `sfx/riser-subtle.opus` | riser | Freesound #859482 "Cinematic Riser #3 subtle" | BeaconStudio | CC0 1.0 | https://freesound.org/people/BeaconStudio/sounds/859482/ |
| `sfx/riser-cymbal.opus` | riser | Freesound #774635 "Reverse Cymbal Shiny" | loganzsound | CC0 1.0 | https://freesound.org/people/loganzsound/sounds/774635/ |
| `sfx/impact-boom.opus` | impact | Freesound #430977 "Big impact.wav" | AudioPapkin | CC0 1.0 | https://freesound.org/people/AudioPapkin/sounds/430977/ |
| `sfx/impact-subdrop.opus` | impact | Freesound #428073 "Sub Drop Smooth.wav" | newagesoup | CC0 1.0 | https://freesound.org/people/newagesoup/sounds/428073/ |
| `sfx/impact-hit.opus` | impact | Freesound #222517 "Dramatic Hit" | qubodup | CC0 1.0 | https://freesound.org/people/qubodup/sounds/222517/ |
| `sfx/impact-punch.opus` | impact | Kenney "Impact Sounds" pack, `impactPunch_heavy_000.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/impact-sounds |
| `sfx/impact-thud.opus` | impact | Kenney "Impact Sounds" pack, `impactSoft_heavy_000.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/impact-sounds |
| `sfx/impact-low.opus` | impact | Kenney "Sci Fi Sounds" pack, `lowFrequency_explosion_001.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/sci-fi-sounds |
| `sfx/ding-correct.opus` | ding | Freesound #243701 "correct" | ertfelda | CC0 1.0 | https://freesound.org/people/ertfelda/sounds/243701/ |
| `sfx/ding-bright.opus` | ding | Freesound #335908 "Correct.mp3" | LittleRainySeasons | CC0 1.0 | https://freesound.org/people/LittleRainySeasons/sounds/335908/ |
| `sfx/ding-ting.opus` | ding | Freesound #174027 "News Ting" | robni7 | CC0 1.0 | https://freesound.org/people/robni7/sounds/174027/ |
| `sfx/ding-idea.opus` | ding | Freesound #407258 "Ding! idea.mp3" | Saya13 | CC0 1.0 | https://freesound.org/people/Saya13/sounds/407258/ |
| `sfx/ding-glass.opus` | ding | Kenney "Interface Sounds" pack, `glass_004.ogg` | Kenney (kenney.nl) | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `sfx/typing-keys.opus` | typing | Freesound #447909 "Keyboard typing" | Breviceps | CC0 1.0 | https://freesound.org/people/Breviceps/sounds/447909/ |
| `sfx/typing-mech.opus` | typing | Freesound #348239 "MECH-KEYBOARD-01.wav" | newagesoup | CC0 1.0 | https://freesound.org/people/newagesoup/sounds/348239/ |
| `sfx/typing-digital.opus` | typing | Freesound #416777 "digital_typing.wav" | Sky_Motion | CC0 1.0 | https://freesound.org/people/Sky_Motion/sounds/416777/ |
| `sfx/typing-key.opus` | typing | Freesound #194799 "keyboard5.wav" | jim-ph | CC0 1.0 | https://freesound.org/people/jim-ph/sounds/194799/ |

## Downloaded at first run (not bundled)

| Component | License | Notes |
|---|---|---|
| Whisper `small.en` (CTranslate2 conversion, `Systran/faster-whisper-small.en`) | MIT (OpenAI Whisper weights; Systran conversion) | `python -m reelengine download-model`, into the app's data folder |

## Python packages (installed from `engine/requirements.txt`)

| Package | License |
|---|---|
| numpy | BSD-3-Clause |
| pillow | MIT-CMU (HPND) |
| opencv-python-headless | Apache 2.0 (OpenCV >= 4.5); wheel bundles FFmpeg (LGPL) |
| faster-whisper | MIT |
| ctranslate2 | MIT |
| onnxruntime | MIT |
| av (PyAV) | BSD-3-Clause; wheel bundles FFmpeg libraries (LGPL 2.1+) |
| tokenizers, huggingface-hub, hf-xet | Apache 2.0 |
| jsonschema, jsonschema-specifications, referencing, attrs, rpds-py | MIT |
| yt-dlp | Unlicense (public domain) |
| tqdm | MPL 2.0 + MIT |
| numpy deps, click, colorama, filelock, fsspec, idna, packaging, pyyaml, protobuf, flatbuffers, anyio, h11, httpx2, httpcore2, truststore, typing-extensions | BSD / MIT / Apache 2.0 / PSF |

The packaging stream should generate the exact list with licenses from the installed runtime
(`pip-licenses --from=mixed --format=markdown`) and attach it here at build time.

**HEIC/HEIF stills:** the installers bundle `pi-heif` (libheif and libde265, LGPL-3.0; see the root
`THIRD_PARTY.md`). A source install without it gets a plain message asking for JPG/PNG. Do not install
`pillow-heif` into the bundle: its binary wheels also contain x265 (GPL 2.0). HEIC decoding involves HEVC,
a patent-encumbered codec; whether to ship it is a legal decision, not a technical one.

## FFmpeg / ffprobe (bundled by packaging, NOT part of this package)

- **Required version: FFmpeg >= 6.1** (7.x recommended). `render` passes `-display_rotation 0` to
  inputs of rotated phone videos; that option does not exist before 6.1, and without it an iPhone
  `.MOV` comes out sideways or double-rotated. `doctor` reports the version.
- Needed filters: `subtitles` (libass), `zscale` (HDR tone mapping, optional), `scale`, `overlay`,
  `tpad`, `loudnorm`/`ebur128`, `alimiter`. Encoders: `libx264`, `aac`; drafts also use
  `h264_videotoolbox` (macOS) / `h264_nvenc` / `h264_amf` / `h264_qsv` (Windows: NVIDIA / AMD / Intel) when the machine has one.
- A static GPL build is fine for an MIT app when shipped as a separate executable the engine runs
  as a subprocess. Ship its `LICENSE` (GPL 2.0+/LGPL) and a link to the exact source of the build
  used. The installers ship Reel Studio's own FFmpeg 7.1.1 build (`packaging/ffmpeg/`, every source pinned in
  `sources.txt`, mirrored by `packaging/mirror_gpl_sources.py`); see the root `THIRD_PARTY.md`.

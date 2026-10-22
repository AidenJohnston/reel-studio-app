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

**Edit import (`reference` extra, not bundled):** `opentimelineio` 0.18.1, `otio-fcpx-xml-adapter` 1.0.0
and `otio-fcp-adapter` 1.0.0 are Apache-2.0. OpenTimelineIO's compiled module also contains Imath
(BSD-3-Clause) and RapidJSON (MIT), but the wheel ships only OpenTimelineIO's own LICENSE and NOTICE.
A bundle that includes it must add those two license texts.

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

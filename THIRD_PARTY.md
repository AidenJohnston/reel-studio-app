# Third-party software in Reel Studio

Reel Studio itself is MIT licensed (see `LICENSE`). The installer also contains the programs below.
Each keeps its own license. This list is what `packaging/fetch_runtime.py` downloads, so the URLs and
SHA-256 values here are the ones the script verifies. If you change one, change the other.

The installed app carries this file and the full license texts under `resources/licenses/`
(`THIRD_PARTY.md`, `texts/gpl-3.0.txt`, `texts/lgpl-3.0.txt`, `texts/lgpl-2.1.txt`, `texts/yunet-MIT.txt`,
`texts/npm-licenses.txt`). `fetch_runtime.py` refuses to build a bundle if any of the texts is missing or altered.

## Bundled programs (downloaded at build time, shipped inside the app)

### FFmpeg and FFprobe (GPL v3), built by this project

Reel Studio runs `ffmpeg` and `ffprobe` as **separate programs** (it starts them as child processes and talks to them
through files and pipes). It does not link against them, so the GPL applies to those two programs only and not to
Reel Studio's own MIT code. The two programs are GPL v3 because they include x264 (GPL-2.0-or-later) and are built
with `--enable-gpl --enable-version3`.

**We build them ourselves**, on both platforms, from pinned source tarballs with a script in this repository
(`packaging/ffmpeg/build.sh`; every source's version, URL and SHA-256 is in `packaging/ffmpeg/sources.txt`). They are
minimal on purpose: only what the engine needs. This replaces the third-party builds used until 2026-10-17 (gyan.dev on
Windows, martin-riedl.de on macOS), whose library versions or build script were not fully public.

| Platform | File (GitHub release tagged `ffmpeg-7.1.1-rs2`) | SHA-256 |
|---|---|---|
| Windows x64 | `ffmpeg-7.1.1-rs2-win-x64.zip` (`ffmpeg.exe`, `ffprobe.exe`, `BUILDINFO.txt`) | `08e0d8ebce07751f2b14de86d0a47594d39564af2439ce79f23121a12ffd2b7f` |
| macOS arm64 | `ffmpeg-7.1.1-rs2-macos-arm64.zip` (`ffmpeg`, `ffprobe`, `BUILDINFO.txt`) | `950d3faa4385a8a4eaa0d92baf8f6c043b8e9207a50a7d24e97935d68033bf45` |

`packaging/fetch_runtime.py` pins those two hashes. The zips are the files `build.sh` writes to `release/ffmpeg/`; the
person publishing a release uploads exactly those to the release (`packaging/ffmpeg/README.md`, "Releasing a new build").

What is linked in (all of it is in the source mirror, below):

| Component | Version | License | Used for |
|---|---|---|---|
| FFmpeg | 7.1.1 | GPL-2.0-or-later (as built: GPL v3) | the programs |
| x264 | master snapshot, commit `373697b4` (2025-03-03) | GPL-2.0-or-later | H.264 encoder (8 and 10 bit) |
| libass | 0.17.3 | ISC | the `subtitles` filter (captions) |
| FreeType | 2.13.3 | FreeType License (FTL) | glyph rendering |
| HarfBuzz | 10.4.0 | MIT | text shaping |
| FriBidi | 1.0.16 | LGPL-2.1-or-later | right-to-left text |
| zimg | 3.0.5 | WTFPL-2.0 | the `zscale` filter (HDR to SDR) |
| zlib | 1.3.1 | zlib | compression |
| nv-codec-headers (Windows only) | n12.2.72.0 | MIT | header files for NVIDIA NVENC (`h264_nvenc`); the NVIDIA driver is loaded at run time |
| AMF headers (Windows only) | 1.4.36 | MIT | header files for AMD AMF (`h264_amf`); `amfrt64.dll` from the AMD driver is loaded at run time |
| libvpl (Windows only) | 2.15.0 | MIT | the Intel oneVPL dispatcher for Quick Sync (`h264_qsv`); it finds and loads the Intel runtime from the GPU driver at run time. Built with a one-line `sed` in `build.sh` (an MSVC-only preprocessor test), FFmpeg itself is unpatched |
| Apple frameworks (macOS only) | system | system libraries | VideoToolbox, AudioToolbox, CoreText |
| MSYS2 GCC runtime (Windows only) | GCC 16.2.0 | GPL-3.0 with the GCC Runtime Library Exception | statically linked compiler runtime (`libgcc`, `libstdc++`) |

No network stack (`--disable-network`), no fontconfig, no iconv, no other third-party codec library: every other
decoder, encoder and filter is FFmpeg's own code. Needed filters/encoders were checked on both builds: `subtitles`,
`loudnorm`, `ebur128`, `blackdetect`, `zscale`, `overlay`, `tpad`, `alimiter`, `drawtext`; `libx264`, `aac`, and
`h264_videotoolbox` (macOS) / `h264_nvenc`, `h264_amf`, `h264_qsv` (Windows). The three Windows GPU encoders contain no vendor code: each
is opened only if that vendor's driver is on the machine (checked at run time; without it Reel Studio uses libx264). The build does not use
`--enable-nonfree`.

* **License text:** GNU GPL version 3, committed as `packaging/licenses/gpl-3.0.txt` (sha256
  `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`, identical to https://www.gnu.org/licenses/gpl-3.0.txt)
  and copied next to the binaries as `resources/ffmpeg/LICENSE.txt` on both platforms. It is never fetched at build time.
  The licenses of the libraries above are inside their source archives in the mirror.
* **Why 7.1.x and not the newest:** the engine is developed and tested against FFmpeg 7.1. FFmpeg 8 and 9 print
  `ffmpeg -filters` with a different column layout, which `reelengine.tools.filters()` mis-parses (it then thinks
  `subtitles`, `loudnorm` and `zscale` are missing). Moving to 8/9 is a one-line version change in `sources.txt` after
  the engine's parser is fixed.
* You may replace these two files with your own FFmpeg build: Reel Studio finds them through the
  `REELENGINE_FFMPEG` / `REELENGINE_FFPROBE` settings.

#### FFmpeg corresponding source (GPL v3 section 6): the compliance statement

We convey the FFmpeg and FFprobe binaries as a download (the GitHub release). GPL v3 section 6(d) lets us do that and
keep the Corresponding Source on a server beside it, provided there are "clear directions next to the object code
saying where to find the Corresponding Source" and it stays available "as long as needed to satisfy these
requirements". Our offer:

1. **The Corresponding Source of the two programs, for both platforms, is exactly the set of files in the folder
   `release/gpl-sources/`** that `python packaging/mirror_gpl_sources.py` produces, and that is attached to the same GitHub
   release as the installers: the unmodified FFmpeg 7.1.1 source (`ffmpeg-7.1.1.tar.xz` with its signature), the source of
   every library in the table above, and `reel-studio-ffmpeg-recipe-rs2.tar.gz`, which holds "the scripts used to control
   compilation and installation" (`build.sh`, `sources.txt` with every version, URL and SHA-256, `pack.py`, `README.md`).
   FFmpeg is not patched. `README.txt` and `SHA256SUMS.txt` sit beside them. **Whoever publishes a release attaches every
   file in that folder to the release and keeps them there as long as the installers are downloadable.** The release notes
   say where they are (`docs/RELEASE-NOTES-*.md`).
2. **Anyone can rebuild the binaries**: one command on each platform (`bash packaging/ffmpeg/build.sh <workdir>`, in an
   MSYS2 UCRT64 shell on Windows or a normal terminal on Apple silicon; the setup is in `packaging/ffmpeg/README.md`).
   The script downloads each source, refuses any file whose SHA-256 differs from `sources.txt`, and compiles. The only
   inputs not in the mirror are the build tools (MSYS2's GCC, nasm, meson, ninja, pkgconf; Apple's clang; GNU
   m4/autoconf/automake/libtool and pkgconf on macOS, which `sources.txt` pins); they are not part of the binaries
   (the statically linked GCC runtime on Windows is under the GCC Runtime Library Exception).
3. The exact configure line of each binary is printed by `ffmpeg -version` and stored in `BUILDINFO.txt` inside each zip.
   It shows the maintainer's build directory in `-I`/`-L` paths; the flags themselves are those in `build.sh`.
4. A reproducible rebuild produces a working equivalent, not necessarily a byte-identical file (compiler and linker
   timestamps, toolchain updates). The hashes pinned above are those of the files we publish.

### CPython (Python Software Foundation License)

Python 3.11.17 from python-build-standalone release 20261013
(https://github.com/astral-sh/python-build-standalone , MPL-2.0 for the build tooling). The distribution
bundles OpenSSL (Apache-2.0), zlib, SQLite (public domain), libffi, expat, xz, bzip2 and others;
their license texts are inside the Python folder under `python/` (`licenses` / `LICENSE.txt`).

| Platform | File | SHA-256 |
|---|---|---|
| Windows x64 | `cpython-3.11.17+20261013-x86_64-pc-windows-msvc-install_only.tar.gz` | `7616ab1f74aab975bd91eb0a657a74a092a63a46cac38c5f3f9415c79fd781f5` |
| macOS arm64 | `cpython-3.11.17+20261013-aarch64-apple-darwin-install_only.tar.gz` | `d81d757a9785850393cd695a9a686c765a6370fbdc83738589ef2ecd3e5c44b3` |

### Python packages (installed by pip from PyPI)

The single source of truth is `engine/requirements.txt` (the engine's own exact pins, including transitive
dependencies) plus `packaging/requirements-extra.txt` (bundle-only extras: pi-heif). `packaging/hash_requirements.py`
turns them into `packaging/requirements-runtime.hashed.txt`, which `fetch_runtime.py` installs with
`pip install --require-hashes --no-deps`; a stale copy stops the build. Versions: see `engine/requirements.txt`.

| Package | License | Notes |
|---|---|---|
| numpy | BSD-3-Clause | wheel bundles OpenBLAS (BSD-3-Clause) and, on Windows, GCC runtime libs (GPL with runtime exception) |
| pillow | HPND | |
| **pi-heif** | BSD-3-Clause (wrapper); wheel libraries LGPL-3.0 | HEIC/HEIF stills (iPhone photos), decode only. The wheels contain exactly two libraries, **libheif 1.23.0 (LGPL-3.0) and libde265 1.1.0 (LGPL-3.0)**, as separate `.dll` / `.dylib` files that can be replaced (LGPL). **It replaces pillow-heif, whose wheels also bundle x265 (GPL-2.0+) and load it in-process: pillow-heif must never be installed** (`fetch_runtime.py`'s smoke test fails the build if it is). Verified 2026-10-17: no x265, aom, dav1d or other encoder strings in the win_amd64 or macOS arm64 libheif. LGPL source: `pillow_heif-1.4.0.tar.gz` (carries `libheif/build_libs.py`, the build recipe), `libheif-1.23.0.tar.gz`, `libde265-1.1.0.tar.gz`, all in the source mirror above. HEVC is a patent-encumbered codec; decoding HEIC is what iPhones' own photos need, so this is the same exposure every photo app with HEIC import has. |
| opencv-python-headless | Apache-2.0 | 5.0.0.93, the version the engine's tests ran against; wheel bundles FFmpeg libraries (LGPL-2.1, `texts/lgpl-2.1.txt`) |
| faster-whisper | MIT | speech to text |
| ctranslate2 | MIT | the inference engine under faster-whisper (CPU only, no torch) |
| onnxruntime | MIT | voice activity detection used by faster-whisper |
| av (PyAV) | BSD-3-Clause | wheel bundles FFmpeg libraries (LGPL-2.1, `texts/lgpl-2.1.txt`) |
| tokenizers, huggingface_hub, hf-xet | Apache-2.0 | download and tokenise the speech model |
| yt-dlp | The Unlicense | downloads videos from links the user pastes |
| jsonschema, referencing, rpds-py, attrs | MIT | validates project files |
| protobuf, flatbuffers | BSD-3-Clause / Apache-2.0 | onnxruntime support |
| PyYAML, tqdm, filelock, fsspec, packaging, typing_extensions, click, colorama, anyio, idna, h11, httpcore2, httpx2, truststore | MIT / BSD / Apache-2.0 / MPL-2.0 (tqdm) | support libraries |

Each wheel carries its own `*.dist-info/licenses` folder inside `python/Lib/site-packages` (Windows) or
`python/lib/python3.11/site-packages` (macOS).

### JavaScript packages (npm)

Production dependency tree of the app plus the front-end libraries vite bundles into the window. Checked with
`npm ls --all --omit=dev` and each package's own `package.json`; **no GPL, AGPL, LGPL or non-commercial npm dependency**
(`packaging/gen_npm_notices.py` fails if one appears). The verbatim license files are in `texts/npm-licenses.txt`.

| Package | License | Copyright |
|---|---|---|
| react, react-dom, scheduler 19 / 0.28 | MIT | Meta Platforms, Inc. and affiliates |
| @reelstudio/ai (this repo) | MIT | Reel Studio |
| @anthropic-ai/sdk 0.135.0 | MIT | Anthropic, PBC |
| @opentelemetry/api 1.9.1 | Apache-2.0 | OpenTelemetry Authors |
| json-schema-to-ts 3.1.1, ts-algebra 2.0.0 | MIT | Thomas Aribart |
| @babel/runtime 7.29.10 | MIT | Sebastian McKenzie and other contributors |
| standardwebhooks 1.1.1 | MIT (package.json; its repository root file is Apache-2.0, both texts shipped) | Standard Webhooks |
| @stablelib/base64 1.0.1 | MIT | Dmitry Chestnykh |
| fast-sha256 1.3.0 | Unlicense | Dmitry Chestnykh |

### QR Code generator library (vendored source, MIT)

The "Send to my phone" QR code is drawn offline by Project Nayuki's QR Code generator library, TypeScript version,
copied unmodified into `app/src/shared/vendor/qrcodegen.ts` (fetched 2026-10-17 from
https://github.com/nayuki/QR-Code-generator/blob/master/typescript-javascript/qrcodegen.ts , SHA-256 of the
upstream file `1dc03fb5a10e0e2318ea162755bbdb9977ca6ce52cff959e9c9b6deafdccda9c`). It is bundled into the window's
JavaScript, where a minifier may drop the source comment, so the notice is repeated here in full:

> QR Code generator library (TypeScript)
>
> Copyright (c) Project Nayuki. (MIT License)
> https://www.nayuki.io/page/qr-code-generator-library
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
> - The above copyright notice and this permission notice shall be included in all copies or substantial portions
>   of the Software.
> - The Software is provided "as is", without warranty of any kind, express or implied, including but not limited
>   to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall
>   the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of
>   contract, tort or otherwise, arising from, out of or in connection with the Software or the use or other
>   dealings in the Software.

### Electron and Chromium (MIT, BSD-3-Clause and others)

The app shell is Electron 44 (https://www.electronjs.org , MIT). The installed app contains
`LICENSE.electron.txt` and `LICENSES.chromium.html` listing every Chromium component license.

### Face detection model (bundled, MIT)

YuNet, `face_detection_yunet_2023mar.onnx` from the OpenCV Model Zoo, unmodified (sha256
`8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`), MIT, Copyright (c) 2020 Shiqi Yu.
https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet . The MIT text is
`packaging/licenses/yunet-MIT.txt`; the installer also places it next to the model as
`engine/reelengine/models/LICENSE-YuNet-MIT.txt`.

### Speech model (downloaded on first run, not bundled)

Whisper in the CTranslate2 conversion from Hugging Face (`Systran/faster-whisper-*`; the app offers `small.en` by
default). License: MIT (OpenAI Whisper weights). https://huggingface.co/Systran/faster-whisper-small.en

### Fonts (bundled, SIL OFL 1.1 or Apache-2.0)

Every font keeps its own license text in the folder it ships in. Names and copyright lines below are read from each
font's own `name` table.

| Where it ships | Families | License |
|---|---|---|
| `resources/fonts/` (`packaging/fonts/`, `SOURCES.md` lists upstream URLs and checksums) | Montserrat v7.222, Inter 4.1, Fraunces 1.000, Roboto 3.016 (static TTFs, unmodified) | SIL OFL 1.1 (`*-OFL.txt` beside the files) |
| `resources/engine/reelengine/fonts/` | Montserrat (SemiBold, variable), Inter, Fraunces; **Roboto 2.001047** | SIL OFL 1.1 (`OFL-*.txt`); Roboto 2.001047 is **Apache-2.0** (`LICENSE-Roboto-Apache-2.0.txt`) |
| `resources/templates/fonts/` (animation and b-roll templates) | Inter (Medium, SemiBold, Bold), Fraunces (SemiBold, Bold), Montserrat variable, **JetBrains Mono** (Medium, Bold) | SIL OFL 1.1, one `OFL.txt` listing each file's copyright: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)" and the same for the others |

OFL fonts may be bundled with software; they may not be sold on their own and keep their names.

### Sound effects (bundled, CC0 1.0)

37 short sounds ship in `resources/engine/reelengine/sfx/` (`engine/reelengine/sfx/`). Each is dedicated to the
public domain under CC0 1.0, from Freesound and Kenney, so none needs a credit. `engine/THIRD_PARTY.md` lists every
file with its source, author and page.

## Not bundled, not used

No PyTorch, no CUDA runtime, no telemetry or analytics libraries.

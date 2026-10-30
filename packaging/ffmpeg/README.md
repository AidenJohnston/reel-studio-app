# Reel Studio's FFmpeg build

Reel Studio ships `ffmpeg` and `ffprobe` 7.1.1 that **we build ourselves** from pinned source tarballs, on both
platforms, instead of re-distributing someone else's binaries. Reason: the GPL (v3 section 6) obliges whoever conveys
a GPL binary to hand out the Corresponding Source, including "the scripts used to control compilation". A third-party
static build that does not publish its dependency versions or its script (the Windows build we used before) cannot
meet that. Here every input is a file in `sources.txt` with its SHA-256 and the commands are in `build.sh`.

The result is deliberately minimal: only what the engine uses.

| In | Why |
|---|---|
| libx264 (8 and 10 bit) | the final H.264 encoder, and the reason the binary is GPL |
| libass + freetype + fribidi + harfbuzz | the `subtitles` filter that burns the captions in |
| libzimg | the `zscale` filter (HDR phone video to SDR) |
| zlib | PNG and compressed containers |
| macOS: VideoToolbox, AudioToolbox | `h264_videotoolbox` draft encoder |
| Windows: nv-codec-headers, AMF headers, libvpl | `h264_nvenc` (NVIDIA), `h264_amf` (AMD), `h264_qsv` (Intel) draft encoders: headers or a run-time-loading dispatcher only, the GPU driver supplies the real code; the engine tests which one opens on the machine |
| Windows: D3D11VA, DXVA2 | hardware decode, when the machine has it |

Everything else FFmpeg decodes or filters (HEVC, ProRes, AAC, `loudnorm`, `overlay`, ...) is FFmpeg's own code. No
network stack (`--disable-network`), no fontconfig, no other third-party codec libraries. Licence of the result:
GPL v3 (`--enable-gpl --enable-version3`). Reel Studio runs the two programs as child processes only.

## Build it yourself

One command per platform; the first run downloads about 40 MB of sources and verifies each against `sources.txt`.
Re-running resumes (a finished step leaves a stamp in `<workdir>/stamps`).

**Windows x64** (MSYS2, https://www.msys2.org). In an **UCRT64** shell:

    pacman -S --needed base-devel autoconf automake libtool make diffutils perl \
        mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-meson \
        mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-cmake
    bash packaging/ffmpeg/build.sh /c/rs-ffmpeg-work

**macOS arm64** (Xcode command line tools and `python3`; the script builds its own autotools, pkgconf, meson):

    bash packaging/ffmpeg/build.sh ~/rs-ffmpeg-work

Output: `release/ffmpeg/ffmpeg-7.1.1-rs2-win-x64.zip` or `...-macos-arm64.zip`, each holding `ffmpeg`, `ffprobe` and
`BUILDINFO.txt` (compiler version and the exact `ffmpeg -version`, which prints the configure line).
`packaging/fetch_runtime.py` uses a file in `release/ffmpeg/` whose SHA-256 matches its pin before it tries to
download anything.

## Releasing a new build

1. Build on both platforms with the commands above.
2. Upload the two zips to `https://dl.getreelstudio.com/source/ffmpeg-7.1.1-rs2/` (`FFMPEG_TAG` and `FFMPEG_BASE` in
   `fetch_runtime.py`), the folder listed on https://getreelstudio.com/source.html.
3. Copy the SHA-256 that `pack.py` printed into `PLATFORMS[...]["ffmpeg_zip"]["sha256"]` in `fetch_runtime.py` and
   into the table in `THIRD_PARTY.md`.
4. If you changed a version in `sources.txt` or a flag in `build.sh`, bump `REV` in `build.sh` and `mirror_gpl_sources.py`
   and the tag/file names in `fetch_runtime.py`.
5. `python packaging/mirror_gpl_sources.py` and upload everything in `release/gpl-sources/` to the same folder, then
   list each file on the source page. A new build (a new tag) gets its own folder; the old one stays online as long as
   any installer that bundles it is downloadable.

The zips are bit-for-bit what was built, but two independent builds are not guaranteed to hash equal (compiler
timestamps, MSYS2 package updates); the pinned hash is the one of the files you upload.

## Updating a library

Change the row in `sources.txt` (file, SHA-256, URL), rebuild, run the engine tests and a captioned render
(`status/ffmpeg.md` shows the check). The mirror script reads `sources.txt`, so the source offer follows automatically.
Build tools (`m4`, `autoconf`, `automake`, `libtool`, `pkgconf`, meson, ninja) are used to compile but never linked; the
macOS ones are pinned here too so the macOS build needs nothing preinstalled.

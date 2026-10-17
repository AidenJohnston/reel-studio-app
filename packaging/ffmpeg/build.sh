#!/usr/bin/env bash
# Build Reel Studio's own minimal FFmpeg 7.1.1 (GPL v3) from pinned source tarballs.
#
#   Windows x64 : run inside an MSYS2 UCRT64 shell  (see README.md for the one-time setup)
#   macOS arm64 : run in a normal terminal (Xcode command line tools + python3; nothing else needs installing)
#
#       bash packaging/ffmpeg/build.sh <workdir> [<output dir>]
#
# <workdir> keeps the downloaded sources (checked against sources.txt SHA-256), the build trees and the install
# prefix; it is safe to delete, and re-running resumes (finished steps leave a stamp file in <workdir>/stamps).
# <output dir> (default: release/ffmpeg next to this repo) receives the two files fetch_runtime.py consumes:
#   ffmpeg-7.1.1-rs2-<platform>.zip   (ffmpeg, ffprobe, BUILDINFO.txt)
#
# What goes in (everything the engine needs, nothing else):
#   libx264 (final encoder)            libass + freetype + fribidi + harfbuzz (captions via the `subtitles` filter)
#   libzimg (the `zscale` filter, HDR phone video -> SDR)   zlib
#   macOS: VideoToolbox + AudioToolbox
#   Windows: hardware H.264 draft encoders, all through permissively licensed headers or a run-time-loading
#            dispatcher (the vendor's driver is loaded when ffmpeg runs, nothing proprietary is linked):
#            NVIDIA h264_nvenc (nv-codec-headers), AMD h264_amf (AMF headers), Intel h264_qsv (libvpl); D3D11VA/DXVA2 decode
# No network stack, no fontconfig, no iconv, no other codecs libraries: every other decoder is FFmpeg's own.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${1:?usage: build.sh <workdir> [<output dir>]}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
OUTDIR="${2:-$REPO/release/ffmpeg}"
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
REV="rs2"            # bump when the recipe changes but FFmpeg's version does not
JOBS="${JOBS:-$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) || echo 4)}"

SRC="$WORK/src"; BLD="$WORK/build"; P="$WORK/prefix"; T="$WORK/tools"; ST="$WORK/stamps"
mkdir -p "$SRC" "$BLD" "$P" "$T" "$ST"

case "$(uname -s)" in
  MINGW*|MSYS*) PLAT=win;   PLATNAME=win-x64;      EXE=.exe ;;
  Darwin)       PLAT=mac;   PLATNAME=macos-arm64;  EXE= ;
                [ "$(uname -m)" = arm64 ] || { echo "macOS build must run on Apple silicon (arm64)"; exit 1; } ;;
  *) echo "unsupported platform $(uname -s)"; exit 1 ;;
esac

log() { printf '\n==== %s ====\n' "$*"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Look a source up in sources.txt, download it if needed, verify it. Prints nothing; sets F_FILE.
fetch() {
  local name="$1" line file want url
  line="$(grep -v '^#' "$HERE/sources.txt" | awk -F'\t' -v n="$name" '$1==n {print; exit}')"
  [ -n "$line" ] || { echo "no such source: $name"; exit 1; }
  file="$(echo "$line" | cut -f2)"; want="$(echo "$line" | cut -f3)"; url="$(echo "$line" | cut -f4)"
  if [ ! -f "$SRC/$file" ]; then
    echo "download $url"
    curl -fsSL --retry 3 -A "reel-studio-packaging/1.0" -o "$SRC/$file.part" "$url"
    mv "$SRC/$file.part" "$SRC/$file"
  fi
  [ "$(sha256 "$SRC/$file")" = "$want" ] || { echo "SHA-256 MISMATCH for $file (wanted $want)"; exit 1; }
  F_FILE="$SRC/$file"
}

# unpack <name>  -> $BLD/<name> (fresh copy, top directory stripped)
unpack() {
  fetch "$1"
  rm -rf "$BLD/$1"; mkdir -p "$BLD/$1"
  tar -xf "$F_FILE" -C "$BLD/$1" --strip-components=1
}

# step <name> <function>: run once, remember it
step() {
  if [ -f "$ST/$1" ]; then echo "(skip $1, already built)"; return; fi
  log "$1"; "$2"; touch "$ST/$1"
}

# ---------------------------------------------------------------- toolchain / environment
export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig:$P/share/pkgconfig"
unset PKG_CONFIG_PATH || true
FPM="-ffile-prefix-map=$WORK=/build"          # keeps build-dir paths out of the binaries
if [ "$PLAT" = mac ]; then
  export MACOSX_DEPLOYMENT_TARGET=12.0
  export CC=clang CXX=clang++
  export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=12.0 $FPM"
  export CXXFLAGS="$CFLAGS"
  export LDFLAGS="-arch arm64 -mmacosx-version-min=12.0"
  export PATH="$T/bin:$T/venv/bin:$PATH"
else
  export CFLAGS="-O2 $FPM"
  export CXXFLAGS="$CFLAGS"
  export LDFLAGS=""
fi

# macOS has no autotools, pkg-config, meson: build them into $T from the pinned tarballs (build tools only).
tools_mac() {
  for t in m4 autoconf automake libtool; do
    unpack "$t"; ( cd "$BLD/$t" && ./configure --prefix="$T" >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null )
  done
  unpack pkgconf
  python3 -m venv "$T/venv"
  "$T/venv/bin/pip" install --quiet -r "$HERE/build-tools-requirements.txt"
  ( cd "$BLD/pkgconf" && "$T/venv/bin/meson" setup out --prefix="$T" --buildtype=release -Dtests=disabled >/dev/null \
      && "$T/venv/bin/ninja" -C out >/dev/null && "$T/venv/bin/ninja" -C out install >/dev/null )
  ln -sf "$T/bin/pkgconf" "$T/bin/pkg-config"
}

# ---------------------------------------------------------------- libraries
b_zlib() {
  unpack zlib; cd "$BLD/zlib"
  ./configure --prefix="$P" --static
  make -j"$JOBS"; make install
}
b_freetype() {
  unpack freetype; cd "$BLD/freetype"
  ./configure --prefix="$P" --disable-shared --enable-static --with-zlib=yes --with-bzip2=no --with-png=no \
              --with-brotli=no --with-harfbuzz=no
  make -j"$JOBS"; make install
}
b_fribidi() {
  unpack fribidi; cd "$BLD/fribidi"
  meson setup out --prefix="$P" --libdir=lib --buildtype=release --default-library=static \
        -Dbin=false -Dtests=false -Ddocs=false
  ninja -C out; ninja -C out install
}
b_harfbuzz() {
  unpack harfbuzz; cd "$BLD/harfbuzz"
  meson setup out --prefix="$P" --libdir=lib --buildtype=release --default-library=static \
        -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dgraphite=disabled \
        -Dcoretext=disabled -Dgdi=disabled -Ddirectwrite=disabled -Dtests=disabled -Dintrospection=disabled \
        -Ddocs=disabled -Dbenchmark=disabled -Dutilities=disabled
  ninja -C out; ninja -C out install
}
b_libass() {
  unpack libass; cd "$BLD/libass"
  # No fontconfig: Reel Studio hands libass a fontsdir with its bundled fonts. Windows uses DirectWrite as the
  # system provider, macOS CoreText; --disable-require-system-font-provider keeps configure from failing without one.
  ./configure --prefix="$P" --disable-shared --enable-static --disable-fontconfig --disable-libunibreak \
              --disable-require-system-font-provider
  make -j"$JOBS"; make install
}
b_x264() {
  unpack x264; cd "$BLD/x264"
  ./configure --prefix="$P" --enable-static --disable-cli --disable-opencl --disable-avs --disable-swscale \
              --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --bit-depth=all --enable-pic
  make -j"$JOBS"; make install
}
b_zimg() {
  unpack zimg; cd "$BLD/zimg"
  ./autogen.sh
  ./configure --prefix="$P" --disable-shared --enable-static --disable-testapp --disable-example --disable-unit-test
  make -j"$JOBS"; make install
}
b_nvcodec() {
  unpack nv-codec-headers; cd "$BLD/nv-codec-headers"
  make PREFIX="$P" install
}
b_amf() {
  # headers only: FFmpeg loads amfrt64.dll from the AMD driver at run time
  unpack amf-headers
  mkdir -p "$P/include"; rm -rf "$P/include/AMF"
  cp -R "$BLD/amf-headers/AMF" "$P/include/AMF"
}
b_libvpl() {
  # the dispatcher only (it finds and loads the Intel runtime at run time); no tools, no examples, no tests
  unpack libvpl; cd "$BLD/libvpl"
  # libvpl 2.15 only knows MSVC on Windows: under GCC `_MSC_VER < 1400` is true (macro undefined = 0) and selects
  # a pre-VS2005 wcscpy_s shim that does not compile. The one-line fix keeps that shim for real old MSVC only.
  sed -i 's/^    #if _MSC_VER < 1400$/    #if defined(_MSC_VER) \&\& _MSC_VER < 1400/; s/^#if _MSC_VER < 1400$/#if defined(_MSC_VER) \&\& _MSC_VER < 1400/' libvpl/src/windows/mfx_dispatcher_defs.h
  grep -q 'defined(_MSC_VER) && _MSC_VER < 1400' libvpl/src/windows/mfx_dispatcher_defs.h
  cmake -S . -B out -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$P" -DCMAKE_INSTALL_LIBDIR=lib         -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TOOLS=OFF -DBUILD_PREVIEW=OFF         -DBUILD_EXPERIMENTAL=OFF -DINSTALL_EXAMPLE_CODE=OFF -DENABLE_WARNINGS_AS_ERRORS=OFF         "-DCMAKE_C_FLAGS=$CFLAGS" "-DCMAKE_CXX_FLAGS=$CXXFLAGS"
  cmake --build out -j"$JOBS"; cmake --install out
}

# ---------------------------------------------------------------- FFmpeg
b_ffmpeg() {
  unpack ffmpeg; cd "$BLD/ffmpeg"
  local common=(
    --prefix=/reel-studio-ffmpeg --pkg-config=pkg-config --pkg-config-flags=--static
    --enable-gpl --enable-version3 --disable-autodetect
    --enable-static --disable-shared --disable-debug --disable-doc --disable-ffplay --disable-network
    --enable-libx264 --enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz
    --enable-libzimg --enable-zlib
    "--extra-cflags=-I$P/include $FPM" "--extra-ldflags=-L$P/lib"
  )
  local plat_args
  if [ "$PLAT" = mac ]; then
    plat_args=(--cc=clang --cxx=clang++ --arch=arm64 --enable-pic --enable-videotoolbox --enable-audiotoolbox
      "--extra-cflags=-arch arm64 -mmacosx-version-min=12.0" "--extra-ldflags=-arch arm64 -mmacosx-version-min=12.0"
      --extra-libs=-lc++)
  else
    plat_args=(--target-os=mingw32 --enable-ffnvcodec --enable-nvenc --enable-amf --enable-libvpl --enable-d3d11va --enable-dxva2
      "--extra-ldflags=-static -Wl,--no-insert-timestamp" --extra-libs="-lstdc++")
  fi
  ./configure "${common[@]}" "${plat_args[@]}"
  make -j"$JOBS"
  strip "ffmpeg$EXE" "ffprobe$EXE"
}

# ---------------------------------------------------------------- run
if [ "$PLAT" = mac ]; then step tools_mac tools_mac; fi
step zlib b_zlib
step freetype b_freetype
step fribidi b_fribidi
step harfbuzz b_harfbuzz
step libass b_libass
step x264 b_x264
step zimg b_zimg
if [ "$PLAT" = win ]; then step nvcodec b_nvcodec; step amf b_amf; step libvpl b_libvpl; fi
rm -f "$ST/ffmpeg"                      # always relink FFmpeg
step ffmpeg b_ffmpeg

log "package"
{
  echo "Reel Studio FFmpeg 7.1.1-$REV ($PLATNAME)"
  echo "Built from the sources listed in packaging/ffmpeg/sources.txt by packaging/ffmpeg/build.sh"
  echo "Toolchain: $(${CC:-gcc} --version | head -1)"
  echo "-- ffmpeg -version --"
  "$BLD/ffmpeg/ffmpeg$EXE" -hide_banner -version
} > "$BLD/BUILDINFO.txt"
python3 "$HERE/pack.py" "$OUTDIR/ffmpeg-7.1.1-$REV-$PLATNAME.zip" \
  "$BLD/ffmpeg/ffmpeg$EXE" "$BLD/ffmpeg/ffprobe$EXE" "$BLD/BUILDINFO.txt"
echo
ls -la "$OUTDIR"

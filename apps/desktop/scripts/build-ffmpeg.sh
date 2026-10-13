#!/bin/sh
# Builds the ffmpeg and ffprobe that ship inside Glintmotion.app (Resources/ffmpeg).
#
# LGPL only: no --enable-gpl, so no libx264/libx265. The engine already falls back to
# VideoToolbox for MP4 when libx264 is missing; HLS export is the one format that
# still needs a GPL ffmpeg (Homebrew's), and the app keeps preferring Homebrew's
# ffmpeg when it is installed. libvpx (VP9, WebM with alpha) and libopus (WebM
# audio) are BSD-licensed and linked statically; everything else is native ffmpeg.
#
# Output: apps/desktop/vendor/ffmpeg/{ffmpeg,ffprobe,CONFIG.txt} and the three licences.
# Needs: Xcode command line tools, cmake, pkg-config (Homebrew).
set -eu

FFMPEG_TAG=n8.0.3
FFMPEG_COMMIT=8ae0b34901ba60a802f183ee75a250a9fc3e09a5
LIBVPX_TAG=v1.17.0
LIBVPX_COMMIT=6df3ec34557879fff673706f4a1d9fbd0f3a6f0e
OPUS_TAG=v1.5.2
OPUS_COMMIT=ddbe48383984d56acd9e1ab6a090c54ca6b735a6

here=$(cd "$(dirname "$0")/.." && pwd)
work="$here/stage/ffmpeg-build"
prefix="$work/prefix"
out="$here/vendor/ffmpeg"
jobs=$(sysctl -n hw.ncpu)
export MACOSX_DEPLOYMENT_TARGET=13.0

fetch() { # name url tag commit
  if [ ! -d "$work/$1" ]; then
    git clone --quiet --depth 1 --branch "$3" "$2" "$work/$1"
  fi
  actual=$(git -C "$work/$1" rev-parse HEAD)
  if [ "$actual" != "$4" ]; then
    echo "$1: expected commit $4 for $3, got $actual" >&2
    exit 1
  fi
}

mkdir -p "$work" "$prefix"
fetch ffmpeg https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_TAG" "$FFMPEG_COMMIT"
fetch libvpx https://chromium.googlesource.com/webm/libvpx "$LIBVPX_TAG" "$LIBVPX_COMMIT"
fetch opus https://github.com/xiph/opus.git "$OPUS_TAG" "$OPUS_COMMIT"

echo "== libvpx"
(
  cd "$work/libvpx"
  ./configure --prefix="$prefix" --target=arm64-darwin22-gcc \
    --enable-static --disable-shared --enable-vp9-highbitdepth \
    --disable-examples --disable-tools --disable-docs --disable-unit-tests
  make -j"$jobs" && make install
)

echo "== opus"
cmake -S "$work/opus" -B "$work/opus/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF \
  -DOPUS_BUILD_TESTING=OFF -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build "$work/opus/build" -j"$jobs" --target install

echo "== ffmpeg"
(
  cd "$work/ffmpeg"
  # LIBDIR, not PATH: pkg-config must not see Homebrew's libraries at all.
  PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" ./configure \
    --prefix="$prefix" --arch=arm64 --cc=clang \
    --pkg-config-flags=--static \
    --enable-static --disable-shared --disable-debug --disable-doc \
    --disable-ffplay --enable-ffmpeg --enable-ffprobe \
    --disable-gpl --disable-nonfree \
    --enable-videotoolbox --enable-audiotoolbox --enable-neon \
    --enable-libvpx --enable-libopus \
    --disable-sdl2 --disable-xlib --disable-libxcb --disable-securetransport \
    --disable-network
  make -j"$jobs"
)

rm -rf "$out" && mkdir -p "$out"
cp "$work/ffmpeg/ffmpeg" "$work/ffmpeg/ffprobe" "$out/"
cp "$work/ffmpeg/COPYING.LGPLv2.1" "$out/COPYING.LGPLv2.1"
cp "$work/libvpx/LICENSE" "$out/LICENSE.libvpx"
cp "$work/opus/COPYING" "$out/LICENSE.opus"
"$out/ffmpeg" -hide_banner -version > "$out/CONFIG.txt"

if grep -q -- "--enable-gpl" "$out/CONFIG.txt"; then
  echo "This ffmpeg is GPL: it must not ship in the app." >&2
  exit 1
fi
for dylib in $(otool -L "$out/ffmpeg" | awk 'NR>1 {print $1}'); do
  case "$dylib" in
    /usr/lib/* | /System/*) ;;
    *) echo "ffmpeg links $dylib, which is not on every Mac." >&2 && exit 1 ;;
  esac
done
echo "Built $(head -1 "$out/CONFIG.txt") into $out"

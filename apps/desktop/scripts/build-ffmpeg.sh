#!/usr/bin/env bash
# Slim LGPL ffmpeg.exe for Qone, cross-compiled on Debian/Ubuntu (WSL locally, ubuntu in CI).
# Every native decoder, demuxer, muxer, encoder and filter stays, so any input
# still decodes. External libraries are only dav1d (AV1 decoding), LAME (MP3
# encoding) and zlib; the full upstream builds add ~100 MB of encoders and GPU
# stacks Qone never calls. Usage: build-ffmpeg.sh <output-directory>
set -euo pipefail

OUT=$(realpath "$1")
# prepare-ffmpeg.ts reuses an output only when it was built by this exact recipe.
RECIPE=$(sha256sum "$0" | cut -d" " -f1)
FFMPEG=8.1.3 FFMPEG_SHA=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
DAV1D=1.5.4 DAV1D_SHA=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
LAME=3.100 LAME_SHA=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
ZLIB=1.3.1 ZLIB_SHA=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
HOST=x86_64-w64-mingw32
WORK=${QONE_FFMPEG_WORK:-$HOME/qone-ffmpeg-build}
PREFIX=$WORK/prefix
JOBS=$(nproc)
SUDO=$([ "$(id -u)" = 0 ] || echo sudo)

if ! command -v $HOST-gcc >/dev/null || ! command -v meson >/dev/null || ! command -v nasm >/dev/null; then
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq mingw-w64 nasm meson ninja-build pkg-config make curl xz-utils
fi

mkdir -p "$WORK" "$PREFIX"
cd "$WORK"

fetch() { # url sha256 -> extracted directory name on stdout
  local file; file=$(basename "$1")
  if [ ! -f "$file" ]; then curl -fsSL --retry 3 "$1" -o "$file.part"; mv "$file.part" "$file"; fi
  echo "$2  $file" | sha256sum -c --quiet - >&2
  rm -rf "${file%.tar.*}"
  tar -xf "$file"
  echo "${file%.tar.*}"
}

dir=$(fetch "https://zlib.net/fossils/zlib-$ZLIB.tar.gz" "$ZLIB_SHA")
make -C "$dir" -f win32/Makefile.gcc -j"$JOBS" PREFIX=$HOST- libz.a >/dev/null
make -C "$dir" -f win32/Makefile.gcc PREFIX=$HOST- INCLUDE_PATH="$PREFIX/include" LIBRARY_PATH="$PREFIX/lib" BINARY_PATH="$PREFIX/bin" install >/dev/null

dir=$(fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME/lame-$LAME.tar.gz" "$LAME_SHA")
(cd "$dir" && ./configure -q --host=$HOST --prefix="$PREFIX" --enable-static --disable-shared --disable-frontend --disable-decoder \
  && make -j"$JOBS" >/dev/null && make install >/dev/null)

dir=$(fetch "https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D/dav1d-$DAV1D.tar.xz" "$DAV1D_SHA")
(cd "$dir" && meson setup build --cross-file=package/crossfiles/x86_64-w64-mingw32.meson --prefix="$PREFIX" --libdir=lib \
  --default-library=static --buildtype=release -Denable_tools=false -Denable_tests=false >/dev/null && ninja -C build install >/dev/null)

dir=$(fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz" "$FFMPEG_SHA")
(cd "$dir" && PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" \
  --target-os=mingw32 --arch=x86_64 --cross-prefix=$HOST- --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib -static" \
  --disable-shared --enable-static --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-autodetect --enable-w32threads --enable-schannel --enable-zlib --enable-libdav1d --enable-libmp3lame \
  --disable-devices --enable-indev=lavfi --disable-hwaccels >/dev/null \
  && make -j"$JOBS" >/dev/null && $HOST-strip ffmpeg.exe)

cp "$dir/ffmpeg.exe" "$OUT/ffmpeg.exe"
cp "$dir/COPYING.LGPLv2.1" "$OUT/ffmpeg-LICENSE"
echo "$RECIPE" > "$OUT/ffmpeg-build.txt"

#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SDK_COMMIT=a1438dff1d38bd9c65dbd693f0e5db4b9ae91779
mkdir -p .deps
if [ ! -d .deps/pico-sdk ]; then
  git clone --depth 1 --branch 2.2.0 https://github.com/raspberrypi/pico-sdk.git .deps/pico-sdk
fi
if [ "$(git -C .deps/pico-sdk rev-parse HEAD)" != "$SDK_COMMIT" ]; then
  echo "Unexpected SDK revision in .deps/pico-sdk; expected Pico SDK 2.2.0" >&2
  exit 1
fi
git -C .deps/pico-sdk submodule update --init lib/tinyusb

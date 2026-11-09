#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -z "${PICO_SDK_PATH:-}" ]; then
  if [ ! -f .deps/pico-sdk/external/pico_sdk_import.cmake ]; then
    echo "Run sh scripts/fetch-sdk.sh first, or set PICO_SDK_PATH" >&2
    exit 1
  fi
  PICO_SDK_PATH="$PWD/.deps/pico-sdk"
fi
export PICO_SDK_PATH
cmake -S . -B "${BUILD_DIR:-build}" -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build "${BUILD_DIR:-build}" --parallel 6

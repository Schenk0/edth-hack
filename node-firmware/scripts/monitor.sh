#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
echo "Open http://127.0.0.1:5191 in Chrome or Edge. Ctrl-C stops this local server."
exec python3 -m http.server 5191 --bind 127.0.0.1 --directory monitor

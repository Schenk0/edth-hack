#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build-host
CXX=${CXX:-c++}
"$CXX" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer \
  -DUWB_TX_ANT_DELAY=16385 -DUWB_RX_ANT_DELAY=16385 -DUWB_TX_POWER=0 -DNETWORK_ID=60785 -DLINE_LENGTH_MM=10000 -Isrc src/mesh.cpp src/protocol.cpp tests/core_test.cpp -o build-host/core-test
build-host/core-test
"$CXX" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -DUWB_TX_ANT_DELAY=16385 -DUWB_RX_ANT_DELAY=16385 -DUWB_TX_POWER=0 -DNETWORK_ID=60785 -DLINE_LENGTH_MM=0 -Isrc src/mesh.cpp tests/unconfigured_test.cpp -o build-host/unconfigured-test
build-host/unconfigured-test
"$CXX" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer \
  -DUWB_TX_ANT_DELAY=16385 -DUWB_RX_ANT_DELAY=16385 -DUWB_TX_POWER=0 -DNETWORK_ID=60785 -DLINE_LENGTH_MM=0 \
  -Isrc src/mesh.cpp tests/filter_test.cpp -o build-host/filter-test
build-host/filter-test
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Isrc -Itests/stubs src/boot.c tests/boot_test.c -o build-host/boot-test
build-host/boot-test
"$CXX" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Isrc src/setup.cpp tests/setup_test.cpp -o build-host/setup-test
build-host/setup-test
"$CXX" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -Isrc src/json_output.cpp tests/json_output_test.cpp -o build-host/json-output-test
build-host/json-output-test
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; import {parseLine} from "./monitor/model.js"; for(const line of fs.readFileSync("build-host/usb-output.jsonl","utf8").trim().split("\n")) assert(parseLine(line)); console.log("PASS: actual queued USB output parses as dashboard JSON");'

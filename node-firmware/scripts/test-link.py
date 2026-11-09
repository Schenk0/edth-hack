#!/usr/bin/env python3
"""Check fresh N1-N2 ranges on both USB nodes. Requires pyserial; changes no settings."""
import argparse
from contextlib import ExitStack
import json
from pathlib import Path
import sys
import time

import serial
from serial.tools import list_ports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=15, choices=range(5, 121), metavar="5..120")
    parser.add_argument("--log", type=Path, help="Save both USB streams as JSON")
    args = parser.parse_args()
    ports = [p for p in list_ports.comports() if p.vid == 0x2E8A and p.pid == 9]
    if len(ports) != 2:
        raise RuntimeError(f"Connect only N1 and N2 over USB; found {len(ports)} mesh boards")
    boards = []
    with ExitStack() as stack:
        for port in ports:
            device = stack.enter_context(serial.Serial(port.device, 115200, timeout=0))
            device.dtr = True
            device.write(b"GET\n")
            boards.append({"board_id": port.serial_number, "port": port.device,
                           "device": device, "buffer": b"", "records": []})
        until = time.monotonic() + args.seconds
        while time.monotonic() < until:
            for board in boards:
                board["buffer"] += board["device"].read(8192)
                while b"\n" in board["buffer"]:
                    raw, board["buffer"] = board["buffer"].split(b"\n", 1)
                    try:
                        record = json.loads(raw)
                    except (ValueError, UnicodeDecodeError):
                        continue  # Opening CDC may begin partway through a line.
                    if isinstance(record, dict) and record.get("v") == 1:
                        board["records"].append(record)
            time.sleep(0.005)
    streams = [{k: b[k] for k in ("board_id", "port", "records")} for b in boards]
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(json.dumps(streams, indent=2) + "\n")
    node_ids, exchanges = [], []
    for board in boards:
        identity = next((r for r in reversed(board["records"]) if r.get("type") == "identity"), {})
        node_id = identity.get("node_id")
        node_ids.append(node_id)
        ranges = [r for r in board["records"] if r.get("type") == "measurement"
                  and r.get("kind") == "range" and r.get("source") == "N1"
                  and r.get("receiver") == f"N{node_id}" and r.get("a") == 1 and r.get("b") == 2
                  and r.get("hops") == 0 and 0 <= r.get("age_ms", 999999) < 200
                  and 0 <= r.get("usb_delay_ms", 999999) < 1000]
        exchanges.append({(r["boot"], r["seq"], r["value_mm"]) for r in ranges})
        print(f"N{node_id} ({board['board_id']}): {len(exchanges[-1])} fresh direct ranges", flush=True)
    shared = exchanges[0] & exchanges[1]
    passed = set(node_ids) == {1, 2} and len(shared) >= 3
    print(f"{'PASS' if passed else 'FAIL'}: {len(shared)} matching exchanges on both nodes; "
          "this checks the RF link, not distance accuracy", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, serial.SerialException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)

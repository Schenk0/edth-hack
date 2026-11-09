#!/usr/bin/env python3
"""Run the firmware's TEST command over USB. Requires pyserial; never changes saved settings."""
import argparse
import json
import sys
import time
from pathlib import Path

import serial
from serial.tools import list_ports


def receive(device, wanted, timeout=10):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        raw = device.readline().decode(errors="replace").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if data.get("v") == 1 and data.get("type") == wanted:
            return data
        if data.get("type") == "setup" and data.get("ok") is False:
            raise RuntimeError(data.get("message", "Command rejected"))
    raise RuntimeError(f"Timed out waiting for {wanted}; check firmware and USB connection")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Specific serial device, e.g. /dev/cu.usbmodem1101")
    parser.add_argument("--repeat", type=int, default=1, choices=range(1, 11), metavar="1..10")
    parser.add_argument("--log", type=Path, help="Save identity and self-test results as JSON")
    args = parser.parse_args()
    ports = [p for p in list_ports.comports() if p.vid == 0x2E8A and p.pid == 9]
    if args.port:
        ports = [p for p in ports if p.device == args.port]
    if len(ports) != 1:
        raise RuntimeError(f"Expected one mesh USB node; found {len(ports)}. Select one with --port.")
    results = []
    with serial.Serial(ports[0].device, 115200, timeout=0.25) as device:
        device.dtr = True
        device.write(b"GET\n")
        identity = receive(device, "identity")
        print(json.dumps(identity), flush=True)
        for _ in range(args.repeat):
            device.write(b"TEST\n")
            result = receive(device, "radio-test")
            results.append(result)
            print(json.dumps(result), flush=True)
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(json.dumps({"identity": identity, "tests": results}, indent=2) + "\n")
    passed = all(r.get("ok") is True and r.get("device_id") == "deca0302" and r.get("stage") == "ready" for r in results)
    print("PASS: DWM3000 device ID, driver initialization and RX enable" if passed else "FAIL: radio self-test; inspect device_id and stage", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, serial.SerialException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)

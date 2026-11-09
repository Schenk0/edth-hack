#!/usr/bin/env python3
"""Verify a three-node relative room layout through one USB observer or a recording."""
import argparse
import json
import math
from pathlib import Path
import re
import sys
import time


FRAME = "relative-n1-n2-positive-y"
MAX_AGE_MS = 6000
MAX_SAMPLES = 20000
NODES = ("N1", "N2", "N3")
EDGES = ((1, 2), (1, 3), (2, 3))


def integer(value, low=0, high=0xFFFFFFFF):
    return type(value) is int and low <= value <= high


def coordinate(value):
    return type(value) in (int, float) and math.isfinite(value) and -1000 <= value <= 1000


class RoomState:
    def __init__(self):
        self.identity = None
        self.boots = {}
        self.versions = {}
        self.ranges = {}
        self.reports = {}
        self.receivers = set()

    def ingest(self, line, at_ms):
        try:
            data = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            return  # CDC can open partway through a line.
        if not isinstance(data, dict) or type(data.get("v")) is not int or data["v"] != 1:
            return
        kind = data.get("type")
        if kind not in ("identity", "measurement", "report"):
            return  # Diagnostic boot fields can identify an exchange, not a node.
        source = data.get("source")
        if source not in NODES or not integer(data.get("boot"), 1):
            raise RuntimeError(f"Invalid {kind} node or boot generation")
        if not integer(data.get("usb_delay_ms", 0), high=2**53 - 1):
            raise RuntimeError(f"Invalid {kind} USB delay")
        if kind == "identity":
            if (data.get("geometry") != "relative-triangle" or not integer(data.get("wire_version"), 2, 2)
                    or not integer(data.get("setup_version"), 1, 1)):
                raise RuntimeError("Room firmware with geometry relative-triangle and wire version 2 is required")
            if (not integer(data.get("node_id"), 1, 3) or data["node_id"] != int(source[1])
                    or data.get("radio_ready") is not True
                    or not isinstance(data.get("board_id"), str)
                    or not re.fullmatch(r"[0-9A-Fa-f]{16}", data["board_id"])):
                raise RuntimeError("Connected board must have an assigned unique ID and a ready radio")
            if self.identity:
                previous = self.identity[0]
                if (data["board_id"], source) != (previous["board_id"], previous["source"]):
                    raise RuntimeError("Connected board identity changed during capture")
            if not self.observe_boot(source, data["boot"]):
                return
            if self.receivers - {source}:
                raise RuntimeError("Recording contains more than one USB observer")
            self.identity = data, at_ms
            return
        if (data.get("receiver") not in NODES or not integer(data.get("seq"), 1)
                or not integer(data.get("age_ms"), high=MAX_AGE_MS - 1)
                or not integer(data.get("hops"), high=4)):
            raise RuntimeError(f"Invalid {kind} receiver, sequence or age")
        if self.identity and data["receiver"] != self.identity[0]["source"]:
            raise RuntimeError("Data was logged by a different USB observer")
        self.receivers.add(data["receiver"])
        if kind == "measurement":
            edge = data.get("a"), data.get("b")
            if (data.get("kind") != "range" or data.get("mode") != "live"
                    or not all(integer(endpoint, 1, 3) for endpoint in edge) or edge not in EDGES
                    or source != f"N{edge[0]}" or not integer(data.get("value_mm"), 1, 1000000)):
                raise RuntimeError("Invalid room range record")
            key, table = edge, self.ranges
        else:
            status = data.get("status")
            positioned = status in ("reference", "relative")
            if (data.get("coordinate_frame") != FRAME or data.get("reflection_ambiguous") is not True
                    or data.get("calibrated") is not False or data.get("residual_m") is not None
                    or status not in ("reference", "relative", "missing-measurements", "inconsistent-ranges", "poor-geometry")):
                raise RuntimeError("Invalid room report frame or status")
            if positioned:
                x, y = data.get("x_m"), data.get("y_m")
                if not coordinate(x) or not coordinate(y):
                    raise RuntimeError("Invalid room report coordinates")
                expected = (status == "reference" and x == 0 and y == 0 if source == "N1" else
                            status == "relative" and x > 0 and y == 0 if source == "N2" else
                            status == "relative" and y > 0)
                if not expected:
                    raise RuntimeError(f"{source} violates the relative coordinate convention")
            elif data.get("x_m") is not None or data.get("y_m") is not None:
                raise RuntimeError("Unresolved report contains coordinates")
            key, table = source, self.reports
        if not self.observe_boot(source, data["boot"]):
            return
        version = data["boot"], data["seq"]
        record_key = kind, key
        if version <= self.versions.get(record_key, (0, 0)):
            return
        self.versions[record_key] = version
        table[key] = data, at_ms

    def observe_boot(self, source, boot):
        previous = self.boots.get(source, 0)
        if boot < previous:
            return False
        if boot > previous:
            self.boots[source] = boot
            self.reports.pop(source, None)
            for key in [key for key, entry in self.ranges.items() if entry[0]["source"] == source]:
                del self.ranges[key]
        return True

    @staticmethod
    def age(entry, now_ms):
        data, received_ms = entry
        return data.get("age_ms", 0) + data.get("usb_delay_ms", 0) + now_ms - received_ms

    def result(self, now_ms):
        issues, ranges, reports = [], {}, {}
        if not self.identity or self.age(self.identity, now_ms) >= MAX_AGE_MS:
            issues.append("Connected room identity is missing or stale")
        for edge in EDGES:
            label = f"N{edge[0]}-N{edge[1]}"
            entry = self.ranges.get(edge)
            if not entry or self.age(entry, now_ms) >= MAX_AGE_MS:
                issues.append(f"{label} range is missing or stale")
            else:
                ranges[label] = {"distance_m": entry[0]["value_mm"] / 1000, "age_ms": self.age(entry, now_ms)}
        for source in NODES:
            entry = self.reports.get(source)
            if not entry or self.age(entry, now_ms) >= MAX_AGE_MS:
                issues.append(f"{source} report is missing or stale")
            elif entry[0]["status"] not in ("reference", "relative"):
                issues.append(f"{source} reports {entry[0]['status']}")
            else:
                reports[source] = {key: entry[0][key] for key in ("status", "x_m", "y_m", "boot", "seq")}
                reports[source]["age_ms"] = self.age(entry, now_ms)
        return {"passed": not issues, "issues": issues, "coordinate_frame": FRAME,
                "reflection_ambiguous": True, "ranges": ranges, "node_reports": reports,
                "accuracy_validated": False}


def replay(recording):
    if (not isinstance(recording, dict) or recording.get("version") != 1
            or not integer(recording.get("duration_ms"), high=120000)
            or not isinstance(recording.get("samples"), list) or len(recording["samples"]) > MAX_SAMPLES):
        raise RuntimeError("Invalid room recording")
    if "wall_duration_ms" in recording:
        wall = recording["wall_duration_ms"]
        if not integer(wall, high=2**53 - 1) or abs(wall - recording["duration_ms"]) > 2000:
            raise RuntimeError("Capture timing was interrupted by sleep or a clock change; raw data is preserved, but readiness cannot be verified")
    state, previous = RoomState(), 0
    for sample in recording["samples"]:
        if (not isinstance(sample, dict) or not integer(sample.get("at_ms"), previous, recording["duration_ms"])
                or not isinstance(sample.get("line"), str) or len(sample["line"]) > 2048):
            raise RuntimeError("Invalid room recording sample or timestamp order")
        previous = sample["at_ms"]
        state.ingest(sample["line"], previous)
    return state.result(recording["duration_ms"])


def capture(args):
    try:
        import serial
        from serial.tools import list_ports
    except ImportError as error:
        raise RuntimeError("Install pyserial for USB capture; offline replay needs only Python") from error
    ports = [p for p in list_ports.comports() if p.vid == 0x2E8A and p.pid == 9
             and (not args.port or p.device == args.port)]
    if len(ports) != 1:
        raise RuntimeError(f"Expected one USB observer; found {len(ports)}. Use --port to select one.")
    recording = {"version": 1, "port": ports[0].device, "duration_ms": args.seconds * 1000, "samples": []}
    try:
        with serial.Serial(ports[0].device, 115200, timeout=0) as device:
            device.dtr = True
            device.write(b"GET\n")
            start, wall_start, buffer = time.monotonic(), time.time(), b""
            while time.monotonic() - start < args.seconds:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                wall_ms = int((time.time() - wall_start) * 1000)
                if abs(wall_ms - elapsed_ms) > 2000:
                    recording["duration_ms"] = min(args.seconds * 1000, elapsed_ms)
                    break
                buffer += device.read(8192)
                if len(buffer) > 65536:
                    raise RuntimeError("USB input exceeded the serial line limit")
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    if len(raw) > 2048:
                        raise RuntimeError("USB input contains an oversized serial line")
                    recording["samples"].append({"at_ms": min(args.seconds * 1000, int((time.monotonic() - start) * 1000)),
                                                 "line": raw.decode(errors="replace")})
                    if len(recording["samples"]) > MAX_SAMPLES:
                        raise RuntimeError("USB recording exceeded the sample limit")
                time.sleep(0.005)
            recording["wall_duration_ms"] = int((time.time() - wall_start) * 1000)
    except serial.SerialException as error:
        raise RuntimeError(f"USB capture failed: {error}") from error
    return recording


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--port", help="One USB observer, for example /dev/cu.usbmodem101")
    source.add_argument("--recording", type=Path, help="Replay a saved room capture without accessing USB")
    parser.add_argument("--seconds", type=int, default=25, choices=range(5, 121), metavar="5..120")
    parser.add_argument("--log", type=Path, help="Save the timestamped capture and final summary as JSON")
    args = parser.parse_args()
    if args.recording:
        if args.recording.stat().st_size > 20 * 1024 * 1024:
            raise RuntimeError("Room recording exceeds 20 MB")
        recording = json.loads(args.recording.read_text())
    else:
        recording = capture(args)
    if args.log:
        if args.recording and args.log.resolve() == args.recording.resolve():
            raise RuntimeError("Use a different --log path to preserve the source recording")
        args.log.parent.mkdir(parents=True, exist_ok=True)
        # Preserve the capture even if schema validation fails during replay.
        args.log.write_text(json.dumps(recording, indent=2) + "\n")
    summary = replay(recording)
    if args.log:
        args.log.write_text(json.dumps({**recording, "summary": summary}, indent=2) + "\n")
    print(json.dumps(summary, indent=2), flush=True)
    print("PASS: fresh ranges and node-reported relative layout; physical accuracy is unverified" if summary["passed"] else
          "FAIL: room layout is not ready; see issues above", flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/test-room.py"
spec = importlib.util.spec_from_file_location("room_verifier", SCRIPT)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def fixture():
    records = [{"v": 1, "type": "identity", "source": "N1", "node_id": 1, "board_id": "1598712C6E2499A8",
                "boot": 7, "geometry": "relative-triangle", "wire_version": 2, "setup_version": 1, "radio_ready": True}]
    for a, b, distance in [(1, 2, 4000), (1, 3, 5000), (2, 3, 7000)]:
        records.append({"v": 1, "type": "measurement", "kind": "range", "mode": "live", "receiver": "N1",
                        "source": f"N{a}", "a": a, "b": b, "value_mm": distance, "boot": 7 if a == 1 else 3,
                        "seq": b, "age_ms": 100, "hops": 0 if a == 1 else 1, "usb_delay_ms": 10})
    for node, x, y, boot in [(1, 0, 0, 7), (2, 4, 0, 3), (3, -1, 4.899, 4)]:
        records.append({"v": 1, "type": "report", "receiver": "N1", "source": f"N{node}", "boot": boot,
                        "seq": 10, "age_ms": 0, "hops": 0 if node == 1 else 1, "status": "reference" if node == 1 else "relative",
                        "x_m": x, "y_m": y, "residual_m": None, "coordinate_frame": verifier.FRAME,
                        "reflection_ambiguous": True, "calibrated": False})
    return {"version": 1, "duration_ms": 1000,
            "samples": [{"at_ms": 100, "line": json.dumps(record)} for record in records]}


class RoomVerifierTest(unittest.TestCase):
    def test_fresh_layout_and_offline_cli(self):
        recording = fixture()
        result = verifier.replay(recording)
        self.assertTrue(result["passed"], result["issues"])
        self.assertEqual(set(result["ranges"]), {"N1-N2", "N1-N3", "N2-N3"})
        self.assertEqual(result["node_reports"]["N3"]["x_m"], -1)
        self.assertFalse(result["accuracy_validated"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            path.write_text(json.dumps(recording))
            run = subprocess.run([sys.executable, str(SCRIPT), "--recording", str(path)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("physical accuracy is unverified", run.stdout)
            recording["duration_ms"] = 6200
            path.write_text(json.dumps(recording))
            run = subprocess.run([sys.executable, str(SCRIPT), "--recording", str(path)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, run.stderr)
            self.assertIn("missing or stale", run.stdout)

    def test_trailing_silence_and_usb_delay_expire_data(self):
        recording = fixture()
        recording["duration_ms"] = 6200
        self.assertFalse(verifier.replay(recording)["passed"])
        recording = fixture()
        line = json.loads(recording["samples"][3]["line"])
        line["usb_delay_ms"] = 5500
        recording["samples"][3]["line"] = json.dumps(line)
        self.assertIn("N2-N3 range is missing or stale", verifier.replay(recording)["issues"])

    def test_host_sleep_invalidates_timing_and_cli_preserves_raw_capture(self):
        recording = fixture()
        recording["wall_duration_ms"] = 107000
        with self.assertRaisesRegex(RuntimeError, "sleep or a clock change"):
            verifier.replay(recording)
        with tempfile.TemporaryDirectory() as directory:
            source, saved = Path(directory) / "source.json", Path(directory) / "saved.json"
            source.write_text(json.dumps(recording))
            run = subprocess.run([sys.executable, str(SCRIPT), "--recording", str(source), "--log", str(saved)],
                                 capture_output=True, text=True)
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertEqual(json.loads(saved.read_text()), recording)
        recording["wall_duration_ms"] = 1005
        self.assertTrue(verifier.replay(recording)["passed"])

    def test_old_boot_duplicates_and_exchange_diagnostics_cannot_revive_layout(self):
        recording = fixture()
        identity = json.loads(recording["samples"][0]["line"])
        identity["boot"] = 8
        late = [{"at_ms": 500, "line": json.dumps(identity)},
                {"at_ms": 600, "line": json.dumps({"v": 1, "type": "radio-quality", "source": "N2", "boot": 99})}]
        late.extend({"at_ms": 700, "line": sample["line"]} for sample in recording["samples"][1:])
        recording["samples"].extend(late)
        result = verifier.replay(recording)
        self.assertFalse(result["passed"])
        self.assertIn("N1-N2 range is missing or stale", result["issues"])
        self.assertIn("N1 report is missing or stale", result["issues"])
        self.assertIn("N2", result["node_reports"])
        duplicate = fixture()
        duplicate["samples"].extend({"at_ms": 5900, "line": s["line"]} for s in copy.deepcopy(duplicate["samples"][1:]))
        duplicate["duration_ms"] = 6200
        self.assertFalse(verifier.replay(duplicate)["passed"])

    def test_unsolved_reports_missing_edge_and_wrong_frame_fail(self):
        recording = fixture()
        recording["samples"].pop(2)  # No N1-N3 edge.
        self.assertFalse(verifier.replay(recording)["passed"])
        recording = fixture()
        report = json.loads(recording["samples"][-1]["line"])
        report.update(seq=11, status="poor-geometry", x_m=None, y_m=None)
        recording["samples"].append({"at_ms": 900, "line": json.dumps(report)})
        self.assertIn("N3 reports poor-geometry", verifier.replay(recording)["issues"])
        report["coordinate_frame"] = "room-walls"
        recording["samples"][-1]["line"] = json.dumps(report)
        with self.assertRaisesRegex(RuntimeError, "frame or status"):
            verifier.replay(recording)


if __name__ == "__main__":
    unittest.main()

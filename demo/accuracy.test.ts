import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeStationary, referenceTriangle, type Recording, type NodeId } from './accuracy.ts';

const identity = (source: NodeId = 'N2', boot = 1) => ({ v: 1, type: 'identity', source, board_id: 'TEST', boot,
  network: 60785, line_length_mm: 0, channel: 5, tx_power: 'fdfdfdfd', tx_ant_delay: 16387,
  rx_ant_delay: 16387, geometry: 'relative-triangle', wire_version: 2, radio_ready: true });
const range = (a = 1, b = 2, seq = 1, value_mm = 4000, extra = {}) => ({ v: 1, type: 'measurement', source: `N${a}`,
  receiver: 'N2', boot: 1, seq, age_ms: 0, usb_delay_ms: 0, hops: 0, mode: 'live', kind: 'range', a, b, value_mm, ...extra });
const report = (source: NodeId = 'N2', seq = 1, x_m = 4, y_m = 0, extra = {}) => ({ v: 1, type: 'report', source,
  receiver: 'N2', boot: 1, seq, age_ms: 0, usb_delay_ms: 0, hops: 0, status: source === 'N1' ? 'reference' : 'relative',
  coordinate_frame: 'relative-n1-n2-positive-y', reflection_ambiguous: true, residual_m: null, calibrated: false, x_m, y_m, ...extra });
const sample = (at_ms: number, value: unknown) => ({ at_ms, line: JSON.stringify(value) });
const close = (actual: number | null | undefined, expected: number) => {
  assert.equal(typeof actual, 'number');
  assert(Math.abs(actual! - expected) < 1e-9, `${actual} != ${expected}`);
};
function set(atMs: number, seq = 1) {
  return [range(1, 2, seq), range(1, 3, seq, 3000), range(2, 3, seq, 5000),
    report('N1', seq, 0), report('N2', seq, 4), report('N3', seq, 0, 3)].map(value => sample(atMs, value));
}

test('measured triangle and raw samples separate repeatability, bias and error without fitting', () => {
  const recording: Recording = { version: 1, duration_ms: 3000, samples: [sample(0, identity())] };
  for (const [seq, atMs, x] of [[1, 500, 4.1], [2, 1500, 4.2], [3, 2500, 4.3]]) {
    recording.samples.push(...[range(1, 2, seq, x * 1000), range(1, 3, seq, 3100), range(2, 3, seq, 5100),
      report('N1', seq, 0), report('N2', seq, x), report('N3', seq, seq === 1 ? .1 : seq === 3 ? -.1 : 0, seq === 2 ? 3.1 : 3)]
      .map(value => sample(atMs, value)));
  }
  const result = analyzeStationary(recording, { settleMs: 0, reference: { n1n2M: 4, n1n3M: 3, n2n3M: 5 } });
  const r = result.ranges[0], n1 = result.nodes[0], n2 = result.nodes[1], n3 = result.nodes[2];
  assert.equal(r.count, 3); close(r.medianM, 4.2); close(r.stdDevM, .1);
  close(r.p95RadiusM, .1); close(r.accuracy?.biasM, .2); close(r.accuracy?.rmseM, Math.sqrt(.14 / 3));
  close(r.accuracy?.p95ErrorM, .29);
  assert.equal(n1.constrained, true); assert.equal(n1.accuracy, null);
  close(n2.stdXM, .1); close(n2.stdYM, 0); close(n2.firstLastShiftM, .2);
  close(n2.accuracy?.rmseM, Math.sqrt(.14 / 3)); close(n3.accuracy?.meanErrorM, .1);
  close(n3.median?.xM, 0); close(n3.median?.yM, 3); close(n3.p95RadiusM, .1);
  close(result.availability.fraction, 2500 / 3000);
  assert.equal(result.observer, 'N2');
});

test('duplicate, stale and retired-boot data do not inflate unique range or position counts', () => {
  const recording: Recording = { version: 1, duration_ms: 3000, samples: [sample(0, identity('N1')),
    sample(100, range(1, 2, 1, 4000, { receiver: 'N1' })),
    sample(200, report('N2', 1, 4, 0, { receiver: 'N1' })),
    sample(300, range(1, 2, 1, 9000, { receiver: 'N1' })),
    sample(400, report('N2', 1, 9, 0, { receiver: 'N1' })),
    sample(500, range(1, 2, 2, 8000, { receiver: 'N1', age_ms: 5999, usb_delay_ms: 1 })),
    sample(600, report('N2', 2, 8, 0, { receiver: 'N1', age_ms: 5999, usb_delay_ms: 1 })),
    sample(1000, identity('N1', 2)),
    sample(1100, range(1, 2, 1, 4200, { receiver: 'N1', boot: 2 })),
    sample(1200, report('N2', 1, 4.2, 0, { receiver: 'N1', boot: 2 })),
    sample(1300, range(1, 2, 999, 7000, { receiver: 'N1', boot: 1 })),
    sample(1400, report('N2', 999, 7, 0, { receiver: 'N1', boot: 1 }))] };
  const result = analyzeStationary(recording, { settleMs: 0 });
  assert.equal(result.ranges[0].count, 2); assert.equal(result.nodes[1].count, 2);
  close(result.ranges[0].medianM, 4.1); close(result.nodes[1].median?.xM, 4.1);
  assert(result.warnings.some(warning => warning.includes('restarted')));
});

test('origin age, USB queuing and settling exclude delayed payloads from the measured window', () => {
  const recording: Recording = { version: 1, duration_ms: 9000, samples: [sample(0, identity()),
    sample(6000, range(1, 2, 1, 9000, { age_ms: 2000 })),
    sample(6000, report('N2', 1, 9, 0, { age_ms: 2000 })),
    sample(7000, range(1, 2, 2, 4100, { age_ms: 1000 })),
    sample(7000, report('N2', 2, 4.1, 0, { age_ms: 1000 })),
    sample(7100, range(1, 2, 3, 8000, { age_ms: 2000, usb_delay_ms: 300 })),
    sample(7100, report('N2', 3, 8, 0, { age_ms: 2000, usb_delay_ms: 300 }))] };
  const result = analyzeStationary(recording);
  assert.equal(result.ranges[0].count, 1); assert.equal(result.nodes[1].count, 1);
  close(result.ranges[0].medianM, 4.1); close(result.nodes[1].median?.xM, 4.1);
  assert.equal(result.nodes[1].stdXM, null);
});

test('availability integrates exact expiry and includes trailing silence rather than counting rows', () => {
  const recording: Recording = { version: 1, samples: [sample(0, identity()), ...set(0)] };
  const result = analyzeStationary(recording, { settleMs: 0, endMs: 10000 });
  close(result.availability.readyMs, 6000); close(result.availability.totalMs, 10000); close(result.availability.fraction, .6);
  assert.equal(analyzeStationary({ version: 1, duration_ms: 10000, samples: [] }, { settleMs: 0 }).availability.fraction, 0);
  assert.equal(analyzeStationary({ version: 1, duration_ms: 1000, samples: [] }).availability.fraction, null);
});

test('explicit capture duration preserves initial silence before the first serial line', () => {
  const result = analyzeStationary({ version: 1, duration_ms: 20000,
    samples: [sample(10000, identity()), ...set(10000)] });
  close(result.durationMs, 20000); close(result.availability.totalMs, 15000);
  close(result.availability.readyMs, 6000); close(result.availability.fraction, .4);
});

test('sleep or a wall-clock jump invalidates compressed capture timing', () => {
  const recording: Recording = { version: 1, duration_ms: 60000, samples: [sample(0, identity()), ...set(55000)] };
  for (const wall_duration_ms of [166000, 50000]) {
    assert.throws(() => analyzeStationary({ ...recording, wall_duration_ms }), /interrupted by sleep or a clock change/);
  }
  assert.doesNotThrow(() => analyzeStationary({ ...recording, wall_duration_ms: 60010 }));
  assert.doesNotThrow(() => analyzeStationary({ ...recording, duration_ms: 65000, wall_duration_ms: 65010 }));
  assert.doesNotThrow(() => analyzeStationary(recording));
});

test('offline CLI retains wall-clock metadata and rejects an interrupted recording', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-capture-'));
  try {
    const filename = join(directory, 'capture.json');
    writeFileSync(filename, JSON.stringify({ version: 1, duration_ms: 60000, wall_duration_ms: 166000, samples: [] }));
    const cli = fileURLToPath(new URL('../node-firmware/scripts/analyze-room.ts', import.meta.url));
    const result = spawnSync(process.execPath, [cli, filename], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /interrupted by sleep or a clock change/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unresolved reports withdraw availability immediately; diagnostics cannot change node boot', () => {
  const recording: Recording = { version: 1, duration_ms: 3000, samples: [sample(0, identity()), ...set(0),
    sample(1000, { v: 1, type: 'radio-health', ok: false, boot: 999 }),
    sample(2000, report('N3', 2, 0, 0, { status: 'inconsistent-ranges', x_m: null, y_m: null }))] };
  const result = analyzeStationary(recording, { settleMs: 0 });
  close(result.availability.readyMs, 2000); assert.equal(result.nodes[2].count, 1);
  assert(!result.warnings.some(warning => warning.includes('restarted')));
});

test('reference distances and recording bounds are validated, while negative N3 x remains valid', () => {
  const point = referenceTriangle({ n1n2M: 3, n1n3M: 5, n2n3M: 7 }).N3;
  close(point.xM, -2.5); assert(point.yM > 0);
  for (const ref of [{ n1n2M: 1, n1n3M: 1, n2n3M: 2 }, { n1n2M: 1, n1n3M: 1, n2n3M: 3 },
    { n1n2M: 0, n1n3M: 1, n2n3M: 1 }, { n1n2M: NaN, n1n3M: 1, n2n3M: 1 }]) assert.throws(() => referenceTriangle(ref));
  assert.throws(() => analyzeStationary({ version: 1, samples: [sample(2, identity()), sample(1, identity())] }));
  assert.throws(() => analyzeStationary({ version: 1, duration_ms: 1, samples: [sample(2, identity())] }));
  assert.throws(() => analyzeStationary({ version: 1, samples: [] }, { startMs: 2, endMs: 1 }));
});

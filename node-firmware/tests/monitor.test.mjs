import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, Lines, parseLine, parseSession, fresh, age, ROOM_FRAME } from '../monitor/model.js';
const report = (extra = {}) => ({ v: 1, type: 'report', source: 'N2', receiver: 'N1', boot: 2, seq: 3, status: 'located', x_m: 4, y_m: 0, residual_m: 0.01, hops: 1, age_ms: 100, calibrated: false, ...extra });
const measurement = (extra = {}) => ({ v: 1, type: 'measurement', kind: 'range', source: 'N1', receiver: 'N1', a: 1, b: 2, boot: 1, seq: 1, value_mm: 4000, age_ms: 20, hops: 0, mode: 'live', ...extra });
const send = (m, d, now = 0) => m.ingest(JSON.stringify(d), now);
const identity = (extra = {}) => ({ v: 1, type: 'identity', source: 'N1', node_id: 1, setup_version: 1, board_id: 'ROOM-BOARD', boot: 10,
  network: 60785, line_length_mm: 0, channel: 5, tx_power: 'fdfdfdfd', tx_ant_delay: 16387, rx_ant_delay: 16354,
  geometry: 'relative-triangle', wire_version: 2, radio_ready: true, ...extra });
const roomReport = (extra = {}) => report({ source: 'N3', boot: 4, seq: 1, status: 'relative', x_m: -1, y_m: 3,
  coordinate_frame: ROOM_FRAME, reflection_ambiguous: true, residual_m: null, ...extra });
const layout = (extra = {}) => ({ v: 1, type: 'layout', source: 'N1', receiver: 'N1', boot: 10, seq: 1,
  status: 'relative', age_ms: 100, hops: 0, coordinate_frame: ROOM_FRAME, reflection_ambiguous: true, calibrated: false,
  positions: [{ id: 'N1', x_m: 0, y_m: 0 }, { id: 'N2', x_m: 4, y_m: 0 }, { id: 'N3', x_m: -1, y_m: 3 }],
  ranges_mm: [4000, 3162, 5831], ...extra });
test('complete layouts accept only direct USB relative triangles or explicit withdrawal', () => {
  assert(parseLine(JSON.stringify(layout())));
  for (const status of ['missing-measurements', 'inconsistent-ranges', 'poor-geometry'])
    assert(parseLine(JSON.stringify(layout({ status, positions: null, ranges_mm: null }))));
  for (const extra of [{ receiver: 'N2' }, { hops: 1 }, { coordinate_frame: 'legacy-line' },
    { reflection_ambiguous: false }, { calibrated: true }, { status: 'reference' }, { status: 'poor-geometry' },
    { positions: null }, { positions: [] }, { positions: [null, null, null] },
    { positions: [{ id: 'N1', x_m: 0, y_m: 0 }, { id: 'N2', x_m: 4, y_m: 0 }, { id: 'N2', x_m: -1, y_m: 3 }] },
    { positions: layout().positions.map(p => p.id === 'N2' ? { ...p, y_m: 1 } : p) },
    { positions: layout().positions.map(p => p.id === 'N3' ? { ...p, y_m: 0 } : p) },
    { positions: layout().positions.map(p => p.id === 'N3' ? { ...p, x_m: '1' } : p) },
    { ranges_mm: null }, { ranges_mm: [4000, 3162] }, { ranges_mm: [4000, -1, 5831] },
    { ranges_mm: [4000, 3162, 5831.5] }, { age_ms: 6000 }, { usb_delay_ms: -1 }])
    assert.equal(parseLine(JSON.stringify(layout(extra))), null, JSON.stringify(extra));
  assert(parseLine(JSON.stringify(identity({ layout_version: 1 }))));
  for (const layout_version of [0, 2, '1', null]) assert.equal(parseLine(JSON.stringify(identity({ layout_version }))), null);
});
test('layout ordering, expiry, withdrawal and generations cannot preserve stale triangles', () => {
  const m = new Monitor(0);
  assert(send(m, identity({ layout_version: 1 })));
  assert(send(m, layout()));
  assert(fresh(m.layout, 5899));
  assert(!send(m, layout(), 5900));
  assert(!fresh(m.layout, 5900));
  assert(send(m, layout({ seq: 2, status: 'inconsistent-ranges', positions: null, ranges_mm: null }), 6000));
  assert.equal(m.layout.data.positions, null);
  assert(!send(m, layout({ seq: 1 }), 6001));
  assert(send(m, layout({ seq: 3, usb_delay_ms: 6000 }), 6002));
  assert(!fresh(m.layout, 6002));
  assert(!send(m, layout({ source: 'N2', receiver: 'N2', boot: 999 }), 6003));
  assert.equal(m.boots.has('N2'), false);
  assert(send(m, roomReport({ boot: 4 }), 6010));
  assert.equal(m.layout, null);
  assert(send(m, layout({ seq: 4 }), 6011));
  assert(send(m, roomReport({ boot: 5 }), 6012));
  assert.equal(m.layout, null);
  assert(send(m, layout({ seq: 5 }), 6013));
  assert(send(m, identity({ boot: 11, layout_version: 1 }), 6020));
  assert.equal(m.layout, null);
  assert(!send(m, layout({ seq: 99 }), 6021));
});
test('network, USB source and coordinate frame changes clear complete layouts', () => {
  const m = new Monitor(0);
  assert(send(m, identity({ layout_version: 1 })));
  assert(send(m, layout()));
  assert(send(m, identity({ network: 42, layout_version: 1 }), 1));
  assert.equal(m.layout, null);
  assert(send(m, layout({ seq: 2 }), 2));
  assert(send(m, identity({ source: 'N2', node_id: 2, boot: 1, network: 42, layout_version: 1 }), 3));
  assert.equal(m.layout, null);
  assert(send(m, layout({ source: 'N2', receiver: 'N2', boot: 1 }), 4));
  assert(send(m, identity({ source: 'N2', node_id: 2, boot: 2, network: 42, geometry: undefined, wire_version: undefined }), 5));
  assert.equal(m.layout, null);
  assert(!send(m, layout({ source: 'N2', receiver: 'N2', boot: 999 }), 6));
  assert.equal(m.boots.get('N2'), 2);
});
test('room reports retain a signed relative frame and explicit mirror ambiguity', () => {
  assert(parseLine(JSON.stringify(roomReport())));
  assert(parseLine(JSON.stringify(roomReport({ source: 'N1', status: 'reference', x_m: 0, y_m: 0 }))));
  assert(parseLine(JSON.stringify(roomReport({ source: 'N2', x_m: 4, y_m: 0 }))));
  assert(parseLine(JSON.stringify(roomReport({ status: 'poor-geometry', x_m: null, y_m: null }))));
  for (const extra of [{ coordinate_frame: 'room-wall-frame' }, { coordinate_frame: undefined }, { reflection_ambiguous: false },
    { residual_m: 0 }, { source: 'N1', status: 'reference' }, { source: 'N2', y_m: 1 }, { y_m: 0 },
    { status: 'poor-geometry' }, { x_m: -1001 }, { y_m: null }]) assert.equal(parseLine(JSON.stringify(roomReport(extra))), null);
  assert(parseLine(JSON.stringify(identity())));
  assert.equal(parseLine(JSON.stringify(identity({ wire_version: 1 }))), null);
});
test('all three ranges retain independent histories and expire with their original age', () => {
  const m = new Monitor(0);
  assert(send(m, identity()));
  for (const [a, b, boot, seq] of [[1, 2, 10, 1], [1, 3, 10, 2], [2, 3, 5, 1]])
    assert(send(m, measurement({ source: `N${a}`, a, b, boot, seq })));
  assert.equal(m.history.get('N1-N3').length, 1);
  assert(fresh(m.measurements.get('N1-N3'), 5979));
  assert(!fresh(m.measurements.get('N1-N3'), 5980));
  assert(send(m, measurement({ boot: 11, seq: 1 }), 6000));
  assert(!m.measurements.has('N1-N3'));
  assert.equal(m.history.get('N1-N3').length, 0);
  assert(m.measurements.has('N2-N3'));
});
test('legacy reports cannot poison the active relative frame or advance its node generations', () => {
  const m = new Monitor(0);
  assert(send(m, identity()));
  assert(send(m, roomReport()));
  assert(!send(m, report({ source: 'N3', boot: 999, seq: 99 })));
  assert.equal(m.boots.get('N3'), 4);
  assert.equal(m.reports.get('N3').data.x_m, -1);
  assert(send(m, identity({ boot: 11, geometry: undefined, wire_version: undefined, line_length_mm: 10000 })));
  assert.equal(m.reports.size, 0);
  assert.equal(m.coordinateFrame, 'legacy-line');
  assert(send(m, report({ source: 'N3', boot: 2 })));
  assert(!send(m, roomReport({ boot: 1000 })));
  assert.equal(m.boots.get('N3'), 2);
});
test('radio quality retains the exchange boot without replacing the reporting node boot', () => {
  const m = new Monitor(0);
  assert(send(m, report({ boot: 6 })));
  const quality = { v: 1, type: 'radio-quality', source: 'N2', peer: 'N1', frame: 'final',
    boot: 26, seq: 219, age_ms: 411, valid: true, rssi_dbm: -80.2, first_path_dbm: -88.91,
    cir_power: 89, f1: 7719, f2: 8875, f3: 16299, accum_count: 115, dgc: 0,
    fp_index_q6: 47440, read_us: 159, rx_status: '00006f70', usb_delay_ms: 2 };
  assert(send(m, quality, 1));
  assert.equal(m.boots.get('N2'), 6);
  assert(send(m, report({ boot: 6, seq: 4 }), 2));
  assert.equal(m.invalid, 0);
  assert.equal(parseLine(JSON.stringify({ ...quality, rssi_dbm: null })), null);
  assert(parseLine(JSON.stringify({ ...quality, valid: false, rssi_dbm: null, first_path_dbm: null })));
  assert(send(m, { v: 1, type: 'radio-health', status: '00000070', state: '01170500',
    fast_errors: 0, slow_errors: 0, reads_per_rate: 256 }, 3));
});
test('stale and duplicate reports never keep a position alive', () => {
  const m = new Monitor(0);
  assert(send(m, report()));
  assert(fresh(m.reports.get('N2'), 5899));
  assert(!send(m, report(), 5900));
  assert.equal(age(m.reports.get('N2'), 5900), 6000);
  assert(!fresh(m.reports.get('N2'), 5900));
  assert(send(m, report({ seq: 4, status: 'missing-measurements', x_m: null, y_m: null }), 6000));
  assert.equal(m.reports.get('N2').data.x_m, null);
});
test('restart invalidates prior positions and ranges; old boots cannot return', () => {
  const m = new Monitor(0);
  send(m, report({ source: 'N1' })); send(m, measurement({ boot: 2 }));
  assert.equal(m.history.get('N1-N2').length, 1);
  assert(send(m, measurement({ boot: 3, seq: 1 }), 10));
  assert(!m.reports.has('N1'));
  assert.equal(m.history.get('N1-N2').length, 1);
  assert(!send(m, report({ source: 'N1', boot: 2, seq: 99 }), 20));
});
test('serial framing survives split chunks and rejects an entire oversized line', () => {
  const lines = new Lines(), output = [];
  lines.feed('{"v":', line => output.push(line));
  lines.feed('1}\r\nnext\n', line => output.push(line));
  assert.deepEqual(output, ['{"v":1}', 'next']);
  lines.feed('x'.repeat(3000) + '{"v":1}\nvalid\n', line => output.push(line));
  assert.equal(output.at(-2), '! Discarded oversized serial line');
  assert.equal(output.at(-1), 'valid');
});
test('malformed values cannot become positions or code', () => {
  for (const extra of [{ x_m: '4' }, { x_m: -1 }, { source: ['N2'] }, { age_ms: 6000 }, { boot: 0 }, { hops: 5 }, { status: 'invented' }, { calibrated: true }])
    assert.equal(parseLine(JSON.stringify(report(extra))), null);
  assert.equal(parseLine('null'), null);
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine(JSON.stringify(measurement({ b: 1 }))), null);
});
test('session export and replay retain origin age and timing', () => {
  const m = new Monitor(500);
  send(m, report(), 600); send(m, report({ seq: 4 }), 900);
  const session = parseSession(JSON.stringify(m.exportSession()));
  const replay = new Monitor(0);
  for (const s of session.samples) replay.ingest(s.line, s.at_ms);
  assert.equal(age(replay.reports.get('N2'), 1000), 700);
  assert.deepEqual(session.samples.map(s => s.at_ms), [100, 400]);
  assert.throws(() => parseSession(JSON.stringify({ ...session, samples: [...session.samples].reverse() })));
  assert.throws(() => parseSession('{"version":1}'));
});

test('USB backpressure delay counts toward freshness and uptime supports long-running nodes', () => {
  const m = new Monitor(0);
  assert(send(m, report({ usb_delay_ms: 6000 })));
  assert(!fresh(m.reports.get('N2'), 0));
  assert.equal(age(m.reports.get('N2'), 0), 6100);
  assert.equal(parseLine(JSON.stringify(report({ usb_delay_ms: -1 }))), null);
  assert.equal(parseLine(JSON.stringify(report({ usb_delay_ms: '1' }))), null);
  assert(send(m, { v:1, type:'diagnostics', source:'N1', uptime_ms: 2 ** 32 + 100,
    ranges_ok:1, ranges_failed:0, accepted:1, rejected:0, rx_errors:0, tx_errors:0, usb_dropped:2 }));
});

test('radio self-test output is accepted for an unassigned board', () => {
  const m = new Monitor(0);
  const result = {v:1, type:'radio-test', ok:false, device_id:'ffffffff', stage:'spi-probe-failed', mesh_running:false};
  assert(send(m, result));
  assert.match(m.lastMessage, /Radio test failed: spi-probe-failed/);
  assert.equal(parseLine(JSON.stringify({...result, ok:'false'})), null);
  assert.equal(parseLine(JSON.stringify({...result, device_id:'not-an-id'})), null);
});

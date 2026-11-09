import { Monitor, Lines, age, ROOM_FRAME, RANGE_LINKS, isRoomReport, parseSession } from '../node-firmware/monitor/model.js';
import { analyzeStationary, referenceTriangle, type Recording, type ReferenceDistances } from './accuracy.ts';
import './style.css';

interface SerialPort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize: number }): Promise<void>;
  setSignals(signals: { dataTerminalReady: boolean }): Promise<void>;
  close(): Promise<void>;
}
interface SerialAccess { requestPort(options: { filters: { usbVendorId: number }[] }): Promise<SerialPort> }
const serial = (navigator as Navigator & { serial?: SerialAccess }).serial;
const element = <T extends HTMLElement>(id: string) => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element ${id}`);
  return result as T;
};
const button = (id: string) => element<HTMLButtonElement>(id);
const map = document.querySelector<SVGSVGElement>('#map')!;
const ids = ['N1', 'N2', 'N3'];
interface Position { id: string; x_m: number; y_m: number }
type DemoModel = Omit<Monitor, 'identity' | 'layout'> & {
  identity: { data: { source: string; geometry?: string; layout_version?: number }; receivedAt: number } | null;
  layout: { data: { source: string; status: string; positions: Position[] | null }; receivedAt: number } | null;
};
let model: DemoModel = new Monitor(performance.now());
let port: SerialPort | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let readTask: Promise<void> | null = null;
let busy = false, closing = false;
let phase: 'idle' | 'locating' | 'tracking' | 'timeout' = 'idle';
let locateStart = Infinity, deadline = Infinity;
let recording: ReturnType<typeof parseSession> | null = null;
let replayTime = 0, replayIndex = 0, replayStart = 0, playing = false;
let selected = 'N1';
let viewSpan = 10;
let lastSvg = '';
const captureDurationMs = 60000;
let stationaryCapture: { startedAt: number; wallStartedAt: number; samples: Recording['samples'] } | null = null;
let measurementRecording: Recording | null = null;
let measurementAnalysis: ReturnType<typeof analyzeStationary> | null = null;
let measurementStatus = 'Connect a room node or open a recording.';
const now = () => recording ? replayTime : performance.now();
const displayMaxAgeMs = 30000;
const available = (entry: Parameters<typeof age>[0]) => Boolean((port || recording) && entry && age(entry, now()) < displayMaxAgeMs);
const message = (text: string) => { element('message').textContent = text; };
const fmt = (value: number) => value.toFixed(2);
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const labels: Record<string, string> = { reference: 'Frame origin', relative: 'Relative estimate', 'poor-geometry': 'Triangle too narrow', 'missing-measurements': 'Missing ranges', 'inconsistent-ranges': 'Ranges disagree' };
function measuredReference(): ReferenceDistances | undefined {
  const values = ['reference-12', 'reference-13', 'reference-23'].map(id => element<HTMLInputElement>(id).value.trim());
  if (values.every(value => !value)) return;
  if (values.some(value => !value)) throw new Error('Enter all three tape distances, or leave all three blank for jitter only.');
  const reference = { n1n2M: Number(values[0]), n1n3M: Number(values[1]), n2n3M: Number(values[2]) };
  referenceTriangle(reference);
  return reference;
}
function renderMeasurementResult() {
  if (!measurementAnalysis) { element('measurement-result').innerHTML = ''; return; }
  const result = measurementAnalysis;
  const cm = (value: number | null | undefined) => value == null ? 'n/a' : (value * 100).toFixed(1);
  const coverage = result.availability.fraction == null ? 'n/a' : `${(result.availability.fraction * 100).toFixed(1)}%`;
  element('measurement-result').innerHTML = `<p>${result.reference ? 'Tape reference supplied. Errors are against its relative triangle.' : 'Jitter only. No independent accuracy reference supplied.'} Layout fresh: ${coverage} of evaluated time.</p>
    <div class="measurement-table"><table><caption>Range measurements, centimetres</caption><thead><tr><th>Link</th><th>Exchanges</th><th>SD</th><th>Median bias</th><th>RMSE</th><th>95% abs error</th></tr></thead><tbody>${result.ranges.map(range => `<tr data-measurement-edge="${range.edge}"><td>${range.edge}</td><td>${range.count}</td><td>${cm(range.stdDevM)}</td><td>${cm(range.accuracy?.biasM)}</td><td>${cm(range.accuracy?.rmseM)}</td><td>${cm(range.accuracy?.p95ErrorM)}</td></tr>`).join('')}</tbody></table></div>
    <div class="measurement-table"><table><caption>Node positions in the N1/N2 frame, centimetres</caption><thead><tr><th>Node</th><th>Reports</th><th>SD x</th><th>SD y</th><th>95% jitter radius</th><th>First/last shift</th><th>95% pos error</th></tr></thead><tbody>${result.nodes.map(node => `<tr data-measurement-node="${node.id}"><td>${node.id}${node.constrained ? ' / fixed origin' : ''}</td><td>${node.count}</td><td>${node.constrained ? 'fixed' : cm(node.stdXM)}</td><td>${node.constrained ? 'fixed' : node.id === 'N2' ? 'axis fixed' : cm(node.stdYM)}</td><td>${node.constrained ? 'fixed' : cm(node.p95RadiusM)}</td><td>${node.constrained ? 'fixed' : cm(node.firstLastShiftM)}</td><td>${node.constrained ? 'not tested' : cm(node.accuracy?.p95ErrorM)}</td></tr>`).join('')}</tbody></table></div>
    <p>SD is sample standard deviation. The jitter radius encloses 95% of reported positions around their median. First/last shift compares median positions in the first and last thirds; this short test does not establish long-term drift.</p>
    ${result.warnings.length ? `<ul>${result.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul>` : ''}`;
}
function analyzeMeasurement(prefix: string) {
  measurementAnalysis = null;
  try {
    if (!measurementRecording) throw new Error('Capture data or open a recording first.');
    measurementAnalysis = analyzeStationary(measurementRecording, {
      startMs: measurementRecording.duration_ms === undefined ? undefined : 0,
      settleMs: 5000, reference: measuredReference(),
    });
    measurementStatus = `${prefix} ${(measurementAnalysis.availability.totalMs / 1000).toFixed(1)} seconds evaluated after settling.`;
  } catch (error) { measurementStatus = `Analysis unavailable. ${error instanceof Error ? error.message : 'Cannot analyze this recording.'}`; }
  renderMeasurementResult();
}
function finishCapture(prefix: string) {
  if (!stationaryCapture) return;
  const duration_ms = Math.max(0, Math.floor(performance.now() - stationaryCapture.startedAt));
  const wall_duration_ms = Date.now() - stationaryCapture.wallStartedAt;
  measurementRecording = { version: 1, kind: 'mesh-usb-session', duration_ms, wall_duration_ms, samples: stationaryCapture.samples };
  stationaryCapture = null;
  analyzeMeasurement(prefix);
}
function renderMeasurement() {
  const capturing = Boolean(stationaryCapture);
  button('capture-stationary').disabled = busy || capturing || !port || Boolean(recording) || model.identity?.data.geometry !== 'relative-triangle';
  button('cancel-stationary').hidden = !capturing;
  button('analyze-stationary').disabled = capturing || !measurementRecording;
  button('analyze-stationary').textContent = recording ? 'Analyze recording' : 'Recalculate measurement';
  button('save-stationary').disabled = capturing || !measurementRecording;
  element<HTMLFieldSetElement>('reference-distances').disabled = capturing;
  if (stationaryCapture) {
    const elapsed = Math.min(60, Math.floor((performance.now() - stationaryCapture.startedAt) / 1000));
    element('measurement-status').textContent = elapsed < 5 ? `Settling: ${5 - elapsed} seconds. Keep all nodes still.` : `Capturing: ${elapsed} / 60 seconds. Keep all nodes still.`;
  } else element('measurement-status').textContent = measurementStatus;
}
const observedAfterLocate = (entry: Parameters<typeof age>[0]) => available(entry) &&
  entry.receivedAt - age(entry, entry.receivedAt) >= locateStart;
function relativePositions(): Position[] | null {
  if (observedAfterLocate(model.layout) && model.layout?.data.status === 'relative') return model.layout.data.positions;
  // New firmware must not fall back to poses from independent report snapshots.
  if (model.identity?.data.layout_version === 1) return null;
  return ids.map(id => ({ id, x_m: model.reports.get(id)!.data.x_m, y_m: model.reports.get(id)!.data.y_m }));
}
function complete() {
  return model.coordinateFrame === ROOM_FRAME && RANGE_LINKS.every(key => {
    return observedAfterLocate(model.measurements.get(key));
  }) && ids.every(id => {
    const e = model.reports.get(id);
    return observedAfterLocate(e) && isRoomReport(e.data) && ['reference', 'relative'].includes(e.data.status);
  }) && relativePositions() !== null;
}
function drawMap(positions: Position[] | null) {
  const connected = model.identity?.data.source;
  const origin = positions?.find(p => p.id === connected);
  const points: { id: string; x: number; y: number }[] = positions && origin ? positions.map(p => {
    return { id: p.id, x: p.x_m - origin.x_m, y: p.y_m - origin.y_m };
  }) : connected && connected !== 'N0' && (port || recording) ? [{ id: connected, x: 0, y: 0 }] : [];
  const extent = Math.max(3, ...points.flatMap(p => [Math.abs(p.x), Math.abs(p.y)]));
  viewSpan = Math.max(viewSpan, extent * 2.7);
  const unit = viewSpan <= 12 ? 1 : viewSpan <= 30 ? 2 : viewSpan <= 60 ? 5 : 10 ** Math.floor(Math.log10(viewSpan / 6));
  const scale = 510 / viewSpan;
  const x = (v: number) => 500 + v * scale, y = (v: number) => 340 - v * scale;
  let svg = '';
  for (let n = Math.ceil(-460 / scale / unit); n * unit <= 460 / scale; n++) {
    const v = n * unit;
    svg += `<line class="${n ? 'grid-line' : 'grid-axis'}" x1="${x(v)}" x2="${x(v)}" y1="38" y2="642"/><text class="axis-label" x="${x(v)}" y="666" text-anchor="middle">${v}</text>`;
  }
  for (let n = Math.ceil(-300 / scale / unit); n * unit <= 300 / scale; n++) {
    const v = n * unit;
    svg += `<line class="${n ? 'grid-line' : 'grid-axis'}" x1="38" x2="962" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="24" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  if (positions) {
    svg += `<path d="M${points.map(p => `${x(p.x)},${y(p.y)}`).join('L')}Z" fill="none" stroke="#65849f" stroke-width="1.5" stroke-dasharray="5 6"/>`;
  }
  for (const p of points) {
    const local = p.id === connected;
    svg += `<g data-node="${p.id}" tabindex="0" role="button" aria-label="Inspect ${p.id}"><title>${p.id}${local ? ', USB node' : ''}</title><circle cx="${x(p.x)}" cy="${y(p.y)}" r="18" fill="none" stroke="${p.id === selected ? '#8bc6ff' : 'none'}"/><circle cx="${x(p.x)}" cy="${y(p.y)}" r="7" fill="${local ? '#f2f6fa' : '#8bc6ff'}"/><text class="map-label" x="${x(p.x)}" y="${y(p.y) - 34}" text-anchor="middle">${p.id}${local ? ' / USB' : ''}</text><text class="map-coordinate" x="${x(p.x)}" y="${y(p.y) + 43}" text-anchor="middle">${fmt(p.x)}, ${fmt(p.y)} m</text></g>`;
  }
  if (!points.length) svg += '<text class="empty-label" x="500" y="290" text-anchor="middle">Connect a USB node to begin</text>';
  if (lastSvg !== svg) { map.innerHTML = svg; lastSvg = svg; }
  element('scale').textContent = `${unit} m grid`;
}
function render() {
  if ((phase === 'locating' || phase === 'timeout') && complete()) { phase = 'tracking'; message(''); }
  if (phase === 'locating' && now() >= deadline) { phase = 'timeout'; message('No complete layout received. Check power, node IDs and all three radio links, then locate again.'); }
  const identity = model.identity?.data, connected = Boolean(port), ready = phase === 'tracking' && complete();
  const positions = ready ? relativePositions() : null;
  const origin = positions?.find(p => p.id === identity?.source);
  const identified = identity && ids.includes(identity.source);
  button('connect').disabled = !serial || busy || connected;
  button('connect').hidden = connected;
  button('disconnect').hidden = !connected;
  button('disconnect').disabled = busy;
  button('locate').disabled = busy || !(connected || recording) || !identified || identity?.geometry !== 'relative-triangle' || phase === 'locating';
  button('locate').lastChild!.textContent = phase === 'locating' ? 'Locating…' : phase === 'tracking' ? 'Locate again' : 'Locate nodes';
  element('connection').textContent = recording ? 'Recording playback' : connected ? identity ? `${identity.source} connected via USB` : 'Reading board identity…' : 'No USB node connected';
  element('connection-dot').className = connected ? 'connected' : '';
  element('source').hidden = !recording;
  const count = ids.filter(id => available(model.reports.get(id))).length;
  element('node-count').textContent = `${count} / 3`;
  element('nodes').innerHTML = ids.map(id => {
    const e = model.reports.get(id), local = identified && identity.source === id && (connected || recording);
    const live = available(e), r = e?.data;
    const position = positions?.find(p => p.id === id);
    const state = live ? labels[r.status] ?? 'Unsupported frame' : e ? 'Signal stale' : local ? 'Connected' : 'Not seen';
    return `<div class="node"><div class="node-title"><strong><i class="${live || local ? 'connected' : ''}"></i>${id}</strong><span>${escape(state)}</span></div><div class="node-role">${local ? 'USB node / map origin' : 'Remote node'}</div><div class="coordinates"><span><small>x</small>${position && origin ? fmt(position.x_m - origin.x_m) : local ? '0.00' : '—'}</span><span><small>y</small>${position && origin ? fmt(position.y_m - origin.y_m) : local ? '0.00' : '—'}</span><small>m</small></div></div>`;
  }).join('');
  element('ranges').innerHTML = RANGE_LINKS.map(key => {
    const e = model.measurements.get(key);
    return `<div class="range"><span>${key.replace('-', ' to ')}</span><strong class="${e && !available(e) ? 'warning' : ''}">${available(e) ? `${fmt(e.data.value_mm / 1000)} m` : e ? 'Stale' : '—'}</strong></div>`;
  }).join('');
  const rejectedLayout = identity?.layout_version === 1 && available(model.layout) && model.layout?.data.status !== 'relative';
  const heading = !connected && !recording ? 'Connect a USB node' : !identified ? 'Waiting for node identity' : identity.geometry !== 'relative-triangle' ? 'Room firmware required' : phase === 'idle' ? 'Ready to locate' : phase === 'locating' ? 'Collecting node reports' : ready ? 'Relative layout ready' : phase === 'timeout' || rejectedLayout ? 'Layout unavailable' : 'Position data expired';
  element('phase').textContent = heading;
  const unheard = ids.filter(id => id !== identity?.source && !available(model.reports.get(id)));
  const missingRanges = RANGE_LINKS.filter(key => !available(model.measurements.get(key)));
  const waiting = unheard.length ? `Waiting for ${unheard.join(' and ')}. Check their USB power and radio links.` :
    missingRanges.length ? `Nodes heard. Waiting for distances: ${missingRanges.join(', ')}. Keep the nodes in a triangle.` :
    identity?.layout_version === 1 ? `${rejectedLayout ? `${labels[model.layout!.data.status]}. ` : ''}Waiting for a fresh complete layout from the USB node.` :
    'Collecting usable node positions. Keep the nodes in a broad triangle.';
  element('guidance').textContent = !connected && !recording ? 'Power all three nodes, then connect the USB board in Chrome or Edge.' : !identified ? 'The board must have an assigned ID: N1, N2 or N3.' : identity.geometry !== 'relative-triangle' ? 'Install the three-node room firmware before locating.' : ready ? 'Live estimates update as nodes move. Select a node to highlight it.' : phase === 'idle' ? 'Press Locate nodes to collect fresh positions from the network.' : waiting;
  button('export').disabled = !model.lines.length;
  element<HTMLInputElement>('import').disabled = connected || busy;
  button('play').hidden = !recording;
  button('play').textContent = playing ? 'Pause recording' : replayIndex >= (recording?.samples.length ?? Infinity) ? 'Replay from start' : 'Play recording';
  element('diagnostics').textContent = `${model.lines.length} serial lines, ${model.invalid} invalid. ${recording ? `Recording at ${fmt(replayTime / 1000)} s.` : 'USB 115200 baud.'} ${[...model.reports].map(([id, e]) => `${id}: ${fmt(age(e, now()) / 1000)} s old`).join('. ')}`;
  const log = model.log.slice(-15).join('\n');
  if (element('log').textContent !== log) element('log').textContent = log;
  drawMap(positions);
  renderMeasurement();
}
async function send(command: string) {
  if (!port?.writable) throw new Error('USB is not writable. Reconnect the board.');
  const writer = port.writable.getWriter();
  try { await writer.write(new TextEncoder().encode(command + '\n')); } finally { writer.releaseLock(); }
}
async function read(opened: SerialPort) {
  const lines = new Lines(), decoder = new TextDecoder();
  if (!opened.readable) throw new Error('USB is not readable.');
  const activeReader = opened.readable.getReader(); reader = activeReader;
  try {
    while (true) {
      const { value, done } = await activeReader.read();
      if (done) break;
      lines.feed(decoder.decode(value, { stream: true }), (line: string) => {
        const receivedAt = now(); model.ingest(line, receivedAt);
        if (stationaryCapture) {
          const at_ms = Math.max(0, Math.floor(receivedAt - stationaryCapture.startedAt));
          if (at_ms <= captureDurationMs) stationaryCapture.samples.push({ at_ms, line });
          if (stationaryCapture.samples.length >= 10000) finishCapture('Capture stopped at its line limit. Partial result.');
        }
      });
    }
  } catch (error) { if (!closing) message(`USB connection ended. ${error instanceof Error ? error.message : 'Reconnect to resume.'}`); }
  finally {
    if (stationaryCapture) finishCapture('USB disconnected. Partial capture.');
    activeReader.releaseLock(); reader = null;
    try { await opened.close(); } catch { /* Unplugged ports may already be closed. */ }
    if (port === opened) port = null;
    phase = 'idle'; render();
  }
}
button('connect').onclick = async () => {
  if (!serial || busy) return;
  busy = true; closing = false; render();
  let opened: SerialPort | null = null;
  try {
    opened = await serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] });
    await opened.open({ baudRate: 115200, bufferSize: 8192 });
    await opened.setSignals({ dataTerminalReady: true });
    model = new Monitor(performance.now()); recording = null; playing = false; phase = 'idle'; viewSpan = 10;
    measurementRecording = null; measurementAnalysis = null; measurementStatus = 'Ready for a stationary capture.'; renderMeasurementResult();
    port = opened; message(''); readTask = read(opened); await send('GET');
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') {
      message('No USB node selected. Choose a XIAO from the USB picker. If no picker appears, open this page in Chrome or Edge.');
    } else {
      message(`Cannot connect. ${error instanceof Error ? error.message : 'USB is unavailable.'} Close serial monitors and apps such as Cura, or choose the other XIAO.`);
    }
    if (reader) { await reader.cancel().catch(() => {}); await readTask; }
    else if (opened) await opened.close().catch(() => {});
  } finally { busy = false; render(); }
};
button('disconnect').onclick = async () => {
  busy = true; closing = true; render();
  try { await reader?.cancel(); await readTask; } finally { busy = false; phase = 'idle'; message(''); render(); }
};
button('locate').onclick = async () => {
  locateStart = now(); deadline = now() + 15000; phase = 'locating'; message(''); render();
  // Nodes range and solve continuously. GET requests identity; it never computes positions on the PC.
  if (port) try { await send('GET'); } catch (error) { phase = 'timeout'; message(error instanceof Error ? error.message : 'USB command failed.'); render(); }
};
button('fit').onclick = () => { viewSpan = 0; render(); };
button('capture-stationary').onclick = async () => {
  if (!port || recording || stationaryCapture || busy) return;
  try {
    measuredReference();
    measurementRecording = null; measurementAnalysis = null; renderMeasurementResult();
    stationaryCapture = { startedAt: performance.now(), wallStartedAt: Date.now(), samples: [] }; render();
    await send('GET');
  } catch (error) {
    stationaryCapture = null;
    measurementAnalysis = null; renderMeasurementResult();
    measurementStatus = error instanceof Error ? error.message : 'Cannot start capture.'; render();
  }
};
button('cancel-stationary').onclick = () => {
  stationaryCapture = null; measurementStatus = 'Capture cancelled. No new measurement saved.'; render();
};
button('analyze-stationary').onclick = () => { analyzeMeasurement(recording ? 'Recording analyzed.' : 'Measurement recalculated.'); render(); };
button('save-stationary').onclick = () => {
  if (!measurementRecording) return;
  const result = { ...measurementRecording, analysis: measurementAnalysis, ...(measurementAnalysis?.reference ? { reference: measurementAnalysis.reference } : {}) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `mesh-stationary-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function select(target: EventTarget | null) {
  if (target instanceof Element) { const node = target.closest('[data-node]'); if (node) { selected = node.getAttribute('data-node')!; render(); } }
}
map.addEventListener('click', event => select(event.target));
map.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event.target); } });
button('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(model.exportSession(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `mesh-demo-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
element<HTMLInputElement>('import').onchange = async event => {
  const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file || port || busy) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Recording exceeds 20 MB.');
    recording = parseSession(await file.text()); model = new Monitor(0); replayIndex = 0; replayTime = 0;
    measurementRecording = { version: 1, kind: 'mesh-usb-session', duration_ms: recording.duration_ms ?? recording.samples.at(-1)!.at_ms,
      wall_duration_ms: recording.wall_duration_ms, samples: recording.samples };
    for (const [id, key] of [['reference-12', 'n1n2M'], ['reference-13', 'n1n3M'], ['reference-23', 'n2n3M']] as const) {
      const value = recording.reference?.[key];
      element<HTMLInputElement>(id).value = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }
    measurementAnalysis = null; measurementStatus = 'Recorded data ready to analyze. No live capture is running.'; renderMeasurementResult();
    replayStart = performance.now(); playing = true; phase = 'idle'; viewSpan = 10; message('Recorded data. USB hardware is disconnected.');
  } catch (error) { message(error instanceof Error ? error.message : 'Cannot open recording.'); }
  render();
};
button('play').onclick = () => {
  if (!recording) return;
  if (playing) playing = false;
  else {
    if (replayIndex >= recording.samples.length) { model = new Monitor(0); replayIndex = 0; replayTime = 0; phase = 'idle'; }
    replayStart = performance.now() - replayTime; playing = true;
  }
  render();
};
if (!serial) message('USB connection needs Chrome or Edge on this computer. You can still open a recording.');
setInterval(() => {
  if (stationaryCapture && performance.now() - stationaryCapture.startedAt >= captureDurationMs) finishCapture('Stationary capture complete.');
  if (recording && playing) {
    replayTime = Math.min(performance.now() - replayStart, recording.samples.at(-1)!.at_ms);
    while (replayIndex < recording.samples.length && recording.samples[replayIndex].at_ms <= replayTime) {
      const sample = recording.samples[replayIndex++]; model.ingest(sample.line, sample.at_ms);
    }
    if (replayIndex >= recording.samples.length) playing = false;
  }
  render();
}, 500);
render();

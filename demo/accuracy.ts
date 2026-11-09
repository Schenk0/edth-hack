import { Monitor, parseLine, fresh, MAX_AGE, ROOM_FRAME } from '../node-firmware/monitor/model.js';

export type NodeId = 'N1' | 'N2' | 'N3';
export type Edge = 'N1-N2' | 'N1-N3' | 'N2-N3';
export interface Recording {
  version: 1;
  samples: Array<{ at_ms: number; line: string }>;
  duration_ms?: number;
  wall_duration_ms?: number;
  kind?: string;
}
export interface ReferenceDistances { n1n2M: number; n1n3M: number; n2n3M: number }
interface Point { xM: number; yM: number }
interface TimedPoint extends Point { atMs: number }
export interface StationaryAnalysis {
  durationMs: number;
  settleMs: number;
  observer: NodeId | null;
  reference: ReferenceDistances | null;
  availability: { fraction: number | null; readyMs: number; totalMs: number };
  ranges: Array<{ edge: Edge; count: number; medianM: number | null; stdDevM: number | null; p95RadiusM: number | null;
    accuracy: { biasM: number; rmseM: number; p95ErrorM: number } | null }>;
  nodes: Array<{ id: NodeId; count: number; median: Point | null; stdXM: number | null; stdYM: number | null;
    p95RadiusM: number | null; firstLastShiftM: number | null; constrained: boolean;
    accuracy: { meanErrorM: number; rmseM: number; p95ErrorM: number } | null }>;
  warnings: string[];
}
const nodes: NodeId[] = ['N1', 'N2', 'N3'];
const edges: Edge[] = ['N1-N2', 'N1-N3', 'N2-N3'];
const maxTime = 7 * 24 * 3600 * 1000;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nodeId = (value: unknown): value is NodeId => value === 'N1' || value === 'N2' || value === 'N3';
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maxTime;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function stdDev(values: number[]) {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}
const rms = (values: number[]) => Math.sqrt(mean(values.map(value => value ** 2)));
function center(points: Point[]): Point {
  return { xM: quantile(points.map(point => point.xM), 0.5), yM: quantile(points.map(point => point.yM), 0.5) };
}
const distance = (a: Point, b: Point) => Math.hypot(a.xM - b.xM, a.yM - b.yM);

// Tape distances define the same conventional frame as the nodes. No fit or scale correction is applied.
export function referenceTriangle(ref: ReferenceDistances): Record<NodeId, Point> {
  if (!ref || [ref.n1n2M, ref.n1n3M, ref.n2n3M].some(value => !Number.isFinite(value) || value <= 0 || value > 1000))
    throw new Error('Enter three finite antenna-to-antenna distances greater than zero and at most 1000 m.');
  const { n1n2M: a, n1n3M: b, n2n3M: c } = ref;
  if (a + b <= c || a + c <= b || b + c <= a) throw new Error('Measured distances must form a non-collinear triangle.');
  const xM = (a * a + b * b - c * c) / (2 * a);
  const yM = Math.sqrt(Math.max(0, b * b - xM * xM));
  if (!Number.isFinite(yM) || yM <= 0) throw new Error('Measured distances must form a non-collinear triangle.');
  return { N1: { xM: 0, yM: 0 }, N2: { xM: a, yM: 0 }, N3: { xM, yM } };
}

interface Entry { data: Record<string, unknown>; receivedAt: number }
function entry(value: unknown): Entry | null {
  if (!object(value) || !object(value.data) || typeof value.receivedAt !== 'number') return null;
  return { data: value.data, receivedAt: value.receivedAt };
}
function expiry(value: Entry) {
  const { age_ms: age, usb_delay_ms: usb } = value.data;
  return value.receivedAt + MAX_AGE - (typeof age === 'number' ? age : 0) - (typeof usb === 'number' ? usb : 0);
}
function readyEntries(model: Monitor, atMs: number): Entry[] | null {
  if (model.coordinateFrame !== ROOM_FRAME) return null;
  const entries: Entry[] = [];
  for (const edge of edges) {
    const cached = entry(model.measurements.get(edge));
    if (!cached || !fresh(cached, atMs)) return null;
    entries.push(cached);
  }
  for (const id of nodes) {
    const cached = entry(model.reports.get(id));
    if (!cached || !fresh(cached, atMs) || cached.data.coordinate_frame !== ROOM_FRAME ||
        !['reference', 'relative'].includes(String(cached.data.status))) return null;
    entries.push(cached);
  }
  return entries;
}

// Uses accepted, unique node reports. Availability integrates cache changes and exact expiry times.
export function analyzeStationary(recording: Recording, options: {
  startMs?: number; endMs?: number; settleMs?: number; reference?: ReferenceDistances;
} = {}): StationaryAnalysis {
  if (!recording || recording.version !== 1 || !Array.isArray(recording.samples) || recording.samples.length > 20000)
    throw new Error('Invalid stationary recording.');
  let previous = 0, bytes = 0;
  for (const sample of recording.samples) {
    if (!sample || !time(sample.at_ms) || sample.at_ms < previous || typeof sample.line !== 'string' || sample.line.length > 2048)
      throw new Error('Invalid recording timestamps or serial lines.');
    previous = sample.at_ms; bytes += sample.line.length;
  }
  if (bytes > 20 * 1024 * 1024) throw new Error('Recording exceeds 20 MB.');
  if (recording.duration_ms !== undefined && (!time(recording.duration_ms) || recording.duration_ms < previous))
    throw new Error('Recording duration precedes its last sample.');
  if (recording.wall_duration_ms !== undefined) {
    if (!time(recording.wall_duration_ms) || recording.duration_ms === undefined)
      throw new Error('Invalid wall-clock capture duration.');
    if (Math.abs(recording.wall_duration_ms - recording.duration_ms) > 2000)
      throw new Error('Capture timing was interrupted by sleep or a clock change. Raw data is preserved; accuracy and availability cannot be verified.');
  }
  const start = options.startMs ?? (recording.duration_ms !== undefined ? 0 : recording.samples[0]?.at_ms ?? 0);
  const end = options.endMs ?? recording.duration_ms ?? previous;
  const settleMs = options.settleMs ?? 5000;
  if (!time(start) || !time(end) || end < start || !time(settleMs)) throw new Error('Invalid analysis window.');
  const cutoff = Math.min(end, start + settleMs), totalMs = end - cutoff;
  const reference = options.reference ?? null, truth = reference ? referenceTriangle(reference) : null;
  const measured = reference ? { 'N1-N2': reference.n1n2M, 'N1-N3': reference.n1n3M, 'N2-N3': reference.n2n3M } : null;
  const ranges = new Map<Edge, number[]>(edges.map(edge => [edge, []]));
  const positions = new Map<NodeId, TimedPoint[]>(nodes.map(id => [id, []]));
  const observers = new Set<NodeId>(), warnings = new Set<string>();
  const boots = new Map<NodeId, number>(), configurations = new Set<string>();
  const model = new Monitor(0);
  let cursor = cutoff, readyMs = 0, invalid = 0, roomReports = 0;
  function integrate(to: number) {
    const until = Math.min(end, to);
    if (until <= cursor) return;
    const cached = readyEntries(model, cursor);
    if (cached) readyMs += Math.max(0, Math.min(until, ...cached.map(expiry)) - cursor);
    cursor = until;
  }
  for (const sample of recording.samples) {
    if (sample.at_ms > end) break;
    integrate(sample.at_ms);
    const data: unknown = parseLine(sample.line);
    const accepted = model.ingest(sample.line, sample.at_ms);
    if (!object(data)) { if (sample.at_ms >= start) invalid++; continue; }
    const inWindow = sample.at_ms >= start;
    if (inWindow && nodeId(data.receiver)) observers.add(data.receiver);
    if (accepted && data.type === 'identity' && nodeId(data.source)) {
      if (inWindow) {
        observers.add(data.source);
        configurations.add(JSON.stringify([data.source, data.board_id, data.network, data.geometry, data.wire_version,
          data.channel, data.tx_power, data.tx_ant_delay, data.rx_ant_delay]));
      }
    }
    if ((data.type === 'identity' || data.type === 'report' || data.type === 'measurement') &&
        nodeId(data.source) && typeof data.boot === 'number' && accepted) {
      const old = boots.get(data.source);
      if (old !== undefined && data.boot > old && inWindow) warnings.add('A node restarted during this window; one stationary configuration is not established.');
      boots.set(data.source, data.boot);
    }
    if (!accepted || model.coordinateFrame !== ROOM_FRAME || (data.type !== 'report' && data.type !== 'measurement') || !nodeId(data.source)) continue;
    const ageMs = typeof data.age_ms === 'number' ? data.age_ms : 0;
    const usbMs = typeof data.usb_delay_ms === 'number' ? data.usb_delay_ms : 0;
    // Reject delayed pre-window payloads even when their bytes arrive after capture starts.
    if (ageMs + usbMs >= MAX_AGE || sample.at_ms - ageMs - usbMs < cutoff) continue;
    if (data.type === 'measurement' && data.kind === 'range' && typeof data.a === 'number' &&
        typeof data.b === 'number' && typeof data.value_mm === 'number') {
      const key = `N${data.a}-N${data.b}`;
      const edge = edges.find(edge => edge === key);
      if (edge) ranges.get(edge)!.push(data.value_mm / 1000);
    } else if (data.type === 'report' && data.coordinate_frame === ROOM_FRAME) {
      roomReports++;
      if (typeof data.x_m === 'number' && typeof data.y_m === 'number' && ['reference', 'relative'].includes(String(data.status)))
        positions.get(data.source)!.push({ atMs: sample.at_ms, xM: data.x_m, yM: data.y_m });
    }
  }
  integrate(end);
  if (invalid) warnings.add(`${invalid} invalid serial line${invalid === 1 ? '' : 's'} ignored.`);
  if (observers.size > 1) warnings.add('Multiple USB observers occur in this window; single-observer availability is not established.');
  if (configurations.size > 1) warnings.add('Connected board or RF settings changed during this window.');
  if (!roomReports) warnings.add('No fresh room-frame position reports were received after settling.');
  if (!totalMs) warnings.add('No analysis time remains after settling.');
  warnings.add('N1 is the defined origin; its zero movement is not an independent accuracy measurement. N2 y=0 is also imposed by the coordinate convention.');
  warnings.add('First-to-last shift describes this window only; it does not prove long-term drift or its cause.');
  if (!reference) warnings.add('No measured distances supplied. Repeatability is available; absolute error is unknown.');
  const rangeResults = edges.map(edge => {
    const values = ranges.get(edge)!;
    if (values.length < 20) warnings.add(`${edge} has fewer than 20 unique fresh ranges; treat its statistics as preliminary.`);
    const medianM = values.length ? quantile(values, 0.5) : null;
    const errors = measured ? values.map(value => value - measured[edge]) : [];
    return { edge, count: values.length, medianM, stdDevM: stdDev(values),
      p95RadiusM: medianM === null ? null : quantile(values.map(value => Math.abs(value - medianM)), 0.95),
      accuracy: errors.length ? { biasM: quantile(errors, 0.5), rmseM: rms(errors), p95ErrorM: quantile(errors.map(Math.abs), 0.95) } : null };
  });
  const nodeResults = nodes.map(id => {
    const points = positions.get(id)!;
    if (points.length < 20) warnings.add(`${id} has fewer than 20 unique fresh positions; treat its statistics as preliminary.`);
    const median = points.length ? center(points) : null;
    const first = points.filter(point => point.atMs < cutoff + totalMs / 3);
    const last = points.filter(point => point.atMs >= cutoff + totalMs * 2 / 3);
    const errors = truth && id !== 'N1' ? points.map(point => distance(point, truth[id])) : [];
    return { id, count: points.length, median, stdXM: stdDev(points.map(point => point.xM)), stdYM: stdDev(points.map(point => point.yM)),
      p95RadiusM: median ? quantile(points.map(point => distance(point, median)), 0.95) : null,
      firstLastShiftM: first.length && last.length ? distance(center(first), center(last)) : null, constrained: id === 'N1',
      accuracy: errors.length ? { meanErrorM: mean(errors), rmseM: rms(errors), p95ErrorM: quantile(errors, 0.95) } : null };
  });
  return { durationMs: end - start, settleMs, observer: observers.size === 1 ? [...observers][0] : null, reference,
    availability: { fraction: totalMs && observers.size <= 1 ? readyMs / totalMs : null, readyMs, totalMs },
    ranges: rangeResults, nodes: nodeResults, warnings: [...warnings] };
}

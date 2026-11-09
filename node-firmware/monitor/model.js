// The Mac only displays node output. Positions always come from the nodes' own solvers.
export const MAX_AGE = 6000;
export const MAX_LINES = 10000;
export const ROOM_FRAME = 'relative-n1-n2-positive-y';
export const RANGE_LINKS = ['N1-N2', 'N1-N3', 'N2-N3'];
const node = value => typeof value === 'string' && /^N[1-3]$/.test(value);
const integer = (value, min = 0, max = 0xffffffff) => Number.isInteger(value) && value >= min && value <= max;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const statuses = new Set(['unconfigured-line', 'reference', 'missing-measurements', 'inconsistent-ranges', 'located']);
const roomStatuses = new Set(['reference', 'relative', 'missing-measurements', 'inconsistent-ranges', 'poor-geometry']);
const layoutStatuses = new Set(['relative', 'missing-measurements', 'inconsistent-ranges', 'poor-geometry']);
export const isRoomReport = data => data?.coordinate_frame === ROOM_FRAME;
export function parseLine(line) {
  if (line.length > 2048) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || d.v !== 1 || typeof d.type !== 'string') return null;
  if (d.usb_delay_ms !== undefined && !integer(d.usb_delay_ms, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (d.type === 'identity') return typeof d.source === 'string' && /^N[0-3]$/.test(d.source) && typeof d.board_id === 'string' && d.board_id.length <= 64 &&
    integer(d.boot, 1) && integer(d.network, 1, 65535) && integer(d.line_length_mm, 0, 1000000) &&
    [5, 9].includes(d.channel) && /^[a-fA-F0-9]{8}$/.test(d.tx_power) &&
    integer(d.tx_ant_delay, 0, 65535) && integer(d.rx_ant_delay, 0, 65535) &&
    (d.node_id === undefined || d.node_id === Number(d.source.slice(1))) &&
    (d.geometry === undefined || (d.geometry === 'relative-triangle' && d.wire_version === 2)) &&
    (d.layout_version === undefined || (d.layout_version === 1 && d.geometry === 'relative-triangle')) ? d : null;
  if (d.type === 'setup') return typeof d.ok === 'boolean' && typeof d.message === 'string' && d.message.length <= 500 ? d : null;
  if (d.type === 'radio-test') return typeof d.ok === 'boolean' && typeof d.device_id === 'string' &&
    /^[a-fA-F0-9]{8}$/.test(d.device_id) && typeof d.stage === 'string' && d.stage.length <= 100 &&
    typeof d.mesh_running === 'boolean' ? d : null;
  if (d.type === 'radio-health') return d.ok === false || (
    typeof d.status === 'string' && /^[a-fA-F0-9]{8}$/.test(d.status) &&
    typeof d.state === 'string' && /^[a-fA-F0-9]{8}$/.test(d.state) &&
    integer(d.reads_per_rate, 1, 10000) && integer(d.fast_errors, 0, d.reads_per_rate) &&
    integer(d.slow_errors, 0, d.reads_per_rate)) ? d : null;
  if (d.type === 'error' && typeof d.source === 'string' && /^N[0-3]$/.test(d.source)) return typeof d.reason === 'string' && d.reason.length <= 200 && typeof d.stage === 'string' && d.stage.length <= 200 ? d : null;
  if (!node(d.source)) return null;
  if (d.type === 'radio-quality') return node(d.peer) && d.peer !== d.source &&
    ['poll', 'response', 'final'].includes(d.frame) && integer(d.boot, 1) && integer(d.seq, 1) &&
    integer(d.age_ms, 0, MAX_AGE - 1) && typeof d.valid === 'boolean' &&
    (d.valid ? finite(d.rssi_dbm, -128, 128) && finite(d.first_path_dbm, -128, 128) && d.accum_count > 0 && d.cir_power > 0 : d.rssi_dbm === null && d.first_path_dbm === null) &&
    integer(d.cir_power, 0, 0x1ffff) && ['f1', 'f2', 'f3'].every(k => integer(d[k], 0, 0x3fffff)) &&
    integer(d.accum_count, 0, 0xfff) && integer(d.dgc, 0, 7) && integer(d.fp_index_q6, 0, 65535) &&
    integer(d.read_us) && typeof d.rx_status === 'string' && /^[a-fA-F0-9]{8}$/.test(d.rx_status) ? d : null;
  if (d.type === 'diagnostics') return ['ranges_ok', 'ranges_failed', 'accepted', 'rejected', 'rx_errors', 'tx_errors'].every(k => integer(d[k])) && integer(d.uptime_ms, 0, Number.MAX_SAFE_INTEGER) && (d.usb_dropped === undefined || integer(d.usb_dropped)) ? d : null;
  if (!node(d.receiver) || !integer(d.boot, 1) || !integer(d.seq, 1) || !integer(d.age_ms, 0, MAX_AGE - 1) || !integer(d.hops, 0, 4)) return null;
  if (d.type === 'layout') {
    if (d.receiver !== d.source || d.hops !== 0 || !isRoomReport(d) || d.reflection_ambiguous !== true ||
        d.calibrated !== false || !layoutStatuses.has(d.status)) return null;
    if (d.status !== 'relative') return d.positions === null && d.ranges_mm === null ? d : null;
    if (!Array.isArray(d.positions) || d.positions.length !== 3 || !d.positions.every((p, i) =>
      p && p.id === `N${i + 1}` && finite(p.x_m, -1000, 1000) && finite(p.y_m, 0, 1000))) return null;
    const [n1, n2, n3] = d.positions;
    return n1.x_m === 0 && n1.y_m === 0 && n2.x_m > 0 && n2.y_m === 0 && n3.y_m > 0 &&
      Array.isArray(d.ranges_mm) && d.ranges_mm.length === 3 && d.ranges_mm.every(mm => integer(mm, 1, 1000000)) ? d : null;
  }
  if (d.type === 'report') {
    if (d.coordinate_frame !== undefined || d.reflection_ambiguous !== undefined || ['relative', 'poor-geometry'].includes(d.status)) {
      if (!isRoomReport(d) || d.reflection_ambiguous !== true || d.residual_m !== null || d.calibrated !== false || !roomStatuses.has(d.status)) return null;
      if (!['reference', 'relative'].includes(d.status)) return d.x_m === null && d.y_m === null ? d : null;
      if (!finite(d.x_m, -1000, 1000) || !finite(d.y_m, 0, 1000)) return null;
      if (d.source === 'N1') return d.status === 'reference' && d.x_m === 0 && d.y_m === 0 ? d : null;
      if (d.status !== 'relative') return null;
      return (d.source === 'N2' ? d.x_m > 0 && d.y_m === 0 : d.y_m > 0) ? d : null;
    }
    const positioned = ['reference', 'located'].includes(d.status);
    return statuses.has(d.status) && finite(d.residual_m, 0, 1000) && d.calibrated === false &&
      (positioned ? finite(d.x_m, 0, 1000) && d.y_m === 0 : d.x_m === null && d.y_m === null) ? d : null;
  }
  if (d.type === 'measurement') {
    if (d.mode !== 'live' || !integer(d.a, 1, 3) || d.source !== `N${d.a}`) return null;
    if (d.kind === 'range') return integer(d.b, d.a + 1, 3) && integer(d.value_mm, 1, 1000000) ? d : null;
    return d.kind === 'anchor' && [1, 3].includes(d.a) && d.b === 0 && integer(d.value_mm, 0, 1000000) && (d.a !== 1 || d.value_mm === 0) ? d : null;
  }
  return null;
}
export const age = (entry, now) => Math.max(0, now - entry.receivedAt) + (entry.data.age_ms ?? 0) + (entry.data.usb_delay_ms ?? 0);
export const fresh = (entry, now) => Boolean(entry && age(entry, now) < MAX_AGE);
export class Monitor {
  identity = null;
  layout = null;
  coordinateFrame = null;
  reports = new Map();
  measurements = new Map();
  diagnostics = new Map();
  errors = new Map();
  boots = new Map();
  history = new Map(RANGE_LINKS.map(link => [link, []]));
  lines = [];
  log = [];
  dropped = 0;
  invalid = 0;
  lastMessage = '';
  constructor(start = 0) { this.start = start; }
  ingest(line, now) {
    if (!Number.isFinite(now) || now < this.start || line.length > 2048) { this.invalid++; return false; }
    this.lines.push({ at_ms: now - this.start, line });
    if (this.lines.length > MAX_LINES) { this.lines.shift(); this.dropped++; }
    this.log.push(line); if (this.log.length > 80) this.log.shift();
    const d = parseLine(line);
    if (!d) { this.invalid++; return false; }
    const entry = { data: d, receivedAt: now };
    if (d.type === 'setup') { this.lastMessage = d.message; return true; }
    if (d.type === 'radio-test') { this.lastMessage = `Radio test ${d.ok ? 'passed' : 'failed'}: ${d.stage}, ID ${d.device_id}`; return true; }
    // Quality uses the initiator's exchange boot, not the reporting board's boot.
    if (d.type === 'radio-quality' || d.type === 'radio-health') return true;
    if (d.type === 'identity') {
      if (node(d.source) && d.boot < (this.boots.get(d.source) ?? 0)) return false;
      const frame = d.geometry === 'relative-triangle' ? ROOM_FRAME : 'legacy-line';
      const previous = this.identity?.data;
      if ((this.coordinateFrame && this.coordinateFrame !== frame) || (previous &&
          (previous.source !== d.source || previous.network !== d.network || (frame === 'legacy-line' && previous.line_length_mm !== d.line_length_mm)))) {
        this.reports.clear(); this.measurements.clear(); this.diagnostics.clear(); this.errors.clear(); this.boots.clear();
        this.layout = null;
        for (const history of this.history.values()) history.splice(0);
      }
      if (this.layout?.data.source !== d.source || previous?.layout_version !== d.layout_version) this.layout = null;
      this.coordinateFrame = frame;
    }
    if (d.type === 'layout' && this.identity && d.source !== this.identity.data.source) return false;
    if (d.type === 'report' || d.type === 'layout') {
      const frame = isRoomReport(d) ? ROOM_FRAME : 'legacy-line';
      if (this.coordinateFrame && this.coordinateFrame !== frame) return false;
      this.coordinateFrame ??= frame;
    }
    if (d.boot && node(d.source)) {
      const previous = this.boots.get(d.source) ?? 0;
      if (d.boot < previous) return false;
      if (d.boot > previous) {
        this.layout = null;
        this.reports.delete(d.source); this.diagnostics.delete(d.source); this.errors.delete(d.source);
        for (const [key, e] of this.measurements) if (e.data.source === d.source) { this.measurements.delete(key); this.history.get(key)?.splice(0); }
        this.boots.set(d.source, d.boot);
      }
    }
    if (d.type === 'identity') {
      this.identity = entry;
      if (d.radio_ready) this.errors.delete(d.source);
    } else if (d.type === 'layout') {
      if (this.layout && d.boot === this.layout.data.boot && d.seq <= this.layout.data.seq) return false;
      this.layout = entry;
    } else if (d.type === 'error') this.errors.set(d.source, entry);
    else if (d.type === 'diagnostics') this.diagnostics.set(d.source, entry);
    else if (d.type === 'report' || d.type === 'measurement') {
      const map = d.type === 'report' ? this.reports : this.measurements;
      const key = d.type === 'report' ? d.source : d.kind === 'range' ? `N${d.a}-N${d.b}` : `anchor-${d.source}`;
      const previous = map.get(key);
      if (previous && d.boot === previous.data.boot && d.seq <= previous.data.seq) return false;
      map.set(key, entry);
      if (d.kind === 'range') {
        const history = this.history.get(key);
        history.push({ at: now - age(entry, now), distance: d.value_mm / 1000 });
        if (history.length > 120) history.shift();
      }
    }
    return true;
  }
  exportSession() { return { version: 1, kind: 'mesh-usb-session', dropped_lines: this.dropped, samples: this.lines }; }
}
export function parseSession(text) {
  if (text.length > 20 * 1024 * 1024) throw new Error('Recording exceeds 20 MB.');
  const session = JSON.parse(text);
  if (session.version !== 1 || session.kind !== 'mesh-usb-session' || !Array.isArray(session.samples) || !session.samples.length || session.samples.length > MAX_LINES)
    throw new Error('Not a mesh USB session recording.');
  let last = -1;
  for (const s of session.samples) {
    if (!finite(s.at_ms, 0, 7 * 24 * 3600000) || s.at_ms < last || typeof s.line !== 'string' || s.line.length > 2048) throw new Error('Invalid recording timestamps or serial lines.');
    last = s.at_ms;
  }
  return session;
}
// USB chunks can split lines arbitrarily. Drop oversized lines through their newline.
export class Lines {
  buffer = ''; overflow = false;
  feed(chunk, emit) {
    for (const char of chunk) {
      if (char === '\n') {
        if (this.overflow) emit('! Discarded oversized serial line');
        else if (this.buffer.trim()) emit(this.buffer.trim());
        this.buffer = ''; this.overflow = false;
      } else if (this.buffer.length < 2048 && !this.overflow) this.buffer += char;
      else { this.buffer = ''; this.overflow = true; }
    }
  }
}

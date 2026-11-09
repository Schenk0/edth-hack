import { Monitor, Lines, age, fresh, MAX_AGE, ROOM_FRAME, RANGE_LINKS, isRoomReport, parseSession, parseLine } from './model.js';
const $ = id => document.getElementById(id);
let model = new Monitor(performance.now());
let port = null, reader = null, readTask = null, opening = false, writing = false;
let mode = 'live', recording = null, playing = false, replayIndex = 0, replayTime = 0, replayStart = 0;
let pendingUntil = 0;
let formKey = '', connectionMessage = 'Connect a powered node in Chrome or Edge.';
const serial = navigator.serial;
const labels = { 'unconfigured-line': 'Baseline not configured', reference: 'Reference', relative: 'Relative estimate', 'poor-geometry': 'Triangle too narrow', 'missing-measurements': 'Waiting for measurements', 'inconsistent-ranges': 'Ranges disagree', located: 'Located' };
const clock = () => mode === 'recording' ? replayTime : performance.now();
const available = entry => fresh(entry, clock()) && (mode === 'recording' || port !== null);
const fmt = value => value === null || value === undefined ? '—' : Number(value).toFixed(3);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statusMessage = text => { $('message').textContent = text; };
function fillSettings(entry) {
  const d = entry.data, key = `${d.board_id}:${d.boot}:${d.geometry ?? 'legacy'}`;
  if (formKey === key) return;
  formKey = key;
  $('node-id').value = String(d.node_id || Number(d.source.slice(1)) || 1);
  $('network').value = d.network;
  $('baseline').value = d.line_length_mm / 1000;
  $('tx-delay').value = d.tx_ant_delay; $('rx-delay').value = d.rx_ant_delay; $('tx-power').value = d.tx_power;
  if (d.source === 'N0') $('setup').open = true;
}
function renderMap(roomReady) {
  if (model.coordinateFrame === ROOM_FRAME) {
    $('map').setAttribute('viewBox', '0 0 880 440');
    $('map').setAttribute('aria-label', 'Node-reported relative 2D positions');
    const reports = [1, 2, 3].map(n => ['N' + n, model.reports.get('N' + n)]);
    if (!roomReady) {
      $('map').innerHTML = '<text x="440" y="215" text-anchor="middle">Waiting for a fresh relative triangle</text>';
      $('map-note').textContent = 'All three measured links and all three solved node reports must be fresh. No positions are inferred by this page.';
      return;
    }
    const points = reports.map(([id, e]) => ({ id, x: e.data.x_m, y: e.data.y_m }));
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const spanX = Math.max(0.25, maxX - minX), spanY = Math.max(0.25, maxY - minY);
    const scale = Math.min(740 / spanX, 290 / spanY);
    const x = p => 70 + (740 - spanX * scale) / 2 + (p.x - minX) * scale;
    const y = p => 355 - (290 - spanY * scale) / 2 - (p.y - minY) * scale;
    $('map').innerHTML = `<path d="M${points.map(p => `${x(p).toFixed(2)},${y(p).toFixed(2)}`).join('L')}Z" fill="none" stroke="#555" stroke-dasharray="5 6"/>` +
      points.map(p => `<g data-node="${p.id}"><circle cx="${x(p).toFixed(2)}" cy="${y(p).toFixed(2)}" r="7" class="position"/><text x="${x(p).toFixed(2)}" y="${(y(p) - 18).toFixed(2)}" text-anchor="middle">${p.id}</text><text x="${x(p).toFixed(2)}" y="${(y(p) + 29).toFixed(2)}" text-anchor="middle">${fmt(p.x)}, ${fmt(p.y)} m</text></g>`).join('');
    $('map-note').textContent = 'Relative frame: N1 is the origin, N2 defines +x, and N3 is drawn at positive y. The mirror layout is equally possible. Room-wall orientation is unknown. Positions come from the nodes.';
    return;
  }
  $('map').setAttribute('viewBox', '0 0 880 150');
  $('map').setAttribute('aria-label', 'Reported positions along the configured baseline');
  const baseline = model.identity?.data.line_length_mm / 1000;
  if (!baseline) {
    $('map').innerHTML = '<line x1="70" y1="74" x2="810" y2="74" stroke="#444" stroke-dasharray="5 6"/>' +
      [1, 2, 3].map((id, i) => `<circle cx="${70 + 370 * i}" cy="74" r="6" fill="#666"/><text x="${70 + 370 * i}" y="108" text-anchor="middle">N${id}</text>`).join('');
    $('map-note').textContent = 'Positions withheld until the measured endpoint separation is configured.';
    return;
  }
  const points = [...model.reports].filter(([, e]) => available(e) && e.data.x_m !== null);
  $('map').innerHTML = '<line x1="70" y1="74" x2="810" y2="74" stroke="#555"/>' +
    `<text x="70" y="135">0 m</text><text x="810" y="135" text-anchor="end">${baseline.toFixed(3)} m</text>` +
    points.map(([id, e]) => {
      const x = 70 + 740 * Math.max(0, Math.min(1, e.data.x_m / baseline));
      return `<circle cx="${x}" cy="74" r="7" class="position"/><text x="${x}" y="48" text-anchor="middle">${id}</text><text x="${x}" y="105" text-anchor="middle">${fmt(e.data.x_m)} m</text>`;
    }).join('');
  $('map-note').textContent = `Straight line, N1 to N3. ${points.length} fresh positions reported. No position is calculated by this page.`;
}
function renderChart(key, suffix) {
  const entry = model.measurements.get(key), samples = model.history.get(key);
  const current = available(entry);
  $('range-' + suffix).textContent = entry ? `${fmt(entry.data.value_mm / 1000)} m${current ? '' : ' · stale'}` : 'No measurement';
  $('range-' + suffix).className = current ? '' : 'muted';
  if (!samples.length) { $('chart-' + suffix).innerHTML = '<text x="8" y="60">Waiting for live ranges</text>'; return; }
  const min = Math.min(...samples.map(p => p.distance)), max = Math.max(...samples.map(p => p.distance));
  const margin = Math.max(0.02, (max - min) * 0.2), low = min - margin, high = max + margin;
  const first = samples[0].at, span = Math.max(1, samples.at(-1).at - first);
  let path = '';
  samples.forEach((p, i) => {
    const x = 50 + (p.at - first) / span * 522, y = 96 - (p.distance - low) / (high - low) * 82;
    path += `${!i || p.at - samples[i - 1].at > MAX_AGE ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `;
  });
  const last = samples.at(-1), dotX = 50 + (last.at - first) / span * 522, dotY = 96 - (last.distance - low) / (high - low) * 82;
  $('chart-' + suffix).innerHTML = `<text x="0" y="22">${high.toFixed(2)}</text><text x="0" y="100">${low.toFixed(2)}</text><path d="${path}" fill="none" stroke="${current ? '#8fcaff' : '#666'}" stroke-width="1.5"/><circle cx="${dotX}" cy="${dotY}" r="2.5" fill="${current ? '#8fcaff' : '#666'}"/>`;
}
function render() {
  const now = clock(), identity = model.identity, d = identity?.data;
  const room = model.coordinateFrame === ROOM_FRAME;
  $('legacy-expected').hidden = room; $('room-expected').hidden = !room;
  $('baseline-field').hidden = room; $('baseline-note').hidden = room;
  $('baseline').disabled = room; $('baseline').required = !room;
  $('residual-header').hidden = room;
  $('setup-note').textContent = room ? 'Assign a different ID to each board and use the same network. Saving restarts only the connected board; reconnect afterward. No baseline is required for the relative room demo.' : 'Assign each board a different ID. Use the same network and measured baseline on all three. Saving restarts only the connected board; reconnect afterward.';
  const roles = room ? ['N1, origin', 'N2, horizontal axis', 'N3, triangle node'] : ['N1, first reference', 'N2, middle node', 'N3, last reference'];
  [...$('node-id').options].forEach((option, index) => { option.textContent = roles[index]; });
  $('mode').textContent = mode === 'recording' ? playing ? 'Recording playing' : 'Recording paused' : port ? 'Live USB' : 'Disconnected';
  $('connection').textContent = mode === 'recording' ? `${(replayTime / 1000).toFixed(1)} s of ${((recording?.samples.at(-1).at_ms ?? 0) / 1000).toFixed(1)} s` : connectionMessage;
  $('counts').textContent = `${model.lines.length} lines · ${model.invalid} invalid${model.dropped ? ` · ${model.dropped} earlier lines discarded` : ''}`;
  $('connect').disabled = !serial || Boolean(port) || opening;
  $('disconnect').disabled = !port; $('export').disabled = !model.lines.length;
  $('import').disabled = Boolean(port) || opening;
  $('play').hidden = mode !== 'recording'; $('play').textContent = playing ? 'Pause recording' : replayIndex >= (recording?.samples.length ?? 0) ? 'Replay from start' : 'Play recording';
  const setupReady = mode === 'live' && port && available(identity) && d.setup_version === 1 && !writing && !pendingUntil;
  $('save').disabled = !setupReady; $('restart').disabled = !setupReady;
  if (identity) {
    if (mode === 'live') fillSettings(identity);
    $('board').textContent = `${d.board_id} · ${d.source === 'N0' ? 'ID unassigned' : d.source} · channel ${d.channel}${available(identity) ? '' : ' · stale'}`;
  } else $('board').textContent = 'No board identified';
  $('nodes').innerHTML = [1, 2, 3].map(n => {
    const e = model.reports.get('N' + n), live = available(e), r = e?.data;
    return `<tr><td>N${n}</td><td class="${live ? ['located', 'reference', 'relative'].includes(r.status) ? 'good' : 'bad' : 'muted'}">${r ? live ? room && r.status === 'reference' ? 'Origin convention' : labels[r.status] : 'Stale report' : 'Not seen'}</td><td>${live ? fmt(r.x_m) : '—'}</td><td>${live ? fmt(r.y_m) : '—'}</td><td${room ? ' hidden' : ''}>${live ? fmt(r.residual_m) : '—'}</td><td>${r?.hops ?? '—'}</td><td>${e ? `${(age(e, now) / 1000).toFixed(1)} s` : '—'}</td><td>${r?.boot ?? '—'}</td></tr>`;
  }).join('');
  const reports = [...model.reports.values()].filter(available);
  const allRoomRanges = RANGE_LINKS.every(link => available(model.measurements.get(link)));
  const allRoomReports = reports.length === 3 && reports.every(e => isRoomReport(e.data) && ['reference', 'relative'].includes(e.data.status));
  const roomReady = allRoomRanges && allRoomReports;
  const adjacent = ['N1-N2', 'N2-N3'].every(k => available(model.measurements.get(k)));
  const endpoint = d?.source === 'N1' ? 'N3' : d?.source === 'N3' ? 'N1' : null;
  const forwarded = endpoint && model.reports.get(endpoint);
  const check = (ok, yes, no) => `<li class="${ok ? 'good' : 'muted'}">${ok ? '✓ ' + yes : '○ ' + no}</li>`;
  $('checks').innerHTML = check(available(identity), 'Connected board identified', 'Waiting for board identity') +
    check(reports.length === 3, 'All three nodes reporting', `${reports.length} of three nodes reporting`) +
    (room ? check(allRoomRanges, 'All three ranges are fresh', 'Waiting for N1 to N2, N1 to N3 and N2 to N3') +
      check(allRoomReports, 'All nodes report a relative solution', 'Relative triangle not yet available') :
      check(adjacent, 'Both adjacent ranges are fresh', 'Waiting for both measured links') +
      check(endpoint && available(forwarded) && forwarded.data.hops === 2, 'Endpoint report crossed two hops', endpoint ? 'Waiting for a two-hop endpoint report' : 'Connect N1 or N3 to verify two hops') +
      check(available(model.reports.get('N2')) && model.reports.get('N2').data.status === 'located', 'N2 reports a local solution', 'N2 position not yet available'));
  const expected = $('expected').value, report = model.reports.get('N2');
  if (room) {
    const target = model.reports.get('N3'), x = $('expected-x').value, y = $('expected-y').value;
    $('position-error').textContent = x !== '' && y !== '' && roomReady && available(target) && target.data.x_m !== null ?
      `N3 position error: ${Math.hypot(target.data.x_m - Number(x), target.data.y_m - Number(y)).toFixed(3)} m` : 'Optional: enter independently measured N3 coordinates in this relative frame.';
  } else $('position-error').textContent = expected !== '' && available(report) && report.data.x_m !== null ?
    `N2 absolute error: ${Math.abs(report.data.x_m - Number(expected)).toFixed(3)} m` : 'Enter an independent measurement to compare with N2.';
  renderMap(roomReady); renderChart('N1-N2', '12'); renderChart('N1-N3', '13'); renderChart('N2-N3', '23');
  $('diagnostics').textContent = [...model.diagnostics].map(([id, e]) => `${id}: ${e.data.ranges_ok} successful / ${e.data.ranges_failed} failed ranges, ${e.data.rx_errors} RX errors, ${e.data.tx_errors} TX errors, ${e.data.usb_dropped ?? 0} USB lines dropped${available(e) ? '' : ' (stale)'}`).join('\n') || 'No diagnostics received.';
  if ($('log').textContent !== model.log.join('\n')) { $('log').textContent = model.log.join('\n'); $('log').scrollTop = $('log').scrollHeight; }
}
function consume(line) {
  model.ingest(line, clock());
  const identity = model.identity?.data;
  if (port && identity) connectionMessage = `${identity.source === 'N0' ? 'Unassigned board' : identity.source} connected · ${identity.board_id}`;
  const data = parseLine(line);
  if (data?.type === 'radio-test') statusMessage(model.lastMessage);
  if (data?.type === 'setup') { pendingUntil = 0; statusMessage(data.message); }
  if (data?.type === 'error') statusMessage(`${data.reason}: ${data.stage}. Check wiring and RF configuration.`);
}
async function send(command) {
  if (!port?.writable) throw new Error('Connect a USB node first.');
  const writer = port.writable.getWriter();
  try { await writer.write(new TextEncoder().encode(command + '\n')); }
  finally { writer.releaseLock(); }
}
async function readSerial(opened) {
  const lines = new Lines(), decoder = new TextDecoder();
  reader = opened.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lines.feed(decoder.decode(value, { stream: true }), consume);
    }
  } catch (error) { statusMessage(`USB connection ended. ${error.message}. Reconnect the board when ready.`); }
  finally {
    reader.releaseLock(); reader = null;
    try { await opened.close(); } catch { /* A physically removed port can already be closed. */ }
    if (port === opened) port = null;
    if (pendingUntil) statusMessage('USB disconnected before the command was confirmed. Reconnect and check the saved settings.');
    pendingUntil = 0;
    connectionMessage = 'USB disconnected. Freshness checks stopped; reconnect to resume.';
    render();
  }
}
$('connect').onclick = async () => {
  opening = true; render();
  let opened;
  try {
    opened = await serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] });
    await opened.open({ baudRate: 115200, bufferSize: 8192 });
    // Pico USB CDC uses DTR to decide whether a terminal is connected.
    try { await opened.setSignals({ dataTerminalReady: true }); }
    catch (error) { await opened.close(); throw error; }
    port = opened; mode = 'live'; playing = false; recording = null;
    model = new Monitor(performance.now()); formKey = ''; pendingUntil = 0; statusMessage('');
    connectionMessage = 'USB open. Waiting for firmware identity.';
    readTask = readSerial(opened);
    await send('GET');
  } catch (error) {
    if (error.name !== 'NotFoundError') statusMessage(`Cannot connect: ${error.message}. Close other serial monitors and retry.`);
    if (port && reader) await reader.cancel().catch(() => {});
    if (readTask) await readTask;
  } finally { opening = false; render(); }
};
$('disconnect').onclick = async () => { if (reader) await reader.cancel().catch(() => {}); if (readTask) await readTask; };
$('settings').onsubmit = async event => {
  event.preventDefault();
  if (!$('settings').reportValidity() || !port || mode !== 'live' || $('save').disabled) return;
  const length = model.coordinateFrame === ROOM_FRAME ? 0 : Math.round(Number($('baseline').value) * 1000), power = Number.parseInt($('tx-power').value, 16);
  const command = `SET ${$('node-id').value} ${$('network').value} ${length} ${$('tx-delay').value} ${$('rx-delay').value} ${power}`;
  writing = true; pendingUntil = performance.now() + 8000;
  statusMessage('Settings sent. Waiting for the board to confirm the save.'); render();
  try { await send(command); }
  catch (error) { pendingUntil = 0; statusMessage(`Settings were not confirmed: ${error.message}`); }
  finally { writing = false; render(); }
};
$('restart').onclick = async () => {
  if ($('restart').disabled) return;
  pendingUntil = performance.now() + 8000; statusMessage('Restart requested. Waiting for confirmation.'); render();
  try { await send('REBOOT'); }
  catch (error) { pendingUntil = 0; statusMessage(error.message); }
};
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(model.exportSession(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `mesh-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('import').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || port) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Recording exceeds 20 MB.');
    recording = parseSession(await file.text()); mode = 'recording';
    model = new Monitor(0); replayIndex = 0; replayTime = recording.samples[0].at_ms;
    replayStart = performance.now() - replayTime; playing = true;
    statusMessage('Recorded data. No hardware is connected or configured during replay.'); render();
  } catch (error) { statusMessage(`Cannot open recording: ${error.message}`); }
};
$('play').onclick = () => {
  if (!recording) return;
  if (playing) playing = false;
  else {
    if (replayIndex >= recording.samples.length) { model = new Monitor(0); replayIndex = 0; replayTime = recording.samples[0].at_ms; }
    replayStart = performance.now() - replayTime; playing = true;
  }
  render();
};
$('expected').oninput = render;
$('expected-x').oninput = render; $('expected-y').oninput = render;
if (!serial) statusMessage('Live USB requires Chrome or Edge on this Mac. Recording replay works without Web Serial.');
setInterval(() => {
  if (pendingUntil && performance.now() >= pendingUntil) { pendingUntil = 0; statusMessage('The board did not confirm the command. Reconnect and check its settings before retrying.'); }
  if (playing && recording) {
    replayTime = Math.min(performance.now() - replayStart, recording.samples.at(-1).at_ms);
    while (replayIndex < recording.samples.length && recording.samples[replayIndex].at_ms <= replayTime) {
      const sample = recording.samples[replayIndex++]; model.ingest(sample.line, sample.at_ms);
    }
    if (replayIndex >= recording.samples.length) playing = false;
  }
  render();
}, 500);
render();

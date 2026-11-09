// Uses a mocked USB stream. This verifies the UI, never physical UWB or SPI.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../monitor/', import.meta.url);
const files = new Set(['index.html', 'app.js', 'model.js', 'style.css']);
const server = createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!files.has(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(new URL(file, root)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.commands = [];
    window.testIdentity = { v: 1, type: 'identity', source: 'N0', node_id: 0, setup_version: 1, board_id: 'TEST-USB-BOARD', boot: 1,
      network: 60785, line_length_mm: 0, channel: 5, tx_power: '00000000', tx_ant_delay: 16385, rx_ant_delay: 16385, radio_ready: false };
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {
      async requestPort() {
        let controller;
        const readable = new ReadableStream({ start(c) { controller = c; } });
        const emit = data => controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + '\n'));
        window.emitUSB = emit;
        return { readable,
          writable: new WritableStream({ write(bytes) {
            const command = new TextDecoder().decode(bytes).trim(); window.commands.push(command);
            if (command === 'GET') emit(window.testIdentity);
            else if (command.startsWith('SET ')) {
              const [id, network, baseline, tx, rx, power] = command.slice(4).split(' ').map(Number);
              Object.assign(window.testIdentity, { node_id: id, source: 'N' + id, network, line_length_mm: baseline,
                tx_ant_delay: tx, rx_ant_delay: rx, tx_power: power.toString(16).padStart(8, '0'), boot: 2, radio_ready: true });
              setTimeout(() => { emit({ v: 1, type: 'setup', ok: true, message: 'Saved. Restarting. Reconnect USB.' }); controller.close(); }, 30);
            }
          } }), async open() {}, async close() {}, async setSignals(signals) { window.usbSignals = signals; }
        };
      }
    } });
  });
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('button', { name: 'Connect USB node' }).click();
  await expect(page.locator('#board')).toContainText('ID unassigned');
  assert.deepEqual(await page.evaluate(() => window.usbSignals), { dataTerminalReady: true });
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#node-id').selectOption('1');
  await page.locator('#network').fill('42'); await page.locator('#baseline').fill('10');
  await page.locator('#save').click();
  await expect(page.locator('#mode')).toHaveText('Disconnected');
  assert.deepEqual(await page.evaluate(() => window.commands), ['GET', 'SET 1 42 10000 16385 16385 0']);
  await page.getByRole('button', { name: 'Connect USB node' }).click();
  await expect(page.locator('#board')).toContainText('N1');
  await page.evaluate(() => {
    for (const [n, x, hops] of [[1, 0, 0], [2, 4, 1], [3, 10, 2]]) window.emitUSB({ v: 1, type: 'report', source: 'N' + n, receiver: 'N1', boot: 2, seq: 1,
      status: n === 2 ? 'located' : 'reference', x_m: x, y_m: 0, residual_m: 0.01, age_ms: 0, hops, calibrated: false });
    for (const [a, mm, hops] of [[1, 4000, 0], [2, 6000, 1]]) window.emitUSB({ v: 1, type: 'measurement', kind: 'range', receiver: 'N1', source: 'N' + a,
      a, b: a + 1, boot: 2, seq: 2, value_mm: mm, age_ms: 0, hops, mode: 'live' });
  });
  await expect(page.locator('#checks')).toContainText('All three nodes reporting');
  await expect(page.locator('#checks')).toContainText('Endpoint report crossed two hops');
  await expect(page.locator('#range-12')).toHaveText('4.000 m');
  await page.locator('#expected').fill('4.2');
  await expect(page.locator('#position-error')).toContainText('0.200 m');
  await expect(page.locator('#map')).toContainText('4.000 m');
  await page.screenshot({ path: fileURLToPath(new URL('../build-host/monitor-wide.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: fileURLToPath(new URL('../build-host/monitor-mobile.png', import.meta.url)), fullPage: true });
  await page.clock.fastForward(6100);
  await expect(page.locator('#nodes')).toContainText('Stale report');
  await expect(page.locator('#range-12')).toContainText('stale');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#nodes')).toContainText('Stale report');
  await expect(page.locator('#save')).toBeDisabled();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.kind, 'mesh-usb-session'); assert(exported.samples.length >= 6);
  await page.locator('#import').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator('#mode')).toContainText('Recording');
  await expect(page.locator('#nodes')).toContainText('Located');
  await expect(page.locator('#save')).toBeDisabled();

  // A room firmware identity uses the same setup command with its legacy baseline reserved as zero.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.evaluate(() => {
    window.testIdentity = { ...window.testIdentity, source: 'N0', node_id: 0, board_id: 'ROOM-USB-BOARD', boot: 1,
      geometry: 'relative-triangle', wire_version: 2, line_length_mm: 12345, radio_ready: false };
    window.emitRoomReport = (n, seq, status) => {
      const [x, y] = [[0, 0], [4, 0], [-3, 4]][n - 1];
      const positioned = !status || status === 'relative' || status === 'reference';
      window.emitUSB({ v: 1, type: 'report', source: 'N' + n, receiver: 'N1', boot: 2, seq,
        status: status ?? (n === 1 ? 'reference' : 'relative'), x_m: positioned ? x : null, y_m: positioned ? y : null,
        residual_m: null, age_ms: 0, hops: n === 1 ? 0 : 1, calibrated: false,
        coordinate_frame: 'relative-n1-n2-positive-y', reflection_ambiguous: true });
    };
    window.emitRoomRanges = (seq, include13 = true) => {
      for (const [a, b, mm, offset] of [[1, 2, 4000, 0], [1, 3, 5000, 1], [2, 3, 8062, 2]]) {
        if (b === 3 && a === 1 && !include13) continue;
        window.emitUSB({ v: 1, type: 'measurement', kind: 'range', receiver: 'N1', source: 'N' + a,
          a, b, boot: 2, seq: seq * 10 + offset, value_mm: mm, age_ms: 0, hops: a === 1 ? 0 : 1, mode: 'live' });
      }
    };
  });
  await page.getByRole('button', { name: 'Connect USB node' }).click();
  await expect(page.locator('#board')).toContainText('ROOM-USB-BOARD');
  await expect(page.locator('#baseline-field')).toBeHidden();
  await expect(page.locator('#baseline')).toBeDisabled();
  await page.locator('#network').fill('43');
  await page.evaluate(() => { document.getElementById('baseline').value = '999'; });
  await page.locator('#save').click();
  await expect(page.locator('#mode')).toHaveText('Disconnected');
  assert.deepEqual((await page.evaluate(() => window.commands)).slice(-2), ['GET', 'SET 1 43 0 16385 16385 0']);
  await page.getByRole('button', { name: 'Connect USB node' }).click();
  await page.evaluate(() => {
    for (const n of [1, 2, 3]) window.emitRoomReport(n, 1);
    window.emitRoomRanges(1, false);
  });
  await expect(page.locator('#checks')).toContainText('All three nodes reporting');
  await expect(page.locator('#map .position')).toHaveCount(0);
  await expect(page.locator('#map-note')).toContainText('All three measured links');
  await page.evaluate(() => window.emitRoomRanges(1));
  await expect(page.locator('#map .position')).toHaveCount(3);
  await expect(page.locator('#map-note')).toContainText('mirror layout');
  await expect(page.locator('#range-13')).toHaveText('5.000 m');
  await expect(page.locator('#checks')).toContainText('All three ranges are fresh');
  await expect(page.locator('#checks')).not.toContainText('two hops');
  await expect(page.locator('#map [data-node="N3"]')).toContainText('-3.000, 4.000 m');
  const plotted = await page.locator('#map').evaluate(svg => Object.fromEntries([...svg.querySelectorAll('g[data-node]')].map(g => {
    const point = g.querySelector('circle'); return [g.dataset.node, { x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')) }];
  })));
  assert(plotted.N3.x < plotted.N1.x && plotted.N3.y < plotted.N1.y);
  await page.locator('#expected-x').fill('-3.1'); await page.locator('#expected-y').fill('4.2');
  await expect(page.locator('#position-error')).toContainText('0.224 m');
  await page.evaluate(() => window.emitRoomReport(3, 2, 'poor-geometry'));
  await expect(page.locator('#map .position')).toHaveCount(0);
  await expect(page.locator('#nodes')).toContainText('Triangle too narrow');
  await page.evaluate(() => window.emitRoomReport(3, 3));
  await expect(page.locator('#map .position')).toHaveCount(3);
  const roomDownloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const roomDownload = await roomDownloadPromise;
  const roomRecording = JSON.parse(await readFile(await roomDownload.path(), 'utf8'));
  await page.screenshot({ path: fileURLToPath(new URL('../build-host/monitor-room-wide.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: fileURLToPath(new URL('../build-host/monitor-room-mobile.png', import.meta.url)), fullPage: true });
  await page.clock.fastForward(5000);
  await page.evaluate(() => {
    for (const n of [1, 2, 3]) window.emitRoomReport(n, 4);
    window.emitRoomRanges(2, false);
  });
  await page.clock.fastForward(1200);
  await expect(page.locator('#range-13')).toContainText('stale');
  await expect(page.locator('#map .position')).toHaveCount(0);
  await expect(page.locator('#nodes')).toContainText('Relative estimate');
  await expect(page.locator('#position-error')).toContainText('Optional:');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#map .position')).toHaveCount(0);
  await page.locator('#import').setInputFiles({ name: 'room-session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(roomRecording)) });
  await expect(page.locator('#mode')).toContainText('Recording');
  await expect(page.locator('#map .position')).toHaveCount(3);
  await expect(page.locator('#map [data-node="N3"]')).toContainText('-3.000, 4.000 m');
  await expect(page.locator('#save')).toBeDisabled();
  assert.deepEqual(errors, []);
  console.log('PASS: legacy and room USB setup, node-reported 2D layout, all-pair charts, stale/withdrawal/disconnect, export/replay and mobile layout');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }

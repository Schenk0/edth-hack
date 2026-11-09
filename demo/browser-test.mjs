// Mocked USB only. No physical serial port or radio is opened.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const server = await createServer({ configFile: false, root: 'demo', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install();
  const mockedUSB = () => {
    window.commands = [];
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() {
      if (window.cancelSelection) throw new DOMException('No port selected by the user.', 'NotFoundError');
      let controller;
      const readable = new ReadableStream({ start(c) { controller = c; } });
      window.emit = data => controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + '\n'));
      window.unplug = () => controller.close();
      return { readable, writable: new WritableStream({ write(bytes) {
        const command = new TextDecoder().decode(bytes).trim(); window.commands.push(command);
        if (command === 'GET') window.emit({ v: 1, type: 'identity', source: 'N2', board_id: 'TEST', boot: 1, network: 60785,
          line_length_mm: 0, channel: 5, tx_power: '00000000', tx_ant_delay: 16385, rx_ant_delay: 16385,
          geometry: 'relative-triangle', wire_version: 2, layout_version: window.layoutVersion, radio_ready: true });
      } }), async open() {
        if (window.portBusy) throw new DOMException('Failed to open serial port.', 'NetworkError');
      }, async close() {}, async setSignals(value) { window.signals = value; } };
    } } });
    window.feed = (seq = 1, missing = false, age_ms = 0, usb_delay_ms = 0, incoherent = false, missingRange = false) => {
      for (const [n, x, y] of [[1,0,0], [2,4,0], [3,1,3]]) {
        if (missing && n === 3) continue;
        window.emit({ v: 1, type: 'report', source: 'N'+n, receiver: 'N2', boot: 1, seq, age_ms, usb_delay_ms, hops: n === 2 ? 0 : 1,
          coordinate_frame: 'relative-n1-n2-positive-y', reflection_ambiguous: true, status: n === 1 ? 'reference' : 'relative',
          x_m: incoherent && n === 2 ? 7 : incoherent && n === 3 ? -2 : x,
          y_m: incoherent && n === 3 ? 6 : y, residual_m: null, calibrated: false });
      }
      for (const [a,b,value_mm] of [[1,2,4000],[1,3,3162],[2,3,4243]]) {
        if (missingRange && a === 1 && b === 3) continue;
        window.emit({ v: 1, type: 'measurement', source:'N'+a,
          receiver:'N2', boot:1, seq, age_ms, usb_delay_ms, hops:0, mode:'live', kind:'range', a,b,value_mm });
      }
    };
    window.feedLayout = (seq, status = 'relative', age_ms = 0, usb_delay_ms = 0) => window.emit({
      v: 1, type: 'layout', source: 'N2', receiver: 'N2', boot: 1, seq, status, age_ms, usb_delay_ms, hops: 0,
      coordinate_frame: 'relative-n1-n2-positive-y', reflection_ambiguous: true, calibrated: false,
      positions: status === 'relative' ? [{ id: 'N1', x_m: 0, y_m: 0 }, { id: 'N2', x_m: 4, y_m: 0 }, { id: 'N3', x_m: 1, y_m: 3 }] : null,
      ranges_mm: status === 'relative' ? [4000, 3162, 4243] : null,
    });
  };
  await page.addInitScript(mockedUSB);
  await page.goto(server.resolvedUrls.local[0]);
  await expect(page.getByRole('button', { name: 'Locate nodes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect USB', exact: true }).click();
  await expect(page.locator('#connection')).toHaveText('N2 connected via USB');
  assert.deepEqual(await page.evaluate(() => window.signals), { dataTerminalReady: true });
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  // Existing reports cannot bypass the operator's Locate action.
  await page.evaluate(() => window.feed());
  await page.clock.runFor(500);
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  await page.clock.runFor(1);
  await page.getByRole('button', { name: 'Locate nodes', exact: true }).click();
  await page.evaluate(() => window.feed(2, true));
  await page.clock.runFor(500);
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  // Post-click delivery does not make pre-click observations new.
  await page.evaluate(() => window.feed(3, false, 1000));
  await page.clock.runFor(500);
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  await page.evaluate(() => window.feed(4, false, 0, 2000));
  await page.clock.runFor(500);
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  await page.evaluate(() => window.feed(5));
  await page.clock.runFor(500);
  await expect(page.locator('#phase')).toHaveText('Relative layout ready');
  await expect(page.locator('#map [data-node]')).toHaveCount(3);
  // N2 is USB, so N1 and N3 must be translated relative to N2, preserving equal axis scale.
  await expect(page.locator('#map [data-node="N1"]')).toContainText('-4.00, 0.00 m');
  await expect(page.locator('#map [data-node="N3"]')).toContainText('-3.00, 3.00 m');
  await page.screenshot({ path: '/tmp/mesh-demo-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/mesh-demo-mobile.png', fullPage: true });
  await page.clock.runFor(29000);
  await expect(page.locator('#phase')).toHaveText('Relative layout ready');
  await expect(page.locator('#map [data-node]')).toHaveCount(3);
  await page.clock.runFor(1100);
  await expect(page.locator('#phase')).toHaveText('Position data expired');
  await expect(page.locator('#map [data-node]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Locate again', exact: true }).click();
  await page.clock.runFor(15500);
  await expect(page.locator('#phase')).toHaveText('Layout unavailable');
  // Returning nodes complete the requested Locate even after its initial timeout.
  await page.evaluate(() => window.feed(6));
  await page.clock.runFor(500);
  await expect(page.locator('#phase')).toHaveText('Relative layout ready');
  await page.evaluate(() => window.unplug());
  await expect(page.locator('#connection')).toHaveText('No USB node connected');
  await expect(page.locator('#map [data-node]')).toHaveCount(0);
  await page.locator('.tools summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save session' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  await page.locator('#import').setInputFiles(path);
  await page.clock.runFor(1000);
  await expect(page.locator('#source')).toHaveText('Recorded session');
  await page.getByRole('button', { name: 'Locate nodes', exact: true }).click();
  await page.clock.runFor(500);
  await expect(page.locator('#phase')).toHaveText('Relative layout ready');
  assert.deepEqual(await page.evaluate(() => window.commands), ['GET', 'GET', 'GET']);
  await page.evaluate(() => { window.cancelSelection = true; });
  await page.getByRole('button', { name: 'Connect USB', exact: true }).click();
  await expect(page.locator('#message')).toContainText('No USB node selected');
  await expect(page.getByRole('button', { name: 'Connect USB', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.cancelSelection = false; window.portBusy = true; });
  await page.getByRole('button', { name: 'Connect USB', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Cura');
  await expect(page.getByRole('button', { name: 'Connect USB', exact: true })).toBeEnabled();
  // A recording can be analyzed without opening a hardware port.
  await expect(page.locator('#capture-stationary')).toBeDisabled();
  await page.locator('#analyze-stationary').click();
  await expect(page.locator('#measurement-result')).toContainText('Jitter only');
  await expect(page.locator('[data-measurement-node="N1"]')).toContainText('not tested');
  await page.locator('#reference-12').fill('4');
  await page.locator('#analyze-stationary').click();
  await expect(page.locator('#measurement-status')).toContainText('all three');
  await expect(page.locator('#save-stationary')).toBeEnabled();
  await page.locator('#reference-13').fill('1');
  await page.locator('#reference-23').fill('1');
  await page.locator('#analyze-stationary').click();
  await expect(page.locator('#measurement-status')).toContainText(/triangle/i);
  await page.locator('#reference-13').fill(String(Math.sqrt(10)));
  await page.locator('#reference-23').fill(String(Math.sqrt(18)));
  await page.locator('#analyze-stationary').click();
  await expect(page.locator('#measurement-result')).toContainText('Tape reference supplied');
  await expect(page.locator('#save-stationary')).toBeEnabled();
  await page.evaluate(() => { window.portBusy = false; });
  await page.getByRole('button', { name: 'Connect USB', exact: true }).click();
  await expect(page.locator('#connection')).toHaveText('N2 connected via USB');
  await page.locator('#capture-stationary').click();
  await expect(page.locator('#measurement-status')).toContainText('Settling');
  await expect(page.locator('#reference-12')).toBeDisabled();
  for (let second = 0; second < 60; second++) {
    await page.evaluate(seq => window.feed(seq), 10 + second);
    await page.clock.runFor(1000);
  }
  await expect(page.locator('#measurement-status')).toContainText('Stationary capture complete');
  await expect(page.locator('#measurement-status')).toContainText(/55\.\d seconds evaluated/);
  await expect(page.locator('#reference-12')).toBeEnabled();
  await expect(page.locator('[data-measurement-node="N3"]')).not.toContainText('n/a');
  const measurementDownloadPromise = page.waitForEvent('download');
  await page.locator('#save-stationary').click();
  const measurementPath = await (await measurementDownloadPromise).path();
  const measured = JSON.parse(await readFile(measurementPath, 'utf8'));
  assert.equal(measured.kind, 'mesh-usb-session');
  assert(measured.duration_ms >= 60000 && measured.duration_ms < 61000);
  assert(Math.abs(measured.wall_duration_ms - measured.duration_ms) <= 2000);
  assert.equal(measured.reference.n1n2M, 4);
  assert(measured.samples.every(sample => sample.at_ms >= 0 && sample.at_ms <= 60000));
  assert(measured.analysis.nodes.find(node => node.id === 'N3').count >= 20);
  assert.equal(measured.analysis.nodes.find(node => node.id === 'N1').accuracy, null);
  // Mac sleep can advance wall time while performance time is suspended.
  // A prior valid result must not survive an unusable capture, but raw data must.
  await page.locator('#capture-stationary').click();
  await page.evaluate(() => {
    window.wallNow = Date.now;
    Date.now = () => window.wallNow() + 106000;
  });
  for (let second = 0; second < 60; second++) {
    await page.evaluate(seq => window.feed(seq), 300 + second);
    await page.clock.runFor(1000);
  }
  await expect(page.locator('#measurement-status')).toContainText(/sleep|clock/i);
  await expect(page.locator('#measurement-result')).toBeEmpty();
  await expect(page.locator('#save-stationary')).toBeEnabled();
  const interruptedDownloadPromise = page.waitForEvent('download');
  await page.locator('#save-stationary').click();
  const interruptedPath = await (await interruptedDownloadPromise).path();
  const interrupted = JSON.parse(await readFile(interruptedPath, 'utf8'));
  assert(interrupted.duration_ms >= 60000 && interrupted.duration_ms < 61000);
  assert(Math.abs(interrupted.wall_duration_ms - interrupted.duration_ms - 106000) <= 2000);
  assert.equal(interrupted.analysis, null);
  assert(interrupted.samples.length > 20);
  await page.evaluate(() => { Date.now = window.wallNow; });
  await page.locator('#capture-stationary').click();
  await page.locator('#cancel-stationary').click();
  await expect(page.locator('#measurement-status')).toContainText('cancelled');
  await expect(page.locator('#save-stationary')).toBeDisabled();
  // Missing reports remain missing; a capture does not invent a node position.
  await page.locator('#capture-stationary').click();
  for (let second = 0; second < 60; second++) {
    await page.evaluate(seq => window.feed(seq, true), 400 + second);
    await page.clock.runFor(1000);
  }
  await expect(page.locator('[data-measurement-node="N3"] td').nth(1)).toHaveText('0');
  await expect(page.locator('[data-measurement-node="N3"]')).toContainText('n/a');
  await page.locator('#capture-stationary').click();
  await page.evaluate(() => window.feed(500));
  await page.clock.runFor(6500);
  await page.evaluate(() => window.unplug());
  await expect(page.locator('#measurement-status')).toContainText('USB disconnected. Partial capture');
  await expect(page.locator('#capture-stationary')).toBeDisabled();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/mesh-measurement-mobile.png', fullPage: true });
  await page.locator('#import').setInputFiles(interruptedPath);
  await page.locator('#analyze-stationary').click();
  await expect(page.locator('#measurement-status')).toContainText(/sleep|clock/i);
  await expect(page.locator('#measurement-result')).toBeEmpty();
  await expect(page.locator('#save-stationary')).toBeEnabled();
  // New firmware supplies one coherent snapshot. Individual reports may disagree with it.
  const layoutPage = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  layoutPage.on('pageerror', e => errors.push(e.message));
  await layoutPage.clock.install();
  await layoutPage.addInitScript(mockedUSB);
  await layoutPage.goto(server.resolvedUrls.local[0]);
  await layoutPage.evaluate(() => { window.layoutVersion = 1; });
  await layoutPage.getByRole('button', { name: 'Connect USB', exact: true }).click();
  await expect(layoutPage.locator('#connection')).toHaveText('N2 connected via USB');
  await layoutPage.evaluate(() => { window.feed(1); window.feedLayout(1); });
  await layoutPage.clock.runFor(501);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.getByRole('button', { name: 'Locate nodes', exact: true }).click();
  // A layout never substitutes for missing post-Locate reports.
  await layoutPage.evaluate(() => { window.feed(2, true); window.feedLayout(2); });
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => { window.feed(3, false, 0, 0, true); window.feedLayout(3, 'relative', 1000); });
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => { window.feed(4, false, 0, 0, true); window.feedLayout(4, 'relative', 0, 2000); });
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => window.feed(5, false, 0, 0, true));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => window.feedLayout(5));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#phase')).toHaveText('Relative layout ready');
  await expect(layoutPage.locator('#map [data-node="N1"]')).toContainText('-4.00, 0.00 m');
  await expect(layoutPage.locator('#map [data-node="N3"]')).toContainText('-3.00, 3.00 m');
  await expect(layoutPage.locator('#nodes .node').nth(2)).toContainText('-3.00');
  await expect(layoutPage.locator('#frame-note')).toBeVisible();
  await expect(layoutPage.locator('#frame-note')).toContainText('Approximate relative positions');
  await layoutPage.screenshot({ path: '/tmp/mesh-demo-coherent-layout.png', fullPage: true });
  // Fresh individual reports cannot keep an expired MCU layout visible.
  await layoutPage.clock.runFor(29000);
  await layoutPage.evaluate(() => window.feed(6, false, 0, 0, true));
  await layoutPage.clock.runFor(600);
  await expect(layoutPage.locator('#phase')).toHaveText('Position data expired');
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => window.feedLayout(6, 'inconsistent-ranges'));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#phase')).toHaveText('Layout unavailable');
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => window.emit({ v: 1, type: 'layout', source: 'N2', receiver: 'N2', boot: 1, seq: 7,
    status: 'relative', age_ms: 0, hops: 0, coordinate_frame: 'relative-n1-n2-positive-y',
    reflection_ambiguous: true, calibrated: false, positions: [], ranges_mm: [4000, 3162, 4243] }));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => window.feedLayout(8, 'poor-geometry'));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => { window.feed(9); window.feedLayout(9); });
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(3);
  // A fresh MCU layout also cannot replace an expired raw range.
  await layoutPage.clock.runFor(29000);
  await layoutPage.evaluate(() => { window.feed(10, false, 0, 0, false, true); window.feedLayout(10); });
  await layoutPage.clock.runFor(600);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.evaluate(() => { window.feed(11); window.feedLayout(11); });
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(3);
  await layoutPage.evaluate(() => window.emit({ v: 1, type: 'report', source: 'N3', receiver: 'N2', boot: 1, seq: 12,
    status: 'poor-geometry', age_ms: 0, hops: 1, coordinate_frame: 'relative-n1-n2-positive-y',
    reflection_ambiguous: true, calibrated: false, residual_m: null, x_m: null, y_m: null }));
  await layoutPage.clock.runFor(500);
  await expect(layoutPage.locator('#map [data-node]')).toHaveCount(1);
  await layoutPage.close();
  // A working N1-N3 link must name the missing N2 without inventing a triangle.
  const missingNodePage = await browser.newPage();
  missingNodePage.on('pageerror', e => errors.push(e.message));
  await missingNodePage.goto(server.resolvedUrls.local[0]);
  const missingNodeRecords = [
    { v: 1, type: 'identity', source: 'N3', board_id: 'TEST', boot: 1, network: 60785, line_length_mm: 0,
      channel: 5, tx_power: 'fdfdfdfd', tx_ant_delay: 16387, rx_ant_delay: 16387, geometry: 'relative-triangle', wire_version: 2, radio_ready: true },
    ...[1, 3].map(n => ({ v: 1, type: 'report', source: `N${n}`, receiver: 'N3', boot: 1, seq: 1, age_ms: 0, hops: n === 3 ? 0 : 1,
      coordinate_frame: 'relative-n1-n2-positive-y', reflection_ambiguous: true, status: 'missing-measurements',
      x_m: null, y_m: null, residual_m: null, calibrated: false })),
    { v: 1, type: 'measurement', source: 'N1', receiver: 'N3', boot: 1, seq: 2, age_ms: 0, hops: 0, mode: 'live', kind: 'range', a: 1, b: 3, value_mm: 2105 },
  ];
  await missingNodePage.locator('#import').setInputFiles({ name: 'missing-N2.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, kind: 'mesh-usb-session', samples: missingNodeRecords.map(data => ({ at_ms: 0, line: JSON.stringify(data) })) })) });
  await missingNodePage.getByRole('button', { name: 'Locate nodes', exact: true }).click();
  await expect(missingNodePage.locator('#guidance')).toBeVisible();
  await expect(missingNodePage.locator('#guidance')).toContainText('Waiting for N2.');
  await expect(missingNodePage.locator('#node-count')).toHaveText('2 / 3');
  await expect(missingNodePage.locator('#map [data-node]')).toHaveCount(1);
  await missingNodePage.close();
  assert.deepEqual(errors, []);
  console.log('Demo verified: coherent MCU layout, strict withdrawal/expiry/post-Locate checks, legacy fallback, USB/Locate, replay, stationary capture, raw export after clock discontinuity, missing data, capture cancel/disconnect and mobile layout.');
} finally { await browser?.close(); await server.close(); }

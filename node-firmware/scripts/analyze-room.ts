#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { analyzeStationary, type Recording, type ReferenceDistances } from '../../demo/accuracy.ts';

const help = `Analyze a stationary room recording. No USB access or settings changes.

node node-firmware/scripts/analyze-room.ts recording.json
node node-firmware/scripts/analyze-room.ts recording.json --distances 1.42 1.37 1.06 --out result.json

--distances gives independently measured N1-N2, N1-N3, N2-N3 distances in metres.
Without distances, results describe repeatability, not accuracy.
--settle-seconds defaults to 5. Keep the nodes still throughout the recording.
Requires Node.js with TypeScript support, as used by this project.`;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reference(value: unknown): ReferenceDistances | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw new Error('Invalid reference distances');
  const { n1n2M, n1n3M, n2n3M } = value;
  if ([n1n2M, n1n3M, n2n3M].some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) {
    throw new Error('Reference distances must be positive finite numbers');
  }
  if (typeof n1n2M !== 'number' || typeof n1n3M !== 'number' || typeof n2n3M !== 'number') {
    throw new Error('Reference distances must be numbers');
  }
  return { n1n2M, n1n3M, n2n3M };
}

function recording(value: unknown): Recording {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.samples)) {
    throw new Error('Expected a version 1 USB recording with samples');
  }
  const samples = value.samples.map((sample: unknown) => {
    if (!object(sample) || typeof sample.at_ms !== 'number' || typeof sample.line !== 'string') {
      throw new Error('Invalid recording sample');
    }
    return { at_ms: sample.at_ms, line: sample.line };
  });
  if (value.duration_ms !== undefined && typeof value.duration_ms !== 'number') {
    throw new Error('Invalid recording duration');
  }
  if (value.wall_duration_ms !== undefined && typeof value.wall_duration_ms !== 'number') {
    throw new Error('Invalid wall-clock recording duration');
  }
  return { version: 1, samples, duration_ms: value.duration_ms, wall_duration_ms: value.wall_duration_ms };
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log(help);
  } else {
    const filename = args.shift()!;
    let measured: ReferenceDistances | undefined;
    let output: string | undefined;
    let settleMs = 5000;
    while (args.length) {
      const flag = args.shift();
      if (flag === '--distances') {
        const values = args.splice(0, 3);
        if (values.length !== 3) throw new Error('--distances requires three distances');
        measured = reference({ n1n2M: Number(values[0]), n1n3M: Number(values[1]), n2n3M: Number(values[2]) });
      } else if (flag === '--out') {
        output = args.shift();
        if (!output || output.startsWith('--')) throw new Error('--out requires a filename');
        if (output === filename) throw new Error('Use a different output filename to preserve the raw recording');
      } else if (flag === '--settle-seconds') {
        const value = args.shift();
        if (value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0) {
          throw new Error('--settle-seconds requires a nonnegative number');
        }
        settleMs = Number(value) * 1000;
      } else throw new Error(`Unknown option: ${flag}`);
    }
    if (statSync(filename).size > 20 * 1024 * 1024) throw new Error('Recording exceeds 20 MB');
    const raw: unknown = JSON.parse(readFileSync(filename, 'utf8'));
    const input = recording(raw);
    const savedReference = !measured && object(raw) ? reference(raw.reference) : undefined;
    const result = analyzeStationary(input, { settleMs, reference: measured ?? savedReference });
    const json = JSON.stringify(result, null, 2) + '\n';
    if (output) writeFileSync(output, json, { flag: 'wx' });
    console.log(json.trimEnd());
  }
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

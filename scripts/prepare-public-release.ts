#!/usr/bin/env bun
import { exportPublicRelease } from './lib/public-release.ts';
const [harness, app, destination, receipt, harnessRef, appRef] = Bun.argv.slice(2);
if (!harness || !app || !destination || !receipt) throw Error('Usage: bun scripts/prepare-public-release.ts HARNESS APP OUTPUT PRIVATE_RECEIPT [HARNESS_REF APP_REF]');
const manifest = await exportPublicRelease({ harness, app, destination, receipt, harnessRef, appRef });
console.log(JSON.stringify({ version: manifest.version, files: manifest.files.length, publication: 'not performed' }));

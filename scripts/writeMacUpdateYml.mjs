#!/usr/bin/env node
/**
 * Build latest-mac.yml for electron-updater.
 *
 * macOS in-app updates require a .zip of the .app (a .dmg is only for
 * first-time install). Pass the zip files first so the feed lists them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
const outPath = process.argv[3];
const inputs = process.argv.slice(4);

if (!version || !outPath || inputs.length === 0) {
  console.error(
    'usage: writeMacUpdateYml.mjs <version> <out.yml> <file.zip> [file...]',
  );
  process.exit(1);
}

const missing = inputs.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`Missing files:\n${missing.join('\n')}`);
  process.exit(1);
}

const entries = inputs.map((p) => {
  const data = fs.readFileSync(p);
  return {
    url: path.basename(p),
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
    size: data.length,
  };
});

const zips = entries.filter((f) => f.url.endsWith('.zip'));
if (zips.length === 0) {
  console.error(
    'electron-updater on macOS needs a .zip; only received: ' +
      entries.map((f) => f.url).join(', '),
  );
  process.exit(1);
}

const primary =
  zips.find((f) => f.url.includes('arm64')) ||
  zips.find((f) => f.url.includes('x64')) ||
  zips[0];

const yml = [
  'version: ' + version,
  'files:',
  ...entries.flatMap((f) => [
    '  - url: ' + f.url,
    '    sha512: ' + f.sha512,
    '    size: ' + f.size,
  ]),
  'path: ' + primary.url,
  'sha512: ' + primary.sha512,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');

fs.writeFileSync(outPath, yml);
console.log(`Wrote ${outPath} (${zips.length} zip(s))`);

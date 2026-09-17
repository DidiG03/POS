import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('sentry bundle guards', () => {
  it('keeps the SDK off the eager entry', () => {
    expect(read('src/renderer/utils/sentryBrowser.ts')).toContain(
      "import('@sentry/browser')",
    );
  });

  it('never holds the whole @sentry/browser namespace', () => {
    // Rollup cannot tree-shake a namespace object that escapes, so holding it
    // (or parking it on `window`) drags Replay + Feedback + Replay-Canvas in —
    // ~240 kB of a 645 kB chunk for features this app does not use. Destructure
    // the two calls we make instead.
    const src = read('src/renderer/utils/sentryBrowser.ts');
    expect(src).toMatch(/\.then\(\(\{\s*init,\s*captureException\s*\}\)/);
    expect(src).not.toContain('__sentry__');
    expect(src).not.toMatch(/typeof import\('@sentry\/browser'\)/);
  });

  it('shortens identifiers in packaged builds but keeps frame names', () => {
    // We ship no source maps, so `keepNames` is what stands between a Sentry
    // stack frame and a wall of single letters.
    const src = read('vite.rendererOptimize.ts');
    expect(src).toContain("apply: 'build'");
    expect(src).toContain('keepNames: true');
    expect(src).toContain('minifyIdentifiers: true');
    // `vite serve` must keep real identifiers for debugging.
    expect(src).toContain('minifyIdentifiers: false');
  });
});

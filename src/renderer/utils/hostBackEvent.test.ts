import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostCameBack } from './hostBackEvent';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('reload when the till comes back (QA round 6, #7)', () => {
  it('only the first answer after a failure counts', () => {
    expect(hostCameBack({ hadFailure: true, ok: true })).toBe(true);
    expect(hostCameBack({ hadFailure: false, ok: true })).toBe(false);
    expect(hostCameBack({ hadFailure: true, ok: false })).toBe(false);
  });

  it('the heartbeat announces it, and counts the very first failed check', () => {
    const src = read('src/renderer/app/AppLayout.tsx');
    const beat = src.slice(src.indexOf('let hadFailure = false;'));
    expect(beat).toContain('announceHostBack()');
    // Set on every miss, not only once the till is declared down: a phone
    // that starts offline may come back before the third miss.
    const miss = beat.slice(beat.indexOf('misses += 1;'));
    expect(miss.slice(0, 80)).toContain('hadFailure = true;');
  });

  it('the floor and the menu reload on it', () => {
    expect(read('src/renderer/app/pages/TablesPage.tsx')).toContain(
      'window.addEventListener(POS_HOST_BACK, onHostBack)',
    );
    expect(read('src/renderer/app/pages/OrderPage.tsx')).toContain(
      'window.addEventListener(POS_HOST_BACK, refresh)',
    );
  });
});

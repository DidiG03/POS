/**
 * "The newest row" is ordered by id, never by createdAt. SQLite DateTime is
 * stored as ISO text by one engine and epoch milliseconds by the other, and
 * every number sorts before every text, so `createdAt DESC` can put an
 * older row first (`tableSession.ts`). Ids only ever rise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('newest-row ordering', () => {
  it('no query orders by createdAt alone', () => {
    const root = path.join(__dirname, '..');
    const offenders = sources(root).filter((f) =>
      /orderBy:\s*\{\s*createdAt:/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

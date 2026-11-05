/**
 * Audit 2026-11, M4: the LAN API's catch-all error replies were sent
 * without CORS headers, so a browser client could not read TABLE_BUSY,
 * 413 or 4xx answers and saw a network failure instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.join(__dirname, 'api.ts'), 'utf8');

/** The outer catch of the request handler: from the 404 fallback to its end. */
function outerCatch(): string {
  const start = api.indexOf("return send(res, 404, 'not found', corsOrigin);");
  expect(start).toBeGreaterThan(0);
  const end = api.indexOf('const server = http.createServer(handler);', start);
  expect(end).toBeGreaterThan(start);
  return api.slice(start, end);
}

describe('LAN API error replies carry CORS headers', () => {
  it('the origin is known outside the try, so the catch can use it', () => {
    expect(api).toMatch(
      /let corsOrigin: ReturnType<typeof cors\.allowOrigin> = null;\s*\n\s*try \{/,
    );
  });

  it('every reply in the catch-all passes corsOrigin', () => {
    const block = outerCatch().split('} catch (e: any) {')[1] ?? '';
    const sends = block.match(/send\([\s\S]*?\);/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(5);
    for (const call of sends) expect(call, call).toContain('corsOrigin');
  });
});

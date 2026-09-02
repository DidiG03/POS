import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveStaticFilePath } from './staticPath';

const ROOT = resolve('/srv/pos/dist/renderer');

describe('resolveStaticFilePath', () => {
  it('resolves a normal asset request', () => {
    expect(resolveStaticFilePath(ROOT, 'assets/app.js')).toBe(
      join(ROOT, 'assets/app.js'),
    );
  });

  it('accepts a leading slash', () => {
    expect(resolveStaticFilePath(ROOT, '/index.html')).toBe(
      join(ROOT, 'index.html'),
    );
  });

  it('rejects a traversal out of the renderer directory', () => {
    expect(resolveStaticFilePath(ROOT, '../../../etc/passwd')).toBeNull();
    expect(resolveStaticFilePath(ROOT, 'assets/../../../db/pos.db')).toBeNull();
  });

  it('rejects a percent-encoded traversal', () => {
    expect(resolveStaticFilePath(ROOT, '%2e%2e/%2e%2e/db/pos.db')).toBeNull();
    expect(resolveStaticFilePath(ROOT, '..%2f..%2fdb%2fpos.db')).toBeNull();
  });

  it('rejects a backslash traversal', () => {
    expect(resolveStaticFilePath(ROOT, '..\\..\\db\\pos.db')).toBeNull();
  });

  it('rejects an absolute path escape', () => {
    expect(resolveStaticFilePath(ROOT, '/../../etc/hosts')).toBeNull();
  });

  it('rejects a NUL byte', () => {
    expect(resolveStaticFilePath(ROOT, 'index.html\0.png')).toBeNull();
  });

  it('rejects a malformed escape', () => {
    expect(resolveStaticFilePath(ROOT, 'assets/%ZZ')).toBeNull();
  });

  it('allows traversal that stays inside the root', () => {
    expect(resolveStaticFilePath(ROOT, 'assets/../index.html')).toBe(
      join(ROOT, 'index.html'),
    );
  });

  it('rejects a sibling directory with a shared prefix', () => {
    expect(
      resolveStaticFilePath(ROOT, '../renderer-secrets/key.pem'),
    ).toBeNull();
  });

  it('rejects empty input', () => {
    expect(resolveStaticFilePath(ROOT, '')).toBeNull();
    expect(resolveStaticFilePath(ROOT, '/')).toBeNull();
    expect(resolveStaticFilePath('', 'index.html')).toBeNull();
  });
});

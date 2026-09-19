import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  gzipBodyIfAccepted,
  gzipHtmlIfAccepted,
  resolveStaticFilePath,
  staticAssetCacheControl,
} from './staticPath';

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

describe('staticAssetCacheControl', () => {
  it('never caches HTML so tablets pick up a host update', () => {
    expect(staticAssetCacheControl('/srv/pos/dist/renderer/index.html')).toBe(
      'no-cache, must-revalidate',
    );
  });

  it('lets hashed Vite assets cache forever', () => {
    expect(
      staticAssetCacheControl(
        '/srv/pos/dist/renderer/assets/index-AbCdEfGh.js',
      ),
    ).toBe('public, max-age=31536000, immutable');
  });
});

describe('gzipHtmlIfAccepted', () => {
  it('gzips HTML when the client accepts gzip', () => {
    const html = Buffer.from(
      '<!doctype html><html><body>OneTap POS</body></html>',
    );
    const packed = gzipHtmlIfAccepted(
      html,
      'text/html; charset=utf-8',
      'gzip, deflate',
    );
    expect(packed.contentEncoding).toBe('gzip');
    expect(gunzipSync(packed.body).toString()).toBe(html.toString());
  });

  it('leaves scripts uncompressed at this layer', () => {
    const js = Buffer.from('console.log("hi")');
    const packed = gzipHtmlIfAccepted(js, 'application/javascript', 'gzip');
    expect(packed.contentEncoding).toBeUndefined();
    expect(packed.body).toBe(js);
  });
});

describe('gzipBodyIfAccepted', () => {
  it('gzips JSON large enough to be worth the CPU', () => {
    const json = Buffer.from(`{"tables":${'[' + '"x",'.repeat(80)}"y"]}`);
    const packed = gzipBodyIfAccepted(
      json,
      'application/json; charset=utf-8',
      'gzip, deflate',
    );
    expect(packed.contentEncoding).toBe('gzip');
    expect(gunzipSync(packed.body).toString()).toBe(json.toString());
  });

  it('leaves tiny JSON uncompressed', () => {
    const json = Buffer.from('{"ok":true}');
    const packed = gzipBodyIfAccepted(json, 'application/json', 'gzip');
    expect(packed.contentEncoding).toBeUndefined();
    expect(packed.body).toBe(json);
  });
});

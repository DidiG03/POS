import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  lucideReactAlias,
  planGzipHtmlBody,
  shouldGzipHtmlDocument,
  stripConditionalGetHeaders,
} from './vite.rendererOptimize';

describe('shouldGzipHtmlDocument', () => {
  it('gzips the document request Lighthouse measures', () => {
    expect(
      shouldGzipHtmlDocument({
        method: 'GET',
        url: '/',
        acceptEncoding: 'gzip, deflate, br',
      }),
    ).toBe(true);
    expect(
      shouldGzipHtmlDocument({
        method: 'GET',
        url: '/index.html',
        acceptEncoding: 'gzip',
      }),
    ).toBe(true);
  });

  it('leaves HMR and module requests alone', () => {
    expect(
      shouldGzipHtmlDocument({
        method: 'GET',
        url: '/src/renderer/main.tsx',
        acceptEncoding: 'gzip',
      }),
    ).toBe(false);
    expect(
      shouldGzipHtmlDocument({
        method: 'GET',
        url: '/',
        acceptEncoding: 'gzip',
        upgrade: 'websocket',
      }),
    ).toBe(false);
    expect(
      shouldGzipHtmlDocument({
        method: 'GET',
        url: '/',
        acceptEncoding: 'identity',
      }),
    ).toBe(false);
  });
});

describe('stripConditionalGetHeaders', () => {
  it('drops If-None-Match so Vite cannot 304 the HTML document', () => {
    const headers: Record<string, unknown> = {
      'if-none-match': 'W/"abc"',
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
      accept: 'text/html',
    };
    stripConditionalGetHeaders(headers);
    expect(headers['if-none-match']).toBeUndefined();
    expect(headers['if-modified-since']).toBeUndefined();
    expect(headers.accept).toBe('text/html');
  });
});

describe('planGzipHtmlBody', () => {
  it('does not rewrite a 304 into 200 with an empty HTML body', () => {
    const planned = planGzipHtmlBody({
      statusCode: 304,
      body: Buffer.alloc(0),
    });
    expect(planned.statusCode).toBe(304);
    expect(planned.body.length).toBe(0);
    expect(planned.contentEncoding).toBeUndefined();
    expect(planned.setContentLength).toBe(false);
  });

  it('gzips a real HTML document', () => {
    const html = Buffer.from(
      '<!doctype html><html><body><div id="root">OneTap POS</div></body></html>',
    );
    const planned = planGzipHtmlBody({ statusCode: 200, body: html });
    expect(planned.statusCode).toBe(200);
    expect(planned.contentEncoding).toBe('gzip');
    expect(gunzipSync(planned.body).toString()).toBe(html.toString());
  });
});

describe('lucideReactAlias', () => {
  it('rewrites only the package entry to the used-icon barrel', () => {
    const alias = lucideReactAlias();
    expect(alias.find.test('lucide-react')).toBe(true);
    expect(alias.find.test('lucide-react/dist/esm/icons/bell.mjs')).toBe(
      false,
    );
    expect(alias.replacement.endsWith('lucideIcons.ts')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertCompanionLanPath,
  companionLanFailure,
  consumeSseBuffer,
  pickForwardHeaders,
} from './companionLanProxy';

describe('assertCompanionLanPath', () => {
  it('allows API paths including query strings', () => {
    expect(assertCompanionLanPath('/auth/users')).toBe('/auth/users');
    expect(assertCompanionLanPath('/events?token=abc')).toBe(
      '/events?token=abc',
    );
  });

  it('rejects open-proxy paths', () => {
    expect(() => assertCompanionLanPath('http://evil.example')).toThrow(
      'invalid path',
    );
    expect(() => assertCompanionLanPath('/../etc/passwd')).toThrow(
      'invalid path',
    );
  });
});

describe('pickForwardHeaders', () => {
  it('keeps auth headers and stamps the companion client', () => {
    expect(
      pickForwardHeaders(
        { Authorization: 'Bearer x', Host: 'evil.example' },
        'admin',
      ),
    ).toEqual({
      Authorization: 'Bearer x',
      'X-POS-Client': 'admin',
    });
  });
});

describe('companionLanFailure', () => {
  it('maps unreachable tills to 503 instead of throwing', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENETUNREACH', message: 'connect ENETUNREACH' },
    });
    const result = companionLanFailure(err);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error).toBe('till_unreachable');
  });

  it('maps aborted polls to 504', () => {
    const err = new DOMException('This operation was aborted', 'AbortError');
    const result = companionLanFailure(err);
    expect(result.status).toBe(504);
    expect(JSON.parse(result.body).error).toBe('till_timeout');
  });
});

describe('consumeSseBuffer', () => {
  it('parses POS event blocks and keeps a partial trailer', () => {
    const { rest, events } = consumeSseBuffer(
      'event: users\ndata: {"ok":true}\n\nevent: ping\ndata: {',
    );
    expect(events).toEqual([{ event: 'users', data: '{"ok":true}' }]);
    expect(rest).toBe('event: ping\ndata: {');
  });
});

import { describe, expect, it } from 'vitest';
import { ifNoneMatchHits, weakEtag } from './lanConditional';

describe('lanConditional', () => {
  it('is stable for the same body and changes when the floor moves', () => {
    const a = weakEtag('{"tables":[]}');
    const b = weakEtag('{"tables":[]}');
    const c = weakEtag('{"tables":[{"label":"T1"}]}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('W/"')).toBe(true);
  });

  it('matches a single If-None-Match token', () => {
    const tag = weakEtag('menu');
    expect(ifNoneMatchHits(tag, tag)).toBe(true);
    expect(ifNoneMatchHits(`${tag}, W/"other"`, tag)).toBe(true);
    expect(ifNoneMatchHits('W/"other"', tag)).toBe(false);
    expect(ifNoneMatchHits(undefined, tag)).toBe(false);
  });
});

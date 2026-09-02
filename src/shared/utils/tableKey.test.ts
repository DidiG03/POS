import { describe, expect, it } from 'vitest';
import { splitTableKey, tableKey } from './tableKey';

describe('splitTableKey', () => {
  it('round-trips a plain area and label', () => {
    expect(splitTableKey(tableKey('Sallon', 'T12'))).toEqual({
      area: 'Sallon',
      label: 'T12',
    });
  });

  it('keeps colons inside the table label', () => {
    expect(splitTableKey('Patio:T:12')).toEqual({
      area: 'Patio',
      label: 'T:12',
    });
  });

  it('rejects keys with no area or label', () => {
    expect(splitTableKey('')).toBeNull();
    expect(splitTableKey('Sallon')).toBeNull();
    expect(splitTableKey('Sallon:')).toBeNull();
    expect(splitTableKey(':T1')).toBeNull();
  });
});

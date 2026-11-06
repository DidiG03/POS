import { describe, expect, it } from 'vitest';
import { notifyModelWrite, onModelWrite } from './client';

describe('onModelWrite', () => {
  it('tells listeners about writes only, and survives a throwing one', () => {
    const seen: string[] = [];
    const offBad = onModelWrite(() => {
      throw new Error('listener bug');
    });
    const off = onModelWrite((model, op) => seen.push(`${model}.${op}`));
    try {
      notifyModelWrite('Notification', 'create');
      notifyModelWrite('Notification', 'findMany');
      notifyModelWrite('Notification', 'updateMany');
      notifyModelWrite('', 'create');
      expect(seen).toEqual(['Notification.create', 'Notification.updateMany']);
    } finally {
      off();
      offBad();
    }
    notifyModelWrite('Notification', 'create');
    expect(seen).toHaveLength(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const count = vi.fn();
const create = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    notification: {
      count: (...a: any[]) => count(...a),
      create: (...a: any[]) => create(...a),
    },
  },
}));

import { recordWrongPinAttempt, wrongPinMessage } from './wrongPinAlert';

describe('wrongPinMessage', () => {
  it('keeps the plain text for a first miss and numbers later ones', () => {
    expect(wrongPinMessage(1)).toBe('Wrong PIN attempt on your account');
    expect(wrongPinMessage(4)).toBe(
      'Wrong PIN attempt on your account (4 in the last 15 minutes)',
    );
  });
});

describe('recordWrongPinAttempt', () => {
  beforeEach(() => {
    count.mockReset();
    create.mockReset().mockResolvedValue({});
  });

  it('writes one notification per attempt, numbered by recent misses', async () => {
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await recordWrongPinAttempt(7);
    await recordWrongPinAttempt(7);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: 7,
      type: 'SECURITY',
      message: 'Wrong PIN attempt on your account',
    });
    expect(create.mock.calls[1][0].data.message).toContain('(2 in the last');
  });

  it('still records when the count read fails', async () => {
    count.mockRejectedValueOnce(new Error('db'));
    await recordWrongPinAttempt(3);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown user', async () => {
    await recordWrongPinAttempt(0);
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * Subscription status is read at startup (before the tablets' server can
 * start) and every 30s while someone is signed in. On a poor connection each
 * of those used to wait on the billing server; they now answer from the
 * saved check and refresh it in the background.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dir } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return {
    dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pos-license-')),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: true, isReady: () => false, getPath: () => dir },
  net: {},
}));

import {
  LICENSE_REVALIDATE_MS,
  getLicenseStatus,
  readStoredLicense,
  writeStoredLicense,
  type StoredLicense,
} from './license';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
process.env.POS_BILLING_URL = 'https://billing.test';

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function save(overrides: Partial<StoredLicense> = {}) {
  writeStoredLicense({
    key: 'OT-KEY',
    email: 'owner@example.com',
    status: 'ACTIVE',
    currentPeriodEnd: null,
    lastValidatedAt: Date.now(),
    ...overrides,
  });
}

function billingAnswers(body: Record<string, unknown>) {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  try {
    fs.unlinkSync(path.join(dir, 'license.json'));
  } catch {
    // none saved
  }
});

describe('getLicenseStatus', () => {
  it('answers from a recent check without calling the billing server', async () => {
    save();
    const st = await getLicenseStatus();
    expect(st).toMatchObject({ required: true, licensed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers an older check at once and refreshes it in the background', async () => {
    save({ lastValidatedAt: Date.now() - LICENSE_REVALIDATE_MS - 1000 });
    let release!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ valid: true, status: 'ACTIVE' }), {
                status: 200,
              }),
            );
        }),
    );

    const st = await getLicenseStatus();
    expect(st.licensed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() =>
      expect(Date.now() - readStoredLicense()!.lastValidatedAt).toBeLessThan(
        5000,
      ),
    );
  });

  it('locks as soon as the billing server has said the key is no good', async () => {
    save({ lastValidatedAt: Date.now() - LICENSE_REVALIDATE_MS - 1000 });
    billingAnswers({ valid: false, status: 'ACTIVE' });
    await getLicenseStatus();
    await vi.waitFor(() => expect(readStoredLicense()?.valid).toBe(false));

    billingAnswers({ valid: false, status: 'ACTIVE' });
    const st = await getLicenseStatus();
    expect(st.licensed).toBe(false);
  });

  it('does not trust a lapsed subscription from the saved check', async () => {
    save({ status: 'PAUSED' });
    billingAnswers({ valid: false, status: 'PAUSED' });
    const st = await getLicenseStatus();
    expect(st.licensed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('always asks when a live answer is wanted', async () => {
    save();
    billingAnswers({ valid: true, status: 'ACTIVE' });
    await getLicenseStatus({ live: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one request between callers asking at once', async () => {
    save({ status: 'PAUSED' });
    billingAnswers({ valid: true, status: 'ACTIVE' });
    const all = await Promise.all([
      getLicenseStatus(),
      getLicenseStatus(),
      getLicenseStatus({ live: true }),
    ]);
    expect(all.every((s) => s.licensed)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps working offline within the grace period', async () => {
    save({ lastValidatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const st = await getLicenseStatus({ live: true });
    expect(st.licensed).toBe(true);
  });

  it('never calls the billing server when nothing was ever activated', async () => {
    const st = await getLicenseStatus();
    expect(st.licensed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

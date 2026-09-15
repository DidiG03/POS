import { describe, expect, it } from 'vitest';
import {
  isMissingUpdateFeedError,
  userFacingUpdaterError,
} from './updateFeedError';

const MISSING_LATEST = `Cannot find latest.yml in the latest release artifacts (https://github.com/DidiG03/POS/releases/download/v0.2.31/latest.yml): HttpError: 404
"method: GET url: https://github.com/DidiG03/POS/releases/download/v0.2.31/latest.yml"`;

describe('updateFeedError', () => {
  it('treats a missing GitHub yml as no update', () => {
    expect(isMissingUpdateFeedError(MISSING_LATEST)).toBe(true);
    expect(userFacingUpdaterError(MISSING_LATEST)).toBe('No update available');
  });

  it('keeps a short unexpected updater error', () => {
    expect(
      userFacingUpdaterError(new Error('net::ERR_INTERNET_DISCONNECTED')),
    ).toBe('net::ERR_INTERNET_DISCONNECTED');
  });
});

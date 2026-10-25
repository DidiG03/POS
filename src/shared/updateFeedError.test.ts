import { describe, expect, it } from 'vitest';
import {
  isMacCodeSignatureError,
  isMissingUpdateFeedError,
  isOfflineUpdaterError,
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
    expect(userFacingUpdaterError(new Error('sha512 checksum mismatch'))).toBe(
      'sha512 checksum mismatch',
    );
  });

  it('treats a dropped connection as offline, not a crash', () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED');
    expect(isOfflineUpdaterError(err)).toBe(true);
    expect(
      isOfflineUpdaterError(new Error('getaddrinfo ENOTFOUND github.com')),
    ).toBe(true);
    expect(userFacingUpdaterError(err)).toMatch(/no internet connection/i);
    expect(isOfflineUpdaterError(new Error('sha512 checksum mismatch'))).toBe(
      false,
    );
  });

  it('recognises Squirrel.Mac refusing an unsigned app', () => {
    expect(
      isMacCodeSignatureError(
        new Error('Could not get code signature for running application'),
      ),
    ).toBe(true);
    expect(isMacCodeSignatureError(new Error('net::ERR_TIMED_OUT'))).toBe(
      false,
    );
  });
});

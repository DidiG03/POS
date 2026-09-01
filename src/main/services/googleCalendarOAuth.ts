import crypto from 'node:crypto';
import http from 'node:http';
import { shell } from 'electron';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

export type GoogleOAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  primary?: boolean;
};

export type StoredGoogleOAuth = {
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
};

export function getGoogleOAuthClientConfig() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  ).trim();
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

export function formatGoogleApiError(message: string): string {
  const raw = String(message || '').trim();
  if (
    /calendar api has not been used|calendar-json\.googleapis\.com.*disabled|accessNotConfigured/i.test(
      raw,
    )
  ) {
    const projectMatch = raw.match(/project\s+(\d+)/i);
    const project = projectMatch?.[1] || '';
    const url = project
      ? `https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=${project}`
      : 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
    return [
      'Google Calendar API is not enabled for your Google Cloud project.',
      'Open Google Cloud Console → APIs & Services → Library → search "Google Calendar API" → Enable.',
      url,
      'Wait 1–2 minutes, then click Connect again in POS (or Sync now if already connected).',
    ].join(' ');
  }
  return raw;
}

function htmlResponse(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111827; color: #f3f4f6; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { max-width: 420px; padding: 24px; border-radius: 12px; background: #1f2937; border: 1px solid #374151; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { opacity: 0.85; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}

async function startOAuthLoopbackServer(
  expectedState: string,
  timeoutMs = 5 * 60_000,
) {
  return await new Promise<{
    port: number;
    waitForCode: Promise<string>;
    close: () => void;
  }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const host = req.headers.host || '';
        const url = new URL(req.url || '/', `http://${host}`);
        if (url.pathname !== '/oauth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const err = url.searchParams.get('error');
        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            htmlResponse(
              'Connection failed',
              'Google sign-in was cancelled or denied. You can close this tab and try again in the POS app.',
            ),
          );
          finishReject(new Error(String(err)));
          return;
        }
        if (!code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            htmlResponse(
              'Connection failed',
              'The sign-in response was invalid. Close this tab and try again in the POS app.',
            ),
          );
          finishReject(new Error('Invalid OAuth callback'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          htmlResponse(
            'Google Calendar connected',
            'Your account is linked. You can close this browser tab and return to OneTap POS.',
          ),
        );
        finishResolve(code);
      } catch (e) {
        finishReject(e);
      }
    });

    let settled = false;
    let finishResolve!: (code: string) => void;
    let finishReject!: (err: unknown) => void;
    const waitForCode = new Promise<string>((res, rej) => {
      finishResolve = (code) => {
        if (settled) return;
        settled = true;
        res(code);
      };
      finishReject = (err) => {
        if (settled) return;
        settled = true;
        rej(err);
      };
    });

    const timer = setTimeout(() => {
      finishReject(new Error('Google sign-in timed out'));
    }, timeoutMs);

    waitForCode.finally(() => clearTimeout(timer));

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (!port) {
        server.close();
        reject(new Error('Could not start OAuth callback server'));
        return;
      }
      resolve({
        port,
        waitForCode,
        close: () => server.close(),
      });
    });
  });
}

async function exchangeAuthorizationCode(args: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      String(
        (data as any)?.error_description ||
          (data as any)?.error ||
          'Token exchange failed',
      ),
    );
  }
  const accessToken = String((data as any)?.access_token || '').trim();
  if (!accessToken) throw new Error('Google did not return an access token');
  const expiresIn = Number((data as any)?.expires_in || 3600);
  return {
    accessToken,
    refreshToken: String((data as any)?.refresh_token || '').trim() || null,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 - 30_000,
  };
}

export async function refreshGoogleAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      String(
        (data as any)?.error_description ||
          (data as any)?.error ||
          'Token refresh failed',
      ),
    );
  }
  const accessToken = String((data as any)?.access_token || '').trim();
  if (!accessToken) throw new Error('Google did not return an access token');
  const expiresIn = Number((data as any)?.expires_in || 3600);
  return {
    accessToken,
    refreshToken: args.refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 - 30_000,
  };
}

export async function getValidGoogleAccessToken(args: {
  oauth?: StoredGoogleOAuth | null;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; oauth: StoredGoogleOAuth }> {
  const refreshToken = String(args.oauth?.refreshToken || '').trim();
  if (!refreshToken) throw new Error('Google Calendar is not connected');

  const cached = String(args.oauth?.accessToken || '').trim();
  const expiresAt = Date.parse(String(args.oauth?.accessTokenExpiresAt || ''));
  if (cached && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    return {
      accessToken: cached,
      oauth: {
        refreshToken,
        accessToken: cached,
        accessTokenExpiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  const refreshed = await refreshGoogleAccessToken({
    refreshToken,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  return {
    accessToken: refreshed.accessToken,
    oauth: {
      refreshToken: refreshed.refreshToken || refreshToken,
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: new Date(refreshed.expiresAt).toISOString(),
    },
  };
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error('Could not read Google account profile');
  }
  return String((data as any)?.email || '').trim();
}

export async function listGoogleCalendars(
  accessToken: string,
): Promise<GoogleCalendarListItem[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      formatGoogleApiError(
        String(
          (data as any)?.error?.message || 'Could not list Google calendars',
        ),
      ),
    );
  }
  const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
  return items
    .map((item: any) => ({
      id: String(item?.id || '').trim(),
      summary: String(item?.summary || item?.id || '').trim(),
      primary: Boolean(item?.primary),
    }))
    .filter((item: GoogleCalendarListItem) => item.id && item.summary);
}

export async function connectGoogleCalendarAccount(): Promise<{
  accountEmail: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  calendars: GoogleCalendarListItem[];
  calendarId: string;
  calendarSummary: string;
  warning?: string;
}> {
  const { clientId, clientSecret, configured } = getGoogleOAuthClientConfig();
  if (!configured) {
    throw new Error(
      'Google OAuth is not configured for this POS build. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
    );
  }

  const state = crypto.randomBytes(16).toString('hex');
  const loopback = await startOAuthLoopbackServer(state);
  const redirectUri = `http://127.0.0.1:${loopback.port}/oauth/callback`;
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', `${CALENDAR_SCOPE} ${PROFILE_SCOPE}`);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  await shell.openExternal(authUrl.toString());

  try {
    const code = await loopback.waitForCode;
    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUri,
      clientId,
      clientSecret,
    });
    if (!tokens.refreshToken) {
      throw new Error(
        'Google did not return a refresh token. Revoke POS access in your Google account settings and connect again.',
      );
    }
    const accountEmail = await fetchGoogleEmail(tokens.accessToken);
    let calendars: GoogleCalendarListItem[] = [];
    let warning: string | undefined;
    try {
      calendars = await listGoogleCalendars(tokens.accessToken);
    } catch (e: any) {
      warning = formatGoogleApiError(String(e?.message || e));
    }
    const primary = calendars.find((c) => c.primary) ||
      calendars[0] || { id: 'primary', summary: 'Primary' };
    return {
      accountEmail,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
      calendars,
      calendarId: primary.id,
      calendarSummary: primary.summary,
      warning,
    };
  } finally {
    loopback.close();
  }
}

export type GoogleApiCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

export function mapGoogleApiEvent(item: GoogleApiCalendarEvent) {
  const uid = String(item?.id || '').trim();
  const summary = String(item?.summary || '').trim();
  if (!uid || !summary) return null;
  const startRaw = item?.start?.dateTime || item?.start?.date;
  if (!startRaw) return null;
  const startsAt = new Date(startRaw);
  if (!Number.isFinite(startsAt.getTime())) return null;
  const endRaw = item?.end?.dateTime || item?.end?.date;
  const endsAt = endRaw ? new Date(endRaw) : null;
  return {
    uid,
    summary,
    description: String(item?.description || ''),
    startsAt,
    endsAt: endsAt && Number.isFinite(endsAt.getTime()) ? endsAt : null,
    cancelled: String(item?.status || '').toLowerCase() === 'cancelled',
  };
}

export async function fetchGoogleCalendarApiEvents(args: {
  oauth?: StoredGoogleOAuth | null;
  calendarId?: string;
  clientId: string;
  clientSecret: string;
}): Promise<{
  events: NonNullable<ReturnType<typeof mapGoogleApiEvent>>[];
  oauth: StoredGoogleOAuth;
}> {
  const { accessToken, oauth } = await getValidGoogleAccessToken(args);
  const calendarId = encodeURIComponent(String(args.calendarId || 'primary'));
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(
    Date.now() + 120 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
  );
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '500');
  url.searchParams.set('showDeleted', 'true');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      formatGoogleApiError(
        String(
          (data as any)?.error?.message ||
            'Could not fetch Google Calendar events',
        ),
      ),
    );
  }
  const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
  const events = items
    .map((item: GoogleApiCalendarEvent) => mapGoogleApiEvent(item))
    .filter(Boolean) as NonNullable<ReturnType<typeof mapGoogleApiEvent>>[];
  return { events, oauth };
}

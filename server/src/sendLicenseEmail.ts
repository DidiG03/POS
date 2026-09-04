import { env } from './env.js';

export async function sendLicenseKeyEmail(input: {
  to: string;
  licenseKey: string;
}): Promise<void> {
  const apiKey = env.resendApiKey;
  const from = env.licenseEmailFrom;
  if (!apiKey || !from) {
    throw new Error(
      'License email is not configured (RESEND_API_KEY, LICENSE_EMAIL_FROM)',
    );
  }
  const to = String(input.to || '').trim();
  const key = String(input.licenseKey || '').trim();
  if (!to.includes('@') || !key) {
    throw new Error('Cannot send license email');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Your OneTap POS license key',
      text: [
        'Use this key in OneTap POS under Already a customer → paste license key.',
        '',
        key,
        '',
        'If you did not ask for this, you can ignore the email.',
      ].join('\n'),
      html: `<p>Use this key in OneTap POS under <strong>Already a customer</strong>, then paste it and activate.</p>
<p style="font-family:ui-monospace,monospace;font-size:14px;word-break:break-all">${escapeHtml(key)}</p>
<p>If you did not ask for this, you can ignore the email.</p>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Could not send license email (${res.status}${body ? `: ${body.slice(0, 180)}` : ''})`,
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

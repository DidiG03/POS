import { env } from './env.js';

export async function sendLicenseKeyEmail(input: {
  to: string;
  licenseKey: string;
}): Promise<void> {
  const to = String(input.to || '').trim();
  const key = String(input.licenseKey || '').trim();
  if (!to.includes('@') || !key) {
    throw new Error('Cannot send license email');
  }

  await sendEmail({
    to,
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
  });
}

/**
 * The Stripe billing-portal link for a subscription whose payment failed.
 * Sent to the address Stripe holds for the customer.
 */
export async function sendBillingPortalEmail(input: {
  to: string;
  url: string;
}): Promise<void> {
  const to = String(input.to || '').trim();
  const url = String(input.url || '').trim();
  if (!to.includes('@') || !url.startsWith('https://')) {
    throw new Error('Cannot send billing email');
  }
  await sendEmail({
    to,
    subject: 'Update the payment method for OneTap POS',
    text: [
      'The last payment for your OneTap POS subscription did not go through.',
      'Open this link to update your card. You will not be charged twice.',
      '',
      url,
      '',
      'The link stops working after a short while. If it has expired, press Subscribe in OneTap POS again and we will send a new one.',
      'If you did not ask for this, you can ignore the email.',
    ].join('\n'),
    html: `<p>The last payment for your OneTap POS subscription did not go through.</p>
<p><a href="${escapeHtml(url)}">Update your payment method</a>. You will not be charged twice.</p>
<p>The link stops working after a short while. If it has expired, press Subscribe in OneTap POS again and we will send a new one.</p>
<p>If you did not ask for this, you can ignore the email.</p>`,
  });
}

async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const apiKey = env.resendApiKey;
  const from = env.licenseEmailFrom;
  if (!apiKey || !from) {
    throw new Error(
      'Email is not configured (RESEND_API_KEY, LICENSE_EMAIL_FROM)',
    );
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Could not send email (${res.status}${body ? `: ${body.slice(0, 180)}` : ''})`,
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

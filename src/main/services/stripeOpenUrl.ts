/**
 * Hosted Stripe Checkout / Customer Portal URLs the till is allowed to open.
 * Billing responses that are not https://*.stripe.com must not reach the browser.
 */

export function isAllowedStripeHostedUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'stripe.com' || host.endsWith('.stripe.com');
  } catch {
    return false;
  }
}

export function publicStripeHostedUrl(
  raw: string | null | undefined,
): string | undefined {
  const url = String(raw || '').trim();
  return isAllowedStripeHostedUrl(url) ? url : undefined;
}

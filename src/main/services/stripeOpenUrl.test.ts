import { describe, expect, it } from 'vitest';
import {
  isAllowedStripeHostedUrl,
  publicStripeHostedUrl,
} from './stripeOpenUrl';

describe('isAllowedStripeHostedUrl', () => {
  it('allows Checkout and Customer Portal hosts', () => {
    expect(
      isAllowedStripeHostedUrl('https://checkout.stripe.com/c/pay/cs_test_x'),
    ).toBe(true);
    expect(
      isAllowedStripeHostedUrl('https://billing.stripe.com/p/session/test'),
    ).toBe(true);
  });

  it('rejects non-https, non-stripe, and lookalike hosts', () => {
    expect(isAllowedStripeHostedUrl('http://checkout.stripe.com/c/pay/x')).toBe(
      false,
    );
    expect(isAllowedStripeHostedUrl('https://evil.com/?next=stripe.com')).toBe(
      false,
    );
    expect(isAllowedStripeHostedUrl('https://stripe.com.evil.com/pay')).toBe(
      false,
    );
    expect(isAllowedStripeHostedUrl('https://evilstripe.com/pay')).toBe(false);
    expect(isAllowedStripeHostedUrl('not a url')).toBe(false);
  });
});

describe('publicStripeHostedUrl', () => {
  it('returns the url only when it is a Stripe https host', () => {
    expect(publicStripeHostedUrl('https://checkout.stripe.com/c/pay/x')).toBe(
      'https://checkout.stripe.com/c/pay/x',
    );
    expect(publicStripeHostedUrl('https://evil.example/pay')).toBeUndefined();
    expect(publicStripeHostedUrl('')).toBeUndefined();
  });
});

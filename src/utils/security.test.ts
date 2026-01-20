import { describe, it, expect } from 'vitest';

/**
 * Unit tests for security utilities
 */

function validatePin(pin: string | null | undefined, rejectWeak = true): { valid: boolean; error?: string } {
  if (!pin) return { valid: false, error: 'PIN is required' };
  const pinStr = String(pin).trim();

  // Current requirement: 4-6 digits
  if (!/^\d{4,6}$/.test(pinStr)) {
    return { valid: false, error: 'PIN must be 4-6 digits' };
  }

  // Only reject weak PINs when creating/updating (not during login)
  if (rejectWeak) {
    const weakPins = ['0000', '1111', '1234', '12345', '123456', '9999', '99999', '999999'];
    if (weakPins.includes(pinStr)) {
      return { valid: false, error: 'PIN is too common. Please choose a different PIN.' };
    }
  }

  return { valid: true };
}

function sanitizeString(input: string | null | undefined, maxLength = 500): string {
  if (!input) return '';
  let sanitized = String(input)
    .trim()
    .slice(0, maxLength)
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove script tags and event handlers
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    // Remove control characters
    .replace(/[\x00-\x1F\x7F]/g, '');

  return sanitized;
}

describe('Security Utilities', () => {
  describe('validatePin', () => {
    it('should accept valid 4-digit PIN', () => {
      const result = validatePin('1234', false);
      expect(result.valid).toBe(true);
    });

    it('should accept valid 6-digit PIN', () => {
      const result = validatePin('123456', false);
      expect(result.valid).toBe(true);
    });

    it('should reject PINs shorter than 4 digits', () => {
      const result = validatePin('123', false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('4-6 digits');
    });

    it('should reject PINs longer than 6 digits', () => {
      const result = validatePin('1234567', false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('4-6 digits');
    });

    it('should reject non-numeric PINs', () => {
      const result = validatePin('abcd', false);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('4-6 digits');
    });

    it('should reject weak PINs when rejectWeak is true', () => {
      const weakPins = ['0000', '1111', '1234', '12345', '123456', '9999', '99999', '999999'];
      weakPins.forEach((pin) => {
        const result = validatePin(pin, true);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too common');
      });
    });

    it('should accept weak PINs when rejectWeak is false (for login)', () => {
      const weakPins = ['0000', '1111', '1234'];
      weakPins.forEach((pin) => {
        const result = validatePin(pin, false);
        expect(result.valid).toBe(true);
      });
    });

    it('should reject null/undefined PIN', () => {
      expect(validatePin(null).valid).toBe(false);
      expect(validatePin(undefined).valid).toBe(false);
      expect(validatePin('').valid).toBe(false);
    });
  });

  describe('sanitizeString', () => {
    it('should remove HTML tags', () => {
      const result = sanitizeString('<script>alert("XSS")</script>Hello');
      // The sanitize function removes tags but keeps text content
      // So we check that tags are removed, not the exact output
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
      expect(result).toContain('Hello');
    });

    it('should remove JavaScript protocol', () => {
      const result = sanitizeString('javascript:alert("XSS")');
      expect(result).not.toContain('javascript:');
    });

    it('should remove event handlers', () => {
      const result = sanitizeString('onclick="alert(\'XSS\')"Hello');
      expect(result).not.toContain('onclick=');
    });

    it('should remove control characters', () => {
      // eslint-disable-next-line no-control-regex
      const result = sanitizeString('Hello\x00World\x1F');
      expect(result).toBe('HelloWorld');
    });

    it('should trim whitespace', () => {
      const result = sanitizeString('  Hello World  ');
      expect(result).toBe('Hello World');
    });

    it('should enforce max length', () => {
      const longString = 'a'.repeat(600);
      const result = sanitizeString(longString, 100);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('should handle null/undefined', () => {
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString(undefined)).toBe('');
    });

    it('should preserve valid text', () => {
      const validText = 'Hello World 123';
      const result = sanitizeString(validText);
      expect(result).toBe(validText);
    });
  });
});

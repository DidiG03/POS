# Testing Guide

**Last Updated**: 2025-01-09

## ✅ Test Coverage

### Unit Tests (Vitest)
- ✅ **Business Logic** (`src/utils/calculations.test.ts`)
  - Totals calculation (subtotal, VAT, total)
  - VAT enabled/disabled
  - Discount calculations (percentage and fixed)
  - Service charge calculations
  - Combined calculations (VAT + discount + service charge)

- ✅ **Formatting Utilities** (`src/utils/format.test.ts`)
  - Amount formatting
  - Currency formatting
  - Edge cases (NaN, Infinity, zero, negative)

- ✅ **Security Utilities** (`src/utils/security.test.ts`)
  - PIN validation (format, weak PIN rejection)
  - String sanitization (XSS prevention)
  - Input validation

**Total**: 42 unit tests passing ✅

### E2E Tests (Playwright)
- ⚠️ **Basic Smoke Test** (`tests/smoke.spec.ts`)
  - App startup verification
  - Basic process check

- ⚠️ **Critical Flows** (`tests/critical-flows.spec.ts`)
  - Placeholder tests (need Electron-specific testing setup)

---

## 🧪 Running Tests

### Run All Unit Tests
```bash
npm run test
```

**Expected Output**:
```
✓ src/utils/calculations.test.ts (16 tests)
✓ src/utils/security.test.ts (16 tests)
✓ src/utils/format.test.ts (10 tests)

Test Files  3 passed (3)
Tests  42 passed (42)
```

### Run Playwright E2E Tests
```bash
npm run test:ui
```

**Note**: Playwright tests require the app to be running or use Electron-specific testing setup.

---

## 📊 Test Results

### Current Status
- ✅ **Unit Tests**: 42/42 passing (100%)
- ⚠️ **E2E Tests**: 1 smoke test (needs Electron setup)
- ⚠️ **Integration Tests**: Not yet implemented

### Test Coverage by Category

| Category | Tests | Status |
|----------|-------|--------|
| Business Logic | 16 | ✅ Passing |
| Formatting | 10 | ✅ Passing |
| Security | 16 | ✅ Passing |
| **Total** | **42** | **✅ 100% Passing** |

---

## 🎯 Test Cases Covered

### Business Logic Tests

#### Totals Calculation
- ✅ Basic subtotal calculation
- ✅ VAT calculation (enabled)
- ✅ VAT disabled
- ✅ Empty lines array
- ✅ Zero prices
- ✅ Different VAT rates
- ✅ Decimal quantities

#### Discount Calculations
- ✅ Percentage discount
- ✅ Fixed amount discount
- ✅ Negative total prevention
- ✅ 100% discount

#### Service Charge Calculations
- ✅ Percentage service charge
- ✅ Fixed amount service charge
- ✅ Zero total handling

#### Combined Calculations
- ✅ VAT + service charge
- ✅ VAT + discount + service charge

### Formatting Tests

#### Amount Formatting
- ✅ Integer formatting
- ✅ Decimal formatting (2 places)
- ✅ Zero handling
- ✅ Negative numbers
- ✅ NaN/Infinity handling

#### Currency Formatting
- ✅ ISO currency codes
- ✅ Currency symbols
- ✅ Rounding to nearest integer
- ✅ Zero handling
- ✅ Invalid currency handling

### Security Tests

#### PIN Validation
- ✅ Valid 4-6 digit PINs
- ✅ Invalid lengths
- ✅ Non-numeric rejection
- ✅ Weak PIN rejection (on create/update)
- ✅ Weak PIN acceptance (on login)
- ✅ Null/undefined handling

#### String Sanitization
- ✅ HTML tag removal
- ✅ JavaScript protocol removal
- ✅ Event handler removal
- ✅ Control character removal
- ✅ Whitespace trimming
- ✅ Max length enforcement
- ✅ Null/undefined handling

---

## 🚀 Adding New Tests

### Unit Test Example

```typescript
// src/utils/your-function.test.ts
import { describe, it, expect } from 'vitest';

describe('Your Function', () => {
  it('should handle basic case', () => {
    const result = yourFunction(input);
    expect(result).toBe(expected);
  });

  it('should handle edge case', () => {
    const result = yourFunction(edgeInput);
    expect(result).toBe(expected);
  });
});
```

### E2E Test Example

```typescript
// tests/your-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Your Flow', () => {
  test('should complete user flow', async ({ page }) => {
    // Navigate to page
    await page.goto('/your-page');
    
    // Interact with elements
    await page.click('button');
    
    // Assert result
    await expect(page.locator('.result')).toContainText('Expected');
  });
});
```

---

## 📈 Coverage Goals

### Current Coverage
- **Unit Tests**: Core business logic ✅
- **E2E Tests**: Basic smoke test ⚠️
- **Integration Tests**: None yet ⚠️

### Target Coverage (Production Ready)
- **Unit Tests**: 80%+ of business logic
- **E2E Tests**: Critical user flows (login → order → payment)
- **Integration Tests**: IPC handlers, database operations

---

## 🐛 Known Issues

### Playwright/Vitest Conflict
- **Issue**: Conflicting expect matchers when running Playwright tests
- **Workaround**: Run Playwright tests separately from Vitest
- **Fix**: Use separate test configurations

### Electron E2E Testing
- **Issue**: Electron-specific tests need special setup
- **Solution**: Use Spectron or playwright-electron
- **Status**: Placeholder tests created, need Electron setup

---

## 🔧 Test Configuration

### Vitest Configuration
Tests are configured via `package.json`:
```json
{
  "scripts": {
    "test": "vitest run --passWithNoTests --exclude \"tests/**\""
  }
}
```

### Playwright Configuration
Located in `tests/playwright.config.ts`:
```typescript
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    viewport: { width: 1280, height: 800 },
  },
});
```

---

## 📝 Next Steps

1. **Expand E2E Tests** (2-3 days)
   - Add Electron-specific test setup
   - Test critical flows (login → order → payment)
   - Test admin flows (user management, menu editing)

2. **Add Integration Tests** (2-3 days)
   - IPC handler tests
   - Database operation tests
   - Cloud sync tests

3. **Increase Coverage** (1-2 days)
   - Add tests for edge cases
   - Add tests for error handling
   - Add tests for offline mode

---

*For questions or contributions, see `PRODUCTION_ROADMAP.md`*

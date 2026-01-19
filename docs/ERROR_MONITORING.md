# Error Monitoring with Sentry

This POS system uses [Sentry](https://sentry.io/) for error tracking and monitoring.

## Setup

### 1. Create a Sentry Account & Project

1. Sign up at https://sentry.io/ (free tier available)
2. Create a new project
3. Select "Electron" as the platform
4. Copy your **DSN** (Data Source Name)

### 2. Configure Sentry DSN

Add your Sentry DSN to your environment:

**Option A: Environment variable (recommended)**
```bash
export SENTRY_DSN="https://xxx@xxx.ingest.sentry.io/xxx"
```

**Option B: `.env` file (for local development)**
```bash
# .env
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
```

**Option C: Production deployment**
Set `SENTRY_DSN` as an environment variable in your deployment platform (Google Cloud, etc.)

### 3. Development vs Production

- **Development**: Sentry is **disabled by default** (even if DSN is set) unless `SENTRY_DEBUG=true` is set. Errors are still logged to console.
- **Production**: Sentry is **enabled automatically** when `SENTRY_DSN` is set.

### 4. Install Dependencies

```bash
pnpm install
# or
npm install
```

The `@sentry/electron` package is already added to `package.json`.

## What Gets Tracked

### Automatic Tracking

✅ **Uncaught exceptions** in main process  
✅ **Unhandled promise rejections** in main process  
✅ **React render errors** (via ErrorBoundary)  
✅ **IPC handler errors** (wrapped automatically)  
✅ **User context** (set after login: userId, role, displayName)

### Manual Tracking

You can manually capture errors or messages:

```typescript
import { captureException, captureMessage, addBreadcrumb } from './services/sentry';

// Capture an exception
try {
  riskyOperation();
} catch (error) {
  captureException(error, { context: 'payment-processing' });
}

// Capture a message
captureMessage('Payment failed validation', 'warning');

// Add breadcrumb (for debugging user actions)
addBreadcrumb('User clicked checkout', 'user-action');
```

## Viewing Errors

1. Go to https://sentry.io/
2. Navigate to your project
3. View **Issues** for all errors
4. Each error includes:
   - Stack trace
   - User information (if logged in)
   - Breadcrumbs (user actions before error)
   - Environment (development/production)
   - App version

## Configuration

### Sentry Settings (in `src/main/services/sentry.ts`)

- **Sample Rate**: 10% of events in production, 100% in development
- **Breadcrumbs**: Limited to 50-100 based on environment
- **Ignored Errors**: Common browser/network errors are filtered out

### Customize Error Filtering

Edit `ignoreErrors` in `src/main/services/sentry.ts` to filter out noise:

```typescript
ignoreErrors: [
  'NetworkError',
  'User cancelled',
  // Add more patterns here
],
```

## Privacy & Security

- **User Data**: Only userId, role, and displayName are sent (set after login)
- **No Sensitive Data**: PINs, passwords, tokens are never sent
- **Local First**: In development, errors are logged locally only
- **GDPR Compliance**: Sentry supports data scrubbing for compliance

## Disabling Sentry

To disable Sentry completely:

1. **Remove DSN**: Unset or delete `SENTRY_DSN` environment variable
2. **No code changes needed**: Sentry will automatically detect missing DSN and disable itself

## Troubleshooting

### Sentry Not Working?

1. Check that `SENTRY_DSN` is set correctly
2. Check console for `[Sentry] Initialized successfully` message
3. In development, set `SENTRY_DEBUG=true` to see what's being sent
4. Check Sentry project settings (correct platform selected?)

### Too Many Errors?

- Use `ignoreErrors` to filter known issues
- Adjust `tracesSampleRate` to reduce volume
- Set up [Alert Rules](https://docs.sentry.io/product/alerts/) to only notify on new/critical errors

### Missing Stack Traces?

- Ensure source maps are uploaded to Sentry (if using minified builds)
- Check that `NODE_ENV=production` in production builds

## Next Steps

- Set up **Alert Rules** in Sentry to get notified of critical errors
- Configure **Release Tracking** to associate errors with app versions
- Use **Performance Monitoring** (Sentry Performance) for slow operations
- Set up **User Feedback** widget for better error context

---

*For more details, see [Sentry Electron Documentation](https://docs.sentry.io/platforms/javascript/guides/electron/)*

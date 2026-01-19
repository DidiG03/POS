# Sentry Error Monitoring - Quick Setup Guide

## ✅ Implementation Complete!

Error monitoring with Sentry has been fully integrated into your POS system. Here's what was implemented:

### What's Been Added

1. ✅ **Sentry package** added to `package.json`
2. ✅ **Sentry initialization** in main process (`src/main/services/sentry.ts`)
3. ✅ **Unhandled error handlers** for main process
4. ✅ **React Error Boundary** component (`src/renderer/components/ErrorBoundary.tsx`)
5. ✅ **User context tracking** (set after login)
6. ✅ **Error tracking** in critical IPC handlers
7. ✅ **Documentation** (`docs/ERROR_MONITORING.md`)

---

## 🚀 Next Steps (Required)

### 1. Install Dependencies

You need to install the Sentry package:

```bash
# Using pnpm (recommended)
pnpm install

# OR using npm
npm install
```

### 2. Get Your Sentry DSN

1. Go to https://sentry.io/ and sign up (free tier available)
2. Create a new project → Select **"Electron"** as platform
3. Copy your **DSN** (it looks like: `https://xxx@xxx.ingest.sentry.io/xxx`)

### 3. Configure Sentry

**Option A: Environment Variable (Recommended for Production)**
```bash
export SENTRY_DSN="https://xxx@xxx.ingest.sentry.io/xxx"
```

**Option B: `.env` File (For Local Development)**
Create or edit `.env` in the project root:
```bash
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
```

**Option C: Test Without Sentry First**
If you don't set `SENTRY_DSN`, Sentry will automatically disable itself. The app will work normally, just without error tracking.

---

## 🧪 Testing

### Test That It Works

1. **Install dependencies**: `pnpm install`
2. **Set SENTRY_DSN**: Add to `.env` or environment
3. **Run the app**: `npm run dev`
4. **Check console**: You should see `[Sentry] Initialized successfully`
5. **Trigger an error**: Open a non-existent route or cause an error
6. **Check Sentry dashboard**: Errors should appear within seconds

### Development Mode Behavior

- **By default**: Errors are logged to console but NOT sent to Sentry (to save quota)
- **To enable sending in dev**: Set `SENTRY_DEBUG=true` in your environment
- **In production**: Errors are automatically sent when `SENTRY_DSN` is set

---

## 📊 What Gets Tracked

### Automatic
- ✅ Uncaught exceptions in main process
- ✅ Unhandled promise rejections
- ✅ React render errors (ErrorBoundary)
- ✅ IPC handler errors
- ✅ User information (userId, role, displayName)

### Manual (Optional)
You can manually track errors:
```typescript
import { captureException, captureMessage } from './services/sentry';

captureException(error, { context: 'payment' });
captureMessage('Something happened', 'warning');
```

---

## 🔍 Viewing Errors

1. Go to https://sentry.io/
2. Open your project
3. Click **"Issues"** to see all errors
4. Click any error to see:
   - Stack trace
   - User who encountered it
   - Breadcrumbs (actions before error)
   - Environment (dev/prod)

---

## ⚙️ Configuration

Edit `src/main/services/sentry.ts` to customize:

- **Sample Rate**: How many events to send (default: 10% in prod, 100% in dev)
- **Ignored Errors**: Filter out known issues
- **Breadcrumbs**: Track user actions before errors

---

## 🛡️ Privacy & Security

- ✅ No sensitive data sent (PINs, passwords, tokens are excluded)
- ✅ Only user ID, role, and display name are tracked
- ✅ GDPR compliant (Sentry supports data scrubbing)
- ✅ Can be disabled by simply not setting `SENTRY_DSN`

---

## ❓ Troubleshooting

**"Build failed: Cannot find @sentry/electron"**
→ Run `pnpm install` or `npm install`

**"Sentry not initialized"**
→ Check that `SENTRY_DSN` is set correctly

**"Errors not appearing in Sentry"**
→ In development, set `SENTRY_DEBUG=true` to enable sending
→ Check Sentry project settings (correct platform selected?)

**"Too many errors"**
→ Adjust `tracesSampleRate` in `sentry.ts` to reduce volume
→ Add patterns to `ignoreErrors` to filter noise

---

## 📚 More Information

- Full documentation: `docs/ERROR_MONITORING.md`
- Sentry docs: https://docs.sentry.io/platforms/javascript/guides/electron/

---

**Ready to go!** Once you install dependencies and set `SENTRY_DSN`, error monitoring will be active.

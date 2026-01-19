# Auto-Update Setup Guide

This POS system uses `electron-updater` to automatically check for and install updates.

## ✅ Implementation Complete

The auto-update system is fully integrated:
- ✅ Automatic update checking on app start (5 second delay)
- ✅ Periodic checks every 4 hours
- ✅ Manual "Check for Updates" option
- ✅ Update notifications in the UI
- ✅ Download progress indicator
- ✅ Install & restart functionality
- ✅ Support for GitHub Releases and custom update servers

---

## 🚀 Configuration

### Option 1: GitHub Releases (Recommended)

If your code is on GitHub, this is the easiest option:

1. **Set environment variables:**
   ```bash
   export GITHUB_OWNER="yourusername"
   export GITHUB_REPO="POS"
   ```

   Or add to `.env`:
   ```bash
   GITHUB_OWNER=yourusername
   GITHUB_REPO=POS
   ```

2. **Configure electron-builder** (in `package.json`):
   ```json
   {
     "build": {
       "publish": {
         "provider": "github",
         "owner": "yourusername",
         "repo": "POS"
       }
     }
   }
   ```

3. **Publish releases:**
   - Create a GitHub release with a tag (e.g., `v1.0.0`)
   - Upload the built app files (`.dmg`, `.exe`, etc.) to the release
   - The app will automatically detect and download updates

### Option 2: Custom Update Server

If you have your own update server:

1. **Set environment variable:**
   ```bash
   export UPDATE_SERVER_URL="https://updates.example.com/updates"
   ```

2. **Your server must provide:**
   - `latest.yml` (or `latest-mac.yml`, `latest-win.yml`) with update metadata
   - Signed update files (`.dmg`, `.exe`, etc.)

### Option 3: Disable Auto-Updates

To disable auto-updates:
```bash
export AUTO_UPDATE_ENABLED=false
```

---

## 📦 Building & Publishing

### Build for Distribution

```bash
npm run build
```

This creates distributable files in `dist/`:
- macOS: `.dmg` file
- Windows: `.exe` installer

### Publish to GitHub Releases

1. **Install electron-builder:**
   ```bash
   npm install -g electron-builder
   ```

2. **Set GitHub token:**
   ```bash
   export GH_TOKEN=your_github_token
   ```

3. **Build and publish:**
   ```bash
   electron-builder --publish always
   ```

   This will:
   - Build the app for all platforms
   - Create a GitHub release
   - Upload the files
   - Generate `latest.yml` files for auto-updates

### Manual Publishing

1. Build the app: `npm run build`
2. Create a GitHub release with tag (e.g., `v1.0.1`)
3. Upload the built files from `dist/`:
   - `POS-1.0.1.dmg` (macOS)
   - `POS Setup 1.0.1.exe` (Windows)
4. The app will automatically detect the new version

---

## 🔧 Version Management

The app version is defined in `package.json`:
```json
{
  "version": "1.0.0"
}
```

**Important:** When releasing a new version:
1. Update `version` in `package.json`
2. Build the app
3. Create a GitHub release with the same version tag (e.g., `v1.0.0`)

---

## 🧪 Testing Updates

### Test in Development

Auto-updates are **disabled in development mode** (`npm run dev`).

To test:
1. Build the app: `npm run build`
2. Run the built app (not `npm run dev`)
3. Create a test release with a higher version
4. The app should detect and offer the update

### Test Update Flow

1. **Check for updates manually:**
   - The app checks automatically on startup
   - Or trigger manually via the UI (if you add a button)

2. **Download update:**
   - When an update is available, a notification appears
   - Click "Download" to download the update

3. **Install update:**
   - After download completes, click "Install & Restart"
   - The app will restart and install the update

---

## 📱 User Experience

### Update Notifications

Users will see:
- **Update Available**: Blue notification with version info and "Download" button
- **Downloading**: Progress bar showing download percentage
- **Ready to Install**: Green notification with "Install & Restart" button

### Update Behavior

- **Automatic checks**: Every 4 hours (configurable in `updater.ts`)
- **Auto-download**: Disabled by default (user must click "Download")
- **Auto-install on quit**: Enabled (if update is downloaded, installs on next quit)
- **Downgrade protection**: Enabled (won't install older versions)

---

## ⚙️ Configuration Options

Edit `src/main/updater.ts` to customize:

- **Check interval**: Change `4 * 60 * 60 * 1000` (4 hours) to your preference
- **Auto-download**: Set `autoUpdater.autoDownload = true` to download automatically
- **Allow pre-releases**: Set `allowPrerelease = true` to include beta versions
- **Check on startup delay**: Change `5000` (5 seconds) to adjust delay

---

## 🔒 Security

- Updates are verified using code signing
- Only signed updates from your configured server are accepted
- GitHub Releases are automatically verified

**Important:** For production, ensure your app is code-signed:
- macOS: Apple Developer certificate
- Windows: Code signing certificate

---

## ❓ Troubleshooting

**"No update server configured"**
→ Set `GITHUB_OWNER` and `GITHUB_REPO` or `UPDATE_SERVER_URL`

**"Updates disabled in development mode"**
→ This is expected. Build the app to test updates.

**"Update not detected"**
→ Check that:
- Version in `package.json` is lower than the release version
- GitHub release exists with the correct tag format (`v1.0.0`)
- `latest.yml` file exists in the release assets

**"Download fails"**
→ Check network connectivity and GitHub release accessibility

**"Install fails"**
→ Ensure the app has write permissions and isn't running as read-only

---

## 📚 More Information

- [electron-updater Documentation](https://www.electron.build/auto-update)
- [electron-builder Publishing](https://www.electron.build/configuration/publish)

---

**Ready to go!** Once you configure `GITHUB_OWNER` and `GITHUB_REPO`, the app will automatically check for updates.

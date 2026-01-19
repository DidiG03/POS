# CI/CD Pipeline Setup Guide

**Last Updated**: 2025-01-09

## ✅ CI/CD Pipeline Implemented

Your POS system now has automated CI/CD pipelines set up using GitHub Actions!

---

## 📋 What's Configured

### 1. **Continuous Integration (CI)**

**File**: `.github/workflows/ci.yml`

**Triggers**: 
- Every push to `main`, `master`, or `develop`
- Every pull request

**What it does**:
1. ✅ Checks out code
2. ✅ Sets up Node.js 18 and pnpm
3. ✅ Installs dependencies
4. ✅ Generates Prisma Client
5. ✅ Runs linter (`pnpm lint`)
6. ✅ Runs unit tests (`pnpm test` - 42 tests)
7. ✅ Builds the application (`pnpm build`)
8. ✅ Uploads build artifacts

**Duration**: ~2-5 minutes

---

### 2. **Continuous Delivery (CD) / Releases**

**File**: `.github/workflows/release.yml`

**Triggers**: 
- When you push a version tag (e.g., `v1.0.0`, `v1.2.3`)

**What it does**:
1. ✅ Builds for all platforms (Windows, macOS, Linux)
2. ✅ Runs tests on each platform
3. ✅ Creates a GitHub Release
4. ✅ Uploads build artifacts to the release

**Duration**: ~15-30 minutes (building for 3 platforms)

---

## 🚀 How to Use

### Running CI Checks

**Automatic**: Just push your code!
```bash
git add .
git commit -m "Your changes"
git push
```

CI will automatically:
- Run tests
- Check linting
- Build the app
- Report results in the Actions tab

---

### Creating a Release

**Step 1**: Update version in `package.json`
```json
{
  "version": "1.0.1"
}
```

**Step 2**: Commit and push
```bash
git add package.json
git commit -m "Bump version to 1.0.1"
git push
```

**Step 3**: Create and push a tag
```bash
git tag v1.0.1
git push origin v1.0.1
```

**Step 4**: GitHub Actions automatically:
- ✅ Builds for Windows, macOS, Linux
- ✅ Runs all tests
- ✅ Creates GitHub Release
- ✅ Uploads build artifacts

**Step 5**: Check your release
- Go to GitHub → Your repo → "Releases"
- Find version `v1.0.1` with all platform builds

---

## 📊 Viewing Results

### CI Status

1. **GitHub UI**:
   - Go to your repository
   - Click "Actions" tab
   - See all workflow runs

2. **Pull Requests**:
   - CI status shows as a checkmark/X on PRs
   - Green ✓ = All tests passed
   - Red ✗ = Tests failed (click to see details)

3. **Commits**:
   - Small checkmark/X icon next to commits
   - Shows if CI passed for that commit

### Release Status

1. **Actions Tab**:
   - Go to "Actions" tab
   - Find "Release" workflow
   - See progress for each platform

2. **Releases Page**:
   - Go to "Releases" in your repo
   - See all releases with downloads

---

## 🔧 Configuration

### Changing Trigger Branches

Edit `.github/workflows/ci.yml`:
```yaml
on:
  push:
    branches: [main, master, develop, your-branch]
```

### Adding More Tests

Edit `.github/workflows/ci.yml`:
```yaml
- name: Run E2E tests
  run: pnpm test:ui
```

### Customizing Release Notes

Edit `.github/workflows/release.yml`:
```yaml
body: |
  ## Changes in v${{ steps.get_version.outputs.VERSION }}
  
  - Feature 1
  - Bug fix 2
  - Improvement 3
```

---

## 🔐 Secrets & Permissions

### GitHub Token

The workflows use `GITHUB_TOKEN` which is:
- ✅ Automatically provided by GitHub
- ✅ No setup needed
- ✅ Has permission to create releases

### Repository Settings

Make sure:
- ✅ GitHub Actions is enabled (Settings → Actions → General)
- ✅ Workflow permissions allow read/write (usually default)

---

## 🎯 Next Steps (Optional Enhancements)

### 1. Add Electron Builder (For Installers)

Currently, workflows build the app but don't create installers (`.exe`, `.dmg`, etc.).

**To add installer creation**:

1. **Install electron-builder**:
   ```bash
   pnpm add -D electron-builder
   ```

2. **Add build script** to `package.json`:
   ```json
   {
     "scripts": {
       "build:installer": "electron-builder"
     }
   }
   ```

3. **Update release workflow** to create installers:
   ```yaml
   - name: Build installers
     run: pnpm build:installer --win --mac --linux
   ```

### 2. Add Code Signing (For Production)

For production releases, sign your apps:
- **macOS**: Apple Developer certificate
- **Windows**: Code signing certificate

Add to workflow:
```yaml
env:
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
  CSC_LINK: ${{ secrets.WINDOWS_CERT }}
  CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
```

### 3. Add Release Notes Auto-Generation

Automatically generate release notes from commits:

```yaml
- name: Generate Release Notes
  uses: release-drafter/release-drafter@v5
```

### 4. Add Notifications

Get notified when releases are ready:

```yaml
- name: Notify Team
  uses: 8398a7/action-slack@v3
  with:
    text: 'Release ${{ steps.get_version.outputs.VERSION }} is ready!'
```

---

## ❓ Troubleshooting

### Workflow Not Running

**Problem**: Workflows don't trigger

**Solutions**:
1. Check that workflows are in `.github/workflows/` directory
2. Ensure GitHub Actions is enabled (Settings → Actions)
3. Check workflow file syntax (YAML must be valid)
4. Verify trigger conditions match your branch names

### Tests Failing in CI

**Problem**: Tests pass locally but fail in CI

**Solutions**:
1. Check Node.js version matches (`package.json` specifies 18+)
2. Ensure all dependencies are in `package.json` (not just `devDependencies`)
3. Check that Prisma Client is generated (`pnpm db:generate`)
4. Review CI logs for specific error messages

### Release Not Created

**Problem**: Tag pushed but release not created

**Solutions**:
1. Ensure tag starts with `v` (e.g., `v1.0.0`, not `1.0.0`)
2. Check Actions tab for errors
3. Verify you have permission to create releases
4. Check that `GITHUB_TOKEN` has write permissions

### Build Failing on Specific Platform

**Problem**: Build works on some platforms but not others

**Solutions**:
1. Check platform-specific dependencies
2. Ensure native modules are compatible with all platforms
3. Review platform-specific error logs
4. Test builds locally for that platform

---

## 📈 Benefits

### Before CI/CD (Manual)

- ⏱️ **Time per release**: 30-60 minutes
- ❌ **Manual steps**: Build, test, package, upload
- ❌ **Human error**: Easy to miss steps or make mistakes
- ❌ **Inconsistent**: Different process each time

### After CI/CD (Automated)

- ⏱️ **Time per release**: 2 minutes (just tag and push)
- ✅ **Automatic**: Everything happens automatically
- ✅ **Consistent**: Same process every time
- ✅ **Reliable**: Tests catch bugs before release

---

## 📚 Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Electron Builder Documentation](https://www.electron.build/)
- [pnpm Documentation](https://pnpm.io/)

---

## ✅ Summary

Your CI/CD pipeline is ready to use! 

**To start using**:
1. Push code → CI runs automatically
2. Tag a release → Release is created automatically

**No additional setup needed** - it's ready to go! 🎉

---

*For questions or issues, check the Actions tab in your GitHub repository.*

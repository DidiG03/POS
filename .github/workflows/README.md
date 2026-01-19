# GitHub Actions Workflows

This directory contains CI/CD workflows for the POS system.

## Workflows

### 1. CI (`ci.yml`)

**Triggers**: Push and pull requests to `main`, `master`, or `develop`

**What it does**:
- Runs linter
- Runs unit tests (42 tests)
- Builds the application
- Uploads build artifacts

**When to use**: Every code change - ensures code quality before merging

### 2. Release (`release.yml`)

**Triggers**: When you push a version tag (e.g., `v1.0.0`)

**What it does**:
- Builds for all platforms (Windows, macOS, Linux)
- Runs tests for each platform
- Creates a GitHub Release
- Uploads build artifacts to the release

**When to use**: When releasing a new version

---

## How to Use

### Running CI Checks

CI runs automatically on:
- Every push to main/master/develop
- Every pull request

No action needed - just push your code!

### Creating a Release

1. **Update version in `package.json`**:
   ```json
   {
     "version": "1.0.1"
   }
   ```

2. **Commit and push**:
   ```bash
   git add package.json
   git commit -m "Bump version to 1.0.1"
   git push
   ```

3. **Create and push a tag**:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

4. **GitHub Actions will automatically**:
   - Build for all platforms
   - Run tests
   - Create a GitHub Release
   - Upload build artifacts

5. **Check the release**:
   - Go to your GitHub repository
   - Click "Releases"
   - Find your new release with all platform builds

---

## Requirements

### GitHub Token

The workflows use `GITHUB_TOKEN` which is automatically provided by GitHub Actions. No setup needed!

### Repository Settings

Make sure:
- GitHub Actions is enabled in repository settings
- You have permission to create releases

---

## Customization

### Adding More Tests

Edit `.github/workflows/ci.yml` and add test steps:
```yaml
- name: Run E2E tests
  run: pnpm test:ui
```

### Changing Platforms

Edit the `matrix` in `.github/workflows/release.yml`:
```yaml
matrix:
  os: [ubuntu-latest, windows-latest, macos-latest]
```

### Custom Build Steps

Edit the build step in either workflow:
```yaml
- name: Custom build step
  run: npm run custom-build
```

---

## Troubleshooting

### Workflow Not Running

- Check that GitHub Actions is enabled in repository settings
- Ensure the workflow file is in `.github/workflows/`
- Check the Actions tab for error messages

### Build Failing

- Check the Actions tab for error details
- Ensure all dependencies are in `package.json`
- Check that build scripts work locally

### Release Not Created

- Ensure you pushed a tag starting with `v` (e.g., `v1.0.0`)
- Check that you have permission to create releases
- Check the Actions tab for error messages

---

## Next Steps

1. **Add electron-builder**: For creating installers (`.exe`, `.dmg`, etc.)
2. **Add code signing**: For production releases
3. **Add release notes**: Automatically generate from commits
4. **Add notifications**: Notify team on release

See `docs/PRODUCTION_ROADMAP.md` for more details.

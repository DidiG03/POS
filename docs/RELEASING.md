# Releasing OneTap

One version, one tag, one GitHub Release.

1. Bump the version in **all four places**, to the same `x.y.z`:
   - `package.json` → `"version"`
   - `android/app/build.gradle` → `versionName` (and `versionCode` + 1)
   - `ios/App/App.xcodeproj/project.pbxproj` and
     `ios-admin/App/App.xcodeproj/project.pbxproj` → `MARKETING_VERSION`
     (and `CURRENT_PROJECT_VERSION` + 1)
2. Merge to `main`.
3. Tag **the merge commit** `v<version>` and push the tag:
   ```bash
   git checkout main && git pull origin main
   node scripts/checkReleaseVersion.mjs        # prints v<version>
   git tag -a v<version> -m "v<version>" && git push origin v<version>
   ```

The tag starts the release workflows (POS for Mac, Windows client, KDS, Admin,
Android, iOS Admin), which all upload to the release named by the tag.

## Guards

- `scripts/checkReleaseVersion.mjs` runs first in every release job and in CI.
  It fails when the tag is not `v<package.json version>` or the Android or
  iOS project carries another version. Nothing is built or uploaded then.
- `.github/scripts/gh-release.sh` refuses to upload to any release other than
  `v<package.json version>` and the tag that started the run. `--clobber`
  therefore only replaces files of the run's own release (a re-run).

Tag v0.2.105 was pushed on a commit whose `package.json` said 0.2.104: its
Windows, Android, KDS and Admin files went into the v0.2.104 release,
replacing the files there, and v0.2.105 only got the Mac files. Both guards
now stop that.

## Secrets

| Workflow          | Secret                                                                   | What it is                                                                                                 |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Release iOS Admin | `ASC_KEY_ID`                                                             | App Store Connect API key ID (App Store Connect → Users and Access → Integrations → App Store Connect API) |
|                   | `ASC_ISSUER_ID`                                                          | The Issuer ID shown above that keys list                                                                   |
|                   | `ASC_KEY_P8`                                                             | The whole downloaded `AuthKey_<ID>.p8` file, BEGIN/END lines included. The key needs the Admin role.       |
| Release Android   | `ANDROID_KEYSTORE_BASE64`                                                | base64 of the upload keystore file                                                                         |
|                   | `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Store password, key alias, key password                                                                    |

The iOS workflow checks its three secrets in its first steps and names any
that are missing.

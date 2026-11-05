#!/usr/bin/env node
/**
 * One version per release (QA v0.2.104, #5).
 *
 * Tag v0.2.105 was pushed on a commit whose package.json said 0.2.104. The
 * release workflows took the version from package.json, so they built
 * 0.2.104 and uploaded it into the existing v0.2.104 release, overwriting
 * its files, while v0.2.105 got only the Mac files. Every release job now
 * runs this first. It fails the job when:
 *   - the pushed tag is not `v<package.json version>` (or
 *     `ios-admin-v<version>` for an Admin-only iOS rebuild);
 *   - the Android or iOS project carries another version.
 * With no tag (a branch build, a manual run) only the projects are compared.
 *
 *   node scripts/checkReleaseVersion.mjs [tag]
 *
 * The tag defaults to GITHUB_REF_NAME when GITHUB_REF_TYPE is "tag". On
 * success it prints the release tag and writes `version` and `tag` to
 * GITHUB_OUTPUT when set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_FORMS = [/^v(.+)$/, /^ios-admin-v(.+)$/];

/** Problems with this set of versions; empty when they all agree. */
export function releaseVersionProblems({ tag, version, gradle, pbxprojs }) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    problems.push(`package.json version "${version}" is not x.y.z.`);
    return problems;
  }
  if (tag) {
    const tagged = TAG_FORMS.map((re) => String(tag).match(re)?.[1]).find(
      Boolean,
    );
    if (!tagged) {
      problems.push(`Tag "${tag}" is not a release tag (v<version>).`);
    } else if (tagged !== version) {
      problems.push(
        `Tag ${tag} does not match package.json version ${version}. ` +
          `Bump the version to ${tagged} in package.json, android/app/build.gradle and the iOS projects, ` +
          `merge, and tag that commit; or tag this commit v${version}. Nothing was built or uploaded.`,
      );
    }
  }
  if (gradle != null) {
    const name = String(gradle).match(/versionName\s+"([^"]+)"/)?.[1];
    if (name !== version) {
      problems.push(
        `android/app/build.gradle versionName "${name}" is not ${version}.`,
      );
    }
  }
  for (const [file, text] of Object.entries(pbxprojs || {})) {
    const found = [
      ...String(text).matchAll(/MARKETING_VERSION = ([^;]+);/g),
    ].map((m) => m[1].trim());
    const wrong = found.filter((v) => v !== version);
    if (wrong.length) {
      problems.push(`${file} MARKETING_VERSION ${wrong[0]} is not ${version}.`);
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf8');
    } catch {
      return null;
    }
  };
  const version = JSON.parse(read('package.json')).version;
  const tag =
    process.argv[2] ||
    (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '');
  const pbxprojs = {};
  for (const p of [
    'ios/App/App.xcodeproj/project.pbxproj',
    'ios-admin/App/App.xcodeproj/project.pbxproj',
  ]) {
    const text = read(p);
    if (text != null) pbxprojs[p] = text;
  }
  const problems = releaseVersionProblems({
    tag,
    version,
    gradle: read('android/app/build.gradle'),
    pbxprojs,
  });
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  const releaseTag = `v${version}`;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=${releaseTag}\n`,
    );
  }
  console.log(releaseTag);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}

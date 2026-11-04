/**
 * QA v0.2.104 #5: CI rejects a release tag that does not match the package
 * version, and app projects that carry another version.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { releaseVersionProblems } from '../../scripts/checkReleaseVersion.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const gradle = (v: string) => `versionCode 77\n        versionName "${v}"\n`;
const pbx = (v: string) =>
  `MARKETING_VERSION = ${v};\nMARKETING_VERSION = ${v};\n`;
const ok = {
  version: '0.2.106',
  gradle: gradle('0.2.106'),
  pbxprojs: { 'ios/App': pbx('0.2.106'), 'ios-admin/App': pbx('0.2.106') },
};

describe('release version check', () => {
  it('passes a matching tag, an Admin-only iOS tag and a branch build', () => {
    expect(releaseVersionProblems({ ...ok, tag: 'v0.2.106' })).toEqual([]);
    expect(
      releaseVersionProblems({ ...ok, tag: 'ios-admin-v0.2.106' }),
    ).toEqual([]);
    expect(releaseVersionProblems({ ...ok, tag: '' })).toEqual([]);
  });

  it('rejects the v0.2.105-on-0.2.104 release', () => {
    const problems = releaseVersionProblems({
      ...ok,
      version: '0.2.104',
      gradle: gradle('0.2.104'),
      pbxprojs: { 'ios/App': pbx('0.2.104') },
      tag: 'v0.2.105',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /Tag v0\.2\.105 does not match package\.json version 0\.2\.104/,
    );
  });

  it('rejects app projects with another version, and odd tags', () => {
    expect(
      releaseVersionProblems({ ...ok, gradle: gradle('0.2.105') }),
    ).toEqual([expect.stringMatching(/build\.gradle versionName "0\.2\.105"/)]);
    expect(
      releaseVersionProblems({
        ...ok,
        pbxprojs: {
          'ios-admin/App': `${pbx('0.2.106')}MARKETING_VERSION = 0.2.99;`,
        },
      }),
    ).toEqual([expect.stringMatching(/MARKETING_VERSION 0\.2\.99/)]);
    expect(releaseVersionProblems({ ...ok, tag: 'release-1' })).toEqual([
      expect.stringMatching(/not a release tag/),
    ]);
  });

  it('this checkout agrees with itself, and the CLI fails a wrong tag', () => {
    const run = (args: string[]) => {
      try {
        return {
          code: 0,
          out: execFileSync(
            'node',
            ['scripts/checkReleaseVersion.mjs', ...args],
            {
              cwd: ROOT,
              encoding: 'utf8',
              env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_REF_TYPE: '' },
            },
          ),
        };
      } catch (e: any) {
        return { code: e.status as number, out: String(e.stderr) };
      }
    };
    const version = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ).version;
    expect(run([])).toEqual({ code: 0, out: `v${version}\n` });
    const bad = run(['v0.0.1']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/::error::Tag v0\.0\.1 does not match/);
  });

  it('the upload helper refuses another release than the run’s own', () => {
    const script = `source .github/scripts/gh-release.sh; gh_assert_own_release "$1"`;
    const version = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ).version;
    const attempt = (tag: string, env: Record<string, string> = {}) => {
      try {
        execFileSync('bash', ['-c', script, 'x', tag], {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_REF_TYPE: '', ...env },
        });
        return 0;
      } catch (e: any) {
        return e.status as number;
      }
    };
    expect(attempt(`v${version}`)).toBe(0);
    // The build is one version; another release is never written to.
    expect(attempt('v0.2.104')).toBe(1);
    // Started by another tag: refused even with the right version.
    expect(
      attempt(`v${version}`, {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v0.2.105',
      }),
    ).toBe(1);
  });
});

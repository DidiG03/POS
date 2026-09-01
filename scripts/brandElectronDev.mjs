/**
 * Chrome/macOS protocol prompts and the Dock tooltip use the Electron
 * binary's Info.plist — and, on macOS, any localized InfoPlist.strings
 * which otherwise keep the stock name "Electron".
 *
 * Packaged builds already use productName from electron-builder.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'OneTap POS';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
let electronBin;
try {
  electronBin = require('electron');
} catch {
  process.exit(0);
}

const appBundle = path.resolve(String(electronBin), '../../..');
const plist = path.join(appBundle, 'Contents', 'Info.plist');
if (!appBundle.endsWith('.app') || !fs.existsSync(plist)) process.exit(0);

function plutilReplace(file, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, file], {
    stdio: 'ignore',
  });
}

function patchPlistStrings(file) {
  try {
    plutilReplace(file, 'CFBundleName', APP_NAME);
    plutilReplace(file, 'CFBundleDisplayName', APP_NAME);
    return;
  } catch {
    // Binary/XML replace can fail on UTF-16 text .strings — rewrite.
  }
  try {
    let raw = fs.readFileSync(file);
    let text;
    if (raw[0] === 0xff && raw[1] === 0xfe) {
      text = raw.slice(2).toString('utf16le');
    } else if (raw[0] === 0xfe && raw[1] === 0xff) {
      text = Buffer.from(raw.slice(2)).swap16().toString('utf16le');
    } else {
      text = raw.toString('utf8');
    }
    const next = text
      .replace(/("CFBundleName"\s*=\s*")[^"]*(")/g, `$1${APP_NAME}$2`)
      .replace(/("CFBundleDisplayName"\s*=\s*")[^"]*(")/g, `$1${APP_NAME}$2`)
      .replace(/(CFBundleName\s*=\s*")[^"]*(")/g, `$1${APP_NAME}$2`)
      .replace(/(CFBundleDisplayName\s*=\s*")[^"]*(")/g, `$1${APP_NAME}$2`);
    if (next !== text) {
      if (raw[0] === 0xff && raw[1] === 0xfe) {
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(next, 'utf16le')]));
      } else {
        fs.writeFileSync(file, next, 'utf8');
      }
    }
  } catch {
    // ignore a single locale
  }
}

try {
  plutilReplace(plist, 'CFBundleName', APP_NAME);
  plutilReplace(plist, 'CFBundleDisplayName', APP_NAME);
} catch {
  process.exit(0);
}

const resources = path.join(appBundle, 'Contents', 'Resources');
if (fs.existsSync(resources)) {
  for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
    const strings = path.join(resources, entry.name, 'InfoPlist.strings');
    if (fs.existsSync(strings)) patchPlistStrings(strings);
  }
}

const iconSrc = path.join(ROOT, 'build-resources', 'icon.icns');
const iconDest = path.join(resources, 'electron.icns');
if (fs.existsSync(iconSrc) && fs.existsSync(path.dirname(iconDest))) {
  try {
    fs.copyFileSync(iconSrc, iconDest);
  } catch {
    // icon is optional for the name fix
  }
}

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (fs.existsSync(lsregister)) {
  try {
    execFileSync(lsregister, ['-f', appBundle], { stdio: 'ignore' });
  } catch {
    // Launch Services refresh is best-effort
  }
}

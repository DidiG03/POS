import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readElectronVersion() {
  try {
    // electron is a devDependency; read installed version
    return require('electron/package.json').version;
  } catch (e) {
    console.error('Could not read electron version from node_modules. Is electron installed?');
    process.exit(1);
  }
}

const electronVersion = readElectronVersion();
const env = {
  ...process.env,
  npm_config_runtime: 'electron',
  npm_config_target: electronVersion,
  npm_config_disturl: 'https://electronjs.org/headers',
  npm_config_arch: process.arch,
};

console.log(`[serialport] Rebuilding @serialport/bindings-cpp for Electron ${electronVersion} (${process.platform}/${process.arch})...`);

const r = spawnSync('pnpm', ['rebuild', '@serialport/bindings-cpp', '--unsafe-perm'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

process.exit(r.status ?? 1);


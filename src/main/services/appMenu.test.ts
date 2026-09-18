import { describe, expect, it } from 'vitest';
import { buildAppMenuTemplate, updateMenuLabel } from './appMenuTemplate';

describe('updateMenuLabel', () => {
  it('uses Check for Updates until a package is ready', () => {
    expect(
      updateMenuLabel({
        checking: false,
        downloading: false,
        downloadPercent: null,
        hasUpdate: false,
        downloaded: false,
      }),
    ).toBe('Check for Updates…');
    expect(
      updateMenuLabel({
        checking: false,
        downloading: false,
        downloadPercent: null,
        hasUpdate: true,
        downloaded: false,
      }),
    ).toBe('Download and Install Update…');
    expect(
      updateMenuLabel({
        checking: false,
        downloading: false,
        downloadPercent: null,
        hasUpdate: true,
        downloaded: true,
      }),
    ).toBe('Install Update and Restart');
  });

  it('shows progress while a check or download is running', () => {
    expect(
      updateMenuLabel({
        checking: true,
        downloading: false,
        downloadPercent: null,
        hasUpdate: false,
        downloaded: false,
      }),
    ).toBe('Checking for Updates…');
    expect(
      updateMenuLabel({
        checking: false,
        downloading: true,
        downloadPercent: 42,
        hasUpdate: true,
        downloaded: false,
      }),
    ).toBe('Downloading Update (42%)');
  });
});

describe('buildAppMenuTemplate', () => {
  const base = {
    appName: 'OneTap POS',
    version: '0.2.40',
    checking: false,
    downloading: false,
    downloadPercent: null as number | null,
    hasUpdate: false,
    downloaded: false,
    onCheckForUpdates: () => undefined,
  };

  it('puts Check for Updates on Windows File and Help menus', () => {
    const template = buildAppMenuTemplate({ ...base, platform: 'win32' });
    const labels = JSON.stringify(template);
    expect(labels).toContain('Check for Updates…');
    expect(template[0]?.label).toBe('File');
    const fileSub = template[0]?.submenu;
    expect(Array.isArray(fileSub) && fileSub[0]?.label).toBe(
      'Check for Updates…',
    );
    const help = template.find((item) => item.role === 'help');
    expect(help).toBeTruthy();
    expect(
      Array.isArray(help?.submenu) &&
        help.submenu.some((item) => item.label === 'Check for Updates…'),
    ).toBe(true);
  });

  it('puts Check for Updates on the macOS app menu', () => {
    const template = buildAppMenuTemplate({ ...base, platform: 'darwin' });
    expect(template[0]?.label).toBe('OneTap POS');
    const appSub = template[0]?.submenu;
    expect(
      Array.isArray(appSub) &&
        appSub.some((item) => item.label === 'Check for Updates…'),
    ).toBe(true);
  });

  it('shows this till’s address on POS Help, not Admin', () => {
    const pos = buildAppMenuTemplate({
      ...base,
      platform: 'darwin',
      onShowTillAddress: () => undefined,
    });
    expect(JSON.stringify(pos)).toContain('This Till’s Address…');
    const admin = buildAppMenuTemplate({ ...base, platform: 'darwin' });
    expect(JSON.stringify(admin)).not.toContain('This Till’s Address…');
  });
});

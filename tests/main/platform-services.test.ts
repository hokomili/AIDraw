import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPlatformInfo } from '../../src/common/platform';
import { requireSecureStorage, secureStorageStatus } from '@main/secure-storage';
import { getStartAtLoginStatus, linuxAutostartPath, setStartAtLogin, wasOpenedAtLogin, type StartAtLoginContext } from '@main/start-at-login';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function mockApp(options: { packaged?: boolean; openAtLogin?: boolean; wasOpenedAtLogin?: boolean } = {}) {
  return {
    isPackaged: options.packaged ?? true,
    getLoginItemSettings: () => ({ openAtLogin: options.openAtLogin ?? false, wasOpenedAtLogin: options.wasOpenedAtLogin ?? false }),
    setLoginItemSettings: vi.fn(),
  } as unknown as StartAtLoginContext['app'];
}

describe('desktop platform services', () => {
  it('names each supported operating-system credential backend', () => {
    expect(desktopPlatformInfo('win32').credentialProtection).toBe('Windows DPAPI');
    expect(desktopPlatformInfo('darwin').credentialProtection).toBe('macOS Keychain');
    expect(desktopPlatformInfo('linux', 'gnome_libsecret').credentialProtection).toContain('gnome libsecret');
  });

  it('rejects Linux basic_text while accepting a real secret store', () => {
    const insecure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
    expect(secureStorageStatus(insecure, 'linux')).toMatchObject({ available: false, backend: 'basic_text' });
    expect(() => requireSecureStorage(insecure, 'linux')).toThrow(/refuses.*basic_text/i);
    expect(secureStorageStatus({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'kwallet6' }, 'linux')).toMatchObject({ available: true, backend: 'kwallet6' });
  });

  it('reports unavailable Keychain/DPAPI without falling back to plaintext', () => {
    expect(secureStorageStatus({ isEncryptionAvailable: () => false }, 'darwin')).toMatchObject({ available: false, reason: expect.stringContaining('Keychain') });
    expect(secureStorageStatus({ isEncryptionAvailable: () => false }, 'win32')).toMatchObject({ available: false, reason: expect.stringContaining('DPAPI') });
  });

  it('creates and removes a headless XDG autostart entry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aidraw-autostart-'));
    temporaryDirectories.push(home);
    const context: StartAtLoginContext = { app: mockApp(), platform: 'linux', executablePath: '/opt/AIDraw/AIDraw', environment: {}, homeDirectory: home };
    expect(getStartAtLoginStatus(context)).toMatchObject({ supported: true, enabled: false, mechanism: 'xdg-autostart' });
    expect(await setStartAtLogin(context, true)).toMatchObject({ enabled: true });
    const entry = await readFile(linuxAutostartPath({}, home), 'utf8');
    expect(entry).toContain('Exec="/opt/AIDraw/AIDraw" --headless');
    expect(await setStartAtLogin(context, false)).toMatchObject({ enabled: false });
  });

  it('uses native Windows and macOS login-item APIs', async () => {
    const windowsApp = mockApp();
    await setStartAtLogin({ app: windowsApp, platform: 'win32', executablePath: 'C:\\Portable\\AIDraw.exe' }, true);
    expect(windowsApp.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: true, args: ['--headless'] }));
    const macApp = mockApp({ wasOpenedAtLogin: true });
    await setStartAtLogin({ app: macApp, platform: 'darwin', executablePath: '/Applications/AIDraw.app/Contents/MacOS/AIDraw' }, true);
    expect(macApp.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(wasOpenedAtLogin({ app: macApp, platform: 'darwin' })).toBe(true);
  });

  it('does not claim login startup in development or unsupported systems', () => {
    expect(getStartAtLoginStatus({ app: mockApp({ packaged: false }), platform: 'linux' })).toMatchObject({ supported: false });
    expect(getStartAtLoginStatus({ app: mockApp(), platform: 'freebsd' })).toMatchObject({ supported: false, mechanism: 'unavailable' });
  });
});

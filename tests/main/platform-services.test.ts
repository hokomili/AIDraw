import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPlatformInfo } from '../../src/common/platform';
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
  it('reports supported desktop platforms without a protected-secret dependency', () => {
    expect(desktopPlatformInfo('win32')).toEqual({ id: 'windows', label: 'Windows' });
    expect(desktopPlatformInfo('darwin')).toEqual({ id: 'macos', label: 'macOS' });
    expect(desktopPlatformInfo('linux')).toEqual({ id: 'linux', label: 'Linux' });
  });

  it('creates and removes a headless XDG autostart entry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aidraw-autostart-'));
    temporaryDirectories.push(home);
    const context: StartAtLoginContext = { app: mockApp(), platform: 'linux', executablePath: '/opt/AIDraw/AIDraw', environment: {}, homeDirectory: home };
    expect(getStartAtLoginStatus(context)).toMatchObject({ supported: true, enabled: false, mechanism: 'xdg-autostart' });
    expect(await setStartAtLogin(context, true)).toMatchObject({ enabled: true });
    const entry = await readFile(linuxAutostartPath({}, home), 'utf8');
    expect(entry).toContain('Exec="/opt/AIDraw/AIDraw" --headless');
    if (process.platform !== 'win32') expect((await stat(linuxAutostartPath({}, home))).mode & 0o777).toBe(0o600);
    expect(await setStartAtLogin(context, false)).toMatchObject({ enabled: false });
  });

  it('serializes XDG enable then disable while one complete replacement is pending', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aidraw-autostart-order-'));
    temporaryDirectories.push(home);
    let markReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => { markReplacementStarted = resolve; });
    let releaseReplacement!: () => void;
    const replacementRelease = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      markReplacementStarted();
      await replacementRelease;
      await rename(source, destination);
    });
    const context: StartAtLoginContext = {
      app: mockApp(), platform: 'linux', executablePath: '/opt/AIDraw/AIDraw', environment: {}, homeDirectory: home, replaceFile,
    };

    const enabled = setStartAtLogin(context, true);
    await replacementStarted;
    const disabled = setStartAtLogin(context, false);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(replaceFile).toHaveBeenCalledOnce();
    expect(getStartAtLoginStatus(context).enabled).toBe(false);
    releaseReplacement();

    await expect(enabled).resolves.toMatchObject({ enabled: true });
    await expect(disabled).resolves.toMatchObject({ enabled: false });
    expect(getStartAtLoginStatus(context).enabled).toBe(false);
    const directory = join(home, '.config', 'autostart');
    expect((await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves an existing XDG entry on replacement failure and recovers the queue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aidraw-autostart-failure-'));
    temporaryDirectories.push(home);
    const target = linuxAutostartPath({}, home);
    const original = '[Desktop Entry]\nName=Prior startup\n';
    await mkdir(join(home, '.config', 'autostart'), { recursive: true });
    await writeFile(target, original, 'utf8');
    let replacements = 0;
    const replaceFile = async (source: string, destination: string): Promise<void> => {
      replacements += 1;
      if (replacements === 1) throw new Error('simulated XDG replacement failure');
      await rename(source, destination);
    };
    const context: StartAtLoginContext = {
      app: mockApp(), platform: 'linux', executablePath: '/opt/AIDraw/AIDraw', environment: {}, homeDirectory: home, replaceFile,
    };

    await expect(setStartAtLogin(context, true)).rejects.toThrow('simulated XDG replacement failure');
    await expect(readFile(target, 'utf8')).resolves.toBe(original);
    expect((await readdir(join(home, '.config', 'autostart'))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

    await expect(setStartAtLogin(context, true)).resolves.toMatchObject({ enabled: true });
    await expect(readFile(target, 'utf8')).resolves.toContain('Exec="/opt/AIDraw/AIDraw" --headless');
    expect(replacements).toBe(2);
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600);
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

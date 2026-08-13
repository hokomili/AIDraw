import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { App } from 'electron';
import { replacePrivateTextFile, type PrivateFileReplacer } from './private-json-file';

type LoginItemApp = Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>;

export interface StartAtLoginContext {
  app: LoginItemApp;
  platform?: NodeJS.Platform;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  replaceFile?: PrivateFileReplacer;
}

export interface StartAtLoginStatus {
  supported: boolean;
  enabled: boolean;
  mechanism: 'windows-login-item' | 'macos-login-item' | 'xdg-autostart' | 'unavailable';
}

let startAtLoginQueue: Promise<void> = Promise.resolve();

function exclusiveStartAtLogin<T>(operation: () => Promise<T>): Promise<T> {
  const result = startAtLoginQueue.then(operation, operation);
  startAtLoginQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function linuxAutostartPath(environment: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()): string {
  return join(environment.XDG_CONFIG_HOME || join(homeDirectory, '.config'), 'autostart', 'aidraw-engine.desktop');
}

function desktopExecArgument(value: string): string {
  return `"${value.replace(/([\\`"$])/g, '\\$1')}"`;
}

export function linuxAutostartEntry(executablePath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AIDraw Agent Engine',
    'Comment=Run the local AIDraw MCP engine without opening the editor',
    `Exec=${desktopExecArgument(executablePath)} --headless`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function getStartAtLoginStatus(context: StartAtLoginContext): StartAtLoginStatus {
  const platform = context.platform ?? process.platform;
  if (!context.app.isPackaged) return { supported: false, enabled: false, mechanism: 'unavailable' };
  if (platform === 'win32') return { supported: true, enabled: context.app.getLoginItemSettings().openAtLogin, mechanism: 'windows-login-item' };
  if (platform === 'darwin') return { supported: true, enabled: context.app.getLoginItemSettings().openAtLogin, mechanism: 'macos-login-item' };
  if (platform === 'linux') {
    return {
      supported: true,
      enabled: existsSync(linuxAutostartPath(context.environment, context.homeDirectory)),
      mechanism: 'xdg-autostart',
    };
  }
  return { supported: false, enabled: false, mechanism: 'unavailable' };
}

export async function setStartAtLogin(context: StartAtLoginContext, enabled: boolean): Promise<StartAtLoginStatus> {
  return exclusiveStartAtLogin(async () => {
    const status = getStartAtLoginStatus(context);
    if (!status.supported) return status;
    const platform = context.platform ?? process.platform;
    const executablePath = context.executablePath ?? process.execPath;
    if (platform === 'win32') {
      const squirrelStub = resolve(dirname(executablePath), '..', basename(executablePath));
      context.app.setLoginItemSettings({
        openAtLogin: enabled,
        path: existsSync(squirrelStub) ? squirrelStub : executablePath,
        args: ['--headless'],
      });
    } else if (platform === 'darwin') {
      context.app.setLoginItemSettings({ openAtLogin: enabled });
    } else if (platform === 'linux') {
      const target = linuxAutostartPath(context.environment, context.homeDirectory);
      if (enabled) {
        await replacePrivateTextFile(target, linuxAutostartEntry(executablePath), context.replaceFile);
      } else {
        await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    return getStartAtLoginStatus(context);
  });
}

export function wasOpenedAtLogin(context: StartAtLoginContext): boolean {
  const platform = context.platform ?? process.platform;
  return context.app.isPackaged && platform === 'darwin' && context.app.getLoginItemSettings().wasOpenedAtLogin === true;
}

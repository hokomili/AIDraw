import { describe, expect, it } from 'vitest';
import { FuseState, FuseVersion } from '@electron/fuses';
import { IPC } from '../../src/common/contracts';
import {
  PACKAGED_FUSE_EXPECTATIONS,
  PACKAGED_PRELOAD_CHANNELS,
  PACKAGED_SECURITY_CSP,
  assertHardenedFuseWire,
  assertPackagedSecuritySources,
} from '../../scripts/packaged-security.mjs';

function hardenedWire(): Record<string | number, unknown> {
  return Object.fromEntries([
    ['version', FuseVersion.V1],
    ...PACKAGED_FUSE_EXPECTATIONS.map((entry) => [entry[1], entry[2]]),
  ]);
}

function secureMainSource(): string {
  return [
    'new BrowserWindow({webPreferences:{preload:path,sandbox:!0,contextIsolation:!0,nodeIntegration:!1,webSecurity:!0,allowRunningInsecureContent:!1}})',
    'window.webContents.setWindowOpenHandler(()=>({action:"deny"}))',
    'window.webContents.on("will-navigate",(event,url)=>{trusted(url)||event.preventDefault()})',
    'contents.on("will-attach-webview",event=>event.preventDefault())',
    'contents.setWindowOpenHandler(()=>({action:"deny"}))',
    'session.setPermissionCheckHandler(()=>!1)',
    'session.setPermissionRequestHandler((contents,permission,callback)=>callback(!1))',
    'throw new Error("Rejected IPC from an untrusted renderer.")',
    'throw new Error("Rejected IPC from an unexpected origin.")',
  ].join(';');
}

function securePreloadSource(): string {
  const channels = PACKAGED_PRELOAD_CHANNELS.map((channel, index) => `channel${index}:"${channel}"`).join(',');
  const invokes = Array.from({ length: 63 }, (_value, index) => `command${index}:()=>electron.ipcRenderer.invoke(channels.channel${index})`).join(',');
  return [
    '"use strict"',
    'const electron=require("electron")',
    `const channels={${channels}}`,
    `const api={${invokes}}`,
    'electron.ipcRenderer.on(channels.channel63,listenerOne)',
    'electron.ipcRenderer.removeListener(channels.channel63,listenerOne)',
    'electron.ipcRenderer.on(channels.channel64,listenerTwo)',
    'electron.ipcRenderer.removeListener(channels.channel64,listenerTwo)',
    'electron.contextBridge.exposeInMainWorld("aidraw",Object.freeze(api))',
  ].join(';');
}

function secureSources() {
  return {
    mainSource: secureMainSource(),
    preloadSource: securePreloadSource(),
    rendererHtml: `<meta http-equiv="Content-Security-Policy" content="${PACKAGED_SECURITY_CSP}">`,
  };
}

describe('packaged Electron security verification', () => {
  it('tracks the complete current typed IPC channel set', () => {
    expect(PACKAGED_PRELOAD_CHANNELS).toHaveLength(65);
    expect([...PACKAGED_PRELOAD_CHANNELS].sort()).toEqual(Object.values(IPC).sort());
  });

  it('accepts only the complete hardened V1 fuse wire', () => {
    expect(assertHardenedFuseWire(hardenedWire())).toEqual({
      RunAsNode: 'disabled',
      EnableCookieEncryption: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled',
      LoadBrowserProcessSpecificV8Snapshot: 'disabled',
      GrantFileProtocolExtraPrivileges: 'disabled',
      WasmTrapHandlers: 'enabled',
    });
  });

  it.each(PACKAGED_FUSE_EXPECTATIONS)('rejects drift in %s', (name, option, expectedState) => {
    const wire = hardenedWire();
    wire[option] = expectedState === FuseState.ENABLE ? FuseState.DISABLE : FuseState.ENABLE;
    expect(() => assertHardenedFuseWire(wire)).toThrow(name);
  });

  it('accepts the exact BrowserWindow, denial, CSP, and serialized preload contract', () => {
    expect(assertPackagedSecuritySources(secureSources())).toMatchObject({
      browserWindow: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      denials: { permissions: true, windowOpen: true, navigation: true, webviewAttach: true },
      preload: { frozenAidrawBridge: true, invokeBindings: 63, eventBindings: 2, fixedChannels: 65 },
    });
  });

  it('rejects weakened BrowserWindow or denial markers', () => {
    const browser = secureSources();
    browser.mainSource = browser.mainSource.replace('sandbox:!0', 'sandbox:!1');
    expect(() => assertPackagedSecuritySources(browser)).toThrow(/BrowserWindow/);

    const permissions = secureSources();
    permissions.mainSource = permissions.mainSource.replace('setPermissionCheckHandler(()=>!1)', 'setPermissionCheckHandler(()=>!0)');
    expect(() => assertPackagedSecuritySources(permissions)).toThrow(/permission-check/);
  });

  it('rejects CSP weakening and generic or expanded preload authority', () => {
    const csp = secureSources();
    csp.rendererHtml = csp.rendererHtml.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    expect(() => assertPackagedSecuritySources(csp)).toThrow(/CSP/);

    const genericIpc = secureSources();
    genericIpc.preloadSource += ';electron.ipcRenderer.send("renderer-selected")';
    expect(() => assertPackagedSecuritySources(genericIpc)).toThrow(/generic IPC/);

    const nodeImport = secureSources();
    nodeImport.preloadSource = nodeImport.preloadSource.replace('const electron=require("electron")', 'const electron=require("electron");const fs=require("node:fs")');
    expect(() => assertPackagedSecuritySources(nodeImport)).toThrow(/exactly once and no other module/);
  });
});

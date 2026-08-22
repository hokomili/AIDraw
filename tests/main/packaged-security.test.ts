import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FuseState, FuseVersion } from '@electron/fuses';
import { IPC } from '../../src/common/contracts';
import {
  PACKAGED_FUSE_EXPECTATIONS,
  PACKAGED_PRELOAD_CHANNELS,
  PACKAGED_SECURITY_CSP,
  assertRetiredProductSurfacesAbsent,
  assertHardenedFuseWire,
  assertPackagedSecuritySources,
  findFirstPartyPackagedJavaScriptEntries,
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
    'const bridgeMode="--mcp-bridge"',
    'const stableBridgeLauncher="bridge-launcher.sh"',
    'const currentEngine="mcp-current.json"',
    'const identityRoute="/mcp/identity"',
    'electron.app.commandLine.appendSwitch("no-startup-window")',
    'electron.app.setActivationPolicy("accessory")',
    'electron.app.dock?.hide()',
  ].join(';');
}

function securePreloadSource(): string {
  const channels = PACKAGED_PRELOAD_CHANNELS.map((channel, index) => `channel${index}:"${channel}"`).join(',');
  const invokes = Array.from({ length: 54 }, (_value, index) => `command${index}:()=>electron.ipcRenderer.invoke(channels.channel${index})`).join(',');
  return [
    '"use strict"',
    'const electron=require("electron")',
    `const channels={${channels}}`,
    `const api={${invokes}}`,
    'electron.ipcRenderer.on(channels.channel54,listenerOne)',
    'electron.ipcRenderer.removeListener(channels.channel54,listenerOne)',
    'electron.ipcRenderer.on(channels.channel55,listenerTwo)',
    'electron.ipcRenderer.removeListener(channels.channel55,listenerTwo)',
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
    expect(PACKAGED_PRELOAD_CHANNELS).toHaveLength(56);
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
      mcpBridge: { stableLauncher: true, privateDiscovery: true, authenticatedIdentity: true, preReadyUiSuppression: true, perLaunchClientRewriteAbsent: true },
      preload: { frozenAidrawBridge: true, invokeBindings: 54, eventBindings: 2, fixedChannels: 56 },
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

  it('rejects missing stable-bridge wiring or retired per-launch setup copy', () => {
    for (const marker of ['--mcp-bridge', 'bridge-launcher.sh', 'mcp-current.json', '/mcp/identity', 'no-startup-window', 'setActivationPolicy("accessory")', 'dock?.hide']) {
      const sources = secureSources();
      sources.mainSource = sources.mainSource.replace(marker, 'missing-marker');
      expect(() => assertPackagedSecuritySources(sources)).toThrow(/MCP|current-engine|engine-instance|macOS/);
    }
    const staleSetup = secureSources();
    staleSetup.mainSource += ';"fresh connection after every AIDraw restart"';
    expect(() => assertPackagedSecuritySources(staleSetup)).toThrow(/per-launch/);
  });

  it('rejects retired product dependencies and active runtime markers before package acceptance', async () => {
    const clean = {
      archiveFiles: [
        '/.vite/build/main.js',
        '/.vite/build/preload.js',
        '/.vite/build/utility-worker.js',
        '/.vite/build/import-document-ABC123.js',
        '/.vite/build/dynamic-local-tool-DEF456.js',
        '/.vite/build/procedural-tool-JKL012.mjs',
        '/.vite/renderer/main_window/assets/index-GHI789.js',
      ],
      firstPartyJavaScriptChunks: [
        { path: '/.vite/build/main.js', source: 'createEphemeralMcpAuthority(); historicalProvenance=["openai","stability","comfyui"]' },
        { path: '/.vite/build/preload.js', source: 'getAgentClientSetup()' },
        { path: '/.vite/build/utility-worker.js', source: 'deterministicRasterUtility()' },
        { path: '/.vite/build/import-document-ABC123.js', source: 'importLocalDocument()' },
        { path: '/.vite/build/dynamic-local-tool-DEF456.js', source: 'runProceduralLocalTool()' },
        { path: '/.vite/build/procedural-tool-JKL012.mjs', source: 'runDeterministicPattern()' },
        { path: '/.vite/renderer/main_window/assets/index-GHI789.js', source: 'native drawing pixel tilemap editor' },
      ],
    };
    expect(findFirstPartyPackagedJavaScriptEntries([...clean.archiveFiles, '/node_modules/library/index.js', '/README.md'])).toEqual(clean.archiveFiles);
    expect(assertRetiredProductSurfacesAbsent(clean)).toMatchObject({
      archiveDependencyRootsChecked: 2,
      firstPartyJavaScriptChunksChecked: 7,
      providerRuntimeAbsent: true,
      generationWorkflowAbsent: true,
      protectedSecretStorageAbsent: true,
    });

    for (const archiveEntry of ['/node_modules/openai/index.js', '/node_modules/jsonc-parser/lib/umd/main.js']) {
      expect(() => assertRetiredProductSurfacesAbsent({ ...clean, archiveFiles: [...clean.archiveFiles, archiveEntry] })).toThrow(/runtime dependency/);
    }
    for (const retiredSource of [
      'safeStorage.encryptString(value)',
      'process.env.OPENAI_API_KEY',
      'registerTool("generation_start")',
      'ipcRenderer.invoke("aidraw:generation:set-credential")',
      'new ProviderCredentials()',
      'join("credentials", "mcp-token.json")',
      'message="Refresh these settings after AIDraw restarts"',
    ]) {
      const firstPartyJavaScriptChunks = clean.firstPartyJavaScriptChunks.map((chunk) => chunk.path === '/.vite/build/utility-worker.js'
        ? { ...chunk, source: `${chunk.source};${retiredSource}` }
        : chunk);
      expect(() => assertRetiredProductSurfacesAbsent({ ...clean, firstPartyJavaScriptChunks })).toThrow(/retired/);
    }

    for (const [path, marker] of [
      ['/.vite/build/dynamic-local-tool-DEF456.js', 'import("generation-provider-runner")'],
      ['/.vite/build/utility-worker.js', 'kind="generation-run"'],
      ['/.vite/build/import-document-ABC123.js', 'kind="render-generation-approval-preview"'],
      ['/.vite/build/dynamic-local-tool-DEF456.js', 'fixture="fnd09-generated-preview-acceptance-normalization"'],
      ['/.vite/build/dynamic-local-tool-DEF456.js', 'kind="normalize-generation-acceptance"'],
      ['/.vite/build/generation-provider-runner-ABC123.js', 'localDrawingTool()'],
    ] as const) {
      const archiveFiles = clean.archiveFiles.includes(path) ? clean.archiveFiles : [...clean.archiveFiles, path];
      const firstPartyJavaScriptChunks = clean.firstPartyJavaScriptChunks
        .filter((chunk) => chunk.path !== path)
        .concat({ path, source: marker });
      expect(() => assertRetiredProductSurfacesAbsent({ archiveFiles, firstPartyJavaScriptChunks })).toThrow(/retired/);
    }

    expect(() => assertRetiredProductSurfacesAbsent({
      ...clean,
      firstPartyJavaScriptChunks: clean.firstPartyJavaScriptChunks.filter((chunk) => chunk.path !== '/.vite/build/dynamic-local-tool-DEF456.js'),
    })).toThrow(/expected 7/);

    const verifier = await readFile(new URL('../../scripts/verify-package.mjs', import.meta.url), 'utf8');
    expect(verifier).toContain('const firstPartyJavaScriptEntries = findFirstPartyPackagedJavaScriptEntries(archiveFiles);');
    expect(verifier).toContain('const firstPartyJavaScriptChunks = firstPartyJavaScriptEntries.map((entry) => ({');
    expect(verifier).toContain('const retiredProductSurfaces = assertRetiredProductSurfacesAbsent({');
    expect(verifier).toContain('firstPartyJavaScriptChunks,');
    expect(verifier).toContain('retiredProductSurfaces,');
  });
});

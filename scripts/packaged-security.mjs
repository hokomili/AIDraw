import { extractFile, listPackage } from '@electron/asar';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';
import { sep } from 'node:path';

export const PACKAGED_SECURITY_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export const PACKAGED_PRELOAD_CHANNELS = [
  'aidraw:bootstrap',
  'aidraw:documents:new',
  'aidraw:documents:activate',
  'aidraw:canvas:apply',
  'aidraw:history:undo',
  'aidraw:history:redo',
  'aidraw:history:undo-agent',
  'aidraw:history:redo-agent',
  'aidraw:checkpoints:create',
  'aidraw:checkpoints:compare',
  'aidraw:checkpoints:restore',
  'aidraw:checkpoints:merge',
  'aidraw:checkpoints:delete',
  'aidraw:document-presets:list',
  'aidraw:document-presets:save',
  'aidraw:document-presets:delete',
  'aidraw:interchange-reports:list',
  'aidraw:interchange-reports:export',
  'aidraw:documents:open',
  'aidraw:documents:save',
  'aidraw:documents:save-as',
  'aidraw:documents:save-all',
  'aidraw:documents:batch-export',
  'aidraw:documents:close-all',
  'aidraw:documents:close',
  'aidraw:agents:stop',
  'aidraw:locks:acquire',
  'aidraw:locks:release',
  'aidraw:mcp:info',
  'aidraw:mcp:credentials',
  'aidraw:mcp:credential:rotate',
  'aidraw:mcp:access:revoke',
  'aidraw:engine:status',
  'aidraw:engine:start-at-login',
  'aidraw:mcp:configure-agent-client',
  'aidraw:mcp:configure-codex',
  'aidraw:jobs:resolve',
  'aidraw:generation:set-credential',
  'aidraw:generation:provider-status',
  'aidraw:generation:start',
  'aidraw:generation:accept',
  'aidraw:generation:reject',
  'aidraw:jobs:cancel',
  'aidraw:documents:import',
  'aidraw:palette:import',
  'aidraw:palette:export',
  'aidraw:pixel-links:manage',
  'aidraw:sprite-sheet:select',
  'aidraw:sprite-sheet:import',
  'aidraw:documents:export',
  'aidraw:clipboard:copy',
  'aidraw:clipboard:paste',
  'aidraw:clipboard:pixel-selection:write',
  'aidraw:clipboard:pixel-selection:read',
  'aidraw:trace:replay',
  'aidraw:editor:advisory',
  'aidraw:preferences:onion-skin:set',
  'aidraw:preferences:ordered-dither:set',
  'aidraw:preferences:sprite-symmetry:set',
  'aidraw:preferences:workspace-layout:set',
  'aidraw:renderer-diagnostics:export',
  'aidraw:renderer-recovery:test-event',
  'aidraw:event',
  'aidraw:documents:new-requested',
];

export const PACKAGED_FUSE_EXPECTATIONS = [
  ['RunAsNode', FuseV1Options.RunAsNode, FuseState.DISABLE],
  ['EnableCookieEncryption', FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  ['EnableNodeOptionsEnvironmentVariable', FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  ['EnableNodeCliInspectArguments', FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  ['EnableEmbeddedAsarIntegrityValidation', FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  ['OnlyLoadAppFromAsar', FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  ['LoadBrowserProcessSpecificV8Snapshot', FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  ['GrantFileProtocolExtraPrivileges', FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  ['WasmTrapHandlers', FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function occurrences(source, marker) {
  return source.split(marker).length - 1;
}

function markerWindow(source, marker, radius = 240) {
  const index = source.indexOf(marker);
  invariant(index >= 0, `Packaged main bundle is missing ${marker}.`);
  return source.slice(Math.max(0, index - radius), index + marker.length + radius);
}

function archivePath(path) {
  return path.slice(1).split('/').join(sep);
}

export function assertHardenedFuseWire(wire) {
  invariant(wire?.version === FuseVersion.V1, `Packaged Electron fuse wire version is ${String(wire?.version)}; expected ${FuseVersion.V1}.`);
  const numericKeys = Object.keys(wire).filter((key) => /^\d+$/.test(key));
  invariant(numericKeys.length === PACKAGED_FUSE_EXPECTATIONS.length, `Packaged Electron fuse wire exposes ${numericKeys.length} slots; expected ${PACKAGED_FUSE_EXPECTATIONS.length}.`);

  const report = {};
  for (const [name, option, expected] of PACKAGED_FUSE_EXPECTATIONS) {
    const actual = wire[option];
    invariant(actual === expected, `Packaged Electron fuse ${name} is ${String(actual)}; expected ${expected === FuseState.ENABLE ? 'enabled' : 'disabled'}.`);
    report[name] = actual === FuseState.ENABLE ? 'enabled' : 'disabled';
  }
  return report;
}

export function assertPackagedSecuritySources({ mainSource, preloadSource, rendererHtml }) {
  invariant(
    /webPreferences:\{[^{}]*sandbox:!0,contextIsolation:!0,nodeIntegration:!1,webSecurity:!0,allowRunningInsecureContent:!1[^{}]*\}/.test(mainSource),
    'Packaged BrowserWindow does not contain the exact sandbox/context-isolation security preferences.',
  );

  const permissionCheck = markerWindow(mainSource, 'setPermissionCheckHandler');
  const permissionRequest = markerWindow(mainSource, 'setPermissionRequestHandler');
  invariant(permissionCheck.includes('=>!1'), 'Packaged permission-check handler is not an unconditional denial.');
  invariant(/\(!1\)/.test(permissionRequest), 'Packaged permission-request handler is not an unconditional denial callback.');
  invariant(occurrences(mainSource, 'setWindowOpenHandler') >= 2, 'Packaged main bundle does not deny window creation at both window and global webContents boundaries.');
  invariant(occurrences(mainSource, 'action:"deny"') >= 2, 'Packaged window-open handlers are not explicit denials.');
  invariant(markerWindow(mainSource, 'will-navigate').includes('preventDefault'), 'Packaged navigation boundary does not prevent rejected navigation.');
  invariant(markerWindow(mainSource, 'will-attach-webview').includes('preventDefault'), 'Packaged webview boundary does not prevent attachment.');
  invariant(mainSource.includes('Rejected IPC from an untrusted renderer.'), 'Packaged main bundle is missing the exact sender-identity rejection.');
  invariant(mainSource.includes('Rejected IPC from an unexpected origin.'), 'Packaged main bundle is missing the exact renderer-origin rejection.');

  const cspMatch = rendererHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  invariant(cspMatch?.[1] === PACKAGED_SECURITY_CSP, 'Packaged renderer CSP differs from the hardened exact policy.');

  const requireCount = (preloadSource.match(/\brequire\s*\(/g) ?? []).length;
  const electronRequireCount = occurrences(preloadSource, 'require("electron")') + occurrences(preloadSource, "require('electron')");
  invariant(requireCount === 1 && electronRequireCount === 1, 'Packaged preload must require Electron exactly once and no other module.');
  invariant(!preloadSource.includes('node:'), 'Packaged preload contains a Node built-in import.');
  invariant(/\.contextBridge\.exposeInMainWorld\("aidraw",Object\.freeze\(/.test(preloadSource), 'Packaged preload does not expose one frozen aidraw bridge.');
  const invokeBindings = (preloadSource.match(/\.ipcRenderer\.invoke\(/g) ?? []).length;
  const eventBindings = (preloadSource.match(/\.ipcRenderer\.on\(/g) ?? []).length;
  const removeBindings = (preloadSource.match(/\.ipcRenderer\.removeListener\(/g) ?? []).length;
  invariant(invokeBindings === 62, `Packaged preload exposes ${invokeBindings} invoke bindings; expected 62.`);
  invariant(eventBindings === 2 && removeBindings === 2, `Packaged preload exposes ${eventBindings} subscriptions/${removeBindings} removals; expected 2/2.`);
  invariant(!/\.ipcRenderer\.(?:send|sendSync|sendTo|sendToHost|postMessage)\(/.test(preloadSource), 'Packaged preload exposes a forbidden generic IPC primitive.');
  const channelMatches = [...preloadSource.matchAll(/["'](aidraw:[^"']+)["']/g)].map((match) => match[1]);
  invariant(channelMatches.length === PACKAGED_PRELOAD_CHANNELS.length, `Packaged preload contains ${channelMatches.length} IPC channel literals; expected ${PACKAGED_PRELOAD_CHANNELS.length}.`);
  invariant(new Set(channelMatches).size === PACKAGED_PRELOAD_CHANNELS.length, 'Packaged preload IPC channel literals are duplicated or missing.');
  const actualChannels = new Set(channelMatches);
  const missingChannels = PACKAGED_PRELOAD_CHANNELS.filter((channel) => !actualChannels.has(channel));
  invariant(missingChannels.length === 0, `Packaged preload is missing fixed channels: ${missingChannels.join(', ')}.`);

  return {
    browserWindow: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    denials: {
      permissions: true,
      windowOpen: true,
      navigation: true,
      webviewAttach: true,
      senderIdentity: true,
      rendererOrigin: true,
    },
    csp: PACKAGED_SECURITY_CSP,
    preload: {
      frozenAidrawBridge: true,
      invokeBindings,
      eventBindings,
      removeBindings,
      fixedChannels: channelMatches.length,
      electronOnlyRequire: true,
      genericIpcAbsent: true,
    },
  };
}

export async function inspectPackagedSecurity({ executable, archive }) {
  const fuseWire = await getCurrentFuseWire(executable);
  const fuses = assertHardenedFuseWire(fuseWire);
  const archiveFiles = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  const paths = {
    main: '/.vite/build/main.js',
    preload: '/.vite/build/preload.js',
    renderer: '/.vite/renderer/main_window/index.html',
  };
  for (const [kind, path] of Object.entries(paths)) invariant(archiveFiles.includes(path), `Packaged ${kind} security artifact is missing: ${path}.`);
  const sources = {
    mainSource: extractFile(archive, archivePath(paths.main)).toString('utf8'),
    preloadSource: extractFile(archive, archivePath(paths.preload)).toString('utf8'),
    rendererHtml: extractFile(archive, archivePath(paths.renderer)).toString('utf8'),
  };
  return { fuses, ...assertPackagedSecuritySources(sources) };
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type AIDrawDesktopAPI } from '../../src/common/contracts';

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn((...args: unknown[]) => Promise.resolve(args)),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
}));

const invokeChannels = {
  bootstrap: IPC.bootstrap,
  newDocument: IPC.newDocument,
  activateDocument: IPC.activateDocument,
  applyTransaction: IPC.applyTransaction,
  undo: IPC.undo,
  redo: IPC.redo,
  undoAgent: IPC.undoAgent,
  redoAgent: IPC.redoAgent,
  createCheckpoint: IPC.checkpointCreate,
  compareCheckpoint: IPC.checkpointCompare,
  restoreCheckpoint: IPC.checkpointRestore,
  mergeCheckpoint: IPC.checkpointMerge,
  deleteCheckpoint: IPC.checkpointDelete,
  listDocumentPresets: IPC.documentPresetsList,
  saveDocumentPreset: IPC.documentPresetsSave,
  deleteDocumentPreset: IPC.documentPresetsDelete,
  listInterchangeReports: IPC.interchangeReportsList,
  exportInterchangeReport: IPC.interchangeReportExport,
  openDocuments: IPC.openDocuments,
  saveDocument: IPC.saveDocument,
  saveDocumentAs: IPC.saveDocumentAs,
  saveAllDocuments: IPC.saveAllDocuments,
  batchExportDocuments: IPC.batchExportDocuments,
  closeAllDocuments: IPC.closeAllDocuments,
  closeDocument: IPC.closeDocument,
  stopAgents: IPC.stopAgents,
  acquireHumanLock: IPC.acquireHumanLock,
  releaseHumanLock: IPC.releaseHumanLock,
  getMcpConnectionInfo: IPC.mcpInfo,
  getMcpConnection: IPC.mcpConnection,
  getEngineStatus: IPC.engineStatus,
  setEngineStartAtLogin: IPC.engineStartAtLogin,
  getAgentClientSetup: IPC.agentClientSetup,
  resolveJob: IPC.resolveJob,
  importFiles: IPC.importFiles,
  importPalette: IPC.importPalette,
  exportPalette: IPC.exportPalette,
  managePixelLink: IPC.managePixelLink,
  selectSpriteSheet: IPC.selectSpriteSheet,
  importSpriteSheet: IPC.importSpriteSheet,
  exportActiveDocument: IPC.exportActiveDocument,
  copySelection: IPC.copySelection,
  pasteClipboard: IPC.pasteClipboard,
  writePixelSelectionClipboard: IPC.writePixelSelectionClipboard,
  readPixelSelectionClipboard: IPC.readPixelSelectionClipboard,
  replayTrace: IPC.replayTrace,
  updateEditorAdvisory: IPC.editorAdvisory,
  setOnionSkinPreferences: IPC.onionSkinPreferencesSet,
  setOrderedDitherPreferences: IPC.orderedDitherPreferencesSet,
  setSpriteSymmetryPreferences: IPC.spriteSymmetryPreferencesSet,
  setWorkspaceLayoutPreferences: IPC.workspaceLayoutPreferencesSet,
  setShortcutPreferences: IPC.shortcutPreferencesSet,
  exportRendererDiagnostics: IPC.rendererDiagnosticsExport,
  injectRendererRecoveryTestEvent: IPC.rendererRecoveryTestEvent,
} as const satisfies Partial<Record<keyof AIDrawDesktopAPI, string>>;

const subscriptionMethods = ['onEvent', 'onNewDocumentRequested'] as const satisfies ReadonlyArray<keyof AIDrawDesktopAPI>;
type ExposedBridge = Record<string, (...args: unknown[]) => unknown>;

let bridge: ExposedBridge;

beforeAll(async () => {
  await import('../../src/preload/preload');
  expect(electronMock.exposeInMainWorld).toHaveBeenCalledTimes(1);
  expect(electronMock.exposeInMainWorld.mock.calls[0][0]).toBe('aidraw');
  bridge = electronMock.exposeInMainWorld.mock.calls[0][1] as ExposedBridge;
});

beforeEach(() => {
  electronMock.invoke.mockClear();
  electronMock.on.mockClear();
  electronMock.removeListener.mockClear();
});

describe('preload window.aidraw security contract', () => {
  it('keeps the preload dependency boundary free of Node and auxiliary Electron primitives', async () => {
    const source = await readFile(resolve('src/preload/preload.ts'), 'utf8');
    const staticImports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const sideEffectImports = [...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);

    expect(staticImports).toEqual(['electron', '../common/contracts']);
    expect(sideEffectImports).toEqual([]);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it('exposes one frozen, function-only, exact allowlist with no generic primitive', () => {
    const expectedKeys = [...Object.keys(invokeChannels), ...subscriptionMethods].sort();
    expect(expectedKeys).toHaveLength(56);
    expect(Object.keys(bridge).sort()).toEqual(expectedKeys);
    expect(Object.getOwnPropertySymbols(bridge)).toEqual([]);
    expect(Object.isFrozen(bridge)).toBe(true);

    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(bridge))) {
      expect(descriptor).toMatchObject({ enumerable: true, configurable: false, writable: false });
      expect(descriptor.get).toBeUndefined();
      expect(descriptor.set).toBeUndefined();
      expect(typeof descriptor.value).toBe('function');
    }

    for (const forbidden of [
      'ipcRenderer', 'contextBridge', 'invoke', 'send', 'sendSync', 'postMessage', 'on', 'once',
      'removeListener', 'require', 'process', 'Buffer', 'electron', 'shell', 'dialog', 'webContents',
    ]) {
      expect(Object.hasOwn(bridge, forbidden), forbidden).toBe(false);
    }
  });

  it('binds every command to one documented channel that renderer input cannot replace', async () => {
    const attemptedChannel = 'aidraw:undocumented:renderer-controlled';
    for (const [method, expectedChannel] of Object.entries(invokeChannels)) {
      electronMock.invoke.mockClear();
      const result = await bridge[method](attemptedChannel, { hostile: true }, ['untrusted']);

      expect(electronMock.invoke, method).toHaveBeenCalledTimes(1);
      expect(electronMock.invoke.mock.calls[0][0], method).toBe(expectedChannel);
      expect(electronMock.invoke.mock.calls[0][0], method).not.toBe(attemptedChannel);
      expect(result, method).toEqual(electronMock.invoke.mock.calls[0]);
    }
  });

  it('exposes only the current process-lifetime MCP connection and no provider or lifecycle surface', async () => {
    expect(Object.keys(bridge).filter((key) => /provider|generation|credential|rotate|revoke/i.test(key))).toEqual([]);
    await bridge.getMcpConnection();
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC.mcpConnection);
  });

  it('keeps indexed-selection PNG planning on the existing fixed clipboard channel without exposing image bytes', async () => {
    const request = {
      documentId: 'document-one', expectedDocumentRevision: 7, spriteId: 'sprite-one', frameId: 'frame-two',
      celId: 'cel-linked-source', origin: { x: -3, y: 5 },
    };
    await bridge.readPixelSelectionClipboard(request);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC.readPixelSelectionClipboard, request);
    expect(JSON.stringify(request)).not.toContain('bytes');
    electronMock.invoke.mockClear();
    const fragment = { version: 1, kind: 'pixel-selection', sourceDocumentId: 'document-one' };
    await bridge.writePixelSelectionClipboard(fragment);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC.writePixelSelectionClipboard, fragment);
  });

  it('subscribes only to the two documented events and never passes the Electron event object across the bridge', () => {
    const rawElectronEvent = { sender: 'must-not-cross-contextBridge' };

    const workspaceCallback = vi.fn();
    const unsubscribeWorkspace = bridge.onEvent(workspaceCallback) as () => void;
    expect(electronMock.on).toHaveBeenCalledTimes(1);
    expect(electronMock.on.mock.calls[0][0]).toBe(IPC.event);
    const workspaceListener = electronMock.on.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
    const workspacePayload = { type: 'document-activated', documentId: 'document-one' };
    workspaceListener(rawElectronEvent, workspacePayload);
    expect(workspaceCallback.mock.calls).toEqual([[workspacePayload]]);
    unsubscribeWorkspace();
    expect(electronMock.removeListener).toHaveBeenCalledWith(IPC.event, workspaceListener);

    electronMock.on.mockClear();
    electronMock.removeListener.mockClear();
    const newDocumentCallback = vi.fn();
    const unsubscribeNewDocument = bridge.onNewDocumentRequested(newDocumentCallback) as () => void;
    expect(electronMock.on).toHaveBeenCalledTimes(1);
    expect(electronMock.on.mock.calls[0][0]).toBe(IPC.newDocumentRequested);
    const newDocumentListener = electronMock.on.mock.calls[0][1] as (event: unknown, kind: unknown) => void;
    newDocumentListener(rawElectronEvent, 'sprite');
    expect(newDocumentCallback.mock.calls).toEqual([['sprite']]);
    unsubscribeNewDocument();
    expect(electronMock.removeListener).toHaveBeenCalledWith(IPC.newDocumentRequested, newDocumentListener);
  });
});

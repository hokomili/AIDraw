import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AIDrawDesktopAPI, type WorkspaceEvent } from '../common/contracts';

const api: AIDrawDesktopAPI = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  newDocument: (options) => ipcRenderer.invoke(IPC.newDocument, options),
  activateDocument: (documentId) => ipcRenderer.invoke(IPC.activateDocument, documentId),
  applyTransaction: (transaction) => ipcRenderer.invoke(IPC.applyTransaction, transaction),
  undo: (documentId) => ipcRenderer.invoke(IPC.undo, documentId),
  redo: (documentId) => ipcRenderer.invoke(IPC.redo, documentId),
  undoAgent: (documentId, actorId) => ipcRenderer.invoke(IPC.undoAgent, documentId, actorId),
  redoAgent: (documentId, actorId) => ipcRenderer.invoke(IPC.redoAgent, documentId, actorId),
  createCheckpoint: (documentId, name) => ipcRenderer.invoke(IPC.checkpointCreate, documentId, name),
  compareCheckpoint: (documentId, checkpointId) => ipcRenderer.invoke(IPC.checkpointCompare, documentId, checkpointId),
  restoreCheckpoint: (documentId, checkpointId) => ipcRenderer.invoke(IPC.checkpointRestore, documentId, checkpointId),
  mergeCheckpoint: (documentId, checkpointId, sourceIds) => ipcRenderer.invoke(IPC.checkpointMerge, documentId, checkpointId, sourceIds),
  deleteCheckpoint: (documentId, checkpointId) => ipcRenderer.invoke(IPC.checkpointDelete, documentId, checkpointId),
  listDocumentPresets: () => ipcRenderer.invoke(IPC.documentPresetsList),
  saveDocumentPreset: (preset) => ipcRenderer.invoke(IPC.documentPresetsSave, preset),
  deleteDocumentPreset: (presetId) => ipcRenderer.invoke(IPC.documentPresetsDelete, presetId),
  listInterchangeReports: (documentId) => ipcRenderer.invoke(IPC.interchangeReportsList, documentId),
  exportInterchangeReport: (reportId) => ipcRenderer.invoke(IPC.interchangeReportExport, reportId),
  openDocuments: () => ipcRenderer.invoke(IPC.openDocuments),
  saveDocument: (documentId) => ipcRenderer.invoke(IPC.saveDocument, documentId),
  saveDocumentAs: (documentId) => ipcRenderer.invoke(IPC.saveDocumentAs, documentId),
  saveAllDocuments: () => ipcRenderer.invoke(IPC.saveAllDocuments),
  batchExportDocuments: (format, options) => ipcRenderer.invoke(IPC.batchExportDocuments, format, options),
  closeAllDocuments: () => ipcRenderer.invoke(IPC.closeAllDocuments),
  closeDocument: (documentId, force) => ipcRenderer.invoke(IPC.closeDocument, documentId, force),
  stopAgents: (documentId) => ipcRenderer.invoke(IPC.stopAgents, documentId),
  acquireHumanLock: (request) => ipcRenderer.invoke(IPC.acquireHumanLock, request),
  releaseHumanLock: (lockId) => ipcRenderer.invoke(IPC.releaseHumanLock, lockId),
  getMcpConnectionInfo: () => ipcRenderer.invoke(IPC.mcpInfo),
  getMcpCredentials: () => ipcRenderer.invoke(IPC.mcpCredentials),
  rotateMcpCredential: () => ipcRenderer.invoke(IPC.mcpCredentialRotate),
  revokeMcpAccess: () => ipcRenderer.invoke(IPC.mcpAccessRevoke),
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  setEngineStartAtLogin: (enabled) => ipcRenderer.invoke(IPC.engineStartAtLogin, enabled),
  configureAgentClient: (clientId) => ipcRenderer.invoke(IPC.configureAgentClient, clientId),
  configureCodex: () => ipcRenderer.invoke(IPC.configureCodex),
  resolveJob: (jobId, decision) => ipcRenderer.invoke(IPC.resolveJob, jobId, decision),
  setProviderCredential: (provider, value) => ipcRenderer.invoke(IPC.setProviderCredential, provider, value),
  getProviderStatus: () => ipcRenderer.invoke(IPC.getProviderStatus),
  generationStart: (request) => ipcRenderer.invoke(IPC.generationStart, request),
  generationAccept: (jobId, outputId) => ipcRenderer.invoke(IPC.generationAccept, jobId, outputId),
  generationReject: (jobId, outputId) => ipcRenderer.invoke(IPC.generationReject, jobId, outputId),
  jobCancel: (jobId) => ipcRenderer.invoke(IPC.jobCancel, jobId),
  importFiles: (pixelMode) => ipcRenderer.invoke(IPC.importFiles, pixelMode),
  importPalette: (documentId, mode) => ipcRenderer.invoke(IPC.importPalette, documentId, mode),
  exportPalette: (documentId, format) => ipcRenderer.invoke(IPC.exportPalette, documentId, format),
  managePixelLink: (documentId, linkId, action) => ipcRenderer.invoke(IPC.managePixelLink, documentId, linkId, action),
  selectSpriteSheet: () => ipcRenderer.invoke(IPC.selectSpriteSheet),
  importSpriteSheet: (selectionId, options) => ipcRenderer.invoke(IPC.importSpriteSheet, selectionId, options),
  exportActiveDocument: (format, options) => ipcRenderer.invoke(IPC.exportActiveDocument, format, options),
  copySelection: (objectIds) => ipcRenderer.invoke(IPC.copySelection, objectIds),
  pasteClipboard: () => ipcRenderer.invoke(IPC.pasteClipboard),
  writePixelSelectionClipboard: (fragment) => ipcRenderer.invoke(IPC.writePixelSelectionClipboard, fragment),
  readPixelSelectionClipboard: () => ipcRenderer.invoke(IPC.readPixelSelectionClipboard),
  replayTrace: (documentId, transactionId) => ipcRenderer.invoke(IPC.replayTrace, documentId, transactionId),
  updateEditorAdvisory: (state) => ipcRenderer.invoke(IPC.editorAdvisory, state),
  setOnionSkinPreferences: (preferences) => ipcRenderer.invoke(IPC.onionSkinPreferencesSet, preferences),
  setOrderedDitherPreferences: (preferences) => ipcRenderer.invoke(IPC.orderedDitherPreferencesSet, preferences),
  setSpriteSymmetryPreferences: (preferences) => ipcRenderer.invoke(IPC.spriteSymmetryPreferencesSet, preferences),
  setWorkspaceLayoutPreferences: (preferences) => ipcRenderer.invoke(IPC.workspaceLayoutPreferencesSet, preferences),
  exportRendererDiagnostics: (detail) => ipcRenderer.invoke(IPC.rendererDiagnosticsExport, detail),
  injectRendererRecoveryTestEvent: () => ipcRenderer.invoke(IPC.rendererRecoveryTestEvent),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceEvent) => callback(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
  onNewDocumentRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, kind?: Parameters<typeof callback>[0]) => callback(kind);
    ipcRenderer.on(IPC.newDocumentRequested, listener);
    return () => ipcRenderer.removeListener(IPC.newDocumentRequested, listener);
  },
};

contextBridge.exposeInMainWorld('aidraw', Object.freeze(api));

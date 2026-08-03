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
  openDocuments: () => ipcRenderer.invoke(IPC.openDocuments),
  saveDocument: (documentId) => ipcRenderer.invoke(IPC.saveDocument, documentId),
  saveDocumentAs: (documentId) => ipcRenderer.invoke(IPC.saveDocumentAs, documentId),
  closeDocument: (documentId, force) => ipcRenderer.invoke(IPC.closeDocument, documentId, force),
  stopAgents: (documentId) => ipcRenderer.invoke(IPC.stopAgents, documentId),
  acquireHumanLock: (request) => ipcRenderer.invoke(IPC.acquireHumanLock, request),
  releaseHumanLock: (lockId) => ipcRenderer.invoke(IPC.releaseHumanLock, lockId),
  getMcpConnectionInfo: () => ipcRenderer.invoke(IPC.mcpInfo),
  getMcpCredentials: () => ipcRenderer.invoke(IPC.mcpCredentials),
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  setEngineStartAtLogin: (enabled) => ipcRenderer.invoke(IPC.engineStartAtLogin, enabled),
  configureCodex: () => ipcRenderer.invoke(IPC.configureCodex),
  resolveJob: (jobId, decision) => ipcRenderer.invoke(IPC.resolveJob, jobId, decision),
  setProviderCredential: (provider, value) => ipcRenderer.invoke(IPC.setProviderCredential, provider, value),
  getProviderStatus: () => ipcRenderer.invoke(IPC.getProviderStatus),
  generationStart: (request) => ipcRenderer.invoke(IPC.generationStart, request),
  generationAccept: (jobId, outputId) => ipcRenderer.invoke(IPC.generationAccept, jobId, outputId),
  jobCancel: (jobId) => ipcRenderer.invoke(IPC.jobCancel, jobId),
  importFiles: (pixelMode) => ipcRenderer.invoke(IPC.importFiles, pixelMode),
  exportActiveDocument: (format, options) => ipcRenderer.invoke(IPC.exportActiveDocument, format, options),
  copySelection: (objectIds) => ipcRenderer.invoke(IPC.copySelection, objectIds),
  pasteClipboard: () => ipcRenderer.invoke(IPC.pasteClipboard),
  replayTrace: (documentId, transactionId) => ipcRenderer.invoke(IPC.replayTrace, documentId, transactionId),
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

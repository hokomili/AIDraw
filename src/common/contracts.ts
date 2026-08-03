import type {
  AIDrawDocument,
  Actor,
  AsyncJob,
  CanvasTransaction,
  Id,
} from '@aidraw/core';
import type { GenerationProvider, GenerationRequest } from './generation';

export type NewDocumentKind = 'illustration' | 'sprite' | 'tilemap' | 'project';
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'psd' | 'gif' | 'apng' | 'sprite-sheet' | 'tiled-json' | 'tiled-xml';

export interface ExportOptions {
  /** Integer nearest-neighbor multiplier used by scalable pixel exports. */
  scale?: number;
}

export interface NewDocumentOptions {
  kind: NewDocumentKind;
  name?: string;
  width?: number;
  height?: number;
  background?: string | null;
  orientation?: 'orthogonal' | 'isometric';
  infinite?: boolean;
  tileWidth?: number;
  tileHeight?: number;
}

export interface DocumentTab {
  id: Id;
  name: string;
  kind: AIDrawDocument['kind'];
  dirty: boolean;
  revision: number;
  filePath?: string;
  activityState?: 'active' | 'complete' | 'conflict' | 'approval';
  activityActor?: Actor;
}

export interface AgentPresence {
  actor: Actor;
  documentId?: Id;
  cursor?: { x: number; y: number; tool?: string };
  queueDepth: number;
  status: 'idle' | 'working' | 'waiting' | 'disconnected';
}

export interface McpConnectionInfo {
  running: boolean;
  url?: string;
  port?: number;
  tokenHint?: string;
  sessions: AgentPresence[];
}

export interface EngineStatus {
  running: boolean;
  uiAttached: boolean;
  startsAtLogin: boolean;
  startAtLoginSupported: boolean;
  mode: 'headless' | 'interactive';
}

export interface WorkspaceSnapshot {
  documents: DocumentTab[];
  activeDocumentId?: Id;
  activeDocument?: AIDrawDocument;
  jobs: AsyncJob[];
  mcp: McpConnectionInfo;
  canUndo: boolean;
  canRedo: boolean;
  agentHistories: Array<{ actor: Actor; canUndo: boolean; canRedo: boolean }>;
}

export interface ApplyTransactionResponse {
  status: 'committed' | 'duplicate' | 'conflict' | 'busy' | 'locked' | 'cancelled';
  revision?: number;
  transactionId?: Id;
  message?: string;
  conflict?: {
    entityId?: Id;
    expectedRevision?: number;
    actualRevision?: number;
    retryable: boolean;
  };
}

export interface TransactionTraceEntry {
  version: 1;
  documentId: Id;
  revision: number;
  recordedAt: string;
  outcome: 'committed' | 'partial' | 'undo' | 'redo';
  transaction: CanvasTransaction;
}

export interface OpenResult {
  opened: string[];
  warnings: string[];
}

export interface SaveResult {
  saved: boolean;
  filePath?: string;
  cancelled?: boolean;
}

export type WorkspaceEvent =
  | { type: 'workspace'; snapshot: WorkspaceSnapshot }
  | {
      type: 'playback';
      documentId: Id;
      transactionId: Id;
      actor: Actor;
      progress: number;
      label: string;
      lane: number;
      operations: CanvasTransaction['operations'];
      /** Full committed operations, sent once when a durable trace replay begins. */
      sourceOperations?: CanvasTransaction['operations'];
      replay?: boolean;
      status: 'playing' | 'completed' | 'cancelled' | 'failed';
    }
  | { type: 'cursor'; presence: AgentPresence }
  | { type: 'job'; job: AsyncJob };

export interface AIDrawDesktopAPI {
  bootstrap(): Promise<WorkspaceSnapshot>;
  newDocument(options: NewDocumentOptions): Promise<WorkspaceSnapshot>;
  activateDocument(documentId: Id): Promise<WorkspaceSnapshot>;
  applyTransaction(transaction: CanvasTransaction): Promise<ApplyTransactionResponse>;
  undo(documentId?: Id): Promise<ApplyTransactionResponse>;
  redo(documentId?: Id): Promise<ApplyTransactionResponse>;
  undoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse>;
  redoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse>;
  openDocuments(): Promise<OpenResult>;
  saveDocument(documentId?: Id): Promise<SaveResult>;
  saveDocumentAs(documentId?: Id): Promise<SaveResult>;
  closeDocument(documentId: Id, force?: boolean): Promise<{ closed: boolean; reason?: string }>;
  stopAgents(documentId?: Id): Promise<number>;
  acquireHumanLock(lock: HumanLockRequest): Promise<{ acquired: boolean; lockId?: Id; reason?: string }>;
  releaseHumanLock(lockId: Id): Promise<void>;
  getMcpConnectionInfo(): Promise<McpConnectionInfo>;
  getMcpCredentials(): Promise<{ url?: string; token: string }>;
  getEngineStatus(): Promise<EngineStatus>;
  setEngineStartAtLogin(enabled: boolean): Promise<EngineStatus>;
  configureCodex(): Promise<{ status: 'configured' | 'cancelled' | 'manual'; message: string }>;
  resolveJob(jobId: Id, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): Promise<AsyncJob | undefined>;
  setProviderCredential(provider: Exclude<GenerationProvider, 'comfyui'>, value: string): Promise<{ saved: boolean }>;
  getProviderStatus(): Promise<Record<GenerationProvider, { configured: boolean }>>;
  generationStart(request: GenerationRequest): Promise<{ jobId: Id }>;
  generationAccept(jobId: Id, outputId: Id): Promise<{ accepted: boolean; message?: string }>;
  jobCancel(jobId: Id): Promise<AsyncJob | undefined>;
  importFiles(pixelMode?: boolean): Promise<{ imported: number; warnings: string[] }>;
  exportActiveDocument(format: ExportFormat, options?: ExportOptions): Promise<{ exported: boolean; filePath?: string; warnings: string[]; cancelled?: boolean }>;
  copySelection(objectIds: Id[]): Promise<{ copied: boolean; kind?: string }>;
  pasteClipboard(): Promise<ApplyTransactionResponse>;
  replayTrace(documentId: Id, transactionId: Id): Promise<{ replaying: boolean; reason?: string }>;
  onEvent(callback: (event: WorkspaceEvent) => void): () => void;
  onNewDocumentRequested(callback: (kind?: NewDocumentKind) => void): () => void;
}

export interface HumanLockRequest {
  documentId: Id;
  objectIds?: Id[];
  region?: { kind: 'pixel' | 'tile'; assetId: Id; x: number; y: number; width: number; height: number };
}

export const IPC = {
  bootstrap: 'aidraw:bootstrap',
  newDocument: 'aidraw:documents:new',
  activateDocument: 'aidraw:documents:activate',
  applyTransaction: 'aidraw:canvas:apply',
  undo: 'aidraw:history:undo',
  redo: 'aidraw:history:redo',
  undoAgent: 'aidraw:history:undo-agent',
  redoAgent: 'aidraw:history:redo-agent',
  openDocuments: 'aidraw:documents:open',
  saveDocument: 'aidraw:documents:save',
  saveDocumentAs: 'aidraw:documents:save-as',
  closeDocument: 'aidraw:documents:close',
  stopAgents: 'aidraw:agents:stop',
  acquireHumanLock: 'aidraw:locks:acquire',
  releaseHumanLock: 'aidraw:locks:release',
  mcpInfo: 'aidraw:mcp:info',
  mcpCredentials: 'aidraw:mcp:credentials',
  engineStatus: 'aidraw:engine:status',
  engineStartAtLogin: 'aidraw:engine:start-at-login',
  configureCodex: 'aidraw:mcp:configure-codex',
  resolveJob: 'aidraw:jobs:resolve',
  setProviderCredential: 'aidraw:generation:set-credential',
  getProviderStatus: 'aidraw:generation:provider-status',
  generationStart: 'aidraw:generation:start',
  generationAccept: 'aidraw:generation:accept',
  jobCancel: 'aidraw:jobs:cancel',
  importFiles: 'aidraw:documents:import',
  exportActiveDocument: 'aidraw:documents:export',
  copySelection: 'aidraw:clipboard:copy',
  pasteClipboard: 'aidraw:clipboard:paste',
  replayTrace: 'aidraw:trace:replay',
  event: 'aidraw:event',
  newDocumentRequested: 'aidraw:documents:new-requested',
} as const;

declare global {
  interface Window {
    aidraw: AIDrawDesktopAPI;
  }
}

import type {
  AIDrawDocument,
  Actor,
  AsyncJob,
  CanvasTransaction,
  Id,
  NewDocumentOptionsInput,
} from '@aidraw/core';
import type { GenerationAcceptanceResult, GenerationProvider, GenerationProviderStatus, GenerationRequest } from './generation';
import type { CheckpointMergeCandidate } from './checkpoint-merge';
import type { PaletteFileFormat, PaletteImportMode } from './palette-interchange';
import type { SpriteSheetSliceOptions } from './sprite-sheet';
import type { AgentClientId, AgentClientSetupResult } from './agent-clients';
import type { DesktopPlatformInfo } from './platform';
import type { InterchangeFidelityEntry } from './interchange-fidelity';
import type { PixelSelectionFragment } from './document-fragment';
import type { OnionSkinPreferences } from './onion-skin';
import type { OrderedDitherPreferences } from './ordered-dither-preferences';
import type { SpriteSymmetryPreferences } from './sprite-symmetry';
import type { WorkspaceLayoutPreferences } from './workspace-layout';
import type { ShortcutPreferences } from './shortcut-preferences';

export type NewDocumentKind = 'illustration' | 'sprite' | 'tilemap' | 'project';
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'psd' | 'gif' | 'apng' | 'sprite-sheet' | 'tiled-json' | 'tiled-xml';

export interface ExportOptions {
  /** Integer nearest-neighbor multiplier used by scalable pixel exports. */
  scale?: number;
  /** Optional named pixel-animation tag to export instead of the full timeline. */
  animationTagId?: Id;
  /** Batch/CLI-friendly exact tag name, resolved independently in each sprite. */
  animationTagName?: string;
  /** Optional named palette cycle exported as one complete GIF/APNG period. */
  paletteCycleId?: Id;
  /** Exact sprite frame used as the immutable source for a palette-cycle export. */
  paletteCycleFrameId?: Id;
}

export type NewDocumentOptions = NewDocumentOptionsInput;

export interface DocumentPreset {
  id: Id;
  name: string;
  kind: NewDocumentKind;
  options: NewDocumentOptions;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentPresetInput {
  id?: Id;
  name: string;
  options: NewDocumentOptions;
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
  activityCursor?: { x: number; y: number; tool?: string };
}

export interface AgentPresence {
  actor: Actor;
  documentId?: Id;
  cursor?: { x: number; y: number; tool?: string };
  queueDepth: number;
  status: 'idle' | 'working' | 'waiting' | 'disconnected';
}

export interface HumanOccupancy {
  documentId: Id;
  active: boolean;
  locks: Array<{
    objectIds?: Id[];
    region?: HumanLockRequest['region'];
    acquiredAt: string;
  }>;
  retryGuidance: string;
}

export interface EditorAdvisoryInput {
  documentId?: Id;
  tool?: string;
  selectedEntityIds?: Id[];
  zoom?: number;
  viewport?: { x: number; y: number; width: number; height: number };
  animation?: {
    activeAssetId?: Id;
    activeFrameId?: Id;
    activeTagId?: Id;
    illustrationTimeMs?: number;
    playing: boolean;
    onionSkin: boolean;
    direction: 'forward' | 'reverse' | 'ping-pong';
  };
}

export interface EditorAdvisoryState extends EditorAdvisoryInput {
  advisory: true;
  attached: boolean;
  updatedAt: string;
}

export interface McpConnectionInfo {
  running: boolean;
  access?: 'active' | 'revoked' | 'unavailable';
  url?: string;
  port?: number;
  tokenHint?: string;
  sessions: AgentPresence[];
}

export interface McpCredentialLifecycleResult {
  action: 'rotate' | 'revoke';
  status: 'completed' | 'cancelled';
  access: 'active' | 'revoked' | 'unavailable';
  sessionsTerminated: number;
  clientConfigurationsStale?: true;
  warning?: true;
  message: string;
}

export type PixelSelectionClipboardReadResult =
  | { status: 'valid'; fragment: PixelSelectionFragment }
  | { status: 'absent'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'incompatible'; message: string };

export interface EngineStatus {
  running: boolean;
  uiAttached: boolean;
  startsAtLogin: boolean;
  startAtLoginSupported: boolean;
  mode: 'headless' | 'interactive';
  platform: DesktopPlatformInfo;
  secureStorageAvailable: boolean;
}

export interface WorkspaceSnapshot {
  /** Monotonic canonical ordering for renderer hydration and IPC response races. */
  workspaceRevision: number;
  /** Bounded startup diagnostics for repairs applied while recovering local journals. */
  recoveryWarnings?: string[];
  documents: DocumentTab[];
  activeDocumentId?: Id;
  activeDocument?: AIDrawDocument;
  jobs: AsyncJob[];
  mcp: McpConnectionInfo;
  canUndo: boolean;
  canRedo: boolean;
  agentHistories: Array<{ actor: Actor; canUndo: boolean; canRedo: boolean }>;
  checkpoints: DocumentCheckpointSummary[];
}

export interface EditorBootstrapSnapshot extends WorkspaceSnapshot {
  /** Main-owned human-local preferences, hydrated before the editor canvas mounts. */
  onionSkinPreferences: OnionSkinPreferences;
  orderedDitherPreferences: OrderedDitherPreferences;
  symmetryPreferences: SpriteSymmetryPreferences;
  workspaceLayoutPreferences: WorkspaceLayoutPreferences;
  shortcutPreferences: ShortcutPreferences;
}

export type OnionSkinPreferenceSaveResult =
  | { saved: true; preferences: OnionSkinPreferences }
  | { saved: false; message: string };

export type OrderedDitherPreferenceSaveResult =
  | { saved: true; preferences: OrderedDitherPreferences }
  | { saved: false; message: string };

export type SpriteSymmetryPreferenceSaveResult =
  | { saved: true; preferences: SpriteSymmetryPreferences }
  | { saved: false; message: string };

export type WorkspaceLayoutPreferenceSaveResult =
  | { saved: true; preferences: WorkspaceLayoutPreferences }
  | { saved: false; message: string };

export type ShortcutPreferenceSaveResult =
  | { saved: true; preferences: ShortcutPreferences }
  | { saved: false; message: string };

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

export interface PaletteImportResult {
  imported: boolean;
  cancelled?: boolean;
  filePath?: string;
  format?: PaletteFileFormat;
  paletteName?: string;
  added: number;
  updated: number;
  skipped: number;
  warnings: string[];
  reportId?: Id;
}

export interface PaletteExportResult {
  exported: boolean;
  cancelled?: boolean;
  filePath?: string;
  warnings: string[];
  reportId?: Id;
}

export type PixelLinkAction = 'embed' | 'extract' | 'relink';

export interface PixelLinkActionResult {
  updated: boolean;
  cancelled?: boolean;
  filePath?: string;
  message?: string;
}

export interface SpriteSheetSelection {
  id: Id;
  name: string;
  width: number;
  height: number;
  previewDataUrl: string;
  suggestedFrameWidth: number;
  suggestedFrameHeight: number;
  expiresAt: string;
}

export interface SpriteSheetImportResult {
  imported: boolean;
  cancelled?: boolean;
  documentId?: Id;
  warnings: string[];
  reportId?: Id;
}

export interface BatchDocumentItemResult {
  documentId: Id;
  name: string;
  status: 'saved' | 'exported' | 'closed' | 'skipped' | 'failed';
  filePath?: string;
  warnings?: string[];
  error?: string;
  reportId?: Id;
}

export interface BatchDocumentResult {
  cancelled?: boolean;
  items: BatchDocumentItemResult[];
}

export interface DocumentCheckpointSummary {
  id: Id;
  documentId: Id;
  name: string;
  createdAt: string;
  createdBy: Actor;
  sourceRevision: number;
  kind: 'manual' | 'automatic';
}

export interface DocumentCheckpointRecord extends DocumentCheckpointSummary {
  document: AIDrawDocument;
}

export interface InterchangeReport {
  id: Id;
  kind: 'import' | 'export';
  status: 'completed' | 'failed';
  actor: Actor;
  createdAt: string;
  documentIds: Id[];
  documentNames: string[];
  format: string;
  sourcePaths: string[];
  destinationPaths: string[];
  warnings: string[];
  rasterized: string[];
  fidelity: InterchangeFidelityEntry[];
  error?: string;
}

export type InterchangeReportInput = Omit<InterchangeReport, 'id' | 'createdAt' | 'fidelity'> & { fidelity?: InterchangeFidelityEntry[] };

export interface CheckpointComparisonResult {
  checkpoint: DocumentCheckpointSummary;
  current: { revision: number; width: number; height: number; dataUrl: string };
  saved: { revision: number; width: number; height: number; dataUrl: string };
  candidates: CheckpointMergeCandidate[];
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
  | { type: 'job'; job: AsyncJob }
  | { type: 'interchange-report'; report: InterchangeReport };

export interface AIDrawDesktopAPI {
  bootstrap(): Promise<EditorBootstrapSnapshot>;
  newDocument(options: NewDocumentOptions): Promise<WorkspaceSnapshot>;
  activateDocument(documentId: Id): Promise<WorkspaceSnapshot>;
  applyTransaction(transaction: CanvasTransaction): Promise<ApplyTransactionResponse>;
  undo(documentId?: Id): Promise<ApplyTransactionResponse>;
  redo(documentId?: Id): Promise<ApplyTransactionResponse>;
  undoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse>;
  redoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse>;
  createCheckpoint(documentId: Id, name: string): Promise<DocumentCheckpointSummary>;
  compareCheckpoint(documentId: Id, checkpointId: Id): Promise<CheckpointComparisonResult>;
  restoreCheckpoint(documentId: Id, checkpointId: Id): Promise<ApplyTransactionResponse>;
  mergeCheckpoint(documentId: Id, checkpointId: Id, sourceIds: Id[]): Promise<ApplyTransactionResponse>;
  deleteCheckpoint(documentId: Id, checkpointId: Id): Promise<{ deleted: boolean; message?: string }>;
  listDocumentPresets(): Promise<DocumentPreset[]>;
  saveDocumentPreset(preset: DocumentPresetInput): Promise<DocumentPreset>;
  deleteDocumentPreset(presetId: Id): Promise<{ deleted: boolean }>;
  listInterchangeReports(documentId?: Id): Promise<InterchangeReport[]>;
  exportInterchangeReport(reportId: Id): Promise<{ exported: boolean; filePath?: string; cancelled?: boolean }>;
  openDocuments(): Promise<OpenResult>;
  saveDocument(documentId?: Id): Promise<SaveResult>;
  saveDocumentAs(documentId?: Id): Promise<SaveResult>;
  saveAllDocuments(): Promise<BatchDocumentResult>;
  batchExportDocuments(format: Extract<ExportFormat, 'png' | 'jpeg' | 'webp' | 'gif' | 'apng' | 'sprite-sheet'>, options?: ExportOptions): Promise<BatchDocumentResult>;
  closeAllDocuments(): Promise<BatchDocumentResult>;
  closeDocument(documentId: Id, force?: boolean): Promise<{ closed: boolean; reason?: string }>;
  stopAgents(documentId?: Id): Promise<number>;
  acquireHumanLock(lock: HumanLockRequest): Promise<{ acquired: boolean; lockId?: Id; reason?: string }>;
  releaseHumanLock(lockId: Id): Promise<void>;
  getMcpConnectionInfo(): Promise<McpConnectionInfo>;
  getMcpCredentials(): Promise<{ url?: string; token: string }>;
  rotateMcpCredential(): Promise<McpCredentialLifecycleResult>;
  revokeMcpAccess(): Promise<McpCredentialLifecycleResult>;
  getEngineStatus(): Promise<EngineStatus>;
  setEngineStartAtLogin(enabled: boolean): Promise<EngineStatus>;
  configureAgentClient(clientId: AgentClientId): Promise<AgentClientSetupResult>;
  /** Backwards-compatible alias for older preload consumers. */
  configureCodex(): Promise<AgentClientSetupResult>;
  resolveJob(jobId: Id, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): Promise<AsyncJob | undefined>;
  setProviderCredential(provider: Exclude<GenerationProvider, 'comfyui'>, value: string): Promise<{ saved: boolean }>;
  getProviderStatus(): Promise<GenerationProviderStatus>;
  generationStart(request: GenerationRequest): Promise<{ jobId: Id }>;
  generationAccept(jobId: Id, outputId: Id): Promise<GenerationAcceptanceResult>;
  generationReject(jobId: Id, outputId: Id): Promise<{ rejected: boolean; message?: string }>;
  jobCancel(jobId: Id): Promise<AsyncJob | undefined>;
  importFiles(pixelMode?: boolean): Promise<{ imported: number; warnings: string[]; reportIds: Id[] }>;
  importPalette(documentId: Id, mode: PaletteImportMode): Promise<PaletteImportResult>;
  exportPalette(documentId: Id, format: PaletteFileFormat): Promise<PaletteExportResult>;
  managePixelLink(documentId: Id, linkId: Id, action: PixelLinkAction): Promise<PixelLinkActionResult>;
  selectSpriteSheet(): Promise<{ selection?: SpriteSheetSelection; cancelled?: boolean }>;
  importSpriteSheet(selectionId: Id, options: SpriteSheetSliceOptions): Promise<SpriteSheetImportResult>;
  exportActiveDocument(format: ExportFormat, options?: ExportOptions): Promise<{ exported: boolean; filePath?: string; warnings: string[]; reportId?: Id; cancelled?: boolean }>;
  copySelection(objectIds: Id[]): Promise<{ copied: boolean; kind?: string }>;
  pasteClipboard(): Promise<ApplyTransactionResponse>;
  writePixelSelectionClipboard(fragment: PixelSelectionFragment): Promise<{ copied: true }>;
  readPixelSelectionClipboard(): Promise<PixelSelectionClipboardReadResult>;
  replayTrace(documentId: Id, transactionId: Id): Promise<{ replaying: boolean; reason?: string }>;
  updateEditorAdvisory(state: EditorAdvisoryInput): Promise<void>;
  setOnionSkinPreferences(preferences: OnionSkinPreferences): Promise<OnionSkinPreferenceSaveResult>;
  setOrderedDitherPreferences(preferences: OrderedDitherPreferences): Promise<OrderedDitherPreferenceSaveResult>;
  setSpriteSymmetryPreferences(preferences: SpriteSymmetryPreferences): Promise<SpriteSymmetryPreferenceSaveResult>;
  setWorkspaceLayoutPreferences(preferences: WorkspaceLayoutPreferences): Promise<WorkspaceLayoutPreferenceSaveResult>;
  setShortcutPreferences(preferences: ShortcutPreferences): Promise<ShortcutPreferenceSaveResult>;
  exportRendererDiagnostics(detail: { message: string; stack?: string; componentStack?: string; userAgent?: string }): Promise<{ saved: boolean; filePath?: string; cancelled?: boolean }>;
  /** Available only to the exact isolated packaged renderer-recovery test profile. */
  injectRendererRecoveryTestEvent(): Promise<{ injected: boolean; byteLength: number }>;
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
  checkpointCreate: 'aidraw:checkpoints:create',
  checkpointCompare: 'aidraw:checkpoints:compare',
  checkpointRestore: 'aidraw:checkpoints:restore',
  checkpointMerge: 'aidraw:checkpoints:merge',
  checkpointDelete: 'aidraw:checkpoints:delete',
  documentPresetsList: 'aidraw:document-presets:list',
  documentPresetsSave: 'aidraw:document-presets:save',
  documentPresetsDelete: 'aidraw:document-presets:delete',
  interchangeReportsList: 'aidraw:interchange-reports:list',
  interchangeReportExport: 'aidraw:interchange-reports:export',
  openDocuments: 'aidraw:documents:open',
  saveDocument: 'aidraw:documents:save',
  saveDocumentAs: 'aidraw:documents:save-as',
  saveAllDocuments: 'aidraw:documents:save-all',
  batchExportDocuments: 'aidraw:documents:batch-export',
  closeAllDocuments: 'aidraw:documents:close-all',
  closeDocument: 'aidraw:documents:close',
  stopAgents: 'aidraw:agents:stop',
  acquireHumanLock: 'aidraw:locks:acquire',
  releaseHumanLock: 'aidraw:locks:release',
  mcpInfo: 'aidraw:mcp:info',
  mcpCredentials: 'aidraw:mcp:credentials',
  mcpCredentialRotate: 'aidraw:mcp:credential:rotate',
  mcpAccessRevoke: 'aidraw:mcp:access:revoke',
  engineStatus: 'aidraw:engine:status',
  engineStartAtLogin: 'aidraw:engine:start-at-login',
  configureAgentClient: 'aidraw:mcp:configure-agent-client',
  configureCodex: 'aidraw:mcp:configure-codex',
  resolveJob: 'aidraw:jobs:resolve',
  setProviderCredential: 'aidraw:generation:set-credential',
  getProviderStatus: 'aidraw:generation:provider-status',
  generationStart: 'aidraw:generation:start',
  generationAccept: 'aidraw:generation:accept',
  generationReject: 'aidraw:generation:reject',
  jobCancel: 'aidraw:jobs:cancel',
  importFiles: 'aidraw:documents:import',
  importPalette: 'aidraw:palette:import',
  exportPalette: 'aidraw:palette:export',
  managePixelLink: 'aidraw:pixel-links:manage',
  selectSpriteSheet: 'aidraw:sprite-sheet:select',
  importSpriteSheet: 'aidraw:sprite-sheet:import',
  exportActiveDocument: 'aidraw:documents:export',
  copySelection: 'aidraw:clipboard:copy',
  pasteClipboard: 'aidraw:clipboard:paste',
  writePixelSelectionClipboard: 'aidraw:clipboard:pixel-selection:write',
  readPixelSelectionClipboard: 'aidraw:clipboard:pixel-selection:read',
  replayTrace: 'aidraw:trace:replay',
  editorAdvisory: 'aidraw:editor:advisory',
  onionSkinPreferencesSet: 'aidraw:preferences:onion-skin:set',
  orderedDitherPreferencesSet: 'aidraw:preferences:ordered-dither:set',
  spriteSymmetryPreferencesSet: 'aidraw:preferences:sprite-symmetry:set',
  workspaceLayoutPreferencesSet: 'aidraw:preferences:workspace-layout:set',
  shortcutPreferencesSet: 'aidraw:preferences:shortcuts:set',
  rendererDiagnosticsExport: 'aidraw:renderer-diagnostics:export',
  rendererRecoveryTestEvent: 'aidraw:renderer-recovery:test-event',
  event: 'aidraw:event',
  newDocumentRequested: 'aidraw:documents:new-requested',
} as const;

declare global {
  interface Window {
    aidraw: AIDrawDesktopAPI;
  }
}

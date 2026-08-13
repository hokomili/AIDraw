import { EventEmitter } from 'node:events';
import {
  CanvasTransactionSchema,
  HUMAN_ACTOR,
  NewDocumentOptionsSchema,
  TransactionConflictError,
  applyTransaction,
  createDocument,
  createId,
  nowIso,
  rebaseTransactionExpectedRevisions,
  type AIDrawDocument,
  type Actor,
  type AsyncJob,
  type CanvasOperation,
  type CanvasTransaction,
  type Id,
} from '@aidraw/core';
import type {
  AgentPresence,
  ApplyTransactionResponse,
  DocumentCheckpointRecord,
  DocumentCheckpointSummary,
  EditorAdvisoryInput,
  EditorAdvisoryState,
  HumanLockRequest,
  HumanOccupancy,
  McpConnectionInfo,
  NewDocumentOptions,
  WorkspaceEvent,
  WorkspaceSnapshot,
  TransactionTraceEntry,
} from '../common/contracts';
import { RecoveryJournal } from './journal';
import { readNativeDocument, writeNativeDocument } from './persistence';
import { renderDocument } from './render-document';
import { TransactionTraceStore } from './trace-store';
import {
  assertDocumentImageAssetMetadata,
  inspectDocumentImageAsset,
  prepareTransactionForCommit,
  type ImageDecodeValidator,
} from './transaction-policy';
import { rebaseRestoredEntityRevisions } from '../common/document-branch';
import { checkpointMergeCandidates, checkpointMergeOperations } from '../common/checkpoint-merge';
import { MAX_TRANSACTION_SERIALIZED_BYTES } from '../common/transaction-limits';
import { committedHistoryTargets, historyTargetsIntersect, mutationHistoryTargets } from './history-policy';
import { MAX_NATIVE_BINARY_ENTRY_BYTES } from './native-container-limits';

interface HistoryInvalidation {
  actorId: Id;
  actorName: string;
  transactionId: Id;
}

interface HistoryEntry {
  transaction: CanvasTransaction;
  targets: string[];
  invalidatedBy?: HistoryInvalidation;
}

interface HistoryState {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

interface HumanLock extends HumanLockRequest {
  id: Id;
  acquiredAt: number;
}

function agentActivityEntries(document: AIDrawDocument) {
  return document.activity.filter((entry) => entry.actor.kind === 'agent');
}

function historyActionAvailable(entries: HistoryEntry[]): boolean {
  const entry = entries.at(-1);
  return Boolean(entry && !entry.invalidatedBy);
}

export class DocumentService extends EventEmitter {
  private readonly documents = new Map<Id, AIDrawDocument>();
  private readonly histories = new Map<Id, Map<Id, HistoryState>>();
  private readonly operationIds = new Map<Id, Map<string, number>>();
  private readonly changes = new Map<Id, Array<{ revision: number; transaction: CanvasTransaction }>>();
  private readonly comparisons = new Map<Id, { transactionId: Id; before: AIDrawDocument; afterRevision: number }>();
  private readonly checkpoints = new Map<Id, Map<Id, DocumentCheckpointRecord>>();
  private readonly locks = new Map<Id, HumanLock>();
  private readonly jobs = new Map<Id, AsyncJob>();
  private readonly jobTimers = new Map<Id, NodeJS.Timeout>();
  private readonly presence = new Map<Id, AgentPresence>();
  private readonly acknowledgedAgentActivityCounts = new Map<Id, number>();
  private editorAdvisory: EditorAdvisoryState = { advisory: true, attached: false, updatedAt: nowIso() };
  private activeDocumentId?: Id;
  private workspaceRevision = 0;
  private recoveryWarnings: string[] = [];
  private mcpInfo: Pick<McpConnectionInfo, 'running' | 'url' | 'port' | 'tokenHint'> = { running: false };

  constructor(
    private readonly journal: RecoveryJournal,
    private readonly appVersion: string,
    private readonly traceStore?: TransactionTraceStore,
    private readonly imageDecoder?: ImageDecodeValidator,
  ) {
    super();
  }

  initialize(): void {
    if (this.documents.size === 0) this.create({ kind: 'illustration' });
  }

  async recover(): Promise<number> {
    const recovered = await this.journal.recoverWorkspace();
    const documents = recovered.documents;
    this.recoveryWarnings = [];
    let omittedPayloads = 0;
    let affectedDocuments = 0;
    for (const document of documents) {
      const omitted = await this.reconcileRecoveredImageAssets(document);
      if (omitted > 0) {
        omittedPayloads += omitted;
        affectedDocuments += 1;
      }
      this.documents.set(document.id, document); this.histories.set(document.id, new Map()); this.operationIds.set(document.id, new Map()); this.changes.set(document.id, []); this.checkpoints.set(document.id, new Map()); this.acknowledgedAgentActivityCounts.set(document.id, agentActivityEntries(document).length);
    }
    if (omittedPayloads > 0) {
      this.recoveryWarnings.push(`Recovery omitted ${omittedPayloads} invalid embedded image payload${omittedPayloads === 1 ? '' : 's'} across ${affectedDocuments} recovered document${affectedDocuments === 1 ? '' : 's'}; the recovered document state and asset metadata were preserved.`);
    }
    this.activeDocumentId = recovered.activeDocumentId && this.documents.has(recovered.activeDocumentId)
      ? recovered.activeDocumentId
      : documents.at(-1)?.id;
    if (documents.length) this.publish();
    return documents.length;
  }

  private async reconcileRecoveredImageAssets(document: AIDrawDocument): Promise<number> {
    let omitted = 0;
    for (const [assetId, candidate] of Object.entries(document.assets)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !Object.hasOwn(candidate, 'data')) continue;
      try {
        const asset = assertDocumentImageAssetMetadata(assetId, candidate);
        if (asset.data === undefined) continue;
        const inspected = inspectDocumentImageAsset(asset, {
          maxBytes: MAX_NATIVE_BINARY_ENTRY_BYTES,
          limitLabel: '128 MiB',
          label: `Recovered asset ${assetId}`,
        });
        if (this.imageDecoder) await this.imageDecoder(inspected.bytes, inspected.expected);
      } catch {
        delete (candidate as { data?: unknown }).data;
        omitted += 1;
      }
    }
    return omitted;
  }

  async compactRecovery(): Promise<void> {
    await Promise.all(this.getDocuments().map((document) => this.journal.compact(document)));
    await this.journal.compactWorkspace([...this.documents.keys()], this.activeDocumentId);
  }

  async flushRecovery(): Promise<void> {
    await this.journal.flush();
  }

  setMcpInfo(info: Pick<McpConnectionInfo, 'running' | 'url' | 'port' | 'tokenHint'>): void {
    this.mcpInfo = info;
    this.publish();
  }

  getMcpInfo(): McpConnectionInfo {
    return { ...this.mcpInfo, sessions: [...this.presence.values()].map((entry) => structuredClone(entry)) };
  }

  getDocument(documentId: Id): AIDrawDocument | undefined {
    const document = this.documents.get(documentId);
    return document ? structuredClone(document) : undefined;
  }

  getDocuments(): AIDrawDocument[] {
    return [...this.documents.values()].map((document) => structuredClone(document));
  }

  getActiveDocumentId(): Id | undefined {
    return this.activeDocumentId;
  }

  getLastComparison(documentId: Id, transactionId: Id): { transactionId: Id; before: AIDrawDocument; after: AIDrawDocument } | undefined {
    const comparison = this.comparisons.get(documentId);
    const after = this.documents.get(documentId);
    if (!comparison || comparison.transactionId !== transactionId || !after || after.revision !== comparison.afterRevision) return undefined;
    return { transactionId, before: structuredClone(comparison.before), after: structuredClone(after) };
  }

  setEditorAttached(attached: boolean): void {
    this.editorAdvisory = attached
      ? { advisory: true, attached: true, updatedAt: nowIso(), documentId: this.activeDocumentId, selectedEntityIds: [] }
      : { advisory: true, attached: false, updatedAt: nowIso() };
  }

  updateEditorAdvisory(input: EditorAdvisoryInput): void {
    if (!this.editorAdvisory.attached) return;
    if (!this.activeDocumentId || input.documentId !== this.activeDocumentId) return;
    const documentId = this.activeDocumentId;
    const tool = typeof input.tool === 'string' && /^[a-z0-9-]{1,40}$/i.test(input.tool) ? input.tool : undefined;
    const selectedEntityIds = Array.isArray(input.selectedEntityIds)
      ? [...new Set(input.selectedEntityIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 256)
      : undefined;
    const zoom = Number.isFinite(input.zoom) ? Math.max(0.01, Math.min(128, Number(input.zoom))) : undefined;
    const viewport = input.viewport && [input.viewport.x, input.viewport.y, input.viewport.width, input.viewport.height].every(Number.isFinite)
      ? { x: Math.max(-16_777_216, Math.min(16_777_216, input.viewport.x)), y: Math.max(-16_777_216, Math.min(16_777_216, input.viewport.y)), width: Math.max(0, Math.min(16_777_216, input.viewport.width)), height: Math.max(0, Math.min(16_777_216, input.viewport.height)) }
      : undefined;
    const cleanId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
    const animation = input.animation && typeof input.animation === 'object'
      ? { activeAssetId: cleanId(input.animation.activeAssetId), activeFrameId: cleanId(input.animation.activeFrameId), activeTagId: cleanId(input.animation.activeTagId), illustrationTimeMs: Number.isFinite(input.animation.illustrationTimeMs) ? Math.max(0, Math.min(600_000, Number(input.animation.illustrationTimeMs))) : undefined, playing: input.animation.playing === true, onionSkin: input.animation.onionSkin === true, direction: input.animation.direction === 'reverse' || input.animation.direction === 'ping-pong' ? input.animation.direction : 'forward' as const }
      : undefined;
    this.editorAdvisory = { advisory: true, attached: true, updatedAt: nowIso(), documentId, tool, selectedEntityIds, zoom, viewport, animation };
  }

  getEditorAdvisory(): EditorAdvisoryState {
    return structuredClone(this.editorAdvisory);
  }

  snapshot(actorId = HUMAN_ACTOR.id): WorkspaceSnapshot {
    const active = this.activeDocumentId ? this.documents.get(this.activeDocumentId) : undefined;
    const history = active ? this.getHistory(active.id, actorId) : undefined;
    const agentActors = new Map<Id, Actor>();
    if (active) for (const entry of active.activity) if (entry.actor.kind === 'agent') agentActors.set(entry.actor.id, entry.actor);
    for (const entry of this.presence.values()) if (entry.actor.kind === 'agent' && (!active || !entry.documentId || entry.documentId === active.id)) agentActors.set(entry.actor.id, entry.actor);
    return {
      workspaceRevision: this.workspaceRevision,
      ...(this.recoveryWarnings.length ? { recoveryWarnings: [...this.recoveryWarnings] } : {}),
      documents: [...this.documents.values()].map((document) => {
        const tab = {
          id: document.id,
          name: document.name,
          kind: document.kind,
          dirty: document.dirty,
          revision: document.revision,
          filePath: document.filePath,
        } as WorkspaceSnapshot['documents'][number];
        if (document.id === this.activeDocumentId) return tab;
        const livePresence = [...this.presence.values()]
          .filter((entry) => entry.actor.kind === 'agent' && entry.documentId === document.id && (entry.status === 'working' || entry.status === 'waiting'))
          .sort((left, right) => Number(right.status === 'working') - Number(left.status === 'working') || left.actor.id.localeCompare(right.actor.id))[0];
        if (livePresence) {
          tab.activityState = 'active';
          tab.activityActor = structuredClone(livePresence.actor);
          tab.activityCursor = livePresence.cursor ? structuredClone(livePresence.cursor) : undefined;
          return tab;
        }
        const activities = agentActivityEntries(document);
        const acknowledged = this.acknowledgedAgentActivityCounts.get(document.id) ?? activities.length;
        if (activities.length > acknowledged) {
          const latest = activities.at(-1)!;
          tab.activityState = latest.status === 'failed' || latest.status === 'cancelled' ? 'conflict' : 'complete';
          tab.activityActor = structuredClone(latest.actor);
        }
        return tab;
      }),
      activeDocumentId: this.activeDocumentId,
      activeDocument: active ? structuredClone(active) : undefined,
      jobs: [...this.jobs.values()].map((job) => structuredClone(job)),
      mcp: this.getMcpInfo(),
      canUndo: Boolean(history && historyActionAvailable(history.undo)),
      canRedo: Boolean(history && historyActionAvailable(history.redo)),
      agentHistories: [...agentActors.values()].map((actor) => {
        const state = active ? this.histories.get(active.id)?.get(actor.id) : undefined;
        return { actor: structuredClone(actor), canUndo: Boolean(state && historyActionAvailable(state.undo)), canRedo: Boolean(state && historyActionAvailable(state.redo)) };
      }),
      checkpoints: active ? this.listCheckpoints(active.id) : [],
    };
  }

  create(options: NewDocumentOptions): WorkspaceSnapshot {
    const parsed = NewDocumentOptionsSchema.parse(options);
    const document = createDocument(parsed.kind);
    if (parsed.name?.trim()) document.name = parsed.name.trim();
    if (document.kind === 'illustration') {
      if (parsed.width) document.artboard.width = parsed.width;
      if (parsed.height) document.artboard.height = parsed.height;
      if (parsed.background !== undefined) document.artboard.background = parsed.background;
    } else {
      const asset = document.pixelAssets[document.activeAssetId];
      if (asset?.type === 'sprite') {
        if (parsed.width) asset.width = parsed.width;
        if (parsed.height) asset.height = parsed.height;
      } else if (asset?.type === 'tilemap') {
        if (parsed.width) asset.width = parsed.width;
        if (parsed.height) asset.height = parsed.height;
        if (parsed.orientation) asset.orientation = parsed.orientation;
        if (parsed.infinite !== undefined) asset.infinite = parsed.infinite;
        if (parsed.tileWidth) asset.tileWidth = parsed.tileWidth;
        if (parsed.tileHeight) asset.tileHeight = parsed.tileHeight;
      }
    }
    this.documents.set(document.id, document);
    this.histories.set(document.id, new Map());
    this.operationIds.set(document.id, new Map());
    this.changes.set(document.id, []);
    this.checkpoints.set(document.id, new Map());
    this.comparisons.delete(document.id);
    this.acknowledgedAgentActivityCounts.set(document.id, agentActivityEntries(document).length);
    void this.journal.compact(document).catch((error) => this.emit('recovery-error', error));
    this.setActiveDocument(document.id);
    this.publish();
    return this.snapshot();
  }

  addDocument(document: AIDrawDocument): WorkspaceSnapshot {
    const cloned = structuredClone(document);
    this.documents.set(document.id, cloned);
    this.histories.set(document.id, new Map());
    this.operationIds.set(document.id, new Map());
    this.changes.set(document.id, []);
    this.checkpoints.set(document.id, new Map());
    this.comparisons.delete(document.id);
    this.acknowledgedAgentActivityCounts.set(document.id, agentActivityEntries(cloned).length);
    void this.journal.compact(document).catch((error) => this.emit('recovery-error', error));
    this.setActiveDocument(document.id);
    this.publish();
    return this.snapshot();
  }

  activate(documentId: Id): WorkspaceSnapshot {
    if (!this.documents.has(documentId)) throw new Error('Document is no longer open.');
    this.setActiveDocument(documentId);
    this.publish();
    return this.snapshot();
  }

  async apply(
    value: CanvasTransaction,
    options: { recordHistory?: boolean; actorMayBypassLocks?: boolean; activityStatus?: 'committed' | 'partial'; trustedProvenance?: boolean } = {},
  ): Promise<ApplyTransactionResponse> {
    let transaction: CanvasTransaction;
    try {
      transaction = CanvasTransactionSchema.parse(value);
    } catch (error) {
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Invalid transaction' };
    }

    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(transaction)); } catch {
      return { status: 'conflict', message: 'Transaction must be JSON-serializable.' };
    }
    if (size > MAX_TRANSACTION_SERIALIZED_BYTES) {
      return { status: 'busy', message: 'Transaction exceeds the 2 MiB request limit.' };
    }
    const current = this.documents.get(transaction.documentId);
    if (!current) return { status: 'conflict', message: 'Document is not open.' };

    const dedupe = this.operationIds.get(current.id) ?? new Map<string, number>();
    this.operationIds.set(current.id, dedupe);
    const priorRevision = dedupe.get(transaction.clientOperationId);
    if (priorRevision !== undefined) {
      return { status: 'duplicate', revision: priorRevision, transactionId: transaction.id };
    }

    if (!options.actorMayBypassLocks && transaction.actor.kind !== 'human') {
      const collision = this.findLockCollision(transaction);
      if (collision) return { status: 'locked', message: collision, conflict: { retryable: true } };
    }

    try {
      transaction = await prepareTransactionForCommit(current, transaction, nowIso(), {
        trustedProvenance: options.trustedProvenance,
        imageDecoder: this.imageDecoder,
      });
      const result = applyTransaction(current, transaction, { status: options.activityStatus });
      const historyTargets = committedHistoryTargets(current, transaction, result.document, result.inverse);
      this.comparisons.set(current.id, { transactionId: transaction.id, before: structuredClone(current), afterRevision: result.document.revision });
      this.documents.set(current.id, result.document);
      dedupe.set(transaction.clientOperationId, result.document.revision);
      if (dedupe.size > 10_000) dedupe.delete(dedupe.keys().next().value as string);

      this.invalidateConflictingHistories(current.id, transaction.actor, transaction.id, mutationHistoryTargets(historyTargets), options.recordHistory === false);
      if (options.recordHistory !== false) {
        const history = this.getHistory(current.id, transaction.actor.id);
        history.undo.push({ transaction: result.inverse, targets: historyTargets });
        history.redo.length = 0;
      } else {
        const history = this.histories.get(current.id)?.get(transaction.actor.id);
        if (history) history.redo.length = 0;
      }
      this.recordChange(current.id, result.document.revision, transaction);
      await this.journal.append(current.id, transaction);
      await this.recordTrace(transaction, result.document.revision, options.activityStatus === 'partial' ? 'partial' : 'committed');
      this.publish();
      return { status: 'committed', revision: result.document.revision, transactionId: transaction.id };
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        return {
          status: 'conflict',
          message: error.message,
          conflict: {
            entityId: error.conflict.entityId,
            expectedRevision: error.conflict.expectedRevision,
            actualRevision: error.conflict.actualRevision,
            retryable: error.conflict.retryable,
          },
        };
      }
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Transaction failed.' };
    }
  }

  async undo(documentId = this.activeDocumentId, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    if (!documentId) return { status: 'conflict', message: 'No active document.' };
    const current = this.documents.get(documentId);
    if (!current) return { status: 'conflict', message: 'Document is not open.' };
    const history = this.getHistory(documentId, actor.id);
    const entry = history.undo.at(-1);
    if (!entry) return { status: 'conflict', message: 'Nothing to undo.' };
    if (entry.invalidatedBy) return { status: 'conflict', message: `Cannot undo because ${entry.invalidatedBy.actorName} changed overlapping content afterward.` };
    let transaction: CanvasTransaction;
    let result: ReturnType<typeof applyTransaction>;
    try {
      transaction = rebaseTransactionExpectedRevisions(current, { ...structuredClone(entry.transaction), actor: structuredClone(actor) });
      result = applyTransaction(current, transaction);
    } catch (error) {
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Undo failed.' };
    }
    const appliedTargets = committedHistoryTargets(current, transaction, result.document, result.inverse);
    const historyTargets = [...new Set([...entry.targets, ...appliedTargets])].sort();
    history.undo.pop();
    this.comparisons.set(documentId, { transactionId: transaction.id, before: structuredClone(current), afterRevision: result.document.revision });
    this.documents.set(documentId, result.document);
    this.invalidateConflictingHistories(documentId, actor, transaction.id, mutationHistoryTargets(appliedTargets));
    history.redo.push({ transaction: result.inverse, targets: historyTargets });
    this.recordChange(documentId, result.document.revision, transaction);
    await this.journal.append(documentId, transaction);
    await this.recordTrace(transaction, result.document.revision, 'undo');
    this.publish();
    return { status: 'committed', revision: result.document.revision, transactionId: transaction.id };
  }

  async redo(documentId = this.activeDocumentId, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    if (!documentId) return { status: 'conflict', message: 'No active document.' };
    const current = this.documents.get(documentId);
    if (!current) return { status: 'conflict', message: 'Document is not open.' };
    const history = this.getHistory(documentId, actor.id);
    const entry = history.redo.at(-1);
    if (!entry) return { status: 'conflict', message: 'Nothing to redo.' };
    if (entry.invalidatedBy) return { status: 'conflict', message: `Cannot redo because ${entry.invalidatedBy.actorName} changed overlapping content afterward.` };
    let transaction: CanvasTransaction;
    let result: ReturnType<typeof applyTransaction>;
    try {
      transaction = rebaseTransactionExpectedRevisions(current, { ...structuredClone(entry.transaction), actor: structuredClone(actor) });
      result = applyTransaction(current, transaction);
    } catch (error) {
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Redo failed.' };
    }
    const appliedTargets = committedHistoryTargets(current, transaction, result.document, result.inverse);
    const historyTargets = [...new Set([...entry.targets, ...appliedTargets])].sort();
    history.redo.pop();
    this.comparisons.set(documentId, { transactionId: transaction.id, before: structuredClone(current), afterRevision: result.document.revision });
    this.documents.set(documentId, result.document);
    this.invalidateConflictingHistories(documentId, actor, transaction.id, mutationHistoryTargets(appliedTargets));
    history.undo.push({ transaction: result.inverse, targets: historyTargets });
    this.recordChange(documentId, result.document.revision, transaction);
    await this.journal.append(documentId, transaction);
    await this.recordTrace(transaction, result.document.revision, 'redo');
    this.publish();
    return { status: 'committed', revision: result.document.revision, transactionId: transaction.id };
  }

  async undoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse> {
    const actor = this.findDocumentAgent(documentId, actorId);
    return actor ? this.undo(documentId, actor) : { status: 'conflict', message: 'That agent has no attributed history in this document.' };
  }

  async redoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse> {
    const actor = this.findDocumentAgent(documentId, actorId);
    return actor ? this.redo(documentId, actor) : { status: 'conflict', message: 'That agent has no attributed history in this document.' };
  }

  listCheckpoints(documentId: Id): DocumentCheckpointSummary[] {
    return this.listCheckpointRecords(documentId)
      .map((checkpoint) => this.checkpointSummary(checkpoint))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getCheckpoint(documentId: Id, checkpointId: Id): DocumentCheckpointRecord | undefined {
    const checkpoint = this.checkpoints.get(documentId)?.get(checkpointId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  listCheckpointMergeCandidates(documentId: Id, checkpointId: Id) {
    const checkpoint = this.checkpoints.get(documentId)?.get(checkpointId);
    if (!checkpoint) throw new Error('Checkpoint not found.');
    return checkpointMergeCandidates(checkpoint.document);
  }

  async mergeCheckpoint(documentId: Id, checkpointId: Id, sourceIds: Id[], actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    const current = this.documents.get(documentId); const checkpoint = this.checkpoints.get(documentId)?.get(checkpointId);
    if (!current || !checkpoint) return { status: 'conflict', message: 'Checkpoint not found.' };
    let operations: CanvasOperation[];
    try { operations = checkpointMergeOperations(current, checkpoint.document, sourceIds); }
    catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : String(error) }; }
    return this.apply({ id: createId('tx'), clientOperationId: createId('checkpoint-merge'), documentId, actor: structuredClone(actor), label: `Merge checkpoint selection · ${checkpoint.name}`, createdAt: nowIso(), operations, playback: { mode: 'instant', speed: 1 } });
  }

  createCheckpoint(documentId: Id, name: string, actor: Actor = HUMAN_ACTOR, kind: DocumentCheckpointSummary['kind'] = 'manual'): DocumentCheckpointSummary {
    const document = this.documents.get(documentId);
    if (!document) throw new Error('Document is not open.');
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) throw new Error('Checkpoint names must contain 1–80 characters.');
    const entries = this.checkpoints.get(documentId) ?? new Map<Id, DocumentCheckpointRecord>();
    if (entries.size >= 32) throw new Error('This document already has the maximum of 32 checkpoints.');
    const checkpoint: DocumentCheckpointRecord = {
      id: createId('checkpoint'),
      documentId,
      name: cleanName,
      createdAt: nowIso(),
      createdBy: structuredClone(actor),
      sourceRevision: document.revision,
      kind,
      document: structuredClone(document),
    };
    entries.set(checkpoint.id, checkpoint);
    this.checkpoints.set(documentId, entries);
    document.dirty = true;
    document.updatedAt = checkpoint.createdAt;
    this.publish();
    return this.checkpointSummary(checkpoint);
  }

  deleteCheckpoint(documentId: Id, checkpointId: Id, actor: Actor = HUMAN_ACTOR): { deleted: boolean; message?: string } {
    const document = this.documents.get(documentId);
    const entries = this.checkpoints.get(documentId);
    const checkpoint = entries?.get(checkpointId);
    if (!document || !entries || !checkpoint) return { deleted: false, message: 'Checkpoint not found.' };
    if (actor.kind !== 'human' && checkpoint.createdBy.id !== actor.id) return { deleted: false, message: 'Agents may only delete checkpoints they created.' };
    entries.delete(checkpointId);
    document.dirty = true;
    document.updatedAt = nowIso();
    this.publish();
    return { deleted: true };
  }

  async restoreCheckpoint(documentId: Id, checkpointId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    const current = this.documents.get(documentId);
    const checkpoint = this.checkpoints.get(documentId)?.get(checkpointId);
    if (!current || !checkpoint) return { status: 'conflict', message: 'Checkpoint not found.' };
    if (actor.kind !== 'human' && [...this.locks.values()].some((lock) => lock.documentId === documentId)) {
      return { status: 'locked', message: 'A human is actively editing this document.', conflict: { retryable: true } };
    }
    const entries = this.checkpoints.get(documentId)!;
    if (entries.size >= 32) {
      const oldestAutomatic = [...entries.values()].filter((entry) => entry.kind === 'automatic').sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!oldestAutomatic) return { status: 'busy', message: 'Delete a checkpoint before restoring so AIDraw can preserve the current branch automatically.' };
      entries.delete(oldestAutomatic.id);
    }
    const timestamp = nowIso();
    const automatic: DocumentCheckpointRecord = {
      id: createId('checkpoint'), documentId, name: `Before restore · ${checkpoint.name}`, createdAt: timestamp,
      createdBy: structuredClone(actor), sourceRevision: current.revision, kind: 'automatic', document: structuredClone(current),
    };
    entries.set(automatic.id, automatic);
    const transactionId = createId('checkpoint-restore');
    const restored = structuredClone(checkpoint.document);
    restored.id = current.id;
    restored.revision = current.revision + 1;
    restored.filePath = current.filePath;
    restored.dirty = true;
    restored.updatedAt = timestamp;
    rebaseRestoredEntityRevisions(current, restored, timestamp);
    restored.activity = [
      ...current.activity,
      {
        id: createId('activity'), transactionId, actor: structuredClone(actor), label: `Restore checkpoint · ${checkpoint.name}`,
        timestamp, status: 'committed', operationCount: 0,
        details: `Accepted checkpoint ${checkpoint.id} from revision ${checkpoint.sourceRevision}; the prior branch is preserved as ${automatic.id}.`,
      },
    ];
    this.comparisons.set(documentId, { transactionId, before: structuredClone(current), afterRevision: restored.revision });
    this.documents.set(documentId, restored);
    this.histories.set(documentId, new Map());
    this.operationIds.set(documentId, new Map());
    this.changes.set(documentId, []);
    await this.journal.compact(restored);
    this.publish();
    return { status: 'committed', revision: restored.revision, transactionId };
  }

  async open(filePaths: string[]): Promise<{ opened: string[]; warnings: string[] }> {
    const opened: string[] = [];
    const warnings: string[] = [];
    for (const filePath of filePaths) {
      try {
        const loaded = await readNativeDocument(filePath, this.imageDecoder);
        const existing = [...this.documents.values()].find((entry) => entry.filePath === filePath);
        if (existing) {
          this.activeDocumentId = existing.id;
          continue;
        }
        this.documents.set(loaded.document.id, loaded.document);
        this.histories.set(loaded.document.id, new Map());
        this.operationIds.set(loaded.document.id, new Map());
        this.changes.set(loaded.document.id, []);
        this.checkpoints.set(loaded.document.id, new Map(loaded.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])));
        this.comparisons.delete(loaded.document.id);
        this.acknowledgedAgentActivityCounts.set(loaded.document.id, agentActivityEntries(loaded.document).length);
        void this.journal.compact(loaded.document).catch((error) => this.emit('recovery-error', error));
        await this.traceStore?.import(loaded.document.id, loaded.trace);
        this.activeDocumentId = loaded.document.id;
        opened.push(filePath);
        warnings.push(...loaded.warnings);
      } catch (error) {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : 'Could not open file.'}`);
      }
    }
    this.resetEditorAdvisory();
    this.persistWorkspace();
    this.publish();
    return { opened, warnings };
  }

  async save(documentId: Id, filePath: string): Promise<string> {
    const document = this.documents.get(documentId);
    if (!document) throw new Error('Document is not open.');
    const trace = await this.listTrace(documentId);
    const destination = await writeNativeDocument(
      filePath,
      document,
      this.appVersion,
      async () => (await renderDocument(document)).toBuffer('image/png'),
      trace,
      this.listCheckpointRecords(documentId),
      undefined,
      this.imageDecoder,
    );
    document.filePath = destination;
    document.dirty = false;
    document.updatedAt = nowIso();
    await this.journal.compact(document);
    this.publish();
    return destination;
  }

  async close(documentId: Id, force = false): Promise<{ closed: boolean; reason?: string }> {
    const document = this.documents.get(documentId);
    if (!document) return { closed: true };
    if (document.dirty && !force) return { closed: false, reason: 'unsaved' };
    this.documents.delete(documentId);
    this.histories.delete(documentId);
    this.operationIds.delete(documentId);
    this.changes.delete(documentId);
    this.comparisons.delete(documentId);
    this.checkpoints.delete(documentId);
    this.acknowledgedAgentActivityCounts.delete(documentId);
    for (const [lockId, lock] of this.locks) if (lock.documentId === documentId) this.locks.delete(lockId);
    if (this.activeDocumentId === documentId) {
      this.activeDocumentId = [...this.documents.keys()].at(-1);
      if (!this.activeDocumentId) this.create({ kind: 'illustration' });
    }
    await this.journal.remove(documentId);
    this.resetEditorAdvisory();
    this.persistWorkspace();
    this.publish();
    return { closed: true };
  }

  acquireLock(request: HumanLockRequest): { acquired: boolean; lockId?: Id; reason?: string } {
    if (!this.documents.has(request.documentId)) return { acquired: false, reason: 'Document is not open.' };
    const lock: HumanLock = { ...structuredClone(request), id: createId('lock'), acquiredAt: Date.now() };
    this.locks.set(lock.id, lock);
    return { acquired: true, lockId: lock.id };
  }

  releaseLock(lockId: Id): void {
    this.locks.delete(lockId);
  }

  getHumanOccupancy(documentId: Id): HumanOccupancy {
    const locks = [...this.locks.values()]
      .filter((lock) => lock.documentId === documentId)
      .map((lock) => ({
        objectIds: lock.objectIds ? [...lock.objectIds] : undefined,
        region: lock.region ? structuredClone(lock.region) : undefined,
        acquiredAt: new Date(lock.acquiredAt).toISOString(),
      }));
    return {
      documentId,
      active: locks.length > 0,
      locks,
      retryGuidance: locks.length > 0
        ? 'Retry after the human releases the listed object/region lock; unrelated entities and non-overlapping regions may proceed now.'
        : 'No human pointer lock is active.',
    };
  }

  updatePresence(presence: AgentPresence): void {
    this.presence.set(presence.actor.id, structuredClone(presence));
    this.emitEvent({ type: 'cursor', presence });
    this.publish();
  }

  removePresence(actorId: Id): void {
    this.presence.delete(actorId);
    this.publish();
  }

  stopAgents(documentId?: Id): number {
    let stopped = 0;
    for (const presence of this.presence.values()) {
      if (!documentId || presence.documentId === documentId) {
        presence.status = 'idle';
        presence.queueDepth = 0;
        stopped += 1;
      }
    }
    this.publish();
    return stopped;
  }

  upsertJob(job: AsyncJob): void {
    const existingTimer = this.jobTimers.get(job.id); if (existingTimer) { clearTimeout(existingTimer); this.jobTimers.delete(job.id); }
    this.jobs.set(job.id, structuredClone(job));
    if (job.status === 'waiting-for-user' && job.approval) {
      const delay = Math.max(0, new Date(job.approval.expiresAt).getTime() - Date.now());
      const requestedDelay = Math.max(0, new Date(job.approval.expiresAt).getTime() - new Date(job.createdAt).getTime());
      const timeoutLabel = requestedDelay === 120_000 ? 'two minutes' : `${Math.round(requestedDelay / 1_000)} seconds`;
      const timer = setTimeout(() => {
        const current = this.jobs.get(job.id); if (!current || current.status !== 'waiting-for-user') return;
        this.upsertJob({ ...current, status: 'cancelled', updatedAt: nowIso(), message: `Approval timed out after ${timeoutLabel}.`, approval: undefined, error: { code: 'approval_timeout', message: 'The in-app approval expired.', retryable: true } });
      }, delay);
      timer.unref(); this.jobTimers.set(job.id, timer);
    }
    this.emitEvent({ type: 'job', job });
    this.publish();
  }

  getJob(jobId: Id): AsyncJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  listJobs(actorId?: Id): AsyncJob[] {
    return [...this.jobs.values()]
      .filter((job) => !actorId || job.actor.id === actorId)
      .map((job) => structuredClone(job));
  }

  resolveJob(jobId: Id, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): AsyncJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current || current.status !== 'waiting-for-user') return current ? structuredClone(current) : undefined;
    const job: AsyncJob = {
      ...current,
      status: decision === 'deny' ? 'cancelled' : 'queued',
      updatedAt: nowIso(),
      message: decision === 'deny' ? 'Denied in AIDraw.' : `Approved (${decision}); ready to run.`,
      approval: undefined,
      result: { ...(typeof current.result === 'object' && current.result ? current.result : {}), approvalDecision: decision },
    };
    this.emit('approval-resolved', structuredClone(current), decision);
    this.upsertJob(job);
    return structuredClone(job);
  }

  getChanges(documentId: Id, afterRevision: number): Array<{ revision: number; transaction: CanvasTransaction }> {
    return (this.changes.get(documentId) ?? []).filter((entry) => entry.revision > afterRevision).map((entry) => structuredClone(entry));
  }

  async listTrace(documentId: Id, limit = Number.POSITIVE_INFINITY): Promise<TransactionTraceEntry[]> {
    return this.traceStore?.list(documentId, limit) ?? [];
  }

  async findTrace(documentId: Id, transactionId: Id): Promise<TransactionTraceEntry | undefined> {
    return this.traceStore?.find(documentId, transactionId);
  }

  broadcastPlayback(event: Extract<WorkspaceEvent, { type: 'playback' }>): void {
    this.emitEvent(event);
  }

  private recordChange(documentId: Id, revision: number, transaction: CanvasTransaction): void {
    const changeLog = this.changes.get(documentId) ?? [];
    changeLog.push({ revision, transaction: structuredClone(transaction) });
    if (changeLog.length > 2_000) changeLog.splice(0, changeLog.length - 2_000);
    this.changes.set(documentId, changeLog);
  }

  private invalidateConflictingHistories(documentId: Id, actor: Actor, transactionId: Id, targets: ReadonlySet<string>, invalidateActor = false): void {
    const histories = this.histories.get(documentId);
    if (!histories) return;
    const invalidation: HistoryInvalidation = { actorId: actor.id, actorName: actor.name, transactionId };
    for (const [actorId, history] of histories) {
      if (!invalidateActor && actorId === actor.id) continue;
      for (const entry of [...history.undo, ...history.redo]) {
        if (!entry.invalidatedBy && historyTargetsIntersect(entry.targets, targets)) entry.invalidatedBy = structuredClone(invalidation);
      }
    }
  }

  private getHistory(documentId: Id, actorId: Id): HistoryState {
    let byActor = this.histories.get(documentId);
    if (!byActor) {
      byActor = new Map();
      this.histories.set(documentId, byActor);
    }
    let history = byActor.get(actorId);
    if (!history) {
      history = { undo: [], redo: [] };
      byActor.set(actorId, history);
    }
    return history;
  }

  private listCheckpointRecords(documentId: Id): DocumentCheckpointRecord[] {
    return [...(this.checkpoints.get(documentId)?.values() ?? [])].map((checkpoint) => structuredClone(checkpoint));
  }

  private checkpointSummary(checkpoint: DocumentCheckpointRecord): DocumentCheckpointSummary {
    return structuredClone({
      id: checkpoint.id,
      documentId: checkpoint.documentId,
      name: checkpoint.name,
      createdAt: checkpoint.createdAt,
      createdBy: checkpoint.createdBy,
      sourceRevision: checkpoint.sourceRevision,
      kind: checkpoint.kind,
    });
  }

  private findDocumentAgent(documentId: Id, actorId: Id): Actor | undefined {
    if (actorId === HUMAN_ACTOR.id) return undefined;
    const document = this.documents.get(documentId);
    const attributed = document?.activity.findLast((entry) => entry.actor.id === actorId && entry.actor.kind === 'agent')?.actor;
    const present = this.presence.get(actorId)?.actor;
    const actor = attributed ?? present;
    return actor?.kind === 'agent' ? structuredClone(actor) : undefined;
  }

  private async recordTrace(transaction: CanvasTransaction, revision: number, outcome: TransactionTraceEntry['outcome']): Promise<void> {
    if (!this.traceStore) return;
    try {
      await this.traceStore.append({ documentId: transaction.documentId, revision, outcome, transaction });
    } catch (error) {
      this.emit('trace-error', error);
    }
  }

  private findLockCollision(transaction: CanvasTransaction): string | undefined {
    const locks = [...this.locks.values()].filter((lock) => lock.documentId === transaction.documentId);
    for (const operation of transaction.operations) {
      for (const lock of locks) {
        if (this.operationTouchesLock(operation, lock)) return 'A human is actively editing this object or region.';
      }
    }
    return undefined;
  }

  private operationTouchesLock(operation: CanvasOperation, lock: HumanLock): boolean {
    const objectId = operation.kind === 'illustration.object.delete'
      ? operation.objectId
      : operation.kind === 'illustration.object.replace' || operation.kind === 'illustration.object.add'
        ? operation.object.id
        : operation.kind === 'pixel.asset.replace' || operation.kind === 'pixel.asset.add'
          ? operation.asset.id
          : operation.kind === 'pixel.asset.delete'
            ? operation.assetId
            : undefined;
    if (objectId && lock.objectIds?.includes(objectId)) return true;
    if (!lock.region) return false;
    const changes = operation.kind === 'pixel.cel.set'
      ? operation.spriteId === lock.region.assetId ? operation.changes : []
      : operation.kind === 'pixel.tilemap.set' && operation.mapId === lock.region.assetId
        ? operation.changes
        : [];
    if (changes.some((change) =>
      change.x >= lock.region!.x && change.y >= lock.region!.y &&
      change.x < lock.region!.x + lock.region!.width && change.y < lock.region!.y + lock.region!.height,
    )) return true;
    const runs = operation.kind === 'pixel.cel.region'
      ? operation.spriteId === lock.region.assetId ? operation.runs : []
      : operation.kind === 'pixel.tilemap.region' && operation.mapId === lock.region.assetId
        ? operation.runs
        : [];
    return runs.some((run) => run.y >= lock.region!.y && run.y < lock.region!.y + lock.region!.height && run.x < lock.region!.x + lock.region!.width && run.x + run.length > lock.region!.x);
  }

  private publish(): void {
    this.workspaceRevision += 1;
    const active = this.activeDocumentId ? this.documents.get(this.activeDocumentId) : undefined;
    if (active) this.acknowledgedAgentActivityCounts.set(active.id, agentActivityEntries(active).length);
    this.emitEvent({ type: 'workspace', snapshot: this.snapshot() });
  }

  private emitEvent(event: WorkspaceEvent): void {
    this.emit('event', event);
  }

  private setActiveDocument(documentId: Id): void {
    this.activeDocumentId = documentId;
    this.resetEditorAdvisory();
    this.persistWorkspace();
  }

  private resetEditorAdvisory(): void {
    if (!this.editorAdvisory.attached) return;
    this.editorAdvisory = {
      advisory: true,
      attached: true,
      updatedAt: nowIso(),
      documentId: this.activeDocumentId,
      selectedEntityIds: [],
    };
  }

  private persistWorkspace(): void {
    void this.journal.compactWorkspace([...this.documents.keys()], this.activeDocumentId).catch((error) => this.emit('recovery-error', error));
  }
}

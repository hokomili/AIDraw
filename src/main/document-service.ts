import { EventEmitter } from 'node:events';
import {
  CanvasTransactionSchema,
  HUMAN_ACTOR,
  TransactionConflictError,
  applyTransaction,
  createDocument,
  createId,
  nowIso,
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
  HumanLockRequest,
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
import { prepareTransactionForCommit } from './transaction-policy';

interface HistoryState {
  undo: CanvasTransaction[];
  redo: CanvasTransaction[];
}

interface HumanLock extends HumanLockRequest {
  id: Id;
  acquiredAt: number;
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export class DocumentService extends EventEmitter {
  private readonly documents = new Map<Id, AIDrawDocument>();
  private readonly histories = new Map<Id, Map<Id, HistoryState>>();
  private readonly operationIds = new Map<Id, Map<string, number>>();
  private readonly changes = new Map<Id, Array<{ revision: number; transaction: CanvasTransaction }>>();
  private readonly locks = new Map<Id, HumanLock>();
  private readonly jobs = new Map<Id, AsyncJob>();
  private readonly jobTimers = new Map<Id, NodeJS.Timeout>();
  private readonly presence = new Map<Id, AgentPresence>();
  private activeDocumentId?: Id;
  private mcpInfo: Pick<McpConnectionInfo, 'running' | 'url' | 'port' | 'tokenHint'> = { running: false };

  constructor(
    private readonly journal: RecoveryJournal,
    private readonly appVersion: string,
    private readonly traceStore?: TransactionTraceStore,
  ) {
    super();
  }

  initialize(): void {
    if (this.documents.size === 0) this.create({ kind: 'illustration' });
  }

  async recover(): Promise<number> {
    const documents = await this.journal.recover();
    for (const document of documents) {
      this.documents.set(document.id, document); this.histories.set(document.id, new Map()); this.operationIds.set(document.id, new Map()); this.changes.set(document.id, []); this.activeDocumentId = document.id;
    }
    if (documents.length) this.publish();
    return documents.length;
  }

  async compactRecovery(): Promise<void> {
    await Promise.all(this.getDocuments().map((document) => this.journal.compact(document)));
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

  snapshot(actorId = HUMAN_ACTOR.id): WorkspaceSnapshot {
    const active = this.activeDocumentId ? this.documents.get(this.activeDocumentId) : undefined;
    const history = active ? this.getHistory(active.id, actorId) : undefined;
    const agentActors = new Map<Id, Actor>();
    if (active) for (const entry of active.activity) if (entry.actor.kind === 'agent') agentActors.set(entry.actor.id, entry.actor);
    for (const entry of this.presence.values()) if (entry.actor.kind === 'agent' && (!active || !entry.documentId || entry.documentId === active.id)) agentActors.set(entry.actor.id, entry.actor);
    return {
      documents: [...this.documents.values()].map((document) => ({
        id: document.id,
        name: document.name,
        kind: document.kind,
        dirty: document.dirty,
        revision: document.revision,
        filePath: document.filePath,
      })),
      activeDocumentId: this.activeDocumentId,
      activeDocument: active ? structuredClone(active) : undefined,
      jobs: [...this.jobs.values()].map((job) => structuredClone(job)),
      mcp: this.getMcpInfo(),
      canUndo: Boolean(history?.undo.length),
      canRedo: Boolean(history?.redo.length),
      agentHistories: [...agentActors.values()].map((actor) => {
        const state = active ? this.histories.get(active.id)?.get(actor.id) : undefined;
        return { actor: structuredClone(actor), canUndo: Boolean(state?.undo.length), canRedo: Boolean(state?.redo.length) };
      }),
    };
  }

  create(options: NewDocumentOptions): WorkspaceSnapshot {
    const document = createDocument(options.kind);
    if (options.name?.trim()) document.name = options.name.trim();
    if (document.kind === 'illustration') {
      if (options.width) document.artboard.width = Math.max(1, Math.round(options.width));
      if (options.height) document.artboard.height = Math.max(1, Math.round(options.height));
      if (options.background !== undefined) document.artboard.background = options.background;
    } else {
      const asset = document.pixelAssets[document.activeAssetId];
      if (asset?.type === 'sprite') {
        if (options.width) asset.width = Math.max(1, Math.round(options.width));
        if (options.height) asset.height = Math.max(1, Math.round(options.height));
      } else if (asset?.type === 'tilemap') {
        if (options.width) asset.width = Math.max(1, Math.round(options.width));
        if (options.height) asset.height = Math.max(1, Math.round(options.height));
        if (options.orientation) asset.orientation = options.orientation;
        if (options.infinite !== undefined) asset.infinite = options.infinite;
        if (options.tileWidth) asset.tileWidth = Math.max(1, Math.min(1024, Math.round(options.tileWidth)));
        if (options.tileHeight) asset.tileHeight = Math.max(1, Math.min(1024, Math.round(options.tileHeight)));
      }
    }
    this.documents.set(document.id, document);
    this.histories.set(document.id, new Map());
    this.operationIds.set(document.id, new Map());
    this.changes.set(document.id, []);
    this.activeDocumentId = document.id;
    void this.journal.compact(document);
    this.publish();
    return this.snapshot();
  }

  addDocument(document: AIDrawDocument): WorkspaceSnapshot {
    this.documents.set(document.id, structuredClone(document));
    this.histories.set(document.id, new Map());
    this.operationIds.set(document.id, new Map());
    this.changes.set(document.id, []);
    this.activeDocumentId = document.id;
    void this.journal.compact(document);
    this.publish();
    return this.snapshot();
  }

  activate(documentId: Id): WorkspaceSnapshot {
    if (!this.documents.has(documentId)) throw new Error('Document is no longer open.');
    this.activeDocumentId = documentId;
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

    const size = Buffer.byteLength(JSON.stringify(transaction));
    if (size > MAX_REQUEST_BYTES) {
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
      if (collision) return { status: 'locked', message: collision };
    }

    try {
      transaction = await prepareTransactionForCommit(current, transaction, nowIso(), { trustedProvenance: options.trustedProvenance });
      const result = applyTransaction(current, transaction, { status: options.activityStatus });
      this.documents.set(current.id, result.document);
      dedupe.set(transaction.clientOperationId, result.document.revision);
      if (dedupe.size > 10_000) dedupe.delete(dedupe.keys().next().value as string);

      if (options.recordHistory !== false) {
        const history = this.getHistory(current.id, transaction.actor.id);
        history.undo.push(result.inverse);
        history.redo.length = 0;
      }
      const changeLog = this.changes.get(current.id) ?? [];
      changeLog.push({ revision: result.document.revision, transaction: structuredClone(transaction) });
      if (changeLog.length > 2_000) changeLog.splice(0, changeLog.length - 2_000);
      this.changes.set(current.id, changeLog);
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
    const transaction = history.undo.pop();
    if (!transaction) return { status: 'conflict', message: 'Nothing to undo.' };
    transaction.actor = actor;
    try {
      const result = applyTransaction(current, transaction);
      this.documents.set(documentId, result.document);
      history.redo.push(result.inverse);
      await this.journal.append(documentId, transaction);
      await this.recordTrace(transaction, result.document.revision, 'undo');
      this.publish();
      return { status: 'committed', revision: result.document.revision, transactionId: transaction.id };
    } catch (error) {
      history.undo.push(transaction);
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Undo failed.' };
    }
  }

  async redo(documentId = this.activeDocumentId, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    if (!documentId) return { status: 'conflict', message: 'No active document.' };
    const current = this.documents.get(documentId);
    if (!current) return { status: 'conflict', message: 'Document is not open.' };
    const history = this.getHistory(documentId, actor.id);
    const transaction = history.redo.pop();
    if (!transaction) return { status: 'conflict', message: 'Nothing to redo.' };
    transaction.actor = actor;
    try {
      const result = applyTransaction(current, transaction);
      this.documents.set(documentId, result.document);
      history.undo.push(result.inverse);
      await this.journal.append(documentId, transaction);
      await this.recordTrace(transaction, result.document.revision, 'redo');
      this.publish();
      return { status: 'committed', revision: result.document.revision, transactionId: transaction.id };
    } catch (error) {
      history.redo.push(transaction);
      return { status: 'conflict', message: error instanceof Error ? error.message : 'Redo failed.' };
    }
  }

  async undoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse> {
    const actor = this.findDocumentAgent(documentId, actorId);
    return actor ? this.undo(documentId, actor) : { status: 'conflict', message: 'That agent has no attributed history in this document.' };
  }

  async redoAgent(documentId: Id, actorId: Id): Promise<ApplyTransactionResponse> {
    const actor = this.findDocumentAgent(documentId, actorId);
    return actor ? this.redo(documentId, actor) : { status: 'conflict', message: 'That agent has no attributed history in this document.' };
  }

  async open(filePaths: string[]): Promise<{ opened: string[]; warnings: string[] }> {
    const opened: string[] = [];
    const warnings: string[] = [];
    for (const filePath of filePaths) {
      try {
        const loaded = await readNativeDocument(filePath);
        const existing = [...this.documents.values()].find((entry) => entry.filePath === filePath);
        if (existing) {
          this.activeDocumentId = existing.id;
          continue;
        }
        this.documents.set(loaded.document.id, loaded.document);
        this.histories.set(loaded.document.id, new Map());
        this.operationIds.set(loaded.document.id, new Map());
        this.changes.set(loaded.document.id, []);
        await this.traceStore?.import(loaded.document.id, loaded.trace);
        this.activeDocumentId = loaded.document.id;
        opened.push(filePath);
        warnings.push(...loaded.warnings);
      } catch (error) {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : 'Could not open file.'}`);
      }
    }
    this.publish();
    return { opened, warnings };
  }

  async save(documentId: Id, filePath: string): Promise<string> {
    const document = this.documents.get(documentId);
    if (!document) throw new Error('Document is not open.');
    const trace = await this.listTrace(documentId);
    const destination = await writeNativeDocument(filePath, document, this.appVersion, (await renderDocument(document)).toBuffer('image/png'), trace);
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
    for (const [lockId, lock] of this.locks) if (lock.documentId === documentId) this.locks.delete(lockId);
    if (this.activeDocumentId === documentId) {
      this.activeDocumentId = [...this.documents.keys()].at(-1);
      if (!this.activeDocumentId) this.create({ kind: 'illustration' });
    }
    await this.journal.remove(documentId);
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
      const timer = setTimeout(() => {
        const current = this.jobs.get(job.id); if (!current || current.status !== 'waiting-for-user') return;
        this.upsertJob({ ...current, status: 'cancelled', updatedAt: nowIso(), message: 'Approval timed out after two minutes.', approval: undefined, error: { code: 'approval_timeout', message: 'The in-app approval expired.', retryable: true } });
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
        : undefined;
    if (objectId && lock.objectIds?.includes(objectId)) return true;
    if (!lock.region) return false;
    const changes = operation.kind === 'pixel.cel.set'
      ? operation.spriteId === lock.region.assetId ? operation.changes : []
      : operation.kind === 'pixel.tilemap.set' && operation.mapId === lock.region.assetId
        ? operation.changes
        : [];
    return changes.some((change) =>
      change.x >= lock.region!.x && change.y >= lock.region!.y &&
      change.x < lock.region!.x + lock.region!.width && change.y < lock.region!.y + lock.region!.height,
    );
  }

  private publish(): void {
    this.emitEvent({ type: 'workspace', snapshot: this.snapshot() });
  }

  private emitEvent(event: WorkspaceEvent): void {
    this.emit('event', event);
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ActorSchema, createId, nowIso, type Actor, type AsyncJob, type CanvasTransaction } from '@aidraw/core';
import type { ApplyTransactionResponse } from '../common/contracts';
import type { DocumentService } from './document-service';

interface BatchState {
  version: 2;
  jobId: string;
  documentId: string;
  documentIncarnationId: string;
  label: string;
  totalTransactions: number;
  nextSequence: number;
  tokenHash: string;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  clientOperationIds: string[];
  transactionIds: string[];
  inFlight?: BatchInFlight;
  message: string;
  error?: AsyncJob['error'];
}

interface BatchInFlight {
  sequence: number;
  clientOperationId: string;
  transactionId: string;
  requestFingerprint: string;
  phase: 'prepared' | 'dispatched';
  cancelRequested: boolean;
}

interface PersistedBatches { version: 2; batches: BatchState[] }

export interface BatchChunkMetadata {
  jobId: string;
  resumeToken: string;
  sequence: number;
}

export interface BatchPreparation {
  accepted: boolean;
  duplicate?: boolean;
  response?: ApplyTransactionResponse;
  expectedSequence?: number;
}

export interface BatchDispatch<T> extends BatchPreparation {
  dispatched?: T;
}

const MAX_BATCHES = 500;
const MAX_BATCH_TRANSACTIONS = 10_000;
const StrictActorSchema = ActorSchema.strict();
const BATCH_LEDGER_KEYS = new Set(['version', 'batches']);
const BATCH_STATE_KEYS = new Set([
  'version', 'jobId', 'documentId', 'documentIncarnationId', 'label', 'totalTransactions', 'nextSequence', 'tokenHash', 'actor',
  'createdAt', 'updatedAt', 'status', 'clientOperationIds', 'transactionIds', 'inFlight', 'message', 'error',
]);
const BATCH_IN_FLIGHT_KEYS = new Set(['sequence', 'clientOperationId', 'transactionId', 'requestFingerprint', 'phase', 'cancelRequested']);
const BATCH_ERROR_KEYS = new Set(['code', 'message', 'retryable']);

export interface BatchManagerOptions {
  /** Narrow deterministic seam for atomic-ledger replacement failure coverage. */
  replaceFile?: (source: string, destination: string) => Promise<void>;
  /** Narrow deterministic seam for fail-closed ledger-read coverage. */
  readStateFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  /** Narrow deterministic seam for retained-ledger pruning coverage. */
  maxBatches?: number;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function writerTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function writerString(value: unknown, maximum?: number): value is string {
  return typeof value === 'string' && value.length > 0 && (maximum === undefined || value.length <= maximum);
}

function writerError(value: unknown): value is NonNullable<AsyncJob['error']> {
  if (!plainRecord(value) || !exactKeys(value, BATCH_ERROR_KEYS)) return false;
  return writerString(value.code) && writerString(value.message) && typeof value.retryable === 'boolean';
}

function writerActor(actor: Actor): Actor {
  const parsed = StrictActorSchema.safeParse(actor);
  if (!parsed.success) throw new Error('The batch actor is invalid.');
  return structuredClone(parsed.data);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: string, expected: string): boolean {
  const actual = Buffer.from(tokenHash(token), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A batch transaction must contain only finite JSON numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!plainRecord(value)) throw new Error('A batch transaction must be a plain JSON value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Stable exact-request identity used only for durable batch reconciliation. */
export function batchTransactionFingerprint(transaction: CanvasTransaction): string {
  let json: string;
  try { json = JSON.stringify(transaction); }
  catch { throw new Error('A batch transaction must be JSON-serializable.'); }
  if (!json) throw new Error('A batch transaction must be JSON-serializable.');
  return createHash('sha256').update(canonicalJson(JSON.parse(json) as unknown)).digest('hex');
}

function isBatchState(value: unknown): value is BatchState {
  if (!plainRecord(value) || !exactKeys(value, BATCH_STATE_KEYS)) return false;
  const state = value;
  if (state.version !== 2 || !writerString(state.jobId) || !writerString(state.documentId)
    || typeof state.documentIncarnationId !== 'string' || !(/^[0-9a-f]{64}$/u.test(state.documentIncarnationId)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(state.documentIncarnationId))
    || !writerString(state.label, 200)
    || typeof state.totalTransactions !== 'number' || !Number.isInteger(state.totalTransactions) || state.totalTransactions < 1 || state.totalTransactions > MAX_BATCH_TRANSACTIONS
    || typeof state.nextSequence !== 'number' || !Number.isInteger(state.nextSequence) || state.nextSequence < 0 || state.nextSequence > state.totalTransactions
    || typeof state.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.tokenHash)
    || !StrictActorSchema.safeParse(state.actor).success || !writerTimestamp(state.createdAt) || !writerTimestamp(state.updatedAt)
    || state.updatedAt < state.createdAt
    || !['queued', 'running', 'completed', 'cancelled', 'failed'].includes(String(state.status)) || !writerString(state.message)
    || !Array.isArray(state.clientOperationIds) || state.clientOperationIds.length !== state.nextSequence
    || state.clientOperationIds.some((id) => !writerString(id, 200))
    || new Set(state.clientOperationIds).size !== state.clientOperationIds.length
    || !Array.isArray(state.transactionIds) || state.transactionIds.length !== state.nextSequence
    || state.transactionIds.some((id) => !writerString(id))
    || (state.error !== undefined && (!writerError(state.error) || !['queued', 'failed'].includes(String(state.status))))) return false;
  if (state.inFlight !== undefined) {
    if (!plainRecord(state.inFlight) || !exactKeys(state.inFlight, BATCH_IN_FLIGHT_KEYS)
      || !Number.isInteger(state.inFlight.sequence) || state.inFlight.sequence !== state.nextSequence
      || state.inFlight.sequence < 0 || state.inFlight.sequence >= state.totalTransactions
      || !writerString(state.inFlight.clientOperationId, 200) || state.clientOperationIds.includes(state.inFlight.clientOperationId)
      || !writerString(state.inFlight.transactionId)
      || typeof state.inFlight.requestFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(state.inFlight.requestFingerprint)
      || !['prepared', 'dispatched'].includes(String(state.inFlight.phase))
      || typeof state.inFlight.cancelRequested !== 'boolean'
      || !['running', 'failed'].includes(String(state.status))
      || state.status === 'failed' && state.inFlight.phase !== 'dispatched') return false;
  } else if (state.status === 'running' || state.status === 'failed') return false;
  if (state.status === 'completed') return state.nextSequence === state.totalTransactions;
  if (state.status === 'cancelled') return state.nextSequence <= state.totalTransactions;
  return state.nextSequence < state.totalTransactions;
}

function isBatchLedger(value: unknown): value is { version: 2; batches: unknown[] } {
  return plainRecord(value) && exactKeys(value, BATCH_LEDGER_KEYS) && value.version === 2 && Array.isArray(value.batches);
}

export class BatchManager {
  private readonly states = new Map<string, BatchState>();
  private readonly liveInFlight = new Map<string, BatchInFlight>();
  private readonly replaceFile: (source: string, destination: string) => Promise<void>;
  private readonly readStateFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly maxBatches: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly documents: DocumentService,
    private readonly statePath: string,
    options: BatchManagerOptions = {},
  ) {
    this.replaceFile = options.replaceFile ?? rename;
    this.readStateFile = options.readStateFile ?? readFile;
    this.maxBatches = options.maxBatches ?? MAX_BATCHES;
    if (!Number.isInteger(this.maxBatches) || this.maxBatches < 1 || this.maxBatches > MAX_BATCHES) {
      throw new Error(`A durable batch manager retains between 1 and ${MAX_BATCHES} batches.`);
    }
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      let parsed: unknown;
      let source: string | undefined;
      try { source = await this.readStateFile(this.statePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (source !== undefined) {
        try { parsed = JSON.parse(source) as unknown; }
        catch (error) {
          throw new Error('The durable batch ledger is malformed; AIDraw preserved it without replacement.', { cause: error });
        }
      }
      const nextStates = new Map<string, BatchState>();
      if (isBatchLedger(parsed)) {
        for (const candidate of parsed.batches.slice(-this.maxBatches)) {
          if (isBatchState(candidate)) nextStates.set(candidate.jobId, structuredClone(candidate));
        }
      }
      for (const state of nextStates.values()) {
        if (!this.hasCurrentDocumentAuthority(state)) this.invalidateDocumentAuthority(state);
        else if (state.inFlight) await this.reconcileInFlight(state);
      }
      await this.commitStates(nextStates);
      // A live owner is process-local proof that the accepted handler may still
      // dispatch or settle this exact chunk. Clear it only after the complete
      // reload is durably accepted; failed reads/reconciliation change nothing.
      this.liveInFlight.clear();
      for (const state of nextStates.values()) this.publishJob(state);
    });
  }

  async start(documentId: string, totalTransactions: number, label: string, actor: Actor): Promise<{ job: AsyncJob; resumeToken: string; nextSequence: number }> {
    return this.exclusive(async () => {
      const documentIncarnationId = this.documents.getDocumentIncarnation(documentId);
      if (!this.documents.getDocument(documentId) || !documentIncarnationId) throw new Error('The batch document is not open.');
      if (!Number.isInteger(totalTransactions) || totalTransactions < 1 || totalTransactions > MAX_BATCH_TRANSACTIONS) throw new Error(`A batch requires 1–${MAX_BATCH_TRANSACTIONS} transactions.`);
      if (!writerString(label, 200)) throw new Error('A batch label requires 1–200 characters.');
      const resumeToken = randomBytes(32).toString('base64url');
      const timestamp = nowIso();
      const state: BatchState = {
        version: 2,
        jobId: createId('job'),
        documentId,
        documentIncarnationId,
        label,
        totalTransactions,
        nextSequence: 0,
        tokenHash: tokenHash(resumeToken),
        actor: writerActor(actor),
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'queued',
        clientOperationIds: [],
        transactionIds: [],
        message: `Ready for transaction 1 of ${totalTransactions}.`,
      };
      const nextStates = new Map(this.states);
      this.prune(nextStates);
      nextStates.set(state.jobId, state);
      await this.commitStates(nextStates);
      const job = this.toJob(state); this.publishJob(state);
      return { job, resumeToken, nextSequence: 0 };
    });
  }

  async resume(jobId: string, resumeToken: string, actor: Actor): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || !tokenMatches(resumeToken, state.tokenHash)) return undefined;
      const nextState = structuredClone(state);
      if (!this.hasCurrentDocumentAuthority(nextState)) {
        this.invalidateDocumentAuthority(nextState);
        const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
        await this.commitStates(nextStates);
        this.liveInFlight.delete(nextState.jobId);
        const job = this.toJob(nextState); this.publishJob(nextState); return job;
      }
      if (nextState.inFlight && !this.hasLiveOwner(nextState)) await this.reconcileInFlight(nextState);
      nextState.actor = writerActor(actor);
      nextState.updatedAt = nowIso();
      nextState.message = nextState.status === 'completed'
        ? 'Batch is already complete.'
        : nextState.status === 'cancelled'
          ? 'Batch was cancelled.'
          : nextState.status === 'failed'
            ? nextState.message
          : nextState.inFlight
            ? `Transaction ${nextState.inFlight.sequence + 1} of ${nextState.totalTransactions} is still running.`
            : `Resume at transaction ${nextState.nextSequence + 1} of ${nextState.totalTransactions}.`;
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates);
      const job = this.toJob(nextState); this.publishJob(nextState); return job;
    });
  }

  /**
   * Resolves an ownerless durable marker before the caller repeats expensive
   * validation. An exact committed trace becomes an idempotent duplicate;
   * only a marker durably proven to remain prepared may reopen its sequence.
   */
  async preflight(metadata: BatchChunkMetadata, documentId: string, clientOperationId: string): Promise<BatchPreparation> {
    return this.exclusive(async () => {
      let state = this.states.get(metadata.jobId);
      const authorityFailure = await this.authorityFailure(state, metadata, documentId);
      if (authorityFailure) return authorityFailure;
      state = await this.reconcileOwnerless(state!);
      return this.preparationDecision(state, metadata, clientOperationId)
        ?? { accepted: true, expectedSequence: state.nextSequence };
    });
  }

  async prepare(metadata: BatchChunkMetadata, transaction: CanvasTransaction, actor: Actor): Promise<BatchPreparation> {
    return this.exclusive(async () => {
      let state = this.states.get(metadata.jobId);
      const authorityFailure = await this.authorityFailure(state, metadata, transaction.documentId);
      if (authorityFailure) return authorityFailure;
      state = await this.reconcileOwnerless(state!);
      const decision = this.preparationDecision(state, metadata, transaction.clientOperationId);
      if (decision) return decision;
      const binding = this.transactionBinding(metadata, transaction);
      const nextState = structuredClone(state);
      nextState.actor = writerActor(actor);
      nextState.inFlight = binding;
      nextState.status = 'running'; nextState.updatedAt = nowIso(); nextState.error = undefined;
      nextState.message = `Running transaction ${metadata.sequence + 1} of ${nextState.totalTransactions}.`;
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates);
      if (!this.hasCurrentDocumentAuthority(nextState)) {
        // The document changed while prepared ownership was being persisted.
        // No callback can exist yet, so retire without mutation.
        const retiredState = structuredClone(nextState);
        this.invalidateDocumentAuthority(retiredState);
        const retiredStates = new Map(this.states); retiredStates.set(retiredState.jobId, retiredState);
        await this.commitStates(retiredStates);
        this.liveInFlight.delete(retiredState.jobId);
        this.publishJob(retiredState);
        return { accepted: false, expectedSequence: retiredState.nextSequence, response: { status: 'conflict', message: 'The batch document incarnation changed during preparation; the old authority was retired without mutation.' } };
      }
      this.liveInFlight.set(nextState.jobId, structuredClone(nextState.inFlight!));
      this.publishJob(nextState);
      return { accepted: true, expectedSequence: nextState.nextSequence };
    });
  }

  /**
   * Durably crosses the first-dispatch boundary, then invokes the scheduler
   * synchronously before cancellation can acquire the batch mutation queue.
   */
  async dispatchPrepared<T>(metadata: BatchChunkMetadata, transaction: CanvasTransaction, dispatch: () => T): Promise<BatchDispatch<T>> {
    return this.exclusive(async () => {
      const state = this.states.get(metadata.jobId);
      const authorityFailure = await this.authorityFailure(state, metadata, transaction.documentId);
      if (authorityFailure) return authorityFailure;
      const binding = this.transactionBinding(metadata, transaction);
      if (!state?.inFlight || !this.sameBinding(state.inFlight, binding) || state.inFlight.phase !== 'prepared') {
        return { accepted: false, expectedSequence: state?.nextSequence, response: { status: state?.status === 'cancelled' ? 'cancelled' : 'conflict', message: state?.status === 'cancelled' ? 'The durable batch was cancelled before dispatch.' : 'The prepared batch transaction no longer owns the dispatch boundary.' } };
      }
      const nextState = structuredClone(state);
      nextState.inFlight!.phase = 'dispatched';
      nextState.updatedAt = nowIso();
      nextState.message = `Dispatched transaction ${metadata.sequence + 1} of ${nextState.totalTransactions}; awaiting its exact outcome.`;
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates);
      if (!this.hasCurrentDocumentAuthority(nextState)) {
        // No callback has run yet, so this specific durable dispatched marker
        // is proven undispatched even if the document changed while the
        // replacement write was pending. Retire it before returning.
        const retiredState = structuredClone(nextState);
        retiredState.inFlight!.phase = 'prepared';
        this.invalidateDocumentAuthority(retiredState);
        const retiredStates = new Map(this.states); retiredStates.set(retiredState.jobId, retiredState);
        await this.commitStates(retiredStates);
        this.liveInFlight.delete(retiredState.jobId);
        this.publishJob(retiredState);
        return { accepted: false, expectedSequence: retiredState.nextSequence, response: { status: 'conflict', message: 'The batch document incarnation changed before scheduler dispatch; the old authority was retired without mutation.' } };
      }
      this.liveInFlight.set(nextState.jobId, structuredClone(nextState.inFlight!));
      this.publishJob(nextState);
      try {
        return { accepted: true, expectedSequence: nextState.nextSequence, dispatched: dispatch() };
      } catch (error) {
        this.forgetLiveOwner(metadata, transaction);
        throw error;
      }
    });
  }

  /** Clears only a chunk the caller proves never reached its first dispatch. */
  async abandonUndispatched(metadata: BatchChunkMetadata, transaction: CanvasTransaction): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const binding = this.transactionBinding(metadata, transaction);
      try {
        const state = this.states.get(metadata.jobId);
        if (!state || !tokenMatches(metadata.resumeToken, state.tokenHash)
          || !state.inFlight || !this.sameBinding(state.inFlight, binding) || state.inFlight.phase !== 'prepared') {
          return state ? this.toJob(state) : undefined;
        }
        const nextState = structuredClone(state);
        nextState.inFlight = undefined;
        nextState.status = 'queued';
        nextState.updatedAt = nowIso();
        nextState.message = `Transaction ${metadata.sequence + 1} was cancelled before dispatch; retry sequence ${metadata.sequence}.`;
        nextState.error = { code: 'batch_cancelled_before_dispatch', message: 'The transaction was cancelled before dispatch and is safe to retry.', retryable: true };
        const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
        await this.commitStates(nextStates);
        const job = this.toJob(nextState); this.publishJob(nextState); return job;
      } finally {
        const live = this.liveInFlight.get(metadata.jobId);
        if (live?.phase === 'prepared' && this.sameBinding(live, binding)) this.liveInFlight.delete(metadata.jobId);
      }
    });
  }

  async finish(metadata: BatchChunkMetadata, transaction: CanvasTransaction, response: ApplyTransactionResponse): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const binding = this.transactionBinding(metadata, transaction);
      try {
        const state = this.states.get(metadata.jobId);
        if (!state || !state.inFlight || !this.sameBinding(state.inFlight, binding) || state.inFlight.phase !== 'dispatched') return state ? this.toJob(state) : undefined;
        const persistedBinding = structuredClone(state.inFlight);
        const nextState = structuredClone(state);
        nextState.updatedAt = nowIso();
        if (!this.hasCurrentDocumentAuthority(nextState)) {
          if (response.status === 'committed' && response.transactionId === binding.transactionId) {
            this.advanceCommitted(nextState, persistedBinding, false);
            nextState.status = 'cancelled';
            nextState.message = `The exact settled transaction belonged to a retired document incarnation; ${nextState.nextSequence} committed transaction${nextState.nextSequence === 1 ? '' : 's'} remain recorded, but this batch cannot continue against the replacement.`;
          } else if (response.status === 'cancelled' || response.status === 'busy' || response.status === 'locked') {
            nextState.inFlight = undefined;
            nextState.status = 'cancelled';
            nextState.error = undefined;
            nextState.message = 'The dispatched transaction was proven not committed before its document incarnation retired; this batch cannot continue against the replacement.';
          } else {
            this.invalidateDocumentAuthority(nextState);
          }
        } else if (response.status === 'committed' && response.transactionId === binding.transactionId) {
          this.advanceCommitted(nextState, persistedBinding, false);
        } else if (response.status === 'duplicate' || response.status === 'conflict') {
          const exact = await this.exactCommittedTrace(nextState.documentId, persistedBinding);
          if (exact) this.advanceCommitted(nextState, persistedBinding, true);
          else this.markAmbiguous(nextState, persistedBinding, response.status === 'duplicate'
            ? 'The document reported a duplicate operation without the exact transaction-bound durable evidence required by this batch.'
            : 'The dispatched transaction returned a conflict, but AIDraw cannot prove that no canonical mutation occurred.');
        } else if (response.status === 'cancelled' || response.status === 'busy' || response.status === 'locked') {
          const cancelled = persistedBinding.cancelRequested;
          nextState.inFlight = undefined;
          nextState.status = cancelled ? 'cancelled' : 'queued';
          nextState.message = cancelled
            ? `Cancelled after ${nextState.nextSequence} of ${nextState.totalTransactions} committed transactions.`
            : `Transaction ${metadata.sequence + 1} was proven not committed; retry sequence ${metadata.sequence}.`;
          nextState.error = cancelled ? undefined : { code: `batch_${response.status}`, message: response.message ?? 'The transaction did not commit.', retryable: true };
        } else {
          this.markAmbiguous(nextState, persistedBinding, 'The dispatched transaction did not return its exact durable transaction identity.');
        }
        const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
        await this.commitStates(nextStates); const job = this.toJob(nextState); this.publishJob(nextState); return job;
      } finally {
        // finish() is called only after the dispatch outcome has settled. If
        // ledger replacement fails, a following preflight owns reconciliation.
        this.forgetLiveOwner(metadata, transaction);
      }
    });
  }

  async cancel(jobId: string, actorId: string): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || state.actor.id !== actorId) return undefined;
      const nextState = structuredClone(state);
      if (!this.hasCurrentDocumentAuthority(nextState)) {
        this.invalidateDocumentAuthority(nextState);
        const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
        await this.commitStates(nextStates);
        this.liveInFlight.delete(nextState.jobId);
        const job = this.toJob(nextState); this.publishJob(nextState); return job;
      }
      if (nextState.status !== 'completed' && nextState.status !== 'cancelled') {
        if (nextState.inFlight?.phase === 'dispatched') {
          nextState.inFlight.cancelRequested = true;
          if (nextState.status !== 'failed') nextState.status = 'running';
          nextState.updatedAt = nowIso();
          nextState.message = `Cancellation requested after dispatch; waiting for the exact transaction outcome before finalizing ${nextState.nextSequence} of ${nextState.totalTransactions}.`;
        } else {
          nextState.status = 'cancelled'; nextState.inFlight = undefined; nextState.updatedAt = nowIso(); nextState.message = `Cancelled after ${nextState.nextSequence} of ${nextState.totalTransactions} committed transactions.`; nextState.error = undefined;
        }
      }
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates);
      if (!nextState.inFlight) this.liveInFlight.delete(nextState.jobId);
      else if (this.liveInFlight.has(nextState.jobId)) this.liveInFlight.set(nextState.jobId, structuredClone(nextState.inFlight));
      const job = this.toJob(nextState); this.publishJob(nextState); return job;
    });
  }

  async flush(): Promise<void> { await this.mutationQueue; }

  private async reconcileInFlight(state: BatchState): Promise<void> {
    const inFlight = state.inFlight!;
    const committed = await this.exactCommittedTrace(state.documentId, inFlight);
    if (committed) this.advanceCommitted(state, inFlight, true);
    else if (inFlight.phase === 'prepared') {
      state.inFlight = undefined;
      state.status = 'queued';
      state.error = { code: 'batch_recovered_before_dispatch', message: 'The prepared transaction never crossed its durable dispatch boundary and is safe to retry.', retryable: true };
      state.message = `Recovered transaction ${inFlight.sequence + 1} before dispatch; retry sequence ${inFlight.sequence}.`;
    } else {
      this.markAmbiguous(state, inFlight, 'AIDraw cannot prove whether the exact dispatched transaction committed; the batch will not replay it.');
    }
    state.updatedAt = nowIso();
  }

  private async authorityFailure(state: BatchState | undefined, metadata: BatchChunkMetadata, documentId: string): Promise<BatchPreparation | undefined> {
    if (!state || !tokenMatches(metadata.resumeToken, state.tokenHash)) return { accepted: false, response: { status: 'conflict', message: 'Batch resume authority is invalid.' } };
    if (state.documentId !== documentId) return { accepted: false, response: { status: 'conflict', message: 'This batch belongs to a different document.' } };
    if (!this.hasCurrentDocumentAuthority(state)) {
      const nextState = structuredClone(state);
      if (this.invalidateDocumentAuthority(nextState)) {
        const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
        await this.commitStates(nextStates);
        this.liveInFlight.delete(nextState.jobId);
        this.publishJob(nextState);
      }
      return { accepted: false, expectedSequence: nextState.nextSequence, response: { status: 'conflict', transactionId: nextState.inFlight?.transactionId, message: 'This batch belongs to a different document incarnation and cannot dispatch or replay against the replacement.' } };
    }
    return undefined;
  }

  private hasCurrentDocumentAuthority(state: BatchState): boolean {
    return this.documents.getDocumentIncarnation(state.documentId) === state.documentIncarnationId;
  }

  private invalidateDocumentAuthority(state: BatchState): boolean {
    if (state.status === 'completed' || state.status === 'cancelled'
      || state.status === 'failed' && state.error?.code === 'batch_document_incarnation_changed') return false;
    const dispatched = state.inFlight?.phase === 'dispatched';
    state.updatedAt = nowIso();
    if (dispatched) {
      state.status = 'failed';
      state.message = 'The bound document incarnation was replaced while an exact dispatched outcome remained unresolved; AIDraw will not replay it.';
      state.error = { code: 'batch_document_incarnation_changed', message: state.message, retryable: false };
    } else {
      state.inFlight = undefined;
      state.status = 'cancelled';
      state.message = `The bound document incarnation closed or was replaced after ${state.nextSequence} committed transaction${state.nextSequence === 1 ? '' : 's'}; this authority is retired.`;
      state.error = undefined;
    }
    return true;
  }

  private preparationDecision(state: BatchState, metadata: BatchChunkMetadata, clientOperationId: string): BatchPreparation | undefined {
    if (state.status === 'cancelled') return { accepted: false, response: { status: 'cancelled', message: 'The durable batch was cancelled.' } };
    if (state.status === 'completed') {
      const duplicate = metadata.sequence < state.nextSequence && state.clientOperationIds[metadata.sequence] === clientOperationId;
      return { accepted: false, duplicate, expectedSequence: state.nextSequence, response: duplicate ? { status: 'duplicate', transactionId: state.transactionIds[metadata.sequence], message: 'This batch transaction was already committed.' } : { status: 'conflict', message: 'The durable batch is already complete.' } };
    }
    if (metadata.sequence < state.nextSequence) {
      const duplicate = state.clientOperationIds[metadata.sequence] === clientOperationId;
      return { accepted: false, duplicate, expectedSequence: state.nextSequence, response: duplicate ? { status: 'duplicate', transactionId: state.transactionIds[metadata.sequence], message: 'This batch transaction was already committed.' } : { status: 'conflict', message: `Batch sequence ${metadata.sequence} is already occupied by another operation.` } };
    }
    if (metadata.sequence !== state.nextSequence) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'conflict', message: `Expected batch sequence ${state.nextSequence}, received ${metadata.sequence}.` } };
    const priorSequence = state.clientOperationIds.indexOf(clientOperationId);
    if (priorSequence >= 0) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'conflict', message: `This clientOperationId was already committed at batch sequence ${priorSequence}; use a fresh idempotency key for sequence ${state.nextSequence}.` } };
    if (state.status === 'failed' && state.inFlight) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'conflict', transactionId: state.inFlight.transactionId, message: state.error?.message ?? 'The exact dispatched batch outcome is ambiguous and will not be replayed.' } };
    if (state.inFlight) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'busy', transactionId: state.inFlight.transactionId, message: 'The expected batch transaction is already in flight.' } };
    if (!writerString(clientOperationId, 200)) throw new Error('A batch clientOperationId requires 1–200 characters.');
    return undefined;
  }

  private hasLiveOwner(state: BatchState): boolean {
    const live = this.liveInFlight.get(state.jobId);
    return Boolean(live && state.inFlight && this.sameBinding(live, state.inFlight));
  }

  private forgetLiveOwner(metadata: BatchChunkMetadata, transaction: CanvasTransaction): void {
    const live = this.liveInFlight.get(metadata.jobId);
    const binding = this.transactionBinding(metadata, transaction);
    if (live && this.sameBinding(live, binding)) this.liveInFlight.delete(metadata.jobId);
  }

  private async reconcileOwnerless(state: BatchState): Promise<BatchState> {
    if (!state.inFlight || this.hasLiveOwner(state)) return state;
    const nextState = structuredClone(state);
    await this.reconcileInFlight(nextState);
    const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
    await this.commitStates(nextStates);
    this.publishJob(nextState);
    return nextState;
  }

  private transactionBinding(metadata: BatchChunkMetadata, transaction: CanvasTransaction): BatchInFlight {
    if (transaction.clientOperationId.length < 1 || transaction.clientOperationId.length > 200) throw new Error('A batch clientOperationId requires 1–200 characters.');
    if (!writerString(transaction.id)) throw new Error('A batch transaction requires a durable transaction identity.');
    return {
      sequence: metadata.sequence,
      clientOperationId: transaction.clientOperationId,
      transactionId: transaction.id,
      requestFingerprint: batchTransactionFingerprint(transaction),
      phase: 'prepared',
      cancelRequested: false,
    };
  }

  private sameBinding(left: BatchInFlight, right: BatchInFlight): boolean {
    return left.sequence === right.sequence
      && left.clientOperationId === right.clientOperationId
      && left.transactionId === right.transactionId
      && left.requestFingerprint === right.requestFingerprint;
  }

  private async exactCommittedTrace(documentId: string, binding: BatchInFlight): Promise<boolean> {
    const entry = await this.documents.findTrace(documentId, binding.transactionId);
    if (!entry || entry.documentId !== documentId || !['committed', 'partial'].includes(entry.outcome)) return false;
    return entry.transaction.clientOperationId === binding.clientOperationId
      && entry.requestFingerprint === binding.requestFingerprint;
  }

  private advanceCommitted(state: BatchState, binding: BatchInFlight, recovered: boolean): void {
    state.inFlight = undefined;
    state.clientOperationIds[binding.sequence] = binding.clientOperationId;
    state.transactionIds[binding.sequence] = binding.transactionId;
    state.nextSequence = Math.max(state.nextSequence, binding.sequence + 1);
    if (binding.cancelRequested) {
      state.status = 'cancelled';
      state.message = `Cancellation retained ${state.nextSequence} committed transaction${state.nextSequence === 1 ? '' : 's'}; no dispatched work was lost or replayed.`;
    } else {
      state.status = state.nextSequence >= state.totalTransactions ? 'completed' : 'queued';
      state.message = state.status === 'completed'
        ? `${recovered ? 'Recovered and completed' : 'Completed'} all ${state.totalTransactions} transactions.`
        : `${recovered ? 'Recovered' : 'Committed'} ${state.nextSequence} of ${state.totalTransactions}; ready for transaction ${state.nextSequence + 1}.`;
    }
    state.error = undefined;
  }

  private markAmbiguous(state: BatchState, binding: BatchInFlight, message: string): void {
    state.inFlight = { ...structuredClone(binding), phase: 'dispatched' };
    state.status = 'failed';
    state.message = message;
    state.error = { code: 'batch_ambiguous_outcome', message, retryable: false };
  }

  private publishJob(state: BatchState): void {
    try { this.documents.upsertJob(this.toJob(state)); }
    catch {
      // Durable batch truth is the private atomic ledger. Renderer/job events
      // are advisory and must not strand an already persisted ownership phase.
    }
  }

  private toJob(state: BatchState): AsyncJob {
    return {
      id: state.jobId,
      kind: 'batch',
      status: state.status,
      actor: structuredClone(state.actor),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      progress: state.totalTransactions ? state.nextSequence / state.totalTransactions : 0,
      message: state.message,
      error: state.error ? structuredClone(state.error) : undefined,
      result: { documentId: state.documentId, label: state.label, totalTransactions: state.totalTransactions, nextSequence: state.nextSequence, transactionIds: [...state.transactionIds] },
    };
  }

  private prune(states: Map<string, BatchState>): void {
    if (states.size < this.maxBatches) return;
    const removable = [...states.values()].filter((state) => state.status === 'completed' || state.status === 'cancelled').sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const state of removable) { if (states.size < this.maxBatches) break; states.delete(state.jobId); }
    if (states.size >= this.maxBatches) throw new Error(`AIDraw retains at most ${this.maxBatches} durable batches; finish or cancel an existing batch first.`);
  }

  private replaceStates(states: ReadonlyMap<string, BatchState>): void {
    this.states.clear();
    for (const [jobId, state] of states) this.states.set(jobId, state);
  }

  private async commitStates(states: Map<string, BatchState>): Promise<void> {
    await this.persist(states);
    this.replaceStates(states);
    const staleJobIds = this.documents.listJobs()
      .filter((job) => job.kind === 'batch' && !states.has(job.id))
      .map((job) => job.id);
    try { this.documents.removeJobs(staleJobIds, 'batch'); }
    catch {
      // The atomic private ledger is authoritative; public mirrors are advisory.
    }
  }

  private async persist(states: ReadonlyMap<string, BatchState>): Promise<void> {
    const contents = `${JSON.stringify({ version: 2, batches: [...states.values()] } satisfies PersistedBatches, null, 2)}\n`;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.replaceFile(temporary, this.statePath);
    } catch (error) {
      try { await handle?.close(); } catch { /* Preserve the primary persistence failure. */ }
      try { await unlink(temporary); } catch { /* The temporary may not exist or may already be replaced. */ }
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

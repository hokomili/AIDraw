import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ActorSchema, createId, nowIso, type Actor, type AsyncJob } from '@aidraw/core';
import type { ApplyTransactionResponse } from '../common/contracts';
import type { DocumentService } from './document-service';

interface BatchState {
  version: 1;
  jobId: string;
  documentId: string;
  label: string;
  totalTransactions: number;
  nextSequence: number;
  tokenHash: string;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled';
  clientOperationIds: string[];
  transactionIds: string[];
  inFlight?: { sequence: number; clientOperationId: string };
  message: string;
  error?: AsyncJob['error'];
}

interface PersistedBatches { version: 1; batches: BatchState[] }

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

const MAX_BATCHES = 500;
const MAX_BATCH_TRANSACTIONS = 10_000;
const StrictActorSchema = ActorSchema.strict();
const BATCH_LEDGER_KEYS = new Set(['version', 'batches']);
const BATCH_STATE_KEYS = new Set([
  'version', 'jobId', 'documentId', 'label', 'totalTransactions', 'nextSequence', 'tokenHash', 'actor',
  'createdAt', 'updatedAt', 'status', 'clientOperationIds', 'transactionIds', 'inFlight', 'message', 'error',
]);
const BATCH_IN_FLIGHT_KEYS = new Set(['sequence', 'clientOperationId']);
const BATCH_ERROR_KEYS = new Set(['code', 'message', 'retryable']);

export interface BatchManagerOptions {
  /** Narrow deterministic seam for atomic-ledger replacement failure coverage. */
  replaceFile?: (source: string, destination: string) => Promise<void>;
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

function isBatchState(value: unknown): value is BatchState {
  if (!plainRecord(value) || !exactKeys(value, BATCH_STATE_KEYS)) return false;
  const state = value;
  if (state.version !== 1 || !writerString(state.jobId) || !writerString(state.documentId) || !writerString(state.label, 200)
    || typeof state.totalTransactions !== 'number' || !Number.isInteger(state.totalTransactions) || state.totalTransactions < 1 || state.totalTransactions > MAX_BATCH_TRANSACTIONS
    || typeof state.nextSequence !== 'number' || !Number.isInteger(state.nextSequence) || state.nextSequence < 0 || state.nextSequence > state.totalTransactions
    || typeof state.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.tokenHash)
    || !StrictActorSchema.safeParse(state.actor).success || !writerTimestamp(state.createdAt) || !writerTimestamp(state.updatedAt)
    || state.updatedAt < state.createdAt
    || !['queued', 'running', 'completed', 'cancelled'].includes(String(state.status)) || !writerString(state.message)
    || !Array.isArray(state.clientOperationIds) || state.clientOperationIds.length !== state.nextSequence
    || state.clientOperationIds.some((id) => !writerString(id, 200))
    || new Set(state.clientOperationIds).size !== state.clientOperationIds.length
    || !Array.isArray(state.transactionIds) || state.transactionIds.length !== state.nextSequence
    || state.transactionIds.some((id) => !writerString(id))
    || (state.error !== undefined && (!writerError(state.error) || state.status !== 'queued'))) return false;
  if (state.inFlight !== undefined) {
    if (!plainRecord(state.inFlight) || !exactKeys(state.inFlight, BATCH_IN_FLIGHT_KEYS)
      || !Number.isInteger(state.inFlight.sequence) || state.inFlight.sequence !== state.nextSequence
      || state.inFlight.sequence < 0 || state.inFlight.sequence >= state.totalTransactions
      || !writerString(state.inFlight.clientOperationId, 200) || state.clientOperationIds.includes(state.inFlight.clientOperationId)
      || state.status !== 'running') return false;
  } else if (state.status === 'running') return false;
  return state.status === 'completed' ? state.nextSequence === state.totalTransactions : state.nextSequence < state.totalTransactions;
}

function isBatchLedger(value: unknown): value is { version: 1; batches: unknown[] } {
  return plainRecord(value) && exactKeys(value, BATCH_LEDGER_KEYS) && value.version === 1 && Array.isArray(value.batches);
}

export class BatchManager {
  private readonly states = new Map<string, BatchState>();
  private readonly replaceFile: (source: string, destination: string) => Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly documents: DocumentService,
    private readonly statePath: string,
    options: BatchManagerOptions = {},
  ) {
    this.replaceFile = options.replaceFile ?? rename;
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown; } catch { parsed = undefined; }
      const nextStates = new Map<string, BatchState>();
      if (isBatchLedger(parsed)) {
        for (const candidate of parsed.batches.slice(-MAX_BATCHES)) {
          if (isBatchState(candidate)) nextStates.set(candidate.jobId, structuredClone(candidate));
        }
      }
      for (const state of nextStates.values()) {
        if (state.inFlight) await this.reconcileInFlight(state);
      }
      await this.commitStates(nextStates);
      for (const state of nextStates.values()) this.documents.upsertJob(this.toJob(state));
    });
  }

  async start(documentId: string, totalTransactions: number, label: string, actor: Actor): Promise<{ job: AsyncJob; resumeToken: string; nextSequence: number }> {
    return this.exclusive(async () => {
      if (!this.documents.getDocument(documentId)) throw new Error('The batch document is not open.');
      if (!Number.isInteger(totalTransactions) || totalTransactions < 1 || totalTransactions > MAX_BATCH_TRANSACTIONS) throw new Error(`A batch requires 1–${MAX_BATCH_TRANSACTIONS} transactions.`);
      if (!writerString(label, 200)) throw new Error('A batch label requires 1–200 characters.');
      const resumeToken = randomBytes(32).toString('base64url');
      const timestamp = nowIso();
      const state: BatchState = {
        version: 1,
        jobId: createId('job'),
        documentId,
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
      const job = this.toJob(state); this.documents.upsertJob(job);
      return { job, resumeToken, nextSequence: 0 };
    });
  }

  async resume(jobId: string, resumeToken: string, actor: Actor): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || !tokenMatches(resumeToken, state.tokenHash)) return undefined;
      const nextState = structuredClone(state);
      nextState.actor = writerActor(actor);
      nextState.updatedAt = nowIso();
      nextState.message = nextState.status === 'completed' ? 'Batch is already complete.' : nextState.status === 'cancelled' ? 'Batch was cancelled.' : `Resume at transaction ${nextState.nextSequence + 1} of ${nextState.totalTransactions}.`;
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates);
      const job = this.toJob(nextState); this.documents.upsertJob(job); return job;
    });
  }

  async prepare(metadata: BatchChunkMetadata, documentId: string, clientOperationId: string, actor: Actor): Promise<BatchPreparation> {
    return this.exclusive(async () => {
      const state = this.states.get(metadata.jobId);
      if (!state || !tokenMatches(metadata.resumeToken, state.tokenHash)) return { accepted: false, response: { status: 'conflict', message: 'Batch resume authority is invalid.' } };
      if (state.documentId !== documentId) return { accepted: false, response: { status: 'conflict', message: 'This batch belongs to a different document.' } };
      if (state.status === 'cancelled') return { accepted: false, response: { status: 'cancelled', message: 'The durable batch was cancelled.' } };
      if (state.status === 'completed') {
        const duplicate = metadata.sequence < state.nextSequence && state.clientOperationIds[metadata.sequence] === clientOperationId;
        return { accepted: false, duplicate, expectedSequence: state.nextSequence, response: duplicate ? { status: 'duplicate', message: 'This batch transaction was already committed.' } : { status: 'conflict', message: 'The durable batch is already complete.' } };
      }
      if (metadata.sequence < state.nextSequence) {
        const duplicate = state.clientOperationIds[metadata.sequence] === clientOperationId;
        return { accepted: false, duplicate, expectedSequence: state.nextSequence, response: duplicate ? { status: 'duplicate', message: 'This batch transaction was already committed.' } : { status: 'conflict', message: `Batch sequence ${metadata.sequence} is already occupied by another operation.` } };
      }
      if (metadata.sequence !== state.nextSequence) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'conflict', message: `Expected batch sequence ${state.nextSequence}, received ${metadata.sequence}.` } };
      const priorSequence = state.clientOperationIds.indexOf(clientOperationId);
      if (priorSequence >= 0) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'conflict', message: `This clientOperationId was already committed at batch sequence ${priorSequence}; use a fresh idempotency key for sequence ${state.nextSequence}.` } };
      if (state.inFlight) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'busy', message: 'The expected batch transaction is already in flight.' } };
      if (!writerString(clientOperationId, 200)) throw new Error('A batch clientOperationId requires 1–200 characters.');
      const nextState = structuredClone(state);
      nextState.actor = writerActor(actor);
      nextState.inFlight = { sequence: metadata.sequence, clientOperationId };
      nextState.status = 'running'; nextState.updatedAt = nowIso(); nextState.error = undefined;
      nextState.message = `Running transaction ${metadata.sequence + 1} of ${nextState.totalTransactions}.`;
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates); this.documents.upsertJob(this.toJob(nextState));
      return { accepted: true, expectedSequence: nextState.nextSequence };
    });
  }

  async finish(metadata: BatchChunkMetadata, clientOperationId: string, response: ApplyTransactionResponse): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(metadata.jobId);
      if (!state || state.inFlight?.sequence !== metadata.sequence || state.inFlight.clientOperationId !== clientOperationId) return state ? this.toJob(state) : undefined;
      const nextState = structuredClone(state);
      nextState.inFlight = undefined;
      nextState.updatedAt = nowIso();
      const committed = response.status === 'committed' || response.status === 'duplicate';
      if (committed && writerString(response.transactionId)) {
        nextState.clientOperationIds[metadata.sequence] = clientOperationId;
        nextState.transactionIds[metadata.sequence] = response.transactionId;
        nextState.nextSequence = metadata.sequence + 1;
        nextState.status = nextState.nextSequence >= nextState.totalTransactions ? 'completed' : 'queued';
        nextState.message = nextState.status === 'completed' ? `Completed all ${nextState.totalTransactions} transactions.` : `Committed ${nextState.nextSequence} of ${nextState.totalTransactions}; ready for transaction ${nextState.nextSequence + 1}.`;
        nextState.error = undefined;
      } else {
        nextState.status = 'queued';
        nextState.message = `Transaction ${metadata.sequence + 1} did not commit; retry sequence ${metadata.sequence}.`;
        nextState.error = committed
          ? { code: 'batch_invalid_result', message: 'The committed transaction did not include its durable transaction identity.', retryable: true }
          : { code: `batch_${response.status}`, message: response.message ?? 'The transaction did not commit.', retryable: response.status !== 'cancelled' };
      }
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates); const job = this.toJob(nextState); this.documents.upsertJob(job); return job;
    });
  }

  async cancel(jobId: string, actorId: string): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || state.actor.id !== actorId) return undefined;
      const nextState = structuredClone(state);
      if (nextState.status !== 'completed') { nextState.status = 'cancelled'; nextState.inFlight = undefined; nextState.updatedAt = nowIso(); nextState.message = `Cancelled after ${nextState.nextSequence} of ${nextState.totalTransactions} committed transactions.`; nextState.error = undefined; }
      const nextStates = new Map(this.states); nextStates.set(nextState.jobId, nextState);
      await this.commitStates(nextStates); const job = this.toJob(nextState); this.documents.upsertJob(job); return job;
    });
  }

  async flush(): Promise<void> { await this.mutationQueue; }

  private async reconcileInFlight(state: BatchState): Promise<void> {
    const inFlight = state.inFlight!;
    const trace = await this.documents.listTrace(state.documentId);
    const committed = trace.find((entry) => entry.transaction.clientOperationId === inFlight.clientOperationId && (entry.outcome === 'committed' || entry.outcome === 'partial'));
    state.inFlight = undefined;
    if (committed) {
      state.clientOperationIds[inFlight.sequence] = inFlight.clientOperationId;
      state.transactionIds[inFlight.sequence] = committed.transaction.id;
      state.nextSequence = Math.max(state.nextSequence, inFlight.sequence + 1);
      state.status = state.nextSequence >= state.totalTransactions ? 'completed' : 'queued';
      state.message = state.status === 'completed' ? `Recovered completed batch of ${state.totalTransactions} transactions.` : `Recovered ${state.nextSequence} of ${state.totalTransactions}; resume at transaction ${state.nextSequence + 1}.`;
    } else {
      state.status = 'queued';
      state.message = `Recovered interrupted transaction ${inFlight.sequence + 1}; retry sequence ${inFlight.sequence}.`;
    }
    state.updatedAt = nowIso();
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
    if (states.size < MAX_BATCHES) return;
    const removable = [...states.values()].filter((state) => state.status === 'completed' || state.status === 'cancelled').sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const state of removable) { if (states.size < MAX_BATCHES) break; states.delete(state.jobId); }
    if (states.size >= MAX_BATCHES) throw new Error(`AIDraw retains at most ${MAX_BATCHES} durable batches; finish or cancel an existing batch first.`);
  }

  private replaceStates(states: ReadonlyMap<string, BatchState>): void {
    this.states.clear();
    for (const [jobId, state] of states) this.states.set(jobId, state);
  }

  private async commitStates(states: Map<string, BatchState>): Promise<void> {
    await this.persist(states);
    this.replaceStates(states);
  }

  private async persist(states: ReadonlyMap<string, BatchState>): Promise<void> {
    const contents = `${JSON.stringify({ version: 1, batches: [...states.values()] } satisfies PersistedBatches, null, 2)}\n`;
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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createId, nowIso, type Actor, type AsyncJob } from '@aidraw/core';
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

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: string, expected: string): boolean {
  const actual = Buffer.from(tokenHash(token), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function isBatchState(value: unknown): value is BatchState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<BatchState>;
  return state.version === 1 && typeof state.jobId === 'string' && typeof state.documentId === 'string' && typeof state.label === 'string'
    && Number.isInteger(state.totalTransactions) && Number(state.totalTransactions) >= 1 && Number(state.totalTransactions) <= MAX_BATCH_TRANSACTIONS
    && Number.isInteger(state.nextSequence) && Number(state.nextSequence) >= 0 && Number(state.nextSequence) <= Number(state.totalTransactions)
    && typeof state.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(state.tokenHash)
    && Boolean(state.actor && typeof state.actor.id === 'string') && ['queued', 'running', 'completed', 'cancelled'].includes(String(state.status))
    && Array.isArray(state.clientOperationIds) && Array.isArray(state.transactionIds);
}

export class BatchManager {
  private readonly states = new Map<string, BatchState>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly documents: DocumentService, private readonly statePath: string) {}

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      let parsed: PersistedBatches | undefined;
      try { parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedBatches; } catch { parsed = undefined; }
      if (parsed?.version === 1 && Array.isArray(parsed.batches)) {
        for (const candidate of parsed.batches.slice(-MAX_BATCHES)) if (isBatchState(candidate)) this.states.set(candidate.jobId, structuredClone(candidate));
      }
      for (const state of this.states.values()) {
        if (state.inFlight) await this.reconcileInFlight(state);
        this.documents.upsertJob(this.toJob(state));
      }
      await this.persist();
    });
  }

  async start(documentId: string, totalTransactions: number, label: string, actor: Actor): Promise<{ job: AsyncJob; resumeToken: string; nextSequence: number }> {
    return this.exclusive(async () => {
      if (!this.documents.getDocument(documentId)) throw new Error('The batch document is not open.');
      if (!Number.isInteger(totalTransactions) || totalTransactions < 1 || totalTransactions > MAX_BATCH_TRANSACTIONS) throw new Error(`A batch requires 1–${MAX_BATCH_TRANSACTIONS} transactions.`);
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
        actor: structuredClone(actor),
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'queued',
        clientOperationIds: [],
        transactionIds: [],
        message: `Ready for transaction 1 of ${totalTransactions}.`,
      };
      this.prune();
      this.states.set(state.jobId, state);
      await this.persist();
      const job = this.toJob(state); this.documents.upsertJob(job);
      return { job, resumeToken, nextSequence: 0 };
    });
  }

  async resume(jobId: string, resumeToken: string, actor: Actor): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || !tokenMatches(resumeToken, state.tokenHash)) return undefined;
      state.actor = structuredClone(actor);
      state.updatedAt = nowIso();
      state.message = state.status === 'completed' ? 'Batch is already complete.' : state.status === 'cancelled' ? 'Batch was cancelled.' : `Resume at transaction ${state.nextSequence + 1} of ${state.totalTransactions}.`;
      await this.persist();
      const job = this.toJob(state); this.documents.upsertJob(job); return job;
    });
  }

  async prepare(metadata: BatchChunkMetadata, documentId: string, clientOperationId: string, actor: Actor): Promise<BatchPreparation> {
    return this.exclusive(async () => {
      const state = this.states.get(metadata.jobId);
      if (!state || !tokenMatches(metadata.resumeToken, state.tokenHash)) return { accepted: false, response: { status: 'conflict', message: 'Batch credentials are invalid.' } };
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
      if (state.inFlight) return { accepted: false, expectedSequence: state.nextSequence, response: { status: 'busy', message: 'The expected batch transaction is already in flight.' } };
      state.actor = structuredClone(actor);
      state.inFlight = { sequence: metadata.sequence, clientOperationId };
      state.status = 'running'; state.updatedAt = nowIso(); state.error = undefined;
      state.message = `Running transaction ${metadata.sequence + 1} of ${state.totalTransactions}.`;
      await this.persist(); this.documents.upsertJob(this.toJob(state));
      return { accepted: true, expectedSequence: state.nextSequence };
    });
  }

  async finish(metadata: BatchChunkMetadata, clientOperationId: string, response: ApplyTransactionResponse): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(metadata.jobId);
      if (!state || state.inFlight?.sequence !== metadata.sequence || state.inFlight.clientOperationId !== clientOperationId) return state ? this.toJob(state) : undefined;
      state.inFlight = undefined;
      state.updatedAt = nowIso();
      if (response.status === 'committed' || response.status === 'duplicate') {
        state.clientOperationIds[metadata.sequence] = clientOperationId;
        if (response.transactionId) state.transactionIds[metadata.sequence] = response.transactionId;
        state.nextSequence = metadata.sequence + 1;
        state.status = state.nextSequence >= state.totalTransactions ? 'completed' : 'queued';
        state.message = state.status === 'completed' ? `Completed all ${state.totalTransactions} transactions.` : `Committed ${state.nextSequence} of ${state.totalTransactions}; ready for transaction ${state.nextSequence + 1}.`;
        state.error = undefined;
      } else {
        state.status = 'queued';
        state.message = `Transaction ${metadata.sequence + 1} did not commit; retry sequence ${metadata.sequence}.`;
        state.error = { code: `batch_${response.status}`, message: response.message ?? 'The transaction did not commit.', retryable: response.status !== 'cancelled' };
      }
      await this.persist(); const job = this.toJob(state); this.documents.upsertJob(job); return job;
    });
  }

  async cancel(jobId: string, actorId: string): Promise<AsyncJob | undefined> {
    return this.exclusive(async () => {
      const state = this.states.get(jobId);
      if (!state || state.actor.id !== actorId) return undefined;
      if (state.status !== 'completed') { state.status = 'cancelled'; state.inFlight = undefined; state.updatedAt = nowIso(); state.message = `Cancelled after ${state.nextSequence} of ${state.totalTransactions} committed transactions.`; state.error = undefined; }
      await this.persist(); const job = this.toJob(state); this.documents.upsertJob(job); return job;
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

  private prune(): void {
    if (this.states.size < MAX_BATCHES) return;
    const removable = [...this.states.values()].filter((state) => state.status === 'completed' || state.status === 'cancelled').sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const state of removable) { if (this.states.size < MAX_BATCHES) break; this.states.delete(state.jobId); }
    if (this.states.size >= MAX_BATCHES) throw new Error(`AIDraw retains at most ${MAX_BATCHES} durable batches; finish or cancel an existing batch first.`);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, batches: [...this.states.values()] } satisfies PersistedBatches, null, 2), 'utf8');
    await rename(temporary, this.statePath);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

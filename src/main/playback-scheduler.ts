import type { CanvasOperation, CanvasTransaction, PointSample } from '@aidraw/core';
import type { ApplyTransactionResponse } from '../common/contracts';
import { DocumentService, type ApplyOptions } from './document-service';
import { MAX_INLINE_ASSET_BYTES, MAX_TRANSACTION_IMAGE_DECODE_MS, MAX_TRANSACTION_IMAGE_DECODES } from './transaction-policy';

interface PlaybackTask {
  transaction: CanvasTransaction;
  applyOptions: ApplyOptions;
  documentIncarnationId: string;
  resolve: (response: ApplyTransactionResponse) => void;
  cancelled: boolean;
  progress: number;
  lane?: number;
  reservedSamples: number;
  playbackSamples: number;
  publicReservationId?: symbol;
}

const MAX_LANES = 4;
const MAX_QUEUED_PER_ACTOR = 4;
const MAX_GLOBAL_SAMPLES = 1_000_000;
const MAX_CONCURRENT_REPLAYS = 1;
export const MAX_PUBLIC_MUTATIONS = 4;
export const MAX_PUBLIC_MUTATIONS_PER_DOCUMENT = 1;
export const MAX_PUBLIC_MUTATIONS_PER_ACTOR = 4;
export const MAX_PUBLIC_RETAINED_IMAGE_BYTES = MAX_PUBLIC_MUTATIONS * MAX_TRANSACTION_IMAGE_DECODES * MAX_INLINE_ASSET_BYTES;
const PUBLIC_MUTATION_IMAGE_RESERVATION_BYTES = MAX_TRANSACTION_IMAGE_DECODES * MAX_INLINE_ASSET_BYTES;
const PUBLIC_OPERATION_BASELINE_SAMPLES = 256;

const CANONICAL_PIXEL_OPERATION_KINDS = new Set([
  'pixel.palette.replace', 'pixel.palette.reorder', 'pixel.palette-cycles.replace', 'pixel.stamps.replace',
  'pixel.tile-stamps.replace', 'pixel.bitmap-fonts.replace', 'pixel.conversion.replace', 'pixel.links.replace',
  'pixel.active-asset.set', 'pixel.frame.add', 'pixel.frame.replace', 'pixel.frame.delete', 'pixel.asset.add',
  'pixel.asset.replace', 'pixel.asset.delete', 'pixel.cel.set', 'pixel.cel.region', 'pixel.tilemap.set', 'pixel.tilemap.region',
]);

function requiresExclusiveSemanticAdmission(kind: unknown): boolean {
  return typeof kind === 'string' && (
    kind.startsWith('pixel.image-collection.')
    || kind === 'pixel.tile-object.create'
    || kind.startsWith('pixel.wang-')
  );
}

interface PublicMutationReservationState {
  id: symbol;
  actorId: string;
  documentId: string;
  documentIncarnationId: string;
  reservedSamples: number;
  reservedImageBytes: number;
  deadline: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  phase: 'preparing' | 'submitted';
  transactionId?: string;
}

export interface PublicMutationReservation {
  readonly id: symbol;
  readonly actorId: string;
  readonly documentId: string;
  readonly documentIncarnationId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  remainingMs(): number;
  assertActive(): void;
  release(): void;
}

export type PublicMutationAdmission =
  | { accepted: true; reservation: PublicMutationReservation }
  | { accepted: false; response: ApplyTransactionResponse };

export class PublicMutationDocumentChangedError extends Error {
  constructor() {
    super('Document incarnation changed during authenticated mutation preparation; the old edit was not applied.');
    this.name = 'PublicMutationDocumentChangedError';
  }
}

function boundedProduct(left: unknown, right: unknown): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || Number(left) < 1 || Number(right) < 1) return MAX_GLOBAL_SAMPLES;
  return Math.min(MAX_GLOBAL_SAMPLES + 1, Number(left) * Number(right));
}

function semanticPixelSamples(operation: Record<string, unknown>): number | undefined {
  const kind = operation.kind;
  if (kind === 'pixel.image.quantize') {
    return operation.width === undefined || operation.height === undefined
      ? MAX_GLOBAL_SAMPLES
      : boundedProduct(operation.width, operation.height);
  }
  if (kind === 'pixel.flood-fill' || kind === 'pixel.bitmap-text.paint') return MAX_GLOBAL_SAMPLES;
  if (kind === 'pixel.replace-color' || kind === 'pixel.adjust-index' || kind === 'pixel.ordered-dither') {
    const region = operation.region;
    if (!region || typeof region !== 'object' || Array.isArray(region)) return MAX_GLOBAL_SAMPLES;
    return boundedProduct((region as Record<string, unknown>).width, (region as Record<string, unknown>).height);
  }
  if (kind === 'pixel.selection.transform') {
    const runs = Array.isArray(operation.runs) ? operation.runs : [];
    let samples = 0;
    for (const run of runs) {
      const length = run && typeof run === 'object' && Number.isSafeInteger((run as Record<string, unknown>).length)
        ? Math.max(0, Number((run as Record<string, unknown>).length))
        : MAX_GLOBAL_SAMPLES;
      samples = Math.min(MAX_GLOBAL_SAMPLES + 1, samples + length);
    }
    if (operation.transform === 'scale') {
      samples = Math.min(MAX_GLOBAL_SAMPLES + 1, samples * boundedProduct(operation.scaleX ?? 1, operation.scaleY ?? 1));
    }
    return samples;
  }
  if (kind === 'pixel.tile-variants.paint') return Array.isArray(operation.points) ? Math.max(1, operation.points.length) : MAX_GLOBAL_SAMPLES;
  if (typeof kind === 'string' && kind.startsWith('pixel.') && !CANONICAL_PIXEL_OPERATION_KINDS.has(kind)) return MAX_GLOBAL_SAMPLES;
  return undefined;
}

export function estimatePublicMutationSamples(operations: readonly unknown[]): number {
  // These families perform document-wide reference/projection planning and are
  // protocol-exclusive transactions. Reserve the complete shared budget first,
  // even for malformed mixtures, so strict exact-intent validation still runs
  // only after aggregate admission rather than becoming a pre-lease exception.
  if (operations.some((value) => value && typeof value === 'object' && !Array.isArray(value)
    && requiresExclusiveSemanticAdmission((value as Record<string, unknown>).kind))) return MAX_GLOBAL_SAMPLES;
  let total = 0;
  for (const value of operations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return MAX_GLOBAL_SAMPLES + 1;
    const operation = value as Record<string, unknown>;
    const semantic = semanticPixelSamples(operation);
    const samples = Math.max(
      PUBLIC_OPERATION_BASELINE_SAMPLES,
      semantic ?? operationSamples(operation as unknown as CanvasOperation),
    );
    total = Math.min(MAX_GLOBAL_SAMPLES + 1, total + samples);
  }
  return total || 1;
}

export interface ReplayRequestResult {
  replaying: boolean;
  reason?: 'already-replaying' | 'replay-busy' | 'replay-too-large';
}

function safeSampleLength(value: unknown): number {
  return Array.isArray(value) ? Math.max(1, value.length) : 1;
}

function safeRunSamples(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) return 1;
  return Math.max(1, value.reduce((total, run) => {
    const length = run && typeof run === 'object' && 'length' in run && Number.isFinite(run.length) ? Math.max(0, Math.floor(Number(run.length))) : 0;
    return Math.min(MAX_GLOBAL_SAMPLES + 1, total + length);
  }, 0));
}

export function operationSamples(operation: CanvasOperation): number {
  if (!operation || typeof operation !== 'object') return 1;
  if (operation.kind === 'illustration.paint.stroke') return safeSampleLength(operation.stroke?.points);
  if (operation.kind === 'illustration.object.add' && operation.object?.type === 'vector-stroke') return safeSampleLength(operation.object.points);
  if (operation.kind === 'illustration.object.replace' && operation.object?.type === 'vector-stroke') return safeSampleLength(operation.object.points);
  if (operation.kind === 'pixel.cel.set' || operation.kind === 'pixel.tilemap.set') return safeSampleLength(operation.changes);
  if (operation.kind === 'pixel.cel.region' || operation.kind === 'pixel.tilemap.region') return safeRunSamples(operation.runs);
  return 1;
}

export function transactionSamples(transaction: CanvasTransaction): number {
  if (!Array.isArray(transaction.operations)) return 1;
  return transaction.operations.reduce((total, operation) => Math.min(MAX_GLOBAL_SAMPLES + 1, total + operationSamples(operation)), 0);
}

function slicePoints<T extends PointSample | { x: number; y: number }>(points: T[], progress: number): T[] {
  if (points.length <= 1) return progress > 0 ? points : [];
  return points.slice(0, Math.max(1, Math.ceil(points.length * progress)));
}

function sliceRuns<T extends { length: number }>(runs: T[], progress: number): T[] {
  let remaining = Math.max(1, Math.ceil(runs.reduce((sum, run) => sum + run.length, 0) * progress));
  const visible: T[] = [];
  for (const run of runs) {
    if (remaining <= 0) break;
    const length = Math.min(run.length, remaining);
    if (length > 0) visible.push({ ...run, length });
    remaining -= length;
  }
  return visible;
}

export function visibleOperations(operations: CanvasOperation[], progress: number): CanvasOperation[] {
  if (!Array.isArray(operations)) return [];
  const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const total = operations.reduce((sum, operation) => sum + operationSamples(operation), 0);
  let revealed = Math.ceil(total * safeProgress);
  const visible: CanvasOperation[] = [];
  for (const operation of operations) {
    const samples = operationSamples(operation);
    if (revealed <= 0) break;
    const operationProgress = Math.min(1, revealed / samples);
    revealed -= samples;
    if (operation.kind === 'illustration.paint.stroke') {
      const points = Array.isArray(operation.stroke?.points) ? operation.stroke.points : [];
      if (points.length) visible.push({ ...operation, stroke: { ...operation.stroke, points: slicePoints(points, operationProgress) } });
    } else if (operation.kind === 'illustration.object.add' && operation.object.type === 'vector-stroke') {
      const points = Array.isArray(operation.object.points) ? operation.object.points : [];
      if (points.length) visible.push({ ...operation, object: { ...operation.object, points: slicePoints(points, operationProgress) } });
    } else if (operation.kind === 'illustration.object.replace' && operation.object.type === 'vector-stroke') {
      const points = Array.isArray(operation.object.points) ? operation.object.points : [];
      if (points.length) visible.push({ ...operation, object: { ...operation.object, points: slicePoints(points, operationProgress) } });
    } else if (operation.kind === 'pixel.cel.set') {
      const changes = Array.isArray(operation.changes) ? operation.changes : [];
      if (changes.length) visible.push({ ...operation, changes: changes.slice(0, Math.max(1, Math.ceil(changes.length * operationProgress))) });
    } else if (operation.kind === 'pixel.tilemap.set') {
      const changes = Array.isArray(operation.changes) ? operation.changes : [];
      if (changes.length) visible.push({ ...operation, changes: changes.slice(0, Math.max(1, Math.ceil(changes.length * operationProgress))) });
    } else if (operation.kind === 'pixel.cel.region') {
      const runs = Array.isArray(operation.runs) ? operation.runs : [];
      if (runs.length) visible.push({ ...operation, runs: sliceRuns(runs, operationProgress) });
    } else if (operation.kind === 'pixel.tilemap.region') {
      const runs = Array.isArray(operation.runs) ? operation.runs : [];
      if (runs.length) visible.push({ ...operation, runs: sliceRuns(runs, operationProgress) });
    } else if (operationProgress >= 0.5) visible.push(structuredClone(operation));
  }
  return visible;
}

function cursorFor(operations: CanvasOperation[]): { x: number; y: number; tool?: string } | undefined {
  const operation = operations.at(-1);
  if (!operation) return undefined;
  if (operation.kind === 'illustration.paint.stroke') {
    const point = Array.isArray(operation.stroke?.points) ? operation.stroke.points.at(-1) : undefined;
    return point ? { x: point.x, y: point.y, tool: operation.stroke.mode === 'erase' ? 'eraser' : 'brush' } : undefined;
  }
  if ((operation.kind === 'illustration.object.add' || operation.kind === 'illustration.object.replace') && operation.object.type === 'vector-stroke') {
    const point = Array.isArray(operation.object.points) ? operation.object.points.at(-1) : undefined;
    return point ? { x: point.x, y: point.y, tool: 'pen' } : undefined;
  }
  if (operation.kind === 'pixel.cel.set' || operation.kind === 'pixel.tilemap.set') {
    const point = Array.isArray(operation.changes) ? operation.changes.at(-1) : undefined;
    return point ? { x: point.x, y: point.y, tool: 'pencil' } : undefined;
  }
  if (operation.kind === 'pixel.cel.region' || operation.kind === 'pixel.tilemap.region') {
    const run = Array.isArray(operation.runs) ? operation.runs.at(-1) : undefined;
    return run ? { x: run.x + Math.max(0, run.length - 1), y: run.y, tool: 'region' } : undefined;
  }
  return undefined;
}

export class PlaybackScheduler {
  private readonly queues = new Map<string, PlaybackTask[]>();
  private readonly active = new Set<PlaybackTask>();
  private readonly replays = new Set<string>();
  private lastScheduledActorId?: string;
  private reservedSamples = 0;
  private reservedPublicImageBytes = 0;
  private readonly publicReservations = new Map<symbol, PublicMutationReservationState>();
  private readonly publicReservationsByDocument = new Map<string, number>();
  private readonly publicReservationsByActor = new Map<string, number>();
  private visualPlaybackEnabled = true;

  constructor(private readonly documents: DocumentService) {}

  setVisualPlaybackEnabled(enabled: boolean): void {
    this.visualPlaybackEnabled = enabled;
  }

  reservePublicMutation(actorId: string, documentId: string, operations: readonly unknown[]): PublicMutationAdmission {
    const documentIncarnationId = this.documents.getDocumentIncarnation(documentId);
    if (!documentIncarnationId) {
      return { accepted: false, response: { status: 'conflict', message: 'Document is not open.' } };
    }
    const documentReservations = this.publicReservationsByDocument.get(documentId) ?? 0;
    const actorReservations = this.publicReservationsByActor.get(actorId) ?? 0;
    if (this.publicReservations.size >= MAX_PUBLIC_MUTATIONS
      || documentReservations >= MAX_PUBLIC_MUTATIONS_PER_DOCUMENT
      || actorReservations >= MAX_PUBLIC_MUTATIONS_PER_ACTOR
      || this.reservedPublicImageBytes + PUBLIC_MUTATION_IMAGE_RESERVATION_BYTES > MAX_PUBLIC_RETAINED_IMAGE_BYTES) {
      return { accepted: false, response: { status: 'busy', message: 'Public mutation preparation capacity is full. Retry after active work completes.' } };
    }

    const id = Symbol('public-mutation');
    const startedAt = Date.now();
    const controller = new AbortController();
    const state = {
      id,
      actorId,
      documentId,
      documentIncarnationId,
      reservedSamples: 0,
      reservedImageBytes: PUBLIC_MUTATION_IMAGE_RESERVATION_BYTES,
      deadline: startedAt + MAX_TRANSACTION_IMAGE_DECODE_MS,
      controller,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      phase: 'preparing' as const,
    } satisfies PublicMutationReservationState;
    state.timer = setTimeout(() => controller.abort(new Error('Public mutation preparation deadline expired.')), MAX_TRANSACTION_IMAGE_DECODE_MS);
    state.timer.unref?.();
    controller.signal.addEventListener('abort', () => this.cancelPublicReservation(id), { once: true });
    this.publicReservations.set(id, state);
    this.publicReservationsByDocument.set(documentId, documentReservations + 1);
    this.publicReservationsByActor.set(actorId, actorReservations + 1);
    this.reservedPublicImageBytes += state.reservedImageBytes;

    // Only after the fixed request/image-retention slot exists do we inspect
    // raw operation shape to reserve the aggregate semantic sample budget.
    const samples = estimatePublicMutationSamples(operations);
    if (samples > MAX_GLOBAL_SAMPLES) {
      this.releasePublicReservation(id);
      return { accepted: false, response: { status: 'conflict', message: 'The public mutation exceeds the one-million-sample preparation limit. Split semantic pixel work into smaller transactions.' } };
    }
    if (samples + this.reservedSamples > MAX_GLOBAL_SAMPLES) {
      this.releasePublicReservation(id);
      return { accepted: false, response: { status: 'busy', message: 'Public mutation semantic-work capacity is full. Retry after active work completes.' } };
    }
    state.reservedSamples = samples;
    this.reservedSamples += samples;

    const assertActive = (): void => {
      if (!this.publicReservations.has(id) || controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Public mutation preparation was cancelled.');
      }
      if (this.documents.getDocumentIncarnation(documentId) !== documentIncarnationId) {
        throw new PublicMutationDocumentChangedError();
      }
    };
    return {
      accepted: true,
      reservation: {
        id,
        actorId,
        documentId,
        documentIncarnationId,
        signal: controller.signal,
        startedAt,
        remainingMs: () => Math.max(0, state.deadline - Date.now()),
        assertActive,
        release: () => this.releasePublicReservation(id),
      },
    };
  }

  submitReserved(
    transaction: CanvasTransaction,
    reservation: PublicMutationReservation,
    applyOptions: ApplyOptions = {},
  ): Promise<ApplyTransactionResponse> {
    const state = this.publicReservations.get(reservation.id);
    if (!state || state.actorId !== transaction.actor.id || state.documentId !== transaction.documentId
      || state.documentIncarnationId !== reservation.documentIncarnationId || state.phase !== 'preparing') {
      reservation.release();
      return Promise.resolve({ status: 'conflict', message: 'Public mutation admission is no longer valid.' });
    }
    try { reservation.assertActive(); }
    catch (error) {
      reservation.release();
      return Promise.resolve({
        status: error instanceof PublicMutationDocumentChangedError ? 'conflict' : 'cancelled',
        message: error instanceof Error ? error.message : 'Public mutation preparation was cancelled.',
      });
    }
    const playbackSamples = transactionSamples(transaction);
    if (!Number.isFinite(playbackSamples) || playbackSamples > state.reservedSamples) {
      reservation.release();
      return Promise.resolve({ status: 'conflict', message: 'Semantic expansion exceeded its pre-admitted public workload; no mutation was applied.' });
    }
    state.phase = 'submitted';
    state.transactionId = transaction.id;
    const documentIncarnationId = state.documentIncarnationId;
    const ownedOptions = { ...applyOptions, signal: reservation.signal, expectedDocumentIncarnationId: documentIncarnationId };
    if (transaction.playback?.mode === 'instant' || !this.visualPlaybackEnabled) {
      return this.documents.apply(transaction, ownedOptions);
    }
    const submitted = new Promise<ApplyTransactionResponse>((resolve) => {
      const actorQueue = this.queues.get(transaction.actor.id) ?? [];
      actorQueue.push({
        transaction: structuredClone(transaction),
        applyOptions: ownedOptions,
        documentIncarnationId,
        resolve,
        cancelled: false,
        progress: 0,
        reservedSamples: state.reservedSamples,
        playbackSamples,
        publicReservationId: state.id,
      });
      this.queues.set(transaction.actor.id, actorQueue);
      this.documents.updatePresence({ actor: transaction.actor, documentId: transaction.documentId, queueDepth: actorQueue.length, status: 'waiting' });
      this.pump();
    });
    return submitted;
  }

  publicMutationStatus(): { active: number; reservedSamples: number; reservedImageBytes: number } {
    return { active: this.publicReservations.size, reservedSamples: this.reservedSamples, reservedImageBytes: this.reservedPublicImageBytes };
  }

  submit(transaction: CanvasTransaction, applyOptions: ApplyOptions = {}): Promise<ApplyTransactionResponse> {
    const documentIncarnationId = this.documents.getDocumentIncarnation(transaction.documentId);
    if (!documentIncarnationId) return Promise.resolve({ status: 'conflict', message: 'Document is not open.' });
    const ownedOptions = { ...applyOptions, expectedDocumentIncarnationId: documentIncarnationId };
    if (transaction.playback?.mode === 'instant' || !this.visualPlaybackEnabled) return this.documents.apply(transaction, ownedOptions);
    const samples = transactionSamples(transaction);
    if (!Number.isFinite(samples)) {
      return Promise.resolve({ status: 'conflict', message: 'Playback sample accounting failed because the transaction payload was malformed.' });
    }
    if (samples + this.reservedSamples > MAX_GLOBAL_SAMPLES) {
      return Promise.resolve({ status: 'busy', message: 'The visible playback budget is full. Retry after active work completes.' });
    }
    const actorQueue = this.queues.get(transaction.actor.id) ?? [];
    const activeForActor = [...this.active].filter((task) => task.transaction.actor.id === transaction.actor.id).length;
    if (actorQueue.length >= MAX_QUEUED_PER_ACTOR || actorQueue.length + activeForActor >= MAX_QUEUED_PER_ACTOR + 1) {
      return Promise.resolve({ status: 'busy', message: 'This session already has four queued transactions.' });
    }
    this.reservedSamples += samples;
    return new Promise((resolve) => {
      actorQueue.push({ transaction: structuredClone(transaction), applyOptions: ownedOptions, documentIncarnationId, resolve, cancelled: false, progress: 0, reservedSamples: samples, playbackSamples: samples });
      this.queues.set(transaction.actor.id, actorQueue);
      this.documents.updatePresence({
        actor: transaction.actor,
        documentId: transaction.documentId,
        queueDepth: actorQueue.length,
        status: 'waiting',
      });
      this.pump();
    });
  }

  replay(transaction: CanvasTransaction): ReplayRequestResult {
    const replayId = `trace:${transaction.id}`;
    if (this.replays.has(replayId)) return { replaying: false, reason: 'already-replaying' };
    if (this.replays.size >= MAX_CONCURRENT_REPLAYS) return { replaying: false, reason: 'replay-busy' };
    if (transactionSamples(transaction) > MAX_GLOBAL_SAMPLES) return { replaying: false, reason: 'replay-too-large' };
    this.replays.add(replayId);
    void this.playReplay(transaction, replayId);
    return { replaying: true };
  }

  private async playReplay(transaction: CanvasTransaction, replayId: string): Promise<void> {
    const samples = Math.max(1, transactionSamples(transaction));
    const speed = Number.isFinite(transaction.playback?.speed) ? transaction.playback!.speed : 1;
    const operationCount = Array.isArray(transaction.operations) ? transaction.operations.length : 0;
    const duration = Math.max(300, Math.min(8_000, (samples * 7 + operationCount * 180) / speed));
    const started = performance.now();
    let firstEvent = true;
    try {
      let progress = 0;
      while (progress < 1) {
        progress = Math.min(1, (performance.now() - started) / duration);
        this.documents.broadcastPlayback({
          type: 'playback',
          documentId: transaction.documentId,
          transactionId: replayId,
          actor: transaction.actor,
          progress,
          label: `${transaction.label} · trace replay`,
          lane: 0,
          operations: visibleOperations(transaction.operations, progress),
          sourceOperations: firstEvent ? transaction.operations : undefined,
          replay: true,
          status: 'playing',
        });
        firstEvent = false;
        if (progress < 1) await new Promise((resolve) => setTimeout(resolve, 33));
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
      this.documents.broadcastPlayback({
        type: 'playback', documentId: transaction.documentId, transactionId: replayId, actor: transaction.actor,
        progress: 1, label: `${transaction.label} · trace replay`, lane: 0, operations: transaction.operations, replay: true, status: 'completed',
      });
    } catch {
      this.documents.broadcastPlayback({
        type: 'playback', documentId: transaction.documentId, transactionId: replayId, actor: transaction.actor,
        progress: 0, label: `${transaction.label} · trace replay`, lane: 0, operations: [], replay: true, status: 'failed',
      });
    } finally {
      this.replays.delete(replayId);
    }
  }

  stop(documentId?: string): number {
    let stopped = 0;
    for (const task of this.active) {
      if (!documentId || task.transaction.documentId === documentId) {
        task.cancelled = true;
        stopped += 1;
      }
    }
    for (const [actorId, queue] of this.queues) {
      const retained: PlaybackTask[] = [];
      for (const task of queue) {
        if (!documentId || task.transaction.documentId === documentId) {
          this.release(task);
          task.resolve({ status: 'cancelled', message: 'Cancelled before playback began.' });
          stopped += 1;
        } else retained.push(task);
      }
      this.queues.set(actorId, retained);
    }
    return stopped;
  }

  cancelTransaction(transactionId: string): boolean {
    const active = [...this.active].find((task) => task.transaction.id === transactionId);
    if (active) { active.cancelled = true; return true; }
    for (const [actorId, queue] of this.queues) {
      const index = queue.findIndex((task) => task.transaction.id === transactionId);
      if (index < 0) continue;
      const [task] = queue.splice(index, 1);
      this.release(task);
      task.resolve({ status: 'cancelled', message: 'Cancelled before playback began.' });
      this.documents.updatePresence({ actor: task.transaction.actor, documentId: task.transaction.documentId, queueDepth: queue.length, status: queue.length ? 'waiting' : 'idle' });
      if (queue.length === 0) this.queues.delete(actorId);
      this.pump();
      return true;
    }
    return false;
  }

  stopActor(actorId: string): number {
    let stopped = 0;
    for (const state of this.publicReservations.values()) {
      if (state.actorId !== actorId || state.controller.signal.aborted) continue;
      state.controller.abort(new Error('The authenticated MCP session closed.'));
      stopped += 1;
    }
    for (const task of this.active) if (task.transaction.actor.id === actorId && !task.cancelled) { task.cancelled = true; stopped += 1; }
    const queue = this.queues.get(actorId) ?? [];
    for (const task of queue.splice(0)) {
      this.release(task);
      task.resolve({ status: 'cancelled', message: 'Cancelled because the authenticated MCP session closed.' });
      stopped += 1;
    }
    if (queue.length === 0) this.queues.delete(actorId);
    this.pump();
    return stopped;
  }

  private pump(): void {
    while (this.active.size < MAX_LANES) {
      const actorIds = [...this.queues.entries()].filter(([, queue]) => queue.length > 0).map(([actorId]) => actorId);
      if (actorIds.length === 0) return;
      const previousIndex = this.lastScheduledActorId ? actorIds.indexOf(this.lastScheduledActorId) : -1;
      const actorId = actorIds[(previousIndex + 1) % actorIds.length];
      this.lastScheduledActorId = actorId;
      const task = this.queues.get(actorId)?.shift();
      if (!task) continue;
      task.lane = this.firstFreeLane();
      this.active.add(task);
      void this.play(task);
    }
  }

  private firstFreeLane(): number {
    const used = new Set([...this.active].map((task) => task.lane));
    for (let lane = 0; lane < MAX_LANES; lane += 1) if (!used.has(lane)) return lane;
    return 0;
  }

  private async play(task: PlaybackTask): Promise<void> {
    const { transaction } = task;
    const speed = Number.isFinite(transaction.playback?.speed) ? transaction.playback!.speed : 1;
    const duration = Math.max(240, Math.min(8_000, (task.playbackSamples * 7 + transaction.operations.length * 180) / speed));
    const started = performance.now();
    let response: ApplyTransactionResponse | undefined;
    try {
      this.documents.updatePresence({ actor: transaction.actor, documentId: transaction.documentId, queueDepth: this.queues.get(transaction.actor.id)?.length ?? 0, status: 'working' });

      while (!task.cancelled) {
        task.progress = Math.min(1, (performance.now() - started) / duration);
        const operations = visibleOperations(transaction.operations, task.progress);
        this.documents.broadcastPlayback({
          type: 'playback', documentId: transaction.documentId, transactionId: transaction.id, actor: transaction.actor,
          progress: task.progress, label: transaction.label, lane: task.lane ?? 0, operations, status: 'playing',
        });
        this.documents.updatePresence({ actor: transaction.actor, documentId: transaction.documentId, cursor: cursorFor(operations), queueDepth: this.queues.get(transaction.actor.id)?.length ?? 0, status: 'working' });
        if (task.progress >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 33));
      }

      if (task.cancelled) {
        const operations = visibleOperations(transaction.operations, task.progress);
        if (operations.length > 0) {
          response = await this.documents.apply({ ...transaction, operations }, {
            ...task.applyOptions,
            activityStatus: 'partial',
            expectedDocumentIncarnationId: task.documentIncarnationId,
          });
        } else response = { status: 'cancelled', message: 'Cancelled before any work was revealed.' };
        this.documents.broadcastPlayback({
          type: 'playback', documentId: transaction.documentId, transactionId: transaction.id, actor: transaction.actor,
          progress: task.progress, label: transaction.label, lane: task.lane ?? 0, operations, status: 'cancelled',
        });
      } else {
        response = await this.documents.apply(transaction, {
          ...task.applyOptions,
          expectedDocumentIncarnationId: task.documentIncarnationId,
        });
        this.documents.broadcastPlayback({
          type: 'playback', documentId: transaction.documentId, transactionId: transaction.id, actor: transaction.actor,
          progress: 1, label: transaction.label, lane: task.lane ?? 0, operations: transaction.operations,
          status: response.status === 'committed' || response.status === 'duplicate' ? 'completed' : 'failed',
        });
      }
    } catch (error) {
      response ??= { status: 'conflict', message: `Visible playback failed safely: ${error instanceof Error ? error.message : 'unknown error'}` };
      try {
        this.documents.broadcastPlayback({
          type: 'playback', documentId: transaction.documentId, transactionId: transaction.id, actor: transaction.actor,
          progress: task.progress, label: transaction.label, lane: task.lane ?? 0, operations: [], status: 'failed',
        });
      } catch {
        // A failed renderer notification must never strand a scheduler lane.
      }
    } finally {
      const remaining = this.queues.get(transaction.actor.id)?.length ?? 0;
      try {
        this.documents.updatePresence({ actor: transaction.actor, documentId: transaction.documentId, queueDepth: remaining, status: remaining ? 'waiting' : 'idle' });
      } catch {
        // Presence is advisory; lane cleanup below is mandatory.
      }
      this.active.delete(task);
      this.release(task);
      task.resolve(response ?? { status: 'conflict', message: 'Visible playback failed safely.' });
      this.pump();
    }
  }

  private release(task: PlaybackTask): void {
    if (task.publicReservationId) {
      task.publicReservationId = undefined;
      task.reservedSamples = 0;
      return;
    }
    this.reservedSamples = Math.max(0, this.reservedSamples - task.reservedSamples);
    task.reservedSamples = 0;
  }

  private cancelPublicReservation(id: symbol): void {
    const state = this.publicReservations.get(id);
    if (!state || state.phase === 'preparing') return;
    if (state.transactionId) this.cancelTransaction(state.transactionId);
  }

  private releasePublicReservation(id: symbol): void {
    const state = this.publicReservations.get(id);
    if (!state) return;
    this.publicReservations.delete(id);
    clearTimeout(state.timer);
    this.reservedSamples = Math.max(0, this.reservedSamples - state.reservedSamples);
    this.reservedPublicImageBytes = Math.max(0, this.reservedPublicImageBytes - state.reservedImageBytes);
    const documentReservations = Math.max(0, (this.publicReservationsByDocument.get(state.documentId) ?? 1) - 1);
    const actorReservations = Math.max(0, (this.publicReservationsByActor.get(state.actorId) ?? 1) - 1);
    if (documentReservations) this.publicReservationsByDocument.set(state.documentId, documentReservations);
    else this.publicReservationsByDocument.delete(state.documentId);
    if (actorReservations) this.publicReservationsByActor.set(state.actorId, actorReservations);
    else this.publicReservationsByActor.delete(state.actorId);
  }
}

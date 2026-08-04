import type { CanvasOperation, CanvasTransaction, PointSample } from '@aidraw/core';
import type { ApplyTransactionResponse } from '../common/contracts';
import { DocumentService } from './document-service';

interface PlaybackTask {
  transaction: CanvasTransaction;
  resolve: (response: ApplyTransactionResponse) => void;
  cancelled: boolean;
  progress: number;
  lane?: number;
  reservedSamples: number;
}

const MAX_LANES = 4;
const MAX_QUEUED_PER_ACTOR = 4;
const MAX_GLOBAL_SAMPLES = 1_000_000;
const MAX_CONCURRENT_REPLAYS = 1;

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
  private visualPlaybackEnabled = true;

  constructor(private readonly documents: DocumentService) {}

  setVisualPlaybackEnabled(enabled: boolean): void {
    this.visualPlaybackEnabled = enabled;
  }

  submit(transaction: CanvasTransaction): Promise<ApplyTransactionResponse> {
    if (transaction.playback?.mode === 'instant' || !this.visualPlaybackEnabled) return this.documents.apply(transaction);
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
      actorQueue.push({ transaction: structuredClone(transaction), resolve, cancelled: false, progress: 0, reservedSamples: samples });
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
    const duration = Math.max(240, Math.min(8_000, (task.reservedSamples * 7 + transaction.operations.length * 180) / speed));
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
          response = await this.documents.apply({ ...transaction, operations }, { activityStatus: 'partial' });
        } else response = { status: 'cancelled', message: 'Cancelled before any work was revealed.' };
        this.documents.broadcastPlayback({
          type: 'playback', documentId: transaction.documentId, transactionId: transaction.id, actor: transaction.actor,
          progress: task.progress, label: transaction.label, lane: task.lane ?? 0, operations, status: 'cancelled',
        });
      } else {
        response = await this.documents.apply(transaction);
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
    this.reservedSamples = Math.max(0, this.reservedSamples - task.reservedSamples);
    task.reservedSamples = 0;
  }
}

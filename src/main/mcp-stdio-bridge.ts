import {
  LATEST_PROTOCOL_VERSION,
  isJSONRPCRequest,
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createMcpBridgeProvisionalId, MCP_BRIDGE_PROVISIONAL_HEADER } from './mcp-authority';
import { readCurrentMcpEngineRunState, type McpEngineRunState } from './mcp-run-state';

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_RECOVERY_STABILITY_MS = 50;
const DEFAULT_RECOVERY_WINDOW_MS = 5_000;
const DEFAULT_RECOVERY_LIMIT = 4;
const IDENTITY_TIMEOUT_MS = 750;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024;

type BridgeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface McpBridgeSessionOptions {
  userDataPath: string;
  emit(message: JSONRPCMessage): void | Promise<void>;
  fetch?: BridgeFetch;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  terminalCloseTimeoutMs?: number;
  recoveryStabilityMs?: number;
  recoveryWindowMs?: number;
  recoveryLimit?: number;
  reportError?: (error: Error) => void;
  isProcessAlive?: (pid: number) => boolean;
}

export interface McpStdioBridgeOptions extends Omit<McpBridgeSessionOptions, 'emit'> {
  input?: Readable;
  output?: Writable;
  terminationSignal?: AbortSignal;
}

interface ActiveBridgeConnection {
  generation: number;
  state: McpEngineRunState;
  sessionId: string;
  protocolVersion: string;
  provisionalId: string;
  eventsAbort: AbortController;
  recoveryScheduled: boolean;
  recoveryAdmitted: boolean;
  eventsEnded: boolean;
  eventsEnd: Promise<void>;
  resolveEventsEnd: () => void;
}

interface PendingServerEventRecovery {
  generation: number;
  queuedThroughSequence: number;
  promise: Promise<void>;
}

interface RecoveryContinuation {
  signal: AbortSignal;
  expectedGeneration: number;
  replacementGeneration?: number;
}

interface ExternalWork {
  sequence: number;
  message: JSONRPCMessage;
  completion: Promise<void>;
  cancellation: AbortController;
  state: 'queued' | 'preparing' | 'dispatched' | 'settled' | 'cancelled';
  active?: ActiveBridgeConnection;
  cancellationRequested: boolean;
  cancellationResponseEmitted: boolean;
}

interface ExternalContinuation {
  signal: AbortSignal;
  work: ExternalWork;
  respectRequestCancellation: boolean;
}

type BridgeContinuation = RecoveryContinuation | ExternalContinuation;

class BridgeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

class AmbiguousBridgeOutcomeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AmbiguousBridgeOutcomeError';
  }
}

class BridgeStateRestoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BridgeStateRestoreError';
  }
}

class BridgeRecoveryCancelledError extends Error {
  constructor(phase: string) {
    super(`AIDraw MCP bridge recovery was cancelled during ${phase}.`);
    this.name = 'BridgeRecoveryCancelledError';
  }
}

class BridgeExternalWorkCancelledError extends Error {
  constructor(readonly closed: boolean, phase: string) {
    super(closed
      ? `AIDraw MCP bridge closed during ${phase}.`
      : `AIDraw MCP request was cancelled before ${phase}.`);
    this.name = 'BridgeExternalWorkCancelledError';
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(new BridgeRecoveryCancelledError('retry delay'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new BridgeRecoveryCancelledError('retry delay'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

function identityUrl(state: McpEngineRunState): string {
  const url = new URL(state.url);
  url.pathname = '/mcp/identity';
  return url.href;
}

function messageId(message: JSONRPCMessage): string | number | undefined {
  if (!('id' in message) || message.id === null || message.id === undefined) return undefined;
  return message.id;
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function cancellationTarget(message: JSONRPCMessage): string | number | undefined {
  if (!('method' in message) || message.method !== 'notifications/cancelled') return undefined;
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !('requestId' in params)) return undefined;
  const requestId = params.requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

function retryableError(message: JSONRPCMessage, reason: string): JSONRPCMessage | undefined {
  const id = messageId(message);
  if (id === undefined || !('method' in message)) return undefined;
  return parseJSONRPCMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32_001,
      message: 'AIDraw MCP engine is not ready.',
      data: { retryable: true, reason },
    },
  });
}

function ambiguousOutcomeError(message: JSONRPCMessage, reason: string): JSONRPCMessage | undefined {
  const id = messageId(message);
  if (id === undefined || !('method' in message)) return undefined;
  return parseJSONRPCMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32_002,
      message: 'AIDraw could not prove whether the engine completed this request.',
      data: {
        ambiguousOutcome: true,
        retryable: false,
        reason,
        next: 'Observe canonical state before deciding whether a new logical operation is needed; never replay this request automatically.',
      },
    },
  });
}

function rejectedRequestError(message: JSONRPCMessage, reason: string): JSONRPCMessage | undefined {
  const id = messageId(message);
  if (id === undefined || !('method' in message)) return undefined;
  return parseJSONRPCMessage({
    jsonrpc: '2.0', id,
    error: { code: -32_003, message: 'AIDraw rejected this MCP request.', data: { retryable: false, reason } },
  });
}

function cancelledRequestError(message: JSONRPCMessage): JSONRPCMessage | undefined {
  const id = messageId(message);
  if (id === undefined || !('method' in message)) return undefined;
  return parseJSONRPCMessage({
    jsonrpc: '2.0', id,
    error: { code: -32_800, message: 'Request cancelled', data: { dispatched: false } },
  });
}

function isSuccessfulResponse(messages: readonly JSONRPCMessage[], id: string | number): boolean {
  return messages.some((message) => {
    if (!('id' in message) || message.id !== id || !('result' in message)) return false;
    return !message.result || typeof message.result !== 'object' || Array.isArray(message.result)
      || !('isError' in message.result) || message.result.isError !== true;
  });
}

function requestParams(message: JSONRPCMessage): Record<string, unknown> | undefined {
  if (!isJSONRPCRequest(message) || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return undefined;
  return message.params as Record<string, unknown>;
}

function parseResponseMessages(text: string, contentType: string): JSONRPCMessage[] {
  if (!text.trim()) return [];
  const values: unknown[] = [];
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const events = text.replaceAll('\r\n', '\n').split(/\n\n+/u);
    for (const event of events) {
      const data = event.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') values.push(JSON.parse(data) as unknown);
    }
  } else {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) values.push(...parsed);
    else values.push(parsed);
  }
  return values.map((value) => parseJSONRPCMessage(value));
}

async function readBoundedResponse(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await abortable(reader.read(), signal, 'engine response body');
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel('AIDraw MCP bridge response exceeded its byte limit.').catch(() => undefined);
      throw new Error('AIDraw MCP bridge rejected an oversized engine response.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined, phase: string): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new BridgeExternalWorkCancelledError(true, phase);
  return await new Promise<T>((resolve, reject) => {
    const cancelled = (): void => reject(new BridgeExternalWorkCancelledError(true, phase));
    signal.addEventListener('abort', cancelled, { once: true });
    void operation.then(
      (value) => { signal.removeEventListener('abort', cancelled); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', cancelled); reject(error); },
    );
  });
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function exactIdentity(value: unknown, state: McpEngineRunState): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity);
  return keys.length === 3 && identity.version === 1
    && identity.instanceId === state.instanceId && identity.pid === state.pid;
}

/**
 * One long-lived stdio client session that discovers the current AIDraw
 * engine, keeps the engine bearer private, and transparently reinitializes its
 * internal HTTP transport when the engine instance changes.
 */
export class McpBridgeSession {
  private readonly fetch: BridgeFetch;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly terminalCloseTimeoutMs: number;
  private readonly recoveryStabilityMs: number;
  private readonly recoveryWindowMs: number;
  private readonly recoveryLimit: number;
  private readonly reportError: (error: Error) => void;
  private readonly isProcessAlive: (pid: number) => boolean;
  private initializeRequest?: JSONRPCRequest;
  private externalInitializeSucceeded = false;
  private initializedIntent = false;
  private active?: ActiveBridgeConnection;
  private readonly pendingSessionRetirements = new Map<string, ActiveBridgeConnection>();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly closeAbort = new AbortController();
  private connectionGeneration = 0;
  private internalRequestSequence = 0;
  private externalWorkSequence = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private messageQueue: Promise<void> = Promise.resolve();
  private outputQueue: Promise<void> = Promise.resolve();
  private currentWork?: ExternalWork;
  private dispatchedMessage?: Promise<void>;
  private serverEventRecovery?: PendingServerEventRecovery;
  private recoveryFailure?: { queuedThroughSequence: number; error: unknown };
  private readonly automaticRecoveryStarts: number[] = [];
  private readonly requestWork = new Map<string, ExternalWork>();
  private joinedSessionArguments?: Record<string, unknown>;
  private readonly resourceSubscriptions = new Set<string>();

  constructor(private readonly options: McpBridgeSessionOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.terminalCloseTimeoutMs = options.terminalCloseTimeoutMs ?? DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS;
    this.recoveryStabilityMs = options.recoveryStabilityMs ?? DEFAULT_RECOVERY_STABILITY_MS;
    this.recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
    this.recoveryLimit = options.recoveryLimit ?? DEFAULT_RECOVERY_LIMIT;
    this.reportError = options.reportError ?? (() => undefined);
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    if (!Number.isSafeInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 1
      || !Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || !Number.isSafeInteger(this.terminalCloseTimeoutMs) || this.terminalCloseTimeoutMs < 1
      || !Number.isSafeInteger(this.recoveryStabilityMs) || this.recoveryStabilityMs < 1
      || !Number.isSafeInteger(this.recoveryWindowMs) || this.recoveryWindowMs < this.recoveryStabilityMs
      || !Number.isSafeInteger(this.recoveryLimit) || this.recoveryLimit < 1) {
      throw new Error('AIDraw MCP bridge retry bounds are invalid.');
    }
  }

  async accept(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    const target = cancellationTarget(message);
    if (target !== undefined) {
      await this.acceptCancellation(message, target);
      return;
    }
    let releaseCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const work: ExternalWork = {
      sequence: ++this.externalWorkSequence,
      message,
      completion,
      cancellation: new AbortController(),
      state: 'queued',
      cancellationRequested: false,
      cancellationResponseEmitted: false,
    };
    if (this.serverEventRecovery) {
      this.serverEventRecovery.queuedThroughSequence = work.sequence;
    }
    const id = messageId(message);
    const key = id === undefined ? undefined : requestKey(id);
    if (key) {
      this.requestWork.set(key, work);
    }
    const prior = this.messageQueue;
    let release = (): void => undefined;
    this.messageQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (this.closed) return;
      if (work.state === 'cancelled') {
        await this.emitCancellationResponse(work);
        return;
      }
      work.state = 'preparing';
      this.currentWork = work;
      await this.waitForScheduledServerEventRecovery(this.preDispatchSignal(work), work.sequence);
      this.assertExternalContinuation(this.externalContinuation(work), 'message admission');
      if (isJSONRPCRequest(message) && message.method === 'initialize') {
        this.initializeRequest = undefined;
        this.externalInitializeSucceeded = false;
        this.initializedIntent = false;
        this.joinedSessionArguments = undefined;
        this.resourceSubscriptions.clear();
        await this.initializeForClient(message, work);
        return;
      }
      if (!this.externalInitializeSucceeded || !this.initializeRequest) {
        throw new Error('Initialize the AIDraw MCP bridge successfully before sending other messages.');
      }
      const initializedNotification = 'method' in message && message.method === 'notifications/initialized';
      if (!initializedNotification && !this.initializedIntent) {
        throw new Error('Send notifications/initialized before other AIDraw MCP traffic.');
      }
      if (initializedNotification) this.initializedIntent = true;
      await this.forwardWithReconnect(message, work);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized instanceof BridgeExternalWorkCancelledError) {
        if (!normalized.closed) await this.emitCancellationResponse(work);
        return;
      }
      if (normalized instanceof BridgeRecoveryCancelledError && work.cancellationRequested) {
        await this.emitCancellationResponse(work);
        return;
      }
      if (normalized instanceof BridgeRecoveryCancelledError && this.closed) return;
      this.reportError(normalized);
      const response = normalized instanceof AmbiguousBridgeOutcomeError
        ? ambiguousOutcomeError(message, normalized.message)
        : normalized instanceof BridgeHttpError && ![401, 404, 503].includes(normalized.status)
          ? rejectedRequestError(message, normalized.message)
        : retryableError(message, normalized.message);
      if (response && !this.closed) await this.emitWithClosePolicy(response).catch(() => undefined);
    } finally {
      work.state = work.state === 'cancelled' ? 'cancelled' : 'settled';
      if (key && this.requestWork.get(key) === work) this.requestWork.delete(key);
      if (this.currentWork === work) this.currentWork = undefined;
      if (this.dispatchedMessage === completion) this.dispatchedMessage = undefined;
      releaseCompletion();
      release();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closeAbort.abort();
    for (const work of this.requestWork.values()) {
      if (work.state === 'queued' || work.state === 'preparing') {
        work.state = 'cancelled';
        work.cancellation.abort();
      }
    }
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.eventsAbort.abort();
      this.rememberPendingSessionRetirement(active);
    }
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const queueDrained = await settleWithin(this.messageQueue, this.terminalCloseTimeoutMs);
    if (!queueDrained) {
      this.reportError(new Error('AIDraw MCP bridge stopped waiting for dispatched work at its terminal close deadline.'));
    }
    if (!await settleWithin(this.outputQueue, this.terminalCloseTimeoutMs)) {
      this.reportError(new Error('AIDraw MCP bridge stopped waiting for external output at its terminal close deadline.'));
    }
    const cleanup = this.withLifecycle(async () => {
      await this.deactivate(true);
      await this.retryPendingSessionRetirements(2);
      if (this.pendingSessionRetirements.size > 0) {
        this.reportError(new Error('AIDraw MCP bridge could not confirm retirement of every internal session before stdio closed.'));
        // No in-process retry can occur after the stdio bridge has closed. The
        // authenticated lifetime-stream disconnect is the host-owned terminal
        // retirement boundary for these confirmed first-party sessions.
        this.pendingSessionRetirements.clear();
      }
    });
    if (!await settleWithin(cleanup, this.terminalCloseTimeoutMs)) {
      this.reportError(new Error('AIDraw MCP bridge cleanup continued beyond its terminal close deadline; host lifetime retirement remains authoritative.'));
    }
  }

  private async initializeForClient(request: JSONRPCRequest, work: ExternalWork): Promise<void> {
    const continuation = this.externalContinuation(work);
    try {
      const messages = await this.withLifecycle(async () => {
        this.assertExternalContinuation(continuation, 'external initialization');
      await this.deactivate(true);
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
          this.assertExternalContinuation(continuation, 'initialization retry');
          const state = await this.waitForEngine(continuation.signal);
        try {
            return (await this.initializeConnection(state, request, true, continuation)).messages;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await this.deactivate(true);
            if (lastError instanceof BridgeExternalWorkCancelledError) throw lastError;
          if (!(lastError instanceof BridgeHttpError) || ![401, 404, 503].includes(lastError.status)) break;
        }
      }
      throw lastError ?? new Error('AIDraw MCP bridge could not initialize.');
    });
      for (const response of messages) await this.emitWithClosePolicy(response);
      this.assertExternalContinuation(continuation, 'external initialize response emission');
      this.initializeRequest = structuredClone(request);
      this.externalInitializeSucceeded = true;
    } catch (error) {
      await this.withLifecycle(async () => { await this.deactivate(true); });
      throw error;
    }
  }

  private async forwardWithReconnect(message: JSONRPCMessage, work: ExternalWork): Promise<void> {
    const preparation = this.externalContinuation(work);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let active: ActiveBridgeConnection | undefined;
      try {
        for (let preparationAttempt = 0; preparationAttempt < 3; preparationAttempt += 1) {
          active = await this.withLifecycle(async () => {
            this.assertExternalContinuation(preparation, 'engine selection');
            const state = await this.waitForEngine(preparation.signal);
            this.assertExternalContinuation(preparation, 'selected-engine admission');
            if (!this.active || this.active.state.instanceId !== state.instanceId) {
              const isInitializedNotification = 'method' in message && message.method === 'notifications/initialized';
              await this.reconnect(state, preparation, isInitializedNotification);
            }
            this.assertExternalContinuation(preparation, 'reconnected-engine admission');
            return this.active!;
          });
          if (work.state !== 'dispatched') {
            await this.waitForScheduledServerEventRecovery(preparation.signal, work.sequence);
            this.assertExternalContinuation(preparation, 'request dispatch');
            if (this.serverEventRecovery || this.active !== active) continue;
          }
          this.markCurrentMessageDispatched(active);
          break;
        }
        if (!active || work.state !== 'dispatched') {
          throw new Error('AIDraw could not reserve a recovered engine session before request dispatch.');
        }
        const messages = await this.post(message, active, this.externalContinuation(work, false));
        this.rememberSuccessfulClientState(message, messages);
        try {
          for (const response of messages) await this.emitWithClosePolicy(response);
        } catch (error) {
          if (error instanceof BridgeExternalWorkCancelledError) throw error;
          throw new AmbiguousBridgeOutcomeError(
            `The engine completed this request, but its response could not be emitted: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.withLifecycle(async () => {
          if (!active || this.active === active) await this.deactivate(true);
        });
        if (lastError instanceof BridgeExternalWorkCancelledError || this.closed || work.state === 'cancelled') break;
        if (work.cancellationRequested && lastError instanceof BridgeHttpError
          && [401, 404, 503].includes(lastError.status)) {
          lastError = new BridgeExternalWorkCancelledError(false, 'retry after proven non-delivery');
          break;
        }
        if (lastError instanceof BridgeStateRestoreError && attempt === 0) continue;
        if (lastError instanceof BridgeHttpError && [401, 404, 503].includes(lastError.status) && attempt === 0) continue;
        break;
      }
    }
    throw lastError ?? new Error('AIDraw MCP bridge could not forward the message.');
  }

  private async reconnect(
    state: McpEngineRunState,
    continuation: BridgeContinuation,
    deferInitializedIntent = false,
  ): Promise<void> {
    this.assertContinuation(continuation, 'connection retirement');
    await this.deactivate(true);
    this.assertContinuation(continuation, 'connection initialization');
    const request: JSONRPCRequest = {
      ...structuredClone(this.initializeRequest!),
      id: `aidraw-bridge-${++this.internalRequestSequence}`,
    };
    await this.initializeConnection(state, request, false, continuation);
    this.assertContinuation(continuation, 'initialized connection admission');
    if (this.initializedIntent && !deferInitializedIntent) {
      try {
        await this.post(
          parseJSONRPCMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          this.active!,
          continuation,
        );
        this.assertContinuation(continuation, 'initialized notification');
        await this.restoreClientState(this.active!, continuation);
        this.assertContinuation(continuation, 'state restoration');
      } catch (error) {
        await this.deactivate(true);
        if (error instanceof BridgeRecoveryCancelledError
          || error instanceof BridgeExternalWorkCancelledError
          || this.closed || continuation.signal.aborted) {
          if ('work' in continuation) throw new BridgeExternalWorkCancelledError(this.closed, 'state restoration');
          throw new BridgeRecoveryCancelledError('state restoration');
        }
        throw new BridgeStateRestoreError(`AIDraw could not restore the external client's session intent: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
  }

  private async initializeConnection(
    state: McpEngineRunState,
    request: JSONRPCRequest,
    externalDispatch = false,
    continuation?: BridgeContinuation,
  ): Promise<{ messages: JSONRPCMessage[] }> {
    const provisionalId = createMcpBridgeProvisionalId();
    let response: Response;
    try {
      if (continuation) this.assertContinuation(continuation, 'initialization dispatch');
      if (externalDispatch) this.markCurrentMessageDispatched();
      response = await this.fetch(state.url, {
        method: 'POST',
        headers: this.headers(state, undefined, provisionalId),
        body: JSON.stringify(request),
        cache: 'no-store',
        ...(continuation ? { signal: continuation.signal } : {}),
      });
      if (continuation) this.assertContinuation(continuation, 'initialization response');
    } catch (error) {
      await this.terminateUnknownProvisionalSession(state, provisionalId);
      if (continuation && this.continuationWasCancelled(continuation, error)) {
        throw this.continuationCancellation(continuation, 'initialization transport');
      }
      throw new Error(`AIDraw bridge initialization transport failed before a usable response: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await this.terminateUnknownProvisionalSession(state, provisionalId);
      throw new BridgeHttpError(response.status, `AIDraw engine refused bridge initialization with HTTP ${response.status}.`);
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId || !/^[\x21-\x7e]{1,256}$/u.test(sessionId)) {
      await response.body?.cancel().catch(() => undefined);
      await this.terminateUnknownProvisionalSession(state, provisionalId);
      throw new Error('AIDraw engine did not return a bounded MCP session identity.');
    }
    let protocolVersion = LATEST_PROTOCOL_VERSION;
    try {
      const text = await readBoundedResponse(response, continuation?.signal);
      if (continuation) this.assertContinuation(continuation, 'initialization response body');
      const messages = parseResponseMessages(text, response.headers.get('content-type') ?? 'application/json');
      const matching = messages.find((message) => messageId(message) === request.id);
      protocolVersion = matching && 'result' in matching && matching.result && typeof matching.result === 'object'
        && 'protocolVersion' in matching.result && typeof matching.result.protocolVersion === 'string'
        ? matching.result.protocolVersion
        : LATEST_PROTOCOL_VERSION;
      if (!matching || !('result' in matching)) throw new Error('AIDraw engine initialization returned no matching successful response.');
      if (continuation) this.assertContinuation(continuation, 'initialized session publication');
      const active = this.createActiveConnection(state, sessionId, protocolVersion, provisionalId, continuation);
      if (continuation && !('work' in continuation)) continuation.replacementGeneration = active.generation;
      this.active = active;
      await this.startServerEvents(active, continuation);
      if (continuation) this.assertContinuation(continuation, 'lifetime-stream admission');
      return { messages };
    } catch (error) {
      const provisional = this.active?.state.instanceId === state.instanceId
        && this.active.sessionId === sessionId
        ? this.active
        : this.createActiveConnection(state, sessionId, protocolVersion, provisionalId);
      if (this.active === provisional) this.active = undefined;
      provisional.eventsAbort.abort();
      this.endActiveEvents(provisional);
      this.rememberPendingSessionRetirement(provisional);
      await this.retryPendingSessionRetirements(2);
      if (continuation && this.continuationWasCancelled(continuation, error)) {
        throw this.continuationCancellation(continuation, 'initialization completion');
      }
      throw error;
    }
  }

  private async post(
    message: JSONRPCMessage,
    active: ActiveBridgeConnection,
    continuation?: BridgeContinuation,
  ): Promise<JSONRPCMessage[]> {
    let response: Response;
    try {
      if (continuation) this.assertContinuation(continuation, 'state request dispatch');
      response = await this.fetch(active.state.url, {
        method: 'POST',
        headers: this.headers(active.state, active),
        body: JSON.stringify(message),
        cache: 'no-store',
        ...(continuation ? { signal: continuation.signal } : {}),
      });
      if (continuation) this.assertContinuation(continuation, 'state request response');
    } catch (error) {
      if (continuation && this.continuationWasCancelled(continuation, error)) {
        throw this.continuationCancellation(continuation, 'state request transport');
      }
      throw new AmbiguousBridgeOutcomeError(
        `The request transport failed after dispatch: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if ([400, 401, 404, 503].includes(response.status)) {
        throw new BridgeHttpError(response.status, `AIDraw engine rejected the bridge session with HTTP ${response.status}.`);
      }
      throw new AmbiguousBridgeOutcomeError(`The engine returned HTTP ${response.status} after request dispatch, so completion cannot be proven.`);
    }
    try {
      const text = await readBoundedResponse(response, continuation?.signal);
      if (continuation) this.assertContinuation(continuation, 'state request response body');
      const messages = parseResponseMessages(text, response.headers.get('content-type') ?? 'application/json');
      const id = messageId(message);
      if (id !== undefined && !messages.some((candidate) => messageId(candidate) === id)) {
        throw new Error('The successful engine response did not contain the matching JSON-RPC result.');
      }
      return messages;
    } catch (error) {
      if (continuation && this.continuationWasCancelled(continuation, error)) {
        throw this.continuationCancellation(continuation, 'state request completion');
      }
      throw new AmbiguousBridgeOutcomeError(
        `The engine accepted the request, but its response could not be read or validated: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  private rememberSuccessfulClientState(message: JSONRPCMessage, responses: readonly JSONRPCMessage[]): void {
    const id = messageId(message);
    if (id === undefined || !isJSONRPCRequest(message) || !isSuccessfulResponse(responses, id)) return;
    const params = requestParams(message);
    if (!params) return;
    if (message.method === 'tools/call' && params.name === 'session_manage') {
      const args = params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return;
      const action = (args as Record<string, unknown>).action;
      if (action === 'join') this.joinedSessionArguments = structuredClone(args as Record<string, unknown>);
      else if (action === 'leave') this.joinedSessionArguments = undefined;
      return;
    }
    if (typeof params.uri !== 'string') return;
    if (message.method === 'resources/subscribe') this.resourceSubscriptions.add(params.uri);
    else if (message.method === 'resources/unsubscribe') this.resourceSubscriptions.delete(params.uri);
  }

  private async restoreClientState(active: ActiveBridgeConnection, continuation?: BridgeContinuation): Promise<void> {
    if (this.joinedSessionArguments) {
      await this.requireSuccessfulRestore(this.internalRequest('tools/call', {
        name: 'session_manage',
        arguments: structuredClone(this.joinedSessionArguments),
      }), active, continuation);
    }
    for (const uri of this.resourceSubscriptions) {
      await this.requireSuccessfulRestore(this.internalRequest('resources/subscribe', { uri }), active, continuation);
    }
  }

  private async requireSuccessfulRestore(
    request: JSONRPCMessage,
    active: ActiveBridgeConnection,
    continuation?: BridgeContinuation,
  ): Promise<void> {
    const id = messageId(request);
    const responses = await this.post(request, active, continuation);
    if (id === undefined || !isSuccessfulResponse(responses, id)) {
      throw new Error('The replacement engine rejected remembered external-client session intent.');
    }
  }

  private internalRequest(method: string, params: Record<string, unknown>): JSONRPCMessage {
    return parseJSONRPCMessage({
      jsonrpc: '2.0',
      id: `aidraw-bridge-${++this.internalRequestSequence}`,
      method,
      params,
    });
  }

  private markCurrentMessageDispatched(active?: ActiveBridgeConnection): void {
    if (!this.currentWork) throw new Error('AIDraw MCP bridge has no current external message to dispatch.');
    this.currentWork.state = 'dispatched';
    this.currentWork.active = active;
    this.dispatchedMessage = this.currentWork.completion;
  }

  private preDispatchSignal(work: ExternalWork): AbortSignal {
    return AbortSignal.any([this.closeAbort.signal, work.cancellation.signal]);
  }

  private externalContinuation(work: ExternalWork, respectRequestCancellation = true): ExternalContinuation {
    return {
      signal: respectRequestCancellation ? this.preDispatchSignal(work) : this.closeAbort.signal,
      work,
      respectRequestCancellation,
    };
  }

  private assertExternalContinuation(continuation: ExternalContinuation, phase: string): void {
    const requestCancelled = continuation.respectRequestCancellation
      && (continuation.work.cancellationRequested
        || continuation.work.state === 'cancelled'
        || continuation.work.cancellation.signal.aborted);
    if (this.closed || this.closeAbort.signal.aborted || requestCancelled || continuation.signal.aborted) {
      throw new BridgeExternalWorkCancelledError(this.closed || this.closeAbort.signal.aborted, phase);
    }
  }

  private assertContinuation(continuation: BridgeContinuation, phase: string): void {
    if ('work' in continuation) this.assertExternalContinuation(continuation, phase);
    else this.assertRecoveryContinuation(continuation, phase);
  }

  private continuationWasCancelled(continuation: BridgeContinuation, error?: unknown): boolean {
    if (error instanceof BridgeRecoveryCancelledError || error instanceof BridgeExternalWorkCancelledError) return true;
    if (this.closed || continuation.signal.aborted) return true;
    return 'work' in continuation && continuation.respectRequestCancellation
      && (continuation.work.cancellationRequested
        || continuation.work.state === 'cancelled'
        || continuation.work.cancellation.signal.aborted);
  }

  private continuationCancellation(continuation: BridgeContinuation, phase: string): Error {
    return 'work' in continuation
      ? new BridgeExternalWorkCancelledError(this.closed || this.closeAbort.signal.aborted, phase)
      : new BridgeRecoveryCancelledError(phase);
  }

  private async acceptCancellation(message: JSONRPCMessage, target: string | number): Promise<void> {
    if (this.closed) return;
    const key = requestKey(target);
    const work = this.requestWork.get(key);
    if (!work) return;
    work.cancellationRequested = true;
    if (work.state === 'queued' || work.state === 'preparing') {
      work.state = 'cancelled';
      work.cancellation.abort();
      await this.emitCancellationResponse(work);
      return;
    }
    if (work.state !== 'dispatched' || !work.active) return;
    const active = work.active;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), IDENTITY_TIMEOUT_MS);
    try {
      const response = await this.fetch(active.state.url, {
        method: 'POST',
        headers: this.headers(active.state, active),
        body: JSON.stringify(message),
        cache: 'no-store',
        signal: AbortSignal.any([this.closeAbort.signal, timeout.signal]),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && ![401, 404].includes(response.status)) {
        this.reportError(new Error(`AIDraw engine rejected request cancellation with HTTP ${response.status}.`));
      }
    } catch (error) {
      if (!this.closed) this.reportError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timer);
    }
  }

  private async emitCancellationResponse(work: ExternalWork): Promise<void> {
    if (work.cancellationResponseEmitted || this.closed) return;
    work.cancellationResponseEmitted = true;
    const response = cancelledRequestError(work.message);
    if (response) await this.emitWithClosePolicy(response).catch(() => undefined);
  }

  private async emitWithClosePolicy(message: JSONRPCMessage, active?: ActiveBridgeConnection): Promise<void> {
    const signal = active
      ? AbortSignal.any([this.closeAbort.signal, active.eventsAbort.signal])
      : this.closeAbort.signal;
    const prior = this.outputQueue;
    const emission = prior.catch(() => undefined).then(async () => {
      // Defer invocation until a microtask so close() or generation retirement
      // published in the same turn wins before user output is touched. A
      // lifetime reader may already have received buffered bytes when its
      // session is retired, so server events also require exact object and
      // generation identity at the final output boundary.
      if (this.closed || this.closeAbort.signal.aborted) {
        throw new BridgeExternalWorkCancelledError(true, 'external output emission');
      }
      if (active && (active.eventsAbort.signal.aborted
        || this.active !== active
        || this.active?.generation !== active.generation)) {
        throw new BridgeExternalWorkCancelledError(false, 'retired lifetime output emission');
      }
      await this.options.emit(message);
    });
    this.outputQueue = emission.catch(() => undefined);
    await abortable(emission, signal, 'external output emission');
  }

  private createActiveConnection(
    state: McpEngineRunState,
    sessionId: string,
    protocolVersion: string,
    provisionalId: string,
    continuation?: BridgeContinuation,
  ): ActiveBridgeConnection {
    let resolveEventsEnd = (): void => undefined;
    const eventsEnd = new Promise<void>((resolve) => { resolveEventsEnd = resolve; });
    return {
      generation: ++this.connectionGeneration,
      state,
      sessionId,
      protocolVersion,
      provisionalId,
      eventsAbort: new AbortController(),
      recoveryScheduled: false,
      recoveryAdmitted: !continuation || 'work' in continuation,
      eventsEnded: false,
      eventsEnd,
      resolveEventsEnd,
    };
  }

  private endActiveEvents(active: ActiveBridgeConnection): void {
    if (active.eventsEnded) return;
    active.eventsEnded = true;
    active.resolveEventsEnd();
  }

  private assertRecoveryContinuation(recovery: RecoveryContinuation, phase: string): void {
    if (this.closed || recovery.signal.aborted) throw new BridgeRecoveryCancelledError(phase);
    if (recovery.replacementGeneration === undefined) {
      if (this.connectionGeneration !== recovery.expectedGeneration) {
        throw new BridgeRecoveryCancelledError(`${phase} after generation change`);
      }
      return;
    }
    if (this.active?.generation !== recovery.replacementGeneration) {
      throw new BridgeRecoveryCancelledError(`${phase} after replacement change`);
    }
  }

  private headers(
    state: McpEngineRunState,
    active?: ActiveBridgeConnection,
    provisionalId = active?.provisionalId,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${state.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(provisionalId ? { [MCP_BRIDGE_PROVISIONAL_HEADER]: provisionalId } : {}),
      ...(active ? { 'mcp-session-id': active.sessionId, 'mcp-protocol-version': active.protocolVersion } : {}),
    };
  }

  private async waitForEngine(cancellationSignal?: AbortSignal): Promise<McpEngineRunState> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (cancellationSignal?.aborted) throw new BridgeRecoveryCancelledError('engine discovery');
      const state = await readCurrentMcpEngineRunState(this.options.userDataPath);
      if (cancellationSignal?.aborted) throw new BridgeRecoveryCancelledError('engine run-state read');
      if (state && this.isProcessAlive(state.pid) && await this.hasMatchingIdentity(state, cancellationSignal)) {
        if (cancellationSignal?.aborted) throw new BridgeRecoveryCancelledError('engine identity admission');
        return state;
      }
      if (cancellationSignal?.aborted) throw new BridgeRecoveryCancelledError('engine identity check');
      if (Date.now() >= deadline) throw new Error('Launch AIDraw and retry; no current authenticated engine instance became ready before the bridge timeout.');
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), cancellationSignal);
    }
  }

  private async hasMatchingIdentity(state: McpEngineRunState, cancellationSignal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
    try {
      const response = await this.fetch(identityUrl(state), {
        method: 'GET',
        headers: { authorization: `Bearer ${state.token}`, accept: 'application/json' },
        cache: 'no-store',
        signal: cancellationSignal ? AbortSignal.any([controller.signal, cancellationSignal]) : controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      const text = await readBoundedResponse(response);
      return exactIdentity(JSON.parse(text) as unknown, state);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async startServerEvents(active: ActiveBridgeConnection, continuation?: BridgeContinuation): Promise<void> {
    if (continuation) this.assertContinuation(continuation, 'lifetime-stream dispatch');
    const response = await this.fetch(active.state.url, {
      method: 'GET',
      headers: this.headers(active.state, active),
      cache: 'no-store',
      signal: continuation
        ? AbortSignal.any([active.eventsAbort.signal, continuation.signal])
        : active.eventsAbort.signal,
    });
    if (continuation) this.assertContinuation(continuation, 'lifetime-stream response');
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BridgeHttpError(response.status, `AIDraw engine refused the bridge lifetime stream with HTTP ${response.status}.`);
    }
    void this.monitorServerEvents(active, response.body);
  }

  private async monitorServerEvents(active: ActiveBridgeConnection, body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      await this.consumeServerEvents(active, body);
      if (this.closed || active.eventsAbort.signal.aborted) return;
      const error = new Error('AIDraw MCP bridge lifetime stream ended unexpectedly.');
      this.reportError(error);
      if (active.recoveryAdmitted) this.scheduleServerEventRecovery(active, error);
    } catch (error) {
      if (this.closed || active.eventsAbort.signal.aborted) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.reportError(normalized);
      if (active.recoveryAdmitted) this.scheduleServerEventRecovery(active, normalized);
    } finally {
      this.endActiveEvents(active);
    }
  }

  private scheduleServerEventRecovery(active: ActiveBridgeConnection, interruption: Error): void {
    if (this.closed || active.eventsAbort.signal.aborted || active.recoveryScheduled) return;
    active.recoveryScheduled = true;
    const cutoff = Date.now() - this.recoveryWindowMs;
    while (this.automaticRecoveryStarts[0] !== undefined && this.automaticRecoveryStarts[0] < cutoff) {
      this.automaticRecoveryStarts.shift();
    }
    const overBudget = this.automaticRecoveryStarts.length >= this.recoveryLimit;
    if (!overBudget) this.automaticRecoveryStarts.push(Date.now());
    const recovery: PendingServerEventRecovery = {
      generation: active.generation,
      queuedThroughSequence: this.externalWorkSequence,
      promise: overBudget
        ? this.failRecoveryBudget(active, this.dispatchedMessage)
        : this.recoverInterruptedServerEvents(active, this.dispatchedMessage),
    };
    this.serverEventRecovery = recovery;
    void recovery.promise.catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.reportError(new Error(
        `AIDraw MCP bridge could not recover its interrupted lifetime stream (${interruption.message}): ${normalized.message}`,
        { cause: normalized },
      ));
    });
  }

  private async failRecoveryBudget(active: ActiveBridgeConnection, dispatchedMessage?: Promise<void>): Promise<void> {
    await dispatchedMessage;
    await this.withLifecycle(async () => {
      if (this.active === active) await this.deactivate(true);
    });
    throw new Error(`AIDraw MCP bridge stopped automatic lifetime recovery after ${this.recoveryLimit} interruptions within ${this.recoveryWindowMs} ms.`);
  }

  private async waitForScheduledServerEventRecovery(signal: AbortSignal | undefined, workSequence: number): Promise<void> {
    for (;;) {
      const failure = this.recoveryFailure;
      if (failure) {
        if (workSequence <= failure.queuedThroughSequence) throw failure.error;
        this.recoveryFailure = undefined;
      }
      const recovery = this.serverEventRecovery;
      if (!recovery) return;
      const result = await abortable(
        recovery.promise.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        signal,
        'lifetime recovery barrier',
      );
      if (this.serverEventRecovery === recovery) this.serverEventRecovery = undefined;
      if (!result.ok) {
        this.recoveryFailure = {
          queuedThroughSequence: recovery.queuedThroughSequence,
          error: result.error,
        };
        throw result.error;
      }
      this.recoveryFailure = undefined;
    }
  }

  private async recoverInterruptedServerEvents(
    interrupted: ActiveBridgeConnection,
    dispatchedMessage: Promise<void> | undefined,
  ): Promise<void> {
    // Let only the already-dispatched external request settle. The published
    // recovery barrier then runs ahead of every request already waiting in the
    // external FIFO. Recovery replays bridge-owned initialization and
    // remembered state, never a client request whose completion may be
    // ambiguous.
    await dispatchedMessage;
    const recovery: RecoveryContinuation = {
      signal: this.closeAbort.signal,
      expectedGeneration: interrupted.generation,
    };
    await this.withLifecycle(async () => {
      if (this.closed || interrupted.eventsAbort.signal.aborted
        || this.active?.generation !== interrupted.generation) return;
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 2 && !this.closed; attempt += 1) {
        try {
          this.assertRecoveryContinuation(recovery, 'engine selection');
          const state = await this.waitForEngine(recovery.signal);
          this.assertRecoveryContinuation(recovery, 'selected-engine admission');
          await this.reconnect(state, recovery);
          this.assertRecoveryContinuation(recovery, 'completed restoration');
          await this.admitRecoveredLifetime(recovery);
          this.assertRecoveryContinuation(recovery, 'stable lifetime admission');
          return;
        } catch (error) {
          if (error instanceof BridgeRecoveryCancelledError
            || this.closed || recovery.signal.aborted) {
            if (recovery.replacementGeneration !== undefined
              && this.active?.generation === recovery.replacementGeneration) {
              await this.deactivate(true);
            }
            return;
          }
          lastError = error instanceof Error ? error : new Error(String(error));
          recovery.expectedGeneration = this.connectionGeneration;
          recovery.replacementGeneration = undefined;
          if (attempt === 0) {
            try { await delay(Math.min(100, 10 * (attempt + 1)), recovery.signal); } catch { return; }
          }
        }
      }
      if (lastError) {
        if (this.active) await this.deactivate(true);
        throw lastError;
      }
    });
  }

  private async admitRecoveredLifetime(recovery: RecoveryContinuation): Promise<void> {
    const active = this.active;
    if (!active || active.generation !== recovery.replacementGeneration) {
      throw new BridgeRecoveryCancelledError('lifetime stability admission');
    }
    const outcome = await Promise.race([
      delay(this.recoveryStabilityMs, recovery.signal).then(() => 'stable' as const),
      active.eventsEnd.then(() => 'ended' as const),
    ]);
    this.assertRecoveryContinuation(recovery, 'lifetime stability observation');
    if (outcome === 'ended' || active.eventsEnded) {
      throw new BridgeStateRestoreError('The replacement engine lifetime stream ended before stability admission.');
    }
    active.recoveryAdmitted = true;
  }

  private async consumeServerEvents(active: ActiveBridgeConnection, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (this.closed || active.eventsAbort.signal.aborted || this.active !== active) return;
      pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      if (Buffer.byteLength(pending, 'utf8') > MAX_SSE_EVENT_BYTES) throw new Error('AIDraw MCP bridge rejected an oversized server event.');
      for (;;) {
        const boundary = pending.indexOf('\n\n');
        if (boundary < 0) break;
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') {
          if (this.closed || active.eventsAbort.signal.aborted || this.active !== active) return;
          await this.emitWithClosePolicy(parseJSONRPCMessage(JSON.parse(data) as unknown), active);
        }
      }
    }
  }

  private async deactivate(terminateSession: boolean): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.eventsAbort.abort();
      this.endActiveEvents(active);
      if (terminateSession) this.rememberPendingSessionRetirement(active);
    }
    if (terminateSession) await this.retryPendingSessionRetirements(1);
  }

  private rememberPendingSessionRetirement(active: ActiveBridgeConnection): void {
    this.pendingSessionRetirements.set(`${active.state.instanceId}:${active.sessionId}`, active);
  }

  private async retryPendingSessionRetirements(attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts && this.pendingSessionRetirements.size > 0; attempt += 1) {
      for (const [key, active] of [...this.pendingSessionRetirements]) {
        if (await this.tryTerminateKnownSession(active)) this.pendingSessionRetirements.delete(key);
      }
      if (this.pendingSessionRetirements.size > 0 && attempt + 1 < attempts) await delay(10);
    }
  }

  private async tryTerminateKnownSession(active: ActiveBridgeConnection): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
    try {
      const response = await this.fetch(active.state.url, {
        method: 'DELETE',
        headers: this.headers(active.state, active),
        cache: 'no-store',
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok || response.status === 401 || response.status === 404;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateUnknownProvisionalSession(state: McpEngineRunState, provisionalId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
      try {
        const response = await this.fetch(state.url, {
          method: 'DELETE',
          headers: this.headers(state, undefined, provisionalId),
          cache: 'no-store',
          signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.ok || response.status === 401) return;
      } catch { /* The host TTL remains the final bounded retirement path. */ }
      finally { clearTimeout(timer); }
      if (attempt === 0) await delay(10);
    }
  }

  private async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleQueue;
    let release = (): void => undefined;
    this.lifecycleQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Run the stable product-owned stdio entry until its parent client closes stdin. */
export async function runMcpStdioBridge(options: McpStdioBridgeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminalCloseTimeoutMs = options.terminalCloseTimeoutMs ?? DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS;
  const transport = new StdioServerTransport(input, output, { maxBufferSize: 2 * 1024 * 1024 });
  const bridge = new McpBridgeSession({
    ...options,
    emit: (message) => transport.send(message),
  });
  const pendingInputs = new Set<Promise<void>>();
  let settled = false;
  await new Promise<void>((resolve) => {
    const close = () => {
      if (settled) return;
      settled = true;
      // close() sets the cancellation boundary synchronously before awaiting
      // queued input, so automatic recovery cannot create a replacement while
      // an undispatched request is draining from the stdio transport.
      const bridgeClosing = bridge.close();
      void (async () => {
        await settleWithin(Promise.allSettled([...pendingInputs]), terminalCloseTimeoutMs);
        await settleWithin(bridgeClosing, terminalCloseTimeoutMs * 3);
        await settleWithin(transport.close().catch(() => undefined), terminalCloseTimeoutMs);
        options.terminationSignal?.removeEventListener('abort', close);
        resolve();
      })();
    };
    transport.onmessage = (message) => {
      const operation = bridge.accept(message);
      pendingInputs.add(operation);
      void operation.finally(() => pendingInputs.delete(operation));
    };
    transport.onerror = (error) => {
      options.reportError?.(error);
      close();
    };
    transport.onclose = close;
    input.once('end', close);
    input.once('close', close);
    options.terminationSignal?.addEventListener('abort', close, { once: true });
    if (options.terminationSignal?.aborted) close();
    if (!settled) {
      void transport.start().catch((error) => {
        options.reportError?.(error instanceof Error ? error : new Error(String(error)));
        close();
      });
    }
  });
}

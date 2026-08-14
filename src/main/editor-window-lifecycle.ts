export const EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS = 10_000;

export type EditorWindowFailure =
  | { kind: 'renderer-gone'; reason: string; exitCode: number }
  | { kind: 'renderer-unresponsive'; graceMs: number }
  | { kind: 'main-frame-load-failed'; errorCode: number; errorDescription: string }
  | { kind: 'load-rejected'; message: string }
  | { kind: 'create-rejected'; message: string }
  | { kind: 'bind-rejected'; message: string }
  | { kind: 'reveal-rejected'; message: string }
  | { kind: 'stale-window'; reason: 'window-destroyed' | 'renderer-destroyed' | 'renderer-crashed' | 'health-check-failed' }
  | { kind: 'destroy-rejected'; message: string };

export interface EditorWindowEvents {
  closeRequested(): void;
  closeCancelled(): void;
  closed(): void;
  mainFrameLoadStarted(): void;
  mainFrameLoadStopped(): void;
  ready(): void;
  rendererUnresponsive(): void;
  rendererResponsive(): void;
  rendererGone(reason: string, exitCode: number): void;
  mainFrameLoadFailed(errorCode: number, errorDescription: string): void;
}

export interface EditorWindowLifecycleDependencies<Window> {
  createWindow(): Window;
  bindWindowEvents(window: Window, events: EditorWindowEvents): void;
  loadWindow(window: Window): Promise<void>;
  revealWindow(window: Window): void;
  destroyWindow(window: Window): void;
  isWindowDestroyed(window: Window): boolean;
  isRendererDestroyed(window: Window): boolean;
  isRendererCrashed(window: Window): boolean;
  scheduleUnresponsiveConfirmation(delayMs: number, confirm: () => void): () => void;
  setCurrentWindow(window: Window | undefined): void;
  setEditorAttached(attached: boolean): void;
  canOpenWindow(): boolean;
  reportFailure(failure: EditorWindowFailure): void;
}

interface WindowEntry<Window> {
  window: Window;
  phase: 'loading' | 'ready';
  closeRequested: boolean;
  closeSettlement?: { promise: Promise<void>; resolve: () => void };
  failureDuringClose?: EditorWindowFailure;
  terminal: { promise: Promise<void>; resolve: () => void; settled: boolean };
  detached: boolean;
  reloadPending: boolean;
  responsiveness: 'responsive' | 'grace' | 'confirmed-unresponsive';
  cancelUnresponsiveConfirmation?: () => void;
  retiring: boolean;
  recoverWhenRetired: boolean;
  allowAutomaticRecovery: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shouldRecoverMainFrameLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== -3;
}

/**
 * Owns the attachable editor window without owning canonical engine state.
 * One explicit show request permits one automatic clean-window retry; another
 * failure leaves the engine headless until the user explicitly opens it again.
 */
export class EditorWindowLifecycle<Window> {
  private active?: WindowEntry<Window>;
  private creationPromise?: Promise<boolean>;
  private recoveryPromise?: Promise<void>;
  private automaticRecoveryPending = false;
  private attached = false;

  constructor(private readonly dependencies: EditorWindowLifecycleDependencies<Window>) {}

  isAttached(): boolean {
    return this.attached;
  }

  async show(): Promise<boolean> {
    if (!this.dependencies.canOpenWindow()) return false;
    this.resumeRecovery();
    if (this.recoveryPromise) await this.recoveryPromise;
    if (!this.dependencies.canOpenWindow()) return false;

    const shown = await this.ensureWindow(false);
    if (shown) return true;
    const recovery = this.recoveryPromise;
    if (recovery) await recovery;
    return this.attached;
  }

  /** Resume a retained retry after a failed graceful-shutdown attempt. */
  resumeRecovery(): void {
    if (!this.dependencies.canOpenWindow()) return;
    const retiring = this.active;
    if (retiring?.retiring && retiring.recoverWhenRetired && this.retire(retiring)) this.requestRecovery();
    if (this.automaticRecoveryPending) this.scheduleRecovery();
  }

  private async ensureWindow(automaticRecovery: boolean): Promise<boolean> {
    if (!this.dependencies.canOpenWindow()) return false;
    if (!automaticRecovery) this.automaticRecoveryPending = false;

    if (this.creationPromise) {
      const created = await this.creationPromise;
      if (!automaticRecovery && created && this.active && !this.active.retiring && !this.active.closeRequested) {
        this.active.allowAutomaticRecovery = true;
        return this.reveal(this.active);
      }
      if (!automaticRecovery && !created && this.dependencies.canOpenWindow()) return this.ensureWindow(false);
      return created;
    }

    const existing = this.active;
    if (existing?.retiring) {
      if (automaticRecovery) return false;
      existing.recoverWhenRetired = false;
      if (!this.retire(existing)) return false;
    } else if (existing) {
      if (existing.closeRequested) {
        const closingFailure = existing.failureDuringClose ?? this.inspectHealth(existing.window);
        if (closingFailure) {
          existing.failureDuringClose = undefined;
          existing.closeRequested = false;
          this.settleClose(existing);
          if (!this.fail(existing, closingFailure, false)) return false;
        } else {
          if (automaticRecovery) return false;
          await existing.closeSettlement?.promise;
          if (!this.dependencies.canOpenWindow()) return false;
          return this.ensureWindow(false);
        }
      } else {
        const failure = this.inspectHealth(existing.window);
        if (existing.phase === 'ready' && !failure) {
          if (!automaticRecovery) existing.allowAutomaticRecovery = true;
          if (!automaticRecovery) return this.reveal(existing);
          return true;
        }
        if (!failure) return false;
        if (!this.fail(existing, failure, false)) return false;
      }
    }

    const operation = this.createAndLoad(!automaticRecovery)
      .finally(() => {
        if (this.creationPromise === operation) this.creationPromise = undefined;
      });
    this.creationPromise = operation;
    return operation;
  }

  private async createAndLoad(allowAutomaticRecovery: boolean): Promise<boolean> {
    let window: Window;
    try {
      window = this.dependencies.createWindow();
    } catch (error) {
      this.dependencies.reportFailure({ kind: 'create-rejected', message: errorMessage(error) });
      if (allowAutomaticRecovery) this.requestRecovery();
      return false;
    }

    let settleTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { settleTerminal = resolve; });
    const entry: WindowEntry<Window> = {
      window,
      phase: 'loading',
      closeRequested: false,
      closeSettlement: undefined,
      failureDuringClose: undefined,
      terminal: { promise: terminalPromise, resolve: settleTerminal, settled: false },
      detached: false,
      reloadPending: false,
      responsiveness: 'responsive',
      cancelUnresponsiveConfirmation: undefined,
      retiring: false,
      recoverWhenRetired: false,
      allowAutomaticRecovery,
    };
    this.active = entry;
    const events: EditorWindowEvents = {
      closeRequested: () => { this.beginClose(entry); },
      closeCancelled: () => { this.cancelClose(entry); },
      closed: () => { this.release(entry); },
      mainFrameLoadStarted: () => { this.beginMainFrameLoad(entry); },
      mainFrameLoadStopped: () => { this.finishAbortedMainFrameLoad(entry); },
      ready: () => { this.markReady(entry); },
      rendererUnresponsive: () => { this.beginUnresponsiveGrace(entry); },
      rendererResponsive: () => { this.markRendererResponsive(entry); },
      rendererGone: (reason, exitCode) => {
        this.handleFailure(entry, { kind: 'renderer-gone', reason, exitCode });
      },
      mainFrameLoadFailed: (errorCode, errorDescription) => {
        this.handleFailure(entry, { kind: 'main-frame-load-failed', errorCode, errorDescription });
      },
    };

    try {
      this.dependencies.bindWindowEvents(window, events);
    } catch (error) {
      this.fail(entry, { kind: 'bind-rejected', message: errorMessage(error) }, entry.allowAutomaticRecovery);
      return false;
    }
    this.dependencies.setCurrentWindow(window);

    const load = Promise.resolve()
      .then(() => this.dependencies.loadWindow(window))
      .then(
        () => ({ kind: 'loaded' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
    const loadOutcome = await Promise.race([
      load,
      entry.terminal.promise.then(() => ({ kind: 'retired' as const })),
    ]);
    if (loadOutcome.kind === 'retired') return false;
    if (loadOutcome.kind === 'rejected') {
      if (this.active === entry && !entry.retiring && !entry.closeRequested) {
        this.fail(entry, { kind: 'load-rejected', message: errorMessage(loadOutcome.error) }, entry.allowAutomaticRecovery);
      }
      return false;
    }

    if (this.active !== entry || entry.retiring || entry.closeRequested) return false;
    if (!this.dependencies.canOpenWindow()) {
      this.deferUntilWindowOpeningResumes(entry);
      return false;
    }
    const failure = this.inspectHealth(window);
    if (failure) {
      this.fail(entry, failure, entry.allowAutomaticRecovery);
      return false;
    }
    this.markReady(entry);
    return this.reveal(entry);
  }

  private inspectHealth(window: Window): EditorWindowFailure | undefined {
    try {
      if (this.dependencies.isWindowDestroyed(window)) return { kind: 'stale-window', reason: 'window-destroyed' };
      if (this.dependencies.isRendererDestroyed(window)) return { kind: 'stale-window', reason: 'renderer-destroyed' };
      if (this.dependencies.isRendererCrashed(window)) return { kind: 'stale-window', reason: 'renderer-crashed' };
      return undefined;
    } catch {
      return { kind: 'stale-window', reason: 'health-check-failed' };
    }
  }

  private markReady(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring) return;
    if (!this.dependencies.canOpenWindow()) {
      this.deferUntilWindowOpeningResumes(entry);
      return;
    }
    const failure = this.inspectHealth(entry.window);
    if (failure) {
      this.fail(entry, failure, entry.allowAutomaticRecovery);
      return;
    }
    entry.phase = 'ready';
    entry.reloadPending = false;
    if (!entry.closeRequested) {
      entry.detached = false;
      this.publishAttached(true);
    }
  }

  private beginClose(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring || entry.closeRequested) return;
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    entry.closeSettlement = { promise, resolve: settle };
    entry.failureDuringClose = undefined;
    entry.closeRequested = true;
  }

  private cancelClose(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring || !entry.closeRequested) return;
    const recordedFailure = entry.failureDuringClose;
    entry.failureDuringClose = undefined;
    entry.closeRequested = false;
    this.settleClose(entry);
    const failure = recordedFailure ?? this.inspectHealth(entry.window);
    if (failure) {
      this.fail(entry, failure, entry.allowAutomaticRecovery);
      return;
    }
    this.dependencies.setCurrentWindow(entry.window);
    if (entry.phase === 'ready') {
      entry.detached = false;
      this.publishAttached(true);
    }
  }

  private beginMainFrameLoad(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring || entry.closeRequested || entry.phase !== 'ready') return;
    entry.phase = 'loading';
    entry.reloadPending = true;
    this.detach(entry);
  }

  /** An aborted replacement navigation leaves the prior healthy main frame usable. */
  private finishAbortedMainFrameLoad(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring || !entry.reloadPending) return;
    if (entry.closeRequested) {
      entry.phase = 'ready';
      entry.reloadPending = false;
      return;
    }
    this.markReady(entry);
  }

  private beginUnresponsiveGrace(entry: WindowEntry<Window>): void {
    if (
      this.active !== entry
      || entry.retiring
      || entry.responsiveness !== 'responsive'
      || entry.failureDuringClose
    ) return;
    entry.responsiveness = 'grace';
    const cancel = this.dependencies.scheduleUnresponsiveConfirmation(
      EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
      () => {
        if (this.active !== entry || entry.retiring || entry.responsiveness !== 'grace') return;
        entry.cancelUnresponsiveConfirmation = undefined;
        entry.responsiveness = 'confirmed-unresponsive';
        // A close still unresolved after Electron's unresponsive signal and the
        // full grace is not a confirmed close. Release any waiter before retiring
        // the unusable shell; a real close would already have emitted `closed`.
        if (entry.closeRequested) {
          entry.closeRequested = false;
          this.settleClose(entry);
        }
        this.handleFailure(entry, {
          kind: 'renderer-unresponsive',
          graceMs: EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
        });
      },
    );
    if (entry.responsiveness === 'grace') entry.cancelUnresponsiveConfirmation = cancel;
    else cancel();
  }

  private markRendererResponsive(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring || entry.responsiveness !== 'grace') return;
    this.cancelUnresponsiveConfirmation(entry);
  }

  private cancelUnresponsiveConfirmation(entry: WindowEntry<Window>): void {
    const cancel = entry.cancelUnresponsiveConfirmation;
    entry.cancelUnresponsiveConfirmation = undefined;
    if (entry.responsiveness === 'grace') entry.responsiveness = 'responsive';
    cancel?.();
  }

  private handleFailure(entry: WindowEntry<Window>, failure: EditorWindowFailure): void {
    if (this.active !== entry || entry.retiring) return;
    this.cancelUnresponsiveConfirmation(entry);
    if (entry.closeRequested) {
      entry.failureDuringClose = failure;
      this.settleClose(entry);
      return;
    }
    this.fail(entry, failure, entry.allowAutomaticRecovery);
  }

  private reveal(entry: WindowEntry<Window>): boolean {
    if (this.active !== entry || entry.phase !== 'ready' || entry.closeRequested || entry.retiring) return false;
    if (!this.dependencies.canOpenWindow()) {
      this.deferUntilWindowOpeningResumes(entry);
      return false;
    }
    const failure = this.inspectHealth(entry.window);
    if (failure) {
      this.fail(entry, failure, entry.allowAutomaticRecovery);
      return false;
    }
    try {
      this.dependencies.revealWindow(entry.window);
      return true;
    } catch (error) {
      this.fail(entry, { kind: 'reveal-rejected', message: errorMessage(error) }, entry.allowAutomaticRecovery);
      return false;
    }
  }

  /** Returns true only after the old native shell is confirmed retired. */
  private fail(entry: WindowEntry<Window>, failure: EditorWindowFailure, recover: boolean): boolean {
    if (this.active !== entry || entry.retiring) return false;
    this.cancelUnresponsiveConfirmation(entry);
    entry.retiring = true;
    entry.recoverWhenRetired = recover;
    this.settleTerminal(entry);
    this.dependencies.setCurrentWindow(undefined);
    this.detach(entry);
    this.dependencies.reportFailure(failure);
    const retired = this.retire(entry);
    if (retired && recover) this.requestRecovery();
    return retired;
  }

  /** A quit race is not a renderer failure; retain the interrupted show for a failed quit. */
  private deferUntilWindowOpeningResumes(entry: WindowEntry<Window>): void {
    if (this.active !== entry || entry.retiring) return;
    this.cancelUnresponsiveConfirmation(entry);
    entry.retiring = true;
    entry.recoverWhenRetired = true;
    this.settleTerminal(entry);
    this.dependencies.setCurrentWindow(undefined);
    this.detach(entry);
    if (this.retire(entry)) this.requestRecovery();
  }

  private retire(entry: WindowEntry<Window>): boolean {
    let destroyed = false;
    try {
      destroyed = this.dependencies.isWindowDestroyed(entry.window);
    } catch (error) {
      this.dependencies.reportFailure({ kind: 'destroy-rejected', message: `window state could not be inspected: ${errorMessage(error)}` });
    }
    if (!destroyed) {
      try {
        this.dependencies.destroyWindow(entry.window);
      } catch (error) {
        this.dependencies.reportFailure({ kind: 'destroy-rejected', message: errorMessage(error) });
      }
      try {
        destroyed = this.dependencies.isWindowDestroyed(entry.window);
      } catch (error) {
        this.dependencies.reportFailure({ kind: 'destroy-rejected', message: `window retirement could not be confirmed: ${errorMessage(error)}` });
      }
    }
    if (this.active !== entry) return true;
    if (!destroyed) return false;
    if (this.active === entry) this.active = undefined;
    return true;
  }

  private release(entry: WindowEntry<Window>): void {
    if (this.active !== entry) return;
    this.cancelUnresponsiveConfirmation(entry);
    const recover = entry.retiring && entry.recoverWhenRetired;
    this.active = undefined;
    this.settleTerminal(entry);
    this.settleClose(entry);
    this.dependencies.setCurrentWindow(undefined);
    this.detach(entry);
    if (recover) this.requestRecovery();
  }

  private settleClose(entry: WindowEntry<Window>): void {
    const settlement = entry.closeSettlement;
    entry.closeSettlement = undefined;
    settlement?.resolve();
  }

  private settleTerminal(entry: WindowEntry<Window>): void {
    if (entry.terminal.settled) return;
    entry.terminal.settled = true;
    entry.terminal.resolve();
  }

  private publishAttached(attached: boolean): void {
    if (this.attached === attached) return;
    this.attached = attached;
    this.dependencies.setEditorAttached(attached);
  }

  /** Detach each concrete renderer session once, even if it failed before readiness. */
  private detach(entry: WindowEntry<Window>): void {
    if (entry.detached) return;
    entry.detached = true;
    this.attached = false;
    this.dependencies.setEditorAttached(false);
  }

  private requestRecovery(): void {
    this.automaticRecoveryPending = true;
    if (this.dependencies.canOpenWindow()) this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.recoveryPromise || !this.automaticRecoveryPending) return;
    const operation = Promise.resolve()
      .then(async () => {
        if (this.creationPromise) await this.creationPromise;
        if (!this.automaticRecoveryPending || !this.dependencies.canOpenWindow()) return;
        if (this.active) {
          this.automaticRecoveryPending = false;
          return;
        }
        this.automaticRecoveryPending = false;
        await this.ensureWindow(true);
      })
      .finally(() => {
        if (this.recoveryPromise === operation) this.recoveryPromise = undefined;
      });
    this.recoveryPromise = operation;
  }
}

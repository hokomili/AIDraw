import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
  EditorWindowLifecycle,
  shouldRecoverMainFrameLoadFailure,
  type EditorWindowEvents,
  type EditorWindowFailure,
} from '@main/editor-window-lifecycle';

interface FakeWindow {
  id: number;
  destroyed: boolean;
  rendererDestroyed: boolean;
  rendererCrashed: boolean;
  minimized: boolean;
  events: EditorWindowEvents;
}

interface HarnessOptions {
  loadWindow?: (window: FakeWindow) => Promise<void>;
  createFailures?: number;
  bindFailures?: number;
  revealFailures?: number;
  destroyFailures?: number;
}

interface ScheduledUnresponsiveConfirmation {
  delayMs: number;
  confirm(): void;
  cancelled: boolean;
}

const inertEvents: EditorWindowEvents = {
  closeRequested: () => undefined,
  closeCancelled: () => undefined,
  closed: () => undefined,
  mainFrameLoadStarted: () => undefined,
  mainFrameLoadStopped: () => undefined,
  ready: () => undefined,
  rendererUnresponsive: () => undefined,
  rendererResponsive: () => undefined,
  rendererGone: () => undefined,
  mainFrameLoadFailed: () => undefined,
};

function createHarness(options: HarnessOptions = {}) {
  const windows: FakeWindow[] = [];
  const failures: EditorWindowFailure[] = [];
  const attachments: boolean[] = [];
  const unresponsiveConfirmations: ScheduledUnresponsiveConfirmation[] = [];
  let current: FakeWindow | undefined;
  let recoverable = true;
  let createAttempts = 0;
  let bindAttempts = 0;
  let revealAttempts = 0;
  let destroyAttempts = 0;
  const revealWindow = vi.fn((window: FakeWindow) => {
    revealAttempts += 1;
    if (revealAttempts <= (options.revealFailures ?? 0)) throw new Error(`simulated reveal failure ${revealAttempts}`);
    window.minimized = false;
  });
  const lifecycle = new EditorWindowLifecycle<FakeWindow>({
    createWindow: () => {
      createAttempts += 1;
      if (createAttempts <= (options.createFailures ?? 0)) throw new Error(`simulated create failure ${createAttempts}`);
      const window = { id: windows.length + 1, destroyed: false, rendererDestroyed: false, rendererCrashed: false, minimized: false, events: inertEvents };
      windows.push(window);
      return window;
    },
    bindWindowEvents: (window, events) => {
      bindAttempts += 1;
      window.events = events;
      if (bindAttempts <= (options.bindFailures ?? 0)) throw new Error(`simulated bind failure ${bindAttempts}`);
    },
    loadWindow: options.loadWindow ?? (async (window) => { window.events.ready(); }),
    revealWindow,
    destroyWindow: (window) => {
      destroyAttempts += 1;
      if (destroyAttempts <= (options.destroyFailures ?? 0)) throw new Error(`simulated destroy failure ${destroyAttempts}`);
      window.destroyed = true;
      window.events.closed();
    },
    isWindowDestroyed: (window) => window.destroyed,
    isRendererDestroyed: (window) => window.rendererDestroyed,
    isRendererCrashed: (window) => window.rendererCrashed,
    scheduleUnresponsiveConfirmation: (delayMs, confirm) => {
      const scheduled: ScheduledUnresponsiveConfirmation = { delayMs, confirm, cancelled: false };
      unresponsiveConfirmations.push(scheduled);
      return () => { scheduled.cancelled = true; };
    },
    setCurrentWindow: (window) => { current = window; },
    setEditorAttached: (attached) => { attachments.push(attached); },
    canOpenWindow: () => recoverable,
    reportFailure: (failure) => { failures.push(failure); },
  });
  return {
    lifecycle,
    windows,
    failures,
    attachments,
    unresponsiveConfirmations,
    revealWindow,
    current: () => current,
    setRecoverable: (value: boolean) => { recoverable = value; },
  };
}

describe('editor window lifecycle', () => {
  it('reports no attached editor before the main frame finishes loading', async () => {
    let releaseLoad!: () => void;
    const loadRelease = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const harness = createHarness({ loadWindow: async (window) => {
      await loadRelease;
      window.events.ready();
    } });

    const showing = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });
    expect(harness.lifecycle.isAttached()).toBe(false);
    expect(harness.attachments).toEqual([]);

    releaseLoad();
    await expect(showing).resolves.toBe(true);
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.attachments).toEqual([true]);
  });

  it('reuses a healthy loaded editor and rearms one later automatic recovery', async () => {
    const harness = createHarness();
    await expect(harness.lifecycle.show()).resolves.toBe(true);
    const first = harness.windows[0];
    first.minimized = true;

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.windows).toHaveLength(1);
    expect(harness.current()).toBe(first);
    expect(first.minimized).toBe(false);
    expect(harness.attachments).toEqual([true]);
    expect(harness.revealWindow).toHaveBeenCalledTimes(2);
  });

  it('keeps one transiently stalled shell when Electron reports it responsive inside the fixed grace', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.events.rendererUnresponsive();
    first.events.rendererUnresponsive();
    expect(harness.unresponsiveConfirmations).toHaveLength(1);
    expect(harness.unresponsiveConfirmations[0]).toMatchObject({
      delayMs: EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
      cancelled: false,
    });

    first.events.rendererResponsive();
    expect(harness.unresponsiveConfirmations[0].cancelled).toBe(true);
    harness.unresponsiveConfirmations[0].confirm();
    await Promise.resolve();

    expect(harness.windows).toEqual([first]);
    expect(harness.current()).toBe(first);
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.attachments).toEqual([true]);
    expect(harness.failures).toEqual([]);
  });

  it('replaces a persistently unresponsive shell once and preserves the explicit-show retry boundary', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.events.rendererUnresponsive();
    harness.unresponsiveConfirmations[0].confirm();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    const replacement = harness.windows[1];
    expect(first.destroyed).toBe(true);
    expect(harness.current()).toBe(replacement);
    expect(harness.failures).toEqual([{
      kind: 'renderer-unresponsive',
      graceMs: EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
    }]);

    first.events.rendererResponsive();
    first.events.rendererUnresponsive();
    expect(harness.unresponsiveConfirmations).toHaveLength(1);

    replacement.events.rendererUnresponsive();
    harness.unresponsiveConfirmations[1].confirm();
    await vi.waitFor(() => { expect(harness.current()).toBeUndefined(); });
    expect(harness.windows).toHaveLength(2);
    expect(harness.lifecycle.isAttached()).toBe(false);

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.windows).toHaveLength(3);
    expect(harness.current()).toBe(harness.windows[2]);
    expect(harness.attachments).toEqual([true, false, true, false, true]);
  });

  it('recovers a persistent initial-load hang once across concurrent show requests', async () => {
    const never = new Promise<void>(() => undefined);
    const harness = createHarness({ loadWindow: async (window) => {
      if (window.id === 1) await never;
      else window.events.ready();
    } });
    const firstShow = harness.lifecycle.show();
    const secondShow = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });

    harness.windows[0].events.rendererUnresponsive();
    harness.unresponsiveConfirmations[0].confirm();

    await expect(Promise.all([firstShow, secondShow])).resolves.toEqual([true, true]);
    expect(harness.windows).toHaveLength(2);
    expect(harness.windows[0].destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
  });

  it('distinguishes responsive and persistent stalls across tentative close cancellation', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.events.rendererUnresponsive();
    first.events.closeRequested();
    first.events.rendererResponsive();
    first.events.closeCancelled();
    harness.unresponsiveConfirmations[0].confirm();
    expect(harness.windows).toEqual([first]);
    expect(harness.failures).toEqual([]);

    first.events.rendererUnresponsive();
    first.events.closeRequested();
    const pendingShow = harness.lifecycle.show();
    await Promise.resolve();
    harness.unresponsiveConfirmations[1].confirm();
    await expect(pendingShow).resolves.toBe(true);
    expect(first.destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{
      kind: 'renderer-unresponsive',
      graceMs: EDITOR_RENDERER_UNRESPONSIVE_GRACE_MS,
    }]);

    first.events.closeCancelled();
    expect(harness.current()).toBe(harness.windows[1]);
  });

  it('does not revive an intentionally closed shell from a stale unresponsive confirmation', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.rendererUnresponsive();
    first.events.closeRequested();
    first.destroyed = true;
    first.events.closed();

    harness.unresponsiveConfirmations[0].confirm();
    await Promise.resolve();
    expect(harness.unresponsiveConfirmations[0].cancelled).toBe(true);
    expect(harness.windows).toEqual([first]);
    expect(harness.current()).toBeUndefined();
    expect(harness.failures).toEqual([]);
  });

  it('keeps a responsive reload and replaces a persistently hung reload without stale reattachment', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.events.rendererUnresponsive();
    first.events.mainFrameLoadStarted();
    first.events.rendererResponsive();
    first.events.ready();
    harness.unresponsiveConfirmations[0].confirm();
    expect(harness.current()).toBe(first);
    expect(harness.lifecycle.isAttached()).toBe(true);

    first.events.mainFrameLoadStarted();
    first.events.rendererUnresponsive();
    harness.unresponsiveConfirmations[1].confirm();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(first.destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.attachments).toEqual([true, false, true, false, true]);
  });

  it('defers persistent-hang replacement during shutdown and resumes it only if shutdown fails', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.rendererUnresponsive();
    harness.setRecoverable(false);
    harness.unresponsiveConfirmations[0].confirm();
    await Promise.resolve();

    expect(first.destroyed).toBe(true);
    expect(harness.windows).toHaveLength(1);
    expect(harness.current()).toBeUndefined();

    harness.setRecoverable(true);
    harness.lifecycle.resumeRecovery();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.lifecycle.isAttached()).toBe(true);
  });

  it('replaces one gone renderer without detaching the canonical engine or accepting stale close events', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.rendererCrashed = true;
    first.events.rendererGone('crashed', 21);
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    const replacement = harness.windows[1];
    expect(first.destroyed).toBe(true);
    expect(harness.current()).toBe(replacement);
    expect(harness.attachments).toEqual([true, false, true]);
    expect(harness.failures).toEqual([{ kind: 'renderer-gone', reason: 'crashed', exitCode: 21 }]);

    first.events.closed();
    expect(harness.current()).toBe(replacement);
    expect(harness.attachments).toEqual([true, false, true]);
  });

  it('bounds consecutive automatic recovery and retries only after another explicit show', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    harness.windows[0].events.rendererGone('killed', 9);
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });

    harness.windows[1].events.rendererGone('launch-failed', 12);
    await vi.waitFor(() => { expect(harness.current()).toBeUndefined(); });
    expect(harness.windows).toHaveLength(2);
    expect(harness.attachments).toEqual([true, false, true, false]);

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.windows).toHaveLength(3);
    expect(harness.current()).toBe(harness.windows[2]);
  });

  it('detects a missed crashed-renderer event on the next show and replaces the stale shell', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const stale = harness.windows[0];
    stale.rendererCrashed = true;

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(stale.destroyed).toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{ kind: 'stale-window', reason: 'renderer-crashed' }]);
  });

  it('rebuilds one editor whose main document fails to load', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const failed = harness.windows[0];

    failed.events.mainFrameLoadFailed(-105, 'NAME_NOT_RESOLVED');
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(failed.destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{
      kind: 'main-frame-load-failed',
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED',
    }]);
  });

  it('retries once when the initial window load promise rejects', async () => {
    let loadAttempt = 0;
    const harness = createHarness({ loadWindow: async (window) => {
      loadAttempt += 1;
      if (loadAttempt === 1) throw new Error('simulated initial renderer load rejection');
      window.events.ready();
    } });

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.windows[0].destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.attachments).toEqual([false, true]);
    expect(harness.failures).toEqual([{
      kind: 'load-rejected',
      message: 'simulated initial renderer load rejection',
    }]);
  });

  it('does not let a terminal renderer event wait forever on an unsettled initial load promise', async () => {
    const never = new Promise<void>(() => undefined);
    const harness = createHarness({ loadWindow: async (window) => {
      if (window.id === 1) await never;
      else window.events.ready();
    } });
    const showing = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });
    harness.windows[0].events.rendererGone('crashed-during-load', 35);

    await expect(showing).resolves.toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.windows[0].destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
  });

  it.each([
    ['create', { createFailures: 1 }, 'create-rejected'],
    ['bind', { bindFailures: 1 }, 'bind-rejected'],
    ['reveal', { revealFailures: 1 }, 'reveal-rejected'],
  ] as const)('contains one %s exception and completes the one permitted retry', async (_label, options, failureKind) => {
    const harness = createHarness(options);
    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.failures[0]?.kind).toBe(failureKind);
    expect(harness.windows).toHaveLength(failureKind === 'create-rejected' ? 1 : 2);
  });

  it('coalesces concurrent show calls onto one loading window', async () => {
    let releaseLoad!: () => void;
    const loadRelease = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const harness = createHarness({ loadWindow: async (window) => {
      await loadRelease;
      window.events.ready();
    } });

    const first = harness.lifecycle.show();
    const second = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });
    releaseLoad();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(harness.windows).toHaveLength(1);
    expect(harness.attachments).toEqual([true]);
  });

  it('preserves a concurrent show intent when the window it joined closes during initial load', async () => {
    let releaseLoad!: () => void;
    const loadRelease = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const harness = createHarness({ loadWindow: async (window) => {
      await loadRelease;
      window.events.ready();
    } });
    const initialShow = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });
    const first = harness.windows[0];
    first.events.closeRequested();
    const concurrentShow = harness.lifecycle.show();
    first.destroyed = true;
    first.events.closed();
    releaseLoad();

    await expect(initialShow).resolves.toBe(false);
    await expect(concurrentShow).resolves.toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
  });

  it('honors a later explicit show after an in-flight automatic replacement fails', async () => {
    let rejectReplacement!: () => void;
    const replacementRelease = new Promise<void>((_resolve, reject) => {
      rejectReplacement = () => { reject(new Error('simulated automatic replacement failure')); };
    });
    const harness = createHarness({ loadWindow: async (window) => {
      if (window.id === 2) await replacementRelease;
      window.events.ready();
    } });
    await harness.lifecycle.show();
    harness.windows[0].events.rendererGone('crashed', 41);
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });

    const explicitShow = harness.lifecycle.show();
    rejectReplacement();
    await expect(explicitShow).resolves.toBe(true);
    expect(harness.windows).toHaveLength(3);
    expect(harness.current()).toBe(harness.windows[2]);
  });

  it('does not create a second shell until failed retirement is later confirmed', async () => {
    const harness = createHarness({ destroyFailures: 1 });
    await harness.lifecycle.show();
    const stale = harness.windows[0];
    stale.events.rendererGone('crashed', 51);
    await vi.waitFor(() => { expect(harness.failures.some((failure) => failure.kind === 'destroy-rejected')).toBe(true); });
    expect(stale.destroyed).toBe(false);
    expect(harness.windows).toHaveLength(1);
    expect(harness.current()).toBeUndefined();
    expect(harness.lifecycle.isAttached()).toBe(false);

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(stale.destroyed).toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
  });

  it('restores attachment after a cancelled close and still recovers a later renderer failure', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.current()).toBe(first);
    const pendingShow = harness.lifecycle.show();
    first.events.closeCancelled();
    await expect(pendingShow).resolves.toBe(true);
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.current()).toBe(first);

    first.events.rendererGone('crashed', 61);
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.attachments).toEqual([true, false, true]);
  });

  it('recovers a renderer lost while a close is pending if that close is then cancelled', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    first.rendererCrashed = true;
    first.events.rendererGone('crashed-during-close', 62);
    expect(harness.windows).toHaveLength(1);
    expect(harness.failures).toEqual([]);

    first.events.closeCancelled();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(first.destroyed).toBe(true);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{ kind: 'renderer-gone', reason: 'crashed-during-close', exitCode: 62 }]);
  });

  it('wakes an explicit show when the closing renderer fails after that show began waiting', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    const pendingShow = harness.lifecycle.show();
    await Promise.resolve();

    first.rendererCrashed = true;
    first.events.rendererGone('crashed-after-close-wait', 63);
    await expect(pendingShow).resolves.toBe(true);
    expect(first.destroyed).toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{ kind: 'renderer-gone', reason: 'crashed-after-close-wait', exitCode: 63 }]);
  });

  it('does not reopen an intentionally closed editor', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    expect(harness.lifecycle.isAttached()).toBe(true);
    first.events.rendererGone('clean-exit', 0);
    first.events.closed();
    await Promise.resolve();
    expect(harness.lifecycle.isAttached()).toBe(false);
    expect(harness.windows).toHaveLength(1);
    expect(harness.current()).toBeUndefined();
    expect(harness.failures).toEqual([]);
  });

  it('coalesces repeated show requests across a closing window and reattaches after it closes', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    const firstShow = harness.lifecycle.show();
    const secondShow = harness.lifecycle.show();
    await Promise.resolve();
    expect(harness.windows).toHaveLength(1);

    first.events.closed();
    await expect(Promise.all([firstShow, secondShow])).resolves.toEqual([true, true]);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.lifecycle.isAttached()).toBe(true);
  });

  it('does not wait forever for a missed closed event when a closing shell is already destroyed', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];
    first.events.closeRequested();
    first.destroyed = true;

    await expect(harness.lifecycle.show()).resolves.toBe(true);
    expect(harness.windows).toHaveLength(2);
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.failures).toEqual([{ kind: 'stale-window', reason: 'window-destroyed' }]);
  });

  it('makes attachment and visual-playback truth follow a full-document reload or aborted reload', async () => {
    const harness = createHarness();
    await harness.lifecycle.show();
    const first = harness.windows[0];

    first.events.mainFrameLoadStarted();
    expect(harness.lifecycle.isAttached()).toBe(false);
    expect(harness.current()).toBe(first);
    first.events.ready();
    expect(harness.lifecycle.isAttached()).toBe(true);

    first.events.mainFrameLoadStarted();
    expect(harness.lifecycle.isAttached()).toBe(false);
    first.events.mainFrameLoadStopped();
    expect(harness.lifecycle.isAttached()).toBe(true);

    first.events.mainFrameLoadStarted();
    first.events.closeRequested();
    first.events.mainFrameLoadStopped();
    expect(harness.lifecycle.isAttached()).toBe(false);
    first.events.closeCancelled();
    expect(harness.lifecycle.isAttached()).toBe(true);
    expect(harness.windows).toHaveLength(1);
    expect(harness.attachments).toEqual([true, false, true, false, true, false, true]);
  });

  it('suppresses show and recovery during shutdown, then resumes the retained retry after shutdown fails', async () => {
    const harness = createHarness({ destroyFailures: 1 });
    await harness.lifecycle.show();
    harness.setRecoverable(false);
    expect(await harness.lifecycle.show()).toBe(false);
    expect(harness.revealWindow).toHaveBeenCalledTimes(1);

    harness.windows[0].events.rendererGone('crashed', 31);
    await Promise.resolve();
    expect(harness.windows).toHaveLength(1);
    expect(harness.windows[0].destroyed).toBe(false);
    expect(harness.current()).toBeUndefined();

    harness.setRecoverable(true);
    harness.lifecycle.resumeRecovery();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.lifecycle.isAttached()).toBe(true);
  });

  it('does not reveal an in-flight load after shutdown starts and resumes it only after shutdown fails', async () => {
    let releaseLoad!: () => void;
    const loadRelease = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const harness = createHarness({ loadWindow: async (window) => {
      await loadRelease;
      window.events.ready();
    } });
    const showing = harness.lifecycle.show();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(1); });
    harness.setRecoverable(false);
    releaseLoad();
    await expect(showing).resolves.toBe(false);
    expect(harness.windows[0].destroyed).toBe(true);
    expect(harness.revealWindow).not.toHaveBeenCalled();
    expect(harness.current()).toBeUndefined();

    harness.setRecoverable(true);
    harness.lifecycle.resumeRecovery();
    await vi.waitFor(() => { expect(harness.windows).toHaveLength(2); });
    expect(harness.current()).toBe(harness.windows[1]);
    expect(harness.lifecycle.isAttached()).toBe(true);
  });

  it('classifies only non-aborted main-frame failures for shell recovery', () => {
    expect(shouldRecoverMainFrameLoadFailure(-3, true)).toBe(false);
    expect(shouldRecoverMainFrameLoadFailure(-105, false)).toBe(false);
    expect(shouldRecoverMainFrameLoadFailure(-105, true)).toBe(true);
  });

  it('wires failures and close cancellation into the production Electron window', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    expect(source).toContain("window.webContents.on('render-process-gone'");
    expect(source).toContain("window.on('unresponsive'");
    expect(source).toContain("window.on('responsive'");
    expect(source).toContain("window.webContents.on('did-fail-load'");
    expect(source).toContain("window.webContents.on('will-prevent-unload'");
    expect(source).toContain("window.webContents.on('did-start-navigation'");
    expect(source).toContain("window.webContents.on('did-stop-loading'");
    expect(source).toContain('events.rendererGone(details.reason, details.exitCode);');
    expect(source).toContain('events.rendererUnresponsive();');
    expect(source).toContain('events.rendererResponsive();');
    expect(source).toContain('if (shouldRecoverMainFrameLoadFailure(errorCode, isMainFrame)) events.mainFrameLoadFailed(errorCode, errorDescription);');
    expect(source).toContain('handle(IPC.acquireHumanLock, (_event, request: HumanLockRequest) => editorWindowLifecycle.isAttached()');
    expect(source).toContain('if (event.defaultPrevented) events.closeCancelled();');
    expect(source).toContain('!gracefulShutdown.isQuitPending()');
    expect(source).toContain('resumeEditorRecovery = () => { editorWindowLifecycle.resumeRecovery(); };');
  });
});

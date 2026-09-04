import { describe, expect, it, vi } from 'vitest';
import { MacosBackgroundPresentation, type MacosActivationPolicy } from '@main/macos-background-presentation';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(showDock: () => Promise<void> = async () => undefined, enabled = true) {
  const actions: string[] = [];
  const policies: MacosActivationPolicy[] = [];
  const presentation = new MacosBackgroundPresentation({
    enabled,
    setActivationPolicy: (policy) => { policies.push(policy); actions.push(`policy:${policy}`); },
    hideDock: () => { actions.push('dock:hide'); },
    showDock: async () => { actions.push('dock:show'); await showDock(); },
  });
  return { presentation, actions, policies };
}

describe('macOS prohibited background presentation', () => {
  it('starts prohibited and promotes only through an editor preparation', async () => {
    const { presentation, actions } = harness();

    presentation.prohibitBeforeReady();
    expect(presentation.acceptsSystemActivation()).toBe(false);
    expect(actions).toEqual(['dock:hide', 'policy:prohibited']);

    await presentation.prepareEditor();
    expect(presentation.acceptsSystemActivation()).toBe(true);
    expect(actions).toEqual(['dock:hide', 'policy:prohibited', 'policy:regular', 'dock:show']);

    presentation.restoreBackground();
    expect(presentation.acceptsSystemActivation()).toBe(false);
    expect(actions.slice(-2)).toEqual(['dock:hide', 'policy:prohibited']);
  });

  it('reapplies prohibited state after a stale asynchronous Dock show settles', async () => {
    const dock = deferred();
    const { presentation, actions } = harness(() => dock.promise);
    presentation.prohibitBeforeReady();
    const promoting = presentation.prepareEditor();
    await vi.waitFor(() => { expect(actions).toContain('dock:show'); });

    presentation.restoreBackground();
    dock.resolve();
    await promoting;

    expect(presentation.acceptsSystemActivation()).toBe(false);
    expect(actions.slice(-4)).toEqual([
      'dock:hide', 'policy:prohibited',
      'dock:hide', 'policy:prohibited',
    ]);
  });

  it('fails closed when foreground promotion fails', async () => {
    const dock = deferred();
    const { presentation, actions } = harness(() => dock.promise);
    presentation.prohibitBeforeReady();
    const promoting = presentation.prepareEditor();
    dock.reject(new Error('simulated Dock failure'));

    await expect(promoting).rejects.toThrow('simulated Dock failure');
    expect(presentation.acceptsSystemActivation()).toBe(false);
    expect(actions.slice(-2)).toEqual(['dock:hide', 'policy:prohibited']);
  });

  it('is inert on non-macOS platforms', async () => {
    const { presentation, actions } = harness(async () => undefined, false);
    presentation.prohibitBeforeReady();
    await presentation.prepareEditor();
    presentation.restoreBackground();
    expect(presentation.acceptsSystemActivation()).toBe(true);
    expect(actions).toEqual([]);
  });
});

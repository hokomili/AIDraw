import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument, createPixelDocument, type AIDrawDocument } from '@aidraw/core';
import type { AIDrawDesktopAPI, EditorBootstrapSnapshot, WorkspaceEvent, WorkspaceSnapshot } from '../../src/common/contracts';
import { DEFAULT_ONION_SKIN_PREFERENCES, type OnionSkinPreferences } from '../../src/common/onion-skin';
import { reconcileWorkspaceSnapshot, useEditorStore } from '../../src/renderer/store';

function snapshot(workspaceRevision: number, document: AIDrawDocument): WorkspaceSnapshot {
  return {
    workspaceRevision,
    documents: [{ id: document.id, name: document.name, kind: document.kind, dirty: document.dirty, revision: document.revision, filePath: document.filePath }],
    activeDocumentId: document.id,
    activeDocument: document,
    jobs: [],
    mcp: { running: true, sessions: [] },
    canUndo: false,
    canRedo: false,
    agentHistories: [],
    checkpoints: [],
  };
}

function bootstrapSnapshot(workspaceRevision: number, document: AIDrawDocument, onionSkinPreferences: OnionSkinPreferences = { ...DEFAULT_ONION_SKIN_PREFERENCES }): EditorBootstrapSnapshot {
  return { ...snapshot(workspaceRevision, document), onionSkinPreferences };
}

const transientState = (current: WorkspaceSnapshot) => ({
  snapshot: current,
  selectedTool: 'bezier' as const,
  brushSize: 12,
  zoom: 2,
  selectedEntityId: 'old-object',
  selectedEntityIds: ['old-object'],
  canvasViewport: { x: 1, y: 2, width: 3, height: 4 },
  canvasAnimation: { illustrationTimeMs: 500, playing: true, onionSkin: false, direction: 'forward' as const },
  revealRequest: { id: 'old-reveal', documentId: current.activeDocumentId!, objectId: 'old-object' },
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('renderer workspace ordering and document isolation', () => {
  it('rejects an older activation response and clears all document-scoped transient state in one patch', () => {
    const first = createIllustrationDocument('First illustration');
    const second = createPixelDocument('sprite', 'Second sprite');
    const current = transientState(snapshot(4, first));
    const accepted = reconcileWorkspaceSnapshot(current, snapshot(6, second));
    const next = { ...current, ...accepted };

    expect(next.snapshot?.activeDocumentId).toBe(second.id);
    expect(next).toMatchObject({ selectedTool: 'pencil', brushSize: 1, zoom: 1, selectedEntityIds: [] });
    expect(next.selectedEntityId).toBeUndefined();
    expect(next.canvasViewport).toBeUndefined();
    expect(next.canvasAnimation).toBeUndefined();
    expect(next.revealRequest).toBeUndefined();
    expect(reconcileWorkspaceSnapshot(next, snapshot(5, first))).toEqual({});
  });

  it('subscribes before bootstrap and keeps the newer canonical event when hydration resolves late', async () => {
    const first = createIllustrationDocument('Bootstrap snapshot');
    const second = createIllustrationDocument('Live event snapshot');
    let resolveBootstrap!: (value: EditorBootstrapSnapshot) => void;
    const bootstrap = new Promise<EditorBootstrapSnapshot>((resolve) => { resolveBootstrap = resolve; });
    let onEvent: ((event: WorkspaceEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const api = {
      bootstrap: vi.fn(() => bootstrap),
      onEvent: vi.fn((callback: (event: WorkspaceEvent) => void) => { onEvent = callback; return unsubscribe; }),
    } as unknown as AIDrawDesktopAPI;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { aidraw: api } });
    useEditorStore.setState({ ...transientState(snapshot(0, first)), loading: true });

    const initialization = useEditorStore.getState().initialize();
    expect(onEvent).toBeTypeOf('function');
    onEvent!({ type: 'workspace', snapshot: snapshot(2, second) });
    resolveBootstrap(bootstrapSnapshot(1, first));
    await initialization;

    expect(useEditorStore.getState().loading).toBe(false);
    expect(useEditorStore.getState().snapshot?.activeDocumentId).toBe(second.id);
    expect(useEditorStore.getState().snapshot?.workspaceRevision).toBe(2);
  });

  it('surfaces recovered-image repair as one bounded bootstrap warning', async () => {
    const document = createIllustrationDocument('Recovered document');
    const warning = 'Recovery omitted 2 invalid embedded image payloads across 1 recovered document; the recovered document state and asset metadata were preserved.';
    const recovered = { ...bootstrapSnapshot(1, document), recoveryWarnings: [warning] };
    const setTimeout = vi.fn();
    const api = {
      bootstrap: vi.fn(async () => recovered),
      onEvent: vi.fn(() => vi.fn()),
    } as unknown as AIDrawDesktopAPI;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { aidraw: api, setTimeout } });
    useEditorStore.setState({ snapshot: undefined, loading: true, toast: undefined });

    await useEditorStore.getState().initialize();

    expect(useEditorStore.getState().snapshot).toEqual(recovered);
    expect(useEditorStore.getState().toast).toMatchObject({ tone: 'warning', message: warning });
    expect(setTimeout).toHaveBeenCalledOnce();
  });

  it('hydrates main-owned onion preferences before editing and never publishes renderer defaults during bootstrap', async () => {
    const first = createPixelDocument('sprite', 'Persistent onion preferences');
    const second = createPixelDocument('sprite', 'Other pixel document');
    const durable = { ...DEFAULT_ONION_SKIN_PREFERENCES, enabled: false, previousFrames: 4, nextFrames: 2, previousTint: '#123456' };
    let bootstrapCalls = 0;
    const setOnionSkinPreferences = vi.fn();
    const api = {
      bootstrap: vi.fn(async () => bootstrapSnapshot(++bootstrapCalls, first, durable)),
      onEvent: vi.fn(() => vi.fn()),
      setOnionSkinPreferences,
    } as unknown as AIDrawDesktopAPI;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { aidraw: api } });
    useEditorStore.setState({
      snapshot: undefined,
      loading: true,
      onionSkinPreferences: { ...DEFAULT_ONION_SKIN_PREFERENCES },
    });

    await useEditorStore.getState().initialize();
    expect(useEditorStore.getState().loading).toBe(false);
    expect(useEditorStore.getState().onionSkinPreferences).toEqual(durable);
    expect(setOnionSkinPreferences).not.toHaveBeenCalled();

    useEditorStore.getState().setSnapshot(snapshot(2, second));
    expect(useEditorStore.getState().onionSkinPreferences).toEqual(durable);

    // A replacement renderer starts from compiled defaults and must hydrate the same main-owned value.
    useEditorStore.setState({ snapshot: undefined, loading: true, onionSkinPreferences: { ...DEFAULT_ONION_SKIN_PREFERENCES } });
    await useEditorStore.getState().initialize();
    expect(useEditorStore.getState().onionSkinPreferences).toEqual(durable);
    expect(setOnionSkinPreferences).not.toHaveBeenCalled();
  });

  it('keeps a failed preference change usable in the editor, reports persistence failure, and allows a later save', async () => {
    const document = createPixelDocument('sprite', 'Onion save failure');
    const before = snapshot(3, document);
    const setTimeout = vi.fn();
    const applyTransaction = vi.fn();
    const setOnionSkinPreferences = vi.fn()
      .mockResolvedValueOnce({ saved: false, message: 'Onion skin changed in this editor, but AIDraw could not save it. The previous saved preference remains.' })
      .mockResolvedValueOnce({ saved: true, preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES, nextFrames: 4 } });
    const api = { setOnionSkinPreferences, applyTransaction } as unknown as AIDrawDesktopAPI;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { aidraw: api, setTimeout } });
    useEditorStore.setState({
      snapshot: before,
      toast: undefined,
      onionSkinPreferences: { ...DEFAULT_ONION_SKIN_PREFERENCES },
    });

    const failedIntent = { ...DEFAULT_ONION_SKIN_PREFERENCES, enabled: false, previousOpacity: 0.5 };
    useEditorStore.getState().setOnionSkinPreferences(failedIntent);
    await vi.waitFor(() => expect(setOnionSkinPreferences).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useEditorStore.getState().toast).toMatchObject({ tone: 'warning', message: expect.stringContaining('could not save') }));
    expect(useEditorStore.getState().onionSkinPreferences).toEqual(failedIntent);
    expect(useEditorStore.getState().snapshot).toEqual(before);
    expect(applyTransaction).not.toHaveBeenCalled();

    const recoveredIntent = { ...DEFAULT_ONION_SKIN_PREFERENCES, nextFrames: 4 };
    useEditorStore.getState().setOnionSkinPreferences(recoveredIntent);
    await vi.waitFor(() => expect(setOnionSkinPreferences).toHaveBeenCalledTimes(2));
    expect(useEditorStore.getState().onionSkinPreferences).toEqual(recoveredIntent);
    expect(useEditorStore.getState().snapshot).toEqual(before);
    expect(applyTransaction).not.toHaveBeenCalled();
  });

  it('cancels a late canvas gesture instead of routing old-document operations into the new active tab', async () => {
    const first = createIllustrationDocument('Gesture source');
    const second = createIllustrationDocument('Current tab');
    const applyTransaction = vi.fn();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { aidraw: { applyTransaction } } });
    useEditorStore.setState({ snapshot: snapshot(3, second) });

    await expect(useEditorStore.getState().apply('Late first-tab preview', [{ kind: 'document.rename', name: 'Wrong target' }], first.id)).resolves.toBe(false);
    expect(applyTransaction).not.toHaveBeenCalled();
  });
});

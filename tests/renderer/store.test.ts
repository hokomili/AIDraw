import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument, createPixelDocument, type AIDrawDocument } from '@aidraw/core';
import type { AIDrawDesktopAPI, WorkspaceEvent, WorkspaceSnapshot } from '../../src/common/contracts';
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
    let resolveBootstrap!: (value: WorkspaceSnapshot) => void;
    const bootstrap = new Promise<WorkspaceSnapshot>((resolve) => { resolveBootstrap = resolve; });
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
    resolveBootstrap(snapshot(1, first));
    await initialization;

    expect(useEditorStore.getState().loading).toBe(false);
    expect(useEditorStore.getState().snapshot?.activeDocumentId).toBe(second.id);
    expect(useEditorStore.getState().snapshot?.workspaceRevision).toBe(2);
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

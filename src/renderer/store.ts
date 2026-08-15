import { create } from 'zustand';
import type { Actor, CanvasOperation, Id, OrderedDitherMatrixSize } from '@aidraw/core';
import { CanvasOperationSchema, HUMAN_ACTOR, createId, nowIso } from '@aidraw/core';
import type { NewDocumentOptions, WorkspaceSnapshot } from '../common/contracts';
import { DEFAULT_ONION_SKIN_PREFERENCES, parseOnionSkinPreferences, type OnionSkinPreferences } from '../common/onion-skin';
import { DEFAULT_SPRITE_SYMMETRY_PREFERENCES, parseSpriteSymmetryPreferences, type SpriteSymmetryPreferences } from '../common/sprite-symmetry';
import type { ReplaySource } from './replay';

export type EditorTool =
  | 'select' | 'lasso' | 'hand' | 'zoom' | 'pen' | 'pencil' | 'brush' | 'eraser'
  | 'bezier' | 'node' | 'gradient' | 'crop' | 'line' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'text' | 'eyedropper'
  | 'fill' | 'replace' | 'wand' | 'stamp' | 'dither' | 'lighten' | 'darken' | 'terrain' | 'tile-object';

type ToastTone = 'info' | 'success' | 'warning' | 'error';

interface EditorState {
  snapshot?: WorkspaceSnapshot;
  loading: boolean;
  selectedTool: EditorTool;
  primaryColor: string;
  secondaryColor: string;
  brushSize: number;
  brushPreset: string;
  opacity: number;
  zoom: number;
  pixelIndex: number;
  ditherMatrixSize: OrderedDitherMatrixSize;
  ditherCoverage: number;
  ditherMixIndex: number;
  onionSkinPreferences: OnionSkinPreferences;
  symmetryPreferences: SpriteSymmetryPreferences;
  rightPanel: 'layers' | 'assets' | 'animation' | 'activity' | 'generation';
  selectedEntityId?: Id;
  selectedEntityIds: Id[];
  canvasViewport?: { x: number; y: number; width: number; height: number };
  canvasAnimation?: { activeAssetId?: Id; activeFrameId?: Id; activeTagId?: Id; illustrationTimeMs?: number; playing: boolean; onionSkin: boolean; direction: 'forward' | 'reverse' | 'ping-pong' };
  revealRequest?: { id: Id; documentId: Id; objectId: Id };
  reportPulse: number;
  playbacks: Record<Id, ReplaySource & { documentId: Id; actor: Actor; label: string; progress: number; operations: CanvasOperation[]; lane: number }>;
  toast?: { id: string; tone: ToastTone; message: string };
  initialize(): Promise<void>;
  setSnapshot(snapshot: WorkspaceSnapshot): void;
  setTool(tool: EditorTool): void;
  setColor(color: string): void;
  setSecondaryColor(color: string): void;
  setBrushSize(value: number): void;
  setBrushPreset(value: EditorState['brushPreset']): void;
  setOpacity(value: number): void;
  setZoom(value: number): void;
  setPixelIndex(value: number): void;
  setDitherMatrixSize(value: OrderedDitherMatrixSize): void;
  setDitherCoverage(value: number): void;
  setDitherMixIndex(value: number): void;
  setOnionSkinPreferences(preferences: OnionSkinPreferences): void;
  setSpriteSymmetryPreferences(preferences: SpriteSymmetryPreferences): void;
  setRightPanel(panel: EditorState['rightPanel']): void;
  setSelectedEntity(id?: Id): void;
  setSelectedEntities(ids: Id[]): void;
  toggleSelectedEntity(id: Id): void;
  setCanvasViewport(viewport?: EditorState['canvasViewport']): void;
  setCanvasAnimation(animation?: EditorState['canvasAnimation']): void;
  revealEntity(id: Id): void;
  notify(message: string, tone?: ToastTone): void;
  newDocument(options: NewDocumentOptions): Promise<void>;
  activate(documentId: Id): Promise<void>;
  apply(label: string, operations: CanvasOperation[], expectedDocumentId?: Id): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  save(saveAs?: boolean): Promise<void>;
  open(): Promise<void>;
}

let unsubscribe: (() => void) | undefined;

type WorkspaceReconcileState = Pick<EditorState,
  'snapshot' | 'selectedTool' | 'brushSize' | 'zoom' | 'selectedEntityId' | 'selectedEntityIds' |
  'canvasViewport' | 'canvasAnimation' | 'revealRequest'
>;

export function reconcileWorkspaceSnapshot(state: WorkspaceReconcileState, snapshot: WorkspaceSnapshot): Partial<EditorState> {
  if (!Number.isSafeInteger(snapshot.workspaceRevision) || snapshot.workspaceRevision < 0) return {};
  if (snapshot.activeDocumentId !== snapshot.activeDocument?.id) return {};
  if (state.snapshot && snapshot.workspaceRevision < state.snapshot.workspaceRevision) return {};
  if (state.snapshot?.activeDocumentId === snapshot.activeDocumentId) return { snapshot };
  return {
    snapshot,
    selectedTool: snapshot.activeDocument?.kind === 'pixel' ? 'pencil' : 'select',
    brushSize: snapshot.activeDocument?.kind === 'pixel' ? 1 : state.brushSize,
    zoom: 1,
    selectedEntityId: undefined,
    selectedEntityIds: [],
    canvasViewport: undefined,
    canvasAnimation: undefined,
    revealRequest: undefined,
  };
}

export function safePlaybackOperations(value: unknown): CanvasOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((operation) => {
    const parsed = CanvasOperationSchema.safeParse(operation);
    return parsed.success ? [parsed.data] : [];
  });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  loading: true,
  selectedTool: 'select',
  primaryColor: '#27213c',
  secondaryColor: '#fffdf7',
  brushSize: 12,
  brushPreset: 'hard-round',
  opacity: 1,
  zoom: 1,
  pixelIndex: 1,
  ditherMatrixSize: 4,
  ditherCoverage: 0.5,
  ditherMixIndex: 0,
  onionSkinPreferences: { ...DEFAULT_ONION_SKIN_PREFERENCES },
  symmetryPreferences: { mode: DEFAULT_SPRITE_SYMMETRY_PREFERENCES.mode, bindings: [] },
  rightPanel: 'layers',
  playbacks: {},
  reportPulse: 0,
  selectedEntityIds: [],

  initialize: async () => {
    unsubscribe?.();
    unsubscribe = window.aidraw.onEvent((event) => {
      if (event.type === 'workspace') set((state) => reconcileWorkspaceSnapshot(state, event.snapshot));
      else if (event.type === 'playback') set((state) => {
        const playbacks = { ...state.playbacks };
        if (event.status === 'playing') {
          const previous = playbacks[event.transactionId];
          playbacks[event.transactionId] = {
            documentId: event.documentId,
            actor: event.actor,
            label: event.label,
            progress: Number.isFinite(event.progress) ? Math.max(0, Math.min(1, event.progress)) : 0,
            operations: safePlaybackOperations(event.operations),
            lane: event.lane,
            replay: event.replay ?? previous?.replay ?? false,
            sourceOperations: event.sourceOperations
              ? safePlaybackOperations(event.sourceOperations)
              : previous?.sourceOperations ?? [],
          };
        }
        else delete playbacks[event.transactionId];
        return { playbacks };
      });
      else if (event.type === 'interchange-report') set((state) => ({ reportPulse: state.reportPulse + 1 }));
    });
    const snapshot = await window.aidraw.bootstrap();
    set((state) => ({
      ...reconcileWorkspaceSnapshot(state, snapshot),
      onionSkinPreferences: structuredClone(snapshot.onionSkinPreferences),
      symmetryPreferences: structuredClone(snapshot.symmetryPreferences),
      loading: false,
    }));
    if (snapshot.recoveryWarnings?.length) get().notify(snapshot.recoveryWarnings.join(' '), 'warning');
  },
  setSnapshot: (snapshot) => set((state) => reconcileWorkspaceSnapshot(state, snapshot)),
  setTool: (selectedTool) => set({ selectedTool }),
  setColor: (primaryColor) => set({ primaryColor }),
  setSecondaryColor: (secondaryColor) => set({ secondaryColor }),
  setBrushSize: (brushSize) => set({ brushSize: Math.max(1, Math.min(500, brushSize)) }),
  setBrushPreset: (brushPreset) => set({ brushPreset }),
  setOpacity: (opacity) => set({ opacity: Math.max(0.01, Math.min(1, opacity)) }),
  setZoom: (zoom) => set({ zoom: Math.max(0.05, Math.min(64, zoom)) }),
  setPixelIndex: (pixelIndex) => set({ pixelIndex }),
  setDitherMatrixSize: (ditherMatrixSize) => set({ ditherMatrixSize }),
  setDitherCoverage: (ditherCoverage) => set({ ditherCoverage: Math.max(0, Math.min(1, ditherCoverage)) }),
  setDitherMixIndex: (ditherMixIndex) => set({ ditherMixIndex: Math.max(0, Math.min(255, Math.trunc(ditherMixIndex))) }),
  setOnionSkinPreferences: (value) => {
    const onionSkinPreferences = parseOnionSkinPreferences(value);
    set({ onionSkinPreferences });
    void window.aidraw.setOnionSkinPreferences(onionSkinPreferences)
      .then((result) => { if (!result.saved) get().notify(result.message, 'warning'); })
      .catch(() => get().notify('Onion skin changed in this editor, but AIDraw could not save it. The previous saved preference remains.', 'warning'));
  },
  setSpriteSymmetryPreferences: (value) => {
    const symmetryPreferences = parseSpriteSymmetryPreferences(value);
    set({ symmetryPreferences });
    void window.aidraw.setSpriteSymmetryPreferences(symmetryPreferences)
      .then((result) => { if (!result.saved) get().notify(result.message, 'warning'); })
      .catch(() => get().notify('Sprite symmetry changed in this editor, but AIDraw could not save it. The previous saved preference remains.', 'warning'));
  },
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setSelectedEntity: (selectedEntityId) => set({ selectedEntityId, selectedEntityIds: selectedEntityId ? [selectedEntityId] : [] }),
  setSelectedEntities: (selectedEntityIds) => set({ selectedEntityIds, selectedEntityId: selectedEntityIds.at(-1) }),
  toggleSelectedEntity: (id) => set((state) => { const selectedEntityIds = state.selectedEntityIds.includes(id) ? state.selectedEntityIds.filter((entry) => entry !== id) : [...state.selectedEntityIds, id]; return { selectedEntityIds, selectedEntityId: selectedEntityIds.at(-1) }; }),
  setCanvasViewport: (canvasViewport) => set({ canvasViewport }),
  setCanvasAnimation: (canvasAnimation) => set({ canvasAnimation }),
  revealEntity: (objectId) => set((state) => {
    const documentId = state.snapshot?.activeDocumentId;
    if (!documentId) return state;
    return {
      selectedEntityId: objectId,
      selectedEntityIds: [objectId],
      selectedTool: 'select',
      revealRequest: { id: createId('reveal'), documentId, objectId },
    };
  }),
  notify: (message, tone = 'info') => {
    const id = createId('toast');
    set({ toast: { id, tone, message } });
    window.setTimeout(() => {
      if (get().toast?.id === id) set({ toast: undefined });
    }, 3200);
  },
  newDocument: async (options) => {
    const snapshot = await window.aidraw.newDocument(options);
    set((state) => reconcileWorkspaceSnapshot({ ...state, brushSize: snapshot.activeDocument?.kind === 'pixel' ? state.brushSize : 12 }, snapshot));
  },
  activate: async (documentId) => {
    const snapshot = await window.aidraw.activateDocument(documentId);
    set((state) => reconcileWorkspaceSnapshot(state, snapshot));
  },
  apply: async (label, operations, expectedDocumentId) => {
    const document = get().snapshot?.activeDocument;
    if (!document || operations.length === 0 || (expectedDocumentId && document.id !== expectedDocumentId)) return false;
    const response = await window.aidraw.applyTransaction({
      id: createId('tx'),
      clientOperationId: createId('human-op'),
      documentId: document.id,
      actor: HUMAN_ACTOR,
      label,
      createdAt: nowIso(),
      operations,
      playback: { mode: 'instant', speed: 1 },
    });
    if (response.status !== 'committed' && response.status !== 'duplicate') {
      get().notify(response.message ?? 'The action could not be applied.', response.status === 'conflict' ? 'error' : 'warning');
      return false;
    }
    return true;
  },
  undo: async () => {
    const response = await window.aidraw.undo(get().snapshot?.activeDocumentId);
    if (response.status !== 'committed') get().notify(response.message ?? 'Nothing to undo.');
  },
  redo: async () => {
    const response = await window.aidraw.redo(get().snapshot?.activeDocumentId);
    if (response.status !== 'committed') get().notify(response.message ?? 'Nothing to redo.');
  },
  save: async (saveAs = false) => {
    const id = get().snapshot?.activeDocumentId;
    const result = saveAs ? await window.aidraw.saveDocumentAs(id) : await window.aidraw.saveDocument(id);
    if (result.saved) get().notify(`Saved ${result.filePath ?? 'document'}`, 'success');
  },
  open: async () => {
    const result = await window.aidraw.openDocuments();
    if (result.warnings.length) get().notify(result.warnings.join(' '), 'warning');
    else if (result.opened.length) get().notify(`Opened ${result.opened.length} document${result.opened.length === 1 ? '' : 's'}.`, 'success');
  },
}));

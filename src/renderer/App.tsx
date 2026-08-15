import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Brush,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Crop,
  Copy,
  Download,
  Eraser,
  FilePlus2,
  FolderOpen,
  Grid3X3,
  Hand,
  Image,
  Keyboard,
  Eye,
  EyeOff,
  Lasso,
  Layers3,
  ListTree,
  LocateFixed,
  Lock,
  Minus,
  Moon,
  MousePointer2,
  OctagonX,
  PaintBucket,
  Palette,
  PenTool,
  Pencil,
  Play,
  Pipette,
  Redo2,
  Repeat2,
  Save,
  Search,
  Shapes,
  Sparkles,
  Square,
  Stamp,
  Star,
  SunMedium,
  Type,
  Undo2,
  Unlock,
  Upload,
  WandSparkles,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import type {
  AIDrawDocument,
  CanvasOperation,
  IllustrationDocument,
  IllustrationLayer,
  IllustrationObject,
  MapObject,
  PaintStyle,
  PixelDocument,
  PaletteCycle,
  PixelLayer,
  PixelSprite,
  PixelTileset,
  RasterBrushPreset,
  TextObject,
  TextStyle,
  TileMapObject,
  TileObjectAlignment,
  TilemapLayer,
  WangSet,
} from "@aidraw/core";
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  MAX_TILEMAP_LAYER_OFFSET,
  MAX_TILESET_DRAWING_OFFSET,
  applyTextStyleRange,
  countPaletteIndexUsage,
  createId,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  decodeTiledGid,
  illustrationAtTime,
  nowIso,
  resolveTilesetForGid,
  resizePixelSpriteCanvas,
  replaceStyledText,
  replaceAndDeletePaletteIndexOperations,
  resolveRasterBrushPreset,
  textStyleAt,
} from "@aidraw/core";
import {
  MAX_PROVIDER_CREDENTIAL_BYTES,
  type GeneratedOutput,
  type GenerationComparisonSource,
  type GenerationJobResult,
  type GenerationMode,
  type GenerationProvider,
  type GenerationProviderStatus,
  type GenerationRequest,
} from "../common/generation";
import { GENERATION_PROVIDER_MODES, generationRequestError } from "../common/generation-capabilities";
import { packPixelLinks, pixelLinkHealth } from "../common/pixel-links";
import type { PaletteImportMode } from "../common/palette-interchange";
import {
  commitOrderedDitherPhaseDraft,
  createOrderedDitherPhaseDraft,
  orderedDitherConfigurationsEqual,
  reconcileOrderedDitherPhaseDraft,
  withAppliedOrderedDitherPreset,
  withOrderedDitherPhaseDraftText,
  withOrderedDitherConfiguration,
  withSavedOrderedDitherPreset,
  withoutOrderedDitherPreset,
  type OrderedDitherConfiguration,
  type OrderedDitherPhaseDraft,
} from "../common/ordered-dither-preferences";
import { approximateLocalObjectBounds } from "../common/illustration-geometry";
import { buildPolishedGoldMaterial } from "../common/material-presets";
import { inspectPathNodes, setPathClosed, splitPathAtNode } from "../common/path-nodes";
import { convertPathArcsToCubics } from "../common/path-conversion";
import { joinPathObjects } from "../common/path-topology";
import { alignIllustrationObjects, distributeIllustrationObjects, type AlignmentTarget, type DistributionMode } from "../common/alignment";
import { actorClientLabel, actorIdentityLabel } from "../common/actor-identity";
import { interchangeFidelityCodeLabel } from "../common/interchange-fidelity";
import { AGENT_CLIENTS, type AgentClientId, type AgentClientSetupResult } from "../common/agent-clients";
import { cropImageToAspect, resetImageCrop } from "../common/image-crop";
import { BrushLibraryDialog } from "./components/BrushLibraryDialog";
import { DitherPresetDialog, OrderedDitherPhaseInput } from "./components/DitherPresetDialog";
import { ImageCropFields } from "./components/ImageCropFields";
import { flattenLayerTree, layerTreeDescendants, moveLayerTreeEntry } from "../common/layer-tree";
import { assignWangTile, deleteWangColor, deleteWangSet, upsertWangColor, upsertWangSet } from "../common/wang-authoring";
import { TILE_VARIANT_GROUP_PROPERTY, tileVariantCandidates, tileVariantGroup } from "../common/tile-variants";
import type {
  BatchDocumentResult,
  CheckpointComparisonResult,
  DocumentTab,
  DocumentPreset,
  EngineStatus,
  InterchangeReport,
  McpCredentialLifecycleResult,
  NewDocumentKind,
  NewDocumentOptions,
  PixelLinkAction,
  SpriteSheetSelection,
} from "../common/contracts";
import { calculateSpriteSheetLayout, type SpriteSheetSliceOptions } from "../common/sprite-sheet";
import { IllustrationCanvas } from "./canvas/IllustrationCanvas";
import { PixelCanvas } from "./canvas/PixelCanvas";
import { useEditorStore, type EditorTool } from "./store";
import { EditorDialog } from "./components/EditorDialog";
import { CollisionShapeEditor } from "./components/CollisionShapeEditor";
import { IllustrationAnimationPanel } from "./components/IllustrationAnimationPanel";
import { TileAnimationEditor } from "./components/TileAnimationEditor";
import { TilesetSliceEditor } from "./components/TilesetSliceEditor";
import { TileVariantPreview } from "./components/TileVariantPreview";
import { TileMapObjectInspector } from "./components/TileMapObjectInspector";
import { ShortcutReferenceDialog } from "./components/ShortcutReferenceDialog";
import { InspectorLayoutControls } from "./components/InspectorLayoutControls";
import { documentTabFocusIndex } from "./document-tabs";
import { menuFocusIndex } from "./popover-navigation";
import { shortcutHelpRequested, toolRailFocusIndex } from "./shortcuts";
import {
  shortcutActionForEvent,
  shortcutActionIdForTool,
  shortcutAriaKeyShortcuts,
  shortcutChordForAction,
  shortcutChordLabel,
} from "../common/shortcut-preferences";
import { requireWritableTileObject, requireWritableTileObjectLayer, TILE_OBJECT_ALIGNMENT_OPTIONS } from "../common/tile-object-authoring";
import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  MAX_INSPECTOR_EXPANDED_WIDTH,
  effectiveInspectorWidth,
} from "../common/workspace-layout";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

interface ToolDefinition {
  id: EditorTool;
  label: string;
  icon: Icon;
}

const commonTools: ToolDefinition[] = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "lasso", label: "Lasso", icon: Lasso },
  { id: "hand", label: "Pan", icon: Hand },
  { id: "zoom", label: "Zoom", icon: ZoomIn },
];

const illustrationTools: ToolDefinition[] = [
  ...commonTools,
  { id: "pen", label: "Pressure pen", icon: PenTool },
  { id: "pencil", label: "Vector pencil", icon: Pencil },
  { id: "bezier", label: "Bézier path", icon: PenTool },
  { id: "node", label: "Node editor", icon: MousePointer2 },
  { id: "brush", label: "Raster brush", icon: Brush },
  { id: "eraser", label: "Eraser", icon: Eraser },
  { id: "line", label: "Line / arrow", icon: Minus },
  { id: "rectangle", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "polygon", label: "Polygon", icon: Shapes },
  { id: "star", label: "Star", icon: Star },
  { id: "gradient", label: "Gradient", icon: Palette },
  { id: "crop", label: "Image crop", icon: Crop },
  { id: "text", label: "Text", icon: Type },
  { id: "eyedropper", label: "Eyedropper", icon: Pipette },
];

const pixelTools: ToolDefinition[] = [
  ...commonTools,
  { id: "pencil", label: "Pixel-perfect pencil", icon: Pencil },
  { id: "eraser", label: "Eraser", icon: Eraser },
  { id: "fill", label: "Fill", icon: PaintBucket },
  { id: "replace", label: "Replace color", icon: Palette },
  { id: "line", label: "Pixel line", icon: Minus },
  { id: "rectangle", label: "Pixel rectangle", icon: Square },
  { id: "ellipse", label: "Pixel ellipse", icon: Circle },
  { id: "wand", label: "Magic wand", icon: WandSparkles },
  { id: "stamp", label: "Stamp", icon: Stamp },
  { id: "terrain", label: "Wang terrain", icon: Shapes },
  { id: "tile-object", label: "Tile object", icon: Layers3 },
  { id: "dither", label: "Ordered dither", icon: Grid3X3 },
  { id: "lighten", label: "Lighten", icon: SunMedium },
  { id: "darken", label: "Darken", icon: Moon },
  { id: "text", label: "Bitmap text", icon: Type },
  { id: "eyedropper", label: "Palette picker", icon: Pipette },
];

function pixelDimension(value: string | number, fallback = 64): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(8192, Math.round(parsed)))
    : fallback;
}

function ModalShell({
  title,
  description,
  onClose,
  className = "",
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => [...(surfaceRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter((element) => element.offsetParent !== null);
    const focusFrame = window.requestAnimationFrame(() => {
      if (!surfaceRef.current?.contains(document.activeElement)) focusableElements()[0]?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!surfaceRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) { event.preventDefault(); surfaceRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (!surfaceRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={surfaceRef}
        className={`modal-surface ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <strong id={titleId}>{title}</strong>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            type="button"
            className="modal-close"
            title="Close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

const newDocumentDefinitions: Array<{
  kind: NewDocumentKind;
  label: string;
  description: string;
  icon: Icon;
  tone: string;
  width: number;
  height: number;
}> = [
  {
    kind: "illustration",
    label: "Illustration",
    description: "Vector objects and tiled paint layers",
    icon: PenTool,
    tone: "illustration",
    width: 1920,
    height: 1080,
  },
  {
    kind: "sprite",
    label: "Pixel Sprite",
    description: "Indexed artwork with layered animation",
    icon: Grid3X3,
    tone: "pixel",
    width: 64,
    height: 64,
  },
  {
    kind: "tilemap",
    label: "Pixel Tilemap",
    description: "Finite or sparse-infinite game maps",
    icon: Shapes,
    tone: "tile",
    width: 64,
    height: 64,
  },
  {
    kind: "project",
    label: "Pixel Project",
    description: "Sprites, tilesets, maps, and shared palettes",
    icon: Layers3,
    tone: "project",
    width: 64,
    height: 64,
  },
];

const documentPresets: Record<
  NewDocumentKind,
  Array<{ label: string; width: number; height: number }>
> = {
  illustration: [
    { label: "HD", width: 1920, height: 1080 },
    { label: "Square", width: 1080, height: 1080 },
    { label: "Portrait", width: 1080, height: 1920 },
  ],
  sprite: [
    { label: "16 px", width: 16, height: 16 },
    { label: "32 px", width: 32, height: 32 },
    { label: "64 px", width: 64, height: 64 },
  ],
  tilemap: [
    { label: "32 tiles", width: 32, height: 32 },
    { label: "64 tiles", width: 64, height: 64 },
    { label: "128 tiles", width: 128, height: 128 },
  ],
  project: [
    { label: "16 px", width: 16, height: 16 },
    { label: "32 px", width: 32, height: 32 },
    { label: "64 px", width: 64, height: 64 },
  ],
};

function NewDocumentDialog({
  onClose,
  initialKind = "illustration",
}: {
  onClose: () => void;
  initialKind?: NewDocumentKind;
}) {
  const newDocument = useEditorStore((state) => state.newDocument);
  const notify = useEditorStore((state) => state.notify);
  const initialDefinition = newDocumentDefinitions.find(
    (entry) => entry.kind === initialKind,
  )!;
  const [kind, setKind] = useState<NewDocumentKind>(initialKind);
  const [name, setName] = useState("");
  const [width, setWidth] = useState(String(initialDefinition.width));
  const [height, setHeight] = useState(String(initialDefinition.height));
  const [backgroundMode, setBackgroundMode] = useState<"solid" | "transparent">(
    "solid",
  );
  const [backgroundColor, setBackgroundColor] = useState("#fffdf7");
  const [orientation, setOrientation] = useState<"orthogonal" | "isometric">(
    "orthogonal",
  );
  const [infinite, setInfinite] = useState(false);
  const [tileWidth, setTileWidth] = useState("16");
  const [tileHeight, setTileHeight] = useState("16");
  const [creating, setCreating] = useState(false);
  const [customPresets, setCustomPresets] = useState<DocumentPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const definition = newDocumentDefinitions.find(
    (entry) => entry.kind === kind,
  )!;

  useEffect(() => {
    let active = true;
    void window.aidraw.listDocumentPresets().then((presets) => {
      if (active) setCustomPresets(presets);
    }).catch(() => {
      if (active) notify("Custom document presets could not be loaded.", "warning");
    });
    return () => { active = false; };
  }, [notify]);

  const chooseKind = (next: NewDocumentKind) => {
    const defaults = newDocumentDefinitions.find(
      (entry) => entry.kind === next,
    )!;
    setKind(next);
    setWidth(String(defaults.width));
    setHeight(String(defaults.height));
  };

  const configuredOptions = (): NewDocumentOptions => {
    const options: NewDocumentOptions = {
      kind,
      width: pixelDimension(width, definition.width),
      height: pixelDimension(height, definition.height),
    };
    if (kind === "illustration") options.background = backgroundMode === "transparent" ? null : backgroundColor;
    if (kind === "tilemap") {
      options.orientation = orientation;
      options.infinite = infinite;
      options.tileWidth = pixelDimension(tileWidth, 16);
      options.tileHeight = pixelDimension(tileHeight, 16);
    }
    return options;
  };

  const applyPreset = (preset: DocumentPreset) => {
    const options = preset.options;
    setWidth(String(options.width ?? definition.width));
    setHeight(String(options.height ?? definition.height));
    if (kind === "illustration") {
      setBackgroundMode(options.background === null ? "transparent" : "solid");
      if (typeof options.background === "string") setBackgroundColor(options.background.slice(0, 7));
    }
    if (kind === "tilemap") {
      setOrientation(options.orientation ?? "orthogonal");
      setInfinite(options.infinite ?? false);
      setTileWidth(String(options.tileWidth ?? 16));
      setTileHeight(String(options.tileHeight ?? 16));
    }
  };

  const savePreset = async () => {
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      const preset = await window.aidraw.saveDocumentPreset({ name: presetName, options: configuredOptions() });
      setCustomPresets((current) => [...current.filter((entry) => entry.id !== preset.id), preset]);
      setPresetName("");
      notify(`Saved document preset “${preset.name}”.`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The document preset could not be saved.", "error");
    } finally {
      setSavingPreset(false);
    }
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const options: NewDocumentOptions = { ...configuredOptions(), name: name.trim() || undefined };
    setCreating(true);
    try {
      await newDocument(options);
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <ModalShell
      title="New document"
      description="Choose a workspace, then configure its canvas before creating it."
      onClose={onClose}
      className="new-document-dialog"
    >
      <form onSubmit={(event) => void create(event)}>
        <div className="new-document-body">
          <div
            className="new-document-kind-grid"
            role="radiogroup"
            aria-label="Document type"
          >
            {newDocumentDefinitions.map((entry) => {
              const KindIcon = entry.icon;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === entry.kind}
                  className={`new-document-kind ${kind === entry.kind ? "is-selected" : ""}`}
                  key={entry.kind}
                  onClick={() => chooseKind(entry.kind)}
                >
                  <span className={`new-doc-icon ${entry.tone}`}>
                    <KindIcon size={20} />
                  </span>
                  <span>
                    <strong>{entry.label}</strong>
                    <small>{entry.description}</small>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="new-document-configuration">
            <div className="configuration-heading">
              <span>
                <strong>Configure {definition.label}</strong>
                <small>All dimensions use integer coordinates.</small>
              </span>
              <span className={`configuration-mode ${definition.tone}`}>
                {kind === "illustration"
                  ? "Canvas"
                  : kind === "tilemap"
                    ? "Map"
                    : "Pixel Art"}
              </span>
            </div>
            <label className="dialog-field">
              <span>Document name</span>
              <input
                autoFocus
                aria-label="Document name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  kind === "illustration"
                    ? "Untitled illustration"
                    : kind === "project"
                      ? "Untitled pixel project"
                      : `Untitled pixel ${kind}`
                }
              />
            </label>
            <div className="dialog-size-row">
              <label className="dialog-field">
                <span>
                  {kind === "tilemap"
                    ? "Map width"
                    : kind === "project"
                      ? "Starting sprite width"
                      : "Width"}
                </span>
                <div className="unit-input">
                  <input
                    aria-label="Document width"
                    type="number"
                    min="1"
                    max="8192"
                    value={width}
                    onChange={(event) => setWidth(event.target.value)}
                    onBlur={() =>
                      setWidth(String(pixelDimension(width, definition.width)))
                    }
                  />
                  <em>{kind === "tilemap" ? "tiles" : "px"}</em>
                </div>
              </label>
              <span className="dimension-cross">×</span>
              <label className="dialog-field">
                <span>
                  {kind === "tilemap"
                    ? "Map height"
                    : kind === "project"
                      ? "Starting sprite height"
                      : "Height"}
                </span>
                <div className="unit-input">
                  <input
                    aria-label="Document height"
                    type="number"
                    min="1"
                    max="8192"
                    value={height}
                    onChange={(event) => setHeight(event.target.value)}
                    onBlur={() =>
                      setHeight(
                        String(pixelDimension(height, definition.height)),
                      )
                    }
                  />
                  <em>{kind === "tilemap" ? "tiles" : "px"}</em>
                </div>
              </label>
            </div>
            <div className="document-presets" aria-label="Size presets">
              {documentPresets[kind].map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  className={
                    pixelDimension(width) === preset.width &&
                    pixelDimension(height) === preset.height
                      ? "is-active"
                      : ""
                  }
                  onClick={() => {
                    setWidth(String(preset.width));
                    setHeight(String(preset.height));
                  }}
                >
                  {preset.label}
                  <small>
                    {preset.width} × {preset.height}
                  </small>
                </button>
              ))}
            </div>
            {customPresets.some((preset) => preset.kind === kind) && <div className="custom-document-presets" aria-label="Custom document presets">
              {customPresets.filter((preset) => preset.kind === kind).map((preset) => {
                const active = pixelDimension(width) === preset.options.width && pixelDimension(height) === preset.options.height;
                return <div className={`custom-document-preset ${active ? "is-active" : ""}`} key={preset.id}>
                  <button type="button" onClick={() => applyPreset(preset)}><strong>{preset.name}</strong><small>{preset.options.width} × {preset.options.height}</small></button>
                  <button type="button" className="delete-custom-preset" aria-label={`Delete ${preset.name} preset`} title="Delete preset" onClick={() => void window.aidraw.deleteDocumentPreset(preset.id).then(({ deleted }) => { if (deleted) setCustomPresets((current) => current.filter((entry) => entry.id !== preset.id)); })}><X size={13} /></button>
                </div>;
              })}
            </div>}
            <div className="save-document-preset">
              <label className="dialog-field"><span>Reusable preset name</span><input value={presetName} maxLength={80} placeholder={`${pixelDimension(width, definition.width)} × ${pixelDimension(height, definition.height)}`} onChange={(event) => setPresetName(event.target.value)} /></label>
              <button type="button" disabled={savingPreset || !presetName.trim()} onClick={() => void savePreset()}>{savingPreset ? "Saving…" : "Save current"}</button>
            </div>

            {kind === "illustration" && (
              <div className="configuration-section">
                <span className="configuration-label">Background</span>
                <div className="background-options">
                  <button
                    type="button"
                    className={
                      backgroundMode === "transparent" ? "is-active" : ""
                    }
                    onClick={() => setBackgroundMode("transparent")}
                  >
                    <span className="transparent-preview" />
                    Transparent
                  </button>
                  <button
                    type="button"
                    className={backgroundMode === "solid" ? "is-active" : ""}
                    onClick={() => setBackgroundMode("solid")}
                  >
                    <span
                      className="solid-preview"
                      style={{ backgroundColor }}
                    />
                    Solid color
                  </button>
                  {backgroundMode === "solid" && (
                    <input
                      aria-label="Artboard background color"
                      type="color"
                      value={backgroundColor}
                      onChange={(event) =>
                        setBackgroundColor(event.target.value)
                      }
                    />
                  )}
                </div>
              </div>
            )}

            {kind === "tilemap" && (
              <div className="configuration-section tilemap-options">
                <label className="dialog-field">
                  <span>Grid orientation</span>
                  <select
                    aria-label="Tilemap orientation"
                    value={orientation}
                    onChange={(event) =>
                      setOrientation(
                        event.target.value as "orthogonal" | "isometric",
                      )
                    }
                  >
                    <option value="orthogonal">Orthogonal</option>
                    <option value="isometric">Isometric</option>
                  </select>
                </label>
                <label className="dialog-field">
                  <span>Tile width</span>
                  <div className="unit-input">
                    <input
                      aria-label="Tile width"
                      type="number"
                      min="1"
                      max="1024"
                      value={tileWidth}
                      onChange={(event) => setTileWidth(event.target.value)}
                    />
                    <em>px</em>
                  </div>
                </label>
                <label className="dialog-field">
                  <span>Tile height</span>
                  <div className="unit-input">
                    <input
                      aria-label="Tile height"
                      type="number"
                      min="1"
                      max="1024"
                      value={tileHeight}
                      onChange={(event) => setTileHeight(event.target.value)}
                    />
                    <em>px</em>
                  </div>
                </label>
                <label className="infinite-toggle">
                  <input
                    type="checkbox"
                    checked={infinite}
                    onChange={(event) => setInfinite(event.target.checked)}
                  />
                  <span>
                    <strong>Sparse infinite map</strong>
                    <small>
                      Store painted regions in 32 × 32 chunks beyond the initial
                      area.
                    </small>
                  </span>
                </label>
              </div>
            )}
          </div>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="secondary-modal-button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary-modal-button"
            disabled={creating}
          >
            <FilePlus2 size={16} />
            {creating ? "Creating…" : `Create ${definition.label}`}
          </button>
        </footer>
      </form>
    </ModalShell>
  );
}

function BatchResultDialog({ title, result, onClose }: { title: string; result: BatchDocumentResult; onClose: () => void }) {
  const failed = result.items.filter((item) => item.status === "failed").length;
  return <EditorDialog title={title} description={`${result.items.length} document${result.items.length === 1 ? "" : "s"} processed${failed ? ` · ${failed} failed` : ""}.`} className="batch-result-dialog" onClose={onClose}><div className="batch-result-list">{result.items.map((item) => <div className={`batch-result-row is-${item.status}`} key={item.documentId}><span><strong>{item.name}</strong><small>{item.filePath ?? item.error ?? item.warnings?.join(" ") ?? item.status}</small></span><em>{item.status}</em></div>)}</div><footer className="modal-footer"><button type="button" className="primary-modal-button" onClick={onClose}>Done</button></footer></EditorDialog>;
}

function BatchExportDialog({ documentCount, onClose }: { documentCount: number; onClose: () => void }) {
  const [format, setFormat] = useState<"png" | "jpeg" | "webp" | "gif" | "apng" | "sprite-sheet">("png");
  const [scale, setScale] = useState(1);
  const [animationTagName, setAnimationTagName] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BatchDocumentResult>();
  const run = async () => { setRunning(true); try { const next = await window.aidraw.batchExportDocuments(format, { scale, animationTagName: ["gif", "apng", "sprite-sheet"].includes(format) && animationTagName.trim() ? animationTagName.trim() : undefined }); if (!next.cancelled) setResult(next); } finally { setRunning(false); } };
  if (result) return <BatchResultDialog title="Batch export complete" result={result} onClose={onClose} />;
  return <EditorDialog title="Batch export" description={`Export all ${documentCount} open documents into one folder with collision-safe filenames.`} className="batch-export-dialog" onClose={onClose}><div className="entry-dialog-body"><label className="dialog-field"><span>Format</span><select autoFocus value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="png">PNG · all documents</option><option value="jpeg">JPEG · all documents</option><option value="webp">WebP · all documents</option><option value="gif">GIF · sprites and keyframed illustrations</option><option value="apng">APNG · sprites and keyframed illustrations</option><option value="sprite-sheet">Sprite sheet + JSON · pixel sprites only</option></select></label><label className="dialog-field"><span>Pixel presentation scale</span><select value={scale} onChange={(event) => setScale(Number(event.target.value))}><option value={1}>1× native</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8× presentation</option><option value={12}>12× presentation</option><option value={16}>16×</option></select></label>{["gif", "apng", "sprite-sheet"].includes(format) && <label className="dialog-field"><span>Shared pixel-animation tag (optional)</span><input maxLength={120} value={animationTagName} onChange={(event) => setAnimationTagName(event.target.value)} placeholder="e.g. Walk" /><small>Each pixel sprite resolves this exact tag independently. Leave blank to also export complete illustration timelines.</small></label>}<p className="batch-export-note">Illustrations remain at native size. Unsupported documents are reported as skipped rather than silently converted.</p></div><footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button><button type="button" className="primary-modal-button" disabled={running || documentCount === 0} onClick={() => void run()}><Download size={15} />{running ? "Exporting…" : "Choose folder and export"}</button></footer></EditorDialog>;
}

function DocumentActivityBadge({ document }: { document: DocumentTab }) {
  if (!document.activityState || !document.activityActor) return null;
  const active = document.activityState === "active";
  const cursor = document.activityCursor;
  const cursorLabel = cursor
    ? ` · ${cursor.tool ?? "cursor"} at ${Math.round(cursor.x)}, ${Math.round(cursor.y)}`
    : "";
  const label = active
    ? `${document.activityActor.name} is working in ${document.name}${cursorLabel}`
    : document.activityState === "complete"
      ? `${document.activityActor.name} finished work in ${document.name}`
      : `${document.activityActor.name} needs attention in ${document.name}`;
  return (
    <span
      className={`tab-activity-badge is-${document.activityState}`}
      data-activity-state={document.activityState}
      data-actor-id={document.activityActor.id}
      data-cursor-x={cursor?.x}
      data-cursor-y={cursor?.y}
      data-cursor-tool={cursor?.tool}
      role="status"
      aria-label={label}
      title={label}
      style={{ "--actor": document.activityActor.color } as React.CSSProperties}
    >
      <MousePointer2 size={10} strokeWidth={2.5} />
    </span>
  );
}

function DocumentTabs() {
  const snapshot = useEditorStore((state) => state.snapshot);
  const activate = useEditorStore((state) => state.activate);
  const [creating, setCreating] = useState<NewDocumentKind>();
  const [showAll, setShowAll] = useState(false);
  const [batchExporting, setBatchExporting] = useState(false);
  const [batchReport, setBatchReport] = useState<{ title: string; result: BatchDocumentResult }>();
  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const [allTabsFocusIndex, setAllTabsFocusIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const allTabsRef = useRef<HTMLDivElement>(null);
  const allTabsButtonRef = useRef<HTMLButtonElement>(null);
  const allTabsMenuRef = useRef<HTMLDivElement>(null);
  const focusAfterCloseRef = useRef(false);
  const allTabsMenuId = useId();
  const documents = snapshot?.documents ?? [];
  const resolvedAllTabsFocusIndex = Math.min(
    allTabsFocusIndex,
    Math.max(0, documents.length + 2),
  );

  useEffect(
    () =>
      window.aidraw.onNewDocumentRequested((kind) => {
        setShowAll(false);
        setCreating(kind ?? "illustration");
      }),
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "n")
        return;
      if (globalThis.document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setShowAll(false);
      setCreating(event.shiftKey ? "sprite" : "illustration");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const next = {
        left: viewport.scrollLeft > 1,
        right:
          viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
      };
      setScrollState((current) =>
        current.left === next.left && current.right === next.right
          ? current
          : next,
      );
    };
    const frame = window.requestAnimationFrame(() => {
      const active = viewport.querySelector<HTMLElement>(
        ".document-tab.is-active",
      );
      if (active) {
        const activeBounds = active.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        if (activeBounds.left < viewportBounds.left)
          viewport.scrollTo({
            left: Math.max(
              0,
              viewport.scrollLeft -
                (viewportBounds.left - activeBounds.left) -
                8,
            ),
            behavior: "smooth",
          });
        else if (activeBounds.right > viewportBounds.right)
          viewport.scrollTo({
            left:
              viewport.scrollLeft +
              activeBounds.right -
              viewportBounds.right +
              8,
            behavior: "smooth",
          });
      }
      update();
    });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", update);
    };
  }, [documents.length, snapshot?.activeDocumentId]);

  useEffect(() => {
    if (!focusAfterCloseRef.current) return;
    focusAfterCloseRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      viewportRef.current
        ?.querySelector<HTMLButtonElement>('.document-tab[tabindex="0"]')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [documents.length, snapshot?.activeDocumentId]);

  useEffect(() => {
    if (!showAll) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const items = allTabsMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      );
      items?.[resolvedAllTabsFocusIndex]?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!allTabsRef.current?.contains(event.target as Node))
        setShowAll(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setShowAll(false);
      allTabsButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [resolvedAllTabsFocusIndex, showAll]);

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(220, viewport.clientWidth * 0.72),
      behavior: "smooth",
    });
  };

  const closeDocumentTab = async (documentId: string, restoreFocus: boolean) => {
    if (restoreFocus) focusAfterCloseRef.current = true;
    const result = await window.aidraw.closeDocument(documentId);
    if (!result.closed && restoreFocus) focusAfterCloseRef.current = false;
  };

  const closeAllTabs = (restoreFocus: boolean) => {
    if (restoreFocus) allTabsButtonRef.current?.focus();
    setShowAll(false);
  };

  const toggleAllTabs = () => {
    if (showAll) {
      setShowAll(false);
      return;
    }
    setAllTabsFocusIndex(
      Math.max(
        0,
        documents.findIndex(
          (document) => document.id === snapshot?.activeDocumentId,
        ),
      ),
    );
    setShowAll(true);
  };

  const handleAllTabsMenuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const items = allTabsMenuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    if (!items?.length) return;
    const currentIndex = [...items].findIndex((item) => item === event.target);
    const nextIndex = menuFocusIndex(event.key, currentIndex, items.length);
    if (nextIndex === undefined) return;
    event.preventDefault();
    setAllTabsFocusIndex(nextIndex);
    items[nextIndex].focus();
  };

  return (
    <div className="document-tabs">
      <button
        className="tab-scroll-control"
        aria-label="Scroll document tabs left"
        title="Earlier documents"
        disabled={!scrollState.left}
        onClick={() => scrollTabs(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <div
        className="document-tab-viewport"
        ref={viewportRef}
        role="tablist"
        aria-label="Open documents"
      >
        {documents.map((document, index) => {
          const active = document.id === snapshot?.activeDocumentId;
          return (
            <div
              key={document.id}
              className={`document-tab-shell ${active ? "is-active" : ""}`}
              role="presentation"
            >
              <button
                type="button"
                className={`document-tab ${active ? "is-active" : ""}`}
                onClick={() => void activate(document.id)}
                onKeyDown={(event) => {
                  if (
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey
                  )
                    return;
                  const nextIndex = documentTabFocusIndex(
                    event.key,
                    index,
                    documents.length,
                  );
                  if (nextIndex === undefined) return;
                  event.preventDefault();
                  const nextTab = viewportRef.current?.querySelectorAll<HTMLButtonElement>(
                    ".document-tab",
                  )[nextIndex];
                  nextTab?.focus();
                  void activate(documents[nextIndex].id);
                }}
                role="tab"
                title={document.name}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
              >
                <span className={`mode-dot ${document.kind}`} />
                <span className="document-tab-name">{document.name}</span>
                {document.dirty && (
                  <span className="dirty-dot" aria-label="Unsaved changes" />
                )}
                <DocumentActivityBadge document={document} />
              </button>
              <button
                type="button"
                tabIndex={active ? 0 : -1}
                className="tab-close"
                aria-label={`Close ${document.name}`}
                onClick={() => void closeDocumentTab(document.id, active)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="tab-scroll-control"
        aria-label="Scroll document tabs right"
        title="Later documents"
        disabled={!scrollState.right}
        onClick={() => scrollTabs(1)}
      >
        <ChevronRight size={15} />
      </button>
      <div className="all-tabs-wrap" ref={allTabsRef}>
        <button
          ref={allTabsButtonRef}
          className={`all-tabs-button ${showAll ? "is-active" : ""}`}
          aria-label="All open documents"
          aria-haspopup="menu"
          aria-expanded={showAll}
          aria-controls={allTabsMenuId}
          title={`${documents.length} open documents`}
          onClick={toggleAllTabs}
        >
          <span>{documents.length}</span>
          <ChevronDown size={13} />
        </button>
        {showAll && (
          <div
            id={allTabsMenuId}
            ref={allTabsMenuRef}
            className="all-tabs-menu popover"
            role="menu"
            aria-label="All open documents"
            onKeyDown={handleAllTabsMenuKeys}
          >
            <div className="popover-title">
              {documents.length} open documents
            </div>
            <div className="all-tabs-list">
              {documents.map((document, index) => (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={resolvedAllTabsFocusIndex === index ? 0 : -1}
                  className={
                    document.id === snapshot?.activeDocumentId
                      ? "is-active"
                      : ""
                  }
                  key={document.id}
                  title={document.name}
                  onClick={() => {
                    closeAllTabs(true);
                    void activate(document.id);
                  }}
                >
                  <span className={`mode-dot ${document.kind}`} />
                  <span>{document.name}</span>
                  {document.dirty && (
                    <span className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                  <DocumentActivityBadge document={document} />
                </button>
              ))}
            </div>
            <div className="all-tabs-batch-actions" role="group" aria-label="All-document actions"><button type="button" role="menuitem" tabIndex={resolvedAllTabsFocusIndex === documents.length ? 0 : -1} onClick={async () => { closeAllTabs(true); const result = await window.aidraw.saveAllDocuments(); if (!result.cancelled) setBatchReport({ title: "Save All complete", result }); }}><Save size={13} /> Save all</button><button type="button" role="menuitem" tabIndex={resolvedAllTabsFocusIndex === documents.length + 1 ? 0 : -1} onClick={() => { closeAllTabs(true); setBatchExporting(true); }}><Download size={13} /> Batch export</button><button type="button" role="menuitem" tabIndex={resolvedAllTabsFocusIndex === documents.length + 2 ? 0 : -1} className="is-danger" onClick={async () => { closeAllTabs(true); const result = await window.aidraw.closeAllDocuments(); if (!result.cancelled) setBatchReport({ title: "Close All complete", result }); }}><X size={13} /> Close all</button></div>
          </div>
        )}
      </div>
      <div className="new-document-wrap">
        <button
          className="icon-button new-tab"
          title="New document"
          onClick={() => setCreating("illustration")}
        >
          <FilePlus2 size={17} />
        </button>
        {creating && (
          <NewDocumentDialog
            initialKind={creating}
            onClose={() => setCreating(undefined)}
          />
        )}
        {batchExporting && <BatchExportDialog documentCount={documents.length} onClose={() => setBatchExporting(false)} />}
        {batchReport && <BatchResultDialog title={batchReport.title} result={batchReport.result} onClose={() => setBatchReport(undefined)} />}
      </div>
    </div>
  );
}

function SpriteSheetImportDialog({ selection, onClose }: { selection: SpriteSheetSelection; onClose: () => void }) {
  const notify = useEditorStore((state) => state.notify);
  const [options, setOptions] = useState<SpriteSheetSliceOptions>({ frameWidth: selection.suggestedFrameWidth, frameHeight: selection.suggestedFrameHeight, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0, order: "rows", durationMs: 100, trimTransparent: false, skipEmpty: false });
  const [busy, setBusy] = useState(false); const [submitError, setSubmitError] = useState<string>();
  const layoutState = useMemo(() => { try { return { layout: calculateSpriteSheetLayout(selection.width, selection.height, options) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } }, [options, selection.height, selection.width]);
  const setNumber = (key: keyof SpriteSheetSliceOptions, value: string) => setOptions((current) => ({ ...current, [key]: value === "" && key === "frameCount" ? undefined : Number(value) }));
  const submit = async () => {
    if (!layoutState.layout || busy) return; setBusy(true); setSubmitError(undefined);
    try {
      const result = await window.aidraw.importSpriteSheet(selection.id, options);
      if (result.imported) { notify(`Imported ${layoutState.layout.frames.length} sprite-sheet cell${layoutState.layout.frames.length === 1 ? "" : "s"}. ${result.warnings.join(" ")}`, result.warnings.length ? "warning" : "success"); onClose(); }
    } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <ModalShell title={`Slice sprite sheet · ${selection.name}`} description={`${selection.width} × ${selection.height}px · selection expires at ${new Date(selection.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`} onClose={onClose} className="sprite-sheet-dialog">
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="sprite-sheet-dialog-body">
        <div className="sprite-sheet-preview"><svg viewBox={`0 0 ${selection.width} ${selection.height}`} preserveAspectRatio="xMidYMid meet" aria-label="Sprite-sheet slice preview"><image href={selection.previewDataUrl} x="0" y="0" width={selection.width} height={selection.height} />{layoutState.layout?.frames.slice(0, 512).map((frame) => <rect key={frame.index} x={frame.x} y={frame.y} width={frame.width} height={frame.height} />)}</svg><small>{layoutState.layout ? `${layoutState.layout.frames.length} of ${layoutState.layout.availableFrames} cells · ${layoutState.layout.columns} columns × ${layoutState.layout.rows} rows` : layoutState.error}</small></div>
        <div className="sprite-sheet-fields">
          <label className="dialog-field"><span>Frame width</span><div className="unit-input"><input autoFocus type="number" min="1" max="8192" value={options.frameWidth} onChange={(event) => setNumber("frameWidth", event.target.value)} /><em>px</em></div></label>
          <label className="dialog-field"><span>Frame height</span><div className="unit-input"><input type="number" min="1" max="8192" value={options.frameHeight} onChange={(event) => setNumber("frameHeight", event.target.value)} /><em>px</em></div></label>
          <label className="dialog-field"><span>Margin X</span><input type="number" min="0" max="8191" value={options.marginX} onChange={(event) => setNumber("marginX", event.target.value)} /></label>
          <label className="dialog-field"><span>Margin Y</span><input type="number" min="0" max="8191" value={options.marginY} onChange={(event) => setNumber("marginY", event.target.value)} /></label>
          <label className="dialog-field"><span>Spacing X</span><input type="number" min="0" max="8191" value={options.spacingX} onChange={(event) => setNumber("spacingX", event.target.value)} /></label>
          <label className="dialog-field"><span>Spacing Y</span><input type="number" min="0" max="8191" value={options.spacingY} onChange={(event) => setNumber("spacingY", event.target.value)} /></label>
          <label className="dialog-field"><span>Frame count</span><input type="number" min="1" max="4096" placeholder="All cells" value={options.frameCount ?? ""} onChange={(event) => setNumber("frameCount", event.target.value)} /></label>
          <label className="dialog-field"><span>Read order</span><select value={options.order} onChange={(event) => setOptions({ ...options, order: event.target.value as SpriteSheetSliceOptions["order"] })}><option value="rows">Rows first</option><option value="columns">Columns first</option></select></label>
          <label className="dialog-field"><span>Frame duration</span><div className="unit-input"><input type="number" min="1" max="60000" value={options.durationMs} onChange={(event) => setNumber("durationMs", event.target.value)} /><em>ms</em></div></label>
          <div className="sprite-sheet-toggles"><label><input type="checkbox" checked={options.trimTransparent} onChange={(event) => setOptions({ ...options, trimTransparent: event.target.checked })} /><span><strong>Trim shared transparent border</strong><small>Keeps every frame aligned to one common crop.</small></span></label><label><input type="checkbox" checked={options.skipEmpty} onChange={(event) => setOptions({ ...options, skipEmpty: event.target.checked })} /><span><strong>Skip empty cells</strong><small>Fully transparent cells do not become frames.</small></span></label></div>
        </div>
        {(submitError || layoutState.error) && <p className="entry-dialog-error" role="alert">{submitError ?? layoutState.error}</p>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-modal-button" disabled={busy || !layoutState.layout}>{busy ? "Importing…" : "Create animated sprite"}</button></footer>
    </form>
  </ModalShell>;
}

function TopBar({
  inspectorCollapsed,
  onOpenShortcuts,
  onOpenAgentActivity,
  onToggleInspector,
}: {
  inspectorCollapsed: boolean;
  onOpenShortcuts: () => void;
  onOpenAgentActivity: () => void;
  onToggleInspector: () => void;
}) {
  const open = useEditorStore((state) => state.open);
  const save = useEditorStore((state) => state.save);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.snapshot?.canUndo);
  const canRedo = useEditorStore((state) => state.snapshot?.canRedo);
  const snapshot = useEditorStore((state) => state.snapshot);
  const canvasAnimation = useEditorStore((state) => state.canvasAnimation);
  const notify = useEditorStore((state) => state.notify);
  const shortcutPreferences = useEditorStore((state) => state.shortcutPreferences);
  const inspectorShortcut = shortcutChordForAction(shortcutPreferences, "toggle-inspector");
  const [exporting, setExporting] = useState(false);
  const [exportScale, setExportScale] = useState(1);
  const [exportTagId, setExportTagId] = useState("");
  const [exportPaletteCycleId, setExportPaletteCycleId] = useState("");
  const [spriteSheetSelection, setSpriteSheetSelection] = useState<SpriteSheetSelection>();
  const exportWrapRef = useRef<HTMLDivElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuId = useId();
  const document = snapshot?.activeDocument;
  const exportSprite = document?.kind === "pixel" && document.pixelAssets[document.activeAssetId]?.type === "sprite" ? document.pixelAssets[document.activeAssetId] as PixelSprite : undefined;
  const selectedExportCycle = document?.kind === "pixel" ? document.paletteCycles.find((cycle) => cycle.id === exportPaletteCycleId) : undefined;
  const exportFrameId = exportSprite && canvasAnimation?.activeAssetId === exportSprite.id && canvasAnimation.activeFrameId && exportSprite.frames[canvasAnimation.activeFrameId]
    ? canvasAnimation.activeFrameId
    : exportSprite?.frameIds[0];
  const exportChoices =
    document?.kind === "pixel"
      ? [
          "png",
          "jpeg",
          "webp",
          "svg",
          "pdf",
          "psd",
          ...(document.pixelAssets[document.activeAssetId]?.type === "sprite"
            ? ["gif", "apng", "sprite-sheet"]
            : []),
          ...(["tilemap", "tileset"].includes(
            document.pixelAssets[document.activeAssetId]?.type ?? "",
          )
            ? ["tiled-json", "tiled-xml"]
            : []),
        ]
      : ["png", "jpeg", "webp", "svg", "pdf", "psd", ...(document?.animation.keyframeIds.length ? ["gif", "apng"] : [])];

  useEffect(() => {
    if (!exporting) return;
    const focusFrame = window.requestAnimationFrame(() => {
      exportMenuRef.current
        ?.querySelector<HTMLElement>('select, button:not(:disabled)')
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!exportWrapRef.current?.contains(event.target as Node))
        setExporting(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setExporting(false);
      exportButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [exporting]);

  return (
    <header className="topbar">
      <div className="brand" aria-label="AIDraw">
        <span className="brand-mark">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-name">AIDraw</span>
      </div>
      <div className="file-actions">
        <button
          className="icon-button"
          title="Open (Ctrl+O)"
          aria-label="Open document"
          aria-keyshortcuts="Control+O"
          onClick={() => void open()}
        >
          <FolderOpen size={17} />
        </button>
        <button
          className="icon-button"
          title="Import artwork"
          aria-label="Import artwork"
          onClick={async () => {
            const result = await window.aidraw.importFiles(
              document?.kind === "pixel",
            );
            if (result.warnings.length)
              notify(result.warnings.join(" "), "warning");
            else if (result.imported)
              notify(
                `Imported ${result.imported} document${result.imported === 1 ? "" : "s"}.`,
                "success",
              );
          }}
        >
          <Upload size={16} />
        </button>
        <button className="icon-button" title="Slice a sprite-sheet image" aria-label="Slice a sprite-sheet image" onClick={async () => { try { const result = await window.aidraw.selectSpriteSheet(); if (result.selection) setSpriteSheetSelection(result.selection); } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); } }}><Grid3X3 size={16} /></button>
        <button
          className="icon-button"
          title="Save (Ctrl+S)"
          aria-label="Save document"
          aria-keyshortcuts="Control+S"
          onClick={() => void save()}
        >
          <Save size={17} />
        </button>
        <div className="export-menu-wrap" ref={exportWrapRef}>
          <button
            ref={exportButtonRef}
            className="icon-button"
            title="Export"
            aria-label="Export document"
            aria-haspopup="dialog"
            aria-expanded={exporting}
            aria-controls={exportMenuId}
            onClick={() => setExporting((value) => !value)}
          >
            <Download size={16} />
          </button>
          {exporting && (
            <div
              id={exportMenuId}
              ref={exportMenuRef}
              className="export-menu popover"
              role="dialog"
              aria-label="Export active document"
            >
              <div className="popover-title">Export active document</div>
              {document?.kind === "pixel" && (
                <label className="export-scale-control">
                  <span>
                    <strong>Pixel scale</strong>
                    <small>Nearest-neighbor</small>
                  </span>
                  <select
                    aria-label="Pixel export scale"
                    value={exportScale}
                    onChange={(event) =>
                      setExportScale(Number(event.target.value))
                    }
                  >
                    <option value={1}>1× Native</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                    <option value={8}>8× Presentation</option>
                    <option value={12}>12× Presentation</option>
                    <option value={16}>16×</option>
                  </select>
                </label>
              )}
              {exportSprite && exportSprite.tags.length > 0 && <label className="export-scale-control"><span><strong>Animation range</strong><small>GIF, APNG, sheet</small></span><select aria-label="Animation export range" disabled={Boolean(selectedExportCycle)} value={exportSprite.tags.some((tag) => tag.id === exportTagId) ? exportTagId : ""} onChange={(event) => { setExportTagId(event.target.value); setExportPaletteCycleId(""); }}><option value="">Full timeline</option>{exportSprite.tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name} · {tag.direction}</option>)}</select></label>}
              {exportSprite && document?.kind === "pixel" && document.paletteCycles.length > 0 && <label className="export-scale-control"><span><strong>Palette-cycle output</strong><small>{selectedExportCycle && selectedExportCycle.stepMs % 10 !== 0 ? "APNG exact · GIF needs 10 ms steps" : "GIF/APNG · active frame"}</small></span><select aria-label="Palette-cycle export" value={selectedExportCycle?.id ?? ""} onChange={(event) => { setExportPaletteCycleId(event.target.value); if (event.target.value) setExportTagId(""); }}><option value="">Timeline or tag animation</option>{document.paletteCycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name} · {cycle.toIndex - cycle.fromIndex + 1} steps · {cycle.stepMs} ms</option>)}</select></label>}
              {exportChoices.map((format) => {
                const scalable =
                  document?.kind === "pixel" &&
                  !["psd", "tiled-json", "tiled-xml"].includes(format);
                const scale = scalable ? exportScale : 1;
                return (
                  <button
                    key={format}
                    disabled={format === "gif" && Boolean(selectedExportCycle && selectedExportCycle.stepMs % 10 !== 0)}
                    onClick={async () => {
                      setExporting(false);
                      exportButtonRef.current?.focus();
                      const result = await window.aidraw.exportActiveDocument(
                        format as Parameters<
                          typeof window.aidraw.exportActiveDocument
                        >[0],
                        {
                          scale,
                          animationTagId: ["gif", "apng", "sprite-sheet"].includes(format) && !selectedExportCycle && exportTagId ? exportTagId : undefined,
                          paletteCycleId: ["gif", "apng"].includes(format) ? selectedExportCycle?.id : undefined,
                          paletteCycleFrameId: ["gif", "apng"].includes(format) && selectedExportCycle ? exportFrameId : undefined,
                        },
                      );
                      if (result.exported)
                        notify(
                          `Exported ${result.filePath}`,
                          result.warnings.length ? "warning" : "success",
                        );
                      else if (result.warnings.length)
                        notify(result.warnings.join(" "), "warning");
                    }}
                  >
                    <span>{format.replace("-", " ").toUpperCase()}</span>
                    {selectedExportCycle && ["gif", "apng"].includes(format) ? <small>{selectedExportCycle.name}</small> : scale > 1 && <small>{scale}×</small>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <span className="toolbar-separator" />
        <button
          className="icon-button"
          disabled={!canUndo}
          title="Undo my action (Ctrl+Z)"
          aria-label="Undo my action"
          aria-keyshortcuts="Control+Z"
          onClick={() => void undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          className="icon-button"
          disabled={!canRedo}
          title="Redo my action (Ctrl+Y)"
          aria-label="Redo my action"
          aria-keyshortcuts="Control+Y"
          onClick={() => void redo()}
        >
          <Redo2 size={17} />
        </button>
      </div>
      {spriteSheetSelection && <SpriteSheetImportDialog selection={spriteSheetSelection} onClose={() => setSpriteSheetSelection(undefined)} />}
      <DocumentTabs />
      <div className="topbar-right">
        <button
          id="inspector-toggle-button"
          type="button"
          className="icon-button"
          title={`${inspectorCollapsed ? "Open" : "Collapse"} inspector (${shortcutChordLabel(inspectorShortcut)})`}
          aria-label={`${inspectorCollapsed ? "Open" : "Collapse"} inspector sidebar`}
          aria-keyshortcuts={shortcutAriaKeyShortcuts(inspectorShortcut)}
          aria-controls="inspector-sidebar"
          aria-expanded={!inspectorCollapsed}
          onClick={onToggleInspector}
        >
          {inspectorCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
        <button
          type="button"
          className="icon-button"
          title="Keyboard shortcuts (F1 or ?)"
          aria-label="Keyboard shortcuts"
          aria-keyshortcuts="F1 ?"
          onClick={onOpenShortcuts}
        >
          <Keyboard size={16} />
        </button>
        <button
          className="agent-pill"
          aria-label="Open agent activity"
          title="Open agent activity"
          onClick={onOpenAgentActivity}
        >
          <Bot size={15} />
          <span>
            {useEditorStore.getState().snapshot?.mcp.sessions.length ?? 0}{" "}
            agents
          </span>
        </button>
      </div>
    </header>
  );
}

function ToolRail({ document }: { document: AIDrawDocument }) {
  const selectedTool = useEditorStore((state) => state.selectedTool);
  const setTool = useEditorStore((state) => state.setTool);
  const shortcutPreferences = useEditorStore((state) => state.shortcutPreferences);
  const mode = document.kind;
  const tools = document.kind === "pixel" ? pixelTools : illustrationTools;
  const [focusedToolId, setFocusedToolId] = useState<EditorTool>(selectedTool);
  const rovingToolId = tools.some((tool) => tool.id === focusedToolId)
    ? focusedToolId
    : tools.some((tool) => tool.id === selectedTool)
      ? selectedTool
      : tools[0].id;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        globalThis.document.querySelector('[aria-modal="true"]') ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        return;
      const action = shortcutActionForEvent(shortcutPreferences, event, mode, "tool");
      const match = tools.find((tool) => action?.kind === "tool" && tool.id === action.toolId);
      if (match) {
        setFocusedToolId(match.id);
        setTool(match.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, setTool, shortcutPreferences, tools]);

  const handleToolRailKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".tool-button")];
    const currentIndex = buttons.indexOf(event.target as HTMLButtonElement);
    const nextIndex = toolRailFocusIndex(event.key, currentIndex, buttons.length);
    if (nextIndex === undefined) return;
    event.preventDefault();
    setFocusedToolId(tools[nextIndex].id);
    buttons[nextIndex].focus();
  };

  return (
    <aside className="tool-rail" role="toolbar" aria-orientation="vertical" aria-label={`${document.kind} tools`} onKeyDown={handleToolRailKeys}>
      {tools.map((tool, index) => {
        const IconComponent = tool.icon;
        const shortcutActionId = shortcutActionIdForTool(mode, tool.id);
        const shortcutChord = shortcutActionId
          ? shortcutChordForAction(shortcutPreferences, shortcutActionId)
          : undefined;
        const divider =
          index === commonTools.length ||
          (document.kind === "illustration" && index === 8);
        return (
          <div key={tool.id} className={divider ? "tool-divider" : undefined}>
            <button
              className={`tool-button ${selectedTool === tool.id ? "is-active" : ""}`}
              onClick={() => setTool(tool.id)}
              title={`${tool.label}${shortcutChord ? ` (${shortcutChordLabel(shortcutChord)})` : ""}`}
              aria-label={tool.label}
              aria-keyshortcuts={shortcutChord ? shortcutAriaKeyShortcuts(shortcutChord) : undefined}
              aria-pressed={selectedTool === tool.id}
              tabIndex={rovingToolId === tool.id ? 0 : -1}
              onFocus={() => setFocusedToolId(tool.id)}
            >
              <IconComponent size={19} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
    </aside>
  );
}

function BrushPresetDialog({
  initial,
  canDelete,
  onSave,
  onDelete,
  onClose,
}: {
  initial: RasterBrushPreset;
  canDelete: boolean;
  onSave: (preset: RasterBrushPreset) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState(() => structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const numberField = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    min: number,
    max: number,
    step = 0.01,
  ) => (
    <label className="dialog-field">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
  const setDynamics = <K extends keyof RasterBrushPreset["dynamics"]>(key: K, value: RasterBrushPreset["dynamics"][K]) =>
    setPreset((current) => ({ ...current, dynamics: { ...current.dynamics, [key]: value } }));
  return (
    <EditorDialog title={canDelete ? "Edit custom brush" : "Create custom brush"} description="The complete dab recipe is stored with every stroke, so headless export and replay stay reproducible." className="brush-preset-dialog" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); setSaving(true); void onSave(preset).finally(() => setSaving(false)); }}>
        <div className="entry-dialog-body brush-preset-grid">
          <label className="dialog-field brush-name-field"><span>Name</span><input autoFocus maxLength={200} value={preset.name} onChange={(event) => setPreset((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="dialog-field"><span>Tip</span><select value={preset.dynamics.tip} onChange={(event) => setDynamics("tip", event.target.value as RasterBrushPreset["dynamics"]["tip"])}><option value="round">Round</option><option value="flat">Flat</option><option value="chalk">Chalk</option><option value="watercolor">Watercolor</option></select></label>
          {numberField("Default size", preset.size, (value) => setPreset((current) => ({ ...current, size: value })), 1, 500, 1)}
          {numberField("Opacity", preset.opacity, (value) => setPreset((current) => ({ ...current, opacity: value })), 0.01, 1)}
          {numberField("Flow", preset.flow, (value) => setPreset((current) => ({ ...current, flow: value })), 0.01, 1)}
          {numberField("Hardness", preset.hardness, (value) => setPreset((current) => ({ ...current, hardness: value })), 0, 1)}
          {numberField("Spacing × size", preset.dynamics.spacing, (value) => setDynamics("spacing", value), 0.01, 4)}
          {numberField("Stabilization", preset.dynamics.stabilization, (value) => setDynamics("stabilization", value), 0, 1)}
          {numberField("Scatter", preset.dynamics.scatter, (value) => setDynamics("scatter", value), 0, 2)}
          {numberField("Size jitter", preset.dynamics.sizeJitter, (value) => setDynamics("sizeJitter", value), 0, 1)}
          {numberField("Opacity jitter", preset.dynamics.opacityJitter, (value) => setDynamics("opacityJitter", value), 0, 1)}
          {numberField("Angle", preset.dynamics.angle, (value) => setDynamics("angle", value), -180, 180, 1)}
          {numberField("Roundness", preset.dynamics.roundness, (value) => setDynamics("roundness", value), 0.05, 1)}
          {numberField("Wetness", preset.dynamics.wetness, (value) => setDynamics("wetness", value), 0, 1)}
          {numberField("Granulation", preset.dynamics.granulation, (value) => setDynamics("granulation", value), 0, 1)}
        </div>
        <footer className="modal-footer brush-preset-footer">
          {canDelete && <button type="button" className="danger-button" onClick={() => void onDelete()}>Delete preset</button>}
          <span />
          <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-modal-button" disabled={saving || !preset.name.trim()}>{saving ? "Saving…" : "Save preset"}</button>
        </footer>
      </form>
    </EditorDialog>
  );
}

function ContextBar({ document }: { document: AIDrawDocument }) {
  const tool = useEditorStore((state) => state.selectedTool);
  const size = useEditorStore((state) => state.brushSize);
  const setSize = useEditorStore((state) => state.setBrushSize);
  const brushPreset = useEditorStore((state) => state.brushPreset);
  const setBrushPreset = useEditorStore((state) => state.setBrushPreset);
  const opacity = useEditorStore((state) => state.opacity);
  const setOpacity = useEditorStore((state) => state.setOpacity);
  const primary = useEditorStore((state) => state.primaryColor);
  const secondary = useEditorStore((state) => state.secondaryColor);
  const setColor = useEditorStore((state) => state.setColor);
  const setSecondary = useEditorStore((state) => state.setSecondaryColor);
  const orderedDitherPreferences = useEditorStore((state) => state.orderedDitherPreferences);
  const setOrderedDitherPreferences = useEditorStore((state) => state.setOrderedDitherPreferences);
  const { matrixSize: ditherMatrixSize, coverage: ditherCoverage, phaseX: ditherPhaseX, phaseY: ditherPhaseY } = orderedDitherPreferences.current;
  const [ditherPhaseDraftState, setDitherPhaseDraftState] = useState<Record<'phaseX' | 'phaseY', OrderedDitherPhaseDraft>>(() => ({
    phaseX: createOrderedDitherPhaseDraft(ditherPhaseX, ditherMatrixSize),
    phaseY: createOrderedDitherPhaseDraft(ditherPhaseY, ditherMatrixSize),
  }));
  const ditherPhaseDrafts = {
    phaseX: reconcileOrderedDitherPhaseDraft(ditherPhaseDraftState.phaseX, ditherPhaseX, ditherMatrixSize),
    phaseY: reconcileOrderedDitherPhaseDraft(ditherPhaseDraftState.phaseY, ditherPhaseY, ditherMatrixSize),
  };
  const ditherMixIndex = useEditorStore((state) => state.ditherMixIndex);
  const setDitherMixIndex = useEditorStore((state) => state.setDitherMixIndex);
  const currentPixelIndex = useEditorStore((state) => state.pixelIndex);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const [brushEditor, setBrushEditor] = useState<{ preset: RasterBrushPreset; existing: boolean }>();
  const [brushLibraryOpen, setBrushLibraryOpen] = useState(false);
  const [ditherPresetsOpen, setDitherPresetsOpen] = useState(false);
  const isBrush = [
    "pen",
    "pencil",
    "brush",
    "eraser",
    "line",
    "rectangle",
    "ellipse",
    "polygon",
    "star",
    "dither",
    "lighten",
    "darken",
  ].includes(tool);

  const customBrushes = document.kind === "illustration" ? document.brushPresets ?? [] : [];
  const activeCustomBrush = customBrushes.find((preset) => preset.id === brushPreset);
  const chooseBrush = (id: string) => {
    const preset = resolveRasterBrushPreset(id, customBrushes);
    setBrushPreset(id); setSize(preset.size); setOpacity(preset.opacity);
  };
  const openBrushEditor = () => {
    const source = resolveRasterBrushPreset(brushPreset, customBrushes);
    setBrushEditor(activeCustomBrush
      ? { preset: source, existing: true }
      : { preset: { ...source, id: createId("brush-preset"), name: `${source.name} custom` }, existing: false });
  };
  const updateDitherConfiguration = (update: Partial<OrderedDitherConfiguration>): boolean => {
    try {
      setOrderedDitherPreferences(withOrderedDitherConfiguration(orderedDitherPreferences, update));
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "The ordered dither setting is invalid.", "warning");
      return false;
    }
  };
  const setDitherPhaseDraft = (axis: 'phaseX' | 'phaseY', value: string) => {
    setDitherPhaseDraftState((current) => ({
      ...current,
      [axis]: withOrderedDitherPhaseDraftText(
        reconcileOrderedDitherPhaseDraft(
          current[axis],
          axis === 'phaseX' ? ditherPhaseX : ditherPhaseY,
          ditherMatrixSize,
        ),
        value,
      ),
    }));
  };
  const resetDitherPhaseDraft = (axis: 'phaseX' | 'phaseY') => {
    setDitherPhaseDraftState((current) => ({
      ...current,
      [axis]: createOrderedDitherPhaseDraft(
        axis === 'phaseX' ? ditherPhaseX : ditherPhaseY,
        ditherMatrixSize,
      ),
    }));
  };
  const commitDitherPhase = (axis: 'phaseX' | 'phaseY') => {
    try {
      const result = commitOrderedDitherPhaseDraft(orderedDitherPreferences, axis, ditherPhaseDrafts[axis]);
      setDitherPhaseDraftState((current) => ({ ...current, [axis]: result.draft }));
      if (result.status === 'invalid') {
        notify(result.message, 'warning');
      } else if (result.status === 'committed'
        && !orderedDitherConfigurationsEqual(result.preferences.current, orderedDitherPreferences.current)) {
        setOrderedDitherPreferences(result.preferences);
      }
    } catch (error) {
      resetDitherPhaseDraft(axis);
      notify(error instanceof Error ? error.message : 'The ordered dither phase is invalid.', 'warning');
    }
  };
  const saveDitherPreset = (name: string): boolean => {
    try {
      setOrderedDitherPreferences(withSavedOrderedDitherPreset(orderedDitherPreferences, { id: createId("dither-preset"), name }));
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "The ordered dither preset could not be saved.", "warning");
      return false;
    }
  };
  const applyDitherPreset = (presetId: string) => {
    try { setOrderedDitherPreferences(withAppliedOrderedDitherPreset(orderedDitherPreferences, presetId)); }
    catch (error) { notify(error instanceof Error ? error.message : "The ordered dither preset could not be applied.", "warning"); }
  };
  const deleteDitherPreset = (presetId: string) => {
    try { setOrderedDitherPreferences(withoutOrderedDitherPreset(orderedDitherPreferences, presetId)); }
    catch (error) { notify(error instanceof Error ? error.message : "The ordered dither preset could not be deleted.", "warning"); }
  };
  const activeDitherPreset = orderedDitherPreferences.activePresetId === null
    ? undefined
    : orderedDitherPreferences.presets.find((preset) => preset.id === orderedDitherPreferences.activePresetId);

  return (
    <>
    <div className="context-bar">
      <span className="context-tool-name">
        {(document.kind === "pixel" ? pixelTools : illustrationTools).find(
          (entry) => entry.id === tool,
        )?.label ?? tool}
      </span>
      {isBrush && (
        <>
          <label className="compact-field">
            <span>Size</span>
            <input
              type="number"
              min="1"
              max={document.kind === "pixel" ? 64 : 500}
              value={size}
              onChange={(event) => setSize(Number(event.target.value))}
            />
          </label>
          {document.kind === "illustration" &&
            (tool === "brush" || tool === "eraser") && (
              <label className="compact-field brush-preset">
                <span>Preset</span>
                <select
                  value={tool === "eraser" ? "eraser" : brushPreset}
                  disabled={tool === "eraser"}
                  onChange={(event) => chooseBrush(event.target.value)}
                >
                  <option value="hard-round">Hard round</option>
                  <option value="soft-round">Soft round</option>
                  <option value="pencil">Pencil</option>
                  <option value="marker">Marker</option>
                  <option value="airbrush">Airbrush</option>
                  <option value="watercolor">Watercolor wash</option>
                  <option value="eraser">Eraser</option>
                  {customBrushes.length > 0 && <optgroup label="Custom brushes">{customBrushes.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</optgroup>}
                </select>
              </label>
            )}
          {document.kind === "illustration" && tool === "brush" && <><button type="button" className="context-action-button" onClick={openBrushEditor}>{activeCustomBrush ? "Edit preset" : "Customize"}</button><button type="button" className="context-action-button" onClick={() => setBrushLibraryOpen(true)}>Brush library</button></>}
          {document.kind === "illustration" && (
            <label className="range-field">
              <span>Opacity</span>
              <input
                type="range"
                min="1"
                max="100"
                value={Math.round(opacity * 100)}
                onChange={(event) =>
                  setOpacity(Number(event.target.value) / 100)
                }
              />
              <output>{Math.round(opacity * 100)}%</output>
            </label>
          )}
          <div className="color-pair" title="Foreground and background colors">
            <input
              aria-label="Foreground color"
              type="color"
              value={primary.slice(0, 7)}
              onChange={(event) => setColor(event.target.value)}
            />
            <input
              aria-label="Background color"
              type="color"
              value={secondary.slice(0, 7)}
              onChange={(event) => setSecondary(event.target.value)}
            />
          </div>
          {document.kind === "pixel" && tool === "dither" && <>
            <label className="compact-field"><span>Matrix</span><select aria-label="Ordered dither matrix" value={ditherMatrixSize} onChange={(event) => updateDitherConfiguration({ matrixSize: Number(event.target.value) as 2 | 4 | 8 })}><option value={2}>2×2</option><option value={4}>4×4</option><option value={8}>8×8</option></select></label>
            <label className="range-field"><span>Mix</span><input aria-label="Ordered dither coverage" type="range" min="0" max="100" value={Math.round(ditherCoverage * 100)} onChange={(event) => updateDitherConfiguration({ coverage: Number(event.target.value) / 100 })} /><output>{Math.round(ditherCoverage * 100)}%</output></label>
            <OrderedDitherPhaseInput axis="X" draft={ditherPhaseDrafts.phaseX.text} onDraftChange={(value) => setDitherPhaseDraft('phaseX', value)} onCommit={() => commitDitherPhase('phaseX')} onCancel={() => resetDitherPhaseDraft('phaseX')} />
            <OrderedDitherPhaseInput axis="Y" draft={ditherPhaseDrafts.phaseY.text} onDraftChange={(value) => setDitherPhaseDraft('phaseY', value)} onCommit={() => commitDitherPhase('phaseY')} onCancel={() => resetDitherPhaseDraft('phaseY')} />
            <label className="compact-field"><span>Base</span><select value={Math.min(ditherMixIndex, document.palette.length - 1)} onChange={(event) => setDitherMixIndex(Number(event.target.value))}>{document.palette.map((entry, index) => <option key={entry.id} value={index}>{index}: {entry.name}</option>)}</select></label>
            <button type="button" className="context-action-button" aria-haspopup="dialog" aria-expanded={ditherPresetsOpen} onClick={() => setDitherPresetsOpen(true)}>Dither presets</button>
            <span className="mode-chip">{activeDitherPreset ? activeDitherPreset.name : "Custom"} · mixes into index {currentPixelIndex}</span>
          </>}
        </>
      )}
      {document.kind === "pixel" && (
        <span className="mode-chip">
          <Grid3X3 size={13} /> Pixel rules on
        </span>
      )}
    </div>
    {ditherPresetsOpen && document.kind === "pixel" && <DitherPresetDialog
      preferences={orderedDitherPreferences}
      onSave={saveDitherPreset}
      onApply={applyDitherPreset}
      onDelete={deleteDitherPreset}
      onClose={() => setDitherPresetsOpen(false)}
    />}
    {brushEditor && document.kind === "illustration" && <BrushPresetDialog
      key={brushEditor.preset.id}
      initial={brushEditor.preset}
      canDelete={brushEditor.existing}
      onClose={() => setBrushEditor(undefined)}
      onSave={async (preset) => {
        const normalized = { ...preset, name: preset.name.trim() };
        const presets = brushEditor.existing ? customBrushes.map((entry) => entry.id === normalized.id ? normalized : entry) : [...customBrushes, normalized];
        if (await apply(brushEditor.existing ? "Edit custom brush" : "Create custom brush", [{ kind: "illustration.brush-presets.replace", presets }])) { chooseBrush(normalized.id); setBrushEditor(undefined); }
      }}
      onDelete={async () => {
        if (await apply("Delete custom brush", [{ kind: "illustration.brush-presets.replace", presets: customBrushes.filter((entry) => entry.id !== brushEditor.preset.id) }])) { chooseBrush("hard-round"); setBrushEditor(undefined); }
      }}
    />}
    {brushLibraryOpen && document.kind === "illustration" && <BrushLibraryDialog
      document={document}
      onClose={() => setBrushLibraryOpen(false)}
      onApply={async (plan) => {
        const applied = await apply(plan.mode === "replace" ? "Replace custom brush library" : "Add custom brush copies", plan.operations);
        const operation = plan.operations[0];
        const imported = operation?.kind === "illustration.brush-presets.replace" ? operation.presets.find((preset) => preset.id === plan.importedIds[0]) : undefined;
        if (applied && imported) { setBrushPreset(imported.id); setSize(imported.size); setOpacity(imported.opacity); }
        return applied;
      }}
    />}
    </>
  );
}

function newIllustrationLayer(
  type: IllustrationLayer["type"],
  number: number,
): IllustrationLayer {
  const timestamp = nowIso();
  const common = {
    id: createId("layer"),
    revision: 0,
    name: `${type === "paint" ? "Paint" : type === "vector" ? "Vector" : "Group"} ${number}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal" as const,
  };
  if (type === "vector") return { ...common, type, objectIds: [] };
  if (type === "paint")
    return { ...common, type, tileSize: 256, tileAssetIds: {}, strokes: [] };
  return { ...common, type, childIds: [] };
}

function IllustrationLayers({ document }: { document: IllustrationDocument }) {
  const selected = useEditorStore((state) => state.selectedEntityId);
  const setSelected = useEditorStore((state) => state.setSelectedEntity);
  const selectedObjects = useEditorStore((state) => state.selectedEntityIds);
  const setSelectedObjects = useEditorStore((state) => state.setSelectedEntities);
  const toggleSelectedObject = useEditorStore(
    (state) => state.toggleSelectedEntity,
  );
  const revealObject = useEditorStore((state) => state.revealEntity);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const [query, setQuery] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [renamingObjectId, setRenamingObjectId] = useState<string>();
  const [draggedObjectId, setDraggedObjectId] = useState<string>();
  const selectionAnchor = useRef<string | undefined>(undefined);
  const selectedLayer = selected ? document.layers[selected] : undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const toggleCollapsed = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const flattened = (
    ids: string[],
    depth = 0,
  ): Array<{ layer: IllustrationLayer; depth: number }> =>
    [...ids].reverse().flatMap((id) => {
      const layer = document.layers[id];
      return layer
        ? [
            { layer, depth },
            ...(layer.type === "group" &&
            (normalizedQuery || !collapsedIds.has(layer.id))
              ? flattened(layer.childIds, depth + 1)
              : []),
          ]
        : [];
    });
  const replace = (layer: IllustrationLayer, label: string) =>
    void apply(label, [
      {
        kind: "illustration.layer.replace",
        layer,
        expectedRevision: document.layers[layer.id].revision,
      },
    ]);
  const remove = (layer: IllustrationLayer) => {
    if (document.layerIds.length <= 1) {
      notify("An illustration must keep at least one layer.", "warning");
      return;
    }
    const operations: CanvasOperation[] =
      layer.type === "vector"
        ? layer.objectIds.map((objectId) => ({
            kind: "illustration.object.delete" as const,
            objectId,
          }))
        : [];
    operations.push({ kind: "illustration.layer.delete", layerId: layer.id });
    void apply(`Delete ${layer.name}`, operations);
    if (selected === layer.id) setSelected(undefined);
  };
  const replaceObject = (object: IllustrationObject, label: string) =>
    void apply(label, [
      {
        kind: "illustration.object.replace",
        object,
        expectedRevision: document.objects[object.id].revision,
      },
    ]);
  const moveObject = (
    object: IllustrationObject,
    layerId: string,
    index?: number,
    parentGroupId?: string,
  ) =>
    void apply(`Move ${object.name}`, [
      {
        kind: "illustration.object.move",
        objectId: object.id,
        layerId,
        index,
        parentGroupId,
        expectedRevision: object.revision,
      },
    ]);
  const duplicateObject = (object: IllustrationObject) => {
    const copy = structuredClone(object);
    const timestamp = nowIso();
    copy.id = createId("object");
    copy.revision = 0;
    copy.name = `${object.name} copy`;
    copy.createdAt = timestamp;
    copy.updatedAt = timestamp;
    copy.createdBy = HUMAN_ACTOR.id;
    if (copy.type === "group") copy.childIds = [];
    const layer = document.layers[object.layerId];
    const index =
      layer?.type === "vector"
        ? Math.max(0, layer.objectIds.indexOf(object.id) + 1)
        : undefined;
    void (async () => {
      if (
        await apply(`Duplicate ${object.name}`, [
          { kind: "illustration.object.add", object: copy, index },
        ])
      )
        setSelectedObjects([copy.id]);
    })();
  };
  const deleteObject = (object: IllustrationObject) => {
    void apply(`Delete ${object.name}`, [
      {
        kind: "illustration.object.delete",
        objectId: object.id,
        expectedRevision: object.revision,
      },
    ]);
    setSelectedObjects(
      selectedObjects.filter((objectId) => objectId !== object.id),
    );
  };
  const objectMatches = (objectId: string, visited = new Set<string>()): boolean => {
    if (!normalizedQuery || visited.has(objectId)) return !normalizedQuery;
    visited.add(objectId);
    const object = document.objects[objectId];
    if (!object) return false;
    if (
      `${object.name} ${object.type}`.toLocaleLowerCase().includes(normalizedQuery)
    )
      return true;
    return (
      object.type === "group" &&
      object.childIds.some((childId) => objectMatches(childId, visited))
    );
  };
  const selectObject = (
    event: React.MouseEvent,
    objectId: string,
    layer: Extract<IllustrationLayer, { type: "vector" }>,
  ) => {
    if (event.shiftKey && selectionAnchor.current) {
      const ordered = [...layer.objectIds].reverse();
      const from = ordered.indexOf(selectionAnchor.current);
      const to = ordered.indexOf(objectId);
      if (from >= 0 && to >= 0) {
        const range = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelectedObjects(
          event.metaKey || event.ctrlKey
            ? [...new Set([...selectedObjects, ...range])]
            : range,
        );
      } else setSelectedObjects([objectId]);
    } else if (event.metaKey || event.ctrlKey) toggleSelectedObject(objectId);
    else setSelectedObjects([objectId]);
    selectionAnchor.current = objectId;
  };
  const dropObject = (
    event: React.DragEvent<HTMLDivElement>,
    target: IllustrationObject,
    targetLayer: Extract<IllustrationLayer, { type: "vector" }>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedObjectId
      ? document.objects[draggedObjectId]
      : undefined;
    setDraggedObjectId(undefined);
    if (!source || source.id === target.id) return;
    const targetIndex = targetLayer.objectIds.indexOf(target.id);
    const sourceIndex =
      source.layerId === targetLayer.id
        ? targetLayer.objectIds.indexOf(source.id)
        : -1;
    const targetIndexAfterRemoval =
      sourceIndex >= 0 && sourceIndex < targetIndex
        ? targetIndex - 1
        : targetIndex;
    const bounds = event.currentTarget.getBoundingClientRect();
    const placeVisuallyAbove = event.clientY < bounds.top + bounds.height / 2;
    const index = Math.max(
      0,
      targetIndexAfterRemoval + (placeVisuallyAbove ? 1 : 0),
    );
    moveObject(
      source,
      targetLayer.id,
      index,
      event.altKey && target.type === "group" ? target.id : undefined,
    );
  };
  return (
    <>
      <label className="outliner-search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          placeholder="Filter layers and objects"
          aria-label="Filter layers and objects"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            title="Clear filter"
            aria-label="Clear outliner filter"
            onClick={() => setQuery("")}
          >
            <X size={12} />
          </button>
        )}
      </label>
      <div className="panel-list layer-list">
        {flattened(document.layerIds).map(({ layer, depth }) => {
          const id = layer.id;
          const layerMatches = `${layer.name} ${layer.type}`
            .toLocaleLowerCase()
            .includes(normalizedQuery);
          const matchingObjects =
            layer.type === "vector" &&
            layer.objectIds.some((objectId) => objectMatches(objectId));
          if (
            normalizedQuery &&
            !layerMatches &&
            !matchingObjects &&
            layer.type !== "group"
          )
            return null;
          const childObjectIds =
            layer.type === "vector"
              ? new Set(
                  layer.objectIds.flatMap((objectId) => {
                    const object = document.objects[objectId];
                    return object?.type === "group" ? object.childIds : [];
                  }),
                )
              : new Set<string>();
          const renderObject = (
            objectId: string,
            objectDepth: number,
            path = new Set<string>(),
          ): React.ReactNode => {
            if (layer.type !== "vector" || path.has(objectId)) return null;
            const object = document.objects[objectId];
            if (!object || object.layerId !== layer.id) return null;
            if (normalizedQuery && !objectMatches(objectId)) return null;
            const nextPath = new Set(path);
            nextPath.add(objectId);
            const layerIndex = layer.objectIds.indexOf(object.id);
            const isGroup = object.type === "group";
            const isCollapsed = collapsedIds.has(object.id);
            const ObjectIcon =
              object.type === "text"
                ? Type
                : object.type === "image"
                  ? Image
                  : object.type === "vector-stroke" || object.type === "path"
                    ? PenTool
                    : object.type === "group"
                      ? Layers3
                      : Shapes;
            return (
              <div className="object-tree-node" key={object.id}>
                <div
                  className={`object-row ${selectedObjects.includes(object.id) ? "is-selected" : ""} ${draggedObjectId === object.id ? "is-dragging" : ""}`}
                  style={
                    {
                      "--object-depth": depth + objectDepth,
                    } as React.CSSProperties
                  }
                  draggable={renamingObjectId !== object.id}
                  onDragStart={(event) => {
                    setDraggedObjectId(object.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", object.id);
                  }}
                  onDragEnd={() => setDraggedObjectId(undefined)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => dropObject(event, object, layer)}
                >
                  <button
                    type="button"
                    className="tree-toggle"
                    title={
                      isGroup
                        ? isCollapsed
                          ? "Expand group"
                          : "Collapse group"
                        : undefined
                    }
                    aria-label={isGroup ? `${isCollapsed ? "Expand" : "Collapse"} ${object.name}` : undefined}
                    disabled={!isGroup}
                    onClick={() => isGroup && toggleCollapsed(object.id)}
                  >
                    {isGroup &&
                      (isCollapsed && !normalizedQuery ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      ))}
                  </button>
                  {renamingObjectId === object.id ? (
                    <input
                      className="object-inline-name"
                      aria-label={`Rename ${object.name}`}
                      autoFocus
                      defaultValue={object.name}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={(event) => {
                        const name = event.currentTarget.value.trim();
                        if (name && name !== object.name)
                          replaceObject({ ...object, name }, "Rename object");
                        setRenamingObjectId(undefined);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          event.currentTarget.value = object.name;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="object-main"
                      title={`${object.name} · ${object.type}`}
                      onClick={(event) => selectObject(event, object.id, layer)}
                      onDoubleClick={() => setRenamingObjectId(object.id)}
                    >
                      <span className={`object-type-icon ${object.type}`}>
                        <ObjectIcon size={13} />
                      </span>
                      <span className="object-copy">
                        <strong>{object.name}</strong>
                        <small>
                          {object.type}
                          {isGroup ? ` · ${object.childIds.length}` : ""}
                        </small>
                      </span>
                    </button>
                  )}
                  <div className="object-quick-actions">
                    <button
                      type="button"
                      title="Reveal on canvas"
                      onClick={() => revealObject(object.id)}
                    >
                      <LocateFixed size={12} />
                    </button>
                    <button
                      type="button"
                      title={object.visible ? "Hide object" : "Show object"}
                      onClick={() =>
                        replaceObject(
                          { ...object, visible: !object.visible },
                          object.visible ? "Hide object" : "Show object",
                        )
                      }
                    >
                      {object.visible ? (
                        <Eye size={12} />
                      ) : (
                        <EyeOff size={12} />
                      )}
                    </button>
                    <button
                      type="button"
                      title={object.locked ? "Unlock object" : "Lock object"}
                      onClick={() =>
                        replaceObject(
                          { ...object, locked: !object.locked },
                          object.locked ? "Unlock object" : "Lock object",
                        )
                      }
                    >
                      {object.locked ? (
                        <Lock size={11} />
                      ) : (
                        <Unlock size={11} />
                      )}
                    </button>
                    <button
                      type="button"
                      title="Move object up"
                      disabled={layerIndex >= layer.objectIds.length - 1}
                      onClick={() =>
                        moveObject(object, layer.id, layerIndex + 1)
                      }
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      type="button"
                      title="Move object down"
                      disabled={layerIndex <= 0}
                      onClick={() =>
                        moveObject(object, layer.id, layerIndex - 1)
                      }
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      type="button"
                      title="Duplicate object"
                      onClick={() => duplicateObject(object)}
                    >
                      <Copy size={11} />
                    </button>
                    <button
                      type="button"
                      title="Delete object"
                      onClick={() => deleteObject(object)}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {isGroup && (normalizedQuery || !isCollapsed) && (
                  <div className="object-children">
                    {object.childIds.map((childId) =>
                      renderObject(childId, objectDepth + 1, nextPath),
                    )}
                  </div>
                )}
              </div>
            );
          };
          return (
            <div className="scene-layer" key={id}>
              <div
                className={`layer-row ${selected === id ? "is-selected" : ""}`}
                style={{ "--layer-depth": depth } as React.CSSProperties}
                onDragOver={(event) => {
                  if (layer.type === "vector" && draggedObjectId)
                    event.preventDefault();
                }}
                onDrop={(event) => {
                  if (layer.type !== "vector" || !draggedObjectId) return;
                  event.preventDefault();
                  const source = document.objects[draggedObjectId];
                  setDraggedObjectId(undefined);
                  if (source)
                    moveObject(source, layer.id, layer.objectIds.length);
                }}
              >
                <button
                  type="button"
                  className="tree-toggle layer-tree-toggle"
                  disabled={layer.type === "paint"}
                  title={
                    layer.type === "paint"
                      ? undefined
                      : collapsedIds.has(layer.id)
                        ? "Expand layer"
                        : "Collapse layer"
                  }
                  aria-label={
                    layer.type === "paint"
                      ? undefined
                      : `${collapsedIds.has(layer.id) ? "Expand" : "Collapse"} ${layer.name}`
                  }
                  onClick={() => toggleCollapsed(layer.id)}
                >
                  {layer.type !== "paint" &&
                    (collapsedIds.has(layer.id) && !normalizedQuery ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    ))}
                </button>
                <button className="layer-main" onClick={() => setSelected(id)}>
                  <span className={`layer-thumbnail ${layer.type}`}>
                    <Layers3 size={15} />
                  </span>
                  <span className="layer-copy">
                    <strong>{layer.name}</strong>
                    <small>
                      {layer.type}
                      {layer.type === "vector"
                        ? ` · ${layer.objectIds.length} objects`
                        : layer.type === "paint"
                          ? ` · ${layer.strokes.length} strokes`
                          : ""}
                    </small>
                  </span>
                  <span className="layer-opacity">
                    {Math.round(layer.opacity * 100)}%
                  </span>
                </button>
                <div className="layer-quick-actions">
                  <button
                    title={layer.visible ? "Hide layer" : "Show layer"}
                    onClick={() =>
                      replace(
                        { ...layer, visible: !layer.visible },
                        layer.visible ? "Hide layer" : "Show layer",
                      )
                    }
                  >
                    {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button
                    title={layer.locked ? "Unlock layer" : "Lock layer"}
                    onClick={() =>
                      replace(
                        { ...layer, locked: !layer.locked },
                        layer.locked ? "Unlock layer" : "Lock layer",
                      )
                    }
                  >
                    {layer.locked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                  <button
                    title="Delete layer"
                    disabled={
                      document.layerIds.length <= 1 ||
                      (layer.type === "group" && layer.childIds.length > 0)
                    }
                    onClick={() => remove(layer)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {layer.type === "vector" &&
                (normalizedQuery || !collapsedIds.has(layer.id)) && (
                  <div className="layer-objects" aria-label={`${layer.name} objects`}>
                    {[...layer.objectIds]
                      .reverse()
                      .filter((objectId) => !childObjectIds.has(objectId))
                      .map((objectId) => renderObject(objectId, 1))}
                  </div>
                )}
            </div>
          );
        })}
      </div>
      {selectedLayer && (
        <div className="layer-inspector">
          <label className="field">
            <span>Name</span>
            <input
              key={`${selectedLayer.id}:${selectedLayer.name}`}
              defaultValue={selectedLayer.name}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== selectedLayer.name)
                  replace({ ...selectedLayer, name }, "Rename layer");
              }}
            />
          </label>
          <label className="field">
            <span>Opacity · {Math.round(selectedLayer.opacity * 100)}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(selectedLayer.opacity * 100)}
              onChange={(event) =>
                replace(
                  {
                    ...selectedLayer,
                    opacity: Number(event.target.value) / 100,
                  },
                  "Change layer opacity",
                )
              }
            />
          </label>
          <label className="field">
            <span>Blend mode</span>
            <select
              value={selectedLayer.blendMode}
              onChange={(event) =>
                replace(
                  {
                    ...selectedLayer,
                    blendMode: event.target
                      .value as IllustrationLayer["blendMode"],
                  },
                  "Change blend mode",
                )
              }
            >
              <option value="normal">Normal</option>
              <option value="multiply">Multiply</option>
              <option value="screen">Screen</option>
              <option value="overlay">Overlay</option>
              <option value="darken">Darken</option>
              <option value="lighten">Lighten</option>
              <option value="color-dodge">Color dodge</option>
              <option value="color-burn">Color burn</option>
              <option value="soft-light">Soft light</option>
              <option value="hard-light">Hard light</option>
              <option value="difference">Difference</option>
              <option value="exclusion">Exclusion</option>
            </select>
          </label>
          <label className="field">
            <span>Parent group</span>
            <select
              value={selectedLayer.parentId ?? ""}
              onChange={(event) =>
                void apply("Move layer", [
                  {
                    kind: "illustration.layer.move",
                    layerId: selectedLayer.id,
                    parentId: event.target.value || undefined,
                    expectedRevision: selectedLayer.revision,
                  },
                ])
              }
            >
              <option value="">Artboard root</option>
              {Object.values(document.layers)
                .filter(
                  (layer) =>
                    layer.type === "group" && layer.id !== selectedLayer.id,
                )
                .map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Clipping mask layer</span>
            <select
              value={selectedLayer.maskLayerId ?? ""}
              onChange={(event) =>
                replace(
                  {
                    ...selectedLayer,
                    maskLayerId: event.target.value || undefined,
                  },
                  "Set clipping mask",
                )
              }
            >
              <option value="">None</option>
              {Object.values(document.layers)
                .filter(
                  (layer) =>
                    layer.id !== selectedLayer.id && layer.type === "vector",
                )
                .map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="mask-author-button" onClick={() => {
            const timestamp = nowIso(); const maskLayerId = createId("mask-layer"); const maskObjectId = createId("mask-object");
            const maskLayer: IllustrationLayer = { id: maskLayerId, revision: 0, name: `${selectedLayer.name} mask`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: false, locked: false, opacity: 1, blendMode: "normal", type: "vector", objectIds: [] };
            const maskObject: IllustrationObject = { id: maskObjectId, revision: 0, name: "Mask bounds", createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: maskLayerId, visible: true, locked: false, opacity: 1, blendMode: "normal", transform: structuredClone(IDENTITY_TRANSFORM), type: "shape", shape: "rectangle", width: document.artboard.width, height: document.artboard.height, fill: { kind: "solid", color: "#ffffff" }, stroke: { paint: { kind: "none" }, width: 0, opacity: 1, lineCap: "round", lineJoin: "round", dash: [] } };
            void apply("Create editable layer mask", [{ kind: "illustration.layer.add", layer: maskLayer }, { kind: "illustration.object.add", object: maskObject }, { kind: "illustration.layer.replace", layer: { ...selectedLayer, maskLayerId }, expectedRevision: selectedLayer.revision }]);
          }}>Create editable layer mask</button>
          <LayerFilterStack layer={selectedLayer} onReplace={replace} />
        </div>
      )}
    </>
  );
}

function objectBounds(object: IllustrationObject): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const local = approximateLocalObjectBounds(object);
  const left = local.x * object.transform.scaleX;
  const right = (local.x + local.width) * object.transform.scaleX;
  const top = local.y * object.transform.scaleY;
  const bottom = (local.y + local.height) * object.transform.scaleY;
  return {
    x: object.transform.x + Math.min(left, right),
    y: object.transform.y + Math.min(top, bottom),
    width: Math.max(1, Math.abs(right - left)),
    height: Math.max(1, Math.abs(bottom - top)),
  };
}

function ArtboardInspector({ document }: { document: IllustrationDocument }) {
  const apply = useEditorStore((state) => state.apply);
  const [draft, setDraft] = useState(() => structuredClone(document.artboard));
  const valid = Number.isInteger(draft.width) && draft.width >= 1 && draft.width <= 8192 && Number.isInteger(draft.height) && draft.height >= 1 && draft.height <= 8192 && Number.isInteger(draft.dpi) && draft.dpi >= 1 && draft.dpi <= 1200;
  const changed = JSON.stringify(draft) !== JSON.stringify(document.artboard);
  const guides = document.guides ?? [];
  const snapSettings = document.snapSettings ?? { artboard: true, objects: true, guides: true, grid: false, pixel: false, gridSize: 16, tolerance: 8 };
  const replaceGuides = (next: typeof guides, label: string) => void apply(label, [{ kind: 'illustration.guides.replace', guides: next, expectedRevision: document.revision }]);
  const replaceSnapping = (patch: Partial<typeof snapSettings>) => void apply('Change snapping', [{ kind: 'illustration.snap-settings.replace', settings: { ...snapSettings, ...patch }, expectedRevision: document.revision }]);
  return (
    <div className="layer-inspector artboard-inspector">
      <div className="section-heading"><span>Artboard</span><small>px · sRGB</small></div>
      <div className="two-fields">
        <label className="field"><span>Width</span><input aria-label="Artboard width" type="number" min="1" max="8192" value={draft.width} onChange={(event) => setDraft((current) => ({ ...current, width: Number(event.target.value) }))} /></label>
        <label className="field"><span>Height</span><input aria-label="Artboard height" type="number" min="1" max="8192" value={draft.height} onChange={(event) => setDraft((current) => ({ ...current, height: Number(event.target.value) }))} /></label>
      </div>
      <label className="field"><span>DPI</span><input aria-label="Artboard DPI" type="number" min="1" max="1200" value={draft.dpi} onChange={(event) => setDraft((current) => ({ ...current, dpi: Number(event.target.value) }))} /></label>
      <label className="checkbox-row"><input type="checkbox" checked={draft.background === null} onChange={(event) => setDraft((current) => ({ ...current, background: event.target.checked ? null : '#fffdf7' }))} /><span>Transparent background</span></label>
      {draft.background !== null && <label className="field"><span>Background</span><input aria-label="Artboard background color" type="color" value={draft.background.slice(0, 7)} onChange={(event) => setDraft((current) => ({ ...current, background: event.target.value }))} /></label>}
      <button className="primary-button" disabled={!valid || !changed} onClick={() => void apply('Resize artboard', [{ kind: 'illustration.artboard.replace', artboard: draft, expectedRevision: document.revision }])}>Apply artboard</button>
      <div className="section-heading"><span>Persistent guides</span><small>{guides.length}</small></div>
      <div className="guide-add-actions"><button onClick={() => replaceGuides([...guides, { id: createId('guide'), orientation: 'vertical', position: document.artboard.width / 2, color: '#2fa7a0', locked: false }], 'Add vertical guide')}>+ Vertical</button><button onClick={() => replaceGuides([...guides, { id: createId('guide'), orientation: 'horizontal', position: document.artboard.height / 2, color: '#e65f7d', locked: false }], 'Add horizontal guide')}>+ Horizontal</button></div>
      <div className="guide-list">{guides.map((guide) => <div className="guide-row" key={guide.id}>
        <select value={guide.orientation} disabled={guide.locked} onChange={(event) => replaceGuides(guides.map((entry) => entry.id === guide.id ? { ...entry, orientation: event.target.value as typeof guide.orientation } : entry), 'Turn guide')}><option value="vertical">V</option><option value="horizontal">H</option></select>
        <input aria-label={`${guide.orientation} guide position`} type="number" defaultValue={guide.position} disabled={guide.locked} onBlur={(event) => replaceGuides(guides.map((entry) => entry.id === guide.id ? { ...entry, position: Number(event.target.value) } : entry), 'Move guide')} />
        <input aria-label="Guide color" type="color" value={guide.color.slice(0, 7)} onChange={(event) => replaceGuides(guides.map((entry) => entry.id === guide.id ? { ...entry, color: event.target.value } : entry), 'Color guide')} />
        <button title={guide.locked ? 'Unlock guide' : 'Lock guide'} onClick={() => replaceGuides(guides.map((entry) => entry.id === guide.id ? { ...entry, locked: !entry.locked } : entry), guide.locked ? 'Unlock guide' : 'Lock guide')}>{guide.locked ? <Lock size={11} /> : <Unlock size={11} />}</button>
        <button title="Delete guide" onClick={() => replaceGuides(guides.filter((entry) => entry.id !== guide.id), 'Delete guide')}><Trash2 size={11} /></button>
      </div>)}</div>
      <div className="section-heading"><span>Snapping</span><small>{snapSettings.tolerance}px tolerance</small></div>
      <div className="snap-settings-grid">
        {([['artboard', 'Artboard'], ['objects', 'Objects'], ['guides', 'Guides'], ['grid', 'Grid'], ['pixel', 'Pixels']] as const).map(([key, label]) => <label className="checkbox-row" key={key}><input type="checkbox" checked={snapSettings[key]} onChange={(event) => replaceSnapping({ [key]: event.target.checked })} /><span>{label}</span></label>)}
      </div>
      <div className="two-fields"><label className="field"><span>Grid size</span><input type="number" min="1" max="4096" value={snapSettings.gridSize} onChange={(event) => replaceSnapping({ gridSize: Math.max(1, Number(event.target.value)) })} /></label><label className="field"><span>Tolerance</span><input type="number" min="0" max="128" value={snapSettings.tolerance} onChange={(event) => replaceSnapping({ tolerance: Math.max(0, Number(event.target.value)) })} /></label></div>
    </div>
  );
}

type GradientFill = Extract<PaintStyle, { kind: "linear-gradient" | "radial-gradient" }>;

function GradientEditor({ fill, newColor, onApply }: { fill: GradientFill; newColor: string; onApply: (fill: GradientFill) => void }) {
  const [draft, setDraft] = useState(() => structuredClone(fill));
  const updateStop = (index: number, patch: Partial<GradientFill["stops"][number]>) => setDraft((current) => ({ ...current, stops: current.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...patch } : stop) }));
  const addStop = () => {
    const ordered = [...draft.stops].sort((left, right) => left.offset - right.offset); let offset = 0.5; let gap = -1;
    for (let index = 1; index < ordered.length; index += 1) { const candidate = ordered[index].offset - ordered[index - 1].offset; if (candidate > gap) { gap = candidate; offset = (ordered[index].offset + ordered[index - 1].offset) / 2; } }
    setDraft((current) => ({ ...current, stops: [...current.stops, { offset, color: newColor, opacity: 1 }].sort((left, right) => left.offset - right.offset) }));
  };
  const cssStops = [...draft.stops].sort((left, right) => left.offset - right.offset).map((stop) => `${stop.color}${Math.round((stop.opacity ?? 1) * 255).toString(16).padStart(2, "0")} ${Math.round(stop.offset * 100)}%`).join(", ");
  return (
    <div className="gradient-editor">
      <div className="gradient-preview" style={{ background: draft.kind === "radial-gradient" ? `radial-gradient(circle, ${cssStops})` : `linear-gradient(90deg, ${cssStops})` }} />
      <div className="gradient-coordinates">
        {(["x1", "y1", "x2", "y2"] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}
      </div>
      <div className="gradient-stop-list">
        {draft.stops.map((stop, index) => <div className="gradient-stop-row" key={`${index}:${stop.offset}`}>
          <input aria-label={`Gradient stop ${index + 1} color`} type="color" value={stop.color.slice(0, 7)} onChange={(event) => updateStop(index, { color: event.target.value })} />
          <label><span>Position</span><input type="number" min="0" max="100" value={Math.round(stop.offset * 100)} onChange={(event) => updateStop(index, { offset: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} /></label>
          <label><span>Opacity</span><input type="number" min="0" max="100" value={Math.round((stop.opacity ?? 1) * 100)} onChange={(event) => updateStop(index, { opacity: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} /></label>
          <button title="Delete gradient stop" disabled={draft.stops.length <= 2} onClick={() => setDraft((current) => ({ ...current, stops: current.stops.filter((_, stopIndex) => stopIndex !== index) }))}><Trash2 size={12} /></button>
        </div>)}
      </div>
      <div className="gradient-actions"><button onClick={addStop}>Add stop</button><button className="primary-button" onClick={() => onApply({ ...draft, stops: [...draft.stops].sort((left, right) => left.offset - right.offset) })}>Apply gradient</button></div>
    </div>
  );
}

function TextInspector({ object, onReplace }: { object: TextObject; onReplace: (object: TextObject, label: string) => void }) {
  const [draftText, setDraftText] = useState(object.text);
  const [selection, setSelection] = useState({ start: 0, end: object.text.length });
  const style = textStyleAt(object, selection.start);
  const applyStyle = (patch: Partial<TextStyle>, label: string) => { if (selection.end > selection.start) onReplace(applyTextStyleRange(object, selection.start, selection.end, patch), label); };
  return (
    <div className="typography-editor">
      <div className="section-heading"><span>Typography</span><small>{selection.end > selection.start ? `${selection.start}–${selection.end}` : "Select text to style"}</small></div>
      <label className="field"><span>Text</span><textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /></label>
      <button className="primary-button" disabled={draftText === object.text} onClick={() => onReplace(replaceStyledText(object, draftText), "Edit text")}>Apply text</button>
      <div className="two-fields">
        <label className="field"><span>Font</span><input key={`${object.revision}:font:${selection.start}`} defaultValue={style.fontFamily} onBlur={(event) => applyStyle({ fontFamily: event.target.value.trim() || "Segoe UI" }, "Style text range")} /></label>
        <label className="field"><span>Size</span><input key={`${object.revision}:size:${selection.start}`} type="number" min="1" max="500" defaultValue={style.fontSize} onBlur={(event) => applyStyle({ fontSize: Math.max(1, Math.min(500, Number(event.target.value))) }, "Style text range")} /></label>
        <label className="field"><span>Weight</span><select value={style.fontWeight} onChange={(event) => applyStyle({ fontWeight: Number(event.target.value) }, "Style text range")}><option value="300">Light</option><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Extra bold</option></select></label>
        <label className="field"><span>Tracking</span><input key={`${object.revision}:tracking:${selection.start}`} type="number" min="-20" max="100" defaultValue={style.letterSpacing} onBlur={(event) => applyStyle({ letterSpacing: Math.max(-20, Math.min(100, Number(event.target.value))) }, "Style text range")} /></label>
      </div>
      <div className="typography-style-row">
        <label><input type="checkbox" checked={style.fontStyle === "italic"} disabled={selection.end <= selection.start} onChange={(event) => applyStyle({ fontStyle: event.target.checked ? "italic" : "normal" }, "Style text range")} /> Italic</label>
        <label><input type="checkbox" checked={Boolean(style.underline)} disabled={selection.end <= selection.start} onChange={(event) => applyStyle({ underline: event.target.checked }, "Style text range")} /> Underline</label>
        <input aria-label="Text range color" type="color" value={style.color.slice(0, 7)} disabled={selection.end <= selection.start} onChange={(event) => applyStyle({ color: event.target.value }, "Style text range")} />
      </div>
      <div className="align-grid text-align-grid">{(["left", "center", "right", "justify"] as const).map((align) => <button className={object.align === align ? "is-active" : ""} key={align} onClick={() => onReplace({ ...object, align }, "Align text")}>{align}</button>)}</div>
      <div className="transform-grid">
        <label><span>Box width</span><input key={`${object.revision}:text-width`} type="number" min="1" max="8192" defaultValue={object.width} onBlur={(event) => onReplace({ ...object, width: Math.max(1, Number(event.target.value)) }, "Resize text box")} /></label>
        <label><span>Box height</span><input key={`${object.revision}:text-height`} type="number" min="1" max="8192" defaultValue={object.height} onBlur={(event) => onReplace({ ...object, height: Math.max(1, Number(event.target.value)) }, "Resize text box")} /></label>
        <label><span>Line height</span><input key={`${object.revision}:line-height`} type="number" min="0.5" max="5" step="0.05" defaultValue={object.lineHeight} onBlur={(event) => onReplace({ ...object, lineHeight: Math.max(0.5, Math.min(5, Number(event.target.value))) }, "Change line height")} /></label>
      </div>
      <small>Double-click visible unlocked text on the canvas, or select it and press Enter, to edit content in place. Range typography remains in this inspector. Text wraps to the box width; explicit line breaks, per-range style, alignment, tracking, and underline render identically in the editor and headless export.</small>
    </div>
  );
}

function ObjectFilterStack({ object, onReplace }: { object: IllustrationObject; onReplace: (object: IllustrationObject, label: string) => void }) {
  type Filters = NonNullable<IllustrationObject["filters"]>;
  type FilterType = Filters[number]["type"];
  const [newFilter, setNewFilter] = useState<FilterType>("brightness");
  const filters = object.filters ?? [];
  const replaceFilters = (next: Filters, label: string) => onReplace({ ...object, filters: next }, label);
  const range = (type: FilterType) => type === "hue" ? { min: -180, max: 180, step: 1 } : type === "blur" ? { min: 0, max: 40, step: 0.25 } : { min: -1, max: 1, step: 0.05 };
  const initial = (type: FilterType) => type === "hue" ? 15 : type === "blur" ? 2 : 0.15;
  return (
    <div className="filter-stack">
      <div className="section-heading"><span>{object.type === "image" ? "Image" : "Object"} filter stack</span><small>{filters.length}</small></div>
      {filters.length === 0 ? <small className="filter-empty">No adjustments. Filters remain editable and render in stack order.</small> : <div className="filter-stack-list">{filters.map((filter, index) => {
        const limits = range(filter.type); return <div className="filter-stack-row" key={`${filter.type}:${index}`}>
          <div className="filter-stack-title"><strong>{filter.type}</strong><output>{filter.type === "hue" ? `${Math.round(filter.value)}°` : filter.type === "blur" ? `${filter.value.toFixed(1)}px` : filter.value.toFixed(2)}</output></div>
          <input aria-label={`${filter.type} filter value`} type="range" min={limits.min} max={limits.max} step={limits.step} value={filter.value} onChange={(event) => replaceFilters(filters.map((entry, position) => position === index ? { ...entry, value: Number(event.target.value) } : entry), `Change ${filter.type} filter`)} />
          <div className="filter-stack-actions"><button disabled={index === 0} title="Move filter earlier" onClick={() => { const next = [...filters]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; replaceFilters(next, "Reorder object filters"); }}><ArrowUp size={11} /></button><button disabled={index === filters.length - 1} title="Move filter later" onClick={() => { const next = [...filters]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; replaceFilters(next, "Reorder object filters"); }}><ArrowDown size={11} /></button><button title="Remove filter" onClick={() => replaceFilters(filters.filter((_, position) => position !== index), `Remove ${filter.type} filter`)}><Trash2 size={11} /></button></div>
        </div>;
      })}</div>}
      <div className="filter-stack-add"><select aria-label="New object filter" value={newFilter} onChange={(event) => setNewFilter(event.target.value as FilterType)}>{(["brightness", "contrast", "saturation", "hue", "blur"] as FilterType[]).map((type) => <option key={type} value={type}>{type}</option>)}</select><button onClick={() => replaceFilters([...filters, { type: newFilter, value: initial(newFilter) }], `Add ${newFilter} filter`)}>+ Add</button>{filters.length > 0 && <button onClick={() => replaceFilters([], "Clear object filters")}>Clear</button>}</div>
    </div>
  );
}

function LayerFilterStack({ layer, onReplace }: { layer: IllustrationLayer; onReplace: (layer: IllustrationLayer, label: string) => void }) {
  type Filters = NonNullable<IllustrationLayer["filters"]>;
  type FilterType = Filters[number]["type"];
  const [newFilter, setNewFilter] = useState<FilterType>("brightness");
  const filters = layer.filters ?? [];
  const replaceFilters = (next: Filters, label: string) => onReplace({ ...layer, filters: next }, label);
  const range = (type: FilterType) => type === "hue" ? { min: -180, max: 180, step: 1 } : type === "blur" ? { min: 0, max: 40, step: 0.25 } : { min: -1, max: 1, step: 0.05 };
  const initial = (type: FilterType) => type === "hue" ? 15 : type === "blur" ? 2 : 0.15;
  return (
    <div className="filter-stack layer-filter-stack">
      <div className="section-heading"><span>Isolated layer filter stack</span><small>{filters.length}</small></div>
      {filters.length === 0 ? <small className="filter-empty">Filters apply after this layer or group is composited, preserving overlap behavior.</small> : <div className="filter-stack-list">{filters.map((filter, index) => {
        const limits = range(filter.type); return <div className="filter-stack-row" key={`${filter.type}:${index}`}>
          <div className="filter-stack-title"><strong>{filter.type}</strong><output>{filter.type === "hue" ? `${Math.round(filter.value)}°` : filter.type === "blur" ? `${filter.value.toFixed(1)}px` : filter.value.toFixed(2)}</output></div>
          <input aria-label={`${filter.type} layer filter value`} type="range" min={limits.min} max={limits.max} step={limits.step} value={filter.value} onChange={(event) => replaceFilters(filters.map((entry, position) => position === index ? { ...entry, value: Number(event.target.value) } : entry), `Change ${filter.type} layer filter`)} />
          <div className="filter-stack-actions"><button disabled={index === 0} title="Move filter earlier" onClick={() => { const next = [...filters]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; replaceFilters(next, "Reorder layer filters"); }}><ArrowUp size={11} /></button><button disabled={index === filters.length - 1} title="Move filter later" onClick={() => { const next = [...filters]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; replaceFilters(next, "Reorder layer filters"); }}><ArrowDown size={11} /></button><button title="Remove filter" onClick={() => replaceFilters(filters.filter((_, position) => position !== index), `Remove ${filter.type} layer filter`)}><Trash2 size={11} /></button></div>
        </div>;
      })}</div>}
      <div className="filter-stack-add"><select aria-label="New layer filter" value={newFilter} onChange={(event) => setNewFilter(event.target.value as FilterType)}>{(["brightness", "contrast", "saturation", "hue", "blur"] as FilterType[]).map((type) => <option key={type} value={type}>{type}</option>)}</select><button onClick={() => replaceFilters([...filters, { type: newFilter, value: initial(newFilter) }], `Add ${newFilter} layer filter`)}>+ Add</button>{filters.length > 0 && <button onClick={() => replaceFilters([], "Clear layer filters")}>Clear</button>}</div>
    </div>
  );
}

function ObjectInspector({ document }: { document: IllustrationDocument }) {
  const selectedIds = useEditorStore((state) => state.selectedEntityIds);
  const setSelected = useEditorStore((state) => state.setSelectedEntities);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const primaryColor = useEditorStore((state) => state.primaryColor);
  const secondaryColor = useEditorStore((state) => state.secondaryColor);
  const objects = selectedIds.map((id) => document.objects[id]).filter(Boolean);
  const object = objects.at(-1);
  const [alignmentTarget, setAlignmentTarget] = useState<AlignmentTarget>("selection");
  const [distributionMode, setDistributionMode] = useState<DistributionMode>("centers");
  const [pathSplitNode, setPathSplitNode] = useState(1);
  if (!object) return null;
  const replace = (next: IllustrationObject, label: string) =>
    void apply(label, [
      {
        kind: "illustration.object.replace",
        object: next,
        expectedRevision: document.objects[next.id].revision,
      },
    ]);
  const align = (
    mode: "left" | "center-x" | "right" | "top" | "center-y" | "bottom",
  ) => {
    const aligned = alignIllustrationObjects(objects, mode, alignmentTarget, { x: 0, y: 0, width: document.artboard.width, height: document.artboard.height }, object.id);
    const operations = aligned.map((entry) => ({
        kind: "illustration.object.replace" as const,
        object: entry,
        expectedRevision: entry.revision,
      }));
    void apply(`Align ${mode}`, operations);
  };
  const distribute = (axis: "x" | "y") => {
    if (objects.length < 3) {
      notify("Select at least three objects to distribute them.", "warning");
      return;
    }
    const distributed = distributeIllustrationObjects(objects, axis, distributionMode);
    const operations = distributed.map((entry) => ({
        kind: "illustration.object.replace" as const,
        object: entry,
        expectedRevision: entry.revision,
      }));
    void apply(`${distributionMode === "spacing" ? "Space" : "Distribute"} ${axis}`, operations);
  };
  const boolean = async (
    mode: "union" | "subtract" | "intersect" | "exclude",
  ) => {
    if (objects.length !== 2) {
      notify(
        "Select exactly two compatible vector shapes for a boolean operation.",
        "warning",
      );
      return;
    }
    try {
      const { createBooleanPath } = await import("../common/path-boolean");
      const result = createBooleanPath(objects[0], objects[1], mode);
      const operations: CanvasOperation[] = objects.map((entry) => ({
        kind: "illustration.object.delete",
        objectId: entry.id,
        expectedRevision: entry.revision,
      }));
      operations.push({ kind: "illustration.object.add", object: result });
      if (await apply(`${mode} paths`, operations)) setSelected([result.id]);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const applyPolishedGold = async () => {
    if (objects.length !== 1) {
      notify(
        "Select exactly one vector shape or path for a material preset.",
        "warning",
      );
      return;
    }
    try {
      const material = buildPolishedGoldMaterial(document, object);
      if (await apply("Apply Polished Gold material", material.operations)) {
        setSelected(material.selectedObjectIds);
        notify(
          "Polished Gold created as an editable reflection stack.",
          "success",
        );
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const parentGroup = Object.values(document.objects).find(
    (entry) => entry.type === "group" && entry.childIds.includes(object.id),
  );
  const containsObject = (
    groupId: string,
    candidateId: string,
    visited = new Set<string>(),
  ): boolean => {
    if (visited.has(groupId)) return false;
    visited.add(groupId);
    const group = document.objects[groupId];
    if (!group || group.type !== "group") return false;
    if (group.childIds.includes(candidateId)) return true;
    return group.childIds.some((childId) =>
      containsObject(childId, candidateId, visited),
    );
  };
  const compatibleGroups = Object.values(document.objects).filter(
    (entry) =>
      entry.type === "group" &&
      entry.id !== object.id &&
      entry.layerId === object.layerId &&
      (object.type !== "group" || !containsObject(object.id, entry.id)),
  );
  const maskCandidates = Object.values(document.objects).filter((entry) => entry.id !== object.id && entry.layerId === object.layerId && (entry.type === "shape" || entry.type === "path" || entry.type === "vector-stroke"));
  const selectionMask = objects.length > 1 && (object.type === "shape" || object.type === "path" || object.type === "vector-stroke") && objects.slice(0, -1).every((entry) => entry.layerId === object.layerId) ? object : undefined;
  const groupSelected = () => {
    if (objects.length === 0) return;
    const layerId = objects[0].layerId;
    if (objects.some((entry) => entry.layerId !== layerId)) {
      notify("Objects must share a vector layer before grouping.", "warning");
      return;
    }
    const layer = document.layers[layerId];
    if (!layer || layer.type !== "vector") return;
    const timestamp = nowIso();
    const group: IllustrationObject = {
      id: createId("object-group"),
      revision: 0,
      name: "Group",
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id,
      layerId,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "normal",
      transform: structuredClone(IDENTITY_TRANSFORM),
      type: "group",
      childIds: objects.map((entry) => entry.id),
    };
    const operations: CanvasOperation[] = [
      {
        kind: "illustration.object.add",
        object: group,
        index:
          Math.max(...objects.map((entry) => layer.objectIds.indexOf(entry.id))) +
          1,
      },
      ...objects.map((entry) => ({
        kind: "illustration.object.move" as const,
        objectId: entry.id,
        layerId,
        index: layer.objectIds.indexOf(entry.id),
        parentGroupId: group.id,
        expectedRevision: entry.revision,
      })),
    ];
    void (async () => {
      if (await apply("Group objects", operations)) setSelected([group.id]);
    })();
  };
  const pathObjects = objects.filter(
    (entry): entry is Extract<IllustrationObject, { type: "path" }> =>
      entry.type === "path",
  );
  let pathNodeCount = 0;
  if (object.type === "path") {
    try {
      pathNodeCount = inspectPathNodes(object.pathData).length;
    } catch {
      pathNodeCount = 0;
    }
  }
  const pathSplitMinimum = object.type === "path" && object.closed ? 0 : 1;
  const pathSplitMaximum =
    object.type === "path"
      ? object.closed
        ? pathNodeCount - 1
        : pathNodeCount - 2
      : -1;
  const selectedSplitNode = Math.max(
    pathSplitMinimum,
    Math.min(pathSplitNode, pathSplitMaximum),
  );
  const splitSelectedPath = async () => {
    if (object.type !== "path" || pathSplitMaximum < pathSplitMinimum) return;
    try {
      const split = splitPathAtNode(object.pathData, selectedSplitNode);
      const operations: CanvasOperation[] = [
        {
          kind: "illustration.object.replace",
          object: {
            ...object,
            pathData: split.primaryPathData,
            closed: false,
          },
          expectedRevision: object.revision,
        },
      ];
      let secondaryId: string | undefined;
      if (split.secondaryPathData) {
        const layer = document.layers[object.layerId];
        if (!layer || layer.type !== "vector")
          throw new Error("The path vector layer does not exist.");
        const timestamp = nowIso();
        secondaryId = createId("path");
        operations.push({
          kind: "illustration.object.add",
          object: {
            ...structuredClone(object),
            id: secondaryId,
            revision: 0,
            name: `${object.name} part 2`,
            createdAt: timestamp,
            updatedAt: timestamp,
            createdBy: HUMAN_ACTOR.id,
            pathData: split.secondaryPathData,
            closed: false,
          },
          index: Math.max(0, layer.objectIds.indexOf(object.id) + 1),
          parentGroupId: parentGroup?.id,
          groupIndex:
            parentGroup?.type === "group"
              ? Math.max(0, parentGroup.childIds.indexOf(object.id) + 1)
              : undefined,
        });
      }
      if (await apply(object.closed ? "Cut closed path" : "Split path", operations))
        setSelected(secondaryId ? [object.id, secondaryId] : [object.id]);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const joinSelectedPaths = async () => {
    if (pathObjects.length !== 2) {
      notify("Select exactly two open paths to join.", "warning");
      return;
    }
    const primary = pathObjects.at(-1)!;
    const secondary = pathObjects[0];
    try {
      const joined = joinPathObjects(primary, secondary, "nearest");
      if (
        await apply("Join paths", [
          {
            kind: "illustration.object.replace",
            object: joined,
            expectedRevision: primary.revision,
          },
          {
            kind: "illustration.object.delete",
            objectId: secondary.id,
            expectedRevision: secondary.revision,
          },
        ])
      )
        setSelected([primary.id]);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const supportsPaint = object.type === "shape" || object.type === "path";
  return (
    <div className="object-inspector">
      <div className="section-heading">
        <span>
          {objects.length > 1
            ? `${objects.length} objects selected`
            : object.type}
        </span>
        <button onClick={groupSelected} title="Group selected objects">
          <Layers3 size={12} /> Group
        </button>
        <button
          onClick={() => {
            void apply(
              "Delete objects",
              objects.map((entry) => ({
                kind: "illustration.object.delete",
                objectId: entry.id,
                expectedRevision: entry.revision,
              })),
            );
            setSelected([]);
          }}
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
      <label className="field">
        <span>Name</span>
        <input
          key={`${object.id}:${object.name}`}
          defaultValue={object.name}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name && name !== object.name)
              replace({ ...object, name }, "Rename object");
          }}
        />
      </label>
      <div className="object-location-grid">
        <label className="field">
          <span>Vector layer</span>
          <select
            value={object.layerId}
            onChange={(event) => {
              const targetLayer = document.layers[event.target.value];
              if (targetLayer?.type !== "vector") return;
              void apply("Move object to layer", [
                {
                  kind: "illustration.object.move",
                  objectId: object.id,
                  layerId: targetLayer.id,
                  index: targetLayer.objectIds.length,
                  expectedRevision: object.revision,
                },
              ]);
            }}
          >
            {Object.values(document.layers)
              .filter((layer) => layer.type === "vector")
              .map((layer) => (
                <option
                  key={layer.id}
                  value={layer.id}
                  disabled={
                    object.type === "group" &&
                    object.childIds.length > 0 &&
                    layer.id !== object.layerId
                  }
                >
                  {layer.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Object group</span>
          <select
            value={parentGroup?.id ?? ""}
            onChange={(event) => {
              const layer = document.layers[object.layerId];
              if (layer?.type !== "vector") return;
              void apply(event.target.value ? "Nest object" : "Ungroup object", [
                {
                  kind: "illustration.object.move",
                  objectId: object.id,
                  layerId: object.layerId,
                  index: layer.objectIds.indexOf(object.id),
                  parentGroupId: event.target.value || undefined,
                  expectedRevision: object.revision,
                },
              ]);
            }}
          >
            <option value="">No object group</option>
            {compatibleGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="transform-grid">
        <label>
          <span>X</span>
          <input
            key={`${object.id}:x`}
            type="number"
            defaultValue={Math.round(object.transform.x)}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  transform: {
                    ...object.transform,
                    x: Number(event.target.value),
                  },
                },
                "Move object",
              )
            }
          />
        </label>
        <label>
          <span>Y</span>
          <input
            key={`${object.id}:y`}
            type="number"
            defaultValue={Math.round(object.transform.y)}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  transform: {
                    ...object.transform,
                    y: Number(event.target.value),
                  },
                },
                "Move object",
              )
            }
          />
        </label>
        <label>
          <span>Rotate</span>
          <input
            key={`${object.id}:rotation`}
            type="number"
            defaultValue={object.transform.rotation}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  transform: {
                    ...object.transform,
                    rotation: Number(event.target.value),
                  },
                },
                "Rotate object",
              )
            }
          />
        </label>
        <label>
          <span>Opacity</span>
          <input
            key={`${object.id}:opacity`}
            type="number"
            min="0"
            max="100"
            defaultValue={Math.round(object.opacity * 100)}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  opacity: Math.max(
                    0,
                    Math.min(1, Number(event.target.value) / 100),
                  ),
                },
                "Change object opacity",
              )
            }
          />
        </label>
      </div>
      <div className="alignment-options"><label className="field"><span>Align to</span><select value={alignmentTarget} onChange={(event) => setAlignmentTarget(event.target.value as AlignmentTarget)}><option value="selection">Selection bounds</option><option value="key-object">Key object · {object.name}</option><option value="artboard">Artboard</option></select></label><label className="field"><span>Distribute by</span><select value={distributionMode} onChange={(event) => setDistributionMode(event.target.value as DistributionMode)}><option value="centers">Centers</option><option value="spacing">Equal gaps</option></select></label></div>
      <div className="align-grid">
        <button onClick={() => align("left")}>Left</button>
        <button onClick={() => align("center-x")}>Center X</button>
        <button onClick={() => align("right")}>Right</button>
        <button onClick={() => align("top")}>Top</button>
        <button onClick={() => align("center-y")}>Center Y</button>
        <button onClick={() => align("bottom")}>Bottom</button>
        <button onClick={() => distribute("x")}>{distributionMode === "spacing" ? "Space X" : "Distribute X"}</button>
        <button onClick={() => distribute("y")}>{distributionMode === "spacing" ? "Space Y" : "Distribute Y"}</button>
      </div>
      {supportsPaint && (
        <>
          <div className="section-heading">
            <span>Fill & path</span>
          </div>
          <div className="paint-actions">
            <button
              onClick={() =>
                replace(
                  { ...object, fill: { kind: "solid", color: primaryColor } },
                  "Set solid fill",
                )
              }
            >
              Solid
            </button>
            <button
              onClick={() =>
                replace(
                  {
                    ...object,
                    fill: {
                      kind: "linear-gradient",
                      x1: 0,
                      y1: 0,
                      x2: objectBounds(object).width,
                      y2: objectBounds(object).height,
                      stops: [
                        { offset: 0, color: primaryColor },
                        { offset: 1, color: secondaryColor },
                      ],
                    },
                  },
                  "Set linear gradient",
                )
              }
            >
              Linear gradient
            </button>
            <button
              onClick={() =>
                replace(
                  {
                    ...object,
                    fill: {
                      kind: "radial-gradient",
                      x1: objectBounds(object).width / 2,
                      y1: objectBounds(object).height / 2,
                      x2: objectBounds(object).width,
                      y2: objectBounds(object).height / 2,
                      stops: [
                        { offset: 0, color: primaryColor },
                        { offset: 1, color: secondaryColor },
                      ],
                    },
                  },
                  "Set radial gradient",
                )
              }
            >
              Radial
            </button>
          </div>
          {(object.fill.kind === "linear-gradient" || object.fill.kind === "radial-gradient") && <GradientEditor key={`${object.id}:${object.revision}:gradient`} fill={object.fill} newColor={primaryColor} onApply={(fill) => replace({ ...object, fill }, "Edit gradient stops")} />}
          {object.type === "path" && (
            <div className="path-node-actions">
              <button
                onClick={() =>
                  replace(
                    {
                      ...object,
                      closed: !object.closed,
                      pathData: setPathClosed(object.pathData, !object.closed),
                    },
                    object.closed ? "Open path" : "Close path",
                  )
                }
              >
                {object.closed ? "Open path" : "Close path"}
              </button>
              {/[aA]/.test(object.pathData) && <button onClick={() => { const converted = convertPathArcsToCubics(object.pathData); replace({ ...object, ...converted }, "Convert path arcs to cubics"); }}>Convert arcs to editable curves</button>}
              <div className="path-topology-row">
                <label>
                  <span>Cut anchor</span>
                  <input
                    aria-label="Path split anchor"
                    type="number"
                    min={pathSplitMinimum}
                    max={Math.max(pathSplitMinimum, pathSplitMaximum)}
                    value={selectedSplitNode}
                    disabled={pathSplitMaximum < pathSplitMinimum}
                    onChange={(event) => setPathSplitNode(Number(event.target.value))}
                  />
                  <small>of {Math.max(0, pathNodeCount - 1)}</small>
                </label>
                <button
                  disabled={pathSplitMaximum < pathSplitMinimum}
                  onClick={() => void splitSelectedPath()}
                >
                  {object.closed ? "Cut open" : "Split path"}
                </button>
                {pathObjects.length === 2 && (
                  <button onClick={() => void joinSelectedPaths()}>
                    Join nearest ends
                  </button>
                )}
              </div>
              <small>
                Node tool: Alt-click curve to add · Ctrl-click node to delete · double-click to smooth/corner · Shift-drag handle to mirror. Joining retains the most recently selected path's style.
              </small>
            </div>
          )}
          <div className="section-heading">
            <span>Materials</span>
            <small>Editable stack</small>
          </div>
          <button
            className="material-preset-button"
            onClick={() => void applyPolishedGold()}
          >
            <span className="material-swatch gold" />
            <span>
              <strong>Polished Gold</strong>
              <small>Masked bands · sheen · rim · depth</small>
            </span>
            <Sparkles size={14} />
          </button>
        </>
      )}
      {objects.length === 2 && (
        <>
          <div className="section-heading">
            <span>Path boolean</span>
          </div>
          <div className="boolean-grid">
            {(["union", "subtract", "intersect", "exclude"] as const).map(
              (mode) => (
                <button key={mode} onClick={() => void boolean(mode)}>
                  {mode}
                </button>
              ),
            )}
          </div>
        </>
      )}
      <label className="field">
        <span>Object mask</span>
        <select
          value={object.maskObjectId ?? ""}
          onChange={(event) =>
            replace(
              { ...object, maskObjectId: event.target.value || undefined },
              "Set object mask",
            )
          }
        >
          <option value="">None</option>
          {maskCandidates.map((entry) => (
              <option value={entry.id} key={entry.id}>
                {entry.name}
              </option>
            ))}
        </select>
      </label>
      <div className="mask-actions">
        {selectionMask && <button onClick={() => { const targets = objects.slice(0, -1); const operations: CanvasOperation[] = targets.map((entry) => ({ kind: "illustration.object.replace", object: { ...entry, maskObjectId: selectionMask.id }, expectedRevision: entry.revision })); operations.push({ kind: "illustration.object.replace", object: { ...selectionMask, visible: false }, expectedRevision: selectionMask.revision }); void (async () => { if (await apply("Mask selected objects", operations)) setSelected(targets.map((entry) => entry.id)); })(); }}><Layers3 size={12} /> Use top object as mask</button>}
        {objects.some((entry) => entry.maskObjectId) && <button onClick={() => void apply("Clear object masks", objects.filter((entry) => entry.maskObjectId).map((entry) => ({ kind: "illustration.object.replace", object: { ...entry, maskObjectId: undefined }, expectedRevision: entry.revision })))}>Clear selected masks</button>}
      </div>
      <div className="section-heading">
        <span>Appearance</span>
      </div>
      <label className="field">
        <span>Object blur · {Math.round(object.blur ?? 0)} px</span>
        <input
          type="range"
          min="0"
          max="40"
          step="0.25"
          value={object.blur ?? 0}
          onChange={(event) =>
            replace(
              { ...object, blur: Math.max(0, Number(event.target.value)) },
              "Change object blur",
            )
          }
        />
      </label>
      <div className="section-heading">
        <span>Shadow</span>
      </div>
      <div className="transform-grid">
        <label>
          <span>Blur</span>
          <input
            key={`${object.id}:shadow-blur`}
            type="number"
            min="0"
            defaultValue={object.shadow?.blur ?? 0}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  shadow: {
                    color: object.shadow?.color ?? "#00000055",
                    blur: Math.max(0, Number(event.target.value)),
                    offsetX: object.shadow?.offsetX ?? 0,
                    offsetY: object.shadow?.offsetY ?? 4,
                  },
                },
                "Change shadow",
              )
            }
          />
        </label>
        <label>
          <span>Offset Y</span>
          <input
            key={`${object.id}:shadow-offset-y`}
            type="number"
            defaultValue={object.shadow?.offsetY ?? 4}
            onBlur={(event) =>
              replace(
                {
                  ...object,
                  shadow: {
                    color: object.shadow?.color ?? "#00000055",
                    blur: object.shadow?.blur ?? 8,
                    offsetX: object.shadow?.offsetX ?? 0,
                    offsetY: Number(event.target.value),
                  },
                },
                "Change shadow",
              )
            }
          />
        </label>
      </div>
      <ObjectFilterStack object={object} onReplace={replace} />
      {object.type === "text" && (
        <TextInspector key={`${object.id}:${object.revision}:text`} object={object} onReplace={replace} />
      )}
      {object.type === "image" && (
        <>
          <ImageCropFields
            key={`${object.id}:${object.revision}:crop-fields`}
            object={object}
            onApply={(next) => replace(next, "Set numeric image crop")}
          />
          <button
            className="crop-button"
            onClick={() =>
              replace(
                object.crop ? resetImageCrop(object) : cropImageToAspect(object, 1),
                object.crop ? "Reset image crop" : "Square crop image",
              )
            }
          >
            {object.crop ? "Reset to full image" : "Square crop"}
          </button>
          <div className="crop-aspect-grid">
            {[{ label: "1:1", value: 1 }, { label: "4:3", value: 4 / 3 }, { label: "3:2", value: 3 / 2 }, { label: "16:9", value: 16 / 9 }].map((preset) => <button key={preset.label} onClick={() => replace(cropImageToAspect(object, preset.value), `Crop image ${preset.label}`)}>{preset.label}</button>)}
          </div>
          <small className="crop-summary">{object.crop ? `Source crop ${object.crop.x.toFixed(1)}, ${object.crop.y.toFixed(1)} · ${object.crop.width.toFixed(1)} × ${object.crop.height.toFixed(1)} px` : `Full source ${object.sourceWidth ?? object.width} × ${object.sourceHeight ?? object.height} px`} · drag on canvas with Crop; hold Shift to preserve the current aspect.</small>
        </>
      )}
    </div>
  );
}

function PixelCanvasSizeEditor({
  sprite,
  onResize,
}: {
  sprite: PixelSprite;
  onResize: (width: number, height: number) => void;
}) {
  const [width, setWidth] = useState(String(sprite.width));
  const [height, setHeight] = useState(String(sprite.height));
  const nextWidth = pixelDimension(width, sprite.width);
  const nextHeight = pixelDimension(height, sprite.height);
  const unchanged = nextWidth === sprite.width && nextHeight === sprite.height;

  return (
    <div className="pixel-size-editor">
      <div className="section-heading">
        <span>Sprite canvas</span>
        <small>Top-left anchor</small>
      </div>
      <div className="pixel-size-fields">
        <label>
          <span>Width</span>
          <input
            aria-label="Sprite canvas width"
            type="number"
            min="1"
            max="8192"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
        </label>
        <span>×</span>
        <label>
          <span>Height</span>
          <input
            aria-label="Sprite canvas height"
            type="number"
            min="1"
            max="8192"
            value={height}
            onChange={(event) => setHeight(event.target.value)}
          />
        </label>
        <button
          disabled={unchanged}
          onClick={() => {
            setWidth(String(nextWidth));
            setHeight(String(nextHeight));
            onResize(nextWidth, nextHeight);
          }}
        >
          Resize
        </button>
      </div>
      <small className="pixel-size-note">
        Shrinking crops pixels outside the new canvas. Undo restores them.
      </small>
    </div>
  );
}

function TilemapLayerOffsetEditor({
  layer,
  onApply,
  onInvalid,
}: {
  layer: TilemapLayer;
  onApply: (offsetX: number, offsetY: number) => void;
  onInvalid: () => void;
}) {
  const [x, setX] = useState(String(layer.offsetX));
  const [y, setY] = useState(String(layer.offsetY));
  const integer = /^-?\d+$/;
  const nextX = integer.test(x.trim()) ? Number(x) : Number.NaN;
  const nextY = integer.test(y.trim()) ? Number(y) : Number.NaN;
  const valid = [nextX, nextY].every((value) => Number.isSafeInteger(value) && Math.abs(value) <= MAX_TILEMAP_LAYER_OFFSET);
  const canonicalDraft = x === String(layer.offsetX) && y === String(layer.offsetY);
  const applyDraft = () => {
    if (!valid) { onInvalid(); return; }
    if (nextX === layer.offsetX && nextY === layer.offsetY) { setX(String(layer.offsetX)); setY(String(layer.offsetY)); return; }
    onApply(nextX, nextY);
  };
  return <div className="tilemap-layer-offset-editor">
    <div className="two-fields">
      <label className="field"><span>Layer offset X</span><input aria-label="Layer drawing offset X" type="number" step="1" min={-MAX_TILEMAP_LAYER_OFFSET} max={MAX_TILEMAP_LAYER_OFFSET} value={x} onChange={(event) => setX(event.target.value)} /></label>
      <label className="field"><span>Layer offset Y</span><input aria-label="Layer drawing offset Y" type="number" step="1" min={-MAX_TILEMAP_LAYER_OFFSET} max={MAX_TILEMAP_LAYER_OFFSET} value={y} onChange={(event) => setY(event.target.value)} /></label>
    </div>
    <div className="tileset-actions"><button type="button" disabled={canonicalDraft} onClick={applyDraft}>Apply layer offset</button></div>
    <small>Signed map pixels · +X right · +Y down. Group offsets add to their descendants.</small>
  </div>;
}

function PixelLayers({ document }: { document: PixelDocument }) {
  const asset = document.pixelAssets[document.activeAssetId];
  const selected = useEditorStore((state) => state.selectedEntityId);
  const setSelected = useEditorStore((state) => state.setSelectedEntity);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const [mapPropertyName, setMapPropertyName] = useState("");
  const [mapPropertyValue, setMapPropertyValue] = useState("");
  const [mapObjectType, setMapObjectType] = useState<"rectangle" | "ellipse" | "polygon" | "polyline">("rectangle");
  const [collapsedLayerIds, setCollapsedLayerIds] = useState<Set<string>>(() => new Set());
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  if (!asset) return <div className="empty-panel">No active pixel asset.</div>;
  const layers =
    asset.type === "sprite"
      ? Object.values(asset.layers ?? {})
      : asset.type === "tilemap"
        ? Object.values(asset.layers ?? {})
        : [];
  const layerTable = Object.fromEntries(layers.map((layer) => [layer.id, layer]));
  const flattenedLayers = asset.type === "sprite" || asset.type === "tilemap" ? flattenLayerTree(layerTable, asset.layerIds, collapsedLayerIds) : [];
  const updateAsset = (next: typeof asset, label: string) =>
    void apply(label, [
      {
        kind: "pixel.asset.replace",
        asset: next,
        expectedRevision: asset.revision,
      },
    ]);
  const updateLayer = (
    layer: PixelLayer | TilemapLayer,
    patch: Partial<PixelLayer | TilemapLayer>,
    label: string,
  ) => {
    const next = structuredClone(asset);
    if (next.type === "sprite" && layer.id in next.layers)
      next.layers[layer.id] = {
        ...next.layers[layer.id],
        ...patch,
      } as PixelLayer;
    if (next.type === "tilemap" && layer.id in next.layers)
      next.layers[layer.id] = {
        ...next.layers[layer.id],
        ...patch,
      } as TilemapLayer;
    updateAsset(next, label);
  };
  const removeLayer = (layer: PixelLayer | TilemapLayer) => {
    const removing = new Set<string>();
    const collect = (id: string) => {
      removing.add(id);
      for (const childId of (asset.type === "sprite"
        ? asset.layers[id]?.childIds
        : asset.type === "tilemap"
          ? asset.layers[id]?.childIds
          : []) ?? [])
        collect(childId);
    };
    collect(layer.id);
    const editableLayers = layers.filter(
      (entry) => entry.type === "pixel" || entry.type === "tile",
    );
    if (editableLayers.every((entry) => removing.has(entry.id))) {
      notify(
        "This asset must keep at least one editable pixel or tile layer.",
        "warning",
      );
      return;
    }
    const next = structuredClone(asset);
    if (next.type === "sprite") {
      for (const id of removing) delete next.layers[id];
      next.layerIds = next.layerIds.filter((id) => !removing.has(id));
      for (const [celId, cel] of Object.entries(next.cels ?? {}))
        if (removing.has(cel.layerId)) delete next.cels[celId];
      for (const current of Object.values(next.layers ?? {}))
        if (current.childIds)
          current.childIds = current.childIds.filter((id) => !removing.has(id));
    } else if (next.type === "tilemap") {
      for (const id of removing) delete next.layers[id];
      next.layerIds = next.layerIds.filter((id) => !removing.has(id));
      for (const current of Object.values(next.layers))
        if (current.childIds)
          current.childIds = current.childIds.filter((id) => !removing.has(id));
    }
    updateAsset(next, `Delete ${layer.name}`);
    if (selected === layer.id) setSelected(undefined);
  };
  const moveLayer = (layer: PixelLayer | TilemapLayer, parentId?: string, index?: number) => {
    const next = structuredClone(asset);
    if (next.type !== "sprite" && next.type !== "tilemap") return;
    const moved = moveLayerTreeEntry(next.layers as Record<string, PixelLayer | TilemapLayer>, next.layerIds, layer.id, parentId, index);
    next.layers = moved.entries as typeof next.layers; next.layerIds = moved.rootIds;
    updateAsset(next, "Move layer");
  };
  const descendants = (id: string): Set<string> => layerTreeDescendants(layerTable, id);
  const dropLayer = (event: React.DragEvent<HTMLDivElement>, target: PixelLayer | TilemapLayer) => {
    event.preventDefault(); const source = draggedLayerId ? layerTable[draggedLayerId] : undefined; setDraggedLayerId(undefined); if (!source || source.id === target.id) return;
    if (event.altKey && target.type === "group") { moveLayer(source, target.id); setCollapsedLayerIds((current) => { const next = new Set(current); next.delete(target.id); return next; }); return; }
    const siblings = target.parentId ? layerTable[target.parentId]?.childIds ?? [] : asset.type === "sprite" || asset.type === "tilemap" ? asset.layerIds : []; const targetIndex = siblings.indexOf(target.id); const sourceIndex = siblings.indexOf(source.id); const adjustedTarget = sourceIndex >= 0 && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex; const bounds = event.currentTarget.getBoundingClientRect(); const visuallyAbove = event.clientY < bounds.top + bounds.height / 2; moveLayer(source, target.parentId, Math.max(0, adjustedTarget + (visuallyAbove ? 1 : 0)));
  };
  const selectedLayer = layers.find((layer) => layer.id === selected) ?? (asset.type === "tilemap" ? layers.find((layer) => layer.type === "object" && layer.objects?.some((object) => object.id === selected)) : undefined);
  const selectedTileObject = asset.type === "tilemap" && selectedLayer?.type === "object"
    ? selectedLayer.objects?.find((object): object is TileMapObject => object.id === selected && object.type === "tile")
    : undefined;
  const tileObjectLayerError = asset.type === "tilemap" && selectedLayer?.type === "object" ? (() => {
    try { requireWritableTileObjectLayer(asset, selectedLayer.id); return undefined; }
    catch (error) { return error instanceof Error ? error.message : "This object layer is not writable."; }
  })() : undefined;
  const tileObjectIdentity = asset.type === "tilemap" && selectedTileObject ? (() => {
    const decoded = decodeTiledGid(selectedTileObject.gid);
    const resolved = resolveTilesetForGid(document, asset, decoded.gid);
    if (!resolved) return `Unresolved raw GID ${selectedTileObject.gid}`;
    const flags = [decoded.diagonal && "D", decoded.hFlip && "H", decoded.vFlip && "V"].filter(Boolean).join("+") || "ordinary";
    return `${resolved.tileset.name} · tile ${resolved.localId} · ${flags}`;
  })() : "";
  const replaceTileObject = (object: TileMapObject, label: string) => {
    if (asset.type !== "tilemap" || selectedLayer?.type !== "object") return;
    let current: TileMapObject;
    try { current = requireWritableTileObject(asset, selectedLayer.id, object.id); }
    catch (error) { notify(error instanceof Error ? error.message : "This object layer is not writable.", "warning"); return; }
    if (object.gid !== current.gid || object.type !== current.type) { notify("Tile-object identity changed before the edit; re-select it and try again.", "warning"); return; }
    const next = structuredClone(asset); const layer = next.layers[selectedLayer.id];
    if (layer?.type !== "object") { notify("That tile-object layer no longer exists. Re-select it and try again.", "warning"); return; }
    layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry);
    updateAsset(next, label);
  };
  const deleteMapObject = (object: MapObject, objectIndex: number) => {
    if (asset.type !== "tilemap" || selectedLayer?.type !== "object") return;
    if (object.type === "tile") {
      try { requireWritableTileObject(asset, selectedLayer.id, object.id); }
      catch (error) { notify(error instanceof Error ? error.message : "This tile object is not writable.", "warning"); return; }
    }
    updateLayer(selectedLayer, { objects: selectedLayer.objects!.filter((_, index) => index !== objectIndex) }, "Delete map object");
    if (selected === object.id) setSelected(selectedLayer.id);
  };
  if (asset.type === "tileset")
    return <TilesetPanel document={document} tileset={asset} />;
  return (
    <>
      <div className="asset-heading">
        <span className={`asset-kind ${asset.type}`}>
          <Grid3X3 size={15} />
        </span>
        <span>
          <strong>{asset.name}</strong>
          <small>{asset.type}</small>
        </span>
      </div>
      {asset.type === "sprite" && (
        <PixelCanvasSizeEditor
          key={`${asset.id}:${asset.width}:${asset.height}`}
          sprite={asset}
          onResize={(width, height) =>
            updateAsset(
              resizePixelSpriteCanvas(asset, width, height),
              "Resize sprite canvas",
            )
          }
        />
      )}
      {asset.type === "tilemap" && <div className="tilemap-settings">
        <div className="section-heading"><span>Map geometry</span><small>{asset.infinite ? "Sparse infinite chunks" : "Finite bounds"}</small></div>
        <div className="tilemap-setting-grid">
          <label className="field"><span>Width</span><input key={"map-width-" + asset.width} type="number" min="1" max="1048576" defaultValue={asset.width} onBlur={(event) => { const width = Math.max(1, Math.round(Number(event.target.value))); if (width !== asset.width) updateAsset({ ...asset, width }, "Resize tilemap width"); }} /></label>
          <label className="field"><span>Height</span><input key={"map-height-" + asset.height} type="number" min="1" max="1048576" defaultValue={asset.height} onBlur={(event) => { const height = Math.max(1, Math.round(Number(event.target.value))); if (height !== asset.height) updateAsset({ ...asset, height }, "Resize tilemap height"); }} /></label>
          <label className="field"><span>Tile width</span><input key={"map-tile-width-" + asset.tileWidth} type="number" min="1" max="1024" defaultValue={asset.tileWidth} onBlur={(event) => { const tileWidth = Math.max(1, Math.round(Number(event.target.value))); if (tileWidth !== asset.tileWidth) updateAsset({ ...asset, tileWidth }, "Change map tile width"); }} /></label>
          <label className="field"><span>Tile height</span><input key={"map-tile-height-" + asset.tileHeight} type="number" min="1" max="1024" defaultValue={asset.tileHeight} onBlur={(event) => { const tileHeight = Math.max(1, Math.round(Number(event.target.value))); if (tileHeight !== asset.tileHeight) updateAsset({ ...asset, tileHeight }, "Change map tile height"); }} /></label>
          <label className="field"><span>Orientation</span><select value={asset.orientation} onChange={(event) => updateAsset({ ...asset, orientation: event.target.value as typeof asset.orientation }, "Change map orientation")}><option value="orthogonal">Orthogonal</option><option value="isometric">Isometric</option></select></label>
          <label className="map-infinite-toggle"><input type="checkbox" checked={asset.infinite} onChange={(event) => updateAsset({ ...asset, infinite: event.target.checked }, event.target.checked ? "Enable infinite map" : "Use finite map")} /><span>Infinite 32×32 chunks</span></label>
        </div>
        <div className="section-heading"><span>Map properties</span></div>
        <div className="tile-property-add"><input aria-label="Map property name" placeholder="name" value={mapPropertyName} onChange={(event) => setMapPropertyName(event.target.value)} /><input aria-label="Map property value" placeholder="value" value={mapPropertyValue} onChange={(event) => setMapPropertyValue(event.target.value)} /><button disabled={!mapPropertyName.trim()} onClick={() => { const value = mapPropertyValue === "true" ? true : mapPropertyValue === "false" ? false : mapPropertyValue.trim() !== "" && Number.isFinite(Number(mapPropertyValue)) ? Number(mapPropertyValue) : mapPropertyValue; updateAsset({ ...asset, properties: { ...asset.properties, [mapPropertyName.trim()]: value } }, "Set map property"); setMapPropertyName(""); setMapPropertyValue(""); }}>Add</button></div>
        <div className="tile-property-list">{Object.entries(asset.properties).map(([key, value]) => <span key={key}><strong>{key}</strong> = {String(value)}<button onClick={() => { const properties = { ...asset.properties }; delete properties[key]; updateAsset({ ...asset, properties }, "Delete map property"); }}>×</button></span>)}</div>
      </div>}
      <div className="panel-list layer-list">
        {flattenedLayers.map(({ entry: layer, depth }) => (
          <div
            key={layer.id}
            className={`layer-row ${selectedLayer?.id === layer.id ? "is-selected" : ""}`}
            style={{ marginLeft: depth * 14 }}
            draggable
            onDragStart={() => setDraggedLayerId(layer.id)}
            onDragEnd={() => setDraggedLayerId(undefined)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropLayer(event, layer)}
          >
            {layer.type === "group" ? <button className="layer-collapse" title={collapsedLayerIds.has(layer.id) ? "Expand group" : "Collapse group"} onClick={() => setCollapsedLayerIds((current) => { const next = new Set(current); if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id); return next; })}>{collapsedLayerIds.has(layer.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button> : <span className="layer-collapse-placeholder" />}
            <button
              className="layer-main"
              onClick={() => setSelected(layer.id)}
            >
              <span className="layer-thumbnail pixel">
                <Grid3X3 size={15} />
              </span>
              <span className="layer-copy">
                <strong>{layer.name}</strong>
                <small>{layer.type}</small>
              </span>
              <span className="layer-opacity">
                {Math.round(layer.opacity * 100)}%
              </span>
            </button>
            <div className="layer-quick-actions">
              <button
                title={layer.visible ? "Hide layer" : "Show layer"}
                onClick={() =>
                  updateLayer(
                    layer,
                    { visible: !layer.visible },
                    layer.visible ? "Hide layer" : "Show layer",
                  )
                }
              >
                {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                title={layer.locked ? "Unlock layer" : "Lock layer"}
                onClick={() =>
                  updateLayer(
                    layer,
                    { locked: !layer.locked },
                    layer.locked ? "Unlock layer" : "Lock layer",
                  )
                }
              >
                {layer.locked ? <Lock size={12} /> : <Unlock size={12} />}
              </button>
              <button
                title="Delete layer"
                disabled={layers.length <= 1}
                onClick={() => removeLayer(layer)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {selectedLayer && (
        <div className="layer-inspector">
          <label className="field">
            <span>Name</span>
            <input
              key={`${selectedLayer.id}:${selectedLayer.name}`}
              defaultValue={selectedLayer.name}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== selectedLayer.name)
                  updateLayer(selectedLayer, { name }, "Rename layer");
              }}
            />
          </label>
          <label className="field">
            <span>Group</span>
            <select
              value={selectedLayer.parentId ?? ""}
              onChange={(event) =>
                moveLayer(selectedLayer, event.target.value || undefined)
              }
            >
              <option value="">Root</option>
              {layers
                .filter(
                  (entry) =>
                    entry.type === "group" &&
                    entry.id !== selectedLayer.id &&
                    !descendants(selectedLayer.id).has(entry.id),
                )
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Opacity · {Math.round(selectedLayer.opacity * 100)}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(selectedLayer.opacity * 100)}
              onChange={(event) =>
                updateLayer(
                  selectedLayer,
                  { opacity: Number(event.target.value) / 100 },
                  "Change layer opacity",
                )
              }
            />
          </label>
          {"blendMode" in selectedLayer && (
            <label className="field">
              <span>Blend mode</span>
              <select
                value={selectedLayer.blendMode}
                onChange={(event) =>
                  updateLayer(
                    selectedLayer,
                    {
                      blendMode: event.target.value as PixelLayer["blendMode"],
                    },
                    "Change blend mode",
                  )
                }
              >
                <option value="normal">Normal</option>
                <option value="multiply">Multiply</option>
                <option value="screen">Screen</option>
                <option value="overlay">Overlay</option>
                <option value="difference">Difference</option>
              </select>
            </label>
          )}
          {"offsetX" in selectedLayer && <TilemapLayerOffsetEditor
            key={`${selectedLayer.id}:${selectedLayer.revision}:${selectedLayer.offsetX}:${selectedLayer.offsetY}`}
            layer={selectedLayer}
            onApply={(offsetX, offsetY) => updateLayer(selectedLayer, { offsetX, offsetY }, "Change layer drawing offset")}
            onInvalid={() => notify(`Layer drawing offsets must be whole map pixels from −${MAX_TILEMAP_LAYER_OFFSET.toLocaleString("en-US")} to ${MAX_TILEMAP_LAYER_OFFSET.toLocaleString("en-US")}.`, "warning")}
          />}
          {"parallaxX" in selectedLayer && <div className="two-fields"><label className="field"><span>Parallax X</span><input type="number" step="0.1" value={selectedLayer.parallaxX} onChange={(event) => updateLayer(selectedLayer, { parallaxX: Number(event.target.value) }, "Change layer parallax")} /></label><label className="field"><span>Parallax Y</span><input type="number" step="0.1" value={selectedLayer.parallaxY} onChange={(event) => updateLayer(selectedLayer, { parallaxY: Number(event.target.value) }, "Change layer parallax")} /></label></div>}
          {selectedLayer.type === "object" && asset.type === "tilemap" && <div className="map-object-editor">
            <div className="section-heading"><span>Map objects</span><small>{selectedLayer.objects?.length ?? 0}</small></div>
            <div className="tileset-actions"><select value={mapObjectType} onChange={(event) => setMapObjectType(event.target.value as typeof mapObjectType)}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="polyline">Polyline</option></select><button onClick={() => { const points = mapObjectType === "polygon" || mapObjectType === "polyline" ? [{ x: 0, y: 0 }, { x: asset.tileWidth, y: 0 }, { x: asset.tileWidth, y: asset.tileHeight }, { x: 0, y: asset.tileHeight }] : undefined; updateLayer(selectedLayer, { objects: [...(selectedLayer.objects ?? []), { id: createId("map-object"), type: mapObjectType, x: 0, y: 0, width: asset.tileWidth, height: asset.tileHeight, points, properties: {} }] }, "Add map object"); }}>+ Object</button></div>
            <div className="collision-list">{(selectedLayer.objects ?? []).map((object, objectIndex) => <div className={"collision-row map-object-row " + (selected === object.id ? "is-selected" : "")} key={object.id} onClick={() => setSelected(object.id)}>{object.type === "tile" ? <><span className="tile-object-row-kind" title={`Fixed tile object GID ${object.gid}`}>Tile</span><span className="tile-object-row-summary">{object.name || `GID ${object.gid}`}</span></> : <><select value={object.type} onChange={(event) => { const type = event.target.value as "rectangle" | "ellipse" | "polygon" | "polyline"; updateLayer(selectedLayer, { objects: selectedLayer.objects!.map((entry) => entry.id === object.id && entry.type !== "tile" ? { ...entry, type } : entry) }, "Change map object type"); }}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="polyline">Polyline</option></select><input aria-label={"Object x " + (objectIndex + 1)} type="number" value={object.x} onChange={(event) => updateLayer(selectedLayer, { objects: selectedLayer.objects!.map((entry, index) => index === objectIndex ? { ...entry, x: Number(event.target.value) } : entry) }, "Move map object")} /><input aria-label={"Object y " + (objectIndex + 1)} type="number" value={object.y} onChange={(event) => updateLayer(selectedLayer, { objects: selectedLayer.objects!.map((entry, index) => index === objectIndex ? { ...entry, y: Number(event.target.value) } : entry) }, "Move map object")} /><input aria-label={"Object width " + (objectIndex + 1)} type="number" value={object.width ?? 0} onChange={(event) => updateLayer(selectedLayer, { objects: selectedLayer.objects!.map((entry, index) => index === objectIndex ? { ...entry, width: Math.max(1, Number(event.target.value)) } : entry) }, "Resize map object")} /><input aria-label={"Object height " + (objectIndex + 1)} type="number" value={object.height ?? 0} onChange={(event) => updateLayer(selectedLayer, { objects: selectedLayer.objects!.map((entry, index) => index === objectIndex ? { ...entry, height: Math.max(1, Number(event.target.value)) } : entry) }, "Resize map object")} /></>}<button title="Delete map object" disabled={object.type === "tile" && Boolean(tileObjectLayerError)} onClick={(event) => { event.stopPropagation(); deleteMapObject(object, objectIndex); }}><Trash2 size={11} /></button></div>)}</div>
            {selectedTileObject && <TileMapObjectInspector
              key={`${asset.id}:${asset.revision}:${selectedLayer.id}:${selectedTileObject.id}`}
              object={selectedTileObject}
              identity={tileObjectIdentity}
              disabled={Boolean(tileObjectLayerError)}
              onReplace={replaceTileObject}
              onInvalid={(message) => notify(message, "warning")}
            />}
            {selectedTileObject && tileObjectLayerError && <p className="tile-object-write-warning" role="status">{tileObjectLayerError}</p>}
          </div>}
        </div>
      )}
    </>
  );
}

function TilesetPanel({
  document,
  tileset,
}: {
  document: PixelDocument;
  tileset: PixelTileset;
}) {
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const [selectedTileId, setSelectedTileId] = useState(0);
  const [collisionType, setCollisionType] = useState<"rectangle" | "ellipse" | "polygon" | "polyline">("rectangle");
  const [selectedCollisionIds, setSelectedCollisionIds] = useState<string[]>([]);
  const [collisionPropertyName, setCollisionPropertyName] = useState("");
  const [collisionPropertyValue, setCollisionPropertyValue] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [propertyValue, setPropertyValue] = useState("");
  const [selectedWangSetId, setSelectedWangSetId] = useState<string>();
  const [drawingOffsetDraft, setDrawingOffsetDraft] = useState<{ tilesetId: string; revision: number; x: string; y: string }>();
  const replace = (next: PixelTileset, label: string) =>
    void apply(label, [
      {
        kind: "pixel.asset.replace",
        asset: next,
        expectedRevision: tileset.revision,
      },
    ]);
  const sourceSprite = document.pixelAssets[tileset.spriteAssetId];
  const tileCount = tileset.columns * tileset.rows;
  const selectedTile = tileset.tiles[selectedTileId] ?? {
    id: selectedTileId,
    sourceX: tileset.margin + selectedTileId % tileset.columns * (tileset.tileWidth + tileset.spacing),
    sourceY: tileset.margin + Math.floor(selectedTileId / tileset.columns) * (tileset.tileHeight + tileset.spacing),
    probability: 1,
    animation: [],
    collisions: [],
    properties: {},
  };
  const selectedVariantGroup = tileVariantGroup(selectedTile);
  const selectedVariantCandidates = tileVariantCandidates(tileset, selectedTileId);
  const selectedCollisionSet = new Set(selectedCollisionIds);
  const selectedCollisions = selectedTile.collisions.filter((shape) => selectedCollisionSet.has(shape.id));
  const selectedCollision = selectedCollisions.length === 1 ? selectedCollisions[0] : undefined;
  const updateTile = (patch: Partial<typeof selectedTile>, label: string) => {
    const next = structuredClone(tileset);
    next.tiles[selectedTileId] = { ...structuredClone(selectedTile), ...patch };
    replace(next, label);
  };
  const currentDrawingOffsetDraft = drawingOffsetDraft?.tilesetId === tileset.id && drawingOffsetDraft.revision === tileset.revision
    ? drawingOffsetDraft
    : { tilesetId: tileset.id, revision: tileset.revision, x: String(tileset.tileOffset.x), y: String(tileset.tileOffset.y) };
  const parsedDrawingOffset = { x: Number(currentDrawingOffsetDraft.x), y: Number(currentDrawingOffsetDraft.y) };
  const drawingOffsetDraftIsValid = [currentDrawingOffsetDraft.x, currentDrawingOffsetDraft.y].every((value) => value.trim())
    && [parsedDrawingOffset.x, parsedDrawingOffset.y].every((value) => Number.isInteger(value) && Math.abs(value) <= MAX_TILESET_DRAWING_OFFSET);
  const drawingOffsetDraftMatchesTileset = drawingOffsetDraftIsValid
    && parsedDrawingOffset.x === tileset.tileOffset.x
    && parsedDrawingOffset.y === tileset.tileOffset.y;
  const applyDrawingOffset = () => {
    const { x, y } = parsedDrawingOffset;
    if (!drawingOffsetDraftIsValid) {
      notify(`Tileset drawing offsets must be whole pixels from −${MAX_TILESET_DRAWING_OFFSET.toLocaleString("en-US")} to ${MAX_TILESET_DRAWING_OFFSET.toLocaleString("en-US")}.`, "warning");
      return;
    }
    if (drawingOffsetDraftMatchesTileset) {
      setDrawingOffsetDraft(undefined);
      return;
    }
    setDrawingOffsetDraft(undefined);
    replace({ ...tileset, tileOffset: { x, y } }, "Change tileset drawing offset");
  };
  const addTerrain = () => {
    const terrainId = tileset.wangSets.length + 1;
    const wangSet: WangSet = {
      id: createId("wang"),
      name: `Terrain ${terrainId}`,
      type: "mixed",
      colors: [
        {
          id: terrainId,
          name: `Terrain ${terrainId}`,
          color:
            document.palette[
              Math.min(terrainId + 3, document.palette.length - 1)
            ]?.color ?? "#ff6b7a",
          tileId: 0,
          probability: 1,
        },
      ],
      tiles: [
        {
          tileId: 0,
          wangId: [
            terrainId,
            terrainId,
            terrainId,
            terrainId,
            terrainId,
            terrainId,
            terrainId,
            terrainId,
          ],
        },
      ],
    };
    replace(upsertWangSet(tileset, wangSet), "Add Wang terrain");
    setSelectedWangSetId(wangSet.id);
  };
  const addCollision = () => {
    const shape = {
      id: createId("collision"),
      type: collisionType,
      x: 0,
      y: 0,
      width: tileset.tileWidth,
      height: tileset.tileHeight,
      properties: {},
      ...((collisionType === "polygon" || collisionType === "polyline") ? { points: [{ x: 0, y: 0 }, { x: tileset.tileWidth, y: 0 }, { x: tileset.tileWidth, y: tileset.tileHeight }, { x: 0, y: tileset.tileHeight }] } : {}),
    } as (typeof selectedTile)["collisions"][number];
    updateTile({ collisions: [...selectedTile.collisions, shape] }, "Add tile collision");
    setSelectedCollisionIds([shape.id]);
  };
  const activeWangSet = tileset.wangSets.find((set) => set.id === selectedWangSetId) ?? tileset.wangSets[0];
  const updateWangSet = (nextSet: WangSet, label: string) => {
    replace(upsertWangSet(tileset, nextSet), label);
  };
  const addWangColor = () => {
    if (!activeWangSet) return;
    const colorId = Math.max(0, ...activeWangSet.colors.map((color) => color.id)) + 1;
    replace(upsertWangColor(tileset, activeWangSet.id, { id: colorId, name: "Terrain " + colorId, color: document.palette[Math.min(colorId + 3, document.palette.length - 1)]?.color ?? "#ff6b7a", tileId: selectedTileId, probability: 1 }), "Add Wang color");
  };
  const assignWangSlot = (slot: number, colorId: number) => {
    if (!activeWangSet) return;
    const existing = activeWangSet.tiles.find((tile) => tile.tileId === selectedTileId);
    const wangId = [...(existing?.wangId ?? [0, 0, 0, 0, 0, 0, 0, 0])] as WangSet["tiles"][number]["wangId"];
    wangId[slot] = colorId;
    replace(assignWangTile(tileset, activeWangSet.id, { tileId: selectedTileId, wangId }), "Assign Wang terrain slot");
  };
  return (
    <div className="tileset-panel">
      <div className="asset-heading">
        <span className="asset-kind tileset">
          <Grid3X3 size={15} />
        </span>
        <span>
          <strong>{tileset.name}</strong>
          <small>
            {tileset.columns} × {tileset.rows} · {tileset.tileWidth} ×{" "}
            {tileset.tileHeight}px
          </small>
        </span>
      </div>
      <TilesetSliceEditor key={`${tileset.id}:${tileset.revision}`} palette={document.palette} tileset={tileset} sourceSprite={sourceSprite?.type === "sprite" ? sourceSprite : undefined} selectedTileId={selectedTileId} onCommit={(next, nextSelectedTileId, impact) => {
        const droppedEntries = impact.droppedAnimationFrames + impact.droppedCollisionShapes + impact.droppedCustomProperties + impact.droppedWangColors + impact.droppedWangTiles;
        if (impact.droppedMetadataTiles > 0 || droppedEntries > 0) notify(`Re-sliced after explicit review; ${impact.droppedMetadataTiles} metadata-addressed tile${impact.droppedMetadataTiles === 1 ? "" : "s"} and ${droppedEntries} metadata entr${droppedEntries === 1 ? "y" : "ies"} no longer fit.`, "warning");
        replace(next, "Re-slice tileset");
        setSelectedTileId(nextSelectedTileId);
        setSelectedCollisionIds([]);
      }} />
      <div className="section-heading"><span>Tiles</span><small>Select one to edit metadata</small></div>
      <div className="tile-definition-grid">{Array.from({ length: Math.min(tileCount, 256) }, (_, id) => <button key={id} className={selectedTileId === id ? "is-active" : ""} onClick={() => { setSelectedTileId(id); setSelectedCollisionIds([]); }}>{id}</button>)}</div>
      {tileCount > 256 && <small className="tileset-slice-summary">Showing the first 256 of {tileCount} tiles.</small>}
      <div className="tile-definition-editor">
        <div className="section-heading"><span>Tile {selectedTileId}</span><small>{selectedTile.sourceX}, {selectedTile.sourceY}</small></div>
        <label className="field"><span>Painting probability</span><input key={"probability-" + selectedTileId + "-" + selectedTile.probability} type="number" min="0" step="0.05" defaultValue={selectedTile.probability} onBlur={(event) => updateTile({ probability: Math.max(0, Number(event.target.value) || 0) }, "Change tile probability")} /></label>
        <label className="field"><span>Random variant group</span><input key={"variant-" + selectedTileId + "-" + String(selectedTile.properties[TILE_VARIANT_GROUP_PROPERTY] ?? "")} maxLength={100} defaultValue={String(selectedTile.properties[TILE_VARIANT_GROUP_PROPERTY] ?? "")} placeholder="e.g. grass" onBlur={(event) => { const properties = { ...selectedTile.properties }; const group = event.target.value.trim(); if (group) properties[TILE_VARIANT_GROUP_PROPERTY] = group; else delete properties[TILE_VARIANT_GROUP_PROPERTY]; updateTile({ properties }, "Change random variant group"); }} /><small>{selectedVariantCandidates.length || 1} weighted tile variant{(selectedVariantCandidates.length || 1) === 1 ? "" : "s"} share this group.</small></label>
        <TileVariantPreview palette={document.palette} sprite={sourceSprite?.type === "sprite" ? sourceSprite : undefined} tileset={tileset} selectedTileId={selectedTileId} group={selectedVariantGroup} candidates={selectedVariantCandidates} onSelect={(tileId) => { setSelectedTileId(tileId); setSelectedCollisionIds([]); }} />
        <TileAnimationEditor document={document} tileset={tileset} sourceSprite={sourceSprite?.type === "sprite" ? sourceSprite : undefined} tile={selectedTile} tileCount={tileCount} onChange={(animation, label) => updateTile({ animation }, label)} />
        <div className="section-heading"><span>Custom properties</span></div>
        <div className="tile-property-add"><input aria-label="Property name" placeholder="name" value={propertyName} onChange={(event) => setPropertyName(event.target.value)} /><input aria-label="Property value" placeholder="value" value={propertyValue} onChange={(event) => setPropertyValue(event.target.value)} /><button disabled={!propertyName.trim()} onClick={() => { const parsed = propertyValue === "true" ? true : propertyValue === "false" ? false : propertyValue.trim() !== "" && Number.isFinite(Number(propertyValue)) ? Number(propertyValue) : propertyValue; updateTile({ properties: { ...selectedTile.properties, [propertyName.trim()]: parsed } }, "Set tile property"); setPropertyName(""); setPropertyValue(""); }}>Add</button></div>
        <div className="tile-property-list">{Object.entries(selectedTile.properties).map(([key, value]) => <span key={key}><strong>{key}</strong> = {String(value)}<button title="Delete property" onClick={() => { const properties = { ...selectedTile.properties }; delete properties[key]; updateTile({ properties }, "Delete tile property"); }}>×</button></span>)}</div>
      </div>
      <div className="section-heading">
        <span>Wang terrain</span>
        <small>{tileset.wangSets.length}</small>
      </div>
      {tileset.wangSets.map((set) => (
        <button className={"terrain-row " + (activeWangSet?.id === set.id ? "is-active" : "")} key={set.id} onClick={() => setSelectedWangSetId(set.id)}>
          <span
            className="terrain-chip"
            style={
              {
                "--terrain": set.colors[0]?.color ?? "#ff6b7a",
              } as React.CSSProperties
            }
          />
          <span>
            <strong>{set.name}</strong>
            <small>
              {set.type} · {set.tiles.length} mapped tiles
            </small>
          </span>
        </button>
      ))}
      <div className="tileset-actions">
        <button onClick={addTerrain}>+ Terrain</button>
        <button disabled={!activeWangSet} onClick={addWangColor}>+ Color</button>
        <button disabled={!activeWangSet} onClick={() => { if (!activeWangSet) return; replace(deleteWangSet(tileset, activeWangSet.id), "Delete Wang terrain"); setSelectedWangSetId(undefined); }}>Delete terrain</button>
      </div>
      {activeWangSet && <div className="wang-editor">
        <div className="two-fields"><label className="field"><span>Set name</span><input key={activeWangSet.id + activeWangSet.name} defaultValue={activeWangSet.name} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== activeWangSet.name) updateWangSet({ ...activeWangSet, name }, "Rename Wang set"); }} /></label><label className="field"><span>Mode</span><select value={activeWangSet.type} onChange={(event) => updateWangSet({ ...activeWangSet, type: event.target.value as WangSet["type"] }, "Change Wang set mode")}><option value="edge">Edge</option><option value="corner">Corner</option><option value="mixed">Mixed</option></select></label></div>
        <div className="wang-color-list">{activeWangSet.colors.map((color, colorIndex) => <div className="wang-color-row" key={color.id}><input aria-label={"Wang color " + color.id} type="color" value={color.color.slice(0, 7)} onChange={(event) => updateWangSet({ ...activeWangSet, colors: activeWangSet.colors.map((entry, index) => index === colorIndex ? { ...entry, color: event.target.value } : entry) }, "Change Wang color")} /><input aria-label={"Wang color name " + color.id} value={color.name} onChange={(event) => updateWangSet({ ...activeWangSet, colors: activeWangSet.colors.map((entry, index) => index === colorIndex ? { ...entry, name: event.target.value } : entry) }, "Rename Wang color")} /><input aria-label={"Wang color probability " + color.id} type="number" min="0" step="0.05" value={color.probability} onChange={(event) => updateWangSet({ ...activeWangSet, colors: activeWangSet.colors.map((entry, index) => index === colorIndex ? { ...entry, probability: Math.max(0, Number(event.target.value) || 0) } : entry) }, "Change Wang probability")} /><button title="Delete Wang color" onClick={() => replace(deleteWangColor(tileset, activeWangSet.id, color.id), "Delete Wang color")}><Trash2 size={10} /></button></div>)}</div>
        <div className="section-heading"><span>Tile {selectedTileId} Wang slots</span><small>edge / corner clockwise</small></div>
        <div className="wang-slot-grid">{["Top edge", "Top-right corner", "Right edge", "Bottom-right corner", "Bottom edge", "Bottom-left corner", "Left edge", "Top-left corner"].map((label, slot) => <label key={label}><span>{label}</span><select value={activeWangSet.tiles.find((tile) => tile.tileId === selectedTileId)?.wangId[slot] ?? 0} onChange={(event) => assignWangSlot(slot, Number(event.target.value))}><option value={0}>None</option>{activeWangSet.colors.map((color) => <option key={color.id} value={color.id}>{color.name}</option>)}</select></label>)}</div>
      </div>}
      <div className="section-heading"><span>Tile {selectedTileId} collisions</span><small>{selectedTile.collisions.length}</small></div>
      <div className="tileset-actions"><select aria-label="Collision shape type" value={collisionType} onChange={(event) => setCollisionType(event.target.value as typeof collisionType)}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="polyline">Polyline</option></select><button onClick={addCollision}>+ Shape</button></div>
      <div className="collision-selection-actions"><small>{selectedCollisions.length} selected</small><button disabled={selectedTile.collisions.length === 0 || selectedCollisions.length === selectedTile.collisions.length} onClick={() => setSelectedCollisionIds(selectedTile.collisions.map((shape) => shape.id))}>Select all</button><button disabled={selectedCollisions.length === 0} onClick={() => setSelectedCollisionIds([])}>Clear</button><button disabled={selectedCollisions.length === 0} onClick={() => { updateTile({ collisions: selectedTile.collisions.filter((shape) => !selectedCollisionSet.has(shape.id)) }, selectedCollisions.length === 1 ? "Delete collision" : `Delete ${selectedCollisions.length} collisions`); setSelectedCollisionIds([]); }}><Trash2 size={10} /> Delete selected</button></div>
      <CollisionShapeEditor documentId={document.id} tilesetId={tileset.id} sprite={sourceSprite?.type === "sprite" ? sourceSprite : undefined} palette={document.palette} sourceX={selectedTile.sourceX} sourceY={selectedTile.sourceY} width={tileset.tileWidth} height={tileset.tileHeight} shapes={selectedTile.collisions} selectedIds={selectedCollisionIds} onSelect={setSelectedCollisionIds} onCommit={(shapes, label) => { const changed = new Map(shapes.map((shape) => [shape.id, shape])); updateTile({ collisions: selectedTile.collisions.map((entry) => changed.get(entry.id) ?? entry) }, label); }} />
      <div className="collision-list">{selectedTile.collisions.map((shape, shapeIndex) => <div className={"collision-row " + (selectedCollisionSet.has(shape.id) ? "is-selected" : "")} key={shape.id} onClick={(event) => { if ((event.target as HTMLElement).closest("input, select, button")) return; setSelectedCollisionIds(event.shiftKey ? selectedCollisionSet.has(shape.id) ? selectedCollisionIds.filter((id) => id !== shape.id) : [...selectedCollisionIds, shape.id] : [shape.id]); }}><input aria-label={"Select collision " + (shapeIndex + 1)} type="checkbox" checked={selectedCollisionSet.has(shape.id)} onChange={(event) => setSelectedCollisionIds(event.target.checked ? [...selectedCollisionIds, shape.id] : selectedCollisionIds.filter((id) => id !== shape.id))} /><select aria-label={"Collision type " + (shapeIndex + 1)} value={shape.type} onChange={(event) => updateTile({ collisions: selectedTile.collisions.map((entry, index) => index === shapeIndex ? { ...entry, type: event.target.value as typeof shape.type } : entry) }, "Change collision type")}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="polyline">Polyline</option></select><input aria-label={"Collision x " + (shapeIndex + 1)} type="number" value={shape.x} onChange={(event) => updateTile({ collisions: selectedTile.collisions.map((entry, index) => index === shapeIndex ? { ...entry, x: Number(event.target.value) } : entry) }, "Move collision")} /><input aria-label={"Collision y " + (shapeIndex + 1)} type="number" value={shape.y} onChange={(event) => updateTile({ collisions: selectedTile.collisions.map((entry, index) => index === shapeIndex ? { ...entry, y: Number(event.target.value) } : entry) }, "Move collision")} /><input aria-label={"Collision width " + (shapeIndex + 1)} type="number" value={shape.width ?? tileset.tileWidth} onChange={(event) => updateTile({ collisions: selectedTile.collisions.map((entry, index) => index === shapeIndex ? { ...entry, width: Math.max(1, Number(event.target.value)) } : entry) }, "Resize collision")} /><input aria-label={"Collision height " + (shapeIndex + 1)} type="number" value={shape.height ?? tileset.tileHeight} onChange={(event) => updateTile({ collisions: selectedTile.collisions.map((entry, index) => index === shapeIndex ? { ...entry, height: Math.max(1, Number(event.target.value)) } : entry) }, "Resize collision")} /><button title="Delete collision" onClick={() => { updateTile({ collisions: selectedTile.collisions.filter((_, index) => index !== shapeIndex) }, "Delete collision"); setSelectedCollisionIds(selectedCollisionIds.filter((id) => id !== shape.id)); }}><Trash2 size={11} /></button></div>)}</div>
      {selectedCollisions.length > 1 && <small className="collision-selection-note">Drag the highlighted shapes together, or select exactly one collision to edit its points and custom properties.</small>}
      {selectedCollision && <div className="collision-property-editor"><div className="section-heading"><span>Collision properties</span><small>{Object.keys(selectedCollision.properties).length}</small></div><div className="tile-property-add"><input aria-label="Collision property name" placeholder="name" value={collisionPropertyName} onChange={(event) => setCollisionPropertyName(event.target.value)} /><input aria-label="Collision property value" placeholder="value" value={collisionPropertyValue} onChange={(event) => setCollisionPropertyValue(event.target.value)} /><button disabled={!collisionPropertyName.trim()} onClick={() => { const parsed = collisionPropertyValue === "true" ? true : collisionPropertyValue === "false" ? false : collisionPropertyValue.trim() !== "" && Number.isFinite(Number(collisionPropertyValue)) ? Number(collisionPropertyValue) : collisionPropertyValue; updateTile({ collisions: selectedTile.collisions.map((entry) => entry.id === selectedCollision.id ? { ...entry, properties: { ...entry.properties, [collisionPropertyName.trim()]: parsed } } : entry) }, "Set collision property"); setCollisionPropertyName(""); setCollisionPropertyValue(""); }}>Add</button></div><div className="tile-property-list">{Object.entries(selectedCollision.properties).map(([key, value]) => <span key={key}><strong>{key}</strong> = {String(value)}<button title="Delete collision property" onClick={() => { const properties = { ...selectedCollision.properties }; delete properties[key]; updateTile({ collisions: selectedTile.collisions.map((entry) => entry.id === selectedCollision.id ? { ...entry, properties } : entry) }, "Delete collision property"); }}>×</button></span>)}</div></div>}
      <div className="section-heading"><span>Drawing offset</span><small>map pixels</small></div>
      <div className="two-fields">
        {(["x", "y"] as const).map((axis) => (
          <label className="field" key={axis}>
            <span>{axis.toUpperCase()} · {axis === "x" ? "right" : "down"} positive</span>
            <input
              key={`${tileset.id}:${tileset.revision}:offset-${axis}`}
              aria-label={`Tileset drawing offset ${axis.toUpperCase()}`}
              type="number"
              min={-MAX_TILESET_DRAWING_OFFSET}
              max={MAX_TILESET_DRAWING_OFFSET}
              step={1}
              value={currentDrawingOffsetDraft[axis]}
              onChange={(event) => setDrawingOffsetDraft({ ...currentDrawingOffsetDraft, [axis]: event.currentTarget.value })}
              onKeyDown={(event) => { if (event.key === "Enter") applyDrawingOffset(); }}
            />
          </label>
        ))}
      </div>
      <div className="tileset-actions"><button disabled={drawingOffsetDraftMatchesTileset} onClick={applyDrawingOffset}>Apply drawing offset</button></div>
      <p className="fine-print">Moves this tileset’s tile-layer sprite artwork without moving map cells, grid geometry, or collision data.</p>
      <div className="section-heading"><span>Tile-object alignment</span><small>Tiled anchor</small></div>
      <label className="field tileset-object-alignment">
        <span>Object anchor</span>
        <select aria-label="Tileset tile-object alignment" value={tileset.objectAlignment} onChange={(event) => replace({ ...tileset, objectAlignment: event.target.value as TileObjectAlignment }, "Change tileset object alignment")}>
          {TILE_OBJECT_ALIGNMENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <p className="fine-print">Changes the shared render, hit, and culling anchor for every resolved tile object that uses this tileset. Unspecified follows Tiled’s map-orientation default.</p>
      <div className="section-heading">
        <span>Transformations</span>
      </div>
      <div className="toggle-grid">
        {(
          [
            ["hFlip", "Horizontal flip"],
            ["vFlip", "Vertical flip"],
            ["rotate", "90° rotation"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={tileset.transformations[key]}
              onChange={(event) =>
                replace(
                  {
                    ...tileset,
                    transformations: {
                      ...tileset.transformations,
                      [key]: event.target.checked,
                    },
                  },
                  "Change tile transformations",
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <p className="fine-print">
        Edit the source pixels directly on canvas. Terrain rules, probabilities,
        animation, drawing offset, properties, and collision data export through Tiled.
      </p>
    </div>
  );
}

function PalettePanel({ document }: { document: PixelDocument }) {
  const index = useEditorStore((state) => state.pixelIndex);
  const setIndex = useEditorStore((state) => state.setPixelIndex);
  const setColor = useEditorStore((state) => state.setColor);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const [cycleDraft, setCycleDraft] = useState<PaletteCycle>();
  const [paletteImportMode, setPaletteImportMode] = useState<PaletteImportMode>("replace-slots");
  const [replacementIndex, setReplacementIndex] = useState(0);
  const selected = document.palette[index] ?? document.palette[0];
  const selectedUsage = useMemo(() => countPaletteIndexUsage(document, index, 10_000), [document, index]);
  const customOverride = index > 0 && Object.values(document.pixelAssets).some((asset) => asset.type === "sprite" && Object.values(asset.paletteOverrides).some((override) => override[index] && JSON.stringify(override[index]) !== JSON.stringify(document.palette[index])));
  const updateSelectedColor = async (color: string) => {
    const palette = structuredClone(document.palette);
    palette[index] = {
      ...palette[index],
      color: index === 0 ? `${color}00` : color,
    };
    await apply("Update palette color", [
      { kind: "pixel.palette.replace", palette },
    ]);
    setColor(color);
  };
  const openNewCycle = () => {
    const fromIndex = Math.max(1, Math.min(index || 1, Math.max(1, document.palette.length - 2)));
    setCycleDraft({ id: createId("cycle"), name: "Cycle " + (document.paletteCycles.length + 1), fromIndex, toIndex: Math.min(document.palette.length - 1, fromIndex + 1), direction: "forward", stepMs: 180 });
  };
  const saveCycle = async () => {
    if (!cycleDraft) return;
    const exists = document.paletteCycles.some((cycle) => cycle.id === cycleDraft.id);
    const cycles = exists ? document.paletteCycles.map((cycle) => cycle.id === cycleDraft.id ? { ...cycleDraft, name: cycleDraft.name.trim() } : cycle) : [...document.paletteCycles, { ...cycleDraft, name: cycleDraft.name.trim() }];
    if (await apply(exists ? "Edit palette cycle" : "Add palette cycle", [{ kind: "pixel.palette-cycles.replace", cycles }])) setCycleDraft(undefined);
  };
  const movePaletteEntry = async (direction: -1 | 1) => {
    const target = index + direction; if (index <= 0 || target <= 0 || target >= document.palette.length) return;
    const entryIds = document.palette.map((entry) => entry.id); [entryIds[index], entryIds[target]] = [entryIds[target], entryIds[index]];
    if (await apply("Reorder palette color", [{ kind: "pixel.palette.reorder", entryIds, expectedRevision: document.revision }])) setIndex(target);
  };
  const deletePaletteEntry = async () => {
    if (index <= 0 || selectedUsage || customOverride) return;
    const entryIds = document.palette.map((entry) => entry.id); const [removedId] = entryIds.splice(index, 1); entryIds.push(removedId);
    const reordered = entryIds.map((id) => document.palette.find((entry) => entry.id === id)!); const oldToNew = new Map(document.palette.map((entry, oldIndex) => [oldIndex, entryIds.indexOf(entry.id)]));
    const cycles = document.paletteCycles.flatMap((cycle) => { const members = Array.from({ length: cycle.toIndex - cycle.fromIndex + 1 }, (_, offset) => cycle.fromIndex + offset).filter((member) => member !== index).map((member) => oldToNew.get(member)!).filter((member) => member < reordered.length - 1); return members.length ? [{ ...cycle, fromIndex: Math.min(...members), toIndex: Math.max(...members) }] : []; });
    if (await apply("Delete unused palette color", [{ kind: "pixel.palette.reorder", entryIds, expectedRevision: document.revision }, { kind: "pixel.palette-cycles.replace", cycles }, { kind: "pixel.palette.replace", palette: reordered.slice(0, -1) }])) setIndex(Math.min(index, reordered.length - 2));
  };
  const replaceAndDeletePaletteEntry = async () => {
    if (index <= 0) return;
    try {
      const target = replacementIndex === index || replacementIndex >= document.palette.length ? 0 : replacementIndex;
      if (await apply("Replace and delete palette color", replaceAndDeletePaletteIndexOperations(document, index, target))) {
        const nextTarget = target > index ? target - 1 : target;
        setIndex(Math.min(nextTarget, document.palette.length - 2));
        setReplacementIndex(0);
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const importPalette = async () => {
    const result = await window.aidraw.importPalette(document.id, paletteImportMode);
    if (!result.imported) return;
    const summary = paletteImportMode === "append-unique"
      ? `Added ${result.added} color${result.added === 1 ? "" : "s"}${result.skipped ? `; skipped ${result.skipped}` : ""}.`
      : `Updated ${result.updated} palette slot${result.updated === 1 ? "" : "s"}${result.added ? ` and added ${result.added}` : ""}.`;
    notify(`${summary}${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`, result.warnings.length ? "warning" : "success");
  };
  const exportPalette = async (format: "json" | "gpl") => {
    const result = await window.aidraw.exportPalette(document.id, format);
    if (result.exported) notify(`Exported palette to ${result.filePath}.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`, result.warnings.length ? "warning" : "success");
  };
  const cycleError = cycleDraft && (!cycleDraft.name.trim() ? "Enter a cycle name." : cycleDraft.fromIndex < 1 || cycleDraft.toIndex < cycleDraft.fromIndex || cycleDraft.toIndex >= document.palette.length ? "Choose an ordered range inside the non-transparent palette." : cycleDraft.stepMs < 16 || cycleDraft.stepMs > 60_000 ? "Use a step time from 16 to 60,000 ms." : undefined);
  return (
    <>
    <section className="palette-section">
      <div className="section-heading">
        <span>Indexed palette</span>
        <small>{document.palette.length}/256</small>
      </div>
      <div className="palette-file-actions">
        <select aria-label="Palette import behavior" value={paletteImportMode} onChange={(event) => setPaletteImportMode(event.target.value as PaletteImportMode)} title="How imported palette colors affect existing indexed artwork">
          <option value="replace-slots">Replace colors by index</option>
          <option value="append-unique">Append unique colors</option>
        </select>
        <button type="button" onClick={() => void importPalette()} title="Import AIDraw JSON or GIMP GPL palette"><Upload size={11} /> Import</button>
        <button type="button" onClick={() => void exportPalette("json")} title="Export portable AIDraw palette JSON"><Download size={11} /> JSON</button>
        <button type="button" onClick={() => void exportPalette("gpl")} title="Export GIMP palette (transparent index omitted)"><Download size={11} /> GPL</button>
      </div>
      <div className="palette-grid">
        {document.palette.map((entry, entryIndex) => (
          <button
            key={entry.id}
            className={`swatch ${entryIndex === index ? "is-active" : ""} ${entryIndex === 0 ? "is-transparent" : ""}`}
            style={{ "--swatch": entry.color } as React.CSSProperties}
            title={`${entryIndex}: ${entry.name} ${entry.color}`}
            onClick={() => {
              setIndex(entryIndex);
              setColor(entry.color.slice(0, 7));
            }}
          />
        ))}
      </div>
      <div className="palette-editor-row">
        <input
          aria-label="Edit selected palette color"
          type="color"
          value={selected.color.slice(0, 7)}
          onChange={(event) => void updateSelectedColor(event.target.value)}
        />
        <span>
          <strong>{selected.name}</strong>
          <small>
            Index {index} · {selected.color}
          </small>
        </span>
        <button
          title="Previous palette slot"
          disabled={index <= 1}
          onClick={() => setIndex(index - 1)}
        >
          ‹
        </button>
        <button
          title="Next palette slot"
          disabled={index >= document.palette.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          ›
        </button>
        <button title="Move selected color one slot earlier" disabled={index <= 1} onClick={() => void movePaletteEntry(-1)}><ChevronLeft size={11} /></button>
        <button title="Move selected color one slot later" disabled={index <= 0 || index >= document.palette.length - 1} onClick={() => void movePaletteEntry(1)}><ChevronRight size={11} /></button>
        <button
          title="Add palette color"
          disabled={document.palette.length >= 256}
          onClick={() =>
            void apply("Add palette color", [
              {
                kind: "pixel.palette.replace",
                palette: [
                  ...document.palette,
                  {
                    id: `color-${document.palette.length}`,
                    name: `Color ${document.palette.length}`,
                    color: "#ff6b7a",
                  },
                ],
              },
            ])
          }
        >
          +
        </button>
        <button title={index === 0 ? "Transparent index 0 cannot be deleted" : selectedUsage ? `Replace this color first; it is used ${selectedUsage}${selectedUsage >= 10_000 ? "+" : ""} times` : customOverride ? "Clear this color's frame-specific overrides before deleting it" : "Delete unused palette color"} disabled={index === 0 || Boolean(selectedUsage) || customOverride || document.palette.length <= 1} onClick={() => void deletePaletteEntry()}><Trash2 size={11} /></button>
      </div>
      {index > 0 && document.palette.length > 1 && <div className="palette-remap-row"><span>Replace index {index} everywhere with</span><select aria-label="Replacement palette color" value={replacementIndex === index ? 0 : replacementIndex} onChange={(event) => setReplacementIndex(Number(event.target.value))}>{document.palette.map((entry, entryIndex) => entryIndex === index ? null : <option key={entry.id} value={entryIndex}>{entryIndex}: {entry.name}</option>)}</select><button onClick={() => void replaceAndDeletePaletteEntry()}><Trash2 size={11} /> Replace & delete</button></div>}
      <div className="palette-cycle-editor">
        <div className="section-heading"><span>Named color cycles</span><button disabled={document.palette.length < 3} onClick={openNewCycle}>+ Cycle</button></div>
        {document.paletteCycles.length === 0 ? <small>No ranges yet. Cycling preview currently rotates every non-transparent color.</small> : <div className="palette-cycle-list">{document.paletteCycles.map((cycle) => <div className="palette-cycle-row" key={cycle.id}><button className="palette-cycle-main" onClick={() => setCycleDraft(structuredClone(cycle))}><Repeat2 size={12} /><span><strong>{cycle.name}</strong><small>{cycle.fromIndex}–{cycle.toIndex} · {cycle.direction} · {cycle.stepMs}ms</small></span></button><button title="Delete palette cycle" onClick={() => void apply("Delete palette cycle", [{ kind: "pixel.palette-cycles.replace", cycles: document.paletteCycles.filter((entry) => entry.id !== cycle.id) }])}><Trash2 size={12} /></button></div>)}</div>}
      </div>
      <div className="conversion-editor">
        <div className="section-heading">
          <span>Generated-image conversion</span>
        </div>
        <label className="field">
          <span>Dithering</span>
          <select
            value={document.conversionDefaults.dithering}
            onChange={(event) =>
              void apply("Change pixel conversion", [
                {
                  kind: "pixel.conversion.replace",
                  conversionDefaults: {
                    ...document.conversionDefaults,
                    dithering: event.target
                      .value as PixelDocument["conversionDefaults"]["dithering"],
                  },
                },
              ])
            }
          >
            <option value="none">None</option>
            <option value="bayer-4x4">Bayer 4×4</option>
            <option value="floyd-steinberg">Floyd–Steinberg</option>
          </select>
        </label>
        <label className="field">
          <span>
            Alpha threshold ·{" "}
            {Math.round(document.conversionDefaults.alphaThreshold * 100)}%
          </span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(document.conversionDefaults.alphaThreshold * 100)}
            onChange={(event) =>
              void apply("Change alpha threshold", [
                {
                  kind: "pixel.conversion.replace",
                  conversionDefaults: {
                    ...document.conversionDefaults,
                    alphaThreshold: Number(event.target.value) / 100,
                  },
                },
              ])
            }
          />
        </label>
        <small>
          Area resize · nearest palette in OKLab · source retained for
          provenance.
        </small>
      </div>
    </section>
    {cycleDraft && <ModalShell title={document.paletteCycles.some((cycle) => cycle.id === cycleDraft.id) ? "Edit palette cycle" : "Add palette cycle"} description="Cycle an exact indexed range without changing stored pixels." onClose={() => setCycleDraft(undefined)} className="palette-cycle-dialog">
      <form onSubmit={(event) => { event.preventDefault(); if (!cycleError) void saveCycle(); }}>
        <div className="entry-dialog-body palette-cycle-grid">
          <label className="dialog-field cycle-name-field"><span>Name</span><input autoFocus maxLength={120} value={cycleDraft.name} onChange={(event) => setCycleDraft({ ...cycleDraft, name: event.target.value })} /></label>
          <label className="dialog-field"><span>First index</span><input type="number" min={1} max={document.palette.length - 1} value={cycleDraft.fromIndex} onChange={(event) => setCycleDraft({ ...cycleDraft, fromIndex: Number(event.target.value) })} /></label>
          <label className="dialog-field"><span>Last index</span><input type="number" min={1} max={document.palette.length - 1} value={cycleDraft.toIndex} onChange={(event) => setCycleDraft({ ...cycleDraft, toIndex: Number(event.target.value) })} /></label>
          <label className="dialog-field"><span>Direction</span><select value={cycleDraft.direction} onChange={(event) => setCycleDraft({ ...cycleDraft, direction: event.target.value as PaletteCycle["direction"] })}><option value="forward">Forward</option><option value="reverse">Reverse</option></select></label>
          <label className="dialog-field"><span>Step (ms)</span><input type="number" min={16} max={60_000} value={cycleDraft.stepMs} onChange={(event) => setCycleDraft({ ...cycleDraft, stepMs: Number(event.target.value) })} /></label>
          <div className="entry-dialog-preview cycle-range-preview"><strong>Preview contract</strong><span>{cycleError ?? (cycleDraft.toIndex - cycleDraft.fromIndex + 1) + " colors · " + (1000 / cycleDraft.stepMs).toFixed(2) + " steps/second"}</span></div>
          {cycleError && <p className="entry-dialog-error" role="alert">{cycleError}</p>}
        </div>
        <footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={() => setCycleDraft(undefined)}>Cancel</button><button type="submit" className="primary-modal-button" disabled={Boolean(cycleError)}>Save cycle</button></footer>
      </form>
    </ModalShell>}
    </>
  );
}

function AgentSetupResultDialog({
  result,
  onClose,
}: {
  result: AgentClientSetupResult;
  onClose: () => void;
}) {
  const configured = result.status === "configured";
  const hasManualSettings = Boolean(result.setupSnippet);
  return (
    <ModalShell
      title={
        configured
          ? `Finish ${result.clientName} setup`
          : hasManualSettings
            ? `Connect ${result.clientName}`
            : `${result.clientName} connection needs attention`
      }
      description={
        configured
          ? "AIDraw is configured. Complete the client-side step before starting agent work."
          : hasManualSettings
            ? "Use these generic Streamable HTTP settings in the client’s MCP configuration."
            : "AIDraw could not complete the automatic connection."
      }
      onClose={onClose}
      className="codex-setup-dialog"
    >
      <div className="codex-setup-body">
        <div
          className={`codex-setup-emblem ${configured ? "is-ready" : "needs-attention"}`}
        >
          <Bot size={27} />
        </div>
        <div className="codex-setup-copy">
          <strong>
            {configured
              ? "Connection saved successfully"
              : hasManualSettings
                ? "Authenticated connection settings"
                : "Automatic setup did not finish"}
          </strong>
          <p>{result.message}</p>
        </div>
        {result.setupSnippet && (
          <div className="agent-setup-snippet">
            <span>Private MCP configuration</span>
            <code>{result.setupSnippet}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(result.setupSnippet!)}>Copy configuration</button>
          </div>
        )}
        {configured && result.restartRequired && (
          <div className="restart-required">
            <span>Required next step</span>
            <strong>{result.restartInstruction}</strong>
            <p>After reconnecting, new local agent sessions can discover AIDraw’s MCP tools. The AIDraw engine may continue running headlessly.</p>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button
          type="button"
          className="primary-modal-button"
          autoFocus
          onClick={onClose}
        >
          {configured ? "Got it" : "Close"}
        </button>
      </footer>
    </ModalShell>
  );
}

function CheckpointComparisonDialog({
  comparison,
  onClose,
  onRestore,
  onMerge,
}: {
  comparison: CheckpointComparisonResult;
  onClose: () => void;
  onRestore: () => Promise<void>;
  onMerge: (sourceIds: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"side-by-side" | "overlay">("side-by-side");
  const [opacity, setOpacity] = useState(50);
  const [restoring, setRestoring] = useState(false);
  const [merging, setMerging] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  return (
    <ModalShell
      title={`Compare · ${comparison.checkpoint.name}`}
      description={`Saved at revision ${comparison.saved.revision}; current revision ${comparison.current.revision}. Both views are rendered from editable canonical state.`}
      className="checkpoint-comparison-dialog"
      onClose={onClose}
    >
      <div className="checkpoint-compare-toolbar">
        <button className={mode === "side-by-side" ? "is-active" : ""} onClick={() => setMode("side-by-side")}>Side by side</button>
        <button className={mode === "overlay" ? "is-active" : ""} onClick={() => setMode("overlay")}>Overlay</button>
        {mode === "overlay" && (
          <label>
            <span>Current {opacity}%</span>
            <input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
          </label>
        )}
      </div>
      <div className={`checkpoint-compare-stage is-${mode}`}>
        <figure className="checkpoint-saved">
          <figcaption>Checkpoint</figcaption>
          <img src={comparison.saved.dataUrl} alt={`${comparison.checkpoint.name} checkpoint`} />
        </figure>
        <figure className="checkpoint-current" style={mode === "overlay" ? { opacity: opacity / 100 } : undefined}>
          <figcaption>Current</figcaption>
          <img src={comparison.current.dataUrl} alt="Current document" />
        </figure>
      </div>
      <div className="checkpoint-merge-panel">
        <span><strong>Selective merge</strong><small>Duplicate chosen top-level layers or project assets into the current branch without replacing it.</small></span>
        <div className="checkpoint-merge-candidates">{comparison.candidates.map((candidate) => <label key={candidate.id}><input type="checkbox" checked={selectedCandidates.includes(candidate.id)} onChange={(event) => setSelectedCandidates((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><span><strong>{candidate.name}</strong><small>{candidate.detail}</small></span></label>)}</div>
      </div>
      <footer className="modal-footer checkpoint-compare-footer">
        <span>Reject leaves the current branch untouched.</span>
        <button onClick={onClose}>Reject</button>
        <button disabled={restoring || merging || selectedCandidates.length === 0} onClick={async () => { setMerging(true); try { await onMerge(selectedCandidates); } finally { setMerging(false); } }}>{merging ? "Merging…" : `Merge selected${selectedCandidates.length ? ` (${selectedCandidates.length})` : ""}`}</button>
        <button
          className="primary"
          disabled={restoring}
          onClick={async () => {
            setRestoring(true);
            try { await onRestore(); } finally { setRestoring(false); }
          }}
        >
          {restoring ? "Restoring…" : "Accept checkpoint"}
        </button>
      </footer>
    </ModalShell>
  );
}

function InterchangeReportDialog({ report, onClose }: { report: InterchangeReport; onClose: () => void }) {
  const notify = useEditorStore((state) => state.notify);
  const pathRows = [
    ...report.sourcePaths.map((path) => ({ label: "Source", path })),
    ...report.destinationPaths.map((path) => ({ label: "Output", path })),
  ];
  return <ModalShell title={`${report.kind === "import" ? "Import" : "Export"} report · ${report.format.toUpperCase()}`} description={`${report.status} by ${actorIdentityLabel(report.actor)} at ${new Date(report.createdAt).toLocaleString()}. This report remains available after restart.`} className="interchange-report-dialog" onClose={onClose}>
    <div className="interchange-report-body">
      <dl className="interchange-report-summary">
        <div><dt>Documents</dt><dd>{report.documentNames.join(", ") || "No document created"}</dd></div>
        <div><dt>Warnings</dt><dd>{report.warnings.length}</dd></div>
        <div><dt>Raster fallbacks</dt><dd>{report.rasterized.length}</dd></div>
        <div><dt>Structured reasons</dt><dd>{report.fidelity.length}</dd></div>
      </dl>
      {pathRows.length > 0 && <section><h4>Files</h4>{pathRows.map((entry, index) => <div className="interchange-path" key={`${entry.path}-${index}`}><span>{entry.label}</span><code>{entry.path}</code></div>)}</section>}
      {report.error && <section className="interchange-error"><h4>Failure</h4><p>{report.error}</p></section>}
      {report.warnings.length > 0 && <section><h4>Warnings and conversions</h4><ul>{report.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}
      {report.rasterized.length > 0 && <section><h4>Rasterized or flattened content</h4><ul>{report.rasterized.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul></section>}
      {report.fidelity.length > 0 && <section><h4>Structured fidelity reasons</h4><ul>{report.fidelity.map((entry, index) => <li key={`${entry.code}-${entry.subjectId}-${index}`}><strong>{interchangeFidelityCodeLabel(entry.code)}</strong> · {entry.subjectType} “{entry.subjectName || entry.subjectId}”{entry.detail ? ` — ${entry.detail}` : ""}</li>)}</ul></section>}
      {!report.error && report.warnings.length === 0 && report.rasterized.length === 0 && report.fidelity.length === 0 && <div className="interchange-clean">No fidelity warnings were reported by this adapter.</div>}
    </div>
    <footer className="modal-footer"><button onClick={onClose}>Close</button><button className="primary" onClick={async () => { const result = await window.aidraw.exportInterchangeReport(report.id); if (result.exported) notify(`Saved report to ${result.filePath}.`, "success"); }}>Export report JSON</button></footer>
  </ModalShell>;
}

function ActivityPanel() {
  const snapshot = useEditorStore((state) => state.snapshot);
  const notify = useEditorStore((state) => state.notify);
  const playbacks = useEditorStore((state) => state.playbacks);
  const reportPulse = useEditorStore((state) => state.reportPulse);
  const document = snapshot?.activeDocument;
  const sessions = snapshot?.mcp.sessions ?? [];
  const [credentials, setCredentials] = useState<{
    url?: string;
    token: string;
  }>();
  const [selectedClient, setSelectedClient] = useState<AgentClientId>("codex");
  const [setupResult, setSetupResult] = useState<AgentClientSetupResult>();
  const [configuring, setConfiguring] = useState(false);
  const [credentialChanging, setCredentialChanging] = useState(false);
  const [credentialResult, setCredentialResult] = useState<McpCredentialLifecycleResult>();
  const [engine, setEngine] = useState<EngineStatus>();
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpointComparison, setCheckpointComparison] = useState<CheckpointComparisonResult>();
  const [interchangeReports, setInterchangeReports] = useState<InterchangeReport[]>([]);
  const [selectedReport, setSelectedReport] = useState<InterchangeReport>();
  useEffect(() => {
    void window.aidraw.getEngineStatus().then(setEngine);
  }, []);
  useEffect(() => {
    let active = true;
    if (!document?.id) { setInterchangeReports([]); return () => { active = false; }; }
    void window.aidraw.listInterchangeReports(document.id).then((reports) => { if (active) setInterchangeReports(reports); });
    return () => { active = false; };
  }, [document?.id, reportPulse]);
  const changeMcpCredential = async (action: "rotate" | "revoke") => {
    setCredentialChanging(true);
    try {
      const result = action === "rotate"
        ? await window.aidraw.rotateMcpCredential()
        : await window.aidraw.revokeMcpAccess();
      if (result.status === "completed") {
        setCredentials(undefined);
        setSetupResult(undefined);
        setCredentialResult(result);
        setEngine(await window.aidraw.getEngineStatus());
        notify(result.message, result.warning ? "warning" : "success");
      } else {
        notify(result.message, "info");
      }
    } catch (error) {
      setCredentials(undefined);
      setSetupResult(undefined);
      setCredentialResult(undefined);
      await window.aidraw.getEngineStatus().then(setEngine).catch(() => undefined);
      notify(error instanceof Error ? error.message : "The MCP credential change failed.", "error");
    } finally {
      setCredentialChanging(false);
    }
  };
  if (!document) return null;
  const mcpAccessRevoked = snapshot?.mcp.access === "revoked";
  const latestAgentActivity = new Map<string, string>();
  for (const entry of [...document.activity].reverse()) {
    if (entry.actor.kind === "agent" && !latestAgentActivity.has(entry.actor.id))
      latestAgentActivity.set(entry.actor.id, entry.id);
  }
  const agentHistories = new Map(
    (snapshot?.agentHistories ?? []).map((history) => [
      history.actor.id,
      history,
    ]),
  );
  return (
    <div className="activity-panel">
      <div className="agent-status-card">
        <div className="agent-status-icon">
          <Bot size={19} />
        </div>
        <div>
          <strong>Headless agent engine</strong>
          <small>
            {snapshot?.mcp.running
              ? `Listening at ${snapshot.mcp.url}`
              : snapshot?.mcp.access === "revoked"
                ? "Agent access is revoked; the editor and canonical engine remain available."
                : "Starting local MCP…"}
          </small>
        </div>
      </div>
      <div className="engine-policy">
        <span>
          <strong>Editor-independent</strong>
          <small>
            Closing this window keeps documents, MCP, and traces running.
          </small>
        </span>
        <button
          disabled={!engine?.startAtLoginSupported}
          onClick={async () =>
            setEngine(
              await window.aidraw.setEngineStartAtLogin(!engine?.startsAtLogin),
            )
          }
        >
          {engine?.startsAtLogin ? "Starts at login" : "Start at login"}
        </button>
      </div>
      <div className="connection-actions">
        <select aria-label="Agent client" value={selectedClient} onChange={(event) => setSelectedClient(event.target.value as AgentClientId)}>
          {AGENT_CLIENTS.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
        <button
          disabled={configuring || snapshot?.mcp.access === "revoked"}
          onClick={async () => {
            setConfiguring(true);
            try {
              const result = await window.aidraw.configureAgentClient(selectedClient);
              if (result.status === "cancelled") notify(result.message, "info");
              else setSetupResult(result);
              setEngine(await window.aidraw.getEngineStatus());
            } finally {
              setConfiguring(false);
            }
          }}
        >
          <Bot size={13} /> {configuring ? "Connecting…" : selectedClient === "generic" ? "Show settings" : "Connect"}
        </button>
        <button
          disabled={!snapshot?.mcp.running}
          onClick={async () =>
            setCredentials(
              credentials ? undefined : await window.aidraw.getMcpCredentials(),
            )
          }
        >
          Connection
        </button>
      </div>
      {credentials && (
        <div className="credential-card">
          <label>
            <span>Streamable HTTP URL</span>
            <code>{credentials.url}</code>
          </label>
          <label>
            <span>Authorization header</span>
            <code>Bearer {credentials.token}</code>
          </label>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(
                `${credentials.url}\nAuthorization: Bearer ${credentials.token}`,
              )
            }
          >
            Copy settings
          </button>
        </div>
      )}
      <section className="credential-lifecycle" aria-label="MCP credential security">
        <div>
          <strong>Credential security</strong>
          <small>{mcpAccessRevoked
            ? "Rotating now re-enables the local endpoint and agent access with a new credential. Persistent folder approvals and already admitted or pending approval work remain; client configurations stay unchanged."
            : "Rotation invalidates every configured bearer and ends active sessions. Persistent folder approvals and already admitted or pending approval work remain. Revocation also stops MCP access; neither action edits client configuration files."}</small>
        </div>
        <div className="credential-lifecycle-actions">
          <button disabled={credentialChanging} onClick={() => void changeMcpCredential("rotate")}>{mcpAccessRevoked ? "Rotate and re-enable" : "Rotate credential"}</button>
          <button disabled={credentialChanging || snapshot?.mcp.access === "revoked"} onClick={() => void changeMcpCredential("revoke")}>Revoke access</button>
        </div>
        {credentialResult && <p role="status">{credentialResult.message}</p>}
      </section>
      {(snapshot?.jobs ?? [])
        .filter((job) => job.status === "waiting-for-user")
        .map((job) => (
          <div className="approval-card" key={job.id}>
            <div className="approval-heading">
              <span
                className="actor-avatar"
                style={{ "--actor": job.actor.color } as React.CSSProperties}
              >
                <Bot size={12} />
              </span>
              <span>
                <strong>{job.approval?.title ?? job.kind}</strong>
                <small>{job.actor.name} requests approval</small>
              </span>
            </div>
            <p>{job.approval?.description ?? job.message}</p>
            {job.approval?.review?.target && (
              <div className="approval-target">
                <span>Exact path</span>
                <code>{job.approval.review.target}</code>
              </div>
            )}
            {(job.approval?.review?.fields.length ?? 0) > 0 && (
              <dl className="approval-review">
                {job.approval!.review!.fields.map((field, index) => (
                  <div
                    key={`${field.label}-${index}`}
                    className={field.tone ? `is-${field.tone}` : undefined}
                  >
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {(job.approval?.review?.previews?.length ?? 0) > 0 && <div className="approval-previews" aria-label="Generation source and mask previews">{job.approval!.review!.previews!.map((preview) => <figure key={`${preview.role}-${preview.assetId}`}><div className={preview.role === "mask" ? "is-mask" : undefined}><img src={preview.dataUrl} alt={`${preview.role === "mask" ? "Mask" : "Source"}: ${preview.name}`} /></div><figcaption><strong>{preview.role === "mask" ? "Mask" : "Source"} · {preview.name}</strong><small>{preview.width} × {preview.height}px · {preview.mimeType}</small></figcaption></figure>)}</div>}
            {job.kind === "generation" && <div className="approval-trust-note generation-trust-note">This approval authorizes this exact provider request once. It does not trust future prompts, providers, source assets, or paid requests.</div>}
            <div className="approval-expiry">
              This request expires at{" "}
              {new Date(job.approval?.expiresAt ?? 0).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              .
            </div>
            {job.approval?.review?.trustFolder &&
              (job.approval.options.includes("allow-session") ||
                job.approval.options.includes("allow-always")) && (
                <div className="approval-trust-note">
                  Folder trust applies only to
                  <code>{job.approval.review.trustFolder}</code>
                  and never permits file enumeration or deletion. Existing
                  files still require approval.
                </div>
              )}
            <div className="approval-actions">
              {job.approval?.options.includes("deny") && (
                <button
                  onClick={() => void window.aidraw.resolveJob(job.id, "deny")}
                >
                  Deny
                </button>
              )}
              {job.approval?.options.includes("allow-once") && (
                <button
                  className="approve"
                  onClick={() =>
                    void window.aidraw.resolveJob(job.id, "allow-once")
                  }
                >
                  Allow once
                </button>
              )}
              {job.approval?.options.includes("allow-session") && (
                <button
                  className="trust"
                  onClick={() =>
                    void window.aidraw.resolveJob(job.id, "allow-session")
                  }
                >
                  Trust this session
                </button>
              )}
              {job.approval?.options.includes("allow-always") && (
                <button
                  className="trust"
                  onClick={() =>
                    void window.aidraw.resolveJob(job.id, "allow-always")
                  }
                >
                  Always trust folder
                </button>
              )}
            </div>
          </div>
        ))}
      {sessions.map((session) => (
        <div className="presence-row" key={session.actor.id}>
          <span
            className="actor-avatar"
            style={{ "--actor": session.actor.color } as React.CSSProperties}
          >
            <Bot size={13} />
          </span>
          <span>
            <strong>{session.actor.name}</strong>
            <small>
              {actorClientLabel(session.actor)
                ? `${actorClientLabel(session.actor)} · `
                : ""}
              {session.status} · {session.queueDepth} queued
            </small>
          </span>
        </div>
      ))}
      <div className="checkpoint-panel">
        <div className="section-heading">
          <span>Checkpoints & variants</span>
          <small>{snapshot?.checkpoints.length ?? 0}/32</small>
        </div>
        <form
          className="checkpoint-create"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = checkpointName.trim();
            if (!name) return;
            try {
              await window.aidraw.createCheckpoint(document.id, name);
              setCheckpointName("");
              notify(`Checkpoint “${name}” created.`, "success");
            } catch (error) {
              notify(error instanceof Error ? error.message : String(error), "error");
            }
          }}
        >
          <input aria-label="Checkpoint name" maxLength={80} placeholder="Name this branch point…" value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} />
          <button disabled={!checkpointName.trim()}>Save state</button>
        </form>
        <div className="checkpoint-list">
          {(snapshot?.checkpoints ?? []).map((checkpoint) => (
            <div className="checkpoint-row" key={checkpoint.id}>
              <span className="checkpoint-icon"><Repeat2 size={12} /></span>
              <span className="checkpoint-copy">
                <strong>{checkpoint.name}</strong>
                <small>{checkpoint.kind === "automatic" ? "Safety branch" : actorIdentityLabel(checkpoint.createdBy)} · r{checkpoint.sourceRevision} · {new Date(checkpoint.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              </span>
              <span className="checkpoint-actions">
                <button title="Compare checkpoint" onClick={async () => {
                  try { setCheckpointComparison(await window.aidraw.compareCheckpoint(document.id, checkpoint.id)); }
                  catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
                }}>Compare</button>
                <button title="Restore checkpoint" onClick={async () => {
                  const result = await window.aidraw.restoreCheckpoint(document.id, checkpoint.id);
                  if (result.status === "committed") notify(`Restored “${checkpoint.name}”. The previous branch was saved automatically.`, "success");
                  else notify(result.message ?? "Checkpoint restore failed.", result.status === "locked" ? "warning" : "error");
                }}>Restore</button>
                <button className="danger" title="Delete checkpoint" onClick={async () => {
                  const result = await window.aidraw.deleteCheckpoint(document.id, checkpoint.id);
                  if (!result.deleted) notify(result.message ?? "Checkpoint delete failed.", "warning");
                  if (checkpointComparison?.checkpoint.id === checkpoint.id) setCheckpointComparison(undefined);
                }}><Trash2 size={10} /></button>
              </span>
            </div>
          ))}
          {(snapshot?.checkpoints.length ?? 0) === 0 && <small className="checkpoint-empty">Save an editable branch point before trying a risky human or agent change.</small>}
        </div>
      </div>
      <div className="interchange-reports-panel">
        <div className="section-heading"><span>Import & export reports</span><small>{interchangeReports.length}</small></div>
        <div className="interchange-report-list">
          {interchangeReports.slice(0, 12).map((report) => <button className={`interchange-report-row is-${report.status}`} key={report.id} onClick={() => setSelectedReport(report)}>
            <span className="interchange-report-icon">{report.kind === "import" ? <Upload size={12} /> : <Download size={12} />}</span>
            <span><strong>{report.kind === "import" ? "Imported" : "Exported"} {report.format.toUpperCase()}</strong><small>{new Date(report.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {report.fidelity.length} coded reason{report.fidelity.length === 1 ? "" : "s"} · {report.warnings.length + report.rasterized.length} note{report.warnings.length + report.rasterized.length === 1 ? "" : "s"}</small></span>
            <em>{report.status}</em>
          </button>)}
          {interchangeReports.length === 0 && <small className="checkpoint-empty">Completed imports and exports will keep their fidelity reports here.</small>}
        </div>
      </div>
      <div className="section-heading">
        <span>Document activity</span>
        <small>{document.activity.length}</small>
      </div>
      <div className="activity-list">
        {[...document.activity].reverse().map((entry) => {
          const replaying = Boolean(playbacks[`trace:${entry.transactionId}`]);
          const history = agentHistories.get(entry.actor.id);
          const isLatestForActor =
            latestAgentActivity.get(entry.actor.id) === entry.id;
          return (
            <div className="activity-row" key={entry.id}>
              <span
                className="actor-avatar"
                style={{ "--actor": entry.actor.color } as React.CSSProperties}
              >
                {entry.actor.kind === "agent" ? (
                  <Bot size={12} />
                ) : (
                  <Pencil size={12} />
                )}
              </span>
              <span className="activity-copy">
                <strong>{entry.label}</strong>
                <small>
                  {actorIdentityLabel(entry.actor)} ·{" "}
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
              </span>
              {entry.actor.kind === "agent" && (
                <span className="activity-controls">
                  <button
                    disabled={replaying}
                    className={`trace-replay${replaying ? " is-replaying" : ""}`}
                    title="Replay durable agent trace"
                    onClick={async () => {
                      const result = await window.aidraw.replayTrace(
                        document.id,
                        entry.transactionId,
                      );
                      if (!result.replaying)
                        notify(
                          result.reason ?? "Trace replay is unavailable.",
                          "warning",
                        );
                    }}
                  >
                    <Play size={10} /> {replaying ? "Replaying…" : "Replay"}
                  </button>
                  {isLatestForActor && history?.canUndo && (
                    <button
                      className="agent-history-action"
                      title={`Undo the latest transaction by ${entry.actor.name}`}
                      onClick={async () => {
                        const result = await window.aidraw.undoAgent(
                          document.id,
                          entry.actor.id,
                        );
                        if (result.status !== "committed")
                          notify(result.message ?? "Agent undo failed.", "warning");
                      }}
                    >
                      <Undo2 size={10} /> Undo
                    </button>
                  )}
                  {isLatestForActor && history?.canRedo && (
                    <button
                      className="agent-history-action"
                      title={`Redo the latest undone transaction by ${entry.actor.name}`}
                      onClick={async () => {
                        const result = await window.aidraw.redoAgent(
                          document.id,
                          entry.actor.id,
                        );
                        if (result.status !== "committed")
                          notify(result.message ?? "Agent redo failed.", "warning");
                      }}
                    >
                      <Redo2 size={10} /> Redo
                    </button>
                  )}
                </span>
              )}
              <span className={`activity-state ${entry.status}`}>
                {entry.status}
              </span>
            </div>
          );
        })}
        {document.activity.length === 0 && (
          <div className="empty-panel">
            Your actions and live agent work will appear here.
          </div>
        )}
      </div>
      {setupResult && (
        <AgentSetupResultDialog
          result={setupResult}
          onClose={() => setSetupResult(undefined)}
        />
      )}
      {checkpointComparison && (
        <CheckpointComparisonDialog
          comparison={checkpointComparison}
          onClose={() => setCheckpointComparison(undefined)}
          onRestore={async () => {
            const result = await window.aidraw.restoreCheckpoint(document.id, checkpointComparison.checkpoint.id);
            if (result.status !== "committed") {
              notify(result.message ?? "Checkpoint restore failed.", result.status === "locked" ? "warning" : "error");
              return;
            }
            setCheckpointComparison(undefined);
            notify(`Accepted “${checkpointComparison.checkpoint.name}”. The previous branch was saved automatically.`, "success");
          }}
          onMerge={async (sourceIds) => {
            const result = await window.aidraw.mergeCheckpoint(document.id, checkpointComparison.checkpoint.id, sourceIds);
            if (result.status !== "committed") { notify(result.message ?? "Checkpoint merge failed.", result.status === "locked" ? "warning" : "error"); return; }
            setCheckpointComparison(undefined); notify(`Merged ${sourceIds.length} checkpoint selection${sourceIds.length === 1 ? "" : "s"} into the current branch.`, "success");
          }}
        />
      )}
      {selectedReport && <InterchangeReportDialog report={selectedReport} onClose={() => setSelectedReport(undefined)} />}
    </div>
  );
}

function GenerationComparisonDialog({
  source,
  output,
  onClose,
  onAccept,
  onReject,
}: {
  source: GenerationComparisonSource;
  output: GeneratedOutput;
  onClose: () => void;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"side-by-side" | "overlay">("side-by-side");
  const [opacity, setOpacity] = useState(50);
  const [zoom, setZoom] = useState(100);
  const [busy, setBusy] = useState<"accept" | "reject">();
  const sourceUrl = `data:${source.mimeType};base64,${source.data}`;
  const outputUrl = `data:${output.mimeType};base64,${output.data}`;
  return <ModalShell title="Compare generated result" description="The before image was frozen before the provider request. Zoom and scrolling are shared so alignment stays inspectable." className="generation-comparison-dialog" onClose={onClose}>
    <div className="generation-compare-toolbar">
      <span className="segmented-buttons"><button className={mode === "side-by-side" ? "is-active" : ""} onClick={() => setMode("side-by-side")}>Side by side</button><button className={mode === "overlay" ? "is-active" : ""} onClick={() => setMode("overlay")}>Overlay</button></span>
      <label><span>Zoom {zoom}%</span><input type="range" min="25" max="400" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
      {mode === "overlay" && <label><span>Result {opacity}%</span><input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label>}
    </div>
    <div className={`generation-compare-stage is-${mode}`}>
      {mode === "side-by-side" ? <div className="generation-compare-strip" style={{ width: `${zoom}%` }}><figure><figcaption>Before</figcaption><img src={sourceUrl} alt="Source before generation" /></figure><figure><figcaption>Result</figcaption><img src={outputUrl} alt="Generated result" /></figure></div> : <div className="generation-overlay-frame" style={{ width: `${zoom}%`, aspectRatio: `${output.width} / ${output.height}` }}><img src={sourceUrl} alt="Source before generation" /><img src={outputUrl} alt="Generated result overlay" style={{ opacity: opacity / 100 }} /></div>}
    </div>
    <footer className="modal-footer generation-compare-footer"><span>Reject removes this unaccepted result from the in-memory job.</span><button disabled={Boolean(busy)} onClick={async () => { setBusy("reject"); try { await onReject(); } finally { setBusy(undefined); } }}>{busy === "reject" ? "Rejecting…" : "Reject result"}</button><button className="primary" disabled={Boolean(busy)} onClick={async () => { setBusy("accept"); try { await onAccept(); } finally { setBusy(undefined); } }}>{busy === "accept" ? "Accepting…" : "Accept as new layer/cel"}</button></footer>
  </ModalShell>;
}

function GenerationPanel({ document }: { document: AIDrawDocument }) {
  const snapshot = useEditorStore((state) => state.snapshot);
  const notify = useEditorStore((state) => state.notify);
  const [provider, setProvider] = useState<GenerationProvider>("openai");
  const [mode, setMode] = useState<GenerationMode>("create");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [resultCount, setResultCount] = useState(1);
  const [aspectIntent, setAspectIntent] = useState<
    "canvas" | "square" | "portrait" | "landscape"
  >("canvas");
  const [sourceAssetIds, setSourceAssetIds] = useState<string[]>([]);
  const [maskAssetId, setMaskAssetId] = useState<string>();
  const [credential, setCredential] = useState("");
  const [showCredential, setShowCredential] = useState(false);
  const [credentialRemovalPending, setCredentialRemovalPending] = useState(false);
  const [providerStatus, setProviderStatus] = useState<GenerationProviderStatus>();
  const [comfyEndpoint, setComfyEndpoint] = useState("http://127.0.0.1:8188");
  const [comfyWorkflow, setComfyWorkflow] = useState<Record<string, unknown>>();
  const [comfyMappings, setComfyMappings] = useState<Record<string, string>>({});
  const [outpaint, setOutpaint] = useState({ left: 256, right: 256, up: 256, down: 256, creativity: 0.5 });
  const [generationComparison, setGenerationComparison] = useState<{ jobId: string; source: GenerationComparisonSource; output: GeneratedOutput }>();
  const generationJobs = (snapshot?.jobs ?? []).filter(
    (job) =>
      job.kind === "generation" &&
      (job.result as { request?: { documentId?: string } } | undefined)?.request
        ?.documentId === document.id,
  );
  const imageAssets = Object.values(document.assets).filter(
    (asset) => asset.data && asset.mimeType.startsWith("image/"),
  );
  const requestedSize = aspectIntent === "square" ? { width: 1024, height: 1024 } : aspectIntent === "portrait" ? { width: 1024, height: 1536 } : aspectIntent === "landscape" ? { width: 1536, height: 1024 } : document.kind === "illustration" ? { width: document.artboard.width, height: document.artboard.height } : { width: 1024, height: 1024 };
  const generationDraft = { documentId: document.id, provider, mode, prompt, negativePrompt: negativePrompt || undefined, sourceAssetIds, maskAssetId, size: requestedSize, aspectIntent, resultCount, providerOptions: provider === "comfyui" ? { endpoint: comfyEndpoint, workflow: comfyWorkflow, mappings: Object.fromEntries(Object.entries(comfyMappings).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()])) } : provider === "stability" && mode === "outpaint" ? outpaint : {} } satisfies GenerationRequest;
  const generationError = generationRequestError(document, generationDraft);
  const selectedProviderStatus = providerStatus?.[provider];

  useEffect(() => {
    void window.aidraw.getProviderStatus().then(setProviderStatus);
  }, []);

  const startGeneration = async () => {
    try {
      await window.aidraw.generationStart(generationDraft);
      notify("Generation started.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <div className="generation-panel">
      <div className="generation-hero">
        <span>
          <Sparkles size={21} />
        </span>
        <strong>Generate into your canvas</strong>
        <small>
          Provider-neutral, non-destructive results with provenance.
        </small>
      </div>
      <label className="field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(event) => { const next = event.target.value as GenerationProvider; setProvider(next); setCredential(""); setShowCredential(false); setCredentialRemovalPending(false); if (!GENERATION_PROVIDER_MODES[next].includes(mode)) setMode(GENERATION_PROVIDER_MODES[next][0]); }}
        >
          <option value="openai">
            OpenAI · gpt-image-2 {providerStatus?.openai.configured ? "✓" : ""}
          </option>
          <option value="stability">
            Stability AI {providerStatus?.stability.configured ? "✓" : ""}
          </option>
          <option value="comfyui">Local ComfyUI</option>
        </select>
      </label>
      <label className="field">
        <span>Mode</span>
        <select
          value={mode}
          onChange={(event) => { const next = event.target.value as GenerationMode; setMode(next); if (next === "create") setSourceAssetIds([]); if (next !== "inpaint") setMaskAssetId(undefined); }}
        >
          {GENERATION_PROVIDER_MODES[provider].map((entry) => <option key={entry} value={entry}>{entry === "create" ? "Create new" : entry === "edit" ? "Edit selection" : entry[0].toUpperCase() + entry.slice(1)}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Prompt</span>
        <textarea
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            document.kind === "pixel"
              ? "A cozy tiny potion shop, 16-bit game sprite…"
              : "A luminous botanical poster with curling leaves…"
          }
        />
      </label>
      {provider !== "openai" && !(provider === "stability" && mode === "outpaint") && (
        <label className="field">
          <span>Negative prompt</span>
          <textarea
            rows={2}
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            placeholder="Elements to avoid…"
          />
        </label>
      )}
      <div className="two-fields">
        <label className="field">
          <span>Results</span>
          <input
            type="number"
            min="1"
            max="4"
            value={resultCount}
            onChange={(event) =>
              setResultCount(
                Math.max(1, Math.min(4, Number(event.target.value))),
              )
            }
          />
        </label>
        <label className="field">
          <span>Aspect</span>
          <select
            value={aspectIntent}
            onChange={(event) =>
              setAspectIntent(event.target.value as typeof aspectIntent)
            }
          >
            <option value="canvas">Canvas</option>
            <option value="square">Square</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
      </div>
      {mode !== "create" && (
        <div className="generation-sources">
          <div className="section-heading">
            <span>Source images</span>
            <small>{sourceAssetIds.length} selected</small>
          </div>
          {imageAssets.length ? (
            imageAssets.map((asset) => (
              <label className="generation-source" key={asset.id}>
                <input
                  type="checkbox"
                  checked={sourceAssetIds.includes(asset.id)}
                  onChange={(event) =>
                    setSourceAssetIds((current) =>
                      event.target.checked
                        ? [...current, asset.id]
                        : current.filter((id) => id !== asset.id),
                    )
                  }
                />
                <img
                  src={`data:${asset.mimeType};base64,${asset.data}`}
                  alt=""
                />
                <span>{asset.name}</span>
              </label>
            ))
          ) : (
            <div className="empty-panel">
              Import an image asset before using edit modes.
            </div>
          )}
          {mode === "inpaint" && (
            <label className="field">
              <span>Mask image</span>
              <select
                value={maskAssetId ?? ""}
                onChange={(event) =>
                  setMaskAssetId(event.target.value || undefined)
                }
              >
                <option value="">Choose a mask</option>
                {imageAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {provider === "stability" && mode === "outpaint" && (
        <div className="generation-sources">
          <div className="section-heading"><span>Directional expansion</span><small>0–2,000 px per side</small></div>
          <div className="two-fields">
            {(["left", "right", "up", "down"] as const).map((direction) => <label className="field" key={direction}><span>{direction[0].toUpperCase() + direction.slice(1)}</span><input type="number" min="0" max="2000" step="1" value={outpaint[direction]} onChange={(event) => setOutpaint((current) => ({ ...current, [direction]: Math.max(0, Math.min(2_000, Math.round(Number(event.target.value) || 0))) }))} /></label>)}
          </div>
          <label className="field"><span>Creativity {outpaint.creativity.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={outpaint.creativity} onChange={(event) => setOutpaint((current) => ({ ...current, creativity: Number(event.target.value) }))} /></label>
          <small>Stability requires at least one non-zero side. The accepted result remains non-destructive.</small>
        </div>
      )}
      {provider === "comfyui" && (
        <>
          <label className="field">
            <span>ComfyUI endpoint</span>
            <input
              value={comfyEndpoint}
              onChange={(event) => setComfyEndpoint(event.target.value)}
            />
          </label>
          <label className="field workflow-picker">
            <span>API-format workflow</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void file
                    .text()
                    .then((text) => setComfyWorkflow(JSON.parse(text)));
              }}
            />
            <small>
              {comfyWorkflow
                ? "Workflow loaded"
                : "Choose JSON exported with Save (API Format)"}
            </small>
          </label>
          <details className="comfy-mapping-editor">
            <summary>Workflow input mapping</summary>
            <small>Optional. Leave blank to auto-detect common nodes; enter a node ID and input name for custom workflows.</small>
            {([
              ["Prompt", "promptNodeId", "promptNodeIdInput"],
              ["Negative prompt", "negativePromptNodeId", "negativePromptNodeIdInput"],
              ["Source image", "sourceNodeId", "sourceNodeIdInput"],
              ["Mask image", "maskNodeId", "maskNodeIdInput"],
              ["Seed", "seedNodeId", "seedNodeIdInput"],
              ["Width", "widthNodeId", "widthNodeIdInput"],
              ["Height", "heightNodeId", "heightNodeIdInput"],
              ["Batch size", "batchSizeNodeId", "batchSizeNodeIdInput"],
            ] as const).map(([label, nodeKey, inputKey]) => <div className="two-fields comfy-mapping-row" key={nodeKey}><label className="field"><span>{label} node ID</span><input value={comfyMappings[nodeKey] ?? ""} onChange={(event) => setComfyMappings((current) => ({ ...current, [nodeKey]: event.target.value }))} placeholder="Auto" /></label><label className="field"><span>Input name</span><input value={comfyMappings[inputKey] ?? ""} onChange={(event) => setComfyMappings((current) => ({ ...current, [inputKey]: event.target.value }))} placeholder="Auto" /></label></div>)}
          </details>
        </>
      )}
      {provider !== "comfyui" && (
        <div className="provider-key-row">
          <span>
            {!selectedProviderStatus
              ? "Checking credential storage…"
              : !selectedProviderStatus.available
              ? `${selectedProviderStatus?.stored ? "Encrypted credential stored but unavailable. " : ""}${selectedProviderStatus?.reason ?? "Operating-system credential protection is unavailable."}`
              : selectedProviderStatus.configured
                ? "Encrypted credential configured"
                : "API key required"}
          </span>
          <div className="provider-key-actions">
            <button disabled={!selectedProviderStatus?.available} onClick={() => { setShowCredential((value) => !value); setCredentialRemovalPending(false); }}>
              {showCredential ? "Hide" : selectedProviderStatus?.configured ? "Replace key" : "Set key"}
            </button>
            {selectedProviderStatus?.stored && <button className="remove-provider-key" onClick={async () => {
              if (!credentialRemovalPending) { setCredentialRemovalPending(true); setShowCredential(false); return; }
              try {
                await window.aidraw.setProviderCredential(provider, "");
                setCredential("");
                setCredentialRemovalPending(false);
                setProviderStatus(await window.aidraw.getProviderStatus());
                notify("Encrypted provider credential removed.", "success");
              } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
              }
            }}>{credentialRemovalPending ? "Confirm remove" : "Remove"}</button>}
          </div>
        </div>
      )}
      {showCredential && provider !== "comfyui" && selectedProviderStatus?.available && (
        <div className="credential-editor">
          <input
            type="password"
            maxLength={MAX_PROVIDER_CREDENTIAL_BYTES}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder={`${provider} API key`}
          />
          <button
            disabled={!credential.trim()}
            onClick={async () => {
              try {
                await window.aidraw.setProviderCredential(provider, credential);
                setCredential("");
                setShowCredential(false);
                setCredentialRemovalPending(false);
                setProviderStatus(await window.aidraw.getProviderStatus());
                notify("Credential encrypted with operating-system protected storage.", "success");
              } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
              }
            }}
          >
            {selectedProviderStatus.configured ? "Replace encrypted" : "Save encrypted"}
          </button>
        </div>
      )}
      {document.kind === "pixel" && (
        <div className="pixel-conversion-note">
          <Grid3X3 size={15} />
          <span>
            <strong>Pixel conversion enabled</strong>
            <small>
              Area downsample · OKLab match ·{" "}
              {document.conversionDefaults.dithering}
            </small>
          </span>
        </div>
      )}
      <button
        className="primary-button"
        disabled={Boolean(generationError)}
        onClick={() => void startGeneration()}
      >
        <Sparkles size={16} /> Generate
      </button>
      {generationError && <p className="entry-dialog-error" role="alert">{generationError}</p>}
      <p className="fine-print">
        Human requests start immediately. Agent requests always wait for your
        in-app approval.
      </p>
      {generationJobs.length > 0 && (
        <div className="generation-results">
          <div className="section-heading">
            <span>Generation jobs</span>
            <small>{generationJobs.length}</small>
          </div>
          {[...generationJobs].reverse().map((job) => {
            const result = job.result as GenerationJobResult | undefined;
            return (
              <div className="generation-job" key={job.id}>
                <div className="generation-job-head">
                  <span>
                    <strong>{job.status}</strong>
                    <small>{job.message}</small>
                  </span>
                  {job.status === "running" && (
                    <button
                      onClick={() => void window.aidraw.jobCancel(job.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {["queued", "running"].includes(job.status) && (
                  <div className="job-progress">
                    <span
                      style={{ width: `${Math.round(job.progress * 100)}%` }}
                    />
                  </div>
                )}
                {job.error && (
                  <div className="job-error">{job.error.message}</div>
                )}
                <div className="result-grid">
                  {result?.outputs?.map((output) => (
                    <div className="result-card" key={output.id}>
                      <img
                        src={`data:${output.mimeType};base64,${output.data}`}
                        alt="Generated result"
                      />
                      <div className="result-card-actions">
                      {result.comparisonSource && <button onClick={() => setGenerationComparison({ jobId: job.id, source: result.comparisonSource!, output })}>Compare</button>}
                      <button disabled={result.acceptedOutputId === output.id} onClick={async () => {
                          const accepted = await window.aidraw.generationAccept(
                            job.id,
                            output.id,
                          );
                          notify(
                            accepted.accepted
                              ? (accepted.message ?? "Result added to the document.")
                              : (accepted.message ??
                                  "Could not accept result."),
                            accepted.accepted ? "success" : "error",
                          );
                        }}
                      >
                        {result.acceptedOutputId === output.id ? "Accepted" : `Accept as ${document.kind === "pixel" ? "cel" : "layer"}`}
                      </button>
                      <button className="reject-generation-result" disabled={result.acceptedOutputId === output.id} onClick={async () => { const rejected = await window.aidraw.generationReject(job.id, output.id); if (!rejected.rejected) notify(rejected.message ?? "Could not reject result.", "warning"); }}>Reject</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {generationComparison && <GenerationComparisonDialog
        source={generationComparison.source}
        output={generationComparison.output}
        onClose={() => setGenerationComparison(undefined)}
        onAccept={async () => {
          const accepted = await window.aidraw.generationAccept(generationComparison.jobId, generationComparison.output.id);
          notify(accepted.accepted ? accepted.message ?? "Result added to the document." : accepted.message ?? "Could not accept result.", accepted.accepted ? "success" : "error");
          if (accepted.accepted) setGenerationComparison(undefined);
        }}
        onReject={async () => {
          const rejected = await window.aidraw.generationReject(generationComparison.jobId, generationComparison.output.id);
          if (rejected.rejected) setGenerationComparison(undefined);
          else notify(rejected.message ?? "Could not reject result.", "warning");
        }}
      />}
    </div>
  );
}

function AssetsPanel({ document }: { document: AIDrawDocument }) {
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  if (document.kind === "illustration") {
    const assets = Object.values(document.assets);
    return (
      <div className="assets-panel">
        <div className="panel-title">
          <span>Assets</span>
          <button className="small-icon-button">+</button>
        </div>
        {assets.length === 0 ? (
          <div className="empty-panel">
            <Image size={28} />
            <span>Drop images, fonts, or generated results here.</span>
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => (
              <div className="asset-card" key={asset.id}>
                {asset.data && asset.mimeType.startsWith("image/") ? (
                  <img
                    src={`data:${asset.mimeType};base64,${asset.data}`}
                    alt=""
                  />
                ) : (
                  <Image size={20} />
                )}
                <strong>{asset.name}</strong>
                <small>{Math.ceil(asset.byteLength / 1024)} KiB</small>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  const assets = document.assetIds
    .map((id) => document.pixelAssets[id])
    .filter(Boolean);
  const addSprite = () =>
    void apply("Add sprite", [
      {
        kind: "pixel.asset.add",
        asset: createPixelSprite(
          `Sprite ${assets.filter((asset) => asset.type === "sprite").length + 1}`,
        ),
      },
    ]);
  const addTileset = () => {
    let sprite = assets.find((asset) => asset.type === "sprite");
    const operations: Parameters<typeof apply>[1] = [];
    if (!sprite || sprite.type !== "sprite") {
      sprite = createPixelSprite("Tileset pixels");
      operations.push({ kind: "pixel.asset.add", asset: sprite });
    }
    const columns = Math.max(1, Math.floor(sprite.width / 16));
    const rows = Math.max(1, Math.floor(sprite.height / 16));
    const tileset = createPixelTileset(
      `Tileset ${assets.filter((asset) => asset.type === "tileset").length + 1}`,
      sprite.id,
      16,
      16,
      columns,
      rows,
    );
    tileset.firstGid = assets
      .filter((asset) => asset.type === "tileset")
      .reduce(
        (next, asset) =>
          Math.max(next, asset.firstGid + asset.columns * asset.rows),
        1,
      );
    operations.push({ kind: "pixel.asset.add", asset: tileset });
    void apply("Add tileset", operations);
  };
  const addMap = () => {
    const map = createPixelTilemap(
      `Map ${assets.filter((asset) => asset.type === "tilemap").length + 1}`,
    );
    map.tilesetIds = assets
      .filter((asset) => asset.type === "tileset")
      .map((asset) => asset.id);
    void apply("Add tilemap", [{ kind: "pixel.asset.add", asset: map }]);
  };
  const packProject = () => {
    try {
      const linkedAssets = packPixelLinks(document);
      void apply("Pack project links", [
        { kind: "pixel.links.replace", linkedAssets, expectedRevision: document.revision },
      ]);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Project links could not be packed.",
        "warning",
      );
    }
  };
  const manageLink = async (linkId: string, action: PixelLinkAction) => {
    try {
      const result = await window.aidraw.managePixelLink(document.id, linkId, action);
      if (result.updated) notify(result.message ?? "Project link updated.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Project link could not be updated.", "error");
    }
  };
  return (
    <div className="assets-panel">
      <div className="panel-title">
        <span>Project assets</span>
        <span className="asset-add-actions">
          <button onClick={addSprite}>Sprite</button>
          <button onClick={addTileset}>Tileset</button>
          <button onClick={addMap}>Map</button>
        </span>
      </div>
      <div className="pixel-asset-list">
        {assets.map((asset) => (
          <button
            key={asset.id}
            className={asset.id === document.activeAssetId ? "is-active" : ""}
            onClick={() =>
              void apply("Select project asset", [
                { kind: "pixel.active-asset.set", assetId: asset.id },
              ])
            }
          >
            <span className={`asset-kind ${asset.type}`}>
              {asset.type === "sprite" ? (
                <Grid3X3 size={16} />
              ) : asset.type === "tilemap" ? (
                <Shapes size={16} />
              ) : (
                <Layers3 size={16} />
              )}
            </span>
            <span>
              <strong>{asset.name}</strong>
              <small>
                {asset.type === "sprite"
                  ? `${asset.width} × ${asset.height} · ${asset.frameIds.length} frames`
                  : asset.type === "tilemap"
                    ? `${asset.orientation} · ${asset.width} × ${asset.height}`
                    : `${asset.columns} × ${asset.rows} tiles`}
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className="pack-project-note">
        <strong>
          Linked project assets ·{" "}
          {
            document.linkedAssets.filter((link) => link.mode === "linked")
              .length
          }
        </strong>
        <small>
          External links retain relative paths, hashes, and cached source data.
          Pack Project embeds them for sharing.
        </small>
        {document.linkedAssets.length === 0 ? (
          <span className="project-link-empty">Imported Tiled sources will appear here.</span>
        ) : (
          <div className="project-link-list" aria-label="Linked project assets">
            {document.linkedAssets.map((link) => {
              const health = pixelLinkHealth(document, link);
              const status = health === "ready"
                ? link.mode === "embedded" ? "Embedded" : "Linked"
                : health === "hash-mismatch" ? "Hash mismatch"
                  : health === "missing-path" ? "Missing path" : "Missing cache";
              return (
                <div className="project-link-row" key={link.id}>
                  <span className="project-link-summary" title={link.relativePath ?? link.name}>
                    <strong>{link.name}</strong>
                    <small className={health === "ready" ? "is-ready" : "is-error"}>{status}</small>
                  </span>
                  <span className="project-link-actions">
                    {link.mode === "linked" ? (
                      <button type="button" disabled={health !== "ready"} onClick={() => void manageLink(link.id, "embed")}>Embed</button>
                    ) : (
                      <button type="button" disabled={health !== "ready"} onClick={() => void manageLink(link.id, "extract")}>Extract</button>
                    )}
                    <button type="button" onClick={() => void manageLink(link.id, "relink")}>Relink</button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <button
          disabled={
            !document.linkedAssets.some((link) => link.mode === "linked")
          }
          onClick={packProject}
        >
          Pack Project
        </button>
      </div>
    </div>
  );
}

function RightSidebar({
  document,
  collapsed,
  savedWidth,
  effectiveWidth,
  maximumEffectiveWidth,
  onResizePreview,
  onResizeCommit,
  onResizeCancel,
  onResetLayout,
}: {
  document: AIDrawDocument;
  collapsed: boolean;
  savedWidth: number;
  effectiveWidth: number;
  maximumEffectiveWidth: number;
  onResizePreview: (width: number) => void;
  onResizeCommit: (width: number) => void;
  onResizeCancel: () => void;
  onResetLayout: () => void;
}) {
  const panel = useEditorStore((state) => state.rightPanel);
  const visiblePanel = panel === "animation" && document.kind !== "illustration" ? "layers" : panel;
  const setPanel = useEditorStore((state) => state.setRightPanel);
  const apply = useEditorStore((state) => state.apply);
  const panelOrder: Array<"layers" | "assets" | "animation" | "activity" | "generation"> = document.kind === "illustration" ? ["layers", "assets", "animation", "activity", "generation"] : ["layers", "assets", "activity", "generation"];
  const handlePanelKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, panelOrder.indexOf(visiblePanel));
    const next = event.key === "Home" ? 0 : event.key === "End" ? panelOrder.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + panelOrder.length) % panelOrder.length;
    setPanel(panelOrder[next]);
    requestAnimationFrame(() => globalThis.document.getElementById(`inspector-tab-${panelOrder[next]}`)?.focus());
  };
  const addIllustrationLayer = (type: IllustrationLayer["type"]) =>
    void apply(`Add ${type} layer`, [
      {
        kind: "illustration.layer.add",
        layer: newIllustrationLayer(
          type,
          document.kind === "illustration" ? document.layerIds.length + 1 : 1,
        ),
      },
    ]);
  const addPixelLayer = (kind: "pixel" | "tile" | "object" | "group") => {
    if (document.kind !== "pixel") return;
    const asset = document.pixelAssets[document.activeAssetId];
    if (!asset || asset.type === "tileset") return;
    const next = structuredClone(asset);
    const timestamp = nowIso();
    if (next.type === "sprite") {
      const layer: PixelLayer = {
        id: createId("layer"),
        revision: 0,
        name:
          kind === "group"
            ? `Group ${next.layerIds.length + 1}`
            : `Pixels ${next.layerIds.length + 1}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id,
        type: kind === "group" ? "group" : "pixel",
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: "normal",
        childIds: kind === "group" ? [] : undefined,
      };
      next.layers[layer.id] = layer;
      next.layerIds.push(layer.id);
      if (layer.type === "pixel")
        for (const frameId of next.frameIds) {
          const id = createId("cel");
          next.cels[id] = {
            id,
            revision: 0,
            name: `${layer.name} · ${next.frames[frameId].name}`,
            createdAt: timestamp,
            updatedAt: timestamp,
            createdBy: HUMAN_ACTOR.id,
            layerId: layer.id,
            frameId,
            chunks: {},
          };
        }
    } else {
      const mapKind = kind === "pixel" ? "tile" : kind;
      const layer: TilemapLayer = {
        id: createId("map-layer"),
        revision: 0,
        name: `${mapKind === "tile" ? "Tiles" : mapKind === "object" ? "Objects" : "Group"} ${next.layerIds.length + 1}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id,
        type: mapKind,
        visible: true,
        locked: false,
        opacity: 1,
        chunks: mapKind === "tile" ? {} : undefined,
        objects: mapKind === "object" ? [] : undefined,
        childIds: mapKind === "group" ? [] : undefined,
        offsetX: 0,
        offsetY: 0,
        parallaxX: 1,
        parallaxY: 1,
      };
      next.layers[layer.id] = layer;
      next.layerIds.push(layer.id);
    }
    void apply("Add pixel layer", [
      {
        kind: "pixel.asset.replace",
        asset: next,
        expectedRevision: asset.revision,
      },
    ]);
  };
  return (
    <aside id="inspector-sidebar" className="right-sidebar" aria-label="Inspector sidebar" hidden={collapsed}>
      <InspectorLayoutControls
        collapsed={collapsed}
        savedWidth={savedWidth}
        effectiveWidth={effectiveWidth}
        maximumEffectiveWidth={maximumEffectiveWidth}
        onResizePreview={onResizePreview}
        onResizeCommit={onResizeCommit}
        onResizeCancel={onResizeCancel}
        onReset={onResetLayout}
      />
      <nav className="panel-tabs" role="tablist" aria-label="Inspector panels" onKeyDown={handlePanelKeys}>
        <button
          id="inspector-tab-layers"
          role="tab"
          aria-selected={visiblePanel === "layers"}
          aria-controls="inspector-panel"
          tabIndex={visiblePanel === "layers" ? 0 : -1}
          className={visiblePanel === "layers" ? "is-active" : ""}
          onClick={() => setPanel("layers")}
          title="Layers"
        >
          <Layers3 size={17} />
          <span>Layers</span>
        </button>
        <button
          id="inspector-tab-assets"
          role="tab"
          aria-selected={visiblePanel === "assets"}
          aria-controls="inspector-panel"
          tabIndex={visiblePanel === "assets" ? 0 : -1}
          className={visiblePanel === "assets" ? "is-active" : ""}
          onClick={() => setPanel("assets")}
          title="Assets"
        >
          <Image size={17} />
          <span>Assets</span>
        </button>
        {document.kind === "illustration" && <button
          id="inspector-tab-animation"
          role="tab"
          aria-selected={visiblePanel === "animation"}
          aria-controls="inspector-panel"
          tabIndex={visiblePanel === "animation" ? 0 : -1}
          className={visiblePanel === "animation" ? "is-active" : ""}
          onClick={() => setPanel("animation")}
          title="Animate"
        >
          <Play size={17} />
          <span>Animate</span>
        </button>}
        <button
          id="inspector-tab-activity"
          role="tab"
          aria-selected={visiblePanel === "activity"}
          aria-controls="inspector-panel"
          tabIndex={visiblePanel === "activity" ? 0 : -1}
          className={visiblePanel === "activity" ? "is-active" : ""}
          onClick={() => setPanel("activity")}
          title="Activity"
        >
          <ListTree size={17} />
          <span>Activity</span>
        </button>
        <button
          id="inspector-tab-generation"
          role="tab"
          aria-selected={visiblePanel === "generation"}
          aria-controls="inspector-panel"
          tabIndex={visiblePanel === "generation" ? 0 : -1}
          className={visiblePanel === "generation" ? "is-active" : ""}
          onClick={() => setPanel("generation")}
          title="Generate"
        >
          <Sparkles size={17} />
          <span>Generate</span>
        </button>
      </nav>
      <div id="inspector-panel" className="panel-content" role="tabpanel" aria-labelledby={`inspector-tab-${visiblePanel}`} tabIndex={0}>
        {visiblePanel === "layers" && (
          <>
            <div className="panel-title">
              <span>
                {document.kind === "pixel" ? "Layers & cels" : "Layers"}
              </span>
              {document.kind === "illustration" ? (
                <span className="layer-add-actions">
                  <button
                    title="Add vector layer"
                    onClick={() => addIllustrationLayer("vector")}
                  >
                    +V
                  </button>
                  <button
                    title="Add paint layer"
                    onClick={() => addIllustrationLayer("paint")}
                  >
                    +P
                  </button>
                  <button
                    title="Add group layer"
                    onClick={() => addIllustrationLayer("group")}
                  >
                    +G
                  </button>
                </span>
              ) : (
                <span className="layer-add-actions">
                  {document.pixelAssets[document.activeAssetId]?.type ===
                    "sprite" && (
                    <button
                      title="Add pixel layer"
                      onClick={() => addPixelLayer("pixel")}
                    >
                      +P
                    </button>
                  )}
                  {document.pixelAssets[document.activeAssetId]?.type ===
                    "tilemap" && (
                    <>
                      <button
                        title="Add tile layer"
                        onClick={() => addPixelLayer("tile")}
                      >
                        +T
                      </button>
                      <button
                        title="Add object layer"
                        onClick={() => addPixelLayer("object")}
                      >
                        +O
                      </button>
                    </>
                  )}
                  <button
                    disabled={
                      document.pixelAssets[document.activeAssetId]?.type ===
                      "tileset"
                    }
                    title="Add group layer"
                    onClick={() => addPixelLayer("group")}
                  >
                    +G
                  </button>
                </span>
              )}
            </div>
            {document.kind === "illustration" ? (
              <>
                <ArtboardInspector key={`${document.id}:${document.artboard.width}:${document.artboard.height}:${document.artboard.background}:${document.artboard.dpi}`} document={document} />
                <IllustrationLayers document={document} />
                <ObjectInspector document={document} />
              </>
            ) : (
              <PixelLayers document={document} />
            )}
            {document.kind === "pixel" && <PalettePanel document={document} />}
          </>
        )}
        {visiblePanel === "assets" && <AssetsPanel document={document} />}
        {visiblePanel === "animation" && document.kind === "illustration" && <IllustrationAnimationPanel document={document} />}
        {visiblePanel === "activity" && <ActivityPanel />}
        {visiblePanel === "generation" && <GenerationPanel document={document} />}
      </div>
    </aside>
  );
}

function StatusBar({ document }: { document: AIDrawDocument }) {
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const agents = useEditorStore((state) => state.snapshot?.mcp.sessions ?? []);
  return (
    <footer className="statusbar">
      <div className="status-mode">
        <span className={`mode-dot ${document.kind}`} />
        {document.kind === "pixel" ? "Pixel Art" : "Illustration"}
      </div>
      <span className="status-divider" />
      <span>
        {document.kind === "illustration"
          ? `${document.artboard.width} × ${document.artboard.height} px`
          : (() => {
              const asset = document.pixelAssets[document.activeAssetId];
              return asset?.type === "sprite"
                ? `${asset.width} × ${asset.height} px`
                : asset?.type === "tilemap"
                  ? `${asset.width} × ${asset.height} tiles`
                  : (asset?.type ?? "");
            })()}
      </span>
      {document.kind === "pixel" && (
        <>
          <span className="status-divider" />
          <span>Nearest · Integer coordinates</span>
        </>
      )}
      <div className="status-spacer" />
      {agents.length > 0 && (
        <div className="status-agents">
          {agents.slice(0, 4).map((entry) => (
            <span
              key={entry.actor.id}
              className="tiny-actor"
              role="img"
              aria-label={actorIdentityLabel(entry.actor)}
              style={{ "--actor": entry.actor.color } as React.CSSProperties}
              title={actorIdentityLabel(entry.actor)}
            >
              <Bot size={11} />
            </span>
          ))}
        </div>
      )}
      <button
        className="stop-agents"
        onClick={() => void window.aidraw.stopAgents(document.id)}
        disabled={agents.length === 0}
        aria-label="Stop all agents working on this document"
      >
        <OctagonX size={14} /> Stop All Agents
      </button>
      <div className="zoom-control">
        <button
          aria-label="Zoom out"
          onClick={() => setZoom(zoom / (document.kind === "pixel" ? 2 : 1.25))}
        >
          −
        </button>
        <input
          aria-label="Canvas zoom"
          type="range"
          min={document.kind === "pixel" ? 1 : 5}
          max={document.kind === "pixel" ? 6400 : 800}
          value={Math.round(zoom * 100)}
          onChange={(event) => setZoom(Number(event.target.value) / 100)}
        />
        <button
          aria-label="Zoom in"
          onClick={() => setZoom(zoom * (document.kind === "pixel" ? 2 : 1.25))}
        >
          +
        </button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      </div>
    </footer>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <span className="brand-mark large">
        <span />
        <span />
        <span />
      </span>
      <strong>Warming up the canvas…</strong>
    </div>
  );
}

function focusInspectorToggle(): void {
  window.requestAnimationFrame(() => globalThis.document.getElementById("inspector-toggle-button")?.focus());
}

function focusActiveInspectorTab(): void {
  window.requestAnimationFrame(() => {
    const state = useEditorStore.getState();
    const panel = state.rightPanel === "animation" && state.snapshot?.activeDocument?.kind !== "illustration"
      ? "layers"
      : state.rightPanel;
    globalThis.document.getElementById(`inspector-tab-${panel}`)?.focus();
  });
}

function toggleInspectorAndMoveFocus(): void {
  const state = useEditorStore.getState();
  const nextCollapsed = !state.workspaceLayoutPreferences.inspectorCollapsed;
  state.setWorkspaceLayoutPreferences({
    ...state.workspaceLayoutPreferences,
    inspectorCollapsed: nextCollapsed,
  });
  if (nextCollapsed) focusInspectorToggle();
  else focusActiveInspectorTab();
}

export function App() {
  const initialize = useEditorStore((state) => state.initialize);
  const snapshot = useEditorStore((state) => state.snapshot);
  const loading = useEditorStore((state) => state.loading);
  const toast = useEditorStore((state) => state.toast);
  const canvasAnimation = useEditorStore((state) => state.canvasAnimation);
  const workspaceLayoutPreferences = useEditorStore((state) => state.workspaceLayoutPreferences);
  const setWorkspaceLayoutPreferences = useEditorStore((state) => state.setWorkspaceLayoutPreferences);
  const shortcutPreferences = useEditorStore((state) => state.shortcutPreferences);
  const setShortcutPreferences = useEditorStore((state) => state.setShortcutPreferences);
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [inspectorResizePreview, setInspectorResizePreview] = useState<number>();
  const cancelInspectorResize = useCallback(() => setInspectorResizePreview(undefined), []);
  const document = snapshot?.activeDocument;
  const canvasDocument = useMemo(() => document?.kind === "illustration" && canvasAnimation?.illustrationTimeMs !== undefined ? illustrationAtTime(document, canvasAnimation.illustrationTimeMs) : document, [canvasAnimation, document]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const measure = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const onShortcutHelp = (event: KeyboardEvent) => {
      if (!shortcutHelpRequested(event)) return;
      if (event.key !== "F1" && (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )) return;
      if (globalThis.document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      setShortcutReferenceOpen(true);
    };
    window.addEventListener("keydown", onShortcutHelp);
    return () => window.removeEventListener("keydown", onShortcutHelp);
  }, []);

  useEffect(() => {
    const publish = (state = useEditorStore.getState()) => {
      void window.aidraw.updateEditorAdvisory({
        documentId: state.snapshot?.activeDocumentId,
        tool: state.selectedTool,
        selectedEntityIds: state.selectedEntityIds,
        zoom: state.zoom,
        viewport: state.canvasViewport,
        animation: state.canvasAnimation,
      }).catch(() => undefined);
    };
    publish();
    return useEditorStore.subscribe((state, previous) => {
      if (state.snapshot?.activeDocumentId !== previous.snapshot?.activeDocumentId || state.selectedTool !== previous.selectedTool || state.selectedEntityIds !== previous.selectedEntityIds || state.zoom !== previous.zoom || state.canvasViewport !== previous.canvasViewport || state.canvasAnimation !== previous.canvasAnimation) publish(state);
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (globalThis.document.querySelector('[aria-modal="true"]')) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        return;
      const shortcutState = useEditorStore.getState();
      const shortcutMode = shortcutState.snapshot?.activeDocument?.kind ?? "illustration";
      if (shortcutActionForEvent(shortcutState.shortcutPreferences, event, shortcutMode, "application")?.id === "toggle-inspector") {
        event.preventDefault();
        cancelInspectorResize();
        toggleInspectorAndMoveFocus();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        const state = useEditorStore.getState();
        const active = state.snapshot?.activeDocument;
        if (active?.kind === "pixel") {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent("aidraw:pixel-selection-command", { detail: "delete" }));
          return;
        }
        if (active?.kind === "illustration" && state.selectedEntityIds.length) {
          event.preventDefault();
          void state.apply(
            "Delete objects",
            state.selectedEntityIds
              .filter((id) => active.objects[id])
              .map((id) => ({
                kind: "illustration.object.delete",
                objectId: id,
                expectedRevision: active.objects[id].revision,
              })),
          );
          state.setSelectedEntities([]);
        }
        return;
      }
      if (event.key === "Escape") {
        const active = useEditorStore.getState().snapshot?.activeDocument;
        if (active?.kind === "pixel") window.dispatchEvent(new CustomEvent("aidraw:pixel-selection-command", { detail: "clear" }));
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void useEditorStore.getState().save(event.shiftKey);
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void useEditorStore.getState().open();
      }
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey
          ? useEditorStore.getState().redo()
          : useEditorStore.getState().undo());
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        void useEditorStore.getState().redo();
      }
      if (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x") {
        event.preventDefault();
        const state = useEditorStore.getState();
        const active = state.snapshot?.activeDocument;
        if (active?.kind === "pixel") {
          window.dispatchEvent(new CustomEvent("aidraw:pixel-selection-command", { detail: event.key.toLowerCase() === "x" ? "cut" : "copy" }));
          return;
        }
        void window.aidraw
          .copySelection(state.selectedEntityIds)
          .then((result) => {
            if (result.copied)
              state.notify("Copied editable artwork, SVG, and PNG.", "success");
          });
        if (event.key.toLowerCase() === "x") {
          const active = state.snapshot?.activeDocument;
          if (active?.kind === "illustration") {
            void state.apply(
              "Cut objects",
              state.selectedEntityIds
                .filter((id) => active.objects[id])
                .map((id) => ({
                  kind: "illustration.object.delete",
                  objectId: id,
                  expectedRevision: active.objects[id].revision,
                })),
            );
            state.setSelectedEntities([]);
          }
        }
      }
      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        if (useEditorStore.getState().snapshot?.activeDocument?.kind === "pixel") {
          window.dispatchEvent(new CustomEvent("aidraw:pixel-selection-command", { detail: "paste" }));
          return;
        }
        void window.aidraw
          .pasteClipboard()
          .then((response) =>
            useEditorStore
              .getState()
              .notify(
                response.status === "committed"
                  ? "Pasted editable artwork."
                  : (response.message ?? "Nothing to paste."),
                response.status === "committed" ? "success" : "warning",
              ),
          );
      }
      if (event.key.toLowerCase() === "a" && useEditorStore.getState().snapshot?.activeDocument?.kind === "pixel") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("aidraw:pixel-selection-command", { detail: "select-all" }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelInspectorResize]);

  const title = useMemo(
    () =>
      document
        ? `${document.dirty ? "• " : ""}${document.name} — AIDraw`
        : "AIDraw",
    [document],
  );
  useEffect(() => {
    globalThis.document.title = title;
  }, [title]);

  if (loading || !document) return <LoadingScreen />;
  const requestedInspectorWidth = inspectorResizePreview ?? workspaceLayoutPreferences.inspectorExpandedWidth;
  const shownInspectorWidth = workspaceLayoutPreferences.inspectorCollapsed
    ? 0
    : effectiveInspectorWidth(requestedInspectorWidth, viewportWidth);
  const maximumShownInspectorWidth = effectiveInspectorWidth(MAX_INSPECTOR_EXPANDED_WIDTH, viewportWidth);
  const shellStyle = {
    "--shell-sidebar-effective-width": `${shownInspectorWidth}px`,
  } as CSSProperties;
  return (
    <div className={`app-shell${workspaceLayoutPreferences.inspectorCollapsed ? " is-inspector-collapsed" : ""}`} style={shellStyle}>
      <button type="button" className="skip-to-canvas" onClick={() => globalThis.document.getElementById("aidraw-canvas")?.focus()}>Skip to canvas</button>
      <span id="aidraw-canvas-keyboard-help" className="visually-hidden">Press F1 for keyboard shortcuts. Use the focus-visible Skip to canvas control to return directly to this drawing surface.</span>
      <TopBar
        inspectorCollapsed={workspaceLayoutPreferences.inspectorCollapsed}
        onOpenShortcuts={() => setShortcutReferenceOpen(true)}
        onToggleInspector={() => {
          cancelInspectorResize();
          toggleInspectorAndMoveFocus();
        }}
        onOpenAgentActivity={() => {
          cancelInspectorResize();
          const state = useEditorStore.getState();
          state.setRightPanel("activity");
          if (state.workspaceLayoutPreferences.inspectorCollapsed) {
            state.setWorkspaceLayoutPreferences({ ...state.workspaceLayoutPreferences, inspectorCollapsed: false });
            focusActiveInspectorTab();
          }
        }}
      />
      <ContextBar document={document} />
      <ToolRail document={document} />
      <main className="canvas-workspace">
        {canvasDocument?.kind === "illustration" ? (
          <IllustrationCanvas key={canvasDocument.id} document={canvasDocument} />
        ) : (
          <PixelCanvas key={canvasDocument?.id} document={canvasDocument as PixelDocument} />
        )}
      </main>
      <RightSidebar
        document={document}
        collapsed={workspaceLayoutPreferences.inspectorCollapsed}
        savedWidth={workspaceLayoutPreferences.inspectorExpandedWidth}
        effectiveWidth={shownInspectorWidth}
        maximumEffectiveWidth={maximumShownInspectorWidth}
        onResizePreview={setInspectorResizePreview}
        onResizeCancel={cancelInspectorResize}
        onResizeCommit={(inspectorExpandedWidth) => setWorkspaceLayoutPreferences({
          ...workspaceLayoutPreferences,
          inspectorExpandedWidth,
        })}
        onResetLayout={() => {
          cancelInspectorResize();
          setWorkspaceLayoutPreferences({ ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES });
        }}
      />
      <StatusBar document={document} />
      {shortcutReferenceOpen && <ShortcutReferenceDialog
        mode={document.kind === "illustration" ? "illustration" : "pixel"}
        preferences={shortcutPreferences}
        onChange={setShortcutPreferences}
        onClose={() => setShortcutReferenceOpen(false)}
      />}
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}

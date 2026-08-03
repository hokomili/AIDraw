import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
  PixelDocument,
  PixelLayer,
  PixelSprite,
  PixelTileset,
  TilemapLayer,
  WangSet,
} from "@aidraw/core";
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  resizePixelSpriteCanvas,
} from "@aidraw/core";
import type {
  GenerationJobResult,
  GenerationMode,
  GenerationProvider,
} from "../common/generation";
import { approximateLocalObjectBounds } from "../common/illustration-geometry";
import { buildPolishedGoldMaterial } from "../common/material-presets";
import type {
  EngineStatus,
  NewDocumentKind,
  NewDocumentOptions,
} from "../common/contracts";
import { IllustrationCanvas } from "./canvas/IllustrationCanvas";
import { PixelCanvas } from "./canvas/PixelCanvas";
import { useEditorStore, type EditorTool } from "./store";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

interface ToolDefinition {
  id: EditorTool;
  label: string;
  icon: Icon;
  shortcut?: string;
}

const commonTools: ToolDefinition[] = [
  { id: "select", label: "Select", icon: MousePointer2, shortcut: "V" },
  { id: "lasso", label: "Lasso", icon: Lasso, shortcut: "L" },
  { id: "hand", label: "Pan", icon: Hand, shortcut: "H" },
  { id: "zoom", label: "Zoom", icon: ZoomIn, shortcut: "Z" },
];

const illustrationTools: ToolDefinition[] = [
  ...commonTools,
  { id: "pen", label: "Pressure pen", icon: PenTool, shortcut: "P" },
  { id: "pencil", label: "Vector pencil", icon: Pencil, shortcut: "N" },
  { id: "bezier", label: "Bézier path", icon: PenTool, shortcut: "A" },
  { id: "node", label: "Node editor", icon: MousePointer2 },
  { id: "brush", label: "Raster brush", icon: Brush, shortcut: "B" },
  { id: "eraser", label: "Eraser", icon: Eraser, shortcut: "E" },
  { id: "line", label: "Line / arrow", icon: Minus, shortcut: "\\" },
  { id: "rectangle", label: "Rectangle", icon: Square, shortcut: "R" },
  { id: "ellipse", label: "Ellipse", icon: Circle, shortcut: "O" },
  { id: "polygon", label: "Polygon", icon: Shapes },
  { id: "star", label: "Star", icon: Star },
  { id: "gradient", label: "Gradient", icon: Palette },
  { id: "crop", label: "Image crop", icon: Crop },
  { id: "text", label: "Text", icon: Type, shortcut: "T" },
  { id: "eyedropper", label: "Eyedropper", icon: Pipette, shortcut: "I" },
];

const pixelTools: ToolDefinition[] = [
  ...commonTools,
  { id: "pencil", label: "Pixel-perfect pencil", icon: Pencil, shortcut: "B" },
  { id: "eraser", label: "Eraser", icon: Eraser, shortcut: "E" },
  { id: "fill", label: "Fill", icon: PaintBucket, shortcut: "G" },
  { id: "replace", label: "Replace color", icon: Palette },
  { id: "line", label: "Pixel line", icon: Minus },
  { id: "rectangle", label: "Pixel rectangle", icon: Square },
  { id: "ellipse", label: "Pixel ellipse", icon: Circle },
  { id: "wand", label: "Magic wand", icon: WandSparkles, shortcut: "W" },
  { id: "stamp", label: "Stamp", icon: Stamp },
  { id: "terrain", label: "Wang terrain", icon: Shapes },
  { id: "dither", label: "Ordered dither", icon: Grid3X3 },
  { id: "lighten", label: "Lighten", icon: SunMedium },
  { id: "darken", label: "Darken", icon: Moon },
  { id: "text", label: "Bitmap text", icon: Type },
  { id: "eyedropper", label: "Palette picker", icon: Pipette, shortcut: "I" },
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(surfaceRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
        aria-labelledby={`${className}-title`}
      >
        <header className="modal-header">
          <div>
            <strong id={`${className}-title`}>{title}</strong>
            {description && <p>{description}</p>}
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
  const definition = newDocumentDefinitions.find(
    (entry) => entry.kind === kind,
  )!;

  const chooseKind = (next: NewDocumentKind) => {
    const defaults = newDocumentDefinitions.find(
      (entry) => entry.kind === next,
    )!;
    setKind(next);
    setWidth(String(defaults.width));
    setHeight(String(defaults.height));
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const options: NewDocumentOptions = {
      kind,
      name: name.trim() || undefined,
      width: pixelDimension(width, definition.width),
      height: pixelDimension(height, definition.height),
    };
    if (kind === "illustration")
      options.background =
        backgroundMode === "transparent" ? null : backgroundColor;
    if (kind === "tilemap") {
      options.orientation = orientation;
      options.infinite = infinite;
      options.tileWidth = pixelDimension(tileWidth, 16);
      options.tileHeight = pixelDimension(tileHeight, 16);
    }
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

function DocumentTabs() {
  const snapshot = useEditorStore((state) => state.snapshot);
  const activate = useEditorStore((state) => state.activate);
  const [creating, setCreating] = useState<NewDocumentKind>();
  const [showAll, setShowAll] = useState(false);
  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const viewportRef = useRef<HTMLDivElement>(null);
  const allTabsRef = useRef<HTMLDivElement>(null);
  const documents = snapshot?.documents ?? [];

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
    if (!showAll) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!allTabsRef.current?.contains(event.target as Node))
        setShowAll(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAll(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showAll]);

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(220, viewport.clientWidth * 0.72),
      behavior: "smooth",
    });
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
        {documents.map((document) => (
          <button
            key={document.id}
            className={`document-tab ${document.id === snapshot?.activeDocumentId ? "is-active" : ""}`}
            onClick={() => void activate(document.id)}
            role="tab"
            title={document.name}
            aria-selected={document.id === snapshot?.activeDocumentId}
          >
            <span className={`mode-dot ${document.kind}`} />
            <span className="document-tab-name">{document.name}</span>
            {document.dirty && (
              <span className="dirty-dot" aria-label="Unsaved changes" />
            )}
            <span
              role="button"
              tabIndex={0}
              className="tab-close"
              aria-label={`Close ${document.name}`}
              onClick={(event) => {
                event.stopPropagation();
                void window.aidraw.closeDocument(document.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ")
                  void window.aidraw.closeDocument(document.id);
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
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
          className={`all-tabs-button ${showAll ? "is-active" : ""}`}
          aria-label="All open documents"
          aria-expanded={showAll}
          title={`${documents.length} open documents`}
          onClick={() => setShowAll((value) => !value)}
        >
          <span>{documents.length}</span>
          <ChevronDown size={13} />
        </button>
        {showAll && (
          <div
            className="all-tabs-menu popover"
            role="menu"
            aria-label="All open documents"
          >
            <div className="popover-title">
              {documents.length} open documents
            </div>
            <div className="all-tabs-list">
              {documents.map((document) => (
                <button
                  type="button"
                  role="menuitem"
                  className={
                    document.id === snapshot?.activeDocumentId
                      ? "is-active"
                      : ""
                  }
                  key={document.id}
                  title={document.name}
                  onClick={() => {
                    setShowAll(false);
                    void activate(document.id);
                  }}
                >
                  <span className={`mode-dot ${document.kind}`} />
                  <span>{document.name}</span>
                  {document.dirty && (
                    <span className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                </button>
              ))}
            </div>
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
      </div>
    </div>
  );
}

function TopBar() {
  const open = useEditorStore((state) => state.open);
  const save = useEditorStore((state) => state.save);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.snapshot?.canUndo);
  const canRedo = useEditorStore((state) => state.snapshot?.canRedo);
  const snapshot = useEditorStore((state) => state.snapshot);
  const notify = useEditorStore((state) => state.notify);
  const [exporting, setExporting] = useState(false);
  const [exportScale, setExportScale] = useState(1);
  const document = snapshot?.activeDocument;
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
      : ["png", "jpeg", "webp", "svg", "pdf", "psd"];

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
          onClick={() => void open()}
        >
          <FolderOpen size={17} />
        </button>
        <button
          className="icon-button"
          title="Import artwork"
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
        <button
          className="icon-button"
          title="Save (Ctrl+S)"
          onClick={() => void save()}
        >
          <Save size={17} />
        </button>
        <div className="export-menu-wrap">
          <button
            className="icon-button"
            title="Export"
            onClick={() => setExporting((value) => !value)}
          >
            <Download size={16} />
          </button>
          {exporting && (
            <div className="export-menu popover">
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
              {exportChoices.map((format) => {
                const scalable =
                  document?.kind === "pixel" &&
                  !["psd", "tiled-json", "tiled-xml"].includes(format);
                const scale = scalable ? exportScale : 1;
                return (
                  <button
                    key={format}
                    onClick={async () => {
                      setExporting(false);
                      const result = await window.aidraw.exportActiveDocument(
                        format as Parameters<
                          typeof window.aidraw.exportActiveDocument
                        >[0],
                        { scale },
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
                    {scale > 1 && <small>{scale}×</small>}
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
          onClick={() => void undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          className="icon-button"
          disabled={!canRedo}
          title="Redo my action (Ctrl+Y)"
          onClick={() => void redo()}
        >
          <Redo2 size={17} />
        </button>
      </div>
      <DocumentTabs />
      <div className="topbar-right">
        <button
          className="agent-pill"
          onClick={() => useEditorStore.getState().setRightPanel("activity")}
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
  const tools = document.kind === "pixel" ? pixelTools : illustrationTools;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      const match = tools.find(
        (tool) => tool.shortcut?.toLowerCase() === event.key.toLowerCase(),
      );
      if (match) setTool(match.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTool, tools]);

  return (
    <aside className="tool-rail" aria-label={`${document.kind} tools`}>
      {tools.map((tool, index) => {
        const IconComponent = tool.icon;
        const divider =
          index === commonTools.length ||
          (document.kind === "illustration" && index === 8);
        return (
          <div key={tool.id} className={divider ? "tool-divider" : undefined}>
            <button
              className={`tool-button ${selectedTool === tool.id ? "is-active" : ""}`}
              onClick={() => setTool(tool.id)}
              title={`${tool.label}${tool.shortcut ? ` (${tool.shortcut})` : ""}`}
              aria-label={tool.label}
              aria-pressed={selectedTool === tool.id}
            >
              <IconComponent size={19} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
    </aside>
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

  return (
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
                  onChange={(event) =>
                    setBrushPreset(event.target.value as typeof brushPreset)
                  }
                >
                  <option value="hard-round">Hard round</option>
                  <option value="soft-round">Soft round</option>
                  <option value="pencil">Pencil</option>
                  <option value="marker">Marker</option>
                  <option value="airbrush">Airbrush</option>
                  <option value="eraser">Eraser</option>
                </select>
              </label>
            )}
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
        </>
      )}
      {document.kind === "pixel" && (
        <span className="mode-chip">
          <Grid3X3 size={13} /> Pixel rules on
        </span>
      )}
    </div>
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

function ObjectInspector({ document }: { document: IllustrationDocument }) {
  const selectedIds = useEditorStore((state) => state.selectedEntityIds);
  const setSelected = useEditorStore((state) => state.setSelectedEntities);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  const primaryColor = useEditorStore((state) => state.primaryColor);
  const secondaryColor = useEditorStore((state) => state.secondaryColor);
  const objects = selectedIds.map((id) => document.objects[id]).filter(Boolean);
  const object = objects.at(-1);
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
    const operations = objects.map((entry) => {
      const bounds = objectBounds(entry);
      const transform = { ...entry.transform };
      if (mode === "left") transform.x += -bounds.x;
      if (mode === "center-x")
        transform.x +=
          document.artboard.width / 2 - (bounds.x + bounds.width / 2);
      if (mode === "right")
        transform.x += document.artboard.width - (bounds.x + bounds.width);
      if (mode === "top") transform.y += -bounds.y;
      if (mode === "center-y")
        transform.y +=
          document.artboard.height / 2 - (bounds.y + bounds.height / 2);
      if (mode === "bottom")
        transform.y += document.artboard.height - (bounds.y + bounds.height);
      return {
        kind: "illustration.object.replace" as const,
        object: { ...entry, transform },
        expectedRevision: entry.revision,
      };
    });
    void apply(`Align ${mode}`, operations);
  };
  const distribute = (axis: "x" | "y") => {
    if (objects.length < 3) {
      notify("Select at least three objects to distribute them.", "warning");
      return;
    }
    const sorted = [...objects].sort((a, b) =>
      axis === "x"
        ? objectBounds(a).x - objectBounds(b).x
        : objectBounds(a).y - objectBounds(b).y,
    );
    const first = objectBounds(sorted[0]);
    const last = objectBounds(sorted.at(-1)!);
    const start =
      axis === "x" ? first.x + first.width / 2 : first.y + first.height / 2;
    const end =
      axis === "x" ? last.x + last.width / 2 : last.y + last.height / 2;
    const operations = sorted.map((entry, index) => {
      const bounds = objectBounds(entry);
      const wanted = start + ((end - start) * index) / (sorted.length - 1);
      const transform = { ...entry.transform };
      if (axis === "x") transform.x += wanted - (bounds.x + bounds.width / 2);
      else transform.y += wanted - (bounds.y + bounds.height / 2);
      return {
        kind: "illustration.object.replace" as const,
        object: { ...entry, transform },
        expectedRevision: entry.revision,
      };
    });
    void apply(`Distribute ${axis}`, operations);
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
      const { createBooleanPath } = await import("./canvas/path-boolean");
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
      <div className="align-grid">
        <button onClick={() => align("left")}>Left</button>
        <button onClick={() => align("center-x")}>Center X</button>
        <button onClick={() => align("right")}>Right</button>
        <button onClick={() => align("top")}>Top</button>
        <button onClick={() => align("center-y")}>Center Y</button>
        <button onClick={() => align("bottom")}>Bottom</button>
        <button onClick={() => distribute("x")}>Distribute X</button>
        <button onClick={() => distribute("y")}>Distribute Y</button>
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
          {Object.values(document.objects)
            .filter((entry) => entry.id !== object.id)
            .map((entry) => (
              <option value={entry.id} key={entry.id}>
                {entry.name}
              </option>
            ))}
        </select>
      </label>
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
      {object.type === "text" && (
        <>
          <div className="section-heading">
            <span>Typography</span>
          </div>
          <label className="field">
            <span>Text</span>
            <textarea
              value={object.text}
              onChange={(event) =>
                replace(
                  {
                    ...object,
                    text: event.target.value,
                    ranges: object.ranges.map((range) => ({
                      ...range,
                      end: event.target.value.length,
                    })),
                  },
                  "Edit text",
                )
              }
            />
          </label>
          <div className="two-fields">
            <label className="field">
              <span>Font</span>
              <input
                value={object.ranges[0]?.fontFamily ?? "Segoe UI"}
                onChange={(event) =>
                  replace(
                    {
                      ...object,
                      ranges: object.ranges.map((range) => ({
                        ...range,
                        fontFamily: event.target.value,
                      })),
                    },
                    "Change font",
                  )
                }
              />
            </label>
            <label className="field">
              <span>Size</span>
              <input
                type="number"
                value={object.ranges[0]?.fontSize ?? 48}
                onChange={(event) =>
                  replace(
                    {
                      ...object,
                      ranges: object.ranges.map((range) => ({
                        ...range,
                        fontSize: Number(event.target.value),
                      })),
                    },
                    "Change font size",
                  )
                }
              />
            </label>
          </div>
        </>
      )}
      {object.type === "image" && (
        <>
          <div className="section-heading">
            <span>Image filters</span>
          </div>
          <div className="filter-grid">
            {(
              ["brightness", "contrast", "saturation", "hue", "blur"] as const
            ).map((type) => (
              <label key={type}>
                <span>{type}</span>
                <input
                  type="range"
                  min={type === "hue" ? -180 : type === "blur" ? 0 : -1}
                  max={type === "hue" ? 180 : type === "blur" ? 40 : 1}
                  step={type === "hue" ? 1 : 0.05}
                  value={
                    object.filters.find((filter) => filter.type === type)
                      ?.value ?? 0
                  }
                  onChange={(event) =>
                    replace(
                      {
                        ...object,
                        filters: [
                          ...object.filters.filter(
                            (filter) => filter.type !== type,
                          ),
                          { type, value: Number(event.target.value) },
                        ],
                      },
                      `Change ${type}`,
                    )
                  }
                />
              </label>
            ))}
          </div>
          <button
            className="crop-button"
            onClick={() =>
              replace(
                {
                  ...object,
                  crop: object.crop
                    ? undefined
                    : {
                        x: object.width * 0.1,
                        y: object.height * 0.1,
                        width: object.width * 0.8,
                        height: object.height * 0.8,
                      },
                },
                object.crop ? "Reset image crop" : "Crop image",
              )
            }
          >
            {object.crop ? "Reset crop" : "Inset crop 10%"}
          </button>
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

function PixelLayers({ document }: { document: PixelDocument }) {
  const asset = document.pixelAssets[document.activeAssetId];
  const selected = useEditorStore((state) => state.selectedEntityId);
  const setSelected = useEditorStore((state) => state.setSelectedEntity);
  const apply = useEditorStore((state) => state.apply);
  const notify = useEditorStore((state) => state.notify);
  if (!asset) return <div className="empty-panel">No active pixel asset.</div>;
  const layers =
    asset.type === "sprite"
      ? Object.values(asset.layers ?? {})
      : asset.type === "tilemap"
        ? Object.values(asset.layers ?? {})
        : [];
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
  const moveLayer = (layer: PixelLayer | TilemapLayer, parentId?: string) => {
    const next = structuredClone(asset);
    if (next.type !== "sprite" && next.type !== "tilemap") return;
    const table = next.layers as Record<string, PixelLayer | TilemapLayer>;
    const moving = table[layer.id];
    if (!moving) return;
    next.layerIds = next.layerIds.filter((id) => id !== layer.id);
    for (const current of Object.values(table))
      if (current.childIds)
        current.childIds = current.childIds.filter((id) => id !== layer.id);
    moving.parentId = parentId;
    if (parentId) {
      const parent = table[parentId];
      if (parent?.type !== "group") return;
      parent.childIds = [...(parent.childIds ?? []), layer.id];
    } else next.layerIds.push(layer.id);
    updateAsset(next, "Move layer");
  };
  const descendants = (id: string): Set<string> => {
    const result = new Set<string>();
    const visit = (currentId: string) => {
      const current =
        asset.type === "sprite"
          ? asset.layers[currentId]
          : asset.type === "tilemap"
            ? asset.layers[currentId]
            : undefined;
      for (const childId of current?.childIds ?? []) {
        result.add(childId);
        visit(childId);
      }
    };
    visit(id);
    return result;
  };
  const selectedLayer = layers.find((layer) => layer.id === selected);
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
      <div className="panel-list layer-list">
        {[...layers].reverse().map((layer) => (
          <div
            key={layer.id}
            className={`layer-row ${selected === layer.id ? "is-selected" : ""}`}
            style={{ marginLeft: layer.parentId ? 14 : 0 }}
          >
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
  const replace = (next: PixelTileset, label: string) =>
    void apply(label, [
      {
        kind: "pixel.asset.replace",
        asset: next,
        expectedRevision: tileset.revision,
      },
    ]);
  const addTerrain = () => {
    const next = structuredClone(tileset);
    const terrainId = next.wangSets.length + 1;
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
    next.wangSets.push(wangSet);
    replace(next, "Add Wang terrain");
  };
  const addCollision = () => {
    const next = structuredClone(tileset);
    const tile = next.tiles[0] ?? {
      id: 0,
      sourceX: 0,
      sourceY: 0,
      probability: 1,
      animation: [],
      collisions: [],
      properties: {},
    };
    tile.collisions.push({
      id: createId("collision"),
      type: "rectangle",
      x: 0,
      y: 0,
      width: next.tileWidth,
      height: next.tileHeight,
      properties: {},
    });
    next.tiles[0] = tile;
    replace(next, "Add tile collision");
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
      <div className="two-fields">
        <label className="field">
          <span>Tile width</span>
          <input
            type="number"
            min="1"
            value={tileset.tileWidth}
            onChange={(event) =>
              replace(
                {
                  ...tileset,
                  tileWidth: Math.max(1, Number(event.target.value)),
                },
                "Resize tiles",
              )
            }
          />
        </label>
        <label className="field">
          <span>Tile height</span>
          <input
            type="number"
            min="1"
            value={tileset.tileHeight}
            onChange={(event) =>
              replace(
                {
                  ...tileset,
                  tileHeight: Math.max(1, Number(event.target.value)),
                },
                "Resize tiles",
              )
            }
          />
        </label>
      </div>
      <div className="section-heading">
        <span>Wang terrain</span>
        <small>{tileset.wangSets.length}</small>
      </div>
      {tileset.wangSets.map((set) => (
        <div className="terrain-row" key={set.id}>
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
        </div>
      ))}
      <div className="tileset-actions">
        <button onClick={addTerrain}>+ Terrain</button>
        <button onClick={addCollision}>+ Tile 1 collision</button>
      </div>
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
        animation, properties, and collision data export through Tiled JSON.
      </p>
    </div>
  );
}

function PalettePanel({ document }: { document: PixelDocument }) {
  const index = useEditorStore((state) => state.pixelIndex);
  const setIndex = useEditorStore((state) => state.setPixelIndex);
  const setColor = useEditorStore((state) => state.setColor);
  const apply = useEditorStore((state) => state.apply);
  const selected = document.palette[index] ?? document.palette[0];
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
  return (
    <section className="palette-section">
      <div className="section-heading">
        <span>Indexed palette</span>
        <small>{document.palette.length}/256</small>
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
  );
}

type CodexSetupResult = {
  status: "configured" | "cancelled" | "manual";
  message: string;
};

function CodexSetupResultDialog({
  result,
  onClose,
}: {
  result: CodexSetupResult;
  onClose: () => void;
}) {
  const configured = result.status === "configured";
  return (
    <ModalShell
      title={
        configured
          ? "Restart Codex to finish"
          : "Codex connection needs attention"
      }
      description={
        configured
          ? "AIDraw is configured. One required step remains before new tasks can use it."
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
              : "Automatic setup did not finish"}
          </strong>
          <p>{result.message}</p>
        </div>
        {configured && (
          <div className="restart-required">
            <span>Required next step</span>
            <strong>Fully quit and restart Codex</strong>
            <p>
              After restarting, every new local Codex task can discover AIDraw’s
              MCP tools. The AIDraw engine may continue running headlessly.
            </p>
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
          {configured ? "I’ll restart Codex" : "Close"}
        </button>
      </footer>
    </ModalShell>
  );
}

function ActivityPanel() {
  const snapshot = useEditorStore((state) => state.snapshot);
  const notify = useEditorStore((state) => state.notify);
  const playbacks = useEditorStore((state) => state.playbacks);
  const document = snapshot?.activeDocument;
  const sessions = snapshot?.mcp.sessions ?? [];
  const [credentials, setCredentials] = useState<{
    url?: string;
    token: string;
  }>();
  const [setupResult, setSetupResult] = useState<CodexSetupResult>();
  const [configuring, setConfiguring] = useState(false);
  const [engine, setEngine] = useState<EngineStatus>();
  useEffect(() => {
    void window.aidraw.getEngineStatus().then(setEngine);
  }, []);
  if (!document) return null;
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
          {engine?.startsAtLogin ? "Starts with Windows" : "Start with Windows"}
        </button>
      </div>
      <div className="connection-actions">
        <button
          disabled={configuring}
          onClick={async () => {
            setConfiguring(true);
            try {
              const result = await window.aidraw.configureCodex();
              if (result.status === "cancelled") notify(result.message, "info");
              else setSetupResult(result);
              setEngine(await window.aidraw.getEngineStatus());
            } finally {
              setConfiguring(false);
            }
          }}
        >
          <Bot size={13} /> {configuring ? "Connecting…" : "Connect Codex"}
        </button>
        <button
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
              {session.status} · {session.queueDepth} queued
            </small>
          </span>
        </div>
      ))}
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
                  {entry.actor.name} ·{" "}
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
        <CodexSetupResultDialog
          result={setupResult}
          onClose={() => setSetupResult(undefined)}
        />
      )}
    </div>
  );
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
  const [providerStatus, setProviderStatus] =
    useState<Record<GenerationProvider, { configured: boolean }>>();
  const [comfyEndpoint, setComfyEndpoint] = useState("http://127.0.0.1:8188");
  const [comfyWorkflow, setComfyWorkflow] = useState<Record<string, unknown>>();
  const generationJobs = (snapshot?.jobs ?? []).filter(
    (job) =>
      job.kind === "generation" &&
      (job.result as { request?: { documentId?: string } } | undefined)?.request
        ?.documentId === document.id,
  );
  const imageAssets = Object.values(document.assets).filter(
    (asset) => asset.data && asset.mimeType.startsWith("image/"),
  );

  useEffect(() => {
    void window.aidraw.getProviderStatus().then(setProviderStatus);
  }, []);

  const startGeneration = async () => {
    try {
      const requestedSize =
        aspectIntent === "square"
          ? { width: 1024, height: 1024 }
          : aspectIntent === "portrait"
            ? { width: 1024, height: 1536 }
            : aspectIntent === "landscape"
              ? { width: 1536, height: 1024 }
              : document.kind === "illustration"
                ? {
                    width: document.artboard.width,
                    height: document.artboard.height,
                  }
                : { width: 1024, height: 1024 };
      await window.aidraw.generationStart({
        documentId: document.id,
        provider,
        mode,
        prompt,
        negativePrompt: negativePrompt || undefined,
        sourceAssetIds,
        maskAssetId,
        size: requestedSize,
        aspectIntent,
        resultCount,
        providerOptions:
          provider === "comfyui"
            ? { endpoint: comfyEndpoint, workflow: comfyWorkflow }
            : {},
      });
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
          onChange={(event) =>
            setProvider(event.target.value as GenerationProvider)
          }
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
          onChange={(event) => setMode(event.target.value as GenerationMode)}
        >
          <option value="create">Create new</option>
          <option value="edit">Edit selection</option>
          <option value="inpaint">Inpaint</option>
          <option value="outpaint">Outpaint</option>
          <option value="variation">Variation</option>
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
      {provider !== "openai" && (
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
        </>
      )}
      {provider !== "comfyui" && (
        <div className="provider-key-row">
          <span>
            {providerStatus?.[provider].configured
              ? "Encrypted credential configured"
              : "API key required"}
          </span>
          <button onClick={() => setShowCredential((value) => !value)}>
            {showCredential ? "Hide" : "Set key"}
          </button>
        </div>
      )}
      {showCredential && provider !== "comfyui" && (
        <div className="credential-editor">
          <input
            type="password"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder={`${provider} API key`}
          />
          <button
            onClick={async () => {
              await window.aidraw.setProviderCredential(provider, credential);
              setCredential("");
              setShowCredential(false);
              setProviderStatus(await window.aidraw.getProviderStatus());
              notify("Credential encrypted with Windows DPAPI.", "success");
            }}
          >
            Save encrypted
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
        disabled={
          !prompt.trim() ||
          (provider === "comfyui" && !comfyWorkflow) ||
          (mode !== "create" && sourceAssetIds.length === 0) ||
          (mode === "inpaint" && !maskAssetId)
        }
        onClick={() => void startGeneration()}
      >
        <Sparkles size={16} /> Generate
      </button>
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
                      <button
                        onClick={async () => {
                          const accepted = await window.aidraw.generationAccept(
                            job.id,
                            output.id,
                          );
                          notify(
                            accepted.accepted
                              ? "Result added to the document."
                              : (accepted.message ??
                                  "Could not accept result."),
                            accepted.accepted ? "success" : "error",
                          );
                        }}
                      >
                        Accept as {document.kind === "pixel" ? "cel" : "layer"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
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
    const missing = document.linkedAssets.filter(
      (link) =>
        !link.cachedPreviewAssetId ||
        !document.assets[link.cachedPreviewAssetId]?.data,
    );
    if (missing.length) {
      notify(
        `${missing.length} linked asset${missing.length === 1 ? "" : "s"} cannot be packed because its cached source is unavailable.`,
        "warning",
      );
      return;
    }
    void apply("Pack project links", [
      {
        kind: "pixel.links.replace",
        linkedAssets: document.linkedAssets.map((link) => ({
          ...link,
          mode: "embedded" as const,
          relativePath: undefined,
        })),
      },
    ]);
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

function RightSidebar({ document }: { document: AIDrawDocument }) {
  const panel = useEditorStore((state) => state.rightPanel);
  const setPanel = useEditorStore((state) => state.setRightPanel);
  const apply = useEditorStore((state) => state.apply);
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
    <aside className="right-sidebar">
      <nav className="panel-tabs" aria-label="Inspector panels">
        <button
          className={panel === "layers" ? "is-active" : ""}
          onClick={() => setPanel("layers")}
          title="Layers"
        >
          <Layers3 size={17} />
          <span>Layers</span>
        </button>
        <button
          className={panel === "assets" ? "is-active" : ""}
          onClick={() => setPanel("assets")}
          title="Assets"
        >
          <Image size={17} />
          <span>Assets</span>
        </button>
        <button
          className={panel === "activity" ? "is-active" : ""}
          onClick={() => setPanel("activity")}
          title="Activity"
        >
          <ListTree size={17} />
          <span>Activity</span>
        </button>
        <button
          className={panel === "generation" ? "is-active" : ""}
          onClick={() => setPanel("generation")}
          title="Generate"
        >
          <Sparkles size={17} />
          <span>Generate</span>
        </button>
      </nav>
      <div className="panel-content">
        {panel === "layers" && (
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
                <IllustrationLayers document={document} />
                <ObjectInspector document={document} />
              </>
            ) : (
              <PixelLayers document={document} />
            )}
            {document.kind === "pixel" && <PalettePanel document={document} />}
          </>
        )}
        {panel === "assets" && <AssetsPanel document={document} />}
        {panel === "activity" && <ActivityPanel />}
        {panel === "generation" && <GenerationPanel document={document} />}
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
              style={{ "--actor": entry.actor.color } as React.CSSProperties}
              title={entry.actor.name}
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
      >
        <OctagonX size={14} /> Stop All Agents
      </button>
      <div className="zoom-control">
        <button
          onClick={() => setZoom(zoom / (document.kind === "pixel" ? 2 : 1.25))}
        >
          −
        </button>
        <input
          type="range"
          min={document.kind === "pixel" ? 1 : 5}
          max={document.kind === "pixel" ? 6400 : 800}
          value={Math.round(zoom * 100)}
          onChange={(event) => setZoom(Number(event.target.value) / 100)}
        />
        <button
          onClick={() => setZoom(zoom * (document.kind === "pixel" ? 2 : 1.25))}
        >
          +
        </button>
        <output>{Math.round(zoom * 100)}%</output>
      </div>
    </footer>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <span className="brand-mark large">
        <span />
        <span />
        <span />
      </span>
      <strong>Warming up the canvas…</strong>
    </div>
  );
}

export function App() {
  const initialize = useEditorStore((state) => state.initialize);
  const snapshot = useEditorStore((state) => state.snapshot);
  const loading = useEditorStore((state) => state.loading);
  const toast = useEditorStore((state) => state.toast);
  const document = snapshot?.activeDocument;

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.key === "Delete" || event.key === "Backspace") {
        const state = useEditorStore.getState();
        const active = state.snapshot?.activeDocument;
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  return (
    <div className="app-shell">
      <TopBar />
      <ContextBar document={document} />
      <ToolRail document={document} />
      <main className="canvas-workspace">
        {document.kind === "illustration" ? (
          <IllustrationCanvas document={document} />
        ) : (
          <PixelCanvas document={document} />
        )}
      </main>
      <RightSidebar document={document} />
      <StatusBar document={document} />
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}

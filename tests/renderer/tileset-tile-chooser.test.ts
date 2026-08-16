import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { TilesetTileChooser } from "../../src/renderer/components/TilesetTileChooser";

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

describe("selected-tileset exact-ID chooser", () => {
  it("renders an explicit bounded empty state", () => {
    const markup = renderToStaticMarkup(createElement(TilesetTileChooser, {
      sourceKind: "image-collection",
      tileIds: [],
      selectedTileId: 0,
      onSelect: () => undefined,
    }));
    expect(markup).toContain('class="tile-definition-empty" role="status"');
    expect(markup).toContain("No authored image-collection tile IDs are available.");
    expect(markup).not.toContain("<button");
  });

  it("renders ordinary atlas IDs in exact order with visible and programmatic selection meaning", () => {
    const tileIds = Object.freeze([0, 1, 2]);
    const before = [...tileIds];
    const markup = renderToStaticMarkup(createElement(TilesetTileChooser, {
      sourceKind: "atlas",
      tileIds,
      selectedTileId: 1,
      onSelect: () => undefined,
    }));
    expect(markup).toContain('role="group" aria-label="atlas tile IDs"');
    expect(markup).toContain('aria-label="atlas tile ID 1, selected" aria-pressed="true"');
    expect(markup).toContain('aria-label="atlas tile ID 0, not selected" aria-pressed="false"');
    expect(markup).toContain('aria-hidden="true">ID <strong>0</strong>');
    expect(markup).not.toContain("Not selected");
    expect(markup.match(/tile-definition-state/g)).toHaveLength(1);
    expect(markup).toContain("lucide-check");
    expect(markup.indexOf("<strong>0</strong>")).toBeLessThan(markup.indexOf("<strong>1</strong>"));
    expect(markup.indexOf("<strong>1</strong>")).toBeLessThan(markup.indexOf("<strong>2</strong>"));
    expect(tileIds).toEqual(before);
  });

  it("preserves exact sparse gaps and long IDs while routing one native button activation", () => {
    const tileIds = Object.freeze([0, 300, 1022]);
    const before = [...tileIds];
    const selected: number[] = [];
    const tree = TilesetTileChooser({
      sourceKind: "image-collection",
      tileIds,
      selectedTileId: 300,
      onSelect: (tileId) => selected.push(tileId),
    });
    const buttons = descendantElements(tree).filter((element) => element.type === "button") as Array<ReactElement<Record<string, unknown>>>;
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "image-collection tile ID 0, not selected",
      "image-collection tile ID 300, selected",
      "image-collection tile ID 1022, not selected",
    ]);
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([false, true, false]);
    expect(buttons.every((button) => button.props.type === "button" && button.props.tabIndex !== -1)).toBe(true);
    (buttons[2].props.onClick as () => void)();
    expect(selected).toEqual([1022]);
    expect(tileIds).toEqual(before);

    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("<strong>1022</strong>");
    expect(markup).not.toContain("<strong>1</strong>");
    expect(markup.indexOf("<strong>0</strong>")).toBeLessThan(markup.indexOf("<strong>300</strong>"));
    expect(markup.indexOf("<strong>300</strong>")).toBeLessThan(markup.indexOf("<strong>1022</strong>"));
  });

  it("retains TilesetPanel fallback, cap, collision reset, variants, and guarded metadata wiring", async () => {
    const app = await readFile(new URL("../../src/renderer/App.tsx", import.meta.url), "utf8");
    const tilesetPanel = app.slice(app.indexOf("function TilesetPanel"), app.indexOf("function PalettePanel"));
    const chooserWiring = tilesetPanel.slice(
      tilesetPanel.indexOf("<TilesetTileChooser"),
      tilesetPanel.indexOf("/>", tilesetPanel.indexOf("<TilesetTileChooser")) + 2,
    );
    expect(app).toContain('import { TilesetTileChooser } from "./components/TilesetTileChooser"');
    expect(tilesetPanel).toContain("const collectionTileIds = imageCollection ? imageCollectionTileIds(tileset) : undefined;");
    expect(tilesetPanel).toContain("? collectionTileIds[0]");
    expect(tilesetPanel).toContain("Array.from({ length: Math.min(tileCount, 256) }, (_, id) => id)");
    expect(chooserWiring).toContain("tileIds={displayedTileIds}");
    expect(chooserWiring).toContain("selectedTileId={effectiveSelectedTileId}");
    expect(chooserWiring).toContain('sourceKind={imageCollection ? "image-collection" : "atlas"}');
    expect(chooserWiring).toContain("setSelectedTileId(tileId);");
    expect(chooserWiring).toContain("setSelectedCollisionIds([]);");
    expect(tilesetPanel).toContain("Showing the first 256 of {tileCount} tiles.");
    expect(tilesetPanel).toContain("<TileVariantPreview document={document} tileset={tileset} selectedTileId={effectiveSelectedTileId}");
    expect(tilesetPanel).toContain("resolveTilesetTileSource(document, tileset, effectiveSelectedTileId)");
    expect(tilesetPanel).toContain("replaceImageCollectionTileMetadata(tileset, effectiveSelectedTileId, patch)");
    expect(tilesetPanel).toContain("imageCollectionSourceDependencyGuards(document, tileset)");
    expect(tilesetPanel).toContain("expectedRevision: tileset.revision");
    expect(tilesetPanel).not.toContain("setPixelIndex");
    expect(tilesetPanel).not.toContain("pixelIndex");
    expect(app).not.toContain('<div className="tile-definition-grid">{displayedTileIds.map');
  });

  it("derives at least five columns and four full rows at both declared inspector widths", async () => {
    const styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    const legacyButton = styles.indexOf(".tile-definition-grid button { min-height: 24px");
    const correctedBase = styles.indexOf("/* Atlas and sparse image-collection tile IDs share one exact native chooser. */");
    const compactMedia = styles.indexOf("@media (max-width: 1120px)", correctedBase);
    const compactRule = styles.indexOf(".tile-definition-grid { max-height: 154px;", compactMedia);
    const ruleBody = (selector: string, offset: number) => {
      const start = styles.indexOf(`${selector} {`, offset);
      const end = styles.indexOf("}", start);
      if (start < 0 || end < 0) throw new Error(`Missing ${selector} CSS rule.`);
      return styles.slice(start, end + 1);
    };
    const px = (body: string, property: string) => {
      const match = body.match(new RegExp(`${property}:\\s*(\\d+)px`));
      if (!match) throw new Error(`Missing ${property} pixel value.`);
      return Number(match[1]);
    };
    const gridColumns = (body: string, availableWidth: number, gap: number) => {
      const fixed = body.match(/grid-template-columns:\s*repeat\((\d+),/);
      if (fixed) return Number(fixed[1]);
      const autoFill = body.match(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\((\d+)px,/);
      if (!autoFill) throw new Error("Missing fixed or bounded auto-fill tile columns.");
      return Math.floor((availableWidth + gap) / (Number(autoFill[1]) + gap));
    };
    const baseGrid = ruleBody(".tile-definition-grid", correctedBase);
    const compactGrid = ruleBody(".tile-definition-grid", compactMedia);
    const button = ruleBody(".tile-definition-grid button", correctedBase);
    const margin = baseGrid.match(/margin:\s*0\s+(\d+)px\s+\d+px/);
    const padding = baseGrid.match(/padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px\s+(\d+)px/);
    const target = styles.match(/--ui-hit-secondary:\s*(\d+)px/);
    const selectedIcon = styles.match(/--ui-icon-secondary:\s*(\d+)px/);
    const exactIdType = styles.match(/--ui-type-label:\s*([\d.]+)rem/);
    if (!margin || !padding || !target || !selectedIcon || !exactIdType) throw new Error("Missing chooser geometry inputs.");
    const horizontalMargin = Number(margin[1]) * 2;
    const horizontalPadding = Number(padding[2]) + Number(padding[4]);
    const verticalPadding = Number(padding[1]) + Number(padding[3]);
    const targetHeight = Number(target[1]) + Number(button.match(/min-height:\s*calc\(var\(--ui-hit-secondary\)\s*\+\s*(\d+)px\)/)?.[1] ?? 0);
    const gap = px(baseGrid, "gap");
    const capacity = (inspectorWidth: number, maxHeight: number, columnsRule: string) => {
      const availableWidth = inspectorWidth - horizontalMargin - horizontalPadding;
      const columns = gridColumns(columnsRule, availableWidth, gap);
      const trackWidth = (availableWidth - (columns - 1) * gap) / columns;
      const rows = Math.floor((maxHeight - verticalPadding + gap) / (targetHeight + gap));
      return { columns, rows, visibleIds: columns * rows, trackWidth };
    };
    const regular = capacity(318, px(baseGrid, "max-height"), baseGrid);
    const compact = capacity(286, px(compactGrid, "max-height"), compactGrid);
    const selectedContentHeight = Number(selectedIcon[1]) + Number(exactIdType[1]) * 16;
    const rejectedCapacity = (inspectorWidth: number, maxHeight: number, minimumTrack: number) => {
      const availableWidth = inspectorWidth - horizontalMargin - horizontalPadding;
      const rejectedGap = 6;
      const rejectedTargetHeight = 44;
      const columns = Math.floor((availableWidth + rejectedGap) / (minimumTrack + rejectedGap));
      const rows = Math.floor((maxHeight - verticalPadding + rejectedGap) / (rejectedTargetHeight + rejectedGap));
      return { columns, rows, visibleIds: columns * rows };
    };
    expect(legacyButton).toBeGreaterThanOrEqual(0);
    expect(correctedBase).toBeGreaterThan(legacyButton);
    expect(compactMedia).toBeGreaterThan(correctedBase);
    expect(compactRule).toBeGreaterThan(compactMedia);
    expect(regular).toMatchObject({ columns: 5, rows: 4, visibleIds: 20 });
    expect(compact).toMatchObject({ columns: 5, rows: 4, visibleIds: 20 });
    expect(rejectedCapacity(318, 164, 78)).toEqual({ columns: 3, rows: 3, visibleIds: 9 });
    expect(rejectedCapacity(286, 154, 68)).toEqual({ columns: 3, rows: 3, visibleIds: 9 });
    expect(regular.trackWidth).toBeGreaterThanOrEqual(targetHeight);
    expect(compact.trackWidth).toBeGreaterThanOrEqual(targetHeight);
    expect(selectedContentHeight).toBeLessThanOrEqual(targetHeight);
    expect(styles).toMatch(/\.tile-definition-grid \{[^}]*max-height: 164px[^}]*repeat\(5, minmax\(0, 1fr\)\)[^}]*gap: 4px[^}]*overflow-y: auto[^}]*overscroll-behavior: contain[^}]*scrollbar-gutter: stable/);
    expect(styles).toMatch(/\.tile-definition-grid button \{[^}]*min-height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.tile-definition-grid button\[aria-pressed="true"\] \{[^}]*grid-template-rows: var\(--ui-icon-secondary\) var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tile-definition-id \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-definition-id strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tile-definition-state svg \{[^}]*width: var\(--ui-icon-secondary\)[^}]*height: var\(--ui-icon-secondary\)/);
    expect(styles).toContain('.tile-definition-grid button[aria-pressed="true"]');
    expect(styles).toContain(".tile-definition-grid button:focus-visible");
    expect(styles).toMatch(/@media \(max-width: 1120px\) \{[\s\S]*\.tile-definition-grid \{ max-height: 154px; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\); \}/);
  });

  it("binds literal changelog, architecture, tracker, and testing truth", async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/FEATURE_TRACKER.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/TESTING.md", import.meta.url), "utf8"),
    ]);
    expect(changelog).toContain("selected-tileset exact-ID chooser");
    expect(architecture).toContain("one renderer-only exact-ID projection");
    expect(tracker).toContain("A bounded source/headless UX-01/MAP-03/MAP-07 checkpoint (2026-08-17)");
    expect(testing).toContain("Current source/headless selected-tileset exact-ID chooser checkpoint");
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain("aria-pressed");
      expect(truth).toContain("first 256");
      expect(truth).toContain("sparse");
    }
  });
});

import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import type { PaletteEntry } from "@aidraw/core";
import { describe, expect, it } from "vitest";

import {
  PALETTE_USAGE_REVIEW_LIMIT,
  PaletteControls,
  PaletteSwatch,
  type PaletteControlsProps,
} from "../../src/renderer/components/PaletteControls";

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

function palette(length = 4): PaletteEntry[] {
  return Array.from({ length }, (_, index) => ({
    id: index === 0 ? "transparent-entry" : `entry-${index}`,
    name: index === 0 ? "Transparent" : `Color ${index}`,
    color: index === 0 ? "#00000000" : `#${(0x110000 + index * 0x10101).toString(16).slice(-6)}`,
  }));
}

function props(overrides: Partial<PaletteControlsProps> = {}): PaletteControlsProps {
  return {
    palette: palette(),
    selectedIndex: 2,
    importMode: "replace-slots",
    replacementIndex: 1,
    selectedUsage: 0,
    hasCustomOverride: false,
    onImportModeChange: () => undefined,
    onImport: () => undefined,
    onExportJson: () => undefined,
    onExportGpl: () => undefined,
    onSelect: () => undefined,
    onColorChange: () => undefined,
    onPrevious: () => undefined,
    onNext: () => undefined,
    onMoveEarlier: () => undefined,
    onMoveLater: () => undefined,
    onAdd: () => undefined,
    onDeleteUnused: () => undefined,
    onReplacementChange: () => undefined,
    onReplaceAndDelete: () => undefined,
    ...overrides,
  };
}

function nativeControls(tree: ReactNode) {
  return descendantElements(tree).filter((element) => element.type === "button" || element.type === "input" || element.type === "select") as Array<ReactElement<Record<string, unknown>>>;
}

describe("indexed palette controls", () => {
  it("renders transparent and ordinary swatches with exact native pressed and non-color selected meaning", () => {
    const entries = palette();
    entries[2] = {
      id: "long-authored-entry-identifier-that-must-remain-recoverable",
      name: "Very long authored violet highlight name that must remain recoverable",
      color: "#5634ef",
    };
    const before = structuredClone(entries);
    Object.freeze(entries);
    const markup = renderToStaticMarkup(createElement(PaletteControls, props({ palette: entries, selectedIndex: 2 })));

    expect(markup).toContain('role="group" aria-label="Indexed palette colors"');
    expect(markup).toContain('class="palette-swatch is-transparent"');
    expect(markup).toContain('aria-label="Palette index 0, Transparent, #00000000, protected transparent, not selected" aria-pressed="false"');
    expect(markup).toContain('aria-label="Palette index 2, Very long authored violet highlight name that must remain recoverable, #5634ef, selected" aria-pressed="true"');
    expect(markup).toContain("lucide-check");
    expect(markup.match(/palette-swatch-selection/gu)).toHaveLength(1);
    expect(markup).toContain("Very long authored violet highlight name that must remain recoverable");
    expect(markup).toContain("Index 2 · Very long authored violet highlight name that must remain recoverable · #5634ef · ID long-authored-entry-identifier-that-must-remain-recoverable");
    expect(entries).toEqual(before);
  });

  it("routes an exact swatch without mutating its palette entry", () => {
    const entry = Object.freeze({ id: "entry-102", name: "Exact cyan", color: "#12cdef" });
    const before = structuredClone(entry);
    const selected: number[] = [];
    const swatch = PaletteSwatch({ entry, index: 102, selected: false, onSelect: () => selected.push(102) }) as ReactElement<Record<string, unknown>>;
    expect(swatch.type).toBe("button");
    expect(swatch.props.type).toBe("button");
    expect(swatch.props["aria-label"]).toBe("Palette index 102, Exact cyan, #12cdef, not selected");
    expect(swatch.props["aria-pressed"]).toBe(false);
    expect(swatch.props.tabIndex).not.toBe(-1);
    (swatch.props.onClick as () => void)();
    expect(selected).toEqual([102]);
    expect(entry).toEqual(before);
  });

  it("keeps import, color, all six selected-color actions, and replacement on distinct exact native routes", () => {
    const routed: string[] = [];
    const replacementSelections: number[] = [];
    const tree = PaletteControls(props({
      onImportModeChange: (mode) => routed.push(`mode:${mode}`),
      onImport: () => routed.push("import"),
      onExportJson: () => routed.push("json"),
      onExportGpl: () => routed.push("gpl"),
      onSelect: (index, color) => routed.push(`select:${index}:${color}`),
      onColorChange: (color) => routed.push(`color:${color}`),
      onPrevious: () => routed.push("previous"),
      onNext: () => routed.push("next"),
      onMoveEarlier: () => routed.push("earlier"),
      onMoveLater: () => routed.push("later"),
      onAdd: () => routed.push("add"),
      onDeleteUnused: () => routed.push("delete-unused"),
      onReplacementChange: (index) => replacementSelections.push(index),
      onReplaceAndDelete: () => routed.push("replace-delete"),
    }));
    const controls = nativeControls(tree);
    const byLabel = (label: string) => controls.find((control) => control.props["aria-label"] === label)!;

    (byLabel("Palette import behavior").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "append-unique" } });
    for (const label of [
      "Import AIDraw JSON or GIMP GPL palette",
      "Export portable AIDraw palette JSON",
      "Export GIMP GPL palette; transparent index 0 is omitted",
      "Select previous palette color",
      "Select next palette color",
      "Move selected palette color one slot earlier",
      "Move selected palette color one slot later",
      "Add palette color",
      "Delete selected unused palette color",
      "Replace palette index 2 with index 1 and delete the source",
    ]) (byLabel(label).props.onClick as () => void)();
    (byLabel("Edit selected palette color for index 2, Color 2").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "#abcdef" } });
    (byLabel("Replacement palette color for source index 2").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "3" } });

    const swatches = descendantElements(tree).filter((element) => element.type === PaletteSwatch) as Array<ReactElement<Parameters<typeof PaletteSwatch>[0]>>;
    const exactSwatch = PaletteSwatch(swatches[3].props) as ReactElement<Record<string, unknown>>;
    (exactSwatch.props.onClick as () => void)();

    expect(routed).toEqual([
      "mode:append-unique", "import", "json", "gpl", "previous", "next", "earlier", "later", "add", "delete-unused", "replace-delete", "color:#abcdef", "select:3:#140303",
    ]);
    expect(replacementSelections).toEqual([3]);
  });

  it("states protected, used, unused, override, fallback, and 256-entry boundaries exactly", () => {
    const transparentTree = PaletteControls(props({ palette: palette(256), selectedIndex: 0, replacementIndex: 0 }));
    const transparentControls = nativeControls(transparentTree);
    const transparentSwatches = descendantElements(transparentTree).filter((element) => element.type === PaletteSwatch);
    const transparentDelete = transparentControls.find((control) => control.props["aria-label"] === "Transparent index 0 cannot be deleted")!;
    const add = transparentControls.find((control) => control.props["aria-label"] === "Add palette color unavailable; palette has reached the 256-entry limit")!;
    const previous = transparentControls.find((control) => control.props["aria-label"] === "Select previous palette color")!;
    const next = transparentControls.find((control) => control.props["aria-label"] === "Select next palette color")!;
    const earlier = transparentControls.find((control) => control.props["aria-label"] === "Move selected palette color one slot earlier")!;
    const later = transparentControls.find((control) => control.props["aria-label"] === "Move selected palette color one slot later")!;
    expect(transparentSwatches).toHaveLength(256);
    expect(transparentDelete.props.disabled).toBe(true);
    expect(transparentDelete.props.title).toBe("Transparent index 0 cannot be deleted");
    expect(previous.props.disabled).toBe(true);
    expect(next.props.disabled).toBe(false);
    expect(earlier.props.disabled).toBe(true);
    expect(later.props.disabled).toBe(true);
    expect(add.props.disabled).toBe(true);
    expect(add.props.title).toBe("Palette has reached the 256-entry limit");
    expect(renderToStaticMarkup(transparentTree)).not.toContain("Replace &amp; delete");

    const firstOpaqueControls = nativeControls(PaletteControls(props({ selectedIndex: 1 })));
    expect(firstOpaqueControls.find((control) => control.props["aria-label"] === "Select previous palette color")?.props.disabled).toBe(true);
    expect(firstOpaqueControls.find((control) => control.props["aria-label"] === "Move selected palette color one slot earlier")?.props.disabled).toBe(true);
    expect(firstOpaqueControls.find((control) => control.props["aria-label"] === "Select next palette color")?.props.disabled).toBe(false);
    expect(firstOpaqueControls.find((control) => control.props["aria-label"] === "Move selected palette color one slot later")?.props.disabled).toBe(false);

    const lastControls = nativeControls(PaletteControls(props({ selectedIndex: 3 })));
    expect(lastControls.find((control) => control.props["aria-label"] === "Select next palette color")?.props.disabled).toBe(true);
    expect(lastControls.find((control) => control.props["aria-label"] === "Move selected palette color one slot later")?.props.disabled).toBe(true);

    const usedMarkup = renderToStaticMarkup(createElement(PaletteControls, props({
      selectedUsage: PALETTE_USAGE_REVIEW_LIMIT,
      hasCustomOverride: true,
      replacementIndex: 2,
    })));
    expect(usedMarkup).toContain("10,000+ indexed cel or reusable-stamp cells (bounded scan stopped at the limit).");
    expect(usedMarkup).toContain("A frame-specific palette override has a custom value in this source slot; replacement normalizes it before removal.");
    expect(usedMarkup).toContain("Index 2 · Color 2 · #130202 · ID entry-2");
    expect(usedMarkup).toContain("Will replace with");
    expect(usedMarkup).toContain("Index 0 · Transparent · #00000000 · ID transparent-entry");

    const outsideFallback = nativeControls(PaletteControls(props({ replacementIndex: 999 }))).find((control) => control.props["aria-label"] === "Replacement palette color for source index 2")!;
    expect(outsideFallback.props.value).toBe(0);

    const usedTree = PaletteControls(props({ selectedUsage: 17, hasCustomOverride: false }));
    const usedDelete = nativeControls(usedTree).find((control) => control.props["aria-label"] === "Replace this color first; it is used 17 times")!;
    expect(usedDelete.props.disabled).toBe(true);
    expect(usedDelete.props.title).toBe("Replace this color first; it is used 17 times");

    const overrideTree = PaletteControls(props({ selectedUsage: 0, hasCustomOverride: true }));
    const overrideDelete = nativeControls(overrideTree).find((control) => control.props["aria-label"] === "Clear this color's frame-specific overrides before deleting it")!;
    expect(overrideDelete.props.disabled).toBe(true);
    expect(overrideDelete.props.title).toBe("Clear this color's frame-specific overrides before deleting it");

    const unusedMarkup = renderToStaticMarkup(createElement(PaletteControls, props()));
    expect(unusedMarkup).toContain("No indexed cel or reusable-stamp cell uses this source slot.");
    expect(unusedMarkup).toContain("No frame-specific palette override has a custom value in this source slot.");
  });

  it("preserves the exact PalettePanel kernels and one canonical call path", async () => {
    const [app, paletteKernel] = await Promise.all([
      readFile(new URL("../../src/renderer/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../packages/core/src/palette.ts", import.meta.url), "utf8"),
    ]);
    const panel = app.slice(app.indexOf("function PalettePanel"), app.indexOf("function AssetPanel"));
    expect(panel).toContain("countPaletteIndexUsage(document, index, PALETTE_USAGE_REVIEW_LIMIT)");
    expect(panel).toContain('apply("Update palette color", [');
    expect(panel).toContain('apply("Add palette color", [{');
    expect(panel).toContain('apply("Delete unused palette color", [{ kind: "pixel.palette.reorder"');
    expect(panel).toContain('apply("Replace and delete palette color", replaceAndDeletePaletteIndexOperations(document, index, target))');
    expect(panel).toContain("setIndex(Math.min(nextTarget, document.palette.length - 2))");
    expect(panel).toContain("setReplacementIndex(0)");
    expect(panel).toContain("onImport={() => void importPalette()}");
    expect(panel).toContain('onExportJson={() => void exportPalette("json")}');
    expect(panel).toContain('onExportGpl={() => void exportPalette("gpl")}');
    expect(panel).toContain("onMoveEarlier={() => void movePaletteEntry(-1)}");
    expect(panel).toContain("onMoveLater={() => void movePaletteEntry(1)}");
    expect(paletteKernel).toContain("for (const stamp of document.stamps)");
    expect(paletteKernel).toContain("for (const asset of Object.values(document.pixelAssets))");
    expect(paletteKernel).toContain("operations.push({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: asset.revision })");
    expect(paletteKernel).toContain("{ kind: 'pixel.palette.reorder', entryIds, expectedRevision: document.revision }");
    expect(paletteKernel).toContain("{ kind: 'pixel.palette-cycles.replace', cycles }");
    expect(paletteKernel).toContain("{ kind: 'pixel.palette.replace', palette: reordered.slice(0, -1) }");
  });

  it("proves regular and compact palette geometry from the declared inspector widths", async () => {
    const styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    const baseGridOffset = styles.indexOf(".palette-grid { display: grid;");
    const compactMediaOffset = styles.indexOf("@media (max-width: 1120px)", baseGridOffset);
    const compactGridOffset = styles.indexOf(".palette-grid { grid-template-columns:", compactMediaOffset);
    const compactRemapOffset = styles.indexOf(".palette-remap-facts > div, .palette-remap-target", compactMediaOffset);
    const ruleBody = (selector: string, offset: number) => {
      const start = styles.indexOf(`${selector} {`, offset);
      const end = styles.indexOf("}", start);
      if (start < 0 || end < 0) throw new Error(`Missing ${selector} CSS rule.`);
      return styles.slice(start, end + 1);
    };
    const root = styles.slice(styles.indexOf(":root {"), styles.indexOf("}", styles.indexOf(":root {")) + 1);
    const variablePx = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*(\\d+)px`))?.[1]);
    const inspectorRegular = variablePx("shell-sidebar-width");
    const inspectorCompact = variablePx("shell-sidebar-compact-width");
    const secondaryTarget = variablePx("ui-hit-secondary");
    const secondaryIcon = variablePx("ui-icon-secondary");
    const captionRem = Number(root.match(/--ui-type-caption:\s*([\d.]+)rem/)?.[1]);
    const panelScrollbar = Number(styles.match(/\.panel-content::-webkit-scrollbar \{ width: (\d+)px;/)?.[1]);
    const baseGrid = ruleBody(".palette-grid", baseGridOffset);
    const compactGrid = ruleBody(".palette-grid", compactMediaOffset);
    const swatch = ruleBody(".palette-swatch", baseGridOffset);
    const fileActions = ruleBody(".palette-file-actions", baseGridOffset);
    const selectedActions = ruleBody(".palette-selected-actions", baseGridOffset);
    const padding = baseGrid.match(/padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px/);
    const gap = Number(baseGrid.match(/gap:\s*(\d+)px/)?.[1]);
    const columns = (body: string) => Number(body.match(/repeat\((\d+),/)?.[1]);
    if (!padding || !gap || !inspectorRegular || !inspectorCompact || !secondaryTarget || !secondaryIcon || !captionRem || !panelScrollbar) throw new Error("Missing palette geometry inputs.");
    const horizontalPadding = Number(padding[2]) * 2;
    const capacity = (width: number, count: number) => ({
      columns: count,
      trackWidth: (width - panelScrollbar - horizontalPadding - gap * (count - 1)) / count,
      rowsForMaximumPalette: Math.ceil(256 / count),
    });
    const regular = capacity(inspectorRegular, columns(baseGrid));
    const compact = capacity(inspectorCompact, columns(compactGrid));
    const threeActionWidth = (width: number) => (width - panelScrollbar - horizontalPadding - 4 * 2) / 3;

    expect(regular).toMatchObject({ columns: 8, rowsForMaximumPalette: 32 });
    expect(compact).toMatchObject({ columns: 7, rowsForMaximumPalette: 37 });
    expect(regular.trackWidth).toBeCloseTo(32.125, 3);
    expect(compact.trackWidth).toBeCloseTo(32.714, 3);
    expect(regular.trackWidth).toBeGreaterThanOrEqual(secondaryTarget);
    expect(compact.trackWidth).toBeGreaterThanOrEqual(secondaryTarget);
    expect(threeActionWidth(inspectorRegular)).toBeGreaterThanOrEqual(secondaryTarget);
    expect(threeActionWidth(inspectorCompact)).toBeGreaterThanOrEqual(secondaryTarget);
    expect(secondaryTarget).toBe(32);
    expect(secondaryIcon).toBe(18);
    expect(secondaryIcon + captionRem * 16 + 2).toBeLessThanOrEqual(secondaryTarget);
    expect(swatch).toContain("min-width: var(--ui-hit-secondary)");
    expect(swatch).toContain("min-height: var(--ui-hit-secondary)");
    expect(fileActions).toContain("repeat(3, minmax(0, 1fr))");
    expect(selectedActions).toContain("repeat(3, minmax(0, 1fr))");
    expect(styles).toContain('.palette-swatch[aria-pressed="true"]');
    expect(styles).toContain(".palette-swatch:focus-visible");
    expect(styles).toMatch(/\.palette-swatch-selection svg \{[^}]*width: var\(--ui-icon-secondary\)[^}]*height: var\(--ui-icon-secondary\)/);
    expect(styles).toMatch(/\.palette-selected-identity strong, \.palette-selected-identity small \{[^}]*overflow-wrap: anywhere/);
    expect(compactMediaOffset).toBeGreaterThan(baseGridOffset);
    expect(compactGridOffset).toBeGreaterThan(compactMediaOffset);
    expect(compactRemapOffset).toBeGreaterThan(compactMediaOffset);
    expect(styles).toMatch(/@media \(max-width: 1120px\) \{[\s\S]*\.palette-remap-facts > div, \.palette-remap-target \{ grid-template-columns: minmax\(0, 1fr\); gap: 3px; \}/);

    const component = await readFile(new URL("../../src/renderer/components/PaletteControls.tsx", import.meta.url), "utf8");
    expect(component).toContain("{palette.map((entry, entryIndex) => (");
    expect(component).not.toContain("palette.slice(");
  });

  it("binds literal changelog, architecture, tracker, and testing truth", async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/FEATURE_TRACKER.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/TESTING.md", import.meta.url), "utf8"),
    ]);
    expect(changelog).toContain("indexed-palette control and replace-delete review");
    expect(architecture).toContain("hook-free indexed-palette control projection");
    expect(tracker).toContain("A bounded source/headless UX-01/PIX-02 checkpoint (2026-08-17)");
    expect(testing).toContain("Current source/headless indexed-palette control checkpoint");
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain("10,000");
      expect(truth).toContain("aria-pressed");
      expect(truth).toContain("32 px");
      expect(truth).toContain("packaged");
    }
  });
});

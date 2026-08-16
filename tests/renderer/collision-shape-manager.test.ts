import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CollisionShape } from "@aidraw/core";
import { CollisionShapeManager } from "../../src/renderer/components/CollisionShapeManager";

const longShapeId = "collision-main-doorway-with-an-exact-long-authored-identity";
const shapes: CollisionShape[] = [
  {
    id: longShapeId,
    type: "rectangle",
    x: -123_456,
    y: 987_654,
    width: 8_192,
    height: 1,
    properties: { material: "stone" },
  },
  {
    id: "collision-polyline-secondary",
    type: "polyline",
    x: -7,
    y: 19,
    points: [{ x: 0, y: 0 }, { x: 12, y: -4 }],
    properties: {},
  },
];

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

function manager(overrides: Partial<Parameters<typeof CollisionShapeManager>[0]> = {}) {
  return createElement(CollisionShapeManager, {
    tileId: 300,
    shapes,
    selectedIds: [longShapeId],
    fallbackWidth: 96,
    fallbackHeight: 48,
    children: createElement("div", null, "Collision canvas remains between actions and cards"),
    onSelect: () => undefined,
    onChange: () => undefined,
    onDelete: () => undefined,
    onDeleteSelected: () => undefined,
    ...overrides,
  });
}

describe("tile collision shape manager", () => {
  it("shows authored-order exact identities, non-color-only selection, and every visible geometry label", () => {
    const markup = renderToStaticMarkup(manager());
    expect(markup).toContain('role="group" aria-label="Collision selection actions for tile 300"');
    expect(markup).toContain("1 of 2 selected");
    expect(markup).toContain(`aria-label="Collision shape 1, ID ${longShapeId}, Rectangle"`);
    expect(markup).toContain(`<strong>Shape 1</strong><small>Shape ID ${longShapeId}</small>`);
    expect(markup).toContain("Selected</em>");
    expect(markup).toContain("Not selected</em>");
    for (const label of ["Type", "X", "Y", "Width", "Height"]) {
      expect(markup).toContain(`<span>${label}</span>`);
    }
    expect(markup).toContain(`aria-label="Collision shape 1, ID ${longShapeId}, X" type="number" value="-123456"`);
    expect(markup).toContain('aria-label="Collision shape 2, ID collision-polyline-secondary, width" type="number" value="96"');
    expect(markup).toContain(`aria-label="Delete collision shape 1, ID ${longShapeId}"`);
    expect(markup).toContain("Delete shape 1");
    expect(markup.indexOf(longShapeId)).toBeLessThan(markup.indexOf("collision-polyline-secondary"));
    expect(markup.indexOf("Collision canvas remains between actions and cards")).toBeLessThan(markup.indexOf(`Shape ID ${longShapeId}`));
  });

  it("routes checkbox, ordinary click, Shift-click, bulk actions, edits, and exact deletion through native controls", () => {
    const canonicalBefore = structuredClone(shapes);
    const selections: string[][] = [];
    const changes: unknown[] = [];
    const deletions: string[] = [];
    const bulkDeletions: string[][] = [];
    const tree = CollisionShapeManager({
      tileId: 300,
      shapes,
      selectedIds: [longShapeId],
      fallbackWidth: 96,
      fallbackHeight: 48,
      children: createElement("div"),
      onSelect: (ids) => selections.push(ids),
      onChange: (shapeId, patch, label) => changes.push([shapeId, patch, label]),
      onDelete: (shapeId) => deletions.push(shapeId),
      onDeleteSelected: (shapeIds) => bulkDeletions.push(shapeIds),
    });
    const elements = descendantElements(tree);
    const controls = elements.filter((element) => element.type === "input" || element.type === "select" || element.type === "button") as Array<ReactElement<Record<string, unknown>>>;
    expect(controls).toHaveLength(17);
    expect(controls.every((control) => control.props.disabled !== true && control.props.tabIndex !== -1)).toBe(true);

    const byLabel = (label: string) => controls.find((control) => control.props["aria-label"] === label)!;
    (byLabel("Select all collision shapes for tile 300").props.onClick as () => void)();
    (byLabel("Clear collision selection for tile 300").props.onClick as () => void)();
    (byLabel("Select collision shape 2, ID collision-polyline-secondary").props.onChange as (event: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: true } });
    const cards = elements.filter((element) => element.type === "fieldset") as Array<ReactElement<{
      "aria-label": string;
      onClick(event: { target: { closest(): null }; shiftKey: boolean }): void;
    }>>;
    expect(cards.map((card) => card.props["aria-label"])).toEqual([
      `Collision shape 1, ID ${longShapeId}, Rectangle`,
      "Collision shape 2, ID collision-polyline-secondary, Polyline",
    ]);
    cards[1].props.onClick({ target: { closest: () => null }, shiftKey: false });
    cards[1].props.onClick({ target: { closest: () => null }, shiftKey: true });
    cards[0].props.onClick({ target: { closest: () => null }, shiftKey: true });
    expect(selections).toEqual([
      [longShapeId, "collision-polyline-secondary"],
      [],
      [longShapeId, "collision-polyline-secondary"],
      ["collision-polyline-secondary"],
      [longShapeId, "collision-polyline-secondary"],
      [],
    ]);

    const change = (label: string, value: string) => {
      (byLabel(label).props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
    };
    change(`Collision shape 1, ID ${longShapeId}, type`, "ellipse");
    change(`Collision shape 1, ID ${longShapeId}, X`, "-999999");
    change(`Collision shape 1, ID ${longShapeId}, Y`, "123");
    change(`Collision shape 1, ID ${longShapeId}, width`, "0");
    change(`Collision shape 1, ID ${longShapeId}, height`, "64");
    (byLabel(`Delete collision shape 1, ID ${longShapeId}`).props.onClick as () => void)();
    (byLabel("Delete 1 selected collision shape from tile 300").props.onClick as () => void)();
    expect(changes).toEqual([
      [longShapeId, { type: "ellipse" }, "Change collision type"],
      [longShapeId, { x: -999_999 }, "Move collision"],
      [longShapeId, { y: 123 }, "Move collision"],
      [longShapeId, { width: 1 }, "Resize collision"],
      [longShapeId, { height: 64 }, "Resize collision"],
    ]);
    expect(deletions).toEqual([longShapeId]);
    expect(bulkDeletions).toEqual([[longShapeId]]);
    expect(shapes).toEqual(canonicalBefore);
  });

  it("uses shared density and icon floors with a later compact two-column reflow", async () => {
    const styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.tile-collision-selection-actions button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-collision-selection-toggle \{[^}]*min-height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.tile-collision-field input, \.tile-collision-field select \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tile-collision-delete \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain(".tile-collision-selection-actions svg, .tile-collision-delete svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary); }");
    expect(styles).toContain(".tile-collision-selection-toggle strong, .tile-collision-selection-toggle small { display: block; min-width: 0; white-space: normal; overflow-wrap: anywhere; }");
    expect(styles).toContain(".tile-collision-card:focus-within { border-color: #6948d2;");
    expect(styles).toContain(".collision-shape-editor small, .collision-selection-note { font-size: var(--ui-type-caption);");
    const ordinaryOffset = styles.indexOf(".tile-collision-fields { min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));");
    const compactMediaOffset = styles.indexOf("@media (max-width: 1120px) {\n  .wang-signature-fields");
    const compactOffset = styles.indexOf(".tile-collision-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }", compactMediaOffset);
    expect(ordinaryOffset).toBeGreaterThanOrEqual(0);
    expect(compactMediaOffset).toBeGreaterThan(ordinaryOffset);
    expect(compactOffset).toBeGreaterThan(ordinaryOffset);
    expect(styles.slice(compactMediaOffset)).toContain(".tile-collision-field.is-type, .tile-collision-delete { grid-column: 1 / -1; }");
    expect(styles.slice(compactMediaOffset)).toContain(".tile-collision-selection-actions > strong, .tile-collision-selection-actions .tile-collision-delete-selected { grid-column: 1 / -1; }");
  });

  it("keeps TilesetPanel callbacks on exact IDs and the established complete replacement boundary", async () => {
    const [app, canvas] = await Promise.all([
      readFile(new URL("../../src/renderer/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../src/renderer/components/CollisionShapeEditor.tsx", import.meta.url), "utf8"),
    ]);
    expect(app).toContain('import { CollisionShapeManager } from "./components/CollisionShapeManager";');
    expect(app).toContain("<CollisionShapeManager");
    expect(app).toContain("entry.id === shapeId ? { ...entry, ...patch } : entry");
    expect(app).toContain("selectedTile.collisions.filter((shape) => shape.id !== shapeId)");
    expect(app).toContain("selectedTile.collisions.filter((shape) => !deleted.has(shape.id))");
    expect(app).toContain("<CollisionShapeEditor");
    expect(app).toContain("const changed = new Map(shapes.map((shape) => [shape.id, shape]))");
    expect(app).toContain('kind: "pixel.asset.replace"');
    expect(app).toContain("expectedRevision: tileset.revision");
    expect(app).toContain("expectedSpriteDependencies");
    expect(app).toContain("entry.id === selectedCollision.id ? { ...entry, properties:");
    expect(canvas).toContain("moveMapObjectSelection");
    expect(canvas).toContain("event.shiftKey");
    expect(canvas).toContain("onPointerCancel={(event) => void finishGesture(event, false)}");
  });

  it("binds durable claims to the exact source/headless presentation boundary", async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/FEATURE_TRACKER.md", import.meta.url), "utf8"),
      readFile(new URL("../../docs/TESTING.md", import.meta.url), "utf8"),
    ]);
    expect(changelog).toContain("selected-tile collision-shape manager");
    expect(architecture).toContain("The selected-tile collision manager is a renderer-only projection");
    expect(tracker).toContain("A bounded source/headless UX-01/MAP-04 checkpoint (2026-08-17)");
    expect(tracker).toContain("full exact shape identities and visibly labeled Type/X/Y/Width/Height");
    expect(testing).toContain("collision manager correction retains authored order and exact shape IDs");
    expect(testing).toContain("no collision-canvas redesign, schema, geometry/topology, semantic-agent, or confirmation-policy change");
  });
});

import type { CollisionShape } from "@aidraw/core";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";

type CollisionShapePatch = Partial<
  Pick<CollisionShape, "type" | "x" | "y" | "width" | "height">
>;

interface CollisionShapeManagerProps {
  tileId: number;
  shapes: CollisionShape[];
  selectedIds: string[];
  fallbackWidth: number;
  fallbackHeight: number;
  children: ReactNode;
  onSelect: (ids: string[]) => void;
  onChange: (shapeId: string, patch: CollisionShapePatch, label: string) => void;
  onDelete: (shapeId: string) => void;
  onDeleteSelected: (shapeIds: string[]) => void;
}

function collisionTypeLabel(type: CollisionShape["type"]): string {
  return type === "rectangle"
    ? "Rectangle"
    : type === "ellipse"
      ? "Ellipse"
      : type === "polygon"
        ? "Polygon"
        : "Polyline";
}

export function CollisionShapeManager({
  tileId,
  shapes,
  selectedIds,
  fallbackWidth,
  fallbackHeight,
  children,
  onSelect,
  onChange,
  onDelete,
  onDeleteSelected,
}: CollisionShapeManagerProps) {
  const shapeIdSet = new Set(shapes.map((shape) => shape.id));
  const activeSelectedIds = selectedIds.filter((id) => shapeIdSet.has(id));
  const selectedSet = new Set(activeSelectedIds);
  const selectShape = (shapeId: string, additive: boolean) => {
    if (!additive) {
      onSelect([shapeId]);
      return;
    }
    onSelect(selectedSet.has(shapeId)
      ? activeSelectedIds.filter((id) => id !== shapeId)
      : [...activeSelectedIds, shapeId]);
  };

  return (
    <>
      <div
        className="tile-collision-selection-actions"
        role="group"
        aria-label={`Collision selection actions for tile ${tileId}`}
      >
        <strong>{activeSelectedIds.length} of {shapes.length} selected</strong>
        <button
          type="button"
          aria-label={`Select all collision shapes for tile ${tileId}`}
          disabled={shapes.length === 0 || activeSelectedIds.length === shapes.length}
          onClick={() => onSelect(shapes.map((shape) => shape.id))}
        >
          Select all
        </button>
        <button
          type="button"
          aria-label={`Clear collision selection for tile ${tileId}`}
          disabled={activeSelectedIds.length === 0}
          onClick={() => onSelect([])}
        >
          Clear
        </button>
        <button
          type="button"
          className="tile-collision-delete-selected"
          aria-label={`Delete ${activeSelectedIds.length} selected collision shape${activeSelectedIds.length === 1 ? "" : "s"} from tile ${tileId}`}
          disabled={activeSelectedIds.length === 0}
          onClick={() => onDeleteSelected(activeSelectedIds)}
        >
          <Trash2 aria-hidden="true" />
          <span>Delete selected</span>
        </button>
      </div>
      {children}
      <div
        className="tile-collision-list"
        role="group"
        aria-label={`Collision shapes for tile ${tileId}`}
      >
        {shapes.map((shape, shapeIndex) => {
          const shapeNumber = shapeIndex + 1;
          const selected = selectedSet.has(shape.id);
          const typeLabel = collisionTypeLabel(shape.type);
          return (
            <fieldset
              className={`tile-collision-card${selected ? " is-selected" : ""}`}
              aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, ${typeLabel}`}
              key={shape.id}
              onClick={(event) => {
                const target = event.target as { closest?: (selector: string) => Element | null };
                if (target.closest?.("input, select, button, label")) return;
                selectShape(shape.id, event.shiftKey);
              }}
            >
              <legend>
                <label className="tile-collision-selection-toggle">
                  <input
                    aria-label={`Select collision shape ${shapeNumber}, ID ${shape.id}`}
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => onSelect(event.currentTarget.checked
                      ? selected
                        ? activeSelectedIds
                        : [...activeSelectedIds, shape.id]
                      : activeSelectedIds.filter((id) => id !== shape.id))}
                  />
                  <span>
                    <strong>Shape {shapeNumber}</strong>
                    <small>Shape ID {shape.id}</small>
                  </span>
                </label>
                <em className="tile-collision-selection-state" aria-hidden="true">
                  {selected ? "Selected" : "Not selected"}
                </em>
              </legend>
              <div className="tile-collision-fields">
                <label className="tile-collision-field is-type">
                  <span>Type</span>
                  <select
                    aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, type`}
                    value={shape.type}
                    onChange={(event) => onChange(shape.id, { type: event.currentTarget.value as CollisionShape["type"] }, "Change collision type")}
                  >
                    <option value="rectangle">Rectangle</option>
                    <option value="ellipse">Ellipse</option>
                    <option value="polygon">Polygon</option>
                    <option value="polyline">Polyline</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="tile-collision-delete"
                  aria-label={`Delete collision shape ${shapeNumber}, ID ${shape.id}`}
                  title={`Delete collision shape ${shapeNumber}, ID ${shape.id}`}
                  onClick={() => onDelete(shape.id)}
                >
                  <Trash2 aria-hidden="true" />
                  <span>Delete shape {shapeNumber}</span>
                </button>
                <label className="tile-collision-field">
                  <span>X</span>
                  <input
                    aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, X`}
                    type="number"
                    value={shape.x}
                    onChange={(event) => onChange(shape.id, { x: Number(event.currentTarget.value) }, "Move collision")}
                  />
                </label>
                <label className="tile-collision-field">
                  <span>Y</span>
                  <input
                    aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, Y`}
                    type="number"
                    value={shape.y}
                    onChange={(event) => onChange(shape.id, { y: Number(event.currentTarget.value) }, "Move collision")}
                  />
                </label>
                <label className="tile-collision-field">
                  <span>Width</span>
                  <input
                    aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, width`}
                    type="number"
                    value={shape.width ?? fallbackWidth}
                    onChange={(event) => onChange(shape.id, { width: Math.max(1, Number(event.currentTarget.value)) }, "Resize collision")}
                  />
                </label>
                <label className="tile-collision-field">
                  <span>Height</span>
                  <input
                    aria-label={`Collision shape ${shapeNumber}, ID ${shape.id}, height`}
                    type="number"
                    value={shape.height ?? fallbackHeight}
                    onChange={(event) => onChange(shape.id, { height: Math.max(1, Number(event.currentTarget.value)) }, "Resize collision")}
                  />
                </label>
              </div>
            </fieldset>
          );
        })}
      </div>
    </>
  );
}

import type { CSSProperties, ReactNode } from "react";
import type { WangSet } from "@aidraw/core";
import { Trash2 } from "lucide-react";

interface WangTerrainSetListProps {
  sets: WangSet[];
  activeSetId?: string;
  onSelect: (setId: string) => void;
}

interface WangTerrainSetEditorProps {
  set: WangSet;
  children: ReactNode;
  onRename: (name: string) => void;
  onChangeType: (type: WangSet["type"]) => void;
  onChangeColor: (
    colorIndex: number,
    patch: Partial<Pick<WangSet["colors"][number], "color" | "name" | "probability">>,
    label: string,
  ) => void;
  onDeleteColor: (colorId: number) => void;
}

function wangSetTypeLabel(type: WangSet["type"]): string {
  return type === "edge" ? "Edge" : type === "corner" ? "Corner" : "Mixed";
}

export function WangTerrainSetList({ sets, activeSetId, onSelect }: WangTerrainSetListProps) {
  return (
    <div className="wang-set-list" role="group" aria-label="Wang terrain sets">
      {sets.map((set) => {
        const selected = activeSetId === set.id;
        const typeLabel = wangSetTypeLabel(set.type);
        return (
          <button
            type="button"
            className={`wang-set-row${selected ? " is-active" : ""}`}
            key={set.id}
            aria-label={`Select Wang terrain set ${set.name}, ID ${set.id}, ${typeLabel} mode`}
            aria-pressed={selected}
            onClick={() => onSelect(set.id)}
          >
            <span
              aria-hidden="true"
              className="wang-set-swatch"
              style={{ "--terrain": set.colors[0]?.color ?? "#ff6b7a" } as CSSProperties}
            />
            <span className="wang-set-copy">
              <strong>{set.name}</strong>
              <small>Set ID {set.id} · {typeLabel} · {set.colors.length} color{set.colors.length === 1 ? "" : "s"} · {set.tiles.length} mapped tile{set.tiles.length === 1 ? "" : "s"}</small>
            </span>
            <span className="wang-set-state" aria-hidden="true">{selected ? "Selected" : "Select"}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WangTerrainSetEditor({
  set,
  children,
  onRename,
  onChangeType,
  onChangeColor,
  onDeleteColor,
}: WangTerrainSetEditorProps) {
  const typeLabel = wangSetTypeLabel(set.type);
  return (
    <div className="wang-editor">
      <div className="wang-active-set">
        <span>
          <strong>{set.name}</strong>
          <small>Selected set · ID {set.id}</small>
        </span>
        <em>{typeLabel} mode</em>
      </div>
      <div className="wang-set-fields">
        <label className="field">
          <span>Set name</span>
          <input
            key={`${set.id}:${set.name}`}
            aria-label={`Wang set ${set.id} name`}
            defaultValue={set.name}
            onBlur={(event) => {
              const name = event.currentTarget.value.trim();
              if (name && name !== set.name) onRename(name);
            }}
          />
        </label>
        <label className="field">
          <span>Mode</span>
          <select
            aria-label={`Wang set ${set.id} mode`}
            value={set.type}
            onChange={(event) => onChangeType(event.currentTarget.value as WangSet["type"])}
          >
            <option value="edge">Edge</option>
            <option value="corner">Corner</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>
      </div>
      <div className="wang-color-list" role="group" aria-label={`Colors in Wang set ${set.name}, ID ${set.id}`}>
        {set.colors.map((color, colorIndex) => (
          <fieldset className="wang-color-card" key={color.id}>
            <legend>
              <strong>{color.name}</strong>
              <small>Color ID {color.id}</small>
            </legend>
            <div className="wang-color-controls">
              <label className="wang-color-field is-color">
                <span>Color</span>
                <input
                  aria-label={`Wang color ${color.id} value`}
                  type="color"
                  value={color.color.slice(0, 7)}
                  onChange={(event) => onChangeColor(colorIndex, { color: event.currentTarget.value }, "Change Wang color")}
                />
              </label>
              <label className="wang-color-field is-name">
                <span>Name</span>
                <input
                  aria-label={`Wang color ${color.id} name`}
                  value={color.name}
                  onChange={(event) => onChangeColor(colorIndex, { name: event.currentTarget.value }, "Rename Wang color")}
                />
              </label>
              <label className="wang-color-field is-probability">
                <span>Probability</span>
                <input
                  aria-label={`Wang color ${color.id} probability`}
                  type="number"
                  min="0"
                  step="0.05"
                  value={color.probability}
                  onChange={(event) => onChangeColor(colorIndex, { probability: Math.max(0, Number(event.currentTarget.value) || 0) }, "Change Wang probability")}
                />
              </label>
              <button
                type="button"
                className="wang-color-delete"
                aria-label={`Delete Wang color ${color.name}, ID ${color.id}`}
                title={`Delete Wang color ${color.name}, ID ${color.id}`}
                onClick={() => onDeleteColor(color.id)}
              >
                <Trash2 aria-hidden="true" />
                <span>Delete color {color.id}</span>
              </button>
            </div>
          </fieldset>
        ))}
      </div>
      {children}
    </div>
  );
}

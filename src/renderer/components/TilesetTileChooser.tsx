import { Check } from "lucide-react";

export interface TilesetTileChooserProps {
  sourceKind: "atlas" | "image-collection";
  tileIds: readonly number[];
  selectedTileId: number;
  onSelect: (tileId: number) => void;
}

export function TilesetTileChooser({
  sourceKind,
  tileIds,
  selectedTileId,
  onSelect,
}: TilesetTileChooserProps) {
  const sourceLabel = sourceKind === "image-collection" ? "image-collection" : "atlas";
  if (tileIds.length === 0) {
    return (
      <p className="tile-definition-empty" role="status">
        No {sourceKind === "image-collection" ? "authored image-collection" : "atlas"} tile IDs are available.
      </p>
    );
  }

  return (
    <div className="tile-definition-grid" role="group" aria-label={`${sourceLabel} tile IDs`}>
      {tileIds.map((tileId) => {
        const selected = tileId === selectedTileId;
        return (
          <button
            key={tileId}
            type="button"
            className={selected ? "is-active" : undefined}
            aria-label={`${sourceLabel} tile ID ${tileId}, ${selected ? "selected" : "not selected"}`}
            aria-pressed={selected}
            onClick={() => onSelect(tileId)}
          >
            {selected && <span className="tile-definition-state" aria-hidden="true"><Check /></span>}
            <span className="tile-definition-id" aria-hidden="true">ID <strong>{tileId}</strong></span>
          </button>
        );
      })}
    </div>
  );
}

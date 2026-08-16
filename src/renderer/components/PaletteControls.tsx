import type { CSSProperties } from "react";
import type { PaletteEntry } from "@aidraw/core";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import type { PaletteImportMode } from "../../common/palette-interchange";

export const PALETTE_USAGE_REVIEW_LIMIT = 10_000;

export interface PaletteControlsProps {
  palette: readonly PaletteEntry[];
  selectedIndex: number;
  importMode: PaletteImportMode;
  replacementIndex: number;
  selectedUsage: number;
  hasCustomOverride: boolean;
  onImportModeChange: (mode: PaletteImportMode) => void;
  onImport: () => void;
  onExportJson: () => void;
  onExportGpl: () => void;
  onSelect: (index: number, color: string) => void;
  onColorChange: (color: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  onAdd: () => void;
  onDeleteUnused: () => void;
  onReplacementChange: (index: number) => void;
  onReplaceAndDelete: () => void;
}

function paletteEntryIdentity(entry: PaletteEntry, index: number): string {
  return `Index ${index} · ${entry.name} · ${entry.color} · ID ${entry.id}`;
}

function directDeleteReason(
  selectedIndex: number,
  paletteLength: number,
  selectedUsage: number,
  hasCustomOverride: boolean,
): string {
  if (selectedIndex === 0) return "Transparent index 0 cannot be deleted";
  if (selectedUsage > 0) return `Replace this color first; it is used ${selectedUsage >= PALETTE_USAGE_REVIEW_LIMIT ? `${PALETTE_USAGE_REVIEW_LIMIT}+` : selectedUsage} times`;
  if (hasCustomOverride) return "Clear this color's frame-specific overrides before deleting it";
  if (paletteLength <= 1) return "The palette must retain one entry";
  return "Delete selected unused palette color";
}

export function PaletteSwatch({
  entry,
  index,
  selected,
  onSelect,
}: {
  entry: PaletteEntry;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const transparency = index === 0 ? ", protected transparent" : "";
  const selection = selected ? "selected" : "not selected";
  return (
    <button
      type="button"
      className={`palette-swatch${index === 0 ? " is-transparent" : ""}${selected ? " is-active" : ""}`}
      style={{ "--swatch": entry.color } as CSSProperties}
      title={`${paletteEntryIdentity(entry, index)} · ${selection}`}
      aria-label={`Palette index ${index}, ${entry.name}, ${entry.color}${transparency}, ${selection}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {selected && <span className="palette-swatch-selection" aria-hidden="true"><Check /></span>}
      <span className="palette-swatch-index" aria-hidden="true">{index}</span>
    </button>
  );
}

export function PaletteControls({
  palette,
  selectedIndex,
  importMode,
  replacementIndex,
  selectedUsage,
  hasCustomOverride,
  onImportModeChange,
  onImport,
  onExportJson,
  onExportGpl,
  onSelect,
  onColorChange,
  onPrevious,
  onNext,
  onMoveEarlier,
  onMoveLater,
  onAdd,
  onDeleteUnused,
  onReplacementChange,
  onReplaceAndDelete,
}: PaletteControlsProps) {
  const selected = palette[selectedIndex] ?? palette[0];
  if (!selected) return null;
  const effectiveReplacementIndex = replacementIndex === selectedIndex || replacementIndex >= palette.length
    ? 0
    : replacementIndex;
  const replacement = palette[effectiveReplacementIndex] ?? palette[0];
  const deleteReason = directDeleteReason(selectedIndex, palette.length, selectedUsage, hasCustomOverride);
  const deleteDisabled = selectedIndex === 0 || selectedUsage > 0 || hasCustomOverride || palette.length <= 1;
  const usageMeaning = selectedUsage >= PALETTE_USAGE_REVIEW_LIMIT
    ? `${PALETTE_USAGE_REVIEW_LIMIT.toLocaleString("en-US")}+ indexed cel or reusable-stamp cells (bounded scan stopped at the limit).`
    : selectedUsage === 0
      ? "No indexed cel or reusable-stamp cell uses this source slot."
      : `${selectedUsage.toLocaleString("en-US")} indexed cel or reusable-stamp ${selectedUsage === 1 ? "cell uses" : "cells use"} this source slot.`;
  const overrideMeaning = hasCustomOverride
    ? "A frame-specific palette override has a custom value in this source slot; replacement normalizes it before removal."
    : "No frame-specific palette override has a custom value in this source slot.";

  return (
    <>
      <div className="palette-file-actions" role="group" aria-label="Palette file actions">
        <label className="palette-import-mode">
          <span>Import behavior</span>
          <select
            aria-label="Palette import behavior"
            value={importMode}
            onChange={(event) => onImportModeChange(event.target.value as PaletteImportMode)}
            title="How imported palette colors affect existing indexed artwork"
          >
            <option value="replace-slots">Replace colors by index</option>
            <option value="append-unique">Append unique colors</option>
          </select>
        </label>
        <button type="button" onClick={onImport} title="Import AIDraw JSON or GIMP GPL palette" aria-label="Import AIDraw JSON or GIMP GPL palette"><Upload /><span>Import</span></button>
        <button type="button" onClick={onExportJson} title="Export portable AIDraw palette JSON" aria-label="Export portable AIDraw palette JSON"><Download /><span>JSON</span></button>
        <button type="button" onClick={onExportGpl} title="Export GIMP palette; transparent index 0 is omitted" aria-label="Export GIMP GPL palette; transparent index 0 is omitted"><Download /><span>GPL</span></button>
      </div>

      <div className="palette-grid" role="group" aria-label="Indexed palette colors">
        {palette.map((entry, entryIndex) => (
          <PaletteSwatch
            key={entry.id}
            entry={entry}
            index={entryIndex}
            selected={entryIndex === selectedIndex}
            onSelect={() => onSelect(entryIndex, entry.color)}
          />
        ))}
      </div>

      <div className="palette-editor-row">
        <label className="palette-color-field">
          <span>Selected color</span>
          <input
            aria-label={`Edit selected palette color for index ${selectedIndex}, ${selected.name}`}
            type="color"
            value={selected.color.slice(0, 7)}
            onChange={(event) => onColorChange(event.target.value)}
          />
        </label>
        <div className="palette-selected-identity" aria-label={`Selected palette entry: ${paletteEntryIdentity(selected, selectedIndex)}`}>
          <strong>{selected.name}</strong>
          <small>{paletteEntryIdentity(selected, selectedIndex)}</small>
        </div>
        <div className="palette-selected-actions" role="group" aria-label={`Actions for palette index ${selectedIndex}`}>
          <button type="button" aria-label="Select previous palette color" title="Select previous palette color" disabled={selectedIndex <= 1} onClick={onPrevious}><ChevronLeft /><span>Previous</span></button>
          <button type="button" aria-label="Select next palette color" title="Select next palette color" disabled={selectedIndex >= palette.length - 1} onClick={onNext}><ChevronRight /><span>Next</span></button>
          <button type="button" aria-label="Move selected palette color one slot earlier" title="Move selected palette color one slot earlier" disabled={selectedIndex <= 1} onClick={onMoveEarlier}><ArrowUp /><span>Earlier</span></button>
          <button type="button" aria-label="Move selected palette color one slot later" title="Move selected palette color one slot later" disabled={selectedIndex <= 0 || selectedIndex >= palette.length - 1} onClick={onMoveLater}><ArrowDown /><span>Later</span></button>
          <button type="button" aria-label={palette.length >= 256 ? "Add palette color unavailable; palette has reached the 256-entry limit" : "Add palette color"} title={palette.length >= 256 ? "Palette has reached the 256-entry limit" : "Add palette color"} disabled={palette.length >= 256} onClick={onAdd}><Plus /><span>Add</span></button>
          <button type="button" aria-label={deleteReason} title={deleteReason} disabled={deleteDisabled} onClick={onDeleteUnused}><Trash2 /><span>Delete</span></button>
        </div>
      </div>

      {selectedIndex > 0 && palette.length > 1 && replacement && (
        <section className="palette-remap-row" aria-label={`Replace and delete palette index ${selectedIndex}`}>
          <div className="palette-remap-heading">
            <strong>Replace &amp; delete</strong>
            <small>One atomic indexed-palette change</small>
          </div>
          <dl className="palette-remap-facts">
            <div><dt>Selected source</dt><dd>{paletteEntryIdentity(selected, selectedIndex)}</dd></div>
            <div><dt>Indexed usage</dt><dd>{usageMeaning}</dd></div>
            <div><dt>Frame overrides</dt><dd>{overrideMeaning}</dd></div>
          </dl>
          <p className="palette-remap-explanation">This remaps the selected source across every indexed cel and reusable stamp, normalizes frame-specific overrides, repairs named cycles, and then removes only that palette slot.</p>
          <label className="palette-remap-target">
            <span>Replacement target</span>
            <select
              aria-label={`Replacement palette color for source index ${selectedIndex}`}
              value={effectiveReplacementIndex}
              onChange={(event) => onReplacementChange(Number(event.target.value))}
            >
              {palette.map((entry, entryIndex) => entryIndex === selectedIndex ? null : (
                <option key={entry.id} value={entryIndex}>{paletteEntryIdentity(entry, entryIndex)}</option>
              ))}
            </select>
          </label>
          <div className="palette-remap-selected-target" aria-live="polite">
            <span>Will replace with</span>
            <strong>{paletteEntryIdentity(replacement, effectiveReplacementIndex)}</strong>
          </div>
          <button
            type="button"
            className="palette-remap-apply"
            aria-label={`Replace palette index ${selectedIndex} with index ${effectiveReplacementIndex} and delete the source`}
            onClick={onReplaceAndDelete}
          >
            <Trash2 />
            <span>Replace &amp; delete</span>
          </button>
        </section>
      )}
    </>
  );
}

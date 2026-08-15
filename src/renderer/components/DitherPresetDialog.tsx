import { useState, type FormEvent } from 'react';
import {
  MAX_ORDERED_DITHER_PRESETS,
  MAX_ORDERED_DITHER_PRESET_NAME_LENGTH,
  orderedDitherPresetNameError,
  type OrderedDitherPreferences,
} from '../../common/ordered-dither-preferences';
import { EditorDialog } from './EditorDialog';

interface DitherPresetDialogProps {
  preferences: OrderedDitherPreferences;
  onSave(name: string): boolean;
  onApply(presetId: string): void;
  onDelete(presetId: string): void;
  onClose(): void;
}

interface OrderedDitherPhaseInputProps {
  axis: 'X' | 'Y';
  draft: string;
  onDraftChange(value: string): void;
  onCommit(): void;
  onCancel(): void;
}

/** A text-backed field so blank/sign-only and unfinished multi-digit drafts survive until commit. */
export function OrderedDitherPhaseInput({ axis, draft, onDraftChange, onCommit, onCancel }: OrderedDitherPhaseInputProps) {
  return (
    <label className="compact-field">
      <span>Phase {axis}</span>
      <input
        aria-label={`Ordered dither matrix-local phase ${axis}`}
        type="text"
        inputMode="numeric"
        pattern="[+-]?[0-9]*"
        value={draft}
        title="Enter a signed whole-cell value; press Enter or leave the field to normalize and apply."
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </label>
  );
}

export function DitherPresetDialog({ preferences, onSave, onApply, onDelete, onClose }: DitherPresetDialogProps) {
  const [name, setName] = useState('');
  const nameError = orderedDitherPresetNameError(name);
  const active = preferences.activePresetId === null
    ? undefined
    : preferences.presets.find((preset) => preset.id === preferences.activePresetId);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!nameError && onSave(name.trim())) setName('');
  };
  return (
    <EditorDialog
      title="Ordered dither presets"
      description="Saved locally across restarts. Reuse matrix, coverage, and matrix-local phase without carrying document palette choices."
      className="dither-preset-dialog"
      onClose={onClose}
    >
      <div className="dither-preset-body">
        <div className="dither-current-summary">
          <span><strong>{active ? `Current preset: ${active.name}` : 'Current settings: Custom'}</strong><small>{preferences.current.matrixSize}×{preferences.current.matrixSize} · {Math.round(preferences.current.coverage * 100)}% · phase {preferences.current.phaseX},{preferences.current.phaseY}</small></span>
          <em>{preferences.presets.length}/{MAX_ORDERED_DITHER_PRESETS} saved</em>
        </div>
        <p className="dither-palette-boundary">Base and mix palette indices stay with the current document and are never stored in presets.</p>
        <div className="dither-preset-list" aria-label="Saved ordered dither presets">
          {preferences.presets.length === 0 && <p className="dither-preset-empty">No saved dither presets yet.</p>}
          {preferences.presets.map((preset) => {
            const isActive = preset.id === preferences.activePresetId;
            return (
              <div key={preset.id} className={`dither-preset-row ${isActive ? 'is-active' : ''}`}>
                <button type="button" onClick={() => onApply(preset.id)} disabled={isActive} aria-label={`${isActive ? 'Current' : 'Apply'} dither preset ${preset.name}`}>
                  <strong>{preset.name}</strong>
                  <small>{preset.matrixSize}×{preset.matrixSize} · {Math.round(preset.coverage * 100)}% · phase {preset.phaseX},{preset.phaseY}</small>
                </button>
                <button type="button" className="delete-dither-preset" onClick={() => onDelete(preset.id)} aria-label={`Delete dither preset ${preset.name}`}>Delete</button>
              </div>
            );
          })}
        </div>
        <form className="save-dither-preset" onSubmit={save}>
          <label className="dialog-field"><span>Preset name</span><input aria-label="New dither preset name" maxLength={MAX_ORDERED_DITHER_PRESET_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} placeholder="Crosshatch 50" /></label>
          <button type="submit" disabled={Boolean(nameError) || preferences.presets.length >= MAX_ORDERED_DITHER_PRESETS}>Save current settings</button>
        </form>
        {name && nameError && <p className="entry-dialog-error" role="alert">{nameError}</p>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Close</button></footer>
    </EditorDialog>
  );
}

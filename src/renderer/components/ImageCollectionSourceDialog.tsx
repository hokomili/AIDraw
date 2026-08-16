import { useState, type FormEvent } from 'react';
import type { PixelDocument } from '@aidraw/core';

import {
  ImageCollectionSourceDialogLifecycle,
  type ImageCollectionSourceOpening,
} from '../image-collection-source-opening';
import { EditorDialog } from './EditorDialog';

interface ImageCollectionSourceDialogProps {
  opening: ImageCollectionSourceOpening;
  currentDocument: PixelDocument;
  currentTilesetId?: string;
  onSubmit(opening: ImageCollectionSourceOpening, input: { name?: string; sourceIds: string[] }): Promise<boolean>;
  onClose(): void;
}

export function ImageCollectionSourceDialog({
  opening,
  currentDocument,
  currentTilesetId,
  onSubmit,
  onClose,
}: ImageCollectionSourceDialogProps) {
  const [lifecycle] = useState(() => new ImageCollectionSourceDialogLifecycle(opening));
  const [, setSelectionVersion] = useState(0);
  const [name, setName] = useState(opening.defaultName ?? 'Image collection');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const view = lifecycle.observe(currentDocument, currentTilesetId);
  const normalizedName = name.trim();
  const nameError = opening.mode === 'create' && (!normalizedName || normalizedName.length > 200)
    ? 'Enter a collection name from 1 to 200 characters.'
    : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (view.contextError) {
      setError(view.contextError);
      return;
    }
    if (nameError || view.selectedInAuthoredOrder.length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const applied = await onSubmit(opening, {
        ...(opening.mode === 'create' ? { name: normalizedName } : {}),
        sourceIds: view.selectedInAuthoredOrder,
      });
      if (applied) onClose();
      else setError('The document changed or the image-collection transaction was refused. Review the warning and reopen this chooser.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The image-collection transaction could not be prepared.');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (sourceId: string) => {
    const toggleError = lifecycle.toggle(sourceId);
    setError(toggleError);
    setSelectionVersion((value) => value + 1);
  };
  const availableCount = opening.choices.filter((choice) => !choice.unavailableReason).length;

  return <EditorDialog
    title={opening.mode === 'create' ? 'Create image collection' : `Append to ${opening.target?.name ?? 'image collection'}`}
    description={opening.mode === 'create'
      ? 'Reference exact one-frame sprite assets in their opening project order. No atlas or sprite copy is created.'
      : 'Add one exact one-frame sprite above the collection’s opening sparse local-ID span.'}
    className="image-collection-source-dialog"
    onClose={onClose}
  >
    <form onSubmit={(event) => void submit(event)}>
      <div className="entry-dialog-body image-collection-source-body">
        {opening.mode === 'create' && <label className="dialog-field"><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(nameError)} /></label>}
        <fieldset className="image-collection-source-list">
          <legend>{opening.mode === 'create' ? 'Sprite sources in opening project order' : 'Sprite source to append'}</legend>
          {opening.choices.map((choice) => <label key={choice.id} className={choice.unavailableReason ? 'is-unavailable' : ''}>
            <input
              type={opening.mode === 'create' ? 'checkbox' : 'radio'}
              name="image-collection-source"
              checked={view.selectedIds.includes(choice.id)}
              disabled={busy || Boolean(view.contextError) || Boolean(choice.unavailableReason)}
              onChange={() => toggle(choice.id)}
            />
            <span><strong>{choice.name}</strong><small>{choice.width} × {choice.height}px · {choice.frameCount} frame{choice.frameCount === 1 ? '' : 's'}{choice.unavailableReason ? ` · ${choice.unavailableReason}` : ''}</small></span>
          </label>)}
          {opening.choices.length === 0 && <p>No sprite assets exist in this pixel document.</p>}
        </fieldset>
        <p className="fine-print">Only one-frame canonical sprites are eligible. Existing source pixels, layers, frames, IDs, and history remain owned by their source assets.</p>
        {nameError && <p className="entry-dialog-error" role="alert">{nameError}</p>}
        {view.contextError && <p className="entry-dialog-error" role="alert">{view.contextError}</p>}
        {error && error !== view.contextError && <p className="entry-dialog-error" role="alert">{error}</p>}
        {availableCount === 0 && <p className="entry-dialog-error" role="status">Create or retain an exact one-frame sprite before using this workflow.</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-modal-button" disabled={busy || Boolean(view.contextError) || Boolean(nameError) || view.selectedInAuthoredOrder.length === 0}>
          {busy ? 'Applying…' : opening.mode === 'create' ? `Create with ${view.selectedInAuthoredOrder.length} source${view.selectedInAuthoredOrder.length === 1 ? '' : 's'}` : 'Append source'}
        </button>
      </footer>
    </form>
  </EditorDialog>;
}

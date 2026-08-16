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
  const replacing = opening.mode === 'replace';
  const removing = opening.mode === 'remove';
  const impact = opening.impact;
  const removalProof = opening.removalProof;
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
    if (nameError || (!removing && view.selectedInAuthoredOrder.length === 0) || ((replacing || removing) && !view.impactConfirmed) || busy) return;
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
  const confirmImpact = (confirmed: boolean) => {
    const confirmationError = removing ? lifecycle.confirmRemoval(confirmed) : lifecycle.confirmReplacement(confirmed);
    setError(confirmationError);
    setSelectionVersion((value) => value + 1);
  };
  const availableCount = opening.choices.filter((choice) => !choice.unavailableReason).length;

  return <EditorDialog
    title={opening.mode === 'create'
      ? 'Create image collection'
      : replacing
        ? `Replace tile ${opening.target?.tileId ?? ''} source`
        : removing
          ? `Remove unused tile ${opening.target?.tileId ?? ''}`
          : `Append to ${opening.target?.name ?? 'image collection'}`}
    description={opening.mode === 'create'
      ? 'Reference exact one-frame sprite assets in their opening project order. No atlas or sprite copy is created.'
      : replacing
        ? 'Choose one unused exact sprite. The stable local tile ID and every authored tile record stay unchanged while its artwork changes everywhere.'
        : removing
          ? 'Detach only this proven-unused sparse tile record. No source sprite, GID, map cell, animation, object, stamp, or other record is rewritten or deleted.'
          : 'Add one exact one-frame sprite above the collection’s opening sparse local-ID span.'}
    className="image-collection-source-dialog"
    onClose={onClose}
  >
    <form onSubmit={(event) => void submit(event)}>
      <div className="entry-dialog-body image-collection-source-body">
        {opening.mode === 'create' && <label className="dialog-field"><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(nameError)} /></label>}
        {!removing && <fieldset className="image-collection-source-list">
          <legend>{opening.mode === 'create' ? 'Sprite sources in opening project order' : replacing ? 'Replacement sprite source' : 'Sprite source to append'}</legend>
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
        </fieldset>}
        {replacing && impact && <section className="image-collection-replacement-impact" aria-label="Document-wide replacement impact">
          <strong>Stable tile {opening.target?.tileId} · base GID {impact.baseGid}</strong>
          <p>The new artwork will resolve for {impact.directMapCellCount.toLocaleString('en-US')} direct map cell{impact.directMapCellCount === 1 ? '' : 's'} across {impact.attachedMapCount.toLocaleString('en-US')} attached map{impact.attachedMapCount === 1 ? '' : 's'}, plus {impact.animationReferenceCount.toLocaleString('en-US')} ordered animation reference{impact.animationReferenceCount === 1 ? '' : 's'}.</p>
          <p>Probability, properties, animation, collisions, raw GIDs, transforms, offsets, and source sprites remain unchanged.</p>
          <label><input type="checkbox" checked={view.impactConfirmed} disabled={busy || Boolean(view.contextError) || view.selectedInAuthoredOrder.length === 0} onChange={(event) => confirmImpact(event.currentTarget.checked)} /> I understand this replaces tile {opening.target?.tileId} artwork everywhere it is referenced.</label>
        </section>}
        {removing && removalProof && <section className="image-collection-replacement-impact" aria-label="Unused source removal confirmation">
          <strong>Tile {opening.target?.tileId} · {opening.target?.sourceName ?? removalProof.sourceName} · source {removalProof.sourceId}</strong>
          <p>The bounded proof found no retained use of base GID {removalProof.baseGid} after scanning {removalProof.scannedReferenceCount.toLocaleString('en-US')} canonical reference entr{removalProof.scannedReferenceCount === 1 ? 'y' : 'ies'} across map cells, tile objects, retained animations, and reusable tile stamps.</p>
          <p>Only this tile record is removed. Its local ID becomes a sparse gap; the source sprite and every map cell, raw transformed GID, other tile record, and unrelated asset remain byte-for-byte owned by their current records.</p>
          <label><input type="checkbox" checked={view.impactConfirmed} disabled={busy || Boolean(view.contextError)} onChange={(event) => confirmImpact(event.currentTarget.checked)} /> I understand tile {opening.target?.tileId} is detached without cascading, rewriting references, or deleting its source sprite.</label>
        </section>}
        <p className="fine-print">{removing ? 'Removal is admitted only after an exact bounded reference proof and leaves at least one source in the collection.' : 'Only one-frame canonical sprites are eligible. Existing source pixels, layers, frames, IDs, and history remain owned by their source assets.'}</p>
        {nameError && <p className="entry-dialog-error" role="alert">{nameError}</p>}
        {view.contextError && <p className="entry-dialog-error" role="alert">{view.contextError}</p>}
        {error && error !== view.contextError && <p className="entry-dialog-error" role="alert">{error}</p>}
        {!removing && availableCount === 0 && <p className="entry-dialog-error" role="status">Create or retain an exact one-frame sprite before using this workflow.</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-modal-button" disabled={busy || Boolean(view.contextError) || Boolean(nameError) || (!removing && view.selectedInAuthoredOrder.length === 0) || ((replacing || removing) && !view.impactConfirmed)}>
          {busy ? 'Applying…' : opening.mode === 'create' ? `Create with ${view.selectedInAuthoredOrder.length} source${view.selectedInAuthoredOrder.length === 1 ? '' : 's'}` : replacing ? 'Replace source everywhere' : removing ? `Remove unused tile ${opening.target?.tileId ?? ''}` : 'Append source'}
        </button>
      </footer>
    </form>
  </EditorDialog>;
}

import { useState, type FormEvent } from 'react';
import type { PixelDocument } from '@aidraw/core';

import {
  imageCollectionTileMoveOpeningGuardError,
  type ImageCollectionTileMoveOpening,
  type ImageCollectionTileMoveReview,
} from '../image-collection-tile-move-opening';
import { EditorDialog } from './EditorDialog';

interface ImageCollectionTileMoveDialogProps {
  opening: ImageCollectionTileMoveOpening;
  currentDocument: PixelDocument;
  currentTilesetId?: string;
  onReview(
    opening: ImageCollectionTileMoveOpening,
    destinationTileId: number,
  ): ImageCollectionTileMoveReview;
  onSubmit(
    opening: ImageCollectionTileMoveOpening,
    review: ImageCollectionTileMoveReview,
  ): Promise<boolean>;
  onClose(): void;
}

export function ImageCollectionTileMoveImpactReview({
  review,
  confirmed,
  disabled,
  onConfirm,
}: {
  review: ImageCollectionTileMoveReview;
  confirmed: boolean;
  disabled: boolean;
  onConfirm(confirmed: boolean): void;
}) {
  const { impact } = review;
  return <section className="image-collection-replacement-impact" aria-label="Exact tile ID move impact">
    <strong>Tile {impact.sourceTileId} → {impact.destinationTileId} · GID {impact.oldBaseGid} → {impact.newBaseGid}</strong>
    <p>{impact.rewrittenReferenceCount.toLocaleString('en-US')} direct reference{impact.rewrittenReferenceCount === 1 ? '' : 's'} will be rewritten by {impact.operationCount.toLocaleString('en-US')} canonical operation{impact.operationCount === 1 ? '' : 's'} after scanning {impact.scannedReferenceCount.toLocaleString('en-US')} bounded entr{impact.scannedReferenceCount === 1 ? 'y' : 'ies'}.</p>
    <p>{impact.attachedMapCount.toLocaleString('en-US')} attached map{impact.attachedMapCount === 1 ? '' : 's'} checked; {impact.maps.length.toLocaleString('en-US')} contain{impact.maps.length === 1 ? 's' : ''} direct references that will move.</p>
    <p>{impact.mapCellCount.toLocaleString('en-US')} map cell{impact.mapCellCount === 1 ? '' : 's'}, {impact.tileObjectCount.toLocaleString('en-US')} tile object{impact.tileObjectCount === 1 ? '' : 's'}, {impact.animationFrameCount.toLocaleString('en-US')} animation frame target{impact.animationFrameCount === 1 ? '' : 's'}, {impact.wangColorCount.toLocaleString('en-US')} Wang representative{impact.wangColorCount === 1 ? '' : 's'}, {impact.wangTileCount.toLocaleString('en-US')} Wang signature record{impact.wangTileCount === 1 ? '' : 's'}, and {impact.tileStampCellCount.toLocaleString('en-US')} reusable stamp cell{impact.tileStampCellCount === 1 ? '' : 's'}.</p>
    {impact.maps.length > 0 && <ul>{impact.maps.map((map) => <li key={map.mapId}><strong>{map.mapName}</strong> · {map.orientation} {map.infinite ? 'sparse infinite' : 'finite'} · {map.tileCellCount} cell{map.tileCellCount === 1 ? '' : 's'} · {map.tileObjectCount} object{map.tileObjectCount === 1 ? '' : 's'} · layers {map.layerIds.join(', ')}</li>)}</ul>}
    {impact.animations.length > 0 && <p>Animation owners: {impact.animations.map((entry) => `tile ${entry.tileId} (${entry.frameCount})`).join(', ')}.</p>}
    {impact.wangSets.length > 0 && <p>Wang sets: {impact.wangSets.map((entry) => `${entry.setName} [${entry.setId}] (${entry.colorCount} representative, ${entry.tileCount} signature)`).join('; ')}.</p>}
    {impact.stamps.length > 0 && <p>Reusable stamps: {impact.stamps.map((entry) => `${entry.stampName} [${entry.stampId}] (${entry.cellCount})`).join('; ')}.</p>}
    <p>The sprite bytes, complete tile metadata, map/stamp geometry, H/V/diagonal flags, collection firstGid and authored span stay unchanged. Only the record ID and exact supported direct references above move.</p>
    <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onConfirm(event.currentTarget.checked)} /> I reviewed tile {impact.sourceTileId} → {impact.destinationTileId} and understand every named reference is rewritten atomically.</label>
  </section>;
}

export function ImageCollectionTileMoveDialog({
  opening,
  currentDocument,
  currentTilesetId,
  onReview,
  onSubmit,
  onClose,
}: ImageCollectionTileMoveDialogProps) {
  const [destinationDraft, setDestinationDraft] = useState(String(opening.target.defaultDestinationTileId));
  const [review, setReview] = useState<ImageCollectionTileMoveReview>();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const contextError = imageCollectionTileMoveOpeningGuardError(opening, currentDocument, currentTilesetId);
  const destinationTileId = Number(destinationDraft);
  const draftValid = destinationDraft.trim().length > 0
    && Number.isSafeInteger(destinationTileId)
    && destinationTileId >= 0
    && destinationTileId <= opening.target.maximumLocalId;

  const changeDestination = (value: string) => {
    setDestinationDraft(value);
    setReview(undefined);
    setConfirmed(false);
    setError(undefined);
  };
  const prepareReview = () => {
    if (contextError) {
      setError(contextError);
      return;
    }
    if (!draftValid) {
      setError(`Enter one unused whole local ID from 0 through ${opening.target.maximumLocalId}.`);
      return;
    }
    try {
      setReview(onReview(opening, destinationTileId));
      setConfirmed(false);
      setError(undefined);
    } catch (caught) {
      setReview(undefined);
      setConfirmed(false);
      setError(caught instanceof Error ? caught.message : 'The exact tile-move impact could not be reviewed.');
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!review || !confirmed || busy || contextError) return;
    setBusy(true);
    setError(undefined);
    try {
      const applied = await onSubmit(opening, review);
      if (applied) onClose();
      else setError('The document changed or the reviewed tile move was refused. Close this review, reopen it, and try again.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The reviewed tile move could not be applied.');
    } finally {
      setBusy(false);
    }
  };
  const impact = review?.impact;

  return <EditorDialog
    title={`Move image-collection tile ${opening.target.sourceTileId}`}
    description={`Move the exact sparse record backed by “${opening.target.sourceName}” into one existing unused local-ID gap. The collection range does not change.`}
    className="image-collection-source-dialog image-collection-tile-move-dialog"
    onClose={onClose}
  >
    <form onSubmit={(event) => void submit(event)}>
      <div className="entry-dialog-body image-collection-source-body">
        <section className="image-collection-replacement-impact" aria-label="Selected image-collection tile identity">
          <strong>{opening.target.name} · tile {opening.target.sourceTileId} · {opening.target.sourceName}</strong>
          <p>Source {opening.target.sourceId} · {opening.target.sourceWidth} × {opening.target.sourceHeight}px · collection span 0–{opening.target.maximumLocalId}</p>
        </section>
        <label className="dialog-field">
          <span>Unused destination local ID</span>
          <input
            autoFocus
            type="number"
            min={0}
            max={opening.target.maximumLocalId}
            step={1}
            value={destinationDraft}
            aria-invalid={!draftValid}
            disabled={busy || Boolean(contextError)}
            onChange={(event) => changeDestination(event.currentTarget.value)}
          />
          <small>The destination must be an unused gap inside 0–{opening.target.maximumLocalId}. Tile {opening.target.sourceTileId}, the current highest ID, and occupied IDs are refused.</small>
        </label>
        <div className="tileset-actions"><button type="button" disabled={busy || Boolean(contextError) || !draftValid} onClick={prepareReview}>Review exact old→new impact</button></div>
        {impact && <ImageCollectionTileMoveImpactReview review={review} confirmed={confirmed} disabled={busy || Boolean(contextError)} onConfirm={setConfirmed} />}
        {contextError && <p className="entry-dialog-error" role="alert">{contextError}</p>}
        {error && error !== contextError && <p className="entry-dialog-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-modal-button" disabled={busy || Boolean(contextError) || !review || !confirmed}>
          {busy ? 'Applying…' : review ? `Move tile ${review.impact.sourceTileId} to ${review.destinationTileId}` : 'Review before Apply'}
        </button>
      </footer>
    </form>
  </EditorDialog>;
}

import { useState } from 'react';
import { Check, Maximize2 } from 'lucide-react';
import type { PixelSprite } from '@aidraw/core';
import {
  MAX_PIXEL_DIMENSION,
  MIN_PIXEL_DIMENSION,
  reviewPixelCanvasSize,
  type PixelCanvasSizeReview,
} from '../pixel-project-sizing';

function resizeConsequence(review: PixelCanvasSizeReview): { title: string; details: string[] } {
  if (review.change === 'unchanged') {
    return {
      title: 'Unchanged',
      details: ['The draft matches the committed canvas, so Resize is unavailable.'],
    };
  }
  const details = ['The top-left anchor stays fixed; existing pixels are never resampled or moved.'];
  if (review.widthChange === 'shrink') details.push('Width shrinks: pixels beyond the new right edge are cropped.');
  if (review.widthChange === 'expand') details.push('Width expands: transparent space is added at the right edge.');
  if (review.heightChange === 'shrink') details.push('Height shrinks: pixels beyond the new bottom edge are cropped.');
  if (review.heightChange === 'expand') details.push('Height expands: transparent space is added at the bottom edge.');
  details.push('Undo restores the previous complete canvas.');
  return { title: 'Resize ready', details };
}

export function PixelCanvasSizeControls({
  sprite,
  width,
  height,
  onWidthChange,
  onHeightChange,
  onResize,
}: {
  sprite: Pick<PixelSprite, 'id' | 'width' | 'height'>;
  width: string;
  height: string;
  onWidthChange: (value: string) => void;
  onHeightChange: (value: string) => void;
  onResize: (width: number, height: number) => void;
}) {
  const review = reviewPixelCanvasSize(sprite, width, height);
  const consequence = resizeConsequence(review);
  return <section className="pixel-size-editor" aria-label="Sprite canvas size decision">
    <div className="section-heading">
      <span>Sprite canvas</span>
      <small>Top-left anchor</small>
    </div>
    <div className="pixel-size-review" aria-label="Current and drafted sprite dimensions">
      <div>
        <small>Current canvas</small>
        <strong>{review.currentWidth} × {review.currentHeight} px</strong>
        <span>Committed sprite dimensions</span>
      </div>
      <div className={`is-${review.change}`}>
        <small>Draft canvas</small>
        <strong>{review.draftWidth} × {review.draftHeight} px</strong>
        <span>{consequence.title}</span>
      </div>
    </div>
    <div className="pixel-size-fields">
      <label>
        <span>Draft width</span>
        <input
          aria-label="Sprite canvas width"
          type="number"
          min={MIN_PIXEL_DIMENSION}
          max={MAX_PIXEL_DIMENSION}
          value={width}
          onChange={(event) => onWidthChange(event.target.value)}
        />
      </label>
      <span aria-hidden="true">×</span>
      <label>
        <span>Draft height</span>
        <input
          aria-label="Sprite canvas height"
          type="number"
          min={MIN_PIXEL_DIMENSION}
          max={MAX_PIXEL_DIMENSION}
          value={height}
          onChange={(event) => onHeightChange(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={review.change === 'unchanged'}
        onClick={() => onResize(review.draftWidth, review.draftHeight)}
      >
        <Maximize2 aria-hidden="true" />
        <span>Resize</span>
      </button>
    </div>
    <div className={`pixel-size-consequence is-${review.change}`} role="status">
      <strong>{consequence.title}</strong>
      {consequence.details.map((detail) => <span key={detail}>{detail}</span>)}
      {review.normalized && <small>Draft inputs resolve to whole pixels between 1 and 8192 before resize.</small>}
    </div>
  </section>;
}

export function PixelCanvasSizeEditor({
  sprite,
  onResize,
}: {
  sprite: PixelSprite;
  onResize: (width: number, height: number) => void;
}) {
  const [width, setWidth] = useState(String(sprite.width));
  const [height, setHeight] = useState(String(sprite.height));
  return <PixelCanvasSizeControls
    sprite={sprite}
    width={width}
    height={height}
    onWidthChange={setWidth}
    onHeightChange={setHeight}
    onResize={(nextWidth, nextHeight) => {
      setWidth(String(nextWidth));
      setHeight(String(nextHeight));
      onResize(nextWidth, nextHeight);
    }}
  />;
}

export function PixelCreationSizeReview({
  kind,
  width,
  height,
}: {
  kind: 'sprite' | 'project';
  width: number;
  height: number;
}) {
  const label = kind === 'project' ? 'Starting sprite canvas' : 'Sprite canvas';
  return <section className="pixel-creation-size-review" aria-label="Pixel canvas creation review">
    <small>{label}</small>
    <strong>{width} × {height} px</strong>
    <span>A new indexed canvas is created at these exact dimensions; no existing artwork is resized.</span>
  </section>;
}

export function TilemapStorageChoice({
  context = 'creation',
  infinite,
  width,
  height,
  tileWidth,
  tileHeight,
  orientation,
  onChange,
}: {
  context?: 'creation' | 'existing';
  infinite: boolean;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  orientation: 'orthogonal' | 'isometric';
  onChange: (infinite: boolean) => void;
}) {
  const existing = context === 'existing';
  const radioName = existing ? 'existing-map-storage' : 'new-tilemap-storage';
  const descriptionPrefix = existing ? 'existing-map-storage' : 'new-tilemap-storage';
  const reviewId = `${descriptionPrefix}-geometry-review`;
  const extentLabel = existing ? 'current' : 'initial';
  return <fieldset className={`tilemap-storage-choice${existing ? ' map-geometry-storage-choice' : ''}`}>
    <legend>{existing ? 'Map storage and view mode' : 'Map extent and storage'}</legend>
    <div className="tilemap-storage-options">
      <label className={!infinite ? 'is-selected' : undefined}>
        <input
          type="radio"
          name={radioName}
          checked={!infinite}
          aria-label={existing ? 'Use finite map mode' : 'Use finite tilemap storage'}
          aria-describedby={`${descriptionPrefix}-finite-description ${reviewId}`}
          onChange={() => onChange(false)}
        />
        <span>
          <strong>Finite map</strong>
          <small id={`${descriptionPrefix}-finite-description`}>{existing
            ? `${width} × ${height} current cells form the complete addressed map. Painting stays inside these bounds.`
            : `${width} × ${height} addressed cells. Painting stays inside the configured bounds.`}</small>
        </span>
        <span className="tilemap-storage-state" aria-hidden="true">
          {!infinite && <Check />}
          {!infinite ? 'Selected' : 'Available'}
        </span>
      </label>
      <label className={infinite ? 'is-selected' : undefined}>
        <input
          type="radio"
          name={radioName}
          checked={infinite}
          aria-label={existing ? 'Use sparse infinite map mode' : 'Use sparse infinite tilemap storage'}
          aria-describedby={`${descriptionPrefix}-infinite-description ${reviewId}`}
          onChange={() => onChange(true)}
        />
        <span>
          <strong>Sparse infinite map</strong>
          <small id={`${descriptionPrefix}-infinite-description`}>{existing
            ? `The ${width} × ${height} current extent remains the initial view; painted regions beyond it use 32 × 32 chunks.`
            : `Starts at ${width} × ${height} cells; painted regions beyond it use 32 × 32 chunks.`}</small>
        </span>
        <span className="tilemap-storage-state" aria-hidden="true">
          {infinite && <Check />}
          {infinite ? 'Selected' : 'Available'}
        </span>
      </label>
    </div>
    <p className="tilemap-storage-review" id={reviewId}>
      <strong>{existing ? 'Current map geometry' : 'Configured map'}</strong>
      <span>{orientation === 'orthogonal' ? 'Orthogonal' : 'Isometric'} · {width} × {height} {extentLabel} cells · {tileWidth} × {tileHeight} px tiles</span>
    </p>
  </fieldset>;
}

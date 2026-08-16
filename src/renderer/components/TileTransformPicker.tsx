import { useEffect, useRef, type ReactNode } from 'react';
import { tilesetHasLocalId, type PixelDocument, type PixelSprite, type PixelTileset } from '@aidraw/core';
import { Check, X } from 'lucide-react';
import {
  TILE_TRANSFORM_CHOICES,
  tileTransformChoiceAllowed,
  tileTransformChoiceId,
  tileTransformPreviewGeometry,
  type TileTransformChoice,
  type TileTransformFlags,
} from '../../common/tile-transform-options';
import { tilesetTileSourceRect } from '../../common/tile-animation';
import { drawSpriteRegionThumbnail } from '../canvas/pixel-bitmap';

const TILE_TRANSFORM_PREVIEW_SIDE = 32;

export function TileTransformChoiceControl({ choice, active, disabled, preview, onSelect }: {
  choice: TileTransformChoice;
  active: boolean;
  disabled: boolean;
  preview?: ReactNode;
  onSelect: (value: TileTransformFlags) => void;
}) {
  const visibleState = active
    ? disabled ? 'Selected · unavailable' : 'Selected'
    : disabled ? 'Unavailable' : 'Available';
  const accessibleState = disabled
    ? 'Unavailable under this tileset’s capabilities.'
    : 'Available under this tileset’s capabilities.';
  return <button
    type="button"
    className={[active ? 'is-active' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}
    disabled={disabled}
    aria-pressed={active}
    aria-label={`Use ${choice.label.toLocaleLowerCase()} tile transform. ${accessibleState}${active ? ' Currently selected.' : ''}`}
    title={`${choice.label} · ${accessibleState}`}
    onClick={() => onSelect({ ...choice.flags })}
  >
    {preview}
    <span className="tile-transform-choice-copy">
      <strong>{choice.label}</strong>
      <small>{choice.shortLabel === '—' ? 'No transform flags' : `${choice.shortLabel} flags`}</small>
    </span>
    <span className={`tile-transform-choice-state${active ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`} aria-hidden="true">
      {active && <Check />}
      <span>{visibleState}</span>
    </span>
  </button>;
}

function TransformSwatch({ palette, sprite, tileset, tileId, choice, active, disabled, onSelect }: {
  palette: PixelDocument['palette'];
  sprite?: PixelSprite;
  tileset: PixelTileset;
  tileId: number;
  choice: TileTransformChoice;
  active: boolean;
  disabled: boolean;
  onSelect: (value: TileTransformFlags) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = TILE_TRANSFORM_PREVIEW_SIDE;
    canvas.height = TILE_TRANSFORM_PREVIEW_SIDE;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const frameId = sprite?.frameIds[0];
    if (!sprite || !frameId || !tilesetHasLocalId(tileset, tileId)) return;
    let sourceRect: ReturnType<typeof tilesetTileSourceRect>;
    try { sourceRect = tilesetTileSourceRect(tileset, tileId, sprite); } catch { return; }
    const geometry = tileTransformPreviewGeometry(sourceRect.width, sourceRect.height, choice.flags, TILE_TRANSFORM_PREVIEW_SIDE);
    const source = window.document.createElement('canvas');
    source.width = geometry.sampleWidth;
    source.height = geometry.sampleHeight;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) return;
    drawSpriteRegionThumbnail(
      sourceContext,
      sprite,
      frameId,
      palette,
      sourceRect,
      source.width,
      source.height,
    );
    context.save();
    context.imageSmoothingEnabled = false;
    context.translate(canvas.width / 2, canvas.height / 2);
    context.transform(geometry.transform.a, geometry.transform.b, geometry.transform.c, geometry.transform.d, 0, 0);
    context.drawImage(source, -geometry.drawWidth / 2, -geometry.drawHeight / 2, geometry.drawWidth, geometry.drawHeight);
    context.restore();
    source.width = 1;
    source.height = 1;
  }, [choice.flags, palette, sprite, tileId, tileset]);
  return <TileTransformChoiceControl
    choice={choice}
    active={active}
    disabled={disabled}
    onSelect={onSelect}
    preview={<span className="tile-transform-preview"><canvas ref={canvasRef} /></span>}
  />;
}

export function TileTransformPicker({ document, sprite, tileset, tileId, value, onChange, onClose }: {
  document: PixelDocument;
  sprite?: PixelSprite;
  tileset: PixelTileset;
  tileId: number;
  value: TileTransformFlags;
  onChange: (value: TileTransformFlags) => void;
  onClose: () => void;
}) {
  const activeId = tileTransformChoiceId(value);
  const activeChoice = TILE_TRANSFORM_CHOICES.find((choice) => choice.id === activeId) ?? TILE_TRANSFORM_CHOICES[0]!;
  const activeAllowed = tileTransformChoiceAllowed(activeChoice, tileset.transformations);
  let sourceSize = `${tileset.tileWidth} × ${tileset.tileHeight}px`;
  try { if (sprite && tilesetHasLocalId(tileset, tileId)) { const rect = tilesetTileSourceRect(tileset, tileId, sprite); sourceSize = `${rect.width} × ${rect.height}px`; } } catch { /* Keep the nominal fallback label. */ }
  return <section id="tile-transform-picker" className="tile-transform-picker" aria-label="Tile transform preview">
    <header>
      <span><strong>Tile transform</strong><small>Choose one exact session-local transform for tile ID {tileId}.</small></span>
      <button type="button" className="tile-transform-close" aria-label="Close tile transform preview" onClick={onClose}><X /><span>Close</span></button>
    </header>
    <div className="tile-transform-review" aria-label="Current tile transform review">
      <div><small>Selected tile source</small><strong>{sprite ? sprite.name : 'Source unavailable'}</strong><span>Tile ID {tileId} · {sprite ? sourceSize : `nominal ${sourceSize}`}</span></div>
      <div><small>Current transform</small><strong>{activeChoice.shortLabel} · {activeChoice.label}</strong><span>{activeAllowed ? 'Available under this tileset’s capabilities' : 'Unavailable under this tileset’s capabilities'}</span></div>
    </div>
    <p className="tile-transform-order-note"><strong>Tiled transform order</strong><span>Diagonal is applied first, then horizontal and vertical. A diagonal rectangular preview therefore swaps the visible footprint axes.</span></p>
    <div className="tile-transform-grid" aria-label="Eight tile transform choices">
      {TILE_TRANSFORM_CHOICES.map((choice) => <TransformSwatch
        key={choice.id}
        palette={document.palette}
        sprite={sprite}
        tileset={tileset}
        tileId={tileId}
        choice={choice}
        active={choice.id === activeId}
        disabled={!tileTransformChoiceAllowed(choice, tileset.transformations)}
        onSelect={onChange}
      />)}
    </div>
    <footer><strong>Preview only</strong><span>Each nearest-neighbor sample aspect-fits the complete transformed footprint inside {TILE_TRANSFORM_PREVIEW_SIDE} × {TILE_TRANSFORM_PREVIEW_SIDE}px. Existing GIDs, source pixels, and canonical documents remain unchanged.</span></footer>
  </section>;
}

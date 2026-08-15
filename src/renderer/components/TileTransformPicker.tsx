import { useEffect, useRef } from 'react';
import type { PixelDocument, PixelSprite, PixelTileset } from '@aidraw/core';
import { X } from 'lucide-react';
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

function TransformSwatch({ palette, sprite, tileset, tileId, choice, active, disabled, onSelect }: {
  palette: PixelDocument['palette'];
  sprite?: PixelSprite;
  tileset: PixelTileset;
  tileId: number;
  choice: TileTransformChoice;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
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
    if (!sprite || !frameId || tileId < 0 || tileId >= tileset.columns * tileset.rows) return;
    const geometry = tileTransformPreviewGeometry(tileset.tileWidth, tileset.tileHeight, choice.flags, TILE_TRANSFORM_PREVIEW_SIDE);
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
      tilesetTileSourceRect(tileset, tileId),
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
  return <button
    type="button"
    className={active ? 'is-active' : ''}
    disabled={disabled}
    aria-pressed={active}
    aria-label={`Use ${choice.label.toLocaleLowerCase()} tile transform`}
    title={disabled ? `${choice.label} is disabled by this tileset.` : `${choice.label} · Tiled diagonal-first flags`}
    onClick={onSelect}
  >
    <span><canvas ref={canvasRef} /></span>
    <strong>{choice.shortLabel}</strong>
    <small>{choice.label}</small>
  </button>;
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
  return <section id="tile-transform-picker" className="tile-transform-picker" aria-label="Tile transform preview">
    <header>
      <span><strong>Tile transform</strong><small>Tile {tileId} · {tileset.tileWidth} × {tileset.tileHeight}px</small></span>
      <span><strong>Tiled flags</strong><small>Diagonal first, then H/V</small></span>
      <button type="button" className="tile-transform-close" aria-label="Close tile transform preview" onClick={onClose}><X size={13} /></button>
    </header>
    <div className="tile-transform-grid">
      {TILE_TRANSFORM_CHOICES.map((choice) => <TransformSwatch
        key={choice.id}
        palette={document.palette}
        sprite={sprite}
        tileset={tileset}
        tileId={tileId}
        choice={choice}
        active={choice.id === activeId}
        disabled={!tileTransformChoiceAllowed(choice, tileset.transformations)}
        onSelect={() => onChange({ ...choice.flags })}
      />)}
    </div>
    <footer><span>Preview aspect-fits the complete transformed footprint inside {TILE_TRANSFORM_PREVIEW_SIDE} × {TILE_TRANSFORM_PREVIEW_SIDE}px and never materializes the complete source sprite.</span></footer>
  </section>;
}

import { useEffect, useRef } from 'react';
import type { PixelDocument, PixelTileset, TileDefinition } from '@aidraw/core';

import { resolveTilesetTileSource } from '../../common/tile-animation';
import { drawSpriteRegionThumbnail } from '../canvas/pixel-bitmap';

const MAX_VISIBLE_VARIANTS = 12;
const MAX_VARIANT_THUMBNAIL_SIDE = 32;

function VariantSwatch({ document, tileset, tile, selected, onSelect }: {
  document: PixelDocument;
  tileset: PixelTileset;
  tile: TileDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let source;
    try { source = resolveTilesetTileSource(document, tileset, tile.id); }
    catch { source = undefined; }
    const width = source?.rect.width ?? tileset.tileWidth;
    const height = source?.rect.height ?? tileset.tileHeight;
    const scale = Math.min(1, MAX_VARIANT_THUMBNAIL_SIDE / width, MAX_VARIANT_THUMBNAIL_SIDE / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!source) return;
    drawSpriteRegionThumbnail(context, source.sprite, source.sprite.frameIds[0], document.palette, source.rect, canvas.width, canvas.height);
  }, [document, tile.id, tileset]);
  return <button type="button" className={selected ? 'is-active' : ''} onClick={onSelect} title={`Tile ${tile.id} · weight ${tile.probability}`} aria-label={`Select variant tile ${tile.id}, weight ${tile.probability}`}>
    <span><canvas ref={canvasRef} /></span><small>{tile.id} · {tile.probability}</small>
  </button>;
}

export function TileVariantPreview({ document, tileset, selectedTileId, group, candidates, onSelect }: {
  document: PixelDocument;
  tileset: PixelTileset;
  selectedTileId: number;
  group?: string;
  candidates: TileDefinition[];
  onSelect: (tileId: number) => void;
}) {
  if (!group || candidates.length < 2) return null;
  const visible = candidates.slice(0, MAX_VISIBLE_VARIANTS);
  return <div className="tile-variant-preview">
    <div className="section-heading"><span>“{group}” variants</span><small>{candidates.length} weighted tiles</small></div>
    <div className="tile-variant-strip">{visible.map((tile) => <VariantSwatch key={tile.id} document={document} tileset={tileset} tile={tile} selected={tile.id === selectedTileId} onSelect={() => onSelect(tile.id)} />)}</div>
    {candidates.length > visible.length && <small className="tile-variant-overflow">Showing the first {visible.length} of {candidates.length} variants.</small>}
  </div>;
}

import { useEffect, useRef } from 'react';
import type { PixelDocument, PixelTileset, TileDefinition } from '@aidraw/core';
import { Check } from 'lucide-react';

import { resolveTilesetTileSource } from '../../common/tile-animation';
import { drawSpriteRegionThumbnail } from '../canvas/pixel-bitmap';

const MAX_VISIBLE_VARIANTS = 12;
const MAX_VARIANT_THUMBNAIL_SIDE = 32;

function VariantThumbnail({ document, tileset, tile }: {
  document: PixelDocument;
  tileset: PixelTileset;
  tile: TileDefinition;
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
  return <span className="tile-variant-thumbnail" aria-hidden="true"><canvas ref={canvasRef} /></span>;
}

export function TileVariantSwatch({ document, tileset, tile, selected, onSelect }: {
  document: PixelDocument;
  tileset: PixelTileset;
  tile: TileDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  const selectionLabel = selected ? 'selected' : 'not selected';
  return <button type="button" className={selected ? 'is-active' : ''} onClick={onSelect} title={`Tile ${tile.id} · authored weight ${tile.probability} · ${selectionLabel}`} aria-label={`Variant tile ID ${tile.id}, authored weight ${tile.probability}, ${selectionLabel}`} aria-pressed={selected}>
    <VariantThumbnail document={document} tileset={tileset} tile={tile} />
    <span className="tile-variant-copy" aria-hidden="true">
      <strong>Tile ID {tile.id}</strong>
      <small>Weight {tile.probability}</small>
    </span>
    {selected && <span className="tile-variant-selection-state" aria-hidden="true"><Check /></span>}
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
  return <div className="tile-variant-preview" role="group" aria-label={`Weighted tile variants for group ${group}`}>
    <dl className="tile-variant-summary">
      <div><dt>Variant group</dt><dd>“{group}”</dd></div>
      <div><dt>Candidate count</dt><dd>{candidates.length} weighted tiles</dd></div>
    </dl>
    <div className="tile-variant-strip" role="group" aria-label={`Variant candidates for group ${group}`}>{visible.map((tile) => <TileVariantSwatch key={tile.id} document={document} tileset={tileset} tile={tile} selected={tile.id === selectedTileId} onSelect={() => onSelect(tile.id)} />)}</div>
    {candidates.length > visible.length && <small className="tile-variant-overflow">Showing the first {visible.length} of {candidates.length} variants.</small>}
  </div>;
}

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pause, Play, Trash2 } from 'lucide-react';
import type { PixelDocument, PixelTileset, TileDefinition } from '@aidraw/core';

import { moveTileAnimationFrame, resolveTilesetTileSource, type TileAnimationFrame } from '../../common/tile-animation';
import { drawSpriteRegionThumbnail } from '../canvas/pixel-bitmap';

interface TileAnimationEditorProps {
  document: PixelDocument;
  tileset: PixelTileset;
  tile: TileDefinition;
  tileCount: number;
  availableTileIds?: number[];
  onChange: (animation: TileAnimationFrame[], label: string) => void;
}

function integerInRange(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function TileAnimationPreview({ document, tileset, tile }: Pick<TileAnimationEditorProps, 'document' | 'tileset' | 'tile'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frames = tile.animation.length ? tile.animation : [{ tileId: tile.id, durationMs: 100 }];
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(() => tile.animation.length > 1 && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const activeIndex = Math.min(frameIndex, frames.length - 1);
  const frame = frames[activeIndex];
  const source = useMemo(() => {
    try { return resolveTilesetTileSource(document, tileset, frame.tileId); }
    catch { return undefined; }
  }, [document, frame.tileId, tileset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = source?.rect.width ?? tileset.tileWidth;
    const height = source?.rect.height ?? tileset.tileHeight;
    const scale = Math.min(1, 40 / width, 40 / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!source) return;
    drawSpriteRegionThumbnail(context, source.sprite, source.sprite.frameIds[0], document.palette, source.rect, canvas.width, canvas.height);
  }, [document.palette, source, tileset.tileHeight, tileset.tileWidth]);

  useEffect(() => {
    if (!playing || tile.animation.length < 2) return undefined;
    const timeout = window.setTimeout(() => setFrameIndex((index) => (index + 1) % tile.animation.length), Math.min(frame.durationMs, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [frame.durationMs, playing, tile.animation.length]);

  return (
    <div className="tile-animation-preview">
      <div className="tile-animation-preview-stage">
        <canvas ref={canvasRef} role="img" aria-label={`Tile animation preview, frame ${activeIndex + 1}, tile ${frame.tileId}`} />
      </div>
      <div className="tile-animation-preview-copy">
        <strong>{tile.animation.length ? `Frame ${activeIndex + 1} of ${tile.animation.length}` : 'Static tile'}</strong>
        <small>{source ? `Tile ${frame.tileId} · ${source.rect.width} × ${source.rect.height}px${tile.animation.length ? ` · ${frame.durationMs} ms` : ''}` : 'Source sprite unavailable'}</small>
      </div>
      {tile.animation.length > 1 && <button type="button" title={playing ? 'Pause animation preview' : 'Play animation preview'} aria-label={playing ? 'Pause animation preview' : 'Play animation preview'} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={11} /> : <Play size={11} />}</button>}
    </div>
  );
}

export function TileAnimationEditor({ document, tileset, tile, tileCount, availableTileIds, onChange }: TileAnimationEditorProps) {
  const [draggedFrameIndex, setDraggedFrameIndex] = useState<number>();
  const [dropFrameIndex, setDropFrameIndex] = useState<number>();
  const moveFrame = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    onChange(moveTileAnimationFrame(tile.animation, fromIndex, toIndex), 'Reorder animated tile frames');
  };
  const endDrag = () => { setDraggedFrameIndex(undefined); setDropFrameIndex(undefined); };
  const dropFrame = (event: DragEvent<HTMLDivElement>, toIndex: number) => {
    event.preventDefault();
    const transferValue = event.dataTransfer.getData('text/plain');
    const transferIndex = transferValue.trim() ? Number(transferValue) : Number.NaN;
    const fromIndex = draggedFrameIndex ?? (Number.isInteger(transferIndex) ? transferIndex : undefined);
    if (fromIndex !== undefined && fromIndex >= 0 && fromIndex < tile.animation.length) moveFrame(fromIndex, toIndex);
    endDrag();
  };
  return (
    <>
      <div className="section-heading"><span>Animation</span><button type="button" onClick={() => onChange([...tile.animation, { tileId: tile.id, durationMs: 100 }], 'Add animated tile frame')}>+ Frame</button></div>
      <TileAnimationPreview key={tile.id} document={document} tileset={tileset} tile={tile} />
      {tile.animation.map((frame, frameIndex) => (
        <div className={`tile-animation-row${dropFrameIndex === frameIndex ? ' is-drop-target' : ''}`} key={`${frame.tileId}-${frame.durationMs}-${frameIndex}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropFrameIndex(frameIndex); }} onDragLeave={() => setDropFrameIndex((index) => index === frameIndex ? undefined : index)} onDrop={(event) => dropFrame(event, frameIndex)}>
          <button type="button" className="tile-animation-drag-handle" draggable aria-label={`Drag animation frame ${frameIndex + 1}`} title="Drag to reorder animation frame" onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(frameIndex)); setDraggedFrameIndex(frameIndex); }} onDragEnd={endDrag}><GripVertical size={11} /></button>
          {availableTileIds ? <select aria-label={`Animation tile ${frameIndex + 1}`} title="Existing collection tile ID" value={frame.tileId} onChange={(event) => onChange(tile.animation.map((entry, index) => index === frameIndex ? { ...entry, tileId: Number(event.target.value) } : entry), 'Edit animated tile frame')}>{availableTileIds.map((tileId) => <option key={tileId} value={tileId}>{tileId}</option>)}</select> : <input aria-label={`Animation tile ${frameIndex + 1}`} title="Tile ID" type="number" min="0" max={tileCount - 1} value={frame.tileId} onChange={(event) => onChange(tile.animation.map((entry, index) => index === frameIndex ? { ...entry, tileId: integerInRange(event.target.value, 0, tileCount - 1, entry.tileId) } : entry), 'Edit animated tile frame')} />}
          <input aria-label={`Animation duration ${frameIndex + 1}`} title="Duration (ms)" type="number" min="1" max="60000" value={frame.durationMs} onChange={(event) => onChange(tile.animation.map((entry, index) => index === frameIndex ? { ...entry, durationMs: integerInRange(event.target.value, 1, 60_000, entry.durationMs) } : entry), 'Edit animated tile timing')} />
          <div className="tile-animation-move-actions">
            <button type="button" title="Move animation frame up" aria-label={`Move animation frame ${frameIndex + 1} up`} disabled={frameIndex === 0} onClick={() => moveFrame(frameIndex, frameIndex - 1)}><ArrowUp size={10} /></button>
            <button type="button" title="Move animation frame down" aria-label={`Move animation frame ${frameIndex + 1} down`} disabled={frameIndex === tile.animation.length - 1} onClick={() => moveFrame(frameIndex, frameIndex + 1)}><ArrowDown size={10} /></button>
          </div>
          <button type="button" title="Delete animation frame" aria-label={`Delete animation frame ${frameIndex + 1}`} onClick={() => onChange(tile.animation.filter((_, index) => index !== frameIndex), 'Delete animated tile frame')}><Trash2 size={11} /></button>
        </div>
      ))}
    </>
  );
}

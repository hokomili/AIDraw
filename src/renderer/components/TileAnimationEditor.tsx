import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pause, Play, Plus, Trash2 } from 'lucide-react';
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
      {tile.animation.length > 1 && <button type="button" title={playing ? 'Pause animation preview' : 'Play animation preview'} aria-label={playing ? 'Pause animation preview' : 'Play animation preview'} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}<span>{playing ? 'Pause preview' : 'Play preview'}</span></button>}
    </div>
  );
}

interface TileAnimationFrameManagerProps {
  tileId: number;
  animation: TileAnimationFrame[];
  tileCount: number;
  availableTileIds?: number[];
  preview: ReactNode;
  draggedFrameIndex?: number;
  dropFrameIndex?: number;
  onDraggedFrameIndexChange: (index: number | undefined) => void;
  onDropFrameIndexChange: (index: number | undefined) => void;
  onChange: TileAnimationEditorProps['onChange'];
}

export function TileAnimationFrameManager({
  tileId,
  animation,
  tileCount,
  availableTileIds,
  preview,
  draggedFrameIndex,
  dropFrameIndex,
  onDraggedFrameIndexChange,
  onDropFrameIndexChange,
  onChange,
}: TileAnimationFrameManagerProps) {
  const moveFrame = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    onChange(moveTileAnimationFrame(animation, fromIndex, toIndex), 'Reorder animated tile frames');
  };
  const endDrag = () => {
    onDraggedFrameIndexChange(undefined);
    onDropFrameIndexChange(undefined);
  };
  const dropFrame = (event: DragEvent<HTMLElement>, toIndex: number) => {
    event.preventDefault();
    const transferValue = event.dataTransfer.getData('text/plain');
    const transferIndex = transferValue.trim() ? Number(transferValue) : Number.NaN;
    const fromIndex = draggedFrameIndex ?? (Number.isInteger(transferIndex) ? transferIndex : undefined);
    if (fromIndex !== undefined && fromIndex >= 0 && fromIndex < animation.length) moveFrame(fromIndex, toIndex);
    endDrag();
  };

  return (
    <div className="tile-animation-editor">
      <div className="section-heading tile-animation-heading">
        <span>Animation</span>
        <button type="button" className="tile-animation-add" aria-label={`Add animation frame for tile ${tileId}`} onClick={() => onChange([...animation, { tileId, durationMs: 100 }], 'Add animated tile frame')}><Plus aria-hidden="true" /><span>Add frame</span></button>
      </div>
      {preview}
      <div className="tile-animation-frame-list" role="list" aria-label={`Animation frames for tile ${tileId}`}>
        {animation.map((frame, frameIndex) => (
          <article
            className={`tile-animation-frame-card${dropFrameIndex === frameIndex ? ' is-drop-target' : ''}`}
            key={`${frame.tileId}-${frame.durationMs}-${frameIndex}`}
            role="listitem"
            aria-label={`Animation frame ${frameIndex + 1}, tile ${frame.tileId}, ${frame.durationMs} milliseconds`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              onDropFrameIndexChange(frameIndex);
            }}
            onDragLeave={() => onDropFrameIndexChange(dropFrameIndex === frameIndex ? undefined : dropFrameIndex)}
            onDrop={(event) => dropFrame(event, frameIndex)}
          >
            <header className="tile-animation-frame-header">
              <span className="tile-animation-frame-identity"><strong>Frame {frameIndex + 1}</strong><small>Tile ID {frame.tileId} · {frame.durationMs} ms</small></span>
              <button type="button" className="tile-animation-drag-handle" draggable aria-label={`Drag animation frame ${frameIndex + 1}`} title={`Drag animation frame ${frameIndex + 1} to reorder`} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(frameIndex)); onDraggedFrameIndexChange(frameIndex); }} onDragEnd={endDrag}><GripVertical aria-hidden="true" /><span>Drag frame</span></button>
            </header>
            <div className="tile-animation-frame-fields">
              <label className="tile-animation-field">
                <span>Tile ID</span>
                {availableTileIds
                  ? <select aria-label={`Animation frame ${frameIndex + 1} tile ID`} title="Existing collection tile ID" value={frame.tileId} onChange={(event) => onChange(animation.map((entry, index) => index === frameIndex ? { ...entry, tileId: Number(event.currentTarget.value) } : entry), 'Edit animated tile frame')}>{availableTileIds.map((availableTileId) => <option key={availableTileId} value={availableTileId}>{availableTileId}</option>)}</select>
                  : <input aria-label={`Animation frame ${frameIndex + 1} tile ID`} title="Tile ID" type="number" min="0" max={tileCount - 1} value={frame.tileId} onChange={(event) => onChange(animation.map((entry, index) => index === frameIndex ? { ...entry, tileId: integerInRange(event.currentTarget.value, 0, tileCount - 1, entry.tileId) } : entry), 'Edit animated tile frame')} />}
              </label>
              <label className="tile-animation-field">
                <span>Duration (ms)</span>
                <input aria-label={`Animation frame ${frameIndex + 1} duration in milliseconds`} title="Duration (ms)" type="number" min="1" max="60000" value={frame.durationMs} onChange={(event) => onChange(animation.map((entry, index) => index === frameIndex ? { ...entry, durationMs: integerInRange(event.currentTarget.value, 1, 60_000, entry.durationMs) } : entry), 'Edit animated tile timing')} />
              </label>
            </div>
            <div className="tile-animation-frame-actions" role="group" aria-label={`Animation frame ${frameIndex + 1} actions`}>
              <button type="button" aria-label={`Move animation frame ${frameIndex + 1} up`} disabled={frameIndex === 0} onClick={() => moveFrame(frameIndex, frameIndex - 1)}><ArrowUp aria-hidden="true" /><span>Move up</span></button>
              <button type="button" aria-label={`Move animation frame ${frameIndex + 1} down`} disabled={frameIndex === animation.length - 1} onClick={() => moveFrame(frameIndex, frameIndex + 1)}><ArrowDown aria-hidden="true" /><span>Move down</span></button>
              <button type="button" className="tile-animation-delete" aria-label={`Delete animation frame ${frameIndex + 1}, tile ${frame.tileId}`} onClick={() => onChange(animation.filter((_, index) => index !== frameIndex), 'Delete animated tile frame')}><Trash2 aria-hidden="true" /><span>Delete frame</span></button>
            </div>
          </article>
        ))}
        {animation.length === 0 && <p className="tile-animation-empty" role="status">No animation frames. This tile remains static until a frame is added.</p>}
      </div>
    </div>
  );
}

export function TileAnimationEditor({ document, tileset, tile, tileCount, availableTileIds, onChange }: TileAnimationEditorProps) {
  const [draggedFrameIndex, setDraggedFrameIndex] = useState<number>();
  const [dropFrameIndex, setDropFrameIndex] = useState<number>();
  return (
    <TileAnimationFrameManager
      tileId={tile.id}
      animation={tile.animation}
      tileCount={tileCount}
      availableTileIds={availableTileIds}
      preview={<TileAnimationPreview key={tile.id} document={document} tileset={tileset} tile={tile} />}
      draggedFrameIndex={draggedFrameIndex}
      dropFrameIndex={dropFrameIndex}
      onDraggedFrameIndexChange={setDraggedFrameIndex}
      onDropFrameIndexChange={setDropFrameIndex}
      onChange={onChange}
    />
  );
}

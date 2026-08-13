import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PixelDocument, PixelSprite, PixelTileset } from '@aidraw/core';

import {
  planTilesetReslice,
  type TilesetMetadataRemap,
  type TilesetResliceImpact,
  type TilesetSliceLayout,
} from '../../common/tileset-reslice';
import { drawSpriteThumbnail } from '../canvas/pixel-bitmap';

interface TilesetSliceEditorProps {
  palette: PixelDocument['palette'];
  tileset: PixelTileset;
  sourceSprite?: PixelSprite;
  selectedTileId: number;
  onCommit: (tileset: PixelTileset, selectedTileId: number, impact: TilesetResliceImpact) => void;
}

interface SliceDraft {
  tileWidth: string;
  tileHeight: string;
  margin: string;
  spacing: string;
}

function draftFor(tileset: PixelTileset): SliceDraft {
  return {
    tileWidth: String(tileset.tileWidth),
    tileHeight: String(tileset.tileHeight),
    margin: String(tileset.margin),
    spacing: String(tileset.spacing),
  };
}

function parsedLayout(draft: SliceDraft): TilesetSliceLayout {
  return {
    tileWidth: Number(draft.tileWidth),
    tileHeight: Number(draft.tileHeight),
    margin: Number(draft.margin),
    spacing: Number(draft.spacing),
  };
}

function totalLoss(impact: TilesetResliceImpact): number {
  return impact.droppedMetadataTiles + impact.droppedAnimationFrames + impact.droppedCollisionShapes + impact.droppedCustomProperties + impact.droppedWangColors + impact.droppedWangTiles;
}

export function TilesetSliceEditor({ palette, tileset, sourceSprite, selectedTileId, onCommit }: TilesetSliceEditorProps) {
  const [draft, setDraft] = useState<SliceDraft>(() => draftFor(tileset));
  const [remap, setRemap] = useState<TilesetMetadataRemap>('source-position');
  const [acknowledged, setAcknowledged] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const patternId = useId().replaceAll(':', '');

  const previewSize = useMemo(() => {
    if (!sourceSprite) return undefined;
    const scale = Math.min(1, 384 / sourceSprite.width, 220 / sourceSprite.height);
    return { width: Math.max(1, Math.round(sourceSprite.width * scale)), height: Math.max(1, Math.round(sourceSprite.height * scale)) };
  }, [sourceSprite]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sourceSprite || !previewSize) return;
    canvas.width = previewSize.width;
    canvas.height = previewSize.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawSpriteThumbnail(context, sourceSprite, sourceSprite.frameIds[0], palette, previewSize.width, previewSize.height);
  }, [palette, previewSize, sourceSprite]);

  const planned = useMemo(() => {
    if (!sourceSprite) return { error: 'The source sprite is missing, so this tileset cannot be re-sliced safely.' } as const;
    try {
      return { plan: planTilesetReslice(tileset, { width: sourceSprite.width, height: sourceSprite.height }, parsedLayout(draft), remap) } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The requested slice is invalid.' } as const;
    }
  }, [draft, remap, sourceSprite, tileset]);
  const plan = 'plan' in planned ? planned.plan : undefined;
  const layoutChanged = Boolean(plan && (plan.tileset.tileWidth !== tileset.tileWidth || plan.tileset.tileHeight !== tileset.tileHeight || plan.tileset.margin !== tileset.margin || plan.tileset.spacing !== tileset.spacing || plan.tileset.columns !== tileset.columns || plan.tileset.rows !== tileset.rows));
  const requiresAcknowledgement = Boolean(plan && (plan.impact.reframedMetadataTiles > 0 || plan.impact.remappedMetadataTileIds > 0 || totalLoss(plan.impact) > 0));

  const selectedTile = tileset.tiles[selectedTileId] ?? {
    sourceX: tileset.margin + selectedTileId % tileset.columns * (tileset.tileWidth + tileset.spacing),
    sourceY: tileset.margin + Math.floor(selectedTileId / tileset.columns) * (tileset.tileHeight + tileset.spacing),
  };
  const draftTileset = plan?.tileset ?? tileset;
  const currentGridWidth = tileset.columns * (tileset.tileWidth + tileset.spacing) - tileset.spacing;
  const currentGridHeight = tileset.rows * (tileset.tileHeight + tileset.spacing) - tileset.spacing;
  const draftGridWidth = draftTileset.columns * (draftTileset.tileWidth + draftTileset.spacing) - draftTileset.spacing;
  const draftGridHeight = draftTileset.rows * (draftTileset.tileHeight + draftTileset.spacing) - draftTileset.spacing;
  const setField = (field: keyof SliceDraft, value: string) => { setDraft((current) => ({ ...current, [field]: value })); setAcknowledged(false); };
  const apply = () => {
    if (!plan || !layoutChanged || (requiresAcknowledgement && !acknowledged)) return;
    const nextSelected = plan.mapTileId(selectedTileId) ?? Math.min(selectedTileId, plan.tileset.columns * plan.tileset.rows - 1);
    onCommit(plan.tileset, nextSelected, plan.impact);
  };

  return <div className="tileset-slice-editor">
    <div className="section-heading"><span>Source-sheet slicing</span><small>Preview before apply</small></div>
    {sourceSprite && previewSize && <div className="tileset-sheet-preview" role="img" aria-label={`Source sprite with current and draft ${tileset.name} crop grids`} style={{ aspectRatio: `${sourceSprite.width} / ${sourceSprite.height}` }}>
      <canvas ref={canvasRef} />
      <svg viewBox={`0 0 ${sourceSprite.width} ${sourceSprite.height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern id={`${patternId}-current`} x={tileset.margin} y={tileset.margin} width={tileset.tileWidth + tileset.spacing} height={tileset.tileHeight + tileset.spacing} patternUnits="userSpaceOnUse"><rect width={tileset.tileWidth} height={tileset.tileHeight} className="current-slice-cell" /></pattern>
          <pattern id={`${patternId}-draft`} x={draftTileset.margin} y={draftTileset.margin} width={draftTileset.tileWidth + draftTileset.spacing} height={draftTileset.tileHeight + draftTileset.spacing} patternUnits="userSpaceOnUse"><rect width={draftTileset.tileWidth} height={draftTileset.tileHeight} className="draft-slice-cell" /></pattern>
        </defs>
        <rect x={tileset.margin} y={tileset.margin} width={currentGridWidth} height={currentGridHeight} fill={`url(#${patternId}-current)`} />
        {plan && <rect x={draftTileset.margin} y={draftTileset.margin} width={draftGridWidth} height={draftGridHeight} fill={`url(#${patternId}-draft)`} />}
        {selectedTile && <rect x={selectedTile.sourceX} y={selectedTile.sourceY} width={tileset.tileWidth} height={tileset.tileHeight} className="selected-slice-cell" />}
      </svg>
      <span className="slice-legend"><i className="current" />Current <i className="draft" />Draft <i className="selected" />Selected</span>
    </div>}
    <div className="tileset-slice-grid">
      <label className="field"><span>Tile width</span><input type="number" min="1" step="1" value={draft.tileWidth} onChange={(event) => setField('tileWidth', event.target.value)} /></label>
      <label className="field"><span>Tile height</span><input type="number" min="1" step="1" value={draft.tileHeight} onChange={(event) => setField('tileHeight', event.target.value)} /></label>
      <label className="field"><span>Margin</span><input type="number" min="0" step="1" value={draft.margin} onChange={(event) => setField('margin', event.target.value)} /></label>
      <label className="field"><span>Spacing</span><input type="number" min="0" step="1" value={draft.spacing} onChange={(event) => setField('spacing', event.target.value)} /></label>
    </div>
    <fieldset className="tileset-remap-options">
      <legend>Metadata remap</legend>
      <label><input type="radio" name={`${patternId}-remap`} checked={remap === 'source-position'} onChange={() => { setRemap('source-position'); setAcknowledged(false); }} /><span><strong>Follow source positions</strong><small>Keep metadata on cells whose top-left source pixel still exists.</small></span></label>
      <label><input type="radio" name={`${patternId}-remap`} checked={remap === 'tile-id'} onChange={() => { setRemap('tile-id'); setAcknowledged(false); }} /><span><strong>Keep tile IDs</strong><small>Keep metadata on the same numbered tiles when those IDs still exist.</small></span></label>
    </fieldset>
    {'error' in planned ? <p className="tileset-reslice-error" role="alert">{planned.error}</p> : <div className={`tileset-reslice-impact ${totalLoss(planned.plan.impact) > 0 ? 'has-loss' : ''}`}>
      <strong>{planned.plan.tileset.columns} × {planned.plan.tileset.rows} · {planned.plan.tileset.columns * planned.plan.tileset.rows} tiles</strong>
      <span>{planned.plan.impact.preservedMetadataTiles} of {planned.plan.impact.metadataTiles} metadata-addressed tiles preserved · {planned.plan.impact.reframedMetadataTiles} reframed · {planned.plan.impact.remappedMetadataTileIds} renumbered</span>
      <span>Drops: {planned.plan.impact.droppedMetadataTiles} tiles · {planned.plan.impact.droppedAnimationFrames} animation frames · {planned.plan.impact.droppedCollisionShapes} collisions · {planned.plan.impact.droppedCustomProperties} properties · {planned.plan.impact.droppedWangColors} Wang colors · {planned.plan.impact.droppedWangTiles} Wang assignments</span>
    </div>}
    {requiresAcknowledgement && <label className="tileset-reslice-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I reviewed how this re-slice moves or drops metadata.</span></label>}
    <div className="tileset-reslice-actions"><button type="button" disabled={!layoutChanged} onClick={() => { setDraft(draftFor(tileset)); setAcknowledged(false); }}>Reset</button><button type="button" className="primary" disabled={!plan || !layoutChanged || (requiresAcknowledgement && !acknowledged)} onClick={apply}>Apply re-slice</button></div>
  </div>;
}

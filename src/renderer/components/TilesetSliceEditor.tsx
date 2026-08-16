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

export type TilesetSliceReviewResult =
  | { kind: 'error'; message: string }
  | { kind: 'plan'; columns: number; rows: number; impact: TilesetResliceImpact };

export interface TilesetSliceReviewProps {
  result: TilesetSliceReviewResult;
  remap: TilesetMetadataRemap;
  layoutChanged: boolean;
  requiresAcknowledgement: boolean;
  acknowledged: boolean;
  onRemapChange: (remap: TilesetMetadataRemap) => void;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  onReset: () => void;
  onApply: () => void;
  radioName: string;
}

export function TilesetSliceLegend({ id }: { id: string }) {
  return <ul className="slice-legend" id={id} aria-label="Slice preview overlay legend">
    <li><i className="current" aria-hidden="true" /><span><strong>Current grid</strong><small>Existing slice geometry</small></span></li>
    <li><i className="draft" aria-hidden="true" /><span><strong>Draft grid</strong><small>Proposed slice geometry</small></span></li>
    <li><i className="selected" aria-hidden="true" /><span><strong>Selected tile</strong><small>Current source rectangle</small></span></li>
  </ul>;
}

export function TilesetSliceReview({
  result,
  remap,
  layoutChanged,
  requiresAcknowledgement,
  acknowledged,
  onRemapChange,
  onAcknowledgedChange,
  onReset,
  onApply,
  radioName,
}: TilesetSliceReviewProps) {
  const plan = result.kind === 'plan' ? result : undefined;
  const applyDisabled = !plan || !layoutChanged || (requiresAcknowledgement && !acknowledged);
  return <>
    <fieldset className="tileset-remap-options">
      <legend>Metadata remap</legend>
      <label><input type="radio" name={radioName} checked={remap === 'source-position'} onChange={() => onRemapChange('source-position')} /><span><strong>Follow source positions</strong><small>Keep metadata on cells whose top-left source pixel still exists.</small></span></label>
      <label><input type="radio" name={radioName} checked={remap === 'tile-id'} onChange={() => onRemapChange('tile-id')} /><span><strong>Keep tile IDs</strong><small>Keep metadata on the same numbered tiles when those IDs still exist.</small></span></label>
    </fieldset>
    {result.kind === 'error'
      ? <p className="tileset-reslice-error" role="alert"><strong>Re-slice unavailable</strong><span>{result.message}</span></p>
      : <section className={`tileset-reslice-impact ${totalLoss(result.impact) > 0 ? 'has-loss' : ''}`} aria-label="Re-slice impact" role="status">
        <strong>Planned sheet: {result.columns} × {result.rows} · {result.columns * result.rows} tiles</strong>
        <dl>
          <div><dt>Metadata tiles</dt><dd>{result.impact.preservedMetadataTiles} of {result.impact.metadataTiles} preserved</dd></div>
          <div><dt>Moved metadata</dt><dd>{result.impact.reframedMetadataTiles} reframed · {result.impact.remappedMetadataTileIds} renumbered</dd></div>
          <div><dt>Dropped metadata</dt><dd>{result.impact.droppedMetadataTiles} tiles · {result.impact.droppedAnimationFrames} animation frames · {result.impact.droppedCollisionShapes} collisions · {result.impact.droppedCustomProperties} properties · {result.impact.droppedWangColors} Wang colors · {result.impact.droppedWangTiles} Wang assignments</dd></div>
        </dl>
      </section>}
    {requiresAcknowledgement && <label className="tileset-reslice-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledgedChange(event.target.checked)} /><span><strong>Review required</strong><small>I reviewed how this re-slice moves or drops metadata.</small></span></label>}
    <div className="tileset-reslice-actions"><button type="button" disabled={!layoutChanged} onClick={onReset}>Reset</button><button type="button" className="primary" disabled={applyDisabled} onClick={onApply}>Apply re-slice</button></div>
  </>;
}

export function TilesetSliceEditor({ palette, tileset, sourceSprite, selectedTileId, onCommit }: TilesetSliceEditorProps) {
  const [draft, setDraft] = useState<SliceDraft>(() => draftFor(tileset));
  const [remap, setRemap] = useState<TilesetMetadataRemap>('source-position');
  const [acknowledged, setAcknowledged] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const patternId = useId().replaceAll(':', '');
  const legendId = `${patternId}-legend`;

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
    {sourceSprite && previewSize && <>
      <div className="tileset-sheet-preview" role="img" aria-label={`Source sprite with current and draft ${tileset.name} crop grids`} aria-describedby={legendId} style={{ aspectRatio: `${sourceSprite.width} / ${sourceSprite.height}` }}>
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
      </div>
      <TilesetSliceLegend id={legendId} />
    </>}
    <div className="tileset-slice-grid">
      <label className="field"><span>Tile width</span><input type="number" min="1" step="1" value={draft.tileWidth} onChange={(event) => setField('tileWidth', event.target.value)} /></label>
      <label className="field"><span>Tile height</span><input type="number" min="1" step="1" value={draft.tileHeight} onChange={(event) => setField('tileHeight', event.target.value)} /></label>
      <label className="field"><span>Margin</span><input type="number" min="0" step="1" value={draft.margin} onChange={(event) => setField('margin', event.target.value)} /></label>
      <label className="field"><span>Spacing</span><input type="number" min="0" step="1" value={draft.spacing} onChange={(event) => setField('spacing', event.target.value)} /></label>
    </div>
    <TilesetSliceReview
      result={'error' in planned
        ? { kind: 'error', message: planned.error ?? 'The requested slice is invalid.' }
        : { kind: 'plan', columns: planned.plan.tileset.columns, rows: planned.plan.tileset.rows, impact: planned.plan.impact }}
      remap={remap}
      layoutChanged={layoutChanged}
      requiresAcknowledgement={requiresAcknowledgement}
      acknowledged={acknowledged}
      onRemapChange={(nextRemap) => { setRemap(nextRemap); setAcknowledged(false); }}
      onAcknowledgedChange={setAcknowledged}
      onReset={() => { setDraft(draftFor(tileset)); setAcknowledged(false); }}
      onApply={apply}
      radioName={`${patternId}-remap`}
    />
  </div>;
}

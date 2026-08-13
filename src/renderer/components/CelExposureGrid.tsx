import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Link2, Unlink2, X } from 'lucide-react';
import { pixelRawCelForFrame, type PixelSprite } from '@aidraw/core';
import { flattenLayerTree } from '../../common/layer-tree';

const MAX_VISIBLE_EXPOSURE_FRAMES = 12;
const MAX_VISIBLE_EXPOSURE_LAYERS = 6;

interface CelExposureGridProps {
  sprite: PixelSprite;
  activeFrameId: string;
  activeLayerId?: string;
  onSelect(frameId: string, layerId: string): void;
  onToggleLink(layerId: string, frameId: string): void;
  onClose(): void;
}

export function CelExposureGrid({ sprite, activeFrameId, activeLayerId, onSelect, onToggleLink, onClose }: CelExposureGridProps) {
  const layers = useMemo(() => flattenLayerTree(sprite.layers, sprite.layerIds).map(({ entry }) => entry).filter((layer) => layer.type === 'pixel'), [sprite.layerIds, sprite.layers]);
  const resolvedLayerId = layers.some((layer) => layer.id === activeLayerId) ? activeLayerId! : layers[0]?.id;
  const activeFrameIndex = Math.max(0, sprite.frameIds.indexOf(activeFrameId));
  const activeLayerIndex = Math.max(0, layers.findIndex((layer) => layer.id === resolvedLayerId));
  const [framePage, setFramePage] = useState(() => Math.floor(activeFrameIndex / MAX_VISIBLE_EXPOSURE_FRAMES));
  const [layerPage, setLayerPage] = useState(() => Math.floor(activeLayerIndex / MAX_VISIBLE_EXPOSURE_LAYERS));
  const framePageCount = Math.max(1, Math.ceil(sprite.frameIds.length / MAX_VISIBLE_EXPOSURE_FRAMES));
  const layerPageCount = Math.max(1, Math.ceil(layers.length / MAX_VISIBLE_EXPOSURE_LAYERS));
  const boundedFramePage = Math.min(framePage, framePageCount - 1);
  const boundedLayerPage = Math.min(layerPage, layerPageCount - 1);
  const frameStart = boundedFramePage * MAX_VISIBLE_EXPOSURE_FRAMES;
  const layerStart = boundedLayerPage * MAX_VISIBLE_EXPOSURE_LAYERS;
  const frames = sprite.frameIds.slice(frameStart, frameStart + MAX_VISIBLE_EXPOSURE_FRAMES);
  const shownLayers = layers.slice(layerStart, layerStart + MAX_VISIBLE_EXPOSURE_LAYERS);
  const gridStyle = { gridTemplateColumns: `112px repeat(${Math.max(1, frames.length)}, 38px)` } as CSSProperties;
  const activeLayer = layers.find((layer) => layer.id === resolvedLayerId);
  const activeRawCel = activeLayer ? pixelRawCelForFrame(sprite, activeLayer.id, activeFrameId) : undefined;
  const activeCanLink = Boolean(activeLayer && activeRawCel && !activeLayer.locked && activeFrameIndex > 0);

  return <section className="cel-exposure-panel" aria-label="Cel exposure grid">
    <header>
      <span><strong>Cel exposure</strong><small>{layers.length} pixel layer{layers.length === 1 ? '' : 's'} × {sprite.frameIds.length} frame{sprite.frameIds.length === 1 ? '' : 's'}</small></span>
      <span className="cel-exposure-paging">
        <button aria-label="Previous layer page" disabled={boundedLayerPage === 0} onClick={() => setLayerPage((page) => Math.max(0, page - 1))}><ChevronUp size={11} /></button>
        <small>Layers {layers.length ? layerStart + 1 : 0}–{Math.min(layers.length, layerStart + shownLayers.length)}</small>
        <button aria-label="Next layer page" disabled={boundedLayerPage >= layerPageCount - 1} onClick={() => setLayerPage((page) => Math.min(layerPageCount - 1, page + 1))}><ChevronDown size={11} /></button>
        <button aria-label="Previous frame page" disabled={boundedFramePage === 0} onClick={() => setFramePage((page) => Math.max(0, page - 1))}><ChevronLeft size={11} /></button>
        <small>Frames {frameStart + 1}–{Math.min(sprite.frameIds.length, frameStart + frames.length)}</small>
        <button aria-label="Next frame page" disabled={boundedFramePage >= framePageCount - 1} onClick={() => setFramePage((page) => Math.min(framePageCount - 1, page + 1))}><ChevronRight size={11} /></button>
      </span>
      <button className="cel-exposure-close" aria-label="Close cel exposure grid" onClick={onClose}><X size={13} /></button>
    </header>
    <div className="cel-exposure-grid" role="grid" aria-label="Layer and frame cel exposures">
      <div className="cel-exposure-row cel-exposure-head" role="row" style={gridStyle}>
        <span role="columnheader">Layer / frame</span>
        {frames.map((frameId) => <button key={frameId} role="columnheader" className={frameId === activeFrameId ? 'is-active' : ''} onClick={() => resolvedLayerId && onSelect(frameId, resolvedLayerId)} aria-label={`Select frame ${sprite.frameIds.indexOf(frameId) + 1}`}>{sprite.frameIds.indexOf(frameId) + 1}</button>)}
      </div>
      {shownLayers.map((layer) => <div className="cel-exposure-row" role="row" style={gridStyle} key={layer.id}>
        <button role="rowheader" className={layer.id === resolvedLayerId ? 'is-active' : ''} onClick={() => onSelect(activeFrameId, layer.id)} title={layer.name}><span>{layer.name}</span>{layer.locked ? <small>locked</small> : !layer.visible ? <small>hidden</small> : null}</button>
        {frames.map((frameId) => {
          const raw = pixelRawCelForFrame(sprite, layer.id, frameId);
          const status = raw?.linkedToCelId ? 'linked' : raw && Object.keys(raw.chunks).length ? 'painted' : raw ? 'blank' : 'missing';
          const selected = layer.id === resolvedLayerId && frameId === activeFrameId;
          return <button role="gridcell" aria-selected={selected} aria-label={`${layer.name}, frame ${sprite.frameIds.indexOf(frameId) + 1}: ${status}`} title={`${layer.name} · frame ${sprite.frameIds.indexOf(frameId) + 1} · ${status}`} className={`${selected ? 'is-active ' : ''}is-${status}`} key={frameId} onClick={() => onSelect(frameId, layer.id)}>{status === 'linked' ? '↗' : status === 'painted' ? '●' : status === 'blank' ? '○' : '–'}</button>;
        })}
      </div>)}
    </div>
    <footer>
      <span><strong>{activeLayer?.name ?? 'No pixel layer'} · frame {activeFrameIndex + 1}</strong><small>{activeRawCel?.linkedToCelId ? 'Linked to the previous resolved cel.' : activeRawCel ? 'Independent cel.' : 'Missing cel exposure.'}</small></span>
      <button disabled={!activeCanLink} onClick={() => activeLayer && onToggleLink(activeLayer.id, activeFrameId)}>{activeRawCel?.linkedToCelId ? <><Unlink2 size={11} /> Unlink copy</> : <><Link2 size={11} /> Link previous</>}</button>
    </footer>
    <small className="cel-exposure-note">Linking clears this exposure's own pixels and follows the previous resolved cel. Unlinking snapshots the currently resolved pixels. Locked layers are read-only here.</small>
  </section>;
}

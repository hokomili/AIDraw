import type { PixelTilemap, TilemapLayer } from '@aidraw/core';

export interface ComposedTilemapLayer {
  layer: TilemapLayer;
  opacity: number;
  offsetX: number;
  offsetY: number;
  parallaxX: number;
  parallaxY: number;
}

export interface TilemapLayerScreenTranslation {
  x: number;
  y: number;
}

interface LayerComposition {
  opacity: number;
  offsetX: number;
  offsetY: number;
  parallaxX: number;
  parallaxY: number;
}

const ROOT_COMPOSITION: LayerComposition = {
  opacity: 1,
  offsetX: 0,
  offsetY: 0,
  parallaxX: 1,
  parallaxY: 1,
};

function selectedLayerIds(map: PixelTilemap, onlyLayerId: string | undefined): Set<string> | undefined {
  if (!onlyLayerId) return undefined;
  const selected = new Set<string>();
  const collect = (id: string, visiting: Set<string>): void => {
    if (visiting.has(id) || selected.has(id)) return;
    const layer = map.layers[id];
    if (!layer) return;
    selected.add(id);
    if (layer.type !== 'group') return;
    const nextVisiting = new Set(visiting); nextVisiting.add(id);
    for (const childId of layer.childIds ?? []) collect(childId, nextVisiting);
  };
  collect(onlyLayerId, new Set());
  return selected;
}

/**
 * Flattens visible leaf layers in painter order while applying Tiled's group
 * inheritance: opacity multiplies, drawing offsets add, and parallax factors
 * multiply. The canonical layer records remain unchanged.
 */
export function composedVisibleTilemapLayers(map: PixelTilemap, onlyLayerId?: string): ComposedTilemapLayer[] {
  const selected = selectedLayerIds(map, onlyLayerId);
  if (selected && selected.size === 0) return [];
  const result: ComposedTilemapLayer[] = [];
  const visit = (id: string, inherited: LayerComposition, visiting: Set<string>): void => {
    if (visiting.has(id)) return;
    const layer = map.layers[id];
    if (!layer?.visible) return;
    const composed: LayerComposition = {
      opacity: inherited.opacity * layer.opacity,
      offsetX: inherited.offsetX + layer.offsetX,
      offsetY: inherited.offsetY + layer.offsetY,
      parallaxX: inherited.parallaxX * layer.parallaxX,
      parallaxY: inherited.parallaxY * layer.parallaxY,
    };
    if (layer.type === 'group') {
      const nextVisiting = new Set(visiting); nextVisiting.add(id);
      for (const childId of layer.childIds ?? []) visit(childId, composed, nextVisiting);
      return;
    }
    if (!selected || selected.has(id)) result.push({ layer, ...composed });
  };
  for (const id of map.layerIds) visit(id, ROOT_COMPOSITION, new Set());
  return result;
}

export function tilemapLayerScreenTranslation(
  layer: Pick<ComposedTilemapLayer, 'offsetX' | 'offsetY' | 'parallaxX' | 'parallaxY'>,
  pan: Readonly<TilemapLayerScreenTranslation>,
  projectionScale: number,
): TilemapLayerScreenTranslation {
  if (![pan.x, pan.y, projectionScale].every(Number.isFinite) || projectionScale <= 0) throw new RangeError('Tilemap layer screen translation requires finite pan and a positive projection scale.');
  return {
    x: pan.x * (layer.parallaxX - 1) + layer.offsetX * projectionScale,
    y: pan.y * (layer.parallaxY - 1) + layer.offsetY * projectionScale,
  };
}

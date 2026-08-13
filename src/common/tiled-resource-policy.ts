import type { PixelTilemap } from '@aidraw/core';

export const MAX_TILED_LAYERS = 4_096;
export const MAX_TILED_DEPTH = 64;
export const MAX_TILED_TILESETS = 1_024;
export const MAX_TILED_LAYER_CELLS = 4_194_304;
export const MAX_TILED_TOTAL_CELLS = 16_777_216;
export const MAX_TILED_OBJECTS = 100_000;

export interface TiledExportResourcePlan {
  layers: number;
  maximumDepth: number;
  tileCells: number;
  objects: number;
}

function safeCellCount(width: number, height: number, label: string): number {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
    || width > Math.floor(MAX_TILED_TOTAL_CELLS / height)) {
    throw new RangeError(`${label} exceeds AIDraw's ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-cell Tiled safety envelope.`);
  }
  return width * height;
}

/**
 * Preflights the exact map-layer tree and expanded tile payload emitted by the
 * Tiled writers. The limits intentionally match import admission so AIDraw
 * does not construct an artifact that its own bounded importer must reject.
 */
export function assertTiledExportResourceBudget(map: PixelTilemap): TiledExportResourcePlan {
  const plan: TiledExportResourcePlan = { layers: 0, maximumDepth: 0, tileCells: 0, objects: 0 };
  const visiting = new Set<string>();

  const visit = (layerId: string, depth: number): void => {
    if (depth > MAX_TILED_DEPTH) throw new RangeError(`Tiled export group nesting exceeds the ${MAX_TILED_DEPTH}-level safety limit.`);
    plan.layers += 1;
    if (plan.layers > MAX_TILED_LAYERS) throw new RangeError(`Tiled export exceeds the ${MAX_TILED_LAYERS.toLocaleString('en-US')}-layer safety limit.`);
    plan.maximumDepth = Math.max(plan.maximumDepth, depth);
    const layer = map.layers[layerId];
    if (!layer) throw new Error(`Tiled export layer ${layerId} is missing.`);

    if (layer.type === 'group') {
      if (visiting.has(layerId)) throw new Error('Tiled export layer hierarchy contains a cycle.');
      visiting.add(layerId);
      try { for (const childId of layer.childIds ?? []) visit(childId, depth + 1); }
      finally { visiting.delete(layerId); }
      return;
    }
    if (layer.type === 'object') {
      plan.objects += layer.objects?.length ?? 0;
      if (!Number.isSafeInteger(plan.objects) || plan.objects > MAX_TILED_OBJECTS) throw new RangeError(`Tiled export exceeds the ${MAX_TILED_OBJECTS.toLocaleString('en-US')}-object safety limit.`);
      return;
    }

    let layerCells: number;
    if (map.infinite) {
      layerCells = 0;
      const chunks = layer.chunks ?? {};
      for (const key in chunks) {
        if (!Object.prototype.hasOwnProperty.call(chunks, key)) continue;
        const chunk = chunks[key];
        const cells = safeCellCount(chunk.width, chunk.height, 'A Tiled export chunk');
        if (cells > MAX_TILED_LAYER_CELLS - layerCells) throw new RangeError(`A Tiled export layer exceeds the ${MAX_TILED_LAYER_CELLS.toLocaleString('en-US')}-cell safety limit.`);
        layerCells += cells;
      }
    } else {
      layerCells = safeCellCount(map.width, map.height, 'A finite Tiled export layer');
      if (layerCells > MAX_TILED_LAYER_CELLS) throw new RangeError(`A Tiled export layer exceeds the ${MAX_TILED_LAYER_CELLS.toLocaleString('en-US')}-cell safety limit.`);
    }
    if (layerCells > MAX_TILED_TOTAL_CELLS - plan.tileCells) throw new RangeError(`Tiled export layer data exceeds the ${MAX_TILED_TOTAL_CELLS.toLocaleString('en-US')}-cell aggregate safety limit.`);
    plan.tileCells += layerCells;
  };

  for (const layerId of map.layerIds) visit(layerId, 0);
  return plan;
}

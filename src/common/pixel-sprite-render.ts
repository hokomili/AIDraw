import {
  decodePixelChunk,
  pixelCelForFrame,
  type PixelCel,
  type PixelDocument,
  type PixelSprite,
} from '@aidraw/core';

export interface PixelSpriteRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelSpriteRegionPlan {
  /** Integer, nominal-sprite-clipped pixels that need compositing. */
  render: PixelSpriteRegion;
  /** Original sampling rectangle expressed in the bounded render surface. */
  sample: PixelSpriteRegion;
  empty: boolean;
}

interface PixelSpriteCanvasContext {
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}

export interface DrawPixelSpriteRegionOptions {
  onlyLayerId?: string;
  invalidChunk?: 'throw' | 'skip';
  opacityMultiplier?: number;
  colorForIndex?: (index: number, cel: PixelCel) => string;
  skipPixel?: (cel: PixelCel, x: number, y: number, index: number) => boolean;
}

function assertRegion(source: PixelSpriteRegion): void {
  if (![source.x, source.y, source.width, source.height].every(Number.isFinite) || source.width <= 0 || source.height <= 0) {
    throw new RangeError('Pixel sprite source rectangles must use finite positive geometry.');
  }
}

/**
 * Plans the smallest integer surface that reproduces sampling the requested
 * rectangle from the nominal full-sprite canvas. Fractional source offsets
 * remain in `sample`, and stored pixels outside nominal sprite bounds cannot
 * leak into a placed tile.
 */
export function pixelSpriteRegionPlan(sprite: PixelSprite, source: PixelSpriteRegion): PixelSpriteRegionPlan {
  assertRegion(source);
  const startX = Math.max(0, Math.floor(source.x));
  const startY = Math.max(0, Math.floor(source.y));
  const endX = Math.min(sprite.width, Math.ceil(source.x + source.width));
  const endY = Math.min(sprite.height, Math.ceil(source.y + source.height));
  if (endX <= startX || endY <= startY) {
    return {
      render: { x: 0, y: 0, width: 1, height: 1 },
      sample: { x: 0, y: 0, width: 1, height: 1 },
      empty: true,
    };
  }
  return {
    render: { x: startX, y: startY, width: endX - startX, height: endY - startY },
    sample: { x: source.x - startX, y: source.y - startY, width: source.width, height: source.height },
    empty: false,
  };
}

function visibleLayers(sprite: PixelSprite, onlyLayerId?: string): Array<{ layer: PixelSprite['layers'][string]; opacity: number }> {
  const result: Array<{ layer: PixelSprite['layers'][string]; opacity: number }> = [];
  const visit = (id: string, opacity = 1) => {
    const layer = sprite.layers[id];
    if (!layer?.visible) return;
    const combined = opacity * layer.opacity;
    if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined);
    else result.push({ layer, opacity: combined });
  };
  if (onlyLayerId) visit(onlyLayerId);
  else for (const id of sprite.layerIds) visit(id);
  return result;
}

function decodedChunk(value: unknown, invalidChunk: 'throw' | 'skip'): Uint8Array | undefined {
  if (invalidChunk === 'throw') return decodePixelChunk(value as PixelCel['chunks'][string]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const chunk = value as PixelCel['chunks'][string];
  if (![chunk.x, chunk.y, chunk.width, chunk.height].every(Number.isFinite) || chunk.width !== 32 || chunk.height !== 32 || typeof chunk.data !== 'string') return undefined;
  try {
    const decoded = decodePixelChunk(chunk);
    return decoded.length === chunk.width * chunk.height ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Composites one sprite frame into a same-size bounded source surface. The
 * routine is shared by browser and headless canvases and preserves the
 * established layer order, linked-cel resolution, opacity, blend, and frame
 * palette behavior without allocating the nominal full sprite.
 */
export function drawPixelSpriteRegion(
  context: PixelSpriteCanvasContext,
  sprite: PixelSprite,
  frameId: string,
  palette: PixelDocument['palette'],
  source: PixelSpriteRegion,
  options: DrawPixelSpriteRegionOptions = {},
): void {
  assertRegion(source);
  const opacityMultiplier = options.opacityMultiplier ?? 1;
  if (!Number.isFinite(opacityMultiplier) || opacityMultiplier < 0 || opacityMultiplier > 1) throw new RangeError('Pixel sprite opacity multiplier must be between zero and one.');
  const sourceEndX = source.x + source.width;
  const sourceEndY = source.y + source.height;
  const nominalStartX = Math.max(0, Math.floor(source.x));
  const nominalStartY = Math.max(0, Math.floor(source.y));
  const nominalEndX = Math.min(sprite.width, Math.ceil(sourceEndX));
  const nominalEndY = Math.min(sprite.height, Math.ceil(sourceEndY));
  if (nominalEndX <= nominalStartX || nominalEndY <= nominalStartY) return;
  const firstChunkX = Math.floor(nominalStartX / 32);
  const firstChunkY = Math.floor(nominalStartY / 32);
  const lastChunkX = Math.floor((nominalEndX - 1) / 32);
  const lastChunkY = Math.floor((nominalEndY - 1) / 32);
  const candidateChunkCount = (lastChunkX - firstChunkX + 1) * (lastChunkY - firstChunkY + 1);
  const colors = sprite.paletteOverrides?.[frameId] ?? palette;
  context.save();
  try {
    context.imageSmoothingEnabled = false;
    for (const { layer, opacity } of visibleLayers(sprite, options.onlyLayerId)) {
      if (layer.type !== 'pixel') continue;
      const cel = pixelCelForFrame(sprite, layer.id, frameId);
      if (!cel) continue;
      context.globalAlpha = opacity * opacityMultiplier;
      context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
      const chunks = cel.chunks ?? {};
      const drawChunk = (value: unknown) => {
        const values = decodedChunk(value, options.invalidChunk ?? 'throw');
        if (!values) return;
        const chunk = value as PixelCel['chunks'][string];
        const startX = Math.max(0, Math.floor(source.x - chunk.x), -chunk.x);
        const startY = Math.max(0, Math.floor(source.y - chunk.y), -chunk.y);
        const endX = Math.min(chunk.width, Math.ceil(sourceEndX - chunk.x), sprite.width - chunk.x);
        const endY = Math.min(chunk.height, Math.ceil(sourceEndY - chunk.y), sprite.height - chunk.y);
        for (let y = startY; y < endY; y += 1) for (let x = startX; x < endX; x += 1) {
          const index = values[y * chunk.width + x] ?? 0;
          if (!index) continue;
          const documentX = chunk.x + x; const documentY = chunk.y + y;
          if (options.skipPixel?.(cel, documentX, documentY, index)) continue;
          context.fillStyle = options.colorForIndex?.(index, cel) ?? colors[index]?.color ?? '#ff00ff';
          context.fillRect(documentX - source.x, documentY - source.y, 1, 1);
        }
      };
      if (candidateChunkCount < Object.keys(chunks).length) {
        for (let chunkY = firstChunkY; chunkY <= lastChunkY; chunkY += 1) for (let chunkX = firstChunkX; chunkX <= lastChunkX; chunkX += 1) {
          const chunk = chunks[`${chunkX},${chunkY}`];
          if (chunk) drawChunk(chunk);
        }
      } else {
        for (const chunk of Object.values(chunks)) drawChunk(chunk);
      }
    }
  } finally { context.restore(); }
}

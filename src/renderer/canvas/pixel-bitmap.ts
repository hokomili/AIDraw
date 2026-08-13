import {
  decodePixelChunk,
  pixelCelForFrame,
  type PixelCel,
  type PixelDocument,
  type PixelSprite,
} from '@aidraw/core';

export function recordValues<T>(value: unknown): T[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter((entry) => Boolean(entry) && typeof entry === 'object') as T[];
}

export function visibleSpriteLayers(sprite: PixelSprite): Array<{ layer: PixelSprite['layers'][string]; opacity: number }> {
  const result: Array<{ layer: PixelSprite['layers'][string]; opacity: number }> = [];
  const visit = (id: string, opacity = 1) => {
    const layer = sprite.layers?.[id];
    if (!layer?.visible) return;
    const combined = opacity * layer.opacity;
    if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined);
    else result.push({ layer, opacity: combined });
  };
  for (const id of sprite.layerIds ?? []) visit(id);
  return result;
}

export function safeDecodePixelChunk(value: unknown): Uint8Array | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const chunk = value as PixelCel['chunks'][string];
  if (![chunk.x, chunk.y, chunk.width, chunk.height].every(Number.isFinite) || chunk.width !== 32 || chunk.height !== 32 || typeof chunk.data !== 'string') return undefined;
  try {
    const decoded = decodePixelChunk(chunk);
    return decoded.length === chunk.width * chunk.height ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function drawSpriteRegion(
  context: CanvasRenderingContext2D,
  sprite: PixelSprite,
  frameId: string,
  palette: PixelDocument['palette'],
  source: { x: number; y: number; width: number; height: number },
): void {
  context.save();
  context.imageSmoothingEnabled = false;
  for (const { layer, opacity } of visibleSpriteLayers(sprite)) {
    if (layer.type !== 'pixel') continue;
    const cel = pixelCelForFrame(sprite, layer.id, frameId);
    if (!cel) continue;
    context.globalAlpha = opacity;
    context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
    for (const chunk of recordValues<PixelCel['chunks'][string]>(cel.chunks)) {
      const values = safeDecodePixelChunk(chunk);
      if (!values) continue;
      const startX = Math.max(0, source.x - chunk.x);
      const startY = Math.max(0, source.y - chunk.y);
      const endX = Math.min(chunk.width, source.x + source.width - chunk.x);
      const endY = Math.min(chunk.height, source.y + source.height - chunk.y);
      for (let y = startY; y < endY; y += 1) for (let x = startX; x < endX; x += 1) {
        const index = values[y * chunk.width + x] ?? 0;
        if (!index) continue;
        context.fillStyle = (sprite.paletteOverrides?.[frameId] ?? palette)[index]?.color ?? '#ff00ff';
        context.fillRect(chunk.x + x - source.x, chunk.y + y - source.y, 1, 1);
      }
    }
  }
  context.restore();
}

export function spriteBitmap(sprite: PixelSprite, frameId: string, palette: PixelDocument['palette']): HTMLCanvasElement {
  const canvas = window.document.createElement('canvas');
  canvas.width = sprite.width;
  canvas.height = sprite.height;
  const context = canvas.getContext('2d')!;
  drawSpriteRegion(context, sprite, frameId, palette, { x: 0, y: 0, width: sprite.width, height: sprite.height });
  return canvas;
}

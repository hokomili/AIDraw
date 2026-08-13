import {
  decodePixelChunk,
  pixelCelForFrame,
  PIXEL_CHUNK_SIZE,
  type PaletteEntry,
  type PixelSprite,
} from '@aidraw/core';
import { pixelSpriteVisibleLayers } from './pixel-sprite-render';

interface ColorAssignment {
  color: number;
  index: number;
}

interface PlannedFrame {
  assignments: ColorAssignment[];
}

export interface ExactAnimationFramePalette {
  assignments: ColorAssignment[];
  paletteOverride?: PaletteEntry[];
}

export interface ExactAnimationPalettePlan {
  alphaThreshold: number;
  palette: PaletteEntry[];
  frames: ExactAnimationFramePalette[];
}

export interface ExactAnimationPalettePlanner {
  addFrame(rgba: Uint8ClampedArray): boolean;
  finish(): ExactAnimationPalettePlan | undefined;
}

function packedColor(red: number, green: number, blue: number, alpha: number): number {
  return ((((red * 256) + green) * 256 + blue) * 256 + alpha) >>> 0;
}

function paletteColor(value: string): number {
  const hex = value.slice(1);
  if (!/^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(hex)) throw new Error(`Palette color ${value} is invalid.`);
  return packedColor(
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  );
}

function colorHex(value: number): string {
  const red = value >>> 24;
  const green = value >>> 16 & 0xff;
  const blue = value >>> 8 & 0xff;
  const alpha = value & 0xff;
  const rgb = [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('');
  return `#${rgb}${alpha === 255 ? '' : alpha.toString(16).padStart(2, '0')}`;
}

function visibleColor(rgba: Uint8ClampedArray, offset: number, alphaThreshold: number): number | undefined {
  const alpha = rgba[offset + 3];
  if (alpha === 0 || alpha / 255 < alphaThreshold) return undefined;
  return packedColor(rgba[offset], rgba[offset + 1], rgba[offset + 2], alpha);
}

function framePlan(
  rgba: Uint8ClampedArray,
  referenceIndexes: Map<number, number>,
  alphaThreshold: number,
): PlannedFrame | undefined {
  if (rgba.byteLength % 4 !== 0) throw new Error('Animation frame RGBA data is incomplete.');
  const colors = new Map<number, undefined>();
  for (let offset = 0; offset < rgba.byteLength; offset += 4) {
    const color = visibleColor(rgba, offset, alphaThreshold);
    if (color === undefined || colors.has(color)) continue;
    colors.set(color, undefined);
    if (colors.size > 255) return undefined;
  }
  const assignments: ColorAssignment[] = [];
  const used = new Uint8Array(256); used[0] = 1;
  for (const color of colors.keys()) {
    const index = referenceIndexes.get(color);
    if (index === undefined || index === 0) continue;
    assignments.push({ color, index }); used[index] = 1;
  }
  let available = 1;
  for (const color of colors.keys()) {
    if (referenceIndexes.has(color)) continue;
    while (available < used.length && used[available]) available += 1;
    if (available >= used.length) return undefined;
    assignments.push({ color, index: available }); used[available] = 1;
  }
  return { assignments };
}

export function createExactAnimationPalettePlanner(
  referencePalette: PaletteEntry[],
  alphaThreshold: number,
): ExactAnimationPalettePlanner {
  if (referencePalette.length < 1 || referencePalette.length > 256) throw new Error('Animation palette planning requires 1–256 reference colors.');
  if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 1) throw new Error('Animation palette planning requires an alpha threshold from zero through one.');
  const referenceColors = referencePalette.map((entry) => paletteColor(entry.color));
  const referenceIndexes = new Map<number, number>();
  referenceColors.forEach((color, index) => { if (index > 0 && !referenceIndexes.has(color)) referenceIndexes.set(color, index); });
  const planned: PlannedFrame[] = [];
  let overflow = false;
  return {
    addFrame(rgba) {
      if (overflow) return false;
      const frame = framePlan(rgba, referenceIndexes, alphaThreshold);
      if (!frame) { overflow = true; planned.length = 0; return false; }
      planned.push(frame); return true;
    },
    finish() {
      if (overflow || !planned.length) return undefined;
      const highestIndex = planned.reduce((highest, frame) => frame.assignments.reduce((frameHighest, assignment) => Math.max(frameHighest, assignment.index), highest), 0);
      const length = Math.max(2, referencePalette.length, highestIndex + 1);
      const baselineColors = Array.from({ length }, (_, index) => referenceColors[index] ?? packedColor(0, 0, 0, 255));
      const frameColors = planned.map((frame) => {
        const colors = [...baselineColors];
        frame.assignments.forEach(({ color, index }) => { colors[index] = color; });
        return colors;
      });
      const entries = baselineColors.map((_, index) => {
        const unchanged = referencePalette[index] !== undefined && frameColors.every((colors) => colors[index] === baselineColors[index]);
        return {
          id: referencePalette[index]?.id ?? `imported-animation-color-${index}`,
          name: unchanged ? referencePalette[index].name : index === 0 ? 'Transparent' : `Animation color ${index}`,
        };
      });
      const palette = entries.map((entry, index) => ({ ...entry, color: colorHex(frameColors[0][index]) }));
      const baseColors = frameColors[0];
      return {
        alphaThreshold,
        palette,
        frames: planned.map((frame, frameIndex) => ({
          assignments: frame.assignments.map((assignment) => ({ ...assignment })),
          ...(frameColors[frameIndex].some((color, index) => color !== baseColors[index])
            ? { paletteOverride: entries.map((entry, index) => ({ ...entry, color: colorHex(frameColors[frameIndex][index]) })) }
            : {}),
        })),
      };
    },
  };
}

export function exactAnimationFrameChanges(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  frame: ExactAnimationFramePalette,
  alphaThreshold: number,
): Array<{ x: number; y: number; index: number }> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.byteLength !== width * height * 4) {
    throw new Error('Animation frame RGBA data does not match its dimensions.');
  }
  const indexes = new Map(frame.assignments.map(({ color, index }) => [color, index]));
  const changes: Array<{ x: number; y: number; index: number }> = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const color = visibleColor(rgba, pixel * 4, alphaThreshold);
    if (color === undefined) continue;
    const index = indexes.get(color);
    if (index === undefined) throw new Error('Animation frame colors disagree with the exact palette plan.');
    changes.push({ x: pixel % width, y: Math.floor(pixel / width), index });
  }
  return changes;
}

interface SingleLayerAnimationFrame {
  colors: Array<readonly [number, number, number, number]>;
  indexes: Uint8Array;
}

function animationFrameColors(palette: PaletteEntry[], sprite: PixelSprite, frameId: string): SingleLayerAnimationFrame['colors'] | undefined {
  const sourcePalette = sprite.paletteOverrides?.[frameId] ?? palette;
  if (sourcePalette.length < 2 || sourcePalette.length > 256) return undefined;
  return sourcePalette.map(({ color }) => {
    const packed = paletteColor(color);
    return [packed >>> 24, packed >>> 16 & 0xff, packed >>> 8 & 0xff, packed & 0xff] as const;
  });
}

function visitPixelLayerIndexes(
  sprite: PixelSprite,
  layerId: string,
  frameId: string,
  visit: (index: number, pixel: number) => boolean,
): boolean {
  const cel = pixelCelForFrame(sprite, layerId, frameId);
  if (!cel) return true;
  const chunks = cel.chunks ?? {};
  const writeChunk = (chunk: (typeof chunks)[string]): boolean => {
    if (chunk.x >= sprite.width || chunk.y >= sprite.height || chunk.x + chunk.width <= 0 || chunk.y + chunk.height <= 0) return true;
    const decoded = decodePixelChunk(chunk);
    for (let y = 0; y < chunk.height; y += 1) for (let x = 0; x < chunk.width; x += 1) {
      const documentX = chunk.x + x; const documentY = chunk.y + y;
      if (documentX < 0 || documentY < 0 || documentX >= sprite.width || documentY >= sprite.height) continue;
      const index = decoded[y * chunk.width + x] ?? 0;
      if (index && !visit(index, documentY * sprite.width + documentX)) return false;
    }
    return true;
  };
  const chunkColumns = Math.ceil(sprite.width / PIXEL_CHUNK_SIZE); const chunkRows = Math.ceil(sprite.height / PIXEL_CHUNK_SIZE);
  if (chunkColumns * chunkRows < Object.keys(chunks).length) {
    for (let chunkY = 0; chunkY < chunkRows; chunkY += 1) for (let chunkX = 0; chunkX < chunkColumns; chunkX += 1) {
      const chunk = chunks[`${chunkX},${chunkY}`];
      if (chunk && !writeChunk(chunk)) return false;
    }
  } else {
    for (const chunk of Object.values(chunks)) if (!writeChunk(chunk)) return false;
  }
  return true;
}

/**
 * Resolves the simple single-pixel-layer shape produced by GIF/APNG import.
 * More complex layer composites keep using the established renderer.
 */
function singlePixelLayerAnimationFrame(
  palette: PaletteEntry[],
  sprite: PixelSprite,
  frameId: string,
  layerId: string,
): SingleLayerAnimationFrame | undefined {
  const layer = sprite.layers[layerId];
  if (!layer || layer.type !== 'pixel') return undefined;
  const indexes = new Uint8Array(sprite.width * sprite.height);
  const colors = animationFrameColors(palette, sprite, frameId);
  if (!colors) return undefined;
  if (!layer.visible) return { colors, indexes };
  if (!visitPixelLayerIndexes(sprite, layer.id, frameId, (index, pixel) => {
    if (!colors[index]) return false;
    indexes[pixel] = index; return true;
  })) return undefined;
  return { colors, indexes };
}

function singleLayerAnimationFrame(
  palette: PaletteEntry[],
  sprite: PixelSprite,
  frameId: string,
): SingleLayerAnimationFrame | undefined {
  if (sprite.layerIds.length !== 1 || Object.keys(sprite.layers).length !== 1) return undefined;
  const layer = sprite.layers[sprite.layerIds[0]];
  if (!layer || layer.type !== 'pixel' || layer.opacity !== 1 || layer.blendMode !== 'normal') return undefined;
  return singlePixelLayerAnimationFrame(palette, sprite, frameId, layer.id);
}

function roundedRatio(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}

function sourceOverPixel(
  output: Uint8ClampedArray,
  offset: number,
  source: readonly [number, number, number, number],
): void {
  const sourceAlpha = source[3];
  if (sourceAlpha === 0) return;
  if (sourceAlpha === 255 || output[offset + 3] === 0) {
    output.set(source, offset);
    return;
  }
  const destinationAlpha = output[offset + 3];
  const inverseSourceAlpha = 255 - sourceAlpha;
  const alphaNumerator = sourceAlpha * 255 + destinationAlpha * inverseSourceAlpha;
  for (let channel = 0; channel < 3; channel += 1) {
    const colorNumerator = source[channel] * sourceAlpha * 255
      + output[offset + channel] * destinationAlpha * inverseSourceAlpha;
    output[offset + channel] = roundedRatio(colorNumerator, alphaNumerator);
  }
  output[offset + 3] = roundedRatio(alphaNumerator, 255);
}

/**
 * Returns deterministic unpremultiplied RGBA for the ordinary normal-composite
 * pixel subset. Visible nested leaves must retain full opacity and normal blend;
 * richer composites deliberately keep using the established Canvas renderer.
 */
export function exactNormalCompositeAnimationFrame(
  palette: PaletteEntry[],
  sprite: PixelSprite,
  frameId: string,
): Uint8ClampedArray | undefined {
  const visible = pixelSpriteVisibleLayers(sprite);
  if (visible.some(({ layer, opacity, normalBlend }) => layer.type !== 'pixel' || opacity !== 1 || !normalBlend)) return undefined;
  const colors = animationFrameColors(palette, sprite, frameId);
  if (!colors) return undefined;
  const output = new Uint8ClampedArray(sprite.width * sprite.height * 4);
  if (visible.length === 1) {
    if (!visitPixelLayerIndexes(sprite, visible[0].layer.id, frameId, (index, pixel) => {
      if (!colors[index]) return false;
      output.set(colors[index], pixel * 4); return true;
    })) return undefined;
    return output;
  }
  for (const { layer } of visible) {
    if (!visitPixelLayerIndexes(sprite, layer.id, frameId, (index, pixel) => {
      const color = colors[index];
      if (!color || color[3] === 0) return false;
      sourceOverPixel(output, pixel * 4, color);
      return true;
    })) return undefined;
  }
  return output;
}

/** Returns exact opaque RGB/index data suitable for a GIF local color table. */
export function exactSingleLayerGifFrame(
  palette: PaletteEntry[],
  sprite: PixelSprite,
  frameId: string,
): { indexes: Uint8Array; palette: number[][] } | undefined {
  const frame = singleLayerAnimationFrame(palette, sprite, frameId);
  if (!frame) return undefined;
  for (const index of frame.indexes) if (index && frame.colors[index]?.[3] !== 255) return undefined;
  return { indexes: frame.indexes, palette: frame.colors.map(([red, green, blue]) => [red, green, blue]) };
}

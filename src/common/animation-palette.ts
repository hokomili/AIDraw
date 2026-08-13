import {
  decodePixelChunk,
  pixelCelForFrame,
  PIXEL_CHUNK_SIZE,
  type PaletteEntry,
  type PixelSprite,
} from '@aidraw/core';

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

/**
 * Returns raw indexed RGBA for the simple single-pixel-layer shape produced by
 * GIF/APNG import. Avoiding a Canvas readback preserves stored partial-alpha
 * channels during APNG re-export; more complex layer composites keep using the
 * established renderer.
 */
export function exactSingleLayerAnimationFrame(
  palette: PaletteEntry[],
  sprite: PixelSprite,
  frameId: string,
): Uint8ClampedArray | undefined {
  if (sprite.layerIds.length !== 1 || Object.keys(sprite.layers).length !== 1) return undefined;
  const layer = sprite.layers[sprite.layerIds[0]];
  if (!layer || layer.type !== 'pixel' || layer.opacity !== 1 || layer.blendMode !== 'normal') return undefined;
  const output = new Uint8ClampedArray(sprite.width * sprite.height * 4);
  if (!layer.visible) return output;
  const cel = pixelCelForFrame(sprite, layer.id, frameId);
  if (!cel) return output;
  const colors = sprite.paletteOverrides?.[frameId] ?? palette;
  const rgba = colors.map(({ color }) => {
    const packed = paletteColor(color);
    return [packed >>> 24, packed >>> 16 & 0xff, packed >>> 8 & 0xff, packed & 0xff] as const;
  });
  const chunks = cel.chunks ?? {};
  const writeChunk = (chunk: (typeof chunks)[string]): boolean => {
    if (chunk.x >= sprite.width || chunk.y >= sprite.height || chunk.x + chunk.width <= 0 || chunk.y + chunk.height <= 0) return true;
    const indexes = decodePixelChunk(chunk);
    for (let y = 0; y < chunk.height; y += 1) for (let x = 0; x < chunk.width; x += 1) {
      const documentX = chunk.x + x; const documentY = chunk.y + y;
      if (documentX < 0 || documentY < 0 || documentX >= sprite.width || documentY >= sprite.height) continue;
      const index = indexes[y * chunk.width + x] ?? 0;
      if (!index) continue;
      const color = rgba[index];
      if (!color) return false;
      output.set(color, (documentY * sprite.width + documentX) * 4);
    }
    return true;
  };
  const chunkColumns = Math.ceil(sprite.width / PIXEL_CHUNK_SIZE); const chunkRows = Math.ceil(sprite.height / PIXEL_CHUNK_SIZE);
  if (chunkColumns * chunkRows < Object.keys(chunks).length) {
    for (let chunkY = 0; chunkY < chunkRows; chunkY += 1) for (let chunkX = 0; chunkX < chunkColumns; chunkX += 1) {
      const chunk = chunks[`${chunkX},${chunkY}`];
      if (chunk && !writeChunk(chunk)) return undefined;
    }
  } else {
    for (const chunk of Object.values(chunks)) if (!writeChunk(chunk)) return undefined;
  }
  return output;
}

import { nativeImage } from 'electron';
import type { PaletteEntry } from '@aidraw/core';

function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = hex.replace('#', '');
  if (normalized.length === 3) return [Number.parseInt(normalized[0] + normalized[0], 16), Number.parseInt(normalized[1] + normalized[1], 16), Number.parseInt(normalized[2] + normalized[2], 16), 255];
  if (normalized.length === 6 || normalized.length === 8) return [Number.parseInt(normalized.slice(0, 2), 16), Number.parseInt(normalized.slice(2, 4), 16), Number.parseInt(normalized.slice(4, 6), 16), normalized.length === 8 ? Number.parseInt(normalized.slice(6, 8), 16) : 255];
  return [0, 0, 0, 255];
}

function linear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function oklab(red: number, green: number, blue: number): [number, number, number] {
  const r = linear(red); const g = linear(green); const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function quantizeToPalette(
  encoded: Buffer,
  width: number,
  height: number,
  palette: PaletteEntry[],
  alphaThreshold = 0.5,
  dithering: 'none' | 'bayer-4x4' | 'floyd-steinberg' = 'none',
): Array<{ x: number; y: number; index: number }> {
  const resized = nativeImage.createFromBuffer(encoded).resize({ width, height, quality: 'best' });
  if (resized.isEmpty()) throw new Error('The generated image could not be decoded.');
  const bitmap = resized.toBitmap();
  const paletteLabs = palette.map((entry) => {
    const rgba = hexToRgba(entry.color);
    return { rgba, lab: oklab(rgba[0], rgba[1], rgba[2]) };
  });
  const changes: Array<{ x: number; y: number; index: number }> = [];
  const errors = new Float32Array(width * height * 3);
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const errorOffset = (y * width + x) * 3;
    const threshold = dithering === 'bayer-4x4' ? (bayer[y % 4][x % 4] - 7.5) * 2 : 0;
    const blue = Math.max(0, Math.min(255, bitmap[offset] + errors[errorOffset + 2] + threshold));
    const green = Math.max(0, Math.min(255, bitmap[offset + 1] + errors[errorOffset + 1] + threshold));
    const red = Math.max(0, Math.min(255, bitmap[offset + 2] + errors[errorOffset] + threshold)); const alpha = bitmap[offset + 3] / 255;
    if (alpha < alphaThreshold) continue;
    const lab = oklab(red, green, blue);
    let best = palette.length > 1 ? 1 : 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < paletteLabs.length; index += 1) {
      const candidate = paletteLabs[index];
      if (candidate.rgba[3] === 0) continue;
      const delta = (lab[0] - candidate.lab[0]) ** 2 + (lab[1] - candidate.lab[1]) ** 2 + (lab[2] - candidate.lab[2]) ** 2;
      if (delta < distance) { distance = delta; best = index; }
    }
    changes.push({ x, y, index: best });
    if (dithering === 'floyd-steinberg') {
      const chosen = paletteLabs[best].rgba; const error = [red - chosen[0], green - chosen[1], blue - chosen[2]];
      const diffuse = (targetX: number, targetY: number, weight: number) => {
        if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) return;
        const target = (targetY * width + targetX) * 3; for (let channel = 0; channel < 3; channel += 1) errors[target + channel] += error[channel] * weight;
      };
      diffuse(x + 1, y, 7 / 16); diffuse(x - 1, y + 1, 3 / 16); diffuse(x, y + 1, 5 / 16); diffuse(x + 1, y + 1, 1 / 16);
    }
  }
  return changes;
}

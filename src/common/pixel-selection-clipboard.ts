import {
  createId,
  pixelCelForFrame,
  type CanvasOperation,
  type PixelDocument,
  type PixelSprite,
} from '@aidraw/core';
import { parseDocumentFragment, type PixelSelectionFragment } from './document-fragment';
import { placeGridClipboard } from './grid-selection';
import type { PixelSelectionPoint } from './pixel-selection';

export interface PixelSelectionPastePlan {
  operations: CanvasOperation[];
  expectedDocumentRevision?: number;
  selection: PixelSelectionPoint[];
  bounds: { x: number; y: number; width: number; height: number };
  dropped: number;
  addedPaletteEntries: number;
}

export interface PixelSelectionPasteTarget {
  document: PixelDocument;
  spriteId: string;
  frameId: string;
  celId: string;
  origin: PixelSelectionPoint;
  createPaletteEntryId?: () => string;
}

export interface PixelSelectionPngSource {
  width: number;
  height: number;
  changes: Array<{ x: number; y: number; index: number }>;
}

export function assertPixelSelectionPngGeometry(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 8_192 || height > 8_192 || width > Math.floor(1_000_000 / height)) {
    throw new Error('Standard PNG selection conversion is limited to one million cells and 8,192 pixels per side.');
  }
}

function resolvedPasteTarget(target: PixelSelectionPasteTarget): {
  sprite: PixelSprite;
  cel: PixelSprite['cels'][string];
  effectiveColors: string[];
} {
  const { document, spriteId, frameId, celId, origin } = target;
  const sprite = document.pixelAssets[spriteId] as PixelSprite | undefined;
  if (!sprite || sprite.type !== 'sprite') throw new Error('Choose a sprite before pasting an indexed selection.');
  if (!sprite.frameIds.includes(frameId)) throw new Error('The destination frame is no longer available.');
  const cel = sprite.cels[celId];
  if (!cel || pixelCelForFrame(sprite, cel.layerId, frameId)?.id !== cel.id) throw new Error('The destination cel is no longer the writable exposure for this frame.');
  const layer = sprite.layers[cel.layerId];
  if (!layer || layer.type !== 'pixel') throw new Error('The destination pixel layer is no longer available.');
  const visited = new Set<string>();
  let current = layer;
  for (;;) {
    if (visited.has(current.id)) throw new Error('The destination pixel layer hierarchy is invalid.');
    visited.add(current.id);
    if (!current.visible || current.locked) throw new Error('Choose a visible, unlocked pixel layer before pasting.');
    if (!current.parentId) break;
    const parent = sprite.layers[current.parentId];
    if (!parent || parent.type !== 'group') throw new Error('The destination pixel layer hierarchy is invalid.');
    current = parent;
  }
  if (!Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) throw new Error('The paste origin must use exact integer pixel coordinates.');
  const effectiveColors = (sprite.paletteOverrides[frameId] ?? document.palette).map((entry) => entry.color);
  if (effectiveColors.length !== document.palette.length) throw new Error('The destination frame palette does not align with the document palette.');
  return { sprite, cel, effectiveColors };
}

function exactColorIndex(colors: string[], color: string): number {
  const normalized = color.toLowerCase();
  return colors.findIndex((candidate) => candidate.toLowerCase() === normalized);
}

function selectionBounds(points: PixelSelectionPoint[]): PixelSelectionPastePlan['bounds'] {
  let left = points[0].x; let right = points[0].x; let top = points[0].y; let bottom = points[0].y;
  for (const point of points.slice(1)) {
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Plans one canonical indexed-selection paste. The effective destination frame
 * palette determines appearance; missing colors are appended to the document
 * palette so the reducer extends every frame override coherently.
 */
export function planPixelSelectionPaste(
  target: PixelSelectionPasteTarget,
  input: PixelSelectionFragment,
): PixelSelectionPastePlan {
  const fragment = parseDocumentFragment(input);
  if (fragment.kind !== 'pixel-selection') throw new Error('The clipboard does not contain an indexed pixel selection.');
  const { document, origin } = target;
  const { sprite, cel, effectiveColors } = resolvedPasteTarget(target);

  const placed = placeGridClipboard(fragment.grid, origin, { width: sprite.width, height: sprite.height });
  if (!placed.selection.length) throw new Error('The pasted pixel selection falls outside this sprite.');

  const palette = structuredClone(document.palette);
  const mapping = new Map<number, number>([[0, 0]]);
  const existingIds = new Set(palette.map((entry) => entry.id));
  const createPaletteEntryId = target.createPaletteEntryId ?? (() => createId('palette'));

  for (const cell of placed.changes) {
    const sourceIndex = cell.value;
    if (mapping.has(sourceIndex)) continue;
    const sourceColor = fragment.palette[sourceIndex];
    if (!sourceColor) throw new Error(`Clipboard palette index ${sourceIndex} is unavailable.`);
    if (fragment.sourceDocumentId === document.id
      && sourceIndex < effectiveColors.length
      && effectiveColors[sourceIndex].toLowerCase() === sourceColor.toLowerCase()) {
      mapping.set(sourceIndex, sourceIndex);
      continue;
    }
    let destinationIndex = exactColorIndex(effectiveColors, sourceColor);
    if (destinationIndex < 0) {
      if (palette.length >= 256) throw new Error('The destination palette is full; remove a color before pasting this selection.');
      const id = createPaletteEntryId();
      if (!id || existingIds.has(id)) throw new Error('A unique palette identity could not be allocated for the pasted selection.');
      existingIds.add(id);
      destinationIndex = palette.length;
      palette.push({ id, name: `Pasted ${destinationIndex}`, color: sourceColor });
      effectiveColors.push(sourceColor);
    }
    mapping.set(sourceIndex, destinationIndex);
  }

  const operations: CanvasOperation[] = [];
  if (palette.length !== document.palette.length) operations.push({ kind: 'pixel.palette.replace', palette });
  operations.push({
    kind: 'pixel.cel.set',
    spriteId: sprite.id,
    celId: cel.id,
    changes: placed.changes.map((cell) => ({ x: cell.x, y: cell.y, index: mapping.get(cell.value) ?? 0 })),
    expectedRevision: cel.revision,
  });
  return {
    operations,
    selection: placed.selection,
    bounds: selectionBounds(placed.selection),
    dropped: placed.dropped,
    addedPaletteEntries: palette.length - document.palette.length,
  };
}

/**
 * Places one completely decoded and destination-indexed standard PNG. Unlike
 * the private fragment route, the bitmap rectangle has no irregular-mask or
 * source-palette identity: every source cell, including transparent index 0,
 * is selected and written exactly once before clipping.
 */
export function planPixelSelectionPngPaste(
  target: PixelSelectionPasteTarget,
  source: PixelSelectionPngSource,
): PixelSelectionPastePlan {
  const { sprite, cel, effectiveColors } = resolvedPasteTarget(target);
  const { width, height } = source;
  assertPixelSelectionPngGeometry(width, height);
  const cellCount = width * height;
  if (source.changes.length !== cellCount) throw new Error('Standard PNG conversion did not return every visible and transparent cell.');
  const seen = new Uint8Array(cellCount);
  for (const change of source.changes) {
    if (!Number.isSafeInteger(change.x) || !Number.isSafeInteger(change.y) || !Number.isSafeInteger(change.index)
      || change.x < 0 || change.y < 0 || change.x >= width || change.y >= height
      || change.index < 0 || change.index >= effectiveColors.length) {
      throw new Error('Standard PNG conversion returned an invalid indexed cell.');
    }
    const offset = change.y * width + change.x;
    if (seen[offset]) throw new Error('Standard PNG conversion returned a duplicate indexed cell.');
    seen[offset] = 1;
  }
  const changes: Array<{ x: number; y: number; index: number }> = [];
  const selection: PixelSelectionPoint[] = [];
  let dropped = 0;
  for (const change of [...source.changes].sort((left, right) => left.y - right.y || left.x - right.x)) {
    const point = { x: target.origin.x + change.x, y: target.origin.y + change.y };
    if (point.x < 0 || point.y < 0 || point.x >= sprite.width || point.y >= sprite.height) {
      dropped += 1;
      continue;
    }
    changes.push({ ...point, index: change.index });
    selection.push(point);
  }
  if (!selection.length) throw new Error('The pasted standard PNG falls outside this sprite.');
  return {
    expectedDocumentRevision: target.document.revision,
    operations: [{
      kind: 'pixel.cel.set',
      spriteId: sprite.id,
      celId: cel.id,
      changes,
      expectedRevision: cel.revision,
    }],
    selection,
    bounds: selectionBounds(selection),
    dropped,
    addedPaletteEntries: 0,
  };
}

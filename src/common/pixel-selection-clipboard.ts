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
  const { document, spriteId, frameId, celId, origin } = target;
  const sprite = document.pixelAssets[spriteId] as PixelSprite | undefined;
  if (!sprite || sprite.type !== 'sprite') throw new Error('Choose a sprite before pasting an indexed selection.');
  if (!sprite.frameIds.includes(frameId)) throw new Error('The destination frame is no longer available.');
  const cel = sprite.cels[celId];
  if (!cel || pixelCelForFrame(sprite, cel.layerId, frameId)?.id !== cel.id) throw new Error('The destination cel is no longer the writable exposure for this frame.');
  if (!Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) throw new Error('The paste origin must use exact integer pixel coordinates.');

  const placed = placeGridClipboard(fragment.grid, origin, { width: sprite.width, height: sprite.height });
  if (!placed.selection.length) throw new Error('The pasted pixel selection falls outside this sprite.');

  const palette = structuredClone(document.palette);
  const effectiveColors = (sprite.paletteOverrides[frameId] ?? document.palette).map((entry) => entry.color);
  if (effectiveColors.length !== palette.length) throw new Error('The destination frame palette does not align with the document palette.');
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

import type { PaletteCycle, PaletteEntry, PixelCel, PixelDocument, PixelSprite, PixelStamp } from './model';
import type { CanvasOperation } from './operations';
import { decodePixelChunk, remapPixelCelIndices } from './pixel';

export function validatePaletteCycle(cycle: PaletteCycle, paletteLength: number): void {
  if (!cycle.id || !cycle.name.trim()) throw new Error('Palette cycles require an id and name.');
  if (!Number.isInteger(cycle.fromIndex) || !Number.isInteger(cycle.toIndex) || cycle.fromIndex < 1 || cycle.toIndex < cycle.fromIndex || cycle.toIndex >= paletteLength) throw new Error('Palette cycle ranges must use ordered non-transparent palette indices.');
  if (!Number.isInteger(cycle.stepMs) || cycle.stepMs < 16 || cycle.stepMs > 60_000) throw new Error('Palette cycle timing must be 16–60,000 milliseconds.');
}

export function cycledPaletteIndex(index: number, cycle: PaletteCycle | undefined, offset: number): number {
  if (!cycle || index < cycle.fromIndex || index > cycle.toIndex) return index;
  const length = cycle.toIndex - cycle.fromIndex + 1;
  const direction = cycle.direction === 'reverse' ? -1 : 1;
  return cycle.fromIndex + ((index - cycle.fromIndex + direction * offset) % length + length) % length;
}

export function countPaletteIndexUsage(document: PixelDocument, paletteIndex: number, limit = Number.POSITIVE_INFINITY): number {
  let count = 0;
  for (const stamp of document.stamps) for (const cell of stamp.cells) if (cell.index === paletteIndex && ++count >= limit) return count;
  for (const asset of Object.values(document.pixelAssets)) if (asset.type === 'sprite') for (const cel of Object.values(asset.cels)) for (const chunk of Object.values(cel.chunks ?? {})) {
    for (const value of decodePixelChunk(chunk)) if (value === paletteIndex && ++count >= limit) return count;
  }
  return count;
}

export function assertPaletteIndicesExist(indices: Iterable<number>, paletteLength: number, label: string): void {
  for (const index of indices) if (!Number.isInteger(index) || index < 0 || index >= paletteLength) {
    throw new Error(`${label} uses palette index ${index}, but the current palette has ${paletteLength} entries.`);
  }
}

export function assertPixelCelsUsePalette(cels: Iterable<PixelCel>, paletteLength: number, label: string): void {
  for (const cel of cels) for (const chunk of Object.values(cel.chunks ?? {})) {
    assertPaletteIndicesExist(decodePixelChunk(chunk), paletteLength, `${label} cel ${cel.id}`);
  }
}

export function assertPixelStampsUsePalette(stamps: Iterable<PixelStamp>, paletteLength: number): void {
  for (const stamp of stamps) assertPaletteIndicesExist(stamp.cells.map((cell) => cell.index), paletteLength, `Pixel stamp ${stamp.id}`);
}

export function assertPixelSpriteUsesPalette(sprite: PixelSprite, palette: readonly PaletteEntry[]): void {
  assertPixelCelsUsePalette(Object.values(sprite.cels), palette.length, `Pixel sprite ${sprite.id}`);
  for (const [frameId, override] of Object.entries(sprite.paletteOverrides)) {
    if (override.length !== palette.length || override.some((entry, index) => entry.id !== palette[index]?.id)) {
      throw new Error(`Pixel sprite ${sprite.id} frame ${frameId} palette override must match the current palette length and entry order.`);
    }
  }
}

export function assertPixelDocumentPaletteReferences(
  palette: readonly PaletteEntry[],
  stamps: Iterable<PixelStamp>,
  assets: PixelDocument['pixelAssets'],
): void {
  assertPixelStampsUsePalette(stamps, palette.length);
  for (const asset of Object.values(assets)) if (asset.type === 'sprite') assertPixelSpriteUsesPalette(asset, palette);
}

function spriteNeedsPaletteRemap(sprite: PixelSprite, sourceIndex: number, paletteColor: PixelDocument['palette'][number]): boolean {
  for (const cel of Object.values(sprite.cels)) for (const chunk of Object.values(cel.chunks ?? {})) for (const value of decodePixelChunk(chunk)) if (value === sourceIndex) return true;
  return Object.values(sprite.paletteOverrides).some((override) => override[sourceIndex] && JSON.stringify(override[sourceIndex]) !== JSON.stringify(paletteColor));
}

/**
 * Build one reversible canonical transaction for replacing every use of one
 * palette index and then deleting that slot. Whole-sprite replacement keeps
 * undo content-exact even when replacement and original pixels become indistinguishable.
 */
export function replaceAndDeletePaletteIndexOperations(document: PixelDocument, sourceIndex: number, replacementIndex: number): CanvasOperation[] {
  if (!Number.isInteger(sourceIndex) || sourceIndex <= 0 || sourceIndex >= document.palette.length) throw new Error('Choose a non-transparent palette index to delete.');
  if (!Number.isInteger(replacementIndex) || replacementIndex < 0 || replacementIndex >= document.palette.length || replacementIndex === sourceIndex) throw new Error('Choose a different existing palette index as the replacement.');
  const indexMap = document.palette.map((_, index) => index === sourceIndex ? replacementIndex : index);
  const operations: CanvasOperation[] = [];
  for (const asset of Object.values(document.pixelAssets)) {
    if (asset.type !== 'sprite' || !spriteNeedsPaletteRemap(asset, sourceIndex, document.palette[sourceIndex])) continue;
    const sprite = structuredClone(asset);
    for (const cel of Object.values(sprite.cels)) remapPixelCelIndices(cel, indexMap);
    for (const override of Object.values(sprite.paletteOverrides)) if (override[sourceIndex]) override[sourceIndex] = structuredClone(document.palette[sourceIndex]);
    operations.push({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: asset.revision });
  }
  if (document.stamps.some((stamp) => stamp.cells.some((cell) => cell.index === sourceIndex))) operations.push({ kind: 'pixel.stamps.replace', stamps: document.stamps.map((stamp) => ({ ...stamp, cells: stamp.cells.map((cell) => cell.index === sourceIndex ? { ...cell, index: replacementIndex } : cell) })) });

  const entryIds = document.palette.map((entry) => entry.id); const [removedId] = entryIds.splice(sourceIndex, 1); entryIds.push(removedId);
  const reordered = entryIds.map((id) => document.palette.find((entry) => entry.id === id)!);
  const oldToNew = new Map(document.palette.map((entry, oldIndex) => [oldIndex, entryIds.indexOf(entry.id)]));
  const cycles = document.paletteCycles.flatMap((cycle) => {
    const members = Array.from({ length: cycle.toIndex - cycle.fromIndex + 1 }, (_, offset) => cycle.fromIndex + offset)
      .filter((member) => member !== sourceIndex).map((member) => oldToNew.get(member)!).filter((member) => member < reordered.length - 1);
    return members.length ? [{ ...cycle, fromIndex: Math.min(...members), toIndex: Math.max(...members) }] : [];
  });
  operations.push(
    { kind: 'pixel.palette.reorder', entryIds, expectedRevision: document.revision },
    { kind: 'pixel.palette-cycles.replace', cycles },
    { kind: 'pixel.palette.replace', palette: reordered.slice(0, -1) },
  );
  if (operations.length > 256) throw new Error('This palette change spans too many sprite assets for one transaction. Split or pack the project before replacing the color.');
  return operations;
}

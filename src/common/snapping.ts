import type { IllustrationDocument, IllustrationObject, Transform } from '@aidraw/core';
import { objectWorldBounds } from './selection-transform';

export interface SnapResult { transform: Transform; guideX?: number; guideY?: number }

export function snapObjectTransform(document: IllustrationDocument, object: IllustrationObject, raw: Transform): SnapResult {
  const settings = document.snapSettings ?? { artboard: true, objects: true, guides: true, grid: false, pixel: false, gridSize: 16, tolerance: 8 };
  const threshold = settings.tolerance; if (threshold <= 0) return { transform: { ...raw } };
  const candidate = { ...structuredClone(object), transform: { ...raw } } as IllustrationObject; const bounds = objectWorldBounds(candidate);
  const xOffsets = [bounds.x - raw.x, bounds.x + bounds.width / 2 - raw.x, bounds.x + bounds.width - raw.x];
  const yOffsets = [bounds.y - raw.y, bounds.y + bounds.height / 2 - raw.y, bounds.y + bounds.height - raw.y];
  const xTargets: number[] = []; const yTargets: number[] = [];
  if (settings.artboard) { xTargets.push(0, document.artboard.width / 2, document.artboard.width); yTargets.push(0, document.artboard.height / 2, document.artboard.height); }
  if (settings.guides) for (const guide of document.guides ?? []) (guide.orientation === 'vertical' ? xTargets : yTargets).push(guide.position);
  if (settings.objects) for (const other of Object.values(document.objects)) if (other.id !== object.id && other.visible) { const otherBounds = objectWorldBounds(other); xTargets.push(otherBounds.x, otherBounds.x + otherBounds.width / 2, otherBounds.x + otherBounds.width); yTargets.push(otherBounds.y, otherBounds.y + otherBounds.height / 2, otherBounds.y + otherBounds.height); }
  const gridSizes = [...new Set([settings.grid ? settings.gridSize : undefined, settings.pixel ? 1 : undefined].filter((size): size is number => Boolean(size)))];
  for (const size of gridSizes) { for (const offset of xOffsets) xTargets.push(Math.round((raw.x + offset) / size) * size); for (const offset of yOffsets) yTargets.push(Math.round((raw.y + offset) / size) * size); }
  let bestX = raw.x; let bestY = raw.y; let guideX: number | undefined; let guideY: number | undefined; let dx = threshold; let dy = threshold;
  for (const target of xTargets) for (const offset of xOffsets) { const next = target - offset; const distance = Math.abs(raw.x - next); if (distance < dx) { dx = distance; bestX = next; guideX = target; } }
  for (const target of yTargets) for (const offset of yOffsets) { const next = target - offset; const distance = Math.abs(raw.y - next); if (distance < dy) { dy = distance; bestY = next; guideY = target; } }
  return { transform: { ...raw, x: bestX, y: bestY }, guideX, guideY };
}

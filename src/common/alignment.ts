import type { IllustrationObject } from '@aidraw/core';
import { objectWorldBounds, selectionWorldBounds, type WorldBounds } from './selection-transform';

export type AlignmentMode = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';
export type AlignmentTarget = 'artboard' | 'selection' | 'key-object';
export type DistributionAxis = 'x' | 'y';
export type DistributionMode = 'centers' | 'spacing';

function alignmentBounds(objects: IllustrationObject[], target: AlignmentTarget, artboard: WorldBounds, keyObjectId?: string): WorldBounds {
  if (target === 'artboard') return artboard;
  if (target === 'key-object') { const key = objects.find((object) => object.id === keyObjectId); if (!key) throw new Error('The key object must be part of the selection.'); return objectWorldBounds(key); }
  const bounds = selectionWorldBounds(objects); if (!bounds) throw new Error('Select at least one object to align.'); return bounds;
}

export function alignIllustrationObjects(objects: IllustrationObject[], mode: AlignmentMode, target: AlignmentTarget, artboard: WorldBounds, keyObjectId?: string): IllustrationObject[] {
  const destination = alignmentBounds(objects, target, artboard, keyObjectId);
  return objects.map((source) => {
    const object = structuredClone(source); const bounds = objectWorldBounds(source); let delta = 0;
    if (mode === 'left') delta = destination.x - bounds.x;
    else if (mode === 'center-x') delta = destination.x + destination.width / 2 - (bounds.x + bounds.width / 2);
    else if (mode === 'right') delta = destination.x + destination.width - (bounds.x + bounds.width);
    else if (mode === 'top') delta = destination.y - bounds.y;
    else if (mode === 'center-y') delta = destination.y + destination.height / 2 - (bounds.y + bounds.height / 2);
    else delta = destination.y + destination.height - (bounds.y + bounds.height);
    if (mode === 'left' || mode === 'center-x' || mode === 'right') object.transform.x += delta; else object.transform.y += delta;
    return object;
  });
}

export function distributeIllustrationObjects(objects: IllustrationObject[], axis: DistributionAxis, mode: DistributionMode): IllustrationObject[] {
  if (objects.length < 3) throw new Error('Select at least three objects to distribute.');
  const sorted = [...objects].sort((left, right) => { const a = objectWorldBounds(left); const b = objectWorldBounds(right); return axis === 'x' ? a.x - b.x : a.y - b.y; });
  const result = sorted.map((object) => structuredClone(object)); const bounds = sorted.map(objectWorldBounds);
  if (mode === 'centers') {
    const first = bounds[0]; const last = bounds.at(-1)!; const start = axis === 'x' ? first.x + first.width / 2 : first.y + first.height / 2; const end = axis === 'x' ? last.x + last.width / 2 : last.y + last.height / 2;
    result.forEach((object, index) => { const current = bounds[index]; const center = axis === 'x' ? current.x + current.width / 2 : current.y + current.height / 2; const wanted = start + (end - start) * index / (result.length - 1); if (axis === 'x') object.transform.x += wanted - center; else object.transform.y += wanted - center; });
  } else {
    const first = bounds[0]; const last = bounds.at(-1)!; const start = axis === 'x' ? first.x : first.y; const end = axis === 'x' ? last.x + last.width : last.y + last.height; const occupied = bounds.reduce((sum, entry) => sum + (axis === 'x' ? entry.width : entry.height), 0); const gap = (end - start - occupied) / (result.length - 1); let cursor = start;
    result.forEach((object, index) => { const current = bounds[index]; const edge = axis === 'x' ? current.x : current.y; if (axis === 'x') object.transform.x += cursor - edge; else object.transform.y += cursor - edge; cursor += (axis === 'x' ? current.width : current.height) + gap; });
  }
  const byId = new Map(result.map((object) => [object.id, object])); return objects.map((object) => byId.get(object.id)!);
}

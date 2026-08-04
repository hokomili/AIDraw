import type { CanvasOperation, Id } from '@aidraw/core';

export interface ReplaySource {
  replay: boolean;
  sourceOperations: CanvasOperation[];
}

export interface ReplayMasks {
  celPixels: Map<Id, Set<string>>;
  tileCells: Map<string, Set<string>>;
  objectIds: Set<Id>;
  strokeIds: Set<Id>;
}

export function replayPointKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

export function replayTileLayerKey(mapId: Id, layerId: Id): string {
  return `${mapId}:${layerId}`;
}

function addPoint(target: Map<string, Set<string>>, id: string, x: number, y: number): void {
  if (![x, y].every(Number.isFinite)) return;
  const points = target.get(id) ?? new Set<string>();
  points.add(replayPointKey(x, y));
  target.set(id, points);
}

function addRun(target: Map<string, Set<string>>, id: string, x: number, y: number, length: number): void {
  if (![x, y, length].every(Number.isFinite) || length < 1) return;
  for (let offset = 0; offset < length; offset += 1) addPoint(target, id, x + offset, y);
}

/**
 * A committed transaction is already present in the canonical document. During
 * trace replay these masks conceal its final marks so the progressive overlay
 * is visible instead of painting identical content over itself.
 */
export function collectReplayMasks(playbacks: ReplaySource[]): ReplayMasks {
  const masks: ReplayMasks = {
    celPixels: new Map(),
    tileCells: new Map(),
    objectIds: new Set(),
    strokeIds: new Set(),
  };

  for (const playback of playbacks) {
    if (!playback.replay) continue;
    for (const operation of playback.sourceOperations) {
      if (operation.kind === 'pixel.cel.set') {
        for (const change of operation.changes) addPoint(masks.celPixels, operation.celId, change.x, change.y);
      } else if (operation.kind === 'pixel.cel.region') {
        for (const run of operation.runs) addRun(masks.celPixels, operation.celId, run.x, run.y, run.length);
      } else if (operation.kind === 'pixel.tilemap.set') {
        const key = replayTileLayerKey(operation.mapId, operation.layerId);
        for (const change of operation.changes) addPoint(masks.tileCells, key, change.x, change.y);
      } else if (operation.kind === 'pixel.tilemap.region') {
        const key = replayTileLayerKey(operation.mapId, operation.layerId);
        for (const run of operation.runs) addRun(masks.tileCells, key, run.x, run.y, run.length);
      } else if (operation.kind === 'illustration.object.add' || operation.kind === 'illustration.object.replace') {
        masks.objectIds.add(operation.object.id);
      } else if (operation.kind === 'illustration.paint.stroke') {
        masks.strokeIds.add(operation.stroke.id);
      }
    }
  }
  return masks;
}

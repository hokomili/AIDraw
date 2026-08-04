import type { AIDrawDocument, EntityBase, PixelAsset } from '@aidraw/core';

function rebaseEntity(next: EntityBase, current: EntityBase | undefined, timestamp: string): void {
  next.revision = Math.max(next.revision, current?.revision ?? -1) + 1;
  next.updatedAt = timestamp;
}

function currentAsset(document: AIDrawDocument, id: string): PixelAsset | undefined {
  return document.kind === 'pixel' ? document.pixelAssets[id] : undefined;
}

/**
 * Invalidates entity revisions when accepting an older branch so operations
 * prepared against either side of the fork cannot pass stale revision checks.
 */
export function rebaseRestoredEntityRevisions(current: AIDrawDocument, restored: AIDrawDocument, timestamp: string): void {
  if (restored.kind === 'illustration') {
    const prior = current.kind === 'illustration' ? current : undefined;
    for (const layer of Object.values(restored.layers)) rebaseEntity(layer, prior?.layers[layer.id], timestamp);
    for (const object of Object.values(restored.objects)) rebaseEntity(object, prior?.objects[object.id], timestamp);
    return;
  }
  for (const asset of Object.values(restored.pixelAssets)) {
    const prior = currentAsset(current, asset.id);
    rebaseEntity(asset, prior, timestamp);
    if (asset.type === 'sprite') {
      const priorSprite = prior?.type === 'sprite' ? prior : undefined;
      for (const layer of Object.values(asset.layers)) rebaseEntity(layer, priorSprite?.layers[layer.id], timestamp);
      for (const frame of Object.values(asset.frames)) rebaseEntity(frame, priorSprite?.frames[frame.id], timestamp);
      for (const cel of Object.values(asset.cels)) rebaseEntity(cel, priorSprite?.cels[cel.id], timestamp);
    } else if (asset.type === 'tilemap') {
      const priorMap = prior?.type === 'tilemap' ? prior : undefined;
      for (const layer of Object.values(asset.layers)) rebaseEntity(layer, priorMap?.layers[layer.id], timestamp);
    }
  }
}

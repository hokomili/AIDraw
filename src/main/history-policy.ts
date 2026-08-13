import type { AIDrawDocument, CanvasOperation, CanvasTransaction, IllustrationDocument, PixelDocument } from '@aidraw/core';

export const DOCUMENT_REVISION_HISTORY_TARGET = 'document:revision';

function add(targets: Set<string>, target: string | undefined): void {
  if (target) targets.add(target);
}

function illustration(document: AIDrawDocument): IllustrationDocument | undefined {
  return document.kind === 'illustration' ? document : undefined;
}

function pixel(document: AIDrawDocument): PixelDocument | undefined {
  return document.kind === 'pixel' ? document : undefined;
}

function layerOrderTarget(parentId: string | undefined): string {
  return `illustration:layer-order:${parentId ?? 'root'}`;
}

function objectOrderTarget(layerId: string | undefined): string | undefined {
  return layerId ? `illustration:object-order:${layerId}` : undefined;
}

function objectGroupTarget(groupId: string | undefined): string | undefined {
  return groupId ? `illustration:object-group:${groupId}` : undefined;
}

function objectMembershipTarget(objectId: string | undefined): string | undefined {
  return objectId ? `illustration:object-membership:${objectId}` : undefined;
}

function findObjectParentGroup(document: IllustrationDocument | undefined, objectId: string): string | undefined {
  if (!document) return undefined;
  return Object.values(document.objects).find((entry) => entry.type === 'group' && entry.childIds.includes(objectId))?.id;
}

function addTranslationTargets(document: IllustrationDocument | undefined, targets: Set<string>): void {
  add(targets, 'illustration:artboard');
  add(targets, 'illustration:guides');
  add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
  if (!document) return;
  const childIds = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
  for (const object of Object.values(document.objects)) if (!childIds.has(object.id)) add(targets, `illustration:object:${object.id}`);
  for (const layer of Object.values(document.layers)) if (layer.type === 'paint') add(targets, `illustration:layer:${layer.id}`);
  for (const keyframe of Object.values(document.animation.keyframes)) if (!childIds.has(keyframe.objectId)) add(targets, `illustration:keyframe:${keyframe.id}`);
}

function addOperationTargets(document: AIDrawDocument, operation: CanvasOperation, targets: Set<string>): void {
  const illustrationDocument = illustration(document);
  const pixelDocument = pixel(document);
  switch (operation.kind) {
    case 'document.rename':
      add(targets, 'document:name');
      return;
    case 'asset.add':
      add(targets, `document:asset:${operation.asset.id}`);
      return;
    case 'asset.delete':
      add(targets, `document:asset:${operation.assetId}`);
      return;
    case 'provenance.add':
      add(targets, 'document:provenance-order');
      add(targets, `document:provenance:${operation.provenance.id}`);
      return;
    case 'provenance.delete':
      add(targets, 'document:provenance-order');
      add(targets, `document:provenance:${operation.provenanceId}`);
      return;
    case 'illustration.artboard.replace':
      add(targets, 'illustration:artboard');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'illustration.artboard.translate':
      addTranslationTargets(illustrationDocument, targets);
      return;
    case 'illustration.layer.add':
      add(targets, `illustration:layer:${operation.layer.id}`);
      add(targets, layerOrderTarget(operation.layer.parentId));
      return;
    case 'illustration.layer.replace':
      add(targets, `illustration:layer:${operation.layer.id}`);
      return;
    case 'illustration.layer.move': {
      const current = illustrationDocument?.layers[operation.layerId];
      add(targets, `illustration:layer:${operation.layerId}`);
      add(targets, layerOrderTarget(current?.parentId));
      add(targets, layerOrderTarget(operation.parentId));
      return;
    }
    case 'illustration.layer.delete': {
      const current = illustrationDocument?.layers[operation.layerId];
      add(targets, `illustration:layer:${operation.layerId}`);
      add(targets, layerOrderTarget(current?.parentId));
      return;
    }
    case 'illustration.object.add':
      add(targets, `illustration:object:${operation.object.id}`);
      add(targets, objectOrderTarget(operation.object.layerId));
      add(targets, objectGroupTarget(operation.parentGroupId));
      add(targets, objectMembershipTarget(operation.parentGroupId ? operation.object.id : undefined));
      if (operation.object.type === 'group') {
        add(targets, objectGroupTarget(operation.object.id));
        for (const childId of operation.object.childIds) add(targets, objectMembershipTarget(childId));
      }
      return;
    case 'illustration.object.replace':
      add(targets, `illustration:object:${operation.object.id}`);
      return;
    case 'illustration.object.move': {
      const current = illustrationDocument?.objects[operation.objectId];
      add(targets, `illustration:object:${operation.objectId}`);
      add(targets, objectOrderTarget(current?.layerId));
      add(targets, objectOrderTarget(operation.layerId));
      add(targets, objectGroupTarget(findObjectParentGroup(illustrationDocument, operation.objectId)));
      add(targets, objectGroupTarget(operation.parentGroupId));
      add(targets, objectMembershipTarget(operation.objectId));
      return;
    }
    case 'illustration.object.delete': {
      const current = illustrationDocument?.objects[operation.objectId];
      add(targets, `illustration:object:${operation.objectId}`);
      add(targets, objectOrderTarget(current?.layerId));
      add(targets, objectGroupTarget(findObjectParentGroup(illustrationDocument, operation.objectId)));
      add(targets, objectMembershipTarget(operation.objectId));
      if (current?.type === 'group') {
        add(targets, objectGroupTarget(current.id));
        for (const childId of current.childIds) add(targets, objectMembershipTarget(childId));
      }
      return;
    }
    case 'illustration.paint.stroke':
      add(targets, `illustration:layer:${operation.layerId}`);
      return;
    case 'illustration.brush-presets.replace':
      add(targets, 'illustration:brush-presets');
      return;
    case 'illustration.guides.replace':
      add(targets, 'illustration:guides');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'illustration.snap-settings.replace':
      add(targets, 'illustration:snap-settings');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'illustration.animation.settings.replace':
      add(targets, 'illustration:animation-settings');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'illustration.animation.keyframe.upsert':
      add(targets, `illustration:keyframe:${operation.keyframe.id}`);
      if (!illustrationDocument?.animation.keyframes[operation.keyframe.id]) add(targets, 'illustration:keyframe-order');
      return;
    case 'illustration.animation.keyframe.delete':
      add(targets, `illustration:keyframe:${operation.keyframeId}`);
      add(targets, 'illustration:keyframe-order');
      return;
    case 'pixel.palette.replace':
      add(targets, 'pixel:palette');
      for (const asset of Object.values(pixelDocument?.pixelAssets ?? {})) if (asset.type === 'sprite') add(targets, `pixel:asset:${asset.id}`);
      return;
    case 'pixel.palette.reorder':
      add(targets, 'pixel:palette');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'pixel.palette-cycles.replace':
      add(targets, 'pixel:palette-cycles');
      return;
    case 'pixel.stamps.replace':
      add(targets, 'pixel:stamps');
      return;
    case 'pixel.tile-stamps.replace':
      add(targets, 'pixel:tile-stamps');
      return;
    case 'pixel.bitmap-fonts.replace':
      add(targets, 'pixel:bitmap-fonts');
      return;
    case 'pixel.conversion.replace':
      add(targets, 'pixel:conversion-defaults');
      return;
    case 'pixel.links.replace':
      add(targets, 'pixel:linked-assets');
      add(targets, DOCUMENT_REVISION_HISTORY_TARGET);
      return;
    case 'pixel.active-asset.set':
      add(targets, 'pixel:active-asset');
      return;
    case 'pixel.frame.add':
      add(targets, `pixel:asset:${operation.spriteId}`);
      add(targets, `pixel:asset:${operation.spriteId}:frame-order`);
      add(targets, `pixel:asset:${operation.spriteId}:frame:${operation.frame.id}`);
      for (const cel of operation.cels) add(targets, `pixel:asset:${operation.spriteId}:cel:${cel.id}`);
      return;
    case 'pixel.frame.replace':
      add(targets, `pixel:asset:${operation.spriteId}:frame:${operation.frame.id}`);
      return;
    case 'pixel.frame.delete': {
      add(targets, `pixel:asset:${operation.spriteId}`);
      add(targets, `pixel:asset:${operation.spriteId}:frame-order`);
      add(targets, `pixel:asset:${operation.spriteId}:frame:${operation.frameId}`);
      const sprite = pixelDocument?.pixelAssets[operation.spriteId];
      if (sprite?.type === 'sprite') for (const cel of Object.values(sprite.cels)) if (cel.frameId === operation.frameId) add(targets, `pixel:asset:${sprite.id}:cel:${cel.id}`);
      return;
    }
    case 'pixel.asset.add':
      add(targets, `pixel:asset:${operation.asset.id}`);
      add(targets, 'pixel:asset-order');
      add(targets, 'pixel:active-asset');
      return;
    case 'pixel.asset.replace':
      add(targets, `pixel:asset:${operation.asset.id}`);
      return;
    case 'pixel.asset.delete':
      add(targets, `pixel:asset:${operation.assetId}`);
      add(targets, 'pixel:asset-order');
      add(targets, 'pixel:active-asset');
      return;
    case 'pixel.cel.set':
    case 'pixel.cel.region':
      add(targets, `pixel:asset:${operation.spriteId}:cel:${operation.celId}`);
      return;
    case 'pixel.tilemap.set':
    case 'pixel.tilemap.region':
      add(targets, `pixel:asset:${operation.mapId}:layer:${operation.layerId}`);
      return;
  }
  const exhaustive: never = operation;
  throw new Error(`Unsupported history operation: ${JSON.stringify(exhaustive)}`);
}

export function historyTargetsForTransaction(document: AIDrawDocument, transaction: CanvasTransaction): Set<string> {
  const targets = new Set<string>();
  for (const operation of transaction.operations) addOperationTargets(document, operation, targets);
  return targets;
}

export function committedHistoryTargets(
  before: AIDrawDocument,
  transaction: CanvasTransaction,
  after: AIDrawDocument,
  inverse: CanvasTransaction,
): string[] {
  const targets = historyTargetsForTransaction(before, transaction);
  for (const target of historyTargetsForTransaction(after, inverse)) targets.add(target);
  return [...targets].sort();
}

export function mutationHistoryTargets(logicalTargets: readonly string[]): Set<string> {
  return new Set([...logicalTargets, DOCUMENT_REVISION_HISTORY_TARGET]);
}

export function historyTargetsIntersect(left: readonly string[], right: ReadonlySet<string>): boolean {
  for (const leftTarget of left) for (const rightTarget of right) {
    if (leftTarget === rightTarget || leftTarget.startsWith(`${rightTarget}:`) || rightTarget.startsWith(`${leftTarget}:`)) return true;
  }
  return false;
}

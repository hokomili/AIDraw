import type {
  ActivityEntry,
  AIDrawDocument,
  EntityBase,
  IllustrationDocument,
  PixelDocument,
  PixelSprite,
  PixelTilemap,
} from './model';
import type { CanvasOperation, CanvasTransaction } from './operations';
import { TransactionConflictError } from './operations';
import { createId, nowIso } from './ids';
import { writePixels, writeTiles } from './pixel';
import { findDocumentAssetReferences } from './references';

export interface ApplyTransactionOptions {
  recordActivity?: boolean;
  status?: ActivityEntry['status'];
}

export interface ApplyTransactionResult {
  document: AIDrawDocument;
  inverse: CanvasTransaction;
}

function assertRevision(entity: EntityBase, expected: number | undefined, operationIndex: number): void {
  if (expected === undefined || entity.revision === expected) return;
  throw new TransactionConflictError({
    operationIndex,
    entityId: entity.id,
    expectedRevision: expected,
    actualRevision: entity.revision,
    message: `Revision conflict for ${entity.name}`,
    retryable: true,
  });
}

function touch(entity: EntityBase, timestamp: string): void {
  entity.revision += 1;
  entity.updatedAt = timestamp;
}

function requireIllustration(document: AIDrawDocument, operationIndex: number): IllustrationDocument {
  if (document.kind === 'illustration') return document;
  throw new TransactionConflictError({
    operationIndex,
    message: 'Illustration operation used on a pixel document',
    retryable: false,
  });
}

function requirePixel(document: AIDrawDocument, operationIndex: number): PixelDocument {
  if (document.kind === 'pixel') return document;
  throw new TransactionConflictError({
    operationIndex,
    message: 'Pixel operation used on an illustration document',
    retryable: false,
  });
}

function findObjectParentGroup(document: IllustrationDocument, objectId: string) {
  for (const candidate of Object.values(document.objects)) {
    if (candidate.type !== 'group') continue;
    const index = candidate.childIds.indexOf(objectId);
    if (index >= 0) return { group: candidate, index };
  }
  return undefined;
}

function groupContainsObject(
  document: IllustrationDocument,
  groupId: string,
  objectId: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(groupId)) return false;
  visited.add(groupId);
  const group = document.objects[groupId];
  if (!group || group.type !== 'group') return false;
  if (group.childIds.includes(objectId)) return true;
  return group.childIds.some((childId) => groupContainsObject(document, childId, objectId, visited));
}

function removeObjectFromGroups(document: IllustrationDocument, objectId: string, timestamp: string): void {
  for (const candidate of Object.values(document.objects)) {
    if (candidate.type !== 'group' || !candidate.childIds.includes(objectId)) continue;
    candidate.childIds = candidate.childIds.filter((id) => id !== objectId);
    touch(candidate, timestamp);
  }
}

function applyOperation(
  document: AIDrawDocument,
  operation: CanvasOperation,
  operationIndex: number,
  timestamp: string,
): CanvasOperation {
  switch (operation.kind) {
    case 'document.rename': {
      const previous = document.name;
      document.name = operation.name.trim() || previous;
      return { kind: 'document.rename', name: previous };
    }
    case 'asset.add': {
      if (document.assets[operation.asset.id]) {
        throw new TransactionConflictError({
          operationIndex,
          entityId: operation.asset.id,
          message: `Asset ${operation.asset.id} already exists`,
          retryable: false,
        });
      }
      document.assets[operation.asset.id] = structuredClone(operation.asset);
      return { kind: 'asset.delete', assetId: operation.asset.id };
    }
    case 'asset.delete': {
      const asset = document.assets[operation.assetId];
      if (!asset) {
        throw new TransactionConflictError({
          operationIndex,
          entityId: operation.assetId,
          message: `Asset ${operation.assetId} does not exist`,
          retryable: true,
        });
      }
      const references = findDocumentAssetReferences(document, operation.assetId);
      if (references.length > 0) {
        const preview = references.slice(0, 4).join(', ');
        const remainder = references.length > 4 ? ` and ${references.length - 4} more` : '';
        throw new TransactionConflictError({
          operationIndex,
          entityId: operation.assetId,
          message: `Asset ${operation.assetId} is still referenced by ${preview}${remainder}. Remove those references first or submit an explicit ordered cascade.`,
          retryable: true,
        });
      }
      delete document.assets[operation.assetId];
      return { kind: 'asset.add', asset: structuredClone(asset) };
    }
    case 'provenance.add': {
      if (document.provenance.some((entry) => entry.id === operation.provenance.id)) {
        throw new Error(`Provenance ${operation.provenance.id} already exists`);
      }
      const referencedAssetIds = [
        operation.provenance.assetId,
        ...operation.provenance.sourceAssetIds,
        ...(operation.provenance.maskAssetId ? [operation.provenance.maskAssetId] : []),
      ];
      const missingAssetId = referencedAssetIds.find((assetId) => !document.assets[assetId]);
      if (missingAssetId) throw new Error(`Provenance references missing asset ${missingAssetId}`);
      document.provenance.push(structuredClone(operation.provenance));
      return { kind: 'provenance.delete', provenanceId: operation.provenance.id };
    }
    case 'provenance.delete': {
      const index = document.provenance.findIndex((entry) => entry.id === operation.provenanceId);
      if (index < 0) throw new Error(`Provenance ${operation.provenanceId} does not exist`);
      const [provenance] = document.provenance.splice(index, 1);
      return { kind: 'provenance.add', provenance };
    }
    case 'illustration.layer.add': {
      const illustration = requireIllustration(document, operationIndex);
      if (illustration.layers[operation.layer.id]) {
        throw new TransactionConflictError({
          operationIndex,
          entityId: operation.layer.id,
          message: `Layer ${operation.layer.id} already exists`,
          retryable: false,
        });
      }
      illustration.layers[operation.layer.id] = structuredClone(operation.layer);
      const parent = operation.layer.parentId ? illustration.layers[operation.layer.parentId] : undefined;
      if (operation.layer.parentId && (!parent || parent.type !== 'group')) throw new Error('Layer parent must be a group layer');
      const siblings = parent?.type === 'group' ? parent.childIds : illustration.layerIds;
      const index = Math.max(0, Math.min(operation.index ?? siblings.length, siblings.length));
      siblings.splice(index, 0, operation.layer.id); if (parent?.type === 'group') touch(parent, timestamp);
      return {
        kind: 'illustration.layer.delete',
        layerId: operation.layer.id,
        expectedRevision: operation.layer.revision,
      };
    }
    case 'illustration.layer.replace': {
      const illustration = requireIllustration(document, operationIndex);
      const current = illustration.layers[operation.layer.id];
      if (!current) throw new Error(`Layer ${operation.layer.id} does not exist`);
      assertRevision(current, operation.expectedRevision, operationIndex);
      const previous = structuredClone(current);
      illustration.layers[operation.layer.id] = structuredClone(operation.layer);
      touch(illustration.layers[operation.layer.id], timestamp);
      return {
        kind: 'illustration.layer.replace',
        layer: previous,
        expectedRevision: illustration.layers[operation.layer.id].revision,
      };
    }
    case 'illustration.layer.move': {
      const illustration = requireIllustration(document, operationIndex); const layer = illustration.layers[operation.layerId];
      if (!layer) throw new Error(`Layer ${operation.layerId} does not exist`); assertRevision(layer, operation.expectedRevision, operationIndex);
      if (operation.parentId === layer.id) throw new Error('A layer cannot parent itself');
      const target = operation.parentId ? illustration.layers[operation.parentId] : undefined;
      if (operation.parentId && (!target || target.type !== 'group')) throw new Error('Layer parent must be a group layer');
      for (let ancestor = target; ancestor; ancestor = ancestor.parentId ? illustration.layers[ancestor.parentId] : undefined) if (ancestor.id === layer.id) throw new Error('Layer grouping cannot create a cycle');
      const previousParentId = layer.parentId; const previousParent = previousParentId ? illustration.layers[previousParentId] : undefined; const previousSiblings = previousParent?.type === 'group' ? previousParent.childIds : illustration.layerIds; const previousIndex = previousSiblings.indexOf(layer.id);
      if (previousIndex >= 0) previousSiblings.splice(previousIndex, 1); if (previousParent?.type === 'group') touch(previousParent, timestamp);
      const targetSiblings = target?.type === 'group' ? target.childIds : illustration.layerIds; const index = Math.max(0, Math.min(operation.index ?? targetSiblings.length, targetSiblings.length)); targetSiblings.splice(index, 0, layer.id); layer.parentId = operation.parentId; touch(layer, timestamp); if (target?.type === 'group') touch(target, timestamp);
      return { kind: 'illustration.layer.move', layerId: layer.id, parentId: previousParentId, index: previousIndex, expectedRevision: layer.revision };
    }
    case 'illustration.layer.delete': {
      const illustration = requireIllustration(document, operationIndex);
      const layer = illustration.layers[operation.layerId];
      if (!layer) throw new Error(`Layer ${operation.layerId} does not exist`);
      assertRevision(layer, operation.expectedRevision, operationIndex);
      const index = illustration.layerIds.indexOf(layer.id);
      if (layer.type === 'vector' && layer.objectIds.length > 0) {
        throw new TransactionConflictError({
          operationIndex,
          entityId: layer.id,
          message: 'Move or delete objects before deleting a non-empty vector layer',
          retryable: true,
        });
      }
      if (layer.type === 'group' && layer.childIds.length > 0) throw new TransactionConflictError({ operationIndex, entityId: layer.id, message: 'Move or delete child layers before deleting a non-empty group', retryable: true });
      const parent = layer.parentId ? illustration.layers[layer.parentId] : undefined; const siblings = parent?.type === 'group' ? parent.childIds : illustration.layerIds; const siblingIndex = siblings.indexOf(layer.id);
      delete illustration.layers[layer.id];
      if (parent?.type === 'group') { parent.childIds = parent.childIds.filter((id) => id !== layer.id); touch(parent, timestamp); } else illustration.layerIds = illustration.layerIds.filter((id) => id !== layer.id);
      return { kind: 'illustration.layer.add', layer: structuredClone(layer), index: siblingIndex >= 0 ? siblingIndex : index };
    }
    case 'illustration.object.add': {
      const illustration = requireIllustration(document, operationIndex);
      if (illustration.objects[operation.object.id]) throw new Error(`Object ${operation.object.id} already exists`);
      const layer = illustration.layers[operation.object.layerId];
      if (!layer || layer.type !== 'vector') throw new Error('Objects must be added to a vector layer');
      illustration.objects[operation.object.id] = structuredClone(operation.object);
      const index = Math.max(0, Math.min(operation.index ?? layer.objectIds.length, layer.objectIds.length));
      layer.objectIds.splice(index, 0, operation.object.id);
      touch(layer, timestamp);
      if (operation.parentGroupId) {
        const parent = illustration.objects[operation.parentGroupId];
        if (!parent || parent.type !== 'group' || parent.layerId !== layer.id) throw new Error('Object parent must be a group in the same vector layer');
        if (parent.id === operation.object.id || groupContainsObject(illustration, operation.object.id, parent.id)) throw new Error('Object grouping cannot create a cycle');
        const groupIndex = Math.max(0, Math.min(operation.groupIndex ?? parent.childIds.length, parent.childIds.length));
        parent.childIds.splice(groupIndex, 0, operation.object.id);
        touch(parent, timestamp);
      }
      return {
        kind: 'illustration.object.delete',
        objectId: operation.object.id,
        expectedRevision: operation.object.revision,
      };
    }
    case 'illustration.object.replace': {
      const illustration = requireIllustration(document, operationIndex);
      const current = illustration.objects[operation.object.id];
      if (!current) throw new Error(`Object ${operation.object.id} does not exist`);
      assertRevision(current, operation.expectedRevision, operationIndex);
      const previous = structuredClone(current);
      if (current.layerId !== operation.object.layerId) {
        const oldLayer = illustration.layers[current.layerId];
        const newLayer = illustration.layers[operation.object.layerId];
        if (!oldLayer || oldLayer.type !== 'vector' || !newLayer || newLayer.type !== 'vector') {
          throw new Error('Object layer move requires vector layers');
        }
        oldLayer.objectIds = oldLayer.objectIds.filter((id) => id !== current.id);
        newLayer.objectIds.push(current.id);
        removeObjectFromGroups(illustration, current.id, timestamp);
        touch(oldLayer, timestamp);
        touch(newLayer, timestamp);
      }
      illustration.objects[current.id] = structuredClone(operation.object);
      touch(illustration.objects[current.id], timestamp);
      return {
        kind: 'illustration.object.replace',
        object: previous,
        expectedRevision: illustration.objects[current.id].revision,
      };
    }
    case 'illustration.object.move': {
      const illustration = requireIllustration(document, operationIndex);
      const object = illustration.objects[operation.objectId];
      if (!object) throw new Error(`Object ${operation.objectId} does not exist`);
      assertRevision(object, operation.expectedRevision, operationIndex);
      const previousLayer = illustration.layers[object.layerId];
      const targetLayer = illustration.layers[operation.layerId];
      if (!previousLayer || previousLayer.type !== 'vector' || !targetLayer || targetLayer.type !== 'vector') throw new Error('Object moves require vector layers');
      if (object.type === 'group' && object.childIds.length > 0 && previousLayer.id !== targetLayer.id) throw new Error('Move a non-empty object group within its current vector layer');
      const targetParent = operation.parentGroupId ? illustration.objects[operation.parentGroupId] : undefined;
      if (operation.parentGroupId && (!targetParent || targetParent.type !== 'group' || targetParent.layerId !== targetLayer.id)) throw new Error('Object parent must be a group in the target vector layer');
      if (targetParent && (targetParent.id === object.id || groupContainsObject(illustration, object.id, targetParent.id))) throw new Error('Object grouping cannot create a cycle');

      const previousIndex = previousLayer.objectIds.indexOf(object.id);
      const previousParent = findObjectParentGroup(illustration, object.id);
      previousLayer.objectIds = previousLayer.objectIds.filter((id) => id !== object.id);
      removeObjectFromGroups(illustration, object.id, timestamp);
      const index = Math.max(0, Math.min(operation.index ?? targetLayer.objectIds.length, targetLayer.objectIds.length));
      targetLayer.objectIds.splice(index, 0, object.id);
      if (targetParent?.type === 'group') {
        const groupIndex = Math.max(0, Math.min(operation.groupIndex ?? targetParent.childIds.length, targetParent.childIds.length));
        targetParent.childIds.splice(groupIndex, 0, object.id);
        touch(targetParent, timestamp);
      }
      if (previousLayer.id === targetLayer.id) touch(targetLayer, timestamp);
      else {
        touch(previousLayer, timestamp);
        touch(targetLayer, timestamp);
      }
      object.layerId = targetLayer.id;
      touch(object, timestamp);
      return {
        kind: 'illustration.object.move',
        objectId: object.id,
        layerId: previousLayer.id,
        index: previousIndex,
        parentGroupId: previousParent?.group.id,
        groupIndex: previousParent?.index,
        expectedRevision: object.revision,
      };
    }
    case 'illustration.object.delete': {
      const illustration = requireIllustration(document, operationIndex);
      const object = illustration.objects[operation.objectId];
      if (!object) throw new Error(`Object ${operation.objectId} does not exist`);
      assertRevision(object, operation.expectedRevision, operationIndex);
      const layer = illustration.layers[object.layerId];
      if (!layer || layer.type !== 'vector') throw new Error('Object layer does not exist');
      const index = layer.objectIds.indexOf(object.id);
      const parent = findObjectParentGroup(illustration, object.id);
      delete illustration.objects[object.id];
      layer.objectIds = layer.objectIds.filter((id) => id !== object.id);
      removeObjectFromGroups(illustration, object.id, timestamp);
      touch(layer, timestamp);
      return { kind: 'illustration.object.add', object: structuredClone(object), index, parentGroupId: parent?.group.id, groupIndex: parent?.index };
    }
    case 'illustration.paint.stroke': {
      const illustration = requireIllustration(document, operationIndex);
      const layer = illustration.layers[operation.layerId];
      if (!layer || layer.type !== 'paint') throw new Error('Paint stroke requires a paint layer');
      assertRevision(layer, operation.expectedRevision, operationIndex);
      layer.strokes.push(structuredClone(operation.stroke));
      touch(layer, timestamp);
      const previousLayer = structuredClone(layer);
      previousLayer.strokes = previousLayer.strokes.filter((stroke) => stroke.id !== operation.stroke.id);
      previousLayer.revision = layer.revision - 1;
      return {
        kind: 'illustration.layer.replace',
        layer: previousLayer,
        expectedRevision: layer.revision,
      };
    }
    case 'pixel.palette.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.palette);
      if (operation.palette.length === 0 || operation.palette.length > 256) {
        throw new Error('Pixel palettes must contain between 1 and 256 entries');
      }
      pixel.palette = structuredClone(operation.palette);
      return { kind: 'pixel.palette.replace', palette: previous };
    }
    case 'pixel.conversion.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.conversionDefaults);
      pixel.conversionDefaults = structuredClone(operation.conversionDefaults);
      return { kind: 'pixel.conversion.replace', conversionDefaults: previous };
    }
    case 'pixel.links.replace': {
      const pixel = requirePixel(document, operationIndex); const previous = structuredClone(pixel.linkedAssets);
      pixel.linkedAssets = structuredClone(operation.linkedAssets); return { kind: 'pixel.links.replace', linkedAssets: previous };
    }
    case 'pixel.active-asset.set': {
      const pixel = requirePixel(document, operationIndex);
      if (!pixel.pixelAssets[operation.assetId]) throw new Error(`Pixel asset ${operation.assetId} does not exist`);
      const previous = pixel.activeAssetId;
      pixel.activeAssetId = operation.assetId;
      return { kind: 'pixel.active-asset.set', assetId: previous };
    }
    case 'pixel.frame.add': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Frame additions require a sprite');
      assertRevision(sprite, operation.expectedRevision, operationIndex);
      if (sprite.frames[operation.frame.id]) throw new Error(`Frame ${operation.frame.id} already exists`);
      sprite.frames[operation.frame.id] = structuredClone(operation.frame);
      const index = Math.max(0, Math.min(operation.index ?? sprite.frameIds.length, sprite.frameIds.length));
      sprite.frameIds.splice(index, 0, operation.frame.id);
      for (const cel of operation.cels) {
        if (cel.frameId !== operation.frame.id) throw new Error('New cels must belong to the new frame');
        if (!sprite.layers[cel.layerId]) throw new Error(`Cel layer ${cel.layerId} does not exist`);
        sprite.cels[cel.id] = structuredClone(cel);
      }
      touch(sprite, timestamp);
      return { kind: 'pixel.frame.delete', spriteId: sprite.id, frameId: operation.frame.id, expectedRevision: sprite.revision };
    }
    case 'pixel.frame.replace': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Frame updates require a sprite');
      const current = sprite.frames[operation.frame.id];
      if (!current) throw new Error(`Frame ${operation.frame.id} does not exist`);
      assertRevision(current, operation.expectedRevision, operationIndex);
      const previous = structuredClone(current);
      sprite.frames[current.id] = structuredClone(operation.frame);
      touch(sprite.frames[current.id], timestamp);
      touch(sprite, timestamp);
      return { kind: 'pixel.frame.replace', spriteId: sprite.id, frame: previous, expectedRevision: sprite.frames[current.id].revision };
    }
    case 'pixel.frame.delete': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Frame deletion requires a sprite');
      assertRevision(sprite, operation.expectedRevision, operationIndex);
      if (sprite.frameIds.length <= 1) throw new Error('A sprite must retain at least one frame');
      const frame = sprite.frames[operation.frameId];
      if (!frame) throw new Error(`Frame ${operation.frameId} does not exist`);
      const index = sprite.frameIds.indexOf(frame.id);
      const cels = Object.values(sprite.cels).filter((cel) => cel.frameId === frame.id).map((cel) => structuredClone(cel));
      for (const cel of cels) delete sprite.cels[cel.id];
      delete sprite.frames[frame.id];
      sprite.frameIds.splice(index, 1);
      sprite.tags = sprite.tags.flatMap((tag) => {
        if (tag.fromFrameId === frame.id && tag.toFrameId === frame.id) return [];
        return [{ ...tag, fromFrameId: tag.fromFrameId === frame.id ? sprite.frameIds[Math.max(0, index - 1)] : tag.fromFrameId, toFrameId: tag.toFrameId === frame.id ? sprite.frameIds[Math.min(sprite.frameIds.length - 1, index)] : tag.toFrameId }];
      });
      touch(sprite, timestamp);
      return { kind: 'pixel.frame.add', spriteId: sprite.id, frame: structuredClone(frame), cels, index, expectedRevision: sprite.revision };
    }
    case 'pixel.asset.add': {
      const pixel = requirePixel(document, operationIndex);
      if (pixel.pixelAssets[operation.asset.id]) throw new Error(`Pixel asset ${operation.asset.id} already exists`);
      pixel.pixelAssets[operation.asset.id] = structuredClone(operation.asset);
      const index = Math.max(0, Math.min(operation.index ?? pixel.assetIds.length, pixel.assetIds.length));
      pixel.assetIds.splice(index, 0, operation.asset.id);
      return { kind: 'pixel.asset.delete', assetId: operation.asset.id, expectedRevision: operation.asset.revision };
    }
    case 'pixel.asset.replace': {
      const pixel = requirePixel(document, operationIndex);
      const current = pixel.pixelAssets[operation.asset.id];
      if (!current) throw new Error(`Pixel asset ${operation.asset.id} does not exist`);
      assertRevision(current, operation.expectedRevision, operationIndex);
      const previous = structuredClone(current);
      pixel.pixelAssets[current.id] = structuredClone(operation.asset);
      touch(pixel.pixelAssets[current.id], timestamp);
      return {
        kind: 'pixel.asset.replace',
        asset: previous,
        expectedRevision: pixel.pixelAssets[current.id].revision,
      };
    }
    case 'pixel.asset.delete': {
      const pixel = requirePixel(document, operationIndex);
      const asset = pixel.pixelAssets[operation.assetId];
      if (!asset) throw new Error(`Pixel asset ${operation.assetId} does not exist`);
      assertRevision(asset, operation.expectedRevision, operationIndex);
      if (pixel.assetIds.length === 1) throw new Error('A pixel document must retain at least one asset');
      const index = pixel.assetIds.indexOf(asset.id);
      delete pixel.pixelAssets[asset.id];
      pixel.assetIds = pixel.assetIds.filter((id) => id !== asset.id);
      if (pixel.activeAssetId === asset.id) pixel.activeAssetId = pixel.assetIds[0];
      return { kind: 'pixel.asset.add', asset: structuredClone(asset), index };
    }
    case 'pixel.cel.set': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Pixel changes require a sprite');
      const cel = sprite.cels[operation.celId];
      if (!cel) throw new Error(`Cel ${operation.celId} does not exist`);
      assertRevision(cel, operation.expectedRevision, operationIndex);
      const inverse = writePixels(cel, operation.changes);
      touch(cel, timestamp);
      touch(sprite, timestamp);
      return {
        kind: 'pixel.cel.set',
        spriteId: sprite.id,
        celId: cel.id,
        changes: inverse,
        expectedRevision: cel.revision,
      };
    }
    case 'pixel.tilemap.set': {
      const pixel = requirePixel(document, operationIndex);
      const map = pixel.pixelAssets[operation.mapId] as PixelTilemap | undefined;
      if (!map || map.type !== 'tilemap') throw new Error('Tile changes require a tilemap');
      const layer = map.layers[operation.layerId];
      if (!layer || layer.type !== 'tile' || !layer.chunks) throw new Error('Tile changes require a tile layer');
      assertRevision(layer, operation.expectedRevision, operationIndex);
      const inverse = writeTiles(layer.chunks, operation.changes);
      touch(layer, timestamp);
      touch(map, timestamp);
      return {
        kind: 'pixel.tilemap.set',
        mapId: map.id,
        layerId: layer.id,
        changes: inverse,
        expectedRevision: layer.revision,
      };
    }
  }
}

export function applyTransaction(
  source: AIDrawDocument,
  transaction: CanvasTransaction,
  options: ApplyTransactionOptions = {},
): ApplyTransactionResult {
  if (source.id !== transaction.documentId) throw new Error('Transaction document ID does not match');
  const document = structuredClone(source);
  const timestamp = nowIso();
  const inverseOperations: CanvasOperation[] = [];

  for (let index = 0; index < transaction.operations.length; index += 1) {
    const inverse = applyOperation(document, transaction.operations[index], index, timestamp);
    inverseOperations.unshift(inverse);
  }

  document.revision += 1;
  document.updatedAt = timestamp;
  document.dirty = true;
  if (options.recordActivity !== false) {
    document.activity.push({
      id: createId('activity'),
      transactionId: transaction.id,
      actor: structuredClone(transaction.actor),
      label: transaction.label,
      timestamp,
      status: options.status ?? 'committed',
      operationCount: transaction.operations.length,
    });
  }

  return {
    document,
    inverse: {
      id: createId('tx'),
      clientOperationId: `inverse:${transaction.clientOperationId}:${document.revision}`,
      documentId: document.id,
      actor: structuredClone(transaction.actor),
      label: `Undo ${transaction.label}`,
      createdAt: timestamp,
      operations: inverseOperations,
      playback: { mode: 'instant', speed: 1 },
    },
  };
}

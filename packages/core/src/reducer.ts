import type {
  ActivityEntry,
  AIDrawDocument,
  EntityBase,
  IllustrationDocument,
  IllustrationLayer,
  PixelDocument,
  PixelSprite,
  PixelTilemap,
} from './model';
import type { CanvasOperation, CanvasTransaction, PixelSpriteDependencyGuard } from './operations';
import { TransactionConflictError } from './operations';
import { createId, nowIso } from './ids';
import { assertImageCollectionTilemapModes, remapPixelCelIndices, writePixelRuns, writePixels, writeTileRuns, writeTiles } from './pixel';
import { findDocumentAssetReferences } from './references';
import { resolvePixelCel } from './animation';
import {
  assertPaletteIndicesExist,
  assertPixelCelsUsePalette,
  assertPixelSpriteUsesPalette,
  assertPixelStampsUsePalette,
  countPaletteIndexUsage,
} from './palette';

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

function assertSpriteDependencies(
  document: PixelDocument,
  dependencies: PixelSpriteDependencyGuard[] | undefined,
  operationIndex: number,
): void {
  for (const dependency of dependencies ?? []) {
    const current = document.pixelAssets[dependency.spriteId];
    if (current?.type === 'sprite'
      && current.revision === dependency.expectedRevision
      && current.width === dependency.width
      && current.height === dependency.height) continue;
    throw new TransactionConflictError({
      operationIndex,
      entityId: dependency.spriteId,
      expectedRevision: dependency.expectedRevision,
      actualRevision: current?.revision,
      message: 'A referenced source sprite changed before the asset replacement',
      retryable: true,
    });
  }
}

function touch(entity: EntityBase, timestamp: string): void {
  entity.revision += 1;
  entity.updatedAt = timestamp;
}

function paintCachePrefixMatches(current: Extract<IllustrationLayer, { type: 'paint' }>, incoming: Extract<IllustrationLayer, { type: 'paint' }>): boolean {
  const count = current.tileCache?.strokeCount;
  return count !== undefined
    && Number.isInteger(count)
    && count >= 0
    && count <= current.strokes.length
    && count <= incoming.strokes.length
    && JSON.stringify(current.strokes.slice(0, count)) === JSON.stringify(incoming.strokes.slice(0, count));
}

function sanitizePaintCache(incoming: IllustrationLayer, current?: IllustrationLayer): IllustrationLayer {
  const next = structuredClone(incoming);
  if (next.type !== 'paint') return next;
  if (current?.type === 'paint' && current.tileCache && paintCachePrefixMatches(current, next)) {
    next.tileAssetIds = structuredClone(current.tileAssetIds);
    next.tileCache = structuredClone(current.tileCache);
  } else {
    next.tileAssetIds = {};
    delete next.tileCache;
  }
  return next;
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

function assertSpriteCoordinates(sprite: PixelSprite, cells: Array<{ x: number; y: number; length?: number }>): void {
  const invalid = cells.find((cell) => cell.x < 0 || cell.y < 0 || cell.y >= sprite.height || cell.x + (cell.length ?? 1) > sprite.width);
  if (invalid) throw new Error(`Pixel write at ${invalid.x},${invalid.y} is outside sprite ${sprite.width}×${sprite.height}`);
}

function assertTileCoordinates(map: PixelTilemap, cells: Array<{ x: number; y: number; length?: number }>): void {
  if (map.infinite) return;
  const invalid = cells.find((cell) => cell.x < 0 || cell.y < 0 || cell.y >= map.height || cell.x + (cell.length ?? 1) > map.width);
  if (invalid) throw new Error(`Tile write at ${invalid.x},${invalid.y} is outside finite map ${map.width}×${map.height}`);
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

function sameOrderedIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function applyOperation(
  document: AIDrawDocument,
  operation: CanvasOperation,
  operationIndex: number,
  timestamp: string,
): CanvasOperation | CanvasOperation[] {
  switch (operation.kind) {
    case 'document.rename': {
      const previous = document.name;
      document.name = operation.name.trim() || previous;
      return { kind: 'document.rename', name: previous };
    }
    case 'illustration.artboard.replace': {
      const illustration = requireIllustration(document, operationIndex);
      if (operation.expectedRevision !== undefined && illustration.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: illustration.id, expectedRevision: operation.expectedRevision, actualRevision: illustration.revision, message: 'Illustration revision changed before the artboard update', retryable: true });
      const previous = structuredClone(illustration.artboard);
      illustration.artboard = structuredClone(operation.artboard);
      return { kind: 'illustration.artboard.replace', artboard: previous };
    }
    case 'illustration.artboard.translate': {
      const illustration = requireIllustration(document, operationIndex);
      if (operation.expectedRevision !== undefined && illustration.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: illustration.id, expectedRevision: operation.expectedRevision, actualRevision: illustration.revision, message: 'Illustration revision changed before the translated artboard update', retryable: true });
      const previous = structuredClone(illustration.artboard); const childIds = new Set(Object.values(illustration.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
      illustration.artboard = structuredClone(operation.artboard);
      for (const object of Object.values(illustration.objects)) if (!childIds.has(object.id)) { object.transform.x += operation.offsetX; object.transform.y += operation.offsetY; touch(object, timestamp); }
      for (const layer of Object.values(illustration.layers)) if (layer.type === 'paint') {
        for (const stroke of layer.strokes) for (const point of stroke.points) { point.x += operation.offsetX; point.y += operation.offsetY; }
        layer.tileAssetIds = {}; delete layer.tileCache; touch(layer, timestamp);
      }
      for (const guide of illustration.guides) guide.position += guide.orientation === 'vertical' ? operation.offsetX : operation.offsetY;
      for (const keyframe of Object.values(illustration.animation.keyframes)) if (!childIds.has(keyframe.objectId)) { keyframe.transform.x += operation.offsetX; keyframe.transform.y += operation.offsetY; touch(keyframe, timestamp); }
      return { kind: 'illustration.artboard.translate', artboard: previous, offsetX: -operation.offsetX, offsetY: -operation.offsetY };
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
      const index = Math.max(0, Math.min(operation.index ?? document.provenance.length, document.provenance.length));
      document.provenance.splice(index, 0, structuredClone(operation.provenance));
      return { kind: 'provenance.delete', provenanceId: operation.provenance.id };
    }
    case 'provenance.delete': {
      const index = document.provenance.findIndex((entry) => entry.id === operation.provenanceId);
      if (index < 0) throw new Error(`Provenance ${operation.provenanceId} does not exist`);
      const [provenance] = document.provenance.splice(index, 1);
      return { kind: 'provenance.add', provenance, index };
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
      if (operation.layer.type === 'group' && operation.layer.childIds.length > 0) throw new Error('Use illustration.layer.move after adding an empty group layer');
      if (operation.layer.type === 'vector' && operation.layer.objectIds.length > 0) throw new Error('Use object add or move operations after adding an empty vector layer');
      illustration.layers[operation.layer.id] = sanitizePaintCache(operation.layer);
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
      if (current.type !== operation.layer.type) throw new Error('A layer replacement cannot change the layer type');
      if (current.parentId !== operation.layer.parentId) throw new Error('Use illustration.layer.move to change layer parentage');
      if (current.type === 'vector' && operation.layer.type === 'vector' && !sameOrderedIds(current.objectIds, operation.layer.objectIds)) throw new Error('Use object add, move, or delete operations to change vector-layer membership');
      if (current.type === 'group' && operation.layer.type === 'group' && !sameOrderedIds(current.childIds, operation.layer.childIds)) throw new Error('Use illustration.layer.move to change group-layer membership');
      if (operation.layer.maskLayerId) {
        const mask = illustration.layers[operation.layer.maskLayerId];
        if (!mask || mask.type !== 'vector' || mask.id === operation.layer.id) throw new Error('A clipping mask must reference another vector layer');
      }
      const previous = structuredClone(current);
      illustration.layers[operation.layer.id] = sanitizePaintCache(operation.layer, current);
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
      const dependent = Object.values(illustration.layers).find((entry) => entry.maskLayerId === layer.id);
      if (dependent) throw new TransactionConflictError({ operationIndex, entityId: layer.id, message: `Clear the clipping mask from ${dependent.name} before deleting ${layer.name}`, retryable: true });
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
      if (operation.object.maskObjectId) {
        const mask = illustration.objects[operation.object.maskObjectId];
        if (!mask || mask.id === operation.object.id || mask.layerId !== operation.object.layerId || !['shape', 'path', 'vector-stroke'].includes(mask.type)) throw new Error('An object mask must reference another path-capable object in the same vector layer');
      }
      if (operation.object.type === 'group') {
        if (new Set(operation.object.childIds).size !== operation.object.childIds.length) throw new Error('Object group members must be unique');
        for (const childId of operation.object.childIds) {
          const child = illustration.objects[childId];
          if (!child || child.layerId !== layer.id) throw new Error('Object group members must already exist in the same vector layer');
          if (child.id === operation.object.id || groupContainsObject(illustration, child.id, operation.object.id)) throw new Error('Object grouping cannot create a cycle');
          if (findObjectParentGroup(illustration, child.id)) throw new Error(`Object ${child.name} already belongs to a group`);
        }
      }
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
      if (current.layerId !== operation.object.layerId) throw new Error('Use illustration.object.move to change an object layer');
      const currentChildIds = current.type === 'group' ? current.childIds : [];
      const incomingChildIds = operation.object.type === 'group' ? operation.object.childIds : [];
      if (!sameOrderedIds(currentChildIds, incomingChildIds)) throw new Error('Use illustration.object.move to change object-group membership');
      if (operation.object.maskObjectId) {
        const mask = illustration.objects[operation.object.maskObjectId];
        if (!mask || mask.id === operation.object.id || mask.layerId !== operation.object.layerId || !['shape', 'path', 'vector-stroke'].includes(mask.type)) throw new Error('An object mask must reference another path-capable object in the same vector layer');
      }
      const previous = structuredClone(current);
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
      const dependent = Object.values(illustration.objects).find((entry) => entry.maskObjectId === object.id);
      if (dependent && previousLayer.id !== targetLayer.id) throw new TransactionConflictError({ operationIndex, entityId: object.id, message: `Clear the object mask from ${dependent.name} before moving ${object.name} to another layer`, retryable: true });
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
      const dependent = Object.values(illustration.objects).find((entry) => entry.maskObjectId === object.id);
      if (dependent) throw new TransactionConflictError({ operationIndex, entityId: object.id, message: `Clear the object mask from ${dependent.name} before deleting ${object.name}`, retryable: true });
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
    case 'illustration.brush-presets.replace': {
      const illustration = requireIllustration(document, operationIndex);
      const previous = structuredClone(illustration.brushPresets ?? []);
      illustration.brushPresets = structuredClone(operation.presets);
      return { kind: 'illustration.brush-presets.replace', presets: previous };
    }
    case 'illustration.guides.replace': {
      const illustration = requireIllustration(document, operationIndex);
      if (operation.expectedRevision !== undefined && illustration.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: illustration.id, expectedRevision: operation.expectedRevision, actualRevision: illustration.revision, message: 'Illustration revision changed before the guide update', retryable: true });
      const previous = structuredClone(illustration.guides ?? []); illustration.guides = structuredClone(operation.guides); return { kind: 'illustration.guides.replace', guides: previous };
    }
    case 'illustration.snap-settings.replace': {
      const illustration = requireIllustration(document, operationIndex);
      if (operation.expectedRevision !== undefined && illustration.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: illustration.id, expectedRevision: operation.expectedRevision, actualRevision: illustration.revision, message: 'Illustration revision changed before the snapping update', retryable: true });
      const previous = structuredClone(illustration.snapSettings); illustration.snapSettings = structuredClone(operation.settings); return { kind: 'illustration.snap-settings.replace', settings: previous };
    }
    case 'illustration.animation.settings.replace': {
      const illustration = requireIllustration(document, operationIndex);
      if (operation.expectedRevision !== undefined && illustration.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: illustration.id, expectedRevision: operation.expectedRevision, actualRevision: illustration.revision, message: 'Illustration revision changed before the animation settings update', retryable: true });
      if (Object.values(illustration.animation.keyframes).some((keyframe) => keyframe.timeMs > operation.settings.durationMs)) throw new Error('Shortening the animation would place a keyframe beyond its duration');
      const previous = { durationMs: illustration.animation.durationMs, framesPerSecond: illustration.animation.framesPerSecond, playback: illustration.animation.playback };
      illustration.animation = { ...illustration.animation, ...structuredClone(operation.settings) };
      return { kind: 'illustration.animation.settings.replace', settings: previous };
    }
    case 'illustration.animation.keyframe.upsert': {
      const illustration = requireIllustration(document, operationIndex);
      const incoming = structuredClone(operation.keyframe);
      if (!illustration.objects[incoming.objectId]) throw new Error(`Animation keyframe object ${incoming.objectId} does not exist`);
      if (incoming.timeMs > illustration.animation.durationMs) throw new Error('Animation keyframe time exceeds the animation duration');
      const duplicate = Object.values(illustration.animation.keyframes).find((entry) => entry.id !== incoming.id && entry.objectId === incoming.objectId && entry.timeMs === incoming.timeMs);
      if (duplicate) throw new Error(`Object ${incoming.objectId} already has a keyframe at ${incoming.timeMs} ms`);
      const current = illustration.animation.keyframes[incoming.id];
      if (current) {
        assertRevision(current, operation.expectedRevision, operationIndex);
        const previous = structuredClone(current);
        illustration.animation.keyframes[incoming.id] = incoming;
        touch(illustration.animation.keyframes[incoming.id], timestamp);
        return { kind: 'illustration.animation.keyframe.upsert', keyframe: previous, expectedRevision: illustration.animation.keyframes[incoming.id].revision };
      }
      if (illustration.animation.keyframeIds.length >= 10_000) throw new Error('Illustration animations are limited to 10,000 keyframes');
      illustration.animation.keyframes[incoming.id] = incoming;
      const index = Math.max(0, Math.min(operation.index ?? illustration.animation.keyframeIds.length, illustration.animation.keyframeIds.length));
      illustration.animation.keyframeIds.splice(index, 0, incoming.id);
      return { kind: 'illustration.animation.keyframe.delete', keyframeId: incoming.id, expectedRevision: incoming.revision };
    }
    case 'illustration.animation.keyframe.delete': {
      const illustration = requireIllustration(document, operationIndex);
      const keyframe = illustration.animation.keyframes[operation.keyframeId];
      if (!keyframe) throw new Error(`Animation keyframe ${operation.keyframeId} does not exist`);
      assertRevision(keyframe, operation.expectedRevision, operationIndex);
      const index = illustration.animation.keyframeIds.indexOf(keyframe.id);
      delete illustration.animation.keyframes[keyframe.id];
      illustration.animation.keyframeIds = illustration.animation.keyframeIds.filter((id) => id !== keyframe.id);
      return { kind: 'illustration.animation.keyframe.upsert', keyframe: structuredClone(keyframe), index: Math.max(0, index) };
    }
    case 'pixel.palette.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.palette);
      if (operation.palette.length === 0 || operation.palette.length > 256) {
        throw new Error('Pixel palettes must contain between 1 and 256 entries');
      }
      if (operation.palette[0].color.length !== 9 || !operation.palette[0].color.toLowerCase().endsWith('00')) throw new Error('Palette index 0 must remain transparent');
      if (new Set(operation.palette.map((entry) => entry.id)).size !== operation.palette.length) throw new Error('Palette entry IDs must be unique');
      const previousIds = previous.map((entry) => entry.id); const nextIds = operation.palette.map((entry) => entry.id); const sharedLength = Math.min(previousIds.length, nextIds.length);
      if (previousIds.slice(0, sharedLength).some((id, index) => nextIds[index] !== id)) throw new Error('Palette additions and removals must occur at the end; use palette reorder first');
      if (operation.palette.length < previous.length) for (let index = operation.palette.length; index < previous.length; index += 1) {
        if (countPaletteIndexUsage(pixel, index, 1)) throw new Error(`Palette index ${index} is still used by pixel artwork or a reusable stamp`);
        for (const asset of Object.values(pixel.pixelAssets)) if (asset.type === 'sprite') for (const override of Object.values(asset.paletteOverrides)) if (JSON.stringify(override[index]) !== JSON.stringify(previous[index])) throw new Error(`Palette index ${index} has a frame-specific override; clear or normalize it before deleting the color`);
      }
      if (pixel.paletteCycles.some((cycle) => cycle.toIndex >= operation.palette.length)) throw new Error('The new palette would invalidate a named cycle range');
      pixel.palette = structuredClone(operation.palette);
      for (const asset of Object.values(pixel.pixelAssets)) if (asset.type === 'sprite') for (const [frameId, override] of Object.entries(asset.paletteOverrides)) asset.paletteOverrides[frameId] = operation.palette.map((entry, index) => structuredClone(override[index] ?? entry));
      return { kind: 'pixel.palette.replace', palette: previous };
    }
    case 'pixel.palette.reorder': {
      const pixel = requirePixel(document, operationIndex);
      if (operation.expectedRevision !== undefined && pixel.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: pixel.id, expectedRevision: operation.expectedRevision, actualRevision: pixel.revision, message: 'Pixel document revision changed before the palette reorder', retryable: true });
      const previousIds = pixel.palette.map((entry) => entry.id); const currentIds = new Set(previousIds);
      if (operation.entryIds.length !== previousIds.length || operation.entryIds.some((id) => !currentIds.has(id))) throw new Error('Palette reorder must contain every current palette entry exactly once');
      if (operation.entryIds[0] !== previousIds[0]) throw new Error('Transparent palette index 0 cannot be moved');
      const oldIndex = new Map(previousIds.map((id, index) => [id, index])); const newIndex = new Map(operation.entryIds.map((id, index) => [id, index])); const indexMap = previousIds.map((id) => newIndex.get(id)!);
      pixel.palette = operation.entryIds.map((id) => structuredClone(pixel.palette[oldIndex.get(id)!]));
      pixel.stamps = pixel.stamps.map((stamp) => ({ ...stamp, cells: stamp.cells.map((cell) => ({ ...cell, index: indexMap[cell.index] ?? cell.index })) }));
      for (const asset of Object.values(pixel.pixelAssets)) if (asset.type === 'sprite') {
        for (const cel of Object.values(asset.cels)) remapPixelCelIndices(cel, indexMap);
        for (const [frameId, override] of Object.entries(asset.paletteOverrides)) asset.paletteOverrides[frameId] = operation.entryIds.map((id) => structuredClone(override[oldIndex.get(id)!]));
      }
      return { kind: 'pixel.palette.reorder', entryIds: previousIds };
    }
    case 'pixel.stamps.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.stamps);
      assertPixelStampsUsePalette(operation.stamps, pixel.palette.length);
      pixel.stamps = structuredClone(operation.stamps);
      return { kind: 'pixel.stamps.replace', stamps: previous };
    }
    case 'pixel.tile-stamps.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.tileStamps);
      pixel.tileStamps = structuredClone(operation.stamps);
      return { kind: 'pixel.tile-stamps.replace', stamps: previous };
    }
    case 'pixel.bitmap-fonts.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.bitmapFonts);
      pixel.bitmapFonts = structuredClone(operation.fonts);
      return { kind: 'pixel.bitmap-fonts.replace', fonts: previous };
    }
    case 'pixel.palette-cycles.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.paletteCycles);
      for (const cycle of operation.cycles) if (cycle.toIndex >= pixel.palette.length) throw new Error(`Palette cycle ${cycle.name} exceeds the current palette`);
      pixel.paletteCycles = structuredClone(operation.cycles);
      return { kind: 'pixel.palette-cycles.replace', cycles: previous };
    }
    case 'pixel.conversion.replace': {
      const pixel = requirePixel(document, operationIndex);
      const previous = structuredClone(pixel.conversionDefaults);
      pixel.conversionDefaults = structuredClone(operation.conversionDefaults);
      return { kind: 'pixel.conversion.replace', conversionDefaults: previous };
    }
    case 'pixel.links.replace': {
      const pixel = requirePixel(document, operationIndex); const previous = structuredClone(pixel.linkedAssets);
      if (operation.expectedRevision !== undefined && pixel.revision !== operation.expectedRevision) throw new TransactionConflictError({ operationIndex, entityId: pixel.id, expectedRevision: operation.expectedRevision, actualRevision: pixel.revision, message: 'Pixel document changed before the project-link update', retryable: true });
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
      assertPixelCelsUsePalette(operation.cels, pixel.palette.length, `New frame ${operation.frame.id}`);
      sprite.frames[operation.frame.id] = structuredClone(operation.frame);
      const index = Math.max(0, Math.min(operation.index ?? sprite.frameIds.length, sprite.frameIds.length));
      sprite.frameIds.splice(index, 0, operation.frame.id);
      for (const cel of operation.cels) {
        if (cel.frameId !== operation.frame.id) throw new Error('New cels must belong to the new frame');
        if (!sprite.layers[cel.layerId]) throw new Error(`Cel layer ${cel.layerId} does not exist`);
        sprite.cels[cel.id] = structuredClone(cel);
      }
      for (const cel of operation.cels) if (cel.linkedToCelId && !resolvePixelCel(sprite, cel.id)) throw new Error(`Cel ${cel.id} has a cyclic or missing link`);
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
      const previousSprite = structuredClone(sprite);
      const index = sprite.frameIds.indexOf(frame.id);
      const cels = Object.values(sprite.cels).filter((cel) => cel.frameId === frame.id).map((cel) => structuredClone(cel));
      const removedCelIds = new Set(cels.map((cel) => cel.id));
      for (const cel of Object.values(sprite.cels)) {
        if (removedCelIds.has(cel.id) || !cel.linkedToCelId) continue;
        const resolved = resolvePixelCel(sprite, cel.id);
        if (!resolved) throw new Error(`Cel ${cel.id} has a cyclic or missing link`);
        let cursor: typeof cel | undefined = cel; let dependsOnRemovedCel = false; const visited = new Set<string>();
        while (cursor?.linkedToCelId && !visited.has(cursor.id)) {
          visited.add(cursor.id);
          if (removedCelIds.has(cursor.linkedToCelId)) { dependsOnRemovedCel = true; break; }
          cursor = sprite.cels[cursor.linkedToCelId];
        }
        if (dependsOnRemovedCel) { cel.chunks = structuredClone(resolved.chunks); delete cel.linkedToCelId; touch(cel, timestamp); }
      }
      for (const cel of cels) delete sprite.cels[cel.id];
      delete sprite.frames[frame.id];
      delete sprite.paletteOverrides[frame.id];
      sprite.frameIds.splice(index, 1);
      sprite.tags = sprite.tags.flatMap((tag) => {
        if (tag.fromFrameId === frame.id && tag.toFrameId === frame.id) return [];
        return [{ ...tag, fromFrameId: tag.fromFrameId === frame.id ? sprite.frameIds[Math.max(0, index - 1)] : tag.fromFrameId, toFrameId: tag.toFrameId === frame.id ? sprite.frameIds[Math.min(sprite.frameIds.length - 1, index)] : tag.toFrameId }];
      });
      touch(sprite, timestamp);
      return { kind: 'pixel.asset.replace', asset: previousSprite, expectedRevision: sprite.revision };
    }
    case 'pixel.asset.add': {
      const pixel = requirePixel(document, operationIndex);
      if (pixel.pixelAssets[operation.asset.id]) throw new Error(`Pixel asset ${operation.asset.id} already exists`);
      if (operation.asset.type === 'sprite') assertPixelSpriteUsesPalette(operation.asset, pixel.palette);
      pixel.pixelAssets[operation.asset.id] = structuredClone(operation.asset);
      const index = Math.max(0, Math.min(operation.index ?? pixel.assetIds.length, pixel.assetIds.length));
      pixel.assetIds.splice(index, 0, operation.asset.id);
      assertImageCollectionTilemapModes(pixel);
      return { kind: 'pixel.asset.delete', assetId: operation.asset.id, expectedRevision: operation.asset.revision };
    }
    case 'pixel.asset.replace': {
      const pixel = requirePixel(document, operationIndex);
      const current = pixel.pixelAssets[operation.asset.id];
      if (!current) throw new Error(`Pixel asset ${operation.asset.id} does not exist`);
      assertRevision(current, operation.expectedRevision, operationIndex);
      assertSpriteDependencies(pixel, operation.expectedSpriteDependencies, operationIndex);
      if (operation.asset.type === 'sprite') assertPixelSpriteUsesPalette(operation.asset, pixel.palette);
      const previous = structuredClone(current);
      pixel.pixelAssets[current.id] = structuredClone(operation.asset);
      touch(pixel.pixelAssets[current.id], timestamp);
      assertImageCollectionTilemapModes(pixel);
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
      const wasActive = pixel.activeAssetId === asset.id;
      delete pixel.pixelAssets[asset.id];
      pixel.assetIds = pixel.assetIds.filter((id) => id !== asset.id);
      if (wasActive) pixel.activeAssetId = pixel.assetIds[0];
      const restore: CanvasOperation = { kind: 'pixel.asset.add', asset: structuredClone(asset), index };
      return wasActive ? [restore, { kind: 'pixel.active-asset.set', assetId: asset.id }] : restore;
    }
    case 'pixel.cel.set': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Pixel changes require a sprite');
      const cel = sprite.cels[operation.celId];
      if (!cel) throw new Error(`Cel ${operation.celId} does not exist`);
      assertRevision(cel, operation.expectedRevision, operationIndex);
      assertSpriteCoordinates(sprite, operation.changes);
      assertPaletteIndicesExist(operation.changes.map((change) => change.index), pixel.palette.length, 'Pixel change');
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
    case 'pixel.cel.region': {
      const pixel = requirePixel(document, operationIndex);
      const sprite = pixel.pixelAssets[operation.spriteId] as PixelSprite | undefined;
      if (!sprite || sprite.type !== 'sprite') throw new Error('Pixel region changes require a sprite');
      const cel = sprite.cels[operation.celId];
      if (!cel) throw new Error(`Cel ${operation.celId} does not exist`);
      assertRevision(cel, operation.expectedRevision, operationIndex);
      assertSpriteCoordinates(sprite, operation.runs);
      assertPaletteIndicesExist(operation.runs.map((run) => run.index), pixel.palette.length, 'Pixel region');
      const inverse = writePixelRuns(cel, operation.runs);
      touch(cel, timestamp);
      touch(sprite, timestamp);
      return { kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: inverse, expectedRevision: cel.revision };
    }
    case 'pixel.tilemap.set': {
      const pixel = requirePixel(document, operationIndex);
      const map = pixel.pixelAssets[operation.mapId] as PixelTilemap | undefined;
      if (!map || map.type !== 'tilemap') throw new Error('Tile changes require a tilemap');
      const layer = map.layers[operation.layerId];
      if (!layer || layer.type !== 'tile' || !layer.chunks) throw new Error('Tile changes require a tile layer');
      assertRevision(layer, operation.expectedRevision, operationIndex);
      assertTileCoordinates(map, operation.changes);
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
    case 'pixel.tilemap.region': {
      const pixel = requirePixel(document, operationIndex);
      const map = pixel.pixelAssets[operation.mapId] as PixelTilemap | undefined;
      if (!map || map.type !== 'tilemap') throw new Error('Tile region changes require a tilemap');
      const layer = map.layers[operation.layerId];
      if (!layer || layer.type !== 'tile' || !layer.chunks) throw new Error('Tile region changes require a tile layer');
      assertRevision(layer, operation.expectedRevision, operationIndex);
      assertTileCoordinates(map, operation.runs);
      const inverse = writeTileRuns(layer.chunks, operation.runs);
      touch(layer, timestamp);
      touch(map, timestamp);
      return { kind: 'pixel.tilemap.region', mapId: map.id, layerId: layer.id, runs: inverse, expectedRevision: layer.revision };
    }
  }
}

function inverseWithCurrentRevision(document: AIDrawDocument, operation: CanvasOperation): CanvasOperation {
  const value = structuredClone(operation);
  if (document.kind === 'illustration') {
    if (value.kind === 'illustration.artboard.replace' || value.kind === 'illustration.artboard.translate' || value.kind === 'illustration.guides.replace' || value.kind === 'illustration.snap-settings.replace' || value.kind === 'illustration.animation.settings.replace') return { ...value, expectedRevision: document.revision };
    if (value.kind === 'illustration.layer.replace') return { ...value, expectedRevision: document.layers[value.layer.id]?.revision };
    if (value.kind === 'illustration.layer.move' || value.kind === 'illustration.layer.delete' || value.kind === 'illustration.paint.stroke') return { ...value, expectedRevision: document.layers[value.layerId]?.revision };
    if (value.kind === 'illustration.object.replace') return { ...value, expectedRevision: document.objects[value.object.id]?.revision };
    if (value.kind === 'illustration.object.move' || value.kind === 'illustration.object.delete') return { ...value, expectedRevision: document.objects[value.objectId]?.revision };
    if (value.kind === 'illustration.animation.keyframe.upsert') return { ...value, expectedRevision: document.animation.keyframes[value.keyframe.id]?.revision };
    if (value.kind === 'illustration.animation.keyframe.delete') return { ...value, expectedRevision: document.animation.keyframes[value.keyframeId]?.revision };
    return value;
  }
  if (value.kind === 'pixel.palette.reorder' || value.kind === 'pixel.links.replace') return { ...value, expectedRevision: document.revision };
  if (value.kind === 'pixel.frame.add' || value.kind === 'pixel.frame.delete') {
    const asset = document.pixelAssets[value.spriteId]; return { ...value, expectedRevision: asset?.type === 'sprite' ? asset.revision : undefined };
  }
  if (value.kind === 'pixel.frame.replace') {
    const asset = document.pixelAssets[value.spriteId]; return { ...value, expectedRevision: asset?.type === 'sprite' ? asset.frames[value.frame.id]?.revision : undefined };
  }
  if (value.kind === 'pixel.asset.replace') return { ...value, expectedRevision: document.pixelAssets[value.asset.id]?.revision };
  if (value.kind === 'pixel.asset.delete') return { ...value, expectedRevision: document.pixelAssets[value.assetId]?.revision };
  if (value.kind === 'pixel.cel.set' || value.kind === 'pixel.cel.region') {
    const asset = document.pixelAssets[value.spriteId]; return { ...value, expectedRevision: asset?.type === 'sprite' ? asset.cels[value.celId]?.revision : undefined };
  }
  if (value.kind === 'pixel.tilemap.set' || value.kind === 'pixel.tilemap.region') {
    const asset = document.pixelAssets[value.mapId]; return { ...value, expectedRevision: asset?.type === 'tilemap' ? asset.layers[value.layerId]?.revision : undefined };
  }
  return value;
}

function rebaseInverseRevisions(document: AIDrawDocument, operations: CanvasOperation[], timestamp: string): CanvasOperation[] {
  const simulation = structuredClone(document); const rebased: CanvasOperation[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = inverseWithCurrentRevision(simulation, operations[index]);
    applyOperation(simulation, operation, index, timestamp); rebased.push(operation);
  }
  return rebased;
}

/**
 * Rebind revision-guarded operations to the current canonical entities while
 * preserving their order. Callers must first establish that no conflicting
 * foreign edit touched the transaction's logical targets.
 */
export function rebaseTransactionExpectedRevisions(
  source: AIDrawDocument,
  transaction: CanvasTransaction,
): CanvasTransaction {
  if (source.id !== transaction.documentId) throw new Error('Transaction document ID does not match');
  const value = structuredClone(transaction);
  if (value.expectedDocumentRevision !== undefined) value.expectedDocumentRevision = source.revision;
  value.operations = rebaseInverseRevisions(source, value.operations, nowIso());
  return value;
}

export function applyTransaction(
  source: AIDrawDocument,
  transaction: CanvasTransaction,
  options: ApplyTransactionOptions = {},
): ApplyTransactionResult {
  if (source.id !== transaction.documentId) throw new Error('Transaction document ID does not match');
  if (transaction.expectedDocumentRevision !== undefined && source.revision !== transaction.expectedDocumentRevision) {
    throw new TransactionConflictError({
      operationIndex: 0,
      entityId: source.id,
      expectedRevision: transaction.expectedDocumentRevision,
      actualRevision: source.revision,
      message: 'Document revision changed before the transaction could be applied',
      retryable: true,
    });
  }
  const document = structuredClone(source);
  const timestamp = nowIso();
  const inverseOperations: CanvasOperation[] = [];

  for (let index = 0; index < transaction.operations.length; index += 1) {
    const inverse = applyOperation(document, transaction.operations[index], index, timestamp);
    inverseOperations.unshift(...(Array.isArray(inverse) ? inverse : [inverse]));
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
  const rebasedInverseOperations = rebaseInverseRevisions(document, inverseOperations, timestamp);

  return {
    document,
    inverse: {
      id: createId('tx'),
      clientOperationId: `inverse:${transaction.clientOperationId}:${document.revision}`,
      documentId: document.id,
      actor: structuredClone(transaction.actor),
      label: `Undo ${transaction.label}`,
      createdAt: timestamp,
      operations: rebasedInverseOperations,
      playback: { mode: 'instant', speed: 1 },
    },
  };
}

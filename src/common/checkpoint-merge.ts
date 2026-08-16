import {
  HUMAN_ACTOR,
  createId,
  nowIso,
  type AIDrawDocument,
  type CanvasOperation,
  type IllustrationDocument,
  type IllustrationLayer,
  type IllustrationObject,
  type PixelAsset,
} from '@aidraw/core';
import { importDocumentFragmentOperations, parseDocumentFragment } from './document-fragment';

export interface CheckpointMergeCandidate {
  id: string;
  name: string;
  type: 'illustration-layer' | 'pixel-asset';
  detail: string;
}

export function checkpointMergeCandidates(document: AIDrawDocument): CheckpointMergeCandidate[] {
  if (document.kind === 'illustration') return document.layerIds.map((id) => document.layers[id]).filter(Boolean).map((layer) => ({ id: layer.id, name: layer.name, type: 'illustration-layer', detail: layer.type }));
  return document.assetIds.map((id) => document.pixelAssets[id]).filter(Boolean).map((asset) => ({ id: asset.id, name: asset.name, type: 'pixel-asset', detail: asset.type }));
}

function collectIllustrationLayers(source: IllustrationDocument, rootIds: string[]): IllustrationLayer[] {
  const result: IllustrationLayer[] = []; const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const layer = source.layers[id]; if (!layer) throw new Error(`Checkpoint layer ${id} does not exist.`);
    seen.add(id); result.push(layer);
    if (layer.type === 'group') for (const childId of layer.childIds) visit(childId);
  };
  for (const id of rootIds) visit(id);
  return result;
}

function orderedIllustrationObjects(source: IllustrationDocument, layers: IllustrationLayer[]): IllustrationObject[] {
  const included = new Set(layers.flatMap((layer) => layer.type === 'vector' ? layer.objectIds : []));
  const result: IllustrationObject[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id) || !included.has(id)) return;
    if (visiting.has(id)) throw new Error('Checkpoint object dependencies contain a cycle.');
    const object = source.objects[id]; if (!object) throw new Error(`Checkpoint object ${id} does not exist.`);
    visiting.add(id);
    if (object.maskObjectId) visit(object.maskObjectId);
    if (object.type === 'group') for (const childId of object.childIds) visit(childId);
    visiting.delete(id); visited.add(id); result.push(object);
  };
  for (const layer of layers) if (layer.type === 'vector') for (const id of layer.objectIds) visit(id);
  return result;
}

function illustrationMergeOperations(target: IllustrationDocument, source: IllustrationDocument, rootIds: string[]): CanvasOperation[] {
  const layers = collectIllustrationLayers(source, rootIds);
  const objects = orderedIllustrationObjects(source, layers);
  const timestamp = nowIso(); const operations: CanvasOperation[] = [];
  const layerIds = new Map(layers.map((layer) => [layer.id, createId('layer')]));
  const objectIds = new Map(objects.map((object) => [object.id, createId('object')]));
  const assetIds = new Map<string, string>();
  const requiredAssets = new Set<string>();
  for (const layer of layers) if (layer.type === 'paint') for (const id of Object.values(layer.tileAssetIds)) requiredAssets.add(id);
  for (const object of objects) if (object.type === 'image') requiredAssets.add(object.assetId);
  for (const id of requiredAssets) {
    const asset = source.assets[id]; if (!asset) throw new Error(`Checkpoint asset ${id} is missing.`);
    const matching = Object.values(target.assets).find((candidate) => candidate.sha256 === asset.sha256);
    if (matching) { assetIds.set(id, matching.id); continue; }
    const next = structuredClone(asset); if (target.assets[next.id] || [...assetIds.values()].includes(next.id)) next.id = createId('asset');
    assetIds.set(id, next.id); operations.push({ kind: 'asset.add', asset: next });
  }
  for (const sourceLayer of layers) {
    const layer = structuredClone(sourceLayer); layer.id = layerIds.get(sourceLayer.id)!; layer.name = `${sourceLayer.name} · checkpoint`; layer.revision = 0; layer.createdAt = timestamp; layer.updatedAt = timestamp; layer.createdBy = HUMAN_ACTOR.id;
    layer.parentId = sourceLayer.parentId ? layerIds.get(sourceLayer.parentId) : undefined;
    layer.maskLayerId = sourceLayer.maskLayerId ? layerIds.get(sourceLayer.maskLayerId) : undefined;
    if (layer.type === 'group') layer.childIds = [];
    if (layer.type === 'vector') layer.objectIds = [];
    if (layer.type === 'paint') layer.tileAssetIds = Object.fromEntries(Object.entries(layer.tileAssetIds).map(([key, id]) => [key, assetIds.get(id) ?? id]));
    operations.push({ kind: 'illustration.layer.add', layer });
  }
  for (const sourceObject of objects) {
    const object = structuredClone(sourceObject); object.id = objectIds.get(sourceObject.id)!; object.layerId = layerIds.get(sourceObject.layerId)!; object.revision = 0; object.createdAt = timestamp; object.updatedAt = timestamp; object.createdBy = HUMAN_ACTOR.id;
    object.maskObjectId = sourceObject.maskObjectId ? objectIds.get(sourceObject.maskObjectId) : undefined;
    if (object.type === 'group') object.childIds = object.childIds.map((id) => objectIds.get(id)).filter((id): id is string => Boolean(id));
    if (object.type === 'image') object.assetId = assetIds.get(object.assetId) ?? object.assetId;
    operations.push({ kind: 'illustration.object.add', object });
  }
  if (operations.length > 256) throw new Error('Checkpoint layer selection expands beyond 256 canonical operations; merge fewer layers at once.');
  return operations;
}

function pixelDependencyClosure(document: Extract<AIDrawDocument, { kind: 'pixel' }>, rootIds: string[]): PixelAsset[] {
  const seen = new Set<string>(); const visit = (id: string) => {
    if (seen.has(id)) return; const asset = document.pixelAssets[id]; if (!asset) throw new Error(`Checkpoint pixel asset ${id} does not exist.`); seen.add(id);
    if (asset.type === 'tileset') {
      if (asset.spriteAssetId) visit(asset.spriteAssetId);
      for (const tile of Object.values(asset.tiles)) if (tile.imageAssetId) visit(tile.imageAssetId);
    }
    if (asset.type === 'tilemap') for (const tilesetId of asset.tilesetIds) visit(tilesetId);
  };
  for (const id of rootIds) visit(id);
  return document.assetIds.filter((id) => seen.has(id)).map((id) => document.pixelAssets[id]);
}

export function checkpointMergeOperations(target: AIDrawDocument, source: AIDrawDocument, sourceIds: string[]): CanvasOperation[] {
  const ids = [...new Set(sourceIds)]; if (ids.length < 1 || ids.length > 32) throw new Error('Choose 1–32 checkpoint layers or assets.');
  if (target.kind !== source.kind) throw new Error('Checkpoint and current document kinds do not match.');
  if (target.kind === 'illustration' && source.kind === 'illustration') return illustrationMergeOperations(target, source, ids);
  if (target.kind === 'pixel' && source.kind === 'pixel') {
    const assets = pixelDependencyClosure(source, ids);
    const fragment = parseDocumentFragment({ version: 1, kind: 'pixel-assets', pixelAssets: assets, activePixelAssetId: ids[0], palette: source.palette });
    return importDocumentFragmentOperations(target, fragment);
  }
  throw new Error('Unsupported checkpoint merge.');
}

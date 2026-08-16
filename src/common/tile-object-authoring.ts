import {
  encodeTiledGid,
  isImageCollectionTileset,
  resolveTilesetForGid,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelSpriteDependencyGuard,
  type PixelTilemap,
  type PixelTileset,
  type TileMapObject,
  type TileObjectAlignment,
  type TilemapLayer,
} from '@aidraw/core';
import { MAX_TILED_OBJECTS } from './tiled-resource-policy';
import { imageCollectionSourceDependencyGuards } from './image-collection-authoring';
import { resolveTilesetTileSource } from './tile-animation';
import { tileTransformFlagsAllowed, type TileTransformFlags } from './tile-transform-options';

export const MAX_TILE_OBJECT_COORDINATE = 16_777_216;
export const MAX_TILE_OBJECT_TEXT_LENGTH = 200;
export const MAX_TILE_OBJECT_PROPERTY_NAME_LENGTH = 200;
export const MAX_TILE_OBJECT_PROPERTY_STRING_LENGTH = 16_384;

export const TILE_OBJECT_ALIGNMENT_OPTIONS: ReadonlyArray<{
  value: TileObjectAlignment;
  label: string;
}> = [
  { value: 'unspecified', label: 'Unspecified (orthogonal bottom-left · isometric bottom)' },
  { value: 'topleft', label: 'Top left' },
  { value: 'top', label: 'Top' },
  { value: 'topright', label: 'Top right' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'bottomleft', label: 'Bottom left' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'bottomright', label: 'Bottom right' },
];

export type TileObjectPropertyValue = string | number | boolean;

export interface TileObjectCreationRequest {
  mapId: string;
  layerId: string;
  tilesetId: string;
  tileId: number;
  transforms: TileTransformFlags;
  point: { x: number; y: number };
  objectId: string;
}

export interface TileObjectCreationPlan {
  asset: PixelTilemap;
  object: TileMapObject;
  expectedRevision: number;
  expectedDocumentRevision?: number;
  expectedSpriteDependencies?: PixelSpriteDependencyGuard[];
}

export interface TileObjectEditableFields {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  name: string;
  className: string;
  properties: Record<string, TileObjectPropertyValue>;
}

function canonicalZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function boundedFinite(value: number, label: string, options: { positive?: boolean } = {}): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_TILE_OBJECT_COORDINATE || (options.positive && value < 1)) {
    const range = options.positive
      ? `from 1 through ${MAX_TILE_OBJECT_COORDINATE.toLocaleString('en-US')}`
      : `between −${MAX_TILE_OBJECT_COORDINATE.toLocaleString('en-US')} and ${MAX_TILE_OBJECT_COORDINATE.toLocaleString('en-US')}`;
    throw new RangeError(`${label} must be a finite number ${range}.`);
  }
  return canonicalZero(value);
}

function boundedText(value: string, label: string): string {
  if (value.length > MAX_TILE_OBJECT_TEXT_LENGTH) throw new RangeError(`${label} is limited to ${MAX_TILE_OBJECT_TEXT_LENGTH} characters.`);
  return value;
}

function validateProperties(properties: Record<string, TileObjectPropertyValue>): Record<string, TileObjectPropertyValue> {
  const result: Record<string, TileObjectPropertyValue> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`Tile-object property “${name}” must be a finite number.`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new RangeError(`Tile-object property “${name}” must be a string, finite number, or boolean.`);
    Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/**
 * Requires one exact visible, unlocked object layer and every ancestor to be
 * visible and unlocked. This prevents placement/edit controls from silently
 * redirecting to another layer when the selected destination is not writable.
 */
export function requireWritableTileObjectLayer(map: PixelTilemap, layerId: string): TilemapLayer {
  const layer = map.layers[layerId];
  if (!layer) throw new Error(`Object layer ${layerId} no longer exists.`);
  if (layer.type !== 'object') throw new Error(`Layer ${layerId} is not an object layer.`);
  const visited = new Set<string>();
  let current: TilemapLayer | undefined = layer;
  while (current) {
    if (visited.has(current.id)) throw new Error(`Layer ${layerId} has a cyclic group ancestry.`);
    visited.add(current.id);
    if (!current.visible) throw new Error(`Layer “${current.name}” is hidden. Show it before editing tile objects.`);
    if (current.locked) throw new Error(`Layer “${current.name}” is locked. Unlock it before editing tile objects.`);
    if (!current.parentId) break;
    current = map.layers[current.parentId];
    if (!current) throw new Error(`Layer ${layerId} references a missing parent group.`);
    if (current.type !== 'group') throw new Error(`Layer ${layerId} has a non-group parent.`);
  }
  return layer;
}

export function requireWritableTileObject(map: PixelTilemap, layerId: string, objectId: string): TileMapObject {
  const layer = requireWritableTileObjectLayer(map, layerId);
  const object = layer.objects?.find((entry) => entry.id === objectId);
  if (!object) throw new Error(`Map object ${objectId} no longer exists on layer ${layerId}.`);
  if (object.type !== 'tile') throw new Error(`Map object ${objectId} is not a tile object.`);
  return object;
}

export function requireTileObjectPlacementTileset(
  document: PixelDocument,
  map: PixelTilemap,
  tilesetId: string,
  expectedRevision: number,
): PixelTileset {
  if (!map.tilesetIds.includes(tilesetId)) throw new Error(`Tileset ${tilesetId} is detached from map ${map.id}.`);
  const tileset = document.pixelAssets[tilesetId];
  if (!tileset) throw new Error(`Tileset ${tilesetId} no longer exists.`);
  if (tileset.type !== 'tileset') throw new Error(`Asset ${tilesetId} is not a tileset.`);
  if (tileset.revision !== expectedRevision) throw new Error(`Tileset ${tilesetId} changed from revision ${expectedRevision} to ${tileset.revision}.`);
  return tileset;
}

export function planTileObjectCreation(document: PixelDocument, request: TileObjectCreationRequest): TileObjectCreationPlan {
  const asset = document.pixelAssets[request.mapId];
  if (!asset) throw new Error(`Map ${request.mapId} no longer exists.`);
  if (asset.type !== 'tilemap') throw new Error(`Asset ${request.mapId} is not a tilemap.`);
  const layer = requireWritableTileObjectLayer(asset, request.layerId);
  const mapObjectCount = Object.values(asset.layers).reduce((count, entry) => count + (entry.objects?.length ?? 0), 0);
  if (mapObjectCount >= MAX_TILED_OBJECTS) throw new RangeError(`Map ${asset.id} has reached the ${MAX_TILED_OBJECTS.toLocaleString('en-US')}-object limit.`);
  if (!request.objectId) throw new Error('A new tile object requires a nonempty identity.');
  if (Object.values(asset.layers).some((entry) => entry.objects?.some((object) => object.id === request.objectId))) throw new Error(`Map object ${request.objectId} already exists.`);

  if (!asset.tilesetIds.includes(request.tilesetId)) throw new Error(`Tileset ${request.tilesetId} is not attached to map ${asset.id}.`);
  const tileset = document.pixelAssets[request.tilesetId];
  if (!tileset) throw new Error(`Tileset ${request.tilesetId} no longer exists.`);
  if (tileset.type !== 'tileset') throw new Error(`Asset ${request.tilesetId} is not a tileset.`);
  const imageCollection = isImageCollectionTileset(tileset);
  const tileCount = tilesetLocalIdSpan(tileset);
  if (!Number.isSafeInteger(request.tileId) || request.tileId < 0 || request.tileId >= tileCount) throw new RangeError(`Tile ID must be a whole number from 0 to ${Math.max(0, tileCount - 1)} for tileset “${tileset.name}”.`);
  if (imageCollection && !tileset.tiles[request.tileId]?.imageAssetId) throw new Error(`Tile ${request.tileId} is a sparse gap in image collection “${tileset.name}”. Choose one exact existing tile ID.`);
  if (!tileTransformFlagsAllowed(request.transforms, tileset.transformations)) throw new Error(`The selected H/V/diagonal transform is not permitted by tileset “${tileset.name}”.`);

  const baseGid = tileset.firstGid + request.tileId;
  const coveringTilesetCount = asset.tilesetIds.reduce((count, id) => {
    const attached = document.pixelAssets[id];
    if (attached?.type !== 'tileset') return count;
    const attachedTileCount = tilesetLocalIdSpan(attached);
    const finalGid = attached.firstGid + attachedTileCount - 1;
    return baseGid >= attached.firstGid && baseGid <= finalGid ? count + 1 : count;
  }, 0);
  if (coveringTilesetCount !== 1) throw new Error(`GID ${baseGid} is covered by ${coveringTilesetCount} attached tileset ranges; tile-object creation requires exactly one.`);
  const resolved = resolveTilesetForGid(document, asset, baseGid);
  if (!resolved || resolved.tileset.id !== tileset.id || resolved.localId !== request.tileId) throw new Error(`Tile ${request.tileId} does not resolve exactly to attached tileset ${tileset.id}; no object was created.`);
  const source = imageCollection ? resolveTilesetTileSource(document, tileset, request.tileId).sprite : undefined;
  const object: TileMapObject = {
    id: request.objectId,
    type: 'tile',
    gid: encodeTiledGid(baseGid, request.transforms),
    x: boundedFinite(request.point.x, 'Tile-object X'),
    y: boundedFinite(request.point.y, 'Tile-object Y'),
    width: boundedFinite(source?.width ?? tileset.tileWidth, 'Tile-object width', { positive: true }),
    height: boundedFinite(source?.height ?? tileset.tileHeight, 'Tile-object height', { positive: true }),
    rotation: 0,
    name: '',
    className: '',
    properties: {},
  };
  const next = structuredClone(asset);
  const nextLayer = next.layers[layer.id];
  if (nextLayer?.type !== 'object') throw new Error(`Object layer ${request.layerId} changed before placement.`);
  nextLayer.objects = [...(nextLayer.objects ?? []), object];
  return {
    asset: next,
    object,
    expectedRevision: asset.revision,
    ...(imageCollection ? {
      expectedDocumentRevision: document.revision,
      expectedSpriteDependencies: imageCollectionSourceDependencyGuards(document, tileset),
    } : {}),
  };
}

/** Preserves tile identity while validating the complete admitted editable field set. */
export function editTileObject(object: TileMapObject, fields: TileObjectEditableFields): TileMapObject {
  return {
    id: object.id,
    type: 'tile',
    gid: object.gid,
    x: boundedFinite(fields.x, 'Tile-object X'),
    y: boundedFinite(fields.y, 'Tile-object Y'),
    width: boundedFinite(fields.width, 'Tile-object width', { positive: true }),
    height: boundedFinite(fields.height, 'Tile-object height', { positive: true }),
    rotation: boundedFinite(fields.rotation, 'Tile-object clockwise rotation'),
    name: boundedText(fields.name, 'Tile-object name'),
    className: boundedText(fields.className, 'Tile-object class'),
    properties: validateProperties(fields.properties),
  };
}

export function parseTileObjectPropertyValue(type: 'string' | 'number' | 'boolean', value: string): TileObjectPropertyValue {
  if (type === 'string') {
    if (value.length > MAX_TILE_OBJECT_PROPERTY_STRING_LENGTH) throw new RangeError(`Tile-object string properties are limited to ${MAX_TILE_OBJECT_PROPERTY_STRING_LENGTH.toLocaleString('en-US')} characters.`);
    return value;
  }
  if (type === 'number') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new RangeError('Tile-object number properties require a finite number.');
    return canonicalZero(Number(value));
  }
  if (value !== 'true' && value !== 'false') throw new RangeError('Tile-object boolean properties must be true or false.');
  return value === 'true';
}

export function setTileObjectProperty(
  object: TileMapObject,
  name: string,
  type: 'string' | 'number' | 'boolean',
  value: string,
): TileMapObject {
  const exactExistingKey = Object.hasOwn(object.properties, name);
  const key = exactExistingKey ? name : name.trim();
  if (!exactExistingKey && (!key || key.length > MAX_TILE_OBJECT_PROPERTY_NAME_LENGTH)) throw new RangeError(`Tile-object property names must be 1–${MAX_TILE_OBJECT_PROPERTY_NAME_LENGTH} characters.`);
  const current = exactExistingKey ? object.properties[key] : undefined;
  if (exactExistingKey && type === 'string' && typeof current === 'string' && current === value) return editTileObject(object, { ...object, properties: object.properties });
  const properties = validateProperties(object.properties);
  Object.defineProperty(properties, key, { value: parseTileObjectPropertyValue(type, value), enumerable: true, configurable: true, writable: true });
  return editTileObject(object, { ...object, properties });
}

export function deleteTileObjectProperty(object: TileMapObject, name: string): TileMapObject {
  const properties = validateProperties(object.properties);
  delete properties[name];
  return editTileObject(object, { ...object, properties });
}

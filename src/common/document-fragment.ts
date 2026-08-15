import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  createId,
  nowIso,
  type AIDrawDocument,
  type CanvasOperation,
  type DocumentAsset,
  type IllustrationDocument,
  type IllustrationObject,
  type PixelAsset,
  type PixelDocument,
  type PaletteEntry,
} from '@aidraw/core';
import type { GridSelectionClipboard } from './grid-selection';

export interface PixelSelectionFragment {
  version: 1;
  kind: 'pixel-selection';
  sourceDocumentId: string;
  grid: GridSelectionClipboard<number>;
  palette: string[];
}

export type AIDrawFragment =
  | { version: 1; kind: 'illustration-objects'; objects: IllustrationObject[]; assets: DocumentAsset[] }
  | { version: 1; kind: 'pixel-assets'; pixelAssets: PixelAsset[]; activePixelAssetId: string; palette: PaletteEntry[] }
  | PixelSelectionFragment;

export const MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;

export function documentFragmentBytes(fragment: AIDrawFragment): number {
  return new TextEncoder().encode(JSON.stringify(fragment)).byteLength;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${label} has unsupported fields.`);
}

function parsePixelSelectionGrid(value: unknown, paletteLength: number): GridSelectionClipboard<number> {
  assertRecord(value, 'Pixel selection grid');
  assertExactKeys(value, ['version', 'originX', 'originY', 'width', 'height', 'cells'], 'Pixel selection grid');
  const { originX, originY, width, height } = value;
  if (value.version !== 1) throw new Error('Unsupported pixel selection grid version.');
  if (![originX, originY, width, height].every(Number.isSafeInteger) || Number(width) < 1 || Number(height) < 1
    || Number(width) > 1_000_000 || Number(height) > 1_000_000
    || Number(originX) > Number.MAX_SAFE_INTEGER - (Number(width) - 1)
    || Number(originY) > Number.MAX_SAFE_INTEGER - (Number(height) - 1)) {
    throw new Error('Pixel selection grid geometry is invalid or exceeds one million cells per axis.');
  }
  if (!Array.isArray(value.cells) || value.cells.length < 1 || value.cells.length > 1_000_000) throw new Error('Pixel selection fragments require 1–1,000,000 selected cells.');
  const occupied = new Set<string>();
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const cells = value.cells.map((candidate, index) => {
    assertRecord(candidate, `Pixel selection cell ${index}`);
    assertExactKeys(candidate, ['x', 'y', 'value'], `Pixel selection cell ${index}`);
    const x = candidate.x; const y = candidate.y; const paletteIndex = candidate.value;
    if (![x, y, paletteIndex].every(Number.isSafeInteger) || Number(x) < 0 || Number(y) < 0
      || Number(x) >= Number(width) || Number(y) >= Number(height)
      || Number(paletteIndex) < 0 || Number(paletteIndex) >= paletteLength) {
      throw new Error(`Pixel selection cell ${index} falls outside its grid or palette.`);
    }
    const key = `${x},${y}`;
    if (occupied.has(key)) throw new Error(`Pixel selection cell ${key} is duplicated.`);
    occupied.add(key);
    const normalizedX = Number(x);
    const normalizedY = Number(y);
    minimumX = Math.min(minimumX, normalizedX);
    minimumY = Math.min(minimumY, normalizedY);
    maximumX = Math.max(maximumX, normalizedX);
    maximumY = Math.max(maximumY, normalizedY);
    return { x: normalizedX, y: normalizedY, value: Number(paletteIndex) };
  });
  if (minimumX !== 0 || minimumY !== 0 || maximumX !== Number(width) - 1 || maximumY !== Number(height) - 1) {
    throw new Error('Pixel selection grid bounds must exactly enclose its selected cells.');
  }
  return { version: 1, originX: Number(originX), originY: Number(originY), width: Number(width), height: Number(height), cells };
}

export function parseDocumentFragment(value: unknown): AIDrawFragment {
  assertRecord(value, 'Document fragment');
  if (value.version !== 1) throw new Error('Unsupported document fragment version.');
  // Clipboard payloads written by builds before multi-asset fragments used this
  // singular shape. Upgrade it at the boundary so existing user clipboards do
  // not become unreadable after the safer fragment contract is introduced.
  if (value.kind === 'pixel-asset' && value.pixelAsset && Array.isArray(value.palette)) {
    assertRecord(value.pixelAsset, 'Pixel fragment asset');
    return parseDocumentFragment({
      version: 1,
      kind: 'pixel-assets',
      pixelAssets: [value.pixelAsset],
      activePixelAssetId: value.pixelAsset.id,
      palette: value.palette,
    });
  }
  if (value.kind === 'pixel-selection') {
    assertExactKeys(value, ['version', 'kind', 'sourceDocumentId', 'grid', 'palette'], 'Pixel selection fragment');
    if (typeof value.sourceDocumentId !== 'string' || !value.sourceDocumentId.trim() || value.sourceDocumentId.length > 200) throw new Error('Pixel selection source document ID must contain 1–200 characters.');
    if (!Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 256
      || value.palette.some((color) => typeof color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color))) {
      throw new Error('Pixel selection fragments require 2–256 hexadecimal palette colors.');
    }
    if (value.palette[0].length !== 9 || !value.palette[0].toLowerCase().endsWith('00')) throw new Error('Pixel selection palette index 0 must remain transparent.');
    const fragment: PixelSelectionFragment = {
      version: 1,
      kind: 'pixel-selection',
      sourceDocumentId: value.sourceDocumentId,
      grid: parsePixelSelectionGrid(value.grid, value.palette.length),
      palette: [...value.palette] as string[],
    };
    if (documentFragmentBytes(fragment) > MAX_FRAGMENT_BYTES) throw new Error('Document fragment exceeds the 2 MiB exchange limit.');
    return fragment;
  }
  if (value.kind === 'illustration-objects') {
    if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > 192) throw new Error('Illustration fragments require 1–192 objects.');
    if (!Array.isArray(value.assets) || value.assets.length > 64) throw new Error('Illustration fragments support at most 64 embedded assets.');
    const objects = value.objects as IllustrationObject[];
    const assets = value.assets as DocumentAsset[];
    if (new Set(objects.map((object) => object?.id)).size !== objects.length || objects.some((object) => !object || typeof object.id !== 'string' || typeof object.type !== 'string')) throw new Error('Illustration fragment object IDs must be unique and valid.');
    if (new Set(assets.map((asset) => asset?.id)).size !== assets.length || assets.some((asset) => !asset || typeof asset.id !== 'string' || typeof asset.sha256 !== 'string')) throw new Error('Illustration fragment asset IDs must be unique and valid.');
    for (const asset of assets) CanvasOperationSchema.parse({ kind: 'asset.add', asset });
    const objectIds = new Set(objects.map((object) => object.id));
    const assetIds = new Set(assets.map((asset) => asset.id));
    for (const object of objects) {
      if (!['vector-stroke', 'path', 'shape', 'text', 'image', 'group'].includes(object.type)) throw new Error(`Unsupported illustration fragment object type ${object.type}.`);
      if (!object.transform || !Number.isFinite(object.transform.x) || !Number.isFinite(object.transform.y)) throw new Error(`Illustration object ${object.id} has an invalid transform.`);
      if (object.maskObjectId && !objectIds.has(object.maskObjectId)) throw new Error(`Illustration object ${object.id} has a mask outside the fragment.`);
      if (object.type === 'group' && object.childIds.some((id) => !objectIds.has(id))) throw new Error(`Illustration group ${object.id} has a child outside the fragment.`);
      if (object.type === 'image' && !assetIds.has(object.assetId)) throw new Error(`Illustration image ${object.id} has an asset outside the fragment.`);
    }
    const fragment = structuredClone(value) as AIDrawFragment;
    if (documentFragmentBytes(fragment) > MAX_FRAGMENT_BYTES) throw new Error('Document fragment exceeds the 2 MiB exchange limit.');
    return fragment;
  }
  if (value.kind === 'pixel-assets') {
    if (!Array.isArray(value.pixelAssets) || value.pixelAssets.length < 1 || value.pixelAssets.length > 64) throw new Error('Pixel fragments require 1–64 assets.');
    if (!Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 256) throw new Error('Pixel fragments require a 2–256 entry palette.');
    if (typeof value.activePixelAssetId !== 'string') throw new Error('Pixel fragment active asset is missing.');
    const assets = value.pixelAssets as PixelAsset[];
    if (new Set(assets.map((asset) => asset?.id)).size !== assets.length || assets.some((asset) => !asset || typeof asset.id !== 'string' || typeof asset.type !== 'string')) throw new Error('Pixel fragment asset IDs must be unique and valid.');
    if (!assets.some((asset) => asset.id === value.activePixelAssetId)) throw new Error('Pixel fragment active asset is not included.');
    for (const asset of assets) CanvasOperationSchema.parse({ kind: 'pixel.asset.add', asset });
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    for (const asset of assets) {
      if (asset.type === 'tileset' && assetsById.get(asset.spriteAssetId)?.type !== 'sprite') throw new Error(`Tileset ${asset.id} has a sprite dependency outside the fragment.`);
      if (asset.type === 'tilemap' && asset.tilesetIds.some((id) => assetsById.get(id)?.type !== 'tileset')) throw new Error(`Tilemap ${asset.id} has a tileset dependency outside the fragment.`);
    }
    const palette = value.palette as PaletteEntry[];
    if (new Set(palette.map((entry) => entry?.id)).size !== palette.length || palette.some((entry) => !entry || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(entry.color))) throw new Error('Pixel fragment palette entries must have unique IDs and valid colors.');
    const fragment = structuredClone(value) as AIDrawFragment;
    if (documentFragmentBytes(fragment) > MAX_FRAGMENT_BYTES) throw new Error('Document fragment exceeds the 2 MiB exchange limit.');
    return fragment;
  }
  throw new Error('Unknown document fragment kind.');
}

export function exportIllustrationFragment(document: IllustrationDocument, objectIds: string[]): AIDrawFragment {
  const ids = objectIds.length ? new Set<string>() : new Set(Object.keys(document.objects));
  const queue = objectIds.length ? [...objectIds] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    const object = document.objects[id];
    if (!object) throw new Error(`Illustration object ${id} does not exist.`);
    ids.add(id);
    if (object.maskObjectId) queue.push(object.maskObjectId);
    if (object.type === 'group') queue.push(...object.childIds);
  }
  const objects = Object.values(document.objects).filter((object) => ids.has(object.id));
  if (!objects.length) throw new Error('No illustration objects were selected for export.');
  const assetIds = new Set(objects.flatMap((object) => object.type === 'image' ? [object.assetId] : []));
  return parseDocumentFragment({ version: 1, kind: 'illustration-objects', objects, assets: [...assetIds].map((id) => document.assets[id]).filter(Boolean) });
}

export function exportPixelFragment(document: PixelDocument, assetId = document.activeAssetId): AIDrawFragment {
  if (!document.pixelAssets[assetId]) throw new Error(`Pixel asset ${assetId} does not exist.`);
  const ids = new Set<string>();
  const queue = [assetId];
  while (queue.length) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    const asset = document.pixelAssets[id];
    if (!asset) throw new Error(`Pixel fragment dependency ${id} is missing.`);
    ids.add(id);
    if (asset.type === 'tileset') queue.push(asset.spriteAssetId);
    if (asset.type === 'tilemap') queue.push(...asset.tilesetIds);
  }
  const pixelAssets = [...ids].map((id) => document.pixelAssets[id]);
  return parseDocumentFragment({ version: 1, kind: 'pixel-assets', pixelAssets, activePixelAssetId: assetId, palette: document.palette });
}

function illustrationImportOperations(document: IllustrationDocument, fragment: Extract<AIDrawFragment, { kind: 'illustration-objects' }>, targetLayerId?: string, offsetX = 16, offsetY = 16): CanvasOperation[] {
  const layer = targetLayerId ? document.layers[targetLayerId] : Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
  if (!layer || layer.type !== 'vector' || layer.locked) throw new Error('Choose an unlocked vector layer for the fragment.');
  const operations: CanvasOperation[] = [];
  const assetIds = new Map<string, string>();
  for (const source of fragment.assets) {
    const matching = Object.values(document.assets).find((asset) => asset.sha256 === source.sha256);
    if (matching) { assetIds.set(source.id, matching.id); continue; }
    const existing = document.assets[source.id];
    const asset = structuredClone(source);
    if (existing) asset.id = createId('asset');
    assetIds.set(source.id, asset.id);
    operations.push({ kind: 'asset.add', asset });
  }
  const objectIds = new Map(fragment.objects.map((object) => [object.id, createId('object')]));
  const timestamp = nowIso();
  for (const source of fragment.objects) {
    const object = structuredClone(source);
    object.id = objectIds.get(source.id)!;
    object.layerId = layer.id;
    object.revision = 0;
    object.createdAt = timestamp;
    object.updatedAt = timestamp;
    object.createdBy = HUMAN_ACTOR.id;
    object.transform = { ...object.transform, x: object.transform.x + offsetX, y: object.transform.y + offsetY };
    if (object.maskObjectId) object.maskObjectId = objectIds.get(object.maskObjectId);
    if (object.type === 'group') object.childIds = object.childIds.map((id) => objectIds.get(id)).filter((id): id is string => Boolean(id));
    if (object.type === 'image') {
      const mapped = assetIds.get(object.assetId) ?? (document.assets[object.assetId] ? object.assetId : undefined);
      if (!mapped) throw new Error(`Image object ${source.id} is missing asset ${object.assetId}.`);
      object.assetId = mapped;
    }
    operations.push({ kind: 'illustration.object.add', object });
  }
  if (operations.length > 256) throw new Error('Fragment expansion exceeds 256 canonical operations.');
  return operations;
}

function colorChannels(color: string): [number, number, number, number] {
  const hex = color.slice(1);
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255];
}

function nearestPaletteIndex(color: string, palette: PaletteEntry[]): number {
  const source = colorChannels(color);
  let best = palette.length > 1 ? 1 : 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = best; index < palette.length; index += 1) {
    const target = colorChannels(palette[index].color);
    const distance = (source[0] - target[0]) ** 2 + (source[1] - target[1]) ** 2 + (source[2] - target[2]) ** 2 + (source[3] - target[3]) ** 2;
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  }
  return best;
}

function remapSpritePalette(asset: PixelAsset, mapping: number[]): void {
  if (asset.type !== 'sprite') return;
  for (const cel of Object.values(asset.cels)) {
    if (asset.paletteOverrides[cel.frameId]) continue;
    for (const chunk of Object.values(cel.chunks)) {
      const values = Buffer.from(chunk.data, 'base64');
      if (values.byteLength !== chunk.width * chunk.height) throw new Error(`Pixel chunk in cel ${cel.id} has invalid encoded data.`);
      for (let index = 0; index < values.length; index += 1) values[index] = mapping[values[index]] ?? 0;
      chunk.data = values.toString('base64');
    }
  }
}

function pixelImportOperations(document: PixelDocument, fragment: Extract<AIDrawFragment, { kind: 'pixel-assets' }>): CanvasOperation[] {
  const ids = new Map(fragment.pixelAssets.map((asset) => [asset.id, createId(asset.type)]));
  const order = { sprite: 0, tileset: 1, tilemap: 2 } as const;
  const operations: CanvasOperation[] = [];
  const palette = structuredClone(document.palette);
  const mapping = fragment.palette.map((entry, index) => {
    if (index === 0) return 0;
    const existing = palette.findIndex((candidate) => candidate.color.toLowerCase() === entry.color.toLowerCase());
    if (existing >= 0) return existing;
    if (palette.length < 256) {
      palette.push({ ...structuredClone(entry), id: createId('palette') });
      return palette.length - 1;
    }
    return nearestPaletteIndex(entry.color, palette);
  });
  if (palette.length !== document.palette.length) operations.push({ kind: 'pixel.palette.replace', palette });
  for (const source of [...fragment.pixelAssets].sort((left, right) => order[left.type] - order[right.type])) {
    const asset = structuredClone(source);
    asset.id = ids.get(source.id)!;
    asset.name = `${asset.name} copy`;
    asset.revision = 0;
    remapSpritePalette(asset, mapping);
    if (asset.type === 'tileset') asset.spriteAssetId = ids.get(asset.spriteAssetId) ?? asset.spriteAssetId;
    if (asset.type === 'tilemap') asset.tilesetIds = asset.tilesetIds.map((id) => ids.get(id) ?? id);
    operations.push({ kind: 'pixel.asset.add', asset });
  }
  operations.push({ kind: 'pixel.active-asset.set', assetId: ids.get(fragment.activePixelAssetId)! });
  return operations;
}

export function importDocumentFragmentOperations(
  document: AIDrawDocument,
  value: unknown,
  options: { targetLayerId?: string; offsetX?: number; offsetY?: number } = {},
): CanvasOperation[] {
  const fragment = parseDocumentFragment(value);
  const offsetX = Number.isFinite(options.offsetX) ? Math.max(-1_000_000, Math.min(1_000_000, Number(options.offsetX))) : 16;
  const offsetY = Number.isFinite(options.offsetY) ? Math.max(-1_000_000, Math.min(1_000_000, Number(options.offsetY))) : 16;
  if (fragment.kind === 'illustration-objects' && document.kind === 'illustration') return illustrationImportOperations(document, fragment, options.targetLayerId, offsetX, offsetY);
  if (fragment.kind === 'pixel-assets' && document.kind === 'pixel') return pixelImportOperations(document, fragment);
  throw new Error(`A ${fragment.kind} fragment cannot be imported into a ${document.kind} document.`);
}

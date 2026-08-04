import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  applyTransaction,
  createIllustrationDocument,
  createPixelDocument,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  readPixel,
  writePixels,
  type CanvasTransaction,
  type DocumentAsset,
  type IllustrationObject,
  type PixelSprite,
} from '@aidraw/core';
import {
  MAX_FRAGMENT_BYTES,
  documentFragmentBytes,
  exportIllustrationFragment,
  exportPixelFragment,
  importDocumentFragmentOperations,
  parseDocumentFragment,
} from '../../src/common/document-fragment';

function objectBase(id: string, layerId: string, x: number, y: number) {
  const timestamp = nowIso();
  return {
    id,
    revision: 0,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    layerId,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    transform: { ...IDENTITY_TRANSFORM, x, y },
  };
}

function shape(id: string, layerId: string, x: number, y: number): IllustrationObject {
  return {
    ...objectBase(id, layerId, x, y),
    type: 'shape',
    shape: 'rectangle',
    width: 8,
    height: 8,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

describe('safe document fragments', () => {
  it('exports illustration relation closure and imports remapped objects with hash-deduplicated assets', () => {
    const source = createIllustrationDocument('Fragment source');
    const sourceLayer = Object.values(source.layers).find((layer) => layer.type === 'vector')!;
    const embedded: DocumentAsset = { id: 'source-image', name: 'Source image', mimeType: 'image/png', byteLength: 3, sha256: 'a'.repeat(64), source: 'embedded', data: 'YWJj' };
    const mask = shape('mask', sourceLayer.id, 2, 3);
    const image: IllustrationObject = { ...objectBase('image', sourceLayer.id, 10, 20), type: 'image', assetId: embedded.id, width: 16, height: 12, filters: [], maskObjectId: mask.id };
    const group: IllustrationObject = { ...objectBase('group', sourceLayer.id, 30, 40), type: 'group', childIds: [image.id] };
    source.assets[embedded.id] = embedded;
    source.objects = { [mask.id]: mask, [image.id]: image, [group.id]: group };
    if (sourceLayer.type === 'vector') sourceLayer.objectIds = [mask.id, image.id, group.id];

    const fragment = exportIllustrationFragment(source, [group.id]);
    expect(fragment.kind).toBe('illustration-objects');
    if (fragment.kind !== 'illustration-objects') throw new Error('Expected illustration fragment');
    expect(fragment.objects.map((object) => object.id).sort()).toEqual(['group', 'image', 'mask']);
    expect(fragment.assets).toEqual([embedded]);

    const target = createIllustrationDocument('Fragment target');
    target.assets['existing-image'] = { ...embedded, id: 'existing-image' };
    const operations = importDocumentFragmentOperations(target, fragment, { offsetX: 5, offsetY: -3 });
    expect(operations.some((operation) => operation.kind === 'asset.add')).toBe(false);
    const additions = operations.filter((operation): operation is Extract<(typeof operations)[number], { kind: 'illustration.object.add' }> => operation.kind === 'illustration.object.add');
    expect(additions).toHaveLength(3);
    const importedImage = additions.find((operation) => operation.object.type === 'image')!.object;
    const importedMask = additions.find((operation) => operation.object.name === 'mask')!.object;
    const importedGroup = additions.find((operation) => operation.object.type === 'group')!.object;
    expect(importedImage.transform).toMatchObject({ x: 15, y: 17 });
    expect(importedImage.type === 'image' && importedImage.assetId).toBe('existing-image');
    expect(importedImage.maskObjectId).toBe(importedMask.id);
    expect(importedGroup.type === 'group' && importedGroup.childIds).toEqual([importedImage.id]);
    expect(new Set(additions.map((operation) => operation.object.id)).size).toBe(3);
  });

  it('exports pixel dependency closure and preserves palette appearance while remapping asset references', () => {
    const source = createPixelDocument('project', 'Pixel source');
    const sprite = source.pixelAssets[source.activeAssetId] as PixelSprite;
    source.palette[4] = { id: 'custom-coral', name: 'Custom coral', color: '#123456' };
    writePixels(Object.values(sprite.cels)[0], [{ x: 1, y: 1, index: 4 }]);
    const tileset = createPixelTileset('Tiles', sprite.id, 16, 16, 4, 4);
    const map = createPixelTilemap('Map');
    map.tilesetIds = [tileset.id];
    source.pixelAssets[tileset.id] = tileset;
    source.pixelAssets[map.id] = map;
    source.assetIds.push(tileset.id, map.id);
    source.activeAssetId = map.id;

    const fragment = exportPixelFragment(source, map.id);
    expect(fragment.kind === 'pixel-assets' && fragment.pixelAssets.map((asset) => asset.type).sort()).toEqual(['sprite', 'tilemap', 'tileset']);

    const target = createPixelDocument('project', 'Pixel target');
    const operations = importDocumentFragmentOperations(target, fragment);
    const transaction: CanvasTransaction = { id: 'fragment-tx', clientOperationId: 'fragment-import', documentId: target.id, actor: HUMAN_ACTOR, label: 'Import fragment', createdAt: nowIso(), operations };
    const imported = applyTransaction(target, transaction).document;
    if (imported.kind !== 'pixel') throw new Error('Expected pixel document');
    const importedMap = imported.pixelAssets[imported.activeAssetId];
    if (importedMap.type !== 'tilemap') throw new Error('Expected imported map');
    const importedTileset = imported.pixelAssets[importedMap.tilesetIds[0]];
    if (importedTileset.type !== 'tileset') throw new Error('Expected imported tileset');
    const importedSprite = imported.pixelAssets[importedTileset.spriteAssetId];
    if (importedSprite.type !== 'sprite') throw new Error('Expected imported sprite');
    const importedIndex = readPixel(Object.values(importedSprite.cels)[0], 1, 1);
    expect(imported.palette[importedIndex].color).toBe('#123456');
    expect([importedMap.id, importedTileset.id, importedSprite.id]).not.toContain(map.id);
  });

  it('upgrades the legacy single-pixel-asset clipboard shape', () => {
    const document = createPixelDocument('sprite');
    const asset = document.pixelAssets[document.activeAssetId];
    const parsed = parseDocumentFragment({ version: 1, kind: 'pixel-asset', pixelAsset: asset, palette: document.palette });
    expect(parsed).toMatchObject({ version: 1, kind: 'pixel-assets', activePixelAssetId: asset.id });
  });

  it('rejects duplicate IDs, external dependencies, and payloads over the exchange cap', () => {
    const document = createIllustrationDocument();
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const first = shape('duplicate', layer.id, 0, 0);
    expect(() => parseDocumentFragment({ version: 1, kind: 'illustration-objects', objects: [first, first], assets: [] })).toThrow(/unique/);
    expect(() => parseDocumentFragment({ version: 1, kind: 'illustration-objects', objects: [{ ...first, id: 'external', maskObjectId: 'missing' }], assets: [] })).toThrow(/outside the fragment/);

    const largeAssets = [0, 1].map((index): DocumentAsset => ({ id: `large-${index}`, name: `Large ${index}`, mimeType: 'image/png', byteLength: 825_000, sha256: String(index).repeat(64), source: 'embedded', data: 'A'.repeat(1_100_000) }));
    const oversized = { version: 1 as const, kind: 'illustration-objects' as const, objects: [first], assets: largeAssets };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_FRAGMENT_BYTES);
    expect(() => parseDocumentFragment(oversized)).toThrow(/2 MiB/);
    expect(documentFragmentBytes(exportIllustrationFragment({ ...document, objects: { [first.id]: first } }, [first.id]))).toBeLessThan(MAX_FRAGMENT_BYTES);
  });
});

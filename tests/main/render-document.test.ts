import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, encodeTiledGid, nowIso, writePixels, writeTiles, type GroupObject, type ShapeObject } from '@aidraw/core';
import { materializePaintTiles } from '@main/persistence';
import { renderIllustration, renderSprite, renderTilemap } from '@main/render-document';

describe('native document rendering', () => {
  it('renders a one-cell non-square isometric map without clipping either tile edge', () => {
    const document = createPixelDocument('project', 'Isometric edge bounds'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Non-square tile', 4, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [2, 4, 8, 11, 12, 9, 6, 3].map((index, offset) => ({ x: offset % 4, y: Math.floor(offset / 4), index })));
    const tileset = createPixelTileset('Non-square tile', sprite.id, 4, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('One diamond'); map.orientation = 'isometric'; map.width = 1; map.height = 1; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d').getImageData(0, 0, 4, 2).data;
    const rendered = renderTilemap(document, map);
    expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 4, height: 2 });
    expect(Buffer.from(rendered.getContext('2d').getImageData(0, 0, 4, 2).data)).toEqual(Buffer.from(source));
  });

  it('renders overlapping isometric cells right-down across reverse-inserted sparse chunks', () => {
    const document = createPixelDocument('project', 'Isometric sparse depth order'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Depth tiles', 8, 4); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 32 }, (_, offset) => ({ x: offset % 8, y: Math.floor(offset / 8), index: offset % 8 < 4 ? 2 : 8 })));
    const tileset = createPixelTileset('Depth tiles', sprite.id, 4, 4, 2, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Sparse diamond'); map.orientation = 'isometric'; map.infinite = true; map.width = 2; map.height = 64; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 32, gid: 2 }, { x: 0, y: 31, gid: 1 }]);
    expect(Object.keys(layer.chunks)).toEqual(['0,1', '0,0']);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d');
    const backColor = [...source.getImageData(0, 0, 1, 1).data];
    const frontColor = [...source.getImageData(4, 0, 1, 1).data];
    const rendered = renderTilemap(document, map).getContext('2d');
    expect([...rendered.getImageData(67, 62, 1, 1).data]).toEqual(backColor);
    expect([...rendered.getImageData(62, 67, 1, 1).data]).toEqual(frontColor);
    expect([...rendered.getImageData(64, 64, 1, 1).data]).toEqual(frontColor);
  });

  it('renders all eight Tiled tile transforms in diagonal-first order', () => {
    const document = createPixelDocument('project', 'Tiled transform rendering'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Labeled tile', 2, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 4 }, { x: 0, y: 1, index: 8 }, { x: 1, y: 1, index: 11 }]);
    const tileset = createPixelTileset('Labeled tile', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Transform matrix'); map.width = 8; map.height = 1; map.tileWidth = 2; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const cases = [
      [{}, ['A', 'B', 'C', 'D']],
      [{ hFlip: true }, ['B', 'A', 'D', 'C']],
      [{ vFlip: true }, ['C', 'D', 'A', 'B']],
      [{ hFlip: true, vFlip: true }, ['D', 'C', 'B', 'A']],
      [{ diagonal: true }, ['D', 'B', 'C', 'A']],
      [{ diagonal: true, hFlip: true }, ['B', 'D', 'A', 'C']],
      [{ diagonal: true, vFlip: true }, ['C', 'A', 'D', 'B']],
      [{ diagonal: true, hFlip: true, vFlip: true }, ['A', 'C', 'B', 'D']],
    ] as const;
    writeTiles(layer.chunks, cases.map(([transforms], x) => ({ x, y: 0, gid: encodeTiledGid(1, transforms) })));
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d').getImageData(0, 0, 2, 2).data;
    const pixels = new Map(['A', 'B', 'C', 'D'].map((label, index) => [label, [...source.slice(index * 4, index * 4 + 4)]]));
    const rendered = renderTilemap(document, map).getContext('2d');
    cases.forEach(([, expected], x) => {
      const actual = [...rendered.getImageData(x * 2, 0, 2, 2).data];
      expect(actual).toEqual(expected.flatMap((label) => pixels.get(label)!));
    });
  });

  it('renders sparse paint caches without drift and updates only tiles touched by appended strokes', async () => {
    const document = createIllustrationDocument('Sparse paint cache');
    document.artboard = { ...document.artboard, width: 768, height: 128, background: null };
    const paint = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing');
    paint.strokes.push(
      { id: 'left-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 32, y: 32, pressure: 0.5 }, { x: 96, y: 64, pressure: 0.5 }], color: '#d94a67', size: 12, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' },
      { id: 'right-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 544, y: 40, pressure: 0.5 }, { x: 608, y: 72, pressure: 0.5 }], color: '#449966', size: 10, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' },
    );
    const uncached = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 768, 128).data;
    expect(materializePaintTiles(document)).toEqual({ layers: 1, renderedTiles: 2, reusedTiles: 0 });
    expect(paint.tileCache?.strokeCount).toBe(2);
    expect(Object.keys(paint.tileAssetIds)).toEqual(['0,0', '2,0']);
    const cached = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 768, 128).data;
    expect(Buffer.from(cached)).toEqual(Buffer.from(uncached));

    const originalLeftAssetId = paint.tileAssetIds['0,0'];
    const originalRightAssetId = paint.tileAssetIds['2,0'];
    paint.strokes.push({ id: 'appended-left-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 128, y: 72, pressure: 0.5 }, { x: 192, y: 88, pressure: 0.5 }], color: '#3344cc', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const cachedWithTail = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 768, 128).data;
    const sourceOnly = structuredClone(document); const sourcePaint = Object.values(sourceOnly.layers).find((entry) => entry.type === 'paint'); if (!sourcePaint || sourcePaint.type !== 'paint') throw new Error('Paint layer missing'); sourcePaint.tileAssetIds = {}; delete sourcePaint.tileCache;
    const fullStrokeRender = (await renderIllustration(sourceOnly)).getContext('2d').getImageData(0, 0, 768, 128).data;
    expect(Buffer.from(cachedWithTail)).toEqual(Buffer.from(fullStrokeRender));

    expect(materializePaintTiles(document)).toEqual({ layers: 1, renderedTiles: 1, reusedTiles: 1 });
    expect(paint.tileCache?.strokeCount).toBe(3);
    expect(paint.tileAssetIds['0,0']).not.toBe(originalLeftAssetId);
    expect(paint.tileAssetIds['2,0']).toBe(originalRightAssetId);
    expect(document.assets[originalLeftAssetId]).toBeUndefined();
    const incrementallyMaterialized = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 768, 128).data;
    expect(Buffer.from(incrementallyMaterialized)).toEqual(Buffer.from(fullStrokeRender));
  });

  it('applies non-destructive blur to vector objects', async () => {
    const document = createIllustrationDocument('Vector blur'); document.artboard = { ...document.artboard, width: 80, height: 60, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape: ShapeObject = {
      id: 'blurred-shape', revision: 0, name: 'Blurred shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', blur: 6, transform: { ...IDENTITY_TRANSFORM, x: 30, y: 20 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ffcc55' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    const canvas = await renderIllustration(document); const context = canvas.getContext('2d');
    expect(context.getImageData(27, 30, 1, 1).data[3]).toBeGreaterThan(0);
    expect(context.getImageData(40, 30, 1, 1).data[3]).toBeGreaterThan(context.getImageData(27, 30, 1, 1).data[3]);
  });

  it('applies ordered adjustment stacks to non-image vector objects', async () => {
    const document = createIllustrationDocument('Vector adjustments'); document.artboard = { ...document.artboard, width: 40, height: 40, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape: ShapeObject = {
      id: 'adjusted-shape', revision: 0, name: 'Adjusted shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', filters: [{ type: 'brightness', value: -1 }, { type: 'contrast', value: 0.25 }], transform: { ...IDENTITY_TRANSFORM, x: 10, y: 10 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ffcc55' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    const data = (await renderIllustration(document)).getContext('2d').getImageData(20, 20, 1, 1).data;
    expect([...data.slice(0, 3)]).toEqual([0, 0, 0]); expect(data[3]).toBe(255);
  });

  it('isolates group opacity and filters before compositing overlapping children', async () => {
    const document = createIllustrationDocument('Isolated group'); document.artboard = { ...document.artboard, width: 50, height: 30, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape = (id: string, x: number): ShapeObject => ({
      id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y: 5 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ff8844' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });
    const first = shape('first', 5); const second = shape('second', 15);
    const group: GroupObject = { id: 'group', revision: 0, name: 'Filtered group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 0.5, blendMode: 'normal', filters: [{ type: 'brightness', value: -1 }], transform: IDENTITY_TRANSFORM, type: 'group', childIds: [first.id, second.id] };
    document.objects[first.id] = first; document.objects[second.id] = second; document.objects[group.id] = group; if (layer.type === 'vector') layer.objectIds.push(first.id, second.id, group.id);
    const context = (await renderIllustration(document)).getContext('2d'); const edge = context.getImageData(8, 10, 1, 1).data; const overlap = context.getImageData(18, 10, 1, 1).data;
    expect([...edge.slice(0, 3)]).toEqual([0, 0, 0]); expect([...overlap.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(overlap[3]).toBe(edge[3]); expect(edge[3]).toBeGreaterThanOrEqual(126); expect(edge[3]).toBeLessThanOrEqual(129);
  });

  it('applies a layer filter to its isolated composite', async () => {
    const document = createIllustrationDocument('Filtered layer'); document.artboard = { ...document.artboard, width: 30, height: 30, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; layer.filters = [{ type: 'brightness', value: -1 }]; const timestamp = nowIso();
    const shape: ShapeObject = { id: 'layer-shape', revision: 0, name: 'Layer shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 5, y: 5 }, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#55bbff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    expect([...(await renderIllustration(document)).getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)]).toEqual([0, 0, 0]);
  });
});

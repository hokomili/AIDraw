import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, encodeTiledGid, nowIso, writePixels, writeTiles, type CollisionShape, type DocumentAsset, type GroupObject, type ImageObject, type ShapeObject } from '@aidraw/core';
import { exportDocument } from '@main/export-document';
import { materializePaintTiles } from '@main/persistence';
import { renderIllustration, renderIllustrationRegion, renderSprite, renderSpriteRegion, renderTilemap, renderTilemapRegion } from '@main/render-document';

describe('native document rendering', () => {
  it('renders locality-safe illustration regions byte-exactly against full-raster crops', async () => {
    const document = createIllustrationDocument('Illustration region parity');
    document.artboard = { ...document.artboard, width: 96, height: 72, background: '#f8efe5' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const shape = (id: string, kind: ShapeObject['shape'], x: number, y: number, width: number, height: number, color: string): ShapeObject => ({
      id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y },
      type: 'shape', shape: kind, width, height, fill: { kind: 'solid', color },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });
    const rectangle = shape('rectangle', 'rectangle', 8, 7, 34, 26, '#ff6b7a');
    const polygon = { ...shape('polygon', 'polygon', 37, 23, 31, 29, '#f6c344'), sides: 7 };
    const star = { ...shape('star', 'star', 20, 20, 24, 24, '#5b78e680'), sides: 5, innerRadius: 0.38 };
    const phaseCases: ShapeObject[] = [
      rectangle,
      polygon,
      star,
      { ...shape('triangle', 'polygon', 9, 31, 35, 27, '#edc94880'), sides: 3 },
      { ...shape('polygon-many', 'polygon', 44, 17, 23, 37, '#b07aa180'), sides: 64 },
      { ...shape('polygon-maximum', 'polygon', 11, 9, 63, 47, '#ff9da780'), sides: 1_000 },
      { ...shape('star-dense', 'star', 55, 26, 21, 29, '#76b7b280'), sides: 17, innerRadius: 0.72 },
      { ...shape('star-hollow-center', 'star', 31, 35, 33, 19, '#e1575980'), sides: 8, innerRadius: 0.08 },
      { ...shape('star-zero-inner', 'star', 24, 12, 37, 41, '#9c755f80'), sides: 6, innerRadius: 0 },
      { ...shape('star-solid-center', 'star', 16, 16, 45, 39, '#4e79a780'), sides: 9, innerRadius: 1 },
    ];
    const parityRegions = [{ x: 9, y: 5, width: 75, height: 56 }, { x: 17, y: 13, width: 67, height: 51 }];
    for (const background of ['#f8efe5', null]) for (const candidate of phaseCases) for (const candidateRegion of parityRegions) {
      document.artboard.background = background;
      document.objects = { [candidate.id]: candidate }; layer.objectIds = [candidate.id];
      const candidateFull = await renderIllustration(document); const candidateActual = await renderIllustrationRegion(document, candidateRegion);
      expect(Buffer.from(candidateActual.getContext('2d').getImageData(0, 0, candidateRegion.width, candidateRegion.height).data), `${candidate.id}/${background ?? 'transparent'}/${candidateRegion.x},${candidateRegion.y}`).toEqual(Buffer.from(candidateFull.getContext('2d').getImageData(candidateRegion.x, candidateRegion.y, candidateRegion.width, candidateRegion.height).data));
      candidateFull.width = 1; candidateFull.height = 1; candidateActual.width = 1; candidateActual.height = 1;
    }
    document.artboard.background = '#f8efe5';
    const group: GroupObject = {
      id: 'group', revision: 0, name: 'group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 2, y: 1 },
      type: 'group', childIds: [rectangle.id, polygon.id, star.id],
    };
    document.objects = { [rectangle.id]: rectangle, [polygon.id]: polygon, [star.id]: star, [group.id]: group };
    layer.objectIds = [rectangle.id, polygon.id, star.id, group.id];
    const region = { x: 9, y: 5, width: 75, height: 56 };

    const full = await renderIllustration(document); const actual = await renderIllustrationRegion(document, region);
    expect({ width: actual.width, height: actual.height }).toEqual({ width: region.width, height: region.height });
    expect(Buffer.from(actual.getContext('2d').getImageData(0, 0, region.width, region.height).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
    full.width = 1; full.height = 1; actual.width = 1; actual.height = 1;
  });

  it('retains exact full-crop fallback for spatial illustration effects', async () => {
    const document = createIllustrationDocument('Illustration regional fallback');
    document.artboard = { ...document.artboard, width: 64, height: 48, background: null };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso(); const object: ShapeObject = {
      id: 'blurred', revision: 0, name: 'Blurred', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', blur: 6, transform: { ...IDENTITY_TRANSFORM, x: 20, y: 12 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#8268dd' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[object.id] = object; layer.objectIds.push(object.id);
    const region = { x: 13, y: 9, width: 31, height: 27 };

    const full = await renderIllustration(document); const actual = await renderIllustrationRegion(document, region);
    expect(Buffer.from(actual.getContext('2d').getImageData(0, 0, region.width, region.height).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
    full.width = 1; full.height = 1; actual.width = 1; actual.height = 1;
  });

  it('renders integer-phase embedded PNG regions byte-exactly against full-raster crops', async () => {
    const document = createIllustrationDocument('Illustration PNG region parity');
    document.artboard = { ...document.artboard, width: 96, height: 72, background: '#f8efe5' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const source = createCanvas(16, 12); const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#ff335580'; sourceContext.fillRect(0, 0, 8, 6);
    sourceContext.fillStyle = '#22aa66'; sourceContext.fillRect(8, 0, 8, 6);
    sourceContext.fillStyle = '#3355ff'; sourceContext.fillRect(0, 6, 8, 6);
    sourceContext.fillStyle = '#ffd84d40'; sourceContext.fillRect(8, 6, 8, 6);
    const bytes = source.toBuffer('image/png'); source.width = 1; source.height = 1;
    const asset: DocumentAsset = { id: 'regional-png', name: 'Regional PNG', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') };
    const timestamp = nowIso(); const base: ImageObject = {
      id: 'regional-image', revision: 0, name: 'Regional image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 31, y: 19 },
      type: 'image', assetId: asset.id, width: 16, height: 12, sourceWidth: 16, sourceHeight: 12, filters: [],
    };
    const phaseCases: ImageObject[] = [
      base,
      { ...base, id: 'upscaled', width: 32, height: 24 },
      { ...base, id: 'downscaled', width: 8, height: 6 },
      { ...base, id: 'cropped-native', width: 9, height: 7, crop: { x: 3, y: 2, width: 9, height: 7 } },
      { ...base, id: 'cropped-scaled', width: 27, height: 14, crop: { x: 3, y: 2, width: 9, height: 7 } },
    ];
    const regions = [{ x: 9, y: 5, width: 75, height: 56 }, { x: 17, y: 13, width: 67, height: 51 }];
    document.assets[asset.id] = asset;
    for (const background of ['#f8efe5', null]) for (const image of phaseCases) for (const region of regions) {
      document.artboard.background = background; document.objects = { [image.id]: image }; layer.objectIds = [image.id];
      const full = await renderIllustration(document); const regional = await renderIllustrationRegion(document, region);
      expect(Buffer.from(regional.getContext('2d').getImageData(0, 0, region.width, region.height).data), `${image.id}/${background ?? 'transparent'}/${region.x},${region.y}`).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
      full.width = 1; full.height = 1; regional.width = 1; regional.height = 1;
    }
    const group: GroupObject = {
      id: 'png-group', revision: 0, name: 'PNG group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 2, y: 1 },
      type: 'group', childIds: [base.id],
    };
    document.objects = { [base.id]: base, [group.id]: group }; layer.objectIds = [base.id, group.id];
    for (const background of ['#f8efe5', null]) for (const region of regions) {
      document.artboard.background = background;
      const full = await renderIllustration(document); const regional = await renderIllustrationRegion(document, region);
      expect(Buffer.from(regional.getContext('2d').getImageData(0, 0, region.width, region.height).data), `group/${background ?? 'transparent'}/${region.x},${region.y}`).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
      full.width = 1; full.height = 1; regional.width = 1; regional.height = 1;
    }
  });

  it('does not decode exact-subset images outside the regional backing', async () => {
    const document = createIllustrationDocument('Illustration regional object culling');
    document.artboard = { ...document.artboard, width: 8_192, height: 8_192, background: null };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const source = createCanvas(16, 16); source.getContext('2d').fillStyle = '#3355ff'; source.getContext('2d').fillRect(0, 0, 16, 16);
    const bytes = source.toBuffer('image/png'); const data = bytes.toString('base64'); source.width = 1; source.height = 1;
    let dataReads = 0;
    const asset: DocumentAsset = {
      id: 'distant-regional-png', name: 'Distant regional PNG', mimeType: 'image/png', byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', get data() { dataReads += 1; return data; },
    };
    const timestamp = nowIso(); const image: ImageObject = {
      id: 'distant-regional-image', revision: 0, name: 'Distant regional image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: structuredClone(IDENTITY_TRANSFORM),
      type: 'image', assetId: asset.id, width: 16, height: 16, sourceWidth: 16, sourceHeight: 16, filters: [],
    };
    const target: ShapeObject = {
      id: 'regional-cull-target', revision: 0, name: 'Regional cull target', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 8_176, y: 8_176 },
      type: 'shape', shape: 'rectangle', width: 16, height: 16, fill: { kind: 'solid', color: '#ff3366' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.assets[asset.id] = asset; document.objects = { [image.id]: image, [target.id]: target }; layer.objectIds = [image.id, target.id];

    const rendered = await renderIllustrationRegion(document, { x: 8_184, y: 8_184, width: 1, height: 1 });
    expect([...rendered.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([255, 51, 102, 255]);
    expect(dataReads).toBe(1);
    rendered.width = 1; rendered.height = 1;
  });

  it('renders a rectangular orthogonal cell at its authored aspect without resampling drift', async () => {
    const document = createPixelDocument('project', 'Orthogonal rectangular cell'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Rectangular tile', 3, 5); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 15 }, (_, offset) => ({ x: offset % 3, y: Math.floor(offset / 3), index: offset + 1 })));
    const tileset = createPixelTileset('Rectangular tile', sprite.id, 3, 5, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('One rectangle'); map.width = 1; map.height = 1; map.tileWidth = 3; map.tileHeight = 5; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d').getImageData(0, 0, 3, 5).data;
    const rendered = renderTilemap(document, map);
    expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 3, height: 5 });
    expect(Buffer.from(rendered.getContext('2d').getImageData(0, 0, 3, 5).data)).toEqual(Buffer.from(source));
    const exported = await exportDocument(document, 'png'); const image = await loadImage(exported.data);
    expect({ width: image.width, height: image.height }).toEqual({ width: 3, height: 5 });
  });

  it('renders orthogonal and isometric nominal regions byte-exactly against full-raster crops', () => {
    for (const orientation of ['orthogonal', 'isometric'] as const) {
      const document = createPixelDocument('tilemap', `${orientation} region parity`); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
      map.orientation = orientation; map.width = 4; map.height = 3; map.tileWidth = 4; map.tileHeight = 2;
      const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
      writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 2 }, { x: 1, y: 1, gid: 4 }, { x: 3, y: 2, gid: 8 }]);
      const timestamp = nowIso(); const objects: typeof map.layers[string] = {
        id: `${orientation}-objects`, revision: 0, name: 'Region object', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
        type: 'object', visible: true, locked: false, opacity: 0.6, parallaxX: 1, parallaxY: 1,
        objects: [{ id: `${orientation}-rectangle`, type: 'rectangle', x: 2, y: 1, width: 4, height: 2, properties: {} }],
      };
      map.layers[objects.id] = objects; map.layerIds.push(objects.id);
      const full = renderTilemap(document, map); const region = { x: 2, y: 1, width: 8, height: 5 };
      const actual = renderTilemapRegion(document, map, region);
      expect(Buffer.from(actual.getContext('2d').getImageData(0, 0, region.width, region.height).data), orientation).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
    }
  });

  it('renders a last-sheet tile from a maximum-size sparse sprite without materializing the full source', () => {
    const document = createPixelDocument('project', 'Maximum sparse tile source'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ff3366ff';
    const sprite = createPixelSprite('Maximum sparse sheet', 8_192, 8_192); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 8_191, y: 8_191, index: 2 }]);
    const tileset = createPixelTileset('Maximum sparse tiles', sprite.id, 16, 16, 512, 512); tileset.firstGid = 1;
    const lastLocalId = tileset.columns * tileset.rows - 1;
    const source = { x: 8_176, y: 8_176, width: 16, height: 16 };
    const bounded = renderSpriteRegion(document, sprite, source);
    expect({ width: bounded.canvas.width, height: bounded.canvas.height, sample: bounded.sample }).toEqual({ width: 16, height: 16, sample: { x: 0, y: 0, width: 16, height: 16 } });
    expect([...bounded.canvas.getContext('2d').getImageData(15, 15, 1, 1).data]).toEqual([255, 51, 102, 255]);
    bounded.canvas.width = 1; bounded.canvas.height = 1;

    const map = createPixelTilemap('One maximum-sheet tile'); map.width = 1; map.height = 1; map.tileWidth = 16; map.tileHeight = 16; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: tileset.firstGid + lastLocalId }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const rendered = renderTilemap(document, map);
    expect([...rendered.getContext('2d').getImageData(15, 15, 1, 1).data]).toEqual([255, 51, 102, 255]);
  });

  it('preserves fractional tile-source sampling and nominal edge clipping', () => {
    const document = createPixelDocument('project', 'Fractional tile source'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ff0000ff'; document.palette[3].color = '#00ff00ff'; document.palette[4].color = '#0000ffff';
    const sprite = createPixelSprite('Fractional sheet', 3, 1); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 3 }, { x: 2, y: 0, index: 4 }]);
    const tileset = createPixelTileset('Fractional tiles', sprite.id, 2, 1, 1, 1); tileset.firstGid = 1;
    tileset.tiles[0] = { id: 0, sourceX: 1.5, sourceY: 0, probability: 1, animation: [], collisions: [], properties: {} };
    const map = createPixelTilemap('Fractional tile map'); map.width = 1; map.height = 1; map.tileWidth = 4; map.tileHeight = 1; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const full = renderSprite(document, sprite); const expected = createCanvas(4, 1); expected.getContext('2d').imageSmoothingEnabled = false; expected.getContext('2d').drawImage(full, 1.5, 0, 2, 1, 0, 0, 4, 1);
    expect(Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 4, 1).data)).toEqual(Buffer.from(expected.getContext('2d').getImageData(0, 0, 4, 1).data));
  });

  it('renders placed tile animations at exact times while retaining the stored GID transform', async () => {
    const document = createPixelDocument('project', 'Animated tile surface'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Animated tile source', 6, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [
      { x: 0, y: 0, index: 15 },
      { x: 2, y: 0, index: 2 }, { x: 3, y: 0, index: 4 }, { x: 2, y: 1, index: 8 }, { x: 3, y: 1, index: 11 },
      { x: 4, y: 0, index: 12 }, { x: 5, y: 0, index: 9 }, { x: 4, y: 1, index: 6 }, { x: 5, y: 1, index: 3 },
    ]);
    const tileset = createPixelTileset('Animated tiles', sprite.id, 2, 2, 3, 1); tileset.firstGid = 1;
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, probability: 1, animation: [{ tileId: 1, durationMs: 80 }, { tileId: 2, durationMs: 120 }], collisions: [], properties: {} },
      1: { id: 1, sourceX: 2, sourceY: 0, probability: 1, animation: [], collisions: [], properties: {} },
      2: { id: 2, sourceX: 4, sourceY: 0, probability: 1, animation: [], collisions: [], properties: {} },
    };
    const map = createPixelTilemap('Animated map'); map.width = 1; map.height = 1; map.tileWidth = 2; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: encodeTiledGid(1, { hFlip: true }) }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d');
    const flippedSource = (sourceX: number) => {
      const data = source.getImageData(sourceX, 0, 2, 2).data;
      return Buffer.concat([Buffer.from(data.slice(4, 8)), Buffer.from(data.slice(0, 4)), Buffer.from(data.slice(12, 16)), Buffer.from(data.slice(8, 12))]);
    };
    const renderedAt = (timeMs?: number) => Buffer.from((timeMs === undefined ? renderTilemap(document, map) : renderTilemap(document, map, undefined, timeMs)).getContext('2d').getImageData(0, 0, 2, 2).data);
    expect(renderedAt()).toEqual(flippedSource(2));
    expect(renderedAt(79)).toEqual(flippedSource(2));
    expect(renderedAt(80)).toEqual(flippedSource(4));
    expect(renderedAt(199)).toEqual(flippedSource(4));
    expect(renderedAt(200)).toEqual(flippedSource(2));

    const exported = await exportDocument(document, 'png'); const image = await loadImage(exported.data); const exportCanvas = createCanvas(2, 2); exportCanvas.getContext('2d').drawImage(image, 0, 0);
    expect(exported.report).toEqual({ warnings: [], rasterized: [] });
    expect(Buffer.from(exportCanvas.getContext('2d').getImageData(0, 0, 2, 2).data)).toEqual(flippedSource(2));
  });

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

  it('includes visible orthogonal object layers in headless z-order and PNG export', async () => {
    const document = createPixelDocument('tilemap', 'Object-layer raster parity'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    map.width = 1; map.height = 1; map.tileWidth = 16; map.tileHeight = 16;
    const tileLayer = map.layers[map.layerIds[0]]; if (tileLayer.type !== 'tile' || !tileLayer.chunks) throw new Error('Expected tile layer');
    writeTiles(tileLayer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    const timestamp = nowIso(); const objectLayer: typeof map.layers[string] = {
      id: 'object-layer', revision: 0, name: 'Visible objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object', visible: true, locked: false, opacity: 1, parallaxX: 1, parallaxY: 1,
      objects: [{ id: 'object-rectangle', type: 'rectangle', x: 2, y: 2, width: 12, height: 12, properties: {} }],
    };
    const basePixel = [...renderTilemap(document, map).getContext('2d').getImageData(8, 8, 1, 1).data];
    map.layers[objectLayer.id] = objectLayer; map.layerIds.push(objectLayer.id);
    const abovePixel = [...renderTilemap(document, map).getContext('2d').getImageData(8, 8, 1, 1).data];
    expect(abovePixel).not.toEqual(basePixel);
    expect(renderTilemap(document, map, objectLayer.id).getContext('2d').getImageData(8, 8, 1, 1).data[3]).toBeGreaterThan(0);

    map.layerIds = [objectLayer.id, tileLayer.id];
    expect([...renderTilemap(document, map).getContext('2d').getImageData(8, 8, 1, 1).data]).toEqual(basePixel);
    map.layerIds = [tileLayer.id, objectLayer.id]; objectLayer.visible = false;
    expect([...renderTilemap(document, map).getContext('2d').getImageData(8, 8, 1, 1).data]).toEqual(basePixel);

    objectLayer.visible = true;
    const exported = await exportDocument(document, 'png'); const image = await loadImage(exported.data); const canvas = createCanvas(image.width, image.height); canvas.getContext('2d').drawImage(image, 0, 0);
    expect(exported.report).toEqual({ warnings: [], rasterized: [] });
    expect([...canvas.getContext('2d').getImageData(8, 8, 1, 1).data]).toEqual(abovePixel);
  });

  it('projects isometric object layers through authored aspect and opacity', () => {
    const document = createPixelDocument('tilemap', 'Isometric object-layer parity'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    map.orientation = 'isometric'; map.width = 1; map.height = 1; map.tileWidth = 8; map.tileHeight = 4;
    const timestamp = nowIso(); const objectLayer: typeof map.layers[string] = {
      id: 'isometric-objects', revision: 0, name: 'Isometric objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object', visible: true, locked: false, opacity: 0.5, parallaxX: 1, parallaxY: 1,
      objects: [{ id: 'isometric-cell', type: 'rectangle', x: 0, y: 0, width: 8, height: 4, properties: {} }],
    };
    map.layers = { [objectLayer.id]: objectLayer }; map.layerIds = [objectLayer.id];
    const rendered = renderTilemap(document, map); const context = rendered.getContext('2d');
    expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 8, height: 4 });
    expect(context.getImageData(4, 2, 1, 1).data[3]).toBeGreaterThanOrEqual(18);
    expect(context.getImageData(4, 2, 1, 1).data[3]).toBeLessThanOrEqual(20);
    objectLayer.visible = false;
    expect([...renderTilemap(document, map).getContext('2d').getImageData(0, 0, 8, 4).data].every((channel) => channel === 0)).toBe(true);
  });

  it('does not path-render a nonintersecting map object during regional rendering', () => {
    const document = createPixelDocument('tilemap', 'Object-region pruning'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    map.width = 100; map.height = 1; map.tileWidth = 16; map.tileHeight = 16;
    const timestamp = nowIso(); let farWidthReads = 0;
    const farObject = {
      id: 'far-object', type: 'rectangle', x: 1_000, y: 0, get width() { farWidthReads += 1; if (farWidthReads > 1) throw new Error('A nonintersecting map object was rendered.'); return 16; }, height: 16, properties: {},
    } as CollisionShape;
    const objectLayer: typeof map.layers[string] = {
      id: 'regional-objects', revision: 0, name: 'Regional objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object', visible: true, locked: false, opacity: 1, parallaxX: 1, parallaxY: 1,
      objects: [farObject, { id: 'near-object', type: 'rectangle', x: 2, y: 2, width: 8, height: 8, properties: {} }],
    };
    map.layers = { [objectLayer.id]: objectLayer }; map.layerIds = [objectLayer.id];
    const rendered = renderTilemapRegion(document, map, { x: 0, y: 0, width: 16, height: 16 });
    expect(farWidthReads).toBe(1);
    expect(rendered.getContext('2d').getImageData(6, 6, 1, 1).data[3]).toBeGreaterThan(0);
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

    for (const background of [null, '#f8efe5']) for (const region of [{ x: 512, y: 0, width: 128, height: 96 }, { x: 540, y: 21, width: 110, height: 80 }]) {
      document.artboard.background = background;
      const full = await renderIllustration(document); const regional = await renderIllustrationRegion(document, region);
      expect(Buffer.from(regional.getContext('2d').getImageData(0, 0, region.width, region.height).data), `${background ?? 'transparent'}/${region.x},${region.y}`).toEqual(Buffer.from(full.getContext('2d').getImageData(region.x, region.y, region.width, region.height).data));
      full.width = 1; full.height = 1; regional.width = 1; regional.height = 1;
    }
    document.artboard.background = null;

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

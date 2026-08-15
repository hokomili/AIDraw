import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, applyTransaction, bitmapTextCells, createId, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, deleteBitmapFontGlyph, editBitmapFontGlyph, encodeTiledGid, nowIso, renameBitmapFont, writePixels, writeTiles, type CollisionShape, type DocumentAsset, type GroupObject, type ImageObject, type ShapeObject } from '@aidraw/core';
import { exportDocument } from '@main/export-document';
import { materializePaintTiles } from '@main/persistence';
import { renderIllustration, renderIllustrationRegion, renderSprite, renderSpriteRegion, renderTilemap, renderTilemapRegion } from '@main/render-document';

describe('native document rendering', () => {
  it('renders and exports newly bundled printable-ASCII glyph pixels exactly', async () => {
    const document = createPixelDocument('sprite', 'Printable ASCII raster');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const cells = bitmapTextCells(document.bitmapFonts[0], 'go@', { x: 2, y: 3 });
    writePixels(cel, cells.map(({ x, y }) => ({ x, y, index: 1 })));

    const rendered = renderSprite(document, sprite);
    const renderedPixels = rendered.getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data;
    const occupied = new Set<string>();
    for (let y = 0; y < sprite.height; y += 1) for (let x = 0; x < sprite.width; x += 1) {
      const offset = (y * sprite.width + x) * 4;
      if (renderedPixels[offset + 3]) {
        occupied.add(`${x},${y}`);
        expect([...renderedPixels.slice(offset, offset + 4)]).toEqual([39, 33, 60, 255]);
      }
    }
    expect(occupied).toEqual(new Set(cells.map(({ x, y }) => `${x},${y}`)));

    const exported = await exportDocument(document, 'png');
    const exportedImage = await loadImage(exported.data);
    const exportedCanvas = createCanvas(exportedImage.width, exportedImage.height);
    exportedCanvas.getContext('2d').drawImage(exportedImage, 0, 0);
    expect(Buffer.from(exportedCanvas.getContext('2d').getImageData(0, 0, exportedImage.width, exportedImage.height).data)).toEqual(Buffer.from(renderedPixels));
  });

  it('keeps sprite and PNG export pixels exact while editing document-owned font assets', async () => {
    const document = createPixelDocument('sprite', 'Font-independent raster');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    writePixels(Object.values(sprite.cels)[0], [{ x: 1, y: 1, index: 4 }, { x: 2, y: 1, index: 5 }]);
    const beforeRaster = Buffer.from(renderSprite(document, sprite).getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data);
    const beforeExport = await exportDocument(document, 'png');
    const visualState = { pixelAssets: structuredClone(document.pixelAssets), palette: structuredClone(document.palette), activeAssetId: document.activeAssetId };

    const renamed = renameBitmapFont(document.bitmapFonts, structuredClone(document.bitmapFonts[0]), 'Interface');
    const edited = editBitmapFontGlyph(renamed.fonts, structuredClone(renamed.font), 'A', { width: 2, advance: 3, rows: ['#.', '##'] }, 8);
    const deleted = deleteBitmapFontGlyph(edited.fonts, structuredClone(edited.font), '?');
    const result = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Edit bitmap font', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: deleted.fonts }],
    });
    if (result.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const changedSprite = result.document.pixelAssets[result.document.activeAssetId];
    if (changedSprite.type !== 'sprite') throw new Error('Expected sprite');
    const afterRaster = Buffer.from(renderSprite(result.document, changedSprite).getContext('2d').getImageData(0, 0, changedSprite.width, changedSprite.height).data);
    const afterExport = await exportDocument(result.document, 'png');
    expect(afterRaster).toEqual(beforeRaster);
    expect(afterExport.data).toEqual(beforeExport.data);
    expect(result.document).toMatchObject(visualState);
  });

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

  it('renders native orthogonal artwork overhang in full and requested rasters without changing canonical or Tiled bytes', async () => {
    const document = createPixelDocument('project', 'Native orthogonal overhang'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ed3f5fff';
    const sprite = createPixelSprite('Six by eight tile', 6, 8); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 48 }, (_, offset) => ({ x: offset % 6, y: Math.floor(offset / 6), index: 2 })));
    const tileset = createPixelTileset('Six by eight tile', sprite.id, 6, 8, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Four-pixel cells'); map.width = 4; map.height = 33; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 3, y: 0, gid: 1 }, { x: 1, y: 32, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const canonical = structuredClone(document); const tiledBefore = await exportDocument(document, 'tiled-json');

    const full = renderTilemap(document, map); const requested = renderTilemapRegion(document, map, { x: 4, y: 124, width: 6, height: 4 });
    expect({ width: full.width, height: full.height }).toEqual({ width: 16, height: 132 });
    expect([...full.getContext('2d').getImageData(15, 0, 1, 1).data]).toEqual([237, 63, 95, 255]);
    expect(Buffer.from(requested.getContext('2d').getImageData(0, 0, 6, 4).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(4, 124, 6, 4).data));
    expect([...requested.getContext('2d').getImageData(0, 0, 6, 4).data].every((value, offset) => value === [237, 63, 95, 255][offset % 4])).toBe(true);

    const tiledAfter = await exportDocument(document, 'tiled-json');
    expect(document).toEqual(canonical);
    expect(tiledAfter).toEqual(tiledBefore);
  });

  it('applies a tileset drawing offset after native placement without expanding the nominal raster', () => {
    const document = createPixelDocument('project', 'Orthogonal tileset drawing offset'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ed3f5fff';
    const sprite = createPixelSprite('Offset source', 2, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 4 }, (_, offset) => ({ x: offset % 2, y: Math.floor(offset / 2), index: 2 })));
    const tileset = createPixelTileset('Offset tiles', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1; tileset.tileOffset = { x: 5, y: -3 };
    const map = createPixelTilemap('Nominal offset canvas'); map.width = 3; map.height = 2; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 1, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const canonical = structuredClone(document);

    const full = renderTilemap(document, map);
    const requested = renderTilemapRegion(document, map, { x: 5, y: 3, width: 2, height: 2 });
    expect({ width: full.width, height: full.height }).toEqual({ width: 12, height: 8 });
    expect([...full.getContext('2d').getImageData(5, 3, 1, 1).data]).toEqual([237, 63, 95, 255]);
    expect([...full.getContext('2d').getImageData(0, 6, 1, 1).data]).toEqual([0, 0, 0, 0]);
    expect(Buffer.from(requested.getContext('2d').getImageData(0, 0, 2, 2).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(5, 3, 2, 2).data));
    expect(document).toEqual(canonical);
  });

  it('retains a nominal-cell fallback when a smaller resolved tileset has no sprite source', () => {
    const document = createPixelDocument('project', 'Missing native tile source'); document.assetIds = []; document.pixelAssets = {};
    const tileset = createPixelTileset('Missing two-pixel source', 'missing-sprite', 2, 2, 1, 1); tileset.firstGid = 1; tileset.tileOffset = { x: 1_000, y: -1_000 };
    const map = createPixelTilemap('Sixteen-pixel fallback'); map.width = 1; map.height = 1; map.tileWidth = 16; map.tileHeight = 16; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    document.pixelAssets = { [tileset.id]: tileset, [map.id]: map }; document.assetIds = [tileset.id, map.id]; document.activeAssetId = map.id;

    const full = renderTilemap(document, map);
    const requested = renderTilemapRegion(document, map, { x: 15, y: 0, width: 1, height: 1 });
    const expected = full.getContext('2d').getImageData(15, 0, 1, 1).data;
    expect(expected[3]).toBe(255);
    expect(Buffer.from(requested.getContext('2d').getImageData(0, 0, 1, 1).data)).toEqual(Buffer.from(expected));
  });

  it('renders and region-culls aligned sprite-backed tile objects without changing nominal orthogonal output bounds', () => {
    const document = createPixelDocument('project', 'Orthogonal tile objects'); document.assetIds = []; document.pixelAssets = {}; document.palette[2].color = '#ed3f5fff';
    const sprite = createPixelSprite('Object source', 2, 2); writePixels(Object.values(sprite.cels)[0], Array.from({ length: 4 }, (_, index) => ({ x: index % 2, y: Math.floor(index / 2), index: 2 })));
    const tileset = createPixelTileset('Object tiles', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1; tileset.objectAlignment = 'bottomright'; tileset.tileOffset = { x: 1, y: -1 };
    const map = createPixelTilemap('Object map'); map.width = 4; map.height = 4; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.offsetX = 2; layer.objects = [{ id: 'chest', type: 'tile', gid: 1, x: 8, y: 8, width: 4, height: 4, rotation: 0, name: 'Chest', className: 'loot', properties: { coins: 3 } }];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id; const canonical = structuredClone(document);

    const full = renderTilemap(document, map); const requested = renderTilemapRegion(document, map, { x: 10, y: 3, width: 1, height: 1 });
    expect({ width: full.width, height: full.height }).toEqual({ width: 16, height: 16 });
    expect([...full.getContext('2d').getImageData(10, 3, 1, 1).data]).toEqual([237, 63, 95, 255]);
    expect(Buffer.from(requested.getContext('2d').getImageData(0, 0, 1, 1).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(10, 3, 1, 1).data));
    expect([...full.getContext('2d').getImageData(4, 4, 1, 1).data]).toEqual([0, 0, 0, 0]);
    expect(document).toEqual(canonical);
  });

  it('uses the same bounded alignment and culling contract for a resolved tile object with no sprite source', () => {
    const document = createPixelDocument('project', 'Missing tile-object source'); document.assetIds = []; document.pixelAssets = {};
    const tileset = createPixelTileset('Missing object tiles', 'missing-sprite', 2, 2, 1, 1); tileset.firstGid = 1; tileset.objectAlignment = 'bottomright'; tileset.tileOffset = { x: 1, y: -1 };
    const map = createPixelTilemap('Object fallback map'); map.width = 4; map.height = 4; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [{ id: 'fallback', type: 'tile', gid: 1, x: 8, y: 8, width: 4, height: 4, rotation: 0, name: 'Fallback', className: '', properties: {} }];
    document.pixelAssets = { [tileset.id]: tileset, [map.id]: map }; document.assetIds = [tileset.id, map.id]; document.activeAssetId = map.id;
    const full = renderTilemap(document, map); const requested = renderTilemapRegion(document, map, { x: 8, y: 3, width: 1, height: 1 });
    expect([...full.getContext('2d').getImageData(8, 3, 1, 1).data][3]).toBe(255);
    expect([...full.getContext('2d').getImageData(4, 4, 1, 1).data]).toEqual([0, 0, 0, 0]);
    expect(Buffer.from(requested.getContext('2d').getImageData(0, 0, 1, 1).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(8, 3, 1, 1).data));
  });

  it('shares isometric tile-object placement for sprite artwork and a bounded unresolved fallback', () => {
    const document = createPixelDocument('project', 'Isometric tile objects'); document.assetIds = []; document.pixelAssets = {}; document.palette[2].color = '#06d6a0ff';
    const sprite = createPixelSprite('Iso object source', 2, 3); writePixels(Object.values(sprite.cels)[0], Array.from({ length: 6 }, (_, index) => ({ x: index % 2, y: Math.floor(index / 2), index: 2 })));
    const tileset = createPixelTileset('Iso object tiles', sprite.id, 2, 3, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Iso object map'); map.orientation = 'isometric'; map.width = 4; map.height = 4; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [
      { id: 'sprite-object', type: 'tile', gid: 1, x: 8, y: 8, width: 4, height: 6, rotation: 0, name: 'Actor', className: 'npc', properties: {} },
      { id: 'fallback-object', type: 'tile', gid: 77, x: 12, y: 4, width: 2, height: 2, rotation: 0, name: 'Unknown', className: '', properties: {} },
    ];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const full = renderTilemap(document, map);
    expect({ width: full.width, height: full.height }).toEqual({ width: 16, height: 8 });
    expect([...full.getContext('2d').getImageData(3, 1, 1, 1).data]).toEqual([6, 214, 160, 255]);
    expect([...full.getContext('2d').getImageData(9, 3, 1, 1).data][3]).toBe(255);
  });

  it('applies raw diagonal tile-object pixels and samples the existing tile animation timeline', () => {
    const document = createPixelDocument('project', 'Transformed animated tile object'); document.assetIds = []; document.pixelAssets = {};
    const colors = ['#ef476fff', '#ffd166ff', '#06d6a0ff', '#118ab2ff', '#8338ecff', '#fb5607ff', '#3a86ffff', '#8ac926ff', '#31a6a0ff']; colors.forEach((color, index) => { document.palette[index + 2].color = color; });
    const sprite = createPixelSprite('Object animation source', 8, 2); const cel = Object.values(sprite.cels)[0]; writePixels(cel, [
      ...Array.from({ length: 8 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), index: index + 2 })),
      ...Array.from({ length: 8 }, (_, index) => ({ x: 4 + index % 4, y: Math.floor(index / 4), index: 10 })),
    ]);
    const tileset = createPixelTileset('Animated object tiles', sprite.id, 4, 2, 2, 1); tileset.firstGid = 1; tileset.objectAlignment = 'center'; tileset.tiles[0] = { id: 0, sourceX: 0, sourceY: 0, probability: 1, animation: [{ tileId: 0, durationMs: 50 }, { tileId: 1, durationMs: 50 }], collisions: [], properties: {} }; tileset.tiles[1] = { id: 1, sourceX: 4, sourceY: 0, probability: 1, animation: [], collisions: [], properties: {} };
    const map = createPixelTilemap('Object transform map'); map.width = 2; map.height = 2; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [{ id: 'animated', type: 'tile', gid: encodeTiledGid(1, { diagonal: true }), x: 4, y: 4, width: 4, height: 2, rotation: 0, name: 'Animated', className: '', properties: {} }];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const first = renderTilemap(document, map, undefined, 0); const second = renderTilemap(document, map, undefined, 60);
    expect([...first.getContext('2d').getImageData(3, 4, 1, 1).data]).toEqual([239, 71, 111, 255]);
    expect([...first.getContext('2d').getImageData(2, 1, 1, 1).data]).toEqual([138, 201, 38, 255]);
    expect([...second.getContext('2d').getImageData(3, 4, 1, 1).data]).toEqual([49, 166, 160, 255]);
  });

  it('preserves all eight Tiled transforms inside a native rectangular orthogonal footprint', () => {
    const document = createPixelDocument('project', 'Native rectangular transforms'); document.assetIds = []; document.pixelAssets = {};
    const colors = ['#ef476fff', '#ffd166ff', '#06d6a0ff', '#118ab2ff', '#8338ecff', '#fb5607ff', '#3a86ffff', '#8ac926ff'];
    colors.forEach((color, offset) => { document.palette[offset + 2].color = color; });
    const sprite = createPixelSprite('Four by two corners', 4, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 8 }, (_, offset) => ({ x: offset % 4, y: Math.floor(offset / 4), index: offset + 2 })));
    const tileset = createPixelTileset('Four by two corners', sprite.id, 4, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Native transform strip'); map.width = 8; map.height = 2; map.tileWidth = 6; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const cases = [
      [{}, ['0,2:A', '1,2:B', '2,2:C', '3,2:D', '0,3:E', '1,3:F', '2,3:G', '3,3:H']],
      [{ hFlip: true }, ['0,2:D', '1,2:C', '2,2:B', '3,2:A', '0,3:H', '1,3:G', '2,3:F', '3,3:E']],
      [{ vFlip: true }, ['0,2:E', '1,2:F', '2,2:G', '3,2:H', '0,3:A', '1,3:B', '2,3:C', '3,3:D']],
      [{ hFlip: true, vFlip: true }, ['0,2:H', '1,2:G', '2,2:F', '3,2:E', '0,3:D', '1,3:C', '2,3:B', '3,3:A']],
      [{ diagonal: true }, ['1,1:H', '2,1:D', '1,2:G', '2,2:C', '1,3:F', '2,3:B', '1,4:E', '2,4:A']],
      [{ diagonal: true, hFlip: true }, ['1,1:D', '2,1:H', '1,2:C', '2,2:G', '1,3:B', '2,3:F', '1,4:A', '2,4:E']],
      [{ diagonal: true, vFlip: true }, ['1,1:E', '2,1:A', '1,2:F', '2,2:B', '1,3:G', '2,3:C', '1,4:H', '2,4:D']],
      [{ diagonal: true, hFlip: true, vFlip: true }, ['1,1:A', '2,1:E', '1,2:B', '2,2:F', '1,3:C', '2,3:G', '1,4:D', '2,4:H']],
    ] as const;
    writeTiles(layer.chunks, cases.map(([transforms], x) => ({ x, y: 0, gid: encodeTiledGid(1, transforms) })));
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const source = renderSprite(document, sprite).getContext('2d').getImageData(0, 0, 4, 2).data;
    const labels = new Map(Array.from({ length: 8 }, (_, offset) => [Buffer.from(source.slice(offset * 4, offset * 4 + 4)).toString('hex'), String.fromCharCode(65 + offset)]));
    const rendered = renderTilemap(document, map).getContext('2d');
    cases.forEach(([, expected], cellX) => {
      const actual: string[] = [];
      const pixels = rendered.getImageData(cellX * 6, 0, 6, 8).data;
      for (let y = 0; y < 8; y += 1) for (let x = 0; x < 6; x += 1) {
        const offset = (y * 6 + x) * 4; if (!pixels[offset + 3]) continue;
        actual.push(`${x},${y}:${labels.get(Buffer.from(pixels.slice(offset, offset + 4)).toString('hex'))}`);
      }
      expect(actual, `transform case ${cellX}`).toEqual(expected);
    });
  });

  it('renders orthogonal and isometric nominal regions byte-exactly against full-raster crops', () => {
    for (const orientation of ['orthogonal', 'isometric'] as const) {
      const document = createPixelDocument('tilemap', `${orientation} region parity`); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
      map.orientation = orientation; map.width = 4; map.height = 3; map.tileWidth = 4; map.tileHeight = 2;
      const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
      writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 2 }, { x: 1, y: 1, gid: 4 }, { x: 3, y: 2, gid: 8 }]);
      const timestamp = nowIso(); const objects: typeof map.layers[string] = {
        id: `${orientation}-objects`, revision: 0, name: 'Region object', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
        type: 'object', visible: true, locked: false, opacity: 0.6, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
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

    const full = renderSprite(document, sprite); const expected = createCanvas(4, 1); expected.getContext('2d').imageSmoothingEnabled = false; expected.getContext('2d').drawImage(full, 1.5, 0, 2, 1, 0, 0, 2, 1);
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

  it('renders native offset isometric artwork and diagonal rectangular transforms without changing canonical or Tiled bytes', async () => {
    const document = createPixelDocument('project', 'Native isometric artwork'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ff0000ff'; document.palette[3].color = '#00ff00ff'; document.palette[4].color = '#0000ffff'; document.palette[5].color = '#ffff00ff';
    const sprite = createPixelSprite('Six by sixteen corners', 6, 16); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [
      { x: 0, y: 0, index: 2 },
      { x: 5, y: 0, index: 3 },
      { x: 0, y: 15, index: 4 },
      { x: 5, y: 15, index: 5 },
    ]);
    const tileset = createPixelTileset('Six by sixteen corners', sprite.id, 6, 16, 1, 1); tileset.firstGid = 1; tileset.tileOffset = { x: 2, y: -1 };
    const map = createPixelTilemap('Native isometric overhang'); map.orientation = 'isometric'; map.width = 3; map.height = 10; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 2, y: 8, gid: encodeTiledGid(1, { diagonal: true }) }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const canonical = structuredClone(document); const tiledBefore = await exportDocument(document, 'tiled-json');

    const full = renderTilemap(document, map); const context = full.getContext('2d');
    expect({ width: full.width, height: full.height }).toEqual({ width: 26, height: 13 });
    expect([...context.getImageData(8, 5, 1, 1).data]).toEqual([255, 255, 0, 255]);
    expect([...context.getImageData(23, 5, 1, 1).data]).toEqual([0, 255, 0, 255]);
    expect([...context.getImageData(8, 10, 1, 1).data]).toEqual([0, 0, 255, 255]);
    expect([...context.getImageData(23, 10, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(7, 5, 1, 1).data]).toEqual([0, 0, 0, 0]);
    const requested = renderTilemapRegion(document, map, { x: 23, y: 5, width: 1, height: 1 });
    expect([...requested.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([0, 255, 0, 255]);

    expect(document).toEqual(canonical);
    expect(await exportDocument(document, 'tiled-json')).toEqual(tiledBefore);
  });

  it('renders all eight Tiled transforms inside the same non-square isometric left/bottom anchor', () => {
    const document = createPixelDocument('project', 'Isometric rectangular transforms'); document.assetIds = []; document.pixelAssets = {};
    const colors = ['#ef476fff', '#ffd166ff', '#06d6a0ff', '#118ab2ff', '#8338ecff', '#fb5607ff', '#3a86ffff', '#8ac926ff'];
    colors.forEach((color, offset) => { document.palette[offset + 2].color = color; });
    const sprite = createPixelSprite('Four by two corners', 4, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 8 }, (_, offset) => ({ x: offset % 4, y: Math.floor(offset / 4), index: offset + 2 })));
    const tileset = createPixelTileset('Four by two corners', sprite.id, 4, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Isometric transform anchor'); map.orientation = 'isometric'; map.width = 3; map.height = 3; map.tileWidth = 6; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const source = renderSprite(document, sprite).getContext('2d').getImageData(0, 0, 4, 2).data;
    const labels = new Map(Array.from({ length: 8 }, (_, offset) => [Buffer.from(source.slice(offset * 4, offset * 4 + 4)).toString('hex'), String.fromCharCode(65 + offset)]));
    const cases = [
      [{}, ['6,6:A', '7,6:B', '8,6:C', '9,6:D', '6,7:E', '7,7:F', '8,7:G', '9,7:H']],
      [{ hFlip: true }, ['6,6:D', '7,6:C', '8,6:B', '9,6:A', '6,7:H', '7,7:G', '8,7:F', '9,7:E']],
      [{ vFlip: true }, ['6,6:E', '7,6:F', '8,6:G', '9,6:H', '6,7:A', '7,7:B', '8,7:C', '9,7:D']],
      [{ hFlip: true, vFlip: true }, ['6,6:H', '7,6:G', '8,6:F', '9,6:E', '6,7:D', '7,7:C', '8,7:B', '9,7:A']],
      [{ diagonal: true }, ['6,4:H', '7,4:D', '6,5:G', '7,5:C', '6,6:F', '7,6:B', '6,7:E', '7,7:A']],
      [{ diagonal: true, hFlip: true }, ['6,4:D', '7,4:H', '6,5:C', '7,5:G', '6,6:B', '7,6:F', '6,7:A', '7,7:E']],
      [{ diagonal: true, vFlip: true }, ['6,4:E', '7,4:A', '6,5:F', '7,5:B', '6,6:G', '7,6:C', '6,7:H', '7,7:D']],
      [{ diagonal: true, hFlip: true, vFlip: true }, ['6,4:A', '7,4:E', '6,5:B', '7,5:F', '6,6:C', '7,6:G', '6,7:D', '7,7:H']],
    ] as const;

    for (const [transforms, expected] of cases) {
      writeTiles(layer.chunks, [{ x: 1, y: 1, gid: encodeTiledGid(1, transforms) }]);
      const pixels = renderTilemap(document, map).getContext('2d').getImageData(0, 0, 18, 12).data;
      const actual: string[] = [];
      for (let y = 0; y < 12; y += 1) for (let x = 0; x < 18; x += 1) {
        const offset = (y * 18 + x) * 4; if (!pixels[offset + 3]) continue;
        actual.push(`${x},${y}:${labels.get(Buffer.from(pixels.slice(offset, offset + 4)).toString('hex'))}`);
      }
      expect(actual, JSON.stringify(transforms)).toEqual(expected);
    }
  });

  it('keeps an isometric missing-source fallback nominal and unoffset', () => {
    const document = createPixelDocument('project', 'Isometric missing source fallback'); document.assetIds = []; document.pixelAssets = {};
    const tileset = createPixelTileset('Missing source', 'missing-sprite', 1, 8, 1, 1); tileset.firstGid = 1; tileset.tileOffset = { x: 1_000, y: -1_000 };
    const map = createPixelTilemap('Nominal isometric fallback'); map.orientation = 'isometric'; map.width = 2; map.height = 2; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: encodeTiledGid(1, { diagonal: true }) }]);
    document.pixelAssets = { [tileset.id]: tileset, [map.id]: map }; document.assetIds = [tileset.id, map.id]; document.activeAssetId = map.id;

    const full = renderTilemap(document, map); const expected = full.getContext('2d').getImageData(5, 0, 1, 1).data;
    expect(expected[3]).toBe(255);
    expect(Buffer.from(renderTilemapRegion(document, map, { x: 5, y: 0, width: 1, height: 1 }).getContext('2d').getImageData(0, 0, 1, 1).data)).toEqual(Buffer.from(expected));
  });

  it('includes visible orthogonal object layers in headless z-order and PNG export', async () => {
    const document = createPixelDocument('tilemap', 'Object-layer raster parity'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    map.width = 1; map.height = 1; map.tileWidth = 16; map.tileHeight = 16;
    const tileLayer = map.layers[map.layerIds[0]]; if (tileLayer.type !== 'tile' || !tileLayer.chunks) throw new Error('Expected tile layer');
    writeTiles(tileLayer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    const timestamp = nowIso(); const objectLayer: typeof map.layers[string] = {
      id: 'object-layer', revision: 0, name: 'Visible objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object', visible: true, locked: false, opacity: 1, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
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
      type: 'object', visible: true, locked: false, opacity: 0.5, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
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
      type: 'object', visible: true, locked: false, opacity: 1, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
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

  it('composes orthogonal group and tile-layer offsets in full and requested rasters without changing nominal bounds', () => {
    const document = createPixelDocument('project', 'Orthogonal layer offsets'); document.assetIds = []; document.pixelAssets = {}; document.palette[2].color = '#ef476fff';
    const sprite = createPixelSprite('Offset tile pixels', 4, 4); writePixels(Object.values(sprite.cels)[0], Array.from({ length: 16 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), index: 2 })));
    const tileset = createPixelTileset('Offset tiles', sprite.id, 4, 4, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Offset map'); map.width = 4; map.height = 4; map.tileWidth = 4; map.tileHeight = 4; map.tilesetIds = [tileset.id];
    const tile = map.layers[map.layerIds[0]]; if (tile.type !== 'tile' || !tile.chunks) throw new Error('Expected tile layer'); tile.offsetX = 1; tile.offsetY = -1; writeTiles(tile.chunks, [{ x: 0, y: 0, gid: 1 }]);
    const timestamp = nowIso(); const group = {
      id: 'offset-group', revision: 0, name: 'Offset group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'group' as const, visible: true, locked: false, opacity: 1, offsetX: 3, offsetY: 2, parallaxX: 1, parallaxY: 1, childIds: [tile.id],
    };
    tile.parentId = group.id; map.layers[group.id] = group; map.layerIds = [group.id];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const full = renderTilemap(document, map); const region = renderTilemapRegion(document, map, { x: 4, y: 1, width: 4, height: 4 });
    expect({ width: full.width, height: full.height }).toEqual({ width: 16, height: 16 });
    expect(full.getContext('2d').getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect(full.getContext('2d').getImageData(4, 1, 4, 4).data.every((value, index) => index % 4 === 3 ? value === 255 : true)).toBe(true);
    expect(Buffer.from(region.getContext('2d').getImageData(0, 0, 4, 4).data)).toEqual(Buffer.from(full.getContext('2d').getImageData(4, 1, 4, 4).data));
  });

  it('translates isometric tile artwork and object overlays by the same composed map-pixel offset', () => {
    const document = createPixelDocument('project', 'Isometric layer offsets'); document.assetIds = []; document.pixelAssets = {}; document.palette[3].color = '#36c98fff';
    const sprite = createPixelSprite('Isometric tile pixels', 4, 2); writePixels(Object.values(sprite.cels)[0], Array.from({ length: 8 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), index: 3 })));
    const tileset = createPixelTileset('Isometric tiles', sprite.id, 4, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Isometric map'); map.orientation = 'isometric'; map.width = 3; map.height = 3; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const tile = map.layers[map.layerIds[0]]; if (tile.type !== 'tile' || !tile.chunks) throw new Error('Expected tile layer'); writeTiles(tile.chunks, [{ x: 1, y: 1, gid: 1 }]);
    const timestamp = nowIso(); const objectLayer = {
      id: 'offset-objects', revision: 0, name: 'Offset objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object' as const, visible: true, locked: false, opacity: 1, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
      objects: [{ id: 'offset-object', type: 'rectangle' as const, x: 4, y: 2, width: 3, height: 2, properties: {} }],
    };
    map.layers[objectLayer.id] = objectLayer; map.layerIds.push(objectLayer.id);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const beforeTile = renderTilemap(document, map, tile.id); const beforeObject = renderTilemap(document, map, objectLayer.id);
    tile.offsetX = 2; tile.offsetY = 1; objectLayer.offsetX = 2; objectLayer.offsetY = 1;
    const afterTile = renderTilemap(document, map, tile.id); const afterObject = renderTilemap(document, map, objectLayer.id);
    const shiftedExactly = (before: ReturnType<typeof renderTilemap>, after: ReturnType<typeof renderTilemap>) => {
      const source = before.getContext('2d').getImageData(0, 0, before.width, before.height).data; const target = after.getContext('2d').getImageData(0, 0, after.width, after.height).data;
      for (let y = 0; y < after.height; y += 1) for (let x = 0; x < after.width; x += 1) for (let channel = 0; channel < 4; channel += 1) expect(target[(y * after.width + x) * 4 + channel]).toBe(x >= 2 && y >= 1 ? source[((y - 1) * before.width + x - 2) * 4 + channel] : 0);
    };
    shiftedExactly(beforeTile, afterTile); shiftedExactly(beforeObject, afterObject);
  });
});

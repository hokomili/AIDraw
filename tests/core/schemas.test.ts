import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  CanvasTransactionSchema,
  ActorSchema,
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  IllustrationObjectAuthoringInputSchema,
  IllustrationObjectInputSchema,
  IllustrationObjectMutationInputSchema,
  MAX_EDITABLE_SVG_PATH_CHARACTERS,
  NewDocumentOptionsSchema,
  createIllustrationDocument,
  createId,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  createPredecessorDefaultBitmapFont,
  migrateDocument,
  materializeIllustrationObjectAuthoringInput,
  normalizeIllustrationObjectForReplacement,
  inspectEditableSvgPathData,
  inspectSvgPathData,
  nowIso,
  writePixels,
  writeTiles,
  type ShapeObject,
  type TilemapLayer,
} from '@aidraw/core';

describe('canvas operation schemas', () => {
  it('validates optional agent model, reasoning, and task metadata', () => {
    expect(ActorSchema.safeParse({ id: 'agent', kind: 'agent', name: 'Luna', color: '#8268dd', client: { model: 'luna', reasoningEffort: 'high', taskId: 'task-29' } }).success).toBe(true);
    expect(ActorSchema.safeParse({ id: 'agent', kind: 'agent', name: 'Luna', color: '#8268dd', client: { reasoningEffort: 'undefined' } }).success).toBe(false);
  });

  it('strictly validates the shared new-document contract', () => {
    expect(NewDocumentOptionsSchema.safeParse({
      kind: 'tilemap',
      name: 'Isometric world',
      width: 128,
      height: 96,
      orientation: 'isometric',
      infinite: true,
      tileWidth: 32,
      tileHeight: 16,
    }).success).toBe(true);
    for (const options of [
      { kind: 'illustration', width: 0 },
      { kind: 'sprite', height: 64.5 },
      { kind: 'illustration', background: 'transparent' },
      { kind: 'tilemap', tileWidth: 2048 },
      { kind: 'illustration', width: 64, surprise: true },
    ]) expect(NewDocumentOptionsSchema.safeParse(options).success).toBe(false);
  });

  it('accepts complete pixel changes and sprite assets', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
      changes: [{ x: 0, y: 31, index: 7 }],
      expectedRevision: 0,
    }).success).toBe(true);

    const guarded = {
      id: 'guarded-transaction', clientOperationId: 'guarded-operation', documentId: 'document-1', expectedDocumentRevision: 4,
      actor: HUMAN_ACTOR, label: 'Guarded pixels', createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: 'sprite-1', celId: 'cel-1', changes: [{ x: 0, y: 0, index: 1 }], expectedRevision: 0 }],
    };
    expect(CanvasTransactionSchema.safeParse(guarded).success).toBe(true);
    expect(CanvasTransactionSchema.safeParse({ ...guarded, expectedDocumentRevision: -1 }).success).toBe(false);
    expect(CanvasTransactionSchema.safeParse({ ...guarded, expectedDocumentRevision: 1.5 }).success).toBe(false);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.asset.add',
      asset: createPixelSprite('Validated sprite', 32, 32),
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.region', spriteId: 'sprite-1', celId: 'cel-1',
      runs: [{ x: 30, y: 2, length: 64, index: 7 }], expectedRevision: 0,
    }).success).toBe(true);
  });

  it('strictly distinguishes atlas slices from sparse image collections', () => {
    const source = createPixelSprite('Tile image', 2, 3);
    const collection = createPixelTileset('Collection', source.id, 2, 2, 1, 1);
    delete collection.spriteAssetId; collection.columns = 3; collection.rows = 0;
    collection.tiles = { 3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source.id, probability: 1, animation: [{ tileId: 3, durationMs: 100 }], collisions: [], properties: { kind: 'stone' } } };
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: collection }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: { ...collection, columns: -1 } }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: { ...collection, rows: 1 } }).success).toBe(false);
    const missingImage = structuredClone(collection); delete missingImage.tiles[3].imageAssetId;
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: missingImage }).success).toBe(false);
    const missingAnimationTarget = structuredClone(collection); missingAnimationTarget.tiles[3].animation[0].tileId = 2;
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: missingAnimationTarget }).success).toBe(false);
    const wangCollection = structuredClone(collection);
    wangCollection.wangSets = [{ id: 'sparse-wang', name: 'Sparse Wang', type: 'mixed', colors: [{ id: 1, name: 'Stone', color: '#777777', tileId: 3, probability: 1 }], tiles: [{ tileId: 3, wangId: [1, 1, 1, 1, 1, 1, 1, 1] }] }];
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: wangCollection }).success).toBe(true);
    const missingWangTile = structuredClone(wangCollection); missingWangTile.wangSets[0].tiles[0].tileId = 2;
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: missingWangTile }).success).toBe(false);
    const missingRepresentative = structuredClone(wangCollection); missingRepresentative.wangSets[0].colors[0].tileId = 2;
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: missingRepresentative }).success).toBe(false);
    const atlas = createPixelTileset('Atlas', source.id, 2, 2, 1, 1); atlas.tiles[0] = { ...collection.tiles[3], id: 0 };
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.add', asset: atlas }).success).toBe(false);

    const document = createPixelDocument('project', 'Persisted isometric collection');
    const map = createPixelTilemap('Sparse isometric map'); map.orientation = 'isometric'; map.infinite = true; map.tilesetIds = [collection.id];
    document.assetIds = [source.id, collection.id, map.id]; document.pixelAssets = { [source.id]: source, [collection.id]: collection, [map.id]: map }; document.activeAssetId = map.id;
    const migrated = migrateDocument(structuredClone(document));
    if (migrated.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(migrated.pixelAssets[map.id]).toMatchObject({ orientation: 'isometric', infinite: true, tilesetIds: [collection.id] });
  });

  it('rejects overlapping, oversized, and malformed compact region runs', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.cel.region', spriteId: 's', celId: 'c', runs: [{ x: 0, y: 0, length: 4, index: 1 }, { x: 3, y: 0, length: 2, index: 2 }] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.tilemap.region', mapId: 'm', layerId: 'l', runs: [{ x: 0, y: 0, length: 65_537, gid: 1 }] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.cel.region', spriteId: 's', celId: 'c', runs: Array.from({ length: 16 }, (_, index) => ({ x: index * 65_536, y: index, length: 65_536, index: 1 })) }).success).toBe(false);
  });

  it('rejects the malformed pixel playback payload that blanked the renderer', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
    }).success).toBe(false);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
      changes: [{ x: Number.NaN, y: 1, index: 2 }],
    }).success).toBe(false);
  });

  it('rejects unknown operation kinds and structurally incomplete asset replacement', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.magic', changes: [] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.asset.replace',
      asset: { id: 'sprite-1', name: 'Incomplete', type: 'sprite', tags: [] },
    }).success).toBe(false);
  });

  it('validates revision-checked illustration object moves', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.move',
      objectId: 'object-a',
      layerId: 'layer-b',
      index: 2,
      expectedRevision: 4,
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.move',
      objectId: '',
      layerId: 'layer-b',
      index: -1,
    }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.move', objectId: 'object-a', layerId: 'layer-b', groupIndex: 0,
    }).success).toBe(false);
  });

  it('fully validates every canonical illustration layer and object payload', () => {
    const document = createIllustrationDocument();
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const object = {
      id: 'schema-shape', revision: 0, name: 'Schema shape', createdAt: nowIso(), updatedAt: nowIso(), createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'shape' as const, shape: 'rectangle' as const, width: 12, height: 8, fill: { kind: 'solid' as const, color: '#ff6b7a' },
      cornerRadius: 0,
      stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
    };
    const valid = [
      { kind: 'illustration.layer.add', layer },
      { kind: 'illustration.layer.replace', layer, expectedRevision: 0 },
      { kind: 'illustration.layer.move', layerId: layer.id, expectedRevision: 0 },
      { kind: 'illustration.layer.delete', layerId: layer.id, expectedRevision: 0 },
      { kind: 'illustration.object.add', object },
      { kind: 'illustration.object.replace', object, expectedRevision: 0 },
      { kind: 'illustration.object.delete', objectId: object.id, expectedRevision: 0 },
    ];
    for (const operation of valid) expect(CanvasOperationSchema.safeParse(operation).success).toBe(true);

    const malformed = [
      { kind: 'illustration.layer.add', layer: { ...layer, objectIds: ['duplicate', 'duplicate'] } },
      { kind: 'illustration.layer.replace', layer: { ...layer, opacity: 2 } },
      { kind: 'illustration.object.add', object: { ...object, transform: { ...object.transform, x: Number.NaN } } },
      { kind: 'illustration.object.replace', object: { ...object, stroke: { ...object.stroke, width: -1 } } },
      { kind: 'illustration.object.add', object: { ...object, surprise: true } },
    ];
    for (const operation of malformed) expect(CanvasOperationSchema.safeParse(operation).success).toBe(false);
  });

  it('advertises and enforces only meaningful canonical fields for every shape subtype', () => {
    const document = createIllustrationDocument();
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const base = {
      id: 'strict-shape', revision: 0, name: 'Strict shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'shape' as const, width: 24, height: 18, fill: { kind: 'solid' as const, color: '#8268dd' },
      stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
    };
    const variants = [
      { shape: 'rectangle', replacement: { cornerRadius: 0 }, defaults: { cornerRadius: 0 }, forbidden: { sides: 7, innerRadius: 0.4 } },
      { shape: 'ellipse', replacement: {}, defaults: {}, forbidden: { sides: 7, innerRadius: 0.4, cornerRadius: 3 } },
      { shape: 'line', replacement: {}, defaults: {}, forbidden: { sides: 7, innerRadius: 0.4, cornerRadius: 3 } },
      { shape: 'arrow', replacement: {}, defaults: {}, forbidden: { sides: 7, innerRadius: 0.4, cornerRadius: 3 } },
      { shape: 'polygon', replacement: { sides: 6 }, defaults: { sides: 6 }, forbidden: { innerRadius: 0.4, cornerRadius: 3 } },
      { shape: 'star', replacement: { sides: 5, innerRadius: 0.45 }, defaults: { sides: 5, innerRadius: 0.45 }, forbidden: { cornerRadius: 3 } },
    ] as const;
    for (const variant of variants) {
      const fill = variant.shape === 'line' || variant.shape === 'arrow' ? { kind: 'none' as const } : base.fill;
      const object = { ...base, fill, id: `strict-${variant.shape}`, shape: variant.shape };
      const added = CanvasOperationSchema.safeParse({ kind: 'illustration.object.add', object });
      expect(added.success, `illustration.object.add:${variant.shape}`).toBe(true);
      if (added.success && 'object' in added.data) expect(added.data.object).toMatchObject(variant.defaults);
      const replaced = CanvasOperationSchema.safeParse({ kind: 'illustration.object.replace', object: { ...object, ...variant.replacement }, expectedRevision: 0 });
      expect(replaced.success, `illustration.object.replace:${variant.shape}`).toBe(true);
      if (replaced.success && 'object' in replaced.data) expect(replaced.data.object).toMatchObject(variant.replacement);
      for (const [field, value] of Object.entries(variant.forbidden)) {
        expect(CanvasOperationSchema.safeParse({ kind: 'illustration.object.add', object: { ...object, [field]: value } }).success, `${variant.shape}:${field}`).toBe(false);
        expect(CanvasOperationSchema.safeParse({ kind: 'illustration.object.replace', object: { ...object, ...variant.replacement, [field]: value }, expectedRevision: 0 }).success, `replace:${variant.shape}:${field}`).toBe(false);
      }
    }

    for (const shape of ['rectangle', 'polygon', 'star'] as const) {
      const fill = base.fill;
      expect(CanvasOperationSchema.safeParse({ kind: 'illustration.object.replace', object: { ...base, fill, id: `incomplete-${shape}`, shape }, expectedRevision: 0 }).success).toBe(false);
    }
    for (const shape of ['line', 'arrow'] as const) {
      expect(CanvasOperationSchema.safeParse({ kind: 'illustration.object.replace', object: { ...base, id: `filled-${shape}`, shape }, expectedRevision: 0 }).success).toBe(false);
    }

    const legacy = createIllustrationDocument('Legacy shape compatibility');
    const legacyLayer = Object.values(legacy.layers).find((entry) => entry.type === 'vector');
    if (!legacyLayer || legacyLayer.type !== 'vector') throw new Error('Expected legacy vector layer');
    const legacyRectangle = { ...base, id: 'legacy-rectangle', layerId: legacyLayer.id, shape: 'rectangle' as const, sides: 777 };
    legacy.objects[legacyRectangle.id] = legacyRectangle;
    legacyLayer.objectIds.push(legacyRectangle.id);
    expect(migrateDocument(legacy)).toMatchObject({ objects: { [legacyRectangle.id]: { shape: 'rectangle', sides: 777 } } });
    const normalizedLegacy = normalizeIllustrationObjectForReplacement(legacyRectangle as ShapeObject);
    expect(normalizedLegacy).toMatchObject({ id: legacyRectangle.id, shape: 'rectangle', cornerRadius: 0 });
    expect(normalizedLegacy).not.toHaveProperty('sides');

    for (const shape of ['rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'star'] as const) {
      const predecessor = {
        ...base,
        id: `predecessor-${shape}`,
        shape,
        sides: shape === 'star' ? 5 : 6,
        innerRadius: 0.46,
        cornerRadius: shape === 'rectangle' ? 12 : undefined,
        fill: shape === 'line' || shape === 'arrow' ? { kind: 'none' as const } : base.fill,
      } as ShapeObject;
      const normalized = normalizeIllustrationObjectForReplacement(predecessor);
      expect(CanvasOperationSchema.safeParse({ kind: 'illustration.object.replace', object: normalized, expectedRevision: 0 }).success, shape).toBe(true);
      expect(normalized).toEqual(expect.objectContaining(shape === 'rectangle' ? { cornerRadius: 12 } : shape === 'polygon' ? { sides: 6 } : shape === 'star' ? { sides: 5, innerRadius: 0.46 } : {}));
      if (shape !== 'rectangle') expect(normalized).not.toHaveProperty('cornerRadius');
      if (shape !== 'polygon' && shape !== 'star') expect(normalized).not.toHaveProperty('sides');
      if (shape !== 'star') expect(normalized).not.toHaveProperty('innerRadius');
    }
  });

  it('retains shared group and text invariants across the strict mutation union', () => {
    const timestamp = nowIso();
    const common = {
      revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: 'vector-layer', visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
    };
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.add',
      object: { ...common, id: 'duplicate-group', name: 'Duplicate group', type: 'group', childIds: ['child', 'child'] },
    }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({
      kind: 'illustration.object.replace', expectedRevision: 0,
      object: {
        ...common, id: 'overflow-text', name: 'Overflow text', type: 'text', text: 'x', width: 10, height: 10, align: 'left', lineHeight: 1.2,
        ranges: [{ start: 0, end: 2, fontFamily: 'sans-serif', fontSize: 12, fontWeight: 400, fontStyle: 'normal', color: '#000000', letterSpacing: 0 }],
      },
    }).success).toBe(false);
  });

  it('materializes strict public illustration drafts with deterministic defaults and server-owned metadata', () => {
    const draft = {
      id: 'public-shape',
      name: 'Public shape',
      layerId: 'vector-layer',
      type: 'shape' as const,
      shape: 'rectangle' as const,
      width: 120,
      height: 80,
      transform: { x: 12, y: 18 },
      fill: { kind: 'solid' as const, color: '#8268dd' },
      revision: 99,
      createdAt: 'forged-created-at',
      updatedAt: 'forged-updated-at',
      createdBy: 'forged-actor',
    };
    expect(IllustrationObjectAuthoringInputSchema.safeParse(draft).success).toBe(true);
    expect(materializeIllustrationObjectAuthoringInput(draft, 'authenticated-agent', '2026-08-24T00:00:00.000Z')).toEqual({
      id: 'public-shape', revision: 0, name: 'Public shape', createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', createdBy: 'authenticated-agent',
      layerId: 'vector-layer', visible: true, locked: false, opacity: 1, blendMode: 'normal',
      transform: { x: 12, y: 18, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
      type: 'shape', shape: 'rectangle', width: 120, height: 80, cornerRadius: 0, fill: { kind: 'solid', color: '#8268dd' },
      stroke: { paint: { kind: 'solid', color: '#000000' }, width: 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });

    const common = { name: 'Variant', layerId: 'vector-layer' };
    for (const variant of [
      { ...common, id: 'public-line', type: 'shape', shape: 'line', width: 80, height: 0 },
      { ...common, id: 'public-path', type: 'path', pathData: 'M0 0 L20 20' },
      { ...common, id: 'public-stroke', type: 'vector-stroke', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      { ...common, id: 'public-text', type: 'text', text: 'Editable' },
      { ...common, id: 'public-image', type: 'image', assetId: 'embedded-image', width: 32, height: 24 },
      { ...common, id: 'public-group', type: 'group' },
    ]) expect(IllustrationObjectAuthoringInputSchema.safeParse(variant).success).toBe(true);
    expect(materializeIllustrationObjectAuthoringInput({ ...common, id: 'public-line', type: 'shape', shape: 'line', width: 80, height: 0 }, 'authenticated-agent', '2026-08-24T00:00:00.000Z')).toMatchObject({
      fill: { kind: 'none' },
      stroke: { paint: { kind: 'solid', color: '#000000' }, width: 1 },
    });
    expect(materializeIllustrationObjectAuthoringInput({ ...common, id: 'public-polygon', type: 'shape', shape: 'polygon', width: 80, height: 60 }, 'authenticated-agent', '2026-08-24T00:00:00.000Z')).toMatchObject({ sides: 6 });
    expect(materializeIllustrationObjectAuthoringInput({ ...common, id: 'public-star', type: 'shape', shape: 'star', width: 80, height: 60 }, 'authenticated-agent', '2026-08-24T00:00:00.000Z')).toMatchObject({ sides: 5, innerRadius: 0.45 });
    expect(materializeIllustrationObjectAuthoringInput({ ...common, id: 'public-closed-path', type: 'path', pathData: 'M0 0 L10 0 L10 10 Z' }, 'authenticated-agent', '2026-08-24T00:00:00.000Z')).toMatchObject({ closed: true });

    for (const malformed of [
      { ...draft, surprise: true },
      { ...draft, fill: { kind: 'solid', color: 'purple' } },
      { ...draft, transform: { x: Number.NaN } },
      { ...draft, stroke: { paint: { kind: 'none' }, width: -1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } },
      { ...common, id: 'irrelevant-rectangle-sides', type: 'shape', shape: 'rectangle', width: 80, height: 60, sides: 7 },
      { ...common, id: 'irrelevant-ellipse-radius', type: 'shape', shape: 'ellipse', width: 80, height: 60, cornerRadius: 4 },
      { ...common, id: 'irrelevant-polygon-radius', type: 'shape', shape: 'polygon', width: 80, height: 60, innerRadius: 0.5 },
      { ...common, id: 'irrelevant-star-corner', type: 'shape', shape: 'star', width: 80, height: 60, cornerRadius: 4 },
      { ...common, id: 'malformed-path', type: 'path', pathData: 'not-valid-path-data' },
      { ...common, id: 'inconsistent-path', type: 'path', pathData: 'M0 0 L10 0', closed: true },
      { ...common, id: 'partial-image-size', type: 'image', assetId: 'embedded-image', width: 32, height: 24, sourceWidth: 32 },
    ]) expect(IllustrationObjectAuthoringInputSchema.safeParse(malformed).success).toBe(false);
  });

  it('validates bounded SVG path grammar and reports final authored closure', () => {
    expect(inspectSvgPathData('M 0 0 C 10 0 10 10 20 10 A 5 6 30 0 1 30 20 Z')).toMatchObject({ closed: true, segmentCount: 3 });
    expect(inspectSvgPathData('m.5-.5 10 0 0 10')).toMatchObject({ closed: false, segmentCount: 3 });
    expect(inspectSvgPathData('M0 0 H10 V10 M20 20 q5 5 10 0')).toMatchObject({ closed: false });
    expect(inspectSvgPathData('M0 0 A1 2 0 013 4')).toMatchObject({ closed: false, segmentCount: 2 });
    expect(inspectSvgPathData('M0 0 A1 2 0 01 3 4')).toMatchObject({ closed: false, segmentCount: 2 });
    for (const malformed of [
      'not-valid-path-data',
      'L0 0',
      'M0',
      'M0 0 L10',
      'M0 0 A-1 2 0 0 1 3 4',
      'M0 0 A1 2 0 2 0 3 4',
      'M0 0 A1 2 0 1e0 0 3 4',
      'M0 0 A1 2 0 0.0 1 3 4',
      'M0 0 A1 2 0 -0 1 3 4',
      'M0 0 L10 10 garbage',
      'M0 0,',
      'M0,,0',
      'M,0 0',
      'M1e999 0 L0 0',
    ]) expect(() => inspectSvgPathData(malformed), malformed).toThrow();
  });

  it('narrows new path admission to one node-editable subpath and a post-arc node budget', () => {
    expect(inspectEditableSvgPathData('M0 0 L10 10')).toMatchObject({ subpathCount: 1, segmentCount: 2, editableNodeUpperBound: 2, effectiveNodeLowerBound: 2, hasArc: false });
    expect(inspectEditableSvgPathData('M0 0 10 10')).toMatchObject({ subpathCount: 1, segmentCount: 2, editableNodeUpperBound: 2, effectiveNodeLowerBound: 2 });
    expect(inspectEditableSvgPathData('M0 0 A1 2 0 013 4')).toMatchObject({ subpathCount: 1, segmentCount: 2, editableNodeUpperBound: 5, effectiveNodeLowerBound: 3, hasArc: true });
    expect(inspectEditableSvgPathData('M0 0 A10 10 0 0 1 0.000002 0')).toMatchObject({ effectiveNodeLowerBound: 2, hasArc: true });
    expect(inspectEditableSvgPathData('M0 0 A1 1000 0 0 0 0 0.001')).toMatchObject({ effectiveNodeLowerBound: 2, hasArc: true });
    expect(inspectEditableSvgPathData('m5 5 l10 0 l0 10 z')).toMatchObject({ closed: true, effectiveNodeLowerBound: 3 });
    for (const incompatible of [
      'M0 0',
      'M0 0 L1 1 M2 2 L3 3',
      'M0 0 Z L1 1',
      'M0 0 L0 0 Z',
      'M0 0 L0.00000001 0 Z',
      'M0 0 C1 1 2 2 0 0 Z',
      'M0 0 A10 10 0 0 1 0 0',
      'M0 0 A10 10 0 0 1 0.000001 0',
      'M0 0 A1 1000 0 0 0 0 0.00001',
    ]) expect(() => inspectEditableSvgPathData(incompatible), incompatible).toThrow();

    const excessiveNodes = `M0 0${' L1 1'.repeat(7_000)}`;
    expect(excessiveNodes.length).toBeLessThan(MAX_EDITABLE_SVG_PATH_CHARACTERS);
    expect(inspectSvgPathData(excessiveNodes)).toMatchObject({ segmentCount: 7_001 });
    expect(() => inspectEditableSvgPathData(excessiveNodes)).toThrow('7,000 nodes after arc conversion');

    const excessiveConvertedArcs = `M0 0${' a1 1 0 0 1 2 2'.repeat(1_750)}`;
    expect(excessiveConvertedArcs.length).toBeLessThan(MAX_EDITABLE_SVG_PATH_CHARACTERS);
    expect(() => inspectEditableSvgPathData(excessiveConvertedArcs)).toThrow('7,000 nodes after arc conversion');

    const publicPath = { id: 'strict-topology', name: 'Strict topology', layerId: 'vector-layer', type: 'path' as const, pathData: 'M0 0 L1 1' };
    expect(IllustrationObjectAuthoringInputSchema.safeParse(publicPath).success).toBe(true);
    for (const pathData of ['M0 0', 'M0 0 L1 1 M2 2 L3 3', 'M0 0 L0.00000001 0 Z', 'M0 0 A10 10 0 0 1 0 0', 'M0 0 A10 10 0 0 1 0.000001 0', 'M0 0 A1 1000 0 0 0 0 0.00001', excessiveNodes, excessiveConvertedArcs]) {
      expect(IllustrationObjectAuthoringInputSchema.safeParse({ ...publicPath, pathData }).success, pathData.slice(0, 80)).toBe(false);
    }
    const timestamp = nowIso();
    const passive = {
      ...publicPath,
      revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      closed: false, fill: { kind: 'none' as const },
      stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
      fillRule: 'nonzero' as const,
    };
    for (const pathData of ['M0 0', 'M0 0 L1 1 M2 2 L3 3', 'M0 0 L0.00000001 0 Z', 'M0 0 A10 10 0 0 1 0 0', 'M0 0 A10 10 0 0 1 0.000001 0', 'M0 0 A1 1000 0 0 0 0 0.00001']) {
      expect(IllustrationObjectInputSchema.safeParse({ ...passive, pathData }).success).toBe(true);
      expect(IllustrationObjectMutationInputSchema.safeParse({ ...passive, pathData }).success).toBe(false);
    }
  });

  it('keeps passive predecessor paths readable while strict editing shares the one-million-character workflow limit', () => {
    const pathData = `M0 0 A1 1 0 0 1 2 2 ${'L0 0 '.repeat(200_000)}`;
    expect(pathData.length).toBeGreaterThan(MAX_EDITABLE_SVG_PATH_CHARACTERS);
    expect(pathData.length).toBeLessThanOrEqual(2_000_000);
    const timestamp = nowIso();
    const object = {
      id: 'passive-large-path', revision: 0, name: 'Passive large path', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: 'vector-layer', visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'path' as const, pathData, closed: false, fill: { kind: 'none' as const },
      stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] }, fillRule: 'nonzero' as const,
    };
    expect(IllustrationObjectInputSchema.safeParse(object).success).toBe(true);
    expect(IllustrationObjectMutationInputSchema.safeParse(object).success).toBe(false);
    expect(IllustrationObjectAuthoringInputSchema.safeParse(object).success).toBe(false);
    expect(() => inspectSvgPathData(pathData)).toThrow('1–1,000,000 characters');
  });

  it('strictly validates revision-checked artboard updates', () => {
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.replace', artboard: { width: 800, height: 600, background: null, colorSpace: 'srgb', dpi: 144 }, expectedRevision: 2 }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.translate', artboard: { width: 1024, height: 768, background: null, colorSpace: 'srgb', dpi: 144 }, offsetX: 112, offsetY: 84, expectedRevision: 2 }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.translate', artboard: { width: 1024, height: 768, background: null, colorSpace: 'srgb', dpi: 144 }, offsetX: 1.5, offsetY: 0 }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'illustration.artboard.replace', artboard: { width: 0, height: 600, background: 'white', colorSpace: 'display-p3', dpi: 0 } }).success).toBe(false);
  });

  it('rejects an asset replacement containing an incomplete nested cel', () => {
    const sprite = createPixelSprite('Malformed nested cel', 32, 32);
    const layerId = sprite.layerIds[0];
    const frameId = sprite.frameIds[0];
    (sprite.cels as Record<string, unknown>)['cel-without-chunks'] = {
      id: 'cel-without-chunks',
      frameId,
      layerId,
    };
    const parsed = CanvasOperationSchema.safeParse({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: 0 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes('chunks'))).toBe(true);
  });

  it('rejects a malformed operation inside an otherwise valid transaction', () => {
    const transaction = {
      id: createId('tx'),
      clientOperationId: createId('client-op'),
      documentId: createId('doc'),
      actor: HUMAN_ACTOR,
      label: 'Malformed trace',
      createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: 'sprite-1', celId: 'cel-1' }],
      playback: { mode: 'animated', speed: 1 },
    };
    expect(CanvasTransactionSchema.safeParse(transaction).success).toBe(false);
  });

  it('strictly validates indexed-image conversion settings', () => {
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.conversion.replace',
      conversionDefaults: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.5 },
    }).success).toBe(true);
    for (const conversionDefaults of [
      { resample: 'nearest', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'rgb', dithering: 'none', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'random', alphaThreshold: 0.5 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: -0.01 },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: Number.NaN },
      { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5, surprise: true },
    ]) expect(CanvasOperationSchema.safeParse({ kind: 'pixel.conversion.replace', conversionDefaults }).success).toBe(false);
  });

  it('validates portable, hash-pinned pixel project links', () => {
    const sha256 = 'a'.repeat(64);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace',
      linkedAssets: [{ id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: '../art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' }],
    }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace',
      linkedAssets: [{ id: 'link-b', name: 'packed tiles', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-b' }],
    }).success).toBe(true);

    for (const link of [
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'C:/art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'art\\tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', sha256, cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'linked', relativePath: 'art/tiles.png', cachedPreviewAssetId: 'cache-a' },
      { id: 'link-a', name: 'tiles.png', mode: 'embedded', relativePath: 'art/tiles.png', sha256, cachedPreviewAssetId: 'cache-a' },
    ]) expect(CanvasOperationSchema.safeParse({ kind: 'pixel.links.replace', linkedAssets: [link] }).success).toBe(false);

    expect(CanvasOperationSchema.safeParse({
      kind: 'pixel.links.replace', linkedAssets: [
        { id: 'duplicate', name: 'one.png', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-a' },
        { id: 'duplicate', name: 'two.png', mode: 'embedded', sha256, cachedPreviewAssetId: 'cache-b' },
      ],
    }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.links.replace', linkedAssets: [], expectedRevision: -1 }).success).toBe(false);
  });
});

describe('persisted attribution schemas', () => {
  function attributedDocument() {
    const document = createIllustrationDocument('Persisted attribution');
    document.activity = [{
      id: 'activity-persisted', transactionId: 'transaction-persisted', actor: HUMAN_ACTOR,
      label: 'Persisted edit', timestamp: nowIso(), status: 'committed', operationCount: 1,
      details: 'Exact activity detail',
    }];
    document.provenance = [{
      id: 'provenance-persisted', assetId: 'asset-output-not-present', provider: 'external',
      modelOrWorkflow: 'Offline imported result', sourceAssetIds: ['asset-source-not-present'],
      createdAt: nowIso(), conversion: { resample: 'area' },
    }];
    return document;
  }

  it('accepts exact activity and provenance while preserving missing-reference recovery', () => {
    const source = attributedDocument();
    const migrated = migrateDocument(source);
    expect(migrated.activity).toEqual(source.activity);
    expect(migrated.provenance).toEqual(source.provenance);
  });

  it('rejects malformed, expanded, and duplicate persisted activity entries', () => {
    const candidates = [
      (document: ReturnType<typeof attributedDocument>) => { (document.activity[0] as unknown as Record<string, unknown>).actor = null; },
      (document: ReturnType<typeof attributedDocument>) => { (document.activity[0] as unknown as Record<string, unknown>).status = 'invented'; },
      (document: ReturnType<typeof attributedDocument>) => { (document.activity[0] as unknown as Record<string, unknown>).operationCount = Number.MAX_SAFE_INTEGER + 1; },
      (document: ReturnType<typeof attributedDocument>) => { (document.activity[0] as unknown as Record<string, unknown>).unexpected = true; },
      (document: ReturnType<typeof attributedDocument>) => { document.activity.push(structuredClone(document.activity[0])); },
    ];
    for (const mutate of candidates) {
      const document = attributedDocument(); mutate(document);
      expect(() => migrateDocument(document)).toThrow('Invalid persisted document activity metadata.');
    }
  });

  it('rejects malformed, expanded, and duplicate persisted provenance entries', () => {
    const candidates = [
      (document: ReturnType<typeof attributedDocument>) => { (document.provenance[0] as unknown as Record<string, unknown>).provider = 'invented'; },
      (document: ReturnType<typeof attributedDocument>) => { (document.provenance[0] as unknown as Record<string, unknown>).sourceAssetIds = 'asset-source'; },
      (document: ReturnType<typeof attributedDocument>) => { (document.provenance[0] as unknown as Record<string, unknown>).conversion = []; },
      (document: ReturnType<typeof attributedDocument>) => { (document.provenance[0] as unknown as Record<string, unknown>).unexpected = true; },
      (document: ReturnType<typeof attributedDocument>) => { document.provenance.push(structuredClone(document.provenance[0])); },
    ];
    for (const mutate of candidates) {
      const document = attributedDocument(); mutate(document);
      expect(() => migrateDocument(document)).toThrow('Invalid persisted document provenance metadata.');
    }
  });
});

describe('persisted illustration schemas', () => {
  function illustrationDocument() {
    const document = createIllustrationDocument('Persisted illustration');
    const vector = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const object: ShapeObject = {
      id: 'persisted-shape', revision: 0, name: 'Persisted shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM },
      type: 'shape', shape: 'rectangle', width: 32, height: 24, fill: { kind: 'solid', color: '#336699' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[object.id] = object; vector.objectIds.push(object.id);
    document.brushPresets = [{
      id: 'persisted-brush', name: 'Persisted brush', size: 12, opacity: 1, hardness: 1, flow: 1,
      dynamics: { tip: 'round', spacing: 0.1, stabilization: 0, scatter: 0, sizeJitter: 0, opacityJitter: 0, angle: 0, roundness: 1, wetness: 0, granulation: 0 },
    }];
    document.guides = [{ id: 'persisted-guide', orientation: 'vertical', position: 16, color: '#55aaff', locked: false }];
    return document;
  }

  function vectorLayer(document: ReturnType<typeof illustrationDocument>) {
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    return layer;
  }

  it('validates complete illustration records while preserving missing-reference recovery', () => {
    const source = illustrationDocument(); const vector = vectorLayer(source); const object = source.objects['persisted-shape'];
    source.layerIds.push('missing-root-layer'); vector.objectIds.push('missing-object'); vector.maskLayerId = 'missing-mask-layer'; object.maskObjectId = 'missing-mask-object';
    const migrated = migrateDocument(source);
    expect(migrated).toMatchObject({
      layerIds: expect.arrayContaining(['missing-root-layer']),
      layers: { [vector.id]: { objectIds: expect.arrayContaining(['missing-object']), maskLayerId: 'missing-mask-layer' } },
      objects: { [object.id]: { maskObjectId: 'missing-mask-object' } },
    });
  });

  it('rejects malformed illustration fields, expanded records, duplicate order IDs, and key/ID contradictions', () => {
    const cases: Array<[string, (document: ReturnType<typeof illustrationDocument>) => void]> = [
      ['Invalid persisted illustration artboard metadata.', (document) => { document.artboard.width = 0; }],
      ['Invalid persisted illustration layer ordering.', (document) => { document.layerIds.push(document.layerIds[0]); }],
      ['Invalid persisted illustration layer metadata.', (document) => { (document as unknown as Record<string, unknown>).layers = []; }],
      ['Invalid persisted illustration layer metadata.', (document) => { vectorLayer(document).id = 'contradictory-layer-id'; }],
      ['Invalid persisted illustration layer metadata.', (document) => { (vectorLayer(document) as unknown as Record<string, unknown>).unexpected = true; }],
      ['Invalid persisted illustration layer metadata.', (document) => {
        const paint = Object.values(document.layers).find((entry) => entry.type === 'paint'); if (!paint || paint.type !== 'paint') throw new Error('Expected paint layer');
        paint.strokes.push({ id: 'invalid-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 1, y: 2, pressure: 2 }], color: '#112233', size: 4, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
      }],
      ['Invalid persisted illustration object metadata.', (document) => { document.objects['persisted-shape'].id = 'contradictory-object-id'; }],
      ['Invalid persisted illustration object metadata.', (document) => { document.objects['persisted-shape'].transform.x = Number.POSITIVE_INFINITY; }],
      ['Invalid persisted illustration object metadata.', (document) => { (document.objects['persisted-shape'] as unknown as Record<string, unknown>).unexpected = true; }],
      ['Invalid persisted illustration brush preset metadata.', (document) => { document.brushPresets.push(structuredClone(document.brushPresets[0])); }],
      ['Invalid persisted illustration guide metadata.', (document) => { document.guides.push(structuredClone(document.guides[0])); }],
      ['Invalid persisted illustration snap settings.', (document) => { (document.snapSettings as unknown as Record<string, unknown>).unexpected = true; }],
    ];
    for (const [error, mutate] of cases) {
      const document = illustrationDocument(); mutate(document);
      expect(() => migrateDocument(document)).toThrow(error);
    }
  });
});

describe('persisted pixel schemas', () => {
  function pixelDocument() {
    const document = createPixelDocument('project', 'Persisted pixel project');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; const timestamp = nowIso();
    writePixels(firstCel, [{ x: 1, y: 2, index: 3 }]);
    const secondFrameId = 'persisted-frame-two'; const secondCelId = 'persisted-cel-two';
    sprite.frameIds.push(secondFrameId);
    sprite.frames[secondFrameId] = { id: secondFrameId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 140 };
    sprite.cels[secondCelId] = { id: secondCelId, revision: 0, name: 'Pixels · Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId: secondFrameId, chunks: {}, linkedToCelId: 'missing-linked-cel' };
    sprite.tags = [{ id: 'persisted-tag', name: 'Loop', fromFrameId: firstFrameId, toFrameId: secondFrameId, direction: 'ping-pong', color: '#31a6a0' }];
    sprite.paletteOverrides[firstFrameId] = structuredClone(document.palette);

    const tileset = createPixelTileset('Persisted terrain', sprite.id, 16, 16, 2, 1);
    tileset.tileOffset = { x: -12, y: 34 };
    tileset.objectAlignment = 'bottomright';
    tileset.tiles[0] = {
      id: 0, sourceX: 0, sourceY: 0, probability: 1, animation: [{ tileId: 1, durationMs: 120 }],
      collisions: [{ id: 'persisted-collision', type: 'rectangle', x: 0, y: 0, width: 16, height: 16, properties: { solid: true } }],
      properties: { terrain: 'grass' },
    };
    tileset.wangSets = [{
      id: 'persisted-wang', name: 'Grass', type: 'mixed',
      colors: [{ id: 1, name: 'Grass', color: '#31a6a0', tileId: 0, probability: 1 }],
      tiles: [{ tileId: 0, wangId: [1, 1, 1, 1, 1, 1, 1, 1] }],
    }];

    const map = createPixelTilemap('Persisted map'); map.tilesetIds = [tileset.id];
    const tileLayer = map.layers[map.layerIds[0]]; if (tileLayer.type !== 'tile' || !tileLayer.chunks) throw new Error('Expected tile layer');
    writeTiles(tileLayer.chunks, [{ x: -1, y: 2, gid: 1 }]);
    const objectLayer: TilemapLayer = {
      id: 'persisted-object-layer', revision: 0, name: 'Objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      type: 'object', visible: true, locked: false, opacity: 1, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
      objects: [
        { id: 'persisted-map-object', type: 'polygon', x: 2, y: 3, points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 6 }], properties: { role: 'spawn' } },
        { id: 'persisted-tile-object', type: 'tile', gid: 0xe000_0001, x: 16, y: 32, width: 24, height: 40, rotation: 45, name: 'Chest', className: 'loot', properties: { coins: 3 } },
      ],
    };
    map.layers[objectLayer.id] = objectLayer; map.layerIds.push(objectLayer.id);
    document.pixelAssets[tileset.id] = tileset; document.pixelAssets[map.id] = map; document.assetIds.push(tileset.id, map.id); document.activeAssetId = map.id;
    document.paletteCycles = [{ id: 'persisted-cycle', name: 'Shimmer', fromIndex: 1, toIndex: 3, direction: 'forward', stepMs: 120 }];
    document.stamps = [{ id: 'persisted-stamp', name: 'Dot', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }] }];
    document.tileStamps = [{ id: 'persisted-tile-stamp', name: 'Tile', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 1 }] }];
    document.linkedAssets = [{ id: 'persisted-link', name: 'Missing but recoverable source', mode: 'embedded', sha256: 'a'.repeat(64), cachedPreviewAssetId: 'missing-cache-asset' }];
    document.conversionDefaults = { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.4 };
    return { document, sprite, tileset, map, firstCel, objectLayer };
  }

  it('normalizes recoverable key aliases and absent preferences before exact canonical validation', () => {
    const { document, sprite, tileset } = pixelDocument(); const layer = sprite.layers[sprite.layerIds[0]]; const frame = sprite.frames[sprite.frameIds[0]]; const cel = Object.values(sprite.cels)[0];
    sprite.layers = { 'legacy-layer-key': layer }; sprite.frames = { 'legacy-frame-key': frame, [sprite.frameIds[1]]: sprite.frames[sprite.frameIds[1]] }; sprite.cels = { 'legacy-cel-key': cel, 'legacy-second-cel-key': sprite.cels['persisted-cel-two'] };
    document.pixelAssets = { 'legacy-sprite-key': sprite, [document.assetIds[1]]: document.pixelAssets[document.assetIds[1]], [document.assetIds[2]]: document.pixelAssets[document.assetIds[2]] };
    const migrated = migrateDocument(document); if (migrated.kind !== 'pixel') throw new Error('Expected pixel document'); const recovered = migrated.pixelAssets[sprite.id]; if (recovered.type !== 'sprite') throw new Error('Expected sprite');
    expect(recovered.layers[layer.id]).toMatchObject({ id: layer.id }); expect(recovered.frames[frame.id]).toMatchObject({ id: frame.id }); expect(recovered.cels[cel.id]).toMatchObject({ id: cel.id });
    expect(recovered.cels['persisted-cel-two'].linkedToCelId).toBe('missing-linked-cel');
    expect(migrated.linkedAssets[0].cachedPreviewAssetId).toBe('missing-cache-asset');

    const absentOffset = structuredClone(document); delete (absentOffset.pixelAssets[tileset.id] as unknown as { tileOffset?: unknown }).tileOffset;
    const offsetDefaulted = migrateDocument(absentOffset); if (offsetDefaulted.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(offsetDefaulted.pixelAssets[tileset.id]).toMatchObject({ type: 'tileset', tileOffset: { x: 0, y: 0 } });

    const absentAlignment = structuredClone(document); delete (absentAlignment.pixelAssets[tileset.id] as unknown as { objectAlignment?: unknown }).objectAlignment;
    const alignmentDefaulted = migrateDocument(absentAlignment); if (alignmentDefaulted.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(alignmentDefaulted.pixelAssets[tileset.id]).toMatchObject({ type: 'tileset', objectAlignment: 'unspecified' });

    const absentLayerOffsets = structuredClone(document); const absentMap = absentLayerOffsets.pixelAssets[absentLayerOffsets.assetIds[2]]; if (absentMap.type !== 'tilemap') throw new Error('Expected tilemap');
    for (const layer of Object.values(absentMap.layers)) { delete (layer as unknown as { offsetX?: unknown }).offsetX; delete (layer as unknown as { offsetY?: unknown }).offsetY; }
    const layerOffsetsDefaulted = migrateDocument(absentLayerOffsets); if (layerOffsetsDefaulted.kind !== 'pixel') throw new Error('Expected pixel document'); const defaultedMap = layerOffsetsDefaulted.pixelAssets[absentMap.id]; if (defaultedMap.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(Object.values(defaultedMap.layers).every((layer) => layer.offsetX === 0 && layer.offsetY === 0)).toBe(true);

    const absent = pixelDocument().document as unknown as Record<string, unknown>;
    delete absent.paletteCycles; delete absent.stamps; delete absent.tileStamps; delete absent.bitmapFonts; delete absent.linkedAssets; delete absent.conversionDefaults;
    const defaulted = migrateDocument(absent); if (defaulted.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(defaulted).toMatchObject({ paletteCycles: [], stamps: [], tileStamps: [], linkedAssets: [], conversionDefaults: { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5 } });
    expect(defaulted.bitmapFonts).toEqual([createPredecessorDefaultBitmapFont()]);
    expect(defaulted.bitmapFonts[0].glyphs.a).toBeUndefined();
    expect(createPixelDocument().bitmapFonts[0].glyphs.a).toBeTruthy();
  });

  it('admits stable overlapping animation tags with duplicate names while requiring unique IDs', () => {
    const { document, sprite } = pixelDocument();
    const [firstFrameId, secondFrameId] = sprite.frameIds;
    sprite.tags = [
      { id: 'outer-tag', name: 'Loop', fromFrameId: firstFrameId, toFrameId: secondFrameId, direction: 'forward', color: '#31a6a0' },
      { id: 'nested-tag', name: 'Loop', fromFrameId: secondFrameId, toFrameId: secondFrameId, direction: 'reverse', color: '#8268dd' },
      { id: 'identical-tag', name: 'Echo', fromFrameId: secondFrameId, toFrameId: secondFrameId, direction: 'ping-pong', color: '#d27c36' },
    ];
    const sibling = createPixelSprite('Sibling');
    sibling.tags = [{ id: 'outer-tag', name: 'Same ID, another sprite', fromFrameId: sibling.frameIds[0], toFrameId: sibling.frameIds[0], direction: 'reverse', color: '#ff6b7a' }];
    document.pixelAssets[sibling.id] = sibling;
    document.assetIds.push(sibling.id);
    const migrated = migrateDocument(document); if (migrated.kind !== 'pixel') throw new Error('Expected pixel document');
    const migratedSprite = migrated.pixelAssets[sprite.id]; if (migratedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(migratedSprite.tags).toEqual(sprite.tags);
    const migratedSibling = migrated.pixelAssets[sibling.id]; if (migratedSibling.type !== 'sprite') throw new Error('Expected sibling sprite');
    expect(migratedSibling.tags[0].id).toBe('outer-tag');

    const duplicateId = structuredClone(document); const duplicateSprite = duplicateId.pixelAssets[sprite.id]; if (duplicateSprite.type !== 'sprite') throw new Error('Expected sprite');
    duplicateSprite.tags[2].id = duplicateSprite.tags[1].id;
    expect(() => migrateDocument(duplicateId)).toThrow('Invalid persisted pixel asset metadata.');
  });

  it('rejects malformed canonical pixel palettes, libraries, assets, links, and conversion state', () => {
    const cases: Array<[string, (fixture: ReturnType<typeof pixelDocument>) => void]> = [
      ['Invalid persisted pixel palette metadata.', ({ document }) => { document.palette[0].color = '#000000ff'; }],
      ['Invalid persisted pixel palette metadata.', ({ document }) => { document.palette[1].id = document.palette[0].id; }],
      ['Invalid persisted pixel palette references.', ({ document, firstCel }) => { const chunk = Object.values(firstCel.chunks)[0]; const bytes = Buffer.from(chunk.data, 'base64'); bytes[0] = document.palette.length; chunk.data = bytes.toString('base64'); }],
      ['Invalid persisted pixel palette references.', ({ document }) => { document.stamps[0].cells[0].index = document.palette.length; }],
      ['Invalid persisted pixel palette references.', ({ sprite }) => { sprite.paletteOverrides[sprite.frameIds[0]].pop(); }],
      ['Invalid persisted pixel palette references.', ({ sprite }) => {
        const override = sprite.paletteOverrides[sprite.frameIds[0]];
        [override[0].id, override[1].id] = [override[1].id, override[0].id];
      }],
      ['Invalid persisted pixel library metadata.', ({ document }) => { document.paletteCycles[0].toIndex = document.palette.length; }],
      ['Invalid persisted pixel library metadata.', ({ document }) => { document.stamps.push(structuredClone(document.stamps[0])); }],
      ['Invalid persisted pixel library metadata.', ({ document }) => { document.bitmapFonts.push(structuredClone(document.bitmapFonts[0])); }],
      ['Invalid persisted pixel link metadata.', ({ document }) => { document.linkedAssets.push(structuredClone(document.linkedAssets[0])); }],
      ['Invalid persisted pixel conversion metadata.', ({ document }) => { document.conversionDefaults.alphaThreshold = 2; }],
      ['Duplicate persisted pixel asset ID:', ({ document, sprite }) => { document.pixelAssets['duplicate-asset-key'] = structuredClone(sprite); }],
      ['Invalid persisted pixel asset metadata.', ({ firstCel }) => { Object.values(firstCel.chunks)[0].data = 'AAAA'; }],
      ['Invalid persisted pixel asset metadata.', ({ firstCel }) => { const chunk = Object.values(firstCel.chunks)[0]; chunk.data = `!${chunk.data.slice(1)}`; }],
      ['Invalid persisted pixel asset metadata.', ({ firstCel }) => { const [key, chunk] = Object.entries(firstCel.chunks)[0]; delete firstCel.chunks[key]; firstCel.chunks['wrong-key'] = chunk; }],
      ['Invalid persisted pixel asset metadata.', ({ firstCel }) => { (Object.values(firstCel.chunks)[0] as unknown as Record<string, unknown>).unexpected = true; }],
      ['Invalid persisted pixel asset metadata.', ({ sprite, firstCel }) => { const duplicate = structuredClone(firstCel); duplicate.id = 'duplicate-exposure'; sprite.cels[duplicate.id] = duplicate; }],
      ['Invalid persisted pixel asset metadata.', ({ tileset }) => { tileset.tiles[0].id = 1; }],
      ['Invalid persisted pixel asset metadata.', ({ tileset }) => { tileset.tileOffset.x = 16_777_217; }],
      ['Invalid persisted pixel asset metadata.', ({ tileset }) => { tileset.tileOffset.y = 0.5; }],
      ['Invalid persisted pixel asset metadata.', ({ tileset }) => { (tileset as unknown as { objectAlignment: string }).objectAlignment = 'baseline'; }],
      ['Invalid persisted pixel asset metadata.', ({ map }) => { map.layers[map.layerIds[0]].offsetX = 16_777_217; }],
      ['Invalid persisted pixel asset metadata.', ({ map }) => { map.layers[map.layerIds[0]].offsetY = 0.5; }],
      ['Invalid persisted pixel asset metadata.', ({ tileset }) => { tileset.wangSets[0].tiles[0].wangId[0] = 2; }],
      ['Invalid persisted pixel asset metadata.', ({ objectLayer }) => { const object = objectLayer.objects?.[0]; if (object?.type !== 'polygon' && object?.type !== 'polyline') throw new Error('Expected point object'); delete object.points; }],
      ['Invalid persisted pixel asset metadata.', ({ objectLayer }) => { const object = objectLayer.objects?.[1]; if (object?.type !== 'tile') throw new Error('Expected tile object'); object.gid = 0; }],
      ['Invalid persisted pixel asset metadata.', ({ objectLayer }) => { const object = objectLayer.objects?.[1]; if (object?.type !== 'tile') throw new Error('Expected tile object'); object.rotation = Number.POSITIVE_INFINITY; }],
      ['Invalid persisted pixel asset metadata.', ({ map }) => { const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer'); Object.values(layer.chunks)[0].x = 1; }],
      ['Invalid persisted pixel asset metadata.', ({ document }) => { (document as unknown as Record<string, unknown>).scope = 'archive'; }],
      ['Invalid persisted pixel link metadata.', ({ document }) => { (document as unknown as Record<string, unknown>).linkedAssets = 'not-a-link-list'; }],
    ];
    for (const [error, mutate] of cases) {
      const fixture = pixelDocument(); mutate(fixture);
      expect(() => migrateDocument(fixture.document)).toThrow(error);
    }
  });

  it('uses the same strict nested schemas for newly supplied pixel assets and libraries', () => {
    const { map, tileset, document } = pixelDocument(); const tileLayer = map.layers[map.layerIds[0]]; if (tileLayer.type !== 'tile' || !tileLayer.chunks) throw new Error('Expected tile layer');
    Object.values(tileLayer.chunks)[0].data = 'AAAA';
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.replace', asset: map, expectedRevision: 0 }).success).toBe(false);
    tileset.tileOffset.x = 0.5;
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.asset.replace', asset: tileset, expectedRevision: 0 }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.stamps.replace', stamps: [document.stamps[0], structuredClone(document.stamps[0])] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.palette-cycles.replace', cycles: [document.paletteCycles[0], structuredClone(document.paletteCycles[0])] }).success).toBe(false);
  });
});

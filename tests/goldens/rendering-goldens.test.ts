import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  encodeTiledGid,
  illustrationAtTime,
  nowIso,
  rasterBrushDynamics,
  writePixels,
  writeTileRuns,
  writeTiles,
  type IllustrationKeyframe,
  type RasterStroke,
  type ShapeObject,
} from '@aidraw/core';
import { renderIllustration, renderSprite, renderTilemap } from '@main/render-document';

function rgbaHash(canvas: Awaited<ReturnType<typeof renderIllustration>>): string {
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return createHash('sha256').update(rgba).digest('hex');
}

function shape(id: string, layerId: string, x: number, y: number, width: number, height: number, color: string): ShapeObject {
  const timestamp = nowIso();
  return { id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'shape', shape: 'rectangle', width, height, fill: { kind: 'solid', color }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
}

async function illustrationCompositeGolden(): Promise<string> {
  const document = createIllustrationDocument('Composite golden'); document.artboard = { ...document.artboard, width: 64, height: 48, background: '#f8efe5' };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer');
  const base = shape('base', layer.id, 6, 7, 38, 29, '#e8b84f'); const overlay = shape('overlay', layer.id, 22, 13, 34, 27, '#8268dd'); overlay.opacity = 0.72; overlay.blendMode = 'multiply'; overlay.filters = [{ type: 'saturation', value: 0.25 }];
  const mask = shape('mask', layer.id, 16, 4, 34, 34, '#000000'); mask.shape = 'ellipse'; mask.visible = false; overlay.maskObjectId = mask.id;
  document.objects = { [base.id]: base, [overlay.id]: overlay, [mask.id]: mask }; layer.objectIds = [base.id, overlay.id, mask.id];
  return rgbaHash(await renderIllustration(document));
}

async function brushGolden(): Promise<string> {
  const document = createIllustrationDocument('Brush golden'); document.artboard = { ...document.artboard, width: 96, height: 64, background: '#fffdf7' };
  const paint = Object.values(document.layers).find((entry) => entry.type === 'paint'); if (!paint || paint.type !== 'paint') throw new Error('Missing paint layer');
  const stroke = (id: string, presetId: 'hard-round' | 'watercolor', y: number, color: string, seed: number): RasterStroke => { const preset = BUILT_IN_RASTER_BRUSH_PRESETS[presetId]; return { id, actorId: HUMAN_ACTOR.id, points: [{ x: 8, y, pressure: 0.25 }, { x: 42, y: y - 6, pressure: 0.9 }, { x: 88, y: y + 3, pressure: 0.55 }], color, size: preset.size, opacity: preset.opacity, hardness: preset.hardness, flow: preset.flow, mode: 'paint', preset: presetId, brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, seed) }; };
  paint.strokes = [stroke('ink', 'hard-round', 18, '#342d49', 7), stroke('wash', 'watercolor', 45, '#3978b8', 42)];
  return rgbaHash(await renderIllustration(document));
}

function spriteGolden(): string {
  const document = createPixelDocument('sprite', 'Sprite golden'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Missing sprite'); sprite.width = 16; sprite.height = 16;
  const cel = Object.values(sprite.cels)[0]; const changes = [] as Array<{ x: number; y: number; index: number }>;
  for (let y = 2; y < 14; y += 1) for (let x = 2; x < 14; x += 1) if ((x + y) % 3 !== 0) changes.push({ x, y, index: x < 8 ? 4 : y < 8 ? 8 : 11 });
  writePixels(cel, changes); return rgbaHash(renderSprite(document, sprite));
}

function mapGolden(orientation: 'orthogonal' | 'isometric'): string {
  const document = createPixelDocument('tilemap', `${orientation} map golden`); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Missing map'); map.orientation = orientation; map.width = 8; map.height = 6; map.tileWidth = 8; map.tileHeight = 8;
  const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Missing tile layer');
  writeTileRuns(layer.chunks, Array.from({ length: map.height }, (_, y) => ({ x: 0, y, length: map.width, gid: y % 4 + 1 })));
  return rgbaHash(renderTilemap(document, map));
}

function tileTransformGolden(): string {
  const document = createPixelDocument('project', 'Tiled transform golden'); document.assetIds = []; document.pixelAssets = {};
  const sprite = createPixelSprite('Labeled tile', 2, 2); const cel = Object.values(sprite.cels)[0];
  writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 4 }, { x: 0, y: 1, index: 8 }, { x: 1, y: 1, index: 11 }]);
  const tileset = createPixelTileset('Labeled tile', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1;
  const map = createPixelTilemap('Transform matrix'); map.width = 8; map.height = 1; map.tileWidth = 2; map.tileHeight = 2; map.tilesetIds = [tileset.id];
  const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
  const transforms = [
    {}, { hFlip: true }, { vFlip: true }, { hFlip: true, vFlip: true },
    { diagonal: true }, { diagonal: true, hFlip: true }, { diagonal: true, vFlip: true }, { diagonal: true, hFlip: true, vFlip: true },
  ];
  writeTiles(layer.chunks, transforms.map((flags, x) => ({ x, y: 0, gid: encodeTiledGid(1, flags) })));
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
  return rgbaHash(renderTilemap(document, map));
}

async function animationGolden(): Promise<string> {
  const document = createIllustrationDocument('Animation golden'); document.artboard = { ...document.artboard, width: 64, height: 32, background: null }; const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer'); const object = shape('actor', layer.id, 4, 8, 12, 12, '#ff6b7a'); document.objects[object.id] = object; layer.objectIds.push(object.id); document.animation.durationMs = 1_000;
  const keyframe = (id: string, timeMs: number, x: number, rotation: number): IllustrationKeyframe => ({ id, revision: 0, name: id, createdAt: object.createdAt, updatedAt: object.updatedAt, createdBy: HUMAN_ACTOR.id, objectId: object.id, timeMs, transform: { ...object.transform, x, rotation }, opacity: timeMs ? 0.6 : 1, visible: true, easing: 'ease-in-out' });
  const first = keyframe('first', 0, 4, 0); const last = keyframe('last', 1_000, 46, 180); document.animation.keyframes = { [first.id]: first, [last.id]: last }; document.animation.keyframeIds = [first.id, last.id];
  return rgbaHash(await renderIllustration(illustrationAtTime(document, 500)));
}

const GOLDEN_HASHES = {
  illustrationComposite: '623e92216930debf11a73466c4d34b888bd9c3c1a57dfce863694784eafd3ac6',
  naturalBrushes: process.platform === 'darwin' && process.arch === 'arm64'
    ? '24d10ac55affbf827b91e0c7336cef4914c99cb08466a40b3c940551b4668bfa'
    : '1ec4a2d01fa69b61bc9f6706abee685b6e207cfa2a9bcffd33a1eea9569bae00',
  indexedSprite: '794c89da39db802f2586364a02711207ee3b3ac0463b9b1e03aa10b389711dc0',
  orthogonalMap: '37aa4899a52c08f383ddd8fbbc7bfc33823180aa8714e5c7d44047bf77b64879',
  isometricMap: 'fb2f38d000733aaf520658d38ec7df376e1df128178e6fe20f5316baf5b8d268',
  tileTransforms: '6bc27075a13934fa4d9a8cb4be584a77cfa9b3f696b71933bd143b838244934d',
  illustrationAnimation: 'c43ed7db842896effb9597fd9ed05e4fc77feda49e1be599b29e7104da71cee1',
};

describe('deterministic raw-RGBA rendering goldens', () => {
  it('matches the maintained cross-mode corpus', async () => {
    const actual = { illustrationComposite: await illustrationCompositeGolden(), naturalBrushes: await brushGolden(), indexedSprite: spriteGolden(), orthogonalMap: mapGolden('orthogonal'), isometricMap: mapGolden('isometric'), tileTransforms: tileTransformGolden(), illustrationAnimation: await animationGolden() };
    expect(actual).toEqual(GOLDEN_HASHES);
  });
});

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  type PathObject,
  type RasterStroke,
  type ShapeObject,
  type TextObject,
} from '@aidraw/core';
import { renderIllustration, renderSprite, renderTilemap } from '@main/render-document';
import { createBooleanPath } from '../../src/common/path-boolean';

function rgbaHash(canvas: Awaited<ReturnType<typeof renderIllustration>>, name: string): string {
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const sha256 = createHash('sha256').update(rgba).digest('hex');
  // Preserve actual pixels for native-platform review before any baseline update.
  const artifactDirectory = process.env.AIDRAW_GOLDEN_ARTIFACT_DIR;
  if (artifactDirectory) {
    const directory = resolve(artifactDirectory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.rgba`), rgba, { flag: 'wx' });
    writeFileSync(join(directory, `${name}.png`), canvas.toBuffer('image/png'), { flag: 'wx' });
    writeFileSync(join(directory, `${name}.json`), `${JSON.stringify({ name, width: canvas.width, height: canvas.height, sha256, platform: process.platform, arch: process.arch, node: process.version }, null, 2)}\n`, { flag: 'wx' });
  }
  return sha256;
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
  return rgbaHash(await renderIllustration(document), 'illustrationComposite');
}

async function illustrationStrokeGolden(): Promise<string> {
  const document = createIllustrationDocument('Stroke-style golden'); document.artboard = { ...document.artboard, width: 80, height: 48, background: null };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer');
  const timestamp = nowIso();
  const path: PathObject = {
    id: 'styled-path', revision: 0, name: 'Styled path', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId: layer.id, visible: true, locked: false, opacity: 0.8, blendMode: 'normal', transform: IDENTITY_TRANSFORM,
    type: 'path', pathData: 'M8 36 L24 8 L40 36', closed: false, fillRule: 'nonzero', fill: { kind: 'none' },
    stroke: { paint: { kind: 'solid', color: '#ff6b7a' }, width: 7, opacity: 0.5, lineCap: 'square', lineJoin: 'bevel', dash: [11, 5] },
  };
  const rectangle = shape('styled-shape', layer.id, 50, 10, 20, 26, '#000000');
  rectangle.fill = { kind: 'none' };
  rectangle.cornerRadius = 4;
  rectangle.stroke = { paint: { kind: 'solid', color: '#31a6a0' }, width: 5, opacity: 0.35, lineCap: 'round', lineJoin: 'round', dash: [6, 4] };
  document.objects = { [path.id]: path, [rectangle.id]: rectangle }; layer.objectIds = [path.id, rectangle.id];
  return rgbaHash(await renderIllustration(document), 'illustrationStrokes');
}

async function illustrationBooleanGolden(): Promise<string> {
  const document = createIllustrationDocument('Boolean golden'); document.artboard = { ...document.artboard, width: 64, height: 64, background: null };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer');
  const timestamp = nowIso();
  const donut: PathObject = {
    id: 'donut', revision: 0, name: 'Donut', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM,
    type: 'path', pathData: 'M4 4H60V60H4Z M18 18H46V46H18Z', closed: true, fillRule: 'evenodd', fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  const island = shape('island', layer.id, 28, 28, 8, 8, '#31a6a0');
  const result = createBooleanPath(donut, island, 'union');
  document.objects = { [result.id]: result }; layer.objectIds = [result.id];
  return rgbaHash(await renderIllustration(document), 'illustrationBoolean');
}

async function missingFontTextGolden(): Promise<string> {
  const document = createIllustrationDocument('Missing-font golden'); document.artboard = { ...document.artboard, width: 180, height: 96, background: null };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer');
  const timestamp = nowIso(); const text = 'Regular\nBold\nItalic\nBold Italic';
  const object: TextObject = {
    id: 'missing-font-text', revision: 0, name: 'Missing-font text', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 4, y: 4 },
    type: 'text', text, width: 172, height: 88, align: 'left', lineHeight: 1.12,
    ranges: [
      { start: 0, end: 8, fontFamily: 'Definitely Missing AIDraw Font 86', fontSize: 18, fontWeight: 400, fontStyle: 'normal', color: '#27213c', letterSpacing: 0 },
      { start: 8, end: 13, fontFamily: 'Definitely Missing AIDraw Font 86', fontSize: 18, fontWeight: 700, fontStyle: 'normal', color: '#27213c', letterSpacing: 0 },
      { start: 13, end: 20, fontFamily: 'Definitely Missing AIDraw Font 86', fontSize: 18, fontWeight: 400, fontStyle: 'italic', color: '#27213c', letterSpacing: 0 },
      { start: 20, end: text.length, fontFamily: 'Definitely Missing AIDraw Font 86', fontSize: 18, fontWeight: 700, fontStyle: 'italic', color: '#27213c', letterSpacing: 0 },
    ],
  };
  document.objects = { [object.id]: object }; layer.objectIds = [object.id];
  return rgbaHash(await renderIllustration(document), 'missingFontText');
}

async function brushGolden(): Promise<string> {
  const document = createIllustrationDocument('Brush golden'); document.artboard = { ...document.artboard, width: 96, height: 64, background: '#fffdf7' };
  const paint = Object.values(document.layers).find((entry) => entry.type === 'paint'); if (!paint || paint.type !== 'paint') throw new Error('Missing paint layer');
  const stroke = (id: string, presetId: 'hard-round' | 'watercolor', y: number, color: string, seed: number): RasterStroke => { const preset = BUILT_IN_RASTER_BRUSH_PRESETS[presetId]; return { id, actorId: HUMAN_ACTOR.id, points: [{ x: 8, y, pressure: 0.25 }, { x: 42, y: y - 6, pressure: 0.9 }, { x: 88, y: y + 3, pressure: 0.55 }], color, size: preset.size, opacity: preset.opacity, hardness: preset.hardness, flow: preset.flow, mode: 'paint', preset: presetId, brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, seed) }; };
  paint.strokes = [stroke('ink', 'hard-round', 18, '#342d49', 7), stroke('wash', 'watercolor', 45, '#3978b8', 42)];
  return rgbaHash(await renderIllustration(document), 'naturalBrushes');
}

function spriteGolden(): string {
  const document = createPixelDocument('sprite', 'Sprite golden'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Missing sprite'); sprite.width = 16; sprite.height = 16;
  const cel = Object.values(sprite.cels)[0]; const changes = [] as Array<{ x: number; y: number; index: number }>;
  for (let y = 2; y < 14; y += 1) for (let x = 2; x < 14; x += 1) if ((x + y) % 3 !== 0) changes.push({ x, y, index: x < 8 ? 4 : y < 8 ? 8 : 11 });
  writePixels(cel, changes); return rgbaHash(renderSprite(document, sprite), 'indexedSprite');
}

function mapGolden(orientation: 'orthogonal' | 'isometric'): string {
  const document = createPixelDocument('tilemap', `${orientation} map golden`); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Missing map'); map.orientation = orientation; map.width = 8; map.height = 6; map.tileWidth = 8; map.tileHeight = 8;
  const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Missing tile layer');
  writeTileRuns(layer.chunks, Array.from({ length: map.height }, (_, y) => ({ x: 0, y, length: map.width, gid: y % 4 + 1 })));
  return rgbaHash(renderTilemap(document, map), orientation === 'orthogonal' ? 'orthogonalMap' : 'isometricMap');
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
  return rgbaHash(renderTilemap(document, map), 'tileTransforms');
}

async function animationGolden(): Promise<string> {
  const document = createIllustrationDocument('Animation golden'); document.artboard = { ...document.artboard, width: 64, height: 32, background: null }; const layer = Object.values(document.layers).find((entry) => entry.type === 'vector'); if (!layer || layer.type !== 'vector') throw new Error('Missing vector layer'); const object = shape('actor', layer.id, 4, 8, 12, 12, '#ff6b7a'); document.objects[object.id] = object; layer.objectIds.push(object.id); document.animation.durationMs = 1_000;
  const keyframe = (id: string, timeMs: number, x: number, rotation: number): IllustrationKeyframe => ({ id, revision: 0, name: id, createdAt: object.createdAt, updatedAt: object.updatedAt, createdBy: HUMAN_ACTOR.id, objectId: object.id, timeMs, transform: { ...object.transform, x, rotation }, opacity: timeMs ? 0.6 : 1, visible: true, easing: 'ease-in-out' });
  const first = keyframe('first', 0, 4, 0); const last = keyframe('last', 1_000, 46, 180); document.animation.keyframes = { [first.id]: first, [last.id]: last }; document.animation.keyframeIds = [first.id, last.id];
  return rgbaHash(await renderIllustration(illustrationAtTime(document, 500)), 'illustrationAnimation');
}

const GOLDEN_HASHES = {
  illustrationComposite: '623e92216930debf11a73466c4d34b888bd9c3c1a57dfce863694784eafd3ac6',
  illustrationStrokes: '28318fc1cc7f7442de0d63d098ca7d7f2579dad6363c07c925304638c32db284',
  illustrationBoolean: 'e0309ac1a79db64b45171ceb4cc991b3612061d820edcd0d4f66099537a16083',
  missingFontText: '09e38eae27a70c6787e2a4efe5f0a71f5a164868db054dbb9415b3ae9762dce8',
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
    const actual = { illustrationComposite: await illustrationCompositeGolden(), illustrationStrokes: await illustrationStrokeGolden(), illustrationBoolean: await illustrationBooleanGolden(), missingFontText: await missingFontTextGolden(), naturalBrushes: await brushGolden(), indexedSprite: spriteGolden(), orthogonalMap: mapGolden('orthogonal'), isometricMap: mapGolden('isometric'), tileTransforms: tileTransformGolden(), illustrationAnimation: await animationGolden() };
    expect(actual).toEqual(GOLDEN_HASHES);
  });
});

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { migrateDocument, readPixel, type PixelCel, type PixelDocument, type PixelSprite } from '@aidraw/core';
import { afterEach, describe, expect, it } from 'vitest';
import { importDocument } from '../../src/main/import-document';
import {
  assertMetadataSpriteSheetAtlas,
  planMetadataSpriteSheet,
  reconstructMetadataSpriteSheetFrame,
} from '../../src/main/sprite-sheet-metadata';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function pixelSprite(document: PixelDocument): PixelSprite {
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite?.type !== 'sprite') throw new Error('Expected an imported sprite');
  return sprite;
}

function frameCel(sprite: PixelSprite, index: number): PixelCel {
  const frameId = sprite.frameIds[index];
  const cel = Object.values(sprite.cels).find((entry) => entry.frameId === frameId);
  if (!cel) throw new Error(`Expected cel for frame ${index}`);
  return cel;
}

async function importFixture(metadata: Record<string, unknown>, canvas: Canvas, imageName = 'atlas.png'): Promise<PixelDocument> {
  const createdDirectory = await mkdtemp(join(tmpdir(), 'aidraw-metadata-sheet-'));
  temporaryDirectories.push(createdDirectory);
  const directory = await realpath(createdDirectory);
  await writeFile(join(directory, imageName), canvas.toBuffer('image/png'));
  await writeFile(join(directory, 'sheet.json'), JSON.stringify(metadata));
  const result = await importDocument(join(directory, 'sheet.json'), true);
  const document = result.documents[0];
  if (document?.kind !== 'pixel') throw new Error('Expected a pixel document');
  return document;
}

function setPixel(context: SKRSContext2D, x: number, y: number, color: string): void {
  context.fillStyle = color;
  context.fillRect(x, y, 1, 1);
}

describe('metadata-driven sprite-sheet import', () => {
  it('reconstructs trimmed and asymmetric clockwise-packed frames onto one exact source canvas', async () => {
    const canvas = createCanvas(7, 3);
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    setPixel(context, 0, 0, '#ff6b7a'); setPixel(context, 1, 0, '#9be3c2');
    setPixel(context, 0, 1, '#31a6a0'); setPixel(context, 1, 1, '#e5b84b');
    // The unrotated 2×3 matrix [ink plum / berry peach / cream sky]
    // is packed clockwise as [cream berry ink / sky peach plum].
    setPixel(context, 3, 0, '#fff1c7'); setPixel(context, 4, 0, '#c04a7a'); setPixel(context, 5, 0, '#27213c');
    setPixel(context, 3, 1, '#74c7ec'); setPixel(context, 4, 1, '#ffb38a'); setPixel(context, 5, 1, '#6c3b78');
    const metadata = {
      frames: {
        'first.png': {
          filename: 'Trimmed first', sourceFrameId: 'source-first',
          frame: { x: 0, y: 0, w: 2, h: 2 }, rotated: false, trimmed: true,
          spriteSourceSize: { x: 1, y: 0, w: 2, h: 2 }, sourceSize: { w: 4, h: 4 }, duration: 80,
        },
        'second.png': {
          filename: 'Rotated second', sourceFrameId: 'source-second',
          frame: { x: 3, y: 0, w: 3, h: 2 }, rotated: true, trimmed: true,
          spriteSourceSize: { x: 0, y: 1, w: 2, h: 3 }, sourceSize: { w: 4, h: 4 }, duration: 135,
        },
      },
      meta: {
        image: 'atlas.png', size: { w: 7, h: 3 },
        frameTags: [
          { name: 'Numeric range', from: 0, to: 1, direction: 'pingpong', color: '#123456' },
          { name: 'Source IDs', fromFrameId: 'source-first', toFrameId: 'source-second', direction: 'reverse', color: '#abcdef' },
        ],
      },
    };
    const document = await importFixture(metadata, canvas);
    const sprite = pixelSprite(document);
    expect(migrateDocument(structuredClone(document))).toMatchObject({ kind: 'pixel' });
    expect([sprite.width, sprite.height, sprite.frameIds.length]).toEqual([4, 4, 2]);
    expect(sprite.frameIds.map((id) => [sprite.frames[id].name, sprite.frames[id].durationMs])).toEqual([
      ['Trimmed first', 80], ['Rotated second', 135],
    ]);
    const first = frameCel(sprite, 0);
    expect(readPixel(first, 0, 0)).toBe(0);
    expect([[1, 0, 4], [2, 0, 7], [1, 1, 8], [2, 1, 15]].map(([x, y]) => readPixel(first, x, y))).toEqual([4, 7, 8, 15]);
    expect(readPixel(first, 3, 3)).toBe(0);
    const second = frameCel(sprite, 1);
    expect([[0, 1], [1, 1], [0, 2], [1, 2], [0, 3], [1, 3]].map(([x, y]) => readPixel(second, x, y))).toEqual([1, 2, 3, 5, 6, 10]);
    expect(readPixel(second, 2, 1)).toBe(0);
    expect(sprite.tags.map((tag) => ({ name: tag.name, from: tag.fromFrameId, to: tag.toFrameId, direction: tag.direction, color: tag.color }))).toEqual([
      { name: 'Numeric range', from: sprite.frameIds[0], to: sprite.frameIds[1], direction: 'ping-pong', color: '#123456' },
      { name: 'Source IDs', from: sprite.frameIds[0], to: sprite.frameIds[1], direction: 'reverse', color: '#abcdef' },
    ]);
    const retained = Object.values(document.assets)[0];
    expect(retained).toMatchObject({ name: 'atlas.png', mimeType: 'image/png', source: 'imported' });
    expect(document.linkedAssets).toEqual([expect.objectContaining({ name: 'atlas.png', relativePath: 'atlas.png', sha256: retained.sha256, cachedPreviewAssetId: retained.id })]);
  });

  it('keeps ordinary same-size array and object metadata on the predecessor untrimmed pixel path', async () => {
    const canvas = createCanvas(8, 2);
    const context = canvas.getContext('2d');
    setPixel(context, 0, 0, '#ff6b7a'); setPixel(context, 1, 1, '#9be3c2');
    setPixel(context, 2, 0, '#31a6a0'); setPixel(context, 3, 1, '#e5b84b');
    setPixel(context, 4, 0, '#ff6b7a'); setPixel(context, 5, 1, '#9be3c2');
    setPixel(context, 6, 0, '#31a6a0'); setPixel(context, 7, 1, '#e5b84b');
    const entries = [
      { filename: 'One', frame: { x: 0, y: 0, w: 2, h: 2 }, sourceSize: { w: 2, h: 2 }, duration: 90 },
      { filename: 'Two', frame: { x: 2, y: 0 }, sourceSize: { w: 2, h: 2 }, duration: 120 },
      { filename: 'Three', frame: { x: 4, y: 0, h: 2 }, sourceSize: { w: 2, h: 2 }, duration: 150 },
      { filename: 'Four', frame: { x: 6, y: 0, w: 2 }, sourceSize: { w: 2, h: 2 }, duration: 180 },
    ];
    const arrayDocument = await importFixture({ frames: entries, meta: { image: 'atlas.png', size: { w: 8, h: 2 } } }, canvas);
    const objectDocument = await importFixture({ frames: { one: entries[0], two: entries[1], three: entries[2], four: entries[3] }, meta: { image: 'atlas.png', size: { w: 8, h: 2 } } }, canvas);
    const inferredCompanionDocument = await importFixture({ frames: entries, meta: {} }, canvas, 'sheet.png');
    const signature = (document: PixelDocument) => {
      const sprite = pixelSprite(document);
      return {
        size: [sprite.width, sprite.height],
        frames: sprite.frameIds.map((id, index) => ({ name: sprite.frames[id].name, duration: sprite.frames[id].durationMs, pixels: [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => readPixel(frameCel(sprite, index), x, y)) })),
      };
    };
    expect(signature(arrayDocument)).toEqual({ size: [2, 2], frames: [
      { name: 'One', duration: 90, pixels: [4, 0, 0, 7] },
      { name: 'Two', duration: 120, pixels: [8, 0, 0, 15] },
      { name: 'Three', duration: 150, pixels: [4, 0, 0, 7] },
      { name: 'Four', duration: 180, pixels: [8, 0, 0, 15] },
    ] });
    expect(signature(objectDocument)).toEqual(signature(arrayDocument));
    expect(signature(inferredCompanionDocument)).toEqual(signature(arrayDocument));
  });

  it('reverses the admitted clockwise packing without interpolation in the pure pixel kernel', () => {
    const plan = planMetadataSpriteSheet({ frames: [{ filename: 'rotated', frame: { x: 0, y: 0, w: 3, h: 2 }, rotated: true, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 2, h: 3 }, sourceSize: { w: 2, h: 3 }, duration: 100 }], meta: { image: 'atlas.png', size: { w: 3, h: 2 } } }, 'fallback.png');
    const atlas = new Uint8ClampedArray([
      5, 0, 0, 255, 3, 0, 0, 255, 1, 0, 0, 255,
      6, 0, 0, 255, 4, 0, 0, 255, 2, 0, 0, 255,
    ]);
    expect(Array.from(reconstructMetadataSpriteSheetFrame(atlas, 3, 2, plan.frames[0], 2, 3))).toEqual([
      1, 0, 0, 255, 2, 0, 0, 255,
      3, 0, 0, 255, 4, 0, 0, 255,
      5, 0, 0, 255, 6, 0, 0, 255,
    ]);
  });

  it('fails closed on incomplete, contradictory, unsafe, ambiguous, and over-budget metadata', () => {
    const base = { filename: 'frame', frame: { x: 0, y: 0, w: 2, h: 3 }, rotated: false, trimmed: true, spriteSourceSize: { x: 1, y: 1, w: 2, h: 3 }, sourceSize: { w: 4, h: 5 }, duration: 100, sourceFrameId: 'source' };
    const metadata = (frames: unknown, meta: Record<string, unknown> = { image: 'atlas.png' }) => ({ frames, meta });
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, spriteSourceSize: undefined }]), 'fallback.png')).toThrow(/spriteSourceSize must be an object/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, frame: undefined }]), 'fallback.png')).toThrow(/rectangle must be an object/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, spriteSourceSize: { y: 1, w: 2, h: 3 } }]), 'fallback.png')).toThrow(/explicit x and y coordinates/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, rotated: 'true' }]), 'fallback.png')).toThrow(/flags must be booleans/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, trimmed: false }]), 'fallback.png')).toThrow(/trimmed flag contradicts/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, spriteSourceSize: { x: 3, y: 3, w: 2, h: 3 } }]), 'fallback.png')).toThrow(/placement exceeds/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, rotated: true }]), 'fallback.png')).toThrow(/clockwise-rotated/);
    expect(() => planMetadataSpriteSheet(metadata([base, { ...base, sourceSize: { w: 5, h: 5 }, sourceFrameId: 'other' }]), 'fallback.png')).toThrow(/sourceSize differs/);
    expect(() => planMetadataSpriteSheet(metadata([{ ...base, duration: 1.5 }]), 'fallback.png')).toThrow(/duration must be an integer/);
    expect(() => planMetadataSpriteSheet(metadata([{ filename: 'first', frame: { x: 0, y: 0, h: 2 } }]), 'fallback.png')).toThrow(/width is required/);
    expect(() => planMetadataSpriteSheet(metadata([{ filename: 'one', frame: { x: 0, y: 0, w: 2, h: 2 } }, { filename: 'two', frame: { x: 2, y: 0, w: 2, width: 3 } }]), 'fallback.png')).toThrow(/contradictory short and long values/);
    expect(() => planMetadataSpriteSheet(metadata([{ filename: 'one', frame: { x: 0, y: 0, w: 2, h: 2 } }, { filename: 'two', frame: { x: 2, y: 0, w: 1, h: 2 } }]), 'fallback.png')).toThrow(/instead of scaling packed pixels/);
    const hugeFrames = Array.from({ length: 5 }, (_, index) => ({ ...base, frame: { x: index, y: 0, w: 1, h: 1 }, spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 }, sourceSize: { w: 4096, h: 4096 }, sourceFrameId: `source-${index}` }));
    expect(() => planMetadataSpriteSheet(metadata(hugeFrames), 'fallback.png')).toThrow(/64-megapixel expanded import budget/);
    expect(() => planMetadataSpriteSheet(metadata([base], { image: 'atlas.png', frameTags: [{ name: 'Missing', fromFrameId: 'missing', to: 0 }] }), 'fallback.png')).toThrow(/does not resolve/);
    expect(() => planMetadataSpriteSheet(metadata([base, { ...base, sourceFrameId: 'source', frame: { x: 2, y: 0, w: 2, h: 3 } }], { image: 'atlas.png', frameTags: [{ name: 'Ambiguous', fromFrameId: 'source', to: 1 }] }), 'fallback.png')).toThrow(/does not resolve to one exact/);
  });

  it('rejects declared atlas mismatches and every out-of-bounds packed rectangle before reconstruction', () => {
    const plan = planMetadataSpriteSheet({ frames: [{ filename: 'frame', frame: { x: 2, y: 1, w: 2, h: 2 }, duration: 100 }], meta: { image: 'atlas.png', size: { w: 4, h: 3 } } }, 'fallback.png');
    expect(() => assertMetadataSpriteSheetAtlas(plan, 5, 3)).toThrow(/disagree with metadata atlas size/);
    expect(() => assertMetadataSpriteSheetAtlas(plan, 3, 3)).toThrow(/disagree with metadata atlas size/);
    const withoutDeclaredSize = { ...plan, declaredAtlasSize: undefined };
    expect(() => assertMetadataSpriteSheetAtlas(withoutDeclaredSize, 3, 3)).toThrow(/out-of-bounds rectangle/);
  });

  it('rejects packed atlas escape and invalid tag references through the production import boundary', async () => {
    const canvas = createCanvas(2, 2);
    await expect(importFixture({
      frames: [{ filename: 'escape', frame: { x: 1, y: 0, w: 2, h: 2 }, duration: 100 }],
      meta: { image: 'atlas.png' },
    }, canvas)).rejects.toThrow(/out-of-bounds rectangle/);
    await expect(importFixture({
      frames: [{ filename: 'frame', sourceFrameId: 'source', frame: { x: 0, y: 0, w: 2, h: 2 }, duration: 100 }],
      meta: { image: 'atlas.png', frameTags: [{ name: 'Broken', fromFrameId: 'missing', to: 0 }] },
    }, canvas)).rejects.toThrow(/does not resolve to one exact source frame/);
  });
});

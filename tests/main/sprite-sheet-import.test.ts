import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { readPixel } from '@aidraw/core';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { importSlicedSpriteSheetBytes } from '../../src/main/import-document';
import { MAX_INLINE_ASSET_BYTES } from '../../src/main/transaction-policy';

describe('sprite-sheet image import', () => {
  it('rejects an oversized retained source before parsing or native decode', async () => {
    await expect(importSlicedSpriteSheetBytes(Buffer.alloc(MAX_INLINE_ASSET_BYTES + 1), 'Oversized sheet', 'image/png', { frameWidth: 1, frameHeight: 1, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0, frameCount: 1, order: 'rows', durationMs: 100, trimTransparent: false, skipEmpty: false })).rejects.toThrow("Sprite-sheet source exceeds AIDraw's 1,500,000-byte editable-asset limit.");
  });

  it('slices, skips empty frames, trims a shared border, preserves timing, and embeds the source', async () => {
    const canvas = createCanvas(14, 4); const context = canvas.getContext('2d'); context.clearRect(0, 0, 14, 4);
    context.fillStyle = '#ff6b7a'; context.fillRect(1, 1, 1, 1);
    context.fillStyle = '#9be3c2'; context.fillRect(7, 2, 1, 1);
    const result = await importSlicedSpriteSheetBytes(canvas.toBuffer('image/png'), 'Tiny sheet', 'image/png', { frameWidth: 4, frameHeight: 4, marginX: 0, marginY: 0, spacingX: 1, spacingY: 0, frameCount: 3, order: 'rows', durationMs: 125, trimTransparent: true, skipEmpty: true });
    const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([sprite.width, sprite.height, sprite.frameIds.length]).toEqual([2, 2, 2]);
    expect(sprite.frameIds.map((id) => sprite.frames[id].durationMs)).toEqual([125, 125]);
    const cels = sprite.frameIds.map((frameId) => Object.values(sprite.cels).find((cel) => cel.frameId === frameId)!);
    expect(readPixel(cels[0], 0, 0)).toBe(4); expect(readPixel(cels[1], 1, 1)).toBe(7);
    expect(Object.values(document.assets)[0]).toMatchObject({ source: 'imported', mimeType: 'image/png' });
    expect(result.warnings.join(' ')).toContain('Skipped 1 fully transparent frame');
    expect(result.warnings.join(' ')).toContain('Trimmed the shared transparent border');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { HUMAN_ACTOR, createPixelDocument, nowIso, readPixel, writePixels } from '@aidraw/core';
import { GIFEncoder } from 'gifenc';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { exportDocument } from '../../src/main/export-document';
import { importApngBytes, importGifBytes } from '../../src/main/import-document';
import { decodeApng } from '../../src/main/apng';

function animatedFixture() {
  const document = createPixelDocument('sprite', 'Round trip'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 4; sprite.height = 3; const firstCel = Object.values(sprite.cels)[0]; sprite.frames[sprite.frameIds[0]].durationMs = 80; writePixels(firstCel, [{ x: 0, y: 0, index: 4 }, { x: 3, y: 2, index: 2 }]);
  const timestamp = nowIso(); const frameId = 'frame-two'; const celId = 'cel-two'; sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 170 }; sprite.cels[celId] = { id: celId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId, chunks: {} }; writePixels(sprite.cels[celId], [{ x: 1, y: 1, index: 7 }]); return { document, sprite };
}

function assertImported(result: ReturnType<typeof importGifBytes> | NonNullable<ReturnType<typeof importApngBytes>>) {
  expect(result.warnings).toEqual([]); const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); expect([sprite.width, sprite.height]).toEqual([4, 3]); expect(sprite.frameIds).toHaveLength(2); expect(sprite.frameIds.map((id) => sprite.frames[id].durationMs)).toEqual([80, 170]); const first = Object.values(sprite.cels).find((cel) => cel.frameId === sprite.frameIds[0])!; const second = Object.values(sprite.cels).find((cel) => cel.frameId === sprite.frameIds[1])!; expect(readPixel(first, 0, 0)).toBe(4); expect(readPixel(first, 1, 1)).toBe(0); expect(readPixel(second, 0, 0)).toBe(0); expect(readPixel(second, 1, 1)).toBe(7); expect(Object.values(document.assets)[0]).toMatchObject({ source: 'imported' });
}

describe('animated pixel import', () => {
  it('round-trips GIF frames, delays, transparency, and source retention', async () => { const { document } = animatedFixture(); const artifact = await exportDocument(document, 'gif'); assertImported(importGifBytes(artifact.data, 'GIF round trip')); });
  it('round-trips APNG frames, delays, transparency, and source retention', async () => { const { document } = animatedFixture(); const artifact = await exportDocument(document, 'apng'); const imported = importApngBytes(artifact.data, 'APNG round trip'); expect(imported).toBeTruthy(); assertImported(imported!); });

  it('composites GIF background disposal before the following frame', () => {
    const encoder = GIFEncoder(); const palette = [[0, 0, 0], [255, 107, 122], [155, 227, 194], [57, 120, 184]];
    encoder.writeFrame(Uint8Array.from([1, 0, 0]), 3, 1, { palette, transparent: true, transparentIndex: 0, delay: 60, dispose: 0 }); encoder.writeFrame(Uint8Array.from([0, 2, 0]), 3, 1, { palette, transparent: true, transparentIndex: 0, delay: 70, dispose: 2 }); encoder.writeFrame(Uint8Array.from([0, 0, 3]), 3, 1, { palette, transparent: true, transparentIndex: 0, delay: 80 }); encoder.finish();
    const imported = importGifBytes(Buffer.from(encoder.bytes()), 'Disposal'); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cels = sprite.frameIds.map((frameId) => Object.values(sprite.cels).find((cel) => cel.frameId === frameId)!);
    expect([readPixel(cels[0], 0, 0), readPixel(cels[0], 1, 0), readPixel(cels[1], 0, 0), readPixel(cels[1], 1, 0), readPixel(cels[2], 0, 0), readPixel(cels[2], 2, 0)]).toEqual([4, 0, 4, 7, 0, 9]); expect(sprite.frameIds.map((id) => sprite.frames[id].durationMs)).toEqual([60, 70, 80]);
  });

  it('round-trips APNG previous-frame disposal selected by delta optimization', async () => {
    const { document, sprite } = animatedFixture(); const timestamp = nowIso(); const thirdFrame = 'frame-three'; const thirdCel = 'cel-three'; sprite.frameIds.push(thirdFrame); sprite.frames[thirdFrame] = { id: thirdFrame, revision: 0, name: 'Frame 3', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 90 }; sprite.cels[thirdCel] = { id: thirdCel, revision: 0, name: 'Frame 3', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId: thirdFrame, chunks: structuredClone(Object.values(sprite.cels)[0].chunks) };
    const artifact = await exportDocument(document, 'apng'); const decoded = decodeApng(artifact.data)!; expect(decoded.frames.some((frame) => frame.dispose === 2)).toBe(true); const imported = importApngBytes(artifact.data, 'Previous disposal')!; const next = imported.documents[0]; if (next.kind !== 'pixel') throw new Error('Expected pixel'); const nextSprite = next.pixelAssets[next.activeAssetId]; if (nextSprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(nextSprite.cels).find((entry) => entry.frameId === nextSprite.frameIds[2])!; expect(readPixel(cel, 0, 0)).toBe(4); expect(readPixel(cel, 1, 1)).toBe(0);
  });
});

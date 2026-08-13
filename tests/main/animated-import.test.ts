import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PALETTE, HUMAN_ACTOR, createPixelDocument, nowIso, readPixel, writePixels } from '@aidraw/core';
import { GIFEncoder } from 'gifenc';
import { crc32, deflateSync } from 'node:zlib';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { exportDocument } from '../../src/main/export-document';
import { importApngBytes, importGifBytes } from '../../src/main/import-document';
import { decodeApng } from '../../src/main/apng';
import { renderSprite } from '../../src/main/render-document';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;
type Rgba = readonly [number, number, number, number];

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii'); const chunk = Buffer.alloc(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0); typeBytes.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, data.byteLength + 8);
  return chunk;
}

function rewritePngChunk(bytes: Buffer, targetType: string, occurrence: number, mutate: (data: Buffer) => void, validCrc = true): Buffer {
  const rewritten = Buffer.from(bytes); let offset = 8; let matched = 0;
  while (offset + 12 <= rewritten.length) {
    const length = rewritten.readUInt32BE(offset); const type = rewritten.toString('ascii', offset + 4, offset + 8); const start = offset + 8; const end = start + length;
    if (end + 4 > rewritten.length) break;
    if (type === targetType && matched++ === occurrence) {
      const data = Buffer.from(rewritten.subarray(start, end)); mutate(data); if (data.length !== length) throw new Error('PNG test mutations must retain chunk length.'); data.copy(rewritten, start);
      if (validCrc) rewritten.writeUInt32BE(crc32(rewritten.subarray(offset + 4, end)) >>> 0, end); else rewritten[end + 3] ^= 1;
      return rewritten;
    }
    offset = end + 4;
  }
  throw new Error(`PNG test fixture is missing ${targetType} occurrence ${occurrence}.`);
}

function replacePngChunkData(bytes: Buffer, targetType: string, occurrence: number, data: Buffer): Buffer {
  let offset = 8; let matched = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8); const end = offset + 12 + length;
    if (end > bytes.length) break;
    if (type === targetType && matched++ === occurrence) return Buffer.concat([bytes.subarray(0, offset), pngChunk(type, data), bytes.subarray(end)]);
    offset = end;
  }
  throw new Error(`PNG test fixture is missing ${targetType} occurrence ${occurrence}.`);
}

function insertPngChunkBefore(bytes: Buffer, targetType: string, type: string, data: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const currentType = bytes.toString('ascii', offset + 4, offset + 8); const end = offset + 12 + length;
    if (end > bytes.length) break;
    if (currentType === targetType) return Buffer.concat([bytes.subarray(0, offset), pngChunk(type, data), bytes.subarray(offset)]);
    offset = end;
  }
  throw new Error(`PNG test fixture is missing ${targetType}.`);
}

function rgbaScanlines(width: number, height: number, rgbaAt: (x: number, y: number) => Rgba, interlaced: boolean): Buffer {
  const rows: Buffer[] = [];
  const passes = interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]] as const;
  for (const [startX, startY, stepX, stepY] of passes) {
    if (startX >= width || startY >= height) continue;
    for (let y = startY; y < height; y += stepY) {
      const row: number[] = [0]; for (let x = startX; x < width; x += stepX) row.push(...rgbaAt(x, y)); rows.push(Buffer.from(row));
    }
  }
  return Buffer.concat(rows);
}

function apngFrameControl(sequence: number, width: number, height: number, x: number, y: number, delayNumerator: number, dispose: 0 | 1 | 2, blend: 0 | 1) {
  const control = Buffer.alloc(26); control.writeUInt32BE(sequence, 0); control.writeUInt32BE(width, 4); control.writeUInt32BE(height, 8); control.writeUInt32BE(x, 12); control.writeUInt32BE(y, 16); control.writeUInt16BE(delayNumerator, 20); control.writeUInt16BE(100, 22); control[24] = dispose; control[25] = blend; return control;
}

function interlacedRgbaApng(malformedFirstFrame = false): { bytes: Buffer; expectedFrames: [Uint8ClampedArray, Uint8ClampedArray] } {
  const width = 8; const height = 8; const patchWidth = 3; const patchHeight = 3; const patchX = 2; const patchY = 3;
  const firstColors: Rgba[] = [[0, 0, 0, 0], [255, 107, 122, 255], [49, 166, 160, 255], [229, 184, 75, 255]];
  const patchColors: Rgba[] = [[255, 107, 122, 255], [155, 227, 194, 255], [57, 120, 184, 255], [0, 0, 0, 0]];
  const firstAt = (x: number, y: number): Rgba => firstColors[(x + y * 2) % firstColors.length];
  const patchAt = (x: number, y: number): Rgba => patchColors[(x * 2 + y) % patchColors.length];
  const first = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) first.set(firstAt(x, y), (y * width + x) * 4);
  const second = first.slice();
  for (let y = 0; y < patchHeight; y += 1) for (let x = 0; x < patchWidth; x += 1) second.set(patchAt(x, y), ((patchY + y) * width + patchX + x) * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; header[12] = 1;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0);
  const firstData = deflateSync(rgbaScanlines(width, height, firstAt, !malformedFirstFrame));
  const secondData = deflateSync(rgbaScanlines(patchWidth, patchHeight, patchAt, true)); const frameData = Buffer.alloc(secondData.byteLength + 4); frameData.writeUInt32BE(2, 0); secondData.copy(frameData, 4);
  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('acTL', animation),
    pngChunk('fcTL', apngFrameControl(0, width, height, 0, 0, 5, 0, 0)),
    pngChunk('IDAT', firstData),
    pngChunk('fcTL', apngFrameControl(1, patchWidth, patchHeight, patchX, patchY, 7, 2, 0)),
    pngChunk('fdAT', frameData),
    pngChunk('IEND'),
  ]);
  return { bytes, expectedFrames: [first, second] };
}

function interlacedIndexedApng(): { bytes: Buffer; expected: Uint8ClampedArray } {
  const width = 8; const height = 8; const rows: Buffer[] = []; const expected = new Uint8ClampedArray(width * height * 4);
  for (const [startX, startY, stepX, stepY] of ADAM7_PASSES) {
    if (startX >= width || startY >= height) continue;
    for (let y = startY; y < height; y += stepY) {
      const passWidth = Math.ceil((width - startX) / stepX); const row = Buffer.alloc(1 + Math.ceil(passWidth / 8)); let passX = 0;
      for (let x = startX; x < width; x += stepX) { const index = (x + y) % 2; if (index) row[1 + Math.floor(passX / 8)] |= 1 << (7 - passX % 8); passX += 1; }
      rows.push(row);
    }
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) expected.set((x + y) % 2 ? [255, 107, 122, 255] : [0, 0, 0, 0], (y * width + x) * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 1; header[9] = 3; header[12] = 1;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  return {
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 107, 122])),
      pngChunk('tRNS', Buffer.from([0, 255])),
      pngChunk('acTL', animation),
      pngChunk('fcTL', apngFrameControl(0, width, height, 0, 0, 4, 0, 0)),
      pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
      pngChunk('IEND'),
    ]),
    expected,
  };
}

function truecolor16TransparencyApng(): { bytes: Buffer; expected: Uint8ClampedArray } {
  const transparent = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]); const opaque = Buffer.from([0x12, 0x35, 0x56, 0x78, 0x9a, 0xbc]);
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 16; header[9] = 2;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  return {
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('tRNS', transparent),
      pngChunk('acTL', animation),
      pngChunk('fcTL', apngFrameControl(0, 2, 1, 0, 0, 6, 0, 0)),
      pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), transparent, opaque]))),
      pngChunk('IEND'),
    ]),
    expected: Uint8ClampedArray.from([0x12, 0x56, 0x9a, 0, 0x12, 0x56, 0x9a, 255]),
  };
}

function grayscale16TransparencyApng(): { bytes: Buffer; expected: Uint8ClampedArray } {
  const transparent = Buffer.from([0x34, 0x56]); const opaque = Buffer.from([0x34, 0x57]);
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 16;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  return {
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('tRNS', transparent),
      pngChunk('acTL', animation),
      pngChunk('fcTL', apngFrameControl(0, 2, 1, 0, 0, 6, 0, 0)),
      pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), transparent, opaque]))),
      pngChunk('IEND'),
    ]),
    expected: Uint8ClampedArray.from([0x34, 0x34, 0x34, 0, 0x34, 0x34, 0x34, 255]),
  };
}

function separateDefaultImageApng(options: { malformedDefault?: boolean; frameUsesIdat?: boolean } = {}): { bytes: Buffer; expected: Uint8ClampedArray } {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  const defaultRaw = options.malformedDefault
    ? Buffer.from([0, 57, 120, 184, 255])
    : Buffer.from([0, 57, 120, 184, 255, 155, 227, 194, 255]);
  const defaultCompressed = deflateSync(defaultRaw); const defaultSplit = Math.max(1, Math.floor(defaultCompressed.length / 2));
  const frameCompressed = deflateSync(Buffer.from([0, 255, 107, 122, 255]));
  const frameData = options.frameUsesIdat ? frameCompressed : Buffer.concat([Buffer.from([0, 0, 0, 1]), frameCompressed]);
  return {
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('acTL', animation),
      pngChunk('IDAT', defaultCompressed.subarray(0, defaultSplit)),
      pngChunk('IDAT', defaultCompressed.subarray(defaultSplit)),
      pngChunk('fcTL', apngFrameControl(0, 1, 1, 1, 0, 9, 0, 0)),
      pngChunk(options.frameUsesIdat ? 'IDAT' : 'fdAT', frameData),
      pngChunk('IEND'),
    ]),
    expected: Uint8ClampedArray.from([0, 0, 0, 0, 255, 107, 122, 255]),
  };
}

function partialIdatFirstFrameApng(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('acTL', animation),
    pngChunk('fcTL', apngFrameControl(0, 1, 1, 1, 0, 9, 0, 0)),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 107, 122, 255]))),
    pngChunk('IEND'),
  ]);
}

function frameLocalPaletteApng(): { bytes: Buffer; expectedFrames: [Uint8ClampedArray, Uint8ClampedArray] } {
  const width = 2; const height = 1;
  const expectedFrames: [Uint8ClampedArray, Uint8ClampedArray] = [
    Uint8ClampedArray.from([1, 2, 3, 255, 64, 128, 192, 128]),
    Uint8ClampedArray.from([7, 8, 9, 255, 10, 11, 12, 192]),
  ];
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2, 0);
  const secondCompressed = deflateSync(Buffer.concat([Buffer.from([0]), Buffer.from(expectedFrames[1])]));
  const secondData = Buffer.alloc(secondCompressed.byteLength + 4); secondData.writeUInt32BE(2, 0); secondCompressed.copy(secondData, 4);
  return {
    bytes: Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngChunk('acTL', animation),
      pngChunk('fcTL', apngFrameControl(0, width, height, 0, 0, 5, 0, 0)),
      pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), Buffer.from(expectedFrames[0])]))),
      pngChunk('fcTL', apngFrameControl(1, width, height, 0, 0, 7, 0, 0)),
      pngChunk('fdAT', secondData),
      pngChunk('IEND'),
    ]),
    expectedFrames,
  };
}

function frameLocalPaletteGif(): { bytes: Buffer; expectedFrames: [Uint8ClampedArray, Uint8ClampedArray] } {
  const encoder = GIFEncoder();
  encoder.writeFrame(Uint8Array.from([1, 2]), 2, 1, { palette: [[0, 0, 0], [1, 2, 3], [4, 5, 6]], transparent: true, transparentIndex: 0, delay: 50, repeat: 0, dispose: 1 });
  encoder.writeFrame(Uint8Array.from([1, 2]), 2, 1, { palette: [[0, 0, 0], [7, 8, 9], [10, 11, 12]], transparent: true, transparentIndex: 0, delay: 70, repeat: 0, dispose: 1 });
  encoder.finish();
  return {
    bytes: Buffer.from(encoder.bytes()),
    expectedFrames: [
      Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]),
      Uint8ClampedArray.from([7, 8, 9, 255, 10, 11, 12, 255]),
    ],
  };
}

function overExactPaletteLimitApng(): Buffer {
  const width = 16; const height = 16;
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1, 0);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('acTL', animation),
    pngChunk('fcTL', apngFrameControl(0, width, height, 0, 0, 10, 0, 0)),
    pngChunk('IDAT', deflateSync(rgbaScanlines(width, height, (x, y) => {
      const index = y * width + x;
      return [index, index ^ 0x55, index ^ 0xaa, 255];
    }, false))),
    pngChunk('IEND'),
  ]);
}

function renderedFrames(result: ReturnType<typeof importGifBytes> | NonNullable<ReturnType<typeof importApngBytes>>): Uint8ClampedArray[] {
  const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  return sprite.frameIds.map((frameId) => renderSprite(document, sprite, frameId).getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data);
}

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

  it('imports exact frame-local APNG colors into aligned palette overrides and re-exports them', async () => {
    const fixture = frameLocalPaletteApng(); const imported = importApngBytes(fixture.bytes, 'Frame-local APNG')!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(imported.warnings).toEqual([]); expect([document.palette[1].color, document.palette[2].color]).toEqual(['#010203', '#4080c080']); expect([sprite.paletteOverrides[sprite.frameIds[1]][1].color, sprite.paletteOverrides[sprite.frameIds[1]][2].color]).toEqual(['#070809', '#0a0b0cc0']);
    const cels = sprite.frameIds.map((frameId) => Object.values(sprite.cels).find((cel) => cel.frameId === frameId)!);
    expect(cels.map((cel) => [readPixel(cel, 0, 0), readPixel(cel, 1, 0)])).toEqual([[1, 2], [1, 2]]); expect(Object.values(document.assets)[0].data).toBe(fixture.bytes.toString('base64'));
    const exported = await exportDocument(document, 'apng'); const decoded = decodeApng(exported.data)!; expect(decoded.frames.map(({ rgba }) => Buffer.from(rgba))).toEqual(fixture.expectedFrames.map((rgba) => Buffer.from(rgba)));
  });

  it('imports exact GIF local color tables as frame palette overrides', () => {
    const fixture = frameLocalPaletteGif(); const imported = importGifBytes(fixture.bytes, 'Local-palette GIF'); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(imported.warnings).toEqual([]); expect([document.palette[1].color, document.palette[2].color]).toEqual(['#010203', '#040506']); expect([sprite.paletteOverrides[sprite.frameIds[1]][1].color, sprite.paletteOverrides[sprite.frameIds[1]][2].color]).toEqual(['#070809', '#0a0b0c']);
    expect(renderedFrames(imported).map((rgba) => Buffer.from(rgba))).toEqual(fixture.expectedFrames.map((rgba) => Buffer.from(rgba))); expect(Object.values(document.assets)[0].data).toBe(fixture.bytes.toString('base64'));
  });

  it('warns and retains document-palette quantization above 255 visible colors in one frame', () => {
    const bytes = overExactPaletteLimitApng(); const imported = importApngBytes(bytes, '256-color APNG')!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(imported.warnings).toEqual([expect.stringMatching(/more than 255 visible RGBA colors.*quantized to the document palette/)]); expect(document.palette).toEqual(DEFAULT_PALETTE); expect(sprite.paletteOverrides).toEqual({}); expect(Object.values(document.assets)[0].data).toBe(bytes.toString('base64'));
  });

  it('imports a spec-derived interlaced RGBA APNG with exact frame rectangles and pixels', () => {
    const fixture = interlacedRgbaApng(); const decoded = decodeApng(fixture.bytes); expect(decoded).toBeTruthy();
    expect(decoded).toMatchObject({ width: 8, height: 8 }); expect(decoded!.frames.map(({ delayMs, dispose, blend }) => ({ delayMs, dispose, blend }))).toEqual([{ delayMs: 50, dispose: 0, blend: 0 }, { delayMs: 70, dispose: 2, blend: 0 }]);
    expect(decoded!.frames.map(({ rgba }) => Buffer.from(rgba))).toEqual(fixture.expectedFrames.map((rgba) => Buffer.from(rgba)));
    const imported = importApngBytes(fixture.bytes, 'Interlaced APNG'); expect(imported).toBeTruthy(); const document = imported!.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([sprite.width, sprite.height]).toEqual([8, 8]); expect(sprite.frameIds.map((id) => sprite.frames[id].durationMs)).toEqual([50, 70]); const cels = sprite.frameIds.map((frameId) => Object.values(sprite.cels).find((cel) => cel.frameId === frameId)!); expect([readPixel(cels[0], 2, 3), readPixel(cels[1], 2, 3)]).toEqual([0, 4]); expect(Object.values(document.assets)[0]).toMatchObject({ mimeType: 'image/apng', data: fixture.bytes.toString('base64') });
  });

  it('rejects an interlaced APNG whose inflated rows use the noninterlaced layout', () => {
    expect(() => decodeApng(interlacedRgbaApng(true).bytes)).toThrow(/APNG frame decoded to \d+ bytes instead of \d+\./);
  });

  it('deinterlaces packed one-bit indexed APNG samples without losing transparency', () => {
    const fixture = interlacedIndexedApng(); const decoded = decodeApng(fixture.bytes); expect(decoded).toBeTruthy(); expect(Buffer.from(decoded!.frames[0].rgba)).toEqual(Buffer.from(fixture.expected));
    const imported = importApngBytes(fixture.bytes, 'Indexed interlaced APNG')!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    expect([sprite.width, sprite.height, sprite.frames[sprite.frameIds[0]].durationMs]).toEqual([8, 8, 40]); expect([readPixel(cel, 0, 0), readPixel(cel, 1, 0)]).toEqual([0, 4]); expect(Object.values(document.assets)[0].data).toBe(fixture.bytes.toString('base64'));
  });

  it('rejects APNG CRC, sequence, declared-count, and final-IEND contradictions before import', () => {
    const valid = interlacedRgbaApng().bytes;
    const cases: Array<[string, Buffer, RegExp]> = [
      ['crc', rewritePngChunk(valid, 'acTL', 0, () => undefined, false), /chunk acTL .* invalid CRC/],
      ['sequence', rewritePngChunk(valid, 'fcTL', 1, (data) => data.writeUInt32BE(3, 0)), /sequence number 3 .* 1 was required/],
      ['frame-count', rewritePngChunk(valid, 'acTL', 0, (data) => data.writeUInt32BE(3, 0)), /declares 3 frames but contains 2 frame controls/],
      ['missing-end', valid.subarray(0, -12), /missing its final IEND chunk/],
      ['trailing-data', Buffer.concat([valid, Buffer.from([0])]), /IEND must be empty and end the file/],
    ];
    for (const [name, bytes, message] of cases) expect(() => importApngBytes(bytes, `Invalid APNG ${name}`)).toThrow(message);
  });

  it('compares all 16 bits of grayscale and truecolor tRNS samples before high-byte conversion', () => {
    for (const [name, fixture] of [['grayscale', grayscale16TransparencyApng()], ['truecolor', truecolor16TransparencyApng()]] as const) {
      const decoded = decodeApng(fixture.bytes); expect(decoded).toBeTruthy(); expect(Buffer.from(decoded!.frames[0].rgba)).toEqual(Buffer.from(fixture.expected));
      const imported = importApngBytes(fixture.bytes, `16-bit ${name} transparent APNG`)!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
      expect([sprite.width, sprite.height, sprite.frames[sprite.frameIds[0]].durationMs]).toEqual([2, 1, 60]); expect(readPixel(cel, 0, 0)).toBe(0); expect(readPixel(cel, 1, 0)).not.toBe(0); expect(Object.values(document.assets)[0].data).toBe(fixture.bytes.toString('base64'));
    }
  });

  it('rejects malformed APNG palettes, transparency metadata, and indexed samples before import', () => {
    const indexed = interlacedIndexedApng().bytes; const rgba = interlacedRgbaApng().bytes; const grayscale = grayscale16TransparencyApng().bytes; const truecolor = truecolor16TransparencyApng().bytes;
    let paletteOverflow = replacePngChunkData(indexed, 'PLTE', 0, Buffer.from([0, 0, 0])); paletteOverflow = replacePngChunkData(paletteOverflow, 'tRNS', 0, Buffer.from([0]));
    const cases: Array<[string, Buffer, RegExp]> = [
      ['palette-shape', replacePngChunkData(indexed, 'PLTE', 0, Buffer.from([0, 0, 0, 255])), /PLTE palette is invalid/],
      ['palette-depth', replacePngChunkData(indexed, 'PLTE', 0, Buffer.from([0, 0, 0, 255, 107, 122, 49, 166, 160])), /PLTE palette exceeds its bit depth/],
      ['transparency-length', replacePngChunkData(indexed, 'tRNS', 0, Buffer.from([0, 255, 255])), /tRNS transparency exceeds its PLTE palette/],
      ['palette-overflow', paletteOverflow, /palette index 1 outside its 1-entry PLTE palette/],
      ['duplicate-palette', insertPngChunkBefore(indexed, 'tRNS', 'PLTE', Buffer.from([0, 0, 0, 255, 107, 122])), /PLTE must appear at most once/],
      ['duplicate-transparency', insertPngChunkBefore(indexed, 'acTL', 'tRNS', Buffer.from([0])), /tRNS must appear at most once/],
      ['grayscale-palette', insertPngChunkBefore(grayscale, 'tRNS', 'PLTE', Buffer.from([0, 0, 0])), /PLTE palette is invalid/],
      ['grayscale-transparency-range', rewritePngChunk(grayscale, 'IHDR', 0, (data) => { data[8] = 8; }), /Grayscale APNG tRNS transparency is invalid/],
      ['truecolor-transparency-range', rewritePngChunk(truecolor, 'IHDR', 0, (data) => { data[8] = 8; }), /Truecolor APNG tRNS transparency is invalid/],
      ['rgba-transparency', insertPngChunkBefore(rgba, 'acTL', 'tRNS', Buffer.from([0, 0])), /color type 6 cannot use tRNS transparency/],
    ];
    for (const [name, bytes, message] of cases) expect(() => importApngBytes(bytes, `Invalid APNG ${name}`)).toThrow(message);
  });

  it('imports animation frames after a separate default image without compositing that fallback', () => {
    const fixture = separateDefaultImageApng(); const decoded = decodeApng(fixture.bytes); expect(decoded).toBeTruthy(); expect(Buffer.from(decoded!.frames[0].rgba)).toEqual(Buffer.from(fixture.expected));
    const imported = importApngBytes(fixture.bytes, 'Separate default APNG')!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    expect([sprite.width, sprite.height, sprite.frames[sprite.frameIds[0]].durationMs]).toEqual([2, 1, 90]); expect([readPixel(cel, 0, 0), readPixel(cel, 1, 0)]).toEqual([0, 4]); expect(Object.values(document.assets)[0].data).toBe(fixture.bytes.toString('base64'));
  });

  it('rejects contradictory APNG default-image and frame-data layouts before import', () => {
    const included = truecolor16TransparencyApng().bytes;
    let nonconsecutive = insertPngChunkBefore(included, 'IEND', 'tEXt', Buffer.from('separator')); nonconsecutive = insertPngChunkBefore(nonconsecutive, 'IEND', 'IDAT', Buffer.alloc(0));
    const cases: Array<[string, Buffer, RegExp]> = [
      ['malformed-default', separateDefaultImageApng({ malformedDefault: true }).bytes, /decoded to 5 bytes instead of 9/],
      ['default-frame-idat', separateDefaultImageApng({ frameUsesIdat: true }).bytes, /frames after a separate default image must use fdAT/],
      ['partial-included-first-frame', partialIdatFirstFrameApng(), /first frame using IDAT must cover the full PNG canvas/],
      ['included-first-frame-fdat', insertPngChunkBefore(included, 'IEND', 'fdAT', Buffer.from([0, 0, 0, 1])), /first frame using IDAT cannot also use fdAT/],
      ['nonconsecutive-idat', nonconsecutive, /IDAT chunks must be consecutive/],
    ];
    for (const [name, bytes, message] of cases) expect(() => importApngBytes(bytes, `Invalid APNG ${name}`)).toThrow(message);
  });

  it('ignores a well-formed unknown ancillary APNG chunk while retaining exact source bytes', () => {
    const fixture = truecolor16TransparencyApng(); const bytes = insertPngChunkBefore(fixture.bytes, 'acTL', 'vpAg', Buffer.from([1, 2, 3]));
    const decoded = decodeApng(bytes); expect(decoded).toBeTruthy(); expect(Buffer.from(decoded!.frames[0].rgba)).toEqual(Buffer.from(fixture.expected));
    const imported = importApngBytes(bytes, 'Ancillary APNG')!; const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([sprite.width, sprite.height, sprite.frames[sprite.frameIds[0]].durationMs]).toEqual([2, 1, 60]); expect(Object.values(document.assets)[0].data).toBe(bytes.toString('base64'));
  });

  it('rejects unknown critical and malformed APNG chunk type codes before import', () => {
    const valid = truecolor16TransparencyApng().bytes;
    const cases: Array<[string, Buffer, RegExp]> = [
      ['unknown-critical', insertPngChunkBefore(valid, 'acTL', 'ABCD', Buffer.from([1])), /unsupported critical PNG chunk ABCD/],
      ['reserved-bit', insertPngChunkBefore(valid, 'acTL', 'abcz', Buffer.alloc(0)), /abcz .* reserved lowercase type bit/],
      ['non-letter', insertPngChunkBefore(valid, 'acTL', 'a1Cd', Buffer.alloc(0)), /invalid four-letter type code/],
    ];
    for (const [name, bytes, message] of cases) expect(() => importApngBytes(bytes, `Invalid APNG ${name}`)).toThrow(message);
  });

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

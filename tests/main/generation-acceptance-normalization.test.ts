import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import type { GeneratedOutput } from '../../src/common/generation';
import { MAX_INLINE_ASSET_BYTES } from '../../src/main/transaction-policy';
import { normalizeGeneratedOutputForAcceptance } from '../../src/main/normalize-generation-output';

function appendAncillaryPadding(png: Buffer, targetBytes: number): Buffer {
  const type = Buffer.from('raNd');
  const payload = Buffer.alloc(Math.max(1, targetBytes - png.byteLength - 12), 0x5a);
  const chunk = Buffer.alloc(payload.byteLength + 12);
  chunk.writeUInt32BE(payload.byteLength, 0);
  type.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0, chunk.byteLength - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

function output(bytes: Buffer, width: number, height: number): GeneratedOutput {
  return { id: 'deterministic-provider-output', mimeType: 'image/png', data: bytes.toString('base64'), width, height, seed: 42 };
}

describe('generated-preview acceptance normalization', () => {
  it('losslessly strips oversized ancillary data without changing the retained provider output', async () => {
    const canvas = createCanvas(8, 6);
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(210, 102, 130, 0.5)'; context.fillRect(0, 0, 8, 6);
    context.fillStyle = '#386fa4'; context.fillRect(2, 1, 4, 3);
    const sourceBytes = appendAncillaryPadding(canvas.toBuffer('image/png'), MAX_INLINE_ASSET_BYTES + 257);
    const providerOutput = output(sourceBytes, 8, 6);
    const retained = structuredClone(providerOutput);

    const prepared = await normalizeGeneratedOutputForAcceptance(providerOutput);
    expect(providerOutput).toEqual(retained);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready' || !prepared.normalization) throw new Error('Expected normalized output');
    const acceptedBytes = Buffer.from(prepared.data, 'base64');
    expect(prepared.normalization).toEqual(expect.objectContaining({
      method: 'png-reencode', sourceOutputId: providerOutput.id,
      sourceMimeType: 'image/png', acceptedMimeType: 'image/png',
      sourceByteLength: sourceBytes.byteLength, acceptedByteLength: acceptedBytes.byteLength,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      acceptedSha256: createHash('sha256').update(acceptedBytes).digest('hex'),
      width: 8, height: 6,
    }));
    expect(acceptedBytes.byteLength).toBeLessThanOrEqual(MAX_INLINE_ASSET_BYTES);
    const decoded = await loadImage(acceptedBytes); expect(decoded.width).toBe(8); expect(decoded.height).toBe(6);
  });

  it('uses the same first fitting fixed WebP quality and bytes for deterministic noisy input', async () => {
    const width = 768; const height = 768;
    const rgba = new Uint8ClampedArray(width * height * 4); let state = 0x1234_5678;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      rgba[offset] = state & 0xff; rgba[offset + 1] = state >>> 8 & 0xff; rgba[offset + 2] = state >>> 16 & 0xff; rgba[offset + 3] = state >>> 24 & 0xff;
    }
    const canvas = createCanvas(width, height); canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const providerOutput = output(canvas.toBuffer('image/png'), width, height);
    expect(Buffer.from(providerOutput.data, 'base64').byteLength).toBeGreaterThan(MAX_INLINE_ASSET_BYTES);

    const first = await normalizeGeneratedOutputForAcceptance(providerOutput);
    const second = await normalizeGeneratedOutputForAcceptance(providerOutput);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'ready', mimeType: 'image/webp', width, height, normalization: { method: 'webp-quality', quality: 95 } });
    if (first.status !== 'ready') throw new Error('Expected normalized output');
    expect(Buffer.from(first.data, 'base64').byteLength).toBeLessThanOrEqual(MAX_INLINE_ASSET_BYTES);
    const decoded = await loadImage(Buffer.from(first.data, 'base64')); const accepted = createCanvas(width, height); accepted.getContext('2d').drawImage(decoded, 0, 0);
    const acceptedRgba = accepted.getContext('2d').getImageData(0, 0, width, height).data;
    let alphaMismatches = 0; for (let offset = 3; offset < rgba.length; offset += 4) if (acceptedRgba[offset] !== rgba[offset]) alphaMismatches += 1;
    expect(alphaMismatches).toBe(0);
  });
});

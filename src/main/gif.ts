export const MAX_GIF_DIMENSION = 8_192;
export const MAX_GIF_PIXELS = 16_777_216;
export const MAX_GIF_FRAMES = 10_000;
export const MAX_GIF_EXPANDED_PIXELS = 256_000_000;
export const MAX_GIF_FILE_BYTES = 256 * 1024 * 1024;

export interface GifInspection {
  width: number;
  height: number;
  frameCount: number;
  patchPixels: number;
}

function uint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error('GIF is truncated.');
  return bytes[offset] | bytes[offset + 1] << 8;
}

function skipBytes(bytes: Uint8Array, offset: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('GIF block is truncated.');
  return offset + length;
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (true) {
    if (offset >= bytes.length) throw new Error('GIF sub-block stream is truncated.');
    const length = bytes[offset]; offset += 1;
    if (length === 0) return offset;
    offset = skipBytes(bytes, offset, length);
  }
}

export function inspectGif(bytes: Uint8Array): GifInspection {
  if (bytes.byteLength < 14) throw new Error('GIF is truncated.');
  if (bytes.byteLength > MAX_GIF_FILE_BYTES) throw new Error(`GIF exceeds the ${MAX_GIF_FILE_BYTES / (1024 * 1024)} MiB compressed-file limit.`);
  const signature = new TextDecoder('ascii').decode(bytes.subarray(0, 6)); if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('GIF header is invalid.');
  const width = uint16(bytes, 6); const height = uint16(bytes, 8);
  if (!width || !height || width > MAX_GIF_DIMENSION || height > MAX_GIF_DIMENSION || width * height > MAX_GIF_PIXELS) throw new Error(`GIF logical screen ${width}×${height} exceeds AIDraw's 8192px/16MP import limit.`);
  const packed = bytes[10]; let offset = 13;
  if (packed & 0x80) offset = skipBytes(bytes, offset, 3 * 2 ** ((packed & 0x07) + 1));
  let frameCount = 0; let patchPixels = 0; let trailer = false;
  while (offset < bytes.length) {
    const marker = bytes[offset]; offset += 1;
    if (marker === 0x00) continue;
    if (marker === 0x3b) { trailer = true; break; }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw new Error('GIF extension label is truncated.'); offset += 1; offset = skipSubBlocks(bytes, offset); continue;
    }
    if (marker !== 0x2c) throw new Error(`GIF contains an unknown block marker 0x${marker.toString(16).padStart(2, '0')}.`);
    if (offset + 9 > bytes.length) throw new Error('GIF image descriptor is truncated.');
    const left = uint16(bytes, offset); const top = uint16(bytes, offset + 2); const frameWidth = uint16(bytes, offset + 4); const frameHeight = uint16(bytes, offset + 6); const imagePacked = bytes[offset + 8]; offset += 9;
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) throw new Error('GIF frame rectangle is empty or exceeds the logical screen.');
    frameCount += 1; patchPixels += frameWidth * frameHeight;
    if (frameCount > MAX_GIF_FRAMES) throw new Error(`GIF exceeds the ${MAX_GIF_FRAMES}-frame import limit.`);
    if (patchPixels > MAX_GIF_EXPANDED_PIXELS || width * height * frameCount > MAX_GIF_EXPANDED_PIXELS) throw new Error(`GIF expands beyond the ${MAX_GIF_EXPANDED_PIXELS.toLocaleString('en-US')}-pixel import budget.`);
    if (imagePacked & 0x80) offset = skipBytes(bytes, offset, 3 * 2 ** ((imagePacked & 0x07) + 1));
    if (offset >= bytes.length) throw new Error('GIF LZW code size is missing.'); const codeSize = bytes[offset]; offset += 1; if (codeSize < 2 || codeSize > 8) throw new Error('GIF LZW code size is invalid.'); offset = skipSubBlocks(bytes, offset);
  }
  if (!trailer) throw new Error('GIF trailer is missing.');
  if (!frameCount) throw new Error('GIF contains no image frames.');
  return { width, height, frameCount, patchPixels };
}

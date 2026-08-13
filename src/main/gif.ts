import { parseGIF } from 'gifuct-js';

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

export interface DecodedGifFrame {
  dims: { width: number; height: number; top: number; left: number };
  delay?: number;
  disposalType?: number;
  patch: Uint8ClampedArray;
}

type GifColor = [number, number, number];
const MAX_GIF_LZW_CODES = 4_096;

interface ParsedGifImageFrame {
  gce?: {
    delay: number;
    transparentColorIndex: number;
    extras: { disposal: number; transparentColorGiven: boolean };
  };
  image: {
    descriptor: { left: number; top: number; width: number; height: number; lct: { exists: boolean; interlaced: boolean } };
    lct?: GifColor[];
    data: { minCodeSize: number; blocks: ArrayLike<number> };
  };
}

interface ParsedGifSource {
  gct?: GifColor[];
  frames: unknown[];
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

function isParsedGifImageFrame(value: unknown): value is ParsedGifImageFrame {
  return value !== null && typeof value === 'object' && 'image' in value;
}

function decodeGifLzw(data: ArrayLike<number>, minimumCodeSize: number, expectedPixels: number, frameNumber: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const prefixes = new Int16Array(MAX_GIF_LZW_CODES);
  const suffixes = new Uint8Array(MAX_GIF_LZW_CODES);
  const stack = new Uint8Array(MAX_GIF_LZW_CODES + 1);
  prefixes.fill(-1);
  for (let code = 0; code < clearCode; code += 1) suffixes[code] = code;

  const output = new Uint8Array(expectedPixels);
  let available = clearCode + 2;
  let codeSize = minimumCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let oldCode = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let inputOffset = 0;
  let outputOffset = 0;
  const reset = () => {
    available = clearCode + 2;
    codeSize = minimumCodeSize + 1;
    codeMask = (1 << codeSize) - 1;
    oldCode = -1;
  };

  while (true) {
    while (bits < codeSize) {
      if (inputOffset >= data.length) throw new Error(`GIF frame ${frameNumber} LZW stream ended before its end-of-information code.`);
      datum |= Number(data[inputOffset]) << bits;
      bits += 8;
      inputOffset += 1;
    }
    let code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clearCode) { reset(); continue; }
    if (code === endCode) {
      if (outputOffset !== expectedPixels) throw new Error(`GIF frame ${frameNumber} decoded ${outputOffset} pixels instead of ${expectedPixels}.`);
      return output;
    }
    if (code > available || code >= MAX_GIF_LZW_CODES) throw new Error(`GIF frame ${frameNumber} contains an invalid LZW dictionary code.`);
    if (oldCode < 0) {
      if (code >= clearCode || outputOffset >= expectedPixels) throw new Error(`GIF frame ${frameNumber} contains an invalid initial LZW code.`);
      first = suffixes[code];
      output[outputOffset] = first;
      outputOffset += 1;
      oldCode = code;
      continue;
    }

    const inputCode = code;
    let stackSize = 0;
    if (code === available) {
      stack[stackSize] = first;
      stackSize += 1;
      code = oldCode;
    }
    while (code >= clearCode + 2) {
      if (code >= available || prefixes[code] < 0 || stackSize >= MAX_GIF_LZW_CODES) throw new Error(`GIF frame ${frameNumber} contains an invalid LZW dictionary chain.`);
      stack[stackSize] = suffixes[code];
      stackSize += 1;
      code = prefixes[code];
    }
    if (code >= clearCode) throw new Error(`GIF frame ${frameNumber} contains an invalid LZW dictionary root.`);
    first = suffixes[code];
    stack[stackSize] = first;
    stackSize += 1;
    while (stackSize) {
      if (outputOffset >= expectedPixels) throw new Error(`GIF frame ${frameNumber} expands beyond its declared rectangle.`);
      stackSize -= 1;
      output[outputOffset] = stack[stackSize];
      outputOffset += 1;
    }
    if (available < MAX_GIF_LZW_CODES) {
      prefixes[available] = oldCode;
      suffixes[available] = first;
      available += 1;
      if ((available & codeMask) === 0 && available < MAX_GIF_LZW_CODES) {
        codeSize += 1;
        codeMask += available;
      }
    }
    oldCode = inputCode;
  }
}

function deinterlaceGifPixels(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(pixels.length);
  const offsets = [0, 4, 2, 1];
  const steps = [8, 8, 4, 2];
  let sourceRow = 0;
  for (let pass = 0; pass < offsets.length; pass += 1) for (let targetRow = offsets[pass]; targetRow < height; targetRow += steps[pass]) {
    const start = sourceRow * width;
    output.set(pixels.subarray(start, start + width), targetRow * width);
    sourceRow += 1;
  }
  if (sourceRow !== height) throw new Error('GIF interlace geometry is inconsistent with its frame rectangle.');
  return output;
}

export function visitDecodedGifFrames(
  bytes: Uint8Array,
  visit: (frame: DecodedGifFrame, index: number) => void,
  inspected = inspectGif(bytes),
): void {
  // gifuct-js remains the container parser, but its pixel helper pads short LZW
  // output with index zero and substitutes black for missing palette entries.
  // Editable import must reject those cases rather than inventing artwork.
  const parsed = parseGIF(Uint8Array.from(bytes).buffer) as unknown as ParsedGifSource;
  let frameCount = 0;
  let patchPixels = 0;
  for (const candidate of parsed.frames) {
    if (!isParsedGifImageFrame(candidate)) continue;
    const { descriptor, data } = candidate.image;
    const frameNumber = frameCount + 1;
    const pixelCount = descriptor.width * descriptor.height;
    const table = descriptor.lct.exists ? candidate.image.lct : parsed.gct;
    if (!Array.isArray(table) || !table.length) throw new Error(`GIF frame ${frameNumber} has no active color table.`);
    const transparentIndex = candidate.gce?.extras.transparentColorGiven ? candidate.gce.transparentColorIndex : undefined;
    if (transparentIndex !== undefined && transparentIndex >= table.length) throw new Error(`GIF frame ${frameNumber} transparency index falls outside its active color table.`);
    let pixels = decodeGifLzw(data.blocks, data.minCodeSize, pixelCount, frameNumber);
    if (descriptor.lct.interlaced) pixels = deinterlaceGifPixels(pixels, descriptor.width, descriptor.height);
    const patch = new Uint8ClampedArray(pixelCount * 4);
    for (let index = 0; index < pixels.length; index += 1) {
      const colorIndex = pixels[index];
      const color = table[colorIndex];
      if (!color) throw new Error(`GIF frame ${frameNumber} references color index ${colorIndex} outside its active color table.`);
      const offset = index * 4;
      patch[offset] = color[0];
      patch[offset + 1] = color[1];
      patch[offset + 2] = color[2];
      patch[offset + 3] = colorIndex === transparentIndex ? 0 : 255;
    }
    const frame: DecodedGifFrame = {
      dims: { width: descriptor.width, height: descriptor.height, top: descriptor.top, left: descriptor.left },
      patch,
    };
    if (candidate.gce) {
      frame.delay = (candidate.gce.delay || 10) * 10;
      frame.disposalType = candidate.gce.extras.disposal;
    }
    patchPixels += pixelCount;
    frameCount += 1;
    visit(frame, frameNumber - 1);
  }
  if (frameCount !== inspected.frameCount || patchPixels !== inspected.patchPixels) throw new Error('GIF decoder output disagrees with the validated container.');
}

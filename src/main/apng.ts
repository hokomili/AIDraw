import { crc32, inflateSync } from 'node:zlib';

export interface DecodedApngFrame { rgba: Uint8ClampedArray; delayMs: number; dispose: 0 | 1 | 2; blend: 0 | 1 }
export interface DecodedApng { width: number; height: number; frames: DecodedApngFrame[] }

interface Header { width: number; height: number; depth: number; colorType: number; interlace: number }
interface FrameControl { x: number; y: number; width: number; height: number; delayMs: number; dispose: 0 | 1 | 2; blend: 0 | 1 }
interface CompressedFrame { control: FrameControl; chunks: Buffer[] }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_APNG_FRAMES = 10_000;
const MAX_APNG_PIXELS = 256_000_000;
const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const LEGAL_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft; const leftDistance = Math.abs(estimate - left); const upDistance = Math.abs(estimate - up); const cornerDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= cornerDistance ? left : upDistance <= cornerDistance ? up : upperLeft;
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function packedRowBytes(width: number, channels: number, depth: number): number {
  return Math.ceil(width * channels * depth / 8);
}

function unfilterRows(inflated: Uint8Array, sourceOffset: number, width: number, height: number, channels: number, depth: number): { bytes: Uint8Array; nextOffset: number } {
  const rowBytes = packedRowBytes(width, channels, depth);
  const bytesPerPixel = Math.max(1, Math.ceil(channels * depth / 8)); const output = new Uint8Array(rowBytes * height);
  let cursor = sourceOffset;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[cursor]; cursor += 1; const target = y * rowBytes;
    if (filter > 4) throw new Error(`APNG uses unsupported PNG filter ${filter}.`);
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[cursor]; cursor += 1; const left = x >= bytesPerPixel ? output[target + x - bytesPerPixel] : 0; const up = y ? output[target - rowBytes + x] : 0; const upperLeft = y && x >= bytesPerPixel ? output[target - rowBytes + x - bytesPerPixel] : 0;
      output[target + x] = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + up : filter === 3 ? raw + Math.floor((left + up) / 2) : raw + paeth(left, up, upperLeft);
    }
  }
  return { bytes: output, nextOffset: cursor };
}

function unpackSample(bytes: Uint8Array, rowBytes: number, x: number, y: number, depth: number): number {
  if (depth === 8) return bytes[y * rowBytes + x];
  const bit = x * depth; const shift = 8 - depth - bit % 8; return (bytes[y * rowBytes + Math.floor(bit / 8)] >> shift) & ((1 << depth) - 1);
}

function packSample(bytes: Uint8Array, rowBytes: number, x: number, y: number, depth: number, sample: number): void {
  const bit = x * depth; const shift = 8 - depth - bit % 8; const offset = y * rowBytes + Math.floor(bit / 8); const mask = ((1 << depth) - 1) << shift;
  bytes[offset] = (bytes[offset] & ~mask) | (sample << shift);
}

function unfilter(compressed: Buffer[], width: number, height: number, channels: number, depth: number, interlace: number): Uint8Array {
  if (interlace !== 0 && interlace !== 1) throw new Error(`APNG interlace method ${interlace} is unsupported.`);
  const expected = interlace === 0
    ? height * (packedRowBytes(width, channels, depth) + 1)
    : ADAM7_PASSES.reduce((sum, [startX, startY, stepX, stepY]) => {
      const passWidth = passSize(width, startX, stepX); const passHeight = passSize(height, startY, stepY);
      return sum + (passWidth && passHeight ? passHeight * (packedRowBytes(passWidth, channels, depth) + 1) : 0);
    }, 0);
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
  if (inflated.length !== expected) throw new Error(`APNG frame decoded to ${inflated.length} bytes instead of ${expected}.`);
  if (interlace === 0) return unfilterRows(inflated, 0, width, height, channels, depth).bytes;

  // Adam7 filters every pass as an independent image. Rebuild the same packed
  // row layout used by the established color conversion below.
  const rowBytes = packedRowBytes(width, channels, depth); const output = new Uint8Array(rowBytes * height); const bytesPerPixel = channels * depth / 8;
  let sourceOffset = 0;
  for (const [startX, startY, stepX, stepY] of ADAM7_PASSES) {
    const passWidth = passSize(width, startX, stepX); const passHeight = passSize(height, startY, stepY);
    if (!passWidth || !passHeight) continue;
    const pass = unfilterRows(inflated, sourceOffset, passWidth, passHeight, channels, depth); sourceOffset = pass.nextOffset;
    const passRowBytes = packedRowBytes(passWidth, channels, depth);
    for (let passY = 0; passY < passHeight; passY += 1) for (let passX = 0; passX < passWidth; passX += 1) {
      const x = startX + passX * stepX; const y = startY + passY * stepY;
      if (depth < 8) {
        packSample(output, rowBytes, x, y, depth, unpackSample(pass.bytes, passRowBytes, passX, passY, depth));
        continue;
      }
      const source = passY * passRowBytes + passX * bytesPerPixel; const target = y * rowBytes + x * bytesPerPixel;
      for (let byte = 0; byte < bytesPerPixel; byte += 1) output[target + byte] = pass.bytes[source + byte];
    }
  }
  return output;
}

function rgbaFrame(header: Header, control: FrameControl, compressed: Buffer[], palette: Uint8Array | undefined, transparency: Uint8Array | undefined): Uint8ClampedArray {
  const channels = [1, 0, 3, 1, 2, 0, 4][header.colorType] ?? 0; if (!channels) throw new Error(`APNG color type ${header.colorType} is unsupported.`); if (![1, 2, 4, 8, 16].includes(header.depth)) throw new Error(`APNG bit depth ${header.depth} is unsupported.`);
  if (!LEGAL_DEPTHS[header.colorType]?.includes(header.depth)) throw new Error(`APNG bit depth ${header.depth} is unsupported for color type ${header.colorType}.`);
  const bytes = unfilter(compressed, control.width, control.height, channels, header.depth, header.interlace); const rowBytes = Math.ceil(control.width * channels * header.depth / 8); const rgba = new Uint8ClampedArray(control.width * control.height * 4); const write = (pixel: number, red: number, green: number, blue: number, alpha = 255) => { const offset = pixel * 4; rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue; rgba[offset + 3] = alpha; };
  for (let y = 0; y < control.height; y += 1) for (let x = 0; x < control.width; x += 1) {
    const pixel = y * control.width + x;
    if (header.colorType === 6) { const offset = y * rowBytes + x * (header.depth === 16 ? 8 : 4); write(pixel, bytes[offset], bytes[offset + (header.depth === 16 ? 2 : 1)], bytes[offset + (header.depth === 16 ? 4 : 2)], bytes[offset + (header.depth === 16 ? 6 : 3)]); }
    else if (header.colorType === 2) { const offset = y * rowBytes + x * (header.depth === 16 ? 6 : 3); const red = bytes[offset]; const green = bytes[offset + (header.depth === 16 ? 2 : 1)]; const blue = bytes[offset + (header.depth === 16 ? 4 : 2)]; const transparent = transparency?.length === 6 && red === transparency[1] && green === transparency[3] && blue === transparency[5]; write(pixel, red, green, blue, transparent ? 0 : 255); }
    else if (header.colorType === 4) { const offset = y * rowBytes + x * (header.depth === 16 ? 4 : 2); const gray = bytes[offset]; write(pixel, gray, gray, gray, bytes[offset + (header.depth === 16 ? 2 : 1)]); }
    else if (header.colorType === 3) { if (!palette) throw new Error('Indexed APNG is missing its PLTE palette.'); const index = unpackSample(bytes, rowBytes, x, y, header.depth); write(pixel, palette[index * 3] ?? 0, palette[index * 3 + 1] ?? 0, palette[index * 3 + 2] ?? 0, transparency?.[index] ?? 255); }
    else { const maximum = (1 << Math.min(8, header.depth)) - 1; const sample = header.depth === 16 ? bytes[y * rowBytes + x * 2] : unpackSample(bytes, rowBytes, x, y, header.depth); const gray = header.depth >= 8 ? sample : Math.round(sample * 255 / maximum); const transparent = transparency?.length === 2 && sample === transparency[1]; write(pixel, gray, gray, gray, transparent ? 0 : 255); }
  }
  return rgba;
}

function composite(canvas: Uint8ClampedArray, canvasWidth: number, control: FrameControl, patch: Uint8ClampedArray): void {
  for (let y = 0; y < control.height; y += 1) for (let x = 0; x < control.width; x += 1) {
    const source = (y * control.width + x) * 4; const target = ((control.y + y) * canvasWidth + control.x + x) * 4;
    if (control.blend === 0) { canvas[target] = patch[source]; canvas[target + 1] = patch[source + 1]; canvas[target + 2] = patch[source + 2]; canvas[target + 3] = patch[source + 3]; continue; }
    const sourceAlpha = patch[source + 3] / 255; const targetAlpha = canvas[target + 3] / 255; const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (!alpha) { canvas.fill(0, target, target + 4); continue; }
    for (let channel = 0; channel < 3; channel += 1) canvas[target + channel] = Math.round((patch[source + channel] * sourceAlpha + canvas[target + channel] * targetAlpha * (1 - sourceAlpha)) / alpha);
    canvas[target + 3] = Math.round(alpha * 255);
  }
}

function clearRect(canvas: Uint8ClampedArray, canvasWidth: number, control: FrameControl): void {
  for (let y = 0; y < control.height; y += 1) canvas.fill(0, ((control.y + y) * canvasWidth + control.x) * 4, ((control.y + y) * canvasWidth + control.x + control.width) * 4);
}

function containsAnimationControl(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8); const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error(`PNG chunk ${type} at ${offset} declares ${length} bytes beyond the ${bytes.length}-byte file boundary.`);
    if (type === 'acTL') return true;
    if (type === 'IEND') return false;
    offset = end + 4;
  }
  return false;
}

export function decodeApng(bytes: Buffer): DecodedApng | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('The input is not a PNG file.');
  if (!containsAnimationControl(bytes)) return undefined;
  let offset = 8; let header: Header | undefined; let declaredFrameCount: number | undefined; let expectedSequence = 0; let sawImageData = false; let sawEnd = false;
  let palette: Uint8Array | undefined; let transparency: Uint8Array | undefined; const frames: CompressedFrame[] = []; let current: CompressedFrame | undefined;
  while (offset + 12 <= bytes.length) {
    const chunkOffset = offset; const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8); const start = offset + 8; const end = start + length;
    if (end + 4 > bytes.length) throw new Error(`PNG chunk ${type} at ${chunkOffset} declares ${length} bytes beyond the ${bytes.length}-byte file boundary.`);
    if ((crc32(bytes.subarray(chunkOffset + 4, end)) >>> 0) !== bytes.readUInt32BE(end)) throw new Error(`PNG chunk ${type} at ${chunkOffset} has an invalid CRC.`);
    const data = bytes.subarray(start, end); offset = end + 4;
    if (type === 'IHDR') {
      if (header || chunkOffset !== 8 || length !== 13) throw new Error('PNG must begin with exactly one 13-byte IHDR chunk.');
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
      if (data[10] !== 0 || data[11] !== 0 || header.interlace > 1) throw new Error('PNG uses an unsupported compression, filter, or interlace method.');
      if (header.width < 1 || header.height < 1 || header.width > 8_192 || header.height > 8_192 || header.width * header.height > 16_777_216) throw new Error('PNG dimensions exceed AIDraw import limits.');
    } else if (!header) throw new Error('PNG image data appears before IHDR.');
    else if (type === 'acTL') {
      if (length !== 8 || declaredFrameCount !== undefined || sawImageData) throw new Error('APNG animation control must appear once before image data.');
      declaredFrameCount = data.readUInt32BE(0); if (declaredFrameCount < 1 || declaredFrameCount > MAX_APNG_FRAMES) throw new Error(`APNG frame count ${declaredFrameCount} exceeds AIDraw limits.`);
    } else if (type === 'PLTE') palette = Uint8Array.from(data);
    else if (type === 'tRNS') transparency = Uint8Array.from(data);
    else if (type === 'fcTL') {
      if (declaredFrameCount === undefined || length !== 26) throw new Error('APNG frame control is invalid.');
      const sequence = data.readUInt32BE(0); if (sequence !== expectedSequence) throw new Error(`APNG sequence number ${sequence} appears where ${expectedSequence} was required.`); expectedSequence += 1;
      const denominator = data.readUInt16BE(22) || 100; const control: FrameControl = { width: data.readUInt32BE(4), height: data.readUInt32BE(8), x: data.readUInt32BE(12), y: data.readUInt32BE(16), delayMs: Math.max(1, Math.round(data.readUInt16BE(20) * 1000 / denominator)), dispose: data[24] as 0 | 1 | 2, blend: data[25] as 0 | 1 };
      if (!control.width || !control.height || control.x + control.width > header.width || control.y + control.height > header.height || control.dispose > 2 || control.blend > 1) throw new Error('APNG frame control is invalid.');
      current = { control, chunks: [] }; frames.push(current);
    } else if (type === 'IDAT') {
      sawImageData = true;
      if (current && frames[0] === current && frames.length === 1) current.chunks.push(Buffer.from(data));
      else if (current) throw new Error('APNG IDAT chunks cannot follow a later animation frame control.');
    } else if (type === 'fdAT') {
      if (!sawImageData || !current || data.length < 4) throw new Error('APNG frame data has no preceding frame control.');
      const sequence = data.readUInt32BE(0); if (sequence !== expectedSequence) throw new Error(`APNG sequence number ${sequence} appears where ${expectedSequence} was required.`); expectedSequence += 1; current.chunks.push(Buffer.from(data.subarray(4)));
    } else if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new Error('PNG IEND must be empty and end the file.');
      sawEnd = true; break;
    }
  }
  if (!sawEnd) throw new Error('APNG is missing its final IEND chunk.');
  if (!header) throw new Error('PNG must begin with exactly one 13-byte IHDR chunk.');
  if (declaredFrameCount === undefined || frames.length !== declaredFrameCount) throw new Error(`APNG declares ${declaredFrameCount ?? 0} frames but contains ${frames.length} frame controls.`);
  if (!frames.length || frames.some((frame) => !frame.chunks.length)) throw new Error('APNG contains incomplete frame data.');
  if (header.width * header.height * frames.length > MAX_APNG_PIXELS) throw new Error('APNG expands beyond the 256-million-pixel animation limit.');
  const canvas = new Uint8ClampedArray(header.width * header.height * 4); const decoded: DecodedApngFrame[] = [];
  for (const frame of frames) { const previous = frame.control.dispose === 2 ? canvas.slice() : undefined; const patch = rgbaFrame(header, frame.control, frame.chunks, palette, transparency); composite(canvas, header.width, frame.control, patch); decoded.push({ rgba: canvas.slice(), delayMs: frame.control.delayMs, dispose: frame.control.dispose, blend: frame.control.blend }); if (frame.control.dispose === 1) clearRect(canvas, header.width, frame.control); else if (frame.control.dispose === 2 && previous) canvas.set(previous); }
  return { width: header.width, height: header.height, frames: decoded };
}

import { inflateSync } from 'node:zlib';

export interface DecodedApngFrame { rgba: Uint8ClampedArray; delayMs: number; dispose: 0 | 1 | 2; blend: 0 | 1 }
export interface DecodedApng { width: number; height: number; frames: DecodedApngFrame[] }

interface Header { width: number; height: number; depth: number; colorType: number; interlace: number }
interface FrameControl { x: number; y: number; width: number; height: number; delayMs: number; dispose: 0 | 1 | 2; blend: 0 | 1 }
interface CompressedFrame { control: FrameControl; chunks: Buffer[] }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_APNG_FRAMES = 10_000;
const MAX_APNG_PIXELS = 256_000_000;

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft; const leftDistance = Math.abs(estimate - left); const upDistance = Math.abs(estimate - up); const cornerDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= cornerDistance ? left : upDistance <= cornerDistance ? up : upperLeft;
}

function unfilter(compressed: Buffer[], width: number, height: number, channels: number, depth: number): Uint8Array {
  const rowBytes = Math.ceil(width * channels * depth / 8); const expected = height * (rowBytes + 1); const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
  if (inflated.length !== expected) throw new Error(`APNG frame decoded to ${inflated.length} bytes instead of ${expected}.`);
  const bytesPerPixel = Math.max(1, Math.ceil(channels * depth / 8)); const output = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (rowBytes + 1)]; const source = y * (rowBytes + 1) + 1; const target = y * rowBytes;
    if (filter > 4) throw new Error(`APNG uses unsupported PNG filter ${filter}.`);
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[source + x]; const left = x >= bytesPerPixel ? output[target + x - bytesPerPixel] : 0; const up = y ? output[target - rowBytes + x] : 0; const upperLeft = y && x >= bytesPerPixel ? output[target - rowBytes + x - bytesPerPixel] : 0;
      output[target + x] = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + up : filter === 3 ? raw + Math.floor((left + up) / 2) : raw + paeth(left, up, upperLeft);
    }
  }
  return output;
}

function unpackSample(bytes: Uint8Array, rowBytes: number, x: number, y: number, depth: number): number {
  if (depth === 8) return bytes[y * rowBytes + x];
  const bit = x * depth; const shift = 8 - depth - bit % 8; return (bytes[y * rowBytes + Math.floor(bit / 8)] >> shift) & ((1 << depth) - 1);
}

function rgbaFrame(header: Header, control: FrameControl, compressed: Buffer[], palette: Uint8Array | undefined, transparency: Uint8Array | undefined): Uint8ClampedArray {
  const channels = [1, 0, 3, 1, 2, 0, 4][header.colorType] ?? 0; if (!channels) throw new Error(`APNG color type ${header.colorType} is unsupported.`); if (![1, 2, 4, 8, 16].includes(header.depth)) throw new Error(`APNG bit depth ${header.depth} is unsupported.`); if (header.interlace !== 0) throw new Error('Interlaced APNG frames are not supported yet.');
  const bytes = unfilter(compressed, control.width, control.height, channels, header.depth); const rowBytes = Math.ceil(control.width * channels * header.depth / 8); const rgba = new Uint8ClampedArray(control.width * control.height * 4); const write = (pixel: number, red: number, green: number, blue: number, alpha = 255) => { const offset = pixel * 4; rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue; rgba[offset + 3] = alpha; };
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

export function decodeApng(bytes: Buffer): DecodedApng | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('The input is not a PNG file.');
  let offset = 8; let header: Header | undefined; let animated = false; let palette: Uint8Array | undefined; let transparency: Uint8Array | undefined; const frames: CompressedFrame[] = []; let current: CompressedFrame | undefined; const defaultChunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const chunkOffset = offset; const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8); const start = offset + 8; const end = start + length; if (end + 4 > bytes.length) throw new Error(`PNG chunk ${type} at ${chunkOffset} declares ${length} bytes beyond the ${bytes.length}-byte file boundary.`); const data = bytes.subarray(start, end); offset = end + 4;
    if (type === 'IHDR') { header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }; if (header.width < 1 || header.height < 1 || header.width > 8_192 || header.height > 8_192 || header.width * header.height > 16_777_216) throw new Error('PNG dimensions exceed AIDraw import limits.'); }
    else if (type === 'acTL') { animated = true; const count = data.readUInt32BE(0); if (count < 1 || count > MAX_APNG_FRAMES) throw new Error(`APNG frame count ${count} exceeds AIDraw limits.`); }
    else if (type === 'PLTE') palette = Uint8Array.from(data);
    else if (type === 'tRNS') transparency = Uint8Array.from(data);
    else if (type === 'fcTL') { if (!header) throw new Error('APNG frame control appears before IHDR.'); const denominator = data.readUInt16BE(22) || 100; const control: FrameControl = { width: data.readUInt32BE(4), height: data.readUInt32BE(8), x: data.readUInt32BE(12), y: data.readUInt32BE(16), delayMs: Math.max(1, Math.round(data.readUInt16BE(20) * 1000 / denominator)), dispose: data[24] as 0 | 1 | 2, blend: data[25] as 0 | 1 }; if (!control.width || !control.height || control.x + control.width > header.width || control.y + control.height > header.height || control.dispose > 2 || control.blend > 1) throw new Error('APNG frame control is invalid.'); current = { control, chunks: [] }; frames.push(current); }
    else if (type === 'IDAT') { if (current && frames[0] === current) current.chunks.push(Buffer.from(data)); else defaultChunks.push(Buffer.from(data)); }
    else if (type === 'fdAT') { if (!current || data.length < 4) throw new Error('APNG frame data has no preceding frame control.'); current.chunks.push(Buffer.from(data.subarray(4))); }
    else if (type === 'IEND') break;
  }
  if (!animated) return undefined; if (!header || !frames.length || frames.some((frame) => !frame.chunks.length)) throw new Error('APNG contains incomplete frame data.'); if (header.width * header.height * frames.length > MAX_APNG_PIXELS) throw new Error('APNG expands beyond the 256-million-pixel animation limit.');
  const canvas = new Uint8ClampedArray(header.width * header.height * 4); const decoded: DecodedApngFrame[] = [];
  for (const frame of frames) { const previous = frame.control.dispose === 2 ? canvas.slice() : undefined; const patch = rgbaFrame(header, frame.control, frame.chunks, palette, transparency); composite(canvas, header.width, frame.control, patch); decoded.push({ rgba: canvas.slice(), delayMs: frame.control.delayMs, dispose: frame.control.dispose, blend: frame.control.blend }); if (frame.control.dispose === 1) clearRect(canvas, header.width, frame.control); else if (frame.control.dispose === 2 && previous) canvas.set(previous); }
  void defaultChunks;
  return { width: header.width, height: header.height, frames: decoded };
}

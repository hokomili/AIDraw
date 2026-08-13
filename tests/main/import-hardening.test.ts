import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { MAX_ILLUSTRATION_TEXT_LENGTH, readTileAt, type PixelTilemap } from '@aidraw/core';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));
const decoderBoundary = vi.hoisted(() => ({ calls: 0, reportedWidthOffset: 0 }));
vi.mock('@napi-rs/canvas', async (importOriginal) => {
  const original = await importOriginal<typeof import('@napi-rs/canvas')>();
  return {
    ...original,
    loadImage: async (...args: Parameters<typeof original.loadImage>) => {
      decoderBoundary.calls += 1; const decoded = await original.loadImage(...args); if (!decoderBoundary.reportedWidthOffset) return decoded;
      return new Proxy(decoded, { get(target, property) { if (property === 'width') return target.width + decoderBoundary.reportedWidthOffset; if (property === 'height') return target.height; return Reflect.get(target, property, target); } });
    },
  };
});
const psdBoundary = vi.hoisted((): { calls: number; reportedWidthOffset: number; truncateCompositeBytes: boolean; totalMemoryLimit?: number } => ({ calls: 0, reportedWidthOffset: 0, truncateCompositeBytes: false }));
vi.mock('ag-psd', async (importOriginal) => {
  const original = await importOriginal<typeof import('ag-psd')>();
  return {
    ...original,
    readPsd: (...args: Parameters<typeof original.readPsd>) => {
      psdBoundary.calls += 1; psdBoundary.totalMemoryLimit = args[1]?.totalMemoryLimit; const decoded = original.readPsd(...args);
      if (psdBoundary.reportedWidthOffset) return { ...decoded, width: decoded.width + psdBoundary.reportedWidthOffset };
      if (psdBoundary.truncateCompositeBytes && decoded.imageData) return { ...decoded, imageData: { width: decoded.imageData.width, height: decoded.imageData.height, data: decoded.imageData.data.subarray(0, -4) } };
      return decoded;
    },
  };
});
const pdfBoundary = vi.hoisted((): { mode: 'real' | 'page-count' | 'page-dimension' | 'expanded'; getDocumentCalls: number; getPageCalls: number; renderCalls: number; cleanupCalls: number; destroyCalls: number; cleanupFailure: boolean; destroyFailure: boolean; events: string[]; textItems?: Array<{ str: string; width: number; height: number; transform: number[]; fontName: string; dir: 'ltr'; hasEOL: boolean }> } => ({ mode: 'real', getDocumentCalls: 0, getPageCalls: 0, renderCalls: 0, cleanupCalls: 0, destroyCalls: 0, cleanupFailure: false, destroyFailure: false, events: [] }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    ...original,
    getDocument: (...args: Parameters<typeof original.getDocument>) => {
      pdfBoundary.getDocumentCalls += 1;
      if (pdfBoundary.mode === 'real') {
        const task = original.getDocument(...args);
        const observedPromise = task.promise.then((source) => new Proxy(source, {
          get(target, property) {
            if (property === 'getPage') return async (...pageArgs: Parameters<typeof target.getPage>) => {
              const pageNumber = pageArgs[0]; pdfBoundary.getPageCalls += 1; pdfBoundary.events.push(`get:${pageNumber}`); const page = await target.getPage(...pageArgs);
              return new Proxy(page, {
                get(pageTarget, pageProperty) {
                  if (pageProperty === 'render') return (...renderArgs: Parameters<typeof pageTarget.render>) => { pdfBoundary.renderCalls += 1; pdfBoundary.events.push(`render:${pageNumber}`); return pageTarget.render(...renderArgs); };
                  if (pageProperty === 'getTextContent' && pdfBoundary.textItems) return async () => ({ items: pdfBoundary.textItems!, styles: Object.create(null), lang: null }) as unknown as Awaited<ReturnType<typeof pageTarget.getTextContent>>;
                  if (pageProperty === 'cleanup') return (...cleanupArgs: Parameters<typeof pageTarget.cleanup>) => { pdfBoundary.cleanupCalls += 1; pdfBoundary.events.push(`cleanup:${pageNumber}`); const cleaned = pageTarget.cleanup(...cleanupArgs); if (pdfBoundary.cleanupFailure) throw new Error('Injected PDF page cleanup failure.'); return cleaned; };
                  const value = Reflect.get(pageTarget, pageProperty, pageTarget); return typeof value === 'function' ? value.bind(pageTarget) : value;
                },
              });
            };
            const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
          },
        }));
        return new Proxy(task, {
          get(target, property) {
            if (property === 'promise') return observedPromise;
            if (property === 'destroy') return async () => { pdfBoundary.destroyCalls += 1; pdfBoundary.events.push('destroy'); await target.destroy(); if (pdfBoundary.destroyFailure) throw new Error('Injected PDF loading-task destroy failure.'); };
            const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      const numPages = pdfBoundary.mode === 'page-count' ? 257 : pdfBoundary.mode === 'expanded' ? 5 : 1;
      const width = pdfBoundary.mode === 'page-dimension' ? 8_193 : 4_096; const height = pdfBoundary.mode === 'page-dimension' ? 1 : 4_096;
      return {
        promise: Promise.resolve({
          numPages,
          getPage: async (pageNumber: number) => {
            pdfBoundary.getPageCalls += 1; pdfBoundary.events.push(`get:${pageNumber}`);
            return {
              getViewport: () => ({ width, height }),
              render: () => { pdfBoundary.renderCalls += 1; pdfBoundary.events.push(`render:${pageNumber}`); return { promise: Promise.resolve() }; },
              getTextContent: async () => ({ items: [] }),
              cleanup: () => { pdfBoundary.cleanupCalls += 1; pdfBoundary.events.push(`cleanup:${pageNumber}`); if (pdfBoundary.cleanupFailure) throw new Error('Injected PDF page cleanup failure.'); return true; },
            };
          },
        }),
        destroy: async () => { pdfBoundary.destroyCalls += 1; pdfBoundary.events.push('destroy'); if (pdfBoundary.destroyFailure) throw new Error('Injected PDF loading-task destroy failure.'); },
      } as unknown as ReturnType<typeof original.getDocument>;
    },
  };
});

import { accountPdfEditableText, importDocument, MAX_STRUCTURED_IMPORT_BYTES, renderPdfPagePng } from '../../src/main/import-document';
import { inspectImageHeader } from '../../src/main/transaction-policy';
import { runImportUtilityRequest } from '../../src/main/utility-import';
import { MAX_IMPORT_UTILITY_SERIALIZED_BYTES } from '../../src/main/utility-contract';

const temporaryDirectories: string[] = [];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii'); const chunk = Buffer.alloc(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0); typeBytes.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, data.byteLength + 8);
  return chunk;
}

/** Tiny RGBA fixture generated from the PNG Adam7 seven-pass geometry; no external corpus or encoder is involved. */
function adam7Png(width = 8, height = 8): Buffer {
  const passes = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ] as const;
  const scanlines: Buffer[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    for (let y = startY; y < height; y += stepY) {
      const row: number[] = [0];
      for (let x = startX; x < width; x += stepX) row.push(x * 31, y * 31, (x * 17 + y * 13) & 0xff, 255);
      scanlines.push(Buffer.from(row));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 1;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(scanlines))), pngChunk('IEND')]);
}

function withPngHeaderDimensions(bytes: Buffer, width: number, height: number): Buffer {
  const patched = Buffer.from(bytes); patched.writeUInt32BE(width, 16); patched.writeUInt32BE(height, 20);
  patched.writeUInt32BE(crc32(patched.subarray(12, 29)) >>> 0, 29);
  return patched;
}

/** Minimal 2×2, 8-bit RGB PSD with empty metadata sections and raw planar composite pixels. */
function minimalRgbPsd(): Buffer {
  const header = Buffer.alloc(26); header.write('8BPS', 0, 'ascii'); header.writeUInt16BE(1, 4); header.writeUInt16BE(3, 12); header.writeUInt32BE(2, 14); header.writeUInt32BE(2, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const sections = Buffer.alloc(12); const composite = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255]);
  return Buffer.concat([header, sections, composite]);
}

/** Writer-produced PSD with one layer record and a one-byte-past-EOF extra-data-length twin. */
async function psdLayerRecordLengthCorpus(): Promise<{ valid: Buffer; malformed: Buffer; extraDataLengthOffset: number; validLength: number; malformedLength: number }> {
  const { writePsdBuffer } = await import('ag-psd');
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const imageData = { width: 2, height: 2, data: rgba };
  const valid = writePsdBuffer({ width: 2, height: 2, imageData, children: [{ name: 'Layer 1', left: 0, top: 0, right: 2, bottom: 2, imageData }] }, { generateThumbnail: false });
  if (valid.toString('ascii', 0, 4) !== '8BPS' || valid.readUInt16BE(4) !== 1) throw new Error('Expected a standard writer-produced PSD fixture.');
  let offset = 26; offset += 4 + valid.readUInt32BE(offset); offset += 4 + valid.readUInt32BE(offset);
  const layerAndMaskStart = offset + 4; const layerAndMaskEnd = layerAndMaskStart + valid.readUInt32BE(offset);
  const layerInfoStart = layerAndMaskStart + 4; const layerInfoEnd = layerInfoStart + valid.readUInt32BE(layerAndMaskStart);
  if (layerInfoEnd > layerAndMaskEnd || valid.readInt16BE(layerInfoStart) !== 1) throw new Error('Expected one bounded PSD layer record.');
  const recordStart = layerInfoStart + 2; const channelCountOffset = recordStart + 16; const channelCount = valid.readUInt16BE(channelCountOffset);
  const extraDataLengthOffset = channelCountOffset + 2 + channelCount * 6 + 12; const validLength = valid.readUInt32BE(extraDataLengthOffset);
  if (channelCount !== 3 || extraDataLengthOffset + 4 + validLength > layerInfoEnd) throw new Error('Expected one bounded RGB PSD layer record.');
  const malformedLength = valid.byteLength - (extraDataLengthOffset + 4) + 1; const malformed = Buffer.from(valid); malformed.writeUInt32BE(malformedLength, extraDataLengthOffset);
  return { valid, malformed, extraDataLengthOffset, validLength, malformedLength };
}

/** Same one-layer PSD with a first-channel declaration just beyond ag-psd's existing bounded read fallback. */
async function psdLayerChannelLengthCorpus(): Promise<{ valid: Buffer; malformed: Buffer; channelLengthOffset: number; validLength: number; malformedLength: number }> {
  const { valid } = await psdLayerRecordLengthCorpus();
  let offset = 26; offset += 4 + valid.readUInt32BE(offset); offset += 4 + valid.readUInt32BE(offset);
  const layerInfoStart = offset + 8; if (valid.readInt16BE(layerInfoStart) !== 1) throw new Error('Expected one PSD layer record for the channel-length fixture.');
  const recordStart = layerInfoStart + 2; const channelCountOffset = recordStart + 16; const channelLengthOffset = channelCountOffset + 4;
  const validLength = valid.readUInt32BE(channelLengthOffset); const malformedLength = 100 * 1024 * 1024 + 3;
  if (valid.readUInt16BE(channelCountOffset) !== 3 || validLength !== 12) throw new Error('Expected one bounded RGB PSD channel record.');
  const malformed = Buffer.from(valid); malformed.writeUInt32BE(malformedLength, channelLengthOffset);
  return { valid, malformed, channelLengthOffset, validLength, malformedLength };
}

/** Same one-layer PSD with a first-channel declaration ending exactly one byte past EOF. */
async function psdShortLayerChannelLengthCorpus(): Promise<{ valid: Buffer; malformed: Buffer; channelDataStart: number; channelLengthOffset: number; validLength: number; malformedLength: number }> {
  const { valid, extraDataLengthOffset, validLength: extraDataLength } = await psdLayerRecordLengthCorpus();
  let offset = 26; offset += 4 + valid.readUInt32BE(offset); offset += 4 + valid.readUInt32BE(offset);
  const layerInfoStart = offset + 8; const recordStart = layerInfoStart + 2; const channelCountOffset = recordStart + 16; const channelLengthOffset = channelCountOffset + 4;
  const channelDataStart = extraDataLengthOffset + 4 + extraDataLength; const validLength = valid.readUInt32BE(channelLengthOffset); const malformedLength = valid.byteLength - channelDataStart + 1;
  if (valid.readInt16BE(layerInfoStart) !== 1 || valid.readUInt16BE(channelCountOffset) !== 3 || validLength !== 12) throw new Error('Expected one bounded RGB PSD channel record.');
  const malformed = Buffer.from(valid); malformed.writeUInt32BE(malformedLength, channelLengthOffset);
  return { valid, malformed, channelDataStart, channelLengthOffset, validLength, malformedLength };
}

/** Same one-layer PSD with the first channel consuming one byte of the next channel's compression field. */
async function psdOverlappingLayerChannelLengthCorpus(): Promise<{ valid: Buffer; malformed: Buffer; channelDataStart: number; channelLengthOffset: number; validLength: number; malformedLength: number }> {
  const { valid, extraDataLengthOffset, validLength: extraDataLength } = await psdLayerRecordLengthCorpus();
  let offset = 26; offset += 4 + valid.readUInt32BE(offset); offset += 4 + valid.readUInt32BE(offset);
  const layerInfoStart = offset + 8; const recordStart = layerInfoStart + 2; const channelCountOffset = recordStart + 16; const channelLengthOffset = channelCountOffset + 4;
  const channelDataStart = extraDataLengthOffset + 4 + extraDataLength; const validLength = valid.readUInt32BE(channelLengthOffset); const malformedLength = validLength + 1;
  if (valid.readInt16BE(layerInfoStart) !== 1 || valid.readUInt16BE(channelCountOffset) !== 3 || validLength !== 12) throw new Error('Expected one bounded RGB PSD channel record.');
  const malformed = Buffer.from(valid); malformed.writeUInt32BE(malformedLength, channelLengthOffset);
  return { valid, malformed, channelDataStart, channelLengthOffset, validLength, malformedLength };
}

async function minimalPdf(pageCount = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create(); for (let page = 0; page < pageCount; page += 1) pdf.addPage([16, 12]);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function malformedPdfObjectStreamCorpus(): Promise<Array<{ name: string; bytes: Buffer; errorName: string; errorMessage: string }>> {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const page = pdf.addPage([16, 12]); page.drawRectangle({ x: 1, y: 1, width: 4, height: 3, color: rgb(1, 0, 0) });
  const valid = Buffer.from(await pdf.save({ useObjectStreams: false })); const text = valid.toString('latin1');
  const mutate = (pattern: RegExp, replacement: (match: string) => string): Buffer => {
    const matches = [...text.matchAll(pattern)]; if (matches.length !== 1) throw new Error(`Expected exactly one PDF fixture token for ${pattern}.`);
    const updated = text.replace(pattern, replacement); if (Buffer.byteLength(updated, 'latin1') !== valid.byteLength) throw new Error(`PDF fixture mutation changed byte length for ${pattern}.`); return Buffer.from(updated, 'latin1');
  };
  return [
    { name: 'missing-catalog-root', bytes: mutate(/\/Root (\d+) 0 R/g, (match) => match.replace(/\d+/, (id) => '9'.repeat(id.length))), errorName: 'InvalidPDFException', errorMessage: 'Invalid Root reference.' },
    { name: 'missing-page-tree-kid', bytes: mutate(/\/Kids \[ (\d+) 0 R \]/g, (match) => match.replace(/\d+/, (id) => '9'.repeat(id.length))), errorName: 'UnknownErrorException', errorMessage: 'Page dictionary kid reference points to wrong type of object.' },
    { name: 'missing-endstream', bytes: mutate(/endstream/g, () => 'endstreaX'), errorName: 'UnknownErrorException', errorMessage: 'Missing endstream command.' },
  ];
}

/** Fixed-date pdf-lib fixture with a real Flate-compressed /ObjStm; every hostile twin changes exactly one byte. */
async function malformedPdfObjectStreamFilterCorpus(): Promise<{ valid: Buffer; fixtures: Array<{ name: string; bytes: Buffer; errorName: string; errorMessage: string }> }> {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const page = pdf.addPage([16, 12]); page.drawRectangle({ x: 1, y: 1, width: 4, height: 3, color: rgb(1, 0, 0) });
  const valid = Buffer.from(await pdf.save({ useObjectStreams: true })); const objectStreamMarker = Buffer.from('/Type /ObjStm', 'ascii'); const markerOffset = valid.indexOf(objectStreamMarker);
  const filter = Buffer.from('/FlateDecode', 'ascii'); const filterOffset = valid.lastIndexOf(filter, markerOffset); const streamMarker = Buffer.from('stream\n', 'ascii'); const streamOffset = valid.indexOf(streamMarker, markerOffset) + streamMarker.byteLength;
  if (markerOffset < 0 || filterOffset < 0 || streamOffset < streamMarker.byteLength || valid.indexOf(objectStreamMarker, markerOffset + 1) >= 0) throw new Error('Expected one Flate-compressed PDF object stream fixture.');
  const unknownFilter = Buffer.from(valid); unknownFilter[filterOffset + filter.byteLength - 1] = 'X'.charCodeAt(0);
  const invalidFlateHeader = Buffer.from(valid); invalidFlateHeader[streamOffset] = 0;
  return {
    valid,
    fixtures: [
      { name: 'unknown-object-stream-filter', bytes: unknownFilter, errorName: 'InvalidPDFException', errorMessage: 'Invalid Root reference.' },
      { name: 'invalid-object-stream-flate-header', bytes: invalidFlateHeader, errorName: 'InvalidPDFException', errorMessage: 'Invalid Root reference.' },
    ],
  };
}

/** Fixed-date PDF with one rendered RGB image whose Flate stream uses PNG predictor parameters. */
async function pdfFlatePredictorCorpus(): Promise<{ valid: Buffer; invalidPredictor: Buffer; recoveredZeroColumns: Buffer }> {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const page = pdf.addPage([16, 12]); const predictorRows = Uint8Array.from([0, 210, 102, 130, 56, 111, 164, 210, 102, 130, 0, 56, 111, 164, 210, 102, 130, 56, 111, 164]);
  const image = pdf.context.flateStream(predictorRows, { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 3 } });
  const imageKey = page.node.newXObject('PredictorImage', pdf.context.register(image)); page.pushOperators(pushGraphicsState(), concatTransformationMatrix(6, 0, 0, 4, 1, 1), drawObject(imageKey), popGraphicsState());
  const valid = Buffer.from(await pdf.save({ useObjectStreams: false })); const text = valid.toString('latin1');
  const mutate = (token: string, replacement: string): Buffer => {
    const matches = text.split(token); if (matches.length !== 2 || replacement.length !== token.length) throw new Error(`Expected one same-size PDF predictor token for ${token}.`);
    return Buffer.from(`${matches[0]}${replacement}${matches[1]}`, 'latin1');
  };
  return { valid, invalidPredictor: mutate('/Predictor 15', '/Predictor 16'), recoveredZeroColumns: mutate('/Columns 3', '/Columns 0') };
}

/** Fixed-date RGB image encoded through ASCIIHexDecode and then FlateDecode. */
async function pdfMultiFilterChainCorpus(): Promise<{ valid: Buffer; reversedOrder: Buffer; truncatedEncodedStream: Buffer }> {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const page = pdf.addPage([16, 12]); const pixels = Uint8Array.from([210, 102, 130, 56, 111, 164, 210, 102, 130, 56, 111, 164, 210, 102, 130, 56, 111, 164]);
  const encoded = Buffer.from(`${deflateSync(pixels).toString('hex').toUpperCase()}>`, 'ascii');
  const image = pdf.context.stream(encoded, { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: ['ASCIIHexDecode', 'FlateDecode'] });
  const imageKey = page.node.newXObject('ChainedImage', pdf.context.register(image)); page.pushOperators(pushGraphicsState(), concatTransformationMatrix(6, 0, 0, 4, 1, 1), drawObject(imageKey), popGraphicsState());
  const valid = Buffer.from(await pdf.save({ useObjectStreams: false })); const text = valid.toString('latin1'); const filterChain = '/Filter [ /ASCIIHexDecode /FlateDecode ]'; const reversedChain = '/Filter [ /FlateDecode /ASCIIHexDecode ]'; const encodedText = encoded.toString('ascii');
  if (text.split(filterChain).length !== 2 || filterChain.length !== reversedChain.length || text.split(encodedText).length !== 2) throw new Error('Expected one stable PDF multi-filter fixture.');
  const truncatedText = `${encodedText.slice(0, 2)}>${encodedText.slice(3, -1)} `;
  return { valid, reversedOrder: Buffer.from(text.replace(filterChain, reversedChain), 'latin1'), truncatedEncodedStream: Buffer.from(text.replace(encodedText, truncatedText), 'latin1') };
}

function ascii85Encode(bytes: Buffer): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const byteCount = Math.min(4, bytes.byteLength - offset); const chunk = Buffer.alloc(4); bytes.copy(chunk, 0, offset, offset + byteCount);
    let value = chunk.readUInt32BE(0); const digits = Array<string>(5);
    for (let index = digits.length - 1; index >= 0; index -= 1) { digits[index] = String.fromCharCode((value % 85) + 33); value = Math.floor(value / 85); }
    encoded += digits.slice(0, byteCount + 1).join('');
  }
  return `${encoded}~>`;
}

/** Fixed-date RGB image encoded through ASCII85Decode and then FlateDecode. */
async function pdfAscii85FlateEodCorpus(): Promise<{ valid: Buffer; prematureEod: Buffer }> {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const page = pdf.addPage([16, 12]); const pixels = Uint8Array.from([210, 102, 130, 56, 111, 164, 210, 102, 130, 56, 111, 164, 210, 102, 130, 56, 111, 164]);
  const encoded = ascii85Encode(deflateSync(pixels));
  const image = pdf.context.stream(Buffer.from(encoded, 'ascii'), { Type: 'XObject', Subtype: 'Image', Width: 3, Height: 2, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: ['ASCII85Decode', 'FlateDecode'] });
  const imageKey = page.node.newXObject('Ascii85Image', pdf.context.register(image)); page.pushOperators(pushGraphicsState(), concatTransformationMatrix(6, 0, 0, 4, 1, 1), drawObject(imageKey), popGraphicsState());
  const valid = Buffer.from(await pdf.save({ useObjectStreams: false })); const text = valid.toString('latin1'); const filterChain = '/Filter [ /ASCII85Decode /FlateDecode ]';
  if (text.split(filterChain).length !== 2 || text.split(encoded).length !== 2 || encoded.slice(0, 2) !== 'Ga') throw new Error('Expected one stable PDF ASCII85/Flate fixture.');
  const prematureEod = `${encoded.slice(0, 2)}~>${encoded.slice(4, -2)}  `;
  return { valid, prematureEod: Buffer.from(text.replace(encoded, prematureEod), 'latin1') };
}

function nestedTiledMap(groupCount: number, leaf: Record<string, unknown> = { type: 'tilelayer', name: 'Ground', width: 1, height: 1, data: [7] }): Record<string, unknown> {
  let layer: Record<string, unknown> = leaf;
  for (let index = groupCount; index >= 1; index -= 1) layer = { type: 'group', name: `Group ${index}`, layers: [layer] };
  return { type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16, tilesets: [], layers: [layer] };
}

function nestedTmx(groupCount: number, leaf = '<layer name="XML Ground" width="1" height="1"><data encoding="csv">7</data></layer>'): string {
  let layer = leaf;
  for (let index = groupCount; index >= 1; index -= 1) layer = `<group name="XML Group ${index}">${layer}</group>`;
  return `<?xml version="1.0" encoding="UTF-8"?><map version="1.10" tiledversion="1.11.2" orientation="orthogonal" renderorder="right-down" infinite="0" width="1" height="1" tilewidth="16" tileheight="16">${layer}</map>`;
}

function tiledLayerBudgetMap(layerCount: number, finalLayer: Record<string, unknown> = { type: 'tilelayer', name: 'Layer-budget marker', width: 1, height: 1, data: [7] }): Record<string, unknown> {
  const layers = Array.from({ length: layerCount - 1 }, (_, index) => ({ type: 'objectgroup', name: `Empty object layer ${index + 1}`, objects: [] as unknown[] })); layers.push(finalLayer as typeof layers[number]);
  return { type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16, tilesets: [], layers };
}

type GeneratedTiledLayer =
  | { type: 'group'; name: string; layers: GeneratedTiledLayer[] }
  | { type: 'objectgroup'; name: string; objects: [] }
  | { type: 'tilelayer'; name: string; width: number; height: number; data: number[] | string; encoding?: 'base64'; compression?: 'zlib' };

function generatedTiledMap(layers: GeneratedTiledLayer[]): Record<string, unknown> {
  return { type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16, tilesets: [], layers };
}

function generatedHierarchy(seed: number, groupDepth: number, hostileLeaf = false): GeneratedTiledLayer[] {
  let serial = 0;
  const gid = () => 1 + ((seed + serial++ * 97) % 4_095);
  let nested: GeneratedTiledLayer = hostileLeaf
    ? { type: 'tilelayer', name: `Hostile leaf ${seed}`, width: 4_097, height: 1_024, encoding: 'base64', compression: 'zlib', data: '!not-base64!' }
    : { type: 'tilelayer', name: `Leaf ${seed}`, width: 1, height: 1, data: [gid()] };
  for (let level = groupDepth; level >= 1; level -= 1) {
    const objectLayer: GeneratedTiledLayer = { type: 'objectgroup', name: `Object ${seed}-${level}`, objects: [] };
    const tileLayer: GeneratedTiledLayer = { type: 'tilelayer', name: `Tile ${seed}-${level}`, width: 1, height: 1, data: [gid()] };
    const order = (seed + level) % 3;
    const layers: GeneratedTiledLayer[] = hostileLeaf ? [nested, objectLayer, tileLayer] : order === 0 ? [nested, objectLayer, tileLayer] : order === 1 ? [objectLayer, tileLayer, nested] : [tileLayer, nested, objectLayer];
    nested = { type: 'group', name: `Group ${seed}-${level}`, layers };
  }
  if (hostileLeaf) return [nested];
  const rootTile: GeneratedTiledLayer = { type: 'tilelayer', name: `Root tile ${seed}`, width: 1, height: 1, data: [gid()] };
  const rootObject: GeneratedTiledLayer = { type: 'objectgroup', name: `Root object ${seed}`, objects: [] };
  return seed % 2 === 0 ? [rootTile, nested, rootObject] : [nested, rootObject, rootTile];
}

function generatedGlobalLayerBoundary(overflow: boolean): GeneratedTiledLayer[] {
  const roots = Array.from({ length: 64 }, (_, rootIndex): GeneratedTiledLayer => {
    const markerPosition = (rootIndex * 17) % 63;
    const layers = Array.from({ length: 63 }, (_, childIndex): GeneratedTiledLayer => childIndex === markerPosition
      ? { type: 'tilelayer', name: `Boundary marker ${rootIndex + 1}`, width: 1, height: 1, data: [rootIndex + 1] }
      : { type: 'objectgroup', name: `Boundary object ${rootIndex + 1}-${childIndex + 1}`, objects: [] });
    return { type: 'group', name: `Boundary group ${rootIndex + 1}`, layers };
  });
  if (overflow) {
    const last = roots.at(-1); if (last?.type !== 'group') throw new Error('Expected final generated group');
    last.layers.push({ type: 'tilelayer', name: 'Hostile global layer 4097', width: 4_097, height: 1_024, encoding: 'base64', compression: 'zlib', data: '!not-base64!' });
  }
  return roots;
}

function countGeneratedLayers(layers: GeneratedTiledLayer[]): number {
  return layers.reduce((total, layer) => total + 1 + (layer.type === 'group' ? countGeneratedLayers(layer.layers) : 0), 0);
}

function expectCanonicalHierarchy(map: PixelTilemap, sources: GeneratedTiledLayer[], ids = map.layerIds, parentId?: string): void {
  expect(ids).toHaveLength(sources.length);
  for (const [index, source] of sources.entries()) {
    const layer = map.layers[ids[index]]; expect(layer).toBeDefined(); expect(layer.name).toBe(source.name); expect(layer.parentId).toBe(parentId);
    if (source.type === 'group') {
      if (layer.type !== 'group') throw new Error(`Expected canonical group ${source.name}`);
      expectCanonicalHierarchy(map, source.layers, layer.childIds ?? [], layer.id);
    } else if (source.type === 'tilelayer') {
      if (layer.type !== 'tile' || !layer.chunks || !Array.isArray(source.data)) throw new Error(`Expected canonical tile ${source.name}`);
      expect(readTileAt(layer.chunks, 0, 0)).toBe(source.data[0]);
    } else {
      if (layer.type !== 'object') throw new Error(`Expected canonical object layer ${source.name}`);
      expect(layer.objects).toEqual([]);
    }
  }
}

function canonicalInlineTmxOrder(layers: GeneratedTiledLayer[]): GeneratedTiledLayer[] {
  const normalize = (layer: GeneratedTiledLayer): GeneratedTiledLayer => layer.type === 'group'
    ? { ...layer, layers: canonicalInlineTmxOrder(layer.layers) }
    : layer;
  return [
    ...layers.filter((layer) => layer.type === 'tilelayer'),
    ...layers.filter((layer) => layer.type === 'objectgroup'),
    ...layers.filter((layer) => layer.type === 'group'),
  ].map(normalize);
}

function generatedInlineTmx(layers: GeneratedTiledLayer[]): string {
  const serializeLayer = (layer: GeneratedTiledLayer): string => {
    if (layer.type === 'group') return `<group name="${layer.name}">${layer.layers.map(serializeLayer).join('')}</group>`;
    if (layer.type === 'objectgroup') return `<objectgroup name="${layer.name}"/>`;
    const data = Array.isArray(layer.data) ? layer.data.join(',') : layer.data;
    return `<layer name="${layer.name}" width="${layer.width}" height="${layer.height}"><data encoding="csv">${data}</data></layer>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><map version="1.10" tiledversion="1.11.2" orientation="orthogonal" renderorder="right-down" infinite="0" width="1" height="1" tilewidth="16" tileheight="16">${layers.map(serializeLayer).join('')}</map>`;
}

function generatedInlineTmxOverDepth(seed: number): GeneratedTiledLayer[] {
  let nested: GeneratedTiledLayer = { type: 'tilelayer', name: `Hostile XML leaf ${seed}`, width: 4_097, height: 1_024, data: 'not-a-gid' };
  for (let level = 65; level >= 1; level -= 1) {
    const tile: GeneratedTiledLayer = { type: 'tilelayer', name: `XML safe tile ${seed}-${level}`, width: 1, height: 1, data: [1 + ((seed + level) % 4_095)] };
    const object: GeneratedTiledLayer = { type: 'objectgroup', name: `XML safe object ${seed}-${level}`, objects: [] };
    const order = (seed + level) % 3;
    const layers: GeneratedTiledLayer[] = order === 0 ? [nested, object, tile] : order === 1 ? [object, tile, nested] : [tile, nested, object];
    nested = { type: 'group', name: `XML hostile group ${seed}-${level}`, layers };
  }
  return [nested];
}

function generatedInlineTmxGlobalBoundary(overflow: boolean): GeneratedTiledLayer[] {
  let nested: GeneratedTiledLayer | undefined;
  for (let level = 64; level >= 1; level -= 1) {
    const leaves = Array.from({ length: 63 }, (_, index): GeneratedTiledLayer => ({
      type: 'tilelayer', name: `XML boundary tile ${level}-${index + 1}`, width: 1, height: 1, data: [1 + ((level * 67 + index * 31) % 4_095)],
    }));
    if (level === 64 && overflow) leaves.push({ type: 'tilelayer', name: 'Hostile XML global layer 4097', width: 4_097, height: 1_024, data: 'not-a-gid' });
    nested = { type: 'group', name: `XML boundary group ${level}`, layers: nested ? [nested, ...leaves] : leaves };
  }
  if (!nested) throw new Error('Expected generated inline TMX hierarchy');
  return [nested];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-import-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  decoderBoundary.calls = 0; decoderBoundary.reportedWidthOffset = 0;
  psdBoundary.calls = 0; psdBoundary.reportedWidthOffset = 0; psdBoundary.truncateCompositeBytes = false; psdBoundary.totalMemoryLimit = undefined;
  pdfBoundary.mode = 'real'; pdfBoundary.getDocumentCalls = 0; pdfBoundary.getPageCalls = 0; pdfBoundary.renderCalls = 0; pdfBoundary.cleanupCalls = 0; pdfBoundary.destroyCalls = 0; pdfBoundary.cleanupFailure = false; pdfBoundary.destroyFailure = false; pdfBoundary.events = []; pdfBoundary.textItems = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('untrusted import limits', () => {
  it('rejects a structured root file before reading beyond its byte budget', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'oversized.tmj'); await writeFile(filePath, ''); await truncate(filePath, MAX_STRUCTURED_IMPORT_BYTES + 1);
    await expect(importDocument(filePath, true)).rejects.toThrow(/16 MiB safety limit/);
  });

  it('rejects DTD and entity declarations in SVG and Tiled XML', async () => {
    const directory = await temporaryDirectory(); const svg = join(directory, 'unsafe.svg'); const map = join(directory, 'unsafe.tmx');
    await writeFile(svg, '<!DOCTYPE svg [<!ENTITY local SYSTEM "file:///secret">]><svg width="1" height="1"><text>&local;</text></svg>');
    await writeFile(map, '<!DOCTYPE map [<!ENTITY local SYSTEM "file:///secret">]><map width="1" height="1" tilewidth="1" tileheight="1"><layer width="1" height="1"><data encoding="csv">0</data></layer></map>');
    await expect(importDocument(svg)).rejects.toThrow(/cannot contain DTD or entity declarations/);
    await expect(importDocument(map, true)).rejects.toThrow(/cannot contain DTD or entity declarations/);
  });

  it('prevents sprite-sheet metadata from escaping the approved folder', async () => {
    const directory = await temporaryDirectory(); const approved = join(directory, 'approved'); await writeFile(join(directory, 'outside.png'), 'not an image'); await mkdir(approved); const metadataPath = join(approved, 'sheet.json');
    await writeFile(metadataPath, JSON.stringify({ frames: [{ frame: { x: 0, y: 0, w: 1, h: 1 } }], meta: { image: '../outside.png' } }));
    await expect(importDocument(metadataPath, true)).rejects.toThrow(/outside the approved import folder/);
  });

  it('prevents Tiled maps and tilesets from escaping through companion references', async () => {
    const directory = await temporaryDirectory(); const approved = join(directory, 'approved'); await mkdir(approved);
    await writeFile(join(directory, 'outside.tsx'), '<tileset name="Outside" tilewidth="1" tileheight="1" tilecount="1" columns="1"/>'); await writeFile(join(directory, 'outside.png'), 'not an image');
    const mapPath = join(approved, 'map.tmj'); await writeFile(mapPath, JSON.stringify({ type: 'map', width: 1, height: 1, tilewidth: 1, tileheight: 1, tilesets: [{ firstgid: 1, source: '../outside.tsx' }], layers: [{ type: 'tilelayer', width: 1, height: 1, data: [0] }] }));
    const tilesetPath = join(approved, 'tileset.tsj'); await writeFile(tilesetPath, JSON.stringify({ type: 'tileset', name: 'Unsafe', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1, image: '../outside.png', imagewidth: 1, imageheight: 1 }));
    await expect(importDocument(mapPath, true)).rejects.toThrow(/outside the approved import folder/);
    await expect(importDocument(tilesetPath, true)).rejects.toThrow(/outside the approved import folder/);
  });

  it('rejects oversized finite maps and inconsistent tile arrays', async () => {
    const directory = await temporaryDirectory(); const huge = join(directory, 'huge.tmj'); const short = join(directory, 'short.tmj');
    await writeFile(huge, JSON.stringify({ type: 'map', width: 4097, height: 1024, tilewidth: 16, tileheight: 16, layers: [] }));
    await writeFile(short, JSON.stringify({ type: 'map', width: 2, height: 2, tilewidth: 16, tileheight: 16, layers: [{ type: 'tilelayer', width: 2, height: 2, data: [0] }] }));
    await expect(importDocument(huge, true)).rejects.toThrow(/cell layer limit/);
    await expect(importDocument(short, true)).rejects.toThrow(/contains 1 cells; expected 4/);
  });

  it('bounds compressed Tiled layer expansion to the declared dimensions', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'bomb.tmj'); const compressed = deflateSync(Buffer.alloc(1_024)).toString('base64');
    await writeFile(filePath, JSON.stringify({ type: 'map', width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ type: 'tilelayer', width: 1, height: 1, encoding: 'base64', compression: 'zlib', data: compressed }] }));
    await expect(importDocument(filePath, true)).rejects.toThrow();
  });

  it('imports the boundary-valid Tiled group depth with its exact canonical parent-child hierarchy', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'nested-boundary.tmj'); await writeFile(filePath, JSON.stringify(nestedTiledMap(64)));
    const imported = await runImportUtilityRequest({ id: 'nested-tiled-boundary', kind: 'import-document', filePath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map.layerIds).toHaveLength(1); expect(Object.keys(map.layers)).toHaveLength(65); let currentId = map.layerIds[0]; let parentId: string | undefined;
    for (let index = 1; index <= 64; index += 1) {
      const group = map.layers[currentId]; if (group.type !== 'group') throw new Error(`Expected group ${index}`);
      if (!group.childIds || group.childIds.length !== 1) throw new Error(`Expected one child in group ${index}`);
      expect(group.name).toBe(`Group ${index}`); expect(group.parentId).toBe(parentId); parentId = group.id; currentId = group.childIds[0];
    }
    const leaf = map.layers[currentId]; if (leaf.type !== 'tile' || !leaf.chunks) throw new Error('Expected nested tile layer'); expect(leaf).toMatchObject({ name: 'Ground', parentId }); expect(readTileAt(leaf.chunks, 0, 0)).toBe(7);
  });

  it('rejects an over-depth Tiled group before validating or expanding its hostile leaf', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'nested-over-depth.tmj');
    await writeFile(filePath, JSON.stringify(nestedTiledMap(65, { type: 'tilelayer', name: 'Unreachable oversized leaf', width: 4_097, height: 1_024, data: [] })));
    await expect(runImportUtilityRequest({ id: 'nested-tiled-over-depth', kind: 'import-document', filePath, pixelMode: true })).rejects.toThrow('Tiled group nesting exceeds the 64-level safety limit.');
  });

  it('imports the boundary-valid inline TMX group depth with its exact canonical hierarchy', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'nested-boundary.tmx'); await writeFile(filePath, nestedTmx(64));
    const imported = await runImportUtilityRequest({ id: 'nested-tmx-boundary', kind: 'import-document', filePath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map.layerIds).toHaveLength(1); expect(Object.keys(map.layers)).toHaveLength(65); let currentId = map.layerIds[0]; let parentId: string | undefined;
    for (let index = 1; index <= 64; index += 1) {
      const group = map.layers[currentId]; if (group.type !== 'group') throw new Error(`Expected XML group ${index}`);
      if (!group.childIds || group.childIds.length !== 1) throw new Error(`Expected one child in XML group ${index}`);
      expect(group.name).toBe(`XML Group ${index}`); expect(group.parentId).toBe(parentId); parentId = group.id; currentId = group.childIds[0];
    }
    const leaf = map.layers[currentId]; if (leaf.type !== 'tile' || !leaf.chunks) throw new Error('Expected nested XML tile layer'); expect(leaf).toMatchObject({ name: 'XML Ground', parentId }); expect(readTileAt(leaf.chunks, 0, 0)).toBe(7);
  });

  it('rejects an over-depth inline TMX group before parsing or expanding its hostile leaf', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'nested-over-depth.tmx');
    const leaf = '<layer name="Unreachable XML leaf" width="4097" height="1024"><data encoding="base64" compression="zlib">!not-base64!</data></layer>'; await writeFile(filePath, nestedTmx(65, leaf));
    await expect(runImportUtilityRequest({ id: 'nested-tmx-over-depth', kind: 'import-document', filePath, pixelMode: true })).rejects.toThrow('Tiled group nesting exceeds the 64-level safety limit.');
  });

  it('imports exactly 4,096 shallow Tiled layers with one identifiable canonical tile leaf', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'layer-budget-boundary.tmj'); await writeFile(filePath, JSON.stringify(tiledLayerBudgetMap(4_096)));
    const imported = await runImportUtilityRequest({ id: 'tiled-layer-budget-boundary', kind: 'import-document', filePath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map.layerIds).toHaveLength(4_096); expect(Object.keys(map.layers)).toHaveLength(4_096); expect(map.layers[map.layerIds[0]]).toMatchObject({ type: 'object', name: 'Empty object layer 1', parentId: undefined });
    expect(map.layerIds.slice(0, -1).every((id, index) => map.layers[id].type === 'object' && map.layers[id].name === `Empty object layer ${index + 1}` && map.layers[id].parentId === undefined)).toBe(true);
    const leaf = map.layers[map.layerIds.at(-1)!]; if (leaf.type !== 'tile' || !leaf.chunks) throw new Error('Expected layer-budget tile marker'); expect(leaf).toMatchObject({ name: 'Layer-budget marker', parentId: undefined }); expect(readTileAt(leaf.chunks, 0, 0)).toBe(7);
  });

  it('rejects sibling 4,097 before parsing its hostile layer data or constructing a canonical document', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'layer-budget-overflow.tmj');
    const hostile = { type: 'tilelayer', name: 'Unreachable layer 4097', width: 4_097, height: 1_024, encoding: 'base64', compression: 'zlib', data: '!not-base64!' }; await writeFile(filePath, JSON.stringify(tiledLayerBudgetMap(4_097, hostile)));
    await expect(runImportUtilityRequest({ id: 'tiled-layer-budget-overflow', kind: 'import-document', filePath, pixelMode: true })).rejects.toThrow('Tiled map exceeds the 4,096-layer limit.');
  });

  it('holds Tiled depth, ordering, GID, and global-layer properties across a deterministic generated hierarchy family', async () => {
    const directory = await temporaryDirectory();
    for (const [seed, depth] of [[11, 0], [29, 1], [47, 2], [83, 7], [131, 16], [197, 32], [251, 64]] as const) {
      const layers = generatedHierarchy(seed, depth); const filePath = join(directory, `property-valid-${seed}-${depth}.tmj`); await writeFile(filePath, JSON.stringify(generatedTiledMap(layers)));
      const imported = await runImportUtilityRequest({ id: `tiled-property-valid-${seed}-${depth}`, kind: 'import-document', filePath, pixelMode: true }); expect(imported.warnings).toEqual([]);
      const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected generated pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected generated tilemap');
      expect(Object.keys(map.layers)).toHaveLength(countGeneratedLayers(layers)); expectCanonicalHierarchy(map, layers);
    }

    for (const seed of [313, 509, 887]) {
      const filePath = join(directory, `property-over-depth-${seed}.tmj`); await writeFile(filePath, JSON.stringify(generatedTiledMap(generatedHierarchy(seed, 65, true))));
      await expect(runImportUtilityRequest({ id: `tiled-property-over-depth-${seed}`, kind: 'import-document', filePath, pixelMode: true })).rejects.toThrow('Tiled group nesting exceeds the 64-level safety limit.');
    }

    const boundaryLayers = generatedGlobalLayerBoundary(false); expect(countGeneratedLayers(boundaryLayers)).toBe(4_096);
    const boundaryPath = join(directory, 'property-global-boundary.tmj'); await writeFile(boundaryPath, JSON.stringify(generatedTiledMap(boundaryLayers)));
    const boundary = await runImportUtilityRequest({ id: 'tiled-property-global-boundary', kind: 'import-document', filePath: boundaryPath, pixelMode: true }); expect(boundary.warnings).toEqual([]);
    const document = boundary.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected boundary pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected boundary tilemap');
    expect(Object.keys(map.layers)).toHaveLength(4_096); expectCanonicalHierarchy(map, boundaryLayers);

    const overflowLayers = generatedGlobalLayerBoundary(true); expect(countGeneratedLayers(overflowLayers)).toBe(4_097);
    const overflowPath = join(directory, 'property-global-overflow.tmj'); await writeFile(overflowPath, JSON.stringify(generatedTiledMap(overflowLayers)));
    await expect(runImportUtilityRequest({ id: 'tiled-property-global-overflow', kind: 'import-document', filePath: overflowPath, pixelMode: true })).rejects.toThrow('Tiled map exceeds the 4,096-layer limit.');
  });

  it('holds inline TMX ordering, depth, GID, and global-layer properties across a deterministic generated family', async () => {
    const directory = await temporaryDirectory();
    for (const [seed, depth] of [[17, 0], [61, 5], [149, 31], [283, 64]] as const) {
      const sourceLayers = generatedHierarchy(seed, depth); const expectedLayers = canonicalInlineTmxOrder(sourceLayers);
      const filePath = join(directory, `xml-property-valid-${seed}-${depth}.tmx`); await writeFile(filePath, generatedInlineTmx(sourceLayers));
      const imported = await runImportUtilityRequest({ id: `xml-property-valid-${seed}-${depth}`, kind: 'import-document', filePath, pixelMode: true }); expect(imported.warnings).toEqual([]);
      const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected generated XML pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected generated XML tilemap');
      expect(Object.keys(map.layers)).toHaveLength(countGeneratedLayers(expectedLayers)); expectCanonicalHierarchy(map, expectedLayers);
    }

    for (const seed of [317, 613, 919]) {
      const sourceLayers = generatedInlineTmxOverDepth(seed); const filePath = join(directory, `xml-property-over-depth-${seed}.tmx`); await writeFile(filePath, generatedInlineTmx(sourceLayers));
      await expect(runImportUtilityRequest({ id: `xml-property-over-depth-${seed}`, kind: 'import-document', filePath, pixelMode: true })).rejects.toThrow('Tiled group nesting exceeds the 64-level safety limit.');
    }

    const boundaryLayers = generatedInlineTmxGlobalBoundary(false); expect(countGeneratedLayers(boundaryLayers)).toBe(4_096);
    const boundaryPath = join(directory, 'xml-property-global-boundary.tmx'); await writeFile(boundaryPath, generatedInlineTmx(boundaryLayers));
    const boundary = await runImportUtilityRequest({ id: 'xml-property-global-boundary', kind: 'import-document', filePath: boundaryPath, pixelMode: true }); expect(boundary.warnings).toEqual([]);
    const document = boundary.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected XML boundary pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected XML boundary tilemap');
    expect(Object.keys(map.layers)).toHaveLength(4_096); expectCanonicalHierarchy(map, canonicalInlineTmxOrder(boundaryLayers));

    const overflowLayers = generatedInlineTmxGlobalBoundary(true); expect(countGeneratedLayers(overflowLayers)).toBe(4_097);
    const overflowPath = join(directory, 'xml-property-global-overflow.tmx'); await writeFile(overflowPath, generatedInlineTmx(overflowLayers));
    await expect(runImportUtilityRequest({ id: 'xml-property-global-overflow', kind: 'import-document', filePath: overflowPath, pixelMode: true })).rejects.toThrow('Tiled map exceeds the 4,096-layer limit.');
  });

  it('rejects an oversized PSD canvas from its header before decoding layers', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'oversized.psd'); const header = Buffer.alloc(26); header.write('8BPS', 0, 'ascii'); header.writeUInt16BE(1, 4); header.writeUInt32BE(1, 14); header.writeUInt32BE(8_193, 18); await writeFile(filePath, header);
    await expect(importDocument(filePath)).rejects.toThrow(/8192px\/16MP import limit/); expect(psdBoundary.calls).toBe(0);
  });

  it('imports a tiny valid PSD through the utility decoder under AIDraw expanded-byte limits', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'minimal.psd'); await writeFile(filePath, minimalRgbPsd());
    const imported = await runImportUtilityRequest({ id: 'minimal-psd', kind: 'import-document', filePath, pixelMode: false }); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document');
    expect(document.artboard).toMatchObject({ width: 2, height: 2 }); expect(Object.values(document.objects)).toContainEqual(expect.objectContaining({ type: 'image', width: 2, height: 2, sourceWidth: 2, sourceHeight: 2 }));
    expect(psdBoundary).toMatchObject({ calls: 1, totalMemoryLimit: 320 * 1024 * 1024 });
  });

  it('rejects truncated and hostile top-level PSD section lengths before invoking the decoder', async () => {
    const directory = await temporaryDirectory(); const base = minimalRgbPsd();
    for (const [label, offset] of [['color-mode data', 26], ['image-resources', 30], ['layer-and-mask', 34]] as const) {
      const truncatedPath = join(directory, `${offset}-truncated.psd`); await writeFile(truncatedPath, base.subarray(0, offset + 2));
      await expect(runImportUtilityRequest({ id: `${offset}-truncated`, kind: 'import-document', filePath: truncatedPath, pixelMode: false })).rejects.toThrow(`PSD ${label} section length is truncated.`);
      const hostile = Buffer.from(base); hostile.writeUInt32BE(0xffff_fff0, offset); const hostilePath = join(directory, `${offset}-hostile.psd`); await writeFile(hostilePath, hostile);
      await expect(runImportUtilityRequest({ id: `${offset}-hostile`, kind: 'import-document', filePath: hostilePath, pixelMode: false })).rejects.toThrow(`PSD ${label} section exceeds the bounded file size.`);
    }
    expect(psdBoundary.calls).toBe(0);
  });

  it('lets the PSD decoder reject an inner layer-record length that extends one byte past EOF', async () => {
    const directory = await temporaryDirectory(); const corpus = await psdLayerRecordLengthCorpus();
    expect(corpus.validLength).toBe(48); expect(corpus.malformedLength).toBe(corpus.valid.byteLength - (corpus.extraDataLengthOffset + 4) + 1);
    expect(corpus.malformed.byteLength).toBe(corpus.valid.byteLength); expect([...corpus.malformed].filter((value, index) => value !== corpus.valid[index])).toHaveLength(1);
    await writeFile(join(directory, 'one-layer-valid.psd'), corpus.valid); await writeFile(join(directory, 'one-layer-invalid-extra-length.psd'), corpus.malformed);
    const valid = await runImportUtilityRequest({ id: 'psd-one-layer-valid', kind: 'import-document', filePath: join(directory, 'one-layer-valid.psd'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); const document = valid.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    expect(document.artboard).toMatchObject({ width: 2, height: 2 }); expect(Object.values(document.layers)).toContainEqual(expect.objectContaining({ name: 'Layer 1' }));
    let malformedResult: unknown; let malformedError: unknown;
    try { malformedResult = await runImportUtilityRequest({ id: 'psd-one-layer-invalid-extra-length', kind: 'import-document', filePath: join(directory, 'one-layer-invalid-extra-length.psd'), pixelMode: false }); } catch (error) { malformedError = error; }
    expect(malformedResult).toBeUndefined(); expect(malformedError).toMatchObject({ name: 'Error', message: 'Section exceeds file size' });
    expect(psdBoundary).toMatchObject({ calls: 2, totalMemoryLimit: 320 * 1024 * 1024 });
  });

  it('rejects an overdeclared PSD layer-channel payload before its bounded fallback allocation', async () => {
    const directory = await temporaryDirectory(); const corpus = await psdLayerChannelLengthCorpus();
    expect(corpus.validLength).toBe(12); expect(corpus.malformedLength - 2).toBe(100 * 1024 * 1024 + 1);
    expect(corpus.malformed.byteLength).toBe(corpus.valid.byteLength); expect([...corpus.malformed].filter((value, index) => value !== corpus.valid[index])).toHaveLength(3);
    await writeFile(join(directory, 'channel-valid.psd'), corpus.valid); await writeFile(join(directory, 'channel-overdeclared.psd'), corpus.malformed);
    const valid = await runImportUtilityRequest({ id: 'psd-channel-valid', kind: 'import-document', filePath: join(directory, 'channel-valid.psd'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); const document = valid.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    expect(document.artboard).toMatchObject({ width: 2, height: 2 }); expect(Object.values(document.layers)).toContainEqual(expect.objectContaining({ name: 'Layer 1' }));
    let malformedResult: unknown; let malformedError: unknown;
    try { malformedResult = await runImportUtilityRequest({ id: 'psd-channel-overdeclared', kind: 'import-document', filePath: join(directory, 'channel-overdeclared.psd'), pixelMode: false }); } catch (error) { malformedError = error; }
    expect(malformedResult).toBeUndefined(); expect(malformedError).toMatchObject({ name: 'Error', message: 'Reading past end of file' });
    expect(psdBoundary).toMatchObject({ calls: 2, totalMemoryLimit: 320 * 1024 * 1024 });
  });

  it('rejects after a short PSD layer-channel overrun is padded by one byte', async () => {
    const directory = await temporaryDirectory(); const corpus = await psdShortLayerChannelLengthCorpus();
    expect(corpus.validLength).toBe(12); expect(corpus.malformedLength).toBe(75); expect(corpus.malformedLength - 2).toBe(73);
    expect(corpus.channelDataStart + corpus.malformedLength).toBe(corpus.valid.byteLength + 1);
    expect(corpus.malformed.byteLength).toBe(corpus.valid.byteLength); expect([...corpus.malformed].filter((value, index) => value !== corpus.valid[index])).toHaveLength(1);
    await writeFile(join(directory, 'channel-short-valid.psd'), corpus.valid); await writeFile(join(directory, 'channel-short-overrun.psd'), corpus.malformed);
    const valid = await runImportUtilityRequest({ id: 'psd-channel-short-valid', kind: 'import-document', filePath: join(directory, 'channel-short-valid.psd'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); const document = valid.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    expect(document.artboard).toMatchObject({ width: 2, height: 2 }); expect(Object.values(document.layers)).toContainEqual(expect.objectContaining({ name: 'Layer 1' }));
    let malformedResult: unknown; let malformedError: unknown;
    try { malformedResult = await runImportUtilityRequest({ id: 'psd-channel-short-overrun', kind: 'import-document', filePath: join(directory, 'channel-short-overrun.psd'), pixelMode: false }); } catch (error) { malformedError = error; }
    expect(malformedResult).toBeUndefined(); expect(malformedError).toMatchObject({ name: 'RangeError', message: 'Offset is outside the bounds of the DataView' });
    expect(psdBoundary).toMatchObject({ calls: 2, totalMemoryLimit: 320 * 1024 * 1024 });
  });

  it('rejects after a one-byte PSD channel overlap reaches shifted ZIP decode', async () => {
    const directory = await temporaryDirectory(); const corpus = await psdOverlappingLayerChannelLengthCorpus();
    expect(corpus.validLength).toBe(12); expect(corpus.malformedLength).toBe(13); expect(corpus.channelLengthOffset).toBe(92); expect(corpus.channelDataStart).toBe(172);
    expect(corpus.channelDataStart + corpus.validLength).toBe(184); expect(corpus.channelDataStart + corpus.malformedLength).toBe(185);
    expect(corpus.valid[corpus.channelDataStart + corpus.validLength]).toBe(0);
    expect(corpus.malformed.byteLength).toBe(corpus.valid.byteLength); expect([...corpus.malformed].filter((value, index) => value !== corpus.valid[index])).toHaveLength(1);
    await writeFile(join(directory, 'channel-overlap-valid.psd'), corpus.valid); await writeFile(join(directory, 'channel-overlap.psd'), corpus.malformed);
    const valid = await runImportUtilityRequest({ id: 'psd-channel-overlap-valid', kind: 'import-document', filePath: join(directory, 'channel-overlap-valid.psd'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); const document = valid.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    expect(document.artboard).toMatchObject({ width: 2, height: 2 }); expect(Object.values(document.layers)).toContainEqual(expect.objectContaining({ name: 'Layer 1' }));
    let malformedResult: unknown; let malformedError: unknown;
    try { malformedResult = await runImportUtilityRequest({ id: 'psd-channel-overlap', kind: 'import-document', filePath: join(directory, 'channel-overlap.psd'), pixelMode: false }); } catch (error) { malformedError = error; }
    expect(malformedResult).toBeUndefined(); expect(malformedError).toBe('incorrect header check');
    expect(psdBoundary).toMatchObject({ calls: 2, totalMemoryLimit: 320 * 1024 * 1024 });
  });

  it('rejects decoder-reported PSD canvas and RGBA byte geometry disagreements', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'decoder-mismatch.psd'); await writeFile(filePath, minimalRgbPsd());
    psdBoundary.reportedWidthOffset = 1; await expect(runImportUtilityRequest({ id: 'psd-canvas-mismatch', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow('Decoded PSD canvas dimensions disagree with its file header.');
    psdBoundary.reportedWidthOffset = 0; psdBoundary.truncateCompositeBytes = true; await expect(runImportUtilityRequest({ id: 'psd-byte-mismatch', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow('Decoded PSD composite decoded byte length disagrees with its RGBA dimensions.');
    expect(psdBoundary.calls).toBe(2);
  });

  it('imports a locally generated PDF through the production utility and destroys its pdf.js loading task', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'minimal.pdf'); await writeFile(filePath, await minimalPdf());
    const imported = await runImportUtilityRequest({ id: 'minimal-pdf', kind: 'import-document', filePath, pixelMode: false }); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document');
    expect(document.artboard).toMatchObject({ width: 16, height: 12 }); expect(imported.warnings).toEqual([expect.stringContaining('faithful raster fallback')]);
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 1, getPageCalls: 1, renderCalls: 1, cleanupCalls: 1, destroyCalls: 1 });
  });

  it('accounts PDF editable text against existing canonical and transfer limits without allocating the transfer ceiling', () => {
    expect(accountPdfEditableText(0, '\u0000')).toBe(8);
    expect(accountPdfEditableText(MAX_IMPORT_UTILITY_SERIALIZED_BYTES - 3, 'x')).toBe(MAX_IMPORT_UTILITY_SERIALIZED_BYTES);
    expect(() => accountPdfEditableText(MAX_IMPORT_UTILITY_SERIALIZED_BYTES - 2, 'x')).toThrow('512 MiB imported-document transfer limit');
    expect(() => accountPdfEditableText(0, 'x'.repeat(MAX_ILLUSTRATION_TEXT_LENGTH + 1))).toThrow("canonical illustration limits");
  });

  it('admits only canonical PDF extracted text before direct import returns', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'canonical-text.pdf'); await writeFile(filePath, await minimalPdf());
    const item = (str: string, width = 100) => ({ str, width, height: 12, transform: [12, 0, 0, 12, 1, 11], fontName: 'sans-serif', dir: 'ltr' as const, hasEOL: false });
    pdfBoundary.textItems = [item('x'.repeat(MAX_ILLUSTRATION_TEXT_LENGTH))];
    const imported = await runImportUtilityRequest({ id: 'pdf-canonical-text-boundary', kind: 'import-document', filePath, pixelMode: false });
    const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    const extracted = Object.values(document.objects).find((object) => object.type === 'text');
    expect(extracted).toMatchObject({ type: 'text', text: 'x'.repeat(MAX_ILLUSTRATION_TEXT_LENGTH), width: 100, height: 12 });

    pdfBoundary.textItems = [item('x'.repeat(MAX_ILLUSTRATION_TEXT_LENGTH + 1))];
    await expect(runImportUtilityRequest({ id: 'pdf-overlong-text', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow("PDF extracted text exceeds AIDraw's canonical illustration limits.");
    pdfBoundary.textItems = [item('finite text', Number.POSITIVE_INFINITY)]; pdfBoundary.cleanupFailure = true;
    await expect(runImportUtilityRequest({ id: 'pdf-nonfinite-text-geometry', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow("PDF extracted text exceeds AIDraw's canonical illustration limits.");
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 3, getPageCalls: 3, renderCalls: 3, cleanupCalls: 3, destroyCalls: 3 });
  });

  it('releases a PDF page canvas after both successful encoding and render failure', async () => {
    let successfulCanvas: Canvas | undefined;
    const png = await renderPdfPagePng(4, 3, async (context) => { context.fillStyle = '#ff0000'; context.fillRect(0, 0, 4, 3); }, (width, height) => { const canvas = createCanvas(width, height); successfulCanvas = canvas; return canvas; });
    expect(png.subarray(1, 4).toString()).toBe('PNG'); expect(successfulCanvas).toMatchObject({ width: 1, height: 1 });

    let failedCanvas: Canvas | undefined; const renderError = new Error('Injected PDF page render failure.');
    await expect(renderPdfPagePng(4, 3, async () => { throw renderError; }, (width, height) => { const canvas = createCanvas(width, height); failedCanvas = canvas; return canvas; })).rejects.toBe(renderError);
    expect(failedCanvas).toMatchObject({ width: 1, height: 1 });
    await expect(renderPdfPagePng(0, 3, async () => undefined)).rejects.toThrow(/8192px\/16MP import limit/);
  });

  it('cleans each processed PDF page before rendering the next page', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'three-pages.pdf'); await writeFile(filePath, await minimalPdf(3));
    const imported = await runImportUtilityRequest({ id: 'three-page-pdf', kind: 'import-document', filePath, pixelMode: false });
    expect(imported.documents).toHaveLength(3);
    expect(pdfBoundary).toMatchObject({ getPageCalls: 3, renderCalls: 3, cleanupCalls: 3, destroyCalls: 1 });
    expect(pdfBoundary.events.filter((event) => /^(?:render|cleanup|destroy)/.test(event))).toEqual([
      'render:1', 'cleanup:1', 'render:2', 'cleanup:2', 'render:3', 'cleanup:3', 'destroy',
    ]);
  });

  it('rejects locally generated truncated and hostile PDF containers through pdf.js and still destroys each loading task', async () => {
    const directory = await temporaryDirectory(); const valid = await minimalPdf(); const fixtures = [valid.subarray(0, 8), Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 4294967295 >>\nstream\ntruncated')];
    for (const [index, bytes] of fixtures.entries()) {
      const filePath = join(directory, `malformed-${index + 1}.pdf`); await writeFile(filePath, bytes);
      await expect(runImportUtilityRequest({ id: `malformed-pdf-${index + 1}`, kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow();
    }
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 2, getPageCalls: 0, renderCalls: 0, destroyCalls: 2 });
  });

  it('rejects a deterministic malformed PDF object/stream corpus and preserves primary errors across cleanup failure', async () => {
    const directory = await temporaryDirectory(); const corpus = await malformedPdfObjectStreamCorpus(); const paths: string[] = [];
    for (const fixture of corpus) {
      const filePath = join(directory, `${fixture.name}.pdf`); paths.push(filePath); await writeFile(filePath, fixture.bytes);
      let caught: unknown; try { await runImportUtilityRequest({ id: `malformed-pdf-${fixture.name}`, kind: 'import-document', filePath, pixelMode: false }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error); expect(caught).toMatchObject({ name: fixture.errorName, message: fixture.errorMessage });
    }
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 3, getPageCalls: 2, renderCalls: 1, destroyCalls: 3 });

    pdfBoundary.destroyFailure = true; let precedenceError: unknown;
    try { await runImportUtilityRequest({ id: 'malformed-pdf-cleanup-precedence', kind: 'import-document', filePath: paths[0], pixelMode: false }); } catch (error) { precedenceError = error; }
    expect(precedenceError).toBeInstanceOf(Error); expect(precedenceError).toMatchObject({ name: corpus[0].errorName, message: corpus[0].errorMessage });
    expect((precedenceError as Error).message).not.toContain('destroy failure'); expect(pdfBoundary).toMatchObject({ destroyCalls: 4 });
  });

  it('imports a real Flate object stream and rejects one-byte filter/header corruptions during pdf.js load', async () => {
    const directory = await temporaryDirectory(); const corpus = await malformedPdfObjectStreamFilterCorpus(); const validPath = join(directory, 'object-stream-valid.pdf'); await writeFile(validPath, corpus.valid);
    const imported = await runImportUtilityRequest({ id: 'pdf-object-stream-valid', kind: 'import-document', filePath: validPath, pixelMode: false }); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document');
    expect(document.artboard).toMatchObject({ width: 16, height: 12 }); expect(corpus.valid.toString('latin1')).toContain('/Type /ObjStm');
    for (const fixture of corpus.fixtures) {
      expect(fixture.bytes.byteLength).toBe(corpus.valid.byteLength); expect([...fixture.bytes].filter((value, index) => value !== corpus.valid[index])).toHaveLength(1);
      const filePath = join(directory, `${fixture.name}.pdf`); await writeFile(filePath, fixture.bytes); let caught: unknown;
      try { await runImportUtilityRequest({ id: `pdf-${fixture.name}`, kind: 'import-document', filePath, pixelMode: false }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error); expect(caught).toMatchObject({ name: fixture.errorName, message: fixture.errorMessage });
    }
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 3, getPageCalls: 1, renderCalls: 1, destroyCalls: 3 });
  });

  it('rejects an invalid Flate predictor at render while preserving pdf.js zero-column recovery', async () => {
    const directory = await temporaryDirectory(); const corpus = await pdfFlatePredictorCorpus();
    for (const [name, bytes] of [['valid', corpus.valid], ['invalid-predictor', corpus.invalidPredictor], ['zero-columns', corpus.recoveredZeroColumns]] as const) {
      expect(bytes.byteLength).toBe(corpus.valid.byteLength); if (name !== 'valid') expect([...bytes].filter((value, index) => value !== corpus.valid[index])).toHaveLength(1);
      await writeFile(join(directory, `${name}.pdf`), bytes);
    }
    const valid = await runImportUtilityRequest({ id: 'pdf-predictor-valid', kind: 'import-document', filePath: join(directory, 'valid.pdf'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); expect(corpus.valid.toString('latin1')).toContain('/DecodeParms <<\n/Predictor 15\n/Colors 3\n/BitsPerComponent 8\n/Columns 3');
    let rejectedResult: unknown; let renderError: unknown;
    try { rejectedResult = await runImportUtilityRequest({ id: 'pdf-predictor-invalid', kind: 'import-document', filePath: join(directory, 'invalid-predictor.pdf'), pixelMode: false }); } catch (error) { renderError = error; }
    expect(rejectedResult).toBeUndefined(); expect(renderError).toMatchObject({ name: 'RangeError', message: 'Invalid typed array length: 4' });
    const recovered = await runImportUtilityRequest({ id: 'pdf-predictor-zero-columns', kind: 'import-document', filePath: join(directory, 'zero-columns.pdf'), pixelMode: false });
    expect(recovered.documents).toHaveLength(1); expect(recovered.documents[0]).toMatchObject({ kind: 'illustration', artboard: { width: 16, height: 12 } });
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 3, getPageCalls: 3, renderCalls: 3, destroyCalls: 3 });
  });

  it('distinguishes reversed multi-filter recovery from encoded-stream truncation at render', async () => {
    const directory = await temporaryDirectory(); const corpus = await pdfMultiFilterChainCorpus();
    for (const [name, bytes] of [['valid', corpus.valid], ['reversed-order', corpus.reversedOrder], ['truncated-stream', corpus.truncatedEncodedStream]] as const) {
      expect(bytes.byteLength).toBe(corpus.valid.byteLength); await writeFile(join(directory, `${name}.pdf`), bytes);
    }
    expect([...corpus.truncatedEncodedStream].filter((value, index) => value !== corpus.valid[index])).toHaveLength(2);
    const valid = await runImportUtilityRequest({ id: 'pdf-multi-filter-valid', kind: 'import-document', filePath: join(directory, 'valid.pdf'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); expect(corpus.valid.toString('latin1')).toContain('/Filter [ /ASCIIHexDecode /FlateDecode ]');
    const recovered = await runImportUtilityRequest({ id: 'pdf-multi-filter-reversed', kind: 'import-document', filePath: join(directory, 'reversed-order.pdf'), pixelMode: false });
    expect(recovered.documents).toHaveLength(1); expect(recovered.documents[0]).toMatchObject({ kind: 'illustration', artboard: { width: 16, height: 12 } });
    pdfBoundary.cleanupFailure = true;
    let truncatedResult: unknown; let truncationError: unknown;
    try { truncatedResult = await runImportUtilityRequest({ id: 'pdf-multi-filter-truncated', kind: 'import-document', filePath: join(directory, 'truncated-stream.pdf'), pixelMode: false }); } catch (error) { truncationError = error; }
    expect(truncatedResult).toBeUndefined(); expect(truncationError).toMatchObject({ name: 'RangeError', message: 'Invalid typed array length: 4' });
    expect((truncationError as Error).message).not.toContain('cleanup failure');
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 3, getPageCalls: 3, renderCalls: 3, cleanupCalls: 3, destroyCalls: 3 });
  });

  it('rejects a premature ASCII85 end marker in an ASCII85/Flate image chain at render', async () => {
    const directory = await temporaryDirectory(); const corpus = await pdfAscii85FlateEodCorpus();
    expect(corpus.prematureEod.byteLength).toBe(corpus.valid.byteLength);
    expect([...corpus.prematureEod].filter((value, index) => value !== corpus.valid[index])).toHaveLength(4);
    await writeFile(join(directory, 'ascii85-valid.pdf'), corpus.valid); await writeFile(join(directory, 'ascii85-premature-eod.pdf'), corpus.prematureEod);
    const valid = await runImportUtilityRequest({ id: 'pdf-ascii85-valid', kind: 'import-document', filePath: join(directory, 'ascii85-valid.pdf'), pixelMode: false });
    expect(valid.documents).toHaveLength(1); expect(valid.documents[0]).toMatchObject({ kind: 'illustration', artboard: { width: 16, height: 12 } });
    let malformedResult: unknown; let malformedError: unknown;
    try { malformedResult = await runImportUtilityRequest({ id: 'pdf-ascii85-premature-eod', kind: 'import-document', filePath: join(directory, 'ascii85-premature-eod.pdf'), pixelMode: false }); } catch (error) { malformedError = error; }
    expect(malformedResult).toBeUndefined(); expect(malformedError).toMatchObject({ name: 'RangeError', message: 'Invalid typed array length: 4' });
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 2, getPageCalls: 2, renderCalls: 2, destroyCalls: 2 });
  });

  it('still fails closed when only PDF loading-task destruction fails', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'cleanup-failure.pdf'); await writeFile(filePath, await minimalPdf()); pdfBoundary.destroyFailure = true;
    await expect(runImportUtilityRequest({ id: 'pdf-cleanup-only-failure', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow('Injected PDF loading-task destroy failure.');
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 1, getPageCalls: 1, renderCalls: 1, cleanupCalls: 1, destroyCalls: 1 });
  });

  it('fails closed on page cleanup alone and still destroys the loading task', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'page-cleanup-failure.pdf'); await writeFile(filePath, await minimalPdf()); pdfBoundary.cleanupFailure = true;
    await expect(runImportUtilityRequest({ id: 'pdf-page-cleanup-only-failure', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow('Injected PDF page cleanup failure.');
    expect(pdfBoundary).toMatchObject({ getDocumentCalls: 1, getPageCalls: 1, renderCalls: 1, cleanupCalls: 1, destroyCalls: 1 });
  });

  it('enforces PDF page, per-page, and cumulative expansion limits before rendering', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'bounded.pdf'); await writeFile(filePath, await minimalPdf());
    for (const [mode, message, getPageCalls] of [
      ['page-count', /256-page import limit/, 0],
      ['page-dimension', /8192px\/16MP import limit/, 1],
      ['expanded', /64-megapixel expanded import budget/, 5],
    ] as const) {
      pdfBoundary.mode = mode;
      await expect(runImportUtilityRequest({ id: `pdf-${mode}`, kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow(message);
      expect(pdfBoundary).toMatchObject({ getPageCalls, renderCalls: 0, cleanupCalls: getPageCalls, destroyCalls: 1 });
      pdfBoundary.getPageCalls = 0; pdfBoundary.cleanupCalls = 0; pdfBoundary.destroyCalls = 0;
    }
  });

  it('imports a bounded Adam7 PNG through the production utility path with matching header and decoded dimensions', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'adam7.png'); const bytes = adam7Png(); await writeFile(filePath, bytes);
    expect(inspectImageHeader(bytes)).toEqual({ mimeType: 'image/png', width: 8, height: 8 });
    const imported = await runImportUtilityRequest({ id: 'adam7-import', kind: 'import-document', filePath, pixelMode: false });
    expect(imported.warnings).toEqual([]); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration document');
    const image = Object.values(document.objects)[0]; expect(document.artboard).toMatchObject({ width: 8, height: 8 }); expect(image).toMatchObject({ type: 'image', width: 8, height: 8, sourceWidth: 8, sourceHeight: 8 });
    expect(Object.values(document.assets)[0].data).toBe(bytes.toString('base64')); expect(decoderBoundary.calls).toBe(1);
  });

  it('rejects an Adam7 PNG when the utility decoder reports dimensions that differ from its header', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'adam7-mismatched.png'); const bytes = adam7Png(); await writeFile(filePath, bytes);
    expect(inspectImageHeader(bytes)).toMatchObject({ width: 8, height: 8 }); decoderBoundary.reportedWidthOffset = 1;
    await expect(runImportUtilityRequest({ id: 'adam7-mismatch', kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow('Decoded image dimensions disagree with its file header.');
    expect(decoderBoundary.calls).toBe(1);
  });

  it('applies dimension and total-pixel limits to interlaced PNG headers before malformed pass data can reach decoding', async () => {
    const directory = await temporaryDirectory(); const base = adam7Png();
    for (const [name, width, height] of [['dimension', 8_193, 1], ['pixels', 4_097, 4_097]] as const) {
      const filePath = join(directory, `adam7-over-${name}.png`); const bytes = withPngHeaderDimensions(base, width, height); await writeFile(filePath, bytes);
      expect(inspectImageHeader(bytes)).toMatchObject({ mimeType: 'image/png', width, height });
      await expect(runImportUtilityRequest({ id: `adam7-over-${name}`, kind: 'import-document', filePath, pixelMode: false })).rejects.toThrow(/8192px\/16MP import limit/);
    }
    expect(decoderBoundary.calls).toBe(0);
  });

  it('applies the sprite-sheet expanded-output budget before decoding an Adam7 companion', async () => {
    const directory = await temporaryDirectory(); const imagePath = join(directory, 'adam7.png'); const metadataPath = join(directory, 'adam7.json'); const bytes = adam7Png();
    await writeFile(imagePath, bytes); await writeFile(metadataPath, JSON.stringify({ frames: Array.from({ length: 5 }, (_, index) => ({ filename: `frame-${index + 1}`, frame: { x: 0, y: 0, w: 4_096, h: 4_096 } })), meta: { image: 'adam7.png' } }));
    expect(inspectImageHeader(bytes)).toMatchObject({ mimeType: 'image/png', width: 8, height: 8 });
    await expect(runImportUtilityRequest({ id: 'adam7-expanded-sheet', kind: 'import-document', filePath: metadataPath, pixelMode: true })).rejects.toThrow('Sprite-sheet frames exceed the 64-megapixel expanded import budget.');
    expect(decoderBoundary.calls).toBe(0);
  });
});

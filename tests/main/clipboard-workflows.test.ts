import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createIllustrationDocument,
  createPixelDocument,
  nowIso,
  type AIDrawDocument,
  type ShapeObject,
} from '@aidraw/core';
import { exportIllustrationFragment, MAX_FRAGMENT_BYTES, type PixelSelectionFragment } from '@common/document-fragment';
import {
  AIDRAW_CLIPBOARD_HTML_VERSION,
  MAX_CLIPBOARD_FRAGMENT_BASE64_CHARACTERS,
  MAX_CLIPBOARD_HTML_BYTES,
  assertClipboardImageGeometry,
  clipboardPngAsset,
  copyPixelSelectionToClipboard,
  copySelectionToClipboard,
  parseAIDrawClipboardHtml,
  pasteFromClipboard,
  readPixelSelectionFromClipboard,
  serializeAIDrawClipboardHtml,
  type ClipboardPng,
  type ClipboardWorkflowDependencies,
  type ClipboardWriteData,
} from '@main/clipboard-workflows';
import { MAX_INLINE_ASSET_BYTES } from '@main/transaction-policy';
import { describe, expect, it, vi } from 'vitest';

function illustrationFixture(): { document: ReturnType<typeof createIllustrationDocument>; shape: ShapeObject } {
  const document = createIllustrationDocument('Clipboard illustration');
  document.artboard = { ...document.artboard, width: 32, height: 24, background: null };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
  const timestamp = nowIso();
  const shape: ShapeObject = {
    id: 'clipboard-shape', revision: 0, name: 'Clipboard rectangle', createdAt: timestamp, updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x: 3, y: 4 }, type: 'shape', shape: 'rectangle', width: 8, height: 6,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  document.objects[shape.id] = shape;
  layer.objectIds.push(shape.id);
  return { document, shape };
}

function tinyPng(width = 2, height = 1): ClipboardPng {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff6b7a';
  context.fillRect(0, 0, width, height);
  return { bytes: canvas.toBuffer('image/png'), width, height };
}

function pixelSelectionFragment(): PixelSelectionFragment {
  return {
    version: 1,
    kind: 'pixel-selection',
    sourceDocumentId: 'clipboard-pixel-source',
    palette: ['#00000000', '#ff6b7a'],
    grid: { version: 1, originX: 2, originY: 3, width: 1, height: 1, cells: [{ x: 0, y: 0, value: 1 }] },
  };
}

function workflowDependencies(
  document: AIDrawDocument,
  options: {
    html?: string;
    png?: ClipboardPng;
    readPng?: () => ClipboardPng | undefined;
    write?: (data: ClipboardWriteData) => void;
    renderPng?: (source: AIDrawDocument) => Promise<Buffer>;
    quantizePng?: ClipboardWorkflowDependencies['raster']['quantizePng'];
    apply?: ClipboardWorkflowDependencies['apply'];
  } = {},
): ClipboardWorkflowDependencies {
  return {
    getActiveDocument: () => document,
    apply: options.apply ?? (async () => ({ status: 'committed' })),
    clipboard: {
      write: options.write ?? (() => undefined),
      readHtml: () => options.html ?? '',
      readPng: options.readPng ?? (() => options.png),
    },
    raster: {
      renderPng: options.renderPng ?? (async () => tinyPng().bytes),
      quantizePng: options.quantizePng ?? (async () => []),
    },
  };
}

describe('clipboard workflows', () => {
  it('round-trips the versioned, checksummed private HTML envelope and rejects tampering', () => {
    const { document, shape } = illustrationFixture();
    const fragment = exportIllustrationFragment(document, [shape.id]);
    const html = serializeAIDrawClipboardHtml(fragment, '<svg aria-label="Clipboard preview"></svg>');
    const json = Buffer.from(JSON.stringify(fragment));
    const digest = createHash('sha256').update(json).digest('hex');

    expect(html).toContain(`data-aidraw-version="${AIDRAW_CLIPBOARD_HTML_VERSION}"`);
    expect(html).toContain(`data-aidraw-sha256="${digest}"`);
    expect(parseAIDrawClipboardHtml(html)).toEqual({ status: 'valid', fragment });

    const tampered = html.replace(/data-aidraw="([A-Za-z0-9+/])/u, (_match, first: string) => `data-aidraw="${first === 'A' ? 'B' : 'A'}`);
    expect(parseAIDrawClipboardHtml(tampered)).toEqual({
      status: 'invalid',
      message: 'AIDraw clipboard data is invalid: fragment SHA-256 does not match.',
    });
  });

  it('publishes and reads exact indexed selections without manufacturing a PNG fallback', () => {
    const fragment = pixelSelectionFragment();
    const write = vi.fn<(data: ClipboardWriteData) => void>();
    expect(copyPixelSelectionToClipboard({ write, readHtml: () => '', readPng: () => undefined }, fragment)).toEqual({ copied: true });
    expect(write).toHaveBeenCalledOnce();
    const written = write.mock.calls[0][0];
    expect(written.png).toBeUndefined();
    expect(JSON.parse(written.text)).toEqual(fragment);
    expect(readPixelSelectionFromClipboard({ write: () => undefined, readHtml: () => written.html, readPng: () => undefined })).toEqual({ status: 'valid', fragment });
    expect(readPixelSelectionFromClipboard({ write: () => undefined, readHtml: () => '<p>ordinary HTML</p>', readPng: () => undefined })).toMatchObject({ status: 'absent' });

    const illustration = illustrationFixture();
    const incompatible = serializeAIDrawClipboardHtml(exportIllustrationFragment(illustration.document, [illustration.shape.id]), '<svg></svg>');
    expect(readPixelSelectionFromClipboard({ write: () => undefined, readHtml: () => incompatible, readPng: () => undefined })).toMatchObject({ status: 'incompatible', message: expect.stringContaining('whole artwork') });
    expect(readPixelSelectionFromClipboard({ write: () => undefined, readHtml: () => '<div data-aidraw="abcd===="></div>', readPng: () => undefined })).toMatchObject({ status: 'invalid' });
  });

  it('accepts the exact legacy private attribute while failing malformed or amplified envelopes closed', () => {
    const { document, shape } = illustrationFixture();
    const fragment = exportIllustrationFragment(document, [shape.id]);
    const encoded = Buffer.from(JSON.stringify(fragment)).toString('base64');
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${encoded}">legacy</div>`)).toEqual({ status: 'valid', fragment });
    expect(parseAIDrawClipboardHtml('<p>ordinary clipboard HTML</p>')).toEqual({ status: 'absent' });
    expect(parseAIDrawClipboardHtml(`<div x-data-aidraw="${encoded}"></div>`)).toEqual({ status: 'absent' });
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${encoded}" data-aidraw="${encoded}"></div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('duplicate') });
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${encoded}" data-aidraw=${encoded}></div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('duplicate') });
    expect(parseAIDrawClipboardHtml('<div data-aidraw="abcd===="></div>')).toMatchObject({ status: 'invalid', message: expect.stringContaining('canonical base64') });
    expect(parseAIDrawClipboardHtml(`<div data-aidraw-version="1" data-aidraw="${encoded}"></div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('SHA-256') });
    expect(parseAIDrawClipboardHtml(serializeAIDrawClipboardHtml(fragment, '<svg></svg>').replace('data-aidraw-version="1"', 'data-aidraw-version="2"'))).toMatchObject({ status: 'invalid', message: expect.stringContaining('version') });
    const invalidUtf8 = Buffer.from(JSON.stringify(fragment));
    invalidUtf8[invalidUtf8.indexOf('Clipboard')] = 0xff;
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${invalidUtf8.toString('base64')}"></div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('JSON or canonical content') });
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${'A'.repeat(MAX_CLIPBOARD_FRAGMENT_BASE64_CHARACTERS + 4)}"></div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('2 MiB') });
    expect(parseAIDrawClipboardHtml(`<div data-aidraw="${encoded}">${'x'.repeat(MAX_CLIPBOARD_HTML_BYTES)}</div>`)).toMatchObject({ status: 'invalid', message: expect.stringContaining('16 MiB') });
    const boundedSerialization = serializeAIDrawClipboardHtml(fragment, 'x'.repeat(MAX_CLIPBOARD_HTML_BYTES));
    expect(Buffer.byteLength(boundedSerialization)).toBeLessThan(MAX_CLIPBOARD_HTML_BYTES);
    expect(boundedSerialization).toContain('<span>AIDraw artwork</span>');
    expect(parseAIDrawClipboardHtml(boundedSerialization)).toEqual({ status: 'valid', fragment });
    expect(MAX_CLIPBOARD_FRAGMENT_BASE64_CHARACTERS).toBe(Math.ceil(MAX_FRAGMENT_BYTES / 3) * 4);
  });

  it('does not reinterpret a corrupt private fragment as a bitmap paste', async () => {
    const readPng = vi.fn(() => tinyPng());
    const apply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const response = await pasteFromClipboard(workflowDependencies(createIllustrationDocument(), {
      html: '<div data-aidraw="abcd===="></div>',
      readPng,
      apply,
    }));
    expect(response).toMatchObject({ status: 'conflict', message: expect.stringContaining('canonical base64') });
    expect(readPng).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not reinterpret an indexed-selection fragment as whole artwork or a bitmap paste', async () => {
    const readPng = vi.fn(() => tinyPng());
    const apply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const response = await pasteFromClipboard(workflowDependencies(createPixelDocument('sprite'), {
      html: serializeAIDrawClipboardHtml(pixelSelectionFragment(), '<span>selection</span>'),
      readPng,
      apply,
    }));
    expect(response).toMatchObject({ status: 'conflict', message: expect.stringContaining('sprite selection controls') });
    expect(readPng).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('admits only canonical bounded PNG bytes whose decoded and native geometry agree', () => {
    const png = tinyPng(2, 1);
    const asset = clipboardPngAsset(png);
    expect(asset).toMatchObject({
      name: 'Clipboard image', mimeType: 'image/png', byteLength: png.bytes.byteLength,
      sha256: createHash('sha256').update(png.bytes).digest('hex'), source: 'imported', data: png.bytes.toString('base64'),
    });
    expect(() => clipboardPngAsset({ ...png, width: 1 })).toThrow(/decoded geometry/);
    expect(() => assertClipboardImageGeometry(8_193, 1)).toThrow(/8192px/);
    expect(() => assertClipboardImageGeometry(4_097, 4_096)).toThrow(/16,777,216 pixels/);
    expect(() => clipboardPngAsset({ bytes: Buffer.alloc(MAX_INLINE_ASSET_BYTES + 1), width: 1, height: 1 })).toThrow(/editable-asset limit/);
  });

  it('renders copy output through the injected raster lane and writes private plus standard fallbacks', async () => {
    const { document, shape } = illustrationFixture();
    const png = tinyPng();
    const write = vi.fn<(data: ClipboardWriteData) => void>();
    const renderPng = vi.fn<ClipboardWorkflowDependencies['raster']['renderPng']>(async () => png.bytes);
    const quantizePng = vi.fn<ClipboardWorkflowDependencies['raster']['quantizePng']>(async () => []);
    const result = await copySelectionToClipboard(workflowDependencies(document, { write, renderPng, quantizePng }), [shape.id]);

    expect(result).toEqual({ copied: true, kind: 'illustration-objects' });
    expect(renderPng).toHaveBeenCalledOnce();
    const rendered = renderPng.mock.calls[0][0];
    expect(rendered).not.toBe(document);
    expect(Object.keys(rendered.kind === 'illustration' ? rendered.objects : {})).toEqual([shape.id]);
    expect(write).toHaveBeenCalledOnce();
    const written = write.mock.calls[0][0];
    expect(written.png).toEqual(png.bytes);
    expect(written.text).toContain('<svg');
    expect(parseAIDrawClipboardHtml(written.html)).toMatchObject({ status: 'valid', fragment: { kind: 'illustration-objects' } });
    expect(quantizePng).not.toHaveBeenCalled();
  });

  it('imports a valid private fragment without consulting the bitmap fallback', async () => {
    const source = illustrationFixture();
    const fragment = exportIllustrationFragment(source.document, [source.shape.id]);
    const target = createIllustrationDocument('Clipboard target');
    const readPng = vi.fn(() => tinyPng());
    const quantizePng = vi.fn<ClipboardWorkflowDependencies['raster']['quantizePng']>(async () => []);
    const apply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const response = await pasteFromClipboard(workflowDependencies(target, {
      html: serializeAIDrawClipboardHtml(fragment, '<svg></svg>'), readPng, quantizePng, apply,
    }));

    expect(response.status).toBe('committed');
    expect(readPng).not.toHaveBeenCalled();
    expect(quantizePng).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0][0].operations).toHaveLength(1);
    expect(apply.mock.calls[0][0].operations[0].kind).toBe('illustration.object.add');
  });

  it('pastes illustration PNGs as assets but routes pixel PNG conversion through the injected raster lane', async () => {
    const png = tinyPng(2, 1);
    const illustration = createIllustrationDocument('Bitmap illustration target');
    const illustrationApply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const illustrationQuantize = vi.fn<ClipboardWorkflowDependencies['raster']['quantizePng']>(async () => []);
    expect((await pasteFromClipboard(workflowDependencies(illustration, { png, apply: illustrationApply, quantizePng: illustrationQuantize }))).status).toBe('committed');
    expect(illustrationApply.mock.calls[0][0].operations.map((operation) => operation.kind)).toEqual(['asset.add', 'illustration.object.add']);
    expect(illustrationQuantize).not.toHaveBeenCalled();

    const pixel = createPixelDocument('sprite', 'Bitmap pixel target');
    const sprite = pixel.pixelAssets[pixel.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 2;
    sprite.height = 1;
    const changes = [{ x: 1, y: 0, index: 4 }];
    const pixelApply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const pixelQuantize = vi.fn<ClipboardWorkflowDependencies['raster']['quantizePng']>(async () => changes);
    expect((await pasteFromClipboard(workflowDependencies(pixel, { png, apply: pixelApply, quantizePng: pixelQuantize }))).status).toBe('committed');
    expect(pixelQuantize).toHaveBeenCalledWith(png.bytes, 2, 1, pixel.palette, {
      alphaThreshold: pixel.conversionDefaults.alphaThreshold,
      dithering: pixel.conversionDefaults.dithering,
    });
    expect(pixelApply.mock.calls[0][0].operations).toEqual([
      expect.objectContaining({ kind: 'pixel.cel.set', changes }),
    ]);
  });

  it('returns native clipboard-read failures as bounded conflicts before transaction construction', async () => {
    const apply = vi.fn<ClipboardWorkflowDependencies['apply']>(async () => ({ status: 'committed' }));
    const response = await pasteFromClipboard(workflowDependencies(createIllustrationDocument(), {
      readPng: () => { throw new Error('Clipboard image dimensions must fit the safety limit.'); },
      apply,
    }));
    expect(response).toEqual({ status: 'conflict', message: 'Clipboard image dimensions must fit the safety limit.' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('wires production copy rendering and pixel quantization through the supervised raster utilities', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    expect(source).toContain("rasterUtilities.exportDocument(document, 'png')");
    expect(source).toContain('rasterUtilities.quantizeImage(bytes, width, height, palette, settings)');
    expect(source).toContain('assertClipboardImageGeometry(size.width, size.height)');
    expect(source).toContain('if (!data.png) { clipboard.write({ text: data.text, html: data.html }); return; }');
    expect(source).toContain('handle(IPC.writePixelSelectionClipboard');
    expect(source).toContain('handle(IPC.readPixelSelectionClipboard');
    expect(source).not.toContain('quantizeToPalette');
  });
});

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { importDocument } from '@main/import-document';
import { illustrationToSvg } from '@main/export-document';
import { importEditableSvg } from '@main/svg-import';
import { renderIllustration } from '@main/render-document';
import { createIllustrationDocument, HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type DocumentAsset, type ImageObject, type TextObject } from '@aidraw/core';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'svg', 'structured-editor.svg');

describe('editable SVG interchange', () => {
  it('imports external-style groups, transforms, styles, gradients, use, masks, filters, text ranges, and embedded images', async () => {
    const imported = await importDocument(fixture);
    expect(imported.documents).toHaveLength(1);
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(document.artboard).toMatchObject({ width: 160, height: 120, background: null });
    const byName = (name: string) => Object.values(document.objects).find((object) => object.name === name);
    const locomotive = byName('locomotive'); expect(locomotive).toMatchObject({ type: 'group', opacity: 0.9, transform: { x: 20, y: 30 } }); expect(locomotive?.transform.rotation).toBeCloseTo(5);
    const body = byName('gold-body');
    expect(body?.type === 'shape' ? body.fill : undefined).toMatchObject({ kind: 'linear-gradient', stops: [{ color: '#6f3d08' }, { color: '#fff0a0', opacity: 0.8 }, { color: '#9b5f10' }] });
    expect(body?.type === 'shape' ? body.stroke : undefined).toMatchObject({ width: 2, lineJoin: 'round', paint: { kind: 'solid', color: '#3a2418' } });
    const label = byName('label');
    expect(label?.type === 'text' ? label.text : undefined).toBe('Gold Express');
    expect(label?.type === 'text' ? label.ranges.map((range) => ({ text: label.text.slice(range.start, range.end), color: range.color, fontStyle: range.fontStyle })) : undefined).toEqual([
      { text: 'Gold ', color: '#20150f', fontStyle: 'normal' },
      { text: 'Express', color: '#b02040', fontStyle: 'italic' },
    ]);
    const lamp = byName('lamp'); expect(lamp?.type).toBe('image'); expect(lamp?.type === 'image' ? document.assets[lamp.assetId]?.mimeType : undefined).toBe('image/png');
    const glow = byName('window-glow'); expect(glow).toMatchObject({ type: 'path', blur: 1.5 }); expect(glow?.maskObjectId).toBeTruthy(); expect(glow?.maskObjectId ? document.objects[glow.maskObjectId]?.visible : undefined).toBe(false);
    expect(byName('badge-use')?.type).toBe('group');
    expect(byName('ViewBox')).toMatchObject({ type: 'group', transform: { x: -10, y: -20 } });
    expect(imported.warnings).toContainEqual(expect.stringMatching(/foreignObject/));
  });

  it('round-trips the supported editable structure through AIDraw SVG export', async () => {
    const imported = await importDocument(fixture); const document = imported.documents[0]; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const svg = illustrationToSvg(document);
    expect(svg).toContain('<linearGradient'); expect(svg).toContain('<g transform='); expect(svg).toContain('<tspan'); expect(svg).toContain('data:image/png;base64'); expect(svg).toContain('clip-path="url(#clip-');
    const reopened = importEditableSvg(svg, 'Round trip').document;
    expect(Object.values(reopened.objects).some((object) => object.type === 'group')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'shape' && object.fill.kind === 'linear-gradient')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'text' && object.ranges.length >= 2)).toBe(true);
    expect(Object.values(reopened.objects).some((object) => object.type === 'image')).toBe(true);
    expect(Object.values(reopened.objects).some((object) => Boolean(object.maskObjectId))).toBe(true);
  });

  it('preserves centered and right-aligned AIDraw text boxes without shifting their transforms', () => {
    const document = createIllustrationDocument('SVG text boxes'); document.artboard = { ...document.artboard, width: 320, height: 180, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const text = (id: string, align: 'center' | 'right', x: number, y: number, width: number, height: number, lineHeight: number): TextObject => ({
      id, revision: 0, name: `${align} label`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id,
      visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'text', text: align === 'center' ? 'Centered' : 'Right', width, height, align, lineHeight,
      ranges: [{ start: 0, end: align === 'center' ? 8 : 5, fontFamily: 'Arial', fontSize: 20, fontWeight: 400, fontStyle: 'normal', color: '#224466', letterSpacing: 0 }],
    });
    const centered = text('centered-text', 'center', 30, 24, 180, 48, 1.4); const right = text('right-text', 'right', 45, 96, 120, 36, 1.1);
    document.objects[centered.id] = centered; document.objects[right.id] = right; vector.objectIds.push(centered.id, right.id);

    const svg = illustrationToSvg(document);
    expect(svg).toContain('x="90" y="20" text-anchor="middle" data-aidraw-text-box="1" data-aidraw-text-width="180" data-aidraw-text-height="48" data-aidraw-line-height="1.4"');
    expect(svg).toContain('x="120" y="20" text-anchor="end" data-aidraw-text-box="1" data-aidraw-text-width="120" data-aidraw-text-height="36" data-aidraw-line-height="1.1"');
    const reopened = importEditableSvg(svg, 'Reopened text boxes').document;
    const reopenedByText = (text: string) => Object.values(reopened.objects).find((object): object is TextObject => object.type === 'text' && object.text === text);
    expect(reopenedByText(centered.text)).toMatchObject({ width: 180, height: 48, align: 'center', lineHeight: 1.4, transform: { x: 30, y: 24 } });
    expect(reopenedByText(right.text)).toMatchObject({ width: 120, height: 36, align: 'right', lineHeight: 1.1, transform: { x: 45, y: 96 } });

    for (const [from, to] of [
      ['data-aidraw-line-height="1.4"', 'data-aidraw-line-height="99"'],
      ['data-aidraw-text-box="1"', 'data-aidraw-text-box="2"'],
      ['data-aidraw-text-width="180"', 'data-aidraw-text-width="true"'],
    ]) {
      const invalid = importEditableSvg(svg.replace(from, to), 'Invalid text metadata');
      expect(invalid.warnings).toContain('Invalid AIDraw SVG text-box metadata was ignored.');
      expect(Object.values(invalid.document.objects).find((object) => object.type === 'text' && object.text === centered.text)).toMatchObject({ lineHeight: 1.2 });
    }
  });

  it('restores an exact AIDraw image crop only when its standard SVG crop still matches', async () => {
    const document = createIllustrationDocument('SVG image crop'); document.artboard = { ...document.artboard, width: 240, height: 160, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const source = createCanvas(8, 6); const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 4, 3); sourceContext.fillStyle = '#00ff00'; sourceContext.fillRect(4, 0, 4, 3);
    sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(0, 3, 4, 3); sourceContext.fillStyle = '#ffff00'; sourceContext.fillRect(4, 3, 4, 3);
    const bytes = source.toBuffer('image/png'); source.width = 1; source.height = 1;
    const asset: DocumentAsset = { id: 'crop-source', name: 'Crop source', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') };
    const timestamp = nowIso(); const image: ImageObject = {
      id: 'cropped-image', revision: 0, name: 'Cropped image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id,
      visible: true, locked: false, opacity: 0.75, blendMode: 'multiply', transform: { ...IDENTITY_TRANSFORM, x: 30, y: 40 }, type: 'image', assetId: asset.id,
      width: 110, height: 85, sourceWidth: 8, sourceHeight: 6, crop: { x: 1.25, y: 0.5, width: 5.5, height: 4.25 }, filters: [],
    };
    document.assets[asset.id] = asset; document.objects[image.id] = image; vector.objectIds.push(image.id);
    const before = structuredClone(document); const svg = illustrationToSvg(document);
    expect(svg).toContain('data-aidraw-image-crop="1" data-aidraw-display-width="110" data-aidraw-display-height="85" data-aidraw-source-width="8" data-aidraw-source-height="6" data-aidraw-crop-x="1.25" data-aidraw-crop-y="0.5" data-aidraw-crop-width="5.5" data-aidraw-crop-height="4.25"');
    expect(svg).toContain('clip-path="url(#crop-cropped-image)" x="-25" y="-10" width="160" height="120" preserveAspectRatio="none"');

    const reopenedResult = importEditableSvg(svg, 'Reopened crop'); const reopened = reopenedResult.document;
    const reopenedImage = Object.values(reopened.objects).find((object): object is ImageObject => object.type === 'image');
    expect(reopenedResult.warnings).toEqual([]);
    expect(reopenedImage).toMatchObject({ width: 110, height: 85, sourceWidth: 8, sourceHeight: 6, crop: { x: 1.25, y: 0.5, width: 5.5, height: 4.25 }, opacity: 0.75, blendMode: 'multiply', transform: { x: 30, y: 40 } });
    expect(reopenedImage?.maskObjectId).toBeUndefined(); expect(document).toEqual(before);
    const originalCanvas = await renderIllustration(document); const reopenedCanvas = await renderIllustration(reopened);
    const originalPixels = Buffer.from(originalCanvas.getContext('2d').getImageData(0, 0, originalCanvas.width, originalCanvas.height).data);
    const reopenedPixels = Buffer.from(reopenedCanvas.getContext('2d').getImageData(0, 0, reopenedCanvas.width, reopenedCanvas.height).data);
    originalCanvas.width = 1; originalCanvas.height = 1; reopenedCanvas.width = 1; reopenedCanvas.height = 1;
    expect(reopenedPixels).toEqual(originalPixels);

    for (const [from, to, warning] of [
      ['data-aidraw-image-crop="1"', 'data-aidraw-image-crop="2"', 'Invalid AIDraw SVG image-crop metadata was ignored.'],
      ['data-aidraw-crop-width="5.5"', 'data-aidraw-crop-width="9"', 'Invalid AIDraw SVG image-crop metadata was ignored.'],
      ['x="-25" y="-10"', 'x="-24" y="-10"', 'AIDraw SVG image-crop metadata did not match its standard SVG crop and was ignored.'],
    ]) {
      const invalid = importEditableSvg(svg.replace(from, to), 'Invalid crop metadata');
      expect(invalid.warnings).toContain(warning);
      const genericImage = Object.values(invalid.document.objects).find((object): object is ImageObject => object.type === 'image');
      expect(genericImage?.crop).toBeUndefined(); expect(genericImage?.maskObjectId).toBeTruthy();
    }
  });
});

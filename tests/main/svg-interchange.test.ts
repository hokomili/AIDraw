import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { importDocument } from '@main/import-document';
import { illustrationToSvg } from '@main/export-document';
import { importEditableSvg } from '@main/svg-import';
import { createIllustrationDocument, HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type TextObject } from '@aidraw/core';

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
});

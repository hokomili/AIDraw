import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { importDocument } from '@main/import-document';
import { illustrationToSvg } from '@main/export-document';
import { importEditableSvg } from '@main/svg-import';

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
});

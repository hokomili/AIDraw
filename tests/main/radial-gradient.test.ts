import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, nowIso, type PaintStyle, type ShapeObject } from '@aidraw/core';
import { renderIllustration } from '@main/render-document';
import { illustrationToSvg } from '@main/export-document';
import { importEditableSvg } from '@main/svg-import';

function fixture(fill: PaintStyle, x = 4) {
  const document = createIllustrationDocument('Radial export fidelity');
  document.artboard = { ...document.artboard, width: 176, height: 128, background: '#000000' };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
  const timestamp = nowIso();
  const object: ShapeObject = {
    id: 'radial', name: 'Radial', revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    layerId: layer.id, type: 'shape', shape: 'ellipse', width: 120, height: 120,
    visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y: 4 }, fill,
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  document.objects = { radial: object }; layer.objectIds = ['radial'];
  return document;
}

describe('radial paint across canonical raster and SVG', () => {
  it.each([4, 24])('preserves the centered radius after translation x=%i and SVG reimport', async (x) => {
    const document = fixture({ kind: 'radial-gradient', x1: 60, y1: 60, x2: 120, y2: 60, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] }, x);
    const original = structuredClone(document);
    const native = await renderIllustration(document);
    const svg = await illustrationToSvg(document);
    const svgCanvas = createCanvas(176, 128); svgCanvas.getContext('2d').drawImage(await loadImage(Buffer.from(svg)), 0, 0);
    const imported = importEditableSvg(svg, 'Reimported radial');
    const roundtrip = await renderIllustration(imported.document);
    const center = x + 60;
    for (const canvas of [native, svgCanvas, roundtrip]) {
      const context = canvas.getContext('2d');
      for (const distance of [10, 20, 30, 40, 50]) {
        const left = context.getImageData(center - distance - 1, 63, 1, 1).data[0];
        const right = context.getImageData(center + distance, 63, 1, 1).data[0];
        expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
        expect(right).toBeGreaterThan(20);
        const expected = native.getContext('2d').getImageData(center + distance, 63, 1, 1).data[0];
        expect(Math.abs(right - expected)).toBeLessThanOrEqual(3);
      }
    }
    expect(document).toEqual(original);
  });

  it('uses the final stop for a zero radial radius, including alpha', async () => {
    const document = fixture({ kind: 'radial-gradient', x1: 60, y1: 60, x2: 60, y2: 60, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#ff0000', opacity: 0.5 }] });
    const native = await renderIllustration(document);
    const svgCanvas = createCanvas(176, 128); svgCanvas.getContext('2d').drawImage(await loadImage(Buffer.from(await illustrationToSvg(document))), 0, 0);
    const a = native.getContext('2d').getImageData(64, 64, 1, 1).data;
    const b = svgCanvas.getContext('2d').getImageData(64, 64, 1, 1).data;
    expect(a[0]).toBeGreaterThanOrEqual(127); expect(a[0]).toBeLessThanOrEqual(128);
    expect([...a].every((value, i) => Math.abs(value - b[i]) <= 1)).toBe(true);
  });
});

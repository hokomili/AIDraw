import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type ImageObject } from '@aidraw/core';
import { ImageCropFields } from '../../src/renderer/components/ImageCropFields';

function image(): ImageObject { const timestamp = nowIso(); return { id: 'image', revision: 3, name: 'Crop', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'image', assetId: 'asset', width: 100, height: 50, sourceWidth: 400, sourceHeight: 200, crop: { x: 50.5, y: 25.25, width: 300.25, height: 150.5 }, filters: [] }; }

describe('numeric image crop fields', () => {
  it('renders one explicit atomic source-coordinate form with fractional values', () => {
    const markup = renderToStaticMarkup(createElement(ImageCropFields, { object: image(), onApply: () => undefined }));
    expect(markup).toContain('aria-label="Numeric source image crop"');
    expect(markup).toContain('Source X');
    expect(markup).toContain('value="50.5"');
    expect(markup).toContain('value="25.25"');
    expect(markup).toContain('value="300.25"');
    expect(markup).toContain('value="150.5"');
    expect(markup).toContain('Full source: 400 × 200 px · fractional coordinates are preserved.');
    expect(markup).toContain('Apply source crop');
  });

  it('wires one revision-keyed form to the existing object replacement path', () => {
    const source = readFileSync('src/renderer/App.tsx', 'utf8');
    expect(source).toContain('key={`${object.id}:${object.revision}:crop-fields`}');
    expect(source).toContain('onApply={(next) => replace(next, "Set numeric image crop")}');
  });
});

import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPixelDocument, createPixelTilemap } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { StampLibraryDialog } from '../../src/renderer/components/StampLibraryDialog';

describe('stamp library dialog', () => {
  it('states the bounded pixel color contract and defaults to non-destructive import', () => {
    const document = createPixelDocument('sprite', 'Pixel stamp target');
    document.stamps = [{ id: 'stamp-one', name: 'One', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 1 }] }];
    const markup = renderToStaticMarkup(createElement(StampLibraryDialog, {
      document,
      onApply: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Pixel stamp library JSON');
    expect(markup).toContain('Parsing and preview do not change the document.');
    expect(markup).toContain('Missing colors are appended; import fails if the 256-color palette is full. Colors are never approximated.');
    expect(markup).toContain('1 reusable pixel stamp');
    expect(markup).toContain('Copy current JSON');
    expect(markup).toContain('Load JSON file');
    expect(markup).toContain('16 MiB · 262,144 cells');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('Add copies');
    expect(markup).toContain('Replace library');
    expect(markup).toContain('Preview import');
  });

  it('states that tile transfer requires exact shared assets and does not bundle or rebase them', () => {
    const document = createPixelDocument('sprite', 'Tile stamp target');
    const map = createPixelTilemap('Map');
    const markup = renderToStaticMarkup(createElement(StampLibraryDialog, {
      document,
      map,
      onApply: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Tile stamp library JSON');
    expect(markup).toContain('exact exported tileset and source-sprite identities, revisions, GID ranges, and geometry');
    expect(markup).toContain('Tileset pixels are not bundled or rebased.');
    expect(markup).toContain('Remove the current tile stamps and preserve the imported library IDs.');
  });

  it('wires one previewed operation plan into the existing atomic document transaction', async () => {
    const canvasSource = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const dialogSource = await readFile(new URL('../../src/renderer/components/StampLibraryDialog.tsx', import.meta.url), 'utf8');
    expect(canvasSource).toContain('<StampLibraryDialog');
    expect(canvasSource).toContain('plan.operations');
    expect(canvasSource).toContain('Import reusable ${plan.kind} stamp library');
    expect(canvasSource).toContain('setActiveStampId(activeId)');
    expect(canvasSource).toContain('setActiveTileStampId(activeId)');
    expect(dialogSource).toContain('prepareStampLibraryImport(document, bundle, mode, { map })');
    expect(dialogSource).toContain('previewRevision !== document.revision');
    expect(dialogSource).toContain('The document changed after preview. Preview again before applying.');
    expect(dialogSource).toContain('const currentPlan = buildPlan()');
    expect(dialogSource).toContain('if (await onApply(currentPlan)) onClose()');
    expect(dialogSource).toContain('No document operation has run yet.');
  });
});

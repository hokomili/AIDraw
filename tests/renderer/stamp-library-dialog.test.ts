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
    expect(markup).toContain('Replace stamp library');
    expect(markup).toContain('Preview import');
  });

  it('offers exact-reference predecessor JSON and a deliberate bounded portable-copy workflow', () => {
    const document = createPixelDocument('sprite', 'Tile stamp target');
    const map = createPixelTilemap('Map');
    const markup = renderToStaticMarkup(createElement(StampLibraryDialog, {
      document,
      map,
      onApply: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Tile stamp library JSON');
    expect(markup).toContain('Version 1 exact-reference JSON keeps predecessor clone/shared-project behavior.');
    expect(markup).toContain('A reviewed version 2 portable kit carries every and only required tilesets and sprite sources.');
    expect(markup).toContain('Byte-identical tilesets reuse only when already attached');
    expect(markup).toContain('preserve every existing cell, tile-object, and retained-stamp GID meaning');
    expect(markup).toContain('Existing assets, maps, cells, and source projects are never rewritten or deleted.');
    expect(markup).toContain('Copy portable kit');
    expect(markup).toContain('Copy exact-reference JSON');
    expect(markup).toContain('128 assets, 64 tilesets, 4,194,304 logical/stored source pixels');
    expect(markup).toContain('1,500,000 planned bytes/256 operations');
    expect(markup).toContain('Replace only the current tile stamps. Existing project assets, maps, cells, and sources remain.');
  });

  it('wires one previewed operation plan into the existing atomic document transaction', async () => {
    const canvasSource = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const dialogSource = await readFile(new URL('../../src/renderer/components/StampLibraryDialog.tsx', import.meta.url), 'utf8');
    expect(canvasSource).toContain('<StampLibraryDialog');
    expect(canvasSource).toContain('plan.operations');
    expect(canvasSource).toContain('Import reusable ${plan.kind} stamp library');
    expect(canvasSource).toContain('plan.expectedDocumentId');
    expect(canvasSource).toContain('plan.expectedDocumentRevision');
    expect(canvasSource).toContain('setActiveStampId(activeId)');
    expect(canvasSource).toContain('setActiveTileStampId(activeId)');
    expect(dialogSource).toContain('prepareStampLibraryImport(document, bundle, mode, { map })');
    expect(dialogSource).toContain('plan.expectedDocumentRevision !== document.revision');
    expect(dialogSource).toContain('The document changed after preview. Preview again before applying.');
    expect(dialogSource).not.toContain('const currentPlan = buildPlan()');
    expect(dialogSource).toContain('if (await onApply(plan)) onClose()');
    expect(dialogSource).toContain('Apply uses this frozen, document-bound preview.');
    expect(dialogSource).toContain('sourceFirstGid');
    expect(dialogSource).toContain('sourceAssetId');
    expect(dialogSource).toContain('mapAttachments');
    expect(dialogSource).toContain('No document operation has run yet.');
  });
});

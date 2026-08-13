import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILT_IN_RASTER_BRUSH_PRESETS, createIllustrationDocument } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { BrushLibraryDialog } from '../../src/renderer/components/BrushLibraryDialog';

describe('custom brush library dialog', () => {
  it('states the bounded document-owned contract and defaults to non-destructive copies', () => {
    const document = createIllustrationDocument('Brush target');
    document.brushPresets = [{ ...structuredClone(BUILT_IN_RASTER_BRUSH_PRESETS.watercolor), id: 'custom-wash', name: 'Custom wash' }];
    const markup = renderToStaticMarkup(createElement(BrushLibraryDialog, { document, onApply: async () => true, onClose: () => undefined }));
    expect(markup).toContain('Custom brush library JSON');
    expect(markup).toContain('Parsing and preview do not change the document.');
    expect(markup).toContain('1 custom brush preset');
    expect(markup).toContain('Copy current JSON');
    expect(markup).toContain('Built-ins, strokes, tip images, folders/tags, and application-wide libraries are not included.');
    expect(markup).toContain('Existing strokes keep their embedded recipes when this library is replaced.');
    expect(markup).toContain('1 MiB · 256 custom presets · exact validated dab recipes');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('Add copies');
    expect(markup).toContain('Replace library');
    expect(markup).toContain('Preview import');
  });

  it('wires revision-expiring preview and one atomic preset replacement into the brush toolbar', async () => {
    const appSource = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    const dialogSource = await readFile(new URL('../../src/renderer/components/BrushLibraryDialog.tsx', import.meta.url), 'utf8');
    const stampSource = await readFile(new URL('../../src/renderer/components/StampLibraryDialog.tsx', import.meta.url), 'utf8');
    expect(appSource).toContain('>Brush library</button>');
    expect(appSource).toContain('<BrushLibraryDialog');
    expect(appSource).toContain('"Replace custom brush library" : "Add custom brush copies"');
    expect(appSource).toContain('plan.operations');
    expect(appSource).toContain('operation.presets.find((preset) => preset.id === plan.importedIds[0])');
    expect(appSource).toContain('setSize(imported.size); setOpacity(imported.opacity)');
    expect(dialogSource).toContain('prepareBrushLibraryImport(document, parseBrushLibraryJson(json), mode)');
    expect(dialogSource).toContain('previewRevision !== document.revision');
    expect(dialogSource).toContain('The document changed after preview. Preview again before applying.');
    expect(dialogSource).toContain('const currentPlan = buildPlan()');
    expect(dialogSource).toContain('if (await onApply(currentPlan)) onClose()');
    expect(dialogSource).toContain('No document operation has run yet.');
    expect(stampSource).toContain('className="library-interchange-dialog"');
  });
});

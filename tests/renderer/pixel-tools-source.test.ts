import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('pixel tool renderer wiring', () => {
  it('uses shared bounded kernels and compact region commits', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('floodPixelRegion');
    expect(source).toContain('replacePixelRegion');
    expect(source).toContain('pixelPerfectStrokePoints');
    expect(source).toContain("kind: 'pixel.cel.region'");
    expect(source).toContain('bulkPreview');
    expect(source).not.toContain('function floodFill(');
    expect(source).not.toContain('function floodSelect(');
    expect(source).not.toContain('function pixelPerfect(');
  });

  it('cancels captured gestures on pointer cancellation or Escape without committing them', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onPointerCancel={() => void cancelGesture()}');
    expect(source).not.toContain('onPointerCancel={() => void finish()}');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("else if (tool === 'fill' || tool === 'replace') { setCursor(point); return; }");
    expect(source).toContain('cancelPixelGesture(() =>');
    expect(source).toContain('gestureEpochRef.current += 1');
    expect(source).toContain('gestureEpoch !== gestureEpochRef.current');
  });

  it('exposes both exact quarter-turn directions for selections and reusable pixel or tile stamps', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain("transformSelection('rotate-clockwise')");
    expect(source).toContain("transformSelection('rotate-counterclockwise')");
    expect(source).toContain("transformActiveStamp('rotate-clockwise')");
    expect(source).toContain("transformActiveStamp('rotate-counterclockwise')");
    expect(source).toContain('RotateCcw');
  });

  it('persists a deterministic new seed between weighted-variant strokes without rewriting painted cells', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('nextTileVariantSeed(variantSeed)');
    expect(source).toContain('Start new tile-variant stroke seed');
    expect(source).toContain('existing painted tiles do not change');
    expect(source).toContain("kind: 'pixel.asset.replace', asset: map, expectedRevision: tilemap.revision");
  });

  it('plans a complete Wang terrain drag before one canonical commit and fails closed with exact transition diagnostics', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const start = source.indexOf("} else if (tool === 'terrain'");
    const end = source.indexOf("        } else {\n          if (tool !== 'eraser'", start);
    const branch = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain('planWangTerrainStroke(terrainSet, points, terrainColor.id, terrainTileAt');
    expect(branch).toContain("{ erase: terrainErase, contains }");
    expect(branch).toContain('resolveTilesetForGid(document, tilemap, gid)');
    expect(branch).toContain('resolved.tileset.id !== terrainTileset.id');
    expect(branch).not.toContain('decoded.gid - firstGid');
    expect(branch).toContain("if (plan.status === 'unmatched')");
    expect(branch).toContain('entry.wangId.join');
    expect(branch).toContain('No terrain tiles changed; add those mappings');
    expect(branch.indexOf("if (plan.status === 'unmatched')")).toBeLessThan(branch.indexOf("kind: 'pixel.tilemap.set'"));
    expect(branch.match(/kind: 'pixel\.tilemap\.set'/gu)).toHaveLength(1);
    expect(branch).toContain('expectedRevision: layer.revision');
    expect(branch).toContain('in one undoable change');
    expect(branch).not.toContain('terrain neighbor');
  });

  it('turns repeated sprite copies into exact wrapped edits through the ordinary cel transaction', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('wrapPixelPoint');
    expect(source).toContain('wrapPixelPoints(preview, sprite.width, sprite.height)');
    expect(source).toContain('wrapPixelPoints(stampPreview, sprite.width, sprite.height)');
    expect(source).toContain("tool !== 'select' && tool !== 'lasso'");
    expect(source).toContain('placePixelStamp(placementStamp, entry.x, entry.y, wrapEditing ? undefined');
    expect(source).toContain('const spritePoint = sprite && wrapEditing ? wrapPixelPoint(point, sprite.width, sprite.height) : point');
    expect(source).toContain('pixelAt(sprite, activeFrameId, spritePoint.x, spritePoint.y)');
    expect(source).toContain('start: spritePoint, read: compositePixelReader(sprite, activeFrameId)');
    expect(source).toContain('wrapPixelPoints(authoredPoints, sprite.width, sprite.height)');
    expect(source).toContain('wrap={wrapEditing}');
    expect(source).toContain('orderedDitherIndex(sample.x, sample.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY)');
    expect(source).toContain('orderedDitherIndex(point.x, point.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY)');
    expect(source).toContain('Preview and edit through repeated copies across opposite sprite edges');
    expect(source).toContain('aria-pressed={wrapEditing}');
    expect(source).toContain("kind: 'pixel.cel.set'");
    expect(source).toContain("region: { kind: bounds.kind, assetId: sprite.id, x: 0, y: 0, width: bounds.width, height: bounds.height }");
  });

  it('maps a bounded indexed sprite selection into the document bitmap-font transaction', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('captureBitmapGlyph(selection, compositePixelReader(sprite, activeFrameId))');
    expect(source).toContain('Map selected nonzero indexed cells to a reusable bitmap-font character');
    expect(source).toContain('<CaseUpper size={EDITOR_DENSITY.secondaryIcon} /> Glyph');
    expect(source).toContain('<BitmapGlyphMapperDialog');
    expect(source).toContain('upsertBitmapFontGlyph(font, character, { ...capture.glyph, advance }, lineHeight)');
    expect(source).toContain("apply('Map bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(source).toContain('Use the Text tool to paint it as editable indexed pixels.');
    expect(source).not.toContain("kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: capture");
  });

  it('maps a reviewed uniform glyph sheet through one current-state font-library transaction', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const component = await readFile(new URL('../../src/renderer/components/BitmapGlyphSheetMapperDialog.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Divide the indexed selection into uniform row-major bitmap-font glyph cells');
    expect(source).toContain('<Table2 size={EDITOR_DENSITY.secondaryIcon} /> Glyph sheet');
    expect(source).toContain('<BitmapGlyphSheetMapperDialog');
    expect(source).toContain('points={selection}');
    expect(source).toContain('readIndex={compositePixelReader(sprite, activeFrameId)}');
    expect(source).toContain('mapBitmapFontGlyphSheet(font, selection, compositePixelReader(sprite, activeFrameId), characters, columns, advance, lineHeight)');
    expect(source).toContain("apply('Map bitmap font glyph sheet', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(source).toContain('Use the Text tool to paint them as editable indexed pixels.');
    expect(component).toContain('The source sprite, palette, frame, and selection stay unchanged.');
    expect(component).toContain('Selected nonzero indices become ink; index 0 and unselected cells are clear.');
    expect(component).not.toContain("kind: 'pixel.cel.set'");
  });

  it('manages one observed document font and glyph through current-state library transactions', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const createBitmapFont = async');
    const end = source.indexOf('const changeFrameDuration = async', start);
    const lifecycle = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source).toContain('Manage document-owned bitmap fonts and mapped glyphs');
    expect(source).toContain('<BitmapFontLibraryDialog');
    expect(source).toContain('selectedFontId={selectedBitmapFontId}');
    expect(source).toContain('onSelectedFontChange={setBitmapFontId}');
    expect(source).toContain('onManageFonts');
    expect(source).toContain('The selected font has no mapped ink for this text. Use Glyph or Glyph sheet to add characters.');
    expect(source).toContain('resolveBitmapFontId(document.bitmapFonts, bitmapFontId)');
    expect(source).toContain('useEditorStore.getState().snapshot?.activeDocument');
    expect(lifecycle).toContain("createEmptyBitmapFont(currentBitmapFonts(), { id: createId('bitmap-font'), ...request })");
    expect(lifecycle).toContain('deleteBitmapFont(currentBitmapFonts(), fontId)');
    expect(lifecycle).toContain('renameBitmapFont(currentBitmapFonts(), request.expectedFont, request.name)');
    expect(lifecycle).toContain('editBitmapFontGlyph(currentBitmapFonts(), request.expectedFont, request.character, request.glyph, request.lineHeight)');
    expect(lifecycle).toContain('deleteBitmapFontGlyph(currentBitmapFonts(), request.expectedFont, request.character)');
    expect(lifecycle).toContain("apply('Create bitmap font', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(lifecycle).toContain("apply('Delete bitmap font', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(lifecycle).toContain("apply('Rename bitmap font', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(lifecycle).toContain("apply('Edit bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(lifecycle).toContain("apply('Delete bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(lifecycle.match(/kind: 'pixel\.bitmap-fonts\.replace'/gu)).toHaveLength(5);
    expect(lifecycle).not.toContain("kind: 'pixel.cel.set'");
    expect(lifecycle).not.toContain('setSelection(');
    expect(lifecycle).toContain('Existing bitmap text remains rasterized in its cels.');
  });

  it('publishes private plus standard-PNG sprite selections while retaining the project-local tile clipboard fail closed', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain("type LocalSelectionClipboard = { kind: 'tile'");
    expect(source.match(/localSelectionClipboard\s*=/gu)).toHaveLength(1); // the tile-only copy assignment
    expect(source).toContain('await window.aidraw.writePixelSelectionClipboard(fragment)');
    expect(source).toContain('const activePalette = sprite.paletteOverrides[activeFrameId] ?? document.palette');
    expect(source).toContain('palette: activePalette.map((entry) => entry.color)');
    expect(source).toContain("if (await copyLocalSelection()) await deleteSelection()");
    expect(source).toContain("window.addEventListener('focus', refreshClipboardAvailability)");
    expect(source).toContain("window.removeEventListener('focus', refreshClipboardAvailability)");
    expect(source).toContain('clipboard = await window.aidraw.readPixelSelectionClipboard({');
    expect(source).toContain('expectedDocumentRevision: document.revision');
    expect(source).toContain('origin: cursor ?? { x: 0, y: 0 }');
    expect(source).toContain("const standardPng = clipboard.status === 'png'");
    expect(source).toContain("clipboard.status === 'png' && clipboard.plan");
    expect(source).toContain("applyGuarded('Paste standard PNG selection', plan.operations, expectedPngDocumentRevision)");
    expect(source).toContain('The standard PNG paste plan is missing its document revision guard.');
    expect(source).toContain("region: { kind: 'pixel', assetId: sprite.id, ...plan.bounds }");
    expect(source).toContain("result.status === 'valid' || result.status === 'png'");
    expect(source).toContain('bitmap transparency became clear selected cells');
    expect(source).toContain("if (tilemap) {\n      const clipboard = localSelectionClipboard;");
    expect(source).not.toContain("localSelectionClipboard = { kind: 'pixel'");
  });
});

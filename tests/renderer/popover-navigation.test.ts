import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveScopedAnimationTagId } from '../../src/renderer/animation-tag-timeline';
import { menuFocusIndex } from '../../src/renderer/popover-navigation';

describe('renderer popover keyboard navigation', () => {
  it('wraps menu focus and resolves Home and End deterministically', () => {
    expect(menuFocusIndex('ArrowDown', 3, 4)).toBe(0);
    expect(menuFocusIndex('ArrowUp', 0, 4)).toBe(3);
    expect(menuFocusIndex('Home', 3, 4)).toBe(0);
    expect(menuFocusIndex('End', 0, 4)).toBe(3);
    expect(menuFocusIndex('ArrowDown', -1, 4)).toBe(0);
    expect(menuFocusIndex('Enter', 0, 4)).toBeUndefined();
    expect(menuFocusIndex('ArrowDown', -1, 0)).toBeUndefined();
  });

  it('routes the active map through Home then ArrowDown to the first created illustration', () => {
    const activeMapIndex = 3;
    const totalDocumentAndBatchItems = 16;
    const homeIndex = menuFocusIndex('Home', activeMapIndex, totalDocumentAndBatchItems);
    expect(homeIndex).toBe(0);
    expect(menuFocusIndex('ArrowDown', homeIndex!, totalDocumentAndBatchItems)).toBe(1);
  });

  it('omits a stored tag choice after the exact sprite or current tag set changes', () => {
    const selection = { documentId: 'document-a', spriteId: 'sprite-a', tagId: 'tag-shared' };
    expect(resolveScopedAnimationTagId(selection, 'document-a', 'sprite-a', ['tag-shared', 'tag-other'])).toBe('tag-shared');
    expect(resolveScopedAnimationTagId(selection, 'document-a', 'sprite-a', ['tag-other'])).toBeUndefined();
    expect(resolveScopedAnimationTagId(selection, 'document-a', 'sprite-b', ['tag-shared'])).toBeUndefined();
    expect(resolveScopedAnimationTagId(selection, 'document-b', 'sprite-a', ['tag-shared'])).toBeUndefined();
    expect(resolveScopedAnimationTagId(undefined, 'document-a', 'sprite-a', ['tag-shared'])).toBeUndefined();
  });

  it('binds owned focus, Escape restoration, and outside dismissal to both popovers', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('aria-haspopup="menu"');
    expect(app).toContain('onKeyDown={handleAllTabsMenuKeys}');
    expect(app).toContain('menuFocusIndex(event.key, currentIndex, items.length)');
    expect(app).toContain('items?.[resolvedAllTabsFocusIndex]?.focus()');
    expect(app).toContain('tabIndex={resolvedAllTabsFocusIndex === index ? 0 : -1}');
    expect(app).toContain('role="group" aria-label="All-document actions"');
    expect((app.match(/role="menuitem"/gu) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(app).toContain('allTabsButtonRef.current?.focus()');
    expect(app).toContain('event.stopImmediatePropagation()');
    expect(app).toContain('aria-haspopup="dialog"');
    expect(app).toContain('role="dialog"');
    expect(app).toContain('aria-label="Export active document"');
    expect(app).toContain("?.querySelector<HTMLElement>('select, button:not(:disabled)')");
    expect(app).toContain('exportButtonRef.current?.focus()');
    expect(app).toContain('exportWrapRef.current?.contains(event.target as Node)');
  });

  it('offers one named palette-cycle period from the active sprite frame without combining timeline scheduling', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<strong>Palette-cycle output</strong><small>{selectedExportCycle && selectedExportCycle.stepMs % 10 !== 0 ? "APNG/sheet exact · GIF needs 10 ms steps" : "GIF/APNG/sheet · active frame"}</small>');
    expect(app).toContain('aria-label="Palette-cycle export"');
    expect(app).toContain('Timeline or tag animation');
    expect(app).toContain('cycle.toIndex - cycle.fromIndex + 1} steps · {cycle.stepMs} ms');
    expect(app).toContain('disabled={Boolean(selectedExportCycle)}');
    expect(app).toContain("disabled={Boolean(selectedExportCycle && (!['gif', 'apng', 'sprite-sheet'].includes(format) || (format === \"gif\" && selectedExportCycle.stepMs % 10 !== 0)))}");
    expect(app).toContain('Palette-cycle output is available only for GIF, APNG, and sprite sheet.');
    expect(app).toContain('paletteCycleId: ["gif", "apng", "sprite-sheet"].includes(format) ? selectedExportCycle?.id : undefined');
    expect(app).toContain('paletteCycleFrameId: ["gif", "apng", "sprite-sheet"].includes(format) && selectedExportCycle ? exportFrameId : undefined');
    expect(app).toContain('canvasAnimation?.activeAssetId === exportSprite.id');
  });

  it('disambiguates independent animation tags by exact authored range and stable order', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<strong>Animation range</strong><small>One exact tag · GIF, APNG, sheet</small>');
    expect(app).toContain('{span.tag.name} · tag {span.order + 1} · F{span.fromIndex + 1}–F{span.toIndex + 1} · {span.tag.direction}');
    expect(app).toContain('value={span.tag.id}');
    expect(app).toContain('resolveScopedAnimationTagId(exportTagSelection, document?.id, exportSprite?.id, exportTagSpans.map((span) => span.tag.id))');
    expect(app).toContain('value={exportTagId ?? ""}');
    expect(app).toContain('animationTagId: ["gif", "apng", "sprite-sheet"].includes(format) && !selectedExportCycle && exportTagId ? exportTagId : undefined');
    expect(app).toContain('duplicate names are refused');
  });
});

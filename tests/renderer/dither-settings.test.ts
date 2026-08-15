import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { OrderedDitherPreferences } from '../../src/common/ordered-dither-preferences';
import { DitherPresetDialog, OrderedDitherPhaseInput } from '../../src/renderer/components/DitherPresetDialog';

const preferences: OrderedDitherPreferences = {
  current: { matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 },
  presets: [{ id: 'fine-shade', name: 'Fine shade', matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 }],
  activePresetId: 'fine-shade',
};

describe('ordered dither settings', () => {
  it('keeps keyboard drafts intact and commits or cancels only at the field boundary', () => {
    const changed: string[] = [];
    const actions: string[] = [];
    const field = OrderedDitherPhaseInput({
      axis: 'X',
      draft: '-13',
      onDraftChange: (value) => changed.push(value),
      onCommit: () => actions.push('commit'),
      onCancel: () => actions.push('cancel'),
    }) as ReactElement<{ children: ReactNode }>;
    type InputProps = {
      type: string;
      value: string;
      onChange(event: { target: { value: string } }): void;
      onBlur(): void;
      onKeyDown(event: { key: string; preventDefault(): void; currentTarget: { blur(): void } }): void;
    };
    const input = Children.toArray(field.props.children).find(
      (child) => isValidElement(child) && child.type === 'input',
    ) as ReactElement<InputProps>;

    expect(input.props.type).toBe('text');
    expect(input.props.value).toBe('-13');
    input.props.onChange({ target: { value: '-' } });
    input.props.onChange({ target: { value: '-1' } });
    input.props.onChange({ target: { value: '-13' } });
    expect(changed).toEqual(['-', '-1', '-13']);
    expect(actions).toEqual([]);

    let prevented = false;
    let blurred = false;
    input.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; }, currentTarget: { blur: () => { blurred = true; } } });
    expect({ prevented, blurred, actions }).toEqual({ prevented: true, blurred: true, actions: [] });
    input.props.onBlur();
    expect(actions).toEqual(['commit']);
    input.props.onKeyDown({ key: 'Escape', preventDefault: () => undefined, currentTarget: { blur: () => undefined } });
    expect(actions).toEqual(['commit', 'cancel']);
  });

  it('renders durable named presets with truthful active state, matrix-local phase, and no palette identity', () => {
    const markup = renderToStaticMarkup(createElement(DitherPresetDialog, {
      preferences,
      onSave: () => true,
      onApply: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Ordered dither presets');
    expect(markup).toContain('Saved locally across restarts.');
    expect(markup).toContain('Current preset: Fine shade');
    expect(markup).toContain('8×8 · 38% · phase 7,2');
    expect(markup).toContain('Base and mix palette indices stay with the current document and are never stored in presets.');
    expect(markup).toContain('aria-label="Current dither preset Fine shade"');
    expect(markup).toContain('aria-label="Delete dither preset Fine shade"');
    expect(markup).toContain('aria-label="New dither preset name"');
    expect(markup).toContain('Save current settings');
    expect(markup).not.toContain('icon-only');
  });

  it('wires hydrated phase through the same preview and commit kernel with wrap, selection, symmetry, and density boundaries intact', async () => {
    const [app, canvas, store, styles, controls] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/store.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/DitherPresetDialog.tsx', import.meta.url), 'utf8'),
    ]);
    expect(controls).toContain('aria-label={`Ordered dither matrix-local phase ${axis}`}');
    expect(app).toContain('withOrderedDitherConfiguration(orderedDitherPreferences, update)');
    expect(app).toContain("onCommit={() => commitDitherPhase('phaseX')}");
    expect(app).toContain("onCommit={() => commitDitherPhase('phaseY')}");
    expect(app).toContain('<DitherPresetDialog');
    expect(app).toContain('if (loading || !document) return <LoadingScreen />;');
    expect(store).toContain('orderedDitherPreferences: structuredClone(snapshot.orderedDitherPreferences)');
    expect(store).toContain('setOrderedDitherPreferences: (value) =>');
    const phasedCall = 'orderedDitherIndex(point.x, point.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY)';
    expect(canvas).toContain('orderedDitherIndex(sample.x, sample.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY)');
    expect(canvas).toContain(phasedCall);
    expect(canvas).toContain('const sample = sprite && wrapEditing ? wrapPixelPoint(point, sprite.width, sprite.height) : point');
    expect(canvas).toContain("tool === 'dither' && selection.length ? symmetric.filter");
    expect(canvas).toContain('wrapPixelPoints(authoredPoints, sprite.width, sprite.height)');
    expect(canvas).toContain('region: { kind: bounds.kind, assetId: sprite.id, x: 0, y: 0, width: bounds.width, height: bounds.height }');
    expect(styles).toMatch(/\.dither-preset-row > button \{[^}]*min-height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.dither-preset-row > button strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.dither-preset-row > button small \{[^}]*font-size: var\(--ui-type-caption\)/);
  });
});

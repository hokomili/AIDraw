import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { createPixelSprite, createPixelTileset } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import {
  TilesetSliceEditor,
  TilesetSliceLegend,
  TilesetSliceReview,
  type TilesetSliceReviewProps,
} from '../../src/renderer/components/TilesetSliceEditor';
import type { TilesetResliceImpact } from '../../src/common/tileset-reslice';

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

const ordinaryImpact: TilesetResliceImpact = {
  metadataTiles: 1_048_576,
  preservedMetadataTiles: 1_048_575,
  reframedMetadataTiles: 999_999,
  remappedMetadataTileIds: 888_888,
  droppedMetadataTiles: 1,
  droppedAnimationFrames: 12_345,
  droppedCollisionShapes: 23_456,
  droppedCustomProperties: 34_567,
  droppedWangColors: 45_678,
  droppedWangTiles: 56_789,
};

function reviewProps(overrides: Partial<TilesetSliceReviewProps> = {}): TilesetSliceReviewProps {
  return {
    result: { kind: 'plan', columns: 1_024, rows: 1_024, impact: ordinaryImpact },
    remap: 'source-position',
    layoutChanged: false,
    requiresAcknowledgement: false,
    acknowledged: false,
    onRemapChange: () => undefined,
    onAcknowledgedChange: () => undefined,
    onReset: () => undefined,
    onApply: () => undefined,
    radioName: 'fixture-remap',
    ...overrides,
  };
}

describe('tileset source-sheet review presentation', () => {
  it('describes every non-color overlay cue and connects the bounded preview to the full legend', () => {
    const legend = renderToStaticMarkup(createElement(TilesetSliceLegend, { id: 'slice-review-legend' }));
    expect(legend).toContain('id="slice-review-legend" aria-label="Slice preview overlay legend"');
    expect(legend).toContain('<strong>Current grid</strong><small>Existing slice geometry</small>');
    expect(legend).toContain('<strong>Draft grid</strong><small>Proposed slice geometry</small>');
    expect(legend).toContain('<strong>Selected tile</strong><small>Current source rectangle</small>');
    expect(legend).toContain('class="current" aria-hidden="true"');
    expect(legend).toContain('class="draft" aria-hidden="true"');
    expect(legend).toContain('class="selected" aria-hidden="true"');
    expect(legend.indexOf('Current grid')).toBeLessThan(legend.indexOf('Draft grid'));
    expect(legend.indexOf('Draft grid')).toBeLessThan(legend.indexOf('Selected tile'));

    const sourceSprite = createPixelSprite('Bounded source sheet', 32, 16);
    const tileset = createPixelTileset('Readable crops', sourceSprite.id, 16, 16, 2, 1);
    const editor = renderToStaticMarkup(createElement(TilesetSliceEditor, {
      palette: [],
      tileset,
      sourceSprite,
      selectedTileId: 0,
      onCommit: () => undefined,
    }));
    const describedBy = editor.match(/aria-describedby="([^"]+-legend)"/u)?.[1];
    expect(describedBy).toBeDefined();
    expect(editor).toContain(`id="${describedBy}" aria-label="Slice preview overlay legend"`);
    for (const field of ['Tile width', 'Tile height', 'Margin', 'Spacing']) expect(editor).toContain(`<span>${field}</span><input type="number"`);
  });

  it('renders complete long impact counts and explicit disabled action meaning without truncating categories', () => {
    const before = structuredClone(ordinaryImpact);
    const markup = renderToStaticMarkup(createElement(TilesetSliceReview, reviewProps()));
    expect(markup).toContain('aria-label="Re-slice impact" role="status"');
    expect(markup).toContain('Planned sheet: 1024 × 1024 · 1048576 tiles');
    expect(markup).toContain('<dt>Metadata tiles</dt><dd>1048575 of 1048576 preserved</dd>');
    expect(markup).toContain('<dt>Moved metadata</dt><dd>999999 reframed · 888888 renumbered</dd>');
    expect(markup).toContain('<dt>Dropped metadata</dt><dd>1 tiles · 12345 animation frames · 23456 collisions · 34567 properties · 45678 Wang colors · 56789 Wang assignments</dd>');
    expect(markup).not.toContain('tileset-reslice-ack');
    expect(markup).toContain('<button type="button" disabled="">Reset</button>');
    expect(markup).toContain('<button type="button" class="primary" disabled="">Apply re-slice</button>');
    expect(ordinaryImpact).toEqual(before);
  });

  it('keeps loss acknowledgment, remap, Reset, and Apply on distinct native callback routes', () => {
    const events: unknown[] = [];
    const before = structuredClone(ordinaryImpact);
    const tree = TilesetSliceReview(reviewProps({
      remap: 'tile-id',
      layoutChanged: true,
      requiresAcknowledgement: true,
      onRemapChange: (remap) => events.push(['remap', remap]),
      onAcknowledgedChange: (acknowledged) => events.push(['acknowledged', acknowledged]),
      onReset: () => events.push(['reset']),
      onApply: () => events.push(['apply']),
    }));
    const controls = descendantElements(tree).filter((element) => element.type === 'input' || element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    expect(controls.every((control) => control.props.tabIndex !== -1)).toBe(true);
    const radios = controls.filter((control) => control.type === 'input' && control.props.type === 'radio');
    const acknowledgement = controls.find((control) => control.type === 'input' && control.props.type === 'checkbox')!;
    const buttons = controls.filter((control) => control.type === 'button');
    const reset = buttons.find((button) => button.props.children === 'Reset')!;
    const apply = buttons.find((button) => button.props.children === 'Apply re-slice')!;
    expect(radios.map((radio) => radio.props.checked)).toEqual([false, true]);
    expect(acknowledgement.props.checked).toBe(false);
    expect(reset.props.disabled).toBe(false);
    expect(apply.props.disabled).toBe(true);
    (radios[0].props.onChange as () => void)();
    (acknowledgement.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    (reset.props.onClick as () => void)();

    const admitted = TilesetSliceReview(reviewProps({
      layoutChanged: true,
      requiresAcknowledgement: true,
      acknowledged: true,
      onApply: () => events.push(['apply']),
    }));
    const admittedApply = descendantElements(admitted).find((element) => element.type === 'button' && (element as ReactElement<Record<string, unknown>>).props.children === 'Apply re-slice') as ReactElement<Record<string, unknown>>;
    expect(admittedApply.props.disabled).toBe(false);
    (admittedApply.props.onClick as () => void)();
    expect(events).toEqual([
      ['remap', 'source-position'],
      ['acknowledged', true],
      ['reset'],
      ['apply'],
    ]);
    expect(ordinaryImpact).toEqual(before);
  });

  it('makes missing-source and planning errors explicit before every final action', () => {
    const tileset = createPixelTileset('Missing source review', 'missing-source', 16, 16, 2, 2);
    const markup = renderToStaticMarkup(createElement(TilesetSliceEditor, {
      palette: [],
      tileset,
      selectedTileId: 0,
      onCommit: () => undefined,
    }));
    expect(markup).toContain('class="tileset-reslice-error" role="alert"');
    expect(markup).toContain('<strong>Re-slice unavailable</strong>');
    expect(markup).toContain('The source sprite is missing, so this tileset cannot be re-sliced safely.');
    expect(markup).not.toContain('tileset-reslice-impact');
    expect(markup).not.toContain('tileset-reslice-ack');
    expect(markup).toContain('<button type="button" disabled="">Reset</button>');
    expect(markup).toContain('<button type="button" class="primary" disabled="">Apply re-slice</button>');
  });

  it('uses shared density floors, full wrapping, visible focus, and a later compact no-loss cascade', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const legacyOffset = styles.indexOf('.slice-legend { position: absolute;');
    const correctedOffset = styles.indexOf('/* Source-sheet re-slicing keeps every review decision legible before the existing explicit commit. */');
    const compactMediaOffset = styles.indexOf('@media (max-width: 1120px)', correctedOffset);
    const compactRuleOffset = styles.indexOf('.tileset-slice-editor .tileset-slice-grid, .slice-legend, .tileset-reslice-actions { grid-template-columns: minmax(0, 1fr); }', compactMediaOffset);
    expect(legacyOffset).toBeGreaterThanOrEqual(0);
    expect(correctedOffset).toBeGreaterThan(legacyOffset);
    expect(compactMediaOffset).toBeGreaterThan(correctedOffset);
    expect(compactRuleOffset).toBeGreaterThan(compactMediaOffset);
    expect(styles).toMatch(/\.tileset-slice-editor \.tileset-slice-grid input \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.slice-legend \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(styles).toMatch(/\.slice-legend i \{[^}]*width: var\(--ui-icon-secondary\)[^}]*height: var\(--ui-icon-secondary\)/);
    expect(styles).toContain('.slice-legend i.current { border-color: #514a58; border-style: dashed; }');
    expect(styles).toContain('.slice-legend i.draft { border-color: #765bd2; border-style: solid; }');
    expect(styles).toContain('.slice-legend i.selected { border: 3px double #b64059; }');
    expect(styles).toMatch(/\.slice-legend strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.slice-legend small \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tileset-remap-options label \{[^}]*min-height: var\(--ui-hit-primary\)/);
    expect(styles).toContain('.tileset-remap-options label:focus-within');
    expect(styles).toMatch(/\.tileset-reslice-impact dd \{[^}]*font-size: var\(--ui-type-label\)[^}]*overflow-wrap: anywhere/);
    expect(styles).toMatch(/\.tileset-reslice-error > span \{[^}]*font-size: var\(--ui-type-caption\)[^}]*overflow-wrap: anywhere/);
    expect(styles).toMatch(/\.tileset-reslice-ack \{[^}]*min-height: var\(--ui-hit-primary\)/);
    expect(styles).toMatch(/\.tileset-reslice-ack strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tileset-reslice-ack small \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tileset-reslice-actions button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.tileset-reslice-actions button:focus-visible');
    const correctedBlock = styles.slice(correctedOffset, compactMediaOffset);
    expect(correctedBlock).not.toContain('text-overflow: ellipsis');
    expect(correctedBlock).not.toContain('white-space: nowrap');
  });

  it('binds literal changelog, architecture, tracker, and testing truth to the presentation-only boundary', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('source-sheet re-slicing review');
    expect(architecture).toContain('full described legend with text plus distinct dashed/solid/double markers');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-02 checkpoint (2026-08-17)');
    expect(testing).toContain('Current source/headless tileset re-slicing review presentation checkpoint');
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain('Current grid');
      expect(truth).toContain('Draft grid');
      expect(truth).toContain('Selected tile');
      expect(truth).toContain('acknowledgment');
    }
    expect(tracker).toContain('UX-01 and MAP-02 remain Working');
    expect(testing).toContain('Packaged/native visual, pointer, keyboard, focus, screen-reader');
  });
});

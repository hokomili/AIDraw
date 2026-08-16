import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { WangSet } from '@aidraw/core';
import {
  WangSignatureEditor,
  WangSignatureFields,
} from '../../src/renderer/components/WangSignatureEditor';
import { WANG_SIGNATURE_SLOTS, withWangSignatureSlot } from '../../src/renderer/wang-signature';

const longColorName = 'Ancient moss-covered upper courtyard transition with rain-darkened stone';
const colors: WangSet['colors'] = [
  { id: 1, name: longColorName, color: '#456b3fff', tileId: 300, probability: 1 },
  { id: 2, name: 'Dry path', color: '#b58b5a', tileId: 301, probability: 0.5 },
];
const signature: WangSet['tiles'][number]['wangId'] = [1, 0, 2, 1, 0, 2, 1, 0];

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

describe('Wang signature editor', () => {
  it('keeps the canonical eight-slot clockwise order and changes only the addressed slot', () => {
    expect(WANG_SIGNATURE_SLOTS.map(({ index, label, kind, position }) => ({ index, label, kind, position }))).toEqual([
      { index: 0, label: 'Top edge', kind: 'edge', position: 'top' },
      { index: 1, label: 'Top-right corner', kind: 'corner', position: 'top-right' },
      { index: 2, label: 'Right edge', kind: 'edge', position: 'right' },
      { index: 3, label: 'Bottom-right corner', kind: 'corner', position: 'bottom-right' },
      { index: 4, label: 'Bottom edge', kind: 'edge', position: 'bottom' },
      { index: 5, label: 'Bottom-left corner', kind: 'corner', position: 'bottom-left' },
      { index: 6, label: 'Left edge', kind: 'edge', position: 'left' },
      { index: 7, label: 'Top-left corner', kind: 'corner', position: 'top-left' },
    ]);
    const source: WangSet['tiles'][number]['wangId'] = [1, 1, 1, 1, 1, 1, 1, 1];
    expect(withWangSignatureSlot(source, 5, 2)).toEqual([1, 1, 1, 1, 1, 2, 1, 1]);
    expect(source).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('renders a non-color-only spatial diagram, eight exact native controls, None, and unabridged authored names', () => {
    const markup = renderToStaticMarkup(createElement(WangSignatureEditor, {
      tileId: 300,
      wangId: signature,
      colors,
      onChange: () => undefined,
    }));
    expect(markup).toContain('Tile 300 Wang signature');
    expect(markup).toContain('Line markers identify edges; diamond markers identify corners. Slots 1–8 run clockwise from the top edge.');
    expect(markup).toContain('aria-label="Tile 300 Wang signature diagram. Line markers are edges, diamond markers are corners, and slots 1 through 8 run clockwise from the top edge."');
    expect(markup.match(/<select/g)).toHaveLength(8);
    expect(markup.match(/<option value="0"(?: selected="")?>None<\/option>/g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Tile 300, slot 1, Top edge, Wang color"');
    expect(markup).toContain('aria-label="Tile 300, slot 8, Top-left corner, Wang color"');
    expect(markup).toContain(`${longColorName} · color 1`);
    expect(markup).toContain(`Current: ${longColorName} · color 1`);
    expect(markup).toContain('Current: None');
    expect(markup.indexOf('1. Top edge')).toBeLessThan(markup.indexOf('2. Top-right corner'));
    expect(markup.indexOf('7. Left edge')).toBeLessThan(markup.indexOf('8. Top-left corner'));
  });

  it('routes pointer and keyboard selection through the same naturally focusable exact-slot controls', () => {
    const changes: Array<[number, number]> = [];
    const fields = WangSignatureFields({
      tileId: 300,
      wangId: signature,
      colors,
      onChange: (slot, colorId) => changes.push([slot, colorId]),
    });
    const selects = descendantElements(fields).filter((element) => element.type === 'select') as Array<ReactElement<{
      'aria-label': string;
      disabled?: boolean;
      tabIndex?: number;
      onChange(event: { currentTarget: { value: string }; nativeEvent?: { type: string } }): void;
    }>>;
    expect(selects).toHaveLength(8);
    expect(selects.every((select) => select.props.disabled !== true && select.props.tabIndex !== -1)).toBe(true);
    selects[0].props.onChange({ currentTarget: { value: '2' }, nativeEvent: { type: 'click' } });
    selects[7].props.onChange({ currentTarget: { value: '0' }, nativeEvent: { type: 'keydown' } });
    expect(changes).toEqual([[0, 2], [7, 0]]);
    expect(selects.map((select) => select.props['aria-label'])).toEqual([
      'Tile 300, slot 1, Top edge, Wang color',
      'Tile 300, slot 2, Top-right corner, Wang color',
      'Tile 300, slot 3, Right edge, Wang color',
      'Tile 300, slot 4, Bottom-right corner, Wang color',
      'Tile 300, slot 5, Bottom edge, Wang color',
      'Tile 300, slot 6, Bottom-left corner, Wang color',
      'Tile 300, slot 7, Left edge, Wang color',
      'Tile 300, slot 8, Top-left corner, Wang color',
    ]);
  });

  it('uses the established ordinary and compact density floors without clipping the selected long name', async () => {
    const [styles, app] = await Promise.all([
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
    ]);
    expect(styles).toMatch(/\.wang-signature-slot select \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.wang-signature-node strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.wang-signature-node small \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.wang-signature-fields { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(styles).toContain('.wang-signature-current > span { min-width: 0; white-space: normal; overflow-wrap: anywhere; }');
    expect(styles).toContain('button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible');
    expect(app).toContain('<WangSignatureEditor');
    expect(app).toContain('wangId={activeTileWangId}');
    expect(app).toContain('onChange={assignWangSlot}');
    expect(app).toContain('withWangSignatureSlot(activeTileWangId, slot, colorId)');
    expect(app).toContain('replaceWang(assignWangTile(tileset, activeWangSet.id');
    expect(app).toContain('if (!imageCollection) {\n      replace(next, label);');
    expect(app).toContain('planImageCollectionWangMutation(active, tileset, next)');
  });

  it('places the equal-specificity compact override after the ordinary two-column rule', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const ordinaryRule = '.wang-signature-fields { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));';
    const compactRule = '@media (max-width: 1120px) {\n  .wang-signature-fields { grid-template-columns: minmax(0, 1fr); }';
    const ordinaryOffset = styles.indexOf(ordinaryRule);
    const compactOffset = styles.indexOf(compactRule);
    expect(ordinaryOffset).toBeGreaterThanOrEqual(0);
    expect(compactOffset).toBeGreaterThan(ordinaryOffset);
  });

  it('binds durable claims to the exact source/headless visual and canonical boundary', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('line markers plus the word **Edge** and diamond markers plus **Corner**');
    expect(architecture).toContain('The tileset Wang signature editor is a renderer-only projection of that same eight-value tuple.');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-05 checkpoint');
    expect(tracker).toContain('packaged visual/assistive acceptance of the new diagram');
    expect(tracker).not.toContain('visual edge diagrams, and external fixtures remain');
    expect(testing).toContain('This checkpoint adds no schema, map-cell mutation, semantic-agent authority, signature generation');
    expect(testing).toContain('packaged/native visual, pointer, keyboard, screen-reader, RC, or stable-v1 acceptance');
  });
});

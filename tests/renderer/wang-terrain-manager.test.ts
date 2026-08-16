import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { WangSet } from '@aidraw/core';
import {
  WangTerrainSetEditor,
  WangTerrainSetList,
} from '../../src/renderer/components/WangTerrainManager';

const longSetName = 'Mountain foothills and rain-darkened courtyard transition terrain';
const longColorName = 'Ancient moss-covered upper courtyard transition with rain-darkened stone';
const sets: WangSet[] = [
  {
    id: 'terrain-mountain-courtyard',
    name: longSetName,
    type: 'mixed',
    colors: [
      { id: 7, name: longColorName, color: '#456b3fff', tileId: 300, probability: 0.75 },
      { id: 12, name: 'Dry path', color: '#b58b5a', tileId: 301, probability: 1 },
    ],
    tiles: [{ tileId: 300, wangId: [7, 0, 7, 0, 7, 0, 7, 0] }],
  },
  {
    id: 'terrain-water',
    name: 'Water',
    type: 'edge',
    colors: [{ id: 3, name: 'Deep water', color: '#334d88', tileId: 302, probability: 2 }],
    tiles: [],
  },
];

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

describe('Wang terrain set and color manager', () => {
  it('shows authored-order sets with exact IDs, full names, and non-color-only selected meaning', () => {
    const markup = renderToStaticMarkup(createElement(WangTerrainSetList, {
      sets,
      activeSetId: sets[0].id,
      onSelect: () => undefined,
    }));
    expect(markup).toContain('role="group" aria-label="Wang terrain sets"');
    expect(markup).toContain(`aria-label="Select Wang terrain set ${longSetName}, ID ${sets[0].id}, Mixed mode" aria-pressed="true"`);
    expect(markup).toContain('aria-label="Select Wang terrain set Water, ID terrain-water, Edge mode" aria-pressed="false"');
    expect(markup).toContain(`${longSetName}</strong><small>Set ID ${sets[0].id} · Mixed · 2 colors · 1 mapped tile`);
    expect(markup).toContain('Selected</span>');
    expect(markup).toContain('Select</span>');
    expect(markup.indexOf(longSetName)).toBeLessThan(markup.indexOf('Water'));
  });

  it('labels every native set/color control, probability, exact ID, and visible text delete action', () => {
    const markup = renderToStaticMarkup(createElement(WangTerrainSetEditor, {
      set: sets[0],
      children: createElement('div', null, 'Signature editor remains adjacent'),
      onRename: () => undefined,
      onChangeType: () => undefined,
      onChangeColor: () => undefined,
      onDeleteColor: () => undefined,
    }));
    expect(markup).toContain(`${longSetName}</strong><small>Selected set · ID ${sets[0].id}`);
    expect(markup).toContain('Mixed mode');
    expect(markup).toContain(`aria-label="Wang set ${sets[0].id} name"`);
    expect(markup).toContain(`aria-label="Wang set ${sets[0].id} mode"`);
    expect(markup).toContain(`role="group" aria-label="Colors in Wang set ${longSetName}, ID ${sets[0].id}"`);
    expect(markup).toContain(`${longColorName}</strong><small>Color ID 7`);
    expect(markup).toContain('<span>Color</span>');
    expect(markup).toContain('<span>Name</span>');
    expect(markup).toContain('<span>Probability</span>');
    expect(markup).toContain('aria-label="Wang color 7 value"');
    expect(markup).toContain('aria-label="Wang color 7 name"');
    expect(markup).toContain('aria-label="Wang color 7 probability"');
    expect(markup).toContain(`aria-label="Delete Wang color ${longColorName}, ID 7"`);
    expect(markup).toContain('Delete color 7');
    expect(markup).toContain('Signature editor remains adjacent');
  });

  it('routes authored-order selection and every edit through naturally focusable native controls', () => {
    const canonicalBefore = structuredClone(sets);
    const selections: string[] = [];
    const list = WangTerrainSetList({ sets, activeSetId: sets[0].id, onSelect: (id) => selections.push(id) });
    const setButtons = descendantElements(list).filter((element) => element.type === 'button') as Array<ReactElement<{
      disabled?: boolean;
      tabIndex?: number;
      onClick(): void;
    }>>;
    expect(setButtons).toHaveLength(2);
    expect(setButtons.every((button) => button.props.disabled !== true && button.props.tabIndex !== -1)).toBe(true);
    setButtons[1].props.onClick();
    expect(selections).toEqual([sets[1].id]);

    const events: unknown[] = [];
    const editor = WangTerrainSetEditor({
      set: sets[0],
      children: createElement('div'),
      onRename: (name) => events.push(['rename', name]),
      onChangeType: (type) => events.push(['type', type]),
      onChangeColor: (index, patch, label) => events.push(['color', index, patch, label]),
      onDeleteColor: (id) => events.push(['delete', id]),
    });
    const controls = descendantElements(editor).filter((element) => element.type === 'input' || element.type === 'select' || element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    expect(controls).toHaveLength(10);
    expect(controls.every((control) => control.props.disabled !== true && control.props.tabIndex !== -1)).toBe(true);

    const byLabel = (label: string) => controls.find((control) => control.props['aria-label'] === label)!;
    (byLabel(`Wang set ${sets[0].id} name`).props.onBlur as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '  Renamed set  ' } });
    (byLabel(`Wang set ${sets[0].id} mode`).props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: 'corner' } });
    (byLabel('Wang color 7 value').props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '#abcdef' } });
    (byLabel('Wang color 7 name').props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: 'New color name' } });
    (byLabel('Wang color 7 probability').props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '-2' } });
    (byLabel(`Delete Wang color ${longColorName}, ID 7`).props.onClick as () => void)();
    expect(events).toEqual([
      ['rename', 'Renamed set'],
      ['type', 'corner'],
      ['color', 0, { color: '#abcdef' }, 'Change Wang color'],
      ['color', 0, { name: 'New color name' }, 'Rename Wang color'],
      ['color', 0, { probability: 0 }, 'Change Wang probability'],
      ['delete', 7],
    ]);
    expect(sets).toEqual(canonicalBefore);
  });

  it('uses shared density floors, full-name wrapping, and a later compact reflow override', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.wang-set-row \{[^}]*min-height: var\(--ui-hit-primary\)[^}]*grid-template-columns: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.wang-set-swatch \{[^}]*width: var\(--ui-hit-secondary\); height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.wang-set-copy strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.wang-set-copy small \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.wang-set-copy strong, .wang-set-copy small { display: block; min-width: 0; white-space: normal; overflow-wrap: anywhere; }');
    expect(styles).toMatch(/\.wang-color-field input \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.wang-color-delete \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.wang-color-delete svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary); }');
    expect(styles).toMatch(/\.wang-color-card legend strong, \.wang-color-card legend small \{[^}]*white-space: normal; overflow-wrap: anywhere;/);
    const ordinaryOffset = styles.indexOf('.wang-set-fields { min-width: 0; margin-top: 8px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(88px, .55fr);');
    const compactOffset = styles.indexOf('@media (max-width: 1120px) {\n  .wang-signature-fields');
    expect(ordinaryOffset).toBeGreaterThanOrEqual(0);
    expect(compactOffset).toBeGreaterThan(ordinaryOffset);
    expect(styles.slice(compactOffset)).toContain('.wang-set-fields { grid-template-columns: minmax(0, 1fr); }');
    expect(styles.slice(compactOffset)).toContain('.wang-color-field.is-name { grid-column: 1 / -1; grid-row: 1; }');
    expect(styles).toMatch(/\.tileset-actions select,[\s\S]*?\.tileset-actions button,[\s\S]*?\{ min-height: var\(--ui-hit-secondary\); font-size: var\(--ui-type-caption\); \}/);
  });

  it('preserves active-set fallback, exact IDs/order, and canonical atlas/collection replacement wiring', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('tileset.wangSets.find((set) => set.id === selectedWangSetId) ?? tileset.wangSets[0]');
    expect(app).toContain('<WangTerrainSetList sets={tileset.wangSets} activeSetId={activeWangSet?.id} onSelect={setSelectedWangSetId} />');
    expect(app).toContain('<WangTerrainSetEditor');
    expect(app).toContain('onChangeColor={updateWangColor}');
    expect(app).toContain('`Add Wang color to set ${activeWangSet.name}, ID ${activeWangSet.id}`');
    expect(app).toContain('`Delete Wang terrain set ${activeWangSet.name}, ID ${activeWangSet.id}`');
    expect(app).toContain('replaceWang(upsertWangSet(tileset, nextSet), label)');
    expect(app).toContain('replaceWang(deleteWangColor(tileset, activeWangSet.id, colorId), "Delete Wang color")');
    expect(app).toContain('if (!imageCollection) {\n      replace(next, label);');
    expect(app).toContain('planImageCollectionWangMutation(active, tileset, next)');
    expect(app).toContain('expectedSpriteDependencies: plan.expectedSpriteDependencies');
  });

  it('binds durable claims to the exact presentation-only boundary', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('Wang terrain-set and color manager adjacent to the visual signature editor');
    expect(architecture).toContain('The adjacent Wang set/color manager is another renderer-only projection of the same canonical records.');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-05 checkpoint (2026-08-17)');
    expect(tracker).toContain('Its adjacent authored-order set/color manager now exposes full exact IDs/names');
    expect(tracker).toContain('packaged/native visual/pointer/keyboard/focus/screen-reader acceptance');
    expect(testing).toContain('The later adjacent-manager correction keeps authored order and exact fallback-selected set identity');
    expect(testing).toContain('This adds no confirmation-policy redesign, schema, semantic route, Wang synthesis');
  });
});

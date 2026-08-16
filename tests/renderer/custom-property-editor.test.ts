import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  CustomPropertyEditor,
} from '../../src/renderer/components/CustomPropertyEditor';
import {
  deleteCustomProperty,
  parseCustomPropertyDraft,
  setCustomProperty,
  type CustomPropertyAction,
  type CustomPropertyValue,
} from '../../src/renderer/custom-properties';

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

const retained = JSON.parse('{"first":"  exact text  ","__proto__":"safe","  spaced key  ":false,"long-key-that-must-remain-fully-recoverable":"a very long value that must remain fully recoverable without an ellipsis"}') as Record<string, CustomPropertyValue>;

function editor(overrides: Partial<Parameters<typeof CustomPropertyEditor>[0]> = {}) {
  return createElement(CustomPropertyEditor, {
    title: 'Map properties',
    scopeLabel: 'Map',
    properties: retained,
    nameDraft: '',
    valueDraft: '',
    onNameDraftChange: () => undefined,
    onValueDraftChange: () => undefined,
    onChange: () => undefined,
    ...overrides,
  });
}

describe('legacy custom-property presentation', () => {
  it('preserves the exact legacy lowercase-boolean, finite-number, and unchanged-text parser', () => {
    expect(parseCustomPropertyDraft('true')).toBe(true);
    expect(parseCustomPropertyDraft('false')).toBe(false);
    expect(parseCustomPropertyDraft('True')).toBe('True');
    expect(parseCustomPropertyDraft(' false ')).toBe(' false ');
    expect(parseCustomPropertyDraft(' 42 ')).toBe(42);
    expect(parseCustomPropertyDraft('0x10')).toBe(16);
    expect(parseCustomPropertyDraft('Infinity')).toBe('Infinity');
    expect(parseCustomPropertyDraft('   ')).toBe('   ');
    expect(parseCustomPropertyDraft('  exact text  ')).toBe('  exact text  ');
  });

  it('trims only submitted keys, preserves predecessor ordinary-key enumeration, and safely overwrites or exactly deletes exotic own keys', () => {
    const before = structuredClone(retained);
    expect(setCustomProperty(retained, '   ', 'ignored')).toBe(retained);
    const overwritten = setCustomProperty(retained, '  __proto__  ', 'false');
    expect(Object.keys(overwritten)).toEqual(Object.keys(retained));
    expect(Object.hasOwn(overwritten, '__proto__')).toBe(true);
    expect(overwritten.__proto__).toBe(false);
    expect(Object.getPrototypeOf(overwritten)).toBe(Object.prototype);

    const added = setCustomProperty(overwritten, '  new key  ', '  exact value  ');
    expect(Object.keys(added)).toEqual([...Object.keys(retained), 'new key']);
    expect(added['new key']).toBe('  exact value  ');
    const deleted = deleteCustomProperty(added, '  spaced key  ');
    expect(Object.keys(deleted)).toEqual(['first', '__proto__', 'long-key-that-must-remain-fully-recoverable', 'new key']);
    expect(Object.hasOwn(deleted, '  spaced key  ')).toBe(false);
    expect(retained).toEqual(before);
  });

  it('uses predecessor ECMAScript array-index enumeration instead of promising universal append order', () => {
    const indexed = JSON.parse('{"10":"ten","ordinary":"kept"}') as Record<string, CustomPropertyValue>;
    const before = structuredClone(indexed);
    const added = setCustomProperty(indexed, '2', 'two');
    expect(Object.entries(added)).toEqual([
      ['2', 'two'],
      ['10', 'ten'],
      ['ordinary', 'kept'],
    ]);
    expect(indexed).toEqual(before);
  });

  it('renders exact ordered key, type, and value meaning with native named controls and a clear empty state', () => {
    const markup = renderToStaticMarkup(editor());
    expect(markup).toContain('<span>Map properties</span><small>4</small>');
    expect(markup).toContain('<span>Name</span><input aria-label="Map property name"');
    expect(markup).toContain('<span>Value</span><input aria-label="Map property value"');
    expect(markup).toContain('role="list" aria-label="Map retained custom properties"');
    expect(markup).toContain('<strong>Property 1</strong>');
    expect(markup).toContain('<dt>Key</dt><dd><code>&quot;first&quot;</code></dd>');
    expect(markup).toContain('<dt>Type</dt><dd>string</dd>');
    expect(markup).toContain('<dt>Value</dt><dd><code>&quot;  exact text  &quot;</code></dd>');
    expect(markup).toContain('<code>&quot;__proto__&quot;</code>');
    expect(markup).toContain('<code>&quot;  spaced key  &quot;</code>');
    expect(markup).toContain('<dt>Type</dt><dd>boolean</dd>');
    expect(markup).toContain('a very long value that must remain fully recoverable without an ellipsis');
    expect(markup).toContain('<span>Delete property</span>');
    expect(markup.indexOf('&quot;first&quot;')).toBeLessThan(markup.indexOf('&quot;__proto__&quot;'));
    expect(markup.indexOf('&quot;__proto__&quot;')).toBeLessThan(markup.indexOf('&quot;  spaced key  &quot;'));

    const empty = renderToStaticMarkup(editor({
      title: 'Collision properties', scopeLabel: 'Collision', properties: {},
    }));
    expect(empty).toContain('role="status">No collision custom properties.</p>');
  });

  it('routes add, overwrite, and exact deletion while leaving source objects immutable and drafts surface-owned', () => {
    const before = structuredClone(retained);
    const changes: Array<{ properties: Record<string, CustomPropertyValue>; action: CustomPropertyAction }> = [];
    const names: string[] = [];
    const values: string[] = [];
    const tree = CustomPropertyEditor({
      title: 'Map properties', scopeLabel: 'Map', properties: retained,
      nameDraft: '  __proto__  ', valueDraft: 'false',
      onNameDraftChange: (value) => names.push(value),
      onValueDraftChange: (value) => values.push(value),
      onChange: (properties, action) => changes.push({ properties, action }),
    });
    const elements = descendantElements(tree);
    const buttons = elements.filter((element) => element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    const inputs = elements.filter((element) => element.type === 'input') as Array<ReactElement<Record<string, unknown>>>;
    expect(buttons.every((button) => button.props.type === 'button' && button.props.tabIndex !== -1)).toBe(true);
    expect(inputs.every((input) => input.props.tabIndex !== -1)).toBe(true);
    const byLabel = (label: string) => buttons.find((button) => button.props['aria-label'] === label)!;
    expect(byLabel('Overwrite map property __proto__')).toBeDefined();
    (byLabel('Overwrite map property __proto__').props.onClick as () => void)();
    (byLabel('Delete map property   spaced key  ').props.onClick as () => void)();
    expect(changes).toHaveLength(2);
    expect(changes[0].action).toBe('set');
    expect(Object.hasOwn(changes[0].properties, '__proto__')).toBe(true);
    expect(changes[0].properties.__proto__).toBe(false);
    expect(changes[1].action).toBe('delete');
    expect(Object.hasOwn(changes[1].properties, '  spaced key  ')).toBe(false);
    const addTree = CustomPropertyEditor({
      title: 'Map properties', scopeLabel: 'Map', properties: retained,
      nameDraft: '  fresh  ', valueDraft: '  exact value  ',
      onNameDraftChange: (value) => names.push(value),
      onValueDraftChange: (value) => values.push(value),
      onChange: (properties, action) => changes.push({ properties, action }),
    });
    const addButton = descendantElements(addTree).find((element) => element.type === 'button' && (element as ReactElement<Record<string, unknown>>).props['aria-label'] === 'Add map property fresh') as ReactElement<Record<string, unknown>>;
    (addButton.props.onClick as () => void)();
    expect(changes[2].action).toBe('set');
    expect(Object.keys(changes[2].properties)).toEqual([...Object.keys(retained), 'fresh']);
    expect(changes[2].properties.fresh).toBe('  exact value  ');
    expect(names).toEqual(['', '']);
    expect(values).toEqual(['', '']);
    expect(retained).toEqual(before);

    const addMarkup = renderToStaticMarkup(editor({ nameDraft: '  fresh  ', valueDraft: 'text' }));
    expect(addMarkup).toContain('aria-label="Add map property fresh"');
    expect(addMarkup).toContain('<span>Add property</span>');
  });

  it('binds all three exact App call sites to the existing complete replacement labels and guards', async () => {
    const [app, objectInspector, changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/TileMapObjectInspector.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(app.match(/<CustomPropertyEditor/g)).toHaveLength(3);
    for (const scope of ['Map', 'Tile', 'Collision']) expect(app).toContain(`scopeLabel="${scope}"`);
    expect(app).toContain('nameDraft={mapPropertyName}');
    expect(app).toContain('nameDraft={propertyName}');
    expect(app).toContain('nameDraft={collisionPropertyName}');
    expect(app).toContain('const [mapPropertyName, setMapPropertyName] = useState("")');
    expect(app).toContain('const [propertyName, setPropertyName] = useState("")');
    expect(app).toContain('const [collisionPropertyName, setCollisionPropertyName] = useState("")');
    expect(app).toContain('action === "set" ? "Set map property" : "Delete map property"');
    expect(app).toContain('action === "set" ? "Set tile property" : "Delete tile property"');
    expect(app).toContain('action === "set" ? "Set collision property" : "Delete collision property"');
    expect(app).toContain('entry.id === selectedCollision.id ? { ...entry, properties } : entry');
    expect(app).toContain('<MapSetupDisclosure');
    expect(app).toContain('expectedRevision: asset.revision');
    expect(app).toContain('expectedRevision: tileset.revision');
    expect(app).toContain('expectedSpriteDependencies');
    expect(objectInspector).toContain('Tile object property type');
    expect(objectInspector).not.toContain('CustomPropertyEditor');
    expect(changelog).toContain('three legacy custom-property editors used by map metadata, selected-tile metadata, and selected-collision metadata');
    expect(architecture).toContain('share one renderer-only controlled presentation, not a property schema or canonical operation');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-03/MAP-04/MAP-07 checkpoint (2026-08-17)');
    expect(testing).toContain('Current source/headless custom-property presentation checkpoint');
    expect(testing).toContain('only lowercase `true`/`false` become boolean');
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain('Object.entries');
      expect(truth).toContain('array-index');
    }
    expect(changelog).not.toContain('new keys append');
    expect(testing).not.toContain('a new key appends');
  });

  it('uses shared density and icon floors with a later compact no-loss cascade', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.custom-property-field input \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.custom-property-set \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.custom-property-entry-heading button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.custom-property-set svg, .custom-property-entry-heading button svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(styles).toContain('.custom-property-details dd { min-width: 0; margin: 3px 0 0; color: var(--ink); font-size: var(--ui-type-label); line-height: 1.4; overflow-wrap: anywhere; white-space: pre-wrap; }');
    expect(styles).not.toContain('.custom-property-details dd { overflow: hidden;');
    const ordinaryOffset = styles.indexOf('.custom-property-fields { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    const compactMediaOffset = styles.indexOf('@media (max-width: 1120px) {\n  .wang-signature-fields', ordinaryOffset);
    const compactOffset = styles.indexOf('.custom-property-fields, .custom-property-details { grid-template-columns: minmax(0, 1fr); }', compactMediaOffset);
    expect(ordinaryOffset).toBeGreaterThanOrEqual(0);
    expect(compactMediaOffset).toBeGreaterThan(ordinaryOffset);
    expect(compactOffset).toBeGreaterThan(compactMediaOffset);
    expect(styles.slice(compactMediaOffset)).toContain('.custom-property-entry-heading button { width: 100%; }');
  });
});

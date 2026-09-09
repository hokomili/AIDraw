import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TilemapStorageChoice } from '../../src/renderer/components/PixelProjectSizing';

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

function rule(styles: string, selector: string, after = 0): { block: string; offset: number } {
  const offset = styles.indexOf(selector, after);
  if (offset < 0) throw new Error(`Missing CSS selector ${selector}`);
  const open = styles.indexOf('{', offset);
  const close = styles.indexOf('}', open);
  return { block: styles.slice(open + 1, close), offset };
}

function integerPx(value: string, label: string): number {
  const match = value.match(new RegExp(`${label}:\\s*(\\d+)px`));
  if (!match) throw new Error(`Missing integer pixel declaration ${label}`);
  return Number(match[1]);
}

describe('existing map storage mode presentation', () => {
  it('renders finite and sparse-infinite as explicit native alternatives with exact current geometry', () => {
    const finite = renderToStaticMarkup(createElement(TilemapStorageChoice, {
      context: 'existing',
      infinite: false,
      width: 1_048_576,
      height: 98_765,
      tileWidth: 1_024,
      tileHeight: 513,
      orientation: 'isometric',
      onChange: () => undefined,
    }));
    expect(finite).toContain('class="tilemap-storage-choice map-geometry-storage-choice"');
    expect(finite).toContain('<legend>Map storage and view mode</legend>');
    expect(finite).toMatch(/aria-label="Use finite map mode"[^>]*name="existing-map-storage" checked=""/u);
    expect(finite).toContain('aria-label="Use sparse infinite map mode"');
    expect(finite).toContain('aria-describedby="existing-map-storage-finite-description existing-map-storage-geometry-review"');
    expect(finite).toContain('aria-describedby="existing-map-storage-infinite-description existing-map-storage-geometry-review"');
    expect(finite).toContain('id="existing-map-storage-finite-description"');
    expect(finite).toContain('id="existing-map-storage-infinite-description"');
    expect(finite).toContain('id="existing-map-storage-geometry-review"');
    expect(finite).toMatch(/<strong>Finite map<\/strong><small[^>]*>1048576 × 98765 current cells form the complete addressed map\. Painting stays inside these bounds\.<\/small>/u);
    expect(finite).toMatch(/<strong>Sparse infinite map<\/strong><small[^>]*>The 1048576 × 98765 current extent remains the initial view; painted regions beyond it use 32 × 32 chunks\.<\/small>/u);
    expect(finite).toContain('<strong>Current map geometry</strong><span>Isometric · 1048576 × 98765 current cells · 1024 × 513 px tiles</span>');
    expect(finite.match(/>Selected<\/span>/gu)).toHaveLength(1);
    expect(finite.match(/>Available<\/span>/gu)).toHaveLength(1);

    const sparse = renderToStaticMarkup(createElement(TilemapStorageChoice, {
      context: 'existing',
      infinite: true,
      width: 32,
      height: 24,
      tileWidth: 16,
      tileHeight: 8,
      orientation: 'orthogonal',
      onChange: () => undefined,
    }));
    expect(sparse).toMatch(/aria-label="Use sparse infinite map mode"[^>]*name="existing-map-storage" checked=""/u);
    expect(sparse).toContain('Orthogonal · 32 × 24 current cells · 16 × 8 px tiles');
  });

  it('routes each exact boolean without mutating the observed geometry', () => {
    const geometry = Object.freeze({ width: 640, height: 360, tileWidth: 32, tileHeight: 16, orientation: 'orthogonal' as const });
    const events: boolean[] = [];
    const tree = TilemapStorageChoice({
      context: 'existing',
      infinite: false,
      ...geometry,
      onChange: (infinite) => events.push(infinite),
    });
    const radios = descendantElements(tree).filter((element) => element.type === 'input') as Array<ReactElement<Record<string, unknown>>>;
    expect(radios.map((radio) => radio.props.name)).toEqual(['existing-map-storage', 'existing-map-storage']);
    expect(radios.map((radio) => radio.props.checked)).toEqual([true, false]);
    expect(radios.map((radio) => radio.props['aria-label'])).toEqual(['Use finite map mode', 'Use sparse infinite map mode']);
    (radios[1]?.props.onChange as () => void)();
    (radios[0]?.props.onChange as () => void)();
    expect(events).toEqual([true, false]);
    expect(geometry).toEqual({ width: 640, height: 360, tileWidth: 32, tileHeight: 16, orientation: 'orthogonal' });
  });

  it('keeps mode authority, activity labels, collection admission, disclosure, and package selectors on their predecessor routes', async () => {
    const [app, e2e] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../e2e/editor.spec.ts', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('context="existing"');
    expect(app).toContain('onChange={(infinite) => updateMapMode(');
    expect(app).toContain('{ ...asset, infinite }');
    expect(app).toContain('infinite ? "Enable infinite map" : "Use finite map"');
    expect(app).not.toContain('imageCollectionTilemapModeError');
    expect(app).toContain('const updateMapMode = (next: typeof asset, label: string) => updateAsset(next, label)');
    expect(app).toContain('kind: "pixel.asset.replace"');
    expect(app).toContain('expectedRevision: asset.revision');
    expect(app).toContain('updateMapMode({ ...asset, orientation: event.target.value as typeof asset.orientation }, "Change map orientation")');
    expect(app).toContain('summary={`${asset.infinite ? "Sparse infinite" : "Finite"}');
    expect(app).not.toContain('className="map-infinite-toggle"');
    expect(e2e).toContain("getByRole('radio', { name: 'Use sparse infinite map mode' })");
    expect(e2e).toContain('await infiniteToggle.check();');
    expect(e2e).not.toContain("locator('.map-infinite-toggle input')");
  });

  it('derives readable regular and compact geometry from the actual inspector, spacing, and cascade declarations', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const legacyOffset = styles.indexOf('.map-infinite-toggle {');
    const sizingOffset = styles.indexOf('/* Pixel creation and sprite resizing expose their exact dimensions and consequences');
    const options = rule(styles, '.tilemap-storage-options {', sizingOffset);
    const option = rule(styles, '.tilemap-storage-options > label {', options.offset);
    const existing = rule(styles, '.tilemap-setting-grid .map-geometry-storage-choice {', option.offset);
    const compactMediaOffset = styles.indexOf('@media (max-width: 1120px)', existing.offset);
    const compact = rule(styles, '.map-geometry-storage-choice .tilemap-storage-options {', compactMediaOffset);
    expect(sizingOffset).toBeGreaterThan(legacyOffset);
    expect(options.offset).toBeGreaterThan(sizingOffset);
    expect(existing.offset).toBeGreaterThan(option.offset);
    expect(compactMediaOffset).toBeGreaterThan(existing.offset);
    expect(compact.offset).toBeGreaterThan(compactMediaOffset);
    expect(options.block).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(compact.block).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(existing.block).toContain('grid-column: 1 / -1');

    const root = rule(styles, ':root {').block;
    const regularInspector = integerPx(root, '--shell-sidebar-width');
    const compactInspector = integerPx(root, '--shell-sidebar-compact-width');
    const target = integerPx(root, '--ui-hit-secondary');
    const icon = integerPx(root, '--ui-icon-secondary');
    const settings = rule(styles, '.tilemap-settings {').block;
    const sidePadding = Number(settings.match(/padding:\s*0\s+(\d+)px/u)?.[1]);
    const optionGap = integerPx(options.block, 'gap');
    const cardPadding = Number(option.block.match(/padding:\s*(\d+)px/u)?.[1]);
    const cardGap = integerPx(option.block, 'gap');
    const regularAvailable = regularInspector - sidePadding * 2;
    const compactAvailable = compactInspector - sidePadding * 2;
    const regularTrack = (regularAvailable - optionGap) / 2;
    const compactTrack = compactAvailable;
    const regularCopy = regularTrack - cardPadding * 2 - icon - cardGap;
    const compactCopy = compactTrack - cardPadding * 2 - icon - cardGap;
    expect({ regularInspector, compactInspector, regularAvailable, compactAvailable }).toEqual({
      regularInspector: 318,
      compactInspector: 286,
      regularAvailable: 294,
      compactAvailable: 262,
    });
    expect({ regularTrack, compactTrack, regularCopy, compactCopy }).toEqual({
      regularTrack: 143.5,
      compactTrack: 262,
      regularCopy: 102.5,
      compactCopy: 221,
    });
    expect(regularTrack).toBeGreaterThanOrEqual(target);
    expect(compactTrack).toBeGreaterThanOrEqual(target);
    expect(regularCopy).toBeGreaterThan(96);
    expect(compactCopy).toBeGreaterThan(96);
    expect(option.block).toContain('min-height: var(--ui-hit-secondary)');
    const corrected = styles.slice(sizingOffset, styles.indexOf('@media (max-width: 680px)', sizingOffset));
    expect(corrected).toContain('.tilemap-storage-options > label:focus-within');
    expect(corrected).toContain('.tilemap-storage-options input { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(corrected).toContain('white-space: normal');
    expect(corrected).toContain('overflow-wrap: anywhere');
    expect(corrected).not.toMatch(/text-overflow:\s*ellipsis/u);
    expect(corrected).not.toMatch(/white-space:\s*nowrap/u);
  });

  it('binds literal documentation to presentation-only existing-map mode truth', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('UX-01/MAP-07/MAP-08 existing-map mode presentation correction');
    expect(architecture).toContain('Expanded existing-map geometry reuses the same renderer-only finite/sparse choice projection');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-07/MAP-08 checkpoint (2026-08-17)');
    expect(tracker).toContain('finite/sparse orthogonal/isometric maps');
    expect(testing).toContain('Prior source/headless existing-map mode presentation checkpoint');
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain('Finite map');
      expect(truth).toContain('Sparse infinite map');
      expect(truth).toContain('32 × 32');
      expect(truth).toContain('image-collection');
    }
    expect(testing).toContain('not packaged/native visual, pointer, keyboard, focus, screen-reader');
  });
});

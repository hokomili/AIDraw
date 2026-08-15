import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  MapSetupDisclosure,
} from '../../src/renderer/components/MapSetupDisclosure';
import { focusDisclosureTriggerBeforeCollapse } from '../../src/renderer/disclosure-focus';

describe('tilemap setup progressive disclosure', () => {
  it('renders one named keyboard-native route with truthful collapsed and expanded state', () => {
    const collapsed = renderToStaticMarkup(createElement(MapSetupDisclosure, {
      expanded: false,
      onExpandedChange: () => undefined,
      summary: 'Finite · orthogonal · 64×64 cells · 16×16 px',
      children: createElement('button', { type: 'button' }, 'Existing map action'),
    }));
    expect(collapsed).toContain('type="button"');
    expect(collapsed).toContain('aria-controls="tilemap-map-setup-controls"');
    expect(collapsed).toContain('aria-describedby="tilemap-map-setup-summary"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Show map setup"');
    expect(collapsed).toContain('id="tilemap-map-setup-summary"');
    expect(collapsed).toContain('Finite · orthogonal · 64×64 cells · 16×16 px');
    expect(collapsed).toContain('id="tilemap-map-setup-controls" hidden=""');
    expect(collapsed).toContain('Existing map action');

    const expanded = renderToStaticMarkup(createElement(MapSetupDisclosure, {
      expanded: true,
      onExpandedChange: () => undefined,
      summary: 'Sparse infinite · isometric · 32×24 cells · 32×16 px',
      children: createElement('button', { type: 'button' }, 'Existing map action'),
    }));
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('aria-label="Hide map setup"');
    expect(expanded).toContain('Sparse infinite · isometric · 32×24 cells · 32×16 px');
    expect(expanded).not.toContain('id="tilemap-map-setup-controls" hidden=""');
  });

  it('moves focus to the disclosure trigger only when collapsing from inside its content', () => {
    const focus = vi.fn();
    expect(focusDisclosureTriggerBeforeCollapse(true, true, focus)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    focus.mockClear();
    expect(focusDisclosureTriggerBeforeCollapse(true, false, focus)).toBe(false);
    expect(focusDisclosureTriggerBeforeCollapse(false, true, focus)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps the primary layer list outside disclosure while reusing density and workspace state', async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('expanded={mapSetupExpanded}');
    expect(app).toContain('mapSetupExpanded: expanded');
    expect(app).toContain('setWorkspaceLayoutPreferences({ ...state.workspaceLayoutPreferences, mapSetupExpanded: expanded });');
    expect(app).toContain('asset.infinite ? "Sparse infinite" : "Finite"');
    expect(app).toMatch(/<\/div><\/MapSetupDisclosure>\}\s*<div className="panel-list layer-list">/u);
    expect(styles).toContain('.map-setup-disclosure-trigger { width: 100%; min-height: var(--ui-hit-primary);');
    expect(styles).toContain('color: var(--ink);');
    expect(styles).toContain('.map-setup-disclosure-trigger svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(styles).toContain('.map-setup-disclosure-copy strong { font-size: var(--ui-type-label); }');
    expect(styles).toContain('.map-setup-disclosure-copy small {');
  });
});

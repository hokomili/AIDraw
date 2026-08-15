import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TileMapObject } from '@aidraw/core';
import { TileMapObjectInspector } from '../../src/renderer/components/TileMapObjectInspector';

const object: TileMapObject = {
  id: 'door', type: 'tile', gid: 0xa000_0011, x: 12.5, y: 31, width: 24, height: 32, rotation: 15,
  name: 'Door', className: 'portal', properties: { target: 'north', cost: 3, open: true },
};

describe('tile-object inspector', () => {
  it('renders fixed identity with bounded geometry, metadata, and typed property controls', () => {
    const markup = renderToStaticMarkup(createElement(TileMapObjectInspector, {
      object,
      identity: 'Actors · tile 0 · D+H',
      onReplace: () => undefined,
      onInvalid: () => undefined,
    }));
    expect(markup).toContain('Actors · tile 0 · D+H');
    for (const label of ['Tile object X', 'Tile object Y', 'Tile object width', 'Tile object height', 'Tile object clockwise rotation', 'Tile object name', 'Tile object class']) expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain('Tile object property type');
    expect(markup).toContain('<option value="string" selected="">String</option>');
    expect(markup).toContain('<option value="number">Number</option>');
    expect(markup).toContain('<option value="boolean">Boolean</option>');
    expect(markup).toContain('target'); expect(markup).toContain('string · north');
    expect(markup).toContain('number · 3'); expect(markup).toContain('boolean · true');
    expect(markup).not.toContain('Tile object GID"');
    expect(markup).not.toContain('polygon');
  });

  it('disables every editing action when the exact layer is not writable', () => {
    const markup = renderToStaticMarkup(createElement(TileMapObjectInspector, {
      object,
      identity: 'Unresolved raw GID 2684354577',
      disabled: true,
      onReplace: () => undefined,
      onInvalid: () => undefined,
    }));
    expect(markup).toContain('Unresolved raw GID 2684354577');
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThan(8);
  });

  it('renders imported exotic property keys without normalizing or dropping them', () => {
    const properties = JSON.parse('{"__proto__":"safe","  spaced  ":"exact"," ":true}') as TileMapObject['properties'];
    const markup = renderToStaticMarkup(createElement(TileMapObjectInspector, {
      object: { ...object, properties },
      identity: 'Actors · tile 0 · ordinary',
      onReplace: () => undefined,
      onInvalid: () => undefined,
    }));
    expect(markup).toContain('__proto__');
    expect(markup).toContain('string · safe');
    expect(markup).toContain('<strong>  spaced  </strong>');
    expect(markup).toContain('string · exact');
    expect(markup).toContain('<strong> </strong>');
    expect(markup).toContain('boolean · true');
  });
});

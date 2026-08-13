import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset } from '@aidraw/core';
import {
  MAX_TILED_EXPORT_COMPANIONS,
  expectedExportArtifactIdentity,
  planTiledExportCompanions,
  plannedExportCompanionPaths,
} from '@main/export-artifact-policy';

function tiledDocument(names: string[]) {
  const document = createPixelDocument('project', 'Tiled companion policy');
  const sprite = createPixelSprite('Shared source', 1, 1);
  const tilesets = names.map((name, index) => {
    const tileset = createPixelTileset(name, sprite.id, 1, 1, 1, 1);
    tileset.id = `tileset-${index}`;
    tileset.firstGid = index + 1;
    return tileset;
  });
  const map = createPixelTilemap('Map');
  map.id = 'map';
  map.tilesetIds = tilesets.map((tileset) => tileset.id);
  document.pixelAssets = { [sprite.id]: sprite, ...Object.fromEntries(tilesets.map((tileset) => [tileset.id, tileset])), [map.id]: map };
  document.assetIds = [sprite.id, ...tilesets.map((tileset) => tileset.id), map.id];
  document.activeAssetId = map.id;
  return { document, map, sprite, tilesets };
}

describe('Tiled export artifact policy', () => {
  it('allocates deterministic case-and-normalization-unique companion names in canonical tileset order', () => {
    const { document } = tiledDocument(['Terrain/Day', 'terrain:day', 'Terrain-Day (2)', 'Cafe\u0301', 'Caf\u00e9']);
    const names = [
      'Terrain-Day.png',
      'terrain-day (2).png',
      'Terrain-Day (2) (2).png',
      'Cafe\u0301.png',
      'Caf\u00e9 (2).png',
    ];
    expect(planTiledExportCompanions(document)?.map((entry) => entry.name)).toEqual(names);
    expect(planTiledExportCompanions(document)?.map((entry) => entry.name)).toEqual(names);
    expect(expectedExportArtifactIdentity(document, 'tiled-json')?.companions?.map((entry) => entry.name)).toEqual(names);
    expect(plannedExportCompanionPaths(document, 'tiled-json', '/exports/map.tmj')).toEqual(names.map((name) => `/exports/${name}`));
  });

  it('admits the exact utility-member boundary and rejects the next image without rendering', () => {
    const names = Array.from({ length: MAX_TILED_EXPORT_COMPANIONS }, (_, index) => `Tileset ${index}`);
    const { document, map, sprite, tilesets } = tiledDocument(names);
    expect(planTiledExportCompanions(document)).toHaveLength(MAX_TILED_EXPORT_COMPANIONS);

    const excess = createPixelTileset('Excess tileset', sprite.id, 1, 1, 1, 1);
    excess.id = 'tileset-excess';
    document.pixelAssets[excess.id] = excess;
    document.assetIds.splice(-1, 0, excess.id);
    map.tilesetIds = [...tilesets.map((tileset) => tileset.id), excess.id];
    expect(() => planTiledExportCompanions(document)).toThrow('4,096-companion-image safety limit');
  });
});

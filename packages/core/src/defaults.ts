import type {
  AIDrawDocument,
  IllustrationDocument,
  IllustrationLayer,
  PaletteEntry,
  PixelAsset,
  PixelDocument,
  PixelLayer,
  PixelSprite,
  PixelTileset,
  PixelTilemap,
  TilemapLayer,
} from './model';
import { HUMAN_ACTOR } from './model';
import { createId, nowIso } from './ids';

export const DEFAULT_PALETTE: PaletteEntry[] = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'ink', name: 'Ink', color: '#27213c' },
  { id: 'plum', name: 'Plum', color: '#6c3b78' },
  { id: 'berry', name: 'Berry', color: '#c04a7a' },
  { id: 'coral', name: 'Coral', color: '#ff6b7a' },
  { id: 'peach', name: 'Peach', color: '#ffb38a' },
  { id: 'cream', name: 'Cream', color: '#fff1c7' },
  { id: 'mint', name: 'Mint', color: '#9be3c2' },
  { id: 'teal', name: 'Teal', color: '#31a6a0' },
  { id: 'ocean', name: 'Ocean', color: '#3978b8' },
  { id: 'sky', name: 'Sky', color: '#74c7ec' },
  { id: 'lavender', name: 'Lavender', color: '#ad8ee6' },
  { id: 'white', name: 'White', color: '#fffdf7' },
  { id: 'gray', name: 'Gray', color: '#a29bab' },
  { id: 'moss', name: 'Moss', color: '#6d9b67' },
  { id: 'gold', name: 'Gold', color: '#e5b84b' },
];

function baseDocument(name: string) {
  const timestamp = nowIso();
  return {
    schemaVersion: 1 as const,
    id: createId('doc'),
    revision: 0,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    dirty: false,
    assets: {},
    activity: [],
    provenance: [],
  };
}

function baseLayer(name: string) {
  const timestamp = nowIso();
  return {
    id: createId('layer'),
    revision: 0,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
  };
}

export function createIllustrationDocument(name = 'Untitled illustration'): IllustrationDocument {
  const vectorLayer: IllustrationLayer = {
    ...baseLayer('Vector 1'),
    type: 'vector',
    objectIds: [],
  };
  const paintLayer: IllustrationLayer = {
    ...baseLayer('Paint 1'),
    type: 'paint',
    tileSize: 256,
    tileAssetIds: {},
    strokes: [],
  };
  return {
    ...baseDocument(name),
    kind: 'illustration',
    artboard: {
      width: 1920,
      height: 1080,
      background: '#fffdf7',
      colorSpace: 'srgb',
      dpi: 96,
    },
    layerIds: [vectorLayer.id, paintLayer.id],
    layers: { [vectorLayer.id]: vectorLayer, [paintLayer.id]: paintLayer },
    objects: {},
  };
}

export function createPixelSprite(name: string, width = 64, height = 64): PixelSprite {
  const timestamp = nowIso();
  const layer: PixelLayer = {
    ...baseLayer('Pixels'),
    type: 'pixel',
  };
  const frameId = createId('frame');
  const celId = createId('cel');
  return {
    id: createId('sprite'),
    revision: 0,
    name,
    type: 'sprite',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    width,
    height,
    layerIds: [layer.id],
    layers: { [layer.id]: layer },
    frameIds: [frameId],
    frames: {
      [frameId]: {
        id: frameId,
        revision: 0,
        name: 'Frame 1',
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id,
        durationMs: 100,
      },
    },
    cels: {
      [celId]: {
        id: celId,
        revision: 0,
        name: 'Pixels · Frame 1',
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id,
        layerId: layer.id,
        frameId,
        chunks: {},
      },
    },
    tags: [],
    paletteOverrides: {},
  };
}

export function createPixelTilemap(name: string): PixelTilemap {
  const timestamp = nowIso();
  const layer: TilemapLayer = {
    id: createId('map-layer'),
    revision: 0,
    name: 'Ground',
    type: 'tile',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    visible: true,
    locked: false,
    opacity: 1,
    chunks: {},
    parallaxX: 1,
    parallaxY: 1,
  };
  return {
    id: createId('map'),
    revision: 0,
    name,
    type: 'tilemap',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    orientation: 'orthogonal',
    infinite: false,
    width: 64,
    height: 64,
    tileWidth: 16,
    tileHeight: 16,
    tilesetIds: [],
    layerIds: [layer.id],
    layers: { [layer.id]: layer },
    properties: {},
  };
}

export function createPixelTileset(name: string, spriteAssetId: string, tileWidth = 16, tileHeight = 16, columns = 4, rows = 4): PixelTileset {
  const timestamp = nowIso();
  return {
    id: createId('tileset'), revision: 0, name, type: 'tileset', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    firstGid: 1, tileWidth, tileHeight, columns, rows, spriteAssetId, tiles: {}, wangSets: [], transformations: { hFlip: true, vFlip: true, rotate: true },
  };
}

export function createPixelDocument(
  mode: 'sprite' | 'tilemap' | 'project' = 'sprite',
  name = mode === 'project' ? 'Untitled pixel project' : `Untitled pixel ${mode}`,
): PixelDocument {
  const primary: PixelAsset = mode === 'tilemap' ? createPixelTilemap('Map 1') : createPixelSprite('Sprite 1');
  return {
    ...baseDocument(name),
    kind: 'pixel',
    scope: mode === 'project' ? 'project' : 'standalone',
    standaloneType: mode === 'project' ? undefined : mode,
    palette: structuredClone(DEFAULT_PALETTE),
    assetIds: [primary.id],
    pixelAssets: { [primary.id]: primary },
    activeAssetId: primary.id,
    linkedAssets: [],
    conversionDefaults: {
      resample: 'area',
      paletteMetric: 'oklab',
      dithering: 'none',
      alphaThreshold: 0.5,
    },
  };
}

export function createDocument(kind: 'illustration' | 'sprite' | 'tilemap' | 'project'): AIDrawDocument {
  return kind === 'illustration' ? createIllustrationDocument() : createPixelDocument(kind);
}

import type { PixelCel, PixelChunk, PixelDocument, PixelSprite, PixelTilemap, PixelTileset, TilemapChunk } from './model';

export const PIXEL_CHUNK_SIZE = 32;
export const TILED_FLIP_HORIZONTAL = 0x8000_0000;
export const TILED_FLIP_VERTICAL = 0x4000_0000;
export const TILED_FLIP_DIAGONAL = 0x2000_0000;
export const TILED_GID_MASK = 0x0fff_ffff;

export function decodeTiledGid(raw: number): { gid: number; hFlip: boolean; vFlip: boolean; diagonal: boolean } {
  const value = raw >>> 0;
  return { gid: value & TILED_GID_MASK, hFlip: Boolean(value & TILED_FLIP_HORIZONTAL), vFlip: Boolean(value & TILED_FLIP_VERTICAL), diagonal: Boolean(value & TILED_FLIP_DIAGONAL) };
}

export function resolveTilesetForGid(document: PixelDocument, map: PixelTilemap, gid: number): { tileset: PixelTileset; localId: number } | undefined {
  const candidates = map.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset' && asset.firstGid <= gid).sort((a, b) => b.firstGid - a.firstGid);
  const tileset = candidates[0]; if (!tileset) return undefined;
  const localId = gid - tileset.firstGid; return localId >= 0 && localId < tileset.columns * tileset.rows ? { tileset, localId } : undefined;
}

function encodeBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function decodeBytes(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(data, 'base64'));
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeUint32(values: Uint32Array): string {
  return encodeBytes(new Uint8Array(values.buffer));
}

function decodeUint32(data: string): Uint32Array {
  const bytes = decodeBytes(data);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
  return new Uint32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

export function chunkCoordinate(value: number): number {
  return Math.floor(value / PIXEL_CHUNK_SIZE);
}

export function chunkKey(chunkX: number, chunkY: number): string {
  return `${chunkX},${chunkY}`;
}

export function createEmptyPixelChunk(chunkX: number, chunkY: number): PixelChunk {
  return {
    x: chunkX * PIXEL_CHUNK_SIZE,
    y: chunkY * PIXEL_CHUNK_SIZE,
    width: PIXEL_CHUNK_SIZE,
    height: PIXEL_CHUNK_SIZE,
    data: encodeBytes(new Uint8Array(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE)),
  };
}

export function readPixel(cel: PixelCel, x: number, y: number): number {
  if (!cel.chunks || typeof cel.chunks !== 'object') return 0;
  const chunkX = chunkCoordinate(x);
  const chunkY = chunkCoordinate(y);
  const chunk = cel.chunks[chunkKey(chunkX, chunkY)];
  if (!chunk) return 0;
  const localX = ((x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
  const localY = ((y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
  try {
    return decodeBytes(chunk.data)[localY * PIXEL_CHUNK_SIZE + localX] ?? 0;
  } catch {
    return 0;
  }
}

export function writePixels(
  cel: PixelCel,
  changes: Array<{ x: number; y: number; index: number }>,
): Array<{ x: number; y: number; index: number }> {
  if (!cel.chunks || typeof cel.chunks !== 'object') cel.chunks = {};
  const inverse: Array<{ x: number; y: number; index: number }> = [];
  const decoded = new Map<string, { chunk: PixelChunk; values: Uint8Array }>();

  for (const change of changes) {
    const chunkX = chunkCoordinate(change.x);
    const chunkY = chunkCoordinate(change.y);
    const key = chunkKey(chunkX, chunkY);
    let entry = decoded.get(key);
    if (!entry) {
      let chunk = cel.chunks[key] ?? createEmptyPixelChunk(chunkX, chunkY);
      let values: Uint8Array;
      try { values = decodeBytes(chunk.data); } catch { chunk = createEmptyPixelChunk(chunkX, chunkY); values = new Uint8Array(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE); }
      if (values.length !== PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE) { chunk = createEmptyPixelChunk(chunkX, chunkY); values = new Uint8Array(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE); }
      entry = { chunk, values };
      decoded.set(key, entry);
      cel.chunks[key] = chunk;
    }
    const localX = ((change.x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    const localY = ((change.y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    const offset = localY * PIXEL_CHUNK_SIZE + localX;
    inverse.push({ x: change.x, y: change.y, index: entry.values[offset] ?? 0 });
    entry.values[offset] = Math.max(0, Math.min(255, Math.round(change.index)));
  }

  for (const { chunk, values } of decoded.values()) chunk.data = encodeBytes(values);
  return inverse;
}

export function resizePixelSpriteCanvas(sprite: PixelSprite, width: number, height: number): PixelSprite {
  const nextWidth = Math.max(1, Math.min(8192, Math.round(width)));
  const nextHeight = Math.max(1, Math.min(8192, Math.round(height)));
  const resized = structuredClone(sprite);
  resized.width = nextWidth;
  resized.height = nextHeight;

  for (const cel of Object.values(resized.cels ?? {})) {
    const retained: Array<{ x: number; y: number; index: number }> = [];
    for (const chunk of Object.values(cel.chunks ?? {})) {
      const values = decodePixelChunk(chunk);
      for (let localY = 0; localY < chunk.height; localY += 1) {
        const y = chunk.y + localY;
        if (y < 0 || y >= nextHeight) continue;
        for (let localX = 0; localX < chunk.width; localX += 1) {
          const x = chunk.x + localX;
          if (x < 0 || x >= nextWidth) continue;
          const index = values[localY * chunk.width + localX] ?? 0;
          if (index !== 0) retained.push({ x, y, index });
        }
      }
    }
    cel.chunks = {};
    writePixels(cel, retained);
  }

  return resized;
}

export function createEmptyTilemapChunk(chunkX: number, chunkY: number): TilemapChunk {
  return {
    x: chunkX * PIXEL_CHUNK_SIZE,
    y: chunkY * PIXEL_CHUNK_SIZE,
    width: PIXEL_CHUNK_SIZE,
    height: PIXEL_CHUNK_SIZE,
    data: encodeUint32(new Uint32Array(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE)),
  };
}

export function readTile(chunk: TilemapChunk, x: number, y: number): number {
  const localX = ((x - chunk.x) % PIXEL_CHUNK_SIZE + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
  const localY = ((y - chunk.y) % PIXEL_CHUNK_SIZE + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
  return decodeUint32(chunk.data)[localY * PIXEL_CHUNK_SIZE + localX] ?? 0;
}

export function writeTiles(
  chunks: Record<string, TilemapChunk>,
  changes: Array<{ x: number; y: number; gid: number }>,
): Array<{ x: number; y: number; gid: number }> {
  const inverse: Array<{ x: number; y: number; gid: number }> = [];
  const decoded = new Map<string, { chunk: TilemapChunk; values: Uint32Array }>();
  for (const change of changes) {
    const chunkX = chunkCoordinate(change.x);
    const chunkY = chunkCoordinate(change.y);
    const key = chunkKey(chunkX, chunkY);
    let entry = decoded.get(key);
    if (!entry) {
      const chunk = chunks[key] ?? createEmptyTilemapChunk(chunkX, chunkY);
      entry = { chunk, values: decodeUint32(chunk.data) };
      decoded.set(key, entry);
      chunks[key] = chunk;
    }
    const localX = ((change.x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    const localY = ((change.y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
    const offset = localY * PIXEL_CHUNK_SIZE + localX;
    inverse.push({ x: change.x, y: change.y, gid: entry.values[offset] ?? 0 });
    entry.values[offset] = Math.max(0, Math.round(change.gid));
  }
  for (const { chunk, values } of decoded.values()) chunk.data = encodeUint32(values);
  return inverse;
}

export function decodePixelChunk(chunk: PixelChunk): Uint8Array {
  return decodeBytes(chunk.data);
}

export function decodeTilemapChunk(chunk: TilemapChunk): Uint32Array {
  return decodeUint32(chunk.data);
}

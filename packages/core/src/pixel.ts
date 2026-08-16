import type { PixelCel, PixelChunk, PixelDocument, PixelSprite, PixelTilemap, PixelTileset, TilemapChunk } from './model';
import type { PixelIndexRun, TileGidRun } from './operations';

export const PIXEL_CHUNK_SIZE = 32;
export const TILED_FLIP_HORIZONTAL = 0x8000_0000;
export const TILED_FLIP_VERTICAL = 0x4000_0000;
export const TILED_FLIP_DIAGONAL = 0x2000_0000;
export const TILED_GID_MASK = 0x0fff_ffff;

export interface TiledTileTransformMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
}

export function decodeTiledGid(raw: number): { gid: number; hFlip: boolean; vFlip: boolean; diagonal: boolean } {
  const value = raw >>> 0;
  return { gid: value & TILED_GID_MASK, hFlip: Boolean(value & TILED_FLIP_HORIZONTAL), vFlip: Boolean(value & TILED_FLIP_VERTICAL), diagonal: Boolean(value & TILED_FLIP_DIAGONAL) };
}

export function encodeTiledGid(gid: number, transforms: { hFlip?: boolean; vFlip?: boolean; diagonal?: boolean } = {}): number {
  if (!Number.isInteger(gid) || gid < 0 || gid > TILED_GID_MASK) throw new Error('Tiled GIDs must be integers inside the 28-bit tile range.');
  return (gid | (transforms.hFlip ? TILED_FLIP_HORIZONTAL : 0) | (transforms.vFlip ? TILED_FLIP_VERTICAL : 0) | (transforms.diagonal ? TILED_FLIP_DIAGONAL : 0)) >>> 0;
}

/** Maps a centered tile using Tiled's diagonal-first, then horizontal/vertical flip order. */
export function tiledTileTransformMatrix(transforms: { hFlip?: boolean; vFlip?: boolean; diagonal?: boolean }): TiledTileTransformMatrix {
  const horizontal = transforms.hFlip ? -1 : 1;
  const vertical = transforms.vFlip ? -1 : 1;
  if (!transforms.diagonal) return { a: horizontal, b: 0, c: 0, d: vertical };
  return { a: 0, b: -vertical, c: -horizontal, d: 0 };
}

export function resolveTilesetForGid(document: PixelDocument, map: PixelTilemap, gid: number): { tileset: PixelTileset; localId: number } | undefined {
  const candidates = map.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset' && asset.firstGid <= gid).sort((a, b) => b.firstGid - a.firstGid);
  const tileset = candidates[0]; if (!tileset) return undefined;
  const localId = gid - tileset.firstGid; return tilesetHasLocalId(tileset, localId) ? { tileset, localId } : undefined;
}

export function isImageCollectionTileset(tileset: PixelTileset): boolean {
  return tileset.spriteAssetId === undefined;
}

export function tilesetHasLocalId(tileset: PixelTileset, localId: number): boolean {
  if (!Number.isSafeInteger(localId) || localId < 0) return false;
  return isImageCollectionTileset(tileset)
    ? Boolean(tileset.tiles[localId]?.imageAssetId)
    : localId < tileset.columns * tileset.rows;
}

export function tilesetLocalIdSpan(tileset: PixelTileset): number {
  if (!isImageCollectionTileset(tileset)) return tileset.columns * tileset.rows;
  let span = 0;
  for (const tile of Object.values(tileset.tiles)) span = Math.max(span, tile.id + 1);
  return span;
}

export function nextTilesetFirstGid(tilesets: readonly PixelTileset[]): number {
  let next = 1;
  for (const tileset of tilesets) {
    const span = tilesetLocalIdSpan(tileset);
    if (!Number.isSafeInteger(span) || span < 1) throw new RangeError(`Tileset “${tileset.name}” has no valid local-ID range.`);
    const after = tileset.firstGid + span;
    if (!Number.isSafeInteger(after) || after > TILED_GID_MASK) throw new RangeError(`Tileset “${tileset.name}” leaves no room for another Tiled GID range.`);
    next = Math.max(next, after);
  }
  return next;
}

export function tilesetTileSourceAssetId(tileset: PixelTileset, localId: number): string | undefined {
  return isImageCollectionTileset(tileset) ? tileset.tiles[localId]?.imageAssetId : tileset.spriteAssetId;
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
  const writer = createPixelWriter(cel);
  const inverse = changes.map((change) => ({ x: change.x, y: change.y, index: writer.write(change.x, change.y, change.index) }));
  writer.flush();
  return inverse.reverse();
}

export function remapPixelCelIndices(cel: PixelCel, indexMap: readonly number[]): void {
  const changes: Array<{ x: number; y: number; index: number }> = [];
  for (const chunk of Object.values(cel.chunks ?? {})) {
    const values = decodePixelChunk(chunk);
    for (let offset = 0; offset < values.length; offset += 1) {
      const current = values[offset] ?? 0; const next = indexMap[current] ?? current;
      if (next === current) continue;
      changes.push({ x: chunk.x + offset % chunk.width, y: chunk.y + Math.floor(offset / chunk.width), index: next });
    }
  }
  if (changes.length) writePixels(cel, changes);
}

function createPixelWriter(cel: PixelCel) {
  if (!cel.chunks || typeof cel.chunks !== 'object') cel.chunks = {};
  const decoded = new Map<string, { chunk: PixelChunk; values: Uint8Array }>();
  const entryAt = (x: number, y: number) => {
    const chunkX = chunkCoordinate(x);
    const chunkY = chunkCoordinate(y);
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
    return entry;
  };
  return {
    write(x: number, y: number, index: number): number {
      const entry = entryAt(x, y);
      const localX = ((x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
      const localY = ((y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
      const offset = localY * PIXEL_CHUNK_SIZE + localX;
      const previous = entry.values[offset] ?? 0;
      entry.values[offset] = Math.max(0, Math.min(255, Math.round(index)));
      return previous;
    },
    flush(): void {
      for (const [key, { chunk, values }] of decoded) {
        if (values.some((value) => value !== 0)) chunk.data = encodeBytes(values);
        else delete cel.chunks[key];
      }
    },
  };
}

function appendPixelRun(runs: PixelIndexRun[], x: number, y: number, index: number): void {
  const previous = runs.at(-1);
  if (previous && previous.y === y && previous.index === index && previous.x + previous.length === x && previous.length < 65_536) previous.length += 1;
  else runs.push({ x, y, length: 1, index });
}

export function writePixelRuns(cel: PixelCel, runs: PixelIndexRun[]): PixelIndexRun[] {
  const writer = createPixelWriter(cel);
  const inverse: PixelIndexRun[] = [];
  for (const run of runs) for (let offset = 0; offset < run.length; offset += 1) {
    const x = run.x + offset;
    appendPixelRun(inverse, x, run.y, writer.write(x, run.y, run.index));
  }
  writer.flush();
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

export function readTileAt(chunks: Record<string, TilemapChunk>, x: number, y: number): number {
  const chunk = chunks[chunkKey(chunkCoordinate(x), chunkCoordinate(y))];
  return chunk ? readTile(chunk, x, y) : 0;
}

export function writeTiles(
  chunks: Record<string, TilemapChunk>,
  changes: Array<{ x: number; y: number; gid: number }>,
): Array<{ x: number; y: number; gid: number }> {
  const writer = createTileWriter(chunks);
  const inverse = changes.map((change) => ({ x: change.x, y: change.y, gid: writer.write(change.x, change.y, change.gid) }));
  writer.flush();
  return inverse.reverse();
}

function createTileWriter(chunks: Record<string, TilemapChunk>) {
  const decoded = new Map<string, { chunk: TilemapChunk; values: Uint32Array }>();
  const entryAt = (x: number, y: number) => {
    const chunkX = chunkCoordinate(x);
    const chunkY = chunkCoordinate(y);
    const key = chunkKey(chunkX, chunkY);
    let entry = decoded.get(key);
    if (!entry) {
      const chunk = chunks[key] ?? createEmptyTilemapChunk(chunkX, chunkY);
      entry = { chunk, values: decodeUint32(chunk.data) };
      decoded.set(key, entry);
      chunks[key] = chunk;
    }
    return entry;
  };
  return {
    write(x: number, y: number, gid: number): number {
      const entry = entryAt(x, y);
      const localX = ((x % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
      const localY = ((y % PIXEL_CHUNK_SIZE) + PIXEL_CHUNK_SIZE) % PIXEL_CHUNK_SIZE;
      const offset = localY * PIXEL_CHUNK_SIZE + localX;
      const previous = entry.values[offset] ?? 0;
      entry.values[offset] = Math.max(0, Math.round(gid));
      return previous;
    },
    flush(): void {
      for (const [key, { chunk, values }] of decoded) {
        if (values.some((value) => value !== 0)) chunk.data = encodeUint32(values);
        else delete chunks[key];
      }
    },
  };
}

function appendTileRun(runs: TileGidRun[], x: number, y: number, gid: number): void {
  const previous = runs.at(-1);
  if (previous && previous.y === y && previous.gid === gid && previous.x + previous.length === x && previous.length < 65_536) previous.length += 1;
  else runs.push({ x, y, length: 1, gid });
}

export function writeTileRuns(chunks: Record<string, TilemapChunk>, runs: TileGidRun[]): TileGidRun[] {
  const writer = createTileWriter(chunks);
  const inverse: TileGidRun[] = [];
  for (const run of runs) for (let offset = 0; offset < run.length; offset += 1) {
    const x = run.x + offset;
    appendTileRun(inverse, x, run.y, writer.write(x, run.y, run.gid));
  }
  writer.flush();
  return inverse;
}

export function decodePixelChunk(chunk: PixelChunk): Uint8Array {
  return decodeBytes(chunk.data);
}

export function decodeTilemapChunk(chunk: TilemapChunk): Uint32Array {
  return decodeUint32(chunk.data);
}

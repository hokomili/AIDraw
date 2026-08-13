export interface TileRenderChunk {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileRenderCell {
  x: number;
  y: number;
  raw: number;
}

/**
 * Sparse chunk records are storage, not z-order. Isometric maps use the
 * right-down order AIDraw writes to Tiled: top rows first, then left-to-right
 * within a row. Decode and retain one aligned chunk band at a time so the
 * ordering fix does not materialize the complete sparse map as cell objects.
 */
export function* isometricTileRenderCells<T extends TileRenderChunk>(
  chunks: readonly T[],
  decode: (chunk: T) => ArrayLike<number> | undefined,
): Generator<TileRenderCell> {
  const ordered = chunks.map((chunk, index) => ({ chunk, index }))
    .sort((left, right) => left.chunk.y - right.chunk.y || left.chunk.x - right.chunk.x || left.index - right.index);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].chunk.y === ordered[start].chunk.y) end += 1;
    const band = ordered.slice(start, end).flatMap(({ chunk }) => {
      const values = decode(chunk);
      return values?.length === chunk.width * chunk.height ? [{ chunk, values }] : [];
    });
    const bandHeight = band.reduce((maximum, { chunk }) => Math.max(maximum, chunk.height), 0);
    for (let localY = 0; localY < bandHeight; localY += 1) for (const { chunk, values } of band) {
      if (localY >= chunk.height) continue;
      for (let localX = 0; localX < chunk.width; localX += 1) {
        const raw = values[localY * chunk.width + localX] ?? 0;
        if (raw !== 0) yield { x: chunk.x + localX, y: chunk.y + localY, raw };
      }
    }
    start = end;
  }
}

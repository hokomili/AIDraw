import {
  isImageCollectionTileset,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { imageCollectionAuthoringTileIds } from '../../common/map-tile-authoring';

export interface CurrentMapTileControlProps {
  document: PixelDocument;
  map: PixelTilemap;
  tilesets: PixelTileset[];
  tilesetId?: string;
  tileIdDraft: string;
  onTilesetChange: (tilesetId: string) => void;
  onTileIdDraftChange: (value: string) => void;
}

export function CurrentMapTileControl({
  document,
  map,
  tilesets,
  tilesetId,
  tileIdDraft,
  onTilesetChange,
  onTileIdDraftChange,
}: CurrentMapTileControlProps) {
  const tileset = tilesets.find((entry) => entry.id === tilesetId);
  const collectionIds = tileset && isImageCollectionTileset(tileset)
    ? imageCollectionAuthoringTileIds(tileset)
    : [];
  const parsedTileId = tileIdDraft.trim() ? Number(tileIdDraft) : Number.NaN;
  const collectionTile = tileset && isImageCollectionTileset(tileset) && Number.isSafeInteger(parsedTileId)
    ? tileset.tiles[parsedTileId]
    : undefined;
  const collectionSource = collectionTile?.imageAssetId ? document.pixelAssets[collectionTile.imageAssetId] : undefined;
  const atlasTileAvailable = Boolean(tileset
    && !isImageCollectionTileset(tileset)
    && Number.isSafeInteger(parsedTileId)
    && parsedTileId >= 0
    && parsedTileId < tilesetLocalIdSpan(tileset));
  const summary = tileset && isImageCollectionTileset(tileset)
    ? collectionSource?.type === 'sprite'
      ? `Collection tile ${parsedTileId}: ${collectionSource.name}, ${collectionSource.width} × ${collectionSource.height} px. Sparse gaps are unavailable.`
      : `Collection tile ${tileIdDraft || '—'} is unavailable; choose an exact authored sparse ID.`
    : tileset && atlasTileAvailable
      ? `Atlas tile ${tileIdDraft || '—'}: ${tileset.tileWidth} × ${tileset.tileHeight} px source crop.`
      : tileset
        ? `Atlas tile ${tileIdDraft || '—'} is unavailable; choose an ID from 0 through ${Math.max(0, tilesetLocalIdSpan(tileset) - 1)}.`
      : 'No attached tileset is available for the Current tile choice.';

  return <div className="current-map-tile-control" role="group" aria-label="Current map tile">
    <select
      aria-label="Current tile tileset"
      aria-describedby="current-map-tile-summary"
      value={tileset?.id ?? ''}
      onChange={(event) => onTilesetChange(event.target.value)}
      title="Exact attached tileset used by ordinary tile painting and the built-in Current tile stamp"
    >
      <option value="" disabled>Attached tileset</option>
      {tilesets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{isImageCollectionTileset(entry) ? ' · image collection' : ' · atlas'}</option>)}
    </select>
    <label className="current-map-tile-id-control">
      <span>Tile ID</span>
      {tileset && isImageCollectionTileset(tileset)
        ? <select
            aria-label="Current tile local tile ID"
            aria-describedby="current-map-tile-summary"
            value={collectionIds.includes(parsedTileId) ? String(parsedTileId) : ''}
            onChange={(event) => onTileIdDraftChange(event.target.value)}
          >
            <option value="" disabled>Exact ID</option>
            {collectionIds.map((tileId) => {
              const sourceId = tileset.tiles[tileId].imageAssetId;
              const source = sourceId ? document.pixelAssets[sourceId] : undefined;
              const label = source?.type === 'sprite'
                ? `${tileId} · ${source.name} · ${source.width}×${source.height}`
                : `${tileId} · unavailable source`;
              return <option key={tileId} value={tileId}>{label}</option>;
            })}
          </select>
        : <input
            aria-label="Current tile local tile ID"
            aria-describedby="current-map-tile-summary"
            type="number"
            min={0}
            max={Math.max(0, tileset ? tilesetLocalIdSpan(tileset) - 1 : 0)}
            step={1}
            value={tileIdDraft}
            onChange={(event) => onTileIdDraftChange(event.target.value)}
          />}
    </label>
    <small id="current-map-tile-summary" aria-live="polite">{map.name}: {summary}</small>
  </div>;
}

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { illustrationAtTime, type AIDrawDocument } from '@aidraw/core';
import { MAX_STATIC_RASTER_SIDE } from '../common/static-raster';
import { renderIllustrationRegion, renderPixelAsset, renderTilemapRegion } from './render-document';
import { MAX_OBSERVATION_PNG_BYTES } from './utility-contract';

export const MAX_OBSERVATION_PIXELS = 4_194_304;
export const MAX_OBSERVATION_SIDE = MAX_STATIC_RASTER_SIDE;
export { MAX_OBSERVATION_PNG_BYTES } from './utility-contract';

export interface ObservationRequest {
  assetId?: string;
  frameId?: string;
  layerId?: string;
  region?: { x: number; y: number; width: number; height: number };
  scale: number;
  background: 'document' | 'transparent' | string;
  illustrationTimeMs?: number;
}

export type CaptureObservation = (
  document: AIDrawDocument,
  request: ObservationRequest,
  maxPixels?: number,
) => Promise<Record<string, unknown>>;

/** Render, crop, and encode one bounded MCP observation in an isolatable unit. */
export const captureObservation: CaptureObservation = async (
  document,
  request,
  maxPixels = MAX_OBSERVATION_PIXELS,
) => {
  let renderSource: () => Canvas | Promise<Canvas>;
  let renderRegionSource: ((region: { x: number; y: number; width: number; height: number }) => Canvas | Promise<Canvas>) | undefined;
  let sourceWidth: number;
  let sourceHeight: number;
  let assetId: string | undefined;
  let frameId: string | undefined;
  const { layerId } = request;
  if (document.kind === 'illustration') {
    if (request.assetId || request.frameId) return { error: 'invalid_observation_target', message: 'Illustration observations do not accept assetId or frameId.' };
    if (request.illustrationTimeMs !== undefined && request.illustrationTimeMs > document.animation.durationMs) return { error: 'animation_time_out_of_bounds', illustrationTimeMs: request.illustrationTimeMs, durationMs: document.animation.durationMs };
    if (layerId && !document.layers[layerId]) return { error: 'layer_not_found', layerId };
    sourceWidth = document.artboard.width;
    sourceHeight = document.artboard.height;
    const illustration = request.illustrationTimeMs === undefined ? document : illustrationAtTime(document, request.illustrationTimeMs);
    renderRegionSource = (region) => renderIllustrationRegion(illustration, region, layerId, request.background === 'document');
    renderSource = () => renderIllustrationRegion(illustration, { x: 0, y: 0, width: sourceWidth, height: sourceHeight }, layerId, request.background === 'document');
  } else {
    if (request.illustrationTimeMs !== undefined) return { error: 'invalid_observation_target', message: 'Pixel observations do not accept illustrationTimeMs.' };
    assetId = request.assetId ?? document.activeAssetId;
    const requestedAsset = document.pixelAssets[assetId];
    if (!requestedAsset) return { error: 'asset_not_found', assetId };
    const renderedAsset = requestedAsset.type === 'tileset' ? document.pixelAssets[requestedAsset.spriteAssetId] : requestedAsset;
    if (!renderedAsset || (renderedAsset.type !== 'sprite' && renderedAsset.type !== 'tilemap')) return { error: 'invalid_observation_target', message: 'The selected asset has no renderable sprite or tilemap source.', assetId };
    if (renderedAsset.type === 'sprite') {
      frameId = request.frameId ?? renderedAsset.frameIds[0];
      if (!frameId || !renderedAsset.frames[frameId]) return { error: 'frame_not_found', assetId, frameId };
      if (layerId && !renderedAsset.layers[layerId]) return { error: 'layer_not_found', assetId, layerId };
      sourceWidth = renderedAsset.width;
      sourceHeight = renderedAsset.height;
    } else {
      if (request.frameId) return { error: 'invalid_observation_target', message: 'Tilemap observations do not accept frameId.', assetId };
      if (layerId && !renderedAsset.layers[layerId]) return { error: 'layer_not_found', assetId, layerId };
      sourceWidth = renderedAsset.orientation === 'isometric'
        ? Math.max(1, Math.ceil((renderedAsset.width + renderedAsset.height) * renderedAsset.tileWidth / 2))
        : renderedAsset.width * renderedAsset.tileWidth;
      sourceHeight = renderedAsset.orientation === 'isometric'
        ? Math.max(1, Math.ceil((renderedAsset.width + renderedAsset.height) * renderedAsset.tileHeight / 2))
        : renderedAsset.height * renderedAsset.tileHeight;
      renderRegionSource = (region) => renderTilemapRegion(document, renderedAsset, region, layerId);
    }
    renderSource = () => renderPixelAsset(document, assetId, frameId, layerId);
  }

  const region = request.region ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  if (region.x + region.width > sourceWidth || region.y + region.height > sourceHeight) {
    return { error: 'region_out_of_bounds', region, source: { width: sourceWidth, height: sourceHeight }, guidance: 'Request a positive integer region fully contained by the selected render target.' };
  }
  const width = region.width * request.scale;
  const height = region.height * request.scale;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > MAX_OBSERVATION_SIDE || height > MAX_OBSERVATION_SIDE) {
    return { error: 'observation_dimensions_too_large', requested: { width, height }, limit: { side: MAX_OBSERVATION_SIDE }, guidance: 'Request a region and scale no larger than the per-side limit.' };
  }
  const outputPixels = width * height;
  if (!Number.isSafeInteger(outputPixels) || outputPixels > maxPixels) {
    return { error: 'observation_too_large', requested: { width, height, pixels: outputPixels }, limit: { pixels: maxPixels }, guidance: 'Request a smaller region or scale.' };
  }
  const source = await (renderRegionSource ? renderRegionSource(region) : renderSource());
  const canvas = createCanvas(width, height);
  try {
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    if (request.background.startsWith('#')) {
      context.fillStyle = request.background;
      context.fillRect(0, 0, width, height);
    }
    if (renderRegionSource) context.drawImage(source, 0, 0, region.width, region.height, 0, 0, width, height);
    else context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, width, height);
    const png = canvas.toBuffer('image/png');
    if (png.byteLength > MAX_OBSERVATION_PNG_BYTES) {
      return { error: 'observation_png_too_large', requested: { width, height, encodedBytes: png.byteLength }, limit: { encodedBytes: MAX_OBSERVATION_PNG_BYTES }, guidance: 'Request a smaller region or scale.' };
    }
    return {
      available: true,
      mimeType: 'image/png',
      width,
      height,
      scale: request.scale,
      region,
      background: request.background,
      assetId,
      frameId,
      layerId,
      illustrationTimeMs: request.illustrationTimeMs,
      data: png.toString('base64'),
    };
  } finally {
    source.width = 1; source.height = 1; canvas.width = 1; canvas.height = 1;
  }
};

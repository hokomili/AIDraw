import { isometricCoordinateFromScreen } from '../../common/isometric-projection';
import { orthogonalCoordinateFromScreen } from '../../common/orthogonal-projection';

export interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasLogicalSize {
  width: number;
  height: number;
}

export interface PixelViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface PixelCoordinate {
  x: number;
  y: number;
}

export interface TilemapObjectPointerGeometry {
  orientation: 'orthogonal' | 'isometric';
  mapHeight: number;
  tileWidth: number;
  tileHeight: number;
  layerTranslation: PixelCoordinate;
}

function clientPointToCanvas(clientX: number, clientY: number, bounds: CanvasBounds, logicalSize: CanvasLogicalSize) {
  const scaleX = bounds.width > 0 ? logicalSize.width / bounds.width : 1;
  const scaleY = bounds.height > 0 ? logicalSize.height / bounds.height : 1;
  return { x: (clientX - bounds.left) * scaleX, y: (clientY - bounds.top) * scaleY };
}

/**
 * Converts a browser pointer position into the canvas' logical pixel grid.
 * The bounds-to-logical scaling keeps input aligned even when Windows display
 * scaling, fractional layout, or a temporarily resized canvas changes its CSS
 * size independently from its drawing surface.
 */
export function clientPointToPixel(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
): PixelCoordinate {
  const canvas = clientPointToCanvas(clientX, clientY, bounds, logicalSize);

  return {
    x: Math.floor((canvas.x - view.offsetX) / view.scale),
    y: Math.floor((canvas.y - view.offsetY) / view.scale),
  };
}

export function clientPointToOrthogonalTile(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
  cellHeight: number,
): PixelCoordinate {
  const point = clientPointToOrthogonalCoordinate(clientX, clientY, bounds, logicalSize, view, cellHeight);
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

export function clientPointToOrthogonalCoordinate(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
  cellHeight: number,
): PixelCoordinate {
  const canvas = clientPointToCanvas(clientX, clientY, bounds, logicalSize);
  return orthogonalCoordinateFromScreen(canvas.x - view.offsetX, canvas.y - view.offsetY, view.scale, cellHeight);
}

export function clientPointToIsometricTile(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
  mapHeight: number,
  cellHeight: number,
): PixelCoordinate {
  const point = clientPointToIsometricCoordinate(clientX, clientY, bounds, logicalSize, view, mapHeight, cellHeight);
  return { x: Math.floor(point.x), y: Math.floor(point.y) };
}

export function clientPointToIsometricCoordinate(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
  mapHeight: number,
  cellHeight: number,
): PixelCoordinate {
  const canvas = clientPointToCanvas(clientX, clientY, bounds, logicalSize);
  const screenX = canvas.x - view.offsetX;
  const screenY = canvas.y - view.offsetY;
  return isometricCoordinateFromScreen(screenX, screenY, mapHeight, view.scale, cellHeight);
}

/**
 * Converts one pointer to the selected object layer's canonical map-pixel
 * anchor. The already-composed layer screen translation includes nested
 * offsets and parallax, so authoring and the shared render/hit contract invert
 * the same visible placement without changing map projection semantics.
 */
export function clientPointToTilemapObjectAnchor(
  clientX: number,
  clientY: number,
  bounds: CanvasBounds,
  logicalSize: CanvasLogicalSize,
  view: PixelViewport,
  geometry: TilemapObjectPointerGeometry,
): PixelCoordinate {
  const layerView = {
    ...view,
    offsetX: view.offsetX + geometry.layerTranslation.x,
    offsetY: view.offsetY + geometry.layerTranslation.y,
  };
  const cellHeight = view.scale * geometry.tileHeight / geometry.tileWidth;
  const coordinate = geometry.orientation === 'isometric'
    ? clientPointToIsometricCoordinate(clientX, clientY, bounds, logicalSize, layerView, geometry.mapHeight, cellHeight)
    : clientPointToOrthogonalCoordinate(clientX, clientY, bounds, logicalSize, layerView, cellHeight);
  return { x: coordinate.x * geometry.tileWidth, y: coordinate.y * geometry.tileHeight };
}

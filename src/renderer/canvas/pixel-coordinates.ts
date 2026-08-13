import { isometricCoordinateFromScreen } from '../../common/isometric-projection';

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

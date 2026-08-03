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
  const scaleX = bounds.width > 0 ? logicalSize.width / bounds.width : 1;
  const scaleY = bounds.height > 0 ? logicalSize.height / bounds.height : 1;
  const canvasX = (clientX - bounds.left) * scaleX;
  const canvasY = (clientY - bounds.top) * scaleY;

  return {
    x: Math.floor((canvasX - view.offsetX) / view.scale),
    y: Math.floor((canvasY - view.offsetY) / view.scale),
  };
}

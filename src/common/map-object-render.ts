import type { CollisionShape } from '@aidraw/core';

interface MapObjectCanvasContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  setLineDash(segments: number[]): void;
}

export interface MapObjectRenderOptions {
  selected?: boolean;
  /** Projected canvas units per canonical map-object pixel. */
  unitScale?: number;
}

/**
 * Draws the application-owned map-object overlay shared by the editor and
 * headless observation/export. The object remains metadata in Tiled output;
 * this function owns only AIDraw's visible canvas representation.
 */
export function drawMapObjectOverlay(
  context: MapObjectCanvasContext,
  object: CollisionShape,
  options: MapObjectRenderOptions = {},
): void {
  const selected = options.selected ?? false;
  const unitScale = Math.max(0.001, options.unitScale ?? 1);
  const width = object.width ?? 1;
  const height = object.height ?? 1;

  context.fillStyle = selected ? 'rgba(130,104,221,.22)' : 'rgba(49,166,160,.15)';
  context.strokeStyle = selected ? '#7454d8' : '#2b958e';
  context.lineWidth = (selected ? 2 : 1.25) / unitScale;
  context.setLineDash(object.type === 'polyline' ? [5 / unitScale, 3 / unitScale] : []);
  context.beginPath();
  if (object.type === 'rectangle') context.rect(object.x, object.y, width, height);
  else if (object.type === 'ellipse') context.ellipse(object.x + width / 2, object.y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
  else if (object.points?.length) {
    object.points.forEach((point, index) => {
      if (index) context.lineTo(object.x + point.x, object.y + point.y);
      else context.moveTo(object.x + point.x, object.y + point.y);
    });
    if (object.type === 'polygon') context.closePath();
  }
  if (object.type !== 'polyline') context.fill();
  context.stroke();
  context.setLineDash([]);

  if (selected && (object.type === 'rectangle' || object.type === 'ellipse')) {
    const handleSize = 8 / unitScale;
    context.fillStyle = '#fff';
    context.fillRect(object.x + width - handleSize / 2, object.y + height - handleSize / 2, handleSize, handleSize);
    context.strokeStyle = '#7454d8';
    context.strokeRect(object.x + width - handleSize / 2, object.y + height - handleSize / 2, handleSize, handleSize);
  }
  if (selected && object.points) {
    const radius = 4 / unitScale;
    for (const point of object.points) {
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(object.x + point.x, object.y + point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#7454d8';
      context.stroke();
    }
  }
}

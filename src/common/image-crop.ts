import type { ImageObject } from '@aidraw/core';

export interface CropRectangle { x: number; y: number; width: number; height: number }

function shiftLocalOrigin(object: ImageObject, localX: number, localY: number): ImageObject['transform'] {
  const angle = object.transform.rotation * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle);
  const skewX = Math.tan(object.transform.skewX * Math.PI / 180); const skewY = Math.tan(object.transform.skewY * Math.PI / 180);
  const transformedX = object.transform.scaleX * localX + skewX * localY; const transformedY = skewY * localX + object.transform.scaleY * localY;
  return { ...object.transform, x: object.transform.x + cosine * transformedX - sine * transformedY, y: object.transform.y + sine * transformedX + cosine * transformedY };
}

export function imageSourceBounds(object: ImageObject): CropRectangle {
  const crop = object.crop; return { x: 0, y: 0, width: object.sourceWidth ?? Math.max(object.width, crop ? crop.x + crop.width : 0), height: object.sourceHeight ?? Math.max(object.height, crop ? crop.y + crop.height : 0) };
}

export function normalizedDisplayCrop(object: ImageObject, start: { x: number; y: number }, end: { x: number; y: number }, aspect?: number): CropRectangle {
  let left = Math.max(0, Math.min(object.width, Math.min(start.x, end.x))); let top = Math.max(0, Math.min(object.height, Math.min(start.y, end.y)));
  let right = Math.max(0, Math.min(object.width, Math.max(start.x, end.x))); let bottom = Math.max(0, Math.min(object.height, Math.max(start.y, end.y)));
  if (aspect && Number.isFinite(aspect) && aspect > 0 && right > left && bottom > top) {
    const width = right - left; const height = bottom - top;
    if (width / height > aspect) { const wanted = height * aspect; if (end.x >= start.x) right = Math.min(object.width, left + wanted); else left = Math.max(0, right - wanted); }
    else { const wanted = width / aspect; if (end.y >= start.y) bottom = Math.min(object.height, top + wanted); else top = Math.max(0, bottom - wanted); }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function cropImageObject(source: ImageObject, displayCrop: CropRectangle): ImageObject {
  const rect = normalizedDisplayCrop(source, displayCrop, { x: displayCrop.x + displayCrop.width, y: displayCrop.y + displayCrop.height });
  if (rect.width <= 0 || rect.height <= 0) throw new Error('An image crop must have positive width and height.');
  const base = source.crop ?? { x: 0, y: 0, width: source.sourceWidth ?? source.width, height: source.sourceHeight ?? source.height };
  const sourceBounds = imageSourceBounds(source); const object = structuredClone(source);
  object.transform = shiftLocalOrigin(source, rect.x, rect.y); object.width = rect.width; object.height = rect.height; object.sourceWidth = sourceBounds.width; object.sourceHeight = sourceBounds.height;
  object.crop = { x: base.x + rect.x / source.width * base.width, y: base.y + rect.y / source.height * base.height, width: rect.width / source.width * base.width, height: rect.height / source.height * base.height };
  return object;
}

export function cropImageToAspect(source: ImageObject, aspect: number): ImageObject {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('Crop aspect must be positive.');
  let width = source.width; let height = source.height; if (width / height > aspect) width = height * aspect; else height = width / aspect;
  return cropImageObject(source, { x: (source.width - width) / 2, y: (source.height - height) / 2, width, height });
}

export function setImageSourceCrop(source: ImageObject, crop: CropRectangle): ImageObject {
  const bounds = imageSourceBounds(source);
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (!values.every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
    throw new Error('Source crop coordinates must be finite, nonnegative, and have positive size.');
  }
  if (crop.x + crop.width > bounds.width || crop.y + crop.height > bounds.height) {
    throw new Error(`Source crop must fit inside ${bounds.width} × ${bounds.height} pixels.`);
  }
  if (crop.x === 0 && crop.y === 0 && crop.width === bounds.width && crop.height === bounds.height) {
    return resetImageCrop(source);
  }
  const base = source.crop ?? bounds;
  const scaleX = source.width / base.width;
  const scaleY = source.height / base.height;
  const object = structuredClone(source);
  object.transform = shiftLocalOrigin(source, (crop.x - base.x) * scaleX, (crop.y - base.y) * scaleY);
  object.width = crop.width * scaleX;
  object.height = crop.height * scaleY;
  object.sourceWidth = bounds.width;
  object.sourceHeight = bounds.height;
  object.crop = structuredClone(crop);
  return object;
}

export function resetImageCrop(source: ImageObject): ImageObject {
  if (!source.crop) return structuredClone(source);
  const bounds = imageSourceBounds(source); const scaleX = source.width / source.crop.width; const scaleY = source.height / source.crop.height; const object = structuredClone(source);
  object.transform = shiftLocalOrigin(source, -source.crop.x * scaleX, -source.crop.y * scaleY); object.width = bounds.width * scaleX; object.height = bounds.height * scaleY; object.sourceWidth = bounds.width; object.sourceHeight = bounds.height; delete object.crop;
  return object;
}

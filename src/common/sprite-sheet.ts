export const MAX_SPRITE_SHEET_FRAMES = 4_096;
export const MAX_SPRITE_SHEET_PREVIEW_WIDTH = 640;
export const MAX_SPRITE_SHEET_PREVIEW_HEIGHT = 480;

export interface SpriteSheetSliceOptions {
  frameWidth: number;
  frameHeight: number;
  marginX: number;
  marginY: number;
  spacingX: number;
  spacingY: number;
  frameCount?: number;
  order: 'rows' | 'columns';
  durationMs: number;
  trimTransparent: boolean;
  skipEmpty: boolean;
}

export interface SpriteSheetFrameRect {
  index: number;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteSheetLayout {
  columns: number;
  rows: number;
  availableFrames: number;
  frames: SpriteSheetFrameRect[];
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

export function spriteSheetPreviewDimensions(imageWidth: number, imageHeight: number): { width: number; height: number } {
  boundedInteger(imageWidth, 'Image width', 1, 8_192);
  boundedInteger(imageHeight, 'Image height', 1, 8_192);
  const scale = imageWidth >= imageHeight
    ? Math.min(1, MAX_SPRITE_SHEET_PREVIEW_WIDTH / imageWidth)
    : Math.min(1, MAX_SPRITE_SHEET_PREVIEW_HEIGHT / imageHeight);
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  };
}

export function validateSpriteSheetSliceOptions(value: SpriteSheetSliceOptions): SpriteSheetSliceOptions {
  const options = {
    frameWidth: boundedInteger(value.frameWidth, 'Frame width', 1, 8_192),
    frameHeight: boundedInteger(value.frameHeight, 'Frame height', 1, 8_192),
    marginX: boundedInteger(value.marginX, 'Horizontal margin', 0, 8_191),
    marginY: boundedInteger(value.marginY, 'Vertical margin', 0, 8_191),
    spacingX: boundedInteger(value.spacingX, 'Horizontal spacing', 0, 8_191),
    spacingY: boundedInteger(value.spacingY, 'Vertical spacing', 0, 8_191),
    frameCount: value.frameCount === undefined ? undefined : boundedInteger(value.frameCount, 'Frame count', 1, MAX_SPRITE_SHEET_FRAMES),
    order: value.order,
    durationMs: boundedInteger(value.durationMs, 'Frame duration', 1, 60_000),
    trimTransparent: value.trimTransparent === true,
    skipEmpty: value.skipEmpty === true,
  } satisfies SpriteSheetSliceOptions;
  if (options.order !== 'rows' && options.order !== 'columns') throw new Error('Sprite-sheet order must be rows or columns.');
  return options;
}

export function calculateSpriteSheetLayout(imageWidth: number, imageHeight: number, value: SpriteSheetSliceOptions): SpriteSheetLayout {
  boundedInteger(imageWidth, 'Image width', 1, 8_192); boundedInteger(imageHeight, 'Image height', 1, 8_192);
  const options = validateSpriteSheetSliceOptions(value);
  const innerWidth = imageWidth - options.marginX * 2; const innerHeight = imageHeight - options.marginY * 2;
  const columns = innerWidth < options.frameWidth ? 0 : Math.floor((innerWidth + options.spacingX) / (options.frameWidth + options.spacingX));
  const rows = innerHeight < options.frameHeight ? 0 : Math.floor((innerHeight + options.spacingY) / (options.frameHeight + options.spacingY));
  const availableFrames = columns * rows;
  if (!availableFrames) throw new Error('The frame size and margins leave no complete frame inside the image.');
  const count = Math.min(options.frameCount ?? availableFrames, availableFrames, MAX_SPRITE_SHEET_FRAMES);
  const frames: SpriteSheetFrameRect[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = options.order === 'rows' ? Math.floor(index / columns) : index % rows;
    const column = options.order === 'rows' ? index % columns : Math.floor(index / rows);
    frames.push({ index, row, column, x: options.marginX + column * (options.frameWidth + options.spacingX), y: options.marginY + row * (options.frameHeight + options.spacingY), width: options.frameWidth, height: options.frameHeight });
  }
  return { columns, rows, availableFrames, frames };
}

export const MAX_METADATA_SPRITE_SHEET_FRAMES = 4_096;
export const MAX_METADATA_SPRITE_SHEET_EXPANDED_PIXELS = 64 * 1024 * 1024;

const MAX_METADATA_SPRITE_SHEET_TAGS = 1_024;
const MAX_FRAME_DIMENSION = 8_192;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const MAX_FRAME_NAME_LENGTH = 200;
const MAX_FRAME_DURATION_MS = 60_000;
const DEFAULT_TAG_COLOR = '#9b87f5';
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

type UnknownRecord = Record<string, unknown>;

export interface MetadataSpriteSheetFrame {
  name: string;
  sourceFrameId?: string;
  durationMs: number;
  packed: { x: number; y: number; width: number; height: number };
  placement: { x: number; y: number; width: number; height: number };
  rotated: boolean;
}

export interface MetadataSpriteSheetTag {
  name: string;
  fromIndex: number;
  toIndex: number;
  direction: 'forward' | 'reverse' | 'ping-pong';
  color: string;
}

export interface MetadataSpriteSheetPlan {
  convention: 'legacy-untrimmed' | 'texturepacker-json';
  width: number;
  height: number;
  expandedPixels: number;
  imageReference: string;
  declaredAtlasSize?: { width: number; height: number };
  frames: MetadataSpriteSheetFrame[];
  tags: MetadataSpriteSheetTag[];
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as UnknownRecord;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum.toLocaleString('en-US')} through ${maximum.toLocaleString('en-US')}.`);
  }
  return value;
}

function aliasedInteger(
  source: UnknownRecord,
  shortKey: string,
  longKey: string,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  fallback?: number,
): number {
  const hasShort = hasOwn(source, shortKey);
  const hasLong = hasOwn(source, longKey);
  if (!hasShort && !hasLong) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} is required.`);
  }
  const shortValue = hasShort ? integer(source[shortKey], label, minimum, maximum) : undefined;
  const longValue = hasLong ? integer(source[longKey], label, minimum, maximum) : undefined;
  if (shortValue !== undefined && longValue !== undefined && shortValue !== longValue) throw new Error(`${label} has contradictory short and long values.`);
  return shortValue ?? longValue!;
}

function dimensions(source: unknown, label: string): { width: number; height: number } {
  const value = record(source, label);
  const width = aliasedInteger(value, 'w', 'width', `${label} width`, 1, MAX_FRAME_DIMENSION);
  const height = aliasedInteger(value, 'h', 'height', `${label} height`, 1, MAX_FRAME_DIMENSION);
  if (width * height > MAX_FRAME_PIXELS) throw new Error(`${label} exceeds AIDraw's 16-megapixel frame limit.`);
  return { width, height };
}

function rectangle(
  source: unknown,
  label: string,
  inheritedSize?: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const value = record(source, label);
  const result = {
    x: integer(hasOwn(value, 'x') ? value.x : 0, `${label} x`, 0),
    y: integer(hasOwn(value, 'y') ? value.y : 0, `${label} y`, 0),
    width: aliasedInteger(value, 'w', 'width', `${label} width`, 1, MAX_FRAME_DIMENSION, inheritedSize?.width),
    height: aliasedInteger(value, 'h', 'height', `${label} height`, 1, MAX_FRAME_DIMENSION, inheritedSize?.height),
  };
  if (result.width * result.height > MAX_FRAME_PIXELS) throw new Error(`${label} exceeds AIDraw's 16-megapixel frame limit.`);
  return result;
}

function positionedRectangle(source: unknown, label: string): { x: number; y: number; width: number; height: number } {
  const value = record(source, label);
  if (!hasOwn(value, 'x') || !hasOwn(value, 'y')) throw new Error(`${label} must provide explicit x and y coordinates.`);
  return rectangle(value, label);
}

function frameEntries(metadata: UnknownRecord): Array<{ key?: string; source: UnknownRecord }> {
  if (Array.isArray(metadata.frames)) return metadata.frames.map((value, index) => ({ source: record(value, `Sprite-sheet frame ${index + 1}`) }));
  const frames = record(metadata.frames, 'Sprite-sheet frames');
  return Object.entries(frames).map(([key, value], index) => ({ key, source: record(value, `Sprite-sheet frame ${index + 1}`) }));
}

function frameName(source: UnknownRecord, key: string | undefined, index: number): string {
  const value = hasOwn(source, 'filename') ? source.filename : hasOwn(source, 'name') ? source.name : key ?? `Frame ${index + 1}`;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_FRAME_NAME_LENGTH) {
    throw new Error(`Sprite-sheet frame ${index + 1} name must contain 1–${MAX_FRAME_NAME_LENGTH} characters.`);
  }
  return value;
}

function frameDuration(source: UnknownRecord, index: number): number {
  return hasOwn(source, 'duration')
    ? integer(source.duration, `Sprite-sheet frame ${index + 1} duration`, 1, MAX_FRAME_DURATION_MS)
    : 100;
}

function sourceFrameId(source: UnknownRecord, index: number): string | undefined {
  if (!hasOwn(source, 'sourceFrameId')) return undefined;
  if (typeof source.sourceFrameId !== 'string' || source.sourceFrameId.length < 1) throw new Error(`Sprite-sheet frame ${index + 1} sourceFrameId must be a non-empty string.`);
  return source.sourceFrameId;
}

function explicitFrame(
  entry: { key?: string; source: UnknownRecord },
  index: number,
): { frame: MetadataSpriteSheetFrame; sourceSize: { width: number; height: number } } {
  const { source } = entry;
  if (!hasOwn(source, 'frame') || !hasOwn(source, 'rotated') || !hasOwn(source, 'trimmed') || !hasOwn(source, 'spriteSourceSize') || !hasOwn(source, 'sourceSize')) {
    throw new Error(`Sprite-sheet frame ${index + 1} must provide frame, rotated, trimmed, spriteSourceSize, and sourceSize together.`);
  }
  if (typeof source.rotated !== 'boolean' || typeof source.trimmed !== 'boolean') throw new Error(`Sprite-sheet frame ${index + 1} rotated and trimmed flags must be booleans.`);
  const packed = positionedRectangle(source.frame, `Sprite-sheet frame ${index + 1} rectangle`);
  const placementRecord = record(source.spriteSourceSize, `Sprite-sheet frame ${index + 1} spriteSourceSize`);
  if (!hasOwn(placementRecord, 'x') || !hasOwn(placementRecord, 'y')) throw new Error(`Sprite-sheet frame ${index + 1} spriteSourceSize must provide explicit x and y coordinates.`);
  const placement = {
    x: integer(placementRecord.x, `Sprite-sheet frame ${index + 1} placement x`, 0),
    y: integer(placementRecord.y, `Sprite-sheet frame ${index + 1} placement y`, 0),
    ...dimensions(placementRecord, `Sprite-sheet frame ${index + 1} spriteSourceSize`),
  };
  const sourceSize = dimensions(source.sourceSize, `Sprite-sheet frame ${index + 1} sourceSize`);
  if (placement.x + placement.width > sourceSize.width || placement.y + placement.height > sourceSize.height) {
    throw new Error(`Sprite-sheet frame ${index + 1} trimmed placement exceeds its full source canvas.`);
  }
  const isFullFrame = placement.x === 0 && placement.y === 0 && placement.width === sourceSize.width && placement.height === sourceSize.height;
  if (source.trimmed === isFullFrame) {
    throw new Error(`Sprite-sheet frame ${index + 1} trimmed flag contradicts its source placement.`);
  }
  const expectedPackedWidth = source.rotated ? placement.height : placement.width;
  const expectedPackedHeight = source.rotated ? placement.width : placement.height;
  if (packed.width !== expectedPackedWidth || packed.height !== expectedPackedHeight) {
    throw new Error(`Sprite-sheet frame ${index + 1} packed rectangle does not match its ${source.rotated ? 'clockwise-rotated' : 'unrotated'} source placement.`);
  }
  return {
    sourceSize,
    frame: {
      name: frameName(source, entry.key, index),
      sourceFrameId: sourceFrameId(source, index),
      durationMs: frameDuration(source, index),
      packed,
      placement,
      rotated: source.rotated,
    },
  };
}

function legacyFrames(entries: Array<{ key?: string; source: UnknownRecord }>): { width: number; height: number; frames: MetadataSpriteSheetFrame[] } {
  let width = 0;
  let height = 0;
  const frames = entries.map((entry, index) => {
    const packed = rectangle(
      hasOwn(entry.source, 'frame') ? entry.source.frame : entry.source,
      `Sprite-sheet frame ${index + 1} rectangle`,
      index === 0 ? undefined : { width, height },
    );
    if (index === 0) { width = packed.width; height = packed.height; }
    else if (packed.width !== width || packed.height !== height) {
      throw new Error(`Sprite-sheet frame ${index + 1} differs from the first untrimmed frame size; provide complete trim/source metadata instead of scaling packed pixels.`);
    }
    return {
      name: frameName(entry.source, entry.key, index),
      sourceFrameId: sourceFrameId(entry.source, index),
      durationMs: frameDuration(entry.source, index),
      packed,
      placement: { x: 0, y: 0, width, height },
      rotated: false,
    };
  });
  return { width, height, frames };
}

function tagSourceIndexes(frames: MetadataSpriteSheetFrame[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    if (!frame.sourceFrameId) return;
    const indexes = result.get(frame.sourceFrameId) ?? [];
    indexes.push(index);
    result.set(frame.sourceFrameId, indexes);
  });
  return result;
}

function tagEndpoint(
  tag: UnknownRecord,
  indexKey: 'from' | 'to',
  idKey: 'fromFrameId' | 'toFrameId',
  fallback: number,
  tagIndex: number,
  frameCount: number,
  sourceIndexes: Map<string, number[]>,
): number {
  let numeric: number | undefined;
  let identified: number | undefined;
  if (hasOwn(tag, indexKey)) numeric = integer(tag[indexKey], `Sprite-sheet tag ${tagIndex + 1} ${indexKey}`, 0, frameCount - 1);
  if (hasOwn(tag, idKey)) {
    const sourceId = tag[idKey];
    if (typeof sourceId !== 'string' || sourceId.length < 1) throw new Error(`Sprite-sheet tag ${tagIndex + 1} ${idKey} must be a non-empty string.`);
    const matches = sourceIndexes.get(sourceId) ?? [];
    if (matches.length !== 1) throw new Error(`Sprite-sheet tag ${tagIndex + 1} ${idKey} does not resolve to one exact source frame.`);
    identified = matches[0];
  }
  if (numeric !== undefined && identified !== undefined && numeric !== identified) throw new Error(`Sprite-sheet tag ${tagIndex + 1} has contradictory ${indexKey} references.`);
  return numeric ?? identified ?? fallback;
}

function metadataTags(meta: UnknownRecord, frames: MetadataSpriteSheetFrame[]): MetadataSpriteSheetTag[] {
  if (hasOwn(meta, 'frameTags') && hasOwn(meta, 'tags')) throw new Error('Sprite-sheet metadata cannot declare both frameTags and tags.');
  const source = hasOwn(meta, 'frameTags') ? meta.frameTags : meta.tags;
  if (source === undefined) return [];
  const values = Array.isArray(source) ? source : [source];
  if (values.length > MAX_METADATA_SPRITE_SHEET_TAGS) throw new Error(`Sprite-sheet metadata exceeds the ${MAX_METADATA_SPRITE_SHEET_TAGS.toLocaleString('en-US')}-tag limit.`);
  const sourceIndexes = tagSourceIndexes(frames);
  return values.map((value, index) => {
    const tag = record(value, `Sprite-sheet tag ${index + 1}`);
    const name = hasOwn(tag, 'name') ? tag.name : 'Animation';
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > MAX_FRAME_NAME_LENGTH) throw new Error(`Sprite-sheet tag ${index + 1} name must contain 1–${MAX_FRAME_NAME_LENGTH} characters.`);
    const rawDirection = hasOwn(tag, 'direction') ? tag.direction : 'forward';
    const direction = rawDirection === 'pingpong' ? 'ping-pong' : rawDirection;
    if (direction !== 'forward' && direction !== 'reverse' && direction !== 'ping-pong') throw new Error(`Sprite-sheet tag ${index + 1} direction is unsupported.`);
    const color = hasOwn(tag, 'color') ? tag.color : DEFAULT_TAG_COLOR;
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) throw new Error(`Sprite-sheet tag ${index + 1} color must be hex RGB or RGBA.`);
    const fromIndex = tagEndpoint(tag, 'from', 'fromFrameId', 0, index, frames.length, sourceIndexes);
    const toIndex = tagEndpoint(tag, 'to', 'toFrameId', frames.length - 1, index, frames.length, sourceIndexes);
    if (toIndex < fromIndex) throw new Error(`Sprite-sheet tag ${index + 1} has a reversed frame range.`);
    return { name, fromIndex, toIndex, direction, color };
  });
}

export function planMetadataSpriteSheet(metadata: unknown, fallbackImageReference: string): MetadataSpriteSheetPlan {
  const root = record(metadata, 'Sprite-sheet metadata');
  const meta = hasOwn(root, 'meta') ? record(root.meta, 'Sprite-sheet meta') : {};
  const entries = frameEntries(root);
  if (!entries.length) throw new Error('Sprite-sheet metadata contains no frames.');
  if (entries.length > MAX_METADATA_SPRITE_SHEET_FRAMES) throw new Error(`Sprite-sheet metadata exceeds the ${MAX_METADATA_SPRITE_SHEET_FRAMES.toLocaleString('en-US')}-frame limit.`);
  const explicitConvention = entries.some(({ source }) => hasOwn(source, 'rotated') || hasOwn(source, 'trimmed') || hasOwn(source, 'spriteSourceSize'));
  let width: number;
  let height: number;
  let frames: MetadataSpriteSheetFrame[];
  if (explicitConvention) {
    const planned = entries.map(explicitFrame);
    width = planned[0].sourceSize.width;
    height = planned[0].sourceSize.height;
    planned.forEach(({ sourceSize }, index) => {
      if (sourceSize.width !== width || sourceSize.height !== height) throw new Error(`Sprite-sheet frame ${index + 1} sourceSize differs from the animation's ${width}×${height} canvas.`);
    });
    frames = planned.map(({ frame }) => frame);
  } else {
    ({ width, height, frames } = legacyFrames(entries));
  }
  if (width * height > MAX_FRAME_PIXELS) throw new Error(`Sprite source size exceeds AIDraw's 16-megapixel frame limit.`);
  const expandedPixels = width * height * frames.length;
  if (!Number.isSafeInteger(expandedPixels) || expandedPixels > MAX_METADATA_SPRITE_SHEET_EXPANDED_PIXELS) throw new Error('Sprite-sheet frames exceed the 64-megapixel expanded import budget.');
  const imageReference = hasOwn(meta, 'image') ? meta.image : fallbackImageReference;
  if (typeof imageReference !== 'string' || imageReference.length < 1) throw new Error('Sprite-sheet image must be a non-empty relative path.');
  const declaredAtlasSize = hasOwn(meta, 'size') ? dimensions(meta.size, 'Sprite-sheet atlas size') : undefined;
  return {
    convention: explicitConvention ? 'texturepacker-json' : 'legacy-untrimmed',
    width,
    height,
    expandedPixels,
    imageReference,
    declaredAtlasSize,
    frames,
    tags: metadataTags(meta, frames),
  };
}

export function assertMetadataSpriteSheetAtlas(plan: MetadataSpriteSheetPlan, width: number, height: number): void {
  if (plan.declaredAtlasSize && (plan.declaredAtlasSize.width !== width || plan.declaredAtlasSize.height !== height)) {
    throw new Error(`Decoded sprite-sheet dimensions ${width}×${height} disagree with metadata atlas size ${plan.declaredAtlasSize.width}×${plan.declaredAtlasSize.height}.`);
  }
  plan.frames.forEach(({ packed }, index) => {
    if (packed.x + packed.width > width || packed.y + packed.height > height) throw new Error(`Sprite-sheet frame ${index + 1} has an invalid or out-of-bounds rectangle.`);
  });
}

export function reconstructMetadataSpriteSheetFrame(
  atlas: Uint8ClampedArray,
  atlasWidth: number,
  atlasHeight: number,
  frame: MetadataSpriteSheetFrame,
  sourceWidth: number,
  sourceHeight: number,
): Uint8ClampedArray {
  if (atlas.length !== atlasWidth * atlasHeight * 4) throw new Error('Sprite-sheet atlas pixels do not match the decoded dimensions.');
  if (sourceWidth < 1 || sourceHeight < 1 || frame.placement.x + frame.placement.width > sourceWidth || frame.placement.y + frame.placement.height > sourceHeight) {
    throw new Error('Sprite-sheet frame placement is outside the canonical source canvas.');
  }
  if (frame.packed.x + frame.packed.width > atlasWidth || frame.packed.y + frame.packed.height > atlasHeight) throw new Error('Sprite-sheet frame rectangle is outside the decoded atlas.');
  const result = new Uint8ClampedArray(sourceWidth * sourceHeight * 4);
  for (let y = 0; y < frame.placement.height; y += 1) {
    for (let x = 0; x < frame.placement.width; x += 1) {
      const sourceX = frame.rotated ? frame.packed.x + frame.placement.height - 1 - y : frame.packed.x + x;
      const sourceY = frame.rotated ? frame.packed.y + x : frame.packed.y + y;
      const sourceOffset = (sourceY * atlasWidth + sourceX) * 4;
      const targetOffset = ((frame.placement.y + y) * sourceWidth + frame.placement.x + x) * 4;
      result.set(atlas.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return result;
}

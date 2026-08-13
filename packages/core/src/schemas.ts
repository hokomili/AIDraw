import { z } from 'zod';
import type { AIDrawDocument, PixelDocument } from './model';
import type { CanvasOperation, CanvasTransaction } from './operations';
import { assertAcyclicReferences } from './reference-graph';

const OperationKindSchema = z.enum([
  'document.rename',
  'illustration.artboard.replace',
  'illustration.artboard.translate',
  'illustration.layer.add',
  'illustration.layer.replace',
  'illustration.layer.move',
  'illustration.layer.delete',
  'illustration.object.add',
  'illustration.object.replace',
  'illustration.object.move',
  'illustration.object.delete',
  'illustration.paint.stroke',
  'illustration.brush-presets.replace',
  'illustration.guides.replace',
  'illustration.snap-settings.replace',
  'illustration.animation.settings.replace',
  'illustration.animation.keyframe.upsert',
  'illustration.animation.keyframe.delete',
  'asset.add',
  'asset.delete',
  'provenance.add',
  'provenance.delete',
  'pixel.palette.replace',
  'pixel.palette.reorder',
  'pixel.palette-cycles.replace',
  'pixel.stamps.replace',
  'pixel.tile-stamps.replace',
  'pixel.bitmap-fonts.replace',
  'pixel.conversion.replace',
  'pixel.links.replace',
  'pixel.active-asset.set',
  'pixel.frame.add',
  'pixel.frame.replace',
  'pixel.frame.delete',
  'pixel.asset.add',
  'pixel.asset.replace',
  'pixel.asset.delete',
  'pixel.cel.set',
  'pixel.cel.region',
  'pixel.tilemap.set',
  'pixel.tilemap.region',
]);

const IdSchema = z.string().min(1);
const ExpectedRevisionSchema = z.number().int().nonnegative().optional();
const FiniteNumberSchema = z.number().refine(Number.isFinite, 'Expected a finite number');
const ColorInputSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const BlendModeInputSchema = z.enum([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion',
]);
const TransformInputSchema = z.object({
  x: FiniteNumberSchema.min(-1_000_000).max(1_000_000),
  y: FiniteNumberSchema.min(-1_000_000).max(1_000_000),
  scaleX: FiniteNumberSchema.min(-10_000).max(10_000),
  scaleY: FiniteNumberSchema.min(-10_000).max(10_000),
  rotation: FiniteNumberSchema.min(-1_000_000).max(1_000_000),
  skewX: FiniteNumberSchema.min(-89.999).max(89.999),
  skewY: FiniteNumberSchema.min(-89.999).max(89.999),
}).strict();
export const NewDocumentOptionsSchema = z.object({
  kind: z.enum(['illustration', 'sprite', 'tilemap', 'project']),
  name: z.string().trim().min(1).max(200).optional(),
  width: FiniteNumberSchema.int().min(1).max(8_192).optional(),
  height: FiniteNumberSchema.int().min(1).max(8_192).optional(),
  background: z.union([z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/), z.null()]).optional(),
  orientation: z.enum(['orthogonal', 'isometric']).optional(),
  infinite: z.boolean().optional(),
  tileWidth: FiniteNumberSchema.int().min(1).max(1_024).optional(),
  tileHeight: FiniteNumberSchema.int().min(1).max(1_024).optional(),
}).strict();

export type NewDocumentOptionsInput = z.infer<typeof NewDocumentOptionsSchema>;
const InlineAssetMimeTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/apng']);
const DocumentAssetInputSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  mimeType: InlineAssetMimeTypeSchema,
  byteLength: FiniteNumberSchema.int().nonnegative().max(1_500_000),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  source: z.enum(['imported', 'generated', 'embedded', 'rendered']),
  data: z.string().min(4).max(2_000_000).optional(),
}).strict();
const LinkedAssetInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  mode: z.enum(['embedded', 'linked']),
  relativePath: z.string().min(1).max(2_048).refine((value) => !value.includes('\0') && !value.includes('\\') && !/^(?:[A-Za-z]:|\/)/.test(value), 'Linked asset paths must be portable relative paths using forward slashes').optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  cachedPreviewAssetId: IdSchema.optional(),
}).strict().superRefine((link, context) => {
  if (!link.sha256) context.addIssue({ code: 'custom', path: ['sha256'], message: 'Linked assets require a content hash' });
  if (!link.cachedPreviewAssetId) context.addIssue({ code: 'custom', path: ['cachedPreviewAssetId'], message: 'Linked assets require a cached source asset' });
  if (link.mode === 'linked' && !link.relativePath) context.addIssue({ code: 'custom', path: ['relativePath'], message: 'External links require a relative path' });
  if (link.mode === 'embedded' && link.relativePath !== undefined) context.addIssue({ code: 'custom', path: ['relativePath'], message: 'Embedded links cannot retain an external path' });
});
const ProvenanceInputSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  provider: z.enum(['openai', 'stability', 'comfyui', 'external']),
  modelOrWorkflow: z.string().min(1).max(500),
  prompt: z.string().max(100_000).optional(),
  negativePrompt: z.string().max(100_000).optional(),
  seed: FiniteNumberSchema.int().optional(),
  sourceAssetIds: z.array(IdSchema).max(64),
  maskAssetId: IdSchema.optional(),
  createdAt: z.string().min(1),
  conversion: z.record(z.string(), z.unknown()).optional(),
}).strict();
const EntityBaseInputShape = {
  id: IdSchema,
  revision: FiniteNumberSchema.int().nonnegative(),
  name: z.string().min(1).max(200),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: IdSchema,
};
const ArtboardInputSchema = z.object({
  width: FiniteNumberSchema.int().min(1).max(8_192),
  height: FiniteNumberSchema.int().min(1).max(8_192),
  background: z.union([ColorInputSchema, z.null()]),
  colorSpace: z.literal('srgb'),
  dpi: FiniteNumberSchema.int().min(1).max(1_200),
}).strict();
const IllustrationKeyframeInputSchema = z.object({
  ...EntityBaseInputShape,
  objectId: IdSchema,
  timeMs: FiniteNumberSchema.int().min(0).max(600_000),
  transform: TransformInputSchema,
  opacity: FiniteNumberSchema.min(0).max(1),
  visible: z.boolean(),
  easing: z.enum(['linear', 'hold', 'ease-in-out']),
}).strict();
const IllustrationAnimationInputSchema = z.object({
  durationMs: FiniteNumberSchema.int().min(1).max(600_000),
  framesPerSecond: FiniteNumberSchema.int().min(1).max(120),
  playback: z.enum(['once', 'loop', 'ping-pong']),
  keyframeIds: z.array(IdSchema).max(10_000),
  keyframes: z.record(z.string(), IllustrationKeyframeInputSchema),
}).strict().superRefine((animation, context) => {
  if (new Set(animation.keyframeIds).size !== animation.keyframeIds.length) context.addIssue({ code: 'custom', path: ['keyframeIds'], message: 'Animation keyframe IDs must be unique' });
  if (Object.keys(animation.keyframes).length > 10_000) context.addIssue({ code: 'custom', path: ['keyframes'], message: 'Illustration animations are limited to 10,000 keyframes' });
  for (const [id, keyframe] of Object.entries(animation.keyframes)) {
    if (keyframe.id !== id) context.addIssue({ code: 'custom', path: ['keyframes', id, 'id'], message: 'Animation keyframe record keys must match entity IDs' });
    if (keyframe.timeMs > animation.durationMs) context.addIssue({ code: 'custom', path: ['keyframes', id, 'timeMs'], message: 'Animation keyframe time exceeds the animation duration' });
  }
  for (const id of animation.keyframeIds) if (!animation.keyframes[id]) context.addIssue({ code: 'custom', path: ['keyframeIds'], message: `Animation keyframe ${id} is missing` });
  for (const id of Object.keys(animation.keyframes)) if (!animation.keyframeIds.includes(id)) context.addIssue({ code: 'custom', path: ['keyframes', id], message: `Animation keyframe ${id} is not ordered` });
});
const PixelChangeSchema = z.object({
  x: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  y: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  index: FiniteNumberSchema.int().min(0).max(255),
});
const TileChangeSchema = z.object({
  x: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  y: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  gid: FiniteNumberSchema.int().min(0).max(0xffff_ffff),
});
const RunPositionShape = {
  x: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  y: FiniteNumberSchema.int().min(-16_777_216).max(16_777_216),
  length: FiniteNumberSchema.int().min(1).max(65_536),
};
const PixelIndexRunSchema = z.object({ ...RunPositionShape, index: FiniteNumberSchema.int().min(0).max(255) }).strict();
const TileGidRunSchema = z.object({ ...RunPositionShape, gid: FiniteNumberSchema.int().min(0).max(0xffff_ffff) }).strict();

function validateRuns(runs: Array<{ x: number; y: number; length: number }>, context: z.RefinementCtx): void {
  const total = runs.reduce((sum, run) => Math.min(1_000_001, sum + run.length), 0);
  if (total > 1_000_000) context.addIssue({ code: 'custom', path: ['runs'], message: 'Region operations are limited to one million cells' });
  const ordered = runs.map((run, index) => ({ ...run, index })).sort((left, right) => left.y - right.y || left.x - right.x);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]; const current = ordered[index];
    if (previous.y === current.y && previous.x + previous.length > current.x) {
      context.addIssue({ code: 'custom', path: ['runs', current.index], message: 'Runs in one operation may not overlap' });
    }
  }
}
const RasterBrushDynamicsSchema = z.object({
  tip: z.enum(['round', 'flat', 'chalk', 'watercolor']),
  spacing: FiniteNumberSchema.min(0.01).max(4),
  stabilization: FiniteNumberSchema.min(0).max(1),
  scatter: FiniteNumberSchema.min(0).max(2),
  sizeJitter: FiniteNumberSchema.min(0).max(1),
  opacityJitter: FiniteNumberSchema.min(0).max(1),
  angle: FiniteNumberSchema.min(-180).max(180),
  roundness: FiniteNumberSchema.min(0.05).max(1),
  wetness: FiniteNumberSchema.min(0).max(1),
  granulation: FiniteNumberSchema.min(0).max(1),
  seed: FiniteNumberSchema.int().min(0).max(0xffff_ffff),
}).strict();
const RasterBrushPresetInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  size: FiniteNumberSchema.min(1).max(500),
  opacity: FiniteNumberSchema.min(0.01).max(1),
  hardness: FiniteNumberSchema.min(0).max(1),
  flow: FiniteNumberSchema.min(0.01).max(1),
  dynamics: RasterBrushDynamicsSchema.omit({ seed: true }),
}).strict();
const RasterBrushPresetsInputSchema = z.array(RasterBrushPresetInputSchema).max(256).superRefine((presets, context) => {
  const ids = new Set<string>();
  presets.forEach((preset, index) => { if (ids.has(preset.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Brush preset IDs must be unique' }); ids.add(preset.id); });
});
const PointSampleInputSchema = z.object({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  pressure: FiniteNumberSchema.min(0).max(1),
  time: FiniteNumberSchema.optional(),
}).strict();
const RasterStrokeInputSchema = z.object({
  id: IdSchema,
  actorId: IdSchema,
  points: z.array(PointSampleInputSchema).min(1).max(1_000_000),
  color: ColorInputSchema,
  size: FiniteNumberSchema.min(1).max(500),
  opacity: FiniteNumberSchema.min(0.01).max(1),
  hardness: FiniteNumberSchema.min(0).max(1),
  flow: FiniteNumberSchema.min(0.01).max(1),
  mode: z.enum(['paint', 'erase']),
  preset: z.enum(['hard-round', 'soft-round', 'pencil', 'marker', 'airbrush', 'eraser', 'watercolor', 'custom']),
  brushPresetId: IdSchema.optional(),
  dynamics: RasterBrushDynamicsSchema.optional(),
}).strict();
const ImageFilterInputSchema = z.object({
  type: z.enum(['brightness', 'contrast', 'saturation', 'hue', 'blur']),
  value: FiniteNumberSchema,
}).strict().superRefine((filter, context) => {
  const valid = filter.type === 'hue'
    ? filter.value >= -180 && filter.value <= 180
    : filter.type === 'blur'
      ? filter.value >= 0 && filter.value <= 40
      : filter.value >= -1 && filter.value <= 1;
  if (!valid) context.addIssue({ code: 'custom', path: ['value'], message: `Filter value is outside the supported ${filter.type} range` });
});
const ImageFiltersInputSchema = z.array(ImageFilterInputSchema).max(64);
const ColorStopInputSchema = z.object({
  offset: FiniteNumberSchema.min(0).max(1),
  color: ColorInputSchema,
  opacity: FiniteNumberSchema.min(0).max(1).optional(),
}).strict();
const PaintStyleInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('solid'), color: ColorInputSchema }).strict(),
  z.object({
    kind: z.enum(['linear-gradient', 'radial-gradient']),
    stops: z.array(ColorStopInputSchema).min(2).max(32),
    x1: FiniteNumberSchema,
    y1: FiniteNumberSchema,
    x2: FiniteNumberSchema,
    y2: FiniteNumberSchema,
  }).strict(),
]);
const StrokeStyleInputSchema = z.object({
  paint: PaintStyleInputSchema,
  width: FiniteNumberSchema.min(0).max(10_000),
  opacity: FiniteNumberSchema.min(0).max(1),
  lineCap: z.enum(['butt', 'round', 'square']),
  lineJoin: z.enum(['miter', 'round', 'bevel']),
  dash: z.array(FiniteNumberSchema.min(0).max(1_000_000)).max(256),
}).strict();
const IllustrationLayerBaseInputShape = {
  ...EntityBaseInputShape,
  parentId: IdSchema.optional(),
  interchangeRole: z.literal('pdf-extracted-text').optional(),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumberSchema.min(0).max(1),
  blendMode: BlendModeInputSchema,
  maskLayerId: IdSchema.optional(),
  filters: ImageFiltersInputSchema.optional(),
};
const IllustrationLayerInputSchema = z.discriminatedUnion('type', [
  z.object({ ...IllustrationLayerBaseInputShape, type: z.literal('group'), childIds: z.array(IdSchema).max(1_000_000) }).strict(),
  z.object({ ...IllustrationLayerBaseInputShape, type: z.literal('vector'), objectIds: z.array(IdSchema).max(1_000_000) }).strict(),
  z.object({
    ...IllustrationLayerBaseInputShape,
    type: z.literal('paint'),
    tileSize: z.literal(256),
    tileAssetIds: z.record(z.string(), IdSchema),
    tileCache: z.object({ version: z.literal(1), strokeCount: FiniteNumberSchema.int().nonnegative(), strokesSha256: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict().optional(),
    strokes: z.array(RasterStrokeInputSchema).max(1_000_000),
  }).strict(),
]).superRefine((layer, context) => {
  const ids = layer.type === 'group' ? layer.childIds : layer.type === 'vector' ? layer.objectIds : layer.strokes.map((stroke) => stroke.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: [layer.type === 'group' ? 'childIds' : layer.type === 'vector' ? 'objectIds' : 'strokes'], message: 'Illustration layer membership IDs must be unique' });
  if (layer.type !== 'paint') return;
  const tiles = Object.entries(layer.tileAssetIds);
  if (tiles.length > 16_384 || tiles.some(([key]) => !/^-?\d+,-?\d+$/.test(key))) context.addIssue({ code: 'custom', path: ['tileAssetIds'], message: 'Paint tile indexes must contain at most 16,384 coordinate keys' });
  if (layer.tileCache && layer.tileCache.strokeCount > layer.strokes.length) context.addIssue({ code: 'custom', path: ['tileCache', 'strokeCount'], message: 'Paint tile cache cannot cover more strokes than the layer contains' });
});
const IllustrationObjectBaseInputShape = {
  ...EntityBaseInputShape,
  layerId: IdSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumberSchema.min(0).max(1),
  blendMode: BlendModeInputSchema,
  transform: TransformInputSchema,
  blur: FiniteNumberSchema.min(0).max(4_096).optional(),
  filters: ImageFiltersInputSchema.optional(),
  maskObjectId: IdSchema.optional(),
  shadow: z.object({ color: ColorInputSchema, blur: FiniteNumberSchema.min(0).max(4_096), offsetX: FiniteNumberSchema, offsetY: FiniteNumberSchema }).strict().optional(),
};
const TextStyleRangeInputSchema = z.object({
  start: FiniteNumberSchema.int().nonnegative().max(100_000),
  end: FiniteNumberSchema.int().nonnegative().max(100_000),
  fontFamily: z.string().trim().min(1).max(200),
  fontSize: FiniteNumberSchema.min(1).max(500),
  fontWeight: FiniteNumberSchema.int().min(100).max(900),
  fontStyle: z.enum(['normal', 'italic']),
  color: ColorInputSchema,
  letterSpacing: FiniteNumberSchema.min(-20).max(100),
  underline: z.boolean().optional(),
}).strict().refine((range) => range.end >= range.start, { path: ['end'], message: 'Text range end must not precede its start' });
const IllustrationObjectInputSchema = z.discriminatedUnion('type', [
  z.object({
    ...IllustrationObjectBaseInputShape,
    type: z.literal('vector-stroke'),
    points: z.array(PointSampleInputSchema).min(1).max(1_000_000),
    brush: z.object({
      size: FiniteNumberSchema.min(1).max(500),
      thinning: FiniteNumberSchema.min(-1).max(1),
      smoothing: FiniteNumberSchema.min(0).max(1),
      streamline: FiniteNumberSchema.min(0).max(1),
      simulatePressure: z.boolean(),
      color: ColorInputSchema,
    }).strict(),
    pathData: z.string().max(2_000_000).optional(),
  }).strict(),
  z.object({ ...IllustrationObjectBaseInputShape, type: z.literal('path'), pathData: z.string().min(1).max(2_000_000), closed: z.boolean(), fill: PaintStyleInputSchema, stroke: StrokeStyleInputSchema, fillRule: z.enum(['nonzero', 'evenodd']) }).strict(),
  z.object({
    ...IllustrationObjectBaseInputShape,
    type: z.literal('shape'),
    shape: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'star']),
    width: FiniteNumberSchema.min(0).max(1_000_000),
    height: FiniteNumberSchema.min(0).max(1_000_000),
    sides: FiniteNumberSchema.int().min(3).max(1_000).optional(),
    innerRadius: FiniteNumberSchema.min(0).max(1).optional(),
    fill: PaintStyleInputSchema,
    stroke: StrokeStyleInputSchema,
    cornerRadius: FiniteNumberSchema.min(0).max(1_000_000).optional(),
  }).strict(),
  z.object({
    ...IllustrationObjectBaseInputShape,
    type: z.literal('text'),
    text: z.string().max(100_000),
    width: FiniteNumberSchema.min(0).max(1_000_000),
    height: FiniteNumberSchema.min(0).max(1_000_000),
    align: z.enum(['left', 'center', 'right', 'justify']),
    lineHeight: FiniteNumberSchema.min(0.1).max(10),
    ranges: z.array(TextStyleRangeInputSchema).max(100_000),
  }).strict(),
  z.object({
    ...IllustrationObjectBaseInputShape,
    type: z.literal('image'),
    assetId: IdSchema,
    width: FiniteNumberSchema.positive().max(1_000_000),
    height: FiniteNumberSchema.positive().max(1_000_000),
    sourceWidth: FiniteNumberSchema.positive().max(1_000_000).optional(),
    sourceHeight: FiniteNumberSchema.positive().max(1_000_000).optional(),
    crop: z.object({ x: FiniteNumberSchema.nonnegative(), y: FiniteNumberSchema.nonnegative(), width: FiniteNumberSchema.positive(), height: FiniteNumberSchema.positive() }).strict().optional(),
    filters: ImageFiltersInputSchema,
  }).strict(),
  z.object({ ...IllustrationObjectBaseInputShape, type: z.literal('group'), childIds: z.array(IdSchema).max(1_000_000) }).strict(),
]).superRefine((object, context) => {
  if (object.type === 'group' && new Set(object.childIds).size !== object.childIds.length) context.addIssue({ code: 'custom', path: ['childIds'], message: 'Object-group child IDs must be unique' });
  if (object.type === 'text' && object.ranges.some((range) => range.end > object.text.length)) context.addIssue({ code: 'custom', path: ['ranges'], message: 'Text style ranges must fit inside the text' });
  if (object.type === 'image' && object.crop && object.sourceWidth !== undefined && object.sourceHeight !== undefined && (object.crop.x + object.crop.width > object.sourceWidth || object.crop.y + object.crop.height > object.sourceHeight)) context.addIssue({ code: 'custom', path: ['crop'], message: 'Image crop must fit inside source geometry' });
});
const IllustrationLayerIdsInputSchema = z.array(IdSchema).max(1_000_000).refine((ids) => new Set(ids).size === ids.length, { message: 'Illustration root layer IDs must be unique' });
const IllustrationLayersInputSchema = z.record(z.string(), IllustrationLayerInputSchema).superRefine((layers, context) => {
  for (const [id, layer] of Object.entries(layers)) if (layer.id !== id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Illustration layer record keys must match entity IDs' });
});
const IllustrationObjectsInputSchema = z.record(z.string(), IllustrationObjectInputSchema).superRefine((objects, context) => {
  for (const [id, object] of Object.entries(objects)) if (object.id !== id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Illustration object record keys must match entity IDs' });
});
const BitmapGlyphInputSchema = z.object({ width: FiniteNumberSchema.int().min(1).max(64), advance: FiniteNumberSchema.int().min(1).max(128), rows: z.array(z.string().regex(/^[.#]{1,64}$/)).min(1).max(64) }).strict().superRefine((glyph, context) => { glyph.rows.forEach((row, index) => { if (row.length !== glyph.width) context.addIssue({ code: 'custom', path: ['rows', index], message: 'Every bitmap glyph row must match its width' }); }); });
const BitmapFontInputSchema = z.object({ id: IdSchema, name: z.string().trim().min(1).max(200), lineHeight: FiniteNumberSchema.int().min(1).max(128), glyphs: z.record(z.string().min(1).max(4), BitmapGlyphInputSchema) }).strict();
const IllustrationGuideInputSchema = z.object({ id: IdSchema, orientation: z.enum(['horizontal', 'vertical']), position: FiniteNumberSchema.min(-1_000_000).max(1_000_000), color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/), locked: z.boolean() }).strict();
const IllustrationGuidesInputSchema = z.array(IllustrationGuideInputSchema).max(1_024).superRefine((guides, context) => {
  const ids = new Set<string>();
  guides.forEach((guide, index) => { if (ids.has(guide.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Guide IDs must be unique' }); ids.add(guide.id); });
});
const IllustrationSnapSettingsInputSchema = z.object({ artboard: z.boolean(), objects: z.boolean(), guides: z.boolean(), grid: z.boolean(), pixel: z.boolean(), gridSize: FiniteNumberSchema.min(1).max(4_096), tolerance: FiniteNumberSchema.min(0).max(128) }).strict();
const MAX_PIXEL_COORDINATE = 16_777_216;
const MAX_PIXEL_DIMENSION = 8_192;
// Match the established Tiled importer ceilings; this boundary adds no new resource policy.
const MAX_TILESET_TILES = 1_048_576;
const MAX_TILESET_COLLISION_OBJECTS = 100_000;
const MAX_WANG_SETS = 1_024;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;
const PropertyValueInputSchema = z.union([z.string(), FiniteNumberSchema, z.boolean()]);
const PropertiesInputSchema = z.record(z.string(), PropertyValueInputSchema);
const ChunkCoordinateInputSchema = FiniteNumberSchema.int().min(-MAX_PIXEL_COORDINATE).max(MAX_PIXEL_COORDINATE).refine((value) => value % 32 === 0, 'Chunk origins must align to the 32-pixel grid');

function canonicalBase64InputSchema(decodedByteLength: number): z.ZodString {
  return z.string().length(Math.ceil(decodedByteLength / 3) * 4).regex(CANONICAL_BASE64_PATTERN, 'Chunk data must use canonical base64');
}

function validateChunkKeys(chunks: Record<string, { x: number; y: number }>, context: z.RefinementCtx): void {
  for (const [key, chunk] of Object.entries(chunks)) {
    const expected = `${chunk.x / 32},${chunk.y / 32}`;
    if (key !== expected) context.addIssue({ code: 'custom', path: [key], message: `Chunk record key must be ${expected}` });
  }
}

function validateUniqueStringIds(entries: Array<{ id: string }>, context: z.RefinementCtx, message: string): void {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message });
    ids.add(entry.id);
  });
}

const FrameInputSchema = z.object({
  ...EntityBaseInputShape,
  durationMs: FiniteNumberSchema.int().min(1).max(60_000),
}).strict();
const PixelChunkInputSchema = z.object({
  x: ChunkCoordinateInputSchema,
  y: ChunkCoordinateInputSchema,
  width: z.literal(32),
  height: z.literal(32),
  data: canonicalBase64InputSchema(32 * 32),
}).strict();
const PixelChunksInputSchema = z.record(z.string(), PixelChunkInputSchema).superRefine(validateChunkKeys);
const TilemapChunkInputSchema = z.object({
  x: ChunkCoordinateInputSchema,
  y: ChunkCoordinateInputSchema,
  width: z.literal(32),
  height: z.literal(32),
  data: canonicalBase64InputSchema(32 * 32 * 4),
}).strict();
const TilemapChunksInputSchema = z.record(z.string(), TilemapChunkInputSchema).superRefine(validateChunkKeys);
const CelInputSchema = z.object({
  ...EntityBaseInputShape,
  layerId: IdSchema,
  frameId: IdSchema,
  chunks: PixelChunksInputSchema,
  linkedToCelId: IdSchema.optional(),
}).strict();
const PaletteEntryInputSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
}).strict();
const PaletteInputSchema = z.array(PaletteEntryInputSchema).min(1).max(256).superRefine((palette, context) => {
  if (!palette[0]?.color.toLowerCase().endsWith('00') || palette[0].color.length !== 9) context.addIssue({ code: 'custom', path: [0, 'color'], message: 'Palette index 0 must be transparent RGBA' });
  validateUniqueStringIds(palette, context, 'Palette entry IDs must be unique');
});
const AnimationTagInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  fromFrameId: IdSchema,
  toFrameId: IdSchema,
  direction: z.enum(['forward', 'reverse', 'ping-pong']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
}).strict();
const AnimationTagsInputSchema = z.array(AnimationTagInputSchema).max(10_000).superRefine((tags, context) => validateUniqueStringIds(tags, context, 'Animation tag IDs must be unique'));
const PixelStampInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  width: FiniteNumberSchema.int().min(1).max(8_192),
  height: FiniteNumberSchema.int().min(1).max(8_192),
  anchorX: FiniteNumberSchema.int().nonnegative(),
  anchorY: FiniteNumberSchema.int().nonnegative(),
  cells: z.array(z.object({ x: FiniteNumberSchema.int().nonnegative(), y: FiniteNumberSchema.int().nonnegative(), index: FiniteNumberSchema.int().min(0).max(255) }).strict()).min(1).max(65_536),
}).strict().superRefine((stamp, context) => {
  if (stamp.anchorX >= stamp.width || stamp.anchorY >= stamp.height) context.addIssue({ code: 'custom', path: ['anchorX'], message: 'Stamp anchor must fit inside its bounds' });
  const seen = new Set<string>();
  stamp.cells.forEach((cell, index) => {
    if (cell.x >= stamp.width || cell.y >= stamp.height) context.addIssue({ code: 'custom', path: ['cells', index], message: 'Stamp cell must fit inside its bounds' });
    const key = `${cell.x},${cell.y}`; if (seen.has(key)) context.addIssue({ code: 'custom', path: ['cells', index], message: 'Stamp cells may not overlap' }); seen.add(key);
  });
});
const PixelStampsInputSchema = z.array(PixelStampInputSchema).max(1_024).superRefine((stamps, context) => validateUniqueStringIds(stamps, context, 'Pixel stamp IDs must be unique'));
const PaletteCycleInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  fromIndex: FiniteNumberSchema.int().min(1).max(255),
  toIndex: FiniteNumberSchema.int().min(1).max(255),
  direction: z.enum(['forward', 'reverse']),
  stepMs: FiniteNumberSchema.int().min(16).max(60_000),
}).strict().refine((cycle) => cycle.toIndex >= cycle.fromIndex, { path: ['toIndex'], message: 'Cycle end index must be at or after its start' });
const PaletteCyclesInputSchema = z.array(PaletteCycleInputSchema).max(256).superRefine((cycles, context) => validateUniqueStringIds(cycles, context, 'Palette cycle IDs must be unique'));
const TileStampInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  width: FiniteNumberSchema.int().min(1).max(8_192),
  height: FiniteNumberSchema.int().min(1).max(8_192),
  anchorX: FiniteNumberSchema.int().nonnegative(),
  anchorY: FiniteNumberSchema.int().nonnegative(),
  cells: z.array(z.object({ x: FiniteNumberSchema.int().nonnegative(), y: FiniteNumberSchema.int().nonnegative(), gid: FiniteNumberSchema.int().min(0).max(0xffff_ffff) }).strict()).min(1).max(65_536),
}).strict().superRefine((stamp, context) => {
  if (stamp.anchorX >= stamp.width || stamp.anchorY >= stamp.height) context.addIssue({ code: 'custom', path: ['anchorX'], message: 'Stamp anchor must fit inside its bounds' });
  const seen = new Set<string>(); stamp.cells.forEach((cell, index) => { if (cell.x >= stamp.width || cell.y >= stamp.height) context.addIssue({ code: 'custom', path: ['cells', index], message: 'Stamp cell must fit inside its bounds' }); const key = cell.x + ',' + cell.y; if (seen.has(key)) context.addIssue({ code: 'custom', path: ['cells', index], message: 'Stamp cells may not overlap' }); seen.add(key); });
});
const TileStampsInputSchema = z.array(TileStampInputSchema).max(1_024).superRefine((stamps, context) => validateUniqueStringIds(stamps, context, 'Tile stamp IDs must be unique'));
const BitmapFontsInputSchema = z.array(BitmapFontInputSchema).min(1).max(64).superRefine((fonts, context) => validateUniqueStringIds(fonts, context, 'Bitmap font IDs must be unique'));
const LinkedAssetsInputSchema = z.array(LinkedAssetInputSchema).max(1_024).superRefine((links, context) => validateUniqueStringIds(links, context, 'Linked asset IDs must be unique'));
const PixelConversionDefaultsInputSchema = z.object({
  resample: z.literal('area'),
  paletteMetric: z.literal('oklab'),
  dithering: z.enum(['none', 'bayer-4x4', 'floyd-steinberg']),
  alphaThreshold: FiniteNumberSchema.min(0).max(1),
}).strict();

const OrderedEntityIdsInputSchema = z.array(IdSchema).superRefine((ids, context) => {
  const seen = new Set<string>(); ids.forEach((id, index) => { if (seen.has(id)) context.addIssue({ code: 'custom', path: [index], message: 'Ordered entity IDs must be unique' }); seen.add(id); });
});
const PixelLayerBaseInputShape = {
  ...EntityBaseInputShape,
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumberSchema.min(0).max(1),
  blendMode: BlendModeInputSchema,
  parentId: IdSchema.optional(),
};
const PixelLayerInputSchema = z.discriminatedUnion('type', [
  z.object({ ...PixelLayerBaseInputShape, type: z.literal('pixel') }).strict(),
  z.object({ ...PixelLayerBaseInputShape, type: z.literal('group'), childIds: OrderedEntityIdsInputSchema }).strict(),
]);
const PixelLayersInputSchema = z.record(z.string(), PixelLayerInputSchema).superRefine((layers, context) => {
  for (const [id, layer] of Object.entries(layers)) if (id !== layer.id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Pixel layer record keys must match entity IDs' });
});
const PixelFramesInputSchema = z.record(z.string(), FrameInputSchema).superRefine((frames, context) => {
  for (const [id, frame] of Object.entries(frames)) if (id !== frame.id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Pixel frame record keys must match entity IDs' });
});
const PixelCelsInputSchema = z.record(z.string(), CelInputSchema).superRefine((cels, context) => {
  const exposures = new Set<string>();
  for (const [id, cel] of Object.entries(cels)) {
    if (id !== cel.id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Pixel cel record keys must match entity IDs' });
    const exposure = `${cel.layerId}\0${cel.frameId}`;
    if (exposures.has(exposure)) context.addIssue({ code: 'custom', path: [id], message: 'Each pixel layer/frame exposure must have at most one cel' });
    exposures.add(exposure);
  }
});
const PixelPaletteOverridesInputSchema = z.record(z.string(), PaletteInputSchema);

const CollisionShapeInputSchema = z.object({
  id: IdSchema,
  type: z.enum(['rectangle', 'ellipse', 'polygon', 'polyline']),
  x: FiniteNumberSchema.min(-MAX_PIXEL_COORDINATE).max(MAX_PIXEL_COORDINATE),
  y: FiniteNumberSchema.min(-MAX_PIXEL_COORDINATE).max(MAX_PIXEL_COORDINATE),
  width: FiniteNumberSchema.nonnegative().max(MAX_PIXEL_COORDINATE).optional(),
  height: FiniteNumberSchema.nonnegative().max(MAX_PIXEL_COORDINATE).optional(),
  points: z.array(z.object({ x: FiniteNumberSchema.min(-MAX_PIXEL_COORDINATE).max(MAX_PIXEL_COORDINATE), y: FiniteNumberSchema.min(-MAX_PIXEL_COORDINATE).max(MAX_PIXEL_COORDINATE) }).strict()).max(65_536).optional(),
  properties: PropertiesInputSchema,
}).strict().superRefine((object, context) => {
  if ((object.type === 'rectangle' || object.type === 'ellipse') && (object.width === undefined || object.height === undefined)) context.addIssue({ code: 'custom', message: 'Rectangle and ellipse map objects require width and height' });
  if ((object.type === 'polygon' || object.type === 'polyline') && (!object.points || object.points.length < 2)) context.addIssue({ code: 'custom', path: ['points'], message: 'Polygon and polyline map objects require at least two points' });
});
const CollisionShapesInputSchema = z.array(CollisionShapeInputSchema).max(100_000).superRefine((objects, context) => validateUniqueStringIds(objects, context, 'Map object IDs must be unique'));
const TileDefinitionInputSchema = z.object({
  id: FiniteNumberSchema.int().nonnegative(),
  sourceX: FiniteNumberSchema.nonnegative().max(MAX_PIXEL_COORDINATE),
  sourceY: FiniteNumberSchema.nonnegative().max(MAX_PIXEL_COORDINATE),
  probability: FiniteNumberSchema.nonnegative(),
  animation: z.array(z.object({ tileId: FiniteNumberSchema.int().nonnegative(), durationMs: FiniteNumberSchema.int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()),
  collisions: CollisionShapesInputSchema,
  properties: PropertiesInputSchema,
}).strict();
const WangColorInputSchema = z.object({
  id: FiniteNumberSchema.int().min(1).max(255),
  name: z.string().trim().min(1).max(100),
  color: ColorInputSchema,
  tileId: FiniteNumberSchema.int().nonnegative(),
  probability: FiniteNumberSchema.nonnegative(),
}).strict();
const WangIdInputSchema = z.tuple([
  FiniteNumberSchema.int().min(0).max(255), FiniteNumberSchema.int().min(0).max(255),
  FiniteNumberSchema.int().min(0).max(255), FiniteNumberSchema.int().min(0).max(255),
  FiniteNumberSchema.int().min(0).max(255), FiniteNumberSchema.int().min(0).max(255),
  FiniteNumberSchema.int().min(0).max(255), FiniteNumberSchema.int().min(0).max(255),
]);
const WangTileInputSchema = z.object({ tileId: FiniteNumberSchema.int().nonnegative(), wangId: WangIdInputSchema }).strict();
const WangSetInputSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(100),
  type: z.enum(['edge', 'corner', 'mixed']),
  colors: z.array(WangColorInputSchema).max(255),
  tiles: z.array(WangTileInputSchema).max(MAX_TILESET_TILES),
}).strict().superRefine((set, context) => {
  const colors = new Set<number>();
  set.colors.forEach((color, index) => { if (colors.has(color.id)) context.addIssue({ code: 'custom', path: ['colors', index, 'id'], message: 'Wang color IDs must be unique' }); colors.add(color.id); });
  const tiles = new Set<number>();
  set.tiles.forEach((tile, index) => {
    if (tiles.has(tile.tileId)) context.addIssue({ code: 'custom', path: ['tiles', index, 'tileId'], message: 'Wang tile IDs must be unique' });
    tiles.add(tile.tileId);
    tile.wangId.forEach((colorId, slot) => { if (colorId > 0 && !colors.has(colorId)) context.addIssue({ code: 'custom', path: ['tiles', index, 'wangId', slot], message: `Wang tile references missing color ${colorId}` }); });
  });
});

const TilemapLayerBaseInputShape = {
  ...EntityBaseInputShape,
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumberSchema.min(0).max(1),
  parentId: IdSchema.optional(),
  parallaxX: FiniteNumberSchema,
  parallaxY: FiniteNumberSchema,
};
const TilemapLayerInputSchema = z.discriminatedUnion('type', [
  z.object({ ...TilemapLayerBaseInputShape, type: z.literal('tile'), chunks: TilemapChunksInputSchema }).strict(),
  z.object({ ...TilemapLayerBaseInputShape, type: z.literal('object'), objects: CollisionShapesInputSchema }).strict(),
  z.object({ ...TilemapLayerBaseInputShape, type: z.literal('group'), childIds: OrderedEntityIdsInputSchema }).strict(),
]);
const TilemapLayersInputSchema = z.record(z.string(), TilemapLayerInputSchema).superRefine((layers, context) => {
  for (const [id, layer] of Object.entries(layers)) if (id !== layer.id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Tilemap layer record keys must match entity IDs' });
});

const PixelSpriteInputSchema = z.object({
  ...EntityBaseInputShape,
  type: z.literal('sprite'),
  width: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  height: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  layerIds: OrderedEntityIdsInputSchema.min(1),
  layers: PixelLayersInputSchema,
  frameIds: OrderedEntityIdsInputSchema.min(1),
  frames: PixelFramesInputSchema,
  cels: PixelCelsInputSchema,
  tags: AnimationTagsInputSchema,
  paletteOverrides: PixelPaletteOverridesInputSchema,
}).strict().superRefine((sprite, context) => {
  sprite.layerIds.forEach((id, index) => { if (!sprite.layers[id]) context.addIssue({ code: 'custom', path: ['layerIds', index], message: `Sprite layer ${id} is missing` }); });
  sprite.frameIds.forEach((id, index) => { if (!sprite.frames[id]) context.addIssue({ code: 'custom', path: ['frameIds', index], message: `Sprite frame ${id} is missing` }); });
  for (const [id, cel] of Object.entries(sprite.cels)) {
    if (!sprite.layers[cel.layerId]) context.addIssue({ code: 'custom', path: ['cels', id, 'layerId'], message: `Cel ${id} references missing layer ${cel.layerId}` });
    if (!sprite.frames[cel.frameId]) context.addIssue({ code: 'custom', path: ['cels', id, 'frameId'], message: `Cel ${id} references missing frame ${cel.frameId}` });
  }
  for (const [index, tag] of sprite.tags.entries()) {
    const from = sprite.frameIds.indexOf(tag.fromFrameId); const to = sprite.frameIds.indexOf(tag.toFrameId);
    if (from < 0 || to < from) context.addIssue({ code: 'custom', path: ['tags', index], message: `Animation tag ${tag.id} has an invalid frame range` });
  }
});
const PixelTilesetInputSchema = z.object({
  ...EntityBaseInputShape,
  type: z.literal('tileset'),
  firstGid: FiniteNumberSchema.int().min(1).max(0xffff_ffff),
  tileWidth: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  tileHeight: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  margin: FiniteNumberSchema.int().nonnegative().max(MAX_PIXEL_COORDINATE),
  spacing: FiniteNumberSchema.int().nonnegative().max(MAX_PIXEL_COORDINATE),
  columns: FiniteNumberSchema.int().min(1).max(MAX_TILESET_TILES),
  rows: FiniteNumberSchema.int().min(1).max(MAX_TILESET_TILES),
  spriteAssetId: IdSchema,
  tiles: z.record(z.string(), TileDefinitionInputSchema),
  wangSets: z.array(WangSetInputSchema).max(MAX_WANG_SETS),
  transformations: z.object({ hFlip: z.boolean(), vFlip: z.boolean(), rotate: z.boolean() }).strict(),
}).strict().superRefine((tileset, context) => {
  const tileCount = tileset.columns * tileset.rows;
  if (!Number.isSafeInteger(tileCount) || tileCount > MAX_TILESET_TILES) context.addIssue({ code: 'custom', path: ['columns'], message: 'Tileset slice exceeds the established one-million-tile limit' });
  const tileDefinitions = Object.entries(tileset.tiles);
  if (tileDefinitions.length > MAX_TILESET_TILES) context.addIssue({ code: 'custom', path: ['tiles'], message: 'Tileset metadata exceeds the established one-million-tile limit' });
  let animationFrames = 0; let collisionObjects = 0;
  for (const [key, tile] of tileDefinitions) {
    animationFrames += tile.animation.length; collisionObjects += tile.collisions.length;
    if (key !== String(tile.id)) context.addIssue({ code: 'custom', path: ['tiles', key, 'id'], message: 'Tile record keys must match tile IDs' });
    if (tile.id >= tileCount) context.addIssue({ code: 'custom', path: ['tiles', key, 'id'], message: `Tile ${tile.id} falls outside the tileset slice` });
    tile.animation.forEach((frame, index) => { if (frame.tileId >= tileCount) context.addIssue({ code: 'custom', path: ['tiles', key, 'animation', index, 'tileId'], message: `Animated tile ${frame.tileId} falls outside the tileset slice` }); });
  }
  if (animationFrames > MAX_TILESET_TILES) context.addIssue({ code: 'custom', path: ['tiles'], message: 'Tileset animation metadata exceeds the established one-million-frame limit' });
  if (collisionObjects > MAX_TILESET_COLLISION_OBJECTS) context.addIssue({ code: 'custom', path: ['tiles'], message: 'Tileset collision metadata exceeds the established 100,000-object limit' });
  const wangSetIds = new Set<string>(); let wangTiles = 0;
  tileset.wangSets.forEach((set, setIndex) => {
    if (wangSetIds.has(set.id)) context.addIssue({ code: 'custom', path: ['wangSets', setIndex, 'id'], message: 'Wang set IDs must be unique' });
    wangSetIds.add(set.id); wangTiles += set.tiles.length;
    set.colors.forEach((color, colorIndex) => { if (color.tileId >= tileCount) context.addIssue({ code: 'custom', path: ['wangSets', setIndex, 'colors', colorIndex, 'tileId'], message: 'Wang color representative tile falls outside the tileset slice' }); });
    set.tiles.forEach((tile, tileIndex) => { if (tile.tileId >= tileCount) context.addIssue({ code: 'custom', path: ['wangSets', setIndex, 'tiles', tileIndex, 'tileId'], message: 'Wang tile falls outside the tileset slice' }); });
  });
  if (wangTiles > MAX_TILESET_TILES) context.addIssue({ code: 'custom', path: ['wangSets'], message: 'Wang terrain metadata exceeds the established one-million-tile limit' });
});
const PixelTilemapInputSchema = z.object({
  ...EntityBaseInputShape,
  type: z.literal('tilemap'),
  orientation: z.enum(['orthogonal', 'isometric']),
  infinite: z.boolean(),
  width: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_COORDINATE),
  height: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_COORDINATE),
  tileWidth: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  tileHeight: FiniteNumberSchema.int().min(1).max(MAX_PIXEL_DIMENSION),
  tilesetIds: OrderedEntityIdsInputSchema,
  layerIds: OrderedEntityIdsInputSchema.min(1),
  layers: TilemapLayersInputSchema,
  properties: PropertiesInputSchema,
}).strict().superRefine((tilemap, context) => {
  tilemap.layerIds.forEach((id, index) => { if (!tilemap.layers[id]) context.addIssue({ code: 'custom', path: ['layerIds', index], message: `Tilemap layer ${id} is missing` }); });
});
const CanonicalPixelAssetInputSchema = z.discriminatedUnion('type', [PixelSpriteInputSchema, PixelTilesetInputSchema, PixelTilemapInputSchema]);
const PixelAssetInputSchema = CanonicalPixelAssetInputSchema.superRefine((asset, context) => {
  if (asset.type !== 'sprite') return;
  for (const [id, cel] of Object.entries(asset.cels)) if (cel.linkedToCelId && !asset.cels[cel.linkedToCelId]) context.addIssue({ code: 'custom', path: ['cels', id, 'linkedToCelId'], message: `Cel ${id} references missing linked cel ${cel.linkedToCelId}` });
  for (const frameId of Object.keys(asset.paletteOverrides)) if (!asset.frames[frameId]) context.addIssue({ code: 'custom', path: ['paletteOverrides', frameId], message: `Palette override references missing frame ${frameId}` });
});
const PixelAssetRecordsInputSchema = z.record(z.string(), CanonicalPixelAssetInputSchema).superRefine((assets, context) => {
  for (const [id, asset] of Object.entries(assets)) if (id !== asset.id) context.addIssue({ code: 'custom', path: [id, 'id'], message: 'Pixel asset record keys must match entity IDs' });
});
const PersistedPixelAssetStateInputSchema = z.object({
  scope: z.enum(['standalone', 'project']),
  standaloneType: z.enum(['sprite', 'tilemap']).optional(),
  assetIds: OrderedEntityIdsInputSchema.min(1),
  pixelAssets: PixelAssetRecordsInputSchema,
  activeAssetId: IdSchema,
}).strict().superRefine((state, context) => {
  state.assetIds.forEach((id, index) => { if (!state.pixelAssets[id]) context.addIssue({ code: 'custom', path: ['assetIds', index], message: `Ordered pixel asset ${id} is missing` }); });
  for (const id of Object.keys(state.pixelAssets)) if (!state.assetIds.includes(id)) context.addIssue({ code: 'custom', path: ['pixelAssets', id], message: `Pixel asset ${id} is not ordered` });
  if (!state.pixelAssets[state.activeAssetId]) context.addIssue({ code: 'custom', path: ['activeAssetId'], message: 'The active pixel asset must exist' });
});
const PersistedPixelLibrariesInputSchema = z.object({
  paletteCycles: PaletteCyclesInputSchema,
  stamps: PixelStampsInputSchema,
  tileStamps: TileStampsInputSchema,
  bitmapFonts: BitmapFontsInputSchema,
}).strict();

const TargetedOperationSchemas: Record<z.infer<typeof OperationKindSchema>, z.ZodType> = {
  'document.rename': z.object({ name: z.string().min(1).max(200) }).loose(),
  'illustration.artboard.replace': z.object({
    artboard: ArtboardInputSchema,
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'illustration.artboard.translate': z.object({
    kind: z.literal('illustration.artboard.translate'),
    artboard: ArtboardInputSchema,
    offsetX: FiniteNumberSchema.int().min(-8_192).max(8_192),
    offsetY: FiniteNumberSchema.int().min(-8_192).max(8_192),
    expectedRevision: ExpectedRevisionSchema,
  }).strict(),
  'asset.add': z.object({ asset: DocumentAssetInputSchema }).loose(),
  'asset.delete': z.object({ assetId: IdSchema }).loose(),
  'provenance.add': z.object({ provenance: ProvenanceInputSchema, index: z.number().int().nonnegative().optional() }).loose(),
  'provenance.delete': z.object({ provenanceId: IdSchema }).loose(),
  'illustration.layer.add': z.object({ kind: z.literal('illustration.layer.add'), layer: IllustrationLayerInputSchema, index: FiniteNumberSchema.int().nonnegative().max(1_000_000).optional() }).strict(),
  'illustration.layer.replace': z.object({ kind: z.literal('illustration.layer.replace'), layer: IllustrationLayerInputSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.layer.move': z.object({ kind: z.literal('illustration.layer.move'), layerId: IdSchema, parentId: IdSchema.optional(), index: FiniteNumberSchema.int().nonnegative().max(1_000_000).optional(), expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.layer.delete': z.object({ kind: z.literal('illustration.layer.delete'), layerId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.object.add': z.object({ kind: z.literal('illustration.object.add'), object: IllustrationObjectInputSchema, index: FiniteNumberSchema.int().nonnegative().max(1_000_000).optional(), parentGroupId: IdSchema.optional(), groupIndex: FiniteNumberSchema.int().nonnegative().max(1_000_000).optional() }).strict(),
  'illustration.object.replace': z.object({ kind: z.literal('illustration.object.replace'), object: IllustrationObjectInputSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.object.move': z.object({
    kind: z.literal('illustration.object.move'),
    objectId: IdSchema,
    layerId: IdSchema,
    index: z.number().int().nonnegative().optional(),
    parentGroupId: IdSchema.optional(),
    groupIndex: z.number().int().nonnegative().optional(),
    expectedRevision: ExpectedRevisionSchema,
  }).strict(),
  'illustration.object.delete': z.object({ kind: z.literal('illustration.object.delete'), objectId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.paint.stroke': z.object({
    layerId: IdSchema,
    stroke: RasterStrokeInputSchema,
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'illustration.brush-presets.replace': z.object({ kind: z.literal('illustration.brush-presets.replace'), presets: RasterBrushPresetsInputSchema }).strict(),
  'illustration.guides.replace': z.object({ kind: z.literal('illustration.guides.replace'), guides: IllustrationGuidesInputSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.snap-settings.replace': z.object({ kind: z.literal('illustration.snap-settings.replace'), settings: IllustrationSnapSettingsInputSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'illustration.animation.settings.replace': z.object({
    kind: z.literal('illustration.animation.settings.replace'),
    settings: z.object({
      durationMs: FiniteNumberSchema.int().min(1).max(600_000),
      framesPerSecond: FiniteNumberSchema.int().min(1).max(120),
      playback: z.enum(['once', 'loop', 'ping-pong']),
    }).strict(),
    expectedRevision: ExpectedRevisionSchema,
  }).strict(),
  'illustration.animation.keyframe.upsert': z.object({
    kind: z.literal('illustration.animation.keyframe.upsert'),
    keyframe: IllustrationKeyframeInputSchema,
    index: FiniteNumberSchema.int().nonnegative().max(10_000).optional(),
    expectedRevision: ExpectedRevisionSchema,
  }).strict(),
  'illustration.animation.keyframe.delete': z.object({
    kind: z.literal('illustration.animation.keyframe.delete'),
    keyframeId: IdSchema,
    expectedRevision: ExpectedRevisionSchema,
  }).strict(),
  'pixel.active-asset.set': z.object({ assetId: IdSchema }).loose(),
  'pixel.palette.replace': z.object({ palette: PaletteInputSchema }).loose(),
  'pixel.palette.reorder': z.object({ kind: z.literal('pixel.palette.reorder'), entryIds: z.array(IdSchema).min(1).max(256), expectedRevision: ExpectedRevisionSchema }).strict().superRefine(({ entryIds }, context) => { if (new Set(entryIds).size !== entryIds.length) context.addIssue({ code: 'custom', path: ['entryIds'], message: 'Palette reorder IDs must be unique' }); }),
  'pixel.stamps.replace': z.object({ stamps: PixelStampsInputSchema }).loose(),
  'pixel.tile-stamps.replace': z.object({ stamps: TileStampsInputSchema }).loose(),
  'pixel.bitmap-fonts.replace': z.object({ fonts: BitmapFontsInputSchema }).loose(),
  'pixel.palette-cycles.replace': z.object({ cycles: PaletteCyclesInputSchema }).loose(),
  'pixel.conversion.replace': z.object({
    conversionDefaults: PixelConversionDefaultsInputSchema,
  }).loose(),
  'pixel.links.replace': z.object({ kind: z.literal('pixel.links.replace'), linkedAssets: LinkedAssetsInputSchema, expectedRevision: ExpectedRevisionSchema }).strict(),
  'pixel.frame.add': z.object({
    spriteId: IdSchema,
    frame: FrameInputSchema,
    cels: z.array(CelInputSchema).max(10_000),
    index: z.number().int().nonnegative().optional(),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'pixel.frame.replace': z.object({ spriteId: IdSchema, frame: FrameInputSchema, expectedRevision: ExpectedRevisionSchema }).loose(),
  'pixel.frame.delete': z.object({ spriteId: IdSchema, frameId: IdSchema, expectedRevision: ExpectedRevisionSchema }).loose(),
  'pixel.asset.add': z.object({ asset: PixelAssetInputSchema, index: z.number().int().nonnegative().optional() }).loose(),
  'pixel.asset.replace': z.object({ asset: PixelAssetInputSchema, expectedRevision: ExpectedRevisionSchema }).loose(),
  'pixel.asset.delete': z.object({ assetId: IdSchema, expectedRevision: ExpectedRevisionSchema }).loose(),
  'pixel.cel.set': z.object({
    spriteId: IdSchema,
    celId: IdSchema,
    changes: z.array(PixelChangeSchema).max(1_000_000),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'pixel.cel.region': z.object({
    spriteId: IdSchema,
    celId: IdSchema,
    runs: z.array(PixelIndexRunSchema).min(1).max(65_536),
    expectedRevision: ExpectedRevisionSchema,
    conversion: z.object({
      sourceAssetId: IdSchema,
      resample: z.literal('area'),
      paletteMetric: z.literal('oklab'),
      dithering: z.enum(['none', 'bayer-4x4', 'floyd-steinberg']),
      alphaThreshold: FiniteNumberSchema.min(0).max(1),
      width: FiniteNumberSchema.int().positive().max(8_192),
      height: FiniteNumberSchema.int().positive().max(8_192),
    }).strict().optional(),
  }).loose().superRefine(({ runs }, context) => validateRuns(runs, context)),
  'pixel.tilemap.set': z.object({
    mapId: IdSchema,
    layerId: IdSchema,
    changes: z.array(TileChangeSchema).max(1_000_000),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'pixel.tilemap.region': z.object({
    mapId: IdSchema,
    layerId: IdSchema,
    runs: z.array(TileGidRunSchema).min(1).max(65_536),
    expectedRevision: ExpectedRevisionSchema,
  }).loose().superRefine(({ runs }, context) => validateRuns(runs, context)),
};

export const ActorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'agent', 'system']),
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6,8}$/),
  client: z.object({
    model: z.string().trim().min(1).max(200).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    taskId: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
});

const ActivityEntryInputSchema = z.object({
  id: IdSchema,
  transactionId: IdSchema,
  actor: ActorSchema,
  label: z.string().min(1).max(200),
  timestamp: z.string().min(1),
  status: z.enum(['committed', 'partial', 'undone', 'failed', 'cancelled']),
  operationCount: FiniteNumberSchema.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  details: z.string().optional(),
}).strict();

export const CanvasOperationSchema = z
  .object({
    kind: OperationKindSchema,
  })
  .loose()
  .superRefine((value, context) => {
    const validator = TargetedOperationSchemas[value.kind];
    const result = validator.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  })
  .transform((value) => value as CanvasOperation);

export const CanvasTransactionSchema = z
  .object({
    id: z.string().min(1),
    clientOperationId: z.string().min(1).max(200),
    documentId: z.string().min(1),
    actor: ActorSchema,
    label: z.string().min(1).max(200),
    createdAt: z.string(),
    operations: z.array(CanvasOperationSchema).max(256),
    playback: z
      .object({
        mode: z.enum(['animated', 'instant']),
        speed: z.number().min(0.25).max(4),
      })
      .optional(),
  })
  .transform((value) => value as CanvasTransaction);

export const PersistedDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    name: z.string().min(1),
    kind: z.enum(['illustration', 'pixel']),
    createdAt: z.string(),
    updatedAt: z.string(),
    dirty: z.boolean(),
    assets: z.record(z.string(), z.unknown()),
    activity: z.array(ActivityEntryInputSchema),
    provenance: z.array(ProvenanceInputSchema),
  })
  .loose()
  .superRefine((value, context) => {
    const activityIds = new Set<string>();
    for (const [index, entry] of value.activity.entries()) {
      if (activityIds.has(entry.id)) context.addIssue({ code: 'custom', path: ['activity', index, 'id'], message: `Duplicate activity ID: ${entry.id}` });
      activityIds.add(entry.id);
    }
    const provenanceIds = new Set<string>();
    for (const [index, entry] of value.provenance.entries()) {
      if (provenanceIds.has(entry.id)) context.addIssue({ code: 'custom', path: ['provenance', index, 'id'], message: `Duplicate provenance ID: ${entry.id}` });
      provenanceIds.add(entry.id);
    }
  })
  .transform((value) => value as unknown as AIDrawDocument);

function assertAcyclicGroupChildren(entries: Record<string, any>, cycleError: string): void {
  assertAcyclicReferences(entries, (entry) => entry?.type === 'group' && Array.isArray(entry.childIds) ? entry.childIds.filter((id: unknown): id is string => typeof id === 'string') : [], cycleError);
}

/**
 * Pixel recovery deliberately normalizes older or incomplete records first.
 * This second boundary proves that the value returned to canonical consumers
 * is nevertheless exact, bounded, and safe for recursive render/export code.
 */
export function validateNormalizedPixelDocument(document: PixelDocument): PixelDocument {
  const palette = PaletteInputSchema.safeParse(document.palette);
  if (!palette.success) throw new Error('Invalid persisted pixel palette metadata.');

  const libraries = PersistedPixelLibrariesInputSchema.safeParse({
    paletteCycles: document.paletteCycles,
    stamps: document.stamps,
    tileStamps: document.tileStamps,
    bitmapFonts: document.bitmapFonts,
  });
  if (!libraries.success || libraries.data.paletteCycles.some((cycle) => cycle.toIndex >= palette.data.length)) throw new Error('Invalid persisted pixel library metadata.');

  const assets = PersistedPixelAssetStateInputSchema.safeParse({
    scope: document.scope,
    standaloneType: document.standaloneType,
    assetIds: document.assetIds,
    pixelAssets: document.pixelAssets,
    activeAssetId: document.activeAssetId,
  });
  if (!assets.success) throw new Error('Invalid persisted pixel asset metadata.');

  const links = LinkedAssetsInputSchema.safeParse(document.linkedAssets);
  if (!links.success) throw new Error('Invalid persisted pixel link metadata.');
  const conversion = PixelConversionDefaultsInputSchema.safeParse(document.conversionDefaults);
  if (!conversion.success) throw new Error('Invalid persisted pixel conversion metadata.');

  document.palette = palette.data;
  document.paletteCycles = libraries.data.paletteCycles;
  document.stamps = libraries.data.stamps;
  document.tileStamps = libraries.data.tileStamps;
  document.bitmapFonts = libraries.data.bitmapFonts;
  document.assetIds = assets.data.assetIds;
  document.pixelAssets = assets.data.pixelAssets as PixelDocument['pixelAssets'];
  document.activeAssetId = assets.data.activeAssetId;
  document.linkedAssets = links.data;
  document.conversionDefaults = conversion.data;
  for (const asset of Object.values(document.pixelAssets)) {
    if (asset.type === 'sprite') assertAcyclicGroupChildren(asset.layers, 'Pixel sprite layer hierarchy contains a cycle.');
    else if (asset.type === 'tilemap') assertAcyclicGroupChildren(asset.layers, 'Pixel tilemap layer hierarchy contains a cycle.');
  }
  return document;
}

export function validateDocument(value: unknown): AIDrawDocument {
  const parsed = PersistedDocumentSchema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === 'activity')) throw new Error('Invalid persisted document activity metadata.');
    if (parsed.error.issues.some((issue) => issue.path[0] === 'provenance')) throw new Error('Invalid persisted document provenance metadata.');
    throw parsed.error;
  }
  const document = parsed.data;
  if (document.kind === 'illustration') {
    if (!Array.isArray(document.brushPresets)) document.brushPresets = [];
    if (!Array.isArray(document.guides)) document.guides = [];
    document.snapSettings ??= { artboard: true, objects: true, guides: true, grid: false, pixel: false, gridSize: 16, tolerance: 8 };
    document.animation ??= { durationMs: 2_000, framesPerSecond: 12, playback: 'loop', keyframeIds: [], keyframes: {} };
    const artboard = ArtboardInputSchema.safeParse(document.artboard);
    if (!artboard.success) throw new Error('Invalid persisted illustration artboard metadata.');
    const layerIds = IllustrationLayerIdsInputSchema.safeParse(document.layerIds);
    if (!layerIds.success) throw new Error('Invalid persisted illustration layer ordering.');
    const layers = IllustrationLayersInputSchema.safeParse(document.layers);
    if (!layers.success) throw new Error('Invalid persisted illustration layer metadata.');
    const objects = IllustrationObjectsInputSchema.safeParse(document.objects);
    if (!objects.success) throw new Error('Invalid persisted illustration object metadata.');
    const brushPresets = RasterBrushPresetsInputSchema.safeParse(document.brushPresets);
    if (!brushPresets.success) throw new Error('Invalid persisted illustration brush preset metadata.');
    const guides = IllustrationGuidesInputSchema.safeParse(document.guides);
    if (!guides.success) throw new Error('Invalid persisted illustration guide metadata.');
    const snapSettings = IllustrationSnapSettingsInputSchema.safeParse(document.snapSettings);
    if (!snapSettings.success) throw new Error('Invalid persisted illustration snap settings.');
    const animation = IllustrationAnimationInputSchema.safeParse(document.animation);
    if (!animation.success) throw new Error(`Invalid illustration animation: ${animation.error.issues.map((issue) => issue.message).join('; ')}`);
    document.artboard = artboard.data;
    document.layerIds = layerIds.data;
    document.layers = layers.data;
    document.objects = objects.data;
    document.brushPresets = brushPresets.data;
    document.guides = guides.data;
    document.snapSettings = snapSettings.data;
    document.animation = animation.data;
    assertAcyclicGroupChildren(document.layers, 'Illustration layer hierarchy contains a cycle.');
    assertAcyclicGroupChildren(document.objects, 'Illustration object hierarchy contains a cycle.');
  } else if (!Array.isArray(document.assetIds) || typeof document.pixelAssets !== 'object') {
    throw new Error('Invalid pixel document structure');
  } else {
    for (const asset of Object.values(document.pixelAssets)) {
      if (asset?.type === 'sprite' && asset.layers && typeof asset.layers === 'object' && !Array.isArray(asset.layers)) {
        assertAcyclicGroupChildren(asset.layers, 'Pixel sprite layer hierarchy contains a cycle.');
      } else if (asset?.type === 'tilemap' && asset.layers && typeof asset.layers === 'object' && !Array.isArray(asset.layers)) {
        assertAcyclicGroupChildren(asset.layers, 'Pixel tilemap layer hierarchy contains a cycle.');
      }
    }
  }
  return document;
}

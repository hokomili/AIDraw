import { z } from 'zod';
import type { AIDrawDocument } from './model';
import type { CanvasOperation, CanvasTransaction } from './operations';

const OperationKindSchema = z.enum([
  'document.rename',
  'illustration.layer.add',
  'illustration.layer.replace',
  'illustration.layer.move',
  'illustration.layer.delete',
  'illustration.object.add',
  'illustration.object.replace',
  'illustration.object.move',
  'illustration.object.delete',
  'illustration.paint.stroke',
  'asset.add',
  'asset.delete',
  'provenance.add',
  'provenance.delete',
  'pixel.palette.replace',
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
  'pixel.tilemap.set',
]);

const IdSchema = z.string().min(1);
const ExpectedRevisionSchema = z.number().int().nonnegative().optional();
const FiniteNumberSchema = z.number().refine(Number.isFinite, 'Expected a finite number');
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
const PixelChangeSchema = z.object({
  x: FiniteNumberSchema.int(),
  y: FiniteNumberSchema.int(),
  index: FiniteNumberSchema.int().min(0).max(255),
});
const TileChangeSchema = z.object({
  x: FiniteNumberSchema.int(),
  y: FiniteNumberSchema.int(),
  gid: FiniteNumberSchema.int().min(0).max(0xffff_ffff),
});
const PointSchema = z.object({ x: FiniteNumberSchema, y: FiniteNumberSchema }).loose();
const FrameInputSchema = z.object({
  ...EntityBaseInputShape,
  durationMs: FiniteNumberSchema.int().min(1).max(60_000),
}).loose();
const PixelChunkInputSchema = z.object({
  x: FiniteNumberSchema.int(),
  y: FiniteNumberSchema.int(),
  width: z.literal(32),
  height: z.literal(32),
  data: z.string(),
}).loose();
const CelInputSchema = z.object({
  ...EntityBaseInputShape,
  layerId: IdSchema,
  frameId: IdSchema,
  chunks: z.record(z.string(), PixelChunkInputSchema),
  linkedToCelId: IdSchema.optional(),
}).loose();
const PixelLayerInputSchema = z.object({
  ...EntityBaseInputShape,
  type: z.enum(['pixel', 'group']),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: FiniteNumberSchema.min(0).max(1),
  blendMode: z.string().min(1),
  parentId: IdSchema.optional(),
  childIds: z.array(IdSchema).optional(),
}).loose();
const PixelAssetInputSchema = z.object({
  ...EntityBaseInputShape,
  type: z.enum(['sprite', 'tileset', 'tilemap']),
}).loose().superRefine((asset, context) => {
  const requireField = (condition: boolean, field: string, message: string) => {
    if (!condition) context.addIssue({ code: 'custom', path: [field], message });
  };
  if (asset.type === 'sprite') {
    requireField(Number.isInteger(asset.width) && Number(asset.width) > 0, 'width', 'Sprite width must be a positive integer');
    requireField(Number.isInteger(asset.height) && Number(asset.height) > 0, 'height', 'Sprite height must be a positive integer');
    requireField(Array.isArray(asset.layerIds), 'layerIds', 'Sprite layerIds must be an array');
    requireField(typeof asset.layers === 'object' && asset.layers !== null, 'layers', 'Sprite layers must be an object');
    requireField(Array.isArray(asset.frameIds), 'frameIds', 'Sprite frameIds must be an array');
    requireField(typeof asset.frames === 'object' && asset.frames !== null, 'frames', 'Sprite frames must be an object');
    requireField(typeof asset.cels === 'object' && asset.cels !== null, 'cels', 'Sprite cels must be an object');
    requireField(Array.isArray(asset.tags), 'tags', 'Sprite tags must be an array');
    requireField(typeof asset.paletteOverrides === 'object' && asset.paletteOverrides !== null, 'paletteOverrides', 'Sprite paletteOverrides must be an object');
    const nested = [
      ['layers', z.record(z.string(), PixelLayerInputSchema), asset.layers],
      ['frames', z.record(z.string(), FrameInputSchema), asset.frames],
      ['cels', z.record(z.string(), CelInputSchema), asset.cels],
    ] as const;
    const parsed = new Map<string, unknown>();
    for (const [field, schema, value] of nested) {
      const result = schema.safeParse(value);
      if (result.success) parsed.set(field, result.data);
      else for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: [field, ...issue.path], message: issue.message });
    }
    const layers = parsed.get('layers') as Record<string, z.infer<typeof PixelLayerInputSchema>> | undefined;
    const frames = parsed.get('frames') as Record<string, z.infer<typeof FrameInputSchema>> | undefined;
    const cels = parsed.get('cels') as Record<string, z.infer<typeof CelInputSchema>> | undefined;
    if (layers && Array.isArray(asset.layerIds)) for (const id of asset.layerIds) requireField(typeof id === 'string' && Boolean(layers[id]), 'layerIds', `Sprite layer ${String(id)} is missing`);
    if (frames && Array.isArray(asset.frameIds)) for (const id of asset.frameIds) requireField(typeof id === 'string' && Boolean(frames[id]), 'frameIds', `Sprite frame ${String(id)} is missing`);
    if (layers && frames && cels) for (const cel of Object.values(cels)) {
      requireField(Boolean(layers[cel.layerId]), 'cels', `Cel ${cel.id} references missing layer ${cel.layerId}`);
      requireField(Boolean(frames[cel.frameId]), 'cels', `Cel ${cel.id} references missing frame ${cel.frameId}`);
    }
  } else if (asset.type === 'tileset') {
    requireField(typeof asset.spriteAssetId === 'string' && asset.spriteAssetId.length > 0, 'spriteAssetId', 'Tileset spriteAssetId is required');
    requireField(typeof asset.tiles === 'object' && asset.tiles !== null, 'tiles', 'Tileset tiles must be an object');
  } else {
    requireField(Array.isArray(asset.layerIds), 'layerIds', 'Tilemap layerIds must be an array');
    requireField(typeof asset.layers === 'object' && asset.layers !== null, 'layers', 'Tilemap layers must be an object');
    requireField(Array.isArray(asset.tilesetIds), 'tilesetIds', 'Tilemap tilesetIds must be an array');
  }
});

const TargetedOperationSchemas: Partial<Record<z.infer<typeof OperationKindSchema>, z.ZodType>> = {
  'document.rename': z.object({ name: z.string().min(1).max(200) }).loose(),
  'asset.add': z.object({ asset: DocumentAssetInputSchema }).loose(),
  'asset.delete': z.object({ assetId: IdSchema }).loose(),
  'provenance.add': z.object({ provenance: ProvenanceInputSchema }).loose(),
  'provenance.delete': z.object({ provenanceId: IdSchema }).loose(),
  'illustration.object.move': z.object({
    objectId: IdSchema,
    layerId: IdSchema,
    index: z.number().int().nonnegative().optional(),
    parentGroupId: IdSchema.optional(),
    groupIndex: z.number().int().nonnegative().optional(),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'illustration.paint.stroke': z.object({
    layerId: IdSchema,
    stroke: z.object({ points: z.array(PointSchema).max(1_000_000) }).loose(),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
  'pixel.active-asset.set': z.object({ assetId: IdSchema }).loose(),
  'pixel.conversion.replace': z.object({
    conversionDefaults: z.object({
      resample: z.literal('area'),
      paletteMetric: z.literal('oklab'),
      dithering: z.enum(['none', 'bayer-4x4', 'floyd-steinberg']),
      alphaThreshold: FiniteNumberSchema.min(0).max(1),
    }).strict(),
  }).loose(),
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
  'pixel.tilemap.set': z.object({
    mapId: IdSchema,
    layerId: IdSchema,
    changes: z.array(TileChangeSchema).max(1_000_000),
    expectedRevision: ExpectedRevisionSchema,
  }).loose(),
};

export const ActorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'agent', 'system']),
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6,8}$/),
});

export const CanvasOperationSchema = z
  .object({
    kind: OperationKindSchema,
  })
  .loose()
  .superRefine((value, context) => {
    const validator = TargetedOperationSchemas[value.kind];
    if (!validator) {
      if ((value.kind === 'illustration.object.add' || value.kind === 'illustration.object.replace') && typeof value.object === 'object' && value.object !== null && (value.object as { type?: unknown }).type === 'vector-stroke') {
        const result = z.object({ object: z.object({ points: z.array(PointSchema).max(1_000_000) }).loose() }).loose().safeParse(value);
        if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
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
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    name: z.string().min(1),
    kind: z.enum(['illustration', 'pixel']),
    createdAt: z.string(),
    updatedAt: z.string(),
    dirty: z.boolean(),
    assets: z.record(z.string(), z.unknown()),
    activity: z.array(z.unknown()),
    provenance: z.array(z.unknown()),
  })
  .loose()
  .transform((value) => value as unknown as AIDrawDocument);

export function validateDocument(value: unknown): AIDrawDocument {
  const document = PersistedDocumentSchema.parse(value);
  if (document.kind === 'illustration') {
    if (!Array.isArray(document.layerIds) || typeof document.layers !== 'object' || typeof document.objects !== 'object') {
      throw new Error('Invalid illustration document structure');
    }
  } else if (!Array.isArray(document.assetIds) || typeof document.pixelAssets !== 'object') {
    throw new Error('Invalid pixel document structure');
  }
  return document;
}

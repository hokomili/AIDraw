import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LATEST_PROTOCOL_VERSION, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  CanvasOperationSchema,
  MAX_WANG_TERRAIN_COORDINATE,
  MAX_WANG_TERRAIN_STROKE_POINTS,
  NewDocumentOptionsSchema,
  applyTextStyleRange,
  bitmapTextCells,
  createId,
  createPixelCelReader,
  createWangTerrainStrokeRandom,
  decodeTiledGid,
  deletePixelAnimationTag,
  duplicatePixelFrame,
  encodeTiledGid,
  floodPixelRegion,
  nowIso,
  orderedDitherIndex,
  placePixelStamp,
  placeTileStamp,
  planWangTerrainStroke,
  readPixel,
  readTileAt,
  replacePixelRegion,
  replaceAndDeletePaletteIndexOperations,
  replaceStyledText,
  reorderPixelFrame,
  resolvePixelCel,
  resolveTilesetForGid,
  stepPaletteByLuminance,
  setPixelFrameCelsLinked,
  setPixelFramePaletteOverride,
  transformPixelStamp,
  transformTileStamp,
  upsertPixelAnimationTag,
  validatePaletteCycle,
  type AIDrawDocument,
  type Actor,
  type AsyncJob,
  type CanvasOperation,
  type CanvasTransaction,
  type DocumentAsset,
  type IllustrationDocument,
  type IllustrationObject,
  type PixelDocument,
  type PixelCellRun,
  type PixelRegionResult,
  type PixelSprite,
} from '@aidraw/core';
import { alignIllustrationObjects, distributeIllustrationObjects } from '../common/alignment';
import { exportIllustrationFragment, exportPixelFragment, importDocumentFragmentOperations, documentFragmentBytes } from '../common/document-fragment';
import { buildPolishedGoldMaterial } from '../common/material-presets';
import { convertPathNode, deletePathNode, inspectPathNodes, insertPathNode, movePathPoint, setPathClosed, splitPathAtNode } from '../common/path-nodes';
import { transformPixelSelection } from '../common/pixel-selection';
import { scaleGridSelection } from '../common/grid-selection';
import { cropImageObject, cropImageToAspect, resetImageCrop } from '../common/image-crop';
import { createBooleanPath } from '../common/path-boolean';
import { convertPathArcsToCubics } from '../common/path-conversion';
import { joinPathObjects } from '../common/path-topology';
import { assignWangTile, deleteWangColor, deleteWangSet, upsertWangColor, upsertWangSet } from '../common/wang-authoring';
import { TILE_VARIANT_SEED_PROPERTY, chooseTileVariant } from '../common/tile-variants';
import { validateGenerationRequest } from '../common/generation-capabilities';
import type { GenerationRequest } from '../common/generation';
import { embedPixelLink, packPixelLinks } from '../common/pixel-links';
import { DocumentService } from './document-service';
import { BatchManager } from './batch-manager';
import { PlaybackScheduler } from './playback-scheduler';
import { plannedExportCompanionPaths, type ExportFormat } from './export-document';
import { quantizeImageToPalette } from './quantize-image';
import { captureObservation, MAX_OBSERVATION_PIXELS, type CaptureObservation } from './capture-observation';
import { projectLinkFileExtension, verifiedPixelLinkCache } from './pixel-link-files';
import { AIDRAW_GUIDE_URI, AIDRAW_HELP_TOPICS, AIDRAW_MCP_GUIDE, AIDRAW_SERVER_INSTRUCTIONS, aidrawHelp } from './mcp-guide';

const PORT_START = 48200;
const PORT_END = 48231;
const MAX_HTTP_BODY = 2 * 1024 * 1024;
const MAX_MCP_SESSIONS = 32;
const MAX_MCP_RESOURCE_SUBSCRIPTIONS = 128;
const AGENT_COLORS = ['#8268dd', '#e65f7d', '#2fa7a0', '#d58a35', '#4d83d1', '#a65dab'];

interface McpSession {
  mcp: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  actor: Actor;
  subscriptions: Set<string>;
  closed: boolean;
}

interface PortSettings { version: 1; preferredPort: number }
interface FolderTrustSettings { version: 1; folders: string[] }
type ApprovalDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';
type McpTransportDiagnosticCode = 'invalid_token' | 'initialization_required' | 'unsupported_protocol_version' | 'unknown_session';

const MCP_TRANSPORT_DIAGNOSTICS: Record<McpTransportDiagnosticCode, { message: string; next: string }> = {
  invalid_token: {
    message: 'Authentication failed; the bearer is absent, invalid, rotated, or revoked.',
    next: "Review Activity's current access state. Leave access revoked if it should remain disabled. Otherwise, if access is revoked, use Rotate and re-enable; then refresh the intended configuration profile through its Connect or Show settings path before initializing a fresh transport and joining again. Never retry a copied or stale bearer.",
  },
  initialization_required: {
    message: 'This stateful legacy endpoint requires initialization before other requests.',
    next: `Initialize without Mcp-Session-Id, retain the returned session ID and negotiated ${LATEST_PROTOCOL_VERSION} protocol version, then call session_manage with action=join.`,
  },
  unsupported_protocol_version: {
    message: 'MCP-Protocol-Version is missing or unsupported for this initialized stateful legacy session.',
    next: `Send the exact negotiated ${LATEST_PROTOCOL_VERSION} value. If it was not retained, discard Mcp-Session-Id and initialize a fresh transport.`,
  },
  unknown_session: {
    message: 'The supplied process-lifetime MCP session is unknown or stale.',
    next: 'Discard Mcp-Session-Id, initialize a fresh transport without it, then call session_manage with action=join again.',
  },
};

function writeMcpTransportDiagnostic(
  response: ServerResponse,
  status: 400 | 401 | 404,
  error: McpTransportDiagnosticCode,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify({
    error,
    profile: 'stateful-legacy',
    protocolVersion: LATEST_PROTOCOL_VERSION,
    ...MCP_TRANSPORT_DIAGNOSTICS[error],
  }));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parsePreferredPortSettings(value: unknown): number | undefined {
  if (!plainRecord(value) || !hasExactKeys(value, ['version', 'preferredPort']) || value.version !== 1
    || !Number.isInteger(value.preferredPort) || Number(value.preferredPort) < PORT_START || Number(value.preferredPort) > PORT_END) return undefined;
  return Number(value.preferredPort);
}

export function parseFolderTrustSettings(value: unknown): string[] | undefined {
  if (!plainRecord(value) || !hasExactKeys(value, ['version', 'folders']) || value.version !== 1 || !Array.isArray(value.folders)) return undefined;
  const folders: string[] = [];
  const seen = new Set<string>();
  for (const folder of value.folders) {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0') || seen.has(folder)) return undefined;
    seen.add(folder); folders.push(folder);
  }
  return folders;
}

async function writePrivateMcpSettings(filePath: string, value: PortSettings | FolderTrustSettings): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  let openHandle = true;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    openHandle = false;
    await rename(temporary, filePath);
  } catch (error) {
    if (openHandle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export type GenerationApprovalPreviewRenderer = (
  asset: DocumentAsset,
) => Promise<{ width: number; height: number; previewPng: Buffer }>;

const ObservationRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
const ObservationBackgroundSchema = z.union([
  z.enum(['document', 'transparent']),
  z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
]);
const SpriteSheetImportOptionsSchema = z.object({
  frameWidth: z.number().int().min(1).max(8_192),
  frameHeight: z.number().int().min(1).max(8_192),
  marginX: z.number().int().min(0).max(8_191).default(0),
  marginY: z.number().int().min(0).max(8_191).default(0),
  spacingX: z.number().int().min(0).max(8_191).default(0),
  spacingY: z.number().int().min(0).max(8_191).default(0),
  frameCount: z.number().int().min(1).max(4_096).optional(),
  order: z.enum(['rows', 'columns']).default('rows'),
  durationMs: z.number().int().min(1).max(60_000).default(100),
  trimTransparent: z.boolean().default(false),
  skipEmpty: z.boolean().default(false),
}).strict();
const AgentQuantizeOperationSchema = z.object({
  kind: z.literal('pixel.image.quantize'),
  assetId: z.string().min(1),
  spriteId: z.string().min(1),
  celId: z.string().min(1),
  x: z.number().int().nonnegative().default(0),
  y: z.number().int().nonnegative().default(0),
  width: z.number().int().min(1).max(8_192).optional(),
  height: z.number().int().min(1).max(8_192).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();
const ExpectedRevisionsSchema = z.record(z.string(), z.number().int().nonnegative());
const SemanticPixelRegionSchema = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const PixelFloodFillSchema = z.object({ kind: z.literal('pixel.flood-fill'), spriteId: z.string().min(1), celId: z.string().min(1), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), index: z.number().int().min(0).max(255), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelReplaceColorSchema = z.object({ kind: z.literal('pixel.replace-color'), spriteId: z.string().min(1), celId: z.string().min(1), fromIndex: z.number().int().min(0).max(255), toIndex: z.number().int().min(0).max(255), region: SemanticPixelRegionSchema.optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelPaletteReplaceDeleteSchema = z.object({ kind: z.literal('pixel.palette.replace-delete'), sourceIndex: z.number().int().min(1).max(255), replacementIndex: z.number().int().min(0).max(255), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelAdjustIndexSchema = z.object({ kind: z.literal('pixel.adjust-index'), spriteId: z.string().min(1), celId: z.string().min(1), delta: z.number().int().min(-255).max(255).refine((value) => value !== 0), order: z.enum(['index', 'luminance']).default('index'), region: SemanticPixelRegionSchema.optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelOrderedDitherSchema = z.object({ kind: z.literal('pixel.ordered-dither'), spriteId: z.string().min(1), celId: z.string().min(1), region: SemanticPixelRegionSchema, indexA: z.number().int().min(0).max(255), indexB: z.number().int().min(0).max(255), coverage: z.number().min(0).max(1), matrixSize: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4), phaseX: z.number().int().min(-8_192).max(8_192).default(0), phaseY: z.number().int().min(-8_192).max(8_192).default(0), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelBitmapTextSchema = z.object({ kind: z.literal('pixel.bitmap-text.paint'), spriteId: z.string().min(1), celId: z.string().min(1), fontId: z.string().min(1), text: z.string().min(1).max(2_000), x: z.number().int().min(-8_192).max(8_192), y: z.number().int().min(-8_192).max(8_192), index: z.number().int().min(0).max(255), letterSpacing: z.number().int().min(0).max(32).default(0), lineSpacing: z.number().int().min(0).max(64).default(0), scale: z.number().int().min(1).max(16).default(1), align: z.enum(['left', 'center', 'right']).default('left'), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelSelectionTransformSchema = z.object({
  kind: z.literal('pixel.selection.transform'),
  spriteId: z.string().min(1),
  celId: z.string().min(1),
  runs: z.array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), length: z.number().int().min(1).max(65_536) }).strict()).min(1).max(65_536),
  transform: z.enum(['move', 'flip-horizontal', 'flip-vertical', 'rotate-clockwise', 'rotate-counterclockwise', 'scale']),
  offsetX: z.number().int().min(-8_192).max(8_192).default(0),
  offsetY: z.number().int().min(-8_192).max(8_192).default(0),
  scaleX: z.number().int().min(1).max(64).default(1),
  scaleY: z.number().int().min(1).max(64).default(1),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
const PixelFrameDuplicateSchema = z.object({ kind: z.literal('pixel.frame.duplicate'), spriteId: z.string().min(1), frameId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelFrameMoveSchema = z.object({ kind: z.literal('pixel.frame.move'), spriteId: z.string().min(1), frameId: z.string().min(1), direction: z.enum(['left', 'right']), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelFrameCelsLinkSchema = z.object({ kind: z.literal('pixel.frame.cels.link'), spriteId: z.string().min(1), frameId: z.string().min(1), linked: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelFrameDurationSchema = z.object({ kind: z.literal('pixel.frame.duration.set'), spriteId: z.string().min(1), frameId: z.string().min(1), durationMs: z.number().int().min(1).max(60_000), expectedRevision: z.number().int().nonnegative() }).strict();
const AnimationTagInputSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(200), fromFrameId: z.string().min(1), toFrameId: z.string().min(1), direction: z.enum(['forward', 'reverse', 'ping-pong']), color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/) }).strict();
const PixelAnimationTagUpsertSchema = z.object({ kind: z.literal('pixel.animation.tag.upsert'), spriteId: z.string().min(1), tag: AnimationTagInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const PixelAnimationTagDeleteSchema = z.object({ kind: z.literal('pixel.animation.tag.delete'), spriteId: z.string().min(1), tagId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelPaletteOverrideSchema = z.object({ kind: z.literal('pixel.palette-override.set'), spriteId: z.string().min(1), frameId: z.string().min(1), colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/)).min(1).max(256).nullable(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelProjectLinkEmbedSchema = z.object({ kind: z.literal('pixel.project-link.embed'), linkId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelProjectLinksPackSchema = z.object({ kind: z.literal('pixel.project-links.pack'), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelStampPlaceSchema = z.object({ kind: z.literal('pixel.stamp.place'), stampId: z.string().min(1), spriteId: z.string().min(1), celId: z.string().min(1), x: z.number().int().min(-8_192).max(16_384), y: z.number().int().min(-8_192).max(16_384), transform: z.enum(['flip-horizontal', 'flip-vertical', 'rotate-clockwise', 'rotate-counterclockwise']).optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelTileStampPlaceSchema = z.object({ kind: z.literal('pixel.tile-stamp.place'), stampId: z.string().min(1), mapId: z.string().min(1), layerId: z.string().min(1), x: z.number().int().min(-16_777_216).max(16_777_216), y: z.number().int().min(-16_777_216).max(16_777_216), transform: z.enum(['flip-horizontal', 'flip-vertical', 'rotate-clockwise', 'rotate-counterclockwise']).optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelTileVariantsPaintSchema = z.object({ kind: z.literal('pixel.tile-variants.paint'), mapId: z.string().min(1), layerId: z.string().min(1), tilesetId: z.string().min(1), tileId: z.number().int().nonnegative(), points: z.array(z.object({ x: z.number().int().min(-16_777_216).max(16_777_216), y: z.number().int().min(-16_777_216).max(16_777_216) }).strict()).min(1).max(65_536), seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(), transforms: z.object({ hFlip: z.boolean().default(false), vFlip: z.boolean().default(false), diagonal: z.boolean().default(false) }).strict().optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelWangTerrainStrokeSchema = z.object({ kind: z.literal('pixel.wang-terrain.stroke'), mapId: z.string().min(1).max(200), layerId: z.string().min(1).max(200), tilesetId: z.string().min(1).max(200), wangSetId: z.string().min(1).max(200), colorId: z.number().int().min(1).max(255), mode: z.enum(['paint', 'erase']), points: z.array(z.object({ x: z.number().int().min(-MAX_WANG_TERRAIN_COORDINATE).max(MAX_WANG_TERRAIN_COORDINATE), y: z.number().int().min(-MAX_WANG_TERRAIN_COORDINATE).max(MAX_WANG_TERRAIN_COORDINATE) }).strict()).min(1).max(MAX_WANG_TERRAIN_STROKE_POINTS), expectedRevision: z.number().int().nonnegative() }).strict();
const MapObjectInputSchema = z.object({ id: z.string().min(1), type: z.enum(['rectangle', 'ellipse', 'polygon', 'polyline']), x: z.number().finite().min(-16_777_216).max(16_777_216), y: z.number().finite().min(-16_777_216).max(16_777_216), width: z.number().finite().positive().max(16_777_216).optional(), height: z.number().finite().positive().max(16_777_216).optional(), points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).max(65_536).optional(), properties: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])) }).strict().superRefine((object, context) => { if ((object.type === 'rectangle' || object.type === 'ellipse') && (object.width === undefined || object.height === undefined)) context.addIssue({ code: 'custom', message: 'Rectangle and ellipse map objects require width and height.' }); if ((object.type === 'polygon' || object.type === 'polyline') && (!object.points || object.points.length < 2)) context.addIssue({ code: 'custom', path: ['points'], message: 'Polygon and polyline map objects require at least two points.' }); });
const PixelMapObjectUpsertSchema = z.object({ kind: z.literal('pixel.map-object.upsert'), mapId: z.string().min(1), layerId: z.string().min(1), object: MapObjectInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const PixelMapObjectDeleteSchema = z.object({ kind: z.literal('pixel.map-object.delete'), mapId: z.string().min(1), layerId: z.string().min(1), objectId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelTilesetCollisionUpsertSchema = z.object({ kind: z.literal('pixel.tileset-collision.upsert'), tilesetId: z.string().min(1), tileId: z.number().int().nonnegative(), shape: MapObjectInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const PixelTilesetCollisionDeleteSchema = z.object({ kind: z.literal('pixel.tileset-collision.delete'), tilesetId: z.string().min(1), tileId: z.number().int().nonnegative(), shapeId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const WangColorInputSchema = z.object({ id: z.number().int().min(1).max(255), name: z.string().trim().min(1).max(100), color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/), tileId: z.number().int().nonnegative(), probability: z.number().finite().nonnegative() }).strict();
const WangIdInputSchema = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);
const WangTileInputSchema = z.object({ tileId: z.number().int().nonnegative(), wangId: WangIdInputSchema }).strict();
const WangSetInputSchema = z.object({ id: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), type: z.enum(['edge', 'corner', 'mixed']), colors: z.array(WangColorInputSchema).max(255), tiles: z.array(WangTileInputSchema).max(65_536) }).strict();
const PixelWangSetUpsertSchema = z.object({ kind: z.literal('pixel.wang-set.upsert'), tilesetId: z.string().min(1), wangSet: WangSetInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const PixelWangSetDeleteSchema = z.object({ kind: z.literal('pixel.wang-set.delete'), tilesetId: z.string().min(1), wangSetId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelWangColorUpsertSchema = z.object({ kind: z.literal('pixel.wang-color.upsert'), tilesetId: z.string().min(1), wangSetId: z.string().min(1), color: WangColorInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const PixelWangColorDeleteSchema = z.object({ kind: z.literal('pixel.wang-color.delete'), tilesetId: z.string().min(1), wangSetId: z.string().min(1), colorId: z.number().int().min(1).max(255), expectedRevision: z.number().int().nonnegative() }).strict();
const PixelWangTileAssignSchema = z.object({ kind: z.literal('pixel.wang-tile.assign'), tilesetId: z.string().min(1), wangSetId: z.string().min(1), tile: WangTileInputSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationAlignSchema = z.object({ kind: z.literal('illustration.objects.align'), objectIds: z.array(z.string().min(1)).min(1).max(256), expectedRevisions: ExpectedRevisionsSchema, mode: z.enum(['left', 'center-x', 'right', 'top', 'center-y', 'bottom']), target: z.enum(['artboard', 'selection', 'key-object']).default('selection'), keyObjectId: z.string().min(1).optional() }).strict();
const IllustrationDistributeSchema = z.object({ kind: z.literal('illustration.objects.distribute'), objectIds: z.array(z.string().min(1)).min(3).max(256), expectedRevisions: ExpectedRevisionsSchema, axis: z.enum(['x', 'y']), mode: z.enum(['centers', 'spacing']).default('centers') }).strict();
const IllustrationBooleanSchema = z.object({ kind: z.literal('illustration.path.boolean'), objectIds: z.tuple([z.string().min(1), z.string().min(1)]), expectedRevisions: ExpectedRevisionsSchema, mode: z.enum(['union', 'subtract', 'intersect', 'exclude']) }).strict();
const IllustrationMaterialSchema = z.object({ kind: z.literal('illustration.material.apply'), objectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), preset: z.literal('polished-gold') }).strict();
const IllustrationGradientSetSchema = z.object({
  kind: z.literal('illustration.gradient.set'),
  objectId: z.string().min(1),
  gradientKind: z.enum(['linear-gradient', 'radial-gradient']),
  x1: z.number().finite(), y1: z.number().finite(), x2: z.number().finite(), y2: z.number().finite(),
  stops: z.array(z.object({ offset: z.number().finite().min(0).max(1), color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/), opacity: z.number().finite().min(0).max(1).optional() }).strict()).min(2).max(32),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
const IllustrationImageCropSchema = z.object({
  kind: z.literal('illustration.image.crop'), objectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), action: z.enum(['rectangle', 'aspect', 'reset']),
  rectangle: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
  aspect: z.number().finite().positive().max(1_000).optional(),
}).strict().superRefine((operation, context) => {
  if (operation.action === 'rectangle' && !operation.rectangle) context.addIssue({ code: 'custom', path: ['rectangle'], message: 'Rectangle crop requires display-space bounds.' });
  if (operation.action === 'aspect' && operation.aspect === undefined) context.addIssue({ code: 'custom', path: ['aspect'], message: 'Aspect crop requires a positive ratio.' });
  if (operation.action !== 'rectangle' && operation.rectangle) context.addIssue({ code: 'custom', path: ['rectangle'], message: 'Rectangle bounds are only valid for rectangle crops.' });
  if (operation.action !== 'aspect' && operation.aspect !== undefined) context.addIssue({ code: 'custom', path: ['aspect'], message: 'Aspect is only valid for aspect crops.' });
});
const IllustrationImageFiltersSchema = z.object({
  kind: z.enum(['illustration.image.filters.replace', 'illustration.object.filters.replace']), objectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  filters: z.array(z.object({ type: z.enum(['brightness', 'contrast', 'saturation', 'hue', 'blur']), value: z.number().finite() }).strict().superRefine((filter, context) => {
    const valid = filter.type === 'hue' ? filter.value >= -180 && filter.value <= 180 : filter.type === 'blur' ? filter.value >= 0 && filter.value <= 40 : filter.value >= -1 && filter.value <= 1;
    if (!valid) context.addIssue({ code: 'custom', path: ['value'], message: `Filter value is outside the supported ${filter.type} range.` });
  })).max(64),
}).strict();
const IllustrationLayerFiltersSchema = z.object({ kind: z.literal('illustration.layer.filters.replace'), layerId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), filters: IllustrationImageFiltersSchema.shape.filters }).strict();
const IllustrationObjectMaskSchema = z.object({ kind: z.literal('illustration.object.mask.set'), objectIds: z.array(z.string().min(1)).min(1).max(256), maskObjectId: z.string().min(1).nullable(), expectedRevisions: ExpectedRevisionsSchema }).strict();
const IllustrationLayerMaskSchema = z.object({ kind: z.literal('illustration.layer.mask.set'), layerId: z.string().min(1), maskLayerId: z.string().min(1).nullable(), expectedRevision: z.number().int().nonnegative() }).strict();
const TextStylePatchSchema = z.object({
  fontFamily: z.string().trim().min(1).max(200).optional(), fontSize: z.number().finite().min(1).max(500).optional(), fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/).optional(), letterSpacing: z.number().finite().min(-20).max(100).optional(), underline: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'At least one text style field is required.');
const IllustrationTextStyleSchema = z.object({ kind: z.literal('illustration.text.style'), objectId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().positive(), style: TextStylePatchSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationTextContentSchema = z.object({ kind: z.literal('illustration.text.content.set'), objectId: z.string().min(1), text: z.string().max(100_000), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathNodeMoveSchema = z.object({ kind: z.literal('illustration.path.node.move'), objectId: z.string().min(1), nodeIndex: z.number().int().nonnegative(), point: z.enum(['anchor', 'in', 'out']), x: z.number().finite(), y: z.number().finite(), mirror: z.boolean().default(false), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathNodeInsertSchema = z.object({ kind: z.literal('illustration.path.node.insert'), objectId: z.string().min(1), segmentIndex: z.number().int().nonnegative(), time: z.number().finite().gt(0).lt(1).default(0.5), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathNodeDeleteSchema = z.object({ kind: z.literal('illustration.path.node.delete'), objectId: z.string().min(1), nodeIndex: z.number().int().nonnegative(), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathNodeConvertSchema = z.object({ kind: z.literal('illustration.path.node.convert'), objectId: z.string().min(1), nodeIndex: z.number().int().nonnegative(), nodeKind: z.enum(['corner', 'smooth']), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathClosedSchema = z.object({ kind: z.literal('illustration.path.closed.set'), objectId: z.string().min(1), closed: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathArcConvertSchema = z.object({ kind: z.literal('illustration.path.arcs.convert'), objectId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathSplitSchema = z.object({ kind: z.literal('illustration.path.split'), objectId: z.string().min(1), nodeIndex: z.number().int().nonnegative(), newObjectId: z.string().min(1).max(500).optional(), expectedRevision: z.number().int().nonnegative() }).strict();
const IllustrationPathJoinSchema = z.object({
  kind: z.literal('illustration.path.join'),
  primaryObjectId: z.string().min(1),
  secondaryObjectId: z.string().min(1),
  endpoints: z.enum(['nearest', 'end-start', 'start-end', 'start-start', 'end-end']).default('nearest'),
  expectedRevisions: ExpectedRevisionsSchema,
}).strict().refine((operation) => operation.primaryObjectId !== operation.secondaryObjectId, 'Join targets must be different paths.');
const DocumentFragmentImportSchema = z.object({
  kind: z.literal('document.fragment.import'),
  fragment: z.unknown(),
  targetLayerId: z.string().min(1).optional(),
  offsetX: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  offsetY: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
}).strict();
const ObservationFragmentSchema = z.object({
  kind: z.enum(['illustration-objects', 'pixel-assets']),
  objectIds: z.array(z.string().min(1)).min(1).max(192).optional(),
  assetId: z.string().min(1).optional(),
}).strict();

const DocumentIdInputSchema = z.string().min(1).describe('Canonical open document ID returned by document_manage action=list, session_manage, or canvas_observe.');
const JobIdInputSchema = z.string().min(1).describe('Owner-scoped job ID returned by an approval, generation, or batch-starting tool.');
function enforceActionInput(value: unknown, context: z.core.$RefinementCtx, schema: z.ZodType): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
}

const SessionManageStrictInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('join').describe('Join/update this authenticated agent presence.'),
    name: z.string().min(1).max(80).optional().describe('Human-readable agent name shown in AIDraw presence and attribution.'),
    color: z.string().optional().describe('Preferred #RRGGBB actor color; invalid values fall back to the assigned session color.'),
    documentId: DocumentIdInputSchema.optional().describe('Optional document in which to publish this presence.'),
    model: z.string().trim().min(1).max(200).optional().describe('Descriptive client model metadata; not platform-attested.'),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().describe('Descriptive reasoning-effort metadata.'),
    taskId: z.string().trim().min(1).max(200).optional().describe('Descriptive external task identifier.'),
  }).strict().describe('Join and optionally identify the authenticated agent.'),
  z.object({ action: z.literal('inspect').describe('Read presence, active document, human occupancy, and advisory editor state.'), documentId: DocumentIdInputSchema.optional() }).strict(),
  z.object({ action: z.literal('leave').describe('Remove this session from live presence without closing documents or the MCP session.') }).strict(),
]).describe('Action-specific AIDraw session contract.');
const SessionManageInputSchema = z.object({
  action: z.enum(['join', 'inspect', 'leave']).describe('Session action. The server strictly rejects fields that do not belong to the selected action.'),
  name: z.string().min(1).max(80).optional().describe('join only: human-readable agent name shown in AIDraw presence and attribution.'),
  color: z.string().optional().describe('join only: preferred #RRGGBB actor color; invalid values fall back to the assigned session color.'),
  documentId: DocumentIdInputSchema.optional().describe('join/inspect only: optional document in which to publish or inspect presence.'),
  model: z.string().trim().min(1).max(200).optional().describe('join only: descriptive client model metadata; not platform-attested.'),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().describe('join only: descriptive reasoning-effort metadata.'),
  taskId: z.string().trim().min(1).max(200).optional().describe('join only: descriptive external task identifier.'),
}).strict().superRefine((value, context) => enforceActionInput(value, context, SessionManageStrictInputSchema))
  .describe('Flat discovery contract for client compatibility; the server still enforces the selected action’s strict field set.');

const HistoryDocumentIdSchema = DocumentIdInputSchema.optional().describe('Optional target; omitted means the active document.');
const HistoryManageStrictInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('undo'), documentId: HistoryDocumentIdSchema }).strict().describe('Undo this authenticated actor’s latest transaction.'),
  z.object({ action: z.literal('redo'), documentId: HistoryDocumentIdSchema }).strict().describe('Redo this authenticated actor’s latest undone transaction.'),
  z.object({ action: z.literal('replay'), documentId: HistoryDocumentIdSchema, transactionId: z.string().min(1).describe('Durable transaction ID obtained from trace/history.') }).strict().describe('Start one bounded, non-mutating trace replay.'),
  z.object({ action: z.literal('checkpoint-list'), documentId: HistoryDocumentIdSchema }).strict().describe('List named checkpoints for one document.'),
  z.object({ action: z.literal('checkpoint-create'), documentId: HistoryDocumentIdSchema, name: z.string().trim().min(1).max(80).describe('Human-readable attributed checkpoint name.') }).strict(),
  z.object({ action: z.literal('checkpoint-restore'), documentId: HistoryDocumentIdSchema, checkpointId: z.string().min(1).describe('Checkpoint ID returned by checkpoint-list/create.') }).strict(),
  z.object({ action: z.literal('checkpoint-merge'), documentId: HistoryDocumentIdSchema, checkpointId: z.string().min(1).describe('Source checkpoint ID.'), sourceIds: z.array(z.string().min(1)).min(1).max(32).describe('Top-level checkpoint layer-tree or pixel-asset IDs to copy with dependency closure.') }).strict(),
  z.object({ action: z.literal('checkpoint-delete'), documentId: HistoryDocumentIdSchema, checkpointId: z.string().min(1).describe('Checkpoint ID; agents may delete only checkpoints they created.') }).strict(),
]).describe('Action-specific actor history, replay, and checkpoint contract.');
const HistoryManageInputSchema = z.object({
  action: z.enum(['undo', 'redo', 'replay', 'checkpoint-list', 'checkpoint-create', 'checkpoint-restore', 'checkpoint-merge', 'checkpoint-delete']).describe('History action. The server strictly rejects fields that do not belong to the selected action.'),
  documentId: HistoryDocumentIdSchema,
  transactionId: z.string().min(1).optional().describe('replay only: durable transaction ID obtained from trace/history.'),
  name: z.string().trim().min(1).max(80).optional().describe('checkpoint-create only: human-readable attributed checkpoint name.'),
  checkpointId: z.string().min(1).optional().describe('checkpoint-restore/merge/delete only: checkpoint ID returned by checkpoint-list/create.'),
  sourceIds: z.array(z.string().min(1)).min(1).max(32).optional().describe('checkpoint-merge only: top-level checkpoint layer-tree or pixel-asset IDs to copy with dependency closure.'),
}).strict().superRefine((value, context) => enforceActionInput(value, context, HistoryManageStrictInputSchema))
  .describe('Flat discovery contract for client compatibility; the server still enforces the selected action’s strict field set.');

const DocumentManageStrictInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list').describe('List open document summaries and activeDocumentId.') }).strict(),
  z.object({
    action: z.literal('new').describe('Create and activate a new in-memory document.'),
    kind: z.enum(['illustration', 'sprite', 'tilemap', 'project']).default('illustration').describe('Document kind; project is the multi-asset pixel-project surface.'),
    name: z.string().trim().min(1).max(200).optional().describe('Optional document name.'),
    width: z.number().int().min(1).max(8_192).optional().describe('Illustration/sprite/map width; defaults come from the shared new-document contract.'),
    height: z.number().int().min(1).max(8_192).optional().describe('Illustration/sprite/map height.'),
    background: z.union([z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/), z.null()]).optional().describe('Illustration background color or null for transparency.'),
    orientation: z.enum(['orthogonal', 'isometric']).optional().describe('Tilemap orientation; meaningful for tilemap/project creation.'),
    infinite: z.boolean().optional().describe('Whether a new tilemap uses signed sparse chunks.'),
    tileWidth: z.number().int().min(1).max(1_024).optional().describe('Tile width in pixels for tilemap creation.'),
    tileHeight: z.number().int().min(1).max(1_024).optional().describe('Tile height in pixels for tilemap creation.'),
  }).strict(),
  z.object({ action: z.literal('activate'), documentId: DocumentIdInputSchema }).strict().describe('Activate an already open document.'),
  z.object({ action: z.literal('open'), path: z.string().min(1).describe('Exact native .aidraw path to present for human file-read approval.') }).strict(),
  z.object({ action: z.literal('save'), documentId: DocumentIdInputSchema }).strict().describe('Request overwrite approval for the document’s existing canonical filePath.'),
  z.object({ action: z.literal('save-as'), documentId: DocumentIdInputSchema, path: z.string().min(1).describe('Exact destination; .aidraw is appended when absent.') }).strict(),
  z.object({ action: z.literal('close'), documentId: DocumentIdInputSchema }).strict().describe('Close without granting discard authority; dirty/save rules remain enforced.'),
]).describe('Action-specific AIDraw document lifecycle contract.');
const DocumentManageInputSchema = z.object({
  action: z.enum(['list', 'new', 'activate', 'open', 'save', 'save-as', 'close']).describe('Document action. The server strictly rejects fields that do not belong to the selected action.'),
  documentId: DocumentIdInputSchema.optional().describe('activate/save/save-as/close only: canonical open document ID.'),
  path: z.string().min(1).optional().describe('open/save-as only: exact native path presented for human approval.'),
  kind: z.enum(['illustration', 'sprite', 'tilemap', 'project']).optional().meta({ default: 'illustration' }).describe('new only: document kind; omitted means illustration.'),
  name: z.string().trim().min(1).max(200).optional().describe('new only: optional document name.'),
  width: z.number().int().min(1).max(8_192).optional().describe('new only: illustration/sprite/map width; defaults come from the shared new-document contract.'),
  height: z.number().int().min(1).max(8_192).optional().describe('new only: illustration/sprite/map height.'),
  background: z.unknown().optional().describe('new only: illustration #RRGGBB/#RRGGBBAA background or null for transparency; the server validates this strictly.'),
  orientation: z.enum(['orthogonal', 'isometric']).optional().describe('new only: tilemap orientation, meaningful for tilemap/project creation.'),
  infinite: z.boolean().optional().describe('new only: whether a tilemap uses signed sparse chunks.'),
  tileWidth: z.number().int().min(1).max(1_024).optional().describe('new only: tile width in pixels for tilemap creation.'),
  tileHeight: z.number().int().min(1).max(1_024).optional().describe('new only: tile height in pixels for tilemap creation.'),
}).strict().superRefine((value, context) => enforceActionInput(value, context, DocumentManageStrictInputSchema))
  .describe('Flat discovery contract for client compatibility; the server still enforces the selected action’s strict field set.');

const JobManageStrictInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list').describe('List privacy-redacted jobs owned by this authenticated actor.') }).strict(),
  z.object({ action: z.literal('inspect'), jobId: JobIdInputSchema }).strict(),
  z.object({ action: z.literal('wait'), jobId: JobIdInputSchema, timeoutMs: z.number().int().min(0).max(30_000).default(0).describe('Bounded long-poll duration; 0 returns current state immediately.') }).strict(),
  z.object({ action: z.literal('approve-dependent'), jobId: JobIdInputSchema }).strict().describe('Report a human approval dependency; this action cannot approve.'),
  z.object({ action: z.literal('cancel'), jobId: JobIdInputSchema }).strict().describe('Cancel owned nonterminal work; committed batch steps remain committed.'),
  z.object({ action: z.literal('start-batch'), documentId: DocumentIdInputSchema, totalTransactions: z.number().int().min(1).max(10_000).describe('Exact transaction count used for durable progress/sequence validation.'), label: z.string().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('resume-batch'), jobId: JobIdInputSchema, resumeToken: z.string().min(32).max(200).describe('Private opaque token returned only by start-batch; never expose it in logs or public summaries.') }).strict(),
]).describe('Action-specific owner-scoped async job and durable-batch contract.');
const JobManageInputSchema = z.object({
  action: z.enum(['list', 'inspect', 'wait', 'approve-dependent', 'cancel', 'start-batch', 'resume-batch']).describe('Job action. The server strictly rejects fields that do not belong to the selected action.'),
  jobId: JobIdInputSchema.optional().describe('inspect/wait/approve-dependent/cancel/resume-batch only: owner-scoped job ID.'),
  timeoutMs: z.number().int().min(0).max(30_000).optional().meta({ default: 0 }).describe('wait only: bounded long-poll duration; omitted or 0 returns current state immediately.'),
  documentId: DocumentIdInputSchema.optional().describe('start-batch only: canonical open document ID.'),
  totalTransactions: z.number().int().min(1).max(10_000).optional().describe('start-batch only: exact transaction count for durable progress/sequence validation.'),
  label: z.string().min(1).max(200).optional().describe('start-batch only: optional human-readable batch label.'),
  resumeToken: z.string().min(32).max(200).optional().describe('resume-batch only: private opaque token returned by start-batch; never expose it in logs or public summaries.'),
}).strict().superRefine((value, context) => enforceActionInput(value, context, JobManageStrictInputSchema))
  .describe('Flat discovery contract for client compatibility; the server still enforces the selected action’s strict field set.');

const HelpInputSchema = z.object({ topic: z.enum(AIDRAW_HELP_TOPICS).default('quickstart').describe('Progressive help topic; start with quickstart.') }).strict();
const NextStepSchema = z.object({
  tool: z.string().min(1).describe('Tool to call next.'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('Safe next-call arguments; placeholders are never secrets.'),
  guidance: z.string().min(1).describe('Why this step is next and any human/retry constraint.'),
}).strict();
type NextStep = z.infer<typeof NextStepSchema>;
const HelpOutputSchema = z.object({
  topic: z.enum(AIDRAW_HELP_TOPICS),
  summary: z.string(),
  steps: z.array(z.string()),
  invariants: z.array(z.string()),
  relatedTools: z.array(z.string()),
  examples: z.array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()), purpose: z.string() }).strict()),
  guideUri: z.literal(AIDRAW_GUIDE_URI),
}).strict();
const SessionManageOutputSchema = z.object({
  actor: z.record(z.string(), z.unknown()).describe('Authenticated server-owned actor identity used for presence and attribution.'),
  presence: z.array(z.record(z.string(), z.unknown())).describe('Current live agent presence summaries.'),
  workspace: z.record(z.string(), z.unknown()).describe('Active document ID, human occupancy, and advisory editor state.'),
  next: NextStepSchema.describe('Safe canonical discovery step after session inspection.'),
}).passthrough();
const CanvasObserveOutputSchema = z.object({
  document: z.unknown().optional().describe('Complete canonical document when a full snapshot was requested.'),
  changes: z.unknown().optional().describe('Canonical changes after sinceRevision when a diff was requested.'),
  revision: z.number().int().nonnegative().optional().describe('Revision of the returned document or checkpoint view.'),
  currentRevision: z.number().int().nonnegative().optional().describe('Current open-document revision; may differ from a checkpoint view revision.'),
  target: z.record(z.string(), z.unknown()).optional().describe('Resolved observation selectors.'),
  png: z.record(z.string(), z.unknown()).optional().describe('Optional bounded PNG evidence with dimensions, MIME type, and encoded data.'),
  comparison: z.record(z.string(), z.unknown()).optional().describe('Optional race-free before/after observation for the latest retained transaction.'),
  error: z.string().optional(), message: z.string().optional(),
}).passthrough();
const ApprovalToolOutputSchema = z.object({
  jobId: z.string().optional().describe('Owner-scoped job ID retained for job_manage.'),
  status: z.string().optional().describe('Current job or request status.'),
  expiresAt: z.string().optional().describe('Human-approval expiry when waiting-for-user.'),
  trust: z.string().optional().describe('Applied non-overwrite file authority, if any.'),
  error: z.string().optional(),
  message: z.string().optional(),
  next: NextStepSchema.optional(),
}).passthrough();
const CanvasConflictDetailSchema = z.object({
  entityId: z.string().optional().describe('Canonical entity whose revision or lock policy prevented the transaction.'),
  expectedRevision: z.number().int().nonnegative().optional().describe('Revision supplied by the rejected operation.'),
  actualRevision: z.number().int().nonnegative().optional().describe('Current canonical entity revision to use when re-observing and rebuilding intent.'),
  retryable: z.boolean().describe('Whether the same logical intent may be retried after re-observing state and honoring locks.'),
}).strict();
const CanvasApplyOutputSchema = z.object({
  status: z.enum(['committed', 'duplicate', 'conflict', 'busy', 'locked', 'cancelled']).describe('Canonical transaction outcome.'),
  revision: z.number().int().nonnegative().optional().describe('Resulting canonical document revision after commit.'),
  transactionId: z.string().optional(),
  message: z.string().optional(),
  conflict: CanvasConflictDetailSchema.optional().describe('Structured revision or lock conflict details; absent for outcomes without an entity-level conflict.'),
  next: NextStepSchema.optional(),
}).passthrough();
const JobManageOutputSchema = z.object({
  id: z.string().optional().describe('Owner-scoped job ID for a direct summary.'),
  kind: z.string().optional().describe('Sanitized lifecycle kind; raw request details remain private.'),
  status: z.string().optional().describe('Current lifecycle status.'),
  jobs: z.array(z.record(z.string(), z.unknown())).optional().describe('Privacy-redacted jobs owned by this authenticated actor.'),
  job: z.record(z.string(), z.unknown()).optional().describe('Privacy-redacted batch job summary returned by start/resume.'),
  resumeToken: z.string().optional().describe('Private batch capability returned only to the owning start call; retain it privately.'),
  nextSequence: z.number().int().nonnegative().optional().describe('Exact next durable-batch sequence.'),
  error: z.union([
    z.string(),
    z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().nonnegative().optional(),
    }).strict(),
  ]).optional(),
  message: z.string().optional(), next: NextStepSchema.optional(),
}).passthrough();

function jobNextStep(job: AsyncJob): NextStep | undefined {
  if (job.status === 'waiting-for-user') {
    return {
      tool: 'job_manage',
      arguments: { action: 'wait', jobId: job.id, timeoutMs: 1_000 },
      guidance: 'A human must review this request in AIDraw. Agents cannot approve it; wait, inspect, or cancel the owned job.',
    };
  }
  if (job.status === 'queued' || job.status === 'running') {
    return {
      tool: 'job_manage',
      arguments: { action: 'wait', jobId: job.id, timeoutMs: 1_000 },
      guidance: 'The job is incomplete. Wait for a terminal owner-scoped summary before observing canonical document state.',
    };
  }
  return undefined;
}

function canvasRetryNextStep(status: string, documentId: string): NextStep | undefined {
  if (!['conflict', 'busy', 'locked', 'cancelled'].includes(status)) return undefined;
  return {
    tool: 'canvas_observe',
    arguments: { documentId },
    guidance: 'Re-observe canonical state, honor human/agent locks and current revisions, then retry the same logical intent with a fresh clientOperationId only when appropriate.',
  };
}

function agentJobSummary(job: AsyncJob): Record<string, unknown> {
  const dependency = job.status === 'waiting-for-user' && job.approval
    ? {
        kind: 'user-approval',
        expiresAt: job.approval.expiresAt,
        permittedDecisions: [...job.approval.options],
        guidance: 'A human must review this request in AIDraw. job_manage cannot approve it.',
      }
    : undefined;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    actor: structuredClone(job.actor),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    message: job.message,
    error: job.error ? structuredClone(job.error) : undefined,
    batch: job.kind === 'batch' && job.result && typeof job.result === 'object'
      ? structuredClone(job.result as Record<string, unknown>)
      : undefined,
    dependency,
    next: jobNextStep(job),
  };
}

function compactIndexedChanges(changes: Array<{ x: number; y: number; index: number }>, offsetX: number, offsetY: number) {
  const runs: Array<{ x: number; y: number; length: number; index: number }> = [];
  const ordered = [...changes].sort((left, right) => left.y - right.y || left.x - right.x);
  for (const change of ordered) {
    const x = change.x + offsetX; const y = change.y + offsetY; const previous = runs.at(-1);
    if (previous && previous.y === y && previous.index === change.index && previous.x + previous.length === x && previous.length < 65_536) previous.length += 1;
    else runs.push({ x, y, length: 1, index: change.index });
  }
  return runs;
}

function pixelSemanticTarget(document: AIDrawDocument, spriteId: string, celId: string): { document: PixelDocument; sprite: PixelSprite; celId: string } {
  if (document.kind !== 'pixel') throw new Error('This semantic pixel operation requires a pixel document.');
  const sprite = document.pixelAssets[spriteId]; if (!sprite || sprite.type !== 'sprite') throw new Error(`Target sprite ${spriteId} does not exist.`);
  const requestedCel = sprite.cels[celId]; if (!requestedCel) throw new Error(`Target cel ${celId} does not exist in sprite ${sprite.id}.`);
  const cel = resolvePixelCel(sprite, requestedCel.id);
  if (!cel) throw new Error(`Cel ${requestedCel.id} has a cyclic or missing link.`);
  return { document, sprite, celId: cel.id };
}

function pixelSpriteTarget(document: AIDrawDocument, spriteId: string): PixelSprite {
  if (document.kind !== 'pixel') throw new Error('This semantic pixel operation requires a pixel document.');
  const sprite = document.pixelAssets[spriteId];
  if (!sprite || sprite.type !== 'sprite') throw new Error(`Target sprite ${spriteId} does not exist.`);
  return sprite;
}

function boundedPixelRegion(sprite: PixelSprite, region?: { x: number; y: number; width: number; height: number }) {
  const target = region ?? { x: 0, y: 0, width: sprite.width, height: sprite.height };
  if (target.x + target.width > sprite.width || target.y + target.height > sprite.height) throw new Error('Semantic pixel region must fit completely inside the sprite.');
  if (target.width * target.height > 1_000_000) throw new Error('Semantic pixel operations are limited to one million target cells.');
  return target;
}

function pixelRegionOperation(sprite: PixelSprite, celId: string, changes: Array<{ x: number; y: number; index: number }>, expectedRevision: number): CanvasOperation[] {
  if (changes.length === 0) throw new Error('The semantic pixel operation would not change any cells.');
  return [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId, runs: compactIndexedChanges(changes, 0, 0), expectedRevision }];
}

function pixelRunOperation(sprite: PixelSprite, celId: string, runs: PixelCellRun[], index: number, expectedRevision: number): CanvasOperation[] {
  if (runs.length === 0) throw new Error('The semantic pixel operation would not change any cells.');
  return [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId, runs: runs.map((run) => ({ ...run, index })), expectedRevision }];
}

function requirePixelToolRegion(action: string, result: PixelRegionResult): Extract<PixelRegionResult, { ok: true }> {
  if (result.ok) return result;
  const unit = result.reason === 'cells' ? 'cells' : 'row runs';
  throw new Error(`${action} is limited to ${result.limit.toLocaleString('en-US')} ${unit}; no pixels were changed.`);
}

function semanticObjects(document: AIDrawDocument, objectIds: string[], expectedRevisions: Record<string, number>): { document: IllustrationDocument; objects: IllustrationObject[] } {
  if (document.kind !== 'illustration') throw new Error('This semantic illustration operation requires an illustration document.');
  if (new Set(objectIds).size !== objectIds.length) throw new Error('Semantic object lists may not contain duplicates.');
  const objects = objectIds.map((id) => { const object = document.objects[id]; if (!object) throw new Error(`Object ${id} does not exist.`); if (expectedRevisions[id] === undefined) throw new Error(`expectedRevisions is missing ${id}.`); return object; });
  return { document, objects };
}

function semanticPath(document: AIDrawDocument, objectId: string): { document: IllustrationDocument; object: Extract<IllustrationObject, { type: 'path' }> } {
  if (document.kind !== 'illustration') throw new Error('Semantic path operations require an illustration document.');
  const object = document.objects[objectId];
  if (!object || object.type !== 'path') throw new Error(`Path object ${objectId} does not exist.`);
  return { document, object };
}

type QuantizeImage = typeof quantizeImageToPalette;

async function expandAgentCanvasOperation(document: AIDrawDocument, value: Record<string, unknown>, quantizeImage: QuantizeImage, actor: Actor): Promise<CanvasOperation[]> {
  if (value.kind === 'document.fragment.import') {
    const operation = DocumentFragmentImportSchema.parse(value);
    return importDocumentFragmentOperations(document, operation.fragment, {
      targetLayerId: operation.targetLayerId,
      offsetX: operation.offsetX,
      offsetY: operation.offsetY,
    });
  }
  if (value.kind === 'pixel.image.quantize') {
    const operation = AgentQuantizeOperationSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const asset = target.document.assets[operation.assetId];
    if (!asset?.data) throw new Error(`Source asset ${operation.assetId} has no embedded raster data.`);
    const width = operation.width ?? target.sprite.width - operation.x; const height = operation.height ?? target.sprite.height - operation.y;
    boundedPixelRegion(target.sprite, { x: operation.x, y: operation.y, width, height }); const settings = target.document.conversionDefaults;
    const changes = await quantizeImage(Buffer.from(asset.data, 'base64'), width, height, target.document.palette, { alphaThreshold: settings.alphaThreshold, dithering: settings.dithering, includeTransparent: true });
    return [{
      kind: 'pixel.cel.region', spriteId: target.sprite.id, celId: target.celId, runs: compactIndexedChanges(changes, operation.x, operation.y), expectedRevision: operation.expectedRevision,
      conversion: { sourceAssetId: asset.id, resample: settings.resample, paletteMetric: settings.paletteMetric, dithering: settings.dithering, alphaThreshold: settings.alphaThreshold, width, height },
    }];
  }
  if (value.kind === 'pixel.palette.replace-delete') {
    const operation = PixelPaletteReplaceDeleteSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Palette replacement requires a pixel document.');
    if (operation.expectedRevision !== document.revision) throw new Error(`Pixel document revision changed from ${operation.expectedRevision} to ${document.revision}; observe and retry.`);
    return replaceAndDeletePaletteIndexOperations(document, operation.sourceIndex, operation.replacementIndex);
  }
  if (value.kind === 'pixel.flood-fill') {
    const operation = PixelFloodFillSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId);
    if (operation.x >= target.sprite.width || operation.y >= target.sprite.height) throw new Error('Flood-fill seed is outside the sprite.');
    if (operation.index >= target.document.palette.length) throw new Error('Flood-fill palette index does not exist.');
    const cel = target.sprite.cels[target.celId]; const read = createPixelCelReader(cel); const sourceIndex = read(operation.x, operation.y); if (sourceIndex === operation.index) throw new Error('Flood fill already has the requested index.');
    const region = requirePixelToolRegion('Pixel flood fill', floodPixelRegion({ width: target.sprite.width, height: target.sprite.height, start: { x: operation.x, y: operation.y }, read }));
    return pixelRunOperation(target.sprite, target.celId, region.runs, operation.index, operation.expectedRevision);
  }
  if (value.kind === 'pixel.replace-color') {
    const operation = PixelReplaceColorSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const region = boundedPixelRegion(target.sprite, operation.region);
    if (operation.toIndex >= target.document.palette.length) throw new Error('Replacement palette index does not exist.');
    if (operation.fromIndex === operation.toIndex) throw new Error('Source and replacement palette indices are identical.');
    const cel = target.sprite.cels[target.celId]; const read = createPixelCelReader(cel);
    const replacement = requirePixelToolRegion('Pixel color replacement', replacePixelRegion({ width: target.sprite.width, height: target.sprite.height, region, matchIndex: operation.fromIndex, read }));
    return pixelRunOperation(target.sprite, target.celId, replacement.runs, operation.toIndex, operation.expectedRevision);
  }
  if (value.kind === 'pixel.adjust-index') {
    const operation = PixelAdjustIndexSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const region = boundedPixelRegion(target.sprite, operation.region); const cel = target.sprite.cels[target.celId]; const changes: Array<{ x: number; y: number; index: number }> = [];
    for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) { const current = readPixel(cel, x, y); if (!current) continue; const index = operation.order === 'luminance' ? stepPaletteByLuminance(target.document.palette, current, operation.delta > 0 ? 'lighter' : 'darker') : Math.max(1, Math.min(target.document.palette.length - 1, current + operation.delta)); if (index !== current) changes.push({ x, y, index }); }
    return pixelRegionOperation(target.sprite, target.celId, changes, operation.expectedRevision);
  }
  if (value.kind === 'pixel.ordered-dither') {
    const operation = PixelOrderedDitherSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const region = boundedPixelRegion(target.sprite, operation.region);
    if (operation.indexA >= target.document.palette.length || operation.indexB >= target.document.palette.length) throw new Error('Dither palette index does not exist.');
    const changes: Array<{ x: number; y: number; index: number }> = [];
    for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) changes.push({ x, y, index: orderedDitherIndex(x, y, operation.indexA, operation.indexB, operation.coverage, operation.matrixSize, operation.phaseX, operation.phaseY) });
    return pixelRegionOperation(target.sprite, target.celId, changes, operation.expectedRevision);
  }
  if (value.kind === 'pixel.bitmap-text.paint') {
    const operation = PixelBitmapTextSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const font = target.document.bitmapFonts.find((entry) => entry.id === operation.fontId); if (!font) throw new Error(`Bitmap font ${operation.fontId} does not exist.`); if (operation.index >= target.document.palette.length) throw new Error(`Palette index ${operation.index} does not exist.`);
    const points = bitmapTextCells(font, operation.text, operation).filter((point) => point.x >= 0 && point.y >= 0 && point.x < target.sprite.width && point.y < target.sprite.height); if (!points.length) throw new Error('Bitmap text falls completely outside the sprite.');
    return pixelRegionOperation(target.sprite, target.celId, points.map((point) => ({ ...point, index: operation.index })), operation.expectedRevision);
  }
  if (value.kind === 'pixel.selection.transform') {
    const operation = PixelSelectionTransformSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId); const points: Array<{ x: number; y: number }> = []; let total = 0;
    for (const run of operation.runs) {
      total += run.length; if (total > 1_000_000) throw new Error('Pixel selection transforms are limited to one million cells.');
      if (run.x + run.length > target.sprite.width || run.y >= target.sprite.height) throw new Error('Every selection run must fit completely inside the sprite.');
      for (let offset = 0; offset < run.length; offset += 1) points.push({ x: run.x + offset, y: run.y });
    }
    if (operation.transform === 'move' && operation.offsetX === 0 && operation.offsetY === 0) throw new Error('A move selection transform requires a non-zero offset.');
    if (operation.transform !== 'move' && (operation.offsetX !== 0 || operation.offsetY !== 0)) throw new Error('Selection offsets are only valid for move transforms.');
    if (operation.transform !== 'scale' && (operation.scaleX !== 1 || operation.scaleY !== 1)) throw new Error('Scale factors are only valid for scale transforms.');
    if (operation.transform === 'scale' && operation.scaleX === 1 && operation.scaleY === 1) throw new Error('A scale transform requires at least one factor greater than one.');
    const cel = target.sprite.cels[target.celId];
    const changes = operation.transform === 'scale'
      ? scaleGridSelection(points, (x, y) => readPixel(cel, x, y), operation.scaleX, operation.scaleY, { width: target.sprite.width, height: target.sprite.height }, 0).changes.map((entry) => ({ x: entry.x, y: entry.y, index: entry.value }))
      : transformPixelSelection(points, (x, y) => readPixel(cel, x, y), operation.transform, { width: target.sprite.width, height: target.sprite.height }, { x: operation.offsetX, y: operation.offsetY }).changes;
    return [{ kind: 'pixel.cel.region', spriteId: target.sprite.id, celId: target.celId, runs: compactIndexedChanges(changes, 0, 0), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.frame.duplicate') {
    const operation = PixelFrameDuplicateSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    const duplicate = duplicatePixelFrame(target, operation.frameId, { actorId: actor.id, timestamp: nowIso() });
    return [{ kind: 'pixel.frame.add', spriteId: target.id, ...duplicate, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.frame.move') {
    const operation = PixelFrameMoveSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    return [{ kind: 'pixel.asset.replace', asset: reorderPixelFrame(target, operation.frameId, operation.direction === 'left' ? -1 : 1), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.frame.cels.link') {
    const operation = PixelFrameCelsLinkSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    return [{ kind: 'pixel.asset.replace', asset: setPixelFrameCelsLinked(target, operation.frameId, operation.linked), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.frame.duration.set') {
    const operation = PixelFrameDurationSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId); const frame = target.frames[operation.frameId];
    if (!frame) throw new Error(`Frame ${operation.frameId} does not exist.`);
    return [{ kind: 'pixel.frame.replace', spriteId: target.id, frame: { ...frame, durationMs: operation.durationMs }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.animation.tag.upsert') {
    const operation = PixelAnimationTagUpsertSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    return [{ kind: 'pixel.asset.replace', asset: upsertPixelAnimationTag(target, operation.tag), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.animation.tag.delete') {
    const operation = PixelAnimationTagDeleteSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    return [{ kind: 'pixel.asset.replace', asset: deletePixelAnimationTag(target, operation.tagId), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.palette-override.set') {
    const operation = PixelPaletteOverrideSchema.parse(value); const target = pixelSpriteTarget(document, operation.spriteId);
    if (document.kind !== 'pixel') throw new Error('Frame palette overrides require a pixel document.');
    if (operation.colors && operation.colors.length !== document.palette.length) throw new Error(`Frame palette overrides require exactly ${document.palette.length} colors.`);
    const palette = operation.colors?.map((color, index) => ({ ...document.palette[index], color }));
    return [{ kind: 'pixel.asset.replace', asset: setPixelFramePaletteOverride(target, operation.frameId, palette), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.project-link.embed') {
    const operation = PixelProjectLinkEmbedSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Project links require a pixel document.');
    const link = document.linkedAssets.find((entry) => entry.id === operation.linkId); if (!link) throw new Error(`Project link ${operation.linkId} does not exist.`);
    if (link.mode === 'embedded') throw new Error(`Project link ${operation.linkId} is already embedded.`);
    return [{ kind: 'pixel.links.replace', linkedAssets: embedPixelLink(document, operation.linkId), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.project-links.pack') {
    const operation = PixelProjectLinksPackSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Project links require a pixel document.');
    if (!document.linkedAssets.some((entry) => entry.mode === 'linked')) throw new Error('The pixel project has no external links to pack.');
    return [{ kind: 'pixel.links.replace', linkedAssets: packPixelLinks(document), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.stamp.place') {
    const operation = PixelStampPlaceSchema.parse(value); const target = pixelSemanticTarget(document, operation.spriteId, operation.celId);
    const stamp = target.document.stamps.find((entry) => entry.id === operation.stampId); if (!stamp) throw new Error(`Pixel stamp ${operation.stampId} does not exist.`);
    const placement = placePixelStamp(operation.transform ? transformPixelStamp(stamp, operation.transform) : stamp, operation.x, operation.y, { width: target.sprite.width, height: target.sprite.height });
    return pixelRegionOperation(target.sprite, target.celId, placement.changes, operation.expectedRevision);
  }
  if (value.kind === 'pixel.tile-stamp.place') {
    const operation = PixelTileStampPlaceSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Tile stamps require a pixel document.');
    const map = document.pixelAssets[operation.mapId]; if (!map || map.type !== 'tilemap') throw new Error('Tile stamp target map does not exist.');
    const layer = map.layers[operation.layerId]; if (!layer || layer.type !== 'tile') throw new Error('Tile stamp target layer does not exist.');
    const stamp = document.tileStamps.find((entry) => entry.id === operation.stampId); if (!stamp) throw new Error('Tile stamp ' + operation.stampId + ' does not exist.');
    const placement = placeTileStamp(operation.transform ? transformTileStamp(stamp, operation.transform) : stamp, operation.x, operation.y, map.infinite ? undefined : { width: map.width, height: map.height });
    if (!placement.changes.length) throw new Error('The tile stamp falls completely outside the finite map.');
    return [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: placement.changes, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.tile-variants.paint') {
    const operation = PixelTileVariantsPaintSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Tile variants require a pixel project.');
    const map = document.pixelAssets[operation.mapId]; if (!map || map.type !== 'tilemap') throw new Error(`Tilemap ${operation.mapId} does not exist.`);
    const layer = map.layers[operation.layerId]; if (!layer || layer.type !== 'tile') throw new Error(`Tile layer ${operation.layerId} does not exist.`);
    const tileset = document.pixelAssets[operation.tilesetId]; if (!tileset || tileset.type !== 'tileset' || !map.tilesetIds.includes(tileset.id)) throw new Error(`Tileset ${operation.tilesetId} is not attached to this map.`);
    if (operation.tileId >= tileset.columns * tileset.rows) throw new Error(`Tile ${operation.tileId} falls outside the tileset slice.`);
    const unique = new Map(operation.points.map((point) => [`${point.x},${point.y}`, point]));
    const points = [...unique.values()]; if (!map.infinite && points.some((point) => point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height)) throw new Error('Variant paint points must fit completely inside a finite map.');
    const seed = operation.seed ?? Math.trunc(Number(map.properties[TILE_VARIANT_SEED_PROPERTY]) || 0);
    const transforms = operation.transforms ?? { hFlip: false, vFlip: false, diagonal: false };
    const changes = points.map((point) => ({ ...point, gid: encodeTiledGid(tileset.firstGid + chooseTileVariant(tileset, operation.tileId, point.x, point.y, seed), transforms) }));
    return [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.wang-terrain.stroke') {
    const operation = PixelWangTerrainStrokeSchema.parse(value);
    if (document.kind !== 'pixel') throw new Error('Wang terrain strokes require a pixel project.');
    const map = document.pixelAssets[operation.mapId];
    if (!map || map.type !== 'tilemap') throw new Error(`Tilemap ${operation.mapId} does not exist.`);
    const layer = map.layers[operation.layerId];
    if (!layer || layer.type !== 'tile' || !layer.chunks) throw new Error(`Tile layer ${operation.layerId} does not exist.`);
    if (operation.expectedRevision !== layer.revision) throw new Error(`Tile layer ${layer.id} revision changed from ${operation.expectedRevision} to ${layer.revision}; observe and retry. No terrain tiles changed.`);
    const tileset = document.pixelAssets[operation.tilesetId];
    if (!tileset || tileset.type !== 'tileset' || !map.tilesetIds.includes(tileset.id)) throw new Error(`Tileset ${operation.tilesetId} is not attached to tilemap ${map.id}.`);
    const wangSet = tileset.wangSets.find((entry) => entry.id === operation.wangSetId);
    if (!wangSet) throw new Error(`Wang set ${operation.wangSetId} does not exist in tileset ${tileset.id}.`);
    if (!wangSet.colors.some((color) => color.id === operation.colorId)) throw new Error(`Wang color ${operation.colorId} does not exist in ${wangSet.name}.`);
    const tileCount = tileset.columns * tileset.rows;
    if (wangSet.tiles.some((tile) => tile.tileId < 0 || tile.tileId >= tileCount)) throw new Error(`Wang set ${wangSet.id} addresses a tile outside tileset ${tileset.id}; no terrain tiles changed.`);
    const contains = (x: number, y: number) => map.infinite || (x >= 0 && y >= 0 && x < map.width && y < map.height);
    const localTileAt = (x: number, y: number): number | undefined => {
      const gid = decodeTiledGid(readTileAt(layer.chunks!, x, y)).gid;
      if (gid === 0) return undefined;
      const resolved = resolveTilesetForGid(document, map, gid);
      if (!resolved || resolved.tileset.id !== tileset.id) throw new Error(`Terrain stroke cell (${x}, ${y}) contains GID ${gid} outside tileset ${tileset.id}. No terrain tiles changed.`);
      return resolved.localId;
    };
    const points = [...new Map(operation.points.map((point) => [`${point.x},${point.y}`, point])).values()];
    const seedMaterial = JSON.stringify([
      'aidraw-wang-terrain-stroke-v1', document.id, map.id, layer.id, tileset.id,
      wangSet.id, operation.colorId, operation.mode,
      points.flatMap((point) => [point.x, point.y]),
    ]);
    const plan = planWangTerrainStroke(wangSet, points, operation.colorId, localTileAt, {
      erase: operation.mode === 'erase',
      contains,
      random: createWangTerrainStrokeRandom(seedMaterial),
    });
    if (plan.status === 'unmatched') {
      const examples = plan.unmatched.slice(0, 3).map((entry) => `(${entry.x}, ${entry.y}) [${entry.wangId.join(',')}]`).join('; ');
      const remainder = plan.unmatched.length > 3 ? `; +${plan.unmatched.length - 3} more` : '';
      throw new Error(`Terrain stroke was not applied: ${plan.unmatched.length} in-map cell${plan.unmatched.length === 1 ? '' : 's'} need exact Wang mappings: ${examples}${remainder}. No terrain tiles changed; add those mappings to "${wangSet.name}" and retry.`);
    }
    if (!plan.changes.length) throw new Error('The terrain stroke already matches the requested terrain; no tiles changed and no revision was created.');
    return [{
      kind: 'pixel.tilemap.set',
      mapId: map.id,
      layerId: layer.id,
      changes: plan.changes.map((change) => ({ x: change.x, y: change.y, gid: encodeTiledGid(tileset.firstGid + change.tileId) })),
      expectedRevision: operation.expectedRevision,
    }];
  }
  if (value.kind === 'pixel.map-object.upsert' || value.kind === 'pixel.map-object.delete') {
    const operation = value.kind === 'pixel.map-object.upsert' ? PixelMapObjectUpsertSchema.parse(value) : PixelMapObjectDeleteSchema.parse(value); if (document.kind !== 'pixel') throw new Error('Map objects require a pixel project.'); const source = document.pixelAssets[operation.mapId]; if (!source || source.type !== 'tilemap') throw new Error(`Tilemap ${operation.mapId} does not exist.`); const layer = source.layers[operation.layerId]; if (!layer || layer.type !== 'object') throw new Error('Map objects require an existing object layer.'); const map = structuredClone(source); const nextLayer = map.layers[operation.layerId]; if (nextLayer.type !== 'object') throw new Error('Map object layer changed unexpectedly.');
    if (operation.kind === 'pixel.map-object.upsert') { const index = (nextLayer.objects ?? []).findIndex((object) => object.id === operation.object.id); if (index < 0) nextLayer.objects = [...(nextLayer.objects ?? []), operation.object]; else nextLayer.objects = (nextLayer.objects ?? []).map((object, position) => position === index ? operation.object : object); }
    else { if (!(nextLayer.objects ?? []).some((object) => object.id === operation.objectId)) throw new Error(`Map object ${operation.objectId} does not exist.`); nextLayer.objects = (nextLayer.objects ?? []).filter((object) => object.id !== operation.objectId); }
    return [{ kind: 'pixel.asset.replace', asset: map, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.tileset-collision.upsert' || value.kind === 'pixel.tileset-collision.delete') {
    const operation = value.kind === 'pixel.tileset-collision.upsert' ? PixelTilesetCollisionUpsertSchema.parse(value) : PixelTilesetCollisionDeleteSchema.parse(value); if (document.kind !== 'pixel') throw new Error('Tileset collisions require a pixel project.'); const source = document.pixelAssets[operation.tilesetId]; if (!source || source.type !== 'tileset') throw new Error(`Tileset ${operation.tilesetId} does not exist.`); if (operation.tileId >= source.columns * source.rows) throw new Error(`Tile ${operation.tileId} falls outside the tileset slice.`); const tileset = structuredClone(source); const tile = tileset.tiles[operation.tileId] ?? { id: operation.tileId, sourceX: tileset.margin + operation.tileId % tileset.columns * (tileset.tileWidth + tileset.spacing), sourceY: tileset.margin + Math.floor(operation.tileId / tileset.columns) * (tileset.tileHeight + tileset.spacing), probability: 1, animation: [], collisions: [], properties: {} };
    if (operation.kind === 'pixel.tileset-collision.upsert') { const existing = tile.collisions.findIndex((shape) => shape.id === operation.shape.id); tile.collisions = existing < 0 ? [...tile.collisions, operation.shape] : tile.collisions.map((shape, index) => index === existing ? operation.shape : shape); }
    else { if (!tile.collisions.some((shape) => shape.id === operation.shapeId)) throw new Error(`Collision shape ${operation.shapeId} does not exist on tile ${operation.tileId}.`); tile.collisions = tile.collisions.filter((shape) => shape.id !== operation.shapeId); }
    tileset.tiles[operation.tileId] = tile; return [{ kind: 'pixel.asset.replace', asset: tileset, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'pixel.wang-set.upsert' || value.kind === 'pixel.wang-set.delete' || value.kind === 'pixel.wang-color.upsert' || value.kind === 'pixel.wang-color.delete' || value.kind === 'pixel.wang-tile.assign') {
    if (document.kind !== 'pixel') throw new Error('Wang authoring requires a pixel project.');
    const parsed = value.kind === 'pixel.wang-set.upsert' ? PixelWangSetUpsertSchema.parse(value)
      : value.kind === 'pixel.wang-set.delete' ? PixelWangSetDeleteSchema.parse(value)
        : value.kind === 'pixel.wang-color.upsert' ? PixelWangColorUpsertSchema.parse(value)
          : value.kind === 'pixel.wang-color.delete' ? PixelWangColorDeleteSchema.parse(value)
            : PixelWangTileAssignSchema.parse(value);
    const source = document.pixelAssets[parsed.tilesetId]; if (!source || source.type !== 'tileset') throw new Error(`Tileset ${parsed.tilesetId} does not exist.`);
    const asset = parsed.kind === 'pixel.wang-set.upsert' ? upsertWangSet(source, parsed.wangSet)
      : parsed.kind === 'pixel.wang-set.delete' ? deleteWangSet(source, parsed.wangSetId)
        : parsed.kind === 'pixel.wang-color.upsert' ? upsertWangColor(source, parsed.wangSetId, parsed.color)
          : parsed.kind === 'pixel.wang-color.delete' ? deleteWangColor(source, parsed.wangSetId, parsed.colorId)
            : assignWangTile(source, parsed.wangSetId, parsed.tile);
    return [{ kind: 'pixel.asset.replace', asset, expectedRevision: parsed.expectedRevision }];
  }
  if (value.kind === 'illustration.objects.align') {
    const operation = IllustrationAlignSchema.parse(value); const target = semanticObjects(document, operation.objectIds, operation.expectedRevisions);
    const aligned = alignIllustrationObjects(target.objects, operation.mode, operation.target, { x: 0, y: 0, width: target.document.artboard.width, height: target.document.artboard.height }, operation.keyObjectId);
    return aligned.map((object): CanvasOperation => ({ kind: 'illustration.object.replace', object, expectedRevision: operation.expectedRevisions[object.id] }));
  }
  if (value.kind === 'illustration.objects.distribute') {
    const operation = IllustrationDistributeSchema.parse(value); const target = semanticObjects(document, operation.objectIds, operation.expectedRevisions);
    const distributed = distributeIllustrationObjects(target.objects, operation.axis, operation.mode);
    return distributed.map((object): CanvasOperation => ({ kind: 'illustration.object.replace', object, expectedRevision: operation.expectedRevisions[object.id] }));
  }
  if (value.kind === 'illustration.path.boolean') {
    const operation = IllustrationBooleanSchema.parse(value); const target = semanticObjects(document, operation.objectIds, operation.expectedRevisions); if (target.objects[0].layerId !== target.objects[1].layerId) throw new Error('Path boolean inputs must share one vector layer.');
    const object = createBooleanPath(target.objects[0], target.objects[1], operation.mode);
    return [
      { kind: 'illustration.object.delete', objectId: target.objects[0].id, expectedRevision: operation.expectedRevisions[target.objects[0].id] },
      { kind: 'illustration.object.delete', objectId: target.objects[1].id, expectedRevision: operation.expectedRevisions[target.objects[1].id] },
      { kind: 'illustration.object.add', object },
    ];
  }
  if (value.kind === 'illustration.material.apply') {
    const operation = IllustrationMaterialSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Material presets require an illustration document.'); const object = document.objects[operation.objectId]; if (!object) throw new Error(`Object ${operation.objectId} does not exist.`); const material = buildPolishedGoldMaterial(document, object); return material.operations.map((entry) => entry.kind === 'illustration.object.replace' && entry.object.id === object.id ? { ...entry, expectedRevision: operation.expectedRevision } : entry);
  }
  if (value.kind === 'illustration.gradient.set') {
    const operation = IllustrationGradientSetSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Gradient editing requires an illustration document.'); const object = document.objects[operation.objectId];
    if (!object || (object.type !== 'shape' && object.type !== 'path')) throw new Error('Gradient editing requires a shape or path object.');
    return [{ kind: 'illustration.object.replace', object: { ...object, fill: { kind: operation.gradientKind, x1: operation.x1, y1: operation.y1, x2: operation.x2, y2: operation.y2, stops: [...operation.stops].sort((left, right) => left.offset - right.offset) } }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.image.crop') {
    const operation = IllustrationImageCropSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Image crops require an illustration document.'); const source = document.objects[operation.objectId]; if (!source || source.type !== 'image') throw new Error(`Image object ${operation.objectId} does not exist.`);
    const object = operation.action === 'reset' ? resetImageCrop(source) : operation.action === 'aspect' ? cropImageToAspect(source, operation.aspect!) : cropImageObject(source, operation.rectangle!);
    return [{ kind: 'illustration.object.replace', object, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.image.filters.replace' || value.kind === 'illustration.object.filters.replace') {
    const operation = IllustrationImageFiltersSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Object filters require an illustration document.'); const object = document.objects[operation.objectId]; if (!object) throw new Error(`Illustration object ${operation.objectId} does not exist.`); if (operation.kind === 'illustration.image.filters.replace' && object.type !== 'image') throw new Error(`Image object ${operation.objectId} does not exist.`);
    return [{ kind: 'illustration.object.replace', object: { ...object, filters: operation.filters }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.layer.filters.replace') {
    const operation = IllustrationLayerFiltersSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Layer filters require an illustration document.'); const layer = document.layers[operation.layerId]; if (!layer) throw new Error(`Illustration layer ${operation.layerId} does not exist.`);
    return [{ kind: 'illustration.layer.replace', layer: { ...layer, filters: operation.filters }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.object.mask.set') {
    const operation = IllustrationObjectMaskSchema.parse(value); const target = semanticObjects(document, operation.objectIds, operation.expectedRevisions);
    if (operation.maskObjectId) { const mask = target.document.objects[operation.maskObjectId]; if (!mask || (mask.type !== 'shape' && mask.type !== 'path' && mask.type !== 'vector-stroke')) throw new Error('Object masks require an existing path-capable mask object.'); if (operation.objectIds.includes(mask.id)) throw new Error('A mask object cannot mask itself.'); if (target.objects.some((object) => object.layerId !== mask.layerId)) throw new Error('Object masks and their targets must share one vector layer.'); }
    return target.objects.map((object): CanvasOperation => ({ kind: 'illustration.object.replace', object: { ...object, maskObjectId: operation.maskObjectId ?? undefined }, expectedRevision: operation.expectedRevisions[object.id] }));
  }
  if (value.kind === 'illustration.layer.mask.set') {
    const operation = IllustrationLayerMaskSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Layer masks require an illustration document.'); const layer = document.layers[operation.layerId]; if (!layer) throw new Error(`Layer ${operation.layerId} does not exist.`); if (operation.maskLayerId) { const mask = document.layers[operation.maskLayerId]; if (!mask || mask.type !== 'vector') throw new Error('A layer mask must reference an existing vector layer.'); if (mask.id === layer.id) throw new Error('A layer cannot mask itself.'); }
    return [{ kind: 'illustration.layer.replace', layer: { ...layer, maskLayerId: operation.maskLayerId ?? undefined }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.text.content.set') {
    const operation = IllustrationTextContentSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Text editing requires an illustration document.'); const object = document.objects[operation.objectId]; if (!object || object.type !== 'text') throw new Error('The text target does not exist.');
    return [{ kind: 'illustration.object.replace', object: replaceStyledText(object, operation.text), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.text.style') {
    const operation = IllustrationTextStyleSchema.parse(value); if (document.kind !== 'illustration') throw new Error('Text editing requires an illustration document.'); const object = document.objects[operation.objectId]; if (!object || object.type !== 'text') throw new Error('The text target does not exist.');
    return [{ kind: 'illustration.object.replace', object: applyTextStyleRange(object, operation.start, operation.end, operation.style), expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.node.move') {
    const operation = IllustrationPathNodeMoveSchema.parse(value); const target = semanticPath(document, operation.objectId);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: movePathPoint(target.object.pathData, operation.nodeIndex, operation.point, operation.x, operation.y, operation.mirror) }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.node.insert') {
    const operation = IllustrationPathNodeInsertSchema.parse(value); const target = semanticPath(document, operation.objectId);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: insertPathNode(target.object.pathData, operation.segmentIndex, operation.time) }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.node.delete') {
    const operation = IllustrationPathNodeDeleteSchema.parse(value); const target = semanticPath(document, operation.objectId);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: deletePathNode(target.object.pathData, operation.nodeIndex) }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.node.convert') {
    const operation = IllustrationPathNodeConvertSchema.parse(value); const target = semanticPath(document, operation.objectId);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: convertPathNode(target.object.pathData, operation.nodeIndex, operation.nodeKind) }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.closed.set') {
    const operation = IllustrationPathClosedSchema.parse(value); const target = semanticPath(document, operation.objectId);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: setPathClosed(target.object.pathData, operation.closed), closed: operation.closed }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.arcs.convert') {
    const operation = IllustrationPathArcConvertSchema.parse(value); const target = semanticPath(document, operation.objectId); const converted = convertPathArcsToCubics(target.object.pathData);
    return [{ kind: 'illustration.object.replace', object: { ...target.object, ...converted }, expectedRevision: operation.expectedRevision }];
  }
  if (value.kind === 'illustration.path.split') {
    const operation = IllustrationPathSplitSchema.parse(value); const target = semanticPath(document, operation.objectId); const split = splitPathAtNode(target.object.pathData, operation.nodeIndex);
    const operations: CanvasOperation[] = [{ kind: 'illustration.object.replace', object: { ...target.object, pathData: split.primaryPathData, closed: false }, expectedRevision: operation.expectedRevision }];
    if (split.secondaryPathData) {
      const timestamp = nowIso(); const layer = target.document.layers[target.object.layerId]; if (!layer || layer.type !== 'vector') throw new Error('The path vector layer does not exist.');
      const parent = Object.values(target.document.objects).find((entry) => entry.type === 'group' && entry.childIds.includes(target.object.id));
      const object = { ...structuredClone(target.object), id: operation.newObjectId ?? createId('path'), revision: 0, name: `${target.object.name} part 2`, createdAt: timestamp, updatedAt: timestamp, pathData: split.secondaryPathData, closed: false };
      operations.push({ kind: 'illustration.object.add', object, index: Math.max(0, layer.objectIds.indexOf(target.object.id) + 1), parentGroupId: parent?.id, groupIndex: parent?.type === 'group' ? Math.max(0, parent.childIds.indexOf(target.object.id) + 1) : undefined });
    }
    return operations;
  }
  if (value.kind === 'illustration.path.join') {
    const operation = IllustrationPathJoinSchema.parse(value); const primary = semanticPath(document, operation.primaryObjectId); const secondary = semanticPath(document, operation.secondaryObjectId);
    return [
      { kind: 'illustration.object.replace', object: joinPathObjects(primary.object, secondary.object, operation.endpoints), expectedRevision: operation.expectedRevisions[primary.object.id] },
      { kind: 'illustration.object.delete', objectId: secondary.object.id, expectedRevision: operation.expectedRevisions[secondary.object.id] },
    ];
  }
  return [CanvasOperationSchema.parse(value)];
}

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function normalizeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function canonicalizeRequestedPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  try {
    return await realpath(absolute);
  } catch {
    const segments = [basename(absolute)];
    let cursor = dirname(absolute);
    while (true) {
      try {
        return resolve(await realpath(cursor), ...segments);
      } catch {
        const parent = dirname(cursor);
        if (parent === cursor) return absolute;
        segments.unshift(basename(cursor));
        cursor = parent;
      }
    }
  }
}

function approvalReview(
  kind: AsyncJob['kind'],
  title: string,
  request: Record<string, unknown>,
  target: string | undefined,
  overwritePaths: string[],
  trustable: boolean,
): NonNullable<NonNullable<AsyncJob['approval']>['review']> {
  const fields: NonNullable<NonNullable<AsyncJob['approval']>['review']>['fields'] = [];
  const add = (label: string, value: unknown, tone?: 'default' | 'warning' | 'paid') => {
    if (value === undefined || value === '' || value === false) return;
    fields.push({ label, value: Array.isArray(value) ? value.join(', ') || 'None' : String(value), tone });
  };
  if (kind === 'generation') {
    add('Provider', request.provider);
    add('Model / workflow', request.provider === 'openai' ? 'gpt-image-2' : request.provider === 'stability' ? 'Stability generation API' : 'Selected ComfyUI API workflow');
    add('Mode', request.mode);
    add('Prompt', request.prompt);
    add('Negative prompt', request.negativePrompt);
    add('Source assets', Array.isArray(request.sourceAssetIds) ? request.sourceAssetIds : []);
    add('Mask asset', request.maskAssetId);
    add('Requested results', request.resultCount);
    add('Potential paid requests', request.resultCount, 'paid');
    add('Size', typeof request.size === 'object' ? JSON.stringify(request.size) : request.size);
    add('Seed', request.seed);
    add('Provider options', JSON.stringify(request.providerOptions ?? {}));
  } else {
    add('Action', request.action ?? title);
    add('Format', request.format);
    add('Presentation scale', request.scale ? `${request.scale}×` : undefined);
    add('Animation tag', typeof request.animationTagId === 'string' ? request.animationTagId : undefined);
    add('Palette cycle', typeof request.paletteCycleId === 'string' ? request.paletteCycleId : undefined);
    add('Palette-cycle source frame', typeof request.paletteCycleFrameId === 'string' ? request.paletteCycleFrameId : undefined);
    add('Pixel import', request.pixelMode === true ? 'Yes' : undefined);
    add('Project link', request.projectLinkId);
    if (overwritePaths.length) add('Will overwrite', overwritePaths.join('\n'), 'warning');
    else if (target && (kind === 'save' || kind === 'export')) add('Overwrite check', 'No existing target detected');
  }
  return {
    action: title,
    target,
    trustFolder: trustable && target ? dirname(target) : undefined,
    overwritePaths,
    fields,
  };
}

async function generationApprovalPreviews(
  document: AIDrawDocument | undefined,
  request: Record<string, unknown>,
  renderPreview: GenerationApprovalPreviewRenderer | undefined,
): Promise<NonNullable<NonNullable<NonNullable<AsyncJob['approval']>['review']>['previews']>> {
  if (!document || !renderPreview) return [];
  const sources = Array.isArray(request.sourceAssetIds) ? request.sourceAssetIds.filter((value): value is string => typeof value === 'string').slice(0, 4).map((assetId) => ({ role: 'source' as const, assetId })) : [];
  const targets = [...sources, ...(typeof request.maskAssetId === 'string' ? [{ role: 'mask' as const, assetId: request.maskAssetId }] : [])];
  const previews: NonNullable<NonNullable<NonNullable<AsyncJob['approval']>['review']>['previews']> = [];
  for (const target of targets) {
    const asset = document.assets[target.assetId]; if (!asset?.data || !asset.mimeType.startsWith('image/')) continue;
    try {
      const preview = await renderPreview(asset);
      previews.push({ role: target.role, assetId: asset.id, name: asset.name, mimeType: asset.mimeType, width: preview.width, height: preview.height, dataUrl: `data:image/png;base64,${preview.previewPng.toString('base64')}` });
    } catch { /* The approval fields still report the asset ID; an unavailable advisory preview never grants or blocks approval. */ }
  }
  return previews;
}

export class McpHost {
  readonly scheduler: PlaybackScheduler;
  private readonly batches: BatchManager;
  private readonly activeBatchTransactions = new Map<string, string>();
  private readonly sessions = new Map<string, McpSession>();
  private initializingSessions = 0;
  private sessionSequence = 0;
  private stopping = false;
  private httpServer?: HttpServer;
  private token = '';
  private credentialGeneration = 0;
  private port?: number;
  private lastRevisions = new Map<string, number>();
  private readonly sessionTrustedFolders = new Map<string, Set<string>>();
  private readonly persistentTrustedFolders = new Set<string>();
  private readonly launchTrustedFolders = new Set<string>();
  private persistentTrustWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly documents: DocumentService,
    private readonly appVersion: string,
    private readonly preferredPortPath: string,
    private readonly cancelJob?: (jobId: string) => void,
    private readonly runApprovedJob?: (job: AsyncJob) => void,
    private readonly quantizeImage: QuantizeImage = quantizeImageToPalette,
    private readonly captureCanvasObservation: CaptureObservation = captureObservation,
    private readonly approvalTimeoutMs = 120_000,
    private readonly renderGenerationApprovalPreview?: GenerationApprovalPreviewRenderer,
  ) {
    this.scheduler = new PlaybackScheduler(documents);
    this.batches = new BatchManager(documents, join(dirname(preferredPortPath), 'batches.json'));
    this.documents.on('event', (event) => {
      if (event.type !== 'workspace') return;
      for (const tab of event.snapshot.documents) {
        const prior = this.lastRevisions.get(tab.id);
        if (prior !== tab.revision) {
          this.lastRevisions.set(tab.id, tab.revision);
          void this.notifyDocumentUpdated(tab.id, tab.revision);
        }
      }
    });
    this.documents.on('approval-resolved', (job: AsyncJob, decision: ApprovalDecision) => { void this.rememberTrust(job, decision); });
  }

  async start(token: string): Promise<{ port: number; url: string; tokenHint: string }> {
    if (this.httpServer) throw new Error('The AIDraw MCP server is already running.');
    if (!token) throw new Error('The AIDraw MCP credential is unavailable.');
    this.stopping = false;
    this.port = undefined;
    this.token = '';
    await this.batches.initialize();
    await this.readFolderTrust();
    const preferred = await this.readPreferredPort();
    const candidates = [preferred, ...Array.from({ length: PORT_END - PORT_START + 1 }, (_, index) => PORT_START + index)]
      .filter((value, index, values) => value >= PORT_START && value <= PORT_END && values.indexOf(value) === index);
    let lastError: Error | undefined;
    for (const port of candidates) {
      try {
        await this.listen(port);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      try {
        await this.writePreferredPort(port);
      } catch {
        await this.closeFailedStartListener();
        throw new Error('The AIDraw MCP endpoint bound a loopback port, but its private preferred-port record could not be persisted. The listener was closed and runtime authority was not enabled.');
      }
      this.port = port;
      this.token = token;
      this.credentialGeneration += 1;
      return { port, url: `http://127.0.0.1:${port}/mcp`, tokenHint: 'Credential active' };
    }
    this.port = undefined;
    this.token = '';
    throw lastError ?? new Error('No AIDraw MCP port is available.');
  }

  credentials(): { url?: string; token: string } {
    return { url: this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined, token: this.token };
  }

  async replaceCredential(token: string): Promise<number> {
    if (!token) throw new Error('The replacement MCP credential is unavailable.');
    if (!this.httpServer || !this.port) throw new Error('The AIDraw MCP server is not running.');
    this.credentialGeneration += 1;
    this.token = token;
    return this.closeAuthenticatedSessions();
  }

  async revokeCredential(): Promise<number> {
    this.credentialGeneration += 1;
    this.token = '';
    return this.closeAuthenticatedSessions();
  }

  /**
   * Grants process-lifetime file authority that was explicitly supplied by the
   * user who launched a headless engine. This is intentionally separate from
   * persistent in-app trust and is never written to disk by McpHost.
   */
  async grantLaunchFolderTrust(folders: string[]): Promise<string[]> {
    for (const folder of folders) this.launchTrustedFolders.add(await this.canonicalizeFolder(folder));
    return [...this.launchTrustedFolders];
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.closeAuthenticatedSessions();
    if (this.httpServer) await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = undefined;
    this.port = undefined;
    this.token = '';
    await this.batches.flush();
    await this.persistentTrustWrite;
    await this.documents.flushRecovery();
  }

  private async listen(port: number): Promise<void> {
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = createServer((request, response) => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      void this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'MCP request failed.' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    this.httpServer = server;
  }

  private async closeFailedStartListener(): Promise<void> {
    const server = this.httpServer;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    if (this.httpServer === server) this.httpServer = undefined;
    this.port = undefined;
    this.token = '';
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port ?? PORT_START}`);
    if (url.pathname === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ name: 'AIDraw Engine', version: this.appVersion, status: 'ok', uiRequired: false }));
      return;
    }
    if (url.pathname !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not_found"}'); return;
    }
    const authorization = request.headers.authorization ?? '';
    if (!this.token || !authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), this.token)) {
      writeMcpTransportDiagnostic(response, 401, 'invalid_token', { 'www-authenticate': 'Bearer realm="AIDraw MCP"' });
      return;
    }
    const requestCredentialGeneration = this.credentialGeneration;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { allow: 'GET, POST, DELETE, OPTIONS' }); response.end(); return;
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    const protocolHeader = request.headers['mcp-protocol-version'];
    const protocolVersion = Array.isArray(protocolHeader) && protocolHeader.length === 1 ? protocolHeader[0] : protocolHeader;
    if (session && protocolVersion !== LATEST_PROTOCOL_VERSION) {
      writeMcpTransportDiagnostic(response, 400, 'unsupported_protocol_version');
      return;
    }
    let body: unknown;
    if (request.method === 'POST') body = await this.readBody(request);

    if (!session) {
      const method = body && typeof body === 'object' && 'method' in body ? (body as { method?: unknown }).method : undefined;
      if (request.method !== 'POST' || method !== 'initialize') {
        if (sessionId) writeMcpTransportDiagnostic(response, 404, 'unknown_session');
        else writeMcpTransportDiagnostic(response, 400, 'initialization_required');
        return;
      }
      if (this.stopping) {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1' });
        response.end('{"error":"mcp_stopping"}');
        return;
      }
      if (this.sessions.size + this.initializingSessions >= MAX_MCP_SESSIONS) {
        response.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'session_limit_reached', limit: MAX_MCP_SESSIONS, message: 'Terminate an existing MCP session with authenticated DELETE before retrying.' }));
        return;
      }
      this.initializingSessions += 1;
      let retained = false;
      try {
        session = await this.createSession();
        await session.transport.handleRequest(request, response, body);
        const assignedId = session.transport.sessionId;
        if (assignedId && !session.closed && !this.stopping && requestCredentialGeneration === this.credentialGeneration) {
          this.sessions.set(assignedId, session);
          retained = true;
        }
      } finally {
        this.initializingSessions -= 1;
        if (session && !retained) await session.mcp.close().catch(() => undefined);
      }
      return;
    }

    await session.transport.handleRequest(request, response, body);
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_HTTP_BODY) throw new Error('MCP request body exceeds 2 MiB.');
      chunks.push(buffer);
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async createSession(): Promise<McpSession> {
    const sessionNumber = ++this.sessionSequence;
    const actorIndex = (sessionNumber - 1) % AGENT_COLORS.length;
    const state: McpSession = {
      actor: { id: createId('agent'), kind: 'agent', name: `Agent ${sessionNumber}`, color: AGENT_COLORS[actorIndex] },
      mcp: undefined as unknown as McpServer,
      transport: new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }),
      subscriptions: new Set(),
      closed: false,
    };
    state.mcp = this.buildServer(state);
    await state.mcp.connect(state.transport);
    const protocolClose = state.transport.onclose;
    state.transport.onclose = () => { protocolClose?.(); this.retireSession(state); };
    return state;
  }

  private retireSession(session: McpSession): void {
    if (!session.closed) {
      session.closed = true;
      for (const [id, active] of this.sessions) if (active === session) this.sessions.delete(id);
    }
    this.documents.removePresence(session.actor.id);
    this.sessionTrustedFolders.delete(session.actor.id);
    session.subscriptions.clear();
  }

  private async closeAuthenticatedSessions(): Promise<number> {
    const sessions = [...new Set(this.sessions.values())];
    for (const session of sessions) this.retireSession(session);
    await Promise.all(sessions.map((session) => session.mcp.close().catch(() => undefined)));
    for (const session of sessions) this.retireSession(session);
    return sessions.length;
  }

  private hasActiveSession(actorId: string): boolean {
    for (const session of this.sessions.values()) if (!session.closed && session.actor.id === actorId) return true;
    return false;
  }

  private buildServer(session: McpSession): McpServer {
    const server = new McpServer({ name: 'aidraw', version: this.appVersion }, {
      capabilities: { resources: { subscribe: true, listChanged: true }, tools: { listChanged: true } },
      instructions: AIDRAW_SERVER_INSTRUCTIONS,
    });
    const approvalJob = async (kind: AsyncJob['kind'], title: string, description: string, documentId: string | undefined, rawRequest: Record<string, unknown>, trustable = true) => {
      const rawPath = typeof rawRequest.path === 'string' ? resolve(rawRequest.path) : undefined;
      const extensionAdjustedPath = rawPath && kind === 'save' && extname(rawPath).toLowerCase() !== '.aidraw' ? `${rawPath}.aidraw` : rawPath;
      const requestedPath = extensionAdjustedPath ? await canonicalizeRequestedPath(extensionAdjustedPath) : undefined;
      const document = documentId ? this.documents.getDocument(documentId) : undefined;
      const companionPaths = requestedPath && document && kind === 'export' && typeof rawRequest.format === 'string'
        ? plannedExportCompanionPaths(document, rawRequest.format as ExportFormat, requestedPath)
        : [];
      // Existing import sources are inputs, not overwrite targets. Folder trust
      // may authorize reading them; only save/export destinations (including
      // companions) must lose automatic trust when an existing file is found.
      const targetPaths = requestedPath && (kind === 'save' || kind === 'export') ? [requestedPath, ...companionPaths] : [];
      const overwritePaths = (await Promise.all(targetPaths.map(async (target) => await stat(target).then(() => target, () => undefined)))).filter((target): target is string => Boolean(target));
      const request = requestedPath ? { ...rawRequest, path: requestedPath, overwritePaths } : rawRequest;
      const timestamp = nowIso(); const review = approvalReview(kind, title, request, requestedPath, overwritePaths, trustable);
      if (kind === 'generation') review.previews = await generationApprovalPreviews(document, request, this.renderGenerationApprovalPreview);
      const job: AsyncJob = {
        id: createId('job'), kind, status: 'waiting-for-user', actor: structuredClone(session.actor), createdAt: timestamp, updatedAt: timestamp,
        progress: 0, message: `${title} is waiting for in-app approval.`, result: { documentId, request },
        approval: {
          title,
          description,
          expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
          options: trustable ? ['allow-once', 'allow-session', 'allow-always', 'deny'] : ['allow-once', 'deny'],
          review,
        },
      };
      if (trustable && requestedPath && overwritePaths.length === 0 && this.isTrustedPath(session.actor.id, requestedPath)) { const approved = { ...job, status: 'queued' as const, message: 'Approved by trusted folder policy.', approval: undefined, result: { documentId, request, approvalDecision: 'trusted-folder' } }; this.documents.upsertJob(approved); this.runApprovedJob?.(approved); return jsonText({ jobId: approved.id, status: approved.status, trust: 'folder', next: jobNextStep(approved) }); }
      this.documents.upsertJob(job);
      return jsonText({ jobId: job.id, status: job.status, expiresAt: job.approval?.expiresAt, next: jobNextStep(job) });
    };

    server.registerResource('AIDraw agent protocol guide', AIDRAW_GUIDE_URI, {
      title: 'AIDraw agent protocol guide', mimeType: 'text/markdown', description: 'Complete optional MCP workflow and safety reference for clients that support resources.',
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: AIDRAW_MCP_GUIDE }] }));

    server.registerResource('Open AIDraw documents', 'aidraw://documents', {
      title: 'Open AIDraw documents', mimeType: 'application/json', description: 'Open documents and current revisions.',
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.documents.snapshot(session.actor.id).documents) }] }));

    const manifestTemplate = new ResourceTemplate('aidraw://documents/{id}/manifest', { list: undefined });
    server.registerResource('AIDraw document manifest', manifestTemplate, { title: 'Document manifest', mimeType: 'application/json' }, async (uri, variables) => {
      const document = this.documents.getDocument(String(variables.id));
      if (!document) throw new Error('Document is not open.');
      const manifest = { schemaVersion: document.schemaVersion, id: document.id, revision: document.revision, kind: document.kind, name: document.name, dirty: document.dirty, updatedAt: document.updatedAt, assetCount: Object.keys(document.assets).length };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest) }] };
    });
    const snapshotTemplate = new ResourceTemplate('aidraw://documents/{id}/snapshot', { list: undefined });
    server.registerResource('AIDraw document snapshot', snapshotTemplate, { title: 'Document snapshot', mimeType: 'application/json' }, async (uri, variables) => {
      const document = this.documents.getDocument(String(variables.id));
      if (!document) throw new Error('Document is not open.');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(document) }] };
    });
    const changesTemplate = new ResourceTemplate('aidraw://documents/{id}/changes/{revision}', { list: undefined });
    server.registerResource('AIDraw document changes', changesTemplate, { title: 'Document changes', mimeType: 'application/json' }, async (uri, variables) => {
      const changes = this.documents.getChanges(String(variables.id), Number(variables.revision));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(changes) }] };
    });
    const traceTemplate = new ResourceTemplate('aidraw://documents/{id}/trace', { list: undefined });
    server.registerResource('AIDraw transaction trace', traceTemplate, { title: 'Durable transaction trace', mimeType: 'application/x-ndjson' }, async (uri, variables) => {
      const entries = await this.documents.listTrace(String(variables.id));
      return { contents: [{ uri: uri.href, mimeType: 'application/x-ndjson', text: entries.map((entry) => JSON.stringify(entry)).join('\n') }] };
    });

    server.registerTool('aidraw_help', {
      title: 'Learn the AIDraw MCP workflow',
      description: 'Return concise model-callable guidance for one workflow topic. Start with quickstart; use the optional aidraw://guide resource for the complete reference.',
      inputSchema: HelpInputSchema,
      outputSchema: HelpOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ topic }) => jsonText(aidrawHelp(topic)));

    server.registerTool('session_manage', {
      title: 'Manage AIDraw agent session',
      description: 'Join, identify, inspect, or leave the live AIDraw workspace. Discovery uses one flat action-enum object for client compatibility; the server strictly validates action-specific fields. See aidraw_help topic=quickstart.',
      inputSchema: SessionManageInputSchema,
      outputSchema: SessionManageOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => {
      const request = SessionManageStrictInputSchema.parse(input);
      let documentId: string | undefined;
      if (request.action === 'join') {
        documentId = request.documentId;
        if (request.name) session.actor.name = request.name;
        session.actor.color = normalizeColor(request.color, session.actor.color);
        if (request.model || request.reasoningEffort || request.taskId) session.actor.client = { model: request.model, reasoningEffort: request.reasoningEffort, taskId: request.taskId };
        this.documents.updatePresence({ actor: session.actor, documentId, queueDepth: 0, status: 'idle' });
      } else if (request.action === 'inspect') {
        documentId = request.documentId;
      } else if (request.action === 'leave') this.documents.removePresence(session.actor.id);
      const activeDocumentId = this.documents.getActiveDocumentId();
      const inspectedDocumentId = documentId ?? activeDocumentId;
      return jsonText({
        actor: session.actor,
        presence: this.documents.getMcpInfo().sessions,
        workspace: {
          activeDocumentId,
          humanOccupancy: inspectedDocumentId ? this.documents.getHumanOccupancy(inspectedDocumentId) : undefined,
          editorAdvisory: this.documents.getEditorAdvisory(),
        },
        next: inspectedDocumentId
          ? { tool: 'canvas_observe', arguments: { documentId: inspectedDocumentId }, guidance: 'Observe canonical state and current revisions before proposing mutations.' }
          : { tool: 'document_manage', arguments: { action: 'list' }, guidance: 'List open documents or create a new document before observing a canvas.' },
      });
    });

    server.registerTool('canvas_observe', {
      title: 'Observe AIDraw canvas',
      description: 'Read canonical state before mutation: a full snapshot or sinceRevision diff, with optional bounded visual/fragment/path evidence. Explicit documentId is safest for multi-document work; see aidraw_help topic=canvas.',
      inputSchema: z.object({
        documentId: DocumentIdInputSchema.optional().describe('Explicit target; omitted means the active document.'),
        sinceRevision: z.number().int().nonnegative().optional().describe('Return canonical changes after this revision instead of the complete current document.'),
        includePng: z.boolean().default(false).describe('Include bounded rendered PNG evidence; false keeps observation structured-only.'),
        assetId: z.string().min(1).optional().describe('Optional pixel asset selector for rendering or fragment work.'),
        frameId: z.string().min(1).optional().describe('Optional sprite frame selector.'),
        layerId: z.string().min(1).optional().describe('Optional illustration or pixel layer selector.'),
        region: ObservationRegionSchema.optional().describe('Optional bounded source-space crop.'),
        scale: z.number().int().min(1).max(16).default(1).describe('Integer nearest-neighbor PNG scale.'),
        background: ObservationBackgroundSchema.default('document').describe('PNG compositing background policy.'),
        compareTransactionId: z.string().min(1).optional().describe('Request retained race-free before/after PNG evidence for the latest matching transaction; requires includePng.'),
        checkpointId: z.string().min(1).optional().describe('Observe one named checkpoint instead of current canonical state; cannot combine with compareTransactionId.'),
        fragment: ObservationFragmentSchema.optional().describe('Export one bounded self-contained illustration-object or pixel-asset fragment.'),
        pathObjectId: z.string().min(1).optional().describe('Inspect normalized path nodes for one illustration path.'),
        illustrationTimeMs: z.number().int().min(0).max(600_000).optional().describe('Optional illustration animation sample time for PNG rendering.'),
      }).strict().refine((value) => !(value.checkpointId && value.compareTransactionId), 'Checkpoint and transaction comparisons cannot be combined.'),
      outputSchema: CanvasObserveOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ documentId, sinceRevision, includePng, assetId, frameId, layerId, region, scale, background, compareTransactionId, checkpointId, fragment, pathObjectId, illustrationTimeMs }) => {
      const id = documentId ?? this.documents.getActiveDocumentId();
      if (!id) return jsonText({ error: 'no_open_document' });
      const currentDocument = this.documents.getDocument(id);
      if (!currentDocument) return jsonText({ error: 'document_not_open' });
      const checkpoint = checkpointId ? this.documents.getCheckpoint(id, checkpointId) : undefined;
      if (checkpointId && !checkpoint) return jsonText({ error: 'checkpoint_not_found', checkpointId });
      const document = checkpoint?.document ?? currentDocument;
      const changes = checkpoint || sinceRevision === undefined ? undefined : this.documents.getChanges(id, sinceRevision);
      const target = { assetId, frameId, layerId, region, scale, background, illustrationTimeMs };
      let fragmentResult: Record<string, unknown> | undefined;
      if (fragment) {
        try {
          if (document.kind === 'illustration' && fragment.kind === 'illustration-objects') {
            if (!fragment.objectIds?.length) throw new Error('Illustration fragment observations require objectIds.');
            const data = exportIllustrationFragment(document, fragment.objectIds);
            fragmentResult = { available: true, byteLength: documentFragmentBytes(data), data };
          } else if (document.kind === 'pixel' && fragment.kind === 'pixel-assets') {
            const data = exportPixelFragment(document, fragment.assetId);
            fragmentResult = { available: true, byteLength: documentFragmentBytes(data), data };
          } else fragmentResult = { available: false, error: 'fragment_kind_mismatch', message: `A ${fragment.kind} fragment cannot be exported from a ${document.kind} document.` };
        } catch (error) {
          fragmentResult = { available: false, error: 'fragment_export_failed', message: error instanceof Error ? error.message : 'The fragment could not be exported.' };
        }
      }
      let pathResult: Record<string, unknown> | undefined;
      if (pathObjectId) {
        try {
          const targetPath = semanticPath(document, pathObjectId).object;
          pathResult = { available: true, objectId: targetPath.id, revision: targetPath.revision, closed: targetPath.closed, nodes: inspectPathNodes(targetPath.pathData) };
        } catch (error) { pathResult = { available: false, error: 'path_nodes_unavailable', message: error instanceof Error ? error.message : 'Path nodes could not be inspected.' }; }
      }
      const comparison = compareTransactionId ? this.documents.getLastComparison(id, compareTransactionId) : undefined;
      const perImagePixels = compareTransactionId ? Math.floor(MAX_OBSERVATION_PIXELS / 2) : MAX_OBSERVATION_PIXELS;
      const png = includePng ? await this.captureCanvasObservation(document, target, perImagePixels) : undefined;
      const comparisonResult = !compareTransactionId ? undefined
        : !includePng ? { available: false, error: 'comparison_requires_png', guidance: 'Set includePng=true to request a paired observation.' }
        : !comparison ? { available: false, error: 'comparison_unavailable', transactionId: compareTransactionId, guidance: 'Only the most recent committed transaction for an open document is retained for race-free comparison.' }
        : { available: true, transactionId: compareTransactionId, beforeRevision: comparison.before.revision, afterRevision: comparison.after.revision, before: await this.captureCanvasObservation(comparison.before, target, perImagePixels), after: png };
      return jsonText({
        document: fragment ? undefined : changes === undefined ? document : undefined,
        changes,
        revision: document.revision,
        currentRevision: currentDocument.revision,
        target: { ...target, compareTransactionId, checkpointId },
        checkpoint: checkpoint ? this.documents.listCheckpoints(id).find((entry) => entry.id === checkpoint.id) : undefined,
        fragment: fragmentResult,
        path: pathResult,
        humanOccupancy: this.documents.getHumanOccupancy(id),
        editorAdvisory: this.documents.getEditorAdvisory(),
        png: compareTransactionId ? undefined : png,
        comparison: comparisonResult,
      });
    });

    server.registerTool('canvas_apply', {
      title: 'Apply visible AIDraw transaction',
      description: 'Submit up to 256 idempotent canvas operations. Observe first, carry expected revisions inside operations, respect human locks, and use a stable clientOperationId only to retry the same logical transaction. See aidraw_help topic=operations.',
      inputSchema: z.object({
        documentId: DocumentIdInputSchema,
        clientOperationId: z.string().min(1).max(200).describe('Caller-stable idempotency key. Reuse only for an exact retry; use a fresh key for a changed intent.'),
        label: z.string().min(1).max(200).describe('Human-visible transaction label used in playback, history, and attribution.'),
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(256).describe('Canonical or semantic operation objects. Read aidraw_help topic=operations and canvas_observe before constructing them.'),
        playback: z.object({ mode: z.enum(['animated', 'instant']).default('animated'), speed: z.number().min(0.25).max(4).default(1) }).optional().describe('Visible playback policy; instant still uses the canonical scheduler and lock policy.'),
        batch: z.object({ jobId: JobIdInputSchema, resumeToken: z.string().min(32).max(200).describe('Private batch capability returned by job_manage action=start-batch.'), sequence: z.number().int().min(0).max(9_999).describe('Exact nextSequence returned by start/resume.') }).strict().optional(),
      }).strict(),
      outputSchema: CanvasApplyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ documentId, clientOperationId, label, operations, playback, batch }) => {
      const document = this.documents.getDocument(documentId);
      if (!document) return jsonText({ status: 'conflict', message: 'Document is not open.', next: { tool: 'document_manage', arguments: { action: 'list' }, guidance: 'Refresh the open-document list before choosing a mutation target.' } });
      const parsedOperations: CanvasOperation[] = [];
      for (const operation of operations) parsedOperations.push(...await expandAgentCanvasOperation(document, operation, this.quantizeImage, session.actor));
      if (parsedOperations.length === 0 || parsedOperations.length > 256) return jsonText({ status: 'conflict', message: 'Semantic expansion must produce 1–256 canonical operations.' });
      const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId, documentId, actor: structuredClone(session.actor), label, createdAt: nowIso(), operations: parsedOperations, playback: playback ?? { mode: 'animated', speed: 1 } };
      if (batch) {
        const preparation = await this.batches.prepare(batch, documentId, clientOperationId, session.actor);
        if (!preparation.accepted) {
          const response = { ...preparation.response, batch: { jobId: batch.jobId, expectedSequence: preparation.expectedSequence, duplicate: preparation.duplicate } };
          return jsonText({ ...response, next: canvasRetryNextStep(String(response.status), documentId) });
        }
        this.activeBatchTransactions.set(batch.jobId, transaction.id);
      }
      let result;
      try { result = await this.scheduler.submit(transaction); }
      catch (error) { result = { status: 'conflict' as const, message: error instanceof Error ? error.message : 'The batch transaction failed.' }; }
      if (batch && this.activeBatchTransactions.get(batch.jobId) === transaction.id) this.activeBatchTransactions.delete(batch.jobId);
      const batchJob = batch ? await this.batches.finish(batch, clientOperationId, result) : undefined;
      return jsonText({ ...result, batch: batchJob ? { jobId: batchJob.id, progress: batchJob.progress, status: batchJob.status, ...(batchJob.result as Record<string, unknown>) } : undefined, next: canvasRetryNextStep(result.status, documentId) });
    });

    server.registerTool('history_manage', {
      title: 'Manage this agent’s AIDraw history',
      description: 'Undo or redo only this actor’s transactions, replay a durable trace, or manage named checkpoints. Discovery is flat; the server strictly validates the selected action’s required and forbidden fields. See aidraw_help topic=history.',
      inputSchema: HistoryManageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (input) => {
      const request = HistoryManageStrictInputSchema.parse(input);
      if (request.action === 'undo') return jsonText(await this.documents.undo(request.documentId, session.actor));
      if (request.action === 'redo') return jsonText(await this.documents.redo(request.documentId, session.actor));
      const id = request.documentId ?? this.documents.getActiveDocumentId();
      if (!id) return request.action === 'replay' ? jsonText({ replaying: false, reason: 'no_open_document' }) : jsonText({ error: 'no_open_document' });
      if (request.action === 'checkpoint-list') return jsonText({ documentId: id, checkpoints: this.documents.listCheckpoints(id) });
      if (request.action === 'checkpoint-create') {
        try { return jsonText({ checkpoint: this.documents.createCheckpoint(id, request.name, session.actor) }); }
        catch (error) { return jsonText({ error: 'checkpoint_create_failed', message: error instanceof Error ? error.message : String(error) }); }
      }
      if (request.action === 'checkpoint-restore') {
        return jsonText(await this.documents.restoreCheckpoint(id, request.checkpointId, session.actor));
      }
      if (request.action === 'checkpoint-merge') {
        return jsonText(await this.documents.mergeCheckpoint(id, request.checkpointId, request.sourceIds, session.actor));
      }
      if (request.action === 'checkpoint-delete') {
        return jsonText(this.documents.deleteCheckpoint(id, request.checkpointId, session.actor));
      }
      const trace = await this.documents.findTrace(id, request.transactionId);
      if (!trace) return jsonText({ replaying: false, reason: 'trace_not_found' });
      return jsonText({ ...this.scheduler.replay(trace.transaction), documentId: id, transactionId: request.transactionId });
    });

    server.registerTool('document_manage', {
      title: 'Manage AIDraw documents',
      description: 'List, create, activate, open, save, save-as, or close documents. Discovery is flat; the server strictly validates the selected action’s required and forbidden fields. File reads, new paths, and overwrites become human-visible approval jobs. See aidraw_help topic=documents or files.',
      inputSchema: DocumentManageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (input) => {
      const request = DocumentManageStrictInputSchema.parse(input);
      if (request.action === 'list') {
        const snapshot = this.documents.snapshot(session.actor.id);
        return jsonText({ activeDocumentId: snapshot.activeDocumentId, documents: snapshot.documents });
      }
      if (request.action === 'new') {
        const options = NewDocumentOptionsSchema.parse({ kind: request.kind, name: request.name, width: request.width, height: request.height, background: request.background, orientation: request.orientation, infinite: request.infinite, tileWidth: request.tileWidth, tileHeight: request.tileHeight });
        return jsonText(this.documents.create(options));
      }
      if (request.action === 'activate') return jsonText(this.documents.activate(request.documentId));
      if (request.action === 'open') return approvalJob('import', 'Open AIDraw document', 'Review the exact path before AIDraw reads this native document.', undefined, request);
      if (request.action === 'save') {
        const document = this.documents.getDocument(request.documentId);
        if (!document?.filePath) return jsonText({ error: 'approval_required', message: 'This document has no canonical path. Call save-as with an exact path for human review.', next: { tool: 'document_manage', guidance: 'Call action=save-as with this documentId and an exact new .aidraw destination.' } });
        return approvalJob('save', 'Overwrite AIDraw document', 'Review the existing destination before the agent overwrites it.', request.documentId, { action: request.action, path: document.filePath });
      }
      if (request.action === 'save-as') return approvalJob('save', 'Save AIDraw document as', 'Review the destination and overwrite impact before AIDraw writes this native document.', request.documentId, request);
      return jsonText(await this.documents.close(request.documentId, false));
    });

    server.registerTool('asset_import', {
      title: 'Import asset', description: 'Request a read of one exact path after human review. Optional sprite-sheet, indexed-palette, and project-relink modes are mutually exclusive and retain the same file authority; see aidraw_help topic=files. This tool never enumerates or deletes files.',
      inputSchema: z.object({
        documentId: DocumentIdInputSchema.optional().describe('Target document; required for palette import and project relink, optional for ordinary raster/native import.'),
        path: z.string().min(1).describe('Exact local source path shown to the human before any read.'),
        pixelMode: z.boolean().default(false).describe('Import ordinary raster input into the pixel workflow.'),
        spriteSheet: SpriteSheetImportOptionsSchema.optional().describe('Sprite-sheet slicing mode; cannot combine with paletteMode or projectLinkId.'),
        paletteMode: z.enum(['replace-slots', 'append-unique']).optional().describe('Indexed palette import mode; requires documentId and cannot combine with other modes.'),
        projectLinkId: z.string().min(1).optional().describe('Existing project link to relink; requires a saved pixel document and cannot combine with other modes.'),
      }).strict(),
      outputSchema: ApprovalToolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ documentId, path, pixelMode, spriteSheet, paletteMode, projectLinkId }) => {
      if ([spriteSheet, paletteMode, projectLinkId].filter(Boolean).length > 1) return jsonText({ error: 'invalid_arguments', message: 'Choose spriteSheet, paletteMode, or projectLinkId, not more than one.' });
      if ((paletteMode || projectLinkId) && !documentId) return jsonText({ error: 'document_id_required', message: `${projectLinkId ? 'Project relink' : 'Palette import'} requires a target pixel document.` });
      const extension = extname(path).toLowerCase();
      if (spriteSheet && !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return jsonText({ error: 'unsupported_sprite_sheet', message: 'Sprite-sheet slicing accepts PNG, JPEG, or WebP images.' });
      if (paletteMode && !['.json', '.gpl'].includes(extension)) return jsonText({ error: 'unsupported_palette', message: 'Palette import accepts AIDraw JSON or GIMP GPL files.' });
      if (projectLinkId) {
        if (pixelMode) return jsonText({ error: 'invalid_arguments', message: 'projectLinkId cannot be combined with pixelMode.' });
        if (!['.png', '.apng', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return jsonText({ error: 'unsupported_project_link', message: 'Project relink accepts PNG, APNG, JPEG, WebP, or GIF images.' });
        const document = this.documents.getDocument(documentId!); if (!document || document.kind !== 'pixel') return jsonText({ error: 'pixel_document_required' });
        if (!document.filePath) return jsonText({ error: 'saved_project_required', message: 'Save the AIDraw project before creating a relative external link.' });
        if (!document.linkedAssets.some((link) => link.id === projectLinkId)) return jsonText({ error: 'project_link_not_found', projectLinkId });
        return approvalJob('import', 'Relink pixel-project source', 'Review the replacement source and target project before AIDraw reads it.', documentId, { action: 'project-link-relink', path, projectLinkId });
      }
      return approvalJob('import', spriteSheet ? 'Slice sprite sheet' : paletteMode ? 'Import indexed palette' : 'Import asset', 'Review the requested path, target document, and import settings before AIDraw reads it.', documentId, { action: 'import', path, pixelMode: spriteSheet ? true : pixelMode, spriteSheet, paletteMode });
    });

    server.registerTool('document_export', {
      title: 'Export document', description: 'Request one exact no-overwrite export target after human review, including companion paths and an optional exact tag or palette-cycle schedule. Supply format for document export, or projectLinkId alone for cached-link extraction; see aidraw_help topic=files.',
      inputSchema: z.object({
        documentId: DocumentIdInputSchema,
        path: z.string().min(1).describe('Exact destination filename including extension; AIDraw reports every existing target to the human.'),
        format: z.enum(['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml']).optional().describe('Required for document export; omit when projectLinkId extracts its verified cached source.'),
        scale: z.number().int().min(1).max(64).default(1).describe('Integer nearest-neighbor presentation scale where supported.'),
        animationTagId: z.string().min(1).optional().describe('Optional exact animation tag ID limiting GIF, APNG, or sprite-sheet export to that independent range.'),
        paletteCycleId: z.string().min(1).optional().describe('Exact named palette-cycle ID for one complete derived GIF/APNG/sprite-sheet period; requires paletteCycleFrameId, and GIF requires stepMs divisible by 10.'),
        paletteCycleFrameId: z.string().min(1).optional().describe('Exact active-sprite source-frame ID for paletteCycleId.'),
        projectLinkId: z.string().min(1).optional().describe('Extract exactly one cached project link; cannot combine with format, animationTagId, palette-cycle fields, or non-default scale.'),
      }).strict(),
      outputSchema: ApprovalToolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ documentId, path, format, scale, animationTagId, paletteCycleId, paletteCycleFrameId, projectLinkId }) => {
      if (!extname(path)) return jsonText({ error: 'extension_required', message: 'Provide an exact export filename including its extension.' });
      const paletteCycleRequested = paletteCycleId !== undefined || paletteCycleFrameId !== undefined;
      if (paletteCycleRequested && (!paletteCycleId || !paletteCycleFrameId)) return jsonText({ error: 'invalid_arguments', message: 'Palette-cycle export requires both paletteCycleId and paletteCycleFrameId.' });
      if (paletteCycleRequested && animationTagId) return jsonText({ error: 'invalid_arguments', message: 'Choose either animationTagId or a palette cycle, not both.' });
      if (projectLinkId) {
        if (format || animationTagId || paletteCycleRequested || scale !== 1) return jsonText({ error: 'invalid_arguments', message: 'Project-link extraction cannot be combined with document format, animation tag, palette cycle, or presentation scale.' });
        const document = this.documents.getDocument(documentId); if (!document || document.kind !== 'pixel') return jsonText({ error: 'pixel_document_required' });
        if (!document.filePath) return jsonText({ error: 'saved_project_required', message: 'Save the AIDraw project before extracting a relative external link.' });
        if (!document.linkedAssets.some((link) => link.id === projectLinkId)) return jsonText({ error: 'project_link_not_found', projectLinkId });
        try {
          const extension = projectLinkFileExtension(verifiedPixelLinkCache(document, projectLinkId).asset);
          const targetExtension = extname(path).toLowerCase(); const accepted = extension === 'jpg' ? ['.jpg', '.jpeg'] : extension === 'apng' ? ['.apng', '.png'] : [`.${extension}`];
          if (!accepted.includes(targetExtension)) return jsonText({ error: 'extension_mismatch', message: `The cached source must be extracted as ${accepted.join(' or ')}.` });
        } catch (error) { return jsonText({ error: 'project_link_unavailable', message: error instanceof Error ? error.message : String(error) }); }
        return approvalJob('export', 'Extract pixel-project source', 'Review the cached source, destination, and overwrite impact before AIDraw writes it.', documentId, { action: 'project-link-extract', path, projectLinkId });
      }
      if (!format) return jsonText({ error: 'format_required', message: 'Document export requires a format.' });
      if (animationTagId) {
        if (!['gif', 'apng', 'sprite-sheet'].includes(format)) return jsonText({ error: 'unsupported_animation_tag_format', message: 'Animation-tag export is available only for GIF, APNG, and sprite sheets.' });
        const document = this.documents.getDocument(documentId);
        if (!document || document.kind !== 'pixel') return jsonText({ error: 'pixel_document_required', message: 'Animation-tag export requires an open pixel document.' });
        const sprite = document.pixelAssets[document.activeAssetId];
        if (sprite?.type !== 'sprite') return jsonText({ error: 'active_sprite_required', message: 'Animation-tag export requires an active pixel sprite.' });
        if (!sprite.tags.some((tag) => tag.id === animationTagId)) return jsonText({ error: 'animation_tag_not_found', animationTagId, message: `Exact animation tag ID “${animationTagId}” does not exist in the active sprite.` });
      }
      if (paletteCycleRequested) {
        if (!['gif', 'apng', 'sprite-sheet'].includes(format)) return jsonText({ error: 'unsupported_palette_cycle_format', message: 'Palette-cycle export is available only for GIF, APNG, and sprite sheets.' });
        const document = this.documents.getDocument(documentId);
        if (!document || document.kind !== 'pixel') return jsonText({ error: 'pixel_document_required', message: 'Palette-cycle export requires an open pixel document.' });
        const sprite = document.pixelAssets[document.activeAssetId];
        if (sprite?.type !== 'sprite') return jsonText({ error: 'active_sprite_required', message: 'Palette-cycle export requires an active pixel sprite.' });
        const cycle = document.paletteCycles.find((entry) => entry.id === paletteCycleId);
        if (!cycle) return jsonText({ error: 'palette_cycle_not_found', paletteCycleId });
        try { validatePaletteCycle(cycle, document.palette.length); }
        catch (error) { return jsonText({ error: 'invalid_palette_cycle', message: error instanceof Error ? error.message : String(error) }); }
        if (!sprite.frameIds.includes(paletteCycleFrameId!) || !sprite.frames[paletteCycleFrameId!]) return jsonText({ error: 'palette_cycle_frame_not_found', paletteCycleFrameId });
        if (format === 'gif' && cycle.stepMs % 10 !== 0) return jsonText({
          error: 'inexact_gif_timing',
          message: `Palette cycle “${cycle.name}” uses ${cycle.stepMs} ms steps, which GIF cannot represent exactly; export APNG or use a 10-millisecond multiple.`,
          paletteCycleId: cycle.id,
          stepMs: cycle.stepMs,
        });
      }
      return approvalJob('export', 'Export document', 'Review format, scale, derived animation schedule, destination, and overwrite impact before AIDraw writes it.', documentId, { action: 'export', path, format, scale, animationTagId, paletteCycleId, paletteCycleFrameId });
    });

    server.registerTool('generation_start', {
      title: 'Generate imagery', description: 'Create a human-only provider approval showing actor, prompt, sources, mask, result count, and possible paid requests. No provider call begins before approval; see aidraw_help topic=jobs or safety.',
      inputSchema: z.object({
        documentId: DocumentIdInputSchema,
        provider: z.enum(['openai', 'stability', 'comfyui']).describe('Configured provider presented to the human; the call may be paid after approval.'),
        mode: z.enum(['create', 'edit', 'inpaint', 'outpaint', 'variation']).describe('Workflow mode; source and mask requirements remain provider/mode validated.'),
        prompt: z.string().min(1).describe('Private generation prompt shown in the approval, never included in public job summaries.'),
        negativePrompt: z.string().optional().describe('Optional private negative prompt.'),
        sourceAssetIds: z.array(z.string()).default([]).describe('Canonical embedded source asset IDs.'),
        maskAssetId: z.string().optional().describe('Optional canonical embedded mask asset ID where the mode supports it.'),
        size: z.union([z.literal('auto'), z.object({ width: z.number().int().positive(), height: z.number().int().positive() })]).default('auto').describe('Requested output size or provider-managed automatic sizing.'),
        aspectIntent: z.enum(['canvas', 'square', 'portrait', 'landscape']).optional(),
        resultCount: z.number().int().min(1).max(4).default(1).describe('Potential provider request/output count shown before approval.'),
        seed: z.number().int().optional().describe('Optional deterministic provider seed where supported.'),
        providerOptions: z.record(z.string(), z.unknown()).default({}).describe('Provider-specific bounded options validated against the selected contract.'),
      }).strict(),
      outputSchema: ApprovalToolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (request) => { try { validateGenerationRequest(this.documents.getDocument(request.documentId), request as GenerationRequest); return approvalJob('generation', 'Generate imagery', 'Review provider, prompt, sources, mask, result count, and the potentially paid request count.', request.documentId, request, false); } catch (error) { return jsonText({ error: 'unsupported_generation_request', message: error instanceof Error ? error.message : String(error) }); } });

    server.registerTool('job_manage', {
      title: 'Inspect or cancel AIDraw jobs',
      description: 'List owner-private redacted jobs, inspect/wait/cancel one, report a human approval dependency, or start/resume a durable transaction batch. Discovery is flat; the server strictly validates the selected action’s required and forbidden fields. See aidraw_help topic=jobs.',
      inputSchema: JobManageInputSchema,
      outputSchema: JobManageOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => {
      const request = JobManageStrictInputSchema.parse(input);
      if (request.action === 'start-batch') {
        try {
          const started = await this.batches.start(request.documentId, request.totalTransactions, request.label ?? 'Agent batch', session.actor);
          return jsonText({
            job: agentJobSummary(started.job), resumeToken: started.resumeToken, nextSequence: started.nextSequence,
            next: { tool: 'canvas_apply', guidance: 'Submit the first transaction with batch.jobId, the private resumeToken returned here, and sequence=nextSequence. Retain the token privately.' },
          });
        } catch (error) { return jsonText({ error: 'batch_start_failed', message: error instanceof Error ? error.message : 'The durable batch could not start.' }); }
      }
      if (request.action === 'resume-batch') {
        const job = await this.batches.resume(request.jobId, request.resumeToken, session.actor);
        const nextSequence = (job?.result as { nextSequence?: number } | undefined)?.nextSequence;
        return job ? jsonText({
          job: agentJobSummary(job), nextSequence,
          next: { tool: 'canvas_apply', guidance: 'Continue with the retained private resumeToken and the returned nextSequence; do not replay a different logical transaction under an old clientOperationId.' },
        }) : jsonText({ error: 'job_not_found' });
      }
      if (request.action === 'list') return jsonText({ jobs: this.documents.listJobs(session.actor.id).map(agentJobSummary) });
      let job = this.documents.getJob(request.jobId);
      if (!job || job.actor.id !== session.actor.id) return jsonText({ error: 'job_not_found' });
      if (request.action === 'cancel' && !['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (job.kind === 'batch') {
          job = await this.batches.cancel(request.jobId, session.actor.id) ?? job;
          const transactionId = this.activeBatchTransactions.get(request.jobId); if (transactionId) this.scheduler.cancelTransaction(transactionId);
        }
        else {
          if (job.kind === 'generation') this.cancelJob?.(request.jobId);
          job = this.documents.getJob(request.jobId) ?? job;
        }
        if (!['cancelled', 'completed', 'failed'].includes(job.status)) { job = { ...job, status: 'cancelled', updatedAt: nowIso(), message: 'Cancelled by the originating agent.' }; this.documents.upsertJob(job); }
      } else if (request.action === 'wait' && request.timeoutMs > 0) {
        const deadline = Date.now() + request.timeoutMs;
        while (Date.now() < deadline && ['queued', 'running', 'waiting-for-user'].includes(job.status)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = this.documents.getJob(request.jobId) ?? job;
        }
      }
      return jsonText(agentJobSummary(job));
    });
    const subscribable = (uri: string) => uri === 'aidraw://documents' || /^aidraw:\/\/documents\/[^/]+\/(?:manifest|snapshot|trace|changes\/\d+)$/.test(uri);
    server.server.setRequestHandler('resources/subscribe', async (request) => {
      const uri = request.params.uri; if (!subscribable(uri)) throw new Error('Only AIDraw document resources can be subscribed.');
      if (!session.subscriptions.has(uri) && session.subscriptions.size >= MAX_MCP_RESOURCE_SUBSCRIPTIONS) throw new Error(`A session may subscribe to at most ${MAX_MCP_RESOURCE_SUBSCRIPTIONS} AIDraw resources.`);
      session.subscriptions.add(uri); return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', async (request) => { session.subscriptions.delete(request.params.uri); return {}; });
    return server;
  }

  private async notifyDocumentUpdated(documentId: string, revision: number): Promise<void> {
    for (const session of this.sessions.values()) {
      const uris = [`aidraw://documents/${documentId}/manifest`, `aidraw://documents/${documentId}/snapshot`, `aidraw://documents/${documentId}/changes/${revision - 1}`, `aidraw://documents/${documentId}/trace`].filter((uri) => session.subscriptions.has(uri));
      await Promise.allSettled(uris.map((uri) => session.mcp.server.sendResourceUpdated({ uri })));
    }
  }

  private trustSettingsPath(): string { return join(dirname(this.preferredPortPath), 'trusted-folders.json'); }

  private normalizeFolder(folder: string): string { const value = resolve(folder); return process.platform === 'win32' ? value.toLowerCase() : value; }

  private async canonicalizeFolder(folder: string): Promise<string> { return this.normalizeFolder(await canonicalizeRequestedPath(folder)); }

  private isWithinFolder(folder: string, filePath: string): boolean { const relativePath = relative(folder, this.normalizeFolder(filePath)); return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath)); }

  private isTrustedPath(actorId: string, filePath: string): boolean {
    const folders = [...this.launchTrustedFolders, ...this.persistentTrustedFolders, ...(this.sessionTrustedFolders.get(actorId) ?? [])]; return folders.some((folder) => this.isWithinFolder(folder, filePath));
  }

  private async rememberTrust(job: AsyncJob, decision: ApprovalDecision): Promise<void> {
    if (!['import', 'export', 'save'].includes(job.kind) || (decision !== 'allow-session' && decision !== 'allow-always')) return;
    // Approval requests already carry the canonical path resolved before the
    // job was created. Preserve synchronous session-trust installation before
    // this async handler's first write so the next MCP call cannot race it.
    const result = job.result as { request?: { path?: unknown } } | undefined; if (typeof result?.request?.path !== 'string') return; const folder = this.normalizeFolder(dirname(resolve(result.request.path)));
    if (decision === 'allow-session') {
      if (!this.hasActiveSession(job.actor.id)) return;
      const folders = this.sessionTrustedFolders.get(job.actor.id) ?? new Set<string>(); folders.add(folder); this.sessionTrustedFolders.set(job.actor.id, folders); return;
    }
    const persist = async () => {
      const folders = new Set(this.persistentTrustedFolders); folders.add(folder);
      await writePrivateMcpSettings(this.trustSettingsPath(), { version: 1, folders: [...folders] } satisfies FolderTrustSettings);
      this.persistentTrustedFolders.clear();
      for (const trustedFolder of folders) this.persistentTrustedFolders.add(trustedFolder);
    };
    const writeResult = this.persistentTrustWrite.then(persist, persist);
    this.persistentTrustWrite = writeResult.then(() => undefined, () => undefined);
    await writeResult;
  }

  private async readFolderTrust(): Promise<void> {
    this.persistentTrustedFolders.clear();
    try {
      const folders = parseFolderTrustSettings(JSON.parse(await readFile(this.trustSettingsPath(), 'utf8')) as unknown);
      if (!folders) return;
      const canonicalFolders = new Set<string>();
      for (const folder of folders) {
        const canonical = await this.canonicalizeFolder(folder);
        if (canonicalFolders.has(canonical)) return;
        canonicalFolders.add(canonical);
      }
      for (const folder of canonicalFolders) this.persistentTrustedFolders.add(folder);
    } catch { /* Missing, stale, or corrupt trust state grants no persistent authority. */ }
  }

  private async readPreferredPort(): Promise<number> {
    try {
      return parsePreferredPortSettings(JSON.parse(await readFile(this.preferredPortPath, 'utf8')) as unknown) ?? PORT_START;
    } catch {
      return PORT_START;
    }
  }

  private async writePreferredPort(port: number): Promise<void> {
    await writePrivateMcpSettings(this.preferredPortPath, { version: 1, preferredPort: port } satisfies PortSettings);
  }
}

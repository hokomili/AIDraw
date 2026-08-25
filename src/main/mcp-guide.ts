export const AIDRAW_GUIDE_URI = 'aidraw://guide';

export const AIDRAW_HELP_TOPICS = ['quickstart', 'documents', 'canvas', 'jobs', 'history', 'files', 'operations', 'safety'] as const;
export type AIDrawHelpTopic = (typeof AIDRAW_HELP_TOPICS)[number];

interface HelpExample {
  tool: string;
  arguments: Record<string, unknown>;
  purpose: string;
}

export interface AIDrawHelpResult {
  topic: AIDrawHelpTopic;
  summary: string;
  steps: string[];
  invariants: string[];
  relatedTools: string[];
  examples: HelpExample[];
  guideUri: typeof AIDRAW_GUIDE_URI;
}

const sharedInvariants = [
  'Join or inspect first, then use document_manage action=list to obtain canonical document IDs.',
  'Observe before mutation. Use current entity/document revisions in expectedRevision fields and re-observe after conflicts.',
  'Reuse clientOperationId only when retrying the same logical canvas transaction; use a new value for new intent.',
  'Human locks have priority. A locked or busy result is retryable guidance, not permission to bypass occupancy.',
  'Only a human in AIDraw may approve jobs. Folder trust never authorizes overwrites, which always require review.',
  'Automatic MCP availability grants canvas access only. It does not grant filesystem access; explicit file approval or separately declared folder authority is a distinct user decision.',
  'job_manage is owner-scoped and intentionally omits raw job results, prompts, paths, and other private approval details.',
];

const helpTopics: Record<AIDrawHelpTopic, AIDrawHelpResult> = {
  quickstart: {
    topic: 'quickstart',
    summary: 'Cold-client sequence for joining, discovering canonical state, making one revision-safe mutation, and following an approval job.',
    steps: [
      'Call session_manage action=join with a human-readable agent name; action=inspect is read-only and may be used instead.',
      'Call document_manage action=list. Use activeDocumentId or a returned document ID; never invent IDs.',
      'Call canvas_observe for that document. The snapshot supplies current revisions, entity IDs, locks, and advisory UI state.',
      'Call canvas_apply with a unique clientOperationId, a concise label, 1–256 operations, and expected revisions from observation where the operation supports them.',
      'For open/save-as/import/export, retain the returned jobId. Automatic MCP setup does not approve files: a human must approve in AIDraw unless the launch explicitly declared separate folder authority. Use job_manage action=wait or inspect; never attempt approval.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['session_manage', 'document_manage', 'canvas_observe', 'canvas_apply', 'job_manage'],
    examples: [
      { tool: 'session_manage', arguments: { action: 'join', name: 'Example agent', color: '#8268dd' }, purpose: 'Declare the authenticated session identity shown in presence and attribution.' },
      { tool: 'document_manage', arguments: { action: 'list' }, purpose: 'Discover open documents and the active document ID.' },
      { tool: 'canvas_observe', arguments: { documentId: '<documentId>' }, purpose: 'Read canonical state and revisions before editing.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<stable-logical-operation-id>', label: 'Rename document', operations: [{ kind: 'document.rename', name: 'New name' }], playback: { mode: 'instant', speed: 1 } }, purpose: 'Minimal idempotent mutation; observe again afterward.' },
      { tool: 'job_manage', arguments: { action: 'wait', jobId: '<jobId>', timeoutMs: 1000 }, purpose: 'Poll owned work without exposing or approving private job details.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  documents: {
    topic: 'documents',
    summary: 'Document lifecycle actions and their conditional inputs.',
    steps: [
      'list requires only action and returns activeDocumentId plus open document summaries.',
      'new accepts kind illustration|sprite|tilemap|project plus optional name and geometry; tilemap-only fields are orientation, infinite, tileWidth, and tileHeight.',
      'activate, save, and close require documentId. open requires path. save-as requires documentId and path.',
      'open and save-as return approval jobs. save uses the document’s canonical existing filePath and also returns an overwrite approval job.',
      'close never grants discard authority; current dirty/save behavior remains enforced by the document service.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['document_manage', 'canvas_observe', 'job_manage'],
    examples: [
      { tool: 'document_manage', arguments: { action: 'new', kind: 'illustration', name: 'Board', width: 1024, height: 1024, background: null }, purpose: 'Create a transparent illustration.' },
      { tool: 'document_manage', arguments: { action: 'save-as', documentId: '<documentId>', path: '<absolute-new-path>.aidraw' }, purpose: 'Request human-reviewed native save authority.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  canvas: {
    topic: 'canvas',
    summary: 'Canonical observation and idempotent, revision-aware canvas mutation.',
    steps: [
      'canvas_observe defaults to the active document when documentId is omitted, but explicit IDs are safer for multi-document work.',
      'Use sinceRevision for diffs; use includePng only for bounded visual evidence. Optional asset/frame/layer/region selectors narrow pixel work.',
      'canvas_apply accepts canonical reducer operations plus the semantic operation families summarized by topic=operations.',
      'A committed result contains the canonical resulting revision. duplicate means the same clientOperationId already committed and was not applied twice.',
      'locked, busy, and retryable conflict results include next-step guidance; re-observe before changing expected revisions.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['canvas_observe', 'canvas_apply', 'history_manage', 'aidraw_help'],
    examples: [
      { tool: 'canvas_observe', arguments: { documentId: '<documentId>', sinceRevision: 0, includePng: false }, purpose: 'Read structured current state or changes.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Set pixels', operations: [{ kind: 'pixel.cel.region', spriteId: '<spriteId>', celId: '<celId>', runs: [{ x: 0, y: 0, length: 8, index: 3 }], expectedRevision: 4 }] }, purpose: 'Compact revision-checked indexed edit.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  jobs: {
    topic: 'jobs',
    summary: 'Owner-scoped async work, human approval dependencies, cancellation, and durable transaction batches.',
    steps: [
      'list requires only action. inspect, approve-dependent, and cancel require jobId. wait requires jobId and optionally timeoutMs up to 30000.',
      'waiting-for-user means a human must choose in AIDraw. approve-dependent reports that dependency; it does not approve.',
      'Queued/running work can be polled with wait. Terminal summaries remain privacy-redacted; inspect canonical document state afterward.',
      'start-batch requires documentId and totalTransactions. Save the returned resumeToken privately; resume-batch requires both jobId and resumeToken.',
      'Each batch canvas_apply supplies jobId, resumeToken, and the exact next zero-based sequence. Existing committed steps remain after cancellation.',
      'A batch is bound to the exact open document incarnation. Recovery preserves that binding across an engine restart, while closing and reopening or replacing the same document ID retires the old batch without dispatching or reconciling against the replacement.',
      'A live accepted step remains busy until its exact dispatch settles. The private ledger binds sequence, transaction ID, request fingerprint, and prepared/dispatched phase. Proven pre-dispatch abandonment reopens; an ownerless dispatched marker advances only from a trace matching all three identities and otherwise fails as ambiguous without replay.',
      'Cancellation before dispatch is terminal without mutation. Cancellation after dispatch remains pending until settlement, so a committed or partial result is recorded before the batch becomes cancelled.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['job_manage', 'canvas_apply', 'canvas_observe'],
    examples: [
      { tool: 'job_manage', arguments: { action: 'inspect', jobId: '<jobId>' }, purpose: 'Read an owned privacy-redacted job summary.' },
      { tool: 'job_manage', arguments: { action: 'start-batch', documentId: '<documentId>', totalTransactions: 3, label: 'Three-step edit' }, purpose: 'Create resumable ordered work.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  history: {
    topic: 'history',
    summary: 'Actor-scoped undo/redo, bounded trace replay, and named checkpoint workflows.',
    steps: [
      'undo and redo optionally accept documentId and affect only transactions owned by this authenticated actor.',
      'replay requires transactionId and optionally documentId. It is bounded and does not commit a new canonical mutation.',
      'checkpoint-list requires no additional fields; checkpoint-create requires name.',
      'checkpoint-restore and checkpoint-delete require checkpointId. checkpoint-merge requires checkpointId plus 1–32 sourceIds.',
      'Agents may delete only checkpoints they created; restore and merge remain canonical attributed transactions.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['history_manage', 'canvas_observe'],
    examples: [
      { tool: 'history_manage', arguments: { action: 'checkpoint-create', documentId: '<documentId>', name: 'Before variation' }, purpose: 'Create an attributed editable branch point.' },
      { tool: 'history_manage', arguments: { action: 'checkpoint-list', documentId: '<documentId>' }, purpose: 'Discover checkpoint IDs before observe/restore/merge.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  files: {
    topic: 'files',
    summary: 'Explicit-path imports, exports, and native saves.',
    steps: [
      'asset_import always requires path; paletteMode or projectLinkId also requires documentId, and spriteSheet, paletteMode, and projectLinkId are mutually exclusive.',
      'document_export requires documentId, an exact filename with extension, and format unless extracting projectLinkId. animationTagId is one exact active-sprite tag ID for an independent GIF/APNG/sprite-sheet range and is refused before approval when missing or incompatible. One paletteCycleId plus one paletteCycleFrameId requests a complete derived period and cannot combine with animationTagId; GIF additionally requires stepMs divisible by 10 and is refused before approval otherwise.',
      'Automatic stdio MCP connection grants no file authority. New paths may proceed only after human approval or explicit folder authority. The headless --trust-folder option is run-scoped launch authority for controlled workflows, not part of static MCP setup and not a zero-per-launch file-access promise. Overwrites always require human review.',
      'AIDraw never enumerates or deletes files for an agent. Retain the returned jobId and wait for its owner-scoped status instead of inferring approval.',
      'Retain jobId and follow the returned next step with job_manage. Raw requests and output paths are intentionally absent from public job summaries.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['document_manage', 'asset_import', 'document_export', 'job_manage'],
    examples: [
      { tool: 'document_export', arguments: { documentId: '<documentId>', path: '<absolute-new-path>.png', format: 'png', scale: 1 }, purpose: 'Request an actor-bound export approval.' },
      { tool: 'document_export', arguments: { documentId: '<documentId>', path: '<absolute-new-path>.apng', format: 'apng', animationTagId: '<exactTagId>', scale: 1 }, purpose: 'Request one exact independent animation-tag schedule without name guessing or overlap composition.' },
      { tool: 'document_export', arguments: { documentId: '<documentId>', path: '<absolute-new-path>.png', format: 'sprite-sheet', scale: 4, paletteCycleId: '<cycleId>', paletteCycleFrameId: '<frameId>' }, purpose: 'Request one complete derived named-cycle sheet after human approval.' },
      { tool: 'asset_import', arguments: { documentId: '<documentId>', path: '<absolute-input-path>.png', pixelMode: true }, purpose: 'Request a reviewed indexed-pixel import.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  operations: {
    topic: 'operations',
    summary: 'Canvas operation families accepted by canvas_apply, including the complete public editable-vector authoring contract exposed by tools/list.',
    steps: [
      'Core operations include document.rename, asset add|delete, illustration artboard/layer/object/paint/guide/snap/animation operations, and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations. Historical provider provenance in older documents is readable but cannot be created or deleted through MCP.',
      'illustration.object.add is fully described inside canvas_apply operations.items. Supply a unique id, human-readable name, observed writable vector layerId, one type discriminator, and that type’s required geometry. The nested schema covers editable vector-stroke, path, shape, text, image, and group objects plus complete paint, gradient, stroke, transform, filter, crop, shadow, and text-range structures.',
      'For illustration.object.add, omit server-owned revision, createdAt, updatedAt, and createdBy. AIDraw starts revision at 0 and writes commit time plus authenticated actor attribution. Legacy callers may send those four fields, but their values are ignored and cannot forge ownership.',
      'Add-time defaults are visible=true, locked=false, opacity=1, blendMode=normal, and identity transform (individual transform coordinates may be supplied). Rectangle, ellipse, polygon, and star shapes default to solid black fill; line and arrow shapes default to no fill; every shape defaults to a visible 1 px solid black round stroke. Rectangle cornerRadius defaults to 0, polygon sides to 6, and star sides/innerRadius to 5/0.45 on add; fields belonging to another shape subtype are rejected. Paths default to no fill and the same visible stroke, use the bounded SVG grammar accepted by import/render/export, and derive closed from their final Z command unless an equal closed value is supplied. New authoring/import requires exactly one simple subpath, no more than 7,000 nodes under conservative arc expansion, 2–7,000 nodes retained by actual native arc conversion and close coalescing, and at most 1,000,000 characters. Every arc command needs endpoints at least 0.000002 document units apart; each nonzero-radius arc must span more than 0.00001 degrees after ellipse normalization so native conversion retains a cubic. Same-endpoint, eccentric native-collapsed arcs and closed geometry that collapses below two native nodes reject; passive reading of older compound, move-only, over-node, oversized, or degenerate paths is compatibility, not new mutation admission. Arc flags are literal one-character 0/1 values: compact forms A20 10 30 0140 20 and A20 10 30 01 40 20 are valid and arc-convertible, while 1e0, 0.0, and -0 flag spellings are not. Vector strokes default to a 4 px black pressure brush; text defaults to 600×80, left alignment, 1.2 line height, and fallback styling.',
      'Image objects must reference an existing usable embedded image asset. AIDraw derives sourceWidth/sourceHeight from the retained bytes, rejects supplied dimensions that disagree, and admits a crop only when it fits that exact source. Before document cloning or semantic/image expansion, instant and animated public mutations reserve one of four global slots, the sole slot for their document, one of four slots for their authenticated actor, semantic work inside one shared one-million-sample budget, and the request’s worst-case 16 × 1.5 MB image allowance. Busy or over-budget work performs no quantization or image inspection. The admitted memory-only context admits at most 16 distinct projections before base64 decoding or hashing and carries one 30-second deadline through response completion. Repeated references to one unchanged asset reuse one inspection buffer and supervised decode, while add/delete invalidates its projection. groupIndex is valid only together with parentGroupId for add or move.',
      'To mutate an existing object with illustration.object.replace, copy the complete observed object, change only intended editable fields, retain only fields advertised for its exact shape subtype, and send its exact observed revision as expectedRevision. Add-time geometry defaults do not apply to replacement: rectangle requires cornerRadius, polygon requires sides, star requires sides plus innerRadius, and line/arrow fill must be none. To preserve a readable predecessor omission, use the renderer-equivalent values 0, 6, or 5/0.45 respectively. Partial or inert-field replacements fail closed. Native and server-authored semantic edits apply this compatibility normalization automatically; direct public replacements remain strict. Existing readable objects may always be moved or deleted by observed ID/revision; exact delete inverses remain undoable without re-admitting their legacy payload as hostile new input.',
      'tools/list publishes complete closed branches for pixel.cel.region, pixel.tilemap.region, pixel.tile-stamps.replace, and pixel.tile-stamp.place. Observe the sprite/cel or map/tile-layer IDs and revisions first. Region runs contain signed x/y, length 1–65,536, and palette index 0–255 or unsigned Tiled GID 0–4,294,967,295; one request is capped at 65,536 non-overlapping runs and one million cells. GID 0 clears a tile. Derive nonzero GIDs from observed attached tilesets rather than guessing. Tile-stamp dimensions, anchor, cells, unique IDs, transform enum, and placement revision are all present in discovery.',
      'Other pixel semantic operations include flood-fill, replace-color, palette replace-delete, adjust-index, ordered-dither, bitmap-text.paint, selection.transform, image.quantize, frame helpers, project links, bounded image-collection create/append/source replacement/proven-unused removal/reviewed gap movement, exact tile-object creation, map objects, collisions, pixel.wang-terrain.stroke, Wang metadata, and tile variants.',
      'pixel.image-collection.create references 1–1,023 exact one-frame sprite IDs in request order; pixel.image-collection.append adds one exact sprite at max local ID + 1; pixel.image-collection.source.replace changes only one exact existing local ID’s source reference; pixel.image-collection.source.remove deletes only one exact tile record after bounded proof that no map cell, tile object, retained animation, reusable tile stamp, or unsupported Wang state can reference it; pixel.image-collection.tile.move moves one non-highest exact tile into one unused gap inside the unchanged authored span and rewrites every proven animation, Wang, map-cell, tile-object, and reusable-stamp reference. Replacement and removal recompute the nominal source envelope; movement preserves it. Each must be the only request in its transaction and carries the observed document revision; append, replacement, removal, and movement also carry the observed tileset revision.',
      'pixel.tile-object.create addresses one exact attached tileset/local ID, writable object layer, transform state, map point, and new object ID. Image-collection IDs are admitted on finite or sparse-infinite orthogonal/isometric maps with an exact sprite source and production-resolver identity. It must stand alone under the observed document/map/tileset revisions and lowers to one guarded complete-map replacement.',
      'pixel.wang-terrain.stroke requires one exact map, tile layer, attached tileset, Wang set, Wang color, paint|erase mode, 1–65,536 ordered signed points, and the current tile-layer revision. An image collection additionally requires expectedDocumentRevision and must be the sole request; every representative and produced local ID must own an exact sprite and resolve through that orthogonal or isometric attachment. It plans atomically, chooses weighted variants deterministically from that exact logical intent, and creates no revision for an unmatched or already-matching stroke.',
      'Illustration semantic operations include align/distribute, path boolean/node/arc/split/join, material, gradient, text, crop, filters, masks, and animation helpers.',
      'Use canvas_observe to obtain exact IDs and revisions. For large exact changes prefer compact pixel.cel.region or pixel.tilemap.region runs.',
      'Unknown kinds, missing conditionally required fields, stale revisions, forged attribution, and unsafe graph/reference changes fail closed.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['canvas_observe', 'canvas_apply'],
    examples: [
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Add editable rectangle', operations: [{ kind: 'illustration.object.add', object: { id: '<newObjectId>', name: 'Public rectangle', layerId: '<observedVectorLayerId>', type: 'shape', shape: 'rectangle', width: 180, height: 96, transform: { x: 40, y: 50 }, fill: { kind: 'solid', color: '#8268dd' } } }] }, purpose: 'Create a canonical editable shape without forged metadata or undisclosed stroke placeholders; advertised defaults fill the omitted fields.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Paint indexed pixels', operations: [{ kind: 'pixel.cel.region', spriteId: '<observedSpriteId>', celId: '<observedCelId>', runs: [{ x: 0, y: 0, length: 8, index: 3 }], expectedRevision: '<observedCelRevision>' }] }, purpose: 'Use the complete discovery branch for a bounded palette-index edit.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Place observed tile stamp', operations: [{ kind: 'pixel.tile-stamp.place', stampId: '<observedStampId>', mapId: '<observedMapId>', layerId: '<observedTileLayerId>', x: 4, y: 5, transform: 'rotate-clockwise', expectedRevision: '<observedTileLayerRevision>' }] }, purpose: 'Place a reusable tile stamp using only IDs, enum values, coordinates, and revision exposed by discovery plus observation.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Flood fill', operations: [{ kind: 'pixel.flood-fill', spriteId: '<spriteId>', celId: '<celId>', x: 4, y: 4, index: 2, expectedRevision: 7 }] }, purpose: 'Semantic indexed operation expanded into canonical runs.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Create image collection', operations: [{ kind: 'pixel.image-collection.create', tilesetId: '<newTilesetId>', name: 'Terrain props', sourceSpriteIds: ['<sourceA>', '<sourceB>'], expectedDocumentRevision: 12 }] }, purpose: 'Reference exact static project sprites without manufacturing an atlas or GIDs.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Replace collection source', operations: [{ kind: 'pixel.image-collection.source.replace', tilesetId: '<tilesetId>', tileId: 3, sourceSpriteId: '<unusedSource>', expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Deliberately change artwork behind one stable sparse local ID without rebasing a raw GID.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Remove unused collection source', operations: [{ kind: 'pixel.image-collection.source.remove', tilesetId: '<tilesetId>', tileId: 3, expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Detach one exact proven-unused tile record without cascading, deleting its sprite, or rewriting a GID.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Move collection tile into gap', operations: [{ kind: 'pixel.image-collection.tile.move', tilesetId: '<tilesetId>', sourceTileId: 3, destinationTileId: 2, expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Move one non-highest sparse tile into an existing unused ID while atomically rebasing only its proven direct references.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Place collection tile object', operations: [{ kind: 'pixel.tile-object.create', mapId: '<mapId>', layerId: '<objectLayerId>', tilesetId: '<tilesetId>', tileId: 3, objectId: '<newObjectId>', x: 32, y: 48, transforms: { hFlip: true, vFlip: false, diagonal: false }, expectedMapRevision: 7, expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Create one exact tile object without typing or rebasing a raw GID.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Paint terrain path', operations: [{ kind: 'pixel.wang-terrain.stroke', mapId: '<mapId>', layerId: '<tileLayerId>', tilesetId: '<tilesetId>', wangSetId: '<wangSetId>', colorId: 1, mode: 'paint', points: [{ x: 4, y: 5 }, { x: 5, y: 5 }], expectedRevision: 7, expectedDocumentRevision: '<required for an image collection>' }] }, purpose: 'Atomically lower one exact Wang stroke into the established canonical tilemap mutation.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Align shapes', operations: [{ kind: 'illustration.objects.align', objectIds: ['<a>', '<b>'], expectedRevisions: { '<a>': 2, '<b>': 1 }, mode: 'left', target: 'selection' }] }, purpose: 'Semantic multi-object revision-checked alignment.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  safety: {
    topic: 'safety',
    summary: 'Authority, privacy, attribution, concurrency, and retry invariants that apply across every tool.',
    steps: [
      'The bearer-authenticated MCP session owns its actor identity, transactions, jobs, undo stack, presence, and batches.',
      'Entity attribution is rewritten from the authenticated actor; caller-supplied creator/provenance claims do not grant authority.',
      'Observe revisions and human occupancy before edits. Human gestures and locks win; do not bypass or synthesize approval decisions.',
      'File operations address exact paths. Trust is scoped, and overwrites remain reviewed.',
      'Terminate unused transport sessions with authenticated HTTP DELETE. session_manage leave removes presence only; it does not release one of the 32 transport slots.',
      'Classify failures before retrying: ordinary clients keep the unchanged AIDraw stdio bridge, while direct HTTP 401 means an explicit QA bearer is absent, invalid, or belongs to another engine run. HTTP 400 is initialization or protocol version, HTTP 404 unknown_session is a stale process-lifetime session, and tool Invalid arguments means the selected action schema was not satisfied.',
      'Use job summaries only for lifecycle state. Observe canonical documents/resources for final state; private raw job results remain server-internal.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['session_manage', 'canvas_observe', 'canvas_apply', 'job_manage'],
    examples: [
      { tool: 'session_manage', arguments: { action: 'inspect', documentId: '<documentId>' }, purpose: 'Check human occupancy and advisory editor state before mutation.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
};

export function aidrawHelp(topic: AIDrawHelpTopic): AIDrawHelpResult {
  return structuredClone(helpTopics[topic]);
}

export const AIDRAW_SERVER_INSTRUCTIONS = [
  'AIDraw is a stateful, authenticated, agent-native canvas. Start with aidraw_help topic=quickstart.',
  'Use session_manage join|inspect, then document_manage list and canvas_observe before canvas_apply.',
  'tools/list exposes flat action-enum inputs plus complete illustration-object, indexed-pixel-region, tilemap-region, and tile-stamp branches inside canvas_apply operations; the server strictly enforces every selected action and variant. aidraw_help provides concise workflows and aidraw://guide provides the optional complete guide.',
  'Reuse clientOperationId only for the same logical transaction; honor expected revisions and human locks.',
  'AIDraw retains at most 32 transports. Terminate an unused session with authenticated HTTP DELETE; session_manage leave removes presence only.',
  'Transport session IDs last only for this AIDraw process. After HTTP 404 unknown_session, discard the ID, initialize again, and rejoin.',
  'Automatic MCP availability grants no file authority. File calls may return owner-scoped jobs; a human alone approves in AIDraw unless the launch explicitly declared separate folder authority. Follow returned next guidance with job_manage wait|inspect.',
  'Job summaries are privacy-redacted. Read canonical state with canvas_observe or document resources after completion.',
].join(' ');

export const AIDRAW_MCP_GUIDE = `# AIDraw agent protocol guide

This guide is optional progressive reference. A client that supports only tools/list and tools/call can learn the same workflow from **aidraw_help** and the tool/result schemas.

## Reliable cold start

1. Call aidraw_help with topic=quickstart.
2. Call session_manage with action=join (or read-only inspect).
3. Call document_manage with action=list; never invent document/entity IDs.
4. Call canvas_observe before canvas_apply. Copy current revisions into operation expectedRevision fields.
5. If a file call returns jobId, follow its next field with owner-scoped job_manage. Automatic MCP connection grants no file authority; only a human can approve in AIDraw unless a controlled launch separately declared folder authority.

## Session lifecycle and subscription capacity

AIDraw retains at most 32 authenticated transport sessions, counting initialization reservations. A simultaneous 33rd initialize receives HTTP 429. Release capacity by sending authenticated HTTP DELETE with the retained Mcp-Session-Id; this also retires presence, resource subscriptions, and session-scoped folder trust. session_manage leave removes presence only. There is no implicit idle eviction, and engine shutdown closes every transport.

Each session may retain at most 128 distinct resource subscriptions. A duplicate subscribe is idempotent; resources/unsubscribe frees one slot.

This endpoint uses the SDK's stateful legacy initialize/session profile and negotiates protocol version 2025-11-25. A legacy initialize carrying an unsupported or modern-only version receives the supported 2025-11-25 value in its initialize result; after initialization, requests must send that negotiated version and a mismatched MCP-Protocol-Version header is rejected with HTTP 400. Transport session IDs exist only for the lifetime of the owning AIDraw process. After HTTP 404 unknown_session, discard the ID, initialize a fresh transport without it, and join again. This is a configuration profile, not a claim that AIDraw exposes the separate modern server/discover profile or that any named installed client has passed runtime acceptance.

## Transport and tool failures

- **Bridge engine-not-ready** means no valid current engine appeared within the bounded wait. Launch AIDraw and retry through the unchanged stdio client configuration; never add a token or per-launch value.
- **Direct HTTP 401 invalid_token** means an explicit QA bearer is absent, invalid, or belongs to another AIDraw engine run. Ordinary clients use the product stdio bridge. Direct callers must obtain a fresh private caller-owned handoff, initialize a fresh transport, and join again.
- **HTTP 400** is initialization or protocol-version failure. Initialize without Mcp-Session-Id, retain the returned session ID and negotiated 2025-11-25 version, and send that version on later requests.
- **HTTP 404 unknown_session** is a stale process-lifetime session. Discard the ID, initialize without it, then call session_manage with action=join again.
- **Tool-level Invalid arguments** means transport authentication and session routing succeeded, but the selected action's strict schema rejected its fields. Re-read that tool's flat action schema and send only the chosen action's required and allowed fields.

The direct 401, initialization-required 400, missing-or-unsupported-version 400, and unknown-session 404 responses name the stateful-legacy profile, exact supported version, failure class, and safe next action. They never reveal whether a particular bearer exists or remains valid. Configuration-profile availability remains separate from installed-client acceptance.

## Conditional action contracts

- **session_manage**: join accepts identity/presence metadata; inspect accepts optional documentId; leave accepts no other fields.
- **document_manage**: list; new plus kind/name/geometry; activate|save|close require documentId; open requires path; save-as requires documentId and path.
- **history_manage**: undo|redo|checkpoint-list accept optional documentId; replay requires transactionId; checkpoint-create requires name; checkpoint-restore|checkpoint-delete require checkpointId; checkpoint-merge requires checkpointId and 1–32 sourceIds.
- **job_manage**: list; inspect|approve-dependent|cancel require jobId; wait requires jobId and accepts timeoutMs 0–30000; start-batch requires documentId and totalTransactions; resume-batch requires jobId and resumeToken.

Discovery deliberately exposes one flat object for each action-oriented tool: action is a required enum and the union of branch fields is optional and action-labelled, without oneOf/anyOf/allOf composition. canvas_apply is the deliberate exception: each operations item includes complete machine-readable illustration.object.add|replace|move|delete, pixel.cel.region, pixel.tilemap.region, pixel.tile-stamps.replace, and pixel.tile-stamp.place branches plus a compatibility branch for the other canonical and semantic families. That fallback explicitly excludes every published exact kind, so an independent JSON Schema validator cannot accept an incomplete known mutation through it. Strict server validation rejects fields from other actions, malformed variants, unknown operation kinds, and missing conditional fields, so compatibility does not weaken file, ownership, revision, or approval boundaries. Tool descriptions and JSON Schema descriptions explain important parameter semantics and limits.

## Observation and mutation

canvas_observe returns canonical snapshots or revision changes and can optionally render a bounded targeted PNG, compare the latest transaction, inspect path nodes, or export a self-contained fragment. Resources expose document lists, manifests, snapshots, changes, and traces.

canvas_apply accepts 1–256 operations. clientOperationId is the idempotency key for one logical transaction. A duplicate key does not apply twice. Use entity/document revisions from observation; stale replacements conflict, non-overlapping additions may still commit, and human locks return retryable locked state. Playback may be instant or visible/animated. Both modes reserve the same pre-expansion capacity: at most four admitted public mutations globally, one per document, four per authenticated actor, and one million aggregate semantic/playback samples. The lease captures the exact open-document incarnation before asynchronous preparation and retains it through scheduler admission and full or partial apply; closing or replacing that document makes the old edit conflict without changing the replacement or creating replayable work. A workload-heavy semantic pixel operation may need its own transaction. A busy response is issued before document cloning, quantization, or image inspection. Durable batches add jobId, private resumeToken, and exact sequence. Their private authority follows the exact recovered document incarnation across engine restart, but closing and replacing the same document ID retires the old batch before reconciliation or dispatch.

For editable vector authoring, first observe an illustration and choose an existing visible, unlocked vector layer. illustration.object.add requires object.id, object.name, object.layerId, object.type, and the selected type’s geometry. It supports vector-stroke (points; optional brush), path (pathData), shape (shape, width, height), text (text), image (assetId, width, height), and group (optional childIds). Common add defaults are visible=true, locked=false, opacity=1, blendMode=normal, and an identity transform whose individual fields can be overridden. Rectangle, ellipse, polygon, and star shapes default to a solid black fill; line and arrow shapes default to no fill; every shape defaults to a visible 1 px black round stroke. Rectangle cornerRadius defaults to 0, polygon sides to 6, and star sides/innerRadius to 5/0.45 on add only; replacement requires those subtype values explicitly and line/arrow replacement permits only fill=none. Fields for a different shape subtype are rejected. Paths default to no fill and the same stroke, use the bounded SVG grammar exercised by import/render/export, derive closed from the final Z command unless an equal value is supplied, and require one simple subpath retaining 2–7,000 effective native nodes after actual arc conversion and close coalescing inside the 1,000,000-character ceiling. Every arc command needs endpoints at least 0.000002 document units apart; every nonzero-radius arc must span more than 0.00001 degrees after ellipse normalization so the native converter retains a cubic. Same-endpoint, eccentric native-collapsed, smaller arcs and degenerate closed geometry reject before mutation. Passive reading of an older compound, move-only, over-node, oversized, or degenerate predecessor path is compatibility, not new admission or a promise that it can be edited unchanged. Arc flags are literal one-character 0/1 grammar terminals, so compact imported forms such as A20 10 30 0140 20 and A20 10 30 01 40 20 are accepted, and illustration.path.arcs.convert normalizes either spelling before producing editable cubics; numeric lookalikes 1e0, 0.0, and -0 are rejected. Vector strokes default to a 4 px black pressure brush; text defaults to 600×80, left alignment, 1.2 line height, and the built-in fallback text style. Image objects must reference an existing usable embedded image asset; source dimensions are derived from its bytes, supplied values must agree, and any crop must fit. The pre-expansion reservation described above carries the same image-work context and 30-second deadline through response completion. It refuses a seventeenth distinct image projection before base64 decoding or hashing. Exact repeated references to one unchanged asset reuse one inspected buffer and supervised decode; an asset add/delete changes projection identity. For add or move, groupIndex is accepted only with parentGroupId. Paint accepts none, solid hexadecimal color, or linear/radial gradient with 2–32 stops and explicit endpoints. Stroke accepts paint, width 0–10,000, opacity 0–1, butt|round|square cap, miter|round|bevel join, and up to 256 nonnegative dash values.

Do not invent revision, createdAt, updatedAt, or createdBy for an add. The server writes revision 0, commit timestamps, and authenticated actor attribution; compatibility values are accepted only to avoid breaking older clients and are ignored. To replace an object, copy its complete canonical object from canvas_observe, change only intended editable fields, retain only fields shown by discovery for its exact shape subtype, and include its observed revision as expectedRevision. That rule safely normalizes an older readable shape that contains an inert field from another subtype. Replacement is not a partial patch. Move and delete likewise require the exact observed object ID and revision, and delete/undo remains available for readable legacy/imported objects without first replacing them. Re-observe after every committed transaction before the next revision-sensitive edit.

Canonical operation families include document rename; assets; illustration artboard/layer/object/paint/guide/snap/animation; and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations. tools/list gives complete branches for bounded pixel.cel.region and pixel.tilemap.region runs plus reusable pixel.tile-stamps.replace and pixel.tile-stamp.place. Observe exact sprite/cel or map/layer IDs and revisions first; GID 0 clears a tile and nonzero GIDs should come from an observed attached tileset. Historical provider provenance remains passive read compatibility only and cannot be added or deleted. Semantic helpers cover pixel fill/color/dither/text/selection/quantize/frame/stamp/link/image-collection/map/collision/Wang/variant workflows and illustration alignment/path/material/gradient/text/crop/filter/mask/animation workflows. pixel.image-collection.create, pixel.image-collection.append, pixel.image-collection.source.replace, pixel.image-collection.source.remove, and pixel.image-collection.tile.move lower bounded image-collection lifecycle intent into existing canonical operations; each is one transaction guarded by the observed document revision, while append/replacement/removal/movement also check the exact tileset plus every relevant source revision/dimension. Removal additionally proves the exact local ID has no retained map-cell, tile-object, animation, tile-stamp, or unsupported Wang reference, keeps the source sprite and every raw GID untouched, and refuses the final tile. Movement shares the human planner, preserves firstGid/span/source ownership and the complete moved record, and emits only exact tileset/map/stamp replacements after bounded production-resolution and reference scans. pixel.tile-object.create shares the human exact-ID planner, including finite or sparse-infinite orthogonal/isometric collection source resolution and document/map/tileset/source guards, and lowers to one complete map replacement. pixel.wang-terrain.stroke addresses one exact map/layer/attached-tileset/set/color, paint or erase, 1–65,536 ordered signed points, and the observed layer revision. For an image collection it is a sole document-revision-bound request and validates every sparse representative/mapping and source under production resolution on orthogonal or isometric maps. It applies the complete shared Wang plan only by lowering it to one canonical pixel.tilemap.set; unmatched and already-matching requests create no revision, while weighted variants use an intent-derived deterministic stream without reading or changing a document seed. Wang metadata operations use the same collection document/source guard without adding a reducer kind. Call aidraw_help with topic=operations for compact examples; tools still validate every canonical field, limit, graph reference, and revision.

## Jobs, approvals, files, and privacy

Open, save, save-as, import, and export may return jobs. Automatic MCP connection alone grants no file authority. Waiting jobs include explicit next guidance. A human chooses approval in the AIDraw UI; job_manage approve-dependent reports the dependency but cannot approve it. Explicit folder trust is a separate folder- and actor-scoped authority and does not cover overwrites. In controlled headless QA, --trust-folder is run-scoped launch authority and must not be represented as part of the static zero-per-launch MCP connection contract. Agents cannot enumerate or delete files through these tools.

job_manage is owner-scoped. Summaries include lifecycle, actor, progress, sanitized error, batch progress, dependency, and next guidance, but omit raw requests/results, prompts, target paths, approval internals, tokens, and other private details. After completion, observe canonical document state rather than expecting private job output.

## Save and history semantics

save requires an existing canonical filePath and creates overwrite review. save-as requires an exact path; AIDraw normalizes the native extension. close does not grant discard authority. Undo/redo are actor-scoped. Checkpoints are attributed editable snapshots; restore and merge are canonical transactions, and agents may delete only their own checkpoints.

## Resources

- aidraw://guide — this complete progressive reference.
- aidraw://documents — open document summaries.
- aidraw://documents/{id}/manifest — compact canonical identity/revision metadata.
- aidraw://documents/{id}/snapshot — complete canonical document.
- aidraw://documents/{id}/changes/{revision} — changes after a revision.
- aidraw://documents/{id}/trace — durable attributed transaction trace.

Resource and instruction support varies by client. Tool discovery plus aidraw_help and returned next guidance are therefore the correctness baseline.
`;

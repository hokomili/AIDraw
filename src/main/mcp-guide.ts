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
  'Only a human in AIDraw may approve jobs. File authority never authorizes generation, and overwrites always require review.',
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
      'For open/save-as/import/export/generation, retain the returned jobId. A human must approve in AIDraw; use job_manage action=wait or inspect, never attempt approval.',
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
    summary: 'Explicit-path imports, exports, native saves, and generation approvals.',
    steps: [
      'asset_import always requires path; paletteMode or projectLinkId also requires documentId, and spriteSheet, paletteMode, and projectLinkId are mutually exclusive.',
      'document_export requires documentId, an exact filename with extension, and format unless extracting projectLinkId. animationTagId is one exact active-sprite tag ID for an independent GIF/APNG/sprite-sheet range and is refused before approval when missing or incompatible. One paletteCycleId plus one paletteCycleFrameId requests a complete derived period and cannot combine with animationTagId; GIF additionally requires stepMs divisible by 10 and is refused before approval otherwise.',
      'New paths may use explicit trusted-folder authority; overwrites always require human review. AIDraw never enumerates or deletes files for an agent.',
      'generation_start requires documentId, provider, mode, and prompt. It always requires human approval and never inherits folder trust.',
      'Retain jobId and follow the returned next step with job_manage. Raw requests and output paths are intentionally absent from public job summaries.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['document_manage', 'asset_import', 'document_export', 'generation_start', 'job_manage'],
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
    summary: 'Canvas operation families accepted by canvas_apply; field-level limits remain enforced by the tool and canonical schemas.',
    steps: [
      'Core document/asset operations include document.rename, asset/provenance add|delete, illustration artboard/layer/object/paint/guide/snap/animation operations, and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations.',
      'Pixel semantic operations include flood-fill, replace-color, palette replace-delete, adjust-index, ordered-dither, bitmap-text.paint, selection.transform, image.quantize, frame helpers, stamps, project links, bounded image-collection create/append/source replacement/proven-unused removal, exact tile-object creation, map objects, collisions, pixel.wang-terrain.stroke, Wang metadata, and tile variants.',
      'pixel.image-collection.create references 1–1,023 exact one-frame sprite IDs in request order; pixel.image-collection.append adds one exact sprite at max local ID + 1; pixel.image-collection.source.replace changes only one exact existing local ID’s source reference; pixel.image-collection.source.remove deletes only one exact tile record after bounded proof that no map cell, tile object, retained animation, reusable tile stamp, or unsupported Wang state can reference it. Replacement and removal recompute the nominal source envelope. Each must be the only request in its transaction and carries the observed document revision; append, replacement, and removal also carry the observed tileset revision.',
      'pixel.tile-object.create addresses one exact attached tileset/local ID, writable object layer, transform state, map point, and new object ID. Image-collection IDs are admitted on finite or sparse-infinite orthogonal maps with an exact sprite source and production-resolver identity. It must stand alone under the observed document/map/tileset revisions and lowers to one guarded complete-map replacement.',
      'pixel.wang-terrain.stroke requires one exact map, tile layer, attached tileset, Wang set, Wang color, paint|erase mode, 1–65,536 ordered signed points, and the current tile-layer revision. An orthogonal image collection additionally requires expectedDocumentRevision and must be the sole request; every representative and produced local ID must own an exact sprite and resolve through that attachment. It plans atomically, chooses weighted variants deterministically from that exact logical intent, and creates no revision for an unmatched or already-matching stroke.',
      'Illustration semantic operations include align/distribute, path boolean/node/arc/split/join, material, gradient, text, crop, filters, masks, and animation helpers.',
      'Use canvas_observe to obtain exact IDs and revisions. For large exact changes prefer compact pixel.cel.region or pixel.tilemap.region runs.',
      'Unknown kinds, missing conditionally required fields, stale revisions, forged attribution, and unsafe graph/reference changes fail closed.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['canvas_observe', 'canvas_apply'],
    examples: [
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Flood fill', operations: [{ kind: 'pixel.flood-fill', spriteId: '<spriteId>', celId: '<celId>', x: 4, y: 4, index: 2, expectedRevision: 7 }] }, purpose: 'Semantic indexed operation expanded into canonical runs.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Create image collection', operations: [{ kind: 'pixel.image-collection.create', tilesetId: '<newTilesetId>', name: 'Terrain props', sourceSpriteIds: ['<sourceA>', '<sourceB>'], expectedDocumentRevision: 12 }] }, purpose: 'Reference exact static project sprites without manufacturing an atlas or GIDs.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Replace collection source', operations: [{ kind: 'pixel.image-collection.source.replace', tilesetId: '<tilesetId>', tileId: 3, sourceSpriteId: '<unusedSource>', expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Deliberately change artwork behind one stable sparse local ID without rebasing a raw GID.' },
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Remove unused collection source', operations: [{ kind: 'pixel.image-collection.source.remove', tilesetId: '<tilesetId>', tileId: 3, expectedTilesetRevision: 4, expectedDocumentRevision: 12 }] }, purpose: 'Detach one exact proven-unused tile record without cascading, deleting its sprite, or rewriting a GID.' },
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
      'File operations address exact paths. Trust is scoped; overwrites remain reviewed; generation is always separate and potentially paid.',
      'Terminate unused transport sessions with authenticated HTTP DELETE. session_manage leave removes presence only; it does not release one of the 32 transport slots.',
      "Classify failures before retrying: HTTP 401 is authentication; review Activity's current access state, leave access revoked if it should remain disabled, and only otherwise rotate and re-enable if revoked before refreshing the intended profile through its Connect or Show settings path. HTTP 400 is initialization or protocol version, HTTP 404 unknown_session is a stale process-lifetime session, and tool Invalid arguments means the selected action schema was not satisfied.",
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
  'tools/list exposes flat action-enum inputs for broad client discovery; the server strictly enforces each selected action’s required and forbidden fields. aidraw_help provides concise workflows and aidraw://guide provides the optional complete guide.',
  'Reuse clientOperationId only for the same logical transaction; honor expected revisions and human locks.',
  'AIDraw retains at most 32 transports. Terminate an unused session with authenticated HTTP DELETE; session_manage leave removes presence only.',
  'Transport session IDs last only for this AIDraw process. After HTTP 404 unknown_session, discard the ID, initialize again, and rejoin.',
  'File and generation calls may return owner-scoped jobs. A human alone approves in AIDraw; follow returned next guidance with job_manage wait|inspect.',
  'Job summaries are privacy-redacted. Read canonical state with canvas_observe or document resources after completion.',
].join(' ');

export const AIDRAW_MCP_GUIDE = `# AIDraw agent protocol guide

This guide is optional progressive reference. A client that supports only tools/list and tools/call can learn the same workflow from **aidraw_help** and the tool/result schemas.

## Reliable cold start

1. Call aidraw_help with topic=quickstart.
2. Call session_manage with action=join (or read-only inspect).
3. Call document_manage with action=list; never invent document/entity IDs.
4. Call canvas_observe before canvas_apply. Copy current revisions into operation expectedRevision fields.
5. If a file or generation call returns jobId, follow its next field with owner-scoped job_manage. Only a human can approve in AIDraw.

## Session lifecycle and subscription capacity

AIDraw retains at most 32 authenticated transport sessions, counting initialization reservations. A simultaneous 33rd initialize receives HTTP 429. Release capacity by sending authenticated HTTP DELETE with the retained Mcp-Session-Id; this also retires presence, resource subscriptions, and session-scoped folder trust. session_manage leave removes presence only. There is no implicit idle eviction, and engine shutdown closes every transport.

Each session may retain at most 128 distinct resource subscriptions. A duplicate subscribe is idempotent; resources/unsubscribe frees one slot.

This endpoint uses the SDK's stateful legacy initialize/session profile and negotiates protocol version 2025-11-25. A legacy initialize carrying an unsupported or modern-only version receives the supported 2025-11-25 value in its initialize result; after initialization, requests must send that negotiated version and a mismatched MCP-Protocol-Version header is rejected with HTTP 400. Transport session IDs exist only for the lifetime of the owning AIDraw process. After HTTP 404 unknown_session, discard the ID, initialize a fresh transport without it, and join again. This is a configuration profile, not a claim that AIDraw exposes the separate modern server/discover profile or that any named installed client has passed runtime acceptance.

## Transport and tool failures

- **HTTP 401 invalid_token** is authentication failure. The bearer may be absent, invalid, rotated, or revoked; the response never distinguishes credential state. Review Activity's current access state. Leave access revoked if it should remain disabled. Otherwise, if access is revoked, use **Rotate and re-enable**; then refresh the intended configuration profile through its applicable **Connect** or **Show settings** path before initializing a fresh transport and joining again. Do not retry a copied or stale bearer.
- **HTTP 400** is initialization or protocol-version failure. Initialize without Mcp-Session-Id, retain the returned session ID and negotiated 2025-11-25 version, and send that version on later requests.
- **HTTP 404 unknown_session** is a stale process-lifetime session. Discard the ID, initialize without it, then call session_manage with action=join again.
- **Tool-level Invalid arguments** means transport authentication and session routing succeeded, but the selected action's strict schema rejected its fields. Re-read that tool's flat action schema and send only the chosen action's required and allowed fields.

The direct 401, initialization-required 400, missing-or-unsupported-version 400, and unknown-session 404 responses name the stateful-legacy profile, exact supported version, failure class, and safe next action. They never reveal whether a particular bearer exists or remains valid. Configuration-profile availability remains separate from installed-client acceptance.

## Conditional action contracts

- **session_manage**: join accepts identity/presence metadata; inspect accepts optional documentId; leave accepts no other fields.
- **document_manage**: list; new plus kind/name/geometry; activate|save|close require documentId; open requires path; save-as requires documentId and path.
- **history_manage**: undo|redo|checkpoint-list accept optional documentId; replay requires transactionId; checkpoint-create requires name; checkpoint-restore|checkpoint-delete require checkpointId; checkpoint-merge requires checkpointId and 1–32 sourceIds.
- **job_manage**: list; inspect|approve-dependent|cancel require jobId; wait requires jobId and accepts timeoutMs 0–30000; start-batch requires documentId and totalTransactions; resume-batch requires jobId and resumeToken.

Discovery deliberately exposes one flat object per tool: action is a required enum and the union of branch fields is optional and action-labelled, without oneOf/anyOf/allOf composition. Strict server validation rejects fields from other actions and requires the selected action’s conditional fields, so compatibility does not weaken file, ownership, revision, or approval boundaries. Tool descriptions and JSON Schema descriptions explain important parameter semantics and limits.

## Observation and mutation

canvas_observe returns canonical snapshots or revision changes and can optionally render a bounded targeted PNG, compare the latest transaction, inspect path nodes, or export a self-contained fragment. Resources expose document lists, manifests, snapshots, changes, and traces.

canvas_apply accepts 1–256 operations. clientOperationId is the idempotency key for one logical transaction. A duplicate key does not apply twice. Use entity/document revisions from observation; stale replacements conflict, non-overlapping additions may still commit, and human locks return retryable locked state. Playback may be instant or visible/animated. Durable batches add jobId, private resumeToken, and exact sequence.

Canonical operation families include document rename; asset/provenance; illustration artboard/layer/object/paint/guide/snap/animation; and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations. Semantic helpers cover pixel fill/color/dither/text/selection/quantize/frame/stamp/link/image-collection/map/collision/Wang/variant workflows and illustration alignment/path/material/gradient/text/crop/filter/mask/animation workflows. pixel.image-collection.create, pixel.image-collection.append, pixel.image-collection.source.replace, and pixel.image-collection.source.remove lower bounded image-collection lifecycle intent into the existing asset add/replace protocol; each is one transaction guarded by the observed document revision, while append/replacement/removal also check the exact tileset plus every relevant source revision/dimension. Removal additionally proves the exact local ID has no retained map-cell, tile-object, animation, tile-stamp, or unsupported Wang reference, keeps the source sprite and every raw GID untouched, and refuses the final tile. pixel.tile-object.create shares the human exact-ID planner, including finite or sparse-infinite orthogonal collection source resolution and document/map/tileset/source guards, and lowers to one complete map replacement. pixel.wang-terrain.stroke addresses one exact map/layer/attached-tileset/set/color, paint or erase, 1–65,536 ordered signed points, and the observed layer revision. For an image collection it is a sole document-revision-bound request, validates every sparse representative/mapping and source under production resolution, and retains orthogonal mode across finite and sparse-infinite storage. It applies the complete shared Wang plan only by lowering it to one canonical pixel.tilemap.set; unmatched and already-matching requests create no revision, while weighted variants use an intent-derived deterministic stream without reading or changing a document seed. Wang metadata operations use the same collection document/source guard without adding a reducer kind. Call aidraw_help with topic=operations for compact examples; tools still validate every canonical field, limit, graph reference, and revision.

## Jobs, approvals, files, and privacy

Open, save, save-as, import, export, and generation may return jobs. Waiting jobs include explicit next guidance. A human chooses approval in the AIDraw UI; job_manage approve-dependent reports the dependency but cannot approve it. File trust is folder- and actor-scoped, does not cover overwrites, and never covers generation. Agents cannot enumerate or delete files through these tools.

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

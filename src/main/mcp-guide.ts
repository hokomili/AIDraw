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
      'document_export requires documentId, an exact filename with extension, and format unless extracting projectLinkId.',
      'New paths may use explicit trusted-folder authority; overwrites always require human review. AIDraw never enumerates or deletes files for an agent.',
      'generation_start requires documentId, provider, mode, and prompt. It always requires human approval and never inherits folder trust.',
      'Retain jobId and follow the returned next step with job_manage. Raw requests and output paths are intentionally absent from public job summaries.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['document_manage', 'asset_import', 'document_export', 'generation_start', 'job_manage'],
    examples: [
      { tool: 'document_export', arguments: { documentId: '<documentId>', path: '<absolute-new-path>.png', format: 'png', scale: 1 }, purpose: 'Request an actor-bound export approval.' },
      { tool: 'asset_import', arguments: { documentId: '<documentId>', path: '<absolute-input-path>.png', pixelMode: true }, purpose: 'Request a reviewed indexed-pixel import.' },
    ],
    guideUri: AIDRAW_GUIDE_URI,
  },
  operations: {
    topic: 'operations',
    summary: 'Canvas operation families accepted by canvas_apply; field-level limits remain enforced by the tool and canonical schemas.',
    steps: [
      'Core document/asset operations include document.rename, asset/provenance add|delete, illustration artboard/layer/object/paint/guide/snap/animation operations, and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations.',
      'Pixel semantic operations include flood-fill, replace-color, palette replace-delete, adjust-index, ordered-dither, bitmap-text.paint, selection.transform, image.quantize, frame helpers, stamps, project links, map objects, collisions, Wang terrain, and tile variants.',
      'Illustration semantic operations include align/distribute, path boolean/node/arc/split/join, material, gradient, text, crop, filters, masks, and animation helpers.',
      'Use canvas_observe to obtain exact IDs and revisions. For large exact changes prefer compact pixel.cel.region or pixel.tilemap.region runs.',
      'Unknown kinds, missing conditionally required fields, stale revisions, forged attribution, and unsafe graph/reference changes fail closed.',
    ],
    invariants: sharedInvariants,
    relatedTools: ['canvas_observe', 'canvas_apply'],
    examples: [
      { tool: 'canvas_apply', arguments: { documentId: '<documentId>', clientOperationId: '<id>', label: 'Flood fill', operations: [{ kind: 'pixel.flood-fill', spriteId: '<spriteId>', celId: '<celId>', x: 4, y: 4, index: 2, expectedRevision: 7 }] }, purpose: 'Semantic indexed operation expanded into canonical runs.' },
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
  'tools/list is authoritative for conditional action inputs; aidraw_help provides concise workflows and aidraw://guide provides the optional complete guide.',
  'Reuse clientOperationId only for the same logical transaction; honor expected revisions and human locks.',
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

## Conditional action contracts

- **session_manage**: join accepts identity/presence metadata; inspect accepts optional documentId; leave accepts no other fields.
- **document_manage**: list; new plus kind/name/geometry; activate|save|close require documentId; open requires path; save-as requires documentId and path.
- **history_manage**: undo|redo|checkpoint-list accept optional documentId; replay requires transactionId; checkpoint-create requires name; checkpoint-restore|checkpoint-delete require checkpointId; checkpoint-merge requires checkpointId and 1–32 sourceIds.
- **job_manage**: list; inspect|approve-dependent|cancel require jobId; wait requires jobId and accepts timeoutMs 0–30000; start-batch requires documentId and totalTransactions; resume-batch requires jobId and resumeToken.

Strict branches reject fields from other actions. Tool descriptions and JSON Schema descriptions explain important parameter semantics and limits.

## Observation and mutation

canvas_observe returns canonical snapshots or revision changes and can optionally render a bounded targeted PNG, compare the latest transaction, inspect path nodes, or export a self-contained fragment. Resources expose document lists, manifests, snapshots, changes, and traces.

canvas_apply accepts 1–256 operations. clientOperationId is the idempotency key for one logical transaction. A duplicate key does not apply twice. Use entity/document revisions from observation; stale replacements conflict, non-overlapping additions may still commit, and human locks return retryable locked state. Playback may be instant or visible/animated. Durable batches add jobId, private resumeToken, and exact sequence.

Canonical operation families include document rename; asset/provenance; illustration artboard/layer/object/paint/guide/snap/animation; and pixel palette/frame/asset/cel/tilemap/link/stamp/font/cycle operations. Semantic helpers cover pixel fill/color/dither/text/selection/quantize/frame/stamp/link/map/collision/Wang/variant workflows and illustration alignment/path/material/gradient/text/crop/filter/mask/animation workflows. Call aidraw_help with topic=operations for compact examples; tools still validate every canonical field, limit, graph reference, and revision.

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

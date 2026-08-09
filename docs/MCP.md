# AIDraw MCP contract

The editor-independent server is stateful Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Send `Authorization: Bearer <token>` on every request and retain the negotiated `Mcp-Session-Id`. The health endpoint is unauthenticated at `/health` but reveals no document data; `uiRequired: false` confirms the canonical engine is available without a window.

`<AIDraw executable> --headless` starts the engine without a renderer. Closing the editor does not terminate sessions or documents. Animated transactions commit immediately while no editor is attached and retain their original operations for later trace replay. Launching AIDraw normally attaches the UI to the same process.

For unattended first-run provisioning, an explicitly authorized launcher may add `--write-mcp-connection=<absolute-json-path>`. Once the authenticated server starts, AIDraw writes its URL, token, active document ID, and process ID to that exact path without creating a renderer. The output is a password-bearing bootstrap artifact: keep it private to the current OS user, import it into the MCP client, and delete it afterward. Without this explicit flag, the operating-system-protected token is disclosed only through guided in-app setup.

## Discovery and cold start

The initialize result carries compact cross-tool instructions, but clients are not required to display them. Correct use therefore remains learnable from the reliable `tools/list` plus `tools/call` surface: call `aidraw_help` with `topic: "quickstart"`, join or inspect the session, list documents, observe canonical state, and only then apply a revision-aware transaction. `aidraw_help` is progressive (`quickstart`, `documents`, `canvas`, `jobs`, `history`, `files`, `operations`, or `safety`) and returns structured content plus safe examples and the optional guide URI.

The `session_manage`, `document_manage`, `history_manage`, and `job_manage` discovery schemas use strict action-specific branches. Their JSON Schema marks conditionally required fields—such as `path` for `open`, `documentId` plus `path` for `save-as`, `checkpointId` plus `sourceIds` for `checkpoint-merge`, and `jobId` for `wait`—and rejects fields belonging to another action. Important observation, idempotency, revision, file, generation, batch, and output fields carry protocol-visible descriptions.

Incomplete approval or running jobs return a safe `next` call for owner-scoped `job_manage`; waiting results explicitly state that only a human can approve in AIDraw. Retryable canvas conflicts, locks, busy queues, and cancellation point back to canonical observation. These hints never disclose raw job results, prompts, paths, approval internals, tokens, or other private data. Clients that support resources may read the complete progressive reference at `aidraw://guide`; clients that ignore instructions and resources retain the same correctness baseline through tools and results alone.

## Agent clients

The Activity panel has consent-driven profiles for Codex, Claude Code, OpenCode, and Antigravity plus a generic Streamable HTTP profile. Every automatic profile creates a timestamped backup and replaces only the `aidraw` entry while preserving unrelated servers/settings (including OpenCode JSONC comments). OpenCode receives its current stable shape directly at `mcp.aidraw`, with `type: "remote"`, `enabled: true`, `oauth: false`, the loopback URL, and the authorization header. AIDraw removes its own obsolete `mcp.servers.aidraw` wrapper when that wrapper has no unrelated entries; it refuses to guess how to migrate unrelated V2 entries. All profiles use the same loopback URL and `Authorization: Bearer <token>` header; they do not create a separate compatibility protocol. Client restart/reconnect instructions remain visible in a full result dialog.

The same launcher may repeat `--trust-folder=<absolute-folder-path>` to grant process-lifetime file authority to the headless MCP sessions it starts. AIDraw accepts this flag only when both `--headless` and `--write-mcp-connection` are present, reports the normalized grants in the connection JSON, and does not persist them. Trusted sessions can read addressed files and create new save/export files within those folders without attaching an editor. Existing destinations are always treated as overwrites and still create approval jobs. Generation requests never inherit folder trust.

## Resources

- `aidraw://guide` — optional complete progressive agent workflow and safety reference
- `aidraw://documents`
- `aidraw://documents/{id}/manifest`
- `aidraw://documents/{id}/snapshot`
- `aidraw://documents/{id}/changes/{revision}`
- `aidraw://documents/{id}/trace` — append-only NDJSON transactions with actor, operations, outcome, and resulting revision

Clients that negotiate subscriptions receive resource-updated notifications after revisions change.

## Tools

- `aidraw_help`: model-callable progressive workflow guidance available to tools-only clients; its structured output names related tools, invariants, safe examples, and the optional guide resource.
- `session_manage`: join/name/color, optionally declare client model/reasoning-effort/task metadata, inspect presence plus human occupancy/advisory editor state, or leave. Advisory state may include the attached editor's tool, selection, zoom, visible world viewport, and active pixel asset/frame/tag/onion-skin/playback direction. Client metadata is descriptive and is not platform-attested.
- `canvas_observe`: structured snapshot or diffs, optionally with a targeted base64 PNG. PNG requests may select current or named-checkpoint state, pixel asset/frame/layer or illustration layer, crop to a region, evaluate a schema-2 illustration at exact `illustrationTimeMs`, scale 1–16× with nearest-neighbor output, and choose document, transparent, or explicit solid background. `compareTransactionId` returns a race-free before/after pair for the most recent committed transaction; `checkpointId` observes a persistent editable branch point. Requests are rejected before utility-process rendering above the 4,194,304-pixel budget (split evenly for a pair) and after either PNG exceeds 4 MiB. Its `fragment` selector exports a self-contained editable illustration-object or pixel-asset graph without touching the OS clipboard.
- `canvas_apply`: up to 256 application-owned operations with an idempotent `clientOperationId`, expected revisions, and instant or visible playback. It also accepts `document.fragment.import`; the 2 MiB fragment is validated, IDs and dependency references are remapped, pixel colors are reconciled with the destination palette, and entity attribution is rewritten to the authenticated session.
- `history_manage`: undo/redo only the calling MCP actor, start a bounded non-mutating trace replay by transaction ID, or create/list/restore/delete attributed named checkpoints. `checkpoint-merge` selectively copies named top-level layer trees or pixel assets with dependency closure into the current document as one undoable transaction. Restoring preserves the branch being left as an automatic checkpoint; agents may delete only checkpoints they created.
- `document_manage`: list/new/activate/open/save/save-as/close. `list` returns `activeDocumentId`; `new` shares the strict human contract for kind, name, dimensions, illustration background, map orientation, finite/infinite mode, and tile geometry.
- `asset_import`: import one explicit path after applicable approval. It can open ordinary artwork, slice PNG/JPEG/WebP sheets with exact frame size/margins/spacing/order/count/duration plus optional shared trim and empty-cell skipping, import JSON/GPL palettes into a named pixel document, or set `projectLinkId` to relink an existing saved pixel-project source. Settings and the target link appear in the same human approval as the path. Metadata/Tiled companion references must be relative and remain within the approved root folder after realpath resolution; imports are byte- and expansion-bounded in the utility process.
- `document_export`: export one explicit path; filename extension is required. Its optional `scale` is an integer from 1 to 64 and applies nearest-neighbor presentation scaling to pixel PNG/JPEG/WebP/SVG/PDF/GIF/APNG/sprite-sheet exports. Pixel GIF, APNG, and sprite-sheet requests may provide `animationTagId` to follow that named tag's forward, reverse, or ping-pong sequence exactly; keyframed illustrations export their complete bounded timeline to GIF/APNG. Set `projectLinkId` without `format` to extract that cached source and convert it into a document-relative external link after approval. PSD and Tiled interchange remain native-scale structural exports.
- `generation_start`: create/edit/inpaint/outpaint/variation request. Agent calls always produce a two-minute in-app approval job.
- `job_manage`: owner-scoped list/inspect, wait up to 30 seconds, report a human-only approval dependency, or cancel. `start-batch` creates a 1–10,000 transaction durable job and returns its one-time opaque resume token; `resume-batch` securely rebinds it after a client or engine restart. Summaries omit raw results and private approval/prompt data.

Long work returns an explicit job ID. File approvals expire after two minutes. `allow-session`, `allow-always`, and explicit launch-time folder authority apply only to non-overwriting file requests. Generation cannot inherit trust. Canvas transactions themselves never require an open editor or approval; approval-dependent boundary work waits for UI attention.

For autonomous runs larger than one transaction, pass the batch `jobId`, `resumeToken`, and zero-based `sequence` on each ordinary `canvas_apply`. AIDraw accepts only the next sequence, treats a repeated sequence/client-operation pair as an idempotent duplicate, advances progress only after commit, and reconciles a crash between commit and progress persistence from the durable trace. Cancellation keeps transactions already committed (including the normal visible partial-stroke rule) and drops the remaining sequence.

## Conflict and load responses

Every mutable entity can carry `expectedRevision`. Non-overlapping additions may commit against a newer document revision, while stale replacements return `status: "conflict"` plus `conflict.entityId`, `expectedRevision`, `actualRevision`, and `retryable`. Retryable conflicts also return a `next` call to `canvas_observe`: re-observe canonical state, rebuild the same logical intent against the current revision, and use a fresh `clientOperationId` because the operation payload changed. Active human locks return `locked` with coarse occupancy and the same observe-first guidance. Full actor queues or the global playback budget return retryable `busy`. Reusing a committed client operation ID returns `duplicate` without applying it again.

Pixel and tile changes can use exact coordinate arrays or compact row runs:

```json
{ "kind": "pixel.cel.region", "spriteId": "sprite", "celId": "cel", "runs": [{ "x": 0, "y": 0, "length": 64, "index": 3 }], "expectedRevision": 4 }
```

`pixel.tilemap.region` uses the same shape with `gid`. One operation may address at most one million cells; overlapping runs are rejected. Runs drive sample-based playback, partial cancellation, lock conflicts, and exact per-actor undo without expanding the request. Tile GIDs retain Tiled horizontal, vertical, and diagonal flags.

## Semantic `canvas_apply` operations

In addition to the canonical reducer kinds, MCP accepts these validated semantic requests and expands them into one or more canonical revision-checked operations:

- `pixel.flood-fill`, `pixel.replace-color`, atomic `pixel.palette.replace-delete`, index- or luminance-ordered `pixel.adjust-index`, and phase-aware 2×2/4×4/8×8 `pixel.ordered-dither`;
- `pixel.bitmap-text.paint` for deterministic document-owned font assets with multiline spacing, integer scale, and alignment;
- `pixel.selection.transform` with compact selection runs for move, horizontal/vertical flip, clockwise/counterclockwise 90° rotation, or independent 1×–64× integer scaling while preserving exact indexed pixels;
- `pixel.image.quantize` for an embedded image asset using the document's area/OKLab/dither/alpha defaults;
- `pixel.project-link.embed` for one hash-checked external link and `pixel.project-links.pack` for every healthy external link, both guarded by the pixel-document revision;
- `illustration.objects.align` with artboard/selection/key-object targets;
- `illustration.objects.distribute` on x or y;
- `illustration.material.apply` with the `polished-gold` editable material recipe;
- `illustration.gradient.set` with 2–32 ordered color/opacity stops and exact local-space geometry;
- `illustration.text.content.set` and `illustration.text.style` for content changes that preserve ranges and exact character-range typography;
- `illustration.image.crop` for display-space rectangle crops, centered aspect crops, and exact non-destructive reset without resampling or stretching;
- `illustration.object.filters.replace` for ordered, non-destructive brightness/contrast/saturation/hue/blur on vector, path, shape, text, stroke, or image objects (`illustration.image.filters.replace` remains a compatible image-only alias);
- `illustration.layer.filters.replace` for the same ordered adjustments on an isolated paint/vector/group-layer composite;
- `illustration.object.mask.set` and `illustration.layer.mask.set` for reference-safe assignment or clearing of editable path/layer masks;
- `illustration.animation.settings.replace`, `illustration.animation.keyframe.upsert`, and `illustration.animation.keyframe.delete` for revision-checked transform/opacity/visibility poses with linear, hold, or ease-in-out interpolation;
- `illustration.path.boolean` for exact Paper.js union/subtract/intersect/exclude over transformed compatible shapes and paths;
- `pixel.frame.duplicate`, `pixel.frame.move`, `pixel.frame.cels.link`, `pixel.frame.duration.set`, animation-tag upsert/delete, and per-frame palette overrides;
- `pixel.stamp.place` and `pixel.tile-stamp.place` for reusable exact indexed/GID stamp placement and optional transforms;
- `pixel.map-object.upsert` and `pixel.map-object.delete` for typed rectangle/ellipse/polygon/polyline object-layer authoring in map-pixel coordinates;
- `pixel.tileset-collision.upsert` and `pixel.tileset-collision.delete` for typed per-tile collision geometry and custom properties;
- `pixel.wang-set.upsert|delete`, `pixel.wang-color.upsert|delete`, and `pixel.wang-tile.assign` for validated edge/corner/mixed terrain authoring;
- `pixel.tile-variants.paint` for coordinate-stable weighted non-Wang variants using an explicit seed or the map's persisted `aidraw:variantSeed` property;
- `illustration.path.node.move|insert|delete|convert` and `illustration.path.closed.set`; request `canvas_observe.pathObjectId` first for revision-labelled anchors and in/out handles.
- `illustration.path.arcs.convert` for exact SVG elliptical-arc conversion into editable cubic segments without dropping subpaths silently;
- `illustration.path.split` for an interior open-path cut or a lossless closed-path opening, and `illustration.path.join` for explicit or nearest-world-endpoint joining across object transforms;
- `document.fragment.import` for a fragment returned by `canvas_observe.fragment`, with optional illustration target layer and x/y offset.

Path booleans use the same exact shared Paper.js kernel in renderer and headless execution. Large multi-stage work should remain semantically partitioned so progress, cancellation, undo, and attribution are understandable.

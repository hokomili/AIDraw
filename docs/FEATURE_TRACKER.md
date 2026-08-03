# AIDraw feature tracker

Last audited: 2026-08-04

This is the source of truth for implementation status. The README and design documents describe the intended v1 product; an item is not complete merely because its data type, dependency, or menu entry exists.

## Status rules

| Status | Meaning |
| --- | --- |
| ✅ Verified | The workflow is implemented and covered by an automated acceptance, contract, or regression test. |
| 🟢 Working | The workflow is usable in the current editor, but its acceptance coverage is incomplete. |
| 🟡 Partial | A useful subset works, but a material part of the promised workflow or fidelity is absent. |
| 🟠 Scaffolded | The model or interchange path exists, but human authoring is too thin to call the feature usable. |
| ⬜ Missing | No meaningful implementation exists yet. |
| ⏸ Deferred | Explicitly outside the selected v1 scope. |

Priorities are `P0` release blocker, `P1` core v1 workflow, `P2` completeness/fidelity, and `P3` polish. A feature may move to **Verified** only when its exit criteria have an automated test.

## Current release truth

- AIDraw is a capable **pre-v1 prototype**, not a completed v1 release. Workspace metadata now honestly identifies `0.1.0-alpha.1`; stable `1.0.0` remains gated by this tracker and the release checklist.
- The strongest areas are the application-owned document/reducer model, native ZIP persistence, indexed sprite storage, headless authenticated MCP, attributed trace/replay, basic illustration drawing, basic pixel animation, and presentation-scaled pixel export.
- The largest product gaps are advanced illustration editing, natural-media/custom brushes, complete pixel selections and animation authoring, tileset/Wang/map authoring, SVG/PDF/PSD fidelity, generation-provider validation, performance isolation, accessibility, and release evidence.
- The fast verification baseline currently passes **21 Vitest files / 66 tests**. The packaged Playwright matrix passes **12 scenarios** separately and is not part of `npm run verify`.
- The repository currently has no committed baseline or published release. Generated package folders are local test artifacts, not release proof.

### Audit snapshot

| Measure | Count |
| --- | ---: |
| Tracked items | 142 |
| Verified | 26 |
| Working | 31 |
| Partial | 53 |
| Scaffolded | 10 |
| Missing | 22 |
| P0 / P1 / P2 | 55 / 73 / 14 |

Requirements added during hands-on testing are included explicitly: autonomous headless work and trace replay (FND-04, AGT-10), model/effort attribution (AGT-16), natural-media and custom brushes (ILL-07/08), polished material construction (ILL-19), illustration animation (ILL-21), presentation upscaling and CLI export (PIX-15), large-run save/export/close UX (UX-11), and independent three-level Luna/high MCP plus Computer Use QA (QA-09/10).

## 1. Foundation, process model, and storage

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| FND-01 | Node 24 npm workspace, Electron/React/TypeScript shell | 🟢 Working | P0 | Workspace and Forge/Vite build exist. Packaging/formal-QA runtime preflight now rejects non-24 Node and post-package verification rejects a missing executable after a misleading Forge exit. Verify clean-clone `npm ci`, package, and launch in CI. |
| FND-02 | Sandboxed renderer and narrow IPC boundary | 🟢 Working | P0 | Context isolation, sandboxing, sender checks, CSP, denied navigation/permissions, and fuses are implemented. Add automated negative security tests. |
| FND-03 | Application-owned schemas, migrations, reducer, inverses | ✅ Verified | P0 | Schema rejection, migration, atomic reducer inverses, stale revisions, layer grouping, and revision-checked cross-layer/object-order moves are tested. |
| FND-04 | Canonical editor-independent engine | ✅ Verified | P0 | Packaged E2E covers authenticated drawing and durable replay with no editor window. |
| FND-05 | Single-instance attach/show lifecycle | ✅ Verified | P0 | Packaged Playwright now covers headless ownership → show/attach → close the editor while health/MCP remain live → show/reattach → explicit engine quit. Keep the isolated QA-harness scenario as a release regression. |
| FND-06 | Native `.aidraw` ZIP, assets, preview, atomic save | ✅ Verified | P0 | Temporary ZIP validation and round-trip are tested. Add corrupted/oversized archive fixtures and interrupted-write tests. |
| FND-07 | Recovery journal, compaction, discard semantics | ✅ Verified | P0 | Snapshot replay, malformed trailing transaction protection, and explicit-discard cleanup are tested. Keep the prior resurrected-document bug as a packaged regression. |
| FND-08 | Durable attributed transaction trace | ✅ Verified | P0 | Trace survives compaction and drives non-mutating replay. |
| FND-09 | Utility-process isolation for conversion/render/generation | ⬜ Missing | P0 | Heavy import/export, raster composition, quantization, and provider work currently run in the Electron main process. Move them behind supervised utility processes with cancellation and crash handling. |
| FND-10 | Planned rendering adapters | 🟡 Partial | P1 | Paper.js and `perfect-freehand` are used. Fabric.js, PixiJS, and `@pixi/tilemap` are installed but the interactive renderers are custom Canvas2D. Either implement the planned adapters or document/remove the unused dependencies and prove equivalent scale/performance. |
| FND-11 | Versioned format migrations beyond schema 1 | 🟠 Scaffolded | P1 | Migration plumbing exists, but there is only one real schema. Add a fixture-based migration policy before format changes ship. |
| FND-12 | Performance instrumentation and budgets | ⬜ Missing | P0 | No automated 60 fps/input-latency, 5,000-object, four-4K-layer, large-map, memory, or long-agent-queue gate exists. |

Evidence: [core model](../packages/core/src/model.ts), [operations](../packages/core/src/operations.ts), [document service](../src/main/document-service.ts), [engine runtime](../src/main/engine-runtime.ts), [persistence](../src/main/persistence.ts), [journal tests](../tests/main/journal.test.ts), [packaged E2E](../tests/e2e/editor.spec.ts).

## 2. Agent-native MCP and collaboration

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| AGT-01 | Authenticated stateful localhost MCP | ✅ Verified | P0 | Bearer auth, stateful sessions, health endpoint, persistent port range, and 32 concurrent clients are contract-tested. |
| AGT-02 | Public resources and subscriptions | 🟡 Partial | P1 | Documents and trace resources are contract-read; manifest/snapshot/changes plus negotiated update notifications are implemented but not contract-tested end to end. |
| AGT-03 | Public tool surface | ✅ Verified | P0 | All nine named tools are registered and schema-discoverable. This verifies presence, not complete semantics of every action. |
| AGT-04 | Headless bootstrap and launch-time folder trust | ✅ Verified | P0 | Explicit connection handoff and process-lifetime trusted folders are exercised in packaged E2E. |
| AGT-05 | Presence, named cursors, activity, background-tab badges | 🟢 Working | P1 | Presence and actor cursors render; activity and tab indicators exist. Add two-document background-edit and cursor-position E2E coverage. |
| AGT-06 | Fair four-lane playback and backpressure | 🟢 Working | P0 | Scheduler integration tests prove all four lane IDs, next-lane cross-actor fairness, queue cleanup, and the one-million-sample busy gate. Add one packaged four-agent visual-lane scenario before graduating to Verified. |
| AGT-07 | Human locks and optimistic human priority | 🟢 Working | P0 | Automated service tests cover same-object replace/delete, overlapping pixel regions, unrelated work, and human bypass priority; packaged human drawing during agent playback also passes. Add a packaged pointer-down-held conflict for object and region locks before graduating to Verified. |
| AGT-08 | Partial cancellation and per-actor undo | ✅ Verified | P0 | Unit integration retains a visible pixel prefix as one undoable/redoable actor transaction, and packaged Playwright covers Stop All Agents plus Activity-panel agent undo/redo without removing the human stroke. |
| AGT-09 | Idempotency and revision conflicts | ✅ Verified | P0 | Duplicate operation IDs and stale entity revisions are covered. Add conflict payload/retry-guidance contract assertions. |
| AGT-10 | Durable autonomous trace inspection and human-triggered replay | ✅ Verified | P0 | Agents can inspect complete traces, and headless transactions remain replayable from Activity after an editor attaches. Agent-triggered replay is separately tracked as PAR-05. |
| AGT-11 | Rich semantic canvas operation families | 🟡 Partial | P1 | Agents receive generic layer/object/frame/cel/pixel/tile primitives. Human tools compute path booleans, align/distribute, fill/replace/dither/lighten/darken, pixel-perfect cleanup, stamps, bitmap text, gradient placement, node/crop geometry, material recipes, and asset graph cascades before emitting those primitives. Expose supported computations as validated semantic operations instead of requiring agents to recreate geometry or pixels. |
| AGT-12 | Approval jobs and folder authority | ✅ Verified | P0 | Structured review shows actor, exact path/provider/prompt, scale/count, paid-request exposure, overwrite targets, and expiry. Packaged UI exposes Deny/once/session/persistent choices; contract tests prove session trust, persistent trust across host restart, and overwrite re-approval. |
| AGT-13 | Job inspect/wait/cancel/approval dependency | 🟡 Partial | P1 | Inspect, bounded wait, and cancellation work. `approve-dependent` is effectively an inspection alias; define and test its exact contract or remove it. |
| AGT-14 | Guided Codex connection and restart notice | 🟢 Working | P0 | Config backup/table replacement, consent dialog, start-at-login, and a result dialog exist. Add a real restart/reconnect acceptance and prominent persistent status until the client reconnects. |
| AGT-15 | Generic MCP-client onboarding | 🟢 Working | P2 | URL/header settings can be revealed and copied. Add client-neutral setup docs and a token-rotation/revocation workflow. |
| AGT-16 | Agent model/effort/task provenance | ⬜ Missing | P2 | `Actor` stores only ID, kind, name, and color, so model/effort/task identity is encoded ad hoc in labels and can become `undefined`. Add optional validated client metadata and distinguish AIDraw transaction completion from external Codex task completion. |

Evidence: [MCP host](../src/main/mcp-host.ts), [scheduler](../src/main/playback-scheduler.ts), [MCP contract tests](../tests/mcp/contract.test.ts), [trace tests](../tests/main/trace-store.test.ts), [replay tests](../tests/renderer/replay.test.ts), [human/agent parity audit](PARITY_AUDIT.md).

### 2A. Human/agent parity and autonomous iteration

The shared reducer gives agents access to every low-level operation kind, but low-level write access is not the same as practical parity. These items reconcile the dedicated [human/agent parity audit](PARITY_AUDIT.md) into the release backlog.

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| PAR-01 | New-document option parity | 🟡 Partial | P1 | MCP creation accepts kind/name/width/height, while the human dialog also controls illustration background and tilemap orientation, finite/infinite mode, and tile geometry. Extend one shared validated creation contract and test identical resulting documents from both surfaces. |
| PAR-02 | Safe document-fragment exchange for agents | ⬜ Missing | P2 | Humans can copy/paste editable AIDraw fragments plus SVG/PNG, but agents cannot. Do not expose the ambient OS clipboard silently; provide document-scoped fragment import/export or an explicitly approved clipboard bridge with format and size limits. |
| PAR-03 | Agent-callable image-to-indexed quantization | ⬜ Missing | P1 | OKLab palette conversion is available only inside main-process clipboard/generation flows. Expose a provider-neutral semantic operation/job that converts an existing document asset into a target sprite/cel with the document's resample, alpha, and dithering settings. |
| PAR-04 | Human-presence and lock awareness | 🟡 Partial | P1 | Agents learn about contention only after a `locked` failure; human cursors and active locks are absent from MCP presence. Expose coarse, privacy-safe occupancy/lock state and retry hints. Preserve human priority rather than giving agents human-priority locks. |
| PAR-05 | Agent-callable trace replay | ⬜ Missing | P2 | Agents can read trace resources, but only renderer IPC can start non-mutating replay. Add an actor-authorized replay action/job with document/transaction targeting, busy state, and no document mutation. |
| PAR-06 | Multi-granularity visual observation | 🟡 Partial | P1 | `canvas_observe` can return one flattened PNG of the active pixel asset's first frame. Add asset/frame/layer/region targeting, integer scale, alpha/background options, output-size limits, and before/after pairs. |
| PAR-07 | Explicit workspace and job observation | 🟡 Partial | P1 | Document listing omits `activeDocumentId`, and jobs can only be inspected by a known ID. Return explicit active-document state and owner-scoped job enumeration/status without leaking human prompt, credential, or approval payloads. |
| PAR-08 | Advisory attached-editor state | ⬜ Missing | P2 | Selection, active tool, zoom, onion skin, playback, and viewport are renderer-only. Define which state materially helps collaboration, expose it only while an editor is attached, mark it advisory, and keep private UI details out of headless contracts. |
| PAR-09 | Bulk region operations and long-run throughput | 🟡 Partial | P1 | Exact pixel/tile writes work but large edits are constrained by 256 operations, 2 MiB requests, four queued transactions, and playback sample budgets. Add chunk/RLE region writes, semantic fills, progress, resumable batching, and cancellation without weakening global backpressure. |
| PAR-10 | Non-destructive branches, variants, and comparison | ⬜ Missing | P2 | Agents must currently duplicate or reverse operations manually to experiment. Add cheap document/layer variants, named checkpoints, side-by-side or overlay comparison, accept/reject, and provenance-preserving merge semantics. |
| SEC-01 | Server-authoritative entity attribution | ✅ Verified | P0 | Commit policy recursively normalizes new/replaced entity creator, timestamps, and revisions from the authenticated actor, renderer IPC cannot impersonate agents, and undo/redo restores exact normalized metadata. Service and MCP regressions cover the boundary. |
| SEC-02 | Asset deletion referential integrity | ✅ Verified | P0 | The reducer reports image, paint-tile, linked-preview, and provenance references; deletion is rejected until references are removed. An explicit ordered object/asset cascade and its exact inverse are tested. |
| SEC-03 | Trusted provenance creation | ✅ Verified | P0 | Generic human/agent canvas transactions cannot add or remove verified provenance. Generation acceptance uses the engine-only path, timestamps are server-issued, referenced assets must exist, and MCP forgery is contract-tested. |
| SEC-04 | Strict conversion-settings validation | ✅ Verified | P0 | Nested conversion settings are strict: area/OKLab, three supported dither modes, finite 0–1 alpha, and no unknown keys. Malformed enums, NaN, ranges, and extra fields are rejected by schema tests. |
| SEC-05 | Inline asset ingestion policy | ✅ Verified | P0 | Inline assets require canonical base64 safe-raster data with declared length/SHA/MIME agreement, header and codec decode, 1.5 MB, 8192 px, and 16 MP limits; dangerous formats and forged generated origin are rejected/normalized. The trust boundary is documented and tested. |

## 3. Illustration editor

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| ILL-01 | Bounded custom artboard, background, sRGB defaults | 🟢 Working | P1 | Dedicated New Document UI supports dimensions and solid/transparent background. Add artboard resize-after-creation and preset persistence if those remain v1 requirements. |
| ILL-02 | Selection and lasso | 🟡 Partial | P1 | Click/multi-select and rectangular lasso work through approximate bounds. Add freeform lasso, actual-path hit testing, marquee containment/intersection options, and selection cycling. |
| ILL-03 | Transform workflow | 🟡 Partial | P1 | Drag translation plus numeric position/rotation exist. Bounding-box handles for scale, rotate, skew, pivots, constrained transforms, and transform reset are missing. |
| ILL-04 | Snapping and guides | 🟡 Partial | P1 | Automatic edge/center snapping and temporary guide lines work. Persistent draggable guides, ruler-origin control, snap settings, and pixel/grid snapping are missing. |
| ILL-05 | Pressure pen and vector pencil | 🟢 Working | P1 | Pressure samples and `perfect-freehand` outlines render. Add real stylus-device acceptance for pressure, tilt policy, latency, and long strokes. |
| ILL-06 | Six essential raster brushes and eraser | 🟡 Partial | P1 | Hard round, soft round, pencil, marker, airbrush, and eraser presets exist. Stroke compositing is basic; spacing, stabilization, texture, wet mixing, and preset editing are absent. |
| ILL-07 | Watercolor/natural-media painting | ⬜ Missing | P1 | No pigment/wetness/granulation/paper interaction exists. Define a bounded watercolor MVP and golden-image tests. |
| ILL-08 | Custom brush engine and preset management | ⬜ Missing | P1 | Users cannot create, import, save, organize, or tune brush tips/dynamics. |
| ILL-09 | Bézier construction and node editing | 🟡 Partial | P1 | Click-to-create paths and direct numeric-point dragging exist. Semantic anchors/handles, corner/smooth conversion, add/delete/split/join nodes, open/close path, and accurate control-point selection are missing. |
| ILL-10 | Lines, arrows, rectangles, ellipses, polygons, stars | 🟢 Working | P1 | Core creation tools and editable model objects exist. Add geometric hit-testing and transform-handle coverage. |
| ILL-11 | Fill/stroke styles, gradients, eyedropper | 🟡 Partial | P1 | Solid/linear/radial model styles and interactive gradient placement exist. A complete multi-stop editor, stop opacity/order, gradient transforms, reusable swatches, and robust sampling are missing. |
| ILL-12 | Images and crop | 🟢 Working | P1 | Image objects, crop state, clipboard images, and basic filters work. Add visual crop handles, aspect presets, replace/relink, and missing-asset UX. |
| ILL-13 | Styled text ranges and typography | 🟡 Partial | P1 | Range-aware model/rendering exists, but the inspector rewrites all ranges together. In-canvas editing, actual range selection, multiline layout/wrapping, weight/style/underline/alignment controls, font fallback/embedding, and text-on-path are incomplete or missing. |
| ILL-14 | Layer groups, object groups, masks, clipping masks | 🟡 Partial | P1 | Layer grouping, layer masks, and object masks render. Object-group authoring/ungrouping, arbitrary mask editing, clipping-stack UX, and clear mask visibility/ownership controls are incomplete. |
| ILL-15 | Alignment and distribution | 🟡 Partial | P1 | Commands exist, but alignment is artboard-based and distribution is basic. Add selection/key-object targets, spacing distribution, and rotated-bound accuracy. |
| ILL-16 | Union/subtract/intersect/exclude | 🟢 Working | P1 | Paper.js-backed booleans exist for supported shapes/paths. Add compound paths, holes, transformed inputs, failure recovery, and golden geometry tests. |
| ILL-17 | Blend modes, opacity, shadows, non-destructive filters | 🟡 Partial | P1 | Common blends, opacity, object blur/shadow, and image brightness/contrast/saturation/hue/blur exist. A reorderable filter stack for arbitrary groups/layers, filter masks, and export parity are missing. |
| ILL-18 | Sparse tiled paint-layer storage | 🟡 Partial | P0 | Strokes are editable in-session and materialized to sparse PNG tiles on save. Prove large-canvas memory bounds, tile invalidation, eraser fidelity, reopening/editing, and incremental composite performance. |
| ILL-19 | Editable material presets and polished gold | 🟢 Working | P2 | The polished-gold preset builds editable gradient/blur/mask layers and exports to SVG. General preset management and more materials are not implemented. |
| ILL-20 | Multiple artboards | ⬜ Missing | P2 | The model supports one artboard per illustration document. If multiple artboards are not intended for v1, state that explicitly in the product scope. |
| ILL-21 | Illustration animation timeline | ⬜ Missing | P2 | Later user testing requested animated vector/illustration results, but no vector keyframe or frame timeline exists. Decide whether this is v1 or a post-v1 extension. |
| ILL-22 | Object list / scene outliner | 🟢 Working | P1 | The Layers panel now has a searchable hierarchical per-layer object tree with type icons, canvas-synchronized range/additive selection, inline rename, visibility/lock controls, revision-checked drag/button ordering, layer/group moves, group creation, duplicate/delete, and reveal-on-canvas centering. It derives directly from canonical snapshots, so agent additions appear live without clearing human selection. Packaged E2E covers live agent insertion, selection preservation, rename, order, grouping, and filtering; add explicit drag/drop, visibility/lock, duplicate/delete, deep-cycle, and reveal-position acceptance before marking Verified. |

Evidence: [illustration canvas](../src/renderer/canvas/IllustrationCanvas.tsx), [geometry](../src/renderer/canvas/geometry.ts), [path booleans](../src/renderer/canvas/path-boolean.ts), [object inspector](../src/renderer/App.tsx), [material tests](../tests/common/material-presets.test.ts).

## 4. Pixel sprites and animation

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| PIX-01 | Pixel Sprite/Tilemap/Project creation and custom sizing | ✅ Verified | P0 | Dedicated creation UI, exact sprite dimensions, resize/crop, undo, and isometric/infinite map options have regressions. |
| PIX-02 | Indexed palette up to 256 entries | 🟢 Working | P1 | Indexed storage, transparent index 0 default, color editing, adding, deleting, and reordering exist. Add import/overflow/transparent-index invariants and palette-swap UX tests. |
| PIX-03 | Integer coordinates and nearest-neighbor rendering | ✅ Verified | P0 | Low-zoom pointer mapping and CSS-stretched canvas coordinates have regressions. Add high-DPI/multi-monitor/stylus tests. |
| PIX-04 | Pixel-perfect pencil, eraser, fill, replace, line, shape tools | 🟢 Working | P1 | Core tools commit exact indexed samples. Add pixel-perfect corner cleanup, fill limits, ellipse goldens, drag cancellation, and large-region performance tests. |
| PIX-05 | Selection and magic wand workflow | 🟡 Partial | P1 | Rectangular lasso/wand visualization exists. Move/copy/cut/paste, floating selection, add/subtract/intersect, rotate/flip, scale, and commit/cancel are missing. |
| PIX-06 | Stamps | 🟠 Scaffolded | P1 | A fixed built-in stamp pattern exists. User-defined reusable stamps, capture from selection, libraries, transforms, and map stamps are missing. |
| PIX-07 | Ordered dithering and lighten/darken | 🟡 Partial | P2 | Basic Bayer-pattern drawing and adjacent-index lighten/darken exist. Configurable matrices, palette-luminance behavior, preview, and controlled dithering regions are missing. |
| PIX-08 | Symmetry, wrap preview, palette cycling | 🟡 Partial | P2 | Basic horizontal/vertical symmetry, repeated preview, and rotate-all-palette preview exist. Authored axes, tile-offset wrap editing, named cycle ranges/speeds, and export behavior are missing. |
| PIX-09 | Bitmap-font text | 🟠 Scaffolded | P2 | A tiny built-in font can be inserted through a prompt. Font import, glyph mapping, spacing/alignment, preview, and reusable bitmap-font assets are missing. |
| PIX-10 | Layered cels, linked cels, durations, onion skin | 🟢 Working | P1 | Layers/cels, linked frame creation, duration editing, onion skin, and playback exist. Add cel exposure/grid editing, link/unlink controls, onion settings, frame duplicate/delete/reorder, and packaged replay regressions. |
| PIX-11 | Animation tags and loop/ping-pong preview | 🟡 Partial | P1 | Tags can be added over the full range and ping-pong preview works. Range/direction/color editing, tag selection, reverse playback, nested/overlap policy, and export-by-tag are missing. |
| PIX-12 | Per-frame palette overrides | 🟠 Scaffolded | P1 | The model and renderer honor overrides, but there is no complete authoring UI or export/import acceptance. |
| PIX-13 | Integer selection transforms and 90-degree rotation | ⬜ Missing | P1 | Tile transformation flags exist elsewhere, but sprite selection rotation/flip is not implemented. |
| PIX-14 | GIF/APNG/sprite-sheet import and animation export | 🟡 Partial | P1 | Import/export code exists and GIF/APNG/sprite-sheet export is tested. Add animated import fixtures, timing/disposal/transparency tests, tag-range export, and large animation limits. |
| PIX-15 | Presentation upscale in UI and headless CLI | ✅ Verified | P1 | Integer 1×–64× nearest-neighbor export and overwrite-safe batch CLI are tested. Add batch APNG/sprite-sheet/Tiled coverage and a documented exit-code contract. |
| PIX-16 | Standalone/project links, embed/extract, Pack Project | 🟡 Partial | P2 | Relative links, hashes, cached source, project asset creation, and Pack Project exist. Embed/extract/relink/stale-hash/conflict workflows and round-trip tests are incomplete. |

Evidence: [pixel canvas](../src/renderer/canvas/PixelCanvas.tsx), [pixel storage](../packages/core/src/pixel.ts), [pixel tests](../tests/core/pixel.test.ts), [coordinate tests](../tests/renderer/pixel-coordinates.test.ts), [CLI tests](../tests/main/cli.test.ts), [export tests](../tests/main/export-document.test.ts).

## 5. Tilesets, Wang terrain, and tilemaps

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| MAP-01 | Tileset/map/Wang/collision data model | ✅ Verified | P1 | Sparse chunks and deterministic Wang matching are unit-tested; the complete model is schema-validated. |
| MAP-02 | Tileset slicing | 🟡 Partial | P1 | Tile width/height, rows, and columns can be edited against a sprite. Margin, spacing, preview selection, re-slice policy, and source-sheet workflow are incomplete. |
| MAP-03 | Per-tile properties, probability, and animation editor | 🟠 Scaffolded | P1 | Fields import/export and render from the model, but there is no complete per-tile authoring UI. |
| MAP-04 | Collision-shape editor | 🟠 Scaffolded | P1 | Collision data imports/exports and one fixed rectangle can be added to tile 1. Interactive rectangle/ellipse/polygon/polyline editing and per-object properties are missing. |
| MAP-05 | Edge/corner/mixed Wang set editor | 🟠 Scaffolded | P1 | One simple all-sides terrain can be generated and the selection algorithm supports eight slots. Full color/set/tile assignment UI and validation are missing. |
| MAP-06 | Terrain painting | 🟡 Partial | P1 | The brush selects from the first Wang set/color. Neighbor-aware constraints, multiple terrains, edge/corner transitions, erase/replace, deterministic variants, and live diagnostics are incomplete. |
| MAP-07 | Finite/infinite orthogonal maps | 🟢 Working | P1 | Exact tile painting and 32×32 sparse chunks work. Add navigation, bounds resize, selection/stamps, large-map performance, and round-trip E2E. |
| MAP-08 | Finite/infinite isometric maps | 🟡 Partial | P1 | Creation and Canvas2D rendering exist, but hit-testing, painting accuracy, ordering, transforms, object placement, and visual goldens need coverage. |
| MAP-09 | Tile/group/object layers, parallax, opacity | 🟡 Partial | P1 | Layer types and properties exist; tile/group basics render. Interactive object placement/editing and parallax preview are missing. |
| MAP-10 | Random variants and probabilities while painting | ⬜ Missing | P1 | Probabilities round-trip but the authoring brush does not choose weighted variants. |
| MAP-11 | Reusable tile/map stamps | ⬜ Missing | P1 | No reusable multi-tile stamp library or selection-to-stamp workflow exists. |
| MAP-12 | Tile transformations | 🟡 Partial | P2 | H/V/diagonal flags render and round-trip, and tileset permissions are editable. Painting/selection controls for applying transforms are missing. |
| MAP-13 | Tiled TMJ/TMX/TSJ/TSX fidelity | 🟡 Partial | P1 | JSON/XML, chunks, layers, tiles, transforms, Wang data, collisions, animation, and properties are implemented. Representative external fixtures and loss reports are not comprehensive. |

Evidence: [Wang implementation](../packages/core/src/wang.ts), [Tiled importer](../src/main/import-document.ts), [Tiled exporter](../src/main/export-document.ts), [Wang tests](../tests/core/wang.test.ts), [export tests](../tests/main/export-document.test.ts).

## 6. Import, export, clipboard, and file authority

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| IO-01 | PNG/JPEG/WebP import/export | 🟢 Working | P1 | Raster import/export paths exist. Add color/alpha/orientation/large-image fixtures and round-trip visual comparisons. |
| IO-02 | SVG editable import | 🟡 Partial | P1 | Basic rect/ellipse/circle/line/path/text elements import. Groups, defs/use, nested transforms, stylesheets, masks/clips, gradients, filters, and images are warned or unsupported. |
| IO-03 | SVG editable export | 🟡 Partial | P1 | Basic vectors, gradients, object blur, masks, and paint fallbacks export. Styled text fidelity, arrows, group semantics, image effects/crops, blend portability, and round-trip tests are incomplete. |
| IO-04 | PSD import/export | 🟡 Partial | P1 | PSD layers can be read and written as raster fallbacks. Editable group/text/vector preservation and detailed unsupported-effect/color-mode reports do not meet the planned fidelity. |
| IO-05 | PDF import/export | 🟡 Partial | P1 | Pages import as raster plus hidden extracted text; export is a raster composite. Translation of common operators and hybrid vector/text export are missing. |
| IO-06 | Clipboard AIDraw JSON + SVG + PNG | 🟢 Working | P1 | Editable AIDraw fragments and bitmap fallback are implemented. Add cross-application and multi-object/mask tests; publish the private MIME/HTML contract. |
| IO-07 | Pixel animated and sprite-sheet interchange | 🟡 Partial | P1 | GIF/APNG and metadata-driven sheets are supported in code. Complete timing, disposal, trimming, slicing UI, and representative round-trip coverage are missing. |
| IO-08 | Tiled interchange | 🟡 Partial | P1 | See MAP-13; source-image companion handling and external-link edge cases need fixture coverage. |
| IO-09 | Explicit import/export report | 🟡 Partial | P1 | Adapters return warnings and the UI shows transient notifications. Add a durable, inspectable report with per-layer/object fallbacks and saved/exportable details. |
| IO-10 | Exact-path authority and overwrite approval | 🟢 Working | P0 | Structured approval, session/persistent choices, symlink/junction canonicalization, case-normalized trust, race-aware exclusive writes, and planned companion overwrite paths are tested; trusted folders never auto-approve existing targets. Add a packaged sprite-sheet/Tiled companion overwrite scenario and reparse-point corpus before Verified. |

Evidence: [import adapters](../src/main/import-document.ts), [export adapters](../src/main/export-document.ts), [clipboard IPC](../src/main/main.ts), [export tests](../tests/main/export-document.test.ts), [persistence tests](../tests/main/persistence.test.ts).

## 7. Image generation

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| GEN-01 | Provider-neutral request/job/provenance model | 🟢 Working | P1 | Provider, mode, prompt, negative prompt, sources, mask, size/aspect, count, seed, options, outputs, and provenance exist. Add schema/capability matrix tests. |
| GEN-02 | OpenAI `gpt-image-2` adapter | 🟡 Partial | P1 | Create/edit requests are implemented. Test create/edit/inpaint/outpaint/variation mappings, unsupported options, moderation, rate limits, timeouts, cancellation, and ambiguous paid failures with a mock server. |
| GEN-03 | Stability adapter | 🟡 Partial | P1 | Create/inpaint/outpaint endpoints exist and unsupported modes fail explicitly. Add official-version compatibility checks and the full mocked failure matrix. |
| GEN-04 | ComfyUI workflow adapter | 🟡 Partial | P1 | API-format workflow loading, node mapping, upload, `/prompt`, WebSocket progress, history, and retrieval exist. Add workflow validation/mapping UI, reconnect, malformed output, queue/cancel, and mock-server tests. |
| GEN-05 | DPAPI credential storage | 🟢 Working | P0 | Hosted keys use the protected credential store. Add rotation/removal, unavailable-DPAPI behavior, and renderer-leak tests. |
| GEN-06 | Agent paid-request approval | 🟡 Partial | P0 | Agent jobs wait for approval and the payload is attached. Replace collapsed raw JSON with a structured review showing actor, provider, prompt, source/mask previews, count/cost exposure, and explicit trust scope. |
| GEN-07 | Create/edit/inpaint/outpaint/variation workflows | 🟡 Partial | P1 | Modes and source/mask selection exist. Canvas selection-to-mask, true artboard expansion for outpaint, mode-specific capability guidance, and non-destructive setup are incomplete. |
| GEN-08 | Result compare, before/after overlay, accept/cancel | 🟡 Partial | P1 | Result cards, progress, cancellation, and accept-to-layer/cel exist. A synchronized before/after overlay, zoom/pan comparison, reject cleanup, and multi-result provenance tests are missing. |
| GEN-09 | Pixel palette conversion and reproducibility | 🟢 Working | P1 | Area resize, OKLab nearest palette, alpha threshold, optional Bayer/Floyd–Steinberg, source retention, and conversion metadata exist. Add golden quantization/dither tests and per-frame acceptance. |
| GEN-10 | No silent provider substitution or ambiguous paid retry | 🟢 Working | P0 | Adapters fail explicitly and do not auto-retry POSTs. Lock this with mock-server assertions. |

Evidence: [generation types](../src/common/generation.ts), [generation manager](../src/main/generation-manager.ts), [quantization](../src/main/quantize.ts), [generation panel](../src/renderer/App.tsx).

## 8. Desktop UX and accessibility

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| UX-01 | Playful light editor shell and context panels | 🟢 Working | P1 | Top tabs, left tools, central canvas, right panels, and bottom status are implemented. Run a coherent spacing/type/contrast pass at supported window sizes. |
| UX-02 | Dedicated New Document configuration | ✅ Verified | P0 | Toolbar, File > New, Ctrl+N, and Ctrl+Shift+N route into the same configuration dialog instead of mutating the document list. A packaged Playwright regression verifies Ctrl+N exposes the 1920×1080 configuration and Cancel creates no document. |
| UX-03 | Reachable overflowing document tabs | ✅ Verified | P0 | Scroll controls and an all-documents menu are covered by packaged E2E. |
| UX-04 | File menu Open and keyboard Open | 🟡 Partial | P0 | Both code paths now call the same open workflow after a prior menu failure. Add a packaged native-menu regression; current E2E does not prove mouse menu activation. |
| UX-05 | Renderer failure containment | 🟢 Working | P0 | Malformed transactions are schema-rejected and an editor-only recovery boundary prevents a permanent white screen. Add a packaged boundary/reload test, telemetry-free diagnostic export, and malformed-event fuzzing. |
| UX-06 | Session restore and close/discard clarity | ✅ Verified | P0 | Explicitly discarded untitled documents no longer restore in unit/E2E coverage. Add saved-close, Save All, Close All, crash, and multi-document recovery scenarios. |
| UX-07 | Replace browser prompts with editor UI | ⬜ Missing | P1 | Text insertion, bitmap text, frame duration, and animation tags still use `window.prompt`, with no validation-rich preview or keyboard-safe workflow. |
| UX-08 | Keyboard-only operation and shortcut discoverability | 🟡 Partial | P1 | Core shortcuts and some ARIA labels exist. Complete focus order, tool settings, canvas alternatives, menus, modal focus traps, and shortcut remapping/documentation. |
| UX-09 | Accessibility audit | ⬜ Missing | P0 | No screen-reader, high-contrast, reduced-motion, color-blind actor-label, 200% text, or automated accessibility gate exists. |
| UX-10 | High-DPI, tablet, multi-monitor, and touchpad QA | ⬜ Missing | P0 | The coordinate fix has unit coverage, but no hardware/input matrix exists. |
| UX-11 | Batch save/export/close workflows | 🟡 Partial | P1 | Headless single-document batch export exists, but the editor lacks a polished Save All / Batch Export / Close All result workflow for large agent runs. |

Evidence: [editor shell](../src/renderer/App.tsx), [styles](../src/renderer/styles.css), [error boundary](../src/renderer/RendererErrorBoundary.tsx), [packaged E2E](../tests/e2e/editor.spec.ts).

## 9. Testing, hardening, documentation, and release

| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| QA-01 | Unit coverage for core schema/reducer/storage | 🟢 Working | P0 | Important happy paths and several regressions are covered. Add property/fuzz tests, all operation inverses, palette overflow, linked assets, cels/tags, locks, and migration fixtures. |
| QA-02 | Golden-image rendering suite | 🟠 Scaffolded | P0 | Native render and SVG assertions exist, but there is no maintained visual-golden corpus for illustration compositing, masks/blends, brushes, pixel frames, or maps. |
| QA-03 | Interchange round-trip corpus | 🟠 Scaffolded | P0 | A few generated export assertions exist. Add representative external SVG/PDF/PSD/GIF/APNG/sprite-sheet/Tiled fixtures and explicit loss expectations. |
| QA-04 | MCP contract and concurrency suite | 🟢 Working | P0 | Auth, discovery, 32 sessions, resources, and duplicate operations are covered. Add subscriptions, every tool action, limits, fairness, locks, cancellation, approvals, and failure payloads. |
| QA-05 | Generation provider mock suite | ⬜ Missing | P0 | No dedicated provider tests cover success, moderation, rate limit, timeout, ambiguous failure, cancellation, or unsupported capabilities. |
| QA-06 | Complete packaged editor E2E matrix | 🟡 Partial | P0 | Core regressions and human+agent/headless scenarios exist. The original acceptance scenarios for conflicts, background tabs, approval, generated fill, animated sprites, Wang terrain, infinite maps, Tiled round-trip, and palette conversion are incomplete. |
| QA-07 | Automated performance gate | ⬜ Missing | P0 | Add repeatable Windows 11 x64 budgets for input latency, frame pacing, load size, memory, save/export duration, and agent queue isolation. |
| QA-08 | Corrupted/untrusted-input hardening | 🟡 Partial | P0 | Schema and recovery rejection exist. Add ZIP bombs, decompression limits, malformed image/PSD/PDF/XML, cyclic groups/links, huge dimensions, path tricks, and fuzz cases. |
| QA-09 | Three-level independent Luna/high QA workflow | 🟡 Partial | P0 | Level 1 smoke, Level 2 regression, and Level 3 release-exhaustive requirements, report template, and independent-task rules are documented; every level mandates automated, isolated MCP, native Computer Use, and bidirectional cross-surface evidence. The coordinated isolated Level 1 workflow completed end to end and accurately failed only on UX-02 after its automated, MCP, pointer, undo/redo, and cross-surface cases passed. Exercise Levels 2 and 3 before graduating this workflow. |
| QA-10 | Exact-build isolated MCP/UI identity harness | 🟢 Working | P0 | Node-24 discovery, runtime enforcement, package artifact verification, isolated interactive/headless session launch/status/stop, coordinator checkpoints, persisted MCP client state, hash/PID/URL checks, post-stop credential redaction, and an explicit unsandboxed-Windows-launch guard are implemented. The harness passed manual MCP and Computer Use self-tests outside the filesystem sandbox. Add automated harness tests, make headless attach reliable, and include it in CI. |
| REL-01 | Clean Git history and reviewable baseline | ⬜ Missing | P0 | All project files are currently untracked. Establish the repository baseline without committing generated output, caches, credentials, or user artwork unless explicitly intended. |
| REL-02 | Honest versioning and changelog | ✅ Verified | P0 | Root/core/lock metadata use `0.1.0-alpha.1`; a dated changelog and explicit prerelease/stable release checklist exist. An automated metadata test prevents a premature stable version or workspace-version drift. |
| REL-03 | Windows CI | 🟠 Scaffolded | P0 | Verify/package/E2E and dependency-audit workflows are defined, but there is no hosted repository run proving them. Publish the baseline, run CI, and retain artifacts/diagnostics. |
| REL-04 | Installer, portable ZIP, checksums, license report | 🟡 Partial | P0 | Forge makers and scripts exist; local package directories are not an audited tagged release. Run the full release workflow and verify install/uninstall/portable behavior on a clean Windows VM. |
| REL-05 | README, contributor guide, security policy, issue templates | 🟢 Working | P1 | Files and templates exist. Reconcile all claims with this tracker and add developer architecture/testing recipes. |
| REL-06 | MIT GitHub publication and tag-driven release | ⬜ Missing | P0 | Repository owner, remote, credentials, published tag, draft release, and public artifacts are not established. |
| REL-07 | Reproducibility and dependency/license review | 🟡 Partial | P0 | Lockfile, audit notes, checksum, and license scripts exist. Rebuild artifacts independently and compare hashes or document deterministic exceptions. |

Evidence: [test suite](../tests), [testing workflow](TESTING.md), [Luna/high prompt](testing/LUNA_HIGH_PROMPT.md), [QA session harness](../scripts/qa-session.mjs), [QA MCP client](../scripts/qa-mcp.mjs), [CI workflow](../.github/workflows/ci.yml), [release workflow](../.github/workflows/release.yml), [package scripts](../package.json), [dependency audit](DEPENDENCY_AUDIT.md).

## 10. Explicitly deferred from v1

These are not defects against the selected v1 unless the product scope changes:

- macOS, Linux, mobile, web hosting, 32-bit builds, and multiple native windows;
- accounts, telemetry, cloud sync, remote human multiplayer, and built-in assistant/chat;
- CMYK/16-bit workflows, ABR brushes, Aseprite round-trip, and lossless Photoshop/PDF round-trip;
- custom autotile scripting, automatic updates, provider accounts/model downloads, and code signing.

## Recommended critical path

1. **Stabilize trust and the product contract:** resolve SEC-01–05, FND-05, AGT-06–08, AGT-12, IO-10, UX-04–06, and establish REL-01/REL-02. Keep every previously reported bug as a packaged regression.
2. **Make agent parity practical:** implement AGT-11 plus PAR-01/03/04/06/07/09 first, so agents receive semantic operations, complete creation options, useful visual feedback, collaboration awareness, explicit workspace state, and efficient region writes. PAR-02/05/08/10 can follow without blocking the core editing loop.
3. **Finish daily illustration work:** transform handles, semantic paths/nodes, real text editing, masks/groups, complete gradients, the object outliner, large paint-layer proof, then a bounded natural-media/custom-brush MVP.
4. **Finish daily pixel animation work:** selection transforms, frame/cel operations, editable tags, palette overrides, reusable stamps/fonts, and animated interchange goldens.
5. **Turn map scaffolding into an editor:** complete tileset metadata, collision/Wang editors, neighbor-aware terrain, variants, objects, stamps, isometric accuracy, and Tiled round trips.
6. **Earn interchange and generation claims:** build the external fixture corpus, improve SVG/PDF/PSD fidelity, add durable reports, and run all providers through deterministic mock servers.
7. **Meet the release gate:** finish QA-09/10, utility-process isolation, performance/accessibility/corrupt-input gates, full packaged E2E, clean VM installer/portable tests, reproducibility, documentation reconciliation, then pass the Level 3 Luna/high gate and publish the tagged GitHub release.

## Maintenance rule

Every feature change should update this file in the same change set. Record the automated acceptance that justifies **Verified**; if a regression invalidates an exit criterion, move the item back immediately. Design documents may remain aspirational, but this tracker must remain literal.

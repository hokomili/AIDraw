# Human/agent parity audit

Last audited: 2026-08-20

## Verdict

AIDraw now has practical agent parity for the highest-value autonomous drawing loop: an authenticated agent can create a fully configured document, inspect exact state or a targeted raster, observe coarse human occupancy, apply compact revision-checked edits, wait on its own jobs, undo/redo, and start bounded non-mutating trace replay without an editor window.

Parity is not complete. Durable long-run batching, checkpoint comparison/merge, exact-time illustration-animation observation, and the highest-value semantic drawing kernels are available to agents. The remaining parity gaps are packaged attached-renderer acceptance, cheaper lower-level branch/merge workflows, richer cross-asset graph conveniences, and a small set of UI-only editing affordances. The editor itself also remains pre-v1, so parity does not imply professional feature completeness.

## Shared canonical boundary

Both renderer IPC and MCP commit through the same application-owned operation schema and reducer. There are 41 canonical operation kinds, including compact pixel/tile regions, atomic artboard replace/translate, palette reordering, and schema-2 illustration-animation settings/keyframes. Historical provider provenance remains readable in existing documents, but no renderer, MCP, or engine operation creates or changes it.

MCP also accepts a bounded semantic layer that expands into canonical operations:

- pixel flood fill, replace color, atomic replace-and-delete palette remapping, index/luminance adjustment, configurable ordered dithering, deterministic bitmap-font text, embedded-image quantization, integer selection scaling, animation/tags, reusable stamps, bounded image-collection create/append/exact-ID source replacement/proven-unused record removal/non-highest-ID in-span gap movement, typed tilemap objects, per-tile collisions, Wang authoring, deterministic weighted tile variants, and hash-checked pixel-project embed/pack operations;
- illustration align/distribute, gradients, styled text, image crop, object/layer/group filter stacks, masks, exact path booleans, schema-2 animation settings/keyframes, and the editable polished-gold material recipe;
- compact RLE cel and tilemap writes.

Human and headless agent path booleans share the exact Paper.js kernel in [`src/common/path-boolean.ts`](../src/common/path-boolean.ts), including transformed inputs and canonical delete/add replacement semantics. Import/export, quantization, and observation compositing run through supervised raster utility workers. Packaged crash and resource-pressure acceptance remains performance hardening rather than a capability gap.

Human and approved-agent SVG export share the same standards-first image-crop adapter. AIDraw re-import restores canonical crop controls only when its bounded versioned metadata still agrees with the ordinary clip/image geometry; edited or foreign wrappers keep the general editable group/image/mask interpretation rather than letting private state override visible content.

Interactive and headless illustration rendering also share one transform/isolation classification for object groups. A transform by itself is applied while traversing the group's children directly, so geometry outside the nominal artboard can move or scale into view without a premature artboard-sized buffer clip; opacity, blend, filters, masks, blur, or shadow still require one isolated composite. This parity statement does not certify effect-bearing transformed-group overhang or packaged Canvas behavior.

Human and approved-agent SVG import also share nested viewport resolution. Nested `<svg>` and referenced `<symbol>` content uses the same unitless/px/percentage placement, sizing, and viewBox matrix before entering canonical groups; unreferenced symbols stay definition-only. The shared importer warns and retains editable overflow because nested viewport clipping, CSS length resolution, and external references are not represented by this source/headless checkpoint.

The human tileset inspector edits an existing image collection through the same complete canonical `pixel.asset.replace` operation already available to the shared reducer boundary. It selects exact sparse IDs, resolves each tile's own sprite dimensions, and changes probability, typed properties, ordered animation, collision metadata, or the existing tileset drawing offset. Later bounded lifecycle work adds human creation from exact existing one-frame sprites, append-above-span, deliberate replacement of one exact local ID's source after a frozen document-wide impact summary, removal of one exact record only after a frozen proof finds no retained direct map-cell, animation, tile-object, stamp, Wang, resolver-shadow, resource, or stale-dependency uncertainty, and one deliberate move of a non-highest tile into an unused gap inside the unchanged authored span. Replacement changes no tile metadata/GID/source sprite and recomputes only the collection's nominal source envelope. Proven-unused removal leaves a sparse gap, first/raw GIDs, all other complete records, and every independently owned source sprite unchanged while recomputing the retained-source envelope. Gap movement moves the complete record and rewrites every proven exact animation, Wang, finite/signed-sparse orthogonal/isometric map-cell, tile-object and reusable-stamp reference while preserving flags, coordinates, order, geometry, source pixels, first GID, authored span and every unrelated resolution. Each chooser retains one immutable opening document/order/source observation and exact target identity/revision; replacement/removal/movement additionally bind tile/source identity and the impact/proof-owning document revision. Stable parent updates preserve selection, identity switches close the keyed panel, and displayed source/order/revision/impact/proof drift visibly refuses rather than reinterpreting the selection through newer props. Authenticated `pixel.image-collection.create|append|source.replace|source.remove|tile.move` requests share the planners, stand alone under the observed document revision, and lower to existing asset/map/stamp replacements rather than a new authority channel. Append/replacement/removal/movement on both surfaces carry exact tileset and relevant sprite revision/dimension guards, so queued-ahead source or topology change refuses atomically without mutating a source. Human creation uses canonical project order; semantic creation uses explicit request order. Tile-object authoring reuses the existing canonical object type and exact-ID planner for per-tile collection sprites, including animation-frame source selection, hit/culling, exact document/source-guarded human creation, document-bound semantic creation, and Tiled/native round trips. Wang likewise admits exact sparse representatives plus guarded paint/erase through the shared planner and maintained Tiled/native paths. Finite and sparse-infinite orthogonal/isometric tile layers first resolve animation to the exact local tile's native source dimensions, then apply projection-specific transforms, offsets, culling and depth without an atlas synthesis or GID rebase. Source deletion/cascading cleanup, swaps/arbitrary ID reassignment/reordering/compaction, external file picking, atlas conversion, Wang synthesis beyond exact authored signatures, collection-specific stamp topology beyond the reviewed exact move, a new sparse-isometric origin policy, and packaged/native acceptance remain outside the cumulative surface.

Animation-tag authoring and playback share the same flat exact-ID records and sequence kernels across the renderer and semantic MCP operation boundary. Overlap and nesting are independent memberships, not a combined schedule. Renderer and approval-backed export use exact IDs; CLI and headless batch retain the deliberately broader exact-ID-or-unambiguous-name convenience and refuse duplicate-name ambiguity. This is an explicit selector-authority difference, not divergent playback geometry, timing, mutation, or canonical state.

The same shared SVG importer rejects any transform-bearing geometry/container/reference/mask or referenced gradient whose parsed numbers, composed matrix, decomposition, or derived paint coordinates are non-finite. Human file import and approved-agent import therefore cannot diverge by admitting `Infinity`/`NaN` canonical state. Transforms on metadata and unsupported omitted elements remain irrelevant; this statement does not change the canonical magnitude policy or claim full transform grammar, external-corpus behavior, or packaged presentation.

Both entry surfaces also receive the same completed-document canonical gate. Canvas-recognized standard CSS colors are reduced to canonical sRGB hex, invalid colors share one warned black fallback, reverse-direction lines retain exact endpoint geometry, and bounded names share the same truncation warnings. Any remaining out-of-model result fails the complete import with the same exact error before either surface can use it. This proves generated source/headless parity only; it does not claim a complete CSS grammar, color-profile fidelity, external-producer recovery, or packaged error presentation.

## Closed parity gaps

| Area | Current contract and evidence |
| --- | --- |
| Creation | One strict `NewDocumentOptionsSchema` covers kind, name, dimensions, background, map orientation, finite/infinite mode, and tile geometry. Direct and MCP isometric creation are compared in contract tests. |
| Image-to-pixel | `pixel.image.quantize` performs area resize, OKLab palette matching, configured alpha threshold, and optional Bayer/Floyd–Steinberg dithering. Source and conversion metadata remain in the trace. |
| Human contention | Session inspection and observation return coarse object/region occupancy plus retry guidance. Agents cannot acquire human-priority locks. |
| Replay | `history_manage:replay` is actor-authorized, one-at-a-time, bounded to one million samples, and does not mutate revision/history. |
| Checkpoints | `history_manage` creates/lists/restores/deletes attributed editable document checkpoints and selectively merges top-level layer trees or pixel assets; `canvas_observe.checkpointId` returns canonical state or PNG. Restore preserves the abandoned branch automatically. |
| Visual observation | Asset/frame/layer/region, integer scale, background, named checkpoint, and exact illustration timeline time are selectable. Targets and output size are validated before utility-process rendering and PNG output is byte-capped. The latest commit can be observed as a race-free revision-labelled before/after pair under one shared budget. |
| Document fragments | `canvas_observe` exports bounded, self-contained editable object/asset graphs and `canvas_apply` imports them through server-attributed canonical operations. Clipboard uses the same versioned contract; indexed sprite-selection copy additionally emits one derived 1× standard PNG and marker-absent PNG paste quantizes into the exact active human exposure without giving MCP ambient clipboard authority. |
| Selection clipboard fallback | Private indexed selection identity remains authoritative between AIDraw processes. A companion standard PNG carries only visible RGBA over the exact selection bounds; marker-absent paste uses the active frame's effective palette/conversion defaults, includes transparent clears, clips at cursor or `(0, 0)`, and returns one bounded cel plan. Its canonical transaction binds the planning document revision plus cel revision, preserving and conflicting on intervening canonical edits rather than committing stale indexes. Invalid or incompatible claimed AIDraw ownership never falls through. This is source/headless behavior, not packaged/native cross-application acceptance or palette/mask fidelity for PNG. |
| Attached advisory | The renderer publishes viewport, selection/tool/zoom, active asset/frame/tag, onion-skin, playback, and direction as sanitized non-canonical hints that clear on detach. |
| Workspace/jobs | Document listing has an explicit active ID. File-approval job list/inspect/wait/cancel is owner-scoped and sanitized; exact approval details and engine authority are not leaked. |
| Throughput | Pixel/tile RLE runs support one million cells, cross 32×32 chunks, exact inverse, progressive reveal/cancel, and sample-based backpressure. Numbered durable batches add progress, idempotent resume, cross-session token rebinding, cancellation, and crash reconciliation from the transaction trace. |
| Attribution | Actor metadata can declare model, reasoning effort, and task ID. UI labels never synthesize `undefined`; metadata is explicitly client-declared rather than platform-attested. |
| Project links | Humans and agents share immutable hash/cache transition kernels. MCP semantic operations embed or pack without UI; explicit approved `asset_import.projectLinkId` and `document_export.projectLinkId` requests relink or extract without filesystem enumeration. |
| Derived cycle export | The human Export popover, headless batch CLI, and approval-backed `document_export` share one exact palette-cycle schedule/export kernel for GIF, APNG, and sprite-sheet output. MCP retains exact-ID and human-approval authority while CLI retains exact-ID-or-unambiguous-name selection; both refuse non-centisecond-exact GIF timing before approval/publication while APNG and sheet metadata retain authored milliseconds. Neither path gains document mutation or combines cycle and timeline scheduling. |
| Animation tag schedules | Human preview/export and MCP resolve one exact independent tag ID; batch and CLI additionally admit one unambiguous case-insensitive name. All surfaces use the same forward/reverse/ping-pong sequence and authored frame durations, while duplicate-name ambiguity, missing IDs, and incompatible formats fail before export/approval. Overlap never composes schedules or creates hierarchy. |
| Metadata sprite-sheet import | One bounded source/headless JSON convention reconstructs complete TexturePacker-style trimmed and clockwise-packed rectangles onto one shared full source canvas, while legacy equal-size untrimmed array/object sheets remain exact. This adds no canonical packing schema, export behavior, arbitrary producer compatibility, Aseprite round trip, MCP authority, or packaged/native evidence. |
| Hardening | Entity attribution is server-authored, inline rasters and addressed imports are decoded/parsed under explicit byte and expansion budgets, companion paths are contained, asset references are protected, conversion settings are strict, and historical provider provenance is passive. |

## Remaining parity backlog

| Tracker | Gap | Why it matters |
| --- | --- | --- |
| PAR-08 | Attached-renderer advisory acceptance | The complete advisory contract is implemented and sanitized; packaged attach/detach and live-state acceptance remains to graduate it from Working. |
| PAR-10 | Layer variants and selective merge | Document checkpoints, canonical observation, overlay/side-by-side review, accept/reject, persistence, safety branches, and dependency-aware top-level layer/pixel-asset merge are implemented. Cheap in-place layer forks and lower-level entity merge remain. |
| AGT-11 | Remaining semantic kernels | Richer cross-asset graph cascades remain; project linking, Wang authoring, deterministic tile variants, and isolated layer/group filters now share semantic or approval-backed agent paths. |

## Boundary asymmetries that remain by design

| Agent | Human |
| --- | --- |
| 256 canonical operations, 2 MiB request/transaction, four queued transactions per actor, four visible lanes, one-million-sample playback budget | Pointer previews are local and human commits bypass the agent queue |
| Explicit addressed paths, approval outside trust, and approval for every overwrite | Native dialogs convey direct user intent |
| Sees coarse occupancy/advisory state only | Owns detailed local UI state |

These are security, responsiveness, and privacy boundaries rather than parity defects. Long-run batching must work within them, not remove them.

## Studio-level gaps shared by human and agent

The largest capability limits now belong to the editor itself:

- deeper paper/pigment simulation and portable brush-library management beyond the sparse tiled paint/cache path (ILL-06–08, ILL-18);
- deeper semantic path/text editing, mask/filter depth, and richer illustration property tracks/dope-sheet editing (ILL-09, ILL-13–17, ILL-21);
- packaged/native cross-application pixel clipboard acceptance, animated interchange fixtures, collision/object-map polish, and external Tiled fixtures (PIX-05/10–14, MAP-02–13);
- advanced SVG/PDF/PSD portability, editable PDF import, and broader animated/Tiled interchange corpora (IO-02–09);
- broader local utility error/mode matrices and goldens, packaged accessibility/input testing, and interactive performance evidence.

## Ordered path from here

1. Finish the remaining daily illustration/pixel/map depth and representative external interchange fixtures.
2. Complete packaged raster-utility crash/cancellation and corrupt-input acceptance.
3. Run packaged attached-editor, accessibility, pointer/frame-pacing, and multi-document regressions with Computer Use.
4. Prove installer/portable behavior, CI, reproducibility, and the Level 3 release workflow on the exact candidate build.
5. Stop at the selected Windows-local v1 boundary; remote multi-agent service infrastructure and non-Windows OS support begin only as separately scoped post-v1 programs.

## Maintenance rule

Any change that materially alters the human or agent surface must update this audit and [`FEATURE_TRACKER.md`](FEATURE_TRACKER.md) in the same change set. “Working” means the current workflow is usable; “Verified” requires automated acceptance evidence.

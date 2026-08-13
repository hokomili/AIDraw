# AIDraw

AIDraw is a desktop, agent-native drawing studio. Its authenticated local engine runs independently of the editor window: agents can continue editing crash-safe documents headlessly, and a human can open the UI at any time to collaborate or replay attributed work. Illustration and indexed pixel-art projects are first-class document modes; there is deliberately no built-in chat.

> **Project status: active pre-v1 development.** The surface below is the target v1 scope, not a claim that every workflow is complete. The audited [feature tracker](docs/FEATURE_TRACKER.md) is the source of truth for what is verified, partial, scaffolded, or missing.

## Target v1 surface

- Single-artboard illustration documents with editable vector strokes, paths and node editing, shapes, gradients, ranged text, images, sparse raster-paint tiles, masks, clipping, blend modes, filters, shadows, alignment, distribution, path booleans, and object-pose keyframe animation with GIF/APNG export.
- Pixel sprites and projects with custom and undoably resizable canvases, indexed palettes with JSON/GPL interchange, bounded exact pixel tools with cancellable gestures, symmetry, configurable ordered dithering, reusable bitmap fonts, selection and reusable pixel/tile stamps with clockwise or counterclockwise exact quarter-turns plus previewed bounded library-JSON transfer, linked cels with a bounded layer×frame exposure grid, animation tags and bounded session-local multi-frame onion controls, palette overrides, a visual sprite-sheet slicing/trim workflow, GIF/APNG, tilesets with source-sheet crop overlays, explicitly reviewed metadata re-slicing, bounded weighted-variant thumbnails and new-stroke reseeding, duration-aware animation preview/reordering, session-phased placed-tile animation with reduced-motion freeze and deterministic first-frame static export, crop-only byte/entry-bounded placed-tile source reuse, multi-selectable collision shapes, probabilities, Wang terrain, all eight square-tile Tiled H/V/diagonal transforms, and finite or 32×32 sparse-infinite orthogonal/isometric maps with storage-independent right-down compositing plus shared authored-aspect projection for artwork, feedback, and pointer/object geometry. Visible rectangle/ellipse/polygon/polyline map-object overlays share editor and headless raster observation/export semantics. Imported project sources can be embedded, extracted, relinked, hash-checked, or packed for sharing. Pixel stamp JSON remaps exact colors; tile stamp JSON is deliberately limited to maps with exact shared tileset/source identities and does not bundle or rebase tileset assets. Native-size tall-tile overhang/offset, explicit Tiled tile offsets/alignment, non-square diagonal-transform geometry, time-addressable tilemap observation, and animated tilemap export remain outside the current rendering promise.
- A secure Electron boundary: sandboxed renderer, context isolation, narrow typed preload API, sender checks, restrictive CSP, denied permission/webview/navigation requests, and Electron fuses.
- An editor-independent, authenticated Streamable HTTP MCP engine on `127.0.0.1`, with presence, named cursors, four fair actor-colored playback lanes with visible progress, human locks, revision conflicts, idempotency, per-actor undo, backpressure, cancellation, resources, and explicit jobs.
- Native `.aidraw` ZIP files with a cross-checked schema-2 manifest/document and tested matched schema-1 migration, strict persisted illustration records, normalized, schema-validated, and palette-reconciled pixel records/chunks, hash/length/MIME/header/supervised-decode-verified content-addressed images on production open/save and utility-import admission, metadata-preserving omission plus a visible startup warning for invalid recovered image payloads, index/payload/revision-reconciled editable named checkpoints, generated paint tiles, schema-validated unique activity/provenance records, a schema-validated durable transaction trace, path-confined contiguous-prefix crash recovery, preview, and restart-persistent reusable document presets.
- PNG/JPEG/WebP/SVG/PDF/PSD and clipboard interchange, plus GIF/APNG/spritesheet and Tiled TMJ/TMX/TSJ/TSX interchange with durable actor-attributed fidelity reports that can be inspected or exported as JSON. Reports retain human-readable warnings and rasterized names; currently instrumented PDF/PSD export outcomes also carry closed machine-readable reason codes tied to exact documents, layers, or objects, including the warning that retained invisible PDF text is not redacted by covering artwork. SVG keeps its supported structure editable; PDF/PSD use explicit hybrid or per-layer raster fallbacks where their richer native features cannot map losslessly. These initial reason codes are not comprehensive adapter-loss accounting or broad format compatibility evidence.
- Provider-neutral generation jobs for OpenAI `gpt-image-2`, Stability, and local ComfyUI API workflows, including configurable Comfy node mappings, graceful provider cancellation, a frozen before/result overlay comparison, true masked illustration outpaint with undoable artboard expansion, and explicit unaccepted-result cleanup. Hosted keys and the MCP bearer token use Windows DPAPI, macOS Keychain, or a real Linux secret store; Linux’s insecure `basic_text` fallback is refused. Every agent request is approved in-app before a potentially paid call.

AIDraw PSD export keeps a visible per-layer raster fallback and may add a hidden editable-text companion. Supported layer/group/companion opacity uses PSD's normalized 0–1 contract and therefore round-trips at the format's 8-bit precision. Before recursion or layer rendering, export rejects an output tree above 2,048 actual PSD records or depth 64; this includes generated visual-fallback and editable-text companion children and shares the established import limits. It then rejects when retained full-canvas layer/fallback rasters would exceed a shared 64-megapixel expanded-pixel budget; structural groups and metadata-only text companions do not consume that pixel budget, and the final composite retains its separate existing 64-megapixel static-raster bound. Illustration fallbacks render sequentially through a non-mutating source view that neutralizes only the exported layer's visibility, opacity, and blend; the temporary native surface is released after its pixels are copied, while masks, filters, descendants, ordering, and retained image data stay authoritative. Pixel PSD export writes the current frame in exact canonical group/child order, including empty groups and hidden pixel source data; each cel is stored at full source alpha while visibility, opacity, blend, and lock remain separate PSD metadata, so they are not baked twice. Later animation frames are explicitly omitted. AIDraw's binary layer and companion-object locks export as PSD lock-all, and PSD lock-all returns as a locked illustration layer. Individual Photoshop transparency/position/composite/artboard locks are not widened into AIDraw's broader lock and instead produce an import warning; pixel-mode import still creates independent sprites rather than restoring that exported hierarchy. Empty folders retain their group type and position because the pinned decoder's `children` array remains authoritative even when empty. For companions created by AIDraw, a later AIDraw import restores the stored object name, opacity, blend, lock, text box, line height, and a matrix-equivalent full affine transform onto the text object while leaving its synthetic hidden layer neutral; one layer visibility change reveals the visible-relative-to-layer object without showing duplicate text by default. Older translation-only AIDraw companions also recover their stored size and position, but an older file whose former AIDraw export already clamped fractional opacity cannot reconstruct the lost fraction. This private suffix-bound round trip and generated opacity/group/lock evidence do not reinterpret unmarked PSD text or promise partial-lock preservation, Photoshop font shaping, effect fidelity, exact transform fields, byte identity, external-producer visual compatibility, pixel-mode import hierarchy, animated-frame PSD export, or lossless PSD interchange.

Illustration lasso selection evaluates canonical object geometry when a gesture completes instead of selecting every object whose rotated bounds overlap. Filled shapes and editable paths use their transformed fill silhouette (including even-odd holes), vector strokes use the same pressure outline as rendering, text and images use their transformed object frame, and stroke-only shapes/paths use their geometric centerline. Click selection likewise treats a supported painted Canvas path as authoritative: empty ellipse corners and even-odd holes no longer fall through to rectangular bounds, rendered arrowheads participate, and the established scale-adjusted edge affordance plus topmost/Alt-cycle order remain. Unsupported groups, malformed paths, non-invertible transforms, paintless objects, or a missing hit-test context retain transformed-bounds fallback so canonical records remain selectable. These are core-geometry selection contracts, not mask, blur, shadow/effect, group-child silhouette, exact skewed screen-distance, or packaged pointer-acceptance promises.

Canonical shape and editable-path strokes now apply the same width, opacity, line cap, line join, dash pattern, and explicit Canvas miter limit in the interactive and headless renderers. Stroke opacity multiplies the existing object/group/layer composite alpha rather than baking a new color or object value, and a nonpainted or zero-width stroke draws nothing. A deterministic raw-RGBA golden binds the supported surface; packaged antialiasing/visual acceptance, custom miter editing, effect/interchange parity, and broad foreign-format claims remain separate.

Illustration union, subtract, intersect, and exclude share one Paper.js constructor across the editor and MCP. Editable paths enter that constructor with their stored even-odd/nonzero rule, the generated compound path keeps Paper.js's result rule, and an empty filled result is rejected before either caller can delete the inputs. The first selected object's layer, opacity/blend, fill, and stroke remain authoritative and are copied independently into the identity-transformed result. This is exact source/headless geometry for the supported shapes and paths, not compound-hole node-edit UX, general multi-subpath authoring, packaged interaction, or foreign-format compatibility.

Targeted illustration observation avoids a full-artboard native surface only when visible content is provably backing-translation invariant: integer-positioned, integer-sized solid rectangles with no stroke inside otherwise empty identity structural groups/layers. It renders a four-pixel-expanded local backing and raw-crops the request byte-for-byte; all curves, paths, text, images, gradients, strokes, rounded/fractional/transformed geometry, masks, paint content/cache, opacity/blend isolation, and effects keep the established full render plus raw crop. This is a bounded allocation win for simple sparse illustrations, not a generic region renderer or a change to canonical artboards, save/export, interchange, or observation output limits.

Illustration images support non-destructive canvas drag/aspect cropping plus explicit source-pixel X/Y/width/height fields. Numeric edits preserve fractional coordinates and the current displayed source-pixel scale, and they reposition the transformed local origin so the selected source top-left stays fixed in world space; applying the exact full-source rectangle clears the crop. This is an existing-object edit, not image-byte mutation, replacement/relink, or a new interchange promise. Explicit transform-reset semantics remain undecided.

Illustration custom raster-brush recipes can be copied or loaded as strict version-1 AIDraw brush-library JSON. Import previews without mutation, defaults to fresh-ID/name copies, and offers an explicit custom-library replacement that leaves existing strokes unchanged because their complete recipe and seed are already embedded. The format is capped at 1 MiB and 256 presets and reserves built-in IDs. It does not transfer built-ins, strokes, bitmap tips, folders/tags, application-global settings, or third-party brush formats; packaged clipboard/file interaction remains unverified.

Square-tile map painting has a bounded eight-choice transform panel. Each 32×32 thumbnail uses the same selected tileset crop and diagonal-first H/V matrix as rendering, while the tileset's geometric flip/90°-rotation capabilities decide which square symmetries are available. If a previously selected transform is not permitted for the active tileset, new paint uses identity rather than silently changing it into another geometry; existing GIDs are untouched. Rectangular diagonal previews remain deliberately unavailable until their cell-fitting policy is defined, and packaged layout/pointer acceptance remains unverified.

Pixel-mode APNG import accepts bounded Adam7-interlaced frame payloads through the existing editable-frame path and retains the exact source. Current deterministic evidence covers generated 8×8 RGBA and one-bit indexed/transparency fixtures, including a partial second-frame rectangle; it is not a broad external-producer or packaged-UI compatibility claim.

That editable-frame path also validates palette/transparency ordering and shape before conversion, rejects indexed pixels outside their declared palette, and compares 16-bit grayscale/truecolor transparency keys before reducing display color to the high byte. Exact evidence is limited to generated 2×1 controls plus malformed metadata variants; color profiles, arbitrary producers, and broad APNG compatibility remain outside the claim.

APNG files whose PNG fallback image is separate from the animation are also handled explicitly: the fallback's consecutive `IDAT` stream is validated but not composited, and later editable frames use `fdAT` over a transparent animation canvas. The alternative first-frame-in-`IDAT` layout must cover the full canvas. Current evidence is one generated 2×1 fallback/partial-frame control plus exact invalid layout mutations, not a general producer corpus.

Within that APNG-specific path, unknown critical PNG chunks and malformed/reserved chunk type codes reject rather than being silently interpreted as ordinary pixels. Unknown well-formed ancillary chunks remain ignored and source-retained. This is generated container-hardening evidence, not an allowlist for every ancillary extension or a broad PNG/APNG producer claim.

Pixel GIF/APNG import now preserves a deterministic frame-local indexed palette when every composited frame has at most 255 visible RGBA colors after the document alpha threshold. Existing document-palette colors keep their slots; novel colors take the lowest unused slots and later frames use ID-aligned palette overrides. If any frame exceeds that bound, the entire animation uses the established document-palette quantizer and reports the fallback while retaining the original source. A simple single-pixel-layer APNG can re-export its stored RGBA palette without a lossy Canvas readback, including partial alpha. Ordinary PNG and sprite-sheet output use that same exact RGBA plane with no palette rewrite, and an opaque GIF can emit indexes plus global/local RGB tables directly. Nontrivial layer composites retain the established Canvas renderer; GIF also falls back when a used color has partial alpha. Current evidence is limited to generated two-frame APNG/GIF controls and one 256-color APNG fallback—not broad producer, color-management, complex-composite, partial-alpha GIF, byte-identical container, or packaged compatibility.

Tilemap observation is allocation-bounded to the requested nonnegative nominal region and decodes only stored chunks whose conservative projected cell envelope can reach that region; the editor applies the same pre-decode filter to its outward-rounded visible viewport, including per-layer parallax, and bounds orthogonal grid-line traversal likewise. Visible map-object paths are filtered by their stroke/selected-handle-expanded affine projected bounds, with order preserved. Sprite base frames, bounded onion neighbors, and wrap copies also use the outward-rounded viewport through the shared region compositor instead of visiting every cel payload. Raster-backed pixel export refuses a whole output above 65,535 pixels per side or 64 megapixels instead of silently resizing it. Oversized canonical maps remain editable and saveable, with the noncanonical native preview replaced by the format's transparent 1×1 fallback when a full nominal preview is unsafe. This does not add a spatial index, expand infinite-map bounds from stored chunks, or define a shifted map origin.

Transient pixel/tile overlays follow the same outward-rounded viewport discipline as base artwork. Flood/replace and stamp previews, marching-ant cells, and replay overlays now submit Canvas work only for conservative projected cell bounds that can reach the view; compact horizontal replay/preview runs are clipped algebraically, including isometric diamond bounds, without expanding their stored operation. Point selections still scan their canonical point array once and retain only visible candidates. This changes no selection, preview, replay, transaction, order, or pixel semantics and is not a spatial-index or packaged frame-pacing claim.

## Requirements

- Windows 11 x64 is the currently locally verified development target.
- macOS and Linux support is implemented behind the same Electron model and has native packaging/CI definitions. Apple Silicon now has an exact-artifact independent Level 2 MCP + Computer Use PASS in `docs/MACOS_DEVELOPMENT.md`, but both targets remain pre-release until their hosted native and Level 3 release gates pass.
- Node.js 24 LTS and npm (the repository pins `24` in `.nvmrc`)
- Visual C++ runtime required by Electron/native dependencies

## Develop

```powershell
npm ci --cache .npm-cache
npm start
```

Run only the canonical engine, without creating an editor window:

```powershell
npm run start:engine
```

Run the complete fast verification suite:

```powershell
npm run verify
```

Run the repeatable non-GUI Windows v1 performance gate (5,000 vectors, four populated 4K paint layers, a 65,536-tile view, save/export, playback accounting, one-million-cell flood fill, and memory):

```powershell
npm run test:performance
```

The gate writes `test-results/performance-gate.json`; packaged pointer/frame-pacing, high-contrast/display-scale, and tablet measurements remain part of the later Computer Use release pass.

Formal QA uses three levels—Smoke, Regression, and Release Exhaustive—and every level combines automated checks, authenticated MCP, and native desktop interaction through Computer Use. Each formal run is performed in a fresh independent `gpt-5.6-luna` / `high` task against one newly packaged executable and isolated profile; PID, executable hash, and the UI/MCP URL must match before mutation. Use `node scripts/npm-node24.mjs run test:level1:auto` for the automated Smoke portion. On Codex desktop, native `qa-session` start/show/status/stop calls must run outside the filesystem sandbox. See [docs/TESTING.md](docs/TESTING.md) for the complete commands, checklists, isolation harness, and report contract.

Build and launch the packaged-app Playwright scenarios:

```powershell
npm run test:e2e
```

## Desktop artifacts

```powershell
npm run release:current
```

Run that command on the target OS. Forge writes Squirrel + ZIP on Windows, DMG + ZIP on macOS, and DEB + RPM + ZIP on Linux under `out/make`. `out/SHA256SUMS.txt` covers release files and `out/THIRD_PARTY_LICENSES.*` records dependency licenses. Prerelease artifacts do not yet carry a trusted publisher signature; local macOS bundles receive only an ad-hoc integrity signature with a stable app requirement, not Developer ID/notarization/Gatekeeper approval. Verify a downloaded file against the checksum published with its release. The tag workflow builds each OS on a native GitHub runner; a workflow definition is not release evidence until those hosted jobs pass.

The current transitive advisory review and build-only exceptions are documented in [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md).

## Connect an agent

Open Activity, choose Codex, Claude Code, OpenCode, Antigravity, or **Other MCP client**, then review the one-time consent prompt. Guided setup backs up the selected client configuration, replaces only its `aidraw` MCP entry, and enables the headless engine at OS sign-in. Restart or reconnect the selected client as instructed by the prominent result dialog. Closing the editor window leaves that engine, MCP endpoint, documents, recovery, and trace recorder running; launching AIDraw again attaches a new editor window to the same owner. The generic profile reveals the same authenticated Streamable HTTP URL/header contract without editing a file.

| Client | Guided user configuration |
| --- | --- |
| Codex | `~/.codex/config.toml` → `[mcp_servers.aidraw]` |
| Claude Code | `~/.claude.json` → `mcpServers.aidraw` (`type: "http"`) |
| OpenCode | `~/.config/opencode/opencode.json(c)` → `mcp.aidraw` (`type: "remote"`, `enabled: true`) |
| Antigravity | `~/.gemini/config/mcp_config.json` → `mcpServers.aidraw` (`serverUrl`) |
| Other | Streamable HTTP URL plus `Authorization: Bearer …` |

Packaged lifecycle commands use the platform’s AIDraw executable (`AIDraw.exe` on Windows, the executable inside `AIDraw.app` on macOS, and `AIDraw` on Linux):

```powershell
<AIDraw executable> --headless     # start the engine with no editor window
<AIDraw executable>                # attach/show an editor on the existing engine
<AIDraw executable> --quit-engine  # explicitly stop the background engine
```

### Batch export CLI

The packaged executable can export a native document without opening the editor or starting the MCP engine. Pixel exports accept an integer 1×–64× nearest-neighbor presentation scale:

```powershell
AIDraw.exe --batch slime.aidraw --scale 8 --save-as slime-x8.gif
AIDraw.exe -b hero.aidraw --format sprite-sheet --scale 4 --save-as hero-x4.png
```

The output format is inferred from the destination extension except for `sprite-sheet`, which requires `--format sprite-sheet`. Existing outputs are protected unless `--overwrite` is explicitly supplied. Use `AIDraw.exe --help` for the complete command reference. The same scale is available in the pixel-mode Export menu and as `scale` on the MCP `document_export` tool.

Automated local provisioning can request a one-time connection handoff without opening the editor:

```powershell
AIDraw.exe --headless --write-mcp-connection=C:\explicit\private\aidraw-connection.json
```

The explicitly named file contains the localhost URL, bearer token, active document ID, and owner PID. Treat it as a password-bearing bootstrap artifact, restrict access to the current OS user, and delete it after transferring the settings into the agent client. Normal launches never write a plaintext token file.

An unattended launcher can grant process-lifetime authority for a specific folder at the same time:

```powershell
AIDraw.exe --headless `
  --write-mcp-connection=C:\explicit\private\aidraw-connection.json `
  --trust-folder=C:\explicit\agent-output
```

`--trust-folder` only works with that explicit headless bootstrap. It lets agents read exact paths and create new files inside the named folder without an editor window. Existing destinations still require approval, so it never silently overwrites a file. Repeat the flag to grant more than one folder; the grant ends when that engine process exits.

The public tools are `session_manage`, `canvas_observe`, `canvas_apply`, `history_manage`, `document_manage`, `asset_import`, `document_export`, `generation_start`, and `job_manage`. Durable traces are available at `aidraw://documents/{id}/trace`, and attributed agent rows in Activity can replay their recorded operations. See [docs/MCP.md](docs/MCP.md) for the complete behavior, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for process/security boundaries, and [docs/PARITY_AUDIT.md](docs/PARITY_AUDIT.md) for the audited gap between human and agent workflows.

## Important boundaries

- Canvas and document-model operations require no open window or per-operation approval. Explicit file paths outside prior or launch-time trust, document closes that discard state, every overwrite, and potentially paid generation remain approval boundaries; pending approval jobs wait safely for an editor to attach.
- Human undo/redo never rewinds agent history. An agent can only undo its own session, while the Activity panel can target attributed work. Disjoint actor targets remain independently undoable; later overlapping work creates a non-crossable history conflict instead of silently rebasing through another actor's state.
- A cancelled animated transaction retains only its visible prefix as one undoable partial transaction.
- Ambiguous chargeable provider requests are never automatically retried and providers are never silently substituted.
- Addressed imports are parsed in a supervised utility process under byte/dimension/expansion budgets. Returned documents are not admitted until their generic asset metadata and embedded image envelopes pass main-owned checks and each payload completes a supervised decode; invalid results return no document. Sprite-sheet and Tiled companion paths must remain inside the approved root folder after canonical resolution; SVG/Tiled DTD and entity declarations are rejected.
- Renderer recovery diagnostics are written only to a user-selected local JSON file and deliberately exclude artwork, generation prompts/results, task IDs, MCP secrets, and provider credentials; AIDraw has no telemetry transport.
- Windows remains the release-evidence baseline. Apple Silicon has an independent Level 2 exact-package PASS, while macOS/Linux remain explicitly unverified release targets until hosted native, clean-machine/signing, and Level 3 gates pass. Accounts, telemetry, cloud sync, remote multiplayer, CMYK/16-bit, custom autotile scripts, automatic updates, and lossless Photoshop/PDF round-tripping are intentionally outside this release.

## License

MIT. See [LICENSE](LICENSE).

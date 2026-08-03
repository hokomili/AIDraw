# Architecture

## Process ownership

`EngineRuntime` is the canonical, BrowserWindow-independent owner of open documents, the transaction reducer, per-actor histories, locks, jobs, persistence, recovery, durable traces, credentials, generation adapters, and the localhost MCP endpoint. It runs in the Electron browser process but does not require a renderer. The React editor is an attachable client that receives immutable workspace snapshots through a narrow preload facade and keeps only optimistic pointer previews and UI state. It cannot access Node or Electron directly.

The first process for a user profile takes Electron's single-instance lock. `AIDraw.exe --headless` starts only `EngineRuntime`; a later ordinary launch signals that owner to create or focus an editor window. Closing the last window disables visual-delay scheduling but deliberately leaves the process and MCP engine alive. **File → Quit AIDraw Engine** or `--quit-engine` is the explicit full shutdown. Guided Codex setup can register the packaged `--headless` command at Windows sign-in.

All committed changes are `CanvasTransaction` values over the application-owned model in `packages/core`. The reducer verifies document identity and expected entity revisions, produces inverse operations, increments revisions, and records attribution. File formats and renderer libraries are adapters; their private serialization never becomes the native model.

## Concurrency

Human gestures preview in the renderer and acquire object or pixel/tile-region locks from pointer-down through commit. Agent transactions are serialized per document and scheduled round-robin across at most four visible lanes when an editor is attached. With no renderer, the same validated transactions commit immediately instead of sleeping for invisible animation. A session may queue four transactions, a request may contain 256 operations/2 MiB, and visible work shares a one-million-sample budget. Unrelated operations proceed; stale/conflicting operations return retry guidance.

Cancelling an active lane slices strokes/pixel changes at the current reveal position, commits that prefix with `partial` activity, and drops the rest. The prefix remains one attributed undoable transaction. Human and each MCP actor have independent undo/redo stacks.

## Rendering and storage

Illustration documents retain editable scene objects and paint strokes. Canvas renderers produce the interactive view and export composite; paint strokes are also materialized into sparse, content-addressed 256×256 PNG tiles when saving. Pixel cels use base64-packed 32×32 indexed chunks; infinite maps use base64-packed 32×32 `uint32` GID chunks with Tiled transform flags.

`.aidraw` is a ZIP with `manifest.json`, `document.json`, `activity.json`, `trace/transactions.jsonl`, `preview.png`, and `assets/<sha256>`. A temporary archive is closed, reopened, migrated, and validated before atomic replacement. Recovery journals append committed transactions and compact to a snapshot every 60 seconds. The separate per-document trace store is append-only and is never erased by recovery compaction; save/open round-trips it with the native file. Activity can replay a traced transaction as a non-mutating canvas overlay.

## Security boundary

BrowserWindow uses sandboxing, context isolation, no Node integration, no webviews, denied permissions/navigation, CSP, and hardened Electron fuses. Production renderer assets are served only from the restricted `aidraw://app` protocol, with `file://` extra privileges disabled. IPC validates the exact sender/main frame. Hosted keys and MCP token use `safeStorage`/DPAPI. Network provider calls run in main and never expose credentials to the renderer.

MCP uses authenticated stateful Streamable HTTP on a persistent first-available port from 48200–48231. Model mutations are safe to perform headlessly. Files are accessed only by explicit canonical paths; session/persistent folder trust can skip repeated non-overwriting prompts. Every overwrite and every agent generation still requires prior authority, and such jobs remain pending until an editor attaches rather than weakening the boundary in headless mode.

The commit boundary replaces client-proposed entity revisions, creator IDs, and timestamps with authenticated actor/commit values, recursively including sprite layers, frames, and cels. Undo/redo operates on the resulting trusted inverse so exact restoration is preserved. Generic canvas transactions cannot add or remove verified generation provenance. Embedded-asset deletion is rejected while image objects, paint tiles, linked previews, or provenance still reference it; an explicit ordered cascade remains possible and exactly invertible.

Inline assets do not grant filesystem authority, but they are still untrusted input. Only canonical base64 raster PNG/APNG/JPEG/WebP/GIF payloads are accepted, with a 1.5 MB decoded limit, SHA-256/length/MIME checks, safe header dimensions, an 8192 px side/16 MP limit, and a real codec decode before commit. Agent claims of a generated source are normalized to ordinary embedded data; verified generation status comes only from the engine-owned provenance path.

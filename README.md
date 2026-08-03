# AIDraw

AIDraw is a Windows-first, agent-native drawing studio. Its authenticated local engine runs independently of the editor window: agents can continue editing crash-safe documents headlessly, and a human can open the UI at any time to collaborate or replay attributed work. Illustration and indexed pixel-art projects are first-class document modes; there is deliberately no built-in chat.

> **Project status: active pre-v1 development.** The surface below is the target v1 scope, not a claim that every workflow is complete. The audited [feature tracker](docs/FEATURE_TRACKER.md) is the source of truth for what is verified, partial, scaffolded, or missing.

## Target v1 surface

- Illustration artboards with editable vector strokes, paths and node editing, shapes, gradients, ranged text, images, sparse raster-paint tiles, masks, clipping, blend modes, filters, shadows, alignment, distribution, and path booleans.
- Pixel sprites and projects with custom and undoably resizable canvases, indexed palettes, exact pixel tools, symmetry, ordered dithering, selection, stamps, linked cels, animation tags/onion skins, palette overrides, spritesheets, GIF/APNG, tilesets, collisions, probabilities, Wang terrain, and finite or 32×32 sparse-infinite orthogonal/isometric maps.
- A secure Electron boundary: sandboxed renderer, context isolation, narrow typed preload API, sender checks, restrictive CSP, denied permission/webview/navigation requests, and Electron fuses.
- An editor-independent, authenticated Streamable HTTP MCP engine on `127.0.0.1`, with presence, named cursors, four fair playback lanes, human locks, revision conflicts, idempotency, per-actor undo, backpressure, cancellation, resources, and explicit jobs.
- Native `.aidraw` ZIP files with a versioned manifest/document, content-addressed assets, generated paint tiles, activity/provenance, a durable transaction trace, recovery journal, and preview.
- PNG/JPEG/WebP/SVG/PDF/PSD and clipboard interchange, plus GIF/APNG/spritesheet and Tiled TMJ/TMX/TSJ/TSX interchange with explicit fallback reports.
- Provider-neutral generation jobs for OpenAI `gpt-image-2`, Stability, and local ComfyUI API workflows. Hosted keys and the MCP bearer token use Windows DPAPI. Every agent request is approved in-app before a potentially paid call.

## Requirements

- Windows 11 x64
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

Formal QA uses three levels—Smoke, Regression, and Release Exhaustive—and every level combines automated checks, authenticated MCP, and native Windows interaction through Computer Use. Each formal run is performed in a fresh independent `gpt-5.6-luna` / `high` task against one newly packaged executable and isolated profile; PID, executable hash, and the UI/MCP URL must match before mutation. Use `node scripts/npm-node24.mjs run test:level1:auto` for the automated Smoke portion. On Codex desktop, native `qa-session` launch/stop calls must run outside the filesystem sandbox. See [docs/TESTING.md](docs/TESTING.md) for the complete commands, checklists, isolation harness, and report contract.

Build and launch the packaged-app Playwright scenarios:

```powershell
npm run test:e2e
```

## Windows artifacts

```powershell
npm run release:windows
```

Forge writes an unsigned Squirrel installer and a portable ZIP under `out/make`. `out/SHA256SUMS.txt` covers release files and `out/THIRD_PARTY_LICENSES.*` records dependency licenses. Builds are unsigned by design; verify a downloaded file against the checksum published with its release.

The current transitive advisory review and build-only exceptions are documented in [docs/DEPENDENCY_AUDIT.md](docs/DEPENDENCY_AUDIT.md).

## Connect an agent

Open Activity, choose **Connect Codex**, review the one-time consent prompt, and restart Codex after AIDraw backs up and updates only `[mcp_servers.aidraw]`. Guided setup also registers `AIDraw.exe --headless` at Windows sign-in. Closing the editor window leaves that engine, MCP endpoint, documents, recovery, and trace recorder running; launching AIDraw again attaches a new editor window to the same owner. The Activity panel can reveal generic localhost settings and toggle start-at-login.

Packaged lifecycle commands are:

```powershell
AIDraw.exe --headless     # start the engine with no editor window
AIDraw.exe                # attach/show an editor on the existing engine
AIDraw.exe --quit-engine  # explicitly stop the background engine
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

The explicitly named file contains the localhost URL, bearer token, active document ID, and owner PID. Treat it as a password-bearing bootstrap artifact, restrict access to the current Windows account, and delete it after transferring the settings into the agent client. Normal launches never write a plaintext token file.

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
- Human undo/redo never rewinds agent history. An agent can only undo its own session, while the Activity panel can target attributed work.
- A cancelled animated transaction retains only its visible prefix as one undoable partial transaction.
- Ambiguous chargeable provider requests are never automatically retried and providers are never silently substituted.
- Windows 11 x64 is the supported v1 platform. Accounts, telemetry, cloud sync, remote multiplayer, CMYK/16-bit, custom autotile scripts, automatic updates, and lossless Photoshop/PDF round-tripping are intentionally outside this release.

## License

MIT. See [LICENSE](LICENSE).

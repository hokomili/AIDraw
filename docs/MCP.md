# AIDraw MCP contract

The editor-independent server is stateful Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Send `Authorization: Bearer <token>` on every request and retain the negotiated `Mcp-Session-Id`. The health endpoint is unauthenticated at `/health` but reveals no document data; `uiRequired: false` confirms the canonical engine is available without a window.

`AIDraw.exe --headless` starts the engine without a renderer. Closing the editor does not terminate sessions or documents. Animated transactions commit immediately while no editor is attached and retain their original operations for later trace replay. Launching AIDraw normally attaches the UI to the same process.

For unattended first-run provisioning, an explicitly authorized launcher may add `--write-mcp-connection=<absolute-json-path>`. Once the authenticated server starts, AIDraw writes its URL, token, active document ID, and process ID to that exact path without creating a renderer. The output is a password-bearing bootstrap artifact: keep it private to the current Windows account, import it into the MCP client, and delete it afterward. Without this explicit flag, the DPAPI-protected token is disclosed only through guided in-app setup.

The same launcher may repeat `--trust-folder=<absolute-folder-path>` to grant process-lifetime file authority to the headless MCP sessions it starts. AIDraw accepts this flag only when both `--headless` and `--write-mcp-connection` are present, reports the normalized grants in the connection JSON, and does not persist them. Trusted sessions can read addressed files and create new save/export files within those folders without attaching an editor. Existing destinations are always treated as overwrites and still create approval jobs. Generation requests never inherit folder trust.

## Resources

- `aidraw://documents`
- `aidraw://documents/{id}/manifest`
- `aidraw://documents/{id}/snapshot`
- `aidraw://documents/{id}/changes/{revision}`
- `aidraw://documents/{id}/trace` — append-only NDJSON transactions with actor, operations, outcome, and resulting revision

Clients that negotiate subscriptions receive resource-updated notifications after revisions change.

## Tools

- `session_manage`: join/name/color, inspect presence, or leave.
- `canvas_observe`: structured snapshot or diffs, optionally with a base64 PNG.
- `canvas_apply`: up to 256 application-owned operations with an idempotent `clientOperationId`, expected revisions, and instant or visible playback.
- `history_manage`: undo/redo only the calling MCP actor.
- `document_manage`: list/new/activate/open/save/save-as/close.
- `asset_import`: import one explicit path after applicable approval.
- `document_export`: export one explicit path; filename extension is required. Its optional `scale` is an integer from 1 to 64 and applies nearest-neighbor presentation scaling to pixel PNG/JPEG/WebP/SVG/PDF/GIF/APNG/sprite-sheet exports. PSD and Tiled interchange remain native-scale structural exports.
- `generation_start`: create/edit/inpaint/outpaint/variation request. Agent calls always produce a two-minute in-app approval job.
- `job_manage`: inspect, wait up to 30 seconds, report approval dependency, or cancel.

Long work returns an explicit job ID. File approvals expire after two minutes. `allow-session`, `allow-always`, and explicit launch-time folder authority apply only to non-overwriting file requests. Generation cannot inherit trust. Canvas transactions themselves never require an open editor or approval; approval-dependent boundary work waits for UI attention.

## Conflict and load responses

Every mutable entity can carry `expectedRevision`. Non-overlapping additions may commit against a newer document revision, while stale replacements return the entity's current revision and retryability. Active human locks return `locked`. Full actor queues or the global playback budget return retryable `busy`. Reusing a committed client operation ID returns `duplicate` without applying it again.

Pixel and tile changes use exact coordinate arrays. Tile GIDs retain Tiled horizontal, vertical, and diagonal flags. Large operations should be split into semantically meaningful transactions so progress, cancellation, undo, and attribution remain understandable.

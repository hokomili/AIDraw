# AIDraw testing workflow

Last updated: 2026-08-03

This workflow defines three test levels for AIDraw. Every formal run uses an independent Codex task configured as **`gpt-5.6-luna` with `high` reasoning**. The implementer does not certify their own change.

Passing automated tests alone is insufficient. Every level includes:

1. source-level automated checks;
2. authenticated MCP behavior;
3. native Windows UI interaction through the Computer Use plugin; and
4. at least one cross-surface assertion where an MCP change is visibly verified in the UI or a UI change is verified through MCP.

Playwright is valuable automated coverage, but it does not replace Computer Use. Computer Use must target the real AIDraw window and exercise native menus, dialogs, focus, pointer placement, and visible rendering.

## Roles and invariants

- The primary task implements changes and selects the required level.
- A **new** Luna/high task performs each formal test run. Do not reuse the implementation task as the tester.
- On Codex desktop, the primary task also acts as the mechanical launch coordinator: it starts/stops the tester's declared isolated package outside the filesystem sandbox, but it does not perform or judge the test cases.
- The tester is read-only with respect to production source. It may run commands and write ignored test reports/artifacts, but it must not fix product code, soften assertions, or change tracker statuses.
- Test documents use a unique `QA L<level> · <UTC timestamp>` prefix. Never modify, save over, close, or discard a pre-existing user document.
- Every formal level uses the exact newly packaged executable with an isolated profile. Testing a convenient pre-existing AIDraw window is not a formal run.
- Packaging and formal QA run only on Node 24.x. The runtime preflight and post-package artifact verifier must both pass; a command exit code without an executable is a failure.
- Paid generation calls are never made during QA. Generation UI is tested with mocks, cancellation, denial, or validation-only paths.
- A missing UI window, unavailable Computer Use helper, unavailable MCP connection, or unknown build identity is **Blocked**, not Pass.
- If Computer Use encounters a confirmation-required destructive action, stop at the confirmation boundary. Never overwrite or delete user data merely to complete a test.

## Level overview

| Level | Name | When to run | Typical duration | Required result |
| --- | --- | --- | --- | --- |
| 1 | Smoke | Before handing off a bug fix or focused feature | 10–20 minutes | Core automated checks, one MCP edit loop, and one native UI edit loop pass. |
| 2 | Regression | Before merging a feature cluster or milestone build | 45–120 minutes | Full fast suite and packaged Playwright pass; core illustration, pixel, persistence, collaboration, and UI regressions pass. |
| 3 | Release exhaustive | Before every versioned release candidate | Several hours or longer | Release artifacts plus exhaustive MCP, UI, interchange, recovery, security, performance, and accessibility evidence pass with no open P0 defects. |

The automated commands are deliberately named `:auto`. They cover only the automated portion of a level; the Luna/high MCP and Computer Use report is still mandatory.

## Exact-build and engine identity preflight

Formal QA must never assume that a registered `aidraw` MCP connection and a visible AIDraw window are the same engine. Multiple packaged builds and isolated profiles can run concurrently. The first bootstrap trial demonstrated that this assumption can produce valid MCP results against one engine while Computer Use sees another.

Use the supplied harness for every formal run:

1. Run the automated level through Node 24. On Codex desktop hosts, `node scripts/npm-node24.mjs ...` discovers the bundled Node 24 runtime; elsewhere, activate `.nvmrc` or set `AIDRAW_NODE24_EXE`.
2. The Luna task reports an `AUTOMATION_COMPLETE_AWAITING_COORDINATOR_LAUNCH` checkpoint containing only the executable path/hash and the planned isolated profile/connection/manifest paths. It does not spawn Electron.
3. The primary launch coordinator validates those paths are below the declared run root and starts the exact package with `scripts/qa-session.mjs`. On Codex desktop, this native GUI command must use the shell tool's explicit unsandboxed/escalated launch permission and `--launch-context unsandboxed-gui`; launching Electron as a child of the filesystem sandbox can raise Windows exception `0x80000003` before the health endpoint responds.
4. The coordinator resumes the same Luna task. Luna runs `qa-session status`; it must report `okay: true`, a live PID, matching connection PID/URL, and an unchanged executable hash.
5. Luna enumerates AIDraw windows with Computer Use. Read-only observation may be used to disambiguate candidates, but no input or QA document mutation is allowed yet.
6. Luna selects the window whose process-backed app identifier names the exact executable and whose Activity panel says `Listening at <manifest mcpUrl>`. The window, manifest, connection file, and process PID must agree.
7. Luna initializes the isolated connection with `scripts/qa-mcp.mjs`. Do not use the globally registered AIDraw MCP for a formal run because it may intentionally serve the user's normal profile.
8. Only after all identity assertions pass may the tester create or edit a QA document. Any mismatch is `BLOCKED`; request coordinator cleanup without mutating documents.

Connection and MCP state files contain a localhost bearer token. Keep them inside ignored `test-results/`, never print their contents, and never paste them into a report. `qa-mcp close` redacts/removes client state, and a successful coordinator `qa-session stop` redacts the stopped engine's connection file.

Example Level 1 bootstrap (replace the run ID once and use separate shell calls so each exit code is preserved):

```powershell
$AIDrawRepo = (Resolve-Path .).Path
$AIDrawRun = Join-Path $AIDrawRepo 'test-results\luna-high\<run-id>-level1'
node scripts/npm-node24.mjs run test:level1:auto
node scripts/qa-session.mjs start --exe "$AIDrawRepo\out\AIDraw-win32-x64\AIDraw.exe" --profile "$AIDrawRun\profile" --connection "$AIDrawRun\connection.json" --manifest "$AIDrawRun\session.json" --mode interactive --launch-context unsandboxed-gui
node scripts/qa-session.mjs status --manifest "$AIDrawRun\session.json"
node scripts/qa-mcp.mjs init --connection "$AIDrawRun\connection.json" --state "$AIDrawRun\mcp-state.json" --actor-name "QA Luna high L1 <run-id>" --actor-color "#7C3AED"
```

The coordinator owns `qa-session start`, `show`, and `stop`; those native-process operations run outside the Codex filesystem sandbox. Luna owns the sandboxed automated, status, MCP-client, Computer Use, assertion, and reporting steps. Write complex tool arguments to JSON files in the run root and pass `--args-file`; this avoids shell quoting from changing the MCP payload. At cleanup, Luna runs `qa-mcp close`, writes a draft result, and returns `TEST_COMPLETE_AWAITING_COORDINATOR_STOP`. After the coordinator stops the isolated engine and the harness redacts its connection credential, the same Luna task is resumed once to verify cleanup and finalize `report.md`. The harness preserves the non-secret profile/evidence; it does not delete test artifacts.

## Common run protocol

Every tester follows this order:

1. **Identify the subject.** Record test level, UTC run ID, source revision if available, dirty/untracked state, Node/npm versions, executable path, executable SHA-256, and isolated profile path.
2. **Run the automated portion.** Use the exact Node-24 level command and preserve the full exit status. Confirm the post-package verifier named the expected executable. Do not summarize a failed command as passed because a narrower retry succeeded.
3. **Pause for coordinated native launch.** Luna returns the automation checkpoint; the primary starts the declared isolated subject through an explicitly unsandboxed `qa-session start` call, then resumes Luna. A Windows exception from a sandbox-child Electron process is an invalid test launch, not a product failure.
4. **Select the native window safely.** Use the Computer Use skill, initialize its runtime, read its guidance and confirmation policy, enumerate apps/windows, and continue only after the executable path and Activity MCP URL select exactly one intended AIDraw window.
5. **Establish the isolated MCP session.** Use `qa-mcp init`, join as `QA Luna high L<level> <run-id>` with a distinct color, list/observe before document mutation, and record document IDs/revisions.
6. **Exercise UI through Computer Use.** Observe, perform one state-derived action, refresh, and visually verify. Re-observe after every layout/modal/focus change. Use real pointer drags for drawing tests.
7. **Cross-check surfaces.** Verify at least one isolated-MCP-created change visibly in that exact AIDraw window and one Computer-Use-created change through an isolated MCP observation or revision diff.
8. **Record failures immediately.** Include expected/actual behavior, exact reproduction, affected document/revision, window title, visual observation, logs, severity, and likely tracker IDs. Continue only when later results remain trustworthy.
9. **Clean up safely.** Restore the initially active isolated tab, close/redact the QA MCP state, and close only safely saved QA documents. Return the stop checkpoint; the coordinator stops the isolated engine outside the sandbox and resumes Luna. Do not touch the user's normal AIDraw profile or use UI deletion as cleanup.
10. **Finalize the report.** Verify the isolated PID is stopped and use [testing/REPORT_TEMPLATE.md](testing/REPORT_TEMPLATE.md). `PASS`, `FAIL`, and `BLOCKED` are the only overall outcomes.

Reports belong under the ignored path:

```text
test-results/luna-high/<UTC-run-id>-level<1|2|3>/report.md
```

The tester also returns the concise outcome in its task so the primary task can read it without opening local artifacts.

## Level 1 — Smoke

Automated command:

```powershell
node scripts/npm-node24.mjs run test:level1:auto
```

Required MCP checks:

- authenticated `session_manage` join/inspect;
- list documents and record the initially active document;
- create one small QA pixel sprite with a unique name;
- observe structured state and PNG;
- apply one visibly animated exact-pixel transaction with a unique client operation ID;
- verify revision increase, nonblank PNG, attribution, and duplicate-operation idempotency;
- undo and redo as the originating agent;
- leave the session.

Required Computer Use checks:

- target exactly one AIDraw window and prove it is not blank or in the renderer recovery screen;
- open the dedicated New Document dialog and cancel it without creating an extra document;
- activate the QA sprite created through MCP and visually verify its dimensions and MCP-created pixels;
- select the pixel pencil, draw one clearly separate pixel with a real pointer action, and verify the visible cell matches the cursor location at a non-default zoom;
- exercise human Undo and Redo through native shortcuts;
- verify tabs, tool rail, canvas, Layers/Inspector/Activity panels, timeline, and bottom status remain responsive;
- cross-check the UI-created pixel through MCP observation;
- restore the original active document.

Level 1 passes only when the automated command, MCP checks, native UI checks, and both cross-surface assertions pass.

## Level 2 — Regression

Automated command:

```powershell
node scripts/npm-node24.mjs run test:level2:auto
```

Level 2 includes all Level 1 checks plus the following.

MCP and collaboration:

- exercise every public resource and tool without making a paid request;
- verify two independent sessions, per-actor undo, duplicate IDs, stale revisions, human-lock conflict, busy/backpressure response, cancellation/partial activity, trace inspection, and background-tab editing;
- test headless engine → attach editor → close editor → reattach lifecycle;
- test a new-path file approval in a disposable test root, denial/cancellation, timeout, and no unintended overwrite;
- verify recovery after a clean restart and explicit discard of an untitled QA document.

Computer Use core workflows:

- use native **File → Open**, keyboard Open, Save As to a new disposable path, and the close flow;
- create custom-size Illustration, Pixel Sprite, Pixel Tilemap, and Pixel Project documents from the dialog;
- illustration: select/multiselect, lasso, move/snapping, pressure/vector stroke, raster brush/eraser, path/node basics, all shapes, gradient, crop, text, eyedropper, layer operations, mask, alignment/distribution, boolean operation, opacity/blend/shadow/blur, Undo/Redo;
- pixel: pencil/eraser/fill/replace/line/shapes/wand/stamp/dither/lighten/darken/text/picker, selection, symmetry, wrap preview, palette edit/reorder, resize, linked and independent frames, duration, onion skin, loop/ping-pong, replay;
- tabs: overflow scrolling/all-documents menu, background activity badge, close/save behavior, and no resurrected discarded document;
- Activity: presence, named cursor, approval card, Stop All Agents, trace replay, and reconnect notice;
- verify no white screen, malformed-event crash, coordinate offset, or unreachable tab regression.

Interchange sample:

- round-trip one representative native file;
- export and visually inspect PNG, SVG, GIF, APNG, and sprite sheet;
- perform at least one representative SVG import and one Tiled JSON round trip, recording expected fallback warnings.

Level 2 passes only with no Blocker/P0 failure and no unexplained skipped required case.

## Level 3 — Release exhaustive

Automated command:

```powershell
node scripts/npm-node24.mjs run test:level3:auto
```

Level 3 is the complete release-candidate gate. It includes Levels 1 and 2 plus:

### Build and clean-machine evidence

- run from a committed, reviewable baseline with a clean dependency install;
- verify installer and portable ZIP on a clean supported Windows 11 x64 environment;
- verify install, launch, attach/headless lifecycle, clean uninstall behavior, portable behavior, SHA-256 checksums, dependency/license report, and documented unsigned-build warning;
- record all artifact hashes and build environment versions.

### Exhaustive MCP contract

- all resources, subscriptions, notifications, tool actions, annotations, schema boundaries, malformed payloads, 2 MiB/256-operation limits, four queues, four playback lanes, one-million-sample budget, 32 clients, fairness, cancellation, locks, retries, approvals, timeouts, and actor-isolated history;
- headless multi-hour-style sequence with checkpoint observation and restart/recovery;
- permission tests for exact paths, trusted folders, reparse/symlink/case aliases, companion exports, overwrites, and unsaved close;
- attribution/provenance and referential-integrity checks represented by SEC-01–05.

### Exhaustive native UI through Computer Use

- enumerate and exercise every visible native menu item, shortcut, dialog, toolbar tool, panel tab, inspector control, timeline control, layer/asset action, status control, approval state, empty/error/loading state, and document type;
- test supported minimum/typical/large window sizes, 100% and 200% display scaling where available, keyboard-only navigation, reduced motion/high contrast where safely testable, focus restoration, modal focus, and readable actor labels;
- perform complete illustration, animated-sprite, tileset/Wang terrain, finite map, infinite map, isometric map, generation-with-mocks, import, export, save, reopen, trace replay, and recovery scenarios;
- visually compare before/after state and cross-check every persisted UI mutation through MCP or reopened native state.

### Interchange and rendering corpus

- run maintained external fixtures for SVG, PDF, PSD, PNG/JPEG/WebP, GIF/APNG, sprite sheets, TMJ/TMX/TSJ/TSX, including supported and deliberately unsupported features;
- compare maintained visual goldens for illustration compositing, brushes, masks, blends, filters, pixel frames, animations, orthogonal maps, and isometric maps;
- require explicit, accurate fallback reports for every intentional fidelity loss.

### Resilience, security, and performance

- malformed/corrupt/truncated/oversized inputs, ZIP bombs/decompression limits, invalid chunks, cyclic references, huge dimensions, interrupted saves, renderer failure/reload, provider failures, and process crashes;
- mocked OpenAI, Stability, and ComfyUI success/failure/cancel/rate-limit/moderation/timeout/ambiguous cases with no paid network call;
- measured pointer latency/frame pacing, 5,000 vectors, four 4K paint layers, large visible tilemap, save/export duration, memory ceiling, and queued-agent isolation against documented budgets.

Level 3 release criteria:

- automated release command passes;
- every mandatory Computer Use and MCP scenario has evidence;
- no open Blocker or P0 defect;
- P1 exceptions are explicitly accepted and linked to tracker IDs;
- release artifacts, report, warnings, and known limitations agree with the README and feature tracker.

## Failure severity and reruns

| Severity | Meaning | Gate effect |
| --- | --- | --- |
| Blocker | Cannot launch/attach/test, persistent white screen, data loss/corruption, unsafe authority bypass, or result cannot be trusted | Fails every level immediately. |
| P0 | Core workflow, security boundary, recovery, coordinate correctness, or release artifact failure | Fails every formal level. |
| P1 | Major advertised workflow is broken without a safe practical workaround | Fails Level 2/3; may fail Level 1 when in changed scope. |
| P2 | Bounded defect with a clear workaround | Record; release requires explicit disposition. |
| P3 | Cosmetic/polish issue | Record and triage. |

After a fix, spawn a **fresh Luna/high task**. A rerun may target the failed case plus the level's smoke core, but a release candidate must receive a fresh complete Level 3 run.

## Tester prompt

Use [testing/LUNA_HIGH_PROMPT.md](testing/LUNA_HIGH_PROMPT.md) as the canonical task prompt. Substitute the level, subject/build identity, and report run ID. Do not remove its Computer Use, isolation, evidence, or no-source-edits requirements.

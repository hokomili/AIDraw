# AIDraw QA report

## Result

- Overall: `PASS | FAIL | BLOCKED`
- Level: `1 | 2 | 3`
- Run ID:
- Started/finished UTC:
- Tester model:
- Tester reasoning effort:
- Report path:

## Subject and environment

- Test subject/change:
- Source revision:
- Dirty/untracked summary:
- Node/npm versions:
- Windows/display details:
- Executable path:
- Executable SHA-256:
- App version/window title:
- Profile: isolated path/identifier:
- Initially active document ID/name:

## Build and engine identity preflight

| Assertion | Result | Evidence (never include bearer credentials) |
| --- | --- | --- |
| Node runtime is 24.x | | |
| Post-package executable exists and hash is recorded | | |
| Native process was launched outside the filesystem sandbox | | |
| QA session status is `okay: true` | | |
| Manifest PID equals connection PID and live process | | |
| Manifest hash equals current executable hash | | |
| Computer Use app path equals manifest executable | | |
| Activity MCP URL equals manifest/isolated-client URL | | |

## Automated gate

| Command | Result | Duration | Evidence/notes |
| --- | --- | ---: | --- |
| `node scripts/npm-node24.mjs run test:levelN:auto` | Pass/Fail/Blocked | | |

## MCP cases

| Case | Result | Document/revision | Evidence/notes |
| --- | --- | --- | --- |
| Authentication/session | | | |
| Observe | | | |
| Apply/idempotency | | | |
| Actor undo/redo | | | |
| Level-specific cases | | | |

## Computer Use UI cases

| Case | Result | Expected | Actual/visual evidence |
| --- | --- | --- | --- |
| Window selection/render health | | | |
| Native menu/dialog | | | |
| Canvas pointer/tool action | | | |
| Panels/tabs/status | | | |
| Level-specific cases | | | |

## Cross-surface assertions

| Direction | Result | Evidence |
| --- | --- | --- |
| MCP → visible UI | | |
| Computer Use UI → MCP state | | |

## Findings

### `BLOCKER/P0/P1/P2/P3` — Short title

- Tracker IDs:
- Reproduction:
- Expected:
- Actual:
- Document ID/revision:
- Window/modal/focus state:
- Evidence/log excerpt:
- Reproducibility:

Repeat the subsection for each finding. Write `None` when there are no findings.

## Coverage exceptions

List every skipped, unavailable, confirmation-blocked, or environment-dependent requirement. Any unexplained mandatory skip invalidates a Pass.

## Cleanup

- MCP session left:
- MCP state credentials redacted:
- Engine connection credentials redacted after stop:
- Initially active isolated document restored:
- QA documents closed safely:
- Remaining QA documents:
- Isolated QA engine stopped:
- Remaining QA processes (isolated and pre-existing listed separately):
- Test files retained:
- Cleanup warnings:

## Final gate decision

State why the level passed, failed, or was blocked and name the exact next required action.

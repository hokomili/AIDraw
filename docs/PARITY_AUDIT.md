# AIDraw human/agent parity audit

Audited: 2026-08-03. Method: code-level enumeration of the complete human surface (renderer tools, panels, dialogs, native menus, main-process IPC) and the complete agent surface (MCP tools, resources, the operation union, reducer semantics, limits), cross-checked for divergence. [FEATURE_TRACKER.md](FEATURE_TRACKER.md) remains the status source of truth; this file records the parity lens specifically.

**Goal context.** AIDraw's objective is an agent-native drawing harness that empowers AI to reach the human ceiling of art skill. The parity question is therefore exact: can an MCP agent reach every document state a human artist can reach in the editor, with comparable feedback and throughput? Section 9 widens the lens to what is missing for the goal itself.

**Tracker reconciliation.** The actionable findings below are now represented in the release tracker as PAR-01–10 and SEC-01–05, with AGT-11 covering semantic operations and AGT-16 covering model/effort/task provenance. The tracker records status and priority; this audit retains the supporting parity analysis.

## 1. Verdict

The architectural foundation is genuinely parity-capable, but parity is not yet achieved. Both surfaces converge on a single vocabulary — the 25-kind `CanvasOperation` union (`packages/core/src/operations.ts:17-54`), one zod schema (`packages/core/src/schemas.ts`), one reducer (`packages/core/src/reducer.ts:66-393`) — whether the caller is the React UI (`src/main/main.ts:187`) or MCP `canvas_apply` (`src/main/mcp-host.ts:289-299`). **Zero operation kinds are blocked for agents**, and every model field is agent-writable (blend modes, masks, gradient stops, text ranges, shadows, cel links, Wang sets, collision shapes, palette overrides). The gaps are concentrated in creation-time options, renderer-computed semantics, observation granularity, throughput, and a few hardening asymmetries.

## 2. Gap class 1 — hard gaps (agent cannot do it at all)

| Gap | Evidence |
| --- | --- |
| `document_manage:new` accepts only kind/name/width/height. No artboard background, no tilemap orientation/infinite/tile-size at creation; the human New Document dialog has all of these. | `src/main/mcp-host.ts:311` vs `src/common/contracts.ts:23-27` |
| Artboard resize after creation exists for no one (human or agent). | FEATURE_TRACKER ILL-01 |
| No clipboard access. Human copy/paste carries SVG + PNG + AIDraw fragments; pasting a foreign image into a pixel document quantizes in main. | `src/main/main.ts:138-170` |
| Image-to-indexed-pixel quantization is a main-only helper; outside the generation-accept flow an agent must reimplement OKLab quantization itself. | `src/main/quantize.ts`, `src/main/generation-manager.ts:96-152` |
| Agents cannot acquire, hold, or observe human locks; conflicts surface only as `locked` responses. Human presence/cursor is invisible to agents (humans never enter the presence map). | `src/main/document-service.ts:451-478`, `src/main/mcp-host.ts:260-272` |
| Agent trace replay is human-only IPC; agents cannot trigger replay. | `src/main/main.ts:279-284` |

## 3. Gap class 2 — semantic gaps (replicable in theory, unreasonable in practice)

These commit through standard operations, but the computation lives in renderer/main code the agent cannot invoke. The agent must re-derive the geometry and emit raw primitives. This is where the human ceiling is actually lost, and it confirms AGT-11 verbatim:

- **Path booleans** (union/subtract/intersect/exclude) — Paper.js in the renderer; agent must reproduce boolean geometry as raw `pathData`. `src/renderer/canvas/path-boolean.ts`
- **Flood fill, replace color, lighten/darken, ordered dither, pixel-perfect pencil, stamp, bitmap-font rasterization** — renderer-computed pixel sets committed via `pixel.cel.set`. `src/renderer/canvas/PixelCanvas.tsx:101-191`
- **Align/distribute, snap-move, gradient drag placement, Bézier smoothing, node editing, image crop drag** — renderer geometry, plain operations out. `src/renderer/canvas/IllustrationCanvas.tsx`, `src/common/illustration-geometry.ts`
- **Material presets** (e.g. polished gold: 9-stop gradient + 5 masked overlay clones) — packaged renderer recipe. `src/common/material-presets.ts`
- **Sprite layer add/delete cascades, cel-per-frame fabrication, tileset/Wang/collision stubs** — whole-asset `pixel.asset.replace` graphs built UI-side. `src/renderer/App.tsx:2072-2351, 3544-3614`
- **Coarse-granularity tier**: pixel layers, cel add/delete/relink on existing frames, animation tags, palette overrides, tileset tiles/Wang/transformations, tilemap object layers — reachable only through whole-asset replace, never first-class operations.

## 4. Gap class 3 — observation gaps (agent draws with one eye closed)

`canvas_observe` provides full document JSON, revision diffs (including human operations), the durable trace, and a flattened PNG. Missing:

- PNG granularity: active asset only, **first frame only**, no per-layer PNG, no scale option. `src/main/render-document.ts:160-224`
- No jobs enumeration — agents can only inspect job IDs they were handed; human-initiated jobs are invisible.
- `activeDocumentId` stripped from the documents resource; only inferable indirectly.
- No lock list, no human presence, no selection/tool/zoom/onion-skin/playback state (renderer-only React state).

## 5. Gap class 4 — throughput and boundary asymmetries (mostly by design)

| Agent | Human |
| --- | --- |
| 256 operations / transaction, 2 MiB body and transaction caps | Uncapped, instant commits |
| 4 visible playback lanes, 4 queued transactions per actor, 1M-sample global budget, `busy` under load | Direct reducer application |
| 2-minute approval jobs for file reads/writes outside trust, every overwrite, all generation | Direct file dialogs and generation |
| No locks; loses every contested region to the human | Lock priority by design |

The caps are sane backpressure and the approval boundary is a security requirement; but as-is they make long autonomous runs (e.g. repainting a 512×512 cel through chunked `pixel.cel.set`) materially slower than a human gesture.

## 6. Gap class 5 — asymmetries in the agent's favor (hardening debt)

- `asset.add` with inline base64 bypasses import approval entirely (capped only by 2 MiB).
- `provenance.add` is unrestricted; provenance can be written without any generation.
- `createdBy`/`createdAt`/`revision` inside add-payloads are cloned verbatim — attribution is forgeable.
- `asset.delete` has no referential-integrity check (can orphan objects referencing the asset).
- `pixel.conversion.replace` accepts unvalidated values (no zod constraint).

## 7. Parity roadmap (priority order)

1. **First-class semantic operations** (extends AGT-11): path booleans, align/distribute, flood fill, replace color, gradient placement, region cel/tile writes. Each is already a reducer-level pattern; expose as operations.
2. **Enrich `document_manage:new`** with background and tilemap geometry options (small, high value).
3. **Observation upgrades**: lock list, per-layer/per-frame PNG with scale, job list, `activeDocumentId`.
4. **Agent-callable quantize / import-to-pixel path** outside the generation flow.
5. **Harden the agent-favored asymmetries** (class 5) before they become attribution bugs.

## 8. What parity already delivers

Headless authenticated engine with no editor required; durable attributed traces and non-mutating replay; per-actor undo; idempotency and revision conflicts; fair lanes and cancellation with partial commit; shared operation vocabulary with zero agent-blocked kinds; generation pipeline with approval gates and palette conversion; native `.aidraw` persistence with recovery. An agent can already autonomously produce complete, attributed illustration and pixel documents.

## 9. Gaps against the ultimate goal: human-ceiling art skill for AI

Parity with the *current UI* is necessary but not sufficient — the UI itself is a pre-v1 prototype (FEATURE_TRACKER "Current release truth"). Reaching the human ceiling requires closing three further rings of gaps.

### 9.1 Artistic capability missing on both surfaces

The agent can only be as good as the studio. These professional fundamentals are absent or partial for human and agent alike (tracker IDs in parentheses):

- Expressive media: no watercolor/natural-media painting (ILL-07), no custom brush engine or preset management (ILL-08), basic stroke compositing without spacing/stabilization/texture/wet mixing (ILL-06).
- Core editing depth: no transform handles (scale/rotate/skew/pivot) (ILL-03), no semantic path/node editing (ILL-09), no in-canvas styled-range text editing (ILL-13), incomplete selection workflows in pixel mode (PIX-05, PIX-13), scaffolded stamps (PIX-06).
- Non-destructive workflows: no reorderable filter stack, filter masks, or export parity (ILL-17); incomplete mask/clipping authoring (ILL-14).
- Completed animation authoring (PIX-10/11 partial; ILL-21 missing) and map/tileset authoring (MAP-02–06, MAP-10–11).
- Interchange fidelity: SVG/PDF/PSD round trips are partial (IO-02–05) — ceiling-level work must survive professional pipelines.

### 9.2 Agent-only capability the goal needs beyond UI parity

Human artists do not work blind; they continuously look, compare, and revise. The harness must give agents equivalent loops, not just equivalent mutations:

- **Perceptual feedback**: multi-scale and region observe, per-layer/per-frame rasters, before/after compare (GEN-08 is partial) — enough visual grounding for an agent to critique its own work.
- **Safe experimentation**: document branching/variants or cheap duplicate-and-compare flows; non-destructive adjustments an agent can revise without inverse-operation archaeology.
- **Semantic authoring primitives** (section 3) so model capacity goes to composition and taste, not reimplementing geometry kernels.
- **Long-run autonomy**: utility-process isolation (FND-09), performance budgets (FND-12/QA-07), and throughput that survives multi-hour unattended sessions.
- **Reliable generation loop**: provider adapters validated against deterministic mock servers (GEN-02–04, QA-05) — generation is the agent's unique amplifier and is currently untested against failure matrices.
- **Richer provenance** (AGT-16): model/effort/task identity per transaction, so attributed traces become a learning and review signal rather than labels.
- **Learning from demonstration**: the durable trace store already records human and agent transactions; with AGT-16 metadata and replay, human sessions become training/eval corpora for closing the skill gap measurably (golden-image suite QA-02 can double as the scoring harness).

### 9.3 Ordered path to the goal

1. Close parity sections 2–4 (semantic ops, creation options, observation, quantize path).
2. Close class-5 hardening debt and AGT-16 provenance.
3. Build the perception/iteration loop (observe upgrades, compare, branching) and validate providers with mock suites.
4. Finish daily-driver depth (ILL-03/06/09/13/17, PIX-05/13) — prioritized by what agents exercise most.
5. Add the bounded natural-media/custom-brush MVP (ILL-07/08) with golden-image tests.
6. Meet the platform gates (FND-09/12, QA-02/05/07) so ceiling-level output survives scale, then the release gate (REL-01–07).

## Maintenance rule

Same as the feature tracker: any change that alters the human or agent surface must update this audit in the same change set. Facts above cite code; judgments are marked as roadmap items.

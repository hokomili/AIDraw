# Dependency audit

## September 9, 2026 RC1 dependency follow-up

RC1 preparation advances Hono 4.13.0 to 4.13.7 and Vitest (including its matching components) 4.1.10 to 4.1.11. The dependency census remains 24 runtime / 28 development / 699 external registry records. npm relocates `@vitest/mocker` below Vitest; the canvas/core workspace links remain intact. The lock policy rejects regressions to all three advisory-bearing package records.

A fresh 641-package install and lifecycle rebuild on Node 24.19.0 / npm 11.6.2 pass the complete security gate: **zero vulnerabilities in both runtime and complete audits**, 639 verified registry signatures and 140 verified attestations. Logs are retained in `test-results/rc1-20260909/`. This dependency result does not transfer acceptance from the retained r2 application; RC1 still requires its fresh native package and independent acceptance gates.

## September 9, 2026 security correction

The user authorized fixing the three dependency packages carrying high-severity findings. The lockfile now selects the following compatible patches without changing direct dependencies or adding overrides:

| Dependency | Previous | Corrected | Surface |
| --- | --- | --- | --- |
| `fast-uri` | 3.1.5 | 3.1.7 | Runtime URI handling through AJV. Version 3.1.7 includes the additional serialization/bracket fixes beyond 3.1.6. |
| `@xmldom/xmldom` | 0.9.10 | 0.9.12 | Electron build tooling through `plist`. npm hoisted this record from the nested `plist` directory. |
| `js-yaml` | 4.3.1 | 4.3.2 | Development tooling through ESLint. |

Only these three package versions changed. npm also refreshed peer metadata. The manifest remains unchanged: 24 runtime and 28 development dependencies, zero optional/peer direct entries, and 699 external registry lock records. The existing security policy now requires the patched locked versions; three regression cases reject the preceding vulnerable versions.

A fresh disposable worktree installed 641 packages with `npm ci`. On Node 24.19.0 / npm 11.6.2, the full security gate passes: both runtime and complete audits have zero high/critical findings, 639 external packages have verified registry signatures, and 140 have verified attestations. The runtime audit still reports one moderate entry in Hono; the complete audit reports three moderate entries in Hono, Vitest and `@vitest/mocker`. No advisory exemption or forced upgrade was used.

Source verification passes portability, TypeScript, ESLint and 242 files / 1,762 tests against the freshly installed patched tree. Bounded dependency probes confirm rejection of malformed IPv6, XML-name injection and empty YAML merges exceeding their configured budget, with valid URI/XML/YAML and an Electron-style plist round trip preserved. These probes exercise the libraries directly; they do not establish prior exploitability through AIDraw's public interfaces.

Evidence is retained under `test-results/dependency-security-20260909/`, including the lock delta, clean install, security/source verification, dependency probes and final file identities. This is source/dependency evidence. It does not rebuild or replace ModelBenchmark's retained r2 package, certify native distribution, or close the remaining independent release gates. The earlier correction/package evidence remains immutable.

Advisory sources: [fast-uri 3.1.7 security release](https://github.com/fastify/fast-uri/releases/tag/v3.1.7), [xmldom memory exhaustion](https://github.com/advisories/GHSA-965w-775f-mr7g), [xmldom name injection](https://github.com/advisories/GHSA-3px3-54cx-rmw9), and [js-yaml empty-merge budget bypass](https://github.com/advisories/GHSA-2883-xcg3-v3hh).

## Historical August checkpoint

Historical lock checkpoint: 2026-08-21. It removes the unused OpenAI SDK and the orphaned direct `jsonc-parser` entry, and builds on the historical 2026-08-13 live registry/advisory review and Apple Silicon package evidence under pinned Node 24.14.0 / npm 11.9.0. Project source, tests, and scripts have no `jsonc-parser` consumer. Both the manifest and lock root now contain exactly **24 runtime dependencies and 28 development dependencies**—52 direct entries total, with zero optional and zero peer entries. Registry-dependent results below remain that review's historical snapshot until the next authorized online audit.

## Audited surfaces

AIDraw treats three surfaces independently:

1. **Application runtime graph.** `npm audit --omit=dev --audit-level=high` reports zero vulnerabilities.
2. **Packaged Electron runtime.** Electron is pinned to **43.4.0**, the latest published 43.x patch at review time. `scripts/verify-package.mjs` reads the packaged runtime's own `version` file and fails unless it exactly matches the manifest/lock policy.
3. **Build and supply-chain graph.** The complete audit explicitly includes production, development, optional, and peer dependencies and reports zero vulnerabilities. Those four command-line includes override every npm-supported ambient `omit` category rather than permitting local configuration to narrow the gate. `npm audit signatures` verifies registry signatures for **641 packages** and attestations for **141 packages** in the installed graph.

The initial complete-tree audit reported **34 package records: 4 low, 29 high, and 1 critical**. Production already had no high/critical finding; the reachable high/critical roots were in Electron rebuild/download, Forge prompt, ZIP extraction, and DMG build tooling. No advisory is being waived in the current complete tree.

## Decisions and compatibility proof

- Keep **Electron Forge 7.11.2 with Electron Packager 18.4.4**. Packager 20 is not a safe override: Forge 7 adapts positional callback hooks, Packager 18 promisifies that contract, and Packager 20 changed to object/promise hooks. A source-contract regression pins the exact Forge adapter, Packager hook runner, CommonJS/default-export bridge, and `extract(zipPath, { dir })` invocation.
- Replace only Packager's vulnerable `extract-zip@2.0.1` implementation with Electron's signed, provenance-published drop-in **`@electron-internal/extract-zip@1.0.5`**, exposed through npm's `extract-zip` alias. The 1.0.5 API and installed metadata match the exact Packager 18 call, and a real Forge package run successfully extracts Electron and completes native-dependency preparation.
- Override Forge's rebuild path to **`@electron/rebuild@4.2.0`**, with **`tar@7.5.22`** and **`tmp@0.2.7`**. The real package/make path completed Forge's native-dependency phase; the lock policy rejects the former `@electron/node-gyp`/tar-6 chain.
- Remove `@electron-forge/maker-dmg` and its unpatched `electron-installer-dmg` → `appdmg` → `image-size` chain. The local macOS maker copies the completed app with `/usr/bin/ditto`, adds the ordinary `/Applications` link, creates a compressed image with `/usr/bin/hdiutil`, verifies it before returning, and deletes partial output on any error. It deliberately adds no custom background/layout, signing, notarization, stapling, or Gatekeeper claim.

The manifest/lock policy also rejects reintroduction of the superseded build roots. It fails unless the manifest and lock root have matching dependency sections and each has exactly **24 runtime, 28 development, zero optional, zero peer, and 52 total direct entries**. OpenAI and `jsonc-parser` are forbidden in every direct dependency section and lock path. Every one of the exactly **699 external, non-link lock records** must resolve to an exact HTTPS `registry.npmjs.org` tarball and carry syntactically valid SHA-512 integrity. Only the explicitly allowed `packages/canvas` and `packages/core` repository workspaces and their npm link records are exempt. The policy separately requires the exact Electron registry tarball and the aliased extractor's exact package identity and registry tarball.

## Release enforcement

`npm run security:verify` is fail-closed and runs:

- manifest/lock policy validation;
- the production-runtime audit;
- a complete audit with production/development/optional/peer dependencies explicitly included; and
- registry signature/attestation verification where npm supports it.

Both desktop CI and release workflows call that complete gate; `release:current` no longer substitutes a production-only audit. Package verification separately requires the exact packaged Electron version, confirms build-only dependencies are absent from the shipped ASAR, and scans every first-party JavaScript chunk in the ASAR—including main, preload, utility worker, importer, renderer, and dynamic build chunks—for orphaned/provider dependency roots plus known active generation, provider-credential, protected-storage, and retired workflow/chunk markers. On 2026-08-25, the retained disposable source copy reused its clean lockfile-governed tree under Node 24.19.0 and produced a fresh local `darwin/arm64` package. The verifier recomputed its exact 252-file first-party package source-input manifest (including `index.html`), passed all 15 first-party JavaScript chunks, the exact 24/28/0/0/52 direct census, and 699-record external lock census for launcher SHA-256 `fcb4bce0595a81d4da2f948424fb8d6d8c94e72bc15c2e8e121e3fcb7505b6fc` and ASAR SHA-256 `974559010dac79fef3d73141bb659f88e44ea39643af1cd2671e60a52b24dc96`. The manifest does not purport to hash the installed dependency tree or toolchain; exact artifact hashes and the dependency census are separate evidence. This is local Apple Silicon artifact evidence only, not Windows/Linux/Intel, hosted, signed-distribution, advisory-refresh, or independent-rebuild evidence; prior package generations remain historical.

The repository's ignored installed dependency graph was not installed, pruned, or rewritten. Instead, the current subject was copied into a private disposable root and `npm ci --no-audit --no-fund` installed exactly 641 packages from the existing lock; registry access was limited to that installation. No current online advisory or registry-signature gate was run, so the audit/signature figures above remain the dated historical snapshot. A prior cache-enabled Vitest run did historically update ignored `node_modules/.vite/vitest/.../results.json`; that results metadata is not dependency truth and was not restored. The maintained complete acceptance/performance routes, both reachable QA-08 child launchers, and every active fenced or inline documented Vitest acceptance command pass `--cache=false`. Command-aware source policy inventories all manifest scripts, maintained executable scripts, workflow commands, and maintained documentation while ignoring ordinary prose; final gates prove the current cache snapshot does not move. Every future package subject still requires its own clean lockfile install; old installed/cache contents are not package evidence. Clean releases must retain the per-platform checksum/license/provenance outputs and receive independent native review.

## Limits and next review

This is a 2026-08-13 registry snapshot and exact local macOS evidence, not a guarantee about future advisories, other native hosts, package-maintainer intent, independent reproducibility, signing, or release-candidate status. Registry signatures authenticate published package material; they do not replace source review. The unsigned/ad-hoc macOS artifacts remain development artifacts.

Do not use `npm audit fix --force`, accept npm's Forge 7-to-6 downgrade proposal, or move Forge 7 to Packager 20 without a complete hook-contract migration and native cross-platform proof. Re-run the complete gate whenever the lockfile changes and re-evaluate the narrow substitutions when Forge, Packager, Rebuild, Electron, or the native DMG toolchain changes.

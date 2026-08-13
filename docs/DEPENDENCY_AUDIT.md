# Dependency audit

Last reviewed: 2026-08-13 against live npm registry/advisory metadata, the current manifest and lockfile, the installed complete tree, and a real Apple Silicon package/make run under pinned Node 24.14.0 / npm 11.9.0.

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

The manifest/lock policy also rejects reintroduction of the superseded build roots. Every one of the current **701 external, non-link lock entries** must resolve to an exact HTTPS `registry.npmjs.org` tarball and carry syntactically valid SHA-512 integrity. Only the explicitly allowed `packages/canvas` and `packages/core` repository workspaces and their npm link records are exempt. The policy separately requires the exact Electron registry tarball and the aliased extractor's exact package identity and registry tarball.

## Release enforcement

`npm run security:verify` is fail-closed and runs:

- manifest/lock policy validation;
- the production-runtime audit;
- a complete audit with production/development/optional/peer dependencies explicitly included; and
- registry signature/attestation verification where npm supports it.

Both desktop CI and release workflows call that complete gate; `release:current` no longer substitutes a production-only audit. Package verification separately requires the exact packaged Electron version and confirms build-only dependencies are absent from the shipped ASAR. Clean releases must still install from `package-lock.json`, retain the per-platform checksum/license/provenance outputs, and receive independent native review.

## Limits and next review

This is a 2026-08-13 registry snapshot and exact local macOS evidence, not a guarantee about future advisories, other native hosts, package-maintainer intent, independent reproducibility, signing, or release-candidate status. Registry signatures authenticate published package material; they do not replace source review. The unsigned/ad-hoc macOS artifacts remain development artifacts.

Do not use `npm audit fix --force`, accept npm's Forge 7-to-6 downgrade proposal, or move Forge 7 to Packager 20 without a complete hook-contract migration and native cross-platform proof. Re-run the complete gate whenever the lockfile changes and re-evaluate the narrow substitutions when Forge, Packager, Rebuild, Electron, or the native DMG toolchain changes.

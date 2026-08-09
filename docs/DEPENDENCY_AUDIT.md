# Dependency audit

Last reviewed: 2026-08-09 against the current lockfile and npm registry.

`npm audit --omit=dev --audit-level=high` passes with zero runtime high/critical findings. The production-tree audit reports two moderate package records in one transitive advisory chain:

- `@modelcontextprotocol/node@2.0.0` requires `@hono/node-server ^1.19.9`. The advisory concerns the Hono adapter's Windows `serve-static` handling of encoded backslashes. AIDraw never registers that middleware: its MCP endpoint is a fixed-route `node:http` server that serves no filesystem paths.

The Hono adapter fix is available only in the incompatible 2.x line (`@hono/node-server` is currently 2.1.0), while the latest MCP node package remains 2.0.0 with its 1.x constraint. No compatible upstream fix is available, and the affected static-file path is unreachable in AIDraw. Do not force an override across that major-version boundary.

One compatible development-only fix was applied without changing a direct dependency: PostCSS 8.5.25 permits `nanoid ^3.3.16`, so the lockfile now resolves patched `nanoid@3.3.18`. The lockfile diff contains only that version, URL, and integrity change; `package.json` is unchanged.

The current full development-tree audit reports 34 package records (4 low, 2 moderate, 27 high, 1 critical). The remaining high/critical findings are confined to native build and packaging tools:

- Electron Forge is already at the latest 7.11.2 and constrains `@electron/rebuild` to 3.7.x. That rebuild line carries `tar@6.2.1`; the patched modern rebuild/tar lines require incompatible major upgrades.
- Forge's prompt chain reaches `external-editor@3.1.0`, whose latest release still requires `tmp ^0.0.33`.
- `appdmg@0.6.6` still requires `image-size ^0.7.4`; the current `image-size@2.0.2` release is itself still inside the advisory range.
- Other reported Forge packages are propagation records from those same rebuild, prompt, cache, and DMG-maker roots rather than additional shipped runtime code.

`scripts/verify-package.mjs` now fails if those residual build-only roots occur inside the packaged ASAR dependency tree, and a synthetic regression proves the rejection. The final verified macOS ASAR contains none of them. Clean release builds must continue to install from `package-lock.json`, use isolated runners, avoid untrusted build inputs, and publish checksums plus the dependency-license inventory.

Do not use `npm audit fix --force`: it would replace coordinated Forge packages with incompatible versions. Re-evaluate these exceptions whenever Forge, MCP, `appdmg`, or the prompt chain updates, and treat any runtime high/critical finding as release-blocking.

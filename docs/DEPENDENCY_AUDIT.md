# Dependency audit

Last reviewed: 2026-08-04 against the current lockfile.

`npm audit --omit=dev --audit-level=high` passes with zero runtime high/critical findings. Direct Hono and AJV advisories were removed by pinning `hono@4.13.0` and `ajv@8.20.0`. The production audit now reports two moderate package records in one transitive advisory chain:

- `@modelcontextprotocol/node` currently carries `@hono/node-server`, whose advisory concerns Hono's Windows `serve-static` path handling. AIDraw does not invoke Hono static serving; its MCP endpoint is a fixed-route `node:http` server that serves no filesystem paths.

The current MCP package requires `@hono/node-server ^1.19.9`, while the advisory is fixed only in the incompatible 2.x line; no compatible upstream fix is currently available. Do not force an override across that major-version boundary. The affected static-file middleware is outside AIDraw's reachable server path.

The full development-tree audit currently reports 31 records (4 low, 2 moderate, 24 high, 1 critical), primarily in Electron Forge's build-only dependency chain (`@electron/rebuild`, platform maker helpers, `@electron/node-gyp`, `tar`, cache and interactive-prompt packages). Those packages are not shipped in the ASAR/runtime dependency set and are used only in clean, lockfile-controlled native release runners. No compatible upstream Forge release currently removes the complete chain. Release CI installs from `package-lock.json`, builds in ephemeral GitHub runners, never feeds untrusted archives to Forge, and publishes per-platform checksums and a dependency-license inventory.

Do not use `npm audit fix --force`: it would replace coordinated Forge packages with incompatible versions. Re-evaluate this exception whenever Electron Forge or MCP packages update, and treat any runtime high/critical finding as release-blocking.

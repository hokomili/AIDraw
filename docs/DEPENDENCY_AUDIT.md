# Dependency audit

Last reviewed: 2026-08-01 against the committed lockfile.

`npm audit --omit=dev --audit-level=high` passes. It reports four moderate package findings across two advisory chains:

- `@modelcontextprotocol/node` currently carries `@hono/node-server`, whose advisory concerns Hono's Windows `serve-static` path handling. AIDraw does not invoke Hono static serving; its MCP endpoint is a fixed-route `node:http` server that serves no filesystem paths.
- The MCP SDK's generated standalone validators require `ajv`/`ajv-formats`. The advisory applies only when AJV's optional `$data` feature is enabled; AIDraw does not enable `$data` and validates application-owned MCP schemas.

No compatible upstream fix is currently available for either chain. There are no runtime high or critical findings.

The full development-tree audit reports findings in Electron Forge's build-only dependency chain (`@electron/rebuild`, `@electron/node-gyp`, `tar`, cache and interactive-prompt packages). Those packages are not shipped in the ASAR/runtime dependency set and are used only in a clean, lockfile-controlled release runner. No compatible upstream Forge release currently removes the complete chain. Release CI installs from `package-lock.json`, builds in an ephemeral GitHub runner, never feeds untrusted archives to Forge, and publishes checksums and a dependency-license inventory.

Do not use `npm audit fix --force`: it would replace coordinated Forge packages with incompatible versions. Re-evaluate this exception whenever Electron Forge or MCP packages update, and treat any runtime high/critical finding as release-blocking.

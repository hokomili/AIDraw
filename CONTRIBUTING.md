# Contributing to AIDraw

Thank you for helping improve AIDraw. Contributions must preserve the editor's three core properties: human pointer input stays local and responsive, all mutations pass through the canonical transaction reducer, and external authority is explicit and reviewable.

## Setup

Use Node 24 LTS on Windows, macOS, or Linux. Windows 11 x64 is the currently locally verified development target; changes affecting macOS or Linux require their native CI jobs before release promotion.

```powershell
npm ci --cache .npm-cache
npm run qa:runtime
npm run check:portability
npm run verify
```

For a macOS transfer or first native bootstrap, follow [`docs/MACOS_DEVELOPMENT.md`](docs/MACOS_DEVELOPMENT.md). Do not copy Windows `node_modules`, packages, profiles, or retained QA evidence to the Mac, and do not treat a workflow definition as native acceptance.

For UI or collaboration changes, also run `npm run test:e2e` on Windows. For packaging changes, run `npm run make` on every affected OS and verify its native artifacts: Squirrel/ZIP on Windows, DMG/ZIP on macOS, or DEB/RPM/ZIP on Linux.

## Change expectations

- Add or update reducer inverse tests for every mutation operation.
- Add migration coverage before changing persisted shape or schema version.
- Preserve client operation ID deduplication, expected revisions, human locks, per-actor history, and scheduler limits.
- Treat corrupt images, archives, provider responses, Tiled files, PSD/PDF input, and MCP bodies as hostile input.
- Keep Electron renderers sandboxed. Do not expose Node primitives or generic IPC through preload.
- Never log prompts containing secrets, API keys, bearer tokens, source images, or full local paths unnecessarily.
- Interchange loss must produce a user-visible warning and faithful fallback.

## Pull requests

Keep changes focused, explain user-visible behavior and security impact, include screenshots for UI changes, and list the exact commands used to verify the change. Do not commit generated `out`, `.vite`, caches, credentials, `.aidraw` recovery files, or provider workflows containing secrets.

By contributing, you agree that your contribution is licensed under the repository's MIT license.

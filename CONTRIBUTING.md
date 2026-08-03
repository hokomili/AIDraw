# Contributing to AIDraw

Thank you for helping improve AIDraw. Contributions must preserve the editor's three core properties: human pointer input stays local and responsive, all mutations pass through the canonical transaction reducer, and external authority is explicit and reviewable.

## Setup

Use Windows 11 x64 and Node 24 LTS.

```powershell
npm ci --cache .npm-cache
npm run verify
```

For UI or collaboration changes, also run `npm run test:e2e`. For packaging changes, run `npm run make` and verify both the Squirrel installer and portable ZIP.

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

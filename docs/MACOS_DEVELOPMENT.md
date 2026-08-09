# macOS development and acceptance

This project is structurally prepared for native macOS development, but Windows static checks and workflow definitions are not macOS runtime evidence. A macOS host must still prove the native dependency, Keychain, package, signing, lifecycle, Electron, and interaction boundaries below.

## Transfer the repository safely

Prefer a reviewed Git commit and a fresh clone on macOS. Before committing, classify every existing modified and untracked path; never stage generated packages, retained QA evidence, `.codex`, caches, credentials, provider configuration, signing identities, or exported artwork. The portability preflight checks tracked paths plus prospective untracked paths without staging them:

```sh
npm run check:portability
git status --short
```

`.gitattributes` stores portable text as LF, keeps Windows-only PowerShell/controller scripts as CRLF, and marks common binary assets explicitly. Do not run `git add --renormalize` as part of migration; review normal content changes and line-ending changes separately if normalization is ever desired.

The current dirty checkout cannot be reproduced by cloning until a human decides which uncommitted source/test/controller files belong in one or more commits. Copying only the Git branch would lose those files; copying the entire Windows directory would also carry ignored native modules, packages, caches, profiles, and evidence that must not be reused on macOS.

## Bootstrap on a fresh macOS clone

Install Node 24 using the version manager of your choice, then use the committed lockfile. Do not copy `node_modules` from Windows: `@napi-rs/canvas` selects a native Darwin optional package during `npm ci`.

```sh
node --version
npm --version
node scripts/check-portability.mjs --include-untracked
npm ci --cache .npm-cache
npm run qa:runtime
npm run verify
```

The Node version must be 24.x. The current lockfile declares both `@napi-rs/canvas-darwin-arm64` and `@napi-rs/canvas-darwin-x64`; successful installation and loading on the actual host remain native evidence, not a Windows-static claim.

## Native package path

Run these only on the macOS host after the source gate is green:

```sh
npm run package
AIDRAW_PACKAGE_PLATFORM=darwin AIDRAW_PACKAGE_ARCH="$(node -p 'process.arch')" node scripts/verify-package.mjs
npm run make
npm run checksums
npm run licenses
```

Forge declares DMG and ZIP makers for Darwin. The fuse hook resolves `AIDraw.app/Contents/MacOS/Electron` while packaging and now keys ad-hoc-signature reset to Forge's target architecture rather than the build host. The release workflow also fails closed if its `macos-arm64` label disagrees with Node's actual platform/architecture.

## Evidence still required on macOS

- `npm ci`, TypeScript, ESLint, Vitest, native canvas loading, package verification, DMG/ZIP creation, and checksum/license output on a clean native runner.
- Electron `safeStorage` backed by an available/unlocked macOS Keychain, including encrypt/decrypt persistence and refusal when unavailable.
- Install, first launch, single-instance attach, headless engine, login-item enable/disable, login-start suppression, editor reopen, explicit engine quit, and uninstall behavior.
- Hardened fuses, sandbox/context isolation, CSP, permission/window/navigation denials, utility-process containment, preload surface, MCP loopback/privacy, approvals, and credential redaction in the exact macOS package.
- Native dialogs, menu roles/shortcuts, file paths and Unicode/case behavior, display scaling, keyboard layout, pointer/tablet input, and visible Computer Use acceptance.
- A deliberate Developer ID signing, hardened-runtime, entitlements, notarization, and stapling policy. Current artifacts are unsigned and must not be described as Gatekeeper-ready.
- Intel macOS remains unverified. The lockfile contains an x64 canvas binary declaration, but the release matrix currently certifies only a native `macos-arm64` job and will fail rather than silently relabel another host.

Until those checks pass, macOS remains a prerelease structural target—not a supported or release-certified runtime.

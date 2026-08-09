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

Inside a restricted automation sandbox, old optional DMG dependencies may invoke `node-gyp` and try to cache Node headers below `~/Library/Caches`, which can make npm silently omit `appdmg`. Keep the same lockfile and redirect only the build cache to a writable temporary directory:

```sh
npm_config_devdir="${TMPDIR%/}/aidraw-node-gyp" npm ci --cache .npm-cache
npm ls appdmg fs-xattr
```

Do not interpret a successful `npm ci` alone as proof that the optional DMG dependency was retained. A normal unrestricted terminal does not need this sandbox-specific redirect.

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

The completed development bundle is signed again after Packager changes its name and `Info.plist`. With no release identity, this is an ad-hoc integrity signature with stable designated requirement `identifier "com.electron.aidraw"`; `scripts/verify-package.mjs` fails unless strict deep verification and that requirement both pass. `AIDRAW_MACOS_SIGN_IDENTITY` selects a Developer ID identity, but the repository does not yet establish or certify the complete hardened-runtime, entitlements, notarization, and stapling policy. DMG creation and mounting use `hdiutil` and must run outside a restricted filesystem sandbox.

## Current Apple Silicon gate matrix

This matrix combines local implementer evidence gathered on 2026-08-09 from `codex/macos-compatibility` at source base `526703a12a082ea27c089d85ed82400bff94d3b0` with the final independent Luna/high Level 2 certificate. The strict PASS report is retained locally under ignored evidence path `test-results/luna-high/20260809T154905Z-macos-level2/report.md` (not as a source-controlled artifact), SHA-256 `fa75d06855d80f77249312c43741172116bc688040290f5ab767f0e846aa0783`, against launcher `8E1523B89F592FC77F85513E4AC21854E3F01E4BC87485CA1EAD9E7DEF201BDE` and ASAR `1B2C8E402F7226BFB6205429CFC4F20F1B0331E23E306EBD0E349D53CA28909D`. Forge excludes project documentation from package inputs; the certified ASAR's project-owned roots are `.vite` and `package.json`, alongside explicit runtime dependency roots under `node_modules`. Therefore this tracked evidence reference does not change the certified bytes. Any material source/package change still requires new exact-artifact evidence.

| Gate | Required evidence | Current evidence | Result / remaining work |
| --- | --- | --- | --- |
| Locked setup and implementation | Node 24, lockfile-controlled install, native optional dependencies present, portability/typecheck/lint/full tests green | Shared Node `v24.14.0`; `npm ci` retained `appdmg@0.6.6` and `fs-xattr@0.3.1`; the only deliberate lock change is compatible `nanoid` 3.3.16 → 3.3.18; the current full gate passed 359 tracked + 5 prospective implementation paths, 111 files / 615 tests, TypeScript, and ESLint | **Local pass.** A fresh hosted runner is still required. |
| Native raster dependency | Load and execute the host-native binding; verify packaged architecture | Native canvas created a canvas on `darwin/arm64`; packaged `skia.darwin-arm64.node`, launcher, and Electron Framework are Mach-O ARM64 | **Local pass on Apple Silicon.** Intel remains untested. |
| Electron package security | Verify the exact app, ASAR, fuses, renderer isolation, preload allowlist, utility containment, native modules, and absence of build-only advisory roots | `scripts/verify-package.mjs` passed for the 53,056-byte launcher SHA-256 `8E1523B89F592FC77F85513E4AC21854E3F01E4BC87485CA1EAD9E7DEF201BDE` and 36,863,031-byte ASAR SHA-256 `1B2C8E402F7226BFB6205429CFC4F20F1B0331E23E306EBD0E349D53CA28909D`; independent Level 2 used this exact identity and confirmed the arm64 ad-hoc deep signature | **Level 2 pass for this artifact.** Developer ID/notarization and exhaustive Level 3 release security remain pending. |
| Dependency advisories | Triage runtime reachability and compatible upgrades; reject breaking forced fixes | Compatible `nanoid` 3.3.18 is locked. Runtime audit has only the two-record moderate MCP→Hono static-serving chain, whose middleware AIDraw does not use. The full tree has 34 records (4 low / 2 moderate / 27 high / 1 critical) in the documented Forge/rebuild/prompt/DMG chains; package verification proves those build-only roots absent from the ASAR | **Local pass at the runtime high/critical release threshold; documented partial overall.** Await compatible upstream Forge/MCP/maker releases and re-audit registry changes. |
| DMG, ZIP, checksum, licenses, and isolated install | Build both makers; verify disk image, embedded/copied app, manifests, launch/quit/removal | Forge remade both distributables with `--skip-package` from the exact Level 2-tested app: 139,653,666-byte DMG SHA-256 `3DDDF85D1CC304D031B32B1D62A9B4BD8D8F8FF5FBA82FA88BB03F65FB98DEAC`; 139,812,412-byte ZIP SHA-256 `7598FE281A64155C1B5ED50F02959719BA10ECB814F5EAA05CB71E68D41ED38D`; checksum-manifest SHA-256 `A8A9457B6C973BE099B84BDB304A12048F363953E64E295C7243F46C0E7DF4F3`. `hdiutil verify` passed, and an isolated read-only mount contained the exact launcher/ASAR hashes above with a valid deep signature. The earlier isolated copy/headless launch/graceful quit/test-Trash/detach workflow passed on this host. | **Local pass with exact final payload identity.** A genuinely clean machine and hosted release artifacts remain pending. |
| Bundle identity and signing | Stable bundle ID and designated requirement; intentional release signing and Gatekeeper policy | Bundle ID and requirement are `com.electron.aidraw`; strict deep verification passes with an ad-hoc signature. Local build/copies had no quarantine attribute; an explicitly quarantined isolated copy was rejected by `spctl`, and `syspolicy_check distribution` reported ad-hoc signing plus a missing notarization ticket | **Partial.** Developer ID, hardened-runtime/entitlement review, notarization, stapling, and Gatekeeper acceptance are not earned. |
| Keychain / secret store | `safeStorage` availability, encrypted-at-rest token, restrictive file mode, restart and rebuilt-app access, refusal when unavailable/locked | The final package wrote 51 bytes of `electron-safe-storage` ciphertext with mode `0600`. After graceful stop/restart of the identical artifact/profile, both token fingerprint `FF220267…6295` and encrypted-file SHA-256 `15CB42F0…A54E` were unchanged and health returned without UI approval | **Partial.** Reusing an older profile after a new ad-hoc rebuild produced no connection within the bounded 20-second launch wait—an inference consistent with the old Keychain ACL requiring UI approval; the audit did not hang or approve it. Developer-ID cross-build migration plus locked/unavailable refusal remain. |
| Headless engine and lifecycle | Headless start, authenticated health, attach/detach editor, restart recovery, explicit quit, no survivor | The final artifact and DMG-copied app each returned authenticated headless health with `uiRequired:false`, exact process identity, graceful credential-redacted quit, and no recorded survivor. The remediation probe started PIDs 67074 then 67141 against one isolated profile, obtained `okay:true` identity before both phases, and stopped each with signal exit 0, no force, and credential redaction. The independent Level 2 same-profile restart and final stop also passed with zero survivors and redacted credentials. | **Level 2 pass.** Real login-start suppression and clean-machine lifecycle remain external release gates. |
| Workspace identity and restart state | One exact active document across tab/title/canvas/canonical MCP/advisory; no cross-tab transient; ordered tabs and real per-document dirty/file state survive graceful restart | Run `20260809T134216Z-macos-level2` remains immutable **FAIL** history. After remediation, focused coverage passes 5 files / 52 tests and the exact packaged case passes inside the 27-case suite. Final independent run `20260809T154905Z-macos-level2` strictly passed: native UI and two actors agreed on exact eight-document order, three dirty/five clean state, saved target path/object, active/advisory identity, human pixel undo/redo, same- and cross-kind preview cancellation with zero locks, blank revision-0 original with no QA bleed, and same-profile restart. | **Independent Level 2 pass for the remediated exact package.** Level 3 stress/release coverage remains. |
| Authenticated MCP | Loopback bearer authentication, discovery, transactions, approvals, privacy, cancellation, redaction | Final packaged MCP initialized headless. Focused contract coverage passes 31/31, including canonical trust roots, symlink escape, failed-job structured output, and correct file-job cancellation semantics | **Local pass for exercised paths.** Exhaustive tool/action/limit coverage remains a formal gate. |
| Import and export | Native import/export through trusted and approval paths; supported-format fidelity and overwrite isolation | The final package imported a valid Unicode `/var/.../Café 導入/valid.svg` through a `/private/var` canonical trust root as a 160×120 illustration. Malformed and missing SVGs failed with structured non-retryable errors; a trusted-folder symlink to the repository stayed `waiting-for-user`, was cancelled, and created no document. Earlier final headless export produced an independently decoded 641×360 RGBA PNG, SHA-256 `A76240BE…1BBF3B` | **Local pass for this representative matrix.** The broader Level 2 interchange corpus remains. |
| Exact package/process identity | Executable path/hash, PID, profile command line, connection PID/URL, and health must agree before mutation | Unsandboxed macOS `lsof`/`ps` status returned `okay:true` for the final build-tree app, DMG-copied app, and independent Level 2 session, including exact executable, isolated `--user-data-dir`, SHA-256, PID, loopback URL, and health. The final report records zero exact survivors and zero AIDraw mounts. | **Independent Level 2 harness pass for the final hash.** Hosted and Level 3 repetition remain. |
| Packaged Level 2 automation | Host-native package/ASAR discovery, unsandboxed user-session launch, isolated profiles, DevTools and headless attach, platform shortcuts, graceful quit/redaction, clean-vs-retained selection | The exact unsandboxed `node scripts/npm-node24.mjs run test:level2:auto` exited 0 in the final independent task: portability 359 tracked + 5 prospective paths, TypeScript, full ESLint, 111/111 Vitest files / 615/615 tests, package verification, and 27/27 self-contained Playwright cases. The strengthened restart case passed against launcher `8E1523B8…1BDE` / ASAR `1B2C8E40…909D`; ten immutable retained cases remained explicit-only. | **Independent Level 2 pass for the exact artifact.** Level 3 and hosted release matrices remain. |
| Human → agent and agent → human | Computer Use and isolated MCP must each make one change observed through the other surface in the exact app | In final independent run `20260809T154905Z-macos-level2`, an MCP-authored gold rectangle was visibly confirmed in the exact native window. Native pixel input at `(16,15)`, Undo, and Redo were observed identically by two authenticated actors; active/advisory identity and canonical canvas state also agreed across tab switches and restart. | **Independent Level 2 bidirectional pass.** Broader Level 3 interaction/accessibility coverage remains. |
| Login item | Native enable/disable, actual login launch, suppression behavior, and restored initial state | Computer Use toggled `Start at login` on and off and restored disabled | **Partial.** A real login/reboot launch and suppression check remains. |
| Performance | Apply the documented budget and diagnose native/heap contributors without weakening it | The unchanged run reproduced 1,378.50 MiB. Stage sampling showed native canvas growth while heap stayed below 60 MiB. Bounded scratch/tile reuse and release of completed scenario outputs produced five passing fresh runs; the final M4/16 GiB run measured 744.58 MiB, with all timings below budget | **Local automated pass under the existing 1,200 MiB budget.** Packaged pointer/frame pacing, display scaling, tablet, and long-session evidence remain formal gates. |
| Formal fresh-task QA | Independent Luna/high Levels 1–3, exact final artifact, authenticated MCP, native Computer Use, bidirectional assertions, retained report | The first Level 2 attempt retains a 0/37 pre-product runner failure and the second retains a product **FAIL**. The final independent report `20260809T154905Z-macos-level2/report.md`, SHA-256 `fa75d068…0783`, is strict **PASS** against the exact five artifact hashes; automation, two-actor MCP, native Computer Use, restart, cleanup, and checkout/index/stash preservation all passed. | **Level 2 complete for this immutable Apple Silicon subject.** Level 3 remains release-blocking. |
| Hosted/native matrix | macOS ARM64 CI/release job and retained artifacts; explicit Intel policy | Workflow definitions exist; local ARM64 evidence above exists | **Pending / release blocking.** No hosted run and no Intel hardware result. |

For a formal isolated native session, create all paths below one ignored `test-results/` run root and launch outside the filesystem sandbox:

```sh
node scripts/qa-session.mjs start \
  --exe "$PWD/out/AIDraw-darwin-arm64/AIDraw.app/Contents/MacOS/AIDraw" \
  --profile "$PWD/test-results/<run-id>/profile" \
  --connection "$PWD/test-results/<run-id>/connection.json" \
  --manifest "$PWD/test-results/<run-id>/session.json" \
  --mode interactive \
  --launch-context unsandboxed-gui
node scripts/qa-session.mjs status --manifest "$PWD/test-results/<run-id>/session.json"
```

## Evidence still required on macOS

- Repeat the locally passing `npm ci`, source, native canvas, package verification, DMG/ZIP, checksum, and license gates on a clean hosted native runner.
- Electron `safeStorage` refusal when Keychain is locked/unavailable, a Developer-ID-signed cross-build credential migration, and an explicitly user-approved migration of any retained legacy ad-hoc ACL.
- Repeat the locally passing isolated copy/first-launch/headless/quit/removal path on a genuinely clean machine; add single-instance attach, login-start suppression, and editor-reopen evidence on the exact candidate.
- Run a fresh independent Level 3 release-exhaustive task against the exact release candidate. Keep all earlier Level 2 failure reports and the final PASS immutable; run the ten manifest-routed retained checkpoint cases only with their explicitly supplied profiles and exact executable/ASAR declarations.
- Repeat the locally passing hardened-fuse, sandbox/context-isolation, CSP, permission/window/navigation, utility-containment, preload, MCP loopback/privacy, approval, and credential-redaction checks in the hosted and Level 3 release matrices.
- Broaden the passing Level 2 native-dialog, menu/shortcut, Unicode/import, pointer, and Computer Use evidence at Level 3 to cover more formats, case behavior, display scaling, keyboard layouts, and tablet input.
- A deliberate Developer ID signing, hardened-runtime, entitlements, notarization, and stapling policy. Current artifacts are ad-hoc signed for local integrity and must not be described as Gatekeeper-ready.
- Intel macOS remains unverified. The lockfile contains an x64 canvas binary declaration, but the release matrix currently certifies only a native `macos-arm64` job and will fail rather than silently relabel another host.

Until the partial and pending gates above pass, macOS remains a prerelease native target—not a supported or release-certified runtime.

# AIDraw release checklist

This checklist complements `FEATURE_TRACKER.md`; it cannot override a missing or partial release gate.

## Prerelease

- [ ] Choose a SemVer prerelease version and add its dated changelog section.
- [ ] Run `node scripts/npm-node24.mjs run check:portability` and `node scripts/npm-node24.mjs run verify` on Windows, macOS, and Linux native runners.
- [ ] Run the packaged Level 2 automated regression matrix.
- [ ] Record known limitations and ensure README claims match the tracker.
- [ ] Build Squirrel/DMG/DEB/RPM/ZIP artifacts on their native OS runners; generate per-platform SHA-256 and license reports.
- [ ] Verify no credentials, MCP tokens, user profiles, QA artifacts, or personal artwork are staged.

## Stable v1 gate

- [ ] Every P0 is Verified and every selected-v1 P1 has met its documented exit criteria.
- [ ] Utility-process, corrupt-input, provider-mock, performance, accessibility, and complete packaged E2E gates pass.
- [ ] Level 3 independent Luna/high automated + MCP + Computer Use QA passes on the exact checksummed build.
- [ ] Install/uninstall/archive behavior passes on clean Windows 11, macOS, and supported Linux VM profiles.
- [ ] macOS package evidence proves the native canvas binary, Keychain-backed `safeStorage`, hardened fuses, login-item lifecycle, DMG/ZIP contents, and graceful credential cleanup on the exact architecture.
- [ ] Developer ID signing, hardened-runtime entitlements, notarization, and stapling are either independently verified or the ad-hoc/unsigned Gatekeeper limitation is explicit in every release artifact and note.
- [ ] Reproducibility/dependency/license review is complete.
- [ ] Repository baseline, owner, remote, CI evidence, signing status, and publication credentials are confirmed.
- [ ] Replace prerelease metadata with `1.0.0`, finalize the changelog, tag, and publish only after all prior boxes pass.

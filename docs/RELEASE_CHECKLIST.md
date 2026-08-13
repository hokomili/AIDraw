# AIDraw release checklist

This checklist complements `FEATURE_TRACKER.md`; it cannot override a missing or partial release gate.

## Prerelease

- [ ] Choose a SemVer prerelease version and add its dated changelog section.
- [ ] Run `node scripts/npm-node24.mjs run check:portability` and `node scripts/npm-node24.mjs run verify` on Windows, macOS, and Linux native runners.
- [ ] Run the packaged Level 2 automated regression matrix.
- [ ] Record known limitations and ensure README claims match the tracker.
- [ ] Build Squirrel/DMG/DEB/RPM/ZIP artifacts on their native OS runners; generate per-platform SHA-256 and license reports.
- [ ] Require package verification to find the exact `LiberationSans-OFL-1.1.txt` resource in every native app layout, and require the generated license inventory to agree with its four bundled font hashes and complete OFL notice.
- [ ] Retain each native job's `RELEASE_PROVENANCE-<platform>.json`; it must bind a clean commit and exact source/toolchain/checksum/artifact inventory.
- [ ] Verify no credentials, MCP tokens, user profiles, QA artifacts, or personal artwork are staged.
- [ ] Run `node scripts/npm-node24.mjs run rc:audit`; treat its ranked output as planning evidence only, not as a release certificate.
- [ ] After fresh independent Level 3 evidence exists, fill an ignored copy of `docs/testing/RC_EVIDENCE_TEMPLATE.json` and require `node scripts/npm-node24.mjs run rc:verify -- --evidence=test-results/luna-high/<run-id>/rc-evidence.json` to pass on the exact clean candidate.

## Stable v1 gate

- [ ] Every P0 is Verified and every selected-v1 P1 has met its documented exit criteria.
- [ ] Utility-process, corrupt-input, provider-mock, performance, accessibility, and complete packaged E2E gates pass.
- [ ] Level 3 independent Luna/high automated + MCP + Computer Use QA passes on the exact checksummed build.
- [ ] Install/uninstall/archive behavior passes on clean Windows 11, macOS, and supported Linux VM profiles.
- [ ] macOS package evidence proves the native canvas binary, Keychain-backed `safeStorage`, hardened fuses, login-item lifecycle, DMG/ZIP contents, and graceful credential cleanup on the exact architecture.
- [ ] Developer ID signing, hardened-runtime entitlements, notarization, and stapling are either independently verified or the ad-hoc/unsigned Gatekeeper limitation is explicit in every release artifact and note.
- [ ] Rebuild each Windows x64, macOS arm64, and Linux x64 artifact set independently; require `node scripts/npm-node24.mjs run reproducibility:compare -- --left=<first-provenance.json> --right=<second-provenance.json> --output=<comparison.json>` to produce a hashed PASS report, or stop for an explicitly reviewed deterministic exception rather than normalizing a mismatch.
- [ ] Dependency/license review is complete and agrees with the compared lockfile and retained license reports.
- [ ] Repository baseline, owner, remote, CI evidence, signing status, and publication credentials are confirmed.
- [ ] Require the same evidence manifest to pass `node scripts/npm-node24.mjs run rc:verify -- --evidence=test-results/luna-high/<run-id>/rc-evidence.json --stable-v1`; this machine check supplements rather than replaces independent evidence review.
- [ ] Replace prerelease metadata with `1.0.0`, finalize the changelog, tag, and publish only after all prior boxes pass.

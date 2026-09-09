# RC1 preparation — September 9, 2026

RC1 remains untagged. The user authorized continuing through fixes, native builds and independent acceptance until tagging is justified. This record preserves failed candidates and the reason for each correction; it is not a release certificate. Evidence lives in ignored `test-results/rc1-20260909/`.

## First candidate

Clean commit `be21ddaa688122e7c049c4eba79d3499146dc926` updates version metadata to `0.1.0-rc.1`, patches all observed dependency advisories, and enables native candidate builds on `codex/rc1` before a tag. The publishing job is restricted to tag events. Mac source verification passes 242 files / 1,765 tests; both audits report zero vulnerabilities, with 639 registry signatures and 140 attestations verified.

Its single-use `package-review-r1/` Mac generation builds DMG and ZIP and passes strict package verification, source-input binding, Electron version, bundled license and ad-hoc signature checks. Independent `hdiutil verify` also passes. The archive is `d9d27c57922342e999709b57a9bbe3148266ea8a560685bd40c1533d5bc9f91e`, 43,673,496 bytes. Its complete extracted main and worker exactly match the independently reviewed September 6 pair; no admission change was made. Checksums, licenses and schema-2 provenance are retained with the generation. This does not transfer the older package's native acceptance.

The [first native matrix](https://github.com/hokomili/AIDraw/actions/runs/34325354703) fails before release: Linux has two differing rendering goldens; Windows also exposes path/ACL-launch issues and related MCP failures; hosted Mac regional-render performance is 687.57 ms against the unchanged 500 ms budget. All logs are retained. No failed result was treated as an artifact or acceptance PASS.

## Exact native rendering references

Diagnostic commit `fe05e6995fdc190d12cb97df4e5045749281710a` retains PNG, raw RGBA and dimensions/hash metadata for all ten maintained goldens without changing expected results. [Its native run](https://github.com/hokomili/AIDraw/actions/runs/34325950993) produces Windows x64 artifact `10093892627` and Linux x64 artifact `10093815982`. Downloads and extracted bytes are retained in `goldens-windows-first*` and `goldens-linux-first*`; `goldens-local-r1/` contains the Mac comparison.

The Windows and Linux bytes are identical. Direct visual inspection of both affected image pairs preserves geometry, dash placement, line breaks and regular/bold/italic/bold-italic text. Raw comparison in `native-golden-comparison-r1.json` shows:

| Fixture | Changed pixels / total | Maximum alpha difference | Maximum premultiplied RGB difference |
| --- | --- | --- | --- |
| Dashed strokes | 227 / 3,840 | 1 / 255 | 1.255 / 255 |
| Missing-font text | 1,079 / 17,280 | 0 / 255 | 1.883 / 255 |

This is a native raster/rounding difference, not changed text coverage or geometry. Transparent unpremultiplied RGB can differ greatly while contributing no visible color, so that maximum alone is not a visual metric. Reference hashes remain exact, with explicit Apple Silicon and Windows/Linux native variants, consistent with the existing natural-brush variant:

| Fixture | macOS arm64 RGBA SHA-256 | Windows/Linux x64 RGBA SHA-256 |
| --- | --- | --- |
| Dashed strokes | `28318fc1cc7f7442de0d63d098ca7d7f2579dad6363c07c925304638c32db284` | `3701162bbee48591e8a5e98673e86725fa6ca26e91a087890f586c03d128a4c2` |
| Missing-font text | `09e38eae27a70c6787e2a4efe5f0a71f5a164868db054dbb9415b3ae9762dce8` | `63733c8fb10444bc63c521125eda96b2aa6077c43367597d8a10557d214dae7f` |

## Corrections under native verification

- Package-output resolution now uses the native synchronous realpath implementation, matching asynchronous canonicalization and expanding Windows 8.3 aliases consistently. Strict containment, reparse/symlink refusal and single-use generation behavior remain enforced. Existing canonical-path, replacement and concurrency tests exercise the corrected boundary.
- The Windows ACL helper invokes its script block explicitly through UTF-16LE `-EncodedCommand`, with separately quoted literal arguments. The former trailing `-Command` arguments became script source instead of `$args`. [Microsoft's PowerShell CLI contract](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1) documents this distinction. Unit checks preserve every volume/ancestor/leaf validation; a native Windows test exercises spaces, apostrophes, Unicode and PowerShell-shaped text in a real disposable directory name.
- Export-companion path and command-inventory tests now express native filesystem separators and normalized report labels respectively; exported companion names and actual authorization policy are unchanged.
- Regional eligibility and rendering avoid allocating an empty child array per non-group object, and reserve recursive cycle bookkeeping for groups. Missing-object/cycle rejection and exact render eligibility remain covered. The local 100,000-object case improves from 181.69 to 100.00 ms; the hosted 500 ms budget is unchanged and still requires fresh native verification. Product-source changes require a fresh complete emitted-pair review before admission.

## Remaining release gates

Independent cumulative Level 3 automated, public MCP, real native Computer Use and cross-surface evidence must bind the final clean candidate. Windows 11 clean installer/portable acceptance requires a verified environment; hosted Windows Server builds do not satisfy it. Native matrix, fresh package/source bindings, artifact hashes, warnings and RC evidence must all pass. Signing remains ad-hoc/unsigned; trusted signing/notarization, independent reproducibility and stable-v1 claims remain separate requirements. Preserve the September 6/8 consumer pins and all recovery stashes.

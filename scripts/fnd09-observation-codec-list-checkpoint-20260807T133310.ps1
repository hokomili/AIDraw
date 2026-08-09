param([switch]$SelfTestOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = 'E:\AIDraw'
$outName = 'out-fnd09-observation-codec-20260807T130830'
$packageRoot = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830'
$exe = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830\AIDraw-win32-x64\AIDraw.exe'
$asar = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830\AIDraw-win32-x64\resources\app.asar'
$profile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-observation-codec-20260807T130830'
$output = 'E:\AIDraw\test-results\playwright-fnd09-observation-codec-20260807T130830'
$agt14Root = 'E:\AIDraw\test-results\retained\aidraw-agt14-opencode-discovery-20260806T040500'
$failedGuard = 'E:\AIDraw\scripts\fnd09-observation-codec-package-checkpoint-20260807T130830.ps1'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$protectedExecutable = 'E:\AIDraw\out-fnd09-utility-pressure-20260806T123215\AIDraw-win32-x64\AIDraw.exe'

$expectedSourceFiles = 271
$expectedSourceBytes = 3373386
$expectedSourceSha256 = '7744647FEF3B16EBE84FC9766FD1AF83DFDE3D263C62AFAD23FFFAD6B70F2762'
$expectedExeBytes = [long]225614336
$expectedExeSha256 = 'A1FB98E3BB482367F17D011B83005F1410180BBD270E0A78329C7FA05CF1E1C5'
$expectedAsarBytes = [long]47571295
$expectedAsarSha256 = '530DF2761572F554F46B0C14BAB5B4455E19439CDC7D43E68B5CADEEBF932DC9'
$expectedProtectedExecutableSha256 = '0B10F6046267FDF3C981B7097A104439821C894A3DFDE900FCCDBF72D5C5BA65'
$scenarioTitle = 'FND-09-OBSERVATION-CODEC exact package rejects undecodable output and recovers queued observation work'

$expectedProtected = @(
  [pscustomobject]@{ ProcessId = 6996; ParentProcessId = 9672; CreationTicks = [long]639216312998769670 },
  [pscustomobject]@{ ProcessId = 7824; ParentProcessId = 6996; CreationTicks = [long]639216313031663290 },
  [pscustomobject]@{ ProcessId = 15556; ParentProcessId = 6996; CreationTicks = [long]639216313030098810 },
  [pscustomobject]@{ ProcessId = 23860; ParentProcessId = 6996; CreationTicks = [long]639216313030185700 }
)

$fixedFiles = @(
  [pscustomobject]@{ Path = $node; Bytes = [long]91380224; Hash = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\npm-node24.mjs'); Bytes = [long]2410; Hash = '60BDF46BE72278E25582EF08600F856DEBFB94B58026AF8FFEC483EB399157EF' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\@playwright\test\cli.js'); Bytes = [long]707; Hash = '79E23E6A249176295B8490567DAA7717448A75866D6EA6F6B296FF3D23305C69' },
  [pscustomobject]@{ Path = (Join-Path $repo 'tests\e2e\utility-containment.spec.ts'); Bytes = [long]37850; Hash = '019392882F69A8BC196061DB2387C52C2F3C6DAEA75AAC8F3BFD5E372DCF150C' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-observation-codec.mjs'); Bytes = [long]6943; Hash = 'F06EEB0F2F40F51BCF42E28010FA0E0BFE6D07F4637E2CE8257B374DE273DE89' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\verify-package.mjs'); Bytes = [long]6114; Hash = '77FFB182928385FA4D001B120680C5EBB6D47B166A48760447F715D470154A8E' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-e2e-boundary.mjs'); Bytes = [long]1123; Hash = 'B45D3C13A9630FAC28EBE0D652842DE820B91E3F3D68065DFD657BDC48721BC3' },
  [pscustomobject]@{ Path = (Join-Path $repo 'playwright.config.ts'); Bytes = [long]485; Hash = '2F87AB6775389B939877E7C9DA758CB8A44F602189EC167F8CCF8DE5120E821F' },
  [pscustomobject]@{ Path = $failedGuard; Bytes = [long]10442; Hash = '1FF43393DFC0C281F0E1493F9294CDB4B6A2F27C24C65A05CC18FB6887CFE9D5' },
  [pscustomobject]@{ Path = $exe; Bytes = $expectedExeBytes; Hash = $expectedExeSha256 },
  [pscustomobject]@{ Path = $asar; Bytes = $expectedAsarBytes; Hash = $expectedAsarSha256 }
)

function Assert-ExactPlaywrightListOutput([string]$Text) {
  $escapedTitle = [regex]::Escape($scenarioTitle)
  $declarationPattern = "(?m)^\s*(?:tests[\\/]e2e[\\/])?utility-containment\.spec\.ts:499:5\s+›\s+$escapedTitle\s*$"
  $declarations = [regex]::Matches($Text, $declarationPattern)
  if ($declarations.Count -ne 1) { throw 'List output must contain one exact observation-codec declaration at utility-containment.spec.ts:499:5.' }
  if ([regex]::Matches($Text, $escapedTitle).Count -ne 1) { throw 'List output repeats or omits the exact observation-codec title.' }
  $allDeclarations = [regex]::Matches($Text, '(?m)^\s*\S+\.spec\.ts:\d+:\d+\s+›\s+.+$')
  if ($allDeclarations.Count -ne 1) { throw 'List output contains an ambiguous additional test declaration.' }
  $totalLines = [regex]::Matches($Text, '(?m)^\s*Total:.*$')
  if ($totalLines.Count -ne 1 -or $totalLines[0].Value -notmatch '^\s*Total:\s+1 test in 1 file\s*$') {
    throw 'List output must contain exactly Total: 1 test in 1 file.'
  }
  return [pscustomobject]@{ Declaration = $declarations[0].Value.Trim(); Total = $totalLines[0].Value.Trim() }
}

function Invoke-ListParserSelfTest {
  $accepted = @(
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "tests/e2e/utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "tests\e2e\utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file"
  )
  foreach ($fixture in $accepted) { [void](Assert-ExactPlaywrightListOutput $fixture) }
  $rejected = @(
    "other.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "utility-containment.spec.ts:500:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "nested/utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nutility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nother.spec.ts:1:1 › another test`nTotal: 2 tests in 1 file",
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 2 tests in 1 file"
  )
  foreach ($fixture in $rejected) {
    $rejectedAsExpected = $false
    try { [void](Assert-ExactPlaywrightListOutput $fixture) }
    catch { $rejectedAsExpected = $true }
    if (!$rejectedAsExpected) { throw 'The observation-codec list parser accepted an ambiguous regression fixture.' }
  }
}

function Get-TextSha256([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) }
  finally { $algorithm.Dispose() }
  return ([BitConverter]::ToString($digest)).Replace('-', '')
}

function Get-SourceManifest {
  $extensions = @('.ts', '.tsx', '.mjs', '.mts', '.json', '.html')
  $files = @()
  foreach ($root in @('src', 'packages', 'tests', 'scripts')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $repo $root) -Recurse -File | Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() }
  }
  $files += @(
    'package.json', 'package-lock.json', 'forge.config.ts', 'playwright.config.ts', 'tsconfig.json',
    'vite.main.config.ts', 'vite.preload.config.ts', 'vite.renderer.config.ts', 'vitest.config.ts',
    'vitest.performance.config.ts', 'eslint.config.mjs', 'index.html'
  ) | ForEach-Object { Get-Item -LiteralPath (Join-Path $repo $_) }
  $files = @($files | Sort-Object FullName -Unique)
  $lines = @()
  $bytes = [long]0
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($repo.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $lines += "$relative`0$($file.Length)`0$hash"
    $bytes += $file.Length
  }
  return [pscustomobject]@{ Files = $files.Count; Bytes = $bytes; Sha256 = (Get-TextSha256 ($lines -join "`n")) }
}

function Assert-FixedFile($item) {
  if (!(Test-Path -LiteralPath $item.Path -PathType Leaf)) { throw "Frozen file is absent: $($item.Path)" }
  if ((Get-Item -LiteralPath $item.Path).Length -ne $item.Bytes) { throw "Frozen file size changed: $($item.Path)" }
  if ((Get-FileHash -LiteralPath $item.Path -Algorithm SHA256).Hash -ne $item.Hash) { throw "Frozen file hash changed: $($item.Path)" }
}

function Get-SubjectProcesses {
  return @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('AIDraw.exe', 'AIMuse.exe', 'opencode.exe') })
}

function Assert-ProcessBoundary($processes, [string]$phase) {
  if (@($processes | Where-Object { $_.ExecutablePath -eq $exe }).Count -ne 0) { throw "The observation-codec package is running during $phase." }
  if (@($processes | Where-Object { $_.Name -eq 'AIMuse.exe' }).Count -ne 0) { throw "AIMuse is present during $phase; stop without process control." }
  if (@($processes | Where-Object { $_.Name -eq 'opencode.exe' }).Count -ne 0) { throw "OpenCode is present during $phase; keep AGT-14 skipped and stop without process control." }
  $aidraw = @($processes | Where-Object { $_.Name -eq 'AIDraw.exe' })
  if ($aidraw.Count -ne $expectedProtected.Count) { throw "The protected AIDraw process count changed during $phase." }
  foreach ($expected in $expectedProtected) {
    $match = @($aidraw | Where-Object { $_.ProcessId -eq $expected.ProcessId })
    if ($match.Count -ne 1) { throw "Protected AIDraw PID $($expected.ProcessId) changed during $phase." }
    $actual = $match[0]
    if (!$actual.ExecutablePath -or $actual.ExecutablePath -ne $protectedExecutable) { throw "Protected AIDraw executable identity changed during $phase." }
    if ($actual.ParentProcessId -ne $expected.ParentProcessId) { throw "Protected AIDraw parent identity changed during $phase." }
    if (([DateTime]$actual.CreationDate).ToUniversalTime().Ticks -ne $expected.CreationTicks) { throw "Protected AIDraw creation identity changed during $phase." }
  }
}

Invoke-ListParserSelfTest
if ($SelfTestOnly) {
  Write-Output 'FND-09 observation-codec list parser self-test passed for basename and tests/e2e forms.'
  return
}

Set-Location -LiteralPath $repo
if (!(Test-Path -LiteralPath $packageRoot -PathType Container)) { throw 'The immutable observation-codec package root is absent.' }
foreach ($path in @($profile, $output)) {
  if (Test-Path -LiteralPath $path) { throw "Future run root is no longer fresh: $path" }
}
if (Test-Path -LiteralPath $agt14Root) { throw 'Skipped AGT-14 root must remain absent.' }
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed.' }
$manifestBefore = Get-SourceManifest
if ($manifestBefore.Files -ne $expectedSourceFiles -or $manifestBefore.Bytes -ne $expectedSourceBytes -or $manifestBefore.Sha256 -ne $expectedSourceSha256) {
  throw 'Frozen source/controller manifest changed before list-only audit.'
}
$baseline = Get-SubjectProcesses
Assert-ProcessBoundary $baseline 'preflight'

$env:OPENAI_API_KEY = ''
$env:STABILITY_API_KEY = ''
$env:COMFYUI_API_KEY = ''
$env:ANTHROPIC_API_KEY = ''
$env:AIDRAW_NODE24_EXE = $node
$env:AIDRAW_FORGE_OUT_DIR = $outName
$env:AIDRAW_E2E_LAUNCH_CONTEXT = 'unsandboxed-gui'
$env:AIDRAW_E2E_OUT_DIR = $outName
$env:AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE = $profile
$env:AIDRAW_E2E_FND09_OBSERVATION_CODEC_EXE_SHA256 = $expectedExeSha256
$env:AIDRAW_E2E_FND09_OBSERVATION_CODEC_ASAR_SHA256 = $expectedAsarSha256
$env:AIDRAW_E2E_ALLOW_FORCE_KILL = '0'
$env:npm_config_offline = 'true'
$env:HTTP_PROXY = 'http://127.0.0.1:9'
$env:HTTPS_PROXY = 'http://127.0.0.1:9'
$env:ALL_PROXY = 'http://127.0.0.1:9'
$env:NO_PROXY = '127.0.0.1,localhost'

& $node '.\scripts\verify-package.mjs'
if ($LASTEXITCODE -ne 0) { throw 'Static verification rejected the immutable observation-codec package.' }
$listLines = @(& $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --list --grep=FND-09-OBSERVATION-CODEC --output=$output --workers=1 --reporter=list 2>&1 | ForEach-Object { [string]$_ })
$listExit = $LASTEXITCODE
$listText = $listLines -join "`n"
if ($listExit -ne 0) { throw "Playwright list-only audit failed with exit code $listExit.`n$listText" }
$selection = Assert-ExactPlaywrightListOutput $listText
foreach ($path in @($profile, $output)) {
  if (Test-Path -LiteralPath $path) { throw "List-only audit created a future run root: $path" }
}
if (Test-Path -LiteralPath $agt14Root) { throw 'List-only audit changed the skipped AGT-14 boundary.' }

$manifestAfter = Get-SourceManifest
if ($manifestAfter.Files -ne $expectedSourceFiles -or $manifestAfter.Bytes -ne $expectedSourceBytes -or $manifestAfter.Sha256 -ne $expectedSourceSha256) {
  throw 'List-only audit changed the frozen source/controller manifest.'
}
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed during list-only audit.' }
$post = Get-SubjectProcesses
Assert-ProcessBoundary $post 'postflight'

[pscustomobject]@{
  Result = 'FND-09 observation codec immutable package/list-only checkpoint passed without native launch.'
  SourceFiles = $manifestAfter.Files
  SourceBytes = $manifestAfter.Bytes
  SourceSha256 = $manifestAfter.Sha256
  Executable = $exe
  ExecutableBytes = $expectedExeBytes
  ExecutableSha256 = $expectedExeSha256
  Asar = $asar
  AsarBytes = $expectedAsarBytes
  AsarSha256 = $expectedAsarSha256
  Declaration = $selection.Declaration
  Total = $selection.Total
  ProfileAbsent = !(Test-Path -LiteralPath $profile)
  OutputAbsent = !(Test-Path -LiteralPath $output)
  ProtectedProcessIds = @($expectedProtected | ForEach-Object { $_.ProcessId })
} | ConvertTo-Json -Depth 4

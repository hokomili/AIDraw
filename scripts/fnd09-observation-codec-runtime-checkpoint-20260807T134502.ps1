param([switch]$SelfTestOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = 'E:\AIDraw'
$outName = 'out-fnd09-observation-codec-20260807T130830'
$packageRoot = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830'
$exe = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830\AIDraw-win32-x64\AIDraw.exe'
$asar = 'E:\AIDraw\out-fnd09-observation-codec-20260807T130830\AIDraw-win32-x64\resources\app.asar'
$profile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-observation-codec-native-20260807T134502'
$output = 'E:\AIDraw\test-results\playwright-fnd09-observation-codec-native-20260807T134502'
$connectionPath = Join-Path $profile 'mcp-connection.json'
$probePath = Join-Path $profile 'fnd09-observation-codec-probe.json'
$evidencePath = Join-Path $profile 'fnd09-observation-codec-evidence.json'
$tokenPath = Join-Path $profile 'credentials\mcp-token.json'
$lastRunPath = Join-Path $output '.last-run.json'
$sentinels = @(
  (Join-Path $profile 'trusted-folders.json'),
  (Join-Path $profile 'credentials\generation.json'),
  (Join-Path $profile 'fnd09-observation-codec-forbidden-network.json')
)
$listProfile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-observation-codec-20260807T130830'
$listOutput = 'E:\AIDraw\test-results\playwright-fnd09-observation-codec-20260807T130830'
$agt14Root = 'E:\AIDraw\test-results\retained\aidraw-agt14-opencode-discovery-20260806T040500'
$failedGuard = 'E:\AIDraw\scripts\fnd09-observation-codec-package-checkpoint-20260807T130830.ps1'
$listGuard = 'E:\AIDraw\scripts\fnd09-observation-codec-list-checkpoint-20260807T133310.ps1'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$protectedExecutable = 'E:\AIDraw\out-fnd09-utility-pressure-20260806T123215\AIDraw-win32-x64\AIDraw.exe'
$scenarioTitle = 'FND-09-OBSERVATION-CODEC exact package rejects undecodable output and recovers queued observation work'

$expectedSourceFiles = 271
$expectedSourceBytes = [long]3374177
$expectedSourceSha256 = 'DD7EDAE0FB14A457CA2C92159DDBD070506D4E53C68F0694753407CD4497C912'
$expectedExeBytes = [long]225614336
$expectedExeSha256 = 'A1FB98E3BB482367F17D011B83005F1410180BBD270E0A78329C7FA05CF1E1C5'
$expectedAsarBytes = [long]47571295
$expectedAsarSha256 = '530DF2761572F554F46B0C14BAB5B4455E19439CDC7D43E68B5CADEEBF932DC9'
$expectedProtectedExecutableSha256 = '0B10F6046267FDF3C981B7097A104439821C894A3DFDE900FCCDBF72D5C5BA65'

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
  [pscustomobject]@{ Path = (Join-Path $repo 'tests\e2e\utility-containment.spec.ts'); Bytes = [long]38020; Hash = '2555565C52D4B01E71F8FABF71729728CF0B896237A3586547E4DDBE456D3015' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-observation-codec.mjs'); Bytes = [long]7372; Hash = '726151A8B0581C0705F4BB529E0588A2FAAF727709C3989E8B015475FA0EF57C' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-observation-codec.d.mts'); Bytes = [long]630; Hash = '38D69B135470A9863E631E490E3E4EE4BF46BE668FE956398AC9686994EEC655' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\verify-package.mjs'); Bytes = [long]6114; Hash = '77FFB182928385FA4D001B120680C5EBB6D47B166A48760447F715D470154A8E' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-e2e-boundary.mjs'); Bytes = [long]1123; Hash = 'B45D3C13A9630FAC28EBE0D652842DE820B91E3F3D68065DFD657BDC48721BC3' },
  [pscustomobject]@{ Path = (Join-Path $repo 'playwright.config.ts'); Bytes = [long]485; Hash = '2F87AB6775389B939877E7C9DA758CB8A44F602189EC167F8CCF8DE5120E821F' },
  [pscustomobject]@{ Path = $failedGuard; Bytes = [long]10442; Hash = '1FF43393DFC0C281F0E1493F9294CDB4B6A2F27C24C65A05CC18FB6887CFE9D5' },
  [pscustomobject]@{ Path = $listGuard; Bytes = [long]13653; Hash = 'C819EF68A43B23D9055382F42CAD1944CA060D6CAA7C8C74CED4CCA913D56F27' },
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

function Assert-ExactPlaywrightRunOutput([string]$Text) {
  $escapedTitle = [regex]::Escape($scenarioTitle)
  $selectionPattern = "(?:tests[\\/]e2e[\\/])?utility-containment\.spec\.ts:499:5\s+›\s+$escapedTitle"
  if ([regex]::Matches($Text, $selectionPattern).Count -ne 1) { throw 'Runtime output must contain exactly one exact observation-codec test selection.' }
  if ([regex]::Matches($Text, $escapedTitle).Count -ne 1) { throw 'Runtime output repeats or omits the exact observation-codec title.' }
  $passed = [regex]::Matches($Text, '(?m)^\s*1 passed(?:\s+\([^)]+\))?\s*$')
  if ($passed.Count -ne 1) { throw 'Runtime output must report exactly 1 passed.' }
  if ($Text -match '(?mi)^\s*\d+\s+(?:failed|skipped|flaky)') { throw 'Runtime output contains a non-pass summary.' }
  return [pscustomobject]@{ Selection = [regex]::Match($Text, $selectionPattern).Value; Summary = $passed[0].Value.Trim() }
}

function Invoke-ParserSelfTest {
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
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nother.spec.ts:1:1 › another test`nTotal: 2 tests in 1 file",
    "utility-containment.spec.ts:499:5 › $scenarioTitle`nTotal: 2 tests in 1 file"
  )
  foreach ($fixture in $rejected) {
    $rejectedAsExpected = $false
    try { [void](Assert-ExactPlaywrightListOutput $fixture) }
    catch { $rejectedAsExpected = $true }
    if (!$rejectedAsExpected) { throw 'The runtime list parser accepted an ambiguous regression fixture.' }
  }
  [void](Assert-ExactPlaywrightRunOutput "Running 1 test using 1 worker`n  ok 1 utility-containment.spec.ts:499:5 › $scenarioTitle (4.1s)`n`n  1 passed (4.8s)")
  $runRejected = $false
  try { [void](Assert-ExactPlaywrightRunOutput "utility-containment.spec.ts:499:5 › $scenarioTitle`n1 failed (4.8s)") }
  catch { $runRejected = $true }
  if (!$runRejected) { throw 'The runtime output parser accepted a failed scenario.' }
}

function Assert-GuardNoForce([string]$Path) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw "Runtime guard has $($errors.Count) PowerShell parse error(s)." }
  $forbiddenCommands = @('Stop-Process', 'taskkill', 'taskkill.exe', 'tskill', 'kill', 'Remove-Item', 'Clear-Content', 'Start-Process')
  $commands = $ast.FindAll({ param($nodeAst) $nodeAst -is [System.Management.Automation.Language.CommandAst] }, $true)
  foreach ($command in $commands) {
    $name = $command.GetCommandName()
    if ($name -and $forbiddenCommands -contains $name) { throw "Runtime guard contains forbidden command $name." }
  }
  $forbiddenMembers = @('Kill', 'Terminate', 'CloseMainWindow')
  $members = $ast.FindAll({ param($nodeAst) $nodeAst -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)
  foreach ($member in $members) {
    $memberName = $member.Member.Extent.Text.Trim([char[]]@([char]39, [char]34))
    if ($forbiddenMembers -contains $memberName) { throw "Runtime guard contains forbidden process-control member $memberName." }
  }
  return [pscustomobject]@{ ParseErrors = 0; ForbiddenCommands = 0; ForbiddenMembers = 0 }
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
  $runOwned = @($processes | Where-Object { $_.ExecutablePath -eq $exe })
  if ($runOwned.Count -ne 0) {
    $survivors = @($runOwned | Sort-Object ProcessId | ForEach-Object { [string]$_.ProcessId }) -join ','
    throw "Exact observation-codec package process exists during $phase (PIDs $survivors); retain all run evidence and do not control it."
  }
  if (@($processes | Where-Object { $_.Name -eq 'AIMuse.exe' }).Count -ne 0) { throw "AIMuse is present during $phase; stop without process control." }
  if (@($processes | Where-Object { $_.Name -eq 'opencode.exe' }).Count -ne 0) { throw "OpenCode is present during $phase; keep AGT-14 skipped and stop without process control." }
  $aidraw = @($processes | Where-Object { $_.Name -eq 'AIDraw.exe' })
  if ($aidraw.Count -ne $expectedProtected.Count) { throw "The protected AIDraw process count changed during $phase; retain evidence and stop without control." }
  foreach ($expected in $expectedProtected) {
    $match = @($aidraw | Where-Object { $_.ProcessId -eq $expected.ProcessId })
    if ($match.Count -ne 1) { throw "Protected AIDraw PID $($expected.ProcessId) changed during $phase." }
    $actual = $match[0]
    if (!$actual.ExecutablePath -or $actual.ExecutablePath -ne $protectedExecutable) { throw "Protected AIDraw executable identity changed during $phase." }
    if ($actual.ParentProcessId -ne $expected.ParentProcessId) { throw "Protected AIDraw parent identity changed during $phase." }
    if (([DateTime]$actual.CreationDate).ToUniversalTime().Ticks -ne $expected.CreationTicks) { throw "Protected AIDraw creation identity changed during $phase." }
  }
}

function Assert-SourceManifest([string]$phase) {
  $manifest = Get-SourceManifest
  if ($manifest.Files -ne $expectedSourceFiles -or $manifest.Bytes -ne $expectedSourceBytes -or $manifest.Sha256 -ne $expectedSourceSha256) {
    throw "Frozen runtime source/controller manifest changed during $phase."
  }
  return $manifest
}

function Assert-SanitizedRetainedText([string]$label, [string]$text) {
  if ($text -match '(?i)Bearer|Authorization|"token"\s*:|"data"\s*:') { throw "$label contains credential or private image payload material." }
}

Invoke-ParserSelfTest
$guardAudit = Assert-GuardNoForce $PSCommandPath
if ($SelfTestOnly) {
  [pscustomobject]@{
    Result = 'FND-09 observation-codec runtime guard parser/no-force self-test passed.'
    Ast = $guardAudit
    PlaywrightTimeoutDisabled = $true
    NoNativeLaunch = $true
  } | ConvertTo-Json -Depth 4
  return
}

Set-Location -LiteralPath $repo
if (!(Test-Path -LiteralPath $packageRoot -PathType Container)) { throw 'The immutable observation-codec package root is absent.' }
foreach ($path in @($profile, $output, $listProfile, $listOutput, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "A required fresh/skipped root is no longer absent: $path" }
}
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed before runtime audit.' }
$manifestBefore = Assert-SourceManifest 'preflight'
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
$env:NO_COLOR = '1'

$verifyLines = @(& $node '.\scripts\verify-package.mjs' 2>&1 | ForEach-Object { [string]$_ })
if ($LASTEXITCODE -ne 0) { throw "Static verification rejected the immutable observation-codec package.`n$($verifyLines -join "`n")" }
$verify = ($verifyLines -join "`n") | ConvertFrom-Json
if ($verify.verified -ne $true -or $verify.executableSha256 -ne $expectedExeSha256 -or $verify.appAsarSha256 -ne $expectedAsarSha256) { throw 'Static package identity verification returned contradictory evidence.' }
if ($verify.packagedUtilityObservationCodec.isolatedMainHook -ne $true -or $verify.packagedUtilityObservationCodec.realUtilityCorruption -ne $true -or $verify.packagedUtilityObservationCodec.fullDecodeBoundary -ne $true -or $verify.packagedUtilityObservationCodec.preloadPrivate -ne $true -or $verify.packagedUtilityObservationCodec.rendererPrivate -ne $true) { throw 'Static observation-codec package markers failed.' }
if ($verify.packagedSecurity.preload.genericIpcAbsent -ne $true -or $verify.packagedSecurity.browserWindow.sandbox -ne $true -or $verify.packagedSecurity.browserWindow.contextIsolation -ne $true) { throw 'Static package-security boundary failed.' }

$observerAuditLines = @(& $node '.\scripts\packaged-utility-observation-codec.mjs' '.\tests\e2e\utility-containment.spec.ts' 2>&1 | ForEach-Object { [string]$_ })
if ($LASTEXITCODE -ne 0) { throw "External observation-codec observer no-force audit failed.`n$($observerAuditLines -join "`n")" }
$observerAudit = ($observerAuditLines -join "`n") | ConvertFrom-Json
if ($observerAudit.observerSha256 -ne '2555565C52D4B01E71F8FABF71729728CF0B896237A3586547E4DDBE456D3015' -or $observerAudit.contract.onePackageLaunch -ne $true -or $observerAudit.contract.playwrightWatchdogDisabled -ne $true -or $observerAudit.contract.gracefulTimeoutRejectsWithoutControl -ne $true -or $observerAudit.contract.toolDiscoveryPrivate -ne $true -or $observerAudit.contract.corruptPayloadPrivate -ne $true) { throw 'External observer contract returned contradictory no-force/privacy evidence.' }

$listLines = @(& $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --list --grep=FND-09-OBSERVATION-CODEC --output=$output --workers=1 --reporter=list 2>&1 | ForEach-Object { [string]$_ })
$listExit = $LASTEXITCODE
$listText = $listLines -join "`n"
if ($listExit -ne 0) { throw "Playwright list-only preflight failed with exit code $listExit.`n$listText" }
$selection = Assert-ExactPlaywrightListOutput $listText
foreach ($path in @($profile, $output, $listProfile, $listOutput, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "List-only preflight changed a fresh/skipped root: $path" }
}
Assert-ProcessBoundary (Get-SubjectProcesses) 'post-list preflight'

$runLines = @(& $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --grep=FND-09-OBSERVATION-CODEC --output=$output --workers=1 --reporter=list 2>&1 | ForEach-Object { [string]$_ })
$testExit = $LASTEXITCODE
$runText = $runLines -join "`n"

$post = Get-SubjectProcesses
Assert-ProcessBoundary $post 'runtime postflight'
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed during runtime audit.' }
$manifestAfter = Assert-SourceManifest 'postflight'
foreach ($path in @($listProfile, $listOutput, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "Runtime audit changed a preserved/skipped root: $path" }
}
foreach ($required in @($profile, $output, $connectionPath, $probePath, $evidencePath, $tokenPath, $lastRunPath)) {
  if (!(Test-Path -LiteralPath $required)) { throw "Required retained runtime artifact is absent: $required" }
}
foreach ($sentinel in $sentinels) {
  if (Test-Path -LiteralPath $sentinel) { throw "Forbidden trust/provider/network sentinel exists: $sentinel" }
}

$connectionRaw = Get-Content -LiteralPath $connectionPath -Raw
$probeRaw = Get-Content -LiteralPath $probePath -Raw
$evidenceRaw = Get-Content -LiteralPath $evidencePath -Raw
$tokenRaw = Get-Content -LiteralPath $tokenPath -Raw
Assert-SanitizedRetainedText 'Retained connection' $connectionRaw
Assert-SanitizedRetainedText 'Retained probe' $probeRaw
Assert-SanitizedRetainedText 'Retained evidence' $evidenceRaw
if ($tokenRaw -match '(?i)Bearer|Authorization|"token"\s*:') { throw 'Safe-storage credential file exposes plaintext credential markers.' }

$connection = $connectionRaw | ConvertFrom-Json
$probe = $probeRaw | ConvertFrom-Json
$evidence = $evidenceRaw | ConvertFrom-Json
$token = $tokenRaw | ConvertFrom-Json
$lastRun = Get-Content -LiteralPath $lastRunPath -Raw | ConvertFrom-Json

if ($connection.credentialStatus -ne 'redacted-after-graceful-stop') { throw 'Connection was not redacted after graceful stop.' }
$connectionUrl = [Uri]$connection.url
if ($connectionUrl.Scheme -ne 'http' -or $connectionUrl.Host -ne '127.0.0.1' -or $connectionUrl.AbsolutePath -ne '/mcp' -or @($connection.trustedFolders).Count -ne 0) { throw 'Retained connection is not the exact loopback/no-trust shape.' }
if ((@($token.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'encryption,value,version' -or $token.encryption -ne 'electron-safe-storage' -or !($token.value -is [string]) -or !$token.value) { throw 'MCP credential is not the expected encrypted safe-storage shape.' }
if ($lastRun.status -ne 'passed' -or @($lastRun.failedTests).Count -ne 0) { throw 'Playwright retained result is not one clean pass.' }

if ($probe.version -ne 1 -or $probe.scenario -ne 'FND-09 packaged observation codec result containment' -or $probe.result -ne 'passed') { throw 'Observation-codec probe identity/result failed.' }
if ($probe.canonical.unchanged -ne $true -or $probe.canonical.before.documentId -ne $probe.canonical.after.documentId -or $probe.canonical.before.revision -ne $probe.canonical.after.revision -or $probe.canonical.before.sha256 -ne $probe.canonical.after.sha256 -or $probe.canonical.before.sha256 -cnotmatch '^[A-F0-9]{64}$') { throw 'Canonical invariance evidence failed.' }
if ($probe.corrupt.error.message -ne 'Raster utility returned an undecodable observation image.' -or $probe.corrupt.crcValidStaticEnvelopeReachedFullDecode -ne $true -or $probe.corrupt.resultReturnedToCaller -ne $false -or $probe.corrupt.payloadRetained -ne $false -or [long]$probe.corrupt.workerPid -le 0) { throw 'Corrupt observation rejection/privacy evidence failed.' }
if ($probe.recovery.workerReplaced -ne $true -or $probe.recovery.queued -ne $true -or $probe.recovery.fixedCorruptResponseHoldMs -ne 150 -or [long]$probe.recovery.workerPid -le 0 -or $probe.recovery.workerPid -eq $probe.corrupt.workerPid) { throw 'Fresh-worker queued recovery evidence failed.' }
if ($probe.recovery.observation.available -ne $true -or $probe.recovery.observation.mimeType -ne 'image/png' -or $probe.recovery.observation.width -ne 8 -or $probe.recovery.observation.height -ne 6 -or $probe.recovery.observation.scale -ne 1 -or $probe.recovery.observation.bytes -le 0 -or $probe.recovery.observation.sha256 -cnotmatch '^[A-F0-9]{64}$') { throw 'Recovered observation identity failed.' }
if ($probe.generationLaneUntouched -ne $true -or $probe.privacy.rendererCreated -ne $false -or $probe.privacy.corruptPayloadPublished -ne $false -or $probe.privacy.publicJobCreated -ne $false) { throw 'Generation-lane or private-surface probe evidence failed.' }
if ($probe.network.nonLoopbackRequests -ne 0 -or $probe.network.externalProviderRequests -ne 0 -or $probe.network.paidRequests -ne 0) { throw 'Probe network/provider/paid boundary failed.' }

if ($evidence.result -ne 'passed' -or $evidence.scenario -ne $scenarioTitle) { throw 'Sanitized runtime evidence result/identity failed.' }
if ($evidence.package.executable -ne $exe -or $evidence.package.executableBytes -ne $expectedExeBytes -or $evidence.package.executableSha256 -ne $expectedExeSha256 -or $evidence.package.asar -ne $asar -or $evidence.package.asarBytes -ne $expectedAsarBytes -or $evidence.package.asarSha256 -ne $expectedAsarSha256) { throw 'Sanitized runtime package identity failed.' }
if ($evidence.launch.mode -ne 'headless' -or $evidence.launch.rendererCreated -ne $false -or $evidence.launch.connectionPidMatched -ne $true -or $evidence.launch.loopbackMcpOnly -ne $true -or @($evidence.launch.trustedFolders).Count -ne 0) { throw 'Headless/loopback launch evidence failed.' }
if ($evidence.actor.name -ne 'FND-09 observation codec observer' -or $evidence.actor.color -ne '#386d91') { throw 'Authenticated actor evidence failed.' }
if ($evidence.observationCodec.result -ne 'passed' -or $evidence.observationCodec.canonical.before.sha256 -ne $probe.canonical.before.sha256 -or $evidence.observationCodec.corrupt.workerPid -ne $probe.corrupt.workerPid -or $evidence.observationCodec.recovery.workerPid -ne $probe.recovery.workerPid -or $evidence.observationCodec.recovery.observation.sha256 -ne $probe.recovery.observation.sha256) { throw 'Sanitized evidence does not embed the exact probe result.' }
if ($evidence.authenticatedMcp.documentId -ne $probe.canonical.before.documentId -or $evidence.authenticatedMcp.revision -ne $probe.canonical.before.revision -or $evidence.authenticatedMcp.canonicalMatchedProbe -ne $true -or $evidence.authenticatedMcp.recoveryPngMatchedProbe -ne $true -or @($evidence.authenticatedMcp.publicJobs).Count -ne 0) { throw 'Authenticated MCP/canonical/privacy evidence failed.' }
if ($evidence.privacy.hookAbsentFromToolsList -ne $true -or $evidence.privacy.corruptUtilityPayloadNotPublished -ne $true -or $evidence.privacy.publicJobSummariesEmpty -ne $true) { throw 'Public tool/job privacy evidence failed.' }
if ($evidence.network.nonLoopbackRequests -ne 0 -or $evidence.network.externalProviderRequests -ne 0 -or $evidence.network.paidRequests -ne 0) { throw 'Runtime network/provider/paid evidence failed.' }
if ($evidence.sentinels.trustAbsent -ne $true -or $evidence.sentinels.providerCredentialsAbsent -ne $true -or $evidence.sentinels.forbiddenNetworkAbsent -ne $true) { throw 'Runtime sentinel evidence failed.' }
if ($evidence.cleanup.gracefulOnly -ne $true -or $evidence.cleanup.exitCode -ne 0 -or $evidence.cleanup.credentialStatus -ne 'redacted-after-graceful-stop') { throw 'Graceful-only credential-redacted cleanup evidence failed.' }

if ($testExit -ne 0) { throw "Exact observation-codec test failed with exit code $testExit; retain every artifact and do not control any process.`n$runText" }
$runSelection = Assert-ExactPlaywrightRunOutput $runText

[pscustomobject]@{
  Result = 'FND-09 observation-codec exact packaged runtime acceptance passed.'
  SourceFiles = $manifestAfter.Files
  SourceBytes = $manifestAfter.Bytes
  SourceSha256 = $manifestAfter.Sha256
  Executable = $exe
  ExecutableBytes = $expectedExeBytes
  ExecutableSha256 = $expectedExeSha256
  Asar = $asar
  AsarBytes = $expectedAsarBytes
  AsarSha256 = $expectedAsarSha256
  ListDeclaration = $selection.Declaration
  RuntimeSelection = $runSelection.Selection
  RuntimeSummary = $runSelection.Summary
  Profile = $profile
  Output = $output
  CorruptWorkerPid = $probe.corrupt.workerPid
  RecoveryWorkerPid = $probe.recovery.workerPid
  CanonicalUnchanged = $probe.canonical.unchanged
  GenerationLaneUntouched = $probe.generationLaneUntouched
  PublicJobs = @($evidence.authenticatedMcp.publicJobs).Count
  NonLoopbackRequests = $evidence.network.nonLoopbackRequests
  ProviderRequests = $evidence.network.externalProviderRequests
  PaidRequests = $evidence.network.paidRequests
  GracefulExitCode = $evidence.cleanup.exitCode
  CredentialStatus = $evidence.cleanup.credentialStatus
  ProtectedProcessIds = @($expectedProtected | ForEach-Object { $_.ProcessId })
} | ConvertTo-Json -Depth 5

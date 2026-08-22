param([switch]$SelfTestOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'This exact package/list guard requires Windows PowerShell 5.1.'
}

$repo = 'E:\AIDraw'
$outName = 'out-fnd09-export-result-20260807T154601'
$packageRoot = 'E:\AIDraw\out-fnd09-export-result-20260807T154601'
$exe = 'E:\AIDraw\out-fnd09-export-result-20260807T154601\AIDraw-win32-x64\AIDraw.exe'
$asar = 'E:\AIDraw\out-fnd09-export-result-20260807T154601\AIDraw-win32-x64\resources\app.asar'
$profile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-export-result-20260807T154601'
$output = 'E:\AIDraw\test-results\playwright-fnd09-export-result-20260807T154601'
$agt14Root = 'E:\AIDraw\test-results\retained\aidraw-agt14-opencode-discovery-20260806T040500'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$electronZipDirectory = 'E:\AIDraw\.electron-cache\9c4e224684594fb9a8cbda18d3e2b7bf0c3c023d1462402a4031f8b4cc25e621'
$electronZip = Join-Path $electronZipDirectory 'electron-v43.2.0-win32-x64.zip'
$protectedExecutable = 'E:\AIDraw\out-fnd09-utility-pressure-20260806T123215\AIDraw-win32-x64\AIDraw.exe'
$observerPath = Join-Path $repo 'tests\e2e\utility-containment.spec.ts'
$observerChecker = Join-Path $repo 'scripts\packaged-utility-export-result.mjs'
$scenarioTitle = 'FND-09-EXPORT-RESULT exact package rejects invalid artifact envelopes and recovers queued export work'
$scenarioLine = 931

$expectedSourceFiles = 283
$expectedSourceBytes = [long]3488952
$expectedSourceSha256 = '6251F84CA821DE1BD28C51113285C434EEECF1B82935CBDCE9451D70D4C7B0A5'
$expectedObserverBytes = [long]63645
$expectedObserverSha256 = '195239783CF0925E1529FFF5BD36652CF63C1E710CE50D47ED228F094A742FCA'
$expectedProtectedExecutableSha256 = '0B10F6046267FDF3C981B7097A104439821C894A3DFDE900FCCDBF72D5C5BA65'
$expectedProtected = @(
  [pscustomobject]@{ ProcessId = 6996; ParentProcessId = 9672; CreationTicks = [long]639216312998769670 },
  [pscustomobject]@{ ProcessId = 7824; ParentProcessId = 6996; CreationTicks = [long]639216313031663290 },
  [pscustomobject]@{ ProcessId = 15556; ParentProcessId = 6996; CreationTicks = [long]639216313030098810 },
  [pscustomobject]@{ ProcessId = 23860; ParentProcessId = 6996; CreationTicks = [long]639216313030185700 }
)

$immutableTrees = @(
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-observation-codec-native-20260807T134502'; Directories = 18; Files = 26; Bytes = [long]90015; Hash = 'D88AC6EB1497F51FD5C820C9B8E7790D1A57280671BE006236429AC8326D9E90' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-observation-codec-native-20260807T134502'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-observation-codec-colorfix-20260807T140828'; Directories = 18; Files = 26; Bytes = [long]90020; Hash = '0CD6D98398D0B913EE211721B6EAEE843FF47B88726C50F7283FB32D4563D167' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-observation-codec-colorfix-20260807T140828'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-quantization-result-native-20260807T152000'; Directories = 18; Files = 26; Bytes = [long]90709; Hash = 'FF6223E47EEA6A6C18A813D1C751B1109C31E70D11FB643367CD0A3C2DE4994D' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-quantization-result-native-20260807T152000'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' }
)

$fixedFiles = @(
  [pscustomobject]@{ Path = $node; Bytes = [long]91380224; Hash = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\npm-node24.mjs'); Bytes = [long]2410; Hash = '60BDF46BE72278E25582EF08600F856DEBFB94B58026AF8FFEC483EB399157EF' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\@playwright\test\cli.js'); Bytes = [long]707; Hash = '79E23E6A249176295B8490567DAA7717448A75866D6EA6F6B296FF3D23305C69' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\@electron-forge\cli\dist\electron-forge.js'); Bytes = [long]5152; Hash = '13560964D8ADD71C5A79AB170DE86F7D83076BBCDD874781FEE5C67191DE4253' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\electron\package.json'); Bytes = [long]744; Hash = '02D60DD9473E05F9E5C3D23D3397E24C77CF283F086BB20BE283E4536AAF1923' },
  [pscustomobject]@{ Path = $electronZip; Bytes = [long]144326439; Hash = 'EBA5F5088AF40ECB364FE258809C79A5234C6ECE5A75C64722772EBA01B02786' },
  [pscustomobject]@{ Path = $observerPath; Bytes = $expectedObserverBytes; Hash = $expectedObserverSha256 },
  [pscustomobject]@{ Path = $observerChecker; Bytes = [long]7443; Hash = 'C101076DD5860BD2093C34E2DF34BE0CE6DB2039ACABA8D515E113A35AB79F6B' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-export-result.d.mts'); Bytes = [long]784; Hash = '791C111C9947012CAB1D5462DA2FC671F118961E2454E0A0A7045DBAAC2AD5E1' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\verify-package.mjs'); Bytes = [long]6766; Hash = '7C5789DA7160D9AAECE0B1442092B6445DBE7282B96F78FC5A229B5ECF71D5CF' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-e2e-boundary.mjs'); Bytes = [long]1123; Hash = 'B45D3C13A9630FAC28EBE0D652842DE820B91E3F3D68065DFD657BDC48721BC3' },
  [pscustomobject]@{ Path = (Join-Path $repo 'playwright.config.ts'); Bytes = [long]485; Hash = '2F87AB6775389B939877E7C9DA758CB8A44F602189EC167F8CCF8DE5120E821F' }
)

function Get-TextSha256([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) }
  finally { $algorithm.Dispose() }
  return ([BitConverter]::ToString($digest)).Replace('-', '')
}

function Assert-ExactPlaywrightListOutput([string]$Text) {
  $escapedTitle = [regex]::Escape($scenarioTitle)
  $declarationPattern = "(?m)^\s*(?:tests[\\/]e2e[\\/])?utility-containment\.spec\.ts:$scenarioLine`:5\s+›\s+$escapedTitle\s*$"
  $declarations = [regex]::Matches($Text, $declarationPattern)
  if ($declarations.Count -ne 1) { throw "List output must contain one exact export-result declaration at utility-containment.spec.ts:$scenarioLine`:5." }
  if ([regex]::Matches($Text, $escapedTitle).Count -ne 1) { throw 'List output repeats or omits the exact export-result title.' }
  $allDeclarations = [regex]::Matches($Text, '(?m)^\s*(?:\S+[\\/])*\S+\.spec\.ts:\d+:\d+\s+›\s+.+$')
  if ($allDeclarations.Count -ne 1) { throw 'List output contains an ambiguous additional test declaration.' }
  $totalLines = [regex]::Matches($Text, '(?m)^\s*Total:.*$')
  if ($totalLines.Count -ne 1 -or $totalLines[0].Value -notmatch '^\s*Total:\s+1 test in 1 file\s*$') {
    throw 'List output must contain exactly Total: 1 test in 1 file.'
  }
  return [pscustomobject]@{ Declaration = $declarations[0].Value.Trim(); Total = $totalLines[0].Value.Trim() }
}

function Invoke-ParserSelfTest {
  $accepted = @(
    "utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "tests/e2e/utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "tests\e2e\utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 1 test in 1 file"
  )
  foreach ($fixture in $accepted) { [void](Assert-ExactPlaywrightListOutput $fixture) }
  $rejected = @(
    "other.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "utility-containment.spec.ts:$($scenarioLine + 1):5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "nested/utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 1 test in 1 file",
    "utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nother.spec.ts:1:1 › another test`nTotal: 2 tests in 1 file",
    "utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`nTotal: 2 tests in 1 file"
  )
  foreach ($fixture in $rejected) {
    $rejectedAsExpected = $false
    try { [void](Assert-ExactPlaywrightListOutput $fixture) }
    catch { $rejectedAsExpected = $true }
    if (!$rejectedAsExpected) { throw 'The export-result list parser accepted an ambiguous regression fixture.' }
  }
}

function Set-DeterministicColorEnvironment {
  [Environment]::SetEnvironmentVariable('FORCE_COLOR', $null, 'Process')
  [Environment]::SetEnvironmentVariable('NO_COLOR', '1', 'Process')
  if ([Environment]::GetEnvironmentVariable('FORCE_COLOR', 'Process') -ne $null) { throw 'FORCE_COLOR must be absent.' }
  if ([Environment]::GetEnvironmentVariable('NO_COLOR', 'Process') -ne '1') { throw 'NO_COLOR must equal 1.' }
}

function Invoke-NativeCapture([scriptblock]$Command) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Command 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines; Text = ($lines -join "`n") }
}

function ConvertFrom-CapturedJson($Capture, [string]$Label) {
  $start = $Capture.Text.IndexOf('{')
  $end = $Capture.Text.LastIndexOf('}')
  if ($start -lt 0 -or $end -lt $start) { throw "$Label did not contain one JSON object." }
  return $Capture.Text.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

function Invoke-EnvironmentSelfTest {
  $originalForceColor = [Environment]::GetEnvironmentVariable('FORCE_COLOR', 'Process')
  $originalNoColor = [Environment]::GetEnvironmentVariable('NO_COLOR', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('FORCE_COLOR', '3', 'Process')
    [Environment]::SetEnvironmentVariable('NO_COLOR', '1', 'Process')
    Set-DeterministicColorEnvironment
    $ok = Invoke-NativeCapture { & $node -e "process.stderr.write('benign-color-warning\n'); process.stdout.write('ok\n')" }
    if ($ok.ExitCode -ne 0 -or $ok.Text -notmatch 'benign-color-warning' -or $ok.Text -notmatch '(?m)^ok$') { throw 'Benign native stderr capture self-test failed.' }
    $failed = Invoke-NativeCapture { & $node -e "process.stderr.write('expected-failure\n'); process.exit(7)" }
    if ($failed.ExitCode -ne 7 -or $failed.Text -notmatch 'expected-failure') { throw 'Native nonzero-exit capture self-test failed.' }
    return [pscustomobject]@{ ForceColorRemoved = $true; NoColorFixed = $true; BenignStderrExitCode = $ok.ExitCode; NonzeroExitPreserved = $failed.ExitCode }
  } finally {
    [Environment]::SetEnvironmentVariable('FORCE_COLOR', $originalForceColor, 'Process')
    [Environment]::SetEnvironmentVariable('NO_COLOR', $originalNoColor, 'Process')
  }
}

function Assert-GuardNoForce([string]$Path) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw "Package guard has $($errors.Count) PowerShell parse error(s)." }
  $forbiddenCommands = @('Stop-Process', 'taskkill', 'taskkill.exe', 'tskill', 'kill', 'Remove-Item', 'Clear-Content', 'Start-Process')
  $commands = $ast.FindAll({ param($nodeAst) $nodeAst -is [System.Management.Automation.Language.CommandAst] }, $true)
  foreach ($command in $commands) {
    $name = $command.GetCommandName()
    if ($name -and $forbiddenCommands -contains $name) { throw "Package guard contains forbidden command $name." }
  }
  $forbiddenMembers = @('Kill', 'Terminate', 'CloseMainWindow')
  $members = $ast.FindAll({ param($nodeAst) $nodeAst -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)
  foreach ($member in $members) {
    $memberName = $member.Member.Extent.Text.Trim([char[]]@([char]39, [char]34))
    if ($forbiddenMembers -contains $memberName) { throw "Package guard contains forbidden process-control member $memberName." }
  }
  return [pscustomobject]@{ ParseErrors = 0; ForbiddenCommands = 0; ForbiddenMembers = 0 }
}

function Get-TreeIdentity([string]$Root) {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { throw "Retained immutable root is absent: $Root" }
  $directories = @(Get-ChildItem -LiteralPath $Root -Recurse -Directory | Sort-Object FullName)
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName)
  $lines = @()
  [long]$bytes = 0
  foreach ($directory in $directories) {
    $relative = $directory.FullName.Substring($Root.Length + 1).Replace('\', '/')
    $lines += "D`0$relative"
  }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Root.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $lines += "F`0$relative`0$($file.Length)`0$hash"
    $bytes += $file.Length
  }
  return [pscustomobject]@{ Directories = $directories.Count; Files = $files.Count; Bytes = $bytes; Sha256 = (Get-TextSha256 ($lines -join "`n")) }
}

function Assert-TreeIdentity($Expected, [string]$Phase) {
  $identity = Get-TreeIdentity $Expected.Path
  if ($identity.Directories -ne $Expected.Directories -or $identity.Files -ne $Expected.Files -or $identity.Bytes -ne $Expected.Bytes -or $identity.Sha256 -ne $Expected.Hash) {
    throw "Immutable retained root changed during $Phase`: $($Expected.Path)"
  }
  return $identity
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
  [long]$bytes = 0
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($repo.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $lines += "$relative`0$($file.Length)`0$hash"
    $bytes += $file.Length
  }
  return [pscustomobject]@{ Files = $files.Count; Bytes = $bytes; Sha256 = (Get-TextSha256 ($lines -join "`n")) }
}

function Assert-SourceManifest([string]$Phase) {
  $manifest = Get-SourceManifest
  if ($manifest.Files -ne $expectedSourceFiles -or $manifest.Bytes -ne $expectedSourceBytes -or $manifest.Sha256 -ne $expectedSourceSha256) {
    throw "Frozen source/controller manifest changed during $Phase."
  }
  return $manifest
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
  if (@($processes | Where-Object { $_.ExecutablePath -eq $exe }).Count -ne 0) { throw "The new export-result package is running during $phase; stop without process control." }
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

Invoke-ParserSelfTest
$guardAudit = Assert-GuardNoForce $PSCommandPath
$environmentAudit = Invoke-EnvironmentSelfTest
if ($SelfTestOnly) {
  [pscustomobject]@{
    Result = 'FND-09 export-result package/list guard parser, no-force, color and stderr self-test passed.'
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    Ast = $guardAudit
    Environment = $environmentAudit
    ExactStaticSelector = "utility-containment.spec.ts:$scenarioLine`:5"
    NoCim = $true
    NoPackage = $true
    NoPlaywright = $true
    NoNativeLaunch = $true
  } | ConvertTo-Json -Depth 5
  return
}

Set-Location -LiteralPath $repo
foreach ($path in @($packageRoot, $profile, $output)) {
  if (Test-Path -LiteralPath $path) { throw "Fresh checkpoint path already exists: $path" }
}
if (Test-Path -LiteralPath $agt14Root) { throw 'Skipped AGT-14 root must remain absent.' }
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed.' }
$manifestBefore = Assert-SourceManifest 'preflight'
$immutableBefore = @($immutableTrees | ForEach-Object { Assert-TreeIdentity $_ 'preflight' })
$baseline = Get-SubjectProcesses
Assert-ProcessBoundary $baseline 'preflight'

$env:ANTHROPIC_API_KEY = ''
$env:AIDRAW_NODE24_EXE = $node
$env:AIDRAW_FORGE_OUT_DIR = $outName
$env:AIDRAW_ELECTRON_ZIP_DIR = $electronZipDirectory
$env:npm_config_offline = 'true'
$env:HTTP_PROXY = 'http://127.0.0.1:9'
$env:HTTPS_PROXY = 'http://127.0.0.1:9'
$env:ALL_PROXY = 'http://127.0.0.1:9'
$env:NO_PROXY = '127.0.0.1,localhost'
Set-DeterministicColorEnvironment

$packageResult = Invoke-NativeCapture { & $node '.\scripts\npm-node24.mjs' run package }
if ($packageResult.ExitCode -ne 0) { throw "Offline package checkpoint failed with exit code $($packageResult.ExitCode); retain the new root.`n$($packageResult.Text)" }
if (!(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'Package outputs are incomplete; retain the package root.' }

$verifyResult = Invoke-NativeCapture { & $node '.\scripts\verify-package.mjs' }
if ($verifyResult.ExitCode -ne 0) { throw "Static verification rejected the new package; retain it as failed evidence.`n$($verifyResult.Text)" }
$verify = ConvertFrom-CapturedJson $verifyResult 'Static package verifier'
if ($verify.verified -ne $true -or $verify.packagedUtilityExportResult.isolatedMainHook -ne $true -or $verify.packagedUtilityExportResult.realUtilityFaultAfterExport -ne $true -or $verify.packagedUtilityExportResult.serializedEnvelopeGateBeforeDecode -ne $true -or $verify.packagedUtilityExportResult.queuedFreshWorkerRecovery -ne $true -or $verify.packagedUtilityExportResult.preloadPrivate -ne $true -or $verify.packagedUtilityExportResult.rendererPrivate -ne $true) {
  throw 'Static export-result package markers failed.'
}
if ($verify.packagedSecurity.preload.genericIpcAbsent -ne $true -or $verify.packagedSecurity.browserWindow.sandbox -ne $true -or $verify.packagedSecurity.browserWindow.contextIsolation -ne $true) { throw 'Static package-security boundary failed.' }

$observerResult = Invoke-NativeCapture { & $node '.\scripts\packaged-utility-export-result.mjs' '.\tests\e2e\utility-containment.spec.ts' }
if ($observerResult.ExitCode -ne 0) { throw "External export-result observer audit failed.`n$($observerResult.Text)" }
$observer = ConvertFrom-CapturedJson $observerResult 'External export-result observer audit'
if ($observer.observerSha256 -ne $expectedObserverSha256 -or $observer.contract.onePackageLaunch -ne $true -or $observer.contract.playwrightWatchdogDisabled -ne $true -or $observer.contract.gracefulTimeoutRejectsWithoutControl -ne $true -or $observer.contract.toolDiscoveryPrivate -ne $true -or $observer.contract.invalidPayloadPrivate -ne $true -or $observer.contract.zeroExportTargets -ne $true) {
  throw 'External observer contract returned contradictory no-force/privacy/filesystem evidence.'
}

$exeItem = Get-Item -LiteralPath $exe
$asarItem = Get-Item -LiteralPath $asar
$exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$asarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
$env:AIDRAW_E2E_LAUNCH_CONTEXT = 'unsandboxed-gui'
$env:AIDRAW_E2E_OUT_DIR = $outName
$env:AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE = $profile
$env:AIDRAW_E2E_FND09_EXPORT_RESULT_EXE_SHA256 = $exeSha256
$env:AIDRAW_E2E_FND09_EXPORT_RESULT_ASAR_SHA256 = $asarSha256
$listResult = Invoke-NativeCapture { & $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --list --grep=FND-09-EXPORT-RESULT --output=$output --workers=1 --reporter=list }
if ($listResult.ExitCode -ne 0) { throw "Playwright list-only audit failed with exit code $($listResult.ExitCode).`n$($listResult.Text)" }
$selection = Assert-ExactPlaywrightListOutput $listResult.Text
foreach ($path in @($profile, $output, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "List-only audit changed a fresh/skipped root: $path" }
}

$manifestAfter = Assert-SourceManifest 'postflight'
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed during package/list audit.' }
$immutableAfter = @($immutableTrees | ForEach-Object { Assert-TreeIdentity $_ 'postflight' })
$post = Get-SubjectProcesses
Assert-ProcessBoundary $post 'postflight'

[pscustomobject]@{
  Result = 'FND-09 export-result package/static/list checkpoint passed without native application launch.'
  SourceFiles = $manifestAfter.Files
  SourceBytes = $manifestAfter.Bytes
  SourceSha256 = $manifestAfter.Sha256
  PackageRoot = $packageRoot
  Executable = $exe
  ExecutableBytes = $exeItem.Length
  ExecutableSha256 = $exeSha256
  Asar = $asar
  AsarBytes = $asarItem.Length
  AsarSha256 = $asarSha256
  Observer = $observerPath
  ObserverSha256 = $observer.observerSha256
  Selector = 'FND-09-EXPORT-RESULT'
  ListDeclaration = $selection.Declaration
  ProfileAbsent = !(Test-Path -LiteralPath $profile)
  OutputAbsent = !(Test-Path -LiteralPath $output)
  SkippedAgt14Absent = !(Test-Path -LiteralPath $agt14Root)
  ImmutableEvidenceTrees = @($immutableAfter | ForEach-Object { $_.Sha256 })
  ProtectedProcessIds = @($expectedProtected | ForEach-Object { $_.ProcessId })
  PackageProcessCount = 0
  NativeApplicationLaunched = $false
} | ConvertTo-Json -Depth 6

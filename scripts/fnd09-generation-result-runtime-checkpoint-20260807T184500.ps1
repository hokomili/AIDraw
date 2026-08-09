param([switch]$SelfTestOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'This exact runtime guard requires Windows PowerShell 5.1.'
}

$repo = 'E:\AIDraw'
$outName = 'out-fnd09-generation-result-20260807T180500'
$packageRoot = 'E:\AIDraw\out-fnd09-generation-result-20260807T180500'
$exe = 'E:\AIDraw\out-fnd09-generation-result-20260807T180500\AIDraw-win32-x64\AIDraw.exe'
$asar = 'E:\AIDraw\out-fnd09-generation-result-20260807T180500\AIDraw-win32-x64\resources\app.asar'
$profile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-generation-result-native-20260807T184500'
$output = 'E:\AIDraw\test-results\playwright-fnd09-generation-result-native-20260807T184500'
$connectionPath = Join-Path $profile 'mcp-connection.json'
$probePath = Join-Path $profile 'fnd09-generation-result-probe.json'
$evidencePath = Join-Path $profile 'fnd09-generation-result-evidence.json'
$tokenPath = Join-Path $profile 'credentials\mcp-token.json'
$lastRunPath = Join-Path $output '.last-run.json'
$sentinels = @(
  (Join-Path $profile 'trusted-folders.json'),
  (Join-Path $profile 'credentials\generation.json'),
  (Join-Path $profile 'fnd09-generation-result-forbidden-network.json')
)
$packageListProfile = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-generation-result-20260807T180500'
$packageListOutput = 'E:\AIDraw\test-results\playwright-fnd09-generation-result-20260807T180500'
$agt14Root = 'E:\AIDraw\test-results\retained\aidraw-agt14-opencode-discovery-20260806T040500'
$packageGuard = 'E:\AIDraw\scripts\fnd09-generation-result-package-checkpoint-20260807T180500.ps1'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$electronZip = 'E:\AIDraw\.electron-cache\9c4e224684594fb9a8cbda18d3e2b7bf0c3c023d1462402a4031f8b4cc25e621\electron-v43.2.0-win32-x64.zip'
$protectedExecutable = 'E:\AIDraw\out-fnd09-utility-pressure-20260806T123215\AIDraw-win32-x64\AIDraw.exe'
$scenarioTitle = 'FND-09-GENERATION-RESULT exact package rejects invalid generated output and recovers queued generation work'
$scenarioLine = 1423

$expectedSourceFiles = 295
$expectedSourceBytes = [long]3600834
$expectedSourceSha256 = '7F411C91900EA6E3D2B24C24C8A191CEC094540627D55760110732ED87A3AB16'
$expectedExeBytes = [long]225614336
$expectedExeSha256 = '13AF1B6A701E7DB231399D19714B3F112D6ACF0B84D908ED582CA75C8FDC1637'
$expectedAsarBytes = [long]47718300
$expectedAsarSha256 = '82B01525F2DCE96868603E7B11E70E1F8AFB7C5974FC131EC2440E169A4A6F9E'
$expectedObserverBytes = [long]91725
$expectedObserverSha256 = '32B7A8FF220269AA7D32F68F1FF0FEC5E7D94FBF8BC653A002CD424BCF6EDCB0'
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
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-quantization-result-native-20260807T152000'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-export-result-native-20260807T161800'; Directories = 18; Files = 26; Bytes = [long]92431; Hash = 'A60186401FD6CD236B2B5A6D2761CB6F5F025877197DB2D7EE67EAF5FBDAD068' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-export-result-native-20260807T161800'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\retained\aidraw-e2e-fnd09-import-result-native-20260807T174500'; Directories = 18; Files = 27; Bytes = [long]92066; Hash = '9FB88ACA7F8CBF2A06B36F8CBDF6F15A287640308BB87788E3EEC4CF37DFFAAC' },
  [pscustomobject]@{ Path = 'E:\AIDraw\test-results\playwright-fnd09-import-result-native-20260807T174500'; Directories = 0; Files = 1; Bytes = [long]45; Hash = 'E9C8773F9C896351AEBEBCF13A1A6958D8D3AC1A65EF1053D885244EBAA3B22C' }
)

$fixedFiles = @(
  [pscustomobject]@{ Path = $node; Bytes = [long]91380224; Hash = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\npm-node24.mjs'); Bytes = [long]2410; Hash = '60BDF46BE72278E25582EF08600F856DEBFB94B58026AF8FFEC483EB399157EF' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\@playwright\test\cli.js'); Bytes = [long]707; Hash = '79E23E6A249176295B8490567DAA7717448A75866D6EA6F6B296FF3D23305C69' },
  [pscustomobject]@{ Path = $electronZip; Bytes = [long]144326439; Hash = 'EBA5F5088AF40ECB364FE258809C79A5234C6ECE5A75C64722772EBA01B02786' },
  [pscustomobject]@{ Path = (Join-Path $repo 'tests\e2e\utility-containment.spec.ts'); Bytes = $expectedObserverBytes; Hash = $expectedObserverSha256 },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-generation-result.mjs'); Bytes = [long]7943; Hash = '781024B1EBDA85E7BFDDB8610FB4E3817CEB1BFDBDE4BBF7CC6B8D6A9E0FBFA7' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-utility-generation-result.d.mts'); Bytes = [long]1017; Hash = '91481063367E2232206A9C6113C1AA98C7C2447DBAA8E23796F09AA81647B342' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\verify-package.mjs'); Bytes = [long]7408; Hash = '25B92938F0C6CDB16A3BBE2B23210891568A03EA5FC3B7D5BB58F430072235DE' },
  [pscustomobject]@{ Path = (Join-Path $repo 'scripts\packaged-e2e-boundary.mjs'); Bytes = [long]1123; Hash = 'B45D3C13A9630FAC28EBE0D652842DE820B91E3F3D68065DFD657BDC48721BC3' },
  [pscustomobject]@{ Path = (Join-Path $repo 'playwright.config.ts'); Bytes = [long]485; Hash = '2F87AB6775389B939877E7C9DA758CB8A44F602189EC167F8CCF8DE5120E821F' },
  [pscustomobject]@{ Path = $packageGuard; Bytes = [long]24942; Hash = '858CB1F9FA2C218555C2C0F1EBCE35B96A54D123E1C10DC77FD79923E05C3583' },
  [pscustomobject]@{ Path = $exe; Bytes = $expectedExeBytes; Hash = $expectedExeSha256 },
  [pscustomobject]@{ Path = $asar; Bytes = $expectedAsarBytes; Hash = $expectedAsarSha256 }
)

function Assert-ExactPlaywrightListOutput([string]$Text) {
  $escapedTitle = [regex]::Escape($scenarioTitle)
  $declarationPattern = "(?m)^\s*(?:tests[\\/]e2e[\\/])?utility-containment\.spec\.ts:$scenarioLine`:5\s+›\s+$escapedTitle\s*$"
  $declarations = [regex]::Matches($Text, $declarationPattern)
  if ($declarations.Count -ne 1) { throw "List output must contain one exact generation-result declaration at utility-containment.spec.ts:$scenarioLine`:5." }
  if ([regex]::Matches($Text, $escapedTitle).Count -ne 1) { throw 'List output repeats or omits the exact generation-result title.' }
  $allDeclarations = [regex]::Matches($Text, '(?m)^\s*(?:\S+[\\/])*\S+\.spec\.ts:\d+:\d+\s+›\s+.+$')
  if ($allDeclarations.Count -ne 1) { throw 'List output contains an ambiguous additional test declaration.' }
  $totalLines = [regex]::Matches($Text, '(?m)^\s*Total:.*$')
  if ($totalLines.Count -ne 1 -or $totalLines[0].Value -notmatch '^\s*Total:\s+1 test in 1 file\s*$') { throw 'List output must contain exactly Total: 1 test in 1 file.' }
  return [pscustomobject]@{ Declaration = $declarations[0].Value.Trim(); Total = $totalLines[0].Value.Trim() }
}

function Assert-ExactPlaywrightRunOutput([string]$Text) {
  $escapedTitle = [regex]::Escape($scenarioTitle)
  $selectionPattern = "(?:tests[\\/]e2e[\\/])?utility-containment\.spec\.ts:$scenarioLine`:5\s+›\s+$escapedTitle"
  if ([regex]::Matches($Text, $selectionPattern).Count -ne 1) { throw 'Runtime output must contain exactly one exact generation-result test selection.' }
  if ([regex]::Matches($Text, $escapedTitle).Count -ne 1) { throw 'Runtime output repeats or omits the exact generation-result title.' }
  $passed = [regex]::Matches($Text, '(?m)^\s*1 passed(?:\s+\([^)]+\))?\s*$')
  if ($passed.Count -ne 1) { throw 'Runtime output must report exactly 1 passed.' }
  if ($Text -match '(?mi)^\s*\d+\s+(?:failed|skipped|flaky)') { throw 'Runtime output contains a non-pass summary.' }
  return [pscustomobject]@{ Selection = [regex]::Match($Text, $selectionPattern).Value; Summary = $passed[0].Value.Trim() }
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
    if (!$rejectedAsExpected) { throw 'The runtime list parser accepted an ambiguous regression fixture.' }
  }
  [void](Assert-ExactPlaywrightRunOutput "Running 1 test using 1 worker`n  ok 1 utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle (3.2s)`n`n  1 passed (3.8s)")
  $runRejected = $false
  try { [void](Assert-ExactPlaywrightRunOutput "utility-containment.spec.ts:$scenarioLine`:5 › $scenarioTitle`n1 failed (3.8s)") }
  catch { $runRejected = $true }
  if (!$runRejected) { throw 'The runtime output parser accepted a failed scenario.' }
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

function Get-TreeIdentity([string]$Root) {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { throw "Retained immutable root is absent: $Root" }
  $directories = @(Get-ChildItem -LiteralPath $Root -Recurse -Directory | Sort-Object FullName)
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName)
  $lines = @()
  $bytes = [long]0
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
  $bytes = [long]0
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
    throw "Frozen package-source/controller manifest changed during $Phase."
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
  $runOwned = @($processes | Where-Object { $_.ExecutablePath -eq $exe })
  if ($runOwned.Count -ne 0) {
    $survivors = @($runOwned | Sort-Object ProcessId | ForEach-Object { [string]$_.ProcessId }) -join ','
    throw "Exact generation-result package process exists during $phase (PIDs $survivors); retain every run artifact and do not control it."
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

function Assert-SanitizedRetainedText([string]$Label, [string]$Text) {
  if ($Text -match '(?i)Bearer|Authorization|"token"\s*:|"data(?:Base64)?"\s*:|"prompt"\s*:|"credential"\s*:|"providerMetadata"\s*:') {
    throw "$Label contains credential or private generated-result payload material."
  }
}

Invoke-ParserSelfTest
$guardAudit = Assert-GuardNoForce $PSCommandPath
$environmentAudit = Invoke-EnvironmentSelfTest
if ($SelfTestOnly) {
  [pscustomobject]@{
    Result = 'FND-09 generation-result runtime guard parser/no-force/color/stderr self-test passed.'
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    Ast = $guardAudit
    Environment = $environmentAudit
    ExactListLine = "utility-containment.spec.ts:$scenarioLine`:5"
    PlaywrightTimeoutDisabled = $true
    NoCim = $true
    NoPackage = $true
    NoPlaywright = $true
    NoNativeLaunch = $true
  } | ConvertTo-Json -Depth 5
  return
}

Set-Location -LiteralPath $repo
if (!(Test-Path -LiteralPath $packageRoot -PathType Container)) { throw 'The immutable generation-result package root is absent.' }
foreach ($path in @($profile, $output, $packageListProfile, $packageListOutput, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "A required fresh/skipped root is no longer absent: $path" }
}
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed before runtime audit.' }
$manifestBefore = Assert-SourceManifest 'preflight'
$immutableBefore = @($immutableTrees | ForEach-Object { Assert-TreeIdentity $_ 'preflight' })
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
$env:AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE = $profile
$env:AIDRAW_E2E_FND09_GENERATION_RESULT_EXE_SHA256 = $expectedExeSha256
$env:AIDRAW_E2E_FND09_GENERATION_RESULT_ASAR_SHA256 = $expectedAsarSha256
$env:AIDRAW_E2E_ALLOW_FORCE_KILL = '0'
$env:npm_config_offline = 'true'
$env:HTTP_PROXY = 'http://127.0.0.1:9'
$env:HTTPS_PROXY = 'http://127.0.0.1:9'
$env:ALL_PROXY = 'http://127.0.0.1:9'
$env:NO_PROXY = '127.0.0.1,localhost'
Set-DeterministicColorEnvironment

$verifyResult = Invoke-NativeCapture { & $node '.\scripts\verify-package.mjs' }
if ($verifyResult.ExitCode -ne 0) { throw "Static verification rejected the immutable generation-result package.`n$($verifyResult.Text)" }
$verify = ConvertFrom-CapturedJson $verifyResult 'Static package verifier'
if ($verify.verified -ne $true -or $verify.executableSha256 -ne $expectedExeSha256 -or $verify.appAsarSha256 -ne $expectedAsarSha256) { throw 'Static package identity verification returned contradictory evidence.' }
if ($verify.packagedUtilityGenerationResult.isolatedMainHook -ne $true -or $verify.packagedUtilityGenerationResult.providerFreeLocalFixture -ne $true -or $verify.packagedUtilityGenerationResult.requestDerivedGenerationGate -ne $true -or $verify.packagedUtilityGenerationResult.queuedFreshWorkerRecovery -ne $true -or $verify.packagedUtilityGenerationResult.preloadPrivate -ne $true -or $verify.packagedUtilityGenerationResult.rendererPrivate -ne $true) { throw 'Static generation-result package markers failed.' }
if ($verify.packagedSecurity.preload.genericIpcAbsent -ne $true -or $verify.packagedSecurity.browserWindow.sandbox -ne $true -or $verify.packagedSecurity.browserWindow.contextIsolation -ne $true) { throw 'Static package-security boundary failed.' }

$observerAuditResult = Invoke-NativeCapture { & $node '.\scripts\packaged-utility-generation-result.mjs' '.\tests\e2e\utility-containment.spec.ts' }
if ($observerAuditResult.ExitCode -ne 0) { throw "External generation-result observer no-force audit failed.`n$($observerAuditResult.Text)" }
$observerAudit = ConvertFrom-CapturedJson $observerAuditResult 'External generation-result observer audit'
if ($observerAudit.observerSha256 -ne $expectedObserverSha256 -or $observerAudit.contract.onePackageLaunch -ne $true -or $observerAudit.contract.playwrightWatchdogDisabled -ne $true -or $observerAudit.contract.gracefulTimeoutRejectsWithoutControl -ne $true -or $observerAudit.contract.toolDiscoveryPrivate -ne $true -or $observerAudit.contract.invalidPayloadPrivate -ne $true -or $observerAudit.contract.providerFree -ne $true -or $observerAudit.contract.zeroInputOrOutputTargets -ne $true) { throw 'External observer contract returned contradictory no-force/privacy/provider/filesystem evidence.' }

$listResult = Invoke-NativeCapture { & $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --list --grep=FND-09-GENERATION-RESULT --output=$output --workers=1 --reporter=list }
if ($listResult.ExitCode -ne 0) { throw "Playwright list-only preflight failed with exit code $($listResult.ExitCode).`n$($listResult.Text)" }
$selection = Assert-ExactPlaywrightListOutput $listResult.Text
foreach ($path in @($profile, $output, $packageListProfile, $packageListOutput, $agt14Root)) {
  if (Test-Path -LiteralPath $path) { throw "List-only preflight changed a fresh/skipped root: $path" }
}
Assert-ProcessBoundary (Get-SubjectProcesses) 'post-list preflight'

# Exactly one test invocation is allowed. There is no retry, cleanup, signal,
# or timeout-driven termination in this controller. Any survivor is evidence.
$runResult = Invoke-NativeCapture { & $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --grep=FND-09-GENERATION-RESULT --output=$output --workers=1 --reporter=list }
$testExit = $runResult.ExitCode
$runText = $runResult.Text

$post = Get-SubjectProcesses
Assert-ProcessBoundary $post 'runtime postflight'
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed during runtime audit.' }
$manifestAfter = Assert-SourceManifest 'postflight'
$immutableAfter = @($immutableTrees | ForEach-Object { Assert-TreeIdentity $_ 'postflight' })
foreach ($path in @($packageListProfile, $packageListOutput, $agt14Root)) {
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

if ($probe.version -ne 1 -or $probe.scenario -ne 'FND-09 packaged generation result containment' -or $probe.result -ne 'passed') { throw 'Generation-result probe identity/result failed.' }
if ($probe.canonical.unchanged -ne $true -or $probe.canonical.before.documentId -ne $probe.canonical.after.documentId -or $probe.canonical.before.revision -ne $probe.canonical.after.revision -or $probe.canonical.before.sha256 -ne $probe.canonical.after.sha256 -or $probe.canonical.before.sha256 -cnotmatch '^[A-F0-9]{64}$') { throw 'Canonical invariance evidence failed.' }
if ($probe.requestContract.provider -ne 'stability' -or $probe.requestContract.mode -ne 'create' -or $probe.requestContract.resultCount -ne 1 -or $probe.requestContract.width -ne 1 -or $probe.requestContract.height -ne 1 -or $probe.requestContract.seed -ne 24681357 -or $probe.requestContract.credentialSupplied -ne $false -or $probe.requestContract.providerInvoked -ne $false) { throw 'Provider-free request contract evidence failed.' }

$faults = @($probe.resultCount, $probe.mimeHeader, $probe.dimensionHeader, $probe.seed, $probe.metadata)
$faultNames = @('result-count', 'mime-header', 'dimension-header', 'seed', 'metadata')
$contracts = @('originating resultCount', 'MIME/header agreement', 'declared/header dimensions', 'request-derived Stability seed', 'record-shaped provider metadata')
$messages = @('Generation utility returned more than the requested 1 result.', 'Generation utility returned a malformed image result.', 'Generation utility returned a malformed image result.', 'Generation utility returned a malformed result.', 'Generation utility returned a malformed result.')
for ($index = 0; $index -lt $faults.Count; $index += 1) {
  $fault = $faults[$index]
  if ($fault.fault -ne $faultNames[$index] -or $fault.contract -ne $contracts[$index] -or $fault.error.message -ne $messages[$index] -or [long]$fault.workerPid -le 0 -or $fault.resultReturnedToCaller -ne $false -or $fault.payloadRetained -ne $false -or $fault.rejectedBeforePreviewOrJobUse -ne $true) { throw "Invalid generation-result rejection/privacy evidence failed at $($faultNames[$index])." }
  $recovery = $fault.queuedRecovery
  if ($recovery.workerReplaced -ne $true -or $recovery.queued -ne $true -or [long]$recovery.workerPid -le 0 -or $recovery.outputCount -ne 1 -or $recovery.mimeType -ne 'image/png' -or $recovery.width -ne 1 -or $recovery.height -ne 1 -or $recovery.seed -ne 24681357 -or $recovery.providerMetadataRecord -ne $true -or [long]$recovery.bytes -le 0 -or $recovery.sha256 -cnotmatch '^[A-F0-9]{64}$' -or $recovery.semanticSha256 -cnotmatch '^[A-F0-9]{64}$') { throw "Queued fresh-worker recovery evidence failed at $($faultNames[$index])." }
}
for ($index = 1; $index -lt $faults.Count; $index += 1) {
  if ($faults[$index].workerPid -ne $faults[$index - 1].queuedRecovery.workerPid) { throw 'Generation-result worker replacement sequence is contradictory.' }
}
$workerPids = @($faults[0].workerPid) + @($faults | ForEach-Object { $_.queuedRecovery.workerPid })
if (@($workerPids | Select-Object -Unique).Count -ne 6 -or $probe.workerPidsDistinct -ne $true) { throw 'The exact five-fault/six-worker sequence is not distinct.' }
if (@($faults | ForEach-Object { $_.queuedRecovery.semanticSha256 } | Select-Object -Unique).Count -ne 1 -or $probe.recoverySemanticHashesAgree -ne $true) { throw 'Recovered valid generation semantic hashes disagree.' }
if ($probe.fixedInvalidResponseHoldMs -ne 150 -or $probe.rasterLaneUntouched -ne $true) { throw 'Deterministic hold or separate raster-lane evidence failed.' }
if ($probe.privacy.rendererCreated -ne $false -or $probe.privacy.invalidPayloadPublished -ne $false -or $probe.privacy.publicJobCreated -ne $false -or $probe.privacy.promptRetained -ne $false -or $probe.privacy.providerMetadataRetained -ne $false) { throw 'Private-surface probe evidence failed.' }
if ($probe.filesystem.inputTargetsCreated -ne 0 -or $probe.filesystem.outputTargetsCreated -ne 0) { throw 'The probe reports an unexpected filesystem target.' }
if ($probe.network.nonLoopbackRequests -ne 0 -or $probe.network.externalProviderRequests -ne 0 -or $probe.network.paidRequests -ne 0) { throw 'Probe network/provider/paid boundary failed.' }

if ($evidence.result -ne 'passed' -or $evidence.scenario -ne $scenarioTitle) { throw 'Sanitized runtime evidence result/identity failed.' }
if ($evidence.package.executable -ne $exe -or $evidence.package.executableBytes -ne $expectedExeBytes -or $evidence.package.executableSha256 -ne $expectedExeSha256 -or $evidence.package.asar -ne $asar -or $evidence.package.asarBytes -ne $expectedAsarBytes -or $evidence.package.asarSha256 -ne $expectedAsarSha256) { throw 'Sanitized runtime package identity failed.' }
if ($evidence.launch.mode -ne 'headless' -or $evidence.launch.rendererCreated -ne $false -or $evidence.launch.connectionPidMatched -ne $true -or $evidence.launch.loopbackMcpOnly -ne $true -or @($evidence.launch.trustedFolders).Count -ne 0) { throw 'Headless/loopback launch evidence failed.' }
if ($evidence.actor.name -ne 'FND-09 generation result observer' -or $evidence.actor.color -ne '#8a5b32') { throw 'Authenticated actor evidence failed.' }
if ($evidence.generationResult.result -ne 'passed' -or $evidence.generationResult.canonical.before.sha256 -ne $probe.canonical.before.sha256 -or $evidence.generationResult.resultCount.workerPid -ne $probe.resultCount.workerPid -or $evidence.generationResult.metadata.queuedRecovery.workerPid -ne $probe.metadata.queuedRecovery.workerPid) { throw 'Sanitized evidence does not embed the exact probe result.' }
if ($evidence.authenticatedMcp.documentId -ne $probe.canonical.before.documentId -or $evidence.authenticatedMcp.revision -ne $probe.canonical.before.revision -or $evidence.authenticatedMcp.canonicalMatchedProbe -ne $true -or @($evidence.authenticatedMcp.publicJobs).Count -ne 0) { throw 'Authenticated MCP/canonical/privacy evidence failed.' }
if ($evidence.privacy.hookAbsentFromToolsList -ne $true -or $evidence.privacy.invalidUtilityPayloadsNotPublished -ne $true -or $evidence.privacy.publicJobSummariesEmpty -ne $true -or $evidence.privacy.promptsRetained -ne $false -or $evidence.privacy.providerMetadataRetained -ne $false) { throw 'Public tool/job privacy evidence failed.' }
if ($evidence.filesystem.inputTargetsCreated -ne 0 -or $evidence.filesystem.outputTargetsCreated -ne 0) { throw 'Sanitized evidence reports an unexpected filesystem target.' }
if ($evidence.network.nonLoopbackRequests -ne 0 -or $evidence.network.externalProviderRequests -ne 0 -or $evidence.network.paidRequests -ne 0) { throw 'Runtime network/provider/paid evidence failed.' }
if ($evidence.sentinels.trustAbsent -ne $true -or $evidence.sentinels.providerCredentialsAbsent -ne $true -or $evidence.sentinels.forbiddenNetworkAbsent -ne $true) { throw 'Runtime sentinel evidence failed.' }
if ($evidence.cleanup.gracefulOnly -ne $true -or $evidence.cleanup.exitCode -ne 0 -or $evidence.cleanup.credentialStatus -ne 'redacted-after-graceful-stop') { throw 'Graceful-only credential-redacted cleanup evidence failed.' }

if ($testExit -ne 0) { throw "Exact generation-result test failed with exit code $testExit; retain every artifact and do not control any process.`n$runText" }
$runSelection = Assert-ExactPlaywrightRunOutput $runText

[pscustomobject]@{
  Result = 'FND-09 generation-result exact packaged runtime acceptance passed.'
  SourceFiles = $manifestAfter.Files
  SourceBytes = $manifestAfter.Bytes
  SourceSha256 = $manifestAfter.Sha256
  Executable = $exe
  ExecutableBytes = $expectedExeBytes
  ExecutableSha256 = $expectedExeSha256
  Asar = $asar
  AsarBytes = $expectedAsarBytes
  AsarSha256 = $expectedAsarSha256
  ObserverSha256 = $observerAudit.observerSha256
  ListDeclaration = $selection.Declaration
  RuntimeSelection = $runSelection.Selection
  RuntimeSummary = $runSelection.Summary
  Profile = $profile
  Output = $output
  FaultWorkers = @($faults | ForEach-Object { $_.workerPid })
  RecoveryWorkers = @($faults | ForEach-Object { $_.queuedRecovery.workerPid })
  CanonicalUnchanged = $probe.canonical.unchanged
  RasterLaneUntouched = $probe.rasterLaneUntouched
  InputTargetsCreated = $evidence.filesystem.inputTargetsCreated
  OutputTargetsCreated = $evidence.filesystem.outputTargetsCreated
  PublicJobs = @($evidence.authenticatedMcp.publicJobs).Count
  NonLoopbackRequests = $evidence.network.nonLoopbackRequests
  ProviderRequests = $evidence.network.externalProviderRequests
  PaidRequests = $evidence.network.paidRequests
  GracefulExitCode = $evidence.cleanup.exitCode
  CredentialStatus = $evidence.cleanup.credentialStatus
  ImmutableEvidenceTrees = @($immutableAfter | ForEach-Object { $_.Sha256 })
  ForceColorAbsent = ([Environment]::GetEnvironmentVariable('FORCE_COLOR', 'Process') -eq $null)
  NoColor = [Environment]::GetEnvironmentVariable('NO_COLOR', 'Process')
  ProtectedProcessIds = @($expectedProtected | ForEach-Object { $_.ProcessId })
} | ConvertTo-Json -Depth 6

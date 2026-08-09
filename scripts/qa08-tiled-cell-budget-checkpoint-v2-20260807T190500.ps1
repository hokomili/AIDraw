param(
  [switch]$SelfTest,
  [switch]$Run
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([bool]$SelfTest -eq [bool]$Run) { throw 'Choose exactly one of -SelfTest or -Run.' }

$repository = 'E:\AIDraw'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$controller = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-gate-v2.mjs'
$safety = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-safety-v2.mjs'
$config = 'E:\AIDraw\scripts\vitest.qa08-tiled-cell-budget-v2.config.mjs'
$acceptance = 'E:\AIDraw\tests\opt-in\qa08-tiled-cell-budget-v2.acceptance.ts'
$controllerTest = 'E:\AIDraw\tests\main\qa08-tiled-cell-budget-gate-v2.test.ts'
$vitestEntry = 'E:\AIDraw\node_modules\vitest\vitest.mjs'
$vitestCli = 'E:\AIDraw\node_modules\vitest\dist\cli.js'
$vitestPackage = 'E:\AIDraw\node_modules\vitest\package.json'
$failedV1Root = 'E:\AIDraw\test-results\retained\aidraw-qa08-tiled-cell-budget-optin-20260807T181500'
$smokeRoot = 'E:\AIDraw\test-results\retained\aidraw-qa08-tiled-cell-budget-cli-smoke-v2-20260807T190500'
$root = 'E:\AIDraw\test-results\retained\aidraw-qa08-tiled-cell-budget-optin-v2-20260807T190500'

$expectedManifest = [ordered]@{
  Files = 134
  Bytes = 2124247
  Sha256 = 'BAB8DCA232369FFE0C59570CF4962CF60A394D7146DAA90DEB1B0DBE2C59CAF5'
}

$expectedSmokeTree = [ordered]@{
  Directories = 3
  Files = 3
  Bytes = 1131
  Sha256 = '4AF8078B10B5032D10EB153E9CE21AF0B49AE65285FB3AF86425FC4904CE12CC'
}

$identities = @(
  [pscustomobject]@{ Path = $node; Bytes = 91380224; Sha256 = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-checkpoint-20260807T181500.ps1'; Bytes = 6778; Sha256 = 'DDF1544A68589C159FC831EF9F66F50EDA4280DC8064E5BF4B325528FBF2FA36' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-gate.mjs'; Bytes = 8865; Sha256 = '46DE556EA5F20B5907EA2E3FF91BAC78631399A74CF8F231D8876C215A7C9D69' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-gate.d.mts'; Bytes = 1097; Sha256 = '5211365A20A2C0FDD6EE8C53B187BB87AAACCB7B8BC61CEFA5E7F037553AFD11' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-safety.mjs'; Bytes = 5271; Sha256 = '6289E544B471D7358E330E1B68CD50BA1E27640F271A300EA27282AB8B235D0E' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-safety.d.mts'; Bytes = 541; Sha256 = 'FF0CD53DCC26DA65F4E7AC2B89831085C8B83C598D4D2E9F623A6F9EB5E6AA13' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\vitest.qa08-tiled-cell-budget.config.mjs'; Bytes = 735; Sha256 = 'F3850C1EE0065AD076CCB8ACCCD9375A5FC01F21B783CC2B4657C2D0C370C502' },
  [pscustomobject]@{ Path = 'E:\AIDraw\tests\opt-in\qa08-tiled-cell-budget.acceptance.ts'; Bytes = 6020; Sha256 = 'A486FB5C3322629B12A98F6F9DF940D44EB0D3ABCFDE306AC751B160989D36FB' },
  [pscustomobject]@{ Path = 'E:\AIDraw\tests\main\qa08-tiled-cell-budget-gate.test.ts'; Bytes = 3657; Sha256 = '6043D59C7CD5E778191792191761DDA90CF6E4962AE25A776F74B284E6B0E8BC' },
  [pscustomobject]@{ Path = $controller; Bytes = 10933; Sha256 = '533B7AD221757680F964031DA3B34BE04074E311DB598ED4D297D6210B76C0A3' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-gate-v2.d.mts'; Bytes = 1486; Sha256 = 'FC8953E3DA167158C41EECA2192A02D4FAF9020563A9AA72EA29808F2720CBE4' },
  [pscustomobject]@{ Path = $safety; Bytes = 5725; Sha256 = '34555909CE73CA6F3862018134C7594D8B9814E76C3EB4ECEC019F02482B5948' },
  [pscustomobject]@{ Path = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-safety-v2.d.mts'; Bytes = 650; Sha256 = 'E450E8D5370E634B325255C5CA591FEDC98344B3A4C98BEE4878D341E532913C' },
  [pscustomobject]@{ Path = $config; Bytes = 703; Sha256 = '9B9B034BEE301A197F20F932312EFDD38F92971DDDB3D073835DC1A524041378' },
  [pscustomobject]@{ Path = $acceptance; Bytes = 8173; Sha256 = '62115DEA854D81A4C8E5AA1E1DD1BDB5A7E2AC0051B52E97F229F2C6EAE7513E' },
  [pscustomobject]@{ Path = $controllerTest; Bytes = 4873; Sha256 = 'E613F9EF41AC5BF3F3206B81F1469C810101BEAAE4A313F9E63F600CC766A65D' },
  [pscustomobject]@{ Path = $vitestEntry; Bytes = 43; Sha256 = '39DB22F579ACF5639BBB17A261408DEBBDE03F4692C0C439E77E7F13AEBA74D6' },
  [pscustomobject]@{ Path = $vitestCli; Bytes = 284; Sha256 = '2AA6BCB906E952EE722FE631DD34C9F87D28E4244716197156C6274D17F28AAC' },
  [pscustomobject]@{ Path = $vitestPackage; Bytes = 5932; Sha256 = 'CAA41F04799BD42F3CFD100C4282E630D77FFC7DEB1E7E4927794FCB7F137F34' }
)

function Assert-Identity($identity) {
  $item = Get-Item -LiteralPath $identity.Path -ErrorAction Stop
  if ([long]$item.Length -ne [long]$identity.Bytes) { throw "Identity size drift: $($identity.Path)" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $identity.Path).Hash
  if ($hash -cne $identity.Sha256) { throw "Identity hash drift: $($identity.Path)" }
}

function Get-TreeIdentity([string]$Path) {
  $rootItem = Get-Item -LiteralPath $Path -ErrorAction Stop
  if (-not $rootItem.PSIsContainer) { throw "Expected retained directory: $Path" }
  $entries = @(Get-ChildItem -LiteralPath $Path -Recurse -Force | Sort-Object FullName)
  $files = @($entries | Where-Object { -not $_.PSIsContainer })
  $directories = @($entries | Where-Object { $_.PSIsContainer })
  $lines = New-Object 'System.Collections.Generic.List[string]'
  [long]$bytes = 0
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Path.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
    $bytes += [long]$file.Length
    [void]$lines.Add("$relative|$($file.Length)|$hash")
  }
  $payload = [Text.Encoding]::UTF8.GetBytes((($lines.ToArray() -join "`n") + "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $treeHash = [BitConverter]::ToString($sha.ComputeHash($payload)).Replace('-', '') } finally { $sha.Dispose() }
  return [pscustomobject]@{ Directories = $directories.Count; Files = $files.Count; Bytes = $bytes; Sha256 = $treeHash }
}

function Invoke-NodeJson([string[]]$Arguments) {
  $lines = @(& $node @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Node guard command failed ($LASTEXITCODE): $($lines -join [Environment]::NewLine)" }
  return (($lines -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Assert-FrozenSmoke {
  $tree = Get-TreeIdentity $smokeRoot
  if ([int]$tree.Directories -ne $expectedSmokeTree.Directories -or [int]$tree.Files -ne $expectedSmokeTree.Files -or [long]$tree.Bytes -ne $expectedSmokeTree.Bytes -or [string]$tree.Sha256 -cne $expectedSmokeTree.Sha256) { throw 'The retained Vitest 4 CLI smoke identity drifted.' }
  $expectedNames = @('smoke-evidence.json', 'smoke.tmj', 'vite-cache')
  $unexpected = @(Get-ChildItem -LiteralPath $smokeRoot | Where-Object { $_.Name -notin $expectedNames })
  if ($unexpected.Count -ne 0) { throw "The retained smoke root contains undeclared artifacts: $($unexpected.Name -join ', ')" }
  $evidence = Get-Content -Raw -LiteralPath (Join-Path $smokeRoot 'smoke-evidence.json') | ConvertFrom-Json
  if ($evidence.contract -cne 'qa08-tiled-cell-budget-v2' -or $evidence.scenario -cne 'smoke' -or [long]$evidence.totalCells -ne 1 -or [int]$evidence.canonicalLayerCount -ne 1 -or [int]$evidence.sampleGids[0] -ne 7 -or $null -ne $evidence.error -or [string]$evidence.source.sha256 -cne 'A19067F6A1B744ED928A6E4C7617897030E23D9D999FC60A755DB7EE296ABE70') { throw 'The retained Vitest 4 CLI smoke evidence contradicts the frozen contract.' }
  return $tree
}

function Assert-LaunchFreePreflight {
  Set-Location -LiteralPath $repository
  foreach ($identity in $identities) { Assert-Identity $identity }
  if (Test-Path -LiteralPath $failedV1Root) { throw "The failed v1 run must remain pre-root and absent: $failedV1Root" }
  if (Test-Path -LiteralPath $root) { throw "The corrected retained QA-08 root is not fresh: $root" }
  $smoke = Assert-FrozenSmoke

  $manifest = Invoke-NodeJson @($safety, '--manifest')
  if ([int]$manifest.files -ne $expectedManifest.Files -or [long]$manifest.bytes -ne $expectedManifest.Bytes -or [string]$manifest.sha256 -cne $expectedManifest.Sha256) { throw 'QA-08 v2 current-source manifest drifted.' }
  $static = Invoke-NodeJson @($safety, '--check')
  if ($static.optInOnly -ne $true -or $static.defaultSuiteExcluded -ne $true -or $static.exactProductionImporter -ne $true -or [long]$static.exactAcceptedCells -ne 16777216 -or [long]$static.exactRejectedCells -ne 16777217 -or $static.vitest4ReporterOverrideAbsent -ne $true -or $static.vitest4PoolOptionsAbsent -ne $true -or $static.tinySmokeBeforeHighMemory -ne $true -or $static.boundedDirectChildTimeout -ne $true -or $static.noShellOrCleanup -ne $true -or $static.noNetworkProviderCredentialPath -ne $true) { throw 'QA-08 v2 static safety contract is incomplete.' }
  $controllerResult = Invoke-NodeJson @($controller, '--self-test')
  if ($controllerResult.childSpawned -ne $false -or $controllerResult.rootCreated -ne $false -or [long]$controllerResult.timeoutMs -ne 180000 -or $controllerResult.reporterOverride -ne $false) { throw 'QA-08 v2 controller self-test crossed the no-child boundary.' }
  if (Test-Path -LiteralPath $root) { throw 'QA-08 v2 launch-free preflight created the future high-memory root.' }
  return [pscustomobject]@{ Manifest = $manifest; Static = $static; Controller = $controllerResult; Smoke = $smoke }
}

$preflight = Assert-LaunchFreePreflight
if ($SelfTest) {
  [pscustomobject]@{ Result = 'QA-08 v2 opt-in aggregate-cell checkpoint self-test PASS'; FailedV1RootAbsent = $true; CorrectedRootAbsent = $true; Source = $preflight.Manifest; Static = $preflight.Static; Controller = $preflight.Controller; Smoke = $preflight.Smoke } | ConvertTo-Json -Depth 8
  exit 0
}

$env:NODE_OPTIONS = $null
$env:FORCE_COLOR = $null
$env:NO_COLOR = '1'
$env:AIDRAW_QA08_CELL_BUDGET_OPT_IN = 'qa08-tiled-cell-budget-v2'
$env:AIDRAW_QA08_CELL_BUDGET_ROOT = $root

& $node $controller '--run'
if ($LASTEXITCODE -ne 0) { throw "QA-08 v2 opt-in controller failed with exit $LASTEXITCODE. Preserve the entire corrected root for audit; do not retry or clean it." }

foreach ($identity in $identities) { Assert-Identity $identity }
$manifestAfter = Invoke-NodeJson @($safety, '--manifest')
if ([string]$manifestAfter.sha256 -cne $expectedManifest.Sha256 -or [int]$manifestAfter.files -ne $expectedManifest.Files -or [long]$manifestAfter.bytes -ne $expectedManifest.Bytes) { throw 'QA-08 v2 source identity changed during the run.' }
$smokeAfter = Assert-FrozenSmoke

$required = @('accept.tmj', 'accept-evidence.json', 'reject.tmj', 'reject-evidence.json', 'gate-summary.json', 'vite-cache')
foreach ($name in $required) { if (!(Test-Path -LiteralPath (Join-Path $root $name))) { throw "QA-08 v2 retained artifact is missing: $name" } }
$unexpected = @(Get-ChildItem -LiteralPath $root | Where-Object { $_.Name -notin $required })
if ($unexpected.Count -ne 0) { throw "QA-08 v2 root contains undeclared artifacts: $($unexpected.Name -join ', ')" }
$summary = Get-Content -Raw -LiteralPath (Join-Path $root 'gate-summary.json') | ConvertFrom-Json
if ($summary.contract -cne 'qa08-tiled-cell-budget-v2' -or [long]$summary.accept.totalCells -ne 16777216 -or [long]$summary.reject.totalCells -ne 16777217 -or [int]$summary.accept.canonicalLayerCount -ne 4 -or [int]$summary.reject.canonicalLayerCount -ne 0 -or [string]$summary.reject.error -cne 'Tiled layer data exceeds the 16,777,216-cell total import budget.') { throw 'QA-08 v2 retained summary contradicts the exact acceptance contract.' }

[pscustomobject]@{ Result = 'PASS'; Root = $root; Source = $manifestAfter; Smoke = $smokeAfter; AcceptDurationMs = $summary.accept.durationMs; RejectDurationMs = $summary.reject.durationMs; AcceptMaxRss = $summary.accept.resources.maxRss; RejectMaxRss = $summary.reject.resources.maxRss } | ConvertTo-Json -Depth 5

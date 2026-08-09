param(
  [switch]$SelfTest,
  [switch]$Run
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([bool]$SelfTest -eq [bool]$Run) { throw 'Choose exactly one of -SelfTest or -Run.' }

$repository = 'E:\AIDraw'
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$controller = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-gate.mjs'
$safety = 'E:\AIDraw\scripts\qa08-tiled-cell-budget-safety.mjs'
$config = 'E:\AIDraw\scripts\vitest.qa08-tiled-cell-budget.config.mjs'
$acceptance = 'E:\AIDraw\tests\opt-in\qa08-tiled-cell-budget.acceptance.ts'
$controllerTest = 'E:\AIDraw\tests\main\qa08-tiled-cell-budget-gate.test.ts'
$vitestEntry = 'E:\AIDraw\node_modules\vitest\vitest.mjs'
$vitestCli = 'E:\AIDraw\node_modules\vitest\dist\cli.js'
$vitestPackage = 'E:\AIDraw\node_modules\vitest\package.json'
$root = 'E:\AIDraw\test-results\retained\aidraw-qa08-tiled-cell-budget-optin-20260807T181500'

$expectedManifest = [ordered]@{
  Files = 134
  Bytes = 2124247
  Sha256 = 'BAB8DCA232369FFE0C59570CF4962CF60A394D7146DAA90DEB1B0DBE2C59CAF5'
}

$identities = @(
  [pscustomobject]@{ Path = $node; Bytes = 91380224; Sha256 = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088' },
  [pscustomobject]@{ Path = $controller; Bytes = 8865; Sha256 = '46DE556EA5F20B5907EA2E3FF91BAC78631399A74CF8F231D8876C215A7C9D69' },
  [pscustomobject]@{ Path = $safety; Bytes = 5271; Sha256 = '6289E544B471D7358E330E1B68CD50BA1E27640F271A300EA27282AB8B235D0E' },
  [pscustomobject]@{ Path = $config; Bytes = 735; Sha256 = 'F3850C1EE0065AD076CCB8ACCCD9375A5FC01F21B783CC2B4657C2D0C370C502' },
  [pscustomobject]@{ Path = $acceptance; Bytes = 6020; Sha256 = 'A486FB5C3322629B12A98F6F9DF940D44EB0D3ABCFDE306AC751B160989D36FB' },
  [pscustomobject]@{ Path = $controllerTest; Bytes = 3657; Sha256 = '6043D59C7CD5E778191792191761DDA90CF6E4962AE25A776F74B284E6B0E8BC' },
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

function Invoke-NodeJson([string[]]$Arguments) {
  $lines = @(& $node @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Node guard command failed ($LASTEXITCODE): $($lines -join [Environment]::NewLine)" }
  return (($lines -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Assert-LaunchFreePreflight {
  Set-Location -LiteralPath $repository
  foreach ($identity in $identities) { Assert-Identity $identity }
  if (Test-Path -LiteralPath $root) { throw "The retained QA-08 root is not fresh: $root" }

  $manifest = Invoke-NodeJson @($safety, '--manifest')
  if ([int]$manifest.files -ne $expectedManifest.Files -or [long]$manifest.bytes -ne $expectedManifest.Bytes -or [string]$manifest.sha256 -cne $expectedManifest.Sha256) { throw 'QA-08 current-source manifest drifted.' }
  $static = Invoke-NodeJson @($safety, '--check')
  if ($static.optInOnly -ne $true -or $static.defaultSuiteExcluded -ne $true -or $static.exactProductionImporter -ne $true -or [long]$static.exactAcceptedCells -ne 16777216 -or [long]$static.exactRejectedCells -ne 16777217 -or $static.identityScopedTimeoutTermination -ne $true -or $static.noShellOrCleanup -ne $true -or $static.noNetworkProviderCredentialPath -ne $true) { throw 'QA-08 static safety contract is incomplete.' }
  $controllerResult = Invoke-NodeJson @($controller, '--self-test')
  if ($controllerResult.childSpawned -ne $false -or $controllerResult.rootCreated -ne $false -or [long]$controllerResult.timeoutMs -ne 180000) { throw 'QA-08 controller self-test crossed the no-child boundary.' }
  if (Test-Path -LiteralPath $root) { throw 'QA-08 launch-free preflight created the future root.' }
  return [pscustomobject]@{ Manifest = $manifest; Static = $static; Controller = $controllerResult }
}

$preflight = Assert-LaunchFreePreflight
if ($SelfTest) {
  [pscustomobject]@{ Result = 'QA-08 opt-in aggregate-cell checkpoint self-test PASS'; RootAbsent = $true; Source = $preflight.Manifest; Static = $preflight.Static; Controller = $preflight.Controller } | ConvertTo-Json -Depth 8
  exit 0
}

$env:NODE_OPTIONS = $null
$env:FORCE_COLOR = $null
$env:NO_COLOR = '1'
$env:AIDRAW_QA08_CELL_BUDGET_OPT_IN = 'qa08-tiled-cell-budget-v1'
$env:AIDRAW_QA08_CELL_BUDGET_ROOT = $root

& $node $controller '--run'
if ($LASTEXITCODE -ne 0) { throw "QA-08 opt-in controller failed with exit $LASTEXITCODE. Preserve the entire root for audit; do not retry or clean it." }

foreach ($identity in $identities) { Assert-Identity $identity }
$manifestAfter = Invoke-NodeJson @($safety, '--manifest')
if ([string]$manifestAfter.sha256 -cne $expectedManifest.Sha256 -or [int]$manifestAfter.files -ne $expectedManifest.Files -or [long]$manifestAfter.bytes -ne $expectedManifest.Bytes) { throw 'QA-08 source identity changed during the run.' }

$required = @('accept.tmj', 'accept-evidence.json', 'reject.tmj', 'reject-evidence.json', 'gate-summary.json', 'vite-cache')
foreach ($name in $required) { if (!(Test-Path -LiteralPath (Join-Path $root $name))) { throw "QA-08 retained artifact is missing: $name" } }
$unexpected = @(Get-ChildItem -LiteralPath $root | Where-Object { $_.Name -notin $required })
if ($unexpected.Count -ne 0) { throw "QA-08 root contains undeclared artifacts: $($unexpected.Name -join ', ')" }
$summary = Get-Content -Raw -LiteralPath (Join-Path $root 'gate-summary.json') | ConvertFrom-Json
if ($summary.contract -cne 'qa08-tiled-cell-budget-v1' -or [long]$summary.accept.totalCells -ne 16777216 -or [long]$summary.reject.totalCells -ne 16777217 -or [int]$summary.accept.canonicalLayerCount -ne 4 -or [int]$summary.reject.canonicalLayerCount -ne 0 -or [string]$summary.reject.error -cne 'Tiled layer data exceeds the 16,777,216-cell total import budget.') { throw 'QA-08 retained summary contradicts the exact acceptance contract.' }

[pscustomobject]@{ Result = 'PASS'; Root = $root; Source = $manifestAfter; AcceptDurationMs = $summary.accept.durationMs; RejectDurationMs = $summary.reject.durationMs; AcceptMaxRss = $summary.accept.resources.maxRss; RejectMaxRss = $summary.reject.resources.maxRss } | ConvertTo-Json -Depth 5

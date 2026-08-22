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
$node = 'C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$electronZipDirectory = 'E:\AIDraw\.electron-cache\9c4e224684594fb9a8cbda18d3e2b7bf0c3c023d1462402a4031f8b4cc25e621'
$electronZip = Join-Path $electronZipDirectory 'electron-v43.2.0-win32-x64.zip'
$protectedExecutable = 'E:\AIDraw\out-fnd09-utility-pressure-20260806T123215\AIDraw-win32-x64\AIDraw.exe'

$expectedSourceFiles = 271
$expectedSourceBytes = 3373386
$expectedSourceSha256 = '7744647FEF3B16EBE84FC9766FD1AF83DFDE3D263C62AFAD23FFFAD6B70F2762'
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
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\@electron-forge\cli\dist\electron-forge.js'); Bytes = [long]5152; Hash = '13560964D8ADD71C5A79AB170DE86F7D83076BBCDD874781FEE5C67191DE4253' },
  [pscustomobject]@{ Path = (Join-Path $repo 'node_modules\electron\package.json'); Bytes = [long]744; Hash = '02D60DD9473E05F9E5C3D23D3397E24C77CF283F086BB20BE283E4536AAF1923' },
  [pscustomobject]@{ Path = $electronZip; Bytes = [long]144326439; Hash = 'EBA5F5088AF40ECB364FE258809C79A5234C6ECE5A75C64722772EBA01B02786' }
)

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
  $text = $lines -join "`n"
  return [pscustomobject]@{ Files = $files.Count; Bytes = $bytes; Sha256 = (Get-TextSha256 $text) }
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
  if (@($processes | Where-Object { $_.ExecutablePath -eq $exe }).Count -ne 0) { throw "The new observation codec package is running during $phase." }
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
    $creationTicks = ([DateTime]$actual.CreationDate).ToUniversalTime().Ticks
    if ($creationTicks -ne $expected.CreationTicks) { throw "Protected AIDraw creation identity changed during $phase." }
  }
}

Set-Location -LiteralPath $repo
foreach ($path in @($packageRoot, $profile, $output)) {
  if (Test-Path -LiteralPath $path) { throw "Fresh checkpoint path already exists: $path" }
}
if (Test-Path -LiteralPath $agt14Root) { throw 'Skipped AGT-14 root must remain absent.' }
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
if ((Get-FileHash -LiteralPath $protectedExecutable -Algorithm SHA256).Hash -ne $expectedProtectedExecutableSha256) { throw 'Protected unrelated AIDraw executable hash changed.' }
$manifestBefore = Get-SourceManifest
if ($manifestBefore.Files -ne $expectedSourceFiles -or $manifestBefore.Bytes -ne $expectedSourceBytes -or $manifestBefore.Sha256 -ne $expectedSourceSha256) {
  throw 'Frozen source/controller manifest changed before packaging.'
}
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

& $node '.\scripts\npm-node24.mjs' run package
if ($LASTEXITCODE -ne 0) { throw "Offline package checkpoint failed with exit code $LASTEXITCODE; retain the new root." }
if (!(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'Package outputs are incomplete.' }
& $node '.\scripts\verify-package.mjs'
if ($LASTEXITCODE -ne 0) { throw 'Static verification rejected the new package; retain it as failed evidence.' }

$env:AIDRAW_E2E_LAUNCH_CONTEXT = 'unsandboxed-gui'
$env:AIDRAW_E2E_OUT_DIR = $outName
$env:AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE = $profile
$listLines = @(& $node '.\scripts\npm-node24.mjs' run test:e2e:only -- --list --grep=FND-09-OBSERVATION-CODEC --output=$output --workers=1 --reporter=list 2>&1 | ForEach-Object { [string]$_ })
$listExit = $LASTEXITCODE
$listText = $listLines -join "`n"
if ($listExit -ne 0) { throw "Playwright list-only audit failed with exit code $listExit.`n$listText" }
$selectionPattern = 'tests[\\/]e2e[\\/]utility-containment\.spec\.ts:\d+:\d+\s+›\s+FND-09-OBSERVATION-CODEC exact package rejects undecodable output and recovers queued observation work'
if ([regex]::Matches($listText, $selectionPattern).Count -ne 1) { throw "List-only selector did not resolve exactly one intended test.`n$listText" }
if ($listText -notmatch 'Total:\s+1 test in 1 file') { throw "List-only audit did not report exactly one test.`n$listText" }
foreach ($path in @($profile, $output)) {
  if (Test-Path -LiteralPath $path) { throw "List-only audit created a future run root: $path" }
}

$manifestAfter = Get-SourceManifest
if ($manifestAfter.Files -ne $expectedSourceFiles -or $manifestAfter.Bytes -ne $expectedSourceBytes -or $manifestAfter.Sha256 -ne $expectedSourceSha256) {
  throw 'Packaging/list changed the frozen source/controller manifest.'
}
foreach ($item in $fixedFiles) { Assert-FixedFile $item }
$post = Get-SubjectProcesses
Assert-ProcessBoundary $post 'postflight'

$exeItem = Get-Item -LiteralPath $exe
$asarItem = Get-Item -LiteralPath $asar
[pscustomobject]@{
  Result = 'FND-09 observation codec package/list checkpoint passed without native launch.'
  SourceFiles = $manifestAfter.Files
  SourceBytes = $manifestAfter.Bytes
  SourceSha256 = $manifestAfter.Sha256
  PackageRoot = $packageRoot
  Executable = $exe
  ExecutableBytes = $exeItem.Length
  ExecutableSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  Asar = $asar
  AsarBytes = $asarItem.Length
  AsarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
  Observer = 'tests/e2e/utility-containment.spec.ts'
  Selector = 'FND-09-OBSERVATION-CODEC'
  ProfileAbsent = !(Test-Path -LiteralPath $profile)
  OutputAbsent = !(Test-Path -LiteralPath $output)
  ProtectedProcessIds = @($expectedProtected | ForEach-Object { $_.ProcessId })
} | ConvertTo-Json -Depth 4

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_IMPORT_RESULT',
  'AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE',
  'fnd09-import-result-probe.json',
  'fnd09-import-result-fixture.svg',
  'fnd09-import-result-forbidden-network.json',
  'FND-09 packaged import result containment',
  'runE2eImportResultProbe',
  'Raster utility returned a malformed imported document.',
  'Raster utility returned malformed import warnings.',
  'rejectedBeforeWorkspaceUse',
];

const WORKER_MARKERS = [
  'AIDRAW_E2E_UTILITY_IMPORT_RESULT',
  'e2eResultFault',
  'document-schema',
  'warning-shape',
  'The import-result probe requires the exact one-document real SVG importer baseline.',
  'The import-result probe is unavailable outside isolated packaged QA.',
];

const PRIVATE_MARKERS = [
  'AIDRAW_E2E_UTILITY_IMPORT_RESULT',
  'e2eResultFault',
  'runE2eImportResultProbe',
  'fnd09-import-result-probe.json',
];

const FORCE_CONTROL_PATTERNS = [
  { label: 'kill/terminate method', pattern: /\.\s*(?:kill|terminate)\s*\(/i },
  { label: 'force signal', pattern: /\b(?:SIGKILL|SIGTERM)\b/i },
  { label: 'Windows process-control command', pattern: /\b(?:taskkill(?:\.exe)?|tskill|Stop-Process|TerminateProcess)\b/i },
  { label: 'POSIX force-kill command', pattern: /\bkill\s+-9\b/i },
];

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Import-result observer source is missing ${label}.`);
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`Import-result observer source repeats ${label}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Import-result observer source cannot bound ${label}.`);
  return source.slice(start, end);
}

function assertForceControlAbsent(label, source) {
  const matched = FORCE_CONTROL_PATTERNS.find(({ pattern }) => pattern.test(source));
  if (matched) throw new Error(`FND-09 import-result ${label} regained forbidden force-control behavior (${matched.label}).`);
}

export function assertPackagedUtilityImportResultSources({ mainSource, workerSource, preloadSource, rendererSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 import-result markers: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 import-result markers: ${missingWorker.join(', ')}.`);
  for (const [label, source] of [['preload', preloadSource], ['renderer', rendererSource]]) {
    const leaked = PRIVATE_MARKERS.filter((marker) => source.includes(marker));
    if (leaked.length) throw new Error(`Packaged ${label} exposes private FND-09 import-result markers: ${leaked.join(', ')}.`);
  }
  return {
    isolatedMainHook: true,
    realUtilityFaultAfterImport: true,
    canonicalMigrationAndWarningGate: true,
    queuedFreshWorkerRecovery: true,
    preloadPrivate: true,
    rendererPrivate: true,
  };
}

export function assertImportResultObserverNoForceSource(observerSource) {
  const waitHelper = sliceBetween(observerSource, 'async function waitForExit', 'async function quitGracefully', 'bounded exit helper');
  const quitHelper = sliceBetween(observerSource, 'async function quitGracefully', 'async function redactConnection', 'graceful quit helper');
  for (const marker of [
    'clearTimeout(timer)',
    "child.removeListener('exit', onExit)",
    "child.once('exit', onExit)",
    'reject(new Error(',
  ]) {
    if (!waitHelper.includes(marker)) throw new Error(`The bounded exit helper is missing ${marker}.`);
  }
  for (const marker of [
    '`--user-data-dir=${profile}`',
    "'--quit-engine'",
    "await waitForExit(signal, 'The isolated FND-09 quit signal', 5_000);",
    "await waitForExit(child, 'The isolated packaged FND-09 engine', 15_000);",
  ]) {
    if (!quitHelper.includes(marker)) throw new Error(`The graceful quit helper is missing ${marker}.`);
  }

  const title = "const importResultScenarioName = 'FND-09-IMPORT-RESULT exact package rejects invalid imported output and recovers queued import work';";
  if (observerSource.split(title).length !== 2) throw new Error('Observer source must contain exactly one FND-09 import-result title.');
  const scenario = sliceBetween(
    observerSource,
    'test(importResultScenarioName, async () => {',
    '// FND-09-IMPORT-RESULT observer end.',
    'import-result scenario',
  );
  if ((scenario.match(/test\.setTimeout\(0\);/g) ?? []).length !== 1) {
    throw new Error('Import-result scenario regained forbidden force-control behavior (Playwright timeout termination is not disabled exactly once).');
  }
  if (/test\.setTimeout\((?!0\))/g.test(scenario)) throw new Error('Import-result scenario regained a timeout-driven worker-termination path.');
  for (const marker of [
    'AIDRAW_E2E_FND09_IMPORT_RESULT_EXE_SHA256',
    'AIDRAW_E2E_FND09_IMPORT_RESULT_ASAR_SHA256',
    "AIDRAW_E2E_UTILITY_IMPORT_RESULT: '1'",
    "expect(toolNames).not.toContain('runE2eImportResultProbe')",
    "expect(toolNames).not.toContain('e2eResultFault')",
    "error: { message: 'Raster utility returned a malformed imported document.' }",
    "error: { message: 'Raster utility returned malformed import warnings.' }",
    'rejectedBeforeWorkspaceUse: true',
    'resultReturnedToCaller: false',
    'payloadRetained: false',
    'importInputsCreated: 1, outputTargetsCreated: 0',
    "createHash('sha256').update(fixture)",
    'invalidUtilityPayloadsNotPublished: true',
    'await quitGracefully(profile, child)',
    "authorityStatus).toBe('redacted-after-graceful-stop')",
  ]) {
    if (!scenario.includes(marker)) throw new Error(`Import-result scenario is missing ${marker}.`);
  }
  if ((scenario.match(/const child = spawn\(packagedExecutable,/g) ?? []).length !== 1) {
    throw new Error('Import-result scenario must retain exactly one package launch.');
  }
  for (const [label, source] of [
    ['bounded exit helper', waitHelper],
    ['graceful quit helper', quitHelper],
    ['scenario', scenario],
  ]) assertForceControlAbsent(label, source);

  return {
    scenario: 'FND-09-IMPORT-RESULT',
    onePackageLaunch: true,
    playwrightWatchdogDisabled: true,
    gracefulTimeoutRejectsWithoutControl: true,
    toolDiscoveryPrivate: true,
    invalidPayloadPrivate: true,
    oneTestOwnedImportInput: true,
    zeroOutputTargets: true,
    checkedSlices: 3,
  };
}

async function runObserverAudit(observerPathArgument) {
  const observerPath = resolve(observerPathArgument || 'tests/e2e/utility-containment.spec.ts');
  const observerSource = await readFile(observerPath, 'utf8');
  return {
    observerPath,
    observerBytes: Buffer.byteLength(observerSource, 'utf8'),
    observerSha256: createHash('sha256').update(observerSource, 'utf8').digest('hex').toUpperCase(),
    contract: assertImportResultObserverNoForceSource(observerSource),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runObserverAudit(process.argv[2]), null, 2)}\n`);
}

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT',
  'AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE',
  'fnd09-quantization-result-probe.json',
  'fnd09-quantization-result-forbidden-network.json',
  'FND-09 packaged quantization result containment',
  'runE2eQuantizationResultProbe',
  'Raster utility quantization result exceeds its ',
  '-pixel output budget.',
  'Raster utility returned a malformed quantization result.',
  'countGateBeforeDuplicateAllocation',
];

const WORKER_MARKERS = [
  'AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT',
  'e2eResultFault',
  'over-budget',
  'contradictory',
  'The quantization-result probe requires the exact valid real-quantizer baseline.',
  'The quantization-result probe is unavailable outside isolated packaged QA.',
];

const PRIVATE_MARKERS = [
  'AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT',
  'e2eResultFault',
  'runE2eQuantizationResultProbe',
  'fnd09-quantization-result-probe.json',
];

const FORCE_CONTROL_PATTERNS = [
  { label: 'kill/terminate method', pattern: /\.\s*(?:kill|terminate)\s*\(/i },
  { label: 'force signal', pattern: /\b(?:SIGKILL|SIGTERM)\b/i },
  { label: 'Windows process-control command', pattern: /\b(?:taskkill(?:\.exe)?|tskill|Stop-Process|TerminateProcess)\b/i },
  { label: 'POSIX force-kill command', pattern: /\bkill\s+-9\b/i },
];

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Quantization-result observer source is missing ${label}.`);
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`Quantization-result observer source repeats ${label}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Quantization-result observer source cannot bound ${label}.`);
  return source.slice(start, end);
}

function assertForceControlAbsent(label, source) {
  const matched = FORCE_CONTROL_PATTERNS.find(({ pattern }) => pattern.test(source));
  if (matched) throw new Error(`FND-09 quantization-result ${label} regained forbidden force-control behavior (${matched.label}).`);
}

export function assertPackagedUtilityQuantizationResultSources({ mainSource, workerSource, preloadSource, rendererSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 quantization-result markers: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 quantization-result markers: ${missingWorker.join(', ')}.`);
  for (const [label, source] of [['preload', preloadSource], ['renderer', rendererSource]]) {
    const leaked = PRIVATE_MARKERS.filter((marker) => source.includes(marker));
    if (leaked.length) throw new Error(`Packaged ${label} exposes private FND-09 quantization-result markers: ${leaked.join(', ')}.`);
  }
  return {
    isolatedMainHook: true,
    realUtilityFaultAfterQuantization: true,
    requestDerivedResultGate: true,
    queuedFreshWorkerRecovery: true,
    preloadPrivate: true,
    rendererPrivate: true,
  };
}

export function assertQuantizationResultObserverNoForceSource(observerSource) {
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

  const title = "const quantizationResultScenarioName = 'FND-09-QUANTIZATION-RESULT exact package rejects invalid child output and recovers queued quantization work';";
  if (observerSource.split(title).length !== 2) throw new Error('Observer source must contain exactly one FND-09 quantization-result title.');
  const scenarioMarker = 'test(quantizationResultScenarioName, async () => {';
  const scenario = sliceBetween(
    observerSource,
    scenarioMarker,
    '// FND-09-QUANTIZATION-RESULT observer end.',
    'quantization-result scenario',
  );
  if ((scenario.match(/test\.setTimeout\(0\);/g) ?? []).length !== 1) {
    throw new Error('Quantization-result scenario regained forbidden force-control behavior (Playwright timeout termination is not disabled exactly once).');
  }
  if (/test\.setTimeout\((?!0\))/g.test(scenario)) throw new Error('Quantization-result scenario regained a timeout-driven worker-termination path.');
  for (const marker of [
    'AIDRAW_E2E_FND09_QUANTIZATION_RESULT_EXE_SHA256',
    'AIDRAW_E2E_FND09_QUANTIZATION_RESULT_ASAR_SHA256',
    "AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT: '1'",
    "expect(toolNames).not.toContain('runE2eQuantizationResultProbe')",
    "expect(toolNames).not.toContain('e2eResultFault')",
    'countGateBeforeDuplicateAllocation: true',
    "contradiction: 'x=1 lies outside the originating 1x1 request'",
    'resultReturnedToCaller: false',
    'payloadRetained: false',
    'invalidUtilityPayloadsNotPublished: true',
    'await quitGracefully(profile, child)',
    "credentialStatus).toBe('redacted-after-graceful-stop')",
  ]) {
    if (!scenario.includes(marker)) throw new Error(`Quantization-result scenario is missing ${marker}.`);
  }
  if ((scenario.match(/const child = spawn\(packagedExecutable,/g) ?? []).length !== 1) {
    throw new Error('Quantization-result scenario must retain exactly one package launch.');
  }
  for (const [label, source] of [
    ['bounded exit helper', waitHelper],
    ['graceful quit helper', quitHelper],
    ['scenario', scenario],
  ]) assertForceControlAbsent(label, source);

  return {
    scenario: 'FND-09-QUANTIZATION-RESULT',
    onePackageLaunch: true,
    playwrightWatchdogDisabled: true,
    gracefulTimeoutRejectsWithoutControl: true,
    toolDiscoveryPrivate: true,
    invalidPayloadPrivate: true,
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
    contract: assertQuantizationResultObserverNoForceSource(observerSource),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runObserverAudit(process.argv[2]), null, 2)}\n`);
}

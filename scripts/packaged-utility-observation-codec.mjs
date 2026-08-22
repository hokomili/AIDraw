import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC',
  'AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE',
  'fnd09-observation-codec-probe.json',
  'fnd09-observation-codec-forbidden-network.json',
  'FND-09 packaged observation codec result containment',
  'Raster utility returned an undecodable observation image.',
];

const WORKER_MARKERS = [
  'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC',
  'e2eCorruptIdat',
  'The observation codec probe is unavailable outside isolated packaged QA.',
  'The observation codec fixture requires one nonempty IDAT chunk.',
  'The observation codec probe requires one available PNG result.',
];

const PRIVATE_MARKERS = [
  'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC',
  'e2eCorruptIdat',
  'runE2eObservationCodecProbe',
  'fnd09-observation-codec-probe.json',
];

const FORCE_CONTROL_PATTERNS = [
  { label: 'kill/terminate method', pattern: /\.\s*(?:kill|terminate)\s*\(/i },
  { label: 'force signal', pattern: /\b(?:SIGKILL|SIGTERM)\b/i },
  { label: 'Windows process-control command', pattern: /\b(?:taskkill(?:\.exe)?|tskill|Stop-Process|TerminateProcess)\b/i },
  { label: 'POSIX force-kill command', pattern: /\bkill\s+-9\b/i },
];

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Observation codec observer source is missing ${label}.`);
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`Observation codec observer source repeats ${label}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Observation codec observer source cannot bound ${label}.`);
  return source.slice(start, end);
}

function assertForceControlAbsent(label, source) {
  const matched = FORCE_CONTROL_PATTERNS.find(({ pattern }) => pattern.test(source));
  if (matched) throw new Error(`FND-09 observation codec ${label} regained forbidden force-control behavior (${matched.label}).`);
}

export function assertPackagedUtilityObservationCodecSources({ mainSource, workerSource, preloadSource, rendererSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 observation codec markers: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 observation codec markers: ${missingWorker.join(', ')}.`);
  for (const [label, source] of [['preload', preloadSource], ['renderer', rendererSource]]) {
    const leaked = PRIVATE_MARKERS.filter((marker) => source.includes(marker));
    if (leaked.length) throw new Error(`Packaged ${label} exposes private FND-09 observation codec markers: ${leaked.join(', ')}.`);
  }
  return {
    isolatedMainHook: true,
    realUtilityCorruption: true,
    fullDecodeBoundary: true,
    preloadPrivate: true,
    rendererPrivate: true,
  };
}

export function assertObservationCodecObserverNoForceSource(observerSource) {
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

  const title = "const observationCodecScenarioName = 'FND-09-OBSERVATION-CODEC exact package rejects undecodable output and recovers queued observation work';";
  if (observerSource.split(title).length !== 2) throw new Error('Observer source must contain exactly one FND-09 observation codec title.');
  const scenarioMarker = 'test(observationCodecScenarioName, async () => {';
  const scenario = sliceBetween(
    observerSource,
    scenarioMarker,
    '// FND-09-OBSERVATION-CODEC observer end.',
    'observation codec scenario',
  );
  if ((scenario.match(/test\.setTimeout\(0\);/g) ?? []).length !== 1) {
    throw new Error('Observation codec scenario regained forbidden force-control behavior (Playwright timeout termination is not disabled exactly once).');
  }
  if (/test\.setTimeout\((?!0\))/g.test(scenario)) {
    throw new Error('Observation codec scenario regained a timeout-driven worker-termination path.');
  }
  for (const marker of [
    'AIDRAW_E2E_FND09_OBSERVATION_CODEC_EXE_SHA256',
    'AIDRAW_E2E_FND09_OBSERVATION_CODEC_ASAR_SHA256',
    "AIDRAW_E2E_UTILITY_OBSERVATION_CODEC: '1'",
    "expect(toolNames).not.toContain('runE2eObservationCodecProbe')",
    "expect(toolNames).not.toContain('observation-codec-probe')",
    'crcValidStaticEnvelopeReachedFullDecode: true',
    'resultReturnedToCaller: false',
    'corruptUtilityPayloadNotPublished: true',
    'await quitGracefully(profile, child)',
    "authorityStatus).toBe('redacted-after-graceful-stop')",
  ]) {
    if (!scenario.includes(marker)) throw new Error(`Observation codec scenario is missing ${marker}.`);
  }
  if ((scenario.match(/const child = spawn\(packagedExecutable,/g) ?? []).length !== 1) {
    throw new Error('Observation codec scenario must retain exactly one package launch.');
  }
  for (const [label, source] of [
    ['bounded exit helper', waitHelper],
    ['graceful quit helper', quitHelper],
    ['scenario', scenario],
  ]) assertForceControlAbsent(label, source);

  return {
    scenario: 'FND-09-OBSERVATION-CODEC',
    onePackageLaunch: true,
    playwrightWatchdogDisabled: true,
    gracefulTimeoutRejectsWithoutControl: true,
    toolDiscoveryPrivate: true,
    corruptPayloadPrivate: true,
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
    contract: assertObservationCodecObserverNoForceSource(observerSource),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runObserverAudit(process.argv[2]), null, 2)}\n`);
}

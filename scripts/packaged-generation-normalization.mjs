import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAIN_MARKERS = [
  'AIDRAW_E2E_GENERATION_NORMALIZATION',
  'AIDRAW_E2E_FND09_NORMALIZATION_PROFILE',
  'FND-09 Generated Preview Normalization',
  'fnd09-normalizable-preview',
  'fnd09-preview-only-preview',
  'fnd09-generation-normalization-fixture-audit.json',
  'fnd09-generation-normalization-forbidden-network.json',
  'original preview is retained unchanged.',
];

const WORKER_MARKERS = [
  'normalize-generation-acceptance',
  'fnd09-generation-normalization-ready-probe.json',
  'fnd09-generation-normalization-preview-only-probe.json',
  'FND-09 packaged generated-preview acceptance normalization',
  'electron-utility-process',
];

const NORMALIZER_MARKERS = [
  'png-reencode',
  'webp-quality',
  'preview-only',
  'Generate a smaller result; AIDraw keeps this provider output available for preview and does not change the document.',
  'Generate a smaller or less complex result; AIDraw keeps this provider output available for preview and does not change the document.',
];

export function assertPackagedGenerationNormalizationSources({ mainSource, workerSource, buildSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 generation-normalization markers: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 generation-normalization markers: ${missingWorker.join(', ')}.`);
  const missingNormalizer = NORMALIZER_MARKERS.filter((marker) => !buildSource.includes(marker));
  if (missingNormalizer.length) throw new Error(`Packaged build is missing generated-preview normalization policy markers: ${missingNormalizer.join(', ')}.`);
  if (!buildSource.includes('[100,95,90,85,80,75,70,60,50,40,30,20,10,5,1,0]')) {
    throw new Error('Packaged build is missing the exact fixed generated-preview WebP quality ladder.');
  }
  if (!/(?:1500000|15e5)/.test(buildSource)) throw new Error('Packaged build is missing the established 1,500,000-byte acceptance ceiling.');
  return {
    isolatedFixture: true,
    realUtilityProbe: true,
    fixedQualityLadder: true,
    acceptanceCeiling: 1_500_000,
    retainedPreviewMessaging: true,
    previewOnlyGuidance: true,
  };
}

const OBSERVER_TITLE = "test('FND-09-GENERATION-NORMALIZATION exact package preserves previews and accepts only a bounded derivative'";
const FORCE_CONTROL_PATTERNS = [
  { label: 'kill/terminate method', pattern: /\.\s*(?:kill|terminate)\s*\(/i },
  { label: 'force signal', pattern: /\b(?:SIGKILL|SIGTERM)\b/i },
  { label: 'Windows process-control command', pattern: /\b(?:taskkill(?:\.exe)?|tskill|Stop-Process|TerminateProcess)\b/i },
  { label: 'POSIX force-kill command', pattern: /\bkill\s+-9\b/i },
];

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Observer source is missing ${label}.`);
  if (source.indexOf(startMarker, start + startMarker.length) >= 0) throw new Error(`Observer source repeats ${label}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Observer source cannot bound ${label}.`);
  return source.slice(start, end);
}

function assertForceControlAbsent(label, source) {
  const matched = FORCE_CONTROL_PATTERNS.find(({ pattern }) => pattern.test(source));
  if (matched) throw new Error(`FND-09 normalization ${label} regained forbidden force-control behavior (${matched.label}).`);
}

export function assertGenerationNormalizationObserverNoForceSource(observerSource) {
  const afterEach = sliceBetween(observerSource, 'test.afterEach(async () => {', 'async function reservePort', 'afterEach cleanup');
  const gracefulBranchStart = afterEach.indexOf('if (gracefulOnlyCleanup) {');
  const genericBranchStart = afterEach.indexOf('} else {', gracefulBranchStart);
  if (gracefulBranchStart < 0 || genericBranchStart < 0) throw new Error('Observer afterEach is missing the isolated graceful-only cleanup branch.');
  const gracefulAfterEach = afterEach.slice(gracefulBranchStart, genericBranchStart);
  if (!gracefulAfterEach.includes('await quitIsolatedEngineGracefully()')) throw new Error('Observer afterEach no longer delegates graceful-only cleanup to the isolated quit helper.');

  const signalHelper = sliceBetween(observerSource, 'async function signalExistingEngine', 'async function waitForOwnedProcessExit', 'profile-scoped signal helper');
  if (!signalHelper.includes("await waitForOwnedProcessExit(child, 'The isolated engine signal', 5_000);")) {
    throw new Error('The profile-scoped signal helper must reject through the bounded graceful wait helper.');
  }

  const waitHelper = sliceBetween(observerSource, 'async function waitForOwnedProcessExit', 'async function quitIsolatedEngineGracefully', 'bounded graceful wait helper');
  for (const marker of [
    'let settled = false',
    'clearTimeout(timer)',
    "child.removeListener('exit', onExit)",
    "child.removeListener('error', onError)",
    "child.once('exit', onExit)",
    "child.once('error', onError)",
    'reject(new Error(',
  ]) {
    if (!waitHelper.includes(marker)) throw new Error(`The bounded graceful wait helper is missing ${marker}.`);
  }

  const quitHelper = sliceBetween(observerSource, 'async function quitIsolatedEngineGracefully', 'function visualHash', 'isolated quit helper');
  for (const marker of [
    '`--user-data-dir=${profilePath}`',
    "'--quit-engine'",
    "await waitForOwnedProcessExit(signal, 'The isolated quit signal', 5_000);",
    "await waitForOwnedProcessExit(engine, 'The isolated AIDraw engine', 15_000);",
  ]) {
    if (!quitHelper.includes(marker)) throw new Error(`The isolated quit helper is missing ${marker}.`);
  }

  const observerStart = observerSource.indexOf(OBSERVER_TITLE);
  if (observerStart < 0 || observerSource.indexOf(OBSERVER_TITLE, observerStart + OBSERVER_TITLE.length) >= 0) {
    throw new Error('Observer source must contain exactly one FND-09 generation-normalization scenario.');
  }
  const observer = observerSource.slice(observerStart);
  const gracefulEnable = observer.indexOf('gracefulOnlyCleanup = true;');
  const launch = observer.indexOf('await launch(');
  if (gracefulEnable < 0 || launch < 0 || gracefulEnable > launch) {
    throw new Error('The normalization scenario must enable graceful-only cleanup before its only package launch.');
  }
  if ((observer.match(/gracefulOnlyCleanup\s*=\s*true\s*;/g) ?? []).length !== 1 || /gracefulOnlyCleanup\s*=\s*false\s*;/.test(observer)) {
    throw new Error('The normalization scenario must retain one monotonic graceful-only cleanup declaration.');
  }
  if ((observer.match(/await\s+launch\s*\(/g) ?? []).length !== 1) throw new Error('The normalization scenario must retain exactly one package launch.');
  const statusLocators = observer.match(/page\.getByRole\('status'\)[^;]*;/g) ?? [];
  const expectedStatusLocators = [
    "page.getByRole('status').filter({ hasText: 'outside the 8192px / 16777216-pixel editable-asset limit' });",
    "page.getByRole('status').filter({ hasText: 'Generated result accepted as a new editable layer/cel' });",
  ];
  if (statusLocators.length !== expectedStatusLocators.length || expectedStatusLocators.some((locator) => !statusLocators.includes(locator))) {
    throw new Error('The normalization scenario must target its two accessible status toasts by stable message instead of page-wide role uniqueness.');
  }
  for (const [label, source] of [
    ['graceful afterEach branch', gracefulAfterEach],
    ['profile-scoped signal helper', signalHelper],
    ['bounded graceful wait helper', waitHelper],
    ['isolated quit helper', quitHelper],
    ['scenario', observer],
  ]) assertForceControlAbsent(label, source);

  return {
    scenario: 'FND-09-GENERATION-NORMALIZATION',
    gracefulOnlyBeforeLaunch: true,
    signalTimeoutRejectsWithoutControl: true,
    quitTimeoutRejectsWithoutControl: true,
    gracefulAfterEachForceFree: true,
    accessibleToastTargeting: true,
    checkedSlices: 5,
  };
}

async function runObserverAudit(observerPathArgument) {
  const observerPath = resolve(observerPathArgument || 'tests/e2e/editor.spec.ts');
  const observerSource = await readFile(observerPath, 'utf8');
  return {
    observerPath,
    observerBytes: Buffer.byteLength(observerSource, 'utf8'),
    observerSha256: createHash('sha256').update(observerSource, 'utf8').digest('hex').toUpperCase(),
    contract: assertGenerationNormalizationObserverNoForceSource(observerSource),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runObserverAudit(process.argv[2]), null, 2)}\n`);
}

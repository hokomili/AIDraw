import { access, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');
const retainedRoot = resolve(repositoryRoot, 'test-results', 'retained');

export const QA08_TILED_CELL_BUDGET_CONTRACT_V2 = Object.freeze({
  optIn: 'qa08-tiled-cell-budget-v2',
  totalCells: 16_777_216,
  layerCells: 4_194_304,
  layerWidth: 2_048,
  layerHeight: 2_048,
  acceptedLayers: 4,
  rejectedCells: 16_777_217,
  childHeapMiB: 1_024,
  childTimeoutMs: 180_000,
  smokeTimeoutMs: 60_000,
  minimumTotalBytes: 4 * 1024 ** 3,
  minimumFreeBytes: 2 * 1024 ** 3,
  rootPattern: /^aidraw-qa08-tiled-cell-budget-optin-v2-[0-9]{8}T[0-9]{6}$/,
  smokeRootPattern: /^aidraw-qa08-tiled-cell-budget-cli-smoke-v2-[0-9]{8}T[0-9]{6}$/,
});

function validateRetainedRoot(root, pattern, message) {
  const resolved = resolve(root);
  if (dirname(resolved) !== retainedRoot || !pattern.test(relative(retainedRoot, resolved))) throw new Error(message);
  return resolved;
}

export function validateQa08CellBudgetPreflightV2(input) {
  const root = validateRetainedRoot(input.root, QA08_TILED_CELL_BUDGET_CONTRACT_V2.rootPattern, 'The QA-08 v2 root must be one new direct child of the retained test-results root.');
  const nodeMajor = Number(String(input.nodeVersion).split('.')[0]);
  if (input.optIn !== QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn) throw new Error('The exact QA-08 v2 high-memory opt-in acknowledgement is required.');
  if (input.mode !== 'run') throw new Error('The QA-08 v2 high-memory gate requires the explicit run mode.');
  if (nodeMajor !== 24) throw new Error(`QA-08 v2 requires pinned Node 24; received ${input.nodeVersion}.`);
  if (input.rootExists) throw new Error('The QA-08 v2 retained root must be absent before either high-memory child starts.');
  if (input.totalMemoryBytes < QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes) throw new Error('QA-08 v2 requires at least 4 GiB total host memory.');
  if (input.freeMemoryBytes < QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes) throw new Error('QA-08 v2 requires at least 2 GiB free host memory immediately before launch.');
  return { root, nodeMajor, totalMemoryBytes: input.totalMemoryBytes, freeMemoryBytes: input.freeMemoryBytes };
}

export function validateQa08CellBudgetSmokePreflightV2(input) {
  const root = validateRetainedRoot(input.root, QA08_TILED_CELL_BUDGET_CONTRACT_V2.smokeRootPattern, 'The QA-08 v2 smoke root must be one new direct child of the retained test-results root.');
  const nodeMajor = Number(String(input.nodeVersion).split('.')[0]);
  if (input.optIn !== QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn) throw new Error('The exact QA-08 v2 smoke acknowledgement is required.');
  if (nodeMajor !== 24) throw new Error(`QA-08 v2 smoke requires pinned Node 24; received ${input.nodeVersion}.`);
  if (input.rootExists) throw new Error('The QA-08 v2 smoke root must be absent before the tiny child starts.');
  return { root, nodeMajor };
}

export function qa08CellBudgetChildArgsV2(scenario) {
  if (!['accept', 'reject', 'smoke'].includes(scenario)) throw new Error(`Unknown QA-08 v2 scenario: ${scenario}`);
  return [
    `--max-old-space-size=${QA08_TILED_CELL_BUDGET_CONTRACT_V2.childHeapMiB}`,
    '--expose-gc',
    resolve(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--cache=false',
    '--config', resolve(repositoryRoot, 'scripts', 'vitest.qa08-tiled-cell-budget-v2.config.mjs'),
  ];
}

export function qa08CellBudgetChildEnvironmentV2(root, scenario, source = process.env) {
  const environment = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec']) if (source[name]) environment[name] = source[name];
  return {
    ...environment,
    AIDRAW_QA08_CELL_BUDGET_OPT_IN: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn,
    AIDRAW_QA08_CELL_BUDGET_ROOT: resolve(root),
    AIDRAW_QA08_CELL_BUDGET_SCENARIO: scenario,
    CI: '1',
    NO_COLOR: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
}

function expectedEvidence(root, scenario) {
  return resolve(root, `${scenario}-evidence.json`);
}

async function readEvidence(root, scenario) {
  const evidence = JSON.parse(await readFile(expectedEvidence(root, scenario), 'utf8'));
  const expectedCells = scenario === 'accept' ? QA08_TILED_CELL_BUDGET_CONTRACT_V2.totalCells : scenario === 'reject' ? QA08_TILED_CELL_BUDGET_CONTRACT_V2.rejectedCells : 1;
  if (evidence.contract !== QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn || evidence.scenario !== scenario || evidence.totalCells !== expectedCells) throw new Error(`QA-08 v2 ${scenario} evidence contradicts the frozen contract.`);
  if (scenario === 'accept' && (evidence.canonicalLayerCount !== 4 || evidence.error !== null)) throw new Error('QA-08 v2 exact-acceptance evidence is incomplete.');
  if (scenario === 'reject' && (evidence.canonicalLayerCount !== 0 || evidence.error !== 'Tiled layer data exceeds the 16,777,216-cell total import budget.')) throw new Error('QA-08 v2 over-budget evidence is incomplete.');
  if (scenario === 'smoke' && (evidence.canonicalLayerCount !== 1 || evidence.sampleGids?.[0] !== 7 || evidence.error !== null)) throw new Error('QA-08 v2 Vitest CLI smoke evidence is incomplete.');
  if (!Number.isFinite(evidence.durationMs) || evidence.durationMs <= 0 || !Number.isFinite(evidence.resources?.maxRss) || evidence.resources.maxRss <= 0) throw new Error(`QA-08 v2 ${scenario} resource evidence is missing.`);
  return evidence;
}

function runChild(root, scenario) {
  const timeout = scenario === 'smoke' ? QA08_TILED_CELL_BUDGET_CONTRACT_V2.smokeTimeoutMs : QA08_TILED_CELL_BUDGET_CONTRACT_V2.childTimeoutMs;
  const result = spawnSync(process.execPath, qa08CellBudgetChildArgsV2(scenario), {
    cwd: repositoryRoot,
    env: qa08CellBudgetChildEnvironmentV2(root, scenario),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout,
    killSignal: 'SIGTERM',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`QA-08 v2 ${scenario} child failed or exceeded its bounded timeout: ${result.error.message}`);
  if (result.signal) throw new Error(`QA-08 v2 ${scenario} child ended by ${result.signal}; retained evidence must be audited.`);
  if (result.status !== 0) throw new Error(`QA-08 v2 ${scenario} child exited ${result.status}.\n${result.stdout}\n${result.stderr}`);
}

export function runQa08CellBudgetSelfTestV2() {
  const fakeRoot = resolve(retainedRoot, 'aidraw-qa08-tiled-cell-budget-optin-v2-20990101T000000');
  const accepted = validateQa08CellBudgetPreflightV2({
    optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn,
    mode: 'run',
    nodeVersion: '24.0.0',
    root: fakeRoot,
    rootExists: false,
    totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes,
    freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes,
  });
  const rejected = [];
  for (const candidate of [
    { label: 'opt-in', optIn: '' },
    { label: 'mode', mode: 'self-test' },
    { label: 'node', nodeVersion: '23.9.0' },
    { label: 'existing-root', rootExists: true },
    { label: 'total-memory', totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes - 1 },
    { label: 'free-memory', freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes - 1 },
  ]) {
    try {
      validateQa08CellBudgetPreflightV2({ optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn, mode: 'run', nodeVersion: '24.0.0', root: fakeRoot, rootExists: false, totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes, freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes, ...candidate });
    } catch { rejected.push(candidate.label); }
  }
  if (rejected.length !== 6) throw new Error('QA-08 v2 preflight self-test did not fail closed for every unsafe case.');
  const args = qa08CellBudgetChildArgsV2('accept');
  if (!args.includes('--max-old-space-size=1024') || !args.includes('--expose-gc') || !args.includes('--cache=false') || args.some((argument) => argument.startsWith('--reporter'))) throw new Error('QA-08 v2 child startup contract is invalid.');
  return { childSpawned: false, rootCreated: false, acceptedRoot: accepted.root, rejected, timeoutMs: QA08_TILED_CELL_BUDGET_CONTRACT_V2.childTimeoutMs, reporterOverride: false };
}

async function pathExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function runSmoke() {
  const root = resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''));
  validateQa08CellBudgetSmokePreflightV2({
    optIn: process.env.AIDRAW_QA08_CELL_BUDGET_OPT_IN,
    nodeVersion: process.versions.node,
    root,
    rootExists: await pathExists(root),
  });
  runChild(root, 'smoke');
  const smoke = await readEvidence(root, 'smoke');
  process.stdout.write(`${JSON.stringify({ result: 'PASS', root, smoke })}\n`);
}

async function runGate() {
  const root = resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''));
  validateQa08CellBudgetPreflightV2({
    optIn: process.env.AIDRAW_QA08_CELL_BUDGET_OPT_IN,
    mode: 'run',
    nodeVersion: process.versions.node,
    root,
    rootExists: await pathExists(root),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  });
  runChild(root, 'accept');
  const accept = await readEvidence(root, 'accept');
  runChild(root, 'reject');
  const reject = await readEvidence(root, 'reject');
  const summaryPath = resolve(root, 'gate-summary.json');
  await writeFile(summaryPath, `${JSON.stringify({ contract: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn, node: process.version, executable: process.execPath, accept, reject }, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ result: 'PASS', root, summaryPath })}\n`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--self-test') { process.stdout.write(`${JSON.stringify(runQa08CellBudgetSelfTestV2())}\n`); return; }
  if (mode === '--describe') { process.stdout.write(`${JSON.stringify({ ...QA08_TILED_CELL_BUDGET_CONTRACT_V2, repositoryRoot, retainedRoot })}\n`); return; }
  if (mode === '--smoke') { await runSmoke(); return; }
  if (mode !== '--run') throw new Error('Use --self-test, --describe, --smoke, or the explicitly audited --run mode.');
  await runGate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });

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

export const QA08_TILED_CELL_BUDGET_CONTRACT = Object.freeze({
  optIn: 'qa08-tiled-cell-budget-v1',
  totalCells: 16_777_216,
  layerCells: 4_194_304,
  layerWidth: 2_048,
  layerHeight: 2_048,
  acceptedLayers: 4,
  rejectedCells: 16_777_217,
  childHeapMiB: 1_024,
  childTimeoutMs: 180_000,
  minimumTotalBytes: 4 * 1024 ** 3,
  minimumFreeBytes: 2 * 1024 ** 3,
  rootPattern: /^aidraw-qa08-tiled-cell-budget-optin-[0-9]{8}T[0-9]{6}$/,
});

export function validateQa08CellBudgetPreflight(input) {
  const root = resolve(input.root);
  const nodeMajor = Number(String(input.nodeVersion).split('.')[0]);
  if (input.optIn !== QA08_TILED_CELL_BUDGET_CONTRACT.optIn) throw new Error('The exact QA-08 high-memory opt-in acknowledgement is required.');
  if (input.mode !== 'run') throw new Error('The QA-08 high-memory gate requires the explicit run mode.');
  if (nodeMajor !== 24) throw new Error(`QA-08 requires pinned Node 24; received ${input.nodeVersion}.`);
  if (dirname(root) !== retainedRoot || !QA08_TILED_CELL_BUDGET_CONTRACT.rootPattern.test(relative(retainedRoot, root))) throw new Error('The QA-08 root must be one new direct child of the retained test-results root.');
  if (input.rootExists) throw new Error('The QA-08 retained root must be absent before either child starts.');
  if (input.totalMemoryBytes < QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes) throw new Error('QA-08 requires at least 4 GiB total host memory.');
  if (input.freeMemoryBytes < QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes) throw new Error('QA-08 requires at least 2 GiB free host memory immediately before launch.');
  return { root, nodeMajor, totalMemoryBytes: input.totalMemoryBytes, freeMemoryBytes: input.freeMemoryBytes };
}

export function qa08CellBudgetChildArgs(scenario) {
  if (!['accept', 'reject'].includes(scenario)) throw new Error(`Unknown QA-08 scenario: ${scenario}`);
  return [
    `--max-old-space-size=${QA08_TILED_CELL_BUDGET_CONTRACT.childHeapMiB}`,
    '--expose-gc',
    resolve(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--cache=false',
    '--config', resolve(repositoryRoot, 'scripts', 'vitest.qa08-tiled-cell-budget.config.mjs'),
    '--reporter=basic',
  ];
}

export function qa08CellBudgetChildEnvironment(root, scenario, source = process.env) {
  const environment = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec']) if (source[name]) environment[name] = source[name];
  return {
    ...environment,
    AIDRAW_QA08_CELL_BUDGET_OPT_IN: QA08_TILED_CELL_BUDGET_CONTRACT.optIn,
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
  const expectedCells = scenario === 'accept' ? QA08_TILED_CELL_BUDGET_CONTRACT.totalCells : QA08_TILED_CELL_BUDGET_CONTRACT.rejectedCells;
  if (evidence.contract !== QA08_TILED_CELL_BUDGET_CONTRACT.optIn || evidence.scenario !== scenario || evidence.totalCells !== expectedCells) throw new Error(`QA-08 ${scenario} evidence contradicts the frozen contract.`);
  if (scenario === 'accept' && (evidence.canonicalLayerCount !== 4 || evidence.error !== null)) throw new Error('QA-08 exact-acceptance evidence is incomplete.');
  if (scenario === 'reject' && (evidence.canonicalLayerCount !== 0 || evidence.error !== 'Tiled layer data exceeds the 16,777,216-cell total import budget.')) throw new Error('QA-08 over-budget evidence is incomplete.');
  if (!Number.isFinite(evidence.durationMs) || evidence.durationMs <= 0 || !Number.isFinite(evidence.resources?.maxRss) || evidence.resources.maxRss <= 0) throw new Error(`QA-08 ${scenario} resource evidence is missing.`);
  return evidence;
}

function runChild(root, scenario) {
  const result = spawnSync(process.execPath, qa08CellBudgetChildArgs(scenario), {
    cwd: repositoryRoot,
    env: qa08CellBudgetChildEnvironment(root, scenario),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: QA08_TILED_CELL_BUDGET_CONTRACT.childTimeoutMs,
    killSignal: 'SIGTERM',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`QA-08 ${scenario} child failed or exceeded its bounded timeout: ${result.error.message}`);
  if (result.signal) throw new Error(`QA-08 ${scenario} child ended by ${result.signal}; retained evidence must be audited.`);
  if (result.status !== 0) throw new Error(`QA-08 ${scenario} child exited ${result.status}.\n${result.stdout}\n${result.stderr}`);
}

export function runQa08CellBudgetSelfTest() {
  const fakeRoot = resolve(retainedRoot, 'aidraw-qa08-tiled-cell-budget-optin-20990101T000000');
  const accepted = validateQa08CellBudgetPreflight({
    optIn: QA08_TILED_CELL_BUDGET_CONTRACT.optIn,
    mode: 'run',
    nodeVersion: '24.0.0',
    root: fakeRoot,
    rootExists: false,
    totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes,
    freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes,
  });
  const rejected = [];
  for (const candidate of [
    { label: 'opt-in', optIn: '' },
    { label: 'mode', mode: 'self-test' },
    { label: 'node', nodeVersion: '23.9.0' },
    { label: 'existing-root', rootExists: true },
    { label: 'total-memory', totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes - 1 },
    { label: 'free-memory', freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes - 1 },
  ]) {
    try {
      validateQa08CellBudgetPreflight({ optIn: QA08_TILED_CELL_BUDGET_CONTRACT.optIn, mode: 'run', nodeVersion: '24.0.0', root: fakeRoot, rootExists: false, totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes, freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes, ...candidate });
    } catch { rejected.push(candidate.label); }
  }
  if (rejected.length !== 6) throw new Error('QA-08 preflight self-test did not fail closed for every unsafe case.');
  const args = qa08CellBudgetChildArgs('accept');
  if (!args.includes('--max-old-space-size=1024') || !args.includes('--expose-gc') || !args.includes('--cache=false')) throw new Error('QA-08 child resource bounds are missing.');
  return { childSpawned: false, rootCreated: false, acceptedRoot: accepted.root, rejected, timeoutMs: QA08_TILED_CELL_BUDGET_CONTRACT.childTimeoutMs };
}

async function pathExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function runGate() {
  const root = resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''));
  validateQa08CellBudgetPreflight({
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
  await writeFile(summaryPath, `${JSON.stringify({ contract: QA08_TILED_CELL_BUDGET_CONTRACT.optIn, node: process.version, executable: process.execPath, accept, reject }, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ result: 'PASS', root, summaryPath })}\n`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--self-test') { process.stdout.write(`${JSON.stringify(runQa08CellBudgetSelfTest())}\n`); return; }
  if (mode === '--describe') { process.stdout.write(`${JSON.stringify({ ...QA08_TILED_CELL_BUDGET_CONTRACT, repositoryRoot, retainedRoot })}\n`); return; }
  if (mode !== '--run') throw new Error('Use --self-test, --describe, or the explicitly audited --run mode.');
  await runGate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });

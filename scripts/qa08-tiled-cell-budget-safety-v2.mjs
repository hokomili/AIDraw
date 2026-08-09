import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function requireText(source, fragments, label) {
  for (const fragment of fragments) if (!source.includes(fragment)) throw new Error(`QA-08 v2 ${label} is missing: ${fragment}`);
}

function forbidText(source, patterns, label) {
  for (const pattern of patterns) if (pattern.test(source)) throw new Error(`QA-08 v2 ${label} contains forbidden behavior: ${pattern}`);
}

export async function assertQa08TiledCellBudgetGateV2(root = process.cwd()) {
  const controller = await readFile(resolve(root, 'scripts/qa08-tiled-cell-budget-gate-v2.mjs'), 'utf8');
  const config = await readFile(resolve(root, 'scripts/vitest.qa08-tiled-cell-budget-v2.config.mjs'), 'utf8');
  const acceptance = await readFile(resolve(root, 'tests/opt-in/qa08-tiled-cell-budget-v2.acceptance.ts'), 'utf8');
  const defaultConfig = await readFile(resolve(root, 'vitest.config.ts'), 'utf8');

  requireText(controller, [
    "optIn: 'qa08-tiled-cell-budget-v2'",
    'minimumTotalBytes: 4 * 1024 ** 3',
    'minimumFreeBytes: 2 * 1024 ** 3',
    'childHeapMiB: 1_024',
    'childTimeoutMs: 180_000',
    'smokeTimeoutMs: 60_000',
    "spawnSync(process.execPath",
    "killSignal: 'SIGTERM'",
    'shell: false',
    'windowsHide: true',
    "runChild(root, 'smoke')",
    "runChild(root, 'accept')",
    "runChild(root, 'reject')",
    'childSpawned: false',
    'rootCreated: false',
  ], 'controller contract');
  forbidText(controller, [/['"`]--reporter=basic['"`]\s*,/, /\bexec(?:File|Sync)?\s*\(/, /\bspawn\s*\(/, /process\.kill\s*\(/, /child\.kill\s*\(/, /taskkill/i, /Stop-Process/i, /\brm(?:Sync)?\s*\(/], 'controller');

  requireText(config, [
    "include: ['tests/opt-in/qa08-tiled-cell-budget-v2.acceptance.ts']",
    "cacheDir: resolve(String(process.env.AIDRAW_QA08_CELL_BUDGET_ROOT ?? ''), 'vite-cache')",
    "pool: 'threads'",
    'fileParallelism: false',
    'maxWorkers: 1',
    'minWorkers: 1',
    'testTimeout: 0',
  ], 'Vitest 4 dedicated config');
  forbidText(config, [/poolOptions/, /singleThread/, /reporters?\s*:/], 'Vitest 4 dedicated config');

  requireText(acceptance, [
    "const CONTRACT = 'qa08-tiled-cell-budget-v2'",
    'const LAYER_WIDTH = 2_048',
    'const LAYER_HEIGHT = 2_048',
    'const LAYER_CELLS = 4_194_304',
    'const TOTAL_CELLS = 16_777_216',
    "scenario === 'smoke'",
    "name: 'Vitest 4 CLI smoke'",
    "data: [7]",
    "await runSmoke(root); return",
    "Array.from({ length: 4 }",
    "name: 'Over-budget layer', width: 1, height: 1, data: [1]",
    "expect(error).toBe('Tiled layer data exceeds the 16,777,216-cell total import budget.')",
    "import { importDocument } from '@main/import-document'",
    "flag: 'wx'",
    "existing.some((name) => name !== 'vite-cache')",
  ], 'acceptance contract');
  forbidText(acceptance, [/node:http/, /node:https/, /\bfetch\s*\(/, /provider/i, /credential/i, /\brm\s*\(/, /process\.kill\s*\(/, /child_process/], 'acceptance');

  if (!defaultConfig.includes("include: ['tests/**/*.test.ts']")) throw new Error('QA-08 v2 cannot prove isolation from the default fast-suite pattern.');
  if (defaultConfig.includes('qa08-tiled-cell-budget-v2.acceptance.ts')) throw new Error('QA-08 v2 high-memory acceptance leaked into the default fast suite.');
  return {
    optInOnly: true,
    defaultSuiteExcluded: true,
    exactProductionImporter: true,
    exactAcceptedCells: 16_777_216,
    exactRejectedCells: 16_777_217,
    vitest4ReporterOverrideAbsent: true,
    vitest4PoolOptionsAbsent: true,
    tinySmokeBeforeHighMemory: true,
    boundedDirectChildTimeout: true,
    noShellOrCleanup: true,
    noNetworkProviderCredentialPath: true,
  };
}

async function sourceFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true }); const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`QA-08 v2 source manifest refuses symlink ${path}.`);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
    else if (/\.(?:ts|tsx|mts|mjs|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function qa08TiledCellBudgetSourceManifestV2(root = process.cwd()) {
  const paths = [
    ...await sourceFiles(root, resolve(root, 'src')),
    ...await sourceFiles(root, resolve(root, 'packages')),
    ...['package.json', 'package-lock.json', 'vitest.config.ts'].map((path) => resolve(root, path)),
  ].sort((left, right) => left.localeCompare(right));
  const lines = []; let bytes = 0;
  for (const path of paths) {
    const file = await stat(path); const data = await readFile(path); bytes += file.size;
    lines.push(`${relative(root, path).split(sep).join('/')}|${file.size}|${createHash('sha256').update(data).digest('hex').toUpperCase()}`);
  }
  return { files: paths.length, bytes, sha256: createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex').toUpperCase() };
}

async function main() {
  if (process.argv[2] === '--check') { process.stdout.write(`${JSON.stringify(await assertQa08TiledCellBudgetGateV2())}\n`); return; }
  if (process.argv[2] === '--manifest') { process.stdout.write(`${JSON.stringify(await qa08TiledCellBudgetSourceManifestV2())}\n`); return; }
  throw new Error('Use --check or --manifest.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });

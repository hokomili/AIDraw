import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QA08_TILED_CELL_BUDGET_CONTRACT_V2,
  qa08CellBudgetChildArgsV2,
  qa08CellBudgetChildEnvironmentV2,
  runQa08CellBudgetSelfTestV2,
  validateQa08CellBudgetPreflightV2,
  validateQa08CellBudgetSmokePreflightV2,
} from '../../scripts/qa08-tiled-cell-budget-gate-v2.mjs';
import { assertQa08TiledCellBudgetGateV2, qa08TiledCellBudgetSourceManifestV2 } from '../../scripts/qa08-tiled-cell-budget-safety-v2.mjs';

const retainedRoot = resolve('test-results', 'retained', 'aidraw-qa08-tiled-cell-budget-optin-v2-20990101T000000');
const smokeRoot = resolve('test-results', 'retained', 'aidraw-qa08-tiled-cell-budget-cli-smoke-v2-20990101T000000');

function validPreflight() {
  return {
    optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn,
    mode: 'run',
    nodeVersion: '24.0.0',
    root: retainedRoot,
    rootExists: false,
    totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes,
    freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes,
  };
}

describe('QA-08 v2 opt-in aggregate Tiled cell-budget gate', () => {
  it('fails closed before high-memory child creation on every unsafe preflight boundary', () => {
    expect(validateQa08CellBudgetPreflightV2(validPreflight())).toMatchObject({ nodeMajor: 24 });
    for (const mutation of [
      { optIn: '' },
      { mode: 'self-test' },
      { nodeVersion: '23.9.0' },
      { root: resolve('test-results', 'outside-root') },
      { rootExists: true },
      { totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumTotalBytes - 1 },
      { freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT_V2.minimumFreeBytes - 1 },
    ]) expect(() => validateQa08CellBudgetPreflightV2({ ...validPreflight(), ...mutation })).toThrow();
  });

  it('isolates the tiny compatibility-smoke root from the high-memory root', () => {
    expect(validateQa08CellBudgetSmokePreflightV2({ optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn, nodeVersion: '24.0.0', root: smokeRoot, rootExists: false })).toMatchObject({ nodeMajor: 24 });
    expect(() => validateQa08CellBudgetSmokePreflightV2({ optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn, nodeVersion: '24.0.0', root: retainedRoot, rootExists: false })).toThrow(/smoke root/);
    expect(() => validateQa08CellBudgetSmokePreflightV2({ optIn: QA08_TILED_CELL_BUDGET_CONTRACT_V2.optIn, nodeVersion: '24.0.0', root: smokeRoot, rootExists: true })).toThrow(/absent/);
  });

  it('builds the exact Vitest 4 child CLI without the removed reporter override', () => {
    const args = qa08CellBudgetChildArgsV2('accept');
    expect(args).toEqual(expect.arrayContaining(['--max-old-space-size=1024', '--expose-gc', 'run']));
    expect(args.some((argument) => argument.startsWith('--reporter'))).toBe(false);
    expect(args.at(-1)).toMatch(/vitest\.qa08-tiled-cell-budget-v2\.config\.mjs$/);
    expect(() => qa08CellBudgetChildArgsV2('other' as 'accept')).toThrow(/Unknown QA-08 v2 scenario/);
    const environment = qa08CellBudgetChildEnvironmentV2(retainedRoot, 'accept', { PATH: 'test-path', OPENAI_API_KEY: 'must-not-pass', NODE_OPTIONS: '--inspect', FORCE_COLOR: '1' });
    expect(environment).toMatchObject({ PATH: 'test-path', AIDRAW_QA08_CELL_BUDGET_SCENARIO: 'accept', NO_COLOR: '1', HTTP_PROXY: 'http://127.0.0.1:9' });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY'); expect(environment).not.toHaveProperty('NODE_OPTIONS'); expect(environment).not.toHaveProperty('FORCE_COLOR');
  });

  it('self-tests every guard without spawning a child or creating a root', () => {
    expect(runQa08CellBudgetSelfTestV2()).toEqual(expect.objectContaining({ childSpawned: false, rootCreated: false, rejected: ['opt-in', 'mode', 'node', 'existing-root', 'total-memory', 'free-memory'], timeoutMs: 180_000, reporterOverride: false }));
  });

  it('keeps the exact acceptance isolated and statically Vitest-4 compatible', async () => {
    await expect(assertQa08TiledCellBudgetGateV2()).resolves.toEqual({
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
    });
  });

  it('produces a deterministic current-source identity without reading output or evidence roots', async () => {
    const first = await qa08TiledCellBudgetSourceManifestV2(); const second = await qa08TiledCellBudgetSourceManifestV2();
    expect(first).toEqual(second); expect(first.files).toBeGreaterThan(100); expect(first.bytes).toBeGreaterThan(1_000_000); expect(first.sha256).toMatch(/^[A-F0-9]{64}$/);
  });
});

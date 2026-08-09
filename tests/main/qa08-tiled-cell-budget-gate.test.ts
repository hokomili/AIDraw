import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QA08_TILED_CELL_BUDGET_CONTRACT,
  qa08CellBudgetChildArgs,
  qa08CellBudgetChildEnvironment,
  runQa08CellBudgetSelfTest,
  validateQa08CellBudgetPreflight,
} from '../../scripts/qa08-tiled-cell-budget-gate.mjs';
import { assertQa08TiledCellBudgetGate, qa08TiledCellBudgetSourceManifest } from '../../scripts/qa08-tiled-cell-budget-safety.mjs';

const retainedRoot = resolve('test-results', 'retained', 'aidraw-qa08-tiled-cell-budget-optin-20990101T000000');

function validPreflight() {
  return {
    optIn: QA08_TILED_CELL_BUDGET_CONTRACT.optIn,
    mode: 'run',
    nodeVersion: '24.0.0',
    root: retainedRoot,
    rootExists: false,
    totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes,
    freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes,
  };
}

describe('QA-08 opt-in aggregate Tiled cell-budget gate', () => {
  it('fails closed before child creation on every unsafe preflight boundary', () => {
    expect(validateQa08CellBudgetPreflight(validPreflight())).toMatchObject({ nodeMajor: 24 });
    for (const mutation of [
      { optIn: '' },
      { mode: 'self-test' },
      { nodeVersion: '23.9.0' },
      { root: resolve('test-results', 'outside-root') },
      { rootExists: true },
      { totalMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumTotalBytes - 1 },
      { freeMemoryBytes: QA08_TILED_CELL_BUDGET_CONTRACT.minimumFreeBytes - 1 },
    ]) expect(() => validateQa08CellBudgetPreflight({ ...validPreflight(), ...mutation })).toThrow();
  });

  it('builds only the exact bounded direct-child invocation and sanitized environment', () => {
    expect(qa08CellBudgetChildArgs('accept')).toEqual(expect.arrayContaining(['--max-old-space-size=1024', '--expose-gc', 'run', '--reporter=basic']));
    expect(() => qa08CellBudgetChildArgs('other' as 'accept')).toThrow(/Unknown QA-08 scenario/);
    const environment = qa08CellBudgetChildEnvironment(retainedRoot, 'accept', { PATH: 'test-path', OPENAI_API_KEY: 'must-not-pass', NODE_OPTIONS: '--inspect' });
    expect(environment).toMatchObject({ PATH: 'test-path', AIDRAW_QA08_CELL_BUDGET_SCENARIO: 'accept', NO_COLOR: '1', HTTP_PROXY: 'http://127.0.0.1:9' });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY'); expect(environment).not.toHaveProperty('NODE_OPTIONS'); expect(environment).not.toHaveProperty('FORCE_COLOR');
  });

  it('self-tests every guard without spawning a child or creating a root', () => {
    expect(runQa08CellBudgetSelfTest()).toEqual(expect.objectContaining({ childSpawned: false, rootCreated: false, rejected: ['opt-in', 'mode', 'node', 'existing-root', 'total-memory', 'free-memory'], timeoutMs: 180_000 }));
  });

  it('keeps the exact high-memory acceptance isolated, static, local, and cleanup-free', async () => {
    await expect(assertQa08TiledCellBudgetGate()).resolves.toEqual({
      optInOnly: true,
      defaultSuiteExcluded: true,
      exactProductionImporter: true,
      exactAcceptedCells: 16_777_216,
      exactRejectedCells: 16_777_217,
      identityScopedTimeoutTermination: true,
      noShellOrCleanup: true,
      noNetworkProviderCredentialPath: true,
    });
  });

  it('produces a deterministic current-source identity without reading output or evidence roots', async () => {
    const first = await qa08TiledCellBudgetSourceManifest(); const second = await qa08TiledCellBudgetSourceManifest();
    expect(first).toEqual(second); expect(first.files).toBeGreaterThan(100); expect(first.bytes).toBeGreaterThan(1_000_000); expect(first.sha256).toMatch(/^[A-F0-9]{64}$/);
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertImportResultObserverNoForceSource,
  assertPackagedUtilityImportResultSources,
} from '../../scripts/packaged-utility-import-result.mjs';

const mainSource = [
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
].join('\n');

const workerSource = [
  'AIDRAW_E2E_UTILITY_IMPORT_RESULT',
  'e2eResultFault',
  'document-schema',
  'warning-shape',
  'The import-result probe requires the exact one-document real SVG importer baseline.',
  'The import-result probe is unavailable outside isolated packaged QA.',
].join('\n');

describe('packaged FND-09 import-result markers', () => {
  it('accepts only the complete private main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityImportResultSources({
      mainSource,
      workerSource,
      preloadSource: '',
      rendererSource: '',
    })).toEqual({
      isolatedMainHook: true,
      realUtilityFaultAfterImport: true,
      canonicalMigrationAndWarningGate: true,
      queuedFreshWorkerRecovery: true,
      preloadPrivate: true,
      rendererPrivate: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_IMPORT_RESULT', ''), workerSource, '', ''],
    ['document migration gate', mainSource.replace('Raster utility returned a malformed imported document.', ''), workerSource, '', ''],
    ['warning shape gate', mainSource.replace('Raster utility returned malformed import warnings.', ''), workerSource, '', ''],
    ['worker mutation', mainSource, workerSource.replace('e2eResultFault', ''), '', ''],
    ['real importer first', mainSource, workerSource.replace('The import-result probe requires the exact one-document real SVG importer baseline.', ''), '', ''],
    ['worker isolation guard', mainSource, workerSource.replace('The import-result probe is unavailable outside isolated packaged QA.', ''), '', ''],
    ['preload privacy', mainSource, workerSource, 'e2eResultFault', ''],
    ['renderer privacy', mainSource, workerSource, '', 'AIDRAW_E2E_UTILITY_IMPORT_RESULT'],
  ])('rejects a package missing or exposing the %s', (_label, candidateMain, candidateWorker, preloadSource, rendererSource) => {
    expect(() => assertPackagedUtilityImportResultSources({
      mainSource: candidateMain,
      workerSource: candidateWorker,
      preloadSource,
      rendererSource,
    })).toThrow(/FND-09/);
  });

  it('keeps one hash-bound, tools-private, transitively force-free packaged observer', async () => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(assertImportResultObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-IMPORT-RESULT',
      onePackageLaunch: true,
      playwrightWatchdogDisabled: true,
      gracefulTimeoutRejectsWithoutControl: true,
      toolDiscoveryPrivate: true,
      invalidPayloadPrivate: true,
      oneTestOwnedImportInput: true,
      zeroOutputTargets: true,
      checkedSlices: 3,
    });
  });

  it.each([
    ['helper kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); child.kill();"],
    [
      'Playwright timeout termination',
      "test(importResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(0);",
      "test(importResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(60_000);",
    ],
    [
      'scenario process kill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 import-result engine did not stop gracefully.'); }",
      "try { process.kill(child.pid!); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 import-result engine did not stop gracefully.'); }",
    ],
    [
      'Windows taskkill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 import-result engine did not stop gracefully.'); }",
      "try { spawn('taskkill.exe', ['/PID', String(child.pid)]); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 import-result engine did not stop gracefully.'); }",
    ],
  ])('rejects an import-result observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertImportResultObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });
});

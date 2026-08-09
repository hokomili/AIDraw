import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertExportResultObserverNoForceSource,
  assertPackagedUtilityExportResultSources,
} from '../../scripts/packaged-utility-export-result.mjs';

const mainSource = [
  'AIDRAW_E2E_UTILITY_EXPORT_RESULT',
  'AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE',
  'fnd09-export-result-probe.json',
  'fnd09-export-result-forbidden-network.json',
  'FND-09 packaged export artifact result containment',
  'runE2eExportResultProbe',
  'Raster utility returned a malformed export artifact.',
  'Raster utility returned a malformed export companion.',
  'rejectedBeforeCallerBase64Decode',
].join('\n');

const workerSource = [
  'AIDRAW_E2E_UTILITY_EXPORT_RESULT',
  'e2eArtifactFault',
  'primary-base64',
  'companion-base64',
  'The export-result probe requires the exact real sprite-sheet artifact and companion baseline.',
  'The export-result probe is unavailable outside isolated packaged QA.',
].join('\n');

describe('packaged FND-09 export-result markers', () => {
  it('accepts only the complete private main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityExportResultSources({
      mainSource,
      workerSource,
      preloadSource: '',
      rendererSource: '',
    })).toEqual({
      isolatedMainHook: true,
      realUtilityFaultAfterExport: true,
      serializedEnvelopeGateBeforeDecode: true,
      queuedFreshWorkerRecovery: true,
      preloadPrivate: true,
      rendererPrivate: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_EXPORT_RESULT', ''), workerSource, '', ''],
    ['primary result gate', mainSource.replace('Raster utility returned a malformed export artifact.', ''), workerSource, '', ''],
    ['companion result gate', mainSource.replace('Raster utility returned a malformed export companion.', ''), workerSource, '', ''],
    ['worker mutation', mainSource, workerSource.replace('e2eArtifactFault', ''), '', ''],
    ['real exporter first', mainSource, workerSource.replace('The export-result probe requires the exact real sprite-sheet artifact and companion baseline.', ''), '', ''],
    ['worker isolation guard', mainSource, workerSource.replace('The export-result probe is unavailable outside isolated packaged QA.', ''), '', ''],
    ['preload privacy', mainSource, workerSource, 'e2eArtifactFault', ''],
    ['renderer privacy', mainSource, workerSource, '', 'AIDRAW_E2E_UTILITY_EXPORT_RESULT'],
  ])('rejects a package missing or exposing the %s', (_label, candidateMain, candidateWorker, preloadSource, rendererSource) => {
    expect(() => assertPackagedUtilityExportResultSources({
      mainSource: candidateMain,
      workerSource: candidateWorker,
      preloadSource,
      rendererSource,
    })).toThrow(/FND-09/);
  });

  it('keeps one hash-bound, tools-private, transitively force-free packaged observer', async () => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(assertExportResultObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-EXPORT-RESULT',
      onePackageLaunch: true,
      playwrightWatchdogDisabled: true,
      gracefulTimeoutRejectsWithoutControl: true,
      toolDiscoveryPrivate: true,
      invalidPayloadPrivate: true,
      zeroExportTargets: true,
      checkedSlices: 3,
    });
  });

  it.each([
    ['helper kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); child.kill();"],
    [
      'Playwright timeout termination',
      "test(exportResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(0);",
      "test(exportResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(60_000);",
    ],
    [
      'scenario process kill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 export-result engine did not stop gracefully.'); }",
      "try { process.kill(child.pid!); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 export-result engine did not stop gracefully.'); }",
    ],
    [
      'Windows taskkill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 export-result engine did not stop gracefully.'); }",
      "try { spawn('taskkill.exe', ['/PID', String(child.pid)]); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 export-result engine did not stop gracefully.'); }",
    ],
  ])('rejects an export-result observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertExportResultObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });
});

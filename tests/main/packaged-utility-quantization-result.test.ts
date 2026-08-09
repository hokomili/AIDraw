import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPackagedUtilityQuantizationResultSources,
  assertQuantizationResultObserverNoForceSource,
} from '../../scripts/packaged-utility-quantization-result.mjs';

const mainSource = [
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
].join('\n');

const workerSource = [
  'AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT',
  'e2eResultFault',
  'over-budget',
  'contradictory',
  'The quantization-result probe requires the exact valid real-quantizer baseline.',
  'The quantization-result probe is unavailable outside isolated packaged QA.',
].join('\n');

describe('packaged FND-09 quantization-result markers', () => {
  it('accepts only the complete private main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityQuantizationResultSources({
      mainSource,
      workerSource,
      preloadSource: '',
      rendererSource: '',
    })).toEqual({
      isolatedMainHook: true,
      realUtilityFaultAfterQuantization: true,
      requestDerivedResultGate: true,
      queuedFreshWorkerRecovery: true,
      preloadPrivate: true,
      rendererPrivate: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT', ''), workerSource, '', ''],
    ['request-derived budget', mainSource.replace('Raster utility quantization result exceeds its ', ''), workerSource, '', ''],
    ['malformed result gate', mainSource.replace('Raster utility returned a malformed quantization result.', ''), workerSource, '', ''],
    ['worker mutation', mainSource, workerSource.replace('e2eResultFault', ''), '', ''],
    ['real quantization first', mainSource, workerSource.replace('The quantization-result probe requires the exact valid real-quantizer baseline.', ''), '', ''],
    ['worker isolation guard', mainSource, workerSource.replace('The quantization-result probe is unavailable outside isolated packaged QA.', ''), '', ''],
    ['preload privacy', mainSource, workerSource, 'e2eResultFault', ''],
    ['renderer privacy', mainSource, workerSource, '', 'AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT'],
  ])('rejects a package missing or exposing the %s', (_label, candidateMain, candidateWorker, preloadSource, rendererSource) => {
    expect(() => assertPackagedUtilityQuantizationResultSources({
      mainSource: candidateMain,
      workerSource: candidateWorker,
      preloadSource,
      rendererSource,
    })).toThrow(/FND-09/);
  });

  it('keeps one hash-bound, tools-private, transitively force-free packaged observer', async () => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(assertQuantizationResultObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-QUANTIZATION-RESULT',
      onePackageLaunch: true,
      playwrightWatchdogDisabled: true,
      gracefulTimeoutRejectsWithoutControl: true,
      toolDiscoveryPrivate: true,
      invalidPayloadPrivate: true,
      checkedSlices: 3,
    });
  });

  it.each([
    ['helper kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); child.kill();"],
    [
      'Playwright timeout termination',
      "test(quantizationResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(0);",
      "test(quantizationResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(60_000);",
    ],
    [
      'scenario process kill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 quantization-result engine did not stop gracefully.'); }",
      "try { process.kill(child.pid!); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 quantization-result engine did not stop gracefully.'); }",
    ],
    [
      'Windows taskkill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 quantization-result engine did not stop gracefully.'); }",
      "try { spawn('taskkill.exe', ['/PID', String(child.pid)]); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 quantization-result engine did not stop gracefully.'); }",
    ],
  ])('rejects a quantization-result observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertQuantizationResultObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });
});

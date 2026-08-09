import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertGenerationResultObserverNoForceSource,
  assertPackagedUtilityGenerationResultSources,
} from '../../scripts/packaged-utility-generation-result.mjs';

const mainSource = [
  'AIDRAW_E2E_UTILITY_GENERATION_RESULT',
  'AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE',
  'fnd09-generation-result-probe.json',
  'fnd09-generation-result-forbidden-network.json',
  'FND-09 packaged generation result containment',
  'runE2eGenerationResultProbe',
  'Generation utility returned more than the requested',
  'Generation utility returned a malformed image result.',
  'Generation utility returned a malformed result.',
  'rejectedBeforePreviewOrJobUse',
  'providerInvoked',
].join('\n');

const workerSource = [
  'AIDRAW_E2E_UTILITY_GENERATION_RESULT',
  'e2eResultFixture',
  'result-count',
  'mime-header',
  'dimension-header',
  'seed',
  'metadata',
  'local-deterministic',
  'The generation-result probe requires the exact provider-free local request baseline.',
  'The generation-result probe is unavailable outside isolated packaged QA.',
].join('\n');

describe('packaged FND-09 generation-result markers', () => {
  it('accepts only the complete private main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityGenerationResultSources({
      mainSource,
      workerSource,
      preloadSource: '',
      rendererSource: '',
    })).toEqual({
      isolatedMainHook: true,
      providerFreeLocalFixture: true,
      requestDerivedGenerationGate: true,
      queuedFreshWorkerRecovery: true,
      preloadPrivate: true,
      rendererPrivate: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_GENERATION_RESULT', ''), workerSource, '', ''],
    ['result-count gate', mainSource.replace('Generation utility returned more than the requested', ''), workerSource, '', ''],
    ['image gate', mainSource.replace('Generation utility returned a malformed image result.', ''), workerSource, '', ''],
    ['request gate', mainSource.replace('Generation utility returned a malformed result.', ''), workerSource, '', ''],
    ['worker fixture', mainSource, workerSource.replace('e2eResultFixture', ''), '', ''],
    ['provider-free baseline', mainSource, workerSource.replace('exact provider-free local request baseline', ''), '', ''],
    ['worker isolation guard', mainSource, workerSource.replace('unavailable outside isolated packaged QA', ''), '', ''],
    ['preload privacy', mainSource, workerSource, 'e2eResultFixture', ''],
    ['renderer privacy', mainSource, workerSource, '', 'AIDRAW_E2E_UTILITY_GENERATION_RESULT'],
  ])('rejects a package missing or exposing the %s', (_label, candidateMain, candidateWorker, preloadSource, rendererSource) => {
    expect(() => assertPackagedUtilityGenerationResultSources({
      mainSource: candidateMain,
      workerSource: candidateWorker,
      preloadSource,
      rendererSource,
    })).toThrow(/FND-09/);
  });

  it('keeps one hash-bound, tools-private, provider-free, transitively force-free observer', async () => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(assertGenerationResultObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-GENERATION-RESULT',
      onePackageLaunch: true,
      playwrightWatchdogDisabled: true,
      gracefulTimeoutRejectsWithoutControl: true,
      toolDiscoveryPrivate: true,
      invalidPayloadPrivate: true,
      providerFree: true,
      zeroInputOrOutputTargets: true,
      checkedSlices: 3,
    });
  });

  it.each([
    ['helper kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); child.kill();"],
    [
      'Playwright timeout termination',
      "test(generationResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(0);",
      "test(generationResultScenarioName, async () => {\n  // This audited observer must never let Playwright terminate its worker on a timeout.\n  // Every bounded wait below rejects without signaling either the app or quit helper.\n  test.setTimeout(60_000);",
    ],
    [
      'scenario process kill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 generation-result engine did not stop gracefully.'); }",
      "try { process.kill(child.pid!); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 generation-result engine did not stop gracefully.'); }",
    ],
    [
      'Windows taskkill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 generation-result engine did not stop gracefully.'); }",
      "try { spawn('taskkill.exe', ['/PID', String(child.pid)]); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 generation-result engine did not stop gracefully.'); }",
    ],
  ])('rejects a generation-result observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertGenerationResultObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });
});

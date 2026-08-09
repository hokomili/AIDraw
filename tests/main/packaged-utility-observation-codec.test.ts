import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertObservationCodecObserverNoForceSource,
  assertPackagedUtilityObservationCodecSources,
} from '../../scripts/packaged-utility-observation-codec.mjs';

const mainSource = [
  'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC',
  'AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE',
  'fnd09-observation-codec-probe.json',
  'fnd09-observation-codec-forbidden-network.json',
  'FND-09 packaged observation codec result containment',
  'Raster utility returned an undecodable observation image.',
].join('\n');

const workerSource = [
  'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC',
  'e2eCorruptIdat',
  'The observation codec probe is unavailable outside isolated packaged QA.',
  'The observation codec fixture requires one nonempty IDAT chunk.',
  'The observation codec probe requires one available PNG result.',
].join('\n');

describe('packaged FND-09 observation codec markers', () => {
  it('accepts only the complete private main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityObservationCodecSources({
      mainSource,
      workerSource,
      preloadSource: '',
      rendererSource: '',
    })).toEqual({
      isolatedMainHook: true,
      realUtilityCorruption: true,
      fullDecodeBoundary: true,
      preloadPrivate: true,
      rendererPrivate: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_OBSERVATION_CODEC', ''), workerSource, '', ''],
    ['main decoder boundary', mainSource.replace('Raster utility returned an undecodable observation image.', ''), workerSource, '', ''],
    ['worker mutation', mainSource, workerSource.replace('e2eCorruptIdat', ''), '', ''],
    ['worker isolation guard', mainSource, workerSource.replace('The observation codec probe is unavailable outside isolated packaged QA.', ''), '', ''],
    ['preload privacy', mainSource, workerSource, 'e2eCorruptIdat', ''],
    ['renderer privacy', mainSource, workerSource, '', 'AIDRAW_E2E_UTILITY_OBSERVATION_CODEC'],
  ])('rejects a package missing or exposing the %s', (_label, candidateMain, candidateWorker, preloadSource, rendererSource) => {
    expect(() => assertPackagedUtilityObservationCodecSources({
      mainSource: candidateMain,
      workerSource: candidateWorker,
      preloadSource,
      rendererSource,
    })).toThrow(/FND-09/);
  });

  it('keeps one hash-bound, tools-private, transitively force-free packaged observer', async () => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(assertObservationCodecObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-OBSERVATION-CODEC',
      onePackageLaunch: true,
      playwrightWatchdogDisabled: true,
      gracefulTimeoutRejectsWithoutControl: true,
      toolDiscoveryPrivate: true,
      corruptPayloadPrivate: true,
      checkedSlices: 3,
    });
  });

  it.each([
    ['helper kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); child.kill();"],
    [
      'Playwright timeout termination',
      'test.setTimeout(0);',
      'test.setTimeout(60_000);',
    ],
    [
      'scenario process kill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 observation codec engine did not stop gracefully.'); }",
      "try { process.kill(child.pid!); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 observation codec engine did not stop gracefully.'); }",
    ],
    [
      'Windows taskkill',
      "try { await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 observation codec engine did not stop gracefully.'); }",
      "try { spawn('taskkill.exe', ['/PID', String(child.pid)]); await quitGracefully(profile, child); }\n    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 observation codec engine did not stop gracefully.'); }",
    ],
  ])('rejects an observation codec observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/utility-containment.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertObservationCodecObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });
});

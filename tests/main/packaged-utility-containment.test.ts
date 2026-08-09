import { describe, expect, it } from 'vitest';
import { assertPackagedUtilityContainmentSources, findPackagedUtilityWorkerBundle } from '../../scripts/packaged-utility-containment.mjs';

const mainSource = [
  'AIDRAW_E2E_UTILITY_CONTAINMENT',
  'AIDRAW_E2E_FND09_UTILITY_PROFILE',
  'fnd09-utility-containment-probe.json',
  'fnd09-forbidden-network.json',
  'FND-09 packaged raster utility crash/cancel/restart containment',
].join('\n');

const workerSource = [
  'containment-probe',
  'utility-cancel',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
].join('\n');

describe('packaged FND-09 utility containment markers', () => {
  it('selects the implementation chunk instead of the Vite worker entry wrapper', () => {
    expect(findPackagedUtilityWorkerBundle([
      '/.vite/build/utility-worker.js',
      '/.vite/build/utility-worker-DaGYAr6L.js',
      '/.vite/build/main.js',
    ])).toBe('/.vite/build/utility-worker-DaGYAr6L.js');
    expect(() => findPackagedUtilityWorkerBundle(['/.vite/build/utility-worker.js'])).toThrow('bundle count is 0');
    expect(() => findPackagedUtilityWorkerBundle([
      '/.vite/build/utility-worker-one.js',
      '/.vite/build/utility-worker-two.js',
    ])).toThrow('bundle count is 2');
  });

  it('accepts only the complete main/worker checkpoint contract', () => {
    expect(assertPackagedUtilityContainmentSources({ mainSource, workerSource })).toEqual({
      isolatedMainHook: true,
      crashProbe: true,
      cancellationProbe: true,
      restartEvidence: true,
      providerPathAbsent: true,
    });
  });

  it.each([
    ['main hook', mainSource.replace('AIDRAW_E2E_UTILITY_CONTAINMENT', ''), workerSource],
    ['fixed evidence path', mainSource.replace('fnd09-utility-containment-probe.json', ''), workerSource],
    ['worker probe', mainSource, workerSource.replace('containment-probe', '')],
    ['worker crash', mainSource, workerSource.replace('process.crash', '')],
    ['worker cancellation', mainSource, workerSource.replace('utility-cancel', '')],
  ])('rejects a package missing the %s marker', (_label, candidateMain, candidateWorker) => {
    expect(() => assertPackagedUtilityContainmentSources({ mainSource: candidateMain, workerSource: candidateWorker })).toThrow(/missing FND-09/);
  });
});

import { describe, expect, it } from 'vitest';
import { assertPackagedUtilityPressureSources } from '../../scripts/packaged-utility-pressure.mjs';

const mainSource = [
  'AIDRAW_E2E_UTILITY_PRESSURE',
  'AIDRAW_E2E_FND09_PRESSURE_PROFILE',
  'fnd09-utility-pressure-probe.json',
  'fnd09-pressure-forbidden-network.json',
  'FND-09 packaged raster utility admission pressure containment',
  'const queueLimit=32;class Backpressure extends Error{code="utility_queue_full";retryable=!0;constructor(){super(`Utility queue reached the ${queueLimit}-task waiting limit. Retry after current work completes.`)}}',
  'Encoded image exceeds the utility input limit.',
].join('\n');

const workerSource = [
  'pressure-gate',
  'AIDRAW_E2E_UTILITY_PRESSURE',
  'The utility pressure probe is unavailable outside isolated packaged QA.',
].join('\n');

describe('packaged FND-09 utility pressure markers', () => {
  it('accepts only the complete fixed pressure checkpoint contract', () => {
    expect(assertPackagedUtilityPressureSources({ mainSource, workerSource })).toEqual({
      isolatedMainHook: true,
      fixedPressureGate: true,
      queueAdmission: true,
      quantizeAdmission: true,
    });
  });

  it.each([
    ['isolated main hook', mainSource.replace('AIDRAW_E2E_UTILITY_PRESSURE', ''), workerSource],
    ['fixed profile', mainSource.replace('AIDRAW_E2E_FND09_PRESSURE_PROFILE', ''), workerSource],
    ['queue admission', mainSource.replace('const queueLimit=32', 'const queueLimit=31'), workerSource],
    ['quantize admission', mainSource.replace('Encoded image exceeds the utility input limit.', ''), workerSource],
    ['fixed worker gate', mainSource, workerSource.replace('pressure-gate', '')],
    ['worker isolation guard', mainSource, workerSource.replace('The utility pressure probe is unavailable outside isolated packaged QA.', '')],
  ])('rejects a package missing the %s marker', (_label, candidateMain, candidateWorker) => {
    expect(() => assertPackagedUtilityPressureSources({ mainSource: candidateMain, workerSource: candidateWorker })).toThrow(/FND-09/);
  });
});

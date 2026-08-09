const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_PRESSURE',
  'AIDRAW_E2E_FND09_PRESSURE_PROFILE',
  'fnd09-utility-pressure-probe.json',
  'fnd09-pressure-forbidden-network.json',
  'FND-09 packaged raster utility admission pressure containment',
  'utility_queue_full',
  'Utility queue reached the ',
  '-task waiting limit. Retry after current work completes.',
  'Encoded image exceeds the utility input limit.',
];

const WORKER_MARKERS = [
  'pressure-gate',
  'AIDRAW_E2E_UTILITY_PRESSURE',
  'The utility pressure probe is unavailable outside isolated packaged QA.',
];

export function assertPackagedUtilityPressureSources({ mainSource, workerSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 utility pressure markers: ${missingMain.join(', ')}.`);
  const queueLimit = /const\s+([$_a-zA-Z][$_a-zA-Z0-9]*)=32;class[\s\S]{0,200}code="utility_queue_full"[\s\S]{0,300}`Utility queue reached the \$\{\1\}-task waiting limit\. Retry after current work completes\.`/.test(mainSource);
  if (!queueLimit) throw new Error('Packaged main process is missing the exact FND-09 32-waiter compiled queue contract.');
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 pressure markers: ${missingWorker.join(', ')}.`);
  return {
    isolatedMainHook: true,
    fixedPressureGate: true,
    queueAdmission: true,
    quantizeAdmission: true,
  };
}

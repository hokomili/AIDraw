const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_CONTAINMENT',
  'AIDRAW_E2E_FND09_UTILITY_PROFILE',
  'fnd09-utility-containment-probe.json',
  'fnd09-forbidden-network.json',
  'FND-09 packaged raster utility crash/cancel/restart containment',
];

const WORKER_MARKERS = [
  'containment-probe',
  'utility-cancel',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
];

export function findPackagedUtilityWorkerBundle(archiveFiles) {
  const matches = archiveFiles.filter((entry) => /^\/\.vite\/build\/utility-worker-[^/]+\.js$/.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Packaged raster utility implementation bundle count is ${matches.length}; expected exactly one.`);
  }
  return matches[0];
}

export function assertPackagedUtilityContainmentSources({ mainSource, workerSource }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 utility containment markers: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 containment markers: ${missingWorker.join(', ')}.`);
  return {
    isolatedMainHook: true,
    crashProbe: true,
    cancellationProbe: true,
    restartEvidence: true,
    providerPathAbsent: true,
  };
}

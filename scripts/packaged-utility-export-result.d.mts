export interface PackagedUtilityExportResultEvidence {
  isolatedMainHook: true;
  realUtilityFaultAfterExport: true;
  serializedEnvelopeGateBeforeDecode: true;
  queuedFreshWorkerRecovery: true;
  preloadPrivate: true;
  rendererPrivate: true;
}

export function assertPackagedUtilityExportResultSources(input: {
  mainSource: string;
  workerSource: string;
  preloadSource: string;
  rendererSource: string;
}): PackagedUtilityExportResultEvidence;

export function assertExportResultObserverNoForceSource(source: string): {
  scenario: 'FND-09-EXPORT-RESULT';
  onePackageLaunch: true;
  playwrightWatchdogDisabled: true;
  gracefulTimeoutRejectsWithoutControl: true;
  toolDiscoveryPrivate: true;
  invalidPayloadPrivate: true;
  zeroExportTargets: true;
  checkedSlices: 3;
};

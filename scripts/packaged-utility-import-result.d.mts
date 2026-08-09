export interface PackagedUtilityImportResultEvidence {
  isolatedMainHook: true;
  realUtilityFaultAfterImport: true;
  canonicalMigrationAndWarningGate: true;
  queuedFreshWorkerRecovery: true;
  preloadPrivate: true;
  rendererPrivate: true;
}

export function assertPackagedUtilityImportResultSources(input: {
  mainSource: string;
  workerSource: string;
  preloadSource: string;
  rendererSource: string;
}): PackagedUtilityImportResultEvidence;

export function assertImportResultObserverNoForceSource(source: string): {
  scenario: 'FND-09-IMPORT-RESULT';
  onePackageLaunch: true;
  playwrightWatchdogDisabled: true;
  gracefulTimeoutRejectsWithoutControl: true;
  toolDiscoveryPrivate: true;
  invalidPayloadPrivate: true;
  oneTestOwnedImportInput: true;
  zeroOutputTargets: true;
  checkedSlices: 3;
};

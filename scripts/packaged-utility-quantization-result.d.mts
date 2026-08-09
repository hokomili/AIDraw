export function assertPackagedUtilityQuantizationResultSources(input: {
  mainSource: string;
  workerSource: string;
  preloadSource: string;
  rendererSource: string;
}): {
  isolatedMainHook: true;
  realUtilityFaultAfterQuantization: true;
  requestDerivedResultGate: true;
  queuedFreshWorkerRecovery: true;
  preloadPrivate: true;
  rendererPrivate: true;
};

export function assertQuantizationResultObserverNoForceSource(observerSource: string): {
  scenario: 'FND-09-QUANTIZATION-RESULT';
  onePackageLaunch: true;
  playwrightWatchdogDisabled: true;
  gracefulTimeoutRejectsWithoutControl: true;
  toolDiscoveryPrivate: true;
  invalidPayloadPrivate: true;
  checkedSlices: 3;
};

export interface PackagedUtilityGenerationResultSources {
  mainSource: string;
  workerSource: string;
  preloadSource: string;
  rendererSource: string;
}

export interface PackagedUtilityGenerationResultContract {
  isolatedMainHook: true;
  providerFreeLocalFixture: true;
  requestDerivedGenerationGate: true;
  queuedFreshWorkerRecovery: true;
  preloadPrivate: true;
  rendererPrivate: true;
}

export interface GenerationResultObserverContract {
  scenario: 'FND-09-GENERATION-RESULT';
  onePackageLaunch: true;
  playwrightWatchdogDisabled: true;
  gracefulTimeoutRejectsWithoutControl: true;
  toolDiscoveryPrivate: true;
  invalidPayloadPrivate: true;
  providerFree: true;
  zeroInputOrOutputTargets: true;
  checkedSlices: 3;
}

export function assertPackagedUtilityGenerationResultSources(
  input: PackagedUtilityGenerationResultSources,
): PackagedUtilityGenerationResultContract;

export function assertGenerationResultObserverNoForceSource(observerSource: string): GenerationResultObserverContract;

export function assertPackagedUtilityObservationCodecSources(input: {
  mainSource: string;
  workerSource: string;
  preloadSource: string;
  rendererSource: string;
}): {
  isolatedMainHook: true;
  realUtilityCorruption: true;
  fullDecodeBoundary: true;
  preloadPrivate: true;
  rendererPrivate: true;
};

export function assertObservationCodecObserverNoForceSource(observerSource: string): {
  scenario: 'FND-09-OBSERVATION-CODEC';
  onePackageLaunch: true;
  playwrightWatchdogDisabled: true;
  gracefulTimeoutRejectsWithoutControl: true;
  toolDiscoveryPrivate: true;
  corruptPayloadPrivate: true;
  checkedSlices: 3;
};

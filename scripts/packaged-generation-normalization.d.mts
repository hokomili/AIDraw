export interface PackagedGenerationNormalizationSources {
  mainSource: string;
  workerSource: string;
  buildSource: string;
}

export function assertPackagedGenerationNormalizationSources(
  sources: PackagedGenerationNormalizationSources,
): {
  isolatedFixture: true;
  realUtilityProbe: true;
  fixedQualityLadder: true;
  acceptanceCeiling: 1_500_000;
  retainedPreviewMessaging: true;
  previewOnlyGuidance: true;
};

export function assertGenerationNormalizationObserverNoForceSource(
  observerSource: string,
): {
  scenario: 'FND-09-GENERATION-NORMALIZATION';
  gracefulOnlyBeforeLaunch: true;
  signalTimeoutRejectsWithoutControl: true;
  quitTimeoutRejectsWithoutControl: true;
  gracefulAfterEachForceFree: true;
  accessibleToastTargeting: true;
  checkedSlices: 5;
};

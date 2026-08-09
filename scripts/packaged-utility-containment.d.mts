export interface PackagedUtilityContainmentSources {
  mainSource: string;
  workerSource: string;
}

export interface PackagedUtilityContainmentReport {
  isolatedMainHook: true;
  crashProbe: true;
  cancellationProbe: true;
  restartEvidence: true;
  providerPathAbsent: true;
}

export function findPackagedUtilityWorkerBundle(archiveFiles: string[]): string;

export function assertPackagedUtilityContainmentSources(
  input: PackagedUtilityContainmentSources,
): PackagedUtilityContainmentReport;

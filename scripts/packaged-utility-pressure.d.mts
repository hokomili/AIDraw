export interface PackagedUtilityPressureSources {
  mainSource: string;
  workerSource: string;
}

export function assertPackagedUtilityPressureSources(
  sources: PackagedUtilityPressureSources,
): {
  isolatedMainHook: true;
  fixedPressureGate: true;
  queueAdmission: true;
  quantizeAdmission: true;
};

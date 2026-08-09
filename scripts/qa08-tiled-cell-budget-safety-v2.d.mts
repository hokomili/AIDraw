export interface Qa08TiledCellBudgetSafetyReportV2 {
  optInOnly: true;
  defaultSuiteExcluded: true;
  exactProductionImporter: true;
  exactAcceptedCells: 16_777_216;
  exactRejectedCells: 16_777_217;
  vitest4ReporterOverrideAbsent: true;
  vitest4PoolOptionsAbsent: true;
  tinySmokeBeforeHighMemory: true;
  boundedDirectChildTimeout: true;
  noShellOrCleanup: true;
  noNetworkProviderCredentialPath: true;
}
export function assertQa08TiledCellBudgetGateV2(root?: string): Promise<Qa08TiledCellBudgetSafetyReportV2>;
export function qa08TiledCellBudgetSourceManifestV2(root?: string): Promise<{ files: number; bytes: number; sha256: string }>;

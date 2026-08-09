export interface Qa08TiledCellBudgetSafetyReport {
  optInOnly: true;
  defaultSuiteExcluded: true;
  exactProductionImporter: true;
  exactAcceptedCells: 16_777_216;
  exactRejectedCells: 16_777_217;
  identityScopedTimeoutTermination: true;
  noShellOrCleanup: true;
  noNetworkProviderCredentialPath: true;
}
export function assertQa08TiledCellBudgetGate(root?: string): Promise<Qa08TiledCellBudgetSafetyReport>;
export function qa08TiledCellBudgetSourceManifest(root?: string): Promise<{ files: number; bytes: number; sha256: string }>;

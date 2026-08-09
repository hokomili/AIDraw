export interface Qa08CellBudgetPreflightInputV2 {
  optIn?: string;
  mode: string;
  nodeVersion: string;
  root: string;
  rootExists: boolean;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
}

export interface Qa08CellBudgetSmokePreflightInputV2 {
  optIn?: string;
  nodeVersion: string;
  root: string;
  rootExists: boolean;
}

export const QA08_TILED_CELL_BUDGET_CONTRACT_V2: Readonly<{
  optIn: string;
  totalCells: number;
  layerCells: number;
  layerWidth: number;
  layerHeight: number;
  acceptedLayers: number;
  rejectedCells: number;
  childHeapMiB: number;
  childTimeoutMs: number;
  smokeTimeoutMs: number;
  minimumTotalBytes: number;
  minimumFreeBytes: number;
  rootPattern: RegExp;
  smokeRootPattern: RegExp;
}>;
export function validateQa08CellBudgetPreflightV2(input: Qa08CellBudgetPreflightInputV2): { root: string; nodeMajor: number; totalMemoryBytes: number; freeMemoryBytes: number };
export function validateQa08CellBudgetSmokePreflightV2(input: Qa08CellBudgetSmokePreflightInputV2): { root: string; nodeMajor: number };
export function qa08CellBudgetChildArgsV2(scenario: 'accept' | 'reject' | 'smoke'): string[];
export function qa08CellBudgetChildEnvironmentV2(root: string, scenario: 'accept' | 'reject' | 'smoke', source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runQa08CellBudgetSelfTestV2(): { childSpawned: false; rootCreated: false; acceptedRoot: string; rejected: string[]; timeoutMs: number; reporterOverride: false };

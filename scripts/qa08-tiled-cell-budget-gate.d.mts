export interface Qa08CellBudgetPreflightInput {
  optIn?: string;
  mode: string;
  nodeVersion: string;
  root: string;
  rootExists: boolean;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
}

export const QA08_TILED_CELL_BUDGET_CONTRACT: Readonly<{
  optIn: string;
  totalCells: number;
  layerCells: number;
  layerWidth: number;
  layerHeight: number;
  acceptedLayers: number;
  rejectedCells: number;
  childHeapMiB: number;
  childTimeoutMs: number;
  minimumTotalBytes: number;
  minimumFreeBytes: number;
  rootPattern: RegExp;
}>;
export function validateQa08CellBudgetPreflight(input: Qa08CellBudgetPreflightInput): { root: string; nodeMajor: number; totalMemoryBytes: number; freeMemoryBytes: number };
export function qa08CellBudgetChildArgs(scenario: 'accept' | 'reject'): string[];
export function qa08CellBudgetChildEnvironment(root: string, scenario: 'accept' | 'reject', source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runQa08CellBudgetSelfTest(): { childSpawned: false; rootCreated: false; acceptedRoot: string; rejected: string[]; timeoutMs: number };

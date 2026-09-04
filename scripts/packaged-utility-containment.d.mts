export interface PackagedUtilityContainmentSources {
  mainSource: string;
  workerSource: string;
  expectedSubject?: 'reviewed-main-worker-pair-20260903-macos-background-lifecycle' | 'reviewed-main-worker-pair-20260825-published-pixel-tile-contract' | 'reviewed-main-worker-pair-20260825-authoring-contract' | 'reviewed-main-worker-pair-20260822' | 'maintained-unit-fixture';
}

export interface PackagedUtilityContainmentReport {
  assurance: 'exact-emitted-subject-identity-admission';
  admittedSubject: 'reviewed-main-worker-pair-20260903-macos-background-lifecycle' | 'reviewed-main-worker-pair-20260825-published-pixel-tile-contract' | 'reviewed-main-worker-pair-20260825-authoring-contract' | 'reviewed-main-worker-pair-20260822' | 'maintained-unit-fixture';
  identities: {
    main: { bytes: number; sha256: string };
    worker: { bytes: number; sha256: string };
  };
  analysisBoundary: {
    admission: 'sha256-and-byte-length-of-the-complete-extracted-main-and-worker-source-pair';
    driftPolicy: 'every-byte-change-fails-closed-until-a-fresh-review-pins-a-new-subject';
    semanticClaim: 'identity-only-not-general-javascript-control-flow-or-runtime-behavior-proof';
    currentAsarRuntimeEvidence: 'unearned';
  };
}

export interface PackagedUtilityContainmentAdversarialReport {
  assurance: 'exact-emitted-subject-drift-controls';
  rejectionBoundary: 'complete-main-or-worker-byte-drift-from-the-reviewed-subject';
  semanticClaim: 'mutation-rejection-by-exact-identity-not-general-javascript-interpretation';
  reachabilityNegativeCasesPerChunk: readonly string[];
  reachabilityNegativeMainCases: readonly string[];
  reachabilityNegativeWorkerCases: readonly string[];
  reachabilityChunks: readonly ['main', 'worker'];
  structuralNegativeCases: readonly string[];
  safeDriftCasesRequiringReview: readonly string[];
  unchangedReviewedSubjectReadmitted: true;
}

export function findPackagedUtilityWorkerBundle(archiveFiles: string[]): string;

export function assertPackagedUtilityContainmentSources(
  input: PackagedUtilityContainmentSources,
): PackagedUtilityContainmentReport;

export function assertPackagedUtilityContainmentAdversarialControls(
  input: PackagedUtilityContainmentSources,
): PackagedUtilityContainmentAdversarialReport;

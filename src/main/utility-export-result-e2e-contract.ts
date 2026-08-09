import type { SerializedExportArtifact } from './utility-contract';

export type Fnd09ExportResultFault = 'primary-base64' | 'companion-base64';

export const FND09_EXPORT_RESULT_E2E_HOLD_MS = 150;

export function isFnd09ExportResultE2eEnabled(input: { nodeEnv?: string; enabled?: string }): boolean {
  return input.nodeEnv === 'test' && input.enabled === '1';
}

export function isFnd09ExportResultFault(value: unknown): value is Fnd09ExportResultFault {
  return value === 'primary-base64' || value === 'companion-base64';
}

/**
 * Fixed packaged-QA mutation applied only after the production sprite-sheet
 * exporter produced both its primary PNG and JSON companion.
 */
export function createFnd09InvalidExportArtifact(
  artifact: SerializedExportArtifact,
  fault: Fnd09ExportResultFault,
): SerializedExportArtifact {
  if (!artifact.dataBase64 || !artifact.companion?.dataBase64) {
    throw new Error('The export-result probe requires the exact real sprite-sheet artifact and companion baseline.');
  }
  return fault === 'primary-base64'
    ? { ...artifact, dataBase64: 'not-canonical-base64' }
    : { ...artifact, companion: { ...artifact.companion, dataBase64: 'not-canonical-base64' } };
}

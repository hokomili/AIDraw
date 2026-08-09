import type { AIDrawDocument } from '@aidraw/core';

export type Fnd09ImportResultFault = 'document-schema' | 'warning-shape';

export const FND09_IMPORT_RESULT_E2E_HOLD_MS = 150;

export function isFnd09ImportResultE2eEnabled(input: { nodeEnv?: string; enabled?: string }): boolean {
  return input.nodeEnv === 'test' && input.enabled === '1';
}

export function isFnd09ImportResultFault(value: unknown): value is Fnd09ImportResultFault {
  return value === 'document-schema' || value === 'warning-shape';
}

/** Mutate only a completed production import result for isolated packaged QA. */
export function createFnd09InvalidImportResult(
  imported: { documents: AIDrawDocument[]; warnings: string[] },
  fault: Fnd09ImportResultFault,
): { documents: AIDrawDocument[]; warnings: unknown[] } {
  if (imported.documents.length !== 1 || imported.documents[0].kind !== 'illustration') {
    throw new Error('The import-result probe requires the exact one-document real SVG importer baseline.');
  }
  if (fault === 'document-schema') {
    return {
      documents: [{ ...imported.documents[0], schemaVersion: 3 } as unknown as AIDrawDocument],
      warnings: [...imported.warnings],
    };
  }
  return { documents: imported.documents, warnings: [17] };
}

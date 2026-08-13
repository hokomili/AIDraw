import type { AIDrawDocument } from '@aidraw/core';
import type {
  CheckpointComparisonResult,
  DocumentCheckpointRecord,
  DocumentCheckpointSummary,
} from '../common/contracts';
import { renderDocumentDimensions } from './render-document';
import { inspectImageHeader } from './transaction-policy';

export type CheckpointPngRenderer = (document: AIDrawDocument) => Promise<Buffer>;

function comparisonImage(document: AIDrawDocument, revision: number, bytes: Buffer): CheckpointComparisonResult['current'] {
  const expected = renderDocumentDimensions(document);
  let actual: ReturnType<typeof inspectImageHeader>;
  try {
    actual = inspectImageHeader(bytes);
  } catch {
    throw new Error('Checkpoint comparison renderer returned an invalid PNG.');
  }
  if (actual.mimeType !== 'image/png' || actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error('Checkpoint comparison renderer returned contradictory PNG geometry.');
  }
  return {
    revision,
    width: expected.width,
    height: expected.height,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  };
}

export async function buildCheckpointComparison(
  current: AIDrawDocument,
  checkpoint: DocumentCheckpointRecord,
  summary: DocumentCheckpointSummary,
  candidates: CheckpointComparisonResult['candidates'],
  renderPng: CheckpointPngRenderer,
): Promise<CheckpointComparisonResult> {
  if (checkpoint.documentId !== current.id || checkpoint.document.id !== current.id
    || summary.id !== checkpoint.id || summary.documentId !== checkpoint.documentId
    || checkpoint.document.revision !== checkpoint.sourceRevision) {
    throw new Error('Checkpoint comparison metadata is inconsistent.');
  }

  // The production gateway is a single-lane utility supervisor. Await each
  // snapshot explicitly so comparison never owns two native render tasks at once.
  const currentBytes = await renderPng(current);
  const currentImage = comparisonImage(current, current.revision, currentBytes);
  const savedBytes = await renderPng(checkpoint.document);
  const savedImage = comparisonImage(checkpoint.document, checkpoint.sourceRevision, savedBytes);
  return {
    checkpoint: structuredClone(summary),
    current: currentImage,
    saved: savedImage,
    candidates: structuredClone(candidates),
  };
}

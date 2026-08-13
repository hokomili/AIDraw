import { isDeepStrictEqual } from 'node:util';
import { ActorSchema } from '@aidraw/core';
import type { DocumentCheckpointRecord, DocumentCheckpointSummary } from '../common/contracts';

const CHECKPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const CHECKPOINT_SUMMARY_KEYS = new Set(['id', 'documentId', 'name', 'createdAt', 'createdBy', 'sourceRevision', 'kind']);
const CHECKPOINT_RECORD_KEYS = new Set([...CHECKPOINT_SUMMARY_KEYS, 'document']);
const StrictActorSchema = ActorSchema.strict();

type ParsedCheckpointRecord = Omit<DocumentCheckpointRecord, 'document'> & { document: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function parseCheckpointMetadata(
  value: Record<string, unknown>,
  expectedDocumentId?: string,
): DocumentCheckpointSummary | undefined {
  const actor = StrictActorSchema.safeParse(value.createdBy);
  if (typeof value.id !== 'string' || !CHECKPOINT_ID_PATTERN.test(value.id)
    || typeof value.documentId !== 'string' || !value.documentId
    || expectedDocumentId !== undefined && value.documentId !== expectedDocumentId
    || typeof value.name !== 'string' || !value.name.trim()
    || !isCanonicalIsoTimestamp(value.createdAt)
    || !actor.success
    || typeof value.sourceRevision !== 'number' || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0
    || value.kind !== 'manual' && value.kind !== 'automatic') return undefined;
  return {
    id: value.id,
    documentId: value.documentId,
    name: value.name,
    createdAt: value.createdAt,
    createdBy: actor.data,
    sourceRevision: value.sourceRevision,
    kind: value.kind,
  };
}

export function parseCheckpointSummary(value: unknown, expectedDocumentId?: string): DocumentCheckpointSummary | undefined {
  if (!isRecord(value) || !hasExactKeys(value, CHECKPOINT_SUMMARY_KEYS)) return undefined;
  return parseCheckpointMetadata(value, expectedDocumentId);
}

export function parseCheckpointRecord(value: unknown, expectedDocumentId?: string): ParsedCheckpointRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, CHECKPOINT_RECORD_KEYS) || !isRecord(value.document)) return undefined;
  const metadata = parseCheckpointMetadata(value, expectedDocumentId);
  return metadata ? { ...metadata, document: value.document } : undefined;
}

export function checkpointMetadataMatches(
  summary: DocumentCheckpointSummary,
  record: Omit<DocumentCheckpointRecord, 'document'>,
): boolean {
  return summary.id === record.id
    && summary.documentId === record.documentId
    && summary.name === record.name
    && summary.createdAt === record.createdAt
    && isDeepStrictEqual(summary.createdBy, record.createdBy)
    && summary.sourceRevision === record.sourceRevision
    && summary.kind === record.kind;
}

export function checkpointDocumentMatchesMetadata(
  metadata: Pick<DocumentCheckpointSummary, 'documentId' | 'sourceRevision'>,
  document: unknown,
): boolean {
  return isRecord(document) && document.id === metadata.documentId && document.revision === metadata.sourceRevision;
}

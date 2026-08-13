import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, createIllustrationDocument } from '@aidraw/core';
import {
  checkpointDocumentMatchesMetadata,
  checkpointMetadataMatches,
  parseCheckpointRecord,
  parseCheckpointSummary,
} from '@main/checkpoint-policy';

const document = createIllustrationDocument('Checkpoint policy fixture');
document.revision = 7;
const summary = {
  id: 'checkpoint-policy',
  documentId: document.id,
  name: 'Before restore · Review branch',
  createdAt: '2026-08-12T03:04:05.006Z',
  createdBy: HUMAN_ACTOR,
  sourceRevision: document.revision,
  kind: 'automatic' as const,
};

describe('checkpoint policy', () => {
  it('accepts the exact writer metadata and rejects malformed or expanded summary envelopes', () => {
    expect(parseCheckpointSummary(summary, document.id)).toEqual(summary);
    const invalid = [
      null,
      [],
      { ...summary, extra: true },
      { ...summary, id: '../checkpoint' },
      { ...summary, documentId: 'document-other' },
      { ...summary, name: '   ' },
      { ...summary, createdAt: '2026-08-12T03:04:05Z' },
      { ...summary, createdBy: { ...HUMAN_ACTOR, extra: true } },
      { ...summary, createdBy: { ...HUMAN_ACTOR, color: 'pink' } },
      { ...summary, sourceRevision: -1 },
      { ...summary, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...summary, kind: 'imported' },
    ];
    for (const value of invalid) expect(parseCheckpointSummary(value, document.id)).toBeUndefined();
  });

  it('requires an exact record, identical index metadata, and the captured document revision', () => {
    const record = { ...summary, document };
    const parsedSummary = parseCheckpointSummary(summary, document.id);
    const parsedRecord = parseCheckpointRecord(record, document.id);
    expect(parsedSummary).toEqual(summary);
    expect(parsedRecord).toEqual(record);
    expect(checkpointMetadataMatches(parsedSummary!, parsedRecord!)).toBe(true);
    expect(checkpointDocumentMatchesMetadata(parsedRecord!, document)).toBe(true);

    expect(parseCheckpointRecord({ ...record, extra: true }, document.id)).toBeUndefined();
    expect(parseCheckpointRecord({ ...summary, document: null }, document.id)).toBeUndefined();
    expect(checkpointMetadataMatches(parsedSummary!, { ...parsedRecord!, name: 'Different branch' })).toBe(false);
    expect(checkpointMetadataMatches(parsedSummary!, { ...parsedRecord!, createdBy: { ...HUMAN_ACTOR, id: 'agent-other' } })).toBe(false);
    expect(checkpointDocumentMatchesMetadata(parsedRecord!, { ...document, revision: document.revision + 1 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, nowIso, type CanvasTransaction } from '@aidraw/core';
import type { TransactionTraceEntry } from '@common/contracts';
import { MAX_TRANSACTION_SERIALIZED_BYTES } from '@common/transaction-limits';
import { parseTransactionTraceEntry, parseTransactionTraceJsonl } from '@main/trace-policy';

function fixture(): TransactionTraceEntry {
  const documentId = 'document-trace-policy-fixture';
  const transaction: CanvasTransaction = {
    id: 'trace-policy-transaction', clientOperationId: 'trace-policy-operation', documentId, actor: HUMAN_ACTOR,
    label: 'Trace policy fixture', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Trace policy fixture' }],
  };
  return { version: 1, documentId, revision: 1, recordedAt: nowIso(), outcome: 'committed', transaction };
}

describe('durable transaction trace policy', () => {
  it('accepts only the exact writer envelope and canonical bounded transaction', () => {
    const valid = fixture();
    expect(parseTransactionTraceEntry(valid, valid.documentId)).toEqual(valid);
    const missingVersion = structuredClone(valid) as unknown as Record<string, unknown>; delete missingVersion.version;
    const malformed: Array<[string, unknown]> = [
      ['non-record', null],
      ['missing field', missingVersion],
      ['extra field', { ...valid, extra: true }],
      ['future version', { ...valid, version: 2 }],
      ['empty document ID', { ...valid, documentId: '' }],
      ['foreign expected document', valid],
      ['negative revision', { ...valid, revision: -1 }],
      ['fractional revision', { ...valid, revision: 1.5 }],
      ['unsafe revision', { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }],
      ['noncanonical timestamp', { ...valid, recordedAt: '2026-08-12T00:00:00Z' }],
      ['unknown outcome', { ...valid, outcome: 'replayed' }],
      ['missing transaction', { ...valid, transaction: undefined }],
      ['foreign transaction document', { ...valid, transaction: { ...valid.transaction, documentId: 'document-other' } }],
      ['invalid canonical operation', { ...valid, transaction: { ...valid.transaction, operations: [{ kind: 'document.rename', name: '' }] } }],
      ['too many operations', { ...valid, transaction: { ...valid.transaction, operations: Array.from({ length: 257 }, () => ({ kind: 'document.rename', name: 'Bounded' })) } }],
      ['invalid actor', { ...valid, transaction: { ...valid.transaction, actor: { ...valid.transaction.actor, kind: 'guest' } } }],
    ];
    for (const [name, value] of malformed) {
      const expectedDocumentId = name === 'foreign expected document' ? 'document-other' : valid.documentId;
      expect({ name, accepted: Boolean(parseTransactionTraceEntry(value, expectedDocumentId)) }).toEqual({ name, accepted: false });
    }
  });

  it('keeps the exact 2 MiB transaction boundary and aggregates tiny-line rejection', () => {
    const valid = fixture();
    const exactTransaction = {
      ...valid.transaction,
      operations: [{ kind: 'document.rename', name: 'Bounded', padding: '' }],
    } as unknown as CanvasTransaction;
    const paddingLength = MAX_TRANSACTION_SERIALIZED_BYTES - Buffer.byteLength(JSON.stringify(exactTransaction), 'utf8');
    (exactTransaction.operations[0] as unknown as { padding: string }).padding = 'x'.repeat(paddingLength);
    const exact = { ...valid, transaction: exactTransaction };
    const oversized = structuredClone(exact) as TransactionTraceEntry;
    (oversized.transaction.operations[0] as unknown as { padding: string }).padding += 'x';
    const source = `${JSON.stringify(exact)}\r\n${Array.from({ length: 10_000 }, () => '{}').join('\n')}\n${JSON.stringify(oversized)}\n`;
    const parsed = parseTransactionTraceJsonl(source, valid.documentId);
    expect(Buffer.byteLength(JSON.stringify(exactTransaction), 'utf8')).toBe(MAX_TRANSACTION_SERIALIZED_BYTES);
    expect(parsed.entries).toEqual([exact]);
    expect(parsed.ignored).toBe(10_001);
  });
});

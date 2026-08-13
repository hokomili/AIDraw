import { CanvasTransactionSchema } from '@aidraw/core';
import type { TransactionTraceEntry } from '../common/contracts';
import { MAX_TRANSACTION_SERIALIZED_BYTES } from '../common/transaction-limits';

const TRACE_VERSION = 1 as const;
const TRACE_ENTRY_KEYS = new Set(['version', 'documentId', 'revision', 'recordedAt', 'outcome', 'transaction']);
// The required compact JSON keys alone make every valid record longer than this; skip tiny-line bombs without parsing each fragment.
const MIN_TRACE_ENTRY_CHARACTERS = 240;
// The 2 MiB transaction may repeat its document ID in the envelope; leave 4 KiB for fixed trace metadata.
const MAX_TRACE_ENTRY_BYTES = MAX_TRANSACTION_SERIALIZED_BYTES * 2 + 4 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function parseTransactionTraceEntry(value: unknown, expectedDocumentId?: string): TransactionTraceEntry | undefined {
  if (!isRecord(value) || Object.keys(value).length !== TRACE_ENTRY_KEYS.size || Object.keys(value).some((key) => !TRACE_ENTRY_KEYS.has(key))) return undefined;
  if (value.version !== TRACE_VERSION || typeof value.documentId !== 'string' || !value.documentId
    || expectedDocumentId !== undefined && value.documentId !== expectedDocumentId
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !isCanonicalIsoTimestamp(value.recordedAt)
    || value.outcome !== 'committed' && value.outcome !== 'partial' && value.outcome !== 'undo' && value.outcome !== 'redo') return undefined;
  const transaction = CanvasTransactionSchema.safeParse(value.transaction);
  if (!transaction.success || transaction.data.documentId !== value.documentId) return undefined;
  let transactionBytes: number;
  try { transactionBytes = Buffer.byteLength(JSON.stringify(transaction.data), 'utf8'); } catch { return undefined; }
  if (transactionBytes > MAX_TRANSACTION_SERIALIZED_BYTES) return undefined;
  return {
    version: TRACE_VERSION,
    documentId: value.documentId,
    revision: value.revision,
    recordedAt: value.recordedAt,
    outcome: value.outcome,
    transaction: transaction.data,
  };
}

export function parseTransactionTraceJsonl(source: string, expectedDocumentId?: string): { entries: TransactionTraceEntry[]; ignored: number } {
  const entries: TransactionTraceEntry[] = [];
  let ignored = 0;
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    let end = newline < 0 ? source.length : newline;
    if (end > start && source.charCodeAt(end - 1) === 13) end -= 1;
    const characters = end - start;
    if (characters > 0) {
      if (characters < MIN_TRACE_ENTRY_CHARACTERS || characters > MAX_TRACE_ENTRY_BYTES) ignored += 1;
      else {
        const line = source.slice(start, end);
        if (Buffer.byteLength(line, 'utf8') > MAX_TRACE_ENTRY_BYTES) ignored += 1;
        else {
          try {
            const entry = parseTransactionTraceEntry(JSON.parse(line), expectedDocumentId);
            if (entry) entries.push(entry); else ignored += 1;
          } catch { ignored += 1; }
        }
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return { entries, ignored };
}

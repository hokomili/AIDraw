import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TransactionTraceEntry } from '../common/contracts';

const TRACE_VERSION = 1 as const;

function isTraceEntry(value: unknown): value is TransactionTraceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<TransactionTraceEntry>;
  return entry.version === TRACE_VERSION
    && typeof entry.documentId === 'string'
    && typeof entry.revision === 'number'
    && typeof entry.recordedAt === 'string'
    && typeof entry.outcome === 'string'
    && Boolean(entry.transaction && typeof entry.transaction === 'object');
}

/**
 * Append-only transaction history kept separately from the compacting recovery
 * journal. The hashed filename prevents document IDs imported from untrusted
 * files from becoming filesystem paths.
 */
export class TransactionTraceStore {
  constructor(private readonly root: string) {}

  async append(entry: Omit<TransactionTraceEntry, 'version' | 'recordedAt'> & { recordedAt?: string }): Promise<void> {
    const record: TransactionTraceEntry = {
      ...structuredClone(entry),
      version: TRACE_VERSION,
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
    };
    const path = this.tracePath(record.documentId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async list(documentId: string, limit = Number.POSITIVE_INFINITY): Promise<TransactionTraceEntry[]> {
    let source: string;
    try { source = await readFile(this.tracePath(documentId), 'utf8'); } catch { return []; }
    const entries: TransactionTraceEntry[] = [];
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as unknown;
        if (isTraceEntry(value) && value.documentId === documentId) entries.push(value);
      } catch {
        // A partial final write must not hide earlier valid trace records.
      }
    }
    const selected = Number.isFinite(limit) ? entries.slice(-Math.max(0, limit)) : entries;
    return selected.map((entry) => structuredClone(entry));
  }

  async find(documentId: string, transactionId: string): Promise<TransactionTraceEntry | undefined> {
    return (await this.list(documentId)).findLast((entry) => entry.transaction.id === transactionId);
  }

  async import(documentId: string, entries: TransactionTraceEntry[]): Promise<number> {
    const existing = new Set((await this.list(documentId)).map((entry) => `${entry.transaction.id}:${entry.revision}:${entry.outcome}`));
    let imported = 0;
    for (const entry of entries) {
      if (!isTraceEntry(entry) || entry.documentId !== documentId) continue;
      const key = `${entry.transaction.id}:${entry.revision}:${entry.outcome}`;
      if (existing.has(key)) continue;
      await this.append(entry);
      existing.add(key);
      imported += 1;
    }
    return imported;
  }

  private tracePath(documentId: string): string {
    const key = createHash('sha256').update(documentId).digest('hex');
    return join(this.root, `${key}.jsonl`);
  }
}

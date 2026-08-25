import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TransactionTraceEntry } from '../common/contracts';
import { parseTransactionTraceEntry, parseTransactionTraceJsonl } from './trace-policy';

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
      version: 1,
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
    };
    const parsed = parseTransactionTraceEntry(record);
    if (!parsed) throw new Error('AIDraw transaction trace contains an invalid entry.');
    const path = this.tracePath(record.documentId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async list(documentId: string, limit = Number.POSITIVE_INFINITY): Promise<TransactionTraceEntry[]> {
    let source: string;
    try { source = await readFile(this.tracePath(documentId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = parseTransactionTraceJsonl(source, documentId).entries;
    const selected = Number.isFinite(limit) ? entries.slice(-Math.max(0, limit)) : entries;
    return selected.map((entry) => structuredClone(entry));
  }

  async find(documentId: string, transactionId: string): Promise<TransactionTraceEntry | undefined> {
    return (await this.list(documentId)).findLast((entry) => entry.transaction.id === transactionId);
  }

  async import(documentId: string, entries: TransactionTraceEntry[]): Promise<number> {
    const existing = new Set((await this.list(documentId)).map((entry) => `${entry.transaction.id}:${entry.revision}:${entry.outcome}`));
    const accepted: TransactionTraceEntry[] = [];
    let imported = 0;
    for (const entry of entries) {
      const parsed = parseTransactionTraceEntry(entry, documentId);
      if (!parsed) continue;
      const key = `${parsed.transaction.id}:${parsed.revision}:${parsed.outcome}`;
      if (existing.has(key)) continue;
      accepted.push(parsed);
      existing.add(key);
      imported += 1;
    }
    if (accepted.length) {
      const path = this.tracePath(documentId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${accepted.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    return imported;
  }

  private tracePath(documentId: string): string {
    const key = createHash('sha256').update(documentId).digest('hex');
    return join(this.root, `${key}.jsonl`);
  }
}

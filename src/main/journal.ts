import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CanvasTransactionSchema, applyTransaction, migrateDocument, type AIDrawDocument, type CanvasTransaction } from '@aidraw/core';

export class RecoveryJournal {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private journalPath(documentId: string): string {
    return join(this.root, `${documentId}.jsonl`);
  }

  private enqueue(documentId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(documentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    this.writeQueues.set(documentId, current);
    return current.finally(() => { if (this.writeQueues.get(documentId) === current) this.writeQueues.delete(documentId); });
  }

  append(documentId: string, transaction: CanvasTransaction): Promise<void> {
    return this.enqueue(documentId, async () => {
      const path = this.journalPath(documentId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify({ type: 'transaction', transaction })}\n`, 'utf8');
    });
  }

  compact(document: AIDrawDocument): Promise<void> {
    return this.enqueue(document.id, async () => {
      const path = this.journalPath(document.id);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${JSON.stringify({ type: 'snapshot', document })}\n`, 'utf8');
      await rename(temp, path);
    });
  }

  remove(documentId: string): Promise<void> {
    return this.enqueue(documentId, async () => {
      const path = this.journalPath(documentId);
      await Promise.all([path, `${path}.tmp`].map(async (candidate) => {
        try {
          await unlink(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }));
    });
  }

  async recover(): Promise<AIDrawDocument[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return []; }
    const recovered: AIDrawDocument[] = [];
    for (const entry of entries.filter((value) => value.endsWith('.jsonl'))) {
      try {
        const records = (await readFile(join(this.root, entry), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type: string; document?: unknown; transaction?: CanvasTransaction });
        const snapshotIndex = records.findLastIndex((record) => record.type === 'snapshot' && record.document);
        if (snapshotIndex < 0) continue;
        let document = migrateDocument(records[snapshotIndex].document);
        for (const record of records.slice(snapshotIndex + 1)) {
          if (record.type !== 'transaction' || !record.transaction) continue;
          const parsed = CanvasTransactionSchema.safeParse(record.transaction);
          if (parsed.success) document = applyTransaction(document, parsed.data).document;
        }
        document.dirty = true;
        if (basename(entry, '.jsonl') === document.id) recovered.push(document);
      } catch {
        // A corrupt journal is isolated; the remaining documents can still recover.
      }
    }
    return recovered;
  }

  async read(documentId: string): Promise<string[]> {
    await this.writeQueues.get(documentId)?.catch(() => undefined);
    try {
      return (await readFile(this.journalPath(documentId), 'utf8')).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writeQueues.values()]);
  }
}

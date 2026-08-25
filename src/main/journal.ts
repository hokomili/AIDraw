import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasTransactionSchema, applyTransaction, migrateDocument, type AIDrawDocument, type CanvasTransaction } from '@aidraw/core';
import { assertStrictNativeEditableTransaction } from './transaction-policy';

const WORKSPACE_FILE = 'workspace.json';
const WORKSPACE_QUEUE = Symbol('workspace');
const JOURNAL_PREFIX = 'document-';
const LEGACY_SNAPSHOT_RECORD_KEYS = new Set(['type', 'document']);
const SNAPSHOT_RECORD_KEYS = new Set(['type', 'document', 'incarnationId']);
const TRANSACTION_RECORD_KEYS = new Set(['type', 'transaction']);
const WORKSPACE_KEYS = new Set(['version', 'documentIds', 'activeDocumentId']);

interface PersistedWorkspace {
  version: 1;
  documentIds: string[];
  activeDocumentId?: string;
}

export interface RecoveredWorkspace {
  documents: AIDrawDocument[];
  documentIncarnations: Record<string, string>;
  activeDocumentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function journalFilename(documentId: string): string {
  const key = createHash('sha256').update(documentId).digest('hex');
  return `${JOURNAL_PREFIX}${key}.jsonl`;
}

function legacyJournalFilename(documentId: string): string | undefined {
  if (!documentId || documentId === '.' || documentId === '..' || documentId.includes('/') || documentId.includes('\\') || documentId.includes('\0')) return undefined;
  const filename = `${documentId}.jsonl`;
  return Buffer.byteLength(filename, 'utf8') <= 255 ? filename : undefined;
}

function journalEntryPriority(entry: string, documentId: string): number {
  if (entry === journalFilename(documentId)) return 2;
  return entry === legacyJournalFilename(documentId) ? 1 : 0;
}

function validIncarnationId(value: unknown): value is string {
  return typeof value === 'string' && (/^[0-9a-f]{64}$/u.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value));
}

function legacyIncarnationId(document: AIDrawDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function recoverJournal(source: string): { document: AIDrawDocument; incarnationId: string } | undefined {
  let document: AIDrawDocument | undefined;
  let incarnationId: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { return document && incarnationId ? { document, incarnationId } : undefined; }
    if (!document) {
      if (!isRecord(value) || value.type !== 'snapshot'
        || (!hasExactKeys(value, SNAPSHOT_RECORD_KEYS) && !hasExactKeys(value, LEGACY_SNAPSHOT_RECORD_KEYS))) return undefined;
      try { document = migrateDocument(value.document); } catch { return undefined; }
      if (Object.hasOwn(value, 'incarnationId')) {
        if (!validIncarnationId(value.incarnationId)) return undefined;
        incarnationId = value.incarnationId;
      } else incarnationId = legacyIncarnationId(document);
      continue;
    }
    if (!isRecord(value) || !hasExactKeys(value, TRANSACTION_RECORD_KEYS) || value.type !== 'transaction') break;
    const transaction = CanvasTransactionSchema.safeParse(value.transaction);
    if (!transaction.success || transaction.data.documentId !== document.id) break;
    try {
      assertStrictNativeEditableTransaction(transaction.data);
      document = applyTransaction(document, transaction.data).document;
    } catch { break; }
  }
  return document && incarnationId ? { document, incarnationId } : undefined;
}

function parseWorkspace(value: unknown): PersistedWorkspace | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !WORKSPACE_KEYS.has(key))
    || value.version !== 1 || !Array.isArray(value.documentIds)
    || value.documentIds.some((id) => typeof id !== 'string' || !id)
    || new Set(value.documentIds).size !== value.documentIds.length) return undefined;
  const hasActive = Object.hasOwn(value, 'activeDocumentId');
  if (Object.keys(value).length !== (hasActive ? 3 : 2)) return undefined;
  if (hasActive && (typeof value.activeDocumentId !== 'string' || !value.documentIds.includes(value.activeDocumentId))) return undefined;
  return {
    version: 1,
    documentIds: [...value.documentIds] as string[],
    ...(hasActive ? { activeDocumentId: value.activeDocumentId as string } : {}),
  };
}

async function regularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class RecoveryJournal {
  private readonly writeQueues = new Map<string | symbol, Promise<void>>();

  constructor(private readonly root: string) {}

  private journalPath(documentId: string): string {
    return join(this.root, journalFilename(documentId));
  }

  private legacyJournalPath(documentId: string): string | undefined {
    const filename = legacyJournalFilename(documentId);
    return filename ? join(this.root, filename) : undefined;
  }

  private enqueue(key: string | symbol, write: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    this.writeQueues.set(key, current);
    return current.finally(() => { if (this.writeQueues.get(key) === current) this.writeQueues.delete(key); });
  }

  private async replace(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async appendPath(documentId: string): Promise<string> {
    const path = this.journalPath(documentId);
    try {
      const status = await lstat(path);
      if (!status.isFile()) throw new Error('Recovery journal path is not a regular file.');
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const legacy = this.legacyJournalPath(documentId);
    return legacy && await regularFile(legacy) ? legacy : path;
  }

  append(documentId: string, transaction: CanvasTransaction): Promise<void> {
    const parsed = CanvasTransactionSchema.safeParse(transaction);
    if (!parsed.success || parsed.data.documentId !== documentId) return Promise.reject(new Error('Recovery transaction is invalid or belongs to another document.'));
    try { assertStrictNativeEditableTransaction(parsed.data); }
    catch (error) { return Promise.reject(error); }
    let record: string;
    try { record = `${JSON.stringify({ type: 'transaction', transaction: parsed.data })}\n`; }
    catch { return Promise.reject(new Error('Recovery transaction must be JSON-serializable.')); }
    return this.enqueue(documentId, async () => {
      await mkdir(this.root, { recursive: true });
      const path = await this.appendPath(documentId);
      await appendFile(path, record, { encoding: 'utf8', mode: 0o600 });
    });
  }

  compact(document: AIDrawDocument, incarnationId: string = randomUUID()): Promise<void> {
    let snapshot: AIDrawDocument; let record: string;
    try {
      if (!validIncarnationId(incarnationId)) throw new Error('Recovery document incarnation is invalid.');
      snapshot = migrateDocument(document);
      record = `${JSON.stringify({ type: 'snapshot', document: snapshot, incarnationId })}\n`;
    } catch (error) { return Promise.reject(error); }
    return this.enqueue(snapshot.id, async () => {
      await mkdir(this.root, { recursive: true });
      await this.replace(this.journalPath(snapshot.id), record);
      const legacy = this.legacyJournalPath(snapshot.id);
      if (legacy) await unlink(legacy).catch(() => undefined);
    });
  }

  compactWorkspace(documentIds: string[], activeDocumentId?: string): Promise<void> {
    const orderedIds = [...new Set(documentIds.filter((id) => typeof id === 'string' && id.length > 0))];
    const workspace: PersistedWorkspace = {
      version: 1,
      documentIds: orderedIds,
      activeDocumentId: activeDocumentId && orderedIds.includes(activeDocumentId) ? activeDocumentId : undefined,
    };
    return this.enqueue(WORKSPACE_QUEUE, async () => {
      await mkdir(this.root, { recursive: true });
      const path = join(this.root, WORKSPACE_FILE);
      await this.replace(path, `${JSON.stringify(workspace)}\n`);
    });
  }

  remove(documentId: string): Promise<void> {
    return this.enqueue(documentId, async () => {
      let entries;
      try { entries = await readdir(this.root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const filenames = [journalFilename(documentId), legacyJournalFilename(documentId)].filter((value): value is string => Boolean(value));
      const candidates = entries.filter((entry) => !entry.isDirectory() && filenames.some((filename) => entry.name === filename || entry.name.startsWith(`${filename}.`) && entry.name.endsWith('.tmp')));
      await Promise.all(candidates.map(async (entry) => {
        try {
          await unlink(join(this.root, entry.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }));
    });
  }

  async recoverWorkspace(): Promise<RecoveredWorkspace> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return { documents: [], documentIncarnations: {} }; }
    const recovered = new Map<string, { document: AIDrawDocument; incarnationId: string; priority: number }>();
    for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith('.jsonl')).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      try {
        const result = recoverJournal(await readFile(join(this.root, entry.name), 'utf8'));
        if (!result) continue;
        const priority = journalEntryPriority(entry.name, result.document.id);
        const current = recovered.get(result.document.id);
        if (priority > 0 && (!current || priority > current.priority)) recovered.set(result.document.id, { ...result, priority });
      } catch {
        // A corrupt journal is isolated; the remaining documents can still recover.
      }
    }
    let workspace: PersistedWorkspace | undefined;
    try {
      workspace = parseWorkspace(JSON.parse(await readFile(join(this.root, WORKSPACE_FILE), 'utf8')));
    } catch {
      // Legacy and crash-interrupted profiles have no trustworthy workspace index.
    }
    const recoveredDocuments = new Map([...recovered].map(([id, value]) => [id, value.document]));
    const workspaceIds = workspace?.documentIds ?? [];
    const workspaceIdSet = new Set(workspaceIds);
    const orderedIds = [
      ...workspaceIds.filter((id) => recoveredDocuments.has(id)),
      ...[...recoveredDocuments.keys()].filter((id) => !workspaceIdSet.has(id)),
    ];
    const documents = orderedIds.map((id) => recoveredDocuments.get(id)!);
    const activeDocumentId = workspace?.activeDocumentId && recoveredDocuments.has(workspace.activeDocumentId)
      ? workspace.activeDocumentId
      : undefined;
    const documentIncarnations = Object.fromEntries(orderedIds.map((id) => [id, recovered.get(id)!.incarnationId]));
    return { documents, documentIncarnations, activeDocumentId };
  }

  async recover(): Promise<AIDrawDocument[]> {
    return (await this.recoverWorkspace()).documents;
  }

  async read(documentId: string): Promise<string[]> {
    await this.writeQueues.get(documentId)?.catch(() => undefined);
    let path = this.journalPath(documentId);
    if (!await regularFile(path)) {
      const legacy = this.legacyJournalPath(documentId);
      if (!legacy || !await regularFile(legacy)) return [];
      path = legacy;
    }
    try {
      return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writeQueues.values()]);
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUMAN_ACTOR, createId, createIllustrationDocument, createPixelDocument, nowIso, type CanvasTransaction } from '@aidraw/core';
import { RecoveryJournal } from '@main/journal';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function journalPath(root: string, documentId: string): string {
  return join(root, `document-${createHash('sha256').update(documentId).digest('hex')}.jsonl`);
}

describe('crash recovery journal', () => {
  it('flushes a scheduled compact before its owner may remove the journal root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Flush barrier');
    const compact = journal.compact(document); let flushed = false; const flush = journal.flush().then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    await flush; await expect(compact).resolves.toBeUndefined();
    expect(await journal.read(document.id)).toEqual([expect.stringContaining('"type":"snapshot"')]);
  });

  it('restores the latest snapshot and replays committed transactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Before crash');
    await journal.compact(document);
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Rename', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Recovered drawing' }] };
    await journal.append(document.id, transaction);
    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1); expect(recovered[0].name).toBe('Recovered drawing'); expect(recovered[0].dirty).toBe(true);
  });

  it('preserves a compacted clean snapshot when no later transaction exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Clean restart');
    expect(document.dirty).toBe(false);
    await journal.compact(document);

    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: document.id, name: 'Clean restart', dirty: false });
  });

  it('removes both committed and temporary recovery state for an explicit discard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Discard me');
    await journal.compact(document);
    await journal.remove(document.id);

    expect(await journal.read(document.id)).toEqual([]);
    expect(await journal.recover()).toEqual([]);
  });

  it('keeps the last good snapshot when a trailing agent transaction is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createPixelDocument('sprite', 'Good sprite snapshot');
    await journal.compact(document);
    const asset = document.pixelAssets[document.activeAssetId];
    const malformed = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Malformed nested sprite', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: { ...asset, cels: { broken: { id: 'broken' } } } }],
    } as unknown as CanvasTransaction;
    await appendFile(journalPath(root, document.id), `${JSON.stringify({ type: 'transaction', transaction: malformed })}\n`, 'utf8');

    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].name).toBe('Good sprite snapshot');
  });

  it('confines untrusted document IDs to hashed files for compact, append, recovery, and discard', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'aidraw-recovery-confinement-')); temporaryPaths.push(parent);
    const root = join(parent, 'recovery'); const escaped = join(parent, 'escaped.jsonl'); await writeFile(escaped, 'sentinel', 'utf8');
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Confined recovery'); document.id = '../escaped';
    await journal.compact(document);
    const transaction: CanvasTransaction = {
      id: 'recovery-confined-transaction', clientOperationId: 'recovery-confined-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: 'Recover confined edit', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Confined recovered edit' }],
    };
    await journal.append(document.id, transaction); await journal.compactWorkspace([document.id], document.id);

    expect(await readFile(escaped, 'utf8')).toBe('sentinel');
    expect((await readdir(root)).sort()).toEqual([`document-${createHash('sha256').update(document.id).digest('hex')}.jsonl`, 'workspace.json'].sort());
    const recovered = await journal.recoverWorkspace();
    expect(recovered).toMatchObject({ activeDocumentId: document.id, documents: [{ id: document.id, name: 'Confined recovered edit', revision: 1, dirty: true }] });

    await journal.remove(document.id);
    expect(await readFile(escaped, 'utf8')).toBe('sentinel'); expect(await readdir(root)).toEqual(['workspace.json']);
  });

  it('keeps case-distinct imported document IDs independent on case-insensitive filesystems', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-case-identity-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const upper = createIllustrationDocument('Uppercase identity'); const lower = createIllustrationDocument('Lowercase identity');
    upper.id = 'Imported-Case-Identity'; lower.id = 'imported-case-identity';
    await journal.compact(upper); await journal.compact(lower);
    expect((await readdir(root)).sort()).toEqual([basename(journalPath(root, upper.id)), basename(journalPath(root, lower.id))].sort());
    expect((await journal.recover()).map(({ id }) => id).sort()).toEqual([upper.id, lower.id].sort());
  });

  it('recovers a contiguous committed prefix from a torn line and never skips across the gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-torn-line-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Before torn append'); await journal.compact(document);
    const transaction = (id: string, name: string): CanvasTransaction => ({
      id, clientOperationId: `${id}-operation`, documentId: document.id, actor: HUMAN_ACTOR,
      label: name, createdAt: nowIso(), operations: [{ kind: 'document.rename', name }],
    });
    const first = transaction('recovery-prefix-first', 'Recovered committed prefix'); await journal.append(document.id, first);
    const path = journalPath(root, document.id); await appendFile(path, '{"type":"transaction"', 'utf8');
    expect(await journal.recover()).toEqual([expect.objectContaining({ id: document.id, name: 'Recovered committed prefix', revision: 1, dirty: true })]);

    const afterGap = transaction('recovery-after-gap', 'Must not cross torn record');
    await appendFile(path, `\n${JSON.stringify({ type: 'transaction', transaction: afterGap })}\n`, 'utf8');
    expect(await journal.recover()).toEqual([expect.objectContaining({ id: document.id, name: 'Recovered committed prefix', revision: 1, dirty: true })]);
  });

  it('rejects invalid recovery writes without changing the last good journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-write-policy-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Recovery write policy'); await journal.compact(document);
    const before = await readFile(journalPath(root, document.id));
    const invalid = {
      id: 'recovery-invalid', clientOperationId: 'recovery-invalid-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: '', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Invalid' }],
    } as CanvasTransaction;
    const crossDocument = { ...invalid, label: 'Cross document', documentId: 'document-other' };
    const nonJson = {
      ...invalid, label: 'Non-JSON recovery transaction',
      operations: [{ kind: 'document.rename', name: 'Invalid', nonJson: 1n }],
    } as unknown as CanvasTransaction;
    await expect(journal.append(document.id, invalid)).rejects.toThrow('invalid or belongs to another document');
    await expect(journal.append(document.id, crossDocument)).rejects.toThrow('invalid or belongs to another document');
    await expect(journal.append(document.id, nonJson)).rejects.toThrow('must be JSON-serializable');
    expect(await readFile(journalPath(root, document.id))).toEqual(before);
  });

  it('reopens a legacy safe-name journal and migrates it to the hashed filename on compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-legacy-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Legacy recovery snapshot'); await mkdir(root, { recursive: true });
    const legacyPath = join(root, `${document.id}.jsonl`); await writeFile(legacyPath, `${JSON.stringify({ type: 'snapshot', document })}\n`, 'utf8');
    const journal = new RecoveryJournal(root);
    const transaction: CanvasTransaction = {
      id: 'legacy-recovery-transaction', clientOperationId: 'legacy-recovery-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: 'Legacy recovery edit', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Legacy journal recovered' }],
    };
    await journal.append(document.id, transaction);
    const recovered = await journal.recover(); expect(recovered).toEqual([expect.objectContaining({ id: document.id, name: 'Legacy journal recovered', revision: 1 })]);
    await journal.compact(recovered[0]);
    expect(await readdir(root)).toEqual([`document-${createHash('sha256').update(document.id).digest('hex')}.jsonl`]);
    expect(await journal.recover()).toEqual([expect.objectContaining({ id: document.id, name: 'Legacy journal recovered', revision: 1 })]);
  });

  it('uses workspace order only when the manifest exactly matches the writer contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-workspace-policy-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const first = createIllustrationDocument('First recovery tab'); const second = createIllustrationDocument('Second recovery tab');
    await journal.compact(first); await journal.compact(second); await journal.compactWorkspace([second.id, first.id], first.id);
    await expect(journal.recoverWorkspace()).resolves.toMatchObject({ activeDocumentId: first.id, documents: [{ id: second.id }, { id: first.id }] });

    const workspacePath = join(root, 'workspace.json');
    const invalid = [
      { version: 1, documentIds: [second.id], activeDocumentId: first.id },
      { version: 1, documentIds: [second.id, second.id], activeDocumentId: second.id },
      { version: 1, documentIds: [second.id, first.id], activeDocumentId: first.id, extra: true },
    ];
    for (const value of invalid) {
      await writeFile(workspacePath, JSON.stringify(value), 'utf8');
      const recovered = await journal.recoverWorkspace();
      expect(recovered.documents.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort()); expect(recovered.activeDocumentId).toBeUndefined();
    }
  });

  it('isolates a malformed illustration snapshot without suppressing a valid sibling journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-illustration-schema-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const valid = createIllustrationDocument('Valid recovery sibling'); const malformed = createIllustrationDocument('Malformed recovery sibling'); malformed.artboard.width = 0;
    await journal.compact(valid);
    await writeFile(journalPath(root, malformed.id), `${JSON.stringify({ type: 'snapshot', document: malformed })}\n`, 'utf8');
    await journal.compactWorkspace([malformed.id, valid.id], malformed.id);
    const recovered = await journal.recoverWorkspace();
    expect(recovered.documents).toEqual([expect.objectContaining({ id: valid.id, name: valid.name })]);
    expect(recovered.activeDocumentId).toBeUndefined();
  });
});

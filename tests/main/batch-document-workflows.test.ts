import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createIllustrationDocument, type AIDrawDocument } from '@aidraw/core';
import type { DocumentTab, InterchangeReportInput } from '../../src/common/contracts';
import {
  BatchDocumentWorkflows,
  type BatchCloseDecision,
  type BatchDocumentWorkflowDependencies,
} from '../../src/main/batch-document-workflows';

function illustration(id: string, name: string): AIDrawDocument {
  const document = createIllustrationDocument(name);
  document.id = id;
  return document;
}

function tab(document: AIDrawDocument, overrides: Partial<DocumentTab> = {}): DocumentTab {
  return {
    id: document.id,
    name: document.name,
    kind: document.kind,
    dirty: document.dirty,
    revision: document.revision,
    ...overrides,
  };
}

function createHarness(input: {
  tabs: DocumentTab[];
  documents: AIDrawDocument[];
  directories?: Array<string | undefined>;
  closeDecisions?: BatchCloseDecision[];
  existingPaths?: string[];
  save?: BatchDocumentWorkflowDependencies['documents']['save'];
  close?: BatchDocumentWorkflowDependencies['documents']['close'];
  exportDocument?: BatchDocumentWorkflowDependencies['exportDocument'];
}) {
  const documents = new Map(input.documents.map((document) => [document.id, document]));
  const directoryChoices = [...(input.directories ?? [])];
  const closeDecisions = [...(input.closeDecisions ?? [])];
  const save = vi.fn(input.save ?? (async (_documentId: string, filePath: string) => filePath));
  const close = vi.fn(input.close ?? (async () => ({ closed: true })));
  const writeTarget = vi.fn(async () => undefined);
  const reports: InterchangeReportInput[] = [];
  const dependencies: BatchDocumentWorkflowDependencies = {
    documents: {
      listTabs: () => input.tabs.map((entry) => ({ ...entry })),
      getDocument: (documentId) => documents.get(documentId),
      save,
      close,
    },
    selectDirectory: vi.fn(async () => directoryChoices.shift()),
    confirmCloseAll: vi.fn(async () => closeDecisions.shift() ?? 'cancel'),
    pathExists: vi.fn(async (filePath) => (input.existingPaths ?? []).includes(filePath)),
    exportDocument: input.exportDocument ?? vi.fn(async () => ({
      data: Buffer.from('png'),
      mimeType: 'image/png',
      extension: 'png',
      report: { warnings: [], rasterized: [] },
    })),
    writeTarget,
    companionBytes: (data) => data,
    recordInterchangeReport: vi.fn(async (report) => {
      reports.push(report);
      return { id: `report-${reports.length}` };
    }),
  };
  return { workflows: new BatchDocumentWorkflows(dependencies), dependencies, save, close, writeTarget, reports };
}

describe('batch document workflows', () => {
  it('returns an honest Save All cancellation before changing any document', async () => {
    const documents = ['one', 'two', 'three'].map((id) => illustration(id, `Drawing ${id}`));
    const harness = createHarness({
      documents,
      tabs: documents.map((document) => tab(document, { dirty: true })),
      directories: [undefined],
    });

    await expect(harness.workflows.saveAllDocuments()).resolves.toEqual({ cancelled: true, items: [] });
    expect(harness.dependencies.selectDirectory).toHaveBeenCalledWith({ kind: 'save-all', title: 'Choose a folder for 3 unsaved drawings' });
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('isolates Save All failures and allocates collision-safe paths without changing focus', async () => {
    const root = join('C:', 'isolated', 'saves');
    const clean = illustration('clean', 'Already saved');
    const failed = illustration('failed', 'Failed existing');
    const first = illustration('first', 'Shared name');
    const second = illustration('second', 'Shared name');
    const tabs = [
      tab(clean, { dirty: false, filePath: join(root, 'already.aidraw') }),
      tab(failed, { dirty: true, filePath: join(root, 'failed.aidraw') }),
      tab(first, { dirty: true }),
      tab(second, { dirty: true }),
    ];
    const activeDocumentId = second.id;
    const harness = createHarness({
      documents: [clean, failed, first, second],
      tabs,
      directories: [root],
      existingPaths: [join(root, 'Shared name.aidraw')],
      save: async (documentId, filePath) => {
        if (documentId === failed.id) throw new Error('bounded save failure');
        return filePath;
      },
    });

    const result = await harness.workflows.saveAllDocuments();
    expect(result.items).toEqual([
      { documentId: clean.id, name: clean.name, status: 'skipped', filePath: join(root, 'already.aidraw') },
      { documentId: failed.id, name: failed.name, status: 'failed', error: 'bounded save failure' },
      { documentId: first.id, name: first.name, status: 'saved', filePath: join(root, 'Shared name (2).aidraw') },
      { documentId: second.id, name: second.name, status: 'saved', filePath: join(root, 'Shared name (3).aidraw') },
    ]);
    expect(harness.save).toHaveBeenCalledTimes(3);
    expect(activeDocumentId).toBe(second.id);
  });

  it('reports batch export cancellation, success, and per-document failure independently', async () => {
    const root = join('C:', 'isolated', 'exports');
    const first = illustration('first', 'Shared export');
    const second = illustration('second', 'Shared export');
    const failed = illustration('failed', 'Failure export');
    const harness = createHarness({
      documents: [first, second, failed],
      tabs: [tab(first), tab(second), tab(failed)],
      directories: [undefined, root],
      exportDocument: vi.fn(async (document: AIDrawDocument) => {
        if (document.id === failed.id) throw new Error('bounded export failure');
        return { data: Buffer.from(document.id), mimeType: 'image/png', extension: 'png', report: { warnings: [], rasterized: [] } };
      }),
    });

    await expect(harness.workflows.batchExportDocuments('png')).resolves.toEqual({ cancelled: true, items: [] });
    expect(harness.writeTarget).not.toHaveBeenCalled();
    const result = await harness.workflows.batchExportDocuments('png');
    expect(result.items).toEqual([
      { documentId: first.id, name: first.name, status: 'exported', filePath: join(root, 'Shared export.png'), warnings: [], reportId: 'report-1' },
      { documentId: second.id, name: second.name, status: 'exported', filePath: join(root, 'Shared export (2).png'), warnings: [], reportId: 'report-2' },
      { documentId: failed.id, name: failed.name, status: 'failed', error: 'bounded export failure', reportId: 'report-3' },
    ]);
    expect(harness.writeTarget).toHaveBeenCalledTimes(2);
    expect(harness.reports.map((report) => report.status)).toEqual(['completed', 'completed', 'failed']);
  });

  it('keeps all dirty documents open when Close All is cancelled', async () => {
    const documents = ['one', 'two'].map((id) => illustration(id, `Drawing ${id}`));
    const harness = createHarness({
      documents,
      tabs: documents.map((document) => tab(document, { dirty: true, filePath: join('C:', 'isolated', `${document.id}.aidraw`) })),
      closeDecisions: ['cancel'],
    });

    await expect(harness.workflows.closeAllDocuments()).resolves.toEqual({ cancelled: true, items: [] });
    expect(harness.dependencies.confirmCloseAll).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Close all drawings',
      message: '2 drawings have unsaved changes.',
      buttons: ['Save all and close', 'Cancel', 'Discard all'],
    }));
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('aborts Close All on a Save All failure and reports later close failures without hiding them', async () => {
    const first = illustration('first', 'First');
    const second = illustration('second', 'Second');
    const tabs = [
      tab(first, { dirty: true, filePath: join('C:', 'isolated', 'first.aidraw') }),
      tab(second, { dirty: true, filePath: join('C:', 'isolated', 'second.aidraw') }),
    ];
    const failedSave = createHarness({
      documents: [first, second],
      tabs,
      closeDecisions: ['save-all'],
      save: async (documentId, filePath) => {
        if (documentId === second.id) throw new Error('save blocked');
        return filePath;
      },
    });
    const saveResult = await failedSave.workflows.closeAllDocuments();
    expect(saveResult.items.map((item) => item.status)).toEqual(['saved', 'failed']);
    expect(failedSave.close).not.toHaveBeenCalled();

    const closeFailure = createHarness({
      documents: [first, second],
      tabs: tabs.map((entry) => ({ ...entry, dirty: false })),
      close: async (documentId) => documentId === second.id ? { closed: false, reason: 'busy' } : { closed: true },
    });
    await expect(closeFailure.workflows.closeAllDocuments()).resolves.toEqual({ items: [
      { documentId: first.id, name: first.name, status: 'closed' },
      { documentId: second.id, name: second.name, status: 'failed', error: 'busy' },
    ] });
  });
});

import { join } from 'node:path';
import { HUMAN_ACTOR, type AIDrawDocument, type AnimationTag, type PixelSprite } from '@aidraw/core';
import type {
  BatchDocumentResult,
  DocumentTab,
  ExportFormat,
  ExportOptions,
  InterchangeReportInput,
} from '../common/contracts';
import type { ExportArtifact } from './export-document';

export type BatchExportFormat = Extract<ExportFormat, 'png' | 'jpeg' | 'webp' | 'gif' | 'apng' | 'sprite-sheet'>;

export interface BatchDirectoryRequest {
  kind: 'save-all' | 'batch-export';
  title: string;
}

export interface BatchCloseRequest {
  title: 'Close all drawings';
  message: string;
  detail: string;
  buttons: readonly ['Save all and close', 'Cancel', 'Discard all'];
}

export type BatchCloseDecision = 'save-all' | 'cancel' | 'discard-all';

export interface BatchDocumentGateway {
  listTabs(): DocumentTab[];
  getDocument(documentId: string): AIDrawDocument | undefined;
  save(documentId: string, filePath: string): Promise<string>;
  close(documentId: string, force: true): Promise<{ closed: boolean; reason?: string }>;
}

export interface BatchDocumentWorkflowDependencies {
  documents: BatchDocumentGateway;
  selectDirectory(request: BatchDirectoryRequest): Promise<string | undefined>;
  confirmCloseAll(request: BatchCloseRequest): Promise<BatchCloseDecision>;
  pathExists(filePath: string): Promise<boolean>;
  exportDocument(document: AIDrawDocument, format: BatchExportFormat, options: ExportOptions): Promise<ExportArtifact>;
  writeTarget(filePath: string, data: Buffer): Promise<void>;
  companionBytes(data: Buffer, format: BatchExportFormat, targetPath: string): Buffer;
  recordInterchangeReport(input: InterchangeReportInput): Promise<{ id: string }>;
}

export function safeBatchFileStem(name: string): string {
  const value = [...name]
    .map((character) => character.charCodeAt(0) < 32 ? '-' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return value || 'Untitled';
}

export function resolveBatchAnimationTag(sprite: PixelSprite, selector: string): { tag?: AnimationTag; refusal?: string } {
  const exactId = sprite.tags.find((entry) => entry.id === selector);
  if (exactId) return { tag: exactId };
  const named = sprite.tags.filter((entry) => entry.name.toLocaleLowerCase() === selector.toLocaleLowerCase());
  if (named.length > 1) return { refusal: `Animation tag name “${selector}” is ambiguous; use an exact tag ID.` };
  if (!named[0]) return { refusal: `Animation tag “${selector}” does not exist in this sprite.` };
  return { tag: named[0] };
}

export class BatchDocumentWorkflows {
  constructor(private readonly dependencies: BatchDocumentWorkflowDependencies) {}

  private async availablePath(directory: string, stem: string, extension: string, reserved: Set<string>): Promise<string> {
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = join(directory, `${stem}${suffix === 1 ? '' : ` (${suffix})`}.${extension}`);
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (reserved.has(normalized)) continue;
      if (!await this.dependencies.pathExists(candidate)) {
        reserved.add(normalized);
        return candidate;
      }
    }
    throw new Error(`Could not allocate a unique ${extension.toUpperCase()} filename for ${stem}.`);
  }

  async saveAllDocuments(): Promise<BatchDocumentResult> {
    const tabs = this.dependencies.documents.listTabs();
    const unsaved = tabs.filter((tab) => !tab.filePath);
    let directory: string | undefined;
    if (unsaved.length) {
      directory = await this.dependencies.selectDirectory({
        kind: 'save-all',
        title: `Choose a folder for ${unsaved.length} unsaved drawing${unsaved.length === 1 ? '' : 's'}`,
      });
      if (!directory) return { cancelled: true, items: [] };
    }

    const reserved = new Set<string>();
    const items: BatchDocumentResult['items'] = [];
    for (const tab of tabs) {
      try {
        if (tab.filePath && !tab.dirty) {
          items.push({ documentId: tab.id, name: tab.name, status: 'skipped', filePath: tab.filePath });
          continue;
        }
        const target = tab.filePath ?? await this.availablePath(directory!, safeBatchFileStem(tab.name), 'aidraw', reserved);
        const filePath = await this.dependencies.documents.save(tab.id, target);
        items.push({ documentId: tab.id, name: tab.name, status: 'saved', filePath });
      } catch (error) {
        items.push({ documentId: tab.id, name: tab.name, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { items };
  }

  async batchExportDocuments(format: BatchExportFormat, options: ExportOptions = {}): Promise<BatchDocumentResult> {
    if (!['png', 'jpeg', 'webp', 'gif', 'apng', 'sprite-sheet'].includes(format)) throw new Error('Unsupported batch export format.');
    const scale = options.scale ?? 1;
    if (!Number.isInteger(scale) || scale < 1 || scale > 64) throw new Error('Batch export scale must be an integer from 1 to 64.');
    const animationTagName = options.animationTagName?.trim();
    if (animationTagName && animationTagName.length > 120) throw new Error('Batch animation tag names are limited to 120 characters.');

    const directory = await this.dependencies.selectDirectory({ kind: 'batch-export', title: 'Choose a batch export folder' });
    if (!directory) return { cancelled: true, items: [] };
    const reserved = new Set<string>();
    const items: BatchDocumentResult['items'] = [];
    for (const tab of this.dependencies.documents.listTabs()) {
      const document = this.dependencies.documents.getDocument(tab.id);
      if (!document) continue;
      if (format === 'sprite-sheet' && (document.kind !== 'pixel' || document.pixelAssets[document.activeAssetId]?.type !== 'sprite')) {
        items.push({ documentId: tab.id, name: tab.name, status: 'skipped', warnings: ['SPRITE-SHEET batch export requires an active pixel sprite.'] });
        continue;
      }
      if (['gif', 'apng'].includes(format) && !((document.kind === 'pixel' && document.pixelAssets[document.activeAssetId]?.type === 'sprite') || (document.kind === 'illustration' && document.animation.keyframeIds.length > 0))) {
        items.push({ documentId: tab.id, name: tab.name, status: 'skipped', warnings: [`${format.toUpperCase()} batch export requires an active pixel sprite or a keyframed illustration.`] });
        continue;
      }
      try {
        const sprite = document.kind === 'pixel' && document.pixelAssets[document.activeAssetId]?.type === 'sprite'
          ? document.pixelAssets[document.activeAssetId]
          : undefined;
        const tagResolution = animationTagName && sprite?.type === 'sprite' ? resolveBatchAnimationTag(sprite, animationTagName) : undefined;
        const tag = tagResolution?.tag;
        if (animationTagName && ['gif', 'apng', 'sprite-sheet'].includes(format) && !tag) {
          items.push({
            documentId: tab.id,
            name: tab.name,
            status: 'skipped',
            warnings: [document.kind === 'illustration'
              ? 'Named animation tags apply only to pixel sprites; clear the shared tag to export this illustration timeline.'
              : tagResolution?.refusal ?? `Animation tag “${animationTagName}” does not exist in this sprite.`],
          });
          continue;
        }
        const artifact = await this.dependencies.exportDocument(document, format, {
          scale: document.kind === 'pixel' ? scale : 1,
          animationTagId: tag?.id,
        });
        const stem = safeBatchFileStem(tab.name)
          + (document.kind === 'pixel' && scale > 1 ? ` @${scale}x` : '')
          + (tag ? ` · ${safeBatchFileStem(tag.name)}` : '');
        const target = await this.availablePath(directory, stem, artifact.extension, reserved);
        await this.dependencies.writeTarget(target, artifact.data);
        const companions = [
          ...(artifact.companions ?? []),
          ...(artifact.companion ? [{ ...artifact.companion, name: artifact.companion.name }] : []),
        ];
        const companionPaths: string[] = [];
        for (const companion of companions) {
          const companionPath = await this.availablePath(directory, stem, companion.extension, reserved);
          await this.dependencies.writeTarget(companionPath, this.dependencies.companionBytes(companion.data, format, target));
          companionPaths.push(companionPath);
        }
        const report = await this.dependencies.recordInterchangeReport({
          kind: 'export',
          status: 'completed',
          actor: HUMAN_ACTOR,
          documentIds: [document.id],
          documentNames: [document.name],
          format,
          sourcePaths: [],
          destinationPaths: [target, ...companionPaths],
          warnings: artifact.report.warnings,
          rasterized: artifact.report.rasterized,
          ...(artifact.report.fidelity ? { fidelity: artifact.report.fidelity } : {}),
        });
        items.push({ documentId: tab.id, name: tab.name, status: 'exported', filePath: target, warnings: artifact.report.warnings, reportId: report.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const report = await this.dependencies.recordInterchangeReport({
          kind: 'export',
          status: 'failed',
          actor: HUMAN_ACTOR,
          documentIds: [document.id],
          documentNames: [document.name],
          format,
          sourcePaths: [],
          destinationPaths: [],
          warnings: [],
          rasterized: [],
          error: message,
        });
        items.push({ documentId: tab.id, name: tab.name, status: 'failed', error: message, reportId: report.id });
      }
    }
    return { items };
  }

  async closeAllDocuments(): Promise<BatchDocumentResult> {
    const tabs = this.dependencies.documents.listTabs();
    const dirty = tabs.filter((tab) => tab.dirty);
    if (dirty.length) {
      const names = dirty.slice(0, 12).map((tab) => `• ${tab.name}`).join('\n');
      const overflow = dirty.length > 12 ? `\n…and ${dirty.length - 12} more.` : '';
      const decision = await this.dependencies.confirmCloseAll({
        title: 'Close all drawings',
        message: `${dirty.length} drawing${dirty.length === 1 ? ' has' : 's have'} unsaved changes.`,
        detail: `${names}${overflow}`,
        buttons: ['Save all and close', 'Cancel', 'Discard all'],
      });
      if (decision === 'cancel') return { cancelled: true, items: [] };
      if (decision === 'save-all') {
        const saved = await this.saveAllDocuments();
        if (saved.cancelled || saved.items.some((item) => item.status === 'failed')) return saved;
      }
    }
    const items: BatchDocumentResult['items'] = [];
    for (const tab of tabs) {
      const closed = await this.dependencies.documents.close(tab.id, true);
      items.push({
        documentId: tab.id,
        name: tab.name,
        status: closed.closed ? 'closed' : 'failed',
        ...(closed.closed ? {} : { error: closed.reason ?? 'The document could not be closed.' }),
      });
    }
    return { items };
  }
}

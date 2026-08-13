import { readFile } from 'node:fs/promises';
import { createId, nowIso } from '@aidraw/core';
import type { Actor } from '@aidraw/core';
import type { InterchangeReport, InterchangeReportInput } from '../common/contracts';
import { normalizeInterchangeFidelityEntries } from '../common/interchange-fidelity';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

interface PersistedReports { version: 1; reports: InterchangeReport[] }
const MAX_REPORTS = 200;

export interface InterchangeReportStoreOptions {
  /** Narrow deterministic seam for replacement failure/concurrency coverage. */
  replaceFile?: PrivateJsonFileReplacer;
}

function strings(value: unknown, maximum = 1_000): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, maximum) : [];
}

function actor(value: unknown): Actor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Actor>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.color !== 'string') return undefined;
  if (!['human', 'agent', 'system'].includes(String(candidate.kind))) return undefined;
  return structuredClone(candidate as Actor);
}

function normalize(value: unknown): InterchangeReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<InterchangeReport>;
  const reportActor = actor(source.actor);
  if (typeof source.id !== 'string' || typeof source.createdAt !== 'string' || !reportActor) return undefined;
  if (!['import', 'export'].includes(String(source.kind)) || !['completed', 'failed'].includes(String(source.status))) return undefined;
  if (typeof source.format !== 'string' || source.format.length > 80) return undefined;
  return {
    id: source.id,
    kind: source.kind as InterchangeReport['kind'],
    status: source.status as InterchangeReport['status'],
    actor: reportActor,
    createdAt: source.createdAt,
    documentIds: strings(source.documentIds, 100),
    documentNames: strings(source.documentNames, 100),
    format: source.format,
    sourcePaths: strings(source.sourcePaths, 100),
    destinationPaths: strings(source.destinationPaths, 100),
    warnings: strings(source.warnings),
    rasterized: strings(source.rasterized),
    fidelity: normalizeInterchangeFidelityEntries(source.fidelity),
    ...(typeof source.error === 'string' ? { error: source.error.slice(0, 10_000) } : {}),
  };
}

export class InterchangeReportStore {
  private reports: InterchangeReport[] = [];
  private loaded = false;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly options: InterchangeReportStoreOptions = {}) {}

  async list(documentId?: string): Promise<InterchangeReport[]> {
    return this.exclusive(async () => {
      await this.load();
      return this.reports
        .filter((report) => !documentId || report.documentIds.includes(documentId))
        .map((report) => structuredClone(report));
    });
  }

  async get(id: string): Promise<InterchangeReport | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const report = this.reports.find((entry) => entry.id === id);
      return report ? structuredClone(report) : undefined;
    });
  }

  async record(input: InterchangeReportInput): Promise<InterchangeReport> {
    return this.exclusive(async () => {
      await this.load();
      const report = normalize({ ...input, id: createId('interchange-report'), createdAt: nowIso() });
      if (!report) throw new Error('The interchange report is invalid.');
      const nextReports = [report, ...this.reports].slice(0, MAX_REPORTS);
      await this.persist(nextReports);
      this.reports = nextReports;
      return structuredClone(report);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedReports>;
      if (value.version === 1 && Array.isArray(value.reports)) this.reports = value.reports.flatMap((entry) => normalize(entry) ?? []).slice(0, MAX_REPORTS);
    } catch {
      // Reports are diagnostic metadata; corruption must not block artwork.
    }
  }

  private async persist(reports: InterchangeReport[]): Promise<void> {
    await replacePrivateJsonFile(this.filePath, { version: 1, reports } satisfies PersistedReports, this.options.replaceFile);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

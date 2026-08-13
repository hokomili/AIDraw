import { join } from 'node:path';
import type { AsyncJob } from '@aidraw/core';
import { LocalCredentialStore } from './credentials';
import { DocumentService } from './document-service';
import { GenerationManager } from './generation-manager';
import { RecoveryJournal } from './journal';
import { McpHost } from './mcp-host';
import { ProviderCredentialStore } from './provider-credentials';
import { TransactionTraceStore } from './trace-store';
import { RasterUtilitySupervisor } from './utility-supervisor';
import { DocumentPresetStore } from './document-preset-store';
import { InterchangeReportStore } from './interchange-report-store';
import type { GenerationProviderRunner } from './generation-provider-runner';

export interface EngineRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  runApprovedFileJob?: (job: AsyncJob) => void;
  generationProviderRunner?: GenerationProviderRunner;
  approvalTimeoutMs?: number;
}

/**
 * Canonical AIDraw engine. It owns every mutable document concern and has no
 * BrowserWindow dependency, so it can run for an entire user session without
 * an editor renderer attached.
 */
export class EngineRuntime {
  readonly service: DocumentService;
  readonly mcpHost: McpHost;
  readonly providerCredentials: ProviderCredentialStore;
  readonly generationManager: GenerationManager;
  readonly rasterUtilities: RasterUtilitySupervisor;
  readonly generationUtilities: RasterUtilitySupervisor;
  readonly documentPresets: DocumentPresetStore;
  readonly interchangeReports: InterchangeReportStore;
  private recoveryTimer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: EngineRuntimeOptions) {
    const { userDataPath, appVersion } = options;
    this.rasterUtilities = new RasterUtilitySupervisor();
    this.generationUtilities = new RasterUtilitySupervisor();
    this.service = new DocumentService(
      new RecoveryJournal(join(userDataPath, 'recovery')),
      appVersion,
      new TransactionTraceStore(join(userDataPath, 'traces')),
      (bytes, expected) => this.rasterUtilities.validateImage(bytes, expected),
      async (document) => (await this.rasterUtilities.exportDocument(document, 'png')).data,
    );
    this.providerCredentials = new ProviderCredentialStore(join(userDataPath, 'credentials', 'generation.json'));
    this.generationManager = new GenerationManager(
      this.service,
      this.providerCredentials,
      options.generationProviderRunner
        ?? ((input, control) => this.generationUtilities.generate(input.jobId, input.document, input.request, input.credential, control)),
      async (document) => (await this.rasterUtilities.exportDocument(document, 'png')).data,
      (encoded, width, height, palette, alphaThreshold, dithering) => this.rasterUtilities.quantizeImage(encoded, width, height, palette, { alphaThreshold, dithering }),
      (output) => this.rasterUtilities.normalizeGeneratedOutput(output),
    );
    this.documentPresets = new DocumentPresetStore(join(userDataPath, 'settings', 'document-presets.json'));
    this.interchangeReports = new InterchangeReportStore(join(userDataPath, 'reports', 'interchange.json'));
    this.mcpHost = new McpHost(
      this.service,
      appVersion,
      join(userDataPath, 'mcp-port.json'),
      (jobId) => { this.generationManager.cancel(jobId); },
      options.runApprovedFileJob,
      (encoded, width, height, palette, settings) => this.rasterUtilities.quantizeImage(encoded, width, height, palette, settings),
      (document, request, maxPixels) => this.rasterUtilities.captureObservation(document, request, maxPixels ?? 4_194_304),
      options.approvalTimeoutMs,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.service.recover();
    this.service.initialize();
    this.recoveryTimer = setInterval(() => void this.service.compactRecovery(), 60_000);
    this.recoveryTimer.unref();
    try {
      const token = await new LocalCredentialStore(join(this.options.userDataPath, 'credentials', 'mcp-token.json')).loadOrCreateToken();
      this.service.setMcpInfo({ running: true, ...(await this.mcpHost.start(token)) });
    } catch (error) {
      this.service.setMcpInfo({ running: false, tokenHint: error instanceof Error ? error.message : 'MCP unavailable' });
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.mcpHost.stop();
    this.rasterUtilities.stop();
    this.generationUtilities.stop();
    await this.service.compactRecovery();
    this.service.setMcpInfo({ running: false });
  }
}

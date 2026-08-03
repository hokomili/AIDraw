import { join } from 'node:path';
import type { AsyncJob } from '@aidraw/core';
import { LocalCredentialStore } from './credentials';
import { DocumentService } from './document-service';
import { GenerationManager } from './generation-manager';
import { RecoveryJournal } from './journal';
import { McpHost } from './mcp-host';
import { ProviderCredentialStore } from './provider-credentials';
import { TransactionTraceStore } from './trace-store';

export interface EngineRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  runApprovedFileJob?: (job: AsyncJob) => void;
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
  private recoveryTimer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: EngineRuntimeOptions) {
    const { userDataPath, appVersion } = options;
    this.service = new DocumentService(
      new RecoveryJournal(join(userDataPath, 'recovery')),
      appVersion,
      new TransactionTraceStore(join(userDataPath, 'traces')),
    );
    this.providerCredentials = new ProviderCredentialStore(join(userDataPath, 'credentials', 'generation.json'));
    this.generationManager = new GenerationManager(this.service, this.providerCredentials);
    this.mcpHost = new McpHost(
      this.service,
      appVersion,
      join(userDataPath, 'mcp-port.json'),
      (jobId) => { this.generationManager.cancel(jobId); },
      options.runApprovedFileJob,
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
    await this.service.compactRecovery();
    await this.mcpHost.stop();
    this.service.setMcpInfo({ running: false });
  }
}

import { join } from 'node:path';
import type { AsyncJob } from '@aidraw/core';
import { parseOnionSkinPreferences, type OnionSkinPreferences } from '../common/onion-skin';
import { parseOrderedDitherPreferences, type OrderedDitherPreferences } from '../common/ordered-dither-preferences';
import { parseSpriteSymmetryPreferences, type SpriteSymmetryPreferences } from '../common/sprite-symmetry';
import { parseWorkspaceLayoutPreferences, type WorkspaceLayoutPreferences } from '../common/workspace-layout';
import { parseShortcutPreferences, type ShortcutPreferences } from '../common/shortcut-preferences';
import type { EditorBootstrapSnapshot, OnionSkinPreferenceSaveResult, OrderedDitherPreferenceSaveResult, ShortcutPreferenceSaveResult, SpriteSymmetryPreferenceSaveResult, WorkspaceLayoutPreferenceSaveResult } from '../common/contracts';
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
import { OnionSkinPreferenceStore } from './onion-skin-preference-store';
import { OrderedDitherPreferenceStore } from './ordered-dither-preference-store';
import { SpriteSymmetryPreferenceStore } from './sprite-symmetry-preference-store';
import { WorkspaceLayoutPreferenceStore } from './workspace-layout-preference-store';
import { ShortcutPreferenceStore } from './shortcut-preference-store';

export interface EngineRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  runApprovedFileJob?: (job: AsyncJob) => void;
  generationProviderRunner?: GenerationProviderRunner;
  approvalTimeoutMs?: number;
}

export interface McpCredentialTransition {
  access: 'active' | 'revoked';
  endpointRunning: boolean;
  sessionsTerminated: number;
  cleanupWarning?: string;
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
  readonly onionSkinPreferences: OnionSkinPreferenceStore;
  readonly orderedDitherPreferences: OrderedDitherPreferenceStore;
  readonly spriteSymmetryPreferences: SpriteSymmetryPreferenceStore;
  readonly workspaceLayoutPreferences: WorkspaceLayoutPreferenceStore;
  readonly shortcutPreferences: ShortcutPreferenceStore;
  private readonly mcpCredentials: LocalCredentialStore;
  private mcpCredentialOperation: Promise<void> = Promise.resolve();
  private recoveryTimer?: NodeJS.Timeout;
  private started = false;
  private stopPromise?: Promise<void>;

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
    this.onionSkinPreferences = new OnionSkinPreferenceStore(join(userDataPath, 'settings', 'onion-skin.json'));
    this.orderedDitherPreferences = new OrderedDitherPreferenceStore(join(userDataPath, 'settings', 'ordered-dither.json'));
    this.spriteSymmetryPreferences = new SpriteSymmetryPreferenceStore(join(userDataPath, 'settings', 'sprite-symmetry.json'));
    this.workspaceLayoutPreferences = new WorkspaceLayoutPreferenceStore(join(userDataPath, 'settings', 'workspace-layout.json'));
    this.shortcutPreferences = new ShortcutPreferenceStore(join(userDataPath, 'settings', 'shortcuts.json'));
    this.interchangeReports = new InterchangeReportStore(join(userDataPath, 'reports', 'interchange.json'));
    this.mcpCredentials = new LocalCredentialStore(join(userDataPath, 'credentials', 'mcp-token.json'));
    this.mcpHost = new McpHost(
      this.service,
      appVersion,
      join(userDataPath, 'mcp-port.json'),
      (jobId) => { this.generationManager.cancel(jobId); },
      options.runApprovedFileJob,
      (encoded, width, height, palette, settings) => this.rasterUtilities.quantizeImage(encoded, width, height, palette, settings),
      (document, request, maxPixels) => this.rasterUtilities.captureObservation(document, request, maxPixels ?? 4_194_304),
      options.approvalTimeoutMs,
      (asset) => this.rasterUtilities.renderGenerationApprovalPreview(asset),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.service.recover();
    this.service.initialize();
    await Promise.all([
      this.onionSkinPreferences.initialize(),
      this.orderedDitherPreferences.initialize(),
      this.spriteSymmetryPreferences.initialize(),
      this.workspaceLayoutPreferences.initialize(),
      this.shortcutPreferences.initialize(),
    ]);
    this.recoveryTimer = setInterval(() => void this.service.compactRecovery(), 60_000);
    this.recoveryTimer.unref();
    try {
      const credential = await this.mcpCredentials.loadOrCreate();
      if (credential.status === 'revoked') {
        this.service.setMcpInfo({ running: false, access: 'revoked', tokenHint: 'Access revoked' });
      } else {
        this.service.setMcpInfo({ running: true, access: 'active', ...(await this.mcpHost.start(credential.token)) });
      }
    } catch (error) {
      this.service.setMcpInfo({ running: false, access: 'unavailable', tokenHint: error instanceof Error ? error.message : 'MCP unavailable' });
    }
  }

  async editorBootstrap(): Promise<EditorBootstrapSnapshot> {
    const preferenceBootstrap = await this.onionSkinPreferences.bootstrap();
    const ditherBootstrap = await this.orderedDitherPreferences.bootstrap();
    const symmetryBootstrap = await this.spriteSymmetryPreferences.bootstrap();
    const workspaceLayoutBootstrap = await this.workspaceLayoutPreferences.bootstrap();
    const shortcutBootstrap = await this.shortcutPreferences.bootstrap();
    const snapshot = this.service.snapshot();
    const recoveryWarnings = [
      ...(snapshot.recoveryWarnings ?? []),
      ...(preferenceBootstrap.warning ? [preferenceBootstrap.warning] : []),
      ...(ditherBootstrap.warning ? [ditherBootstrap.warning] : []),
      ...(symmetryBootstrap.warning ? [symmetryBootstrap.warning] : []),
      ...(workspaceLayoutBootstrap.warning ? [workspaceLayoutBootstrap.warning] : []),
      ...(shortcutBootstrap.warning ? [shortcutBootstrap.warning] : []),
    ];
    return {
      ...snapshot,
      onionSkinPreferences: preferenceBootstrap.preferences,
      orderedDitherPreferences: ditherBootstrap.preferences,
      symmetryPreferences: symmetryBootstrap.preferences,
      workspaceLayoutPreferences: workspaceLayoutBootstrap.preferences,
      shortcutPreferences: shortcutBootstrap.preferences,
      ...(recoveryWarnings.length ? { recoveryWarnings } : {}),
    };
  }

  async setOnionSkinPreferences(value: unknown): Promise<OnionSkinPreferenceSaveResult> {
    let preferences: OnionSkinPreferences;
    try { preferences = parseOnionSkinPreferences(value); }
    catch {
      return { saved: false, message: 'AIDraw rejected invalid onion skin preferences; the saved preference was not changed.' };
    }
    try {
      return { saved: true, preferences: await this.onionSkinPreferences.save(preferences) };
    } catch {
      return { saved: false, message: 'Onion skin changed in this editor, but AIDraw could not save it. The previous saved preference remains.' };
    }
  }

  async setOrderedDitherPreferences(value: unknown): Promise<OrderedDitherPreferenceSaveResult> {
    let preferences: OrderedDitherPreferences;
    try { preferences = parseOrderedDitherPreferences(value); }
    catch {
      return { saved: false, message: 'AIDraw rejected invalid ordered dither preferences; the saved preference was not changed.' };
    }
    try {
      return { saved: true, preferences: await this.orderedDitherPreferences.save(preferences) };
    } catch {
      return { saved: false, message: 'Ordered dither settings changed in this editor, but AIDraw could not save them. The previous saved preference remains.' };
    }
  }

  async setSpriteSymmetryPreferences(value: unknown): Promise<SpriteSymmetryPreferenceSaveResult> {
    let preferences: SpriteSymmetryPreferences;
    try { preferences = parseSpriteSymmetryPreferences(value); }
    catch {
      return { saved: false, message: 'AIDraw rejected invalid sprite symmetry preferences; the saved preference was not changed.' };
    }
    try {
      return { saved: true, preferences: await this.spriteSymmetryPreferences.save(preferences) };
    } catch {
      return { saved: false, message: 'Sprite symmetry changed in this editor, but AIDraw could not save it. The previous saved preference remains.' };
    }
  }

  async setWorkspaceLayoutPreferences(value: unknown): Promise<WorkspaceLayoutPreferenceSaveResult> {
    let preferences: WorkspaceLayoutPreferences;
    try { preferences = parseWorkspaceLayoutPreferences(value); }
    catch {
      return { saved: false, message: 'AIDraw rejected invalid workspace layout preferences; the saved layout was not changed.' };
    }
    try {
      return { saved: true, preferences: await this.workspaceLayoutPreferences.save(preferences) };
    } catch {
      return { saved: false, message: 'Inspector layout changed in this editor, but AIDraw could not save it. The previous saved layout remains.' };
    }
  }

  async setShortcutPreferences(value: unknown): Promise<ShortcutPreferenceSaveResult> {
    let preferences: ShortcutPreferences;
    try { preferences = parseShortcutPreferences(value); }
    catch {
      return { saved: false, message: 'AIDraw rejected invalid shortcut preferences; the saved mapping was not changed.' };
    }
    try {
      return { saved: true, preferences: await this.shortcutPreferences.save(preferences) };
    } catch {
      return { saved: false, message: 'Keyboard shortcuts changed in this editor, but AIDraw could not save them. The previous saved mapping remains.' };
    }
  }

  rotateMcpCredential(): Promise<McpCredentialTransition> {
    return this.exclusiveMcpCredentialOperation(async () => {
      this.assertCredentialMutationAvailable();
      const token = await this.mcpCredentials.rotate();
      const current = this.mcpHost.credentials();
      if (current.url) {
        const sessionsTerminated = await this.mcpHost.replaceCredential(token);
        this.service.setMcpInfo({
          running: true,
          access: 'active',
          url: current.url,
          port: Number(new URL(current.url).port),
          tokenHint: 'Credential active',
        });
        return { access: 'active', endpointRunning: true, sessionsTerminated };
      }
      try {
        const started = await this.mcpHost.start(token);
        this.service.setMcpInfo({ running: true, access: 'active', ...started });
        return { access: 'active', endpointRunning: true, sessionsTerminated: 0 };
      } catch {
        this.service.setMcpInfo({ running: false, access: 'unavailable', tokenHint: 'MCP unavailable' });
        throw new Error('The MCP credential was replaced and every prior bearer is invalid, but the local endpoint could not be started. Existing client configurations are stale. Restart AIDraw or rotate again to retry.');
      }
    });
  }

  revokeMcpAccess(): Promise<McpCredentialTransition> {
    return this.exclusiveMcpCredentialOperation(async () => {
      this.assertCredentialMutationAvailable();
      await this.mcpCredentials.revoke();
      const sessionsTerminated = await this.mcpHost.revokeCredential();
      let cleanupFailed = false;
      try {
        await this.mcpHost.stop();
      } catch {
        cleanupFailed = true;
      }
      const endpoint = this.mcpHost.credentials();
      const endpointRunning = Boolean(endpoint.url);
      this.service.setMcpInfo({
        running: endpointRunning,
        access: 'revoked',
        url: endpoint.url,
        port: endpoint.url ? Number(new URL(endpoint.url).port) : undefined,
        tokenHint: 'Access revoked',
      });
      return {
        access: 'revoked',
        endpointRunning,
        sessionsTerminated,
        ...(cleanupFailed ? {
          cleanupWarning: endpointRunning
            ? 'MCP access was revoked and every bearer remains invalid, but the local endpoint could not be fully stopped. Restart AIDraw before re-enabling access.'
            : 'MCP access was revoked and every bearer remains invalid, but final MCP cleanup did not complete. Restart AIDraw before re-enabling access.',
        } : {}),
      };
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.stopPromise) return this.stopPromise;
    const operation = this.stopStartedRuntime();
    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = undefined;
    }
  }

  private async stopStartedRuntime(): Promise<void> {
    await this.mcpCredentialOperation;
    await Promise.all([
      this.onionSkinPreferences.flush(),
      this.orderedDitherPreferences.flush(),
      this.spriteSymmetryPreferences.flush(),
      this.workspaceLayoutPreferences.flush(),
      this.shortcutPreferences.flush(),
    ]);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.mcpHost.stop();
    this.rasterUtilities.stop();
    this.generationUtilities.stop();
    await this.service.compactRecovery();
    this.service.setMcpInfo({ running: false });
    this.started = false;
  }

  private assertCredentialMutationAvailable(): void {
    if (!this.started || this.stopPromise) throw new Error('The AIDraw engine is stopping.');
  }

  private exclusiveMcpCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mcpCredentialOperation.then(operation, operation);
    this.mcpCredentialOperation = result.then(() => undefined, () => undefined);
    return result;
  }
}

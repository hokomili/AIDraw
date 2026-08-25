import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AsyncJob } from '@aidraw/core';
import { parseOnionSkinPreferences, type OnionSkinPreferences } from '../common/onion-skin';
import { parseOrderedDitherPreferences, type OrderedDitherPreferences } from '../common/ordered-dither-preferences';
import { parseSpriteSymmetryPreferences, type SpriteSymmetryPreferences } from '../common/sprite-symmetry';
import { parseWorkspaceLayoutPreferences, type WorkspaceLayoutPreferences } from '../common/workspace-layout';
import { parseShortcutPreferences, type ShortcutPreferences } from '../common/shortcut-preferences';
import type { EditorBootstrapSnapshot, OnionSkinPreferenceSaveResult, OrderedDitherPreferenceSaveResult, ShortcutPreferenceSaveResult, SpriteSymmetryPreferenceSaveResult, WorkspaceLayoutPreferenceSaveResult } from '../common/contracts';
import { DocumentService } from './document-service';
import { RecoveryJournal } from './journal';
import { McpHost } from './mcp-host';
import { createEphemeralMcpAuthority } from './mcp-authority';
import { publishMcpEngineRunState, retireMcpEngineRunState, type McpEngineRunState } from './mcp-run-state';
import { TransactionTraceStore } from './trace-store';
import { RasterUtilitySupervisor } from './utility-supervisor';
import { DocumentPresetStore } from './document-preset-store';
import { InterchangeReportStore } from './interchange-report-store';
import { OnionSkinPreferenceStore } from './onion-skin-preference-store';
import { OrderedDitherPreferenceStore } from './ordered-dither-preference-store';
import { SpriteSymmetryPreferenceStore } from './sprite-symmetry-preference-store';
import { WorkspaceLayoutPreferenceStore } from './workspace-layout-preference-store';
import { ShortcutPreferenceStore } from './shortcut-preference-store';

export interface EngineRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  runApprovedFileJob?: (job: AsyncJob) => void;
  approvalTimeoutMs?: number;
  /** Testable server bound; ordinary product launches use McpHost's default. */
  mcpProvisionalSessionTtlMs?: number;
}

/**
 * Canonical AIDraw engine. It owns every mutable document concern and has no
 * BrowserWindow dependency, so it can run for an entire user session without
 * an editor renderer attached.
 */
export class EngineRuntime {
  readonly service: DocumentService;
  readonly mcpHost: McpHost;
  readonly rasterUtilities: RasterUtilitySupervisor;
  readonly documentPresets: DocumentPresetStore;
  readonly interchangeReports: InterchangeReportStore;
  readonly onionSkinPreferences: OnionSkinPreferenceStore;
  readonly orderedDitherPreferences: OrderedDitherPreferenceStore;
  readonly spriteSymmetryPreferences: SpriteSymmetryPreferenceStore;
  readonly workspaceLayoutPreferences: WorkspaceLayoutPreferenceStore;
  readonly shortcutPreferences: ShortcutPreferenceStore;
  private recoveryTimer?: NodeJS.Timeout;
  private started = false;
  private stopPromise?: Promise<void>;
  private mcpRunState?: McpEngineRunState;

  constructor(private readonly options: EngineRuntimeOptions) {
    const { userDataPath, appVersion } = options;
    this.rasterUtilities = new RasterUtilitySupervisor();
    this.service = new DocumentService(
      new RecoveryJournal(join(userDataPath, 'recovery')),
      appVersion,
      new TransactionTraceStore(join(userDataPath, 'traces')),
      (bytes, expected, control) => this.rasterUtilities.validateImage(bytes, expected, control),
      async (document) => (await this.rasterUtilities.exportDocument(document, 'png')).data,
    );
    this.documentPresets = new DocumentPresetStore(join(userDataPath, 'settings', 'document-presets.json'));
    this.onionSkinPreferences = new OnionSkinPreferenceStore(join(userDataPath, 'settings', 'onion-skin.json'));
    this.orderedDitherPreferences = new OrderedDitherPreferenceStore(join(userDataPath, 'settings', 'ordered-dither.json'));
    this.spriteSymmetryPreferences = new SpriteSymmetryPreferenceStore(join(userDataPath, 'settings', 'sprite-symmetry.json'));
    this.workspaceLayoutPreferences = new WorkspaceLayoutPreferenceStore(join(userDataPath, 'settings', 'workspace-layout.json'));
    this.shortcutPreferences = new ShortcutPreferenceStore(join(userDataPath, 'settings', 'shortcuts.json'));
    this.interchangeReports = new InterchangeReportStore(join(userDataPath, 'reports', 'interchange.json'));
    this.mcpHost = new McpHost(
      this.service,
      appVersion,
      join(userDataPath, 'mcp-port.json'),
      options.runApprovedFileJob,
      (encoded, width, height, palette, settings, control) => this.rasterUtilities.quantizeImage(encoded, width, height, palette, settings, control),
      (document, request, maxPixels) => this.rasterUtilities.captureObservation(document, request, maxPixels ?? 4_194_304),
      options.approvalTimeoutMs,
      { provisionalSessionTtlMs: options.mcpProvisionalSessionTtlMs },
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
    const instanceId = randomUUID();
    try {
      const token = createEphemeralMcpAuthority();
      const connection = await this.mcpHost.start(token, instanceId);
      const runState: McpEngineRunState = {
        version: 1,
        instanceId,
        pid: process.pid,
        authority: 'engine-run',
        url: connection.url,
        token,
        startedAt: new Date().toISOString(),
      };
      await publishMcpEngineRunState(this.options.userDataPath, runState);
      this.mcpRunState = runState;
      this.service.setMcpInfo({ running: true, authority: 'ephemeral', ...connection });
    } catch (error) {
      await this.mcpHost.stop().catch(() => undefined);
      await retireMcpEngineRunState(this.options.userDataPath, instanceId);
      this.service.setMcpInfo({ running: false, authority: 'unavailable', tokenHint: error instanceof Error ? error.message : 'MCP unavailable' });
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
      return { saved: false, message: 'Workspace layout changed in this editor, but AIDraw could not save it. The previous saved layout remains.' };
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
    await Promise.all([
      this.onionSkinPreferences.flush(),
      this.orderedDitherPreferences.flush(),
      this.spriteSymmetryPreferences.flush(),
      this.workspaceLayoutPreferences.flush(),
      this.shortcutPreferences.flush(),
    ]);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const runState = this.mcpRunState;
    this.mcpRunState = undefined;
    try {
      await this.mcpHost.stop();
    } finally {
      if (runState) await retireMcpEngineRunState(this.options.userDataPath, runState.instanceId);
    }
    this.rasterUtilities.stop();
    await this.service.compactRecovery();
    this.service.setMcpInfo({ running: false, authority: 'unavailable' });
    this.started = false;
  }

}

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasTransactionSchema, HUMAN_ACTOR, createId, nowIso, type AsyncJob, type CanvasOperation } from '@aidraw/core';
import { IPC, type BatchDocumentResult, type DocumentPresetInput, type EngineStatus, type ExportOptions, type HumanLockRequest, type InterchangeReportInput, type NewDocumentOptions, type PixelLinkAction, type PixelLinkActionResult } from '../common/contracts';
import { applyPortablePalette, parsePaletteFile, serializePaletteFile, type PaletteFileFormat, type PaletteImportMode } from '../common/palette-interchange';
import type { DocumentService } from './document-service';
import type { McpHost } from './mcp-host';
import type { ProviderCredentialStore } from './provider-credentials';
import type { GenerationManager } from './generation-manager';
import { EngineRuntime } from './engine-runtime';
import type { GenerationRequest } from '../common/generation';
import type { ExportFormat } from './export-document';
import { cliHelp, executeBatchExport, parseCliArguments, type CliCommand } from './cli';
import { validateSpriteSheetSliceOptions, type SpriteSheetSliceOptions } from '../common/sprite-sheet';
import { buildRendererDiagnostics, type RendererFailureDetail } from './renderer-diagnostics';
import { embedPixelLink, externalizePixelLink } from '../common/pixel-links';
import { MAX_PROJECT_LINK_BYTES, portableProjectAssetPath, preparePixelLinkRelink, projectLinkFileExtension, verifiedPixelLinkCache } from './pixel-link-files';
import { agentClientDescriptor, isAgentClientId, type AgentClientId, type AgentClientSetupResult } from '../common/agent-clients';
import { configureAgentClientFile } from './agent-client-config';
import { secureStorageStatus } from './secure-storage';
import { getStartAtLoginStatus, setStartAtLogin, wasOpenedAtLogin } from './start-at-login';
import { resolveRendererRecoveryE2eConfiguration, sanitizedMalformedRendererRecoveryEvent } from './renderer-recovery-e2e';
import { createQa06GenerationE2eRunner, installQa06GenerationE2eNetworkBoundary, resolveQa06GenerationE2eConfiguration } from './generation-e2e';
import { createQa06PixelPaletteE2eRunner, installQa06PixelPaletteE2eNetworkBoundary, resolveQa06PixelPaletteE2eConfiguration } from './pixel-generation-e2e';
import { BatchDocumentWorkflows, safeBatchFileStem as safeFileStem, type BatchExportFormat } from './batch-document-workflows';
import { installUx11BatchE2eNetworkBoundary, resolveUx11BatchE2eConfiguration, Ux11BatchE2eController } from './batch-workflows-e2e';
import { assertTrustedRendererInvocation, isTrustedRendererUrl } from './renderer-security';
import { installFnd09UtilityContainmentNetworkBoundary, resolveFnd09UtilityContainmentE2eConfiguration, runFnd09UtilityContainmentScenario } from './utility-containment-e2e';
import { resolveFnd09UtilityPressureE2eConfiguration, runFnd09UtilityPressureScenario } from './utility-pressure-e2e';
import { resolveFnd09ObservationCodecE2eConfiguration, runFnd09ObservationCodecScenario } from './utility-observation-codec-e2e';
import { resolveFnd09QuantizationResultE2eConfiguration, runFnd09QuantizationResultScenario } from './utility-quantization-result-e2e';
import { resolveFnd09ExportResultE2eConfiguration, runFnd09ExportResultScenario } from './utility-export-result-e2e';
import { resolveFnd09ImportResultE2eConfiguration, runFnd09ImportResultScenario } from './utility-import-result-e2e';
import { resolveFnd09GenerationResultE2eConfiguration, runFnd09GenerationResultScenario } from './utility-generation-result-e2e';
import {
  createFnd09GenerationNormalizationE2eRunner,
  installFnd09GenerationNormalizationE2eNetworkBoundary,
  resolveFnd09GenerationNormalizationE2eConfiguration,
} from './generation-normalization-e2e';
import {
  assertClipboardImageGeometry,
  copySelectionToClipboard,
  pasteFromClipboard,
  type ClipboardWorkflowDependencies,
} from './clipboard-workflows';
import { buildCheckpointComparison } from './checkpoint-comparison';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let engineRuntime: EngineRuntime;
let service: DocumentService;
let mcpHost: McpHost;
let providerCredentials: ProviderCredentialStore;
let generationManager: GenerationManager;
let batchDocumentWorkflows: BatchDocumentWorkflows;
let engineShutdownComplete = false;
let engineQuitPending = false;
let engineReadyPromise: Promise<void> | undefined;
let suppressMacLoginActivationUntil = 0;
const pendingSpriteSheets = new Map<string, { filePath: string; sha256: string; name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; expiresAt: number }>();

async function recordInterchangeReport(input: InterchangeReportInput) {
  const report = await engineRuntime.interchangeReports.record(input);
  mainWindow?.webContents.send(IPC.event, { type: 'interchange-report', report });
  return report;
}

const cliArguments = process.argv.slice(app.isPackaged ? 1 : 2);
let cliCommand: CliCommand | undefined; let cliParseError: Error | undefined;
try { cliCommand = parseCliArguments(cliArguments); } catch (error) { cliParseError = error instanceof Error ? error : new Error(String(error)); }
const cliInvocation = Boolean(cliCommand || cliParseError);
const startupCommand = cliInvocation
  ? 'cli'
  : process.argv.includes('--quit-engine')
    ? 'quit-engine'
    : process.argv.includes('--headless')
      ? 'headless'
      : 'show';
if (startupCommand === 'headless' || startupCommand === 'cli') app.disableHardwareAcceleration();
const explicitUserData = process.argv.find((argument) => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const explicitMcpConnectionFile = process.argv.find((argument) => argument.startsWith('--write-mcp-connection='))?.slice('--write-mcp-connection='.length);
const explicitTrustedFolders = process.argv
  .filter((argument) => argument.startsWith('--trust-folder='))
  .map((argument) => argument.slice('--trust-folder='.length));
if (explicitUserData) {
  const isolatedPath = resolve(explicitUserData);
  app.setPath('userData', isolatedPath);
  app.setName(`AIDraw-${createHash('sha256').update(isolatedPath.toLowerCase()).digest('hex').slice(0, 12)}`);
}
const hasSingleInstanceLock = cliInvocation || app.requestSingleInstanceLock({ command: startupCommand });

const rendererRecoveryE2e = resolveRendererRecoveryE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_RENDERER_RECOVERY,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  diagnosticPath: process.env.AIDRAW_E2E_RENDERER_DIAGNOSTIC_PATH,
});
const qa06GenerationE2e = resolveQa06GenerationE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_QA06_GENERATION_MOCK,
  declaredProfilePath: process.env.AIDRAW_E2E_QA06_GENERATION_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  outputPath: process.env.AIDRAW_E2E_QA06_GENERATION_MOCK_OUTPUT_PATH,
  auditPath: process.env.AIDRAW_E2E_QA06_GENERATION_MOCK_AUDIT_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_QA06_GENERATION_NETWORK_SENTINEL_PATH,
});
const qa06PixelPaletteE2e = resolveQa06PixelPaletteE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK,
  declaredProfilePath: process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  outputPath: process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK_OUTPUT_PATH,
  auditPath: process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK_AUDIT_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_NETWORK_SENTINEL_PATH,
});
const fnd09GenerationNormalizationE2e = resolveFnd09GenerationNormalizationE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_GENERATION_NORMALIZATION,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  normalizableOutputPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_NORMALIZABLE_OUTPUT_PATH,
  previewOnlyOutputPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_OUTPUT_PATH,
  auditPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_AUDIT_PATH,
  readyProbePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_READY_PROBE_PATH,
  previewOnlyProbePath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_NORMALIZATION_NETWORK_SENTINEL_PATH,
});
if ([qa06GenerationE2e, qa06PixelPaletteE2e, fnd09GenerationNormalizationE2e].filter(Boolean).length > 1) throw new Error('Only one isolated generation fixture may be enabled.');
if (qa06GenerationE2e) installQa06GenerationE2eNetworkBoundary(qa06GenerationE2e);
if (qa06PixelPaletteE2e) installQa06PixelPaletteE2eNetworkBoundary(qa06PixelPaletteE2e);
if (fnd09GenerationNormalizationE2e) installFnd09GenerationNormalizationE2eNetworkBoundary(fnd09GenerationNormalizationE2e);
const ux11BatchE2e = resolveUx11BatchE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UX11_BATCH,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_UX11_BATCH_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
});
const ux11BatchE2eController = ux11BatchE2e ? new Ux11BatchE2eController(ux11BatchE2e) : undefined;
if (ux11BatchE2e) installUx11BatchE2eNetworkBoundary(ux11BatchE2e);
const fnd09UtilityContainmentE2e = resolveFnd09UtilityContainmentE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_CONTAINMENT,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_UTILITY_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_UTILITY_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_UTILITY_NETWORK_SENTINEL_PATH,
});
const fnd09UtilityPressureE2e = resolveFnd09UtilityPressureE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_PRESSURE,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_PRESSURE_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_PRESSURE_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_PRESSURE_NETWORK_SENTINEL_PATH,
});
const fnd09ObservationCodecE2e = resolveFnd09ObservationCodecE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_OBSERVATION_CODEC,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_NETWORK_SENTINEL_PATH,
});
const fnd09QuantizationResultE2e = resolveFnd09QuantizationResultE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_NETWORK_SENTINEL_PATH,
});
const fnd09ExportResultE2e = resolveFnd09ExportResultE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_EXPORT_RESULT,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_NETWORK_SENTINEL_PATH,
});
const fnd09ImportResultE2e = resolveFnd09ImportResultE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_IMPORT_RESULT,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_NETWORK_SENTINEL_PATH,
});
const fnd09GenerationResultE2e = resolveFnd09GenerationResultE2eConfiguration({
  nodeEnv: process.env.NODE_ENV,
  enabled: process.env.AIDRAW_E2E_UTILITY_GENERATION_RESULT,
  workspacePath: process.cwd(),
  declaredProfilePath: process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE,
  userDataPath: explicitUserData,
  connectionPath: explicitMcpConnectionFile,
  probePath: process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_PROBE_PATH,
  networkSentinelPath: process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_NETWORK_SENTINEL_PATH,
});
const fnd09UtilityFixtures = [fnd09UtilityContainmentE2e, fnd09UtilityPressureE2e, fnd09ObservationCodecE2e, fnd09QuantizationResultE2e, fnd09ExportResultE2e, fnd09ImportResultE2e, fnd09GenerationResultE2e].filter(Boolean);
if (fnd09UtilityFixtures.length > 1) throw new Error('Only one isolated FND-09 utility fixture may be enabled.');
if (fnd09UtilityFixtures.length && (startupCommand !== 'headless' || rendererRecoveryE2e || qa06GenerationE2e || qa06PixelPaletteE2e || fnd09GenerationNormalizationE2e || ux11BatchE2e)) {
  throw new Error('The isolated FND-09 utility probe requires its own headless profile and fixture boundary.');
}
if (fnd09UtilityContainmentE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09UtilityContainmentE2e);
if (fnd09UtilityPressureE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09UtilityPressureE2e);
if (fnd09ObservationCodecE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09ObservationCodecE2e);
if (fnd09QuantizationResultE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09QuantizationResultE2e);
if (fnd09ExportResultE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09ExportResultE2e);
if (fnd09ImportResultE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09ImportResultE2e);
if (fnd09GenerationResultE2e) installFnd09UtilityContainmentNetworkBoundary(fnd09GenerationResultE2e);

function isIsolatedOpenCodeE2eApproval(clientId: AgentClientId): boolean {
  if (clientId !== 'opencode' || process.env.NODE_ENV !== 'test' || process.env.AIDRAW_E2E_AUTO_APPROVE_AGENT_CLIENT !== 'opencode') return false;
  const configPath = process.env.AIDRAW_OPENCODE_CONFIG_PATH;
  if (!explicitUserData || !explicitMcpConnectionFile || !configPath) return false;
  const profile = resolve(explicitUserData);
  if (!basename(profile).toLowerCase().startsWith('aidraw-e2e-')) return false;
  const isInsideProfile = (path: string) => {
    const candidate = relative(profile, resolve(path));
    return candidate.length > 0 && !candidate.startsWith('..') && !isAbsolute(candidate);
  };
  return isInsideProfile(explicitMcpConnectionFile) && isInsideProfile(configPath);
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'aidraw',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  assertTrustedRendererInvocation(event, mainWindow?.webContents, MAIN_WINDOW_VITE_DEV_SERVER_URL);
}

async function saveDocument(documentId?: string, saveAs = false) {
  const id = documentId ?? service.getActiveDocumentId();
  if (!id) return { saved: false, cancelled: true };
  const document = service.getDocument(id);
  if (!document) return { saved: false, cancelled: true };
  let filePath = saveAs ? undefined : document.filePath;
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save AIDraw document',
      defaultPath: `${document.name.replace(/[<>:"/\\|?*]/g, '-')}.aidraw`,
      filters: [{ name: 'AIDraw document', extensions: ['aidraw'] }],
      properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { saved: false, cancelled: true };
    filePath = result.filePath;
  }
  const destination = await service.save(id, filePath);
  return { saved: true, filePath: destination };
}

async function saveAllDocuments(): Promise<BatchDocumentResult> {
  return batchDocumentWorkflows.saveAllDocuments();
}

async function batchExportDocuments(format: BatchExportFormat, options: ExportOptions = {}): Promise<BatchDocumentResult> {
  return batchDocumentWorkflows.batchExportDocuments(format, options);
}

async function closeAllDocuments(): Promise<BatchDocumentResult> {
  return batchDocumentWorkflows.closeAllDocuments();
}

async function openDocuments(): Promise<{ opened: string[]; warnings: string[] }> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return { opened: [], warnings: ['The editor window is unavailable.'] };
  const result = await dialog.showOpenDialog(window, {
    title: 'Open AIDraw document',
    filters: [{ name: 'AIDraw document', extensions: ['aidraw'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? { opened: [], warnings: [] } : service.open(result.filePaths);
}

function normalizedAuthorityPath(filePath: string): string {
  const value = resolve(filePath);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function approvedOverwritePaths(request: Record<string, unknown>): Set<string> {
  return new Set((Array.isArray(request.overwritePaths) ? request.overwritePaths : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizedAuthorityPath));
}

async function assertOverwriteAuthority(filePath: string, approved: Set<string>): Promise<void> {
  const exists = await stat(filePath).then(() => true, () => false);
  if (exists && !approved.has(normalizedAuthorityPath(filePath))) {
    throw new Error(`The target ${filePath} appeared or changed after approval. Submit the exact overwrite for approval again.`);
  }
}

async function writeApprovedTarget(filePath: string, data: Buffer, approved: Set<string>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const existed = await stat(filePath).then(() => true, () => false);
  if (existed && !approved.has(normalizedAuthorityPath(filePath))) {
    throw new Error(`The target ${filePath} appeared or changed after approval. Submit the exact overwrite for approval again.`);
  }
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${createId('write')}.tmp`;
  await writeFile(temporaryPath, data);
  try {
    if (existed) await rename(temporaryPath, filePath);
    else {
      await link(temporaryPath, filePath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function runApprovedFileJob(job: AsyncJob): Promise<void> {
  const result = job.result as { documentId?: string; request?: Record<string, unknown> } | undefined;
  const request = result?.request; if (!request) return;
  service.upsertJob({ ...job, status: 'running', progress: 0.1, updatedAt: nowIso(), message: `Running approved ${job.kind}…` });
  try {
    const action = String(request.action ?? ''); const requestedPath = typeof request.path === 'string' ? resolve(request.path) : undefined;
    const approvedOverwrites = approvedOverwritePaths(request);
    let output: unknown;
    if (job.kind === 'import' && action === 'open' && requestedPath) output = await service.open([requestedPath]);
    else if (job.kind === 'import' && action === 'project-link-relink' && requestedPath && result?.documentId && typeof request.projectLinkId === 'string') {
      const document = service.getDocument(result.documentId); if (!document || document.kind !== 'pixel') throw new Error('Project-link relink requires an open pixel document.');
      const file = await stat(requestedPath); if (!file.isFile() || file.size < 1 || file.size > MAX_PROJECT_LINK_BYTES) throw new Error('Relinked source images must be non-empty files no larger than 1.5 MB.');
      const bytes = await readFile(requestedPath); if (bytes.byteLength !== file.size) throw new Error('The relink source changed while it was being read; submit it again.');
      const prepared = preparePixelLinkRelink(document, request.projectLinkId, requestedPath, bytes);
      const response = await service.apply({ id: createId('tx'), clientOperationId: createId('project-link-relink'), documentId: document.id, actor: job.actor, label: `Relink project asset · ${basename(requestedPath)}`, createdAt: nowIso(), operations: prepared.operations, playback: { mode: 'instant', speed: 1 } });
      if (response.status !== 'committed' && response.status !== 'duplicate') throw new Error(response.message ?? 'The project link could not be relinked.');
      const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: job.actor, documentIds: [document.id], documentNames: [document.name], format: 'project-link-source', sourcePaths: [requestedPath], destinationPaths: [], warnings: [], rasterized: [] });
      output = { linkId: request.projectLinkId, path: requestedPath, relativePath: prepared.relativePath, reportId: report.id };
    }
    else if (job.kind === 'import' && action === 'import' && requestedPath) {
      const paletteMode = request.paletteMode === 'replace-slots' || request.paletteMode === 'append-unique' ? request.paletteMode : undefined;
      const spriteSheet = request.spriteSheet && typeof request.spriteSheet === 'object' ? validateSpriteSheetSliceOptions(request.spriteSheet as unknown as SpriteSheetSliceOptions) : undefined;
      if (paletteMode) {
        if (!result?.documentId) throw new Error('Palette import requires a target document.'); const document = service.getDocument(result.documentId); if (!document || document.kind !== 'pixel') throw new Error('Palette import requires an open pixel document.');
        const bytes = await readFile(requestedPath); const parsed = parsePaletteFile(bytes, extname(requestedPath)); const applied = applyPortablePalette(document.palette, parsed.entries, paletteMode, () => createId('palette'));
        const response = await service.apply({ id: createId('tx'), clientOperationId: createId('palette-import'), documentId: document.id, actor: job.actor, label: paletteMode === 'append-unique' ? `Append palette · ${parsed.name}` : `Import palette slots · ${parsed.name}`, createdAt: nowIso(), operations: [{ kind: 'pixel.palette.replace', palette: applied.palette }], playback: { mode: 'instant', speed: 1 } });
        if (response.status !== 'committed' && response.status !== 'duplicate') throw new Error(response.message ?? 'Palette import could not be committed.'); const warnings = [...parsed.warnings, ...applied.warnings];
        const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: job.actor, documentIds: [document.id], documentNames: [document.name], format: `palette-${parsed.format}`, sourcePaths: [requestedPath], destinationPaths: [], warnings, rasterized: [] }); output = { imported: [document.id], added: applied.added, updated: applied.updated, skipped: applied.skipped, warnings, reportId: report.id };
      } else {
        let imported;
        if (spriteSheet) { const extension = extname(requestedPath).toLowerCase(); imported = await engineRuntime.rasterUtilities.importSpriteSheet(requestedPath, { options: spriteSheet, name: basename(requestedPath, extension) }); }
        else imported = await engineRuntime.rasterUtilities.importDocument(requestedPath, request.pixelMode === true);
        for (const document of imported.documents) service.addDocument(document);
        const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: job.actor, documentIds: imported.documents.map((document) => document.id), documentNames: imported.documents.map((document) => document.name), format: spriteSheet ? 'sprite-sheet-image' : extname(requestedPath).slice(1).toLowerCase() || 'unknown', sourcePaths: [requestedPath], destinationPaths: [], warnings: imported.warnings, rasterized: imported.warnings.filter((warning) => /raster|flatten|fallback/i.test(warning)), ...(imported.fidelity?.length ? { fidelity: imported.fidelity } : {}) });
        output = { imported: imported.documents.map((document) => document.id), warnings: imported.warnings, reportId: report.id };
      }
    } else if (job.kind === 'save' && (action === 'save-as' || action === 'save') && requestedPath && result?.documentId) {
      await assertOverwriteAuthority(requestedPath, approvedOverwrites);
      output = { path: await service.save(result.documentId, requestedPath) };
    }
    else if (job.kind === 'export' && action === 'project-link-extract' && requestedPath && result?.documentId && typeof request.projectLinkId === 'string') {
      const document = service.getDocument(result.documentId); if (!document || document.kind !== 'pixel') throw new Error('Project-link extraction requires an open pixel document.');
      const { link: projectLink, bytes } = verifiedPixelLinkCache(document, request.projectLinkId);
      const relativePath = portableProjectAssetPath(document, requestedPath); await assertOverwriteAuthority(requestedPath, approvedOverwrites); await writeApprovedTarget(requestedPath, bytes, approvedOverwrites);
      const response = await service.apply({ id: createId('tx'), clientOperationId: createId('project-link-extract'), documentId: document.id, actor: job.actor, label: `Extract project link · ${projectLink.name}`, createdAt: nowIso(), operations: [{ kind: 'pixel.links.replace', linkedAssets: externalizePixelLink(document, projectLink.id, relativePath), expectedRevision: document.revision }], playback: { mode: 'instant', speed: 1 } });
      if (response.status !== 'committed' && response.status !== 'duplicate') throw new Error(response.message ?? 'The project link could not be extracted.');
      const report = await recordInterchangeReport({ kind: 'export', status: 'completed', actor: job.actor, documentIds: [document.id], documentNames: [document.name], format: 'project-link-source', sourcePaths: [], destinationPaths: [requestedPath], warnings: [], rasterized: [] });
      output = { linkId: projectLink.id, path: requestedPath, relativePath, reportId: report.id };
    }
    else if (job.kind === 'export' && action === 'export' && requestedPath && result?.documentId) {
      const document = service.getDocument(result.documentId); if (!document) throw new Error('Target document is no longer open.');
      const artifact = await engineRuntime.rasterUtilities.exportDocument(document, String(request.format) as ExportFormat, { scale: request.scale === undefined ? undefined : Number(request.scale), animationTagId: typeof request.animationTagId === 'string' ? request.animationTagId : undefined }); const target = extname(requestedPath) ? requestedPath : `${requestedPath}.${artifact.extension}`;
      const companionPaths: string[] = []; const companions = [...(artifact.companions ?? []), ...(artifact.companion ? [{ ...artifact.companion, name: artifact.companion.name }] : [])];
      const plannedCompanions = companions.map((companion) => ({ companion, path: companion.name ? join(dirname(target), companion.name) : `${target.slice(0, -extname(target).length)}.${companion.extension}` }));
      await Promise.all([target, ...plannedCompanions.map((entry) => entry.path)].map((path) => assertOverwriteAuthority(path, approvedOverwrites)));
      await writeApprovedTarget(target, artifact.data, approvedOverwrites);
      for (const entry of plannedCompanions) { await writeApprovedTarget(entry.path, companionBytes(entry.companion.data, String(request.format), target), approvedOverwrites); companionPaths.push(entry.path); }
      const report = await recordInterchangeReport({ kind: 'export', status: 'completed', actor: job.actor, documentIds: [document.id], documentNames: [document.name], format: String(request.format), sourcePaths: [], destinationPaths: [target, ...companionPaths], warnings: artifact.report.warnings, rasterized: artifact.report.rasterized, ...(artifact.report.fidelity ? { fidelity: artifact.report.fidelity } : {}) });
      output = { path: target, companionPaths, warnings: artifact.report.warnings, reportId: report.id };
    } else throw new Error('The approved file job has invalid or incomplete arguments.');
    service.upsertJob({ ...job, status: 'completed', progress: 1, updatedAt: nowIso(), message: `Approved ${job.kind} completed.`, result: { ...result, output } });
  } catch (error) {
    service.upsertJob({ ...job, status: 'failed', progress: 0, updatedAt: nowIso(), message: `Approved ${job.kind} failed.`, error: { code: 'file_job_failed', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
}

function companionBytes(data: Buffer, format: string, target: string): Buffer {
  if (format !== 'sprite-sheet') return data;
  try { const metadata = JSON.parse(data.toString('utf8')) as { meta?: Record<string, unknown> }; metadata.meta = { ...(metadata.meta ?? {}), image: basename(target) }; return Buffer.from(JSON.stringify(metadata, null, 2)); } catch { return data; }
}

function clipboardDependencies(): ClipboardWorkflowDependencies {
  return {
    getActiveDocument: () => {
      const id = service.getActiveDocumentId();
      return id ? service.getDocument(id) : undefined;
    },
    apply: (transaction) => service.apply(transaction),
    raster: {
      renderPng: async (document) => (await engineRuntime.rasterUtilities.exportDocument(document, 'png')).data,
      quantizePng: (bytes, width, height, palette, settings) => engineRuntime.rasterUtilities.quantizeImage(bytes, width, height, palette, settings),
    },
    clipboard: {
      write: (data) => {
        const image = nativeImage.createFromBuffer(data.png);
        if (image.isEmpty()) throw new Error('Clipboard PNG output could not be decoded for the system clipboard.');
        clipboard.write({ text: data.text, html: data.html, image });
      },
      readHtml: () => clipboard.readHTML(),
      readPng: () => {
        const image = clipboard.readImage();
        if (image.isEmpty()) return undefined;
        const size = image.getSize();
        assertClipboardImageGeometry(size.width, size.height);
        return { bytes: image.toPNG(), width: size.width, height: size.height };
      },
    },
  };
}

const copySelection = (objectIds: string[]) => copySelectionToClipboard(clipboardDependencies(), objectIds);
const pasteClipboard = () => pasteFromClipboard(clipboardDependencies());

function registerIpc(): void {
  const handle = <T extends unknown[], R>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R>,
  ) => ipcMain.handle(channel, (event, ...args: T) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });

  handle(IPC.bootstrap, () => service.snapshot());
  handle<[NewDocumentOptions], ReturnType<DocumentService['create']>>(IPC.newDocument, (_event, options) => {
    if (!['illustration', 'sprite', 'tilemap', 'project'].includes(options.kind)) throw new Error('Unknown document kind.');
    return service.create(options);
  });
  handle<[string], ReturnType<DocumentService['activate']>>(IPC.activateDocument, (_event, id) => service.activate(id));
  handle(IPC.applyTransaction, (_event, value) => {
    const transaction = CanvasTransactionSchema.parse(value);
    return service.apply({ ...transaction, actor: HUMAN_ACTOR });
  });
  handle(IPC.undo, (_event, id?: string) => service.undo(id));
  handle(IPC.redo, (_event, id?: string) => service.redo(id));
  handle(IPC.undoAgent, (_event, documentId: string, actorId: string) => service.undoAgent(documentId, actorId));
  handle(IPC.redoAgent, (_event, documentId: string, actorId: string) => service.redoAgent(documentId, actorId));
  handle(IPC.checkpointCreate, (_event, documentId: string, name: string) => service.createCheckpoint(documentId, name, HUMAN_ACTOR));
  handle(IPC.checkpointCompare, async (_event, documentId: string, checkpointId: string) => {
    const current = service.getDocument(documentId); const checkpoint = service.getCheckpoint(documentId, checkpointId);
    if (!current || !checkpoint) throw new Error('Checkpoint not found.');
    const summary = service.listCheckpoints(documentId).find((entry) => entry.id === checkpoint.id)!;
    const candidates = service.listCheckpointMergeCandidates(documentId, checkpointId);
    return buildCheckpointComparison(current, checkpoint, summary, candidates, async (document) => (
      await engineRuntime.rasterUtilities.exportDocument(document, 'png')
    ).data);
  });
  handle(IPC.checkpointRestore, (_event, documentId: string, checkpointId: string) => service.restoreCheckpoint(documentId, checkpointId, HUMAN_ACTOR));
  handle(IPC.checkpointMerge, (_event, documentId: string, checkpointId: string, sourceIds: string[]) => service.mergeCheckpoint(documentId, checkpointId, sourceIds, HUMAN_ACTOR));
  handle(IPC.checkpointDelete, (_event, documentId: string, checkpointId: string) => service.deleteCheckpoint(documentId, checkpointId, HUMAN_ACTOR));
  handle(IPC.documentPresetsList, () => engineRuntime.documentPresets.list());
  handle(IPC.documentPresetsSave, (_event, preset: DocumentPresetInput) => engineRuntime.documentPresets.save(preset));
  handle(IPC.documentPresetsDelete, (_event, presetId: string) => engineRuntime.documentPresets.delete(presetId));
  handle(IPC.interchangeReportsList, (_event, documentId?: string) => engineRuntime.interchangeReports.list(documentId));
  handle(IPC.interchangeReportExport, async (_event, reportId: string) => {
    const report = await engineRuntime.interchangeReports.get(reportId);
    if (!report) throw new Error('Interchange report not found.');
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Export interchange report', defaultPath: `AIDraw ${report.kind} report ${report.createdAt.slice(0, 10)}.json`, filters: [{ name: 'JSON report', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return { exported: false, cancelled: true };
    await writeApprovedTarget(result.filePath, Buffer.from(`${JSON.stringify({ version: 1, report }, null, 2)}\n`), new Set(await stat(result.filePath).then(() => [normalizedAuthorityPath(result.filePath!)], () => [])));
    return { exported: true, filePath: result.filePath };
  });
  handle(IPC.openDocuments, () => openDocuments());
  handle(IPC.saveDocument, (_event, id?: string) => saveDocument(id));
  handle(IPC.saveDocumentAs, (_event, id?: string) => saveDocument(id, true));
  handle(IPC.saveAllDocuments, () => saveAllDocuments());
  handle(IPC.batchExportDocuments, (_event, format: BatchExportFormat, options?: ExportOptions) => batchExportDocuments(format, options));
  handle(IPC.closeAllDocuments, () => closeAllDocuments());
  handle(IPC.closeDocument, async (_event, id: string, force = false) => {
    const document = service.getDocument(id);
    if (document?.dirty && !force) {
      const decision = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Unsaved drawing',
        message: `Save changes to “${document.name}”?`,
        detail: 'Closing without saving will discard changes from this session.',
        buttons: ['Save', 'Cancel', 'Discard'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (decision.response === 1) return { closed: false, reason: 'cancelled' };
      if (decision.response === 0) {
        const saved = await saveDocument(id);
        if (!saved.saved) return { closed: false, reason: 'cancelled' };
      }
      return service.close(id, true);
    }
    return service.close(id, force === true);
  });
  handle(IPC.stopAgents, (_event, id?: string) => mcpHost.scheduler.stop(id) + service.stopAgents(id));
  handle(IPC.acquireHumanLock, (_event, request: HumanLockRequest) => service.acquireLock(request));
  handle(IPC.releaseHumanLock, (_event, id: string) => service.releaseLock(id));
  handle(IPC.mcpInfo, () => service.getMcpInfo());
  handle(IPC.mcpCredentials, () => mcpHost.credentials());
  handle(IPC.engineStatus, () => engineStatus());
  handle(IPC.engineStartAtLogin, (_event, enabled: boolean) => setEngineStartAtLogin(enabled === true));
  handle(IPC.resolveJob, (_event, jobId: string, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny') => {
    const job = service.resolveJob(jobId, decision);
    if (job?.status === 'queued' && job.kind === 'generation') void generationManager.runApproved(job);
    else if (job?.status === 'queued' && ['import', 'export', 'save'].includes(job.kind)) void runApprovedFileJob(job);
    return job;
  });
  handle(IPC.setProviderCredential, async (_event, provider: 'openai' | 'stability', value: string) => {
    if (provider !== 'openai' && provider !== 'stability') throw new Error('Unknown hosted provider.');
    await providerCredentials.set(provider, value);
    return { saved: true };
  });
  handle(IPC.getProviderStatus, () => providerCredentials.status());
  handle(IPC.generationStart, (_event, request: GenerationRequest) => generationManager.startHuman(request));
  handle(IPC.generationAccept, (_event, jobId: string, outputId: string) => generationManager.accept(jobId, outputId));
  handle(IPC.generationReject, (_event, jobId: string, outputId: string) => generationManager.reject(jobId, outputId));
  handle(IPC.jobCancel, (_event, jobId: string) => generationManager.cancel(jobId));
  handle(IPC.rendererRecoveryTestEvent, () => {
    if (!rendererRecoveryE2e) throw new Error('The renderer recovery test event is unavailable outside its isolated E2E profile.');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The isolated renderer recovery test window is unavailable.');
    const probe = sanitizedMalformedRendererRecoveryEvent();
    mainWindow.webContents.send(IPC.event, probe.event);
    return { injected: true, byteLength: probe.byteLength };
  });
  handle(IPC.rendererDiagnosticsExport, async (_event, detail: RendererFailureDetail) => {
    if (!detail || typeof detail !== 'object' || typeof detail.message !== 'string') throw new Error('Renderer diagnostics require an error message.');
    const result = rendererRecoveryE2e
      ? { canceled: false, filePath: rendererRecoveryE2e.diagnosticPath }
      : await dialog.showSaveDialog(mainWindow!, { title: 'Save AIDraw renderer diagnostics', defaultPath: `aidraw-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, filters: [{ name: 'JSON diagnostics', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return { saved: false, cancelled: true };
    const diagnostic = buildRendererDiagnostics({ appVersion: app.getVersion(), platform: process.platform, architecture: process.arch, electronVersion: process.versions.electron, engine: engineStatus(), snapshot: service.snapshot(), detail });
    const approvedOverwrite = rendererRecoveryE2e ? new Set<string>() : new Set([normalizedAuthorityPath(result.filePath)]);
    await writeApprovedTarget(result.filePath, Buffer.from(`${JSON.stringify(diagnostic, null, 2)}\n`), approvedOverwrite);
    return { saved: true, filePath: result.filePath };
  });
  handle(IPC.importFiles, async (_event, pixelMode = false) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import into AIDraw', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported artwork', extensions: ['png', 'apng', 'gif', 'jpg', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'tmj', 'tmx', 'tsj', 'tsx', 'json'] },
        { name: 'Images', extensions: ['png', 'apng', 'gif', 'jpg', 'jpeg', 'webp', 'svg'] },
        { name: 'Photoshop', extensions: ['psd'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Tiled maps and tilesets', extensions: ['tmj', 'tmx', 'tsj', 'tsx', 'json'] },
      ],
    });
    if (result.canceled) return { imported: 0, warnings: [], reportIds: [] };
    let imported = 0; const warnings: string[] = []; const reportIds: string[] = [];
    for (const filePath of result.filePaths) {
      try {
        const value = await engineRuntime.rasterUtilities.importDocument(filePath, pixelMode === true);
        for (const document of value.documents) { service.addDocument(document); imported += 1; }
        warnings.push(...value.warnings);
        const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: HUMAN_ACTOR, documentIds: value.documents.map((document) => document.id), documentNames: value.documents.map((document) => document.name), format: extname(filePath).slice(1).toLowerCase() || 'unknown', sourcePaths: [filePath], destinationPaths: [], warnings: value.warnings, rasterized: value.warnings.filter((warning) => /raster|flatten|fallback/i.test(warning)), ...(value.fidelity?.length ? { fidelity: value.fidelity } : {}) });
        reportIds.push(report.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error); warnings.push(`${basename(filePath)}: ${message}`);
        const report = await recordInterchangeReport({ kind: 'import', status: 'failed', actor: HUMAN_ACTOR, documentIds: [], documentNames: [], format: extname(filePath).slice(1).toLowerCase() || 'unknown', sourcePaths: [filePath], destinationPaths: [], warnings: [], rasterized: [], error: message });
        reportIds.push(report.id);
      }
    }
    return { imported, warnings, reportIds };
  });
  handle(IPC.importPalette, async (_event, documentId: string, mode: PaletteImportMode) => {
    if (mode !== 'replace-slots' && mode !== 'append-unique') throw new Error('Unknown palette import mode.');
    const document = service.getDocument(documentId); if (!document || document.kind !== 'pixel') throw new Error('Palette import requires an open pixel document.');
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Import indexed palette', properties: ['openFile'], filters: [{ name: 'Palette files', extensions: ['json', 'gpl'] }, { name: 'AIDraw palette JSON', extensions: ['json'] }, { name: 'GIMP palette', extensions: ['gpl'] }] });
    if (result.canceled || !result.filePaths[0]) return { imported: false, cancelled: true, added: 0, updated: 0, skipped: 0, warnings: [] };
    const filePath = result.filePaths[0]; const parsed = parsePaletteFile(await readFile(filePath), extname(filePath));
    const applied = applyPortablePalette(document.palette, parsed.entries, mode, () => createId('palette'));
    const response = await service.apply({ id: createId('tx'), clientOperationId: createId('palette-import'), documentId, actor: HUMAN_ACTOR, label: mode === 'append-unique' ? `Append palette · ${parsed.name}` : `Import palette slots · ${parsed.name}`, createdAt: nowIso(), operations: [{ kind: 'pixel.palette.replace', palette: applied.palette }], playback: { mode: 'instant', speed: 1 } });
    if (response.status !== 'committed' && response.status !== 'duplicate') throw new Error(response.message ?? 'Palette import could not be committed.');
    const warnings = [...parsed.warnings, ...applied.warnings];
    const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: HUMAN_ACTOR, documentIds: [documentId], documentNames: [document.name], format: `palette-${parsed.format}`, sourcePaths: [filePath], destinationPaths: [], warnings, rasterized: [] });
    return { imported: true, filePath, format: parsed.format, paletteName: parsed.name, added: applied.added, updated: applied.updated, skipped: applied.skipped, warnings, reportId: report.id };
  });
  handle(IPC.exportPalette, async (_event, documentId: string, format: PaletteFileFormat) => {
    if (format !== 'json' && format !== 'gpl') throw new Error('Unknown palette export format.');
    const document = service.getDocument(documentId); if (!document || document.kind !== 'pixel') throw new Error('Palette export requires an open pixel document.');
    const result = await dialog.showSaveDialog(mainWindow!, { title: `Export ${format.toUpperCase()} palette`, defaultPath: `${safeFileStem(document.name)} palette.${format}`, filters: [{ name: format === 'json' ? 'AIDraw palette JSON' : 'GIMP palette', extensions: [format] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return { exported: false, cancelled: true, warnings: [] };
    const target = extname(result.filePath) ? result.filePath : `${result.filePath}.${format}`; const existed = await stat(target).then(() => true, () => false);
    await writeApprovedTarget(target, Buffer.from(serializePaletteFile(document.name, document.palette, format), 'utf8'), new Set(existed ? [normalizedAuthorityPath(target)] : []));
    const warnings = format === 'gpl' ? ['GPL stores RGB only; transparent index 0 is documented and omitted.'] : [];
    const report = await recordInterchangeReport({ kind: 'export', status: 'completed', actor: HUMAN_ACTOR, documentIds: [documentId], documentNames: [document.name], format: `palette-${format}`, sourcePaths: [], destinationPaths: [target], warnings, rasterized: [] });
    return { exported: true, filePath: target, warnings, reportId: report.id };
  });
  handle<[string, string, PixelLinkAction], PixelLinkActionResult>(IPC.managePixelLink, async (_event, documentId, linkId, action) => {
    if (action !== 'embed' && action !== 'extract' && action !== 'relink') throw new Error('Unknown pixel-project link action.');
    const document = service.getDocument(documentId);
    if (!document || document.kind !== 'pixel') throw new Error('Pixel-project link management requires an open pixel document.');
    const linkedAsset = document.linkedAssets.find((entry) => entry.id === linkId);
    if (!linkedAsset) throw new Error('Linked project asset not found.');

    const commit = async (label: string, operations: CanvasOperation[]): Promise<void> => {
      const response = await service.apply({
        id: createId('tx'), clientOperationId: createId('pixel-link'), documentId, actor: HUMAN_ACTOR,
        label, createdAt: nowIso(), operations, playback: { mode: 'instant', speed: 1 },
      });
      if (response.status !== 'committed' && response.status !== 'duplicate') throw new Error(response.message ?? 'The project-link update could not be committed.');
    };
    if (action === 'embed') {
      verifiedPixelLinkCache(document, linkId);
      await commit(`Embed project link · ${linkedAsset.name}`, [{ kind: 'pixel.links.replace', linkedAssets: embedPixelLink(document, linkId), expectedRevision: document.revision }]);
      return { updated: true, message: `Embedded ${linkedAsset.name}.` };
    }

    if (action === 'extract') {
      const { asset, bytes } = verifiedPixelLinkCache(document, linkId);
      if (!document.filePath) throw new Error('Save the AIDraw project before extracting an external link.');
      const extension = projectLinkFileExtension(asset);
      const defaultName = extname(asset.name) ? asset.name : `${safeFileStem(linkedAsset.name)}.${extension}`;
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Extract linked project asset', defaultPath: join(dirname(document.filePath), defaultName),
        filters: [{ name: 'Cached source image', extensions: [extension] }], properties: ['showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return { updated: false, cancelled: true };
      const target = extname(result.filePath) ? result.filePath : `${result.filePath}.${extension}`;
      const relativePath = portableProjectAssetPath(document, target);
      const existed = await stat(target).then(() => true, () => false);
      await writeApprovedTarget(target, bytes, new Set(existed ? [normalizedAuthorityPath(target)] : []));
      await commit(`Extract project link · ${linkedAsset.name}`, [{ kind: 'pixel.links.replace', linkedAssets: externalizePixelLink(document, linkId, relativePath), expectedRevision: document.revision }]);
      return { updated: true, filePath: target, message: `Extracted ${linkedAsset.name}.` };
    }

    if (!document.filePath) throw new Error('Save the AIDraw project before relinking an external source.');
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Relink project asset', properties: ['openFile'],
      filters: [{ name: 'Source images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { updated: false, cancelled: true };
    const filePath = resolve(result.filePaths[0]); const file = await stat(filePath);
    if (!file.isFile() || file.size < 1 || file.size > MAX_PROJECT_LINK_BYTES) throw new Error('Relinked source images must be non-empty files no larger than 1.5 MB.');
    const bytes = await readFile(filePath);
    if (bytes.byteLength !== file.size) throw new Error('The selected source changed while it was being read; choose it again.');
    const prepared = preparePixelLinkRelink(document, linkId, filePath, bytes);
    await commit(`Relink project asset · ${linkedAsset.name}`, prepared.operations);
    return { updated: true, filePath, message: `Relinked ${linkedAsset.name}.` };
  });
  handle(IPC.selectSpriteSheet, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a sprite-sheet image', properties: ['openFile'], filters: [{ name: 'Sprite-sheet images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const filePath = result.filePaths[0]; const inspected = await engineRuntime.rasterUtilities.inspectSpriteSheet(filePath); const { width, height } = inspected;
    const now = Date.now(); for (const [id, selection] of pendingSpriteSheets) if (selection.expiresAt <= now) pendingSpriteSheets.delete(id); while (pendingSpriteSheets.size >= 8) pendingSpriteSheets.delete(pendingSpriteSheets.keys().next().value!);
    const id = createId('sprite-sheet'); const expiresAt = now + 120_000; const extension = extname(filePath).toLowerCase(); const name = basename(filePath, extension);
    pendingSpriteSheets.set(id, { filePath, sha256: inspected.sha256, name, mimeType: inspected.mimeType, expiresAt });
    const divisors = [64, 48, 32, 24, 16, 8].filter((size) => width % size === 0 && height % size === 0 && width * height / (size * size) >= 2); const suggested = divisors[0] ?? Math.min(32, width, height);
    return { selection: { id, name, width, height, previewDataUrl: `data:image/png;base64,${inspected.previewPng.toString('base64')}`, suggestedFrameWidth: suggested, suggestedFrameHeight: suggested, expiresAt: new Date(expiresAt).toISOString() } };
  });
  handle(IPC.importSpriteSheet, async (_event, selectionId: string, input: SpriteSheetSliceOptions) => {
    const selection = pendingSpriteSheets.get(selectionId); if (!selection || selection.expiresAt <= Date.now()) { pendingSpriteSheets.delete(selectionId); throw new Error('The sprite-sheet selection expired; choose the image again.'); }
    const options = validateSpriteSheetSliceOptions(input);
    const imported = await engineRuntime.rasterUtilities.importSpriteSheet(selection.filePath, { options, name: selection.name, mimeType: selection.mimeType, expectedSha256: selection.sha256 }); const document = imported.documents[0]; service.addDocument(document); pendingSpriteSheets.delete(selectionId);
    const report = await recordInterchangeReport({ kind: 'import', status: 'completed', actor: HUMAN_ACTOR, documentIds: [document.id], documentNames: [document.name], format: 'sprite-sheet-image', sourcePaths: [selection.filePath], destinationPaths: [], warnings: imported.warnings, rasterized: [] });
    return { imported: true, documentId: document.id, warnings: imported.warnings, reportId: report.id };
  });
  handle(IPC.exportActiveDocument, async (_event, format: ExportFormat, options: ExportOptions = {}) => {
    const id = service.getActiveDocumentId(); const document = id ? service.getDocument(id) : undefined;
    if (!document) return { exported: false, warnings: ['No active document.'] };
    const artifact = await engineRuntime.rasterUtilities.exportDocument(document, format, options);
    const scale = options.scale ?? 1;
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: `Export ${format.toUpperCase()}`,
      defaultPath: `${document.name.replace(/[<>:"/\\|?*]/g, '-')}${scale > 1 ? ` @${scale}x` : ''}.${artifact.extension}`,
      filters: [{ name: format.toUpperCase(), extensions: [artifact.extension] }], properties: ['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { exported: false, warnings: artifact.report.warnings, cancelled: true };
    const target = extname(result.filePath) ? result.filePath : `${result.filePath}.${artifact.extension}`;
    const companions = [...(artifact.companions ?? []), ...(artifact.companion ? [{ ...artifact.companion, name: artifact.companion.name }] : [])];
    const plannedCompanions = companions.map((companion) => ({ companion, path: companion.name ? join(dirname(target), companion.name) : `${target.slice(0, -extname(target).length)}.${companion.extension}` }));
    const targetExisted = await stat(target).then(() => true, () => false);
    const existingCompanions = (await Promise.all(plannedCompanions.map(async (entry) => await stat(entry.path).then(() => entry.path, () => undefined)))).filter((path): path is string => Boolean(path));
    if (existingCompanions.length > 0) {
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Overwrite export companion files?',
        message: `This export also replaces ${existingCompanions.length} companion file${existingCompanions.length === 1 ? '' : 's'}.`,
        detail: existingCompanions.join('\n'),
        buttons: ['Cancel export', 'Overwrite companion files'],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmation.response !== 1) return { exported: false, warnings: artifact.report.warnings, cancelled: true };
    }
    const approved = new Set([...(targetExisted ? [target] : []), ...existingCompanions].map(normalizedAuthorityPath));
    await writeApprovedTarget(target, artifact.data, approved);
    for (const entry of plannedCompanions) await writeApprovedTarget(entry.path, companionBytes(entry.companion.data, format, target), approved);
    const report = await recordInterchangeReport({ kind: 'export', status: 'completed', actor: HUMAN_ACTOR, documentIds: [document.id], documentNames: [document.name], format, sourcePaths: [], destinationPaths: [target, ...plannedCompanions.map((entry) => entry.path)], warnings: artifact.report.warnings, rasterized: artifact.report.rasterized, ...(artifact.report.fidelity ? { fidelity: artifact.report.fidelity } : {}) });
    return { exported: true, filePath: target, warnings: artifact.report.warnings, reportId: report.id };
  });
  handle(IPC.copySelection, (_event, objectIds: string[]) => copySelection(Array.isArray(objectIds) ? objectIds : []));
  handle(IPC.pasteClipboard, () => pasteClipboard());
  handle(IPC.replayTrace, async (_event, documentId: string, transactionId: string) => {
    const trace = await service.findTrace(documentId, transactionId);
    if (!trace) return { replaying: false, reason: 'The durable transaction trace is unavailable.' };
    const replay = mcpHost.scheduler.replay(trace.transaction);
    const reason = replay.reason === 'already-replaying' ? 'This trace is already replaying.' : replay.reason === 'replay-busy' ? 'Another trace is already replaying.' : replay.reason === 'replay-too-large' ? 'The trace exceeds the replay sample limit.' : undefined;
    return { replaying: replay.replaying, reason };
  });
  handle(IPC.editorAdvisory, (_event, state) => { service.updateEditorAdvisory(state && typeof state === 'object' ? state : {}); });
  handle(IPC.configureAgentClient, (_event, clientId: unknown) => configureAgentClient(clientId));
  handle(IPC.configureCodex, () => configureAgentClient('codex'));
}

async function configureAgentClient(value: unknown): Promise<AgentClientSetupResult> {
  if (!isAgentClientId(value)) throw new Error('Unknown agent client.');
  const clientId: AgentClientId = value;
  const descriptor = agentClientDescriptor(clientId);
  const credentials = mcpHost.credentials();
  const base = {
    clientId,
    clientName: descriptor.name,
    restartInstruction: descriptor.restartInstruction,
    documentationUrl: descriptor.documentationUrl,
  };
  if (!credentials.url || !credentials.token) {
    return { ...base, status: 'manual', message: 'The AIDraw MCP server is not running.', restartRequired: false };
  }
  if (clientId === 'generic') return configureAgentClientFile(clientId, { url: credentials.url, token: credentials.token });
  const platform = secureStorageStatus(safeStorage).platform;
  const isolatedE2eApproval = isIsolatedOpenCodeE2eApproval(clientId);
  if (!isolatedE2eApproval) {
    const decision = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: `Connect ${descriptor.name} to AIDraw`,
      message: `Connect ${descriptor.name} and keep the AIDraw Engine available headlessly?`,
      detail: `AIDraw will back up ${descriptor.configurationDescription}, replace only its aidraw MCP entry, and start the engine at ${platform.label} sign-in. The authenticated engine keeps working when the editor window is closed.`,
      buttons: ['Connect and Enable Headless Engine', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (decision.response !== 0) return { ...base, status: 'cancelled', message: `${descriptor.name} configuration was not changed.`, restartRequired: false };
  }
  try {
    const result = await configureAgentClientFile(clientId, { url: credentials.url, token: credentials.token });
    const status = isolatedE2eApproval ? engineStatus() : await setEngineStartAtLogin(true);
    const startup = isolatedE2eApproval
      ? ' Start-at-login was intentionally unchanged by this isolated packaged validation.'
      : status.startsAtLogin
        ? ` The headless engine will start at ${platform.label} sign-in.`
        : ' Start-at-login becomes available in a packaged desktop build.';
    return { ...result, message: `${result.message}${startup}` };
  } catch (error) {
    return { ...base, status: 'manual', message: `Could not configure ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`, restartRequired: false };
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: () => void requestNewDocument('illustration') },
        { label: 'New Pixel Sprite…', accelerator: 'CmdOrCtrl+Shift+N', click: () => void requestNewDocument('sprite') },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openDocuments() },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => void saveDocument() },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => void saveDocument(undefined, true) },
        { label: 'Save All…', accelerator: 'CmdOrCtrl+Alt+S', click: () => void saveAllDocuments() },
        { label: 'Batch Export PNG…', click: () => void batchExportDocuments('png') },
        { label: 'Close All…', click: () => void closeAllDocuments() },
        { type: 'separator' },
        { label: 'Close Editor Window', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
        { label: 'Quit AIDraw Engine…', click: () => void requestEngineQuit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo My Last Action', accelerator: 'CmdOrCtrl+Z', click: () => void service.undo() },
        { label: 'Redo My Last Action', accelerator: 'CmdOrCtrl+Y', click: () => void service.redo() },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'AIDraw on GitHub',
          click: () => void shell.openExternal('https://github.com/hokomili/AIDraw'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function requestNewDocument(kind: 'illustration' | 'sprite' = 'illustration'): Promise<void> {
  await createWindow();
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.newDocumentRequested, kind);
}

function engineStatus(): EngineStatus {
  const login = getStartAtLoginStatus({ app });
  const storage = secureStorageStatus(safeStorage);
  return {
    running: true,
    uiAttached: Boolean(mainWindow && !mainWindow.isDestroyed()),
    startsAtLogin: login.enabled,
    startAtLoginSupported: login.supported,
    mode: mainWindow && !mainWindow.isDestroyed() ? 'interactive' : 'headless',
    platform: storage.platform,
    secureStorageAvailable: storage.available,
  };
}

async function setEngineStartAtLogin(enabled: boolean): Promise<EngineStatus> {
  await setStartAtLogin({ app }, enabled);
  return engineStatus();
}

async function requestEngineQuit(confirmInEditor = true): Promise<void> {
  if (engineQuitPending || engineShutdownComplete) return;
  engineQuitPending = true;
  try {
    const dirty = service.getDocuments().filter((document) => document.dirty);
    if (confirmInEditor && mainWindow && !mainWindow.isDestroyed()) {
      const decision = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Quit AIDraw Engine',
        message: 'Quit the background engine and disconnect every agent?',
        detail: dirty.length
          ? `${dirty.length} unsaved document${dirty.length === 1 ? ' is' : 's are'} protected by crash recovery and will reopen next time.`
          : 'Closing the editor window alone keeps the headless engine available.',
        buttons: ['Quit Engine', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (decision.response !== 0) return;
    }
    await engineRuntime.stop();
    engineShutdownComplete = true;
    app.quit();
  } finally {
    engineQuitPending = false;
  }
}

async function registerRendererProtocol(): Promise<void> {
  const rendererRoot = resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
  await protocol.handle('aidraw', (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const filePath = resolve(rendererRoot, `.${pathname}`);
      const relativePath = relative(rendererRoot, filePath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#eeeae4',
    title: 'AIDraw',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = window;
  service.setEditorAttached(true);
  mcpHost.scheduler.setVisualPlaybackEnabled(true);
  if (startupCommand === 'headless') window.show();

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL)) event.preventDefault();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
    service.setEditorAttached(false);
    mcpHost.scheduler.setVisualPlaybackEnabled(false);
  });
  window.once('ready-to-show', () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadURL('aidraw://app/index.html');
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

async function initializeApplication(): Promise<void> {
  if (cliInvocation) {
    let exitCode = 0;
    try {
      if (cliParseError) throw cliParseError;
      if (cliCommand?.kind === 'help') process.stdout.write(`${cliHelp(basename(process.execPath))}\n`);
      else if (cliCommand?.kind === 'version') process.stdout.write(`${app.getVersion()}\n`);
      else if (cliCommand?.kind === 'batch-export') process.stdout.write(`${JSON.stringify(await executeBatchExport(cliCommand), null, 2)}\n`);
      else throw new Error('No AIDraw CLI command was provided.');
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`AIDraw CLI: ${error instanceof Error ? error.message : String(error)}\n\n${cliHelp(basename(process.execPath))}\n`);
    }
    engineShutdownComplete = true;
    app.exit(exitCode);
    return;
  }
  if (startupCommand === 'quit-engine') {
    engineShutdownComplete = true;
    app.quit();
    return;
  }
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) await registerRendererProtocol();
  engineRuntime = new EngineRuntime({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
    runApprovedFileJob: (job) => { if (['import', 'export', 'save'].includes(job.kind)) void runApprovedFileJob(job); },
    generationProviderRunner: qa06GenerationE2e
      ? createQa06GenerationE2eRunner(qa06GenerationE2e)
      : qa06PixelPaletteE2e
        ? createQa06PixelPaletteE2eRunner(qa06PixelPaletteE2e)
        : fnd09GenerationNormalizationE2e
          ? createFnd09GenerationNormalizationE2eRunner(fnd09GenerationNormalizationE2e)
          : undefined,
    approvalTimeoutMs: qa06GenerationE2e?.approvalTimeoutMs ?? qa06PixelPaletteE2e?.approvalTimeoutMs ?? (fnd09GenerationNormalizationE2e ? 60_000 : undefined),
  });
  service = engineRuntime.service;
  mcpHost = engineRuntime.mcpHost;
  providerCredentials = engineRuntime.providerCredentials;
  generationManager = engineRuntime.generationManager;
  batchDocumentWorkflows = new BatchDocumentWorkflows({
    documents: {
      listTabs: () => service.snapshot().documents,
      getDocument: (documentId) => service.getDocument(documentId),
      save: (documentId, filePath) => service.save(documentId, filePath),
      close: (documentId, force) => service.close(documentId, force),
    },
    selectDirectory: async (request) => {
      if (ux11BatchE2eController) return ux11BatchE2eController.selectDirectory(request);
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: request.title,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    confirmCloseAll: async (request) => {
      if (ux11BatchE2eController) return ux11BatchE2eController.confirmCloseAll(request);
      const decision = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        ...request,
        buttons: [...request.buttons],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return decision.response === 0 ? 'save-all' : decision.response === 2 ? 'discard-all' : 'cancel';
    },
    pathExists: (filePath) => stat(filePath).then(() => true, () => false),
    exportDocument: (document, format, options) => {
      if (ux11BatchE2eController?.shouldFailExport(document, format)) throw new Error('Isolated UX-11 per-document export failure.');
      return engineRuntime.rasterUtilities.exportDocument(document, format, options);
    },
    writeTarget: (filePath, data) => writeApprovedTarget(filePath, data, new Set()),
    companionBytes,
    recordInterchangeReport,
  });
  mcpHost.scheduler.setVisualPlaybackEnabled(false);
  await engineRuntime.start();
  let launchTrustedFolders: string[] = [];
  if (explicitTrustedFolders.length > 0) {
    if (startupCommand !== 'headless' || !explicitMcpConnectionFile) throw new Error('--trust-folder requires --headless and --write-mcp-connection.');
    if (explicitTrustedFolders.some((folder) => !folder || !isAbsolute(folder))) throw new Error('--trust-folder values must be non-empty absolute paths.');
    launchTrustedFolders = await mcpHost.grantLaunchFolderTrust(explicitTrustedFolders.map((folder) => resolve(folder)));
  }
  if (explicitMcpConnectionFile) {
    const connectionPath = resolve(explicitMcpConnectionFile);
    const credentials = mcpHost.credentials();
    if (!credentials.url) throw new Error('Cannot write an MCP connection file because the local server did not start.');
    await mkdir(dirname(connectionPath), { recursive: true });
    await writeFile(connectionPath, `${JSON.stringify({ version: 1, url: credentials.url, token: credentials.token, activeDocumentId: service.getActiveDocumentId(), pid: process.pid, trustedFolders: launchTrustedFolders }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (fnd09UtilityContainmentE2e) {
    void runFnd09UtilityContainmentScenario(engineRuntime, fnd09UtilityContainmentE2e)
      .catch((error) => process.stderr.write(`FND-09 utility containment probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09UtilityPressureE2e) {
    void runFnd09UtilityPressureScenario(engineRuntime, fnd09UtilityPressureE2e)
      .catch((error) => process.stderr.write(`FND-09 utility pressure probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09ObservationCodecE2e) {
    void runFnd09ObservationCodecScenario(engineRuntime, fnd09ObservationCodecE2e)
      .catch((error) => process.stderr.write(`FND-09 observation codec probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09QuantizationResultE2e) {
    void runFnd09QuantizationResultScenario(engineRuntime, fnd09QuantizationResultE2e)
      .catch((error) => process.stderr.write(`FND-09 quantization-result probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09ExportResultE2e) {
    void runFnd09ExportResultScenario(engineRuntime, fnd09ExportResultE2e)
      .catch((error) => process.stderr.write(`FND-09 export-result probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09ImportResultE2e) {
    void runFnd09ImportResultScenario(engineRuntime, fnd09ImportResultE2e)
      .catch((error) => process.stderr.write(`FND-09 import-result probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (fnd09GenerationResultE2e) {
    void runFnd09GenerationResultScenario(engineRuntime, fnd09GenerationResultE2e)
      .catch((error) => process.stderr.write(`FND-09 generation-result probe failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  registerIpc();
  createMenu();
  service.on('event', (event) => mainWindow?.webContents.send(IPC.event, event));
  const macLoginLaunch = wasOpenedAtLogin({ app });
  if (macLoginLaunch) suppressMacLoginActivationUntil = Date.now() + 3_000;
  if (startupCommand !== 'headless' && !macLoginLaunch) await createWindow();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else if (cliInvocation) {
  engineReadyPromise = app.whenReady().then(initializeApplication);
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData) => {
    const requested = typeof additionalData === 'object' && additionalData && 'command' in additionalData
      ? String((additionalData as { command?: unknown }).command)
      : commandLine.includes('--quit-engine')
        ? 'quit-engine'
        : commandLine.includes('--headless')
          ? 'headless'
          : 'show';
    void (async () => {
      await engineReadyPromise;
      if (requested === 'quit-engine') await requestEngineQuit(false);
      else if (requested !== 'headless') await createWindow();
    })();
  });
  engineReadyPromise = app.whenReady().then(initializeApplication);
  app.on('activate', () => {
    if (Date.now() < suppressMacLoginActivationUntil) return;
    void engineReadyPromise?.then(() => createWindow());
  });
  app.on('window-all-closed', () => {
    // The window is only a client. The canonical engine intentionally remains
    // alive for authenticated agents and crash-safe autonomous work.
  });
  app.on('before-quit', () => {
    if (!engineShutdownComplete) void engineRuntime?.stop();
  });
}

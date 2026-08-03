import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { copyFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CanvasTransactionSchema, HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, nowIso, type AIDrawDocument, type AsyncJob, type CanvasOperation, type CanvasTransaction, type DocumentAsset, type IllustrationObject, type ImageObject, type PaletteEntry, type PixelAsset } from '@aidraw/core';
import { IPC, type EngineStatus, type ExportOptions, type HumanLockRequest, type NewDocumentOptions } from '../common/contracts';
import type { DocumentService } from './document-service';
import type { McpHost } from './mcp-host';
import type { ProviderCredentialStore } from './provider-credentials';
import type { GenerationManager } from './generation-manager';
import { EngineRuntime } from './engine-runtime';
import type { GenerationRequest } from '../common/generation';
import { exportDocument, illustrationToSvg, type ExportFormat } from './export-document';
import { importDocument } from './import-document';
import { renderDocument } from './render-document';
import { quantizeToPalette } from './quantize';
import { cliHelp, executeBatchExport, parseCliArguments, type CliCommand } from './cli';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let engineRuntime: EngineRuntime;
let service: DocumentService;
let mcpHost: McpHost;
let providerCredentials: ProviderCredentialStore;
let generationManager: GenerationManager;
let engineShutdownComplete = false;
let engineQuitPending = false;
let engineReadyPromise: Promise<void> | undefined;

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

protocol.registerSchemesAsPrivileged([{
  scheme: 'aidraw',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Rejected IPC from an untrusted renderer.');
  }
  const url = event.senderFrame.url;
  if (!url.startsWith('aidraw://app/') && !url.startsWith('http://localhost:') && !url.startsWith('http://127.0.0.1:')) {
    throw new Error('Rejected IPC from an unexpected origin.');
  }
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
    else if (job.kind === 'import' && action === 'import' && requestedPath) {
      const imported = await importDocument(requestedPath, request.pixelMode === true); for (const document of imported.documents) service.addDocument(document);
      output = { imported: imported.documents.map((document) => document.id), warnings: imported.warnings };
    } else if (job.kind === 'save' && (action === 'save-as' || action === 'save') && requestedPath && result?.documentId) {
      await assertOverwriteAuthority(requestedPath, approvedOverwrites);
      output = { path: await service.save(result.documentId, requestedPath) };
    }
    else if (job.kind === 'export' && action === 'export' && requestedPath && result?.documentId) {
      const document = service.getDocument(result.documentId); if (!document) throw new Error('Target document is no longer open.');
      const artifact = await exportDocument(document, String(request.format) as ExportFormat, { scale: request.scale === undefined ? undefined : Number(request.scale) }); const target = extname(requestedPath) ? requestedPath : `${requestedPath}.${artifact.extension}`;
      const companionPaths: string[] = []; const companions = [...(artifact.companions ?? []), ...(artifact.companion ? [{ ...artifact.companion, name: artifact.companion.name }] : [])];
      const plannedCompanions = companions.map((companion) => ({ companion, path: companion.name ? join(dirname(target), companion.name) : `${target.slice(0, -extname(target).length)}.${companion.extension}` }));
      await Promise.all([target, ...plannedCompanions.map((entry) => entry.path)].map((path) => assertOverwriteAuthority(path, approvedOverwrites)));
      await writeApprovedTarget(target, artifact.data, approvedOverwrites);
      for (const entry of plannedCompanions) { await writeApprovedTarget(entry.path, companionBytes(entry.companion.data, String(request.format), target), approvedOverwrites); companionPaths.push(entry.path); }
      output = { path: target, companionPaths, warnings: artifact.report.warnings };
    } else throw new Error('The approved file job has invalid or incomplete arguments.');
    service.upsertJob({ ...job, status: 'completed', progress: 1, updatedAt: nowIso(), message: `Approved ${job.kind} completed.`, result: { ...result, output } });
  } catch (error) {
    service.upsertJob({ ...job, status: 'failed', progress: 0, updatedAt: nowIso(), message: `Approved ${job.kind} failed.`, error: { code: 'file_job_failed', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
}

interface ClipboardFragment { version: 1; kind: 'illustration-objects' | 'pixel-asset'; objects?: IllustrationObject[]; assets?: DocumentAsset[]; pixelAsset?: PixelAsset; palette?: PaletteEntry[] }

function companionBytes(data: Buffer, format: string, target: string): Buffer {
  if (format !== 'sprite-sheet') return data;
  try { const metadata = JSON.parse(data.toString('utf8')) as { meta?: Record<string, unknown> }; metadata.meta = { ...(metadata.meta ?? {}), image: basename(target) }; return Buffer.from(JSON.stringify(metadata, null, 2)); } catch { return data; }
}

async function copySelection(objectIds: string[]): Promise<{ copied: boolean; kind?: string }> {
  const id = service.getActiveDocumentId(); const document = id ? service.getDocument(id) : undefined; if (!document) return { copied: false };
  let fragment: ClipboardFragment; let standardDocument: AIDrawDocument; let svg = '';
  if (document.kind === 'illustration') {
    standardDocument = structuredClone(document);
    const ids = objectIds.length ? new Set(objectIds) : new Set(Object.keys(document.objects)); const objects = Object.values(document.objects).filter((object) => ids.has(object.id)); if (!objects.length) return { copied: false };
    const assetIds = new Set(objects.flatMap((object) => object.type === 'image' ? [object.assetId] : [])); fragment = { version: 1, kind: 'illustration-objects', objects, assets: [...assetIds].map((assetId) => document.assets[assetId]).filter(Boolean) };
    standardDocument.objects = Object.fromEntries(objects.map((object) => [object.id, object])); for (const layer of Object.values(standardDocument.layers)) if (layer.type === 'vector') layer.objectIds = layer.objectIds.filter((objectId) => ids.has(objectId)); svg = illustrationToSvg(standardDocument);
  } else {
    standardDocument = structuredClone(document);
    const asset = document.pixelAssets[document.activeAssetId]; if (!asset) return { copied: false }; fragment = { version: 1, kind: 'pixel-asset', pixelAsset: asset, palette: document.palette };
  }
  const png = (await renderDocument(standardDocument)).toBuffer('image/png'); const encoded = Buffer.from(JSON.stringify(fragment)).toString('base64'); const html = `<div data-aidraw="${encoded}">${svg || '<span>AIDraw pixel artwork</span>'}</div>`;
  clipboard.write({ text: svg || JSON.stringify(fragment), html, image: nativeImage.createFromBuffer(png) }); return { copied: true, kind: fragment.kind };
}

async function pasteClipboard(): Promise<ReturnType<DocumentService['apply']> extends Promise<infer R> ? R : never> {
  const id = service.getActiveDocumentId(); const document = id ? service.getDocument(id) : undefined; if (!document) return { status: 'conflict', message: 'No active document.' };
  let fragment: ClipboardFragment | undefined; const match = clipboard.readHTML().match(/data-aidraw="([A-Za-z0-9+/=]+)"/); if (match) { try { fragment = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as ClipboardFragment; } catch { fragment = undefined; } }
  const operations: CanvasOperation[] = [];
  if (fragment?.kind === 'illustration-objects' && document.kind === 'illustration') {
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked); if (!layer || layer.type !== 'vector') return { status: 'conflict', message: 'Add an editable vector layer before pasting.' };
    for (const asset of fragment.assets ?? []) if (!document.assets[asset.id]) operations.push({ kind: 'asset.add', asset });
    const sourceObjects = fragment.objects ?? []; const ids = new Map(sourceObjects.map((object) => [object.id, createId('object')])); const timestamp = nowIso(); for (const source of sourceObjects) { const object = structuredClone(source); object.id = ids.get(source.id)!; object.layerId = layer.id; object.revision = 0; object.createdAt = timestamp; object.updatedAt = timestamp; object.createdBy = HUMAN_ACTOR.id; object.transform = { ...object.transform, x: object.transform.x + 16, y: object.transform.y + 16 }; if (object.maskObjectId) object.maskObjectId = ids.get(object.maskObjectId); operations.push({ kind: 'illustration.object.add', object }); }
  } else if (fragment?.kind === 'pixel-asset' && document.kind === 'pixel' && fragment.pixelAsset) {
    const asset = structuredClone(fragment.pixelAsset); asset.id = createId(asset.type); asset.name = `${asset.name} copy`; asset.revision = 0; operations.push({ kind: 'pixel.asset.add', asset }, { kind: 'pixel.active-asset.set', assetId: asset.id });
  } else {
    const image = clipboard.readImage(); if (image.isEmpty()) return { status: 'conflict', message: 'Clipboard has no AIDraw objects or image.' }; const bytes = image.toPNG(); const sha256 = createHash('sha256').update(bytes).digest('hex'); const asset: DocumentAsset = { id: createId('asset'), name: 'Clipboard image', mimeType: 'image/png', byteLength: bytes.byteLength, sha256, source: 'imported', data: bytes.toString('base64') }; operations.push({ kind: 'asset.add', asset });
    if (document.kind === 'illustration') { const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked); if (!layer || layer.type !== 'vector') return { status: 'conflict', message: 'Add a vector layer before pasting.' }; const size = image.getSize(); const timestamp = nowIso(); const object: ImageObject = { id: createId('object'), revision: 0, name: 'Clipboard image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 16, y: 16 }, type: 'image', assetId: asset.id, width: size.width, height: size.height, filters: [] }; operations.push({ kind: 'illustration.object.add', object }); }
    else { const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') return { status: 'conflict', message: 'Choose a sprite before pasting pixels.' }; const frameId = sprite.frameIds[0]; const layerId = [...sprite.layerIds].reverse().find((entry) => sprite.layers[entry]?.type === 'pixel'); const cel = Object.values(sprite.cels).find((entry) => entry.frameId === frameId && entry.layerId === layerId); if (!cel) return { status: 'conflict', message: 'The sprite has no editable cel.' }; operations.push({ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: quantizeToPalette(bytes, sprite.width, sprite.height, document.palette, document.conversionDefaults.alphaThreshold, document.conversionDefaults.dithering), expectedRevision: cel.revision }); }
  }
  const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('clipboard'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Paste', createdAt: nowIso(), operations, playback: { mode: 'instant', speed: 1 } }; return service.apply(transaction);
}

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
  handle(IPC.openDocuments, () => openDocuments());
  handle(IPC.saveDocument, (_event, id?: string) => saveDocument(id));
  handle(IPC.saveDocumentAs, (_event, id?: string) => saveDocument(id, true));
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
  handle(IPC.jobCancel, (_event, jobId: string) => generationManager.cancel(jobId));
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
    if (result.canceled) return { imported: 0, warnings: [] };
    let imported = 0; const warnings: string[] = [];
    for (const filePath of result.filePaths) {
      try {
        const value = await importDocument(filePath, pixelMode === true);
        for (const document of value.documents) { service.addDocument(document); imported += 1; }
        warnings.push(...value.warnings);
      } catch (error) { warnings.push(`${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { imported, warnings };
  });
  handle(IPC.exportActiveDocument, async (_event, format: ExportFormat, options: ExportOptions = {}) => {
    const id = service.getActiveDocumentId(); const document = id ? service.getDocument(id) : undefined;
    if (!document) return { exported: false, warnings: ['No active document.'] };
    const artifact = await exportDocument(document, format, options);
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
    return { exported: true, filePath: target, warnings: artifact.report.warnings };
  });
  handle(IPC.copySelection, (_event, objectIds: string[]) => copySelection(Array.isArray(objectIds) ? objectIds : []));
  handle(IPC.pasteClipboard, () => pasteClipboard());
  handle(IPC.replayTrace, async (_event, documentId: string, transactionId: string) => {
    const trace = await service.findTrace(documentId, transactionId);
    if (!trace) return { replaying: false, reason: 'The durable transaction trace is unavailable.' };
    const replaying = await mcpHost.scheduler.replay(trace.transaction);
    return { replaying, reason: replaying ? undefined : 'This trace is already replaying.' };
  });
  handle(IPC.configureCodex, () => configureCodex());
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
}

async function configureCodex(): Promise<{ status: 'configured' | 'cancelled' | 'manual'; message: string }> {
  const credentials = mcpHost.credentials();
  if (!credentials.url || !credentials.token) return { status: 'manual', message: 'The AIDraw MCP server is not running.' };
  const decision = await dialog.showMessageBox(mainWindow!, {
    type: 'question',
    title: 'Connect Codex to AIDraw',
    message: 'Connect Codex and keep the AIDraw Engine available headlessly?',
    detail: 'AIDraw will back up config.toml, replace only the [mcp_servers.aidraw] table, and start its engine at Windows sign-in. The authenticated engine keeps working when the editor window is closed. Restart Codex afterward.',
    buttons: ['Connect and Enable Headless Engine', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (decision.response !== 0) return { status: 'cancelled', message: 'Codex configuration was not changed.' };
  try {
    const codexRoot = process.env.CODEX_HOME || join(homedir(), '.codex');
    const configPath = join(codexRoot, 'config.toml');
    await mkdir(codexRoot, { recursive: true });
    let existing = '';
    try { existing = await readFile(configPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(configPath, `${configPath}.aidraw-backup-${stamp}`);
    }
    const withoutAIDraw = existing.replace(/(?:^|\r?\n)\[mcp_servers\.aidraw\][\s\S]*?(?=\r?\n\[[^\]]+\]|$)/g, '').trimEnd();
    const table = [
      '[mcp_servers.aidraw]',
      `url = "${escapeToml(credentials.url)}"`,
      `http_headers = { Authorization = "Bearer ${escapeToml(credentials.token)}" }`,
    ].join('\n');
    await writeFile(configPath, `${withoutAIDraw}${withoutAIDraw ? '\n\n' : ''}${table}\n`, 'utf8');
    const status = setEngineStartAtLogin(true);
    return { status: 'configured', message: `AIDraw was added to ${configPath}. ${status.startsAtLogin ? 'The headless engine will start with Windows.' : 'Start-at-login is available in packaged Windows builds.'} Restart Codex to connect.` };
  } catch (error) {
    return { status: 'manual', message: `Could not edit Codex configuration: ${error instanceof Error ? error.message : String(error)}` };
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
          click: () => void shell.openExternal('https://github.com/aidraw/aidraw'),
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
  const startAtLoginSupported = app.isPackaged && process.platform === 'win32';
  return {
    running: true,
    uiAttached: Boolean(mainWindow && !mainWindow.isDestroyed()),
    startsAtLogin: startAtLoginSupported ? app.getLoginItemSettings().openAtLogin : false,
    startAtLoginSupported,
    mode: mainWindow && !mainWindow.isDestroyed() ? 'interactive' : 'headless',
  };
}

function setEngineStartAtLogin(enabled: boolean): EngineStatus {
  if (app.isPackaged && process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--headless'],
    });
  }
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
  mcpHost.scheduler.setVisualPlaybackEnabled(true);
  if (startupCommand === 'headless') window.show();

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!allowed && !url.startsWith('aidraw://app/')) event.preventDefault();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
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
  });
  service = engineRuntime.service;
  mcpHost = engineRuntime.mcpHost;
  providerCredentials = engineRuntime.providerCredentials;
  generationManager = engineRuntime.generationManager;
  mcpHost.scheduler.setVisualPlaybackEnabled(false);
  await engineRuntime.start();
  let launchTrustedFolders: string[] = [];
  if (explicitTrustedFolders.length > 0) {
    if (startupCommand !== 'headless' || !explicitMcpConnectionFile) throw new Error('--trust-folder requires --headless and --write-mcp-connection.');
    if (explicitTrustedFolders.some((folder) => !folder || !isAbsolute(folder))) throw new Error('--trust-folder values must be non-empty absolute paths.');
    launchTrustedFolders = mcpHost.grantLaunchFolderTrust(explicitTrustedFolders.map((folder) => resolve(folder)));
  }
  if (explicitMcpConnectionFile) {
    const connectionPath = resolve(explicitMcpConnectionFile);
    const credentials = mcpHost.credentials();
    if (!credentials.url) throw new Error('Cannot write an MCP connection file because the local server did not start.');
    await mkdir(dirname(connectionPath), { recursive: true });
    await writeFile(connectionPath, `${JSON.stringify({ version: 1, url: credentials.url, token: credentials.token, activeDocumentId: service.getActiveDocumentId(), pid: process.pid, trustedFolders: launchTrustedFolders }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  registerIpc();
  createMenu();
  service.on('event', (event) => mainWindow?.webContents.send(IPC.event, event));
  if (startupCommand !== 'headless') await createWindow();
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
  app.on('activate', () => { void engineReadyPromise?.then(() => createWindow()); });
  app.on('window-all-closed', () => {
    // The window is only a client. The canonical engine intentionally remains
    // alive for authenticated agents and crash-safe autonomous work.
  });
  app.on('before-quit', () => {
    if (!engineShutdownComplete) void engineRuntime?.stop();
  });
}

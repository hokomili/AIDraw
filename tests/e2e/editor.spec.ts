import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { HUMAN_ACTOR, readPixel, readTileAt, type Actor, type IllustrationDocument, type PixelDocument, type PixelSprite } from '@aidraw/core';
import { parse } from 'jsonc-parser';
import UPNG from 'upng-js';
import {
  QA06_GENERATION_E2E_AUDIT_FILE,
  QA06_GENERATION_E2E_CONNECTION_FILE,
  QA06_GENERATION_E2E_DOCUMENT_NAME,
  QA06_GENERATION_E2E_MASK_ASSET_ID,
  QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE,
  QA06_GENERATION_E2E_OUTPUT_FILE,
  QA06_GENERATION_E2E_PROFILE_PREFIX,
  QA06_GENERATION_E2E_REQUEST,
  QA06_GENERATION_E2E_SOURCE_ASSET_ID,
} from '../../src/main/generation-e2e';
import {
  QA06_PIXEL_PALETTE_E2E_AUDIT_FILE,
  QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE,
  QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME,
  QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE,
  QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE,
  QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX,
  QA06_PIXEL_PALETTE_E2E_REQUEST,
  qa06PixelPaletteExpectedIndex,
} from '../../src/main/pixel-generation-e2e';
import {
  FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME,
  FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX,
  FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_REQUEST,
} from '../../src/main/generation-normalization-e2e';
import { MAX_INLINE_ASSET_BYTES } from '../../src/main/transaction-policy';
import {
  UX11_BATCH_E2E_AUDIT_FILE,
  UX11_BATCH_E2E_CONNECTION_FILE,
  UX11_BATCH_E2E_EVIDENCE_FILE,
  UX11_BATCH_E2E_EXPORT_DIRECTORY,
  UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME,
  UX11_BATCH_E2E_NETWORK_SENTINEL_FILE,
  UX11_BATCH_E2E_PROFILE_PREFIX,
  UX11_BATCH_E2E_SAVE_DIRECTORY,
  UX11_BATCH_E2E_SCREENSHOTS,
  UX11_BATCH_E2E_SHARED_DOCUMENT_NAME,
} from '../../src/main/batch-workflows-e2e';
import { readNativeDocument } from '../../src/main/persistence';
import {
  assertPackagedE2eProfile,
  canonicalPackagedE2ePath,
  createPackagedE2eProfile,
  inspectPackagedMcpCredential,
  packagedE2ePrimaryModifier,
  packagedE2ePrimaryShortcut,
  resolvePackagedE2eArtifact,
  spawnPackagedE2e,
  waitForPackagedE2eReady,
} from '../../scripts/packaged-e2e-runtime.mjs';

let applicationProcess: ChildProcess | undefined;
let applicationStderr: Buffer[] = [];
let browser: Browser | undefined;
let profilePath: string | undefined;
let gracefulOnlyCleanup = false;
let preserveProfileAfterTest = false;
const packagedArtifact = resolvePackagedE2eArtifact();
const packagedExecutable = packagedArtifact.executable;
const packagedAsar = packagedArtifact.asar;

test.afterEach(async () => {
  const child = applicationProcess;
  let cleanupError: Error | undefined;
  if (child && child.exitCode === null) {
    if (gracefulOnlyCleanup) {
      try { await quitIsolatedEngineGracefully(); }
      catch (error) { cleanupError = error instanceof Error ? error : new Error('The owned packaged process did not exit through graceful-only cleanup.'); }
      if (child.exitCode === null && !cleanupError) cleanupError = new Error('The owned packaged process was still running after graceful-only cleanup; refusing force termination.');
    } else {
      try { await quitIsolatedEngineGracefully(); }
      catch (error) {
        cleanupError = error instanceof Error ? error : new Error('The owned packaged process did not exit through graceful cleanup.');
        if (child.exitCode === null) {
          child.kill();
          await new Promise<void>((resolveWait) => { child.once('exit', () => resolveWait()); setTimeout(resolveWait, 5_000); });
        }
      }
      if (child.exitCode === null && !cleanupError) cleanupError = new Error('The owned packaged process was still running after graceful cleanup.');
    }
  }
  if (profilePath && child?.exitCode !== null) {
    try { await redactOwnedConnection(join(profilePath, 'mcp-connection.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !cleanupError) cleanupError = error instanceof Error ? error : new Error('The owned MCP connection could not be redacted.');
    }
  }
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
  applicationProcess = undefined;
  applicationStderr = [];
  browser = undefined;
  if (profilePath && !preserveProfileAfterTest) await rm(profilePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  profilePath = undefined;
  gracefulOnlyCleanup = false;
  preserveProfileAfterTest = false;
  if (cleanupError) throw cleanupError;
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a DevTools port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface LaunchOptions {
  environment?: NodeJS.ProcessEnv;
  extraArguments?: string[];
}

async function launch(existingProfile?: string, options: LaunchOptions = {}): Promise<Page> {
  profilePath = existingProfile
    ? assertPackagedE2eProfile(existingProfile)
    : await createPackagedE2eProfile(process.cwd(), 'editor');
  const port = await reservePort();
  applicationStderr = [];
  applicationProcess = spawnPackagedE2e(packagedExecutable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profilePath}`,
    ...(options.extraArguments ?? []),
  ], { env: options.environment, stdio: ['ignore', 'ignore', 'pipe'] });
  applicationProcess.stderr?.on('data', (chunk: Buffer) => applicationStderr.push(chunk));
  const endpoint = `http://127.0.0.1:${port}`;
  browser = await waitForPackagedE2eReady({
    child: applicationProcess,
    label: 'The AIDraw DevTools endpoint',
    stderr: () => Buffer.concat(applicationStderr).toString('utf8'),
    attempt: async () => {
      try { return await chromium.connectOverCDP(endpoint); }
      catch { return undefined; }
    },
  });
  const deadline = Date.now() + (process.platform === 'darwin' ? 30_000 : 15_000);
  const context = browser.contexts()[0];
  while (Date.now() < deadline) {
    const page = context?.pages().find((candidate) => candidate.url().startsWith('aidraw://app/'));
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AIDraw renderer did not open. ${Buffer.concat(applicationStderr).toString('utf8')}`);
}

async function waitForHealth(profile: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const settings = JSON.parse(await readFile(join(profile, 'mcp-port.json'), 'utf8')) as { preferredPort: number };
      const url = `http://127.0.0.1:${settings.preferredPort}/health`;
      const response = await fetch(url);
      if (response.ok) return url;
    } catch { /* Engine is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The headless AIDraw health endpoint did not start.');
}

async function waitForMcpConnection(path: string): Promise<{ url: string; token: string; activeDocumentId: string; trustedFolders: string[] }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const connection = JSON.parse(await readFile(path, 'utf8')) as { url?: string; token?: string; activeDocumentId?: string; trustedFolders?: string[] };
      if (connection.url && connection.token && connection.activeDocumentId) return { url: connection.url, token: connection.token, activeDocumentId: connection.activeDocumentId, trustedFolders: connection.trustedFolders ?? [] };
    } catch { /* Headless engine is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The headless AIDraw MCP connection file was not written.');
}

function parseMcpPayload(text: string): { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: unknown };
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1)!) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: unknown };
}

async function callMcpTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const payload = parseMcpPayload(await response.text());
  if (!response.ok || payload.error) throw new Error(`${name} failed: ${JSON.stringify(payload.error ?? payload)}`);
  const text = payload.result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} did not return structured JSON text.`);
  if (payload.result?.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectMcpTestClient(url: string, token: string, clientName: string, join: { name: string; color: string; documentId: string }): Promise<{ actor: Actor; headers: Record<string, string> }> {
  const initialize = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: clientName, version: '1.0' } } }),
  });
  const sessionId = initialize.headers.get('mcp-session-id');
  if (!initialize.ok || !sessionId) throw new Error(`The isolated ${clientName} MCP session is unavailable.`);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const joined = await callMcpTool(url, headers, 2, 'session_manage', { action: 'join', ...join });
  const actor = joined.actor as Actor | undefined;
  if (!actor?.id || actor.kind !== 'agent' || actor.name !== join.name) throw new Error(`The isolated ${clientName} actor identity is invalid.`);
  return { actor, headers };
}

async function waitForRendererPage(): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = browser?.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith('aidraw://app/'));
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The existing headless engine did not attach an editor window.');
}

async function signalExistingEngine(...args: string[]): Promise<void> {
  if (!profilePath) throw new Error('No AIDraw test profile is active.');
  const child = spawnPackagedE2e(packagedExecutable, [`--user-data-dir=${profilePath}`, ...args], { stdio: 'ignore' });
  await waitForOwnedProcessExit(child, 'The isolated engine signal', 5_000);
}

async function waitForOwnedProcessExit(child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} could not run: ${error.message}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} did not exit gracefully within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (child.exitCode !== null) onExit();
  });
}

async function quitIsolatedEngineGracefully(): Promise<void> {
  if (!profilePath || !applicationProcess || applicationProcess.exitCode !== null) return;
  const engine = applicationProcess;
  const signal = spawnPackagedE2e(packagedExecutable, [`--user-data-dir=${profilePath}`, '--quit-engine'], { stdio: 'ignore' });
  await waitForOwnedProcessExit(signal, 'The isolated quit signal', 5_000);
  await waitForOwnedProcessExit(engine, 'The isolated AIDraw engine', 15_000);
}

function visualHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function redactOwnedConnection(path: string): Promise<void> {
  const connection = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  delete connection.token;
  await writeFile(path, `${JSON.stringify({ ...connection, credentialStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, 'utf8');
}

test('opens the configurable New Document dialog from the native shortcut without creating first', async () => {
  const page = await launch();
  const before = await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length);
  await page.keyboard.press(packagedE2ePrimaryShortcut('N'));
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Document width')).toHaveValue('1920');
  await expect(dialog.getByLabel('Document height')).toHaveValue('1080');
  expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length)).toBe(before);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length)).toBe(before);
});

test('writes the stable OpenCode MCP shape through the packaged onboarding UI', async () => {
  const isolatedProfile = await createPackagedE2eProfile(process.cwd(), 'opencode');
  const configPath = join(isolatedProfile, 'opencode.jsonc');
  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  await writeFile(configPath, '{\n  // preserve this user setting\n  "theme": "system",\n  "mcp": { "servers": { "aidraw": { "type": "remote", "url": "http://127.0.0.1:1/mcp", "codemode": false } } }\n}\n', 'utf8');

  const page = await launch(isolatedProfile, {
    environment: {
      NODE_ENV: 'test',
      AIDRAW_E2E_AUTO_APPROVE_AGENT_CLIENT: 'opencode',
      AIDRAW_OPENCODE_CONFIG_PATH: configPath,
    },
    extraArguments: [`--write-mcp-connection=${connectionPath}`],
  });
  await page.getByTitle('Activity').click();
  await page.getByLabel('Agent client').selectOption('opencode');
  const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  const setup = page.getByRole('dialog', { name: 'Finish OpenCode setup' });
  await expect(setup.getByText('Connection saved successfully', { exact: true })).toBeVisible();
  await expect(setup.getByText('Restart OpenCode, then run opencode mcp list to verify AIDraw.', { exact: true })).toBeVisible();
  await expect(setup.getByText(/Start-at-login was intentionally unchanged by this isolated packaged validation\./)).toBeVisible();

  const text = await readFile(configPath, 'utf8');
  const config = parse(text) as { theme?: string; mcp?: Record<string, unknown> };
  const aidraw = config.mcp?.aidraw as { type?: string; url?: string; enabled?: boolean; oauth?: boolean; codemode?: boolean; headers?: { Authorization?: string } } | undefined;
  expect(text).toContain('// preserve this user setting');
  expect(config.theme).toBe('system');
  expect(config.mcp).not.toHaveProperty('servers');
  expect(aidraw).toMatchObject({ type: 'remote', url: credentials.url, enabled: true, oauth: false });
  expect(aidraw).not.toHaveProperty('codemode');
  expect(aidraw?.headers?.Authorization === `Bearer ${credentials.token}`).toBe(true);
  await setup.getByRole('button', { name: 'Got it' }).click();
});

test('keeps a live object outliner synchronized with agent edits and human organization', async () => {
  const page = await launch();
  const initial = await page.evaluate(async () => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'illustration') throw new Error('Illustration document unavailable.');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Vector layer unavailable.');
    const timestamp = new Date().toISOString();
    const base = {
      revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'outliner-agent', layerId: layer.id,
      visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
      stroke: { paint: { kind: 'solid' as const, color: '#342947' }, width: 2, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
    };
    const response = await window.aidraw.applyTransaction({
      id: 'tx-outliner-initial', clientOperationId: 'e2e-outliner-initial', documentId: document.id,
      actor: { id: 'outliner-agent', kind: 'agent', name: 'Outliner agent', color: '#2fa7a0' },
      label: 'Agent adds organized objects', createdAt: timestamp,
      operations: [
        { kind: 'illustration.object.add', object: { ...base, id: 'outliner-rectangle', name: 'Human rectangle', type: 'shape', shape: 'rectangle', width: 180, height: 110, transform: { ...base.transform, x: 150, y: 180 }, fill: { kind: 'solid', color: '#f28a8f' } } },
        { kind: 'illustration.object.add', object: { ...base, id: 'outliner-star', name: 'Agent star', type: 'shape', shape: 'star', width: 130, height: 130, sides: 5, innerRadius: .45, transform: { ...base.transform, x: 430, y: 210 }, fill: { kind: 'solid', color: '#f2cf65' } } },
      ],
      playback: { mode: 'instant', speed: 1 },
    });
    return { status: response.status, documentId: document.id, layerId: layer.id };
  });
  expect(initial.status).toBe('committed');

  const rectangle = page.locator('.object-row').filter({ hasText: 'Human rectangle' });
  const star = page.locator('.object-row').filter({ hasText: 'Agent star' });
  await expect(rectangle).toBeVisible();
  await expect(star).toBeVisible();
  await rectangle.locator('.object-main').click();
  await expect(rectangle).toHaveClass(/is-selected/);

  await page.evaluate(async ({ documentId, layerId }) => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'illustration') throw new Error('Illustration document unavailable.');
    const timestamp = new Date().toISOString();
    await window.aidraw.applyTransaction({
      id: 'tx-outliner-live', clientOperationId: 'e2e-outliner-live', documentId,
      actor: { id: 'outliner-agent', kind: 'agent', name: 'Outliner agent', color: '#2fa7a0' },
      label: 'Agent adds ellipse while human selects', createdAt: timestamp,
      operations: [{
        kind: 'illustration.object.add',
        object: {
          id: 'outliner-ellipse', revision: 0, name: 'Live agent ellipse', createdAt: timestamp, updatedAt: timestamp,
          createdBy: 'outliner-agent', layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
          transform: { x: 720, y: 240, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
          type: 'shape', shape: 'ellipse', width: 150, height: 95, fill: { kind: 'solid', color: '#67c4bb' },
          stroke: { paint: { kind: 'solid', color: '#342947' }, width: 2, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
        },
      }],
      playback: { mode: 'instant', speed: 1 },
    });
  }, initial);
  await expect(page.locator('.object-row').filter({ hasText: 'Live agent ellipse' })).toBeVisible();
  await expect(rectangle).toHaveClass(/is-selected/);

  await star.locator('.object-main').dblclick();
  const rename = page.getByLabel('Rename Agent star');
  await rename.fill('Renamed agent star');
  await rename.press('Enter');
  await expect(page.locator('.object-row').filter({ hasText: 'Renamed agent star' })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    return document?.kind === 'illustration' ? document.objects['outliner-star']?.name : undefined;
  })).toBe('Renamed agent star');

  const renamedStar = page.locator('.object-row').filter({ hasText: 'Renamed agent star' });
  await renamedStar.getByTitle('Move object down').click();
  await expect.poll(async () => page.evaluate(async ({ layerId }) => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    const layer = document?.kind === 'illustration' ? document.layers[layerId] : undefined;
    return layer?.type === 'vector' ? layer.objectIds.slice(0, 2) : [];
  }, initial)).toEqual(['outliner-star', 'outliner-rectangle']);

  await rectangle.locator('.object-main').click();
  await renamedStar.locator('.object-main').click({ modifiers: [packagedE2ePrimaryModifier()] });
  await page.locator('.object-inspector').getByRole('button', { name: 'Group' }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'illustration') return [];
    const group = Object.values(document.objects).find((entry) => entry.type === 'group');
    return group?.type === 'group' ? [...group.childIds].sort() : [];
  })).toEqual(['outliner-rectangle', 'outliner-star']);

  await page.getByLabel('Filter layers and objects').fill('ellipse');
  await expect(page.locator('.object-row').filter({ hasText: 'Live agent ellipse' })).toBeVisible();
  await expect(page.locator('.object-row').filter({ hasText: 'Renamed agent star' })).toHaveCount(0);
});

test('creates and edits an indexed pixel sprite', async () => {
  const page = await launch(); await expect(page.getByText('Illustration', { exact: true }).last()).toBeVisible(); await page.getByTitle('New document').click(); const dialog = page.getByRole('dialog', { name: 'New document' }); await expect(dialog).toBeVisible(); await dialog.getByRole('radio', { name: /Pixel Sprite/ }).click(); await dialog.getByRole('button', { name: 'Create Pixel Sprite' }).click(); await expect(page.locator('.status-mode').filter({ hasText: /^Pixel Art$/ })).toBeVisible();
  const canvas = page.getByRole('application', { name: /Pixel-art canvas/ }); await expect(canvas).toBeVisible(); await page.getByTitle('Pixel-perfect pencil').click(); const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Pixel canvas has no bounds'); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 18, bounds.y + bounds.height / 2 + 18, { steps: 6 }); await page.mouse.up(); await expect(page.getByLabel('Unsaved changes').last()).toBeVisible();
});

test('runs packaged agent image quantization in the supervised raster utility', async () => {
  const page = await launch();
  const setup = await page.evaluate(async () => {
    await window.aidraw.newDocument({ kind: 'sprite', name: 'Utility quantize', width: 2, height: 2 });
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'pixel') throw new Error('Pixel document unavailable.');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Sprite unavailable.');
    const cel = Object.values(sprite.cels)[0];
    return { documentId: document.id, spriteId: sprite.id, celId: cel.id, celRevision: cel.revision, credentials: await window.aidraw.getMcpCredentials() };
  });
  if (!setup.credentials.url) throw new Error('MCP endpoint unavailable.');
  const initialize = await fetch(setup.credentials.url, { method: 'POST', headers: { authorization: `Bearer ${setup.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'utility-e2e', version: '1.0' } } }) });
  const sessionId = initialize.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('MCP session unavailable.');
  const headers = { authorization: `Bearer ${setup.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(setup.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await callMcpTool(setup.credentials.url, headers, 2, 'session_manage', { action: 'join', name: 'Utility test agent', documentId: setup.documentId });

  const source = createCanvas(2, 2);
  const context = source.getContext('2d');
  context.fillStyle = '#31a6a0';
  context.fillRect(0, 0, 2, 2);
  const bytes = source.toBuffer('image/png');
  const assetId = 'utility-source-image';
  const asset = { id: assetId, name: 'Utility source', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'embedded', data: bytes.toString('base64') };
  expect(await callMcpTool(setup.credentials.url, headers, 3, 'canvas_apply', { documentId: setup.documentId, clientOperationId: 'utility-asset', label: 'Embed utility source', operations: [{ kind: 'asset.add', asset }], playback: { mode: 'instant', speed: 1 } })).toMatchObject({ status: 'committed' });
  expect(await callMcpTool(setup.credentials.url, headers, 4, 'canvas_apply', { documentId: setup.documentId, clientOperationId: 'utility-quantize', label: 'Quantize in utility process', operations: [{ kind: 'pixel.image.quantize', assetId, spriteId: setup.spriteId, celId: setup.celId, x: 0, y: 0, width: 2, height: 2, expectedRevision: setup.celRevision }], playback: { mode: 'instant', speed: 1 } })).toMatchObject({ status: 'committed' });
  const observed = await callMcpTool(setup.credentials.url, headers, 5, 'canvas_observe', { documentId: setup.documentId });
  const document = observed.document as PixelDocument;
  const sprite = document.pixelAssets[setup.spriteId];
  if (sprite.type !== 'sprite') throw new Error('Observed sprite unavailable.');
  const cel = sprite.cels[setup.celId];
  expect([readPixel(cel, 0, 0), readPixel(cel, 1, 0), readPixel(cel, 0, 1), readPixel(cel, 1, 1)]).toEqual([8, 8, 8, 8]);
});

test('visibly replays a committed pixel drawing trace', async () => {
  const page = await launch();
  await page.evaluate(async () => window.aidraw.newDocument({ kind: 'sprite', name: 'Pixel replay', width: 32, height: 32 }));
  const canvas = page.getByRole('application', { name: /Pixel-art canvas/ });
  await expect(canvas).toBeVisible();
  const blank = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const setup = await page.evaluate(async () => {
    const document = (await window.aidraw.bootstrap()).activeDocument;
    if (!document || document.kind !== 'pixel') throw new Error('Pixel replay document unavailable.');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Pixel replay sprite unavailable.');
    const frameId = sprite.frameIds[0];
    const cel = Object.values(sprite.cels).find((entry) => entry.frameId === frameId);
    if (!cel) throw new Error('Pixel replay cel unavailable.');
    return { documentId: document.id, spriteId: sprite.id, celId: cel.id, revision: cel.revision, credentials: await window.aidraw.getMcpCredentials() };
  });
  if (!setup.credentials.url) throw new Error('Pixel replay MCP endpoint unavailable.');
  const initialize = await fetch(setup.credentials.url, { method: 'POST', headers: { authorization: `Bearer ${setup.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'pixel-replay-e2e', version: '1.0' } } }) });
  const sessionId = initialize.headers.get('mcp-session-id'); if (!sessionId) throw new Error('Pixel replay MCP session missing.');
  const headers = { authorization: `Bearer ${setup.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(setup.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await callMcpTool(setup.credentials.url, headers, 2, 'session_manage', { action: 'join', name: 'Pixel replay agent', color: '#31a6a0', documentId: setup.documentId });
  const changes = Array.from({ length: 144 }, (_, index) => ({ x: 10 + index % 12, y: 10 + Math.floor(index / 12), index: 1 + index % 5 }));
  const response = await callMcpTool(setup.credentials.url, headers, 3, 'canvas_apply', {
    documentId: setup.documentId, clientOperationId: 'e2e-pixel-replay', label: 'Agent pixel mosaic',
    operations: [{ kind: 'pixel.cel.set', spriteId: setup.spriteId, celId: setup.celId, changes, expectedRevision: setup.revision }],
    playback: { mode: 'instant', speed: 1 },
  });
  expect(response.status).toBe('committed');

  await expect.poll(
    () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
    { timeout: 4_000 },
  ).not.toBe(blank);
  const completed = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.getByTitle('Activity').click();
  await expect(page.getByText('Agent pixel mosaic', { exact: true })).toBeVisible();
  const replay = page.getByTitle('Replay durable agent trace').first();
  await replay.click();
  await expect(replay).toHaveText(/Replaying/);
  await page.waitForTimeout(80);
  const revealing = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  expect(revealing).not.toBe(completed);
  await expect(replay).toHaveText('Replay', { timeout: 4_000 });
  await expect.poll(
    () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
    { timeout: 4_000 },
  ).toBe(completed);
});

test('keeps many open document tabs reachable', async () => {
  const page = await launch();
  await page.evaluate(async () => {
    for (let index = 1; index <= 14; index += 1) {
      await window.aidraw.newDocument({ kind: 'sprite', name: `Overflow sprite ${index}` });
    }
  });

  const viewport = page.locator('.document-tab-viewport');
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'All open documents' }).click();
  const menu = page.getByRole('menu', { name: 'All open documents' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(15);
  await menu.getByRole('menuitem', { name: 'Overflow sprite 1', exact: true }).click();
  await expect(page.locator('.document-tab[title="Overflow sprite 1"]')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.locator('.document-tab.is-active').evaluate((tab) => {
    const viewportElement = tab.parentElement!;
    const tabBounds = tab.getBoundingClientRect();
    const viewportBounds = viewportElement.getBoundingClientRect();
    return tabBounds.left >= viewportBounds.left - 1 && tabBounds.right <= viewportBounds.right + 1;
  })).toBe(true);
});

test('publishes and clears attached editor advisory state through MCP', async () => {
  const page = await launch();
  const state = await page.evaluate(async () => ({ snapshot: await window.aidraw.bootstrap(), credentials: await window.aidraw.getMcpCredentials() }));
  if (!state.credentials.url || !state.snapshot.activeDocumentId) throw new Error('Editor advisory MCP setup unavailable.');

  const initialize = await fetch(state.credentials.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'editor-advisory-e2e', version: '1.0' } } }),
  });
  const sessionId = initialize.headers.get('mcp-session-id');
  if (!initialize.ok || !sessionId) throw new Error('Editor advisory MCP session missing.');
  const headers = { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(state.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await callMcpTool(state.credentials.url, headers, 2, 'session_manage', { action: 'join', name: 'Editor advisory observer', documentId: state.snapshot.activeDocumentId });

  await page.getByTitle('Pressure pen').click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('.zoom-control output')).toHaveText('125%');

  let requestId = 3;
  const inspectAdvisory = async () => {
    const inspected = await callMcpTool(state.credentials.url!, headers, requestId++, 'session_manage', { action: 'inspect', documentId: state.snapshot.activeDocumentId });
    const workspace = inspected.workspace as { editorAdvisory?: { attached?: boolean; documentId?: string; tool?: string; zoom?: number; viewport?: { width?: number; height?: number } } } | undefined;
    return workspace?.editorAdvisory;
  };
  await expect.poll(async () => {
    const advisory = await inspectAdvisory();
    return advisory?.attached === true
      && advisory.documentId === state.snapshot.activeDocumentId
      && advisory.tool === 'pen'
      && advisory.zoom === 1.25
      && Number(advisory.viewport?.width) > 0
      && Number(advisory.viewport?.height) > 0;
  }).toBe(true);

  await page.close();
  await expect.poll(async () => (await inspectAdvisory())?.attached).toBe(false);
});

test('contains a sanitized malformed renderer event and reloads canonical engine state', async () => {
  const isolatedProfile = await createPackagedE2eProfile(process.cwd(), 'recovery');
  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const diagnosticPath = join(isolatedProfile, 'renderer-recovery-diagnostic.json');
  const artworkSentinel = 'UX05_PRIVATE_ARTWORK_7d13';
  const promptSentinel = 'UX05_PRIVATE_PROMPT_4e22';
  const negativePromptSentinel = 'UX05_PRIVATE_NEGATIVE_PROMPT_9c81';
  const taskSentinel = 'UX05_PRIVATE_TASK_f664';
  const providerSecretSentinel = 'UX05_PRIVATE_PROVIDER_SECRET_2a50';
  let stoppedGracefully = false;

  try {
    const page = await launch(isolatedProfile, {
      environment: {
        NODE_ENV: 'test',
        AIDRAW_E2E_RENDERER_RECOVERY: '1',
        AIDRAW_E2E_RENDERER_DIAGNOSTIC_PATH: diagnosticPath,
      },
      extraArguments: [`--write-mcp-connection=${connectionPath}`],
    });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated renderer-recovery process has no PID.');

    const artwork = createCanvas(2, 2);
    const artworkContext = artwork.getContext('2d');
    artworkContext.fillStyle = '#c86891';
    artworkContext.fillRect(0, 0, 2, 2);
    const artworkBytes = artwork.toBuffer('image/png');
    const artworkData = artworkBytes.toString('base64');
    const artworkAssetId = 'ux05-private-artwork';
    const initial = await page.evaluate(async ({ artworkAssetId, artworkSentinel, artworkData, byteLength, sha256 }) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The UX-05 illustration document is unavailable.');
      const timestamp = new Date().toISOString();
      const result = await window.aidraw.applyTransaction({
        id: 'tx-ux05-private-artwork',
        clientOperationId: 'e2e-ux05-private-artwork',
        documentId: document.id,
        actor: { id: 'ux05-renderer', kind: 'human', name: 'Human', color: '#27213c' },
        label: 'Prepare renderer recovery state',
        createdAt: timestamp,
        operations: [{
          kind: 'asset.add',
          asset: { id: artworkAssetId, name: artworkSentinel, mimeType: 'image/png', byteLength, sha256, source: 'embedded', data: artworkData },
        }],
        playback: { mode: 'instant', speed: 1 },
      });
      return { status: result.status, documentId: document.id };
    }, {
      artworkAssetId,
      artworkSentinel,
      artworkData,
      byteLength: artworkBytes.byteLength,
      sha256: createHash('sha256').update(artworkBytes).digest('hex'),
    });
    expect(initial.status).toBe('committed');

    const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
    if (!credentials.url || !credentials.token) throw new Error('The isolated UX-05 MCP endpoint is unavailable.');
    const initialize = await fetch(credentials.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'renderer-recovery-e2e', version: '1.0' } } }),
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    if (!initialize.ok || !sessionId) throw new Error('The isolated UX-05 MCP session is unavailable.');
    const headers = { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
    await fetch(credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    await callMcpTool(credentials.url, headers, 2, 'session_manage', { action: 'join', name: 'Recovery probe agent', documentId: initial.documentId, model: 'e2e-recovery-model', reasoningEffort: 'high', taskId: taskSentinel });
    const generation = await callMcpTool(credentials.url, headers, 3, 'generation_start', {
      documentId: initial.documentId,
      provider: 'stability',
      mode: 'create',
      prompt: promptSentinel,
      negativePrompt: negativePromptSentinel,
      sourceAssetIds: [],
      size: 'auto',
      resultCount: 1,
      providerOptions: { stylePreset: providerSecretSentinel },
    });
    const generationJobId = typeof generation.jobId === 'string' ? generation.jobId : undefined;
    expect({ status: generation.status, hasJobId: Boolean(generationJobId) }).toEqual({ status: 'waiting-for-user', hasJobId: true });
    if (!generationJobId) throw new Error('The sanitized generation approval has no job ID.');

    const canonicalBefore = await page.evaluate(async ({ artworkAssetId, artworkSentinel, artworkData, generationJobId, promptSentinel, negativePromptSentinel, taskSentinel, providerSecretSentinel }) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The canonical UX-05 document is unavailable.');
      const job = snapshot.jobs.find((entry) => entry.id === generationJobId);
      const encodedJob = JSON.stringify(job);
      const encodedSessions = JSON.stringify(snapshot.mcp.sessions);
      return {
        documentId: document.id,
        name: document.name,
        kind: document.kind,
        revision: document.revision,
        width: document.artboard.width,
        height: document.artboard.height,
        assetPresent: document.assets[artworkAssetId]?.name === artworkSentinel,
        artworkDataPresent: document.assets[artworkAssetId]?.data === artworkData,
        jobStatus: job?.status,
        promptPresent: encodedJob.includes(promptSentinel) && encodedJob.includes(negativePromptSentinel),
        providerSecretPresent: encodedJob.includes(providerSecretSentinel),
        taskPresent: encodedJob.includes(taskSentinel) || encodedSessions.includes(taskSentinel),
      };
    }, { artworkAssetId, artworkSentinel, artworkData, generationJobId, promptSentinel, negativePromptSentinel, taskSentinel, providerSecretSentinel });
    expect(canonicalBefore).toMatchObject({ kind: 'illustration', assetPresent: true, artworkDataPresent: true, jobStatus: 'waiting-for-user', promptPresent: true, providerSecretPresent: true, taskPresent: true });

    const injection = await page.evaluate(async () => window.aidraw.injectRendererRecoveryTestEvent());
    expect(injection.injected).toBe(true);
    expect(injection.byteLength).toBeGreaterThan(0);
    expect(injection.byteLength).toBeLessThanOrEqual(1_024);

    const recovery = page.getByRole('alert');
    await expect(recovery.getByRole('heading', { name: 'The editor hit a malformed drawing event' })).toBeVisible();
    await expect(recovery.getByRole('button', { name: 'Reload editor' })).toBeEnabled();
    await expect(recovery.getByRole('button', { name: 'Save diagnostics…' })).toBeEnabled();
    await recovery.getByText('Technical detail', { exact: true }).click();
    const technicalDetail = await recovery.locator('code').textContent();
    expect((technicalDetail?.length ?? 0) > 0 && (technicalDetail?.length ?? 0) <= 4_096).toBe(true);
    expect([artworkSentinel, promptSentinel, negativePromptSentinel, taskSentinel, providerSecretSentinel, credentials.token].some((value) => technicalDetail?.includes(value))).toBe(false);

    const canonicalWhileContained = await page.evaluate(async ({ documentId, artworkAssetId, generationJobId }) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      const engine = await window.aidraw.getEngineStatus();
      return {
        sameDocument: document?.id === documentId,
        assetPresent: document?.kind === 'illustration' && Boolean(document.assets[artworkAssetId]),
        jobStatus: snapshot.jobs.find((entry) => entry.id === generationJobId)?.status,
        running: engine.running,
        attached: engine.uiAttached,
      };
    }, { documentId: canonicalBefore.documentId, artworkAssetId, generationJobId });
    expect(canonicalWhileContained).toEqual({ sameDocument: true, assetPresent: true, jobStatus: 'waiting-for-user', running: true, attached: true });
    const inspected = await callMcpTool(credentials.url, headers, 4, 'session_manage', { action: 'inspect', documentId: canonicalBefore.documentId });
    const inspectedWorkspace = inspected.workspace as { activeDocumentId?: string } | undefined;
    expect(inspectedWorkspace?.activeDocumentId === canonicalBefore.documentId).toBe(true);

    await recovery.getByRole('button', { name: 'Save diagnostics…' }).click();
    await expect(recovery.getByRole('status')).toContainText('Saved locally to');
    const diagnosticText = await readFile(diagnosticPath, 'utf8');
    expect(diagnosticText.length).toBeGreaterThan(0);
    expect(diagnosticText.length).toBeLessThan(100_000);
    const diagnostic = JSON.parse(diagnosticText) as {
      format?: string;
      version?: number;
      localOnly?: boolean;
      renderer?: { message?: string };
      engine?: { running?: boolean; uiAttached?: boolean; mode?: string };
      workspace?: { activeDocumentId?: string; documents?: Array<Record<string, unknown>>; jobs?: Array<Record<string, unknown>>; mcp?: Record<string, unknown>; checkpointCount?: number };
    };
    expect({
      format: diagnostic.format,
      version: diagnostic.version,
      localOnly: diagnostic.localOnly,
      rendererMessageBounded: Boolean(diagnostic.renderer?.message) && diagnostic.renderer!.message!.length <= 4_096,
      engineRunning: diagnostic.engine?.running,
      editorAttached: diagnostic.engine?.uiAttached,
      mode: diagnostic.engine?.mode,
      activeDocumentId: diagnostic.workspace?.activeDocumentId,
      documentKeys: Object.keys(diagnostic.workspace?.documents?.[0] ?? {}).sort(),
      jobKeys: Object.keys(diagnostic.workspace?.jobs?.find((job) => job.id === generationJobId) ?? {}).sort(),
      mcpKeys: Object.keys(diagnostic.workspace?.mcp ?? {}).sort(),
      checkpointCount: diagnostic.workspace?.checkpointCount,
    }).toEqual({
      format: 'aidraw-renderer-diagnostic',
      version: 1,
      localOnly: true,
      rendererMessageBounded: true,
      engineRunning: true,
      editorAttached: true,
      mode: 'interactive',
      activeDocumentId: canonicalBefore.documentId,
      documentKeys: ['dirty', 'id', 'kind', 'name', 'revision'],
      jobKeys: ['actor', 'id', 'kind', 'progress', 'status'],
      mcpKeys: ['port', 'running', 'sessionCount'],
      checkpointCount: 0,
    });
    const diagnosticLeaks = [
      artworkSentinel,
      artworkData,
      promptSentinel,
      negativePromptSentinel,
      taskSentinel,
      providerSecretSentinel,
      credentials.token,
      connectionPath,
      isolatedProfile,
      'ux05-sanitized-malformed-document',
    ].map((value) => diagnosticText.includes(value));
    expect(diagnosticLeaks).toEqual(Array(diagnosticLeaks.length).fill(false));
    expect(diagnosticText.includes('Bearer ')).toBe(false);

    const navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await recovery.getByRole('button', { name: 'Reload editor' }).click();
    await navigation;
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(canonicalBefore.name, { exact: true }).first()).toBeVisible();

    const canonicalAfterReload = await page.evaluate(async ({ documentId, revision, width, height, artworkAssetId, artworkSentinel, artworkData, generationJobId, promptSentinel, taskSentinel }) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      const job = snapshot.jobs.find((entry) => entry.id === generationJobId);
      return {
        sameDocument: document?.id === documentId,
        sameRevision: document?.revision === revision,
        sameDimensions: document?.kind === 'illustration' && document.artboard.width === width && document.artboard.height === height,
        assetRestored: document?.kind === 'illustration' && document.assets[artworkAssetId]?.name === artworkSentinel && document.assets[artworkAssetId]?.data === artworkData,
        jobRestored: job?.status === 'waiting-for-user' && JSON.stringify(job).includes(promptSentinel),
        taskRestored: JSON.stringify(snapshot.mcp.sessions).includes(taskSentinel),
      };
    }, { documentId: canonicalBefore.documentId, revision: canonicalBefore.revision, width: canonicalBefore.width, height: canonicalBefore.height, artworkAssetId, artworkSentinel, artworkData, generationJobId, promptSentinel, taskSentinel });
    expect(canonicalAfterReload).toEqual({ sameDocument: true, sameRevision: true, sameDimensions: true, assetRestored: true, jobRestored: true, taskRestored: true });
    expect(applicationProcess?.pid).toBe(enginePid);

    await quitIsolatedEngineGracefully();
    stoppedGracefully = true;
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) await quitIsolatedEngineGracefully();
  }
});

test('keeps held illustration-object and pixel-region gestures ahead of authenticated agent conflicts', async () => {
  const evidenceRoot = join(process.cwd(), 'test-results', 'retained');
  await mkdir(evidenceRoot, { recursive: true });
  const isolatedProfile = await mkdtemp(join(evidenceRoot, 'aidraw-e2e-locks-'));
  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;

  try {
    const page = await launch(isolatedProfile, { extraArguments: [`--write-mcp-connection=${connectionPath}`] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated AGT-07 package has no engine PID.');

    const illustration = await page.evaluate(async () => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The AGT-07 illustration document is unavailable.');
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'vector') throw new Error('The AGT-07 vector layer is unavailable.');
      const timestamp = new Date().toISOString();
      const object = {
        id: 'agt07-held-object', revision: 0, name: 'Human held object', createdAt: timestamp, updatedAt: timestamp, createdBy: 'human',
        layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
        transform: { x: 420, y: 300, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
        type: 'shape' as const, shape: 'rectangle' as const, width: 240, height: 160,
        fill: { kind: 'solid' as const, color: '#f28a8f' },
        stroke: { paint: { kind: 'solid' as const, color: '#342947' }, width: 4, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
      };
      const applied = await window.aidraw.applyTransaction({
        id: 'tx-agt07-held-object', clientOperationId: 'e2e-agt07-held-object', documentId: document.id,
        actor: { id: 'agt07-human', kind: 'human', name: 'Human', color: '#27213c' }, label: 'Add held object', createdAt: timestamp,
        operations: [{ kind: 'illustration.object.add', object }], playback: { mode: 'instant', speed: 1 },
      });
      return { status: applied.status, documentId: document.id, object, artboard: document.artboard };
    });
    expect(illustration.status).toBe('committed');
    await expect(page.getByText('Human held object', { exact: true })).toBeVisible();

    const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
    if (!credentials.url || !credentials.token) throw new Error('The isolated AGT-07 MCP endpoint is unavailable.');
    const initialize = await fetch(credentials.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'agt07-lock-e2e', version: '1.0' } } }),
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    if (!initialize.ok || !sessionId) throw new Error('The isolated AGT-07 MCP session is unavailable.');
    const headers = { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
    await fetch(credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    let requestId = 2;
    await callMcpTool(credentials.url, headers, requestId++, 'session_manage', { action: 'join', name: 'AGT-07 conflict agent', documentId: illustration.documentId });

    const illustrationCanvas = page.getByRole('application', { name: /Illustration canvas/ });
    await expect(illustrationCanvas).toBeVisible();
    const illustrationBounds = await illustrationCanvas.boundingBox();
    if (!illustrationBounds) throw new Error('The AGT-07 illustration canvas has no bounds.');
    const illustrationScale = Math.min((illustrationBounds.width - 128) / illustration.artboard.width, (illustrationBounds.height - 112) / illustration.artboard.height);
    const illustrationOffsetX = (illustrationBounds.width - illustration.artboard.width * illustrationScale) / 2;
    const illustrationOffsetY = (illustrationBounds.height - illustration.artboard.height * illustrationScale) / 2;
    const illustrationStart = {
      x: illustrationBounds.x + illustrationOffsetX + (illustration.object.transform.x + illustration.object.width / 2) * illustrationScale,
      y: illustrationBounds.y + illustrationOffsetY + (illustration.object.transform.y + illustration.object.height / 2) * illustrationScale,
    };
    const illustrationEnd = { x: illustrationStart.x + 72, y: illustrationStart.y + 44 };
    const illustrationBeforeVisual = visualHash(await illustrationCanvas.screenshot());
    await page.mouse.move(illustrationStart.x, illustrationStart.y);
    await page.mouse.down();

    const inspectIllustrationLock = async () => {
      const inspected = await callMcpTool(credentials.url!, headers, requestId++, 'session_manage', { action: 'inspect', documentId: illustration.documentId });
      const workspace = inspected.workspace as { humanOccupancy?: { active?: boolean; locks?: Array<{ objectIds?: string[] }> } } | undefined;
      return workspace?.humanOccupancy;
    };
    await expect.poll(async () => {
      const occupancy = await inspectIllustrationLock();
      return occupancy?.active === true && occupancy.locks?.some((lock) => lock.objectIds?.includes(illustration.object.id)) === true;
    }).toBe(true);

    await page.mouse.move(illustrationEnd.x, illustrationEnd.y, { steps: 6 });
    await expect.poll(async () => visualHash(await illustrationCanvas.screenshot())).not.toBe(illustrationBeforeVisual);
    const illustrationDuringVisual = visualHash(await illustrationCanvas.screenshot());
    const illustrationConflict = await callMcpTool(credentials.url, headers, requestId++, 'canvas_apply', {
      documentId: illustration.documentId,
      clientOperationId: 'agt07-agent-delete-held-object',
      label: 'Agent deletes held object',
      operations: [{ kind: 'illustration.object.delete', objectId: illustration.object.id, expectedRevision: illustration.object.revision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect({
      status: illustrationConflict.status,
      message: illustrationConflict.message,
      retryable: (illustrationConflict.conflict as { retryable?: boolean } | undefined)?.retryable,
    }).toEqual({ status: 'locked', message: 'A human is actively editing this object or region.', retryable: true });
    const illustrationWhileHeld = await page.evaluate(async ({ documentId, objectId }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.id !== documentId || document.kind !== 'illustration') return undefined;
      const object = document.objects[objectId];
      return { exists: Boolean(object), revision: object?.revision, x: object?.transform.x, y: object?.transform.y, documentRevision: document.revision };
    }, { documentId: illustration.documentId, objectId: illustration.object.id, revision: illustration.object.revision, x: illustration.object.transform.x, y: illustration.object.transform.y });
    expect(illustrationWhileHeld).toMatchObject({ exists: true, revision: illustration.object.revision, x: illustration.object.transform.x, y: illustration.object.transform.y, documentRevision: 1 });

    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async ({ documentId, objectId }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.id !== documentId || document.kind !== 'illustration') return undefined;
      const object = document.objects[objectId];
      return object ? { name: object.name, revision: object.revision, x: object.transform.x, y: object.transform.y, documentRevision: document.revision, lastLabel: document.activity.at(-1)?.label } : undefined;
    }, { documentId: illustration.documentId, objectId: illustration.object.id })).toMatchObject({ name: 'Human held object', revision: 1, documentRevision: 2, lastLabel: 'Move object' });
    const illustrationCanonical = await page.evaluate(async ({ documentId, objectId }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.id !== documentId || document.kind !== 'illustration') return undefined;
      const object = document.objects[objectId];
      return object ? { x: object.transform.x, y: object.transform.y } : undefined;
    }, { documentId: illustration.documentId, objectId: illustration.object.id });
    expect(illustrationCanonical?.x !== illustration.object.transform.x || illustrationCanonical?.y !== illustration.object.transform.y).toBe(true);
    expect(visualHash(await illustrationCanvas.screenshot())).not.toBe(illustrationBeforeVisual);
    expect(illustrationDuringVisual).not.toBe(illustrationBeforeVisual);
    const observedIllustration = await callMcpTool(credentials.url, headers, requestId++, 'canvas_observe', { documentId: illustration.documentId });
    const observedIllustrationDocument = observedIllustration.document as { objects?: Record<string, { name?: string; revision?: number; transform?: { x?: number; y?: number } }> } | undefined;
    expect(observedIllustrationDocument?.objects?.[illustration.object.id]).toMatchObject({ name: 'Human held object', revision: 1, transform: illustrationCanonical });
    expect((await inspectIllustrationLock())?.active).toBe(false);

    const pixel = await page.evaluate(async () => {
      const snapshot = await window.aidraw.newDocument({ kind: 'sprite', name: 'Held pixel gesture', width: 16, height: 16 });
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'pixel') throw new Error('The AGT-07 pixel document is unavailable.');
      const sprite = document.pixelAssets[document.activeAssetId];
      if (sprite.type !== 'sprite') throw new Error('The AGT-07 sprite is unavailable.');
      const cel = Object.values(sprite.cels).find((entry) => entry.frameId === sprite.frameIds[0]);
      if (!cel) throw new Error('The AGT-07 pixel cel is unavailable.');
      return { documentId: document.id, documentRevision: document.revision, spriteId: sprite.id, celId: cel.id, celRevision: cel.revision, width: sprite.width, height: sprite.height };
    });
    await callMcpTool(credentials.url, headers, requestId++, 'session_manage', { action: 'join', name: 'AGT-07 conflict agent', documentId: pixel.documentId });
    const pixelCanvas = page.getByRole('application', { name: /Pixel-art canvas/ });
    await expect(pixelCanvas).toBeVisible();
    await page.getByTitle('Pixel-perfect pencil (B)').click();
    const pixelBounds = await pixelCanvas.boundingBox();
    if (!pixelBounds) throw new Error('The AGT-07 pixel canvas has no bounds.');
    const pixelScale = Math.max(1, Math.floor(Math.min((pixelBounds.width - 120) / pixel.width, (pixelBounds.height - 100) / pixel.height)));
    const pixelOffsetX = Math.round((pixelBounds.width - pixel.width * pixelScale) / 2);
    const pixelOffsetY = Math.round((pixelBounds.height - pixel.height * pixelScale) / 2);
    const pixelStartCell = { x: 4, y: 4 };
    const pixelEndCell = { x: 7, y: 4 };
    const pixelPoint = (cell: { x: number; y: number }) => ({
      x: pixelBounds.x + pixelOffsetX + (cell.x + 0.5) * pixelScale,
      y: pixelBounds.y + pixelOffsetY + (cell.y + 0.5) * pixelScale,
    });
    const pixelBeforeVisual = visualHash(await pixelCanvas.screenshot());
    const pixelStart = pixelPoint(pixelStartCell);
    const pixelEnd = pixelPoint(pixelEndCell);
    await page.mouse.move(pixelStart.x, pixelStart.y);
    await page.mouse.down();

    const inspectPixelLock = async () => {
      const inspected = await callMcpTool(credentials.url!, headers, requestId++, 'session_manage', { action: 'inspect', documentId: pixel.documentId });
      const workspace = inspected.workspace as { humanOccupancy?: { active?: boolean; locks?: Array<{ region?: { kind?: string; assetId?: string; x?: number; y?: number; width?: number; height?: number } }> } } | undefined;
      return workspace?.humanOccupancy;
    };
    await expect.poll(async () => {
      const occupancy = await inspectPixelLock();
      return occupancy?.locks?.some((lock) => lock.region?.kind === 'pixel' && lock.region.assetId === pixel.spriteId && lock.region.x === 0 && lock.region.y === 0 && lock.region.width === pixel.width && lock.region.height === pixel.height) === true;
    }).toBe(true);

    await page.mouse.move(pixelEnd.x, pixelEnd.y, { steps: 4 });
    await expect.poll(async () => visualHash(await pixelCanvas.screenshot())).not.toBe(pixelBeforeVisual);
    const pixelDuringVisual = visualHash(await pixelCanvas.screenshot());
    const pixelConflict = await callMcpTool(credentials.url, headers, requestId++, 'canvas_apply', {
      documentId: pixel.documentId,
      clientOperationId: 'agt07-agent-overwrite-held-pixels',
      label: 'Agent overwrites held pixels',
      operations: [{ kind: 'pixel.cel.set', spriteId: pixel.spriteId, celId: pixel.celId, changes: [{ x: 5, y: 4, index: 8 }], expectedRevision: pixel.celRevision }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect({
      status: pixelConflict.status,
      message: pixelConflict.message,
      retryable: (pixelConflict.conflict as { retryable?: boolean } | undefined)?.retryable,
    }).toEqual({ status: 'locked', message: 'A human is actively editing this object or region.', retryable: true });
    const pixelWhileHeld = await page.evaluate(async ({ documentId, spriteId, celId }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.id !== documentId || document.kind !== 'pixel') return undefined;
      const sprite = document.pixelAssets[spriteId];
      if (sprite.type !== 'sprite') return undefined;
      const cel = sprite.cels[celId];
      return { documentRevision: document.revision, celRevision: cel.revision, chunks: Object.keys(cel.chunks).length };
    }, { documentId: pixel.documentId, spriteId: pixel.spriteId, celId: pixel.celId });
    expect(pixelWhileHeld).toEqual({ documentRevision: pixel.documentRevision, celRevision: pixel.celRevision, chunks: 0 });

    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async ({ documentId, spriteId, celId }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.id !== documentId || document.kind !== 'pixel') return undefined;
      const sprite = document.pixelAssets[spriteId];
      if (sprite.type !== 'sprite') return undefined;
      const cel = sprite.cels[celId];
      return { documentRevision: document.revision, celRevision: cel.revision, changed: Object.keys(cel.chunks).length > 0, lastLabel: document.activity.at(-1)?.label };
    }, { documentId: pixel.documentId, spriteId: pixel.spriteId, celId: pixel.celId })).toEqual({ documentRevision: pixel.documentRevision + 1, celRevision: pixel.celRevision + 1, changed: true, lastLabel: 'Draw pixels' });
    expect(visualHash(await pixelCanvas.screenshot())).not.toBe(pixelBeforeVisual);
    expect(pixelDuringVisual).not.toBe(pixelBeforeVisual);
    const observedPixel = await callMcpTool(credentials.url, headers, requestId++, 'canvas_observe', { documentId: pixel.documentId });
    const observedPixelDocument = observedPixel.document as PixelDocument;
    const observedSprite = observedPixelDocument.pixelAssets[pixel.spriteId];
    if (observedSprite.type !== 'sprite') throw new Error('Authenticated observation lost the AGT-07 sprite.');
    const observedCel = observedSprite.cels[pixel.celId];
    expect([4, 5, 6, 7].map((x) => readPixel(observedCel, x, 4))).toEqual([1, 1, 1, 1]);
    expect(readPixel(observedCel, 5, 4)).not.toBe(8);
    expect((await inspectPixelLock())?.active).toBe(false);
    expect(applicationProcess?.pid).toBe(enginePid);

    await quitIsolatedEngineGracefully();
    await redactOwnedConnection(connectionPath);
    stoppedGracefully = true;
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      await quitIsolatedEngineGracefully();
      await redactOwnedConnection(connectionPath).catch(() => undefined);
    }
  }
});

test('keeps background collaboration visible without stealing foreground human focus', async () => {
  const evidenceRoot = join(process.cwd(), 'test-results', 'retained');
  await mkdir(evidenceRoot, { recursive: true });
  const isolatedProfile = await mkdtemp(join(evidenceRoot, 'aidraw-e2e-background-tabs-'));
  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: [`--write-mcp-connection=${connectionPath}`] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated AGT-05 package has no engine PID.');

    const setup = await page.evaluate(async () => {
      const initial = await window.aidraw.bootstrap();
      const initialDocumentId = initial.activeDocumentId;
      if (!initialDocumentId) throw new Error('The initial AGT-05 document is unavailable.');
      const backgroundSnapshot = await window.aidraw.newDocument({ kind: 'illustration', name: 'AGT-05 Background board', width: 1_200, height: 900, background: '#fffaf4' });
      const background = backgroundSnapshot.activeDocument;
      if (!background || background.kind !== 'illustration') throw new Error('The AGT-05 background document is unavailable.');
      const backgroundLayer = Object.values(background.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!backgroundLayer || backgroundLayer.type !== 'vector') throw new Error('The AGT-05 background vector layer is unavailable.');
      const foregroundSnapshot = await window.aidraw.newDocument({ kind: 'illustration', name: 'AGT-05 Foreground board', width: 1_200, height: 900, background: '#f6fbff' });
      const foreground = foregroundSnapshot.activeDocument;
      if (!foreground || foreground.kind !== 'illustration') throw new Error('The AGT-05 foreground document is unavailable.');
      const closed = await window.aidraw.closeDocument(initialDocumentId, true);
      if (!closed.closed) throw new Error('The isolated initial document could not be discarded.');
      const current = await window.aidraw.bootstrap();
      if (current.activeDocumentId !== foreground.id || current.documents.length !== 2) throw new Error('The AGT-05 two-document workspace identity is invalid.');
      return {
        background: {
          documentId: background.id,
          revision: background.revision,
          layerId: backgroundLayer.id,
          objectIds: Object.keys(background.objects),
        },
        foreground: {
          documentId: foreground.id,
          revision: foreground.revision,
          artboard: foreground.artboard,
          objectIds: Object.keys(foreground.objects),
        },
      };
    });
    const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
    if (!credentials.url || !credentials.token) throw new Error('The isolated AGT-05 MCP endpoint is unavailable.');
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'agt05-background-collaborator', {
      name: 'Background collaborator',
      color: '#4169e1',
      documentId: setup.background.documentId,
    });

    const timestamp = new Date().toISOString();
    const backgroundPoints = Array.from({ length: 600 }, (_, index) => ({
      x: 180 + index * (840 / 599),
      y: 250 + Math.sin(index / 20) * 70,
      pressure: 0.6,
    }));
    const agentRequest = callMcpTool(credentials.url, client.headers, 3, 'canvas_apply', {
      documentId: setup.background.documentId,
      clientOperationId: 'agt05-background-stroke',
      label: 'AGT-05 background collaboration',
      operations: [{
        kind: 'illustration.object.add',
        object: {
          id: 'agt05-background-stroke',
          revision: 0,
          name: 'AGT-05 background stroke',
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: client.actor.id,
          layerId: setup.background.layerId,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'normal',
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
          type: 'vector-stroke',
          points: backgroundPoints,
          brush: { size: 24, thinning: 0.45, smoothing: 0.55, streamline: 0.45, simulatePressure: false, color: '#4169e1' },
        },
      }],
      playback: { mode: 'animated', speed: 0.25 },
    });
    let agentSettled = false;
    void agentRequest.then(() => { agentSettled = true; }, () => { agentSettled = true; });

    const backgroundTab = page.locator('.document-tab[title="AGT-05 Background board"]');
    const foregroundTab = page.locator('.document-tab[title="AGT-05 Foreground board"]');
    const activeBadge = backgroundTab.locator('.tab-activity-badge');
    await expect(foregroundTab).toHaveAttribute('aria-selected', 'true');
    await expect(backgroundTab).toHaveAttribute('aria-selected', 'false');
    await expect(activeBadge).toHaveAttribute('data-activity-state', 'active');
    await expect(activeBadge).toHaveAttribute('data-actor-id', client.actor.id);
    await expect(activeBadge).toHaveAttribute('data-cursor-tool', 'pen');
    await expect(activeBadge).toHaveAttribute('aria-label', /Background collaborator is working in AGT-05 Background board · pen at/);
    expect(await activeBadge.evaluate((entry) => getComputedStyle(entry).getPropertyValue('--actor').trim().toLowerCase())).toBe('#4169e1');
    await backgroundTab.screenshot({ path: join(isolatedProfile, 'agt05-background-active-badge.png') });

    await expect.poll(async () => page.evaluate(async ({ backgroundDocumentId, foregroundDocumentId, actorId }) => {
      const snapshot = await window.aidraw.bootstrap();
      const tab = snapshot.documents.find((entry) => entry.id === backgroundDocumentId);
      const presence = snapshot.mcp.sessions.find((entry) => entry.actor.id === actorId);
      return snapshot.activeDocumentId === foregroundDocumentId
        && tab?.activityState === 'active'
        && tab.activityActor?.id === actorId
        && tab.activityCursor?.tool === 'pen'
        && Number.isFinite(tab.activityCursor.x)
        && presence?.documentId === backgroundDocumentId
        && presence.status === 'working'
        && presence.cursor?.tool === 'pen';
    }, { backgroundDocumentId: setup.background.documentId, foregroundDocumentId: setup.foreground.documentId, actorId: client.actor.id })).toBe(true);
    const liveSignal = await page.evaluate(async ({ backgroundDocumentId, actorId }) => {
      const snapshot = await window.aidraw.bootstrap();
      const tab = snapshot.documents.find((entry) => entry.id === backgroundDocumentId);
      const presence = snapshot.mcp.sessions.find((entry) => entry.actor.id === actorId);
      return {
        activeDocumentId: snapshot.activeDocumentId,
        tab: { state: tab?.activityState, actor: tab?.activityActor?.name, cursor: tab?.activityCursor },
        presence: presence ? { documentId: presence.documentId, status: presence.status, queueDepth: presence.queueDepth, cursor: presence.cursor } : undefined,
      };
    }, { backgroundDocumentId: setup.background.documentId, actorId: client.actor.id });

    const canvas = page.getByRole('application', { name: 'Illustration canvas for AGT-05 Foreground board' });
    await page.getByTitle('Pressure pen').click();
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error('The AGT-05 foreground canvas has no bounds.');
    const scale = Math.min((canvasBounds.width - 128) / setup.foreground.artboard.width, (canvasBounds.height - 112) / setup.foreground.artboard.height);
    const offsetX = (canvasBounds.width - setup.foreground.artboard.width * scale) / 2;
    const offsetY = (canvasBounds.height - setup.foreground.artboard.height * scale) / 2;
    const screenPoint = (x: number, y: number) => ({ x: canvasBounds.x + offsetX + x * scale, y: canvasBounds.y + offsetY + y * scale });
    const humanStart = screenPoint(250, 690);
    const humanEnd = screenPoint(940, 760);
    const humanBefore = await canvas.screenshot();
    const gestureStarted = performance.now();
    await page.mouse.move(humanStart.x, humanStart.y);
    await page.mouse.down();
    await page.mouse.move(humanEnd.x, humanEnd.y, { steps: 12 });
    const gestureInputMs = performance.now() - gestureStarted;
    expect(gestureInputMs).toBeLessThan(1_500);
    const humanHeld = await canvas.screenshot({ path: join(isolatedProfile, 'agt05-foreground-held-preview.png') });
    expect(visualHash(humanHeld)).not.toBe(visualHash(humanBefore));
    expect(agentSettled).toBe(false);
    expect(await page.evaluate(async ({ foregroundDocumentId, objectIds }) => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== foregroundDocumentId) return undefined;
      return {
        activeDocumentId: snapshot.activeDocumentId,
        revision: document.revision,
        humanObjects: Object.values(document.objects).filter((entry) => entry.createdBy === 'human' && !objectIds.includes(entry.id)).length,
      };
    }, { foregroundDocumentId: setup.foreground.documentId, objectIds: setup.foreground.objectIds })).toEqual({
      activeDocumentId: setup.foreground.documentId,
      revision: setup.foreground.revision,
      humanObjects: 0,
    });
    const backgroundWhileHeld = await callMcpTool(credentials.url, client.headers, 4, 'canvas_observe', { documentId: setup.background.documentId });
    const backgroundWhileHeldDocument = backgroundWhileHeld.document as IllustrationDocument;
    expect(backgroundWhileHeldDocument.revision).toBe(setup.background.revision);
    expect(backgroundWhileHeldDocument.objects['agt05-background-stroke']).toBeUndefined();
    await expect(foregroundTab).toHaveAttribute('aria-selected', 'true');
    await expect(activeBadge).toHaveAttribute('data-activity-state', 'active');

    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async ({ foregroundDocumentId, objectIds }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== foregroundDocumentId) return undefined;
      const human = Object.values(document.objects).find((entry) => entry.createdBy === 'human' && !objectIds.includes(entry.id));
      return human?.type === 'vector-stroke' ? { revision: document.revision, id: human.id, pointCount: human.points.length } : undefined;
    }, { foregroundDocumentId: setup.foreground.documentId, objectIds: setup.foreground.objectIds })).toMatchObject({ revision: setup.foreground.revision + 1 });
    const humanCommit = await page.evaluate(async ({ foregroundDocumentId, objectIds }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== foregroundDocumentId) return undefined;
      const human = Object.values(document.objects).find((entry) => entry.createdBy === 'human' && !objectIds.includes(entry.id));
      return human?.type === 'vector-stroke' ? { id: human.id, revision: human.revision, pointCount: human.points.length } : undefined;
    }, { foregroundDocumentId: setup.foreground.documentId, objectIds: setup.foreground.objectIds });
    expect(humanCommit?.pointCount).toBeGreaterThan(2);
    expect(agentSettled).toBe(false);
    const foregroundCommittedVisual = visualHash(await canvas.screenshot());

    await backgroundTab.click();
    await expect(backgroundTab).toHaveAttribute('aria-selected', 'true');
    const namedCursor = page.locator('.agent-cursor').filter({ hasText: client.actor.name });
    const namedCursorLabel = namedCursor.locator('span');
    await expect(namedCursorLabel).toBeVisible();
    const namedCursorSignal = await namedCursor.evaluate((entry) => {
      const bounds = entry.querySelector('span')?.getBoundingClientRect();
      return {
        name: entry.textContent?.trim(),
        actorColor: getComputedStyle(entry).getPropertyValue('--actor').trim().toLowerCase(),
        bounds: bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : undefined,
      };
    });
    expect(namedCursorSignal.name).toBe(client.actor.name);
    expect(namedCursorSignal.actorColor).toBe('#4169e1');
    expect(namedCursorSignal.bounds?.width).toBeGreaterThan(20);
    expect(namedCursorSignal.bounds?.height).toBeGreaterThan(10);
    await page.locator('.illustration-canvas-container').screenshot({ path: join(isolatedProfile, 'agt05-background-named-cursor.png') });
    expect(agentSettled).toBe(false);

    await foregroundTab.click();
    await expect(foregroundTab).toHaveAttribute('aria-selected', 'true');
    await expect(canvas).toBeVisible();
    await expect.poll(async () => visualHash(await canvas.screenshot())).toBe(foregroundCommittedVisual);
    const agentResult = await agentRequest;
    expect(agentResult).toMatchObject({ status: 'committed', revision: setup.background.revision + 1 });

    const completeBadge = backgroundTab.locator('.tab-activity-badge');
    await expect(completeBadge).toHaveAttribute('data-activity-state', 'complete');
    await expect(completeBadge).toHaveAttribute('data-actor-id', client.actor.id);
    await expect(completeBadge).toHaveAttribute('aria-label', 'Background collaborator finished work in AGT-05 Background board');
    await backgroundTab.screenshot({ path: join(isolatedProfile, 'agt05-background-complete-badge.png') });
    await expect.poll(async () => visualHash(await canvas.screenshot())).toBe(foregroundCommittedVisual);

    const observedBackground = await callMcpTool(credentials.url, client.headers, 5, 'canvas_observe', { documentId: setup.background.documentId });
    const observedForeground = await callMcpTool(credentials.url, client.headers, 6, 'canvas_observe', { documentId: setup.foreground.documentId });
    const backgroundDocument = observedBackground.document as IllustrationDocument;
    const foregroundDocument = observedForeground.document as IllustrationDocument;
    const backgroundStroke = backgroundDocument.objects['agt05-background-stroke'];
    expect(backgroundDocument.revision).toBe(setup.background.revision + 1);
    expect(backgroundStroke).toMatchObject({ type: 'vector-stroke', createdBy: client.actor.id, name: 'AGT-05 background stroke' });
    if (backgroundStroke.type !== 'vector-stroke') throw new Error('Authenticated observation lost the AGT-05 background stroke.');
    expect(backgroundStroke.points).toHaveLength(600);
    expect(backgroundStroke.brush.color).toBe('#4169e1');
    expect(foregroundDocument.revision).toBe(setup.foreground.revision + 1);
    expect(humanCommit && foregroundDocument.objects[humanCommit.id]).toMatchObject({ type: 'vector-stroke', createdBy: 'human', name: 'Pressure stroke' });
    const finalWorkspace = await page.evaluate(async ({ backgroundDocumentId, foregroundDocumentId, actorId }) => {
      const snapshot = await window.aidraw.bootstrap();
      const tab = snapshot.documents.find((entry) => entry.id === backgroundDocumentId);
      const presence = snapshot.mcp.sessions.find((entry) => entry.actor.id === actorId);
      return {
        documentCount: snapshot.documents.length,
        activeDocumentId: snapshot.activeDocumentId,
        foregroundRevision: snapshot.activeDocument?.id === foregroundDocumentId ? snapshot.activeDocument.revision : undefined,
        backgroundTab: { state: tab?.activityState, actorId: tab?.activityActor?.id, cursor: tab?.activityCursor },
        presence: presence ? { documentId: presence.documentId, status: presence.status, queueDepth: presence.queueDepth, cursor: presence.cursor } : undefined,
      };
    }, { backgroundDocumentId: setup.background.documentId, foregroundDocumentId: setup.foreground.documentId, actorId: client.actor.id });
    expect(finalWorkspace).toMatchObject({
      documentCount: 2,
      activeDocumentId: setup.foreground.documentId,
      foregroundRevision: setup.foreground.revision + 1,
      backgroundTab: { state: 'complete', actorId: client.actor.id, cursor: undefined },
      presence: { documentId: setup.background.documentId, status: 'idle', queueDepth: 0, cursor: undefined },
    });
    expect(applicationProcess?.pid).toBe(enginePid);

    await writeFile(join(isolatedProfile, 'agt05-evidence.json'), `${JSON.stringify({
      packagedExecutable,
      enginePid,
      documents: { background: setup.background.documentId, foreground: setup.foreground.documentId },
      liveSignal,
      human: { gestureInputMs, previewBeforeSha256: visualHash(humanBefore), previewHeldSha256: visualHash(humanHeld), committedCanvasSha256: foregroundCommittedVisual, commit: humanCommit },
      namedCursor: namedCursorSignal,
      agentResult: { status: agentResult.status, revision: agentResult.revision, transactionId: agentResult.transactionId },
      canonical: { backgroundRevision: backgroundDocument.revision, backgroundObjectId: backgroundStroke.id, foregroundRevision: foregroundDocument.revision, foregroundHumanObjectId: humanCommit?.id },
      finalWorkspace,
    }, null, 2)}\n`, 'utf8');

    await quitIsolatedEngineGracefully();
    await redactOwnedConnection(connectionPath);
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`AGT-05 packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('keeps four authenticated playback lanes visible and fair while a human draws', async () => {
  const evidenceRoot = join(process.cwd(), 'test-results', 'retained');
  await mkdir(evidenceRoot, { recursive: true });
  const isolatedProfile = await mkdtemp(join(evidenceRoot, 'aidraw-e2e-lanes-'));
  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: [`--write-mcp-connection=${connectionPath}`] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated AGT-06 package has no engine PID.');

    const initial = await page.evaluate(async () => {
      const snapshot = await window.aidraw.bootstrap();
      const document = snapshot.activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The AGT-06 illustration document is unavailable.');
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'vector') throw new Error('The AGT-06 vector layer is unavailable.');
      return {
        documentId: document.id,
        revision: document.revision,
        layerId: layer.id,
        artboard: document.artboard,
        objectIds: Object.keys(document.objects),
      };
    });
    const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
    if (!credentials.url || !credentials.token) throw new Error('The isolated AGT-06 MCP endpoint is unavailable.');

    const agentSpecs = [
      { suffix: 'a', name: 'Lane agent A', color: '#e0527d', y: 150 },
      { suffix: 'b', name: 'Lane agent B', color: '#2e9c91', y: 330 },
      { suffix: 'c', name: 'Lane agent C', color: '#6d5bd0', y: 510 },
      { suffix: 'd', name: 'Lane agent D', color: '#d27b2d', y: 690 },
    ];
    const clients = await Promise.all(agentSpecs.map((agent) => connectMcpTestClient(credentials.url!, credentials.token!, `agt06-${agent.suffix}`, {
      name: agent.name,
      color: agent.color,
      documentId: initial.documentId,
    })));
    expect(new Set(clients.map((client) => client.actor.id)).size).toBe(4);

    const timestamp = new Date().toISOString();
    const agentRequests = clients.map((client, index) => {
      const spec = agentSpecs[index];
      const points = Array.from({ length: 600 }, (_, pointIndex) => ({
        x: 220 + pointIndex * (1_480 / 599),
        y: spec.y + Math.sin(pointIndex / 18) * 25,
        pressure: 0.55,
      }));
      return callMcpTool(credentials.url!, client.headers, 3, 'canvas_apply', {
        documentId: initial.documentId,
        clientOperationId: `agt06-lane-${spec.suffix}`,
        label: `AGT-06 lane ${spec.suffix.toUpperCase()}`,
        operations: [{
          kind: 'illustration.object.add',
          object: {
            id: `agt06-lane-${spec.suffix}`,
            revision: 0,
            name: `AGT-06 lane ${spec.suffix.toUpperCase()}`,
            createdAt: timestamp,
            updatedAt: timestamp,
            createdBy: client.actor.id,
            layerId: initial.layerId,
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
            type: 'vector-stroke',
            points,
            brush: { size: 20, thinning: 0.45, smoothing: 0.55, streamline: 0.45, simulatePressure: false, color: spec.color },
          },
        }],
        playback: { mode: 'animated', speed: 0.25 },
      });
    });
    const agentResultsPromise = Promise.all(agentRequests);
    let agentsSettled = false;
    void agentResultsPromise.then(() => { agentsSettled = true; }, () => { agentsSettled = true; });

    const lanePanel = page.getByRole('region', { name: 'Active agent playback lanes' });
    const laneRows = lanePanel.locator('.playback-lane');
    await expect(lanePanel).toBeVisible();
    await expect(laneRows).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) await expect(laneRows.nth(index)).toBeVisible();
    const laneSnapshot = await laneRows.evaluateAll((rows) => rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      return {
        lane: Number((row as HTMLElement).dataset.playbackLane),
        name: row.querySelector('.playback-lane-agent')?.textContent ?? '',
        color: getComputedStyle(row).getPropertyValue('--actor').trim().toLocaleLowerCase(),
        label: row.getAttribute('title') ?? '',
        progress: (row.querySelector('progress') as HTMLProgressElement | null)?.value ?? -1,
        bounds: { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
      };
    }));
    expect(laneSnapshot.map((entry) => entry.lane)).toEqual([0, 1, 2, 3]);
    expect(new Set(laneSnapshot.map((entry) => entry.name))).toEqual(new Set(agentSpecs.map((entry) => entry.name)));
    expect(new Set(laneSnapshot.map((entry) => entry.color))).toEqual(new Set(agentSpecs.map((entry) => entry.color)));
    expect(new Set(laneSnapshot.map((entry) => entry.label))).toEqual(new Set(agentSpecs.map((entry) => `AGT-06 lane ${entry.suffix.toUpperCase()}`)));
    for (const lane of laneSnapshot) {
      expect(lane.bounds.width).toBeGreaterThan(150);
      expect(lane.bounds.height).toBeGreaterThan(20);
      expect(lane.progress).toBeGreaterThanOrEqual(0);
      expect(lane.progress).toBeLessThan(1);
    }
    for (let index = 1; index < laneSnapshot.length; index += 1) expect(laneSnapshot[index - 1].bounds.bottom).toBeLessThanOrEqual(laneSnapshot[index].bounds.top);
    await lanePanel.screenshot({ path: join(isolatedProfile, 'agt06-four-visible-lanes.png') });

    const progressBefore = laneSnapshot.map((entry) => entry.progress);
    await expect.poll(async () => {
      const progress = await laneRows.locator('progress').evaluateAll((entries) => entries.map((entry) => (entry as HTMLProgressElement).value));
      return progress.every((value, index) => value > progressBefore[index]);
    }, { timeout: 2_000 }).toBe(true);
    const progressAfter = await laneRows.locator('progress').evaluateAll((progress) => progress.map((entry) => (entry as HTMLProgressElement).value));
    const inspected = await callMcpTool(credentials.url, clients[0].headers, 4, 'session_manage', { action: 'inspect', documentId: initial.documentId });
    const presenceDuring = (inspected.presence as Array<{ actor: Actor; queueDepth: number; status: string }>).filter((entry) => clients.some((client) => client.actor.id === entry.actor.id));
    expect(presenceDuring).toHaveLength(4);
    expect(presenceDuring.every((entry) => entry.status === 'working' && entry.queueDepth === 0)).toBe(true);

    const canvas = page.getByRole('application', { name: /Illustration canvas/ });
    await page.getByTitle('Pressure pen').click();
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error('The AGT-06 illustration canvas has no bounds.');
    const scale = Math.min((canvasBounds.width - 128) / initial.artboard.width, (canvasBounds.height - 112) / initial.artboard.height);
    const offsetX = (canvasBounds.width - initial.artboard.width * scale) / 2;
    const offsetY = (canvasBounds.height - initial.artboard.height * scale) / 2;
    const screenPoint = (x: number, y: number) => ({ x: canvasBounds.x + offsetX + x * scale, y: canvasBounds.y + offsetY + y * scale });
    const humanStart = screenPoint(520, 860);
    const humanEnd = screenPoint(1_280, 940);
    const humanClip = {
      x: Math.floor(Math.min(humanStart.x, humanEnd.x) - 22),
      y: Math.floor(Math.min(humanStart.y, humanEnd.y) - 22),
      width: Math.ceil(Math.abs(humanEnd.x - humanStart.x) + 44),
      height: Math.ceil(Math.abs(humanEnd.y - humanStart.y) + 44),
    };
    const humanBefore = await page.screenshot({ clip: humanClip });
    const gestureStarted = performance.now();
    await page.mouse.move(humanStart.x, humanStart.y);
    await page.mouse.down();
    await page.mouse.move(humanEnd.x, humanEnd.y, { steps: 12 });
    const gestureInputMs = performance.now() - gestureStarted;
    expect(gestureInputMs).toBeLessThan(1_500);
    const humanDuring = await page.screenshot({ clip: humanClip, path: join(isolatedProfile, 'agt06-human-held-preview.png') });
    expect(visualHash(humanDuring)).not.toBe(visualHash(humanBefore));
    expect(await page.evaluate(async ({ documentId, objectIds }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== documentId) return undefined;
      return {
        revision: document.revision,
        newHumanObjects: Object.values(document.objects).filter((object) => object.createdBy === 'human' && !objectIds.includes(object.id)).map((object) => object.id),
      };
    }, initial)).toEqual({ revision: initial.revision, newHumanObjects: [] });
    await expect(laneRows).toHaveCount(4);

    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async ({ documentId, objectIds }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== documentId) return undefined;
      const object = Object.values(document.objects).find((entry) => entry.createdBy === 'human' && !objectIds.includes(entry.id));
      return object?.type === 'vector-stroke' ? { documentRevision: document.revision, name: object.name, pointCount: object.points.length, createdBy: object.createdBy } : undefined;
    }, initial)).toMatchObject({ documentRevision: initial.revision + 1, name: 'Pressure stroke', createdBy: 'human' });
    const humanCommit = await page.evaluate(async ({ documentId, objectIds }) => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration' || document.id !== documentId) return undefined;
      const object = Object.values(document.objects).find((entry) => entry.createdBy === 'human' && !objectIds.includes(entry.id));
      return object?.type === 'vector-stroke' ? { id: object.id, revision: object.revision, pointCount: object.points.length } : undefined;
    }, initial);
    expect(humanCommit).toBeDefined();
    expect(humanCommit?.pointCount).toBeGreaterThan(2);
    expect(agentsSettled).toBe(false);
    await expect(laneRows).toHaveCount(4);

    const agentResults = await agentResultsPromise;
    expect(agentResults.map((entry) => entry.status)).toEqual(['committed', 'committed', 'committed', 'committed']);
    expect(agentResults.map((entry) => Number(entry.revision)).sort((left, right) => left - right)).toEqual([
      initial.revision + 2,
      initial.revision + 3,
      initial.revision + 4,
      initial.revision + 5,
    ]);
    await expect(lanePanel).toBeHidden();

    const observed = await callMcpTool(credentials.url, clients[0].headers, 5, 'canvas_observe', { documentId: initial.documentId });
    const observedDocument = observed.document as IllustrationDocument;
    expect(observedDocument.revision).toBe(initial.revision + 5);
    for (let index = 0; index < agentSpecs.length; index += 1) {
      const spec = agentSpecs[index];
      const object = observedDocument.objects[`agt06-lane-${spec.suffix}`];
      expect(object).toMatchObject({ name: `AGT-06 lane ${spec.suffix.toUpperCase()}`, createdBy: clients[index].actor.id, type: 'vector-stroke' });
      if (object.type !== 'vector-stroke') throw new Error(`Authenticated observation lost AGT-06 lane ${spec.suffix.toUpperCase()}.`);
      expect(object.points).toHaveLength(600);
      expect(object.brush.color).toBe(spec.color);
    }
    expect(humanCommit && observedDocument.objects[humanCommit.id]).toMatchObject({ name: 'Pressure stroke', createdBy: 'human', type: 'vector-stroke' });
    const rendererCanonical = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      return document?.kind === 'illustration' ? { revision: document.revision, objectIds: Object.keys(document.objects).sort() } : undefined;
    });
    expect(rendererCanonical).toEqual({ revision: observedDocument.revision, objectIds: Object.keys(observedDocument.objects).sort() });
    const agentActivity = observedDocument.activity.filter((entry) => entry.label.startsWith('AGT-06 lane '));
    expect(new Set(agentActivity.map((entry) => entry.actor.id))).toEqual(new Set(clients.map((client) => client.actor.id)));
    expect(agentActivity.every((entry) => entry.status === 'committed')).toBe(true);
    const inspectedAfter = await callMcpTool(credentials.url, clients[0].headers, 6, 'session_manage', { action: 'inspect', documentId: initial.documentId });
    const presenceAfter = (inspectedAfter.presence as Array<{ actor: Actor; queueDepth: number; status: string }>).filter((entry) => clients.some((client) => client.actor.id === entry.actor.id));
    expect(presenceAfter).toHaveLength(4);
    expect(presenceAfter.every((entry) => entry.status === 'idle' && entry.queueDepth === 0)).toBe(true);
    expect(applicationProcess?.pid).toBe(enginePid);

    await writeFile(join(isolatedProfile, 'agt06-evidence.json'), `${JSON.stringify({
      packagedExecutable,
      enginePid,
      lanes: laneSnapshot,
      progressBefore,
      progressAfter,
      presenceDuring: presenceDuring.map((entry) => ({ actor: entry.actor.name, queueDepth: entry.queueDepth, status: entry.status })),
      human: { gestureInputMs, previewBeforeSha256: visualHash(humanBefore), previewHeldSha256: visualHash(humanDuring), commit: humanCommit },
      agentResults: agentResults.map((entry, index) => ({ actor: clients[index].actor.name, status: entry.status, revision: entry.revision, transactionId: entry.transactionId })),
      final: { revision: observedDocument.revision, objectIds: Object.keys(observedDocument.objects).sort(), agentActivity: agentActivity.map((entry) => ({ actor: entry.actor.name, label: entry.label, status: entry.status })) },
      presenceAfter: presenceAfter.map((entry) => ({ actor: entry.actor.name, queueDepth: entry.queueDepth, status: entry.status })),
    }, null, 2)}\n`, 'utf8');

    await quitIsolatedEngineGracefully();
    await redactOwnedConnection(connectionPath);
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    const invalidSandboxLaunch = /exit_code=-1073741515|0xC0000135|GPU process isn't usable/i.test(diagnostic);
    const boundaryGuidance = invalidSandboxLaunch
      ? '\nExecution-boundary check: repeat this exact packaged command through explicit unsandboxed shell escalation before diagnosing Windows or AIDraw runtime state.'
      : '';
    regressionFailure = new Error(`AGT-06 packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}${boundaryGuidance}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('creates a custom-sized sprite and resizes its canvas with undo', async () => {
  const page = await launch();
  await page.getByTitle('New document').click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByRole('radio', { name: /Pixel Sprite/ }).click();
  await dialog.getByLabel('Document name').fill('Custom sprite');
  await dialog.getByLabel('Document width').fill('40');
  await dialog.getByLabel('Document height').fill('48');
  await dialog.getByRole('button', { name: 'Create Pixel Sprite' }).click();

  await expect.poll(async () => {
    const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!document || document.kind !== 'pixel') return undefined;
    const sprite = document.pixelAssets[document.activeAssetId];
    return sprite.type === 'sprite' ? [document.name, sprite.width, sprite.height] : undefined;
  }).toEqual(['Custom sprite', 40, 48]);

  await page.getByLabel('Sprite canvas width').fill('32');
  await page.getByLabel('Sprite canvas height').fill('36');
  await page.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect.poll(async () => {
    const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!document || document.kind !== 'pixel') return undefined;
    const sprite = document.pixelAssets[document.activeAssetId];
    return sprite.type === 'sprite' ? [sprite.width, sprite.height] : undefined;
  }).toEqual([32, 36]);

  await page.getByTitle('Undo my action (Ctrl+Z)').click();
  await expect.poll(async () => {
    const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!document || document.kind !== 'pixel') return undefined;
    const sprite = document.pixelAssets[document.activeAssetId];
    return sprite.type === 'sprite' ? [sprite.width, sprite.height] : undefined;
  }).toEqual([40, 48]);
});

test('configures an isometric sparse tilemap in the New Document dialog', async () => {
  const page = await launch();
  await page.getByTitle('New document').click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByRole('radio', { name: /Pixel Tilemap/ }).click();
  await dialog.getByLabel('Document name').fill('Isometric world');
  await dialog.getByLabel('Document width').fill('96');
  await dialog.getByLabel('Document height').fill('48');
  await dialog.getByLabel('Tilemap orientation').selectOption('isometric');
  await dialog.getByLabel('Tile width').fill('32');
  await dialog.getByLabel('Tile height').fill('16');
  await dialog.getByText('Sparse infinite map', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Create Pixel Tilemap' }).click();

  await expect.poll(async () => {
    const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!document || document.kind !== 'pixel') return undefined;
    const map = document.pixelAssets[document.activeAssetId];
    return map.type === 'tilemap' ? [document.name, map.width, map.height, map.orientation, map.infinite, map.tileWidth, map.tileHeight] : undefined;
  }).toEqual(['Isometric world', 96, 48, 'isometric', true, 32, 16]);
});

test('lands the pixel pencil on the visible cell at low zoom', async () => {
  const page = await launch();
  await page.getByTitle('New document').click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByRole('radio', { name: /Pixel Sprite/ }).click();
  await dialog.getByRole('button', { name: 'Create Pixel Sprite' }).click();
  const canvas = page.getByRole('application', { name: /Pixel-art canvas/ });
  const timeline = page.locator('.timeline');
  await expect(canvas).toBeVisible();
  await expect(timeline).toBeVisible();

  const initialCanvasBounds = await canvas.boundingBox();
  const timelineBounds = await timeline.boundingBox();
  if (!initialCanvasBounds || !timelineBounds) throw new Error('Pixel canvas layout is unavailable.');
  expect(Math.abs(initialCanvasBounds.y + initialCanvasBounds.height - timelineBounds.y)).toBeLessThanOrEqual(1);

  await page.locator('.zoom-control button').first().click();
  await expect(page.locator('.zoom-control output')).toHaveText('50%');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Pixel canvas has no bounds.');
  const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
  if (!document || document.kind !== 'pixel') throw new Error('Expected a pixel document.');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected an active sprite.');

  const fit = Math.max(1, Math.floor(Math.min((bounds.width - 120) / sprite.width, (bounds.height - 100) / sprite.height)));
  const scale = Math.max(1, Math.round(fit * 0.5));
  const offsetX = Math.round((bounds.width - sprite.width * scale) / 2);
  const offsetY = Math.round((bounds.height - sprite.height * scale) / 2);
  const target = { x: 0, y: 63 };
  await page.getByTitle('Pixel-perfect pencil').click();
  const targetX = bounds.x + offsetX + (target.x + 0.5) * scale;
  const targetY = bounds.y + offsetY + (target.y + 0.5) * scale;
  await page.mouse.move(targetX, targetY);
  await expect(page.getByText('0, 63', { exact: true })).toBeVisible();
  await page.mouse.click(targetX, targetY);

  await expect.poll(async () => {
    const current = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!current || current.kind !== 'pixel') return -1;
    const currentSprite = current.pixelAssets[current.activeAssetId];
    if (currentSprite.type !== 'sprite') return -1;
    const cel = Object.values(currentSprite.cels).find((entry) => entry.frameId === currentSprite.frameIds[0]);
    return cel ? readPixel(cel, target.x, target.y) : -1;
  }).toBe(1);
});

test('isolates rapid tab state and restores an exact mixed workspace after graceful restart', async () => {
  const page = await launch();
  await page.getByTitle('New document').click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByRole('radio', { name: /Pixel Sprite/ }).click();
  await dialog.getByLabel('Document name').fill('Discarded forever');
  await dialog.getByRole('button', { name: 'Create Pixel Sprite' }).click();

  const canvas = page.getByRole('application', { name: /Pixel-art canvas/ });
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Pixel canvas has no bounds.');
  await page.getByTitle('Pixel-perfect pencil').click();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.getByLabel('Unsaved changes').last()).toBeVisible();

  const discardedId = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocumentId);
  if (!discardedId) throw new Error('Discard test document is not active.');
  expect(await page.evaluate((documentId) => window.aidraw.closeDocument(documentId, true), discardedId)).toEqual({ closed: true });
  await expect.poll(async () => (await page.evaluate(async () => window.aidraw.bootstrap())).documents.map(({ id }) => id)).not.toContain(discardedId);

  const setup = await page.evaluate(async () => {
    const original = (await window.aidraw.bootstrap()).activeDocument;
    if (!original) throw new Error('The original clean document is unavailable.');
    const create = async (options: { kind: 'illustration' | 'sprite' | 'tilemap' | 'project'; name: string }, dirty: boolean) => {
      const snapshot = await window.aidraw.newDocument(options);
      const document = snapshot.activeDocument;
      if (!document) throw new Error(`Could not create ${options.name}.`);
      let revision = document.revision;
      if (dirty) {
        const response = await window.aidraw.applyTransaction({
          id: `tx-${document.id}`, clientOperationId: `op-${document.id}`, documentId: document.id,
          actor: { id: 'human', kind: 'human', name: 'Human', color: '#27213c' }, label: `Edit ${options.name}`, createdAt: new Date().toISOString(),
          operations: [{ kind: 'document.rename', name: `${options.name} · edited` }], playback: { mode: 'instant', speed: 1 },
        });
        if (response.status !== 'committed') throw new Error(`Could not dirty ${options.name}.`);
        if (typeof response.revision !== 'number') throw new Error(`Missing revision for ${options.name}.`);
        revision = response.revision;
      }
      return { id: document.id, name: dirty ? `${options.name} · edited` : options.name, dirty, revision };
    };
    const source = await create({ kind: 'illustration', name: 'Transient path source' }, false);
    const target = await create({ kind: 'illustration', name: 'Clean restart target' }, false);
    const dirtyIllustration = await create({ kind: 'illustration', name: 'Dirty illustration' }, true);
    const cleanSprite = await create({ kind: 'sprite', name: 'Clean sprite' }, false);
    const dirtySprite = await create({ kind: 'sprite', name: 'Dirty sprite' }, true);
    const cleanTilemap = await create({ kind: 'tilemap', name: 'Clean tilemap' }, false);
    const dirtyProject = await create({ kind: 'project', name: 'Dirty project' }, true);
    await window.aidraw.activateDocument(target.id);
    return {
      source, target, dirtyIllustration, cleanSprite, dirtySprite,
      expected: [
        { id: original.id, dirty: false }, source, target, dirtyIllustration, cleanSprite, dirtySprite, cleanTilemap, dirtyProject,
      ].map(({ id, dirty }) => ({ id, dirty })),
    };
  });

  const targetTab = page.locator(`.document-tab[title="${setup.target.name}"]`);
  await expect(targetTab).toHaveAttribute('aria-selected', 'true');
  const targetCanvas = page.getByRole('application', { name: `Illustration canvas for ${setup.target.name}` });
  await expect(targetCanvas).toBeVisible();
  const cleanCanvasData = await targetCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());

  await page.locator(`.document-tab[title="${setup.source.name}"]`).click();
  const sourceCanvas = page.getByRole('application', { name: `Illustration canvas for ${setup.source.name}` });
  await expect(sourceCanvas).toBeVisible();
  await page.getByTitle('Bézier path').click();
  const sourceBounds = await sourceCanvas.boundingBox();
  if (!sourceBounds) throw new Error('The transient-path canvas has no bounds.');
  await page.mouse.click(sourceBounds.x + sourceBounds.width * 0.38, sourceBounds.y + sourceBounds.height * 0.42);
  await page.mouse.click(sourceBounds.x + sourceBounds.width * 0.62, sourceBounds.y + sourceBounds.height * 0.58);
  await expect.poll(() => sourceCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(cleanCanvasData);

  await page.evaluate(({ sourceName, middleName, targetName }) => {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.document-tab')];
    for (const name of [sourceName, middleName, targetName]) {
      const tab = tabs.find((candidate) => candidate.title === name);
      if (!tab) throw new Error(`Missing rapid-switch tab ${name}.`);
      tab.click();
    }
  }, { sourceName: setup.source.name, middleName: setup.dirtyIllustration.name, targetName: setup.target.name });
  await expect.poll(async () => (await page.evaluate(async () => window.aidraw.bootstrap())).activeDocumentId).toBe(setup.target.id);
  await expect(targetTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveTitle(`${setup.target.name} — AIDraw`);
  const isolatedCanvas = page.getByRole('application', { name: `Illustration canvas for ${setup.target.name}` });
  await expect.poll(() => isolatedCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(cleanCanvasData);

  const credentials = await page.evaluate(async () => window.aidraw.getMcpCredentials());
  if (!credentials.url) throw new Error('The tab-identity MCP endpoint is unavailable.');
  const identityClient = await connectMcpTestClient(credentials.url, credentials.token, 'tab-identity-e2e', { name: 'Tab identity observer', color: '#4f73d9', documentId: setup.target.id });
  let identityRequestId = 3;
  await expect.poll(async () => {
    const listed = await callMcpTool(credentials.url!, identityClient.headers, identityRequestId++, 'document_manage', { action: 'list' });
    const inspected = await callMcpTool(credentials.url!, identityClient.headers, identityRequestId++, 'session_manage', { action: 'inspect' });
    const workspace = inspected.workspace as { activeDocumentId?: string; editorAdvisory?: { documentId?: string; selectedEntityIds?: string[] } };
    return { listed: listed.activeDocumentId, active: workspace.activeDocumentId, advisory: workspace.editorAdvisory?.documentId, selected: workspace.editorAdvisory?.selectedEntityIds };
  }).toEqual({ listed: setup.target.id, active: setup.target.id, advisory: setup.target.id, selected: [] });

  await page.locator(`.document-tab[title="${setup.cleanSprite.name}"]`).click();
  const cleanPixelCanvas = page.getByRole('application', { name: `Pixel-art canvas for ${setup.cleanSprite.name}` });
  await expect(cleanPixelCanvas).toBeVisible();
  const cleanPixelCanvasData = await cleanPixelCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.locator(`.document-tab[title="${setup.dirtySprite.name}"]`).click();
  const dirtyPixelCanvas = page.getByRole('application', { name: `Pixel-art canvas for ${setup.dirtySprite.name}` });
  await expect(dirtyPixelCanvas).toBeVisible();
  await page.getByTitle('Pixel-perfect pencil').click();
  const dirtyPixelBounds = await dirtyPixelCanvas.boundingBox();
  if (!dirtyPixelBounds) throw new Error('The transient pixel canvas has no bounds.');
  await page.mouse.move(dirtyPixelBounds.x + dirtyPixelBounds.width * 0.44, dirtyPixelBounds.y + dirtyPixelBounds.height * 0.44);
  await page.mouse.down();
  await page.mouse.move(dirtyPixelBounds.x + dirtyPixelBounds.width * 0.56, dirtyPixelBounds.y + dirtyPixelBounds.height * 0.56, { steps: 4 });
  await expect.poll(() => dirtyPixelCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(cleanPixelCanvasData);
  await page.evaluate((name) => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('.document-tab')].find((candidate) => candidate.title === name);
    if (!tab) throw new Error(`Missing pixel isolation tab ${name}.`);
    tab.click();
  }, setup.cleanSprite.name);
  await page.mouse.up();
  await expect.poll(async () => (await page.evaluate(async () => window.aidraw.bootstrap())).activeDocumentId).toBe(setup.cleanSprite.id);
  await expect.poll(() => page.getByRole('application', { name: `Pixel-art canvas for ${setup.cleanSprite.name}` }).evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(cleanPixelCanvasData);
  await expect.poll(async () => {
    const snapshot = await page.evaluate(async () => window.aidraw.bootstrap());
    return snapshot.documents.find((document) => document.id === setup.dirtySprite.id)?.revision;
  }).toBe(setup.dirtySprite.revision);
  await expect.poll(async () => {
    const inspected = await callMcpTool(credentials.url!, identityClient.headers, identityRequestId++, 'session_manage', { action: 'inspect', documentId: setup.dirtySprite.id });
    return (inspected.workspace as { humanOccupancy?: { active?: boolean } }).humanOccupancy?.active;
  }).toBe(false);

  await page.locator(`.document-tab[title="${setup.dirtySprite.name}"]`).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const selectionCanvas = page.getByRole('application', { name: `Pixel-art canvas for ${setup.dirtySprite.name}` });
  const selectionBounds = await selectionCanvas.boundingBox();
  if (!selectionBounds) throw new Error('The pixel selection canvas has no bounds.');
  await page.mouse.move(selectionBounds.x + selectionBounds.width * 0.43, selectionBounds.y + selectionBounds.height * 0.43);
  await page.mouse.down();
  await page.mouse.move(selectionBounds.x + selectionBounds.width * 0.57, selectionBounds.y + selectionBounds.height * 0.57, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => selectionCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(cleanPixelCanvasData);
  await page.locator(`.document-tab[title="${setup.cleanSprite.name}"]`).click();
  await expect.poll(() => page.getByRole('application', { name: `Pixel-art canvas for ${setup.cleanSprite.name}` }).evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(cleanPixelCanvasData);

  await page.locator(`.document-tab[title="${setup.target.name}"]`).click();
  await expect.poll(async () => (await page.evaluate(async () => window.aidraw.bootstrap())).activeDocumentId).toBe(setup.target.id);
  await expect(targetTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveTitle(`${setup.target.name} — AIDraw`);

  const persistentProfile = profilePath!;
  await signalExistingEngine('--quit-engine');
  await expect.poll(() => applicationProcess?.exitCode, { timeout: 8_000 }).not.toBe(null);
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
  browser = undefined;
  applicationProcess = undefined;

  const restarted = await launch(persistentProfile);
  const restored = await restarted.evaluate(async () => window.aidraw.bootstrap());
  expect(restored.documents.map(({ id }) => id)).toEqual(setup.expected.map(({ id }) => id));
  expect(restored.documents.map(({ id, dirty }) => ({ id, dirty }))).toEqual(setup.expected);
  expect(restored.documents.every((document) => document.filePath === undefined)).toBe(true);
  expect(restored.activeDocumentId).toBe(setup.target.id);
  expect(restored.activeDocument?.id).toBe(setup.target.id);
  await expect(restarted.locator(`.document-tab[title="${setup.target.name}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(restarted).toHaveTitle(`${setup.target.name} — AIDraw`);
  const restartedCanvas = restarted.getByRole('application', { name: `Illustration canvas for ${setup.target.name}` });
  await expect.poll(() => restartedCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(cleanCanvasData);
  const restartedCredentials = await restarted.evaluate(async () => window.aidraw.getMcpCredentials());
  if (!restartedCredentials.url) throw new Error('The restarted identity MCP endpoint is unavailable.');
  const restartClient = await connectMcpTestClient(restartedCredentials.url, restartedCredentials.token, 'restart-identity-e2e', { name: 'Restart identity observer', color: '#2f9d8f', documentId: setup.target.id });
  const restartInspect = await callMcpTool(restartedCredentials.url, restartClient.headers, 3, 'session_manage', { action: 'inspect' });
  expect(restartInspect).toMatchObject({ workspace: { activeDocumentId: setup.target.id, editorAdvisory: { attached: true, documentId: setup.target.id, selectedEntityIds: [] } } });
  await expect.poll(async () => (await restarted.evaluate(async () => window.aidraw.bootstrap())).documents.map(({ id }) => id)).not.toContain(discardedId);
  await expect(restarted.getByText('Discarded forever', { exact: true })).toHaveCount(0);
});

test('keeps human drawing responsive while an MCP agent plays visibly', async () => {
  const page = await launch(); const state = await page.evaluate(async () => ({ snapshot: await window.aidraw.bootstrap(), credentials: await window.aidraw.getMcpCredentials() })); const document = state.snapshot.activeDocument; if (!document || document.kind !== 'illustration' || !state.credentials.url) throw new Error('Illustration MCP setup unavailable'); const vectorLayer = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vectorLayer) throw new Error('Vector layer unavailable');
  const init = await fetch(state.credentials.url, { method: 'POST', headers: { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'Playwright agent', version: '1.0' } } }) }); const sessionId = init.headers.get('mcp-session-id'); if (!sessionId) throw new Error('MCP session missing'); const headers = { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId }; await fetch(state.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); await fetch(state.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Playwright agent', color: '#2fa7a0', documentId: document.id } } }) });
  const timestamp = new Date().toISOString(); const points = Array.from({ length: 120 }, (_, index) => ({ x: 180 + index * 4, y: 230 + Math.sin(index / 8) * 70, pressure: 0.5 })); const agentRequest = fetch(state.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canvas_apply', arguments: { documentId: document.id, clientOperationId: 'playwright-agent-stroke', label: 'Agent ribbon', operations: [{ kind: 'illustration.object.add', object: { id: 'playwright-ribbon', revision: 0, name: 'Agent ribbon', createdAt: timestamp, updatedAt: timestamp, createdBy: 'playwright-agent', layerId: vectorLayer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 }, type: 'vector-stroke', points, brush: { size: 18, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false, color: '#2fa7a0' } } }], playback: { mode: 'animated', speed: 1 } } } }) });
  await page.waitForTimeout(150); const canvas = page.getByRole('application', { name: /Illustration canvas/ }); await page.getByTitle('Pressure pen').click(); const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Illustration canvas has no bounds'); await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 0.58, bounds.y + bounds.height * 0.54, { steps: 8 }); await page.mouse.up(); await page.getByRole('button', { name: 'Stop All Agents' }).click(); expect((await agentRequest).ok).toBe(true); await page.getByTitle('Activity').click(); const activity = page.locator('.activity-row').filter({ hasText: 'Agent ribbon' }).first(); await expect(activity).toBeVisible(); await expect(activity.locator('.activity-state')).toHaveText('partial'); await expect(page.getByText(/Playwright agent/).last()).toBeVisible(); const undoAgent = page.getByTitle('Undo the latest transaction by Playwright agent'); await undoAgent.click(); await expect.poll(async () => page.evaluate(async () => { const document = (await window.aidraw.bootstrap()).activeDocument; return document?.kind === 'illustration' && Boolean(document.objects['playwright-ribbon']); })).toBe(false); const redoAgent = page.getByTitle('Redo the latest undone transaction by Playwright agent'); await redoAgent.click(); await expect.poll(async () => page.evaluate(async () => { const document = (await window.aidraw.bootstrap()).activeDocument; return document?.kind === 'illustration' && Boolean(document.objects['playwright-ribbon']); })).toBe(true); const replay = page.getByTitle('Replay durable agent trace').first(); await replay.click(); await expect(replay).toHaveText(/Replaying/); await expect(replay).toHaveText('Replay', { timeout: 4_000 });
});

test('shows structured file approval and applies session trust without bypassing overwrites', async () => {
  const page = await launch();
  const state = await page.evaluate(async () => ({ snapshot: await window.aidraw.bootstrap(), credentials: await window.aidraw.getMcpCredentials() }));
  if (!state.credentials.url || !state.snapshot.activeDocumentId || !profilePath) throw new Error('MCP approval setup unavailable.');
  const initialize = await fetch(state.credentials.url, { method: 'POST', headers: { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'approval-e2e', version: '1.0' } } }) });
  const sessionId = initialize.headers.get('mcp-session-id'); if (!sessionId) throw new Error('Approval MCP session missing.');
  const headers = { authorization: `Bearer ${state.credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(state.credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await callMcpTool(state.credentials.url, headers, 2, 'session_manage', { action: 'join', name: 'Approval agent', documentId: state.snapshot.activeDocumentId });
  const outputFolder = join(profilePath, 'approved-output');
  const firstPath = join(outputFolder, 'first.png');
  const first = await callMcpTool(state.credentials.url, headers, 3, 'document_export', { documentId: state.snapshot.activeDocumentId, path: firstPath, format: 'png', scale: 1 });
  expect(first.status).toBe('waiting-for-user');

  await page.getByTitle('Activity').click();
  const approval = page.locator('.approval-card').filter({ hasText: 'Export document' });
  await expect(approval).toBeVisible();
  await expect(approval.locator('.approval-target')).toContainText('first.png');
  await expect(approval.locator('.approval-review')).toContainText('Presentation scale');
  await expect(approval.getByRole('button', { name: 'Deny' })).toBeVisible();
  await expect(approval.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(approval.getByRole('button', { name: 'Trust this session' })).toBeVisible();
  await expect(approval.getByRole('button', { name: 'Always trust folder' })).toBeVisible();
  await approval.getByRole('button', { name: 'Trust this session' }).click();
  await expect.poll(async () => await readFile(firstPath).then((bytes) => bytes.byteLength, () => 0)).toBeGreaterThan(0);

  const secondPath = join(outputFolder, 'second.png');
  const second = await callMcpTool(state.credentials.url, headers, 4, 'document_export', { documentId: state.snapshot.activeDocumentId, path: secondPath, format: 'png', scale: 1 });
  expect(second).toMatchObject({ status: 'queued', trust: 'folder' });
  const completed = await callMcpTool(state.credentials.url, headers, 5, 'job_manage', { action: 'wait', jobId: second.jobId, timeoutMs: 10_000 });
  expect(completed.status).toBe('completed');

  const overwrite = await callMcpTool(state.credentials.url, headers, 6, 'document_export', { documentId: state.snapshot.activeDocumentId, path: firstPath, format: 'png', scale: 1 });
  expect(overwrite.status).toBe('waiting-for-user');
  const overwriteApproval = page.locator('.approval-card').filter({ hasText: 'Export document' });
  await expect(overwriteApproval.locator('.approval-review')).toContainText('Will overwrite');
  await expect(overwriteApproval.locator('.approval-review')).toContainText('first.png');
  await overwriteApproval.getByRole('button', { name: 'Deny' }).click();
});

test('QA-06 denies and allow-once saves exact paths without granting file trust', async () => {
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith('aidraw-e2e-qa06-file-approval-')) {
      throw new Error('AIDRAW_E2E_QA06_PROFILE must name a new aidraw-e2e-qa06-file-approval-* directory inside test-results/retained.');
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact QA-06 profile already exists: ${isolatedProfile}`);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, 'aidraw-e2e-qa06-file-approval-'));

  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const targetRoot = join(isolatedProfile, 'approval-targets');
  const deniedPath = join(targetRoot, 'denied-agent-save.aidraw');
  const allowedPath = join(targetRoot, 'allowed-once-agent-save.aidraw');
  const trustProbePath = join(targetRoot, 'untrusted-follow-up.aidraw');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const evidencePath = join(isolatedProfile, 'qa06-evidence.json');
  const denialScreenshotPath = join(isolatedProfile, 'qa06-denial-approval.png');
  const allowOnceScreenshotPath = join(isolatedProfile, 'qa06-allow-once-approval.png');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: [`--write-mcp-connection=${connectionPath}`] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 package has no engine PID.');
    await mkdir(targetRoot, { recursive: true });
    expect(await readdir(targetRoot)).toEqual([]);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);

    const initial = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The QA-06 illustration document is unavailable.');
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'vector') throw new Error('The QA-06 vector layer is unavailable.');
      return { documentId: document.id, layerId: layer.id, revision: document.revision };
    });
    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-file-approval', {
      name: 'QA-06 file approval agent',
      color: '#b64f75',
      documentId: initial.documentId,
    });

    const timestamp = new Date().toISOString();
    const seeded = await callMcpTool(credentials.url, client.headers, 3, 'canvas_apply', {
      documentId: initial.documentId,
      clientOperationId: 'qa06-seed-artwork',
      label: 'QA-06 seed artwork',
      playback: { mode: 'instant', speed: 1 },
      operations: [{
        kind: 'illustration.object.add',
        object: {
          id: 'qa06-seed-object',
          revision: 0,
          name: 'QA-06 seed object',
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: client.actor.id,
          layerId: initial.layerId,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'normal',
          transform: { x: 96, y: 84, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
          type: 'shape',
          shape: 'rectangle',
          width: 180,
          height: 120,
          fill: { kind: 'solid', color: '#b64f75' },
          stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
        },
      }],
    });
    expect(seeded).toMatchObject({ status: 'committed', revision: initial.revision + 1 });

    const beforeObserved = await callMcpTool(credentials.url, client.headers, 4, 'canvas_observe', { documentId: initial.documentId });
    const beforeDocument = beforeObserved.document as IllustrationDocument;
    expect(beforeDocument).toMatchObject({ id: initial.documentId, revision: initial.revision + 1, dirty: true });
    expect(beforeDocument.filePath).toBeUndefined();
    expect(beforeDocument.objects['qa06-seed-object']).toMatchObject({ createdBy: client.actor.id, name: 'QA-06 seed object' });
    const rendererBefore = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    expect(rendererBefore).toEqual(beforeDocument);
    const beforeSha256 = visualHash(Buffer.from(JSON.stringify(beforeDocument), 'utf8'));

    const assertVisibleApproval = async (targetPath: string) => {
      await page.getByTitle('Activity').click();
      const card = page.locator('.approval-card').filter({ hasText: 'Save AIDraw document as' });
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-heading small')).toHaveText('QA-06 file approval agent requests approval');
      await expect(card.locator('.approval-target > span')).toHaveText('Exact path');
      await expect(card.locator('.approval-target code')).toHaveText(targetPath);
      expect((await card.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual([
        'Deny',
        'Allow once',
        'Trust this session',
        'Always trust folder',
      ]);
      return card;
    };

    const denied = await callMcpTool(credentials.url, client.headers, 5, 'document_manage', {
      action: 'save-as',
      documentId: initial.documentId,
      path: deniedPath,
    });
    expect(denied).toMatchObject({ status: 'waiting-for-user' });
    const deniedJobId = String(denied.jobId);
    const deniedCard = await assertVisibleApproval(deniedPath);
    const deniedActor = await page.evaluate(async (jobId) => {
      const job = (await window.aidraw.bootstrap()).jobs.find((entry) => entry.id === jobId);
      return job ? { actorId: job.actor.id, actorName: job.actor.name, actorColor: job.actor.color, choices: job.approval?.options } : undefined;
    }, deniedJobId);
    expect(deniedActor).toEqual({ actorId: client.actor.id, actorName: client.actor.name, actorColor: client.actor.color, choices: ['allow-once', 'allow-session', 'allow-always', 'deny'] });
    await deniedCard.screenshot({ path: denialScreenshotPath });
    await deniedCard.getByRole('button', { name: 'Deny' }).click();
    await expect(deniedCard).toHaveCount(0);
    const deniedResult = await callMcpTool(credentials.url, client.headers, 6, 'job_manage', { action: 'wait', jobId: deniedJobId, timeoutMs: 5_000 });
    expect(deniedResult).toMatchObject({ id: deniedJobId, kind: 'save', status: 'cancelled', message: 'Denied in AIDraw.' });
    expect(await access(deniedPath).then(() => true, () => false)).toBe(false);
    expect(await readdir(targetRoot)).toEqual([]);

    const afterDenialObserved = await callMcpTool(credentials.url, client.headers, 7, 'canvas_observe', { documentId: initial.documentId });
    expect(afterDenialObserved.document).toEqual(beforeDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(beforeDocument);
    expect(visualHash(Buffer.from(JSON.stringify(afterDenialObserved.document), 'utf8'))).toBe(beforeSha256);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);

    const allowed = await callMcpTool(credentials.url, client.headers, 8, 'document_manage', {
      action: 'save-as',
      documentId: initial.documentId,
      path: allowedPath,
    });
    expect(allowed).toMatchObject({ status: 'waiting-for-user' });
    const allowedJobId = String(allowed.jobId);
    expect(allowedJobId).not.toBe(deniedJobId);
    const allowedCard = await assertVisibleApproval(allowedPath);
    await allowedCard.screenshot({ path: allowOnceScreenshotPath });
    await allowedCard.getByRole('button', { name: 'Allow once' }).click();
    await expect(allowedCard).toHaveCount(0);
    const allowedResult = await callMcpTool(credentials.url, client.headers, 9, 'job_manage', { action: 'wait', jobId: allowedJobId, timeoutMs: 10_000 });
    expect(allowedResult).toMatchObject({ id: allowedJobId, kind: 'save', status: 'completed' });
    expect((await readFile(allowedPath)).byteLength).toBeGreaterThan(0);
    expect(await access(deniedPath).then(() => true, () => false)).toBe(false);
    expect(await readdir(targetRoot)).toEqual(['allowed-once-agent-save.aidraw']);

    const afterAllowObserved = await callMcpTool(credentials.url, client.headers, 10, 'canvas_observe', { documentId: initial.documentId });
    const afterAllowDocument = afterAllowObserved.document as IllustrationDocument;
    expect(afterAllowDocument).toMatchObject({ id: initial.documentId, revision: beforeDocument.revision, dirty: false, filePath: allowedPath });
    expect(afterAllowDocument.objects['qa06-seed-object']).toEqual(beforeDocument.objects['qa06-seed-object']);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(afterAllowDocument);

    const trustProbe = await callMcpTool(credentials.url, client.headers, 11, 'document_manage', {
      action: 'save-as',
      documentId: initial.documentId,
      path: trustProbePath,
    });
    expect(trustProbe).toMatchObject({ status: 'waiting-for-user' });
    const trustProbeJobId = String(trustProbe.jobId);
    const trustProbeCard = await assertVisibleApproval(trustProbePath);
    await trustProbeCard.getByRole('button', { name: 'Deny' }).click();
    const trustProbeResult = await callMcpTool(credentials.url, client.headers, 12, 'job_manage', { action: 'wait', jobId: trustProbeJobId, timeoutMs: 5_000 });
    expect(trustProbeResult).toMatchObject({ id: trustProbeJobId, kind: 'save', status: 'cancelled' });
    expect(await access(trustProbePath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await readdir(targetRoot)).toEqual(['allowed-once-agent-save.aidraw']);

    const finalJobs = await callMcpTool(credentials.url, client.headers, 13, 'job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<{ id: string; kind: string; status: string }>;
    expect(jobSummaries.map((job) => ({ id: job.id, kind: job.kind, status: job.status }))).toEqual([
      { id: deniedJobId, kind: 'save', status: 'cancelled' },
      { id: allowedJobId, kind: 'save', status: 'completed' },
      { id: trustProbeJobId, kind: 'save', status: 'cancelled' },
    ]);
    expect(jobSummaries.some((job) => job.kind === 'generation')).toBe(false);
    expect(applicationProcess?.pid).toBe(enginePid);

    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).not.toBe(null);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s/i);
    await writeFile(evidencePath, `${JSON.stringify({
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      document: {
        id: initial.documentId,
        deniedCanonicalSha256: beforeSha256,
        revisionBefore: beforeDocument.revision,
        revisionAfter: afterAllowDocument.revision,
        dirtyBefore: beforeDocument.dirty,
        dirtyAfter: afterAllowDocument.dirty,
        finalPath: afterAllowDocument.filePath,
      },
      approvals: {
        choices: ['deny', 'allow-once', 'allow-session', 'allow-always'],
        denied: { jobId: deniedJobId, path: deniedPath, status: deniedResult.status },
        allowOnce: { jobId: allowedJobId, path: allowedPath, status: allowedResult.status },
        noTrustProbe: { jobId: trustProbeJobId, path: trustProbePath, status: trustProbeResult.status },
      },
      filesystem: { files: await readdir(targetRoot), persistentTrustFile: false },
      canonicalAgreement: { denialUnchanged: true, rendererMatchedMcp: true },
      paidOrProviderRequests: 0,
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    }, null, 2)}\n`, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`QA-06 packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-ANIM closes an exact packaged animated-sprite lifecycle', async () => {
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_ANIMATION_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith('aidraw-e2e-qa06-animation-')) {
      throw new Error('AIDRAW_E2E_QA06_ANIMATION_PROFILE must name a new aidraw-e2e-qa06-animation-* directory inside test-results/retained.');
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact QA-06 animation profile already exists: ${isolatedProfile}`);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, 'aidraw-e2e-qa06-animation-'));

  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const exportRoot = join(isolatedProfile, 'animation-export');
  const exportPath = join(exportRoot, 'qa06-bounce-loop.apng');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const evidencePath = join(isolatedProfile, 'qa06-animation-evidence.json');
  const timelineScreenshotPath = join(isolatedProfile, 'qa06-animation-timeline.png');
  const onionScreenshotPath = join(isolatedProfile, 'qa06-animation-onion.png');
  const playbackScreenshotPath = join(isolatedProfile, 'qa06-animation-playback.png');
  const approvalScreenshotPath = join(isolatedProfile, 'qa06-animation-export-approval.png');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: [`--write-mcp-connection=${connectionPath}`] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 animation package has no engine PID.');
    expect(page.url()).toMatch(/^aidraw:\/\/app\//);
    await mkdir(exportRoot, { recursive: true });
    expect(await readdir(exportRoot)).toEqual([]);
    expect(await access(exportPath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Pixel Sprite/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill('QA-06 Animated Sprite');
    await newDocumentDialog.getByLabel('Document width').fill('16');
    await newDocumentDialog.getByLabel('Document height').fill('16');
    await newDocumentDialog.getByRole('button', { name: 'Create Pixel Sprite' }).click();
    await expect(page.locator('.status-mode').filter({ hasText: /^Pixel Art$/ })).toBeVisible();

    const initialDocument = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!initialDocument || initialDocument.kind !== 'pixel') throw new Error('The QA-06 pixel document is unavailable.');
    const initialSprite = initialDocument.pixelAssets[initialDocument.activeAssetId];
    if (initialSprite.type !== 'sprite' || initialSprite.width !== 16 || initialSprite.height !== 16) throw new Error('The QA-06 16×16 sprite is unavailable.');

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-animated-sprite', {
      name: 'QA-06 animation agent',
      color: '#7257c8',
      documentId: initialDocument.id,
    });
    let mcpRequestId = 2;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, ++mcpRequestId, name, args);

    const timeline = page.locator('.timeline');
    const frameButtons = () => timeline.locator('.frame-strip > button:not(.add-frame)');
    const addFrameButton = timeline.locator('.add-frame');
    const setFrameDuration = async (index: number, durationMs: number) => {
      await frameButtons().nth(index).dblclick();
      const dialog = page.getByRole('dialog', { name: `Frame ${index + 1} duration` });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Duration (milliseconds)').fill(String(durationMs));
      await dialog.getByRole('button', { name: 'Set duration' }).click();
      await expect(dialog).toBeHidden();
      await expect(frameButtons().nth(index).locator('em')).toHaveText(`${durationMs}ms`);
    };

    await expect(frameButtons()).toHaveCount(1);
    await setFrameDuration(0, 80);
    await addFrameButton.click();
    await expect(frameButtons()).toHaveCount(2);
    await setFrameDuration(1, 120);
    await addFrameButton.click({ modifiers: ['Alt'] });
    await expect(frameButtons()).toHaveCount(3);
    await expect(page.getByTitle('Unlink active frame cels')).toBeVisible();
    await setFrameDuration(2, 160);
    await page.getByTitle('Unlink active frame cels').click();
    await expect(page.getByTitle('Link active frame cels to previous frame')).toBeVisible();
    await addFrameButton.click({ modifiers: ['Alt'] });
    await expect(frameButtons()).toHaveCount(4);
    await expect(page.getByTitle('Unlink active frame cels')).toBeVisible();
    await setFrameDuration(3, 200);
    await expect(timeline.locator('.timeline-label small')).toHaveText('4 frames · 0 tags');

    await timeline.getByRole('button', { name: '+ Tag', exact: true }).click();
    const tagDialog = page.getByRole('dialog', { name: 'Add animation tag' });
    await tagDialog.getByLabel('Name').fill('QA-06 Bounce Loop');
    await tagDialog.getByLabel('Start frame').selectOption({ label: 'Frame 1' });
    await tagDialog.getByLabel('End frame').selectOption({ label: 'Frame 4' });
    await tagDialog.getByLabel('Direction').selectOption('ping-pong');
    await expect(tagDialog.getByText('4 frames · ping-pong', { exact: true })).toBeVisible();
    await tagDialog.getByRole('button', { name: 'Add tag' }).click();
    await expect(tagDialog).toBeHidden();
    await expect(timeline.locator('.timeline-label small')).toHaveText('4 frames · 1 tags');
    const tagButton = timeline.locator('.timeline-tags button').filter({ hasText: 'QA-06 Bounce Loop' });
    await expect(tagButton).toBeVisible();
    await timeline.screenshot({ path: timelineScreenshotPath });

    const rendererBeforeSeed = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!rendererBeforeSeed || rendererBeforeSeed.kind !== 'pixel') throw new Error('The UI-authored QA-06 sprite is unavailable.');
    const spriteBeforeSeed = rendererBeforeSeed.pixelAssets[rendererBeforeSeed.activeAssetId];
    if (spriteBeforeSeed.type !== 'sprite') throw new Error('The UI-authored QA-06 sprite is invalid.');
    const frameIds = [...spriteBeforeSeed.frameIds];
    const cels = frameIds.map((frameId) => Object.values(spriteBeforeSeed.cels).find((cel) => cel.frameId === frameId));
    if (frameIds.length !== 4 || cels.some((cel) => !cel)) throw new Error('The QA-06 sprite does not have exactly one cel for each of four frames.');
    expect(cels[0]?.linkedToCelId).toBeUndefined();
    expect(cels[1]?.linkedToCelId).toBeUndefined();
    expect(cels[2]?.linkedToCelId).toBeUndefined();
    expect(cels[3]?.linkedToCelId).toBe(cels[2]?.id);
    expect(frameIds.map((frameId) => spriteBeforeSeed.frames[frameId].durationMs)).toEqual([80, 120, 160, 200]);
    const tag = spriteBeforeSeed.tags.find((entry) => entry.name === 'QA-06 Bounce Loop');
    expect(tag).toMatchObject({ fromFrameId: frameIds[0], toFrameId: frameIds[3], direction: 'ping-pong', color: '#31a6a0' });
    if (!tag) throw new Error('The QA-06 animation tag is unavailable.');

    const cross = (centerX: number, centerY: number, index: number) => [
      { x: centerX, y: centerY, index },
      { x: centerX - 1, y: centerY, index },
      { x: centerX + 1, y: centerY, index },
      { x: centerX, y: centerY - 1, index },
      { x: centerX, y: centerY + 1, index },
    ];
    const seeded = await call('canvas_apply', {
      documentId: rendererBeforeSeed.id,
      clientOperationId: 'qa06-animation-seed-cels',
      label: 'QA-06 seed animation cels',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'pixel.cel.set', spriteId: spriteBeforeSeed.id, celId: cels[0]!.id, changes: cross(3, 8, 2), expectedRevision: cels[0]!.revision },
        { kind: 'pixel.cel.set', spriteId: spriteBeforeSeed.id, celId: cels[1]!.id, changes: cross(12, 8, 4), expectedRevision: cels[1]!.revision },
        { kind: 'pixel.cel.set', spriteId: spriteBeforeSeed.id, celId: cels[2]!.id, changes: cross(8, 3, 6), expectedRevision: cels[2]!.revision },
      ],
    });
    expect(seeded.status).toBe('committed');
    const seededRevision = Number(seeded.revision);
    expect(Number.isInteger(seededRevision)).toBe(true);
    await expect.poll(async () => (await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument))?.revision).toBe(seededRevision);

    const observed = await call('canvas_observe', { documentId: rendererBeforeSeed.id });
    const canonicalDocument = observed.document as PixelDocument;
    expect(canonicalDocument).toMatchObject({ id: rendererBeforeSeed.id, revision: seededRevision, kind: 'pixel', name: 'QA-06 Animated Sprite' });
    const rendererDocument = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    expect(rendererDocument).toEqual(canonicalDocument);
    const canonicalSprite = canonicalDocument.pixelAssets[canonicalDocument.activeAssetId];
    if (canonicalSprite.type !== 'sprite') throw new Error('The canonical QA-06 sprite is invalid.');
    const canonicalCels = frameIds.map((frameId) => Object.values(canonicalSprite.cels).find((cel) => cel.frameId === frameId)!);
    expect(frameIds.map((frameId) => canonicalSprite.frames[frameId].durationMs)).toEqual([80, 120, 160, 200]);
    expect(canonicalCels.map((cel) => cel.linkedToCelId)).toEqual([undefined, undefined, undefined, canonicalCels[2].id]);
    expect(readPixel(canonicalCels[0], 3, 8)).toBe(2);
    expect(readPixel(canonicalCels[1], 12, 8)).toBe(4);
    expect(readPixel(canonicalCels[2], 8, 3)).toBe(6);
    expect(canonicalSprite.tags).toEqual([tag]);

    const canonicalFrameRgbaSha256: string[] = [];
    for (const frameId of frameIds) {
      const frameObservation = await call('canvas_observe', {
        documentId: canonicalDocument.id,
        includePng: true,
        assetId: canonicalSprite.id,
        frameId,
        scale: 2,
        background: 'transparent',
      });
      const png = frameObservation.png as { available?: boolean; width?: number; height?: number; frameId?: string; data?: string };
      expect(png).toMatchObject({ available: true, width: 32, height: 32, frameId });
      if (!png.data) throw new Error(`Authenticated MCP did not return frame ${frameId}.`);
      const decoded = UPNG.decode(Uint8Array.from(Buffer.from(png.data, 'base64')).buffer);
      canonicalFrameRgbaSha256.push(visualHash(Buffer.from(UPNG.toRGBA8(decoded)[0])));
    }
    expect(new Set(canonicalFrameRgbaSha256.slice(0, 3)).size).toBe(3);
    expect(canonicalFrameRgbaSha256[3]).toBe(canonicalFrameRgbaSha256[2]);

    await tagButton.click();
    await expect(tagButton).toHaveClass(/is-active/);
    await frameButtons().nth(1).click();
    const onionButton = page.getByTitle('Onion skin');
    await expect(onionButton).toHaveClass(/is-active/);
    const pixelCanvas = page.getByRole('application', { name: /Pixel-art canvas/ });
    const onionOn = await pixelCanvas.screenshot({ path: onionScreenshotPath });
    await onionButton.click();
    await expect(onionButton).not.toHaveClass(/is-active/);
    const onionOff = await pixelCanvas.screenshot();
    expect(visualHash(onionOff)).not.toBe(visualHash(onionOn));
    await onionButton.click();
    await expect(onionButton).toHaveClass(/is-active/);
    const restoredOnion = await pixelCanvas.screenshot();
    expect(visualHash(restoredOnion)).toBe(visualHash(onionOn));

    await expect.poll(async () => {
      const inspected = await call('session_manage', { action: 'inspect', documentId: canonicalDocument.id });
      return (inspected.workspace as { editorAdvisory?: { animation?: unknown } } | undefined)?.editorAdvisory?.animation;
    }).toMatchObject({ activeAssetId: canonicalSprite.id, activeFrameId: frameIds[1], activeTagId: tag.id, playing: false, onionSkin: true, direction: 'ping-pong' });

    const playButton = timeline.locator('.play-button');
    await playButton.click();
    await expect.poll(async () => {
      const inspected = await call('session_manage', { action: 'inspect', documentId: canonicalDocument.id });
      return (inspected.workspace as { editorAdvisory?: { animation?: { playing?: boolean; onionSkin?: boolean; direction?: string; activeTagId?: string } } } | undefined)?.editorAdvisory?.animation;
    }).toMatchObject({ activeTagId: tag.id, playing: true, onionSkin: true, direction: 'ping-pong' });
    await timeline.screenshot({ path: playbackScreenshotPath });
    await playButton.click();
    await expect.poll(async () => {
      const inspected = await call('session_manage', { action: 'inspect', documentId: canonicalDocument.id });
      return (inspected.workspace as { editorAdvisory?: { animation?: { playing?: boolean } } } | undefined)?.editorAdvisory?.animation?.playing;
    }).toBe(false);

    const exportRequest = await call('document_export', {
      documentId: canonicalDocument.id,
      path: exportPath,
      format: 'apng',
      scale: 2,
      animationTagId: tag.id,
    });
    expect(exportRequest).toMatchObject({ status: 'waiting-for-user' });
    const exportJobId = String(exportRequest.jobId);
    await page.getByTitle('Activity').click();
    const approvalCard = page.locator('.approval-card').filter({ hasText: 'Export document' });
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard.locator('.approval-heading small')).toHaveText('QA-06 animation agent requests approval');
    await expect(approvalCard.locator('.approval-target > span')).toHaveText('Exact path');
    await expect(approvalCard.locator('.approval-target code')).toHaveText(exportPath);
    expect((await approvalCard.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual([
      'Deny',
      'Allow once',
      'Trust this session',
      'Always trust folder',
    ]);
    await approvalCard.screenshot({ path: approvalScreenshotPath });
    await approvalCard.getByRole('button', { name: 'Allow once' }).click();
    await expect(approvalCard).toHaveCount(0);
    const exported = await call('job_manage', { action: 'wait', jobId: exportJobId, timeoutMs: 10_000 });
    expect(exported).toMatchObject({
      id: exportJobId,
      kind: 'export',
      status: 'completed',
      actor: { id: client.actor.id, name: client.actor.name },
    });
    expect(exported).not.toHaveProperty('result');
    expect(JSON.stringify(exported)).not.toContain(exportPath);
    const canonicalExportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), exportJobId);
    expect(canonicalExportJob).toMatchObject({
      id: exportJobId,
      kind: 'export',
      status: 'completed',
      actor: { id: client.actor.id, name: client.actor.name },
      result: { output: {
        path: exportPath,
        companionPaths: [],
        warnings: expect.arrayContaining(['Exported animation tag “QA-06 Bounce Loop” using ping-pong playback.']),
      } },
    });
    expect(await readdir(exportRoot)).toEqual(['qa06-bounce-loop.apng']);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    const exportedBytes = await readFile(exportPath);
    const decodedExport = UPNG.decode(Uint8Array.from(exportedBytes).buffer);
    expect(decodedExport).toMatchObject({ width: 32, height: 32 });
    expect(decodedExport.tabs.acTL?.num_frames).toBe(6);
    expect(decodedExport.frames.map((frame) => frame.delay)).toEqual([80, 120, 160, 200, 160, 120]);
    const exportedFrameRgbaSha256 = UPNG.toRGBA8(decodedExport).map((frame) => visualHash(Buffer.from(frame)));
    expect(exportedFrameRgbaSha256).toEqual([
      canonicalFrameRgbaSha256[0],
      canonicalFrameRgbaSha256[1],
      canonicalFrameRgbaSha256[2],
      canonicalFrameRgbaSha256[3],
      canonicalFrameRgbaSha256[2],
      canonicalFrameRgbaSha256[1],
    ]);

    const afterExport = await call('canvas_observe', { documentId: canonicalDocument.id });
    expect(afterExport.document).toEqual(canonicalDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(canonicalDocument);
    const finalJobs = await call('job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<{ id: string; kind: string; status: string }>;
    expect(jobSummaries.map((job) => ({ id: job.id, kind: job.kind, status: job.status }))).toEqual([
      { id: exportJobId, kind: 'export', status: 'completed' },
    ]);
    expect(jobSummaries.some((job) => job.kind === 'generation')).toBe(false);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      document: { id: canonicalDocument.id, revision: canonicalDocument.revision, spriteId: canonicalSprite.id, width: canonicalSprite.width, height: canonicalSprite.height },
      animation: {
        frameIds,
        durationsMs: [80, 120, 160, 200],
        independentFrameIds: frameIds.slice(0, 3),
        linkedFrame: { frameId: frameIds[3], linkedToCelId: canonicalCels[2].id },
        tag: { id: tag.id, name: tag.name, direction: tag.direction, fromFrameId: tag.fromFrameId, toFrameId: tag.toFrameId },
        onionSkin: { visibleDifference: true, onSha256: visualHash(onionOn), offSha256: visualHash(onionOff) },
        canonicalFrameRgbaSha256,
      },
      canonicalAgreement: { rendererMatchedMcp: true, exportSequenceMatchedMcp: true },
      export: { path: exportPath, format: 'apng', scale: 2, width: 32, height: 32, frameCount: 6, delaysMs: decodedExport.frames.map((frame) => frame.delay), byteLength: exportedBytes.byteLength, onlyTarget: true },
      paidOrProviderRequests: 0,
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`QA-06 animated-sprite packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-WANG closes an exact packaged finite-map Wang-terrain lifecycle', async () => {
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_WANG_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith('aidraw-e2e-qa06-wang-terrain-')) {
      throw new Error('AIDRAW_E2E_QA06_WANG_PROFILE must name a new aidraw-e2e-qa06-wang-terrain-* directory inside test-results/retained.');
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error('The exact QA-06 Wang-terrain profile already exists: ' + isolatedProfile);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, 'aidraw-e2e-qa06-wang-terrain-'));

  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const exportRoot = join(isolatedProfile, 'wang-interchange');
  const exportPath = join(exportRoot, 'qa06-finite-meadow.tmj');
  const companionPath = join(exportRoot, 'Tileset 1.png');
  const evidencePath = join(isolatedProfile, 'qa06-wang-terrain-evidence.json');
  const metadataScreenshotPath = join(isolatedProfile, 'qa06-wang-metadata.png');
  const paintedScreenshotPath = join(isolatedProfile, 'qa06-wang-painted.png');
  const erasedScreenshotPath = join(isolatedProfile, 'qa06-wang-erased.png');
  const finalScreenshotPath = join(isolatedProfile, 'qa06-wang-finite-final.png');
  const approvalScreenshotPath = join(isolatedProfile, 'qa06-wang-export-approval.png');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const transitionWangIds = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 1, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 0, 0, 0, 0, 0, 1],
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0],
  ];
  const expectedPattern = [
    { dx: 0, dy: 0, gid: 2 },
    { dx: 0, dy: -1, gid: 3 },
    { dx: 1, dy: -1, gid: 4 },
    { dx: 1, dy: 0, gid: 5 },
    { dx: 1, dy: 1, gid: 6 },
    { dx: 0, dy: 1, gid: 7 },
    { dx: -1, dy: 1, gid: 8 },
    { dx: -1, dy: 0, gid: 9 },
    { dx: -1, dy: -1, gid: 10 },
  ];
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: ['--write-mcp-connection=' + connectionPath] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 Wang-terrain package has no engine PID.');
    await mkdir(exportRoot, { recursive: true });
    expect(await readdir(exportRoot)).toEqual([]);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Pixel Project/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill('QA-06 Wang Terrain');
    await newDocumentDialog.getByLabel('Document width').fill('64');
    await newDocumentDialog.getByLabel('Document height').fill('64');
    await newDocumentDialog.getByRole('button', { name: 'Create Pixel Project' }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      return document?.kind === 'pixel' ? [document.name, document.scope, Object.keys(document.pixelAssets).length] : undefined;
    }).toEqual(['QA-06 Wang Terrain', 'project', 1]);

    await page.getByTitle('Assets').click();
    const assetsPanel = page.locator('.assets-panel');
    await expect(assetsPanel).toBeVisible();
    await assetsPanel.getByRole('button', { name: 'Tileset', exact: true }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      return document?.kind === 'pixel' ? Object.values(document.pixelAssets).filter((asset) => asset.type === 'tileset').length : 0;
    }).toBe(1);
    await assetsPanel.getByRole('button', { name: 'Map', exact: true }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      return document?.kind === 'pixel' ? Object.values(document.pixelAssets).filter((asset) => asset.type === 'tilemap').length : 0;
    }).toBe(1);

    const createdAssets = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') throw new Error('The QA-06 pixel project is unavailable.');
      const source = Object.values(document.pixelAssets).find((asset) => asset.type === 'sprite');
      const tileset = Object.values(document.pixelAssets).find((asset) => asset.type === 'tileset');
      const map = Object.values(document.pixelAssets).find((asset) => asset.type === 'tilemap');
      if (!source || !tileset || !map) throw new Error('The QA-06 project assets are incomplete.');
      return { documentId: document.id, sourceId: source.id, tilesetId: tileset.id, tilesetName: tileset.name, mapId: map.id, mapName: map.name };
    });

    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: createdAssets.tilesetName }).click();
    await page.getByTitle('Layers').click();
    const tilesetPanel = page.locator('.tileset-panel');
    await expect(tilesetPanel).toBeVisible();
    await tilesetPanel.getByRole('button', { name: '+ Terrain', exact: true }).click();
    await expect(tilesetPanel.locator('.wang-editor')).toBeVisible();

    const wangState = async () => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') return undefined;
      const active = document.pixelAssets[document.activeAssetId];
      if (active?.type !== 'tileset') return undefined;
      const set = active.wangSets[0];
      return set ? { name: set.name, type: set.type, colorName: set.colors[0]?.name, color: set.colors[0]?.color, probability: set.colors[0]?.probability } : undefined;
    });
    const wangEditor = tilesetPanel.locator('.wang-editor');
    const setNameInput = wangEditor.getByLabel('Set name');
    await setNameInput.fill('QA-06 Meadow');
    await setNameInput.blur();
    await expect.poll(wangState).toMatchObject({ name: 'QA-06 Meadow' });
    const modeSelect = wangEditor.getByLabel('Mode');
    await modeSelect.selectOption('edge');
    await expect.poll(wangState).toMatchObject({ type: 'edge' });
    await modeSelect.selectOption('mixed');
    await expect.poll(wangState).toMatchObject({ type: 'mixed' });
    await wangEditor.getByLabel('Wang color name 1').fill('Meadow');
    await expect.poll(wangState).toMatchObject({ colorName: 'Meadow' });
    await wangEditor.getByLabel('Wang color 1').fill('#55aa44');
    await expect.poll(wangState).toMatchObject({ color: '#55aa44' });
    await wangEditor.getByLabel('Wang color probability 1').fill('0.75');
    await expect.poll(wangState).toEqual({ name: 'QA-06 Meadow', type: 'mixed', colorName: 'Meadow', color: '#55aa44', probability: 0.75 });

    await page.getByTitle('Assets').click();
    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: createdAssets.mapName }).click();
    await page.getByTitle('Layers').click();
    const mapSetupButton = page.locator('.map-setup-disclosure-trigger');
    if ((await mapSetupButton.getAttribute('aria-expanded')) !== 'true') await mapSetupButton.click();
    const mapSettings = page.locator('.tilemap-settings');
    await expect(mapSettings).toBeVisible();
    const widthInput = mapSettings.getByRole('spinbutton', { name: 'Width', exact: true });
    const heightInput = mapSettings.getByRole('spinbutton', { name: 'Height', exact: true });
    const tileWidthInput = mapSettings.getByRole('spinbutton', { name: 'Tile width', exact: true });
    const tileHeightInput = mapSettings.getByRole('spinbutton', { name: 'Tile height', exact: true });
    await expect(widthInput).toHaveCount(1);
    await expect(heightInput).toHaveCount(1);
    await expect(tileWidthInput).toHaveCount(1);
    await expect(tileHeightInput).toHaveCount(1);
    await widthInput.fill('12');
    await widthInput.blur();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? map.width : undefined;
    }).toBe(12);
    await heightInput.fill('10');
    await heightInput.blur();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? [map.height, map.infinite, map.orientation] : undefined;
    }).toEqual([10, false, 'orthogonal']);
    await mapSettings.getByLabel('Map property name').fill('qa06-scenario');
    await mapSettings.getByLabel('Map property value').fill('finite-wang');
    await mapSettings.locator('.tile-property-add').getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? map.properties['qa06-scenario'] : undefined;
    }).toBe('finite-wang');

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-wang-terrain', {
      name: 'QA-06 terrain agent',
      color: '#4f8d48',
      documentId: createdAssets.documentId,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);

    const beforeSeed = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument) as PixelDocument;
    const sourceSprite = beforeSeed.pixelAssets[createdAssets.sourceId];
    const tilesetBeforeSeed = beforeSeed.pixelAssets[createdAssets.tilesetId];
    const mapBeforeSeed = beforeSeed.pixelAssets[createdAssets.mapId];
    if (sourceSprite.type !== 'sprite' || tilesetBeforeSeed.type !== 'tileset' || mapBeforeSeed.type !== 'tilemap') throw new Error('The QA-06 Wang assets changed type unexpectedly.');
    const sourceCel = Object.values(sourceSprite.cels).find((cel) => cel.frameId === sourceSprite.frameIds[0]);
    const authoredWangSet = tilesetBeforeSeed.wangSets[0];
    if (!sourceCel || !authoredWangSet) throw new Error('The QA-06 source cel or authored Wang set is unavailable.');
    const tileRuns: Array<{ x: number; y: number; length: number; index: number }> = [];
    for (let tileId = 0; tileId < transitionWangIds.length; tileId += 1) {
      const tileX = tileId % 4 * 16;
      const tileY = Math.floor(tileId / 4) * 16;
      const paletteIndex = tileId % Math.max(1, beforeSeed.palette.length - 1) + 1;
      for (let row = 0; row < 16; row += 1) tileRuns.push({ x: tileX, y: tileY + row, length: 16, index: paletteIndex });
    }
    const seeded = await call('canvas_apply', {
      documentId: beforeSeed.id,
      clientOperationId: 'qa06-wang-transition-seed',
      label: 'QA-06 seed Wang transitions and visible tile art',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'pixel.cel.region', spriteId: sourceSprite.id, celId: sourceCel.id, runs: tileRuns, expectedRevision: sourceCel.revision },
        {
          kind: 'pixel.wang-set.upsert',
          tilesetId: tilesetBeforeSeed.id,
          wangSet: { ...authoredWangSet, tiles: transitionWangIds.map((wangId, tileId) => ({ tileId, wangId })) },
          expectedRevision: tilesetBeforeSeed.revision,
        },
      ],
    });
    expect(seeded).toMatchObject({ status: 'committed' });

    const seededObserved = await call('canvas_observe', { documentId: beforeSeed.id });
    const seededDocument = seededObserved.document as PixelDocument;
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(seededDocument);
    const seededTileset = seededDocument.pixelAssets[createdAssets.tilesetId];
    if (seededTileset.type !== 'tileset') throw new Error('The canonical QA-06 tileset is unavailable after seeding.');
    expect(seededTileset.wangSets[0]).toMatchObject({
      id: authoredWangSet.id,
      name: 'QA-06 Meadow',
      type: 'mixed',
      colors: [{ id: 1, name: 'Meadow', color: '#55aa44', tileId: 0, probability: 0.75 }],
    });
    expect(seededTileset.wangSets[0].tiles).toEqual(transitionWangIds.map((wangId, tileId) => ({ tileId, wangId })));

    await page.getByTitle('Assets').click();
    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: createdAssets.tilesetName }).click();
    await page.getByTitle('Layers').click();
    await expect(tilesetPanel.locator('.terrain-row').filter({ hasText: 'QA-06 Meadow' })).toContainText('mixed · 10 mapped tiles');
    await tilesetPanel.locator('.tile-definition-grid button').getByText('1', { exact: true }).click();
    await expect(wangEditor.getByLabel('Set name')).toHaveValue('QA-06 Meadow');
    await expect(wangEditor.getByLabel('Mode')).toHaveValue('mixed');
    await expect(wangEditor.getByLabel('Wang color name 1')).toHaveValue('Meadow');
    await expect(wangEditor.getByLabel('Wang color 1')).toHaveValue('#55aa44');
    await expect(wangEditor.getByLabel('Wang color probability 1')).toHaveValue('0.75');
    const wangSlots = wangEditor.locator('.wang-slot-grid select');
    await expect(wangSlots).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) await expect(wangSlots.nth(index)).toHaveValue('1');
    await page.screenshot({ path: metadataScreenshotPath });

    await page.getByTitle('Assets').click();
    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: createdAssets.mapName }).click();
    await page.getByTitle('Layers').click();
    await expect(mapSettings.getByText('Finite bounds', { exact: true })).toBeVisible();
    await expect(widthInput).toHaveValue('12');
    await expect(heightInput).toHaveValue('10');
    await expect(tileWidthInput).toHaveValue('16');
    await expect(tileHeightInput).toHaveValue('16');
    await expect(mapSettings.getByRole('combobox', { name: 'Orientation', exact: true })).toHaveValue('orthogonal');
    await expect(mapSettings.locator('.map-infinite-toggle input')).not.toBeChecked();
    await page.getByRole('button', { name: 'Wang terrain', exact: true }).click();
    const floatingControls = page.locator('.pixel-floating-controls');
    await expect(floatingControls.getByLabel('Active Wang set')).toHaveValue(authoredWangSet.id);
    await expect(floatingControls.getByLabel('Active Wang color')).toHaveValue('1');
    const terrainToggle = floatingControls.getByTitle('Toggle terrain erase and neighbor repair');
    await expect(terrainToggle).toContainText('Paint');
    const pixelCanvas = page.getByRole('application', { name: /Pixel-art canvas/ });
    await expect(pixelCanvas).toBeVisible();

    const center = { x: 5, y: 4 };
    const readRendererPattern = async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument) as PixelDocument;
      const map = document.pixelAssets[createdAssets.mapId];
      if (map.type !== 'tilemap') throw new Error('The active QA-06 map is unavailable.');
      const layer = map.layers[map.layerIds[0]];
      if (layer.type !== 'tile' || !layer.chunks) throw new Error('The QA-06 tile layer is unavailable.');
      return expectedPattern.map((entry) => readTileAt(layer.chunks!, center.x + entry.dx, center.y + entry.dy));
    };
    const clickMapCell = async (x: number, y: number) => {
      const bounds = await pixelCanvas.boundingBox();
      if (!bounds) throw new Error('The QA-06 finite-map canvas has no bounds.');
      const scale = Math.max(1, Math.round(Math.max(1, Math.floor(Math.min((bounds.width - 120) / 12, (bounds.height - 100) / 10)))));
      const offsetX = Math.round((bounds.width - 12 * scale) / 2);
      const offsetY = Math.round((bounds.height - 10 * scale) / 2);
      await page.mouse.click(bounds.x + offsetX + (x + 0.5) * scale, bounds.y + offsetY + (y + 0.5) * scale);
    };

    await expect.poll(readRendererPattern).toEqual(Array(9).fill(0));
    const initialCanvas = await pixelCanvas.screenshot();
    await clickMapCell(center.x, center.y);
    await expect.poll(readRendererPattern).toEqual(expectedPattern.map((entry) => entry.gid));
    const paintedCanvas = await pixelCanvas.screenshot({ path: paintedScreenshotPath });
    expect(visualHash(paintedCanvas)).not.toBe(visualHash(initialCanvas));

    await terrainToggle.click();
    await expect(terrainToggle).toContainText('Erase');
    await clickMapCell(center.x, center.y);
    await expect.poll(readRendererPattern).toEqual(Array(9).fill(1));
    const erasedCanvas = await pixelCanvas.screenshot({ path: erasedScreenshotPath });
    expect(visualHash(erasedCanvas)).not.toBe(visualHash(paintedCanvas));

    await terrainToggle.click();
    await expect(terrainToggle).toContainText('Paint');
    await clickMapCell(center.x, center.y);
    await expect.poll(readRendererPattern).toEqual(expectedPattern.map((entry) => entry.gid));
    const repaintedCanvas = await pixelCanvas.screenshot();
    expect(visualHash(repaintedCanvas)).toBe(visualHash(paintedCanvas));
    await page.screenshot({ path: finalScreenshotPath });

    const canonicalObserved = await call('canvas_observe', {
      documentId: seededDocument.id,
      includePng: true,
      assetId: createdAssets.mapId,
      scale: 1,
      background: 'transparent',
    });
    const canonicalDocument = canonicalObserved.document as PixelDocument;
    const rendererFinal = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    expect(rendererFinal).toEqual(canonicalDocument);
    const canonicalMap = canonicalDocument.pixelAssets[createdAssets.mapId];
    const canonicalTileset = canonicalDocument.pixelAssets[createdAssets.tilesetId];
    if (canonicalMap.type !== 'tilemap' || canonicalTileset.type !== 'tileset') throw new Error('The final canonical QA-06 map assets are invalid.');
    expect(canonicalMap).toMatchObject({ width: 12, height: 10, orientation: 'orthogonal', infinite: false, tilesetIds: [createdAssets.tilesetId], properties: { 'qa06-scenario': 'finite-wang' } });
    expect(canonicalTileset.wangSets[0]).toEqual(seededTileset.wangSets[0]);
    const canonicalLayer = canonicalMap.layers[canonicalMap.layerIds[0]];
    if (canonicalLayer.type !== 'tile' || !canonicalLayer.chunks) throw new Error('The final canonical QA-06 tile layer is unavailable.');
    expect(expectedPattern.map((entry) => readTileAt(canonicalLayer.chunks!, center.x + entry.dx, center.y + entry.dy))).toEqual(expectedPattern.map((entry) => entry.gid));
    const mcpPng = canonicalObserved.png as { available: boolean; mimeType: string; width: number; height: number; assetId: string; data: string };
    expect(mcpPng).toMatchObject({ available: true, mimeType: 'image/png', width: 192, height: 160, assetId: createdAssets.mapId });
    const mcpPngBytes = Buffer.from(mcpPng.data, 'base64');
    expect(mcpPngBytes.byteLength).toBeGreaterThan(0);

    const exportRequest = await call('document_export', {
      documentId: canonicalDocument.id,
      path: exportPath,
      format: 'tiled-json',
    });
    expect(exportRequest).toMatchObject({ status: 'waiting-for-user' });
    const exportJobId = String(exportRequest.jobId);
    await page.getByTitle('Activity').click();
    const approvalCard = page.locator('.approval-card').filter({ hasText: 'Export document' });
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard.locator('.approval-heading small')).toHaveText('QA-06 terrain agent requests approval');
    await expect(approvalCard.locator('.approval-target code')).toHaveText(exportPath);
    await expect(approvalCard.locator('.approval-review')).toContainText('tiled-json');
    await expect(approvalCard.locator('.approval-review')).toContainText('No existing target detected');
    expect((await approvalCard.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual([
      'Deny',
      'Allow once',
      'Trust this session',
      'Always trust folder',
    ]);
    await approvalCard.screenshot({ path: approvalScreenshotPath });
    await approvalCard.getByRole('button', { name: 'Allow once' }).click();
    await expect(approvalCard).toHaveCount(0);
    const exported = await call('job_manage', { action: 'wait', jobId: exportJobId, timeoutMs: 10_000 });
    expect(exported).toMatchObject({ id: exportJobId, kind: 'export', status: 'completed', actor: { id: client.actor.id, name: client.actor.name } });
    expect(exported).not.toHaveProperty('result');
    expect(JSON.stringify(exported)).not.toContain(exportPath);
    const canonicalExportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), exportJobId);
    expect(canonicalExportJob).toMatchObject({
      id: exportJobId,
      kind: 'export',
      status: 'completed',
      actor: { id: client.actor.id, name: client.actor.name },
      result: { output: { path: exportPath, companionPaths: [companionPath], warnings: [] } },
    });
    expect((await readdir(exportRoot)).sort()).toEqual(['Tileset 1.png', 'qa06-finite-meadow.tmj'].sort());
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    const exportedBytes = await readFile(exportPath);
    const companionBytes = await readFile(companionPath);
    expect(companionBytes.subarray(1, 4).toString()).toBe('PNG');
    const tiled = JSON.parse(exportedBytes.toString('utf8')) as {
      type: string;
      orientation: string;
      infinite: boolean;
      width: number;
      height: number;
      tilewidth: number;
      tileheight: number;
      properties: Array<{ name: string; value: string; type: string }>;
      tilesets: Array<{
        firstgid: number;
        name: string;
        image: string;
        wangsets: Array<{
          name: string;
          type: string;
          colors: Array<{ name: string; color: string; tile: number; probability: number }>;
          wangtiles: Array<{ tileid: number; wangid: number[] }>;
        }>;
      }>;
      layers: Array<{ type: string; width: number; height: number; data: number[] }>;
    };
    expect(tiled).toMatchObject({
      type: 'map',
      orientation: 'orthogonal',
      infinite: false,
      width: 12,
      height: 10,
      tilewidth: 16,
      tileheight: 16,
      properties: [{ name: 'qa06-scenario', value: 'finite-wang', type: 'string' }],
    });
    expect(tiled.tilesets).toHaveLength(1);
    expect(tiled.tilesets[0]).toMatchObject({
      firstgid: 1,
      name: 'Tileset 1',
      image: 'Tileset 1.png',
      wangsets: [{
        name: 'QA-06 Meadow',
        type: 'mixed',
        colors: [{ name: 'Meadow', color: '#55aa44', tile: 0, probability: 0.75 }],
        wangtiles: transitionWangIds.map((wangid, tileid) => ({ tileid, wangid })),
      }],
    });
    expect(tiled.layers[0]).toMatchObject({ type: 'tilelayer', width: 12, height: 10 });
    expect(expectedPattern.map((entry) => tiled.layers[0].data[(center.y + entry.dy) * 12 + center.x + entry.dx])).toEqual(expectedPattern.map((entry) => entry.gid));

    const afterExport = await call('canvas_observe', { documentId: canonicalDocument.id });
    expect(afterExport.document).toEqual(canonicalDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(canonicalDocument);
    const finalJobs = await call('job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<{ id: string; kind: string; status: string }>;
    expect(jobSummaries.map((job) => ({ id: job.id, kind: job.kind, status: job.status }))).toEqual([{ id: exportJobId, kind: 'export', status: 'completed' }]);
    expect(jobSummaries.some((job) => job.kind === 'generation')).toBe(false);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      document: { id: canonicalDocument.id, revision: canonicalDocument.revision, scope: canonicalDocument.scope },
      wang: {
        tilesetId: canonicalTileset.id,
        set: { id: canonicalTileset.wangSets[0].id, name: canonicalTileset.wangSets[0].name, type: canonicalTileset.wangSets[0].type },
        color: canonicalTileset.wangSets[0].colors[0],
        mappedTileCount: canonicalTileset.wangSets[0].tiles.length,
        wangIds: canonicalTileset.wangSets[0].tiles.map((tile) => ({ tileId: tile.tileId, wangId: tile.wangId })),
      },
      finiteMap: {
        mapId: canonicalMap.id,
        width: canonicalMap.width,
        height: canonicalMap.height,
        orientation: canonicalMap.orientation,
        infinite: canonicalMap.infinite,
        center,
        paintedPattern: expectedPattern.map((entry) => ({ x: center.x + entry.dx, y: center.y + entry.dy, gid: entry.gid })),
        paintEraseRepaint: true,
      },
      visible: {
        initialSha256: visualHash(initialCanvas),
        paintedSha256: visualHash(paintedCanvas),
        erasedSha256: visualHash(erasedCanvas),
        repaintedSha256: visualHash(repaintedCanvas),
        repaintRestoredPaintHash: visualHash(repaintedCanvas) === visualHash(paintedCanvas),
      },
      canonicalAgreement: {
        rendererMatchedMcp: true,
        mcpPng: { width: mcpPng.width, height: mcpPng.height, sha256: visualHash(mcpPngBytes) },
        exportMatchedCanonical: true,
      },
      interchange: {
        format: 'tiled-json',
        path: exportPath,
        companionPaths: [companionPath],
        files: (await readdir(exportRoot)).sort(),
        tmjByteLength: exportedBytes.byteLength,
        tmjSha256: visualHash(exportedBytes),
        companionByteLength: companionBytes.byteLength,
        companionSha256: visualHash(companionBytes),
        fullRoundTripExercised: false,
        infiniteMapExercised: false,
      },
      paidOrProviderRequests: 0,
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error('QA-06 Wang-terrain packaged regression failed: ' + (error instanceof Error ? error.message : String(error)) + (diagnostic ? '\n' + diagnostic : ''));
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(regressionFailure.message + '\nGraceful cleanup also failed: ' + cleanupFailure.message)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-INFINITE closes an exact packaged orthogonal sparse-chunk lifecycle', async () => {
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_INFINITE_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith('aidraw-e2e-qa06-infinite-map-')) {
      throw new Error('AIDRAW_E2E_QA06_INFINITE_PROFILE must name a new aidraw-e2e-qa06-infinite-map-* directory inside test-results/retained.');
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error('The exact QA-06 infinite-map profile already exists: ' + isolatedProfile);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, 'aidraw-e2e-qa06-infinite-map-'));

  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const exportRoot = join(isolatedProfile, 'infinite-interchange');
  const exportPath = join(exportRoot, 'qa06-sparse-infinite.tmj');
  const companionPath = join(exportRoot, 'Tileset 1.png');
  const evidencePath = join(isolatedProfile, 'qa06-infinite-map-evidence.json');
  const settingsScreenshotPath = join(isolatedProfile, 'qa06-infinite-settings.png');
  const negativeScreenshotPath = join(isolatedProfile, 'qa06-infinite-negative-chunks.png');
  const positiveScreenshotPath = join(isolatedProfile, 'qa06-infinite-positive-chunks.png');
  const approvalScreenshotPath = join(isolatedProfile, 'qa06-infinite-export-approval.png');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(isolatedProfile, 'qa06-infinite-forbidden-network.json');
  const paintedCells = [
    { x: -33, y: -1, gid: 1 },
    { x: -32, y: -1, gid: 1 },
    { x: -31, y: -1, gid: 1 },
    { x: -1, y: -1, gid: 1 },
    { x: 0, y: -1, gid: 1 },
    { x: 1, y: -1, gid: 1 },
    { x: -1, y: 0, gid: 1 },
    { x: 0, y: 0, gid: 1 },
    { x: 1, y: 0, gid: 1 },
    { x: 31, y: 0, gid: 1 },
    { x: 32, y: 0, gid: 1 },
    { x: 33, y: 0, gid: 1 },
    { x: 31, y: 31, gid: 1 },
    { x: 32, y: 32, gid: 1 },
  ];
  const cellOrder = (a: { x: number; y: number; gid: number }, b: { x: number; y: number; gid: number }) => a.y - b.y || a.x - b.x || a.gid - b.gid;
  const nonzeroCells = (document: PixelDocument, mapId: string) => {
    const map = document.pixelAssets[mapId];
    if (map?.type !== 'tilemap') throw new Error('The QA-06 infinite map is unavailable.');
    const layer = map.layers[map.layerIds[0]];
    if (layer.type !== 'tile' || !layer.chunks) throw new Error('The QA-06 infinite tile layer is unavailable.');
    const cells: Array<{ x: number; y: number; gid: number }> = [];
    for (const chunk of Object.values(layer.chunks)) {
      const values = Buffer.from(chunk.data, 'base64');
      for (let index = 0; index < chunk.width * chunk.height; index += 1) {
        const gid = values.readUInt32LE(index * 4);
        if (gid) cells.push({ x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid });
      }
    }
    return cells.sort(cellOrder);
  };

  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: ['--write-mcp-connection=' + connectionPath] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 infinite-map package has no engine PID.');
    await mkdir(exportRoot, { recursive: true });
    expect(await readdir(exportRoot)).toEqual([]);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Pixel Project/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill('QA-06 Sparse Infinite Map');
    await newDocumentDialog.getByLabel('Document width').fill('64');
    await newDocumentDialog.getByLabel('Document height').fill('64');
    await newDocumentDialog.getByRole('button', { name: 'Create Pixel Project' }).click();

    await page.getByTitle('Assets').click();
    const assetsPanel = page.locator('.assets-panel');
    await expect(assetsPanel).toBeVisible();
    await assetsPanel.getByRole('button', { name: 'Tileset', exact: true }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      return document?.kind === 'pixel' ? Object.values(document.pixelAssets).filter((asset) => asset.type === 'tileset').length : 0;
    }).toBe(1);
    await assetsPanel.getByRole('button', { name: 'Map', exact: true }).click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      return document?.kind === 'pixel' ? Object.values(document.pixelAssets).filter((asset) => asset.type === 'tilemap').length : 0;
    }).toBe(1);

    const createdAssets = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') throw new Error('The QA-06 infinite-map project is unavailable.');
      const source = Object.values(document.pixelAssets).find((asset) => asset.type === 'sprite');
      const tileset = Object.values(document.pixelAssets).find((asset) => asset.type === 'tileset');
      const map = Object.values(document.pixelAssets).find((asset) => asset.type === 'tilemap');
      if (!source || !tileset || !map) throw new Error('The QA-06 infinite-map assets are incomplete.');
      return { documentId: document.id, sourceId: source.id, tilesetId: tileset.id, mapId: map.id, mapName: map.name };
    });
    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: createdAssets.mapName }).click();
    await page.getByTitle('Layers').click();
    const mapSetupButton = page.locator('.map-setup-disclosure-trigger');
    if ((await mapSetupButton.getAttribute('aria-expanded')) !== 'true') await mapSetupButton.click();
    const mapSettings = page.locator('.tilemap-settings');
    await expect(mapSettings).toBeVisible();
    const widthInput = mapSettings.getByRole('spinbutton', { name: 'Width', exact: true });
    const heightInput = mapSettings.getByRole('spinbutton', { name: 'Height', exact: true });
    await expect(widthInput).toHaveCount(1);
    await expect(heightInput).toHaveCount(1);
    await expect(widthInput).toHaveValue('64');
    await expect(heightInput).toHaveValue('64');
    await widthInput.fill('32');
    await widthInput.blur();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? [map.width, map.height] : undefined;
    }).toEqual([32, 64]);
    await heightInput.fill('32');
    await heightInput.blur();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? [map.width, map.height] : undefined;
    }).toEqual([32, 32]);
    const infiniteToggle = mapSettings.locator('.map-infinite-toggle input');
    await expect(infiniteToggle).toHaveCount(1);
    await mapSettings.locator('.map-infinite-toggle').click();
    await expect.poll(async () => {
      const document = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
      const map = document?.kind === 'pixel' ? document.pixelAssets[createdAssets.mapId] : undefined;
      return map?.type === 'tilemap' ? [map.infinite, map.orientation, map.width, map.height, map.tileWidth, map.tileHeight] : undefined;
    }).toEqual([true, 'orthogonal', 32, 32, 16, 16]);
    await expect(infiniteToggle).toBeChecked();
    await mapSettings.getByLabel('Map property name').fill('qa06-scenario');
    await mapSettings.getByLabel('Map property value').fill('orthogonal-sparse-chunks');
    await mapSettings.locator('.tile-property-add').getByRole('button', { name: 'Add', exact: true }).click();
    await expect(mapSettings.getByText('Sparse infinite chunks', { exact: true })).toBeVisible();
    await expect(mapSettings.getByText('qa06-scenario', { exact: true })).toBeVisible();
    await page.screenshot({ path: settingsScreenshotPath });

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-infinite-map', {
      name: 'QA-06 infinite map agent',
      color: '#2f7fbe',
      documentId: createdAssets.documentId,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);

    const beforeSeed = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument) as PixelDocument;
    const sourceSprite = beforeSeed.pixelAssets[createdAssets.sourceId];
    const mapBeforeSeed = beforeSeed.pixelAssets[createdAssets.mapId];
    if (sourceSprite.type !== 'sprite' || mapBeforeSeed.type !== 'tilemap') throw new Error('The QA-06 infinite-map assets changed type unexpectedly.');
    const sourceCel = Object.values(sourceSprite.cels).find((cel) => cel.frameId === sourceSprite.frameIds[0]);
    const tileLayer = mapBeforeSeed.layers[mapBeforeSeed.layerIds[0]];
    if (!sourceCel || tileLayer.type !== 'tile') throw new Error('The QA-06 infinite-map source cel or tile layer is unavailable.');
    const tileRuns = Array.from({ length: 16 }, (_, row) => ({ x: 0, y: row, length: 16, index: 4 }));
    const seeded = await call('canvas_apply', {
      documentId: beforeSeed.id,
      clientOperationId: 'qa06-infinite-sparse-seed',
      label: 'QA-06 seed visible art across signed sparse chunks',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'pixel.cel.region', spriteId: sourceSprite.id, celId: sourceCel.id, runs: tileRuns, expectedRevision: sourceCel.revision },
        { kind: 'pixel.tilemap.set', mapId: mapBeforeSeed.id, layerId: tileLayer.id, changes: paintedCells, expectedRevision: tileLayer.revision },
      ],
    });
    expect(seeded).toMatchObject({ status: 'committed' });

    const seededObserved = await call('canvas_observe', { documentId: beforeSeed.id, includePng: true, assetId: createdAssets.mapId, scale: 1, background: 'transparent' });
    const seededDocument = seededObserved.document as PixelDocument;
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(seededDocument);
    const seededMap = seededDocument.pixelAssets[createdAssets.mapId];
    if (seededMap.type !== 'tilemap') throw new Error('The canonical QA-06 infinite map is unavailable after seeding.');
    expect(seededMap).toMatchObject({ infinite: true, orientation: 'orthogonal', width: 32, height: 32, tileWidth: 16, tileHeight: 16, tilesetIds: [createdAssets.tilesetId], properties: { 'qa06-scenario': 'orthogonal-sparse-chunks' } });
    expect(nonzeroCells(seededDocument, createdAssets.mapId)).toEqual([...paintedCells].sort(cellOrder));
    const seededLayer = seededMap.layers[seededMap.layerIds[0]];
    if (seededLayer.type !== 'tile' || !seededLayer.chunks) throw new Error('The seeded QA-06 infinite tile layer is unavailable.');
    const expectedChunkOrigins = ['-64,-32', '-32,-32', '0,-32', '-32,0', '0,0', '32,0', '32,32'];
    expect(Object.values(seededLayer.chunks).map((chunk) => `${chunk.x},${chunk.y}`).sort()).toEqual([...expectedChunkOrigins].sort());
    const mcpPng = seededObserved.png as { available: boolean; mimeType: string; width: number; height: number; assetId: string; data: string };
    expect(mcpPng).toMatchObject({ available: true, mimeType: 'image/png', width: 512, height: 512, assetId: createdAssets.mapId });

    const pixelCanvas = page.getByRole('application', { name: /Pixel-art canvas/ });
    await expect(pixelCanvas).toBeVisible();
    await page.getByRole('button', { name: 'Pan', exact: true }).click();
    const inspectViewport = async () => {
      const inspected = await call('session_manage', { action: 'inspect', documentId: seededDocument.id });
      return (inspected.workspace as { editorAdvisory?: { viewport?: { x: number; y: number; width: number; height: number } } } | undefined)?.editorAdvisory?.viewport;
    };
    const initialViewport = await expect.poll(inspectViewport).toBeTruthy().then(() => inspectViewport());
    if (!initialViewport) throw new Error('The QA-06 infinite-map editor viewport is unavailable.');
    const canvasBounds = await pixelCanvas.boundingBox();
    if (!canvasBounds) throw new Error('The QA-06 infinite-map canvas has no bounds.');
    await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
    await page.mouse.wheel(-600, -600);
    await expect.poll(async () => {
      const viewport = await inspectViewport();
      return viewport ? [viewport.x < initialViewport.x - 25, viewport.y < initialViewport.y - 25] : [false, false];
    }).toEqual([true, true]);
    const negativeViewport = await inspectViewport();
    const negativeCanvas = await pixelCanvas.screenshot({ path: negativeScreenshotPath });
    await page.mouse.wheel(1_200, 1_200);
    await expect.poll(async () => {
      const viewport = await inspectViewport();
      return viewport ? [viewport.x > initialViewport.x + 25, viewport.y > initialViewport.y + 25] : [false, false];
    }).toEqual([true, true]);
    const positiveViewport = await inspectViewport();
    const positiveCanvas = await pixelCanvas.screenshot({ path: positiveScreenshotPath });
    expect(visualHash(negativeCanvas)).not.toBe(visualHash(positiveCanvas));
    const afterNavigation = await call('canvas_observe', { documentId: seededDocument.id });
    expect(afterNavigation.document).toEqual(seededDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(seededDocument);

    const exportRequest = await call('document_export', { documentId: seededDocument.id, path: exportPath, format: 'tiled-json' });
    expect(exportRequest).toMatchObject({ status: 'waiting-for-user' });
    const exportJobId = String(exportRequest.jobId);
    await page.getByTitle('Activity').click();
    const approvalCard = page.locator('.approval-card').filter({ hasText: 'Export document' });
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard.locator('.approval-heading small')).toHaveText('QA-06 infinite map agent requests approval');
    await expect(approvalCard.locator('.approval-target code')).toHaveText(exportPath);
    await expect(approvalCard.locator('.approval-review')).toContainText('tiled-json');
    await expect(approvalCard.locator('.approval-review')).toContainText('No existing target detected');
    expect((await approvalCard.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual(['Deny', 'Allow once', 'Trust this session', 'Always trust folder']);
    await approvalCard.screenshot({ path: approvalScreenshotPath });
    await approvalCard.getByRole('button', { name: 'Allow once' }).click();
    const exported = await call('job_manage', { action: 'wait', jobId: exportJobId, timeoutMs: 10_000 });
    expect(exported).toMatchObject({ id: exportJobId, kind: 'export', status: 'completed', actor: { id: client.actor.id, name: client.actor.name } });
    expect(exported).not.toHaveProperty('result');
    expect(JSON.stringify(exported)).not.toContain(exportPath);
    const canonicalExportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), exportJobId);
    expect(canonicalExportJob).toMatchObject({ result: { output: { path: exportPath, companionPaths: [companionPath], warnings: [] } } });
    expect((await readdir(exportRoot)).sort()).toEqual(['Tileset 1.png', 'qa06-sparse-infinite.tmj'].sort());

    const exportedBytes = await readFile(exportPath);
    const companionBytes = await readFile(companionPath);
    expect(companionBytes.subarray(1, 4).toString()).toBe('PNG');
    const tiled = JSON.parse(exportedBytes.toString('utf8')) as {
      type: string;
      orientation: string;
      infinite: boolean;
      width: number;
      height: number;
      tilewidth: number;
      tileheight: number;
      properties: Array<{ name: string; value: string; type: string }>;
      layers: Array<{ type: string; chunks: Array<{ x: number; y: number; width: number; height: number; data: number[] }> }>;
      tilesets: Array<{ firstgid: number; image: string }>;
    };
    expect(tiled).toMatchObject({
      type: 'map',
      orientation: 'orthogonal',
      infinite: true,
      width: 32,
      height: 32,
      tilewidth: 16,
      tileheight: 16,
      properties: [{ name: 'qa06-scenario', value: 'orthogonal-sparse-chunks', type: 'string' }],
      tilesets: [{ firstgid: 1, image: 'Tileset 1.png' }],
    });
    expect(tiled.layers).toHaveLength(1);
    expect(tiled.layers[0].type).toBe('tilelayer');
    expect(tiled.layers[0].chunks.map((chunk) => `${chunk.x},${chunk.y}`).sort()).toEqual([...expectedChunkOrigins].sort());
    const exportedCells = tiled.layers[0].chunks.flatMap((chunk) => chunk.data.flatMap((gid, index) => gid ? [{ x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid }] : [])).sort(cellOrder);
    expect(exportedCells).toEqual([...paintedCells].sort(cellOrder));

    const afterExport = await call('canvas_observe', { documentId: seededDocument.id });
    expect(afterExport.document).toEqual(seededDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(seededDocument);
    const finalJobs = await call('job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<{ id: string; kind: string; status: string }>;
    expect(jobSummaries.map((job) => ({ id: job.id, kind: job.kind, status: job.status }))).toEqual([{ id: exportJobId, kind: 'export', status: 'completed' }]);
    expect(jobSummaries.some((job) => job.kind === 'generation')).toBe(false);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      document: { id: seededDocument.id, revision: seededDocument.revision, scope: seededDocument.scope },
      infiniteMap: {
        mapId: seededMap.id,
        orientation: seededMap.orientation,
        infinite: seededMap.infinite,
        initialWidth: seededMap.width,
        initialHeight: seededMap.height,
        tileWidth: seededMap.tileWidth,
        tileHeight: seededMap.tileHeight,
        chunkOrigins: expectedChunkOrigins,
        paintedCells: [...paintedCells].sort(cellOrder),
      },
      visible: {
        initialViewport,
        negativeViewport,
        positiveViewport,
        negativeSha256: visualHash(negativeCanvas),
        positiveSha256: visualHash(positiveCanvas),
        distinctSignedViews: visualHash(negativeCanvas) !== visualHash(positiveCanvas),
      },
      canonicalAgreement: {
        rendererMatchedMcpBeforeNavigation: true,
        rendererMatchedMcpAfterNavigation: true,
        rendererMatchedMcpAfterExport: true,
        mcpPng: { width: mcpPng.width, height: mcpPng.height, sha256: visualHash(Buffer.from(mcpPng.data, 'base64')) },
        exportMatchedCanonicalChunks: true,
      },
      interchange: {
        format: 'tiled-json',
        path: exportPath,
        companionPaths: [companionPath],
        files: (await readdir(exportRoot)).sort(),
        tmjByteLength: exportedBytes.byteLength,
        tmjSha256: visualHash(exportedBytes),
        companionByteLength: companionBytes.byteLength,
        companionSha256: visualHash(companionBytes),
        fullRoundTripExercised: false,
        isometricInfiniteMapExercised: false,
      },
      paidOrProviderRequests: 0,
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error('QA-06 infinite-map packaged regression failed: ' + (error instanceof Error ? error.message : String(error)) + (diagnostic ? '\n' + diagnostic : ''));
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(regressionFailure.message + '\nGraceful cleanup also failed: ' + cleanupFailure.message)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-TILED-RT closes an exact packaged supported orthogonal TMJ companion round trip', async () => {
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_TILED_RT_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith('aidraw-e2e-qa06-tiled-roundtrip-')) {
      throw new Error('AIDRAW_E2E_QA06_TILED_RT_PROFILE must name a new aidraw-e2e-qa06-tiled-roundtrip-* directory inside test-results/retained.');
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error('The exact QA-06 Tiled round-trip profile already exists: ' + isolatedProfile);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, 'aidraw-e2e-qa06-tiled-roundtrip-'));

  const connectionPath = join(isolatedProfile, 'mcp-connection.json');
  const interchangeRoot = join(isolatedProfile, 'tiled-roundtrip-interchange');
  const firstExportRoot = join(interchangeRoot, 'first-export');
  const secondExportRoot = join(interchangeRoot, 'second-export');
  const firstExportPath = join(firstExportRoot, 'qa06-supported-first.tmj');
  const firstCompanionPath = join(firstExportRoot, 'Roundtrip Terrain.png');
  const secondExportPath = join(secondExportRoot, 'qa06-supported-second.tmj');
  const secondCompanionPath = join(secondExportRoot, 'Roundtrip Terrain.png');
  const evidencePath = join(isolatedProfile, 'qa06-tiled-roundtrip-evidence.json');
  const authoredScreenshotPath = join(isolatedProfile, 'qa06-tiled-authored-source.png');
  const firstApprovalScreenshotPath = join(isolatedProfile, 'qa06-tiled-first-export-approval.png');
  const importApprovalScreenshotPath = join(isolatedProfile, 'qa06-tiled-import-approval.png');
  const importedScreenshotPath = join(isolatedProfile, 'qa06-tiled-imported-document.png');
  const secondApprovalScreenshotPath = join(isolatedProfile, 'qa06-tiled-second-export-approval.png');
  const reexportScreenshotPath = join(isolatedProfile, 'qa06-tiled-reexport-result.png');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(isolatedProfile, 'qa06-tiled-roundtrip-forbidden-network.json');
  const paintedCells = [
    { x: -33, y: -1, gid: 1 }, { x: -32, y: -1, gid: 2 }, { x: -31, y: -1, gid: 1 },
    { x: -1, y: -1, gid: 2 }, { x: 0, y: -1, gid: 1 }, { x: 1, y: -1, gid: 2 },
    { x: -1, y: 0, gid: 1 }, { x: 0, y: 0, gid: 2 }, { x: 1, y: 0, gid: 1 },
    { x: 31, y: 0, gid: 2 }, { x: 32, y: 0, gid: 1 }, { x: 33, y: 0, gid: 2 },
    { x: 31, y: 31, gid: 1 }, { x: 32, y: 32, gid: 2 },
  ];
  const expectedChunkOrigins = ['-64,-32', '-32,-32', '0,-32', '-32,0', '0,0', '32,0', '32,32'];
  const cellOrder = (left: { x: number; y: number; gid: number }, right: { x: number; y: number; gid: number }) => left.y - right.y || left.x - right.x || left.gid - right.gid;
  const nonzeroCells = (document: PixelDocument, mapId: string) => {
    const map = document.pixelAssets[mapId];
    if (map?.type !== 'tilemap') throw new Error('The QA-06 Tiled round-trip map is unavailable.');
    const layer = map.layers[map.layerIds[0]];
    if (layer.type !== 'tile' || !layer.chunks) throw new Error('The QA-06 Tiled round-trip tile layer is unavailable.');
    const cells: Array<{ x: number; y: number; gid: number }> = [];
    for (const chunk of Object.values(layer.chunks)) {
      const values = Buffer.from(chunk.data, 'base64');
      for (let index = 0; index < chunk.width * chunk.height; index += 1) {
        const gid = values.readUInt32LE(index * 4);
        if (gid) cells.push({ x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid });
      }
    }
    return cells.sort(cellOrder);
  };
  const pixelPlane = (sprite: PixelSprite) => {
    const cel = Object.values(sprite.cels).find((entry) => entry.frameId === sprite.frameIds[0]);
    if (!cel) throw new Error('The QA-06 Tiled round-trip sprite has no first-frame cel.');
    return Array.from({ length: sprite.width * sprite.height }, (_, index) => readPixel(cel, index % sprite.width, Math.floor(index / sprite.width)));
  };
  const canonicalSemantics = (document: PixelDocument, mapId: string) => {
    const map = document.pixelAssets[mapId];
    if (map?.type !== 'tilemap') throw new Error('The canonical QA-06 Tiled map is unavailable.');
    const layer = map.layers[map.layerIds[0]];
    if (layer.type !== 'tile' || !layer.chunks) throw new Error('The canonical QA-06 Tiled layer is unavailable.');
    const tileset = document.pixelAssets[map.tilesetIds[0]];
    if (tileset?.type !== 'tileset') throw new Error('The canonical QA-06 Tiled tileset is unavailable.');
    if (!tileset.spriteAssetId) throw new Error('The canonical QA-06 Tiled tileset is not atlas-backed.');
    const sprite = document.pixelAssets[tileset.spriteAssetId];
    if (sprite?.type !== 'sprite') throw new Error('The canonical QA-06 Tiled tileset pixels are unavailable.');
    return {
      map: {
        orientation: map.orientation,
        infinite: map.infinite,
        width: map.width,
        height: map.height,
        tileWidth: map.tileWidth,
        tileHeight: map.tileHeight,
        properties: Object.entries(map.properties).sort(([left], [right]) => left.localeCompare(right)),
      },
      tileset: {
        name: tileset.name,
        firstGid: tileset.firstGid,
        tileWidth: tileset.tileWidth,
        tileHeight: tileset.tileHeight,
        margin: tileset.margin,
        spacing: tileset.spacing,
        columns: tileset.columns,
        rows: tileset.rows,
        transformations: tileset.transformations,
        tiles: Object.values(tileset.tiles).sort((left, right) => left.id - right.id).map((tile) => ({
          id: tile.id,
          sourceX: tile.sourceX,
          sourceY: tile.sourceY,
          probability: tile.probability,
          animation: tile.animation,
          properties: Object.entries(tile.properties).sort(([left], [right]) => left.localeCompare(right)),
        })),
      },
      layer: {
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        parallaxX: layer.parallaxX,
        parallaxY: layer.parallaxY,
        chunkOrigins: Object.values(layer.chunks).map((chunk) => `${chunk.x},${chunk.y}`).sort(),
        cells: nonzeroCells(document, map.id),
      },
      pixels: { width: sprite.width, height: sprite.height, indices: pixelPlane(sprite) },
    };
  };
  const tiledSemantics = (bytes: Buffer) => {
    const tiled = JSON.parse(bytes.toString('utf8')) as {
      type: string; orientation: string; infinite: boolean; width: number; height: number; tilewidth: number; tileheight: number;
      properties?: Array<{ name: string; type: string; value: unknown }>;
      tilesets: Array<{
        firstgid: number; name: string; tilewidth: number; tileheight: number; margin: number; spacing: number; tilecount: number; columns: number;
        image: string; imagewidth: number; imageheight: number; transformations?: { hflip: boolean; vflip: boolean; rotate: boolean; preferuntransformed: boolean };
        tiles?: Array<{ id: number; probability?: number; animation?: Array<{ tileid: number; duration: number }>; properties?: Array<{ name: string; type: string; value: unknown }> }>;
      }>;
      layers: Array<{ name: string; type: string; visible: boolean; opacity: number; parallaxx: number; parallaxy: number; chunks: Array<{ x: number; y: number; width: number; height: number; data: number[] }> }>;
    };
    const properties = (values: Array<{ name: string; type: string; value: unknown }> | undefined) => [...(values ?? [])].sort((left, right) => left.name.localeCompare(right.name));
    const layers = tiled.layers.map((layer) => ({
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      opacity: layer.opacity,
      parallaxx: layer.parallaxx,
      parallaxy: layer.parallaxy,
      chunks: [...layer.chunks].sort((left, right) => left.y - right.y || left.x - right.x),
    }));
    return {
      map: { type: tiled.type, orientation: tiled.orientation, infinite: tiled.infinite, width: tiled.width, height: tiled.height, tilewidth: tiled.tilewidth, tileheight: tiled.tileheight, properties: properties(tiled.properties) },
      tilesets: tiled.tilesets.map((tileset) => ({
        firstgid: tileset.firstgid,
        name: tileset.name,
        tilewidth: tileset.tilewidth,
        tileheight: tileset.tileheight,
        margin: tileset.margin,
        spacing: tileset.spacing,
        tilecount: tileset.tilecount,
        columns: tileset.columns,
        image: basename(tileset.image),
        imagewidth: tileset.imagewidth,
        imageheight: tileset.imageheight,
        transformations: tileset.transformations,
        tiles: [...(tileset.tiles ?? [])].sort((left, right) => left.id - right.id).map((tile) => ({ id: tile.id, probability: tile.probability, animation: tile.animation ?? [], properties: properties(tile.properties) })),
      })),
      layers,
    };
  };
  const pngPixels = (bytes: Buffer) => {
    const decoded = UPNG.decode(Uint8Array.from(bytes).buffer);
    return { width: decoded.width, height: decoded.height, rgba: Buffer.from(UPNG.toRGBA8(decoded)[0]) };
  };

  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, { extraArguments: ['--write-mcp-connection=' + connectionPath] });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 Tiled round-trip package has no engine PID.');
    await Promise.all([mkdir(firstExportRoot, { recursive: true }), mkdir(secondExportRoot, { recursive: true })]);
    expect(await readdir(firstExportRoot)).toEqual([]);
    expect(await readdir(secondExportRoot)).toEqual([]);
    for (const path of [evidencePath, authoredScreenshotPath, firstApprovalScreenshotPath, importApprovalScreenshotPath, importedScreenshotPath, secondApprovalScreenshotPath, reexportScreenshotPath]) expect(await access(path).then(() => true, () => false)).toBe(false);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Pixel Project/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill('QA-06 Supported Tiled Round Trip');
    await newDocumentDialog.getByLabel('Document width').fill('32');
    await newDocumentDialog.getByLabel('Document height').fill('16');
    await newDocumentDialog.getByRole('button', { name: 'Create Pixel Project' }).click();

    await page.getByTitle('Assets').click();
    const assetsPanel = page.locator('.assets-panel');
    await expect(assetsPanel).toBeVisible();
    await assetsPanel.getByRole('button', { name: 'Tileset', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      return document?.kind === 'pixel' ? Object.values(document.pixelAssets).filter((asset) => asset.type === 'tileset').length : 0;
    })).toBe(1);
    await assetsPanel.getByRole('button', { name: 'Map', exact: true }).click();
    const createdAssets = await expect.poll(async () => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') return undefined;
      const source = Object.values(document.pixelAssets).find((asset) => asset.type === 'sprite');
      const tileset = Object.values(document.pixelAssets).find((asset) => asset.type === 'tileset');
      const map = Object.values(document.pixelAssets).find((asset) => asset.type === 'tilemap');
      return source && tileset && map ? { documentId: document.id, sourceId: source.id, tilesetId: tileset.id, mapId: map.id } : undefined;
    })).toBeTruthy().then(async () => page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'pixel') throw new Error('The QA-06 Tiled round-trip project is unavailable.');
      const source = Object.values(document.pixelAssets).find((asset) => asset.type === 'sprite');
      const tileset = Object.values(document.pixelAssets).find((asset) => asset.type === 'tileset');
      const map = Object.values(document.pixelAssets).find((asset) => asset.type === 'tilemap');
      if (!source || !tileset || !map) throw new Error('The QA-06 Tiled round-trip assets are incomplete.');
      return { documentId: document.id, sourceId: source.id, tilesetId: tileset.id, mapId: map.id };
    }));

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-tiled-roundtrip', {
      name: 'QA-06 Tiled roundtrip agent',
      color: '#7a4fbe',
      documentId: createdAssets.documentId,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);

    const beforeSeed = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument) as PixelDocument;
    const sourceBeforeSeed = beforeSeed.pixelAssets[createdAssets.sourceId];
    const tilesetBeforeSeed = beforeSeed.pixelAssets[createdAssets.tilesetId];
    const mapBeforeSeed = beforeSeed.pixelAssets[createdAssets.mapId];
    if (sourceBeforeSeed.type !== 'sprite' || tilesetBeforeSeed.type !== 'tileset' || mapBeforeSeed.type !== 'tilemap') throw new Error('The QA-06 Tiled round-trip assets changed type unexpectedly.');
    const sourceCel = Object.values(sourceBeforeSeed.cels).find((cel) => cel.frameId === sourceBeforeSeed.frameIds[0]);
    const tileLayer = mapBeforeSeed.layers[mapBeforeSeed.layerIds[0]];
    if (!sourceCel || tileLayer.type !== 'tile') throw new Error('The QA-06 Tiled round-trip source cel or tile layer is unavailable.');
    expect(tilesetBeforeSeed).toMatchObject({ tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, firstGid: 1 });
    const authoredTileset = structuredClone(tilesetBeforeSeed);
    authoredTileset.name = 'Roundtrip Terrain';
    authoredTileset.transformations = { hFlip: true, vFlip: false, rotate: true };
    authoredTileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, probability: 0.25, animation: [], collisions: [], properties: { walkable: true, cost: 3 } },
      1: { id: 1, sourceX: 16, sourceY: 0, probability: 0.75, animation: [{ tileId: 0, durationMs: 120 }], collisions: [], properties: { walkable: false, cost: 8 } },
    };
    const authoredMap = structuredClone(mapBeforeSeed);
    authoredMap.name = 'Signed map';
    authoredMap.orientation = 'orthogonal';
    authoredMap.infinite = true;
    authoredMap.width = 32;
    authoredMap.height = 32;
    authoredMap.tileWidth = 16;
    authoredMap.tileHeight = 16;
    authoredMap.properties = { 'qa06-scenario': 'orthogonal-companion-roundtrip', seed: 4242, collisionSafe: true };
    const seeded = await call('canvas_apply', {
      documentId: beforeSeed.id,
      clientOperationId: 'qa06-tiled-supported-seed',
      label: 'QA-06 author supported Tiled round-trip surface',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'pixel.cel.region', spriteId: sourceBeforeSeed.id, celId: sourceCel.id, runs: [
          { x: 0, y: 0, length: 1, index: 2 }, { x: 1, y: 0, length: 1, index: 4 }, { x: 15, y: 7, length: 1, index: 7 },
          { x: 16, y: 0, length: 1, index: 9 }, { x: 17, y: 0, length: 1, index: 15 }, { x: 31, y: 15, length: 1, index: 3 },
        ], expectedRevision: sourceCel.revision },
        { kind: 'pixel.asset.replace', asset: authoredTileset, expectedRevision: tilesetBeforeSeed.revision },
        { kind: 'pixel.asset.replace', asset: authoredMap, expectedRevision: mapBeforeSeed.revision },
        { kind: 'pixel.tilemap.set', mapId: authoredMap.id, layerId: tileLayer.id, changes: paintedCells, expectedRevision: tileLayer.revision },
      ],
    });
    expect(seeded).toMatchObject({ status: 'committed' });

    const firstObserved = await call('canvas_observe', { documentId: beforeSeed.id, includePng: true, assetId: createdAssets.mapId, scale: 1, background: 'transparent' });
    const firstDocument = firstObserved.document as PixelDocument;
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(firstDocument);
    const firstSemantics = canonicalSemantics(firstDocument, createdAssets.mapId);
    expect(firstDocument.pixelAssets[createdAssets.mapId]).toMatchObject({ type: 'tilemap', name: 'Signed map' });
    expect(firstSemantics).toMatchObject({
      map: { orientation: 'orthogonal', infinite: true, width: 32, height: 32, tileWidth: 16, tileHeight: 16 },
      tileset: { name: 'Roundtrip Terrain', firstGid: 1, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, transformations: { hFlip: true, vFlip: false, rotate: true } },
      layer: { chunkOrigins: [...expectedChunkOrigins].sort(), cells: [...paintedCells].sort(cellOrder) },
      pixels: { width: 32, height: 16 },
    });
    expect(firstSemantics.map.properties).toEqual([['collisionSafe', true], ['qa06-scenario', 'orthogonal-companion-roundtrip'], ['seed', 4242]]);
    expect(firstDocument.activity.filter((entry) => entry.label === 'QA-06 author supported Tiled round-trip surface').at(-1)?.actor.id).toBe(client.actor.id);
    const firstSpriteObserved = await call('canvas_observe', { documentId: beforeSeed.id, includePng: true, assetId: createdAssets.sourceId, scale: 1, background: 'transparent' });
    const firstSpritePng = firstSpriteObserved.png as { available: boolean; width: number; height: number; data: string };
    expect(firstSpritePng).toMatchObject({ available: true, width: 32, height: 16 });

    await page.getByTitle('Assets').click();
    await assetsPanel.locator('.pixel-asset-list button').filter({ hasText: 'Signed map' }).click();
    await page.getByTitle('Layers').click();
    const sourceMapSetupButton = page.locator('.map-setup-disclosure-trigger');
    if ((await sourceMapSetupButton.getAttribute('aria-expanded')) !== 'true') await sourceMapSetupButton.click();
    const sourceMapSettings = page.locator('.tilemap-settings');
    await expect(sourceMapSettings.getByText('Sparse infinite chunks', { exact: true })).toBeVisible();
    await expect(sourceMapSettings.getByText('qa06-scenario', { exact: true })).toBeVisible();
    await expect(sourceMapSettings.getByText('collisionSafe', { exact: true })).toBeVisible();
    await expect(sourceMapSettings.getByText('seed', { exact: true })).toBeVisible();
    await page.screenshot({ path: authoredScreenshotPath });

    const findApprovalCard = (title: string, target: string) => page.locator('.approval-card').filter({ hasText: title }).filter({ has: page.locator('.approval-target code').filter({ hasText: target }) });
    const assertApproval = async (card: ReturnType<typeof findApprovalCard>, target: string, action: string) => {
      await expect(card).toHaveCount(1);
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-heading small')).toHaveText('QA-06 Tiled roundtrip agent requests approval');
      await expect(card.locator('.approval-target code')).toHaveText(target);
      await expect(card.locator('.approval-review')).toContainText(action);
      expect((await card.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual(['Deny', 'Allow once', 'Trust this session', 'Always trust folder']);
    };

    const firstExportRequest = await call('document_export', { documentId: firstDocument.id, path: firstExportPath, format: 'tiled-json' });
    expect(firstExportRequest).toMatchObject({ status: 'waiting-for-user' });
    const firstExportJobId = String(firstExportRequest.jobId);
    await page.getByTitle('Activity').click();
    const firstExportApproval = findApprovalCard('Export document', firstExportPath);
    await assertApproval(firstExportApproval, firstExportPath, 'tiled-json');
    await expect(firstExportApproval.locator('.approval-review')).toContainText('No existing target detected');
    await firstExportApproval.screenshot({ path: firstApprovalScreenshotPath });
    await firstExportApproval.getByRole('button', { name: 'Allow once' }).click();
    const firstExported = await call('job_manage', { action: 'wait', jobId: firstExportJobId, timeoutMs: 10_000 });
    expect(firstExported).toMatchObject({ id: firstExportJobId, kind: 'export', status: 'completed', actor: { id: client.actor.id, name: client.actor.name } });
    expect(firstExported).not.toHaveProperty('result');
    expect(JSON.stringify(firstExported)).not.toContain(firstExportPath);
    const canonicalFirstExportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), firstExportJobId);
    expect(canonicalFirstExportJob).toMatchObject({ result: { output: { path: firstExportPath, companionPaths: [firstCompanionPath], warnings: [] } } });
    expect((await readdir(firstExportRoot)).sort()).toEqual(['Roundtrip Terrain.png', 'qa06-supported-first.tmj'].sort());
    expect(await readdir(secondExportRoot)).toEqual([]);
    const firstTmjBytes = await readFile(firstExportPath);
    const firstCompanionBytes = await readFile(firstCompanionPath);
    const firstTiled = tiledSemantics(firstTmjBytes);
    expect(firstTiled.map).toMatchObject({ type: 'map', orientation: 'orthogonal', infinite: true, width: 32, height: 32, tilewidth: 16, tileheight: 16 });
    expect(firstTiled.map.properties).toEqual([
      { name: 'collisionSafe', type: 'bool', value: true },
      { name: 'qa06-scenario', type: 'string', value: 'orthogonal-companion-roundtrip' },
      { name: 'seed', type: 'int', value: 4242 },
    ]);
    expect(firstTiled.tilesets).toEqual([expect.objectContaining({ firstgid: 1, name: 'Roundtrip Terrain', image: 'Roundtrip Terrain.png', imagewidth: 32, imageheight: 16 })]);
    expect(firstTiled.layers[0].chunks.map((chunk) => `${chunk.x},${chunk.y}`).sort()).toEqual([...expectedChunkOrigins].sort());
    const firstPng = pngPixels(firstCompanionBytes);
    expect(firstPng).toMatchObject({ width: 32, height: 16 });
    expect(firstPng.rgba.equals(pngPixels(Buffer.from(firstSpritePng.data, 'base64')).rgba)).toBe(true);

    const importRequest = await call('asset_import', { documentId: firstDocument.id, path: firstExportPath, pixelMode: true });
    expect(importRequest).toMatchObject({ status: 'waiting-for-user' });
    const importJobId = String(importRequest.jobId);
    const importApproval = findApprovalCard('Import asset', firstExportPath);
    await assertApproval(importApproval, firstExportPath, 'import');
    await expect(importApproval.locator('.approval-review')).toContainText('Pixel import');
    await expect(importApproval.locator('.approval-review')).toContainText('Yes');
    await importApproval.screenshot({ path: importApprovalScreenshotPath });
    await importApproval.getByRole('button', { name: 'Allow once' }).click();
    const imported = await call('job_manage', { action: 'wait', jobId: importJobId, timeoutMs: 10_000 });
    expect(imported).toMatchObject({ id: importJobId, kind: 'import', status: 'completed', actor: { id: client.actor.id, name: client.actor.name } });
    expect(imported).not.toHaveProperty('result');
    expect(JSON.stringify(imported)).not.toContain(firstExportPath);
    const canonicalImportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), importJobId) as { result?: { output?: { imported?: string[]; warnings?: string[] } } } | undefined;
    expect(canonicalImportJob).toMatchObject({ result: { output: { imported: [expect.any(String)], warnings: [] } } });
    const importedDocumentId = canonicalImportJob?.result?.output?.imported?.[0];
    if (!importedDocumentId || importedDocumentId === firstDocument.id) throw new Error('The exact first TMJ pair did not create one distinct imported document.');
    const importedObserved = await call('canvas_observe', { documentId: importedDocumentId });
    const importedDocument = importedObserved.document as PixelDocument;
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(importedDocument);
    const importedMap = importedDocument.pixelAssets[importedDocument.activeAssetId];
    if (importedMap?.type !== 'tilemap') throw new Error('The imported QA-06 Tiled document is not active on its map.');
    const importedSemantics = canonicalSemantics(importedDocument, importedMap.id);
    expect(importedSemantics).toEqual(firstSemantics);
    const importedTileset = importedDocument.pixelAssets[importedMap.tilesetIds[0]];
    if (importedTileset?.type !== 'tileset') throw new Error('The imported QA-06 Tiled tileset is unavailable.');
    if (!importedTileset.spriteAssetId) throw new Error('The imported QA-06 Tiled tileset is not atlas-backed.');
    const importedSprite = importedDocument.pixelAssets[importedTileset.spriteAssetId];
    if (importedSprite?.type !== 'sprite') throw new Error('The imported QA-06 Tiled companion pixels are unavailable.');
    const importedSpriteObserved = await call('canvas_observe', { documentId: importedDocument.id, includePng: true, assetId: importedSprite.id, scale: 1, background: 'transparent' });
    const importedSpritePng = importedSpriteObserved.png as { available: boolean; width: number; height: number; data: string };
    expect(importedSpritePng).toMatchObject({ available: true, width: 32, height: 16 });
    expect(pngPixels(Buffer.from(importedSpritePng.data, 'base64')).rgba.equals(firstPng.rgba)).toBe(true);

    await page.getByTitle('Assets').click();
    await page.getByTitle('Layers').click();
    const importedMapSetupButton = page.locator('.map-setup-disclosure-trigger');
    if ((await importedMapSetupButton.getAttribute('aria-expanded')) !== 'true') await importedMapSetupButton.click();
    const importedMapSettings = page.locator('.tilemap-settings');
    await expect(importedMapSettings.getByText('Sparse infinite chunks', { exact: true })).toBeVisible();
    await expect(importedMapSettings.getByText('qa06-scenario', { exact: true })).toBeVisible();
    await page.screenshot({ path: importedScreenshotPath });

    const secondExportRequest = await call('document_export', { documentId: importedDocument.id, path: secondExportPath, format: 'tiled-json' });
    expect(secondExportRequest).toMatchObject({ status: 'waiting-for-user' });
    const secondExportJobId = String(secondExportRequest.jobId);
    await page.getByTitle('Activity').click();
    const secondExportApproval = findApprovalCard('Export document', secondExportPath);
    await assertApproval(secondExportApproval, secondExportPath, 'tiled-json');
    await expect(secondExportApproval.locator('.approval-review')).toContainText('No existing target detected');
    await secondExportApproval.screenshot({ path: secondApprovalScreenshotPath });
    await secondExportApproval.getByRole('button', { name: 'Allow once' }).click();
    const secondExported = await call('job_manage', { action: 'wait', jobId: secondExportJobId, timeoutMs: 10_000 });
    expect(secondExported).toMatchObject({ id: secondExportJobId, kind: 'export', status: 'completed', actor: { id: client.actor.id, name: client.actor.name } });
    expect(secondExported).not.toHaveProperty('result');
    expect(JSON.stringify(secondExported)).not.toContain(secondExportPath);
    const canonicalSecondExportJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), secondExportJobId);
    expect(canonicalSecondExportJob).toMatchObject({ result: { output: { path: secondExportPath, companionPaths: [secondCompanionPath], warnings: [] } } });
    expect((await readdir(secondExportRoot)).sort()).toEqual(['Roundtrip Terrain.png', 'qa06-supported-second.tmj'].sort());
    expect((await readdir(interchangeRoot)).sort()).toEqual(['first-export', 'second-export']);

    const secondTmjBytes = await readFile(secondExportPath);
    const secondCompanionBytes = await readFile(secondCompanionPath);
    expect(tiledSemantics(secondTmjBytes)).toEqual(firstTiled);
    const secondPng = pngPixels(secondCompanionBytes);
    expect(secondPng.width).toBe(firstPng.width);
    expect(secondPng.height).toBe(firstPng.height);
    expect(secondPng.rgba.equals(firstPng.rgba)).toBe(true);
    const afterReexport = await call('canvas_observe', { documentId: importedDocument.id });
    expect(afterReexport.document).toEqual(importedDocument);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(importedDocument);
    await page.getByTitle('Assets').click();
    await page.getByTitle('Layers').click();
    await page.screenshot({ path: reexportScreenshotPath });

    const finalJobs = await call('job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<Record<string, unknown>>;
    expect(jobSummaries.map((job) => ({ id: job.id, kind: job.kind, status: job.status }))).toEqual([
      { id: firstExportJobId, kind: 'export', status: 'completed' },
      { id: importJobId, kind: 'import', status: 'completed' },
      { id: secondExportJobId, kind: 'export', status: 'completed' },
    ]);
    expect(jobSummaries.every((job) => !Object.prototype.hasOwnProperty.call(job, 'result') && !Object.prototype.hasOwnProperty.call(job, 'approval'))).toBe(true);
    expect(JSON.stringify(finalJobs)).not.toContain(firstExportPath);
    expect(JSON.stringify(finalJobs)).not.toContain(secondExportPath);
    expect(jobSummaries.some((job) => job.kind === 'generation')).toBe(false);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    for (const screenshotPath of [authoredScreenshotPath, firstApprovalScreenshotPath, importApprovalScreenshotPath, importedScreenshotPath, secondApprovalScreenshotPath, reexportScreenshotPath]) expect(await access(screenshotPath).then(() => true, () => false)).toBe(true);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      documents: { source: { id: firstDocument.id, revision: firstDocument.revision }, imported: { id: importedDocument.id, revision: importedDocument.revision }, distinct: firstDocument.id !== importedDocument.id },
      supportedSurface: {
        orientation: 'orthogonal',
        infinite: true,
        width: 32,
        height: 32,
        tileWidth: 16,
        tileHeight: 16,
        typedProperties: firstTiled.map.properties,
        tileset: firstSemantics.tileset,
        chunkOrigins: expectedChunkOrigins,
        paintedCells: [...paintedCells].sort(cellOrder),
        canonicalImportEqual: true,
        rendererMatchedMcpBeforeFirstExport: true,
        rendererMatchedMcpAfterImport: true,
        rendererMatchedMcpAfterSecondExport: true,
      },
      interchange: {
        first: { path: firstExportPath, companionPath: firstCompanionPath, tmjBytes: firstTmjBytes.byteLength, tmjSha256: visualHash(firstTmjBytes), pngBytes: firstCompanionBytes.byteLength, pngSha256: visualHash(firstCompanionBytes) },
        second: { path: secondExportPath, companionPath: secondCompanionPath, tmjBytes: secondTmjBytes.byteLength, tmjSha256: visualHash(secondTmjBytes), pngBytes: secondCompanionBytes.byteLength, pngSha256: visualHash(secondCompanionBytes) },
        exactDirectoryBounds: true,
        supportedSemanticEquality: true,
        decodedPixelEquality: true,
        broadFullFidelityClaimed: false,
        isometricExercised: false,
        unsupportedModernFieldsExercised: false,
      },
      privacy: { publicJobSummariesRedacted: true, generationJobs: 0 },
      paidOrProviderRequests: 0,
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error('QA-06 Tiled round-trip packaged regression failed: ' + (error instanceof Error ? error.message : String(error)) + (diagnostic ? '\n' + diagnostic : ''));
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(regressionFailure.message + '\nGraceful cleanup also failed: ' + cleanupFailure.message)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-GEN closes an exact packaged deterministic generated-fill lifecycle', async () => {
  test.setTimeout(90_000);
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_GENERATION_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith(QA06_GENERATION_E2E_PROFILE_PREFIX)) {
      throw new Error(`AIDRAW_E2E_QA06_GENERATION_PROFILE must name a new ${QA06_GENERATION_E2E_PROFILE_PREFIX}* directory inside test-results/retained.`);
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact QA-06 generated-fill profile already exists: ${isolatedProfile}`);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, QA06_GENERATION_E2E_PROFILE_PREFIX));

  const connectionPath = join(isolatedProfile, QA06_GENERATION_E2E_CONNECTION_FILE);
  const mockOutputPath = join(isolatedProfile, QA06_GENERATION_E2E_OUTPUT_FILE);
  const mockAuditPath = join(isolatedProfile, QA06_GENERATION_E2E_AUDIT_FILE);
  const networkSentinelPath = join(isolatedProfile, QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE);
  const evidencePath = join(isolatedProfile, 'qa06-generated-fill-evidence.json');
  const denialScreenshotPath = join(isolatedProfile, 'qa06-generation-denial-approval.png');
  const timeoutScreenshotPath = join(isolatedProfile, 'qa06-generation-timeout-approval.png');
  const allowScreenshotPath = join(isolatedProfile, 'qa06-generation-allow-once-approval.png');
  const previewScreenshotPath = join(isolatedProfile, 'qa06-generation-preview.png');
  const acceptedScreenshotPath = join(isolatedProfile, 'qa06-generation-accepted.png');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    for (const path of [mockOutputPath, mockAuditPath, networkSentinelPath, evidencePath, denialScreenshotPath, timeoutScreenshotPath, allowScreenshotPath, previewScreenshotPath, acceptedScreenshotPath]) {
      expect(await access(path).then(() => true, () => false)).toBe(false);
    }
    const page = await launch(isolatedProfile, {
      environment: {
        NODE_ENV: 'test',
        AIDRAW_E2E_QA06_GENERATION_MOCK: '1',
        AIDRAW_E2E_QA06_GENERATION_PROFILE: isolatedProfile,
        AIDRAW_E2E_QA06_GENERATION_MOCK_OUTPUT_PATH: mockOutputPath,
        AIDRAW_E2E_QA06_GENERATION_MOCK_AUDIT_PATH: mockAuditPath,
        AIDRAW_E2E_QA06_GENERATION_NETWORK_SENTINEL_PATH: networkSentinelPath,
      },
      extraArguments: [`--write-mcp-connection=${connectionPath}`],
    });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 generated-fill package has no engine PID.');
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Illustration/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill(QA06_GENERATION_E2E_DOCUMENT_NAME);
    await newDocumentDialog.getByLabel('Document width').fill('320');
    await newDocumentDialog.getByLabel('Document height').fill('240');
    await newDocumentDialog.getByRole('button', { name: 'Create Illustration' }).click();
    const initial = await page.evaluate(async () => {
      const document = (await window.aidraw.bootstrap()).activeDocument;
      if (!document || document.kind !== 'illustration') throw new Error('The QA-06 generated-fill illustration is unavailable.');
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'vector') throw new Error('The QA-06 generated-fill vector layer is unavailable.');
      return { documentId: document.id, layerId: layer.id, revision: document.revision, name: document.name, width: document.artboard.width, height: document.artboard.height };
    });
    expect(initial).toMatchObject({ name: QA06_GENERATION_E2E_DOCUMENT_NAME, width: 320, height: 240 });

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-generated-fill', {
      name: 'QA-06 generated fill agent',
      color: '#d26682',
      documentId: initial.documentId,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);

    const sourceCanvas = createCanvas(192, 128); const sourceContext = sourceCanvas.getContext('2d'); sourceContext.fillStyle = '#26324a'; sourceContext.fillRect(0, 0, 192, 128); sourceContext.fillStyle = '#6f86bd'; sourceContext.fillRect(20, 20, 152, 88); sourceContext.fillStyle = '#d26682'; sourceContext.fillRect(64, 40, 64, 48); const sourceBytes = sourceCanvas.toBuffer('image/png');
    const maskCanvas = createCanvas(192, 128); const maskContext = maskCanvas.getContext('2d'); maskContext.clearRect(0, 0, 192, 128); maskContext.fillStyle = '#ffffff'; maskContext.fillRect(48, 32, 96, 64); const maskBytes = maskCanvas.toBuffer('image/png');
    const asset = (id: string, name: string, bytes: Buffer) => ({ id, name, mimeType: 'image/png', byteLength: bytes.byteLength, sha256: visualHash(bytes), source: 'imported', data: bytes.toString('base64') });
    const timestamp = new Date().toISOString();
    const seeded = await call('canvas_apply', {
      documentId: initial.documentId,
      clientOperationId: 'qa06-generated-fill-fixture',
      label: 'QA-06 install generated-fill source and mask',
      playback: { mode: 'instant', speed: 1 },
      operations: [
        { kind: 'asset.add', asset: asset(QA06_GENERATION_E2E_SOURCE_ASSET_ID, 'QA-06 fill source', sourceBytes) },
        { kind: 'asset.add', asset: asset(QA06_GENERATION_E2E_MASK_ASSET_ID, 'QA-06 fill mask', maskBytes) },
        {
          kind: 'illustration.object.add',
          object: {
            id: 'qa06-generation-source-object', revision: 0, name: 'QA-06 source artwork', createdAt: timestamp, updatedAt: timestamp,
            createdBy: client.actor.id, layerId: initial.layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
            transform: { x: 64, y: 56, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
            type: 'image', assetId: QA06_GENERATION_E2E_SOURCE_ASSET_ID, width: 192, height: 128, sourceWidth: 192, sourceHeight: 128, filters: [],
          },
        },
      ],
    });
    expect(seeded).toMatchObject({ status: 'committed', revision: initial.revision + 1 });
    const beforeObserved = await call('canvas_observe', { documentId: initial.documentId, includePng: true, scale: 1, background: 'document' });
    const beforeDocument = beforeObserved.document as IllustrationDocument;
    const beforePng = beforeObserved.png as { available: boolean; data: string; width: number; height: number };
    expect(beforePng).toMatchObject({ available: true, width: 320, height: 240 });
    expect(beforeDocument).toMatchObject({ id: initial.documentId, revision: initial.revision + 1, name: QA06_GENERATION_E2E_DOCUMENT_NAME, kind: 'illustration' });
    expect(beforeDocument.objects['qa06-generation-source-object']).toMatchObject({ createdBy: client.actor.id, assetId: QA06_GENERATION_E2E_SOURCE_ASSET_ID });
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(beforeDocument);
    const beforeCanonicalSha256 = visualHash(Buffer.from(JSON.stringify(beforeDocument), 'utf8'));
    const beforeCanvasSha256 = visualHash(Buffer.from(beforePng.data, 'base64'));

    const generationArguments = { documentId: initial.documentId, ...structuredClone(QA06_GENERATION_E2E_REQUEST) };
    const startGeneration = () => call('generation_start', generationArguments);
    const assertFullApproval = async (jobId: string, returnedExpiresAt: string, screenshotPath?: string) => {
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      const card = page.locator('.approval-card').filter({ hasText: 'Generate imagery' });
      await expect(card).toBeVisible();
      await expect(card.locator('.approval-heading strong')).toHaveText('Generate imagery');
      await expect(card.locator('.approval-heading small')).toHaveText('QA-06 generated fill agent requests approval');
      await expect(card.locator('p')).toHaveText('Review provider, prompt, sources, mask, result count, and the potentially paid request count.');
      const fields = await card.locator('.approval-review > div').evaluateAll((rows) => rows.map((row) => [row.querySelector('dt')?.textContent?.trim(), row.querySelector('dd')?.textContent?.trim()]));
      expect(fields).toEqual([
        ['Provider', 'stability'],
        ['Model / workflow', 'Stability generation API'],
        ['Mode', 'inpaint'],
        ['Prompt', QA06_GENERATION_E2E_REQUEST.prompt],
        ['Negative prompt', QA06_GENERATION_E2E_REQUEST.negativePrompt],
        ['Source assets', QA06_GENERATION_E2E_SOURCE_ASSET_ID],
        ['Mask asset', QA06_GENERATION_E2E_MASK_ASSET_ID],
        ['Requested results', '1'],
        ['Potential paid requests', '1'],
        ['Size', JSON.stringify(QA06_GENERATION_E2E_REQUEST.size)],
        ['Seed', String(QA06_GENERATION_E2E_REQUEST.seed)],
        ['Provider options', JSON.stringify(QA06_GENERATION_E2E_REQUEST.providerOptions)],
      ]);
      await expect(card.getByRole('img', { name: 'Source: QA-06 fill source' })).toBeVisible();
      await expect(card.getByRole('img', { name: 'Mask: QA-06 fill mask' })).toBeVisible();
      await expect(card.locator('.approval-previews figcaption')).toContainText(['192 × 128px · image/png', '192 × 128px · image/png']);
      await expect(card.locator('.generation-trust-note')).toHaveText('This approval authorizes this exact provider request once. It does not trust future prompts, providers, source assets, or paid requests.');
      expect((await card.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual(['Deny', 'Allow once']);
      const canonical = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
      expect(canonical).toMatchObject({
        id: jobId,
        kind: 'generation',
        status: 'waiting-for-user',
        actor: client.actor,
        approval: { options: ['allow-once', 'deny'], review: { fields: expect.any(Array), previews: expect.any(Array) } },
        result: { documentId: initial.documentId, request: generationArguments },
      });
      const expiresAt = canonical?.approval?.expiresAt;
      expect(expiresAt).toBe(returnedExpiresAt);
      const expiryDuration = new Date(String(expiresAt)).getTime() - new Date(String(canonical?.createdAt)).getTime();
      expect(expiryDuration).toBeGreaterThanOrEqual(19_900);
      expect(expiryDuration).toBeLessThanOrEqual(20_100);
      if (screenshotPath) await card.screenshot({ path: screenshotPath });
      return card;
    };
    const assertCanonicalUnchanged = async () => {
      const observed = await call('canvas_observe', { documentId: initial.documentId });
      expect(observed.document).toEqual(beforeDocument);
      expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(beforeDocument);
      expect(visualHash(Buffer.from(JSON.stringify(observed.document), 'utf8'))).toBe(beforeCanonicalSha256);
    };
    const assertFixtureNotRun = async () => {
      expect(await access(mockOutputPath).then(() => true, () => false)).toBe(false);
      expect(await access(mockAuditPath).then(() => true, () => false)).toBe(false);
      expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
      expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);
    };

    const denied = await startGeneration();
    expect(denied).toMatchObject({ status: 'waiting-for-user', expiresAt: expect.any(String) });
    const deniedJobId = String(denied.jobId);
    const deniedCard = await assertFullApproval(deniedJobId, String(denied.expiresAt), denialScreenshotPath);
    const deniedPublic = await call('job_manage', { action: 'inspect', jobId: deniedJobId });
    expect(deniedPublic).toMatchObject({ id: deniedJobId, actor: client.actor, status: 'waiting-for-user', dependency: { kind: 'user-approval', permittedDecisions: ['allow-once', 'deny'] } });
    expect(deniedPublic).not.toHaveProperty('approval'); expect(deniedPublic).not.toHaveProperty('result'); expect(JSON.stringify(deniedPublic)).not.toContain(QA06_GENERATION_E2E_REQUEST.prompt);
    await deniedCard.getByRole('button', { name: 'Deny', exact: true }).click();
    const deniedResult = await call('job_manage', { action: 'wait', jobId: deniedJobId, timeoutMs: 5_000 });
    expect(deniedResult).toMatchObject({ id: deniedJobId, status: 'cancelled', message: 'Denied in AIDraw.' });
    await assertCanonicalUnchanged(); await assertFixtureNotRun();

    const timeoutStartedAt = Date.now();
    const timed = await startGeneration();
    const timedJobId = String(timed.jobId);
    const timedCard = await assertFullApproval(timedJobId, String(timed.expiresAt), timeoutScreenshotPath);
    const timedResult = await call('job_manage', { action: 'wait', jobId: timedJobId, timeoutMs: 30_000 });
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    expect(timedResult).toMatchObject({ id: timedJobId, status: 'cancelled', message: 'Approval timed out after 20 seconds.', error: { code: 'approval_timeout', message: 'The in-app approval expired.', retryable: true } });
    expect(timeoutElapsedMs).toBeGreaterThanOrEqual(18_000); expect(timeoutElapsedMs).toBeLessThan(30_000);
    await expect(timedCard).toHaveCount(0);
    await assertCanonicalUnchanged(); await assertFixtureNotRun();

    const cancelled = await startGeneration();
    const cancelledJobId = String(cancelled.jobId);
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    const cancelledCard = page.locator('.approval-card').filter({ hasText: 'Generate imagery' });
    await expect(cancelledCard).toBeVisible();
    const boundedWaitStartedAt = Date.now();
    const waiting = await call('job_manage', { action: 'wait', jobId: cancelledJobId, timeoutMs: 250 });
    const boundedWaitElapsedMs = Date.now() - boundedWaitStartedAt;
    expect(waiting).toMatchObject({ id: cancelledJobId, status: 'waiting-for-user', dependency: { kind: 'user-approval' } });
    expect(boundedWaitElapsedMs).toBeLessThan(2_000);
    const cancelledResult = await call('job_manage', { action: 'cancel', jobId: cancelledJobId });
    expect(cancelledResult).toMatchObject({ id: cancelledJobId, status: 'cancelled', message: 'Generation cancelled.' });
    await expect(cancelledCard).toHaveCount(0);
    await assertCanonicalUnchanged(); await assertFixtureNotRun();

    const allowed = await startGeneration();
    const allowedJobId = String(allowed.jobId);
    const allowedCard = await assertFullApproval(allowedJobId, String(allowed.expiresAt), allowScreenshotPath);
    await allowedCard.getByRole('button', { name: 'Allow once', exact: true }).click();
    const allowedResult = await call('job_manage', { action: 'wait', jobId: allowedJobId, timeoutMs: 10_000 });
    expect(allowedResult).toMatchObject({ id: allowedJobId, kind: 'generation', status: 'completed', actor: client.actor, progress: 1 });
    expect(allowedResult).not.toHaveProperty('result');
    expect(JSON.stringify(allowedResult)).not.toContain(QA06_GENERATION_E2E_REQUEST.prompt);
    expect(JSON.stringify(allowedResult)).not.toContain(QA06_GENERATION_E2E_OUTPUT_FILE);
    expect(await access(mockOutputPath).then(() => true, () => false)).toBe(true);
    expect(await access(mockAuditPath).then(() => true, () => false)).toBe(true);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    const mockOutputBytes = await readFile(mockOutputPath);
    const mockAuditText = await readFile(mockAuditPath, 'utf8');
    const mockAudit = JSON.parse(mockAuditText) as { invocationCount: number; transport: string; output: { byteLength: number; sha256: string; width: number; height: number }; hostedKeyReceived: boolean; externalProviderRequests: number; paidRequests: number };
    expect(mockAudit).toMatchObject({ invocationCount: 1, transport: 'in-process-deterministic-runner', output: { byteLength: mockOutputBytes.byteLength, sha256: visualHash(mockOutputBytes), width: 192, height: 128 }, hostedKeyReceived: false, externalProviderRequests: 0, paidRequests: 0 });
    expect(mockAuditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const canonicalCompleted = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), allowedJobId);
    expect(canonicalCompleted).toMatchObject({
      id: allowedJobId,
      status: 'completed',
      actor: client.actor,
      result: {
        request: generationArguments,
        outputs: [{ id: 'qa06-generated-fill-result', mimeType: 'image/png', width: 192, height: 128, seed: QA06_GENERATION_E2E_REQUEST.seed, providerMetadata: { fixture: 'qa06-generated-fill', transport: 'deterministic-local', externalProviderRequests: 0, paidRequests: 0 } }],
      },
    });
    const completedOutput = (canonicalCompleted?.result as { outputs?: Array<{ data: string }> } | undefined)?.outputs?.[0];
    if (!completedOutput) throw new Error('The canonical generated output is unavailable in the isolated renderer/service snapshot.');
    expect(Buffer.from(completedOutput.data, 'base64')).toEqual(mockOutputBytes);

    await page.getByRole('tab', { name: 'Generate', exact: true }).click();
    const resultCard = page.locator('.result-card').filter({ has: page.getByRole('img', { name: 'Generated result' }) });
    await expect(resultCard).toBeVisible();
    await resultCard.getByRole('button', { name: 'Compare', exact: true }).click();
    const compareDialog = page.getByRole('dialog', { name: 'Compare generated result' });
    await expect(compareDialog.getByRole('img', { name: 'Source before generation' })).toBeVisible();
    await expect(compareDialog.getByRole('img', { name: 'Generated result' })).toBeVisible();
    await compareDialog.screenshot({ path: previewScreenshotPath });
    await compareDialog.getByRole('button', { name: 'Accept as new layer/cel', exact: true }).click();
    await expect(compareDialog).toHaveCount(0);
    await expect(resultCard.getByRole('button', { name: 'Accepted', exact: true })).toBeDisabled();

    const afterObserved = await call('canvas_observe', { documentId: initial.documentId, includePng: true, scale: 1, background: 'document' });
    const afterDocument = afterObserved.document as IllustrationDocument;
    const afterPng = afterObserved.png as { available: boolean; data: string; width: number; height: number };
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(afterDocument);
    expect(afterDocument.revision).toBe(beforeDocument.revision + 1);
    expect(afterDocument.objects['qa06-generation-source-object']).toEqual(beforeDocument.objects['qa06-generation-source-object']);
    expect(afterDocument.assets[QA06_GENERATION_E2E_SOURCE_ASSET_ID]).toEqual(beforeDocument.assets[QA06_GENERATION_E2E_SOURCE_ASSET_ID]);
    expect(afterDocument.assets[QA06_GENERATION_E2E_MASK_ASSET_ID]).toEqual(beforeDocument.assets[QA06_GENERATION_E2E_MASK_ASSET_ID]);
    expect(Object.keys(afterDocument.layers)).toHaveLength(Object.keys(beforeDocument.layers).length + 1);
    expect(Object.keys(afterDocument.objects)).toHaveLength(Object.keys(beforeDocument.objects).length + 1);
    expect(Object.keys(afterDocument.assets)).toHaveLength(Object.keys(beforeDocument.assets).length + 1);
    const generatedAsset = Object.values(afterDocument.assets).find((entry) => entry.source === 'generated');
    if (!generatedAsset) throw new Error('The accepted generated asset is absent from canonical state.');
    expect(generatedAsset).toMatchObject({ mimeType: 'image/png', byteLength: mockOutputBytes.byteLength, sha256: visualHash(mockOutputBytes) });
    const generatedObject = Object.values(afterDocument.objects).find((entry) => entry.type === 'image' && entry.assetId === generatedAsset.id);
    if (!generatedObject) throw new Error('The accepted generated image object is absent from canonical state.');
    const generatedLayer = afterDocument.layers[generatedObject.layerId];
    if (!generatedLayer) throw new Error('The accepted generated layer is absent from canonical state.');
    const acceptanceActivity = afterDocument.activity.at(-1);
    expect(generatedObject).toMatchObject({ name: 'Generated image', createdBy: HUMAN_ACTOR.id, width: 192, height: 128, transform: { x: 64, y: 56, scaleX: 1, scaleY: 1 } });
    expect(generatedLayer).toMatchObject({ name: 'Generated result', createdBy: HUMAN_ACTOR.id });
    expect(acceptanceActivity).toMatchObject({ actor: HUMAN_ACTOR, label: 'Accept generated image', status: 'committed' });
    expect(afterDocument.provenance).toHaveLength(1);
    const generatedProvenance = afterDocument.provenance[0];
    expect(generatedProvenance).toMatchObject({ assetId: generatedAsset.id, provider: 'stability', modelOrWorkflow: 'stable-image-core', seed: QA06_GENERATION_E2E_REQUEST.seed, sourceAssetIds: [QA06_GENERATION_E2E_SOURCE_ASSET_ID], maskAssetId: QA06_GENERATION_E2E_MASK_ASSET_ID });
    expect(afterPng).toMatchObject({ available: true, width: 320, height: 240 });
    const afterCanvasSha256 = visualHash(Buffer.from(afterPng.data, 'base64'));
    expect(afterCanvasSha256).not.toBe(beforeCanvasSha256);
    await page.getByRole('application', { name: /Illustration canvas/ }).screenshot({ path: acceptedScreenshotPath });
    const canonicalAcceptedJob = await page.evaluate(async (jobId) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === jobId), allowedJobId);
    expect(canonicalAcceptedJob).toMatchObject({ actor: client.actor, result: { acceptedOutputId: 'qa06-generated-fill-result' } });

    const finalJobs = await call('job_manage', { action: 'list' });
    const jobSummaries = finalJobs.jobs as Array<{ id: string; kind: string; status: string }>;
    expect(jobSummaries.map(({ id, kind, status }) => ({ id, kind, status }))).toEqual([
      { id: deniedJobId, kind: 'generation', status: 'cancelled' },
      { id: timedJobId, kind: 'generation', status: 'cancelled' },
      { id: cancelledJobId, kind: 'generation', status: 'cancelled' },
      { id: allowedJobId, kind: 'generation', status: 'completed' },
    ]);
    expect(JSON.stringify(finalJobs)).not.toContain(QA06_GENERATION_E2E_REQUEST.prompt);
    expect(JSON.stringify(finalJobs)).not.toContain('qa06-generated-fill-result');
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    for (const screenshotPath of [denialScreenshotPath, timeoutScreenshotPath, allowScreenshotPath, previewScreenshotPath, acceptedScreenshotPath]) expect(await access(screenshotPath).then(() => true, () => false)).toBe(true);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      attribution: {
        requestingAgent: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
        acceptingHuman: { id: HUMAN_ACTOR.id, name: HUMAN_ACTOR.name, color: HUMAN_ACTOR.color },
        generatedObjectCreatedBy: generatedObject.createdBy,
        generatedLayerCreatedBy: generatedLayer.createdBy,
        acceptanceTransactionId: acceptanceActivity?.transactionId,
      },
      approval: {
        completeFields: ['Provider', 'Model / workflow', 'Mode', 'Prompt', 'Negative prompt', 'Source assets', 'Mask asset', 'Requested results', 'Potential paid requests', 'Size', 'Seed', 'Provider options'],
        choices: ['deny', 'allow-once'],
        expiryMs: 20_000,
        denied: { jobId: deniedJobId, status: deniedResult.status, canonicalUnchanged: true },
        timedOut: { jobId: timedJobId, status: timedResult.status, elapsedMs: timeoutElapsedMs, error: timedResult.error, canonicalUnchanged: true },
        cancelled: { jobId: cancelledJobId, status: cancelledResult.status, boundedWaitMs: boundedWaitElapsedMs, canonicalUnchanged: true },
        allowOnce: { jobId: allowedJobId, status: allowedResult.status },
      },
      document: {
        id: afterDocument.id,
        revisionBefore: beforeDocument.revision,
        revisionAfter: afterDocument.revision,
        beforeCanonicalSha256,
        existingSourceObjectPreserved: true,
        acceptedNonDestructively: true,
        generatedAsset: { id: generatedAsset.id, byteLength: generatedAsset.byteLength, sha256: generatedAsset.sha256 },
        provenance: { count: afterDocument.provenance.length, provider: generatedProvenance.provider, modelOrWorkflow: generatedProvenance.modelOrWorkflow, seed: generatedProvenance.seed },
      },
      visible: { beforeCanvasSha256, afterCanvasSha256, generatedPreviewShown: true, comparisonShown: true },
      canonicalAgreement: { rendererMatchedMcp: true, acceptedOutputMatchedMock: true, publicJobSummariesRedacted: true },
      mockProvider: { outputPath: mockOutputPath, auditPath: mockAuditPath, outputByteLength: mockOutputBytes.byteLength, outputSha256: visualHash(mockOutputBytes), invocationCount: mockAudit.invocationCount, transport: mockAudit.transport },
      networkAndCost: { externalProviderRequests: mockAudit.externalProviderRequests, paidRequests: mockAudit.paidRequests, hostedKeyReceived: mockAudit.hostedKeyReceived, forbiddenRequestSentinelAbsent: true, providerCredentialFileAbsent: true },
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`QA-06 generated-fill packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('QA-06-PALETTE closes an exact packaged generated-image indexed conversion lifecycle', async () => {
  test.setTimeout(90_000);
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  await mkdir(retainedRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_QA06_PIXEL_PALETTE_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const retainedRelative = relative(retainedRoot, isolatedProfile);
    if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(isolatedProfile).startsWith(QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX)) {
      throw new Error(`AIDRAW_E2E_QA06_PIXEL_PALETTE_PROFILE must name a new ${QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX}* directory inside test-results/retained.`);
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact QA-06 pixel-palette profile already exists: ${isolatedProfile}`);
  } else isolatedProfile = await mkdtemp(join(retainedRoot, QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX));

  const connectionPath = join(isolatedProfile, QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE);
  const mockOutputPath = join(isolatedProfile, QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE);
  const mockAuditPath = join(isolatedProfile, QA06_PIXEL_PALETTE_E2E_AUDIT_FILE);
  const networkSentinelPath = join(isolatedProfile, QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE);
  const evidencePath = join(isolatedProfile, 'qa06-pixel-palette-evidence.json');
  const settingsScreenshotPath = join(isolatedProfile, 'qa06-pixel-palette-settings.png');
  const approvalScreenshotPath = join(isolatedProfile, 'qa06-pixel-palette-approval.png');
  const previewScreenshotPath = join(isolatedProfile, 'qa06-pixel-palette-preview.png');
  const acceptedScreenshotPath = join(isolatedProfile, 'qa06-pixel-palette-accepted.png');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    for (const path of [connectionPath, mockOutputPath, mockAuditPath, networkSentinelPath, evidencePath, settingsScreenshotPath, approvalScreenshotPath, previewScreenshotPath, acceptedScreenshotPath, trustSettingsPath, providerCredentialsPath]) {
      expect(await access(path).then(() => true, () => false)).toBe(false);
    }
    const page = await launch(isolatedProfile, {
      environment: {
        NODE_ENV: 'test',
        AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK: '1',
        AIDRAW_E2E_QA06_PIXEL_PALETTE_PROFILE: isolatedProfile,
        AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK_OUTPUT_PATH: mockOutputPath,
        AIDRAW_E2E_QA06_PIXEL_PALETTE_MOCK_AUDIT_PATH: mockAuditPath,
        AIDRAW_E2E_QA06_PIXEL_PALETTE_NETWORK_SENTINEL_PATH: networkSentinelPath,
      },
      extraArguments: [`--write-mcp-connection=${connectionPath}`],
    });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated QA-06 pixel-palette package has no engine PID.');
    expect(page.url()).toMatch(/^aidraw:\/\/app\//);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Pixel Sprite/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill(QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME);
    await newDocumentDialog.getByLabel('Document width').fill('16');
    await newDocumentDialog.getByLabel('Document height').fill('16');
    await newDocumentDialog.getByRole('button', { name: 'Create Pixel Sprite' }).click();
    await expect(page.locator('.status-mode').filter({ hasText: /^Pixel Art$/ })).toBeVisible();

    const conversionEditor = page.locator('.conversion-editor');
    await expect(conversionEditor.getByText('Generated-image conversion', { exact: true })).toBeVisible();
    await conversionEditor.getByLabel('Dithering').selectOption('bayer-4x4');
    const alphaThreshold = conversionEditor.getByRole('slider', { name: /Alpha threshold/ });
    await alphaThreshold.fill('60');
    await expect(conversionEditor.getByLabel('Dithering')).toHaveValue('bayer-4x4');
    await expect(alphaThreshold).toHaveValue('60');
    await conversionEditor.screenshot({ path: settingsScreenshotPath });

    const initialDocument = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!initialDocument || initialDocument.kind !== 'pixel') throw new Error('The QA-06 pixel-palette document is unavailable.');
    const initialSprite = initialDocument.pixelAssets[initialDocument.activeAssetId];
    if (initialSprite.type !== 'sprite' || initialSprite.width !== 16 || initialSprite.height !== 16 || initialSprite.frameIds.length !== 1) throw new Error('The QA-06 one-frame 16×16 sprite is unavailable.');
    expect(initialDocument).toMatchObject({ name: QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME, standaloneType: 'sprite', conversionDefaults: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.6 } });

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'qa06-pixel-palette', {
      name: 'QA-06 pixel palette agent',
      color: '#3978b8',
      documentId: initialDocument.id,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);
    const beforeObserved = await call('canvas_observe', { documentId: initialDocument.id, includePng: true, scale: 8, background: 'transparent' });
    const beforeDocument = beforeObserved.document as PixelDocument;
    const beforePng = beforeObserved.png as { available: boolean; data: string; width: number; height: number };
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(beforeDocument);
    expect(beforePng).toMatchObject({ available: true, width: 128, height: 128 });
    const beforeSprite = beforeDocument.pixelAssets[beforeDocument.activeAssetId];
    if (beforeSprite.type !== 'sprite') throw new Error('The canonical pre-conversion sprite is unavailable.');
    const beforeLayerIds = [...beforeSprite.layerIds];
    const beforeCels = structuredClone(beforeSprite.cels);
    const beforePalette = structuredClone(beforeDocument.palette);
    const beforeCanvasSha256 = visualHash(Buffer.from(beforePng.data, 'base64'));

    const generationArguments = { documentId: initialDocument.id, ...structuredClone(QA06_PIXEL_PALETTE_E2E_REQUEST) };
    const started = await call('generation_start', generationArguments);
    expect(started).toMatchObject({ status: 'waiting-for-user', expiresAt: expect.any(String) });
    const jobId = String(started.jobId);
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    const approvalCard = page.locator('.approval-card').filter({ hasText: 'Generate imagery' });
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard.locator('.approval-heading small')).toHaveText('QA-06 pixel palette agent requests approval');
    const approvalFields = await approvalCard.locator('.approval-review > div').evaluateAll((rows) => rows.map((row) => [row.querySelector('dt')?.textContent?.trim(), row.querySelector('dd')?.textContent?.trim()]));
    expect(approvalFields).toEqual([
      ['Provider', 'stability'],
      ['Model / workflow', 'Stability generation API'],
      ['Mode', 'create'],
      ['Prompt', QA06_PIXEL_PALETTE_E2E_REQUEST.prompt],
      ['Negative prompt', QA06_PIXEL_PALETTE_E2E_REQUEST.negativePrompt],
      ['Source assets', 'None'],
      ['Requested results', '1'],
      ['Potential paid requests', '1'],
      ['Size', JSON.stringify(QA06_PIXEL_PALETTE_E2E_REQUEST.size)],
      ['Seed', String(QA06_PIXEL_PALETTE_E2E_REQUEST.seed)],
      ['Provider options', JSON.stringify(QA06_PIXEL_PALETTE_E2E_REQUEST.providerOptions)],
    ]);
    await expect(approvalCard.locator('.generation-trust-note')).toHaveText('This approval authorizes this exact provider request once. It does not trust future prompts, providers, source assets, or paid requests.');
    expect((await approvalCard.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual(['Deny', 'Allow once']);
    await approvalCard.screenshot({ path: approvalScreenshotPath });
    const publicWaiting = await call('job_manage', { action: 'inspect', jobId });
    expect(publicWaiting).toMatchObject({ id: jobId, actor: client.actor, status: 'waiting-for-user', dependency: { kind: 'user-approval', permittedDecisions: ['allow-once', 'deny'] } });
    expect(publicWaiting).not.toHaveProperty('approval'); expect(publicWaiting).not.toHaveProperty('result');
    expect(JSON.stringify(publicWaiting)).not.toContain(QA06_PIXEL_PALETTE_E2E_REQUEST.prompt);

    await approvalCard.getByRole('button', { name: 'Allow once', exact: true }).click();
    const completed = await call('job_manage', { action: 'wait', jobId, timeoutMs: 10_000 });
    expect(completed).toMatchObject({ id: jobId, kind: 'generation', status: 'completed', actor: client.actor, progress: 1 });
    expect(completed).not.toHaveProperty('result');
    expect(await access(mockOutputPath).then(() => true, () => false)).toBe(true);
    expect(await access(mockAuditPath).then(() => true, () => false)).toBe(true);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    const mockOutputBytes = await readFile(mockOutputPath);
    const mockAuditText = await readFile(mockAuditPath, 'utf8');
    const mockAudit = JSON.parse(mockAuditText) as { invocationCount: number; transport: string; output: { byteLength: number; sha256: string; width: number; height: number }; hostedKeyReceived: boolean; externalProviderRequests: number; paidRequests: number };
    expect(mockAudit).toMatchObject({ invocationCount: 1, transport: 'in-process-deterministic-runner', output: { byteLength: mockOutputBytes.byteLength, sha256: visualHash(mockOutputBytes), width: 32, height: 32 }, hostedKeyReceived: false, externalProviderRequests: 0, paidRequests: 0 });
    expect(mockAuditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const canonicalCompleted = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
    expect(canonicalCompleted).toMatchObject({ id: jobId, status: 'completed', actor: client.actor, result: { request: generationArguments, outputs: [{ id: 'qa06-pixel-palette-result', width: 32, height: 32, seed: QA06_PIXEL_PALETTE_E2E_REQUEST.seed }] } });
    const completedOutput = (canonicalCompleted?.result as { outputs?: Array<{ data: string }> } | undefined)?.outputs?.[0];
    if (!completedOutput) throw new Error('The canonical pixel-palette output is unavailable in the isolated renderer/service snapshot.');
    expect(Buffer.from(completedOutput.data, 'base64')).toEqual(mockOutputBytes);

    await page.getByRole('tab', { name: 'Generate', exact: true }).click();
    await expect(page.locator('.pixel-conversion-note')).toContainText(/Pixel conversion enabled\s*Area downsample · OKLab match · bayer-4x4/);
    const resultCard = page.locator('.result-card').filter({ has: page.getByRole('img', { name: 'Generated result' }) });
    await expect(resultCard).toBeVisible();
    await resultCard.getByRole('button', { name: 'Compare', exact: true }).click();
    const compareDialog = page.getByRole('dialog', { name: 'Compare generated result' });
    await expect(compareDialog.getByRole('img', { name: 'Source before generation' })).toBeVisible();
    await expect(compareDialog.getByRole('img', { name: 'Generated result' })).toBeVisible();
    await compareDialog.screenshot({ path: previewScreenshotPath });
    await compareDialog.getByRole('button', { name: 'Accept as new layer/cel', exact: true }).click();
    await expect(compareDialog).toHaveCount(0);

    const afterObserved = await call('canvas_observe', { documentId: initialDocument.id, includePng: true, scale: 8, background: 'transparent' });
    const afterDocument = afterObserved.document as PixelDocument;
    const afterPng = afterObserved.png as { available: boolean; data: string; width: number; height: number };
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(afterDocument);
    expect(afterDocument.revision).toBe(beforeDocument.revision + 1);
    expect(afterDocument.palette).toEqual(beforePalette);
    expect(afterDocument.conversionDefaults).toEqual({ resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.6 });
    expect(afterDocument.activeAssetId).toBe(beforeDocument.activeAssetId);
    const afterSprite = afterDocument.pixelAssets[afterDocument.activeAssetId];
    if (afterSprite.type !== 'sprite') throw new Error('The canonical converted sprite is unavailable.');
    expect(afterSprite.frameIds).toEqual(beforeSprite.frameIds);
    expect(afterSprite.layerIds).toHaveLength(beforeLayerIds.length + 1);
    for (const [celId, cel] of Object.entries(beforeCels)) expect(afterSprite.cels[celId]).toEqual(cel);
    const generatedLayerId = afterSprite.layerIds.find((id) => !beforeLayerIds.includes(id));
    if (!generatedLayerId) throw new Error('The generated indexed layer is unavailable.');
    const generatedLayer = afterSprite.layers[generatedLayerId];
    const generatedCels = Object.values(afterSprite.cels).filter((cel) => cel.layerId === generatedLayerId);
    expect(generatedLayer).toMatchObject({ name: 'Generated result', createdBy: HUMAN_ACTOR.id, type: 'pixel' });
    expect(generatedCels).toHaveLength(1);
    expect(generatedCels[0]).toMatchObject({ frameId: afterSprite.frameIds[0], createdBy: HUMAN_ACTOR.id });
    const actualIndices: number[] = [];
    const expectedIndices: number[] = [];
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
      actualIndices.push(readPixel(generatedCels[0], x, y));
      expectedIndices.push(qa06PixelPaletteExpectedIndex(x, y));
    }
    expect(actualIndices).toEqual(expectedIndices);
    const indexCounts = actualIndices.reduce<Record<number, number>>((counts, index) => ({ ...counts, [index]: (counts[index] ?? 0) + 1 }), {});
    expect(Object.values(indexCounts).reduce((total, count) => total + count, 0)).toBe(256);
    expect(Object.keys(indexCounts).map(Number).sort((left, right) => left - right)).toEqual([0, 1, 4, 7, 9, 15]);
    const generatedAsset = Object.values(afterDocument.assets).find((asset) => asset.source === 'generated');
    if (!generatedAsset) throw new Error('The retained generated source asset is unavailable.');
    expect(generatedAsset).toMatchObject({ mimeType: 'image/png', byteLength: mockOutputBytes.byteLength, sha256: visualHash(mockOutputBytes) });
    expect(afterDocument.provenance).toEqual([expect.objectContaining({ assetId: generatedAsset.id, provider: 'stability', modelOrWorkflow: 'stable-image-core', seed: QA06_PIXEL_PALETTE_E2E_REQUEST.seed, sourceAssetIds: [], conversion: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.6, width: 16, height: 16 } })]);
    const acceptanceActivity = afterDocument.activity.at(-1);
    expect(acceptanceActivity).toMatchObject({ actor: HUMAN_ACTOR, label: 'Accept generated image into palette', status: 'committed' });
    expect(afterPng).toMatchObject({ available: true, width: 128, height: 128 });
    const afterCanvasSha256 = visualHash(Buffer.from(afterPng.data, 'base64'));
    expect(afterCanvasSha256).not.toBe(beforeCanvasSha256);
    await page.getByRole('application', { name: /Pixel-art canvas/ }).screenshot({ path: acceptedScreenshotPath });
    const canonicalAcceptedJob = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
    expect(canonicalAcceptedJob).toMatchObject({ actor: client.actor, result: { acceptedOutputId: 'qa06-pixel-palette-result' } });
    const publicFinal = await call('job_manage', { action: 'list' });
    expect(publicFinal.jobs).toEqual([expect.objectContaining({ id: jobId, kind: 'generation', status: 'completed', actor: client.actor })]);
    expect(JSON.stringify(publicFinal)).not.toContain(QA06_PIXEL_PALETTE_E2E_REQUEST.prompt);
    expect(JSON.stringify(publicFinal)).not.toContain('qa06-pixel-palette-result');
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    for (const screenshotPath of [settingsScreenshotPath, approvalScreenshotPath, previewScreenshotPath, acceptedScreenshotPath]) expect(await access(screenshotPath).then(() => true, () => false)).toBe(true);
    expect(applicationProcess?.pid).toBe(enginePid);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(JSON.stringify(redactedConnection)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      package: { executable: packagedExecutable, enginePid },
      actor: { id: client.actor.id, name: client.actor.name, color: client.actor.color },
      approval: { actor: client.actor.name, completePayload: true, choices: ['deny', 'allow-once'], allowedOnce: true },
      document: {
        id: afterDocument.id,
        revisionBefore: beforeDocument.revision,
        revisionAfter: afterDocument.revision,
        activeSpriteId: afterSprite.id,
        frameCount: afterSprite.frameIds.length,
        originalLayersPreserved: true,
        generatedLayerId,
        generatedCelId: generatedCels[0].id,
        palettePreserved: true,
        indexCounts,
        conversion: afterDocument.provenance[0].conversion,
        generatedSource: { byteLength: generatedAsset.byteLength, sha256: generatedAsset.sha256 },
      },
      attribution: { requestingAgent: client.actor, acceptingHuman: HUMAN_ACTOR, generatedLayerCreatedBy: generatedLayer.createdBy, generatedCelCreatedBy: generatedCels[0].createdBy, acceptanceTransactionId: acceptanceActivity?.transactionId },
      canonicalAgreement: { rendererMatchedMcp: true, convertedIndicesMatchedFixture: true, acceptedOutputMatchedMock: true, publicJobSummariesRedacted: true },
      visible: { settingsShown: true, approvalShown: true, comparisonShown: true, acceptedCanvasShown: true, beforeCanvasSha256, afterCanvasSha256 },
      mockProvider: { outputPath: mockOutputPath, auditPath: mockAuditPath, outputByteLength: mockOutputBytes.byteLength, outputSha256: visualHash(mockOutputBytes), invocationCount: mockAudit.invocationCount, transport: mockAudit.transport },
      networkAndCost: { externalProviderRequests: mockAudit.externalProviderRequests, paidRequests: mockAudit.paidRequests, hostedKeyReceived: mockAudit.hostedKeyReceived, forbiddenRequestSentinelAbsent: true, providerCredentialFileAbsent: true },
      scope: { singleFramePolicyOnly: true, multiFrameAcceptanceExercised: false, paletteFileInterchangeExercised: false },
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, 'utf8');
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`QA-06 pixel-palette packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('UX-11-BATCH closes an exact packaged multi-document Save All, export, and Close All lifecycle', async () => {
  test.setTimeout(90_000);
  const testResultsRoot = resolve(process.cwd(), 'test-results');
  await mkdir(testResultsRoot, { recursive: true });
  const configuredProfile = process.env.AIDRAW_E2E_UX11_BATCH_PROFILE?.trim();
  let isolatedProfile: string;
  if (configuredProfile) {
    isolatedProfile = resolve(configuredProfile);
    const testResultsRelative = relative(testResultsRoot, isolatedProfile);
    if (!testResultsRelative || testResultsRelative.startsWith('..') || isAbsolute(testResultsRelative) || dirname(testResultsRelative) !== '.' || !basename(isolatedProfile).startsWith(UX11_BATCH_E2E_PROFILE_PREFIX)) {
      throw new Error(`AIDRAW_E2E_UX11_BATCH_PROFILE must name a new ${UX11_BATCH_E2E_PROFILE_PREFIX}* direct child of test-results.`);
    }
    if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact UX-11 profile already exists: ${isolatedProfile}`);
  } else isolatedProfile = await mkdtemp(join(testResultsRoot, UX11_BATCH_E2E_PROFILE_PREFIX));

  const connectionPath = join(isolatedProfile, UX11_BATCH_E2E_CONNECTION_FILE);
  const auditPath = join(isolatedProfile, UX11_BATCH_E2E_AUDIT_FILE);
  const evidencePath = join(isolatedProfile, UX11_BATCH_E2E_EVIDENCE_FILE);
  const saveDirectory = join(isolatedProfile, UX11_BATCH_E2E_SAVE_DIRECTORY);
  const exportDirectory = join(isolatedProfile, UX11_BATCH_E2E_EXPORT_DIRECTORY);
  const networkSentinelPath = join(isolatedProfile, UX11_BATCH_E2E_NETWORK_SENTINEL_FILE);
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const screenshotPaths = UX11_BATCH_E2E_SCREENSHOTS.map((name) => join(isolatedProfile, name));
  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    for (const path of [connectionPath, auditPath, evidencePath, saveDirectory, exportDirectory, networkSentinelPath, trustSettingsPath, providerCredentialsPath, ...screenshotPaths]) {
      expect(await access(path).then(() => true, () => false)).toBe(false);
    }
    const page = await launch(isolatedProfile, {
      environment: {
        NODE_ENV: 'test',
        AIDRAW_E2E_UX11_BATCH: '1',
        AIDRAW_E2E_UX11_BATCH_PROFILE: isolatedProfile,
      },
      extraArguments: [`--write-mcp-connection=${connectionPath}`],
    });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated UX-11 package has no engine PID.');
    const rawConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as { pid?: number };
    expect(rawConnection.pid).toBe(enginePid);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);

    const setup = await page.evaluate(async ({ sharedName, failureName }) => {
      const initial = await window.aidraw.bootstrap();
      if (!initial.activeDocumentId) throw new Error('The initial UX-11 document is unavailable.');
      const created: Array<{ documentId: string; name: string; layerId: string; revision: number }> = [];
      for (const name of [sharedName, sharedName, failureName]) {
        const snapshot = await window.aidraw.newDocument({ kind: 'illustration', name, width: 240, height: 160, background: '#fffdf8' });
        const document = snapshot.activeDocument;
        if (!document || document.kind !== 'illustration') throw new Error('The UX-11 illustration document was not created.');
        const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
        if (!layer || layer.type !== 'vector') throw new Error('The UX-11 vector layer is unavailable.');
        created.push({ documentId: document.id, name: document.name, layerId: layer.id, revision: document.revision });
      }
      const closed = await window.aidraw.closeDocument(initial.activeDocumentId, true);
      if (!closed.closed) throw new Error('The initial UX-11 document could not be discarded.');
      const foreground = created.at(-1)!;
      await window.aidraw.activateDocument(foreground.documentId);
      const current = await window.aidraw.bootstrap();
      if (current.documents.length !== 3 || current.activeDocumentId !== foreground.documentId) throw new Error('The exact UX-11 three-document focus was not established.');
      return { documents: created, foregroundDocumentId: foreground.documentId };
    }, { sharedName: UX11_BATCH_E2E_SHARED_DOCUMENT_NAME, failureName: UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME });

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'ux11-batch-observer', {
      name: 'UX-11 batch observer',
      color: '#386fa4',
      documentId: setup.documents[0].documentId,
    });
    let requestId = 3;
    const seedDocuments = async (prefix: string, offset: number) => {
      for (const [index, document] of setup.documents.entries()) {
        const timestamp = new Date().toISOString();
        const response = await callMcpTool(credentials.url, client.headers, requestId++, 'canvas_apply', {
          documentId: document.documentId,
          clientOperationId: `${prefix}-${index}`,
          label: `${prefix} ${index + 1}`,
          playback: { mode: 'instant', speed: 1 },
          operations: [{
            kind: 'illustration.object.add',
            object: {
              id: `${prefix}-object-${index}`,
              revision: 0,
              name: `${prefix} object ${index + 1}`,
              createdAt: timestamp,
              updatedAt: timestamp,
              createdBy: client.actor.id,
              layerId: document.layerId,
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              transform: { x: 24 + offset + index * 12, y: 28 + offset, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 },
              type: 'shape',
              shape: 'rectangle',
              width: 48,
              height: 36,
              fill: { kind: 'solid', color: index === 0 ? '#386fa4' : index === 1 ? '#d9822b' : '#a23b72' },
              stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
            },
          }],
        });
        expect(response).toMatchObject({ status: 'committed' });
      }
    };
    const observeDocuments = async () => {
      const observed: IllustrationDocument[] = [];
      for (const document of setup.documents) {
        const response = await callMcpTool(credentials.url, client.headers, requestId++, 'canvas_observe', { documentId: document.documentId });
        observed.push(response.document as IllustrationDocument);
      }
      return observed;
    };
    const tabProjection = (tabs: Array<{ id: string; name: string; dirty: boolean; revision: number; filePath?: string }>) => tabs.map((entry) => ({ id: entry.id, name: entry.name, dirty: entry.dirty, revision: entry.revision, filePath: entry.filePath }));
    const waitForAuditEvents = async (count: number) => {
      await expect.poll(async () => {
        try { return (JSON.parse(await readFile(auditPath, 'utf8')) as { events?: unknown[] }).events?.length ?? 0; }
        catch { return 0; }
      }).toBe(count);
    };
    const openAllTabs = async () => {
      await page.getByRole('button', { name: 'All open documents', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'All open documents', exact: true });
      await expect(menu).toBeVisible();
      return menu;
    };

    await seedDocuments('ux11-seed', 0);
    const beforeSaveObserved = await observeDocuments();
    const beforeSave = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(beforeSave.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(beforeSave.documents.every((document) => document.dirty && !document.filePath)).toBe(true);
    expect(beforeSave.activeDocument).toEqual(beforeSaveObserved.find((document) => document.id === setup.foregroundDocumentId));

    let menu = await openAllTabs();
    await menu.getByRole('button', { name: 'Save all', exact: true }).click();
    await waitForAuditEvents(1);
    const afterCancelledSave = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(afterCancelledSave.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(tabProjection(afterCancelledSave.documents)).toEqual(tabProjection(beforeSave.documents));
    expect(await access(saveDirectory).then(() => true, () => false)).toBe(false);
    await expect(page.getByRole('dialog', { name: 'Save All complete' })).toHaveCount(0);

    menu = await openAllTabs();
    await menu.getByRole('button', { name: 'Save all', exact: true }).click();
    const saveResultDialog = page.getByRole('dialog', { name: 'Save All complete' });
    await expect(saveResultDialog).toBeVisible();
    await waitForAuditEvents(2);
    expect(await saveResultDialog.locator('.batch-result-row em').allTextContents()).toEqual(['saved', 'saved', 'saved']);
    await saveResultDialog.screenshot({ path: screenshotPaths[0] });
    const expectedSavePaths = [
      join(saveDirectory, `${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}.aidraw`),
      join(saveDirectory, `${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME} (2).aidraw`),
      join(saveDirectory, `${UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME}.aidraw`),
    ];
    expect((await readdir(saveDirectory)).sort()).toEqual(expectedSavePaths.map((path) => basename(path)).sort());
    for (const path of expectedSavePaths) expect((await stat(path)).size).toBeGreaterThan(0);
    const afterSave = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(afterSave.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(afterSave.documents.map((document) => document.filePath)).toEqual(expectedSavePaths);
    expect(afterSave.documents.every((document) => !document.dirty)).toBe(true);
    const afterSaveObserved = await observeDocuments();
    for (const [index, observed] of afterSaveObserved.entries()) expect(afterSave.documents[index]).toMatchObject({ id: observed.id, name: observed.name, revision: observed.revision, dirty: observed.dirty, filePath: observed.filePath });
    expect(afterSave.activeDocument).toEqual(afterSaveObserved.find((document) => document.id === setup.foregroundDocumentId));
    await saveResultDialog.getByRole('button', { name: 'Done', exact: true }).click();

    await seedDocuments('ux11-revision', 18);
    const beforeExportObserved = await observeDocuments();
    const beforeExport = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(beforeExport.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(beforeExport.documents.every((document) => document.dirty)).toBe(true);
    expect(beforeExport.activeDocument).toEqual(beforeExportObserved.find((document) => document.id === setup.foregroundDocumentId));

    menu = await openAllTabs();
    await menu.getByRole('button', { name: 'Batch export', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Batch export' });
    await expect(exportDialog).toBeVisible();
    await exportDialog.getByRole('button', { name: 'Choose folder and export', exact: true }).click();
    await waitForAuditEvents(3);
    await expect(exportDialog).toBeVisible();
    expect(await access(exportDirectory).then(() => true, () => false)).toBe(false);
    expect(tabProjection((await page.evaluate(async () => window.aidraw.bootstrap())).documents)).toEqual(tabProjection(beforeExport.documents));

    await exportDialog.getByRole('button', { name: 'Choose folder and export', exact: true }).click();
    const exportResultDialog = page.getByRole('dialog', { name: 'Batch export complete' });
    await expect(exportResultDialog).toBeVisible();
    await waitForAuditEvents(4);
    expect(await exportResultDialog.locator('.batch-result-row em').allTextContents()).toEqual(['exported', 'exported', 'failed']);
    await expect(exportResultDialog).toContainText('Isolated UX-11 per-document export failure.');
    await exportResultDialog.screenshot({ path: screenshotPaths[1] });
    const expectedExportPaths = [
      join(exportDirectory, `${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}.png`),
      join(exportDirectory, `${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME} (2).png`),
    ];
    expect((await readdir(exportDirectory)).sort()).toEqual(expectedExportPaths.map((path) => basename(path)).sort());
    const exported = await Promise.all(expectedExportPaths.map(async (path) => ({ path, size: (await stat(path)).size, sha256: visualHash(await readFile(path)) })));
    expect(exported.every((entry) => entry.size > 0)).toBe(true);
    const afterExport = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(afterExport.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(tabProjection(afterExport.documents)).toEqual(tabProjection(beforeExport.documents));
    expect(afterExport.activeDocument).toEqual(beforeExport.activeDocument);
    const reports = await page.evaluate(async () => window.aidraw.listInterchangeReports());
    expect(reports).toHaveLength(3);
    expect(reports.map((report) => ({ documentId: report.documentIds[0], status: report.status, actor: report.actor.id, destinationCount: report.destinationPaths.length }))).toEqual(expect.arrayContaining([
      { documentId: setup.documents[0].documentId, status: 'completed', actor: HUMAN_ACTOR.id, destinationCount: 1 },
      { documentId: setup.documents[1].documentId, status: 'completed', actor: HUMAN_ACTOR.id, destinationCount: 1 },
      { documentId: setup.documents[2].documentId, status: 'failed', actor: HUMAN_ACTOR.id, destinationCount: 0 },
    ]));
    await exportResultDialog.getByRole('button', { name: 'Done', exact: true }).click();

    menu = await openAllTabs();
    await menu.getByRole('button', { name: 'Close all', exact: true }).click();
    await waitForAuditEvents(5);
    const afterCancelledClose = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(afterCancelledClose.activeDocumentId).toBe(setup.foregroundDocumentId);
    expect(tabProjection(afterCancelledClose.documents)).toEqual(tabProjection(beforeExport.documents));
    await expect(page.getByRole('dialog', { name: 'Close All complete' })).toHaveCount(0);

    menu = await openAllTabs();
    await menu.getByRole('button', { name: 'Close all', exact: true }).click();
    const closeResultDialog = page.getByRole('dialog', { name: 'Close All complete' });
    await expect(closeResultDialog).toBeVisible();
    await waitForAuditEvents(6);
    expect(await closeResultDialog.locator('.batch-result-row em').allTextContents()).toEqual(['closed', 'closed', 'closed']);
    await closeResultDialog.screenshot({ path: screenshotPaths[2] });
    const afterClose = await page.evaluate(async () => window.aidraw.bootstrap());
    expect(afterClose.documents).toHaveLength(1);
    expect(setup.documents.map((document) => document.documentId)).not.toContain(afterClose.activeDocumentId);
    const mcpAfterClose = await callMcpTool(credentials.url, client.headers, requestId++, 'document_manage', { action: 'list' });
    expect(mcpAfterClose.activeDocumentId).toBe(afterClose.activeDocumentId);
    expect(mcpAfterClose.documents).toEqual(afterClose.documents);
    for (const [index, path] of expectedSavePaths.entries()) {
      const loaded = await readNativeDocument(path);
      expect(loaded.document).toMatchObject({
        id: setup.documents[index].documentId,
        name: setup.documents[index].name,
        revision: beforeExportObserved[index].revision,
        dirty: false,
      });
      expect(Object.keys(loaded.document.kind === 'illustration' ? loaded.document.objects : {})).toHaveLength(2);
    }

    const auditText = await readFile(auditPath, 'utf8');
    const audit = JSON.parse(auditText) as { events: Array<{ kind: string; decision: string; title: string; message?: string; buttons?: string[] }>; externalRequests: number; providerRequests: number; paidRequests: number };
    expect(audit.events.map((event) => [event.kind, event.decision])).toEqual([
      ['save-all-directory', 'cancel'],
      ['save-all-directory', 'choose-directory'],
      ['batch-export-directory', 'cancel'],
      ['batch-export-directory', 'choose-directory'],
      ['close-all-confirmation', 'cancel'],
      ['close-all-confirmation', 'save-all-and-close'],
    ]);
    expect(audit.events.slice(-2).every((event) => event.title === 'Close all drawings' && event.message === '3 drawings have unsaved changes.' && JSON.stringify(event.buttons) === JSON.stringify(['Save all and close', 'Cancel', 'Discard all']))).toBe(true);
    expect(audit).toMatchObject({ externalRequests: 0, providerRequests: 0, paidRequests: 0 });
    expect(auditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    expect(await access(networkSentinelPath).then(() => true, () => false)).toBe(false);
    expect(await access(providerCredentialsPath).then(() => true, () => false)).toBe(false);
    expect(await access(trustSettingsPath).then(() => true, () => false)).toBe(false);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).jobs)).toEqual([]);
    for (const screenshotPath of screenshotPaths) expect(await access(screenshotPath).then(() => true, () => false)).toBe(true);
    expect(applicationProcess?.pid).toBe(enginePid);

    await callMcpTool(credentials.url, client.headers, requestId++, 'session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(redactedConnection, 'token')).toBe(false);
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    const packageSize = (await stat(packagedExecutable)).size;
    const evidence = {
      version: 1,
      package: { executable: packagedExecutable, byteLength: packageSize, enginePid },
      actor: client.actor,
      documents: setup.documents.map((document, index) => ({
        id: document.documentId,
        name: document.name,
        savedPath: expectedSavePaths[index],
        finalSavedRevision: beforeExportObserved[index].revision,
      })),
      cancellation: { saveAllCanonicalUnchanged: true, batchExportCanonicalUnchanged: true, closeAllCanonicalUnchanged: true },
      focus: { foregroundDocumentId: setup.foregroundDocumentId, stableThroughSaveAndExportAndCancelledClose: true },
      saveAll: { statuses: ['saved', 'saved', 'saved'], exactTargets: expectedSavePaths, collisionSafe: true },
      batchExport: { statuses: ['exported', 'exported', 'failed'], exactTargets: exported, boundedFailure: 'Isolated UX-11 per-document export failure.' },
      closeAll: { choices: ['Save all and close', 'Cancel', 'Discard all'], cancelledOnce: true, statuses: ['closed', 'closed', 'closed'], replacementDocumentId: afterClose.activeDocumentId },
      canonicalAgreement: { rendererMatchedAuthenticatedMcpBeforeSave: true, afterSave: true, beforeExport: true, afterCloseList: true, savedFilesMatchedCanonicalRevisions: true },
      filesystem: { saveDirectory, exportDirectory, onlyDeclaredSaveTargets: true, onlyDeclaredExportTargets: true },
      networkAndCost: { externalRequests: 0, providerRequests: 0, paidRequests: 0, forbiddenRequestSentinelAbsent: true, providerCredentialFileAbsent: true },
      cleanup: { graceful: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`UX-11 packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

test('keeps the authenticated engine working with no editor window and replays its durable trace', async () => {
  profilePath = await createPackagedE2eProfile(process.cwd(), 'headless');
  const debuggingPort = await reservePort();
  const connectionPath = join(profilePath, 'mcp-connection.json');
  const agentOutputPath = join(profilePath, 'agent-output');
  applicationStderr = [];
  applicationProcess = spawnPackagedE2e(packagedExecutable, [
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profilePath}`,
    `--write-mcp-connection=${connectionPath}`,
    `--trust-folder=${agentOutputPath}`,
    '--headless',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  applicationProcess.stderr?.on('data', (chunk: Buffer) => applicationStderr.push(chunk));
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  browser = await waitForPackagedE2eReady({
    child: applicationProcess,
    label: 'The headless AIDraw DevTools endpoint',
    stderr: () => Buffer.concat(applicationStderr).toString('utf8'),
    attempt: async () => {
      try { return await chromium.connectOverCDP(endpoint); }
      catch { return undefined; }
    },
  });
  const healthUrl = await waitForHealth(profilePath);
  const credentials = await waitForMcpConnection(connectionPath);
  expect(credentials.trustedFolders).toContain(await canonicalPackagedE2ePath(agentOutputPath));
  expect(await (await fetch(healthUrl)).json()).toMatchObject({ status: 'ok', uiRequired: false });
  expect(browser.contexts()[0]?.pages().some((page) => page.url().startsWith('aidraw://app/'))).toBe(false);
  await expect.poll(() => applicationProcess?.exitCode).toBe(null);
  expect((await fetch(healthUrl)).ok).toBe(true);

  const initialize = await fetch(credentials.url, { method: 'POST', headers: { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'headless-e2e', version: '1.0' } } }) });
  const sessionId = initialize.headers.get('mcp-session-id'); if (!sessionId) throw new Error('Headless MCP session missing.');
  const headers = { authorization: `Bearer ${credentials.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await fetch(credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Headless test agent', documentId: credentials.activeDocumentId } } }) });
  const applied = await fetch(credentials.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canvas_apply', arguments: { documentId: credentials.activeDocumentId, clientOperationId: 'closed-window-rename', label: 'Closed-window agent edit', operations: [{ kind: 'document.rename', name: 'Headless result' }], playback: { mode: 'animated', speed: 1 } } } }) });
  expect(applied.ok).toBe(true);

  const nativePath = join(agentOutputPath, 'headless-result.aidraw');
  const pngPath = join(agentOutputPath, 'headless-result.png');
  const saveJob = await callMcpTool(credentials.url, headers, 4, 'document_manage', { action: 'save-as', documentId: credentials.activeDocumentId, path: nativePath });
  const exportJob = await callMcpTool(credentials.url, headers, 5, 'document_export', { documentId: credentials.activeDocumentId, path: pngPath, format: 'png' });
  expect(saveJob).toMatchObject({ status: 'queued', trust: 'folder' });
  expect(exportJob).toMatchObject({ status: 'queued', trust: 'folder' });
  const saved = await callMcpTool(credentials.url, headers, 6, 'job_manage', { action: 'wait', jobId: saveJob.jobId, timeoutMs: 10_000 });
  const exported = await callMcpTool(credentials.url, headers, 7, 'job_manage', { action: 'wait', jobId: exportJob.jobId, timeoutMs: 10_000 });
  expect(saved.status).toBe('completed');
  expect(exported.status).toBe('completed');
  expect((await readFile(nativePath)).byteLength).toBeGreaterThan(0);
  expect((await readFile(pngPath)).byteLength).toBeGreaterThan(0);

  const overwriteJob = await callMcpTool(credentials.url, headers, 8, 'document_export', { documentId: credentials.activeDocumentId, path: pngPath, format: 'png' });
  expect(overwriteJob.status).toBe('waiting-for-user');
  await callMcpTool(credentials.url, headers, 9, 'job_manage', { action: 'cancel', jobId: overwriteJob.jobId });

  await signalExistingEngine('--show');
  const reopened = await waitForRendererPage();
  await expect(reopened.getByText('Headless result', { exact: true }).first()).toBeVisible();
  await reopened.getByTitle('Activity').click();
  await expect(reopened.getByText('Closed-window agent edit', { exact: true })).toBeVisible();
  await expect(reopened.getByTitle('Replay durable agent trace')).toBeVisible();
  await reopened.close();
  await expect.poll(() => browser?.contexts()[0]?.pages().some((page) => page.url().startsWith('aidraw://app/'))).toBe(false);
  expect((await fetch(healthUrl)).ok).toBe(true);
  await signalExistingEngine('--show');
  const reattached = await waitForRendererPage();
  await expect(reattached.getByText('Headless result', { exact: true }).first()).toBeVisible();
  await signalExistingEngine('--quit-engine');
  await expect.poll(() => applicationProcess?.exitCode, { timeout: 8_000 }).not.toBe(null);
});

test('FND-09-GENERATION-NORMALIZATION exact package preserves previews and accepts only a bounded derivative', async () => {
  test.setTimeout(90_000);
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const configuredProfile = process.env.AIDRAW_E2E_FND09_NORMALIZATION_PROFILE?.trim();
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_NORMALIZATION_PROFILE must name the fresh retained profile authorized for this exact run.');
  const isolatedProfile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, isolatedProfile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(isolatedProfile) !== retainedRoot || !basename(isolatedProfile).startsWith(FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX)) {
    throw new Error(`AIDRAW_E2E_FND09_NORMALIZATION_PROFILE must be a new ${FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX}* direct child of test-results/retained.`);
  }
  if (await access(isolatedProfile).then(() => true, () => false)) throw new Error(`The exact FND-09 normalization profile already exists: ${isolatedProfile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_NORMALIZATION_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_NORMALIZATION_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 normalization executable and ASAR SHA-256 declarations are required.');
  const executableHash = visualHash(await readFile(packagedExecutable)).toUpperCase();
  const asarHash = visualHash(await readFile(packagedAsar)).toUpperCase();
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  const connectionPath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE);
  const normalizableOutputPath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE);
  const previewOnlyOutputPath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE);
  const auditPath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE);
  const readyProbePath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE);
  const previewOnlyProbePath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE);
  const networkSentinelPath = join(isolatedProfile, FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE);
  const evidencePath = join(isolatedProfile, 'fnd09-generation-normalization-evidence.json');
  const approvalScreenshotPath = join(isolatedProfile, 'fnd09-generation-normalization-approval.png');
  const previewsScreenshotPath = join(isolatedProfile, 'fnd09-generation-normalization-previews.png');
  const previewOnlyScreenshotPath = join(isolatedProfile, 'fnd09-generation-normalization-preview-only.png');
  const successScreenshotPath = join(isolatedProfile, 'fnd09-generation-normalization-success.png');
  const acceptedScreenshotPath = join(isolatedProfile, 'fnd09-generation-normalization-accepted.png');
  const tokenPath = join(isolatedProfile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(isolatedProfile, 'trusted-folders.json');
  const providerCredentialsPath = join(isolatedProfile, 'credentials', 'generation.json');
  const declaredArtifacts = [
    connectionPath, normalizableOutputPath, previewOnlyOutputPath, auditPath, readyProbePath, previewOnlyProbePath,
    evidencePath, approvalScreenshotPath, previewsScreenshotPath, previewOnlyScreenshotPath, successScreenshotPath,
    acceptedScreenshotPath, tokenPath, trustSettingsPath, providerCredentialsPath, networkSentinelPath,
  ];
  for (const path of declaredArtifacts) expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);

  gracefulOnlyCleanup = true;
  preserveProfileAfterTest = true;
  let stoppedGracefully = false;
  let regressionFailure: Error | undefined;

  try {
    const page = await launch(isolatedProfile, {
      environment: {
        NODE_ENV: 'test',
        AIDRAW_E2E_GENERATION_NORMALIZATION: '1',
        AIDRAW_E2E_FND09_NORMALIZATION_PROFILE: isolatedProfile,
        AIDRAW_E2E_FND09_NORMALIZATION_CONNECTION_PATH: connectionPath,
        AIDRAW_E2E_FND09_NORMALIZATION_NORMALIZABLE_OUTPUT_PATH: normalizableOutputPath,
        AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_OUTPUT_PATH: previewOnlyOutputPath,
        AIDRAW_E2E_FND09_NORMALIZATION_AUDIT_PATH: auditPath,
        AIDRAW_E2E_FND09_NORMALIZATION_READY_PROBE_PATH: readyProbePath,
        AIDRAW_E2E_FND09_NORMALIZATION_PREVIEW_ONLY_PROBE_PATH: previewOnlyProbePath,
        AIDRAW_E2E_FND09_NORMALIZATION_NETWORK_SENTINEL_PATH: networkSentinelPath,
      },
      extraArguments: [
        '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-pings',
        `--write-mcp-connection=${connectionPath}`,
      ],
    });
    const enginePid = applicationProcess?.pid;
    if (!enginePid) throw new Error('The isolated FND-09 normalization package has no engine PID.');

    await page.getByTitle('New document').click();
    const newDocumentDialog = page.getByRole('dialog', { name: 'New document' });
    await newDocumentDialog.getByRole('radio', { name: /Illustration/ }).click();
    await newDocumentDialog.getByLabel('Document name').fill(FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME);
    await newDocumentDialog.getByLabel('Document width').fill('320');
    await newDocumentDialog.getByLabel('Document height').fill('240');
    await newDocumentDialog.getByRole('button', { name: 'Create Illustration' }).click();
    const initialDocument = await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument);
    if (!initialDocument || initialDocument.kind !== 'illustration') throw new Error('The FND-09 normalization illustration is unavailable.');
    expect(initialDocument).toMatchObject({ name: FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME, artboard: { width: 320, height: 240 } });

    const credentials = await waitForMcpConnection(connectionPath);
    expect(credentials.trustedFolders).toEqual([]);
    const client = await connectMcpTestClient(credentials.url, credentials.token, 'fnd09-generation-normalization', {
      name: 'FND-09 normalization agent', color: '#7a4fbe', documentId: initialDocument.id,
    });
    let requestId = 3;
    const call = (name: string, args: Record<string, unknown>) => callMcpTool(credentials.url, client.headers, requestId++, name, args);
    const request = { documentId: initialDocument.id, ...structuredClone(FND09_GENERATION_NORMALIZATION_E2E_REQUEST) };
    const started = await call('generation_start', request);
    expect(started).toMatchObject({ status: 'waiting-for-user', jobId: expect.any(String), expiresAt: expect.any(String) });
    const jobId = String(started.jobId);

    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    const approval = page.locator('.approval-card').filter({ hasText: 'Generate imagery' });
    await expect(approval).toBeVisible();
    await expect(approval.locator('.approval-heading small')).toHaveText('FND-09 normalization agent requests approval');
    const approvalFields = await approval.locator('.approval-review > div').evaluateAll((rows) => rows.map((row) => [row.querySelector('dt')?.textContent?.trim(), row.querySelector('dd')?.textContent?.trim()]));
    expect(approvalFields).toEqual([
      ['Provider', 'stability'],
      ['Model / workflow', 'Stability generation API'],
      ['Mode', 'create'],
      ['Prompt', FND09_GENERATION_NORMALIZATION_E2E_REQUEST.prompt],
      ['Negative prompt', FND09_GENERATION_NORMALIZATION_E2E_REQUEST.negativePrompt],
      ['Source assets', 'None'],
      ['Requested results', '2'],
      ['Potential paid requests', '2'],
      ['Size', 'auto'],
      ['Seed', String(FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed)],
      ['Provider options', JSON.stringify(FND09_GENERATION_NORMALIZATION_E2E_REQUEST.providerOptions)],
    ]);
    expect((await approval.locator('.approval-actions button').allTextContents()).map((value) => value.trim())).toEqual(['Deny', 'Allow once']);
    await approval.screenshot({ path: approvalScreenshotPath });
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
    const completed = await call('job_manage', { action: 'wait', jobId, timeoutMs: 20_000 });
    expect(completed).toMatchObject({ id: jobId, kind: 'generation', status: 'completed', actor: client.actor, progress: 1 });
    expect(completed).not.toHaveProperty('result');
    expect(JSON.stringify(completed)).not.toContain(FND09_GENERATION_NORMALIZATION_E2E_REQUEST.prompt);

    const normalizableBytes = await readFile(normalizableOutputPath);
    const previewOnlyBytes = await readFile(previewOnlyOutputPath);
    const auditText = await readFile(auditPath, 'utf8');
    const audit = JSON.parse(auditText) as {
      invocationCount: number;
      transport: string;
      outputs: Array<{ id: string; byteLength: number; sha256: string; width: number; height: number }>;
      hostedKeyReceived: boolean;
      nonLoopbackRequests: number;
      externalProviderRequests: number;
      paidRequests: number;
    };
    expect(normalizableBytes.byteLength).toBeGreaterThan(MAX_INLINE_ASSET_BYTES);
    expect(audit).toMatchObject({
      invocationCount: 1,
      transport: 'in-process-deterministic-runner',
      outputs: [
        { id: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, byteLength: normalizableBytes.byteLength, sha256: visualHash(normalizableBytes), width: 64, height: 48 },
        { id: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID, byteLength: previewOnlyBytes.byteLength, sha256: visualHash(previewOnlyBytes), ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS },
      ],
      hostedKeyReceived: false, nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0,
    });
    expect(auditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const completedPrivateJob = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
    expect(completedPrivateJob).toMatchObject({
      id: jobId,
      actor: client.actor,
      result: {
        request,
        outputs: [
          { id: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, mimeType: 'image/png', width: 64, height: 48, seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed },
          { id: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID, mimeType: 'image/png', ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS, seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed + 1 },
        ],
      },
    });
    const privateOutputs = (completedPrivateJob?.result as { outputs?: Array<{ id: string; data: string }> } | undefined)?.outputs;
    expect(Buffer.from(privateOutputs?.[0].data ?? '', 'base64')).toEqual(normalizableBytes);
    expect(Buffer.from(privateOutputs?.[1].data ?? '', 'base64')).toEqual(previewOnlyBytes);

    const beforeFailure = await call('canvas_observe', { documentId: initialDocument.id });
    expect(beforeFailure.document).toEqual(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument));
    const beforeFailureSha256 = visualHash(Buffer.from(JSON.stringify(beforeFailure.document), 'utf8'));
    const revisionBefore = Number(beforeFailure.revision);

    await page.getByRole('tab', { name: 'Generate', exact: true }).click();
    const resultCards = page.locator('.result-card');
    await expect(resultCards).toHaveCount(2);
    await page.locator('.generation-results').screenshot({ path: previewsScreenshotPath });
    await resultCards.nth(1).getByRole('button', { name: 'Accept as layer', exact: true }).click();
    const previewOnlyToast = page.getByRole('status').filter({ hasText: 'outside the 8192px / 16777216-pixel editable-asset limit' });
    await expect(previewOnlyToast).toContainText('outside the 8192px / 16777216-pixel editable-asset limit');
    await expect(previewOnlyToast).toContainText('keeps this provider output available for preview and does not change the document');
    await page.screenshot({ path: previewOnlyScreenshotPath });
    await expect.poll(() => access(previewOnlyProbePath).then(() => true, () => false)).toBe(true);
    const previewOnlyProbe = JSON.parse(await readFile(previewOnlyProbePath, 'utf8')) as {
      version: number;
      scenario: string;
      process: { role: string; pid: number };
      requestKind: string;
      source: { outputId: string; byteLength: number; sha256: string; width: number; height: number };
      result: { status: string; reason: string; message: string; guidance: string };
    };
    expect(previewOnlyProbe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged generated-preview acceptance normalization',
      process: { role: 'electron-utility-process', pid: expect.any(Number) },
      requestKind: 'normalize-generation-acceptance',
      source: { outputId: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID, byteLength: previewOnlyBytes.byteLength, sha256: visualHash(previewOnlyBytes), ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS },
      result: { status: 'preview-only', reason: 'inline-geometry-limit' },
    });
    expect(previewOnlyProbe.process.pid).not.toBe(enginePid);
    const afterFailure = await call('canvas_observe', { documentId: initialDocument.id });
    expect(afterFailure.document).toEqual(beforeFailure.document);
    expect(afterFailure.revision).toBe(revisionBefore);
    expect(visualHash(Buffer.from(JSON.stringify(afterFailure.document), 'utf8'))).toBe(beforeFailureSha256);
    expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument)).toEqual(afterFailure.document);
    const jobAfterFailure = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
    expect(jobAfterFailure?.message).toContain('Generate a smaller result');
    expect((jobAfterFailure?.result as { acceptedOutputId?: string } | undefined)?.acceptedOutputId).toBeUndefined();
    const retainedAfterFailure = (jobAfterFailure?.result as { outputs?: Array<{ data: string }> } | undefined)?.outputs;
    expect(Buffer.from(retainedAfterFailure?.[0].data ?? '', 'base64')).toEqual(normalizableBytes);
    expect(Buffer.from(retainedAfterFailure?.[1].data ?? '', 'base64')).toEqual(previewOnlyBytes);

    const normalizableCard = resultCards.nth(0);
    await normalizableCard.getByRole('button', { name: 'Compare', exact: true }).click();
    const compareDialog = page.getByRole('dialog', { name: 'Compare generated result' });
    await expect(compareDialog.getByRole('img', { name: 'Generated result' })).toBeVisible();
    await compareDialog.getByRole('button', { name: 'Accept as new layer/cel', exact: true }).click();
    const successToast = page.getByRole('status').filter({ hasText: 'Generated result accepted as a new editable layer/cel' });
    await expect(successToast).toContainText('Generated result accepted as a new editable layer/cel');
    await expect(successToast).toContainText('original preview is retained unchanged');
    await expect.poll(() => access(readyProbePath).then(() => true, () => false)).toBe(true);
    const readyProbe = JSON.parse(await readFile(readyProbePath, 'utf8')) as {
      version: number;
      scenario: string;
      process: { role: string; pid: number };
      requestKind: string;
      source: { outputId: string; byteLength: number; sha256: string; width: number; height: number };
      result: {
        status: string;
        mimeType: string;
        width: number;
        height: number;
        normalization: { method: string; sourceOutputId: string; sourceByteLength: number; acceptedByteLength: number; sourceSha256: string; acceptedSha256: string; acceptedMimeType: string };
      };
    };
    expect(readyProbe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged generated-preview acceptance normalization',
      process: { role: 'electron-utility-process', pid: expect.any(Number) },
      requestKind: 'normalize-generation-acceptance',
      source: { outputId: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, byteLength: normalizableBytes.byteLength, sha256: visualHash(normalizableBytes), width: 64, height: 48 },
      result: { status: 'ready', mimeType: 'image/png', width: 64, height: 48, normalization: { method: 'png-reencode', sourceOutputId: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID } },
    });
    expect(readyProbe.process.pid).toBe(previewOnlyProbe.process.pid);
    expect(readyProbe.process.pid).not.toBe(enginePid);
    expect(readyProbe.result.normalization.sourceByteLength).toBe(normalizableBytes.byteLength);
    expect(readyProbe.result.normalization.acceptedByteLength).toBeLessThanOrEqual(MAX_INLINE_ASSET_BYTES);
    await expect(successToast).toContainText(`from ${normalizableBytes.byteLength} to ${readyProbe.result.normalization.acceptedByteLength} bytes as image/png`);
    await page.screenshot({ path: successScreenshotPath });
    await expect(normalizableCard.getByRole('button', { name: 'Accepted', exact: true })).toBeDisabled();

    const afterSuccess = await call('canvas_observe', { documentId: initialDocument.id, includePng: true, scale: 1, background: 'document' });
    const afterDocument = afterSuccess.document as IllustrationDocument;
    expect(afterDocument).toEqual(await page.evaluate(async () => (await window.aidraw.bootstrap()).activeDocument));
    expect(afterDocument.revision).toBe(revisionBefore + 1);
    const generatedAsset = Object.values(afterDocument.assets).find((asset) => asset.source === 'generated');
    if (!generatedAsset?.data) throw new Error('The normalized accepted asset is absent from canonical state.');
    expect(generatedAsset).toMatchObject({
      name: expect.stringContaining('normalized for acceptance'),
      mimeType: 'image/png',
      byteLength: readyProbe.result.normalization.acceptedByteLength,
      sha256: readyProbe.result.normalization.acceptedSha256,
    });
    expect(visualHash(Buffer.from(generatedAsset.data, 'base64'))).toBe(readyProbe.result.normalization.acceptedSha256);
    expect(generatedAsset.data).not.toBe(privateOutputs?.[0].data);
    expect(afterDocument.provenance).toEqual([expect.objectContaining({
      assetId: generatedAsset.id,
      provider: 'stability',
      modelOrWorkflow: 'stable-image-core',
      prompt: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.prompt,
      seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed,
      conversion: { acceptanceNormalization: readyProbe.result.normalization },
    })]);
    expect(afterDocument.activity.at(-1)).toMatchObject({ actor: HUMAN_ACTOR, label: 'Accept generated image', status: 'committed' });
    const generatedObject = Object.values(afterDocument.objects).find((object) => object.type === 'image' && object.assetId === generatedAsset.id);
    if (!generatedObject) throw new Error('The normalized generated object is absent from canonical state.');
    expect(afterDocument.layers[generatedObject.layerId]).toMatchObject({ createdBy: HUMAN_ACTOR.id, name: 'Generated result' });
    expect(generatedObject).toMatchObject({ createdBy: HUMAN_ACTOR.id, width: 64, height: 48 });
    await page.getByRole('application', { name: /Illustration canvas/ }).screenshot({ path: acceptedScreenshotPath });

    const acceptedPrivateJob = await page.evaluate(async (id) => (await window.aidraw.bootstrap()).jobs.find((job) => job.id === id), jobId);
    expect(acceptedPrivateJob).toMatchObject({ actor: client.actor, result: { acceptedOutputId: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, acceptedNormalization: readyProbe.result.normalization } });
    const retainedAfterSuccess = (acceptedPrivateJob?.result as { outputs?: Array<{ data: string }> } | undefined)?.outputs;
    expect(Buffer.from(retainedAfterSuccess?.[0].data ?? '', 'base64')).toEqual(normalizableBytes);
    expect(Buffer.from(retainedAfterSuccess?.[1].data ?? '', 'base64')).toEqual(previewOnlyBytes);

    const publicJobs = await call('job_manage', { action: 'list' });
    expect(publicJobs.jobs).toEqual([expect.objectContaining({ id: jobId, kind: 'generation', status: 'completed', actor: client.actor })]);
    expect(JSON.stringify(publicJobs)).not.toMatch(/acceptedNormalization|sourceSha256|acceptedSha256|fnd09-normalizable-preview|fnd09-preview-only-preview/i);
    expect(JSON.stringify(publicJobs)).not.toContain(FND09_GENERATION_NORMALIZATION_E2E_REQUEST.prompt);
    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as unknown;
    inspectPackagedMcpCredential(tokenFile, credentials.token);
    for (const sentinel of [trustSettingsPath, providerCredentialsPath, networkSentinelPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    for (const screenshot of [approvalScreenshotPath, previewsScreenshotPath, previewOnlyScreenshotPath, successScreenshotPath, acceptedScreenshotPath]) expect(await access(screenshot).then(() => true, () => false)).toBe(true);

    await call('session_manage', { action: 'leave' });
    await quitIsolatedEngineGracefully();
    expect(applicationProcess?.exitCode).toBe(0);
    await redactOwnedConnection(connectionPath);
    const redactedConnectionText = await readFile(connectionPath, 'utf8');
    const redactedConnection = JSON.parse(redactedConnectionText) as Record<string, unknown>;
    expect(redactedConnection.credentialStatus).toBe('redacted-after-graceful-stop');
    expect(redactedConnectionText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);

    const evidence = {
      version: 1,
      scenario: 'FND-09 packaged generated-preview acceptance normalization',
      package: {
        executable: packagedExecutable,
        executableBytes: (await stat(packagedExecutable)).size,
        executableSha256: executableHash,
        asar: packagedAsar,
        asarBytes: (await stat(packagedAsar)).size,
        asarSha256: asarHash,
      },
      actor: { requestingAgent: client.actor, acceptingHuman: HUMAN_ACTOR },
      utility: { workerPid: readyProbe.process.pid, distinctFromMain: readyProbe.process.pid !== enginePid, sameWorkerForBothResults: readyProbe.process.pid === previewOnlyProbe.process.pid },
      retainedOriginals: {
        normalizable: { byteLength: normalizableBytes.byteLength, sha256: visualHash(normalizableBytes), privateJobByteExact: true },
        previewOnly: { byteLength: previewOnlyBytes.byteLength, sha256: visualHash(previewOnlyBytes), privateJobByteExact: true },
      },
      previewOnly: { reason: previewOnlyProbe.result.reason, revisionBefore, revisionAfter: afterFailure.revision, canonicalUnchanged: true, guidanceVisible: true },
      acceptedDerivative: {
        normalization: readyProbe.result.normalization,
        canonicalAssetId: generatedAsset.id,
        canonicalAssetMatchedProbe: true,
        rendererMatchedAuthenticatedMcp: true,
        humanAcceptanceTransaction: true,
      },
      privacy: { publicJobSummaryRedacted: true, originalOutputsPrivate: true },
      fixture: { invocationCount: audit.invocationCount, transport: audit.transport },
      networkAndCost: { nonLoopbackRequests: audit.nonLoopbackRequests, externalProviderRequests: audit.externalProviderRequests, paidRequests: audit.paidRequests, hostedKeyReceived: audit.hostedKeyReceived },
      sentinels: { trustAbsent: true, providerCredentialAbsent: true, forbiddenNetworkAbsent: true },
      cleanup: { gracefulOnly: true, exitCode: applicationProcess?.exitCode, credentialStatus: redactedConnection.credentialStatus },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(evidenceText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    await writeFile(evidencePath, evidenceText, { encoding: 'utf8', flag: 'wx' });
    stoppedGracefully = true;
  } catch (error) {
    const diagnostic = Buffer.concat(applicationStderr).toString('utf8').trim();
    regressionFailure = new Error(`FND-09 generated-preview normalization packaged regression failed: ${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    if (!stoppedGracefully && applicationProcess?.exitCode === null) {
      try {
        await quitIsolatedEngineGracefully();
        await redactOwnedConnection(connectionPath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        regressionFailure = regressionFailure
          ? new Error(`${regressionFailure.message}\nGraceful cleanup also failed: ${cleanupFailure.message}`)
          : cleanupFailure;
      }
    }
  }
  if (regressionFailure) throw regressionFailure;
});

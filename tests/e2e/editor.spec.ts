import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPixel } from '@aidraw/core';

let applicationProcess: ChildProcess | undefined;
let browser: Browser | undefined;
let profilePath: string | undefined;
const packagedExecutable = join(process.cwd(), process.env.AIDRAW_E2E_OUT_DIR || 'out', 'AIDraw-win32-x64', 'AIDraw.exe');

test.afterEach(async () => {
  const child = applicationProcess;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 5_000); });
  }
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
  applicationProcess = undefined;
  browser = undefined;
  if (profilePath) await rm(profilePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  profilePath = undefined;
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a DevTools port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function launch(existingProfile?: string): Promise<Page> {
  profilePath = existingProfile ?? await mkdtemp(join(tmpdir(), 'aidraw-e2e-'));
  const port = await reservePort();
  const stderr: Buffer[] = [];
  applicationProcess = spawn(packagedExecutable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profilePath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  applicationProcess.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (!browser && Date.now() < deadline) {
    if (applicationProcess.exitCode !== null) break;
    try { browser = await chromium.connectOverCDP(endpoint); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!browser) throw new Error(`AIDraw DevTools endpoint did not start. ${Buffer.concat(stderr).toString('utf8')}`);
  const context = browser.contexts()[0];
  while (Date.now() < deadline) {
    const page = context?.pages().find((candidate) => candidate.url().startsWith('aidraw://app/'));
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AIDraw renderer did not open. ${Buffer.concat(stderr).toString('utf8')}`);
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

function parseMcpPayload(text: string): { result?: { content?: Array<{ type: string; text?: string }> }; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as { result?: { content?: Array<{ type: string; text?: string }> }; error?: unknown };
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1)!) as { result?: { content?: Array<{ type: string; text?: string }> }; error?: unknown };
}

async function callMcpTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const payload = parseMcpPayload(await response.text());
  if (!response.ok || payload.error) throw new Error(`${name} failed: ${JSON.stringify(payload.error ?? payload)}`);
  const text = payload.result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} did not return structured JSON text.`);
  return JSON.parse(text) as Record<string, unknown>;
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
  const child = spawn(packagedExecutable, [`--user-data-dir=${profilePath}`, ...args], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 5_000);
  });
}

test('opens the configurable New Document dialog from Ctrl+N without creating first', async () => {
  const page = await launch();
  const before = await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length);
  await page.keyboard.press('Control+N');
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Document width')).toHaveValue('1920');
  await expect(dialog.getByLabel('Document height')).toHaveValue('1080');
  expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length)).toBe(before);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(async () => (await window.aidraw.bootstrap()).documents.length)).toBe(before);
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
  await renamedStar.locator('.object-main').click({ modifiers: ['Control'] });
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
  const page = await launch(); await expect(page.getByText('Illustration', { exact: true }).last()).toBeVisible(); await page.getByTitle('New document').click(); const dialog = page.getByRole('dialog', { name: 'New document' }); await expect(dialog).toBeVisible(); await dialog.getByRole('radio', { name: /Pixel Sprite/ }).click(); await dialog.getByRole('button', { name: 'Create Pixel Sprite' }).click(); await expect(page.getByText('Pixel Art', { exact: true })).toBeVisible();
  const canvas = page.getByRole('application', { name: /Pixel-art canvas/ }); await expect(canvas).toBeVisible(); await page.getByTitle('Pixel-perfect pencil').click(); const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Pixel canvas has no bounds'); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 18, bounds.y + bounds.height / 2 + 18, { steps: 6 }); await page.mouse.up(); await expect(page.getByLabel('Unsaved changes').last()).toBeVisible();
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

test('does not restore an untitled document that was explicitly discarded', async () => {
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

  const persistentProfile = profilePath!;
  await signalExistingEngine('--quit-engine');
  await expect.poll(() => applicationProcess?.exitCode, { timeout: 8_000 }).not.toBe(null);
  if (browser?.isConnected()) await browser.close().catch(() => undefined);
  browser = undefined;
  applicationProcess = undefined;

  const restarted = await launch(persistentProfile);
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

test('keeps the authenticated engine working with no editor window and replays its durable trace', async () => {
  profilePath = await mkdtemp(join(tmpdir(), 'aidraw-e2e-headless-'));
  const debuggingPort = await reservePort();
  const connectionPath = join(profilePath, 'mcp-connection.json');
  const agentOutputPath = join(profilePath, 'agent-output');
  applicationProcess = spawn(packagedExecutable, [
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profilePath}`,
    `--write-mcp-connection=${connectionPath}`,
    `--trust-folder=${agentOutputPath}`,
    '--headless',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  const deadline = Date.now() + 15_000;
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(endpoint); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!browser) throw new Error('Could not attach to the headless Electron process.');
  const healthUrl = await waitForHealth(profilePath);
  const credentials = await waitForMcpConnection(connectionPath);
  expect(credentials.trustedFolders).toContain(agentOutputPath.toLowerCase());
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
  await callMcpTool(credentials.url, headers, 9, 'job_manage', { action: 'cancel', jobId: overwriteJob.jobId, timeoutMs: 0 });

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

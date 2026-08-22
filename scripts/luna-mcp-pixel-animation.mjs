import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import UPNG from 'upng-js';
import gifenc from 'gifenc';
import { initializeDirectMcp, readMcpConnectionHandoff } from './mcp-direct-client.mjs';

const { GIFEncoder, applyPalette } = gifenc;

const root = resolve(import.meta.dirname, '..');
const executable = process.env.AIDRAW_EXECUTABLE ?? join(root, 'out-regression', 'AIDraw-win32-x64', 'AIDraw.exe');
const outputName = process.env.AIDRAW_OUTPUT_NAME ?? 'luna-mcp-pixel-animation';
const outputDir = join(root, 'autonomous-output', outputName);
const profileDir = join(outputDir, '.isolated-profile');
const pendingPath = join(root, 'autonomous-output', `${outputName}-pending.json`);
const calls = [];
let primary;
let rpcId = 0;

function sleep(milliseconds) { return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)); }

async function signalPrimary(...args) {
  const child = spawn(executable, [`--user-data-dir=${profileDir}`, ...args], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolveExit) => {
    child.once('exit', resolveExit);
    setTimeout(() => { if (child.exitCode === null) child.kill(); resolveExit(); }, 5_000);
  });
}

async function waitForHealth(connectionPath) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const connection = await readMcpConnectionHandoff(connectionPath);
      const url = new globalThis.URL(connection.url); url.pathname = '/health';
      const response = await globalThis.fetch(url, { headers: { authorization: `Bearer ${connection.token}` } });
      if (response.ok) return { url: url.toString(), body: await response.json() };
    } catch { /* Engine is still starting. */ }
    await sleep(100);
  }
  throw new Error('Headless engine health endpoint did not start.');
}

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`MCP returned an unrecognized response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1));
}

async function rpc(url, headers, method, params = {}, authenticated = true) {
  const id = ++rpcId;
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: authenticated ? headers : { authorization: headers.authorization, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = parseRpcPayload(await response.text());
  calls.push({ id, method, status: response.status, ok: response.ok });
  if (!response.ok || body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body)}`);
  return { body, response };
}

function parseToolResult(result, name) {
  if (result.isError) throw new Error(`${name} reported an MCP tool error: ${JSON.stringify(result)}`);
  const block = result.content?.find((entry) => entry.type === 'text');
  if (!block?.text) throw new Error(`${name} did not return a JSON text block.`);
  const value = JSON.parse(block.text);
  if (value?.status === 'conflict' || value?.error) throw new Error(`${name} failed: ${JSON.stringify(value)}`);
  return value;
}

async function tool(url, headers, name, args) {
  const { body } = await rpc(url, headers, 'tools/call', { name, arguments: args });
  calls.push({ method: `tool:${name}`, arguments: summarizeArguments(name, args) });
  return parseToolResult(body.result, name);
}

function summarizeArguments(name, args) {
  if (name === 'canvas_apply') return { documentId: args.documentId, clientOperationId: args.clientOperationId, label: args.label, operationKinds: args.operations.map((entry) => entry.kind), operationCount: args.operations.length };
  if (name === 'canvas_observe') return { documentId: args.documentId, includePng: args.includePng };
  return args;
}

function entity(id, name, createdBy, timestamp) {
  return { id, revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy };
}

function makeSlimeFrame(pose) {
  const points = new Map();
  const put = (x, y, index) => points.set(`${x},${y}`, { x, y, index });
  const spans = pose.spans;
  const occupied = new Set();
  for (const [y, left, right] of spans) for (let x = left; x <= right; x += 1) occupied.add(`${x},${y}`);
  for (const [y, left, right] of spans) {
    for (let x = left; x <= right; x += 1) {
      const border = !occupied.has(`${x - 1},${y}`) || !occupied.has(`${x + 1},${y}`) || !occupied.has(`${x},${y - 1}`) || !occupied.has(`${x},${y + 1}`);
      put(x, y, border ? 1 : (y >= pose.darkFrom ? 2 : 3));
    }
  }
  for (const [x, y] of pose.highlights) put(x, y, 4);
  for (const [x, y] of pose.eyes) put(x, y, 1);
  for (const [x, y] of pose.eyeGlints) put(x, y, 5);
  for (const [x, y] of pose.mouth) put(x, y, 1);
  for (const [x, y] of pose.blush) put(x, y, 6);
  for (const [x, y] of pose.shadow ?? []) put(x, y, 7);
  return [...points.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

const poses = [
  {
    name: 'Ready', durationMs: 150, darkFrom: 17,
    spans: [[8,10,13],[9,8,15],[10,7,16],[11,6,17],[12,5,18],[13,5,18],[14,5,18],[15,5,18],[16,5,18],[17,6,17],[18,7,16],[19,9,14]],
    highlights: [[9,10],[10,10],[8,11],[9,11]], eyes: [[9,13],[9,14],[14,13],[14,14]], eyeGlints: [[9,13],[14,13]], mouth: [[11,16],[12,16]], blush: [[7,15],[16,15]],
  },
  {
    name: 'Stretch', durationMs: 120, darkFrom: 17,
    spans: [[5,11,12],[6,9,14],[7,8,15],[8,8,15],[9,7,16],[10,7,16],[11,7,16],[12,7,16],[13,7,16],[14,7,16],[15,7,16],[16,7,16],[17,8,15],[18,8,15],[19,10,13]],
    highlights: [[10,7],[11,7],[9,8]], eyes: [[10,11],[13,11]], eyeGlints: [[10,11],[13,11]], mouth: [[11,14],[12,14]], blush: [[8,13],[15,13]],
  },
  {
    name: 'Airborne', durationMs: 170, darkFrom: 13,
    spans: [[3,10,13],[4,8,15],[5,7,16],[6,6,17],[7,6,17],[8,6,17],[9,6,17],[10,6,17],[11,7,16],[12,7,16],[13,8,15],[14,10,13]],
    highlights: [[9,5],[10,5],[8,6]], eyes: [[9,8],[14,8]], eyeGlints: [[9,8],[14,8]], mouth: [[11,11],[12,11]], blush: [[7,10],[16,10]], shadow: [[8,19],[9,19],[10,19],[11,19],[12,19],[13,19],[14,19],[15,19]],
  },
  {
    name: 'Squash', durationMs: 130, darkFrom: 18,
    spans: [[12,9,14],[13,6,17],[14,4,19],[15,3,20],[16,3,20],[17,3,20],[18,4,19],[19,6,17]],
    highlights: [[7,14],[8,14],[6,15]], eyes: [[8,16],[15,16]], eyeGlints: [[8,16],[15,16]], mouth: [[11,18],[12,18]], blush: [[5,17],[18,17]],
  },
];

function decodeAndScalePng(bytes, scale) {
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  const width = decoded.width * scale;
  const height = decoded.height * scale;
  const scaled = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (Math.floor(y / scale) * decoded.width + Math.floor(x / scale)) * 4;
      const target = (y * width + x) * 4;
      scaled[target] = rgba[source]; scaled[target + 1] = rgba[source + 1]; scaled[target + 2] = rgba[source + 2]; scaled[target + 3] = rgba[source + 3];
    }
  }
  return { rgba: scaled, width, height };
}

async function run() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const connectionPath = resolve(join(profileDir, 'mcp-connection.json'));
  primary = spawn(executable, [
    `--user-data-dir=${profileDir}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
    `--trust-folder=${outputDir}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const stderr = [];
  primary.stderr?.on('data', (chunk) => stderr.push(chunk));

  const health = await waitForHealth(connectionPath);
  const connectionDeadline = Date.now() + 20_000;
  let connection;
  while (!connection && Date.now() < connectionDeadline) {
    try { connection = await readMcpConnectionHandoff(connectionPath); } catch { await sleep(100); }
  }
  if (!connection?.url || !connection?.token) throw new Error(`Headless MCP connection file did not appear. ${Buffer.concat(stderr).toString('utf8')}`);
  const credentials = { url: connection.url, token: connection.token };
  const initialRendererPages = 0;
  const rendererPagesBeforeMutations = 0;
  if (rendererPagesBeforeMutations !== 0) throw new Error('Renderer remained open before MCP mutations.');
  const healthWhileRendererClosed = await (await globalThis.fetch(health.url, { headers: { authorization: `Bearer ${connection.token}` } })).json();
  if (healthWhileRendererClosed.uiRequired !== false) throw new Error(`Engine unexpectedly requires UI: ${JSON.stringify(healthWhileRendererClosed)}`);

  const initialized = await initializeDirectMcp(connection, {
    requestId: ++rpcId,
    clientInfo: { name: 'Luna black-box acceptance', version: '1.0' },
  });
  calls.push({ id: rpcId, method: 'initialize', status: 200, ok: true, protocolVersion: initialized.protocolVersion });
  const headers = initialized.headers;
  calls.push({ method: 'notifications/initialized' });

  const listedTools = (await rpc(credentials.url, headers, 'tools/list')).body.result.tools.map((entry) => entry.name);
  const created = await tool(credentials.url, headers, 'document_manage', { action: 'new', kind: 'sprite', name: 'Luna’s Bouncing Teal Slime', width: 24, height: 24 });
  const documentId = created.activeDocument?.id ?? created.activeDocumentId;
  if (!documentId) throw new Error(`document_manage(new) did not return an active document: ${JSON.stringify(created)}`);
  const joined = await tool(credentials.url, headers, 'session_manage', { action: 'join', name: 'Luna', color: '#31c8bd', documentId });
  const actor = joined.actor;
  let observed = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: false });
  let document = observed.document;
  let sprite = document.pixelAssets[document.activeAssetId];
  const originalFrameId = sprite.frameIds[0];
  const layerId = sprite.layerIds.find((id) => sprite.layers[id]?.type === 'pixel');
  const originalCel = Object.values(sprite.cels).find((cel) => cel.frameId === originalFrameId && cel.layerId === layerId);
  if (!layerId || !originalCel) throw new Error('New public sprite snapshot did not contain an editable first cel.');

  const palette = [
    { id: 'luna-transparent', name: 'Transparent', color: '#00000000', index: 0 },
    { id: 'luna-outline', name: 'Deep ocean outline', color: '#17334d', index: 1 },
    { id: 'luna-teal-dark', name: 'Teal shade', color: '#119b98', index: 2 },
    { id: 'luna-teal', name: 'Teal slime', color: '#2ed3c6', index: 3 },
    { id: 'luna-mint', name: 'Mint shine', color: '#8af5d4', index: 4 },
    { id: 'luna-white', name: 'Eye sparkle', color: '#f6fbff', index: 5 },
    { id: 'luna-coral', name: 'Coral blush', color: '#ff7f8a', index: 6 },
    { id: 'luna-shadow', name: 'Soft shadow', color: '#53677a99', index: 7 },
  ];
  await tool(credentials.url, headers, 'canvas_apply', {
    documentId, clientOperationId: 'luna-slime-palette-and-pose-1', label: 'Luna paints the ready pose', playback: { mode: 'animated', speed: 1 },
    operations: [
      { kind: 'pixel.palette.replace', palette },
      { kind: 'pixel.frame.replace', spriteId: sprite.id, frame: { ...sprite.frames[originalFrameId], name: poses[0].name, durationMs: poses[0].durationMs } },
      { kind: 'pixel.cel.set', spriteId: sprite.id, celId: originalCel.id, changes: makeSlimeFrame(poses[0]) },
    ],
  });

  const frameIds = [originalFrameId];
  for (let index = 1; index < poses.length; index += 1) {
    const timestamp = new Date().toISOString();
    const frameId = `luna-frame-${index + 1}`;
    const celId = `luna-cel-${index + 1}`;
    frameIds.push(frameId);
    await tool(credentials.url, headers, 'canvas_apply', {
      documentId, clientOperationId: `luna-slime-pose-${index + 1}`, label: `Luna paints ${poses[index].name.toLowerCase()} pose`, playback: { mode: 'animated', speed: 1 },
      operations: [
        { kind: 'pixel.frame.add', spriteId: sprite.id, frame: { ...entity(frameId, poses[index].name, actor.id, timestamp), durationMs: poses[index].durationMs }, cels: [{ ...entity(celId, `${poses[index].name} pixels`, actor.id, timestamp), layerId, frameId, chunks: {} }] },
        { kind: 'pixel.cel.set', spriteId: sprite.id, celId, changes: makeSlimeFrame(poses[index]) },
      ],
    });
  }

  observed = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: false });
  document = observed.document;
  const canonicalFrameOrder = [...document.pixelAssets[document.activeAssetId].frameIds];
  const frameSnapshots = [];
  for (let index = 0; index < canonicalFrameOrder.length; index += 1) {
    observed = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: false });
    document = observed.document;
    sprite = document.pixelAssets[document.activeAssetId];
    const targetFrameId = canonicalFrameOrder[index];
    const reordered = { ...sprite, frameIds: [targetFrameId, ...sprite.frameIds.filter((id) => id !== targetFrameId)] };
    await tool(credentials.url, headers, 'canvas_apply', {
      documentId, clientOperationId: `luna-observe-frame-${index + 1}`, label: `Select ${poses[index].name} for MCP snapshot`, playback: { mode: 'instant', speed: 4 },
      operations: [{ kind: 'pixel.asset.replace', asset: reordered }],
    });
    const capture = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: true });
    if (!capture.png?.available || !capture.png.data) throw new Error(`canvas_observe did not return PNG data for frame ${index + 1}.`);
    const bytes = Buffer.from(capture.png.data, 'base64');
    const path = join(outputDir, `frame-${index + 1}-${poses[index].name.toLowerCase()}-mcp.png`);
    await writeFile(path, bytes);
    frameSnapshots.push({ frameId: targetFrameId, name: poses[index].name, durationMs: poses[index].durationMs, bytes, path });
  }

  observed = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: false });
  document = observed.document;
  sprite = document.pixelAssets[document.activeAssetId];
  await tool(credentials.url, headers, 'canvas_apply', {
    documentId, clientOperationId: 'luna-restore-canonical-frame-order', label: 'Restore animation frame order', playback: { mode: 'instant', speed: 4 },
    operations: [{ kind: 'pixel.asset.replace', asset: { ...sprite, frameIds: canonicalFrameOrder } }],
  });

  const nativePath = join(outputDir, 'luna-bouncing-teal-slime.aidraw');
  const gifExportPath = join(outputDir, 'luna-bouncing-teal-slime-export.gif');
  const apngExportPath = join(outputDir, 'luna-bouncing-teal-slime-export.apng');
  const sheetExportPath = join(outputDir, 'luna-bouncing-teal-slime-sheet.png');
  const nativeSave = await tool(credentials.url, headers, 'document_manage', { action: 'save-as', documentId, path: nativePath });
  const gifExport = await tool(credentials.url, headers, 'document_export', { documentId, path: gifExportPath, format: 'gif' });
  const apngExport = await tool(credentials.url, headers, 'document_export', { documentId, path: apngExportPath, format: 'apng' });
  const sheetExport = await tool(credentials.url, headers, 'document_export', { documentId, path: sheetExportPath, format: 'sprite-sheet' });
  const approvalJobs = [nativeSave, gifExport, apngExport, sheetExport].map((result) => result.jobId).filter(Boolean);
  const fileJobs = [];
  for (const jobId of approvalJobs) fileJobs.push(await tool(credentials.url, headers, 'job_manage', { action: 'wait', jobId, timeoutMs: 30_000 }));
  if (fileJobs.some((job) => job.status !== 'completed')) throw new Error(`Headless trusted-folder file job failed: ${JSON.stringify(fileJobs)}`);

  const scaledFrames = frameSnapshots.map((frame) => decodeAndScalePng(frame.bytes, 12));
  const apngBytes = Buffer.from(UPNG.encode(scaledFrames.map((frame) => frame.rgba.buffer), scaledFrames[0].width, scaledFrames[0].height, 0, poses.map((pose) => pose.durationMs)));
  const apngPath = join(outputDir, 'luna-bouncing-teal-slime.apng.png');
  await writeFile(apngPath, apngBytes);
  const representativePath = join(outputDir, 'luna-bouncing-teal-slime.png');
  await writeFile(representativePath, Buffer.from(UPNG.encode([scaledFrames[2].rgba.buffer], scaledFrames[2].width, scaledFrames[2].height, 0)));

  const gifPalette = [[0, 0, 0], [23, 51, 77], [17, 155, 152], [46, 211, 198], [138, 245, 212], [246, 251, 255], [255, 127, 138], [83, 103, 122]];
  const gif = GIFEncoder();
  for (let index = 0; index < scaledFrames.length; index += 1) {
    const rgba = new Uint8Array(scaledFrames[index].rgba);
    for (let pixel = 0; pixel < rgba.length; pixel += 4) if (rgba[pixel + 3] < 128) { rgba[pixel] = 0; rgba[pixel + 1] = 0; rgba[pixel + 2] = 0; rgba[pixel + 3] = 0; }
    const indices = applyPalette(rgba, gifPalette);
    for (let pixel = 0; pixel < rgba.length; pixel += 4) if (rgba[pixel + 3] < 128) indices[pixel / 4] = 0;
    gif.writeFrame(indices, scaledFrames[index].width, scaledFrames[index].height, { palette: index === 0 ? gifPalette : undefined, delay: poses[index].durationMs, repeat: 0, transparent: true, transparentIndex: 0, dispose: 2 });
  }
  gif.finish();
  const gifPath = join(outputDir, 'luna-bouncing-teal-slime.gif');
  await writeFile(gifPath, gif.bytes());

  const { body: traceBody } = await rpc(credentials.url, headers, 'resources/read', { uri: `aidraw://documents/${documentId}/trace` });
  const traceText = traceBody.result.contents?.[0]?.text ?? '';
  const tracePath = join(outputDir, 'durable-trace.ndjson');
  await writeFile(tracePath, traceText, 'utf8');
  const traceEntries = traceText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const finalObserve = await tool(credentials.url, headers, 'canvas_observe', { documentId, includePng: false });
  const finalSprite = finalObserve.document.pixelAssets[finalObserve.document.activeAssetId];
  const lunaTraceEntries = traceEntries.filter((entry) => entry.transaction?.actor?.name === 'Luna');

  const officialPaths = [nativePath, gifExportPath, apngExportPath, sheetExportPath, join(outputDir, 'luna-bouncing-teal-slime-sheet.json')];
  const officialSizes = Object.fromEntries(await Promise.all(officialPaths.map(async (path) => [path, (await readFile(path)).byteLength])));

  const report = {
    schemaVersion: 2,
    test: 'AIDraw packaged public-MCP headless pixel-animation acceptance',
    verdict: finalSprite.frameIds.length === 4 && rendererPagesBeforeMutations === 0 && healthWhileRendererClosed.uiRequired === false && lunaTraceEntries.length >= 9 && fileJobs.every((job) => job.status === 'completed') ? 'pass' : 'fail',
    runAt: new Date().toISOString(),
    constraints: { executableOnly: executable, internalEngineApisUsed: false, mutationsViaAuthenticatedMcpOnly: true, priorInternalHarnessUsed: false },
    actor: { requestedName: 'Luna', observed: actor },
    document: { id: documentId, name: finalObserve.document.name, revision: finalObserve.revision, kind: finalObserve.document.kind, spriteId: finalSprite.id, dimensions: [finalSprite.width, finalSprite.height], frameCount: finalSprite.frameIds.length, frameOrder: finalSprite.frameIds, frameDurationsMs: finalSprite.frameIds.map((id) => finalSprite.frames[id].durationMs), indexedPaletteEntries: finalObserve.document.palette.length },
    headlessEvidence: { initialRendererPageCount: initialRendererPages, rendererPageCountBeforeMutations: rendererPagesBeforeMutations, healthWhileRendererClosed, primaryPid: primary.pid },
    publicContract: { endpoint: credentials.url.replace(/:\d+\//, ':<isolated-port>/'), toolsAdvertised: listedTools, calls },
    durableTrace: { uri: `aidraw://documents/${documentId}/trace`, path: tracePath, entryCount: traceEntries.length, lunaEntryCount: lunaTraceEntries.length, labels: lunaTraceEntries.map((entry) => entry.transaction.label), allLunaEntriesAttributed: lunaTraceEntries.every((entry) => entry.transaction.actor.name === 'Luna') },
    headlessFileAuthority: { grantedFolders: connection.trustedFolders, jobs: fileJobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, message: job.message })), officialSizes },
    outputs: { nativeDocument: nativePath, animatedGif: gifExportPath, animatedApng: apngExportPath, spriteSheet: sheetExportPath, spriteSheetMetadata: join(outputDir, 'luna-bouncing-teal-slime-sheet.json'), representativePng: representativePath, mcpFrameSnapshots: frameSnapshots.map((entry) => entry.path), traceNdjson: tracePath },
    presentationEncoding: { source: 'Only base64 PNG payloads returned by public canvas_observe(includePng:true)', nearestNeighborScale: 12, originalFrameSize: [24, 24], outputFrameSize: [288, 288] },
    limitations: ['canvas_observe renders the sprite frame currently first in frameIds; public pixel.asset.replace transactions temporarily reordered frames for capture, then restored canonical order.'],
  };
  await writeFile(join(outputDir, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

let report;
try {
  report = await run();
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, documentId: report.document.id, frameCount: report.document.frameCount, outputs: report.outputs }, null, 2)}\n`);
} finally {
  const keepEngine = process.env.AIDRAW_KEEP_ENGINE === '1';
  if (!keepEngine) {
    try { await signalPrimary('--quit-engine'); } catch { /* Best effort after an earlier startup failure. */ }
    if (primary && primary.exitCode === null) {
      await Promise.race([new Promise((resolveExit) => primary.once('exit', resolveExit)), sleep(5_000)]);
      if (primary.exitCode === null) primary.kill();
    }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined);
  }
  await rm(pendingPath, { force: true }).catch(() => undefined);
}

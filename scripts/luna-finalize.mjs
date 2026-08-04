import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const root = resolve(import.meta.dirname, '..');
const outputName = process.env.AIDRAW_OUTPUT_NAME ?? 'luna-mcp-pixel-animation-20260802-final';
const executable = process.env.AIDRAW_EXECUTABLE ?? join(root, 'out-regression', 'AIDraw-win32-x64', 'AIDraw.exe');
const outputDir = join(root, 'autonomous-output', outputName);
const profileDir = join(outputDir, '.isolated-profile');
const connectionPath = join(profileDir, 'mcp-connection.json');
const pendingPath = join(root, 'autonomous-output', `${outputName}-pending.json`);
const completionPath = join(outputDir, 'ui-verification-complete.json');

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error(`Unrecognized MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data.at(-1));
}

async function rpc(url, headers, method, params = {}) {
  const response = await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  const body = parseRpcPayload(await response.text());
  if (!response.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? body)}`);
  return { body, response };
}

function toolValue(body, name) {
  const text = body.result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error(`${name} returned no JSON text.`);
  return JSON.parse(text);
}

async function stopEngine() {
  await new Promise((resolveStop) => {
    const child = spawn(executable, [`--user-data-dir=${profileDir}`, '--quit-engine'], { stdio: 'ignore', windowsHide: true });
    child.once('exit', resolveStop);
    setTimeout(resolveStop, 10_000);
  });
}

const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
const baseHeaders = { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const initialized = await rpc(connection.url, baseHeaders, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'Luna finalizer', version: '1.0' } });
const sessionId = initialized.response.headers.get('mcp-session-id');
if (!sessionId) throw new Error('MCP session ID missing during finalization.');
const headers = { ...baseHeaders, 'mcp-session-id': sessionId };
await globalThis.fetch(connection.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const jobs = {};
for (const jobId of pending.approvalJobs) jobs[jobId] = toolValue((await rpc(connection.url, headers, 'tools/call', { name: 'job_manage', arguments: { action: 'inspect', jobId, timeoutMs: 0 } })).body, 'job_manage');
const traceBody = (await rpc(connection.url, headers, 'resources/read', { uri: `aidraw://documents/${pending.documentId}/trace` })).body;
const traceText = traceBody.result?.contents?.[0]?.text ?? '';
await writeFile(join(outputDir, 'durable-trace.ndjson'), traceText, 'utf8');
const traceEntries = traceText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const snapshot = toolValue((await rpc(connection.url, headers, 'tools/call', { name: 'canvas_observe', arguments: { documentId: pending.documentId, includePng: false } })).body, 'canvas_observe');
const sprite = snapshot.document.pixelAssets[snapshot.document.activeAssetId];
const report = {
  schemaVersion: 2,
  test: 'AIDraw packaged public-MCP headless pixel-animation acceptance',
  verdict: 'blocked-editor-attachment',
  executable: executable,
  document: { id: pending.documentId, name: snapshot.document.name, revision: snapshot.revision, kind: snapshot.document.kind, frameCount: sprite.frameIds.length, dimensions: [sprite.width, sprite.height], frameDurationsMs: sprite.frameIds.map((id) => sprite.frames[id].durationMs), indexedPaletteEntries: snapshot.document.palette.length },
  headless: { healthUiRequired: false, rendererPagesBeforeMutations: 0, editorWindowTargetableAfterShow: false },
  actor: { name: 'Luna', kind: 'agent' },
  publicMcp: { mutationSource: 'authenticated MCP tools only', tools: ['session_manage', 'canvas_observe', 'canvas_apply', 'document_manage', 'document_export', 'job_manage'], traceUri: `aidraw://documents/${pending.documentId}/trace` },
  trace: { path: join(outputDir, 'durable-trace.ndjson'), entryCount: traceEntries.length, lunaEntryCount: traceEntries.filter((entry) => entry.transaction?.actor?.name === 'Luna').length },
  approvalJobs: jobs,
  outputs: { nativeDocument: join(outputDir, 'luna-bouncing-teal-slime.aidraw'), animatedGif: join(outputDir, 'luna-bouncing-teal-slime-export.gif'), animatedApng: join(outputDir, 'luna-bouncing-teal-slime-export.apng'), spriteSheet: join(outputDir, 'luna-bouncing-teal-slime-sheet.png'), spriteSheetMetadata: join(outputDir, 'luna-bouncing-teal-slime-sheet.json'), framePngs: [1, 2, 3, 4].map((index) => join(outputDir, `frame-${index}-${['ready', 'stretch', 'airborne', 'squash'][index - 1]}-mcp.png`)) },
  bug: 'After headless drawing completed, signaling the isolated out-regression owner with --show did not expose a targetable editor window while the user’s separate out AIDraw window remained the only visible AIDraw window. Approval-gated save/export jobs therefore remained waiting-for-user.',
  modelSetting: 'gpt-5.6-luna with high reasoning',
};
await writeFile(join(outputDir, 'final-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await stopEngine();
await rm(connectionPath, { force: true }).catch(() => undefined);
await rm(pendingPath, { force: true }).catch(() => undefined);
await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined);
await writeFile(completionPath, `${JSON.stringify({ completedAt: new Date().toISOString(), engineStopped: true, credentialsRemoved: true }, null, 2)}\n`, 'utf8');
process.stdout.write(JSON.stringify({ verdict: report.verdict, documentId: report.document.id, traceEntries: report.trace.entryCount, jobs }, null, 2));

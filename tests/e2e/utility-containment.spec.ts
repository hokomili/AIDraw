import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  resolvePackagedE2eArtifact,
  spawnPackagedE2e,
} from '../../scripts/packaged-e2e-runtime.mjs';

const scenarioName = 'FND-09-UTILITY-CONTAINMENT exact package contains crash and cancellation before clean restart';
const profilePrefix = 'aidraw-e2e-fnd09-utility-containment-';
const pressureScenarioName = 'FND-09-UTILITY-PRESSURE exact package bounds and drains the real raster lane';
const pressureProfilePrefix = 'aidraw-e2e-fnd09-utility-pressure-';
const observationCodecScenarioName = 'FND-09-OBSERVATION-CODEC exact package rejects undecodable output and recovers queued observation work';
const observationCodecProfilePrefix = 'aidraw-e2e-fnd09-observation-codec-';
const quantizationResultScenarioName = 'FND-09-QUANTIZATION-RESULT exact package rejects invalid child output and recovers queued quantization work';
const quantizationResultProfilePrefix = 'aidraw-e2e-fnd09-quantization-result-';
const exportResultScenarioName = 'FND-09-EXPORT-RESULT exact package rejects invalid artifact envelopes and recovers queued export work';
const exportResultProfilePrefix = 'aidraw-e2e-fnd09-export-result-';
const importResultScenarioName = 'FND-09-IMPORT-RESULT exact package rejects invalid imported output and recovers queued import work';
const importResultProfilePrefix = 'aidraw-e2e-fnd09-import-result-';
const generationResultScenarioName = 'FND-09-GENERATION-RESULT exact package rejects invalid generated output and recovers queued generation work';
const generationResultProfilePrefix = 'aidraw-e2e-fnd09-generation-result-';
const packagedArtifact = resolvePackagedE2eArtifact();
const packagedExecutable = packagedArtifact.executable;
const packagedAsar = packagedArtifact.asar;

interface McpMessage {
  result?: Record<string, unknown>;
  error?: unknown;
}

interface McpConnection {
  version: number;
  url: string;
  token: string;
  activeDocumentId: string;
  pid: number;
  trustedFolders: string[];
}

interface UtilityProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  crash?: {
    workerPid: number;
    error: { name: string; message: string };
    restartPid: number;
    queuedExport: { bytes: number; sha256: string; warnings: string[] };
  };
  cancellation?: {
    workerPid: number;
    error: { name: string; message: string };
    restartPid: number;
    queuedExport: { bytes: number; sha256: string; warnings: string[] };
  };
  workerPidsDistinct?: boolean;
  generationLaneUntouched?: boolean;
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

interface UtilityPressureProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  oversize?: {
    boundaryBytes: number;
    rejectedBytes: number;
    base64Attempted: boolean;
    workerStarted: boolean;
    error: { name: string; message: string };
  };
  admission?: {
    activeWorkerPid: number;
    waitingLimit: number;
    queuedAtLimit: number;
    overflowError: { name: string; message: string; code: string; retryable: boolean };
  };
  cancellation?: { label: string; error: { name: string; message: string }; queuedAfterCancellation: number };
  refill?: { label: string; queuedAfterRefill: number };
  drain?: { expectedOrder: string[]; completionOrder: string[]; sameWorker: boolean; workerPid: number; queuedAfterDrain: number };
  generationLaneUntouched?: boolean;
  privacy?: { rawUtilityPayloadsPublished: boolean; publicJobCreated: boolean };
}

interface UtilityObservationCodecProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  corrupt?: {
    workerPid: number;
    error: { name: string; message: string };
    crcValidStaticEnvelopeReachedFullDecode: boolean;
    resultReturnedToCaller: boolean;
    payloadRetained: boolean;
  };
  recovery?: {
    workerPid: number;
    workerReplaced: boolean;
    queued: boolean;
    fixedCorruptResponseHoldMs: number;
    observation: { available: boolean; mimeType: string; width: number; height: number; scale: number; bytes: number; sha256: string };
  };
  generationLaneUntouched?: boolean;
  privacy?: { rendererCreated: boolean; corruptPayloadPublished: boolean; publicJobCreated: boolean };
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

interface UtilityQuantizationResultProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  overBudget?: {
    workerPid: number;
    error: { name: string; message: string };
    resultReturnedToCaller: boolean;
    payloadRetained: boolean;
    requestPixelBudget: number;
    returnedChanges: number;
    countGateBeforeDuplicateAllocation: boolean;
    queuedRecovery: { workerPid: number; workerReplaced: boolean; queued: boolean; changes: number; sha256: string };
  };
  contradictory?: {
    workerPid: number;
    error: { name: string; message: string };
    resultReturnedToCaller: boolean;
    payloadRetained: boolean;
    contradiction: string;
    queuedRecovery: { workerPid: number; workerReplaced: boolean; queued: boolean; changes: number; sha256: string };
  };
  fixedInvalidResponseHoldMs?: number;
  workerPidsDistinct?: boolean;
  generationLaneUntouched?: boolean;
  privacy?: { rendererCreated: boolean; invalidPayloadPublished: boolean; publicJobCreated: boolean };
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

interface UtilityExportResultProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  realExporter?: { format: string; primary: string; companion: string };
  primary?: {
    workerPid: number;
    error: { name: string; message: string };
    resultReturnedToCaller: boolean;
    payloadRetained: boolean;
    rejectedBeforeCallerBase64Decode: boolean;
    exportTargetWritten: boolean;
    queuedRecovery: {
      workerPid: number;
      workerReplaced: boolean;
      queued: boolean;
      primary: { bytes: number; sha256: string; mimeType: string; extension: string };
      companion: { bytes: number; sha256: string; mimeType: string; extension: string };
      warnings: string[];
      rasterized: string[];
    };
  };
  companion?: UtilityExportResultProbeEvidence['primary'];
  fixedInvalidResponseHoldMs?: number;
  workerPidsDistinct?: boolean;
  generationLaneUntouched?: boolean;
  privacy?: { rendererCreated: boolean; invalidPayloadPublished: boolean; publicJobCreated: boolean };
  filesystem?: { exportTargetsCreated: number };
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

interface UtilityImportResultProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  realImporter?: { format: string; fixtureBytes: number; fixtureSha256: string };
  documentSchema?: {
    workerPid: number;
    error: { name: string; message: string };
    resultReturnedToCaller: boolean;
    payloadRetained: boolean;
    rejectedBeforeWorkspaceUse: boolean;
    queuedRecovery: {
      workerPid: number;
      workerReplaced: boolean;
      queued: boolean;
      documentCount: number;
      schemaVersion: number;
      kind: string;
      name: string;
      width: number;
      height: number;
      layerCount: number;
      objectCount: number;
      warnings: string[];
      semanticSha256: string;
    };
  };
  warningShape?: UtilityImportResultProbeEvidence['documentSchema'];
  fixedInvalidResponseHoldMs?: number;
  workerPidsDistinct?: boolean;
  generationLaneUntouched?: boolean;
  privacy?: { rendererCreated: boolean; invalidPayloadPublished: boolean; publicJobCreated: boolean };
  filesystem?: { importInputsCreated: number; outputTargetsCreated: number };
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

interface UtilityGenerationResultFaultEvidence {
  fault: string;
  contract: string;
  workerPid: number;
  error: { name: string; message: string };
  resultReturnedToCaller: boolean;
  payloadRetained: boolean;
  rejectedBeforePreviewOrJobUse: boolean;
  queuedRecovery: {
    workerPid: number;
    workerReplaced: boolean;
    queued: boolean;
    outputCount: number;
    mimeType: string;
    width: number;
    height: number;
    seed: number;
    providerMetadataRecord: boolean;
    bytes: number;
    sha256: string;
    semanticSha256: string;
  };
}

interface UtilityGenerationResultProbeEvidence {
  version: number;
  scenario: string;
  result: 'passed' | 'failed';
  canonical: {
    before: { documentId: string; revision: number; sha256: string };
    after?: { documentId: string; revision: number; sha256: string };
    unchanged?: boolean;
  };
  requestContract?: {
    provider: string;
    mode: string;
    resultCount: number;
    width: number;
    height: number;
    seed: number;
    credentialSupplied: boolean;
    providerInvoked: boolean;
  };
  resultCount?: UtilityGenerationResultFaultEvidence;
  mimeHeader?: UtilityGenerationResultFaultEvidence;
  dimensionHeader?: UtilityGenerationResultFaultEvidence;
  seed?: UtilityGenerationResultFaultEvidence;
  metadata?: UtilityGenerationResultFaultEvidence;
  fixedInvalidResponseHoldMs?: number;
  workerPidsDistinct?: boolean;
  recoverySemanticHashesAgree?: boolean;
  rasterLaneUntouched?: boolean;
  privacy?: {
    rendererCreated: boolean;
    invalidPayloadPublished: boolean;
    publicJobCreated: boolean;
    promptRetained: boolean;
    providerMetadataRetained: boolean;
  };
  filesystem?: { inputTargetsCreated: number; outputTargetsCreated: number };
  network: { nonLoopbackRequests: number; externalProviderRequests: number; paidRequests: number };
}

function parseMcp(text: string): McpMessage {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as McpMessage;
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!data.length) throw new Error('The packaged MCP server returned an unrecognized response.');
  return JSON.parse(data.at(-1)!) as McpMessage;
}

function toolResult(message: McpMessage): Record<string, unknown> {
  if (message.error) throw new Error(`The packaged MCP call failed: ${JSON.stringify(message.error)}`);
  const content = message.result?.content as Array<{ type?: string; text?: string }> | undefined;
  const text = content?.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error('The packaged MCP tool did not return JSON text.');
  return JSON.parse(text) as Record<string, unknown>;
}

async function postMcp(url: string, headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>): Promise<McpMessage> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw new Error(`The packaged MCP ${method} request returned HTTP ${response.status}.`);
  return parseMcp(await response.text());
}

async function callTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return toolResult(await postMcp(url, headers, id, 'tools/call', { name, arguments: args }));
}

async function connectMcp(connection: McpConnection): Promise<Record<string, string>> {
  const response = await fetch(connection.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fnd09-packaged-utility-observer', version: '1.0.0' } } }),
  });
  const sessionId = response.headers.get('mcp-session-id');
  const initialized = parseMcp(await response.text());
  if (!response.ok || !sessionId || !initialized.result) throw new Error('The packaged FND-09 MCP observer could not initialize.');
  const headers = { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': sessionId };
  await fetch(connection.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return headers;
}

async function waitForJson<T>(path: string, child: ChildProcess, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The packaged FND-09 engine exited before ${label} with code ${child.exitCode}.`);
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
  }
  throw new Error(`The packaged FND-09 engine did not write ${label} in time.`);
}

async function waitForConnection(path: string, child: ChildProcess): Promise<McpConnection> {
  const connection = await waitForJson<Partial<McpConnection>>(path, child, 'its isolated MCP connection');
  if (connection.version !== 1 || !connection.url || !connection.token || !connection.activeDocumentId || !Number.isInteger(connection.pid)) {
    throw new Error('The packaged FND-09 MCP connection has the wrong shape.');
  }
  return connection as McpConnection;
}

async function waitForExit(child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveWait, reject) => {
    const onExit = () => { clearTimeout(timer); resolveWait(); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); reject(new Error(`${label} did not exit gracefully within ${timeoutMs} ms.`)); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function quitGracefully(profile: string, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const signal = spawnPackagedE2e(packagedExecutable, [`--user-data-dir=${profile}`, '--quit-engine'], { stdio: 'ignore' });
  await waitForExit(signal, 'The isolated FND-09 quit signal', 5_000);
  await waitForExit(child, 'The isolated packaged FND-09 engine', 15_000);
}

async function redactConnection(path: string): Promise<'redacted-after-graceful-stop' | 'absent'> {
  if (!await access(path).then(() => true, () => false)) return 'absent';
  const connection = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  delete connection.token;
  await writeFile(path, `${JSON.stringify({ ...connection, credentialStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, 'utf8');
  return 'redacted-after-graceful-stop';
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

test(scenarioName, async () => {
  test.setTimeout(60_000);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_UTILITY_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_UTILITY_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(profilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_UTILITY_PROFILE must be a new ${profilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 utility profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_UTILITY_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_UTILITY_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-utility-containment-probe.json');
  const evidencePath = join(profile, 'fnd09-utility-containment-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_CONTAINMENT: '1',
      AIDRAW_E2E_FND09_UTILITY_PROFILE: profile,
      AIDRAW_E2E_FND09_UTILITY_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_UTILITY_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityProbeEvidence>(probePath, child, 'its fixed utility containment probe');
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged raster utility crash/cancel/restart containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      crash: { workerPid: expect.any(Number), restartPid: expect.any(Number), queuedExport: { bytes: expect.any(Number), sha256: expect.any(String), warnings: [] } },
      cancellation: { workerPid: expect.any(Number), restartPid: expect.any(Number), error: { name: 'AbortError' }, queuedExport: { bytes: expect.any(Number), sha256: expect.any(String), warnings: [] } },
      workerPidsDistinct: true,
      generationLaneUntouched: true,
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(probe.crash?.error.message).toContain('exited unexpectedly');
    expect(probe.crash?.queuedExport).toEqual(probe.cancellation?.queuedExport);
    expect(new Set([probe.crash?.workerPid, probe.crash?.restartPid, probe.cancellation?.restartPid]).size).toBe(3);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const joined = await callTool(connection.url, headers, 2, 'session_manage', { action: 'join', name: 'FND-09 utility observer', color: '#4f79b8' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 utility observer', color: '#4f79b8' } });
    const observed = await callTool(connection.url, headers, 3, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: true, scale: 1, background: 'transparent' });
    expect(observed).toMatchObject({
      document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision },
      revision: probe.canonical.before.revision,
      png: { available: true, width: expect.any(Number), height: expect.any(Number), data: expect.any(String) },
    });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 4, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: scenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', connectionPidMatched: true, loopbackOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 utility observer', color: '#4f79b8' },
      containment: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, postRestartPngAvailable: true, publicJobs: [] },
      privacy: { publicJobSummariesEmpty: true, rawUtilityResultsNotPublished: true },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: scenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});

test(pressureScenarioName, async () => {
  test.setTimeout(60_000);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_PRESSURE_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_PRESSURE_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(pressureProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_PRESSURE_PROFILE must be a new ${pressureProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 pressure profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_PRESSURE_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_PRESSURE_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 pressure executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-utility-pressure-probe.json');
  const evidencePath = join(profile, 'fnd09-utility-pressure-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-pressure-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_PRESSURE: '1',
      AIDRAW_E2E_FND09_PRESSURE_PROFILE: profile,
      AIDRAW_E2E_FND09_PRESSURE_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_PRESSURE_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityPressureProbeEvidence>(probePath, child, 'its fixed utility pressure probe');
    const expectedOrder = [
      ...Array.from({ length: 32 }, (_, index) => `queued-${index}`).filter((label) => label !== 'queued-10'),
      'replacement',
    ];
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged raster utility admission pressure containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      oversize: { boundaryBytes: 1_500_000, rejectedBytes: 1_500_001, base64Attempted: false, workerStarted: false, error: { message: 'Encoded image exceeds the utility input limit.' } },
      admission: { activeWorkerPid: expect.any(Number), waitingLimit: 32, queuedAtLimit: 32, overflowError: { name: 'UtilityBackpressureError', code: 'utility_queue_full', retryable: true } },
      cancellation: { label: 'queued-10', error: { name: 'AbortError' }, queuedAfterCancellation: 31 },
      refill: { label: 'replacement', queuedAfterRefill: 32 },
      drain: { expectedOrder, completionOrder: expectedOrder, sameWorker: true, workerPid: expect.any(Number), queuedAfterDrain: 0 },
      generationLaneUntouched: true,
      privacy: { rawUtilityPayloadsPublished: false, publicJobCreated: false },
    });
    expect(probe.admission?.activeWorkerPid).toBe(probe.drain?.workerPid);
    expect(probe.admission?.overflowError.message).toBe('Utility queue reached the 32-task waiting limit. Retry after current work completes.');

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const joined = await callTool(connection.url, headers, 2, 'session_manage', { action: 'join', name: 'FND-09 pressure observer', color: '#7456a8' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 pressure observer', color: '#7456a8' } });
    const observed = await callTool(connection.url, headers, 3, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: false });
    expect(observed).toMatchObject({ document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision }, revision: probe.canonical.before.revision });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 4, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: pressureScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 pressure observer', color: '#7456a8' },
      pressure: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, publicJobs: [] },
      privacy: { publicJobSummariesEmpty: true, rawUtilityPayloadsNotPublished: true },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 pressure engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 pressure connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: pressureScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});

test(observationCodecScenarioName, async () => {
  // This audited observer must never let Playwright terminate its worker on a timeout.
  // Every bounded wait below rejects without signaling either the app or quit helper.
  test.setTimeout(0);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(observationCodecProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE must be a new ${observationCodecProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 observation codec profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_OBSERVATION_CODEC_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 observation codec executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-observation-codec-probe.json');
  const evidencePath = join(profile, 'fnd09-observation-codec-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-observation-codec-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_OBSERVATION_CODEC: '1',
      AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE: profile,
      AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_OBSERVATION_CODEC_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityObservationCodecProbeEvidence>(probePath, child, 'its fixed observation codec probe');
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged observation codec result containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      corrupt: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned an undecodable observation image.' },
        crcValidStaticEnvelopeReachedFullDecode: true,
        resultReturnedToCaller: false,
        payloadRetained: false,
      },
      recovery: {
        workerPid: expect.any(Number),
        workerReplaced: true,
        queued: true,
        fixedCorruptResponseHoldMs: 150,
        observation: { available: true, mimeType: 'image/png', width: 8, height: 6, scale: 1, bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      generationLaneUntouched: true,
      privacy: { rendererCreated: false, corruptPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(probe.corrupt?.workerPid).not.toBe(probe.recovery?.workerPid);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const listed = await postMcp(connection.url, headers, 2, 'tools/list', {});
    const listedTools = listed.result?.tools;
    if (!Array.isArray(listedTools)) throw new Error('The packaged MCP observer did not receive tools/list.');
    const toolNames = listedTools.map((entry) => String((entry as { name?: unknown }).name));
    expect(toolNames).not.toContain('runE2eObservationCodecProbe');
    expect(toolNames).not.toContain('observation-codec-probe');

    const joined = await callTool(connection.url, headers, 3, 'session_manage', { action: 'join', name: 'FND-09 observation codec observer', color: '#386d91' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 observation codec observer', color: '#386d91' } });
    const observed = await callTool(connection.url, headers, 4, 'canvas_observe', {
      documentId: connection.activeDocumentId,
      includePng: true,
      scale: 1,
      background: 'transparent',
      region: { x: 0, y: 0, width: 8, height: 6 },
    });
    expect(observed).toMatchObject({
      document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision },
      revision: probe.canonical.before.revision,
      png: { available: true, width: 8, height: 6, data: expect.any(String) },
    });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const observedPng = observed.png as { data: string };
    expect(createHash('sha256').update(Buffer.from(observedPng.data, 'base64')).digest('hex').toUpperCase()).toBe(probe.recovery?.observation.sha256);
    const jobs = await callTool(connection.url, headers, 5, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: observationCodecScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', rendererCreated: false, connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 observation codec observer', color: '#386d91' },
      observationCodec: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, recoveryPngMatchedProbe: true, publicJobs: [] },
      privacy: { hookAbsentFromToolsList: true, corruptUtilityPayloadNotPublished: true, publicJobSummariesEmpty: true },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 observation codec engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 observation codec connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: observationCodecScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedProbe = await readFile(probePath, 'utf8');
  expect(retainedProbe).not.toMatch(/"data"\s*:|"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"data"\s*:|"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});
// FND-09-OBSERVATION-CODEC observer end.

test(quantizationResultScenarioName, async () => {
  // This audited observer must never let Playwright terminate its worker on a timeout.
  // Every bounded wait below rejects without signaling either the app or quit helper.
  test.setTimeout(0);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(quantizationResultProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE must be a new ${quantizationResultProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 quantization-result profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_QUANTIZATION_RESULT_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 quantization-result executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-quantization-result-probe.json');
  const evidencePath = join(profile, 'fnd09-quantization-result-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-quantization-result-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT: '1',
      AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE: profile,
      AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_QUANTIZATION_RESULT_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityQuantizationResultProbeEvidence>(probePath, child, 'its fixed quantization-result probe');
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged quantization result containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      overBudget: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility quantization result exceeds its 1-pixel output budget.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        requestPixelBudget: 1,
        returnedChanges: 2,
        countGateBeforeDuplicateAllocation: true,
        queuedRecovery: { workerPid: expect.any(Number), workerReplaced: true, queued: true, changes: 1, sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      contradictory: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned a malformed quantization result.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        contradiction: 'x=1 lies outside the originating 1x1 request',
        queuedRecovery: { workerPid: expect.any(Number), workerReplaced: true, queued: true, changes: 1, sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      fixedInvalidResponseHoldMs: 150,
      workerPidsDistinct: true,
      generationLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(probe.overBudget?.workerPid).not.toBe(probe.overBudget?.queuedRecovery.workerPid);
    expect(probe.contradictory?.workerPid).toBe(probe.overBudget?.queuedRecovery.workerPid);
    expect(probe.contradictory?.workerPid).not.toBe(probe.contradictory?.queuedRecovery.workerPid);
    expect(probe.overBudget?.queuedRecovery.sha256).toBe(probe.contradictory?.queuedRecovery.sha256);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const listed = await postMcp(connection.url, headers, 2, 'tools/list', {});
    const listedTools = listed.result?.tools;
    if (!Array.isArray(listedTools)) throw new Error('The packaged MCP observer did not receive tools/list.');
    const toolNames = listedTools.map((entry) => String((entry as { name?: unknown }).name));
    expect(toolNames).not.toContain('runE2eQuantizationResultProbe');
    expect(toolNames).not.toContain('quantization-result-probe');
    expect(toolNames).not.toContain('e2eResultFault');

    const joined = await callTool(connection.url, headers, 3, 'session_manage', { action: 'join', name: 'FND-09 quantization result observer', color: '#6b4f9c' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 quantization result observer', color: '#6b4f9c' } });
    const observed = await callTool(connection.url, headers, 4, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: false });
    expect(observed).toMatchObject({ document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision }, revision: probe.canonical.before.revision });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 5, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: quantizationResultScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', rendererCreated: false, connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 quantization result observer', color: '#6b4f9c' },
      quantizationResult: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, publicJobs: [] },
      privacy: { hookAbsentFromToolsList: true, invalidUtilityPayloadsNotPublished: true, publicJobSummariesEmpty: true },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 quantization-result engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 quantization-result connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: quantizationResultScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedProbe = await readFile(probePath, 'utf8');
  expect(retainedProbe).not.toMatch(/"data"\s*:|"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"data"\s*:|"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});
// FND-09-QUANTIZATION-RESULT observer end.

test(exportResultScenarioName, async () => {
  // This audited observer must never let Playwright terminate its worker on a timeout.
  // Every bounded wait below rejects without signaling either the app or quit helper.
  test.setTimeout(0);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(exportResultProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE must be a new ${exportResultProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 export-result profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_EXPORT_RESULT_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 export-result executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-export-result-probe.json');
  const evidencePath = join(profile, 'fnd09-export-result-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-export-result-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_EXPORT_RESULT: '1',
      AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE: profile,
      AIDRAW_E2E_FND09_EXPORT_RESULT_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_EXPORT_RESULT_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityExportResultProbeEvidence>(probePath, child, 'its fixed export-result probe');
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged export artifact result containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      realExporter: { format: 'sprite-sheet', primary: 'image/png', companion: 'application/json' },
      primary: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned a malformed export artifact.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeCallerBase64Decode: true,
        exportTargetWritten: false,
        queuedRecovery: {
          workerPid: expect.any(Number), workerReplaced: true, queued: true,
          primary: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/), mimeType: 'image/png', extension: 'png' },
          companion: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/), mimeType: 'application/json', extension: 'json' },
          warnings: [], rasterized: [],
        },
      },
      companion: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned a malformed export companion.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeCallerBase64Decode: true,
        exportTargetWritten: false,
        queuedRecovery: {
          workerPid: expect.any(Number), workerReplaced: true, queued: true,
          primary: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/), mimeType: 'image/png', extension: 'png' },
          companion: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/), mimeType: 'application/json', extension: 'json' },
          warnings: [], rasterized: [],
        },
      },
      fixedInvalidResponseHoldMs: 150,
      workerPidsDistinct: true,
      generationLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { exportTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(probe.primary?.workerPid).not.toBe(probe.primary?.queuedRecovery.workerPid);
    expect(probe.companion?.workerPid).toBe(probe.primary?.queuedRecovery.workerPid);
    expect(probe.companion?.workerPid).not.toBe(probe.companion?.queuedRecovery.workerPid);
    expect(probe.primary?.queuedRecovery.primary.sha256).toBe(probe.companion?.queuedRecovery.primary.sha256);
    expect(probe.primary?.queuedRecovery.companion.sha256).toBe(probe.companion?.queuedRecovery.companion.sha256);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const listed = await postMcp(connection.url, headers, 2, 'tools/list', {});
    const listedTools = listed.result?.tools;
    if (!Array.isArray(listedTools)) throw new Error('The packaged MCP observer did not receive tools/list.');
    const toolNames = listedTools.map((entry) => String((entry as { name?: unknown }).name));
    expect(toolNames).not.toContain('runE2eExportResultProbe');
    expect(toolNames).not.toContain('export-result-probe');
    expect(toolNames).not.toContain('e2eArtifactFault');

    const joined = await callTool(connection.url, headers, 3, 'session_manage', { action: 'join', name: 'FND-09 export result observer', color: '#3b728f' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 export result observer', color: '#3b728f' } });
    const observed = await callTool(connection.url, headers, 4, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: false });
    expect(observed).toMatchObject({ document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision }, revision: probe.canonical.before.revision });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 5, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: exportResultScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', rendererCreated: false, connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 export result observer', color: '#3b728f' },
      exportResult: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, publicJobs: [] },
      privacy: { hookAbsentFromToolsList: true, invalidUtilityPayloadsNotPublished: true, publicJobSummariesEmpty: true },
      filesystem: { exportTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 export-result engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 export-result connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: exportResultScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedProbe = await readFile(probePath, 'utf8');
  expect(retainedProbe).not.toMatch(/"data(?:Base64)?"\s*:|"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"data(?:Base64)?"\s*:|"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});
// FND-09-EXPORT-RESULT observer end.

test(importResultScenarioName, async () => {
  // This audited observer must never let Playwright terminate its worker on a timeout.
  // Every bounded wait below rejects without signaling either the app or quit helper.
  test.setTimeout(0);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(importResultProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE must be a new ${importResultProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 import-result profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_IMPORT_RESULT_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 import-result executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-import-result-probe.json');
  const fixturePath = join(profile, 'fnd09-import-result-fixture.svg');
  const evidencePath = join(profile, 'fnd09-import-result-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-import-result-forbidden-network.json');
  for (const path of [connectionPath, probePath, fixturePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AIDRAW_E2E_UTILITY_IMPORT_RESULT: '1',
      AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE: profile,
      AIDRAW_E2E_FND09_IMPORT_RESULT_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_IMPORT_RESULT_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityImportResultProbeEvidence>(probePath, child, 'its fixed import-result probe');
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged import result containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      realImporter: { format: 'svg', fixtureBytes: expect.any(Number), fixtureSha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      documentSchema: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned a malformed imported document.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeWorkspaceUse: true,
        queuedRecovery: {
          workerPid: expect.any(Number), workerReplaced: true, queued: true,
          documentCount: 1, schemaVersion: 2, kind: 'illustration', width: 4, height: 3,
          layerCount: expect.any(Number), objectCount: expect.any(Number), warnings: [], semanticSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        },
      },
      warningShape: {
        workerPid: expect.any(Number),
        error: { message: 'Raster utility returned malformed import warnings.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeWorkspaceUse: true,
        queuedRecovery: {
          workerPid: expect.any(Number), workerReplaced: true, queued: true,
          documentCount: 1, schemaVersion: 2, kind: 'illustration', width: 4, height: 3,
          layerCount: expect.any(Number), objectCount: expect.any(Number), warnings: [], semanticSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        },
      },
      fixedInvalidResponseHoldMs: 150,
      workerPidsDistinct: true,
      generationLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { importInputsCreated: 1, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(probe.documentSchema?.workerPid).not.toBe(probe.documentSchema?.queuedRecovery.workerPid);
    expect(probe.warningShape?.workerPid).toBe(probe.documentSchema?.queuedRecovery.workerPid);
    expect(probe.warningShape?.workerPid).not.toBe(probe.warningShape?.queuedRecovery.workerPid);
    expect(probe.documentSchema?.queuedRecovery.semanticSha256).toBe(probe.warningShape?.queuedRecovery.semanticSha256);

    const fixture = await readFile(fixturePath);
    expect(fixture.byteLength).toBe(probe.realImporter?.fixtureBytes);
    expect(createHash('sha256').update(fixture).digest('hex').toUpperCase()).toBe(probe.realImporter?.fixtureSha256);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const listed = await postMcp(connection.url, headers, 2, 'tools/list', {});
    const listedTools = listed.result?.tools;
    if (!Array.isArray(listedTools)) throw new Error('The packaged MCP observer did not receive tools/list.');
    const toolNames = listedTools.map((entry) => String((entry as { name?: unknown }).name));
    expect(toolNames).not.toContain('runE2eImportResultProbe');
    expect(toolNames).not.toContain('import-result-probe');
    expect(toolNames).not.toContain('e2eResultFault');

    const joined = await callTool(connection.url, headers, 3, 'session_manage', { action: 'join', name: 'FND-09 import result observer', color: '#6f4c8b' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 import result observer', color: '#6f4c8b' } });
    const observed = await callTool(connection.url, headers, 4, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: false });
    expect(observed).toMatchObject({ document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision }, revision: probe.canonical.before.revision });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 5, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: importResultScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', rendererCreated: false, connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 import result observer', color: '#6f4c8b' },
      importResult: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, publicJobs: [] },
      privacy: { hookAbsentFromToolsList: true, invalidUtilityPayloadsNotPublished: true, publicJobSummariesEmpty: true },
      filesystem: { importInputsCreated: 1, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 import-result engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 import-result connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: importResultScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedProbe = await readFile(probePath, 'utf8');
  expect(retainedProbe).not.toMatch(/"documents?"\s*:|"data(?:Base64)?"\s*:|"token"|Authorization|Bearer/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"documents?"\s*:|"data(?:Base64)?"\s*:|"token"|Authorization|Bearer/i);
  if (failure) throw failure;
});
// FND-09-IMPORT-RESULT observer end.

test(generationResultScenarioName, async () => {
  // This audited observer must never let Playwright terminate its worker on a timeout.
  // Every bounded wait below rejects without signaling either the app or quit helper.
  test.setTimeout(0);
  const configuredProfile = process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || dirname(profile) !== retainedRoot || !basename(profile).startsWith(generationResultProfilePrefix)) {
    throw new Error(`AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE must be a new ${generationResultProfilePrefix}* direct child of test-results/retained.`);
  }
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable FND-09 generation-result profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_FND09_GENERATION_RESULT_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact FND-09 generation-result executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const probePath = join(profile, 'fnd09-generation-result-probe.json');
  const evidencePath = join(profile, 'fnd09-generation-result-evidence.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const providerCredentialsPath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'fnd09-generation-result-forbidden-network.json');
  for (const path of [connectionPath, probePath, evidencePath, tokenPath, trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawn(packagedExecutable, [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    `--user-data-dir=${profile}`,
    '--headless',
    `--write-mcp-connection=${connectionPath}`,
  ], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENAI_API_KEY: '',
      STABILITY_API_KEY: '',
      COMFYUI_API_KEY: '',
      AIDRAW_E2E_UTILITY_GENERATION_RESULT: '1',
      AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE: profile,
      AIDRAW_E2E_FND09_GENERATION_RESULT_PROBE_PATH: probePath,
      AIDRAW_E2E_FND09_GENERATION_RESULT_NETWORK_SENTINEL_PATH: forbiddenNetworkPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: process.platform === 'win32',
  });

  let failure: Error | undefined;
  let runtimeEvidence: Record<string, unknown> | undefined;
  let credentialStatus: 'redacted-after-graceful-stop' | 'absent' = 'absent';
  let executableBytes = 0;
  let asarBytes = 0;
  try {
    const connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const probe = await waitForJson<UtilityGenerationResultProbeEvidence>(probePath, child, 'its fixed generation-result probe');
    const recoveryShape = {
      workerPid: expect.any(Number), workerReplaced: true, queued: true,
      outputCount: 1, mimeType: 'image/png', width: 1, height: 1, seed: 24_681_357,
      providerMetadataRecord: true, bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/), semanticSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
    };
    expect(probe).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged generation result containment',
      result: 'passed',
      canonical: { before: { documentId: connection.activeDocumentId }, after: { documentId: connection.activeDocumentId }, unchanged: true },
      requestContract: { provider: 'stability', mode: 'create', resultCount: 1, width: 1, height: 1, seed: 24_681_357, credentialSupplied: false, providerInvoked: false },
      resultCount: {
        fault: 'result-count', contract: 'originating resultCount', workerPid: expect.any(Number),
        error: { message: 'Generation utility returned more than the requested 1 result.' },
        resultReturnedToCaller: false, payloadRetained: false, rejectedBeforePreviewOrJobUse: true, queuedRecovery: recoveryShape,
      },
      mimeHeader: {
        fault: 'mime-header', contract: 'MIME/header agreement', workerPid: expect.any(Number),
        error: { message: 'Generation utility returned a malformed image result.' },
        resultReturnedToCaller: false, payloadRetained: false, rejectedBeforePreviewOrJobUse: true, queuedRecovery: recoveryShape,
      },
      dimensionHeader: {
        fault: 'dimension-header', contract: 'declared/header dimensions', workerPid: expect.any(Number),
        error: { message: 'Generation utility returned a malformed image result.' },
        resultReturnedToCaller: false, payloadRetained: false, rejectedBeforePreviewOrJobUse: true, queuedRecovery: recoveryShape,
      },
      seed: {
        fault: 'seed', contract: 'request-derived Stability seed', workerPid: expect.any(Number),
        error: { message: 'Generation utility returned a malformed result.' },
        resultReturnedToCaller: false, payloadRetained: false, rejectedBeforePreviewOrJobUse: true, queuedRecovery: recoveryShape,
      },
      metadata: {
        fault: 'metadata', contract: 'record-shaped provider metadata', workerPid: expect.any(Number),
        error: { message: 'Generation utility returned a malformed result.' },
        resultReturnedToCaller: false, payloadRetained: false, rejectedBeforePreviewOrJobUse: true, queuedRecovery: recoveryShape,
      },
      fixedInvalidResponseHoldMs: 150,
      workerPidsDistinct: true,
      recoverySemanticHashesAgree: true,
      rasterLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false, promptRetained: false, providerMetadataRetained: false },
      filesystem: { inputTargetsCreated: 0, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    const faults = [probe.resultCount, probe.mimeHeader, probe.dimensionHeader, probe.seed, probe.metadata];
    for (let index = 1; index < faults.length; index += 1) expect(faults[index]?.workerPid).toBe(faults[index - 1]?.queuedRecovery.workerPid);
    const workerPids = [faults[0]?.workerPid, ...faults.map((entry) => entry?.queuedRecovery.workerPid)];
    expect(new Set(workerPids).size).toBe(6);
    expect(new Set(faults.map((entry) => entry?.queuedRecovery.semanticSha256)).size).toBe(1);

    const tokenFile = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tokenFile).sort()).toEqual(['encryption', 'value', 'version']);
    expect(tokenFile.encryption).toBe('electron-safe-storage');
    expect(tokenFile.value).not.toBe(connection.token);

    const headers = await connectMcp(connection);
    const listed = await postMcp(connection.url, headers, 2, 'tools/list', {});
    const listedTools = listed.result?.tools;
    if (!Array.isArray(listedTools)) throw new Error('The packaged MCP observer did not receive tools/list.');
    const toolNames = listedTools.map((entry) => String((entry as { name?: unknown }).name));
    expect(toolNames).not.toContain('runE2eGenerationResultProbe');
    expect(toolNames).not.toContain('generation-result-probe');
    expect(toolNames).not.toContain('e2eResultFixture');

    const joined = await callTool(connection.url, headers, 3, 'session_manage', { action: 'join', name: 'FND-09 generation result observer', color: '#8a5b32' });
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'FND-09 generation result observer', color: '#8a5b32' } });
    const observed = await callTool(connection.url, headers, 4, 'canvas_observe', { documentId: connection.activeDocumentId, includePng: false });
    expect(observed).toMatchObject({ document: { id: connection.activeDocumentId, revision: probe.canonical.before.revision }, revision: probe.canonical.before.revision });
    expect(createHash('sha256').update(JSON.stringify(observed.document)).digest('hex').toUpperCase()).toBe(probe.canonical.before.sha256);
    const jobs = await callTool(connection.url, headers, 5, 'job_manage', { action: 'list' });
    expect(jobs).toEqual({ jobs: [] });

    for (const sentinel of [trustSettingsPath, providerCredentialsPath, forbiddenNetworkPath]) {
      expect(await access(sentinel).then(() => true, () => false)).toBe(false);
    }
    executableBytes = (await stat(packagedExecutable)).size;
    asarBytes = (await stat(packagedAsar)).size;
    runtimeEvidence = {
      scenario: generationResultScenarioName,
      package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      launch: { mode: 'headless', rendererCreated: false, connectionPidMatched: true, loopbackMcpOnly: true, trustedFolders: [] },
      actor: { name: 'FND-09 generation result observer', color: '#8a5b32' },
      generationResult: probe,
      authenticatedMcp: { documentId: connection.activeDocumentId, revision: observed.revision, canonicalMatchedProbe: true, publicJobs: [] },
      privacy: { hookAbsentFromToolsList: true, invalidUtilityPayloadsNotPublished: true, publicJobSummariesEmpty: true, promptsRetained: false, providerMetadataRetained: false },
      filesystem: { inputTargetsCreated: 0, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      sentinels: { trustAbsent: true, providerCredentialsAbsent: true, forbiddenNetworkAbsent: true },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    let cleanupError: Error | undefined;
    try { await quitGracefully(profile, child); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('The packaged FND-09 generation-result engine did not stop gracefully.'); }
    try { credentialStatus = await redactConnection(connectionPath); }
    catch (error) { cleanupError ??= error instanceof Error ? error : new Error('The packaged FND-09 generation-result connection could not be redacted.'); }

    const retainedEvidence = {
      ...(runtimeEvidence ?? {
        scenario: generationResultScenarioName,
        package: { executable: packagedExecutable, executableBytes, executableSha256: executableHash, asar: packagedAsar, asarBytes, asarSha256: asarHash },
      }),
      result: failure || cleanupError ? 'failed' : 'passed',
      error: failure?.message ?? cleanupError?.message,
      cleanup: { gracefulOnly: true, exitCode: child.exitCode, credentialStatus },
    };
    await writeFile(evidencePath, `${JSON.stringify(retainedEvidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    if (!failure && cleanupError) failure = cleanupError;
  }

  expect(child.exitCode).toBe(0);
  expect(credentialStatus).toBe('redacted-after-graceful-stop');
  const retainedConnection = await readFile(connectionPath, 'utf8');
  expect(retainedConnection).toContain('redacted-after-graceful-stop');
  expect(retainedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  const retainedProbe = await readFile(probePath, 'utf8');
  expect(retainedProbe).not.toMatch(/"data(?:Base64)?"\s*:|"token"|Authorization|Bearer|"prompt"\s*:|"credential"\s*:|"providerMetadata"\s*:/i);
  const retainedEvidence = await readFile(evidencePath, 'utf8');
  expect(retainedEvidence).not.toMatch(/"data(?:Base64)?"\s*:|"token"|Authorization|Bearer|"prompt"\s*:|"credential"\s*:|"providerMetadata"\s*:/i);
  if (failure) throw failure;
});
// FND-09-GENERATION-RESULT observer end.

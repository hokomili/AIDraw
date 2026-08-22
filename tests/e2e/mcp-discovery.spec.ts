import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { initializeDirectMcp, readMcpConnectionHandoff } from '../../scripts/mcp-direct-client.mjs';
import { resolvePackagedE2eArtifact, spawnPackagedE2e } from '../../scripts/packaged-e2e-runtime.mjs';

const scenarioName = 'MCP-COLD-DISCOVERY exact package teaches a tools-only client without repository context';
const profilePrefix = 'aidraw-e2e-mcp-discovery-';
const packagedArtifact = resolvePackagedE2eArtifact();
const packagedExecutable = packagedArtifact.executable;
const packagedAsar = packagedArtifact.asar;

interface McpMessage {
  result?: Record<string, unknown>;
  error?: unknown;
}

interface McpConnection {
  version: 2;
  url: string;
  token: string;
  authority: 'engine-process';
  activeDocumentId: string;
  pid: number;
  trustedFolders: string[];
}

interface DiscoverySchema {
  const?: unknown;
  description?: string;
  properties?: Record<string, DiscoverySchema>;
  required?: string[];
  oneOf?: DiscoverySchema[];
  anyOf?: DiscoverySchema[];
  additionalProperties?: boolean;
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

async function callTool(url: string, headers: Record<string, string>, id: number, name: string, args: Record<string, unknown>): Promise<{ message: McpMessage; value: Record<string, unknown> }> {
  const message = await postMcp(url, headers, id, 'tools/call', { name, arguments: args });
  return { message, value: toolResult(message) };
}

async function connectColdClient(connection: McpConnection, name: string): Promise<{ initialize: Record<string, unknown>; headers: Record<string, string> }> {
  const initialized = await initializeDirectMcp(connection, { clientInfo: { name, version: '1.0.0' } });
  return { initialize: initialized.initialize, headers: initialized.headers };
}

async function waitForConnection(path: string, child: ChildProcess): Promise<McpConnection> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The nominated packaged engine exited before MCP startup with code ${child.exitCode}.`);
    try {
      const value = await readMcpConnectionHandoff(path);
      if (value.activeDocumentId) return value as McpConnection;
    } catch { /* The isolated engine is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The nominated packaged engine did not write its isolated MCP connection in time.');
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
  await waitForExit(signal, 'The isolated quit signal', 5_000);
  await waitForExit(child, 'The isolated packaged engine', 15_000);
}

async function redactConnection(path: string): Promise<void> {
  const connection = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  delete connection.token;
  await writeFile(path, `${JSON.stringify({ ...connection, authorityStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, 'utf8');
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

function actionBranch(schema: DiscoverySchema | undefined, action: string): DiscoverySchema | undefined {
  return [...(schema?.oneOf ?? []), ...(schema?.anyOf ?? [])].find((branch) => branch.properties?.action?.const === action);
}

test(scenarioName, async () => {
  test.setTimeout(45_000);
  const configuredProfile = process.env.AIDRAW_E2E_MCP_DISCOVERY_PROFILE;
  if (!configuredProfile) throw new Error('AIDRAW_E2E_MCP_DISCOVERY_PROFILE must name the fresh retained profile authorized for this exact run.');
  const retainedRoot = resolve(process.cwd(), 'test-results', 'retained');
  const profile = resolve(configuredProfile);
  const retainedRelative = relative(retainedRoot, profile);
  if (!retainedRelative || retainedRelative.startsWith('..') || isAbsolute(retainedRelative) || !basename(profile).startsWith(profilePrefix)) {
    throw new Error(`AIDRAW_E2E_MCP_DISCOVERY_PROFILE must be a new ${profilePrefix}* direct child of test-results/retained.`);
  }
  if (dirname(profile) !== retainedRoot) throw new Error('The MCP discovery profile must be a direct child of test-results/retained.');
  if (await access(profile).then(() => true, () => false)) throw new Error(`The immutable MCP discovery profile already exists: ${profile}`);

  const expectedExecutableHash = process.env.AIDRAW_E2E_MCP_DISCOVERY_EXE_SHA256?.toUpperCase();
  const expectedAsarHash = process.env.AIDRAW_E2E_MCP_DISCOVERY_ASAR_SHA256?.toUpperCase();
  if (!expectedExecutableHash || !expectedAsarHash) throw new Error('Exact executable and ASAR SHA-256 declarations are required.');
  const executableHash = await sha256(packagedExecutable);
  const asarHash = await sha256(packagedAsar);
  expect(executableHash).toBe(expectedExecutableHash);
  expect(asarHash).toBe(expectedAsarHash);

  await mkdir(profile, { recursive: false });
  const connectionPath = join(profile, 'mcp-connection.json');
  const evidencePath = join(profile, 'mcp-discovery-evidence.json');
  const forbiddenTargetPath = join(profile, 'artifacts', 'cold-client-never-approved.png');
  const trustSettingsPath = join(profile, 'trusted-folders.json');
  const retiredProviderStorePath = join(profile, 'credentials', 'generation.json');
  const forbiddenNetworkPath = join(profile, 'mcp-discovery-forbidden-network.json');
  const tokenPath = join(profile, 'credentials', 'mcp-token.json');
  for (const path of [connectionPath, evidencePath, forbiddenTargetPath, trustSettingsPath, retiredProviderStorePath, forbiddenNetworkPath, tokenPath]) {
    expect(await access(path).then(() => true, () => false), `${path} must be absent before launch`).toBe(false);
  }

  const child = spawnPackagedE2e(packagedExecutable, [`--user-data-dir=${profile}`, '--headless', `--write-mcp-connection=${connectionPath}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let connection: McpConnection | undefined;
  let evidence: Record<string, unknown> | undefined;
  try {
    connection = await waitForConnection(connectionPath, child);
    expect(connection.pid).toBe(child.pid);
    expect(connection.trustedFolders).toEqual([]);
    const mcpUrl = new URL(connection.url);
    expect(mcpUrl.protocol).toBe('http:');
    expect(mcpUrl.hostname).toBe('127.0.0.1');
    expect(mcpUrl.pathname).toBe('/mcp');

    const owner = await connectColdClient(connection, 'independent-tools-only-cold-client');
    const instructions = String(owner.initialize.instructions ?? '');
    expect(instructions).toContain('aidraw_help');
    expect(instructions).toContain('document_manage list');
    expect(instructions).toContain('canvas_observe');
    expect(instructions).toContain('A human alone approves');

    const listedToolsMessage = await postMcp(connection.url, owner.headers, 2, 'tools/list', {});
    const tools = (listedToolsMessage.result?.tools ?? []) as Array<{ name: string; inputSchema?: DiscoverySchema; outputSchema?: DiscoverySchema }>;
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toEqual([
      'aidraw_help', 'session_manage', 'canvas_observe', 'canvas_apply', 'history_manage',
      'document_manage', 'asset_import', 'document_export', 'job_manage',
    ]);
    expect(new Set(toolNames).size).toBe(9);
    expect(actionBranch(tools.find((tool) => tool.name === 'document_manage')?.inputSchema, 'save-as')).toMatchObject({ required: ['action', 'documentId', 'path'], additionalProperties: false });
    expect(actionBranch(tools.find((tool) => tool.name === 'job_manage')?.inputSchema, 'wait')).toMatchObject({ required: ['action', 'jobId'], additionalProperties: false });
    expect(tools.find((tool) => tool.name === 'aidraw_help')?.outputSchema?.properties?.guideUri?.const).toBe('aidraw://guide');

    const helpCall = await callTool(connection.url, owner.headers, 3, 'aidraw_help', { topic: 'quickstart' });
    expect(helpCall.message.result?.structuredContent).toEqual(helpCall.value);
    expect(helpCall.value).toMatchObject({ topic: 'quickstart', guideUri: 'aidraw://guide', relatedTools: expect.arrayContaining(['session_manage', 'document_manage', 'canvas_observe', 'canvas_apply', 'job_manage']) });
    expect(helpCall.value.steps).toEqual(expect.arrayContaining([expect.stringContaining('human must approve')]));

    const joined = (await callTool(connection.url, owner.headers, 4, 'session_manage', { action: 'join', name: 'Packaged cold discovery agent', color: '#5874c6' })).value;
    expect(joined).toMatchObject({ actor: { kind: 'agent', name: 'Packaged cold discovery agent', color: '#5874c6' }, next: { tool: 'canvas_observe' } });
    const documents = (await callTool(connection.url, owner.headers, 5, 'document_manage', { action: 'list' })).value;
    const documentId = String(documents.activeDocumentId);
    expect(documentId).toBe(connection.activeDocumentId);
    const observed = (await callTool(connection.url, owner.headers, 6, 'canvas_observe', { documentId })).value;
    expect(observed).toMatchObject({ document: { id: documentId }, revision: expect.any(Number), currentRevision: expect.any(Number) });
    const revisionBefore = Number(observed.revision);

    const appliedCall = await callTool(connection.url, owner.headers, 7, 'canvas_apply', {
      documentId,
      clientOperationId: 'packaged-cold-discovery-rename-v1',
      label: 'Packaged cold-client rename',
      operations: [{ kind: 'document.rename', name: 'Packaged discovery canvas' }],
      playback: { mode: 'instant', speed: 1 },
    });
    expect(appliedCall.message.result?.structuredContent).toEqual(appliedCall.value);
    expect(appliedCall.value).toMatchObject({ status: 'committed', revision: revisionBefore + 1, transactionId: expect.any(String) });
    const observedAfter = (await callTool(connection.url, owner.headers, 8, 'canvas_observe', { documentId })).value;
    expect(observedAfter).toMatchObject({ document: { id: documentId, name: 'Packaged discovery canvas' }, revision: revisionBefore + 1 });

    const approvalCall = await callTool(connection.url, owner.headers, 9, 'document_export', { documentId, path: forbiddenTargetPath, format: 'png', scale: 1 });
    const jobId = String(approvalCall.value.jobId);
    expect(approvalCall.message.result?.structuredContent).toEqual(approvalCall.value);
    expect(approvalCall.value).toMatchObject({ status: 'waiting-for-user', next: { tool: 'job_manage', arguments: { action: 'wait', jobId }, guidance: expect.stringContaining('Agents cannot approve') } });
    const waited = (await callTool(connection.url, owner.headers, 10, 'job_manage', { action: 'wait', jobId, timeoutMs: 0 })).value;
    expect(waited).toMatchObject({ id: jobId, status: 'waiting-for-user', dependency: { kind: 'user-approval', guidance: expect.stringContaining('cannot approve') }, next: { tool: 'job_manage' } });
    const publicJobText = JSON.stringify(waited);
    for (const privateValue of [forbiddenTargetPath, basename(forbiddenTargetPath), '"result"', '"request"', '"prompt"']) expect(publicJobText).not.toContain(privateValue);

    const outsider = await connectColdClient(connection, 'independent-job-privacy-probe');
    const outsiderJobs = (await callTool(connection.url, outsider.headers, 2, 'job_manage', { action: 'list' })).value;
    expect(outsiderJobs).toEqual({ jobs: [] });
    const outsiderInspect = (await callTool(connection.url, outsider.headers, 3, 'job_manage', { action: 'inspect', jobId })).value;
    expect(outsiderInspect).toEqual({ error: 'job_not_found' });

    expect((await callTool(connection.url, owner.headers, 11, 'job_manage', { action: 'approve-dependent', jobId })).value).toMatchObject({ id: jobId, status: 'waiting-for-user' });
    expect((await callTool(connection.url, owner.headers, 12, 'job_manage', { action: 'cancel', jobId })).value).toMatchObject({ id: jobId, status: 'cancelled' });
    expect(await access(forbiddenTargetPath).then(() => true, () => false)).toBe(false);

    const resourcesMessage = await postMcp(connection.url, owner.headers, 13, 'resources/list', {});
    const resources = (resourcesMessage.result?.resources ?? []) as Array<{ uri: string }>;
    expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: 'aidraw://guide' })]));
    const guideMessage = await postMcp(connection.url, owner.headers, 14, 'resources/read', { uri: 'aidraw://guide' });
    const guideText = String(((guideMessage.result?.contents ?? []) as Array<{ text?: string }>)[0]?.text ?? '');
    expect(guideText).toContain('Reliable cold start');
    expect(guideText).toContain('Conditional action contracts');
    expect(guideText).toContain('Only a human can approve');

    for (const sentinel of [trustSettingsPath, retiredProviderStorePath, forbiddenNetworkPath, tokenPath]) expect(await access(sentinel).then(() => true, () => false)).toBe(false);

    evidence = {
      scenario: scenarioName,
      package: {
        executable: packagedExecutable,
        executableBytes: (await stat(packagedExecutable)).size,
        executableSha256: executableHash,
        asar: packagedAsar,
        asarBytes: (await stat(packagedAsar)).size,
        asarSha256: asarHash,
      },
      launch: { mode: 'headless', connectionPidMatched: true, loopbackOnly: true, trustedFolders: [] },
      discovery: { instructionsPresent: true, toolsCount: toolNames.length, helpTopic: 'quickstart', structuredHelpMatched: true, resourcesUsedBeforeCoreWorkflow: false },
      actor: { name: 'Packaged cold discovery agent', color: '#5874c6' },
      canonical: { documentId, revisionBefore, revisionAfter: Number(observedAfter.revision), rendererRequired: false, observedRename: 'Packaged discovery canvas' },
      approval: { status: 'cancelled', humanOnlyDependencyObserved: true, nextWaitObserved: true, targetWritten: false, outsiderListEmpty: true, outsiderInspectNotFound: true },
      privacy: { pathAbsentFromPublicSummary: true, rawResultAbsent: true, rawRequestAbsent: true, promptAbsent: true, publicJobOwnerScoped: true },
      guide: { discoveredAfterCoreWorkflow: true, readAfterCoreWorkflow: true },
      nonLoopbackRequestsAttempted: 0,
      sentinelsAbsent: true,
      mcpAuthority: 'ephemeral-engine-process',
    };
  } finally {
    try { await quitGracefully(profile, child); }
    finally { if (await access(connectionPath).then(() => true, () => false)) await redactConnection(connectionPath); }
  }

  expect(child.exitCode).toBe(0);
  if (!evidence) throw new Error('Sanitized MCP discovery evidence was not completed.');
  const redactedConnection = await readFile(connectionPath, 'utf8');
  expect(redactedConnection).toContain('redacted-after-graceful-stop');
  expect(redactedConnection).not.toMatch(/"token"|Authorization|Bearer/i);
  await writeFile(evidencePath, `${JSON.stringify({ ...evidence, graceful: true, exitCode: child.exitCode, authorityStatus: 'redacted-after-graceful-stop' }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const sanitizedEvidence = await readFile(evidencePath, 'utf8');
  expect(sanitizedEvidence).not.toMatch(/"token"|Authorization|Bearer|cold-client-never-approved\.png/i);
});

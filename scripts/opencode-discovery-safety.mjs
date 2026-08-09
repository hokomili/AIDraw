import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';
import { posix, win32 } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

export const OPENCODE_DISCOVERY_RUN_PREFIX = 'aidraw-agt14-opencode-discovery-';
export const OPENCODE_DISCOVERY_LAUNCH_CONTEXT = 'unsandboxed-gui';
export const OPENCODE_DISCOVERY_OFFLINE_BOUNDARY = 'coordinator-enforced-offline';

const SAFE_INHERITED_ENVIRONMENT_KEYS = new Set([
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
]);

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function requireSha256(value, label) {
  const normalized = requireText(value, label).toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) throw new Error(`${label} must be an exact SHA-256 digest.`);
  return normalized;
}

function requireBytes(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer byte count.`);
  return value;
}

function assertStrictDescendant(path, parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a strict child of the isolated AGT-14 run root.`);
  }
}

function assertLoopbackMcpConnection(connection) {
  if (!connection || typeof connection !== 'object') throw new Error('The AIDraw MCP connection is required.');
  const url = new URL(requireText(connection.url, 'The AIDraw MCP URL'));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp') {
    throw new Error('The AIDraw MCP URL must be the exact loopback Streamable HTTP /mcp endpoint.');
  }
  const token = requireText(connection.token, 'The AIDraw MCP bearer token');
  return { url: url.toString(), token };
}

export function buildOpenCodeDiscoveryPlan(input, platform = process.platform) {
  const path = pathApi(platform);
  const workspacePath = path.resolve(requireText(input.workspacePath, 'workspacePath'));
  const retainedRoot = path.join(workspacePath, 'test-results', 'retained');
  const runRoot = path.resolve(requireText(input.runRoot, 'runRoot'));
  const runRelative = path.relative(retainedRoot, runRoot);
  if (!runRelative || runRelative.startsWith('..') || path.isAbsolute(runRelative) || runRelative.includes(path.sep)
    || !path.basename(runRoot).toLowerCase().startsWith(OPENCODE_DISCOVERY_RUN_PREFIX)) {
    throw new Error(`runRoot must be a fresh ${OPENCODE_DISCOVERY_RUN_PREFIX}* direct child of test-results/retained.`);
  }

  const aidrawProfile = path.join(runRoot, 'aidraw-profile');
  const connectionPath = path.join(aidrawProfile, 'mcp-connection.json');
  const configRoot = path.join(aidrawProfile, 'opencode-xdg');
  const configPath = path.join(configRoot, 'opencode', 'opencode.jsonc');
  const clientHome = path.join(runRoot, 'opencode-home');
  const clientRoamingAppData = path.join(clientHome, 'AppData', 'Roaming');
  const clientLocalAppData = path.join(clientHome, 'AppData', 'Local');
  const clientUserData = path.join(runRoot, 'opencode-user-data');
  const clientTemp = path.join(runRoot, 'opencode-temp');
  const outputRoot = path.join(runRoot, 'client-output');
  const manifestPath = path.join(runRoot, 'opencode-discovery-manifest.json');
  const clientProcessPath = path.join(runRoot, 'opencode-client-process.json');
  const evidencePath = path.join(runRoot, 'opencode-discovery-evidence.json');
  const cleanupAuditPath = path.join(runRoot, 'opencode-discovery-cleanup.json');
  const screenshotPath = path.join(outputRoot, 'opencode-aidraw-discovery.png');
  const forbiddenNetworkSentinel = path.join(runRoot, 'forbidden-external-network.json');
  const providerCredentialSentinel = path.join(runRoot, 'provider-credential-access.json');

  for (const [label, candidate] of Object.entries({
    aidrawProfile,
    connectionPath,
    configRoot,
    configPath,
    clientHome,
    clientRoamingAppData,
    clientLocalAppData,
    clientUserData,
    clientTemp,
    outputRoot,
    manifestPath,
    clientProcessPath,
    evidencePath,
    cleanupAuditPath,
    screenshotPath,
    forbiddenNetworkSentinel,
    providerCredentialSentinel,
  })) assertStrictDescendant(path, runRoot, candidate, label);

  return {
    version: 1,
    kind: 'aidraw-opencode-installed-discovery',
    workspacePath,
    runRoot,
    aidraw: {
      executable: path.resolve(requireText(input.aidrawExecutable, 'aidrawExecutable')),
      executableBytes: requireBytes(input.aidrawExecutableBytes, 'aidrawExecutableBytes'),
      executableSha256: requireSha256(input.aidrawExecutableSha256, 'aidrawExecutableSha256'),
      asar: path.resolve(requireText(input.aidrawAsar, 'aidrawAsar')),
      asarBytes: requireBytes(input.aidrawAsarBytes, 'aidrawAsarBytes'),
      asarSha256: requireSha256(input.aidrawAsarSha256, 'aidrawAsarSha256'),
      profile: aidrawProfile,
      connectionPath,
    },
    client: {
      id: 'opencode',
      productVersion: requireText(input.clientProductVersion, 'clientProductVersion'),
      executable: path.resolve(requireText(input.clientExecutable, 'clientExecutable')),
      executableBytes: requireBytes(input.clientExecutableBytes, 'clientExecutableBytes'),
      executableSha256: requireSha256(input.clientExecutableSha256, 'clientExecutableSha256'),
      configRoot,
      configPath,
      home: clientHome,
      roamingAppData: clientRoamingAppData,
      localAppData: clientLocalAppData,
      userData: clientUserData,
      temp: clientTemp,
      arguments: [
        `--user-data-dir=${clientUserData}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    },
    outputRoot,
    manifestPath,
    clientProcessPath,
    evidencePath,
    cleanupAuditPath,
    screenshotPath,
    sentinels: {
      forbiddenNetwork: forbiddenNetworkSentinel,
      providerCredentialAccess: providerCredentialSentinel,
    },
    networkBoundary: {
      requiresIndependentOfflineEnforcement: true,
      note: 'Electron flags and proxy variables are defense in depth only; the coordinator must independently prevent external egress for the installed-client run.',
    },
  };
}

export function assertOpenCodeDiscoveryLaunchBoundary(declarations, platform = process.platform) {
  if (platform === 'win32' && declarations?.launchContext !== OPENCODE_DISCOVERY_LAUNCH_CONTEXT) {
    throw new Error('Refusing to launch installed OpenCode from an unacknowledged Windows execution boundary.');
  }
  if (declarations?.offlineBoundary !== OPENCODE_DISCOVERY_OFFLINE_BOUNDARY) {
    throw new Error('Refusing to launch installed OpenCode without an independently enforced offline boundary.');
  }
  return {
    launchContext: platform === 'win32' ? OPENCODE_DISCOVERY_LAUNCH_CONTEXT : 'not-required',
    offlineBoundary: OPENCODE_DISCOVERY_OFFLINE_BOUNDARY,
  };
}

export function buildOpenCodeChildEnvironment(baseEnvironment, plan) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (SAFE_INHERITED_ENVIRONMENT_KEYS.has(key.toUpperCase()) && typeof value === 'string') environment[key] = value;
  }
  Object.assign(environment, {
    USERPROFILE: plan.client.home,
    APPDATA: plan.client.roamingAppData,
    LOCALAPPDATA: plan.client.localAppData,
    XDG_CONFIG_HOME: plan.client.configRoot,
    TEMP: plan.client.temp,
    TMP: plan.client.temp,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
  });
  return environment;
}

export function buildOpenCodeConfig(connection) {
  const validated = assertLoopbackMcpConnection(connection);
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      aidraw: {
        type: 'remote',
        url: validated.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${validated.token}` },
      },
    },
  }, null, 2)}\n`;
}

function parseConfig(text, configPath = 'opencode.jsonc') {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`${configPath} contains invalid JSON/JSONC (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}).`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${configPath} must contain a JSON object.`);
  return value;
}

export function inspectOpenCodeConfig(text, expectedUrl) {
  const value = parseConfig(text);
  const mcp = value.mcp && typeof value.mcp === 'object' && !Array.isArray(value.mcp) ? value.mcp : {};
  const aidraw = mcp.aidraw && typeof mcp.aidraw === 'object' && !Array.isArray(mcp.aidraw) ? mcp.aidraw : {};
  const headers = aidraw.headers && typeof aidraw.headers === 'object' && !Array.isArray(aidraw.headers) ? aidraw.headers : {};
  const authorization = headers.Authorization;
  const authorizationState = typeof authorization !== 'string'
    ? 'missing'
    : authorization === 'redacted-after-graceful-stop'
      ? 'redacted'
      : authorization.startsWith('Bearer ') && authorization.length > 7
        ? 'bearer'
        : 'invalid';
  return {
    schema: value.$schema,
    configured: aidraw.type === 'remote' && aidraw.enabled === true && aidraw.oauth === false,
    urlMatches: typeof expectedUrl === 'string' ? aidraw.url === new URL(expectedUrl).toString() : undefined,
    authorizationState,
    obsoleteWrapperAbsent: !Object.hasOwn(mcp, 'servers'),
  };
}

export function redactOpenCodeConfig(text) {
  const summary = inspectOpenCodeConfig(text);
  if (summary.authorizationState !== 'bearer' && summary.authorizationState !== 'redacted') {
    throw new Error('The isolated OpenCode configuration does not contain a redactable AIDraw authorization header.');
  }
  if (summary.authorizationState === 'redacted') return text;
  const source = text.trim() ? text : '{}\n';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const updated = applyEdits(source, modify(source, ['mcp', 'aidraw', 'headers', 'Authorization'], 'redacted-after-graceful-stop', {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  }));
  return updated.endsWith(eol) ? updated : `${updated}${eol}`;
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const HELP = `AIDraw isolated QA session

Usage:
  node scripts/qa-session.mjs start --exe <AIDraw.exe> --profile <dir> --connection <json> --launch-context unsandboxed-gui [--manifest <json>] [--mode interactive|headless] [--trust-folder <dir> ...]
  node scripts/qa-session.mjs show --manifest <json>
  node scripts/qa-session.mjs status --manifest <json>
  node scripts/qa-session.mjs stop --manifest <json>
  node scripts/qa-session.mjs redact --manifest <json>

Interactive mode is the formal UI-test default and opens the editor immediately.
Headless mode is used for explicit lifecycle scenarios; use show to request its
editor window after the MCP QA document has a unique name.
On Windows, start/show/stop must be invoked outside a Codex filesystem sandbox.
The launch-context acknowledgement prevents accidental sandboxed GUI startup.
Session files contain local bearer credentials and must stay below ignored
test-results/.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return { command, values };
}

function required(values, key) {
  const value = values.get(key)?.at(-1);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function optional(values, key) {
  return values.get(key)?.at(-1);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit) => {
    const timeout = globalThis.setTimeout(() => resolveExit(undefined), timeoutMs);
    child.once('exit', (code) => {
      globalThis.clearTimeout(timeout);
      resolveExit(code ?? 0);
    });
  });
}

async function health(url) {
  const healthUrl = new globalThis.URL(url);
  healthUrl.pathname = '/health';
  healthUrl.search = '';
  const response = await globalThis.fetch(healthUrl, { signal: globalThis.AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`Health endpoint returned ${response.status}.`);
  return { url: healthUrl.toString(), body: await response.json().catch(() => ({})) };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForConnection(connectionPath, expectedPid, startedAt) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const fileInfo = await stat(connectionPath);
      if (fileInfo.mtimeMs + 1_000 < startedAt) throw new Error('Connection file is stale.');
      const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
      if (!connection.url || !connection.token || !connection.pid) throw new Error('Connection file is incomplete.');
      if (Number(connection.pid) !== expectedPid) throw new Error(`Connection PID ${connection.pid} does not match launched PID ${expectedPid}.`);
      const healthResult = await health(connection.url);
      return { connection, health: healthResult };
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 150));
    }
  }
  throw new Error(`AIDraw QA engine did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function loadManifest(values) {
  const manifestPath = resolve(required(values, 'manifest'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !manifest.exe || !manifest.profile || !manifest.connection || !manifest.pid) {
    throw new Error(`Invalid QA session manifest: ${manifestPath}`);
  }
  return { manifestPath, manifest };
}

async function redactConnection(manifest) {
  if (isProcessAlive(Number(manifest.pid))) throw new Error(`Refusing to redact connection credentials while QA PID ${manifest.pid} is still alive.`);
  const connection = JSON.parse(await readFile(manifest.connection, 'utf8'));
  const redacted = {
    version: connection.version ?? 1,
    url: connection.url ?? manifest.mcpUrl,
    activeDocumentId: connection.activeDocumentId,
    pid: connection.pid ?? manifest.pid,
    trustedFolders: connection.trustedFolders ?? manifest.trustedFolders ?? [],
    stoppedAt: new Date().toISOString(),
    credentialsRedacted: true,
  };
  await writeFile(manifest.connection, `${JSON.stringify(redacted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return redacted;
}

async function start(values) {
  const exe = resolve(required(values, 'exe'));
  const profile = resolve(required(values, 'profile'));
  const connection = resolve(required(values, 'connection'));
  const manifestPath = resolve(optional(values, 'manifest') ?? join(profile, 'qa-session.json'));
  const mode = optional(values, 'mode') ?? 'interactive';
  const launchContext = optional(values, 'launch-context');
  if (process.platform === 'win32' && launchContext !== 'unsandboxed-gui') {
    throw new Error('Refusing to launch native AIDraw from an unknown Windows context. Invoke this command with shell sandbox escalation and --launch-context unsandboxed-gui.');
  }
  if (!['interactive', 'headless'].includes(mode)) throw new Error('--mode must be interactive or headless.');
  const trustedFolders = (values.get('trust-folder') ?? []).map((folder) => resolve(folder));
  if (mode !== 'headless' && trustedFolders.length > 0) throw new Error('--trust-folder is available only with --mode headless.');
  await access(exe);
  await mkdir(profile, { recursive: true });
  await mkdir(dirname(connection), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  for (const folder of trustedFolders) await mkdir(folder, { recursive: true });

  const startedAtMs = Date.now();
  const args = [
    `--user-data-dir=${profile}`,
    ...(mode === 'headless' ? ['--headless'] : []),
    `--write-mcp-connection=${connection}`,
    ...trustedFolders.map((folder) => `--trust-folder=${folder}`),
  ];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  if (!child.pid) throw new Error('AIDraw did not return a process ID.');

  const ready = await waitForConnection(connection, child.pid, startedAtMs);
  const manifest = {
    version: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    exe,
    exeSha256: await sha256(exe),
    profile,
    connection,
    mode,
    launchContext,
    pid: child.pid,
    mcpUrl: ready.connection.url,
    healthUrl: ready.health.url,
    trustedFolders,
    windowRequested: mode === 'interactive',
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
}

async function show(values) {
  const { manifestPath, manifest } = await loadManifest(values);
  const connection = JSON.parse(await readFile(manifest.connection, 'utf8'));
  if (Number(connection.pid) !== Number(manifest.pid) || connection.url !== manifest.mcpUrl) {
    throw new Error('Refusing to show an editor because the session connection identity changed.');
  }
  await health(manifest.mcpUrl);
  const child = spawn(manifest.exe, [`--user-data-dir=${manifest.profile}`], {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });
  const exitCode = await waitForExit(child);
  if (exitCode === undefined) throw new Error('The editor attach signal did not return within 10 seconds.');
  if (exitCode !== 0) throw new Error(`The editor attach signal exited with code ${exitCode}.`);
  const updated = { ...manifest, windowRequested: true, windowRequestedAt: new Date().toISOString() };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifestPath, pid: manifest.pid, mcpUrl: manifest.mcpUrl, windowRequested: true }, null, 2)}\n`);
}

async function status(values) {
  const { manifestPath, manifest } = await loadManifest(values);
  const currentHash = await sha256(manifest.exe);
  const connection = JSON.parse(await readFile(manifest.connection, 'utf8'));
  let healthResult;
  let healthError;
  try { healthResult = await health(manifest.mcpUrl); } catch (error) { healthError = error instanceof Error ? error.message : String(error); }
  const result = {
    manifestPath,
    exe: manifest.exe,
    expectedSha256: manifest.exeSha256,
    currentSha256: currentHash,
    hashMatches: currentHash === manifest.exeSha256,
    pid: manifest.pid,
    processAlive: isProcessAlive(Number(manifest.pid)),
    connectionPid: connection.pid,
    pidMatches: Number(connection.pid) === Number(manifest.pid),
    mcpUrl: manifest.mcpUrl,
    connectionUrl: connection.url,
    urlMatches: connection.url === manifest.mcpUrl,
    health: healthResult ?? { error: healthError },
    profile: manifest.profile,
    mode: manifest.mode ?? 'headless',
    windowRequested: Boolean(manifest.windowRequested),
  };
  const okay = result.hashMatches && result.processAlive && result.pidMatches && result.urlMatches && Boolean(healthResult);
  process.stdout.write(`${JSON.stringify({ okay, ...result }, null, 2)}\n`);
  if (!okay) process.exitCode = 1;
}

async function stop(values) {
  const { manifestPath, manifest } = await loadManifest(values);
  const child = spawn(manifest.exe, [`--user-data-dir=${manifest.profile}`, '--quit-engine'], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  const signalExitCode = await waitForExit(child);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isProcessAlive(Number(manifest.pid))) {
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 150));
  }
  const stopped = !isProcessAlive(Number(manifest.pid));
  const redactedConnection = stopped ? await redactConnection(manifest) : undefined;
  const updated = { ...manifest, stoppedAt: new Date().toISOString(), stopped, connectionCredentialsRedacted: Boolean(redactedConnection) };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifestPath, signalExitCode, stopped, pid: manifest.pid, connectionCredentialsRedacted: Boolean(redactedConnection) }, null, 2)}\n`);
  if (!stopped) process.exitCode = 1;
}

async function redact(values) {
  const { manifestPath, manifest } = await loadManifest(values);
  await redactConnection(manifest);
  const updated = { ...manifest, connectionCredentialsRedacted: true };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifestPath, pid: manifest.pid, connectionCredentialsRedacted: true }, null, 2)}\n`);
}

const { command, values } = parseArguments(process.argv.slice(2));
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (command === 'start') {
  await start(values);
} else if (command === 'show') {
  await show(values);
} else if (command === 'status') {
  await status(values);
} else if (command === 'stop') {
  await stop(values);
} else if (command === 'redact') {
  await redact(values);
} else {
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

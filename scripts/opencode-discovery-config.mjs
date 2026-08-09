import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildOpenCodeChildEnvironment,
  buildOpenCodeConfig,
  buildOpenCodeDiscoveryPlan,
  assertOpenCodeDiscoveryLaunchBoundary,
  inspectOpenCodeConfig,
  redactOpenCodeConfig,
} from './opencode-discovery-safety.mjs';

const HELP = `AIDraw isolated OpenCode discovery configuration

Usage:
  node scripts/opencode-discovery-config.mjs prepare <exact plan arguments>
  node scripts/opencode-discovery-config.mjs launch --manifest <json> --launch-context unsandboxed-gui --offline-boundary coordinator-enforced-offline
  node scripts/opencode-discovery-config.mjs redact --manifest <json>

prepare never launches either product: it reads one isolated AIDraw connection,
verifies both executable identities, writes only the derived disposable OpenCode
JSONC path, and emits a secret-free manifest. launch is separately guarded and
starts only the exact installed client with the manifest's isolated environment;
it never stops or force-terminates the client. A normal client exit triggers
credential redaction. redact is the recovery command after separately proving both
exact processes have exited.
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
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return { command, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function requiredBytes(values, key) {
  const value = Number(required(values, key));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer byte count.`);
  return value;
}

function planInput(values) {
  return {
    workspacePath: required(values, 'workspace'),
    runRoot: required(values, 'run-root'),
    aidrawExecutable: required(values, 'aidraw-exe'),
    aidrawExecutableBytes: requiredBytes(values, 'aidraw-exe-bytes'),
    aidrawExecutableSha256: required(values, 'aidraw-exe-sha256'),
    aidrawAsar: required(values, 'aidraw-asar'),
    aidrawAsarBytes: requiredBytes(values, 'aidraw-asar-bytes'),
    aidrawAsarSha256: required(values, 'aidraw-asar-sha256'),
    clientProductVersion: required(values, 'client-version'),
    clientExecutable: required(values, 'client-exe'),
    clientExecutableBytes: requiredBytes(values, 'client-exe-bytes'),
    clientExecutableSha256: required(values, 'client-exe-sha256'),
  };
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function assertFileIdentity(path, expectedBytes, expectedSha256, label) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expectedBytes) throw new Error(`${label} byte identity mismatch.`);
  if (await sha256(path) !== expectedSha256) throw new Error(`${label} SHA-256 identity mismatch.`);
}

async function atomicWrite(path, contents) {
  const temporaryPath = `${path}.aidraw-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function prepareIsolatedOpenCodeDiscovery(input, now = new Date()) {
  const plan = buildOpenCodeDiscoveryPlan(input);
  await assertFileIdentity(plan.aidraw.executable, plan.aidraw.executableBytes, plan.aidraw.executableSha256, 'AIDraw executable');
  await assertFileIdentity(plan.aidraw.asar, plan.aidraw.asarBytes, plan.aidraw.asarSha256, 'AIDraw ASAR');
  await assertFileIdentity(plan.client.executable, plan.client.executableBytes, plan.client.executableSha256, 'OpenCode executable');
  if (!await exists(plan.aidraw.connectionPath)) throw new Error('The exact isolated AIDraw connection does not exist.');
  for (const path of [
    plan.client.configPath,
    plan.client.home,
    plan.client.userData,
    plan.client.temp,
    plan.outputRoot,
    plan.manifestPath,
    plan.clientProcessPath,
    plan.evidencePath,
    plan.cleanupAuditPath,
    plan.screenshotPath,
    ...Object.values(plan.sentinels),
  ]) if (await exists(path)) throw new Error(`The fresh OpenCode discovery path already exists: ${path}`);

  const connection = JSON.parse(await readFile(plan.aidraw.connectionPath, 'utf8'));
  const config = buildOpenCodeConfig(connection);
  const configSummary = inspectOpenCodeConfig(config, connection.url);
  const childEnvironment = buildOpenCodeChildEnvironment(process.env, plan);
  const manifest = {
    ...plan,
    preparedAt: now.toISOString(),
    clientEnvironment: childEnvironment,
    configSummary,
    credentialStatus: 'live-in-isolated-config',
  };
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serializedManifest.includes(connection.token) || serializedManifest.includes(`Bearer ${connection.token}`)) {
    throw new Error('Refusing to write an OpenCode discovery manifest containing the MCP bearer credential.');
  }

  await mkdir(dirname(plan.client.configPath), { recursive: true });
  for (const path of [plan.client.home, plan.client.roamingAppData, plan.client.localAppData, plan.client.userData, plan.client.temp, plan.outputRoot]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(plan.client.configPath, config, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await writeFile(plan.manifestPath, serializedManifest, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    await atomicWrite(plan.client.configPath, redactOpenCodeConfig(config));
    throw error;
  }
  return manifest;
}

export async function redactIsolatedOpenCodeDiscovery(manifestPath, now = new Date()) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.kind !== 'aidraw-opencode-installed-discovery' || !manifest.client?.configPath || !manifest.cleanupAuditPath) {
    throw new Error('Invalid isolated OpenCode discovery manifest.');
  }
  const config = await readFile(manifest.client.configPath, 'utf8');
  const redacted = redactOpenCodeConfig(config);
  await atomicWrite(manifest.client.configPath, redacted);
  const summary = inspectOpenCodeConfig(redacted);
  const cleanup = {
    version: 1,
    kind: manifest.kind,
    redactedAt: now.toISOString(),
    configPath: manifest.client.configPath,
    authorizationState: summary.authorizationState,
    credentialStatus: 'redacted-after-graceful-stop',
  };
  await writeFile(manifest.cleanupAuditPath, `${JSON.stringify(cleanup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return cleanup;
}

export async function launchIsolatedOpenCodeDiscovery(manifestPath, declarations, now = new Date()) {
  const boundary = assertOpenCodeDiscoveryLaunchBoundary(declarations);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.kind !== 'aidraw-opencode-installed-discovery' || !manifest.client?.executable || !manifest.clientProcessPath) {
    throw new Error('Invalid isolated OpenCode discovery manifest.');
  }
  if (await exists(manifest.clientProcessPath)) throw new Error('The immutable OpenCode process record already exists.');
  await assertFileIdentity(manifest.client.executable, manifest.client.executableBytes, manifest.client.executableSha256, 'OpenCode executable');
  const config = await readFile(manifest.client.configPath, 'utf8');
  if (inspectOpenCodeConfig(config).authorizationState !== 'bearer') throw new Error('The isolated OpenCode configuration is not live for discovery.');

  let child;
  try {
    child = spawn(manifest.client.executable, manifest.client.arguments, {
      env: manifest.clientEnvironment,
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    });
  } catch (error) {
    await redactIsolatedOpenCodeDiscovery(manifestPath, now);
    throw error;
  }
  if (!child.pid) {
    await redactIsolatedOpenCodeDiscovery(manifestPath, now);
    throw new Error('Installed OpenCode did not return a process ID.');
  }
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 0));
  });
  const processRecord = {
    version: 1,
    kind: manifest.kind,
    startedAt: now.toISOString(),
    pid: child.pid,
    executable: manifest.client.executable,
    executableBytes: manifest.client.executableBytes,
    executableSha256: manifest.client.executableSha256,
    arguments: manifest.client.arguments,
    configRoot: manifest.client.configRoot,
    userData: manifest.client.userData,
    ...boundary,
  };
  let recordError;
  try {
    await writeFile(manifest.clientProcessPath, `${JSON.stringify(processRecord, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    recordError = error;
  }
  let exitCode;
  try {
    exitCode = await exitPromise;
  } catch (error) {
    await redactIsolatedOpenCodeDiscovery(manifestPath);
    throw error;
  }
  const cleanup = await redactIsolatedOpenCodeDiscovery(manifestPath);
  if (recordError) throw recordError;
  await atomicWrite(manifest.clientProcessPath, `${JSON.stringify({ ...processRecord, exitedAt: new Date().toISOString(), exitCode, credentialStatus: cleanup.credentialStatus }, null, 2)}\n`);
  return { ...processRecord, exitCode, cleanup };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'prepare') {
    const manifest = await prepareIsolatedOpenCodeDiscovery(planInput(values));
    process.stdout.write(`${JSON.stringify({ manifestPath: manifest.manifestPath, runRoot: manifest.runRoot, client: manifest.client, credentialStatus: manifest.credentialStatus }, null, 2)}\n`);
    return;
  }
  if (command === 'redact') {
    const cleanup = await redactIsolatedOpenCodeDiscovery(required(values, 'manifest'));
    process.stdout.write(`${JSON.stringify(cleanup, null, 2)}\n`);
    return;
  }
  if (command === 'launch') {
    const result = await launchIsolatedOpenCodeDiscovery(required(values, 'manifest'), {
      launchContext: required(values, 'launch-context'),
      offlineBoundary: required(values, 'offline-boundary'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

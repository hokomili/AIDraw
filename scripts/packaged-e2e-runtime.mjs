import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export const PACKAGED_E2E_SUITE_ENV = 'AIDRAW_E2E_SUITE';
export const PACKAGED_E2E_RETAINED_TITLE_PATTERN = /(?:MCP-COLD-DISCOVERY|FND-02-PACKAGED-SECURITY|FND-09-)/;
export const PACKAGED_E2E_SELF_CONTAINED_CASES = 27;
export const PACKAGED_E2E_RETAINED_CASES = 10;

export const PACKAGED_E2E_RETAINED_PROFILE_ENVS = Object.freeze([
  'AIDRAW_E2E_MCP_DISCOVERY_PROFILE',
  'AIDRAW_E2E_FND02_SECURITY_PROFILE',
  'AIDRAW_E2E_FND09_UTILITY_PROFILE',
  'AIDRAW_E2E_FND09_PRESSURE_PROFILE',
  'AIDRAW_E2E_FND09_OBSERVATION_CODEC_PROFILE',
  'AIDRAW_E2E_FND09_QUANTIZATION_RESULT_PROFILE',
  'AIDRAW_E2E_FND09_EXPORT_RESULT_PROFILE',
  'AIDRAW_E2E_FND09_IMPORT_RESULT_PROFILE',
  'AIDRAW_E2E_FND09_GENERATION_RESULT_PROFILE',
  'AIDRAW_E2E_FND09_NORMALIZATION_PROFILE',
]);

const RETAINED_TITLE_MARKERS = Object.freeze([
  'MCP-COLD-DISCOVERY',
  'FND-02-PACKAGED-SECURITY',
  'FND-09-',
]);

function nonEmpty(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function normalizeArch(arch) {
  if (arch === 'arm') return 'armv7l';
  return arch;
}

export function resolvePackagedE2eArtifact({
  workspacePath = process.cwd(),
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const workspace = resolve(workspacePath);
  const targetArch = normalizeArch(nonEmpty(environment.AIDRAW_E2E_ARCH) ?? arch);
  const outRoot = resolve(workspace, nonEmpty(environment.AIDRAW_E2E_OUT_DIR) ?? 'out');
  const explicitExecutable = nonEmpty(environment.AIDRAW_E2E_EXECUTABLE);
  let executable;

  if (explicitExecutable) {
    executable = resolve(workspace, explicitExecutable);
    if (platform === 'darwin' && executable.endsWith('.app')) {
      executable = join(executable, 'Contents', 'MacOS', 'AIDraw');
    }
  } else if (platform === 'win32') {
    executable = join(outRoot, `AIDraw-win32-${targetArch}`, 'AIDraw.exe');
  } else if (platform === 'darwin') {
    executable = join(outRoot, `AIDraw-darwin-${targetArch}`, 'AIDraw.app', 'Contents', 'MacOS', 'AIDraw');
  } else if (platform === 'linux') {
    executable = join(outRoot, `AIDraw-linux-${targetArch}`, 'AIDraw');
  } else {
    throw new Error(`Packaged Level 2 automation does not define an AIDraw executable layout for ${platform}/${targetArch}.`);
  }

  const explicitAsar = nonEmpty(environment.AIDRAW_E2E_ASAR);
  const asar = explicitAsar
    ? resolve(workspace, explicitAsar)
    : platform === 'darwin'
      ? resolve(dirname(executable), '..', 'Resources', 'app.asar')
      : join(dirname(executable), 'resources', 'app.asar');

  return { workspace, outRoot, platform, arch: targetArch, executable, asar };
}

export function assertPackagedE2eArtifact(artifact) {
  for (const [label, path] of [['executable', artifact.executable], ['ASAR', artifact.asar]]) {
    let metadata;
    try { metadata = statSync(path); }
    catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      throw new Error(`The packaged AIDraw ${label} for ${artifact.platform}/${artifact.arch} is missing: ${path}.${detail}`);
    }
    if (!metadata.isFile()) throw new Error(`The packaged AIDraw ${label} is not a file: ${path}.`);
  }
  if (artifact.platform !== 'win32') {
    try { accessSync(artifact.executable, constants.X_OK); }
    catch { throw new Error(`The packaged AIDraw executable is not executable: ${artifact.executable}.`); }
  }
  return artifact;
}

function requestedRetainedTitle(argv) {
  const selectorText = argv.join(' ');
  return RETAINED_TITLE_MARKERS.some((marker) => selectorText.includes(marker));
}

export function resolvePackagedE2eSelection(environment = process.env, argv = process.argv.slice(2)) {
  const requested = nonEmpty(environment[PACKAGED_E2E_SUITE_ENV])?.toLowerCase();
  if (requested && !['self-contained', 'retained', 'all'].includes(requested)) {
    throw new Error(`${PACKAGED_E2E_SUITE_ENV} must be self-contained, retained, or all; received ${JSON.stringify(requested)}.`);
  }

  const configuredRetainedProfiles = PACKAGED_E2E_RETAINED_PROFILE_ENVS.filter((name) => nonEmpty(environment[name]));
  const retainedSelector = requestedRetainedTitle(argv);
  if (requested === 'self-contained' && (configuredRetainedProfiles.length || retainedSelector)) {
    throw new Error('The self-contained Level 2 suite cannot be combined with retained-profile configuration or a retained-checkpoint selector.');
  }

  const suite = requested ?? (configuredRetainedProfiles.length || retainedSelector ? 'retained' : 'self-contained');
  return {
    suite,
    configuredRetainedProfiles,
    grep: suite === 'retained' ? new RegExp(PACKAGED_E2E_RETAINED_TITLE_PATTERN) : undefined,
    grepInvert: suite === 'self-contained' ? new RegExp(PACKAGED_E2E_RETAINED_TITLE_PATTERN) : undefined,
  };
}

export function packagedE2eSpawnOptions(options = {}, platform = process.platform) {
  return {
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: platform === 'win32',
  };
}

export function spawnPackagedE2e(executable, args, options = {}, platform = process.platform) {
  return spawn(executable, args, packagedE2eSpawnOptions(options, platform));
}

function isWithin(parent, candidate) {
  const nested = relative(parent, candidate);
  return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested);
}

export function assertPackagedE2eProfile(profilePath, workspacePath = process.cwd()) {
  const profile = resolve(profilePath);
  if (!basename(profile).startsWith('aidraw-e2e-')) {
    throw new Error(`Packaged Level 2 profiles must use an aidraw-e2e-* leaf name: ${profile}.`);
  }
  const allowedRoots = [resolve(workspacePath, 'test-results'), resolve(tmpdir())];
  if (!allowedRoots.some((root) => isWithin(root, profile))) {
    throw new Error(`Refusing a packaged Level 2 profile outside test-results or the system temporary root: ${profile}.`);
  }
  return profile;
}

export async function createPackagedE2eProfile(workspacePath = process.cwd(), label = 'case') {
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
  const root = resolve(workspacePath, 'test-results', 'playwright-profiles');
  await mkdir(root, { recursive: true });
  return assertPackagedE2eProfile(await mkdtemp(join(root, `aidraw-e2e-${safeLabel}-`)), workspacePath);
}

export async function canonicalPackagedE2ePath(path, platform = process.platform) {
  const canonical = await realpath(resolve(path)).catch(() => resolve(path));
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function packagedE2ePrimaryShortcut(key, platform = process.platform) {
  return `${packagedE2ePrimaryModifier(platform)}+${key}`;
}

export function packagedE2ePrimaryModifier(platform = process.platform) {
  return platform === 'darwin' ? 'Meta' : 'Control';
}

export async function waitForPackagedE2eReady({
  child,
  attempt,
  label,
  stderr = () => '',
  timeoutMs = process.platform === 'darwin' ? 30_000 : 15_000,
  intervalMs = 100,
}) {
  let spawnError;
  const onError = (error) => { spawnError = error; };
  child.once('error', onError);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`${label} could not spawn the packaged app: ${spawnError.message}`);
      const value = await attempt();
      if (value !== undefined && value !== null && value !== false) return value;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${label} stopped because the packaged app exited with code ${String(child.exitCode)} and signal ${String(child.signalCode)}.`);
      }
      await delay(intervalMs);
    }
    const diagnostic = String(stderr()).trim();
    throw new Error(`${label} did not become ready within ${timeoutMs} ms.${diagnostic ? `\n${diagnostic}` : ''}`);
  } finally {
    child.removeListener('error', onError);
  }
}

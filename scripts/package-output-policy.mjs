import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const PACKAGE_GENERATION_MARKER = '.aidraw-package-generation.json';
export const PACKAGE_GENERATION_POLICY = 'exclusive-output-root-v1';

const supportedPlatforms = new Set(['darwin', 'linux', 'win32']);
const supportedArchitectures = new Set(['arm64', 'x64']);

function slash(path) {
  return path.replaceAll('\\', '/');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

function isContained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function selectedOutput(options) {
  const environment = options.environment ?? process.env;
  const configured = options.outputDirectory ?? environment.AIDRAW_FORGE_OUT_DIR;
  if (configured !== undefined && (typeof configured !== 'string' || configured.trim() === '')) {
    throw new Error('AIDRAW_FORGE_OUT_DIR must name a nonempty package-generation root.');
  }
  return configured ?? 'out';
}

export function resolvePackageOutputRoot(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const selectedDirectory = resolve(workspace, selectedOutput(options));
  let workspaceRealPath;
  let parentInfo;
  let parentRealPath;
  try {
    workspaceRealPath = realpathSync(workspace);
    parentInfo = lstatSync(dirname(selectedDirectory));
    parentRealPath = realpathSync(dirname(selectedDirectory));
  } catch (error) {
    throw new Error('Package-generation output must have an existing directory parent inside the AIDraw workspace.', { cause: error });
  }
  const outputDirectory = resolve(parentRealPath, basename(selectedDirectory));
  if (outputDirectory === workspaceRealPath
    || !parentInfo.isDirectory()
    || parentInfo.isSymbolicLink()
    || !isContained(workspaceRealPath, parentRealPath)) {
    throw new Error('AIDraw package-generation roots must be strict children of the workspace.');
  }
  return outputDirectory;
}

async function inspectPackageOutputContext(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const outputDirectory = resolvePackageOutputRoot({ ...options, workspace });
  const outputParent = dirname(outputDirectory);
  const [packageSource, workspaceRealPath, parentInfo, parentRealPath] = await Promise.all([
    readFile(resolve(workspace, 'package.json'), 'utf8'),
    realpath(workspace),
    lstat(outputParent),
    realpath(outputParent),
  ]);
  const packageMetadata = JSON.parse(packageSource);
  if (packageMetadata.name !== 'aidraw' || typeof packageMetadata.version !== 'string' || !packageMetadata.version) {
    throw new Error('Package generation must run from the AIDraw workspace.');
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !isContained(workspaceRealPath, parentRealPath)) {
    throw new Error('Package-generation output must have a real directory parent inside the AIDraw workspace.');
  }
  return {
    workspace: workspaceRealPath,
    outputDirectory,
    relativeOutputDirectory: slash(relative(workspaceRealPath, outputDirectory)),
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version,
  };
}

async function outputExists(outputDirectory) {
  try {
    await lstat(outputDirectory);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function existingGenerationError(relativeOutputDirectory) {
  return new Error(
    `Refusing to replace package-generation root ${relativeOutputDirectory}: `
      + 'AIDraw package roots are single-use. Select a fresh AIDRAW_FORGE_OUT_DIR.',
  );
}

export async function assertPackageOutputAvailable(options = {}) {
  const context = await inspectPackageOutputContext(options);
  if (await outputExists(context.outputDirectory)) {
    throw existingGenerationError(context.relativeOutputDirectory);
  }
  return context;
}

function assertTarget(platform, architecture) {
  if (!supportedPlatforms.has(platform)) throw new Error(`Unsupported AIDraw package platform ${JSON.stringify(platform)}.`);
  if (!supportedArchitectures.has(architecture)) throw new Error(`Unsupported AIDraw package architecture ${JSON.stringify(architecture)}.`);
}

function expectedGeneration(context, platform, architecture) {
  return {
    schemaVersion: 1,
    policy: PACKAGE_GENERATION_POLICY,
    package: { name: context.packageName, version: context.packageVersion },
    target: { platform, architecture },
    outputDirectory: context.relativeOutputDirectory,
  };
}

function sameGeneration(actual, expected) {
  return isRecord(actual)
    && actual.schemaVersion === expected.schemaVersion
    && actual.policy === expected.policy
    && isRecord(actual.package)
    && Object.keys(actual.package).length === 2
    && actual.package.name === expected.package.name
    && actual.package.version === expected.package.version
    && isRecord(actual.target)
    && Object.keys(actual.target).length === 2
    && actual.target.platform === expected.target.platform
    && actual.target.architecture === expected.target.architecture
    && actual.outputDirectory === expected.outputDirectory
    && Object.keys(actual).length === 5;
}

export async function reservePackageGeneration(options) {
  assertTarget(options.platform, options.architecture);
  const context = await inspectPackageOutputContext(options);
  try {
    await mkdir(context.outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw existingGenerationError(context.relativeOutputDirectory);
    throw error;
  }

  const generation = expectedGeneration(context, options.platform, options.architecture);
  const markerPath = resolve(context.outputDirectory, PACKAGE_GENERATION_MARKER);
  try {
    await writeFile(markerPath, `${JSON.stringify(generation, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(
      `Package-generation root ${context.relativeOutputDirectory} was reserved but its marker could not be written; `
        + 'the root remains consumed and must not be reused.',
      { cause: error },
    );
  }
  return { ...context, generation, markerPath };
}

export async function readPackageGeneration(options) {
  assertTarget(options.platform, options.architecture);
  const context = await inspectPackageOutputContext(options);
  const markerPath = resolve(context.outputDirectory, PACKAGE_GENERATION_MARKER);
  const outputInfo = await lstat(context.outputDirectory).catch((error) => {
    throw new Error(`Package generation root is missing at ${context.outputDirectory}.`, { cause: error });
  });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error(`Package generation root must be a real directory at ${context.outputDirectory}.`);
  }
  const outputRealPath = await realpath(context.outputDirectory);
  if (!isContained(context.workspace, outputRealPath)
    || !isContained(context.outputDirectory, outputRealPath)
    || !isContained(outputRealPath, context.outputDirectory)) {
    throw new Error(`Package generation root resolves outside its declared workspace path at ${context.outputDirectory}.`);
  }
  const markerInfo = await lstat(markerPath).catch((error) => {
    throw new Error(`Package generation marker is missing or invalid at ${markerPath}.`, { cause: error });
  });
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error(`Package generation marker must be a regular non-symlink file at ${markerPath}.`);
  }
  let generation;
  try {
    generation = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`Package generation marker is missing or invalid at ${markerPath}.`, { cause: error });
  }
  const expected = expectedGeneration(context, options.platform, options.architecture);
  if (!sameGeneration(generation, expected)) {
    throw new Error(`Package generation marker does not match ${context.relativeOutputDirectory} and ${options.platform}/${options.architecture}.`);
  }
  return { ...context, generation, markerPath };
}

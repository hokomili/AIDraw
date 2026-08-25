import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const PACKAGE_BUILD_INPUT_MANIFEST = '.aidraw-package-build-input.json';
export const PACKAGE_BUILD_INPUT_POLICY = 'exact-package-source-input-v1';
export const PACKAGE_BUILD_INPUT_PATHS = Object.freeze([
  '.nvmrc',
  'forge.config.ts',
  'index.html',
  'package-lock.json',
  'package.json',
  'packages',
  'resources',
  'scripts/package-build-input.mjs',
  'scripts/package-output-policy.mjs',
  'scripts/safe-dmg-maker.mjs',
  'src',
  'tsconfig.json',
  'vite.main.config.ts',
  'vite.preload.config.ts',
  'vite.renderer.config.ts',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function slash(path) {
  return path.replaceAll('\\', '/');
}

function contained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sortPaths(paths) {
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function canonicalRecordBytes(records) {
  return Buffer.from(records.map((record) => `${record.bytes}\t${record.sha256}\t${record.path}\n`).join(''), 'utf8');
}

async function collectRecords(workspace, selectedPaths) {
  const records = [];
  async function visit(path) {
    const absolute = resolve(workspace, path);
    if (!contained(workspace, absolute)) throw new Error(`Package build input escapes the workspace: ${path}`);
    const details = await lstat(absolute).catch((error) => {
      throw new Error(`Package build input is missing: ${path}`, { cause: error });
    });
    if (details.isSymbolicLink()) throw new Error(`Package build input may not be a symlink: ${path}`);
    if (details.isDirectory()) {
      const children = sortPaths(await readdir(absolute));
      for (const child of children) await visit(join(path, child));
      return;
    }
    if (!details.isFile()) throw new Error(`Package build input must be a regular file: ${path}`);
    if (path.includes('\t') || path.includes('\n') || path.includes('\r')) throw new Error(`Package build input path is not manifest-safe: ${path}`);
    const bytes = await readFile(absolute);
    records.push({ path: slash(path), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  for (const path of selectedPaths) await visit(path);
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.path)) throw new Error(`Package build input path is included more than once: ${record.path}`);
    seen.add(record.path);
  }
  return records;
}

async function buildManifest(options = {}) {
  const workspace = await realpath(resolve(options.workspace ?? process.cwd()));
  const inputPaths = [...(options.inputPaths ?? PACKAGE_BUILD_INPUT_PATHS)];
  if (JSON.stringify(inputPaths) !== JSON.stringify(sortPaths(inputPaths))) {
    throw new Error('Package build input paths must be in deterministic raw UTF-8 order.');
  }
  const records = await collectRecords(workspace, inputPaths);
  const canonicalBytes = canonicalRecordBytes(records);
  return {
    workspace,
    manifest: {
      schemaVersion: 1,
      policy: PACKAGE_BUILD_INPUT_POLICY,
      inputs: inputPaths,
      summary: {
        files: records.length,
        bytes: records.reduce((sum, record) => sum + record.bytes, 0),
        recordsBytes: canonicalBytes.byteLength,
        recordsSha256: sha256(canonicalBytes),
      },
      records,
    },
  };
}

function assertManifestShape(value, expectedInputs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.policy !== PACKAGE_BUILD_INPUT_POLICY
    || JSON.stringify(value.inputs) !== JSON.stringify(expectedInputs)
    || !value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)
    || !Array.isArray(value.records)
    || Object.keys(value).sort().join(',') !== 'inputs,policy,records,schemaVersion,summary') {
    throw new Error('Package build input manifest has an invalid contract.');
  }
  if (JSON.stringify(expectedInputs) !== JSON.stringify(sortPaths(expectedInputs))
    || new Set(expectedInputs).size !== expectedInputs.length
    || expectedInputs.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new Error('Package build input paths must be unique and in deterministic raw UTF-8 order.');
  }
  let previousPath;
  for (const record of value.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'bytes,path,sha256'
      || typeof record.path !== 'string' || record.path.length === 0
      || record.path.includes('\\') || record.path.includes('\t') || record.path.includes('\n') || record.path.includes('\r')
      || isAbsolute(record.path) || record.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)
      || (previousPath !== undefined && Buffer.compare(Buffer.from(previousPath, 'utf8'), Buffer.from(record.path, 'utf8')) >= 0)) {
      throw new Error('Package build input manifest has an invalid file record.');
    }
    previousPath = record.path;
  }
  if (Object.keys(value.summary).sort().join(',') !== 'bytes,files,recordsBytes,recordsSha256') {
    throw new Error('Package build input manifest has an invalid summary contract.');
  }
  const canonicalBytes = canonicalRecordBytes(value.records);
  const summary = {
    files: value.records.length,
    bytes: value.records.reduce((sum, record) => sum + record.bytes, 0),
    recordsBytes: canonicalBytes.byteLength,
    recordsSha256: sha256(canonicalBytes),
  };
  if (JSON.stringify(value.summary) !== JSON.stringify(summary)) throw new Error('Package build input manifest summary does not match its records.');
}

export async function capturePackageBuildInput(options = {}) {
  const outputDirectory = resolve(options.outputDirectory);
  const outputRealPath = await realpath(outputDirectory);
  const { workspace, manifest } = await buildManifest(options);
  if (!contained(workspace, outputRealPath) || outputRealPath === workspace) {
    throw new Error('Package build input manifest must be written inside a reserved package-generation root.');
  }
  const manifestPath = resolve(outputRealPath, PACKAGE_BUILD_INPUT_MANIFEST);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { manifestPath, manifest, fileSha256: sha256(await readFile(manifestPath)) };
}

export async function readPackageBuildInput(options = {}) {
  const outputDirectory = resolve(options.outputDirectory);
  const manifestPath = resolve(outputDirectory, PACKAGE_BUILD_INPUT_MANIFEST);
  const manifestInfo = await lstat(manifestPath).catch((error) => {
    throw new Error(`Package build input manifest is missing at ${manifestPath}.`, { cause: error });
  });
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error(`Package build input manifest must be a regular non-symlink file at ${manifestPath}.`);
  const bytes = await readFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new Error(`Package build input manifest is invalid JSON at ${manifestPath}.`, { cause: error });
  }
  const inputPaths = [...(options.inputPaths ?? PACKAGE_BUILD_INPUT_PATHS)];
  assertManifestShape(manifest, inputPaths);
  const current = await buildManifest({ ...options, inputPaths });
  if (JSON.stringify(current.manifest) !== JSON.stringify(manifest)) {
    throw new Error('Package source inputs changed after the package build began.');
  }
  return {
    manifestPath,
    manifest,
    fileBytes: bytes.byteLength,
    fileSha256: sha256(bytes),
  };
}

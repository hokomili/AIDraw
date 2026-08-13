import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { access, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { arch as hostArchitecture, platform as hostPlatform, release as hostRelease } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

const execute = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const PLATFORM_LABELS = new Map([
  ['win32:x64', 'windows-x64'],
  ['darwin:arm64', 'macos-arm64'],
  ['linux:x64', 'linux-x64'],
]);
const TOOLCHAIN_PACKAGES = Object.freeze([
  'electron',
  '@electron-forge/cli',
  'vite',
  'typescript',
  '@napi-rs/canvas',
  'canvas',
]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function slash(path) { return path.replaceAll('\\', '/'); }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function filesBelow(directory) {
  const result = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release output must not contain symbolic links: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child);
      else throw new Error(`Release output contains an unsupported filesystem entry: ${child}`);
    }
  }
  await visit(directory);
  return result.sort(compare);
}

function releasePlatformLabel(platform, architecture) {
  const label = PLATFORM_LABELS.get(`${platform}:${architecture}`);
  if (!label) throw new Error(`Unsupported release provenance host ${platform}/${architecture}.`);
  return label;
}

function npmVersionFromEnvironment() {
  const match = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/u);
  if (!match) throw new Error('npm version is unavailable; run provenance through the pinned npm script.');
  return match[1];
}

async function inspectRepository(cwd) {
  const [{ stdout: commit }, { stdout: statusOutput }] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }),
    execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
  ]);
  return { commit: commit.trim(), status: statusOutput.trimEnd() };
}

function parseChecksumManifest(contents) {
  const entries = [];
  const seen = new Set();
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/iu);
    if (!match) throw new Error(`Checksum manifest line ${index + 1} is malformed.`);
    const path = match[2];
    if (path.includes('\\') || path.startsWith('/') || path.split('/').some((component) => !component || component === '.' || component === '..')) throw new Error(`Checksum manifest line ${index + 1} has an unsafe path.`);
    if (seen.has(path)) throw new Error(`Checksum manifest repeats ${path}.`);
    seen.add(path);
    entries.push({ path, sha256: match[1].toLowerCase() });
  }
  if (!entries.length) throw new Error('Checksum manifest is empty.');
  return entries.sort((left, right) => compare(left.path, right.path));
}

async function existingChecksumManifest(outDirectory, platformLabel, explicitName) {
  const names = explicitName ? [explicitName] : [`SHA256SUMS-${platformLabel}.txt`, 'SHA256SUMS.txt'];
  for (const name of names) {
    if (!/^SHA256SUMS(?:-[a-z0-9-]+)?\.txt$/iu.test(name)) throw new Error(`Invalid checksum manifest name ${JSON.stringify(name)}.`);
    const path = join(outDirectory, name);
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw new Error(`No checksum manifest exists for ${platformLabel}.`);
}

async function fileRecord(outDirectory, path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Release evidence must be a regular non-symlink file: ${path}`);
  return { path: slash(relative(outDirectory, path)), bytes: info.size, sha256: await sha256File(path) };
}

function declaredToolchain(packageJson) {
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const result = {};
  for (const name of TOOLCHAIN_PACKAGES) {
    const version = declared[name];
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) throw new Error(`Release toolchain dependency ${name} must use an exact version.`);
    result[name] = version;
  }
  return result;
}

function validateRepository(repository) {
  if (!isRecord(repository) || !COMMIT.test(repository.commit)) throw new Error('Release provenance requires a full 40-character Git commit.');
  if (typeof repository.status !== 'string') throw new Error('Release provenance requires an explicit Git status.');
  if (repository.status) throw new Error(`Release provenance requires a clean checkout; found ${repository.status.split(/\r?\n/u).length} changed path(s).`);
}

export async function captureReleaseProvenance(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const outDirectory = resolve(cwd, options.outDirectory ?? 'out');
  const makeDirectory = join(outDirectory, 'make');
  const packagePath = join(cwd, 'package.json');
  const lockPath = join(cwd, 'package-lock.json');
  const nvmrcPath = join(cwd, '.nvmrc');
  const [packageBytes, lockBytes, nvmrc, repository] = await Promise.all([
    readFile(packagePath),
    readFile(lockPath),
    readFile(nvmrcPath, 'utf8'),
    options.repository ?? inspectRepository(cwd),
  ]);
  validateRepository(repository);
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  const lockJson = JSON.parse(lockBytes.toString('utf8'));
  if (packageJson.name !== 'aidraw' || lockJson.name !== 'aidraw') throw new Error('Release provenance must run in the AIDraw workspace.');
  if (typeof packageJson.version !== 'string' || !packageJson.version) throw new Error('package.json has no version.');
  if (lockJson.packages?.['']?.version !== packageJson.version) throw new Error('Root package-lock version does not match package.json.');

  const nodePlatform = options.runtime?.platform ?? hostPlatform();
  const architecture = options.runtime?.architecture ?? hostArchitecture();
  const expectedPlatformLabel = releasePlatformLabel(nodePlatform, architecture);
  const platformLabel = options.platformLabel ?? process.env.AIDRAW_RELEASE_PLATFORM ?? expectedPlatformLabel;
  if (platformLabel !== expectedPlatformLabel) throw new Error(`Release platform label ${platformLabel} disagrees with native host ${nodePlatform}/${architecture} (${expectedPlatformLabel}).`);
  const nodeVersion = options.runtime?.nodeVersion ?? process.version;
  if (!/^v24\./u.test(nodeVersion)) throw new Error(`Release provenance requires Node 24.x; found ${nodeVersion}.`);
  const npmVersion = options.runtime?.npmVersion ?? npmVersionFromEnvironment();
  if (!EXACT_VERSION.test(npmVersion)) throw new Error(`Release provenance requires an exact npm version; found ${npmVersion}.`);
  if (nvmrc.trim() !== '24' || packageJson.engines?.node !== '>=24 <25') throw new Error('Release provenance requires the repository Node 24 runtime contract.');

  const makeFiles = await filesBelow(makeDirectory);
  if (!makeFiles.length) throw new Error('Release maker output is empty.');
  const artifacts = [];
  for (const path of makeFiles) artifacts.push(await fileRecord(outDirectory, path));

  const checksumPath = await existingChecksumManifest(outDirectory, platformLabel, options.checksumManifestName ?? process.env.AIDRAW_CHECKSUM_FILE);
  const checksumContents = await readFile(checksumPath, 'utf8');
  const checksumEntries = parseChecksumManifest(checksumContents);
  const artifactByPath = new Map(artifacts.map((entry) => [entry.path, entry]));
  if (checksumEntries.length !== artifacts.length) throw new Error(`Checksum manifest covers ${checksumEntries.length} files, but maker output contains ${artifacts.length}.`);
  for (const entry of checksumEntries) {
    const artifact = artifactByPath.get(entry.path);
    if (!artifact) throw new Error(`Checksum manifest names missing maker artifact ${entry.path}.`);
    if (artifact.sha256 !== entry.sha256) throw new Error(`Checksum manifest hash mismatch for ${entry.path}.`);
  }

  const licenseReports = [];
  for (const name of ['THIRD_PARTY_LICENSES.json', 'THIRD_PARTY_LICENSES.md']) {
    const path = join(outDirectory, name);
    if (await access(path).then(() => true, () => false)) licenseReports.push(await fileRecord(outDirectory, path));
  }
  if (platformLabel === 'windows-x64' && licenseReports.length !== 2) throw new Error('Windows release provenance requires both third-party license reports.');

  const manifest = {
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    platform: { label: platformLabel, nodePlatform, architecture },
    candidate: { version: packageJson.version, commit: repository.commit.toLowerCase() },
    source: {
      clean: true,
      packageJsonSha256: sha256Bytes(packageBytes),
      packageLockSha256: sha256Bytes(lockBytes),
      lockfileVersion: lockJson.lockfileVersion,
    },
    runtime: {
      node: nodeVersion,
      npm: npmVersion,
      nvmrc: nvmrc.trim(),
      nodeEngine: packageJson.engines.node,
      osRelease: options.runtime?.osRelease ?? hostRelease(),
    },
    toolchain: declaredToolchain(packageJson),
    artifacts,
    checksumManifest: await fileRecord(outDirectory, checksumPath),
    licenseReports,
  };

  const outputPath = options.outputPath ? resolve(cwd, options.outputPath) : join(outDirectory, `RELEASE_PROVENANCE-${platformLabel}.json`);
  if (options.write !== false) await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { manifest, outputPath };
}

function valueAt(object, path) {
  let value = object;
  for (const part of path.split('.')) value = isRecord(value) ? value[part] : undefined;
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function addDifference(target, field, left, right) {
  if (stableJson(left) !== stableJson(right)) target.push({ field, left: left ?? null, right: right ?? null });
}

function recordsByPath(value, field, differences, side) {
  if (!Array.isArray(value)) { differences.push({ field, left: side === 'left' ? 'invalid' : null, right: side === 'right' ? 'invalid' : null }); return new Map(); }
  const result = new Map();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      differences.push({ field, left: side === 'left' ? 'invalid entry' : null, right: side === 'right' ? 'invalid entry' : null });
      continue;
    }
    if (result.has(entry.path)) differences.push({ field: `${field}.${entry.path}`, left: side === 'left' ? 'duplicate' : null, right: side === 'right' ? 'duplicate' : null });
    result.set(entry.path, entry);
  }
  return result;
}

export function compareReleaseProvenance(left, right, options = {}) {
  const sourceDifferences = [];
  const toolchainDifferences = [];
  const artifactDifferences = [];
  const environmentDifferences = [];
  for (const [side, manifest] of [['left', left], ['right', right]]) {
    if (!isRecord(manifest) || manifest.schemaVersion !== 1) sourceDifferences.push({ field: `${side}.schemaVersion`, left: side === 'left' ? manifest?.schemaVersion ?? null : null, right: side === 'right' ? manifest?.schemaVersion ?? null : null });
  }
  for (const field of ['platform.label', 'platform.nodePlatform', 'platform.architecture', 'candidate.version', 'candidate.commit', 'source.clean', 'source.packageJsonSha256', 'source.packageLockSha256', 'source.lockfileVersion']) addDifference(sourceDifferences, field, valueAt(left, field), valueAt(right, field));
  if (valueAt(left, 'source.clean') !== true || valueAt(right, 'source.clean') !== true) sourceDifferences.push({ field: 'source.clean.required', left: valueAt(left, 'source.clean') ?? null, right: valueAt(right, 'source.clean') ?? null });
  for (const field of ['runtime.node', 'runtime.npm', 'runtime.nvmrc', 'runtime.nodeEngine', 'toolchain']) addDifference(toolchainDifferences, field, valueAt(left, field), valueAt(right, field));
  addDifference(environmentDifferences, 'runtime.osRelease', valueAt(left, 'runtime.osRelease'), valueAt(right, 'runtime.osRelease'));
  addDifference(environmentDifferences, 'capturedAt', valueAt(left, 'capturedAt'), valueAt(right, 'capturedAt'));

  const leftArtifacts = recordsByPath(left?.artifacts, 'artifacts', artifactDifferences, 'left');
  const rightArtifacts = recordsByPath(right?.artifacts, 'artifacts', artifactDifferences, 'right');
  for (const path of [...new Set([...leftArtifacts.keys(), ...rightArtifacts.keys()])].sort(compare)) addDifference(artifactDifferences, `artifacts.${path}`, leftArtifacts.get(path), rightArtifacts.get(path));
  addDifference(artifactDifferences, 'checksumManifest', left?.checksumManifest, right?.checksumManifest);
  const leftLicenses = recordsByPath(left?.licenseReports, 'licenseReports', artifactDifferences, 'left');
  const rightLicenses = recordsByPath(right?.licenseReports, 'licenseReports', artifactDifferences, 'right');
  for (const path of [...new Set([...leftLicenses.keys(), ...rightLicenses.keys()])].sort(compare)) addDifference(artifactDifferences, `licenseReports.${path}`, leftLicenses.get(path), rightLicenses.get(path));

  const differences = [...sourceDifferences, ...toolchainDifferences, ...artifactDifferences];
  const artifactCount = leftArtifacts.size;
  if (!artifactCount || rightArtifacts.size !== artifactCount) {
    if (!differences.some((entry) => entry.field === 'artifacts.count')) differences.push({ field: 'artifacts.count', left: artifactCount, right: rightArtifacts.size });
  }
  differences.sort((a, b) => compare(a.field, b.field));
  return {
    schemaVersion: 1,
    comparedAt: options.comparedAt ?? new Date().toISOString(),
    result: differences.length ? 'FAIL' : 'PASS',
    platform: valueAt(left, 'platform.label') ?? null,
    candidate: {
      version: valueAt(left, 'candidate.version') ?? null,
      commit: valueAt(left, 'candidate.commit') ?? null,
    },
    sourceIdentityEqual: sourceDifferences.length === 0,
    toolchainIdentityEqual: toolchainDifferences.length === 0,
    artifactInventoryEqual: artifactDifferences.length === 0 && artifactCount > 0 && rightArtifacts.size === artifactCount,
    artifactCount,
    leftManifest: options.leftManifest,
    rightManifest: options.rightManifest,
    differences,
    environmentDifferences: environmentDifferences.sort((a, b) => compare(a.field, b.field)),
  };
}

async function loadManifest(path) {
  const linkInfo = await lstat(path);
  const info = await stat(path);
  if (linkInfo.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`Provenance manifest must be a regular non-symlink file no larger than 4 MiB: ${path}`);
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes), bytes: info.size };
}

function parseArguments(arguments_) {
  const [mode, ...rest] = arguments_;
  if (!['capture', 'compare'].includes(mode)) throw new Error('Usage: release-provenance.mjs capture [--output=path] | compare --left=path --right=path --output=path');
  const values = { mode, output: undefined, left: undefined, right: undefined };
  for (const argument of rest) {
    if (argument.startsWith('--output=')) values.output = argument.slice('--output='.length);
    else if (argument.startsWith('--left=')) values.left = argument.slice('--left='.length);
    else if (argument.startsWith('--right=')) values.right = argument.slice('--right='.length);
    else throw new Error(`Unknown release-provenance argument: ${argument}`);
  }
  if (mode === 'compare' && (!values.left || !values.right || !values.output)) throw new Error('compare requires --left, --right, and --output.');
  if (mode === 'capture' && (values.left || values.right)) throw new Error('capture does not accept --left or --right.');
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_.mode === 'capture') {
      const result = await captureReleaseProvenance({ outputPath: arguments_.output });
      process.stdout.write(`AIDraw release provenance: captured ${result.manifest.artifacts.length} artifacts in ${result.outputPath}.\n`);
    } else {
      const leftPath = resolve(arguments_.left);
      const rightPath = resolve(arguments_.right);
      const [left, right] = await Promise.all([loadManifest(leftPath), loadManifest(rightPath)]);
      const report = compareReleaseProvenance(left.value, right.value, {
        leftManifest: { path: basename(leftPath), bytes: left.bytes, sha256: left.sha256 },
        rightManifest: { path: basename(rightPath), bytes: right.bytes, sha256: right.sha256 },
      });
      const outputPath = resolve(arguments_.output);
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      process.stdout.write(`AIDraw release reproducibility: ${report.result} for ${report.platform} (${report.artifactCount} artifacts); report ${outputPath}.\n`);
      if (report.result !== 'PASS') process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`AIDraw release provenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

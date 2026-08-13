import { readFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

export const EXPECTED_ELECTRON_VERSION = '43.4.0';
export const COMPLETE_AUDIT_COMMAND = 'npm audit --include=prod --include=dev --include=optional --include=peer --audit-level=high';

export const REPOSITORY_WORKSPACE_PATHS = Object.freeze([
  'packages/canvas',
  'packages/core',
]);

const REPOSITORY_WORKSPACE_PATTERNS = Object.freeze(['packages/*']);

export const REQUIRED_SECURITY_OVERRIDES = Object.freeze({
  '@electron/rebuild': '4.2.0',
  'extract-zip': 'npm:@electron-internal/extract-zip@1.0.5',
  tar: '7.5.22',
  tmp: '0.2.7',
});

const REQUIRED_LOCKED_PACKAGES = Object.freeze({
  'node_modules/@electron/packager': '18.4.4',
  'node_modules/@electron/rebuild': '4.2.0',
  'node_modules/electron': EXPECTED_ELECTRON_VERSION,
  'node_modules/extract-zip': '1.0.5',
  'node_modules/tar': '7.5.22',
  'node_modules/tmp': '0.2.7',
});

const FORBIDDEN_BUILD_PACKAGES = Object.freeze([
  '@electron/node-gyp',
  'appdmg',
  'electron-installer-dmg',
  'image-size',
]);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be exactly ${expected}; found ${String(value)}.`);
}

function requireExactStringArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} must be exactly ${JSON.stringify(expected)}.`);
  }
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index < 0 ? undefined : lockPath.slice(index + marker.length);
}

function isExactNpmRegistryTarball(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.hostname === 'registry.npmjs.org'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && url.pathname.endsWith('.tgz');
}

function inspectLockProvenance(packages) {
  const allowedWorkspaces = new Set(REPOSITORY_WORKSPACE_PATHS);
  const linkedWorkspaces = new Set();
  let externalRegistryPackages = 0;

  for (const [lockPath, value] of Object.entries(packages)) {
    if (!lockPath) continue;
    const record = requireRecord(value, `package-lock.json ${lockPath}`);
    if (record.link === true) {
      if (!lockPath.startsWith('node_modules/') || typeof record.resolved !== 'string' || !allowedWorkspaces.has(record.resolved)) {
        throw new Error(`${lockPath} must link to an explicitly allowed repository workspace.`);
      }
      requireRecord(packages[record.resolved], `package-lock.json workspace ${record.resolved}`);
      linkedWorkspaces.add(record.resolved);
      continue;
    }
    if (allowedWorkspaces.has(lockPath)) continue;
    if (!isExactNpmRegistryTarball(record.resolved)) {
      throw new Error(`${lockPath} must resolve to an exact HTTPS registry.npmjs.org tarball.`);
    }
    if (typeof record.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity)) {
      throw new Error(`${lockPath} must retain a registry SHA-512 integrity value.`);
    }
    externalRegistryPackages += 1;
  }

  for (const workspacePath of allowedWorkspaces) {
    const workspace = requireRecord(packages[workspacePath], `package-lock.json workspace ${workspacePath}`);
    if (workspace.link === true || Object.hasOwn(workspace, 'resolved') || Object.hasOwn(workspace, 'integrity')) {
      throw new Error(`${workspacePath} must remain a repository workspace record without external resolution metadata.`);
    }
    if (!linkedWorkspaces.has(workspacePath)) throw new Error(`${workspacePath} must have a package-lock.json workspace link.`);
  }

  return {
    externalRegistryPackages,
    repositoryWorkspaces: [...REPOSITORY_WORKSPACE_PATHS],
  };
}

export function inspectDependencySecurityPolicy({ packageJson, lockJson }) {
  const manifest = requireRecord(packageJson, 'package.json');
  const lock = requireRecord(lockJson, 'package-lock.json');
  requireExact(lock.lockfileVersion, 3, 'package-lock.json lockfileVersion');

  const devDependencies = requireRecord(manifest.devDependencies, 'package.json devDependencies');
  const overrides = requireRecord(manifest.overrides, 'package.json overrides');
  const scripts = requireRecord(manifest.scripts, 'package.json scripts');
  requireExactStringArray(manifest.workspaces, REPOSITORY_WORKSPACE_PATTERNS, 'package.json workspaces');
  requireExact(scripts['security:audit:complete'], COMPLETE_AUDIT_COMMAND, 'package.json complete security audit command');
  requireExact(devDependencies.electron, EXPECTED_ELECTRON_VERSION, 'package.json Electron version');
  requireExact(devDependencies['@electron-forge/cli'], '7.11.2', 'package.json Electron Forge CLI version');
  requireExact(devDependencies['@electron-forge/maker-base'], '7.11.2', 'package.json local DMG maker base version');
  if (Object.hasOwn(devDependencies, '@electron-forge/maker-dmg')) throw new Error('The vulnerable appdmg-backed Forge DMG maker must not be installed.');

  for (const [name, version] of Object.entries(REQUIRED_SECURITY_OVERRIDES)) {
    requireExact(overrides[name], version, `package.json override ${name}`);
  }

  const packages = requireRecord(lock.packages, 'package-lock.json packages');
  const root = requireRecord(packages[''], 'package-lock.json root package');
  requireExactStringArray(root.workspaces, REPOSITORY_WORKSPACE_PATTERNS, 'package-lock.json root workspaces');
  const provenance = inspectLockProvenance(packages);
  const lockedDevDependencies = requireRecord(root.devDependencies, 'package-lock.json root devDependencies');
  requireExact(lockedDevDependencies.electron, EXPECTED_ELECTRON_VERSION, 'package-lock.json root Electron version');
  requireExact(lockedDevDependencies['@electron-forge/maker-base'], '7.11.2', 'package-lock.json root local DMG maker base version');
  if (Object.hasOwn(lockedDevDependencies, '@electron-forge/maker-dmg')) throw new Error('package-lock.json still installs the vulnerable Forge DMG maker.');

  for (const [lockPath, version] of Object.entries(REQUIRED_LOCKED_PACKAGES)) {
    const record = requireRecord(packages[lockPath], `package-lock.json ${lockPath}`);
    requireExact(record.version, version, `${lockPath} version`);
  }

  const electronRecord = packages['node_modules/electron'];
  requireExact(electronRecord.resolved, `https://registry.npmjs.org/electron/-/electron-${EXPECTED_ELECTRON_VERSION}.tgz`, 'locked Electron tarball');
  const extractorRecord = packages['node_modules/extract-zip'];
  requireExact(extractorRecord.name, '@electron-internal/extract-zip', 'locked Packager extractor package');
  requireExact(
    extractorRecord.resolved,
    'https://registry.npmjs.org/@electron-internal/extract-zip/-/extract-zip-1.0.5.tgz',
    'locked Packager extractor tarball',
  );

  const forbidden = [];
  for (const lockPath of Object.keys(packages)) {
    const packageName = packageNameFromLockPath(lockPath);
    const lockRecord = packages[lockPath];
    if (
      (packageName && FORBIDDEN_BUILD_PACKAGES.includes(packageName))
      || (packageName === 'extract-zip' && lockRecord?.name !== '@electron-internal/extract-zip')
    ) forbidden.push(lockPath);
  }
  if (forbidden.length) throw new Error(`Vulnerable or superseded build packages remain locked: ${forbidden.join(', ')}.`);

  return {
    electron: EXPECTED_ELECTRON_VERSION,
    forge: '7.11.2',
    packager: '18.4.4',
    extractor: '@electron-internal/extract-zip@1.0.5',
    ...provenance,
    overrides: { ...REQUIRED_SECURITY_OVERRIDES },
    removedBuildPackages: [...FORBIDDEN_BUILD_PACKAGES],
  };
}

export function assertPackagedElectronVersion(expected, packagedVersionText) {
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) throw new Error('Expected Electron version is not an exact stable version.');
  if (typeof packagedVersionText !== 'string') throw new Error('Packaged Electron version file is not text.');
  const packaged = packagedVersionText.trim();
  if (packaged !== expected) throw new Error(`Packaged Electron runtime is ${packaged || 'missing'}; expected ${expected}.`);
  return packaged;
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

async function main() {
  const packageJson = await readJson(resolve('package.json'), 'package.json');
  const lockJson = await readJson(resolve('package-lock.json'), 'package-lock.json');
  const result = inspectDependencySecurityPolicy({ packageJson, lockJson });
  process.stdout.write(`${JSON.stringify({ verified: true, node: process.version, ...result }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

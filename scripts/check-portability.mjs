import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

const execute = promisify(execFile);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SECRET_NAME = /^(?:aidraw-connection.*\.json|mcp-(?:connection|token)\.json|trusted-folders\.json)$/i;
const SECRET_EXTENSION = /\.(?:cer|crt|csr|der|jks|key|keystore|mobileprovision|p12|pem|pfx|provisionprofile)$/i;
const GENERATED_DIRECTORY = /^(?:\.AppleDouble|\.codex|\.electron-cache|\.fseventsd|\.npm-cache|\.Spotlight-V100|\.tmp|\.tmp-e2e-profile|\.Trashes|\.vite|\$RECYCLE\.BIN|autonomous-output|coverage|DerivedData|dist|node_modules|out(?:-.*)?|playwright-report|test-results|.*\.app|.*\.xcarchive)$/i;
const GENERATED_FILE = /^(?:\.DS_Store|\.LSOverride|desktop\.ini|ehthumbs\.db|Icon\r|Thumbs\.db|\._.*)$/i;
const GENERATED_EXTENSION = /\.(?:dmg|dmp|pkg)$/i;

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function inspectRepositoryPaths(inputPaths) {
  const paths = [...new Set(inputPaths)].sort(compare);
  const violations = [];
  const identities = new Map();
  const add = (code, path, message, otherPath) => violations.push({ code, path, ...(otherPath ? { otherPath } : {}), message });

  for (const path of paths) {
    if (typeof path !== 'string' || !path) { add('empty_path', String(path), 'Repository paths must be nonempty strings.'); continue; }
    if (path.includes('\0') || path.includes('\\')) add('unsafe_separator', path, 'Repository paths must use relative Git slash separators.');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('//')) add('absolute_path', path, 'Repository paths must be relative, never absolute or drive-qualified.');
    if (path.includes('\uFFFD')) add('invalid_unicode', path, 'Repository paths must decode as valid Unicode.');

    const components = path.split('/');
    for (const component of components) {
      if (!component || component === '.' || component === '..') add('unsafe_component', path, `Unsafe path component ${JSON.stringify(component)}.`);
      if ([...component].some((character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code === 127 || '<>:"|?*'.includes(character); })) add('forbidden_character', path, `Cross-platform-forbidden character in ${JSON.stringify(component)}.`);
      if (/[. ]$/.test(component)) add('trailing_dot_or_space', path, `Path component ends in a dot or space: ${JSON.stringify(component)}.`);
      if (WINDOWS_DEVICE_NAME.test(component)) add('reserved_device_name', path, `Reserved Windows device name: ${JSON.stringify(component)}.`);
      if (Buffer.byteLength(component, 'utf8') > 255) add('component_too_long', path, `Path component exceeds the portable 255-byte limit: ${JSON.stringify(component)}.`);
      if (GENERATED_DIRECTORY.test(component)) add('generated_directory', path, `Generated/local-only directory must not be tracked: ${JSON.stringify(component)}.`);
    }

    const leaf = components.at(-1) ?? '';
    if (GENERATED_FILE.test(leaf) || GENERATED_EXTENSION.test(leaf)) add('platform_artifact', path, `Platform-generated artifact must not be tracked: ${JSON.stringify(leaf)}.`);
    const retiredProviderStoreFile = leaf.toLowerCase() === 'generation.json' && components.slice(0, -1).some((component) => component.toLowerCase() === 'credentials');
    if ((/^\.env(?:\..+)?$/i.test(leaf) && leaf.toLowerCase() !== '.env.example') || leaf.toLowerCase() === '.npmrc' || SECRET_NAME.test(leaf) || retiredProviderStoreFile || SECRET_EXTENSION.test(leaf)) {
      add('secret_or_credential', path, `Credential/bootstrap/signing material must not be tracked: ${JSON.stringify(leaf)}.`);
    }

    const identity = path.normalize('NFC').toLowerCase();
    const existing = identities.get(identity);
    if (existing && existing !== path) add('casefold_collision', path, `Path collides on a case-insensitive or Unicode-normalizing filesystem with ${JSON.stringify(existing)}.`, existing);
    else identities.set(identity, path);
  }

  return violations.sort((left, right) => compare(`${left.code}\0${left.path}`, `${right.code}\0${right.path}`));
}

export function inspectReleaseHost(expectedPlatform, expectedArchitecture, actual = { platform: process.platform, architecture: process.arch }) {
  const violations = [];
  if (expectedPlatform && expectedPlatform !== actual.platform) violations.push({ code: 'host_platform_mismatch', path: '', message: `Release job expects ${expectedPlatform}, but Node reports ${actual.platform}.` });
  if (expectedArchitecture && expectedArchitecture !== actual.architecture) violations.push({ code: 'host_architecture_mismatch', path: '', message: `Release job expects ${expectedArchitecture}, but Node reports ${actual.architecture}.` });
  return violations;
}

async function gitPaths(cwd, args) {
  const { stdout } = await execute('git', ['ls-files', '-z', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.split('\0').filter(Boolean);
}

export async function inspectRepository(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tracked = await gitPaths(cwd, ['--cached']);
  const untracked = options.includeUntracked ? await gitPaths(cwd, ['--others', '--exclude-standard']) : [];
  const hostViolations = inspectReleaseHost(options.expectedPlatform, options.expectedArchitecture, options.actualHost);
  return {
    cwd,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    trackedCount: tracked.length,
    untrackedCount: untracked.length,
    violations: [...inspectRepositoryPaths([...tracked, ...untracked]), ...hostViolations],
  };
}

function parseArguments(arguments_) {
  const options = { includeUntracked: false, json: false, expectedPlatform: undefined, expectedArchitecture: undefined };
  for (const argument of arguments_) {
    if (argument === '--include-untracked') options.includeUntracked = true;
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--expect-platform=')) options.expectedPlatform = argument.slice('--expect-platform='.length);
    else if (argument.startsWith('--expect-arch=')) options.expectedArchitecture = argument.slice('--expect-arch='.length);
    else throw new Error(`Unknown portability-check argument: ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await inspectRepository(options);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (!report.violations.length) process.stdout.write(`AIDraw portability preflight: ${report.trackedCount} tracked + ${report.untrackedCount} untracked paths are portable on ${report.platform}/${report.architecture}.\n`);
    else process.stderr.write(`${report.violations.map((entry) => `[${entry.code}] ${entry.path || '<host>'}: ${entry.message}`).join('\n')}\n`);
    if (report.violations.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`AIDraw portability preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

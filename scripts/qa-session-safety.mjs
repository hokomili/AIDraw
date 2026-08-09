import { posix, win32 } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

function normalizedPath(value, platform) {
  const path = platform === 'win32' ? win32 : posix;
  const normalized = path.resolve(String(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function commandLineHasProfile(commandLine, profile, platform) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return false;
  const expected = `--user-data-dir=${profile}`;
  const comparableCommand = (platform === 'win32' ? commandLine.toLowerCase() : commandLine).replaceAll('"', '');
  const comparableExpected = platform === 'win32' ? expected.toLowerCase() : expected;
  let offset = comparableCommand.indexOf(comparableExpected);
  while (offset >= 0) {
    const before = offset === 0 ? '' : comparableCommand[offset - 1];
    const after = comparableCommand[offset + comparableExpected.length] ?? '';
    if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) return true;
    offset = comparableCommand.indexOf(comparableExpected, offset + 1);
  }
  return false;
}

export function requiresUnsandboxedGuiLaunch(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

export function processProbeErrorMeansAlive(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
}

export function assertConnectionFileReplaceable(connection, processAlive) {
  const pid = Number(connection?.pid);
  if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
    throw new Error(`Refusing to replace a QA connection file while its recorded PID ${pid} is still alive.`);
  }
}

export function assertForceStopIdentity({ manifest, connection, currentExeSha256, processIdentity, platform = process.platform }) {
  const pid = Number(manifest.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Force-stop identity has an invalid manifest PID.');
  if (Number(connection.pid) !== pid) throw new Error(`Force-stop refused: connection PID ${connection.pid} does not match manifest PID ${pid}.`);
  if (Number(processIdentity.pid) !== pid) throw new Error(`Force-stop refused: live process PID ${processIdentity.pid} does not match manifest PID ${pid}.`);
  if (connection.url !== manifest.mcpUrl) throw new Error('Force-stop refused: connection URL does not match the manifest MCP URL.');
  const mcpUrl = new URL(manifest.mcpUrl);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(mcpUrl.hostname)) throw new Error('Force-stop refused: manifest MCP URL is not loopback-only.');
  if (currentExeSha256 !== manifest.exeSha256) throw new Error('Force-stop refused: executable SHA-256 no longer matches the manifest.');
  if (normalizedPath(processIdentity.executablePath, platform) !== normalizedPath(manifest.exe, platform)) {
    throw new Error('Force-stop refused: live process executable does not match the manifest.');
  }
  if (!commandLineHasProfile(processIdentity.commandLine, manifest.profile, platform)) {
    throw new Error('Force-stop refused: live process command line does not contain the exact manifest profile.');
  }
  return { pid, mcpUrl: manifest.mcpUrl, exeSha256: currentExeSha256, exe: manifest.exe, profile: manifest.profile };
}

export function buildRedactedConnection(connection, manifest, stoppedAt = new Date().toISOString()) {
  return {
    version: connection.version ?? 1,
    url: connection.url ?? manifest.mcpUrl,
    activeDocumentId: connection.activeDocumentId,
    pid: connection.pid ?? manifest.pid,
    trustedFolders: connection.trustedFolders ?? manifest.trustedFolders ?? [],
    stoppedAt,
    credentialsRedacted: true,
  };
}

import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

export const FND05_PACKAGED_SCENARIO = 'FND-05-STALE-RENDERER exact package replaces one lost renderer without replacing its engine';
export const FND05_PACKAGED_PROFILE_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_PROFILE';
export const FND05_PACKAGED_EXE_HASH_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_EXE_SHA256';
export const FND05_PACKAGED_ASAR_HASH_ENV = 'AIDRAW_E2E_FND05_STALE_RENDERER_ASAR_SHA256';
export const FND05_PACKAGED_PROFILE_PREFIX = 'aidraw-e2e-fnd05-stale-renderer-';
export const FND05_PACKAGED_FILES = Object.freeze({
  ownerConnection: 'mcp-owner-connection.json',
  relaunchConnection: 'mcp-relaunch-connection.json',
  evidence: 'fnd05-stale-renderer-evidence.json',
  failure: 'fnd05-stale-renderer-failure.json',
  cleanup: 'fnd05-stale-renderer-cleanup.json',
  forbiddenNetwork: 'fnd05-forbidden-network.json',
  providerCredentials: join('credentials', 'generation.json'),
  tokenCredentials: join('credentials', 'mcp-token.json'),
});

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for the retained FND-05 exact-package acceptance.`);
  return value;
}

function declaredSha256(environment, name) {
  const value = required(environment, name).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(value)) throw new Error(`${name} must be one exact SHA-256 digest.`);
  return value;
}

export function resolveFnd05PackagedAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const profile = resolve(required(environment, FND05_PACKAGED_PROFILE_ENV));
  const nested = relative(retainedRoot, profile);
  const leaf = basename(profile);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(profile) !== retainedRoot || !leaf.startsWith(FND05_PACKAGED_PROFILE_PREFIX)) {
    throw new Error(`${FND05_PACKAGED_PROFILE_ENV} must be a fresh ${FND05_PACKAGED_PROFILE_PREFIX}* direct child of test-results/retained.`);
  }
  const runId = leaf.slice(FND05_PACKAGED_PROFILE_PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${FND05_PACKAGED_PROFILE_ENV} must end in a 8-80 character lowercase run identifier.`);
  }
  const paths = Object.fromEntries(Object.entries(FND05_PACKAGED_FILES).map(([key, file]) => [key, join(profile, file)]));
  return {
    workspace,
    retainedRoot,
    profile,
    runId,
    executableSha256: declaredSha256(environment, FND05_PACKAGED_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, FND05_PACKAGED_ASAR_HASH_ENV),
    paths,
  };
}

export function parseFnd05OwnedProcesses(processTable, profilePath) {
  const profile = resolve(profilePath);
  const escapedProfile = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactProfile = new RegExp(`(?:=|\\s|["'])${escapedProfile}(?=$|[\\s/"'])`);
  const rows = [];
  for (const line of String(processTable).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !exactProfile.test(match[3])) continue;
    const type = match[3].match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? 'browser';
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), type });
  }
  return rows.sort((left, right) => left.pid - right.pid);
}

export function redactFnd05FailureText(value, secrets = []) {
  let text = String(value ?? '').slice(0, 16_384);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|token)\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]');
}

export function assertFnd05EvidenceRedacted(serialized, forbiddenValues = []) {
  const text = String(serialized);
  if (/"(?:token|authorization)"\s*:/i.test(text) || /Bearer\s+(?!\[redacted\])[^\s"']+/i.test(text)) {
    throw new Error('FND-05 retained evidence contains a credential-shaped field or bearer value.');
  }
  const leaked = forbiddenValues.filter((value) => value && text.includes(value));
  if (leaked.length) throw new Error('FND-05 retained evidence contains a declared secret value.');
  return true;
}

const EXPECTED_PAGE_CRASH_COMMAND_ERROR = /^(?:cdpSession\.send:\s*)?(?:Protocol error \(Page\.crash\):\s*)?(?:Page crashed|Target crashed|Target closed|Session closed(?:\..*)?|Target page, context or browser has been closed)\.?\s*$/i;

function crashErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function observeFnd05DeliberatePageCrash(crashEvent, crashCommand) {
  const [eventOutcome, commandOutcome] = await Promise.allSettled([crashEvent, crashCommand]);
  if (eventOutcome.status === 'rejected') {
    const message = crashErrorMessage(eventOutcome.reason);
    throw new Error(`The deliberate FND-05 renderer crash was not positively observed: ${message}`, { cause: eventOutcome.reason });
  }
  if (commandOutcome.status === 'rejected') {
    const message = crashErrorMessage(commandOutcome.reason);
    if (!EXPECTED_PAGE_CRASH_COMMAND_ERROR.test(message)) {
      throw new Error(`The FND-05 Page.crash command failed for an unrelated reason: ${message}`, { cause: commandOutcome.reason });
    }
    return { crashObserved: true, command: 'rejected-after-crash' };
  }
  return { crashObserved: true, command: 'resolved' };
}

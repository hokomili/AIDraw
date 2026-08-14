import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { inspectPackagedMcpCredential } from './packaged-e2e-runtime.mjs';

export const UX01_PACKAGED_SCENARIO = 'UX-01-DENSITY exact package preserves supported content viewports and reachable editor controls';
export const UX01_PACKAGED_PROFILE_ENV = 'AIDRAW_E2E_UX01_DENSITY_PROFILE';
export const UX01_PACKAGED_FAILURE_ROOT_ENV = 'AIDRAW_E2E_UX01_DENSITY_FAILURE_ROOT';
export const UX01_PACKAGED_EXE_HASH_ENV = 'AIDRAW_E2E_UX01_DENSITY_EXE_SHA256';
export const UX01_PACKAGED_ASAR_HASH_ENV = 'AIDRAW_E2E_UX01_DENSITY_ASAR_SHA256';
export const UX01_PACKAGED_PROFILE_PREFIX = 'aidraw-e2e-ux01-density-';
export const UX01_PACKAGED_FAILURE_PREFIX = 'ux01-density-native-';
export const UX01_UNSAFE_REPORT_ENVIRONMENTS = Object.freeze([
  'PLAYWRIGHT_HTML_OUTPUT_DIR',
  'PLAYWRIGHT_HTML_OPEN',
  'PLAYWRIGHT_HTML_HOST',
  'PLAYWRIGHT_HTML_PORT',
  'PLAYWRIGHT_JSON_OUTPUT_FILE',
  'PLAYWRIGHT_JSON_OUTPUT_NAME',
  'PLAYWRIGHT_JUNIT_OUTPUT_FILE',
  'PLAYWRIGHT_JUNIT_OUTPUT_NAME',
  'PLAYWRIGHT_BLOB_OUTPUT_DIR',
  'PLAYWRIGHT_BLOB_OUTPUT_FILE',
  'PLAYWRIGHT_BLOB_OUTPUT_NAME',
  'PW_TEST_HTML_REPORT_OPEN',
]);
export const UX01_PACKAGED_SCREENSHOTS = Object.freeze([
  'screenshots/default-illustration.png',
  'screenshots/minimum-illustration.png',
  'screenshots/minimum-sprite.png',
  'screenshots/minimum-map.png',
]);
export const UX01_PACKAGED_FILES = Object.freeze({
  ownerConnection: 'mcp-owner-connection.json',
  evidence: 'ux01-density-evidence.json',
  failure: 'ux01-density-failure.json',
  cleanup: 'ux01-density-cleanup.json',
  forbiddenNetwork: 'ux01-forbidden-network.json',
  providerCredentials: join('credentials', 'generation.json'),
  tokenCredentials: join('credentials', 'mcp-token.json'),
});

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for the retained UX-01 exact-package acceptance.`);
  return value;
}

function declaredSha256(environment, name) {
  const value = required(environment, name).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(value)) throw new Error(`${name} must be one exact SHA-256 digest.`);
  return value;
}

export function resolveUx01PackagedAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const retainedFailureRoot = resolve(workspace, 'test-results', 'retained-failures');
  const profile = resolve(required(environment, UX01_PACKAGED_PROFILE_ENV));
  const nested = relative(retainedRoot, profile);
  const leaf = basename(profile);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(profile) !== retainedRoot || !leaf.startsWith(UX01_PACKAGED_PROFILE_PREFIX)) {
    throw new Error(`${UX01_PACKAGED_PROFILE_ENV} must be a fresh ${UX01_PACKAGED_PROFILE_PREFIX}* direct child of test-results/retained.`);
  }
  const runId = leaf.slice(UX01_PACKAGED_PROFILE_PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${UX01_PACKAGED_PROFILE_ENV} must end in an 8-80 character lowercase run identifier.`);
  }
  const failureRoot = resolve(required(environment, UX01_PACKAGED_FAILURE_ROOT_ENV));
  const failureNested = relative(retainedFailureRoot, failureRoot);
  if (!failureNested || failureNested.startsWith('..') || isAbsolute(failureNested)
    || dirname(failureRoot) !== retainedFailureRoot
    || basename(failureRoot) !== `${UX01_PACKAGED_FAILURE_PREFIX}${runId}`) {
    throw new Error(`${UX01_PACKAGED_FAILURE_ROOT_ENV} must be the matching fresh ${UX01_PACKAGED_FAILURE_PREFIX}${runId} direct child of test-results/retained-failures.`);
  }
  const paths = Object.fromEntries(Object.entries(UX01_PACKAGED_FILES).map(([key, file]) => [key, join(profile, file)]));
  return {
    workspace,
    retainedRoot,
    retainedFailureRoot,
    profile,
    runId,
    failureRoot,
    playwrightOutput: join(failureRoot, 'playwright'),
    executableSha256: declaredSha256(environment, UX01_PACKAGED_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, UX01_PACKAGED_ASAR_HASH_ENV),
    paths,
    screenshots: UX01_PACKAGED_SCREENSHOTS.map((file) => join(profile, file)),
  };
}

export function assertUx01SafeReporterEnvironment(environment = process.env) {
  const configured = UX01_UNSAFE_REPORT_ENVIRONMENTS.filter((name) => String(environment[name] ?? '').trim());
  if (configured.length) {
    throw new Error(`UX-01 native acceptance rejects credential-capable Playwright report configuration: ${configured.join(', ')}.`);
  }
  return true;
}

export function inspectUx01EncryptedToken(value, liveToken) {
  try {
    return inspectPackagedMcpCredential(value, liveToken);
  } catch {
    throw new Error('The UX-01 MCP credential is not the expected encrypted safe-storage record.');
  }
}

export function parseUx01WindowMeasurement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The UX-01 renderer did not return a native window measurement.');
  }
  const location = String(value.location ?? '');
  const content = value.content;
  const outer = value.outer;
  const screen = value.screen;
  const layout = value.layout;
  if (!location.startsWith('aidraw://app/')
    || !content || typeof content !== 'object'
    || !outer || typeof outer !== 'object'
    || !screen || typeof screen !== 'object'
    || !layout || typeof layout !== 'object') {
    throw new Error('The UX-01 window measurement is not from the exact trusted AIDraw renderer.');
  }
  const root = layout.root;
  const body = layout.body;
  if (!root || typeof root !== 'object' || !body || typeof body !== 'object') {
    throw new Error('The UX-01 renderer returned incomplete root-layout geometry.');
  }
  const fields = {
    contentWidth: Number(content.width),
    contentHeight: Number(content.height),
    devicePixelRatio: Number(content.devicePixelRatio),
    outerWidth: Number(outer.width),
    outerHeight: Number(outer.height),
    outerX: Number(outer.x),
    outerY: Number(outer.y),
    screenWidth: Number(screen.width),
    screenHeight: Number(screen.height),
    screenAvailLeft: Number(screen.availLeft),
    screenAvailTop: Number(screen.availTop),
    screenAvailWidth: Number(screen.availWidth),
    screenAvailHeight: Number(screen.availHeight),
    rootClientWidth: Number(root.clientWidth),
    rootClientHeight: Number(root.clientHeight),
    rootScrollWidth: Number(root.scrollWidth),
    rootScrollHeight: Number(root.scrollHeight),
    bodyClientWidth: Number(body.clientWidth),
    bodyClientHeight: Number(body.clientHeight),
    bodyScrollWidth: Number(body.scrollWidth),
    bodyScrollHeight: Number(body.scrollHeight),
  };
  const integerDimensions = [
    fields.contentWidth, fields.contentHeight, fields.outerWidth, fields.outerHeight,
    fields.screenWidth, fields.screenHeight, fields.screenAvailWidth, fields.screenAvailHeight,
    fields.rootClientWidth, fields.rootClientHeight, fields.rootScrollWidth, fields.rootScrollHeight,
    fields.bodyClientWidth, fields.bodyClientHeight, fields.bodyScrollWidth, fields.bodyScrollHeight,
  ];
  const integerPositions = [fields.outerX, fields.outerY, fields.screenAvailLeft, fields.screenAvailTop];
  if (!integerDimensions.every((entry) => Number.isInteger(entry) && entry > 0 && entry <= 32_768)
    || !integerPositions.every((entry) => Number.isInteger(entry) && Math.abs(entry) <= 32_768)
    || !Number.isFinite(fields.devicePixelRatio)
    || fields.devicePixelRatio <= 0
    || fields.devicePixelRatio > 16
    || fields.outerWidth < fields.contentWidth
    || fields.outerHeight < fields.contentHeight
    || fields.screenAvailWidth > fields.screenWidth
    || fields.screenAvailHeight > fields.screenHeight
    || fields.rootClientWidth !== fields.contentWidth
    || fields.rootClientHeight !== fields.contentHeight
    || fields.bodyClientWidth !== fields.contentWidth
    || fields.bodyClientHeight !== fields.contentHeight
    || fields.rootScrollWidth < fields.rootClientWidth
    || fields.rootScrollHeight < fields.rootClientHeight
    || fields.bodyScrollWidth < fields.bodyClientWidth
    || fields.bodyScrollHeight < fields.bodyClientHeight) {
    throw new Error('The UX-01 renderer returned invalid native outer/content window geometry.');
  }
  return {
    location,
    content: { width: fields.contentWidth, height: fields.contentHeight, devicePixelRatio: fields.devicePixelRatio },
    outer: { x: fields.outerX, y: fields.outerY, width: fields.outerWidth, height: fields.outerHeight },
    screen: {
      width: fields.screenWidth,
      height: fields.screenHeight,
      availLeft: fields.screenAvailLeft,
      availTop: fields.screenAvailTop,
      availWidth: fields.screenAvailWidth,
      availHeight: fields.screenAvailHeight,
    },
    layout: {
      root: {
        clientWidth: fields.rootClientWidth,
        clientHeight: fields.rootClientHeight,
        scrollWidth: fields.rootScrollWidth,
        scrollHeight: fields.rootScrollHeight,
      },
      body: {
        clientWidth: fields.bodyClientWidth,
        clientHeight: fields.bodyClientHeight,
        scrollWidth: fields.bodyScrollWidth,
        scrollHeight: fields.bodyScrollHeight,
      },
    },
  };
}

export function assertUx01ContentSizeRequest(width, height) {
  if (![width, height].every((entry) => Number.isInteger(entry) && entry >= 320 && entry <= 8_192)) {
    throw new Error('The UX-01 renderer content-size request must contain bounded integer dimensions.');
  }
  return { width, height };
}

export function parseUx01OwnedProcesses(processTable, profilePath) {
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

export function redactUx01FailureText(value, secrets = []) {
  let text = String(value ?? '').slice(0, 16_384);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|token)\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]');
}

export function assertUx01EvidenceRedacted(serialized, forbiddenValues = []) {
  const text = String(serialized);
  if (/"(?:token|authorization)"\s*:/i.test(text) || /Bearer\s+(?!\[redacted\])[^\s"']+/i.test(text)) {
    throw new Error('UX-01 retained evidence contains a credential-shaped field or bearer value.');
  }
  const leaked = forbiddenValues.filter((value) => value && text.includes(value));
  if (leaked.length) throw new Error('UX-01 retained evidence contains a declared secret value.');
  return true;
}

import { writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import {
  assertUx01EvidenceRedacted,
  parseUx01OwnedProcesses,
  redactUx01FailureText,
  UX01_UNSAFE_REPORT_ENVIRONMENTS,
} from './ux01-packaged-acceptance.mjs';

export const UX09_TEXT_REFLOW_SCENARIO = 'UX-09-TEXT-REFLOW exact package keeps the 200-percent primary pixel workspace reachable';
export const UX09_TEXT_REFLOW_MECHANISM = 'Playwright trusted-renderer inline documentElement.style.fontSize = 32px after app-shell readiness';
export const UX09_TEXT_REFLOW_PROFILE_ENV = 'AIDRAW_E2E_UX09_TEXT_REFLOW_PROFILE';
export const UX09_TEXT_REFLOW_FAILURE_ROOT_ENV = 'AIDRAW_E2E_UX09_TEXT_REFLOW_FAILURE_ROOT';
export const UX09_TEXT_REFLOW_EXE_HASH_ENV = 'AIDRAW_E2E_UX09_TEXT_REFLOW_EXE_SHA256';
export const UX09_TEXT_REFLOW_ASAR_HASH_ENV = 'AIDRAW_E2E_UX09_TEXT_REFLOW_ASAR_SHA256';
export const UX09_TEXT_REFLOW_PACKAGE_PREFIX = 'ux09-text-reflow-';
export const UX09_TEXT_REFLOW_PROFILE_PREFIX = 'aidraw-e2e-ux09-text-reflow-';
export const UX09_TEXT_REFLOW_FAILURE_PREFIX = 'ux09-text-reflow-native-';
export const UX09_TEXT_REFLOW_FILES = Object.freeze({
  ownerConnection: 'mcp-owner-connection.json',
  evidence: 'ux09-text-reflow-evidence.json',
  failure: 'ux09-text-reflow-failure.json',
  cleanup: 'ux09-text-reflow-cleanup.json',
  forbiddenNetwork: 'ux09-text-reflow-forbidden-network.json',
  retiredProviderStore: join('credentials', 'generation.json'),
  retiredAuthorityStore: join('credentials', 'mcp-token.json'),
});
export const UX09_TEXT_REFLOW_SCREENSHOTS = Object.freeze([
  'screenshots/minimum-root32-overview.png',
  'screenshots/minimum-root32-inspector.png',
  'screenshots/minimum-root32-timeline-edit.png',
]);
export const UX09_TEXT_REFLOW_UNSAFE_REPORT_ENVIRONMENTS = UX01_UNSAFE_REPORT_ENVIRONMENTS;

const UX09_TEXT_REFLOW_CHILD_ENVIRONMENTS = Object.freeze([
  'HOME', 'LOGNAME', 'USER', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING',
  'AIDRAW_E2E_LAUNCH_CONTEXT', 'AIDRAW_E2E_OUT_DIR', 'AIDRAW_E2E_PLATFORM', 'AIDRAW_E2E_ARCH',
  'AIDRAW_E2E_EXECUTABLE', 'AIDRAW_E2E_ASAR',
  UX09_TEXT_REFLOW_PROFILE_ENV, UX09_TEXT_REFLOW_FAILURE_ROOT_ENV,
  UX09_TEXT_REFLOW_EXE_HASH_ENV, UX09_TEXT_REFLOW_ASAR_HASH_ENV,
]);

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for the retained UX-09 text-reflow acceptance.`);
  return value;
}

function declaredSha256(environment, name) {
  const value = required(environment, name).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(value)) throw new Error(`${name} must be one exact SHA-256 digest.`);
  return value;
}

function directChildWithPrefix(root, candidate, prefix, environmentName) {
  const nested = relative(root, candidate);
  const leaf = basename(candidate);
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || dirname(candidate) !== root || !leaf.startsWith(prefix)) {
    throw new Error(`${environmentName} must be a fresh ${prefix}* direct child of ${relative(process.cwd(), root) || root}.`);
  }
  return leaf.slice(prefix.length);
}

export function resolveUx09TextReflowAcceptance({ workspacePath = process.cwd(), environment = process.env } = {}) {
  const workspace = resolve(workspacePath);
  const preparedRoot = resolve(workspace, 'test-results', 'prepared-packages');
  const retainedRoot = resolve(workspace, 'test-results', 'retained');
  const retainedFailureRoot = resolve(workspace, 'test-results', 'retained-failures');
  const packageRoot = resolve(workspace, required(environment, 'AIDRAW_E2E_OUT_DIR'));
  const profile = resolve(required(environment, UX09_TEXT_REFLOW_PROFILE_ENV));
  const failureRoot = resolve(required(environment, UX09_TEXT_REFLOW_FAILURE_ROOT_ENV));
  const runId = directChildWithPrefix(retainedRoot, profile, UX09_TEXT_REFLOW_PROFILE_PREFIX, UX09_TEXT_REFLOW_PROFILE_ENV);
  if (!/^[a-z0-9](?:[a-z0-9-]{6,78}[a-z0-9])$/.test(runId)) {
    throw new Error(`${UX09_TEXT_REFLOW_PROFILE_ENV} must end in an 8-80 character lowercase run identifier.`);
  }
  if (directChildWithPrefix(preparedRoot, packageRoot, UX09_TEXT_REFLOW_PACKAGE_PREFIX, 'AIDRAW_E2E_OUT_DIR') !== runId) {
    throw new Error(`AIDRAW_E2E_OUT_DIR must be the matching fresh ${UX09_TEXT_REFLOW_PACKAGE_PREFIX}${runId} direct child of test-results/prepared-packages.`);
  }
  if (directChildWithPrefix(retainedFailureRoot, failureRoot, UX09_TEXT_REFLOW_FAILURE_PREFIX, UX09_TEXT_REFLOW_FAILURE_ROOT_ENV) !== runId) {
    throw new Error(`${UX09_TEXT_REFLOW_FAILURE_ROOT_ENV} must be the matching fresh ${UX09_TEXT_REFLOW_FAILURE_PREFIX}${runId} direct child of test-results/retained-failures.`);
  }
  const paths = Object.fromEntries(Object.entries(UX09_TEXT_REFLOW_FILES).map(([key, file]) => [key, join(profile, file)]));
  return {
    workspace,
    preparedRoot,
    retainedRoot,
    retainedFailureRoot,
    packageRoot,
    generationMarker: join(packageRoot, '.aidraw-package-generation.json'),
    profile,
    runId,
    failureRoot,
    playwrightOutput: join(failureRoot, 'playwright'),
    executableSha256: declaredSha256(environment, UX09_TEXT_REFLOW_EXE_HASH_ENV),
    asarSha256: declaredSha256(environment, UX09_TEXT_REFLOW_ASAR_HASH_ENV),
    paths,
    screenshots: UX09_TEXT_REFLOW_SCREENSHOTS.map((file) => join(profile, file)),
  };
}

export function assertUx09TextReflowSafeReporterEnvironment(environment = process.env) {
  const configured = UX09_TEXT_REFLOW_UNSAFE_REPORT_ENVIRONMENTS.filter((name) => String(environment[name] ?? '').trim());
  if (configured.length) {
    throw new Error(`UX-09 text-reflow acceptance rejects secret-bearing Playwright report configuration: ${configured.join(', ')}.`);
  }
  return true;
}

export function buildUx09TextReflowChildEnvironment(environment = process.env) {
  const childEnvironment = {};
  for (const name of UX09_TEXT_REFLOW_CHILD_ENVIRONMENTS) {
    const value = environment[name];
    if (typeof value === 'string' && value) childEnvironment[name] = value;
  }
  childEnvironment.AIDRAW_E2E_UX09_TEXT_REFLOW_WRAPPER = '1';
  childEnvironment.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  return childEnvironment;
}

export function parseUx09OwnedProcesses(processTable, profilePath) {
  return parseUx01OwnedProcesses(processTable, profilePath);
}

export function hasExactUx09ProcessShape(rows, expectedOwnerPid) {
  const browsers = rows.filter((entry) => entry.type === 'browser');
  const renderers = rows.filter((entry) => entry.type === 'renderer');
  return browsers.length === 1
    && browsers[0].pid === expectedOwnerPid
    && renderers.length === 1
    && renderers[0].ppid === expectedOwnerPid;
}

export async function exerciseUx09ScrollBoundaries(element, axis) {
  if (!['x', 'y', 'both'].includes(axis)) throw new Error(`Unsupported UX-09 scroll axis ${JSON.stringify(axis)}.`);
  const originalX = Number(element.scrollLeft);
  const originalY = Number(element.scrollTop);
  const scrollWidth = Number(element.scrollWidth);
  const scrollHeight = Number(element.scrollHeight);
  const clientWidth = Number(element.clientWidth);
  const clientHeight = Number(element.clientHeight);
  const dimensions = { originalX, originalY, scrollWidth, scrollHeight, clientWidth, clientHeight };
  const diagnosticDimensions = Object.fromEntries(Object.entries(dimensions).map(([name, value]) => [
    name,
    Number.isFinite(value) ? value : String(value),
  ]));
  for (const [name, value] of Object.entries(dimensions)) {
    if (!Number.isFinite(value)) {
      throw new Error(`UX-09 scroll boundary ${name} must be finite. Diagnostics: ${JSON.stringify({ axis, dimensions: diagnosticDimensions })}.`);
    }
  }
  const maxX = Math.max(0, scrollWidth - clientWidth);
  const maxY = Math.max(0, scrollHeight - clientHeight);
  const boundaryDiagnostics = JSON.stringify({ axis, dimensions: diagnosticDimensions, maxX, maxY });
  const maximumSamples = 80;
  const waitForAnimationSample = () => new Promise((resolveSample) => {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      globalThis.setTimeout(resolveSample, 0);
      return;
    }
    let settled = false;
    let frame = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(frame);
      resolveSample();
    };
    const timer = globalThis.setTimeout(finish, 25);
    frame = globalThis.requestAnimationFrame(finish);
  });
  const converge = async (property, target, label) => {
    element[property] = target;
    let observed = Number(element[property]);
    for (let sample = 0; sample < maximumSamples && (!Number.isFinite(observed) || observed !== target); sample += 1) {
      await waitForAnimationSample();
      observed = Number(element[property]);
    }
    if (!Number.isFinite(observed) || observed !== target) {
      throw new Error(`UX-09 ${label} did not converge to ${target} after ${maximumSamples} bounded samples (last ${String(observed)}). Diagnostics: ${boundaryDiagnostics}.`);
    }
    return observed;
  };
  let startX = originalX;
  let endX = originalX;
  let startY = originalY;
  let endY = originalY;
  let endpointFailure;
  try {
    if (axis === 'x' || axis === 'both') {
      startX = await converge('scrollLeft', 0, 'horizontal start endpoint');
      endX = await converge('scrollLeft', maxX, 'horizontal end endpoint');
    }
    if (axis === 'y' || axis === 'both') {
      startY = await converge('scrollTop', 0, 'vertical start endpoint');
      endY = await converge('scrollTop', maxY, 'vertical end endpoint');
    }
  } catch (error) {
    endpointFailure = error instanceof Error ? error : new Error(String(error));
  }
  let restoredX = Number(element.scrollLeft);
  let restoredY = Number(element.scrollTop);
  const restorationFailures = [];
  try {
    restoredX = await converge('scrollLeft', originalX, 'horizontal restoration');
  } catch (error) {
    restorationFailures.push(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    restoredY = await converge('scrollTop', originalY, 'vertical restoration');
  } catch (error) {
    restorationFailures.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (restorationFailures.length) {
    const endpointContext = endpointFailure ? ` Endpoint exercise also failed: ${endpointFailure.message}` : '';
    throw new Error(`UX-09 scroll position restoration failed: ${restorationFailures.map((error) => error.message).join(' ')}${endpointContext}`);
  }
  if (endpointFailure) throw endpointFailure;
  return {
    originalX,
    originalY,
    boundaryDimensions: { scrollWidth, scrollHeight, clientWidth, clientHeight },
    maxX,
    maxY,
    startX,
    endX,
    startY,
    endY,
    restoredX,
    restoredY,
    reachedStartX: startX === 0,
    reachedEndX: endX === maxX,
    reachedStartY: startY === 0,
    reachedEndY: endY === maxY,
  };
}

export function assertUx09LocalAxisReachability(metric, options = {}) {
  const requireMovement = options.requireMovement !== false;
  const admitContainedZeroRange = options.admitContainedZeroRange === true;
  const layoutBefore = metric.layoutBefore;
  const layoutAfter = metric.layoutAfter;
  const requestedAxes = layoutAfter?.axis === 'both' ? ['x', 'y'] : [layoutAfter?.axis];
  const diagnostics = {
    layoutBefore: layoutBefore ?? null,
    boundary: {
      dimensions: metric.boundaryDimensions ?? null,
      originalX: metric.originalX,
      originalY: metric.originalY,
      maxX: metric.maxX,
      maxY: metric.maxY,
      startX: metric.startX,
      endX: metric.endX,
      startY: metric.startY,
      endY: metric.endY,
      restoredX: metric.restoredX,
      restoredY: metric.restoredY,
      reachedStartX: metric.reachedStartX,
      reachedEndX: metric.reachedEndX,
      reachedStartY: metric.reachedStartY,
      reachedEndY: metric.reachedEndY,
    },
    layoutAfter: layoutAfter ?? null,
  };
  const fail = (reason) => {
    throw new Error(`UX-09 ${layoutAfter?.selector ?? layoutBefore?.selector ?? 'unknown-surface'} local-axis admission failed: ${reason}. Diagnostics: ${JSON.stringify(diagnostics)}.`);
  };
  const layoutNumberFields = ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'];
  for (const [label, layout] of [['before', layoutBefore], ['after', layoutAfter]]) {
    if (!layout || typeof layout !== 'object') fail(`${label} layout sample is absent`);
    if (!['x', 'y', 'both'].includes(layout.axis)) fail(`${label} layout axis is unsupported`);
    if (typeof layout.selector !== 'string' || !layout.selector) fail(`${label} layout selector is absent`);
    if (typeof layout.overflowX !== 'string' || typeof layout.overflowY !== 'string') fail(`${label} overflow policy is indeterminate`);
    for (const name of layoutNumberFields) {
      if (!Number.isFinite(layout[name])) fail(`${label} layout ${name} must be finite`);
    }
    if (layout.clientWidth <= 0 || layout.clientHeight <= 0 || layout.scrollWidth < 0 || layout.scrollHeight < 0) {
      fail(`${label} layout dimensions must describe a positive client area and nonnegative scroll extent`);
    }
  }
  if (layoutBefore.selector !== layoutAfter.selector || layoutBefore.axis !== layoutAfter.axis
    || layoutBefore.overflowX !== layoutAfter.overflowX || layoutBefore.overflowY !== layoutAfter.overflowY
    || layoutNumberFields.some((name) => layoutBefore[name] !== layoutAfter[name])) {
    fail('layout dimensions or overflow policy changed between the pre-probe and post-restoration samples');
  }
  const rectangleStable = (before, after) => before && after
    && ['left', 'right', 'top', 'bottom'].every((edge) => Number.isFinite(before[edge])
      && Number.isFinite(after[edge]) && Math.abs(before[edge] - after[edge]) <= 0.5);
  const containmentStable = (before, after) => {
    if (!before && !after) return true;
    if (!before || !after) return false;
    if (!rectangleStable(before.viewport, after.viewport)
      || !rectangleStable(before.scrollport, after.scrollport)
      || !rectangleStable(before.visibleScrollport, after.visibleScrollport)
      || !Array.isArray(before.clippingAncestors) || !Array.isArray(after.clippingAncestors)
      || before.clippingAncestors.length !== after.clippingAncestors.length
      || !Array.isArray(before.children) || !Array.isArray(after.children)
      || before.children.length !== after.children.length) return false;
    const ancestorsStable = before.clippingAncestors.every((entry, index) => {
      const later = after.clippingAncestors[index];
      return entry.label === later.label && entry.overflowX === later.overflowX
        && entry.overflowY === later.overflowY && rectangleStable(entry.rect, later.rect);
    });
    const childrenStable = before.children.every((entry, index) => {
      const later = after.children[index];
      return entry.index === later.index && entry.label === later.label && entry.flexShrink === later.flexShrink
        && entry.rendered === later.rendered && rectangleStable(entry.rect, later.rect);
    });
    return ancestorsStable && childrenStable;
  };
  if (!containmentStable(layoutBefore.containment, layoutAfter.containment)) {
    fail('containment geometry changed between the pre-probe and post-restoration samples');
  }
  const boundaryDimensions = metric.boundaryDimensions;
  if (!boundaryDimensions || layoutNumberFields.some((name) => !Number.isFinite(boundaryDimensions[name]))) {
    fail('boundary-probe dimensions are absent or nonfinite');
  }
  if (layoutNumberFields.some((name) => boundaryDimensions[name] !== layoutAfter[name])) {
    fail('boundary-probe dimensions disagree with the stable post-restoration layout');
  }
  const boundaryNumbers = ['originalX', 'originalY', 'maxX', 'maxY', 'startX', 'endX', 'startY', 'endY', 'restoredX', 'restoredY'];
  for (const name of boundaryNumbers) {
    if (!Number.isFinite(metric[name])) fail(`boundary ${name} must be finite`);
  }
  const derivedMaxX = Math.max(0, layoutAfter.scrollWidth - layoutAfter.clientWidth);
  const derivedMaxY = Math.max(0, layoutAfter.scrollHeight - layoutAfter.clientHeight);
  if (metric.maxX !== derivedMaxX || metric.maxY !== derivedMaxY) {
    fail('declared boundary range disagrees with the stable client/scroll dimensions');
  }
  if (metric.originalX < 0 || metric.originalX > metric.maxX || metric.originalY < 0 || metric.originalY > metric.maxY) {
    fail('original scroll position is outside the declared range');
  }
  if (metric.restoredX !== metric.originalX || metric.restoredY !== metric.originalY) {
    fail('the exact original scroll position was not restored');
  }
  const endpointBooleans = [
    ['reachedStartX', metric.reachedStartX, metric.startX === 0],
    ['reachedEndX', metric.reachedEndX, metric.endX === metric.maxX],
    ['reachedStartY', metric.reachedStartY, metric.startY === 0],
    ['reachedEndY', metric.reachedEndY, metric.endY === metric.maxY],
  ];
  for (const [name, actual, expected] of endpointBooleans) {
    if (typeof actual !== 'boolean' || actual !== expected) fail(`${name} contradicts its numeric endpoint`);
  }

  const dispositions = { x: 'not-requested', y: 'not-requested' };
  for (const requestedAxis of requestedAxes) {
    const horizontal = requestedAxis === 'x';
    const label = horizontal ? 'horizontal' : 'vertical';
    const policy = horizontal ? layoutAfter.overflowX : layoutAfter.overflowY;
    const maximum = horizontal ? metric.maxX : metric.maxY;
    const original = horizontal ? metric.originalX : metric.originalY;
    const start = horizontal ? metric.startX : metric.startY;
    const end = horizontal ? metric.endX : metric.endY;
    if (!/(?:auto|scroll)/.test(policy)) fail(`${label} overflow policy must remain auto or scroll`);
    if (start !== 0 || end !== maximum) fail(`${label} numeric endpoints do not equal the exact requested start and end`);
    if (!requireMovement) {
      dispositions[requestedAxis] = 'policy-only';
      continue;
    }
    if (maximum > 0) {
      dispositions[requestedAxis] = 'scrollable';
      continue;
    }
    if (maximum !== 0) fail(`${label} maximum range must be zero or positive`);
    if (!admitContainedZeroRange) fail(`${label} movement is required but the range is zero`);
    if (original !== 0) fail(`${label} zero-range state has a nonzero original position`);
    const containment = layoutAfter.containment;
    if (!containment || typeof containment !== 'object') fail(`${label} zero-range containment geometry is absent`);
    const rectangles = [containment.viewport, containment.scrollport, containment.visibleScrollport];
    for (const rectangle of rectangles) {
      if (!rectangle || Object.values(rectangle).some((value) => !Number.isFinite(value))) {
        fail(`${label} zero-range containment geometry is nonfinite`);
      }
    }
    if (containment.scrollport.right <= containment.scrollport.left
      || containment.scrollport.bottom <= containment.scrollport.top
      || containment.visibleScrollport.right <= containment.visibleScrollport.left
      || containment.visibleScrollport.bottom <= containment.visibleScrollport.top) {
      fail(`${label} zero-range visible scrollport is empty`);
    }
    if (!isUx09RectContained(containment.scrollport, containment.visibleScrollport, 0.5)) {
      fail(`${label} zero-range scrollport is clipped by the viewport or an ancestor`);
    }
    if (!Array.isArray(containment.children) || containment.children.length === 0) {
      fail(`${label} zero-range direct-child geometry is absent`);
    }
    if (containment.children.some((child) => !Number.isFinite(child.flexShrink))) {
      fail(`${label} zero-range child shrink state is indeterminate`);
    }
    const relevantChildren = containment.children.filter((child) => child.flexShrink === 0);
    if (relevantChildren.length === 0) fail(`${label} zero-range state has no non-shrinking context child to prove`);
    const clippedChildren = relevantChildren.filter((child) => !child.rendered
      || !child.rect
      || Object.values(child.rect).some((value) => !Number.isFinite(value))
      || child.rect.right <= child.rect.left
      || child.rect.bottom <= child.rect.top
      || !isUx09RectContained(child.rect, containment.visibleScrollport, 0.5));
    if (clippedChildren.length) {
      fail(`${label} zero-range state has clipped or hidden non-shrinking children ${clippedChildren.map((child) => child.label).join(', ')}`);
    }
    dispositions[requestedAxis] = 'contained-zero-range';
  }
  return dispositions;
}

export function isUx09RectContained(inner, outer, tolerance = 1) {
  return inner.left >= outer.left - tolerance
    && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance
    && inner.bottom <= outer.bottom + tolerance;
}

export function isUx09ExactTextFit({ text, expected, clientWidth, scrollWidth }) {
  return text === expected
    && Number.isFinite(clientWidth)
    && clientWidth > 0
    && Number.isFinite(scrollWidth)
    && scrollWidth <= clientWidth;
}

export function classifyUx09RendererRequest(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { permitted: false, descriptor: 'invalid-url', reason: 'renderer request is not a valid URL' };
  }
  const query = url.search ? '?[query-redacted]' : '';
  const descriptor = `${url.protocol}//${url.host}${url.pathname}${query}`;
  const indexPath = url.pathname === '/' || url.pathname === '/index.html';
  const exactIndexQuery = url.search === '' || (url.search === '?native-titlebar=hidden-inset' && indexPath);
  const generatedAssetPath = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(url.pathname);
  const permitted = url.protocol === 'aidraw:'
    && url.hostname === 'app'
    && !url.port
    && !url.username
    && !url.password
    && !url.hash
    && ((indexPath && exactIndexQuery) || (generatedAssetPath && url.search === ''));
  return {
    permitted,
    descriptor,
    reason: permitted
      ? 'exact packaged aidraw://app document or generated asset'
      : 'not an admitted packaged aidraw://app document or generated asset',
  };
}

export async function writeUx09ExclusiveRecord(path, serialized) {
  await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export function redactUx09FailureText(value, secrets = []) {
  return redactUx01FailureText(value, secrets);
}

export function assertUx09EvidenceRedacted(serialized, forbiddenValues = []) {
  return assertUx01EvidenceRedacted(serialized, forbiddenValues);
}

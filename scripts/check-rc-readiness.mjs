import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

const execute = promisify(execFile);
const STATUS_VALUES = new Set(['✅ Verified', '🟢 Working', '🟡 Partial', '🟠 Scaffolded', '⬜ Missing', '⏸ Deferred']);
const PRIORITY_VALUES = new Set(['P0', 'P1', 'P2', 'P3']);
const PASS = 'PASS';
const LEVEL3_COMMAND = 'node scripts/npm-node24.mjs run test:level3:auto';
const REQUIRED_ARTIFACTS = Object.freeze([
  'windows-x64:squirrel',
  'windows-x64:zip',
  'windows-x64:checksums',
  'macos-arm64:dmg',
  'macos-arm64:zip',
  'macos-arm64:checksums',
  'linux-x64:deb',
  'linux-x64:rpm',
  'linux-x64:zip',
  'linux-x64:checksums',
  'all:licenses-json',
  'all:licenses-markdown',
]);
const RECONCILIATION_KEYS = Object.freeze(['readme', 'featureTracker', 'changelog', 'knownLimitations']);
const NATIVE_PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);
const REPRODUCIBILITY_PLATFORMS = Object.freeze(['windows-x64', 'macos-arm64', 'linux-x64']);

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
function isCommit(value) { return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value); }
function issue(rank, code, message, scope = 'both', trackerIds = []) { return { rank, code, message, scope, trackerIds }; }
function sortIssues(issues) { return issues.sort((left, right) => left.rank - right.rank || compare(left.code, right.code) || compare(left.message, right.message)); }

export function parseFeatureTracker(markdown) {
  const items = [];
  const errors = [];
  const ids = new Set();
  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    if (!/^\|\s*[A-Z][A-Z0-9]*-\d+\s*\|/u.test(line)) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    if (cells.length !== 5) {
      errors.push(`Line ${index + 1} has ${cells.length} tracker cells; expected 5.`);
      continue;
    }
    const [id, feature, status, priority, truth] = cells;
    if (ids.has(id)) errors.push(`Duplicate tracker ID ${id} on line ${index + 1}.`);
    else ids.add(id);
    if (!feature) errors.push(`Tracker item ${id} has no feature name.`);
    if (!STATUS_VALUES.has(status)) errors.push(`Tracker item ${id} has unknown status ${JSON.stringify(status)}.`);
    if (!PRIORITY_VALUES.has(priority)) errors.push(`Tracker item ${id} has unknown priority ${JSON.stringify(priority)}.`);
    if (!truth) errors.push(`Tracker item ${id} has no current-truth/exit-criteria text.`);
    items.push({ id, feature, status, priority, truth });
  }
  if (!items.length) errors.push('No feature-tracker rows were found.');
  return { items, errors };
}

function pathIsContained(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !fromRoot.startsWith('/') && !fromRoot.startsWith('\\'));
}

async function resolveContainedFile(cwd, path, role, maximumBytes) {
  if (typeof path !== 'string' || !path || path.includes('\\') || resolve(path) === path) throw new Error(`${role} path must be a nonempty repository-relative slash path.`);
  const root = await realpath(cwd);
  const absolute = resolve(root, path);
  if (!pathIsContained(root, absolute)) throw new Error(`${role} path escapes the repository root.`);
  const linkInfo = await lstat(absolute);
  if (linkInfo.isSymbolicLink()) throw new Error(`${role} must not be a symbolic link.`);
  const resolved = await realpath(absolute);
  if (!pathIsContained(root, resolved)) throw new Error(`${role} resolves outside the repository root.`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${role} must be a regular file.`);
  if (maximumBytes !== undefined && info.size > maximumBytes) throw new Error(`${role} exceeds the ${maximumBytes}-byte inspection limit.`);
  return { absolute: resolved, size: info.size };
}

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

async function inspectHashedFile(cwd, entry, role, maximumBytes) {
  if (!isRecord(entry) || typeof entry.path !== 'string' || !isSha256(entry.sha256)) return { error: `${role} must provide a repository-relative path and full SHA-256.` };
  try {
    const file = await resolveContainedFile(cwd, entry.path, role, maximumBytes);
    const actualSha256 = await sha256File(file.absolute);
    if (actualSha256 !== entry.sha256.toLowerCase()) return { error: `${role} SHA-256 mismatch for ${entry.path}.` };
    return { path: entry.path, sha256: actualSha256, size: file.size, absolute: file.absolute };
  } catch (error) {
    return { error: `${role}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeReport(markdown) { return markdown.replaceAll('`', '').replaceAll('*', ''); }

function inspectReportText(markdown, commit) {
  const report = normalizeReport(markdown);
  const errors = [];
  if (!/-\s*Overall:\s*PASS\b/iu.test(report)) errors.push('report does not declare Overall: PASS');
  if (!/-\s*Level:\s*3\b/iu.test(report)) errors.push('report does not declare Level: 3');
  if (!report.toLowerCase().includes(commit.toLowerCase())) errors.push('report does not contain the candidate commit');
  if (!report.includes(LEVEL3_COMMAND)) errors.push(`report does not contain the exact automated command ${LEVEL3_COMMAND}`);
  if (!/(?:authoritative[^\n]*exit|exit(?:\s+code)?)[^\n\d]*0\b/iu.test(report)) errors.push('report does not record automated exit 0');
  if (!/gpt-5\.6-luna/iu.test(report) || !/\bhigh\b/iu.test(report)) errors.push('report does not record the required gpt-5.6-luna/high independent tester');
  for (const [label, pattern] of [
    ['MCP evidence', /^##\s+.*MCP/im],
    ['Computer Use evidence', /^##\s+.*Computer Use/im],
    ['cross-surface evidence', /^##\s+.*Cross[- ]surface/im],
    ['coverage exceptions', /^##\s+.*Coverage exceptions/im],
    ['final gate decision', /^##\s+.*Final gate decision/im],
  ]) if (!pattern.test(report)) errors.push(`report has no ${label} section`);
  return errors;
}

function requirePass(issues, value, code, label, scope = 'both', rank = 1) {
  if (value !== PASS) issues.push(issue(rank, code, `${label} must be PASS; found ${JSON.stringify(value)}.`, scope));
}

function inspectDefects(issues, defects, trackerById) {
  if (!isRecord(defects)) {
    issues.push(issue(1, 'defects_missing', 'Evidence must include explicit Blocker, P0, and accepted P1 defect disposition.'));
    return;
  }
  for (const [key, label] of [['blocker', 'Blocker'], ['p0', 'P0']]) {
    if (!Array.isArray(defects[key])) issues.push(issue(1, `defects_${key}_invalid`, `${label} defects must be an explicit array.`));
    else if (defects[key].length) issues.push(issue(1, `defects_${key}_open`, `${label} defects remain open: ${defects[key].map(String).sort(compare).join(', ')}.`));
  }
  if (!Array.isArray(defects.p1Exceptions)) {
    issues.push(issue(1, 'defects_p1_invalid', 'P1 exceptions must be an explicit array, even when empty.'));
    return;
  }
  const seen = new Set();
  for (const [index, exception] of defects.p1Exceptions.entries()) {
    const prefix = `P1 exception ${index + 1}`;
    if (!isRecord(exception)) { issues.push(issue(1, 'defects_p1_exception_invalid', `${prefix} must be an object.`)); continue; }
    const trackerId = exception.trackerId;
    const item = typeof trackerId === 'string' ? trackerById.get(trackerId) : undefined;
    if (!item || item.priority !== 'P1') issues.push(issue(1, 'defects_p1_tracker_invalid', `${prefix} must link an existing P1 tracker ID.`));
    else if (seen.has(trackerId)) issues.push(issue(1, 'defects_p1_duplicate', `${prefix} duplicates tracker ID ${trackerId}.`, 'both', [trackerId]));
    else seen.add(trackerId);
    if (typeof exception.acceptedBy !== 'string' || !exception.acceptedBy.trim()) issues.push(issue(1, 'defects_p1_acceptance_missing', `${prefix} must name who accepted it.`));
    if (typeof exception.rationale !== 'string' || !exception.rationale.trim()) issues.push(issue(1, 'defects_p1_rationale_missing', `${prefix} must record its rationale.`));
  }
}

async function inspectReproducibilityReports(cwd, value, context) {
  const issues = [];
  if (!Array.isArray(value)) return [issue(3, 'stable_reproducibility_missing', 'Stable-v1 evidence must include per-platform reproducibility comparison reports.', 'stable-v1')];
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const label = `Reproducibility report ${index + 1}`;
    if (!isRecord(entry) || typeof entry.platform !== 'string') { issues.push(issue(3, 'stable_reproducibility_entry_invalid', `${label} must name its platform.`, 'stable-v1')); continue; }
    if (seen.has(entry.platform)) { issues.push(issue(3, 'stable_reproducibility_duplicate', `${label} duplicates ${entry.platform}.`, 'stable-v1')); continue; }
    seen.add(entry.platform);
    const file = await inspectHashedFile(cwd, entry, `${label} (${entry.platform})`, 4 * 1024 * 1024);
    if (file.error) { issues.push(issue(3, 'stable_reproducibility_file_invalid', file.error, 'stable-v1')); continue; }
    let report;
    try { report = JSON.parse(await readFile(file.absolute, 'utf8')); }
    catch (error) { issues.push(issue(3, 'stable_reproducibility_report_invalid', `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`, 'stable-v1')); continue; }
    const validManifestReference = (reference) => isRecord(reference) && typeof reference.path === 'string' && Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && isSha256(reference.sha256);
    const valid = isRecord(report)
      && report.schemaVersion === 1
      && report.result === 'PASS'
      && report.platform === entry.platform
      && isRecord(report.candidate)
      && report.candidate.version === context.packageVersion
      && typeof report.candidate.commit === 'string'
      && report.candidate.commit.toLowerCase() === context.repository.commit.toLowerCase()
      && report.sourceIdentityEqual === true
      && report.toolchainIdentityEqual === true
      && report.artifactInventoryEqual === true
      && Number.isSafeInteger(report.artifactCount)
      && report.artifactCount > 0
      && validManifestReference(report.leftManifest)
      && validManifestReference(report.rightManifest)
      && Array.isArray(report.differences)
      && report.differences.length === 0;
    if (!valid) issues.push(issue(3, 'stable_reproducibility_report_contract_invalid', `${label} does not prove an exact PASS for the current candidate and platform.`, 'stable-v1'));
  }
  const missing = REPRODUCIBILITY_PLATFORMS.filter((platform) => !seen.has(platform));
  if (missing.length) issues.push(issue(3, 'stable_reproducibility_matrix_incomplete', `Stable-v1 reproducibility reports are missing: ${missing.join(', ')}.`, 'stable-v1'));
  return issues;
}

async function inspectEvidence(cwd, evidence, context) {
  const issues = [];
  if (!isRecord(evidence)) return [issue(1, 'evidence_invalid', 'RC evidence must be a JSON object.')];
  if (evidence.schemaVersion !== 1) issues.push(issue(1, 'evidence_schema_unsupported', `Evidence schemaVersion must be 1; found ${JSON.stringify(evidence.schemaVersion)}.`));

  const candidate = evidence.candidate;
  if (!isRecord(candidate)) issues.push(issue(1, 'candidate_missing', 'Evidence must identify the exact candidate version and commit.'));
  else {
    if (candidate.version !== context.packageVersion) issues.push(issue(1, 'candidate_version_mismatch', `Evidence version ${JSON.stringify(candidate.version)} does not match package version ${context.packageVersion}.`));
    if (!isCommit(candidate.commit) || candidate.commit.toLowerCase() !== context.repository.commit.toLowerCase()) issues.push(issue(1, 'candidate_commit_mismatch', `Evidence commit ${JSON.stringify(candidate.commit)} does not match current HEAD ${context.repository.commit}.`));
    if (candidate.sourceClean !== true) issues.push(issue(1, 'candidate_not_declared_clean', 'Evidence must declare sourceClean: true for its exact committed subject.'));
  }

  const level3 = evidence.level3;
  if (!isRecord(level3)) issues.push(issue(1, 'level3_missing', 'Evidence must contain the independent Level 3 result.'));
  else {
    requirePass(issues, level3.result, 'level3_not_pass', 'Level 3 result');
    if (level3.independent !== true) issues.push(issue(1, 'level3_not_independent', 'Level 3 evidence must declare independent: true.'));
    if (!isRecord(level3.tester) || level3.tester.model !== 'gpt-5.6-luna' || level3.tester.reasoningEffort !== 'high') issues.push(issue(1, 'level3_tester_invalid', 'Level 3 tester must be gpt-5.6-luna with high reasoning.'));
    if (!isRecord(level3.automated) || level3.automated.command !== LEVEL3_COMMAND || level3.automated.exitCode !== 0) issues.push(issue(1, 'level3_automated_invalid', `Level 3 automation must record ${LEVEL3_COMMAND} with exitCode 0.`));
    requirePass(issues, level3.mcpResult, 'level3_mcp_not_pass', 'Level 3 MCP result');
    requirePass(issues, level3.computerUseResult, 'level3_computer_use_not_pass', 'Level 3 Computer Use result');
    requirePass(issues, level3.crossSurfaceResult, 'level3_cross_surface_not_pass', 'Level 3 cross-surface result');
    if (level3.mandatoryCoverageComplete !== true) issues.push(issue(1, 'level3_coverage_incomplete', 'Every mandatory Level 3 scenario must have evidence; mandatoryCoverageComplete is not true.'));
    const reportResult = await inspectHashedFile(cwd, level3.report, 'Level 3 report', 4 * 1024 * 1024);
    if (reportResult.error) issues.push(issue(1, 'level3_report_invalid', reportResult.error));
    else {
      const markdown = await readFile(reportResult.absolute, 'utf8');
      const reportErrors = inspectReportText(markdown, context.repository.commit);
      if (reportErrors.length) issues.push(issue(1, 'level3_report_contract_invalid', `Level 3 report contract failed: ${reportErrors.join('; ')}.`));
    }
  }

  inspectDefects(issues, evidence.defects, context.trackerById);

  if (!isRecord(evidence.reconciliation)) issues.push(issue(4, 'reconciliation_missing', 'Evidence must reconcile README, tracker, changelog, and known limitations.'));
  else for (const key of RECONCILIATION_KEYS) if (evidence.reconciliation[key] !== true) issues.push(issue(4, `reconciliation_${key}_missing`, `Documentation reconciliation ${key} must be true.`));

  const matrix = evidence.nativeMatrix;
  if (!isRecord(matrix)) issues.push(issue(3, 'native_matrix_missing', 'Evidence must record native verify/package results for Windows, macOS, and Linux plus Windows clean-install acceptance.'));
  else for (const platform of NATIVE_PLATFORMS) {
    const row = matrix[platform];
    if (!isRecord(row)) { issues.push(issue(3, `native_${platform}_missing`, `Native ${platform} evidence is missing.`)); continue; }
    requirePass(issues, row.verify, `native_${platform}_verify_not_pass`, `Native ${platform} verify`, 'both', 3);
    requirePass(issues, row.package, `native_${platform}_package_not_pass`, `Native ${platform} package`, 'both', 3);
    if (platform === 'windows') requirePass(issues, row.cleanInstall, 'native_windows_clean_install_not_pass', 'Windows clean-install lifecycle', 'both', 3);
    else requirePass(issues, row.cleanInstall, `native_${platform}_clean_install_not_pass`, `${platform} clean-install lifecycle`, 'stable-v1', 3);
  }

  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : undefined;
  if (!artifacts) issues.push(issue(3, 'artifacts_missing', 'Evidence must enumerate every required checksummed release artifact.'));
  else {
    const seen = new Set();
    for (const [index, artifact] of artifacts.entries()) {
      if (!isRecord(artifact) || typeof artifact.platform !== 'string' || typeof artifact.kind !== 'string') { issues.push(issue(3, 'artifact_entry_invalid', `Artifact ${index + 1} must provide platform and kind.`)); continue; }
      const key = `${artifact.platform}:${artifact.kind}`;
      if (seen.has(key)) { issues.push(issue(3, 'artifact_duplicate', `Artifact key ${key} is duplicated.`)); continue; }
      seen.add(key);
      const result = await inspectHashedFile(cwd, artifact, `Artifact ${key}`);
      if (result.error) issues.push(issue(3, 'artifact_file_invalid', result.error));
    }
    const missing = REQUIRED_ARTIFACTS.filter((key) => !seen.has(key));
    if (missing.length) issues.push(issue(3, 'artifact_matrix_incomplete', `Required artifact evidence is missing: ${missing.join(', ')}.`));
  }

  const stable = evidence.stableV1;
  if (!isRecord(stable)) issues.push(issue(3, 'stable_evidence_missing', 'Stable-v1 evidence must explicitly cover the remaining stable checklist.', 'stable-v1'));
  else {
    requirePass(issues, stable.releaseGatesResult, 'stable_release_gates_not_pass', 'Utility/corrupt-input/provider-mock/performance/accessibility/complete E2E gates', 'stable-v1', 3);
    requirePass(issues, stable.macosNativePackageResult, 'stable_macos_package_not_pass', 'macOS native package/Keychain/fuse/login/DMG/ZIP lifecycle', 'stable-v1', 3);
    issues.push(...await inspectReproducibilityReports(cwd, stable.reproducibilityReports, context));
    requirePass(issues, stable.dependencyLicenseReviewResult, 'stable_dependency_license_review_not_pass', 'Dependency/license review', 'stable-v1', 3);
    requirePass(issues, stable.repositoryPrerequisitesResult, 'stable_repository_prerequisites_not_pass', 'Repository/owner/remote/CI/signing/publication prerequisites', 'stable-v1', 3);
    if (!isRecord(stable.signing) || !['VERIFIED', 'UNSIGNED_LIMITATION'].includes(stable.signing.status)) issues.push(issue(3, 'stable_signing_invalid', 'Signing must be VERIFIED or UNSIGNED_LIMITATION.', 'stable-v1'));
    else if (stable.signing.status === 'UNSIGNED_LIMITATION' && stable.signing.limitationDocumentedEverywhere !== true) issues.push(issue(3, 'stable_unsigned_limitation_missing', 'An unsigned candidate must document the Gatekeeper limitation in every artifact and release note.', 'stable-v1'));
  }
  return issues;
}

async function inspectRepository(cwd) {
  const [{ stdout: commit }, { stdout: statusOutput }] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }),
    execute('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
  ]);
  return { commit: commit.trim(), status: statusOutput.trimEnd() };
}

async function loadEvidence(cwd, evidencePath) {
  const file = await resolveContainedFile(cwd, evidencePath, 'RC evidence manifest', 1024 * 1024);
  return JSON.parse(await readFile(file.absolute, 'utf8'));
}

export async function inspectReleaseReadiness(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const [trackerMarkdown, packageJson, repository] = await Promise.all([
    options.trackerMarkdown ?? readFile(resolve(cwd, 'docs/FEATURE_TRACKER.md'), 'utf8'),
    options.packageJson ?? readFile(resolve(cwd, 'package.json'), 'utf8').then(JSON.parse),
    options.repository ?? inspectRepository(cwd),
  ]);
  const parsedTracker = parseFeatureTracker(trackerMarkdown);
  const trackerById = new Map(parsedTracker.items.map((item) => [item.id, item]));
  const issues = parsedTracker.errors.map((error) => issue(1, 'tracker_contract_invalid', error));
  const dirtyPaths = repository.status ? repository.status.split(/\r?\n/u) : [];
  if (dirtyPaths.length) issues.push(issue(5, 'source_not_clean', `Current source is not a committed clean candidate (${dirtyPaths.length} path${dirtyPaths.length === 1 ? '' : 's'}): ${dirtyPaths.join(', ')}.`));

  const p0Incomplete = parsedTracker.items.filter((item) => item.priority === 'P0' && item.status !== '✅ Verified');
  if (p0Incomplete.length) issues.push(issue(2, 'stable_p0_incomplete', `${p0Incomplete.length} P0 tracker items are not Verified: ${p0Incomplete.map((item) => `${item.id} (${item.status})`).join(', ')}.`, 'stable-v1', p0Incomplete.map((item) => item.id)));
  const p1Incomplete = parsedTracker.items.filter((item) => item.priority === 'P1' && !['✅ Verified', '⏸ Deferred'].includes(item.status));
  if (p1Incomplete.length) issues.push(issue(4, 'stable_p1_incomplete', `${p1Incomplete.length} selected-v1 P1 tracker items have not met exit criteria: ${p1Incomplete.map((item) => `${item.id} (${item.status})`).join(', ')}.`, 'stable-v1', p1Incomplete.map((item) => item.id)));

  let evidence = options.evidence;
  if (evidence === undefined && options.evidencePath) {
    try { evidence = await loadEvidence(cwd, options.evidencePath); }
    catch (error) { issues.push(issue(1, 'evidence_unreadable', `RC evidence manifest could not be read: ${error instanceof Error ? error.message : String(error)}.`)); }
  }
  if (evidence === undefined) {
    issues.push(issue(1, 'level3_evidence_missing', 'No RC evidence manifest was supplied. Level 3 requires one exact independent report/hash, automated/MCP/Computer Use/cross-surface PASS, explicit defect disposition, native matrix results, and hashed release artifacts.'));
    issues.push(issue(3, 'stable_evidence_missing', 'No stable-v1 evidence was supplied for cross-platform clean install, macOS package/security lifecycle, release gates, signing or explicit unsigned limitations, reproducibility/licenses, and repository/publication prerequisites.', 'stable-v1'));
  }
  else issues.push(...await inspectEvidence(cwd, evidence, { packageVersion: packageJson.version, repository, trackerById }));

  sortIssues(issues);
  const level3Issues = issues.filter((entry) => entry.scope !== 'stable-v1');
  const stableIssues = issues;
  return {
    schemaVersion: 1,
    cwd,
    packageVersion: packageJson.version,
    commit: repository.commit,
    evidencePath: options.evidencePath,
    tracker: {
      itemCount: parsedTracker.items.length,
      p0NotVerified: p0Incomplete.map((item) => item.id),
      p1NotClosed: p1Incomplete.map((item) => item.id),
    },
    level3: { ready: level3Issues.length === 0, issueCount: level3Issues.length },
    stableV1: { ready: stableIssues.length === 0, issueCount: stableIssues.length },
    issues,
  };
}

function parseArguments(arguments_) {
  const options = { audit: false, json: false, stableV1: false, evidencePath: undefined };
  for (const argument of arguments_) {
    if (argument === '--audit') options.audit = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--stable-v1') options.stableV1 = true;
    else if (argument.startsWith('--evidence=')) options.evidencePath = argument.slice('--evidence='.length);
    else throw new Error(`Unknown RC-readiness argument: ${argument}`);
  }
  return options;
}

function formatReport(report) {
  const lines = [
    `AIDraw release-readiness ${report.evidencePath ? 'verification' : 'audit'} for ${report.packageVersion} at ${report.commit}`,
    `Level 3 RC: ${report.level3.ready ? 'READY' : 'BLOCKED'} (${report.level3.issueCount} issue${report.level3.issueCount === 1 ? '' : 's'})`,
    `Stable v1: ${report.stableV1.ready ? 'READY' : 'BLOCKED'} (${report.stableV1.issueCount} issue${report.stableV1.issueCount === 1 ? '' : 's'})`,
    `Tracker: ${report.tracker.itemCount} items; ${report.tracker.p0NotVerified.length} P0 not Verified; ${report.tracker.p1NotClosed.length} selected-v1 P1 not closed.`,
  ];
  if (report.issues.length) {
    lines.push('Ranked remaining gaps:');
    for (const entry of report.issues) lines.push(`${entry.rank}. [${entry.code}] ${entry.message}`);
  } else lines.push('All machine-verifiable Level 3 and stable-v1 preflight requirements are satisfied.');
  return `${lines.join('\n')}\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await inspectReleaseReadiness({ evidencePath: options.evidencePath });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(formatReport(report));
    const selectedReady = options.stableV1 ? report.stableV1.ready : report.level3.ready;
    if (!options.audit && !selectedReady) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`AIDraw release-readiness preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

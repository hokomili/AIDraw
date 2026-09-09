import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inspectReleaseReadiness, parseFeatureTracker } from '../../scripts/check-rc-readiness.mjs';

const execute = promisify(execFile);
const temporaryRoots: string[] = [];
const commit = 'a'.repeat(40);
const completeTracker = `
| ID | Feature | Status | Priority | Current truth and exit criteria |
| --- | --- | --- | --- | --- |
| QA-01 | Automated coverage | ✅ Verified | P0 | Exact acceptance exists. |
| REL-05 | Documentation | ⏸ Deferred | P1 | Explicitly outside the selected v1 scope. |
`;
const requiredArtifacts = [
  ['windows-x64', 'squirrel'],
  ['windows-x64', 'zip'],
  ['windows-x64', 'checksums'],
  ['macos-arm64', 'dmg'],
  ['macos-arm64', 'zip'],
  ['macos-arm64', 'checksums'],
  ['linux-x64', 'deb'],
  ['linux-x64', 'rpm'],
  ['linux-x64', 'zip'],
  ['linux-x64', 'checksums'],
  ['all', 'licenses-json'],
  ['all', 'licenses-markdown'],
] as const;

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

async function completeEvidence() {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-rc-readiness-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'test-results', 'level3'), { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });
  const reportPath = 'test-results/level3/report.md';
  const report = `# AIDraw Level 3 QA report

## Result

- Overall: \`PASS\`
- Level: \`3\`
- Source revision: \`${commit}\`
- Tester model: \`gpt-6-astra\`
- Tester reasoning effort: \`high\`

## Automated gate

- Command: \`node scripts/npm-node24.mjs run test:level3:auto\`
- Authoritative exit: \`0\`

## MCP evidence

PASS.

## Computer Use evidence

PASS.

## Cross-surface evidence

PASS.

## Coverage exceptions

None.

## Final gate decision

PASS.
`;
  await writeFile(join(root, reportPath), report, 'utf8');
  const artifacts = [];
  for (const [platform, kind] of requiredArtifacts) {
    const path = `out/${platform}-${kind}.artifact`;
    const contents = `${platform}:${kind}\n`;
    await writeFile(join(root, path), contents, 'utf8');
    artifacts.push({ platform, kind, path, sha256: sha256(contents) });
  }
  const reproducibilityReports = [];
  for (const platform of ['windows-x64', 'macos-arm64', 'linux-x64']) {
    const path = `test-results/level3/reproducibility-${platform}.json`;
    const manifestReference = { path: `${platform}-provenance.json`, bytes: 128, sha256: sha256(`${platform}:manifest`) };
    const contents = `${JSON.stringify({
      schemaVersion: 1,
      result: 'PASS',
      platform,
      candidate: { version: '0.1.0-alpha.1', commit },
      sourceIdentityEqual: true,
      toolchainIdentityEqual: true,
      artifactInventoryEqual: true,
      artifactCount: 1,
      leftManifest: manifestReference,
      rightManifest: { ...manifestReference, path: `${platform}-provenance-rerun.json` },
      differences: [],
      environmentDifferences: [],
    }, null, 2)}\n`;
    await writeFile(join(root, path), contents, 'utf8');
    reproducibilityReports.push({ platform, path, sha256: sha256(contents) });
  }
  return {
    root,
    evidence: {
      schemaVersion: 1,
      candidate: { version: '0.1.0-alpha.1', commit, sourceClean: true },
      level3: {
        result: 'PASS',
        independent: true,
        tester: { model: 'gpt-6-astra', reasoningEffort: 'high' },
        automated: { command: 'node scripts/npm-node24.mjs run test:level3:auto', exitCode: 0 },
        mcpResult: 'PASS',
        computerUseResult: 'PASS',
        crossSurfaceResult: 'PASS',
        mandatoryCoverageComplete: true,
        report: { path: reportPath, sha256: sha256(report) },
      },
      defects: { blocker: [], p0: [], p1Exceptions: [] },
      nativeMatrix: {
        windows: { verify: 'PASS', package: 'PASS', cleanInstall: 'PASS' },
        macos: { verify: 'PASS', package: 'PASS', cleanInstall: 'PASS' },
        linux: { verify: 'PASS', package: 'PASS', cleanInstall: 'PASS' },
      },
      artifacts,
      reconciliation: { readme: true, featureTracker: true, changelog: true, knownLimitations: true },
      stableV1: {
        releaseGatesResult: 'PASS',
        macosNativePackageResult: 'PASS',
        signing: { status: 'VERIFIED', limitationDocumentedEverywhere: false },
        reproducibilityReports,
        dependencyLicenseReviewResult: 'PASS',
        repositoryPrerequisitesResult: 'PASS',
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release-candidate readiness preflight', () => {
  it('parses every live tracker row under the documented status contract', async () => {
    const tracker = await readFile(resolve('docs/FEATURE_TRACKER.md'), 'utf8');
    const parsed = parseFeatureTracker(tracker);
    expect(parsed.errors).toEqual([]);
    expect(parsed.items.length).toBeGreaterThan(50);
    expect(parsed.items.find((item) => item.id === 'QA-09')).toMatchObject({ priority: 'P0', status: '🟡 Partial' });
    expect(parsed.items.find((item) => item.id === 'REL-02')).toMatchObject({ priority: 'P0', status: '✅ Verified' });
  });

  it('accepts a complete exact Level 3 manifest and the stricter stable-v1 evidence', async () => {
    const fixture = await completeEvidence();
    const report = await inspectReleaseReadiness({
      cwd: fixture.root,
      trackerMarkdown: completeTracker,
      packageJson: { version: '0.1.0-alpha.1' },
      repository: { commit, status: '' },
      evidence: fixture.evidence,
    });
    expect(report.level3).toEqual({ ready: true, issueCount: 0 });
    expect(report.stableV1).toEqual({ ready: true, issueCount: 0 });
    expect(report.issues).toEqual([]);
  });

  it('preserves current RC1 Luna evidence without allowing Luna for subsequent candidates', async () => {
    const fixture = await completeEvidence();
    fixture.evidence.level3.tester.model = 'gpt-5.6-luna';
    const path = join(fixture.root, fixture.evidence.level3.report.path);
    const original = await readFile(path, 'utf8');
    const historical = original.replace('gpt-6-astra', 'gpt-5.6-luna');
    await writeFile(path, historical, 'utf8');
    fixture.evidence.level3.report.sha256 = sha256(historical);
    for (const version of ['0.1.0-rc.1', '0.1.0-rc.2']) {
      fixture.evidence.candidate.version = version;
      const report = await inspectReleaseReadiness({ cwd: fixture.root, trackerMarkdown: completeTracker, packageJson: { version }, repository: { commit, status: '' }, evidence: fixture.evidence });
      expect(report.level3.ready).toBe(version === '0.1.0-rc.1');
      expect(report.issues.some((entry) => entry.code === 'level3_tester_invalid')).toBe(version !== '0.1.0-rc.1');
    }
  });

  it('does not conflate a complete Level 3 certificate with incomplete stable-v1 tracker work', async () => {
    const fixture = await completeEvidence();
    const tracker = completeTracker
      .replace('QA-01 | Automated coverage | ✅ Verified', 'QA-01 | Automated coverage | 🟢 Working')
      .replace('REL-05 | Documentation | ⏸ Deferred', 'REL-05 | Documentation | 🟡 Partial');
    const report = await inspectReleaseReadiness({
      cwd: fixture.root,
      trackerMarkdown: tracker,
      packageJson: { version: '0.1.0-alpha.1' },
      repository: { commit, status: '' },
      evidence: fixture.evidence,
    });
    expect(report.level3.ready).toBe(true);
    expect(report.stableV1.ready).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toEqual(['stable_p0_incomplete', 'stable_p1_incomplete']);
  });

  it('fails closed on a report hash mismatch and on incomplete artifact evidence', async () => {
    const fixture = await completeEvidence();
    fixture.evidence.level3.report.sha256 = '0'.repeat(64);
    fixture.evidence.artifacts.pop();
    const report = await inspectReleaseReadiness({
      cwd: fixture.root,
      trackerMarkdown: completeTracker,
      packageJson: { version: '0.1.0-alpha.1' },
      repository: { commit, status: '' },
      evidence: fixture.evidence,
    });
    expect(report.level3.ready).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(['level3_report_invalid', 'artifact_matrix_incomplete']));
  });

  it('keeps Level 3 distinct when stable-v1 reproducibility evidence is invalid', async () => {
    const fixture = await completeEvidence();
    fixture.evidence.stableV1.reproducibilityReports[0].sha256 = '0'.repeat(64);
    const report = await inspectReleaseReadiness({
      cwd: fixture.root,
      trackerMarkdown: completeTracker,
      packageJson: { version: '0.1.0-alpha.1' },
      repository: { commit, status: '' },
      evidence: fixture.evidence,
    });
    expect(report.level3.ready).toBe(true);
    expect(report.stableV1.ready).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toContain('stable_reproducibility_file_invalid');
  });

  it('reports the current ranked gaps without turning an audit into certification', async () => {
    const { stdout } = await execute(process.execPath, [resolve('scripts/check-rc-readiness.mjs'), '--audit', '--json'], { cwd: resolve('.'), encoding: 'utf8', windowsHide: true });
    const report = JSON.parse(stdout) as { level3: { ready: boolean }; stableV1: { ready: boolean }; issues: Array<{ code: string }> };
    expect(report.level3.ready).toBe(false);
    expect(report.stableV1.ready).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(['level3_evidence_missing', 'stable_p0_incomplete', 'stable_evidence_missing', 'stable_p1_incomplete']));
  });

  it('keeps the audit non-gating and exposes an evidence-required verification command', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['rc:audit']).toBe('node scripts/check-rc-readiness.mjs --audit');
    expect(packageJson.scripts['rc:verify']).toBe('node scripts/check-rc-readiness.mjs');
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertUx09EvidenceRedacted,
  assertUx09LocalAxisReachability,
  assertUx09TextReflowSafeReporterEnvironment,
  buildUx09TextReflowChildEnvironment,
  classifyUx09RendererRequest,
  exerciseUx09ScrollBoundaries,
  hasExactUx09ProcessShape,
  isUx09ExactTextFit,
  isUx09RectContained,
  parseUx09OwnedProcesses,
  redactUx09FailureText,
  resolveUx09TextReflowAcceptance,
  UX09_TEXT_REFLOW_ASAR_HASH_ENV,
  UX09_TEXT_REFLOW_EXE_HASH_ENV,
  UX09_TEXT_REFLOW_FAILURE_PREFIX,
  UX09_TEXT_REFLOW_FAILURE_ROOT_ENV,
  UX09_TEXT_REFLOW_FILES,
  UX09_TEXT_REFLOW_MECHANISM,
  UX09_TEXT_REFLOW_PACKAGE_PREFIX,
  UX09_TEXT_REFLOW_PROFILE_ENV,
  UX09_TEXT_REFLOW_PROFILE_PREFIX,
  UX09_TEXT_REFLOW_SCREENSHOTS,
  writeUx09ExclusiveRecord,
} from '../../scripts/ux09-text-reflow-acceptance.mjs';

const digest = 'A'.repeat(64);

function environment(workspace: string, runId = '20260816t120000z-87436fe-ux09'): NodeJS.ProcessEnv {
  return {
    AIDRAW_E2E_OUT_DIR: join(workspace, 'test-results', 'prepared-packages', `${UX09_TEXT_REFLOW_PACKAGE_PREFIX}${runId}`),
    [UX09_TEXT_REFLOW_PROFILE_ENV]: join(workspace, 'test-results', 'retained', `${UX09_TEXT_REFLOW_PROFILE_PREFIX}${runId}`),
    [UX09_TEXT_REFLOW_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${UX09_TEXT_REFLOW_FAILURE_PREFIX}${runId}`),
    [UX09_TEXT_REFLOW_EXE_HASH_ENV]: digest,
    [UX09_TEXT_REFLOW_ASAR_HASH_ENV]: digest.toLowerCase(),
  };
}

describe('UX-09 exact-package 32 px text-reflow boundary', () => {
  it('records the consumed controller/product/scenario failures and bounded packaged frame correction without overclaiming acceptance', async () => {
    const [changelog, tracker, testing] = await Promise.all([
      readFile(resolve('CHANGELOG.md'), 'utf8'),
      readFile(resolve('docs/FEATURE_TRACKER.md'), 'utf8'),
      readFile(resolve('docs/TESTING.md'), 'utf8'),
    ]);
    for (const source of [changelog, tracker, testing]) {
      expect(source).toContain('20260815t231450z-87436fe-ux09');
      expect(source).toContain('20260815t234733z-87436fe-ux09-r2');
      expect(source).toContain('20260816t002458z-87436fe-ux09-r3');
      expect(source).toContain('20260816t005522z-87436fe-ux09-r4');
      expect(source).toContain('1/1 in 4.6 seconds');
      expect(source).toContain('1/1 in 3.8 seconds');
      expect(source).toContain('1/1 in 4.7 seconds');
      expect(source).toContain('bounded convergence sampler');
      expect(source).toMatch(/context-bar|\.context-bar/);
      expect(source).toMatch(/controller/i);
      expect(source).toMatch(/zero survivors|zero owned survivors/i);
      expect(source).toMatch(/unexecuted source\/headless/);
    }
    expect(changelog).toContain('1/1 in 5.1 seconds');
    expect(testing).toContain('1/1 in 5.1 seconds');
    expect(testing).toContain('**Playwright trusted-renderer inline `documentElement.style.fontSize = 32px` after app-shell readiness**');
    expect(testing).toContain('No screenshot, completed metrics/evidence, request census');
    expect(testing).toContain('Only after independent review and separate authorization may another wholly fresh identity run.');
    expect(tracker).toContain('remains a consumed controller-only label-lookup failure');
    expect(tracker).toContain('established one bounded packaged product defect');
    expect(changelog).toContain('intrinsic horizontal overflow (`scrollWidth > clientWidth`)');
    expect(testing).toContain('This is a product fit defect rather than a controller failure.');
    expect(changelog).toContain('unchanged 3 px side padding leaves 56/136 px usable');
    expect(tracker).toContain('separate enlarged thumbnail/metadata rows each expose the full 136 px');
    expect(testing).toContain('ordinary second row retains its 28/28 px frame-number/metadata split');
    expect(changelog).toContain('two-axis inspector-label containment and the unchanged exact `60000ms` intrinsic-fit assertion passed');
    expect(tracker).toContain('prior fit predicates and `.document-tab-viewport` smooth-scroll proof passed');
    expect(testing).toContain('Treat this as a controller-proof failure, not a product document-tab scrolling defect.');
    expect(testing).toContain('`overflow-x: auto` and `scroll-behavior: smooth`');
    expect(testing).toContain('One screenshot was retained');
    expect(changelog).toContain('passed `.document-tab-viewport`');
    expect(tracker).toContain('controller/scenario evidence gap');
    expect(testing).toContain('no positive horizontal range in that scenario state');
    expect(testing).toContain('not evidence that context controls are clipped or unreachable');
    expect(testing).toContain('finite positive scrollport');
    expect(testing).toContain('bounded numeric client/scroll/range/endpoint plus scrollport/child geometry');
  });

  it('binds one correlated single-use package, profile, failure root, and bounded screenshot set', () => {
    const workspace = resolve('synthetic-workspace');
    const runId = '20260816t120000z-87436fe-ux09';
    const resolved = resolveUx09TextReflowAcceptance({ workspacePath: workspace, environment: environment(workspace, runId) });
    expect(resolved).toMatchObject({ workspace, runId, executableSha256: digest, asarSha256: digest });
    expect(resolved.packageRoot).toBe(join(workspace, 'test-results', 'prepared-packages', `${UX09_TEXT_REFLOW_PACKAGE_PREFIX}${runId}`));
    expect(resolved.profile).toBe(join(workspace, 'test-results', 'retained', `${UX09_TEXT_REFLOW_PROFILE_PREFIX}${runId}`));
    expect(resolved.failureRoot).toBe(join(workspace, 'test-results', 'retained-failures', `${UX09_TEXT_REFLOW_FAILURE_PREFIX}${runId}`));
    expect(resolved.paths.ownerConnection).toBe(join(resolved.profile, UX09_TEXT_REFLOW_FILES.ownerConnection));
    expect(resolved.screenshots).toEqual(UX09_TEXT_REFLOW_SCREENSHOTS.map((file) => join(resolved.profile, file)));
    expect(new Set(resolved.screenshots).size).toBe(3);
  });

  it('fails closed for nested, cross-run, default-profile, short-identity, or invalid hash declarations', () => {
    const workspace = resolve('synthetic-workspace');
    const valid = environment(workspace);
    expect(() => resolveUx09TextReflowAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX09_TEXT_REFLOW_PROFILE_ENV]: join(workspace, 'Default') },
    })).toThrow(/direct child/);
    expect(() => resolveUx09TextReflowAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX09_TEXT_REFLOW_PROFILE_ENV]: join(valid[UX09_TEXT_REFLOW_PROFILE_ENV]!, 'nested') },
    })).toThrow(/direct child/);
    expect(() => resolveUx09TextReflowAcceptance({ workspacePath: workspace, environment: environment(workspace, 'short') })).toThrow(/8-80/);
    expect(() => resolveUx09TextReflowAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX09_TEXT_REFLOW_FAILURE_ROOT_ENV]: join(workspace, 'test-results', 'retained-failures', `${UX09_TEXT_REFLOW_FAILURE_PREFIX}different-run`) },
    })).toThrow(/matching fresh/);
    expect(() => resolveUx09TextReflowAcceptance({
      workspacePath: workspace,
      environment: { ...valid, [UX09_TEXT_REFLOW_ASAR_HASH_ENV]: 'abc' },
    })).toThrow(/SHA-256/);
  });

  it('strips credential, provider, reporter, and proxy state from the child environment', () => {
    const workspace = resolve('synthetic-workspace');
    const declared = environment(workspace);
    const child = buildUx09TextReflowChildEnvironment({
      ...declared,
      PATH: '/safe/bin',
      HOME: '/safe/home',
      UNRELATED_SECRET: 'must-not-pass',
      HTTP_PROXY: 'http://proxy.invalid',
      PLAYWRIGHT_HTML_OUTPUT_DIR: '/unsafe/reporter',
    });
    expect(child).toMatchObject({
      ...declared,
      PATH: '/safe/bin',
      HOME: '/safe/home',
      AIDRAW_E2E_UX09_TEXT_REFLOW_WRAPPER: '1',
      PLAYWRIGHT_NO_COPY_PROMPT: '1',
    });
    expect(child).not.toHaveProperty('UNRELATED_SECRET');
    expect(child).not.toHaveProperty('HTTP_PROXY');
    expect(child).not.toHaveProperty('PLAYWRIGHT_HTML_OUTPUT_DIR');
    expect(assertUx09TextReflowSafeReporterEnvironment({})).toBe(true);
    expect(() => assertUx09TextReflowSafeReporterEnvironment({ PLAYWRIGHT_JSON_OUTPUT_FILE: '/tmp/unsafe' })).toThrow(/PLAYWRIGHT_JSON_OUTPUT_FILE/);
  });

  it('finds only exact-profile processes and retains no secret-bearing evidence', () => {
    const profile = resolve('test-results/retained/aidraw-e2e-ux09-text-reflow-20260816t120000z-87436fe-ux09');
    const table = [
      ` 100 1 /candidate/AIDraw --user-data-dir=${profile}`,
      ` 101 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}`,
      ` 102 100 /candidate/AIDraw Helper --type=gpu-process --user-data-dir=${profile}`,
      ` 103 100 /candidate/AIDraw Helper --type=renderer --user-data-dir=${profile}-sibling`,
      ' 999 1 /candidate/AIDraw --user-data-dir=/Users/example/Library/Application Support/AIDraw',
    ].join('\n');
    const owned = parseUx09OwnedProcesses(table, profile);
    expect(owned).toEqual([
      { pid: 100, ppid: 1, type: 'browser' },
      { pid: 101, ppid: 100, type: 'renderer' },
      { pid: 102, ppid: 100, type: 'gpu-process' },
    ]);
    expect(hasExactUx09ProcessShape(owned, 100)).toBe(true);
    expect(hasExactUx09ProcessShape([...owned, { pid: 104, ppid: 1, type: 'browser' }], 100)).toBe(false);
    expect(hasExactUx09ProcessShape([...owned, { pid: 104, ppid: 100, type: 'renderer' }], 100)).toBe(false);
    expect(hasExactUx09ProcessShape(owned, 999)).toBe(false);
    expect(hasExactUx09ProcessShape(owned.map((entry) => entry.type === 'renderer' ? { ...entry, ppid: 999 } : entry), 100)).toBe(false);
    const secret = 'ux09-private-token';
    const redacted = redactUx09FailureText(`Authorization: Bearer ${secret}; token=${secret}`, [secret]);
    expect(redacted).not.toContain(secret);
    expect(assertUx09EvidenceRedacted(JSON.stringify({ result: 'failed', redacted }), [secret])).toBe(true);
    expect(() => assertUx09EvidenceRedacted(JSON.stringify({ token: secret }), [secret])).toThrow(/secret-bearing/);
  });

  it('exercises both scroll boundaries and restores a surface that starts at its maximum', async () => {
    const surface = {
      scrollLeft: 120,
      scrollTop: 80,
      scrollWidth: 220,
      scrollHeight: 180,
      clientWidth: 100,
      clientHeight: 100,
    };
    await expect(exerciseUx09ScrollBoundaries(surface, 'both')).resolves.toMatchObject({
      originalX: 120,
      originalY: 80,
      maxX: 120,
      maxY: 80,
      startX: 0,
      endX: 120,
      startY: 0,
      endY: 80,
      restoredX: 120,
      restoredY: 80,
      reachedStartX: true,
      reachedEndX: true,
      reachedStartY: true,
      reachedEndY: true,
    });
    expect(surface).toMatchObject({ scrollLeft: 120, scrollTop: 80 });

    const xOnly = { ...surface, scrollLeft: 45, scrollTop: 31 };
    await expect(exerciseUx09ScrollBoundaries(xOnly, 'x')).resolves.toMatchObject({ startX: 0, endX: 120, restoredX: 45, restoredY: 31 });
    expect(xOnly).toMatchObject({ scrollLeft: 45, scrollTop: 31 });
  });

  it('awaits delayed smooth-scroll convergence on both axes and restores the exact nonzero origin', async () => {
    let currentX = 37.5;
    let currentY = 22.25;
    let pendingX: { target: number; reads: number } | undefined;
    let pendingY: { target: number; reads: number } | undefined;
    const horizontalAssignments: number[] = [];
    const verticalAssignments: number[] = [];
    const surface = {
      get scrollLeft() {
        if (pendingX && --pendingX.reads <= 0) {
          currentX = pendingX.target;
          pendingX = undefined;
        }
        return currentX;
      },
      set scrollLeft(target: number) {
        horizontalAssignments.push(target);
        pendingX = { target, reads: 4 };
      },
      get scrollTop() {
        if (pendingY && --pendingY.reads <= 0) {
          currentY = pendingY.target;
          pendingY = undefined;
        }
        return currentY;
      },
      set scrollTop(target: number) {
        verticalAssignments.push(target);
        pendingY = { target, reads: 3 };
      },
      scrollWidth: 260,
      scrollHeight: 190,
      clientWidth: 100,
      clientHeight: 90,
    };

    await expect(exerciseUx09ScrollBoundaries(surface, 'both')).resolves.toMatchObject({
      originalX: 37.5,
      originalY: 22.25,
      maxX: 160,
      maxY: 100,
      startX: 0,
      endX: 160,
      startY: 0,
      endY: 100,
      restoredX: 37.5,
      restoredY: 22.25,
    });
    expect(horizontalAssignments).toEqual([0, 160, 37.5]);
    expect(verticalAssignments).toEqual([0, 100, 22.25]);
    expect(surface.scrollLeft).toBe(37.5);
    expect(surface.scrollTop).toBe(22.25);
  });

  it('fails closed for a stuck endpoint and still restores both axes', async () => {
    let currentX = 19;
    let currentY = 11;
    const assignments = { x: [] as number[], y: [] as number[] };
    const surface = {
      get scrollLeft() { return currentX; },
      set scrollLeft(target: number) {
        assignments.x.push(target);
        if (target === 19) currentX = target;
      },
      get scrollTop() { return currentY; },
      set scrollTop(target: number) {
        assignments.y.push(target);
        currentY = target;
      },
      scrollWidth: 200,
      scrollHeight: 180,
      clientWidth: 100,
      clientHeight: 100,
    };

    let failure = '';
    try {
      await exerciseUx09ScrollBoundaries(surface, 'both');
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toMatch(/horizontal start endpoint did not converge/);
    expect(failure).toContain('"scrollWidth":200');
    expect(failure).toContain('"clientWidth":100');
    expect(failure).toContain('"maxX":100');
    expect(assignments.x).toEqual([0, 19]);
    expect(assignments.y).toEqual([11]);
    expect({ x: currentX, y: currentY }).toEqual({ x: 19, y: 11 });
  });

  it('fails closed when exact restoration cannot converge and still attempts the other axis', async () => {
    let currentX = 45;
    let currentY = 31;
    let horizontalAssignments = 0;
    const verticalAssignments: number[] = [];
    const surface = {
      get scrollLeft() { return currentX; },
      set scrollLeft(target: number) {
        horizontalAssignments += 1;
        if (horizontalAssignments < 3) currentX = target;
      },
      get scrollTop() { return currentY; },
      set scrollTop(target: number) {
        verticalAssignments.push(target);
        currentY = target;
      },
      scrollWidth: 220,
      scrollHeight: 180,
      clientWidth: 100,
      clientHeight: 100,
    };

    await expect(exerciseUx09ScrollBoundaries(surface, 'x')).rejects.toThrow(/horizontal restoration did not converge/);
    expect(verticalAssignments).toEqual([31]);
    expect(currentY).toBe(31);
  });

  it('requires exact positive-range movement and restoration with bounded numeric diagnostics', () => {
    const layout = {
      selector: '.context-bar',
      axis: 'x' as const,
      overflowX: 'auto',
      overflowY: 'hidden',
      clientWidth: 120,
      clientHeight: 40,
      scrollWidth: 220,
      scrollHeight: 40,
    };
    const metric = {
      layoutBefore: layout,
      layoutAfter: { ...layout },
      boundaryDimensions: { scrollWidth: 220, scrollHeight: 40, clientWidth: 120, clientHeight: 40 },
      originalX: 35,
      originalY: 0,
      maxX: 100,
      maxY: 0,
      startX: 0,
      endX: 100,
      startY: 0,
      endY: 0,
      restoredX: 35,
      restoredY: 0,
      reachedStartX: true,
      reachedEndX: true,
      reachedStartY: true,
      reachedEndY: true,
    };
    expect(assertUx09LocalAxisReachability(metric)).toEqual({ x: 'scrollable', y: 'not-requested' });
    expect(() => assertUx09LocalAxisReachability({ ...metric, reachedEndX: false, endX: 35 })).toThrow(/numeric endpoints do not equal the exact requested start and end/);
    expect(() => assertUx09LocalAxisReachability({ ...metric, reachedEndX: true, endX: 35 })).toThrow(/reachedEndX contradicts its numeric endpoint/);
    expect(() => assertUx09LocalAxisReachability({ ...metric, restoredX: 34 })).toThrow(/exact original scroll position was not restored/);
    try {
      assertUx09LocalAxisReachability({ ...metric, reachedEndX: false, endX: 35 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('"selector":".context-bar"');
      expect(message).toContain('"clientWidth":120');
      expect(message).toContain('"maxX":100');
      expect(message).toContain('"endX":35');
    }
  });

  it('admits a zero-range context surface only when its visible scrollport and non-shrinking children fully fit', () => {
    const containment = {
      viewport: { left: 0, right: 980, top: 0, bottom: 640 },
      scrollport: { left: 100, right: 220, top: 60, bottom: 100 },
      visibleScrollport: { left: 100, right: 220, top: 60, bottom: 100 },
      clippingAncestors: [],
      children: [
        { index: 0, label: '0:span.context-tool-name', flexShrink: 0, rendered: true, rect: { left: 105, right: 145, top: 65, bottom: 95 } },
        { index: 1, label: '1:label.compact-field', flexShrink: 0, rendered: true, rect: { left: 150, right: 215, top: 65, bottom: 95 } },
      ],
    };
    const layout = {
      selector: '.context-bar',
      axis: 'x' as const,
      overflowX: 'auto',
      overflowY: 'hidden',
      clientWidth: 120,
      clientHeight: 40,
      scrollWidth: 120,
      scrollHeight: 40,
      containment,
    };
    const contained = {
      layoutBefore: layout,
      layoutAfter: { ...layout },
      boundaryDimensions: { scrollWidth: 120, scrollHeight: 40, clientWidth: 120, clientHeight: 40 },
      originalX: 0,
      originalY: 0,
      maxX: 0,
      maxY: 0,
      startX: 0,
      endX: 0,
      startY: 0,
      endY: 0,
      restoredX: 0,
      restoredY: 0,
      reachedStartX: true,
      reachedEndX: true,
      reachedStartY: true,
      reachedEndY: true,
    };
    expect(assertUx09LocalAxisReachability(contained, { admitContainedZeroRange: true })).toEqual({
      x: 'contained-zero-range',
      y: 'not-requested',
    });
    expect(() => assertUx09LocalAxisReachability(contained)).toThrow(/movement is required but the range is zero/);

    const clippedLayout = {
      ...layout,
      containment: {
        ...containment,
        children: [
          containment.children[0],
          { ...containment.children[1], rect: { left: 150, right: 228, top: 65, bottom: 104 } },
        ],
      },
    };
    const clipped = { ...contained, layoutBefore: clippedLayout, layoutAfter: { ...clippedLayout } };
    try {
      assertUx09LocalAxisReachability(clipped, { admitContainedZeroRange: true });
      throw new Error('Expected the clipped zero-range surface to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/clipped or hidden non-shrinking children/);
      expect(message).toContain('1:label.compact-field');
      expect(message).toContain('"right":228');
      expect(message).toContain('"bottom":104');
      expect(message).toContain('"visibleScrollport":{"left":100,"right":220,"top":60,"bottom":100}');
    }
  });

  it('rejects contradictory boundary ranges and changed pre/post layout or containment samples', () => {
    const containment = {
      viewport: { left: 0, right: 980, top: 0, bottom: 640 },
      scrollport: { left: 100, right: 220, top: 60, bottom: 100 },
      visibleScrollport: { left: 100, right: 220, top: 60, bottom: 100 },
      clippingAncestors: [],
      children: [
        { index: 0, label: '0:span.context-tool-name', flexShrink: 0, rendered: true, rect: { left: 105, right: 145, top: 65, bottom: 95 } },
      ],
    };
    const layout = {
      selector: '.context-bar',
      axis: 'x' as const,
      overflowX: 'auto',
      overflowY: 'hidden',
      clientWidth: 120,
      clientHeight: 40,
      scrollWidth: 120,
      scrollHeight: 40,
      containment,
    };
    const metric = {
      layoutBefore: layout,
      layoutAfter: { ...layout },
      boundaryDimensions: { scrollWidth: 120, scrollHeight: 40, clientWidth: 120, clientHeight: 40 },
      originalX: 0,
      originalY: 0,
      maxX: 0,
      maxY: 0,
      startX: 0,
      endX: 0,
      startY: 0,
      endY: 0,
      restoredX: 0,
      restoredY: 0,
      reachedStartX: true,
      reachedEndX: true,
      reachedStartY: true,
      reachedEndY: true,
    };

    const overflowingLayout = { ...layout, scrollWidth: 121 };
    expect(() => assertUx09LocalAxisReachability({
      ...metric,
      layoutBefore: overflowingLayout,
      layoutAfter: { ...overflowingLayout },
      boundaryDimensions: { ...metric.boundaryDimensions, scrollWidth: 121 },
    }, { admitContainedZeroRange: true })).toThrow(/declared boundary range disagrees/);
    expect(() => assertUx09LocalAxisReachability({
      ...metric,
      boundaryDimensions: { ...metric.boundaryDimensions, scrollWidth: 121 },
    }, { admitContainedZeroRange: true })).toThrow(/boundary-probe dimensions disagree/);
    expect(() => assertUx09LocalAxisReachability({
      ...metric,
      layoutAfter: { ...layout, clientWidth: 119 },
      boundaryDimensions: { ...metric.boundaryDimensions, clientWidth: 119 },
      maxX: 1,
      endX: 1,
    }, { admitContainedZeroRange: true })).toThrow(/layout dimensions or overflow policy changed/);
    const changedContainment = {
      ...containment,
      children: [{ ...containment.children[0], rect: { left: 105, right: 147, top: 65, bottom: 95 } }],
    };
    expect(() => assertUx09LocalAxisReachability({
      ...metric,
      layoutAfter: { ...layout, containment: changedContainment },
    }, { admitContainedZeroRange: true })).toThrow(/containment geometry changed/);
  });

  it('requires two-axis containment and complete intrinsic frame metadata fit', () => {
    const button = { left: 10, right: 110, top: 20, bottom: 80 };
    expect(isUx09RectContained({ left: 20, right: 100, top: 30, bottom: 70 }, button)).toBe(true);
    expect(isUx09RectContained({ left: 9, right: 100, top: 30, bottom: 70 }, button, 0)).toBe(false);
    expect(isUx09RectContained({ left: 20, right: 111, top: 30, bottom: 70 }, button, 0)).toBe(false);
    expect(isUx09ExactTextFit({ text: '60000ms', expected: '60000ms', clientWidth: 80, scrollWidth: 80 })).toBe(true);
    expect(isUx09ExactTextFit({ text: '60000ms', expected: '60000ms', clientWidth: 79, scrollWidth: 80 })).toBe(false);
    expect(isUx09ExactTextFit({ text: '6000…', expected: '60000ms', clientWidth: 80, scrollWidth: 80 })).toBe(false);
  });

  it('admits only exact packaged renderer resources and rejects every loopback request', () => {
    for (const value of [
      'aidraw://app/index.html',
      'aidraw://app/index.html?native-titlebar=hidden-inset',
      'aidraw://app/assets/index-ABC123.js',
      'aidraw://app/assets/index-ABC123.css',
    ]) expect(classifyUx09RendererRequest(value).permitted, value).toBe(true);
    for (const value of [
      'http://127.0.0.1:43123/mcp',
      'http://localhost:43123/anything',
      'ws://127.0.0.1:43123/socket',
      'aidraw://guide',
      'aidraw://app/index.html?unexpected=1',
      'data:text/plain,unexpected',
      'blob:aidraw://app/unexpected',
      'devtools://devtools/bundled/inspector.html',
    ]) expect(classifyUx09RendererRequest(value).permitted, value).toBe(false);
    expect(classifyUx09RendererRequest('http://127.0.0.1:43123/mcp?token=secret')).toMatchObject({
      permitted: false,
      descriptor: 'http://127.0.0.1:43123/mcp?[query-redacted]',
    });
  });

  it('creates evidence records exclusively without replacing an unexpected predecessor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-ux09-exclusive-'));
    const path = join(directory, 'cleanup.json');
    try {
      await writeUx09ExclusiveRecord(path, 'predecessor\n');
      await expect(writeUx09ExclusiveRecord(path, 'replacement\n')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path, 'utf8')).toBe('predecessor\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps retired persistent stores as explicit absence sentinels', () => {
    expect(UX09_TEXT_REFLOW_FILES.retiredProviderStore).toBe(join('credentials', 'generation.json'));
    expect(UX09_TEXT_REFLOW_FILES.retiredAuthorityStore).toBe(join('credentials', 'mcp-token.json'));
  });

  it('labels and binds the exact trusted-renderer mechanism, fit metrics, local axes, canonical edit, and graceful cleanup', async () => {
    const [spec, wrapper, config, styles] = await Promise.all([
      readFile(resolve('tests/e2e/editor-text-reflow.spec.ts'), 'utf8'),
      readFile(resolve('scripts/run-ux09-text-reflow-acceptance.mjs'), 'utf8'),
      readFile(resolve('playwright.ux09-text-reflow.config.ts'), 'utf8'),
      readFile(resolve('src/renderer/styles.css'), 'utf8'),
    ]);
    expect(UX09_TEXT_REFLOW_MECHANISM).toBe('Playwright trusted-renderer inline documentElement.style.fontSize = 32px after app-shell readiness');
    expect(spec).toContain("document.documentElement.style.fontSize = '32px'");
    expect(spec).toContain('document.documentElement.dataset.ux09TextReflowMechanism = mechanism');
    expect(spec).toContain("const label = button.querySelector('span')");
    expect(spec).not.toContain('An inspector tab has no direct visible label.');
    expect(spec).toContain("expect(tabFit.offsetHeight).toBeGreaterThanOrEqual(70)");
    expect(spec).toContain("expect(frameFit.width).toBeGreaterThanOrEqual(140)");
    expect(spec).toContain('exerciseUx09ScrollBoundaries');
    expect(spec).toContain("localAxisMetric(page, '.context-bar', 'x', { admitContainedZeroRange: true })");
    expect(spec).toContain("stage: 'local-axis-reachability'");
    expect(spec).toContain('Before-layout diagnostics: ${JSON.stringify(layoutBefore)}');
    expect(spec).toContain('layoutAfter = await locator.evaluate(inspectLocalAxisLayout, settings)');
    expect(spec).toContain('assertUx09LocalAxisReachability(metric, options)');
    expect(spec).toContain('isUx09RectContained(entry.text, entry.button)');
    expect(spec).toContain('isUx09RectContained(entry.text, tabFit.visibleStrip)');
    expect(spec).toContain("expected: '60000ms'");
    expect(spec).toContain('scrollWidth: frameFit.metadataScrollWidth');
    expect(spec).toContain('hasExactUx09ProcessShape(last, expectedOwnerPid)');
    expect(spec).toContain('classifyUx09RendererRequest(request.url())');
    expect(spec).toContain("begins when the CDP context request listener attaches");
    expect(spec).toContain("axes.push(await localAxisMetric(page, '.statusbar', 'x'))");
    expect(spec).toContain("keyboardRecovery.push('Shift+Tab reveals named Skip to canvas; Enter focuses the pixel canvas')");
    expect(spec).toContain("page.keyboard.press('Meta+Shift+I')");
    expect(spec).toContain('activePixelObservation(page, pixelPoint.x, pixelPoint.y)');
    expect(spec).toContain("window.aidraw.undo(documentId)");
    expect(spec).toContain("expect(timelineBoundary.height).toBe(138)");
    expect(spec).toContain('unexpectedRendererRequests).toEqual([])');
    expect(spec).toContain("'--quit-engine'");
    expect(spec).toContain('writeUx09ExclusiveRecord(configured.paths.cleanup, cleanupSerialized)');
    expect(spec.match(/screenshotRecord\(page, configured\.screenshots\[\d\]\)/g)).toHaveLength(3);
    expect(spec).not.toMatch(/\.kill\s*\(/);
    expect(spec).not.toMatch(/\brm\s*\(/);
    expect(styles).toContain('.panel-tabs { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(3.25rem, 1fr); height: max(52px, calc(31px + 1.25rem));');
    expect(styles).toContain('.frame-strip > button { width: max(62px, calc(5rem - 18px));');
    expect(wrapper).toContain('process.umask(0o077)');
    expect(wrapper).toContain("'--config=playwright.ux09-text-reflow.config.ts'");
    expect(wrapper).not.toMatch(/\.kill\s*\(/);
    expect(wrapper).not.toMatch(/\brm\s*\(/);
    expect(config).toContain("reporter: [['list']]");
    expect(config).toContain("trace: 'off'");
    expect(config).toContain("screenshot: 'off'");
    expect(config).toContain("video: 'off'");
  });
});

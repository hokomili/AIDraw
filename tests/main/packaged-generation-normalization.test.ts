import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertGenerationNormalizationObserverNoForceSource,
  assertPackagedGenerationNormalizationSources,
} from '../../scripts/packaged-generation-normalization.mjs';

const mainSource = [
  'AIDRAW_E2E_GENERATION_NORMALIZATION',
  'AIDRAW_E2E_FND09_NORMALIZATION_PROFILE',
  'FND-09 Generated Preview Normalization',
  'fnd09-normalizable-preview',
  'fnd09-preview-only-preview',
  'fnd09-generation-normalization-fixture-audit.json',
  'fnd09-generation-normalization-forbidden-network.json',
  'original preview is retained unchanged.',
].join('\n');

const workerSource = [
  'normalize-generation-acceptance',
  'fnd09-generation-normalization-ready-probe.json',
  'fnd09-generation-normalization-preview-only-probe.json',
  'FND-09 packaged generated-preview acceptance normalization',
  'electron-utility-process',
].join('\n');

const buildSource = [
  'png-reencode',
  'webp-quality',
  'preview-only',
  '[100,95,90,85,80,75,70,60,50,40,30,20,10,5,1,0]',
  'const inlineLimit=1500000;',
  'Generate a smaller result; AIDraw keeps this provider output available for preview and does not change the document.',
  'Generate a smaller or less complex result; AIDraw keeps this provider output available for preview and does not change the document.',
].join('\n');

describe('packaged generated-preview normalization markers', () => {
  it('accepts only the complete fixed packaged observer contract', () => {
    expect(assertPackagedGenerationNormalizationSources({ mainSource, workerSource, buildSource })).toEqual({
      isolatedFixture: true,
      realUtilityProbe: true,
      fixedQualityLadder: true,
      acceptanceCeiling: 1_500_000,
      retainedPreviewMessaging: true,
      previewOnlyGuidance: true,
    });
  });

  it.each([
    ['fixture gate', mainSource.replace('AIDRAW_E2E_GENERATION_NORMALIZATION', ''), workerSource, buildSource],
    ['private output identity', mainSource.replace('fnd09-normalizable-preview', ''), workerSource, buildSource],
    ['utility probe', mainSource, workerSource.replace('electron-utility-process', ''), buildSource],
    ['preview-only guidance', mainSource, workerSource, buildSource.replace('Generate a smaller result;', 'Try again;')],
    ['quality ladder', mainSource, workerSource, buildSource.replace('100,95,90', '100,90')],
    ['byte ceiling', mainSource, workerSource, buildSource.replace('1500000', '1500001')],
  ])('rejects a package missing the %s contract', (_label, candidateMain, candidateWorker, candidateBuild) => {
    expect(() => assertPackagedGenerationNormalizationSources({ mainSource: candidateMain, workerSource: candidateWorker, buildSource: candidateBuild })).toThrow(/Packaged/);
  });

  it('keeps exactly one immutable, hash-bound, transitively force-free future observer', async () => {
    const source = await readFile(resolve('tests/e2e/editor.spec.ts'), 'utf8');
    const title = "test('FND-09-GENERATION-NORMALIZATION exact package preserves previews and accepts only a bounded derivative'";
    expect(source.split(title)).toHaveLength(2);
    const observer = source.slice(source.indexOf(title));
    expect(observer).toContain('AIDRAW_E2E_FND09_NORMALIZATION_EXE_SHA256');
    expect(observer).toContain('AIDRAW_E2E_FND09_NORMALIZATION_ASAR_SHA256');
    expect(observer).toContain('gracefulOnlyCleanup = true');
    expect(observer).toContain('redacted-after-graceful-stop');
    expect(observer).toContain('publicJobSummaryRedacted: true');
    expect(observer).not.toContain('.kill(');
    expect(observer).not.toContain('rm(');
    expect(assertGenerationNormalizationObserverNoForceSource(source)).toEqual({
      scenario: 'FND-09-GENERATION-NORMALIZATION',
      gracefulOnlyBeforeLaunch: true,
      signalTimeoutRejectsWithoutControl: true,
      quitTimeoutRejectsWithoutControl: true,
      gracefulAfterEachForceFree: true,
      accessibleToastTargeting: true,
      checkedSlices: 5,
    });
  });

  it.each([
    ['preview-only toast', ".filter({ hasText: 'outside the 8192px / 16777216-pixel editable-asset limit' })"],
    ['accepted toast', ".filter({ hasText: 'Generated result accepted as a new editable layer/cel' })"],
  ])('rejects page-wide role uniqueness for the %s', async (_label, filter) => {
    const source = await readFile(resolve('tests/e2e/editor.spec.ts'), 'utf8');
    expect(source).toContain(filter);
    expect(() => assertGenerationNormalizationObserverNoForceSource(source.replace(filter, ''))).toThrow(/two accessible status toasts/);
  });

  it.each([
    ['profile signal kill', "await waitForOwnedProcessExit(child, 'The isolated engine signal', 5_000);", "await waitForOwnedProcessExit(child, 'The isolated engine signal', 5_000); child.kill();"],
    ['process kill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); process.kill(child.pid!);"],
    ['Windows taskkill', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); spawn('taskkill.exe', ['/PID', String(child.pid)]);"],
    ['PowerShell Stop-Process', "child.removeListener('exit', onExit);", "child.removeListener('exit', onExit); spawn('powershell.exe', ['Stop-Process']);"],
  ])('rejects a normalization observer that regains %s behavior', async (_label, target, replacement) => {
    const source = await readFile(resolve('tests/e2e/editor.spec.ts'), 'utf8');
    expect(source).toContain(target);
    expect(() => assertGenerationNormalizationObserverNoForceSource(source.replace(target, replacement))).toThrow(/forbidden force-control behavior/);
  });

  it('rejects launch before the graceful-only contract is active', async () => {
    const source = await readFile(resolve('tests/e2e/editor.spec.ts'), 'utf8');
    const observerStart = source.indexOf("test('FND-09-GENERATION-NORMALIZATION exact package");
    const prefix = source.slice(0, observerStart);
    const observer = source.slice(observerStart).replace('gracefulOnlyCleanup = true;', '');
    expect(() => assertGenerationNormalizationObserverNoForceSource(prefix + observer)).toThrow(/enable graceful-only cleanup before/);
  });
});

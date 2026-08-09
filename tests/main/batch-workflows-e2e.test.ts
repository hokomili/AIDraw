import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIllustrationDocument } from '@aidraw/core';
import {
  UX11_BATCH_E2E_CONNECTION_FILE,
  UX11_BATCH_E2E_EXPORT_DIRECTORY,
  UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME,
  UX11_BATCH_E2E_PROFILE_PREFIX,
  UX11_BATCH_E2E_SAVE_DIRECTORY,
  UX11_BATCH_E2E_SHARED_DOCUMENT_NAME,
  Ux11BatchE2eController,
  installUx11BatchE2eNetworkBoundary,
  resolveUx11BatchE2eConfiguration,
} from '../../src/main/batch-workflows-e2e';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aidraw-ux11-e2e-'));
  roots.push(workspace);
  const testResults = join(workspace, 'test-results');
  const profile = join(testResults, `${UX11_BATCH_E2E_PROFILE_PREFIX}unit`);
  const connection = join(profile, UX11_BATCH_E2E_CONNECTION_FILE);
  await mkdir(profile, { recursive: true });
  const configuration = resolveUx11BatchE2eConfiguration({
    nodeEnv: 'test',
    enabled: '1',
    workspacePath: workspace,
    declaredProfilePath: profile,
    userDataPath: profile,
    connectionPath: connection,
  });
  if (!configuration) throw new Error('The valid UX-11 fixture did not resolve.');
  return { workspace, testResults, profile, connection, configuration };
}

describe('UX-11 packaged workflow boundary', () => {
  it('fails closed unless the declared profile and connection are exact test-results direct children', async () => {
    const { workspace, testResults, profile, connection } = await fixture();
    const base = {
      nodeEnv: 'test',
      enabled: '1',
      workspacePath: workspace,
      declaredProfilePath: profile,
      userDataPath: profile,
      connectionPath: connection,
    };
    expect(resolveUx11BatchE2eConfiguration(base)).toBeDefined();
    expect(resolveUx11BatchE2eConfiguration({ ...base, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveUx11BatchE2eConfiguration({ ...base, declaredProfilePath: `${profile}-other` })).toBeUndefined();
    expect(resolveUx11BatchE2eConfiguration({ ...base, userDataPath: join(testResults, 'wrong-prefix') })).toBeUndefined();
    expect(resolveUx11BatchE2eConfiguration({ ...base, connectionPath: join(profile, 'other.json') })).toBeUndefined();
    expect(resolveUx11BatchE2eConfiguration({ ...base, userDataPath: join(workspace, `${UX11_BATCH_E2E_PROFILE_PREFIX}outside`), declaredProfilePath: join(workspace, `${UX11_BATCH_E2E_PROFILE_PREFIX}outside`) })).toBeUndefined();
  });

  it('drives only the exact cancel/choose/confirm sequence and records a sanitized audit', async () => {
    const { configuration } = await fixture();
    const controller = new Ux11BatchE2eController(configuration);
    const saveRequest = { kind: 'save-all' as const, title: 'Choose a folder for 3 unsaved drawings' };
    const exportRequest = { kind: 'batch-export' as const, title: 'Choose a batch export folder' };
    const closeRequest = {
      title: 'Close all drawings' as const,
      message: '3 drawings have unsaved changes.',
      detail: `• ${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}\n• ${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}\n• ${UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME}`,
      buttons: ['Save all and close', 'Cancel', 'Discard all'] as const,
    };

    await expect(controller.selectDirectory(saveRequest)).resolves.toBeUndefined();
    await expect(controller.selectDirectory(saveRequest)).resolves.toBe(configuration.saveDirectory);
    await expect(controller.selectDirectory(exportRequest)).resolves.toBeUndefined();
    await expect(controller.selectDirectory(exportRequest)).resolves.toBe(configuration.exportDirectory);
    await expect(controller.confirmCloseAll(closeRequest)).resolves.toBe('cancel');
    await expect(controller.confirmCloseAll(closeRequest)).resolves.toBe('save-all');
    expect(await access(join(configuration.profilePath, UX11_BATCH_E2E_SAVE_DIRECTORY)).then(() => true, () => false)).toBe(true);
    expect(await access(join(configuration.profilePath, UX11_BATCH_E2E_EXPORT_DIRECTORY)).then(() => true, () => false)).toBe(true);
    const auditText = await readFile(configuration.auditPath, 'utf8');
    const audit = JSON.parse(auditText) as { events: Array<{ kind: string; decision: string }>; externalRequests: number; providerRequests: number; paidRequests: number };
    expect(audit.events.map((event) => [event.kind, event.decision])).toEqual([
      ['save-all-directory', 'cancel'],
      ['save-all-directory', 'choose-directory'],
      ['batch-export-directory', 'cancel'],
      ['batch-export-directory', 'choose-directory'],
      ['close-all-confirmation', 'cancel'],
      ['close-all-confirmation', 'save-all-and-close'],
    ]);
    expect(audit).toMatchObject({ externalRequests: 0, providerRequests: 0, paidRequests: 0 });
    expect(auditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    expect(controller.shouldFailExport(createIllustrationDocument(UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME), 'png')).toBe(true);
    expect(controller.shouldFailExport(createIllustrationDocument(UX11_BATCH_E2E_SHARED_DOCUMENT_NAME), 'png')).toBe(false);
    await expect(controller.selectDirectory(saveRequest)).rejects.toThrow(/sequence was exhausted/);
  });

  it('blocks an unexpected external fetch and writes only the bounded sentinel', async () => {
    const { configuration } = await fixture();
    const restore = installUx11BatchE2eNetworkBoundary(configuration);
    try {
      await expect(fetch('https://provider.invalid/generate')).rejects.toThrow(/blocked an external request/);
      const sentinel = JSON.parse(await readFile(configuration.networkSentinelPath, 'utf8')) as Record<string, unknown>;
      expect(sentinel).toMatchObject({ fixture: 'ux11-batch-workflows', blocked: true, hostname: 'provider.invalid', externalRequests: 1, paidRequests: 0 });
      expect(JSON.stringify(sentinel)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    } finally {
      restore();
    }
  });
});

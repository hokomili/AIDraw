import { describe, expect, it } from 'vitest';
import { assertForceStopIdentity, buildRedactedConnection, type ForceStopIdentityInput } from '../../scripts/qa-session-safety.mjs';

const baseline: ForceStopIdentityInput = {
  manifest: {
    pid: 4312,
    exe: 'C:\\builds\\AIDraw.exe',
    exeSha256: 'ABC123',
    profile: 'C:\\qa runs\\profile one',
    mcpUrl: 'http://127.0.0.1:48200/mcp',
    trustedFolders: ['C:\\qa runs\\output'],
  },
  connection: {
    version: 1,
    pid: 4312,
    url: 'http://127.0.0.1:48200/mcp',
    token: 'PRIVATE-BEARER-TOKEN',
    activeDocumentId: 'doc-1',
  },
  currentExeSha256: 'ABC123',
  processIdentity: {
    pid: 4312,
    executablePath: 'c:\\BUILDS\\aidraw.exe',
    commandLine: '"C:\\builds\\AIDraw.exe" "--user-data-dir=C:\\qa runs\\profile one" --write-mcp-connection=C:\\qa.json',
  },
  platform: 'win32',
};

describe('QA session force-stop safety', () => {
  it('accepts only a live process matching PID, URL, hash, executable, and exact profile', () => {
    expect(assertForceStopIdentity(baseline)).toEqual({
      pid: baseline.manifest.pid,
      mcpUrl: baseline.manifest.mcpUrl,
      exeSha256: baseline.manifest.exeSha256,
      exe: baseline.manifest.exe,
      profile: baseline.manifest.profile,
    });
  });

  const mismatches: Array<[string, ForceStopIdentityInput, RegExp]> = [
    ['connection PID', { ...baseline, connection: { ...baseline.connection, pid: 99 } }, /connection PID/],
    ['live PID', { ...baseline, processIdentity: { ...baseline.processIdentity, pid: 99 } }, /live process PID/],
    ['URL', { ...baseline, connection: { ...baseline.connection, url: 'http://127.0.0.1:48201/mcp' } }, /connection URL/],
    ['loopback URL', { ...baseline, manifest: { ...baseline.manifest, mcpUrl: 'https://example.test/mcp' }, connection: { ...baseline.connection, url: 'https://example.test/mcp' } }, /loopback-only/],
    ['hash', { ...baseline, currentExeSha256: 'CHANGED' }, /SHA-256/],
    ['executable', { ...baseline, processIdentity: { ...baseline.processIdentity, executablePath: 'C:\\other\\AIDraw.exe' } }, /executable/],
    ['profile', { ...baseline, processIdentity: { ...baseline.processIdentity, commandLine: '"C:\\builds\\AIDraw.exe" --user-data-dir=C:\\qa-runs\\other' } }, /exact manifest profile/],
    ['profile prefix', { ...baseline, processIdentity: { ...baseline.processIdentity, commandLine: '"C:\\builds\\AIDraw.exe" "--user-data-dir=C:\\qa runs\\profile one-extra"' } }, /exact manifest profile/],
  ];

  it.each(mismatches)('refuses a mismatched %s before termination', (_label, input, expected) => {
    expect(() => assertForceStopIdentity(input)).toThrow(expected);
  });

  it('redacts bearer credentials while preserving non-secret cleanup identity', () => {
    const redacted = buildRedactedConnection(baseline.connection, baseline.manifest, '2026-08-05T00:00:00.000Z');
    expect(redacted).toEqual({
      version: 1,
      url: baseline.manifest.mcpUrl,
      activeDocumentId: 'doc-1',
      pid: baseline.manifest.pid,
      trustedFolders: baseline.manifest.trustedFolders,
      stoppedAt: '2026-08-05T00:00:00.000Z',
      credentialsRedacted: true,
    });
    expect(JSON.stringify(redacted)).not.toContain(baseline.connection.token);
    expect(redacted).not.toHaveProperty('token');
  });
});

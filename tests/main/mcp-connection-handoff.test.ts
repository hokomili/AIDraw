import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMcpConnectionHandoff, resolveMcpConnectionHandoffPath, writeMcpConnectionHandoff } from '../../src/main/mcp-connection-handoff';
import { initializeDirectMcp, parseMcpConnectionHandoff as parseQaHandoff } from '../../scripts/mcp-direct-client.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-mcp-handoff-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'connection.json') };
}

const handoff = {
  version: 2 as const,
  authority: 'engine-process' as const,
  url: 'http://127.0.0.1:48200/mcp',
  token: 'A'.repeat(43),
  activeDocumentId: 'document-1',
  pid: 1234,
  trustedFolders: ['/approved/project'],
};

describe('MCP connection handoff', () => {
  it('keeps production and every maintained QA/package consumer on one strict version-two shape', () => {
    expect(parseMcpConnectionHandoff(handoff)).toEqual(handoff);
    expect(parseQaHandoff(handoff)).toEqual(handoff);
    for (const invalid of [
      { ...handoff, version: 1 },
      { ...handoff, authority: 'engine-run' },
      { ...handoff, token: 'short' },
      { ...handoff, unexpected: true },
      { ...handoff, trustedFolders: ['relative'] },
      { ...handoff, trustedFolders: ['/approved/project', '/approved/project'] },
    ]) {
      expect(parseMcpConnectionHandoff(invalid)).toBeUndefined();
      expect(parseQaHandoff(invalid)).toBeUndefined();
    }
  });
  it('carries the negotiated protocol version with the session ID on every post-initialize request', async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'aidraw', version: 'test' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-v2' },
        });
      }
      return new Response('', { status: 202 });
    };
    const initialized = await initializeDirectMcp(handoff, { fetch, clientInfo: { name: 'shared-helper-test', version: '1.0.0' } });
    expect(initialized.protocolVersion).toBe('2026-07-28');
    expect(requests[0].headers.get('mcp-protocol-version')).toBeNull();
    expect(requests[1].headers.get('mcp-session-id')).toBe('session-v2');
    expect(requests[1].headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(requests[1].body).toMatchObject({ method: 'notifications/initialized' });
  });
  it('labels the explicitly requested file as process-lifetime authority', () => {
    expect(handoff).toMatchObject({ version: 2, authority: 'engine-process', pid: 1234 });
  });
  it('admits only the documented absolute output path', () => {
    expect(() => resolveMcpConnectionHandoffPath('')).toThrow('--write-mcp-connection requires a non-empty absolute path.');
    expect(() => resolveMcpConnectionHandoffPath('connection.json')).toThrow('--write-mcp-connection requires a non-empty absolute path.');
    const unnormalized = `${join(tmpdir(), 'handoffs')}${sep}..${sep}connection.json`;
    expect(resolveMcpConnectionHandoffPath(unnormalized)).toBe(join(tmpdir(), 'connection.json'));
  });

  it('keeps the prior artifact visible until one private complete replacement', async () => {
    const value = await fixture();
    const prior = Buffer.from('{"old":true}\n', 'utf8');
    await writeFile(value.path, prior);
    if (process.platform !== 'win32') await chmod(value.path, 0o644);

    const replaceFile = vi.fn(async (source: string, destination: string) => {
      expect(await readFile(destination)).toEqual(prior);
      expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(handoff);
      if (process.platform !== 'win32') expect((await stat(source)).mode & 0o777).toBe(0o600);
      await rename(source, destination);
    });

    await writeMcpConnectionHandoff(value.path, handoff, replaceFile);

    expect(replaceFile).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual(handoff);
    expect(await readdir(value.directory)).toEqual(['connection.json']);
    if (process.platform !== 'win32') expect((await stat(value.path)).mode & 0o777).toBe(0o600);
  });

  it('preserves the prior artifact and cleans its private temporary when replacement fails', async () => {
    const value = await fixture();
    const prior = Buffer.from('{"old":true}\n', 'utf8');
    await writeFile(value.path, prior);

    await expect(writeMcpConnectionHandoff(value.path, handoff, async () => {
      throw new Error('Injected connection-handoff replacement failure.');
    })).rejects.toThrow('Injected connection-handoff replacement failure.');

    expect(await readFile(value.path)).toEqual(prior);
    expect(await readdir(value.directory)).toEqual(['connection.json']);
  });

  it('binds production headless bootstrap to the private handoff writer', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');
    expect(source).toContain("resolveMcpConnectionHandoffPath(explicitMcpConnectionArgument.slice('--write-mcp-connection='.length))");
    expect(source).toContain('await writeMcpConnectionHandoff(connectionPath, {');
    expect(source).not.toContain('writeFile(connectionPath,');
  });

  it('keeps every retained direct QA/E2E route on the shared parser and negotiated-header helper', async () => {
    const routes = [
      'scripts/qa-mcp.mjs',
      'scripts/qa-session.mjs',
      'scripts/luna-finalize.mjs',
      'scripts/luna-mcp-pixel-animation.mjs',
      'scripts/finalize-matrix-workspace.mjs',
      'tests/e2e/editor.spec.ts',
      'tests/e2e/security.spec.ts',
      'tests/e2e/mcp-discovery.spec.ts',
      'tests/e2e/stale-renderer-recovery.spec.ts',
      'tests/e2e/utility-containment.spec.ts',
      'tests/e2e/editor-text-reflow.spec.ts',
      'tests/e2e/editor-density.spec.ts',
    ];
    for (const route of routes) {
      const contents = await readFile(resolve(route), 'utf8');
      expect(contents, route).toContain('mcp-direct-client.mjs');
      expect(contents, route).not.toMatch(/protocolVersion:\s*['"]2026-07-28['"]/u);
      expect(contents, route).not.toMatch(/['"]mcp-session-id['"]:\s*sessionId/u);
    }
    const finalizer = await readFile(resolve('scripts/finalize-matrix-workspace.mjs'), 'utf8');
    expect(finalizer).toContain('AIDRAW_MCP_CONNECTION_HANDOFF');
    expect(finalizer).not.toMatch(/CODEX_CONFIG|Authorization\s*=\s*["']Bearer/u);
  });
});

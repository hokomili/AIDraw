import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMcpConnectionHandoffPath, writeMcpConnectionHandoff } from '../../src/main/mcp-connection-handoff';

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
  version: 1 as const,
  url: 'http://127.0.0.1:48200/mcp',
  token: 'private-bearer-token',
  activeDocumentId: 'document-1',
  pid: 1234,
  trustedFolders: ['/approved/project'],
};

describe('MCP connection handoff', () => {
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
});

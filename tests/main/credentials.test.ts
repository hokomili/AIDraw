import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  encryptString: vi.fn((value: string) => Buffer.from(`protected:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^protected:/, '')),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: storage.encryptString,
    decryptString: storage.decryptString,
  },
}));

import { LocalCredentialStore } from '../../src/main/credentials';
import { MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES } from '../../src/main/secure-storage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  storage.encryptString.mockClear();
  storage.decryptString.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; path: string; store: LocalCredentialStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-mcp-credentials-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'mcp-token.json');
  return { directory, path, store: new LocalCredentialStore(path) };
}

describe('local MCP credential storage', () => {
  it('creates one encrypted token and reopens the same value without exposing it in the file', async () => {
    const value = await fixture();
    const created = await value.store.loadOrCreateToken();
    const source = await readFile(value.path, 'utf8');

    expect(created).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(source).not.toContain(created);
    expect(storage.encryptString).toHaveBeenCalledWith(created);
    await expect(value.store.loadOrCreateToken()).resolves.toBe(created);
    expect(storage.decryptString).toHaveBeenCalledOnce();
  });

  it('rotates an over-ceiling credential file without passing its bytes to secure storage', async () => {
    const value = await fixture();
    await writeFile(value.path, Buffer.alloc(MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES + 1, 0x78));

    const rotated = await value.store.loadOrCreateToken();
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect((await readFile(value.path)).byteLength).toBeLessThan(MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES);
  });

  it('routes both encrypted credential files through the shared bounded reader', async () => {
    const [mcpSource, providerSource] = await Promise.all([
      readFile(join(process.cwd(), 'src/main/credentials.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/provider-credentials.ts'), 'utf8'),
    ]);
    expect(mcpSource).toContain("readEncryptedCredentialFile(this.tokenPath, 'MCP credential file')");
    expect(providerSource).toContain("readEncryptedCredentialFile(this.filePath, 'Provider credential file')");
    expect(`${mcpSource}\n${providerSource}`).not.toContain('await readFile(');
  });
});

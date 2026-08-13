import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

import { LocalCredentialStore, type LocalCredentialStoreOptions } from '../../src/main/credentials';
import { MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES } from '../../src/main/secure-storage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  storage.encryptString.mockClear();
  storage.decryptString.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: LocalCredentialStoreOptions = {}): Promise<{ directory: string; path: string; store: LocalCredentialStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-mcp-credentials-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'mcp-token.json');
  return { directory, path, store: new LocalCredentialStore(path, options) };
}

describe('local MCP credential storage', () => {
  it('creates one encrypted token and reopens the same value without exposing it in the file', async () => {
    const value = await fixture();
    const [created, concurrent] = await Promise.all([value.store.loadOrCreateToken(), value.store.loadOrCreateToken()]);
    const source = await readFile(value.path, 'utf8');

    expect(created).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(concurrent).toBe(created);
    expect(source).not.toContain(created);
    expect(storage.encryptString).toHaveBeenCalledWith(created);
    expect(storage.encryptString).toHaveBeenCalledOnce();
    expect(storage.decryptString).toHaveBeenCalledOnce();
    await expect(value.store.loadOrCreateToken()).resolves.toBe(created);
    expect(storage.decryptString).toHaveBeenCalledTimes(2);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);
    if (process.platform !== 'win32') expect((await stat(value.path)).mode & 0o777).toBe(0o600);
  });

  it('accepts only exact writer-shaped ciphertext that decrypts to a canonical token', async () => {
    const value = await fixture();
    await writeFile(value.path, JSON.stringify({
      version: 1,
      encryption: 'electron-safe-storage',
      value: Buffer.from('protected:short-token', 'utf8').toString('base64'),
      unexpected: true,
    }));

    const rotatedUnknownField = await value.store.loadOrCreateToken();
    expect(rotatedUnknownField).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({
      version: 1,
      encryption: 'electron-safe-storage',
      value: Buffer.from(`protected:${rotatedUnknownField}`, 'utf8').toString('base64'),
    });

    await writeFile(value.path, JSON.stringify({
      version: 1,
      encryption: 'electron-safe-storage',
      value: Buffer.from('protected:short-token', 'utf8').toString('base64'),
    }));
    const rotatedInvalidToken = await value.store.loadOrCreateToken();
    expect(rotatedInvalidToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotatedInvalidToken).not.toBe(rotatedUnknownField);
    expect(storage.decryptString).toHaveBeenCalledOnce();
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);
  });

  it('preserves prior bytes on replacement failure, cleans its temporary, and recovers the queue', async () => {
    let replacements = 0;
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      replacements += 1;
      if (replacements === 1) throw new Error('Injected MCP token replacement failure.');
      await rename(source, destination);
    });
    const value = await fixture({ replaceFile });
    const corrupt = Buffer.from('{"corrupt":true}\n', 'utf8');
    await writeFile(value.path, corrupt);

    storage.encryptString.mockReturnValueOnce(Buffer.alloc(0));
    await expect(value.store.loadOrCreateToken()).rejects.toThrow('Secure credential storage returned an invalid encrypted value.');
    expect(await readFile(value.path)).toEqual(corrupt);
    expect(replaceFile).not.toHaveBeenCalled();

    await expect(value.store.loadOrCreateToken()).rejects.toThrow('Injected MCP token replacement failure.');
    expect(await readFile(value.path)).toEqual(corrupt);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);

    const recovered = await value.store.loadOrCreateToken();
    expect(recovered).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replaceFile).toHaveBeenCalledTimes(2);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);
    await expect(value.store.loadOrCreateToken()).resolves.toBe(recovered);
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

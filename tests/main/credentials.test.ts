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
let generatedTokenSequence = 1;

function fakeToken(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url');
}

afterEach(async () => {
  storage.encryptString.mockClear();
  storage.decryptString.mockClear();
  generatedTokenSequence = 1;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: LocalCredentialStoreOptions = {}): Promise<{ directory: string; path: string; store: LocalCredentialStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-mcp-credentials-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'mcp-token.json');
  return {
    directory,
    path,
    store: new LocalCredentialStore(path, {
      generateToken: () => fakeToken(generatedTokenSequence++),
      ...options,
    }),
  };
}

describe('local MCP credential storage', () => {
  it('creates one encrypted token and reopens the same value without exposing it in the file', async () => {
    const value = await fixture();
    const [created, concurrent] = await Promise.all([value.store.loadOrCreate(), value.store.loadOrCreate()]);
    expect(created.status).toBe('active');
    expect(concurrent.status).toBe('active');
    const token = created.status === 'active' ? created.token : '';
    const source = await readFile(value.path, 'utf8');

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(concurrent).toEqual(created);
    expect(source).not.toContain(token);
    expect(storage.encryptString).toHaveBeenCalledWith(token);
    expect(storage.encryptString).toHaveBeenCalledOnce();
    expect(storage.decryptString).toHaveBeenCalledOnce();
    await expect(value.store.loadOrCreate()).resolves.toEqual(created);
    expect(storage.decryptString).toHaveBeenCalledTimes(2);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);
    expect(JSON.parse(source)).toMatchObject({ version: 2, status: 'active', encryption: 'electron-safe-storage' });
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

    const rotatedUnknownField = await value.store.loadOrCreate();
    expect(rotatedUnknownField.status).toBe('active');
    const firstToken = rotatedUnknownField.status === 'active' ? rotatedUnknownField.token : '';
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({
      version: 2,
      status: 'active',
      encryption: 'electron-safe-storage',
      value: Buffer.from(`protected:${firstToken}`, 'utf8').toString('base64'),
    });

    await writeFile(value.path, JSON.stringify({
      version: 1,
      encryption: 'electron-safe-storage',
      value: Buffer.from('protected:short-token', 'utf8').toString('base64'),
    }));
    const rotatedInvalidToken = await value.store.loadOrCreate();
    expect(rotatedInvalidToken.status).toBe('active');
    const secondToken = rotatedInvalidToken.status === 'active' ? rotatedInvalidToken.token : '';
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).not.toBe(firstToken);
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
    await expect(value.store.loadOrCreate()).rejects.toThrow('Secure credential storage returned an invalid encrypted value.');
    expect(await readFile(value.path)).toEqual(corrupt);
    expect(replaceFile).not.toHaveBeenCalled();

    await expect(value.store.loadOrCreate()).rejects.toThrow('Injected MCP token replacement failure.');
    expect(await readFile(value.path)).toEqual(corrupt);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);

    const recovered = await value.store.loadOrCreate();
    expect(recovered.status).toBe('active');
    expect(replaceFile).toHaveBeenCalledTimes(2);
    expect(await readdir(value.directory)).toEqual(['mcp-token.json']);
    await expect(value.store.loadOrCreate()).resolves.toEqual(recovered);
  });

  it('rotates an over-ceiling credential file without passing its bytes to secure storage', async () => {
    const value = await fixture();
    await writeFile(value.path, Buffer.alloc(MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES + 1, 0x78));

    const rotated = await value.store.loadOrCreate();
    expect(rotated.status).toBe('active');
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect((await readFile(value.path)).byteLength).toBeLessThan(MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES);
  });

  it('reads legacy active state, rotates only after atomic persistence, and preserves the prior credential on failure', async () => {
    const replacementOrder: string[] = [];
    let failReplacement = false;
    const value = await fixture({
      generateToken: () => fakeToken(7),
      replaceFile: async (source, destination) => {
        replacementOrder.push('replace');
        if (failReplacement) throw new Error('Injected rotation failure.');
        await rename(source, destination);
      },
    });
    const legacyToken = fakeToken(6);
    await writeFile(value.path, JSON.stringify({
      version: 1,
      encryption: 'electron-safe-storage',
      value: Buffer.from(`protected:${legacyToken}`, 'utf8').toString('base64'),
    }));

    await expect(value.store.loadOrCreate()).resolves.toEqual({ status: 'active', token: legacyToken });
    const rotated = await value.store.rotate();
    expect(rotated).toBe(fakeToken(7));
    expect(replacementOrder).toEqual(['replace']);
    const persisted = JSON.parse(await readFile(value.path, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({ version: 2, status: 'active', encryption: 'electron-safe-storage' });
    expect(JSON.stringify(persisted)).not.toContain(rotated);

    const prior = await readFile(value.path);
    failReplacement = true;
    await expect(value.store.rotate()).rejects.toThrow('Injected rotation failure.');
    expect(await readFile(value.path)).toEqual(prior);
    expect((await readdir(value.directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('persists revocation without ciphertext and does not silently reactivate on load', async () => {
    const value = await fixture();
    await value.store.loadOrCreate();
    storage.encryptString.mockClear();
    storage.decryptString.mockClear();

    await value.store.revoke();
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 2, status: 'revoked' });
    await expect(value.store.loadOrCreate()).resolves.toEqual({ status: 'revoked' });
    expect(storage.encryptString).not.toHaveBeenCalled();
    expect(storage.decryptString).not.toHaveBeenCalled();

    const replacement = await value.store.rotate();
    expect(replacement).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(value.store.loadOrCreate()).resolves.toEqual({ status: 'active', token: replacement });
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

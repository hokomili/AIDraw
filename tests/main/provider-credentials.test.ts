import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROVIDER_CREDENTIAL_BYTES } from '../../src/common/generation';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { ProviderCredentialStore, type ProviderCredentialStoreOptions } from '../../src/main/provider-credentials';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: ProviderCredentialStoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-provider-credentials-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'generation.json');
  const encryptString = vi.fn((value: string) => Buffer.from(`protected:${value}`, 'utf8'));
  const decryptString = vi.fn((value: Buffer) => value.toString('utf8').replace(/^protected:/, ''));
  const storage = { isEncryptionAvailable: () => true, encryptString, decryptString };
  return {
    directory,
    path,
    storage,
    encryptString,
    decryptString,
    store: new ProviderCredentialStore(path, { platform: 'win32', storage, ...options }),
  };
}

describe('provider credential lifecycle', () => {
  it('serializes concurrent providers, rotates atomically, and removes only the selected encrypted value', async () => {
    const value = await fixture();
    await Promise.all([
      value.store.set('openai', '  openai-secret  '),
      value.store.set('stability', 'stability-secret'),
    ]);

    expect(await value.store.get('openai')).toBe('openai-secret');
    expect(await value.store.get('stability')).toBe('stability-secret');
    expect(await value.store.status()).toEqual({
      openai: { configured: true, stored: true, available: true },
      stability: { configured: true, stored: true, available: true },
      comfyui: { configured: true, stored: false, available: true },
    });

    const firstRaw = await readFile(value.path, 'utf8');
    expect(firstRaw).toContain('"encryption": "windows-dpapi"');
    expect(firstRaw).not.toMatch(/openai-secret|stability-secret|protected:/);
    expect(JSON.stringify(await value.store.status())).not.toContain(Buffer.from('protected:openai-secret').toString('base64'));
    expect(await readdir(value.directory)).toEqual(['generation.json']);

    await value.store.set('openai', 'rotated-openai-secret');
    expect(await value.store.get('openai')).toBe('rotated-openai-secret');
    expect(await value.store.get('stability')).toBe('stability-secret');
    const rotatedRaw = await readFile(value.path, 'utf8');
    expect(rotatedRaw).not.toContain(Buffer.from('protected:openai-secret').toString('base64'));
    expect(rotatedRaw).toContain(Buffer.from('protected:rotated-openai-secret').toString('base64'));
    expect(rotatedRaw).toContain(Buffer.from('protected:stability-secret').toString('base64'));
    expect(await readdir(value.directory)).toEqual(['generation.json']);

    await value.store.set('openai', '');
    expect(await value.store.get('openai')).toBeUndefined();
    expect(await value.store.get('stability')).toBe('stability-secret');
    expect(await value.store.status()).toMatchObject({ openai: { configured: false, stored: false }, stability: { configured: true, stored: true } });
    expect(await readdir(value.directory)).toEqual(['generation.json']);

    await value.store.set('stability', '   ');
    await expect(access(value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await value.store.status()).toMatchObject({ openai: { configured: false, stored: false }, stability: { configured: false, stored: false } });
  });

  it('preserves the prior file and cleans the temporary when encryption, replacement, or input validation rejects a rotation', async () => {
    const value = await fixture();
    await value.store.set('openai', 'original-secret');
    const before = await readFile(value.path);

    value.encryptString.mockImplementationOnce(() => { throw new Error('DPAPI rotation failed'); });
    await expect(value.store.set('openai', 'replacement-secret')).rejects.toThrow('DPAPI rotation failed');
    expect(await readFile(value.path)).toEqual(before);
    expect(await value.store.get('openai')).toBe('original-secret');

    const failedReplace = vi.fn(async () => { throw new Error('atomic credential replacement failed'); });
    const replacementFailure = new ProviderCredentialStore(value.path, { platform: 'win32', storage: value.storage, replaceFile: failedReplace });
    await expect(replacementFailure.set('openai', 'replacement-secret')).rejects.toThrow('atomic credential replacement failed');
    expect(failedReplace).toHaveBeenCalledTimes(1);
    expect(await readFile(value.path)).toEqual(before);
    expect(await value.store.get('openai')).toBe('original-secret');
    expect(await readdir(value.directory)).toEqual(['generation.json']);

    await expect(value.store.set('openai', 'x'.repeat(MAX_PROVIDER_CREDENTIAL_BYTES + 1))).rejects.toThrow(`${MAX_PROVIDER_CREDENTIAL_BYTES} UTF-8 bytes`);
    expect(await readFile(value.path)).toEqual(before);
    expect(await readdir(value.directory)).toEqual(['generation.json']);
  });

  it('reports unavailable DPAPI without decrypting or exposing ciphertext, but still permits removal', async () => {
    const value = await fixture();
    await value.store.set('openai', 'stored-secret');
    const before = await readFile(value.path);
    const unavailableStorage = {
      isEncryptionAvailable: () => false,
      encryptString: vi.fn(() => Buffer.from('must-not-encrypt')),
      decryptString: vi.fn(() => 'must-not-decrypt'),
    };
    const unavailable = new ProviderCredentialStore(value.path, { platform: 'win32', storage: unavailableStorage });

    const status = await unavailable.status();
    expect(status.openai).toMatchObject({ configured: false, stored: true, available: false, reason: expect.stringContaining('DPAPI') });
    expect(status.stability).toMatchObject({ configured: false, stored: false, available: false, reason: expect.stringContaining('DPAPI') });
    expect(JSON.stringify(status)).not.toMatch(/stored-secret|protected:|cHJvdGVjdGVk/);
    await expect(unavailable.get('openai')).resolves.toBeUndefined();
    expect(unavailableStorage.decryptString).not.toHaveBeenCalled();
    await expect(unavailable.set('stability', 'new-secret')).rejects.toThrow(/DPAPI.*unavailable/i);
    expect(unavailableStorage.encryptString).not.toHaveBeenCalled();
    expect(await readFile(value.path)).toEqual(before);

    await unavailable.set('openai', '');
    await expect(access(value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(unavailableStorage.decryptString).not.toHaveBeenCalled();
  });
});

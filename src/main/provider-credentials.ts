import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { GenerationProvider } from '../common/generation';

type HostedProvider = Exclude<GenerationProvider, 'comfyui'>;
interface CredentialFile { version: 1; encryption: 'windows-dpapi'; values: Partial<Record<HostedProvider, string>> }

export class ProviderCredentialStore {
  constructor(private readonly filePath: string) {}

  async set(provider: HostedProvider, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    const file = await this.read();
    if (value.trim()) file.values[provider] = safeStorage.encryptString(value.trim()).toString('base64');
    else delete file.values[provider];
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async get(provider: HostedProvider): Promise<string | undefined> {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const encrypted = (await this.read()).values[provider];
    return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined;
  }

  async status(): Promise<Record<GenerationProvider, { configured: boolean }>> {
    const file = await this.read();
    return {
      openai: { configured: Boolean(file.values.openai) },
      stability: { configured: Boolean(file.values.stability) },
      comfyui: { configured: true },
    };
  }

  private async read(): Promise<CredentialFile> {
    try {
      const file = JSON.parse(await readFile(this.filePath, 'utf8')) as CredentialFile;
      if (file.version === 1 && file.encryption === 'windows-dpapi' && file.values) return file;
    } catch {
      // Missing or corrupt files begin empty; secrets are never downgraded to plaintext.
    }
    return { version: 1, encryption: 'windows-dpapi', values: {} };
  }
}

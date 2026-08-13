import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import {
  MAX_PROVIDER_CREDENTIAL_BYTES,
  type GenerationProvider,
  type GenerationProviderStatus,
} from '../common/generation';
import { MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES, readEncryptedCredentialFile, requireSecureStorage, secureStorageStatus, type SafeStorageStatusSource } from './secure-storage';

type HostedProvider = Exclude<GenerationProvider, 'comfyui'>;

interface ProviderCredentialEncryption extends SafeStorageStatusSource {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CredentialFile {
  version: 1;
  encryption: 'windows-dpapi' | 'electron-safe-storage';
  values: Partial<Record<HostedProvider, string>>;
}

export interface ProviderCredentialStoreOptions {
  storage?: ProviderCredentialEncryption;
  platform?: NodeJS.Platform;
  /** Narrow deterministic seam for atomic-replacement failure coverage. */
  replaceFile?: (source: string, destination: string) => Promise<void>;
}

const HOSTED_PROVIDERS = ['openai', 'stability'] as const satisfies readonly HostedProvider[];

function emptyCredentialFile(platform: NodeJS.Platform): CredentialFile {
  return { version: 1, encryption: platform === 'win32' ? 'windows-dpapi' : 'electron-safe-storage', values: {} };
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function parseCredentialFile(source: string): CredentialFile | undefined {
  if (Buffer.byteLength(source, 'utf8') > MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES) return undefined;
  const parsed = JSON.parse(source) as Partial<CredentialFile>;
  if (parsed.version !== 1 || !['windows-dpapi', 'electron-safe-storage'].includes(String(parsed.encryption))
    || !parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) return undefined;
  if (Object.keys(parsed.values).some((key) => !HOSTED_PROVIDERS.includes(key as HostedProvider))) return undefined;
  for (const provider of HOSTED_PROVIDERS) {
    const value = parsed.values[provider];
    if (value !== undefined && !canonicalBase64(value)) return undefined;
  }
  return parsed as CredentialFile;
}

export class ProviderCredentialStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly storage: ProviderCredentialEncryption;
  private readonly platform: NodeJS.Platform;
  private readonly replaceFile: (source: string, destination: string) => Promise<void>;

  constructor(private readonly filePath: string, options: ProviderCredentialStoreOptions = {}) {
    this.storage = options.storage ?? safeStorage;
    this.platform = options.platform ?? process.platform;
    this.replaceFile = options.replaceFile ?? rename;
  }

  async set(provider: HostedProvider, value: string): Promise<void> {
    if (!HOSTED_PROVIDERS.includes(provider) || typeof value !== 'string') throw new Error('Unknown hosted provider credential.');
    const normalized = value.trim();
    if (Buffer.byteLength(normalized, 'utf8') > MAX_PROVIDER_CREDENTIAL_BYTES) {
      throw new Error(`Provider credentials must not exceed ${MAX_PROVIDER_CREDENTIAL_BYTES} UTF-8 bytes.`);
    }
    if (normalized) requireSecureStorage(this.storage, this.platform);

    return this.exclusive(async () => {
      const file = await this.read();
      if (normalized) {
        const encrypted = this.storage.encryptString(normalized);
        if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < 1 || encrypted.byteLength > 64 * 1024) {
          throw new Error('Operating-system credential protection returned an invalid encrypted value.');
        }
        file.values[provider] = encrypted.toString('base64');
        await this.persist(file);
        return;
      }

      if (!file.values[provider]) return;
      delete file.values[provider];
      if (HOSTED_PROVIDERS.some((entry) => Boolean(file.values[entry]))) await this.persist(file);
      else await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
  }

  async get(provider: HostedProvider): Promise<string | undefined> {
    if (!HOSTED_PROVIDERS.includes(provider)) throw new Error('Unknown hosted provider credential.');
    if (!secureStorageStatus(this.storage, this.platform).available) return undefined;
    const encrypted = (await this.read()).values[provider];
    if (!encrypted) return undefined;
    const decrypted = this.storage.decryptString(Buffer.from(encrypted, 'base64'));
    if (!decrypted || Buffer.byteLength(decrypted, 'utf8') > MAX_PROVIDER_CREDENTIAL_BYTES) {
      throw new Error('The stored provider credential is invalid.');
    }
    return decrypted;
  }

  async status(): Promise<GenerationProviderStatus> {
    const file = await this.read();
    const secure = secureStorageStatus(this.storage, this.platform);
    const hosted = (provider: HostedProvider) => {
      const stored = Boolean(file.values[provider]);
      return {
        configured: secure.available && stored,
        stored,
        available: secure.available,
        ...(!secure.available && secure.reason ? { reason: secure.reason } : {}),
      };
    };
    return {
      openai: hosted('openai'),
      stability: hosted('stability'),
      comfyui: { configured: true, stored: false, available: true },
    };
  }

  private async read(): Promise<CredentialFile> {
    try {
      return parseCredentialFile(await readEncryptedCredentialFile(this.filePath, 'Provider credential file')) ?? emptyCredentialFile(this.platform);
    } catch {
      // Missing or corrupt files begin empty; secrets are never downgraded to plaintext.
      return emptyCredentialFile(this.platform);
    }
  }

  private async persist(file: CredentialFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    let openHandle = true;
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      openHandle = false;
      await this.replaceFile(temporary, this.filePath);
    } catch (error) {
      if (openHandle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

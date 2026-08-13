import { randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';
import { readEncryptedCredentialFile, requireSecureStorage } from './secure-storage';

interface EncryptedSecretFile {
  version: 1;
  encryption: 'windows-dpapi' | 'electron-safe-storage';
  value: string;
}

const ENCRYPTED_SECRET_KEYS = new Set(['version', 'encryption', 'value']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LocalCredentialStoreOptions {
  replaceFile?: PrivateJsonFileReplacer;
}

function encryptedSecretBytes(value: unknown): Buffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unsupported credential file.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== ENCRYPTED_SECRET_KEYS.size || Object.keys(record).some((key) => !ENCRYPTED_SECRET_KEYS.has(key))
    || record.version !== 1 || !['windows-dpapi', 'electron-safe-storage'].includes(record.encryption as string)
    || typeof record.value !== 'string' || !record.value) throw new Error('Unsupported credential file.');
  const encrypted = Buffer.from(record.value, 'base64');
  if (!encrypted.byteLength || encrypted.toString('base64') !== record.value) throw new Error('Unsupported credential file.');
  return encrypted;
}

function isCanonicalToken(value: string): boolean {
  if (!TOKEN_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
}

export class LocalCredentialStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tokenPath: string,
    private readonly options: LocalCredentialStoreOptions = {},
  ) {}

  loadOrCreateToken(): Promise<string> {
    return this.exclusive(() => this.loadOrCreateTokenQueued());
  }

  private async loadOrCreateTokenQueued(): Promise<string> {
    requireSecureStorage(safeStorage);
    try {
      const encrypted = encryptedSecretBytes(JSON.parse(await readEncryptedCredentialFile(this.tokenPath, 'MCP credential file')));
      const token = safeStorage.decryptString(encrypted);
      if (!isCanonicalToken(token)) throw new Error('Unsupported credential file.');
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // An unreadable/corrupt secret is replaced instead of weakening storage.
      }
      const token = randomBytes(32).toString('base64url');
      const encrypted = safeStorage.encryptString(token);
      if (!encrypted.byteLength) throw new Error('Secure credential storage returned an invalid encrypted value.');
      const file: EncryptedSecretFile = { version: 1, encryption: 'electron-safe-storage', value: encrypted.toString('base64') };
      await replacePrivateJsonFile(this.tokenPath, file, this.options.replaceFile);
      return token;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

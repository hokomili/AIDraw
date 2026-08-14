import { randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';
import { readEncryptedCredentialFile, requireSecureStorage } from './secure-storage';

interface ActiveCredentialFile {
  version: 2;
  status: 'active';
  encryption: 'windows-dpapi' | 'electron-safe-storage';
  value: string;
}

interface RevokedCredentialFile {
  version: 2;
  status: 'revoked';
}

export type LocalCredentialState =
  | { status: 'active'; token: string }
  | { status: 'revoked' };

const LEGACY_ENCRYPTED_SECRET_KEYS = new Set(['version', 'encryption', 'value']);
const ACTIVE_CREDENTIAL_KEYS = new Set(['version', 'status', 'encryption', 'value']);
const REVOKED_CREDENTIAL_KEYS = new Set(['version', 'status']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LocalCredentialStoreOptions {
  replaceFile?: PrivateJsonFileReplacer;
  generateToken?: () => string;
}

function exactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  return Object.keys(record).length === expected.size && Object.keys(record).every((key) => expected.has(key));
}

function parseCredentialFile(value: unknown): { status: 'active'; encrypted: Buffer } | { status: 'revoked' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unsupported credential file.');
  const record = value as Record<string, unknown>;
  if (record.version === 2 && record.status === 'revoked') {
    if (!exactKeys(record, REVOKED_CREDENTIAL_KEYS)) throw new Error('Unsupported credential file.');
    return { status: 'revoked' };
  }
  const legacy = record.version === 1 && exactKeys(record, LEGACY_ENCRYPTED_SECRET_KEYS);
  const active = record.version === 2 && record.status === 'active' && exactKeys(record, ACTIVE_CREDENTIAL_KEYS);
  if ((!legacy && !active) || !['windows-dpapi', 'electron-safe-storage'].includes(record.encryption as string)
    || typeof record.value !== 'string' || !record.value) throw new Error('Unsupported credential file.');
  const encrypted = Buffer.from(record.value, 'base64');
  if (!encrypted.byteLength || encrypted.toString('base64') !== record.value) throw new Error('Unsupported credential file.');
  return { status: 'active', encrypted };
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

  loadOrCreate(): Promise<LocalCredentialState> {
    return this.exclusive(() => this.loadOrCreateQueued());
  }

  rotate(): Promise<string> {
    return this.exclusive(async () => {
      requireSecureStorage(safeStorage);
      const token = this.newToken();
      await this.persistActive(token);
      return token;
    });
  }

  revoke(): Promise<void> {
    return this.exclusive(async () => {
      const file: RevokedCredentialFile = { version: 2, status: 'revoked' };
      await replacePrivateJsonFile(this.tokenPath, file, this.options.replaceFile);
    });
  }

  private async loadOrCreateQueued(): Promise<LocalCredentialState> {
    try {
      const credential = parseCredentialFile(JSON.parse(await readEncryptedCredentialFile(this.tokenPath, 'MCP credential file')));
      if (credential.status === 'revoked') return credential;
      requireSecureStorage(safeStorage);
      const token = safeStorage.decryptString(credential.encrypted);
      if (!isCanonicalToken(token)) throw new Error('Unsupported credential file.');
      return { status: 'active', token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // An unreadable/corrupt secret is replaced instead of weakening storage.
      }
      requireSecureStorage(safeStorage);
      const token = this.newToken();
      await this.persistActive(token);
      return { status: 'active', token };
    }
  }

  private newToken(): string {
    const token = this.options.generateToken?.() ?? randomBytes(32).toString('base64url');
    if (!isCanonicalToken(token)) throw new Error('MCP credential generation returned an invalid value.');
    return token;
  }

  private async persistActive(token: string): Promise<void> {
    const encrypted = safeStorage.encryptString(token);
    if (!encrypted.byteLength) throw new Error('Secure credential storage returned an invalid encrypted value.');
    const file: ActiveCredentialFile = {
      version: 2,
      status: 'active',
      encryption: 'electron-safe-storage',
      value: encrypted.toString('base64'),
    };
    await replacePrivateJsonFile(this.tokenPath, file, this.options.replaceFile);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

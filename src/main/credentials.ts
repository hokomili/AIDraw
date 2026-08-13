import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { readEncryptedCredentialFile, requireSecureStorage } from './secure-storage';

interface EncryptedSecretFile {
  version: 1;
  encryption: 'windows-dpapi' | 'electron-safe-storage';
  value: string;
}
export class LocalCredentialStore {
  constructor(private readonly tokenPath: string) {}

  async loadOrCreateToken(): Promise<string> {
    requireSecureStorage(safeStorage);
    try {
      const file = JSON.parse(await readEncryptedCredentialFile(this.tokenPath, 'MCP credential file')) as EncryptedSecretFile;
      if (file.version !== 1 || !['windows-dpapi', 'electron-safe-storage'].includes(file.encryption)) throw new Error('Unsupported credential file.');
      return safeStorage.decryptString(Buffer.from(file.value, 'base64'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // An unreadable/corrupt secret is replaced instead of weakening storage.
      }
      const token = randomBytes(32).toString('base64url');
      const encrypted = safeStorage.encryptString(token);
      const file: EncryptedSecretFile = { version: 1, encryption: 'electron-safe-storage', value: encrypted.toString('base64') };
      await mkdir(dirname(this.tokenPath), { recursive: true });
      await writeFile(this.tokenPath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
      return token;
    }
  }
}

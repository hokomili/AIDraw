import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';

interface EncryptedSecretFile {
  version: 1;
  encryption: 'windows-dpapi';
  value: string;
}
export class LocalCredentialStore {
  constructor(private readonly tokenPath: string) {}

  async loadOrCreateToken(): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is not available; the MCP server was not started.');
    }
    try {
      const file = JSON.parse(await readFile(this.tokenPath, 'utf8')) as EncryptedSecretFile;
      if (file.version !== 1 || file.encryption !== 'windows-dpapi') throw new Error('Unsupported credential file.');
      return safeStorage.decryptString(Buffer.from(file.value, 'base64'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // An unreadable/corrupt secret is replaced instead of weakening storage.
      }
      const token = randomBytes(32).toString('base64url');
      const encrypted = safeStorage.encryptString(token);
      const file: EncryptedSecretFile = { version: 1, encryption: 'windows-dpapi', value: encrypted.toString('base64') };
      await mkdir(dirname(this.tokenPath), { recursive: true });
      await writeFile(this.tokenPath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
      return token;
    }
  }
}

import { desktopPlatformInfo, type DesktopPlatformInfo } from '../common/platform';
import { readBoundedRegularFile } from './bounded-file-read';

export const MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES = 256 * 1024;

export async function readEncryptedCredentialFile(filePath: string, label: string): Promise<string> {
  const bytes = await readBoundedRegularFile(filePath, {
    maxBytes: MAX_ENCRYPTED_CREDENTIAL_FILE_BYTES,
    minBytes: 1,
    notFileMessage: `${label} is not a regular file.`,
    tooLargeMessage: `${label} exceeds the 256 KiB encrypted-file limit.`,
    tooSmallMessage: `${label} is empty.`,
    changedMessage: `${label} changed while it was being read.`,
  });
  return bytes.toString('utf8');
}

export interface SafeStorageStatusSource {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}

export interface SecureStorageStatus {
  available: boolean;
  platform: DesktopPlatformInfo;
  backend?: string;
  reason?: string;
}

export function secureStorageStatus(source: SafeStorageStatusSource, platform: NodeJS.Platform = process.platform): SecureStorageStatus {
  const encryptionAvailable = source.isEncryptionAvailable();
  if (platform === 'linux') {
    const backend = source.getSelectedStorageBackend?.() ?? 'unknown';
    const platformInfo = desktopPlatformInfo(platform, backend);
    if (!encryptionAvailable || backend === 'unknown') {
      return { available: false, platform: platformInfo, backend, reason: 'A Linux secret store is not available yet.' };
    }
    if (backend === 'basic_text') {
      return { available: false, platform: platformInfo, backend, reason: 'AIDraw refuses Electron’s insecure basic_text credential fallback. Install or unlock a supported system keyring.' };
    }
    return { available: true, platform: platformInfo, backend };
  }
  const platformInfo = desktopPlatformInfo(platform);
  if (platformInfo.id === 'unsupported') return { available: false, platform: platformInfo, reason: `Secure credential storage is not supported on ${platformInfo.label}.` };
  return encryptionAvailable
    ? { available: true, platform: platformInfo }
    : { available: false, platform: platformInfo, reason: `${platformInfo.credentialProtection} is unavailable.` };
}

export function requireSecureStorage(source: SafeStorageStatusSource, platform: NodeJS.Platform = process.platform): SecureStorageStatus {
  const status = secureStorageStatus(source, platform);
  if (!status.available) throw new Error(status.reason ?? 'Operating-system credential protection is unavailable.');
  return status;
}

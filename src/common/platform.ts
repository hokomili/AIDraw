export type DesktopPlatformId = 'windows' | 'macos' | 'linux' | 'unsupported';

export interface DesktopPlatformInfo {
  id: DesktopPlatformId;
  label: string;
  credentialProtection: string;
}

export function desktopPlatformId(platform: NodeJS.Platform): DesktopPlatformId {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

export function desktopPlatformInfo(platform: NodeJS.Platform, linuxBackend?: string): DesktopPlatformInfo {
  switch (desktopPlatformId(platform)) {
    case 'windows':
      return { id: 'windows', label: 'Windows', credentialProtection: 'Windows DPAPI' };
    case 'macos':
      return { id: 'macos', label: 'macOS', credentialProtection: 'macOS Keychain' };
    case 'linux':
      return {
        id: 'linux',
        label: 'Linux',
        credentialProtection: linuxBackend && linuxBackend !== 'unknown'
          ? `Linux secret store (${linuxBackend.replaceAll('_', ' ')})`
          : 'Linux secret store',
      };
    default:
      return { id: 'unsupported', label: platform, credentialProtection: 'Unavailable' };
  }
}

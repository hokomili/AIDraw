export type DesktopPlatformId = 'windows' | 'macos' | 'linux' | 'unsupported';

export interface DesktopPlatformInfo {
  id: DesktopPlatformId;
  label: string;
}

export function desktopPlatformId(platform: NodeJS.Platform): DesktopPlatformId {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

export function desktopPlatformInfo(platform: NodeJS.Platform): DesktopPlatformInfo {
  switch (desktopPlatformId(platform)) {
    case 'windows':
      return { id: 'windows', label: 'Windows' };
    case 'macos':
      return { id: 'macos', label: 'macOS' };
    case 'linux':
      return { id: 'linux', label: 'Linux' };
    default:
      return { id: 'unsupported', label: platform };
  }
}

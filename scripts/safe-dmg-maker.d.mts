import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';

export interface SafeDmgConfig {
  name?: string;
}

export interface SafeDmgPlan {
  appPath: string;
  outputPath: string;
  volumeName: string;
}

export function planSafeDmg(input: {
  dir: string;
  makeDir: string;
  appName: string;
  configuredName?: string;
}): SafeDmgPlan;

export class SafeDmgMaker extends MakerBase<SafeDmgConfig> {
  name: string;
  defaultPlatforms: Array<'darwin' | 'mas'>;
  requiredExternalBinaries: string[];
  isSupportedOnCurrentPlatform(): boolean;
  make(options: MakerOptions): Promise<string[]>;
}

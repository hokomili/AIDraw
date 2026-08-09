import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { resolve } from 'node:path';
import process from 'node:process';

const localElectronZipDirectory = process.env.AIDRAW_ELECTRON_ZIP_DIR;

const packagedRuntimeRoots = [
  '/.vite',
  '/node_modules/@napi-rs/canvas',
  '/node_modules/ajv',
  '/node_modules/ajv-formats',
  '/node_modules/fast-deep-equal',
  '/node_modules/fast-uri',
  '/node_modules/json-schema-traverse',
  '/node_modules/paper',
  '/node_modules/require-from-string',
];

const config: ForgeConfig = {
  outDir: process.env.AIDRAW_FORGE_OUT_DIR || 'out',
  packagerConfig: {
    asar: { unpack: '**/*.node' },
    prune: false,
    ...(localElectronZipDirectory ? { electronZipDir: resolve(localElectronZipDirectory) } : {}),
    // Vite bundles the application graph. Keep the native raster binding,
    // Paper's deliberately externalized geometry runtime, and AJV helpers
    // referenced by generated standalone validator functions.
    ignore: (filePath) => {
      if (!filePath) return false;
      const keep = packagedRuntimeRoots.some((root) =>
        filePath === root || filePath.startsWith(`${root}/`) || root.startsWith(`${filePath}/`),
      ) || filePath.startsWith('/node_modules/@napi-rs/canvas-');
      return !keep;
    },
    download: {
      cacheRoot: resolve('.electron-cache'),
    },
  },
  // @napi-rs/canvas ships an Electron-compatible N-API binary. Rebuilding all
  // optional dependencies would incorrectly compile Fabric's unused `canvas`.
  rebuildConfig: { onlyModules: [] },
  makers: [
    new MakerSquirrel({
      name: 'aidraw',
      setupExe: 'AIDraw-Setup.exe',
    }),
    new MakerDMG({ name: 'AIDraw' }, ['darwin']),
    new MakerDeb({
      options: {
        name: 'aidraw', productName: 'AIDraw', genericName: 'Drawing Studio',
        description: 'Agent-native mixed-media and pixel-art studio',
        maintainer: 'AIDraw contributors', homepage: 'https://github.com/hokomili/AIDraw',
        categories: ['Graphics'], mimeType: ['application/x-aidraw'],
      },
    }, ['linux']),
    new MakerRpm({
      options: {
        name: 'aidraw', productName: 'AIDraw', genericName: 'Drawing Studio',
        description: 'Agent-native mixed-media and pixel-art studio',
        license: 'MIT', homepage: 'https://github.com/hokomili/AIDraw',
        categories: ['Graphics'], mimeType: ['application/x-aidraw'],
      },
    }, ['linux']),
    new MakerZIP({}, ['win32', 'darwin', 'linux']),
  ],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
      const electronBinary = platform === 'win32'
        ? resolve(buildPath, '..', '..', 'electron.exe')
        : platform === 'darwin'
          ? resolve(buildPath, '..', '..', 'MacOS', 'Electron')
          : resolve(buildPath, '..', '..', 'electron');
      await flipFuses(electronBinary, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
        resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64',
      });
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/utility-worker.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
